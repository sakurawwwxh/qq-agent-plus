// 备份路径的安全锚点：软链数据目录、损坏密钥文件、服务原本停止状态。
// 行为级测试需要真的停 systemd 服务；这里锚住关键分支，防止以后被"简化"掉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ops = fs.readFileSync(path.join(repo, 'src', 'ops.js'), 'utf8');
const keySource = fs.readFileSync(path.join(repo, 'src', 'core', 'backup-key.js'), 'utf8');

test('备份：数据目录软链按真实目录打包，恢复替换真实目录', () => {
  assert.match(ops, /fs\.realpathSync\(dataDir\)[\s\S]{0,160}path\.dirname\(sourceDir\)/,
    'tar 打包必须解析 dataDir 软链，否则会归档 symlink 条目');
  assert.match(ops, /fs\.realpathSync\(cfg\.dataDir\)[\s\S]{0,240}const pre = `\$\{targetDir\}/,
    '恢复必须替换软链指向的真实目录，保留软链布局');
});

test('备份密钥：只在文件不存在时生成，绝不覆盖已损坏的旧密钥', () => {
  assert.match(keySource, /error\?\.code !== 'ENOENT'/, '非 ENOENT 的读取失败必须中止');
  assert.match(keySource, /fs\.openSync\(file, 'wx', 0o600\)/, '生成密钥必须用 wx 防覆盖');
  assert.match(keySource, /不会覆盖原密钥/, '格式错误时要给出明确原因');
});

test('备份：只恢复备份前原本在跑的服务，重启失败按失败返回', () => {
  assert.match(ops, /serviceWasActive/, '要记录备份前的服务状态');
  assert.match(ops, /if \(serviceManaged && serviceWasActive\)/, '原本停止的服务不能被备份拉起');
  assert.match(ops, /restartFailed = true/, '重启失败要记账');
  assert.match(ops, /if \(restartFailed\)[\s\S]{0,120}return 1/, '重启失败不能返回 0');
});

test('install-timers 启用恢复演练 timer', () => {
  assert.match(ops, /qq-agent-backup-drill\.timer/, '生成或启用列表里必须有恢复演练 timer');
});
