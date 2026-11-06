// 插件写操作信任模型（v2.1）：开关默认关 → 对象级批准（待批队列）→ 60s 间隔 → 配额，
// 以及"确定未执行"的批准/配额退还。全部宿主侧，用假 host（不起子进程）验注册表的完整链路。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-writes-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

const {
  grantApproval, checkApproval, refundApproval, consumeQuota, refundQuota,
  requestPendingApproval, listPendingApprovals, approvePendingApproval, grantsStatus,
  rejectPendingApproval, recordPluginWrite, listPluginWrites,
  normalizeTarget, clearPluginGrants
} = await import('../src/plugins/grants.js');
const { PluginRegistry, PLUGIN_WRITE_FLOOR_MS } = await import('../src/plugins/registry.js');

const manifest = () => ({
  id: 'demo',
  apiVersion: 2,
  name: '演示写插件',
  version: '1.0.0',
  capabilities: ['tools'],
  tools: [{
    name: 'do',
    description: '写一点东西',
    parameters: { type: 'object', properties: { bvid: { type: 'string' } }, required: ['bvid'] },
    action: 'write',
    actionTarget: ['bvid'],
    actionPreview: 'text'
  }],
  approvals: [{ action: 'write', label: '写', description: '会写', defaultUses: 1 }],
  quotas: { write: 10 }
});

function makeRegistry({ switchOn = true, ownerUin = '', behavior = {}, manifestPatch = null, sender = null, onebot = {} } = {}) {
  const base = manifest();
  const m = manifestPatch ? { ...base, ...manifestPatch } : base;
  const calls = [];
  const host = {
    id: m.id,
    manifest: m,
    state: 'running',
    lastError: '',
    startedAt: Date.now(),
    callTool: async (name, args, { context } = {}) => {
      calls.push({ name, args, context });
      if (behavior.throw) {
        const error = new Error(behavior.throw);
        if (behavior.throwCode) error.code = behavior.throwCode;
        throw error;
      }
      return { ok: true, verified: true, echo: args.bvid, approved: context?.approved || null };
    },
    status: () => ({ id: m.id, state: 'running', running: true, stats: {} }),
    stop: async () => {},
    observe: () => false
  };
  const registry = new PluginRegistry({
    root: path.join(dataDir, 'plugins'),
    dataDir,
    log: () => {},
    getConfig: () => ({
      admin: ownerUin ? { ownerUin } : undefined,
      onebot,
      plugins: {
        enabled: true,
        enabledIds: ['demo'],
        lazy: true,
        requireIsolation: false,
        switches: switchOn ? { demo: { write: true } } : {}
      }
    }),
    getSender: () => sender,
    hostFactory: () => host
  });
  registry.hosts.set('demo', host);
  // 同一文件共用一个 dataDir：journal 现在会持久化 lastWriteAt（重启后 floor 仍生效）。
  // 这些用例按"新进程"语义跑，显式把进程内 floor 归零；需要测持久化的用例自己再写回。
  registry.lastWriteAt.set('demo', 0);
  return { registry, host, calls };
}

const runTool = async (registry, args, ctx = {}) => {
  const meta = registry.toolDefsFor().find((t) => t.name === 'plugin_call');
  return meta.execute({ chatKey: 'group:1', ...ctx }, { tool: 'demo__do', args });
};

const parse = (result) => JSON.parse(result.content);

test('对象级授权：一次批准只对一个目标', () => {
  grantApproval(dataDir, 'demo', 'write', { target: 'BV1', uses: 1, ttlMs: 60_000 });
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BV1' }).approved, true, '同目标放行');
  const other = checkApproval(dataDir, 'demo', 'write', { target: 'BV2' });
  assert.equal(other.approved, false);
  assert.match(other.reason, /只对一个目标/);
  // 通配（target 空）匹配任意目标 —— 兼容插件直调 cap.approval.check 的旧路径
  grantApproval(dataDir, 'demo', 'wild', { target: '', uses: 1, ttlMs: 60_000 });
  assert.equal(checkApproval(dataDir, 'demo', 'wild', { target: 'ANY' }).approved, true);
});

