import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/core/sqlite.js';
import { buildTar } from './helpers/tar.mjs';

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

function runOps(args, { key = KEY, env = {} } = {}) {
  return spawnSync(process.execPath, [OPS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, QQ_AGENT_BACKUP_KEY: key, QQ_AGENT_SERVICE: 'qq-agent-missing-test', ...env },
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

test('备份演练：没有 SQLite 或 SQLite 损坏必须失败，不能假绿', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const noDb = path.join(root, 'no-db.tar.gz');
  fs.writeFileSync(noDb, buildTar([
    { name: 'config.json', data: '{"server":{"token":"x"}}' }
  ]));
  const noDbDrill = runOps(['backup', '--drill', '--from', noDb, '--no-encrypt', '--data', data]);
  assert.notEqual(noDbDrill.status, 0, noDbDrill.stdout + noDbDrill.stderr);
  assert.match(`${noDbDrill.stdout}${noDbDrill.stderr}`, /没有任何 SQLite|缺少 messages\.sqlite/);

  const corrupt = path.join(root, 'corrupt.tar.gz');
  fs.writeFileSync(corrupt, buildTar([
    { name: 'config.json', data: '{"server":{"token":"x"}}' },
    { name: 'messages.sqlite', data: 'this is not a sqlite database' }
  ]));
  const corruptDrill = runOps(['backup', '--drill', '--from', corrupt, '--no-encrypt', '--data', data]);
  assert.notEqual(corruptDrill.status, 0, corruptDrill.stdout + corruptDrill.stderr);
  assert.match(`${corruptDrill.stdout}${corruptDrill.stderr}`, /integrity_check 失败/);
});

test('--include-stack-creds 从部署路径取 snowluma/.env（不是源码父目录）', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const data = path.join(root, 'data');
  const backups = path.join(root, 'backups');
  seedDataDir(data);
  fs.mkdirSync(path.join(root, 'snowluma'), { recursive: true });
  fs.writeFileSync(path.join(root, 'snowluma/.env'), 'SNOWLUMA_SECRET=1\n');
  fs.writeFileSync(path.join(root, 'deployment-access.txt'), 'token\n');
  const backup = runOps(['backup', '--confirm', '--no-encrypt', '--include-stack-creds',
    '--data', data, '--backup-dir', backups], {
    env: {
      QQ_AGENT_DIR: root,
      QQ_AGENT_DATA_DIR: data,
      QQ_AGENT_SNOWLUMA_DIR: path.join(root, 'snowluma')
    }
  });
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const archive = path.join(backups, newest(backups, '.tar.gz'));
  // GNU tar 在 Windows 上会把盘符当远程主机，需要 --force-local；bsdtar（Windows CI）
  // 本身支持盘符且不认识这个选项。按 --version 判断，不能只看 platform。
  const tarVersion = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  const forceLocal = /GNU tar/i.test(`${tarVersion.stdout || ''}${tarVersion.stderr || ''}`)
    ? ['--force-local'] : [];
  const listed = spawnSync('tar', [...forceLocal, '-tzf', archive], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /stack-credentials\/snowluma\.env/, '必须打包 snowluma/.env');
  assert.match(listed.stdout, /stack-credentials\/deployment-access\.txt/);
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

test('恢复会清掉源主机遗留的运行态锁/中断标记', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const arch = path.join(root, 'state.tar.gz');
  fs.writeFileSync(arch, buildTar([
    { name: 'config.json', data: '{"server":{"token":"x"}}' },
    { name: '.auto-update.lock', data: '{"pid":1}' },
    { name: '.deploy-in-progress', data: '{}' },
    { name: '.deploy.lock', type: '5' },
    { name: '.deploy.lock/pid', data: '1' }
  ]));
  const target = path.join(root, 'restored');
  const res = runOps(['restore', '--from', arch, '--data', target, '--confirm', '--no-encrypt']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  for (const name of ['.auto-update.lock', '.deploy-in-progress', '.deploy.lock', '.server.lock']) {
    assert.equal(fs.existsSync(path.join(target, name)), false, `${name} 不应残留`);
  }
});

test('恢复拒绝符号链接/硬链接归档，不能把链接带进数据目录', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const arch = path.join(root, 'evil.tar.gz');
  fs.writeFileSync(arch, buildTar([
    { name: 'config.json', data: '{"server":{"token":"x"}}' },
    { name: 'messages.sqlite', type: '2', linkname: '/etc/passwd' }
  ]));
  const target = path.join(root, 'restored');
  const res = runOps(['restore', '--from', arch, '--data', target, '--confirm', '--no-encrypt']);
  assert.notEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(`${res.stdout}${res.stderr}`, /不允许的条目类型|不安全/);
  assert.equal(fs.existsSync(path.join(target, 'config.json')), false, '校验失败不能落盘');
});

test('备份拒绝数据目录内的符号链接/硬链接：不能生成恢复侧会拒绝的归档', {
  skip: skipTar || (process.platform === 'win32' ? 'Windows 创建链接需要额外权限，改在 Linux/CI 验证' : false)
}, (t) => {
  for (const [label, make] of [
    ['symlink', (data) => fs.symlinkSync('config.json', path.join(data, 'linked'))],
    ['hardlink', (data) => fs.linkSync(path.join(data, 'config.json'), path.join(data, 'linked'))]
  ]) {
    const root = tempDir(t);
    const data = path.join(root, 'data');
    const backups = path.join(root, 'backups');
    seedDataDir(data);
    make(data);
    const backup = runOps(['backup', '--confirm', '--data', data, '--backup-dir', backups]);
    assert.notEqual(backup.status, 0, `${label}: ${backup.stdout}${backup.stderr}`);
    assert.match(`${backup.stdout}${backup.stderr}`, /不允许的条目类型|备份作废/, label);
    assert.equal(fs.existsSync(backups) ? newest(backups, '.enc') : '', '', `${label}: 不应留下不可恢复的归档`);
  }
});

test('恢复拒绝硬链接与 FIFO 条目', {
  skip: skipTar || (process.platform === 'win32' ? 'Windows tar 对绝对盘符路径的兼容问题，改在 Linux/CI 验证' : false)
}, (t) => {
  const root = tempDir(t);
  for (const [label, type, linkname] of [['hardlink', '1', 'config.json'], ['fifo', '6', '']]) {
    const arch = path.join(root, `${label}.tar.gz`);
    fs.writeFileSync(arch, buildTar([
      { name: 'config.json', data: '{"server":{"token":"x"}}' },
      { name: 'shadow', type, linkname, data: '' }
    ]));
    const target = path.join(root, `out-${label}`);
    const res = runOps(['restore', '--from', arch, '--data', target, '--confirm', '--no-encrypt']);
    assert.notEqual(res.status, 0, `${label}: ${res.stdout}${res.stderr}`);
    assert.match(`${res.stdout}${res.stderr}`, /不允许的条目类型/);
    assert.equal(fs.existsSync(path.join(target, 'config.json')), false, label);
  }
});

test('恢复拒绝 Windows 尾随点/空格与反斜杠路径', { skip: skipTar }, (t) => {
  const root = tempDir(t);
  const arch = path.join(root, 'evil-path.tar.gz');
  fs.writeFileSync(arch, buildTar([
    { name: 'config.json', data: '{"server":{"token":"x"}}' },
    { name: 'a/.. /config.json', data: 'evil' }
  ]));
  const target = path.join(root, 'restored');
  const res = runOps(['restore', '--from', arch, '--data', target, '--confirm', '--no-encrypt']);
  assert.notEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(`${res.stdout}${res.stderr}`, /不安全/);
  assert.equal(fs.existsSync(path.join(target, 'config.json')), false);
});
