// 连发分组的纯函数测试：同一发送者的连续消息才合并，插话/超时断开。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupMessageBursts, hasBurst, burstMeta, directWakeDelayFor } from '../src/core/message-burst.js';

const m = (senderId, ts, text = '') => ({ senderId, ts, text, id: ts, mid: ts });

test('同一发送者连续消息合并成一组，中间插话断开', () => {
  const groups = groupMessageBursts([
    m('a', 1000, '第一句'), m('a', 1200, '第二句'), m('b', 1300, '插话'), m('a', 1400, '第三句')
  ]);
  assert.deepEqual(groups.map((g) => g.entries.length), [2, 1, 1]);
  assert.equal(hasBurst([m('a', 1), m('a', 2)]), true);
  assert.equal(hasBurst([m('a', 1), m('b', 2)]), false);
});

test('间隔超过 maxGapMs 或时间倒序不合并', () => {
  assert.deepEqual(groupMessageBursts([m('a', 1000), m('a', 70000)]).map((g) => g.entries.length), [1, 1]);
  assert.deepEqual(groupMessageBursts([m('a', 5000), m('a', 4000)], { maxGapMs: 60000 }).map((g) => g.entries.length), [1, 1]);
  assert.deepEqual(groupMessageBursts([m('a', 1000), m('a', 2000)], { maxGapMs: 500 }).map((g) => g.entries.length), [1, 1]);
});

test('缺失 senderId 不合并，burstMeta 只统计真正的连发组', () => {
  const groups = groupMessageBursts([{ ts: 1, text: 'x' }, { ts: 2, text: 'y' }]);
  assert.deepEqual(groups.map((g) => g.entries.length), [1, 1]);
  const meta = burstMeta([m('a', 1), m('a', 2), m('a', 3), m('b', 4)]);
  assert.equal(meta.burstGroups, 1);
  assert.equal(meta.burstMessages, 3);
  assert.deepEqual(meta.burstSenders, ['a']);
});

test('直接互动窗口：群聊默认 1200，私聊默认 300，夹在 0–2000', () => {
  assert.equal(directWakeDelayFor('group:1', {}), 1200);
  assert.equal(directWakeDelayFor('private:1', {}), 300);
  assert.equal(directWakeDelayFor('group:1', { burstMergeDelayMs: 500 }), 500);
  assert.equal(directWakeDelayFor('group:1', { burstMergeDelayMs: 99999 }), 2000);
  assert.equal(directWakeDelayFor('private:1', { directWakeDelayMs: 0 }), 0);
  assert.equal(directWakeDelayFor('group:1', { burstMergeDelayMs: 'bad' }), 1200);
});
