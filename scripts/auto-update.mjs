import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  autoUpdateOwner,
  autoUpdatePaths,
  consumeAutoUpdateRequest,
  failureDetail,
  readAutoUpdateState,
  sanitizeUpdateError,
  writeAutoUpdateState
} from '../src/auto-update.js';
import {
  gitTransportPrefix,
  isRetryableUpdateNetworkError,
  normalizeUpdateNetworkSettings,
  retryUpdateOperation
} from '../src/update-network.js';
import { checkForUpdate, githubApiBase } from '../src/update-notice.js';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    'data-dir': { type: 'string' },
    service: { type: 'string' }
  }
});

const appDir = path.resolve(values['app-dir'] || path.resolve(import.meta.dirname, '..'));
const dataDir = path.resolve(values['data-dir'] || process.env.QQ_AGENT_DATA_DIR || path.join(appDir, 'data'));
const service = String(values.service || '').trim();
if (!service || !/^[A-Za-z0-9_-]+$/.test(service)) {
  throw new Error('--service is required and must be a valid systemd unit prefix');
}

const paths = autoUpdatePaths(dataDir);
const configFile = path.join(dataDir, 'config.json');
const deploymentFile = path.join(appDir, '.deployment.json');
let lockHandle = null;
// 只有真正抢到锁的那个进程才允许释放它。
// 抢锁失败的一方（UPDATE_BUSY 时 lockHandle 仍是 null）如果也走一遍释放，会把**胜出方**的
// 锁文件与它正在用的源码包一起删掉——随后第三个进程能进、它调 deploy.sh 又会被 .deploy.lock
// 挡住而判失败，disableOnFailure 打开时还会顺带把自动更新关掉（2026-09-29 审查 P1）。
let lockOwned = false;
let workDir = '';
let phase = 'startup';
let mode = 'scheduled';
let targetRevision = '';
let targetVersion = '';
let cfg = {};
let repository = '';
let branch = 'main';
let probeStartedAt = 0;
let networkSettings = normalizeUpdateNetworkSettings();
const notifyAttempts = Math.min(
  30,
  Math.max(1, Number(process.env.QQ_AGENT_UPDATE_NOTIFY_ATTEMPTS) || 30)
);
const notifyRetryMs = Math.min(
  10_000,
  Math.max(10, Number(process.env.QQ_AGENT_UPDATE_NOTIFY_RETRY_MS) || 1_000)
);

