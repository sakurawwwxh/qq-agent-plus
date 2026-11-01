#!/usr/bin/env node
// 控制台路由快照：生成或校验 test/fixtures/console-routes.snapshot.json。
//
// 为什么需要：app.js 有 220+ 条路由，42 条是正则、顺序敏感；按域拆分时
// "漏注册/重复注册/顺序变化"很难靠肉眼发现。快照把 method+path 的**注册顺序**
// 固定下来，任何差异都必须显式更新。
//
// 用法：
//   node scripts/snapshot-routes.mjs          # 校验（CI/测试用）
//   node scripts/snapshot-routes.mjs --write  # 确认差异符合预期后重写快照
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'console-routes.snapshot.json');

// 必须在 import config/app 之前设好：config 在模块求值期读 DATA_DIR。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-route-snapshot-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.env.QQ_AGENT_SKIP_INDEX_WARM = '1';

const { createApp } = await import(pathToFileURL(path.join(ROOT, 'src', 'console', 'app.js')).href);
const { installManualFriendReviewRoute } = await import(pathToFileURL(path.join(ROOT, 'src', 'console', 'manual-friend-review-route.js')).href);

let routes = [];
try {
  const app = createApp({ log: () => {} });
  // 生产入口 server.js 会额外注册这条；快照必须覆盖生产实际路由集。
  installManualFriendReviewRoute(app);
  routes = app.listRoutes();
  try { app.store?.close?.(); } catch { /* 已关闭 */ }
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
}

const text = `${JSON.stringify(routes, null, 2)}\n`;
const write = process.argv.includes('--write');

if (write) {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, text);
  console.log(`已写入 ${routes.length} 条路由 → ${path.relative(ROOT, FIXTURE)}`);
} else {
  let current = '';
  try { current = fs.readFileSync(FIXTURE, 'utf8'); } catch { /* 缺文件即不一致 */ }
  if (current !== text) {
    console.error('路由快照不一致：请先运行 node scripts/snapshot-routes.mjs --write，并确认差异是预期改动。');
    process.exit(1);
  }
  console.log(`路由快照一致（${routes.length} 条）`);
}
