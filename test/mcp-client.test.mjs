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
