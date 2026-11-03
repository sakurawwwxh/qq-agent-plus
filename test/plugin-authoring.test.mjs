// 插件作者三件套（src/plugins/pack.js + scripts/plugin-{create,dev,pack}.mjs）的护栏。
//
// 这三件决定"别人能不能写出第二个插件"，所以断言盯的是**作者会踩的坑**，不是内部实现：
//   · 打出来的包宿主认不认 —— 用**真安装器**（parseTarGz + installPlugin）解，不另写一套解析；
//   · 同一份源码两次打包是否逐字节相同 —— 否则 CI 算的 sha256 与作者本地永远对不上；
//   · 脚手架产物能不能开箱打包、能不能真起来调通工具（第一步就卡住就没人写第二个）；
//   · 该拒的（TypeScript / 第三方依赖 / 坏 manifest / 超大）都要拒，且**不落盘**。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { collectPluginFiles, buildPluginTarball, packPluginDir, indexEntryFor } =
  await import('../src/plugins/pack.js');
const { parseTarGz, installPlugin, sha256Of } = await import('../src/plugins/install.js');
const { parsePluginManifest } = await import('../src/plugins/manifest.js');

const made = [];
function tempDir(t, prefix = 'qq-plugin-pack-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch { /* 句柄占用就算了 */ }
  });
  return dir;
}
// 用例被中断时 t.after 不保证跑到：兜底清掉本文件建过的临时目录
process.on('exit', () => {
  for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 同上 */ } }
});

