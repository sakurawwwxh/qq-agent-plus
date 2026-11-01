// 索引与上架：条目归一化（别名 / 兼容门控）、多来源合并、安装来源记录、官方索引与仓库内产物的一致性。
//
// 这一层的定位是"用户看得到的那一面"：控制台列出什么、哪些能装、装完记录什么。
// 所以断言盯的都是**用户与作者能观察到的事实**，而不是内部字段名。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildTar } from './helpers/tar.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-index-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const {
  normalizePluginIndexEntry, normalizePluginIndex, fetchPluginIndex, fetchPluginIndexes,
  installPlugin, uninstallPlugin, writePluginInstallInfo, readPluginInstallInfo,
  sha256Of, PLUGIN_INDEX_URL_FIELDS, createIndexRevokedCache, indexResultForDisplay
} = await import('../src/plugins/install.js');
const { PLUGIN_API_VERSION } = await import('../src/plugins/manifest.js');
const { packPluginDir } = await import('../src/plugins/pack.js');
const { PluginRegistry } = await import('../src/plugins/registry.js');

const sha = (char) => char.repeat(64);
const version = '0.8.5';
const entry = (over = {}) => ({
  id: 'demo-plugin', name: '演示', version: '1.0.0', description: '可安装',
  capabilities: ['tools'], downloadUrl: 'https://example.com/demo.tar.gz', sha256: sha('a'), ...over
});
const normalize = (item, over = {}) => normalizePluginIndexEntry(item, { hostVersion: version, ...over });

/** 造一个最小插件包（内容随版本变，用来验"升级后来源记录被覆盖"）。 */
const buildPluginTarball = (manifest, marker) => buildTar([
  { name: 'plugin.json', data: manifest },
  { name: 'index.mjs', data: `// ${marker}\nexport const ok = true;\n` }
]);

test('地址字段名三种叫法都认，按 downloadUrl > tarball > url 取第一个', () => {
  assert.deepEqual([...PLUGIN_INDEX_URL_FIELDS], ['downloadUrl', 'tarball', 'url']);
  // 我们自己的 plugin-pack 产出的条目用 downloadUrl，仓库最早的索引形状用 tarball ——
  // 两条都得能读出来，否则作者照文档生成的条目会被静默跳过（2026-10-16 抓到的真问题）
  for (const field of PLUGIN_INDEX_URL_FIELDS) {
    const result = normalize(entry({ downloadUrl: '', tarball: '', url: '', [field]: 'https://example.com/x.tar.gz' }));
    assert.equal(result.ok, true, `${field} 应该能被读出来`);
    assert.equal(result.entry.url, 'https://example.com/x.tar.gz');
  }
  const both = normalize(entry({ tarball: 'https://example.com/tar.tar.gz', downloadUrl: 'https://example.com/dl.tar.gz' }));
  assert.equal(both.entry.url, 'https://example.com/dl.tar.gz', '两个都给时按固定优先级，避免同一份索引读出两种结果');
});

test('坏条目被拒且给出可读原因（不是静默丢弃）', () => {
  const cases = [
    ['不是对象', 'not-an-object', /不是对象/],
    ['id 不合法', entry({ id: 'Bad_Id' }), /id 不合法/],
    ['id 太短', entry({ id: 'a' }), /id 不合法/],
    ['没有地址', entry({ downloadUrl: '' }), /缺少可下载地址/],
    ['地址不是 http(s)', entry({ url: 'file:///tmp/x.tar.gz', downloadUrl: '' }), /缺少可下载地址/],
    ['缺 sha256', entry({ sha256: '' }), /sha256 必须是/],
    ['sha256 形状不对', entry({ sha256: 'abc' }), /sha256 必须是/]
  ];
  for (const [label, item, pattern] of cases) {
    const result = normalize(item);
    assert.equal(result.ok, false, `${label}：应该被拒`);
    assert.match(result.reason, pattern, label);
  }
  const { entries, skipped } = normalizePluginIndex({ plugins: cases.map(([, item]) => item) });
  assert.equal(entries.length, 0);
  assert.equal(skipped.length, cases.length, '每一条被拒的都要留下原因');
});

