// #85：deferred 消息状态机（存储层）。
// 入站先落库但不进 unread；富化完成后再放行为 pending/acked，或按黑名单丢弃。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-deferred-store-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { ChatStore } = await import('../src/core/store.js');

test('deferred 不进 unread；更新正文后放行为 pending', (t) => {
  const store = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  t.after(() => store.close());
  const stored = store.appendIncoming('group:1', {
    mid: 1, ts: Date.now(), senderId: '42', senderName: 'A', text: '[合并转发聊天记录]', media: []
  }, { deferred: true });
  assert.equal(stored.state, 'deferred');
  assert.equal(store.unreadCount('group:1'), 0);
  assert.equal(store.getChatMeta('group:1').unread, 0);

  assert.equal(store.updateDeferredMessage('group:1', stored.id, {
    text: 'A: 真实转发正文', reply: { messageId: '9', sender: 'B', text: '被引用' }, media: [{ kind: 'image', url: 'u' }]
  }), 1);
  assert.equal(store.finalizeDeferred('group:1', stored.id), 'pending');
  assert.equal(store.unreadCount('group:1'), 1);
  const row = store.getMessage('group:1', stored.id);
  assert.equal(row.text, 'A: 真实转发正文');
  assert.equal(row.reply.text, '被引用');
  assert.equal(row.state, 'pending');

  // 已放行后再 finalize/update 都是空操作，不会把 pending 误改回去
  assert.equal(store.finalizeDeferred('group:1', stored.id), '');
  assert.equal(store.updateDeferredMessage('group:1', stored.id, { text: 'late' }), 0);
  assert.equal(store.getMessage('group:1', stored.id).text, 'A: 真实转发正文');
});

test('recordOnly 的 deferred 放行后是 acked，不唤醒', (t) => {
  const store = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  t.after(() => store.close());
  const stored = store.appendIncoming('group:2', {
    mid: 2, ts: Date.now(), senderId: '42', senderName: 'A', text: '[引用消息]', media: []
  }, { deferred: true, recordOnly: true });
  assert.equal(store.finalizeDeferred('group:2', stored.id), 'acked');
  assert.equal(store.unreadCount('group:2'), 0);
  assert.equal(store.getChatMeta('group:2').held, 0);
});

test('黑名单丢弃 deferred 时同步回退 message_count', (t) => {
  const store = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  t.after(() => store.close());
  const stored = store.appendIncoming('group:3', {
    mid: 3, ts: Date.now(), senderId: '42', senderName: 'A', text: '正常占位', media: []
  }, { deferred: true });
  assert.equal(store.getChatMeta('group:3').total, 1);
  assert.equal(store.dropDeferredMessage('group:3', stored.id), true);
  assert.equal(store.getMessage('group:3', stored.id), null);
  assert.equal(store.getChatMeta('group:3').total, 0, 'message_count 不能留下幽灵计数');
  assert.equal(store.dropDeferredMessage('group:3', stored.id), false);
});

test('重启时未完成的 deferred 按 release_state 放行', (t) => {
  const store = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  t.after(() => store.close());
  store.appendIncoming('group:4', { mid: 4, ts: Date.now(), senderId: '1', senderName: 'A', text: '唤醒', media: [] }, { deferred: true });
  store.appendIncoming('group:5', { mid: 5, ts: Date.now(), senderId: '1', senderName: 'A', text: '只存档', media: [] }, { deferred: true, recordOnly: true });
  const chats = store.releaseStaleDeferred().sort();
  assert.deepEqual(chats, ['group:4', 'group:5']);
  assert.equal(store.unreadCount('group:4'), 1);
  assert.equal(store.unreadCount('group:5'), 0);
  const pending = store.db.prepare("SELECT state, release_state FROM messages WHERE chat_key='group:4'").get();
  assert.deepEqual({ ...pending }, { state: 'pending', release_state: '' });
  const acked = store.db.prepare("SELECT state, release_state FROM messages WHERE chat_key='group:5'").get();
  assert.deepEqual({ ...acked }, { state: 'acked', release_state: '' });
});

test('长跑进程的兜底只放行超过年龄阈值的 deferred', (t) => {
  const store = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  t.after(() => store.close());
  const fresh = store.appendIncoming('group:6', {
    mid: 6, ts: Date.now(), senderId: '1', senderName: 'A', text: '新的', media: []
  }, { deferred: true });
  const stale = store.appendIncoming('group:7', {
    mid: 7, ts: Date.now(), senderId: '1', senderName: 'A', text: '旧的', media: []
  }, { deferred: true });
  store.db.prepare("UPDATE messages SET deferred_at=? WHERE chat_key='group:7'")
    .run(Date.now() - 120_000);

  assert.deepEqual(store.releaseStaleDeferred({ olderThanMs: 60_000 }), ['group:7']);
  assert.equal(store.getMessage('group:6', fresh.id).state, 'deferred', '新任务不能被误放行');
  assert.equal(store.getMessage('group:7', stale.id).state, 'pending');
});

test('queueStats 覆盖 deferred，并有独立队列索引', (t) => {
  const store = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  t.after(() => store.close());
  store.appendIncoming('group:9', {
    mid: 9, ts: Date.now(), senderId: '1', senderName: 'A', text: '排队', media: []
  }, { deferred: true });
  const stats = store.queueStats();
  assert.ok(stats.byState.deferred >= 1);
  const indexes = store.db.prepare('PRAGMA index_list(messages)').all().map((row) => row.name);
  assert.ok(indexes.includes('messages_queue_stats'), indexes.join(','));
});

test('touchDeferred 从真正开始富化的时刻重新计龄', (t) => {
  const store = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  t.after(() => store.close());
  const stored = store.appendIncoming('group:8', {
    mid: 8, ts: Date.now(), senderId: '1', senderName: 'A', text: '排队', media: []
  }, { deferred: true });
  const old = Date.now() - 120_000;
  store.db.prepare("UPDATE messages SET deferred_at=? WHERE chat_key='group:8'").run(old);
  assert.equal(store.touchDeferred('group:8', stored.id), 1);
  const touched = Number(store.getMessage('group:8', stored.id).deferred_at) || 0;
  assert.ok(touched > old);
  assert.deepEqual(store.releaseStaleDeferred({ olderThanMs: 60_000 }), [], '刚刷新过的行不能被清扫');
});
