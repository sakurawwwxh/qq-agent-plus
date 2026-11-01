#!/usr/bin/env node
// 覆盖率基线（零依赖）：用 Node 内置 --experimental-test-coverage 跑单元测试。
// 里程碑 1 只要求"跑得出来、数字进 CI 日志"；M2 起按版本 ratchet。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 委托给 test-suite 的 coverage 模式：复用它的 TMPDIR 重定向与统一清理，
// 避免与并发的 npm test 互相删临时目录（本地实测过 ENOENT）。
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'test-suite.mjs'), 'coverage'], {
  cwd: ROOT,
  stdio: 'inherit'
});
child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
