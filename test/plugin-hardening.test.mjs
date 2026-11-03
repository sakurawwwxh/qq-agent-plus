// P3 结构性加固的验收：网络真拦、资源上限、懒启动、发布者签名、撤回名单。
//
// 这一层的特点：**几乎每条都只有真起子进程才测得到**（隔离、内存、限频、懒启动的起停），
// 所以这里不 mock child_process（与本仓既有的 plugins.test.mjs 同一口径）。
// 平台差异如实处理：网络命名空间与 /proc 采样只有 Linux 有 —— Windows 上这些用例显式报
// diagnostic 跳过，并由服务器的 Linux 矩阵覆盖（不是"默默绿"）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(repo, 'test', 'fixtures', 'plugins');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-hardening-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { parsePluginManifest } = await import('../src/plugins/manifest.js');
const { PluginHost } = await import('../src/plugins/host.js');
const { PluginRegistry } = await import('../src/plugins/registry.js');
const {
  pluginLaunchSpec, networkIsolationSupported, isolationSummary, resetIsolationProbe
} = await import('../src/plugins/isolation.js');
const { installPlugin, verifyPluginSignature, sha256Of } = await import('../src/plugins/install.js');
const { packPluginDir } = await import('../src/plugins/pack.js');

const isLinux = process.platform === 'linux';
const manifestOf = (id) => {
  const dir = path.join(FIXTURES, id);
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.ok(parsed.ok, `夹具 ${id} 的 manifest 必须合法：${parsed.error}`);
  return parsed.manifest;
};
const waitFor = async (predicate, timeoutMs = 8000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
};

// ── 网络真拦 ────────────────────────────────────────────────────────────────
test('网络隔离：起来之后插件直连连不出去（ENETUNREACH），经宿主那条路照旧可用', async (t) => {
  if (!isLinux) { t.skip('本平台没有 unshare/netns'); return; }
  resetIsolationProbe();
  const probe = networkIsolationSupported();
  if (!probe.ok) { t.skip(`本机网络命名空间不可用（${probe.error}）`); return; }

  const host = new PluginHost({ manifest: manifestOf('netprobe'), dataDir, log: () => {}, getSettings: () => ({}) });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  assert.equal(host.netIsolated, true, '宿主状态里要如实标出"网络已隔离"');
  assert.equal(host.status().netIsolated, true);

  // 直连：隔离住的话网络栈根本不可达（ENETUNREACH）；没隔离会是 ECONNREFUSED（栈是通的）
  const direct = await host.callTool('direct_probe', { port: 1 });
  assert.equal(direct.code, 'ENETUNREACH', `插件不该能直连网络，实际 ${direct.code}`);

  // 经宿主：走 safe-fetch 的能力路照旧在（这条用例只证明"路还通着"，不让它真出去 ——
  // 指到本机地址，宿主自己会拦，返回的是"宿主拦下的"而不是"插件连不出去"）
  const viaHost = await host.callTool('via_host', { url: 'http://127.0.0.1:9/' });
  assert.equal(viaHost.ok, false);
  assert.match(viaHost.error, /内网|本机/, '宿主那条路仍然活着（插件只是自己出不去）');
});

