// 一键安装入口（install.sh）的行为用例：
//   1) 零问答：以 --yes 调 deploy-all.sh，模型配置默认跳过（--skip-model-config）；
//   2) 显式给了模型参数/环境变量就不跳过（透传）；
//   3) root 交给 root-install.sh 做降权准备，不会直接执行 deploy-all.sh；
//   4) deploy-all.sh 失败时退出码透传 + 给日志路径；成功时打印"接下来三步"（控制台带
//      令牌的链接、扫码入口、白名单、安全组端口），这些值要从凭据文件里真实取到；
//   5) 同目录缺 deploy-all.sh 时告诉用户怎么拿完整仓库。
// 用桩 deploy-all.sh 记录收到的一切参数 —— 断言的是 install.sh 真正的装配行为，不是源码文本。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = hasBash ? false : '需要 bash';

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$QQ_STUB_ARGS"
# 端口故意用非默认值：钉住 install.sh 的"安全组清单从实际地址取端口"（写死默认值即红）
printf 'Agent console: http://10.0.0.5:43210\\nAgent token: tok-123\\n' > ./deployment-access.txt
printf 'SnowLuma WebUI: http://10.0.0.5:45099\\nQQ login/noVNC: http://10.0.0.5:46081\\nnoVNC password: 12345678\\n' >> ./deployment-access.txt
printf 'Mode: observe\\n' >> ./deployment-access.txt
# 用 $PWD 的 POSIX 形态（MSYS 下 Windows 盘符路径会读不到）；真实脚本打的也是绝对路径
printf 'Credentials: %s\\n' "$PWD/deployment-access.txt"
exit "\${QQ_STUB_EXIT:-0}"
`;

function fixture(t, { withDeployAll = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-oneclick-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(repo, 'install.sh'), path.join(dir, 'install.sh'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts/root-install.sh'), path.join(dir, 'scripts/root-install.sh'));
  if (withDeployAll) fs.writeFileSync(path.join(dir, 'deploy-all.sh'), STUB);
  const argsFile = path.join(dir, 'args.txt');
  return { dir, argsFile };
}

function run(f, args = [], env = {}) {
  return spawnSync('bash', [path.join(f.dir, 'install.sh'), ...args], {
    cwd: f.dir,
    env: {
      ...process.env,
      // 失败路径会留一份安装日志（install.sh 的 LOG_FILE 走 TMPDIR）：指到 fixture 目录里，
      // 由 t.after 统一清掉，别往系统临时目录漏 qq-* 文件（测试卫生）。
      TMPDIR: f.dir,
      QQ_STUB_ARGS: f.argsFile,
      // 这组用例用桩 deploy-all，不跑真实发行版探测；发行版体检由 platform-check 用例覆盖。
      QQ_AGENT_PLATFORM_CHECKED: '1',
      // 模型意图探测会看这几个环境变量：测试里先清掉，避免外层环境干扰断言
      QQ_AGENT_MODEL_BASE_URL: '', QQ_AGENT_MODEL_API_KEY: '', QQ_AGENT_MODEL: '',
      ...env
    },
    encoding: 'utf8',
    timeout: 20_000
  });
}

const stubArgs = (f) => fs.readFileSync(f.argsFile, 'utf8').trim().split('\n');

test('零问答装配：--yes + 默认跳过模型配置，装完打印接下来三步（值取自凭据文件）', { skip }, (t) => {
  const f = fixture(t);
  const r = run(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stubArgs(f), ['--yes', '--skip-model-config'], '默认应当零问答且把模型配置留到控制台');
  // 三步清单里的真实值：带令牌的控制台链接、扫码入口与密码、白名单、安全组、日志命令
  assert.match(r.stdout, /http:\/\/10\.0\.0\.5:43210\/\?token=tok-123/, '控制台链接要带令牌（点开即进）');
  assert.match(r.stdout, /http:\/\/10\.0\.0\.5:46081/);
  assert.match(r.stdout, /12345678/);
  assert.match(r.stdout, /聊天白名单/);
  assert.match(r.stdout, /安全组放行 43210/,
    '安全组提示里的控制台端口要从实际地址取（非默认端口时要跟着走）');
  assert.match(r.stdout, /ssh -N -L 43210:127\.0\.0\.1:43210/,
    '给出可在本地直接复制的完整隧道命令');
  assert.match(r.stdout, /45099:127\.0\.0\.1:45099/);
  assert.match(r.stdout, /46081:127\.0\.0\.1:46081/);
  assert.match(r.stdout, /console-tunnel\.bat/);
  assert.match(r.stdout, /console-tunnel\.sh/);
  assert.match(r.stdout, /raw\.githubusercontent\.com\/sakurawwwxh\/qq-agent-plus\/main\/console-tunnel\.bat/,
    '给一个不用 scp 的下载地址');
  assert.match(r.stdout, /manage\.sh logs/);
  assert.match(r.stdout, /观察/, 'observe 模式要提示去控制台切「启用」');
});

test('--help：只转发帮助，不继续打印“安装完成”假成功页', { skip }, (t) => {
  const f = fixture(t);
  const r = run(f, ['--help']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stubArgs(f), ['--help'], '帮助参数应直接转给 deploy-all.sh');
  assert.doesNotMatch(r.stdout, /安装完成/, '帮助不能当成安装完成');
});

test('--check-only：只预检就把"预检通过"说成"安装完成"是错的（2026-10-13 审查）', { skip }, (t) => {
  const f = fixture(t);
  const r = run(f, ['--check-only']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stubArgs(f), ['--yes', '--skip-model-config', '--check-only'], '预检参数原样透传');
  assert.doesNotMatch(r.stdout, /安装完成/, '什么都没装就不能打印安装完成清单');
  assert.match(r.stdout, /只做了预检/);
});

test('install.sh 依赖的输出标签仍在 deploy-all.sh 里（改标签即红，别静默取空）', { skip }, () => {
  // install.sh 的 read_field 按这些标签从安装输出/凭据文件取值；deploy-all.sh 改名后
  // install.sh 会静默取到空串（最坏打出 ?token= 的空令牌链接），这里把契约钉死。
  const src = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  for (const needle of ["printf 'Credentials: %s\\n'", 'Agent console:', 'Agent token:',
    'SnowLuma WebUI:', 'QQ login/noVNC:', 'noVNC password:', 'Mode: ']) {
    assert.ok(src.includes(needle), `deploy-all.sh 里应仍输出「${needle}」`);
  }
});

test('显式模型参数/环境变量会透传且不再跳过模型配置', { skip }, (t) => {
  const a = fixture(t);
  const ra = run(a, ['--model-base-url', 'https://api.example.test', '--model', 'm-1', '--model-api-key', 'k-1']);
  assert.equal(ra.status, 0, ra.stdout + ra.stderr);
  assert.deepEqual(stubArgs(a),
    ['--yes', '--model-base-url', 'https://api.example.test', '--model', 'm-1', '--model-api-key', 'k-1'],
    '用户参数原样透传，且不再追加 --skip-model-config');

  const b = fixture(t);
  const rb = run(b, [], { QQ_AGENT_MODEL_API_KEY: 'k-2' });
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  assert.deepEqual(stubArgs(b), ['--yes'], '环境变量给了 Key 也不跳过（Key 的值随环境进子进程，不出现在参数里）');
});

test('root 自动进入降权准备：不会直接执行 deploy-all.sh', { skip }, (t) => {
  const f = fixture(t);
  const binDir = path.join(f.dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
  const r = run(f, [], {
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    // 测试环境不是 root：只让 root 包装层打印计划，绝不创建用户/改系统
    QQ_AGENT_ROOT_INSTALL_TEST: '1',
    // ⚠️ 部署根目录必须显式指到 fixture **旁边**：root-install.sh 默认用 /mnt/data/qq-agent，
    // 而 fixture 建在 os.tmpdir() 下 —— 在部署机上跑测试时 TMPDIR 往往就在 /mnt/data/qq-agent 里
    // （auto-update 用 <checkout>/.auto-update-test-tmp），源码会落进默认部署根目录，
    // 被"源码不能放在部署根目录里"的安全闸门拦下，用例想验的降权计划反而没机会打印。
    QQ_AGENT_STACK_DIR: `${f.dir}-stack`
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /root 安装准备/);
  assert.match(r.stdout, /服务用户：qqagent/);
  assert.match(r.stdout, /机器人将以它运行，不是 root/);
  assert.match(r.stdout, /以 qqagent 执行 install\.sh/);
  assert.equal(fs.existsSync(f.argsFile), false, 'root 包装层不能直接执行 deploy-all.sh');
});

test('deploy-all.sh 失败：退出码透传并给出日志路径；不会假装成功打印三步', { skip }, (t) => {
  const f = fixture(t);
  const r = run(f, [], { QQ_STUB_EXIT: '3' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /安装没有完成（退出码 3）/);
  assert.match(r.stderr, /完整日志：/);
  assert.doesNotMatch(r.stdout, /接下来三步/, '失败时不能打印成功清单');
});

test('同目录缺 deploy-all.sh：告诉用户拿完整仓库，而不是静默失败', { skip }, (t) => {
  const f = fixture(t, { withDeployAll: false });
  const r = run(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /找不到同目录的 deploy-all\.sh/);
  assert.match(r.stderr, /git clone/);
});