test('待批队列：请求 → 私聊/控制台批准 → 单次通行证；拒绝即消失', () => {
  const pending = requestPendingApproval(dataDir, {
    pluginId: 'demo', pluginName: '演示', action: 'write', label: '写', target: 'BV9', preview: 'hello'
  });
  assert.match(pending.id, /^ap_/);
  assert.equal(pending.duplicate, undefined);
  const dup = requestPendingApproval(dataDir, {
    pluginId: 'demo', action: 'write', target: 'BV9', preview: 'hello'
  });
  assert.equal(dup.duplicate, true, '同目标重复请求只留一条');

  const approved = approvePendingApproval(dataDir, pending.id, { uses: 1, ttlMs: 60_000 });
  assert.equal(approved.pending.target, 'BV9');
  assert.equal(approved.grant.target, 'BV9');
  assert.equal(listPendingApprovals(dataDir).some((item) => item.id === pending.id), false, '批准后出队');

  const consumed = checkApproval(dataDir, 'demo', 'write', { consume: true, target: 'BV9', preview: 'hello' });
  assert.equal(consumed.approved, true);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BV9', preview: 'hello' }).approved, false, '一次用完');
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BV9', preview: '换了一段' }).approved, false,
    '批准绑定预览内容：换了正文必须重新批准');

  const p2 = requestPendingApproval(dataDir, { pluginId: 'demo', action: 'write', target: 'BV8' });
  rejectPendingApproval(dataDir, p2.id);
  assert.equal(listPendingApprovals(dataDir).length, 0);
  assert.throws(() => approvePendingApproval(dataDir, p2.id), /不存在或已过期/);
});

test('退还：确定未执行退回批准与配额，且幂等', () => {
  grantApproval(dataDir, 'demo', 'write', { target: 'BVR', uses: 1, ttlMs: 60_000 });
  const approval = checkApproval(dataDir, 'demo', 'write', { consume: true, target: 'BVR' });
  const quota = consumeQuota(dataDir, 'demo', 'write', 2);
  assert.equal(quota.ok, true);
  assert.equal(refundApproval(dataDir, 'demo', approval.receipt), true);
  assert.equal(refundApproval(dataDir, 'demo', approval.receipt), false, '收据只退一次');
  assert.equal(refundQuota(dataDir, 'demo', quota.receipt), true);
  assert.equal(refundQuota(dataDir, 'demo', quota.receipt), false);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BVR' }).approved, true, '批准回来了');
  assert.equal(consumeQuota(dataDir, 'demo', 'write', 2).used, 1, '配额退回到 1（原扣 2 退 1）');
});

test('写审计：宿主侧记录，最近在前，超过上限裁剪', () => {
  recordPluginWrite(dataDir, 'audit', { action: 'write', target: 'A', outcome: 'ok', note: '回读核验通过' });
  recordPluginWrite(dataDir, 'audit', { action: 'write', target: 'B', outcome: 'pending', note: 'ap_x' });
  const writes = listPluginWrites(dataDir, 'audit');
  assert.equal(writes[0].target, 'B');
  assert.equal(writes[1].outcome, 'ok');
});