test('启动方式：有网络隔离时套 unshare，没有时退回直接起 node', () => {
  // 结论是缓存的，而这条用例要**故意**换探测结果，所以每个分支前都清一次缓存
  //（Linux 上第一条用例已经把 {ok:true} 缓存进去了 —— 不清的话这里会拿到别人的结论）
  resetIsolationProbe();
  // platform 是注入点：这样"Windows 上没有 unshare"与"Linux 上套 unshare"两个分支在任何机器上都被跑到
  const unsupported = pluginLaunchSpec({
    pluginDir: FIXTURES, networkIsolation: true, spawn: () => ({ status: 1, stderr: 'no' }), platform: 'linux'
  });
  assert.equal(unsupported.command, process.execPath, '探测失败就别硬套，直接起 node');
  assert.equal(unsupported.netIsolated, false);

  const otherPlatform = pluginLaunchSpec({ pluginDir: FIXTURES, networkIsolation: true, spawn: () => ({ status: 0 }), platform: 'win32' });
  assert.equal(otherPlatform.command, process.execPath, '非 Linux 不套 unshare（连探都不探）');
  assert.equal(otherPlatform.netIsolated, false);

  resetIsolationProbe();
  const supported = pluginLaunchSpec({
    pluginDir: FIXTURES, networkIsolation: true, memoryMb: 128, spawn: () => ({ status: 0 }), platform: 'linux'
  });
  assert.equal(supported.command, 'unshare');
  assert.deepEqual(supported.args.slice(0, 3), ['--user', '--map-root-user', '--net']);
  assert.equal(supported.args[3], process.execPath, 'unshare 后面才是 node');
  assert.ok(supported.args.includes('--max-old-space-size=128'), '堆上限也在同一处加');
  assert.equal(supported.netIsolated, true);

  // 网络隔离关掉时不套 unshare（给了用户"我不要断网"的余地）
  const off = pluginLaunchSpec({ pluginDir: FIXTURES, networkIsolation: false, spawn: () => ({ status: 0 }), platform: 'linux' });
  assert.equal(off.command, process.execPath);
  assert.equal(off.netIsolated, false);

  // 只关 Node 权限模型（unconfined）不能把网络隔离一起关掉：两件事互相独立。
  resetIsolationProbe();
  const unconfinedNet = pluginLaunchSpec({
    pluginDir: FIXTURES, unconfined: true, networkIsolation: true,
    spawn: () => ({ status: 0 }), platform: 'linux'
  });
  assert.equal(unconfinedNet.command, 'unshare');
  assert.equal(unconfinedNet.netIsolated, true);
  assert.equal(unconfinedNet.args.includes('--permission'), false, 'unconfined 仍然不带 Node 权限参数');
});

test('网络隔离探测只跑一次（每次加载插件都起一个 unshare 子进程是浪费）', () => {
  resetIsolationProbe();
  let calls = 0;
  const counting = () => { calls += 1; return { status: 0, stderr: '' }; };
  networkIsolationSupported({ spawn: counting, force: true, platform: 'linux' });
  networkIsolationSupported({ spawn: counting, platform: 'linux' });
  networkIsolationSupported({ spawn: counting, platform: 'linux' });
  assert.equal(calls, 1, `探测次数应为 1，实际 ${calls}`);
  // 探测结论要**跟着注入的探测结果走**（原来断言 typeof === 'boolean' 是恒真的，等于没测）
  const okProbe = isolationSummary({ spawn: () => ({ status: 0 }), platform: 'linux' });
  assert.equal(okProbe.net, true, '探测成功时 summary.net 要是 true');
  resetIsolationProbe();
  const failProbe = isolationSummary({ spawn: () => ({ status: 1, stderr: 'nope' }), platform: 'linux' });
  assert.equal(failProbe.net, false, '探测失败时 summary.net 要是 false');
  assert.match(failProbe.netError, /nope/, '失败原因要带上（否则用户只看到一个 false）');
  resetIsolationProbe();
});

