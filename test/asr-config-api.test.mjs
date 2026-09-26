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

test('模型列表从服务商官网拉，且保存的 Key 只发给配置里的地址', async (t) => {
  // 造两个"服务商"：一个是我们配置里已知的地址，一个是陌生地址
  const seen = [];
  const makeProvider = async (models) => {
    const server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, auth: req.headers.authorization || '' , url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  };
  // 故意混入 TTS 与通用 LLM：只应列出能转写的那些
  const known = await makeProvider([
    'FunAudioLLM/SenseVoiceSmall', 'Qwen/Qwen3-ASR-1.7B', 'deepseek-chat',
    'FunAudioLLM/CosyVoice2-0.5B', 'tts-1', 'gpt-4o-mini'
  ]);
  const stranger = await makeProvider(['whisper-large-v3-turbo']);
  t.after(async () => { await known.close(); await stranger.close(); });

  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.asr = {
    ...cfg.asr, enabled: true, provider: 'openai',
    baseUrl: `http://127.0.0.1:${known.port}/v1`, model: '', apiKey: 'saved-asr-key', apiKeyProvider: 'openai'
  };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const post = async (body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/asr/models`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  // ① 已知地址 + 不传 Key → 用保存的 Key；**只返回语音模型**（用户要求：列表里混着几百个 LLM 等于找不到）
  const first = await post({ baseUrl: `http://127.0.0.1:${known.port}/v1` });
  assert.equal(first.status, 200);
  assert.equal(seen[0].auth, 'Bearer saved-asr-key', '已知地址才用保存的 Key');
  assert.equal(first.body.speechOnly, true);
  assert.deepEqual(first.body.models, ['FunAudioLLM/SenseVoiceSmall', 'Qwen/Qwen3-ASR-1.7B'],
    '只列能转写的；TTS（CosyVoice2 / tts-1）与通用 LLM 都排除');
  assert.equal(first.body.total, 6, '同时报告全量条数，便于说明"从 6 个里筛出 2 个"');

  // ② 陌生地址 + 不传 Key → **不能**把保存的 Key 发过去
  seen.length = 0;
  const second = await post({ baseUrl: `http://127.0.0.1:${stranger.port}/v1` });
  assert.equal(second.status, 200);
  assert.equal(seen[0].auth, '', '陌生地址不得携带保存的 Key');

  // ③ 用户当场填了 Key → 发给他填的那个地址（这是他的明确意图）
  seen.length = 0;
  await post({ baseUrl: `http://127.0.0.1:${stranger.port}/v1`, apiKey: 'typed-key' });
  assert.equal(seen[0].auth, 'Bearer typed-key');
});

test('这家全是 LLM 时退回全量并说明（不让人以为"拉不到"）', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'gpt-4o-mini' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const providerPort = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'k', apiKeyProvider: 'openai' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const response = await fetch(`http://127.0.0.1:${port}/api/asr/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
  });
  const body = await response.json();
  assert.equal(body.speechOnly, false);
  assert.deepEqual(body.models, ['deepseek-chat', 'gpt-4o-mini'], '认不出语音模型时退回全量');
});

test('语音模型筛选：名字里没有 asr 的转写模型也要留下，TTS 排除并如实回报', async (t) => {
  // 用户 2026-09-26 反馈"硅基流动明明有 8 个语音模型，列表只给 5 个"：
  // 漏掉的是 XingChenGSR（语音识别，名字里没有 asr），另外 2 个是文字转语音（不该进转写列表）。
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // 照硅基流动当天的真实数据来：98 个模型里语音相关正好 8 个（6 个转写 + 2 个语音合成）
    res.end(JSON.stringify({ data: [
      { id: 'deepseek-ai/DeepSeek-V3' },
      { id: 'FunAudioLLM/SenseVoiceSmall' },
      { id: 'Qwen/Qwen3-ASR-1.7B' },
      { id: 'XingChenAGI/XingChenASR-V3.2' },
      { id: 'XingChenAGI/XingChenASR-V3.2-Ultra' },
      { id: 'XingChenAGI/XingChenASR-Diarize-V3.0' },
      { id: 'XingChenAGI/XingChenGSR-V1.0' },
      { id: 'FunAudioLLM/CosyVoice2-0.5B' },
      { id: 'fnlp/MOSS-TTSD-v0.5' },
      { id: 'zai-org/GLM-5.3' }
    ] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const providerPort = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'k', apiKeyProvider: 'openai' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const response = await fetch(`http://127.0.0.1:${port}/api/asr/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
  });
  const body = await response.json();
  assert.equal(body.speechOnly, true);
  assert.ok(body.models.includes('XingChenAGI/XingChenGSR-V1.0'), 'GSR 是语音识别，不该因为名字里没有 asr 就漏掉');
  assert.equal(body.models.includes('FunAudioLLM/CosyVoice2-0.5B'), false, 'TTS 不该进转写列表');
  assert.equal(body.speechCount, 6, '6 个转写类都要在（含名字里没有 asr 的那一个）');
  assert.equal(body.ttsCount, 2, '被排除的 TTS 要如实回报，界面才能解释"少的是哪几个"');
  assert.deepEqual([...body.ttsSample].sort(), ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5']);
  assert.equal(body.total, 10);
});
