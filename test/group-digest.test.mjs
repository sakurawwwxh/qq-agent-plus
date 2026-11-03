// 群日报（group-digest）门禁：读消息与调模型**之前**就该挡住观察模式/白名单外的群。
// 原来只在最后 sendTextBatch 时才被 access 挡 —— 于是每天照样读 400 条消息 + 调一次模型
// 才被拒（白花钱，还把群消息送出了网）。2026-10-03 全量审查。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-digest-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const { GroupDigestManager } = await import('../src/features/group-digest.js');
const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { ChatStore } = await import('../src/core/store.js');
const { EffectLedger } = await import('../src/core/effects.js');

function fixture({ mode = 'active', allow = ['1'], sender = null, platform = null, persona = null, effects = null, now = null, rows: rowsOverride = null, storeExtras = null, store: storeOverride = null } = {}) {
  const rows = rowsOverride ?? Array.from({ length: 20 }, (_, i) => ({
    mid: `m${i}`, ts: Date.now() - 60_000, self: false,
    sender: { uin: 100 + i, nickname: `群友${i}` }, text: `第 ${i} 条消息`
  }));
  const stats = { modelCalls: 0, sent: 0 };
  const manager = new GroupDigestManager({
    store: storeOverride ?? { recent: () => rows, listChats: () => ['group:1'], hasUncertainEffects: () => false, ...(storeExtras || {}) },
    sender: sender ?? { sendTextBatch: async () => { stats.sent += 1; return { sent: [] }; } },
    effects,
    ...(now ? { now } : {})
  });
  updateConfig({
    ...DEFAULT_CONFIG,
    runtime: { ...DEFAULT_CONFIG.runtime, mode },
    allow: { groups: allow },
    platform: { ...DEFAULT_CONFIG.platform, ...(platform ?? {}) },
    persona: { ...DEFAULT_CONFIG.persona, ...(persona ?? {}) },
    groupDigest: { ...DEFAULT_CONFIG.groupDigest, enabled: true, chats: ['group:1'] }
  });
  // 群日报用 llm.chatCompletion（全局 fetch）→ 用 fetch 桩数调用次数
  globalThis.fetch = async () => {
    stats.modelCalls += 1;
    return Response.json({ choices: [{ message: { content: '群里在聊啥' } }], usage: { total_tokens: 5 } });
  };
  return { manager, stats };
}

test('观察模式：群日报不调模型也不发', async () => {
  const f = fixture({ mode: 'observe' });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 0, '观察模式不该花钱');
  assert.equal(f.stats.sent, 0);
});

test('白名单之外的群：群日报不调模型', async () => {
  const f = fixture({ mode: 'active', allow: ['999'] });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 0, '不在白名单的群不该花钱（门禁要放在调模型之前）');
});

test('正常放行时仍会调模型并发送（门禁没把功能打死）', async () => {
  const f = fixture({ mode: 'active', allow: ['1'] });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 1, '白名单 + active 模式要照常跑');
  assert.equal(f.stats.sent, 1);
});

test('日报卡片：forwardCards 开（默认）→ 发合并转发卡片（带群内昵称），不再发纯文本', async () => {
  const cards = [];
  const texts = [];
  const f = fixture({
    persona: { selfNickname: '犊子' },
    sender: {
      sendForwardCard: async (chatKey, nodes, options) => { cards.push({ chatKey, nodes, options }); return { message_id: 7 }; },
      sendTextBatch: async (chatKey, messages) => { texts.push({ chatKey, messages }); return { sent: [] }; }
    }
  });
  const out = await f.manager.runOnce();
  assert.equal(cards.length, 1, '默认要发卡片');
  assert.equal(texts.length, 0, '发了卡片就不该再发文本（否则群里两条日报）');
  assert.deepEqual(cards[0].nodes, [{
    type: 'node',
    data: { nickname: '犊子', content: [{ type: 'text', data: { text: '群里在聊啥' } }] }
  }]);
  assert.equal(cards[0].chatKey, 'group:1');
  assert.equal(out.results[0].asCard, true);
});

test('日报卡片：开关关掉 / 老 sender 没有 sendForwardCard → 回落纯文本', async () => {
  // ① 控制台「平台能力」里关掉 forwardCards
  const texts = [];
  const f1 = fixture({
    platform: { forwardCards: false },
    sender: {
      sendForwardCard: async () => { throw new Error('关了开关还走卡片 = 回归'); },
      sendTextBatch: async (chatKey, messages) => { texts.push({ chatKey, messages }); return { sent: [] }; }
    }
  });
  const out1 = await f1.manager.runOnce();
  assert.equal(texts.length, 1, '关掉开关要回到纯文本');
  assert.deepEqual(texts[0].messages, ['群里在聊啥']);
  assert.equal(out1.results[0].asCard, false);

  // ② sender 没有 sendForwardCard 能力（老接线/降级场景）也要能跑
  const texts2 = [];
  const f2 = fixture({
    sender: { sendTextBatch: async (chatKey, messages) => { texts2.push({ chatKey, messages }); return { sent: [] }; } }
  });
  const out2 = await f2.manager.runOnce();
  assert.deepEqual(texts2[0].messages, ['群里在聊啥'], '没有卡片能力就回落文本，不能抛错');
  assert.equal(out2.results[0].asCard, false, 'asCard 要如实报"没走卡片"（2026-10-07 复审 P3）');
});

