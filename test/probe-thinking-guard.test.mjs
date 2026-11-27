// probe-thinking 路由的 storedKeyAllowedFor 守卫：掩码/空 Key 时只把服务端已存的明文 Key
// 发给配置里已知的地址（终审补上的闸门，曾被人回归过一次——用真路由 + 真 HTTP 钉住）。
// 注意：控制台启动期会自己对 api.baseUrl 做价目探测（/api/pricing 等），目标服务器上
// 会混进无关流量——断言只认"探测请求"（body 里带 1+1= 那条）。
// 用法：node --test test/probe-thinking-guard.test.mjs（数据目录自动建临时目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-probe-guard-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

// 目标服务：记下每个请求的 authorization / 路径 / body 片段
const seen = [];
const makeTarget = () => http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ auth: String(req.headers.authorization || ''), url: req.url || '', body: body.slice(0, 200) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      data: [{ id: 'm1' }],
      choices: [{ message: { content: '2' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }));
  });
});
const knownTarget = makeTarget();
const otherTarget = makeTarget();
const unknownTarget = makeTarget();
await new Promise((r) => knownTarget.listen(0, '127.0.0.1', r));
await new Promise((r) => otherTarget.listen(0, '127.0.0.1', r));
await new Promise((r) => unknownTarget.listen(0, '127.0.0.1', r));
const knownBase = `http://127.0.0.1:${knownTarget.address().port}/v1`;
const otherBase = `http://127.0.0.1:${otherTarget.address().port}/v1`;
const unknownBase = `http://127.0.0.1:${unknownTarget.address().port}/v1`;

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  // 已知地址 = api.baseUrl 指向 knownTarget；otherTarget 端口不同 = 未知地址。
  // 控制台端口先探测一个空闲口再用（固定段随机端口在并发跑测试时会偶发撞车）。
  server: { port: await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  }), host: '127.0.0.1' },
  api: {
    baseUrl: knownBase, apiKey: 'stored-key-123', model: 'm1',
    extraBody: { 'x-saved-secret': 'saved-extra-secret' },
    thinkingParams: { off: { x_saved_thinking: 'saved-thinking-secret' } }
  },
  providers: [{ id: 'other', baseURL: otherBase, models: ['m1'] }],
  providerKeys: { other: 'other-key-456' }
}));

const { createApp } = await import('../src/console/app.js');
const app = createApp({ log: () => {} });
const consolePort = await app.start();

const postProbe = (baseUrl) => fetch(`http://127.0.0.1:${consolePort}/api/providers/probe-thinking`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ baseUrl, apiKey: '', model: 'm1' })
});
// 只看探测请求（probeThinking 发的消息内容是「只回复数字：1+1=?」），启动期价目探测不算
const probeHits = () => seen.filter((e) => e.body.includes('1+1='));

test('未知地址不回退已存 Key；已知地址才带上', async () => {
  // 未知地址：绝对不能把 stored-key 发出去
  const r1 = await postProbe(unknownBase);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.equal(probeHits().length, 1);
  assert.equal(probeHits().at(-1).auth, '', '已存 Key 不得发往未配置的地址');
  assert.equal(probeHits().at(-1).body.includes('saved-extra-secret'), false, '主渠道 extraBody 不得发往未知地址');
  assert.equal(probeHits().at(-1).body.includes('saved-thinking-secret'), false, '主渠道 thinkingParams 不得发往未知地址');
  assert.equal(probeHits().at(-1).url, '/v1/chat/completions');

  // 另一个已登记 provider：只能用它自己的 Key
  const r2 = await postProbe(otherBase);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).ok, true);
  assert.match(probeHits().at(-1).auth, /^Bearer other-key-456$/);
  assert.equal(probeHits().at(-1).url, '/v1/chat/completions');

  // 当前主地址：回退到当前主 Key
  const r3 = await postProbe(knownBase);
  assert.equal(r3.status, 200);
  assert.equal((await r3.json()).ok, true);
  assert.match(probeHits().at(-1).auth, /^Bearer stored-key-123$/);
  assert.equal(probeHits().at(-1).body.includes('saved-extra-secret'), true, '探测当前主渠道仍应带上已保存的 extraBody');
  assert.equal(probeHits().at(-1).url, '/v1/chat/completions');
});

test('只传 providerId 时按该 provider 地址取 Key，不回退主 Key', async () => {
  const r = await fetch(`http://127.0.0.1:${consolePort}/api/providers/probe-thinking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'other', apiKey: '', model: 'm1' })
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.match(probeHits().at(-1).auth, /^Bearer other-key-456$/, 'providerId 路径必须用该 provider 自己的 Key');
  assert.equal(probeHits().at(-1).body.includes('saved-extra-secret'), false, '不能把主渠道 extraBody 带到另一家');
});

test.after(async () => {
  try { await app.stop(); } catch { /* 已停 */ }
  knownTarget.close();
  otherTarget.close();
  unknownTarget.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄未放就留着 */ }
});
