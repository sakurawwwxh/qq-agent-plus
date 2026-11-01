// A2 的**行为**用例：走真实派发链验证「自主节奏唤醒不绕过预算闸门」。
//
// 上一版我断言"行为用例做不到、直接调 wake() 会空过"——那是切入点选错了：
// 直接调 wake() 时它在到达预算闸门之前就因别的条件 return，runAgent 调用数恒为 0。
// 走真实链路就成立：真 store / sessions / 假 onebot + 桩 globalThis.fetch，
// onIncoming() → 排一次 paced 唤醒 → 把它置为到期 → fireDueScheduledWakes()
// → 断言 fetch 调用次数与未读数（2026-10-04 全面复审给的切入点）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pacing-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');

/** 造一个「预算已超 + 开启自主节奏」的实例，返回跑真实派发链要用的东西。 */
function makeInstance(t, { onExceed, spentYuan = 99 }) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime = { ...cfg.runtime, mode: 'active' };
  cfg.api = {
    ...cfg.api, model: 'test-model', baseUrl: 'https://api.example/v1', apiKey: 'k',
    budget: { enabled: true, dailyYuan: 0.01, onExceed }
  };
  cfg.allow.groups = ['1'];
  cfg.memory.consolidateEnabled = false;
  cfg.sticker.enabled = false;
  cfg.pacing = { ...(cfg.pacing || {}), enabled: true, scope: 'group', minWakeMinutes: 5, defaultWakeMinutes: 5 };
  setRuntimeConfig(cfg);

  // ⚠️ 每个用例**各自一份 sqlite**：messages 表对 (chat_key, mid) 有唯一约束，共用同一个
  // 文件时后两个用例的 appendIncoming 会被去重吞掉，实际驱动 wake 的是前一个用例残留的
  // 那行 —— 用例之间顺序耦合，谁改了自己的前置谁就把后面的静默弄塌（2026-10-04 复审 P2）。
  // ⚠️⚠️ 第一个位置参数是 maxPerChat：原先漏了它，配置对象被当成 cap 传进去、filename 落回
  // 默认，三个用例照样共用 messages.sqlite —— 隔离从写下那天起就没生效过
  //（2026-10-05 全审实测：临时目录里只有 messages.sqlite，没有任何 pacing-*.sqlite）。
  const store = new ChatStore(0, {
    dataDir: root,
    filename: `pacing-${onExceed}-${spentYuan}-${Math.random().toString(36).slice(2, 8)}.sqlite`
  });
  const sessions = new SessionRegistry();
  const memory = { formatForPrompt: () => '', formatHandoffForPrompt: () => '', getHandoff: () => null, setHandoff: () => null, clearHandoff: () => {} };
  sessions.todayUsage = () => ({ runs: 9, estimatedYuan: spentYuan, unpricedRuns: 0 });
  const sender = {
    sendTextBatch: async (_chatKey, messages) => ({
      sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: []
    })
  };
  const runner = new Orchestrator({
    store, sessions, memory, stickers: {}, sender,
    onebot: { selfId: '888', selfNickname: 'bot', getGroupInfo: async () => ({ group_name: 'test' }) }
  });
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls += 1;
    return Response.json({ choices: [{ message: { content: '收到' } }], usage: { total_tokens: 10 } });
  };
  t.after(async () => {
    await runner.abortAll();
    globalThis.fetch = originalFetch;
    sessions.close?.();
    store.close();
  });
  return { runner, store, sessions, get modelCalls() { return modelCalls; } };
}