test('兼容门控：apiVersion / minVersion 对不上时条目保留、标成装不了并说原因', () => {
  const api = normalize(entry({ apiVersion: PLUGIN_API_VERSION + 1 }));
  assert.equal(api.ok, true, '版本不匹配不是"坏条目"，要留住才能告诉用户为什么装不了');
  assert.equal(api.entry.compatible, false);
  assert.match(api.entry.reason, new RegExp(`apiVersion ${PLUGIN_API_VERSION + 1}`));

  const higher = normalize(entry({ minVersion: '9.9.9' }));
  assert.equal(higher.entry.compatible, false);
  assert.match(higher.entry.reason, /要求宿主 ≥ 9\.9\.9/);

  assert.equal(normalize(entry({ minVersion: version })).entry.compatible, true, '等于本机版本要能装');
  assert.equal(normalize(entry({ minVersion: '0.1.0' })).entry.compatible, true);
  assert.equal(normalize(entry({ apiVersion: PLUGIN_API_VERSION })).entry.compatible, true);
  assert.equal(normalize(entry()).entry.compatible, true, '不声明就是不限制');
  // 本机版本未知时不做判断（别用空字符串比出版本大小）
  assert.equal(normalize(entry({ minVersion: '9.9.9' }), { hostVersion: '' }).entry.compatible, true);
});

test('拉取索引：条目带来源，坏项留痕带原因；非 200 / 坏 JSON / 少 plugins 数组一律报错', async () => {
  const logs = [];
  const body = JSON.stringify({ version: 1, plugins: [entry(), { id: 'no-sha', downloadUrl: 'https://example.com/x.tar.gz' }, 42] });
  const result = await fetchPluginIndex({
    url: 'https://example.com/index.json', name: '官方', fetchText: async () => ({ statusCode: 200, body }),
    log: (line) => logs.push(line), hostVersion: version
  });
  assert.deepEqual(result.entries.map((item) => item.id), ['demo-plugin']);
  assert.equal(result.entries[0].source, '官方', '条目要记住自己来自哪份索引');
  assert.equal(logs.length, 2);
  assert.ok(logs.some((line) => line.includes('sha256 必须是')), `跳过原因要写清：${logs.join(' | ')}`);
  // 跳过的条目要回传给调用方（只写日志的话，界面上那句"缺字段被跳过"永远不会出现）
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((item) => item.reason && item.source === '官方'), '每条都要带原因与来源');

  const reject = async (over, pattern) => {
    await assert.rejects(() => fetchPluginIndex({ url: 'https://x/index.json', fetchText: async () => over }), pattern);
  };
  await reject({ statusCode: 404, body: 'nope' }, /HTTP 404/);
  await reject({ statusCode: 200, body: 'not json' }, /不是合法 JSON/);
  await reject({ statusCode: 200, body: '{}' }, /没有 plugins 数组/);
  await assert.rejects(() => fetchPluginIndex({ url: '', fetchText: async () => ({}) }), /没有配置索引地址/);
  await assert.rejects(() => fetchPluginIndex({ url: 'https://x/i.json' }), /没有可用的抓取实现/);
});

test('多来源索引：按配置顺序取靠前的，重复项进 skipped，一份拉不动不影响其余', async () => {
  const official = JSON.stringify({ version: 1, plugins: [entry({ id: 'shared-plugin', name: '官方的' }), entry({ id: 'official-only' })] });
  const third = JSON.stringify({ version: 1, plugins: [entry({ id: 'shared-plugin', name: '第三方的' }), entry({ id: 'third-only' })] });
  const logs = [];
  const result = await fetchPluginIndexes({
    sources: [
      { url: 'https://third.example/index.json', name: '第三方' },
      { url: 'https://official.example/index.json', name: '官方' },
      { url: 'https://broken.example/index.json', name: '坏掉的' }
    ],
    fetchText: async (url) => {
      if (url.includes('broken')) throw Object.assign(new Error('连不上'), { code: 'E_NET' });
      return { statusCode: 200, body: url.includes('third') ? third : official };
    },
    log: (line) => logs.push(line),
    hostVersion: version
  });
  assert.deepEqual(result.plugins.map((item) => item.id), ['shared-plugin', 'third-only', 'official-only'], '顺序即优先级');
  assert.equal(result.plugins[0].name, '第三方的', '同 id 取靠前那份');
  assert.equal(result.plugins[0].source, '第三方');
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /与「第三方」里的同名条目重复/);
  assert.deepEqual(result.sources.map((item) => item.ok), [true, true, false], '每个来源的结果单独记录');
  assert.match(result.sources[2].error, /连不上/);
  assert.ok(logs.some((line) => line.includes('坏掉的')), '拉取失败要留痕');
});

