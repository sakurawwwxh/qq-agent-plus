import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    ...options
  });
}

test('deploy script verifies and rolls back the update service and timer', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(source, /scripts\/auto-update\.mjs/);
  assert.match(source, /UPDATE_SERVICE="\$\{SERVICE\}-update"/);
  assert.match(source, /systemd-analyze --user verify "\$UPDATE_UNIT_FILE"/);
  assert.match(source, /systemctl --user enable --now "\$UPDATE_SERVICE\.timer"/);
  assert.match(source, /cp -p "\$LOCK_DIR\/state\/update\.service" "\$UPDATE_UNIT_FILE"/);
  assert.match(source, /QQ_AGENT_SOURCE_REVISION/);
});

// Issue #5（2026-09-22）：国内服务器拉不到 Docker Hub，脚本只报「after 3 attempts」就退出，
// 用户不知道还能换镜像站。这组断言守住三件事：认用户指定的镜像站、不替用户默认选第三方镜像站、
// 失败时给可操作的指引。
test('deploy-all retries through a user-specified image mirror and never picks one itself', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');

  // 默认必须是空列表：镜像站是第三方，用哪家只能由用户决定
  assert.match(source, /^IMAGE_MIRRORS=\(\)$/m, '镜像站列表要以空数组初始化');
  assert.match(source, /^IMAGE_MIRROR_ARG=""$/m, '--image-mirror 默认必须为空');
  assert.doesNotMatch(source, /IMAGE_MIRRORS=\(\s*["']/, '不许把第三方镜像站写成默认值');

  // 两条入口：环境变量（逗号分隔）+ 命令行
  assert.match(source, /QQ_AGENT_IMAGE_MIRROR/);
  assert.match(source, /IFS=',' read -r -a IMAGE_MIRRORS/);
  assert.match(source, /--image-mirror\) require_value "\$@"; IMAGE_MIRROR_ARG="\$2"; shift 2 ;;/);
  assert.match(source, /\[\[ "\$mirror" =~ \^\[A-Za-z0-9\.-\]\+\(:\[0-9\]\+\)\?\$ \]\]/, '镜像站 host 要校验格式');

  // 回退顺序：直连（3 次退避）→ 逐个镜像站 → 仍失败才报错
  assert.match(source, /pull_with_retry\(\)/);
  assert.match(source, /if pull_with_retry "\$IMAGE"; then\n  PULLED=true/);
  assert.match(source, /candidate="\$\{mirror%\/\}\/\$IMAGE"/);
  assert.match(source, /if pull_with_retry "\$candidate"; then/);
  // 换了镜像站要把 .env 里的引用一起改掉（compose 走 --env-file），且保持权限
  assert.match(source, /update_env_image\(\)/);
  assert.match(source, /chmod --reference="\$ENV_FILE"/);

  // 失败时的指引：三条路都写到，且明确"脚本不替你选镜像站"
  assert.match(source, /image_pull_hint\(\)/);
  for (const needle of ['QQ_AGENT_IMAGE_MIRROR=<mirror>', 'registry-mirrors', 'docker save', '镜像站由第三方提供']) {
    assert.ok(source.includes(needle), `失败提示里应包含：${needle}`);
  }
  assert.match(source, /image_pull_hint\n  die /, '先打指引再退出');
});

// 凭据不经手变量、也不进子进程环境：既能少一份密钥驻留，也是 Mimosa「硬编码凭据」规则盯的地方。
test('deploy-all 现读现用凭据，模型 Key 走 0600 文件而不是子进程环境', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  assert.doesNotMatch(source, /^OLD_[A-Z_]*(PASSWORD|TOKEN)[A-Z_]*=/m, '旧凭据不该留在变量里');
  assert.match(source, /stored_value\(\) \{ env_value "\$ENV_FILE" "\$1"; \}/);
  assert.match(source, /SNOWLUMA_PASSWORD="\$\{SNOWLUMA_PASSWORD:-\$\(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD\)\}"/);
  assert.match(source, /SNOWLUMA_PASSWORD" != "\$\(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD\)"/);

  assert.doesNotMatch(source, /export QQ_AGENT_MODEL_API_KEY=/, '模型 Key 不该导出进子进程环境');
  assert.match(source, /mktemp "\$\{TMPDIR:-\/tmp\}\/qq-agent-model-key\.XXXXXX"/);
  assert.match(source, /chmod 600 "\$MODEL_KEY_FILE"/);
  assert.match(source, /export QQ_AGENT_MODEL_KEY_FILE="\$MODEL_KEY_FILE"/);
  assert.match(source, /trap 'rm -f "\$MODEL_KEY_FILE"; cleanup_fresh_stack' EXIT/);
});

test('configure-linux creates observe config and preserves runtime mode on update', (t) => {
  const dataDir = tempDir(t, 'qq-deploy-config-');
  const script = path.join(repo, 'scripts/configure-linux.mjs');
  const first = runNode(script, [
    '--data-dir', dataDir,
    '--host', '127.0.0.1',
    '--port', '43210'
  ]);
  assert.equal(first.status, 0, first.stderr);

  const configFile = path.join(dataDir, 'config.json');
  const initial = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(initial.runtime.mode, 'observe');
  assert.equal(initial.server.host, '127.0.0.1');
  assert.equal(initial.server.port, 43210);
  assert.ok(initial.server.token.length >= 32);
  // 安全意图：不得泄露给 group/other。不能精确断言 0600——btrfs（部分 NAS）
  // 上 writeFileSync/chmod 的 mode 会落成 0700（owner-only 但带 x 位，Issue #11）。
  assert.equal(fs.statSync(configFile).mode & 0o077, 0);

  initial.runtime.mode = 'active';
  fs.writeFileSync(configFile, JSON.stringify(initial), { mode: 0o600 });
  const second = runNode(script, [
    '--data-dir', dataDir,
    '--host', '0.0.0.0',
    '--port', '43211'
  ]);
  assert.equal(second.status, 0, second.stderr);

  const updated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(updated.runtime.mode, 'active');
  assert.equal(updated.server.host, '0.0.0.0');
  assert.equal(updated.server.port, 43211);
  assert.equal(updated.server.token, initial.server.token);
});

test('configure-linux accepts full-stack credentials and OneBot endpoints', (t) => {
  const dataDir = tempDir(t, 'qq-full-deploy-config-');
  const result = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', dataDir,
    '--host', '0.0.0.0',
    '--port', '43212'
  ], {
    env: {
      ...process.env,
      QQ_AGENT_CONSOLE_TOKEN: 'agent-console-token-1234',
      QQ_AGENT_ONEBOT_TOKEN: 'onebot-ws-token-1234',
      QQ_AGENT_ONEBOT_HTTP_TOKEN: 'onebot-http-token-1234',
      QQ_AGENT_ONEBOT_WS_URL: 'ws://127.0.0.1:33001',
      QQ_AGENT_ONEBOT_HTTP_URL: 'http://127.0.0.1:33000',
      QQ_AGENT_MODEL_BASE_URL: 'https://model.example/v1',
      QQ_AGENT_MODEL_API_KEY: 'model-secret',
      QQ_AGENT_MODEL: 'model-name',
      QQ_AGENT_ALLOW_GROUPS: '123,456',
      QQ_AGENT_ALLOW_PRIVATE: '789'
    }
  });
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.server.token, 'agent-console-token-1234');
  assert.equal(config.onebot.wsUrl, 'ws://127.0.0.1:33001');
  assert.equal(config.onebot.httpUrl, 'http://127.0.0.1:33000');
  assert.equal(config.onebot.accessToken, 'onebot-ws-token-1234');
  assert.equal(config.onebot.httpAccessToken, 'onebot-http-token-1234');
  assert.equal(config.api.baseUrl, 'https://model.example/v1');
  assert.equal(config.api.apiKey, 'model-secret');
  assert.equal(config.api.model, 'model-name');
  assert.deepEqual(config.allow.groups, ['123', '456']);
  assert.deepEqual(config.allow.private, ['789']);
});

