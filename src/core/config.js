// Production configuration adapter.
//
// The historical normalizer/persistence implementation remains in
// config-legacy.js for data-format compatibility. This module owns the current
// production invariants: promoted capabilities are not user-switchable,
// automated slang research is retired, and admin.ownerUin is the sole
// administrator configuration source.
import * as legacy from './config-legacy.js';
import { idList } from './list.js';
import {
  ASR_DEFAULT_PROVIDER, ASR_PROVIDERS,
  asrLocalModel, findWhisperBinSync
} from './config-legacy.js';
import {
  applyStableFeaturePolicy,
  globalAdminUin,
  stableFeatureFingerprint,
  suspendLegacyExperimentalGates
} from './stable-feature-policy.js';
import { validateBlacklistKeywordRules } from './keyword-rules.js';

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

function effectiveSectionBody(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const replaced = node.__replace__;
  return replaced && typeof replaced === 'object' && !Array.isArray(replaced) ? replaced : node;
}

function normalizedRequestedAdmin(patch, current) {
  // 整段替换（{__replace__:{...}}）必须按"有效体"判断是否显式提交：
  // 只看外层 hasOwn(ownerUin) 会让 `admin.__replace__={}` 绕过校验，
  // 结果 autoUpdate 已启用却被清空管理员（2026-10-31 复审 P2）。
  const node = patch?.admin;
  const replaced = node && typeof node === 'object' && !Array.isArray(node)
    && Object.hasOwn(node, '__replace__') && node.__replace__
    && typeof node.__replace__ === 'object' && !Array.isArray(node.__replace__)
    ? node.__replace__
    : null;
  const body = replaced || node;
  const explicit = Boolean(replaced) || hasOwn(body, 'ownerUin');
  if (!explicit) return { explicit: false, ownerUin: globalAdminUin(current) };
  const ownerUin = String(body?.ownerUin || '').trim();
  if (ownerUin && !/^\d{5,15}$/.test(ownerUin)) {
    throw new Error('管理员 QQ 必须为 5 到 15 位数字');
  }
  return { explicit: true, ownerUin };
}

/** 把补丁段写回“有效体”：`{__replace__: X}` 要改 X，不能写在外层（会被整段替换丢掉）。 */
function mergeIntoSegment(patch, key, nextBody) {
  const node = patch?.[key];
  if (node && typeof node === 'object' && !Array.isArray(node)
    && node.__replace__ && typeof node.__replace__ === 'object' && !Array.isArray(node.__replace__)) {
    node.__replace__ = { ...node.__replace__, ...nextBody };
    return;
  }
  const body = node && typeof node === 'object' && !Array.isArray(node) ? node : {};
  patch[key] = { ...body, ...nextBody };
}

function mirrorAdminIntoLegacyPatch(patch, ownerUin) {
  // These mirrors exist only until the remaining runtime modules stop reading
  // their historical paths. The retired slang worker intentionally has no
  // mirror at all: its old owner/tuning fields are removed by the policy.
  const identityBody = effectiveSectionBody(patch.identityPilot) || {};
  mergeIntoSegment(patch, 'identityPilot', {
    friendProposal: { ...(identityBody.friendProposal || {}), ownerUin }
  });
  mergeIntoSegment(patch, 'incidentPilot', { ownerUin });
  mergeIntoSegment(patch, 'autoUpdate', { ownerUin });
  return patch;
}