test('注册表全链路：开关隐藏工具 → 未批生成待批 → 批准后自动执行 → 额度耗尽', async () => {
  // ① 开关关：工具不注册（模型看不见）
  const off = makeRegistry({ switchOn: false });
  assert.equal(off.registry.toolDefsFor().length, 0, '开关关时 plugin_call 都不该出现');

  // ② 开关开、未批：报 needsApproval、生成待批、审计记 pending
  const { registry, calls } = makeRegistry({ ownerUin: '10001' });
  const denied = parse(await runTool(registry, { bvid: 'BVZ', text: '内容' }));
  assert.equal(denied.needsApproval, true);
  assert.match(denied.error, /需要管理员批准/);
  assert.match(denied.error, /不用重复调用/, '批准后宿主会自动执行，不能再引导模型重试');
  const pending = listPendingApprovals(dataDir).find((item) => item.pluginId === 'demo' && item.target === 'BVZ');
  assert.ok(pending, '待批已登记');
  assert.equal(pending.preview, '内容', 'actionPreview 参数进了待批预览');
  assert.equal(listPluginWrites(dataDir, 'demo')[0].outcome, 'pending');

  // ③ 私聊同意：只有 owner 本人；批准后宿主持有原始调用，自动重放一次
  const stranger = registry.handleOwnerApprovalText('同意', '99999');
  assert.equal(stranger.handled, false, '非 owner 不拦消息');
  const chat = registry.handleOwnerApprovalText(`同意 ${pending.id} 2`, '10001');
  assert.equal(chat.handled, true);
  assert.match(chat.reply, /已批准/);
  assert.match(chat.reply, /2 次额度/);
  assert.match(chat.reply, /自动执行/);
  await tick();
  assert.equal(calls.length, 1, '批准后应自动执行原请求，用户不用再说一遍');
  assert.deepEqual(calls[0].args, { bvid: 'BVZ', text: '内容' });
  assert.equal(listPluginWrites(dataDir, 'demo')[0].outcome, 'ok', '自动重试也要落审计');

  // ④ 还剩 1 次额度：手动重试同一目标直接成功（拨开 60s 下限）
  registry.lastWriteAt.set('demo', Date.now() - PLUGIN_WRITE_FLOOR_MS - 1000);
  const ok = parse(await runTool(registry, { bvid: 'BVZ', text: '内容' }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.approved, { action: 'write', target: 'BVZ' });
  assert.match(listPluginWrites(dataDir, 'demo')[0].note, /回读核验通过/);

  // ⑤ 额度已耗尽：再调回到"待批"
  registry.lastWriteAt.set('demo', Date.now() - PLUGIN_WRITE_FLOOR_MS - 1000);
  const again = parse(await runTool(registry, { bvid: 'BVZ', text: '内容' }));
  assert.equal(again.needsApproval, true);
});

test('注册表：60s 写入间隔下限 与 失败退还', async () => {
  const { registry, calls } = makeRegistry({ behavior: {} });
  grantApproval(dataDir, 'demo', 'write', { target: 'BVF', preview: '内容', uses: 5, ttlMs: 60_000 });

  const first = parse(await runTool(registry, { bvid: 'BVF', text: '内容' }));
  assert.equal(first.ok, true);

  // 间隔下限：手动把 lastWriteAt 拨到"刚写过"，第二次同插件写被拒
  const saved = registry.lastWriteAt.get('demo');
  registry.lastWriteAt.set('demo', Date.now());
  const floored = parse(await runTool(registry, { bvid: 'BVF', text: '内容' }));
  assert.match(floored.error, /至少间隔/);
  assert.equal(calls.length, 1, '被间隔挡住的调用不该到达插件');
  registry.lastWriteAt.set('demo', saved - PLUGIN_WRITE_FLOOR_MS);

  // 失败退还：插件抛错 → 批准与配额都退回去
  const failing = makeRegistry({ behavior: { throw: 'B 站接口挂了' } });
  failing.registry.lastWriteAt.set('demo', Date.now() - PLUGIN_WRITE_FLOOR_MS - 1000);
  grantApproval(dataDir, 'demo', 'write', { target: 'BVE', preview: '内容', uses: 1, ttlMs: 60_000 });
  const err = parse(await runTool(failing.registry, { bvid: 'BVE', text: '内容' }));
  assert.equal(err.error.includes('B 站接口挂了'), true);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BVE', preview: '内容' }).approved, true, '抛错后批准已退还');
});

test('聊天内拒绝：owner 回「拒绝」出队并回话', async () => {
  // 前面用例可能留了未消费的待批（比如"耗尽后再调"那条）：先清场，别让它抢走"最新一条"
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry } = makeRegistry({ ownerUin: '10001' });
  await runTool(registry, { bvid: 'BVRJ', text: '拒绝测试' });
  const chat = registry.handleOwnerApprovalText('拒绝', '10001');
  assert.equal(chat.handled, true);
  assert.match(chat.reply, /已拒绝/);
  assert.equal(listPendingApprovals(dataDir).some((item) => item.target === 'BVRJ'), false);
  const empty = registry.handleOwnerApprovalText('同意', '10001');
  assert.equal(empty.handled, true);
  assert.match(empty.reply, /没有待批准/);
});

