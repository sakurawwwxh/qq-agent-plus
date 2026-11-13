// 群管理工具：只允许全局管理员在群里明确要求时执行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-moderation-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools.js');

const OWNER = '900001';
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.admin = { ownerUin: OWNER };
cfg.allow.groups = ['1'];
setRuntimeConfig(cfg);

function context({ senderId = OWNER, entries = null } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      kind: 'group',
      chatId: '1',
      chatKey: 'group:1',
      selfId: '888',
      triggerEntries: entries || [{ senderId, senderName: 'x', self: false, text: '禁言 踢人 撤回 设置管理员' }],
      session: { id: 's', leaseId: 'l', sent: [] },
      store: { findByMid: () => ({ mid: '123', self: false }) },
      onebot: {
        selfId: '888',
        setGroupBan: async (...args) => { calls.push(['ban', ...args]); return {}; },
        kickGroupMember: async (...args) => { calls.push(['kick', ...args]); return {}; },
        deleteMessage: async (...args) => { calls.push(['recall', ...args]); return {}; },
        setGroupAdmin: async (...args) => { calls.push(['admin', ...args]); return {}; }
      },
      emit: () => {}
    }
  };
}

const tool = (name) => buildToolDefs().find((entry) => entry.name === name);

it('管理员可以禁言；分钟换成秒，0 = 解禁', async () => {
  const { ctx, calls } = context();
  const result = await tool('set_group_ban').execute(ctx, { targetUserId: '42', minutes: 10 });
  assert.ok(!result.isError);
  assert.deepEqual(calls[0].slice(0, 2), ['ban', '1']);
  assert.equal(calls[0][3], 600);
  const unban = await tool('set_group_ban').execute(ctx, { targetUserId: '42', minutes: 0 });
  assert.ok(!unban.isError);
  assert.equal(calls[1][3], 0);
});

it('非管理员请求一律拒绝，不会调用协议端', async () => {
  const { ctx, calls } = context({ senderId: '42' });
  const result = await tool('set_group_ban').execute(ctx, { targetUserId: '43', minutes: 10 });
  assert.equal(result.isError, true);
  assert.match(result.content, /全局管理员/);
  assert.equal(calls.length, 0);
});

it('不能对管理员或机器人自己执行管理动作', async () => {
  const { ctx } = context();
  const owner = await tool('kick_group_member').execute(ctx, { targetUserId: OWNER });
  assert.equal(owner.isError, true);
  const self = await tool('kick_group_member').execute(ctx, { targetUserId: '888' });
  assert.equal(self.isError, true);
});

it('撤回与设置管理员走对应 OneBot 接口', async () => {
  const { ctx, calls } = context();
  assert.ok(!(await tool('recall_message').execute(ctx, { messageId: '#123' })).isError);
  assert.ok(!(await tool('set_group_admin').execute(ctx, { targetUserId: '42', enable: true })).isError);
  assert.equal(calls[0][0], 'recall');
  assert.equal(calls[0][1], 123);
  assert.equal(calls[1][0], 'admin');
  assert.equal(calls[1][3], true);
});

it('撤回目标必须能在当前会话定位，不能拿别的群的 message id 删', async () => {
  const { ctx, calls } = context();
  ctx.store = { findByMid: () => null };
  const result = await tool('recall_message').execute(ctx, { messageId: '#999' });
  assert.equal(result.isError, true);
  assert.match(result.content, /当前会话/);
  assert.equal(calls.length, 0);
});

it('机器人撤回自己刚发的消息不需要管理员指令', async () => {
  const { ctx, calls } = context({ senderId: '42' });
  ctx.store = { findByMid: () => ({ mid: '124', self: true }) };
  const result = await tool('recall_message').execute(ctx, { messageId: '#124' });
  assert.ok(!result.isError);
  assert.equal(calls[0][0], 'recall');
  assert.equal(calls[0][1], 124);
});

