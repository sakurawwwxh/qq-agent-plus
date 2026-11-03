#!/usr/bin/env node
// 测试临时目录集中清理入口（测试卫生，2026-10-09）。
//
// 为什么需要：大量用例用 `fs.mkdtempSync(path.join(os.tmpdir(), 'qq-...-'))` 建工作目录，
// 用完不删；一轮全量会往系统临时目录里堆上百个 qq-* 目录（本地实测单轮 220 个），CI/
// 服务器长期跑会把 /tmp 塞满。调用点分散在 123 个文件、共 185 处，逐个改的改动面太大，
// 所以在唯一入口把**子进程**的 TMPDIR/TMP/TEMP 指到本次运行专属的一个根目录，跑完整体
// 删除 —— 一次覆盖全部用例，且不改任何测试逻辑。
//
// 为什么必须在子进程里设：os.tmpdir() 在进程启动时读环境变量（Node 文档口径），
// 在本进程里改已经晚了；只有 spawn 出去的子进程才会读到新的值。
//
// 安全边界：基础目录仍取当前 os.tmpdir()（即尊重用户已设的 TMPDIR/TMP/TEMP），只删
// 我们自己 mkdtemp 出来的那一层；绝不删启动时就已存在的临时目录内容。作为兜底，运行期间
// 新出现在基准目录下、名字以 qq- 开头的目录也会被清掉（见 cleanup 里的说明）。
// 清理在正常退出、测试失败、以及收到 SIGINT/SIGTERM 时都会执行。
//
// 用法：
//   node scripts/test-suite.mjs             # = npm test（单元 + 提示词/渲染/滚动/用量回归）
//   node scripts/test-suite.mjs unit        # = npm run test:unit
//   node scripts/test-suite.mjs local       # = npm run test:local
//   node scripts/test-suite.mjs regression  # = 四个独立回归脚本
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 单元用例即目录清单：等价于 `node --test test/*.test.mjs`，但不依赖 shell 展开 glob
// （npm 在 Windows 下走 cmd.exe，glob 不展开，交给 shell 会在跨平台时掉用例）。
const UNIT_FILES = fs
  .readdirSync(path.join(repoRoot, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join('test', f));

// 并发度默认压到 4：几百个测试文件里不少会临时监听端口/启动 app，默认按 CPU 核数
// 并发时 Windows 上偶发端口抢占（表现为某个文件整体 "test failed"、单独跑却全绿）。
const TEST_CONCURRENCY = String(Math.max(1, Number(process.env.QQ_AGENT_TEST_CONCURRENCY) || 4));

const SUITES = {
  unit: [[process.execPath, [`--test-concurrency=${TEST_CONCURRENCY}`, '--test', ...UNIT_FILES]]],
  regression: [
    [process.execPath, ['test/test-prompt.mjs']],
    [process.execPath, ['test/render-test.mjs']],
    [process.execPath, ['test/scroll-test.mjs']],
    [process.execPath, ['test/usage-e2e.mjs']],
  ],
  local: [[process.execPath, ['test/local/run.mjs']]],
  // 覆盖率：与 unit 同一批文件，只是多一个 Node 内置覆盖率开关；
  // 走这里可以复用 TMPDIR 重定向与统一清理。
  coverage: [[process.execPath, [`--test-concurrency=${TEST_CONCURRENCY}`, '--experimental-test-coverage', '--test', ...UNIT_FILES]]],
};
// 默认集与改动前的 `npm test` 完全一致：只含 unit + regression，不含 local。
SUITES.all = [...SUITES.unit, ...SUITES.regression];

const requested = process.argv[2] || 'all';
const commands = SUITES[requested];
if (!commands) {
  console.error(`未知测试集：${requested}（可选：${Object.keys(SUITES).join(' / ')}）`);
  process.exit(2);
}

// 重定向基准：先取当前 tmpdir（尊重用户已设的 TMPDIR/TMP/TEMP），并记下里面已有的
// qq-* 目录；启动时就存在的（用户或上一次留下的）一律不动，清理只针对新建的。
const baseTmp = os.tmpdir();
const preexisting = new Set(fs.readdirSync(baseTmp).filter((n) => n.startsWith('qq-')));
// ⚠️ 运行中的服务也会在系统 tmp 下建工作目录（image-downsample 的 qq-ffmpeg-/qq-ffprobe-、
// 运维脚本的 qq-agent-face-names-/qq-agent-model-key-）。它们和"漏网测试子进程的产物"
// 从名字上无法区分，只能按已知前缀排除：在部署机上跑 npm test 时误删正在跑的 ffmpeg
// 工作目录，会让那次图片/GIF 处理直接失败（2026-10-09 审查）。新增运行时 tmp 前缀时同步这里。
const RUNTIME_TMP_PREFIXES = [
  'qq-ffmpeg-', 'qq-ffprobe-', 'qq-agent-face-names-', 'qq-agent-model-key-',
  'qq-diagnose-', 'qq-diagnose-fallback-', 'qq-stack-creds-',
  'qq-backup-drill-', 'qq-restore-', 'qq-agent-local-'
];
const tmpRoot = fs.mkdtempSync(path.join(baseTmp, 'qq-test-root-'));
let cleaned = false;
function rmBestEffort(target) {
  // maxRetries/retryDelay：子进程（尤其是 node --test 拉起的用例孙进程）在被杀后
  // 可能还短暂持着文件句柄，Windows 上会 EPERM/EBUSY；多等几轮让它们退干净。
  return fs.rmSync(target, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
}
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    rmBestEffort(tmpRoot);
  } catch (err) {
    // 清理失败不应覆盖测试结果，但要能看见。
    console.error(`[test-suite] 临时目录清理失败：${tmpRoot} —— ${err.message}`);
  }
  // 兜底：个别用例直接 spawn 子进程时没有把 process.env 一起传过去
  // （例如 test/deployment-*.test.mjs 里的 `env: { HOME, PATH }`），子进程看到的
  // TMPDIR 是空的，它的 os.tmpdir() 就落回系统默认目录，绕过上面的重定向、把 qq-*
  // 散在那里。这里只清「本次运行期间新出现的 qq-* 目录」，启动时已存在的绝不动。
  // 只认目录：避免误删用户重定向到 /tmp 的 qq-*.txt 之类的普通文件。
  try {
    for (const entry of fs.readdirSync(baseTmp, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('qq-')) continue;
      if (RUNTIME_TMP_PREFIXES.some((p) => entry.name.startsWith(p))) continue;   // 可能是运行中服务的目录，别动
      if (preexisting.has(entry.name) || entry.name === path.basename(tmpRoot)) continue;
      // ⚠️ 别的 test-suite 实例的根目录（qq-test-root-*）：它在启动**之后**出现，所以不在
      // preexisting 里 —— 原来的写法会把**并发跑的另一个实例**的根删掉，那个实例里的用例随后
      // 报 `mkdtemp ENOENT`（2026-10-17 实测：两个 run 并行，NNP 那轮恰好挂在构建戳用例上）。
      // 根目录由它自己的 cleanup() 负责；只清超过 6 小时的（确认是死掉的残留）。
      if (entry.name.startsWith('qq-test-root-')) {
        let ageMs = 0;
        try { ageMs = Date.now() - fs.statSync(path.join(baseTmp, entry.name)).mtimeMs; } catch { ageMs = 0; }
        if (ageMs < 6 * 60 * 60 * 1000) continue;
      }
      rmBestEffort(path.join(baseTmp, entry.name));
    }
  } catch (err) {
    console.error(`[test-suite] 兜底清理失败：${err.message}`);
  }
}