// ── 资源上限 ────────────────────────────────────────────────────────────────
test('调用限频：超过每分钟上限的调用被拒（带 E_RATE_LIMIT，且计数留痕）', async (t) => {
  let clock = 1_700_000_000_000;
  const host = new PluginHost({
    manifest: manifestOf('lazy-tools'), dataDir, log: () => {}, getSettings: () => ({}),
    limits: { callsPerMinute: 2 }, now: () => clock
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  assert.equal((await host.callTool('ping', {})).pong, true);
  assert.equal((await host.callTool('ping', {})).pong, true);
  await assert.rejects(() => host.callTool('ping', {}), (error) => error.code === 'E_RATE_LIMIT', '第三次要按限频拒掉');
  assert.equal(host.stats.rateLimited, 1);
  // 时间往前走一分钟，窗口清空后恢复
  clock += 61_000;
  assert.equal((await host.callTool('ping', {})).pong, true);
});

test('内存上限：超了就重启该插件进程（并留下计数），堆上限写在启动参数里', async (t) => {
  const spec = pluginLaunchSpec({ pluginDir: FIXTURES, memoryMb: 32, spawn: () => ({ status: 0 }) });
  assert.ok(spec.args.includes('--max-old-space-size=32'), 'V8 堆上限要在启动参数里');

  if (!isLinux) { t.skip('/proc 采样只有 Linux 有'); return; }
  const host = new PluginHost({
    manifest: manifestOf('lazy-tools'), dataDir, log: () => {}, getSettings: () => ({}),
    // 16MB 堆：对一个什么都不做的插件够用（不会启动就被 V8 带走）；常驻阈值是它的 1.5 倍 = 24MB，
    // 而 Node 进程的 RSS 光二进制就 30MB 以上 —— 于是必然撞上，正好验看门狗那条路
    limits: { memoryMb: 16 },
    timeouts: { heartbeatMs: 40, heartbeatMissLimit: 99 }
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  const killed = await waitFor(() => host.stats.memoryKills >= 1, 6000);
  assert.equal(killed, true, `内存超限应触发重启，实际 rssKb=${host.rssKb} memoryKills=${host.stats.memoryKills}`);
  assert.ok(host.rssKb > 24 * 1024, `采样到的常驻内存应当是真实值（>24MB），实际 ${host.rssKb}KB`);
  assert.ok(host.restarts >= 1, '重启要计数（控制台能看到）');
});

// ── 懒启动 ──────────────────────────────────────────────────────────────────
test('懒启动：纯工具插件先不起进程但**工具对模型可见**，第一次调用时才起', async (t) => {
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {},
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['lazy-tools'], lazy: true, idleMinutes: 30 } })
  });
  t.after(() => registry.stop());
  const started = await registry.start();
  assert.ok(started.started.includes('lazy-tools'));
  const host = registry.hosts.get('lazy-tools');
  assert.equal(host.state, 'idle', '懒启动：start() 之后进程不该已经起来');
  // 关键：工具必须已经交给模型（否则模型永远不会调它 → 进程永远不会起 → "懒启动"成了"永不启动"）
  const defs = registry.toolDefsFor();
  // 现在默认是**按需挂载**：只挂一个 meta 工具，它把可用的插件工具列在描述里（省提示词）
  assert.deepEqual(defs.map((d) => d.name), ['plugin_call']);
  assert.match(defs[0].description, /lazy-tools__ping/, '可用的插件工具要列在 meta 工具的描述里');

  const result = await defs[0].execute({}, { tool: 'lazy-tools__ping' });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content).pong, true);
  assert.equal(registry.hosts.get('lazy-tools').state, 'running', '调过之后进程应该在跑');
  assert.equal(registry.list().plugins.find((p) => p.id === 'lazy-tools').lazy, true, '列表里如实标成懒启动');
});

test('懒启动：空闲到点自动停进程；声明 observe/schedule 的插件**不**懒启动', async (t) => {
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {},
    scheduleIntervalMs: 30,                        // 让空闲清理跑得快一点
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['lazy-tools', 'good'], lazy: true, idleMinutes: 0.002 } })
  });
  t.after(() => registry.stop());
  await registry.start();
  assert.equal(registry.hosts.get('good').state, 'running', '有 schedule/observe 的插件要常驻（否则功能静默失效）');
  assert.equal(registry.list().plugins.find((p) => p.id === 'good').lazy, false);

  const defs = registry.toolDefsFor();
  await defs[0].execute({}, { tool: 'lazy-tools__ping' });   // 起进程
  assert.equal(registry.hosts.get('lazy-tools').state, 'running');
  const stopped = await waitFor(() => registry.hosts.get('lazy-tools').state === 'stopped', 6000);
  assert.equal(stopped, true, '空闲到点该停掉');
  assert.equal(registry.hosts.get('good').state, 'running', '常驻插件不许被顺手停掉');
  // 停了之后再调用要能自愈（重新起）
  assert.equal(JSON.parse((await defs[0].execute({}, { tool: 'lazy-tools__ping' })).content).pong, true);
});