it('管理员只回“收到”不算授权具体管理动作', async () => {
  const { ctx, calls } = context({ entries: [
    { senderId: '42', senderName: 'member', self: false, text: '把 43 踢了' },
    { senderId: OWNER, senderName: 'admin', self: false, text: '收到' }
  ] });
  const result = await tool('kick_group_member').execute(ctx, { targetUserId: '43' });
  assert.equal(result.isError, true);
  assert.match(result.content, /没有明确的管理指令/);
  assert.equal(calls.length, 0);
});

it('管理员引用/转发别人的“踢了/禁言”不算自己下令', async () => {
  const { ctx, calls } = context({ entries: [{
    senderId: OWNER,
    senderName: 'admin',
    self: false,
    text: '[引用#1·42：把 43 踢了，顺便禁言] ？'
  }] });
  const kick = await tool('kick_group_member').execute(ctx, { targetUserId: '43' });
  assert.equal(kick.isError, true);
  assert.match(kick.content, /没有明确的管理指令/);
  assert.equal(calls.length, 0);
});

it('泛词不再当成管理指令：封面/踢球/“我是管理员吗”都不授权', async () => {
  const cases = [
    ['set_group_ban', { targetUserId: '43', minutes: 5 }, '这个封面不错'],
    ['kick_group_member', { targetUserId: '43' }, '他在踢球'],
    ['set_group_admin', { targetUserId: '43', enable: true }, '我是管理员吗']
  ];
  for (const [name, args, text] of cases) {
    const { ctx, calls } = context({ entries: [{ senderId: OWNER, senderName: 'admin', self: false, text }] });
    const result = await tool(name).execute(ctx, args);
    assert.equal(result.isError, true, `${name}（${text}）不该被授权`);
    assert.equal(calls.length, 0);
  }
});

it('工具表构建后管理员关掉群管理：executeTool 当次就拒绝', async () => {
  const { ctx, calls } = context();
  const defs = [tool('set_group_ban')];
  const disabled = structuredClone(cfg);
  disabled.moderation = { ...(disabled.moderation || {}), enabled: false };
  setRuntimeConfig(disabled);
  try {
    const result = await executeTool(defs, ctx, 'set_group_ban', JSON.stringify({ targetUserId: '42', minutes: 5 }));
    assert.equal(result.isError, true);
    assert.match(String(result.content), /群管理已关闭/);
    assert.equal(calls.length, 0);
  } finally {
    setRuntimeConfig(cfg);
  }
});

it('畸形参数不会反转语义：非整数分钟/非布尔 enable 直接拒绝', async () => {
  const { ctx, calls } = context();
  assert.equal((await tool('set_group_ban').execute(ctx, { targetUserId: '42', minutes: null })).isError, true);
  assert.equal((await tool('set_group_ban').execute(ctx, { targetUserId: '42', minutes: 0.5 })).isError, true);
  assert.equal((await tool('set_group_admin').execute(ctx, { targetUserId: '42', enable: 'true' })).isError, true);
  assert.equal(calls.length, 0);
});

it('批次里管理员之后还有别人发言时，不把群友指令当成管理员授权', async () => {
  const { ctx, calls } = context({ entries: [
    { senderId: OWNER, senderName: 'admin', self: false },
    { senderId: '42', senderName: 'member', self: false }
  ] });
  const result = await tool('set_group_ban').execute(ctx, { targetUserId: '43', minutes: 5 });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

it('前导零不能绕过对自己/管理员的保护', async () => {
  const { ctx, calls } = context();
  const owner = await tool('kick_group_member').execute(ctx, { targetUserId: `0${OWNER}` });
  assert.equal(owner.isError, true);
  const self = await tool('kick_group_member').execute(ctx, { targetUserId: '0888' });
  assert.equal(self.isError, true);
  assert.equal(calls.length, 0);
});

it('非管理员调用撤回/设管理员同样被拒绝', async () => {
  const { ctx, calls } = context({ senderId: '42' });
  assert.equal((await tool('recall_message').execute(ctx, { messageId: '1' })).isError, true);
  assert.equal((await tool('set_group_admin').execute(ctx, { targetUserId: '43', enable: true })).isError, true);
  assert.equal(calls.length, 0);
});
