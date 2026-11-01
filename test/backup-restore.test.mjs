import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/core/sqlite.js';

const OPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ops.js');
const KEY = 'a'.repeat(64);
const WRONG = 'b'.repeat(64);
const tarAvailable = spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0;
const skipTar = tarAvailable ? false : '本机缺少 tar，无法验证备份/恢复';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-backup-restore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function seedDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{"server":{"token":"restore-me"}}\n');
  const db = openDatabase(path.join(dir, 'messages.sqlite'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER); INSERT INTO t VALUES (1);');
  } finally {
    db.close();
  }
}

function runOps(args, { key = KEY } = {}) {
  return spawnSync(process.execPath, [OPS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, QQ_AGENT_BACKUP_KEY: key, QQ_AGENT_SERVICE: 'qq-agent-missing-test' },
    timeout: 120000
  });
}

function newest(dir, ext) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(ext)).sort().at(-1) || '';
}

test('加密备份 -> 演练 -> 恢复 -> 错密钥拒绝', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const data = path.join(root, 'data');
  const backups = path.join(root, 'backups');
  seedDataDir(data);

  const backup = runOps(['backup', '--confirm', '--data', data, '--backup-dir', backups]);
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const encName = newest(backups, '.tar.gz.enc');
  assert.ok(encName, '应生成 .tar.gz.enc');
  assert.equal(fs.existsSync(path.join(backups, 'qq-agent-data-' + encName.split('qq-agent-data-')[1].replace('.enc', ''))), false,
    '明文 tar.gz 不应留在备份目录');

  const drill = runOps(['backup', '--drill', '--data', data, '--backup-dir', backups]);
  assert.equal(drill.status, 0, drill.stderr || drill.stdout);

  const restored = path.join(root, 'restored');
  const restore = runOps(['restore', '--from', path.join(backups, encName), '--data', restored, '--confirm']);
  assert.equal(restore.status, 0, restore.stderr || restore.stdout);
  assert.equal(fs.readFileSync(path.join(restored, 'config.json'), 'utf8'), '{"server":{"token":"restore-me"}}\n');
  const db = openDatabase(path.join(restored, 'messages.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    assert.equal(Object.values(row)[0], 'ok');
  } finally {
    db.close();
  }

  const bad = path.join(root, 'bad');
  const wrongKey = runOps(['restore', '--from', path.join(backups, encName), '--data', bad, '--confirm'], { key: WRONG });
  assert.notEqual(wrongKey.status, 0, '错误密钥必须失败');
  assert.equal(fs.existsSync(bad), false, '解密失败不应创建目标目录');
});

test('--no-encrypt 仍可备份/恢复；恢复没有 --confirm 直接拒绝', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const data = path.join(root, 'data');
  const backups = path.join(root, 'backups');
  seedDataDir(data);

  const backup = runOps(['backup', '--confirm', '--no-encrypt', '--data', data, '--backup-dir', backups]);
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const name = newest(backups, '.tar.gz');
  assert.ok(name, '应生成明文 .tar.gz');

  const refused = runOps(['restore', '--from', path.join(backups, name), '--data', path.join(root, 'x')]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /--confirm/);

  const restored = path.join(root, 'restored');
  const restore = runOps(['restore', '--from', path.join(backups, name), '--data', restored, '--confirm', '--no-encrypt']);
  assert.equal(restore.status, 0, restore.stderr || restore.stdout);
  assert.equal(fs.existsSync(path.join(restored, 'config.json')), true);
});

test('恢复前发现数据目录仍被实例占用（锁存活）必须拒绝，未停服不覆盖', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const source = path.join(root, 'source');
  const backups = path.join(root, 'backups');
  seedDataDir(source);
  const backup = runOps(['backup', '--confirm', '--data', source, '--backup-dir', backups]);
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const arch = path.join(backups, newest(backups, '.tar.gz.enc'));

  const target = path.join(root, 'target');
  seedDataDir(target);
  const lock = path.join(target, '.server.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: Date.now() }));

  const refused = runOps(['restore', '--from', arch, '--data', target, '--confirm']);
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(`${refused.stdout}${refused.stderr}`, /仍被实例占用/);
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"server":{"token":"restore-me"}}\n',
    '拒绝时不能动目标目录');

  fs.rmSync(lock, { force: true });
  const ok = runOps(['restore', '--from', arch, '--data', target, '--confirm']);
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
});

test('备份前发现数据目录仍被实例占用（锁存活）必须中止，不生成归档', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const data = path.join(root, 'data');
  const backups = path.join(root, 'backups');
  seedDataDir(data);
  fs.writeFileSync(path.join(data, '.server.lock'), JSON.stringify({
    pid: process.pid, hostname: os.hostname(), startedAt: Date.now()
  }));
  const backup = runOps(['backup', '--confirm', '--data', data, '--backup-dir', backups]);
  assert.notEqual(backup.status, 0, backup.stdout + backup.stderr);
  assert.match(`${backup.stdout}${backup.stderr}`, /仍被实例占用/);
  assert.equal(fs.existsSync(backups) ? newest(backups, '.enc') : '', '', '不应生成归档');
});
