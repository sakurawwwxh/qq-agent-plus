import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../src/core/store.js';

describe('ChatStore', () => {
  function fixture(t, cap = 0, opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-'));
    const store = new ChatStore(cap, { dataDir: dir, ...opts });
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { store, dir };
  }
  function append(store, mid, text = 'message') {
    return store.appendIncoming('group:1', { mid, text, senderId: '42', senderName: 'member' });
  }

  it('deduplicates replayed messages and preserves pagination order', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    assert.equal(append(store, 1).duplicate, true);
    append(store, 2);
    assert.equal(store.unreadCount('group:1'), 2);
    assert.deepEqual(store.recent('group:1', { limit: 1, offset: 1 }).map((m) => m.mid), ['1']);
  });

  it('lastSelfMessageAt 直接查库，不被最近 100 条窗口截断', (t) => {
    const { store } = fixture(t);
    const base = Date.now() - 200_000;
    store.appendSelf('group:1', { mid: 'self-1', text: '我说过话', ts: base });
    for (let i = 0; i < 120; i += 1) append(store, i + 1000, `m${i}`);
    assert.equal(store.lastSelfMessageAt('group:1'), base);
    assert.equal(store.recent('group:1', { limit: 100 }).some((m) => m.self), false,
      '前提：最近 100 条里确实没有自己');
  });

  it('claims a snapshot without acknowledging it and keeps later messages pending', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    const batch = store.claimUnread('group:1');
    assert.equal(store.findByMid('group:1', 1).read, false);
    assert.equal(store.claimUnread('group:1'), null);
    append(store, 2);
    assert.equal(store.ackLease(batch.id), 1);
    assert.equal(store.ackLease(batch.id), 0);
    assert.deepEqual(store.peekUnread('group:1').map((m) => m.mid), ['2']);
  });

  it('claimUnread 支持从指定 id 开始领取（degrade 队尾 @ 不被更早的普通消息挤出批次）', (t) => {
    const { store } = fixture(t);
    for (let i = 1; i <= 5; i += 1) append(store, i, `m${i}`);
    const batch = store.claimUnread('group:1', { fromId: 3 });
    assert.deepEqual(batch.messages.map((m) => m.mid), ['3', '4', '5']);
    store.ackLease(batch.id);
  });

  it('somePending 扫描整段未读：排在 peek 窗口之后的 @ 也能找到', (t) => {
    const { store } = fixture(t);
    for (let i = 1; i <= 150; i += 1) append(store, i, `普通消息 ${i}`);
    store.appendIncoming('group:1', { mid: 151, text: '@机器人 看一下', senderId: '43', senderName: 'member', mentionsSelf: true });
    assert.equal(store.peekUnread('group:1', 100).some((m) => m.mentionsSelf), false,
      'peek 只看最旧 100 条，@ 在窗口外');
    assert.equal(store.somePending('group:1', { test: (m) => m.mentionsSelf === true }), true,
      'degrade 闸门必须扫完整段未读，否则该群当天对 @ 完全无反应');
    assert.equal(store.somePending('group:1', { test: (m) => m.eventKind === 'poke' }), false);
  });

  it('returns failed unsent batches to pending and stops after the attempt budget', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    for (let n = 0; n < 3; n++) {
      const batch = store.claimUnread('group:1');
      store.failLease(batch.id, 'offline', { delayMs: 0 });
    }
    assert.equal(store.unreadCount('group:1'), 0);
    assert.equal(store.getChatMeta('group:1').failed, 1);
    assert.equal(store.retryFailed('group:1'), 1);
    assert.equal(store.unreadCount('group:1'), 1);
  });

  it('recovers expired leases without re-sending uncertain external effects', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    const batch = store.claimUnread('group:1');
    const send = store.beginSend('group:1', batch.id, { text: 'hello' });
    store.finishSend(send, { error: 'response lost' });
    assert.equal(store.recoverExpired(Date.now() + 300000), 1);
    assert.equal(store.getChatMeta('group:1').held, 1);
    assert.equal(store.retryFailed('group:1'), 0);
    assert.equal(store.resolveHeld('group:1'), 1);
  });

  it('启动时收口未过期的 leased run：硬崩重启不让会话卡 4 分钟', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    store.claimUnread('group:1');
    assert.equal(store.hasLeasedRun('group:1'), true);
    // 租约 expires_at 在未来；只有启动清扫能把它收口。
    assert.equal(store.failLeasedRunsAtStartup(), 1);
    assert.equal(store.hasLeasedRun('group:1'), false);
    assert.equal(store.findByMid('group:1', 1).state, 'pending');
  });

  it('recoverExpired 跳过 live 集合里仍在跑的租约：不把在跑批次放回队列（2026-10-09 审查）', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    const batch = store.claimUnread('group:1');
    // 租约已到期、但执行还在跑（liveLeases 带着它）→ 回收必须跳过：
    // 放回 pending 会被下一个 drain 再处理一遍 = 群里重复回复（线上真实发生过）。
    assert.equal(store.recoverExpired(Date.now() + 300000, { live: new Set([batch.id]) }), 0);
    assert.equal(store.unreadCount('group:1'), 0, '在跑批次不能被放回 pending');
    assert.equal(store.claimUnread('group:1'), null, '也不能被重复领取（one_lease_per_chat）');
    // 执行收尾、live 清空后，过期租约才允许被回收
    assert.equal(store.recoverExpired(Date.now() + 300000, { live: new Set() }), 1);
  });

  it('pruneRuns：清超期终态行、留未过期与 leased 行（启动与每日调度共用同一口径）', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    const done = store.claimUnread('group:1');
    store.ackLease(done.id);
    append(store, 2);
    const failed = store.claimUnread('group:1');
    store.failLease(failed.id, 'boom', { retryable: false });

    const insert = store.db.prepare('INSERT INTO runs(id,chat_key,state,expires_at) VALUES (?,?,?,?)');
    const old = Date.now() - 100 * 24 * 3600 * 1000;
    const recent = Date.now() + 60 * 1000;
    insert.run('old-acked', 'group:9', 'acked', old);
    insert.run('old-held', 'group:9', 'held', old);
    insert.run('old-failed', 'group:9', 'failed', old);
    insert.run('recent-acked', 'group:9', 'acked', recent);
    insert.run('old-but-leased', 'group:9', 'leased', old);
    assert.equal(store.pruneRuns(), 3, '三条超期终态行被清掉');
    const left = store.db.prepare('SELECT id FROM runs ORDER BY id').all().map((r) => r.id);
    assert.ok(!left.includes('old-acked') && !left.includes('old-held') && !left.includes('old-failed'));
    assert.ok(left.includes('recent-acked'), '未过期行保留');
    assert.ok(left.includes('old-but-leased'), 'leased 行不归保留期管（回收是 recoverExpired 的职责）');
    assert.ok(left.includes(done.id) && left.includes(failed.id), '本次启动建的行（expires_at 在未来）不能被清');
    assert.equal(store.pruneRuns(1), 0, '再清一遍是幂等的');
  });

  it('resolveHeld 清残骸但绝不碰在途租约的证据，也不漏掉主动唤醒的孤儿残骸', (t) => {
    const { store } = fixture(t);
    // 在途租约：claimUnread 建的 runs 行是 'leased'，它的 outbox 行是 failLease 判
    // hasEffects 的证据 —— 删掉它，这次收尾就会被当成"没发出去"，整批消息回队重跑。
    append(store, 1);
    const batch = store.claimUnread('group:1');
    const live = store.beginSend('group:1', batch.id, { text: 'in flight' });
    const orphan = store.beginSend('group:1', 'proactive-synthetic-run', { text: 'lost' });
    store.finishSend(orphan, { error: 'response lost' });
    assert.equal(store.getChatMeta('group:1').held, 2, '前提：一条在途 + 一条主动唤醒的未知残骸');
    assert.equal(store.resolveHeld('group:1'), 1, '清掉的是残骸数，不是把在途那条也算进去');
    assert.equal(store.hasEffects(batch.id), true, '在途租约的 sending 行被删了：收尾会当成没发过');
    assert.ok(store.listUnknownOperations('group:1', 100, { includeSending: true }).some((op) => op.id === live), '在途证据仍在库里');
    // 主动唤醒没有 runs 行（runId 是合成值），残骸 run_id 在 runs 里查无此人 ——
    // 只按终态 run 取交集的写法会永远清不掉它，控制台一直显示"待核对"。
    assert.equal(store.listUnknownOperations('group:1', 100, { includeSending: true }).some((op) => op.id === orphan), false,
      '主动唤醒的未知残骸要能清掉，否则人工核对永远点不干净');
    assert.equal(store.getChatMeta('group:1').held, 1, '清完之后只剩在途那条');
  });

  it('reconciles unknown operations individually without deleting business history', (t) => {
    const { store } = fixture(t);
    const message = store.appendIncoming('group:9', {
      mid: 901, ts: Date.now(), senderId: '42', text: 'unknown write'
    });
    const lease = store.claimUnread('group:9');
    const first = store.beginSend('group:9', lease.id, { type: 'text', text: 'one' });
    const second = store.beginSend('group:9', lease.id, { type: 'poke', targetUserId: '42' });
    store.finishSend(first, { error: 'response lost' });
    store.finishSend(second, { error: 'response lost' });
    store.failLease(lease.id, 'Delivery uncertain; batch held for operator review');
    assert.equal(store.getChatMeta('group:9').held, 1);
    assert.equal(store.listUnknownOperations('group:9').length, 2);

    const one = store.reconcileUnknownOperation(first, 'sent');
    assert.equal(one.remaining, 1);
    assert.equal(store.findByMid('group:9', message.mid).state, 'held');
    const two = store.reconcileUnknownOperation(second, 'failed');
    assert.equal(two.remaining, 0);
    assert.equal(store.findByMid('group:9', message.mid).state, 'acked');
    assert.equal(store.getChatMeta('group:9').held, 0);
  });

  it('reconcile 不允许把仍在发送的 sending 行提前改成终态', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    const lease = store.claimUnread('group:1');
    const live = store.beginSend('group:1', lease.id, { text: 'in flight' });
    assert.equal(store.reconcileUnknownOperation(live, 'sent'), null,
      '在途发送不是 unknown，管理员不能提前核对');
    assert.equal(store.listUnknownOperations('group:1').some((op) => op.id === live), false,
      '控制台默认只列 unknown，sending 的按钮必然核对失败');
    assert.equal(store.listUnknownOperations('group:1', 100, { includeSending: true }).some((op) => op.id === live), true,
      '在途证据必须保留，finishSend/hasUncertainEffects 还要用');
    store.finishSend(live, { error: 'response lost' });
    assert.equal(store.reconcileUnknownOperation(live, 'sent').result, 'sent');
  });

  it('persists leases and recovers an interrupted unsent run after reopening', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-reopen-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let store = new ChatStore(0, { dataDir: dir });
    append(store, 1);
    store.claimUnread('group:1');
    store.close();
    store = new ChatStore(0, { dataDir: dir });
    assert.equal(store.recoverExpired(Date.now() + 300000), 1);
    assert.equal(store.unreadCount('group:1'), 1);
    store.close();
  });

  it('bounds each batch and never evicts pending messages for retention', (t) => {
    const { store } = fixture(t, 2);
    for (let i = 1; i <= 6; i++) append(store, i, 'x'.repeat(3000));
    assert.equal(store.unreadCount('group:1'), 6);
    const batch = store.claimUnread('group:1', { maxChars: 3000 });
    assert.equal(batch.messages.length, 1);
    assert.ok(batch.messages[0].text.length < 2100);
    assert.equal(store.findByMid('group:1', 1).text.length, 3000);
    store.failLease(batch.id, 'invalid model', { retryable: false });
    assert.equal(store.getChatMeta('group:1').failed, 1);
    assert.equal(store.getChatMeta('group:1').unread, 5);
  });

  it('imports a legacy JSON once, preserving the original archive', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-import-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'messages'));
    const file = path.join(dir, 'messages/group_1.json');
    fs.writeFileSync(file, JSON.stringify({ chatKey: 'group:1', messages: [
      { mid: 1, text: 'old', read: true }, { mid: 2, text: 'new', read: false }
    ] }));
    let store = new ChatStore(0, { dataDir: dir });
    assert.equal(store.unreadCount('group:1'), 1);
    store.close();
    store = new ChatStore(0, { dataDir: dir });
    assert.equal(store.getChatMeta('group:1').total, 2);
    assert.ok(fs.existsSync(file));
    store.close();
  });

  it('updates media without duplication and only marks specified pending IDs read', (t) => {
    const { store } = fixture(t);
    const m = append(store, 1);
    append(store, 2);
    store.updateByMid('group:1', 1, { text: 'expanded', appendMedia: [{ url: 'https://example.com/a' }, { url: 'https://example.com/a' }] });
    assert.equal(store.findByLocalId('group:1', m.id).media.length, 1);
    assert.equal(store.findByMid('group:1', 1).text, 'expanded');
    assert.equal(store.markRead('group:1', [m.id]), 1);
    assert.equal(store.activeMembers('group:1')[0].count, 2);
    assert.equal(store.drainUnread('group:1').length, 1);
  });

  it('persists conversation threads and append-only checkpoints', (t) => {
    const { store } = fixture(t);
    const first = store.upsertConversationThread('group:1', {
      participantIds: ['42'],
      topic: '部署排查',
      lastMessageId: 10,
      continuationWindowMs: 120000,
      ttlMs: 600000
    });
    assert.equal(first.state, 'engaged');
    assert.deepEqual(first.participantIds, ['42']);
    assert.ok(first.engagedUntil > Date.now());

    const second = store.upsertConversationThread('group:1', {
      participantIds: ['43'],
      lastMessageId: 11,
      continuationWindowMs: 120000,
      ttlMs: 600000
    });
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.version, first.version + 1);
    assert.deepEqual(second.participantIds, ['42', '43']);

    store.appendThreadCheckpoint('group:1', second.threadId, 'run-1', {
      summary: '服务已恢复',
      openQuestions: ['是否还会断线']
    }, [10, 11]);
    const checkpoint = store.latestThreadCheckpoint('group:1');
    assert.equal(checkpoint.threadId, first.threadId);
    assert.equal(checkpoint.state.summary, '服务已恢复');
    assert.deepEqual(checkpoint.sourceMessageIds, [10, 11]);

    assert.equal(store.closeConversationThread('group:1', 'test-finished'), true);
    assert.equal(store.getConversationThread('group:1'), null);
  });

  it('restores active threads after reopening and expires them by deadline', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-thread-reopen-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let store = new ChatStore(0, { dataDir: dir });
    const thread = store.upsertConversationThread('group:1', {
      participantIds: ['42'],
      continuationWindowMs: 60000,
      ttlMs: 60000
    });
    store.close();

    store = new ChatStore(0, { dataDir: dir });
    assert.equal(store.getConversationThread('group:1').threadId, thread.threadId);
    assert.equal(store.getConversationThread('group:1', thread.expiresAt + 1), null);
    store.close();
  });

  it('applies lifecycle idle deadlines, hard rollover and one-shot resume state', (t) => {
    const { store } = fixture(t);
    const startedAt = 1_000_000;
    const listening = store.updateLifecycleThread('group:1', {
      disposition: 'listening',
      participantIds: ['42'],
      silentIdleMs: 300000,
      activeIdleMs: 1200000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      promptHash: 'prompt-v1',
      now: startedAt
    });
    assert.equal(listening.state, 'listening');
    assert.equal(listening.idleDeadline, startedAt + 300000);
    assert.ok(store.getConversationThread('group:1', startedAt + 299999));
    const acceptedBeforeDeadline = store.updateLifecycleThread('group:1', {
      disposition: 'listening',
      silentIdleMs: 300000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      acceptedAt: startedAt + 299999,
      now: startedAt + 310000
    });
    assert.equal(acceptedBeforeDeadline.threadId, listening.threadId, '截止前到达的消息应继续原生命周期');
    assert.equal(store.getConversationThread('group:1', acceptedBeforeDeadline.idleDeadline + 1), null);

    const active = store.updateLifecycleThread('group:2', {
      disposition: 'active',
      participantIds: ['42'],
      promptTokens: 12000,
      activeIdleMs: 1200000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      promptHash: 'prompt-v1',
      now: startedAt
    });
    assert.equal(active.promptTokens, 12000);
    store.appendThreadTurns('group:2', active.threadId, 'run-1', [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '继续' }
    ]);
    assert.equal(store.getThreadTurns(active.threadId).length, 2);

    const refreshedOnce = store.updateLifecycleThread('group:2', {
      disposition: 'active',
      participantIds: ['43'],
      activeIdleMs: 1200000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      promptHash: 'prompt-v1',
      now: startedAt + 15 * 60000
    });
    assert.equal(refreshedOnce.promptTokens, 12000, '未提供新 usage 时保留上次输入 Token');
    const refreshed = store.updateLifecycleThread('group:2', {
      disposition: 'active',
      participantIds: ['43'],
      activeIdleMs: 1200000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      promptHash: 'prompt-v1',
      now: startedAt + 25 * 60000
    });
    assert.equal(refreshedOnce.hardDeadline, active.hardDeadline, '第一次刷新不延长硬上限');
    assert.equal(refreshed.hardDeadline, active.hardDeadline, '硬上限不能随消息刷新');
    const armed = store.getConversationThread('group:2', active.hardDeadline + 1);
    assert.equal(armed.state, 'rollover_armed');
    assert.equal(armed.promptTokens, 0);
    assert.equal(store.getThreadTurns(active.threadId).length, 0, '滚动时清除原始 provider transcript');

    const resumed = store.updateLifecycleThread('group:2', {
      disposition: 'active',
      promptHash: 'prompt-v1',
      now: active.hardDeadline + 2
    });
    assert.notEqual(resumed.threadId, active.threadId, '任意消息续接应创建新生命周期');
    assert.equal(resumed.state, 'active');

    const equalDeadline = store.updateLifecycleThread('group:3', {
      disposition: 'active',
      activeIdleMs: 1200000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      now: startedAt
    });
    store.updateLifecycleThread('group:3', {
      disposition: 'active',
      activeIdleMs: 1200000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      now: startedAt + 10 * 60000
    });
    assert.equal(
      store.getConversationThread('group:3', equalDeadline.hardDeadline + 1).state,
      'rollover_armed',
      '空闲与硬截止相同时应按硬截止进入续接待命'
    );

    const crossedDuringRun = store.updateLifecycleThread('group:4', {
      disposition: 'active',
      activeIdleMs: 2400000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      now: startedAt
    });
    const crossedResult = store.updateLifecycleThread('group:4', {
      disposition: 'listening',
      activeIdleMs: 2400000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      acceptedAt: crossedDuringRun.hardDeadline - 1,
      now: crossedDuringRun.hardDeadline + 10000
    });
    assert.equal(crossedResult.state, 'rollover_armed', '截止前接收的活跃轮次跨过硬上限后仍应待续接');
  });

  it('restores lifecycle provider turns after reopening', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lifecycle-reopen-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let store = new ChatStore(0, { dataDir: dir });
    const thread = store.updateLifecycleThread('group:1', {
      disposition: 'active',
      promptHash: 'stable-prefix',
      now: Date.now()
    });
    store.appendThreadTurns('group:1', thread.threadId, 'run-1', [
      { role: 'user', content: '第一批消息' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: '需要先检查',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'check', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'call-1', name: 'check', content: 'ok' }
    ]);
    store.close();

    store = new ChatStore(0, { dataDir: dir });
    const restored = store.getConversationThread('group:1');
    assert.equal(restored.threadId, thread.threadId);
    const turns = store.getThreadTurns(thread.threadId);
    assert.equal(turns.length, 3);
    assert.equal(turns[1].reasoning_content, '需要先检查');
    store.close();
  });

  it('adds lifecycle columns to databases created by the threaded pilot', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-thread-migrate-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'messages.sqlite');
    const old = new DatabaseSync(filename);
    old.exec(`
      CREATE TABLE conversation_threads (
        chat_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '', participant_ids TEXT NOT NULL DEFAULT '[]',
        opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_human_at INTEGER NOT NULL DEFAULT 0, last_agent_at INTEGER NOT NULL DEFAULT 0,
        engaged_until INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
        close_reason TEXT
      );
      INSERT INTO conversation_threads
        (chat_key,thread_id,state,opened_at,updated_at,expires_at)
        VALUES ('group:1','old-thread','engaged',1,1,9999999999999);
    `);
    old.close();

    const store = new ChatStore(0, { dataDir: dir });
    const migrated = store.getConversationThread('group:1');
    assert.equal(migrated.threadId, 'old-thread');
    assert.equal(migrated.mode, 'threaded');
    assert.equal(migrated.transcriptChars, 0);
    assert.equal(migrated.promptTokens, 0);
    store.close();
  });

  it('atomically rolls back message acknowledgement when lifecycle persistence fails', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    const lease = store.claimUnread('group:1');
    const cyclic = { role: 'user', content: 'broken' };
    cyclic.self = cyclic;

    assert.throws(() => store.commitLifecycleRun({
      chatKey: 'group:1',
      leaseId: lease.id,
      runId: lease.id,
      threadOptions: { disposition: 'active', promptHash: 'v1' },
      checkpointState: { summary: 'should roll back' },
      sourceMessageIds: [1],
      messages: [cyclic]
    }));

    assert.equal(store.findByMid('group:1', 1).state, 'leased');
    assert.equal(store.getConversationThread('group:1'), null);
    assert.equal(store.latestThreadCheckpoint('group:1'), null);
  });

  it('exposes a lease probe for callers that must not dispatch while a lease is open', (t) => {
    // 背景（2026-09-29 审查 P1）：到点派发提醒的预检必须在 wake 之前知道"这个会话是不是已经
    // 有未回收的租约"——claimUnread 会返回 null 让 wake 静默空转，而调用方随后会把提醒
    // 标记成已触发。硬崩溃留下的 leased 残行正好命中这个窗口。
    const { store } = fixture(t);
    append(store, 1);
    assert.equal(store.hasLeasedRun('group:1'), false);
    const lease = store.claimUnread('group:1');
    assert.equal(store.hasLeasedRun('group:1'), true);
    assert.equal(store.claimUnread('group:1'), null, '有租约时领不到新批次');
    store.ackLease(lease.id);
    assert.equal(store.hasLeasedRun('group:1'), false);
    assert.equal(store.hasLeasedRun('group:2'), false, '只作用于指定会话');
  });

  it('honours store.sqliteSynchronous and can switch it at runtime (Issue #45)', (t) => {
    const sync = (store) => store.db.prepare('PRAGMA synchronous').get().synchronous;
    const { store } = fixture(t);
    assert.equal(sync(store), 2, '默认 FULL');
    store.setSynchronous('NORMAL');
    assert.equal(sync(store), 1, '切到 NORMAL 后即时生效');
    store.setSynchronous('not-a-mode');
    assert.equal(sync(store), 2, '非法值回到 FULL');
    const { store: normal } = fixture(t, 0, { synchronous: 'NORMAL' });
    assert.equal(sync(normal), 1, '构造参数也生效');
  });
});
