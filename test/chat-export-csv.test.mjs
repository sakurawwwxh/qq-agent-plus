// CSV 导出的公式注入防护（2026-10-31 盲审 P2）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('CSV 导出对公式前缀加单引号（防 Excel 公式注入）', async (t) => {
  const { base, token, app } = await bootConsole(t);
  const store = app.store;
  store.db.prepare('INSERT OR IGNORE INTO chats(chat_key,next_id,message_count) VALUES (?,?,?)')
    .run('group:2', 3, 1);
  store.db.prepare(`INSERT INTO messages
    (chat_key,id,mid,ts,sender_id,sender_name,text,self,state)
    VALUES (?,?,?,?,?,?,?,0,'acked')`).run('group:2', 1, 'csv1', Date.now(), '42', '=cmd', '=HYPERLINK("http://x","y")');

  const res = await fetch(`${base}/api/chats/group_2/export?format=csv`, {
    headers: { 'x-console-token': token }
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"'=cmd"/, '昵称的 = 前缀要加单引号');
  assert.match(text, /"'=HYPERLINK/, '正文的 = 前缀要加单引号');
});
