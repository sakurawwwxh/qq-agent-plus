// 多提供商模型目录：统一使用 OpenAI 兼容接口，由控制台维护。
import { getConfig, updateConfig } from './config.js';
import { assertTimeAllowed, watchTimeWindow } from './time-gate.js';
import { readJsonBounded } from './http-body.js';
import { modelServiceOfBaseUrl, modelServiceById, resolveThinkingPatch, normalizeThinkingIntent, effectiveThinkingRaw, hostOf } from './provider-presets.js';

/** 当前生效的提供商目录（配置里的 providers）。 */
export function currentProviders() {
  const cfg = getConfig();
  return (cfg.providers || []).map((p) => withResolvedKey(p, cfg));
}

/** 给指定提供商设置 API Key（密钥与公开目录元数据分开存储）。 */
export function setProviderKey(providerId, apiKey) {
  // 掩码 = "没改这一项"，不是"把 Key 设成 ******"。不挡的话掩码会落进 providerKeys，
  // 读取侧当它不存在（回退内联）、归档侧当它存在（跳过）—— 两边口径一反就丢 Key
  //（2026-10-04 复审 P3）。官方界面提交前会过滤，这里从入口也堵一道。
  const key = String(apiKey ?? '').trim();
  if (key === '******') return currentProviders().find((p) => p.id === providerId) || null;
  const keys = { ...(getConfig().providerKeys || {}) };
  if (key) keys[providerId] = key;
  else delete keys[providerId];
  // 必须走 __replace__ 整体替换：deepMerge 只遍历 override 的键，普通传对象时
  // 被删掉的 id 会从旧配置原样复活 —— "清 Key"实际没清，明文还留在 config.json。
  updateConfig({ providerKeys: { __replace__: keys } });
  return currentProviders().find((p) => p.id === providerId) || null;
}

// ── 手动管理提供商/模型（设置页“模型 API”） ──────────────────────────────

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function hostDisplayName(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.hostname || '自定义提供商';
  } catch {
    return '自定义提供商';
  }
}

function normalizeModelInput(models) {
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m) continue;
    if (typeof m === 'string') {
      const id = m.trim();
      if (id) out.push({ id, name: id });
    } else if (typeof m === 'object') {
      const id = String(m.id ?? m.model ?? '').trim();
      if (id) out.push({ id, name: String(m.name ?? m.id ?? id).trim() || id });
    }
  }
  return out;
}

/** 从当前配置里取 provider.apiKey 对应的真实值（含旧版 top-level key 回退）。 */
function providerKeyValue(provider, cfg = getConfig()) {
  if (provider && typeof provider === 'object') {
    // ⚠️ **目录优先**（2026-10-04 复审 P3 修正）：`providerKeys` 是权威存储 —— 控制台的
    // 「设置 Key」和 upsert 都写它，providers[] 里按约定不留明文；`providers[].apiKey` 只是
    // 老配置的残留。原来是内联优先，于是"控制台刚写进去的新 Key"会被一份更旧的内联值盖掉，
    // 而一次与 Key 无关的「加模型」就会静默换掉实际发出的那把。
    // 目录没有才回退内联（老实例只有内联那一份，不能因此失效）。
    const catalogKey = String(cfg?.providerKeys?.[provider.id] ?? '').trim();
    if (catalogKey && catalogKey !== '******') return catalogKey;
    const top = String(provider.apiKey ?? '').trim();
    if (top && top !== '******') return top;
  }
  return '';
}

/** 提供商对象里 apiKey 可能是掩码/引用，请求前必须解出真实 key。 */
function withResolvedKey(p, cfg = getConfig()) {
  const real = providerKeyValue(p, cfg);
  return { ...p, apiKey: real };
}

