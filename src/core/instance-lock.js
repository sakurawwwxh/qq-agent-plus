// 数据目录单实例锁（2026-10-31 复审）。
//
// 背景：两个进程共用一个 data 目录会同时写 messages.sqlite / 会话索引 / 插件目录，
// 还会让效果账本的"单进程在途"前提失效。锁必须在**打开存储之前**拿到，
// 否则第二个进程虽然最终被拒，也已经做过迁移/清理/索引重写。
//
// 原子性：
// - 锁内容先写进同目录的唯一临时文件并 fsync，再用 linkSync 原子发布到锁名
//   （目标已存在即 EEXIST）；不会出现"锁文件已创建但内容还没写"的空窗口。
// - 陈旧锁接管用 renameSync 到唯一名字：并发接管时只有一个进程 rename 成功。
// - 读不到内容且文件很新 → 视为"正在创建"，短暂等待后重试，不立即判陈旧。
//
// 语义：
// - 锁文件 <DATA_DIR>/.server.lock，内容 { pid, hostname, startedAt }；
// - 同机且 pid 仍存活 → 拒绝启动（E_INSTANCE_LOCKED）；
// - 同机 pid 已不存在、或锁文件损坏且已过窗口期 → 自动接管；
// - 不同主机（共享盘）→ 一律拒绝，不猜别的机器上的 pid；
// - 同进程可重入（测试/脚本会创建多个 createApp），跨进程严格互斥。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const LOCK_NAME = '.server.lock';
// 空/半写锁在这个窗口内视为"另一个进程正在创建"，不抢。
const FRESH_LOCK_GRACE_MS = 5000;
const MAX_ATTEMPTS = 55;   // ≈ FRESH_LOCK_GRACE_MS / 100ms + 余量
const activeLocks = new Map();   // resolvedFile -> { count }

function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* 不支持时直接继续 */ }
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function removeOwnLock(file) {
  const holder = readHolder(file);
  if (!holder || Number(holder.pid) !== process.pid
    || String(holder.hostname || '') !== os.hostname()) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

function releaseLock(file) {
  const state = activeLocks.get(file);
  if (!state) return false;
  state.count -= 1;
  if (state.count > 0) return true;
  activeLocks.delete(file);
  return removeOwnLock(file);
}

function lockFsError(action, file, error) {
  const wrapped = new Error(
    `无法${action}：${file}（${error?.message ?? error}）。请确认数据目录存在且当前用户可写。`
  );
  wrapped.code = error?.code || 'E_INSTANCE_LOCK_ERROR';
  wrapped.cause = error;
  return wrapped;
}

function makeHandle(file) {
  return { file, release: () => releaseLock(file) };
}

let exitHookInstalled = false;
/** 进程正常退出/未捕获异常走 exit 时兜底删锁；SIGKILL/OOM 走不到，由 self-pid 规则接管。 */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const file of [...activeLocks.keys()]) {
      try { removeOwnLock(file); } catch { /* 忽略 */ }
    }
    activeLocks.clear();
  });
}

/** 判断锁文件状态：absent / live / foreign / stale / transient。 */
function lockState(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { state: 'absent', holder: null, stat: null }; }
  const holder = readHolder(file);
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) {
    const age = Date.now() - Number(stat.mtimeMs || 0);
    return { state: age >= FRESH_LOCK_GRACE_MS ? 'stale' : 'transient', holder, stat };
  }
  if (holder.hostname && String(holder.hostname) !== os.hostname()) return { state: 'foreign', holder, stat };
  // 同 PID：只可能是本进程里没有登记的遗留锁（上一次容器生命周期 / 同一 PID namespace
  // 里重启，Docker + init 时 node 常见为 PID 2）。进程内正在使用的锁会在 acquire 入口
  // 走 activeLocks 重入，不会到这里。
  if (Number(holder.pid) === process.pid) return { state: 'stale', holder, stat, selfPid: true };
  try {
    process.kill(holder.pid, 0);
    return { state: 'live', holder, stat };
  } catch (error) {
    // ESRCH = 进程不存在；EPERM 等一律按"可能还活着"处理（fail-closed）。
    return { state: error?.code === 'ESRCH' ? 'stale' : 'live', holder, stat };
  }
}

/** 先写临时文件，再原子发布到锁名。返回 true=拿到，false=已存在（走状态判断）。 */
function publishLock(file) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const payload = JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: Date.now() });
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try { fs.chmodSync(tmp, 0o600); } catch { /* 某些文件系统不支持 */ }
    const tmpStat = fs.statSync(tmp);
    try {
      fs.linkSync(tmp, file);
      // 发布后再核对一次：并发的陈旧锁接管可能刚把我们的锁名 rename 走。
      let published;
      try { published = fs.statSync(file); } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return false;
        throw error;
      }
      if (Number(published.ino) !== Number(tmpStat.ino)
        || Number(published.dev) !== Number(tmpStat.dev)) return false;
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      // 不支持硬链接的文件系统（部分 FAT/网络盘）：退回 O_EXCL 创建。
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(error?.code)) throw error;
      let lockFd;
      try {
        lockFd = fs.openSync(file, 'wx', 0o600);
      } catch (openError) {
        if (openError?.code === 'EEXIST') return false;
        throw openError;
      }
      let ownStat = null;
      let failure = null;
      try {
        fs.writeSync(lockFd, payload);
        fs.fsyncSync(lockFd);
        ownStat = fs.fstatSync(lockFd);
        const pathStat = fs.statSync(file);
        if (Number(ownStat.ino) !== Number(pathStat.ino)
          || Number(ownStat.dev) !== Number(pathStat.dev)) return false;
      } catch (error) {
        failure = error;
      } finally {
        try { fs.closeSync(lockFd); } catch { /* ignore */ }
      }
      if (failure) {
        // fd 关掉后再清理（Windows 不允许删除打开中的文件）；只删自己创建的那个 inode。
        try {
          if (ownStat) {
            const atPath = fs.statSync(file);
            if (Number(ownStat.ino) === Number(atPath.ino) && Number(ownStat.dev) === Number(atPath.dev)) {
              fs.unlinkSync(file);
            }
          }
        } catch { /* 已被替换/已删除 */ }
        throw failure;
      }
      return true;
    }
  } finally {
    if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* 已 link 或未创建 */ }
  }
}

