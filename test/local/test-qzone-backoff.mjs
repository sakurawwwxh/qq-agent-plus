// 本地回归：空间互动接口异常时不再每秒重试（指数退避到分钟级），也不再"第一次失败就上报"。
//
// 这是 2026-09-17 那次"失败后 1.4 秒重试一次、6 分钟刷了两百次"事故的回归用例。
// 用假时钟 + 可控定时器，毫秒级验证：
//   ① 好友动态抓取失败先重试一次（每轮最多 2 次请求，绝不刷屏）；
//   ② 失败只记账不当故障：前两次安静退避（2 分钟 → 4 分钟），第 3 次才上报一条异常通知；
//   ③ 失败期间不算建立动态基线（免得把上线前的旧动态当新内容），接口恢复后计数清零、回到正常节奏。
//
// 用法：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-backoff.mjs
//
// 重要：必须用临时 QQ_AGENT_DATA_DIR（本用例会往里面写 config.json 和状态文件），
//       绝不能指向生产数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = process.env.QQ_AGENT_DATA_DIR;
if (!dataDir) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 指向一个临时目录，例如：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-backoff.mjs');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active', paused: false },
  qzoneInteractions: { enabled: true }
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const { QzoneInteractionManager } = await import(
  pathToFileURL(path.join(repoRoot, 'src', 'features', 'qzone-interactions.js')).href
);

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let fakeNow = Date.parse('2026-09-19T02:00:00Z');
const timers = [];
globalThis.setTimeout = (fn, ms) => {
  const handle = { fn, ms: Number(ms) || 0, canceled: false };
  timers.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  if (handle && typeof handle === 'object') handle.canceled = true;
};

let feedAttempts = 0;
let replyAttempts = 0;
let feedsHealthy = false;
let emptyMessage = false;
const onebot = {
  selfId: '10000001',
  async call(action) {
    if (action === 'get_qzone_feeds') {
      feedAttempts += 1;
      if (emptyMessage) throw new Error('');
      if (!feedsHealthy) {
        throw new Error('OneBot get_qzone_feeds 失败: retcode=100 qzone feeds failed: code=-10001 network busy');
      }
      return { feeds: [] };
    }
    if (action === 'get_qzone_msg_list') {
      replyAttempts += 1;
      return { msglist: [] };
    }
    throw new Error(`用例未覆盖的接口: ${action}`);
  }
};
const logs = [];
const mgr = new QzoneInteractionManager({
  onebot,
  now: () => fakeNow,
  sleep: () => Promise.resolve(),
  log: (...args) => logs.push(args.join(' '))
});

const statePath = path.join(dataDir, 'qzone-interactions.json');
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const notifications = () => logs.filter((line) => line.includes('run failed'));

const peek = () => {
  const live = timers.filter((timer) => !timer.canceled);
  return live[live.length - 1] || null;
};
const fire = async () => {
  const timer = peek();
  if (!timer) throw new Error('没有排到下一次巡检');
  timer.canceled = true;
  timer.fn();
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    if (!mgr.running) break;
  }
  const next = peek();
  return next ? next.ms : -1;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

