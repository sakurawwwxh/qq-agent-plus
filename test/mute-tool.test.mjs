// AI 自主禁言：情绪可以自由表达，但目标/角色/时长/冷却/每日次数都由代码硬拦。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mute-tool-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { buildToolDefs } = await import('../src/tools/tools.js');
const { resetMuteStateForTest } = await import('../src/tools/mute.js');

const OWNER = '900001';
const SELF = '888';
let cfg;
let shutUntil;

function setup({ enabled = true, dryRun = false, maxMinutes = 60, cooldownMinutes = 360, dailyLimit = 3 } = {}) {
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ownerUin: OWNER };
  cfg.allow.groups = ['1'];
  cfg.mute = { enabled, dryRun, maxMinutes, cooldownMinutes, dailyLimit };
  setRuntimeConfig(cfg);
  resetMuteStateForTest();
  shutUntil = 0;
}

function context({ entries = [{ senderId: '42', senderName: '张三', self: false, text: '一直刷屏骂人' }], throwOnBan = null } = {}) {
  const calls = [];
  const members = [
    { user_id: Number(SELF), role: 'admin', join_time: 1, card: '机器人' },
    { user_id: 42, role: 'member', join_time: 1, card: '张三', nickname: 'zhangsan', shut_up_timestamp: shutUntil },
    { user_id: 43, role: 'member', join_time: 1, card: '李四', nickname: 'lisi' },
    { user_id: Number(OWNER), role: 'owner', join_time: 1, card: '主人' }
  ];
  return {
    calls,
    ctx: {
      kind: 'group',
      chatId: '1',
      chatKey: 'group:1',
      selfId: SELF,
      triggerEntries: entries,
      session: { id: 's', leaseId: 'l', sent: [] },
      onebot: {
        selfId: SELF,
        getGroupMemberInfo: async (_gid, uid) => {
          const member = members.find((item) => item.user_id === Number(uid));
          if (!member) throw new Error('member not found');
          return { ...member, shut_up_timestamp: member.user_id === 42 ? shutUntil : member.shut_up_timestamp };
        },
        getGroupMemberList: async () => members,
        setGroupBan: async (...args) => {
          if (throwOnBan) throw throwOnBan;
          calls.push(['ban', ...args]);
          return {};
        }
      },
      emit: () => {}
    }
  };
}

const tool = () => buildToolDefs({ kind: 'group', chatId: '1' }).find((entry) => entry.name === 'mute_member');

beforeEach(() => setup());

it('默认关闭；群聊开启后注入，私聊不注入', () => {
  setup({ enabled: false });
  assert.equal(tool(), undefined);
  setup({ enabled: true });
  assert.ok(tool());
  assert.equal(buildToolDefs({ kind: 'private', chatId: '1' }).find((entry) => entry.name === 'mute_member'), undefined);
});

it('dry-run 默认只回计划，不调用协议端', async () => {
  setup({ dryRun: true });
  const { ctx, calls } = context();
  const result = await tool().execute(ctx, { target: '42', minutes: 5, emotion: '烦躁', reason: '刷屏' });
  assert.ok(!result.isError);
  assert.match(result.content, /试运行/);
  assert.equal(calls.length, 0);
});

it('目标必须在本轮触发消息里，且只能是普通成员', async () => {
  const { ctx, calls } = context({ entries: [{ senderId: '43', self: false, text: '别人' }] });
  const result = await tool().execute(ctx, { target: '42', minutes: 5 });
  assert.equal(result.isError, true);
  assert.match(result.content, /这一轮没惹你/);
  assert.equal(calls.length, 0);

  const owner = await tool().execute(ctx, { target: OWNER, minutes: 5 });
  assert.equal(owner.isError, true);
  const self = await tool().execute(ctx, { target: SELF, minutes: 5 });
  assert.equal(self.isError, true);
});

