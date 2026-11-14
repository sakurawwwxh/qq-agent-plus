// 整应用入口的模拟：不连真实 QQ/协议端，只把真实事件对象喂给 createApp 的 OneBot onEvent。
// 覆盖群内 owner 命令、撤回 notice 和群聊 @ 的 1200ms 连发合并窗口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-app-ingress-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.QQ_AGENT_SKIP_INDEX_WARM = '1';
process.env.QQ_AGENT_SKIP_NETWORK_PROBES = '1';
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

const OWNER = '900001';
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime = { ...cfg.runtime, mode: 'active', paused: false };
cfg.allow = { ...cfg.allow, groups: ['1'], private: [] };
cfg.admin = { ...(cfg.admin || {}), ownerUin: OWNER, groupCommands: { enabled: true, chats: ['1'] } };
cfg.api = { ...cfg.api, baseUrl: '', apiKey: '', model: 'mock-model' };
cfg.pacing = { ...cfg.pacing, enabled: false };
cfg.groupGame = { ...(cfg.groupGame || {}), enabled: false };
cfg.livingMemory = { ...(cfg.livingMemory || {}), enabled: false };
cfg.server = { ...(cfg.server || {}), token: 'test-console-token', singleInstanceLock: false };
updateConfig(cfg);

const app = createApp({ log: () => {} });
app.onebot.selfInfo = { user_id: 888, nickname: 'bot' };
const wakes = [];
const sent = [];
const realOnIncoming = app.orchestrator.onIncoming.bind(app.orchestrator);
app.orchestrator.onIncoming = (chatKey) => wakes.push(chatKey);
app.sender.sendTextBatch = async (chatKey, messages, options = {}) => {
  sent.push({ chatKey, messages: [...messages], options });
  return { sent: messages.map((text, i) => ({ text, messageId: `test-${i}` })), failed: [] };
};

let mid = 2000;
const groupEvent = (text, senderId = '42') => ({
  post_type: 'message', message_type: 'group', group_id: 1,
  message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: Number(senderId), nickname: senderId === OWNER ? '主人' : '群友' },
  message: [{ type: 'text', data: { text } }]
});

test.after(async () => {
  await app.stop().catch(() => {});
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
});

test('整应用入口：owner 群命令在模型前被消费并回复', async () => {
  const event = groupEvent('状态', OWNER);
  await app.onebot.onEvent(event);
  assert.equal(wakes.length, 0, '命令不能唤醒模型');
  assert.equal(sent.length, 1, '命令要回复一条');
  assert.match(sent[0].messages[0], /状态：/);
  const row = app.store.recent('group:1', { limit: 10 }).find((m) => Number(m.mid) === event.message_id);
  assert.equal(row?.state, 'acked', '命令要先标读');
});

test('整应用入口：群成员撤回消息后存档变占位且不再未读', async () => {
  wakes.length = 0;
  const event = groupEvent('这条要撤回', '42');
  await app.onebot.onEvent(event);
  assert.equal(wakes.length, 1, '普通消息先进入普通链路');
  const before = app.store.recent('group:1', { limit: 10 }).find((m) => Number(m.mid) === event.message_id);
  assert.equal(before.state, 'pending');

  await app.onebot.onEvent({
    post_type: 'notice', notice_type: 'group_recall', group_id: 1,
    message_id: event.message_id, user_id: 42, operator_id: 42,
    time: Math.floor(Date.now() / 1000) + 1
  });
  const after = app.store.recent('group:1', { limit: 10 }).find((m) => Number(m.mid) === event.message_id);
  assert.equal(after.state, 'acked');
  assert.equal(after.text, '[消息已撤回]');
  assert.equal(after.media.length, 0);
  assert.equal(wakes.length, 1, '撤回不能再唤醒一轮');
});

test('整应用入口：群聊 @ 使用 1200ms 连发合并窗口', async () => {
  const delays = [];
  app.orchestrator.onIncoming = realOnIncoming;
  const original = app.orchestrator.scheduleWake.bind(app.orchestrator);
  app.orchestrator.scheduleWake = (chatKey, delay = null, options = {}) => {
    const scheduled = original(chatKey, delay, options);
    if (scheduled) delays.push(delay);
    return scheduled;
  };
  try {
    const event = groupEvent('在吗', '42');
    event.message = [{ type: 'at', data: { qq: '888' } }, { type: 'text', data: { text: ' 在吗' } }];
    await app.onebot.onEvent(event);
    for (let i = 0; i < 100 && !delays.length; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(delays.at(-1), 1200);
  } finally {
    app.orchestrator.scheduleWake = original;
    app.orchestrator.onIncoming = (chatKey) => wakes.push(chatKey);
    app.orchestrator.abortSchedule?.('group:1');
  }
});
