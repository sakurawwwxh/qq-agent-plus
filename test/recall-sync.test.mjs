// 入站撤回同步：pending 不再唤醒；deferred 收口；acked/leased 都清正文与媒体。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-recall-sync-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');
const { createNoticeDedup } = await import('../src/console/notice-dedup.js');
const { markRecalled, handleRecallNotice } = await import('../src/console/recall-sync.js');

function fixture(t) {
  const store = new ChatStore(0, { dataDir: dir, filename: `recall-${Math.random().toString(36).slice(2)}.sqlite` });
  t.after(() => store.close());
  return store;
}

function append(store, opts = {}, options = {}) {
  return store.appendIncoming('group:1', {
    mid: 1, ts: Date.now(), senderId: '42', senderName: '甲', text: '原始正文',
    media: [{ kind: 'image', url: 'https://example.test/a.png' }], ...opts
  }, options);
}

test('pending 消息撤回后标已读并清空正文/媒体/引用', (t) => {
  const store = fixture(t);
  append(store, { reply: { messageId: '9', sender: '乙', text: '引用原文' } });
  const changed = markRecalled(store, 'group:1', 1);
  assert.equal(changed.previousState, 'pending');
  const row = store.findByMid('group:1', 1);
  assert.equal(store.getMessage('group:1', row.id).state, 'acked');
  assert.equal(row.text, '[消息已撤回]');
  assert.deepEqual(row.media, []);
  assert.equal(row.reply, null);
  assert.equal(row.eventKind, 'recalled');
  assert.equal(store.peekUnread('group:1', 10).length, 0, '撤回后不能再被领取');
});

test('acked 消息撤回只改存档，不动已读状态与其他消息', (t) => {
  const store = fixture(t);
  const row = append(store);
  store.markRead('group:1', [row.id]);
  assert.equal(markRecalled(store, 'group:1', 1).previousState, 'acked');
  assert.equal(store.getMessage('group:1', row.id).state, 'acked');
  assert.equal(store.findByMid('group:1', 1).text, '[消息已撤回]');
});

test('deferred 消息撤回会收口为 acked，富化不能再覆盖', (t) => {
  const store = fixture(t);
  append(store, {}, { deferred: true });
  assert.equal(markRecalled(store, 'group:1', 1).previousState, 'deferred');
  assert.equal(store.findByMid('group:1', 1).state, 'acked');
  assert.equal(store.updateDeferredMessage('group:1', 1, { text: '迟到的富化正文', reply: null, media: [] }), 0);
  assert.equal(store.findByMid('group:1', 1).text, '[消息已撤回]');
});

test('handleRecallNotice 处理群/私聊、去重、找不到消息也不抛', () => {
  const store = fixture({ after: () => {} });
  try {
    const dedup = createNoticeDedup();
    const events = [];
    const group = { notice_type: 'group_recall', group_id: 1, message_id: 1, operator_id: '42', time: 100 };
    append(store);
    assert.equal(handleRecallNotice(group, { store, emit: (name) => events.push(name), dedup }), true);
    assert.equal(handleRecallNotice(group, { store, emit: () => {}, dedup }), true, '重复事件不重复处理');
    assert.equal(events.filter((name) => name === 'message-recalled').length, 1);
    assert.equal(handleRecallNotice({ notice_type: 'friend_recall', user_id: 7, message_id: 2 }, { store }), true);
    assert.equal(handleRecallNotice({ notice_type: 'group_recall', message_id: null }, { store }), false);
  } finally {
    store.close();
  }
});