function readObject(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid object: ${path.basename(file)}`);
  }
  return parsed;
}

function writeObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function command(binary, args, {
  cwd = appDir,
  env = process.env,
  timeout = 20 * 60 * 1000,
  allowFailure = false
} = {}) {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 24 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (allowFailure) return result;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // 详情口径见 failureDetail：node --test 优先列 not ok 失败项，不拿输出结尾凑数
    const detail = failureDetail(result);
    const error = new Error(`${path.basename(binary)} ${args[0] || ''} failed`
      + `${detail ? `: ${detail}` : ` with exit ${result.status}`}`);
    error.status = result.status;
    error.stdout = String(result.stdout || '');
    error.stderr = String(result.stderr || '');
    error.command = `${binary} ${args.join(' ')}`;
    throw error;
  }
  return result;
}

function git(args, options = {}) {
  return command('git', args, options);
}

function networkGitArgs(args) {
  return [...gitTransportPrefix(networkSettings), ...args];
}

function commandFailure(binary, args, result) {
  if (result?.error) return result.error;
  // 与 command() 同一口径（见 failureDetail）：有 TAP 失败项就别拿输出结尾当详情
  const detail = failureDetail(result);
  const error = new Error(`${path.basename(binary)} ${args[0] || ''} failed`
    + `${detail ? `: ${detail}` : ` with exit ${result?.status}`}`);
  error.status = result?.status;
  error.stdout = String(result?.stdout || '');
  error.stderr = String(result?.stderr || '');
  error.command = `${binary} ${args.join(' ')}`;
  return error;
}

function revisionFromFile() {
  try {
    return fs.readFileSync(path.join(dataDir, 'deployed-revision'), 'utf8')
      .trim()
      .replace(/-dirty$/, '');
  } catch {
    return '';
  }
}

// 锁的陈旧宽限：只在"读不出属主 pid"和"接管互斥文件被遗留"两种情况下用。
// 5 分钟与 deploy.sh 的陈旧判据一致；定时器是 1 小时一次，实际不会因此误判并发。
const LOCK_STALE_MS = 5 * 60 * 1000;

function fileAgeMs(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return Infinity; }
}

/**
 * 现在这把锁能不能接管？返回 { takeable, reason }。
 * reason 是要报给用户的话（不可接管时用），`takeable: true` 时为空串。
 */
function lockJudgement() {
  let owner = {};
  try { owner = readObject(paths.lock); } catch { /* 空/坏锁：走下面的宽限 */ }
  const pid = Number(owner.pid) || 0;
  if (pid > 0) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (signalError) {
      // EPERM 之类表示进程确实还在（只是不归我们管）→ 保守当作活着
      alive = signalError?.code !== 'ESRCH';
    }
    if (alive) return { takeable: false, reason: `Another update process is running (${pid})` };
    return { takeable: true, reason: '' };
  }
  // 读不出 pid：可能是刚 open('wx') 还没写完 JSON 的并发进程，也可能是写了一半被杀。
  // 前者不能抢，后者才该抢 —— 用时间分开（原来 pid=0 时直接抢，等于把并发进程的锁删掉）。
  if (fileAgeMs(paths.lock) < LOCK_STALE_MS) {
    return { takeable: false, reason: 'Another update process is starting' };
  }
  return { takeable: true, reason: '' };
}

/**
 * 接管一个没有活属主的锁。
 * 2026-10-01 审查：原来是裸的 unlinkSync + openSync('wx') —— 这两步不是原子对，两个进程同时
 * 判定"陈旧"时会互相删掉对方刚建好的锁，双双拿到"唯一"锁。改成先抢一个互斥文件（open 'wx'
 * 是原子的），只有赢家去删锁重建；互斥文件本身带陈旧兜底，否则持有者被 SIGKILL 会把
 * 自动更新永久钉在"有人在接管"上（和 pid 锁当初的坑一模一样）。
 */
function autoUpdateTryTakeOver() {
  const mutex = `${paths.lock}.takeover`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle = null;
    try {
      handle = fs.openSync(mutex, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (fileAgeMs(mutex) < LOCK_STALE_MS) return false;
      try { fs.unlinkSync(mutex); } catch { /* 别人已经清掉了 */ }
      continue;
    }
    try {
      // 拿到互斥后**再判一次**：判定与抢互斥之间可能被挂起，期间别的进程可能已经建好新锁
      // （它先判、再抢到互斥、跑完释放），这时照删就把人家正在用的锁删掉了（2026-10-01 审查 P2）。
      if (!lockJudgement().takeable) return false;
      try { fs.unlinkSync(paths.lock); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      lockHandle = fs.openSync(paths.lock, 'wx', 0o600);
      return true;
    } catch (error) {
      // 互斥在手却建不出锁：说明别的进程刚重建了锁（或拿到了它），这次就不抢了
      if (error?.code === 'EEXIST') return false;
      throw error;
    } finally {
      try { fs.closeSync(handle); } catch { /* ignore */ }
      try { fs.unlinkSync(mutex); } catch { /* ignore */ }
    }
  }
  return false;
}

function acquireLock() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    lockHandle = fs.openSync(paths.lock, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const judgement = lockJudgement();
    if (!judgement.takeable) {
      throw Object.assign(new Error(judgement.reason), { code: 'UPDATE_BUSY' });
    }
    if (!autoUpdateTryTakeOver()) {
      throw Object.assign(
        new Error('Another update process is taking over the lock'),
        { code: 'UPDATE_BUSY' }
      );
    }
  }
  try {
    fs.writeFileSync(lockHandle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  } catch (error) {
    // 半成品锁（没有 pid）会把下一个进程推进"宽限期"分支 —— 别把它留在盘上
    try { fs.closeSync(lockHandle); } catch { /* ignore */ }
    try { fs.unlinkSync(paths.lock); } catch { /* ignore */ }
    lockHandle = null;
    throw error;
  }
  lockOwned = true;
}


function releaseLock() {
  // 没抢到锁就什么都不动：锁文件、工作目录、源码包都不是这次运行的
  // （见上面 lockOwned 的说明；这条 if 之前是漏的，2026-09-29 审查 P1）
  if (!lockOwned) return;
  lockOwned = false;
  if (lockHandle !== null) {
    try { fs.closeSync(lockHandle); } catch { /* ignore */ }
    lockHandle = null;
  }
  try { fs.unlinkSync(paths.lock); } catch { /* ignore */ }
  if (workDir) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    workDir = '';
  }
  // 源码包与工作目录同级（data/update-work/）：中途失败或被杀时别留下几十 MB 的临时包
  try {
    for (const name of fs.readdirSync(paths.workRoot)) {
      if (/^source-[0-9a-f]{12}\.tar\.gz$/.test(name)) {
        fs.rmSync(path.join(paths.workRoot, name), { force: true });
      }
    }
  } catch { /* 目录不存在或删不掉都不影响 */ }
}

function disableAutoUpdate() {
  const current = readObject(configFile);
  current.autoUpdate = {
    ...(current.autoUpdate || {}),
    enabled: false
  };
  writeObject(configFile, current);
  cfg = current;
  return current;
}

async function notifyFailure(currentConfig) {
  const host = ['0.0.0.0', '::', '[::]'].includes(String(currentConfig.server?.host || ''))
    ? '127.0.0.1'
    : String(currentConfig.server?.host || '127.0.0.1');
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `http://${displayHost}:${Number(currentConfig.server?.port) || 3210}/api/auto-update/notify-pending`;
  for (let attempt = 0; attempt < notifyAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-console-token': String(currentConfig.server?.token || '')
        },
        body: '{}',
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) return true;
    } catch {
      // A failed deployment may still be restoring the Agent.
    }
    await new Promise((resolve) => setTimeout(resolve, notifyRetryMs));
  }
  return false;
}

function ensureRepository(cache, remoteRepository) {
  fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(cache)) {
    git(['init', '--bare', cache]);
  }
  const remotes = git(['--git-dir', cache, 'remote']).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (remotes.includes('origin')) {
    git(['--git-dir', cache, 'remote', 'set-url', 'origin', remoteRepository]);
  } else {
    git(['--git-dir', cache, 'remote', 'add', 'origin', remoteRepository]);
  }
}

