// MCP stdio 客户端/管理器：启动、列工具、调用、meta 挂载。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs');
const hangFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hang-mcp-server.mjs');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { McpManager } = await import('../src/mcp/manager.js');
const { McpStdioClient } = await import('../src/mcp/client.js');

function configWith(server = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  // 空令牌 + 共享网络会让 MCP 子进程能访问本机控制台；管理器现在 fail-closed。
  cfg.server = { ...(cfg.server || {}), token: 'test-console-token' };
  cfg.mcp = {
    enabled: true,
    servers: [{
      id: 'fake',
      command: process.execPath,
      args: [fixture],
      timeoutMs: 10000,
      ...server
    }]
  };
  setRuntimeConfig(cfg);
  return cfg;
}

it('空令牌控制台 + 未隔离网络：MCP server 必须拒绝启动', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...(cfg.server || {}), token: '' };
  cfg.mcp = {
    enabled: true,
    servers: [{ id: 'unsafe', command: process.execPath, args: [fixture], timeoutMs: 5000 }]
  };
  setRuntimeConfig(cfg);
  const manager = new McpManager();
  try {
    await manager.start();
    assert.equal(manager.status().filter((row) => row.ready).length, 0, '不能把可访问本机控制台的子进程拉起来');
    assert.equal(manager.toolDefsFor().length, 0);
  } finally {
    manager.stop();
  }
});

it('启动 stdio server，列出工具并调用', async () => {
  configWith();
  const manager = new McpManager();
  try {
    await manager.start();
    const status = manager.status();
    assert.equal(status.length, 1);
    assert.equal(status[0].ready, true);
    assert.deepEqual(status[0].tools, ['echo']);
    const def = manager.toolDefsFor().find((entry) => entry.name === 'mcp_fake_echo');
    assert.ok(def, 'direct 挂载应生成 mcp_<server>_<tool>');
    const result = await def.execute({}, { text: 'hi' });
    assert.equal(result.content, 'echo:hi');
    assert.equal(result.isError, false);
  } finally {
    manager.stop();
  }
});

it('inputSchema 超过上限的工具不挂载，正常工具不受影响', async () => {
  configWith({ env: { MCP_FAKE_OVERSIZED: '1' } });
  const manager = new McpManager();
  try {
    await manager.start();
    const names = manager.toolDefsFor().map((entry) => entry.name);
    assert.ok(names.includes('mcp_fake_echo'), '正常 schema 仍要挂载');
    assert.ok(!names.includes('mcp_fake_oversized'), '超大 schema 必须整条摘掉');
    assert.ok(manager.status()[0].tools.includes('oversized'), '状态里仍能看到 server 自报的工具');
  } finally {
    manager.stop();
  }
});

it('meta 挂载只暴露一个 mcp_call，仍能转发到 server', async () => {
  configWith({ toolMounting: 'meta' });
  const manager = new McpManager();
  try {
    await manager.start();
    const names = manager.toolDefsFor().map((entry) => entry.name);
    assert.deepEqual(names, ['mcp_call']);
    const def = manager.toolDefsFor()[0];
    const result = await def.execute({}, { server: 'fake', tool: 'echo', arguments: { text: 'yo' } });
    assert.equal(result.content, 'echo:yo');
  } finally {
    manager.stop();
  }
});

it('server 不回应 initialize 时按超时失败并清理进程', async () => {
  const client = new McpStdioClient({
    id: 'hang',
    command: process.execPath,
    args: [hangFixture],
    timeoutMs: 1000
  });
  await assert.rejects(() => client.start(), /超时/);
  assert.equal(client.running, false);
  client.stop();
});

it('未知 server / 未知工具返回可读错误，不抛崩', async () => {
  configWith({ toolMounting: 'meta' });
  const manager = new McpManager();
  try {
    await manager.start();
    const def = manager.toolDefsFor()[0];
    const noServer = await def.execute({}, { server: 'nope', tool: 'echo', arguments: {} });
    assert.equal(noServer.isError, true);
    assert.match(noServer.content, /没有这个 MCP server/);
    const noTool = await def.execute({}, { server: 'fake', tool: 'nope', arguments: {} });
    assert.equal(noTool.isError, true);
    assert.match(noTool.content, /调用失败/);
  } finally {
    manager.stop();
  }
});

