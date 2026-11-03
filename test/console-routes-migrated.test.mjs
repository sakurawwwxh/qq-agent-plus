// 路由迁移收尾的静态断言（改进方案 #2，J.1 的"不重复注册"与 auth 显式化）：
// 迁移完成的契约 —— 源码里不得再出现 if 链形态的 /api/ 判定；所有 API 路由都走 router。
// 这两条断言同时是"防回退"：以后有人往 handleHttp 里加 if 分支会被直接拦下。
//
// 2026-10-31：按域拆分后，路由可能出现在 src/console/routes/*.js —— 断言范围同步扩展，
// 否则新模块里的 auth:false / if 链会静默漏检。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROUTE_DIR = 'src/console/routes';

const targets = [
  'src/console/app.js',
  'src/console/storage.js',
  'src/console/manual-friend-review-route.js',
  'src/server.js'
];
function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
try {
  // 递归：以后按子目录拆 routes/ 时，auth:false / if 链检查不能静默漏检（2026-11-01 盲审 P2）。
  targets.push(...walkJs(ROUTE_DIR));
} catch { /* 还没有 routes/ 目录 */ }

const sources = targets.map((file) => ({
  file,
  src: fs.readFileSync(path.resolve(file), 'utf8')
}));

test('if 链形态的 /api/ 判定已清零（不重复注册：路由只存在于路由表）', () => {
  const offenders = [];
  for (const { file, src } of sources) {
    const literal = [...src.matchAll(/pathname === '\/api\/[^']*'/g)].map((m) => m[0]);
    const regexExec = [...src.matchAll(/\.exec\(pathname\)/g)].map((m) => m[0]);
    // 前缀分支（startsWith('/api/...')）同样是 if 链路由；旧断言只挡了总闸那一种写法，
    // 在拆出的 routes/*.js 里写 `if (req.url.startsWith('/api/x'))` 会漏检（2026-10-31 审查 P2）。
    const prefix = [...src.matchAll(/(?:pathname|req\.url|url\.pathname)\.startsWith\(\s*['"]\/api[^'"]*['"]/g)]
      .map((m) => m[0]);
    if (literal.length) offenders.push(`${file}: 字面量 ${literal.join(', ')}`);
    if (regexExec.length) offenders.push(`${file}: 正则 ${regexExec.length} 处`);
    if (prefix.length) offenders.push(`${file}: 前缀分支 ${prefix.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `仍有 if 链形态的路由判定：\n${offenders.join('\n')}`);
});

test("源码里没有残留的 '/api/' 前缀总闸（鉴权统一由路由表的 auth 默认 true 执行）", () => {
  const offenders = sources
    .filter(({ src }) => /pathname\.startsWith\('\/api\/'\)/.test(src))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], `总闸应已拆除：${offenders.join(', ')}`);
});

test('每个 router.add 的显式 auth:false 都在白名单之内（auth 显式化的收口断言）', () => {
  // 按 `router.add(` 切块后逐块判定（不能用跨块的无界正则：那会跨过任意多条路由去
  // 找下一个 { auth: false }，归属不可靠 —— 2026-09-30 审查 P3）。
  const explicitFalse = [];
  for (const { file, src } of sources) {
    const blocks = src.split(/\n\s*(?:router|app)\.add(?:Route)?\(/).slice(1);
    for (const block of blocks) {
      if (!/auth\s*:\s*false/.test(block)) continue;
      const m = block.match(/^\s*'(\w+)',\s*('([^']+)'|(\/(?:[^\n]*?)\/[a-z]*))/);
      assert.ok(m, `${file}: 无法从 auth:false 路由块提取路径：${block.slice(0, 60)}`);
      explicitFalse.push(m[3] || m[4]);
    }
  }
  const allowed = new Set(['/healthz', '/api/login']);
  const offenders = explicitFalse.filter((p) => !allowed.has(p));
  assert.deepEqual(offenders, [], `白名单外的 auth:false：${offenders.join(', ')}`);
  assert.equal(explicitFalse.length, 2, '当前应恰好两处 auth:false（/healthz、/api/login）');
});
