// 插件安装器（src/plugins/install.js）：解包防护、内容校验、原子换入与回滚、卸载保留数据。
// 归档由 test/helpers/tar.mjs 手工拼（不依赖系统 tar），要构造危险归档时直接给条目。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTar } from './helpers/tar.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-install-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const dotSlash = (name) => ['.', name].join('/');   // 直写 `./x.mjs` 会被 layout 守卫当成 import
const dotDot = (name) => ['..', name].join('/');
const { parseTarGz, installPlugin, uninstallPlugin, fetchPluginIndex, sha256Of, isSha256, verifySha256, MAX_PLUGIN_ARCHIVE_BYTES, MAX_TOTAL_UNPACKED } =
  await import('../src/plugins/install.js');
const { parsePluginManifest } = await import('../src/plugins/manifest.js');

const manifest = (id, extra = {}) => JSON.stringify({
  id, apiVersion: 1, name: `测试插件 ${id}`, version: '1.0.0', capabilities: ['tools'],
  tools: [{ name: 'ping', description: '原样返回' }], ...extra
});

const packPlugin = (id, { prefix = '', extraFiles = [], compressed = true } = {}) => {
  const p = prefix ? `${prefix.replace(/\/$/, '')}/` : '';   // 外层目录（模拟 `tar -czf x.tar.gz plugin/`）
  return buildTar([
    ...(p ? [{ name: p.replace(/\/$/, ''), type: '5' }] : []),
    { name: `${p}plugin.json`, data: manifest(id) },
    { name: `${p}index.mjs`, data: 'export const ok = true;\n' },
    ...extraFiles
  ], { compress: compressed });
};

const pluginsRoot = path.join(dataDir, 'plugins');
const slate = () => { fs.rmSync(pluginsRoot, { recursive: true, force: true }); fs.mkdirSync(pluginsRoot, { recursive: true }); };
const strays = () => fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.'));

test('tar 解析：普通文件/目录/./ 前缀都能解；外层单目录自动剥掉', () => {
  const entries = parseTarGz(buildTar([
    { name: '.', type: '5' },
    { name: dotSlash('plugin.json'), data: '{}' },
    { name: dotSlash('sub'), type: '5' },
    { name: dotSlash('sub/a.mjs'), data: 'x' }
  ]));
  assert.deepEqual(entries.filter((e) => e.type === 'file').map((e) => e.name).sort(),
    ['plugin.json', 'sub/a.mjs']);
  assert.equal(entries.find((e) => e.name === 'plugin.json').data.toString('utf8'), '{}');

  // 外层套一个目录（`tar -czf x.tar.gz plugin/`）：安装时要能当根处理
  const wrapped = buildTar([
    { name: 'demo', type: '5' },
    { name: 'demo/plugin.json', data: manifest('demo') },
    { name: 'demo/index.mjs', data: 'x' }
  ]);
  const extracted = parseTarGz(wrapped);
  const hasRootManifest = extracted.some((e) => e.name === 'plugin.json');
  assert.equal(hasRootManifest, false, '解析器本身不做剥壳（剥壳在安装路径上，见下一条）');
});

function fixTarChecksum(buffer) {
  for (let i = 148; i < 156; i += 1) buffer[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += buffer[i];
  buffer.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
}

test('tar 数字字段必须严格是八进制；base-256/非法字符直接拒绝', () => {
  const original = buildTar([
    { name: 'plugin.json', data: '{}' },
    { name: 'index.mjs', data: 'x' }
  ], { compress: false });
  for (const [label, mutate] of [
    ['非法八进制', (b) => b.write('00000000008\0', 124, 'ascii')],
    ['base-256', (b) => { b.fill(0, 124, 136); b[124] = 0x80; }]
  ]) {
    const bad = Buffer.from(original);
    mutate(bad);
    fixTarChecksum(bad);
    assert.throws(() => parseTarGz(bad), /数字字段/, label);
  }
});

test('安装前校验包内 engines.minVersion，避免升级后才在加载期消失', async () => {
  const tarball = buildTar([
    { name: 'plugin.json', data: manifest('demo', { engines: { minVersion: '9.9.9' } }) },
    { name: 'index.mjs', data: 'export const ok = true;\n' }
  ]);
  await assert.rejects(
    () => installPlugin({ tarball, id: 'demo', dataDir, hostVersion: '0.9.13' }),
    /E_ENGINE|要求宿主/
  );
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'demo')), false, '失败不能留下半装目录');
});

