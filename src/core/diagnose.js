// 一键诊断包（`node src/ops.js doctor`）。
//
// 目的：把排障需要的现场信息一次收齐，用户不需要懂 SSH、也不用把整个 data 目录发出来。
// 硬约束（比"信息全"更重要）：
//   1. 尽量不带密钥 —— 配置先走 sanitizeConfigSecrets（与 /api/config 同一口径）再走
//      redactSecretFields（按值形态再兜一遍），MCP env / args 与插件设置里的敏感键整段掩码；
//      日志走 redactText（与 logger 同一口径）。第三方插件自己打印的内容无法保证。
//   2. 只读：不打开可写数据库、不改配置、不重启服务。SQLite 一律 readOnly（WAL 库可能
//      需要 -shm，那是 SQLite 自己的行为，不是本模块写业务数据）。
//   3. 体积有界：目录遍历、日志行数、事件条数都有上限；日志只读文件尾部 256KB。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizeConfigSecrets, redactSecretFields } from './secret-keys.js';
import { redactText } from './redact.js';
import { openDatabase } from './sqlite.js';
import { listSessionFiles } from './session-files.js';

const MAX_WALK_FILES = 50000;
const MAX_LOG_CHARS = 40000;
const LOG_TAIL_BYTES = 256 * 1024;
const SECRET_SETTING_KEY = /(cookie|session|token|secret|pass(word|wd)?|auth|credential|(^|_)key$)/i;

/** 递归汇总目录大小（跳过符号链接；深度与文件数有上限，防止指向 / 的软链把命令挂死）。 */
function walkSize(dir, agg, depth = 0) {
  if (depth > 6 || agg.files >= MAX_WALK_FILES) return;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (agg.files >= MAX_WALK_FILES) return;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) { agg.files += 1; agg.bytes += stat.size; continue; }
    if (stat.isDirectory()) walkSize(full, agg, depth + 1);
  }
}

/** data 目录一级占用排行（诊断包里的 storage.json 主体）。 */
export function storageBreakdown(dataDir) {
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const full = path.join(dataDir, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) { out.push({ name, kind: 'symlink', bytes: 0, files: 0 }); continue; }
    if (stat.isFile()) { out.push({ name, kind: 'file', bytes: stat.size, files: 1 }); continue; }
    if (!stat.isDirectory()) continue;
    const agg = { bytes: 0, files: 0 };
    walkSize(full, agg);
    out.push({ name, kind: 'dir', bytes: agg.bytes, files: agg.files });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** 会话留档专项统计（含压缩归档；与 sessions.storageStats 同口径但不依赖 SessionRegistry）。 */
export function sessionStorage(dataDir) {
  let files = [];
  try { files = listSessionFiles(path.join(dataDir, 'sessions')); } catch { return null; }
  let bytes = 0;
  let compressed = 0;
  let compressedBytes = 0;
  let oldestAt = 0;
  for (const entry of files) {
    let stat;
    try { stat = fs.statSync(entry.file); } catch { continue; }
    bytes += stat.size;
    if (entry.compressed) { compressed += 1; compressedBytes += stat.size; }
    if (!oldestAt || stat.mtimeMs < oldestAt) oldestAt = stat.mtimeMs;
  }
  return { files: files.length, compressed, bytes, compressedBytes, oldestAt: oldestAt || null };
}

/**
 * 插件设置里的敏感键整段掩码。`plugins.settings.<id>` 是插件自定义的键值，
 * 常见的 `biliCookie` / `userSession` 这类键名不带 token/key 字样，按字段名脱敏拦不住；
 * 这里按"敏感词出现在键名任意位置"再掩一遍，其余设置保留（诊断仍要看配置）。
 */
function maskPluginSettings(cfg) {
  const settings = cfg?.plugins?.settings;
  if (!settings || typeof settings !== 'object') return;
  for (const bag of Object.values(settings)) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
    for (const key of Object.keys(bag)) {
      // sanitizeConfigSecrets 生成的 hasXxx 布尔标记不要被当成敏感值再掩一次
      if (/^has[a-z]/i.test(key) && typeof bag[key] === 'boolean') continue;
      if (SECRET_SETTING_KEY.test(key)) bag[key] = '******';
    }
  }
}

/**
 * MCP 的 env/args 是自由格式，字段名不带 token/key 也完全合法（SENTRY_AUTH_TOKEN、
 * --header "Authorization: …"）。这两处一律按"值不可信"处理：env 的值全掩、args 里
 * 敏感选项的下一个参数掩掉。键名保留，方便对照用了哪些变量。
 */