test('目标缺失/非法：拒绝且不生成通配批准（旧实现会退化成 target:"" 万能通行证）', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry, calls } = makeRegistry({ behavior: {} });
  const missing = parse(await runTool(registry, { text: '内容' }));
  assert.equal(missing.needsApproval, false);
  assert.match(missing.error, /需要明确目标/);
  const bad = parse(await runTool(registry, { bvid: 'BV/../x', text: '内容' }));
  assert.match(bad.error, /目标不合法/);
  assert.equal(calls.length, 0, '两种情况都不该到达插件');
  assert.equal(listPendingApprovals(dataDir).length, 0, '不许生成"无目标"待批');
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'ANYTHING', preview: '内容' }).approved, false,
    '更不许出现任意目标都能命中的通行证');
});

test('目标超过 120 字符直接拒绝，不截断成前缀批准', () => {
  assert.equal(normalizeTarget('a'.repeat(120)), 'a'.repeat(120));
  assert.equal(normalizeTarget('a'.repeat(121)), null, '截断后校验会让批准只绑定前 120 字符');
});

test('待批请求也计入 60s 写间隔，不能连续刷待批', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry } = makeRegistry({ ownerUin: '10001' });
  registry.lastWriteAt.set('demo', 0);
  const first = parse(await runTool(registry, { bvid: 'BVQ', text: '内容' }));
  assert.equal(first.needsApproval, true);
  const second = parse(await runTool(registry, { bvid: 'BVQ', text: '内容' }));
  assert.match(second.error, /至少间隔/, '第二次应被写间隔挡住，而不是再生成一条待批');
  assert.equal(listPendingApprovals(dataDir).filter((item) => item.target === 'BVQ').length, 1);
});

test('卸载清理：清掉授权与待批，不影响其他插件', () => {
  grantApproval(dataDir, 'clear-a', 'write', { target: 'X', uses: 1, ttlMs: 60_000 });
  requestPendingApproval(dataDir, { pluginId: 'clear-a', action: 'write', target: 'Y' });
  grantApproval(dataDir, 'clear-b', 'write', { target: 'Z', uses: 1, ttlMs: 60_000 });
  clearPluginGrants(dataDir, 'clear-a');
  assert.equal(checkApproval(dataDir, 'clear-a', 'write', { target: 'X' }).approved, false);
  assert.equal(listPendingApprovals(dataDir).some((item) => item.pluginId === 'clear-a'), false);
  assert.equal(checkApproval(dataDir, 'clear-b', 'write', { target: 'Z' }).approved, true,
    '别的插件的授权不能被顺手清掉');
});

test('预览内容改变：旧批准失效，并为新内容单独生成待批', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry, calls } = makeRegistry({ ownerUin: '10001' });
  registry.lastWriteAt.set('demo', 0);
  await runTool(registry, { bvid: 'BVP', text: '好评' });
  const pending = listPendingApprovals(dataDir).find((item) => item.target === 'BVP');
  assert.ok(pending, '第一次请求生成待批');
  registry.handleOwnerApprovalText(`同意 ${pending.id}`, '10001');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.text, '好评', '自动重放的是批准时看到的那份正文');

  registry.lastWriteAt.set('demo', Date.now() - PLUGIN_WRITE_FLOOR_MS - 1000);
  const changed = parse(await runTool(registry, { bvid: 'BVP', text: '恶意内容' }));
  assert.equal(changed.needsApproval, true, '换了正文必须重新批准');
  const pending2 = listPendingApprovals(dataDir).find((item) => item.target === 'BVP' && item.preview === '恶意内容');
  assert.ok(pending2, '新内容要有自己的待批（不能复用旧文案的待批）');
});