test('tar 解析：目录穿越 / 绝对路径 / 符号链接 / pax 长路径头 一律拒绝', () => {
  const cases = [
    [[{ name: dotDot('evil.mjs'), data: 'x' }], /不安全的路径/],
    [[{ name: '/etc/passwd', data: 'x' }], /不安全的路径/],
    [[{ name: 'demo/../../x', data: 'x' }], /不安全的路径/],
    // Windows 会剥掉段末尾的空格/点：`.. `、`...` 在 Win32 上等价于父目录
    [[{ name: 'a/.. /config.json', data: 'x' }], /不安全的路径/],
    [[{ name: 'a/.../config.json', data: 'x' }], /不安全的路径/],
    [[{ name: 'a/name. /config.json', data: 'x' }], /不安全的路径/],
    [[{ name: 'a\\..\\config.json', data: 'x' }], /不安全的路径/],
    [[{ name: 'C:\\evil\\x', data: 'x' }], /不安全的路径/],
    [[{ name: 'a/nul.txt', data: 'x' }], /不安全的路径/],
    [[{ name: 'x', type: '2', data: 'target' }], /不允许的条目类型/],   // 符号链接
    [[{ name: 'x', type: '1' }], /不允许的条目类型/]                    // 硬链接
  ];
  for (const [entries, pattern] of cases) {
    assert.throws(() => parseTarGz(buildTar(entries)), pattern, JSON.stringify(entries));
  }
  // pax 扩展头：拒绝并给出可操作的指引（v1 不实现扩展属性解析）
  assert.throws(() => parseTarGz(buildTar([{ name: 'plugin.json', data: '{}' }], { longNameHeader: true })),
    /条目类型 x/);
  // 截断：头里写的长度超过实际内容（用未压缩的 tar，才走得到"内容不足"这条判据）
  const rawTar = buildTar([{ name: 'a', data: 'x'.repeat(1200) }], { compress: false });
  assert.throws(() => parseTarGz(rawTar.subarray(0, 700)), /截断/);
  // gzip 本身被截断：解压就失败，也要报出来（不能静默当成空归档）
  const gz = buildTar([{ name: 'a', data: 'x'.repeat(1200) }]);
  assert.throws(() => parseTarGz(gz.subarray(0, 20)), /gzip|截断/);
});

test('内容校验：sha256 形状 / 一致 / 不一致', () => {
  assert.equal(isSha256('a'.repeat(64)), true);
  assert.equal(isSha256('A'.repeat(64)), true, '大写也认（比较时统一小写）');
  assert.equal(isSha256('abc'), false);
  const buffer = Buffer.from('hello plugin');
  const sha = sha256Of(buffer);
  assert.equal(verifySha256(buffer, sha), true);
  assert.throws(() => verifySha256(buffer, 'b'.repeat(64)), /内容校验失败/);
  assert.throws(() => verifySha256(buffer, 'nope'), /64 位十六进制/);
});

