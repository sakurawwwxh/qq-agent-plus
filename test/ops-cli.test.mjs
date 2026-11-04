// ops.js 子命令的参数透传（2026-09-30 审查 P2 回归护栏）。
//
// 背景：`audit-prune` 的 help 与 docs/OPS.md 都写了 `--data=目录`，但它原先用 `config({})`，
// 完全忽略该参数 —— 未知参数在这个 CLI 里不算错误，于是 `--data=/other/data` 会静默去删
// **默认**数据目录（或 /data/qq-agent/data）的审计文件。同类子命令都透传了 --data。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const repo = path.resolve('.');

function runOps(args, env = {}) {
  // 关键：清掉 QQ_AGENT_DATA_DIR 等回退来源 —— 否则 config({}) 会从环境变量取到同一目录，
  // 测试就分不出"--data 被透传"和"碰巧环境也是这个目录"，变异验证不会变红（实测踩到）。
  const base = { ...process.env, ...env };
  for (const k of ['QQ_AGENT_DATA_DIR', 'QQ_AGENT_DIR', 'QQ_AGENT_APP_DIR']) delete base[k];
  const r = spawnSync(process.execPath, [path.join(repo, 'src/ops.js'), ...args], {
    encoding: 'utf8',
    cwd: repo,
    env: base,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('audit-prune --data 透传：列出的是传入目录的文件（P2）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ops-audit-'));
  const logDir = path.join(dir, 'audit-log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'audit-202001.jsonl'), '{}\n');

  const r = runOps(['audit-prune', '--dry-run', `--data=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /audit-202001\.jsonl/, '应列出 --data 传入目录里的审计文件');
  assert.ok(fs.existsSync(path.join(logDir, 'audit-202001.jsonl')), 'dry-run 不得删除文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit-prune 无 --confirm 时拒绝执行（破坏性操作要有闸门）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ops-audit2-'));
  fs.mkdirSync(path.join(dir, 'audit-log'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audit-log', 'audit-202001.jsonl'), '{}\n');

  const r = runOps(['audit-prune', `--data=${dir}`]);
  assert.notEqual(r.code, 0, '无 --confirm 应拒绝（非 0 退出）');
  assert.match(r.out, /--confirm/);
  assert.ok(fs.existsSync(path.join(dir, 'audit-log', 'audit-202001.jsonl')), '拒绝时不得删除文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-10-01 审查：qq-agent-backup.service 的五行 Environment= 原先整段是注释（health 与
// audit-prune 两个单元都带了），于是自定义部署下备份会打包**默认**数据目录、停**默认**服务名 ——
// 而备份正是"先停服务、打包、再拉起"，打错目录/停错服务是数据安全事故，不是参数没给全。
// 断言用 ^...$ 多行锚：`# Environment=...` 这种注释行不能算命中（否则原样也能过）。
test('install-timers --print：备份单元把路径/服务名/保留份数显式带进环境', () => {
  const rootDir = '/srv/qq-agent-custom';
  const r = spawnSync(process.execPath, [path.join(repo, 'src/ops.js'), 'install-timers', '--print'], {
    encoding: 'utf8',
    cwd: repo,
    env: {
      ...process.env,
      QQ_AGENT_DIR: rootDir,
      QQ_AGENT_DATA_DIR: `${rootDir}/mydata`,
      QQ_AGENT_BACKUP_DIR: `${rootDir}/mybackups`,
      QQ_AGENT_SERVICE: 'qq-agent-custom.service',
      QQ_AGENT_KEEP: '9',
      QQ_AGENT_BACKUP_KEY_FILE: `${rootDir}/keys/backup.key`,
    },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 0, out);

  const sections = new Map();
  for (const part of out.split('──────── ').slice(1)) {
    const [name, ...rest] = part.split(' ────────');
    sections.set(name.trim(), rest.join(' ────────'));
  }
  const backup = sections.get('qq-agent-backup.service') || '';
  assert.ok(backup.includes('backup --confirm'), `没取到备份单元内容：${out.slice(0, 300)}`);

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const line of [
    `Environment="QQ_AGENT_DIR=${rootDir}"`,
    `Environment="QQ_AGENT_DATA_DIR=${rootDir}/mydata"`,
    `Environment="QQ_AGENT_BACKUP_DIR=${rootDir}/mybackups"`,
    'Environment="QQ_AGENT_SERVICE=qq-agent-custom.service"',
    'Environment="QQ_AGENT_KEEP=9"',
    `Environment="QQ_AGENT_BACKUP_KEY_FILE=${rootDir}/keys/backup.key"`,
  ]) {
    assert.ok(
      new RegExp(`^${escape(line)}$`, 'm').test(backup),
      `备份单元缺少生效行（注释不算）：${line}`
    );
  }
  // 备份和演练必须用同一把钥匙；否则备份用本地新生成的 key，演练用 off-host key，月月失败。
  const drill = sections.get('qq-agent-backup-drill.service') || '';
  assert.ok(drill.includes(`Environment="QQ_AGENT_BACKUP_KEY_FILE=${rootDir}/keys/backup.key"`),
    '演练单元必须与备份单元使用同一个 QQ_AGENT_BACKUP_KEY_FILE');
  // 值必须整体加引号：systemd 的 Environment= 未加引号时按空白切词，路径里有空格就会被拆开
  // （变成"目录只读到空格前"），而这里三个路径恰好都可以来自用户环境变量（另一条审查意见）。
  // 口径与 scripts/install-service.mjs 生成的单元一致。
  for (const unit of sections.values()) {
    const unquoted = unit.split('\n').filter((line) => /^Environment=QQ_AGENT_[A-Z_]+=[^"]/.test(line));
    assert.deepEqual(unquoted, [], `Environment 值必须加引号：${unquoted.join(' / ')}`);
  }
});

test('ops scan --strict 指向不存在的目录要退出非 0（CI 把关用；否则扫了空气还判绿）', async () => {
  const { spawnSync } = await import('node:child_process');
  const missing = path.join(os.tmpdir(), `qq-ops-missing-${Date.now()}`);
  const strict = spawnSync(process.execPath, ['src/ops.js', 'scan', missing, '--strict'], { encoding: 'utf8' });
  assert.notEqual(strict.status, 0, '目录写错时 --strict 必须让 CI 变红');
  assert.match(String(strict.stdout) + String(strict.stderr), /目录不存在/);
  const loose = spawnSync(process.execPath, ['src/ops.js', 'scan', missing], { encoding: 'utf8' });
  assert.equal(loose.status, 0, '不带 --strict 时只报告、不阻断（保持只读体检的用法）');
});