test('安装来源记录：装完写下"从哪来、哪一份"，升级覆盖、卸载后仍在，读不到不影响使用', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-prov-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });
  const manifest = JSON.stringify({
    id: 'prov-demo', apiVersion: 1, name: '来源演示', version: '1.0.0', capabilities: ['tools'],
    tools: [{ name: 'ping', description: 'x' }]
  });
  const tarball = buildPluginTarball(manifest, '1.0.0');
  const result = await installPlugin({
    tarball, id: 'prov-demo', dataDir: dir, source: '索引：官方', url: 'https://example.com/p.tar.gz',
    sha256: sha256Of(tarball), hostVersion: version, log: () => {}
  });
  assert.equal(result.ok, true);
  const info = readPluginInstallInfo({ dataDir: dir, id: 'prov-demo' });
  assert.equal(info.source, '索引：官方');
  assert.equal(info.url, 'https://example.com/p.tar.gz');
  assert.equal(info.sha256, sha256Of(tarball));
  assert.equal(info.version, '1.0.0');
  assert.equal(info.hostVersion, version);
  assert.equal(info.apiVersion, 1);
  assert.equal(info.upgraded, false);
  assert.ok(info.installedAt > 0);

  // 升级：记录里换成新版本与 upgraded=true（旧记录不能留着骗人）
  const next = buildPluginTarball(manifest.replace('1.0.0', '1.1.0'), '1.1.0');
  await installPlugin({ tarball: next, id: 'prov-demo', dataDir: dir, source: '手动填写的地址', url: 'https://example.com/p2.tar.gz', log: () => {} });
  const upgraded = readPluginInstallInfo({ dataDir: dir, id: 'prov-demo' });
  assert.equal(upgraded.version, '1.1.0');
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.source, '手动填写的地址');

  // 卸载只挪代码目录：来源记录跟着数据留下（重装后还能追"上次是从哪来的"）
  uninstallPlugin({ id: 'prov-demo', dataDir: dir });
  assert.equal(fs.existsSync(path.join(dir, 'plugins', 'prov-demo')), false);
  assert.equal(readPluginInstallInfo({ dataDir: dir, id: 'prov-demo' }).url, 'https://example.com/p2.tar.gz');

  // 写不进去时"记录失败"要能被调用方看见，但不能把安装本身拖下水
  const blocked = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocked, 'x');
  const failed = writePluginInstallInfo({ dataDir: blocked, id: 'prov-demo' });
  assert.equal(failed.ok, false);
  assert.ok(failed.error, '失败要给原因');
  assert.equal(readPluginInstallInfo({ dataDir: blocked, id: 'prov-demo' }), null, '读不到就返回 null（老插件/手工拷的都属于这种）');
});

test('控制台列表透出来源记录（手工拷进来的如实为 null）', async (t) => {
  // 插件目录（root）与数据目录（dataDir）在真实部署里是 data/plugins 与 data/plugin-data 两个平级
  // 目录，这里也要分开 —— 否则 plugin-data 会被当成一个"没有 manifest 的插件"扫进来
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-list-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-store-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  });
  fs.cpSync(path.join(repo, 'test', 'fixtures', 'plugins', 'good'), path.join(root, 'good'), { recursive: true });
  writePluginInstallInfo({
    dataDir: store, id: 'good', source: '索引：官方', url: 'https://example.com/g.tar.gz',
    version: '1.0.0', publisher: 'alice', signatureVerified: true
  });
  const registry = new PluginRegistry({ root, dataDir: store, log: () => {}, getConfig: () => ({ plugins: { enabled: false, enabledIds: [] } }) });
  const listed = registry.list().plugins;
  assert.equal(listed.length, 1, '夹具目录里只有一个插件');
  assert.equal(listed[0].install.source, '索引：官方');
  assert.equal(listed[0].install.url, 'https://example.com/g.tar.gz');
  assert.equal(listed[0].install.version, '1.0.0');
  // 发布者与验签结论：安装器写进 install.json、UI 要显示 —— registry.list() 这一跳漏搬过（界面
  // 上"有没有密码学来源凭证"会跟"从来没签名这回事"长得一模一样），所以这里必须逐字段断言
  assert.equal(listed[0].install.publisher, 'alice', '发布者要穿到控制台');
  assert.equal(listed[0].install.signatureVerified, true, '验签结论要穿到控制台');
  // 没有来源记录的插件（手工拷进目录的）读出来就是 null，界面据此显示"手工放的"
  assert.equal(readPluginInstallInfo({ dataDir: store, id: 'not-installed' }), null);
});