/**
 * 重建 providers 列表之前，先把**内联**在 `providers[].apiKey` 里的旧式 Key 归档进
 * `providerKeys`。下面几处（加模型 / 删模型 / upsert / 探测落盘）都要重建整份列表，
 * 而 deepMerge 对数组是**整体替换**，所以重建时必须把 apiKey 剥掉（providers[] 里不留明文）；
 * 但剥之前不归档的话，老配置（Key 直接写在 providers[] 里）一次「加/删模型」就**永久丢失** ——
 * 实测：装完运行期解析得到 Key，加一次模型之后变成空串，控制台也没处找回来（2026-10-04 复审 P2）。
 *
 * 目录里已有**真值**就不覆盖（那一份是控制台/upsert 写的，比内联残留新；覆盖等于吃掉用户
 * 刚存进去的 Key）。与 providerKeyValue 的「目录优先」是同一套口径。
 * ⚠️ `******`（掩码）算**没有**，必须与 providerKeyValue 一致（2026-10-04 复审 P3）：
 * 两边口径反了会丢 Key —— 目录里是掩码时读取会回退内联（还能用），而归档却因"目录非空"
 * 跳过；随后重建把内联剥掉，目录只剩掩码、读取又当它不存在 → 真值彻底消失。
 * 返回是否需要写回。
 *
 * 注：两份都在时**内联那份会在重建时被丢掉**（成了死数据，不再被使用）——能保住的是目录那份。
 */
function archiveInlineProviderKeys(providers) {
  const keys = { ...(getConfig().providerKeys || {}) };
  let changed = false;
  for (const p of providers || []) {
    const id = String(p?.id || '').trim();
    const inline = String(p?.apiKey ?? '').trim();
    if (!id || !inline || inline === '******') continue;
    const existing = String(keys[id] ?? '').trim();
    if (existing && existing !== '******') continue;   // 目录那份已是真值，不覆盖
    keys[id] = inline;
    changed = true;
  }
  if (changed) updateConfig({ providerKeys: keys });
  return changed;
}

/** OpenCode Go 路由头：omen alpha 等模型缺 x-opencode-session 直接 400。
 *  中转站转发时域名不是 opencode.ai，要靠模型 id 的 opencode-go/ 前缀识别。 */
function opencodeHeaders(baseUrl, model = '') {
  if (!/opencode\.ai/i.test(String(baseUrl)) && !/^opencode-go\//i.test(String(model || ''))) return {};
  return { 'x-opencode-session': `qqagent-probe-${process.pid}`, 'user-agent': 'qq-agent/0.3' };
}

/** 用指定 baseUrl/key 获取模型列表（OpenAI /models）。 */
export async function fetchModelsFrom(baseUrl, apiKey, timeoutMs = 15000) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('请先填写 Base URL');
  const res = await fetch(`${base}/models`, {
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...opencodeHeaders(base) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  // 有界读（2MB）：模型列表可能不小，但绝不该是"无上限"（2026-10-09 审查）
  const data = await readJsonBounded(res, 2 * 1024 * 1024);
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => String(m.id ?? m.model ?? m)).filter(Boolean);
}

/** 用用户提供的 baseUrl + apiKey + modelId 发送一次最小 chat 测试请求。 */
export async function testModelChat({ baseUrl, apiKey, model }) {  assertTimeAllowed('');
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('请先填写 Base URL');
  if (!String(model || '').trim()) throw new Error('请先填写模型 ID');
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), 20000);
  const releaseTimeGuard = watchTimeWindow((error) => controller.abort(error), '');
  try {
    controller.signal.throwIfAborted();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...opencodeHeaders(base, model)
      },
      body: JSON.stringify({
        model: String(model).trim(),
        messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
        max_tokens: 16,
        stream: false
      }),
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    // 有界读（256KB）：测试请求的响应本应很小（2026-10-09 审查）
    let body = {};
    try { body = await readJsonBounded(res, 256 * 1024); } catch { body = {}; }
    if (!res.ok) {
      const errText = String(body?.error?.message ?? body?.message ?? '').slice(0, 200);
      return { ok: false, httpStatus: res.status, latencyMs, note: `HTTP ${res.status}${errText ? `：${errText}` : ''}` };
    }
    const reply = String(body?.choices?.[0]?.message?.content ?? '').trim().slice(0, 60);
    return { ok: true, httpStatus: res.status, latencyMs, note: reply ? `模型回复：「${reply}」` : '请求成功（无文本返回）' };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    return { ok: false, latencyMs, note: msg === '超时' ? '连接超时' : `网络错误：${msg}` };
  } finally {
    releaseTimeGuard();
    clearTimeout(timer);
  }
}