function maskMcpSecrets(cfg) {
  const servers = cfg?.mcp?.servers;
  if (!Array.isArray(servers)) return;
  const flag = /^--?(?:.*[-_])?(?:key|token|secret|pass(word|wd)?|auth|authorization|header|cookie)/i;
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue;
    if (server.env && typeof server.env === 'object' && !Array.isArray(server.env)) {
      for (const key of Object.keys(server.env)) server.env[key] = '******';
    }
    if (Array.isArray(server.args)) {
      for (let i = 0; i < server.args.length; i += 1) {
        if (typeof server.args[i] !== 'string') continue;
        if (!flag.test(server.args[i])) continue;
        if (i + 1 < server.args.length) server.args[i + 1] = '******';
        i += 1;
      }
    }
  }
}

/**
 * 配置脱敏副本；读不到/坏 JSON 返回 { unavailable, error } 而不是抛。
 * 解析失败时不回显 V8 的原始报错 —— 它会把出错位置的输入片段带出来（可能正好是 Key）。
 */
export function redactedConfig(dataDir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  } catch {
    return { unavailable: true, error: '配置文件不存在或不是合法 JSON（内容不回显）' };
  }
  try {
    const safe = redactSecretFields(sanitizeConfigSecrets(raw));
    maskMcpSecrets(safe);
    maskPluginSettings(safe);
    return safe;
  } catch {
    return { unavailable: true, error: '配置脱敏失败（内容不回显）' };
  }
}

/**
 * 已安装插件清单（id / 名称 / 版本 / apiVersion）。
 * 只认真实目录、跳过 `.staging-*`/`.backup-*`/`.removed-*` 这类中间目录；
 * 清单坏了也要以 `broken:true` 列出来 —— 那正是需要排障的对象。
 */
export function pluginSummary(dataDir) {
  const dir = path.join(dataDir, 'plugins');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name, 'plugin.json');
    if (!fs.existsSync(file)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({
        id: entry.name,
        name: String(manifest?.name ?? ''),
        version: String(manifest?.version ?? ''),
        apiVersion: manifest?.apiVersion ?? null
      });
    } catch {
      out.push({ id: entry.name, broken: true, error: 'plugin.json 无法解析' });
    }
  }
  return out;
}

/**
 * 异常台账摘要（只读打开）。库不存在返回 null；库存在但读不了返回
 * `{ unavailable: true, reason }`，不能和"一条异常都没有"混为一谈。
 */
