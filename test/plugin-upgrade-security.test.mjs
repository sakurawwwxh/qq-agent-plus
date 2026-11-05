import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { applyUpgradeSecurity } = await import('../src/plugins/upgrade-security.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-upgrade-sec-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(id) {
  const dataDir = path.join(root, id);
  fs.mkdirSync(path.join(dataDir, 'plugins', id), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'plugins', id, 'plugin.json'), JSON.stringify({
    id, approvals: [{ action: 'write' }, { action: 'post' }]
  }));
  fs.mkdirSync(path.join(dataDir, 'plugin-grants'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'plugin-grants', `${id}.json`), JSON.stringify({
    approvals: [{ action: 'write', target: 'x' }], quota: { day: '2026-11-05', used: 1 }
  }));
  fs.writeFileSync(path.join(dataDir, 'plugin-grants', 'pending.json'), JSON.stringify([
    { id: 'p1', pluginId: id }, { id: 'p2', pluginId: 'other' }
  ]));
  return dataDir;
}

test('权限面变化的升级：清批准/待批，并关闭该插件的写开关（保留配额）', () => {
  const dataDir = fixture('demo');
  const patches = [];
  const out = applyUpgradeSecurity(dataDir, {
    id: 'demo', upgraded: true, diff: { permissionChanged: true }
  }, { updateConfig: (patch) => patches.push(patch) });
  assert.equal(out.disabledActions, 2);
  assert.equal(out.reset.clearedApprovals, 1);
  assert.equal(out.reset.clearedPending, 1);
  const grants = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugin-grants', 'demo.json'), 'utf8'));
  assert.deepEqual(grants.approvals, []);
  assert.equal(grants.quota.used, 1, '配额计数不能被升级清零');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'plugin-grants', 'pending.json'), 'utf8')),
    [{ id: 'p2', pluginId: 'other' }]);
  assert.deepEqual(patches, [{
    plugins: { switches: { demo: { write: false, post: false } } }
  }]);
});

test('没有 diff（旧清单损坏 + force）：无法证明权限没变，必须按变化重置', () => {
  const dataDir = fixture('nodiff');
  const patches = [];
  const out = applyUpgradeSecurity(dataDir, { id: 'nodiff', upgraded: true }, {
    updateConfig: (patch) => patches.push(patch)
  });
  assert.equal(out.reset.clearedApprovals, 1, '缺 diff 不能成为跳过清授权的后门');
  assert.equal(out.reset.clearedPending, 1);
  assert.equal(out.disabledActions, 2);
  assert.equal(patches.length, 1);
});

test('新清单读不了导致关开关失败：授权已清，但要回传 warning 而不是静默成功', () => {
  const dataDir = fixture('broken');
  fs.writeFileSync(path.join(dataDir, 'plugins', 'broken', 'plugin.json'), '{"id":');
  const logs = [];
  const out = applyUpgradeSecurity(dataDir, {
    id: 'broken', upgraded: true, diff: { permissionChanged: true }
  }, { updateConfig: () => {}, log: (line) => logs.push(line) });
  assert.equal(out.reset.clearedApprovals, 1);
  assert.equal(out.disabledActions, 0);
  assert.match(out.warning, /关闭写开关失败/);
  assert.equal(logs.length, 1, '同时要写日志');
});

test('未升级或权限面没变：不动授权，也不写配置', () => {
  const dataDir = fixture('same');
  assert.equal(applyUpgradeSecurity(dataDir, { id: 'same', upgraded: false, diff: { permissionChanged: true } }), null);
  assert.equal(applyUpgradeSecurity(dataDir, { id: 'same', upgraded: true, diff: { permissionChanged: false } }), null);
  const grants = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugin-grants', 'same.json'), 'utf8'));
  assert.equal(grants.approvals.length, 1);
});
