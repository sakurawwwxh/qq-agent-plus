// #85：入站慢操作不再阻塞同会话后续消息。
// 引用/@昵称/合并转发的网络解析放到后台，消息先以 deferred 占位入库；
// 富化完成后过黑名单再放行。预算到点也必须按占位符收尾。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ingest-defer-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.QQ_AGENT_SKIP_INDEX_WARM = '1';
process.env.QQ_AGENT_SKIP_NETWORK_PROBES = '1';
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, { timeout = 3000, step = 10 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  throw new Error('waitFor 超时');
}
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime = { ...cfg.runtime, mode: 'active' };
cfg.allow = { ...cfg.allow, groups: ['1'], private: [] };
cfg.messageTypes = { ...cfg.messageTypes, expandForward: true, enrichTimeoutMs: 200 };
cfg.api = { ...cfg.api, baseUrl: '', apiKey: '', model: 'mock-model' };
cfg.pacing = { ...cfg.pacing, enabled: false };
updateConfig(cfg);

const app = createApp({ log: () => {} });
app.onebot.selfInfo = { user_id: 888, nickname: 'bot' };
const wakeCalls = [];
app.orchestrator.onIncoming = (chatKey) => { wakeCalls.push(chatKey); };
let mid = 1000;

function groupEvent(message, extra = {}) {
  mid += 1;
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    message_id: mid,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 42, nickname: '群友' },
    message,
    ...extra
  };
}

function textEvent(text) {
  return groupEvent([{ type: 'text', data: { text } }]);
}

function rowByMid(id) {
  return app.store.recent('group:1', { limit: 100 }).find((row) => Number(row.mid) === Number(id)) || null;
}

test.after(async () => {
  await app.stop().catch(() => {});
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
});

test('慢引用解析不阻塞后续普通消息；到点按占位符放行', async () => {
  app.onebot.getMsg = () => new Promise(() => {});   // 模拟协议端永不返回
  wakeCalls.length = 0;
  const slow = groupEvent([
    { type: 'reply', data: { id: '9000' } },
    { type: 'text', data: { text: '看这个' } }
  ]);
  const started = Date.now();
  await app.onebot.onEvent(slow);
  assert.ok(Date.now() - started < 150, `慢引用不应阻塞入口，实际 ${Date.now() - started}ms`);

  const before = rowByMid(slow.message_id);
  assert.ok(before, '占位消息应立即落库');
  assert.equal(before.state, 'deferred');
  assert.match(before.text, /\[引用消息\]/);
  assert.equal(wakeCalls.length, 0, '富化完成前不该唤醒');

  // 紧随其后的普通消息必须立刻处理，不能排在慢引用后面
  const fast = textEvent('普通消息');
  const fastStarted = Date.now();
  await app.onebot.onEvent(fast);
  assert.ok(Date.now() - fastStarted < 150, `普通消息不应排队，实际 ${Date.now() - fastStarted}ms`);
  await waitFor(() => wakeCalls.length >= 1);
  assert.deepEqual(wakeCalls, ['group:1'], '普通消息应先唤醒');

  await waitFor(() => rowByMid(slow.message_id)?.state === 'pending');
  const after = rowByMid(slow.message_id);
  assert.match(after.text, /\[引用消息\]看这个/);
  await waitFor(() => wakeCalls.length >= 2);
  assert.equal(wakeCalls.length, 2, '延迟消息收尾后也要唤醒');
});

test('引用消息 id 属于别的群：不把别群原文带进当前群历史', async () => {
  app.onebot.getMsg = async () => ({
    group_id: 2,
    message_type: 'group',
    sender: { card: '别群的人', user_id: 77 },
    message: [{ type: 'text', data: { text: '别群的原文' } }]
  });
  wakeCalls.length = 0;
  const event = groupEvent([
    { type: 'reply', data: { id: '9100' } },
    { type: 'text', data: { text: '看这个' } }
  ]);
  await app.onebot.onEvent(event);
  await waitFor(() => rowByMid(event.message_id)?.state === 'pending');
  const row = rowByMid(event.message_id);
  assert.match(row.text, /\[引用消息\]/);
  assert.doesNotMatch(row.text, /别群的原文/);
});

test('富化后的正文命中黑名单：丢弃且不唤醒', async () => {
  const storeCfg = getConfig().store;
  updateConfig({ store: { ...storeCfg, blacklistKeywords: ['广告'] } });
  try {
    app.onebot.getMsg = async () => {
      await sleep(30);
      return {
        group_id: 1,
        message_type: 'group',
        sender: { card: '广告号', user_id: 7 },
        message: [{ type: 'text', data: { text: '广告内容' } }]
      };
    };
    wakeCalls.length = 0;
    const event = groupEvent([
      { type: 'reply', data: { id: '9001' } },
      { type: 'text', data: { text: '看这个' } }
    ]);
    await app.onebot.onEvent(event);
    assert.equal(rowByMid(event.message_id)?.state, 'deferred');
    await waitFor(() => rowByMid(event.message_id) === null);
    assert.equal(wakeCalls.length, 0);
  } finally {
    updateConfig({ store: { ...getConfig().store, blacklistKeywords: [] } });
  }
});

test('合并转发在后台展开并更新正文', async () => {
  app.onebot.call = async (action, args) => {
    if (action === 'get_forward_msg' && args?.id === 'fwd12345') {
      await sleep(30);
      return { messages: [{ sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '转发正文' } }] }] };
    }
    throw new Error(`unexpected call ${action}`);
  };
  wakeCalls.length = 0;
  const event = groupEvent([{ type: 'forward', data: { id: 'fwd12345' } }]);
  const started = Date.now();
  await app.onebot.onEvent(event);
  assert.ok(Date.now() - started < 150, `转发展开不应阻塞入口，实际 ${Date.now() - started}ms`);
  assert.equal(rowByMid(event.message_id)?.state, 'deferred');
  await waitFor(() => rowByMid(event.message_id)?.text?.includes('转发正文'));
  const row = rowByMid(event.message_id);
  assert.equal(row.state, 'pending');
  assert.equal(wakeCalls.length, 1);
});

test('转发展开超时：保留占位符并放行，不永久卡住', async () => {
  app.onebot.call = () => new Promise(() => {});
  wakeCalls.length = 0;
  const event = groupEvent([{ type: 'forward', data: { id: 'fwd-timeout' } }]);
  await app.onebot.onEvent(event);
  await waitFor(() => rowByMid(event.message_id)?.state === 'pending');
  const row = rowByMid(event.message_id);
  assert.match(row.text, /\[合并转发聊天记录\]/);
  assert.equal(wakeCalls.length, 1);
});

test('handled 收尾必须 ack（源码锚点，防止群游戏/管理员命令又回 pending）', () => {
  const source = fs.readFileSync(new URL('../src/console/app.js', import.meta.url), 'utf8');
  assert.match(source, /reason === 'handled' \? \{ state: 'acked' \}/);
  assert.match(source, /recordOnly \? `\$\{chatKey\}#backlog` : chatKey/);
  assert.match(source, /ingestStopping\) return Promise\.resolve\(\)/);
  assert.match(source, /store\.markRead\(chatKey, \[stored\.id\]\)/);
});