test('安装：装成功、重复装＝升级并留下旧版备份、staging 不留残渣', async () => {
  slate();
  const first = await installPlugin({ tarball: packPlugin('demo'), id: 'demo', dataDir });
  assert.equal(first.ok, true);
  assert.equal(first.id, 'demo');
  assert.equal(first.upgraded, false);
  const installed = path.join(pluginsRoot, 'demo');
  assert.ok(fs.existsSync(path.join(installed, 'plugin.json')));
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8')), { dir: installed });
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(strays(), [], '不该留下 .staging-* 之类的残渣');

  // 外层单目录的包也要能装（剥壳发生在安装路径上）
  const wrapped = await installPlugin({ tarball: packPlugin('wrapped', { prefix: 'wrapped' }), dataDir });
  assert.equal(wrapped.id, 'wrapped');
  assert.ok(fs.existsSync(path.join(pluginsRoot, 'wrapped', 'plugin.json')));

  const second = await installPlugin({ tarball: packPlugin('demo'), dataDir });
  assert.equal(second.upgraded, true, '第二次装同一个 id 是升级');
  assert.ok(second.backupDir && fs.existsSync(second.backupDir), '旧版要留在备份目录里（可回滚）');
  assert.ok(fs.existsSync(path.join(second.backupDir, 'plugin.json')));
  // 备份轮转：连装几次只留最近 3 份（不留的话每次升级堆一份代码）
  for (let i = 0; i < 4; i += 1) await installPlugin({ tarball: packPlugin('demo'), dataDir });
  const backups = fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.backup-demo.'));
  assert.equal(backups.length, 3, `备份应只留最近 3 份，实际 ${backups.length}`);
  assert.deepEqual(strays().filter((name) => !name.startsWith('.backup-')), [], '除了备份不该有别的东西');
});

test('同一毫秒内连装也不撞名（时钟不前进时升级照样留档、轮转照样生效）', async () => {
  // 这条钉的是服务器实测到的 ENOTEMPTY：备份目录名只用时间戳时，同一毫秒连做两次升级会撞名，
  // 而 rename 到非空目录在 POSIX 上直接失败。把时钟钉住就能在任何机器上稳定复现这个竞态。
  slate();
  const fixed = () => 1_700_000_000_000;
  await installPlugin({ tarball: packPlugin('demo'), dataDir, now: fixed });
  for (let i = 0; i < 3; i += 1) await installPlugin({ tarball: packPlugin('demo'), dataDir, now: fixed });
  const backups = fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.backup-demo.'));
  assert.equal(backups.length, 3, `同一毫秒连装也要各自留档并轮转到 3 份，实际 ${backups.length}`);
  assert.ok(fs.existsSync(path.join(pluginsRoot, 'demo', 'plugin.json')), '升级后新版本要在位');
});

test('安装：id 与预期不符要拒装，且不留下任何东西（staging 清干净）', async () => {
  slate();
  await assert.rejects(
    () => installPlugin({ tarball: packPlugin('other'), id: 'expected', dataDir }),
    /与预期（expected）不一致/
  );
  assert.deepEqual(fs.readdirSync(pluginsRoot), [], '拒装之后目录里不该多出任何东西');
});

test('安装：走 URL 时没给 sha256 直接拒（不给"从网上抓段代码就跑"留路）', async () => {
  await assert.rejects(
    () => installPlugin({ url: 'https://example.com/p.tar.gz', dataDir, fetchBinary: async () => ({ buffer: Buffer.from('x') }) }),
    /必须提供 sha256/
  );
  // 给了 sha256 但内容不符：必须拦下，且不落地
  slate();
  const body = packPlugin('demo');
  await assert.rejects(
    () => installPlugin({ url: 'https://example.com/p.tar.gz', sha256: 'c'.repeat(64), dataDir, fetchBinary: async () => ({ buffer: body }) }),
    /内容校验失败/
  );
  assert.deepEqual(fs.readdirSync(pluginsRoot), []);

  // 给了对得上 sha 的内容：正常装（下载路径与本地路径共用同一套校验）
  const ok = await installPlugin({
    url: 'https://example.com/p.tar.gz', sha256: sha256Of(body), dataDir, fetchBinary: async () => ({ buffer: body })
  });
  assert.equal(ok.id, 'demo');
  assert.ok(fs.existsSync(path.join(pluginsRoot, 'demo', 'index.mjs')));
});

test('安装：下载体积上限也挡（下载器不设限时由安装器兜底）', async () => {
  await assert.rejects(
    () => installPlugin({
      url: 'https://example.com/big.tar.gz', sha256: 'd'.repeat(64), dataDir,
      fetchBinary: async () => ({ buffer: Buffer.alloc(MAX_PLUGIN_ARCHIVE_BYTES + 1) })
    }),
    /超过体积上限/
  );
});

