#!/usr/bin/env node
// 稳定性循环：默认 unit ×5、Playwright ×2。用于验收“没有 unexplained flake”。
// 用法：node scripts/stability-check.mjs [--unit 10] [--browser 3]
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(args[index + 1]) || fallback;
};
const unitRuns = Math.max(1, flag('unit', 5));
const browserRuns = Math.max(0, flag('browser', 2));
const run = (label, command, commandArgs, useShell = false) => {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: useShell,
    env: { ...process.env }
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`\n✗ ${label} 失败（${seconds}s，退出 ${result.status}）`);
    process.exit(result.status || 1);
  }
  console.log(`✓ ${label} 通过（${seconds}s）`);
};

for (let i = 1; i <= unitRuns; i += 1) {
  run(`unit #${i}/${unitRuns}`, process.execPath, ['scripts/test-suite.mjs', 'unit']);
}
for (let i = 1; i <= browserRuns; i += 1) {
  run(`browser #${i}/${browserRuns}`, 'npx', ['playwright', 'test'], process.platform === 'win32');
}
console.log(`\n稳定性循环通过：unit ×${unitRuns}，browser ×${browserRuns}`);
