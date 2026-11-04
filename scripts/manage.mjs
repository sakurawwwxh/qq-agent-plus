import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase, backup } from '../src/core/sqlite.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readJson(file, hint) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${hint} (${file}): ${error?.message ?? error}`);
  }
}
// 只按后缀判断会把普通文件当数据库打开（SQLITE_NOTADB 直接中断备份）。
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');
function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(SQLITE_MAGIC.length);
      return fs.readSync(fd, head, 0, head.length, 0) === head.length
        && head.equals(SQLITE_MAGIC);
    } finally { fs.closeSync(fd); }
  } catch {
    return false;
  }
}
const deploy = readJson(path.join(root, '.deployment.json'),
  'Cannot read the deployment record — run manage.sh from the installation directory (the one holding .deployment.json)');
// config.json 只在真正需要控制台 API/token 时才读：配置文件损坏时 stop/start/restart/logs
// 仍必须可用，否则恰好在最需要恢复的时候被卡死。
let cfgCache = null;
function getCfg() {
  if (!cfgCache) {
    cfgCache = readJson(path.join(deploy.data, 'config.json'), 'Cannot read the deployed configuration');
  }
  return cfgCache;
}
let baseCache = null;
function getBase() {
  if (baseCache) return baseCache;
  const rawHost = String(getCfg().server.host || '127.0.0.1');
  let host = rawHost === '0.0.0.0' ? '127.0.0.1' : (rawHost === '::' ? '::1' : rawHost);
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  baseCache = `http://${host}:${getCfg().server.port}`;
  return baseCache;
}
const command = process.argv[2] || 'status';
const systemctl = (action) => {
  const r = spawnSync('systemctl', ['--user', action, `${deploy.service}.service`, '--no-pager'], { stdio: 'inherit' });
  process.exitCode = r.status || 0;
};
async function api(route, body) {
  const res = await fetch(getBase() + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-console-token': getCfg().server.token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
  return result;
}
if (['start', 'stop', 'restart', 'status'].includes(command)) {
  systemctl(command);
} else if (command === 'logs') {
  spawnSync('journalctl', ['--user', '-u', `${deploy.service}.service`, '-n', '100', '--no-pager'], { stdio: 'inherit' });
} else if (command === 'token') {
  console.log(getCfg().server.token);
} else if (command === 'observe' || command === 'activate') {
  const active = command === 'activate';
  const confirm = process.argv.includes('--confirm-exclusive');
  if (active && !confirm) throw new Error('Stop/exclude the old instance first, then use activate --confirm-exclusive');
  console.log(await api('/api/runtime', { mode: active ? 'active' : 'observe',
    confirmExclusive: confirm, skipBacklog: active && !process.argv.includes('--with-backlog') }));
} else if (command === 'health') {
  console.log(JSON.stringify(await api('/api/status'), null, 2));
} else if (command === 'update-status') {
  console.log(JSON.stringify(await api('/api/auto-update/status'), null, 2));
} else if (command === 'update-now') {
  if (!process.argv.includes('--confirm')) {
    throw new Error('Use update-now --confirm');
  }
  console.log(JSON.stringify(await api('/api/auto-update/run', { confirm: true }), null, 2));
} else if (command === 'update-resume') {
  if (!process.argv.includes('--confirm')) {
    throw new Error('Use update-resume --confirm after configuring the administrator in the console');
  }
  console.log(JSON.stringify(await api('/api/auto-update/resume', {
    confirm: true,
    ownerUin: getCfg().autoUpdate?.ownerUin || '',
    intervalHours: getCfg().autoUpdate?.intervalHours || 6
  }), null, 2));
} else if (command === 'update-pause') {
  if (!process.argv.includes('--confirm')) throw new Error('Use update-pause --confirm');
  console.log(JSON.stringify(await api('/api/auto-update/pause', { confirm: true }), null, 2));
} else if (command === 'retry-failed' || command === 'resolve-held') {
  const key = process.argv[3];
  if (!/^(group|private):\d+$/.test(key || '') || !process.argv.includes('--confirm')) {
    throw new Error(`${command} group:123 --confirm (resolve-held acknowledges reviewed delivery; it does not resend)`);
  }
  console.log(await api(`/api/chats/${key.replace(':', '_')}/${command}`, { confirm: true }));
} else if (command === 'backup') {
  const target = process.argv[3];
  if (!target || fs.existsSync(target)) throw new Error('Provide a new backup directory');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  // 复制数据目录下的全部条目，只跳过可重建的临时物。写死清单会随功能增加而漏掉东西
  // （身份/关系/事故台账、daily-moments、群动态与主动发言状态都曾经在清单之外）。
  const skip = new Set(['deploy-backups', 'update-work', 'update-repository.git', '.server.lock']);
  const copyTree = async (srcDir, dstDir) => {
    fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const { name } = entry;
      if (skip.has(name) || name.startsWith('.') || name.endsWith('.lock')) continue;
      const src = path.join(srcDir, name);
      const dst = path.join(dstDir, name);
      // 所有 SQLite 库都走在线 backup API：identity/relationship/incident 以及嵌套的
      // living-memory/memory 库也可能开 WAL，直接 cpSync 会把 .sqlite/-wal/-shm 拆在不同时点。
      if (name.endsWith('.sqlite') && entry.isFile() && isSqliteFile(src)) {
        const db = openDatabase(src, { readOnly: true });
        try {
          await backup(db, dst);
          try { fs.chmodSync(dst, 0o600); } catch { /* 网络盘可能不支持 chmod */ }
        } finally { db.close(); }
        continue;
      }
      // 对应库的 WAL/SHM 由 backup API 合并进快照，不再单独复制。
      if (/\.sqlite-(wal|shm)$/.test(name)) continue;
      if (entry.isDirectory()) await copyTree(src, dst);
      else fs.copyFileSync(src, dst);
    }
  };
  await copyTree(deploy.data, target);
  console.log(`Backup saved to ${target}`);
} else {
  throw new Error('Commands: status start stop restart logs health token observe activate update-status update-now update-resume update-pause retry-failed resolve-held backup');
}
