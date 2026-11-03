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

// 顺序敏感的真正意义：后注册的字面量路由不能被前面的参数/正则路由抢先命中。
// 现有快照只对比字符串，允许“先写 /api/x/:id、后写 /api/x/y，再 --write”这种静默遮蔽
//（2026-11-01 盲审 P2）。
function matcherFor(routePath) {
  // listRoutes 把 RegExp 投影成字符串；现有正则路由统一以 ^ 开头，字面量路径不会。
  if (routePath.startsWith('/^')) {
    const regex = /^\/(.*)\/([a-z]*)$/.exec(routePath);
    if (!regex) return null;
    try { return new RegExp(regex[1], regex[2]); } catch { return null; }
  }
  if (!routePath.includes(':')) return null;
  const escape = (s) => [...s].map((ch) => ('\\^$.*+?()[]{}|'.includes(ch) ? `\\${ch}` : ch)).join('');
  const source = `^${routePath.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : escape(seg))).join('/')}$`;
  return new RegExp(source);
}

function findShadowed(routes) {
  const earlier = [];
  const shadowed = [];
  for (const route of routes) {
    const isRegex = route.path.startsWith('/^');
    const isPattern = !isRegex && route.path.includes(':');
    if (!isRegex && !isPattern) {
      for (const prev of earlier) {
        if (prev.method !== route.method) continue;
        const matcher = matcherFor(prev.path);
        if (matcher && matcher.test(route.path)) shadowed.push(`${route.method} ${route.path} ← ${prev.path}`);
      }
    }
    earlier.push(route);
  }
  return shadowed;
}

test('遮蔽检查器自身有效：参数路由与正则路由都能抓到后面的字面量', () => {
  const synthetic = [
    { method: 'GET', path: '/api/items/:id' },
    { method: 'GET', path: String(/^\/api\/items\/\d+$/) },
    { method: 'GET', path: '/api/items/special' },
    { method: 'GET', path: '/api/items/123' },
    { method: 'GET', path: '/api/items/special/extra' }
  ];
  assert.deepEqual(findShadowed(synthetic), [
    'GET /api/items/special ← /api/items/:id',
    'GET /api/items/123 ← /api/items/:id',
    'GET /api/items/123 ← /^\\/api\\/items\\/\\d+$/'
  ]);
});

test('字面量路由不会被前面的参数/正则路由遮蔽', () => {
  const app = createApp({ log: () => {} });
  installManualFriendReviewRoute(app);
  let routes;
  try {
    routes = app.listRoutes();
  } finally {
    try { app.store?.close?.(); } catch { /* 已关闭 */ }
  }
  const shadowed = findShadowed(routes);
  assert.deepEqual(shadowed, [], `这些字面量路由会被前面的模式路由遮蔽：\n${shadowed.join('\n')}`);
});
