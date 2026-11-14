// 屏蔽名单对“已经入库、还没领取”的消息也要生效：只在入口丢弃新消息不够。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-blocklist-pending-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');
const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { isBlockedSender, purgeBlockedPending } = await import('../src/core/blocklist.js');

test('屏蔽前入队、尚未领取的消息会被收口，不能进入本轮触发批', (t) => {
  const store = new ChatStore(0, { dataDir: dir, filename: `blocklist-${Date.now()}.sqlite` });
  t.after(() => store.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.blocklist = { '1': ['42'] };
  updateConfig(cfg);
  try {
    store.appendIncoming('group:1', { mid: 1, text: '屏蔽前的话', senderId: '42', senderName: '甲' });
    store.appendIncoming('group:1', { mid: 2, text: '正常消息', senderId: '43', senderName: '乙' });
    assert.equal(store.peekUnread('group:1', 10).length, 2);
    assert.equal(isBlockedSender('group:1', '42'), true);
    assert.equal(isBlockedSender('group:1', '43'), false);
    const changed = purgeBlockedPending(store, 'group:1');
    assert.equal(changed, 1, '只收口被屏蔽成员的消息');
    assert.equal(store.getMessage('group:1', 1)?.state, 'acked');
    assert.deepEqual(store.peekUnread('group:1', 10).map((m) => m.senderId), ['43']);
  } finally {
    updateConfig(structuredClone(DEFAULT_CONFIG));
  }
});