// ── 官方索引与仓库内产物：改了源码忘了重打包，必须被挡住 ────────────────────────
test('配置迁移：老实例存的"旧官方索引地址"要被搬到新地址，用户自填的地址不许动', async () => {
  // 索引搬家后，老实例的 config.json 里存着旧地址，而旧地址只剩一张空指路牌 ——
  // 界面会显示"索引里暂时没有条目"，用户看不出是被搬走了。迁移只改"等于出厂旧默认值"的那种。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-idx-mig-'));
  process.env.QQ_AGENT_DATA_DIR = dir;
  const OLD = 'https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plus/main/plugins/index.json';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ plugins: { enabled: true, indexUrl: OLD } }));
  const { loadConfig } = await import('../src/core/config-legacy.js');
  const migrated = loadConfig();
  const { DEFAULT_CONFIG } = await import('../src/core/config.js');
  assert.equal(migrated.plugins.indexUrl, DEFAULT_CONFIG.plugins.indexUrl, '旧默认值要搬到新默认值');
  assert.match(migrated.plugins.indexUrl, /qq-agent-plugins/, '新地址应当是独立索引仓库');
  // 用户自填的地址（哪怕是个 fork）一律不碰。
  // ⚠️ 这里不能"换个 config.json 再 loadConfig()"——config 是**进程内缓存**的（第一次读之后就定了），
  // 所以直测那条迁移的纯函数（config-legacy 把它导出来了，就是给这种用例用的）。
  const { migratePluginIndexUrl } = await import('../src/core/config-legacy.js');
  const userValue = 'https://my-fork.example/plugins/index.json';
  assert.equal(migratePluginIndexUrl({ indexUrl: userValue }).indexUrl, userValue, '用户自填的地址必须原样保留');
  assert.equal(migratePluginIndexUrl({ indexUrl: OLD }).indexUrl, DEFAULT_CONFIG.plugins.indexUrl, '只有旧默认值才搬');
  assert.deepEqual(migratePluginIndexUrl({ indexUrl: userValue, enabled: true }), { indexUrl: userValue, enabled: true }, '其余字段原样带过');
  assert.equal(migratePluginIndexUrl(null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('官方索引已搬到独立仓库：主仓库只留指路牌（避免有人照着过期副本发布）', () => {
  const stub = JSON.parse(fs.readFileSync(path.join(repo, 'plugins', 'index.json'), 'utf8'));
  assert.deepEqual(stub.plugins, [], '主仓库里不该再留一份可发布的索引副本');
  assert.match(stub.note, /qq-agent-plugins/, '要写清官方索引现在在哪');
  assert.equal(fs.existsSync(path.join(repo, 'plugins', 'packages')), false, '包也搬走了（仓库内那份在索引仓库里）');
});

test('官方插件：现打源码的 sha256 必须等于期望值（改了源码忘了重打包就红）', () => {
  // 索引与包搬到独立仓库之后，这条护栏换了个形式留在**本仓库**：
  // 期望值记在 plugins/official-packages.json，这里的"现打一份"必须与它逐字节一致。
  // ——这正是"改了源码忘了重打包"这类错误唯一能被自动发现的地方（发布时两边要一起更新）。
  const expected = JSON.parse(fs.readFileSync(path.join(repo, 'plugins', 'official-packages.json'), 'utf8'));
  const ids = Object.keys(expected.packages || {});
  // 这份清单同时是"哪些插件算官方插件"的唯一来源：examples/plugins 下的每个目录都必须有锚，
  // 锚也不许指向已经删掉的目录 —— 否则"少了一条不会被发现"（原来这里是 ids.length >= 3，
  // 补进 5 个新插件却一条锚都没有，用例照样绿）
  const dirs = fs.readdirSync(path.join(repo, 'examples', 'plugins'), { withFileTypes: true })
    .filter((item) => item.isDirectory()).map((item) => item.name).sort();
  assert.deepEqual([...ids].sort(), dirs,
    'examples/plugins 下的每个插件都要在 plugins/official-packages.json 里有锚（反之不许留孤儿锚）');
  for (const id of ids) {
    const fresh = packPluginDir({ dir: path.join(repo, 'examples', 'plugins', id) });
    assert.equal(fresh.ok, true, `${id} 应能打包`);
    assert.equal(fresh.manifest.id, id);
    assert.equal(fresh.manifest.version, expected.packages[id].version,
      `${id} 的 manifest 版本与期望值不一致（发布时忘了同步 plugins/official-packages.json？）`);
    assert.equal(fresh.sha256, expected.packages[id].sha256,
      `${id} 现打源码的 sha256 与期望值不一致：改了源码要重新打包并同步期望值与索引仓库`);
  }
});

test('市场字段归一化：地址字段只收 http(s)，其余按形状收敛（缺了不影响安装）', () => {
  const result = normalize(entry({
    icon: 'javascript:alert(1)',
    homepage: 'data:text/html,<script>',
    readmeUrl: 'ftp://x/y.md',
    changelogUrl: 'https://example.com/changes.md',
    screenshots: ['https://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 42],
    mirrors: ['https://mirror.example/demo.tar.gz', 'http://ok.example/x', 'file:///etc/passwd'],
    readme: 'x'.repeat(5000),
    size: '12.5',
    downloads: -3,
    updatedAt: '2026-10-16',
    category: '工具'
  }));
  assert.equal(result.ok, true, `字段形状不影响"能不能装"：${result.reason || ''}`);
  const item = result.entry;
  assert.equal(item.icon, '', '图标不是 http(s) 就置空（界面降级成字母块）');
  assert.equal(item.homepage, '', '主页不是 http(s) 就置空（控制台会把它做成可点链接）');
  assert.equal(item.readmeUrl, '', '说明链接同上');
  assert.equal(item.changelogUrl, 'https://example.com/changes.md', '合法的地址要留着');
  assert.deepEqual(item.screenshots, ['https://example.com/a.png'],
    '截图只留 http(s) 字符串（javascript:/data:/非字符串一律丢掉）');
  assert.deepEqual(item.mirrors, ['https://mirror.example/demo.tar.gz', 'http://ok.example/x'],
    '镜像地址同样只收 http(s)：http 与 https 都留，file:// 这类丢掉');
  assert.equal(item.readme.length, 4000, 'README 正文要有长度上限（详情页要显示它）');
  assert.equal(item.size, 12, '包大小取整（界面按 KB 显示，小数点没意义）');
  assert.equal(item.downloads, 0, '下载量是数字或 0（负数收敛掉 —— 界面会直接插值显示）');
  assert.equal(item.updatedAt, '2026-10-16');
  assert.equal(item.category, '工具');
});

test('索引里的撤回条目：标成装不了并说清原因（集中下架不需要每台机器改配置）', () => {
  const revoked = normalize(entry({ revoked: true, revokedReason: '被举报：往群里发广告' }));
  assert.equal(revoked.ok, true, '撤回的条目仍然要能读出来（列出来才能告诉用户"它被撤了"）');
  assert.equal(revoked.entry.compatible, false, '撤回的条目列出来但装不了');
  assert.match(revoked.entry.reason, /已被撤回：被举报/);
  assert.match(revoked.entry.revoked, /被举报/, '原因要能透给界面（用户要知道为什么）');
  const plain = normalize(entry({ revoked: true })).entry;
  assert.equal(plain.revoked, '索引里已撤回', '没给原因也要有一句默认说明，不能是空字符串');
});

test('集中撤回名单：拉取失败**不许清空**旧的（fail-open 会让下架的插件悄悄复活）', () => {
  // 这条钉的是一个 fail-open：fetchPluginIndexes 对每个来源单独 catch，失败时返回空 plugins，
  // 若拿它覆盖缓存，"某个来源拉不动"就等于"没人被撤回" —— 被下架的插件立刻恢复工具、
  // observe 与周期任务，而且没有任何提示。索引抖动比下架常见得多，所以这是最该守住的一格。
  const cache = createIndexRevokedCache();
  assert.deepEqual(cache.rules(), [], '一开始没有名单');
  cache.update({ sources: [{ url: 'a', ok: true, count: 1 }], plugins: [{ id: 'bad', version: '1.0.0', revoked: true }] });
  assert.deepEqual(cache.rules(), ['bad@1.0.0'], '拉到了就记下这一条');

  cache.update({ sources: [{ url: 'a', ok: false, error: '超时' }], plugins: [] });
  assert.deepEqual(cache.rules(), ['bad@1.0.0'], '全失败：沿用上一次的名单（拉不动 ≠ 没撤回）');

  cache.update({ sources: [{ url: 'a', ok: false, error: '超时' }, { url: 'b', ok: false, error: 'DNS' }], plugins: [] });
  assert.deepEqual(cache.rules(), ['bad@1.0.0'], '多个来源全失败也一样');

  // 有一个来源成功：按它的结果刷新（撤回被解除时也要跟着解除，否则名单只增不减）
  cache.update({ sources: [{ url: 'a', ok: false }, { url: 'b', ok: true, count: 1 }], plugins: [] });
  assert.deepEqual(cache.rules(), [], '有来源成功就要按新结果来（撤回是可以解除的）');
});

test('集中撤回名单：条目是版本粒度的（撤 1.0.0 不该连作者修好的 1.1.0 一起撤）', () => {
  const cache = createIndexRevokedCache();
  cache.update({ sources: [{ ok: true }], plugins: [{ id: 'bad', version: '1.0.0', revoked: true }, { id: 'other', version: '2.0.0' }] });
  assert.deepEqual(cache.rules(), ['bad@1.0.0'], '只撤被标的那一版（与本地 plugins.revoked 的 id@版本 同一语义）');
  // 没有版本的条目（理论上不该有）退化成裸 id，至少不会漏撤
  const cache2 = createIndexRevokedCache();
  cache2.update({ sources: [{ ok: true }], plugins: [{ id: 'odd', revoked: true }] });
  assert.deepEqual(cache2.rules(), ['odd']);
});

test('注册表：索引侧的撤回名单与本机配置取并集（两边任一命中都不许跑）', async (t) => {
  const fixtures = path.join(repo, 'test', 'fixtures', 'plugins');
  const cfg = { plugins: { enabled: true, enabledIds: ['good'] } };      // 本机配置里什么都没撤
  const registry = new PluginRegistry({
    root: fixtures, dataDir, log: () => {}, getConfig: () => cfg,
    getIndexRevoked: () => ['good@1.0.0']                                // 索引说这一版被撤了
  });
  t.after(() => registry.stop());
  assert.deepEqual((await registry.start()).started, [], '索引侧撤回的版本不许加载');
  assert.deepEqual(registry.toolDefsFor(), [], '也不许把工具交给模型');
  const listed = registry.list().plugins.find((p) => p.id === 'good');
  assert.equal(listed.revoked, 'good@1.0.0', '列表里要能看到"它在撤回名单里"（不是悄悄消失）');
});

test('索引这次拉不到时：回落给"上次成功读到的"，并带出原因与时间（市场不该变空）', () => {
  // 索引挂在第三方托管（GitHub raw）上，从自建服务器拉它偶发超时是常态 —— 2026-10-16 生产实测：
  // 同一 URL 用 curl 2.5s 成功，而控制台那一次超时，于是**整个市场变成空的**。
  // 索引内容一个月才变几次，"这次没拉到"绝不该等于"没有插件可装"。
  const good = { plugins: [{ id: 'demo', version: '1.0.0' }, { id: 'demo2', version: '1.0.0' }], sources: [{ name: '官方索引', ok: true, count: 2 }] };
  const lastGood = { at: 1_700_000_000_000, result: good };
  const failed = { plugins: [], sources: [{ name: '官方索引', ok: false, count: 0, error: '请求超时：raw.githubusercontent.com' }] };

  const shown = indexResultForDisplay(failed, lastGood);
  assert.equal(shown.plugins.length, 2, '拉不到时要给上次读到的那份，而不是空市场');
  assert.equal(shown.stale, true);
  assert.equal(shown.staleAt, lastGood.at, '要带出"这份是多久以前读到的"');
  assert.match(shown.staleReason, /超时/, '要把失败原因带出来，界面要如实说明');

  // 拿到了就照实给新的（哪怕条数比上次少 —— 索引真的删条目时要能反映出来）
  const fresh = { plugins: [{ id: 'only', version: '2.0.0' }], sources: [{ name: '官方索引', ok: true, count: 1 }] };
  const shown2 = indexResultForDisplay(fresh, lastGood);
  assert.deepEqual(shown2, fresh);
  assert.ok(!shown2.stale, '成功刷新不该带 stale');

  // 没有"上次成功"的历史时，只能如实给空的（不能编）
  assert.deepEqual(indexResultForDisplay(failed, null), failed);
  // 多来源里只要有一个成功，就是新数据（不算 stale）
  const partial = { plugins: [{ id: 'a', version: '1.0.0' }], sources: [{ ok: false, error: '超时' }, { ok: true, count: 1 }] };
  assert.ok(!indexResultForDisplay(partial, lastGood).stale, '有来源成功就算拿到了');
});

test('索引体检脚本：官方索引通过；坏索引报出对应问题并不给 0 退出码', (t) => {
  const run = (args) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'plugin-index-check.mjs'), ...args],
    { cwd: repo, encoding: 'utf8' });
  const good = run([]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /可以上架/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-index-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'index.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    plugins: [
      entry({ id: 'dup-plugin' }),
      entry({ id: 'dup-plugin' }),
      entry({ id: 'no-sha-plugin', sha256: '' }),
      entry({ id: 'future-plugin', minVersion: '99.0.0' })
    ]
  }));
  const bad = run([file]);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /E_DUPLICATE/);
  assert.match(bad.stdout, /E_ENTRY/);
  assert.match(bad.stdout, /W_INCOMPATIBLE/);
  // 缺文件的用法错误也要说清，而不是抛栈
  const missing = run([path.join(dir, 'nope.json')]);
  assert.equal(missing.status, 1);
  assert.match(`${missing.stdout}${missing.stderr}`, /E_READ/);
});