/** 造一个最小可用插件目录（可逐项改坏）。 */
function makePlugin(dir, { id = 'demo', manifest = {}, files = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const raw = {
    id,
    apiVersion: 1,
    name: `演示 ${id}`,
    version: '0.1.0',
    description: '打包测试用',
    entry: 'index.mjs',
    capabilities: ['tools'],
    tools: [{ name: 'hello', description: '回显' }],
    ...manifest
  };
  fs.writeFileSync(path.join(dir, 'plugin.json'), `${JSON.stringify(raw, null, 2)}\n`);
  for (const [name, data] of Object.entries({ 'index.mjs': 'export const ok = true;\n', ...files })) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
  return raw;
}

const runScript = (script, args, options = {}) =>
  spawnSync(process.execPath, [path.join(repo, script), ...args], { cwd: repo, encoding: 'utf8', ...options });

/** 脚本在 --json 下只应输出一行 JSON；取最后一个非空行（诊断信息可能走 stderr）。 */
const lastJson = (stdout) => {
  const line = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
  assert.ok(line, `没拿到 JSON 输出：${stdout}`);
  return JSON.parse(line);
};

const packedCount = (outDir) => (fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0);

test('buildPluginTarball：真安装器认得（ustar + 普通文件），两次打包逐字节相同', (t) => {
  const dir = tempDir(t);
  makePlugin(dir);
  const files = collectPluginFiles(dir);
  const first = buildPluginTarball(files);
  const second = buildPluginTarball(files);
  assert.deepEqual(first, second, '同一份源码两次打包必须逐字节相同，否则索引里的 sha256 与作者本地算的会对不上');

  const entries = parseTarGz(first);
  assert.deepEqual(entries.filter((e) => e.type === 'file').map((e) => e.name).sort(), ['index.mjs', 'plugin.json']);
  const manifestEntry = entries.find((e) => e.name === 'plugin.json');
  assert.equal(JSON.parse(manifestEntry.data.toString('utf8')).id, 'demo');
});

test('buildPluginTarball：超过 100 字节的路径靠 ustar 的 prefix 段承载，安装器能还原', (t) => {
  const dir = tempDir(t);
  const long = `${'x'.repeat(80)}/${'y'.repeat(80)}.mjs`;
  makePlugin(dir, { files: { [long]: 'export const deep = true;\n' } });
  const entries = parseTarGz(buildPluginTarball(collectPluginFiles(dir)));
  const found = entries.find((e) => e.name.endsWith('.mjs') && e.name.startsWith('x'.repeat(20)));
  assert.ok(found, '长路径必须能原样解出来（prefix + name 两段拼回）');
  assert.equal(found.name, long);
  // 拼不回来的（prefix 段也装不下）要明确报错，而不是悄悄截断成另一个路径
  const tooLong = `${'z'.repeat(200)}/w.mjs`;
  makePlugin(dir, { files: { [tooLong]: 'export const x = 1;\n' } });
  assert.throws(() => buildPluginTarball(collectPluginFiles(dir)), /路径太长/);
});

test('条目顺序按码位排：不受语言环境影响（跨平台 sha256 一致的前提）', (t) => {
  const dir = tempDir(t);
  // 混大小写 + 下划线 + 目录：按 ICU 排序（大小写不敏感）时会是 [a.mjs, B.mjs, _z.mjs, Z.mjs]，
  // 按码位是 [B.mjs, Z.mjs, _z.mjs, a.mjs] —— 两种顺序的字节不同，sha256 自然也不同。
  makePlugin(dir, { files: { 'B.mjs': 'B', 'a.mjs': 'a', 'Z.mjs': 'Z', 'sub/_x.mjs': 'x' } });
  const names = parseTarGz(buildPluginTarball(collectPluginFiles(dir))).map((e) => e.name);
  assert.deepEqual(names, [...names].sort(), `条目顺序必须与码位序一致，实际 ${names.join(', ')}`);
});

test('字节级金标：同一个夹具的 sha256 固定不变（把顺序、头字段、压缩头一起钉住）', (t) => {
  const dir = tempDir(t);
  makePlugin(dir, { id: 'golden', manifest: { name: '金标夹具', description: '打包可复现性金标' } });
  const packed = packPluginDir({ dir });
  // gzip 头 10 字节：magic(2) + CM + FLG=0 + MTIME=0（不写打包时间）+ XFL=2（最高压缩）
  // + OS=0xff（**不写平台** —— zlib 默认会写 Linux=3 / Windows=10，那是两个包 sha256 不同的元凶）。
  // 整条头都断言下来：改动其中任何一个字节，这条会红，而不是等到 CI 与作者本地对不上才发现。
  assert.deepEqual([...packed.buffer.subarray(0, 10)],
    [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]);
  // 金标值：跨平台实测（Windows / Linux 同 Node 22）打过同一个数。它变了只有两种可能：
  // 打包逻辑变了（该看差异），或 Node 的 zlib 换了实现（那就得重新确认可复现性再重新冻结）。
  assert.equal(packed.bytes, 318);
  assert.equal(packed.sha256, 'b4ca880bb89de4905171f8391b93aebb293351541997115020e459f52fad49d2');
});

test('collectPluginFiles：跳过隐藏文件与 node_modules；符号链接一律拒', (t) => {
  const dir = tempDir(t);
  makePlugin(dir, { files: { 'sub/extra.mjs': 'export const s = 1;\n' } });
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.hidden'), 'x');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'x');
  assert.deepEqual(collectPluginFiles(dir).map((f) => f.name), ['index.mjs', 'plugin.json', 'sub/extra.mjs']);

  let linked = false;
  try { fs.symlinkSync(path.join(dir, 'index.mjs'), path.join(dir, 'link.mjs'), 'file'); linked = true; }
  catch { /* Windows 非开发者模式建不了符号链接 */ }
  if (!linked) {
    t.skip('本机建不了符号链接（Windows 需要开发者模式/管理员）');
    return;
  }
  assert.throws(() => collectPluginFiles(dir), /不支持的东西/, '符号链接不能进包（安装器本来也会拒）');
});

test('packPluginDir：正常路径给出 sha256/大小/文件数，并落盘到 --out', (t) => {
  const dir = tempDir(t);
  const out = path.join(tempDir(t), 'dist');
  makePlugin(dir, { id: 'demo-tools' });
  const packed = packPluginDir({ dir, outDir: out });
  assert.equal(packed.id, 'demo-tools');
  assert.equal(packed.version, '0.1.0');
  assert.equal(packed.sha256, sha256Of(packed.buffer), '索引里贴的 sha256 必须就是包内容的 sha256');
  assert.equal(packed.bytes, packed.buffer.length);
  assert.equal(packed.fileCount, 2);
  assert.equal(path.basename(packed.file), 'demo-tools-0.1.0.tar.gz');
  assert.deepEqual(fs.readFileSync(packed.file), packed.buffer);
  // 不传 outDir 就只算不落盘（CI 里做校验用得上）
  assert.equal(packPluginDir({ dir }).file, '');
});

test('打包：目录里已有的 .tar.gz 不再进包，entry 要按**相对路径**精确匹配', (t) => {
  const dir = tempDir(t);
  makePlugin(dir, { id: 'demo-tools' });
  // 手工打过一个包留在目录里：它不该被装进后续每一份新包（否则体积递增、sha256 每次都变，
  // 现象看起来只是"改了源码"，极难联想）
  fs.writeFileSync(path.join(dir, 'demo-tools-1.0.0.tar.gz'), 'old package');
  const first = packPluginDir({ dir });
  const names = parseTarGz(first.buffer).map((item) => item.name);
  assert.deepEqual(names.sort(), ['index.mjs', 'plugin.json'], '包里的旧 tar.gz 不能再次进包');
  // entry 指向子目录时，包里得**在同一个相对路径上**有它（原来只比 basename：随便哪个位置同名就算过）
  const nested = path.join(dir, 'nested');
  // entry 指向 lib/main.mjs，而包里**只有**根目录的 main.mjs：按 basename 比就会误判"入口在包里"，
  // 于是本地自测通过、装到用户机器上起不来（宿主按 manifest 的 entry 去找 lib/main.mjs，找不到）
  makePlugin(nested, {
    id: 'nested-tools', manifest: { entry: 'lib/main.mjs' }, files: { 'main.mjs': '// 同名，但位置不对\n' }
  });
  assert.throws(() => packPluginDir({ dir: nested }), /lib\/main\.mjs/,
    '只有别处的同名文件不算——入口必须落在 manifest 声明的那个相对路径上');
});

test('packPluginDir：--out 指向插件目录里面要当场拒绝（否则下次打包会把自己装进去）', (t) => {
  const dir = tempDir(t);
  makePlugin(dir, { id: 'demo-tools' });
  for (const out of [dir, path.join(dir, 'dist')]) {
    let error = null;
    try { packPluginDir({ dir, outDir: out }); } catch (err) { error = err; }
    assert.ok(error, `--out=${out} 应该被拒`);
    assert.equal(error.code, 'E_ARGS');
    assert.match(error.message, /在插件目录里面/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'dist')), false, '被拒时连目录都不该建');
  // 目录外（哪怕就在上一层）是正常的：默认行为就是落在插件目录旁边
  const outside = path.join(tempDir(t), 'dist');
  assert.equal(packPluginDir({ dir, outDir: outside }).ok, true);
});

