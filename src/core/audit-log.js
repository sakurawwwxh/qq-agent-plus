// 控制台审计日志（改进方案 #5）：追加写 JSONL，**旁路语义** —— 任何写入/读取失败都只
// console.warn，绝不让业务请求 500 或变慢。设计定稿见方案附录 J.2 与 J.6.1。
//
// 落盘：<dir>/audit-YYYYMM.jsonl（自然月切文件；目录 0700、文件 0600，追加写）。
// 记录字段：ts, action, target, ip, fwd, ua, tokenFp, changed, before, after, ok, error,
//           truncated?, partial?
// 脱敏：before/after 先过"配置形态脱敏"（sanitizeConfigSecrets，保留 hasXxx 语义）再走
//       "通用深层脱敏"（redactSecretFields），最后逐字段 4KB 截断；整条 before+after 超过
//       RECORD_LIMIT 时降级为"只留 changed 顶层键"的 before/after 并标 partial。
// tokenFp：调用方传入（= sha256(控制台令牌) 前 8 位）；本模块不碰明文令牌。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { redactSecretFields, sanitizeConfigSecrets } from './secret-keys.js';
import { maskPluginSettings } from './diagnose.js';
import { redactText } from './redact.js';

const FIELD_LIMIT = 4096;            // 单字段 4KB 截断（J.2）
const RECORD_LIMIT = 256 * 1024;     // 整条 before+after 上限（J.6.1：配置快照已 24KB 量级）
const FILE_RE = /^audit-(\d{6})\.jsonl$/;

function resolveDir(dir) {
  return String(dir || '') || path.join(DATA_DIR, 'audit-log');
}

function monthKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fileFor(dir, ts) {
  return path.join(dir, `audit-${monthKeyOf(ts)}.jsonl`);
}

/** 逐字段截断（超长字符串 → 前 4KB + 标记）；深度上限 12，防爆栈。 */
function truncateDeep(node, state, depth = 0) {
  if (depth > 12) { state.truncated = true; return '[depth-limit]'; }
  if (typeof node === 'string') {
    if (node.length > FIELD_LIMIT) { state.truncated = true; return `${node.slice(0, FIELD_LIMIT)}…[截断]`; }
    return node;
  }
  if (Array.isArray(node)) return node.map((v) => truncateDeep(v, state, depth + 1));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = truncateDeep(v, state, depth + 1);
    return out;
  }
  return node;
}

/**
 * 审计值统一处理链：配置形态脱敏 → 通用脱敏 → 逐字段截断。
 * 任一步失败都不放弃整条记录：脱敏失败宁可不落值，也不落可疑原文。
 */
