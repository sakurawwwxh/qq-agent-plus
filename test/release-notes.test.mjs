// 发版说明与发布检查脚本的守卫：
//   - CHANGES 最新版本章节必须等于 package.json（"未发布"段不算版本章节）；
//   - scripts/release-check.mjs 在 --allow-unreleased 下能通过当前仓库状态
//     （防止脚本本身写坏、或版本/pin 漂移）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const changes = fs.readFileSync('docs/CHANGES.md', 'utf8');

test('CHANGES 最新版本章节等于 package.json 版本', () => {
  const headings = [...changes.matchAll(/^##\s+(?:0\.\s*)?(\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
  assert.ok(headings.length > 0, 'CHANGES 里找不到版本章节');
  assert.equal(headings[0], pkg.version, `最新章节 ${headings[0]} 与 package.json ${pkg.version} 不一致`);
});

test('release-check 在当前未发布状态可通过 --allow-unreleased', () => {
  const result = spawnSync(process.execPath, ['scripts/release-check.mjs', '--allow-unreleased'], {
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `release-check 失败：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /发版检查通过/);
});
