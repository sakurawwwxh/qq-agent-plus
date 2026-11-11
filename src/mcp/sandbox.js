// MCP stdio 的启动沙箱决策：把"配置里写了隔离"翻译成真正能落地的命令 + 参数。
//
// 背景（2026-11-03 审查）：旧实现把 networkIsolation 统一套成 `unshare --net <command>`。
// 对 node/npx 是对的，对 docker 是假隔离 —— 被关进 netns 的只是 docker CLI，容器仍走
// 默认 bridge。这里按 command 分派：
//   · docker → 绝不套 CLI netns，改为校验/补齐容器硬化参数（--network none 等）；
//   · node   → Node 权限模型（只读入口目录）+ 可选 netns；
//   · npx/uvx/其他 → Linux 上有 bubblewrap 就用 bwrap（只读根 + 独立 netns）；
//     没有 bwrap 时，required 模式 fail-closed，auto 模式要求 allowUnsandboxed 显式信任。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from '../core/config.js';
import { networkIsolationSupported } from '../plugins/isolation.js';
import { isNodeCommand, mcpPermissionSpec, stripIsolationEnv } from './isolation.js';

const NETWORKS = new Set(['none', 'loopback', 'host']);
const MODES = new Set(['off', 'auto', 'required']);
// 只做黑名单也要把短参数和容易漏的口子全列上：`-v/:/host`（无空格挂载）、
// 组合短参数 `-itv`（pflag 会拆成 -i -t -v）、`--volumes-from`、
// `--security-opt`（可关 seccomp/apparmor）、`-p` 发布端口，以及会覆盖宿主硬化参数的 flag。
const DOCKER_UNSAFE_RE = /^(?:--privileged|--volume(?:=|$)|--mount(?:=|$)|--device(?:=|$)|--cap-add(?:=|$)|--cap-drop(?:=|$)|--pid(?:=|$)|--ipc(?:=|$)|--userns(?:=|$)|--uts(?:=|$)|--cgroupns(?:=|$)|--security-opt(?:=|$)|--volumes-from(?:=|$)|--entrypoint(?:=|$)|--runtime(?:=|$)|--network(?:=|$)|--net(?:=|$)|--publish(?:=|$)|--expose(?:=|$)|--read-only(?:=|$)|--pids-limit(?:=|$)|--memory(?:=|$)|--memory-swap(?:=|$)|--tmpfs(?:=|$)|--cidfile(?:=|$)|-[^-]*[vp].*)/i;
const DOCKER_IMAGE_RE = /^[a-zA-Z0-9][\w./:@-]*$/;

function baseName(command) {
  return path.basename(String(command || '')).toLowerCase();
}

function isDockerCommand(command) {
  return baseName(command) === 'docker' || baseName(command) === 'docker.exe';
}

function normMode(server = {}, { networkIsolation = false, permissionIsolation = false } = {}) {
  // 旧开关是显式安全要求，不能被同时保存的 sandbox.mode:'off' 覆盖。
  // 控制台曾把两者一起写盘：勾了「网络隔离」却留着 mode=off/network=host，
  // 旧实现会直接返回未沙箱 spec，勾选框形同虚设。
  if (networkIsolation || permissionIsolation) return 'required';
  const raw = String(server?.mode || '').trim().toLowerCase();
  if (MODES.has(raw)) return raw;
  // 只写了 sandbox.network:'none'/'loopback' 也要真的尝试隔离：以前默认 off，
  // 这行配置会被静默忽略，npx/uvx 仍以完整网络启动。
  const net = String(server?.network || '').trim().toLowerCase();
  return net && net !== 'host' ? 'auto' : 'off';
}

function normNetwork(server = {}, networkIsolation = false, fallback = 'host') {
  // networkIsolation 的字面语义就是禁网；显式 loopback/host 不能在它打开时翻案。
  if (networkIsolation) return 'none';
  const raw = String(server?.network || '').trim().toLowerCase();
  if (NETWORKS.has(raw)) return raw;
  return fallback;
}