/**
 * 思考能力探测：用「真正会发出去的那套参数」发一条最小请求，实测这个渠道的实际行为。
 * 能测出的事实（不靠预设假设，也不依赖任何查询接口）：
 *   - 关闭参数是否生效：带了 off 形状后响应里还有没有思考痕迹（reasoning_content / reasoning_tokens）；
 *   - 档位接受度：400 报错里若列出合法枚举（如 Command Code 的 "expected one of low|medium|high|xhigh|max"），解析出来缓存。
 * 结果落盘到 provider.thinkingProbe，控制台据此显示「已实测」标记。
 */
export async function probeThinking({ providerId = '', baseUrl = '', apiKey = '', model = '', thinking = undefined, extraBody = undefined, useSavedParams = true } = {}) {
  assertTimeAllowed('');
  const cfg = getConfig();
  let p = currentProviders().find((x) => x.id === providerId) || null;
  // 地址回退链带上顶层 api.*：大量部署（包括本机实测的这台）不建 provider 记录，
  // 直接用 api.baseUrl + api.apiKey 连接（2026-09-27 服务器实测踩到）。
  const base = normalizeBaseUrl(baseUrl || p?.baseURL || cfg?.api?.baseUrl || '');
  // Key 只认调用方传入的那把：路由已按"已知地址"守卫解析过。
  // 这里不再回退 p.apiKey / cfg.api.apiKey —— 否则等于把已存明文 Key 送到任意 baseUrl（终审 P1）。
  const key = String(apiKey || '').trim();
  const modelId = String(model || cfg?.api?.model || (p?.models || [])[0] || '').trim();
  if (!base) throw new Error('请先填写 Base URL');
  if (!modelId) throw new Error('请先选择/填写模型 ID');
  // 渠道形状按"实测地址"解析：p.preset 只在 provider 存的地址与实测地址同主机时才可信——
  // 换了地址未保存就探测，按旧家形状发参数会得出错误结论（审查 2026-09-28）。
  const presetApplies = !!(p?.preset && p.baseURL && hostOf(p.baseURL) === hostOf(base));
  const service = modelServiceOfBaseUrl(base)
    || (presetApplies ? modelServiceById(p.preset) : null);
  const serviceId = (presetApplies ? p.preset : '') || service?.id || '';
  // 档位意图：调用方显式给了就用它的；否则按"实测地址"取每供应商设置（分设配置也参与），
  // 不再退回裸的全局 api.thinking（审查 2026-09-28：分设模式下探测测的应是该家配置的档）。
  const intent = normalizeThinkingIntent(
    thinking !== undefined ? thinking : effectiveThinkingRaw(cfg?.api, hostOf(base)),
    'chat'
  );
  // 探测两类问题，语义分开（终审 P1：此前把"当前档位"的实测结果误当"能关闭"落盘）：
  //  - 选择是 off / 未设(on)：测"这个渠道能不能关掉思考" → canDisable 有结论（含近似档说明）；
  //  - 选择是具体档位：只报"该档位实发与思考 token"，不下"可关闭"的结论。
  const testingOff = intent === 'on' || intent === 'off';
  // 已保存的 thinkingParams / extraBody 只属于当前主渠道。探测别的地址时不能把它们
  // 当成"真正会发出去的参数"（里面可能有 authorization 等密钥）。
  const savedThinkingParams = useSavedParams ? cfg?.api?.thinkingParams : undefined;
  const resolved = resolveThinkingPatch(serviceId, testingOff ? 'off' : intent, savedThinkingParams);
  const sendPatch = resolved?.patch || null;
  const offPatch = testingOff ? sendPatch : null;
  const approx = resolved?.approx === true;
  const extra = extraBody !== undefined ? extraBody : (useSavedParams ? cfg?.api?.extraBody : undefined);
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: '只回复数字：1+1=?' }],
    max_tokens: 1024,
    stream: false,
    ...(sendPatch || {}),
    ...((extra && typeof extra === 'object' && !Array.isArray(extra)) ? extra : {})
  };
  // 与 chatCompletion 同款守卫：thinkingParams / extraBody 带 stream:true 时，探测响应的
  // 解析失败会被吞成空对象、得出"实测已关闭"的错误结论落盘（复审 2026-09-28）。
  if (body.stream === true) body.stream = false;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), 25000);
  const releaseTimeGuard = watchTimeWindow((error) => controller.abort(error), '');
  try {
    controller.signal.throwIfAborted();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...opencodeHeaders(base, modelId)
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    // 有界读（256KB）：探测请求的响应本应很小（2026-10-09 审查）
    let payload = {};
    try { payload = await readJsonBounded(res, 256 * 1024); } catch { payload = {}; }
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const errText = String(payload?.error?.message ?? payload?.message ?? '').slice(0, 300);
      // 有的渠道会在 400 里列出合法档位枚举 —— 直接解析缓存，省得逐个试。
      const m = errText.match(/expected one of\s+["']?([a-z| ]+)["']?/i);
      const levels = m ? m[1].split('|').map((s) => s.trim()).filter(Boolean) : null;
      const result = {
        ok: false, latencyMs, serviceId,
        sentPatch: sendPatch,
        note: `探测请求失败 HTTP ${res.status}${errText ? `：${errText}` : ''}`,
        ...(levels ? { levels } : {})
      };
      saveProbe(p, result, base);
      return result;
    }
    const usage = payload?.usage || {};
    const reasoningTokens = Number(usage?.completion_tokens_details?.reasoning_tokens) || 0;
    const reasoningContent = String(payload?.choices?.[0]?.message?.reasoning_content ?? '').trim();
    const hasReasoning = reasoningTokens > 0 || reasoningContent !== '';
    let canDisable = null;
    let note;
    if (testingOff) {
      canDisable = offPatch ? !hasReasoning : null;
      note = offPatch
        ? (hasReasoning
          ? (approx
            ? `该渠道无法真正关闭思考：选「关闭」按最低档发送（实测思考 token ${reasoningTokens || '>0'}）。`
            : `该渠道忽略了关闭思考的参数（思考 token ${reasoningTokens || '>0'}）：无法真正关闭。`)
          : '该渠道接受了关闭思考的参数：实测已关闭，无思考 token。')
        : (hasReasoning
          ? `未配置可用的关闭参数；实测思考默认开启（思考 token ${reasoningTokens || '>0'}）。可用「额外请求参数」按服务商文档自定义。`
          : '未配置关闭参数；本次请求未见思考 token（无法据此断定可关闭）。');
    } else {
      note = `已按「${intent}」档实测：思考 token ${reasoningTokens || 0}${hasReasoning ? '' : '（未见思考痕迹）'}；本次不含"能否关闭"的结论，选「关闭」再测即可。`;
    }
    const result = { ok: true, latencyMs, serviceId, sentPatch: sendPatch, hasReasoning, canDisable, reasoningTokens, note };
    saveProbe(p, result, base);
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    const result = { ok: false, latencyMs, serviceId, sentPatch: sendPatch, note: msg === '超时' ? '探测超时' : `探测失败：${msg}` };
    saveProbe(p, result, base);
    return result;
  } finally {
    releaseTimeGuard();
    clearTimeout(timer);
  }
}