// 子进程只继承我们重定向后的临时目录，其余环境原样透传。
// 单元测试会频繁 createApp().start()；默认配置里的技能索引是真实 GitHub 地址，
// 启动预热会让每个测试都发一次外网请求（离线 CI 还会拖到超时）。测试集里统一关掉。
const childEnv = { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot, QQ_AGENT_SKIP_INDEX_WARM: '1', QQ_AGENT_SKIP_NETWORK_PROBES: '1' };
let current = null;
let aborted = null;

function run(cmd, args) {
  return new Promise((resolve) => {
    current = spawn(cmd, args, { cwd: repoRoot, env: childEnv, stdio: 'inherit' });
    current.on('close', (code, signal) => {
      current = null;
      resolve({ code, signal });
    });
  });
}

// 收到信号先把信号转给正在跑的子进程，主循环退出后统一清理。
function onSignal(sig) {
  aborted = aborted || sig;
  if (current) current.kill(sig);
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
// 兜底：任何路径退出都清一次（cleanup 幂等）。
process.on('exit', cleanup);

let exitCode = 0;
for (const [cmd, args] of commands) {
  if (aborted) break;
  const { code, signal } = await run(cmd, args);
  if (signal) {
    aborted = signal;
    break;
  }
  if (code !== 0) {
    exitCode = code ?? 1;
    break;
  }
}

// 信号中断时给刚被杀掉的子进程/孙进程一点退出时间再清，否则它们手里的文件句柄会让 rm 失败。
if (aborted) await new Promise((resolve) => setTimeout(resolve, 1000));
cleanup();
if (aborted) process.exit(aborted === 'SIGINT' ? 130 : 143);
// 不用 process.exit：最后一个子进程的 stdio 句柄可能还在异步关闭，
// Windows 上强制退出会撞 libuv 断言（`UV_HANDLE_CLOSING`，表现为用例全过但退出码 127）。
// 设置 exitCode 让事件循环自然结束即可。
process.exitCode = exitCode;
