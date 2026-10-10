// 新工具的行为测试（2026-09-28）：dice 随机、get_group_member_list、remind。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tools-play-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { buildToolDefs } = await import('../src/tools/tools-core.js');
const { ReminderStore } = await import('../src/core/reminders.js');

const defs = buildToolDefs();
const tool = (name) => {
  const t = defs.find((d) => d.name === name);
  assert.ok(t, `工具 ${name} 应存在`);
  return t;
};
const parse = (r) => JSON.parse(r.content);

test('dice：骰子/区间/硬币/抽人都在范围内，非法输入报错', async () => {
  for (let i = 0; i < 50; i += 1) {
    const r = parse(await tool('dice').execute({}, { kind: 'dice', sides: 6, count: 2 }));
    assert.equal(r.rolls.length, 2);
    assert.ok(r.rolls.every((v) => v >= 1 && v <= 6));
    assert.equal(r.total, r.rolls[0] + r.rolls[1]);
  }
  const n = parse(await tool('dice').execute({}, { kind: 'number', min: 10, max: 12 }));
  assert.ok([10, 11, 12].includes(n.result));
  const coin = parse(await tool('dice').execute({}, { kind: 'coin' }));
  assert.ok(['正面', '反面'].includes(coin.result));
  const pick = parse(await tool('dice').execute({}, { kind: 'pick', items: ['甲', '乙', '丙'] }));
  assert.ok(['甲', '乙', '丙'].includes(pick.picked));
  assert.equal(pick.candidates, 3);
  // 非法
  assert.equal((await tool('dice').execute({}, { kind: 'pick', items: ['only'] })).isError, true);
  assert.equal((await tool('dice').execute({}, { kind: 'number', min: 5, max: 5 })).isError, true);
});

test('get_group_member_list：过滤脏数据、按角色排序、私聊拒绝', async () => {
  const members = [
    { user_id: 2002, nickname: '乙', role: 'member' },
    { user_id: 1001, nickname: '甲', card: '群主甲', role: 'owner' },
    { user_id: 'bad', nickname: '脏数据' },
    { user_id: 3003, nickname: '丙', role: 'admin' }
  ];
  const ctx = {
    kind: 'group', chatId: '123',
    onebot: { getGroupMemberList: async () => members }
  };
  const r = parse(await tool('get_group_member_list').execute(ctx, { limit: 2 }));
  assert.equal(r.total, 3);                    // 脏数据被过滤
  assert.equal(r.returned, 2);
  assert.equal(r.members[0].userId, '1001');   // owner 排最前
  assert.equal(r.members[0].name, '群主甲');    // 群名片优先
  assert.equal(r.members[1].role, 'admin');

  // 协议端不支持 → 友好报错，不抛
  const bad = await tool('get_group_member_list').execute({ kind: 'group', chatId: '1', onebot: { getGroupMemberList: async () => { throw new Error('unsupported action'); } } }, {});
  assert.equal(bad.isError, true);
  assert.match(bad.content, /获取成员名单失败/);
  // 私聊拒绝
  const priv = await tool('get_group_member_list').execute({ kind: 'private', chatId: '1', onebot: {} }, {});
  assert.equal(priv.isError, true);
});

test('remind：新增（HH:MM / 分钟）、列表、取消；无 store 时优雅报错', async () => {
  const store = new ReminderStore(path.join(dataDir, 'reminders-tool.json'));
  const ctx = { chatKey: 'group:42', kind: 'group', chatId: '42', selfNickname: '小鲸鱼', reminders: store };

  const add = parse(await tool('remind').execute(ctx, { action: 'add', at: '23:59', text: '提醒大家早睡' }));
  assert.equal(add.created, true);
  assert.ok(add.id);
  const add2 = parse(await tool('remind').execute(ctx, { action: 'add', minutes: 30, text: '半小时后收衣服' }));
  assert.ok(add2.id);

  const list = parse(await tool('remind').execute(ctx, { action: 'list' }));
  assert.equal(list.pending, 2);
  assert.ok(list.reminders.every((x) => x.id && x.at && x.text));

  const cancel = parse(await tool('remind').execute(ctx, { action: 'cancel', id: add.id }));
  assert.equal(cancel.canceled, true);
  const after = parse(await tool('remind').execute(ctx, { action: 'list' }));
  assert.equal(after.pending, 1);

  // 非法输入
  assert.equal((await tool('remind').execute(ctx, { action: 'add', at: '99:99', text: 'x' })).isError, true);
  assert.equal((await tool('remind').execute(ctx, { action: 'add', minutes: 0, text: 'x' })).isError, true);
  assert.equal((await tool('remind').execute(ctx, { action: 'add', minutes: 5, text: '' })).isError, true);
  assert.equal((await tool('remind').execute(ctx, { action: 'cancel', id: 'nope' })).isError, true);
  // 无提醒能力的环境
  assert.equal((await tool('remind').execute({ chatKey: 'group:1', kind: 'group' }, { action: 'list' })).isError, true);
});

test('remind 归属（2026-10-10 复核版）：from 必须对上本轮消息里的人；对不上/不填都不记', async () => {
  const store = new ReminderStore(path.join(dataDir, 'reminders-attribution-tool.json'));
  const base = { chatKey: 'group:43', kind: 'group', chatId: '43', reminders: store };
  const batch = [{ senderId: '7', senderName: '彭于晏' }, { senderId: 'self', senderName: '小鲸鱼', self: true }];
  // 1) from 对上本轮发送者（群名片）→ 记录；to 一并落盘
  const explicit = parse(await tool('remind').execute(
    { ...base, triggerEntries: batch },
    { action: 'add', at: '23:59', text: '去吃饭', to: '吴彦祖', from: '彭于晏' }
  ));
  const it1 = store.list('group:43').find((x) => x.id === explicit.id);
  assert.equal(it1.createdBy, '彭于晏');
  assert.equal(it1.targetName, '吴彦祖');
  // 2) from 用 QQ 号也对得上
  const byId = parse(await tool('remind').execute({ ...base, triggerEntries: batch },
    { action: 'add', minutes: 30, text: '喝水', from: '7' }));
  assert.equal(store.list('group:43').find((x) => x.id === byId.id).createdBy, '7');
  // 3) from 对不上（借管理员之名 / 猜的人）→ 不记（派发话术回落"有人"，不把错的人当事实）
  const fake = parse(await tool('remind').execute({ ...base, triggerEntries: batch },
    { action: 'add', minutes: 31, text: '吃药', from: '管理员' }));
  assert.equal(store.list('group:43').find((x) => x.id === fake.id).createdBy, '');
  // 4) 不填 from → 不猜（已移除"唯一发送者兜底"：提醒可能上一轮的人提的、这一轮是别人在说话）
  const none = parse(await tool('remind').execute({ ...base, triggerEntries: batch },
    { action: 'add', minutes: 32, text: '睡觉' }));
  assert.equal(store.list('group:43').find((x) => x.id === none.id).createdBy, '');
  // 5) list 回带归属（模型自查"是谁请的"）
  const list = parse(await tool('remind').execute(base, { action: 'list' }));
  const row = list.reminders.find((x) => x.id === explicit.id);
  assert.equal(row.to, '吴彦祖');
  assert.equal(row.from, '彭于晏');
});
