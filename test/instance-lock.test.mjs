// 数据目录单实例锁（2026-10-31 复审）：
// 同一数据目录第二个实例必须拒绝启动；陈旧 pid / 损坏锁自动接管；stop 只删自己的锁。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-instance-lock-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.QQ_AGENT_SKIP_INDEX_WARM = '1';
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { acquireInstanceLock } = await import('../src/core/instance-lock.js');
const lockModuleUrl = pathToFileURL(path.resolve('src/core/instance-lock.js')).href;

/** 从**另一个进程**尝试拿锁；返回 { code, out }。 */
function acquireInChild(dir) {
  const script = `import { acquireInstanceLock } from ${JSON.stringify(lockModuleUrl)};
    try { const h = acquireInstanceLock(${JSON.stringify(dir)}); h.release(); console.log('ACQUIRED'); }
    catch (error) { console.log(error.code || error.message); process.exit(3); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function lockFile(dir) { return path.join(dir, '.server.lock'); }
function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('跨进程互斥；同进程可重入；release 后可重新获取', () => {
  const dir = path.join(root, 'unit');
  const first = acquireInstanceLock(dir);
  assert.equal(fs.existsSync(lockFile(dir)), true);
  const child = acquireInChild(dir);
  assert.equal(child.code, 3, child.out);
  assert.match(child.out, /E_INSTANCE_LOCKED/);

  // 同进程重入：测试/脚本会在一个进程里创建多个 createApp
  const second = acquireInstanceLock(dir);
  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(lockFile(dir)), true, '还剩一个持有者，锁不能提前删');
  assert.equal(second.release(), true);
  assert.equal(fs.existsSync(lockFile(dir)), false);

  const third = acquireInstanceLock(dir);
  assert.equal(third.release(), true);
});

test('陈旧 pid 与损坏锁自动接管；不同主机的锁不接管', () => {
  const staleDir = path.join(root, 'stale');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(lockFile(staleDir), JSON.stringify({ pid: 2147483647, hostname: os.hostname(), startedAt: 1 }));
  const stolen = acquireInstanceLock(staleDir);
  assert.equal(stolen.release(), true);

  const brokenDir = path.join(root, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(lockFile(brokenDir), '{not-json');
  // 刚写出的损坏锁可能是别的进程"正在创建"：要过了 5 秒窗口才允许接管。
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lockFile(brokenDir), old, old);
  const recovered = acquireInstanceLock(brokenDir);
  assert.equal(recovered.release(), true);

  const foreignDir = path.join(root, 'foreign');
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(lockFile(foreignDir), JSON.stringify({
    pid: process.pid, hostname: 'another-host', startedAt: 1
  }));
  assert.throws(() => acquireInstanceLock(foreignDir), (error) => error.code === 'E_INSTANCE_LOCKED');
});

test('同一 PID 的遗留锁可接管（Docker + init 重启后 node 仍是 PID 2）', () => {
  const dir = path.join(root, 'selfpid');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify({
    pid: process.pid, hostname: os.hostname(), startedAt: Date.now() - 60_000
  }));
  const handle = acquireInstanceLock(dir);
  assert.equal(handle.release(), true);
});

test('进程正常退出时自动释放锁（不依赖显式 stop）', () => {
  const dir = path.join(root, 'exit-hook');
  const script = `import { acquireInstanceLock } from ${JSON.stringify(lockModuleUrl)};
    acquireInstanceLock(${JSON.stringify(dir)});
    console.log('ACQUIRED');
    process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(lockFile(dir)), false, 'exit 钩子要删掉自己的锁');
  const handle = acquireInstanceLock(dir);
  assert.equal(handle.release(), true);
});

test('release 不会删掉别的进程的锁', () => {
  const dir = path.join(root, 'mismatch');
  const handle = acquireInstanceLock(dir);
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid + 1, hostname: os.hostname(), startedAt: 2 }));
  assert.equal(handle.release(), false);
  assert.equal(fs.existsSync(lockFile(dir)), true);
});

test('createApp().start() 持锁，stop() 释放；运行中第二个实例起不来', async () => {
  const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
  const { createApp } = await import('../src/console/app.js');
  const port = await freePort();
  updateConfig({
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port, token: '' },
    runtime: { ...DEFAULT_CONFIG.runtime, mode: 'observe' },
    onebot: { ...DEFAULT_CONFIG.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' }
  });
  const app = createApp({ log: () => {} });
  try {
    await app.start();
    assert.equal(fs.existsSync(lockFile(root)), true, 'start 成功后要留下锁');
    const child = acquireInChild(root);
    assert.equal(child.code, 3, child.out);
    assert.match(child.out, /E_INSTANCE_LOCKED/);
  } finally {
    await app.stop();
  }
  assert.equal(fs.existsSync(lockFile(root)), false, 'stop 后要释放锁');
  const again = acquireInstanceLock(root);
  assert.equal(again.release(), true);
});


test('server.singleInstanceLock=false：不建锁，第二个进程也能启动', async () => {
  const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
  const { createApp } = await import('../src/console/app.js');
  const port = await freePort();
  updateConfig({
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port, token: '', singleInstanceLock: false },
    runtime: { ...DEFAULT_CONFIG.runtime, mode: 'observe' },
    onebot: { ...DEFAULT_CONFIG.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' }
  });
  const app = createApp({ log: () => {} });
  try {
    await app.start();
    assert.equal(fs.existsSync(lockFile(root)), false, '关闭后不应创建锁文件');
    const child = acquireInChild(root);
    assert.equal(child.code, 0, child.out);
  } finally {
    await app.stop();
  }
});


test('并发接管陈旧锁：两个进程同时抢，只能有一个成功', async () => {
  const dir = path.join(root, 'race');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: 2147483647, hostname: os.hostname(), startedAt: 1 }));
  const script = `import { acquireInstanceLock } from ${JSON.stringify(lockModuleUrl)};
    try {
      const h = acquireInstanceLock(${JSON.stringify(dir)});
      console.log('ACQUIRED');
      await new Promise((resolve) => setTimeout(resolve, 400));
      h.release();
      process.exit(0);
    } catch (error) { console.log(error.code || error.message); process.exit(3); }`;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  const winners = [a, b].filter((r) => /ACQUIRED/.test(r.out));
  const losers = [a, b].filter((r) => /E_INSTANCE_LOCKED/.test(r.out));
  assert.equal(winners.length, 1, `必须恰好一个成功：${a.out} | ${b.out}`);
  assert.equal(losers.length, 1, `另一个必须被拒：${a.out} | ${b.out}`);
});