function prepareValue(value, state) {
  if (value === undefined || value === null) return null;
  let v = value;
  try { v = sanitizeConfigSecrets(v); } catch { state.truncated = true; }
  try { maskPluginSettings(v); } catch { state.truncated = true; }
  try { v = redactSecretFields(v); } catch { state.truncated = true; return '[unredacted]'; }
  return truncateDeep(v, state, 0);
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj ?? null;
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

const str = (v, n) => String(v ?? '').slice(0, n);

/**
 * 追加一条审计记录。**永不抛**：失败只 console.warn（旁路语义，J.2）。
 * entry.at 可注入时间戳（测试造跨月）；entry.dir 可覆盖落盘目录（ops/测试用）。
 */
export function appendAudit(entry = {}) {
  try {
    const ts = Number(entry.at) > 0 ? Number(entry.at) : Date.now();
    const dir = resolveDir(entry.dir);
    const state = { truncated: false };
    let before = prepareValue(entry.before, state);
    let after = prepareValue(entry.after, state);

    // 整包上限：超了就只留 changed 顶层键（J.6.1 在 J.2「单字段 4KB」之上补的口径）
    let partial = false;
    const keys = Array.isArray(entry.changed) ? entry.changed.map((k) => str(k, 80)).slice(0, 50) : [];
    if ((JSON.stringify(before) || '').length + (JSON.stringify(after) || '').length > RECORD_LIMIT) {
      if (keys.length) {
        before = pick(before, keys);
        after = pick(after, keys);
        partial = true;
      }
    }

    const record = {
      ts,
      action: str(entry.action, 100),
      target: str(entry.target, 200),
      ip: str(entry.ip, 100),
      fwd: str(entry.fwd, 200),
      ua: str(entry.ua, 200),
      tokenFp: str(entry.tokenFp, 32),
      changed: keys,
      ok: entry.ok !== false,
      error: entry.error ? redactText(entry.error, 500) : '',
      before,
      after,
      ...(state.truncated ? { truncated: true } : {}),
      ...(partial ? { partial: true } : {})
    };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = fileFor(dir, ts);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    // btrfs 兜底（Issue #11）：appendFileSync 的 mode 只在新建设备节点时生效，已存在的文件不会被改权限。
    // 本仓其它落盘点都补了这道 chmod，审计日志漏了 —— 而它恰恰装着配置快照、IP 与 UA。
    try { fs.chmodSync(file, 0o600); } catch { /* 权限设不上不影响审计本身 */ }
    return record;
  } catch (error) {
    try { console.warn('[audit] 写入失败（已忽略）:', error?.message ?? error); } catch { /* 忽略 */ }
    return null;
  }
}

/**
 * 分页查询：新→旧；limit 默认 200、硬上限 500（J.2：不做全量导出）；
 * beforeTs 为 ts 游标（只返回 ts < beforeTs 的记录）。返回 { entries, nextBefore }。
 */
export function queryAudit(options = {}) {
  const dir = resolveDir(options.dir);
  const limit = Math.min(Math.max(1, Math.floor(Number(options.limit) || 200)), 500);
  const beforeTs = Number(options.beforeTs) > 0 ? Number(options.beforeTs) : Infinity;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => FILE_RE.test(name)).sort().reverse();
  } catch { return { entries: [], nextBefore: null }; }

  const entries = [];
  let nextBefore = null;
  scan: for (const name of files) {
    let lines;
    try { lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec.ts !== 'number') continue;
      if (rec.ts >= beforeTs) continue;
      // 游标就是 ts 本身，下一页会把 `ts === nextBefore` 的记录整组跳过 —— 所以同一毫秒的
      // 记录必须在这一页全部取完（这一页可能比 limit 多几条），否则组内靠后的记录永远查不到
      // （2026-10-01 审查）。前提是日志按 ts 单调追加、跨月文件新的在前 —— 与游标法本身同一前提。
      if (nextBefore !== null && rec.ts < nextBefore) break scan;
      entries.push(rec);
      if (nextBefore === null && entries.length >= limit) nextBefore = rec.ts;
    }
  }
  return { entries, nextBefore };
}

/**
 * 清理超过保留月数的月文件。keepMonths 默认 6；dryRun 只报告不删。
 * 只删"比保留窗口更旧"的月份：未来月份（时钟偏差/人为造）一律保留，宁可留也不误删。
 * 返回 { dir, keepMonths, kept, removed, dryRun }。
 */
export function pruneAudit(options = {}) {
  const dir = resolveDir(options.dir);
  const keepMonths = Math.max(1, Math.floor(Number(options.keepMonths) || 6));
  const dryRun = options.dryRun === true;
  const anchor = new Date(Number(options.now) > 0 ? Number(options.now) : Date.now());
  const cutoff = new Date(anchor.getFullYear(), anchor.getMonth() - (keepMonths - 1), 1);
  const cutoffKey = `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
  const kept = [];
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { dir, keepMonths, kept, removed, dryRun }; }
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    if (m[1] >= cutoffKey) { kept.push(name); continue; }
    if (!dryRun) {
      // 删成功才计入 removed：删不掉（权限/占用）的文件不能报告成"已清理"，
      // 下次 prune 还会再试一次（2026-10-12 审查）。
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { continue; }
    }
    removed.push(name);
  }
  return { dir, keepMonths, kept, removed, dryRun };
}
