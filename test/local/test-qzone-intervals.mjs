// 本地回归：动态互动的巡检节奏（好友动态 24 小时 / 评论回复 2 小时）。
//
// 用假时钟 + 可控定时器把 24 小时压到毫秒级验证，覆盖这几件事：
//   1) 首轮之后下一次排在 120 分钟（两个间隔取近的那个）
//   2) 只到回复的间隔时，只跑回复那一半，不碰好友动态接口
//   3) 好友动态满 24 小时才跑；那一刻回复还没到点，就单独跑好友动态
//   4) 接口失败先重试一次，再退避到分钟级（2→4→8 分钟），连续第 3 次才上报，不会每秒重试
//   5) 到点在活跃时段之外时不调用接口，排到下一个时段开始
//   6) 没有新内容的一轮不调模型（0 token）
//
// 用法：
//   T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-intervals.mjs
//
// 重要：必须用临时 QQ_AGENT_DATA_DIR（本用例会往里面写 config.json），
//       绝不能指向生产数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = process.env.QQ_AGENT_DATA_DIR;
if (!dataDir) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 指向一个临时目录，例如：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-intervals.mjs');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });

const FEED_MINUTES = 1440;
const REPLY_MINUTES = 120;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active', paused: false },
  qzoneInteractions: {
    enabled: true,
    feedIntervalMinutes: FEED_MINUTES,
    replyIntervalMinutes: REPLY_MINUTES,
    // 默认整段活跃，节奏断言不被活跃时段干扰（活跃时段单独在第 5 项测）
    activeHours: { start: '00:00', end: '23:59' }
  }
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const { QzoneInteractionManager } = await import(
  pathToFileURL(path.join(repoRoot, 'src', 'features', 'qzone-interactions.js')).href
);

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

// ── 假时钟 + 可控定时器：把 24 小时的排期压缩成"手动点火" ──
// 活跃时段按配置时区（time-control 的 TIME_ZONE，固定 Asia/Shanghai）判读钟点，跟跑测机器的
// 时区无关：CI 跑在 UTC 上，直接 new Date(2026, 8, 19, 2, 0) 造出来的"凌晨两点"在那边是上午十点，
// 断言就会莫名其妙地挂。所以时间戳一律按那个时区造。
const { TIME_ZONE } = await import(pathToFileURL(path.join(repoRoot, 'src', 'core', 'time-control.js')).href);
const zonedMs = (y, m, d, hh, mm) => {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(guess));
  const pick = (type) => Number(parts.find((part) => part.type === type).value);
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour') % 24, pick('minute'));
  return guess - (asUtc - guess);
};
let fakeNow = zonedMs(2026, 9, 19, 10, 0); // 该时区的 09-19 10:00，在活跃时段内
let timers = [];
globalThis.setTimeout = (fn, ms, ...args) => {
  const handle = { fn, ms: Number(ms) || 0, args, canceled: false };
  timers.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  if (handle && typeof handle === 'object') handle.canceled = true;
};

const calls = { feed: 0, reply: 0 };
let modelCalls = 0;
let failFeeds = false;
const onebot = {
  selfId: '10000001',
  selfNickname: '测试昵称',
  async call(method) {
    if (method === 'get_qzone_feeds') {
      calls.feed += 1;
      if (failFeeds) throw new Error('OneBot get_qzone_feeds 失败: retcode=100 使用人数过多，请稍后再试');
      return { feeds: [] };
    }
    if (method === 'get_qzone_msg_list') {
      calls.reply += 1;
      return { msglist: [] };
    }
    throw new Error(`用例未覆盖的接口: ${method}`);
  }
};

const logs = [];
const mgr = new QzoneInteractionManager({
  onebot,
  now: () => fakeNow,
  sleep: () => Promise.resolve(),
  complete: async () => { modelCalls += 1; throw new Error('这一轮不该调模型'); },
  log: (...args) => logs.push(args.join(' '))
});

const settle = async () => {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    if (!mgr.running) return;
  }
  throw new Error('巡检在 1 秒内没有结束');
};

const pending = () => timers.filter((timer) => !timer.canceled);
const peek = () => {
  const live = pending();
  return live[live.length - 1] || null;
};
// 触发当前这次巡检，返回"这轮结束后排的下一轮间隔"（毫秒）；没有下一轮则返回 -1
const fire = async (label) => {
  const timer = peek();
  if (!timer) throw new Error(`${label}: 没有排到下一次巡检`);
  timer.canceled = true;
  timer.fn();
  await settle();
  const next = peek();
  return next ? next.ms : -1;
};
const jump = (minutes) => { fakeNow += minutes * 60000; };

const statePath = path.join(dataDir, 'qzone-interactions.json');
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const minutes = (ms) => Math.round(ms / 60000);
let failed = false;

