import { getConfig } from '../core/config.js';
import { withModelReplacement } from '../core/model-replacement.js';
import { modelHttpError } from './model-http-error.js';
// 图片生成适配器：OpenAI 兼容的 POST {base}/images/generations（2026-09 主流网关与自建都收敛到这个形状）。
// 与 TTS 侧同构：只做兼容端点，原生厂商适配器等有需求再加。
//
// 响应两种形态（各网关不一，都要吃）：
//   · b64_json —— 图片本体直接给（省一次下载，首选）
//   · url      —— 给临时链接，由调用方走 safeFetchBinary 拉（本项目已有 SSRF 防护）
// ModelScope API-Inference 是例外：创建任务后只给 task_id，必须轮询任务结果中的 output_images。
//
// Key 归属是这里的重点（见 resolveImageGenAuth）：配置指向别家却留空 Key 时，
// **绝不能**回退用聊天模型那把 Key —— 那是"把 A 家的密钥发给 B 家"的经典事故。
//
// 下载器（url 形态）直接 import safeFetchBinary 而不是当参数传：函数当参数会被 ops scan
// 当成"未定义调用点"误报（与 tts-http.js 里记的同一类）。
import { watchTimeWindow } from '../core/time-gate.js';
import { imageGenKeyResolve } from '../core/config.js';
import { imageGenServiceOfBaseUrl, imageGenServiceNeedsKey } from './image-gen-presets.js';
import { safeFetchBinary } from './safe-fetch.js';
import { readBytesBounded, readTextBounded } from '../core/http-body.js';

export const MAX_PROMPT_CHARS = 800;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 与表情库落盘上限一致
// 生图接口可能直接回 b64_json（16 MiB 图片编成 base64 约 21 MiB 字符），上限给到 16 MiB：
// 既容纳正常大图，又能拦住畸形响应把常驻进程读爆。
// （图片字节本身另有 MAX_IMAGE_BYTES 与 safeFetchBinary 的限量，这里只管文本读取。）
const IMAGE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const MODELSCOPE_POLL_MS = 5000;

export function imageGenConfigured(cfg) {
  const g = cfg?.imageGen || {};
  return g.enabled === true
    && String(g.baseUrl || '').trim() !== ''
    && String(g.model || '').trim() !== '';
}

/** 取主机名（比较"是不是同一家"用；解析失败返回空串）。 */
function hostOf(url) {
  try { return new URL(String(url || '').trim()).host.toLowerCase(); } catch { return ''; }
}

/** 实际要打的地址：imageGen 没填就跟聊天模型同一家（很多网关同域就带 images 端点）。 */
export function imageGenBaseUrl(imageGen, api) {
  const clean = (value) => String(value || '').trim()
    .replace(/\/+$/, '')
    // 用户常把完整端点粘进「服务地址」（issue #62）：适配器自己会拼 /images/generations，
    // 不剥掉就会变成 /images/generations/images/generations，服务端只会回 404。
    .replace(/\/images\/generations$/i, '');
  const own = clean(imageGen?.baseUrl);
  if (own) return own;
  return clean(api?.baseUrl);
}

/**
 * 存过的 Key 能不能用于**当前这个地址**：凭据记着存它时的主机名（apiKeyHost）。
 * 没记归属的老配置（migrateConfig 会按当时的地址补记）按"能用"算 —— 不给升级中的实例
 * 制造"突然不生效"。与 asr 的 asrCredentialApplies 同一条道理（2026-10-01 审查补）：
 * 之前这里只看"填没填 Key"，于是**换了预设/换了地址，旧 Key 照样以 Bearer 发到新主机**
 * —— 而"一键切换服务预设"正是这个功能的日常用法，等于把老 Key 送出去。
 */
export function imageGenKeyApplies(imageGen, host) {
  const stored = String(imageGen?.apiKeyHost || '').trim().toLowerCase();
  if (!stored) return true;
  return stored === String(host || '').trim().toLowerCase();
}