/** 真实链路：来一条未读 → onIncoming 排 paced 唤醒 → 置为到期 → fireDueScheduledWakes。 */
async function runPacedWake(t, opts) {
  const ctx = makeInstance(t, opts);
  ctx.store.appendIncoming('group:1', { mid: '1', text: '在吗', senderId: '42', senderName: 'm42' });
  ctx.runner.onIncoming('group:1');                       // 排一次 paced 唤醒
  const wake = ctx.runner.scheduledWakes.get('group:1');
  assert.ok(wake, '前提：已排上一次自主节奏唤醒');
  ctx.runner.scheduledWakes.set('group:1', { ...wake, at: Date.now() - 1000 });   // 置为到期
  ctx.runner.fireDueScheduledWakes();
  await new Promise((r) => setTimeout(r, 400));           // 让链跑完
  return { ...ctx, unread: ctx.store.unreadCount('group:1') };
}

test('A2（行为）：预算超限 + 停止策略下，自主节奏唤醒一次模型都不调', async (t) => {
  const r = await runPacedWake(t, { onExceed: 'block' });
  assert.equal(r.modelCalls, 0, 'block 期间自主节奏唤醒不许调模型（paced 不能靠 manual:true 绕过闸门）');
  assert.equal(r.unread, 1, '未读要保留（不能当成已处理吞掉）');
});

test('A2（行为）：预算超限 + 降级策略下，群里没 @ 同样不调模型', async (t) => {
  const r = await runPacedWake(t, { onExceed: 'degrade' });
  assert.equal(r.modelCalls, 0, 'degrade 下自主节奏唤醒同样要被拦');
  assert.equal(r.unread, 1, '未读保留');
});

test('A2（反向，行为）：预算未超限时，同一条链路会真的调模型（守卫不能变成"一律不放行"）', async (t) => {
  const r = await runPacedWake(t, { onExceed: 'block', spentYuan: 0 });
  assert.ok(r.modelCalls >= 1, `预算未超限时 paced 唤醒应当调模型（实际 fetch ${r.modelCalls} 次）——守卫若变成"一律不放行"，这条会红`);
});

// ── 2026-10-06 复审 P3：pacing 不许顶掉模型自安排的唤醒（单槽覆盖会连留言一起清）──
test('P3-1（行为）：带留言的 selfWake 不被 paced 唤醒顶掉', async (t) => {
  const ctx = makeInstance(t, { onExceed: 'block', spentYuan: 0 });
  ctx.runner.scheduleInitiativeWake('group:1', 2 * 60 * 60 * 1000, '记得看看那个帖子的后续', { kind: 'selfWake' });
  ctx.store.appendIncoming('group:1', { mid: '31', text: '今天天气不错', senderId: '42', senderName: 'm42' });
  ctx.runner.onIncoming('group:1');
  const wake = ctx.runner.scheduledWakes.get('group:1');
  assert.equal(wake?.kind, 'selfWake', '模型自安排的唤醒不许被 paced 覆盖');
  assert.equal(wake?.note, '记得看看那个帖子的后续', 'selfWake 的留言必须原样保留');
  assert.equal(ctx.store.unreadCount('group:1'), 1, '消息保留未读，等 selfWake 到点处理');
});

test('P3-1（反向，行为）：没有 selfWake 时 paced 照常排上（守卫不许变成一律不排）', async (t) => {
  const ctx = makeInstance(t, { onExceed: 'block', spentYuan: 0 });
  ctx.store.appendIncoming('group:1', { mid: '41', text: '在吗', senderId: '43', senderName: 'm43' });
  ctx.runner.onIncoming('group:1');
  const wake = ctx.runner.scheduledWakes.get('group:1');
  assert.ok(wake, '无已有安排时 paced 唤醒要照常排上');
  assert.equal(wake.kind, 'paced');
});

