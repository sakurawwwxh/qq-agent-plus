// Production configuration adapter.
//
// The historical normalizer/persistence implementation remains in
// config-legacy.js for data-format compatibility. This module owns the current
// production invariants: promoted capabilities are not user-switchable,
// automated slang research is retired, and admin.ownerUin is the sole
// administrator configuration source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as legacy from './config-legacy.js';
import { ASR_DEFAULT_PROVIDER, ASR_PROVIDERS } from './config-legacy.js';
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

/** provider 列表与默认值定义在 config-legacy（读盘迁移要用），这里继续用并 re-export（见文件末尾）。 */
export function asrProvider(cfg = getConfig()) {
  const raw = String(cfg?.asr?.provider || '').trim().toLowerCase();
  return ASR_PROVIDERS.includes(raw) ? raw : ASR_DEFAULT_PROVIDER;
}

/** PATH 里按顺序尝试的候选名（安装脚本构建出来的名字是 whisper-cli）。 */
export const WHISPER_BIN_CANDIDATES = ['whisper-cli', 'whisper-cpp', 'main'];

/**
 * 本机转写的模型文件：配置 > 环境变量 WHISPER_MODEL > 标准位置里第一个 ggml-*.bin。
 * 标准位置按"越可能被安装到"的顺序找：<数据目录>/asr/（安装脚本的默认落点）、仓库 models/、
 * ~/.cache/whisper.cpp/。同名偏好 small → base → tiny → 其它，保证同一台机器上结果确定。
 */
export function asrLocalModel(cfg = getConfig()) {
  const configured = String(cfg?.asr?.localModel || '').trim();
  if (configured) return configured;
  const fromEnv = String(process.env.WHISPER_MODEL || '').trim();
  if (fromEnv) return fromEnv;
  const dirs = [
    path.join(legacy.DATA_DIR, 'asr'),
    path.join(legacy.ROOT, 'models'),
    path.join(os.homedir(), '.cache', 'whisper.cpp')
  ];
  const prefer = ['ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin'];
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^ggml-.+\.bin$/i.test(name)) continue;
      found.push(path.join(dir, name));
    }
  }
  if (!found.length) return '';
  const rank = (file) => {
    const base = path.basename(file).toLowerCase();
    const hit = prefer.indexOf(base);
    return hit === -1 ? prefer.length : hit;
  };
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

/**
 * 本机转写的可执行文件：配置 > 环境变量 WHISPER_BIN > 安装脚本的构建产物 > PATH 候选名。
 * 返回"打算用的那个"，真能不能跑由探测决定（见 asr-local.js 的 resolveWhisperBin）。
 */
export function asrLocalBin(cfg = getConfig()) {
  // "会用哪个"：配置/环境变量给了就用它（哪怕文件不在——这样用户能看见自己填错的那条路径）；
  // 否则找构建产物 / PATH 候选名。真要判定"能不能跑"用 findWhisperBinSync()（它做存在性检查）。
  const configured = String(cfg?.asr?.localBin || '').trim();
  if (configured) return configured;
  const fromEnv = String(process.env.WHISPER_BIN || '').trim();
  if (fromEnv) return fromEnv;
  return findWhisperBinSync(cfg) || '';
}

/** Windows 上要试 .exe 后缀；其它平台直接按名字找。 */
function binNamesOnPlatform() {
  const names = [...WHISPER_BIN_CANDIDATES];
  if (process.platform === 'win32') return [...names.map((n) => `${n}.exe`), ...names];
  return names;
}

/**
 * 同步找一遍可用的 whisper 二进制（配置里的路径 → 安装脚本的构建产物 → PATH 候选名）。
 * 只做存在性检查，够"要不要把工具注入给模型"用；真能不能跑由 asr-local.js 的异步探测定案。
 * 为什么要有这个：可用性判定若只认模型文件，会出现"工具注入了、提示词也说能转，
 * 但真调起来必失败"的矛盾（2026-09-26 审查）。
 */
export function findWhisperBinSync(cfg = getConfig()) {
  const configured = String(cfg?.asr?.localBin || '').trim() || String(process.env.WHISPER_BIN || '').trim();
  const built = path.join(legacy.DATA_DIR, 'asr', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
  const seen = new Set();
  for (const candidate of [configured, built, ...binNamesOnPlatform()]) {
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (candidate.includes(path.sep) || candidate.includes('/')) {
        if (fs.existsSync(candidate)) return candidate;
        continue;
      }
      const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
      for (const dir of dirs) {
        const full = path.join(dir, candidate);
        if (fs.existsSync(full)) return candidate;   // 交给子进程按 PATH 解析，避免拼出别的平台路径
      }
    } catch { /* 单个目录出问题就当没找到 */ }
  }
  return null;
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
export function asrApiKey(cfg = getConfig()) {
  const stored = String(cfg?.asr?.apiKey || '').trim();
  if (stored && legacy.asrCredentialApplies(cfg?.asr, asrProvider(cfg), stored, 'apiKeyProvider', 'apiKeyHost')) {
    return stored;
  }
  // 存的那把"不属于这家"时**回落到环境变量**：ASR_API_KEY 是部署级的单一值，文档承诺它不受归属限制
  // （2026-09-26 审查：原来"存了但不适用"会把 env 彻底挡住，用户按文档设了也不生效）
  return String(process.env.ASR_API_KEY || '').trim();
}

/** 腾讯云的 SecretId（同 apiKey 的绑定规则）。 */
export function asrSecretId(cfg = getConfig()) {
  const stored = String(cfg?.asr?.secretId || '').trim();
  return legacy.asrCredentialApplies(cfg?.asr, asrProvider(cfg), stored, 'secretIdProvider') ? stored : '';
}

/**
 * 百度 Secret Key / 腾讯云 SecretKey / 讯飞 APISecret —— 三家共用 `asr.secretKey` 一个字段，
 * 所以归属必须记清：不记就会把腾讯的 SecretKey 发给百度或讯飞（2026-09-26 审查，实测复现）。
 */
export function asrSecretKey(cfg = getConfig()) {
  const stored = String(cfg?.asr?.secretKey || '').trim();
  return legacy.asrCredentialApplies(cfg?.asr, asrProvider(cfg), stored, 'secretKeyProvider') ? stored : '';
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