test('packPluginDir：坏插件逐条拒，且不在输出目录留下任何东西', (t) => {  const root = tempDir(t);
  const out = path.join(root, 'dist');
  const cases = [
    {
      name: '没有 plugin.json',
      build: (dir) => fs.mkdirSync(dir, { recursive: true }),
      code: 'E_ARGS',
      match: /没有 plugin\.json/
    },
    {
      name: 'manifest 过不了校验（apiVersion 不认识）',
      build: (dir) => makePlugin(dir, { manifest: { apiVersion: 99 } }),
      code: 'E_MANIFEST',
      match: /apiVersion/
    },
    {
      name: 'manifest 里的入口不在包里',
      build: (dir) => makePlugin(dir, { manifest: { entry: 'missing.mjs' } }),
      code: 'E_PACK',
      match: /入口/
    },
    {
      name: 'TypeScript 源码',
      build: (dir) => makePlugin(dir, { files: { 'src/main.ts': 'export const n: number = 1;\n' } }),
      code: 'E_PACK',
      match: /TypeScript/
    },
    {
      name: '声明了第三方依赖（dependencies）',
      build: (dir) => makePlugin(dir, {
        files: { 'package.json': JSON.stringify({ name: 'demo', dependencies: { 'node-fetch': '^3.0.0' } }) }
      }),
      code: 'E_PACK',
      match: /node-fetch/
    },
    {
      name: '声明了第三方依赖（peerDependencies）',
      build: (dir) => makePlugin(dir, {
        files: { 'package.json': JSON.stringify({ name: 'demo', peerDependencies: { undici: '^8.0.0' } }) }
      }),
      code: 'E_PACK',
      match: /undici/
    },
    {
      name: '包超过安装器的 5MB 上限',
      build: (dir) => makePlugin(dir, { files: { 'blob.bin': crypto.randomBytes(5 * 1024 * 1024 + 512 * 1024) } }),
      code: 'E_PACK',
      match: /上限/
    }
  ];
  for (const [i, item] of cases.entries()) {
    const dir = path.join(root, `case-${i}`);
    item.build(dir);
    let error = null;
    try { packPluginDir({ dir, outDir: out }); } catch (err) { error = err; }
    assert.ok(error, `${item.name}：应该被拒`);
    assert.equal(error.code, item.code, `${item.name}：错误码（${error.message}）`);
    assert.match(error.message, item.match, item.name);
  }
  assert.equal(packedCount(out), 0, '被拒的插件不该落盘 —— 作者得先修好再重打');
});