export function incidentSummary(dataDir, { limit = 8 } = {}) {
  const file = path.join(dataDir, 'incident-pilot.sqlite');
  if (!fs.existsSync(file)) return null;
  let db = null;
  try {
    db = openDatabase(file, { readOnly: true });
    const counts = db.prepare('SELECT state, COUNT(*) AS count FROM incidents GROUP BY state').all();
    const latest = db.prepare(`SELECT code, category, severity, state, count, last_at, safe_message
      FROM incidents ORDER BY last_at DESC LIMIT ?`).all(Math.max(1, Math.min(50, Number(limit) || 8)))
      .map((row) => ({ ...row, safe_message: redactText(row.safe_message, 300) }));
    return { counts, latest };
  } catch (error) {
    return { unavailable: true, reason: redactText(String(error?.message ?? error), 200) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * 出站副作用账本摘要（只读）。旧数据目录还没有 effects 表时返回 null，
 * 不能把"表不存在"报成"没有未知动作"。
 */
export function effectSummary(dataDir) {
  const file = path.join(dataDir, 'messages.sqlite');
  if (!fs.existsSync(file)) return null;
  let db = null;
  try {
    db = openDatabase(file, { readOnly: true });
    const rows = db.prepare('SELECT state, COUNT(*) AS n FROM effects GROUP BY state').all();
    const counts = {};
    let total = 0;
    for (const row of rows) {
      counts[String(row.state)] = Number(row.n) || 0;
      total += Number(row.n) || 0;
    }
    const since = Date.now() - 24 * 60 * 60 * 1000;
    // 与 /api/status 的 stats() 同口径（按 created_at，走 state+created 索引）
    const unknownRecent = Number(db.prepare(
      "SELECT COUNT(*) AS n FROM effects WHERE state='unknown' AND created_at >= ?"
    ).get(since)?.n) || 0;
    // 只给定位信息（id/kind/会话/时间/错误摘要），不含消息正文；用于 ops effects resolve
    const unknownSamples = db.prepare(`SELECT id, kind, chat_key, created_at, detail
      FROM effects WHERE state='unknown' ORDER BY created_at DESC LIMIT 20`).all()
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        chatKey: row.chat_key,
        createdAt: Number(row.created_at) || 0,
        detail: redactText(String(row.detail || ''), 400)
      }));
    return { total, counts, unknownRecent, unknownSamples };
  } catch (error) {
    const message = String(error?.message ?? error);
    // 表不存在 = 旧数据目录（正常）；其余读取失败要如实说"读不了"，不能伪装成旧版本
    if (/no such table/i.test(message)) return null;
    return { unavailable: true, reason: redactText(message, 200) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** journalctl 在"没有匹配条目"时退出码仍是 0，输出这类占位行。 */
function isJournalPlaceholder(text) {
  const body = String(text || '').trim();
  return !body || body.startsWith('-- No entries --') || /^-- .* --$/.test(body);
}

/**
 * 最近日志。Linux 上先 `journalctl --user -u <service>`（本项目是 systemd **user** unit），
 * 再退回系统 journal；都取不到时读 `data/logs` 下最新的 `.log` 尾部。
 * 统一过 redactText：日志里可能带 URL 令牌、Authorization 头与 Key。
 */
export function logTail({ dataDir = '', service = '', lines = 300 } = {}) {
  const maxLines = Math.max(10, Math.min(2000, Number(lines) || 300));
  if (process.platform === 'linux' && service) {
    const base = ['-u', service, '--since', '-3 hours', '-n', String(maxLines), '--no-pager', '-o', 'short-iso'];
    for (const extra of [['--user'], []]) {
      const result = spawnSync('journalctl', [...extra, ...base], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024
      });
      if (result.status === 0 && !isJournalPlaceholder(result.stdout)) return redactLog(result.stdout);
    }
  }
  try {
    const dir = path.join(dataDir, 'logs');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'))
      .map((f) => {
        const file = path.join(dir, f);
        // 只认普通文件：符号链接可能指向 config.json / 别人的日志
        const stat = fs.lstatSync(file);
        return stat.isFile() ? { file, at: stat.mtimeMs } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
    if (!files.length) return noLogsHint(service);
    const { file } = files[0];
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
    const length = Math.max(0, stat.size - start);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const tail = buf.toString('utf8').split('\n').slice(-maxLines).join('\n');
    return redactLog(tail);
  } catch {
    return noLogsHint(service);
  }
}

/**
 * 日志取不到时不能只给空串：诊断包是最常被附到 issue 里的东西，
 * "没有可用日志"会被读成"这台机器没日志"，而实际可能只是容器部署或 sudo 跑丢了 user journal。
 * 返回一句可操作提示，让人知道下一步该贴什么。
 */
function noLogsHint(service) {
  const unit = service || '<service>';
  return [
    '（没有读到日志：本机没有可访问的 journal，data/logs 下也没有 .log 文件）',
    '容器部署：docker compose logs --tail 400 agent',
    `systemd 用户服务：journalctl --user -u ${unit} -n 400 --no-pager`,
    '注意用运行服务的同一个用户执行（sudo 会看到 root 的 user journal，读不到业务单元）'
  ].join('\n');
}

/** 日志截断保留**最新**的一段（redactText 的 max 是掐头，直接传会把最近的错误切掉）。 */
function redactLog(text) {
  return redactText(text, Number.MAX_SAFE_INTEGER).slice(-MAX_LOG_CHARS);
}

/** 诊断包内的文件清单（纯函数，便于测试断言脱敏结果）。 */
export function buildDiagnoseEntries(data) {
  return {
    'manifest.json': JSON.stringify(data.manifest ?? {}, null, 2),
    // 不叫 config.json：包被误解到 data/ 时会覆盖线上真实配置（全部密钥已被删，等同于清空）
    'config.redacted.json': JSON.stringify(data.config ?? { unavailable: true }, null, 2),
    // 同理，data/health.json 是线上巡检状态文件
    'health-check.json': JSON.stringify(data.health ?? { skipped: true }, null, 2),
    'storage.json': JSON.stringify({
      breakdown: data.storage?.breakdown ?? [],
      sessions: data.storage?.sessions ?? null
    }, null, 2),
    'plugins.json': JSON.stringify(data.plugins ?? [], null, 2),
    'incidents.json': JSON.stringify(data.incidents ?? null, null, 2),
    'effects.json': JSON.stringify(data.effects ?? null, null, 2),
    'logs.txt': data.logs && String(data.logs).trim() ? String(data.logs) : '(没有可用日志)'
  };
}

/**
 * 写出诊断包：优先 tar.gz（Linux/macOS 自带；Windows 10+ 也有 bsdtar）。
 * tar 不可用或跨盘失败时退回**目录形态**（同样内容，用户可自行压缩），并返回实际路径。
 *
 * 安全要点：
 *   - 先写 `*.tmp-<pid>` 再改名：tar 失败不会把用户已有的同名文件截断成半成品；
 *   - 回退目录用带时间戳的新名字，不删除任何已存在路径（`--out` 指到用户目录也不会被清）；
 *   - Windows 上给 tar 加 `--force-local`（GNU tar 会把 `C:\...` 当成远端主机）。
 */
export function writeDiagnoseArchive(outFile, entries) {
  const abs = path.resolve(outFile);
  const entriesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diagnose-'));
  const writeFiles = (dir) => {
    for (const [name, body] of Object.entries(entries)) {
      fs.writeFileSync(path.join(dir, path.basename(name)), String(body ?? ''), { mode: 0o600 });
    }
  };
  let workDir = null;
  const cleanup = () => {
    for (const dir of [entriesDir, workDir]) {
      if (!dir) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
  try {
    writeFiles(entriesDir);
  } catch (error) {
    cleanup();
    return { ok: false, method: 'none', path: '', error: redactText(String(error?.message ?? error), 200) };
  }

  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch { /* 目录已存在/无权限，交给 tar 报错 */ }
  // tar 产物放到**输出目录下随机命名的私有目录**里再 rename 到目标：
  //   - 不用 predictible 的 `<out>.tmp-<pid>`（共享 /tmp 里可被预置软链，tar 会 O_TRUNC 跟随；
  //     2026-10-30 交叉审查 P2）；
  //   - 与目标同盘，rename 而不是跨文件系统拷贝。
  try { workDir = fs.mkdtempSync(path.join(path.dirname(abs), '.qq-diagnose-')); } catch { workDir = null; }
  const tarOut = workDir ? path.join(workDir, 'bundle.tar.gz') : path.join(entriesDir, 'bundle.tar.gz');
  const attempts = [];
  if (process.platform === 'win32') attempts.push(['--force-local', '-czf', tarOut, '-C', entriesDir, '.']);
  attempts.push(['-czf', tarOut, '-C', entriesDir, '.']);
  let ok = false;
  for (const args of attempts) {
    const result = spawnSync('tar', args, { timeout: 60000 });
    if (result.status === 0) { ok = true; break; }
  }
  if (ok) {
    try {
      if (workDir) {
        fs.renameSync(tarOut, abs);
      } else {
        // 输出目录不可写/跨盘：直接写目标（目标本身就是用户指定的路径）
        fs.copyFileSync(tarOut, abs);
      }
      try { fs.chmodSync(abs, 0o600); } catch { /* 平台不支持就算了 */ }
      cleanup();
      return { ok: true, method: 'tar.gz', path: abs };
    } catch (error) {
      cleanup();
      return writeFallback(abs, entries, error);
    }
  }
  cleanup();
  return writeFallback(abs, entries, null);
}

/** 回退：内容放进一个**新**目录，绝不删除任何已存在路径。 */
function writeFallback(abs, entries, error) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const dir of [`${abs}.d`, `${abs}.d-${stamp}`]) {
    if (fs.existsSync(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [name, body] of Object.entries(entries)) {
        fs.writeFileSync(path.join(dir, path.basename(name)), String(body ?? ''), { mode: 0o600 });
      }
      return { ok: true, method: 'dir', path: dir };
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  // 最后兜底：再建一个随机临时目录把内容放进去（不删，路径明确打印）
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diagnose-fallback-'));
    for (const [name, body] of Object.entries(entries)) {
      fs.writeFileSync(path.join(dir, path.basename(name)), String(body ?? ''), { mode: 0o600 });
    }
    return {
      ok: false,
      method: 'dir',
      path: dir,
      error: error ? redactText(String(error?.message ?? error), 200) : '没有可写的输出位置'
    };
  } catch {
    return {
      ok: false,
      method: 'none',
      path: '',
      error: error ? redactText(String(error?.message ?? error), 200) : '没有可写的输出位置'
    };
  }
}
