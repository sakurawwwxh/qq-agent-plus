// 控制台展示的 SSH 恢复命令必须带 --data/--service：SSH 会话没有服务进程的环境变量，
// 照默认值执行会恢复到 /data/qq-agent/data 或停错服务（2026-11-01 盲审 P1）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('备份状态里的 restoreCli 带实际数据目录与服务名', async (t) => {
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-backup-cli-'));
  process.env.QQ_AGENT_BACKUP_DIR = backups;
  process.env.QQ_AGENT_SERVICE = 'custom.service';
  t.after(() => fs.rmSync(backups, { recursive: true, force: true }));
  fs.writeFileSync(path.join(backups, 'qq-agent-data-test.tar.gz.enc'), 'x');

  const { request, root } = await bootConsole(t);
  const res = await request('GET', '/api/backup/status');
  assert.equal(res.status, 200);
  const cmd = res.body.restoreCli;
  assert.ok(cmd.includes(`--from '${path.join(backups, 'qq-agent-data-test.tar.gz.enc')}'`), cmd);
  assert.ok(cmd.includes(`--data '${path.resolve(root)}'`), cmd);
  assert.ok(cmd.includes("--service 'custom.service'"), cmd);
  assert.ok(cmd.trim().endsWith('--confirm'), cmd);
});
