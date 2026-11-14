// Persisted, credential-free queues shared by chat / ASR / TTS / image generation.
export const REPLACEMENT_CHANNELS = ['chat', 'asr', 'tts', 'imageGen'];
export const MAX_REPLACEMENT_ENTRIES = 64;
export const DEFAULT_REPLACEMENT_TRIGGERS = Object.freeze({ http402: true, http403: true, quota429: true, http401: false });
export function normalizeReplacementTriggers(raw) {
  return Object.fromEntries(Object.entries(DEFAULT_REPLACEMENT_TRIGGERS).map(([key, fallback]) =>
    [key, typeof raw?.[key] === 'boolean' ? raw[key] : fallback]));
}
function validateTriggers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !Object.hasOwn(DEFAULT_REPLACEMENT_TRIGGERS, key))
    || Object.keys(DEFAULT_REPLACEMENT_TRIGGERS).some((key) => typeof raw[key] !== 'boolean')) {
    throw Object.assign(new Error('触发条件必须包含四项布尔值，不能提交其他字段。'), { httpStatus: 400 });
  }
  return normalizeReplacementTriggers(raw);
}
const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const text = (v) => typeof v === 'string' ? v.trim().slice(0, 300) : '';
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));

export function normalizeReplacementEntry(value) {
  const v = object(value);
  const source = ['catalog', 'service'].includes(v.source) ? v.source : 'catalog';
  const providerId = text(v.providerId);
  const model = text(v.model);
  if (!providerId || !model || ['__proto__', 'constructor', 'prototype'].includes(providerId)) return null;
  return { source, providerId, model };
}

export function normalizeModelReplacement(raw) {
  const input = object(raw);
  return Object.fromEntries(REPLACEMENT_CHANNELS.map((channel) => {
    const c = object(input[channel]);
    const entries = Array.isArray(c.entries)
      ? c.entries.slice(0, MAX_REPLACEMENT_ENTRIES).map(normalizeReplacementEntry)
      : [null, null, null];
    const nextIndex = integer(c.nextIndex, entries.length);
    return [channel, {
      enabled: c.enabled === true && entries.some(Boolean) && nextIndex < entries.length,
      entries, triggers: normalizeReplacementTriggers(c.triggers), nextIndex, revision: integer(c.revision),
      lastSwitchAt: integer(c.lastSwitchAt),
      lastModel: text(c.lastModel)
    }];
  }));
}

// Browser edits cannot forge a queue cursor or overwrite progress from a model error
// which arrived while the settings page was open. Internal runtime updates use
// updateConfig directly; this function belongs to the authenticated POST route.
export function configureModelReplacement(current, submitted) {
  const before = normalizeModelReplacement(current);
  const input = object(submitted);
  const result = {};
  for (const channel of REPLACEMENT_CHANNELS) {
    if (!Object.hasOwn(input, channel)) continue;
    const value = object(input[channel]);
    const old = before[channel];
    if (value.revision !== old.revision) {
      throw Object.assign(new Error('模型替换链已在后台变化，请重新加载设置后再保存。'), { httpStatus: 409, code: 'REPLACEMENT_CONFLICT' });
    }
    const editsQueue = Object.hasOwn(value, 'entries') || Object.hasOwn(value, 'enabled');
    if (editsQueue && (typeof value.enabled !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > MAX_REPLACEMENT_ENTRIES)) {
      throw Object.assign(new Error('请提交开关和模型列表，最多 64 个选择框。'), { httpStatus: 400 });
    }
    const entries = editsQueue ? value.entries.map((entry) => {
      if (entry === null) return null;
      const normalized = normalizeReplacementEntry(entry);
      if (!normalized) throw Object.assign(new Error('替换链的模型选择无效。'), { httpStatus: 400 });
      return normalized;
    }) : old.entries;
    const enabled = editsQueue ? value.enabled : old.enabled;
    if (enabled && !entries.some(Boolean)) throw Object.assign(new Error('请至少选择一个替换模型后再启用。'), { httpStatus: 400 });
    const triggers = Object.hasOwn(value, 'triggers') ? validateTriggers(value.triggers) : old.triggers;
    const rulesChanged = JSON.stringify(triggers) !== JSON.stringify(old.triggers);
    const changed = JSON.stringify(entries) !== JSON.stringify(old.entries);
    result[channel] = {
      ...old, entries, enabled, triggers,
      nextIndex: changed || (enabled && !old.enabled) ? 0 : old.nextIndex,
      revision: old.revision + (changed || rulesChanged || enabled !== old.enabled ? 1 : 0)
    };
  }
  return result;
}
