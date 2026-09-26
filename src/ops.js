#!/usr/bin/env node
// QQ Agent 运维工具（唯一入口）。
//
// 原 ops/ 目录下的 shell / python 脚本已全部移植到这里，只用 Node 内置模块，
// 不引入任何新依赖。用法：node src/ops.js <子命令> [选项]；每个子命令支持 --help。
//
// 约定：
//   - 只读子命令（audit / audit-host / scan / watch-* / face-names --print / console --print）
//     不写业务数据；
//   - 破坏性操作（backup / deploy / guard 真实执行 / install-timers 写盘）必须显式 --confirm，
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
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
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

function formatCount(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN') : String(value);
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
    return new DatabaseSync(file, { readOnly: true });
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
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  const counts = new Map();
  for (const name of files) {
    let session;
    try { session = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
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
process setTimeout clearTimeout setInterval clearInterval setImmediate queueMicrotask requestAnimationFrame
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent fetch URL URLSearchParams
structuredClone BigInt RegExp Error TypeError RangeError SyntaxError Symbol AbortController AbortSignal
TextEncoder TextDecoder atob btoa globalThis performance crypto require module exports
FormData Blob Headers Response Request
if for while switch catch return typeof function await new delete void in of do else try throw case instanceof
yield super this null true false async static get set import export default class const let var new`.split(/\s+/).filter(Boolean));

// 已知误报（解构参数 / 动态 import / 全局对象），仅列出逐个确认过的。
const KNOWN_IGNORE = [
  'Agent', 'Proxy', 'resolve', 'reject', 'task', 'fn', 'send', 'sleep', 'operation',
  'isRetryable', 'random', 'resolveAtName', 'resolveReply', 'normalizeBehaviorProfile',
  'getConfigFn', 'allowSource', 'fetchFn'
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
  ['normalizeMid 定义', 1, 'src/tools/tools-core.js', '^function normalizeMid\\(value\\)'],
  ['normalizeMid 调用点', 3, 'src/tools/tools-core.js', 'replyToMessageId: normalizeMid\\(args'],
  ['store.findByMid 归一化', 1, 'src/core/store.js', 'normalizeMid\\(mid\\)'],
  ['贴纸同步防清空守卫', 1, 'src/onebot/stickers.js', 'if \\(!fetchedIds\\.size\\) return out'],
  ['主动间隔守卫', 1, 'src/core/orchestrator.js', 'minGapMs'],
  ['主动判定落盘', 1, 'src/core/orchestrator.js', 'writeProactiveLastAttempt\\(nowTick\\)'],
  ['多窗口工具函数', 1, 'src/core/orchestrator.js', 'function proactiveWindowState'],
  ['补话安排', 1, 'src/core/orchestrator.js', 'maybeScheduleFollowUp\\(chatKey'],
  ['重连补课', 2, 'src/console/app.js', 'catchUpMissedMessages|scheduleCatchUp'],
  ['空间互动失败退避', 2, 'src/features/qzone-interactions.js', 'failStreak|backoff'],
  // 重试实现早就改成"按可确认未送达的错误判断"，不再用 isTransient 命名 ——
  // 标记要跟着指向现在的实现，否则每次体检都误报一项。
  ['发送网络级重试', 1, 'src/onebot/sender.js', '能证明请求没被对方收到|1.5 秒后重试一次'],
  ['QQ表情标签', 1, 'src/onebot/onebot.js', 'QQ表情'],
  ['看图先读情绪', 1, 'src/llm/prompt.js', '看图先读情绪'],
  ['表情编号≠stickerId 提醒', 1, 'src/llm/prompt.js', '别拿这个编号去 get_sticker_image'],
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
  ['表情清单常驻', 1, 'src/llm/prompt.js', '表情清单常驻系统提示']
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
    const body = await response.text();
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
    noteLine(`主动开话题: enabled=${proactive.enabled} 概率=${proactive.probability} 间隔=${interval(proactive.checkIntervalMinMs, proactive.checkIntervalMaxMs)} 窗口=${windows} 冷场=${Math.round(Number(proactive.idleThresholdMs || 0) / 60000)}分钟`);
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
    noteLine(`白名单群/私聊: ${(cfgJson.allow?.groups || []).length} / ${(cfgJson.allow?.private || []).length}`);
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
  for (const name of ['messages.sqlite', 'incident-pilot.sqlite', 'identity-pilot.sqlite', 'relationship-pilot.sqlite']) {
    const file = path.join(cfg.dataDir, name);
    if (!exists(file)) {
      noteLine(`（缺 ${name}）`);
      continue;
    }
    noteLine(`${name.padEnd(26)} integrity=${sqliteIntegrity(file)}`);
  }
  const sessionsDir = path.join(cfg.dataDir, 'sessions');
  let sessionCount = 0;
  if (exists(sessionsDir)) {
    try { sessionCount = fs.readdirSync(sessionsDir).length; } catch { sessionCount = 0; }
  }
  noteLine(`会话文件: ${sessionCount} 个`);

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
    const status = await fetchJson(`http://127.0.0.1:${cfg.consolePort}/api/status?token=${encodeURIComponent(consoleInfo.token)}`);
    if (!status.json) ngLine(`控制台状态接口不可达（${status.error || `HTTP ${status.status}`}）`);
    else {
      const data = status.json;
      const onebot = data.onebot || {};
      const orchestrator = data.orchestrator || {};
      noteLine(`OneBot: connected=${onebot.connected} error=${JSON.stringify(onebot.error ?? null)} self=${onebot.self?.userId ?? '-'}`);
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
    ngLine(`目录不存在: ${dir}`);
    return 0;
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
function runTarCreate(outFile, dataDir) {
  const parent = path.dirname(dataDir);
  const base = path.basename(dataDir);
  const attempts = IS_WINDOWS
    ? [['--force-local', '-czf', outFile, '-C', parent, base], ['-czf', outFile, '-C', parent, base]]
    : [['-czf', outFile, '-C', parent, base]];
  let last = { ok: false, code: null, stderr: '' };
  for (const tarArgs of attempts) {
    const result = run('tar', tarArgs, { timeout: 0 });
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
  if (dryRun) {
    say('备份预演（不会停服务、不会写文件）:');
    noteLine(`数据目录: ${cfg.dataDir}`);
    noteLine(`备份目录: ${cfg.backupDir}`);
    noteLine(`服务名: ${cfg.service}（先 stop、打包后 start）`);
    noteLine(`保留份数: ${keep}`);
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
  // 包里是 config.json（含密钥）/console-access.txt/messages.sqlite，权限必须收紧
  fs.mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 });
  const outFile = path.join(cfg.backupDir, `qq-agent-data-${formatStamp()}.tar.gz`);
  const du = run('du', ['-sh', cfg.dataDir]);
  if (!du.missing && du.ok) noteLine(`源大小: ${du.stdout.trim().split(/\s+/)[0]}`);

  let serviceManaged = false;
  let tarOk = false;
  try {
    const stop = systemctlUser(['stop', cfg.service], { timeout: 60000 });
    serviceManaged = !stop.missing;
    if (stop.missing) skipLine('缺少 systemctl：跳过停服务（直接打包）');
    else if (!stop.ok) noteLine(`停止服务返回码 ${stop.code}，仍继续备份`);
    await sleep(2000);
    const tar = runTarCreate(outFile, cfg.dataDir);
    tarOk = tar.ok;
    if (!tarOk) ngLine(`tar 打包失败（返回码 ${tar.code}${tar.stderr ? `：${tar.stderr.trim().split('\n')[0]}` : ''}）`);
  } finally {
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
    try { fs.rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
    ngLine('tar 失败，本次备份作废（服务已恢复）');
    return 1;
  }
  let backups = [];
  try {
    backups = fs.readdirSync(cfg.backupDir)
      .filter((name) => /^qq-agent-data-.*\.tar\.gz$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(cfg.backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { backups = []; }
  for (const stale of backups.slice(keep)) {
    try { fs.rmSync(path.join(cfg.backupDir, stale.name), { force: true }); } catch { /* 忽略 */ }
  }
  const size = (() => {
    try { return (fs.statSync(outFile).size / 1024 / 1024).toFixed(1); } catch { return '?'; }
  })();
  try { fs.chmodSync(outFile, 0o600); } catch { /* 权限设不上不影响备份本身 */ }
  okLine(`备份完成: ${size} MB ${outFile}`);
  for (const item of backups.slice(0, keep)) noteLine(`  ${item.name}`);
  return 0;
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
        const consoleStatus = await fetchJson(`http://127.0.0.1:${cfg.consolePort}/api/status?token=${encodeURIComponent(consoleInfo.token)}`, {}, 5000);
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
  const cfg = config({ dir: optValue(args, '--root-dir', null) });
  const srcDir = path.resolve(optValue(args, '--dir', envStr('QQ_AGENT_SRC_DIR', path.join(os.homedir(), 'qq-agent-src'))));
  const image = envStr('SNOWLUMA_IMAGE', 'motricseven7/snowluma:v1.14.15');
  const obHttp = envStr('QQ_AGENT_ONEBOT_HTTP_PORT', '3390');
  const obWs = envStr('QQ_AGENT_ONEBOT_WS_PORT', '3391');
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

function sshTarget(args) {
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
  const openArgs = IS_WINDOWS ? ['/c', 'start', '', url] : [url];
  const result = run(command, openArgs, { timeout: 10000 });
  if (result.missing) noteLine(`（未找到打开浏览器的命令，请手动访问 ${url}）`);
}

async function cmdConsole(args) {
  if (wantsHelp(args)) { say(HELP.console); return 0; }
  const target = sshTarget(args);
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
ExecStart=${nodeBin} ${opsPath} backup --confirm
# 默认部署根目录 /data/qq-agent，备份输出到 $HOME/qq-agent/backups，保留 4 份：
# Environment=QQ_AGENT_DIR=${cfg.rootDir}
# Environment=QQ_AGENT_DATA_DIR=${cfg.dataDir}
# Environment=QQ_AGENT_BACKUP_DIR=${cfg.backupDir}
# Environment=QQ_AGENT_SERVICE=${serviceName}
# Environment=QQ_AGENT_KEEP=${cfg.keep}
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
  return [
    ['qq-agent-backup.service', backupService],
    ['qq-agent-backup.timer', backupTimer],
    ['process-guard.service', guardService],
    ['process-guard.timer', guardTimer]
  ];
}

function cmdInstallTimers(args) {
  if (wantsHelp(args)) { say(HELP['install-timers']); return 0; }
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
    skipLine('缺少 systemctl：请手动执行 systemctl --user daemon-reload && systemctl --user enable --now qq-agent-backup.timer process-guard.timer');
    return 0;
  }
  if (!reload.ok) ngLine(`daemon-reload 失败: ${text(reload)}`);
  const enable = systemctlUser(['enable', '--now', 'qq-agent-backup.timer', 'process-guard.timer'], { timeout: 60000 });
  if (enable.ok) okLine('定时器已启用：qq-agent-backup.timer（每周日 04:10）、process-guard.timer（每 10 分钟）');
  else ngLine(`启用定时器失败: ${text(enable)}`);
  return 0;
}

// ───────────────────────────────── 帮助 ─────────────────────────────────

const HELP = {
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

  backup: `用法: node src/ops.js backup --confirm [--keep=N] [--data=目录] [--backup-dir=目录]
       node src/ops.js backup --dry-run

停服务几秒 -> tar.gz 打包数据目录 -> 起服务 -> 只留最近 N 份。
任何失败路径都会把服务拉起来；tar 失败时本次备份作废。

--confirm     实际执行（必需；没有它会打印提醒后退出 1）
--dry-run     只打印将要做什么
--keep=N      保留份数（默认 QQ_AGENT_KEEP=4）

环境变量: QQ_AGENT_DATA_DIR / QQ_AGENT_BACKUP_DIR / QQ_AGENT_SERVICE / QQ_AGENT_KEEP`,

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
--root-dir=目录   部署根目录（默认 QQ_AGENT_ROOT_DIR / QQ_AGENT_DIR）
--confirm         实际执行（必需）
--dry-run         只打印将执行的命令

环境变量: QQ_AGENT_MODEL_API_KEY 或 QQ_AGENT_MODEL_KEY_FILE（必填其一）、
          QQ_AGENT_MODEL_BASE_URL / QQ_AGENT_MODEL（必填）、
          QQ_AGENT_ROOT_DIR / SNOWLUMA_IMAGE /
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

安装两个 systemd user 定时器：
  qq-agent-backup.timer（每周日 04:10 备份，Persistent=true）
  process-guard.timer（每 10 分钟进程看门狗）

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
  say('  backup          停/起服务 + 打包数据目录 + 只留最近 N 份（需 --confirm）');
  say('  scan            未定义调用扫描（只报告、不阻断）');
  say('  watch-send      盯 outbox 水位线，确认消息通过工具层发出');
  say('  watch-login     轮询协议端端口直到 QQ 登录成功');
  say('  guard           进程数超阈值时清理失控进程树（需 --confirm）');
  say('  face-names      合并三个来源导出表情名对照表');
  say('  deploy          非交互部署（需 --confirm）');
  say('  console         SSH 隧道 + 打开控制台（Windows/macOS/Linux）');
  say('  install-timers  生成并安装两个 systemd user 定时器（需 --confirm）');
  say('  help            显示本帮助');
  say();
  say('环境变量与常用示例见 docs/OPS.md。');
  say('只读子命令不写业务数据；破坏性操作必须显式 --confirm，可用 --dry-run / --print 预演。');
}

// ───────────────────────────────── 入口 ─────────────────────────────────

const COMMANDS = {
  audit: { run: auditServer, help: HELP.audit },
  'audit-host': { run: auditHost, help: HELP['audit-host'] },
  backup: { run: cmdBackup, help: HELP.backup },
  scan: { run: cmdScan, help: HELP.scan },
  'watch-send': { run: cmdWatchSend, help: HELP['watch-send'] },
  'watch-login': { run: cmdWatchLogin, help: HELP['watch-login'] },
  guard: { run: cmdGuard, help: HELP.guard },
  'face-names': { run: cmdFaceNames, help: HELP['face-names'] },
  deploy: { run: cmdDeploy, help: HELP.deploy },
  console: { run: cmdConsole, help: HELP.console },
  'install-timers': { run: cmdInstallTimers, help: HELP['install-timers'] }
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