function ensureAdminPrivateAccess(patch, current, ownerUin) {
  if (!ownerUin) return patch;

  const allowBody = effectiveSectionBody(patch.allow) || {};
  const requestedAllow = Array.isArray(allowBody.private)
    ? allowBody.private.map(String)
    : idList(current.allow?.private);
  mergeIntoSegment(patch, 'allow', { private: [...new Set([...requestedAllow, ownerUin])] });

  const denyBody = effectiveSectionBody(patch.deny) || {};
  const requestedDeny = Array.isArray(denyBody.private)
    ? denyBody.private.map(String)
    : idList(current.deny?.private);
  mergeIntoSegment(patch, 'deny', { private: requestedDeny.filter((uin) => uin !== ownerUin) });
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

export function reloadConfig() {
  return stabilize(legacy.reloadConfig());
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

/** provider 列表与默认值定义在 config-legacy（读盘迁移要用），这里继续用并 re-export（见文件末尾）。 */
export function asrProvider(cfg = getConfig()) {
  const raw = String(cfg?.asr?.provider || '').trim().toLowerCase();
  return ASR_PROVIDERS.includes(raw) ? raw : ASR_DEFAULT_PROVIDER;
}

/**
 * 语音转文字用的 API Key：只认自己的（`asr.apiKey`，留空回退环境变量 ASR_API_KEY）。
 * ⚠️ 故意**不**回退到「搜索服务」的豆包 Key：搜索与转写是两套服务/两家供应商都可能，
 * 耦合会让"配没配搜索 Key"决定"能不能转写"（用户明确要求分开）。
 *
 * 另外：配置里的凭据与"存它时的服务"绑定（`asr.apiKeyProvider`，OpenAI 兼容再加 `asr.apiKeyHost`
 * 这一层主机名）。换服务/换地址后不再拿旧 Key 去发请求 —— 否则把火山的 Key 发到硅基流动、
 * 把腾讯的 SecretKey 当讯飞 APISecret 这类事都会静默发生（2026-09-26 审查，两处都实测复现）。
 * 环境变量不受此限：它是部署级的一个值，用户设它就意味着"给我当前配的那个供应商用"。
 */
/**
 * 当前这家该用的三项凭据（2026-10-02 用户要求："切换服务预设时 Key 跟着切换"）：
 * 活动槽那把按归属算（asrCredentialApplies），不适用就查"这家存过的"（asr.keys 映射，
 * 由 asrCredentialFor 兜底老配置的单槽）。都没有时 asrApiKey 再回落到环境变量。
 */
export function asrCredentials(cfg = getConfig()) {
  const asr = cfg?.asr || {};
  const provider = asrProvider(cfg);
  const pick = (kind, providerField, hostField) => {
    const stored = String(asr?.[kind] || '').trim();
    if (stored && legacy.asrCredentialApplies(asr, provider, stored, providerField, hostField)) return stored;
    return legacy.asrCredentialFor(asr, kind, provider, asr?.baseUrl);
  };
  return {
    slot: legacy.asrCredentialSlot(provider, asr?.baseUrl),
    apiKey: pick('apiKey', 'apiKeyProvider', 'apiKeyHost'),
    secretId: pick('secretId', 'secretIdProvider'),
    secretKey: pick('secretKey', 'secretKeyProvider')
  };
}

export function asrApiKey(cfg = getConfig()) {
  const resolved = asrCredentials(cfg).apiKey;
  if (resolved) return resolved;
  // provider 只是"升级默认值"（用户没选过）时，不拿部署级的环境变量 Key 去请求一个他没选过的服务：
  // 从控制台保存一次即固化 provider（并清掉这个标记），那时 env Key 照常生效（2026-09-26 审查 P2）
  if (cfg?.asr?.providerDefaulted === true) return '';
  // 存的那把"不属于这家"时**回落到环境变量**：ASR_API_KEY 是部署级的单一值，文档承诺它不受归属限制
  // （2026-09-26 审查：原来"存了但不适用"会把 env 彻底挡住，用户按文档设了也不生效）
  return String(process.env.ASR_API_KEY || '').trim();
}

/** 腾讯云的 SecretId（同 apiKey 的绑定规则 + 按服务记忆）。 */
export function asrSecretId(cfg = getConfig()) {
  return asrCredentials(cfg).secretId;
}

/**
 * 百度 Secret Key / 腾讯云 SecretKey / 讯飞 APISecret —— 三家共用 `asr.secretKey` 一个字段，
 * 所以归属必须记清：不记就会把腾讯的 SecretKey 发给百度或讯飞（2026-09-26 审查，实测复现）。
 */
export function asrSecretKey(cfg = getConfig()) {
  return asrCredentials(cfg).secretKey;
}

/** 当前配的这家，Key 绑定落在哪个主机上（控制台显示"这把 Key 是哪家的"用；非 OpenAI 兼容为空）。 */
export function asrKeyHost(cfg = getConfig()) {
  const stored = String(cfg?.asr?.apiKey || '').trim();
  if (!stored) return '';
  const provider = asrProvider(cfg);
  if (provider !== 'openai') return '';
  const bound = String(cfg?.asr?.apiKeyHost || '').trim();
  return bound || legacy.asrEndpointHost(cfg?.asr?.baseUrl);
}

/** Key 从哪来（控制台显示用）：'config' | 'env' | ''（没配）。 */
export function asrKeySource(cfg = getConfig()) {
  if (!asrApiKey(cfg)) return '';
  // 必须报"真正生效的那把从哪来"：存的那把不适用时会回落到 env，原来无条件按"存过就算 config"报，
  // 界面就不会提示"Key 来自环境变量"，用户撤掉 env 后会突然失效且找不到原因（2026-09-26 审查 P2）
  return asrCredentials(cfg).apiKey ? 'config' : 'env';
}

/**
 * 当前供应商是否已配置齐（够不够用）：
 * - volc / openai：要 Key；openai 兼容的还要地址与模型名（服务不同，模型名不能猜）。
 * - local：不需要 Key，但要填模型文件路径（二进制可省，默认找 whisper-cli）。
 */
export function asrConfigured(cfg = getConfig()) {
  const provider = asrProvider(cfg);
  // 本机转写要两样都齐：模型文件 + 能跑的二进制。只看模型会出现"注入了必失败"（2026-09-26 审查）。
  if (provider === 'local') {
    if (asrLocalModel(cfg) === '') return false;
    return Boolean(findWhisperBinSync(cfg));
  }
  if (provider === 'aliyun') return asrApiKey(cfg) !== '';                       // 地址/模型有默认值
  if (provider === 'baidu') return asrApiKey(cfg) !== '';                        // Secret Key 可选（老式才要）
  if (provider === 'tencent') {
    // 只认"为腾讯云存的"那对：同一个 secretKey 字段谁都可能往这填（百度/讯飞也用它）
    return asrSecretId(cfg) !== '' && asrSecretKey(cfg) !== '';
  }
  if (provider === 'iflytek') {
    return String(cfg?.asr?.appId || '').trim() !== '' && asrApiKey(cfg) !== ''
      && asrSecretKey(cfg) !== '';
  }
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

/** 每小时最多转写几次（按量计费服务的硬闸门，全局。#9 双闸的全局侧）。 */
export function asrMaxPerHour(cfg = getConfig()) {
  const n = Number(cfg?.asr?.maxPerHour);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.round(n)) : 12;
}

/** 每会话每小时最多转写几次（#9 双闸的会话侧）。 */
export function asrMaxPerHourPerChat(cfg = getConfig()) {
  const n = Number(cfg?.asr?.maxPerHourPerChat);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.round(n)) : 4;
}

/**
 * 图片生成是否可用：自己的开关打开，且地址与模型都填了。
 * 与聊天模型解耦：地址留空时适配器会按"与模型同域"补全，但这里要求显式有地址或模型同域可推。
 */
export function imageGenAvailable(cfg = getConfig()) {
  const g = cfg?.imageGen || {};
  if (g.enabled !== true) return false;
  const model = String(g.model || '').trim();
  if (!model) return false;
  const own = String(g.baseUrl || '').trim();
  if (own) return true;
  // 地址留空：只有"聊天模型那边有地址可用"才算配置齐（同域复用那套）
  return String(cfg?.api?.baseUrl || '').trim() !== '';
}

/** 每小时最多生成几张图（按张计费，唯一成本闸门）。 */
export function imageGenMaxPerHour(cfg = getConfig()) {
  const n = Number(cfg?.imageGen?.maxPerHour);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.round(n)) : 6;
}