it('总开关关闭时不再把 MCP 工具交给模型', async () => {
  const cfg = configWith();
  const manager = new McpManager();
  try {
    await manager.start();
    assert.ok(manager.toolDefsFor().length > 0);
    cfg.mcp.enabled = false;
    setRuntimeConfig(cfg);
    assert.deepEqual(manager.toolDefsFor(), []);
  } finally {
    manager.stop();
  }
});

it('总开关关闭时，已保存的 server 仍出现在状态里并标未启用', async () => {
  const cfg = configWith();
  cfg.mcp.enabled = false;
  setRuntimeConfig(cfg);
  const manager = new McpManager();
  try {
    const rows = manager.status();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'fake');
    assert.equal(rows[0].ready, false);
    assert.equal(rows[0].globalEnabled, false);
    assert.equal(rows[0].enabled, false);
  } finally {
    manager.stop();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}

it('server 调用中崩溃后自动重启，工具重新挂载可用', async () => {
  configWith({ env: { MCP_FAKE_EXIT_ON_CALL: '1' } });
  const manager = new McpManager({ restartBaseMs: 50, restartMaxMs: 200 });
  try {
    await manager.start();
    const def = manager.toolDefsFor().find((entry) => entry.name === 'mcp_fake_echo');
    const crashed = await def.execute({}, { text: 'boom' });
    assert.equal(crashed.isError, true, '崩溃中的调用必须报错而不是挂住');
    assert.equal(await waitFor(() => manager.status()[0]?.ready), true, '崩溃后应自动重启并恢复就绪');
    const row = manager.status()[0];
    assert.deepEqual(row.tools, ['echo']);
    assert.equal(row.restarting, false);
    assert.ok(manager.toolDefsFor().some((entry) => entry.name === 'mcp_fake_echo'), '重启后工具要重新挂载');
  } finally {
    manager.stop();
  }
});

it('意外退出也清理 sandbox 临时目录（自动重启不会留下孤儿资源）', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-cleanup-'));
  const client = new McpStdioClient({
    id: 'cleanup', command: process.execPath, args: [fixture], timeoutMs: 2000
  });
  try {
    await client.start();
    client.cleanup = { tempHome };
    client.proc.kill('SIGKILL');
    assert.equal(await waitFor(() => !fs.existsSync(tempHome), 2000), true);
  } finally {
    client.stop();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('连续 3 次调用超时后杀掉子进程，交给管理器自动重启', async () => {
  configWith({ env: { MCP_FAKE_HANG_CALL: '1' }, timeoutMs: 80 });
  const manager = new McpManager({ restartBaseMs: 50, restartMaxMs: 200 });
  try {
    await manager.start();
    const def = manager.toolDefsFor().find((entry) => entry.name === 'mcp_fake_echo');
    for (let i = 0; i < 3; i += 1) {
      const result = await def.execute({}, { text: 'hang' });
      assert.equal(result.isError, true);
      assert.match(result.content, /超时/);
    }
    assert.equal(await waitFor(() => manager.status()[0]?.restartAttempts >= 1, 3000), true, '卡死应触发自动重启');
    assert.equal(await waitFor(() => manager.status()[0]?.ready, 3000), true, '重启后应恢复就绪');
  } finally {
    manager.stop();
  }
});

it('启动失败会退避重试，超过上限后停止并给出可读错误', async () => {
  configWith({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
  const manager = new McpManager({ restartBaseMs: 50, restartMaxMs: 50, maxRestarts: 2 });
  try {
    await manager.start();
    assert.equal(await waitFor(() => /已停止重试/.test(manager.status()[0]?.error || '')), true);
    const row = manager.status()[0];
    assert.match(row.error, /连续 2 次自动重启未成功/);
    assert.equal(row.restarting, false);
    assert.equal(row.restartAttempts, 2);
  } finally {
    manager.stop();
  }
});

it('主动 stop() 取消待执行的重启，不会把关闭当成崩溃', async () => {
  configWith();
  const manager = new McpManager({ restartBaseMs: 50 });
  try {
    await manager.start();
    manager.clients.get('fake').client.proc.kill('SIGKILL');
    assert.equal(await waitFor(() => Boolean(manager.clients.get('fake')?.restartTimer)), true);
    manager.stop();
    await sleep(200);
    assert.equal(manager.clients.size, 0);
  } finally {
    manager.stop();
  }
});

it('要求网络隔离但本机不支持时启动失败，不静默退化成可联网', async (t) => {
  if (process.platform === 'linux') return t.skip('Linux 是否支持 netns 由内核决定，改在部署机验证');
  const client = new McpStdioClient({
    id: 'iso',
    command: process.execPath,
    args: ['-e', ''],
    networkIsolation: true
  });
  await assert.rejects(() => client.start(), /网络隔离/);
  client.stop();
});

it('permissionIsolation：以 Node 权限模型启动，只读入口目录且能正常列工具', async () => {
  const client = new McpStdioClient({
    id: 'isolated',
    command: process.execPath,
    args: [fixture],
    permissionIsolation: true
  });
  try {
    await client.start();
    assert.equal(client.permissionActive, true);
    assert.deepEqual(client.tools.map((tool) => tool.name), ['echo']);
  } finally {
    client.stop();
  }
});

it('permissionIsolation：外壳命令与非 node 进程 fail-closed，不假装隔离', async () => {
  const shell = new McpStdioClient({
    id: 'shell', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], permissionIsolation: true
  });
  await assert.rejects(() => shell.start(), (error) => error.code === 'E_MCP_ISOLATION' && /只支持直接用 node/.test(error.message));
  shell.stop();
});

it('permissionIsolation：读取白名单不能覆盖数据目录', async () => {
  const inside = path.join(dir, 'mcp-server.mjs');
  fs.writeFileSync(inside, '');
  const client = new McpStdioClient({
    id: 'inside', command: process.execPath, args: [inside], permissionIsolation: true
  });
  await assert.rejects(() => client.start(), /数据目录/);
  client.stop();
});

it('隔离模式剥掉能改写启动行为的注入变量，业务凭据保留', async () => {
  const { stripIsolationEnv } = await import('../src/mcp/isolation.js');
  assert.deepEqual(stripIsolationEnv({
    NODE_OPTIONS: '--require ./evil.js',
    NODE_PATH: '/tmp/modules',
    LD_PRELOAD: '/tmp/evil.so',
    LD_AUDIT: '/tmp/audit.so',
    DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    GITHUB_TOKEN: 'keep-me'
  }), { GITHUB_TOKEN: 'keep-me' });
});

it('permissionIsolation：args 里夹带权限/加载器参数一律拒绝', async () => {
  const { mcpPermissionSpec } = await import('../src/mcp/isolation.js');
  const server = path.join(dir, 'mcp-server.mjs');
  for (const flag of [
    '--permission', '--experimental-permission', '--allow-fs-read=/', '--allow-fs-write=/tmp',
    '--allow-child-process', '--max-old-space-size=64', '--require', '-r', '--import=x',
    '--loader', '--experimental-loader=x', '-e', '--eval=1', '-p', '--print=x',
    '--openssl-config=/tmp/x.cnf', '--icu-data-dir=/tmp', '--snapshot-blob=/tmp/x.blob'
  ]) {
    const spec = mcpPermissionSpec({ command: process.execPath, args: [flag, server] });
    assert.equal(spec.ok, false, `${flag} 必须被拒绝，否则白名单可被追加参数绕过`);
    assert.match(spec.error, /不允许在 args 里传权限\/加载器参数/);
  }
});

it('permissionIsolation：读取目录取最后一个入口脚本，避开 -r 预加载脚本', async () => {
  const { mcpReadDir } = await import('../src/mcp/isolation.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-args-'));
  try {
    const preload = path.join(base, 'preload.js');
    const server = path.join(base, 'server.mjs');
    fs.writeFileSync(preload, '');
    fs.writeFileSync(server, '');
    assert.equal(mcpReadDir({ args: ['-r', preload, server] }), base);
    assert.equal(mcpReadDir({ args: [server, '--flag'] }), base);
    assert.equal(mcpReadDir({ args: [], cwd: base }), base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

it('网络隔离包装：内层命令保持 node 本身，不能拼成 unshare unshare', async () => {
  const { wrapWithNetns } = await import('../src/mcp/isolation.js');
  const spec = wrapWithNetns('/usr/bin/node', ['--permission', '/srv/mcp/server.mjs']);
  assert.equal(spec.command, 'unshare');
  assert.deepEqual(spec.args, [
    '--user', '--map-root-user', '--net',
    '/usr/bin/node', '--permission', '/srv/mcp/server.mjs'
  ]);
});

it('networkIsolation：Linux 支持 netns 时真实启动，工具可用', async (t) => {
  if (process.platform !== 'linux') return t.skip('只有 Linux 有 unshare/netns');
  const { networkIsolationSupported } = await import('../src/plugins/isolation.js');
  const probe = networkIsolationSupported();
  if (!probe.ok) return t.skip(probe.error);
  const client = new McpStdioClient({
    id: 'netiso', command: process.execPath, args: [fixture],
    networkIsolation: true, timeoutMs: 15000
  });
  try {
    await client.start();
    assert.deepEqual(client.tools.map((tool) => tool.name), ['echo']);
  } finally {
    client.stop();
  }
});

it('networkIsolation + permissionIsolation：两层叠加仍能启动', async (t) => {
  if (process.platform !== 'linux') return t.skip('只有 Linux 有 unshare/netns');
  const { networkIsolationSupported } = await import('../src/plugins/isolation.js');
  const probe = networkIsolationSupported();
  if (!probe.ok) return t.skip(probe.error);
  const client = new McpStdioClient({
    id: 'bothiso', command: process.execPath, args: [fixture],
    networkIsolation: true, permissionIsolation: true, timeoutMs: 15000
  });
  try {
    await client.start();
    assert.equal(client.permissionActive, true);
    assert.deepEqual(client.tools.map((tool) => tool.name), ['echo']);
  } finally {
    client.stop();
  }
});

it('permissionIsolation：允许目录里的软链指向数据目录时拒绝启动', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-link-'));
  try {
    const allowed = path.join(base, 'allowed');
    fs.mkdirSync(allowed);
    fs.writeFileSync(path.join(allowed, 'mcp-server.mjs'), '');
    try {
      fs.symlinkSync(dir, path.join(allowed, 'leak'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`本机不允许创建软链：${error.code}`);
      return;
    }
    const { mcpPermissionSpec } = await import('../src/mcp/isolation.js');
    const spec = mcpPermissionSpec({
      command: process.execPath,
      args: [path.join(allowed, 'mcp-server.mjs')]
    });
    assert.equal(spec.ok, false);
    assert.match(spec.error, /权限白名单不安全/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('管理器 close() 后不再拉起 MCP server，进程退出阶段不会复活子进程', async () => {
  configWith();
  const manager = new McpManager({ restartBaseMs: 50 });
  await manager.start();
  assert.equal(manager.status()[0].ready, true);
  manager.close();
  assert.equal(manager.clients.size, 0);
  assert.deepEqual(await manager.start(), []);
  await sleep(150);
  assert.equal(manager.clients.size, 0);
  assert.equal(manager.status()[0].ready, false);
});

it('管理器：permissionIsolation 生效并在状态里标明', async () => {
  configWith({ permissionIsolation: true });
  const manager = new McpManager();
  try {
    await manager.start();
    const status = manager.status();
    assert.equal(status[0].ready, true);
    assert.equal(status[0].permissionIsolation, true);
    assert.equal(status[0].permissionActive, true);
  } finally {
    manager.stop();
  }
});