/** 探测结果落盘（控制台展示「已实测」标记用）。
 *  归属按"实测地址"算（审查 2026-09-28）：实测地址与 provider 存的地址同主机 → 记到该 provider 名下；
 *  否则记到 api.thinkingProbe 并带上实测的 baseUrl——换地址后旧结论自动作废，也
 *  不会把测自新地址的结论挂在旧 provider 上。 */
function saveProbe(provider, result, probedBase = '') {
  const snapshot = {
    checkedAt: Date.now(),
    ok: result.ok === true,
    canDisable: result.canDisable === null || result.canDisable === undefined ? null : result.canDisable === true,
    reasoningTokens: Number(result.reasoningTokens) || 0,
    levels: Array.isArray(result.levels) ? result.levels : undefined,
    note: String(result.note || '').slice(0, 300)
  };
  try {
    const sameHost = !!(provider?.id && provider.id.startsWith('custom_')
      && provider.baseURL && probedBase
      && hostOf(provider.baseURL) === hostOf(probedBase));
    if (sameHost) {
      const resolved = currentProviders();
      archiveInlineProviderKeys(resolved);   // 先归档内联 Key，再重建（否则剥掉即丢失）
      const providers = resolved.map((x) => {
        const { apiKey: _ak, ...rest } = x;
        return rest;
      });
      const target = providers.find((x) => x.id === provider.id);
      if (target) {
        target.thinkingProbe = snapshot;
        updateConfig({ providers });
        return;
      }
    }
    updateConfig({ api: { thinkingProbe: { ...snapshot, baseUrl: normalizeBaseUrl(probedBase || '') } } });
  } catch { /* 落盘失败不影响探测结果本身 */ }
}

