import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTar } from './helpers/tar.mjs';
import {
  comparePluginVersions, diffManifests, hashManifest, permissionProjection
} from '../src/plugins/manifest-diff.js';
import {
  backfillManifestHash, checkApproval, consumeQuota, grantApproval,
  listPendingApprovals, requestPendingApproval, resetPluginGrants, approvePendingApproval
} from '../src/plugins/grants.js';
import { installPlugin } from '../src/plugins/install.js';
import { applyUpgradeSecurity } from '../src/plugins/upgrade-security.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-upgrade-diff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function manifest(version, { actionTarget = 'target', capabilities = ['tools', 'approval', 'quota', 'config', 'secrets', 'http'], secret = false } = {}) {
  const fields = [{ key: 'channel', label: '频道', type: 'select', options: [{ value: 'a', label: 'A' }] }];
  if (secret) fields.push({ key: 'token', label: 'Token', type: 'secret' });
  return {
    id: 'demo', apiVersion: 2, name: '演示插件', version, entry: 'index.mjs',
    capabilities,
    httpDomains: ['example.com'],
    approvals: [{ action: 'write', label: '写一条' }],
    quotas: { write: 10 },
    settings: { groups: [{ key: 'account', title: '账号', fields }] },
    tools: [{
      name: 'write', description: '写一条',
      parameters: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } } },
      action: 'write', actionTarget, actionPreview: 'text'
    }]
  };
}

function pack(version, options = {}) {
  return buildTar([
    { name: 'plugin.json', data: JSON.stringify(manifest(version, options)) },
    { name: 'index.mjs', data: 'process.exit(0)\n' }
  ]);
}

test('diff：同一份 manifest 不算权限变化，哈希稳定', () => {
  const a = manifest('1.0.0');
  const b = JSON.parse(JSON.stringify(a));
  const diff = diffManifests(a, b);
  assert.equal(diff.permissionChanged, false);
  assert.deepEqual(diff.summary, []);
  assert.equal(hashManifest(a), hashManifest(b));
});

test('diff：新增能力 / 改 actionTarget / 新增 secret / 换发布者都要重授权', () => {
  const base = manifest('1.0.0');
  assert.equal(diffManifests(base, manifest('1.1.0', { capabilities: ['tools', 'approval', 'observe'] })).permissionChanged, true);
  assert.equal(diffManifests(base, manifest('1.1.0', { actionTarget: 'bvid' })).permissionChanged, true);
  const quotaRemoved = { ...manifest('1.1.0'), quotas: {} };
  assert.equal(diffManifests(base, quotaRemoved).permissionChanged, true,
    '删除配额（去掉一道刹车）同样是权限面变化');
  assert.equal(diffManifests(base, manifest('1.1.0', { secret: true })).permissionChanged, true);
  const publisher = diffManifests(base, base, { previousPublisher: 'a', nextPublisher: 'b' });
  assert.equal(publisher.permissionChanged, true);
  assert.deepEqual(publisher.areas, ['publisher']);
});

test('diff：只改描述/README 类信息不算权限变化', () => {
  const a = manifest('1.0.0');
  const b = JSON.parse(JSON.stringify(a));
  b.tools[0].description = '换了段说明';
  const diff = diffManifests(a, b);
  assert.equal(diff.permissionChanged, false);
});

test('授权绑定 manifest 哈希：换版本后旧批准不匹配', (t) => {
  const dir = tempDir(t);
  const oldHash = hashManifest(manifest('1.0.0'));
  const newHash = hashManifest(manifest('2.0.0', { actionTarget: 'bvid' }));
  grantApproval(dir, 'demo', 'write', { target: 'BV1', manifestHash: oldHash });
  assert.equal(checkApproval(dir, 'demo', 'write', { target: 'BV1', manifestHash: oldHash }).approved, true);
  assert.equal(checkApproval(dir, 'demo', 'write', { target: 'BV1', manifestHash: newHash }).approved, false);
  // 不传哈希时保持旧兼容（测试与旧调用方）
  assert.equal(checkApproval(dir, 'demo', 'write', { target: 'BV1' }).approved, true);
});