test('启动时先取一次索引再加载插件：否则重启后没人打开插件页，被撤回的插件会照跑一整个进程生命周期', () => {
  // 撤回是集中下架（索引改一次，所有机器下次读到就生效）—— 但"下次读到"必须真的发生在加载之前。
  // 这条钉的是顺序：warmPluginIndexForRevocation() 在 pluginRegistry.start() 之前 await，
  // 且有一个周期刷新把"后来才撤回"补上（长期运行的进程不该等到有人打开页面）。
  const app = fs.readFileSync(new URL('../src/console/app.js', import.meta.url), 'utf8');
  const warm = app.indexOf('await warmPluginIndexForRevocation()');
  const start = app.indexOf('await pluginRegistry.start();');
  assert.ok(warm > 0, '启动流程里要有"先取索引（只为撤回名单）"这一步');
  assert.ok(start > 0, '启动流程里要有 pluginRegistry.start()');
  assert.ok(warm < start, '取索引必须在加载插件之前（顺序反了就等于没做）');
  assert.match(app, /startPluginIndexRefresh\(\);/, '启动后要挂周期刷新');
  assert.match(app, /pluginRegistry\.reconfigure\(\)[\s\S]{0,120}集中撤回名单有更新/,
    '名单变了要重排（被撤回的停、被解禁的起）');
});