/** 测试一个提供商端点（按 providerId 查目录，或直接给 baseUrl/apiKey）。 */
export async function testOneProvider({ providerId = '', baseUrl = '', apiKey = '' } = {}) {
  let p = currentProviders().find((x) => x.id === providerId);
  if (!p) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) return { ok: false, verdict: 'no-endpoint', note: '没有端点地址', latencyMs: 0 };
    p = { id: providerId || '__tmp__', displayName: hostDisplayName(base), baseURL: base, apiKey: apiKey || '', models: [] };
  } else if (apiKey && apiKey !== '******') {
    p = { ...p, apiKey };
  }
  return testProvider(p);
}

/** 新建提供商；若同 baseURL 已存在则合并模型。返回 { provider, created }。
 *  preset = 渠道预设 id（provider-presets.js），用于把"关思考"翻译成该渠道认识的参数形状；
 *  留空时运行期按 baseURL 主机名自动推断。 */
export function upsertProvider({ baseUrl, apiKey, models = [], preset = '' }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Base URL 不能为空');
  const presetId = String(preset || '').trim().toLowerCase();
  // 掩码 = "没改这一项"，在**入口归一一次**，下面两个分支都只看它 ——
  // 此前只有"既有"分支判了掩码，"新建"分支照样把 '******' 当新 Key 写进 providerKeys
  //（2026-10-04 复审 P3）。入口收一次，比在每个分支各写一遍判据更不容易再漏。
  const submittedKey = String(apiKey ?? '').trim() === '******' ? '' : String(apiKey ?? '').trim();
  const resolved = currentProviders();
  archiveInlineProviderKeys(resolved);   // 内联 Key 先归档，再重建列表
  const providers = resolved.map((p) => { const { apiKey: _ak, ...rest } = p; return { ...rest, models: [...(p.models || [])] }; });
  const existing = providers.find((p) => normalizeBaseUrl(p.baseURL) === base);
  const entries = normalizeModelInput(models);
  if (existing) {
    for (const m of entries) {
      if (!existing.models.includes(m.id)) existing.models.push(m.id);
    }
    // 先补好显示名再落盘：updateConfig 会把数组的当前内容快照进去，
    // 在它之后改 existing 只改了返回值 —— 配置里留下的还是首次导入的名字，UI 上显示原始 id。
    existing.modelNames = { ...(existing.modelNames || {}) };
    for (const m of entries) existing.modelNames[m.id] = m.name;
    if (presetId && existing.preset !== presetId) existing.preset = presetId;
    if (submittedKey) {
      const keys = { ...(getConfig().providerKeys || {}) };
      keys[existing.id] = submittedKey;
      updateConfig({ providers, providerKeys: keys });
    } else {
      updateConfig({ providers });
    }
    return { provider: withResolvedKey(existing), created: false };
  }
  const id = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const modelNames = {};
  for (const m of entries) modelNames[m.id] = m.name;
  const provider = {
    id,
    displayName: hostDisplayName(base),
    api: 'openai',
    anthropicOrigin: false,
    baseURL: base,
    apiKey: '',
    apiKeyFrom: submittedKey ? 'manual' : '',
    models: entries.map((m) => m.id),
    modelNames,
    needsBaseUrl: false,
    ...(presetId ? { preset: presetId } : {})
  };
  providers.push(provider);
  const keys = { ...(getConfig().providerKeys || {}) };
  if (submittedKey) keys[id] = submittedKey;
  // 新建的提供商自动切换为当前模型（控制台"确认添加"的文案一直这么承诺，
  // 此前却只建目录不切换 —— 用户添加完看到「尚未选择模型」+ 空的模型目录框）。
  // api.baseUrl 一并同步：控制台地址框回显与思考设置的归属键都读它，不同步会出现
  // "界面显示旧地址、思考设置写到旧 host"（审查 2026-09-28）。
  const previousHost = hostOf(getConfig()?.api?.baseUrl || '');
  const nextHost = hostOf(base);
  updateConfig({
    providers,
    ...(apiKey ? { providerKeys: keys } : {}),
    api: {
      provider: id, model: entries[0]?.id || '', baseUrl: base,
      // 换主机时旧渠道的额外请求头/思考映射可能带着上一家的凭据，必须清掉。
      ...(nextHost !== previousHost
        ? { extraBody: { __replace__: {} }, thinkingParams: { __replace__: {} } }
        : {})
    }
  });
  return { provider: withResolvedKey(provider), created: true };
}

