// 出站副作用账本（src/core/effects.js）：
//   幂等键唯一、状态迁移、unknown 终态、启动清扫、保留期、统计。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-effect-ledger-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { ChatStore } = await import('../src/core/store.js');
const { EffectLedger } = await import('../src/core/effects.js');

const freshStore = () => new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(dataDir, 'db-')) });

test('begin → settle：同一幂等键只允许一次，成功后返回 done', () => {
  const store = freshStore();
  try {
    const ledger = new EffectLedger(store.db);
    const first = ledger.begin({ kind: 'digest', chatKey: 'group:1', idemKey: 'digest:1:2026-10-31', detail: { day: '2026-10-31' } });
    assert.equal(first.action, 'proceed');
    assert.equal(first.state, 'planned');
    assert.ok(first.id);

    const inflight = ledger.begin({ kind: 'digest', chatKey: 'group:1', idemKey: 'digest:1:2026-10-31' });
    assert.equal(inflight.action, 'in-flight', '同一动作并发时第二次只能等');
    assert.equal(inflight.id, first.id);

    assert.equal(ledger.settle(first.id, 'sent', { chars: 42 }), true);
    const done = ledger.begin({ kind: 'digest', chatKey: 'group:1', idemKey: 'digest:1:2026-10-31' });
    assert.equal(done.action, 'done');
    assert.equal(done.state, 'sent');
    const row = ledger.get('digest', 'digest:1:2026-10-31');
    assert.equal(row.detail.chars, 42, 'settle 的 detail 要并进去');
    assert.equal(row.detail.day, '2026-10-31', 'begin 的 detail 不能被冲掉');
  } finally { store.close(); }
});

test('failed 允许重试（沿用同一 id）；unknown 是终态，不能改写', () => {
  const store = freshStore();
  try {
    const ledger = new EffectLedger(store.db);
    const begun = ledger.begin({ kind: 'reminder', chatKey: 'group:1', idemKey: 'reminder:r1:1000' });
    ledger.settle(begun.id, 'failed', { reason: 'no-send' });

    const retry = ledger.begin({ kind: 'reminder', chatKey: 'group:1', idemKey: 'reminder:r1:1000' });
    assert.equal(retry.action, 'proceed', '确定没发出去的失败可以再试');
    assert.equal(retry.id, begun.id, '沿用同一个 id，便于追踪');
    assert.equal(retry.retried, true);

    ledger.settle(begun.id, 'unknown', { reason: 'timeout' });
    const review = ledger.begin({ kind: 'reminder', chatKey: 'group:1', idemKey: 'reminder:r1:1000' });
    assert.equal(review.action, 'review', '未知结果必须人工核对，不能自动重试');
    assert.equal(ledger.settle(begun.id, 'sent'), false, 'unknown 不允许被后续轮次改成 sent');
    assert.equal(ledger.get('reminder', 'reminder:r1:1000').state, 'unknown');
  } finally { store.close(); }
});

test('进程重启立即清扫 planned（不等 15 分钟 TTL）；同进程内仍返回 in-flight', () => {
  const store = freshStore();
  try {
    let now = 1_000_000;
    const first = new EffectLedger(store.db, { now: () => now });
    const begun = first.begin({ kind: 'game', chatKey: 'group:1', idemKey: 'game:1:g1' });
    assert.equal(begun.action, 'proceed');
    // 同一进程/同一账本内重复 begin：这才是真正的 in-flight（动作可能还在跑）
    assert.equal(first.begin({ kind: 'game', chatKey: 'group:1', idemKey: 'game:1:g1' }).action, 'in-flight');

    // 只过了 60 秒就"重启"：上一条命不可能还在执行，必须直接转 unknown，
    // 否则 15 分钟内的重启会把日报/游戏播报当成 in-flight 并永久跳过当天（2026-10-31 审查 P2）。
    now += 60_000;
    const second = new EffectLedger(store.db, { now: () => now });
    const afterRestart = second.get('game', 'game:1:g1');
    assert.equal(afterRestart.state, 'unknown');
    assert.equal(afterRestart.detail.staleReason, 'process-restart');
    assert.equal(second.begin({ kind: 'game', chatKey: 'group:1', idemKey: 'game:1:g1' }).action, 'review');
  } finally { store.close(); }
});