test('观察模式挡下的群不记当日完成，恢复后可以补跑', async () => {
  // 同一文件的用例共享 DATA_DIR；先清掉前面用例写下的"今天已跑过"
  fs.rmSync(path.join(root, 'group-digest-state.json'), { force: true });
  const f = fixture({ mode: 'observe' });
  await f.manager.runOnce();
  const stateFile = path.join(root, 'group-digest-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  assert.equal(state?.doneChats?.includes('group:1') || false, false, '被挡下的群不能记完成');

  updateConfig({
    ...DEFAULT_CONFIG,
    runtime: { ...DEFAULT_CONFIG.runtime, mode: 'active' },
    allow: { groups: ['1'] },
    groupDigest: { ...DEFAULT_CONFIG.groupDigest, enabled: true, chats: ['group:1'] }
  });
  await f.manager.runOnce({ skipDone: true });
  assert.equal(f.stats.sent, 1, '恢复 active 后应补发，而不是被 already-sent-today 跳过');
});

test('关闭群日报后，自动补跑（skipDone）不再发送', async () => {
  const f = fixture({ mode: 'active' });
  updateConfig({
    ...DEFAULT_CONFIG,
    runtime: { ...DEFAULT_CONFIG.runtime, mode: 'active' },
    allow: { groups: ['1'] },
    groupDigest: { ...DEFAULT_CONFIG.groupDigest, enabled: false, chats: ['group:1'] }
  });
  const out = await f.manager.runOnce({ skipDone: true });
  assert.equal(out.skipped, 'disabled');
  assert.equal(f.stats.sent, 0, '功能已关闭，孤儿补跑不能发消息');
});

test('同一天同一个群只发一次（账本按归属日去重）', async () => {
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'ledger-dedupe-')) });
  try {
    const ledger = new EffectLedger(store.db);
    const f = fixture({ effects: ledger });
    const first = await f.manager.runOnce();
    assert.equal(f.stats.sent, 1);
    assert.ok(first.results.some((r) => r.ok === true));

    const second = await f.manager.runOnce();   // 控制台"立即运行"手点一次
    assert.equal(f.stats.sent, 1, '同一天同一群不能再发一遍');
    assert.ok(second.results.some((r) => r.skipped === 'effect-done'));
  } finally { store.close(); }
});

test('跨午夜：日报归属开始那天，第二天照常发（不再被标成已发）', async () => {
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'ledger-midnight-')) });
  try {
    // 固定到上海时区 23:58（= UTC 15:58），不依赖 CI 机器的本地时区。
    // 旧写法用 new Date().setHours(23,58)，在 UTC runner 上实际是上海次日 07:58，
    // 跨午夜后仍落在同一个上海自然日，账本按归属日去重就会把第二天当成已发。
    const day1 = new Date(Date.UTC(2026, 10, 3, 15, 58, 0));
    let now = day1.getTime();
    const ledger = new EffectLedger(store.db, { now: () => now });
    const stats = { sent: 0 };
    const sender = {
      sendTextBatch: async () => {
        stats.sent += 1;
        now = day1.getTime() + 4 * 60 * 1000;   // 发送过程跨过午夜（00:02）
        return { sent: [] };
      }
    };
    const rows = Array.from({ length: 20 }, (_, i) => ({
      mid: `m${i}`, ts: day1.getTime() - 60_000, self: false,
      sender: { uin: 100 + i, nickname: `群友${i}` }, text: `第 ${i} 条消息`
    }));
    const f = fixture({ effects: ledger, sender, now: () => now, rows });
    await f.manager.runOnce();
    assert.equal(stats.sent, 1);

    // 第二天 09:30：如果进度文件按"写盘时刻"记日期，这里会被当成已经发过而静默跳过
    const day2 = new Date(Date.UTC(2026, 10, 4, 1, 30, 0));   // 上海次日 09:30
    now = day2.getTime();
    await f.manager.runOnce({ skipDone: true });
    assert.equal(stats.sent, 2, '第二天的日报必须照常发');
  } finally { store.close(); }
});