/** 给指定提供商追加模型（合并 modelNames）。 */
export function addModelsToProvider(providerId, models = []) {
  const entries = normalizeModelInput(models);
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  p.modelNames = { ...(p.modelNames || {}) };
  for (const m of entries) {
    if (!p.models.includes(m.id)) p.models.push(m.id);
    p.modelNames[m.id] = m.name;
  }
  archiveInlineProviderKeys(providers);   // 内联 Key 先归档，别被下面的重建剥掉
  updateConfig({ providers: providers.map((x) => { const { apiKey, ...rest } = x; return rest; }) });
  return p;
}

/** 从提供商移除一个模型。 */
export function removeModelFromProvider(providerId, modelId) {
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  p.models = p.models.filter((id) => id !== modelId);
  if (p.modelNames) {
    const modelNames = { ...p.modelNames };
    delete modelNames[modelId];
    p.modelNames = modelNames;
  }
  archiveInlineProviderKeys(providers);   // 内联 Key 先归档，别被下面的重建剥掉
  updateConfig({ providers: providers.map((x) => { const { apiKey, ...rest } = x; return rest; }) });
  return p;
}

// ── 连通性测试：GET {baseURL}/models（OpenAI 兼容探测） ────────────────────

/**
 * 测试一个提供商的端点连通性与密钥有效性。
 * 返回 { ok, httpStatus, modelCount, latencyMs, verdict, note }。
 * verdict: ok（可用）/ bad-key（密钥被拒）/ no-models-route（端点可达但无 /models 路由）/ no-endpoint / error
 */
export async function testProvider(p, timeoutMs = 12000) {
  if (!p.baseURL) return { ok: false, verdict: 'no-endpoint', note: '没有端点地址', latencyMs: 0 };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), timeoutMs);
  try {
    const res = await fetch(`${p.baseURL}/models`, {
      headers: {
        ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
        ...opencodeHeaders(p.baseURL)
      },
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) {
      let count = 0;
      try {
        const data = await readJsonBounded(res, 2 * 1024 * 1024);
        const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        count = list.length;
      } catch { /* body 不是 JSON 或超限 */ }
      return { ok: true, httpStatus: res.status, modelCount: count, latencyMs, verdict: 'ok', note: count ? `列到 ${count} 个模型` : '端点可用（未返回模型列表）' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, httpStatus: res.status, latencyMs, verdict: 'bad-key', note: `HTTP ${res.status}：密钥无效或无权限` };
    }
    if (res.status === 404) {
      return { ok: false, httpStatus: 404, latencyMs, verdict: 'no-models-route', note: '端点可达但没有 /models 路由（chat/completions 未必不可用）' };
    }
    return { ok: false, httpStatus: res.status, latencyMs, verdict: 'error', note: `HTTP ${res.status}` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    return { ok: false, latencyMs, verdict: 'error', note: msg === '超时' ? '连接超时' : `网络错误：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 并发测试全部提供商（限 4 并发）。 */
export async function testAllProviders(providers, limit = 4) {
  const results = {};
  const queue = [...providers];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const p = queue.shift();
      results[p.id] = { ...(await testProvider(p)), displayName: p.displayName };
    }
  });
  await Promise.all(workers);
  return results;
}
