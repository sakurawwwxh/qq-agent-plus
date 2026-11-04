import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootInstaller = fs.readFileSync(path.join(repo, 'scripts/root-install.sh'), 'utf8');
const install = fs.readFileSync(path.join(repo, 'install.sh'), 'utf8');

test('install.sh：root 只负责转交降权包装层，不再直接拒绝', () => {
  assert.match(install, /ROOT_INSTALLER="\$SCRIPT_DIR\/scripts\/root-install\.sh"/);
  assert.match(install, /exec bash "\$ROOT_INSTALLER" "\$@"/);
  assert.doesNotMatch(install, /请不要用 root 运行/);
});

test('root-install.sh：创建服务用户、装 Docker、开 linger、以普通用户重跑', () => {
  assert.match(rootInstaller, /SERVICE_USER="\$\{SERVICE_USER:-qqagent\}"/,
    '默认服务用户必须是 qqagent，不能是 root');
  assert.match(rootInstaller, /useradd --create-home --shell \/bin\/bash/);
  assert.match(rootInstaller, /QQ_AGENT_ALLOW_DOCKER_GROUP/, 'docker 组必须显式 opt-in');
  assert.match(rootInstaller, /usermod -aG docker "\$SERVICE_USER"/);
  assert.match(rootInstaller, /loginctl enable-linger "\$SERVICE_USER"/);
  assert.match(rootInstaller, /setpriv --reuid="\$SERVICE_UID" --regid="\$SERVICE_GID" --init-groups/,
    '必须以服务用户重新执行 install.sh（补充组按当前账号实际组继承）');
  assert.match(rootInstaller, /DOCKER_GID="\$\(getent group docker/,
    '默认安装需要读取 docker gid 做临时补充组');
  assert.match(rootInstaller, /--groups "\$DOCKER_GID"/,
    '未 opt-in 永久加组时，安装子进程仍要能临时访问 Docker');
  assert.match(rootInstaller, /源码目录不能是符号链接/,
    'root rsync --delete 前必须拒绝 symlink 的 src');
  assert.match(rootInstaller, /realpath -m -- "\$SRC_DIR"/,
    '还要确认解析后的 src 仍在部署根内');
  assert.match(rootInstaller, /bash "\$SRC_DIR\/install\.sh" "\$\{PASSTHRU\[@\]\}"/,
    '最终必须以服务用户重新执行 install.sh');
  assert.match(rootInstaller, /qq-agent-manage/, 'root 用户需要一个降权后的管理入口');
  assert.match(rootInstaller, /--exclude='\.env'/,
    '复制源码时不能把 .env 一起带到部署目录');
  assert.match(rootInstaller, /realpath -m -- "\$ROOT_DIR"/, '部署根目录必须先规范化');
  assert.match(rootInstaller, /不能是共享系统目录/, '必须拒绝 /mnt、/opt、/home 等共享父目录');
  assert.match(rootInstaller, /SERVICE_UID" != "0"/, '必须拒绝 UID 0 的别名账号');
  assert.match(rootInstaller, /install_packages docker\.io \|\|/, '引擎和 Compose 必须分开安装');
  assert.match(rootInstaller, /Docker Compose v2 不可用/, 'Compose v2 缺失要给可执行说明');
});

test('root-install.sh：测试模式只打印计划，不创建用户或执行安装', { skip: process.platform !== 'linux' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-root-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'install.sh'), path.join(dir, 'install.sh'));
  fs.copyFileSync(path.join(repo, 'scripts/root-install.sh'), path.join(dir, 'scripts/root-install.sh'));
  fs.writeFileSync(path.join(dir, 'deploy-all.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  // 部署根目录必须在源码目录之外；父目录可以存在，但 stack 本身必须不存在，
  // 否则 root-install 会把父目录属主当成服务用户（CI 上是 runner）。
  const stackParent = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-root-stack-'));
  t.after(() => fs.rmSync(stackParent, { recursive: true, force: true }));
  const stack = path.join(stackParent, 'stack');
  const marker = path.join(dir, 'should-not-exist');
  const result = spawnSync('bash', [path.join(dir, 'scripts/root-install.sh'), '--root-dir', stack, '--check-only'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, QQ_AGENT_ROOT_INSTALL_TEST: '1', QQ_STUB_ARGS: marker },
    timeout: 20_000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /root 安装准备/);
  assert.match(result.stdout, /服务用户：qqagent/);
  assert.match(result.stdout, new RegExp(`部署目录：${stack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(fs.existsSync(marker), false, '测试模式绝不能执行 deploy-all.sh');
});

test('root-install.sh：拒绝 /mnt、/opt 这类共享父目录', { skip: process.platform !== 'linux' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-root-unsafe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'install.sh'), path.join(dir, 'install.sh'));
  fs.copyFileSync(path.join(repo, 'scripts/root-install.sh'), path.join(dir, 'scripts/root-install.sh'));
  fs.writeFileSync(path.join(dir, 'deploy-all.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('bash', [path.join(dir, 'scripts/root-install.sh'), '--root-dir', '/mnt', '--check-only'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, QQ_AGENT_ROOT_INSTALL_TEST: '1' },
    timeout: 20_000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /共享系统目录/);
});