try {
  mgr.start();
  const first = peek();
  check('启动后先等 15 秒再巡检（不抢启动带宽）', first && first.ms === 15000, `排了 ${first?.ms}ms`);

  // ① 首轮：两个接口都到点，各跑一次；下一次排到较近的回复间隔
  const afterFirst = await fire('首轮');
  check('首轮跑了好友动态 + 回复各一次', calls.feed === 1 && calls.reply === 1, `feed=${calls.feed} reply=${calls.reply}`);
  check(
    `首轮之后下一次排在 ${REPLY_MINUTES} 分钟（取较近的回复间隔）`,
    minutes(afterFirst) === REPLY_MINUTES,
    `实际 ${minutes(afterFirst)} 分钟`
  );

  // ② 只到回复的点：只跑回复那一半
  jump(REPLY_MINUTES + 1);
  let feedBefore = calls.feed;
  let replyBefore = calls.reply;
  const afterReply = await fire('回复轮');
  check(
    '回复到点时只跑回复，不碰好友动态接口',
    calls.feed === feedBefore && calls.reply === replyBefore + 1,
    `本轮 feed+${calls.feed - feedBefore} reply+${calls.reply - replyBefore}`
  );
  check(`回复轮之后仍排在 ${REPLY_MINUTES} 分钟`, minutes(afterReply) === REPLY_MINUTES, `实际 ${minutes(afterReply)} 分钟`);

  // ③ 逼近 24 小时：好友动态还差 1 分钟时，先排 1 分钟
  //    此刻 fakeNow = T0 + (REPLY_MINUTES + 1)，好友动态在 T0 + FEED_MINUTES 到点
  jump(FEED_MINUTES - 1 - (REPLY_MINUTES + 1));
  feedBefore = calls.feed;
  replyBefore = calls.reply;
  const beforeFeed = await fire('临近好友动态检查');
  check('好友动态还差 1 分钟时只跑回复，且下一次排 1 分钟',
    calls.feed === feedBefore && minutes(beforeFeed) === 1,
    `feed+${calls.feed - feedBefore}，下一次 ${minutes(beforeFeed)} 分钟`);

  // ④ 到 24 小时：好友动态单独跑（那一刻回复还没到点）
  jump(2);
  feedBefore = calls.feed;
  replyBefore = calls.reply;
  await fire('好友动态轮');
  check('满 24 小时跑好友动态', calls.feed === feedBefore + 1, `feed+${calls.feed - feedBefore}`);
  check('该轮回复未到点，不重复跑回复', calls.reply === replyBefore, `reply+${calls.reply - replyBefore}`);
  check('没有新内容时一轮不调模型（0 token）', modelCalls === 0 && logs.length === 0, `modelCalls=${modelCalls} logs=${logs.length}`);

  // ⑤ 接口连续失败：抓取先重试一次（每轮最多 2 次请求），再按 2 分钟 → 4 分钟 → 8 分钟退避，
  //    绝不是每秒重试；整轮不再因此失败，连续第 3 次才上报一条异常通知。
  //    （回复列表接口的失败是软兜底，由 test-qzone-reply-fallback.mjs 单独覆盖）
  failFeeds = true;
  jump(FEED_MINUTES + 1);
  const feedBeforeFail = calls.feed;
  const afterFail1 = await fire('失败轮 1');
  check('失败轮先重试一次（共 2 次请求，不刷屏）', calls.feed === feedBeforeFail + 2, `本轮尝试 ${calls.feed - feedBeforeFail} 次`);
  check('失败后退避到 2 分钟', minutes(afterFail1) === 2, `实际 ${minutes(afterFail1)} 分钟`);
  check('failStreak 记为 1', readState().failStreak === 1, `failStreak=${readState().failStreak}`);
  check('这一轮不是"执行失败"，而是标明动态没取到',
    readState().runs[0].status === 'partial-feed-error' && Boolean(readState().runs[0].feedError),
    `status=${readState().runs[0].status}`);
  check('前两次失败都不上报异常通知', logs.length === 0, `logs=${logs.length}`);

  jump(2);
  const afterFail2 = await fire('失败轮 2');
  check('再次失败退避翻倍到 4 分钟', minutes(afterFail2) === 4, `实际 ${minutes(afterFail2)} 分钟`);
  check('第 2 次失败仍不上报', logs.length === 0, `logs=${logs.length}`);

  jump(4);
  const afterFail3 = await fire('失败轮 3');
  check('第 3 次连续失败才上报一条异常通知', logs.length === 1 && /network busy|使用人数过多/.test(logs[0] || ''),
    `logs=${logs.length}`);
  check('连续失败退避到 8 分钟', minutes(afterFail3) === 8, `实际 ${minutes(afterFail3)} 分钟`);
  failFeeds = false;

  // ⑥ 到点在活跃时段之外：不调用接口，排到下一个时段开始（07:00）
  mgr.stop();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    runtime: { mode: 'active', paused: false },
    qzoneInteractions: {
      enabled: true,
      feedIntervalMinutes: FEED_MINUTES,
      replyIntervalMinutes: REPLY_MINUTES,
      activeHours: { start: '07:00', end: '01:00' }
    }
  }));
  const { updateConfig, reloadConfig } = await import(pathToFileURL(path.join(repoRoot, 'src', 'core', 'config.js')).href);
  reloadConfig();
  updateConfig({ qzoneInteractions: { activeHours: { start: '07:00', end: '01:00' } } });
  const beforeQuiet = { ...calls };
  fakeNow = zonedMs(2026, 9, 19, 2, 0); // 该时区凌晨 2 点，落在 01:00–07:00 的静默段
  timers = [];
  mgr.start();
  await fire('静默段首检');
  const quietTimer = peek();
  const quietMs = quietTimer ? minutes(quietTimer.ms) : -1;
  check('活跃时段外不调用接口', calls.feed === beforeQuiet.feed && calls.reply === beforeQuiet.reply, `feed=${calls.feed} reply=${calls.reply}`);
  check('静默段排到 07:00 再检查（约 5 小时）', quietMs >= 295 && quietMs <= 301, `实际 ${quietMs} 分钟`);
  mgr.stop();
} catch (error) {
  failed = true;
  console.log('FAIL 用例异常终止:', error?.message ?? error);
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

failed = results.some((ok) => !ok) || failed;
console.log(`\n动态互动节奏用例: ${results.filter(Boolean).length}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
