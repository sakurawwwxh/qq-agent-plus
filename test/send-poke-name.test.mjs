// send_poke 按名字反查 QQ：模型常把聊天里看到的群名片/备注当 targetUserId 传（3 天失败 7 次），
// 光靠工具说明拦不住。原则是「宁可报错也不猜人」：只认唯一命中，单字前缀不猜，0 永远走数字路径。
// 另外群名片会改名：历史名字撞到别人时必须报歧义，不能拍最新同名的另一个人。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rmDirBestEffort } from './helpers/cleanup.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-poke-name-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => rmDirBestEffort(dir));

const { ChatStore } = await import('../src/core/store.js');
const { buildToolDefs } = await import('../src/tools/tools-core.js');
const { resolvePokeTarget } = await import('../src/tools/poke-target.js');
const { setMemberNote } = await import('../src/memory/memory-global.js');

const poke = buildToolDefs().find((d) => d.name === 'send_poke');
let nextMid = 0;

function setup(t, { chatKey = 'group:1', kind = 'group', chatId = '1', rows = null } = {}) {
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  const memberRows = rows || [
    ['101', '阿沫'],
    ['102', '阿扁羽'],
    ['103', '该群已被封禁，详情请前往安全中心查看...'],
    ['104', '该群近期被多次举报涉嫌违规内容，'],
    ['105', 'Neko'],
    ['106', '🦌了'],
    ['107', '小维'],
    ['108', '0鸣（🦌了）'],
    ['109', '重名'],
    ['110', '重名'],
    ['1011', '1011号']
  ];
  memberRows.forEach(([senderId, senderName], i) => {
    store.appendIncoming(chatKey, {
      mid: ++nextMid, senderId, senderName, text: 'hi', ts: 1000 + i
    });
  });
  setMemberNote('105', '饲养员');
  t.after(() => setMemberNote('105', ''));
  const sends = [];
  const ctx = {
    kind, chatId, chatKey, store,
    session: { id: 's', leaseId: 'lease' },
    sender: { poke: async (...args) => { sends.push(args); return {}; } }
  };
  return { ctx, store, sends, run: (targetUserId) => poke.execute(ctx, { targetUserId }) };
}

test('send_poke：群名片精确命中就拍对应 QQ', async (t) => {
  const { run, sends } = setup(t);
  for (const [name, id] of [['阿沫', 101], ['阿扁羽', 102], ['@阿沫', 101]]) {
    const result = await run(name);
    assert.equal(result.isError, undefined, result.content);
    assert.equal(sends.at(-1)[1], id, name);
  }
});

test('send_poke：只对上控制台备注也能拍（群名片 Neko / 备注 饲养员）', async (t) => {
  const { run, sends } = setup(t);
  const result = await run('饲养员');
  assert.equal(result.isError, undefined, result.content);
  assert.equal(sends[0][1], 105);
});

test('send_poke：截断的名字按前缀唯一命中', async (t) => {
  const { run, sends } = setup(t);
  const result = await run('该群已被封禁');
  assert.equal(result.isError, undefined, result.content);
  assert.equal(sends[0][1], 103);
});

test('send_poke：单字前缀、单个 emoji、以及 @ 后带空格都不猜', async (t) => {
  const { run, sends } = setup(t);
  // "@ 0" 是绕过单字门槛的经典输入：strip @ 后残留空格会被算成第二个字。
  for (const name of ['小', '🦌', '@ 小', '@ 🦌', '@ 0', '@']) {
    const result = await run(name);
    assert.equal(result.isError, true, name);
    if (name === '@ 0') assert.match(result.content, /不是当前群中已出现的成员 QQ 号/, name);
    else assert.match(result.content, /没有唯一对上的成员/, name);
  }
  assert.equal(sends.length, 0);
});

test('send_poke：前缀命中多人报错，不猜', async (t) => {
  const { run, sends } = setup(t);
  const result = await run('该群');
  assert.equal(result.isError, true);
  assert.match(result.content, /103/);
  assert.match(result.content, /104/);
  assert.equal(sends.length, 0);
});

test('send_poke：0 走数字路径，绝不匹配到「0鸣…」', async (t) => {
  const { run, sends } = setup(t);
  for (const value of [0, '0', '000']) {
    const result = await run(value);
    assert.equal(result.isError, true);
    assert.match(result.content, /不是当前群中已出现的成员 QQ 号/);
  }
  assert.equal(sends.length, 0);
});

test('send_poke：纯数字但位数不合法时直接拒绝，不拿去做名字匹配', async (t) => {
  const { run, sends } = setup(t);
  const result = await run('1234567890123456');
  assert.equal(result.isError, true);
  assert.match(result.content, /1-15 位数字 QQ 号/);
  assert.equal(sends.length, 0);
});

test('send_poke：@QQ、前导零 QQ 先归一化，不能掉进名字前缀', async (t) => {
  const { run, sends } = setup(t);
  // 1011号 存在时，旧实现会把 "@101" 当成名字前缀拍给 1011。
  for (const target of ['101', '00101', '@101', ' @101 ']) {
    const result = await run(target);
    assert.equal(result.isError, undefined, `${target}: ${result.content}`);
    assert.equal(sends.at(-1)[1], 101, target);
  }
});

test('send_poke：重名报错并列出全部候选 QQ', async (t) => {
  const { run, sends } = setup(t);
  const result = await run('重名');
  assert.equal(result.isError, true);
  assert.match(result.content, /请用 QQ 号指定/);
  assert.match(result.content, /109/);
  assert.match(result.content, /110/);
  assert.equal(sends.length, 0);
});