/** 存过 Key、但它不是给当前地址存的 → 界面要提示"换个地址要重填"。 */
export function imageGenKeyStale(imageGen, api) {
  const host = hostOf(imageGenBaseUrl(imageGen, api));
  const hasAny = Boolean(String(imageGen?.apiKey || '').trim())
    || Object.values(imageGen?.keys || {}).some((v) => String(v || '').trim());
  if (!hasAny) return false;   // 从没存过 = "还没填"，不是"要重填"
  // imageGenKeyFor 里含"没记归属的老单槽按当前地址能用"的兜底 —— 与运行时同一口径，
  // 不给升级中的实例制造突然失效（2026-10-02 回归测试抓到过）
  return !imageGenKeyResolve(imageGen, host).value;
}

/** 实际会用的图片服务主机（控制台「显示」按钮判断"表单里换的主机是不是当前这家"用）。 */
export function imageGenEffectiveHost(imageGen, api) {
  return hostOf(imageGenBaseUrl(imageGen, api));
}

/**
 * 决定用哪把 Key、以及能不能复用聊天模型那把。
 * 规则：
 *   0. 服务地址命中的预设**声明不需要 Key**（如免 Key 的 pollinations）→ 直接放行，空 Key；
 *   1. imageGen 自己填了 Key、**且它是给当前这个地址存的** → 用它；
 *   2. 没填（或存的那把不属于当前地址），但实际地址与聊天模型 api.baseUrl **同域**
 *      （含"没填地址=跟模型同一家"）→ 复用模型 Key；
 *   3. 都不成立 → 拒绝，返回明确错误，绝不把别家的 Key 发给这个地址。
 * 返回值：{ ok, key, reused, error }
 */
export function resolveImageGenAuth({ imageGen, api, apiKey } = {}) {
  const effective = imageGenBaseUrl(imageGen, api);
  const preset = imageGenServiceOfBaseUrl(effective);
  if (preset && !imageGenServiceNeedsKey(preset)) return { ok: true, key: '', reused: false, error: '' };
  const gHost = hostOf(effective);
  const own = String(imageGen?.apiKey || '').trim();
  if (own && own !== '******' && imageGenKeyApplies(imageGen, gHost)) {
    return { ok: true, key: own, reused: false, error: '' };
  }
  // 活动槽不可用（没填/归属不是这家）→ 查"这家存过的"（2026-10-02：切换服务预设的记忆；
  // 也覆盖手改配置直接换地址的情况 —— 只要那把 Key 确实是给这个主机存的，就不算跨家外发）
  // 运行时取值走 imageGenKeyResolve（与保存路径同一口径；不再另开一个字符串包装导出）
  const remembered = imageGenKeyResolve(imageGen, gHost).value;
  if (remembered) return { ok: true, key: remembered, reused: false, error: '' };
  const aHost = hostOf(api?.baseUrl);
  if (gHost && aHost && gHost === aHost) {
    const modelKey = String(apiKey || '').trim();
    if (modelKey && modelKey !== '******') return { ok: true, key: modelKey, reused: true, error: '' };
    return { ok: true, key: '', reused: false, error: '' };   // 同域但模型也没 Key：让请求自己去撞 401
  }
  if (own && own !== '******') {
    return {
      ok: false,
      key: '',
      reused: false,
      error: `图片生成存的 Key 是给 ${imageGen?.apiKeyHost || '另一个地址'} 的，当前地址是`
        + ` ${gHost || '未填'}：换地址后要重新填一次 Key（不会把旧 Key 发给新地址）。`
    };
  }
  return {
    ok: false,
    key: '',
    reused: false,
    error: '图片生成没有可用的 API Key：这里填的服务地址与聊天模型不是同一家，'
      + '不会把模型那把 Key 发给它。请在「图片生成」里单独填 Key，或把地址改成与模型相同的主机。'
  };
}

/**
 * 生成一张图。cfg：{ baseUrl, apiKey, model, size, timeoutMs, extraBody }
 * 返回 { buffer, format?, revisedPrompt? }；url 形态的图片在这里就下载好（调用方只拿到字节）。
 * 失败抛带可读原因的错。
 */