test('模型 Key 也可以走 QQ_AGENT_MODEL_KEY_FILE（不留在子进程环境里）', (t) => {
  const dataDir = tempDir(t, 'qq-keyfile-config-');
  const keyFile = path.join(tempDir(t, 'qq-keyfile-'), 'model-key');
  fs.writeFileSync(keyFile, 'key-from-file\n', { mode: 0o600 });
  const result = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', dataDir,
    '--host', '127.0.0.1',
    '--port', '43213'
  ], {
    env: {
      ...process.env,
      QQ_AGENT_MODEL_BASE_URL: 'https://model.example/v1',
      QQ_AGENT_MODEL: 'model-name',
      QQ_AGENT_MODEL_API_KEY: '',
      QQ_AGENT_MODEL_KEY_FILE: keyFile
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.api.apiKey, 'key-from-file', '尾随换行要被去掉');

  // 文件不存在时报错要指得出是哪个变量，而不是静默当成没配 Key
  const missing = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', tempDir(t, 'qq-keyfile-missing-'),
    '--host', '127.0.0.1',
    '--port', '43214'
  ], {
    env: { ...process.env, QQ_AGENT_MODEL_KEY_FILE: path.join(dataDir, 'nope') }
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /QQ_AGENT_MODEL_KEY_FILE/);
});

