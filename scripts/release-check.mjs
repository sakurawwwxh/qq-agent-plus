#!/usr/bin/env node
// 发版前检查（零依赖）：把目前靠人工记忆的几件事收口成一条命令。
//
// 用法：
//   node scripts/release-check.mjs                 # 版本/CHANGES/镜像 pin
//   node scripts/release-check.mjs --tag v0.9.14   # 额外校验 tag 与 package.json
//   node scripts/release-check.mjs --allow-unreleased
//   node scripts/release-check.mjs --run-gates     # 再跑 lint/scan/unit（较慢）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const inlineTagArg = process.argv.find((arg) => arg.startsWith('--tag='));
const tagSpecified = args.has('--tag') || inlineTagArg !== undefined;
const tagArg = (() => {
  const idx = process.argv.indexOf('--tag');
  if (idx >= 0) return String(process.argv[idx + 1] || '');
  return inlineTagArg ? inlineTagArg.slice('--tag='.length) : '';
})();

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const pkg = JSON.parse(read('package.json'));
const version = String(pkg.version || '');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json 版本不合法：${version}`);

// 1) CHANGES：有"未发布"段时，必须先改名成版本章节才能发版
const changes = read('docs/CHANGES.md');
if (/^##\s+未发布/m.test(changes)) {
  if (!args.has('--allow-unreleased')) {
    fail('docs/CHANGES.md 仍有"## 未发布"段：发版前把它改成 "## 0. <version>：..."');
  } else {
    notes.push('CHANGES 仍有未发布段（--allow-unreleased 已放行）');
  }
}
const versionHeadings = [...changes.matchAll(/^##\s+(?:0\.\s*)?(\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
if (versionHeadings.length && versionHeadings[0] !== version) {
  fail(`CHANGES 最新版本章节是 ${versionHeadings[0]}，package.json 是 ${version}`);
} else if (!versionHeadings.length) {
  fail('CHANGES 里找不到版本章节');
}

// 2) 镜像 pin：compose/README/README.en/DOCKER 必须与 package.json 一致
const compose = read('docker-compose.yml');
if (!compose.includes(`wangxinhong/qq-agent-plus:${version}`)) {
  fail(`docker-compose.yml 的 Agent 镜像 pin 不是 ${version}`);
}
for (const rel of ['README.md', 'README.en.md', 'docs/DOCKER.md']) {
  const tags = [...read(rel).matchAll(/qq-agent-plus:(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  if (!tags.length) fail(`${rel} 里没有镜像 tag 示例`);
  const stale = [...new Set(tags)].filter((tag) => tag !== version);
  if (stale.length) fail(`${rel} 里还有旧镜像 tag：${stale.join(', ')}`);
}

// 3) tag 与 package.json 一致；tag 指向的提交不能带 [skip ci]（否则 Release/Docker 都不跑）
if (tagSpecified && !tagArg) fail('--tag 缺少值（例如 --tag v0.9.14）');
if (tagArg) {
  const tagVersion = tagArg.replace(/^v/, '');
  if (tagVersion !== version) fail(`tag ${tagArg} 与 package.json ${version} 不一致`);
  const log = spawnSync('git', ['log', '-1', '--format=%B', tagArg], { cwd: ROOT, encoding: 'utf8' });
  if (log.status !== 0) {
    fail(`读不到 tag ${tagArg} 指向的提交（git log 退出 ${log.status}）`);
  } else if (/\[(?:skip ci|ci skip|skip-ci)\]/i.test(log.stdout)) {
    fail(`tag ${tagArg} 指向的提交带 [skip ci]：Release/Docker 工作流不会触发`);
  }
} else {
  const head = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: ROOT, encoding: 'utf8' });
  if (head.status === 0 && /\[(?:skip ci|ci skip|skip-ci)\]/i.test(head.stdout)) {
    fail('HEAD 提交带 [skip ci]：从这个提交打 tag 会跳过 Release/Docker');
  }
}

// 4) 可选：跑门禁
if (args.has('--run-gates')) {
  for (const [label, cmd, cmdArgs] of [
    ['lint', 'npm', ['run', 'lint']],
    ['scan', process.execPath, ['src/ops.js', 'scan', '--strict']],
    ['unit', 'npm', ['run', 'test:unit']]
  ]) {
    // Windows 上只有 npm（npm.cmd）需要 shell；process.execPath 带空格时走 shell 会被 cmd 拆坏
    const useShell = process.platform === 'win32' && cmd === 'npm';
    const result = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: useShell });
    if (result.status !== 0) fail(`${label} 未通过（退出 ${result.status}）`);
  }
}

notes.push(`版本 ${version}`);
if (failures.length) {
  console.error('发版检查未通过：');
  for (const item of failures) console.error(`  ✗ ${item}`);
  process.exit(1);
}
console.log('发版检查通过：');
for (const item of notes) console.log(`  ✓ ${item}`);
