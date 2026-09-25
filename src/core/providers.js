// 多提供商模型目录：统一使用 OpenAI 兼容接口，由控制台维护。
import { getConfig, updateConfig } from './config.js';
import { assertTimeAllowed, watchTimeWindow } from './time-gate.js';

/** 当前生效的提供商目录（配置里的 providers）。 */
export function currentProviders() {
  const cfg = getConfig();
  return (cfg.providers || []).map((p) => withResolvedKey(p, cfg));
}

/** 给指定提供商设置 API Key（密钥与公开目录元数据分开存储）。 */
export function setProviderKey(providerId, apiKey) {
  const key = String(apiKey ?? '').trim();
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
function providerKeyValue(provider, cfg) {
  if (provider && typeof provider === 'object') {
    const top = String(provider.apiKey ?? '').trim();
    if (top && top !== '******') return top;
    const catalogKey = String(cfg?.providerKeys?.[provider.id] ?? '').trim();
    if (catalogKey && catalogKey !== '******') return catalogKey;
  }
  return '';
}

/** 提供商对象里 apiKey 可能是掩码/引用，请求前必须解出真实 key。 */
function withResolvedKey(p, cfg = getConfig()) {
  const real = providerKeyValue(p, cfg);
  return { ...p, apiKey: real };
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
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => String(m.id ?? m.model ?? m)).filter(Boolean);
}

/** 用用户提供的 baseUrl + apiKey + modelId 发送一次最小 chat 测试请求。 */
export async function testModelChat({ baseUrl, apiKey, model }) {
  assertTimeAllowed('');
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
    const body = await res.json().catch(() => ({}));
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

/** 新建提供商；若同 baseURL 已存在则合并模型。返回 { provider, created }。 */
export function upsertProvider({ baseUrl, apiKey, models = [] }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Base URL 不能为空');
  const providers = currentProviders().map((p) => { const { apiKey: _ak, ...rest } = p; return { ...rest, models: [...(p.models || [])] }; });
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
    if (apiKey) {
      const keys = { ...(getConfig().providerKeys || {}) };
      keys[existing.id] = String(apiKey).trim();
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
    apiKeyFrom: apiKey ? 'manual' : '',
    models: entries.map((m) => m.id),
    modelNames,
    needsBaseUrl: false
  };
  providers.push(provider);
  const keys = { ...(getConfig().providerKeys || {}) };
  if (apiKey) keys[id] = String(apiKey).trim();
  // 新建的提供商自动切换为当前模型（控制台"确认添加"的文案一直这么承诺，
  // 此前却只建目录不切换 —— 用户添加完看到「尚未选择模型」+ 空的模型目录框）。
  updateConfig({
    providers,
    ...(apiKey ? { providerKeys: keys } : {}),
    api: { provider: id, model: entries[0]?.id || '' }
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
    p.modelNames = { ...p.modelNames };
    delete p.modelNames[modelId];
  }
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
        const data = await res.json();
        const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        count = list.length;
      } catch { /* body 不是 JSON */ }
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