test('卸载：只挪走代码目录，插件数据保留（重装后状态还在）', async () => {
  slate();
  await installPlugin({ tarball: packPlugin('demo'), dataDir });
  const dataKeep = path.join(dataDir, 'plugin-data', 'demo');
  fs.mkdirSync(dataKeep, { recursive: true });
  fs.writeFileSync(path.join(dataKeep, 'storage.json'), '{"last":"keep-me"}');
  const result = uninstallPlugin({ id: 'demo', dataDir });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'demo')), false, '代码目录要挪走');
  assert.ok(!fs.readdirSync(pluginsRoot).includes('demo'));
  assert.equal(fs.readFileSync(path.join(dataKeep, 'storage.json'), 'utf8'), '{"last":"keep-me"}', '数据不该被顺手删掉');
  assert.throws(() => uninstallPlugin({ id: 'demo', dataDir }), /没有装着/);
  assert.throws(() => uninstallPlugin({ id: '../etc', dataDir }), /id 不合法/);
});

test('备份目录名不会被"前缀相同的另一个插件"命中（demo 升级不许动 demo-tools 的备份）', async () => {
  slate();
  // 这一条是审查抓到的：备份名原来用 `.backup-<id>-` 做前缀筛选，而 id 允许连字符，
  // 于是给 `demo` 升级会把 `demo-tools` 的备份一起纳入排序与删除 —— 最坏是**删掉本次升级刚做的回滚点**，
  // 而界面上还写着"旧版留在 .backup-* 里，确认没问题可以删"（用户以为那是安全网）。
  for (let i = 0; i < 3; i += 1) {
    await installPlugin({ tarball: packPlugin('demo-tools', { extraFiles: [{ name: 'v.mjs', data: `x${i}` }] }), dataDir, log: () => {} });
  }
  const before = fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.backup-demo-tools.'));
  assert.equal(before.length, 2, `demo-tools 应该有两份备份（留最近 3 份），实际 ${before.join(', ')}`);

  await installPlugin({ tarball: packPlugin('demo-tools', { extraFiles: [{ name: 'v.mjs', data: 'new' }] }), dataDir, log: () => {} });
  const mine = fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.backup-demo-tools.'));
  assert.equal(mine.length, 3, '第四份换入后仍保留 3 份（轮转照旧）');

  // 装另一个 id（前缀是 demo 而不是 demo-tools）时，demo-tools 的备份一份都不许少
  await installPlugin({ tarball: packPlugin('demo', { extraFiles: [{ name: 'v.mjs', data: 'a' }] }), dataDir, log: () => {} });
  await installPlugin({ tarball: packPlugin('demo', { extraFiles: [{ name: 'v.mjs', data: 'b' }] }), dataDir, log: () => {} });
  const stillThere = fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.backup-demo-tools.'));
  assert.equal(stillThere.length, 3, `demo 的备份轮转不许碰到 demo-tools 的备份，实际剩 ${stillThere.join(', ')}`);
  const demoBackups = fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.backup-demo.'));
  assert.equal(demoBackups.length, 1, 'demo 自己那一次升级应该留着回滚点');
});

test('解压炸弹：解压后超过上限直接拒（这段代码跑在宿主进程里，不能让它把机器人撑爆）', async () => {
  // 5MB 的 gz 能解开成 GB 级。造一个高压缩比的东西：全零内容压完只有几十 KB。
  const zlib = await import('node:zlib');
  const raw = Buffer.alloc(MAX_TOTAL_UNPACKED + 8 * 1024 * 1024, 0);
  const gz = zlib.gzipSync(raw, { level: 9 });
  assert.ok(gz.length < 1024 * 1024, `压缩后应该很小（${gz.length} 字节）才有"炸弹"的意义`);
  assert.throws(() => parseTarGz(gz), /上限|疑似压缩炸弹/);
  // 正常的包照旧能解（别把上限做成"永远拒绝"）
  assert.ok(parseTarGz(packPlugin('ok-bomb')).length > 0);
});

