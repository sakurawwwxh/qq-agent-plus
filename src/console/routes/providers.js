// 提供商（模型接入）与本机 ASR 安装路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M2）。
// 这里只搬路由；ASR 安装的状态机（子进程/日志/删除托管目录）仍留在 createApp 里，
// 通过 snapshot/remove/start 三个闭包注入 —— 它和 stop() 的生命周期绑在一起，别硬拆。
import { isContainerRuntime } from '../../core/runtime.js';
import { asrApiKey, asrCredentialForSlot, asrCredentials } from '../../core/config.js';
import {
  fetchModelsFrom, currentProviders, setProviderKey, testAllProviders,
  testOneProvider, testModelChat, probeThinking, upsertProvider,
  addModelsToProvider, removeModelFromProvider
} from '../../core/providers.js';
import { resolveApiKey } from '../../llm/llm.js';

export function registerProviderRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const auditWrite = deps.auditWrite;
  const keyEndpointAllowed = deps.keyEndpointAllowed;
  const storedKeyAllowedFor = deps.storedKeyAllowedFor;
  const sanitizeProvider = deps.sanitizeProvider;
  const asrInstallSnapshot = deps.asrInstallSnapshot;
  const removeLocalAsrFiles = deps.removeLocalAsrFiles;
  const startAsrInstall = deps.startAsrInstall;
  const getAsrRunning = deps.getAsrRunning;
  const log = deps.log;
  if (!router || !json || !readBody || !getConfig || !auditWrite || !keyEndpointAllowed
    || !storedKeyAllowedFor || !sanitizeProvider || !asrInstallSnapshot || !removeLocalAsrFiles
    || !startAsrInstall || !getAsrRunning || !log) {
    throw new Error('registerProviderRoutes 需要 router/json/readBody/getConfig/auditWrite/密钥守卫/ASR 闭包/log');
  }

  router.add('GET', '/api/providers', async (req, res) => {
    const providers = currentProviders().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      baseURL: p.baseURL,
      apiKey: '',              // 不把真实 Key 暴露给 UI；有 Key 用 hasKey 表示
      apiKeyFrom: p.apiKeyFrom || '',
      needsBaseUrl: p.needsBaseUrl === true,
      hasKey: !!p.apiKey,
      anthropicOrigin: p.anthropicOrigin === true,
      models: p.models,
      modelNames: p.modelNames || {},
      preset: p.preset || '',
      thinkingProbe: p.thinkingProbe || null
    }));
    return json(res, 200, { providers });
  });
  router.add('GET', '/api/providers/key', async (req, res, params, url) => {
    if (!keyEndpointAllowed(req)) {
      return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
    }
    const pid = String(url.searchParams.get('providerId') || '');
    const p = currentProviders().find((x) => x.id === pid);
    return json(res, 200, { apiKey: p?.apiKey || '' });
  });
  router.add('POST', '/api/asr/models', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const baseUrl = String(body.baseUrl || cfgNow.asr?.baseUrl || '').trim();
      const submitted = String(body.apiKey ?? '').trim();
      const trimSlash = (value) => String(value || '').trim().replace(/[/]+$/, '').toLowerCase();
      const knownBase = trimSlash(cfgNow.asr?.baseUrl);
      const target = trimSlash(baseUrl);
      const apiKey = (submitted && submitted !== '******')
        ? submitted
        : (target && target === knownBase ? asrApiKey(cfgNow) : '');
      const all = await fetchModelsFrom(baseUrl, apiKey);
      // 用户要求：只取语音模型。列表里通常混着几百个 LLM，全给出来等于找不到东西。
      // 正向：转写类（whisper / sensevoice / ASR / speech-to-text / 转写…）。
      //   ⚠️ 关键词表必然不完备：硅基流动的 XingChenGSR 是语音识别，名字里却没有 asr
      //   （用户 2026-09-26 反馈"明明有 8 个只给 5 个"）。所以除了补关键词，
      //   还要把"被排除的 TTS"如实回报给界面 —— 用户能看出少的是哪几个、为什么少。
      const isAsrModel = (id) => /whisper|sensevoice|teleasr|funaudio|asr|gsr|paraformer|transcri|transcribe|audio.?to.?text|speech.?to.?text|recogni|stt|speech/i.test(id);
      // 反向：TTS（文字转语音）不是我们要的 —— 把 CosyVoice、tts-1、voice-clone 之类列进来只会误导。
      const isTtsModel = (id) => /tts|text.?to.?speech|cosyvoice|voice.?clone|voice.?design|speech.?synth|music|sing/i.test(id);
      const speech = all.filter((id) => isAsrModel(id) && !isTtsModel(id)).sort((a, b) => a.localeCompare(b));
      const tts = all.filter((id) => isTtsModel(id)).sort((a, b) => a.localeCompare(b));
      // 一家都没认出来时退回全量（宁可给多，也别让人以为"拉不到"），并如实说明
      const models = speech.length ? speech : [...all].sort((a, b) => a.localeCompare(b));
      return json(res, 200, {
        ok: true,
        models,
        speechOnly: speech.length > 0,
        speechCount: speech.length,
        // 被排除的语音合成模型：界面据此说明"少的那几个是什么"（只给前 3 个名字，别把提示撑满）
        ttsCount: tts.length,
        ttsSample: tts.slice(0, 3),
        total: all.length
      });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/asr/install-status', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    return json(res, 200, asrInstallSnapshot());
  });
  router.add('POST', '/api/asr/uninstall', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    // 与全站其它破坏性端点同一口径：必须显式 confirm —— 这是不可逆删除（约 500MB 模型与构建产物），
    // 之前唯一的防线是前端对话框，body 可为空的直接请求会把它们全删掉（2026-10-07 复审 P3）。
    const body = await readBody(req);
    if (body?.confirm !== true) return json(res, 409, { error: '删除本机转写需要显式确认' });
    if (getAsrRunning()) return json(res, 409, { error: '安装还在进行中，等它跑完再删' });
    try {
      const removed = removeLocalAsrFiles();
      // 破坏性操作留一行日志：以后能查"什么时候、删了哪个目录、放了多少空间"
      log(`[asr] 已完整卸载本机转写：${removed.managedDir}（释放 ${Math.round((removed.freedBytes || 0) / 1048576)}MB）`);
      return json(res, 200, { ok: true, ...removed, status: asrInstallSnapshot() });
    } catch (error) {
      return json(res, 500, { error: `删除失败：${String(error?.message ?? error)}` });
    }
  });
  router.add('POST', '/api/asr/install', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    if (isContainerRuntime()) {
      return json(res, 409, {
        error: '容器模式不支持在容器内编译 whisper.cpp（镜像里没有 git/cmake/编译工具）。'
          + '请改用托管 ASR，或构建包含 whisper.cpp 的自定义镜像。'
      });
    }
    try {
      const started = startAsrInstall();
      auditWrite('asr.install', '', { req, after: started });
      return json(res, 202, started);
    } catch (error) {
      auditWrite('asr.install', '', { req, ok: false, error: String(error?.message ?? error) });
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/asr-key', async (req, res, params, url) => {
    if (!keyEndpointAllowed(req)) {
      return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
    }
    const field = String(url.searchParams.get('field') || 'apiKey');
    const allowed = { apiKey: 'apiKey', secretId: 'secretId', secretKey: 'secretKey' };
    if (!Object.hasOwn(allowed, field)) return json(res, 400, { error: `未知字段：${field}` });
    const cfgNow = getConfig();
    const cred = asrCredentials(cfgNow);
    // 表单里刚切换、还没保存时，「显示」要回显**目标槽位**那把（与界面上的掩码同源）：
    // 直接按已保存配置解析会把上一家的明文显示在新服务名下（2026-10-02 全量审查实测），
    // 用户点一下「显示」再保存就把那家 Key 绑给了新的服务。目标槽位与当前槽位不一致时
    // 只认"明确属于目标槽位"的（映射 + 归属钉匹配），归属未知的不给别家回显。
    const slot = String(url.searchParams.get('slot') || '').trim().toLowerCase();
    if (slot && slot !== String(cred.slot || '').toLowerCase()) {
      const target = asrCredentialForSlot(cfgNow.asr, field, slot);
      return json(res, 200, { apiKey: target.owned ? target.value : '' });
    }
    // 回读的是**当前这家实际会用的**那一把（活动槽，或"这家存过的"）
    return json(res, 200, { apiKey: cred[field] || '' });
  });
  router.add('POST', '/api/providers/fetch-models', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
      const submitted = String(body.apiKey ?? '').trim();
      // 掩码 / 空 → 用服务端已保存的 Key，但仅限配置里已知的地址（见 storedKeyAllowedFor）。
      const apiKey = (submitted && submitted !== '******')
        ? submitted
        : (storedKeyAllowedFor(cfgNow, baseUrl) ? String(cfgNow.api.apiKey || '') : '');
      const models = await fetchModelsFrom(baseUrl, apiKey);
      return json(res, 200, { ok: true, models });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/test-one', async (req, res) => {
    try {
      const body = await readBody(req);
      const result = await testOneProvider({
        providerId: String(body.providerId ?? ''),
        baseUrl: String(body.baseUrl ?? ''),
        apiKey: String(body.apiKey ?? '')
      });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/test-chat', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const submitted = String(body.apiKey ?? '').trim();
      const baseUrl = String(body.baseUrl ?? '');
      // 掩码 / 空 → 说明客户端没有新 Key，用服务端已保存的；但只发往配置里已知的地址
      // （见 storedKeyAllowedFor：否则等于把明文 Key 送到调用方指定的任意主机）。
      const apiKey = (submitted && submitted !== '******')
        ? submitted
        : (storedKeyAllowedFor(cfgNow, baseUrl) ? resolveApiKey(cfgNow) : '');
      const result = await testModelChat({
        baseUrl,
        apiKey,
        model: String(body.model ?? '')
      });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/probe-thinking', async (req, res) => {
    try {
      const body = await readBody(req);
      // 支持用"未保存的当前选择"实测：thinking 传字符串或按用途对象；
      // extraBody 传对象。类型不合法一律忽略（回落到已保存配置）。
      const thinkingInput = (typeof body.thinking === 'string'
        || (body.thinking && typeof body.thinking === 'object' && !Array.isArray(body.thinking)))
        ? body.thinking : undefined;
      const extraInput = (body.extraBody && typeof body.extraBody === 'object' && !Array.isArray(body.extraBody))
        ? body.extraBody : undefined;
      const baseUrlIn = String(body.baseUrl ?? '');
      const submitted = String(body.apiKey ?? '').trim();
      // 与「测试连通性」「获取列表」同一条守卫：掩码/空 Key 时只把服务端已存的明文 Key
      // 发给配置里已知的地址——不能因为调用方随手填个地址就把 Key 送出去（终审发现漏了这条）。
      const apiKeyResolved = (submitted && submitted !== '******')
        ? submitted
        : (storedKeyAllowedFor(getConfig(), baseUrlIn || getConfig().api.baseUrl) ? resolveApiKey(getConfig()) : '');
      const result = await probeThinking({
        providerId: String(body.providerId ?? ''),
        model: String(body.model ?? ''),
        thinking: thinkingInput,
        extraBody: extraInput,
        baseUrl: baseUrlIn,
        apiKey: apiKeyResolved
      });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers', async (req, res) => {
    try {
      const body = await readBody(req);
      const r = upsertProvider({
        baseUrl: String(body.baseUrl ?? ''),
        apiKey: String(body.apiKey ?? ''),
        models: body.models || [],
        preset: String(body.preset ?? '')
      });
      auditWrite('providers.upsert', String(r.provider?.id ?? ''), { req, after: sanitizeProvider(r.provider) });
      return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
    } catch (error) {
      auditWrite('providers.upsert', '', { req, ok: false, error: String(error?.message ?? error) });
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/models', async (req, res) => {
    try {
      const body = await readBody(req);
      const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
      if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
      auditWrite('providers.models.add', String(body.providerId ?? ''), { req, after: sanitizeProvider(p) });
      return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
    } catch (error) {
      auditWrite('providers.models.add', '', { req, ok: false, error: String(error?.message ?? error) });
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', '/api/providers/models', async (req, res) => {
    try {
      const body = await readBody(req);
      const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
      if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
      auditWrite('providers.models.remove', String(body.providerId ?? ''), { req, after: sanitizeProvider(p) });
      return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
    } catch (error) {
      auditWrite('providers.models.remove', '', { req, ok: false, error: String(error?.message ?? error) });
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/set-key', async (req, res) => {
    const body = await readBody(req);
    const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
    if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
    // 只记 hasKey（明文 Key 由 core 的脱敏链兜底，即使误传也不会落盘）
    auditWrite('providers.key.set', String(body.providerId ?? ''), { req, after: { hasKey: !!updated.apiKey } });
    return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
  });
  router.add('POST', '/api/providers/test-all', async (req, res) => {
    const results = await testAllProviders(currentProviders());
    const okCount = Object.values(results).filter((r) => r.ok).length;
    return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
  });
}