test('撤回名单在运行中变化会重排：启动时 5 秒竞速失败也不至于一直跑到进程结束', () => {
  const app = fs.readFileSync(new URL('../src/console/app.js', import.meta.url), 'utf8');
  // 插件路由已拆到 routes/plugins.js（2026-10-31 M2），启用/安装失败这两处断言在那边
  const routes = fs.readFileSync(new URL('../src/console/routes/plugins.js', import.meta.url), 'utf8');
  assert.match(app, /const rulesBefore = indexRevokedRules\(\)/, '更新前要拍一份旧名单');
  assert.match(app, /if \(applyRevocation && pluginsStarted && rulesAfter !== rulesBefore\)/, '运行中名单变化要触发重排');
  assert.match(app, /loadPluginIndex\(\{ applyRevocation: false \}\)/, '启用路由自己会重排，别让加载再排一次');
  assert.match(app, /pluginsStarted = true;/, '启动成功后置位');
  assert.match(routes, /if \(body\.enabled === true\) await loadIndex\(\{ applyRevocation: false \}\)/, '启用前先尽力拿一次名单');
  assert.match(app, /loadPluginIndex\(\{ applyRevocation: false \}\)\.then/, '6 小时定时刷新只重排一次');
  // 安装失败但没动过目录时不要重排（重排会停掉所有插件、打断在途工具调用）
  assert.match(routes, /if \(replaced\) await pluginRegistry\.reconfigure\(\)/,
    '只有真的换过目录才需要恢复重排');
});

