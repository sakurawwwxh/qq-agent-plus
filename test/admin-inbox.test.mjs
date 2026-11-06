import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createActionStore } from '../src/admin/actions.js';
import { createInbox } from '../src/admin/inbox.js';
import { requestPendingApproval } from '../src/plugins/grants.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const clock = { value: 1_700_000_000_000 };
  const actions = createActionStore({ dataDir: dir, now: () => clock.value });
  const plugin = requestPendingApproval(dir, {
    pluginId: 'demo', pluginName: '演示插件', action: 'write', label: '写一条',
    target: 'BV1', preview: '准备写一条评论'
  });
  const calls = [];
  const pluginRegistry = {
    handleOwnerApprovalText(text, actor) {
      calls.push(['plugin', text, actor]);
      return { handled: true, reply: '已批准（插件）' };
    }
  };
  const identity = {
    async decideIncomingFriendRequest(id, decision, options) {
      calls.push(['friend', id, decision, options]);
      return { note: '已处理好友申请' };
    },
    listIncomingFriendRequests() {
      return [{ id: 'fr_abc123456789', userId: '20002', primaryName: '小明', verifyMessage: '我是小明' }];
    }
  };
  const sendAction = actions.create({
    actor: '10001', targets: ['group:433397830'], items: [{ type: 'text', text: '公告' }]
  }).action;
  actions.update(sendAction.id, { preview: '准备发送到：测试群' });
  const inbox = createInbox({
    dataDir: dir,
    actions,
    getPluginRegistry: () => pluginRegistry,
    getIdentityPilot: () => identity,
    now: () => clock.value,
    audit: () => {}
  });
  return { dir, clock, actions, inbox, plugin, calls, sendAction };
}

test('收件箱聚合插件/好友/发送动作，生成稳定短码并显示发送项', (t) => {
  const { inbox, plugin, sendAction } = fixture(t);
  const items = inbox.list();
  assert.equal(items.length, 3);
  const pluginItem = items.find((item) => item.id === plugin.id);
  assert.match(pluginItem.code, /^\d{6}$/);
  assert.equal(items.find((item) => item.id === sendAction.id).type, 'send');
  const text = inbox.formatList();
  assert.match(text, /插件/);
  assert.match(text, /好友/);
  assert.match(text, /发送/);
  // 同一 key 再列一次，短码保持稳定
  assert.equal(inbox.list().find((item) => item.id === plugin.id).code, pluginItem.code);
});

test('同意插件/拒绝好友按短码分发；短码一次性', async (t) => {
  const { inbox, plugin, calls } = fixture(t);
  const items = inbox.list();
  const pluginCode = items.find((item) => item.id === plugin.id).code;
  const friendCode = items.find((item) => item.type === 'friend').code;
  const approved = await inbox.decide({ code: pluginCode, decision: 'approve', actor: '10001' });
  assert.equal(approved.reply, '已批准（插件）');
  assert.deepEqual(calls[0], ['plugin', `同意 ${plugin.id}`, '10001']);
  await assert.rejects(() => inbox.decide({ code: pluginCode, decision: 'approve', actor: '10001' }), /不存在或已过期/);
  const rejected = await inbox.decide({ code: friendCode, decision: 'reject', actor: '10001' });
  assert.equal(rejected.reply, '已处理好友申请');
  assert.equal(calls[1][0], 'friend');
  assert.equal(calls[1][2], 'reject');
});

test('短码过期后拒绝；发送动作不能用「同意」代替确认', async (t) => {
  const { inbox, clock, sendAction } = fixture(t);
  const items = inbox.list();
  const code = items.find((item) => item.type === 'friend').code;
  const sendItem = items.find((item) => item.id === sendAction.id);
  assert.equal(sendItem.code, undefined);
  clock.value += 11 * 60_000;
  await assert.rejects(() => inbox.decide({ code, decision: 'approve', actor: '10001' }), /不存在或已过期/);
});
