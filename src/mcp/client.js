// 极简 MCP stdio 客户端：只依赖 node 内建。一个 server 一个子进程，JSON-RPC 走 stdin/stdout。
// 不实现采样/资源/提示词，只做 tools/list + tools/call —— 这是给聊天机器人用的最小闭环。

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { buildMcpLaunchSpec } from './sandbox.js';

const DEFAULT_TIMEOUT = 30000;
const PROTOCOL_VERSION = '2024-11-05';
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC'
];

function safeEnv() {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] != null) out[key] = process.env[key];
  }
  return out;
}

export class McpStdioClient {
  constructor({ id, command, args = [], env = {}, cwd = '', timeoutMs = DEFAULT_TIMEOUT, log = () => {}, onExit = null, networkIsolation = false, permissionIsolation = false, memoryMb = 0, sandbox = {}, allowUnsandboxed = false }) {
    this.id = String(id || '').trim();
    this.command = String(command || '').trim();
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.env = env && typeof env === 'object' ? env : {};
    this.cwd = String(cwd || '').trim() || undefined;
    this.timeoutMs = Math.min(600_000, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT));
    this.log = log;
    // 可选的 Linux 网络隔离：MCP server 默认仍能联网（搜索/GitHub 类需要），
    // 管理员对本地不可信 server 显式打开后，进程连不上任何网络接口。
    this.networkIsolation = networkIsolation === true;
    // 可选的 Node 权限模型隔离：只读白名单 + 禁止子进程/Worker/加载插件。只对
    // command 就是 node 的 server 生效；npx/docker 外壳会在 start() 里 fail-closed。
    this.permissionIsolation = permissionIsolation === true;
    // sandbox：{ mode:'off'|'auto'|'required', kind, network, writablePaths }。
    // allowUnsandboxed 是显式信任门禁：auto 模式找不到沙箱时只有它为 true 才允许裸跑。
    this.sandbox = sandbox && typeof sandbox === 'object' ? sandbox : {};
    this.allowUnsandboxed = allowUnsandboxed === true;
    // 小于 64MB 的堆上限只会让 server 起不来；按 0（不设）处理。
    const heapMb = Math.floor(Number(memoryMb) || 0);
    this.memoryMb = heapMb >= 64 ? Math.min(4096, heapMb) : 0;
    this.permissionActive = false;
    this.netIsolated = false;
    this.fsIsolated = false;
    this.unsandboxed = false;
    this.sandboxKind = 'none';
    this.cleanup = null;
    // 意外退出时通知管理器。主动 stop()（重载/关闭）不触发，避免把关闭当成崩溃重启。
    this.onExit = typeof onExit === 'function' ? onExit : null;
    this.intentionalStop = false;
    this.proc = null;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = '';
    this.tools = [];
    this.startedAt = 0;
    this.lastError = '';
    this.ready = false;
  }

  get running() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  async start() {
    if (!this.id) throw new Error('MCP server 缺少 id');
    if (!this.command) throw new Error(`MCP server ${this.id} 缺少 command`);
    if (this.running) return;
    this.ready = false;
    this.lastError = '';
    this.intentionalStop = false;
    this.buffer = '';
    this.stderrTail = '';
    let command = this.command;
    let args = [...this.args];
    this.permissionActive = false;
    this.netIsolated = false;
    this.fsIsolated = false;
    this.unsandboxed = false;
    this.sandboxKind = 'none';
    let spec;
    try {
      spec = buildMcpLaunchSpec({
        id: this.id,
        command,
        args,
        cwd: this.cwd || '',
        env: this.env,
        networkIsolation: this.networkIsolation,
        permissionIsolation: this.permissionIsolation,
        memoryMb: this.memoryMb,
        sandbox: this.sandbox,
        allowUnsandboxed: this.allowUnsandboxed
      });
    } catch (error) {
      if (!error?.code) error.code = 'E_MCP_ISOLATION';
      throw error;
    }
    command = spec.command;
    args = spec.args;
    this.cleanup = spec.cleanup || null;
    this.permissionActive = spec.permissionActive === true;
    this.netIsolated = spec.netIsolated === true;
    this.fsIsolated = spec.fsIsolated === true;
    this.unsandboxed = spec.unsandboxed === true;
    this.sandboxKind = String(spec.sandboxKind || 'none');
    this.log.info?.(`MCP ${this.id} 启动方式：${this.sandboxKind}`
      + `${this.netIsolated ? '（禁网）' : '（允许网络）'}${this.unsandboxed ? '（未沙箱，管理员已显式信任）' : ''}`);
    const child = spawn(command, args, {
      cwd: this.cwd,
      // 不继承完整 process.env：第三方 server 不该读到宿主的所有凭据/代理变量。
      // 配置变量可以扩展；隔离模式下 NODE_OPTIONS/LD_PRELOAD 这类能改写启动行为的键会被剥掉。
      env: { ...safeEnv(), ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    this.proc = child;
    this.startedAt = Date.now();
    child.stdin.on('error', (error) => {
      // 子进程退出/关闭 stdin 后再写会异步抛 EPIPE；没有监听会变成 uncaughtException，
      // 一个坏 MCP server 就能带走整个机器人。
      this.ready = false;
      this.lastError = `stdin: ${String(error?.message ?? error)}`;
      this.#failAll(new Error(`MCP ${this.id} 写入失败：${this.lastError}`));
    });
    child.stdout.on('error', (error) => {
      this.lastError = `stdout: ${String(error?.message ?? error)}`;
    });
    child.stderr.on('error', () => { /* stderr 只做诊断，读不了就算了 */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => {
      this.lastError = String(error?.message ?? error);
      this.#failAll(new Error(`MCP ${this.id} 进程错误：${this.lastError}`));
    });
    child.on('exit', (code, signal) => {
      const detail = `MCP ${this.id} 进程退出 code=${code ?? 'null'} signal=${signal || 'null'}`;
      this.ready = false;
      this.lastError = detail;
      this.log.warn?.(detail);
      this.#failAll(new Error(detail));
      // 非 stop() 的意外退出也要清 docker cidfile/容器和 bwrap 临时 HOME；
      // 否则自动重启会不断留下孤儿容器。
      this.#cleanupSandbox();
      if (!this.intentionalStop) {
        try { this.onExit?.({ code, signal }); } catch { /* 重启逻辑自身不能拖垮宿主 */ }
      }
    });
    try {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'qq-agent-plus', version: '1' }
      });
      this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.tools = await this.listTools();
      this.ready = true;
      this.log.info?.(`MCP ${this.id} 就绪，${this.tools.length} 个工具`);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.stop();
      throw error;
    }
  }

  #send(payload) {
    if (!this.proc?.stdin?.writable) throw new Error(`MCP ${this.id} 未启动`);
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) {
      this.lastError = 'stdout 单行超过 1MB，已停止该 server';
      this.buffer = '';
      this.#failAll(new Error(`MCP ${this.id} ${this.lastError}`));
      this.stop();
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (!line) continue;
      let message = null;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.id != null && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        entry.cleanup?.();
        this.consecutiveTimeouts = 0;
        if (message.error) entry.reject(new Error(String(message.error.message || 'MCP 调用失败')));
        else entry.resolve(message.result);
      }
    }
  }

  #failAll(error) {
    for (const entry of this.pending.values()) {
      entry.cleanup?.();
      entry.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('MCP 调用已取消'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : new Error('MCP 调用已取消'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        // 单次调用超时 ≠ server 挂了：之前把 ready 置 false 之后没有任何路径能恢复，
        // 一次慢检索就会让该 server 的全部工具在进程剩余生命里一直报"没有就绪"。
        // 连续 3 次超时才认为 server 真的卡死（成功的应答会把计数清零）。
        this.consecutiveTimeouts = (Number(this.consecutiveTimeouts) || 0) + 1;
        this.lastError = `${method} 超时（${this.timeoutMs}ms）`;
        if (this.consecutiveTimeouts >= 3) {
          this.ready = false;
          this.lastError = `连续 ${this.consecutiveTimeouts} 次调用超时，已标记未就绪`;
          // 不退出进程的话，管理器永远不会走 onExit 重启，这个 server 会一直“未就绪”。
          // 主动杀掉子进程，让 onExit 接管有界重启；不要设置 intentionalStop。
          try { this.proc?.kill('SIGKILL'); } catch { /* 已退出 */ }
        }
        cleanup();
        reject(new Error(`MCP ${this.id} ${this.lastError}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async listTools({ signal } = {}) {
    const out = [];
    let cursor = '';
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, { signal });
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      out.push(...tools);
      cursor = String(result?.nextCursor || '');
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name, args = {}, { signal } = {}) {
    const result = await this.request('tools/call', { name, arguments: args }, { signal });
    return result;
  }

  #cleanupSandbox() {
    const cleanup = this.cleanup;
    this.cleanup = null;
    if (!cleanup) return;
    if (cleanup.cidFile) {
      try {
        const cid = fs.readFileSync(cleanup.cidFile, 'utf8').trim();
        if (cid) {
          // docker run 是前台进程，杀掉 CLI 不一定能带走容器；用 cidfile 兜底强制清理。
          // 不能 spawnSync：这段在子进程 exit 回调里，Docker 卡住会冻结整个事件循环。
          execFile('docker', ['rm', '-f', cid], { timeout: 8000, windowsHide: true }, () => {});
        }
      } catch { /* 容器可能已退出并 --rm 自清 */ }
      try { fs.rmSync(cleanup.cidFile, { force: true }); } catch { /* ignore */ }
    }
    if (cleanup.tempHome) {
      try { fs.rmSync(cleanup.tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  stop() {
    this.intentionalStop = true;
    this.permissionActive = false;
    this.netIsolated = false;
    this.fsIsolated = false;
    const child = this.proc;
    this.proc = null;
    this.ready = false;
    this.#failAll(new Error(`MCP ${this.id} 已停止`));
    this.#cleanupSandbox();
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 2000);
    timer.unref?.();
  }
}

/** 把 MCP 的 content 数组压成模型能读的文本。 */
export function mcpContentToText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map((part) => {
    if (part?.type === 'text') return String(part.text ?? '');
    if (part?.type === 'image') return `[图片 ${part.mimeType || ''}]`;
    if (part?.type === 'resource') return `[资源 ${part.resource?.uri || ''}]`;
    return '';
  }).filter(Boolean).join('\n');
  return text || '(MCP 工具没有返回文本)';
}
