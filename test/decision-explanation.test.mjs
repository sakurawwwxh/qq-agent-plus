// 回复决策快照与持久化：解释字段稳定、每会话环形上限、坏文件不炸。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildDecisionSnapshot, createDecisionLog } from '../src/core/decision-explanation.js';

test('buildDecisionSnapshot：命中、预算、连发和消息 id 都可解释', () => {
  const entries = [
    { id: 1, mentionsSelf: true, ts: 1000, senderId: 'a' },
    { id: 2, ts: 1500, senderId: 'a' },
    { id: 3, reply: { senderId: 'bot' }, ts: 1600, senderId: 'b' }
  ];
  const snap = buildDecisionSnapshot({
    chatKey: 'group:1', pendingEntries: entries, selfId: 'bot',
    cfg: { store: { randomPercent: 60 } },
    budget: { enabled: true, exceeded: false, onExceed: 'degrade', spentYuan: 1.2, limitYuan: 20 },
    tierResult: { shouldRespond: false, tier: 2, reason: '随机未命中', count: 3, roll: 77 },
    conversationMode: 'lifecycle', outcome: 'skipped'
  });
  assert.equal(snap.outcome, 'skipped');
  assert.equal(snap.hits.atMe, true);
  assert.equal(snap.hits.replyToMe, true);
  assert.equal(snap.hits.probability, true);
  assert.equal(snap.pendingCount, 3);
  assert.deepEqual(snap.messageIds, [1, 2, 3]);
  assert.equal(snap.budget.limitYuan, 20);
  assert.equal(snap.burst.burstGroups, 1);
  assert.equal(snap.burst.burstMessages, 2);
  assert.equal(snap.percent, 60);
  assert.equal(snap.roll, 77);
  assert.equal(snap.conversationMode, 'lifecycle');
});

test('createDecisionLog：按会话保留最近 20 条，重启后仍可读', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-decision-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'decision-log.json');
  const log = createDecisionLog({ file, limit: 500, perChat: 20 });
  for (let i = 0; i < 25; i += 1) {
    log.set('group:1', { at: i, outcome: 'skipped', reason: `r${i}` });
  }
  log.set('group:2', { at: 99, outcome: 'skipped', reason: 'other' });
  const list = log.list('group:1');
  assert.equal(list.length, 20);
  assert.equal(list[0].reason, 'r24');
  assert.equal(log.get('group:1').reason, 'r24');
  assert.equal(log.get('group:2').reason, 'other');

  const reopened = createDecisionLog({ file });
  assert.equal(reopened.get('group:1').reason, 'r24');
  assert.equal(reopened.list('group:1').length, 20);
});

test('createDecisionLog：坏 JSON 按空日志继续，不抛', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-decision-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'decision-log.json');
  fs.writeFileSync(file, '{ broken');
  const log = createDecisionLog({ file, log: { warn() {} } });
  assert.equal(log.get('group:1'), null);
  log.set('group:1', { at: 1, reason: 'ok' });
  assert.equal(log.get('group:1').reason, 'ok');
});
