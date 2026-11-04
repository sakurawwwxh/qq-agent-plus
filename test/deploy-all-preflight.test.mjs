import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skipUnlessLinux } from './helpers/platform.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellOptions = {
  skip: process.getuid?.() === 0
    ? 'Installer must run as a non-root service user'
    : skipUnlessLinux('Installer preflight needs bash/systemctl/docker fixtures (Linux only)')
};

function fixture(t, { fakeUid = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stack-preflight-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'stack');
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const source = path.join(dir, 'source');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  for (const file of [
    'deploy-all.sh',
    'scripts/check-platform.sh',
    'scripts/check-stack-update.mjs',
    'scripts/configure-snowluma.mjs'
  ]) {
    fs.copyFileSync(path.join(repo, file), path.join(source, file));
  }
  fs.writeFileSync(path.join(source, 'deploy.sh'), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(source, 'scripts/rotate-snowluma-password.mjs'), 'throw new Error("Unexpected credential rotation");\n');
  const stateFile = path.join(dir, 'host.json');
  const callsFile = path.join(dir, 'calls.jsonl');
  const host = { service: 'not-found', workingDirectory: path.join(root, 'app'), containers: [], listeners: [], fakeUid };
  // Host commands never reach the real daemon, package manager or systemd.
  // Write-shaped calls are rejected unless testing an allowed managed update.
  const mock = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const state = JSON.parse(fs.readFileSync(process.env.QQ_PREFLIGHT_FIXTURE));
fs.appendFileSync(process.env.QQ_PREFLIGHT_CALLS, JSON.stringify([name, ...args]) + '\\n');
const out = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value));
if (name === 'uname') out('Linux');
else if (name === 'realpath') out(path.resolve(args.at(-1)));
else if (name === 'id') {
  if (args.includes('-un')) out(process.env.USER || process.env.USERNAME || 'qqagent');
  else if (args.includes('-u')) out(String(state.fakeUid ?? 1000));
  else if (args.includes('-g')) out('1000');
  else process.exit(1);
}
else if (name === 'systemctl') {
  if (args.includes('show-environment')) process.exit(state.requireRuntimeDir && !process.env.XDG_RUNTIME_DIR ? 1 : 0);
  else if (args.includes('--property=LoadState')) {
    out(state.service);
    if (state.loadFailed) process.exit(1);
  }
  else if (args.includes('--property=WorkingDirectory')) out(state.workingDirectory);
  else if (args.includes('is-active')) process.exit(state.running ? 0 : 3);
  else if (state.allowMockWrites && args.includes('restart')) process.exit(0);
  else process.exit(90);
} else if (name === 'docker') {
  if (state.dockerDenied) process.exit(1);
  if (args[0] === 'info') process.exit(0);
  else if (args[0] === 'ps') {
    if (state.inventoryFailed) process.exit(1);
    for (const c of state.containers) out([c.Id, c.Name.slice(1), c.Config.Image].join('|'));
  } else if (args[0] === 'inspect') {
    const c = state.containers.find((c) => c.Id === args.at(-1));
    if (!c) process.exit(1);
    if (args.includes('--format')) {
      if (c.State.Running) {
        for (const ports of Object.values(c.HostConfig.PortBindings)) for (const port of ports) out(port.HostPort);
      }
    } else out([c]);
  } else if (args[0] === 'compose' && args.includes('config')) out(state.compose);
  else if (state.allowMockWrites && (args[0] === 'pull' || args[0] === 'compose')) process.exit(0);
  else process.exit(90);
} else if (name === 'ss') {
  if (state.ssFailed) process.exit(1);
  for (const port of state.listeners) out('LISTEN 0 511 0.0.0.0:' + port + ' 0.0.0.0:*');
} else if (name === 'curl' && state.allowMockWrites) process.exit(0);
else process.exit(90);
`;
  for (const name of ['uname', 'realpath', 'systemctl', 'docker', 'ss', 'sudo', 'curl', ...(fakeUid == null ? [] : ['id'])]) {
    fs.writeFileSync(path.join(bin, name), mock, { mode: 0o755 });
  }
  function run(args = ['--check-only']) {
    fs.writeFileSync(stateFile, JSON.stringify(host));
    return spawnSync('/bin/bash', [path.join(source, 'deploy-all.sh'), '--root-dir', root, ...args], {
      cwd: source,
      env: {
        HOME: home, PATH: `${bin}:/usr/bin:/bin`,
        // 这组用例用 POSIX 桩替代真实 systemd/包管理器；发行版体检由
        // test/platform-check.test.mjs 单独覆盖，这里不重复跑真实探测。
        QQ_AGENT_PLATFORM_CHECKED: '1',
        QQ_PREFLIGHT_FIXTURE: stateFile, QQ_PREFLIGHT_CALLS: callsFile
      },
      encoding: 'utf8',
      timeout: 15_000
    });
  }
  return { root, host, run, callsFile };
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
}

function managed(f, { publishHost = null } = {}) {
  const { root, host } = f;
  const env = {
    SNOWLUMA_IMAGE: 'motricseven7/snowluma:v1.14.15',
    SNOWLUMA_CONTAINER: 'qq-agent-snowluma',
    QQ_AGENT_SERVICE: 'qq-agent-linux',
    AGENT_PORT: '3210',
    SNOWLUMA_WEBUI_HOST_PORT: '5099',
    NOVNC_PORT: '6081',
    ONEBOT_HTTP_PORT: '3000',
    ONEBOT_WS_PORT: '3001',
    ONEBOT_TOKEN: 'onebot-token-do-not-print',
    QQ_AGENT_CONSOLE_TOKEN: 'console-token-do-not-print',
    SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: 'Secret!Password123',
    VNC_PASSWD: 'abcdef12'
  };
  if (publishHost) env.PUBLISH_HOST = publishHost;
  write(path.join(root, 'snowluma/.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  write(path.join(root, 'app/.deployment.json'), {
    root: path.join(root, 'app'), data: path.join(root, 'data'), node: process.execPath, service: 'qq-agent-linux'
  });
  write(path.join(root, 'app/.deployment-node'), `${process.execPath}\n`);
  write(path.join(root, 'data/config.json'), {
    runtime: { mode: 'active', paused: false },
    server: { host: '0.0.0.0', port: 3210, token: env.QQ_AGENT_CONSOLE_TOKEN },
    onebot: {
      httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001',
      accessToken: env.ONEBOT_TOKEN, httpAccessToken: env.ONEBOT_TOKEN
    }
  });
  const volumes = [
    ['data', '/app/data'], ['client-config', '/app/.config'], ['client-data', '/app/.local/share']
  ].map(([source, target]) => ({ type: 'bind', source: path.join(root, 'snowluma', source), target }));
  const publicHost = publishHost || '0.0.0.0';
  const ports = [
    [3000, '127.0.0.1'], [3001, '127.0.0.1'], [5099, publicHost], [6081, publicHost]
  ].map(([target, host_ip]) => ({ target, host_ip, published: String(target), protocol: 'tcp' }));
  host.compose = { services: { snowluma: {
    image: env.SNOWLUMA_IMAGE, container_name: env.SNOWLUMA_CONTAINER,
    volumes, ports, environment: { VNC_PASSWD: env.VNC_PASSWD, SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD }
  } } };
  write(path.join(root, 'snowluma/docker-compose.yml'), host.compose);
  host.service = 'loaded';
  host.running = true;
  host.containers = [{
    Id: 'abc123', Name: '/qq-agent-snowluma', State: { Running: true },
    Config: {
      Image: env.SNOWLUMA_IMAGE,
      Labels: { 'com.docker.compose.project.working_dir': path.join(root, 'snowluma'), 'com.docker.compose.service': 'snowluma' }
    },
    Mounts: volumes.map((v) => ({ Type: v.type, Source: v.source, Destination: v.target })),
    HostConfig: { PortBindings: Object.fromEntries(ports.map((p) => [`${p.target}/tcp`, [{ HostPort: p.published, HostIp: p.host_ip }]])) }
  }];
  host.listeners = [3210, 3000, 3001, 5099, 6081];
}

function snapshot(root) {
  if (!fs.existsSync(root)) return null;
  const result = {};
  function visit(file) {
    const stat = fs.lstatSync(file);
    result[path.relative(root, file)] = {
      mode: stat.mode, mtime: stat.mtimeMs,
      content: stat.isFile() ? fs.readFileSync(file, 'base64') : null
    };
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
  }
  visit(root);
  return result;
}

function protectedRun(f, pattern, args = ['--check-only']) {
  const before = snapshot(f.root);
  const result = f.run(args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
  assert.deepEqual(snapshot(f.root), before, 'No contents, permissions or timestamps may change on refusal');
  assert.doesNotMatch(result.stdout + result.stderr, /onebot-token-do-not-print|console-token-do-not-print|Secret!Password123/);
  const calls = fs.existsSync(f.callsFile)
    ? fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  assert.ok(!calls.some(([name, ...args]) =>
    (name === 'sudo' && args.join(' ') !== '-n docker info')
    || name === 'curl' || (name === 'docker' && args[0] === 'pull')
    || (name === 'systemctl' && args.some((arg) => ['restart', 'start', 'stop', 'enable'].includes(arg)))));
}

test('legacy production state is refused before credentials, dependencies or services change', shellOptions, (t) => {
  const f = fixture(t);
  write(path.join(f.root, 'data/config.json'), {
    runtime: { mode: 'active' },
    onebot: { httpUrl: 'http://127.0.0.1:13000', wsUrl: 'ws://127.0.0.1:13001', accessToken: 'production-token' }
  });
  write(path.join(f.root, 'app/.deployment.json'), { service: 'qq-agent-linux' });
  protectedRun(f, /without managed stack metadata/, ['--yes', '--rotate-credentials', '--skip-model-config']);
  assert.ok(!fs.existsSync(path.join(f.root, 'snowluma')));
});

test('a lone .env never implies a managed installation', shellOptions, (t) => {
  const f = fixture(t);
  write(path.join(f.root, 'snowluma/.env'), 'ONEBOT_TOKEN=onebot-token-do-not-print\n');
  protectedRun(f, /incomplete managed stack/);
});

test('leftover QQ login data is protected even without any Agent configuration', shellOptions, (t) => {
  const f = fixture(t);
  write(path.join(f.root, 'snowluma/client-data/login.json'), '{"session":"existing"}');
  protectedRun(f, /without managed stack metadata/);
});

test('fresh preflight succeeds without creating the stack or asking for model credentials', shellOptions, (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Environment: fresh installation/);
  assert.equal(snapshot(f.root), null);
});

test('pre-created empty data directories do not count as an existing installation', shellOptions, (t) => {
  const f = fixture(t);
  for (const name of ['data', 'app/data', 'snowluma']) fs.mkdirSync(path.join(f.root, name), { recursive: true });
  const before = snapshot(f.root);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Environment: fresh installation/);
  assert.deepEqual(snapshot(f.root), before);
});

// ── 网页终端缺 XDG_RUNTIME_DIR（2026-10-12 报道）：预检必须自动补变量或给可操作指引 ──
// 真 systemctl 在没有 XDG_RUNTIME_DIR 时固定报 "Failed to connect to bus"，哪怕用户管理器
// 在跑；这里让 mock 也这样做（requireRuntimeDir 开关），专门覆盖原 fixture 没盖住的情形
//（原 mock 把 show-environment 恒真，所以"变量没设"从来没被走到）。
const runtimeDir = process.getuid ? `/run/user/${process.getuid()}` : '';
const hasRuntimeDir = process.platform !== 'win32' && runtimeDir !== '' && fs.existsSync(runtimeDir);
// Windows 上本文件整组本就不可运行（spawnSync /bin/bash ENOENT，属既有 Windows 基线）；
// 新增用例按 skip 处理，别往基线里塞新的红。
const shellNeedsPosix = process.platform === 'win32'
  ? 'Windows 上本组用例不可运行（/bin/bash 与 POSIX 桩，见既有 Windows 基线）'
  : false;

test('a web terminal missing XDG_RUNTIME_DIR is rescued by the backfill when /run/user/<uid> exists', {
  skip: shellOptions.skip || shellNeedsPosix || (hasRuntimeDir ? false : 'requires a real /run/user/<uid> (Linux user session)')
}, (t) => {
  const f = fixture(t);
  f.host.requireRuntimeDir = true;   // 与真 systemctl 同口径：没有变量就 exit 1
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Environment: fresh installation/);
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(([name, ...args]) => name === 'systemctl' && args.includes('show-environment')),
    '探测仍然要真的发生（不是被跳过）');
});

test('a web terminal missing XDG_RUNTIME_DIR without /run/user/<uid> fails closed with actionable guidance', {
  skip: shellOptions.skip || shellNeedsPosix
}, (t) => {
  const f = fixture(t, { fakeUid: 59999 });   // id -u 指到一个没有 runtime 目录的 uid
  f.host.requireRuntimeDir = true;
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /XDG_RUNTIME_DIR/, '要告诉用户缺的是这个变量');
  assert.match(result.stderr, /enable-linger/, '目录不存在时要给出 enable-linger 这一步');
  assert.equal(snapshot(f.root), null, '拒绝时不得创建栈目录');
});

test('a not-found service reported with nonzero exit still permits fresh installation', shellOptions, (t) => {
  const f = fixture(t);
  f.host.loadFailed = true;
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Environment: fresh installation/);
  assert.equal(snapshot(f.root), null);
});

test('a managed stack may be checked repeatedly with all of its own ports occupied', shellOptions, (t) => {
  const f = fixture(t);
  managed(f);
  const before = snapshot(f.root);
  for (let i = 0; i < 2; i++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Environment: managed stack/);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('ordinary managed update does not attempt password rotation and preserves Agent configuration', shellOptions, (t) => {
  const f = fixture(t);
  managed(f);
  f.host.allowMockWrites = true;
  const configFile = path.join(f.root, 'data/config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const result = f.run(['--yes']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Deployment complete. Agent mode: active/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  assert.doesNotMatch(result.stderr, /credential rotation/);
});

test('managed loopback stack (new default) passes its own preflight', shellOptions, (t) => {
  const f = fixture(t);
  managed(f, { publishHost: '127.0.0.1' });
  // 新装默认不仅 compose 绑回环，Agent 的 config.server.host 也是 127.0.0.1；
  // 两个条件都覆盖，才能证明 allowlist 放宽确实服务于默认安装。
  const configFile = path.join(f.root, 'data/config.json');
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  cfg.server.host = '127.0.0.1';
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Ownership and port checks passed/);
});

test('a managed stack with a stopped container and Agent can be updated', shellOptions, (t) => {
  const f = fixture(t);
  managed(f);
  f.host.running = false;
  f.host.containers[0].State.Running = false;
  f.host.listeners = [];
  const before = snapshot(f.root);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(snapshot(f.root), before);
});

for (const [name, mutate, pattern] of [
  ['external SnowLuma at another root', (f) => {
    f.host.containers = [{ Id: 'external', Name: '/qq-bridge-snowluma', Config: { Image: 'motricseven7/snowluma:v1.14.15' } }];
  }, /external QQ gateway container/],
  ['pre-existing Agent service', (f) => { f.host.service = 'loaded'; }, /qq-agent-linux.service already exists/],
  ['Nginx on the selected WebUI port', (f) => { f.host.listeners = [5099]; }, /port 5099 is already in use/],
  ['failed Docker inventory', (f) => { f.host.inventoryFailed = true; }, /container inventory is unavailable/],
  ['inaccessible Docker daemon', (f) => { f.host.dockerDenied = true; }, /containers cannot be inspected/],
  ['failed service inspection', (f) => {
    f.host.service = '';
    f.host.loadFailed = true;
  }, /Cannot inspect the selected systemd service/],
  ['unavailable port inventory', (f) => { f.host.ssFailed = true; }, /Cannot inspect listening ports/]
]) {
  test(`preflight protects ${name}`, shellOptions, (t) => {
    const f = fixture(t);
    mutate(f);
    protectedRun(f, pattern);
  });
}

for (const [name, mutate, pattern] of [
  ['service directory', (f) => { f.host.workingDirectory = '/different/app'; }, /another application directory/],
  ['container project', (f) => {
    f.host.containers[0].Config.Labels['com.docker.compose.project.working_dir'] = '/home/sourcecode/apps';
  }, /another Compose project/],
  ['container volumes', (f) => { f.host.containers[0].Mounts[0].Type = 'volume'; }, /different installation/],
  ['unrelated Compose services', (f) => { f.host.compose.services.database = {}; }, /unrelated services/],
  ['Compose volume source', (f) => {
    f.host.compose.services.snowluma.volumes[0].source = '/different/data';
  }, /different installation/],
  ['changed live Token', (f) => {
    const file = path.join(f.root, 'data/config.json');
    const config = JSON.parse(fs.readFileSync(file));
    config.server.token = 'changed-by-admin';
    write(file, config);
  }, /Console credentials have changed/],
  ['production OneBot endpoints', (f) => {
    const file = path.join(f.root, 'data/config.json');
    const config = JSON.parse(fs.readFileSync(file));
    config.onebot.httpUrl = 'http://127.0.0.1:13000';
    write(file, config);
  }, /different OneBot endpoints/],
  ['corrupt configuration', (f) => {
    write(path.join(f.root, 'data/config.json'), '{"token":"onebot-token-do-not-print');
  }, /Malformed deployment metadata/]
]) {
  test(`managed preflight refuses mismatched ${name} without writing`, shellOptions, (t) => {
    const f = fixture(t);
    managed(f);
    mutate(f);
    protectedRun(f, pattern);
  });
}