function validateCheckout(directory) {
  for (const file of [
    'package.json',
    'package-lock.json',
    'deploy.sh',
    'src/server.js',
    'scripts/auto-update.mjs'
  ]) {
    if (!fs.existsSync(path.join(directory, file))) {
      throw new Error(`Downloaded revision is incomplete: missing ${file}`);
    }
  }
  const pkg = readObject(path.join(directory, 'package.json'));
  // 兼容改名前后的仓库标识：本项目包名是 qq-agent-plus，早先的部署仍可能是 qq-agent。
  if (!['qq-agent', 'qq-agent-plus'].includes(String(pkg.name || ''))) {
    throw new Error('Downloaded repository is not a QQ Agent project');
  }
}

function retryLog(scope) {
  return ({ nextAttempt, delayMs, error }) => {
    const text = sanitizeUpdateError(error);
    console.warn(
      `[auto-update] ${scope} failed; retry ${nextAttempt}/${networkSettings.networkRetries + 1}`
      + ` in ${delayMs}ms: ${text}`
    );
  };
}

async function probeConnectivity() {
  probeStartedAt = Date.now();
  const timeout = networkSettings.connectivityTimeoutSeconds * 1000;
  const result = await retryUpdateOperation(async () => {
    const args = networkGitArgs([
      'ls-remote',
      '--exit-code',
      '--heads',
      repository,
      `refs/heads/${branch}`
    ]);
    const probe = git(args, { allowFailure: true, timeout });
    if (probe.error) throw probe.error;
    if (probe.status === 2) {
      throw Object.assign(
        new Error(`Automatic update branch not found: ${branch}`),
        { code: 'UPDATE_BRANCH_NOT_FOUND', retryable: false, status: 2 }
      );
    }
    if (probe.status !== 0) throw commandFailure('git', args, probe);
    const line = String(probe.stdout || '').trim().split(/\r?\n/)[0] || '';
    const match = /^([0-9a-f]{40})\s+refs\/heads\//.exec(line);
    if (!match) {
      throw Object.assign(
        new Error(`GitHub returned no valid revision for branch ${branch}`),
        { retryable: false }
      );
    }
    return match[1];
  }, {
    retries: networkSettings.networkRetries,
    baseDelayMs: networkSettings.retryBaseMs,
    maxDelayMs: networkSettings.retryMaxMs,
    isRetryable: isRetryableUpdateNetworkError,
    onRetry: retryLog('connectivity probe')
  });
  const connectivity = {
    status: 'ok',
    transport: 'git',
    checkedAt: Date.now(),
    attempts: result.attempts,
    latencyMs: Date.now() - probeStartedAt,
    repository,
    branch,
    revision: result.value,
    error: ''
  };
  writeAutoUpdateState(dataDir, { connectivity });
  return connectivity;
}

async function fetchReleaseTag(tag) {
  const timeout = networkSettings.fetchTimeoutSeconds * 1000;
  return retryUpdateOperation(async () => {
    git(networkGitArgs([
      '--git-dir',
      paths.repository,
      'fetch',
      '--force',
      '--prune',
      '--depth=1',
      'origin',
      `+refs/tags/${tag}:refs/tags/${tag}`
    ]), { timeout });
    return true;
  }, {
    retries: networkSettings.networkRetries,
    baseDelayMs: networkSettings.retryBaseMs,
    maxDelayMs: networkSettings.retryMaxMs,
    isRetryable: isRetryableUpdateNetworkError,
    onRetry: retryLog('git fetch')
  });
}

/* ══════════════════════════════════════════════════════════════
   第二条下载通道：GitHub API + codeload 源码包
   ══════════════════════════════════════════════════════════════

   有些网络到 github.com 的 git 通道是黑洞（TCP 443 连上就卡住，或 ls-remote
   直接超时），但 api.github.com 与 codeload.github.com 是好的。这条通道用
   「API 解析 tag/branch → commit sha，再拉该 commit 的 tar.gz」把同样的源码取回来，
   取回之后的流程（npm ci → 单元测试 → deploy.sh）与 git 通道完全一致。

   安全性：两条通道都是 HTTPS、都以 GitHub 给出的 commit sha 为锚点；tarball 的
   地址里带的就是 API 解析出来的那个 sha，信任级别与 git fetch 一致。
   压缩包大小设上限，避免异常地址把内存吃满。
*/

const CODELOAD_DEFAULT = 'https://codeload.github.com';
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const TOO_LARGE = 'Source archive is larger than the allowed limit';

/** https://github.com/<owner>/<repo>.git → { owner, repo }；解析不了返回 null。 */
function repositorySlug() {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repository);
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** codeload 基地址：QQ_AGENT_CODELOAD 供测试桩/镜像覆盖。 */
function codeloadBase() {
  return String(process.env.QQ_AGENT_CODELOAD || CODELOAD_DEFAULT).replace(/\/+$/, '');
}

