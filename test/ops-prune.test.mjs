// ops prune 的删除边界（2026-10-31 全量审查 P1 回归）：
// messages 的主键是 (chat_key, id)，id 只在会话内自增。旧实现只按 id 删，
// 会把其它会话里同号的 pending/held 一起删掉 —— 这条用例钉住"只删候选 rowid"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { ChatStore } from '../src/core/store.js';

test('ops prune 只删 acked 超期行：不跨会话误删 pending/held，并重算 message_count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ops-prune-'));
  try {
    const now = Date.now();
    const old = now - 3 * 86400000;
    const fresh = now - 1000;
    const store = new ChatStore(0, { dataDir: dir });
    const insertChat = store.db.prepare('INSERT OR IGNORE INTO chats(chat_key,next_id,message_count) VALUES (?,?,?)');
    insertChat.run('group:111', 10, 3);
    insertChat.run('group:222', 10, 2);
    const insert = store.db.prepare(`INSERT INTO messages
      (chat_key,id,mid,ts,sender_id,sender_name,text,self,state)
      VALUES (?,?,?,?,?,?,?,0,?)`);
    // 同号冲突是本用例的核心：两个会话都有 id=1，只有 group:111 的旧 acked 该删。
    insert.run('group:111', 1, 'a1', old, '1', 'A', '旧已确认', 'acked');
    insert.run('group:111', 2, 'a2', old, '1', 'A', '旧已确认 2', 'acked');
    insert.run('group:111', 3, 'a3', fresh, '1', 'A', '新已确认', 'acked');
    insert.run('group:222', 1, 'b1', old, '2', 'B', '旧待处理', 'pending');
    insert.run('group:222', 2, 'b2', old, '2', 'B', '旧待核对', 'held');
    store.close();

    const run = spawnSync(process.execPath, [
      path.join(process.cwd(), 'src', 'ops.js'),
      'prune', '--days=1', '--confirm', `--data=${dir}`
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /已删除 2 条/);

    const again = new ChatStore(0, { dataDir: dir });
    try {
      const rows = again.db.prepare('SELECT chat_key, id, state FROM messages ORDER BY chat_key, id').all();
      assert.deepEqual(rows.map((r) => `${r.chat_key}/${r.id}/${r.state}`), [
        'group:111/3/acked',
        'group:222/1/pending',
        'group:222/2/held'
      ], '只允许删 group:111 的两条旧 acked');
      const counts = Object.fromEntries(again.db.prepare('SELECT chat_key, message_count FROM chats').all()
        .map((r) => [r.chat_key, r.message_count]));
      assert.equal(counts['group:111'], 1, 'message_count 要按剩余行重算');
      assert.equal(counts['group:222'], 2);
    } finally {
      again.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