test('一次调用给了多个不同目标：拒绝（否则批准对象与实际执行参数会错位）', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const tools = [{
    ...manifest().tools[0],
    parameters: { type: 'object', properties: { bvid: { type: 'string' }, mid: { type: 'string' } } },
    actionTarget: ['bvid', 'mid']
  }];
  const { registry, calls } = makeRegistry({ behavior: {}, manifestPatch: { tools } });
  const both = parse(await runTool(registry, { bvid: 'BV1', mid: '12345', text: '内容' }));
  assert.match(both.error, /多个不同的目标/);
  assert.equal(calls.length, 0, '有歧义的调用不该到达插件');

  // 只给一个目标时按它绑定（follow 用 mid、like 用 bvid 都走这条路）
  const one = parse(await runTool(registry, { mid: '12345', text: '内容' }));
  assert.equal(one.needsApproval, true);
  assert.equal(listPendingApprovals(dataDir).find((item) => item.target === '12345')?.action, 'write');
});

test('控制台直调不能绕过写门：声明 action 的登录工具也拒绝', async () => {
  const tools = [{
    name: 'login',
    description: '扫码登录',
    parameters: { type: 'object', properties: {} },
    action: 'start'
  }];
  const { registry } = makeRegistry({ manifestPatch: { tools } });
  await assert.rejects(
    () => registry.callConsoleTool('demo', 'login', { action: 'start' }),
    /不能从控制台直调/
  );
});

test('控制台直调带 channel=console，但不伪造 senderIsOwner（issue #21）', async () => {
  const tools = [{ name: 'login', description: '扫码登录', parameters: { type: 'object', properties: {} } }];
  const { registry, calls } = makeRegistry({ manifestPatch: { tools } });
  const result = await registry.callConsoleTool('demo', 'login', { action: 'poll' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].context, { channel: 'console', chatKey: '' },
    '控制台调用要带 channel，但不能伪造 senderIsOwner 提权');
});

test('超时/进程退出：结果未知 → 不退批准与配额，并明确不重试', async () => {
  const failing = makeRegistry({ behavior: { throw: 'request timeout', throwCode: 'E_TIMEOUT' } });
  failing.registry.lastWriteAt.set('demo', 0);
  grantApproval(dataDir, 'demo', 'write', { target: 'BVT', preview: '内容', uses: 1, ttlMs: 60_000 });
  const res = parse(await runTool(failing.registry, { bvid: 'BVT', text: '内容' }));
  assert.equal(res.uncertain, true);
  assert.match(res.error, /不要重试/);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BVT', preview: '内容' }).approved, false,
    '结果未知不能退还批准（否则模型重试 = 重复评论）');
  assert.equal(listPluginWrites(dataDir, 'demo')[0].outcome, 'unknown');
});

test('批准摘要绑定完整正文：前 300 字相同、尾巴不同也必须重新批准', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry, calls } = makeRegistry({ ownerUin: '10001' });
  registry.lastWriteAt.set('demo', 0);
  const head = 'a'.repeat(300);
  await runTool(registry, { bvid: 'BVL', text: head + '尾巴A' });
  const pending = listPendingApprovals(dataDir).find((item) => item.target === 'BVL');
  assert.ok(pending, '首次请求生成待批');
  assert.equal(pending.previewLength, 303, '待批要记录完整长度');
  registry.handleOwnerApprovalText(`同意 ${pending.id}`, '10001');
  await tick();
  assert.equal(calls.length, 1, '批准后自动重放的是待批时绑定的那份完整正文');
  assert.equal(calls[0].args.text, head + '尾巴A');

  // 正文只换后 5 个字：没有可用批准，必须生成新的待批（摘要绑定完整正文）
  registry.lastWriteAt.set('demo', Date.now() - PLUGIN_WRITE_FLOOR_MS - 1000);
  const changed = parse(await runTool(registry, { bvid: 'BVL', text: head + '尾巴B' }));
  assert.equal(changed.needsApproval, true, '只换后 5 个字也要重新批准');
  assert.ok(listPendingApprovals(dataDir).some((item) => item.target === 'BVL' && item.previewLength === 303));
});

