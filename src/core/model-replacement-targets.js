import { createHash } from 'node:crypto';
import { TTS_SERVICES, ttsServiceOfBaseUrl, ttsServiceOf, ttsKeyFor, ttsVoicesFor, ttsVoiceSlot } from '../llm/tts-presets.js';
import { IMAGEGEN_SERVICES, imageGenServiceOfBaseUrl } from '../llm/image-gen-presets.js';
import { asrCredentialFor, asrCredentialForSlot, asrCredentialSlot, asrEndpointHost, imageGenKeyResolve } from './config.js';
import { normalizeModelReplacement } from './model-replacement-config.js';

const asrServices = [
  { id: 'siliconflow', label: '硅基流动 · 转写', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['FunAudioLLM/SenseVoiceSmall'] },
  { id: 'aliyun', label: '阿里云百炼 · 转写', provider: 'aliyun', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-asr-flash'] },
  { id: 'groq', label: 'Groq · 转写', provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', models: ['whisper-large-v3-turbo', 'whisper-large-v3'] },
  { id: 'openai', label: 'OpenAI · 转写', provider: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'] },
  { id: 'baidu', label: '百度 · 转写', provider: 'baidu', baseUrl: '', models: ['1537'] },
  { id: 'tencent', label: '腾讯云 · 转写', provider: 'tencent', baseUrl: '', models: ['16k_zh'] },
  { id: 'iflytek', label: '讯飞 · 转写', provider: 'iflytek', baseUrl: '', models: ['iat'] },
  { id: 'volc', label: '火山 Seed-ASR', provider: 'volc', baseUrl: '', models: ['seed-asr'] }
];
const clean = (v) => String(v || '').trim();
const baseOf = (v) => clean(v).replace(/\/+$/, '');
const modelId = (m) => typeof m === 'string' ? m : m?.id;
const own = (obj, k) => obj && Object.hasOwn(obj, k) ? obj[k] : undefined;
const usableKey = (key) => clean(key) !== '******' ? clean(key) : '';
const normalizeReplacementEntrySafe = (entry) => {
  const source = ['catalog', 'service'].includes(entry?.source) ? entry.source : 'catalog';
  const providerId = clean(entry?.providerId);
  const model = clean(entry?.model);
  if (!providerId || !model) return null;
  const voice = clean(entry?.voice);
  return { source, providerId, model, ...(voice ? { voice } : {}) };
};
function catalogProvider(cfg, id) { return (cfg.providers || []).find((p) => p.id === id); }
function catalogKey(cfg, p) { return usableKey(own(cfg.providerKeys, p.id)) || usableKey(p.apiKey); }

/** Credential-free, complete registered model catalog plus media presets. */
export function replacementCatalog(cfg, channel) {
  const groups = (cfg.providers || []).map((p) => ({
    id: `catalog:${p.id}`, label: p.displayName || p.id,
    models: (p.models || []).map((m) => ({
      source: 'catalog', providerId: p.id, model: modelId(m),
      label: p.modelNames?.[modelId(m)] || modelId(m)
    })).filter((m) => m.model)
  }));
  const services = channel === 'asr' ? asrServices : channel === 'tts' ? TTS_SERVICES : channel === 'imageGen' ? IMAGEGEN_SERVICES : [];
  for (const s of services) {
    if (!s.baseUrl && !['baidu', 'tencent', 'iflytek', 'volc'].includes(s.id)) continue;
    const models = (s.models || []).map(modelId).filter(Boolean);
    if (channel === 'tts' && !models.length) models.push('default');
    // Include the current custom model without attempting a network model-list call.
    const active = cfg[channel] || {};
    const matches = s.baseUrl ? baseOf(s.baseUrl) === baseOf(active.baseUrl) : s.provider === active.provider;
    if (matches && active.model && !models.includes(active.model)) models.push(active.model);
    if (models.length) groups.push({
      id: `service:${s.id}`, label: s.label,
      models: models.map((model) => ({ source: 'service', providerId: s.id, model, label: model === 'default' ? '服务默认模型（使用已保存音色）' : model }))
    });
  }
  return groups;
}

function requireKey(key, label) {
  if (!usableKey(key)) throw Object.assign(new Error(`${label}未保存对应密钥，请先在该服务的设置中配置。`), { httpStatus: 400 });
  return key;
}

/** Resolve references server-side. Queue entries never contain endpoints or secrets. */
export function replacementTargetPatch(cfg, channel, entry) {
  let baseUrl, key = '', service;
  if (entry.source === 'catalog') {
    const p = catalogProvider(cfg, entry.providerId);
    if (!p || !(p.models || []).some((m) => modelId(m) === entry.model)) {
      throw Object.assign(new Error('替换模型已从模型目录删除，请重新选择。'), { httpStatus: 400 });
    }
    baseUrl = baseOf(p.baseURL);
    key = catalogKey(cfg, p);
    if (!baseUrl) throw Object.assign(new Error('替换模型缺少服务地址。'), { httpStatus: 400 });
    if (channel === 'chat') {
      requireKey(key, '聊天模型');
      const sameHost = asrEndpointHost(cfg.api?.baseUrl || '') === asrEndpointHost(baseUrl);
      // extraBody / thinkingParams 是用户给原服务商填的高级请求参数，可能含
      // authorization/x-api-key；换主机时不能原样发给另一家（与 imageGen 同口径）。
      return { api: { ...cfg.api, provider: p.id, baseUrl, model: entry.model, apiKey: '', ...(sameHost ? {} : { extraBody: {}, thinkingParams: {} }) } };
    }
  } else {
    const services = channel === 'asr' ? asrServices : channel === 'tts' ? TTS_SERVICES : channel === 'imageGen' ? IMAGEGEN_SERVICES : [];
    service = services.find((s) => s.id === entry.providerId);
    if (!service || !replacementCatalog(cfg, channel).some((g) => g.models.some((m) => m.source === 'service' && m.providerId === entry.providerId && m.model === entry.model))) {
      throw Object.assign(new Error('替换服务或模型不存在，请重新选择。'), { httpStatus: 400 });
    }
    baseUrl = baseOf(service.baseUrl);
  }
  if (channel === 'asr') {
    const old = cfg.asr || {};
    // Alibaba's qwen-ASR uses chat/completions, not audio/transcriptions.
    const provider = service?.provider || (/dashscope\.aliyuncs\.com/.test(baseUrl) && /qwen.*asr/i.test(entry.model) ? 'aliyun' : 'openai');
    const slot = asrCredentialSlot(provider, baseUrl);
    // 无归属的旧单槽凭据只允许在当前同一地址（原生云服务还要求同一 provider）上沿用，
    // 与运行期 asrCredentialFor 的兼容口径一致；换主机/换厂商仍只认明确归属的凭据。
    const sameEndpoint = baseOf(old.baseUrl) === baseUrl
      && (provider === 'openai' || String(old.provider || '').trim().toLowerCase() === provider);
    const credentials = {};
    for (const kind of ['apiKey', 'secretId', 'secretKey']) {
      const owned = asrCredentialForSlot(old, kind, slot).value;
      credentials[kind] = owned || (sameEndpoint ? asrCredentialFor(old, kind, provider, baseUrl) : '');
    }
    credentials.apiKey ||= key;
    if (provider === 'tencent') { requireKey(credentials.secretId, '腾讯云 SecretId'); requireKey(credentials.secretKey, '腾讯云 SecretKey'); }
    else {
      requireKey(credentials.apiKey, '语音转文字');
      if (provider === 'iflytek') { requireKey(credentials.secretKey, '讯飞 APISecret'); requireKey(old.appId, '讯飞 AppID'); }
    }
    const next = { ...old, ...credentials, provider, baseUrl, model: entry.model, providerDefaulted: false,
      apiKeyProvider: provider, apiKeyHost: provider === 'openai' ? asrEndpointHost(baseUrl) : '',
      secretIdProvider: provider, secretKeyProvider: provider,
      keys: { ...old.keys, [slot]: credentials }
    };
    if (provider === 'tencent') next.tencentEngineModelType = entry.model;
    if (provider === 'baidu') next.baiduDevPid = Number(entry.model) || 1537;
    return { asr: next };
  }
  if (channel === 'tts') {
    const old = cfg.tts || {};
    service ||= ttsServiceOfBaseUrl(baseUrl);
    const id = service?.id || 'custom';
    const sameEndpoint = baseOf(old.baseUrl) === baseUrl;
    // A generic 'custom' credential is NOT transferable to another custom host.
    const stored = id !== 'custom' || sameEndpoint ? ttsKeyFor(old, id) : '';
    key = usableKey(stored) || key;
    requireKey(key, '语音回复');
    const candidates = ttsVoicesFor(id, entry.model);
    const voiceSlot = ttsVoiceSlot(baseUrl, entry.model === 'default' ? '' : entry.model);
    const savedVoice = own(old.voiceSlots, voiceSlot) || (id !== 'custom' ? own(old.voices, id) : '') || (sameEndpoint ? old.voice : '');
    const explicitVoice = clean(entry.voice);
    let voice = explicitVoice || savedVoice;
    if (!explicitVoice && (!voice || (candidates.length && !candidates.includes(voice) && !candidates.includes(voice.split(':').pop())))) voice = candidates[0] || '';
    if (!voice) throw Object.assign(new Error('目标 TTS 服务没有可用音色，请在替换链里填写音色，或先在语音回复设置中保存该服务的音色。'), { httpStatus: 400 });
    if (id === 'siliconflow' && !voice.startsWith(entry.model + ':')) voice = `${entry.model}:${voice.split(':').pop()}`;
    const next = { ...old, provider: service?.provider || 'openai', baseUrl,
      model: entry.model === 'default' ? '' : entry.model, voice,
      apiKey: key, apiKeyService: id, keys: { ...old.keys, [id]: key }, voices: { ...old.voices, [id]: voice },
      voiceSlots: { ...old.voiceSlots, ...(old.voice ? { [ttsVoiceSlot(old.baseUrl, old.model)]: old.voice } : {}), [voiceSlot]: voice }
    };
    if (['volc', 'minimax'].includes(next.provider)) requireKey(next.provider === 'volc' ? old.appId : old.groupId, next.provider === 'volc' ? '火山 AppID' : 'MiniMax GroupId');
    return { tts: next };
  }
  if (channel === 'imageGen') {
    const old = cfg.imageGen || {};
    const host = asrEndpointHost(baseUrl);
    const owned = imageGenKeyResolve(old, host);
    // 旧配置的单槽 Key 可能没记 apiKeyHost（运行期在同一地址仍会用它）。只有目标
    // 就是当前同一地址时才沿用；换主机绝不把无归属的旧 Key 递过去。
    const sameEndpoint = baseOf(old.baseUrl || cfg.api?.baseUrl) === baseUrl;
    key = (owned.owned || sameEndpoint ? owned.value : '') || key;
    const preset = imageGenServiceOfBaseUrl(baseUrl);
    if (preset?.shape !== 'pollinations') requireKey(key, '图片生成');
    return { imageGen: { ...old, baseUrl, model: entry.model,
      apiKey: key, apiKeyHost: key ? host : '', keys: { ...old.keys, ...(key ? { [host]: key } : {}) },
      // Provider-specific image arguments must not follow a switch to another API.
      extraBody: sameEndpoint ? old.extraBody : {}
    } };
  }
  throw Object.assign(new Error('未知的模型替换链。'), { httpStatus: 400 });
}

/**
 * 逐项解析替换链目标，提前暴露“保存时有效、运行时已失效”的配置问题。
 * 只做本地解析（目录项、凭据归属、音色回退），不发网络请求、不产生费用。
 */
export function replacementReadiness(cfg, channel, entriesOverride = null) {
  const chain = normalizeModelReplacement(cfg.modelReplacement)[channel];
  const sourceEntries = Array.isArray(entriesOverride)
    ? entriesOverride.slice(0, 64).map((entry) => entry ? normalizeReplacementEntrySafe(entry) : null)
    : chain.entries;
  const entries = sourceEntries.map((entry, index) => {
    if (!entry) return { index, empty: true, ready: false, label: '', reason: '空槽，运行时跳过' };
    const label = `${entry.model} · ${entry.providerId}`;
    try {
      const patch = replacementTargetPatch(cfg, channel, entry);
      const target = channel === 'chat' ? patch.api
        : channel === 'asr' ? patch.asr
          : channel === 'tts' ? patch.tts : patch.imageGen;
      return {
        index, empty: false, ready: true, label,
        model: entry.model,
        ...(channel === 'tts' ? { voice: target?.voice || '' } : {}),
        baseUrl: target?.baseUrl || ''
      };
    } catch (error) {
      return { index, empty: false, ready: false, label, model: entry.model, reason: String(error?.message ?? error) };
    }
  });
  const used = entries.filter((item) => !item.empty);
  return {
    channel,
    enabled: chain.enabled,
    nextIndex: chain.nextIndex,
    revision: chain.revision,
    lastModel: chain.lastModel,
    lastSwitchAt: chain.lastSwitchAt,
    history: chain.history,
    entries,
    total: used.length,
    readyCount: used.filter((item) => item.ready).length,
    invalidCount: used.filter((item) => !item.ready).length,
    ready: used.every((item) => item.ready)
  };
}

export function replacementIdentity(cfg, channel) {
  const s = channel === 'chat' ? cfg.api : cfg[channel];
  const key = channel === 'chat'
    ? (cfg.api?.provider ? own(cfg.providerKeys, cfg.api.provider) || (cfg.providers || []).find((p) => p.id === cfg.api.provider)?.apiKey : s?.apiKey)
    : channel === 'tts' ? ttsKeyFor(s) : s?.apiKey;
  const fingerprint = createHash('sha256').update(JSON.stringify([key || '', s?.secretId || '', s?.secretKey || ''])).digest('hex');
  return JSON.stringify([s?.provider || '', s?.baseUrl || (channel === 'imageGen' ? cfg.api?.baseUrl : ''), s?.model || '', channel === 'tts' ? ttsServiceOf(s)?.id : '', fingerprint]);
}
