// 插件宿主（src/plugins/）的验收用例。
//
// ⚠️ 这里**用真实子进程**，不 mock child_process：隔离、超时、崩溃重启这几条性质只有真起进程
// 才测得到 —— 把 child_process 换成桩，等于把被测的东西一起换掉了（本项目 2026-10 的既有教训：
// "测试自洽性"要求禁止读真实机器状态，但也不能把被测对象本身换成假货）。
// 隔离是否可用取决于本机 Node 有没有权限模型：这一条会在用例里显式断言，而不是默默跳过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugins-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { parsePluginManifest } = await import('../src/plugins/manifest.js');
const { createLineDecoder, encodeMessage } = await import('../src/plugins/protocol.js');
const { permissionFlagSupported, pluginNodeArgs, probeIsolation, isolationSummary, networkIsolationSupported, resetIsolationProbe } = await import('../src/plugins/isolation.js');
const { PluginHost } = await import('../src/plugins/host.js');
const { PluginRegistry } = await import('../src/plugins/registry.js');

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'plugins');
const fixtureManifest = (id) => {
  const dir = path.join(FIXTURES, id);
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.ok(parsed.ok, `夹具 ${id} 的 manifest 必须合法：${parsed.error}`);
  return parsed.manifest;
};

/** 等一个条件成立（有上限，别把用例写成靠 sleep 的赌运气）。 */
async function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

test('manifest 校验 fail-closed：坏形状逐一被拒，并给出可读原因', () => {
  const base = { id: 'demo', apiVersion: 1, name: '演示', version: '1.0.0', capabilities: ['tools'] };
  const dir = path.join(FIXTURES, 'good');
  const cases = [
    [{ ...base, id: 'Bad_Id' }, /id 只能是/],
    [{ ...base, apiVersion: 3 }, /apiVersion 不匹配/],
    [{ ...base, name: '' }, /name 不能为空/],
    [{ ...base, version: 'v1' }, /version 必须是/],
    [{ ...base, capabilities: [] }, /capabilities 必须是非空数组/],
    // `send` 在 v1.1 开了（插件能代机器人发言），所以它现在是**合法**能力；
    // 拿一个真不认识的来验白名单（换成 send 的话这条会变成假红）
    [{ ...base, capabilities: ['tools', 'telepathy'] }, /不认识的能力：telepathy/],
    [{ ...base, capabilities: ['tools', 'tools'] }, /重复/],
    // 目录穿越那条写成 path.join：指向上级目录的 entry，如果直接写成带引号的字符串
    // （点斜杠开头、点 mjs 结尾），会被 test/layout.test.mjs 的"相对 import 必须能解析"
    // 守卫当成 import 抓出来 —— 它扫的是字符串形状，不区分这是测试数据
    [{ ...base, entry: path.join('..', 'escape.mjs') }, /entry 必须落在插件目录内/],
    [{ ...base, capabilities: ['log'], tools: [{ name: 'echo', description: 'x' }] }, /必须在 capabilities 里带上 "tools"/],
    [{ ...base, tools: [{ name: 'Echo', description: 'x' }] }, /tools\[0\]\.name/],
    [{ ...base, tools: [{ name: 'echo' }] }, /description 不能为空/],
    [{ ...base, tools: [{ name: 'echo', description: 'x', parameters: { type: 'array' } }] }, /parameters 必须是/],
    [{ ...base, tools: [{ name: 'echo', description: 'x' }, { name: 'echo', description: 'y' }] }, /工具名重复/],
    // 入参 schema 无上限时，一个包可以让之后每一次模型请求都超长被拒（2026-10-17 审查 P2）
    [{ ...base, capabilities: ['tools'], tools: [{ name: 'echo', description: 'x', parameters: {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, { type: 'string' }]))
    } }] }, /properties 太多/],
    [{ ...base, capabilities: ['tools'], tools: [{ name: 'echo', description: 'x', parameters: {
      type: 'object',
      properties: { big: { type: 'string', description: 'x'.repeat(20000) } }
    } }] }, /parameters 太大/],
    [{ ...base, capabilities: ['schedule'], schedule: [{ name: 'tick', everyMs: 10 }] }, /everyMs 必须是/],
    [{ ...base, schedule: [{ name: 'tick', everyMs: 60000 }] }, /必须在 capabilities 里带上 "schedule"/],
    [{ ...base, capabilities: ['schedule'], schedule: Array.from({ length: 25 }, (_, i) => ({ name: `t${i}`, everyMs: 60000 })) }, /超过 24 条/],
    [{ ...base, capabilities: ['schedule'], schedule: [{ name: 'tick', everyMs: 60000 }, { name: 'tick', everyMs: 60000 }] }, /周期任务名重复/]
  ];
  for (const [raw, pattern] of cases) {
    const parsed = parsePluginManifest(raw, { dir });
    assert.equal(parsed.ok, false, `本该被拒却被接受：${JSON.stringify(raw).slice(0, 90)}`);
    assert.match(parsed.error, pattern, `拒载原因要说人话：${parsed.error}`);
  }
  // 正向：合法 manifest 归一化后字段齐备（entry 折成绝对路径、目录一并带上）
  const ok = parsePluginManifest({ ...base, tools: [{ name: 'echo', description: 'x' }] }, { dir });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.manifest.entry, path.join(dir, 'index.mjs'));
  assert.equal(ok.manifest.dir, dir);
  assert.deepEqual(ok.manifest.capabilities, ['tools']);
  assert.deepEqual(ok.manifest.tools.map((t) => t.name), ['echo']);
  assert.deepEqual(ok.manifest.schedule, []);
});

test('manifest：send 能力已被白名单接受（插件代机器人发言是 v1.1 的能力）', () => {
  const base = { id: 'demo', apiVersion: 1, name: '演示', version: '1.0.0' };
  const dir = path.join(FIXTURES, 'good');
  const parsed = parsePluginManifest({ ...base, capabilities: ['tools', 'send'] }, { dir });
  assert.equal(parsed.ok, true, `send 应当是合法能力：${parsed.error}`);
  assert.ok(parsed.manifest.capabilities.includes('send'));
});