export async function generateImage(args = {}) {
  const current = getConfig();
  const initial = { ...current, ...(args.cfg?.imageGen ? args.cfg : {}),
    api: args.apiCfg || args.cfg?.api || current.api,
    imageGen: args.cfg?.imageGen || args.cfg || current.imageGen };
  return withModelReplacement('imageGen', initial, (cfg) => generateImageOnce({
    ...args, cfg, apiCfg: cfg.api,
    apiKey: cfg === initial ? args.apiKey : (cfg.providerKeys?.[cfg.api?.provider] || cfg.api?.apiKey || '')
  }), { signal: args.signal });
}

async function generateImageOnce({
  cfg,
  apiCfg = null,
  apiKey = '',
  prompt,
  signal = null,
  fetchFn = fetch,
  modelscopePollMs = MODELSCOPE_POLL_MS
} = {}) {
  const g = cfg?.imageGen || cfg || {};
  const base = imageGenBaseUrl(g, apiCfg);
  const model = String(g.model || '').trim();
  const body = String(prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
  if (!base) throw new Error('未配置图片生成的服务地址（设置 → 图片生成；留空表示与聊天模型同一家，那边也要有地址）');
  if (!model) throw new Error('未配置图片生成的模型（如 gpt-image-1 / seedream-3.0）');
  if (!body) throw new Error('生图提示词为空');

  const auth = resolveImageGenAuth({ imageGen: g, api: apiCfg, apiKey });
  if (!auth.ok) throw new Error(auth.error);

  const size = String(g.size || '').trim();
  // response_format 默认**不发送**：新版 OpenAI（gpt-image-1）会因未知参数直接 400，
  // 而老接口不传也有默认行为；两种响应形态下面都吃，所以不传最兼容。
  // 想强制某一种的用户可以自己填 b64_json / url（填别的值当没填）。
  const wantFormat = String(g.responseFormat || '').trim();
  const formatParam = (wantFormat === 'b64_json' || wantFormat === 'url') ? { response_format: wantFormat } : {};
  const extra = g.extraBody && typeof g.extraBody === 'object' && !Array.isArray(g.extraBody)
    ? g.extraBody
    : {};

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(g.timeoutMs) || 120000);   // 生图比对话慢，默认给 2 分钟
  const timer = setTimeout(() => controller.abort(new Error('图片生成超时')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('Run cancelled'));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const releaseTimeGuard = watchTimeWindow((error) => controller.abort(error));
  const preset = imageGenServiceOfBaseUrl(base);
  // Moss 官方 output_watermark 是 { enabled: boolean }；0.9.11 早期说明误导过布尔写法，
  // 这里兼容一次，免得按旧说明保存的配置在升级后还是发不出（issue #62 更正）。
  const requestExtra = extra.output_watermark !== undefined && typeof extra.output_watermark === 'boolean' && preset?.id === 'moss'
    ? { ...extra, output_watermark: { enabled: extra.output_watermark } }
    : extra;
  try {
    // 免 Key 的 pollinations 形状单独走一条：提示词在 URL 路径里、GET 取图字节
    // （它那个长得像 OpenAI 的 POST /openai/images/generations **不看 body**，别用）
    if (preset?.shape === 'pollinations') {
      return await pollinationsImage({ base, body, model, size, controller, fetchFn });
    }
    if (preset?.shape === 'modelscope') {
      return await modelscopeImage({ base, body, model, size, extra, auth, controller, fetchFn, pollMs: modelscopePollMs });
    }
    const res = await fetchFn(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {})
      },
      body: JSON.stringify({
        model,
        prompt: body,
        n: 1,
        ...formatParam,
        ...(size ? { size } : {}),
        ...requestExtra
      }),
      signal: controller.signal
    });
    const text = await readTextBounded(res, IMAGE_RESPONSE_MAX_BYTES);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 下面按原文报错 */ }
    if (!res.ok) {
      const detail = String(parsed?.error?.message || parsed?.message || text || '').slice(0, 300);
      throw modelHttpError(`图片生成失败 HTTP ${res.status}${detail ? `：${detail}` : ''}`, res.status, text);
    }
    const item = Array.isArray(parsed?.data) ? parsed.data[0] : null;
    if (!item) throw new Error(`图片生成没有返回图片：${String(text).slice(0, 200)}`);

    const revisedPrompt = String(item.revised_prompt || '').trim();
    // ① b64_json：常见网关即便要 url 也会带上，优先用
    const b64 = String(item.b64_json || item.image || '').trim();
    if (b64) {
      const buffer = Buffer.from(b64, 'base64');
      if (!buffer.length) throw new Error('图片生成返回了空的 base64 数据');
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('生成的图片过大（>8 MiB）');
      return { buffer, revisedPrompt };
    }
    // ② url：走内置的 SSRF 防护下载后再返回（调用方只拿到字节，不存会过期的临时链接）
    const url = String(item.url || '').trim();
    if (!url) throw new Error('图片生成既没有 b64_json 也没有 url');
    const { buffer } = await safeFetchBinary(url, MAX_IMAGE_BYTES, controller.signal);
    if (!buffer?.length) throw new Error('从生成结果 URL 下载到的图片为空');
    return { buffer, revisedPrompt };
  } finally {
    clearTimeout(timer);
    releaseTimeGuard();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** ModelScope API-Inference：创建异步任务，完成后从 output_images 下载结果。 */
async function modelscopeImage({ base, body, model, size, extra, auth, controller, fetchFn, pollMs }) {
  const headers = {
    'content-type': 'application/json',
    'X-ModelScope-Async-Mode': 'true',
    ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {})
  };
  const res = await fetchFn(`${base}/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, prompt: body, n: 1, ...(size ? { size } : {}), ...extra }),
    signal: controller.signal
  });
  const text = await readTextBounded(res, IMAGE_RESPONSE_MAX_BYTES);
  let created = null;
  try { created = JSON.parse(text); } catch { /* 按原文带出 */ }
  if (!res.ok) {
    const detail = String(created?.error?.message || created?.message || text || '').slice(0, 300);
    throw modelHttpError(`图片生成失败 HTTP ${res.status}${detail ? `：${detail}` : ''}`, res.status, text);
  }
  const taskId = String(created?.task_id || '').trim();
  if (!taskId) throw new Error(`魔搭图片生成没有返回 task_id：${String(text).slice(0, 200)}`);

  // 官方要求任务查询携带该类型；成功响应才包含 output_images，不能把创建任务的 SUCCEED 当成图片结果。
  let lastTaskText = '';
  try {
    while (true) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('图片生成超时');
      await sleepWithSignal(Math.max(0, Number(pollMs) || 0), controller.signal);
      const taskRes = await fetchFn(`${base}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: {
          ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
          'X-ModelScope-Task-Type': 'image_generation'
        },
        signal: controller.signal
      });
      const taskText = await readTextBounded(taskRes, IMAGE_RESPONSE_MAX_BYTES);
      lastTaskText = taskText;
      let task = null;
      try { task = JSON.parse(taskText); } catch { /* 按原文带出 */ }
      if (!taskRes.ok) {
        const detail = String(task?.error?.message || task?.message || taskText || '').slice(0, 300);
        throw new Error(`魔搭图片任务查询失败 HTTP ${taskRes.status}${detail ? `：${detail}` : ''}`);
      }
      const status = String(task?.task_status || '').toUpperCase();
      // 终态失败要立刻停：FAILED / CANCELED 都不会再产出图片，继续轮询只会拖到外层超时。
      // PENDING / RUNNING 以及不认识的中间态继续轮询，最终由 controller 的 timeoutMs 兜底。
      if (['FAILED', 'CANCELED', 'CANCELLED'].includes(status)) {
        const detail = String(task?.message || task?.error?.message || taskText || '').slice(0, 300);
        const reason = status === 'FAILED' ? '失败' : `已终止（${status}）`;
        const terminal = new Error(`魔搭图片生成任务${reason}${detail ? `：${detail}` : ''}`);
        terminal.code = 'MODELSCOPE_TASK_TERMINAL';
        throw terminal;
      }
      if (status !== 'SUCCEED') continue;
      const url = String(task?.output_images?.[0] || '').trim();
      if (!url) throw new Error(`魔搭图片生成任务已完成但没有返回 output_images：${String(taskText).slice(0, 300)}`);
      const { buffer } = await safeFetchBinary(url, MAX_IMAGE_BYTES, controller.signal);
      if (!buffer?.length) throw new Error('从魔搭生成结果 URL 下载到的图片为空');
      return { buffer, revisedPrompt: '' };
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    // 只有服务商明确返回的终态（FAILED / CANCELED）不需要再补"可能计费"：
    // 用 code 而不是文案前缀判断，避免以后改提示语时静默改变控制流。
    if (error?.code === 'MODELSCOPE_TASK_TERMINAL') throw error;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      // 除了图片自身的 timeoutMs，orchestrator 还会用 api.runTimeoutMs 截断整个 run；
      // 后者抛的是 "Run deadline exceeded"，同样属于"任务已创建、但本地不再等"的场景。
      const timedOut = reason?.name === 'TimeoutError'
        || /超时|timed? ?out|deadline|time limit/i.test(String(reason?.message || reason || message));
      if (!timedOut) throw error;
      const last = lastTaskText ? `（最后一次任务响应：${lastTaskText.slice(0, 300)}）` : '';
      throw new Error(`魔搭图片生成超时${last}；任务可能已在服务商侧继续执行并计费，请勿立即重试`);
    }
    // 轮询网络错误/任务查询 5xx：任务已经创建，重试可能再建一个计费任务。
    // cause 要原样带上：undici 的网络错误外层常只有 "fetch failed"，真因在 cause 上。
    throw new Error(`${message}；任务可能已在服务商侧继续执行并计费，请勿立即重试`, { cause: error });
  }
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('图片生成超时'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * pollinations 形状：GET {base}/prompt/<提示词>?width=&height=&model=&nologo=true，直接拿图片字节。
 * 返回与 OpenAI 形状同一个 `{ buffer, revisedPrompt }`，调用方不需要知道是哪一家。
 * 尺寸从「尺寸」栏的 `1024x1024` 解析（它只认 width/height 两个查询参数）。
 */
async function pollinationsImage({ base, body, model, size, controller, fetchFn }) {
  const url = new URL(`${base}/prompt/${encodeURIComponent(body)}`);
  const m = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/.exec(String(size || '').trim());
  if (m) {
    url.searchParams.set('width', m[1]);
    url.searchParams.set('height', m[2]);
  }
  if (model) url.searchParams.set('model', model);
  url.searchParams.set('nologo', 'true');
  const res = await fetchFn(url.toString(), { method: 'GET', signal: controller.signal });
  const type = String(res.headers?.get?.('content-type') || '');
  if (!res.ok || !type.startsWith('image/')) {
    // 错误详情有界读（4096 字节足够，还要再截 300 字符）；读不出来不影响报错本身。
    let detail = '', errorBody = '';
    try { errorBody = await readTextBounded(res, 4096); detail = String(errorBody).slice(0, 300); } catch { /* 忽略 */ }
    // 402 / 429 是这条免 Key 路线的常态而不是异常：官方文档写明匿名档是「15 秒 1 次」按 IP 限流，
    // 额度用完之后直接回一个**空的** 402（响应体就俩字节 {}），不解释的话用户完全看不懂。
    // 2026-10-01 实测：同一时刻本机出口 200、云服务器出口 402 —— 是按 IP 算的。
    if (res.status === 402 || res.status === 429) {
      throw modelHttpError(`图片生成被限流（HTTP ${res.status}）：这条免 Key 路线是匿名档，按 IP 限制`
        + '（官方文档口径 1 次/15 秒），额度用完就会这样。稍后再试，或换一家有免费额度的图模型'
        + '（控制台「图片生成 → 服务预设」里可选）。', res.status, errorBody);
    }
    throw modelHttpError(`图片生成失败 HTTP ${res.status}${detail ? `：${detail}` : ''}`, res.status, errorBody);
  }
  // 有界读取：上游返回超大/畸形响应时中途取消，而不是先整包读入再判长度（那样上限形同虚设）
  let buffer;
  try {
    buffer = await readBytesBounded(res, MAX_IMAGE_BYTES);
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') throw new Error('生成的图片过大（>8 MiB）');
    throw error;
  }
  if (!buffer.length) throw new Error('图片生成返回了空数据');
  return { buffer, revisedPrompt: '' };
}
