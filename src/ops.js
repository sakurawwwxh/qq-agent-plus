#!/usr/bin/env node
// QQ Agent 运维工具（唯一入口）。
//
// 原 ops/ 目录下的 shell / python 脚本已全部移植到这里，只用 Node 内置模块，
// 不引入任何新依赖。用法：node src/ops.js <子命令> [选项]；每个子命令支持 --help。
//
// 约定：
//   - 只读子命令（audit / audit-host / scan / watch-* / face-names --print / console --print）
//     不写业务数据；
//   - 破坏性操作（backup / deploy / guard 真实执行 / install-timers 写盘 / audit-prune 删文件）必须显式 --confirm，
//     预先查看可用 --dry-run / --print；
//   - 外部命令（systemctl / docker / journalctl / ss / tar ...）缺失时，对应段落自动降级为
//     「跳过」，不会中断整体体检；
//   - 所有路径与凭据只从环境变量读取，本文件不含任何真实地址、令牌、账号。
//   - 输出为中文，无 emoji。
//
// 环境变量清单与示例见 docs/OPS.md。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './core/sqlite.js';
import { runHealthCheck } from './core/health-check.js';
import { readTextBounded } from './core/http-body.js';
import { SNOWLUMA_BASELINE_IMAGE, createSnowlumaUpdater } from './core/snowluma-update.js';
import { readOwnerUin, sendOwnerText } from './core/notify-owner.js';
import { isContainerRuntime, containerUpdateHint } from './core/runtime.js';
import { idList } from './core/list.js';
import { listSessionFiles, readSessionFile } from './core/session-files.js';
import { EffectLedger } from './core/effects.js';
import { inspectInstanceLock } from './core/instance-lock.js';
import {
  storageBreakdown, sessionStorage, redactedConfig, pluginSummary, incidentSummary,
  effectSummary, logTail, buildDiagnoseEntries, writeDiagnoseArchive
} from './core/diagnose.js';
import { pruneAudit } from './core/audit-log.js';
import { installPlugin, uninstallPlugin, readPluginInstallInfo, sha256Of } from './plugins/install.js';
import { resolveModelPrice, modelLabel, setRemotePrices, setChannelPrices } from './pricing/model-prices.js';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

// ───────────────────────────────── 基础工具 ─────────────────────────────────

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function envStr(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return envStr('USER', 'unknown');
  }
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readFileNormalized(file) {
  return readFileSafe(file).replace(/\r\n/g, '\n');
}

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function formatStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function config(overrides = {}) {
  const rootDir = overrides.dir || envStr('QQ_AGENT_DIR', '/data/qq-agent');
  return {
    rootDir,
    appDir: overrides.app || envStr('QQ_AGENT_APP_DIR', path.join(rootDir, 'app')),
    dataDir: overrides.data || envStr('QQ_AGENT_DATA_DIR', path.join(rootDir, 'data')),
    backupDir: overrides.backupDir || envStr('QQ_AGENT_BACKUP_DIR', path.join(os.homedir(), 'qq-agent', 'backups')),
    service: envStr('QQ_AGENT_SERVICE', 'qq-agent-linux.service'),
    updateTimer: envStr('QQ_AGENT_UPDATE_TIMER', 'qq-agent-linux-update.timer'),
    guardTimer: envStr('QQ_AGENT_GUARD_TIMER', 'process-guard.timer'),
    consolePort: envStr('QQ_AGENT_CONSOLE_PORT', '3210'),
    onebotPort: envStr('QQ_AGENT_ONEBOT_HTTP_PORT', '3390'),
    webuiPort: envStr('QQ_AGENT_WEBUI_PORT', '5099'),
    vncPort: envStr('QQ_AGENT_VNC_PORT', '6081'),
    user: envStr('QQ_AGENT_USER', currentUser()),
    guardUser: envStr('QQ_AGENT_GUARD_USER', envStr('QQ_AGENT_USER', currentUser())),
    keep: intEnv('QQ_AGENT_KEEP', 4),
    snowlumaContainer: envStr('QQ_AGENT_SNOWLUMA_CONTAINER', 'qq-agent-snowluma'),
    // 协议端 compose 项目（.env + docker-compose.yml 所在地）：一键更新与版本检查都读这里
    snowlumaDir: envStr('QQ_AGENT_SNOWLUMA_DIR', path.join(rootDir, 'snowluma')),
    node: envStr('QQ_AGENT_NODE', ''),
    log: envStr('QQ_AGENT_LOG', path.join(os.homedir(), 'qq-agent-undefined-calls.log'))
  };
}

// ───────────────────────────────── 输出 ─────────────────────────────────

const say = (line = '') => { process.stdout.write(`${line}\n`); };

function section(title) {
  say();
  say(`===== ${title} =====`);
}

let ngCount = 0;
let warnCount = 0;

const okLine = (msg) => say(`  OK  ${msg}`);
const ngLine = (msg) => { say(`  NG  ${msg}`); ngCount += 1; };
const noteLine = (msg) => say(`  ${msg}`);
const skipLine = (msg) => say(`  （跳过：${msg}）`);
const okWarn = (msg) => say(`  [正常] ${msg}`);
const badWarn = (msg) => { say(`  [注意] ${msg}`); warnCount += 1; };
const infoWarn = (msg) => say(`  [信息] ${msg}`);

// ───────────────────────────────── 命令执行 ─────────────────────────────────

function run(cmd, args = [], options = {}) {
  const { timeout = 20000, cwd, env } = options;
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeout > 0 ? timeout : undefined,
      maxBuffer: 64 * 1024 * 1024,
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true
    });
    if (result.error) {
      return {
        ok: false,
        missing: result.error.code === 'ENOENT',
        code: null,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
      };
    }
    return {
      ok: result.status === 0,
      missing: false,
      code: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    };
  } catch (error) {
    return { ok: false, missing: false, code: null, stdout: '', stderr: String(error && error.message ? error.message : error) };
  }
}

function runSh(line, options = {}) {
  if (IS_WINDOWS) return run('bash', ['-c', line], options);
  return run('/bin/sh', ['-c', line], options);
}

function text(result) {
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

function systemctlUser(args, options = {}) {
  return run('systemctl', ['--user', ...args], options);
}

/**
 * 这个 unit 是否真的存在。测试/非 systemd 环境里 systemctl 命令可能装了就绪，
 * 但服务名是假的；此时不能把"起不来"当成恢复失败 —— 那会把一个只恢复数据的演练判红。
 */
function serviceLoaded(name) {
  const unit = String(name || '').trim();
  if (!unit) return false;
  const result = systemctlUser(['show', unit, '-p', 'LoadState', '--value'], { timeout: 5000 });
  if (result.missing) return false;
  return String(result.stdout || '').trim() === 'loaded';
}

// ───────────────────────────────── 参数解析 ─────────────────────────────────

const hasFlag = (args, name) => args.includes(name);
const wantsHelp = (args) => args.includes('--help') || args.includes('-h');

function optValue(args, name, fallback = null) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name) return i + 1 < args.length ? args[i + 1] : fallback;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return fallback;
}

function numOpt(args, name, fallback) {
  const value = Number.parseFloat(optValue(args, name, ''));
  return Number.isFinite(value) ? value : fallback;
}

function intOpt(args, name, fallback) {
  const value = Number.parseInt(optValue(args, name, ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

function positionalArgs(args) {
  return args.filter((arg) => !arg.startsWith('-'));
}

// ───────────────────────────────── 只读数据访问 ─────────────────────────────────

function findJsFiles(dir) {
  const files = [];
  if (!dir || !exists(dir)) return files;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
    }
  }
  return files.sort();
}

function findRuntimeNode(appDir) {
  const runtimeDir = path.join(appDir, '.runtime');
  if (!exists(runtimeDir)) return '';
  let entries = [];
  try {
    entries = fs.readdirSync(runtimeDir);
  } catch {
    return '';
  }
  const candidates = entries.filter((name) => name.startsWith('node-')).sort().reverse();
  for (const name of candidates) {
    const bin = path.join(runtimeDir, name, 'bin', 'node');
    if (exists(bin)) return bin;
  }
  return '';
}

function openReadOnlyDb(file) {
  if (!exists(file)) return null;
  try {
    return openDatabase(file, { readOnly: true });
  } catch {
    return null;
  }
}

function sqliteIntegrity(file) {
  const db = openReadOnlyDb(file);
  if (!db) return null;
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    const value = row ? Object.values(row)[0] : '未知';
    return String(value);
  } catch (error) {
    return `读取失败: ${error && error.message ? error.message : error}`;
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
  }
}

/**
 * 把磁盘上的价格表缓存注入查价层（只读，不发网络请求）。
 *   - data/price-feed-cache.json → 远程价格表（项目/社区公共参考价）
 *   - data/channel-prices.json   → 每渠道价目表（只注入 config 里还配着的渠道）
 * 与服务进程启动时的行为一致（src/pricing/price-feed.js / src/pricing/channel-prices.js 也是先吃缓存）。
 */
function injectCachedPriceTables(dataDir, priceCfg) {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'price-feed-cache.json'), 'utf8'));
    if (cache?.prices && typeof cache.prices === 'object') {
      setRemotePrices(cache.prices, cache.aliases && typeof cache.aliases === 'object' ? cache.aliases : null);
    }
  } catch { /* 没有缓存就只用内置表 */ }
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-prices.json'), 'utf8'));
    const feeds = cache?.feeds && typeof cache.feeds === 'object' ? cache.feeds : {};
    const wanted = new Set((Array.isArray(priceCfg?.api?.channelPriceFeeds) ? priceCfg.api.channelPriceFeeds : [])
      .map((f) => String(f?.vendor || '').trim())
      .filter(Boolean));
    for (const [vendor, feed] of Object.entries(feeds)) {
      if (!wanted.has(vendor)) continue;
      const prices = feed?.prices;
      setChannelPrices(vendor, prices && typeof prices === 'object' ? prices : null);
    }
  } catch { /* 同上 */ }
}

/**
 * 价格缺口（只读）：扫会话留档，找出"没有价格"的模型。
 * 与用量页同一条判价链（含账户口径、渠道价目表、远程价格表、"按当前模型估算"），
 * 所以这里剩下的就是真正没算进成本的调用。没有留档时返回 null。
 *
 * 远程表与渠道价目表用**磁盘缓存**注入（不发网络请求）：体检是只读的，
 * 而服务进程启动时也是先吃这两份缓存 —— 不在线拉才能既对齐口径又不打扰外部站点。
 */
function priceGapReport(cfg) {
  // 用配置文件的完整内容判价（ops 自己的 cfg 是扁平结构，缺 api.* 会让
  // 账户口径与按当前模型估算失效，报出的缺口就跟控制台对不上）
  let priceCfg = {};
  try { priceCfg = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'config.json'), 'utf8')); } catch { priceCfg = {}; }
  injectCachedPriceTables(cfg.dataDir, priceCfg);
  const dir = path.join(cfg.dataDir, 'sessions');
  const byId = new Map();
  try {
    for (const entry of listSessionFiles(dir)) {
      const cur = byId.get(entry.id);
      if (!cur || (cur.compressed && !entry.compressed)) byId.set(entry.id, entry);
    }
  } catch {
    return null;   // 读不了就报"没有留档"，由调用方说无法判定（不中断体检）
  }
  if (!byId.size) return null;
  const counts = new Map();
  for (const entry of byId.values()) {
    const session = readSessionFile(entry.file);
    if (!session) continue;
    const vendor = String(session?.vendor || '').trim();
    for (const message of (session?.messages || [])) {
      const raw = message?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const usage = raw.usage || {};
      const promptTokens = Number(usage.prompt_tokens) || 0;
      const completionTokens = Number(usage.completion_tokens) || 0;
      if (!promptTokens && !completionTokens) continue;
      const model = String(raw.model || session?.model || '').trim();
      const at = Number(raw.created) ? Number(raw.created) * 1000 : (Number(session?.startedAt) || 0);
      const price = resolveModelPrice(model, priceCfg, null, { vendor, at });
      if (price.unpriced !== true) continue;
      const key = modelLabel(vendor, model);
      const current = counts.get(key) || { key, calls: 0, tokens: 0 };
      current.calls += 1;
      current.tokens += promptTokens + completionTokens;
      counts.set(key, current);
    }
  }
  return [...counts.values()].sort((a, b) => b.calls - a.calls);
}

// ───────────────────────── 未定义调用扫描（原 scan-undefined-calls.py） ─────────────────────────

const SCAN_GLOBALS = new Set(`console Math JSON Object Array String Number Boolean Date Promise Set Map WeakMap WeakSet Buffer
process setTimeout clearTimeout setInterval clearInterval setImmediate queueMicrotask
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent fetch URL URLSearchParams
structuredClone BigInt RegExp Error TypeError RangeError SyntaxError Symbol AbortController AbortSignal
TextEncoder TextDecoder atob btoa globalThis performance crypto
Int32Array Uint8Array SharedArrayBuffer ArrayBuffer
FormData Blob Headers Response Request
if for while switch catch return typeof function await new delete void in of do else try throw case instanceof
yield super this null true false async static get set import export default class const let var new`.split(/\s+/).filter(Boolean));

// 已知误报（解构参数 / 动态 import / 全局对象），仅列出逐个确认过的。
const KNOWN_IGNORE = [
  'Agent', 'Proxy', 'resolve', 'reject', 'task', 'fn', 'send', 'sleep', 'operation',
  'isRetryable', 'random', 'resolveAtName', 'resolveReply', 'normalizeBehaviorProfile',
  'getConfigFn', 'allowSource', 'fetchFn',
  // 可注入的实现（测试里传假实现）：WebSocketImpl=WebSocket 构造器；nowFn=时间函数；perChunk=逐片转写回调；
  // fetchImpl/statfs/notify=health-check 的注入点（测试不打真实网络/磁盘；解构参数默认值超出扫描器识别范围）
  'WebSocketImpl', 'nowFn', 'perChunk', 'fetchImpl', 'statfs', 'notify'
];

const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^', '\n', '']);

// 把注释/字符串/模板串/正则替换成空白，保留换行；正则字面量按"前一个有效字符不是值"判定。
function blankSource(src) {
  const out = [];
  const length = src.length;
  let i = 0;
  let last = '';
  const emit = (chunk) => { out.push(chunk); };
  while (i < length) {
    const char = src[i];
    const next = i + 1 < length ? src[i + 1] : '';
    if (char === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      let end = src.indexOf('*/', i + 2);
      end = end < 0 ? length : end + 2;
      let newlines = 0;
      for (let k = i; k < end; k += 1) if (src[k] === '\n') newlines += 1;
      emit('\n'.repeat(newlines));
      i = end;
      continue;
    }
    if (char === '/' && REGEX_PRECEDERS.has(last)) {
      let j = i + 1;
      let inClass = false;
      while (j < length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { j += 1; break; }
        else if (src[j] === '\n') break;
        j += 1;
      }
      emit(' '.repeat(Math.max(0, j - i)));
      last = '/';
      i = j;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let j = i + 1;
      while (j < length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j += 1; break; }
        if (quote === '`' && src[j] === '$' && j + 1 < length && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < length && depth) {
            if (src[j] === '{') depth += 1;
            else if (src[j] === '}') depth -= 1;
            j += 1;
          }
          continue;
        }
        j += 1;
      }
      // 保留引号本身：否则 import ... from '...' 的引号也会被抹掉，import 解析会落空。
      if (j - i >= 2) emit(src[i] + ' '.repeat(j - i - 2) + src[j - 1]);
      else emit(' '.repeat(Math.max(0, j - i)));
      last = quote;
      i = j;
      continue;
    }
    emit(char);
    if (char.trim() !== '') last = char;
    i += 1;
  }
  return out.join('');
}

function declaredNames(src) {
  const names = new Set();
  for (const match of src.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of src.matchAll(/^\s*(?:static\s+|async\s+|get\s+|set\s+|#)*([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(match[1]);
  for (const match of src.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*['"]/g)) {
    for (const identifier of match[1].matchAll(/[A-Za-z_$][\w$]*/g)) names.add(identifier[0]);
  }
  for (const match of src.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from/gm)) names.add(match[1]);
  return names;
}

function makeLineCounter(src) {
  const newlines = [];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') newlines.push(i);
  return (index) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (newlines[mid] < index) low = mid + 1;
      else high = mid;
    }
    return low + 1;
  };
}

function scanSourceFile(file, ignore) {
  const src = blankSource(readFileNormalized(file));
  const declared = declaredNames(src);
  const lineAt = makeLineCounter(src);
  const missing = new Map();
  for (const match of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (declared.has(name) || SCAN_GLOBALS.has(name) || ignore.has(name)) continue;
    if (!missing.has(name)) missing.set(name, lineAt(match.index));
  }
  return missing;
}

function scanDirectory(dir, ignore) {
  const lines = [];
  let total = 0;
  if (!exists(dir)) return { lines, total, files: 0 };
  // 递归（src/ 按领域分了子目录）：漏掉子目录会让这个门禁静默只扫一部分代码
  const files = findJsFiles(dir);
  for (const name of files) {
    const missing = scanSourceFile(name, ignore);
    if (missing.size === 0) continue;
    total += missing.size;
    const items = [...missing.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([key, line]) => `${key}(第${line}行)`);
    lines.push(`${path.relative(dir, name).split(path.sep).join('/')} → ${items.join(', ')}`);
  }
  return { lines, total, files: files.length };
}

// ───────────────────────────── 主机体检（原 audit-host.sh） ─────────────────────────────

function auditFailedUnits() {
  const failed = run('systemctl', ['--failed', '--no-pager', '--no-legend']);
  if (failed.missing) return { missing: true, count: 0, first: [] };
  const rows = failed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return { missing: false, count: rows.length, first: rows.slice(0, 5) };
}

function ssListenEntries() {
  const result = run('ss', ['-lntp']);
  if (result.missing || !result.ok) return null;
  const entries = [];
  for (const line of result.stdout.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/).filter(Boolean);
    if (fields.length < 5) continue;
    entries.push({
      local: fields[3],
      peer: fields[4],
      process: fields.slice(5).join(' ')
    });
  }
  return entries;
}

