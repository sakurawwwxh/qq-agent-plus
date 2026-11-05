// MCP stdio 的 Node 权限模型隔离。
//
// 与插件宿主共用同一套能力检测（plugins/isolation.js），区别在"允许读哪里"：
// 插件是插件目录，MCP 是入口脚本所在目录（或显式配置的 cwd）。只对直接用 node
// 启动的 server 生效 —— npx/docker 是外壳进程，往它们前面塞 --permission 只会把
// 参数喂给外壳，不会约束真正跑起来的 server，所以这里 fail-closed 而不是假装隔离。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/config.js';
import {
  permissionFlagSupported, pluginNodeArgs, probeIsolation
} from '../plugins/isolation.js';

const NODE_NAMES = new Set(['node', 'node.exe', 'nodejs', 'nodejs.exe']);
const SCRIPT_RE = /\.(?:mjs|cjs|js)$/i;
// Node 的 --allow-* 是累加的：追加在 --allow-fs-read=<目录> 后面的 --allow-fs-read=/
// 会直接绕过隔离；--require/--loader 等也会在入口脚本前执行代码。args 来自配置，
// 隔离模式下不允许出现这些参数。
const UNSAFE_ARG_RE = /^(?:--permission|--experimental-permission|--allow-[a-z-]+|--max-old-space-size|--require|--import|--loader|--experimental-loader|-r|-e|--eval|-p|--print|--openssl-config|--icu-data-dir|--snapshot-blob)(?:=|$)/i;

function isInsideOrEqual(parent, child) {
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function realPathOf(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

/**
 * Node 权限模型会跟随软链：允许目录里的 `leak -> <数据目录>/config.json` 仍可读。
 * 启动前把允许目录里的软链全部解析一遍；指向目录外/数据目录的一律拒绝（fail-closed）。
 * 目录很大（例如带完整 node_modules）时上限 20000 条，超限同样拒绝而不是跳过检查。
 */
function findEscapingSymlink(root, dataDir) {
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return `目录读不了：${dir}`; }
    for (const entry of entries) {
      seen += 1;
      if (seen > 20_000) return `目录条目超过 20000，无法确认没有越界软链：${root}`;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try { target = fs.realpathSync(full); } catch { return `软链损坏：${full}`; }
        if (!isInsideOrEqual(root, target) || isInsideOrEqual(dataDir, target) || isInsideOrEqual(target, dataDir)) {
          return `软链指向允许目录之外：${full} -> ${target}`;
        }
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return '';
}

export function isNodeCommand(command, nodePath = process.execPath) {
  const value = String(command || '').trim();
  if (!value) return false;
  if (NODE_NAMES.has(path.basename(value).toLowerCase())) return true;
  try { return path.resolve(value) === path.resolve(nodePath); } catch { return false; }
}

/**
 * 入口脚本所在目录优先；取最后一个脚本参数，避开 `-r preload.js` 里的预加载脚本。
 * 没有入口脚本（-e / 纯 cwd 启动）时才退回 cwd。
 */
export function mcpReadDir({ args = [], cwd = '' } = {}) {
  const base = String(cwd || '').trim() || process.cwd();
  const scripts = (Array.isArray(args) ? args : [])
    .map(String)
    .filter((arg) => !arg.startsWith('-') && SCRIPT_RE.test(arg));
  const entry = scripts[scripts.length - 1];
  return entry ? path.dirname(path.resolve(base, entry)) : path.resolve(base);
}

/**
 * @returns {{ok:true, command:string, args:string[], allowDir:string} | {ok:false, error:string}}
 */
export function mcpPermissionSpec({
  command, args = [], cwd = '', nodePath = process.execPath
} = {}) {
  if (!isNodeCommand(command, nodePath)) {
    return {
      ok: false,
      error: `permissionIsolation 只支持直接用 node 启动的 server（当前 command=${command || '空'}）；`
        + 'npx/docker 这类外壳进程无法用 Node 权限模型约束'
    };
  }
  if (!permissionFlagSupported()) {
    return { ok: false, error: '本机 Node 不支持 --permission，MCP 进程无法与宿主隔离' };
  }
  const userArgs = Array.isArray(args) ? args.map(String) : [];
  const unsafe = userArgs.filter((arg) => UNSAFE_ARG_RE.test(arg));
  if (unsafe.length) {
    return { ok: false, error: `permissionIsolation 不允许在 args 里传权限/加载器参数：${unsafe.join(', ')}` };
  }
  const resolvedAllow = mcpReadDir({ args: userArgs, cwd });
  let allowDir;
  try {
    if (!fs.statSync(resolvedAllow).isDirectory()) {
      return { ok: false, error: `允许读取的路径不是目录：${resolvedAllow}` };
    }
    // 软链目录先解析到真实路径；后续白名单/软链检查都按真实路径做。
    allowDir = fs.realpathSync(resolvedAllow);
  } catch {
    return { ok: false, error: `允许读取的目录不存在：${resolvedAllow}` };
  }
  const dataDir = realPathOf(DATA_DIR);
  // 只读白名单是"整个目录"：如果它落在数据目录里，或者把数据目录包了进去，
  // 权限模型等于没开 —— 配置写错时宁可不启动。
  if (isInsideOrEqual(dataDir, allowDir) || isInsideOrEqual(allowDir, dataDir)) {
    return { ok: false, error: `允许读取的目录 ${allowDir} 与数据目录 ${dataDir} 重叠` };
  }
  if (allowDir === path.parse(allowDir).root) {
    return { ok: false, error: '不允许把文件系统根目录作为 MCP 的读取白名单' };
  }
  const symlinkError = findEscapingSymlink(allowDir, dataDir);
  if (symlinkError) return { ok: false, error: `权限白名单不安全：${symlinkError}` };
  const probe = probeIsolation({ pluginDir: allowDir });
  if (!probe.ok) return { ok: false, error: `权限模型探测失败：${probe.error}` };
  return {
    ok: true,
    command: nodePath,
    args: [...pluginNodeArgs({ pluginDir: allowDir }), ...userArgs],
    allowDir
  };
}

/**
 * 套上网络命名空间前缀。内层命令必须是原始 node（无论前面是否已经套了权限模型参数），
 * 不能先覆盖 command 再拼参数 —— 那会启动成 `unshare ... unshare <脚本>`，进程 126 退出。
 */
export function wrapWithNetns(command, args = []) {
  return {
    command: 'unshare',
    args: ['--user', '--map-root-user', '--net', String(command), ...(Array.isArray(args) ? args : [])]
  };
}

/** 会被 Node/动态链接器当成“额外启动参数/库”的环境变量：隔离模式下不允许从配置注入。 */
export function stripIsolationEnv(env) {
  const deny = /^(NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/i;
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (deny.test(key) || value == null) continue;
    out[key] = String(value);
  }
  return out;
}