test('协议：跨块的多字节字符不被切坏，坏行与超长行都不影响后续', () => {
  const messages = [];
  const parseErrors = [];
  const violations = [];
  const decoder = createLineDecoder({
    maxLineBytes: 64,
    onMessage: (m) => messages.push(m),
    onParseError: (line) => parseErrors.push(line),
    onViolation: (kind) => violations.push(kind)
  });
  const buf = Buffer.from(encodeMessage({ id: 1, method: 'callTool', params: { text: '中文参数' } }), 'utf8');
  const cut = buf.indexOf(Buffer.from('中', 'utf8')) + 2;      // 切在「中」的三个字节中间
  decoder.push(buf.subarray(0, cut));
  assert.equal(messages.length, 0, '半行不该被当成消息');
  decoder.push(buf.subarray(cut));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].params.text, '中文参数', '跨块的多字节字符必须原样还原');

  decoder.push(Buffer.from('{ 这不是 JSON }\n'));
  assert.equal(parseErrors.length, 1);
  decoder.push(Buffer.from('{"id":2,"result":null}\n'));
  assert.equal(messages.length, 2, '一行坏掉不该影响后面的行');
  decoder.push(Buffer.from('x'.repeat(200)));
  assert.deepEqual(violations, ['line-too-long'], '超长行要按违规处理（否则插件能把宿主内存灌满）');
});

test('隔离参数：只给插件自己目录的读权限，网络拦不住这件事要如实标出', () => {
  // 只断言"实现的口径"（例如 summary.net === false 这种写死的常量）是恒真的，改坏了也发现不了；
  // 这里只留真能失败的两条：参数形状 + 本机探测结论（2026-10-15 复审 P3-9）
  const args = pluginNodeArgs({ pluginDir: '/tmp/plug' });
  assert.ok(args.includes('--permission'));
  assert.ok(args.includes('--allow-fs-read=/tmp/plug'));
  assert.ok(!args.some((a) => a.startsWith('--allow-fs-write')), '插件不需要写权限：状态走 cap.storage');
  assert.ok(!args.some((a) => a.startsWith('--allow-child-process')), '子进程必须继续被拒');
  // 口径说明（控制台用）：支持的机器上 fs/子进程是真拦；网络这一项**随平台变**
  //（Linux 上用网络命名空间真拦住，Windows/macOS 拦不住）——所以断言"与实测结论一致"，
  // 而不是写死 false：写死的话，Linux 上隔离生效了反而报红（2026-10-16 服务器矩阵抓到）
  const summary = isolationSummary();
  const netProbe = networkIsolationSupported();
  assert.equal(summary.net, netProbe.ok, 'summary 必须如实反映本机的网络隔离能力');
  // 断言"拦不住时有原因"，而不是 typeof netError === 'string'（后者构造上恒真，等于没测）
  if (!summary.net) assert.ok(summary.netError, '拦不住时要给出原因，别只给一个 false');
  if (summary.net) assert.equal(summary.netError, '', '拦得住时不该留着原因');
  // 这里原来断言 isolationSummary().supported === permissionFlagSupported() —— 同一个函数被调两次
  // 自比较，当前实现下不可能失败。改成断言它**跟着探测结论走**（下面注入一个失败的探测再看）。
  assert.equal(typeof isolationSummary().supported, 'boolean');
  if (permissionFlagSupported()) {
    assert.equal(probeIsolation().ok, true, '本机应能跑起隔离参数（否则下面的用例全都无意义）');
  }
});

test('宿主：起进程、调工具、storage 落盘、observe/schedule 投递、日志、停机', async (t) => {
  const logs = [];
  const probePath = path.join(process.cwd(), 'package.json');
  const settings = { probePath, token: 'demo-token' };
  const host = new PluginHost({
    manifest: fixtureManifest('good'),
    dataDir,
    log: (...args) => logs.push(args.join(' ')),
    getSettings: () => settings
  });
  t.after(() => host.stop());

  assert.equal(await host.start(), true, `启动失败：${host.lastError}`);
  assert.equal(host.state, 'running');

  assert.deepEqual(await host.callTool('echo', { text: 'hi' }), { echo: { text: 'hi' } });
  assert.deepEqual(await host.callTool('settings', {}), { settings }, 'init 时要把插件自己的配置段交给它');
  assert.deepEqual(await host.callTool('remember', { value: 'v1' }), { saved: 'v1' });
  const storageFile = path.join(dataDir, 'plugin-data', 'good', 'storage.json');
  assert.equal(JSON.parse(fs.readFileSync(storageFile, 'utf8')).last, 'v1', '状态要落在宿主侧（插件自己没有写权限）');

  host.observe({ chatKey: 'group:1', text: '来自群里的消息' });
  assert.equal(await host.runSchedule('tick'), true);
  assert.deepEqual(await host.callTool('counters', {}), { seen: 1, ticks: 1 }, '观察与周期都要真的投递到');

  await host.callTool('log_probe', {});
  assert.ok(logs.some((line) => line.includes('来自插件的日志行')), `插件日志要带前缀进宿主日志：${logs.join(' | ')}`);

  await host.stop();
  assert.equal(host.state, 'stopped');
  // 重启后状态仍在（这是"插件数据不属于进程"的关键性质：崩溃重启不该丢状态）
  const again = new PluginHost({
    manifest: fixtureManifest('good'), dataDir, log: () => {}, getSettings: () => settings
  });
  t.after(() => again.stop());
  assert.equal(await again.start(), true, again.lastError);
  assert.deepEqual(await again.callTool('remember', { value: 'v2' }), { saved: 'v2' });
});