test('indexEntryFor：字段齐全，下载地址按 GitHub Release 约定拼，缺参时留可见占位', (t) => {
  const dir = tempDir(t);
  makePlugin(dir, { id: 'demo-tools' });
  const packed = packPluginDir({ dir });
  const entry = indexEntryFor(packed, {
    baseUrl: 'https://github.com/me/demo/', tag: 'v0.1.0', minVersion: '0.8.5',
    tags: ['工具', '游戏'], author: 'me', homepage: 'https://example.com/demo'
  });
  assert.equal(entry.downloadUrl, 'https://github.com/me/demo/releases/download/v0.1.0/demo-tools-0.1.0.tar.gz');
  assert.equal(entry.sha256, packed.sha256);
  assert.equal(entry.id, 'demo-tools');
  assert.equal(entry.apiVersion, 1);
  assert.equal(entry.minVersion, '0.8.5');
  assert.deepEqual(entry.capabilities, ['tools']);
  assert.deepEqual(entry.tags, ['工具', '游戏']);
  assert.equal(entry.homepage, 'https://example.com/demo');

  // 缺 base-url 时不猜地址：放一个作者一眼能看见的占位，而不是生成一个装不上的 URL
  const bare = indexEntryFor(packed, {});
  assert.match(bare.downloadUrl, /demo-tools-0\.1\.0\.tar\.gz/);
  assert.match(bare.downloadUrl, /^</);
  assert.match(bare.minVersion, /^<.+>$/);
  assert.match(bare.author, /^<.+>$/);
  assert.deepEqual(bare.tags, ['社区']);
});

test('打包 → 真安装器装一遍 → 装出来的树与源目录逐字节一致', async (t) => {
  const dir = tempDir(t);
  const dataDir = tempDir(t);
  makePlugin(dir, { id: 'roundtrip', files: { 'lib/helper.mjs': 'export const n = 1;\n' } });
  const packed = packPluginDir({ dir });
  const installed = await installPlugin({ tarball: packed.buffer, id: packed.id, dataDir, log: () => {} });
  assert.equal(installed.id, 'roundtrip');
  const dest = path.join(dataDir, 'plugins', 'roundtrip');
  assert.equal(
    fs.readFileSync(path.join(dest, 'plugin.json'), 'utf8'),
    fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')
  );
  assert.equal(fs.readFileSync(path.join(dest, 'lib/helper.mjs'), 'utf8'), 'export const n = 1;\n');
});