function auditHost(args) {
  ngCount = 0;
  warnCount = 0;
  const cfg = config({
    dir: optValue(args, '--dir', null),
    data: optValue(args, '--data', null)
  });

  say('════════ A. 系统基础 ════════');
  const kernel = run('uname', ['-r']);
  if (kernel.missing) skipLine('缺少 uname（非 Linux 环境）');
  else {
    const pretty = /PRETTY_NAME="?([^"\n]+)"?/.exec(readFileSafe('/etc/os-release'));
    infoWarn(`内核 ${kernel.stdout.trim()} ｜ ${pretty ? pretty[1] : '未知发行版'}`);
  }
  const boot = run('uptime', ['-s']);
  const uptime = run('uptime', ['-p']);
  if (boot.missing || uptime.missing) skipLine('缺少 uptime 命令');
  else infoWarn(`开机于 ${boot.stdout.trim() || '未知'}，已运行 ${uptime.stdout.trim().replace(/^up\s*/i, '') || '未知'}`);
  const timedatectl = run('timedatectl');
  if (timedatectl.missing) skipLine('缺少 timedatectl 命令');
  else {
    for (const line of timedatectl.stdout.split('\n')) {
      if (/Time zone|synchronized/i.test(line)) say(`  ${line.trim()}`);
    }
  }
  const rebootRequired = exists('/var/run/reboot-required');
  noteLine(`重启需求: ${rebootRequired ? '需要重启（有内核/安全更新生效前）' : '无'}`);

  say('════════ B. systemd 失败单元 ════════');
  const failed = auditFailedUnits();
  if (failed.missing) skipLine('缺少 systemctl（非 Linux/systemd 环境）');
  else {
    noteLine(`系统级失败单元: ${failed.count}${failed.first.length ? ` ${failed.first.join(' | ')}` : ''}`);
    if (failed.count === 0) okWarn('没有失败的系统服务');
    else badWarn(`${failed.count} 个系统服务处于失败状态`);
  }

  say('════════ C. 资源 ════════');
  const free = run('free', ['-m']);
  if (free.missing || !free.ok) skipLine('缺少 free 命令');
  else {
    for (const line of free.stdout.split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === 'Mem:') noteLine(`内存 ${fields[2]}M/${fields[1]}M（可用 ${fields[6] ?? '-'}M）`);
      if (fields[0] === 'Swap:') noteLine(`交换 ${fields[2]}M/${fields[1]}M`);
    }
  }
  const uptimeFull = run('uptime');
  if (uptimeFull.missing) skipLine('缺少 uptime 命令');
  else noteLine(`负载 ${/load average[:：]?\s*(.*)$/.exec(uptimeFull.stdout.trim())?.[1] ?? uptimeFull.stdout.trim()}`);
  const ps = run('ps', ['-eo', 'rss,comm', '--sort=-rss']);
  if (ps.missing || !ps.ok) skipLine('缺少 ps 命令');
  else {
    for (const line of ps.stdout.split('\n').slice(1, 6)) {
      const fields = line.trim().split(/\s+/);
      const rss = Number.parseInt(fields[0], 10);
      if (Number.isFinite(rss) && rss > 0) noteLine(`内存Top: ${(fields.slice(1).join(' ') || '?').padEnd(22)} ${(rss / 1024).toFixed(1)}M`);
    }
  }

  say('════════ D. 磁盘卫生 ════════');
  const dfRoot = run('df', ['-h', '/']);
  if (dfRoot.missing || !dfRoot.ok) skipLine('缺少 df 命令');
  else {
    const fields = (dfRoot.stdout.split('\n')[1] || '').trim().split(/\s+/);
    if (fields.length >= 5) noteLine(`根盘 ${fields[1]} 已用 ${fields[2]} (${fields[4]}，剩 ${fields[3]})`);
  }
  const journalUsage = run('journalctl', ['--disk-usage']);
  if (journalUsage.missing) skipLine('缺少 journalctl 命令');
  else noteLine(`journald 日志占用: ${(/[0-9.]+[KMGT]?B?/.exec(`${journalUsage.stdout}${journalUsage.stderr}`)?.[0]) ?? '未知'}`);
  const duLog = runSh('du -sh /var/log 2>/dev/null | cut -f1');
  const duApt = runSh('du -sh /var/cache/apt 2>/dev/null | cut -f1');
  if (duLog.missing && duApt.missing) skipLine('缺少 du 命令');
  else noteLine(`/var/log 大小: ${duLog.stdout.trim() || '-'}  /var/cache/apt: ${duApt.stdout.trim() || '-'}`);
  const dockerDf = run('docker', ['system', 'df']);
  if (dockerDf.missing) skipLine('缺少 docker 命令');
  else if (!dockerDf.ok) noteLine('docker 不可用，忽略 docker 占用');
  else {
    noteLine('docker 总占用:');
    for (const line of dockerDf.stdout.split('\n').filter(Boolean)) say(`    ${line}`);
  }
  const kernels = runSh("dpkg -l 2>/dev/null | grep -c 'linux-image-[0-9]'");
  if (kernels.missing) skipLine('缺少 dpkg 命令');
  else noteLine(`已安装内核: ${kernels.stdout.trim() || '0'} 个`);
  const bigLogs = runSh('du -sh /var/log/* 2>/dev/null | sort -rh | head -3');
  if (bigLogs.missing) skipLine('缺少 du 命令');
  else noteLine(`/var/log 大头: ${bigLogs.stdout.trim().split('\n').filter(Boolean).join('  ') || '-'}`);

  say('════════ E. Docker 容器 ════════');
  const dockerPs = run('docker', ['ps', '-a', '--format', '{{.Names}}|{{.Status}}']);
  if (dockerPs.missing) skipLine('缺少 docker 命令');
  else if (!dockerPs.ok) noteLine('docker 不可用（守护进程未运行？）');
  else {
    const containers = dockerPs.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (containers.length === 0) noteLine('没有容器');
    for (const line of containers) {
      const [name, status = ''] = line.split('|');
      if (/^Up/i.test(status)) okWarn(`${name} (${status})`);
      else badWarn(`${name} (${status})`);
    }
    for (const line of containers) {
      const name = line.split('|')[0];
      const inspect = run('docker', ['inspect', '-f', '{{.RestartCount}} {{.HostConfig.RestartPolicy.Name}}', name]);
      if (!inspect.ok) continue;
      const [count = '?', policy = '?'] = inspect.stdout.trim().split(/\s+/);
      noteLine(`  ${name}: 重启${count}次 / 策略${policy}`);
    }
  }

  say('════════ F. 监听端口（本机视角）════════');
  const listeners = ssListenEntries();
  if (listeners === null) skipLine('缺少 ss 命令（iproute2）');
  else {
    const rows = listeners
      .filter((entry) => !/127\.0\.0\.1|\[::1\]/.test(entry.local))
      .map((entry) => `  ${entry.local}  <-  ${entry.process}`.trimEnd());
    for (const row of [...new Set(rows)].slice(0, 20)) say(row);
    noteLine('（以上为对 0.0.0.0/[::] 监听的端口；仅 127.0.0.1 的已略）');
  }

  say('════════ G. SSH 与登录安全 ════════');
  const sshd = run('sshd', ['-T']);
  if (sshd.missing || !sshd.ok) skipLine('读 sshd 生效配置需要 root，本次略过');
  else {
    for (const line of sshd.stdout.split('\n')) {
      if (/^(passwordauthentication|permitrootlogin|port)\s/i.test(line.trim())) noteLine(line.trim());
    }
  }
  const authLog = readFileSafe('/var/log/auth.log');
  noteLine(`今天失败的 SSH 认证次数: ${authLog ? (authLog.match(/Failed password|Invalid user/g) || []).length : 'n/a'}`);
  const last = run('last', ['-n', '5', '-w']);
  if (last.missing) skipLine('缺少 last 命令');
  else for (const line of last.stdout.split('\n').slice(0, 6)) if (line.trim()) say(`  ${line.trim()}`);
  const loginUsers = readFileSafe('/etc/passwd')
    .split('\n')
    .map((line) => line.split(':'))
    .filter((fields) => fields.length > 6 && /(bash|sh)$/.test(fields[6]))
    .map((fields) => fields[0]);
  noteLine(`可登录的用户: ${loginUsers.join(' ') || '（读不到 /etc/passwd）'}`);
  const groups = run('groups', [cfg.user]);
  if (!groups.missing) noteLine(`${cfg.user} 的 sudo 组成员: ${groups.stdout.trim().replace(/^[^:]*:\s*/, '') || '未知'}`);
  const fail2ban = run('fail2ban-client', ['status']);
  if (fail2ban.missing) noteLine('fail2ban: 未安装');
  else noteLine(`fail2ban: ${fail2ban.stdout.split('\n').slice(0, 2).join(' / ').trim() || '已安装'}`);

  say('════════ H. 防火墙 ════════');
  const ufw = run('ufw', ['status']);
  if (ufw.missing) skipLine('缺少 ufw 命令');
  else noteLine(`ufw: ${(ufw.stdout.split('\n')[0] || text(ufw)).trim()}`);
  const iptables = run('iptables', ['-S']);
  if (iptables.missing) skipLine('缺少 iptables 命令');
  else for (const line of iptables.stdout.split('\n').slice(0, 5)) if (line.trim()) say(`  ${line.trim()}`);

  say('════════ I. 定时任务 ════════');
  const rootCron = run('crontab', ['-l', '-u', 'root']);
  if (rootCron.missing) skipLine('缺少 crontab 命令');
  else noteLine(`root crontab: ${rootCron.stdout.split('\n').filter((line) => /^[^#]/.test(line) && line.trim()).length} 条`);
  const userCron = run('crontab', ['-l']);
  if (!userCron.missing) noteLine(`${cfg.user} crontab: ${userCron.stdout.split('\n').filter((line) => /^[^#]/.test(line) && line.trim()).length} 条`);
  const timers = run('systemctl', ['list-timers', '--no-pager', '--no-legend']);
  if (timers.missing) skipLine('缺少 systemctl 命令');
  else {
    const names = timers.stdout.split('\n').map((line) => line.trim().split(/\s+/).pop()).filter(Boolean);
    noteLine(`系统 timer: ${names.join(' ')}`);
  }

  say('════════ J. 系统更新 ════════');
  const upgradable = runSh('apt list --upgradable 2>/dev/null | grep -c upgradable');
  if (upgradable.missing) skipLine('缺少 apt 命令');
  else noteLine(`可升级包: ${upgradable.stdout.trim() || '0'} 个（安全更新用 apt 注意评估）`);
  const unattended = run('systemctl', ['is-active', 'unattended-upgrades']);
  if (unattended.missing) skipLine('缺少 systemctl 命令');
  else noteLine(`unattended-upgrades: ${unattended.stdout.trim() || unattended.stderr.trim() || '未知'}`);

  say('════════ K. TLS 证书 ════════');
  const certbot = run('certbot', ['certificates']);
  if (certbot.missing) skipLine('缺少 certbot 命令');
  else for (const line of certbot.stdout.split('\n')) if (/Certificate Name|Expiry/i.test(line)) noteLine(line.trim());
  const liveDir = '/etc/letsencrypt/live';
  if (exists(liveDir)) {
    // 证书目录通常是 root-only：普通用户 stat 得到但读不了，必须吞掉 EACCES 而不是整段崩掉
    // （原 shell 版靠 glob 展开为空自然跳过，Node 的 readdirSync 会直接抛）。
    let certNames = [];
    try {
      certNames = fs.readdirSync(liveDir);
    } catch (error) {
      skipLine(`读取 ${liveDir} 失败（${error?.code || error?.message || error}），跳过证书到期检查`);
    }
    for (const name of certNames) {
      const fullchain = path.join(liveDir, name, 'fullchain.pem');
      if (!exists(fullchain)) continue;
      const expiry = run('openssl', ['x509', '-enddate', '-noout', '-in', fullchain]);
      if (expiry.missing) { skipLine('缺少 openssl 命令'); break; }
      noteLine(`${name}: 到期 ${expiry.stdout.trim().replace(/^notAfter=/, '') || '未知'}`);
    }
  } else skipLine('没有 /etc/letsencrypt/live 目录');

  say('════════ L. 备份状况 ════════');
  let bakCount = 0;
  if (exists(cfg.dataDir)) {
    try {
      bakCount = fs.readdirSync(cfg.dataDir).filter((name) => name.includes('.bak')).length;
    } catch { bakCount = 0; }
  }
  noteLine(`${cfg.dataDir} 下的 .bak* 现场备份: ${bakCount} 个（补丁过程的现场备份，不是定时备份）`);
  const cronBackup = runSh("grep -rE 'backup|rsync|tar' /etc/cron* /var/spool/cron 2>/dev/null | grep -cv '^#'");
  if (cronBackup.missing) skipLine('缺少 grep/cron 目录，无法统计定时备份');
  else noteLine(`有无定时备份任务: ${cronBackup.stdout.trim() || '0'} 条`);

  say();
  say('════════ 结论 ════════');
  say(`  需要注意的事项: ${warnCount} 项（见上面 [注意] 行）`);
  return 0;
}

// ─────────────────────────── 服务体检（原 audit-server.sh） ───────────────────────────

const AUDIT_MARKERS = [
  // `export` 前缀可省：这条从 CJS 时代留下，文件改成 ESM 后 `^function` 永远匹配不上，
  // 体检就会常驻一条假 NG（2026-10-01 在服务器上实测到）。锚点保留，仍只认定义那一行。
  ['normalizeMid 定义', 1, 'src/tools/tools-core.js', '^(?:export )?function normalizeMid\\(value\\)'],
  ['normalizeMid 调用点', 3, 'src/tools/tools-core.js', 'replyToMessageId: normalizeMid\\('],
  ['store.findByMid 归一化', 1, 'src/core/store.js', 'normalizeMid\\(mid\\)'],
  ['贴纸同步防清空守卫', 1, 'src/onebot/stickers.js', 'if \\(!fetchedIds\\.size\\) return out'],
  ['主动间隔守卫', 1, 'src/core/orchestrator.js', 'minGapMs'],
  ['主动判定落盘', 2, 'src/core/orchestrator.js', 'writeProactiveAttempt\\(PROACTIVE_STATE_FILE, scope, nowTick\\)'],
  ['主动判定原子写', 1, 'src/core/proactive-state.js', 'renameSync\\(tmp, file\\)'],
  ['多窗口工具函数', 1, 'src/core/orchestrator.js', 'function proactiveWindowState'],
  ['补话安排', 1, 'src/core/orchestrator.js', 'maybeScheduleFollowUp\\(chatKey'],
  ['重连补课', 2, 'src/console/app.js', 'catchUpMissedMessages|scheduleCatchUp'],
  ['空间互动失败退避', 2, 'src/features/qzone-interactions.js', 'failStreak|backoff'],
  // 重试实现早就改成"按可确认未送达的错误判断"，不再用 isTransient 命名 ——
  // 标记要跟着指向现在的实现，否则每次体检都误报一项。
  ['发送网络级重试', 1, 'src/onebot/sender.js', '能证明请求没被对方收到|1.5 秒后重试一次'],
  ['QQ表情标签', 1, 'src/onebot/onebot.js', 'QQ表情'],
  ['看图先读情绪', 1, 'src/llm/prompt.js', '看图先读情绪'],
  ['表情编号≠stickerId 提醒', 1, 'src/llm/prompt.js', '别拿这个编号去 .*send_sticker'],
  ['发言唯一通道提示', 1, 'src/llm/prompt.js', '发言的唯一通道'],
  ['收尾自检段', 2, 'src/llm/prompt.js', '沉默就是零输出|每次结束前必读'],
  ['多气泡鼓励', 1, 'src/llm/prompt.js', '别把一轮压成一句点评'],
  ['一轮说完', 1, 'src/llm/prompt.js', '有想法就一轮里说完'],
  ['贴纸选图提示', 1, 'src/onebot/stickers.js', '选图很简单'],
  ['审核拦截重试', 1, 'src/llm/llm.js', '审核拦截整次请求'],
  ['兜底模型接入', 1, 'src/llm/llm.js', '改用兜底模型'],
  // 这条以前查 config.json（实例当前人设）：管理员改过人设就不含这句话，于是永远误报。
  // 改查随版本发布的内置卡，才对应"这个补丁在不在"的本意。
  ['人设·别当评委', 1, 'roles/xiaojingyu.md', '不要总结、不要升华'],
  ['闲聊带自己', 1, 'src/llm/prompt.js', '把自己的那半句补上'],
  ['表情清单动态段', 1, 'src/llm/prompt.js', 'function stickerPromptBlock']
];

function loadConfigJson(dataDir) {
  const file = path.join(dataDir, 'config.json');
  if (!exists(file)) return null;
  try {
    return JSON.parse(readFileSafe(file));
  } catch {
    return { __invalid: true };
  }
}

function configToken(cfgJson) {
  const envToken = envStr('QQ_AGENT_CONSOLE_TOKEN');
  if (envToken) return { token: envToken, from: 'env' };
  const fileToken = cfgJson && !cfgJson.__invalid ? String(cfgJson.server?.token || '').trim() : '';
  return fileToken ? { token: fileToken, from: 'config.json' } : { token: '', from: '' };
}

function onebotToken(cfgJson) {
  const envToken = envStr('QQ_AGENT_ONEBOT_TOKEN');
  if (envToken) return envToken;
  return String(cfgJson?.onebot?.accessToken || cfgJson?.onebot?.httpAccessToken || '').trim();
}

async function fetchJson(url, headers = {}, timeoutMs = 6000) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    // 有界读：探测目标是本机/局域网服务，2MB 上限只是兜"端点发疯"（2026-10-10 审查）
    const body = await readTextBounded(response, 2 * 1024 * 1024);
    let json = null;
    try { json = JSON.parse(body); } catch { json = null; }
    return { ok: response.ok, status: response.status, body, json };
  } catch (error) {
    return { ok: false, status: 0, body: '', json: null, error: error && error.message ? error.message : String(error) };
  }
}

function checkMarker(name, want, file, pattern) {
  if (!exists(file)) {
    ngLine(`${name}：文件缺失（${file}）`);
    return;
  }
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    ngLine(`${name}：正则无效（${pattern}）`);
    return;
  }
  const count = readFileNormalized(file).split('\n').filter((line) => regex.test(line)).length;
  if (count >= want) okLine(`${name}（${count}）`);
  else ngLine(`${name} 期望≥${want} 实际 ${count}（${file}）`);
}