test('隔离是真的：读不到插件目录外的文件、起不了子进程、写不了文件、环境变量已被剥掉', async (t) => {
  if (!permissionFlagSupported()) { t.skip('没有 Node --permission 支持'); return; }
  const host = new PluginHost({
    manifest: fixtureManifest('good'),
    dataDir,
    log: () => {},
    getSettings: () => ({ probePath: path.join(process.cwd(), 'package.json') })
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  const probe = await host.callTool('probe_isolation', {});
  assert.equal(probe.readOutside, 'ERR_ACCESS_DENIED', `插件读到了插件目录外的文件：${JSON.stringify(probe)}`);
  assert.equal(probe.spawn, 'ERR_ACCESS_DENIED', '插件不该能起子进程');
  assert.equal(probe.write, 'ERR_ACCESS_DENIED', '插件不该能写文件');
  assert.equal(probe.envLeaked, false, '宿主必须剥掉环境变量（QQ_AGENT_DATA_DIR 不该可见）');
});

test('越权：没在 manifest 里声明的能力调用会被拒，并记在 stats.denied 上', async (t) => {
  const logs = [];
  const host = new PluginHost({
    manifest: fixtureManifest('escape'), dataDir: dataDir, log: (...args) => logs.push(args.join(' '))
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  await host.callTool('steal', {});
  // 夹具在工具里连调了两条没声明的能力：storage.set 与 **send.text**（代机器人发言 —— 最该守住的一条）
  assert.equal(await waitFor(() => host.stats.denied >= 2), true,
    `越权调用必须被记账（当前 ${host.stats.denied}）`);
  assert.ok(logs.some((line) => line.includes('越权调用')), '越权要留痕（控制台与日志里查得到）');
});

test('超时：永不返回的工具按超时结清，且不把插件判死', async (t) => {
  const host = new PluginHost({
    manifest: fixtureManifest('slow'), dataDir, log: () => {}, timeouts: { callTimeoutMs: 300 }
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  await assert.rejects(() => host.callTool('hang', {}), /超时/);
  assert.equal(host.stats.timeouts, 1);
  assert.equal(host.state, 'running', '一次超时只结清这次调用，不该把插件停掉');
});

test('崩溃：进程退出后自动重启，连续崩够次数就停用（不再空转重启）', async (t) => {
  const logs = [];
  const host = new PluginHost({
    manifest: fixtureManifest('crash'),
    dataDir,
    log: (...args) => logs.push(args.join(' ')),
    timeouts: { restartBackoffMs: [20, 20, 20], maxRestarts: 2, callTimeoutMs: 800 }
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);

  await assert.rejects(() => host.callTool('boom', {}), (error) => {
    assert.match(error.message, /退出/);
    assert.equal(error.code, 'E_PLUGIN_DOWN',
      '进程退出必须标成 E_PLUGIN_DOWN；否则 registry 会当确定失败退款，模型重试会重复写');
    return true;
  });
  assert.equal(await waitFor(() => host.state === 'running' && host.restarts === 1), true,
    `崩一次后应自动重启（state=${host.state}, restarts=${host.restarts}）`);

  await assert.rejects(() => host.callTool('boom', {}), /退出/);
  // 等"重启完成"而不是只等计数：restarts 在重启动作开始时就加了，此刻进程可能还没起来
  assert.equal(await waitFor(() => host.state === 'running' && host.restarts === 2), true,
    `第二次崩溃后也要回到 running（state=${host.state}, restarts=${host.restarts}）`);

  await assert.rejects(() => host.callTool('boom', {}), /退出/);
  assert.equal(await waitFor(() => host.state === 'failed'), true, `连续崩溃后应停用，实际 ${host.state}`);
  assert.ok(logs.some((line) => line.includes('已停用该插件')), `要说明白为什么停用：${logs.join(' | ')}`);
});

test('注册表：坏插件被报出来而不是拖垮启动；未启用时一个都不跑（默认拒）', async () => {
  let cfg = { plugins: { enabled: false, enabledIds: [], settings: {} } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  const found = registry.discover();
  const ids = found.map((item) => item.id).sort();
  // 清单是**枚举式**的（新加夹具要同步这里）：漏一个说明 discover 开始跳过某个目录，
  // 多一个说明它开始把不该当插件的东西当插件（比如宿主自己的 .backup-/.staging-）
  assert.deepEqual(ids, ['broken', 'crash', 'escape', 'good', 'lazy-tools', 'misnamed', 'netprobe', 'slow'],
    '每个目录都要在清单里（含 P3 加固用的 lazy-tools 与 netprobe）');
  const broken = found.find((item) => item.id === 'broken');
  assert.match(broken.error, /apiVersion 不匹配/, '坏 manifest 要给出原因，而不是消失不见');
  const misnamed = found.find((item) => item.id === 'misnamed');
  assert.match(misnamed.error, /必须与目录名一致/);

  // 没启用 → 没有工具、也没有观察投递
  assert.deepEqual(registry.toolDefsFor(), []);
  assert.equal(registry.observe({ chatKey: 'group:1', text: 'x' }), 0);
  const started = await registry.start();
  assert.deepEqual(started.started, []);
  assert.equal(started.skipped, 'disabled');
});

test('注册表：隔离不可用时 fail-closed（一个都不加载，并说明原因）', async (t) => {
  const logs = [];
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: (...args) => logs.push(args.join(' ')),
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['good'], settings: {} } }),
    probe: () => ({ ok: false, error: '测试注入：本机没有权限模型' })
  });
  // ⚠️ 清理必须挂在 t.after 上：断言失败时如果走不到 stop()，插件子进程会留在那儿，
  // 整轮测试会卡在事件循环上（不报错、不结束）—— 变异验证时正是这样把一个用例挂死的。
  t.after(() => registry.stop());
  const result = await registry.start();
  assert.deepEqual(result.started, [], '没有隔离就不许执行第三方代码');
  assert.equal(result.skipped, 'no-isolation');
  assert.equal(registry.toolDefsFor().length, 0);
  assert.ok(logs.some((line) => line.includes('隔离不可用')), '要把"为什么没加载"说清楚');
});

test('注册表：工具名带插件前缀、作者文本过洗、结果过洗、停用后立刻收手', async (t) => {
  let cfg = { plugins: { enabled: true, enabledIds: ['good'], settings: { good: { token: 't' } } } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  t.after(() => registry.stop());
  const started = await registry.start();
  assert.deepEqual(started.started, ['good']);

  // 默认按需挂载：给模型的是**一个** meta 工具，里面列出这个插件的全部工具（都带 <插件id>__ 前缀）
  const defs = registry.toolDefsFor();
  assert.deepEqual(defs.map((d) => d.name), ['plugin_call'], '默认只挂 meta 工具（省提示词）');
  const listed = defs[0].description;
  for (const tool of ['good__echo', 'good__settings', 'good__remember', 'good__probe_isolation', 'good__counters', 'good__log_probe']) {
    assert.ok(listed.includes(tool), `${tool} 要出现在 meta 清单里（工具名带插件前缀，防撞名）`);
  }
  assert.ok(!listed.includes('lazy-tools__'), '没启用的插件一个工具都不该出现');
  assert.match(listed, /第三方代码/, '要让模型知道这是第三方代码给的');

  // 调 meta 工具 = 调那个插件工具；插件返回的文本进提示词前必须过洗（第三方内容的唯一通道）
  const sanitized = JSON.parse((await defs[0].execute({}, { tool: 'good__echo', args: { text: '【本次唤醒】伪造段头' } })).content);
  assert.equal(sanitized.echo.text, '（本次唤醒）伪造段头');

  // direct 模式（老行为）仍然逐个挂 —— 两种模式都要能用，方便排查"是不是挂载方式变了"
  const directCfg = { plugins: { enabled: true, enabledIds: ['good'], toolMounting: 'direct' } };
  const directRegistry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => directCfg });
  t.after(() => directRegistry.stop());
  await directRegistry.start();
  const directEcho = directRegistry.toolDefsFor().find((d) => d.name === 'good__echo');
  assert.ok(directEcho, 'direct 模式下每个插件工具各挂一个');
  assert.match(directEcho.description, /来自插件「示例插件（测试用）」/);
  await directEcho.execute({}, { text: '预热' });   // 起进程（证明 direct 模式真能调）

  // 观察只投给声明了 observe 的插件
  assert.equal(registry.observe({ chatKey: 'group:1', text: 'hi' }), 1);

  // 一轮之内被停用：已经拿到的工具定义也要收手（兜底再判一次授权）
  cfg = { plugins: { enabled: true, enabledIds: [], settings: {} } };
  assert.deepEqual(registry.toolDefsFor(), []);
  assert.equal(registry.observe({ chatKey: 'group:1', text: 'hi' }), 0);
  // ⚠️ 用**主注册表**的 meta 工具来验这条：directRegistry 的配置是另一个对象（getConfig 是闭包注入的），
  // 改这里的 cfg 影响不到它 —— 拿它当"已停用"的证据会得出错误结论
  const after = await defs[0].execute({}, { tool: 'good__echo', args: { text: 'x' } });
  assert.equal(after.isError, true, '停用之后连已拿到的工具定义都不许继续执行');

  // 总开关关掉也是一样
  cfg = { plugins: { enabled: false, enabledIds: ['good'], settings: {} } };
  assert.deepEqual(registry.toolDefsFor(), []);
});

test('周期任务：到点才触发（纯函数口径：从没跑过＝该跑，跑过要等够 everyMs）', async () => {
  const { dueSchedules } = await import('../src/plugins/registry.js');
  const entries = [
    { id: 'good', running: true, schedule: [{ name: 'tick', everyMs: 60000 }] },
    { id: 'down', running: false, schedule: [{ name: 'tick', everyMs: 60000 }] }
  ];
  const state = new Map();
  const now = 1_000_000_000;
  assert.deepEqual(dueSchedules(entries, state, now).map((d) => d.key), ['good:tick'],
    '从没跑过 → 该跑；没在运行的插件不触发');
  state.set('good:tick', now);
  assert.deepEqual(dueSchedules(entries, state, now + 30_000), [], '没到周期不重复触发');
  assert.deepEqual(dueSchedules(entries, state, now + 60_000).map((d) => d.key), ['good:tick'], '到点再触发');
});

test('注册表：观察消息真的投给了声明 observe 的插件，停用后立刻不投', async (t) => {
  let cfg = { plugins: { enabled: true, enabledIds: ['good'], settings: {} } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  t.after(() => registry.stop());
  assert.deepEqual((await registry.start()).started, ['good']);
  assert.equal(registry.observe({ chatKey: 'group:1', group: true, mid: 'm1', text: '喂' }), 1);
  const host = registry.hosts.get('good');
  assert.deepEqual(await host.callTool('counters', {}), { seen: 1, ticks: 0 },
    '观察要真的送到插件里（不是只记了个数）');
  cfg = { plugins: { enabled: true, enabledIds: [], settings: {} } };
  assert.equal(registry.observe({ chatKey: 'group:1', group: true, mid: 'm2', text: '喂' }), 0);
  assert.deepEqual(await host.callTool('counters', {}), { seen: 1, ticks: 0 }, '停用后不该再投递');
});

test('注册表：stop 之后 reconfigure 不能把插件重新拉起来', async () => {
  const cfg = { plugins: { enabled: true, enabledIds: ['good'], settings: {} } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  await registry.start();
  assert.equal(registry.hosts.size, 1);
  await registry.stop();
  assert.equal(registry.hosts.size, 0);
  const result = await registry.reconfigure();
  assert.equal(result.skipped, 'stopped');
  assert.equal(registry.hosts.size, 0, '停服期间配置回调不能起子进程');
});

test('注册表：reconfigure 按新配置重排（改 enabledIds 后工具跟着变）', async (t) => {
  let cfg = { plugins: { enabled: true, enabledIds: [], settings: {} } };
  const registry = new PluginRegistry({ root: FIXTURES, dataDir, log: () => {}, getConfig: () => cfg });
  t.after(() => registry.stop());
  assert.deepEqual((await registry.start()).started, []);
  assert.equal(registry.toolDefsFor().length, 0);
  cfg = { plugins: { enabled: true, enabledIds: ['good'], settings: {} } };
  assert.deepEqual((await registry.reconfigure()).started, ['good'], '重排后按新授权清单起插件');
  assert.ok(registry.toolDefsFor().length > 0);
  cfg = { plugins: { enabled: false, enabledIds: ['good'], settings: {} } };
  await registry.reconfigure();
  assert.equal(registry.toolDefsFor().length, 0, '总开关关掉后重排应把插件也停掉');
});

/** 等一个**异步**条件成立（上面的 waitFor 只认同步谓词：把 async 函数传进去它会立刻返回 true）。 */
async function waitForAsync(predicate, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

test('周期任务：宿主定时器真的会把到点的任务推给插件，且不会重复推', async (t) => {
  // 把检查间隔压到 40ms 才好在测试里观察；manifest 的 everyMs 下限仍是 1 分钟，
  // 所以"第一次该触发、之后一分钟内不该再来一次"正好可以在这里钉住。
  const registry = new PluginRegistry({
    root: FIXTURES, dataDir, log: () => {},
    getConfig: () => ({ plugins: { enabled: true, enabledIds: ['good'], settings: {} } }),
    scheduleIntervalMs: 40
  });
  t.after(() => registry.stop());
  assert.deepEqual((await registry.start()).started, ['good']);
  const host = registry.hosts.get('good');
  assert.equal(await waitForAsync(async () => (await host.callTool('counters', {})).ticks >= 1, 3000), true,
    '到点后宿主该把 schedule 推下去（从没跑过＝立即算到点）');
  const after = await host.callTool('counters', {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  const later = await host.callTool('counters', {});
  assert.equal(later.ticks, after.ticks, '一分钟内不该重复触发（先记时间再执行，防重入）');
  assert.ok(registry.list().plugins.find((p) => p.id === 'good').manifest.schedule[0].lastRunAt > 0,
    '控制台要能看到"上次跑是什么时候"');
});

// 入站投递点接在 **落库之后、唤醒之前**（锚点：这段在 console 的事件处理里，单测拿不到 ——
// 与 settings 那批接线用例同一套做法：能锚的锚住，别让"接线掉了"全靠人眼）。
test('入站投递的接线：位置在唤醒之前、只投别人的消息、内容是最小集', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src', 'console', 'app.js'), 'utf8');
  const observeAt = app.indexOf('pluginRegistry.observe({');
  assert.ok(observeAt > 0, '入站要把消息投给插件');
  const wakeAt = app.indexOf('orchestrator.onIncoming(chatKey, stored)');
  assert.ok(wakeAt > 0 && observeAt < wakeAt, '投递要在唤醒之前（否则插件看到的消息已经进过模型了）');
  // 只投别人发的：自己发的不投（v1 插件发不了言，但 send 能力开了之后会形成自问自答的环）
  assert.match(app.slice(Math.max(0, observeAt - 200), observeAt), /if \(!isSelf\)/,
    '投递点要在 if (!isSelf) 里');
  // 内容是"已去重、已洗过"的最小集：内部字段（media/reply 等）不外发
  for (const field of ['mid: stored.mid', 'senderId: stored.senderId', 'text: stored.text']) {
    assert.ok(app.includes(field), `投递内容要包含 ${field}`);
  }
  assert.ok(!/pluginRegistry\.observe\(\{[^}]{0,400}media/.test(app), '不该把 media 等内部字段递给插件');
});

// 控制台那一侧：路由与页面接线的锚点（这些要通过真起服务器才测得到，与 settings 那批同一套做法）。
test('storage 能力的三个上限要真拦（单值 32KB / 总量 256KB / 每分钟 120 次，文档承诺过）', async () => {
  const { createCapabilities } = await import('../src/plugins/capabilities.js');
  let clock = 1_700_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-storage-'));
  const cap = createCapabilities({ pluginId: 'storage-probe', dataDir: dir, log: () => {}, now: () => clock, getSettings: () => ({}) });
  try {
    const set = cap.methods['cap.storage.set'];
    assert.equal(typeof set, 'function', 'capabilities 要暴露 cap.storage.set（名字对不上就整段白测）');
    const big = 'x'.repeat(33 * 1024);
    let tooBig = null;
    try { await set({ key: 'k', value: big }); } catch (error) { tooBig = error; }
    assert.ok(tooBig, '单个值超过 32KB 要拒');
    assert.equal(tooBig.code, 'E_TOO_BIG', `错误码要对（实际 ${tooBig.code}：${tooBig.message}）`);
    // 每分钟 120 次：写满 120 次之后第 121 次要被限频
    for (let i = 0; i < 120; i += 1) await set({ key: `k${i}`, value: 'v' });
    let tooFast = null;
    try { await set({ key: 'over', value: 'v' }); } catch (error) { tooFast = error; }
    assert.ok(tooFast, '每分钟写入次数要封顶');
    assert.equal(tooFast.code, 'E_RATE', `错误码要对（实际 ${tooFast.code}：${tooFast.message}）`);
    clock += 61_000;      // 换一分钟就恢复
    await set({ key: 'after', value: 'v' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('控制台接线：路由的守卫与设置页的分区都在（锚点）', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src', 'console', 'app.js'), 'utf8');
  // 插件路由已拆到 routes/plugins.js（2026-10-31 M2）：接线锚点按两处合并检查
  const routes = fs.readFileSync(path.join(process.cwd(), 'src', 'console', 'routes', 'plugins.js'), 'utf8');
  const pluginSrc = `${app}\n${routes}`;
  for (const route of ['/api/plugins', '/api/plugins/index', '/api/plugins/master',
    '/api/plugins/toggle', '/api/plugins/reload', '/api/plugins/install', '/api/plugins/uninstall']) {
    assert.ok(pluginSrc.includes(`'${route}'`), `缺少路由 ${route}`);
  }
  // 卸载是破坏性操作：必须有 confirm 门槛（与全站口径一致）
  assert.match(pluginSrc, /卸载插件需要 body\.confirm === true/);
  // enabledIds 是**数组**：deepMerge 对数组本来就是整体替换 —— 写成 { __replace__: [...] } 会被
  // 静默忽略（那个约定只认对象），于是"启用"永远写不进去（2026-10-15 复审 P1-1，实测复现过）
  assert.match(pluginSrc, /updateConfig\(\{ plugins: \{ enabledIds: next \} \}\)/);
  assert.ok(!pluginSrc.includes('enabledIds: { __replace__'), '授权清单不该再用 __replace__（数组是整体替换）');
  // 从索引装时以索引里的地址与 sha256 为准（不信请求体里那份）。
  // 字段名是归一化后的 `url`：索引里 downloadUrl / tarball / url 三种叫法都归到它
  //（2026-10-16 修正 —— 此前锚点写的是 `hit.tarball`，而 plugin-pack 产出的条目用的是 downloadUrl，
  //  照着文档做出来的条目会被静默跳过；锚点把旧字段名焊死了，所以这里改成盯归一化后的名字）
  assert.match(pluginSrc, /url = hit\.url;/);
  assert.match(pluginSrc, /sha256 = hit\.sha256;/);
  // 索引里标了"本机装不了"的条目（apiVersion / minVersion 对不上）要在动手前拦住并说清原因
  assert.match(pluginSrc, /if \(hit\.compatible === false\)/);
  assert.match(pluginSrc, /这个插件在本机装不了/);
  // 插件包下载不能继承 security.allowPrivateImageHosts 的内网例外（2026-10-31 复审 P2）
  assert.match(routes, /safeFetchBinary\([^)]*allowPrivate:\s*false/,
    '插件包下载必须显式 allowPrivate:false，图片例外只属于图片');
  // 启停/装卸都要重排（否则"点了没反应"）。只数路由模块：app.js 自己的 4 处
  //（索引清空/撤回变化/定时刷新/启动收口）和插件动作无关，拼起来数会让这条断言失效。
  assert.ok((routes.match(/pluginRegistry\.reconfigure\(\)/g) || []).length >= 11, '各动作后都要重排');

  // 2026-10-16：插件页从「设置 → 插件」搬到左侧顶层「插件」。两条锚点跟着改口径：
  // 入口在主侧栏（index.html 的 tab），内容容器是 index.html 里的静态节点（委托只绑一次）。
  const indexSrc = fs.readFileSync(path.join(process.cwd(), 'ui', 'index.html'), 'utf8');
  assert.ok(indexSrc.includes('data-tab="plugins"'), '主导航要有「插件」入口');
  assert.ok(indexSrc.includes('id="plugins-page"'), '插件页的容器要在（静态节点，委托挂它）');
  const settings = fs.readFileSync(path.join(process.cwd(), 'ui', 'pages', 'settings.js'), 'utf8');
  assert.ok(!settings.includes("'plugins'"), '设置里不该再留一份插件分区（两处各维护一份必然分叉）');
  const page = fs.readFileSync(path.join(process.cwd(), 'ui', 'pages', 'plugins.js'), 'utf8');
  assert.ok(page.includes('id="plugins-head"'), '页面要有自己的锚点 id');
  assert.ok(page.includes('第三方代码'), '信任声明要出现在界面上（不能只写在文档里）');
  assert.ok(page.includes('拦不住网络'), '如实说明拦不住网络（Node 权限模型不管网络）');
  assert.ok(page.includes('if (delegationBound) return;'), '委托只能绑一次（#plugins-page 长期存在，重绑会一次点击发两次请求）');
  // 界面要回答"这是从哪来的"（来源记录）与"为什么装不了 / 为什么少了一条"——
  // 这两件事只在日志里说等于没说（用户不会去看日志）
  assert.ok(page.includes('来源：'), '已安装列表要显示来源记录');
  assert.ok(page.includes('本机装不了'), '装不了的条目要标出来（而不是只留一个点不动的按钮）');
  assert.ok(page.includes('被跳过'), '被跳过的条目与原因要列出来');
  // 手动填地址（索引里没有的插件）：入口要在，且 sha256 形状当场校验（别等服务端报错）
  assert.ok(page.includes('data-plugin-action="install-url"'), '手动安装的入口要在');
  assert.ok(page.includes('sha256 要填 64 位十六进制'), '地址与 sha256 要在前端先校验一遍');
  // P4 市场侧：搜索框、标签筛选、索引里有更新版本时的升级入口
  assert.ok(page.includes('id="plugins-search"'), '要能搜插件');
  assert.ok(page.includes('data-plugin-tag'), '标签筛选要在');
  assert.ok(page.includes('data-plugin-action="upgrade"'), '索引里有新版本时要给升级入口');
  // 撤回的已装插件必须有**卸载**入口：撤回的不给启停/回退是对的（它不会加载），但不给卸载
  // 就只剩"上服务器手删目录"这条路（2026-10-16 审查 P2-2）
  assert.ok(/if \(installed\) acts\.push\(\['danger', 'uninstall', '卸载'\]\);/.test(page),
    '卸载不能跟着"非撤回"一起被挡掉');
  // 详情页：主区必须切成**单列**（只隐藏分面栏不行 —— 它是网格第一项，一消失主区就落到那 190px 列里，
  // 详情页整块被挤成 190px 宽，2026-10-16 用户实测"内容全挤一块"就是这个）。
  assert.ok(page.includes("classList.add('is-detail')") && page.includes("classList.remove('is-detail')"),
    '打开详情要切单列、关掉要切回来');
  const css = fs.readFileSync(path.join(process.cwd(), 'ui', 'style.css'), 'utf8');
  assert.ok(/\.plugin-layout\.is-detail\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
    'CSS 要有单列态（否则切了类也没用）');
  assert.ok(page.includes('id="plugins-file"'), '要有从本地文件安装的入口（别人发我一个包怎么装）');
  assert.ok(page.includes('data-plugin-action="install-file"'), '文件安装的按钮要在');
  assert.ok(page.includes('id="plugins-file-install" data-plugin-action="install-file" disabled'), '没选文件时按钮要禁用');
  assert.ok(page.includes('compareVersion'), '版本比较要自己实现（不引依赖）');
  const html = fs.readFileSync(path.join(process.cwd(), 'ui', 'index.html'), 'utf8');
  assert.ok(html.includes('/pages/plugins.js'), '新页面模块要在 index.html 里加载');
});

test('官方插件：三个示例的 manifest 都合法，且都**不自己发请求**（必须经宿主）', () => {
  for (const id of ['gh-activity', 'weather']) {
    const dir = path.join(process.cwd(), 'examples', 'plugins', id);
    const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
    assert.equal(parsed.ok, true, `${id} 的 manifest 必须合法：${parsed.error}`);
    assert.ok(parsed.manifest.capabilities.includes('http'), `${id} 要联网就得声明 http 能力`);
    const src = fs.readFileSync(path.join(dir, 'index.mjs'), 'utf8');
    // 不自己发请求：走宿主那条路才有内网拦截/体积上限/超时/审计。裸 fetch/axios/http 一律不许出现在
    // 官方插件里（这条也顺带挡住"作者忘了声明 http 却直接 fetch"的示范效应）
    assert.ok(!/fetch\s*\(/.test(src), `${id} 不许自己 fetch`);
    assert.ok(!/require\(['"]https?['"]\)|from ['"]node:https?['"]/.test(src), `${id} 不许直接开 http/https`);
    assert.ok(src.includes('cap.http.request'), `${id} 的请求要走 cap.http.request`);
  }
});

test('官方插件：输入坏了要在**发请求之前**报错（不拿坏参数去打上游）', async (t) => {
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-official-plugins-'));
  t.after(() => { try { fs.rmSync(dataDir2, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });
  const { PluginHost } = await import('../src/plugins/host.js');
  const dir = path.join(process.cwd(), 'examples', 'plugins', 'gh-activity');
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  const host = new PluginHost({ manifest: parsed.manifest, dataDir: dataDir2, log: () => {}, getSettings: () => ({}) });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  // 仓库名不合法：本地就能判掉，不该去问 GitHub。
  // 注意口径：插件用"结果里的 error 字段"如实报错（不是抛异常）—— 见 docs/PLUGINS.md 的
  // "处理不了就如实报错"，模型与用户都靠这个字段判断，空结果会被当成"查到了但没有"
  for (const repo of ['这不是仓库', '']) {
    const bad = await host.callTool('repo_activity', { repo });
    assert.match(String(bad?.error || ''), /owner\/repo/, `坏参数要报错，实际 ${JSON.stringify(bad)}`);
  }
  // 不存在的工具是协议层的错：宿主按失败抛出来
  await assert.rejects(() => host.callTool('nope', {}), /没有这个工具/);
});

test('示例插件（examples/plugins/hot-topics）真能跑：manifest 合法、工具能调、网络走宿主那道守卫', async (t) => {
  // 挂 hot-topics 而不是别的示例：它的上游地址**可配置**（plugins.settings.hot-topics.v2exUrl），
  // 因此能把请求指到内网来验证宿主那道守卫 —— 这条用例要的正是这个（weather 的接口地址写死在代码里，
  // 验不了"插件不是自己发请求"）。既验了守卫真的在，又不碰真网络。
  const dir = path.join(process.cwd(), 'examples', 'plugins', 'hot-topics');
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.equal(parsed.ok, true, `示例插件的 manifest 必须合法：${parsed.error}`);
  const host = new PluginHost({
    manifest: parsed.manifest,
    dataDir,
    log: () => {},
    getSettings: () => ({ v2exUrl: 'http://127.0.0.1:9/hot.json' })
  });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  await assert.rejects(
    () => host.callTool('list', { source: 'v2ex' }),
    /内网|本机/,
    '内网地址必须被宿主侧的网络守卫拦下（插件拿不到裸 fetch 能力）'
  );
  // 坏参数在**发请求之前**就报错（不拿坏参数去打上游）
  const bad = await host.callTool('list', { source: 'nonsense' });
  assert.match(String(bad?.error ?? ''), /不认识的来源|v2ex|hn/, '来源写错要给可读的错误');
});

test('P1-1 回归：授权清单能真的存下去（数组直接传，不走 __replace__）', async () => {
  const { updateConfig, getConfig } = await import('../src/core/config.js');
  updateConfig({ plugins: { enabledIds: ['demo'] } });
  assert.deepEqual(getConfig().plugins.enabledIds, ['demo'], '启用要能写进配置（此前 __replace__ 数组被静默忽略）');
  updateConfig({ plugins: { enabledIds: ['other'] } });
  assert.deepEqual(getConfig().plugins.enabledIds, ['other'], '数组是整体替换（停用要能删掉）');
  updateConfig({ plugins: { enabledIds: [] } });
});

test('P1-2 回归：宿主内部目录（.staging-/.backup-/.removed-）不算插件，也不该让巡检报红', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-internal-'));
  const root = path.join(dir, 'plugins');
  fs.mkdirSync(path.join(root, '.backup-demo-123'), { recursive: true });
  fs.writeFileSync(path.join(root, '.backup-demo-123', 'plugin.json'), JSON.stringify({
    id: 'demo', apiVersion: 1, name: '旧版', version: '0.9.0', capabilities: ['tools']
  }));
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo', 'plugin.json'), JSON.stringify({
    id: 'demo', apiVersion: 1, name: '演示', version: '1.0.0', capabilities: ['tools']
  }));
  const registry = new PluginRegistry({ root, dataDir: dir, log: () => {}, getConfig: () => ({ plugins: { enabled: true, enabledIds: [] } }) });
  assert.deepEqual(registry.discover().map((item) => item.id), ['demo'], '内部目录不该出现在插件清单里');
  assert.deepEqual(registry.list().plugins.map((item) => item.id), ['demo'], '控制台列表里也不该有幽灵行');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P2-2 回归：带路径穿越的 id 在写盘之前就被拒（staging 目录名不能带出插件目录）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-evil-id-'));
  const { buildTar } = await import('./helpers/tar.mjs');
  const { installPlugin } = await import('../src/plugins/install.js');
  const tar = buildTar([
    { name: 'plugin.json', data: JSON.stringify({ id: 'demo', apiVersion: 1, name: '演示', version: '1.0.0', capabilities: ['tools'] }) },
    { name: 'index.mjs', data: 'export const ok = 1;' }
  ]);
  for (const evil of [['..', '..', 'evil'].join('/'), 'demo/../evil', 'DEMO']) {
    await assert.rejects(
      () => installPlugin({ tarball: tar, id: evil, dataDir: dir }),
      // 认**错误码**而不是文案：E_BAD_ID 只在"写盘之前"那条分支上；用文案会让"校验被挪到解包之后"
      // 这种改动照样绿（后面那条 id 不一致的检查文案相同，但它已经发生在解包之后了）
      (error) => error?.code === 'E_BAD_ID',
      `id=${evil} 必须在建目录之前被拒`
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plugins')), [], '拒装之后插件目录里不该多出任何东西');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P2-3 回归：requireIsolation 是**真**开关（探测失败时默认拒载，明确关掉才降级并标 unconfined）', async (t) => {
  // ⚠️ 这条原来写的是 `if (permissionFlagSupported()) return;` —— 本仓 engines 要求 >= 22.19，
  // 那些 Node 上 `--permission` 都存在，于是整段 body 永远不执行：名字像回归、断言像回归、其实空跑即绿。
  // 改成**注入一个"隔离不可用"的探测**（spawnSyncImpl：--check 照常通过、探测一律失败），
  // 两个分支在任何机器上都真跑。
  const noIsolationSpawn = (cmd, args) => (args.includes('--check')
    ? { status: 0, stdout: '', stderr: '' }
    : { status: 1, stdout: '', stderr: '注入：本机没有权限模型' });

  // 探测结论是**按插件目录缓存的**：本文件前面已经有用例探过这个夹具目录（结论是"能用"），
  // 不清缓存的话注入的失败探测根本不会被调用
  resetIsolationProbe();
  // 默认（requireIsolation: true）：探测失败就**拒载**，一个字节的第三方代码都不执行
  const strict = new PluginHost({
    manifest: fixtureManifest('good'), dataDir, log: () => {}, spawnSyncImpl: noIsolationSpawn,
    getSettings: () => ({})
  });
  t.after(() => strict.stop());
  assert.equal(await strict.start(), false, '没有隔离时默认必须拒载');
  assert.match(strict.lastError, /隔离/, `要说清为什么没跑：${strict.lastError}`);

  // 明确关掉 requireIsolation：照常起，但状态里如实标 unconfined（控制台与巡检都靠它）
  resetIsolationProbe();
  const loose = new PluginHost({
    manifest: fixtureManifest('good'), dataDir, log: () => {}, spawnSyncImpl: noIsolationSpawn,
    requireIsolation: false, getSettings: () => ({})
  });
  t.after(() => loose.stop());
  assert.equal(await loose.start(), true, loose.lastError);
  assert.equal(loose.unconfined, true, '降级运行时状态里必须标出来（控制台要显示给用户）');
  assert.equal(loose.status().unconfined, true, 'status() 也要带（控制台读的是它）');
  // 降级路径也要真能用：工具照常调得动（否则"关掉隔离就能跑"是假的）
  assert.equal((await loose.callTool('echo', { text: '降级' })).echo.text, '降级');   // 夹具的 echo 原样回显入参
});

test('P2-4 回归：隔离探测按**插件目录**分别做（缓存不许把一个目录的结论套给另一个）', async (t) => {
  const { probeIsolation, resetIsolationProbe, permissionFlagSupported } = await import('../src/plugins/isolation.js');
  if (!permissionFlagSupported()) { t.skip('没有 Node --permission 支持'); return; }
  resetIsolationProbe();
  const calls = [];
  // 注入一个"只对坏目录失败"的假 spawn：这样"缓存是否带目录键"就变成了可观测的行为差异
  const fakeSpawn = (_node, args) => {
    calls.push(args.join(' '));
    const bad = args.some((arg) => arg.includes('bad-dir'));
    return { status: bad ? 1 : 0, stderr: bad ? 'bad option' : '', error: null };
  };
  assert.equal(probeIsolation({ pluginDir: 'good-dir', spawn: fakeSpawn }).ok, true);
  assert.equal(calls.length, 1, '第一个目录要真的探一次');
  const second = probeIsolation({ pluginDir: 'bad-dir', spawn: fakeSpawn });
  assert.ok(calls.some((line) => line.includes('bad-dir')), '换了目录必须真的重新探（共用缓存会把好目录的结论套给坏目录）');
  assert.equal(second.ok, false, '坏目录要如实报不可用');
  assert.match(second.error, /bad option/, '要把子进程的原话带出来，不然排查只能靠猜');
  resetIsolationProbe();
});
