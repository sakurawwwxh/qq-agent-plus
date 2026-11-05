// 本地文件安装（「别人发我一个包 / 我自己打了一个包」的最短路径）：
// 控制台的 install-file 路由 + `ops plugins install <文件>` 两条入口。
//
// 为什么这条值得单独测：它绕开了"必须有公开 URL"这个前提，是小白唯一走得通的路
// （索引要 push 之后才有内容、手动填地址要用户自己找 URL 和 sha256、拷目录要 SSH）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-local-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { packPluginDir } = await import('../src/plugins/pack.js');
const { readPluginInstallInfo, sha256Of } = await import('../src/plugins/install.js');
const { grantApproval } = await import('../src/plugins/grants.js');

const packed = packPluginDir({ dir: path.join(repo, 'examples', 'plugins', 'weather') });

const freePort = async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

test('控制台：把包当文件传上去就能装（服务端算 sha256 并回传），来源记录写"本地文件"', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.plugins = { ...cfg.plugins, enabled: false, enabledIds: [] };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  const good = await post('/api/plugins/install-file', {
    fileName: 'weather-1.0.0.tar.gz', base64: packed.buffer.toString('base64')
  });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.id, 'weather');
  assert.equal(good.body.version, '1.0.0');
  assert.equal(good.body.sha256, sha256Of(packed.buffer), '服务端要算内容指纹回传（界面上给用户核对）');
  assert.equal(good.body.fileName, 'weather-1.0.0.tar.gz');
  const record = readPluginInstallInfo({ dataDir, id: 'weather' });
  assert.equal(record.source, '本地文件：weather-1.0.0.tar.gz');
  assert.equal(record.sha256, sha256Of(packed.buffer));

  // 同 id 升级且权限面变化：先 409 + diff，必须带 diffHash 重试才换入。
  // 控制台「安装文件」的二次确认就是靠这个 409 拿 diff 的。
  const v2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-v2-'));
  t.after(() => fs.rmSync(v2Dir, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, 'examples', 'plugins', 'weather'), v2Dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(v2Dir, 'plugin.json'), 'utf8'));
  manifest.version = '1.0.1';
  // httpDomains 只在 apiVersion 2 下生效；升级同时抬高 apiVersion → 权限面必然变化。
  manifest.apiVersion = 2;
  manifest.httpDomains = ['api.example.com'];
  fs.writeFileSync(path.join(v2Dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  const packedV2 = packPluginDir({ dir: v2Dir });
  const confirm = await post('/api/plugins/install-file', {
    fileName: 'weather-1.0.1.tar.gz', base64: packedV2.buffer.toString('base64')
  });
  assert.equal(confirm.status, 409, JSON.stringify(confirm.body));
  assert.equal(confirm.body.code, 'E_UPGRADE_CONFIRM');
  assert.equal(confirm.body.diff?.permissionChanged, true);
  assert.ok(confirm.body.diff?.diffHash, '409 必须回传 diffHash，控制台才能二次确认');
  const upgraded = await post('/api/plugins/install-file', {
    fileName: 'weather-1.0.1.tar.gz',
    base64: packedV2.buffer.toString('base64'),
    expectedDiffHash: confirm.body.diff.diffHash
  });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.body));
  assert.equal(upgraded.body.version, '1.0.1');

  // 坏输入：空内容 / 乱内容 → 明确报错（不落盘、不假装成功）
  const empty = await post('/api/plugins/install-file', { fileName: 'x.tar.gz', base64: '' });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /没有收到文件内容/);
  const junk = await post('/api/plugins/install-file', { fileName: 'x.tar.gz', base64: 'not-a-package' });
  assert.equal(junk.status, 400);
  assert.ok(junk.body.error, '乱内容要给出可读原因');
});

test('命令行：ops plugins install <文件> 装得上，list 能看到来源并提醒"装上≠授权"', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-ops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'weather-1.0.0.tar.gz');
  fs.writeFileSync(file, packed.buffer);
  const run = (args) => spawnSync(process.execPath, [path.join(repo, 'src', 'ops.js'), ...args],
    { cwd: repo, encoding: 'utf8' });

  const install = run(['plugins', 'install', file, `--data=${dir}`]);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.match(install.stdout, /插件 weather v1\.0\.0/);
  assert.match(install.stdout, /sha256/, '要打印算出来的内容指纹供核对');
  assert.match(install.stdout, new RegExp(sha256Of(packed.buffer).slice(0, 16)));
  assert.ok(fs.existsSync(path.join(dir, 'plugins', 'weather', 'plugin.json')), '包要真解开');

  const list = run(['plugins', 'list', `--data=${dir}`]);
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.match(list.stdout, /weather v1\.0\.0/);
  assert.match(list.stdout, /来源 本地文件/);
  assert.match(list.stdout, /装上 ≠ 授权/, '要提醒装上不等于授权（否则用户以为装完就跑起来了）');

  // 旧清单损坏 + force：CLI 也必须走“按权限变化清授权”的收口，不能只换文件。
  grantApproval(dir, 'weather', 'write', { target: 'x' });
  fs.writeFileSync(path.join(dir, 'plugins', 'weather', 'plugin.json'), '{"id":"weather",');
  const forced = run(['plugins', 'install', file, `--data=${dir}`, '--force']);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(forced.stdout, /重新授权|授权/, 'force 覆盖要提示重新授权');
  const grants = JSON.parse(fs.readFileSync(path.join(dir, 'plugin-grants', 'weather.json'), 'utf8'));
  assert.deepEqual(grants.approvals, [], '旧授权必须清掉');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'plugins', 'weather', 'plugin.json'), 'utf8')).version, '1.0.0');

  // 文件不存在 / 不是包：报错而不是静默成功
  assert.equal(run(['plugins', 'install', path.join(dir, 'nope.tar.gz'), `--data=${dir}`]).status, 1);
  const junkFile = path.join(dir, 'junk.tar.gz');
  fs.writeFileSync(junkFile, 'not a package');
  const junk = run(['plugins', 'install', junkFile, `--data=${dir}`]);
  assert.equal(junk.status, 1);
  assert.match(junk.stdout + junk.stderr, /安装失败/);
});