test('send_poke：改名后旧名字与别人重名 → 报歧义，不拍最新同名的人', async (t) => {
  const { run, sends } = setup(t, {
    chatKey: 'group:history',
    rows: [
      ['1001', '小明'],
      ['1002', '小明'],
      ['1003', '路人'],
      ['1001', '老A']
    ]
  });
  const result = await run('小明');
  assert.equal(result.isError, true);
  assert.match(result.content, /1001/);
  assert.match(result.content, /1002/);
  assert.match(result.content, /请用 QQ 号指定/);
  assert.equal(sends.length, 0);
});

test('send_poke：历史名字唯一时仍能拍到本人', async (t) => {
  const { run, sends } = setup(t, {
    chatKey: 'group:history-unique',
    rows: [['1001', '旧名字'], ['1002', '别人'], ['1001', '老A']]
  });
  const result = await run('旧名字');
  assert.equal(result.isError, undefined, result.content);
  assert.equal(sends[0][1], 1001);
});

test('send_poke：历史精确命中不能压过另一个人的当前前缀', async (t) => {
  const { run, sends } = setup(t, {
    chatKey: 'group:history-prefix',
    rows: [
      ['1001', '小明'],
      ['1002', '小明（上班）'],
      ['1001', '老A']
    ]
  });
  // 模型看到的是 1002 的当前群名片“小明（上班）”，截断成“小明”；
  // 不能因为 1001 的历史名字恰好也是“小明”就拍 1001。
  const result = await run('小明');
  assert.equal(result.isError, true);
  assert.match(result.content, /1001/);
  assert.match(result.content, /1002/);
  assert.match(result.content, /请用 QQ 号指定/);
  assert.equal(sends.length, 0);
});

test('resolvePokeTarget：历史精确也不能压过别人当前备注的前缀', () => {
  setMemberNote('3002', '小明（朋友）');
  try {
    const rows = [
      { userId: '3001', name: '小明', lastTs: 1, count: 1 },
      { userId: '3002', name: 'B', lastTs: 2, count: 1 },
      { userId: '3001', name: '老A', lastTs: 3, count: 1 }
    ];
    const result = resolvePokeTarget({
      chatKey: 'group:note-prefix',
      store: { memberNameHistory: () => rows }
    }, '小明');
    assert.match(result.error, /3001/);
    assert.match(result.error, /3002/);
    assert.match(result.error, /请用 QQ 号指定/);
  } finally {
    setMemberNote('3002', '');
  }
});

test('send_poke：私聊不按名字反查，只认当前对端', async (t) => {
  const { run, sends } = setup(t, {
    chatKey: 'private:101', kind: 'private', chatId: '101',
    rows: [['101', '阿沫']]
  });
  const named = await run('阿沫');
  assert.equal(named.isError, true);
  assert.match(named.content, /私聊只能拍当前聊天对象/);
  const numeric = await run('101');
  assert.equal(numeric.isError, undefined, numeric.content);
  assert.equal(sends.at(-1)[1], 101);
  const omitted = await run(undefined);
  assert.equal(omitted.isError, undefined, omitted.content);
  assert.equal(sends.at(-1)[1], null);
});

test('send_poke：对不上时给「是不是想找」建议', async (t) => {
  const { run, sends } = setup(t);
  const result = await run('沫沫');
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content, /你是不是想找/);
  const near = await run('🦌');
  assert.match(near.content, /你是不是想找：.*106/);
  assert.equal(sends.length, 0);
});

test('send_poke：没发过言的数字 QQ 仍然被拒', async (t) => {
  const { run, sends } = setup(t);
  const result = await run('999999');
  assert.equal(result.isError, true);
  assert.match(result.content, /不是当前群中已出现的成员 QQ 号/);
  assert.equal(sends.length, 0);
});

test('send_poke：反查到非数字 sender_id 时拒绝，不发送 NaN', async (t) => {
  const { run, sends } = setup(t, {
    chatKey: 'group:nonnumeric',
    rows: [['u1', '机器人']]
  });
  const result = await run('机器人');
  assert.equal(result.isError, true);
  assert.match(result.content, /QQ 号不合法/);
  assert.equal(sends.length, 0);
});

test('memberNameHistory：保留改名前的群名片，按最近出现排序', (t) => {
  const { store } = setup(t, {
    chatKey: 'group:history-store',
    rows: [['1001', '旧名字'], ['1001', '老A'], ['1002', '别人']]
  });
  const names = store.memberNameHistory('group:history-store');
  assert.deepEqual(names.map((row) => `${row.userId}:${row.name}`), [
    '1002:别人', '1001:老A', '1001:旧名字'
  ]);
});

test('resolvePokeTarget：历史名字超过上限时 fail closed', () => {
  const rows = Array.from({ length: 20001 }, (_, i) => ({
    userId: String(100000 + i), name: `候选${i}`, lastTs: i, count: 1
  }));
  const result = resolvePokeTarget({
    chatKey: 'group:big',
    store: { memberNameHistory: () => rows }
  }, '候选1');
  assert.match(result.error, /历史群名片过多/);
});

test('resolvePokeTarget：store 不支持历史名字时 fail closed', () => {
  const result = resolvePokeTarget({ chatKey: 'group:x', store: {} }, '阿沫');
  assert.match(result.error, /无法校验历史群名片/);
});

test('resolvePokeTarget：歧义候选最多列 10 个，避免灌满上下文', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    userId: String(200000 + i), name: '同名', lastTs: i, count: 1
  }));
  const result = resolvePokeTarget({
    chatKey: 'group:many',
    store: { memberNameHistory: () => rows }
  }, '同名');
  assert.match(result.error, /等 12 人/);
  assert.match(result.error, /200009/);
  assert.doesNotMatch(result.error, /200010/);
});
