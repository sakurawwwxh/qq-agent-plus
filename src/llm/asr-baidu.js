// 百度短语音识别（标准版）：POST vop.baidu.com/server_api，JSON 带 base64 音频。
// 两种鉴权都支持（百度现在默认发的是第二种，更简单）：
//   1. 老式：API Key + Secret Key → 换 access_token（有效期 30 天，这里缓存到进程里）
//   2. 新式：直接 `Authorization: Bearer bce-v3/ALTAK-...`（把 API Key 原样当 Bearer 用）
// 限制：单次 ≤60 秒、≤约 3MB（由上层分片）；pcm/wav/amr/m4a 都收，16k/8k 16 位单声道。
import { asrApiKey, asrSecretKey, getConfig } from '../core/config.js';

export const BAIDU_SPEECH_URL = 'https://vop.baidu.com/server_api';
export const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
/** dev_pid：1537=普通话(纯中文)，1737=英语，1536=普通话(带标点，需权限)。 */
export const BAIDU_DEV_PID = 1537;

// access_token 缓存（进程内；30 天有效，这里保守 12 小时刷新）。
// 必须按凭据指纹缓存：换了 Key/Secret 后复用旧 token 会一直报 3302「鉴权失败」，让人查错方向。
let tokenCache = { value: '', at: 0, fingerprint: '' };
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** 老式鉴权：用 API Key + Secret Key 换 access_token（带缓存；失败时抛百度给的错误文案）。 */
export async function baiduAccessToken({ apiKey, secretKey, fetchFn = fetch, timeoutMs = 20000, now = Date.now(), signal } = {}) {
  const fingerprint = `${String(apiKey || '')}
${String(secretKey || '')}`;
  if (tokenCache.value && tokenCache.fingerprint === fingerprint && now - tokenCache.at < TOKEN_TTL_MS) {
    return tokenCache.value;
  }
  const url = `${BAIDU_TOKEN_URL}?grant_type=client_credentials`
    + `&client_id=${encodeURIComponent(apiKey || '')}&client_secret=${encodeURIComponent(secretKey || '')}`;
  if (signal?.aborted) throw signal.reason ?? new Error('已中止');
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetchFn(url, { method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { /* 下面按无 token 处理 */ }
  const token = String(data?.access_token || '').trim();
  if (!token) {
    throw new Error(`百度换取 access_token 失败：${String(data?.error_description || data?.error || body).slice(0, 200)}`);
  }
  tokenCache = { value: token, at: now, fingerprint };
  return token;
}

/** 测试用：清掉 token 缓存。 */
export function resetBaiduTokenCache() { tokenCache = { value: '', at: 0, fingerprint: '' }; }

/**
 * 转写一段 16k 单声道 PCM（≤60 秒，由上层分片）。返回纯文本。
 * 有 secretKey 走老式换 token；只有 apiKey 就按新式 Bearer（bce-v3 那种）发。
 */
export async function baiduTranscribe(pcmBuffer, {
  apiKey, secretKey, devPid = BAIDU_DEV_PID, cuid = 'qq-agent', timeoutMs = 60000, signal, fetchFn = fetch
} = {}) {
  if (!apiKey) throw new Error('未配置百度语音的 API Key');
  if (signal?.aborted) throw signal.reason ?? new Error('已中止');
  const headers = { 'content-type': 'application/json' };
  let token = '';
  if (String(secretKey || '').trim()) {
    token = await baiduAccessToken({ apiKey, secretKey, fetchFn, signal });
    headers['content-type'] = 'application/json';
  } else {
    // 新式 API Key 直接当 Bearer 用（百度控制台现在默认发 bce-v3/ALTAK-... 这种）
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const payload = {
    format: 'pcm',
    rate: 16000,
    channel: 1,
    cuid,
    len: pcmBuffer.length,
    speech: pcmBuffer.toString('base64'),
    dev_pid: Number(devPid) || BAIDU_DEV_PID
  };
  if (token) payload.token = token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('语音识别请求超时')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('已中止'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchFn(BAIDU_SPEECH_URL, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal
    });
    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch { /* 下面统一报错 */ }
    // 顺序要紧：HTTP 失败时 body 可能是网关的 JSON（没有 err_no），先看 status 才能带上真实原因；
    // 2xx 但 body 不是 JSON 也要明说，别当成"没有内容"（2026-09-26 审查）。
    if (!res.ok) throw new Error(`百度语音识别服务返回 ${res.status}：${String(body).slice(0, 200)}`);
    if (!data) throw new Error(`百度语音识别返回的不是 JSON：${String(body).slice(0, 200)}`);
    // 百度：err_no=0 才是成功；结果在 result[0]
    if (data.err_no !== 0) {
      const hint = {
        3300: '输入参数不正确', 3301: '音频质量过差', 3302: '鉴权失败（Key/Secret 不对，或没开语音识别服务）',
        3303: '服务端问题', 3304: '用户请求超限（当日免费额度用完？）', 3305: '服务未开通',
        3307: '音频过长（超过 60 秒，需要分片）', 3308: '音频数据为空或格式不对', 3309: '音频格式不对'
      }[Number(data.err_no)];
      throw new Error(`百度语音识别失败：${data.err_msg || '未知错误'}（err_no=${data.err_no}${hint ? '，' + hint : ''}）`);
    }
    const list = Array.isArray(data?.result) ? data.result : [];
    return list.map((line) => String(line || '')).join('').trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 从配置取这套参数。 */
export function baiduOptions(cfg = getConfig()) {
  return {
    apiKey: asrApiKey(cfg),
    // 老式鉴权才用：同样走绑定后的取值，别把"为腾讯云存的"那把拿给百度
    secretKey: asrSecretKey(cfg),
    devPid: Number(cfg?.asr?.devPid) || BAIDU_DEV_PID
  };
}