test('engines.minVersion 在 reload/懒启动路径同样生效', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-engine-'));
  const pluginDir = path.join(root, 'demo');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    id: 'demo',
    apiVersion: 2,
    name: '引擎门槛演示',
    version: '1.0.0',
    entry: 'index.mjs',
    capabilities: ['tools'],
    engines: { minVersion: '9.0.0' },
    tools: [{ name: 'noop', description: '什么都不做', parameters: { type: 'object', properties: {} } }]
  }), 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), '', 'utf8');
  try {
    const registry = new PluginRegistry({
      root,
      dataDir: path.join(root, 'data'),
      log: () => {},
      getConfig: () => ({
        plugins: { enabled: true, enabledIds: ['demo'], lazy: true, requireIsolation: false }
      })
    });
    const started = await registry.start();
    assert.deepEqual(started.started, [], '启动阶段就该跳过不满足 engines 的插件');
    assert.equal(registry.hosts.size, 0);
    const reload = await registry.reload('demo');
    assert.equal(reload.ok, false, 'reload 不能绕过 engines');
    assert.match(String(reload.error || ''), /要求宿主/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('E_WRITE_UNKNOWN：结果未知同样不退批准与配额', async () => {
  const failing = makeRegistry({ behavior: { throw: 'B 站接口返回 HTTP 502', throwCode: 'E_WRITE_UNKNOWN' } });
  failing.registry.lastWriteAt.set('demo', 0);
  grantApproval(dataDir, 'demo', 'write', { target: 'BVU', preview: '内容', uses: 1, ttlMs: 60_000 });
  const res = parse(await runTool(failing.registry, { bvid: 'BVU', text: '内容' }));
  assert.equal(res.uncertain, true);
  assert.match(res.error, /不要重试/);
  assert.equal(checkApproval(dataDir, 'demo', 'write', { target: 'BVU', preview: '内容' }).approved, false);
  assert.equal(listPluginWrites(dataDir, 'demo')[0].outcome, 'unknown');
});

test('插件上下文带上 senderIsOwner：只给布尔值，不泄露 QQ 号', async () => {
  for (const leftover of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, leftover.id);
  const { registry, calls } = makeRegistry({ ownerUin: '10001' });
  registry.lastWriteAt.set('demo', 0);
  grantApproval(dataDir, 'demo', 'write', { target: 'BVO', preview: '内容', uses: 1, ttlMs: 60_000 });
  await runTool(registry, { bvid: 'BVO', text: '内容' }, {
    triggerEntries: [{ senderId: '10001', self: false }]
  });
  const mine = calls.at(-1)?.context || {};
  assert.equal(mine.senderIsOwner, true, JSON.stringify(mine));
  assert.equal(calls.length, 1, '调用应到达插件');
  assert.equal(JSON.stringify(mine).includes('10001'), false, '上下文不能带 owner 的 QQ 号');

  registry.lastWriteAt.set('demo', 0);
  grantApproval(dataDir, 'demo', 'write', { target: 'BVN', preview: '内容', uses: 1, ttlMs: 60_000 });
  await runTool(registry, { bvid: 'BVN', text: '内容' }, {
    triggerEntries: [{ senderId: '20002', self: false }]
  });
  assert.equal(calls.at(-1)?.context?.senderIsOwner, false);
});

const clearPending = () => {
  for (const item of listPendingApprovals(dataDir)) rejectPendingApproval(dataDir, item.id);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

test('待批通知：带编号与次数指令，送达后标记 notify.ok=true', async () => {
  clearPending();
  const sent = [];
  const ws = makeRegistry({
    ownerUin: '10001',
    sender: { sendTextBatch: async (_key, messages) => { sent.push(...messages); return { sent: [], failed: [] }; } }
  });
  await runTool(ws.registry, { bvid: 'BVNOTIFY', text: '内容' });
  const pending = listPendingApprovals(dataDir).find((item) => item.target === 'BVNOTIFY');
  assert.ok(pending, '应生成待批');
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(pending.id), '通知必须带待批编号');
  assert.match(sent[0], /同意 ap_.* 5/, '通知要写清带次数的批准写法');
  assert.equal(listPendingApprovals(dataDir).find((item) => item.id === pending.id)?.notify?.ok, true);
  clearPending();
});

test('待批通知：WS 私聊被拒时回落 OneBot HTTP', async () => {
  clearPending();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ status: 'ok', retcode: 0, data: { message_id: 9 } });
  };
  try {
    const ws = makeRegistry({
    ownerUin: '10001',
      sender: { sendTextBatch: async () => { throw new Error('private not allowed'); } },
      onebot: { httpUrl: 'http://127.0.0.1:3390', accessToken: 'token' }
    });
    await runTool(ws.registry, { bvid: 'BVHTTP', text: '内容' });
    const pending = listPendingApprovals(dataDir).find((item) => item.target === 'BVHTTP');
    assert.ok(pending);
    await tick();
    assert.equal(calls.length, 1, 'WS 失败后应改走 HTTP');
    assert.match(calls[0].url, /send_private_msg$/);
    assert.match(String(calls[0].body.message), new RegExp(pending.id));
    assert.equal(listPendingApprovals(dataDir).find((item) => item.id === pending.id)?.notify?.ok, true);
  } finally {
    globalThis.fetch = original;
    clearPending();
  }
});