test('保留期只清已结算的；unknown/planned 永不自动删；统计口径正确', () => {
  const store = freshStore();
  try {
    let now = 5_000_000;
    const ledger = new EffectLedger(store.db, { now: () => now });
    const sent = ledger.begin({ kind: 'digest', idemKey: 'd:sent' });
    ledger.settle(sent.id, 'sent');
    const unknown = ledger.begin({ kind: 'digest', idemKey: 'd:unknown' });
    ledger.settle(unknown.id, 'unknown');
    const failed = ledger.begin({ kind: 'digest', idemKey: 'd:failed' });
    ledger.settle(failed.id, 'failed');

    const stats = ledger.stats();
    assert.equal(stats.byState.sent, 1);
    assert.equal(stats.byState.unknown, 1);
    assert.equal(stats.byState.failed, 1);
    assert.equal(stats.unknownRecent, 1);

    now += 100 * 24 * 60 * 60 * 1000;
    const removed = ledger.prune(90);
    assert.equal(removed, 2, 'sent 与 failed 被清，unknown 保留');
    assert.ok(ledger.get('digest', 'd:unknown'));
    assert.equal(ledger.get('digest', 'd:sent'), null);
  } finally { store.close(); }
});

test('kind/idemKey 缺失直接报错（避免调用方写错键还静默不幂等）', () => {
  const store = freshStore();
  try {
    const ledger = new EffectLedger(store.db);
    assert.throws(() => ledger.begin({ kind: '', idemKey: 'x' }), /kind/);
    assert.throws(() => ledger.begin({ kind: 'digest', idemKey: '' }), /idemKey/);
  } finally { store.close(); }
});