export function updateConfig(patch, options = {}) {
  const current = stabilize(legacy.getConfig());
  const rawPatch = structuredClone(
    patch && typeof patch === 'object' ? patch : {}
  );
  // 控制台的整段替换用 { __replace__: {...} } 表达：校验要看替换后的内容，
  // 否则脚本/第三方客户端可以绕过 400（随后被加载期 sanitize 静默丢弃）。
  const storePatch = rawPatch?.store && typeof rawPatch.store === 'object'
    && Object.hasOwn(rawPatch.store, '__replace__')
    ? rawPatch.store.__replace__
    : rawPatch?.store;
  if (storePatch && typeof storePatch === 'object' && Object.hasOwn(storePatch, 'blacklistKeywords')) {
    if (!Array.isArray(storePatch.blacklistKeywords)) {
      throw Object.assign(new Error('消息关键词黑名单必须是数组'), { httpStatus: 400 });
    }
    const error = validateBlacklistKeywordRules(storePatch.blacklistKeywords);
    if (error) throw Object.assign(new Error(error), { httpStatus: 400 });
  }
  const requestedAdmin = normalizedRequestedAdmin(rawPatch, current);
  // autoUpdate 也可能是整段替换：只看外层会把 `autoUpdate.__replace__:{enabled:true}`
  // 当成“没启用”，从而让“清空管理员 + 开启自动更新”的组合绕过校验（2026-10-31 复审）。
  const autoNode = rawPatch?.autoUpdate;
  const autoPatch = effectiveSectionBody(autoNode);
  const autoReplaced = Boolean(autoNode && typeof autoNode === 'object' && !Array.isArray(autoNode)
    && Object.hasOwn(autoNode, '__replace__') && autoNode.__replace__
    && typeof autoNode.__replace__ === 'object' && !Array.isArray(autoNode.__replace__));
  // 整段替换后没写 enabled 时，实际生效值是 false（migrateConfig 只认 === true），
  // 不能按“当前开着”判断，否则会误报“自动更新不能清空管理员”（2026-10-31 复核 P3）。
  const autoUpdateEnabled = autoReplaced
    ? autoPatch?.enabled === true
    : (hasOwn(autoPatch, 'enabled') ? autoPatch.enabled === true : current.autoUpdate?.enabled === true);

  // Auto update has a real notification dependency. Promoted Identity/Incident
  // infrastructure does not: it remains active with no administrator and only
  // skips QQ notification/approval edges.
  if (!requestedAdmin.ownerUin && autoUpdateEnabled) {
    throw Object.assign(new Error('自动更新已启用，不能清空全局管理员 QQ'), { httpStatus: 400 });
  }

  // Reuse the mature legacy normalizer without allowing obsolete experimental
  // gates or per-feature owner fields to become configuration sources again.
  suspendLegacyExperimentalGates(current);
  const compatiblePatch = suspendLegacyExperimentalGates(rawPatch);
  mirrorAdminIntoLegacyPatch(compatiblePatch, requestedAdmin.ownerUin);
  ensureAdminPrivateAccess(compatiblePatch, current, requestedAdmin.ownerUin);

  try {
    const updated = legacy.updateConfig(compatiblePatch, options);
    // legacy.updateConfig 已经同步落过盘（含外部修改检测/原子写）；这里只在稳定特性策略
    // 真的改写了配置时再补一次保存。原来的 finally 无条件 scheduleConfigSave 会让每次保存
    // 都多写一次盘，连"校验失败被 400 拒绝"的请求也会在 400ms 后整体重写 config.json，
    // 可能在用户没保存任何东西时撞出 .conflict 备份。
    return stabilize(updated, { persist: true });
  } finally {
    // An unrelated validation error must never leave promoted infrastructure
    // gated off in the in-memory legacy object.
    applyStableFeaturePolicy(legacy.getConfig());
  }
}

export function setRuntimeConfig(config) {
  return legacy.setRuntimeConfig(applyStableFeaturePolicy(config));
}

export function scheduleConfigSave() {
  applyStableFeaturePolicy(legacy.getConfig());
  return legacy.scheduleConfigSave();
}