it('支持唯一群名片匹配；重名要求补 QQ 号', async () => {
  const { ctx, calls } = context();
  assert.ok(!(await tool().execute(ctx, { target: '张三', minutes: 5 })).isError);
  assert.equal(calls.length, 1);
  resetMuteStateForTest();
  const list = await ctx.onebot.getGroupMemberList('1');
  ctx.onebot.getGroupMemberList = async () => [...list, { user_id: 44, role: 'member', join_time: 1, card: '张三' }];
  ctx.triggerEntries = [{ senderId: '42', self: false }, { senderId: '44', self: false }];
  const dup = await tool().execute(ctx, { target: '张三', minutes: 5 });
  assert.equal(dup.isError, true);
  assert.match(dup.content, /改填 QQ 号/);
});

it('机器人不是管理员时拒绝', async () => {
  const { ctx } = context();
  ctx.onebot.getGroupMemberInfo = async (_gid, uid) => ({ user_id: Number(uid), role: uid === Number(SELF) ? 'member' : 'member', join_time: 1 });
  const result = await tool().execute(ctx, { target: '42', minutes: 5 });
  assert.equal(result.isError, true);
  assert.match(result.content, /不是群管理员/);
});

it('非法分钟数拒绝，不静默截断', async () => {
  const { ctx, calls } = context();
  for (const minutes of [0.4, true, [], '  ', 61, -0]) {
    const result = await tool().execute(ctx, { target: '42', minutes });
    assert.equal(result.isError, true, String(minutes));
  }
  assert.equal(calls.length, 0);
});

it('成功禁言换算成秒并落盘；同一人冷却期内拒绝', async () => {
  const { ctx, calls } = context();
  const first = await tool().execute(ctx, { target: '42', minutes: 5 });
  assert.ok(!first.isError, first.content);
  assert.deepEqual(calls[0].slice(0, 3), ['ban', '1', 42]);
  assert.equal(calls[0][3], 300);
  const second = await tool().execute(ctx, { target: '42', minutes: 5 });
  assert.equal(second.isError, true);
  assert.match(second.content, /刚处理过/);
  assert.equal(calls.length, 1);
});

it('每群每日次数上限生效', async () => {
  setup({ dailyLimit: 1 });
  const entries = [{ senderId: '42', self: false }, { senderId: '43', self: false }];
  const { ctx, calls } = context({ entries });
  assert.ok(!(await tool().execute(ctx, { target: '42', minutes: 5 })).isError);
  const second = await tool().execute(ctx, { target: '43', minutes: 5 });
  assert.equal(second.isError, true);
  assert.match(second.content, /上限/);
  assert.equal(calls.length, 1);
});

it('解禁只能解自己下过、且没被人类加罚的那条', async () => {
  const { ctx, calls } = context();
  assert.ok(!(await tool().execute(ctx, { target: '42', minutes: 5 })).isError);
  shutUntil = Math.floor(Date.now() / 1000) + 300;
  const unmute = await tool().execute(ctx, { target: '42', minutes: 0 });
  assert.ok(!unmute.isError, unmute.content);
  assert.equal(calls[1][3], 0);
  const again = await tool().execute(ctx, { target: '42', minutes: 0 });
  assert.equal(again.isError, true);
  assert.equal(calls.length, 2);
});

it('别人下的禁言不能解；人类加罚后也不能解', async () => {
  const { ctx } = context();
  const noRecord = await tool().execute(ctx, { target: '42', minutes: 0 });
  assert.equal(noRecord.isError, true);
  assert.match(noRecord.content, /只能解除你自己/);

  setup();
  const next = context();
  assert.ok(!(await tool().execute(next.ctx, { target: '42', minutes: 5 })).isError);
  shutUntil = Math.floor(Date.now() / 1000) + 600;
  const penalized = await tool().execute(next.ctx, { target: '42', minutes: 0 });
  assert.equal(penalized.isError, true);
  assert.match(penalized.content, /加罚/);
});

it('结果未知按可能已生效记录，冷却阻止模型重复操作', async () => {
  const { ctx, calls } = context({ throwOnBan: new Error('socket hang up') });
  const result = await tool().execute(ctx, { target: '42', minutes: 5 });
  assert.equal(result.isError, true);
  assert.match(result.content, /别重复操作/);
  assert.equal(calls.length, 0);
  const again = await tool().execute(ctx, { target: '42', minutes: 5 });
  assert.equal(again.isError, true);
  assert.match(again.content, /刚处理过/);
});
