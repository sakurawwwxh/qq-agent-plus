import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clearAdminServices, getAdminServices } from '../src/admin/index.js';
import { createAdminServices } from '../src/admin/bootstrap.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-boot-'));
  t.after(() => {
    clearAdminServices();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const replies = [];
  const effects = new Map();
  let seq = 0;
  const cfg = { admin: { ownerUin: '10001' }, allow: { groups: ['433397830'] }, deny: { groups: [] } };
  const store = {
    listChats: () => ['group:433397830'],
    getChatMeta: () => ({ held: 0 }),
    findByMid: () => null,
    hasUncertainEffects: () => false,
    outboxStats: () => ({ total: 0, byState: {} }),
    queueStats: () => ({ byState: {}, oldestAgeMs: 0 }),
    unknownSummaryAll: () => ({ total: 0, oldestAgeMs: 0 })
  };
  const onebot = {
    selfId: '999',
    connected: true,
    async call(action) {
      if (action === 'get_group_list') return [{ group_id: 433397830, group_name: '测试群' }];
      throw new Error(`unexpected ${action}`);
    }
  };
  const sender = {
    async sendTextBatch(target, list) {
      replies.push([target, list[0]]);
      return { sent: [{ messageId: `m${++seq}` }], failed: [] };
    }
  };
  const ledger = {
    begin() { return { id: `e${++seq}`, action: 'proceed' }; },
    settle() { effects.set('settled', true); return true; },
    get() { return null; }
  };
  const services = createAdminServices({
    dataDir: dir, store, sender, onebot, effects: ledger,
    pluginRegistry: { handleOwnerApprovalText: () => ({ handled: false }) },
    getIdentityPilot: () => null, getConfig: () => cfg, getMcp: () => null, log: () => {}
  });
  return { dir, services, replies, cfg };
}

test('bootstrap：管理员私聊「发到群」直接回复预览，不动模型；普通私聊不拦截', async (t) => {
  const { services, replies } = fixture(t);
  assert.equal(getAdminServices(), services);
  const handled = await services.handlePrivateMessage({
    post_type: 'message', message_type: 'private', user_id: '10001', raw_message: '发到群 433397830 晚上好'
  });
  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0][1], /准备发送到/);
  assert.match(replies[0][1], /确认 \d{6}/);
  assert.equal(services.actions.listPending().length, 1);

  const normal = await services.handlePrivateMessage({
    post_type: 'message', message_type: 'private', user_id: '10001', raw_message: '今天吃什么'
  });
  assert.equal(normal, false);
  assert.equal(replies.length, 1);
});