test('发送结果未知：账本记 unknown，同一天不再自动重发', async () => {
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'ledger-unknown-')) });
  try {
    const ledger = new EffectLedger(store.db);
    let calls = 0;
    const sender = {
      sendTextBatch: async () => {
        calls += 1;
        throw Object.assign(new Error('socket timeout'), { outcome: 'unknown' });
      }
    };
    // 模拟 outbox 里有本次 effect 的 unknown 行
    const f = fixture({ effects: ledger, sender, storeExtras: { hasUncertainEffects: () => true } });
    const first = await f.manager.runOnce();
    assert.ok(String(first.results[0]?.error).includes('未知'));
    assert.equal(ledger.stats().byState.unknown, 1);

    const second = await f.manager.runOnce();
    assert.equal(calls, 1, '结果未知后绝不自动重发');
    assert.ok(String(second.results[0]?.error).includes('未知'));
  } finally { store.close(); }
});

test('in-flight 不记今日完成：同一天补跑仍会再试（不会永久跳过）', async () => {
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'ledger-inflight-')) });
  try {
    const { todayKey } = await import('../src/core/util.js');
    // 本文件前面的用例可能已把 group:1 写进"今日已完成"；这条用例要单独验证
    // in-flight 是否写进度，先清掉共享状态文件。
    fs.rmSync(path.join(root, 'group-digest-state.json'), { force: true });
    const ledger = new EffectLedger(store.db);
    const day = todayKey();
    const begun = ledger.begin({ kind: 'digest', chatKey: 'group:1', idemKey: `digest:group:1:${day}` });
    assert.equal(begun.action, 'proceed');
    const f = fixture({ effects: ledger });

    const first = await f.manager.runOnce();
    assert.ok(String(first.results[0]?.error).includes('还在发送中'));
    assert.equal(f.stats.sent, 0, '在途时不能发');

    // 在途结束后用 skipDone 补跑：如果上一轮被记成"今日已完成"，这里会被 already-sent-today 跳过。
    ledger.settle(begun.id, 'failed', { error: '模拟在途结束' });
    const second = await f.manager.runOnce({ skipDone: true });
    assert.equal(f.stats.sent, 1, 'in-flight 不能写进 doneChats，否则当天日报永久丢失');
    assert.ok(!second.results.some((r) => r.skipped === 'already-sent-today'));
  } finally { store.close(); }
});

test('确定没发出去（failed）：同一天允许再试一次', async () => {
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'ledger-failed-')) });
  try {
    const ledger = new EffectLedger(store.db);
    let calls = 0;
    const sender = {
      sendTextBatch: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('connect ECONNREFUSED'), { outcome: 'failed' });
        return { sent: [] };
      }
    };
    const f = fixture({ effects: ledger, sender });
    await f.manager.runOnce();
    assert.equal(ledger.stats().byState.failed, 1);
    await f.manager.runOnce();
    assert.equal(calls, 2, '能证明没送达的失败允许重试');
    assert.equal(ledger.stats().byState.sent, 1);
  } finally { store.close(); }
});

test('上次结果未知时：自动补跑被挡住，控制台「立即试跑一次」清掉 outbox 未知后能重发', async () => {
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'ledger-force-')) });
  try {
    // 真实 store：日报要有 20 条消息才生成
    for (let i = 0; i < 20; i += 1) {
      store.appendIncoming('group:1', {
        mid: `f${i}`, ts: Date.now() - 60_000, senderId: '42', senderName: '群友', text: `第 ${i} 条`
      }, { recordOnly: true });
    }
    const ledger = new EffectLedger(store.db);
    let calls = 0;
    const sender = {
      sendTextBatch: async (_chatKey, _messages, options = {}) => {
        calls += 1;
        if (calls === 1) {
          // 真实链路：sender 会先用 runId=effectId 写一条 outbox unknown，再抛错
          const opId = store.beginSend('group:1', options.runId, { type: 'text' });
          store.finishSend(opId, { error: 'socket timeout', outcome: 'unknown' });
          throw Object.assign(new Error('socket timeout'), { outcome: 'unknown' });
        }
        return { sent: [] };
      }
    };
    const f = fixture({ effects: ledger, sender, store });
    await f.manager.runOnce();
    assert.equal(ledger.stats().byState.unknown, 1);
    assert.equal(store.listUnknownOperations('group:1').length, 1, '前提：outbox 里有本次未知行');

    // 自动补跑：不能重发
    await f.manager.runOnce({ skipDone: true });
    assert.equal(calls, 1);

    // 人工点「立即试跑一次」：核对掉 outbox 未知行 → resolve → 重新 begin → 发送
    await f.manager.runOnce({ forceUnknown: true });
    assert.equal(calls, 2, '人工确认后要能真正重试（不能被 outbox 守卫挡住）');
    assert.equal(ledger.stats().byState.sent, 1);
    assert.equal(ledger.stats().byState.unknown, 0);
    assert.equal(store.listUnknownOperations('group:1').length, 0, '旧未知行要被核对掉');
  } finally { store.close(); }
});
