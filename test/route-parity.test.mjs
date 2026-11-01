// 控制台路由快照（结构守卫）：
//   - 注册顺序敏感：同一 method+path 重复注册时，router 只取第一条，后者静默失效；
//   - 按域拆分 app.js 时，这份快照能发现"漏注册 / 重复注册 / 顺序变化"。
// 快照由 scripts/snapshot-routes.mjs 生成；确认差异符合预期后才允许 --write。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-route-parity-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.env.QQ_AGENT_SKIP_INDEX_WARM = '1';
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { createApp } = await import('../src/console/app.js');
const { installManualFriendReviewRoute } = await import('../src/console/manual-friend-review-route.js');
const snapshotPath = path.resolve('test/fixtures/console-routes.snapshot.json');
const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

test('路由注册集合与顺序与快照完全一致', () => {
  const app = createApp({ log: () => {} });
  installManualFriendReviewRoute(app);
  let actual;
  try {
    actual = app.listRoutes();
  } finally {
    try { app.store?.close?.(); } catch { /* 已关闭 */ }
  }
  assert.equal(actual.length, expected.length, `路由数量变化：${expected.length} → ${actual.length}`);
  assert.deepEqual(actual, expected, '路由快照不一致（顺序敏感）');
});

test('未鉴权路由恰好是 /healthz 与 /api/login', () => {
  const app = createApp({ log: () => {} });
  installManualFriendReviewRoute(app);
  let routes;
  try {
    routes = app.listRoutes();
  } finally {
    try { app.store?.close?.(); } catch { /* 已关闭 */ }
  }
  const open = routes.filter((route) => !route.auth).map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(open, ['GET /healthz', 'POST /api/login']);
});

test('同一 method+path 不允许重复注册（后者会被静默遮蔽）', () => {
  const app = createApp({ log: () => {} });
  installManualFriendReviewRoute(app);
  let routes;
  try {
    routes = app.listRoutes();
  } finally {
    try { app.store?.close?.(); } catch { /* 已关闭 */ }
  }
  const seen = new Set();
  const duplicates = [];
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  assert.deepEqual(duplicates, [], `重复注册：${duplicates.join(' / ')}`);
});