// ── 并发与生命周期（审查抓到的：孤儿进程 / 在途调用被打断 / 停用后仍被拉起）──────
/** 假 host：不真起进程，但把 start/stop 的调用逐个记下来 —— 这些用例要验的是"谁被停过"。 */
function fakeHostFactory(created) {
  return (manifest, cfg = {}) => {
    const host = {
      id: manifest.id,
      manifest,
      limits: cfg.limits || {},     // 注册表算出来的资源上限（用例据此验非法值被换成了默认值）
      state: 'idle',
      startedAt: 0,
      lastError: '',
      pending: new Map(),          // 在途请求（空闲停的判据之一）
      async start() { await new Promise((resolve) => { setTimeout(resolve, 5); }); this.state = 'running'; this.startedAt = Date.now(); return true; },
      async stop() { await new Promise((resolve) => { setTimeout(resolve, 5); }); this.state = 'stopped'; },
      async callTool() { return { pong: true }; },
      async runSchedule() { return true; },
      observe() { return true; },
      status() { return { state: this.state, netIsolated: false, unconfined: false, rssKb: 0, limits: this.limits }; }
    };
    created.push(host);
    return host;
  };
}

test('并发重排（双击启用 / 启用后顺手保存设置）不会留下没人管的进程', async (t) => {
  const created = [];
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {}, hostFactory: fakeHostFactory(created),
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['good', 'lazy-tools'] } })
  });
  t.after(() => registry.stop());
  // 两次并发 reconfigure：这是最现实的触发路径（UI 不禁跨控件重复点）。原来 reconfigure 不走
  // 串行队列，两个 #stopImpl/#startImpl 交错会让某一代 host 既不在表里、也没人停它 ——
  // 那个进程会带着自己的心跳与崩溃重启逻辑一直活下去，还和表里那代抢同一份 plugin-data。
  await Promise.all([registry.reconfigure(), registry.reconfigure()]);
  const inTable = new Set([...registry.hosts.values()]);
  const orphans = created.filter((host) => !inTable.has(host) && host.state !== 'stopped');
  assert.deepEqual(orphans.map((host) => host.id), [],
    `每一个被换下去的 host 都必须已经停掉，否则它的进程会一直活着（created=${created.length}）`);
  assert.equal(registry.hosts.size, 2, '每个启用的插件在表里恰好一份');
});

test('注册表把并发/磁盘/总内存上限原样传给 host，非法值回落默认', async (t) => {
  const created = [];
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {}, hostFactory: fakeHostFactory(created),
    getConfig: () => ({
      plugins: {
        enabled: true,
        enabledIds: ['good'],
        limits: { memoryMb: 'bad', callsPerMinute: 0, concurrency: 3, diskMb: 512, totalMemoryMb: 256 }
      }
    })
  });
  t.after(() => registry.stop());
  await registry.start();
  assert.equal(created.length, 1);
  assert.equal(created[0].limits.memoryMb, 128, '非法内存值回落默认');
  assert.equal(created[0].limits.callsPerMinute, 120, '非法调用上限回落默认');
  assert.equal(created[0].limits.concurrency, 3, '并发上限不能被注册表吞掉');
  assert.equal(created[0].limits.diskMb, 512, '磁盘上限不能被注册表吞掉');
  assert.equal(created[0].limits.totalMemoryMb, 256);
});

test('空闲停：有在途调用的插件不下手（别把正在干活的进程收走）', async (t) => {
  const created = [];
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {}, hostFactory: fakeHostFactory(created),
    scheduleIntervalMs: 25,
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['lazy-tools'], lazy: true, idleMinutes: 0.001 } })
  });
  t.after(() => registry.stop());
  await registry.start();
  const host = registry.hosts.get('lazy-tools');
  await host.start();
  host.pending.set(1, {});                       // 假装有一次调用正在跑
  await new Promise((resolve) => setTimeout(resolve, 200));   // 让空闲清扫跑好几轮
  assert.equal(host.state, 'running', '有在途调用时不许被空闲停掉');
  host.pending.clear();
  const stopped = await waitFor(() => host.state === 'stopped', 3000);
  assert.equal(stopped, true, '调用结束、空闲到点后应该被停掉（这条同时证明"没在途时该停的还是会停"）');
});

