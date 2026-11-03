// 插件进程的隔离参数 —— 这是"插件生态"与"把机器交给陌生人"之间的那道门。
//
// 两层，都是真跑起来验过的（本机 Node v24 + 生产 Node v22.23.2 两台都跑过）：
//
// 一、Node 权限模型：`node --permission --allow-fs-read=<插件目录> <entry>`
//     · 读 /data/qq-agent/data/config.json（凭据所在）→ **ERR_ACCESS_DENIED**
//     · 读插件目录外的任何文件、import 目录外的模块 → **ERR_ACCESS_DENIED**
//     · child_process.spawn / execSync → **ERR_ACCESS_DENIED**
//     · worker_threads → **ERR_ACCESS_DENIED**
//     · 加载同目录的兄弟模块（多文件插件）→ 正常
//   拦不住的：
//     · **网络** —— `--allow-net` 这个 flag 在 v22/v24 上都不存在（`bad option`）。Node 的权限
//       模型覆盖 fs / child_process / worker / addons / wasi，**不覆盖网络**。
//     · **环境变量** —— 子进程默认继承 env，`process.env.QQ_AGENT_*` 读得到。所以宿主 spawn 时
//       必须自己剥（见 host.js 的 childEnv()）。
//
// 二、网络命名空间（Linux，2026-10-16 加）：`unshare --user --map-root-user --net …`
//     把插件进程放进一个**没有网络接口**的命名空间 —— 插件连不出去（实测 connect 与 fetch 都是
//     ENETUNREACH），要联网只能走宿主的 `cap.http.request`（那条路有内网拦截、体积上限、超时与审计）。
//     实测条件：内核 5.15 + `kernel.unprivileged_userns_clone=1`（Ubuntu 默认），**不需要 root**，
//     在 `setpriv --no-new-privs` 的加固环境里照样可用，与 Node 权限模型叠加也正常。
//     不支持时（Windows / macOS / 内核关了非特权 userns）如实标出来，不假装拦住了。
import { spawnSync } from 'node:child_process';

/** 本机 node 认不认 `--permission`（不认就只能走 fail-closed：拒绝加载插件）。 */
export function permissionFlagSupported() {
  const flags = process.allowedNodeEnvironmentFlags;
  return typeof flags?.has === 'function' && flags.has('--permission');
}

/**
 * spawn 插件进程用的参数。
 * 只给**只读 + 只读插件目录**：插件要存东西走 `cap.storage`（宿主侧落盘），
 * 于是插件进程连写权限都不需要 —— 少一项权限就少一类被写坏的东西。
 */
export function pluginNodeArgs({ pluginDir = '' } = {}) {
  const args = ['--permission'];
  // 权限模型会打一条 ExperimentalWarning 到 stderr，混在插件日志里既吵又容易被当成故障。
  // 老 node 不认这个 flag 时不加（认不认由 probeIsolation 实测）。
  if (process.allowedNodeEnvironmentFlags?.has?.('--disable-warning')) {
    args.push('--disable-warning=ExperimentalWarning');
  }
  if (pluginDir) args.push(`--allow-fs-read=${pluginDir}`);
  return args;
}

// 按插件目录缓存：--allow-fs-read 的值是探测输入之一，缓存成单一变量会让第一个目录的结论
// （甚至"没带 --allow-fs-read"的结论）冒充所有插件的结论（2026-10-15 复审 P2-4）。
const probeCache = new Map();
// 网络隔离的结论与插件目录无关（unshare 不看目录），只需探一次
let netProbe = null;

/**
 * 网络隔离的启动前缀：`unshare --user --map-root-user --net`。
 * 只在 Linux 且真跑得起来时启用 —— 探测方式就是**真起一次**（`unshare … <node> -e ''`），
 * 因为"命令存在"不等于"这台内核允许"（很多发行版默认关掉非特权 userns）。
 */
export function networkIsolationSupported({
  spawn = spawnSync, nodePath = process.execPath, force = false, platform = process.platform
} = {}) {
  if (!force && netProbe) return netProbe;
  if (platform !== 'linux') {
    // 非 Linux 直接短路（连探都不用探）：Windows/macOS 没有 unshare。
    // platform 是注入点，测试用它把两个分支都覆盖到（否则这条逻辑在 Windows 上永不被执行）
    netProbe = { ok: false, error: `本平台（${platform}）没有 unshare/netns，插件进程的网络拦不住` };
    return netProbe;
  }
  const runNode = spawn;
  const result = runNode('unshare', ['--user', '--map-root-user', '--net', nodePath, '-e', ''], {
    encoding: 'utf8', timeout: 20000
  });
  if (result?.status === 0) {
    netProbe = { ok: true, error: '' };
    return netProbe;
  }
  const detail = String(result?.stderr || result?.error?.message || '').trim().split('\n').slice(-1)[0];
  netProbe = { ok: false, error: `网络命名空间用不了：${detail || '未知原因'}` };
  return netProbe;
}