test('待批请求也绑定版本：待批期间升级则批准失败', (t) => {
  const dir = tempDir(t);
  const oldHash = hashManifest(manifest('1.0.0'));
  // 只升版本、权限面不变 → 哈希相同，待批仍然有效（这是设计：没有权限变化就不打扰管理员）
  const samePermissionHash = hashManifest(manifest('2.0.0'));
  assert.equal(samePermissionHash, oldHash);
  // 真正的权限变化（actionTarget 改了）才让旧待批失效
  const newHash = hashManifest(manifest('2.0.0', { actionTarget: 'bvid' }));
  const pending = requestPendingApproval(dir, {
    pluginId: 'demo', action: 'write', target: 'BV1', manifestHash: oldHash
  });
  assert.equal(listPendingApprovals(dir).length, 1);
  assert.throws(
    () => approvePendingApproval(dir, pending.id, { manifestHash: newHash }),
    (error) => error.code === 'E_STALE_APPROVAL'
  );
  const approved = approvePendingApproval(dir, pending.id, { manifestHash: oldHash });
  assert.equal(approved.grant.manifestHash, oldHash);
});

test('升级重置：清批准与待批，但保留当天配额计数', (t) => {
  const dir = tempDir(t);
  const hash = hashManifest(manifest('1.0.0'));
  grantApproval(dir, 'demo', 'write', { target: 'BV1', manifestHash: hash });
  requestPendingApproval(dir, { pluginId: 'demo', action: 'write', target: 'BV2', manifestHash: hash });
  consumeQuota(dir, 'demo', 'write', 10);
  const result = resetPluginGrants(dir, 'demo');
  assert.equal(result.clearedApprovals, 1);
  assert.equal(result.clearedPending, 1);
  assert.equal(listPendingApprovals(dir).length, 0);
  const status = consumeQuota(dir, 'demo', 'write', 10);
  assert.equal(status.used, 2, '配额计数不应被升级清零');
});

test('老授权没有哈希：加载时补绑当前 manifest', (t) => {
  const dir = tempDir(t);
  grantApproval(dir, 'demo', 'write', { target: 'BV1' });
  const hash = hashManifest(manifest('1.0.0'));
  assert.equal(backfillManifestHash(dir, 'demo', hash), 1);
  assert.equal(checkApproval(dir, 'demo', 'write', { target: 'BV1', manifestHash: hash }).approved, true);
});

test('安装器：权限变化必须带确认哈希；无变化可直升级；降级/同版本拒绝', async (t) => {
  const dir = tempDir(t);
  const install = (version, options = {}, extra = {}) => installPlugin({
    id: 'demo', tarball: pack(version, options), dataDir: dir, log: () => {}, ...extra
  });

  const first = await install('1.0.0');
  assert.equal(first.upgraded, false);

  // 预览：只返回 diff，不换目录
  const preview = await install('2.0.0', { actionTarget: 'bvid' }, { previewOnly: true });
  assert.equal(preview.preview, true);
  assert.equal(preview.diff.permissionChanged, true);
  const stillOld = JSON.parse(fs.readFileSync(path.join(dir, 'plugins', 'demo', 'plugin.json'), 'utf8'));
  assert.equal(stillOld.version, '1.0.0');

  // 没带确认哈希：拒绝
  await assert.rejects(
    () => install('2.0.0', { actionTarget: 'bvid' }),
    (error) => error.code === 'E_UPGRADE_CONFIRM' && error.diff?.permissionChanged === true
  );

  // 带确认哈希：成功
  const upgraded = await install('2.0.0', { actionTarget: 'bvid' }, { expectedDiffHash: preview.diff.diffHash });
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.diff.permissionChanged, true);

  // 只升版本、权限面不变（沿用上一步的 actionTarget）：不需要确认
  const unchanged = await install('3.0.0', { actionTarget: 'bvid' });
  assert.equal(unchanged.upgraded, true);
  assert.equal(unchanged.diff.permissionChanged, false);

  // 降级拒绝；同版本重装保留（修复/重装是既有工作流）
  await assert.rejects(() => install('1.0.0'), (error) => error.code === 'E_DOWNGRADE');
  const reinstall = await install('3.0.0', { actionTarget: 'bvid' });
  assert.equal(reinstall.upgraded, true);
});

