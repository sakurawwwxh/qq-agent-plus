// Production configuration adapter.
//
// The historical normalizer/persistence implementation remains in
// config-legacy.js for data-format compatibility. This module owns the current
// production invariants: promoted capabilities are not user-switchable,
// automated slang research is retired, and admin.ownerUin is the sole
// administrator configuration source.
import * as legacy from './config-legacy.js';
import {
  applyStableFeaturePolicy,
  globalAdminUin,
  stableFeatureFingerprint,
  suspendLegacyExperimentalGates
} from './stable-feature-policy.js';

export * from './config-legacy.js';

function stabilize(config, { persist = false } = {}) {
  const before = stableFeatureFingerprint(config);
  applyStableFeaturePolicy(config);
  if (persist && before !== stableFeatureFingerprint(config)) {
    legacy.scheduleConfigSave();
  }
  return config;
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function normalizedRequestedAdmin(patch, current) {
  const explicit = hasOwn(patch?.admin, 'ownerUin');
  if (!explicit) return { explicit: false, ownerUin: globalAdminUin(current) };
  const ownerUin = String(patch.admin.ownerUin || '').trim();
  if (ownerUin && !/^\d{5,15}$/.test(ownerUin)) {
    throw new Error('管理员 QQ 必须为 5 到 15 位数字');
  }
  return { explicit: true, ownerUin };
}

function mirrorAdminIntoLegacyPatch(patch, ownerUin) {
  // These mirrors exist only until the remaining runtime modules stop reading
  // their historical paths. The retired slang worker intentionally has no
  // mirror at all: its old owner/tuning fields are removed by the policy.
  patch.identityPilot = {
    ...(patch.identityPilot || {}),
    friendProposal: {
      ...(patch.identityPilot?.friendProposal || {}),
      ownerUin
    }
  };
  patch.incidentPilot = {
    ...(patch.incidentPilot || {}),
    ownerUin
  };
  patch.autoUpdate = {
    ...(patch.autoUpdate || {}),
    ownerUin
  };
  return patch;
}

function ensureAdminPrivateAccess(patch, current, ownerUin) {
  if (!ownerUin) return patch;

  const requestedAllow = Array.isArray(patch.allow?.private)
    ? patch.allow.private.map(String)
    : (current.allow?.private || []).map(String);
  patch.allow = {
    ...(patch.allow || {}),
    private: [...new Set([...requestedAllow, ownerUin])]
  };

  const requestedDeny = Array.isArray(patch.deny?.private)
    ? patch.deny.private.map(String)
    : (current.deny?.private || []).map(String);
  patch.deny = {
    ...(patch.deny || {}),
    private: requestedDeny.filter((uin) => uin !== ownerUin)
  };
  return patch;
}

// Explicit exports override names re-exported by `export *`.
export const DEFAULT_CONFIG = applyStableFeaturePolicy(
  structuredClone(legacy.DEFAULT_CONFIG)
);

export function loadConfig() {
  return stabilize(legacy.loadConfig());
}

export function getConfig() {
  return stabilize(legacy.getConfig(), { persist: true });
}

/** The only administrator QQ configuration read/written by current code. */
export function adminOwnerUin(cfg = getConfig()) {
  return globalAdminUin(cfg);
}

// Compatibility helpers retained because current runtime modules still import
// the old names. They are constants now, not feature gates.
export function identityPilotEnabled() {
  return true;
}

// 主动好友候选已退役（Issue #10）：协议路径被服务端统一拒绝（业务码恒 1），
// SnowLuma 上游明确不暴露内核加好友能力（#480 not_planned），连续实验还触发过
// QQ 账号风控。功能永久关闭，不随配置恢复。
export function friendProposalEnabled() {
  return false;
}

export function triggeredFriendProposalEnabled(cfg = getConfig()) {
  return cfg?.identityPilot?.friendProposal?.mode === 'triggered';
}

export function promptFriendProposalEnabled(cfg = getConfig()) {
  return cfg?.identityPilot?.friendProposal?.mode !== 'triggered';
}

export function incomingFriendRequestEnabled() {
  return true;
}

// 同上：主动好友派发随功能一起退役，永久关闭。
export function friendRequestDispatchEnabled() {
  return false;
}

/** Compatibility tombstone: automated slang research cannot be reactivated. */
export function slangPilotEnabled() {
  return false;
}

export function incidentPilotEnabled() {
  return true;
}

/** 语音转写的供应商：'volc'（火山 Seed-ASR）/ 'openai'（任意 OpenAI 兼容服务）/ 'local'（本机 whisper.cpp）。 */
export const ASR_PROVIDERS = ['volc', 'openai', 'local'];
export function asrProvider(cfg = getConfig()) {
  const raw = String(cfg?.asr?.provider || '').trim().toLowerCase();
  return ASR_PROVIDERS.includes(raw) ? raw : 'volc';
}

/**
 * 语音转文字用的 API Key：只认自己的（`asr.apiKey`，留空回退环境变量 ASR_API_KEY）。
 * ⚠️ 故意**不**回退到「搜索服务」的豆包 Key：搜索与转写是两套服务/两家供应商都可能，
 * 耦合会让"配没配搜索 Key"决定"能不能转写"（用户明确要求分开）。
 *
 * 另外：配置里的 Key 与"存它时的供应商"绑定（`asr.apiKeyProvider`）。换供应商后不再拿旧 Key 去发请求 ——
 * 否则把火山的 Key 发到 Groq/硅基流动那种事会静默发生（2026-09-26 审查）。环境变量不受此限：
 * 它是部署级的一个值，用户设它就意味着"给我当前配的那个供应商用"。
 */
export function asrApiKey(cfg = getConfig()) {
  const stored = String(cfg?.asr?.apiKey || '').trim();
  const storedFor = String(cfg?.asr?.apiKeyProvider || '').trim().toLowerCase();
  if (stored) {
    if (storedFor && storedFor !== asrProvider(cfg)) return '';
    return stored;
  }
  return String(process.env.ASR_API_KEY || '').trim();
}

/** Key 从哪来（控制台显示用）：'config' | 'env' | ''（没配）。 */
export function asrKeySource(cfg = getConfig()) {
  if (asrApiKey(cfg)) return String(cfg?.asr?.apiKey || '').trim() ? 'config' : 'env';
  return '';
}

/**
 * 当前供应商是否已配置齐（够不够用）：
 * - volc / openai：要 Key；openai 兼容的还要地址与模型名（服务不同，模型名不能猜）。
 * - local：不需要 Key，但要填模型文件路径（二进制可省，默认找 whisper-cli）。
 */
export function asrConfigured(cfg = getConfig()) {
  const provider = asrProvider(cfg);
  if (provider === 'local') return String(cfg?.asr?.localModel || '').trim() !== '';
  if (provider === 'openai') {
    return asrApiKey(cfg) !== ''
      && String(cfg?.asr?.baseUrl || '').trim() !== ''
      && String(cfg?.asr?.model || '').trim() !== '';
  }
  return asrApiKey(cfg) !== '';
}

/**
 * 语音转文字（ASR）是否可用：自己的开关打开，且当前供应商配置齐了。
 * 与「联网搜索」开关、与搜索用的 Key **完全独立**：换供应商只改 asr 这一节。
 */
export function asrAvailable(cfg = getConfig()) {
  return cfg?.asr?.enabled !== false && asrConfigured(cfg);
}

/** 每小时最多转写几次（按量计费服务的硬闸门）。 */
export function asrMaxPerHour(cfg = getConfig()) {
  const n = Number(cfg?.asr?.maxPerHour);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.round(n)) : 12;
}