async function auditServer(args) {
  ngCount = 0;
  warnCount = 0;
  const cfg = config({
    dir: optValue(args, '--dir', null),
    app: optValue(args, '--app', null),
    data: optValue(args, '--data', null)
  });
  const overrideConf = envStr('QQ_AGENT_OVERRIDE_CONF', path.join(os.homedir(), '.config', 'systemd', 'user', `${cfg.service}.d`, 'override.conf'));
  const cfgJson = loadConfigJson(cfg.dataDir);
  const consoleInfo = configToken(cfgJson);
  const scanIgnore = new Set(KNOWN_IGNORE);

  section('1. 服务与定时器');
  const active = systemctlUser(['is-active', cfg.service]);
  if (active.missing) skipLine('缺少 systemctl（非 Linux/systemd 环境）');
  else {
    const enabled = systemctlUser(['is-enabled', cfg.service]);
    noteLine(`qq-agent 状态: ${active.stdout.trim() || '未知'} / 开机自启: ${text(enabled) || '未知'}`);
    const restarts = systemctlUser(['show', cfg.service, '-p', 'NRestarts', '--value']);
    const started = systemctlUser(['show', cfg.service, '-p', 'ActiveEnterTimestamp', '--value']);
    noteLine(`重启次数: ${restarts.stdout.trim() || '未知'}  启动时间: ${started.stdout.trim() || '未知'}`);
    noteLine(`更新定时器（应为 enabled，它负责定期检查更新）: ${text(systemctlUser(['is-enabled', cfg.updateTimer])) || '未知'}`);
    noteLine(`进程看门狗（应为 enabled）: ${text(systemctlUser(['is-enabled', cfg.guardTimer])) || '未知'}`);
    const timers = systemctlUser(['list-timers', '--all', '--no-pager']);
    for (const line of timers.stdout.split('\n').slice(0, 6)) if (line.trim()) noteLine(line.trim());
  }

  section('2. 启动补丁链完整性');
  if (!exists(overrideConf)) skipLine(`未找到 ${overrideConf}`);
  else {
    const lines = readFileNormalized(overrideConf).split('\n');
    const scripts = lines.filter((line) => line.startsWith('ExecStartPost=')).map((line) => line.slice('ExecStartPost='.length).trim()).filter(Boolean);
    let missing = 0;
    for (const script of scripts) {
      let executable = true;
      try {
        fs.accessSync(script, fs.constants.X_OK);
      } catch {
        executable = false;
      }
      if (!executable) {
        noteLine(`  NG  不可执行/缺失: ${script}`);
        missing += 1;
      }
    }
    noteLine(`注册脚本数: ${scripts.length}，不可用: ${missing}`);
    if (missing === 0) okLine('补丁链引用的脚本都存在且可执行');
    else ngLine(`有 ${missing} 个脚本不可用`);
  }

  section('3. 源码语法（全部 js）');
  const jsFiles = [...findJsFiles(path.join(cfg.appDir, 'src')), ...findJsFiles(path.join(cfg.appDir, 'ui'))];
  if (jsFiles.length === 0) skipLine(`没有找到 js 源码（${cfg.appDir}/src、${cfg.appDir}/ui）`);
  else {
    const nodeBin = cfg.node || findRuntimeNode(cfg.appDir) || process.execPath;
    const nodeProbe = run(nodeBin, ['--version']);
    if (nodeProbe.missing) {
      ngLine(`找不到 node（设 QQ_AGENT_NODE）`);
    } else {
      let badFiles = 0;
      for (const file of jsFiles) {
        const check = run(nodeBin, ['--check', file], { timeout: 30000 });
        if (!check.ok) {
          ngLine(`语法错误: ${file}${check.stderr ? ` (${check.stderr.trim().split('\n')[0]})` : ''}`);
          badFiles += 1;
        }
      }
      if (badFiles === 0) okLine(`所有 js 文件语法通过（${jsFiles.length} 个）`);
      else ngLine(`语法错误文件数: ${badFiles}`);
    }
  }

  section('4. 未定义调用扫描');
  const scanDir = path.join(cfg.appDir, 'src');
  let scanTotal = 0;
  if (!exists(scanDir)) skipLine(`未找到 ${scanDir}`);
  else {
    const report = scanDirectory(scanDir, scanIgnore);
    scanTotal = report.total;
    for (const line of report.lines) noteLine(line);
    noteLine(`可疑未定义调用点: ${scanTotal}`);
    if (scanTotal === 0) okLine('未发现可疑未定义调用');
    else noteLine(`（仅记录，不阻断；已知误报可用 --ignore 过滤）`);
  }

  section('5. 关键补丁标记');
  for (const [name, want, relative, pattern] of AUDIT_MARKERS) {
    const file = relative === 'config.json' ? path.join(cfg.dataDir, 'config.json') : path.join(cfg.appDir, relative);
    checkMarker(name, want, file, pattern);
  }
  const inlineDir = path.join(cfg.appDir, 'src');
  let inlineFiles = 0;
  if (exists(inlineDir)) {
    inlineFiles = findJsFiles(inlineDir)
      .filter((file) => readFileSafe(file).includes('import { resolveToolCalls }'))
      .length;
  }
  if (inlineFiles >= 5) okLine(`内联工具兜底接入（${inlineFiles} 个文件）`);
  else ngLine(`内联工具兜底接入 期望≥5 个文件，实际 ${inlineFiles}`);

  section('6. 配置');
  if (!cfgJson) skipLine(`未找到 ${path.join(cfg.dataDir, 'config.json')}`);
  else if (cfgJson.__invalid) ngLine('config.json 不是合法 JSON');
  else {
    const proactive = cfgJson.proactive || {};
    const windows = (proactive.activeHours?.windows || []).map((win) => `[${win.start}-${win.end}]`).join(' ');
    const interval = (min, max) => `${(Number(min) / 3.6e6).toFixed(1)}-${(Number(max) / 3.6e6).toFixed(1)}h`;
    noteLine(`主动开话题: enabled=${proactive.enabled} 范围=群聊:${proactive.groupEnabled !== false}/私聊:${proactive.privateEnabled === true} 概率=${proactive.probability} 间隔=${interval(proactive.checkIntervalMinMs, proactive.checkIntervalMaxMs)} 窗口=${windows} 冷场=${Math.round(Number(proactive.idleThresholdMs || 0) / 60000)}分钟`);
    noteLine(`主动开口另两项: 补话=${proactive.followUpEnabled !== false} 自安排唤醒=${proactive.selfWakeEnabled !== false}`);
    noteLine(`思考开关: ${JSON.stringify(cfgJson.api?.thinking ?? null)}`);
    noteLine(`自动更新: ${cfgJson.autoUpdate?.enabled}`);
    noteLine(`时间控制: ${cfgJson.timeControl?.enabled}`);
    noteLine(`节奏(pacing): ${cfgJson.pacing?.enabled}`);
    noteLine(`空间互动: ${cfgJson.qzoneInteractions?.enabled}`);
    noteLine(`说说/每日总结: ${cfgJson.dailyMoments?.enabled}`);
    noteLine(`表情包: enabled=${cfgJson.sticker?.enabled} 积极度=${cfgJson.sticker?.encourage} 自动收藏=${cfgJson.sticker?.autoCollect}`);
    noteLine(`模型: ${cfgJson.api?.model} @ ${cfgJson.api?.baseUrl}`);
    const fallback = cfgJson.api?.fallback || {};
    noteLine(`兜底模型: ${fallback.model && fallback.enabled !== false ? `${fallback.model} @ ${fallback.baseUrl}` : '（未配置/已停用）'}`);
    noteLine(`白名单群/私聊: ${idList(cfgJson.allow?.groups).length} / ${idList(cfgJson.allow?.private).length}`);
    noteLine(`模型密钥(api.apiKey): ${cfgJson.api?.apiKey ? '有' : '无'}`);
    noteLine(`控制台令牌(server.token): ${cfgJson.server?.token ? '有' : '无'}`);
    noteLine(`OneBot 令牌(onebot.accessToken/httpAccessToken): ${cfgJson.onebot?.accessToken || cfgJson.onebot?.httpAccessToken ? '有' : '无'}`);
    okLine('config.json 是合法 JSON');
  }

  section('7. 数据文件');
  const stickersFile = path.join(cfg.dataDir, 'stickers.json');
  if (exists(stickersFile)) {
    try {
      const parsed = JSON.parse(readFileSafe(stickersFile));
      const items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.stickers || []);
      const ids = items.map((item) => item?.id);
      const unique = new Set(ids);
      const noted = items.filter((item) => item?.localNote).length;
      noteLine(`表情库: ${items.length} 条，重复 id: ${ids.length - unique.size}，有备注: ${noted}`);
    } catch (error) {
      ngLine(`stickers.json 读取失败: ${error && error.message ? error.message : error}`);
    }
  } else skipLine(`缺 stickers.json（${stickersFile}）`);
  for (const name of [
    'messages.sqlite',
    'incident-pilot.sqlite',
    'identity-pilot.sqlite',
    'relationship-pilot.sqlite',
    path.join('memory', 'search.sqlite'),
    path.join('living-memory', 'living-memory.sqlite')
  ]) {
    const file = path.join(cfg.dataDir, name);
    if (!exists(file)) {
      noteLine(`（缺 ${name}）`);
      continue;
    }
    noteLine(`${name.padEnd(34)} integrity=${sqliteIntegrity(file)}`);
  }
  const sessionsDir = path.join(cfg.dataDir, 'sessions');
  let sessionFiles = [];
  try { sessionFiles = listSessionFiles(sessionsDir); } catch { sessionFiles = []; }
  const sessionCount = new Set(sessionFiles.map((f) => f.id)).size;
  const compressedCount = sessionFiles.filter((f) => f.compressed).length;
  noteLine(`会话文件: ${sessionCount} 个（压缩归档 ${compressedCount} 个）`);

  // 价格缺口（只读）：出现过的模型里，哪些没有价格。
  // 判价逻辑与用量页一致（含账户口径与"按当前模型估算"），所以这里报出来的
  // 是真正没算进成本的那些调用 —— 免得用户过几天才发现成本少算了。
  section('7.1 价格缺口（模型有没有价）');
  const gaps = priceGapReport(cfg);
  if (gaps === null) skipLine('没有会话留档，无法判定');
  else if (!gaps.length) okLine('出现过的模型都有价格（或已按当前模型估算）');
  else {
    const calls = gaps.reduce((sum, g) => sum + g.calls, 0);
    const tokens = gaps.reduce((sum, g) => sum + g.tokens, 0);
    badWarn(`有 ${gaps.length} 个模型没有价格：`
      + gaps.slice(0, 5).map((g) => `${g.key}（${g.calls} 次）`).join('、')
      + `${gaps.length > 5 ? ' 等' : ''}`);
    noteLine(`  → 共 ${calls} 次调用 / ${tokens} token 没算进成本`);
    noteLine('  → 到控制台「设置 → 模型价格」定价，或打开"按当前模型估算"（默认已开）');
  }

  section('8. 运行态');
  if (!consoleInfo.token) skipLine('未设置 QQ_AGENT_CONSOLE_TOKEN，且 config.json 无 server.token，跳过控制台状态接口');
  else {
    // 令牌必须走请求头：查询串令牌已收窄到 /api/events（2026-10-06 复审），
    // 这里还用 ?token= 的话拿到的是 401，而 fetchJson 无论状态码都解析 JSON ——
    // 巡检会打印一条"看着正常"的假数据并误判通过（2026-10-07 复审 P2）。
    const status = await fetchJson(`http://127.0.0.1:${cfg.consolePort}/api/status`, { 'x-console-token': consoleInfo.token });
    if (!status.json || status.json.error) ngLine(`控制台状态接口不可达（${status.error || status.json?.error || `HTTP ${status.status}`}）`);
    else {
      const data = status.json;
      const onebot = data.onebot || {};
      const orchestrator = data.orchestrator || {};
      noteLine(`OneBot: connected=${onebot.connected} error=${JSON.stringify(onebot.error ?? null)} self=${onebot.self?.userId ?? '-'}`);
      // 连接还在、心跳/事件停了 = 半开连接或上游卡死。只看 connected 会把这种情况当正常。
      const lastBeat = Number(onebot.lastHeartbeatAt) || Number(onebot.lastEventAt) || 0;
      if (onebot.connected && lastBeat && Date.now() - lastBeat > 10 * 60_000) {
        badWarn(`OneBot 已 ${Math.round((Date.now() - lastBeat) / 60_000)} 分钟没有心跳/事件（连接仍在，可能已半开）`);
      } else {
        noteLine(`OneBot 入站: 最后事件 ${lastBeat ? new Date(lastBeat).toLocaleString() : '尚未收到'}，最后心跳 ${onebot.lastHeartbeatAt ? new Date(onebot.lastHeartbeatAt).toLocaleString() : '尚未收到'}`);
      }
      noteLine(`编排器: paused=${orchestrator.paused} mode=${orchestrator.mode} 运行中=${orchestrator.running} 并发上限=${orchestrator.maxConcurrentRuns}`);
      noteLine(`今日用量: ${data.usage?.totalTokens} tokens / ${data.usage?.runs} 次运行`);
      const incidents = data.incidentPilot?.counts || {};
      noteLine(`告警: open=${incidents.open} resolved=${incidents.resolved} pendingNotify=${data.incidentPilot?.pendingNotifications}`);
      noteLine(`（token 来源：${consoleInfo.from}，未打印）`);
    }
  }
  const obToken = onebotToken(cfgJson);
  if (!obToken) skipLine('未设置 QQ_AGENT_ONEBOT_TOKEN，且 config.json 无 OneBot 令牌，跳过 OneBot 直连检查');
  else {
    const status = await fetchJson(`http://127.0.0.1:${cfg.onebotPort}/get_status`, { Authorization: `Bearer ${obToken}` });
    noteLine(`OneBot 直连: ${status.body ? status.body.trim().slice(0, 200) : `不可达（${status.error || `HTTP ${status.status}`}）`}`);
  }
  const messagesDb = path.join(cfg.dataDir, 'messages.sqlite');
  const db = openReadOnlyDb(messagesDb);
  if (!db) noteLine(`（缺 messages.sqlite，跳过队列统计）`);
  else {
    try {
      const pending = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE state='pending'").get();
      const runs = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE state NOT IN ('acked','failed')").get();
      noteLine(`待处理消息: ${pending?.count ?? '?'} 条`);
      noteLine(`未完成 run: ${runs?.count ?? '?'} 个`);
    } catch (error) {
      noteLine(`队列统计失败: ${error && error.message ? error.message : error}`);
    } finally {
      try { db.close(); } catch { /* 忽略 */ }
    }
  }

  section('9. 最近日志（6 小时，剔除 SQLite 实验性警告）');
  const journal = run('journalctl', ['--user', '-u', cfg.service, '--since', '6 hours ago', '--no-pager'], { timeout: 60000 });
  if (journal.missing) skipLine('缺少 journalctl 命令');
  else {
    const hits = journal.stdout.split('\n')
      .filter((line) => !/ExperimentalWarning|trace-warnings/.test(line))
      .filter((line) => /error|fail|异常|失败|refus|crash/i.test(line))
      .slice(-8);
    for (const line of hits) noteLine(line);
    noteLine('（以上是含 error/fail 的行，空=没有）');
  }

  section('10. 主机资源与容器');
  const free = run('free', ['-m']);
  if (free.missing) skipLine('缺少 free 命令');
  else {
    const mem = free.stdout.split('\n').find((line) => line.startsWith('Mem:'))?.trim().split(/\s+/) || [];
    const swap = free.stdout.split('\n').find((line) => line.startsWith('Swap:'))?.trim().split(/\s+/) || [];
    if (mem.length) noteLine(`内存: 总 ${mem[1]}M 用 ${mem[2]}M 可用 ${mem[6] ?? '-'}M  交换: ${swap[2] ?? '-'}M/${swap[1] ?? '-'}M`);
  }
  const disk = run('df', ['-h', cfg.dataDir]);
  const rootDisk = run('df', ['-h', '/']);
  if (disk.missing && rootDisk.missing) skipLine('缺少 df 命令');
  else {
    const root = (rootDisk.stdout.split('\n')[1] || '').trim().split(/\s+/);
    const data = (disk.stdout.split('\n')[1] || '').trim().split(/\s+/);
    noteLine(`磁盘 /: ${root[1] ?? '-'} 已用 ${root[2] ?? '-'} (${root[4] ?? '-'})  数据盘: ${data[1] ?? '-'} 已用 ${data[2] ?? '-'} (${data[4] ?? '-'})`);
  }
  const uptime = run('uptime');
  if (!uptime.missing) noteLine(`负载: ${/load average[:：]?\s*(.*)$/.exec(uptime.stdout.trim())?.[1] ?? uptime.stdout.trim()}`);
  const ps = run('ps', ['-u', cfg.user, '-o', 'pid=']);
  if (ps.missing) skipLine('缺少 ps 命令');
  else noteLine(`${cfg.user} 进程数: ${ps.stdout.split('\n').filter((line) => line.trim()).length}`);
  const dockerPs = run('docker', ['ps', '--format', '{{.Names}} | {{.Status}} | {{.Ports}}']);
  if (dockerPs.missing) skipLine('缺少 docker 命令');
  else if (dockerPs.ok) for (const line of dockerPs.stdout.split('\n').slice(0, 12)) if (line.trim()) noteLine(`  ${line.trim()}`);
  const listeners = ssListenEntries();
  if (listeners === null) skipLine('缺少 ss 命令（iproute2）');
  else {
    noteLine(`端口绑定（控制台 ${cfg.consolePort} 可能是唯一对外端口，其余应在 127.0.0.1）:`);
    const pattern = new RegExp(`:(${cfg.consolePort}|${cfg.onebotPort}|3391|5099|6081|5900)\\b`);
    const rows = [...new Set(listeners.filter((entry) => pattern.test(entry.local)).map((entry) => `    ${entry.local}  ${entry.process}`.trimEnd()))];
    for (const row of rows) say(row);
  }

  section('11. 主机级自动更新定时器（可选）');
  const hostPattern = envStr('QQ_AGENT_HOST_UPDATE_PATTERN', 'hermes|unattended|update');
  const hostTimers = run('systemctl', ['list-timers', '--all', '--no-pager']);
  if (hostTimers.missing) skipLine('缺少 systemctl 命令');
  else {
    let regex;
    try { regex = new RegExp(hostPattern, 'i'); } catch { regex = null; }
    const hits = regex ? hostTimers.stdout.split('\n').filter((line) => regex.test(line)) : [];
    if (hits.length === 0) noteLine('（未找到）');
    else for (const line of hits) noteLine(line);
  }

  say();
  section('自检结论');
  if (ngCount === 0) say('  全部通过（0 项异常）');
  else say(`  有 ${ngCount} 项异常，见上面 NG 行`);
  say(`  未定义调用扫描: 可疑未定义调用点: ${scanTotal}`);
  return 0;
}

// ─────────────────────────── scan 子命令（原 check-undefined-calls.sh） ───────────────────────────

function cmdScan(args) {
  if (wantsHelp(args)) { say(HELP.scan); return 0; }
  const positional = positionalArgs(args);
  const dir = positional[0] ? path.resolve(positional[0]) : path.join(REPO_DIR, 'src');
  const ignoreRaw = optValue(args, '--ignore', null);
  const ignore = hasFlag(args, '--no-ignore') ? new Set()
    : ignoreRaw === null ? new Set(KNOWN_IGNORE)
      : new Set(ignoreRaw.split(',').map((item) => item.trim()).filter(Boolean));
  if (!exists(dir)) {
    // --strict 是 CI 门禁：路径写错时必须让 CI 变红，否则扫了个空气还判绿（2026-10-03 全量审查）
    ngLine(`目录不存在: ${dir}`);
    return hasFlag(args, '--strict') ? 1 : 0;
  }
  const report = scanDirectory(dir, ignore);
  for (const line of report.lines) say(line);
  say();
  say(`可疑未定义调用点: ${report.total}`);
  const logFile = optValue(args, '--log', null);
  if (logFile && report.total > 0) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const header = `[${stamp}] 启动自检发现可疑未定义调用（${report.total} 处）`;
    try {
      fs.appendFileSync(logFile, `${[header, ...report.lines].join('\n')}\n`, 'utf8');
      say(`已记录到 ${logFile}`);
    } catch (error) {
      ngLine(`写日志失败: ${error && error.message ? error.message : error}`);
    }
  }
  // 原则：只记录、不阻断（挂在服务启动链上时不能因为扫描结果把服务拦下来）。
  // CI 或人工把关时用 --strict：有可疑调用就以 1 退出。
  if (hasFlag(args, '--strict') && report.total > 0) return 1;
  return 0;
}

// ─────────────────────────── backup 子命令（原 backup-qq-agent-data.sh） ───────────────────────────