// ── 2026-10-06 复审 P2：网关返回畸形 tool_calls（缺 id）时，进 messages 前先归一化 ──
test('P2-8（行为）：缺 id 的原生 tool_calls 会被补齐，下一轮 assistant/tool 配对完整', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime = { ...cfg.runtime, mode: 'active' };
  cfg.api = { ...cfg.api, model: 'test-model', baseUrl: 'https://api.example/v1', apiKey: 'k' };
  cfg.allow.groups = ['1'];
  cfg.memory.consolidateEnabled = false;
  cfg.sticker.enabled = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, {
    dataDir: root,
    filename: `toolcalls-${Math.random().toString(36).slice(2, 8)}.sqlite`
  });
  const sessions = new SessionRegistry();
  const memory = { formatForPrompt: () => '', formatHandoffForPrompt: () => '', getHandoff: () => null, setHandoff: () => null, clearHandoff: () => {} };
  const sender = {
    sendTextBatch: async (_chatKey, messages) => ({
      sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: []
    })
  };
  const runner = new Orchestrator({
    store, sessions, memory, stickers: {}, sender,
    onebot: { selfId: '888', selfNickname: 'bot', getGroupInfo: async () => ({ group_name: 'test' }) }
  });
  const originalFetch = globalThis.fetch;
  const bodies = [];
  let call = 0;
  globalThis.fetch = async (_url, options) => {
    call += 1;
    bodies.push(JSON.parse(String(options?.body || '{}')));
    if (call === 1) {
      // 部分网关/自部署推理服务的真实形态：缺 id、缺 type 的原生 tool_calls
      return Response.json({
        choices: [{ message: { content: '', tool_calls: [{ function: { name: 'no_such_tool', arguments: '{}' } }] } }],
        usage: { total_tokens: 5 }
      });
    }
    return Response.json({ choices: [{ message: { content: '好的' } }], usage: { total_tokens: 3 } });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await runner.abortAll();
    sessions.close?.();
    store.close();
  });
  store.appendIncoming('group:1', { mid: 51, text: '麻烦看下', senderId: '42', senderName: 'm42' });
  await runner.wake('group:1');
  assert.ok(bodies.length >= 2, `前提：第二轮请求发生了（实际 ${bodies.length} 轮）`);
  // 按"哪一轮带着 tool 结果"定位，不写死 bodies[1]：上游多出一次合法请求轮次（如多一轮
  // 规划）时下标会假红（2026-10-07 复核）。
  const roundWithTools = bodies.find((b) => (b.messages || []).some((m) => m.role === 'tool'));
  assert.ok(roundWithTools, '前提：存在带 tool 结果消息的请求轮次');
  const assistant = (roundWithTools.messages || [])
    .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length).pop();
  const toolMsg = (roundWithTools.messages || []).filter((m) => m.role === 'tool').pop();
  assert.ok(assistant, '第二轮请求要带上 assistant.tool_calls');
  assert.ok(assistant.tool_calls[0].id, 'tool_calls[0].id 必须已归一化补齐（缺 id 时多数端点整请求 400）');
  assert.ok(toolMsg, '第二轮请求要带上 tool 结果消息');
  assert.equal(toolMsg.tool_call_id, assistant.tool_calls[0].id, 'assistant 与 tool 消息必须按同一 id 配对');
});

test('兜底回收不能绕过 pacing：不会排 8–12 秒的即时唤醒', async (t) => {
  const ctx = makeInstance(t, { onExceed: 'block' });
  ctx.store.appendIncoming('group:1', { mid: 'recovery-1', text: '普通消息', senderId: '42', senderName: 'm42' });
  ctx.runner.onIncoming('group:1');
  const before = ctx.runner.scheduledWakes.get('group:1');
  assert.ok(before && before.at - Date.now() > 60_000, '前提：已排几分钟后的 paced 唤醒');

  ctx.runner.startRecoveryLoop();
  await new Promise((resolve) => setTimeout(resolve, 5300));

  assert.equal(ctx.runner.pendingWake.size, 0, '回收循环不该排即时唤醒');
  assert.equal(ctx.store.unreadCount('group:1'), 1, '消息必须保留到 paced 唤醒');
  const after = ctx.runner.scheduledWakes.get('group:1');
  assert.ok(after && after.at - Date.now() > 60_000, '仍应是几分钟后的 paced，而不是被提前');
});
