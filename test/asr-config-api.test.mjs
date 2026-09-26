// 语音转写的配置接口：/api/config 里带的服务端判定（configured / available / keySource / keyProvider）
// 与 /api/asr-key 的明文回读。前端只负责显示这些结论，界面与后端判定不能各算一套
// （2026-09-26 审查：此前界面按"有没有 Key"说"在生效"，而后端对 OpenAI 兼容还要求地址+模型名）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asr-config-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('ASR 状态由服务端判定，并随配置即时变化', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
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
  const asrStatus = async () => (await request('/api/config')).body.asr;

  // 1) 什么都没配：如实说"没配齐"，且 Key 明文不出现
  let st = await asrStatus();
  assert.equal(st.configured, false);
  assert.equal(st.available, false);
  assert.equal(st.keySource, '');
  assert.equal(Object.prototype.hasOwnProperty.call(st, 'apiKey'), false, '接口不得回传明文 Key');

  // 2) 火山 + Key（记下它是给火山存的）→ 配齐
  await request('/api/config', {
    method: 'POST',
    body: { asr: { ...cfg.asr, enabled: true, provider: 'volc', apiKey: 'volc-secret', apiKeyProvider: 'volc' } }
  });
  st = await asrStatus();
  assert.equal(st.configured, true);
  assert.equal(st.available, true);
  assert.equal(st.keySource, 'config');
  assert.equal(st.hasApiKey, true, 'sanitizeConfig 生成的 hasApiKey 仍在');

  // 3) 换成 OpenAI 兼容：Key 是给火山存的 → 不参与请求，判定回落到"没配齐"（凭据不跨供应商）
  // 只发被测字段（控制台保存时也是这个形状：Key 留空/掩码时不在 patch 里）
  await request('/api/config', {
    method: 'POST',
    body: { asr: { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' } }
  });
  st = await asrStatus();
  assert.equal(st.configured, false, '换供应商后旧 Key 不算数');
  assert.equal(st.keyProvider, 'volc');

  // 4) 补上给这家用的 Key → 配齐；/api/asr-key 能回读明文（仅控制台来源）
  await request('/api/config', {
    method: 'POST',
    body: { asr: { apiKey: 'sf-secret', apiKeyProvider: 'openai' } }
  });
  st = await asrStatus();
  assert.equal(st.configured, true);
  const key = await request('/api/asr-key');
  assert.equal(key.status, 200);
  assert.equal(key.body.apiKey, 'sf-secret');

  // 5) 开关一关：available 立刻为假（工具不再注入）
  await request('/api/config', { method: 'POST', body: { asr: { enabled: false } } });
  st = await asrStatus();
  assert.equal(st.configured, true, '配置还在');
  assert.equal(st.available, false, '但开关关掉就不生效');
});
