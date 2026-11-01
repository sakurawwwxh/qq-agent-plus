import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-conflict-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig, getConfig, reloadConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
after(() => {
  fs.rmSync(path.join(root, 'config.json'), { force: true });
  reloadConfig();
});

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('配置冲突 API：默认 409 不写盘，force 才写，reload 读回磁盘版本', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.webSearch = {
    ...cfg.webSearch,
    providers: [{
      id: 'sp_conflict_1', name: 'old-name', type: 'openai',
      baseUrl: 'https://search.example.com/v1', apiKey: 'sk-old', count: 6, timeoutMs: 20000
    }]
  };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  const file = path.join(root, 'config.json');
  const external = JSON.parse(fs.readFileSync(file, 'utf8'));
  external.api.model = 'external-api-edit';
  fs.writeFileSync(file, `${JSON.stringify(external, null, 2)}\n`);

  const conflict = await request('/api/config', { method: 'POST', body: { api: { temperature: 0.42 } } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CONFIG_CONFLICT');
  assert.ok(conflict.body.configConflict?.backupPath);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).api.model, 'external-api-edit');

  // 写盘失败时不能就地改内存：搜索渠道更新必须走副本（2026-10-31 复审 P2）。
  const providerConflict = await request('/api/search-providers', {
    method: 'POST',
    body: {
      name: 'new-name', type: 'openai', baseUrl: 'https://search.example.com/v1', apiKey: 'sk-new'
    }
  });
  assert.equal(providerConflict.status, 400, JSON.stringify(providerConflict.body));
  assert.match(String(providerConflict.body.error), /CONFIG_CONFLICT|外部|冲突/i);
  const providers = await request('/api/search-providers');
  assert.equal(providers.body.providers[0].name, 'old-name', '失败保存不能改内存里的名称');
  const configAfter = await request('/api/config');
  assert.equal(configAfter.body.webSearch.providers[0].name, 'old-name');

  const forced = await request('/api/config?force=1', { method: 'POST', body: { api: { temperature: 0.42 } } });
  assert.equal(forced.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).api.temperature, 0.42);

  // 外部再改一次，reload 应该把内存切回磁盘版本。
  const next = JSON.parse(fs.readFileSync(file, 'utf8'));
  next.api.model = 'external-again';
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  const reloaded = await request('/api/config/reload', { method: 'POST', body: {} });
  assert.equal(reloaded.status, 200);
  assert.equal(getConfig().api.model, 'external-again');

  // 磁盘文件坏了不能“重载成默认值”把令牌/白名单冲掉，必须拒绝并让用户先修文件。
  fs.writeFileSync(file, '{ broken json');
  const rejected = await request('/api/config/reload', { method: 'POST', body: {} });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'CONFIG_RELOAD_REJECTED');
});