test('待批通知两条都失败：控制台可见 notify.ok=false 与原因', async () => {
  clearPending();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const ws = makeRegistry({
    ownerUin: '10001',
      sender: { sendTextBatch: async () => { throw new Error('private not allowed'); } },
      onebot: { httpUrl: 'http://127.0.0.1:3390' }
    });
    await runTool(ws.registry, { bvid: 'BVFAIL', text: '内容' });
    const pending = listPendingApprovals(dataDir).find((item) => item.target === 'BVFAIL');
    assert.ok(pending);
    await tick();
    const after = listPendingApprovals(dataDir).find((item) => item.id === pending.id);
    assert.equal(after.notify?.ok, false);
    assert.match(String(after.notify?.error || ''), /WS 私聊|HTTP 直发/);
  } finally {
    globalThis.fetch = original;
    clearPending();
  }
});

test('QQ 指令：待批列表、多条必须带编号、同意 N 次', () => {
  clearPending();
  clearPluginGrants(dataDir, 'demo');
  const { registry } = makeRegistry({ ownerUin: '10001' });
  const p1 = requestPendingApproval(dataDir, { pluginId: 'demo', pluginName: '演示', action: 'write', label: '写', target: 'BV1', preview: 'a' });
  const p2 = requestPendingApproval(dataDir, { pluginId: 'demo', pluginName: '演示', action: 'write', label: '写', target: 'BV2', preview: 'b' });

  const listed = registry.handleOwnerApprovalText('待批', '10001');
  assert.match(listed.reply, new RegExp(p1.id));
  assert.match(listed.reply, new RegExp(p2.id), '待批列表要能一次看全编号');

  const ambiguous = registry.handleOwnerApprovalText('同意', '10001');
  assert.match(ambiguous.reply, /带编号/);
  assert.match(ambiguous.reply, new RegExp(p1.id), '多条待批时回复里要给出编号');

  const approved = registry.handleOwnerApprovalText(`同意 ${p1.id} 5`, '10001');
  assert.match(approved.reply, /5 次额度/);
  const status = grantsStatus(dataDir, 'demo', { approvals: manifest().approvals, quotas: manifest().quotas });
  assert.equal(status.approvals.write.usesLeft, 5, 'QQ 也应能一次批准多次');
  rejectPendingApproval(dataDir, p2.id);
});