function isolationError(id, message) {
  const error = new Error(`MCP ${id} 隔离配置不成立：${message}`);
  error.code = 'E_MCP_ISOLATION';
  return error;
}

/** 两个路径是否互为祖先/相等（用于挡住“传数据目录的父目录”这种绕过）。 */
function overlaps(left, right) {
  const l = path.resolve(String(left || ''));
  const r = path.resolve(String(right || ''));
  if (l === r) return true;
  // 根目录与任何路径都重叠：用 startsWith('//') 判断会漏掉 `/`，之前 cwd='/' 能把整个宿主挂进沙箱。
  if (l === path.parse(l).root || r === path.parse(r).root) return true;
  return l.startsWith(`${r}${path.sep}`) || r.startsWith(`${l}${path.sep}`);
}

function realOrResolved(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

// bwrap/docker 探测都真跑一次并缓存；测试可注入 spawn / platform / force。
let bwrapProbe = null;
let dockerProbe = null;

export function bwrapSupported({
  spawn = spawnSync, platform = process.platform, force = false
} = {}) {
  if (!force && bwrapProbe) return bwrapProbe;
  if (platform !== 'linux') {
    bwrapProbe = { ok: false, error: `本平台（${platform}）没有 bubblewrap` };
    return bwrapProbe;
  }
  const version = spawn?.('bwrap', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (version?.status !== 0) {
    bwrapProbe = { ok: false, error: '未安装 bubblewrap（bwrap）' };
    return bwrapProbe;
  }
  const probe = spawn?.('bwrap', [
    '--unshare-all', '--die-with-parent',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--dev', '/dev', '--proc', '/proc', 'true'
  ], { encoding: 'utf8', timeout: 10000 });
  if (probe?.status === 0) {
    bwrapProbe = { ok: true, error: '' };
    return bwrapProbe;
  }
  const detail = String(probe?.stderr || probe?.error?.message || '').trim().split('\n').slice(-1)[0];
  bwrapProbe = { ok: false, error: `bwrap 跑不起来（用户命名空间可能被禁用）：${detail || '未知原因'}` };
  return bwrapProbe;
}

export function dockerSupported({ spawn = spawnSync, force = false } = {}) {
  if (!force && dockerProbe) return dockerProbe;
  const result = spawn?.('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8', timeout: 8000
  });
  if (result?.status === 0) {
    dockerProbe = { ok: true, error: '' };
    return dockerProbe;
  }
  const detail = String(result?.stderr || result?.error?.message || '').trim().split('\n').slice(-1)[0];
  dockerProbe = { ok: false, error: `Docker 不可用：${detail || '未知原因'}` };
  return dockerProbe;
}

export function resetSandboxProbes() {
  bwrapProbe = null;
  dockerProbe = null;
}

/**
 * Docker 硬化：只接受 `docker run [已有 flags] image ...`，补齐/校验安全参数。
 * 任何挂载宿主目录、加权限、共享网络/命名空间/设备的写法都直接拒绝 —— 这些不是
 * "管理员信任"的问题，而是 MCP 输出给模型后可能被诱导利用的攻击面。
 */
function dockerSpec({ id, args, network, memoryMb }) {
  const userArgs = Array.isArray(args) ? args.map(String) : [];
  if (userArgs[0] !== 'run') {
    throw isolationError(id, 'docker 命令必须是 `docker run ...`（不接受 exec/start/attach）');
  }
  if (!DOCKER_IMAGE_RE.test(String(userArgs[1] || '')) && !String(userArgs[1] || '').startsWith('-')) {
    throw isolationError(id, 'docker run 缺少有效镜像名');
  }
  for (const arg of userArgs) {
    if (DOCKER_UNSAFE_RE.test(arg)) {
      throw isolationError(id, `不允许在 docker args 里指定权限/网络/挂载参数：${arg}`);
    }
    if (/docker\.sock/i.test(arg)) {
      throw isolationError(id, '不允许把 docker.sock 挂进 MCP 容器');
    }
  }
  if (network === 'host') {
    throw isolationError(id, 'docker MCP 必须使用 --network none/loopback，不能用 host 网络');
  }
  const cidFile = path.join(
    os.tmpdir(),
    `qq-agent-mcp-${String(id || 'server').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}.cid`
  );
  const flags = [
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    '--init',
    '--rm',
    `--cidfile=${cidFile}`
  ];
  if (memoryMb > 0) flags.push(`--memory=${memoryMb}m`);
  // 用户 flag 原样保留（已校验），硬化 flag 插在 run 之后、用户 flag 之前。
  return {
    command: 'docker',
    args: ['run', ...flags, ...userArgs.slice(1)],
    cleanup: { cidFile },
    netIsolated: network !== 'host',
    fsIsolated: true,
    sandboxKind: 'docker',
    network
  };
}

const BWRAP_RO_BINDS = ['/usr', '/lib', '/lib64', '/bin', '/sbin'];
const BWRAP_RO_FILES = ['/etc/ld.so.cache', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf'];

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 权限/只读盘交给 bwrap 报错 */ }
}