test('连续崩溃被停用（failed）后：不再占着模型工具表，也不被一次调用顺手拉起', async (t) => {
  const created = [];
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {}, hostFactory: fakeHostFactory(created),
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['good', 'lazy-tools'] } })
  });
  t.after(() => registry.stop());
  await registry.start();
  const good = registry.hosts.get('good');
  assert.match(registry.toolDefsFor()[0].description, /good__echo/, '正常时工具要出现在 meta 清单里');
  good.state = 'failed';                          // 模拟"连续崩够次数已停用"
  assert.ok(!registry.toolDefsFor()[0].description.includes('good__echo'),
    '被停用的插件不该再出现在工具清单里（否则模型每调一次宿主就再 spawn 一次，"不再空转"就落空了）');
  assert.equal(JSON.parse((await registry.toolDefsFor()[0].execute({}, { tool: 'lazy-tools__ping' })).content).pong,
    true, '正常插件不受影响');
  // 显式重载能恢复（这是设计上留的恢复路径）
  await registry.reload('good');
  assert.equal(registry.hosts.get('good').state, 'running', '重载要能把停用的插件拉回来');
  assert.match(registry.toolDefsFor()[0].description, /good__echo/, '重载后工具回到清单');
});

test('工具挂载：默认按需（一个 meta 工具），配成 direct 时逐个挂（两种模式都覆盖）', async (t) => {
  const created = [];
  const mk = (toolMounting) => new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {}, hostFactory: fakeHostFactory(created),
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['lazy-tools', 'good'], toolMounting } })
  });
  const meta = mk(undefined);
  t.after(() => meta.stop());
  await meta.start();
  const metaDefs = meta.toolDefsFor();
  assert.equal(metaDefs.length, 1, '默认只挂一个 meta 工具');
  assert.equal(metaDefs[0].name, 'plugin_call');
  assert.match(metaDefs[0].description, /good__echo/);
  assert.match(metaDefs[0].description, /lazy-tools__ping/);
  // 传错工具名：要说清"没有这个"并把可用的列回来（模型据此自我纠正，而不是瞎猜参数）
  const miss = await metaDefs[0].execute({}, { tool: 'nope' });
  assert.equal(miss.isError, true);
  assert.match(miss.content, /没有这个插件工具/);
  assert.match(miss.content, /good__echo/, '可用清单要回给模型');

  const direct = mk('direct');
  t.after(() => direct.stop());
  await direct.start();
  const directNames = direct.toolDefsFor().map((def) => def.name);
  assert.ok(directNames.includes('good__echo') && directNames.includes('lazy-tools__ping'),
    `direct 模式要逐个挂（实际 ${directNames.join(', ')}）`);
  assert.ok(!directNames.includes('plugin_call'), 'direct 模式下不该出现 meta 工具');
  assert.ok(directNames.length > 2, 'good 夹具本身有多个工具，逐个挂就该多出来（这条同时说明它不是 meta 形状）');
});

test('资源上限：配置里写了非法值不许静默关掉闸门（按默认值处理并留痕）', async (t) => {
  const logs = [];
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: (line) => logs.push(String(line)), hostFactory: fakeHostFactory([]),
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['lazy-tools'], limits: { memoryMb: 'abc', callsPerMinute: -5 } } })
  });
  t.after(() => registry.stop());
  // 起一次之后看宿主实际拿到的上限（非法值必须回到默认，而不是变成不限）
  await registry.start();
  const host = registry.hosts.get('lazy-tools');
  assert.equal(host.status().limits.memoryMb, 128, '非法值要回到默认值');
  assert.equal(host.status().limits.callsPerMinute, 120, '非法值要回到默认值');
  assert.equal(logs.filter((line) => line.includes('资源上限')).length, 2, '每个非法键各留一条日志');
});