/**
 * 原子接管陈旧锁：rename 成功者唯一。
 * rename 之后必须验证移走的确实是**我们观察到的那个陈旧锁**：并发场景下
 * 另一个进程可能已经接管并发布了新活锁，直接删掉会双持有（2026-10-31 复核 P1）。
 * 不是同一个文件时尽量原样 link 回去，然后由调用方重试/报错。
 */
function takeOverStale(file, expected) {
  const moved = `${file}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, moved);
  } catch (error) {
    if (['ENOENT', 'EPERM', 'EBUSY'].includes(error?.code)) return false;
    throw error;
  }
  let movedStat = null;
  try { movedStat = fs.statSync(moved); } catch { /* 下面按不一致处理 */ }
  const holder = readHolder(moved);
  const sameFile = Boolean(movedStat && expected?.stat
    && Number(movedStat.ino) === Number(expected.stat.ino)
    && Number(movedStat.dev) === Number(expected.stat.dev));
  const sameHolder = expected?.holder
    ? Boolean(holder
      && Number(holder.pid) === Number(expected.holder.pid)
      && String(holder.hostname || '') === String(expected.holder.hostname || ''))
    : !holder;
  if (!sameFile || !sameHolder) {
    // 移走的是别人刚发布的活锁：尽量放回去，绝不继续 publish。
    let restored = false;
    try { fs.linkSync(moved, file); restored = true; } catch { /* 锁名已被第三个进程占用 */ }
    try { fs.unlinkSync(moved); } catch { /* ignore */ }
    return restored ? 'restored' : 'lost';
  }
  try { fs.unlinkSync(moved); } catch { /* ignore */ }
  return 'taken';
}

/**
 * 获取数据目录锁。成功返回 { file, release() }；失败抛 E_INSTANCE_LOCKED。
 * @param {string} dataDir
 * @param {{log?: Function}} [options]
 */
export function acquireInstanceLock(dataDir, { log = () => {} } = {}) {
  const file = path.resolve(path.join(dataDir, LOCK_NAME));
  const existing = activeLocks.get(file);
  if (existing) {
    existing.count += 1;
    return makeHandle(file);
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw lockFsError('创建数据目录', dataDir, error);
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let published = false;
    try {
      published = publishLock(file);
    } catch (error) {
      throw lockFsError('写入实例锁', file, error);
    }
    if (published) {
      activeLocks.set(file, { count: 1 });
      installExitHook();
      return makeHandle(file);
    }
    const { state, holder, stat } = lockState(file);
    if (state === 'live' || state === 'foreign') {
      const who = holder
        ? `pid ${holder.pid}${holder.hostname ? ` @ ${holder.hostname}` : ''}`
        : '无法确认持有者';
      const error = new Error(
        `数据目录已被另一个实例占用（${who}）：${file}。`
        + '同一数据目录只能跑一个实例；确认旧进程已退出后可删除该锁文件再启动。'
      );
      error.code = 'E_INSTANCE_LOCKED';
      error.holder = holder;
      throw error;
    }
    if (state === 'transient') {
      sleep(100);
      continue;
    }
    if (state === 'stale') {
      log(`[lock] 接管陈旧实例锁：${file}（${holder?.pid ? `pid ${holder.pid} 已不存在` : '内容损坏且已过窗口期'}）`);
      const outcome = takeOverStale(file, { holder, stat });
      if (outcome === 'lost') {
        // 我们把别人刚发布的活锁移走了、且锁名已被第三个进程占用：本次 acquire 必须终止，
        // 不能再 publish（否则会与那个仍活着但暂时“无锁文件”的实例双持有）。
        const error = new Error(`并发接管锁失败，请重试：${file}`);
        error.code = 'E_INSTANCE_LOCKED';
        throw error;
      }
    }
  }
  const error = new Error(`无法获取数据目录锁（并发争用）：${file}`);
  error.code = 'E_INSTANCE_LOCKED';
  throw error;
}


/**
 * 只读查看数据目录锁状态（运维 restore 前检查用）。
 * @returns {{file: string, state: 'absent'|'live'|'foreign'|'stale'|'transient', holder: object|null}}
 */
export function inspectInstanceLock(dataDir) {
  const file = path.resolve(path.join(dataDir, LOCK_NAME));
  const { state, holder } = lockState(file);
  return { file, state, holder };
}