test('撤回名单落盘：重启后索引拉不到也沿用（kill switch 不随进程消失）', () => {
  const file = path.join(dataDir, 'revoked-cache-test.json');
  const first = createIndexRevokedCache({ file });
  first.update({
    sources: [{ url: 'https://example.com/index.json', ok: true }],
    revoked: [{ url: 'https://example.com/index.json', rules: ['demo-plugin@1.0.0'] }]
  });
  assert.deepEqual(first.rules(), ['demo-plugin@1.0.0']);
  assert.equal(fs.existsSync(file), true, '规则要落盘');

  const second = createIndexRevokedCache({ file });
  assert.deepEqual(second.rules(), ['demo-plugin@1.0.0'], '新进程从磁盘恢复');
  const afterFailure = second.update({
    sources: [{ url: 'https://example.com/index.json', ok: false }],
    revoked: []
  });
  assert.deepEqual(afterFailure, ['demo-plugin@1.0.0'], '索引拉不动时沿用上次规则');
});

test('移除索引来源后规则立即失效（即使其余来源都拉不到）', () => {
  const file = path.join(dataDir, 'revoked-remove-test.json');
  const cache = createIndexRevokedCache({ file });
  cache.update({
    sources: [{ url: 'https://a.example/index.json', ok: true }],
    revoked: [{ url: 'https://a.example/index.json', rules: ['demo@1.0.0'] }]
  });
  assert.deepEqual(cache.rules(), ['demo@1.0.0']);

  const afterRemove = cache.update({
    sources: [{ url: 'https://b.example/index.json', ok: false }],
    revoked: [],
    configured: ['https://b.example/index.json']
  });
  assert.deepEqual(afterRemove, [], 'A 已被移除，不能继续用 A 的规则（即使 B 拉不到）');

  assert.deepEqual(cache.update({ sources: [], configured: [] }), [], '清空所有来源也不保留旧规则');
});