try {
  mgr.start();
  const first = peek();
  check('启动后先等 15 秒再巡检', first?.ms === 15000, `排了 ${first?.ms}ms`);

  // ① 首轮失败：抓取重试一次（共 2 次请求），整轮其余照跑，退避 2 分钟
  const afterFirst = await fire();
  check('首轮失败会重试一次（共 2 次请求，不是刷屏）', feedAttempts === 2, `feedAttempts=${feedAttempts}`);
  check('失败轮仍然检查了评论回复', replyAttempts === 1, `replyAttempts=${replyAttempts}`);
  check('失败后退避到 2 分钟', afterFirst === 120000, `实际 ${Math.round(afterFirst / 1000)}s`);
  check('第 1 次失败不发异常通知', notifications().length === 0, `notifications=${notifications().length}`);
  check('failStreak 记为 1', readState().failStreak === 1, `failStreak=${readState().failStreak}`);
  check('没读到动态就不算建立基线（免得旧动态被当新内容）',
    !readState().feedInitializedAt, `feedInitializedAt=${readState().feedInitializedAt}`);

  // ② 第二次失败：仍安静，退避翻倍到 4 分钟
  fakeNow += 120000;
  const afterSecond = await fire();
  check('第二轮仍只尝试 2 次', feedAttempts === 4, `feedAttempts=${feedAttempts}`);
  check('连续失败退避翻倍到 4 分钟', afterSecond === 240000, `实际 ${Math.round(afterSecond / 60000)} 分钟`);
  check('第 2 次失败仍不发异常通知', notifications().length === 0, `notifications=${notifications().length}`);

  // ③ 第三次失败：这才上报一条异常通知，退避 8 分钟
  fakeNow += 240000;
  const afterThird = await fire();
  check('第三轮仍只尝试 2 次', feedAttempts === 6, `feedAttempts=${feedAttempts}`);
  check('第 3 次连续失败应该上报一条异常通知', notifications().length === 1, `notifications=${notifications().length}`);
  check('上报文案带上了原因', /network busy/.test(notifications()[0] || ''), notifications()[0] || '无');
  check('连续失败退避到 8 分钟', afterThird === 480000, `实际 ${Math.round(afterThird / 60000)} 分钟`);
  check('failStreak 记为 3', readState().failStreak === 3, `failStreak=${readState().failStreak}`);
  const failingRun = readState().runs[0];
  check('运行记录标明本轮动态没取到', failingRun.status === 'partial-feed-error' && Boolean(failingRun.feedError),
    `status=${failingRun.status} feedError=${failingRun.feedError || '无'}`);

  // ④ 第四次失败：只报过一次就不再补报（不能变成每轮都顶一条），退避继续翻倍到 16 分钟
  fakeNow += 480000;
  const afterFourth = await fire();
  check('第 4 次失败不重复上报', notifications().length === 1, `notifications=${notifications().length}`);
  check('退避继续翻倍到 16 分钟', afterFourth === 960000, `实际 ${Math.round(afterFourth / 60000)} 分钟`);

  // ⑤ 接口恢复：失败计数清零、建立基线、回到正常节奏
  feedsHealthy = true;
  fakeNow += 960000;
  const afterRecovery = await fire();
  const state = readState();
  check('恢复后 failStreak 清零', !state.failStreak, `failStreak=${state.failStreak}`);
  check('恢复后这一轮建立了动态基线', Boolean(state.feedInitializedAt), `feedInitializedAt=${state.feedInitializedAt}`);
  check('恢复后按正常回复间隔排期（5 分钟）', afterRecovery === 300000, `实际 ${Math.round(afterRecovery / 60000)} 分钟`);

  fakeNow += 300000;
  await fire();
  check('下一轮恢复正常状态（idle，无降级标记）',
    readState().runs[0].status === 'idle' && !readState().runs[0].feedError,
    `status=${readState().runs[0].status} feedError=${readState().runs[0].feedError || '无'}`);

  // ⑥ 最坏情况压测：接口长期失败时绝不打密。
  //    2026-09-17 那次事故是"失败后每秒重试"→ 3 分钟打了 191 次 → QQ 直接限流。
  //    这里用假时钟连续跑 24 小时（全程失败），逐轮统计外部请求数与轮次间隔。
  //    ⚠️ 统计口径只有两路：抓取（首次 + 重试一次，最多 2 次）与评论列表（1 次）。
  //    所以下面"每轮最多 3 次"是这两路的上限，**不是**"整轮只发 3 次请求"——
  //    失败轮还会照常跑评论回复（详情轮询与写操作另有自己的上限），本用例不覆盖那部分。
  mgr.stop();
  feedsHealthy = false;
  fakeNow += 300000;
  timers.length = 0;
  mgr.start();
  const stormStart = fakeNow;
  const feedBeforeStorm = feedAttempts;
  const replyBeforeStorm = replyAttempts;
  const notificationsBeforeStorm = notifications().length;
  let rounds = 0;
  let busiestRound = 0;
  let minDelay = Infinity;
  while (fakeNow - stormStart < 24 * 3600000 && rounds < 500) {
    const before = feedAttempts + replyAttempts;
    const schedule = await fire();
    const used = feedAttempts + replyAttempts - before;
    busiestRound = Math.max(busiestRound, used);
    if (schedule > 0) minDelay = Math.min(minDelay, schedule);
    rounds += 1;
    if (!(schedule > 0)) break;
    fakeNow += schedule;
  }
  const stormRequests = feedAttempts + replyAttempts - feedBeforeStorm - replyBeforeStorm;
  console.log(`  （24 小时持续失败：${rounds} 轮、共 ${stormRequests} 次请求、最少间隔 ${Math.round(minDelay / 1000)} 秒`
    + '；回复检查本身按配置的 5 分钟一轮，失败时还被退避拖慢）');
  check('持续失败时一轮最多 3 次外部请求（动态重试 2 次 + 评论列表 1 次）',
    busiestRound <= 3, `实测最多 ${busiestRound} 次/轮`);
  check('持续失败时任意两轮间隔不少于 2 分钟（事故时是 1.4 秒一轮）',
    minDelay >= 120000, `实测最小间隔 ${Math.round(minDelay / 1000)} 秒`);
  check('24 小时持续失败的总请求数在两百次以内（事故时 3 分钟 191 次）',
    stormRequests <= 200, `24 小时共 ${stormRequests} 次（${rounds} 轮）`);
  check('连续失败期间只在第 3 次上报一条，之后不再补报',
    notifications().length - notificationsBeforeStorm === 1,
    `本轮失败新增 ${notifications().length - notificationsBeforeStorm} 条`);

  // ⑦ 边界：错误对象没有 message（空字符串）时也必须算失败。
  //    否则 feedError 为空串会被当成"这轮没失败"，下一轮只隔 1 秒 —— 就是打密的形态。
  feedsHealthy = true;
  emptyMessage = true;
  mgr.stop();
  fakeNow += 60000;
  timers.length = 0;
  mgr.start();
  const afterEmptyMessage = await fire();
  check('空错误信息也按失败处理：下一轮仍按退避排（分钟级，不是 1 秒）',
    afterEmptyMessage >= 120000, `实际 ${Math.round(afterEmptyMessage / 1000)} 秒`);
  check('运行记录里的失败原因不为空',
    Boolean(readState().runs[0].feedError), `feedError=${JSON.stringify(readState().runs[0].feedError || '')}`);
  emptyMessage = false;
} catch (error) {
  results.push(false);
  console.log('FAIL 用例异常终止:', error?.message ?? error);
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log(`\n退避用例: ${results.filter(Boolean).length}/${results.length} 通过`);
process.exit(results.every(Boolean) ? 0 : 1);