// GNU tar 会把 "C:/..." 当成远程主机（Windows 盘符），失败时退回不带 --force-local 的形式
// （bsdtar 不认该选项，但它本身不解析远程归档，可以直接处理盘符路径）。
function runTarCreate(outFile, dataDir, extra = null) {
  const parent = path.dirname(dataDir);
  const base = path.basename(dataDir);
  // 部署快照 / 更新缓存都是可重建的大目录；与 scripts/manage.mjs backup 的排除清单保持一致，
  // 否则每周定时备份会把它们整套再打包一份（2026-10 审查 P3）。
  const excludes = ['--exclude=deploy-backups', '--exclude=update-work', '--exclude=update-repository.git',
    // 运行态锁：备份/恢复跨主机时 pid/hostname 都是旧的，会挡住新实例启动
    '--exclude=.server.lock'];
  const baseArgs = [...excludes, '-czf', outFile, '-C', parent, base];
  // 可选：把部署凭据放在归档顶层 stack-credentials/ 下（恢复时不会自动写回，需人工取用）
  if (extra?.dir && extra?.name) baseArgs.push('-C', extra.dir, extra.name);
  const attempts = IS_WINDOWS
    ? [['--force-local', ...baseArgs], [...baseArgs]]
    : [[...baseArgs]];
  let last = { ok: false, code: null, stderr: '' };
  for (const tarArgs of attempts) {
    // 有界超时：备份在 systemctl stop 之后跑，tar 卡住 = 机器人一直停着等人
    //（2026-10-12 审查：这里原来是 timeout: 0 = 永不超时）。30 分钟对数据目录足够宽裕；
    // 超时会连进程一起杀掉，失败路径会清掉半成品并照常拉起服务。
    const result = run('tar', tarArgs, { timeout: 30 * 60 * 1000 });
    if (result.ok) return result;
    last = result;
    try { fs.rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
  }
  return last;
}

async function cmdBackup(args) {
  if (wantsHelp(args)) { say(HELP.backup); return 0; }
  const cfg = config({
    data: optValue(args, '--data', null),
    backupDir: optValue(args, '--backup-dir', null)
  });
  const keep = Math.max(1, intOpt(args, '--keep', cfg.keep));
  const dryRun = hasFlag(args, '--dry-run');
  const noEncrypt = hasFlag(args, '--no-encrypt');
  const includeStackCreds = hasFlag(args, '--include-stack-creds');
  const keyFile = optValue(args, '--key-file', '');
  if (hasFlag(args, '--drill')) {
    return runBackupDrill({ cfg, from: optValue(args, '--from', null), keyFile, noEncrypt });
  }
  const keyPath = backupKeyFile(keyFile);
  if (dryRun) {
    say('备份预演（不会停服务、不会写文件）:');
    noteLine(`数据目录: ${cfg.dataDir}`);
    noteLine(`备份目录: ${cfg.backupDir}`);
    noteLine(`服务名: ${cfg.service}（先 stop、打包后 start）`);
    noteLine(`保留份数: ${keep}`);
    noteLine(`含部署凭据: ${includeStackCreds ? '是（.env / .deployment.json / deployment-access.txt → stack-credentials/）' : '否'}`);
    noteLine(`加密: ${noEncrypt ? '关闭（--no-encrypt，不建议）' : 'AES-256-GCM'}`);
    if (!noEncrypt) {
      noteLine(`密钥: ${String(process.env.QQ_AGENT_BACKUP_KEY || '').trim() ? '来自 QQ_AGENT_BACKUP_KEY' : keyPath}`);
    }
    return 0;
  }
  if (!hasFlag(args, '--confirm')) {
    ngLine('备份会停服务并清理旧备份：请加 --confirm 执行（或 --dry-run 预演）');
    return 1;
  }
  if (!exists(cfg.dataDir)) {
    ngLine(`数据目录不存在: ${cfg.dataDir}`);
    return 1;
  }
  const tarProbe = run('tar', ['--version']);
  if (tarProbe.missing) {
    ngLine('本机缺少 tar 命令，无法备份');
    return 1;
  }
  // 包里是 config.json（含密钥）/console-access.txt/messages.sqlite，权限必须收紧；
  // 默认再加密一层 —— 备份一旦离开主机，明文 tar.gz 就是一份完整凭据。
  fs.mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(cfg.backupDir, 0o700); } catch { /* Windows/不支持时忽略 */ }
  // 上一次加密备份如果被 SIGKILL/掉电打断，可能留下未加密的 .plain；
  // 只清超过 1 小时的，避免误删另一个正在跑的备份。
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(cfg.backupDir)) {
      if (!/^\.qq-agent-data-.*\.tar\.gz\.plain$/.test(name)) continue;
      const file = path.join(cfg.backupDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs >= 60 * 60 * 1000) fs.rmSync(file, { force: true });
      } catch { /* 单个残留不影响本次备份 */ }
    }
  } catch { /* 目录读不了交由后面的 tar 报错 */ }
  const stamp = formatStamp();
  const outFile = path.join(cfg.backupDir, `qq-agent-data-${stamp}.tar.gz${noEncrypt ? '' : '.enc'}`);
  const plainFile = noEncrypt ? outFile : path.join(cfg.backupDir, `.qq-agent-data-${stamp}.tar.gz.plain`);
  const du = run('du', ['-sh', cfg.dataDir]);
  if (!du.missing && du.ok) noteLine(`源大小: ${du.stdout.trim().split(/\s+/)[0]}`);

  // --include-stack-creds：把部署机上的 .env / .deployment.json / deployment-access.txt
  // 复制到临时目录再打进归档顶层。默认不含，避免一份备份把整台机器的凭据都带走。
  let credsTemp = null;
  let credsExtra = null;
  if (includeStackCreds) {
    credsTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stack-creds-'));
    const stackDir = path.join(credsTemp, 'stack-credentials');
    fs.mkdirSync(stackDir, { recursive: true, mode: 0o700 });
    const candidates = [
      { src: path.join(REPO_DIR, '.env'), name: 'app.env' },
      { src: path.join(path.dirname(REPO_DIR), '.env'), name: 'deployment.env' },
      { src: path.join(REPO_DIR, '.deployment.json'), name: 'deployment.json' },
      { src: path.join(path.dirname(REPO_DIR), 'deployment-access.txt'), name: 'deployment-access.txt' }
    ];
    let copied = 0;
    for (const item of candidates) {
      if (!exists(item.src)) continue;
      try {
        const dest = path.join(stackDir, item.name);
        fs.copyFileSync(item.src, dest);
        try { fs.chmodSync(dest, 0o600); } catch { /* Windows 上忽略 */ }
        copied += 1;
      } catch (error) {
        noteLine(`部署凭据复制失败（${item.name}）：${error?.message || error}`);
      }
    }
    if (copied) credsExtra = { dir: credsTemp, name: 'stack-credentials' };
    else noteLine('没有找到可打包的部署凭据（.env / .deployment.json / deployment-access.txt）');
  }

  let serviceManaged = false;
  let tarOk = false;
  try {
    serviceManaged = serviceLoaded(cfg.service);
    if (!serviceManaged) {
      skipLine(`服务 ${cfg.service} 不存在或不可用：跳过停服务（直接打包）`);
    } else {
      const stop = systemctlUser(['stop', cfg.service], { timeout: 60000 });
      if (!stop.ok) {
        // 备份要打的是"停服后的一致性快照"：停不下来就宁可不打，也不生成可能损坏的归档。
        ngLine(`停止服务失败（返回码 ${stop.code}），已中止备份；请手动停止 ${cfg.service} 后重试`);
        return 1;
      }
    }
    await sleep(2000);
    // 停服后仍被锁住 = 还有别的进程在写这个数据目录（自定义 service 名/容器/WSL 等）。
    // 此时打出来的是跨时刻的 SQLite 副本，宁可中止也不生成不可信的归档。
    const lock = inspectInstanceLock(cfg.dataDir);
    if (['live', 'foreign', 'transient'].includes(lock.state)) {
      const who = lock.holder
        ? `pid ${lock.holder.pid}${lock.holder.hostname ? ` @ ${lock.holder.hostname}` : ''}`
        : lock.state;
      ngLine(`数据目录仍被实例占用（${who}），已中止备份；请先停止该实例`);
      return 1;
    }
    // 先以 0600 预创建明文包：tar 覆盖已有文件时保留权限，中断也不会留下 umask 决定的 0644。
    try {
      fs.closeSync(fs.openSync(plainFile, 'w', 0o600));
      try { fs.chmodSync(plainFile, 0o600); } catch { /* Windows 忽略 */ }
    } catch (error) {
      ngLine(`无法创建临时备份文件：${error?.message || error}，本次备份作废`);
      return 1;
    }
    const tar = runTarCreate(plainFile, cfg.dataDir, credsExtra);
    tarOk = tar.ok;
    if (!tarOk) ngLine(`tar 打包失败（返回码 ${tar.code}${tar.stderr ? `：${tar.stderr.trim().split('\n')[0]}` : ''}）`);
  } finally {
    if (credsTemp) {
      try { fs.rmSync(credsTemp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    // 无论 tar 成败都要把服务拉起来——备份失败可以下次再试，机器人停着才是事故。
    if (serviceManaged) {
      const start = systemctlUser(['start', cfg.service], { timeout: 60000 });
      await sleep(3000);
      const state = systemctlUser(['is-active', cfg.service]);
      noteLine(`服务: ${state.stdout.trim() || text(state) || '未知'}`);
      if (!start.ok) ngLine(`服务重启失败（返回码 ${start.code}）：请手动检查 systemctl --user status ${cfg.service}`);
    }
  }
  if (!tarOk) {
    try { fs.rmSync(plainFile, { force: true }); } catch { /* 忽略 */ }
    ngLine('tar 失败，本次备份作废（服务已恢复）');
    return 1;
  }
  // 服务已经恢复，加密放在这里做：不占停机时间。
  if (!noEncrypt) {
    try {
      await encryptBackupFile(plainFile, outFile, loadBackupKey({ create: true, keyFile }));
      try { fs.rmSync(plainFile, { force: true }); } catch { /* 忽略 */ }
    } catch (error) {
      try { fs.rmSync(plainFile, { force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
      ngLine(`加密失败：${error?.message || error}（本次备份作废）`);
      return 1;
    }
  }
  const backups = listBackupFiles(cfg.backupDir);
  for (const stale of backups.slice(keep)) {
    try { fs.rmSync(stale.file, { force: true }); } catch { /* 忽略 */ }
  }
  const size = (() => {
    try { return (fs.statSync(outFile).size / 1024 / 1024).toFixed(1); } catch { return '?'; }
  })();
  try { fs.chmodSync(outFile, 0o600); } catch { /* 权限设不上不影响备份本身 */ }
  okLine(`备份完成: ${size} MB ${outFile}`);
  if (!noEncrypt) noteLine(`加密: AES-256-GCM；密钥 ${String(process.env.QQ_AGENT_BACKUP_KEY || '').trim() ? '来自环境变量' : keyFile || keyPath}`);
  for (const item of backups.slice(0, keep)) noteLine(`  ${item.name}`);
  return 0;
}

// ─────────────────────────── 备份加密 / 恢复 ───────────────────────────

const BACKUP_MAGIC = Buffer.from('QQAGENT1');

function backupKeyFile(explicit = '') {
  return explicit || envStr('QQ_AGENT_BACKUP_KEY_FILE', path.join(os.homedir(), '.config', 'qq-agent', 'backup.key'));
}

/** 密钥来源：QQ_AGENT_BACKUP_KEY（64 位 hex 或口令）优先，其次密钥文件；备份时缺文件会自动生成。 */
function loadBackupKey({ create = false, keyFile = '' } = {}) {
  const envKey = String(process.env.QQ_AGENT_BACKUP_KEY || '').trim();
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) return Buffer.from(envKey, 'hex');
    // 口令：固定 salt 是为了同一口令在不同机器上能解开同一份备份（备份恢复不依赖本机状态）。
    return crypto.scryptSync(envKey, 'qq-agent-backup-v1', 32);
  }
  const file = backupKeyFile(keyFile);
  try {
    const raw = fs.readFileSync(file);
    const textValue = raw.toString('utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(textValue)) return Buffer.from(textValue, 'hex');
    if (raw.length === 32) return raw;
    throw new Error('密钥文件格式不对（需要 64 位十六进制或 32 字节）');
  } catch (error) {
    if (!create) {
      throw new Error(`找不到可用的备份密钥：${file}（${error?.message || error}）。`
        + '请设置 QQ_AGENT_BACKUP_KEY 或用 --key-file 指定');
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600 });
    noteLine(`已生成备份密钥: ${file}（请与备份分开保管；丢了备份无法恢复）`);
    return key;
  }
}

async function encryptBackupFile(inFile, outFile, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const writer = fs.createWriteStream(outFile, { mode: 0o600 });
  writer.write(BACKUP_MAGIC);
  writer.write(iv);
  await pipeline(fs.createReadStream(inFile), cipher, writer);
  fs.appendFileSync(outFile, cipher.getAuthTag(), { mode: 0o600 });
}

async function decryptBackupFile(inFile, outFile, key) {
  const size = fs.statSync(inFile).size;
  if (size < BACKUP_MAGIC.length + 12 + 16) throw new Error('备份文件太短，不是有效归档');
  const head = Buffer.alloc(BACKUP_MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  const fd = fs.openSync(inFile, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
    fs.readSync(fd, tag, 0, tag.length, size - 16);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error('不是 QQ Agent 加密备份（文件头不符）');
  }
  const iv = head.subarray(BACKUP_MAGIC.length);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  await pipeline(
    fs.createReadStream(inFile, { start: head.length, end: size - 17 }),
    decipher,
    fs.createWriteStream(outFile, { mode: 0o600 })
  );
}

function listBackupFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^qq-agent-data-.*\.tar\.gz(\.enc)?$/.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        return { name, file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** Windows 上先试 GNU tar 的 --force-local，遇到 bsdtar（不认这个选项）再退回不加。 */
function runTarWithFallback(args, options) {
  const attempts = IS_WINDOWS ? [['--force-local', ...args], [...args]] : [args];
  let last = { ok: false, code: null, stderr: '' };
  for (const attempt of attempts) {
    const result = run('tar', attempt, options);
    if (result.ok) return result;
    last = result;
  }
  return last;
}

function runTarList(file) {
  return runTarWithFallback(['-tzf', file], { timeout: 120000 });
}

/** 详细列表（首列是条目类型）：-tzf 只给名字，识别不了符号链接/硬链接/设备节点。 */
function runTarVerboseList(file) {
  return runTarWithFallback(['-tvzf', file], { timeout: 120000 });
}

function runTarExtract(file, destDir) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  return runTarWithFallback(['-xzf', file, '-C', destDir], { timeout: 30 * 60 * 1000 });
}

function unsafeArchiveName(raw) {
  let name = String(raw || '').replace(/\\/g, '/');
  while (name.startsWith('./')) name = name.slice(2);
  name = name.replace(/\/+$/, '');
  if (!name || name === '.') return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
  return name.split('/').some((segment) => {
    if (!segment || segment === '.' || segment === '..') return true;
    if (/[<>:"|?*\x00-\x1f]/.test(segment)) return true;
    // Windows 会剥掉段末尾的点和空格（restore 也在 Windows 上跑）
    if (segment.replace(/[. ]+$/g, '') !== segment) return true;
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment);
  });
}

function validateTarEntries(stdout) {
  const entries = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const unsafe = entries.filter((entry) => unsafeArchiveName(entry));
  if (unsafe.length) throw new Error(`归档包含不安全路径：${unsafe.slice(0, 3).join('、')}`);
  return entries;
}

/** 拒绝符号链接/硬链接/设备/FIFO：恢复时 cpSync 会把链接原样带进数据目录。 */
function validateTarTypes(stdout) {
  const lines = String(stdout || '').split('\n').filter((line) => line.trim());
  const bad = lines.filter((line) => !['-', 'd'].includes(line[0]));
  if (bad.length) {
    throw new Error(`归档包含不允许的条目类型（只允许普通文件/目录）：${bad.slice(0, 3).join('、')}`);
  }
  return lines;
}

/** 归档里数据目录可能在顶层，也可能套了一层（`data/config.json`）。 */
function locateDataRoot(dir) {
  if (exists(path.join(dir, 'config.json'))) return dir;
  let children = [];
  try { children = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return null; }
  for (const child of children) {
    if (child.name.startsWith('.')) continue;
    const candidate = path.join(dir, child.name);
    if (exists(path.join(candidate, 'config.json'))) return candidate;
  }
  return null;
}

/** 数据目录里的 SQLite 不只在顶层：人物记忆索引、长期语义记忆都在子目录。 */
function listSqliteFiles(root, maxDepth = 3) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.sqlite')) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found;
}

/** 恢复演练：解密 -> 校验路径 -> 解到临时目录 -> SQLite integrity_check。不碰生产数据。 */
async function runBackupDrill({ cfg, from = null, keyFile = '', noEncrypt = false } = {}) {
  const source = from
    ? { name: path.basename(from), file: path.resolve(from) }
    : listBackupFiles(cfg.backupDir)[0];
  if (!source || !exists(source.file)) {
    ngLine(`没有可演练的备份文件（目录：${cfg.backupDir}）`);
    return 1;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-backup-drill-'));
  const tarFile = path.join(temp, 'restore.tar.gz');
  try {
    if (!noEncrypt && source.file.endsWith('.enc')) {
      await decryptBackupFile(source.file, tarFile, loadBackupKey({ keyFile }));
    } else {
      fs.copyFileSync(source.file, tarFile);
    }
    const listed = runTarList(tarFile);
    if (listed.missing) { ngLine('本机缺少 tar，无法演练'); return 1; }
    if (!listed.ok) { ngLine(`归档读取失败：${(listed.stderr || '').trim().split('\n')[0] || listed.code}`); return 1; }
    const verbose = runTarVerboseList(tarFile);
    if (!verbose.ok) { ngLine(`归档类型读取失败：${(verbose.stderr || '').trim().split('\n')[0] || verbose.code}`); return 1; }
    const entries = validateTarEntries(listed.stdout);
    validateTarTypes(verbose.stdout);
    const extractDir = path.join(temp, 'extract');
    const extracted = runTarExtract(tarFile, extractDir);
    if (!extracted.ok) { ngLine(`解包失败：${(extracted.stderr || '').trim().split('\n')[0] || extracted.code}`); return 1; }
    const dataRoot = locateDataRoot(extractDir);
    if (!dataRoot) { ngLine('归档里没有 config.json，不像 QQ Agent 数据目录'); return 1; }
    const databases = listSqliteFiles(dataRoot);
    for (const file of databases) {
      const name = path.relative(dataRoot, file);
      let db = null;
      try {
        db = openDatabase(file, { readOnly: true });
        const row = db.prepare('PRAGMA integrity_check').get();
        const verdict = row ? Object.values(row)[0] : '';
        if (verdict !== 'ok') { ngLine(`${name}: integrity_check=${verdict || '未知'}`); return 1; }
      } catch (error) {
        noteLine(`${name}: 跳过 integrity_check（${error?.message || error}）`);
      } finally {
        try { db?.close(); } catch { /* 忽略 */ }
      }
    }
    okLine(`演练通过: ${source.name}（${entries.length} 个条目，${databases.length} 个 SQLite）`);
    return 0;
  } catch (error) {
    ngLine(`演练失败：${error?.message || error}`);
    return 1;
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

async function cmdRestore(args) {
  if (wantsHelp(args)) { say(HELP.restore); return 0; }
  const from = String(optValue(args, '--from', '') || '').trim();
  if (!from) { ngLine('缺少 --from <备份文件>'); return 2; }
  if (!exists(from)) { ngLine(`备份文件不存在: ${from}`); return 2; }
  const cfg = config({ data: optValue(args, '--data', null) });
  const keyFile = optValue(args, '--key-file', '');
  const noEncrypt = hasFlag(args, '--no-encrypt');
  const dryRun = hasFlag(args, '--dry-run');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-restore-'));
  const tarFile = path.join(temp, 'restore.tar.gz');
  try {
    if (!noEncrypt && from.endsWith('.enc')) {
      await decryptBackupFile(from, tarFile, loadBackupKey({ keyFile }));
    } else {
      fs.copyFileSync(from, tarFile);
    }
    const listed = runTarList(tarFile);
    if (listed.missing) { ngLine('本机缺少 tar，无法恢复'); return 1; }
    if (!listed.ok) { ngLine(`归档读取失败：${(listed.stderr || '').trim().split('\n')[0] || listed.code}`); return 1; }
    const verbose = runTarVerboseList(tarFile);
    if (!verbose.ok) { ngLine(`归档类型读取失败：${(verbose.stderr || '').trim().split('\n')[0] || verbose.code}`); return 1; }
    const entries = validateTarEntries(listed.stdout);
    validateTarTypes(verbose.stdout);
    noteLine(`归档条目: ${entries.length}`);
    if (dryRun) {
      for (const entry of entries.slice(0, 20)) noteLine(`  ${entry}`);
      if (entries.length > 20) noteLine(`  … 还有 ${entries.length - 20} 条`);
      say('恢复预演（未停服务、未写数据目录）');
      return 0;
    }
    if (!hasFlag(args, '--confirm')) {
      ngLine('恢复会覆盖数据目录：请加 --confirm（或 --dry-run 预览）');
      return 1;
    }
    const extractDir = path.join(temp, 'extract');
    const extracted = runTarExtract(tarFile, extractDir);
    if (!extracted.ok) { ngLine(`解包失败：${(extracted.stderr || '').trim().split('\n')[0] || extracted.code}`); return 1; }
    const dataRoot = locateDataRoot(extractDir);
    if (!dataRoot) { ngLine('归档里没有 config.json，不像 QQ Agent 数据目录'); return 1; }

    const stamp = formatStamp();
    const pre = `${cfg.dataDir}.pre-restore-${stamp}`;
    const serviceManaged = serviceLoaded(cfg.service);
    if (!serviceManaged) {
      skipLine(`服务 ${cfg.service} 不存在或不可用：跳过停服务（只恢复数据）`);
    } else {
      const stop = systemctlUser(['stop', cfg.service], { timeout: 60000 });
      if (!stop.ok) {
        ngLine(`停止服务失败（返回码 ${stop.code}），已中止恢复；请手动停止 ${cfg.service} 后重试`);
        systemctlUser(['start', cfg.service], { timeout: 60000 });
        return 1;
      }
    }
    await sleep(2000);
    // 停服后仍被锁住 = 还有进程在写这个数据目录（自定义 service 名/容器/WSL 等）。
    // 此时 rename+覆盖会让在线进程与磁盘分叉，必须拒绝。
    const lock = inspectInstanceLock(cfg.dataDir);
    if (['live', 'foreign', 'transient'].includes(lock.state)) {
      const who = lock.holder
        ? `pid ${lock.holder.pid}${lock.holder.hostname ? ` @ ${lock.holder.hostname}` : ''}`
        : lock.state;
      ngLine(`数据目录仍被实例占用（${who}）：${lock.file}`);
      ngLine('请先停止该实例；确认进程已退出后删除锁文件再重试');
      if (serviceManaged) systemctlUser(['start', cfg.service], { timeout: 60000 });
      return 1;
    }

    let committed = false;
    let rolledBackPrevious = false;
    let previousMoved = false;
    const hadPrevious = exists(cfg.dataDir);
    try {
      if (hadPrevious) { fs.renameSync(cfg.dataDir, pre); previousMoved = true; }
      fs.mkdirSync(path.dirname(cfg.dataDir), { recursive: true });
      fs.cpSync(dataRoot, cfg.dataDir, { recursive: true, force: true });
      // 旧归档可能带着源主机的锁（pid/hostname 都不属于本机）：恢复后必须清掉。
      try { fs.rmSync(path.join(cfg.dataDir, '.server.lock'), { force: true }); } catch { /* 忽略 */ }
      try { fs.chmodSync(cfg.dataDir, 0o700); } catch { /* 忽略 */ }
      committed = true;
    } catch (error) {
      ngLine(`恢复失败：${error?.message || error}`);
      // cpSync 在创建目标目录之后失败会留下半套数据；旧逻辑只在"目标不存在"时才回滚，
      // 结果服务会带着部分恢复的目录启动（2026-10-31 盲审 P1）。这里先挪走半成品再换回旧数据。
      try {
        if (previousMoved && exists(cfg.dataDir)) {
          if (hadPrevious) {
            const partial = `${cfg.dataDir}.restore-partial-${stamp}`;
            fs.renameSync(cfg.dataDir, partial);
            ngLine(`部分恢复的数据留在 ${partial}`);
          } else {
            fs.rmSync(cfg.dataDir, { recursive: true, force: true });
          }
        }
        if (previousMoved && hadPrevious && exists(pre)) {
          fs.renameSync(pre, cfg.dataDir);
          rolledBackPrevious = true;
        } else if (!previousMoved && hadPrevious && exists(cfg.dataDir)) {
          // 改名就没成功：旧目录还是完整的，可以直接启动。
          rolledBackPrevious = true;
        }
      } catch (rollbackError) {
        ngLine(`回滚失败，恢复前的数据仍在 ${pre}：${rollbackError?.message || rollbackError}`);
      }
      return 1;
    } finally {
      const canStart = committed || rolledBackPrevious;
      if (serviceManaged && !canStart) {
        ngLine('恢复未完成且旧数据未能自动换回：服务保持停止，请人工检查后再启动');
      } else if (serviceManaged) {
        const start = systemctlUser(['start', cfg.service], { timeout: 60000 });
        await sleep(3000);
        const state = systemctlUser(['is-active', cfg.service]);
        const active = String(state.stdout || '').trim() === 'active';
        noteLine(`服务: ${state.stdout.trim() || text(state) || '未知'}`);
        // Type=simple 的 start 返回 0 不代表进程没在几秒内崩掉：必须看 is-active。
        if (committed && (!start.ok || !active)) {
          ngLine('恢复后服务起不来：正在回滚到恢复前的数据');
          systemctlUser(['stop', cfg.service], { timeout: 60000 });
          try {
            const failed = `${cfg.dataDir}.restore-failed-${stamp}`;
            if (exists(cfg.dataDir)) fs.renameSync(cfg.dataDir, failed);
            if (exists(pre)) fs.renameSync(pre, cfg.dataDir);
            systemctlUser(['start', cfg.service], { timeout: 60000 });
            ngLine(`已回滚；恢复失败的数据留在 ${failed}`);
          } catch (rollbackError) {
            ngLine(`回滚失败：${rollbackError?.message || rollbackError}`);
          }
          return 1;
        }
      }
    }
    okLine(`恢复完成: ${cfg.dataDir}`);
    if (exists(pre)) noteLine(`恢复前的数据已留档: ${pre}`);
    return 0;
  } catch (error) {
    ngLine(`恢复失败：${error?.message || error}`);
    return 1;
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

function configuredRetentionDays(dataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return Math.max(0, Math.floor(Number(cfg?.store?.retentionDays) || 0));
  } catch {
    return 0;
  }
}

/** 按天清理已确认（acked）的历史消息；未处理/held 永不删除。 */
function cmdPrune(args) {
  if (wantsHelp(args)) { say(HELP.prune); return 0; }
  const cfg = config({ data: optValue(args, '--data', null) });
  const days = Math.max(0, intOpt(args, '--days', configuredRetentionDays(cfg.dataDir)));
  if (!days) {
    ngLine('没有指定 --days，config.json 的 store.retentionDays 也是 0（不删除任何消息）');
    return 1;
  }
  const file = path.join(cfg.dataDir, 'messages.sqlite');
  if (!exists(file)) { ngLine(`找不到消息库: ${file}`); return 1; }
  const cutoff = Date.now() - days * 86400000;
  const db = openDatabase(file);
  try {
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE state='acked' AND ts < ?").get(cutoff)?.n) || 0;
    noteLine(`候选: ${total} 条（state=acked 且 ts < ${new Date(cutoff).toISOString()}，保留最近 ${days} 天）`);
    if (hasFlag(args, '--dry-run')) return 0;
    if (!hasFlag(args, '--confirm')) {
      ngLine('这会删除历史消息：请加 --confirm 执行（或 --dry-run 预览）');
      return 1;
    }
    let removed = 0;
    while (true) {
      // 按 rowid 删除：messages 的主键是 (chat_key, id)，id 只是**会话内**自增。
      // 只按 id 匹配会跨会话误删同号行（pending/held 也一起没），2026-10-31 全量审查 P1。
      const result = db.prepare(`DELETE FROM messages WHERE rowid IN (
        SELECT rowid FROM messages WHERE state='acked' AND ts < ? ORDER BY ts LIMIT 1000
      )`).run(cutoff);
      const changes = Number(result?.changes) || 0;
      removed += changes;
      if (!changes) break;
    }
    // message_count 是 chats 上的缓存（getChatMeta/分页 total 读它），删除后必须重算，
    // 否则列表里的"共 N 条"会长期虚高。
    try {
      db.exec(`UPDATE chats SET message_count=(
        SELECT COUNT(*) FROM messages WHERE messages.chat_key=chats.chat_key
      )`);
    } catch { /* 老库/空库没有 chats 表时不阻断清理 */ }
    okLine(`已删除 ${removed} 条（保留最近 ${days} 天；未处理/held 未动）`);
    return 0;
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
  }
}

// ─────────────────────────── watch-send 子命令（原 watch-send.py） ───────────────────────────

function outboxSnapshot(dataDir) {
  const db = openReadOnlyDb(path.join(dataDir, 'messages.sqlite'));
  const result = { error: '', maxRowid: 0, rows: [], lastHuman: null, pending: 0, definedIncidents: [], incidentError: '' };
  if (!db) {
    result.error = 'messages.sqlite 不存在或无法以只读方式打开';
    return result;
  }
  try {
    result.maxRowid = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM outbox').get()?.value ?? 0);
    const rows = db.prepare('SELECT rowid AS rid, run_id AS run, chat_key AS chat, state, payload, error FROM outbox ORDER BY rowid DESC LIMIT 6').all();
    result.rows = rows.map((row) => {
      let text = '';
      try {
        const parsed = row.payload ? JSON.parse(row.payload) : null;
        text = parsed && typeof parsed === 'object' ? String(parsed.text ?? '') : String(row.payload ?? '');
      } catch {
        text = String(row.payload ?? '').slice(0, 60);
      }
      return { rid: Number(row.rid), run: row.run, chat: row.chat, state: row.state, text: text.slice(0, 80), error: row.error };
    });
    const human = db.prepare('SELECT ts, text FROM messages WHERE self=0 ORDER BY ts DESC LIMIT 1').get();
    if (human) result.lastHuman = { ts: human.ts, text: String(human.text ?? '').slice(0, 80) };
    result.pending = Number(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE state='pending'").get()?.count ?? 0);
  } catch (error) {
    result.error = error && error.message ? error.message : String(error);
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
  }
  const idb = openReadOnlyDb(path.join(dataDir, 'incident-pilot.sqlite'));
  if (idb) {
    try {
      const columns = idb.prepare('PRAGMA table_info(incidents)').all().map((row) => row.name);
      const column = ['message', 'msg'].find((name) => columns.includes(name)) || columns[0];
      if (column) {
        const rows = idb.prepare(`SELECT ${column} AS msg, last_at FROM incidents WHERE ${column} LIKE ? ORDER BY last_at DESC LIMIT 2`).all('%is not defined%');
        result.definedIncidents = rows.map((row) => ({ msg: String(row.msg ?? '').slice(0, 90), at: Number(row.last_at ?? 0) }));
      }
    } catch (error) {
      result.incidentError = error && error.message ? error.message : String(error);
    } finally {
      try { idb.close(); } catch { /* 忽略 */ }
    }
  } else {
    result.incidentError = 'incident-pilot.sqlite 不存在或无法只读打开';
  }
  return result;
}

function clockStamp(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function cmdWatchSend(args) {
  if (wantsHelp(args)) { say(HELP['watch-send']); return 0; }
  const cfg = config({ data: optValue(args, '--data', null) });
  const minutes = numOpt(args, '--minutes', 240);
  const intervalSec = Math.max(1, numOpt(args, '--interval', 30));
  if (!(minutes > 0)) {
    ngLine('--minutes 需要大于 0 的分钟数');
    return 1;
  }
  let base = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    base = outboxSnapshot(cfg.dataDir);
    if (!base.error) break;
    say(`  （基线第 ${attempt} 次查询失败：${base.error}，10 秒后重试）`);
    await sleep(10000);
  }
  if (!base || base.error) {
    say('基线查询连续 3 次失败，脚本退出');
    return 1;
  }
  const baseRowid = base.maxRowid;
  const baseIncidentAt = Math.max(0, ...base.definedIncidents.map((item) => item.at));
  say(`基线：outbox 最新 rowid=${baseRowid}，待处理消息 ${base.pending} 条`);
  say(`      最近一条人类消息：${base.lastHuman?.text ?? '-'}`);
  if (base.incidentError) noteLine(`（告警库读取提示：${base.incidentError}）`);

  const deadline = Date.now() + minutes * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSec * 1000);
    const info = outboxSnapshot(cfg.dataDir);
    if (info.error) {
      say(`  （本轮查询失败，跳过：${info.error}）`);
      continue;
    }
    for (const incident of info.definedIncidents) {
      if (incident.at > baseIncidentAt) {
        say(`SEND_FAIL：又出现未定义函数事故 → ${incident.msg}（${clockStamp(incident.at)}）`);
        return 1;
      }
    }
    const fresh = info.rows.filter((row) => row.rid > baseRowid);
    for (const row of fresh.reverse()) {
      if (row.state === 'failed') {
        say(`SEND_FAIL：工具层发送失败 ｜ ${row.chat} ｜ ${row.run} ｜ ${row.text} ｜ ${row.error}`);
        return 1;
      }
      if (String(row.run) === 'mix-test' || String(row.run) === 'manual-face-test') continue; // 手工测试行，不算
      say(`SEND_OK：机器人通过工具层成功回话 ｜ ${row.chat} ｜ run=${row.run} ｜ state=${row.state} ｜ ${row.text}`);
      say(`      人类上一条：${info.lastHuman?.text ?? '-'}`);
      return 0;
    }
  }
  say(`TIMEOUT：${minutes} 分钟内没有通过工具层发过消息（没人跟它说话也属正常）`);
  return 2;
}

// ─────────────────────────── watch-login 子命令（原 watch-login.py） ───────────────────────────

async function cmdWatchLogin(args) {
  if (wantsHelp(args)) { say(HELP['watch-login']); return 0; }
  const cfg = config({});
  const cfgJson = loadConfigJson(cfg.dataDir);
  const token = onebotToken(cfgJson);
  const minutes = numOpt(args, '--timeout', 25);
  const intervalSec = Math.max(1, numOpt(args, '--interval', 15));
  if (!token) {
    ngLine('未设置 QQ_AGENT_ONEBOT_TOKEN（或 config.json 里没有 OneBot 令牌），无法轮询登录状态');
    return 1;
  }
  const consoleInfo = configToken(cfgJson);
  const statusUrl = `http://127.0.0.1:${cfg.onebotPort}/get_status`;
  const deadline = Date.now() + Math.max(0, minutes) * 60 * 1000;
  let tries = 0;
  while (Date.now() <= deadline) {
    tries += 1;
    const status = await fetchJson(statusUrl, { Authorization: `Bearer ${token}` }, 4000);
    if (status.body && status.body.includes('online')) {
      say(`LOGIN_OK（第 ${tries} 次探测，约 ${Math.round(tries * intervalSec)} 秒）`);
      say(`get_status: ${status.body.trim().slice(0, 200)}`);
      const loginInfo = await fetchJson(`http://127.0.0.1:${cfg.onebotPort}/get_login_info`, { Authorization: `Bearer ${token}` }, 5000);
      say(`get_login_info: ${loginInfo.body.trim().slice(0, 300) || '（无响应）'}`);
      if (consoleInfo.token) {
        const consoleStatus = await fetchJson(`http://127.0.0.1:${cfg.consolePort}/api/status`, { 'x-console-token': consoleInfo.token }, 5000);
        say(`console: ${consoleStatus.body.trim().slice(0, 400) || '（无响应）'}`);
      }
      say('--- journal ---');
      const journal = run('journalctl', ['--user', '-u', cfg.service, '-n', '12', '--no-pager']);
      if (journal.missing) skipLine('缺少 journalctl 命令');
      else say(journal.stdout.trim());
      return 0;
    }
    await sleep(intervalSec * 1000);
  }
  say(`LOGIN_TIMEOUT（${minutes} 分钟内没等到登录，二维码可能已过期）`);
  return 1;
}

// ─────────────────────────── guard 子命令（原 guard-process-explosion.sh） ───────────────────────────

function readProc(pid, name) {
  return readFileSafe(`/proc/${pid}/${name}`);
}

function linuxProcesses() {
  const procs = [];
  if (!exists('/proc')) return procs;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const status = readProc(entry, 'status');
    const uidLine = status.split('\n').find((line) => line.startsWith('Uid:'));
    const uid = uidLine ? uidLine.trim().split(/\s+/)[1] : '';
    const comm = readProc(entry, 'comm').trim();
    const cmdline = readProc(entry, 'cmdline').replace(/\0/g, ' ').trim();
    procs.push({ pid: entry, uid, comm, cmdline });
  }
  return procs;
}

function passwdUid(name) {
  for (const line of readFileSafe('/etc/passwd').split('\n')) {
    const fields = line.split(':');
    if (fields[0] === name && fields.length > 2) return fields[2];
  }
  return '';
}

function appendGuardLog(logFile, lines) {
  try {
    fs.appendFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
    return true;
  } catch (error) {
    ngLine(`写看门狗日志失败（${logFile}）：${error && error.message ? error.message : error}`);
    return false;
  }
}

function cmdGuard(args) {
  if (wantsHelp(args)) { say(HELP.guard); return 0; }
  if (isContainerRuntime()) { badWarn(containerUpdateHint()); return 1; }
  warnCount = 0;
  const cfg = config({});
  const limit = Math.max(1, intOpt(args, '--threshold', intEnv('QQ_AGENT_PROC_LIMIT', 800)));
  const dryRun = hasFlag(args, '--dry-run');
  const logFile = optValue(args, '--log', envStr('QQ_AGENT_GUARD_LOG', path.join(os.homedir(), 'process-explosion.log')));
  if (!IS_LINUX || !exists('/proc')) {
    skipLine(`进程看门狗只在 Linux 上生效（当前平台 ${process.platform}）`);
    return 0;
  }
  const target = cfg.guardUser;
  let targetUid = '';
  if (target === currentUser() && typeof process.getuid === 'function') targetUid = String(process.getuid());
  else targetUid = passwdUid(target);
  if (!targetUid) {
    skipLine(`无法解析用户 ${target} 的 uid（/etc/passwd 里没有？）`);
    return 0;
  }
  const procs = linuxProcesses().filter((proc) => proc.uid === targetUid);
  if (procs.length < limit) {
    okLine(`${target} 进程数 ${procs.length}，低于阈值 ${limit}，无需处理`);
    return 0;
  }
  const counts = new Map();
  for (const proc of procs) counts.set(proc.comm, (counts.get(proc.comm) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => `${name}:${count}`).join(' ');
  say(`=== ${new Date().toLocaleString('zh-CN', { hour12: false })} 触发：${target} 进程数 ${procs.length} ===`);
  noteLine(`各程序计数: ${top}`);
  // 只按"同类进程数超阈值"判定失控（bash 200 个 = 真 fork 炸弹）。
  // 旧逻辑在进程总数超限时把目标用户的全部 bash/sh/grep/tr/sleep 一网打尽——
  // 包括管理员自己的 SSH 会话和正在跑的部署脚本（真实误杀形态，勿回退）。
  // 总数超限但没有同类失控组时，只告警不杀。
  const runaway = procs.filter((proc) => ['bash', 'grep', 'tr', 'sh', 'sleep'].includes(proc.comm)
    && (counts.get(proc.comm) || 0) > 200);
  if (procs.length > 3000 && runaway.length === 0) {
    say(`  进程总数 ${procs.length} 超过 3000，但没有单类进程超过 200：不做查杀（避免误杀正常会话与部署脚本）`);
  }
  if (dryRun) {
    say(`  （预演）将清理 ${runaway.length} 个失控进程，不写日志、不杀进程`);
    for (const proc of runaway.slice(0, 20)) noteLine(`  pid=${proc.pid} ${proc.comm} ${proc.cmdline.slice(0, 100)}`);
    if (runaway.length > 20) noteLine(`  ...（其余 ${runaway.length - 20} 个略）`);
    return 0;
  }
  if (!hasFlag(args, '--confirm')) {
    ngLine(`检测到 ${procs.length} 个进程（阈值 ${limit}）超过阈值：真实清理请加 --confirm（或 --dry-run 预演）`);
    return 1;
  }
  let killed = 0;
  for (const proc of runaway) {
    try {
      process.kill(Number(proc.pid), 'SIGKILL');
      killed += 1;
    } catch { /* 进程可能已退出 */ }
  }
  const logLines = [
    `=== ${new Date().toLocaleString('zh-CN', { hour12: false })} 触发：${target} 进程数 ${procs.length} ===`,
    `  各程序计数: ${top}`,
    `  已杀: ${killed}`
  ];
  appendGuardLog(logFile, logLines);
  say(`  已杀: ${killed}（记录在 ${logFile}）`);
  return 0;
}

// ─────────────────────────── face-names 子命令（原 export-face-names.sh） ───────────────────────────

function cmdFaceNames(args) {
  if (wantsHelp(args)) { say(HELP['face-names']); return 0; }
  const cfg = config({ data: optValue(args, '--data', null) });
  const container = optValue(args, '--container', cfg.snowlumaContainer);
  const printOnly = hasFlag(args, '--print') || hasFlag(args, '--dry-run');
  const catalogOverride = optValue(args, '--catalog', null);
  const qqOverride = optValue(args, '--qq-config', null);
  const outFile = path.join(cfg.dataDir, 'face-names.json');

  let tmpDir = '';
  let catalogFile = catalogOverride;
  let qqFile = qqOverride;
  if (!catalogFile) {
    const dockerProbe = run('docker', ['--version']);
    if (dockerProbe.missing) {
      ngLine('本机缺少 docker 命令，无法从容器导出（可用 --catalog=文件 指定本地副本）');
      return 1;
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-face-names-'));
    catalogFile = path.join(tmpDir, 'sys-face.json');
    qqFile = qqFile || path.join(tmpDir, 'qq-face.json');
    const copied = run('docker', ['cp', `${container}:/app/data/data/sys-face-catalog.json`, catalogFile]);
    if (!copied.ok) {
      cleanupTmp(tmpDir);
      ngLine(`导出失败：容器 ${container} 未运行或文件不存在`);
      return 1;
    }
    run('docker', ['cp', `${container}:/app/.config/QQ/global/nt_data/Emoji/emoji-resource/face_config.json`, qqFile]);
  }
  try {
    const merged = new Map();
    const sources = new Map();
    try {
      const catalog = JSON.parse(readFileSafe(catalogFile));
      for (const pack of catalog.packs || []) {
        for (const emoji of pack.emojis || []) {
          const sid = String(emoji.qSid ?? '').trim();
          const name = String(emoji.qDes ?? '').trim().replace(/^\//, '');
          if (sid && name) { merged.set(sid, name); sources.set(sid, 'catalog'); }
        }
      }
    } catch (error) {
      noteLine(`目录读取失败: ${error && error.message ? error.message : error}`);
    }
    try {
      const qq = JSON.parse(readFileSafe(qqFile));
      let added = 0;
      for (const emoji of qq.sysface || []) {
        const sid = String(emoji.QSid ?? '').trim();
        const name = String(emoji.QDes ?? '').trim().replace(/^\//, '');
        if (sid && name && !merged.has(sid)) { merged.set(sid, name); sources.set(sid, 'qq'); added += 1; }
      }
      noteLine(`QQ 配置新增 ${added} 条`);
    } catch (error) {
      noteLine(`QQ 配置读取失败: ${error && error.message ? error.message : error}`);
    }
    const extraPath = path.join(cfg.dataDir, 'face-names-extra.json');
    if (exists(extraPath)) {
      try {
        const extra = JSON.parse(readFileSafe(extraPath));
        let applied = 0;
        for (const [key, value] of Object.entries(extra.bySid || {})) {
          const sid = String(key).trim();
          const name = String(value).trim();
          if (sid && name && merged.get(sid) !== name) { merged.set(sid, name); sources.set(sid, 'manual'); applied += 1; }
        }
        noteLine(`手工补充应用 ${applied} 条`);
      } catch (error) {
        noteLine(`手工补充表读取失败: ${error && error.message ? error.message : error}`);
      }
    } else {
      noteLine(`（暂无手工补充表 ${extraPath}）`);
    }
    const payload = { bySid: Object.fromEntries(merged), source: 'catalog+qq+manual', exportedAt: Date.now() / 1000 };
    const numbers = [...merged.keys()].filter((key) => /^\d+$/.test(key)).map(Number).sort((a, b) => a - b);
    if (printOnly) {
      say(JSON.stringify(payload, null, 2));
      noteLine(`（预演：未写入 ${outFile}；共 ${merged.size} 条，编号范围 ${numbers[0] ?? '-'} - ${numbers.at(-1) ?? '-'}）`);
      return 0;
    }
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 0), 'utf8');
    okLine(`已导出 ${merged.size} 条 -> ${outFile}（编号范围 ${numbers[0] ?? '-'} - ${numbers.at(-1) ?? '-'}）`);
    noteLine('提示：onebot.js 的表情名补丁读取该文件，改完需重启服务。');
    return 0;
  } finally {
    if (tmpDir) cleanupTmp(tmpDir);
  }
}

function cleanupTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ─────────────────────────── deploy 子命令（原 deploy_qq_agent.sh） ───────────────────────────

async function cmdDeploy(args) {
  if (wantsHelp(args)) { say(HELP.deploy); return 0; }
  if (isContainerRuntime()) { badWarn(containerUpdateHint()); return 1; }
  const cfg = config({ dir: optValue(args, '--root-dir', null) });
  const srcDir = path.resolve(optValue(args, '--dir', envStr('QQ_AGENT_SRC_DIR', path.join(os.homedir(), 'qq-agent-src'))));
  const image = envStr('SNOWLUMA_IMAGE', SNOWLUMA_BASELINE_IMAGE);
  // 与 install.sh 全栈默认一致（3000/3001）；旧的 3390/3391 会让既有全栈安装
  // 在 check-stack-update 处被判成“OneBot 端点不一致”。
  const obHttp = envStr('QQ_AGENT_ONEBOT_HTTP_PORT', '3000');
  const obWs = envStr('QQ_AGENT_ONEBOT_WS_PORT', '3001');
  const baseUrl = envStr('QQ_AGENT_MODEL_BASE_URL');
  const model = envStr('QQ_AGENT_MODEL');
  const dryRun = hasFlag(args, '--dry-run');

  let key = envStr('QQ_AGENT_MODEL_API_KEY');
  const keyFile = envStr('QQ_AGENT_MODEL_KEY_FILE');
  if (!key && keyFile) {
    key = readFileSafe(keyFile).replace(/[\r\n]+/g, '');
    if (!key) noteLine(`（提示）读取 API Key 文件失败或为空: ${keyFile}`);
  }
  // 缺凭据只在"真的要部署"时才算失败：--dry-run 仍应能看清计划（否则在没有凭据的机器上预演都跑不了）。
  const missing = [];
  if (!key) missing.push('QQ_AGENT_MODEL_API_KEY（或 QQ_AGENT_MODEL_KEY_FILE）');
  if (!baseUrl || !model) missing.push('QQ_AGENT_MODEL_BASE_URL / QQ_AGENT_MODEL');
  const deployScript = path.join(srcDir, 'deploy-all.sh');
  const scriptArgs = ['deploy-all.sh', '-y', '--root-dir', cfg.rootDir, '--onebot-http-port', obHttp, '--onebot-ws-port', obWs, '--image', image];

  const plan = () => {
    noteLine(`源码目录: ${srcDir}`);
    noteLine(`部署根目录: ${cfg.rootDir}`);
    noteLine(`协议端镜像: ${image}`);
    noteLine(`OneBot 端口: HTTP ${obHttp} / WS ${obWs}`);
    noteLine(`模型: ${model || '(未设置)'} @ ${baseUrl || '(未设置)'}`);
    noteLine(`模型凭据: ${key ? '有（未打印）' : '缺失'}`);
  };
  if (dryRun) {
    say('部署预演（不会执行任何命令）:');
    plan();
    say(`  将执行: cd ${srcDir} && bash ${scriptArgs.join(' ')}`);
    if (missing.length) noteLine(`（预演）真实部署前需要补: ${missing.join('、')}`);
    return 0;
  }
  if (missing.length) {
    ngLine(`缺少必要配置: ${missing.join('、')}`);
    return 1;
  }
  if (!hasFlag(args, '--confirm')) {
    say('部署会修改服务与数据目录：请加 --confirm 执行（或 --dry-run 预演）');
    plan();
    return 1;
  }
  if (!exists(deployScript)) {
    ngLine(`找不到部署脚本: ${deployScript}（用 --dir= 指定已 clone 的源码目录）`);
    return 1;
  }
  plan();
  const id = run('id', ['-un']);
  if (!id.missing) {
    const groups = run('id', ['-nG']);
    noteLine(`当前用户: ${id.stdout.trim()}  分组含 docker: ${/\bdocker\b/.test(groups.stdout) ? 'yes' : 'no'}`);
  }
  const free = run('free', ['-m']);
  if (!free.missing && free.ok) {
    const mem = free.stdout.split('\n').find((line) => line.startsWith('Mem:'))?.trim().split(/\s+/) || [];
    noteLine(`可用内存: ${mem[6] ?? '-'} MB`);
  }
  const df = run('df', ['-h', '/']);
  if (!df.missing && df.ok) {
    const fields = (df.stdout.split('\n')[1] || '').trim().split(/\s+/);
    noteLine(`磁盘可用: ${fields[3] ?? '-'}`);
  }
  const bashProbe = run('bash', ['--version']);
  if (bashProbe.missing) {
    ngLine('本机缺少 bash（deploy-all.sh 需要 bash）');
    return 1;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  // 模型 Key 不进子进程环境（/proc/<pid>/environ 能读到）：写一个 0600 临时文件，
  // 由 deploy-all.sh 按 QQ_AGENT_MODEL_KEY_FILE 读进去（它自己还会再转到 0600 文件给部署步骤）。
  let modelKeyDir = '';
  const childEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: envStr('XDG_RUNTIME_DIR', `/run/user/${uid}`),
    LANG: envStr('LANG', 'C.UTF-8'),
    QQ_AGENT_MODEL_BASE_URL: baseUrl,
    QQ_AGENT_MODEL: model
  };
  delete childEnv.QQ_AGENT_MODEL_API_KEY;
  if (key) {
    modelKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-model-key-'));
    const keyFile = path.join(modelKeyDir, 'model-key');
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    childEnv.QQ_AGENT_MODEL_KEY_FILE = keyFile;
  }
  say();
  const child = spawn('bash', scriptArgs, { cwd: srcDir, stdio: 'inherit', env: childEnv, windowsHide: true });
  const exitCode = await new Promise((resolve) => {
    child.on('error', (error) => {
      ngLine(`无法启动部署脚本: ${error && error.message ? error.message : error}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (modelKeyDir) {
    try { fs.rmSync(modelKeyDir, { recursive: true, force: true }); } catch { /* 残留只是空目录+旧 key 文件，下次覆盖 */ }
  }
  return exitCode;
}

// ─────────────────────────── console 子命令（原 qq-console.bat） ───────────────────────────

function sshTarget() {
  const sshSpec = envStr('QQ_AGENT_SSH');
  let host = envStr('SSHHOST');
  let user = envStr('SSHUSER', 'ubuntu');
  // 允许 SSHHOST / QQ_AGENT_SSH 写成 user@host（旧 bat 的写法）。
  if (host && host.includes('@')) {
    const [specUser, specHost] = host.split('@');
    if (specUser) user = specUser;
    host = specHost;
  }
  if (!host && sshSpec) {
    if (sshSpec.includes('@')) {
      const [specUser, specHost] = sshSpec.split('@');
      user = specUser || user;
      host = specHost;
    } else host = sshSpec;
  }
  return {
    host,
    user,
    port: envStr('SSHPORT', '22'),
    consolePort: envStr('QQ_AGENT_CONSOLE_PORT', '3210'),
    webuiPort: envStr('QQ_AGENT_WEBUI_PORT', '5099'),
    vncPort: envStr('QQ_AGENT_VNC_PORT', '6081'),
    token: envStr('QQ_AGENT_CONSOLE_TOKEN')
  };
}

async function waitForUrl(url, timeoutSec, child) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return { ready: false, exited: true };
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { ready: true, exited: false };
    } catch {
      await sleep(1000);
    }
  }
  return { ready: false, exited: false };
}

function openBrowser(url) {
  const command = IS_WINDOWS ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  // cmd.exe 把 & | ^ < > " 当元字符，而 Node 只对含空格/制表符的参数加引号 —— URL 里
  // 带控制台令牌时，`/c start "" http://…?token=a&<命令>` 会被当命令分隔符执行本地命令
  // （2026-10-09 审查）。控制台自己轮换的令牌不含这些字符，但运维注入的令牌可能：
  // 拒绝并让用户手动复制，别赌。
  // 2026-10-09 复核补两个：`%VAR%` 在 cmd 里会展开，而展开结果里的元字符会被重新解析
  //（实测 `set X=^&calc` 再 `echo %X%` 真的会执行 calc），`!` 是延迟展开的同一类风险；
  // CR/LF/TAB 则直接断行。代价是含 `%` 的合法 URL（如已编码的 `%20`）也会被拒 —— 只影响
  // "自动打开"这一步（提示里让人手动复制，不阻断任何东西），所以宁可保守。
  if (IS_WINDOWS && /["&|^<>%!\r\n\t]/.test(String(url))) {
    noteLine('（地址里含有 cmd 不接受的字符，为安全起见未自动打开；请手动复制到浏览器）');
    return;
  }
  const openArgs = IS_WINDOWS ? ['/c', 'start', '', url] : [url];
  const result = run(command, openArgs, { timeout: 10000 });
  if (result.missing) noteLine(`（未找到打开浏览器的命令，请手动访问 ${url}）`);
}

/**
 * 现场读服务器上的 deployment-access.txt，打印"登进去要用"的凭据。
 *
 * 为什么在这里：只给 URL 不给密码，用户打开 SnowLuma WebUI 会卡在登录页 ——
 * 而那份文件是部署脚本写的（0600），密码只有它和 compose 的 .env 里有。
 * 读不到就静默跳过（不打扰正常流程），也不打印 OneBot/控制台令牌（控制台里能看/改）。
 */
function printRemoteCredentials(target) {
  const cmd = 'for f in /mnt/data/qq-agent/deployment-access.txt /data/qq-agent/deployment-access.txt; '
    + 'do if [ -f "$f" ]; then grep -E "^(SnowLuma password|noVNC password): " "$f"; break; fi; done';
  const res = run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', target.port,
    `${target.user}@${target.host}`, cmd], { timeout: 15000 });
  const lines = String(res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  noteLine('（来自服务器上的 deployment-access.txt）');
  for (const line of lines) {
    noteLine(line.startsWith('SnowLuma') ? `  ${line}　← SnowLuma WebUI 登录用（账号固定 admin，只要密码）` : `  ${line}　← QQ 扫码/远程桌面用`);
  }
}

async function cmdConsole(args) {
  if (wantsHelp(args)) { say(HELP.console); return 0; }
  const target = sshTarget();
  if (!target.host) {
    ngLine('请设置 SSHHOST=user@host（或 QQ_AGENT_SSH=user@host）');
    return 1;
  }
  const consoleUrl = `http://127.0.0.1:${target.consolePort}/${target.token ? `?token=${encodeURIComponent(target.token)}` : ''}`;
  const sshArgs = [
    '-N',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-o', 'ExitOnForwardFailure=yes',
    '-p', target.port,
    '-L', `${target.consolePort}:127.0.0.1:${target.consolePort}`,
    '-L', `${target.webuiPort}:127.0.0.1:${target.webuiPort}`,
    '-L', `${target.vncPort}:127.0.0.1:${target.vncPort}`,
    `${target.user}@${target.host}`
  ];
  if (hasFlag(args, '--print')) {
    say(`ssh ${sshArgs.join(' ')}`);
    noteLine(`QQ Agent 控制台 ....... http://127.0.0.1:${target.consolePort}`);
    noteLine(`SnowLuma WebUI ........ http://127.0.0.1:${target.webuiPort}`);
    noteLine(`QQ 远程桌面 / 扫码 .... http://127.0.0.1:${target.vncPort}`);
    printRemoteCredentials(target);
    noteLine(`控制台 URL（已带 token 时为免登录）: ${consoleUrl}`);
    return 0;
  }
  const sshProbe = run('ssh', ['-V'], { timeout: 8000 });
  if (sshProbe.missing) {
    ngLine('本机缺少 ssh 命令（Windows 10+ 可在“可选功能”里安装 OpenSSH 客户端）');
    return 1;
  }
  say('============================================================');
  say(`  QQ Agent 控制台（通过 SSH 隧道访问 ${target.user}@${target.host}）`);
  say('============================================================');
  say();
  say('正在建立 SSH 隧道（需已配置密钥登录）...');
  say(`  QQ Agent 控制台 ....... http://127.0.0.1:${target.consolePort}`);
  say(`  SnowLuma WebUI ........ http://127.0.0.1:${target.webuiPort}`);
  say(`  QQ 远程桌面 / 扫码 .... http://127.0.0.1:${target.vncPort}`);
  printRemoteCredentials(target);
  say();
  say('关闭本窗口 / Ctrl+C = 断开隧道；服务器上的机器人照常运行。');
  if (!target.token) say('（未设置 QQ_AGENT_CONSOLE_TOKEN，打开控制台后需手动登录）');
  say();
  const child = spawn('ssh', sshArgs, { stdio: 'inherit', windowsHide: true });
  let childError = '';
  child.on('error', (error) => { childError = error && error.message ? error.message : String(error); });
  const timeoutSec = Math.max(1, numOpt(args, '--timeout', 45));
  const ready = await waitForUrl(consoleUrl, timeoutSec, child);
  if (ready.exited || childError) {
    ngLine(`SSH 隧道已退出${childError ? `：${childError}` : ''}。可能原因：网络不通 / SSH 密钥失效 / 地址或端口不对。`);
    return 1;
  }
  if (!ready.ready) {
    ngLine(`${timeoutSec} 秒内没能连上控制台。可在另一个窗口手动试: ssh ${target.user}@${target.host}`);
    try { child.kill(); } catch { /* 忽略 */ }
    return 1;
  }
  okLine(`隧道就绪（控制台 ${consoleUrl}）`);
  if (hasFlag(args, '--open')) openBrowser(consoleUrl);
  say('隧道保持中；按 Ctrl+C 断开。');
  return await new Promise((resolve) => {
    const onSignal = () => {
      try { child.kill('SIGINT'); } catch { /* 忽略 */ }
      resolve(0);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 0));
  });
}

// ───────────────────────── 协议端（SnowLuma）版本与更新子命令 ─────────────────────────
// 这两个命令是"控制台一键更新协议端"的同一实现（控制台走 core/snowluma-update.js 的
// SnowlumaUpdater，命令行走这里），运维排查时可以直接在服务器上跑。
function makeSnowlumaUpdater(args) {
  const cfg = config({ dir: optValue(args, '--root-dir', null) });
  return {
    cfg,
    updater: createSnowlumaUpdater({
      composeDir: cfg.snowlumaDir,
      container: cfg.snowlumaContainer,
      webuiPort: Number(cfg.webuiPort) || 5099,
      log: (line) => infoWarn(line)
    })
  };
}

async function cmdSnowlumaVersion(args) {
  if (wantsHelp(args)) { say(HELP['snowluma-version']); return 0; }
  const { updater } = makeSnowlumaUpdater(args);
  const st = await updater.status();
  if (!st.installed) {
    badWarn(`没找到协议端 compose 项目：${st.composeDir}/.env 不存在（这台机器可能没装协议端）`);
    return 1;
  }
  say(`协议端 compose 目录: ${st.composeDir}`);
  say(`容器: ${st.container}（${st.running ? '运行中' : `状态 ${st.runningState || '未知'}`}）`);
  say(`当前镜像: ${st.currentImage || '(未知)'}${st.currentVersion ? `（版本 ${st.currentVersion}）` : ''}`);
  say(`目标镜像: ${st.targetImage || '(未知)'}${st.targetVersion ? `（版本 ${st.targetVersion}）` : ''}`);
  if (st.outdated) {
    badWarn(`协议端落后于项目基线 ${st.targetVersion}：控制台「设置 → OneBot」页可一键更新（或跑 snowluma-update）`);
  } else if (st.belowRecommended) {
    badWarn(`协议端低于推荐版本 ${st.minRecommended}（贴纸会显示成图片）—— 建议升级`);
  } else {
    okWarn('协议端版本不落后');
  }
  return 0;
}

async function cmdSnowlumaUpdate(args) {
  if (wantsHelp(args)) { say(HELP['snowluma-update']); return 0; }
  // 容器里没有宿主 docker 套接字，也没有协议端 compose 项目可改；更新只能换镜像。
  if (isContainerRuntime()) {
    badWarn(containerUpdateHint());
    return 1;
  }
  const { updater } = makeSnowlumaUpdater(args);
  const to = optValue(args, '--to', '');
  const dryRun = hasFlag(args, '--dry-run');
  const st = await updater.status();
  if (!st.installed) {
    badWarn(`没找到协议端 compose 项目：${st.composeDir}/.env 不存在`);
    return 1;
  }
  if (dryRun) {
    const plan = await updater.update({ to, dryRun: true });
    say(`[dry-run] ${plan.envChange}`);
    say(`[dry-run] 步骤: ${(plan.steps || []).map((s) => `${s.cmd} ${s.args.join(' ')}`).join(' → ')}`);
    say('（dry-run 不写 .env、不动容器）');
    return 0;
  }
  if (!st.outdated && !to) {
    okWarn(`协议端已经是最新（${st.currentVersion}），无需更新。`
      + `要重建容器请手工执行：docker compose --project-directory <协议端目录> up -d --force-recreate`);
    return 0;
  }
  infoWarn(`开始更新协议端：${st.currentVersion || st.currentImage} → ${to || st.targetVersion || st.targetImage}`);
  const res = await updater.update({ to });
  for (const line of res.log || []) say(`  · ${line}`);
  if (res.ok) {
    okWarn(`协议端已更新到 ${res.to}（等待就绪 ${Math.round((res.waitedMs || 0) / 1000)}s；备份 ${res.backupDir}）`);
    return 0;
  }
  badWarn(`更新失败：${res.error}${res.rolledBack ? '（已自动回滚到旧镜像）' : res.restored ? '（.env 已还原）' : ''}`);
  return 1;
}

// ─────────────────────────── health-check 子命令（改进方案 C8/#7） ───────────────────────────
/**
 * 巡检 / 诊断共用的现场解析：从 data/config.json + 环境变量拼出 runHealthCheck 参数。
 * 抽出来是因为 doctor 也要跑同一套巡检 —— 两处各抄一份迟早会漂移。
 */
function healthCheckContext(cfgBase, dataDir) {
  // 没有配置＝按默认端口探测
  const cfg = loadConfigJson(dataDir) || {};
  const onebotToken = String(cfg.onebot?.httpAccessToken || cfg.onebot?.accessToken || '');
  const onebotHttpPort = Number(intEnv('QQ_AGENT_ONEBOT_HTTP_PORT', Number(cfg.onebot?.httpPort) || Number(cfgBase.onebotPort) || 3390));
  // 容器/声明式部署里配置写的是完整 URL（snowluma:3000）；只传端口会去探 127.0.0.1。
  let onebotHttpUrl = String(cfg.onebot?.httpUrl || '').trim();
  if (!onebotHttpUrl) {
    try {
      const parsed = new URL(`http://127.0.0.1:${onebotHttpPort}`);
      onebotHttpUrl = parsed.href.replace(/\/+$/, '');
    } catch { onebotHttpUrl = ''; }
  }
  return {
    cfg,
    onebotToken,
    onebotHttpPort,
    onebotHttpUrl,
    ownerUin: readOwnerUin(cfg),
    options: {
      dataDir,
      mode: String(cfg.runtime?.mode || 'active'),
      consolePort: Number(cfg.server?.port) || Number(cfgBase.consolePort) || 3210,
      onebotHttpPort,
      onebotHttpUrl,
      onebotToken,
      containerRuntime: isContainerRuntime(),
      snowlumaDir: cfgBase.snowlumaDir,
      // NNP 探测用（2026-10-09 审查）：主进程被加固时 sudo 回退必失败，巡检不能拿它当"能用"
      service: cfgBase.service
    }
  };
}

async function cmdHealthCheck(args) {
  if (wantsHelp(args)) { say(HELP['health-check']); return 0; }
  // 路径口径必须与 backup / install-timers 一致（走 config()）：手写 os.homedir() 回退在
  // systemd 定时器里会落到 ~/qq-agent/data，读不到部署的 messages.sqlite —— 2026-09-30
  // 实机复现过（unit 首次运行即 FAILURE），已改回 config({})。
  const cfgBase = config({});
  const dataDir = cfgBase.dataDir;
  const ctx = healthCheckContext(cfgBase, dataDir);
  const result = await runHealthCheck({
    ...ctx.options,
    // 破坏性操作显式确认的同一口径：--confirm 才允许真的发 QQ 通知，--print/无参只巡检
    notify: hasFlag(args, '--confirm') && ctx.ownerUin
      ? (text) => sendOwnerText({ httpPort: ctx.onebotHttpPort, httpUrl: ctx.onebotHttpUrl, token: ctx.onebotToken, ownerUin: ctx.ownerUin, text })
      : null
  });
  say(JSON.stringify({ healthy: result.healthy, notified: result.notified, checks: result.checks }, null, 2));
  return result.code;
}

/**
 * 一键诊断包：巡检结果 + 脱敏配置 + 存储占用 + 插件清单 + 异常台账 + 最近日志。
 * 只读；不写业务数据、不重启服务。退出码沿用巡检结果（0=健康 / 1=有失败项）。
 */
async function cmdDoctor(args) {
  if (wantsHelp(args)) { say(HELP.doctor); return 0; }
  const cfgBase = config({});
  const dataDir = cfgBase.dataDir;
  const ctx = healthCheckContext(cfgBase, dataDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 容器里 /app 是只读的：默认写到数据目录（/data 可写），避免 doctor 在 Docker 部署上
  // 打印“生成失败”。显式 --out 仍优先。
  const defaultDir = (() => {
    try { fs.accessSync(process.cwd(), fs.constants.W_OK); return process.cwd(); }
    catch { return dataDir; }
  })();
  const outFile = String(optValue(args, '--out', '') || path.join(defaultDir, `qq-agent-diagnose-${stamp}.tar.gz`));

  let health = null;
  if (!hasFlag(args, '--no-health')) {
    // persist:false：doctor 是只读命令，不能顺手把 data/health.json 的"最近一次巡检"改掉
    health = await runHealthCheck({ ...ctx.options, notify: null, persist: false });
  }

  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8')).version || ''; } catch { /* ignore */ }
  let revision = '';
  try { revision = fs.readFileSync(path.join(dataDir, 'deployed-revision'), 'utf8').trim(); } catch { /* ignore */ }

  const data = {
    manifest: {
      generatedAt: new Date().toISOString(),
      version,
      revision,
      node: process.version,
      platform: `${process.platform} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1048576),
      uptimeSec: Math.round(os.uptime()),
      dataDir
    },
    config: redactedConfig(dataDir),
    health: health ? { healthy: health.healthy, checks: health.checks } : { skipped: true },
    storage: { breakdown: storageBreakdown(dataDir), sessions: sessionStorage(dataDir) },
    plugins: pluginSummary(dataDir),
    incidents: incidentSummary(dataDir),
    effects: effectSummary(dataDir),
    logs: logTail({ dataDir, service: ctx.options.service, lines: 300 })
  };
  const written = writeDiagnoseArchive(outFile, buildDiagnoseEntries(data));

  if (!written.ok) {
    say('诊断包生成失败：没有可写的输出位置。');
    say(`  原因  ${written.error || '未知'}`);
    say(`  兜底  ${written.path || '（无）'}`);
    return 1;
  }

  const mb = (bytes) => `${(Number(bytes) / 1048576).toFixed(1)}MB`;
  say('诊断包已生成（配置已脱敏、日志按现有规则过滤令牌）：');
  say(`  路径  ${written.path}${written.method === 'dir' ? '（目录形态：本机没有可用 tar）' : ''}`);
  say(`  版本  ${version || '未知'}${revision ? ` · ${String(revision).slice(0, 12)}` : ''} · Node ${process.version}`);
  if (health) {
    const failed = (health.checks || []).filter((item) => item?.ok === false);
    say(`  巡检  ${failed.length
      ? `${failed.length} 项失败：${failed.map((item) => item.name || item.id || '未命名').slice(0, 5).join('、')}`
      : '全部通过'}`);
  } else {
    say('  巡检  已跳过（--no-health）');
  }
  const sessions = data.storage.sessions;
  if (sessions) say(`  留档  ${sessions.files} 个 / ${mb(sessions.bytes)}（已压缩 ${sessions.compressed} 个）`);
  else say('  留档  （目录读不到，已跳过）');
  const installed = (data.plugins || []).filter((item) => !item.broken).length;
  const broken = (data.plugins || []).filter((item) => item.broken).length;
  const incidentText = !data.incidents
    ? '无'
    : (data.incidents.unavailable ? '读取失败（包内已记录原因）' : '已包含');
  say(`  插件  ${installed} 个${broken ? `（${broken} 个清单损坏）` : ''} · 异常台账 ${incidentText}`);
  const effects = data.effects;
  if (effects?.unavailable) {
    say(`  账本  读取失败：${effects.reason || '未知原因'}（包内 effects.json 有记录）`);
  } else if (effects) {
    say(`  账本  ${effects.total} 条（unknown ${effects.counts?.unknown || 0}，近 24h ${effects.unknownRecent}）`);
  } else {
    say('  账本  （旧数据目录没有 effects 表，跳过）');
  }
  say('');
  say('把这个文件附到 issue 里即可；里面不含配置里的 Key/Token（第三方插件自己打印的内容除外）。');
  return health ? (health.healthy ? 0 : 1) : 0;
}

/**
 * 账本改判后同步 outbox：日报/游戏终局的发送把 run_id 记成 effect id，
 * 只改 effects 表会让会话一直处于 held（2026-10-31 审查 P2）。
 * 语义与 console 的 unknown-operations/reconcile 保持一致。
 * @returns {number} 同步的 outbox 行数
 */
function reconcileEffectOutbox(db, effectId, result) {
  const rows = db.prepare(`SELECT id, run_id AS runId, chat_key AS chatKey FROM outbox
    WHERE run_id=? AND state IN ('sending','unknown')`).all(String(effectId));
  if (!rows.length) return 0;
  const state = result === 'sent' ? 'reconciled_sent' : 'reconciled_failed';
  const error = result === 'sent' ? '管理员确认已发送' : '管理员确认未发送';
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('UPDATE outbox SET state=?, error=? WHERE id=?');
    for (const row of rows) changed += Number(update.run(state, error, row.id).changes) || 0;
    const groups = new Map();
    for (const row of rows) groups.set(`${row.chatKey}
${row.runId}`, row);
    for (const row of groups.values()) {
      const remaining = Number(db.prepare(`SELECT COUNT(*) AS count FROM outbox
        WHERE run_id=? AND state IN ('sending','unknown')`).get(row.runId).count) || 0;
      if (remaining !== 0) continue;
      db.prepare(`UPDATE messages SET state='acked', lease_id=NULL
        WHERE chat_key=? AND state='held' AND lease_id=?`).run(row.chatKey, row.runId);
      db.prepare(`UPDATE runs SET state='acked', error=? WHERE id=? AND state='held'`)
        .run('管理员已核对全部未知写入', row.runId);
      db.prepare(`DELETE FROM outbox WHERE run_id=? AND state IN ('reconciled_sent','reconciled_failed')`)
        .run(row.runId);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw error;
  }
  return changed;
}

/**
 * 出站副作用账本的人工核对入口（list / resolve）。
 * 只读写 messages.sqlite 的 effects 表；不补发、不撤回任何消息。
 */
function cmdEffects(args) {
  if (wantsHelp(args)) { say(HELP.effects); return 0; }
  const sub = String(args[0] || 'list');
  const cfg = config({ data: optValue(args, '--data', null) });
  const file = path.join(cfg.dataDir, 'messages.sqlite');
  if (!exists(file)) { say(`没有找到 ${file}`); return 1; }
  const db = openDatabase(file);
  try {
    // sweep:false：list 是只读操作，不能顺手把 planned 扫成 unknown
    const ledger = new EffectLedger(db, { sweep: false });
    if (sub === 'list') {
      const state = String(optValue(args, '--state', 'unknown') || 'unknown');
      const limit = Math.min(200, Math.max(1, intOpt(args, '--limit', 30)));
      const rows = ledger.list({ state, limit });
      say(`副作用账本（state=${state}，最多 ${limit} 条）：`);
      if (!rows.length) { say('（没有）'); return 0; }
      for (const row of rows) {
        const when = new Date(row.createdAt).toISOString().replace('T', ' ').slice(0, 19);
        const note = String(row.detail?.error || row.detail?.reason || row.detail?.staleReason || '').slice(0, 80);
        say(`  ${row.id}  ${row.kind}  ${row.chatKey || '-'}  ${when}  ${note}`);
      }
      say('');
      say('改判：node src/ops.js effects resolve <id> --sent|--failed --confirm');
      return 0;
    }
    if (sub === 'resolve') {
      const id = String(args[1] || '');
      const wantSent = hasFlag(args, '--sent');
      const wantFailed = hasFlag(args, '--failed');
      if (!id || wantSent === wantFailed) {
        say('用法: node src/ops.js effects resolve <id> --sent|--failed --confirm');
        return 2;
      }
      if (!hasFlag(args, '--confirm')) { say('改判需要显式 --confirm'); return 2; }
      const ok = ledger.resolve(id, wantSent ? 'sent' : 'failed', { reason: 'ops-resolve' });
      if (!ok) {
        say('没有改动（id 不存在，或不是 unknown 状态）');
        return 1;
      }
      const linked = reconcileEffectOutbox(db, id, wantSent ? 'sent' : 'failed');
      say(`已改判为 ${wantSent ? 'sent' : 'failed'}：${id}`
        + (linked ? `（已同步 ${linked} 条未知发送）` : ''));
      return 0;
    }
    say(`未知子命令: ${sub}`);
    say('用法: node src/ops.js effects list|resolve ...');
    return 2;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ─────────────────────────── install-timers 子命令（原 ops/systemd/） ───────────────────────────

function unitFiles(cfg) {
  const nodeBin = process.execPath;
  const opsPath = path.join(REPO_DIR, 'src', 'ops.js');
  const serviceName = cfg.service;
  const backupService = `[Unit]
# QQ Agent 数据目录每周备份（由 qq-agent-backup.timer 触发）。
# 由 node src/ops.js install-timers 生成；路径按实际部署改。
Description=QQ Agent data weekly backup

[Service]
Type=oneshot
# 显式带路径：ops.js 的默认值可能与本机部署不一致（本单元要在无人值守下自足）。
# 2026-10-01 审查：这五行原先是注释，于是自定义部署下备份会打包错误的目录、
# 停错服务（QQ_AGENT_SERVICE 默认 qq-agent-linux.service）；备份会停服务再拉起，
# 打错目录 / 停错服务都是数据安全事故，不是"参数没给全"。
Environment="QQ_AGENT_DIR=${cfg.rootDir}"
Environment="QQ_AGENT_DATA_DIR=${cfg.dataDir}"
Environment="QQ_AGENT_BACKUP_DIR=${cfg.backupDir}"
Environment="QQ_AGENT_SERVICE=${serviceName}"
Environment="QQ_AGENT_KEEP=${cfg.keep}"
ExecStart=${nodeBin} ${opsPath} backup --confirm
`;
  const backupTimer = `[Unit]
# 每周日凌晨 4:10 备份一次数据目录；关机错过会在下次开机补跑（Persistent=true）。
Description=Weekly QQ Agent data backup (Sun 04:10)

[Timer]
OnCalendar=Sun *-*-* 04:10:00
Persistent=true
Unit=qq-agent-backup.service

[Install]
WantedBy=timers.target
`;
  const backupDrillService = `[Unit]
# 每月恢复演练：解密最近一份备份到临时目录 + SQLite integrity_check。
# 不碰生产数据；密钥必须放在文件里（unit 不带 QQ_AGENT_BACKUP_KEY 环境变量）。
Description=QQ Agent backup restore drill

[Service]
Type=oneshot
Environment="QQ_AGENT_DATA_DIR=${cfg.dataDir}"
Environment="QQ_AGENT_BACKUP_DIR=${cfg.backupDir}"
Environment="QQ_AGENT_BACKUP_KEY_FILE=${envStr('QQ_AGENT_BACKUP_KEY_FILE', path.join(os.homedir(), '.config', 'qq-agent', 'backup.key'))}"
ExecStart=${nodeBin} ${opsPath} backup --drill
`;
  const backupDrillTimer = `[Unit]
# 每月 1 日 05:10 演练一次（排在 04:10 的每周备份之后）。
Description=Monthly QQ Agent backup restore drill (1st 05:10)

[Timer]
OnCalendar=*-*-01 05:10:00
Persistent=true
Unit=qq-agent-backup-drill.service

[Install]
WantedBy=timers.target
`;
  const guardService = `[Unit]
# 进程看门狗：用户进程数异常增长（脚本失控递归）时清理并记录。
# 由 node src/ops.js install-timers 生成；路径按实际部署改。
Description=Watchdog: kill runaway process trees in a user account

[Service]
Type=oneshot
ExecStart=${nodeBin} ${opsPath} guard --confirm
# 需要盯别的用户/改阈值时打开（默认盯当前用户、阈值 800）：
# Environment=QQ_AGENT_GUARD_USER=${cfg.guardUser}
# Environment=QQ_AGENT_PROC_LIMIT=${intEnv('QQ_AGENT_PROC_LIMIT', 800)}
`;
  const guardTimer = `[Unit]
# 每 10 分钟跑一次进程看门狗（首次在开机 3 分钟后）。
Description=Run process watchdog every 10 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
AccuracySec=1min

[Install]
WantedBy=timers.target
`;
  const healthService = `[Unit]
# 每 5 分钟巡检一次 Agent 健康（改进方案 C8/#7）：控制台/OneBot/入站处理水位/磁盘/
# 自动更新状态/部署中断标记/sqlite 完整性；连续 3 次失败才给管理员发 QQ 私聊。
# 由 node src/ops.js install-timers 生成；路径按实际部署改。
Description=QQ Agent health probe

[Service]
Type=oneshot
# 显式带路径：ops.js 的默认值可能与本机部署不一致（本单元要在无人值守下自足）。
# QQ_AGENT_SERVICE 决定加固探测（NoNewPrivileges / umask）检查的是哪个 unit —— 自定义
# 部署下漏了这个变量会去探测默认 unit 名，巡检把错误的 unit 判成"未加固"（2026-10-12 审查）。
Environment="QQ_AGENT_DIR=${cfg.rootDir}"
Environment="QQ_AGENT_DATA_DIR=${cfg.dataDir}"
Environment="QQ_AGENT_ONEBOT_HTTP_PORT=${cfg.onebotPort}"
Environment="QQ_AGENT_SERVICE=${serviceName}"
ExecStart=${nodeBin} ${opsPath} health-check --confirm
`;
  const healthTimer = `[Unit]
# 每 5 分钟巡检一次（首次在开机 5 分钟后）；关机错过会在下次开机补跑。
Description=Run QQ Agent health probe every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=1min

[Install]
WantedBy=timers.target
`;
  const auditPruneService = `[Unit]
# 审计日志清理（改进方案 #5）：删除超过保留月数的 data/audit-log/audit-YYYYMM.jsonl。
# 由 node src/ops.js install-timers 生成；路径按实际部署改。
Description=QQ Agent audit log prune

[Service]
Type=oneshot
# ops.js 的默认值可能与本机部署不一致（本单元要在无人值守下自足）
Environment="QQ_AGENT_DATA_DIR=${cfg.dataDir}"
ExecStart=${nodeBin} ${opsPath} audit-prune --confirm
`;
  const auditPruneTimer = `[Unit]
# 每月 1 日 04:20 清理一次（排在 backup 之后）；关机错过会在下次开机补跑。
Description=Monthly QQ Agent audit log prune (1st 04:20)

[Timer]
OnCalendar=*-*-01 04:20:00
Persistent=true
Unit=qq-agent-audit-prune.service

[Install]
WantedBy=timers.target
`;
  return [
    ['qq-agent-backup.service', backupService],
    ['qq-agent-backup.timer', backupTimer],
    ['qq-agent-backup-drill.service', backupDrillService],
    ['qq-agent-backup-drill.timer', backupDrillTimer],
    ['process-guard.service', guardService],
    ['process-guard.timer', guardTimer],
    ['qq-agent-health.service', healthService],
    ['qq-agent-health.timer', healthTimer],
    ['qq-agent-audit-prune.service', auditPruneService],
    ['qq-agent-audit-prune.timer', auditPruneTimer]
  ];
}

function cmdInstallTimers(args) {
  if (wantsHelp(args)) { say(HELP['install-timers']); return 0; }
  if (isContainerRuntime()) { badWarn(containerUpdateHint()); return 1; }
  const cfg = config({});
  const unitDir = envStr('QQ_AGENT_SYSTEMD_DIR', path.join(os.homedir(), '.config', 'systemd', 'user'));
  const units = unitFiles(cfg);
  if (hasFlag(args, '--print')) {
    say('以下单元将安装到 ' + unitDir + '（未写盘）：');
    for (const [name, content] of units) {
      say();
      say(`──────── ${name} ────────`);
      say(content.replace(/\n$/, ''));
    }
    return 0;
  }
  if (!hasFlag(args, '--confirm')) {
    ngLine(`安装定时器会写入 ${unitDir} 并执行 systemctl --user enable --now：请加 --confirm（或 --print 预演）`);
    return 1;
  }
  try {
    fs.mkdirSync(unitDir, { recursive: true });
    for (const [name, content] of units) {
      const file = path.join(unitDir, name);
      fs.writeFileSync(file, content, 'utf8');
      okLine(`已写入 ${file}`);
    }
  } catch (error) {
    ngLine(`写入单元文件失败: ${error && error.message ? error.message : error}`);
    return 1;
  }
  const reload = systemctlUser(['daemon-reload']);
  if (reload.missing) {
    skipLine('缺少 systemctl：请手动执行 systemctl --user daemon-reload && systemctl --user enable --now qq-agent-backup.timer process-guard.timer qq-agent-health.timer qq-agent-audit-prune.timer');
    return 0;
  }
  if (!reload.ok) ngLine(`daemon-reload 失败: ${text(reload)}`);
  const reloadOk = reload.ok;
  const enable = systemctlUser(['enable', '--now', 'qq-agent-backup.timer', 'process-guard.timer', 'qq-agent-health.timer', 'qq-agent-audit-prune.timer'], { timeout: 60000 });
  if (enable.ok) okLine('定时器已启用：qq-agent-backup.timer（每周日 04:10）、process-guard.timer（每 10 分钟）、qq-agent-health.timer（每 5 分钟巡检）、qq-agent-audit-prune.timer（每月 1 日 04:20 清理审计日志）');
  else ngLine(`启用定时器失败: ${text(enable)}`);
  // 挂在部署链上时退出 0 等于告诉 systemd"成功"，而四个定时器其实一个都没起来（2026-10-03 全量审查）
  return reloadOk && enable.ok ? 0 : 1;
}

// ───────────────────────────────── audit-prune ─────────────────────────────────

function cmdAuditPrune(args) {
  if (wantsHelp(args)) { say(HELP['audit-prune']); return 0; }
  // --data 必须解析：help 与 docs/OPS.md 都写了 `--data=目录`，同类子命令也都透传
  // （backup/deploy/install-timers）；漏掉会让 `--data=/other` 静默去删**默认**数据目录的
  // 审计文件（2026-09-30 审查 P2）。
  const cfg = config({ data: optValue(args, '--data', null) });
  const keepMonths = Math.max(1, intOpt(args, '--keep-months', 6));
  const dryRun = hasFlag(args, '--dry-run');
  const dir = path.join(cfg.dataDir, 'audit-log');
  if (!dryRun && !hasFlag(args, '--confirm')) {
    ngLine(`audit-prune 会删除 ${dir} 下超过保留月数的审计文件：请加 --confirm（或 --dry-run 预演）`);
    return 1;
  }
  const r = pruneAudit({ dir, keepMonths, dryRun });
  noteLine(`目录: ${r.dir}`);
  for (const name of r.kept) noteLine(`保留 ${name}`);
  for (const name of r.removed) noteLine(`${dryRun ? '将删除' : '已删除'} ${name}`);
  if (!r.kept.length && !r.removed.length) noteLine('没有审计文件，无需处理');
  okLine(dryRun
    ? `预演完成（未删任何文件）：将删除 ${r.removed.length} 个，保留 ${r.kept.length} 个`
    : `审计清理完成：删除 ${r.removed.length} 个，保留 ${r.kept.length} 个（保留 ${keepMonths} 个月）`);
  return 0;
}

// ───────────────────────────────── plugins ─────────────────────────────────

/**
 * 插件子命令组。做的是"不用打开控制台也能装/看/停"这件事，重点是 `install <文件>`：
 * 别人发你一个 `.tar.gz`、或者你自己刚 `plugin-pack` 出来一个，这是最短的一条路
 * （控制台的"手动安装"要一个公开 URL + 手填 sha256，拷目录要 SSH 权限）。
 *
 * 本地文件安装的口径：**sha256 是算出来给你核对的**，不是要你提供 —— 内容就是身份。
 * 装完来源记录里写"本地文件：<文件名>"，控制台「已安装」里能看到。
 */
async function cmdPlugins(args) {
  const sub = args.find((a) => !a.startsWith('-')) || '';
  if (wantsHelp(args) || !sub) { say(HELP.plugins); return sub ? 0 : 2; }
  const cfg = config({ data: optValue(args, '--data', null) });

  if (sub === 'list') {
    const root = path.join(cfg.dataDir, 'plugins');
    let names = [];
    try { names = fs.readdirSync(root).filter((name) => !name.startsWith('.')); } catch { /* 还没装过 */ }
    if (!names.length) { noteLine(`数据目录 ${cfg.dataDir} 下没有插件`); return 0; }
    section('已装插件');
    for (const name of names) {
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(root, name, 'plugin.json'), 'utf8')); } catch { /* 坏包 */ }
      const info = readPluginInstallInfo({ dataDir: cfg.dataDir, id: name });
      noteLine(`${name}${manifest ? ` v${manifest.version}` : '（plugin.json 读不了）'}`
        + `｜能力 ${(manifest?.capabilities || []).join('/') || '?'}`
        + `｜来源 ${info ? [info.source, info.publisher ? `${info.publisher}${info.signatureVerified ? '（签名已验证）' : '（未验证）'}` : ''].filter(Boolean).join(' ') : '（没有来源记录）'}`);
    }
    const enabledIds = readPluginEnabledIds(cfg);
    noteLine(`授权（会真跑）的：${enabledIds.length ? enabledIds.join(', ') : '（一个都没有——装上 ≠ 授权）'}`);
    return 0;
  }

  if (sub === 'uninstall') {
    // 只把真正的子命令后的位置参数当 id：--data 的值不能混进来（支持 --data=目录 与 --data 目录 两种写法）
    const positional = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--data') { i += 1; continue; }
      if (arg.startsWith('-')) continue;
      positional.push(arg);
    }
    const id = positional[1] || '';
    if (!id) { ngLine('要指定插件 id：node src/ops.js plugins uninstall <id> --confirm [--purge-data]'); return 2; }
    const purgeData = hasFlag(args, '--purge-data');
    const target = path.join(cfg.dataDir, 'plugins', id);
    if (!fs.existsSync(target)) { ngLine(`没有装着 ${id}（${target}）`); return 1; }
    noteLine(`卸载 ${id}：代码目录会移走，插件数据${purgeData ? '与凭据会一并删除' : '保留（重装后还能接着用）'}`);
    if (hasFlag(args, '--dry-run')) return 0;
    if (!hasFlag(args, '--confirm')) {
      ngLine('这会移除插件代码：请加 --confirm 执行（或 --dry-run 只预览）');
      return 1;
    }
    try {
      const result = uninstallPlugin({ id, dataDir: cfg.dataDir, purgeData });
      okLine(`已卸载 ${result.id}`);
      noteLine(`代码移到了 ${result.removedDir}（只留最近一份，巡检会清理）`);
      noteLine(result.dataPurged ? '插件数据与凭据已删除' : `插件数据保留在 ${result.dataKept}`);
      return 0;
    } catch (error) {
      ngLine(`卸载失败：${error?.message ?? error}${error?.code ? `（${error.code}）` : ''}`);
      return 1;
    }
  }

  if (sub === 'install') {
    const diffFlag = args.indexOf('--expect-diff');
    const expectedDiffHash = diffFlag >= 0 ? String(args[diffFlag + 1] || '').trim() : '';
    const positional = args.filter((a, i) => !a.startsWith('-') && !(diffFlag >= 0 && i === diffFlag + 1));
    const file = positional[1] || '';
    if (!file) { ngLine('要指定一个包文件：node src/ops.js plugins install <文件.tar.gz> [--expect-diff <hash>]'); return 2; }
    const full = path.resolve(file);
    if (!fs.existsSync(full)) { ngLine(`找不到文件：${full}`); return 1; }
    const buffer = fs.readFileSync(full);
    if (!buffer.length) { ngLine('文件是空的'); return 1; }
    try {
      const result = await installPlugin({
        tarball: buffer, dataDir: cfg.dataDir, log: noteLine,
        source: `本地文件：${path.basename(full)}`, hostVersion: readRepoVersion(),
        expectedDiffHash
      });
      section('安装完成');
      okLine(`插件 ${result.id} v${result.version}${result.upgraded ? '（升级，旧版已备份）' : ''}`);
      noteLine(`包内容 sha256：${sha256Of(buffer)}`);
      noteLine('这一步只是"装上"。要让它跑，还得授权：控制台左侧「插件」页点启用，');
      noteLine('或者写进配置 plugins.enabledIds（并确保 plugins.enabled 为 true）。');
      return 0;
    } catch (error) {
      if (error?.code === 'E_UPGRADE_CONFIRM' || error?.code === 'E_UPGRADE_CONFIRM_STALE') {
        ngLine(`安装失败：${error.message}`);
        if (error.diff?.summary?.length) noteLine(`权限变化：${error.diff.summary.join('；')}`);
        noteLine(`确认后重试：node src/ops.js plugins install ${file} --expect-diff ${error.diff?.diffHash || '<diffHash>'}`);
        return 1;
      }
      ngLine(`安装失败：${error?.message ?? error}${error?.code ? `（${error.code}）` : ''}`);
      return 1;
    }
  }

  ngLine(`认不得的子命令：${sub}（可用：list / install / uninstall）`);
  return 2;
}

/** 从配置里读"已授权会真跑"的插件 id（只读，不写盘）。 */
function readPluginEnabledIds(cfg) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'config.json'), 'utf8'));
    return Array.isArray(json?.plugins?.enabledIds) ? json.plugins.enabledIds : [];
  } catch { return []; }
}

/** 本仓版本号（来源记录里写"装的时候宿主是什么版本"）。 */
function readRepoVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

// ───────────────────────────────── 帮助 ─────────────────────────────────

const HELP = {
  'snowluma-version': `用法: node src/ops.js snowluma-version [--root-dir 目录]
看协议端（SnowLuma）当前镜像与版本、项目基线版本、是否落后。
读数来自 <root-dir>/snowluma/.env 与 docker inspect（不需要停服务）。`,
  'snowluma-update': `用法: node src/ops.js snowluma-update [--to 镜像] [--dry-run]
把协议端镜像更新到项目基线（或 --to 指定的镜像）：备份 .env/compose → 改 SNOWLUMA_IMAGE
→ docker compose pull → up -d → 等就绪。拉取失败只还原 .env；起不来会自动回滚到旧镜像。
数据卷不动，所以 QQ 登录态保留。--dry-run 只打印计划。`,
  'health-check': `用法: node src/ops.js health-check [--confirm]

一次性健康巡检并输出 JSON（退出码 0=健康 / 1=有失败项）。检查：控制台 /healthz、
OneBot get_status、协议端版本、Docker 套接字可读写性、
入站处理水位（到期未处理/重试耗尽的入站消息；observe / 暂停 /
预算降级自动跳过）、磁盘余量、自动更新状态、部署中断标记、messages 库完整性。
结果落到 data/health.json。

  --confirm  允许在"连续 3 次失败"或"恢复"时给 admin.ownerUin 发 QQ 私聊
             （不加只巡检、不发通知；状态仍会记录）。qq-agent-health.timer 用 --confirm。

  环境变量: QQ_AGENT_DATA_DIR / QQ_AGENT_ONEBOT_HTTP_PORT`,

  effects: `用法: node src/ops.js effects list [--state unknown] [--limit 30] [--data DIR]
       node src/ops.js effects resolve <id> --sent|--failed --confirm [--data DIR]

出站副作用账本（docs/EFFECT-LEDGER.md）的人工核对入口：
  list     列出最近记录（默认 unknown），带 id/动作/会话/时间/错误摘要；
  resolve  把一条 unknown 改判为 sent 或 failed（写入 resolvedBy=manual），
           必须显式 --confirm。只改账本，不会补发/撤回任何消息。

账本在 data/messages.sqlite 的 effects 表；服务运行时可安全读写（WAL）。
只读子命令 list 不写业务数据；resolve 是受控写入。`,

  doctor: `用法: node src/ops.js doctor [--out 文件] [--no-health]

生成排障用的诊断包：巡检结果 + 脱敏配置 + 存储占用（含会话留档/压缩归档）+
插件清单 + 异常台账 + 出站副作用账本状态 + 最近 3 小时日志（先 journalctl --user，
再系统 journal，取不到则 data/logs 最新文件）。
配置走 sanitizeConfigSecrets + redactSecretFields，MCP env/args 与插件设置的敏感键整段掩码；
日志走 redactText（常见 Key/Token/查询串/Cookie 形态）。第三方插件自己打印的内容无法保证。

  --out <文件>   输出路径（默认 ./qq-agent-diagnose-<时间戳>.tar.gz；
                 tar 不可用时退化为同名 .d 目录）
  --no-health    跳过巡检（不探测控制台/协议端/磁盘，包更小也更快）

只读：不改配置、不重启服务、不写 data/health.json。
退出码：0=健康且已生成 / 1=有失败项或包没生成。`,

  plugins: `用法: node src/ops.js plugins <子命令> [--data=目录]

  list                              列出已装插件（版本/能力/来源）与已授权清单
  install <文件.tar.gz>             从**本地文件**装一个插件（别人发你的包、或你自己打的包）
  uninstall <id> [--purge-data]     卸载插件；默认保留数据与凭据，--purge-data 一并删除

本地文件安装不需要你提供 sha256 —— 装完会打印算出来的值供核对；来源记录里写"本地文件：<文件名>"。
卸载会移走代码目录（留一份 .removed-* 便于巡检），必须加 --confirm；--dry-run 只预览。
装上不等于授权：要让它跑，还得在控制台点启用（或写进 plugins.enabledIds）。`,
  audit: `用法: node src/ops.js audit [--app=目录] [--data=目录] [--dir=部署根目录]

服务 + 代码 + 数据体检（只读，不会改配置或重启服务）：
  systemd user 服务与定时器、启动补丁链、全量 js 语法、未定义调用扫描、
  关键补丁标记、config.json 关键项（密钥只报有/无）、sqlite 完整性、
  控制台/OneBot 运行态、最近日志、主机资源与定时器。

环境变量: QQ_AGENT_DIR / QQ_AGENT_APP_DIR / QQ_AGENT_DATA_DIR / QQ_AGENT_NODE /
          QQ_AGENT_SERVICE / QQ_AGENT_UPDATE_TIMER / QQ_AGENT_GUARD_TIMER /
          QQ_AGENT_OVERRIDE_CONF / QQ_AGENT_CONSOLE_PORT / QQ_AGENT_ONEBOT_HTTP_PORT /
          QQ_AGENT_CONSOLE_TOKEN / QQ_AGENT_ONEBOT_TOKEN / QQ_AGENT_USER`,

  'audit-host': `用法: node src/ops.js audit-host [--dir=部署根目录] [--data=数据目录]

主机只读体检：失败单元、内存/磁盘/journald、docker 容器与重启次数、监听端口、
SSH 配置、防火墙、定时任务、可升级包、TLS 证书到期、备份现状。

环境变量: QQ_AGENT_DIR / QQ_AGENT_DATA_DIR / QQ_AGENT_USER

外部命令（systemctl/free/df/journalctl/docker/ss/...）缺失时对应段落打印跳过。`,

  'audit-prune': `用法: node src/ops.js audit-prune --confirm [--keep-months=N] [--data=目录]
       node src/ops.js audit-prune --dry-run

删除 data/audit-log/ 下超过保留月数的 audit-YYYYMM.jsonl（控制台写操作的审计留痕，改进方案 #5）。
按自然月切文件，默认保留 6 个月；qq-agent-audit-prune.timer 每月 1 日 04:20 自动跑。

--confirm       实际删除（必需；没有它会打印提醒后退出 1）
--dry-run       只列出将删除的文件
--keep-months=N 保留月数（默认 6）

环境变量: QQ_AGENT_DATA_DIR`,

  backup: `用法: node src/ops.js backup --confirm [--keep=N] [--data=目录] [--backup-dir=目录]
       [--include-stack-creds] [--no-encrypt] [--key-file=文件]
       node src/ops.js backup --dry-run
       node src/ops.js backup --drill [--from=备份文件] [--key-file=文件]

停服务几秒 -> tar.gz 打包数据目录 -> 起服务 -> 加密 -> 只留最近 N 份。
任何失败路径都会把服务拉起来；tar 或加密失败时本次备份作废。
默认 AES-256-GCM 加密；密钥来自 QQ_AGENT_BACKUP_KEY 或
~/.config/qq-agent/backup.key（首次备份自动生成，务必与备份分开保管）。

--confirm     实际执行（必需；没有它会打印提醒后退出 1）
--dry-run     只打印将要做什么
--keep=N      保留份数（默认 QQ_AGENT_KEEP=4）
--include-stack-creds  把 .env / .deployment.json / deployment-access.txt 放进归档顶层
              stack-credentials/（默认不含；恢复时不会自动写回，需人工取用）
--no-encrypt  不加密（仅在明确知道备份不会离开主机时使用）
--key-file    指定密钥文件
--drill       恢复演练：解密最近一份备份到临时目录并跑 SQLite integrity_check，
              不碰生产数据；定时演练要求密钥在文件里（unit 不带环境变量）。

环境变量: QQ_AGENT_DATA_DIR / QQ_AGENT_BACKUP_DIR / QQ_AGENT_SERVICE /
          QQ_AGENT_KEEP / QQ_AGENT_BACKUP_KEY / QQ_AGENT_BACKUP_KEY_FILE`,

  restore: `用法: node src/ops.js restore --from <备份文件> [--data=目录] [--dry-run]
       [--confirm] [--key-file=文件] [--no-encrypt]

解密 -> 校验归档路径 -> 停服务 -> 旧数据留档 -> 解包 -> 起服务 -> 检查状态。
服务起不来时自动回滚到恢复前的数据（留在 data.pre-restore-*）。

--from        备份文件（.tar.gz.enc 或 .tar.gz）
--data        目标数据目录（默认沿用配置）
--dry-run     只解密/列目录，不写任何数据
--confirm     实际执行（必需）
--key-file    指定密钥文件
--no-encrypt  归档未加密时使用`,

  prune: `用法: node src/ops.js prune --days=N [--data=目录] [--dry-run] [--confirm]

只删除 state='acked' 且早于 N 天的消息；pending / leased / failed / held 永远不删。
--days 省略时读 config.json 的 store.retentionDays（0 = 不删）。
--dry-run 预览条数；--confirm 实际执行。`,

  scan: `用法: node src/ops.js scan [目录] [--ignore=名1,名2] [--no-ignore] [--log=文件] [--strict]

扫描"调用了但本文件既没定义也没 import"的函数名（把注释/字符串/正则/模板串抹白后匹配）。
默认只报告、不阻断，退出码恒为 0（挂在服务启动链上时不能拦住服务）。
目录默认 src/。

--strict     有可疑调用时以退出码 1 结束（CI 把关用）
--ignore=a,b 忽略名单（默认内置项目已知误报表；传空 --ignore= 可关闭默认值）
--no-ignore  不使用任何忽略名单
--log=文件    有可疑调用时追加记录（对应原启动自检；服务启动时可用它挂 ExecStartPost）

环境变量: QQ_AGENT_LOG（仅文档用途，--log 未指定时不写日志）`,

  'watch-send': `用法: node src/ops.js watch-send [--minutes=N] [--interval=秒] [--data=目录]

盯 outbox 表的 rowid 水位线：基线之后新增的行若为 failed 就报 SEND_FAIL；
若出现新的未定义函数事故也报 SEND_FAIL；成功通过工具层发消息报 SEND_OK。
默认每 30 秒查一次，默认最多盯 240 分钟。

退出码: 0 = 工具层成功发出消息；1 = 发送失败 / 又出现未定义函数；2 = 超时。

环境变量: QQ_AGENT_DATA_DIR`,

  'watch-login': `用法: node src/ops.js watch-login [--timeout=N] [--interval=秒]

每 15 秒轮询一次协议端 HTTP 端口，直到 QQ 登录成功（响应里含 online），
然后打印 get_status / get_login_info / 控制台状态 / 最近日志。
--timeout=N 是最长等待分钟数（默认 25）。

退出码: 0 = 已登录；1 = 超时或缺少令牌。

环境变量: QQ_AGENT_ONEBOT_TOKEN（必填，或 config.json 里的 OneBot 令牌）、
          QQ_AGENT_ONEBOT_HTTP_PORT / QQ_AGENT_CONSOLE_PORT / QQ_AGENT_CONSOLE_TOKEN /
          QQ_AGENT_SERVICE / QQ_AGENT_DATA_DIR`,

  guard: `用法: node src/ops.js guard --dry-run [--threshold=N]
       node src/ops.js guard --confirm [--threshold=N] [--log=文件]

进程看门狗（仅 Linux）：某用户进程数超过阈值时，清理失控的 bash/grep/tr/sh/sleep
进程树并记录现场。默认阈值 800。

--threshold=N 进程数阈值（默认 QQ_AGENT_PROC_LIMIT=800）
--dry-run     只列出将清理的进程，不杀、不写日志
--confirm     真实清理（必需）

环境变量: QQ_AGENT_GUARD_USER / QQ_AGENT_PROC_LIMIT / QQ_AGENT_GUARD_LOG`,

  'face-names': `用法: node src/ops.js face-names [--print] [--data=目录] [--container=容器名]
       node src/ops.js face-names --catalog=sys-face.json [--qq-config=face_config.json]

合并 SnowLuma 目录 / QQ 客户端配置 / 手工补充表（data/face-names-extra.json），
导出 data/face-names.json（onebot.js 的表情名补丁读取它，改完需重启服务）。

--print / --dry-run  只打印结果 JSON，不写文件
--catalog=文件       跳过 docker cp，直接用本地 sys-face-catalog.json

环境变量: QQ_AGENT_DATA_DIR / QQ_AGENT_SNOWLUMA_CONTAINER`,

  deploy: `用法: node src/ops.js deploy --confirm [--dir=源码目录] [--root-dir=部署根目录]
       node src/ops.js deploy --dry-run

非交互部署：调用源码目录里的 deploy-all.sh -y，凭据只从环境变量传入。

--dir=目录        已 clone 的源码目录（默认 QQ_AGENT_SRC_DIR 或 ~/qq-agent-src）
--root-dir=目录   部署根目录（默认 QQ_AGENT_DIR；QQ_AGENT_ROOT_DIR 已废弃、不生效）
--confirm         实际执行（必需）
--dry-run         只打印将执行的命令

环境变量: QQ_AGENT_MODEL_API_KEY 或 QQ_AGENT_MODEL_KEY_FILE（必填其一）、
          QQ_AGENT_MODEL_BASE_URL / QQ_AGENT_MODEL（必填）、
          SNOWLUMA_IMAGE /
          QQ_AGENT_ONEBOT_HTTP_PORT / QQ_AGENT_ONEBOT_WS_PORT`,

  console: `用法: node src/ops.js console [--open] [--print] [--timeout=秒]

用系统 ssh 建立到服务器的隧道（控制台 / SnowLuma WebUI / QQ 远程桌面三个端口），
等控制台就绪后提示访问地址；--open 会同时用默认浏览器打开控制台。
需要本机已配置到服务器的 SSH 免密登录（密钥）。

--print       只打印 ssh 命令与访问地址，不连接
--open        就绪后自动打开浏览器
--timeout=秒  等待控制台就绪的秒数（默认 45）

环境变量: SSHHOST（或 QQ_AGENT_SSH=user@host）、SSHUSER（默认 ubuntu）、SSHPORT（22）、
          QQ_AGENT_CONSOLE_PORT（3210）/ QQ_AGENT_WEBUI_PORT（5099）/ QQ_AGENT_VNC_PORT（6081）、
          QQ_AGENT_CONSOLE_TOKEN（可选，带上则免登录）`,

  'install-timers': `用法: node src/ops.js install-timers --print
       node src/ops.js install-timers --confirm

安装 systemd user 定时器：
  qq-agent-backup.timer（每周日 04:10 备份，Persistent=true）
  process-guard.timer（每 10 分钟进程看门狗）
  qq-agent-health.timer（每 5 分钟健康巡检）
  qq-agent-audit-prune.timer（每月 1 日 04:20 清理审计日志）

--print    只打印单元内容，不写盘
--confirm  写入并执行 systemctl --user daemon-reload / enable --now

环境变量: QQ_AGENT_SYSTEMD_DIR（默认 ~/.config/systemd/user）及所有路径变量`
};

function printMainHelp() {
  say('QQ Agent 运维工具（唯一入口，只用 Node 内置模块）');
  say();
  say('用法: node src/ops.js <子命令> [选项]');
  say('      node src/ops.js <子命令> --help');
  say();
  say('子命令:');
  say('  audit           服务 + 代码 + 数据体检（只读）');
  say('  audit-host      主机体检（只读）');
  say('  audit-prune     清理超期的审计日志（需 --confirm）');
  say('  backup          停/起服务 + 打包数据目录 + 只留最近 N 份（需 --confirm）');
  say('  scan            未定义调用扫描（只报告、不阻断）');
  say('  watch-send      盯 outbox 水位线，确认消息通过工具层发出');
  say('  watch-login     轮询协议端端口直到 QQ 登录成功');
  say('  guard           进程数超阈值时清理失控进程树（需 --confirm）');
  say('  face-names      合并三个来源导出表情名对照表');
  say('  deploy          非交互部署（需 --confirm）');
  say('  console         SSH 隧道 + 打开控制台（Windows/macOS/Linux）');
  say('  plugins         插件：本地文件安装 / 列已装的（node src/ops.js plugins install <文件>）');
  say('  install-timers  生成并安装 systemd user 定时器（需 --confirm）');
  say('  health-check    健康巡检（控制台/协议端/入站水位/磁盘/更新状态）；退出码 0=健康');
  say('  doctor          一键诊断包（巡检+脱敏配置+存储占用+日志），提 issue 时附上');
  say('  effects         出站副作用账本：列 unknown / 人工改判（需 --confirm）');
  say('  snowluma-version 看协议端（SnowLuma）镜像版本与是否落后于项目基线');
  say('  snowluma-update  更新协议端镜像（改 .env + compose pull/up -d，失败自动回滚）');
  say('  help            显示本帮助');
  say();
  say('环境变量与常用示例见 docs/OPS.md。');
  say('只读子命令不写业务数据；破坏性操作必须显式 --confirm，可用 --dry-run / --print 预演。');
}

// ───────────────────────────────── 入口 ─────────────────────────────────

const COMMANDS = {
  audit: { run: auditServer, help: HELP.audit },
  'audit-host': { run: auditHost, help: HELP['audit-host'] },
  'audit-prune': { run: cmdAuditPrune, help: HELP['audit-prune'] },
  backup: { run: cmdBackup, help: HELP.backup },
  restore: { run: cmdRestore, help: HELP.restore },
  prune: { run: cmdPrune, help: HELP.prune },
  scan: { run: cmdScan, help: HELP.scan },
  'watch-send': { run: cmdWatchSend, help: HELP['watch-send'] },
  'watch-login': { run: cmdWatchLogin, help: HELP['watch-login'] },
  plugins: { run: cmdPlugins, help: HELP.plugins },
  guard: { run: cmdGuard, help: HELP.guard },
  'face-names': { run: cmdFaceNames, help: HELP['face-names'] },
  deploy: { run: cmdDeploy, help: HELP.deploy },
  console: { run: cmdConsole, help: HELP.console },
  'install-timers': { run: cmdInstallTimers, help: HELP['install-timers'] },
  'health-check': { run: cmdHealthCheck, help: HELP['health-check'] },
  doctor: { run: cmdDoctor, help: HELP.doctor },
  effects: { run: cmdEffects, help: HELP.effects },
  'snowluma-version': { run: cmdSnowlumaVersion, help: HELP['snowluma-version'] },
  'snowluma-update': { run: cmdSnowlumaUpdate, help: HELP['snowluma-update'] }
};

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'help';
  const args = argv.slice(1);
  if (command === 'help' || command === '--help' || command === '-h') {
    printMainHelp();
    return 0;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    say(`未知子命令: ${command}`);
    say();
    printMainHelp();
    return 2;
  }
  if (wantsHelp(args)) {
    say(entry.help);
    return 0;
  }
  const code = await entry.run(args);
  return typeof code === 'number' ? code : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`ops 执行失败: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
