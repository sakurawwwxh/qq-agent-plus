// 协议端（SnowLuma）版本识别与"控制台一键更新"的回归用例。
//
// 这一层的价值全在**边界与失败路径**上：镜像串解析（带国内镜像站前缀）、版本比较、
// 目标镜像的前缀继承、以及更新失败时的"只还原 .env / 自动回滚"——真机上跑一次升级代价太大
// （协议端会重启），所以用注入的 exec/probe 替身把这些路径逐条钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const {
  SNOWLUMA_BASELINE_IMAGE, SNOWLUMA_MIN_RECOMMENDED,
  parseImage, compareVersions, targetImageFor, readComposeEnv, renderEnvWithImage,
  backupComposeFiles, createSnowlumaUpdater
} = await import('../src/core/snowluma-update.js');

const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无视 */ } }
});

/** 造一个假的 compose 项目目录（.env + docker-compose.yml）。 */
function makeProject({ image = 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15', container = 'qq-agent-snowluma' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snowluma-'));
  tempDirs.add(dir);
  fs.writeFileSync(path.join(dir, '.env'), [
    `SNOWLUMA_IMAGE=${image}`,
    `SNOWLUMA_CONTAINER=${container}`,
    'ONEBOT_HTTP_PORT=3390',
    'ONEBOT_TOKEN=secret-token',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  snowluma:\n    image: "${SNOWLUMA_IMAGE}"\n');
  return dir;
}

/**
 * 假 docker：只实现我们用到的四个形态。up -d 之后"运行中的镜像"就跟着 .env 变
 * （模拟容器真的重建了）；pull 可以通过 failingPull 控制失败。
 */
function fakeDocker({ dir, state = {} } = {}) {
  const calls = [];
  const api = {
    calls,
    state: { running: state.running === true, image: state.image || '', failingPull: false, failingUp: false },
    exec(cmd, args) {
      calls.push([cmd, ...args].join(' '));
      if (cmd !== 'docker') return { ok: false, code: -1, stdout: '', stderr: `unexpected cmd ${cmd}` };
      const joined = args.join(' ');
      if (args[0] === 'inspect') {
        if (joined.includes('.Config.Image')) return { ok: true, code: 0, stdout: `${api.state.image}\n`, stderr: '' };
        if (joined.includes('.State.Status')) return { ok: true, code: 0, stdout: `${api.state.running ? 'running' : 'exited'}\n`, stderr: '' };
        return { ok: false, code: 1, stdout: '', stderr: 'no such field' };
      }
      if (args[0] === 'compose') {
        const action = args.filter((a) => !a.startsWith('-') && a !== 'compose' && a !== dir && !a.includes('.env') && !a.includes('docker-compose'))[0];
        if (action === 'pull') {
          if (api.state.failingPull) return { ok: false, code: 1, stdout: '', stderr: 'manifest unknown' };
          return { ok: true, code: 0, stdout: 'pulled', stderr: '' };
        }
        if (action === 'up') {
          if (api.state.failingUp) return { ok: false, code: 1, stdout: '', stderr: 'port is already allocated' };
          // 容器重建：把运行中的镜像切换成 .env 里现在写的那个
          api.state.image = readComposeEnv(dir).image;
          api.state.running = true;
          return { ok: true, code: 0, stdout: 'started', stderr: '' };
        }
      }
      return { ok: false, code: -1, stdout: '', stderr: `unhandled: ${joined}` };
    }
  };
  return api;
}

function makeUpdater(dir, docker, { probeOk = true, probeCalls = 0, hasNoNewPrivs = () => false } = {}) {
  let seen = 0;
  return createSnowlumaUpdater({
    composeDir: dir,
    container: 'qq-agent-snowluma',
    webuiPort: 5099,
    exec: docker.exec,
    probe: async () => { seen += 1; return { ok: seen > probeCalls && probeOk, status: probeOk ? 200 : 0 }; },
    // NNP 探测必须注入、不许落到真实的 /proc/self/status：更新器的部署前门禁**跑在带
    // NoNewPrivileges 的 unit 里**（标准部署默认加固），不注入的话走 sudo 回退的两条用例
    // （#1043/#1048）在门禁环境里必败 —— 结果是所有加固部署都更不了版
    //（2026-10-10 线上实测：本机 unit 的门禁日志里正是这两条）。默认"未加固"＝确定性地
    // 走 sudo 路径；要测加固路径就显式传 () => true（见下方 #392 那条）。
    hasNoNewPrivs,
    log: () => {},
    readyPollMs: 1,
    readyTimeoutMs: 30
  });
}

// ── 镜像串与版本 ──

test('parseImage：带镜像站前缀 / 带端口 / 无 tag 都能拆对', () => {
  const a = parseImage('mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.22');
  assert.equal(a.registry, 'mirror.ccs.tencentyun.com/');
  assert.equal(a.repo, 'motricseven7/snowluma');
  assert.equal(a.tag, 'v1.14.22');
  assert.equal(a.version, '1.14.22');
  const b = parseImage('motricseven7/snowluma:v1.14.15');
  assert.equal(b.registry, '');
  assert.equal(b.repo, 'motricseven7/snowluma');
  assert.equal(b.version, '1.14.15');
  const c = parseImage('127.0.0.1:5000/snowluma');
  assert.equal(c.registry, '127.0.0.1:5000/');
  assert.equal(c.repo, 'snowluma');
  assert.equal(c.version, '');
  assert.equal(parseImage('').version, '');
});

test('compareVersions：数值比较（不是字符串比较）', () => {
  assert.equal(compareVersions('1.14.22', '1.14.22'), 0);
  assert.equal(compareVersions('1.14.9', '1.14.15'), -1, '9 < 15（字符串比较会判反）');
  assert.equal(compareVersions('1.15.0', '1.14.99'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('', '1.14.15'), -1, '认不出来的版本按 0 处理');
});

test('targetImageFor：沿用当前镜像的镜像站前缀，不把国内机器坑到 docker.io', () => {
  const mirrored = targetImageFor({ currentImage: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
  assert.equal(mirrored, `mirror.ccs.tencentyun.com/motricseven7/snowluma:${parseImage(SNOWLUMA_BASELINE_IMAGE).tag}`,
    '当前走镜像站 → 目标也用镜像站 + 基线版本');
  const plain = targetImageFor({ currentImage: 'motricseven7/snowluma:v1.14.15' });
  assert.equal(plain, SNOWLUMA_BASELINE_IMAGE, '本来就拉 docker.io 的 → 直接用基线');
  const override = targetImageFor({ currentImage: 'mirror.x/motricseven7/snowluma:v1.14.15', override: 'registry.local/snowluma:v9.9.9' });
  assert.equal(override, 'registry.local/snowluma:v9.9.9', '配置里手填的镜像优先');
});

test('renderEnvWithImage：镜像引用不合法（含换行/空格/引号）直接拒绝，不许往 .env 里注入新变量', () => {
  // 2026-10-08 二轮审查：这个值来自控制台请求体，会被写成 .env 的一行 —— 值里带换行就等于
  // 往 .env 注入一个新变量（docker compose 会拿它插值镜像 tag / 端口 / 引导密码）。
  const rejects = ['a\nb=1', 'a\r\nb=1', 'a b', 'a;b', 'a"b', '', '   '];
  for (const bad of rejects) {
    assert.throws(() => renderEnvWithImage('SNOWLUMA_IMAGE=old\n', bad), /不合法/,
      `应拒绝非法镜像引用：${JSON.stringify(bad)}`);
  }
  // 反向：合法引用照旧写进去
  assert.match(
    renderEnvWithImage('SNOWLUMA_IMAGE=old\n', 'mirror.ccs.tencentyun.com/x/y:v1.2.22'),
    /^SNOWLUMA_IMAGE=mirror\.ccs\.tencentyun\.com\/x\/y:v1\.2\.22$/m
  );
});

test('renderEnvWithImage：只改 SNOWLUMA_IMAGE 那一行，其余行（含令牌）原样保留', () => {
  const raw = 'SNOWLUMA_IMAGE=old:v1\nONEBOT_TOKEN=secret-token\nSNOWLUMA_CONTAINER=qq-agent-snowluma\n';
  const next = renderEnvWithImage(raw, 'new:v2');
  assert.match(next, /^SNOWLUMA_IMAGE=new:v2$/m);
  assert.match(next, /ONEBOT_TOKEN=secret-token/, '其它键不许被动');
  assert.equal(next.split('\n').length, raw.split('\n').length, '行数不变（是替换不是追加）');
  const appended = renderEnvWithImage('ONEBOT_TOKEN=t\n', 'x:v1');
  assert.match(appended, /SNOWLUMA_IMAGE=x:v1/);
  const withBlank = renderEnvWithImage('A=1\n\n', 'x:v1');
  assert.ok(withBlank.startsWith('A=1'), '原有内容保持在前');
  assert.ok(withBlank.includes('SNOWLUMA_IMAGE=x:v1'), '新键要写进去');
  assert.ok(withBlank.endsWith('\n'), '结尾换行保持（别把文件写成一坨）');
});

test('backupComposeFiles：两份文件都进时间戳目录', () => {
  const dir = makeProject();
  const b = backupComposeFiles(dir, 1700000000000);
  assert.deepEqual(b.copied.sort(), ['.env', 'docker-compose.yml']);
  assert.ok(fs.existsSync(path.join(b.dir, '.env')));
  assert.ok(fs.existsSync(path.join(b.dir, 'docker-compose.yml')));
});

// ── 状态与更新 ──

test('status：跑着的镜像 / 目标镜像 / 是否落后（含"低于推荐版本"）', async () => {
  const dir = makeProject({ image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const st = await makeUpdater(dir, docker).status();
  assert.equal(st.currentVersion, '1.14.15');
  assert.equal(st.targetVersion, parseImage(SNOWLUMA_BASELINE_IMAGE).version);
  assert.equal(st.outdated, true, '1.14.15 落后于基线');
  assert.equal(st.belowRecommended, true, `低于推荐版本 ${SNOWLUMA_MIN_RECOMMENDED}`);
  assert.equal(st.running, true);

  // 已经是最新：不落后；推荐版本线也不再报警
  const docker2 = fakeDocker({ dir, state: { running: true, image: `mirror.ccs.tencentyun.com/motricseven7/snowluma:${parseImage(SNOWLUMA_BASELINE_IMAGE).tag}` } });
  const st2 = await makeUpdater(dir, docker2).status();
  assert.equal(st2.outdated, false);
  assert.equal(st2.belowRecommended, false);
});

test('status：没装协议端（没有 .env）时如实说"没找到"，不抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snowluma-empty-'));
  tempDirs.add(dir);
  const docker = fakeDocker({ dir });
  const st = await makeUpdater(dir, docker).status();
  assert.equal(st.installed, false);
  assert.equal(st.currentVersion, '');
});

test('update：把镜像写进 .env → pull → up -d → 等就绪，并留备份目录', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const updater = makeUpdater(dir, docker);
  const res = await updater.update();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.from, 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15');
  assert.equal(res.to, `mirror.ccs.tencentyun.com/motricseven7/snowluma:${parseImage(SNOWLUMA_BASELINE_IMAGE).tag}`,
    '镜像站前缀要跟着当前镜像走');
  // .env 真的改了，且别的键还在
  const env = readComposeEnv(dir);
  assert.equal(env.image, res.to);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /ONEBOT_TOKEN=secret-token/);
  // 备份目录里有更新前的 .env
  assert.ok(fs.existsSync(path.join(res.backupDir, '.env')), '更新前要留一份 .env 备份');
  assert.match(fs.readFileSync(path.join(res.backupDir, '.env'), 'utf8'), /v1\.14\.15/);
  // 命令序列：pull 在 up -d 之前
  const seq = docker.calls.join(' ;; ');
  assert.match(seq, /compose --project-directory .* pull/);
  assert.match(seq, /compose --project-directory .* up -d/);
  assert.ok(seq.indexOf(' pull') < seq.indexOf(' up -d'), '先 pull 再 up -d');
});

test('update dryRun：只算命令与 .env 变化，一个字节都不写', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  const res = await makeUpdater(dir, docker).update({ dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.match(res.envChange, /^SNOWLUMA_IMAGE=mirror\.ccs\.tencentyun\.com\//);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before, 'dry-run 不许改 .env');
  assert.equal(docker.calls.some((c) => c.includes(' pull') || c.includes(' up')), false,
    'dry-run 不许动容器（只允许 inspect 这类只读查询）');
});

test('update：pull 失败 → 只还原 .env，容器一个都不动', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  docker.state.failingPull = true;
  const res = await makeUpdater(dir, docker).update();
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'pull');
  assert.equal(res.restored, true);
  assert.match(res.error, /manifest unknown/);
  assert.equal(readComposeEnv(dir).image, 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15', '.env 必须还原');
  assert.equal(docker.calls.some((c) => c.includes('up -d')), false, 'pull 失败就不该动容器');
});

test('update：起来了但等不到就绪 → 自动回滚到旧镜像，并把两次结果都报出来', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  // 第一次 up 之后永远探不到就绪；回滚用的第二次 up 之后就绪
  let upCount = 0;
  const baseExec = docker.exec;
  docker.exec = (cmd, args, opts) => {
    if (cmd === 'docker' && args[0] === 'compose' && args.includes('up')) upCount += 1;
    return baseExec(cmd, args, opts);
  };
  const updater = createSnowlumaUpdater({
    composeDir: dir,
    container: 'qq-agent-snowluma',
    webuiPort: 5099,
    exec: docker.exec,
    probe: async () => ({ ok: upCount > 1, status: upCount > 1 ? 200 : 0 }),   // 只有回滚后才就绪
    log: () => {},
    readyPollMs: 1,
    readyTimeoutMs: 15
  });
  const res = await updater.update();
  assert.equal(res.ok, false, '超时就算失败');
  assert.equal(res.rolledBack, true, '必须自动回滚成功');
  assert.equal(readComposeEnv(dir).image, 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15', '.env 回到旧镜像');
  assert.ok(res.log.join(' ').includes('回滚'), '日志里要看得到回滚');
});

test('update：同一时刻只允许一个（并发点击直接被拒）', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const updater = makeUpdater(dir, docker);
  const first = updater.update();
  const second = await updater.update();
  assert.equal(second.ok, false);
  assert.match(second.error, /进行中/);
  assert.equal((await first).ok, true);
});

test('rollback：回滚到上一次更新前的镜像（没有记录时如实拒绝）', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const updater = makeUpdater(dir, docker);
  const none = await updater.rollback();
  assert.equal(none.ok, false);
  assert.match(none.error, /可回滚/);

  await updater.update();                     // 先升上去
  const up = readComposeEnv(dir).image;
  assert.match(up, /v1\.14\.22$/);
  const back = await updater.rollback();
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(readComposeEnv(dir).image, 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15', '回到更新前的镜像');
});

// ── Issue #30：docker 套接字权限不足（systemd 用户服务的组是"启动那刻"冻结的） ──

test('isDockerSocketDenied：认得出本机 unix socket 与 TCP 两种措辞，别的不误判', async () => {
  const { isDockerSocketDenied } = await import('../src/core/snowluma-update.js');
  assert.equal(isDockerSocketDenied(
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'), true);
  assert.equal(isDockerSocketDenied('Got permission denied while trying to connect to the Docker daemon socket'), true);
  // `connect: permission denied` 单独出现时**不算** —— 出网策略（SELinux/防火墙/代理）
  // 也是这个措辞，误判会把用户引去重启 user manager（审查指出的过宽问题）。
  // 带上 docker 上下文才算。
  assert.equal(isDockerSocketDenied('connect: permission denied'), false, '没有 docker 上下文不许判成缺组');
  assert.equal(isDockerSocketDenied('error during connect: dial unix /var/run/docker.sock: connect: permission denied'), true);
  // 反向：别的 docker 失败不许被当成"没权限"，否则会把用户引去改错东西
  assert.equal(isDockerSocketDenied('manifest unknown'), false);
  assert.equal(isDockerSocketDenied('Cannot connect to the Docker daemon at tcp://…'), false);
  assert.equal(isDockerSocketDenied('port is already allocated'), false);
  assert.equal(isDockerSocketDenied(''), false);
  assert.equal(isDockerSocketDenied(undefined), false);
});

test('Issue #30：预检拦住"没权限"，给可执行步骤，且一个新文件都不动', async () => {
  const { DOCKER_SOCKET_HINT } = await import('../src/core/snowluma-update.js');
  const dir = makeProject({ image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
  const envPath = path.join(dir, '.env');
  const before = fs.readFileSync(envPath, 'utf8');
  const calls = [];
  const updater = createSnowlumaUpdater({
    composeDir: dir,
    container: 'qq-agent-snowluma',
    // 预检分支要确定性：不注入的话这条用例的分支随运行环境有没有 NNP 漂移
    //（测试要验的是"没免密 sudo → 给人工步骤"这一支；NNP 分支由 #392 专门覆盖）
    hasNoNewPrivs: () => false,
    exec(cmd, args) {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'docker' && args[0] === 'info') {
        return { ok: false, code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock' };
      }
      // 回退尝试也要报失败（模拟“没有免密 sudo”）：这时才该给出人工修复步骤
      if (cmd === 'sudo') {
        return { ok: false, code: 1, stdout: '', stderr: 'sudo: a password is required' };
      }
      // inspect 是 status() 用来读“当前镜像/容器状态”的只读调用，允许它；
      // 真正要钉死的是：预检没过就绝不允许 compose pull / up（那才会改东西）。
      if (cmd === 'docker' && args[0] === 'inspect') {
        return { ok: true, code: 0, stdout: args.join(' ').includes('.Config.Image') ? 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15\n' : 'exited\n', stderr: '' };
      }
      throw new Error(`预检没过却继续调了 docker：${cmd} ${args.join(' ')}`);
    },
    probe: async () => ({ ok: true, status: 200 }),
    log: () => {},
    readyPollMs: 1,
    readyTimeoutMs: 30
  });

  const res = await updater.update({ to: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.22' });

  assert.equal(res.ok, false);
  assert.equal(res.stage, 'preflight', '要在 preflight 阶段就挡住，而不是走到 pull 才报');
  // 断言"有可执行的修复命令"要钉到**正向命令**上：2026-10-09 换文案后，
  // 用 includes('systemctl restart user@') 会被"不要用 restart"的警告句满足（假绿）。
  assert.ok(res.error.includes('sudo systemctl stop user@') && res.error.includes('sudo systemctl start user@'),
    '要给能直接执行的修复命令（stop → sleep → start 三段式）');
  assert.ok(res.error.includes(DOCKER_SOCKET_HINT));
  assert.equal(fs.readFileSync(envPath, 'utf8'), before, '.env 必须原样未动');
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false, '预检没过不该产生备份目录');
  assert.deepEqual(calls.filter((c) => c.includes('compose')), [], '预检没过绝不允许走到 compose pull / up');
  assert.equal(calls.filter((c) => c.startsWith('docker info')).length, 1, '只允许探一次');
});

test('Issue #30：没有 docker 组但 sudo -n 可用时，更新走 sudo 回退并且真的能跑完', async () => {
  // 这是这条 issue 的**真正的修法**：非 root 进程无法给自己补上缺失的补充组
  // （实测 systemd-run --user -p SupplementaryGroups=docker 报 Operation not permitted），
  // 所以唯一的“当下就能用”的路是走 sudo —— deploy-all.sh 早就在用同一条路。
  const dir = makeProject({ image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
  const docker = fakeDocker({ dir });
  const baseExec = docker.exec;
  const seen = [];
  docker.exec = (cmd, args, opts) => {
    seen.push([cmd, ...args].join(' '));
    // 直接 docker：一律“套接字没权限”；sudo -n docker：转交给假 docker 本体
    if (cmd === 'docker') {
      return { ok: false, code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' };
    }
    if (cmd === 'sudo' && args[0] === '-n' && args[1] === 'docker') {
      const inner = args.slice(2);
      if (inner[0] === 'info') return { ok: true, code: 0, stdout: '24.0.7\n', stderr: '' };
      return baseExec('docker', inner, opts);
    }
    return { ok: false, code: -1, stdout: '', stderr: `unhandled ${cmd}` };
  };

  const res = await makeUpdater(dir, docker).update({ to: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.22' });
  assert.equal(res.ok, true, 'sudo 回退可用时，更新应当成功（这就是 issue #30 的修法）');
  assert.equal(res.viaSudo, true, '结果要如实标记“这次是走 sudo 跑的”');
  assert.ok(seen.some((c) => c.startsWith('sudo -n docker compose')), 'compose 要走 sudo');
  // 直接 docker 失败后必须落到 sudo，而不是卡在原地说“权限不足”
  assert.ok(seen.some((c) => c.startsWith('docker info')));
  assert.ok(seen.some((c) => c.startsWith('sudo -n docker info')));
});

test('NNP 加固的 unit 里一次 sudo 都不试，报错直接指向真正的修法（2026-10-09 审查）', async () => {
  // NoNewPrivileges 下 sudo 必失败（内核禁止 setuid 提权），而标准 unit 默认带加固。
  // 试一次注定失败的提权只会把用户引向"是不是 sudo 没配"——真正的修法是重启 user manager。
  const dir = makeProject({ image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
  const docker = fakeDocker({ dir });
  const seen = [];
  docker.exec = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'docker') {
      return { ok: false, code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' };
    }
    return { ok: false, code: -1, stdout: '', stderr: `unhandled ${cmd}` };
  };
  const updater = createSnowlumaUpdater({
    composeDir: dir,
    container: 'qq-agent-snowluma',
    webuiPort: 5099,
    exec: docker.exec,
    probe: async () => ({ ok: true, status: 200 }),
    hasNoNewPrivs: () => true,          // 模拟 install-service.mjs 生成的加固 unit
    log: () => {}
  });
  const res = await updater.update({ to: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.22' });
  assert.equal(res.ok, false);
  assert.equal(seen.some((c) => c.startsWith('sudo')), false, '加固时必须一次 sudo 都不试');
  assert.match(String(res.error || ''), /NoNewPrivileges/, '报错要指出加固这个真因');
  assert.equal(/已尝试 sudo/.test(String(res.error || '')), false,
    '没试过就不许说"已尝试 sudo 回退"（会把用户引向 sudo 配置错误）');
});

test('dockerSocketHintLocal：按本机诊断给出精确命令，且通用提示不再埋 terminate-user 的雷', async () => {
  const { dockerSocketHintLocal, DOCKER_SOCKET_HINT } = await import('../src/core/snowluma-update.js');
  // ① 诊断不可用（非 Linux / 命令缺失）：不给本机段
  assert.equal(dockerSocketHintLocal({ userInGroup: null }), '');
  assert.equal(dockerSocketHintLocal({}), '');
  // ② 已在 docker 组：只差让管理器读到 —— 给 stop/sleep/start 三步，且不该再叫用户 usermod
  const one = dockerSocketHintLocal({ user: 'ubuntu', groupExists: true, userInGroup: true });
  assert.match(one, /sudo systemctl stop user@/);
  assert.match(one, /sleep 3/);
  assert.match(one, /sudo systemctl start user@/);
  assert.equal(/systemctl restart user@/.test(one), false,
    '不许给 restart：实测会撞 219/CGROUP 且失败后不自动恢复');
  assert.equal(/usermod/.test(one), false, '已经在组里就不该再让用户 usermod');
  // ③ 不在组：加组 + 重建四步
  const two = dockerSocketHintLocal({ user: 'ubuntu', groupExists: true, userInGroup: false });
  assert.match(two, /sudo usermod -aG docker ubuntu/);
  assert.match(two, /sudo systemctl stop user@/);
  assert.match(two, /sudo systemctl start user@/);
  // ④ 没有 docker 组（非标准安装）：指向文档，不给命令
  const none = dockerSocketHintLocal({ user: 'ubuntu', groupExists: false, userInGroup: false });
  assert.match(none, /LINUX\.md/);
  // ⑤ 2026-10-09 实测：terminate-user 不会自动重建、restart 会撞 219/CGROUP —— 都不许当修复手段
  assert.equal(/sudo loginctl terminate-user/.test(DOCKER_SOCKET_HINT), false,
    'DOCKER_SOCKET_HINT 不许再教 terminate-user');
  assert.equal(/sudo systemctl restart user@/.test(DOCKER_SOCKET_HINT), false,
    'restart user@ 是 219/CGROUP 的雷（实测），不许再当修复命令');
  assert.match(DOCKER_SOCKET_HINT, /sudo systemctl stop user@/);
  assert.match(DOCKER_SOCKET_HINT, /sudo systemctl start user@/);
});

test('baselineAlignDecision：唯一对齐条件与五种跳过原因（随 Agent 版本对齐，2026-10-09）', async () => {
  const { baselineAlignDecision } = await import('../src/core/snowluma-update.js');
  const base = { installed: true, outdated: true, override: '', followBaseline: true, busy: false };
  assert.equal(baselineAlignDecision(base), 'align');
  assert.equal(baselineAlignDecision({ ...base, installed: false }), 'skip:not-installed');
  assert.equal(baselineAlignDecision({ ...base, override: 'registry.local/snowluma:v9.9.9' }), 'skip:override');
  assert.equal(baselineAlignDecision({ ...base, followBaseline: false }), 'skip:disabled');
  assert.equal(baselineAlignDecision({ ...base, busy: true }), 'skip:busy');
  assert.equal(baselineAlignDecision({ ...base, outdated: false }), 'skip:up-to-date');
  // 顺序语义：自定义镜像优先于一切配置（锁版本的机器永不被自动动到）
  assert.equal(baselineAlignDecision({ ...base, override: 'x:v1', followBaseline: false, busy: true }),
    'skip:override', 'override 先于 disabled/busy 判定');
  // 缺键即开：真实配置里没有 followBaseline 这个键，传入 undefined 必须按"开"走（2026-10-09 审查）
  assert.equal(baselineAlignDecision({ installed: true, outdated: true }), 'align',
    'followBaseline 缺省＝开');
  // 默认参数：什么都不传 = 没装 + 不落后 → 跳过（绝不误触发）
  assert.equal(baselineAlignDecision(), 'skip:not-installed');
});

test('QQ_AGENT_NO_SUDO_DOCKER=1 时不走 sudo 回退（给不想让服务提权的部署留开关）', async () => {
  const prev = process.env.QQ_AGENT_NO_SUDO_DOCKER;
  process.env.QQ_AGENT_NO_SUDO_DOCKER = '1';
  try {
    const dir = makeProject({ image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
    const docker = fakeDocker({ dir });
    const baseExec = docker.exec;
    const seen = [];
    docker.exec = (cmd, args, opts) => {
      seen.push([cmd, ...args].join(' '));
      if (cmd === 'docker') return { ok: false, code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' };
      if (cmd === 'sudo') return baseExec('docker', args.slice(2), opts);
      return { ok: false, code: -1, stdout: '', stderr: 'unhandled' };
    };
    const res = await makeUpdater(dir, docker).update({ to: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.22' });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'preflight');
    assert.equal(seen.some((c) => c.startsWith('sudo')), false, '开关打开时不许出现任何 sudo 调用');
  } finally {
    if (prev === undefined) delete process.env.QQ_AGENT_NO_SUDO_DOCKER;
    else process.env.QQ_AGENT_NO_SUDO_DOCKER = prev;
  }
});

test('Issue #30：pull 阶段才发现没权限（例如 docker info 恰好能过）也要给可执行提示', async () => {
  const dir = makeProject({ image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
  const docker = fakeDocker({ dir });
  const baseExec = docker.exec;
  // 场景：docker info 过得去（所以预检放行），但真正 pull 的时候才撚上权限错误 ——
  // 比如守护进程中途被重启、或运维改回了 socket 权限。要钉的是“pull 失败也得给可执行步骤”。
  // sudo 回退也失败（没有免密 sudo）。
  docker.exec = (cmd, args, opts) => {
    if (cmd === 'sudo') return { ok: false, code: 1, stdout: '', stderr: 'sudo: a password is required' };
    if (cmd === 'docker' && args[0] === 'info') return { ok: true, code: 0, stdout: '24.0.7\n', stderr: '' };
    if (cmd === 'docker' && args[0] === 'compose' && args.includes('pull')) {
      return { ok: false, code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' };
    }
    return baseExec(cmd, args, opts);
  };
  const res = await makeUpdater(dir, docker).update({ to: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.22' });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'pull');
  assert.ok(res.error.includes('systemctl restart user@'), 'pull 失败也要把原始 stderr 换成可执行步骤');
  assert.ok(res.error.includes('sudo -n docker 回退'), '要说清“连 sudo 都试过了”，否则用户会以为没试');
});