test('configure-snowluma synchronizes global and per-account server tokens', (t) => {
  const dataDir = tempDir(t, 'qq-snowluma-config-');
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'onebot_12345.json'), JSON.stringify({
    mode: 'snapshot',
    networks: {
      httpServers: [{ name: 'custom-http', host: '127.0.0.1', port: 3100 }],
      wsServers: [{ name: 'custom-ws', host: '127.0.0.1', port: 3101, role: 'Event' }]
    }
  }));

  const result = runNode(path.join(repo, 'scripts/configure-snowluma.mjs'), [
    '--data-dir', dataDir,
    '--token', 'shared-onebot-token-1234',
    '--http-port', '3000',
    '--ws-port', '3001'
  ]);
  assert.equal(result.status, 0, result.stderr);

  for (const name of ['onebot.json', 'onebot_12345.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
    assert.equal(config.networks.httpServers[0].host, '0.0.0.0');
    assert.equal(config.networks.httpServers[0].port, 3000);
    assert.equal(config.networks.httpServers[0].accessToken, 'shared-onebot-token-1234');
    assert.equal(config.networks.wsServers[0].host, '0.0.0.0');
    assert.equal(config.networks.wsServers[0].port, 3001);
    assert.equal(config.networks.wsServers[0].accessToken, 'shared-onebot-token-1234');
  }
  assert.ok(fs.existsSync(path.join(configDir, 'onebot_12345.json.bak')));
});

test('installed manage launcher uses the exact deployed Node runtime', (t) => {
  const root = tempDir(t, 'qq-deploy-root-');
  const home = tempDir(t, 'qq-deploy-home-');
  const data = path.join(root, 'data');
  const capture = path.join(root, 'node-invocation.txt');
  const fakeNode = path.join(root, 'private-node');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(path.join(repo, 'manage.sh'), path.join(root, 'manage.sh'));
  fs.writeFileSync(path.join(root, 'scripts/manage.mjs'), '');
  fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`, { mode: 0o700 });

  const install = runNode(path.join(repo, 'scripts/install-service.mjs'), [], {
    env: {
      ...process.env,
      HOME: home,
      QQ_INSTALL_DIR: root,
      QQ_DATA_DIR: data,
      QQ_NODE: fakeNode,
      QQ_SERVICE: 'qq-agent-test',
      QQ_SNOWLUMA_WEBUI_URL: 'http://127.0.0.1:15099'
    }
  });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.deployment-node'), 'utf8'), `${fakeNode}\n`);
  // 同上：btrfs 上可能落成 0700，只断言不泄露给 group/other
  assert.equal(fs.statSync(path.join(root, '.deployment-node')).mode & 0o077, 0);
  const unit = fs.readFileSync(path.join(home, '.config/systemd/user/qq-agent-test.service'), 'utf8');
  assert.match(unit, /Environment="SNOWLUMA_WEBUI_URL=http:\/\/127\.0\.0\.1:15099"/);
  const updateUnit = fs.readFileSync(
    path.join(home, '.config/systemd/user/qq-agent-test-update.service'),
    'utf8'
  );
  const updateTimer = fs.readFileSync(
    path.join(home, '.config/systemd/user/qq-agent-test-update.timer'),
    'utf8'
  );
  assert.match(updateUnit, /scripts\/auto-update\.mjs/);
  // 更新器自身预算最坏 >50min（npm ci 10 + 单测 20 + deploy 20）：unit 超时必须大于它，
  // 否则 systemd 会在回滚进行中 SIGKILL 整个 cgroup，留下半新半旧的安装目录。
  assert.match(updateUnit, /TimeoutStartSec=75min/);
  assert.match(updateUnit, /TimeoutStopSec=10min/);
  assert.match(updateTimer, /OnUnitInactiveSec=1h/);
  assert.match(updateTimer, /RandomizedDelaySec=10min/);
  const deployment = JSON.parse(fs.readFileSync(path.join(root, '.deployment.json'), 'utf8'));
  assert.equal(deployment.updateService, 'qq-agent-test-update');
  assert.equal(deployment.repository, 'https://github.com/sakurawwwxh/qq-agent-plus.git');
  assert.equal(deployment.branch, 'main');

  const manage = spawnSync('/bin/bash', [path.join(root, 'manage.sh'), 'health'], {
    cwd: root,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8'
  });
  assert.equal(manage.status, 0, manage.stderr);
  assert.deepEqual(
    fs.readFileSync(capture, 'utf8').trim().split('\n'),
    ['scripts/manage.mjs', 'health']
  );
});

// Issue #15（2026-09-25）：unit 带 NoNewPrivileges 时重启后 sudo 必死，linger 步骤
// 一失败整个更新就回滚。linger 只影响下次开机自启，必须是尽力而为：先预检 NNP
// 别让 sudo 去撞内核限制，sudo 失败走警告分支（if/elif 保护，不触发 ERR 回滚）。
test('deploy script treats linger as best-effort and never rolls back over it', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(
    source,
    /loginctl show-user "\$USER" -p Linger --value 2>\/dev\/null \|\| true/,
    'loginctl 查询失败要当作"未开 linger"处理，不能让命令替换触发 ERR'
  );
  assert.match(
    source,
    /if grep -q 'NoNewPrivs:\[\[:space:\]\]\*1' \/proc\/self\/status/,
    '先预检 NoNewPrivileges：被加固时跳过 sudo，给出手动指引而不是内核报错'
  );
  assert.match(
    source,
    /elif ! sudo loginctl enable-linger "\$USER"/,
    'sudo 失败必须走 elif 警告分支，不能裸跑触发 ERR 回滚'
  );
  assert.match(source, /下次开机不会自启/, '警告要说明后果与手动补救命令');
});