function bwrapSpec({
  id, command, args, cwd, env, network, writablePaths = []
}) {
  if (network === 'host') {
    throw isolationError(id, 'bwrap 模式不支持 host 网络（要联网请显式改用 docker 或关闭沙箱）');
  }
  if (network === 'loopback') {
    throw isolationError(id, 'bwrap 模式暂不支持 loopback（--unshare-net 下 lo 默认未启用），请改用 docker');
  }
  const userArgs = Array.isArray(args) ? args.map(String) : [];
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-mcp-home-'));
  const cacheDir = path.join(DATA_DIR, 'mcp-cache');
  ensureDir(cacheDir);
  const npmCache = path.join(cacheDir, 'npm');
  const uvCache = path.join(cacheDir, 'uv');
  ensureDir(npmCache);
  ensureDir(uvCache);
  const bindArgs = [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/tmp/home',
    '--bind', npmCache, npmCache,
    '--bind', uvCache, uvCache
  ];
  for (const dir of BWRAP_RO_BINDS) {
    if (fs.existsSync(dir)) bindArgs.push('--ro-bind', dir, dir);
  }
  for (const file of BWRAP_RO_FILES) {
    if (fs.existsSync(file)) bindArgs.push('--ro-bind', file, file);
  }
  const dataReal = realOrResolved(DATA_DIR);
  const workDir = String(cwd || '').trim();
  if (workDir) {
    const real = fs.realpathSync(workDir);
    // cwd 是只读 bind，但只读也能读到 config.json / 令牌文件：与数据目录重叠就拒绝。
    if (overlaps(real, dataReal)) throw isolationError(id, `cwd 不能与数据目录重叠：${real}`);
    bindArgs.push('--ro-bind', real, real, '--chdir', real);
  } else {
    bindArgs.push('--chdir', '/tmp');
  }
  for (const raw of Array.isArray(writablePaths) ? writablePaths : []) {
    const target = String(raw || '').trim();
    if (!target) continue;
    const real = fs.realpathSync(target);
    // 先 realpath 再判根：`/tmp/link -> /` 这种软链不能靠 target 字面量绕过。
    if (real === path.parse(real).root) {
      throw isolationError(id, 'writablePaths 不能是文件系统根目录');
    }
    // 双向判断：既不能是数据目录本身/子目录，也不能是它的父目录（父目录可写 = 数据目录可写）。
    if (overlaps(real, dataReal)) {
      throw isolationError(id, `writablePaths 不能与数据目录重叠：${real}`);
    }
    bindArgs.push('--bind', real, real);
  }
  return {
    command: 'bwrap',
    args: [...bindArgs, command, ...userArgs],
    env: {
      ...env,
      HOME: '/tmp/home',
      TMPDIR: '/tmp',
      npm_config_cache: npmCache,
      npm_config_offline: 'true',
      UV_CACHE_DIR: uvCache
    },
    cleanup: { tempHome },
    netIsolated: true,
    fsIsolated: true,
    sandboxKind: 'bwrap',
    network: 'none'
  };
}

