import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPS = path.join(ROOT, 'src', 'ops.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ops-uninstall-'));

function makePlugin(id) {
  const dataDir = path.join(root, `data-${id}`);
  fs.mkdirSync(path.join(dataDir, 'plugins', id), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'plugins', id, 'plugin.json'), JSON.stringify({
    id, apiVersion: 1, name: id, version: '1.0.0', capabilities: ['tools'],
    tools: [{ name: 'ping', description: 'x', parameters: { type: 'object' } }]
  }));
  fs.mkdirSync(path.join(dataDir, 'plugin-data', id), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'plugin-data', id, 'state.json'), '{"kept":true}');
  fs.mkdirSync(path.join(dataDir, 'plugin-secrets'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'plugin-secrets', `${id}.json`), '{"token":"secret"}');
  return dataDir;
}

function run(dataDir, ...args) {
  return spawnSync(process.execPath, [OPS, 'plugins', ...args, `--data=${dataDir}`], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir }
  });
}

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('ops plugins uninstall：默认保留数据与凭据，代码移入 .removed-*', () => {
  const dataDir = makePlugin('keep-me');
  const result = run(dataDir, 'uninstall', 'keep-me', '--confirm');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(dataDir, 'plugins', 'keep-me')), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'plugin-data', 'keep-me', 'state.json'), 'utf8'), '{"kept":true}');
  assert.equal(fs.existsSync(path.join(dataDir, 'plugin-secrets', 'keep-me.json')), true);
  assert.ok(fs.readdirSync(path.join(dataDir, 'plugins')).some((name) => name.startsWith('.removed-keep-me.')));
});

test('ops plugins uninstall --purge-data：数据与凭据一起删', () => {
  const dataDir = makePlugin('purge-me');
  const result = run(dataDir, 'uninstall', 'purge-me', '--purge-data', '--confirm');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(dataDir, 'plugin-data', 'purge-me')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'plugin-secrets', 'purge-me.json')), false);
});

test('ops plugins uninstall：--dry-run / 缺 --confirm 不删任何东西', () => {
  const dataDir = makePlugin('safe-me');
  const dry = run(dataDir, 'uninstall', 'safe-me', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.equal(fs.existsSync(path.join(dataDir, 'plugins', 'safe-me')), true);
  const noConfirm = run(dataDir, 'uninstall', 'safe-me');
  assert.equal(noConfirm.status, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'plugins', 'safe-me')), true);
});

test('ops plugins uninstall：运行中的实例拒绝 CLI 卸载（避免进程继续持有已删插件）', () => {
  const dataDir = makePlugin('live-me');
  fs.writeFileSync(path.join(dataDir, '.server.lock'), JSON.stringify({
    pid: process.pid, hostname: os.hostname(), startedAt: Date.now()
  }));
  const result = run(dataDir, 'uninstall', 'live-me', '--confirm');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(`${result.stdout}${result.stderr}`, /仍被实例占用/);
  assert.equal(fs.existsSync(path.join(dataDir, 'plugins', 'live-me')), true);
});
