// unknown 超期释放策略：默认关闭；开启后按 run 同步 effect 账本并刷新控制台。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-outbox-policy-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { updateConfig } = await import('../src/core/config.js');
const { releaseStaleUnknown } = await import('../src/core/outbox-auto-release.js');

test('默认关闭：连 store 都不碰', () => {
  let called = false;
  const out = releaseStaleUnknown({
    store: { autoReleaseStaleUnknown: () => { called = true; return { released: 1 }; } }
  });
  assert.equal(called, false);
  assert.equal(out.released, 0);
});

test('开启后：整 run 释放时同步账本，并通知控制台刷新', () => {
  updateConfig({ outbox: { unknownAutoReleaseDays: 7 } });
  try {
    const calls = [];
    const out = releaseStaleUnknown({
      store: {
        autoReleaseStaleUnknown: (days) => {
          calls.push(['store', days]);
          return {
            released: 1,
            chats: ['group:1'],
            operations: [{ operationId: 'op1', runId: 'run1', remaining: 0 }]
          };
        }
      },
      effects: {
        settle: (...args) => { calls.push(['settle', ...args]); return true; }
      },
      emit: (...args) => calls.push(['emit', ...args])
    });
    assert.equal(out.released, 1);
    assert.deepEqual(calls[0], ['store', 7]);
    assert.equal(calls[1][0], 'settle');
    assert.equal(calls[1][1], 'run1');
    assert.deepEqual(calls[2], ['emit', 'chat-update', 'group:1']);
  } finally {
    updateConfig({ outbox: { unknownAutoReleaseDays: 0 } });
  }
});

test('开启后：每条自动释放写 outbox.auto-release 审计，保留条数与策略天数', () => {
  updateConfig({ outbox: { unknownAutoReleaseDays: 7 } });
  try {
    releaseStaleUnknown({
      store: {
        autoReleaseStaleUnknown: () => ({
          released: 2,
          chats: ['group:1'],
          operations: [
            { operationId: 'op1', runId: 'run1', chatKey: 'group:1', remaining: 0 },
            { operationId: 'op2', runId: 'run1', chatKey: 'group:1', remaining: 1 }
          ]
        })
      },
      effects: {},
      emit: () => {}
    });
    const logDir = path.join(dir, 'audit-log');
    const file = fs.readdirSync(logDir).find((name) => /^audit-\d{6}\.jsonl$/.test(name));
    assert.ok(file, '自动释放必须落审计，不能只留汇总日志');
    const records = fs.readFileSync(path.join(logDir, file), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.action === 'outbox.auto-release' && entry.target === 'group:1');
    assert.equal(records.length, 2, '每个 operation 一条审计');
    assert.equal(records[0].target, 'group:1');
    assert.equal(records[0].after.operationId, 'op1');
    assert.equal(records[0].after.runId, 'run1');
    assert.equal(records[0].after.policyDays, 7);
    assert.equal(records[0].after.remaining, 0);
    assert.equal(records[1].after.operationId, 'op2');
    assert.equal(records[1].after.remaining, 1);
  } finally {
    updateConfig({ outbox: { unknownAutoReleaseDays: 0 } });
  }
});