/** 插件进程的启动方式：命令 + 参数（是否套 unshare 由这里决定，host 只管照着起）。 */
export function pluginLaunchSpec({
  pluginDir = '', unconfined = false, networkIsolation = false, memoryMb = 0,
  spawn = spawnSync, nodePath = process.execPath, platform = process.platform
} = {}) {
  const nodeArgs = unconfined ? [] : pluginNodeArgs({ pluginDir });
  // 堆上限：插件是"几个 JS 文件"，默认给 128MB 已经很宽；超了让 V8 自己 OOM 退出，
  // 由看门狗按崩溃处理（而不是让它把宿主的机器吃光）
  if (!unconfined && memoryMb > 0) nodeArgs.unshift(`--max-old-space-size=${Math.floor(memoryMb)}`);
  const prefix = [];
  if (networkIsolation) {
    const probe = networkIsolationSupported({ spawn, nodePath, platform });
    if (probe.ok) prefix.push('unshare', '--user', '--map-root-user', '--net');
  }
  if (!prefix.length) return { command: nodePath, args: nodeArgs, netIsolated: false };
  return { command: prefix[0], args: [...prefix.slice(1), nodePath, ...nodeArgs], netIsolated: true };
}

/**
 * 真起一次子进程验证参数可用（`allowedNodeEnvironmentFlags` 只说明"认这个 flag"，
 * 不说明这组参数能跑起来）。结果进程内缓存 —— 一次约 30ms，没必要每次加载插件都跑。
 *
 * ⚠️ 缓存的是**结论**（能不能用），不是参数本身：`--allow-fs-read` 里是各插件自己的目录，
 * 必须由调用方按目录现算（缓存一份会把第一个插件的目录发给所有人）。
 * @returns {{ok:boolean, error?:string}}
 */
export function probeIsolation({ pluginDir, spawn = spawnSync, nodePath = process.execPath, force = false } = {}) {
  const cacheKey = String(pluginDir || '');
  if (!force && probeCache.has(cacheKey)) return probeCache.get(cacheKey);
  if (!permissionFlagSupported()) {
    const verdict = { ok: false, error: '本机 Node 不支持 --permission（权限模型），插件进程无法与宿主隔开' };
    probeCache.set(cacheKey, verdict);
    return verdict;
  }
  const runNode = spawn;
  const attempt = (args) => runNode(nodePath, [...args, '-e', ''], { encoding: 'utf8', timeout: 20000 });
  const first = attempt(pluginNodeArgs({ pluginDir }));
  if (first?.status === 0) { probeCache.set(cacheKey, { ok: true }); return probeCache.get(cacheKey); }
  // 某些老版本的 --disable-warning 写法不同 → 去掉它再试一次，别因为一条警告就判定隔离不可用
  const fallback = pluginNodeArgs({ pluginDir }).filter((a) => !a.startsWith('--disable-warning'));
  if (attempt(fallback)?.status === 0) { probeCache.set(cacheKey, { ok: true }); return probeCache.get(cacheKey); }
  const detail = String(first?.stderr || first?.error?.message || '').trim().split('\n').slice(-1)[0];
  const verdict = { ok: false, error: `隔离参数跑不起来：${detail || '未知原因'}` };
  probeCache.set(cacheKey, verdict);
  return verdict;
}

/** 给控制台/巡检用的口径说明：哪些拦得住、哪些拦不住。 */
export function isolationSummary({ spawn = spawnSync, nodePath = process.execPath, platform = process.platform } = {}) {
  const supported = permissionFlagSupported();
  const net = networkIsolationSupported({ spawn, nodePath, platform });
  return {
    supported,
    fs: supported,
    childProcess: supported,
    worker: supported,
    // 网络：Linux 上靠网络命名空间真拦住（插件只能走宿主的 cap.http）；其他平台如实为 false
    net: net.ok,
    netError: net.error,
    env: false       // 宿主自己剥，见 host.js
  };
}

/** 只测一次用：重置缓存（测试用）。 */
export function resetIsolationProbe() {
  probeCache.clear();
  netProbe = null;
}
