import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { acquireMaintenanceLock, createSignalGuard } = await import('../src/core/maintenance.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-maint-'));
const lockPathFor = (dataDir) => path.join(path.dirname(dataDir), `.${path.basename(dataDir)}.maintenance.lock`);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('维护锁：同一数据目录只允许一个持有者，release 后可再次获取', () => {
  const lock = acquireMaintenanceLock(dir, { kind: 'backup' });
  assert.equal(fs.existsSync(lock.file), true);
  assert.throws(() => acquireMaintenanceLock(dir, { kind: 'restore' }), (error) => {
    assert.equal(error.code, 'E_MAINTENANCE_BUSY');
    assert.match(error.message, /backup.*pid/);
    return true;
  });
  lock.release();
  assert.equal(fs.existsSync(lock.file), false);
  const again = acquireMaintenanceLock(dir, { kind: 'restore' });
  again.release();
});

test('维护锁：同主机死 pid 的陈旧锁可自动接管，跨主机按时间上限接管', () => {
  const lockFile = lockPathFor(dir);
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: 999999, hostname: os.hostname(), kind: 'backup', startedAt: Date.now()
  }));
  const taken = acquireMaintenanceLock(dir, { kind: 'restore' });
  assert.equal(taken.owner.kind, 'restore');
  taken.release();

  fs.writeFileSync(lockFile, JSON.stringify({
    pid: process.pid, hostname: 'another-host', kind: 'backup', startedAt: Date.now() - 7 * 60 * 60 * 1000
  }));
  const aged = acquireMaintenanceLock(dir, { kind: 'restore' });
  assert.equal(aged.owner.kind, 'restore');
  aged.release();
});

test('维护锁：损坏/半写的锁一分钟后可接管', () => {
  const lockFile = lockPathFor(dir);
  fs.writeFileSync(lockFile, '{"pid":');
  const old = new Date(Date.now() - 2 * 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const lock = acquireMaintenanceLock(dir, { kind: 'backup' });
  lock.release();
});

test('信号守卫：注册/注销 SIGINT/SIGTERM/SIGHUP，未收到信号时 throwIfInterrupted 不抛', () => {
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name));
  const guard = createSignalGuard();
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name)),
    before.map((n) => n + 1));
  assert.equal(guard.interrupted, false);
  assert.doesNotThrow(() => guard.throwIfInterrupted());
  guard.dispose();
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name)), before);
});

test('维护锁：被其他持有者接手后，旧 release 不删新锁', () => {
  const lock = acquireMaintenanceLock(dir, { kind: 'backup' });
  const replacement = {
    pid: process.pid, hostname: os.hostname(), kind: 'restore', startedAt: Date.now() + 1000
  };
  fs.writeFileSync(lock.file, JSON.stringify(replacement));
  lock.release();
  assert.deepEqual(JSON.parse(fs.readFileSync(lock.file, 'utf8')), replacement,
    'release 只能删自己创建的锁，不能误删接管者的锁');
  fs.rmSync(lock.file, { force: true });
});

test('维护锁：锁文件写坏后 release 不删，交给 stale 接管', () => {
  const lock = acquireMaintenanceLock(dir, { kind: 'backup' });
  fs.writeFileSync(lock.file, '{"pid":');
  lock.release();
  assert.equal(fs.existsSync(lock.file), true, '读不出 owner 时无法证明是自己的锁，不能删');
  fs.rmSync(lock.file, { force: true });
});

test('维护锁：新鲜的 takeover 锁会挡住并发的陈旧锁接管', () => {
  const lockFile = lockPathFor(dir);
  const takeoverFile = `${lockFile}.takeover`;
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: 999999, hostname: os.hostname(), kind: 'backup', startedAt: Date.now()
  }));
  fs.writeFileSync(takeoverFile, JSON.stringify({
    pid: process.pid, hostname: os.hostname(), kind: 'restore:takeover', startedAt: Date.now()
  }));
  try {
    assert.throws(() => acquireMaintenanceLock(dir, { kind: 'restore' }), (error) => error.code === 'E_MAINTENANCE_BUSY');
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, 999999, '没抢到 takeover 的进程不能删旧锁');
  } finally {
    fs.rmSync(takeoverFile, { force: true });
    fs.rmSync(lockFile, { force: true });
  }
});

test('维护锁不创建数据目录本身（恢复目标可以不存在）', () => {
  const missing = path.join(dir, 'not-created');
  const lock = acquireMaintenanceLock(missing, { kind: 'restore' });
  assert.equal(fs.existsSync(missing), false);
  lock.release();
});
