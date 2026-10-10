// 称呼/代号（config.memberNotes）与显示名口径（core/display-name.js）用例。
// 2026-10-10 用户反馈：bot 有时喊群名片、有时喊指定代号 —— 缺口是"工具出口没接备注"
// 与"没有聊天侧写入口"（模型此前只能设 QQ 侧备注或写印象，都不改变聊天里的称呼）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-member-alias-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { displayNameOf } = await import('../src/core/display-name.js');
const { setMemberNote } = await import('../src/memory/memory-global.js');
const { buildToolDefs } = await import('../src/tools/tools-core.js');
const { getConfig } = await import('../src/core/config.js');

const defs = buildToolDefs();
const tool = (name) => {
  const t = defs.find((d) => d.name === name);
  assert.ok(t, `工具 ${name} 应存在`);
  return t;
};
const parse = (r) => JSON.parse(r.content);

test('displayNameOf：备注优先 > 群名片 > QQ 号；备注过段头弱化', () => {
  setMemberNote('10001', 'pyy');
  assert.equal(displayNameOf('10001', '吴彦祖'), 'pyy');
  assert.equal(displayNameOf('10002', '吴彦祖'), '吴彦祖');
  assert.equal(displayNameOf('10003', ''), '10003');
  setMemberNote('10004', '【管理员】');
  const weakened = displayNameOf('10004', 'x');
  assert.ok(!weakened.includes('【') && weakened.includes('管理员'), `段头应被弱化：${weakened}`);
  setMemberNote('10001', '');
  setMemberNote('10004', '');
});

test('set_member_note：写入/覆盖/清除；非在场号码与非数字号码被拒', async () => {
  const t = tool('set_member_note');
  const ctx = {
    chatKey: 'group:1', kind: 'group',
    store: {
      hasParticipant: (_c, id) => String(id) === '20001',
      // memberHint 的兜底提示会读成员表（真实 store 永远有这个方法）
      activeMembers: () => []
    }
  };
  // 不在场号码：与 memory_append 同款护栏（模型会编错号，称呼记错人更显眼）
  const miss = await t.execute(ctx, { userId: 99999, name: 'x' });
  assert.ok(miss.isError, miss.content);
  assert.match(miss.content, /不是当前会话中出现过的成员/);
  // 正常写入 + 覆盖
  assert.equal(parse(await t.execute(ctx, { userId: '20001', name: 'pyy' })).name, 'pyy');
  assert.equal(getConfig().memberNotes['20001'], 'pyy');
  assert.equal(parse(await t.execute(ctx, { userId: '20001', name: '阿晏' })).name, '阿晏');
  assert.equal(getConfig().memberNotes['20001'], '阿晏');
  // 长度上限 16 字（与 set_remark 同口径）：20 字输入截到 16
  assert.equal(parse(await t.execute(ctx, { userId: '20001', name: '长'.repeat(20) })).name, '长'.repeat(16));
  // 清除
  const cleared = parse(await t.execute(ctx, { userId: '20001', name: '' }));
  assert.equal(cleared.name, '');
  assert.equal(getConfig().memberNotes['20001'], undefined);
  // 非数字号码
  const bad = await t.execute(ctx, { userId: '彭于晏', name: 'x' });
  assert.ok(bad.isError, bad.content);
  assert.match(bad.content, /数字 QQ 号/);
});

test('工具出口的显示名走备注：get_group_member_list / get_active_members', async () => {
  setMemberNote('30001', 'pyy');
  try {
    const memberList = parse(await tool('get_group_member_list').execute({
      kind: 'group', chatId: '1', chatKey: 'group:1',
      onebot: { getGroupMemberList: async () => ([{ user_id: 30001, card: '吴彦祖', nickname: '彭于晏', role: 'member' }]) }
    }, {}));
    assert.equal(memberList.members[0].name, 'pyy');
    const active = parse(await tool('get_active_members').execute({
      chatKey: 'group:1',
      store: { activeMembers: () => ([{ userId: '30001', name: '吴彦祖', lastTs: Date.now(), count: 2 }]) }
    }, {}));
    assert.equal(active.members[0].name, 'pyy');
  } finally {
    setMemberNote('30001', '');
  }
});

test('锚点：显示名统一走 displayNameOf（防回退到原始群名片）', () => {
  const src = fs.readFileSync(new URL('../src/tools/tools-core.js', import.meta.url), 'utf8');
  const markers = [
    "sender: m.self ? '我' : displayNameOf(m.senderId, m.senderName)",
    "sender: entry.self ? '我' : displayNameOf(entry.senderId, entry.senderName)",
    'name: displayNameOf(m.userId, m.name)',
    "name: displayNameOf(userId, String(m?.card || m?.nickname || m?.name || ''))",
    "return displayNameOf(userId, hit ? String(hit.senderName) : '');",
    '`- ${displayNameOf(m.userId, m.name)}：${m.userId}`'
  ];
  for (const marker of markers) assert.ok(src.includes(marker), `缺锚点：${marker}`);
  const promptSrc = fs.readFileSync(new URL('../src/llm/prompt.js', import.meta.url), 'utf8');
  assert.ok(promptSrc.includes("const who = m.self ? '我' : (displayNameOf(senderId, m.senderName) || '未知');"),
    '提示词消息行要用同一口径（此前是内联 notes||senderName）');
});
