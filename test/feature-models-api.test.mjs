import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-feature-models-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, pathname, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: payload ? 'POST' : 'GET',
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 保留原文 */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', (error) => resolve({ status: 0, body: null, text: String(error?.message || error) }));
    if (payload) req.write(payload);
    req.end();
  });
}

test('feature model routes validate, save per-task, and ignore forged full-config writes', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.api = { ...cfg.api, baseUrl: 'https://main.example/v1', provider: 'main', model: 'main-model', apiKey: 'main-key' };
  cfg.providers = [
    { id: 'main', displayName: 'Main', baseURL: 'https://main.example/v1', models: ['main-model'] },
    { id: 'cheap', displayName: 'Cheap', baseURL: 'https://cheap.example/v1', models: ['cheap-model'] },
    { id: 'other', displayName: 'Other', baseURL: 'https://other.example/v1', models: ['other-model'] }
  ];
  cfg.providerKeys = { main: 'main-key', other: 'other-key' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await app.start();

  const initial = await request(port, '/api/feature-models');
  assert.equal(initial.status, 200, initial.text);
  assert.equal(initial.body?.features?.['group-digest']?.ready, false);
  assert.equal(initial.body?.features?.['group-digest']?.enabled, false);

  const noKey = await request(port, '/api/feature-models', {
    feature: 'group-digest', enabled: true, providerId: 'cheap', model: 'cheap-model'
  });
  assert.equal(noKey.status, 400, noKey.text);
  assert.match(noKey.body?.error || '', /密钥/);
  assert.equal(getConfig().featureModels['group-digest'].enabled, false);

  updateConfig({ providerKeys: { ...getConfig().providerKeys, cheap: 'cheap-key' } });
  const saved = await request(port, '/api/feature-models', {
    feature: 'group-digest', enabled: true, providerId: 'cheap', model: 'cheap-model'
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body?.status?.ready, true);

  // 换提供商但模型仍来自上一家：必须拒绝，不能把 model-a 发到 B 的端点。
  const staleModel = await request(port, '/api/feature-models', {
    feature: 'group-digest', enabled: true, providerId: 'other', model: 'cheap-model'
  });
  assert.equal(staleModel.status, 400, staleModel.text);
  assert.match(staleModel.body?.error || '', /模型列表/);
  assert.equal(getConfig().featureModels['group-digest'].providerId, 'cheap');

  // 旧设置页整包保存不能覆盖这项独立配置。
  const fullSave = await request(port, '/api/config', {
    featureModels: { 'group-digest': { enabled: false, providerId: '', model: '' } }
  });
  assert.equal(fullSave.status, 200, fullSave.text);
  assert.equal(getConfig().featureModels['group-digest'].enabled, true);
  assert.equal(getConfig().featureModels['group-digest'].providerId, 'cheap');

  const disabled = await request(port, '/api/feature-models', {
    feature: 'group-digest', enabled: false, providerId: 'cheap', model: 'cheap-model'
  });
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(getConfig().featureModels['group-digest'].enabled, false);

  // 手动换主渠道时旧渠道的额外请求头不能跟过去（与自动替换/兜底同口径）。
  updateConfig({ api: { extraBody: { authorization: 'Bearer old-secret' }, thinkingParams: { off: { x: 'old' } } } });
  const switched = await request(port, '/api/config', { api: { baseUrl: 'https://other.example/v1' } });
  assert.equal(switched.status, 200, switched.text);
  assert.deepEqual(getConfig().api.extraBody, {});
  assert.deepEqual(getConfig().api.thinkingParams, {});

  // api 整节替换（__replace__）时也必须清空，不能把内层 __replace__ 当普通字段落盘。
  updateConfig({ api: { extraBody: { nested: true }, thinkingParams: { off: { x: 'old' } } } });
  const replaced = await request(port, '/api/config', {
    api: { __replace__: { provider: 'main', baseUrl: 'https://replaced.example/v1', model: 'main-model', apiKey: '' } }
  });
  assert.equal(replaced.status, 200, replaced.text);
  assert.deepEqual(getConfig().api.extraBody, {});
  assert.deepEqual(getConfig().api.thinkingParams, {});
  assert.equal(JSON.stringify(getConfig().api.extraBody).includes('__replace__'), false);

  // 通过「添加提供商」切换主渠道时同样要清掉旧渠道的额外请求头。
  updateConfig({ api: { extraBody: { authorization: 'Bearer old-secret-2' }, thinkingParams: { off: { x: 'old' } } } });
  const added = await request(port, '/api/providers', {
    baseUrl: 'https://brand-new.example/v1', apiKey: 'new-key', models: [{ id: 'new-model', name: 'New Model' }]
  });
  assert.equal(added.status, 200, added.text);
  assert.deepEqual(getConfig().api.extraBody, {});
  assert.deepEqual(getConfig().api.thinkingParams, {});
});