test('跨进程崩溃：begin 之后进程直接退出 → 重启清扫为 unknown，不再自动执行', async () => {
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-effect-crash-'));
  const repo = path.dirname(fileURLToPath(new URL('./', import.meta.url)));
  const storeUrl = pathToFileURL(path.join(repo, 'src/core/store.js')).href;
  const effectsUrl = pathToFileURL(path.join(repo, 'src/core/effects.js')).href;
  const script = `
    import { ChatStore } from ${JSON.stringify(storeUrl)};
    import { EffectLedger } from ${JSON.stringify(effectsUrl)};
    const store = new ChatStore(0, { dataDir: process.env.QQ_AGENT_DATA_DIR });
    const ledger = new EffectLedger(store.db);
    const e = ledger.begin({ kind: 'digest', chatKey: 'group:1', idemKey: 'digest:group:1:2026-10-31' });
    // 模拟"发送后、结算前"被杀：planned 行留着，时间已经超过 TTL
    store.db.prepare('UPDATE effects SET created_at=?').run(Date.now() - 3600_000);
    process.stdout.write('EFFECT_ID=' + e.id);
    process.exit(86);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, QQ_AGENT_DATA_DIR: crashDir },
    encoding: 'utf8'
  });
  assert.equal(child.status, 86, child.stderr || '子进程应按约定退出');

  // "重启"：新进程/新账本构造时清扫，把上一条命的 planned 转成 unknown
  const store = new ChatStore(0, { dataDir: crashDir });
  try {
    const ledger = new EffectLedger(store.db);
    const row = ledger.get('digest', 'digest:group:1:2026-10-31');
    assert.equal(row.state, 'unknown');
    assert.equal(row.detail.staleReason, 'process-restart');
    assert.equal(
      ledger.begin({ kind: 'digest', chatKey: 'group:1', idemKey: 'digest:group:1:2026-10-31' }).action,
      'review',
      '崩溃后的动作必须人工核对，不能自动再做一遍'
    );
  } finally {
    store.close();
    fs.rmSync(crashDir, { recursive: true, force: true });
  }
});

test('resolve 的人工审计在后续 failed→planned 重试后仍然保留', () => {
  const store = freshStore();
  try {
    const ledger = new EffectLedger(store.db);
    const begun = ledger.begin({ kind: 'digest', idemKey: 'd:audit' });
    ledger.settle(begun.id, 'unknown', { reason: 'timeout' });
    assert.equal(ledger.resolve(begun.id, 'failed', { reason: 'manual-force' }), true);
    ledger.begin({ kind: 'digest', idemKey: 'd:audit', detail: { day: '2026-10-31' } });
    const row = ledger.get('digest', 'd:audit');
    assert.equal(row.state, 'planned');
    assert.equal(row.detail.resolvedBy, 'manual', '人工改判的审计不能被 begin 覆盖');
    assert.equal(row.detail.reason, 'manual-force');
    assert.equal(row.detail.day, '2026-10-31', '新的 detail 也要并进来');
    // 非 unknown 不允许 resolve
    ledger.settle(begun.id, 'sent');
    assert.equal(ledger.resolve(begun.id, 'failed'), false, 'sent 不能被 resolve 回退');
  } finally { store.close(); }
});

test('ops effects：列出 unknown、人工改判为 failed（CLI 端到端）', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-effects-cli-'));
  const repo = path.dirname(fileURLToPath(new URL('./', import.meta.url)));
  const store = new ChatStore(0, { dataDir: cliDir });
  let id = '';
  try {
    const ledger = new EffectLedger(store.db);
    const begun = ledger.begin({ kind: 'direct:react', chatKey: 'group:1', idemKey: 'cli:1', detail: { mid: '42' } });
    ledger.settle(begun.id, 'unknown', { error: 'timeout' });
    id = begun.id;
    // 模拟这笔副作用对应的 outbox 未知行 + 被它挂起的 held 消息/运行：
    // 账本改判后必须一起核对掉，否则会话会一直 blocked（2026-10-31 审查 P2）。
    store.db.prepare(`INSERT INTO outbox(id, run_id, chat_key, state, payload)
      VALUES (?,?,?,?,?)`).run('op_cli_1', begun.id, 'group:1', 'unknown', '{}');
    store.db.prepare(`INSERT INTO messages
      (chat_key,id,mid,ts,sender_id,sender_name,text,self,state,lease_id)
      VALUES (?,?,?,?,?,?,?,1,?,?)`).run('group:1', 1, 'm1', Date.now(), '1', 'A', 'x', 'held', begun.id);
    store.db.prepare(`INSERT INTO runs(id, chat_key, state, expires_at, error)
      VALUES (?,?,?,?,?)`).run(begun.id, 'group:1', 'held', Date.now() + 60_000, '');
  } finally { store.close(); }

  const env = { ...process.env, QQ_AGENT_DATA_DIR: cliDir };
  const ops = path.join(repo, 'src/ops.js');
  const list = spawnSync(process.execPath, [ops, 'effects', 'list', '--state', 'unknown'], { env, encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.ok(list.stdout.includes(id), '列表要给出 id');
  assert.ok(list.stdout.includes('direct:react'));

  const refuse = spawnSync(process.execPath, [ops, 'effects', 'resolve', id, '--sent'], { env, encoding: 'utf8' });
  assert.equal(refuse.status, 2, '没有 --confirm 必须拒绝');

  const resolve = spawnSync(process.execPath, [ops, 'effects', 'resolve', id, '--sent', '--confirm'], { env, encoding: 'utf8' });
  assert.equal(resolve.status, 0, resolve.stderr);
  assert.match(resolve.stdout, /已改判为 sent/);

  const after = spawnSync(process.execPath, [ops, 'effects', 'list', '--state', 'unknown'], { env, encoding: 'utf8' });
  assert.equal(after.status, 0);
  assert.ok(!after.stdout.includes(id), '改判后不在 unknown 列表');
  assert.match(resolve.stdout, /已同步 1 条未知发送/);

  // outbox 未知行被核对、held 消息与 run 被释放（与 console 的 reconcile 同语义）
  const reopened = new ChatStore(0, { dataDir: cliDir });
  try {
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE run_id=?').get(id).n, 0);
    assert.equal(reopened.db.prepare("SELECT state FROM messages WHERE chat_key='group:1' AND id=1").get().state, 'acked');
    assert.equal(reopened.db.prepare('SELECT state FROM runs WHERE id=?').get(id).state, 'acked');
  } finally { reopened.close(); }
  fs.rmSync(cliDir, { recursive: true, force: true });
});
