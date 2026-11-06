function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

export const LIVING_MEMORY_DEFAULTS = Object.freeze({
  enabled: false,
  graduated: false,
  mode: 'shadow',               // shadow = collect/recall audit only; active = inject recall into the prompt
  // 远程 Embedding 往返通常已经接近数百毫秒；450ms 会让本地向量排序与序列化没有余量。
  // 超时后保留关键词检索结果，不影响回复主链路。
  recallTimeoutMs: 1800,
  maxInjectChars: 2400,
  maxRecallItems: 6,
  rrfK: 60,
  recentMemoryCount: 2,
  autoInjectMaxItems: 3,
  autoInjectMinScore: 0.3,
  autoInjectDiversity: 0.68,
  autoInjectRecentContext: true,
  autoInjectMinQueryChars: 4,
  autoCapture: true,
  // Capture every allowed incoming message, independent of whether the bot replies.
  captureAllMessages: false,
  captureMinMessages: 6,
  captureIdleMs: 90000,
  // shadow 阶段只审计关键词召回；语义召回要等转正或手动“召回测试”时才付 Embedding 延迟与费用。
  shadowSemantic: false,
  allowPrivate: false,
  allowGlobal: false,
  // 0 keeps source turns indefinitely. The operator explicitly requested that
  // mode, so pruning must not silently impose the historical 5000-turn cap.
  turnRetentionDays: 7,
  groups: []
});

/** 只接受已知字段：旧实验配置里的 serviceUrl 等键不能原样写回 config.json。 */
export function normalizeLivingMemoryConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const groups = [...new Set((Array.isArray(source.groups) ? source.groups : [])
    .map((id) => String(id || '').trim()).filter((id) => /^\d{1,15}$/.test(id)))].slice(0, 5000);
  return {
    enabled: source.enabled === true,
    graduated: source.graduated === true,
    mode: source.mode === 'active' ? 'active' : 'shadow',
    recallTimeoutMs: clampInt(source.recallTimeoutMs, 300, 5000, LIVING_MEMORY_DEFAULTS.recallTimeoutMs),
    maxInjectChars: clampInt(source.maxInjectChars, 300, 8000, LIVING_MEMORY_DEFAULTS.maxInjectChars),
    maxRecallItems: clampInt(source.maxRecallItems, 1, 16, LIVING_MEMORY_DEFAULTS.maxRecallItems),
    rrfK: clampInt(source.rrfK, 10, 200, LIVING_MEMORY_DEFAULTS.rrfK),
    recentMemoryCount: clampInt(source.recentMemoryCount, 0, 4, LIVING_MEMORY_DEFAULTS.recentMemoryCount),
    autoInjectMaxItems: clampInt(source.autoInjectMaxItems, 1, 8, LIVING_MEMORY_DEFAULTS.autoInjectMaxItems),
    autoInjectMinScore: Math.max(0, Math.min(1, Number.isFinite(Number(source.autoInjectMinScore)) ? Number(source.autoInjectMinScore) : LIVING_MEMORY_DEFAULTS.autoInjectMinScore)),
    autoInjectDiversity: Math.max(0.2, Math.min(0.95, Number.isFinite(Number(source.autoInjectDiversity)) ? Number(source.autoInjectDiversity) : LIVING_MEMORY_DEFAULTS.autoInjectDiversity)),
    autoInjectRecentContext: source.autoInjectRecentContext !== false,
    autoInjectMinQueryChars: clampInt(source.autoInjectMinQueryChars, 1, 80, LIVING_MEMORY_DEFAULTS.autoInjectMinQueryChars),
    autoCapture: source.autoCapture !== false,
    captureAllMessages: source.captureAllMessages === true,
    captureMinMessages: clampInt(source.captureMinMessages, 2, 60, LIVING_MEMORY_DEFAULTS.captureMinMessages),
    captureIdleMs: clampInt(source.captureIdleMs, 10_000, 30 * 60_000, LIVING_MEMORY_DEFAULTS.captureIdleMs),
    shadowSemantic: source.shadowSemantic === true,
    allowPrivate: source.allowPrivate === true,
    allowGlobal: source.allowGlobal === true,
    turnRetentionDays: clampInt(source.turnRetentionDays, 0, 3650, LIVING_MEMORY_DEFAULTS.turnRetentionDays),
    groups
  };
}

/**
 * 一个 scope 是否在运营者声明的范围内。写接口与召回测试共用这一处判断，
 * 避免 API 只校验格式、却让手动写记忆绕过 groups/allowPrivate/allowGlobal。
 */
export function livingMemoryScopeAllowed(config, scopeKey) {
  const cfg = normalizeLivingMemoryConfig(config);
  if (cfg.enabled !== true) return false;
  const text = String(scopeKey || '');
  if (text === 'owner-global') return cfg.allowGlobal === true;
  if (text.startsWith('private:')) return cfg.allowPrivate === true && /^private:\d+$/.test(text);
  if (text.startsWith('group:')) {
    if (!/^group:\d+$/.test(text)) return false;
    return !cfg.groups.length || cfg.groups.includes(text.slice('group:'.length));
  }
  return false;
}

export function livingMemoryApplies(config, chatKey) {
  return livingMemoryScopeAllowed(config, chatKey);
}
