// #84：held 过期后的自动收尾。
// 关键语义：只有该 run 的 outbox 全部终结（或没有 outbox）才释放；
// 仍有 sending/unknown 的必须留给人工核对；缺 lease_id 的旧行按会话级 outbox 判断。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-held-release-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { ChatStore } = await import('../src/core/store.js');

function makeStore(name) {
  return new ChatStore(0, { dataDir: path.join(root, name), filename: 'messages.sqlite' });
}

function appendAndLease(store, chatKey, mid = 1) {
  store.appendIncoming(chatKey, {
    mid, ts: Date.now(), senderId: '42', senderName: '群友', text: `msg-${mid}`, media: []
  });
  return store.claimUnread(chatKey);
}

function holdLease(store, lease) {
  store.failLease(lease.id, 'Delivery uncertain; batch held');
  return store.db.prepare("SELECT state FROM runs WHERE id=?").get(lease.id).state;
}

test('outbox 已终结（sent/failed）→ 自动释放 held 并解除会话阻塞', (t) => {
  const store = makeStore('terminal');
  t.after(() => store.close());
  for (const [idx, finish] of [
    (op) => store.finishSend(op, { messageId: 'm-sent' }),
    (op) => store.finishSend(op, { error: 'definitive failure', outcome: 'failed' })
  ].entries()) {
    const chatKey = `group:${idx + 1}`;
    const lease = appendAndLease(store, chatKey, idx + 1);
    const op = store.beginSend(chatKey, lease.id, { text: 'reply' });
    assert.equal(holdLease(store, lease), 'held');
    finish(op);
    assert.equal(store.getChatMeta(chatKey).held, 1, '释放前 held 应挡住会话');

    const result = store.autoReleaseResolvedHeld();
    const released = result.released.find((row) => row.chatKey === chatKey);
    assert.ok(released, JSON.stringify(result));
    assert.equal(released.messages, 1);
    assert.equal(released.reason, 'outbox-terminal');
    assert.equal(store.getChatMeta(chatKey).held, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_key=? AND state='held'").get(chatKey).n, 0);
    assert.equal(store.db.prepare("SELECT state FROM runs WHERE id=?").get(lease.id).state, 'acked');
    const runError = String(store.db.prepare('SELECT error FROM runs WHERE id=?').get(lease.id).error || '');
    assert.match(runError, /Delivery uncertain/, '原 failLease 错误不能被覆盖');
    assert.match(runError, /自动释放/, '自动释放原因要追加在日志/台账里');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE run_id=?').get(lease.id).n, 0);
  }
});

test('outbox 仍有 unknown/sending → 保留，等人工核对', (t) => {
  const store = makeStore('uncertain');
  t.after(() => store.close());

  const unknownLease = appendAndLease(store, 'group:1', 1);
  const unknownOp = store.beginSend('group:1', unknownLease.id, { text: 'reply' });
  holdLease(store, unknownLease);
  store.finishSend(unknownOp, { error: 'timeout' });

  const sendingLease = appendAndLease(store, 'group:2', 2);
  store.beginSend('group:2', sendingLease.id, { text: 'reply' });
  holdLease(store, sendingLease);

  const result = store.autoReleaseResolvedHeld();
  assert.deepEqual(result.released, []);
  assert.equal(result.kept.length, 2);
  assert.ok(result.kept.every((row) => row.reason === 'outbox-unresolved'));
  assert.equal(store.getChatMeta('group:1').held, 1);
  assert.equal(store.getChatMeta('group:2').held, 1);
});

test('没有 outbox 的 held 可释放；缺 lease_id 时按会话级 outbox 判断', (t) => {
  const store = makeStore('orphan');
  t.after(() => store.close());
  const now = Date.now();
  store.appendIncoming('group:1', { mid: 1, ts: now, senderId: '42', senderName: 'A', text: 'a', media: [] });
  store.appendIncoming('group:2', { mid: 2, ts: now, senderId: '42', senderName: 'A', text: 'b', media: [] });
  store.appendIncoming('group:3', { mid: 3, ts: now, senderId: '42', senderName: 'A', text: 'c', media: [] });
  store.db.prepare("UPDATE messages SET state='held', lease_id='run-no-outbox' WHERE chat_key='group:1'").run();
  store.db.prepare("UPDATE messages SET state='held', lease_id=NULL WHERE chat_key='group:2'").run();
  store.db.prepare("UPDATE messages SET state='held', lease_id=NULL WHERE chat_key='group:3'").run();
  store.db.prepare("INSERT INTO runs(id,chat_key,state,expires_at) VALUES('run-no-outbox','group:1','held',?)").run(now);
  // group:3 还有一条真正未知的外发：缺 lease 的旧 held 不能盲目放行
  const op = store.beginSend('group:3', 'legacy-unknown', { text: 'notice' });
  store.finishSend(op, { error: 'timeout' });

  const result = store.autoReleaseResolvedHeld();
  const byChat = new Map(result.released.map((row) => [row.chatKey, row]));
  assert.equal(byChat.get('group:1').reason, 'no-outbox');
  assert.equal(byChat.get('group:2').reason, 'missing-lease-no-outbox');
  assert.equal(store.getChatMeta('group:1').held, 0);
  assert.equal(store.getChatMeta('group:2').held, 0);
  assert.equal(store.getChatMeta('group:3').held, 1);
  assert.deepEqual(result.kept.map((row) => row.reason), ['missing-lease-unresolved']);
});

test('只释放目标 run：同会话另一批 unknown outbox 仍会继续挡住会话', (t) => {
  const store = makeStore('scoped');
  t.after(() => store.close());
  const lease = appendAndLease(store, 'group:1', 1);
  const op = store.beginSend('group:1', lease.id, { text: 'reply' });
  holdLease(store, lease);
  store.finishSend(op, { messageId: 'm-sent' });
  // 另一个主动唤醒留下的 unknown 残骸（没有 messages.held 行，但 getChatMeta 会算它）
  store.beginSend('group:1', 'proactive-run', { text: 'notice' });
  store.finishSend(store.db.prepare('SELECT id FROM outbox WHERE run_id=?').get('proactive-run').id, { error: 'timeout' });

  const result = store.autoReleaseResolvedHeld();
  assert.equal(result.released.length, 1);
  assert.equal(result.released[0].messages, 1);
  // held 消息已放行，但 unknown 外发还挂着：会话仍应显示待核对。
  assert.equal(store.getChatMeta('group:1').held, 1);
});

test('同一会话两个 held run：只释放 outbox 已终结的那个', (t) => {
  const store = makeStore('two-held');
  t.after(() => store.close());
  const first = appendAndLease(store, 'group:1', 1);
  const firstOp = store.beginSend('group:1', first.id, { text: 'one' });
  holdLease(store, first);
  store.finishSend(firstOp, { messageId: 'm1' });

  const second = appendAndLease(store, 'group:1', 2);
  store.beginSend('group:1', second.id, { text: 'two' });
  holdLease(store, second);

  const result = store.autoReleaseResolvedHeld();
  assert.equal(result.released.length, 1);
  assert.equal(result.released[0].runId, first.id);
  assert.equal(store.getMessage('group:1', first.messages[0].id).state, 'acked');
  assert.equal(store.getMessage('group:1', second.messages[0].id).state, 'held');
  assert.equal(store.getChatMeta('group:1').held, 1);
});

test('reconciled_sent/reconciled_failed 也算已终结', (t) => {
  const store = makeStore('reconciled');
  t.after(() => store.close());
  for (const [idx, state] of ['reconciled_sent', 'reconciled_failed'].entries()) {
    const chatKey = `group:${idx + 1}`;
    const lease = appendAndLease(store, chatKey, idx + 1);
    const op = store.beginSend(chatKey, lease.id, { text: 'reply' });
    holdLease(store, lease);
    store.finishSend(op, { error: 'timeout' });
    // reconcileUnknownOperation 自己会顺手释放 held；这里直接造"已核对但还没清行"的状态，
    // 验证自动释放也认这两个终态（Issue #84 明确点名）。
    store.db.prepare('UPDATE outbox SET state=? WHERE id=?').run(state, op);
    const result = store.autoReleaseResolvedHeld();
    assert.equal(result.released.length, 1, chatKey);
    assert.equal(result.released[0].reason, 'outbox-terminal', chatKey);
    assert.equal(store.getChatMeta(chatKey).held, 0, chatKey);
  }
});

test('回收循环的启动和 5 秒 tick 都接入了自动释放', () => {
  const source = fs.readFileSync(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8');
  const start = source.indexOf('startRecoveryLoop()');
  const end = source.indexOf('// ── 入站接口', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.ok((block.match(/this\.releaseResolvedHeld\(\)/g) || []).length >= 2,
    '启动和周期 tick 都必须调用 releaseResolvedHeld');
  assert.ok((block.match(/this\.releaseStaleDeferred\(\)/g) || []).length >= 2,
    '启动和周期 tick 都必须调用 releaseStaleDeferred');
});

test('启动时把遗留 sending 收口成 unknown（不能永远停在发送中）', (t) => {
  const store = makeStore('stale-sending');
  t.after(() => store.close());
  const lease = appendAndLease(store, 'group:1', 1);
  const op = store.beginSend('group:1', lease.id, { text: 'reply' });
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(op).state, 'sending');
  assert.equal(store.markStaleSendingUnknown(), 1);
  const row = store.db.prepare('SELECT state,error FROM outbox WHERE id=?').get(op);
  assert.equal(row.state, 'unknown');
  assert.match(String(row.error), /进程重启/);
});

test('没有 held 时是空操作，不会误删 active 租约的 outbox', (t) => {
  const store = makeStore('active');
  t.after(() => store.close());
  const lease = appendAndLease(store, 'group:1', 1);
  const op = store.beginSend('group:1', lease.id, { text: 'reply' });
  const result = store.autoReleaseResolvedHeld();
  assert.deepEqual(result, { released: [], kept: [] });
  assert.equal(store.db.prepare('SELECT state FROM messages WHERE chat_key=?').get('group:1').state, 'leased');
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(op).state, 'sending');
});