test('清空索引来源后，启动路径也会清空撤回规则', () => {
  const app = fs.readFileSync(new URL('../src/console/app.js', import.meta.url), 'utf8');
  assert.match(app, /indexRevokedCache\.update\(\{ sources: \[\], configured: \[\] \}\)/,
    '无来源分支要清空规则并落盘');
  assert.match(app, /pluginIndexCache = \{ key: '', at: 0, result: \{ plugins: \[\], skipped: \[\], sources: \[\] \} \}/,
    '无来源分支还要清 10 分钟缓存，否则加回同一来源会跳过撤回名单更新');
  const warmAt = app.indexOf('const warmPluginIndexForRevocation');
  assert.ok(warmAt > 0, 'warmPluginIndexForRevocation 的结构变了就更新这条用例');
  const slice = app.slice(warmAt, warmAt + 800);
  assert.ok(slice.includes('await loadPluginIndex()'),
    '启动预热在无来源时也要走 loadPluginIndex，否则磁盘里的旧规则会继续拒载插件');
});

test('撤回名单缓存损坏时改名留档，并按空名单启动', () => {
  const file = path.join(dataDir, 'revoked-corrupt-test.json');
  fs.writeFileSync(file, '{not-json');
  const cache = createIndexRevokedCache({ file });
  assert.deepEqual(cache.rules(), []);
  assert.equal(fs.existsSync(file), false, '坏文件被改名');
  assert.ok(fs.readdirSync(dataDir).some((name) => name.startsWith('revoked-corrupt-test.json.broken-')),
    '要留下坏文件供排查');
});
