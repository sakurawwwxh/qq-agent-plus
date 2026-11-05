// 备份/恢复这类“会停服务、会覆盖数据目录”的维护任务共用的小工具。
//
// 两件事：
//   1. DATA_DIR/.maintenance.lock：同一数据目录同时只能有一个维护任务。备份和恢复
//      交错会打出跨时刻的 SQLite 副本，或者把恢复中的目录再打包一份。
//   2. 信号守卫：Ctrl+C/SIGHUP 默认会立即终止 Node，跳过 backup/restore 的 finally，
//      留下“服务停着 + 半套数据”。装上监听后先让当前同步步骤跑完，finally 里恢复服务，
//      再按中断返回；第二次信号才强制退出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
const TAKEOVER_STALE_MS = 60_000;

function readOwner(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但不属于当前用户；其他错误（ESRCH）按已退出处理。
    return error?.code === 'EPERM';
  }
}

function isStale(owner, file, now, staleMs) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return true; }
  if (!owner) return now - mtime > 60_000;   // 写了一半/损坏的锁：一分钟后可接管
  const startedAt = Number(owner.startedAt) || 0;
  // 没有 startedAt 的旧锁/手写锁按文件 mtime 算年龄，否则跨主机的锁永远不过期。
  if (now - (startedAt || mtime) > staleMs) return true;
  // 只有同主机才能可靠地用 pid 判断存活；跨主机的锁交给上面的时间上限。
  if (String(owner.hostname || '') === os.hostname() && !pidAlive(Number(owner.pid))) return true;
  return false;
}

/** 接管锁本身也要互斥：两个进程同时判断“旧锁过期”时，只有一个能拿到 takeover。 */
function acquireTakeover(file, kind) {
  const takeover = `${file}.takeover`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(takeover, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({
          pid: process.pid, hostname: os.hostname(), kind: `${kind}:takeover`, startedAt: Date.now()
        }));
      } finally {
        try { fs.closeSync(fd); } catch { /* 已关闭 */ }
      }
      return takeover;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!isStale(readOwner(takeover), takeover, Date.now(), TAKEOVER_STALE_MS)) return null;
      try { fs.rmSync(takeover, { force: true }); } catch { /* 被别的进程先接管 */ }
    }
  }
  return null;
}

function describe(owner) {
  if (!owner) return '未知持有者';
  const who = owner.pid ? `pid ${owner.pid}` : '未知 pid';
  return `${owner.kind || '维护任务'}（${who}${owner.hostname ? ` @ ${owner.hostname}` : ''}）`;
}

/**
 * 获取维护锁。拿不到时抛 E_MAINTENANCE_BUSY；持有者已退出/超时则自动接管。
 * @returns {{file: string, owner: object, release: () => void}}
 */
export function acquireMaintenanceLock(dataDir, { kind = 'maintenance', staleMs = DEFAULT_STALE_MS } = {}) {
  // 不创建 dataDir：恢复的目标目录可能本来不存在，提前建出来会被 hadPrevious 误判成
  // “有旧数据”，多留一份空的 .pre-restore。只保证父目录在。
  let realDir = path.resolve(dataDir);
  fs.mkdirSync(path.dirname(realDir), { recursive: true });
  // 锁放在数据目录的**同级**而不是目录内：恢复会把整个数据目录 rename 成 .pre-restore，
  // 锁跟着搬走就会在恢复中途“消失”，另一个备份可能趁机进来。软链先解析到真实目录，
  // 保证备份与恢复拿的是同一把锁。
  try { realDir = fs.realpathSync(realDir); } catch { /* 目录不存在时按原路径 */ }
  const file = path.join(path.dirname(realDir), `.${path.basename(realDir)}.maintenance.lock`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const owner = { pid: process.pid, hostname: os.hostname(), kind, startedAt: Date.now() };
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
      } catch (error) {
        try { fs.closeSync(fd); } catch { /* 已关闭 */ }
        try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
        throw error;
      }
      try { fs.closeSync(fd); } catch { /* 已关闭 */ }
      let released = false;
      return {
        file,
        owner,
        release() {
          if (released) return;
          released = true;
          try {
            const current = readOwner(file);
            // 只删自己的锁：读不出来/已被接管时不删，交给下次 stale 接管。
            if (current && current.pid === owner.pid && current.hostname === owner.hostname
              && current.startedAt === owner.startedAt) fs.rmSync(file, { force: true });
          } catch { /* 删不掉交给下次 stale 接管 */ }
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = readOwner(file);
      if (!isStale(owner, file, Date.now(), staleMs)) {
        const busy = new Error(`数据目录正在被另一个维护任务占用：${describe(owner)}`);
        busy.code = 'E_MAINTENANCE_BUSY';
        busy.owner = owner;
        throw busy;
      }
      // 先抢 takeover 再删旧锁：两个进程同时判断“过期”时，只有一个能进入删除段，
      // 避免 A 删旧锁、B 随后又把 A 刚建的新锁删掉。
      const takeover = acquireTakeover(file, kind);
      if (!takeover) continue;
      try {
        const current = readOwner(file);
        if (isStale(current, file, Date.now(), staleMs)) {
          try { fs.rmSync(file, { force: true }); } catch { /* 被别的进程先接管 */ }
        }
      } finally {
        try { fs.rmSync(takeover, { force: true }); } catch { /* 忽略 */ }
      }
    }
  }
  const busy = new Error('数据目录的维护锁反复被抢占，请稍后重试');
  busy.code = 'E_MAINTENANCE_BUSY';
  throw busy;
}

/**
 * 安装 SIGINT/SIGTERM/SIGHUP 守卫。第一次信号只记录，让当前备份/恢复走完 finally；
 * 第二次信号恢复默认行为（立即退出），避免收尾卡住时无法 Ctrl+C。
 */
export function createSignalGuard({ log = () => {} } = {}) {
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let signal = '';
  let hits = 0;
  const handler = (name) => {
    hits += 1;
    if (hits > 1) {
      process.exit(130);
      return;
    }
    signal = name;
    log(`收到 ${name}：等当前步骤结束后中止（再按一次强制退出）`);
  };
  for (const name of names) process.on(name, handler);
  return {
    get interrupted() { return Boolean(signal); },
    get signal() { return signal; },
    throwIfInterrupted() {
      if (!signal) return;
      const error = new Error(`收到 ${signal}，已中止`);
      error.code = 'E_INTERRUPTED';
      throw error;
    },
    dispose() {
      for (const name of names) process.removeListener(name, handler);
    }
  };
}
