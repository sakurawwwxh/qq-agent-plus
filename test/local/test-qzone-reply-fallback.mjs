// 本地回归：动态互动"回复"半边的限流兜底。
//
// 背景：自己的动态列表接口 get_qzone_msg_list 在 Qzone 侧常被限流（retcode=100）。
// 修复前它一失败，整轮回复检查就抛错、触发退避；修复后改走"已关注动态 + Cookie 详情
// 接口"兜底，回复功能在限流窗口内照常工作。本用例验证这条兜底链路端到端能跑通：
// 发现新评论 → 模型决定 → 实际回复 → 状态回写；并确认评论数可靠时不会多余地拉详情。
//
// 用法：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-reply-fallback.mjs
//
// 重要：必须用临时 QQ_AGENT_DATA_DIR（本用例会往里面写 config.json 和状态文件），
//       绝不能指向生产数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = process.env.QQ_AGENT_DATA_DIR;
if (!dataDir) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 指向一个临时目录，例如：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-qzone-reply-fallback.mjs');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active', paused: false },
  qzoneInteractions: {
    enabled: true,
    feedIntervalMinutes: 1440,
    replyIntervalMinutes: 120,
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
let fakeNow = Date.parse('2026-09-19T10:00:00Z');
const timers = [];
globalThis.setTimeout = (fn, ms) => {
  const handle = { fn, ms: Number(ms) || 0, canceled: false };
  timers.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  if (handle && typeof handle === 'object') handle.canceled = true;
};

const POST_KEY = '10000001:tidA';
const postTime = Math.floor(fakeNow / 1000) - 3600;
const comment1 = {
  commentId: '1', tid: '1', parentTid: '', uin: '10000002',
  nickname: '老哥', content: '前排', targetUin: '', time: Math.floor(fakeNow / 1000) - 3000
};
const comment2 = {
  commentId: '2', tid: '2', parentTid: '', uin: '10000002',
  nickname: '老哥', content: '再说一句', targetUin: '', time: Math.floor(fakeNow / 1000) - 60
};

// 种一份状态：已关注自己的说说，评论数 2，只扫过 1 条（评论 1 已审阅）
fs.writeFileSync(path.join(dataDir, 'qzone-interactions.json'), JSON.stringify({
  version: 1,
  feedInitializedAt: fakeNow - 86400000,
  replyInitializedAt: fakeNow - 86400000,
  lastFeedPollAt: fakeNow - 60000,
  lastReplyPollAt: 0,
  feeds: [],
  comments: [{
    key: `${POST_KEY}:root:1:10000002`,
    status: 'reviewed',
    discoveredAt: fakeNow - 3000000,
    updatedAt: fakeNow - 2900000,
    post: { uin: '10000001', tid: 'tidA', nickname: '测试昵称', content: '说说内容', time: postTime },
    comment: { ...comment1 },
    rootComment: { ...comment1 },
    context: [{ ...comment1, self: false }]
  }],
  watchedPosts: [{
    key: POST_KEY, uin: '10000001', tid: 'tidA', nickname: '测试昵称', content: '说说内容',
    time: postTime, commentCount: 2, scannedCommentCount: 1, own: true, updatedAt: fakeNow - 60000
  }, {
    // 安静的说说：评论数没变化，且从未进入过会话
    key: '10000001:tidB', uin: '10000001', tid: 'tidB', nickname: '测试昵称', content: '另一条',
    time: postTime - 7200, commentCount: 1, scannedCommentCount: 1, own: true, updatedAt: fakeNow - 60000
  }],
  runs: []
}));

let msgListAttempts = 0;
let msgListHealthy = false;
let detailCallsByTid = {};
let replyCalls = [];
let modelCalls = 0;
const onebot = {
  selfId: '10000001',
  selfNickname: '测试昵称',
  async call(method) {
    if (method === 'get_qzone_msg_list') {
      msgListAttempts += 1;
      if (!msgListHealthy) throw new Error('OneBot get_qzone_msg_list 失败: retcode=100 使用人数过多，请稍后再试');
      return {
        msglist: [
          { tid: 'tidA', content: '说说内容', time: postTime, comment_num: 2 },
          { tid: 'tidB', content: '另一条', time: postTime - 7200, comment_num: 1 }
        ]
      };
    }
    throw new Error(`用例未覆盖的接口: ${method}`);
  }
};
const qzoneWeb = {
  async getPostDetail(uin, tid) {
    detailCallsByTid[tid] = (detailCallsByTid[tid] || 0) + 1;
    if (tid === 'tidB') {
      return {
        tid, uin, nickname: '测试昵称', content: '另一条', time: postTime - 7200, commentCount: 1,
        comments: [{ commentId: 'b1', tid: 'b1', parentTid: '', uin: '10000002', nickname: '老哥', content: '顶', targetUin: '', time: postTime - 7000 }]
      };
    }
    return {
      tid, uin, nickname: '测试昵称', content: '说说内容', time: postTime, commentCount: 2,
      comments: [{ ...comment1 }, { ...comment2 }]
    };
  },
  async replyComment({ ownerUin, tid, content }) {
    replyCalls.push({ ownerUin, tid, content });
    return { commentId: `stub-${replyCalls.length}` };
  }
};
const mgr = new QzoneInteractionManager({
  onebot,
  qzoneWeb,
  now: () => fakeNow,
  sleep: () => Promise.resolve(),
  complete: async () => {
    modelCalls += 1;
    return {
      message: {
        content: '',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: {
            name: 'submit_qzone_interactions',
            arguments: JSON.stringify({
              feedActions: [],
              replyActions: [
                { id: 'reply-1', action: 'reply', content: '哈哈谢谢', reason: '朋友在接话' },
                { id: 'reply-2', action: 'skip', content: '', reason: '不必接' }
              ]
            })
          }
        }]
      },
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      model: 'stub-model'
    };
  },
  log: () => {}
});

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
const readState = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'qzone-interactions.json'), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