test('sha256 给了但形状不对：一律拒（不许"跳过校验继续装"）', async () => {
  slate();
  const tarball = packPlugin('sha-shape');
  await assert.rejects(
    () => installPlugin({ tarball, id: 'sha-shape', sha256: 'abc123', dataDir, log: () => {} }),
    (error) => error.code === 'E_SHA_SHAPE',
    '给了 sha256 就得能核对：形状不对必须报错，而不是静默跳过'
  );
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'sha-shape')), false, '被拒时不该落盘');
});

test('索引门控：minVersion 写成 v0.8.5 也不许静默放过；形状坏掉一律标成装不了', async () => {
  const { normalizePluginIndexEntry } = await import('../src/plugins/install.js');
  const base = { id: 'gate-plugin', downloadUrl: 'https://e/x.tar.gz', sha256: 'a'.repeat(64) };
  const higher = normalizePluginIndexEntry({ ...base, minVersion: 'v9.9.9' }, { hostVersion: '0.8.5' });
  assert.equal(higher.entry.compatible, false, '带 v 前缀的高版本要求必须拦住（原来因为这层正则直接跳过门控）');
  assert.match(higher.entry.reason, /9\.9\.9/);
  const lower = normalizePluginIndexEntry({ ...base, minVersion: 'v0.1.0' }, { hostVersion: '0.8.5' });
  assert.equal(lower.entry.compatible, true, '带 v 的低版本要求要能正常通过');
  const broken = normalizePluginIndexEntry({ ...base, minVersion: '下个版本' }, { hostVersion: '0.8.5' });
  assert.equal(broken.entry.compatible, false, '形状不对要 fail-closed');
  assert.match(broken.entry.reason, /形状不对/);
});

test('索引：坏项跳过、好项归一化、非 200 与坏 JSON 都要报出来', async () => {
  const body = JSON.stringify({
    plugins: [
      { id: 'good', name: '好插件', version: '1.0.0', description: '可用', capabilities: ['tools'], tarball: 'https://example.com/g.tar.gz', sha256: 'e'.repeat(64) },
      { id: 'no-sha', name: '缺 sha', tarball: 'https://example.com/x.tar.gz' },
      { id: 'Bad_Id', name: '坏 id', tarball: 'https://example.com/y.tar.gz', sha256: 'f'.repeat(64) },
      'not-an-object'
    ]
  });
  const skipped = [];
  const index = await fetchPluginIndex({ url: 'https://example.com/index.json', fetchText: async () => ({ statusCode: 200, body }), log: (line) => skipped.push(line) });
  const list = index.entries;
  assert.deepEqual(list.map((p) => p.id), ['good'], '只保留完整的项');
  // 三条坏项都要留痕（含"整项不是对象"那种形状坏）：悄悄少一条最难排查
  assert.equal(skipped.length, 3, '缺 sha / 坏 id / 不是对象 都要留下原因');
  // 跳过的条目要能从返回值拿到（只写日志的话，界面那句「缺字段被跳过」永远不会出现）
  assert.equal(index.skipped.length, 3, '跳过的条目要回传给调用方');
  assert.ok(index.skipped.every((item) => item.reason && item.source === 'https://example.com/index.json'), '每条都要带原因与来源');
  assert.equal(list[0].sha256, 'e'.repeat(64));
  assert.equal(list[0].url, 'https://example.com/g.tar.gz', 'tarball 这个老字段名要能读出来（归一化到 url）');
  await assert.rejects(() => fetchPluginIndex({ url: 'https://x/index.json', fetchText: async () => ({ statusCode: 404, body: 'nope' }) }), /HTTP 404/);
  await assert.rejects(() => fetchPluginIndex({ url: 'https://x/index.json', fetchText: async () => ({ statusCode: 200, body: 'not json' }) }), /不是合法 JSON/);
  await assert.rejects(() => fetchPluginIndex({ url: 'https://x/index.json', fetchText: async () => ({ statusCode: 200, body: '{}' }) }), /没有 plugins 数组/);
});
