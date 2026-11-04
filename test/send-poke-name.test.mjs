// send_poke 按名字反查 QQ：模型常把聊天里看到的群名片/备注当 targetUserId 传（3 天失败 7 次），
// 光靠工具说明拦不住。原则是「宁可报错也不猜人」：只认唯一命中，单字前缀不猜，0 永远走数字路径。
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
const { setMemberNote } = await import('../src/memory/memory-global.js');

const poke = buildToolDefs().find((d) => d.name === 'send_poke');

function setup(t) {
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  const rows = [
    ['101', '阿沫'],
    ['102', '阿扁羽'],
    ['103', '该群已被封禁，详情请前往安全中心查看...'],
    ['104', '该群近期被多次举报涉嫌违规内容，'],
    ['105', 'Neko'],
    ['106', '🦌了'],
    ['107', '小维'],
    ['108', '0鸣（🦌了）'],
    ['109', '重名'],
    ['110', '重名']
  ];
  rows.forEach(([senderId, senderName], i) => {
    store.appendIncoming('group:1', { mid: i + 1, senderId, senderName, text: 'hi', ts: 1000 + i });
  });
  setMemberNote('105', '饲养员');
  t.after(() => setMemberNote('105', ''));
  const sends = [];
  const ctx = {
    kind: 'group', chatId: '1', chatKey: 'group:1', store,
    session: { id: 's', leaseId: 'lease' },
    sender: { poke: async (...args) => { sends.push(args); return {}; } }
  };
  return { ctx, sends, run: (targetUserId) => poke.execute(ctx, { targetUserId }) };
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

test('send_poke：单字前缀与单个 emoji 前缀不猜', async (t) => {
  const { run, sends } = setup(t);
  for (const name of ['小', '🦌']) {
    const result = await run(name);
    assert.equal(result.isError, true, name);
    assert.match(result.content, /没有唯一对上的成员/);
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
  for (const value of [0, '0']) {
    const result = await run(value);
    assert.equal(result.isError, true);
    assert.match(result.content, /不是当前群中已出现的成员 QQ 号/);
  }
  assert.equal(sends.length, 0);
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