try {
  mgr.start();
  await fire();

  const state = readState();
  const run = (state.runs || [])[0] || {};
  check('主接口仍会先尝试一次', msgListAttempts === 1, `attempts=${msgListAttempts}`);
  check('限流时整轮不失败（run.status=done）', run.kind === 'reply' && run.status === 'done', `status=${run.status} error=${run.error || '无'}`);
  check('兜底改用详情接口拉评论树（两条已关注说说各一次）',
    detailCallsByTid.tidA === 1 && detailCallsByTid.tidB === 1,
    `tidA=${detailCallsByTid.tidA} tidB=${detailCallsByTid.tidB}`);
  const queued = (state.comments || []).find((item) => item.key === `${POST_KEY}:root:2:10000002`);
  check('新评论被发现并完成回复', queued?.status === 'replied' && queued?.replyContent === '哈哈谢谢', `status=${queued?.status}`);
  check('回复真实发出一次', replyCalls.length === 1 && replyCalls[0].content === '哈哈谢谢'
    && replyCalls[0].ownerUin === '10000001' && replyCalls[0].tid === 'tidA',
    JSON.stringify(replyCalls));
  const watched = (state.watchedPosts || []).find((item) => item.key === POST_KEY);
  check('扫描水位与关注状态回写', watched?.scannedCommentCount === 2 && watched?.conversationActive === true,
    `scanned=${watched?.scannedCommentCount} active=${watched?.conversationActive}`);
  check('限流不累计 failStreak', !state.failStreak, `failStreak=${state.failStreak}`);
  const nextMs = peek()?.ms ?? -1;
  check('下一轮按正常回复间隔排期', nextMs === 120 * 60000, `实际 ${Math.round(nextMs / 60000)} 分钟`);

  // 反向确认：接口恢复后，评论数可靠路径与复查节奏都符合预期
  msgListHealthy = true;
  fakeNow += 120 * 60000;
  const modelCallsBefore = modelCalls;
  await fire();
  const state2 = readState();
  const run2 = (state2.runs || [])[0] || {};
  check('安静说说接口恢复后不再拉详情（仅限流轮兜底拉过一次）',
    detailCallsByTid.tidB === 1, `tidB 详情 ${detailCallsByTid.tidB || 0} 次`);
  check('活跃会话按节奏复查详情，无新评论不调模型',
    detailCallsByTid.tidA === 2 && modelCalls === modelCallsBefore,
    `tidA 详情 ${detailCallsByTid.tidA} 次，modelCalls=${modelCalls}`);
  check('该轮空跑记为 idle', run2.status === 'idle', `status=${run2.status}`);
} catch (error) {
  results.push(false);
  console.log('FAIL 用例异常终止:', error?.message ?? error);
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log(`\n回复兜底用例: ${results.filter(Boolean).length}/${results.length} 通过`);
process.exit(results.every(Boolean) ? 0 : 1);