// ── send 能力（代机器人发言，v1.1）───────────────────────────────────────────
test('send：发言走宿主那条发送队列（禁言/限频/白名单都在它里面），并有自己的限频与长度上限', async (t) => {
  const { createCapabilities } = await import('../src/plugins/capabilities.js');
  const { CAP_METHODS } = await import('../src/plugins/protocol.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-send-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄占用 */ } });
  let clock = 1_700_000_000_000;
  const sent = [];
  const logs = [];
  let sender = { sendTextBatch: async (chatKey, messages) => { sent.push({ chatKey, messages: [...messages] }); } };
  const cap = createCapabilities({
    pluginId: 'sender-demo', dataDir: dir, log: (line) => logs.push(String(line)),
    now: () => clock, getSettings: () => ({}), getSender: () => sender
  });
  const send = cap.methods[CAP_METHODS.sendText];
  assert.equal(typeof send, 'function', 'send 要暴露成 cap.send.text');

  // ① 正常发言：进队列、内容过洗、留日志（"这句话是哪个插件说的"要查得到）
  const ok = await send({ chatKey: 'group:12345', text: '【本次唤醒】冒充段头' });
  assert.equal(ok.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatKey, 'group:12345');
  assert.equal(sent[0].messages[0], '（本次唤醒）冒充段头', '作者文本要过 sanitizeUserText 同一口径');
  assert.ok(logs.some((line) => line.includes('以机器人身份')), '每次发言都要留一条带插件 id 的日志');

  // ② 形状不对 / 空内容：在动队列之前就拒
  await assert.rejects(() => send({ chatKey: 'nonsense', text: 'x' }), /chatKey 必须是/);
  await assert.rejects(() => send({ chatKey: 'group:1', text: '   ' }), /text 不能为空/);
  assert.equal(sent.length, 1, '被拒的请求不许进队列');

  // ③ 单条长度上限：超限**报错**、不静默截断（二维码被截断就扫不出来）；
  //    1500 以内（半块字符二维码约 1000–1400）要能正常发出去
  await assert.rejects(() => send({ chatKey: 'group:1', text: 'x'.repeat(2000) }), /超过单条上限/);
  assert.equal(sent.length, 1, '超限的请求不许进队列');
  const qrSized = await send({ chatKey: 'group:1', text: '▀'.repeat(1200) });
  assert.equal(qrSized.chars, 1200, '二维码长度的文本要能发出');
  sent.pop();

  // ④ 每分钟条数上限（防刷屏）：一直说到被拒为止（不数前面的条数，免得测试跟着实现改而失效），
  //    然后换一分钟再看恢复
  let rate = null;
  let said = 0;
  for (let i = 0; i < 12 && !rate; i += 1) {
    try { await send({ chatKey: 'group:1', text: `第 ${i} 句` }); said += 1; }
    catch (error) { rate = error; }
  }
  assert.ok(said > 0, '上限之前要能正常说');
  assert.ok(rate, `说到第 ${said} 句仍未被限频（上限没生效？）`);
  assert.equal(rate.code, 'E_RATE');
  clock += 61_000;
  assert.equal((await send({ chatKey: 'group:1', text: '新的一分钟' })).ok, true);

  // ⑤ 宿主没有发送队列时**明确报错**，不假装发成功（fail-closed）
  sender = null;
  await assert.rejects(() => send({ chatKey: 'group:1', text: 'x' }), (error) => error.code === 'E_NO_SENDER');

  // ⑥ chatKey 必须收紧到"数字 id"：宽形状（`group:1:0` 这类）会让下游 split(':') 只取前两段把消息
  //    真发到群 1，而禁言预检拿整串（必失败 → 当未禁言）、每会话限频的桶键也是整串（换后缀就是新桶）
  //    —— 一道禁言、一道限频双双被绕。这里用"带后缀的整串"直接钉住它被拒。
  sender = { sendTextBatch: async (chatKey, messages) => { sent.push({ chatKey, messages }); return { ok: true }; } };
  const before = sent.length;
  await assert.rejects(() => send({ chatKey: 'group:1:0', text: 'x' }), /chatKey 必须是/);
  await assert.rejects(() => send({ chatKey: 'group:abc', text: 'x' }), /chatKey 必须是/);
  await assert.rejects(() => send({ chatKey: 'private:1:2', text: 'x' }), /chatKey 必须是/);
  assert.equal(sent.length, before, '形状不规范的 chatKey 不许进队列');
});

// ── 撤回名单 ────────────────────────────────────────────────────────────────
test('撤回名单：命中的插件不加载、不给工具，且**列表里标出来**（不是悄悄消失）', async (t) => {
  const cfg = { plugins: { enabled: true, enabledIds: ['good'], revoked: ['good'] } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  t.after(() => registry.stop());
  const started = await registry.start();
  assert.deepEqual(started.started, [], '撤回的插件不许加载');
  assert.deepEqual(registry.toolDefsFor(), []);
  const listed = registry.list().plugins.find((p) => p.id === 'good');
  assert.equal(listed.revoked, 'good', '列表里要能看出"它在撤回名单里"');
  assert.equal(listed.enabled, true, '授权清单没动 —— 撤回是另一道闸门，两件事分开表达');
});

test('撤回名单：id@版本 只撤那一个版本（发新版修复后老版本仍不许跑）', async (t) => {
  const cfg = { plugins: { enabled: true, enabledIds: ['good'], revoked: ['good@1.0.0'] } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  t.after(() => registry.stop());
  assert.deepEqual((await registry.start()).started, [], '夹具版本正好是 1.0.0，应被撤回');
  assert.equal(registry.list().plugins.find((p) => p.id === 'good').revoked, 'good@1.0.0');

  cfg.plugins.revoked = ['good@9.9.9'];            // 别的版本不受影响
  assert.deepEqual((await registry.reconfigure()).started, ['good']);
});

test('撤回名单：版本写法不同也要命中（1.0 / v1.0.0 / 1.0.0+build 都等于 1.0.0）', async (t) => {
  // 索引/配置是第三方内容，版本可能写成 1.0 或带构建元数据；按字符串精确比较时，
  // 这样一条撤回规则对已安装的 1.0.0 完全不起作用（2026-10-17 审查 P2）
  // 预发布版是**另一个版本**：撤 1.0.0-beta.1 不能误伤稳定的 1.0.0
  {
    const cfg = { plugins: { enabled: true, enabledIds: ['good'], revoked: ['good@1.0.0-beta.1'] } };
    const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
    t.after(() => registry.stop());
    assert.deepEqual((await registry.start()).started, ['good'], '撤预发布版不该误伤稳定版');
  }
  for (const rule of ['good@1.0', 'good@v1.0.0', 'good@1.0.0+build']) {
    const cfg = { plugins: { enabled: true, enabledIds: ['good'], revoked: [rule] } };
    const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
    t.after(() => registry.stop());
    assert.deepEqual((await registry.start()).started, [], `${rule} 应命中夹具的 1.0.0`);
  }
});

// ── 发布者签名 ──────────────────────────────────────────────────────────────
test('发布者签名：登记过公钥就必须验签通过才许装；没登记公钥照装但标"未验证"', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-sign-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });
  const source = path.join(repo, 'examples', 'plugins', 'weather');
  const packed = packPluginDir({ dir: source });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const good = crypto.sign(null, packed.buffer, privateKey).toString('base64');

  // ① 登记了公钥 + 签名对 → 装得上，来源记录里写明发布者与"已验证"
  const ok = await installPlugin({
    tarball: packed.buffer, id: packed.id, dataDir: dir, publisher: 'alice', signature: good,
    publishers: { alice: rawPub }, log: () => {}
  });
  assert.equal(ok.ok, true);
  const { readPluginInstallInfo } = await import('../src/plugins/install.js');
  const record = readPluginInstallInfo({ dataDir: dir, id: packed.id });
  assert.equal(record.publisher, 'alice');
  assert.equal(record.signatureVerified, true);

  // ② 包被改过（换一个字节）→ 签名对不上 → 拒绝安装
  const tampered = Buffer.from(packed.buffer);
  tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;
  await assert.rejects(
    () => installPlugin({ tarball: tampered, id: packed.id, dataDir: dir, publisher: 'alice', signature: good, publishers: { alice: rawPub }, log: () => {} }),
    /没通过验签/
  );
  // ③ 登记了公钥但没带签名 → 一样拒绝（fail-closed：登记公钥就是"我要求这个发布者签名"）
  await assert.rejects(
    () => installPlugin({ tarball: packed.buffer, id: packed.id, dataDir: dir, publisher: 'alice', publishers: { alice: rawPub }, log: () => {} }),
    /没通过验签/
  );
  // ④ 没登记公钥的发布者：照装，但如实标"未验证"（生态起步阶段不能把路堵死）
  const unverified = await installPlugin({
    tarball: packed.buffer, id: packed.id, dataDir: dir, publisher: 'bob', signature: good,
    publishers: { alice: rawPub }, log: () => {}
  });
  assert.equal(unverified.ok, true);
  assert.equal(readPluginInstallInfo({ dataDir: dir, id: packed.id }).signatureVerified, false);

  // ⑤ 公钥/签名的各种编码都要认（base64 / hex / PEM）
  assert.equal(verifyPluginSignature({ buffer: packed.buffer, signature: good, publicKey: rawPub }).ok, true);
  assert.equal(verifyPluginSignature({
    buffer: packed.buffer, signature: crypto.sign(null, packed.buffer, privateKey).toString('hex'),
    publicKey: Buffer.from(rawPub, 'base64').toString('hex')
  }).ok, true);
  assert.equal(verifyPluginSignature({
    buffer: packed.buffer, signature: good, publicKey: publicKey.export({ type: 'spki', format: 'pem' })
  }).ok, true);
});