export function updateConfig(patch) {
  const current = stabilize(legacy.getConfig());
  const rawPatch = structuredClone(
    patch && typeof patch === 'object' ? patch : {}
  );
  const requestedAdmin = normalizedRequestedAdmin(rawPatch, current);
  const autoUpdateEnabled = hasOwn(rawPatch?.autoUpdate, 'enabled')
    ? rawPatch.autoUpdate.enabled === true
    : current.autoUpdate?.enabled === true;

  // Auto update has a real notification dependency. Promoted Identity/Incident
  // infrastructure does not: it remains active with no administrator and only
  // skips QQ notification/approval edges.
  if (!requestedAdmin.ownerUin && autoUpdateEnabled) {
    throw new Error('自动更新已启用，不能清空全局管理员 QQ');
  }

  // Reuse the mature legacy normalizer without allowing obsolete experimental
  // gates or per-feature owner fields to become configuration sources again.
  suspendLegacyExperimentalGates(current);
  const compatiblePatch = suspendLegacyExperimentalGates(rawPatch);
  mirrorAdminIntoLegacyPatch(compatiblePatch, requestedAdmin.ownerUin);
  ensureAdminPrivateAccess(compatiblePatch, current, requestedAdmin.ownerUin);

  try {
    const updated = legacy.updateConfig(compatiblePatch);
    return stabilize(updated);
  } finally {
    // An unrelated validation error must never leave promoted infrastructure
    // gated off in the in-memory legacy object.
    applyStableFeaturePolicy(legacy.getConfig());
    legacy.scheduleConfigSave();
  }
}

export function setRuntimeConfig(config) {
  return legacy.setRuntimeConfig(applyStableFeaturePolicy(config));
}

export function scheduleConfigSave() {
  applyStableFeaturePolicy(legacy.getConfig());
  return legacy.scheduleConfigSave();
}