test('同版本重装：权限面变化同样要确认哈希（不能因为版本号没动就静默换入）', async (t) => {
  const dir = tempDir(t);
  const install = (version, options = {}, extra = {}) => installPlugin({
    id: 'demo', tarball: pack(version, options), dataDir: dir, log: () => {}, ...extra
  });
  const first = await install('1.0.0');
  assert.equal(first.upgraded, false);
  await assert.rejects(
    () => install('1.0.0', { actionTarget: 'bvid' }),
    (error) => error.code === 'E_UPGRADE_CONFIRM' && error.diff?.permissionChanged === true
  );
  const preview = await install('1.0.0', { actionTarget: 'bvid' }, { previewOnly: true });
  const applied = await install('1.0.0', { actionTarget: 'bvid' }, { expectedDiffHash: preview.diff.diffHash });
  assert.equal(applied.upgraded, true);
});

test('旧清单损坏：没 force 拒绝升级，force 覆盖后按“权限已变”清授权', async (t) => {
  const dir = tempDir(t);
  const install = (version, options = {}, extra = {}) => installPlugin({
    id: 'demo', tarball: pack(version, options), dataDir: dir, log: () => {}, ...extra
  });
  await install('1.0.0');
  const hash = hashManifest(manifest('1.0.0'));
  grantApproval(dir, 'demo', 'write', { target: 'BV1', manifestHash: hash });
  assert.equal(checkApproval(dir, 'demo', 'write', { target: 'BV1', manifestHash: hash }).approved, true);

  // 模拟半写/手改损坏：读不出旧权限面，不能默认“没变化”直接放行。
  fs.writeFileSync(path.join(dir, 'plugins', 'demo', 'plugin.json'), '{"id":"demo",');
  await assert.rejects(
    () => install('2.0.0'),
    (error) => error.code === 'E_UPGRADE_UNREADABLE_OLD'
  );
  assert.equal(fs.existsSync(path.join(dir, 'plugins', 'demo', 'index.mjs')), true, '拒绝升级不能破坏已装目录');

  const forced = await install('2.0.0', {}, { force: true });
  assert.equal(forced.upgraded, true);
  assert.equal(forced.diff.permissionChanged, true, '读不出旧清单时 force 必须按权限变化处理');
  assert.deepEqual(forced.diff.areas, ['unreadable-old-manifest']);

  const secured = applyUpgradeSecurity(dir, forced);
  assert.ok(secured.reset.clearedApprovals >= 1, '覆盖损坏清单后必须清掉旧授权');
  assert.equal(checkApproval(dir, 'demo', 'write', { target: 'BV1', manifestHash: hash }).approved, false);
});

test('版本比较：数字段优先，v 前缀与预发布后缀不干扰', () => {
  assert.equal(comparePluginVersions('1.2.0', '1.10.0'), -1);
  assert.equal(comparePluginVersions('v2.0.0', '2.0.0'), 0);
  assert.equal(comparePluginVersions('2.0.0', '2.0.0-beta'), 0);
  assert.equal(comparePluginVersions('2.1.0', '2.0.9'), 1);
});

test('权限投影：稳定排序（同样内容不同键顺序 = 同一哈希）', () => {
  const a = { id: 'x', capabilities: ['b', 'a'], tools: [], httpDomains: ['z', 'a'] };
  assert.equal(permissionProjection(a).capabilities.join(','), 'a,b');
  assert.equal(permissionProjection(a).httpDomains.join(','), 'a,z');
});