test('签名脚本：--keygen 生成密钥对，签出来的名宿主认得（作者侧与宿主侧同一份实现）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-signcli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'key');
  const run = (args) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'plugin-sign.mjs'), ...args],
    { cwd: repo, encoding: 'utf8' });
  const generated = run(['--keygen', '--out', out]);
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  assert.ok(fs.existsSync(`${out}.key`) && fs.existsSync(`${out}.pub`), '私钥与公钥都要生成');
  if (!isLinux) assert.ok(true, '权限位只有 POSIX 有意义');
  else assert.equal(fs.statSync(`${out}.key`).mode & 0o777, 0o600, '私钥不能给别人读');

  // 包自己现打一个（不要依赖仓库里提交的产物：那些已经搬到独立索引仓库了，
  // 而且"本地现打 → 签名 → 验签"这条链路本来就不该依赖任何提交物）
  const pkg = path.join(dir, 'weather-1.0.0.tar.gz');
  fs.writeFileSync(pkg, packPluginDir({ dir: path.join(repo, 'examples', 'plugins', 'weather') }).buffer);
  const signed = run(['--key', `${out}.key`, '--pack', pkg]);
  assert.equal(signed.status, 0, signed.stdout + signed.stderr);
  const signature = /"signature": "([^"]+)"/.exec(signed.stdout)?.[1] || '';
  assert.ok(signature, `要打印可粘进索引的 signature：${signed.stdout}`);
  const pub = fs.readFileSync(`${out}.pub`, 'utf8').trim();

  const verified = run(['--key', `${out}.key`, '--pack', pkg, '--verify', '--signature', signature, '--pub', pub]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  // 换一个包来验：必须失败（别把"能验"写成"总是通过"）
  const wrong = run(['--key', `${out}.key`, '--pack', path.join(repo, 'package.json'), '--verify', '--signature', signature, '--pub', pub]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /对不上/);
  assert.equal(verifyPluginSignature({ buffer: fs.readFileSync(pkg), signature, publicKey: pub }).ok, true);
  assert.equal(sha256Of(fs.readFileSync(pkg)).length, 64);
});

test('模型侧工具名超过 64 字符时在 manifest 校验就拒绝', () => {
  const parsed = parsePluginManifest({
    id: 'a'.repeat(32),
    name: 'too-long-tool',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['tools'],
    tools: [{
      name: 'a'.repeat(31),
      description: 'x',
      parameters: { type: 'object', properties: {} }
    }]
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /64 字符上限/);
});
