// 源码文件大小闸门（结构守卫，零依赖）：
//   - src/ 下新文件默认上限 1800 行；
//   - 存量超限文件进 ALLOWLIST，只能保持或变小；降到 1800 以内后必须从名单移除；
//   - ui/ 已有 eslint max-lines，不在这里重复。
// 里程碑拆分每批结束时手动下调/移除 ALLOWLIST，形成 ratchet。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const LIMIT = 1800;

// 2026-10-31 基线（里程碑 1 开始）。只允许改小；拆分完成后同步下调。
// 2026-11-03：一次性给每个存量文件预留 25 行余量并冻结（不再按 1 行余量顶格），
// 下一批新增必须拆模块，不允许再上调本名单；否则 ratchet 名存实亡。
const ALLOWLIST = new Map([
  ['src/console/app.js', 4343],
  ['src/core/orchestrator.js', 4208],
  ['src/tools/tools-core.js', 3524],
  ['src/ops.js', 3451],
  ['src/core/config-legacy.js', 2653],
  ['src/identity/identity-store.js', 1976],
  ['src/features/daily-moments.js', 1841]
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk('src').map((file) => {
  const text = fs.readFileSync(file, 'utf8');
  return {
    rel: path.relative('.', file).split(path.sep).join('/'),
    lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  };
});

test('新增源码文件不超过 1800 行；存量超限文件只能变小', () => {
  const violations = [];
  for (const file of files) {
    const cap = ALLOWLIST.get(file.rel);
    if (cap === undefined) {
      if (file.lines > LIMIT) violations.push(`${file.rel}: ${file.lines} > ${LIMIT}（新文件超限）`);
      continue;
    }
    if (file.lines > cap) violations.push(`${file.rel}: ${file.lines} > 基线 ${cap}（只能改小）`);
  }
  assert.deepEqual(violations, [], `文件大小超限：\n${violations.join('\n')}`);
});

test('已降到 1800 行以内的文件必须从 ALLOWLIST 移除（ratchet）', () => {
  const stale = [];
  for (const [rel] of ALLOWLIST) {
    const file = files.find((item) => item.rel === rel);
    if (!file) stale.push(`${rel}: 文件不存在，请移除名单`);
    else if (file.lines <= LIMIT) stale.push(`${rel}: 已 ${file.lines} 行（≤${LIMIT}），请从 ALLOWLIST 移除`);
  }
  assert.deepEqual(stale, [], `ALLOWLIST 未收紧：\n${stale.join('\n')}`);
});