function nodeSpec({
  id, command, args, cwd, env, network, permissionIsolation, memoryMb,
  nodePath, netProbe = null
}) {
  let nextCommand = command;
  let nextArgs = [...(Array.isArray(args) ? args.map(String) : [])];
  let permissionActive = false;
  if (permissionIsolation) {
    const spec = mcpPermissionSpec({ command, args: nextArgs, cwd, nodePath });
    if (!spec.ok) throw isolationError(id, spec.error);
    nextCommand = spec.command;
    nextArgs = spec.args;
    permissionActive = true;
  }
  if (memoryMb > 0 && permissionActive) {
    nextArgs.unshift(`--max-old-space-size=${memoryMb}`);
  }
  let netIsolated = false;
  if (network === 'none') {
    const probe = netProbe || networkIsolationSupported();
    if (!probe.ok) throw isolationError(id, `网络隔离不可用：${probe.error}`);
    const wrappedCommand = 'unshare';
    const wrappedArgs = ['--user', '--map-root-user', '--net', nextCommand, ...nextArgs];
    nextCommand = wrappedCommand;
    nextArgs = wrappedArgs;
    netIsolated = true;
  } else if (network === 'loopback') {
    throw isolationError(id, 'node 模式暂不支持 loopback（netns 下 lo 默认未启用）');
  }
  return {
    command: nextCommand,
    args: nextArgs,
    env,
    cleanup: null,
    permissionActive,
    // Node 权限模型覆盖 fs/子进程/Worker；网络要靠 netns。
    fsIsolated: permissionActive,
    netIsolated,
    sandboxKind: permissionActive ? 'node-permission' : (netIsolated ? 'netns' : 'none'),
    network
  };
}

/**
 * 生成最终启动参数。caller 只需把 command/args/env/cwd/cleanup 拿去 spawn。
 * @returns {{ok:true, command, args, env, cleanup, sandboxKind, permissionActive,
 *   netIsolated, fsIsolated, unsandboxed, network} | never}
 */
