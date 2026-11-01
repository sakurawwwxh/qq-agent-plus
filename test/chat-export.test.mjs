// 全量导出必须覆盖 >5000 条的会话（2026-10-31 盲审 P1）：
// store.recent 的 afterId=0 是"最新 N 条"分支，旧实现会让旧消息静默丢失。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('会话导出从最老一条开始，>5000 条也不丢', async (t) => {
  const { base, token, app } = await bootConsole(t);
  const store = app.store;
  const total = 5001;
  store.db.prepare('INSERT OR IGNORE INTO chats(chat_key,next_id,message_count) VALUES (?,?,?)')
    .run('group:1', total + 1, total);
  const insert = store.db.prepare(`INSERT INTO messages
    (chat_key,id,mid,ts,sender_id,sender_name,text,self,state)
    VALUES (?,?,?,?,?,?,?,0,'acked')`);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 1; i <= total; i += 1) {
      insert.run('group:1', i, `m${i}`, 1700000000000 + i, '42', 'm42', `第 ${i} 条`);
    }
    store.db.exec('COMMIT');
  } catch (error) {
    try { store.db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw error;
  }

  const res = await fetch(`${base}/api/chats/group_1/export?format=jsonl`, {
    headers: { 'x-console-token': token }
  });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split('\n');
  assert.equal(lines.length, total, `应导出全部 ${total} 条`);
  assert.equal(JSON.parse(lines[0]).mid, 'm1', '第一条必须是最老消息');
  assert.equal(JSON.parse(lines[lines.length - 1]).mid, `m${total}`, '最后一条必须是最新消息');
});