test('plugin-create：生成骨架、manifest 过宿主校验；非法参数不建目录、不覆盖已存在的目录', (t) => {
  const parent = tempDir(t);
  const created = runScript('scripts/plugin-create.mjs',
    ['demo-tools', '--name', '演示工具', '--author', 'sakurawwwxh', '--dir', parent]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const target = path.join(parent, 'demo-tools');
  for (const name of ['plugin.json', 'index.mjs', 'README.md']) {
    assert.ok(fs.existsSync(path.join(target, name)), `${name} 应该生成`);
  }
  const raw = JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8'));
  assert.equal(raw.id, 'demo-tools');
  assert.equal(raw.name, '演示工具');
  const checked = parsePluginManifest(raw, { dir: target });
  assert.equal(checked.ok, true, `脚手架产出的 manifest 必须过宿主那一关：${checked.error}`);
  assert.deepEqual(checked.manifest.tools.map((item) => item.name), ['hello']);

  // 非法 id / 非法工具名：拒，且一个字节都不写
  for (const args of [['Bad-Id'], ['demo', '--tool', 'Has-Dash']]) {
    const bad = runScript('scripts/plugin-create.mjs', [...args, '--dir', parent]);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  }
  assert.equal(fs.existsSync(path.join(parent, 'Bad-Id')), false);
  assert.equal(fs.existsSync(path.join(parent, 'demo')), false);

  // 目录已存在且非空：拒，且不清空别人的东西
  fs.mkdirSync(path.join(parent, 'taken'));
  fs.writeFileSync(path.join(parent, 'taken', 'keep.txt'), 'keep\n');
  const taken = runScript('scripts/plugin-create.mjs', ['taken', '--dir', parent]);
  assert.equal(taken.status, 2, taken.stdout + taken.stderr);
  assert.equal(fs.readFileSync(path.join(parent, 'taken', 'keep.txt'), 'utf8'), 'keep\n');
});

test('三件套串起来：脚手架产物能打包自测、能真起来调通工具（作者走的正是这条路）', (t) => {
  const parent = tempDir(t);
  const created = runScript('scripts/plugin-create.mjs',
    ['demo-tools', '--name', '演示工具', '--author', 'tester', '--dir', parent]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const target = path.join(parent, 'demo-tools');

  // ① 打包 + 自测（脚本自己拿真安装器在临时目录里装一遍，装不上就 exit 1）
  const pack = runScript('scripts/plugin-pack.mjs', [
    target, '--out', path.join(parent, 'dist'), '--base-url', 'https://github.com/tester/demo-tools',
    '--tag', 'v0.1.0', '--min-version', '0.8.5', '--tags', '工具', '--json'
  ]);
  const packed = lastJson(pack.stdout);
  assert.equal(pack.status, 0, pack.stdout + pack.stderr);
  assert.equal(packed.selfTest.ok, true, `自测必须过：${packed.selfTest.error}`);
  assert.ok(fs.existsSync(packed.file), '包要落在 --out 指的目录里');
  assert.equal(packed.entry.minVersion, '0.8.5');
  assert.deepEqual(packed.entry.tags, ['工具']);

  // ② 可复现：换一个输出目录再打一次，sha256 必须一模一样
  const again = lastJson(runScript('scripts/plugin-pack.mjs',
    [target, '--out', path.join(parent, 'dist2'), '--json']).stdout);
  assert.equal(again.sha256, packed.sha256, '同一份源码两次打包的 sha256 必须相同');

  // ③ 假宿主真起一遍（真协议 + 真隔离）：这条就是 README 里写的第一条命令
  const dev = runScript('scripts/plugin-dev.mjs', [target, '--call', 'hello', '--args', '{"text":"你好"}', '--json']);
  const called = lastJson(dev.stdout);
  assert.equal(dev.status, 0, dev.stdout + dev.stderr);
  assert.equal(called.ok, true, called.error);
  assert.equal(called.result.echo, '你好');

  // ④ 占位符提醒：脚手架的一句话描述没改时，打包输出要提醒"它会原样显示给使用者"。
  //    这不是拦（自测才是拦），但作者最容易忘的就是把模板句当成成品发出去。
  const warn = runScript('scripts/plugin-pack.mjs', [target, '--out', path.join(parent, 'dist3')]);
  assert.match(warn.stdout, /上架前改掉这几处/, `打包输出里要有占位符提醒：
${warn.stdout.slice(-400)}`);
});

test('plugin-pack --index：同 id 幂等替换；不带 --write 只预览、不动文件', (t) => {
  const parent = tempDir(t);
  const target = path.join(parent, 'demo');
  makePlugin(target, { id: 'demo' });
  const indexPath = path.join(parent, 'index.json');

  const added = lastJson(runScript('scripts/plugin-pack.mjs',
    [target, '--out', path.join(parent, 'd1'), '--index', indexPath, '--write', '--json']).stdout);
  assert.equal(added.index.action, 'added');
  const updated = lastJson(runScript('scripts/plugin-pack.mjs',
    [target, '--out', path.join(parent, 'd2'), '--index', indexPath, '--write', '--json']).stdout);
  assert.equal(updated.index.action, 'updated');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(index.plugins.length, 1, '同一个 id 只留一条');
  assert.equal(index.plugins[0].sha256, updated.sha256);

  const before = fs.readFileSync(indexPath, 'utf8');
  const preview = lastJson(runScript('scripts/plugin-pack.mjs',
    [target, '--out', path.join(parent, 'd3'), '--index', indexPath, '--json']).stdout);
  assert.equal(preview.index.action, 'preview');
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before, '预览模式不许改文件');
});

test('plugin-pack --index：写索引按 id 合并 —— 撤回/签名/分类这类维护字段不能被重新打包冲掉', (t) => {
  const parent = tempDir(t);
  const target = path.join(parent, 'demo');
  makePlugin(target, { id: 'demo' });
  const indexPath = path.join(parent, 'index.json');
  // 先放一条"已上架"的条目，带撤回、发布者、签名与分类
  fs.writeFileSync(indexPath, JSON.stringify({
    version: 1,
    plugins: [{
      id: 'demo', version: '1.0.0', capabilities: ['tools'],
      downloadUrl: 'https://github.com/me/demo/releases/download/v1/demo-1.0.0.tar.gz',
      sha256: 'b'.repeat(64), revoked: true, revokedReason: '恶意行为',
      publisher: 'alice', signature: 'sig', category: '工具', tags: ['官方']
    }]
  }, null, 2));

  const out = lastJson(runScript('scripts/plugin-pack.mjs',
    [target, '--out', path.join(parent, 'dist'), '--index', indexPath, '--write', '--json']).stdout);
  assert.equal(out.index.action, 'updated');
  const entry = JSON.parse(fs.readFileSync(indexPath, 'utf8')).plugins[0];
  assert.equal(entry.revoked, true, '重新打包不能把撤回清掉（那等于下架的插件又变成可安装）');
  assert.equal(entry.publisher, 'alice', '发布者与签名属于信任链，不能被冲掉');
  assert.equal(entry.signature, 'sig');
  assert.equal(entry.category, '工具', '市场字段要保留');
  assert.deepEqual(entry.tags, ['官方'], '没传 --tags 时不能用默认 ["社区"] 覆盖原有标签');
  assert.equal(entry.sha256, out.sha256, '包指纹要更新');
});

test('plugin-pack：自测跑不起来时要如实报失败（不能"没验过"就发出去）', (t) => {
  const parent = tempDir(t);
  const target = path.join(parent, 'demo');
  makePlugin(target, { id: 'demo' });
  // 临时目录指到一个不存在的地方：安装器要用的沙盒建不出来，自测也就无从谈起
  const broken = path.join(parent, 'no-such-tmp');
  const env = { ...process.env, TMPDIR: broken, TMP: broken, TEMP: broken };
  const r = runScript('scripts/plugin-pack.mjs', [target, '--out', path.join(parent, 'dist'), '--json'], { env });
  assert.equal(r.status, 1, `自测没跑成必须失败退出：${r.stdout}${r.stderr}`);
  const payload = lastJson(r.stdout);
  assert.equal(payload.selfTest.ok, false);
  assert.ok(payload.selfTest.error, '要说清为什么没验成');
});

test('plugin-dev：调不存在的工具要明确失败（报出工具名），漏了 plugin.json 直接说清', (t) => {
  const parent = tempDir(t);
  const target = path.join(repo, 'test/fixtures/plugins/good');   // 真能起来的夹具（协议、能力都走一遍）

  const miss = runScript('scripts/plugin-dev.mjs', [target, '--call', 'nope', '--json']);
  assert.equal(miss.status, 1, miss.stdout + miss.stderr);
  const payload = lastJson(miss.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.tool, 'nope');
  assert.match(payload.error, /nope/);

  const empty = path.join(parent, 'empty');
  fs.mkdirSync(empty);
  const noManifest = runScript('scripts/plugin-dev.mjs', [empty, '--call', 'hello', '--json']);
  assert.equal(noManifest.status, 1);
  assert.match(`${noManifest.stdout}${noManifest.stderr}`, /plugin\.json/);
});

test('打包可复现：同一份源码在 CRLF 工作副本上打出的包，与 LF 逐字节相同', async (t) => {
  // Git for Windows 默认 core.autocrlf=true：外部作者 clone 下来的插件是 CRLF，而这台 CI 是 LF。
  // 文档承诺"跨平台 sha256 一致"（内容锚点能用的前提），所以打包器要自己归一行尾。
  const { packPluginDir } = await import('../src/plugins/pack.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const manifest = JSON.stringify({
    id: 'eol-demo', apiVersion: 1, name: '行尾', version: '1.0.0', description: 'eol',
    entry: 'index.mjs', capabilities: ['tools'],
    tools: [{ name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } }]
  }, null, 2);
  const source = "const a = 1;\nconst b = 2;\nprocess.stdin.on('data', () => {});\n";
  const make = (eol) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `qq-eol-${eol === '\r\n' ? 'crlf' : 'lf'}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'eol-demo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'plugin.json'), `${manifest}\n`);
    fs.writeFileSync(path.join(dir, 'index.mjs'), source.replace(/\n/g, eol));
    return dir;
  };
  const lf = packPluginDir({ dir: make('\n') });
  const crlf = packPluginDir({ dir: make('\r\n') });
  assert.equal(crlf.sha256, lf.sha256, 'CRLF 工作副本打出来的包必须与 LF 一致（否则 sha256 两侧对不上）');
});

test('plugin-pack --index：包默认落进索引仓库的 plugins/packages（verify-index 要求仓库里有产物）', (t) => {
  const parent = tempDir(t);
  const target = path.join(parent, 'demo');
  makePlugin(target, { id: 'demo', manifest: { version: '1.0.0' } });
  const indexDir = path.join(parent, 'plugins');
  fs.mkdirSync(indexDir, { recursive: true });
  const indexPath = path.join(indexDir, 'index.json');
  const out = lastJson(runScript('scripts/plugin-pack.mjs',
    [target, '--index', indexPath, '--write', '--json']).stdout);
  assert.equal(out.index.action, 'added');
  const packaged = path.join(indexDir, 'packages', 'demo-1.0.0.tar.gz');
  assert.equal(fs.existsSync(packaged), true, '包应出现在 plugins/packages/ 下');
});

test('打包拒绝大小写不对的 manifest（Plugin.json 在 Windows 上能读，到 Linux 就装不上）', async (t) => {
  const { packPluginDir } = await import('../src/plugins/pack.js');
  const parent = tempDir(t);
  const dir = path.join(parent, 'demo');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'Plugin.json'), JSON.stringify({
    id: 'demo', apiVersion: 1, name: '大小写', version: '1.0.0', description: 'x',
    entry: 'index.mjs', capabilities: ['tools'],
    tools: [{ name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } }]
  }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), "process.stdin.on('data', () => {});");
  assert.throws(() => packPluginDir({ dir }), /大小写/);
});