export function buildMcpLaunchSpec({
  id = 'mcp',
  command,
  args = [],
  cwd = '',
  env = {},
  networkIsolation = false,
  permissionIsolation = false,
  memoryMb = 0,
  sandbox = {},
  allowUnsandboxed = false,
  execPath = process.execPath,
  platform = process.platform,
  spawn = spawnSync,
  probeBwrap = null,
  probeDocker = null,
  netProbe = null,
  nodePath = process.execPath
} = {}) {
  const serverId = String(id || 'mcp');
  const cmd = String(command || '').trim();
  if (!cmd) {
    const error = new Error(`MCP ${serverId} 缺少 command`);
    error.code = 'E_MCP_ISOLATION';
    throw error;
  }
  const mode = normMode(sandbox, { networkIsolation, permissionIsolation });
  // docker 容器不存在“host 网络可用”的合法形态：没显式配置时默认 none，而不是让
  // 每个 OCI/registry 导入的 server 都因为默认 host 被 fail-closed 挡死。
  const network = normNetwork(sandbox, networkIsolation, isDockerCommand(cmd) ? 'none' : 'host');
  // Node 权限模型只能约束 node 本身：npx/docker 是外壳进程，往它们前面塞 --permission
  // 不会约束真正跑起来的 server，必须 fail-closed 而不是假装隔离。
  if (permissionIsolation && !isNodeCommand(cmd, execPath)) {
    throw isolationError(
      serverId,
      `permissionIsolation 只支持直接用 node 启动的 server（当前 command=${cmd}）；`
        + 'npx/docker 这类外壳进程无法用 Node 权限模型约束'
    );
  }
  const base = {
    command: cmd,
    args: Array.isArray(args) ? args.map(String) : [],
    env: env && typeof env === 'object' ? { ...env } : {},
    cleanup: null,
    permissionActive: false,
    netIsolated: false,
    fsIsolated: false,
    unsandboxed: false,
    sandboxKind: 'none',
    network
  };
  const withIsoEnv = (spec) => ({
    ...base,
    ...spec,
    env: stripIsolationEnv(spec.env ?? base.env)
  });

  // 1) docker：容器自己就是边界，绝不再套 CLI netns。
  if (isDockerCommand(cmd)) {
    const probe = probeDocker || dockerSupported({ spawn });
    if (!probe.ok) throw isolationError(serverId, probe.error);
    return withIsoEnv(dockerSpec({ id: serverId, args: base.args, network, memoryMb }));
  }

  // 2) 直接用 node 启动：权限模型 + 可选 netns。
  if (isNodeCommand(cmd, execPath)) {
    if (mode === 'required' && !permissionIsolation && !networkIsolation && network === 'host') {
      throw isolationError(serverId, 'required 模式至少要启用 permissionIsolation 或 networkIsolation');
    }
    const spec = nodeSpec({
      id: serverId, command: cmd, args: base.args, cwd, env: base.env,
      network, permissionIsolation, memoryMb, nodePath, netProbe
    });
    const isolated = spec.permissionActive || spec.netIsolated;
    if (!isolated && mode === 'required') {
      throw isolationError(serverId, 'required 模式至少要启用 permissionIsolation 或 networkIsolation');
    }
    if (!isolated && mode === 'auto' && !allowUnsandboxed) {
      throw isolationError(serverId, '未启用任何隔离；如确认信任该 server，请显式设置 allowUnsandboxed:true');
    }
    return withIsoEnv({ ...spec, unsandboxed: !isolated });
  }

  // 3) 其他命令（npx/uvx/任意可执行文件）：Linux 上优先 bwrap。
  if (mode !== 'off' && network !== 'host') {
    const probe = probeBwrap || bwrapSupported({ spawn, platform });
    if (probe.ok) {
      return withIsoEnv(bwrapSpec({
        id: serverId, command: cmd, args: base.args, cwd, env: base.env,
        network, memoryMb, writablePaths: sandbox.writablePaths
      }));
    }
    if (mode === 'required' || !allowUnsandboxed) {
      throw isolationError(
        serverId,
        `${probe.error}；required/未显式信任时拒绝以未隔离方式启动（可设 allowUnsandboxed 或将 sandbox.mode 设为 off）`
      );
    }
  }

  // 4) 旧行为兜底：开了 networkIsolation 但没有 bwrap 时，Linux 上仍可用 CLI netns
  //    （对 npx/普通可执行文件成立；docker 已在上面分流，不会被假隔离）。
  if (networkIsolation && network === 'none') {
    const probe = netProbe || networkIsolationSupported();
    if (!probe.ok) throw isolationError(serverId, `网络隔离不可用：${probe.error}`);
    return withIsoEnv({
      command: 'unshare',
      args: ['--user', '--map-root-user', '--net', cmd, ...base.args],
      sandboxKind: 'netns',
      netIsolated: true
    });
  }

  if (mode === 'required') {
    throw isolationError(serverId, '本机没有可用的沙箱（bwrap/docker/netns）');
  }
  if (mode === 'auto' && !allowUnsandboxed) {
    throw isolationError(serverId, '本机没有可用的沙箱；如确认信任该 server，请显式设置 allowUnsandboxed:true');
  }
  return { ...base, unsandboxed: true, sandboxKind: 'none' };
}