/** 读一个 GitHub API JSON；非 2xx 抛可重试错误（5xx/429）或不可重试错误。 */
async function githubApiJson(pathname, timeoutMs) {
  const res = await fetch(`${githubApiBase()}${pathname}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'qq-agent-plus-auto-update' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const error = new Error(`GitHub API ${res.status} for ${pathname}`);
    error.retryable = res.status >= 500 || res.status === 429;
    throw error;
  }
  return res.json();
}

/** git 通道探不通时的第二探：用 API 问同一个仓库/分支。 */
async function probeConnectivityViaApi() {
  const slug = repositorySlug();
  if (!slug) return null;
  probeStartedAt = Date.now();
  const timeout = networkSettings.connectivityTimeoutSeconds * 1000;
  const result = await retryUpdateOperation(async () => {
    const data = await githubApiJson(
      `/repos/${slug.owner}/${slug.repo}/commits/${encodeURIComponent(branch)}`,
      timeout
    );
    const sha = String(data?.sha || '').trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw Object.assign(new Error(`GitHub API returned no valid revision for ${branch}`), {
        retryable: false
      });
    }
    return sha;
  }, {
    retries: networkSettings.networkRetries,
    baseDelayMs: networkSettings.retryBaseMs,
    maxDelayMs: networkSettings.retryMaxMs,
    isRetryable: isRetryableUpdateNetworkError,
    onRetry: retryLog('api probe')
  });
  return {
    status: 'ok',
    transport: 'api',
    checkedAt: Date.now(),
    attempts: result.attempts,
    latencyMs: Date.now() - probeStartedAt,
    repository,
    branch,
    revision: result.value,
    error: ''
  };
}

/** 用 API 把 tag 解析成 commit sha（tag 也能当 ref 用）。 */
async function resolveTagRevisionViaApi(tag) {
  const slug = repositorySlug();
  if (!slug) throw new Error('Automatic update repository is not an approved GitHub HTTPS URL');
  const timeout = networkSettings.connectivityTimeoutSeconds * 1000;
  const result = await retryUpdateOperation(async () => {
    const data = await githubApiJson(
      `/repos/${slug.owner}/${slug.repo}/commits/${encodeURIComponent(tag)}`,
      timeout
    );
    const sha = String(data?.sha || '').trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw Object.assign(new Error(`Release ${tag} did not resolve to a valid revision`), {
        retryable: false
      });
    }
    return sha;
  }, {
    retries: networkSettings.networkRetries,
    baseDelayMs: networkSettings.retryBaseMs,
    maxDelayMs: networkSettings.retryMaxMs,
    isRetryable: isRetryableUpdateNetworkError,
    onRetry: retryLog('api resolve')
  });
  return result.value;
}

/** 边读边算字节数：超过上限立刻断开，别先吃满内存再检查。 */
async function readCappedBody(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) {
    const fallback = Buffer.from(await res.arrayBuffer());
    if (fallback.length > maxBytes) throw Object.assign(new Error(TOO_LARGE), { retryable: false });
    return fallback;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error(TOO_LARGE), { retryable: false });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 已经取消/关闭 */ }
  }
  return Buffer.concat(chunks, total);
}

/** 拉某个 commit 的源码包并解开到 workDir（顶层目录用 --strip-components=1 去掉）。 */
async function materializeFromApi(workDir, revision) {
  const slug = repositorySlug();
  if (!slug) throw new Error('Automatic update repository is not an approved GitHub HTTPS URL');
  const url = `${codeloadBase()}/${slug.owner}/${slug.repo}/tar.gz/${revision}`;
  // 默认基地址必须是 HTTPS。把 QQ_AGENT_CODELOAD 配成 http:// 还不够，必须再显式设
  // QQ_AGENT_CODELOAD_ALLOW_INSECURE=1 才放行明文：这个地址决定"哪份源码会被 npm ci +
  // 测试 + deploy.sh 以服务账号跑起来"，等于允许执行任意代码，不该由一次顺手配的镜像地址
  // 静默打开（2026-09-29 审查 P2）。测试桩/内网镜像按需显式打开。
  const insecureBase = codeloadBase().startsWith('http://');
  const allowInsecure = insecureBase
    && /^(1|true|yes)$/i.test(String(process.env.QQ_AGENT_CODELOAD_ALLOW_INSECURE || ''));
  if (insecureBase && !allowInsecure) {
    throw Object.assign(
      new Error('QQ_AGENT_CODELOAD must use HTTPS (set QQ_AGENT_CODELOAD_ALLOW_INSECURE=1 to allow plaintext mirrors)'),
      { retryable: false }
    );
  }
  const timeout = networkSettings.fetchTimeoutSeconds * 1000;
  // retryUpdateOperation 返回 { value, attempts }，别把包装对象当数据用
  const downloaded = await retryUpdateOperation(async () => {
    const res = await fetch(url, {
      headers: { 'user-agent': 'qq-agent-plus-auto-update' },
      signal: AbortSignal.timeout(timeout)
    });
    if (!res.ok) {
      const error = new Error(`codeload ${res.status} for ${revision}`);
      error.retryable = res.status >= 500 || res.status === 429;
      throw error;
    }
    // 镜像/代理可能把请求改道，源码包必须是 HTTPS 取回来的（显式配 http 镜像时除外）
    if (!allowInsecure && new URL(res.url || url).protocol !== 'https:') {
      throw Object.assign(new Error('Source archive must be fetched over HTTPS'), { retryable: false });
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_TARBALL_BYTES) {
      throw Object.assign(new Error(TOO_LARGE), { retryable: false });
    }
    return readCappedBody(res, MAX_TARBALL_BYTES);
  }, {
    retries: networkSettings.networkRetries,
    baseDelayMs: networkSettings.retryBaseMs,
    maxDelayMs: networkSettings.retryMaxMs,
    isRetryable: isRetryableUpdateNetworkError,
    onRetry: retryLog('codeload download')
  });
  const archive = path.join(path.dirname(workDir), `source-${revision.slice(0, 12)}.tar.gz`);
  fs.writeFileSync(archive, downloaded.value, { mode: 0o600 });
  try {
    command('tar', ['-xzf', archive, '-C', workDir, '--strip-components=1'], {
      timeout: 10 * 60 * 1000
    });
  } catch (error) {
    // tar 缺失时 spawnSync 只给 ENOENT，补一句人话（tar 是本项目的部署依赖）
    if (error?.code === 'ENOENT') {
      throw new Error('目标主机缺少 tar，无法解开源码包（docs/LINUX.md 的依赖清单包含 tar）');
    }
    throw error;
  } finally {
    try { fs.rmSync(archive, { force: true }); } catch { /* 临时文件删不掉不影响部署 */ }
  }
  return url;
}

/**
 * 解析 tag → commit sha：先试首选的下载通道，失败再试另一条。
 * 只做解析（不下载源码）——"已经是最新"的常见路径不该白拉一个源码包。
 * 返回 { revision, transport }；两条都不通时抛出最后一条的错误。
 */
async function resolveTargetRevision(tag, preferredTransport) {
  const lanes = preferredTransport === 'api' ? ['api', 'git'] : ['git', 'api'];
  const failures = [];
  for (const [index, lane] of lanes.entries()) {
    try {
      let revision = '';
      if (lane === 'api') {
        revision = await resolveTagRevisionViaApi(tag);
      } else {
        await fetchReleaseTag(tag);
        revision = git([
          '--git-dir',
          paths.repository,
          'rev-parse',
          `refs/tags/${tag}^{commit}`
        ]).stdout.trim();
      }
      if (!/^[0-9a-f]{40}$/.test(revision)) {
        throw new Error(`Release ${tag} did not resolve to a valid revision`);
      }
      return { revision, transport: lane };
    } catch (error) {
      failures.push({ lane, error });
      if (index === lanes.length - 1) break;
      console.error(`[auto-update] ${lane} 通道解析失败（${sanitizeUpdateError(error)}），改走另一条通道`);
    }
  }
  throw combinedTransportError('解析部署目标', failures);
}

/** 把已经解析好的 revision 落到 workDir：同样两条通道依次尝试。 */
async function materializeSource(workDir, revision, preferredTransport, tag) {
  const lanes = preferredTransport === 'api' ? ['api', 'git'] : ['git', 'api'];
  const failures = [];
  for (const [index, lane] of lanes.entries()) {
    // 换通道重来前把工作目录清干净，避免上一条通道的残留文件混进去
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    try {
      if (lane === 'api') {
        await materializeFromApi(workDir, revision);
      } else {
        // 走 git 取源码时，对象可能不在本地缓存里（revision 是 API 通道解析出来的）：
        // 先按 tag fetch 一次再 checkout，否则必然 "reference is not a tree"。
        const hasObject = git([
          '--git-dir',
          paths.repository,
          'cat-file',
          '-e',
          `${revision}^{commit}`
        ], { allowFailure: true });
        if (hasObject.status !== 0 && tag) await fetchReleaseTag(tag);
        git([
          '--git-dir',
          paths.repository,
          '--work-tree',
          workDir,
          'checkout',
          '--force',
          revision,
          '--',
          '.'
        ]);
      }
      return lane;
    } catch (error) {
      failures.push({ lane, error });
      if (index === lanes.length - 1) break;
      console.error(`[auto-update] ${lane} 通道取源码失败（${sanitizeUpdateError(error)}），改走另一条通道`);
    }
  }
  throw combinedTransportError('取源码', failures);
}

/**
 * 两条通道都失败时的错误：把两条的原因都带上。
 * 只报最后一条会把真正的病因（比如 API 限流）藏起来，排障方向会被带偏。
 */
function combinedTransportError(stage, failures) {
  const detail = failures
    .map(({ lane, error }) => `${lane}: ${sanitizeUpdateError(error)}`)
    .join('；');
  const error = new Error(`${stage}失败（两条下载通道都不通）—— ${detail}`);
  error.cause = failures[0]?.error;
  return error;
}

/**
 * 本次要部署的 Release tag；没有可部署的发布版本时返回 ''。
 * 判定口径与控制台弹窗共用 checkForUpdate：branch 上的普通提交永远不部署。
 */
function releaseTarget(notice, ignoredVersion = '') {
  if (!notice || typeof notice !== 'object') return '';
  const version = String(notice.version || '').trim();
  if (!version) return '';
  // 控制台"忽略该版本"以前只压弹窗，定时更新照样部署；这里让它真正生效
  if (ignoredVersion && version === String(ignoredVersion).trim()) return '';
  if (notice.available === true) return version;
  // unknown-deployed：当前部署不是 git 提交（例如压缩包安装），没有可比较的基线，
  // 直接安装最新 Release。
  if (notice.reason === 'unknown-deployed') return version;
  return '';
}

async function run() {
  acquireLock();
  const request = consumeAutoUpdateRequest(dataDir);
  mode = request?.mode || 'scheduled';
  cfg = readObject(configFile);
  const settings = cfg.autoUpdate || {};
  networkSettings = normalizeUpdateNetworkSettings(settings);
  const previous = readAutoUpdateState(dataDir);
  // disableOnFailure 落下 enabled:false 后，控制台的任何一次保存都可能把主进程内存里的旧配置
  // （enabled:true）写回文件、把自停悄悄抹掉 —— 升级自停还得认数据目录里的 autoDisabled，
  // 它只由更新器自己与被显式 resume 的控制台接口读写（2026-10-07 复审 P2）。
  if (mode === 'scheduled' && (settings.enabled !== true || previous.autoDisabled === true)) return;

  const now = Date.now();
  const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
  if (
    mode === 'scheduled'
    && Number(previous.lastCheckAt || 0) > 0
    && now < Number(previous.lastCheckAt) + intervalMs
  ) {
    return;
  }

  repository = String(settings.repository || '').trim();
  branch = String(settings.branch || 'main').trim();
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(repository)) {
    throw new Error('Automatic update repository is not an approved GitHub HTTPS URL');
  }
  if (
    !/^[A-Za-z0-9._/-]{1,100}$/.test(branch)
    || branch.startsWith('-')
    || branch.includes('..')
    || branch.endsWith('/')
  ) {
    throw new Error('Automatic update branch is invalid');
  }
  const deployment = readObject(deploymentFile);
  if (
    path.resolve(deployment.root || '') !== appDir
    || path.resolve(deployment.data || '') !== dataDir
    || deployment.service !== service
  ) {
    throw new Error('Deployment metadata does not match this installation');
  }

  phase = 'connectivity';
  const currentRevision = revisionFromFile();
  writeAutoUpdateState(dataDir, {
    status: 'checking',
    mode,
    phase,
    startedAt: now,
    progressAt: now,
    completedAt: 0,
    ...(mode === 'scheduled' ? { lastCheckAt: now } : {}),
    currentRevision,
    targetRevision: '',
    targetVersion: '',
    // 每次运行显式清空：状态是浅合并的，不清会残留上一次成功的通道值
    transport: '',
    error: '',
    notification: {
      pending: false,
      ownerUin: autoUpdateOwner(cfg),
      sentAt: 0,
      error: ''
    },
    connectivity: {
      status: 'testing',
      transport: '',
      checkedAt: 0,
      attempts: 0,
      latencyMs: 0,
      repository,
      branch,
      revision: '',
      error: ''
    }
  });

  ensureRepository(paths.repository, repository);
  // 连通性：先按 git 通道探；只有它不通时才启用 API + codeload 那条通道。
  // 两条都不通才算真的不通（原来的错误原样抛出，通知/自愈逻辑不变）。
  let transport = 'git';
  let connectivity;
  try {
    connectivity = await probeConnectivity();
  } catch (gitError) {
    const fallback = await probeConnectivityViaApi().catch(() => null);
    if (!fallback) throw gitError;
    transport = 'api';
    connectivity = fallback;
    console.log('[auto-update] git 通道不通，本次改用 GitHub API + codeload 源码包');
    writeAutoUpdateState(dataDir, { connectivity });
  }
  if (mode === 'probe') {
    writeAutoUpdateState(dataDir, {
      status: 'idle',
      mode,
      phase: 'complete',
      completedAt: Date.now(),
      error: '',
      autoDisabled: false,
      connectivity
    });
    return;
  }

  phase = 'checking';
  writeAutoUpdateState(dataDir, {
    status: 'checking',
    mode,
    phase,
    lastCheckAt: now,
    // 阶段推进要续期：这一阶段包含 GitHub 查询与 git fetch，可能几分钟；
    // 不续期的话控制台进度行会把"整轮耗时"当成"本阶段耗时"显示。
    progressAt: Date.now(),
    connectivity
  });

  // 部署目标只认「已发布的 Release」：branch 上的日常提交不部署。
  // 判定与控制台弹窗共用 checkForUpdate，避免两边口径不一致。
  // 手动 update-now 是明确的重试意图：绕过"忽略该版本"——否则更新失败一次之后
  // 同名 Release 永远 no-update，只能手改 state 文件（Issue #7 踩到的坑）。
  const notice = await checkForUpdate(dataDir, cfg, { force: mode === 'manual' });
  targetVersion = releaseTarget(notice, mode === 'manual' ? '' : previous?.ignoredVersion);
  if (!targetVersion) {
    console.log(`[auto-update] no released version to deploy (${notice?.reason || 'unknown'})`);
    writeAutoUpdateState(dataDir, {
      status: 'no-update',
      mode,
      phase: 'complete',
      completedAt: Date.now(),
      currentRevision,
      targetRevision: '',
      targetVersion: '',
      transport,
      error: '',
      autoDisabled: false
    });
    return;
  }

  // 解析部署目标：git 通道 fetch + rev-parse，或 API 解析 tag → sha
  const resolved = await resolveTargetRevision(targetVersion, transport);
  transport = resolved.transport;
  targetRevision = resolved.revision;

  if (currentRevision === targetRevision) {
    writeAutoUpdateState(dataDir, {
      status: 'no-update',
      mode,
      phase: 'complete',
      completedAt: Date.now(),
      currentRevision,
      targetRevision,
      targetVersion,
      transport,
      error: '',
      autoDisabled: false
    });
    return;
  }

  fs.mkdirSync(paths.workRoot, { recursive: true, mode: 0o700 });
  // 上次被强杀（systemd TimeoutStartSec / OOM / 手工 stop）留下的工作目录没人会清：
  // releaseLock 在 SIGKILL 下不执行，于是每中断一次就堆一个几十 MB 的 checkout。
  // 顺手清掉超过 6 小时的（正在跑的那次 mtime 是新的，不会误删）。
  try {
    for (const name of fs.readdirSync(paths.workRoot)) {
      if (!/^checkout-/.test(name)) continue;
      const full = path.join(paths.workRoot, name);
      const age = Date.now() - Number(fs.statSync(full).mtimeMs || 0);
      if (age > 6 * 3600 * 1000) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch { /* 清不掉不影响本次更新 */ }
  workDir = fs.mkdtempSync(path.join(paths.workRoot, 'checkout-'));
  transport = await materializeSource(workDir, targetRevision, transport, targetVersion);
  validateCheckout(workDir);

  phase = 'testing';
  writeAutoUpdateState(dataDir, {
    status: 'testing',
    mode,
    phase,
    targetRevision,
    targetVersion,
    transport,
    progressAt: Date.now()   // 给"卡住 30 分钟就放开提示"当基准：阶段推进要续期
  });
  const npm = String(
    process.env.QQ_AGENT_UPDATE_NPM
    || path.join(path.dirname(process.execPath), 'npm')
  );
  if (!fs.existsSync(npm)) throw new Error('The deployed Node.js runtime does not include npm');
  const runtimeEnv = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`
  };
  command(npm, [
    'ci',
    // devDeps（eslint/globals）只服务本仓开发与 CI；更新器临时目录装运行时依赖即可，
    // 否则每次自动更新都多拉几十 MB（改进方案 D6）。测试需要 devDeps 的用例必须自带缺件跳过。
    '--omit=dev',
    '--ignore-scripts',
    '--prefer-offline',
    '--no-audit',
    '--fund=false',
    `--fetch-retries=${networkSettings.networkRetries}`,
    `--fetch-retry-mintimeout=${networkSettings.retryBaseMs}`,
    `--fetch-retry-maxtimeout=${networkSettings.retryMaxMs}`
  ], {
    cwd: workDir,
    timeout: 10 * 60 * 1000,
    env: runtimeEnv
  });
  const tests = fs.readdirSync(path.join(workDir, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('test', name));
  const testDataDir = path.join(workDir, '.auto-update-test-data');
  // 用例自己的临时目录走 os.tmpdir()：指到工作目录里，随工作目录一起删掉。
  // 不然每次更新都会给系统 /tmp 留十几个 qq-* 残渣目录（用例跑挂了就没有 after 钩子清理）。
  const testTmpDir = path.join(workDir, '.auto-update-test-tmp');
  fs.mkdirSync(testDataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(testTmpDir, { recursive: true, mode: 0o700 });
  const testEnv = {
    ...runtimeEnv,
    NODE_ENV: 'test',
    QQ_AGENT_DATA_DIR: testDataDir,
    TMPDIR: testTmpDir,
    TMP: testTmpDir,
    TEMP: testTmpDir
  };
  command(process.execPath, ['--test', ...tests], {
    cwd: workDir,
    timeout: 20 * 60 * 1000,
    env: testEnv
  });
  command(process.execPath, ['--check', 'src/server.js'], { cwd: workDir });
  command(process.execPath, ['--check', 'scripts/auto-update.mjs'], { cwd: workDir });

  // ── 与 CI（.github/workflows/ci.yml 的 test job）对齐的其余门禁 ──
  // 原来只跑 `node --test test/*.test.mjs`，于是"提示词 / 渲染 / 滚动 / 用量端到端"这几条
  // 与 UI 直接相关的回归**在更新器这一层没有任何覆盖**：它们都是纯 Node + 本仓源码
  // （不 import happy-dom / eslint 这些 devDeps），--omit=dev 下照样能跑，却漏在门外
  // ——UI 类回归因此能绕过自动更新直接上线（2026-10；CI 早就拦得住，更新器没有）。
  // 逐个按文件是否存在执行：真实候选树是完整 checkout，只有测试替身的最小树会缺文件；
  // 真缺了，发布前置闸门（release.yml 的 verify job）与 CI 也会红，这里不重复兜底。
  //
  // 这里**刻意不跑 `npm run lint`**：按 D6 更新器用 `npm ci --omit=dev`，装不了 eslint，
  // 硬加会让每次自动更新都失败。lint 由 CI 的 lint job 与发布前置闸门
  // （release.yml 的 verify job，用完整依赖跑 `npm run lint`）覆盖；更新器部署的又只可能是
  // "已经过发布闸门"的 Release——所以这条不是漏测（别下一个人再提一遍）。
  for (const [script, timeout] of [
    ['test/test-prompt.mjs', 5 * 60 * 1000],
    ['test/render-test.mjs', 10 * 60 * 1000],
    ['test/scroll-test.mjs', 5 * 60 * 1000],
    ['test/usage-e2e.mjs', 10 * 60 * 1000],
    ['test/local/run.mjs', 10 * 60 * 1000]
  ]) {
    if (!fs.existsSync(path.join(workDir, script))) {
      console.log(`[auto-update] 跳过 ${script}（候选树里没有这个文件）`);
      continue;
    }
    command(process.execPath, [script], { cwd: workDir, timeout, env: testEnv });
  }
  // CI 的静态门禁：未定义调用扫描（node src/ops.js scan --strict）。纯 Node，不依赖 devDeps。
  if (fs.existsSync(path.join(workDir, 'src', 'ops.js'))) {
    command(process.execPath, ['src/ops.js', 'scan', '--strict'], {
      cwd: workDir,
      timeout: 5 * 60 * 1000
    });
  } else {
    console.log('[auto-update] 跳过 src/ops.js scan --strict（候选树里没有这个文件）');
  }
  // 两个目录必须在 deploy.sh 之前删掉：它 rsync 的是整个 checkout（根目录多什么就被部署什么）
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.rmSync(testTmpDir, { recursive: true, force: true });

  phase = 'deploying';
  writeAutoUpdateState(dataDir, {
    status: 'deploying',
    mode,
    phase,
    progressAt: Date.now(),
    targetRevision,
    targetVersion,
    transport
  });
  try {
    command('/bin/bash', [
      path.join(workDir, 'deploy.sh'),
      '--install-dir', appDir,
      '--data-dir', dataDir,
      '--host', String(cfg.server?.host || '127.0.0.1'),
      '--port', String(Number(cfg.server?.port) || 3210),
      '--service', service,
      '--node', process.execPath,
      // 期望的来源仓库/分支透传给部署侧：与安装记录比对，堵"在错误源码树里跑 deploy.sh"。
      // 自动更新发起的部署里，控制台设置就是真相源 —— 校验侧对"更新器驱动"的不一致按警告
      // 处理（见 verify-deployment-target.mjs），否则改过分支的实例会永久卡死在拒绝部署上。
      '--repository', repository,
      '--branch', branch
    ], {
      cwd: workDir,
      timeout: 20 * 60 * 1000,
      env: {
        ...runtimeEnv,
        QQ_AGENT_SOURCE_REVISION: targetRevision,
        QQ_AGENT_REPOSITORY: repository,
        QQ_AGENT_BRANCH: branch
      }
    });
  } catch (error) {
    const output = `${error?.stdout || ''}${error?.stderr || ''}`;
    if (/Another deployment is running|Another deployment is taking over a stale lock/.test(output)) {
      // 有人（多为手动部署）正持锁：这是正常碰撞，不是失败 —— 按 busy 结清
      //（不自停、不发告警，等下个周期再来）。此前会误判成部署失败并触发 disableOnFailure
      // + 给管理员发告警（2026-10-07 复审 P3）。
      const busy = new Error('另一个部署正在进行，本轮更新跳过（不算失败）');
      busy.code = 'UPDATE_BUSY';
      throw busy;
    }
    throw error;
  }

  writeAutoUpdateState(dataDir, {
    status: 'succeeded',
    mode,
    phase: 'complete',
    completedAt: Date.now(),
    lastSuccessAt: Date.now(),
    currentRevision: targetRevision,
    targetRevision,
    targetVersion,
    transport,
    error: '',
    autoDisabled: false
  });
}

try {
  await run();
} catch (error) {
  if (error?.code === 'UPDATE_BUSY') {
    console.log(`[auto-update] ${error.message}`);
    process.exitCode = 0;
  } else if (mode === 'probe') {
    const message = sanitizeUpdateError(error);
    writeAutoUpdateState(dataDir, {
      status: 'idle',
      mode: 'probe',
      phase: 'complete',
      completedAt: Date.now(),
      error: '',
      autoDisabled: false,
      connectivity: {
        status: 'failed',
        transport: '',
        checkedAt: Date.now(),
        attempts: Number(error?.attempts) || 1,
        latencyMs: probeStartedAt ? Date.now() - probeStartedAt : 0,
        repository,
        branch,
        revision: '',
        error: message
      },
      notification: { pending: false }
    });
    console.error(`[auto-update] connectivity probe failed: ${message}`);
    process.exitCode = 0;
  } else {
    const message = sanitizeUpdateError(error);
    let currentConfig = cfg;
    try {
      if (!currentConfig || !Object.keys(currentConfig).length) currentConfig = readObject(configFile);
    } catch { currentConfig = {}; }
    const failurePolicy = normalizeUpdateNetworkSettings(currentConfig.autoUpdate || {});
    if (failurePolicy.disableOnFailure) {
      try { currentConfig = disableAutoUpdate(); } catch { /* state still records autoDisabled */ }
    }
    writeAutoUpdateState(dataDir, {
      status: 'failed',
      mode,
      phase,
      completedAt: Date.now(),
      targetRevision,
      targetVersion,
      error: message,
      autoDisabled: failurePolicy.disableOnFailure,
      ...(phase === 'connectivity' ? {
        connectivity: {
          status: 'failed',
          checkedAt: Date.now(),
          attempts: Number(error?.attempts) || 1,
          latencyMs: probeStartedAt ? Date.now() - probeStartedAt : 0,
          repository,
          branch,
          revision: '',
          error: message
        }
      } : {}),
      notification: {
        pending: true,
        ownerUin: autoUpdateOwner(currentConfig),
        sentAt: 0,
        error: ''
      }
    });
    console.error(`[auto-update] ${message}`);
    try { await notifyFailure(currentConfig); } catch { /* keep pending notification on disk */ }
    process.exitCode = 1;
  }
} finally {
  releaseLock();
}
