import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from '../core/config.js';
import { cappedByTokenSaver, tokenSaverCapsOf } from '../core/token-saver.js';
import {
  addUsage,
  cachedTokensOfUsage,
  chatCompletionWithRetry,
  emptyUsage
} from '../llm/llm.js';
import { assertTimeAllowed, watchTimeWindow, withTimeScope } from '../core/time-gate.js';
import { resolveSelfName } from '../core/util.js';
import { timeControlState } from '../core/time-control.js';
import {
  estimateQzoneTokens,
  parseQzoneFeed,
  qzoneCommentKey,
  qzonePostKey,
  QzoneWebClient
} from '../onebot/qzone-feed.js';
import {
  buildQzoneInteractionPrompt,
  qzoneInteractionPersonaHash,
  QZONE_INTERACTION_PROMPT_VERSION
} from '../llm/qzone-interaction-prompt.js';
import { resolveToolCalls } from '../tools/inline-tools.js';
import { minuteOfDayInZone, sanitizeUserText } from '../core/util.js';
import { newTraceId, withTrace } from '../core/logger.js';

const STATE_FILE = path.join(DATA_DIR, 'qzone-interactions.json');
const HOUR_MS = 60 * 60 * 1000;
const MAX_STATE_ITEMS = 2000;
// 腾讯侧 feeds3_html_more 偶发繁忙（network busy / 使用人数过多）通常几十秒内恢复：
// 抓取失败先等一会儿重试一次，仍失败才记账走退避。
const FEED_RETRY_DELAY_MS = 45000;
// 连续失败到第 3 次才上报异常通知：一次限流不值得顶一条"错误"给管理员。
const FAILURE_NOTIFY_STREAK = 3;

/** observe/暂停模式不自动调模型，也不做 Qzone 写操作（看别人动态另说，这里连发现都不跑）。 */
function automationAllowed() {
  const cfg = getConfig();
  return cfg.runtime?.mode === 'active' && !cfg.runtime?.paused;
}

function cleanText(value, max = 1000) {
  // 双保险：数据源头（qzone-feed.js 的 compact）已过 sanitizeUserText，
  // 拼进互动决策提示词前再过一次 —— 昵称等字段可能绕过 compact 直达这里。
  return sanitizeUserText(String(value ?? '').replace(/\0/g, '').replace(/[ \t]+/g, ' ').trim()).slice(0, max);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // 同 daily-moments：状态文件坏掉先留档 .broken-<时间戳>（丢失的 'unknown' 标记会让
    // 未确认结果被当成没做过、可能重复互动 —— 留证据便于人工核对；2026-10-12 审查）。
    if (error?.code !== 'ENOENT') {
      console.error(`[qzone] 读取 ${file} 失败，按默认状态处理，原文件已备份为 .broken-<时间戳>：`, error?.message ?? error);
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* 备份失败就留在原处 */ }
    }
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function interactionError(code, message, httpStatus = 409) {
  return Object.assign(new Error(message), { code, httpStatus });
}

/**
 * 哪些错误不算"这一轮失败了"：主动停止/重启（手动停用、换配置），以及全局时间控制把运行
 * 中止在非活跃时段。这两类都是正常结束，不该累计失败计数、更不该顶一条异常通知出来。
 */
export function isNonFailureRunError(error) {
  if (error?.code === 'TIME_CONTROL_INACTIVE') return true;
  return /Qzone interaction task stopped/i.test(String(error?.message ?? error));
}

// ── 活跃时段（本功能专用）：窗口外不阅览动态，也不影响聊天回复 ──

function activeHoursMinute(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 解析 {start:'08:00', end:'23:00'}；缺省或非法 = 全天可用。 */
function normalizeActiveHours(raw) {
  const start = activeHoursMinute(raw?.start);
  const end = activeHoursMinute(raw?.end);
  if (start == null || end == null || start === end) return null;
  return { start, end };
}

/** 当前是否在活跃时段内；不在时给出下一次进入窗口的时间。 */
function activeHoursState(hours, now) {
  if (!hours) return { active: true, nextActiveAt: 0 };
  const minute = minuteOfDayInZone(now);
  const wrap = hours.start > hours.end;
  const active = wrap
    ? minute >= hours.start || minute < hours.end
    : minute >= hours.start && minute < hours.end;
  if (active) return { active: true, nextActiveAt: 0 };
  const delta = minute < hours.start ? hours.start - minute : 1440 - minute + hours.start;
  return { active: false, nextActiveAt: now + delta * 60000 };
}

function normalizedConfig(raw = getConfig().qzoneInteractions || {}) {
  return {
    enabled: raw.enabled === true,
    startupCatchup: raw.startupCatchup === true,
    activeHours: normalizeActiveHours(raw.activeHours),
    feedIntervalMinutes: Math.min(1440, Math.max(5, Number(raw.feedIntervalMinutes) || 60)),
    replyIntervalMinutes: Math.min(1440, Math.max(1, Number(raw.replyIntervalMinutes) || 5)),
    feedFetchCount: Math.min(50, Math.max(1, Number(raw.feedFetchCount) || 30)),
    ownPostCount: Math.min(30, Math.max(1, Number(raw.ownPostCount) || 10)),
    maxAgeHours: Math.min(24 * 30, Math.max(1, Number(raw.maxAgeHours) || 72)),
    maxBatchItems: Math.min(50, Math.max(1, Number(raw.maxBatchItems) || 20)),
    maxLikesPerRun: Math.min(20, Math.max(0, Number(raw.maxLikesPerRun) || 0)),
    maxCommentsPerRun: Math.min(10, Math.max(0, Number(raw.maxCommentsPerRun) || 0)),
    maxRepliesPerRun: Math.min(20, Math.max(0, Number(raw.maxRepliesPerRun) || 0)),
    commentMaxChars: Math.min(200, Math.max(5, Number(raw.commentMaxChars) || 60)),
    replyMaxChars: Math.min(200, Math.max(5, Number(raw.replyMaxChars) || 60)),
    allowLikes: raw.allowLikes !== false,
    allowComments: raw.allowComments !== false,
    allowReplies: raw.allowReplies !== false,
    actionDelayMinMs: Math.min(10000, Math.max(0, Number(raw.actionDelayMinMs) || 0)),
    actionDelayMaxMs: Math.min(15000, Math.max(0, Number(raw.actionDelayMaxMs) || 0)),
    maxDecisionRounds: Math.min(5, Math.max(1, Number(raw.maxDecisionRounds) || 3))
  };
}

function defaultState() {
  return {
    version: 1,
    accountId: '',
    feedInitializedAt: 0,
    replyInitializedAt: 0,
    lastFeedPollAt: 0,
    lastReplyPollAt: 0,
    feeds: [],
    comments: [],
    watchedPosts: [],
    runs: []
  };
}

function normalizeState(raw) {
  const fallback = defaultState();
  const state = raw && typeof raw === 'object' ? raw : {};
  for (const key of ['feeds', 'comments', 'watchedPosts', 'runs']) {
    if (!Array.isArray(state[key])) state[key] = fallback[key];
  }
  state.version = 1;
  // 2026-10-06 复审 P2：持久化状态绑定账号（详见 #run 里的闸门）。旧状态文件没有该字段
  // 时保持空串，首次运行回填当前 selfId。
  state.accountId = String(state.accountId || '');
  state.feedInitializedAt = Number(state.feedInitializedAt) || 0;
  state.replyInitializedAt = Number(state.replyInitializedAt) || 0;
  state.lastFeedPollAt = Number(state.lastFeedPollAt) || 0;
  state.lastReplyPollAt = Number(state.lastReplyPollAt) || 0;
  return state;
}

function openAiTools(defs) {
  return defs.map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters
    }
  }));
}

function actionCounts(plan) {
  const counts = { likes: 0, comments: 0, replies: 0 };
  for (const item of plan.feedActions) {
    if (item.action === 'like' || item.action === 'like_comment') counts.likes += 1;
    if (item.action === 'comment' || item.action === 'like_comment') counts.comments += 1;
  }
  counts.replies = plan.replyActions.filter((item) => item.action === 'reply').length;
  return counts;
}

function sanitizePlan(raw, batch, cfg) {
  const fail = (message) => {
    throw interactionError('QZONE_INTERACTION_DECISION_INVALID', message, 422);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('提交参数必须为 JSON 对象');
  if (!Array.isArray(raw.feedActions) || !Array.isArray(raw.replyActions)) {
    fail('feedActions 和 replyActions 必须为数组');
  }
  const feedIds = new Set(batch.feeds.map((item) => item.id));
  const replyIds = new Set(batch.replies.map((item) => item.id));
  const seenFeed = new Set();
  const seenReply = new Set();
  const feedActions = raw.feedActions.map((item) => {
    const id = String(item?.id || '');
    const action = String(item?.action || '');
    if (!feedIds.has(id) || seenFeed.has(id)) fail('feedActions 含未知或重复 id');
    if (!['skip', 'like', 'comment', 'like_comment'].includes(action)) {
      fail('好友动态 action 必须为 skip、like、comment 或 like_comment');
    }
    if ((!cfg.allowLikes && ['like', 'like_comment'].includes(action))
      || (!cfg.allowComments && ['comment', 'like_comment'].includes(action))) {
      fail('提交了当前设置不允许的好友动态操作');
    }
    const content = cleanText(item?.content, 1000);
    if (content.length > cfg.commentMaxChars) {
      fail(`评论不能超过 ${cfg.commentMaxChars} 个字符`);
    }
    if (/@\{uin:/i.test(content)) fail('评论正文不能直接包含 QQ 原生回复标记');
    if (['comment', 'like_comment'].includes(action) && !content) fail('评论内容不能为空');
    if (['skip', 'like'].includes(action) && content) fail('不评论时 content 必须为空');
    seenFeed.add(id);
    return { id, action, content, reason: cleanText(item?.reason, 200) };
  });
  const replyActions = raw.replyActions.map((item) => {
    const id = String(item?.id || '');
    const action = String(item?.action || '');
    if (!replyIds.has(id) || seenReply.has(id)) fail('replyActions 含未知或重复 id');
    if (!['skip', 'reply'].includes(action)) fail('评论回复 action 必须为 skip 或 reply');
    if (!cfg.allowReplies && action === 'reply') fail('当前设置不允许回复评论');
    const content = cleanText(item?.content, 1000);
    if (content.length > cfg.replyMaxChars) {
      fail(`回复不能超过 ${cfg.replyMaxChars} 个字符`);
    }
    if (/@\{uin:/i.test(content)) fail('回复正文不能直接包含 QQ 原生回复标记');
    if (action === 'reply' && !content) fail('回复内容不能为空');
    if (action === 'skip' && content) fail('不回复时 content 必须为空');
    seenReply.add(id);
    return { id, action, content, reason: cleanText(item?.reason, 200) };
  });
  if (seenFeed.size !== feedIds.size || seenReply.size !== replyIds.size) {
    fail('必须为本批次每个条目提交一次决定');
  }
  const counts = actionCounts({ feedActions, replyActions });
  if (counts.likes > cfg.maxLikesPerRun) fail(`本轮点赞不能超过 ${cfg.maxLikesPerRun} 条`);
  if (counts.comments > cfg.maxCommentsPerRun) fail(`本轮评论不能超过 ${cfg.maxCommentsPerRun} 条`);
  if (counts.replies > cfg.maxRepliesPerRun) fail(`本轮回复不能超过 ${cfg.maxRepliesPerRun} 条`);
  return { feedActions, replyActions };
}

function publicPost(post) {
  return {
    author: sanitizeUserText(post.nickname) || '好友',
    time: post.time,
    content: cleanText(post.content, 1200),
    imageCount: post.images?.length || 0,
    commentCount: post.comments?.length || 0,
    alreadyLiked: post.isLiked === true,
    recentComments: (post.comments || []).slice(-8).map((comment) => ({
      author: sanitizeUserText(comment.nickname) || '好友',
      content: cleanText(comment.content, 300)
    }))
  };
}

function publicReply(item) {
  return {
    author: sanitizeUserText(item.comment.nickname) || '好友',
    time: item.comment.time || item.discoveredAt,
    content: cleanText(item.comment.content, 500),
    post: {
      author: sanitizeUserText(item.post.nickname) || '好友',
      content: cleanText(item.post.content, 800)
    },
    thread: (item.context || []).slice(-10).map((comment) => ({
      author: sanitizeUserText(comment.nickname) || '好友',
      content: cleanText(comment.content, 300),
      self: comment.self === true
    }))
  };
}

function publicRunDetails(run, state) {
  const feeds = new Map(state.feeds.map((item) => [item.key, item]));
  const comments = new Map(state.comments.map((item) => [item.key, item]));
  const details = new Map();
  for (const action of run.actions || []) {
    const kind = action.type === 'reply' ? 'reply' : 'feed';
    let detail = details.get(action.key);
    if (!detail) {
      const item = kind === 'reply' ? comments.get(action.key) : feeds.get(action.key);
      if (kind === 'reply' && item) {
        const reply = publicReply(item);
        detail = {
          kind,
          post: reply.post,
          comment: {
            author: reply.author,
            time: reply.time,
            content: reply.content
          },
          thread: reply.thread,
          decision: item.decision || '',
          response: item.replyContent || '',
          reason: item.reason || '',
          operations: []
        };
      } else {
        detail = {
          kind,
          ...(item ? {
            post: publicPost(item.post),
            decision: item.decision || '',
            response: item.commentContent || '',
            reason: item.reason || ''
          } : {}),
          operations: []
        };
      }
      details.set(action.key, detail);
    }
    detail.operations.push({
      type: action.type,
      status: action.status,
      ...(action.error ? { error: cleanText(action.error, 300) } : {})
    });
  }
  return [...details.values()];
}

export class QzoneInteractionManager {
  constructor({
    onebot,
    sessions = null,
    emit = null,
    complete = chatCompletionWithRetry,
    qzoneWeb = null,
    setProactiveSuppressed = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    random = Math.random,
    log = console.log,
    stateFile = STATE_FILE
  }) {
    this.onebot = onebot;
    this.sessions = sessions;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.complete = complete;
    this.qzoneWeb = qzoneWeb || new QzoneWebClient(onebot);
    this.setProactiveSuppressed = setProactiveSuppressed;
    this.sleep = sleep;
    this.now = now;
    this.random = random;
    this.log = log;
    this.stateFile = stateFile;
    this.state = normalizeState(readJson(stateFile, defaultState()));
    this.timer = null;
    this.nextRunAt = 0;
    this.running = null;
    this.task = null;
    this.controller = null;
    this.stopped = true;
    let recovered = false;
    for (const list of [this.state.feeds, this.state.comments]) {
      for (const item of list) {
        if (item.status !== 'acting') continue;
        item.status = 'unknown';
        item.error = '外部写入期间服务中断，结果不明，不会自动重试';
        item.updatedAt = this.now();
        recovered = true;
      }
    }
    for (const run of this.state.runs) {
      if (run.status !== 'running') continue;
      run.status = 'interrupted';
      run.error = '任务执行期间服务中断';
      run.endedAt = this.now();
      recovered = true;
    }
    if (recovered) this.#save();
  }

  status() {
    const cfg = normalizedConfig();
    return {
      enabled: cfg.enabled,
      running: Boolean(this.running),
      task: this.task,
      nextRunAt: this.nextRunAt,
      lastFeedPollAt: this.state.lastFeedPollAt,
      lastReplyPollAt: this.state.lastReplyPollAt,
      unreadFeeds: this.state.feeds.filter((item) => item.status === 'unread').length,
      unreadReplies: this.state.comments.filter((item) => item.status === 'unread').length,
      uncertain: [...this.state.feeds, ...this.state.comments]
        .filter((item) => item.status === 'unknown').length,
      records: this.state.runs.slice(0, 20).map((run) => ({
        ...run,
        details: publicRunDetails(run, this.state)
      }))
    };
  }

  start() {
    this.stop();
    if (!normalizedConfig().enabled) return;
    this.stopped = false;
    this.#schedule(15000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = 0;
  }

  async abort() {
    const running = this.running;
    this.controller?.abort(new Error('Qzone interaction task stopped'));
    if (!running) return;
    await Promise.race([
      running.catch(() => {}),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref?.();
      })
    ]);
  }

  reconfigure() {
    if (normalizedConfig().enabled) this.start();
    else {
      this.stop();
      this.abort().catch(() => {});
    }
  }

  async runNow(kind = 'all') {
    if (!['all', 'feed', 'reply'].includes(kind)) {
      throw interactionError('QZONE_INTERACTION_KIND_INVALID', 'kind 必须为 all、feed 或 reply', 400);
    }
    return this.#exclusive(`manual-${kind}`, () =>
      this.#run({ kind, source: 'manual', includeExisting: true })
    );
  }

  async #exclusive(task, execute) {
    if (this.running) throw interactionError('QZONE_INTERACTION_BUSY', '已有动态互动任务正在执行');
    assertTimeAllowed('');
    this.task = task;
    this.controller = new AbortController();
    this.setProactiveSuppressed(true);
    this.running = withTimeScope('', execute).finally(() => {
      this.running = null;
      this.task = null;
      this.controller = null;
      this.setProactiveSuppressed(false);
      this.emit('qzone-interactions-status', this.status());
    });
    this.emit('qzone-interactions-status', this.status());
    return this.running;
  }

  #schedule(delay = 60000) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.nextRunAt = this.now() + Math.max(1000, Number(delay) || 1000);
    this.timer = setTimeout(() => {
      withTrace(newTraceId(), () => this.#tick()).catch((error) => {
        this.log('[qzone-interactions] scheduler error:', error);
        // 这一轮炸了也要把下一次排上：否则 enabled:true 但永远不再跑，只有重启能恢复
        try { this.#schedule(60000); } catch { /* 已停用 */ }
      });
    }, Math.max(1000, Number(delay) || 1000));
    this.timer.unref?.();
  }

  async #tick() {
    if (this.stopped) return;
    // observe/暂停是全局闸门：不能只靠聊天发送的 assertCanSend，Qzone 写操作不经过它。
    if (!automationAllowed()) {
      this.#schedule(60000);
      return;
    }
    const cfg = normalizedConfig();
    const now = this.now();
    const time = timeControlState(getConfig().timeControl, '', now);
    if (!time.active) {
      this.#schedule(time.nextActiveAt ? time.nextActiveAt - now + 1 : 60000);
      return;
    }
    // 本功能自带活跃时段：窗口外不阅览动态（聊天回复不受影响）
    const hours = activeHoursState(cfg.activeHours, now);
    if (!hours.active) {
      this.#schedule(Math.max(1000, hours.nextActiveAt - now + 1));
      return;
    }
    if (this.running) {
      this.#schedule(60000);
      return;
    }
    const feedDue = !this.state.lastFeedPollAt
      || now - this.state.lastFeedPollAt >= cfg.feedIntervalMinutes * 60000;
    const replyDue = !this.state.lastReplyPollAt
      || now - this.state.lastReplyPollAt >= cfg.replyIntervalMinutes * 60000;
    // 账号不一致：#run 里会 #recordFailure 并跳过执行 —— 这里干脆不进 #exclusive，
    // 且下面"成功清零"的分支不能吃掉这次失败（否则退避失效、退回 1Hz 空转，P1-2）
    const runSelfId = String(this.onebot?.selfId || '');
    const accountMismatch = Boolean(this.state.accountId) && this.state.accountId !== runSelfId;
    if (accountMismatch) {
      // 账号不一致是**持久**状态：不进 #exclusive 就等于连失败都不记 → failStreak 恒 0、
      // 退避失效、每 1 秒重排一次，功能静默停摆（2026-10-13 全项目审查 P2-1）。
      this.#recordFailure(`QQ 登录账号与 qzone-interactions 状态文件不一致（状态里是 ${this.state.accountId}，当前是 ${runSelfId}），本轮跳过`);
    }
    if ((feedDue || replyDue) && !accountMismatch) {
      try {
        const result = await this.#exclusive('scheduled', () => this.#run({
          kind: feedDue && replyDue ? 'all' : (feedDue ? 'feed' : 'reply'),
          source: 'scheduled',
          includeExisting: cfg.startupCatchup
        }));
        // 好友动态抓取失败（重试后仍没拿到）算这一轮降级：评论检查与未读积压已经照跑，
        // 但失败计数和退避照旧，保持"接口出问题就慢下来"的保护。
        const feedError = result?.run?.feedError;
        if (feedError) this.#recordFailure(`好友动态抓取失败（已重试一次）: ${feedError}`);
        else if (Number(this.state.failStreak)) {
          this.state.failStreak = 0;
          this.#save();
        }
      } catch (error) {
        // 主动停止/重启、或全局时间控制判定离开活跃时段：不是故障，不上报也不退避
        if (!isNonFailureRunError(error)) this.#recordFailure(String(error?.message ?? error));
      }
    }
    if (!this.stopped) {
      const nextFeed = this.state.lastFeedPollAt + cfg.feedIntervalMinutes * 60000;
      const nextReply = this.state.lastReplyPollAt + cfg.replyIntervalMinutes * 60000;
      const dueDelay = Math.max(1000, Math.min(nextFeed, nextReply) - this.now());
      // 连续失败退避：1→2 分钟、2→4 分钟…最多 30 分钟；成功一次即清零
      const streak = Math.min(6, Number(this.state.failStreak) || 0);
      const backoff = streak ? Math.min(30, 2 ** streak) * 60000 : 0;
      this.#schedule(Math.max(dueDelay, backoff));
    }
  }

  /**
   * 记一次失败：累加连续失败计数（供退避使用），并决定要不要上报异常通知。
   * 腾讯侧偶发繁忙很常见，前两次只写日志；连到第 3 次仍失败才当故障通知，之后安静退避重试。
   */
  #recordFailure(message) {
    const streak = Math.min(6, (Number(this.state.failStreak) || 0) + 1);
    this.state.failStreak = streak;
    this.#save();
    // 传 Error 实例而不是字符串：moduleLog 只对带 Error 的调用进异常面板（2026-10-07 复审）
    if (streak === FAILURE_NOTIFY_STREAK) this.log('[qzone-interactions] run failed:', new Error(String(message)));
    else console.log(`[qzone-interactions] run failed（连续 ${streak} 次，退避重试中）:`, message);
  }

  #save() {
    this.#prune();
    writeJson(this.stateFile, this.state);
    this.emit('qzone-interactions-status', this.status());
  }

  #prune() {
    const cutoff = this.now() - 30 * 24 * HOUR_MS;
    // 未处理的（unread）与待人工核对的（unknown）永远保留，只对已结束的旧项做上限截断。
    // 此前是过滤后直接 slice：一旦超过上限，最老的 unread/unknown 会被静默丢掉——既不记日志
    // 也不改状态，等于那批动态再也不会被处理。
    const trim = (items) => {
      const kept = items.filter((item) => item.status === 'unread' || item.status === 'unknown'
        || Number(item.updatedAt || item.discoveredAt) >= cutoff);
      const active = kept.filter((item) => item.status === 'unread' || item.status === 'unknown');
      const settled = kept.filter((item) => item.status !== 'unread' && item.status !== 'unknown')
        .sort((a, b) => Number(b.discoveredAt) - Number(a.discoveredAt));
      const room = Math.max(0, MAX_STATE_ITEMS - active.length);
      const keep = new Set([...active, ...settled.slice(0, room)]);
      return kept.filter((item) => keep.has(item))
        .sort((a, b) => Number(b.discoveredAt) - Number(a.discoveredAt));
    };
    this.state.feeds = trim(this.state.feeds);
    this.state.comments = trim(this.state.comments);
    this.state.watchedPosts = this.state.watchedPosts
      .filter((post) => Number(post.updatedAt) >= cutoff)
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      .slice(0, 100);
    this.state.runs = this.state.runs.slice(0, 90);
  }

  #watchPost(post, patch = {}) {
    const key = qzonePostKey(post);
    const existing = this.state.watchedPosts.find((item) => item.key === key);
    const suppliedCommentCount = post.commentCount ?? post.comments?.length;
    const value = {
      key,
      uin: String(post.uin),
      tid: String(post.tid),
      nickname: cleanText(post.nickname || existing?.nickname, 80),
      content: cleanText(post.content || existing?.content, 1200),
      time: Number(post.time || existing?.time) || 0,
      commentCount: suppliedCommentCount == null
        ? (Number(existing?.commentCount) || 0)
        : (Number(suppliedCommentCount) || 0),
      updatedAt: this.now(),
      ...patch
    };
    if (existing) Object.assign(existing, value);
    else this.state.watchedPosts.push(value);
  }

  #queueComments(post) {
    const selfId = String(this.onebot.selfId || '');
    const roots = new Map((post.comments || [])
      .filter((comment) => !comment.parentTid)
      .map((comment) => [String(comment.tid || comment.commentId), comment]));
    for (const comment of post.comments || []) {
      if (!comment.uin || String(comment.uin) === selfId) continue;
      const root = roots.get(String(comment.parentTid || ''));
      const directedToSelf = String(comment.targetUin || '') === selfId
        || String(root?.uin || '') === selfId;
      const eligible = (!comment.parentTid && String(post.uin) === selfId) || directedToSelf;
      if (!eligible) continue;
      const key = qzoneCommentKey(post, comment);
      if (this.state.comments.some((item) => item.key === key)) continue;
      this.state.comments.push({
        key,
        status: 'unread',
        discoveredAt: this.now(),
        updatedAt: this.now(),
        post: {
          uin: String(post.uin),
          tid: String(post.tid),
          nickname: cleanText(post.nickname, 80),
          content: cleanText(post.content, 1200),
          time: Number(post.time) || 0
        },
        comment: { ...comment },
        rootComment: root ? { ...root } : (!comment.parentTid ? { ...comment } : null),
        // 每条待回复评论都复制整份线程会让状态按 C×K 膨胀；模型/回复只需要最近几条上下文。
        context: (post.comments || []).slice(-10).map((item) => ({
          ...item,
          self: String(item.uin) === selfId
        }))
      });
    }
  }

  /** 取一页好友动态；接口失败与返回结构异常都算失败，由 #discoverFeeds 决定是否重试。 */
  async #fetchFeeds(cfg, signal) {
    const data = await this.onebot.call(
      'get_qzone_feeds',
      { page_num: 1, count: cfg.feedFetchCount },
      30000,
      signal
    );
    if (!Array.isArray(data?.feeds)) throw new Error('好友动态接口返回格式无效');
    return data;
  }

  /** 重试前的等待；这期间被中止就立刻结束等待，由调用方 throwIfAborted 收尾。 */
  async #waitBeforeFeedRetry(signal) {
    if (!signal) {
      await this.sleep(FEED_RETRY_DELAY_MS);
      return;
    }
    if (signal.aborted) return;
    await Promise.race([
      this.sleep(FEED_RETRY_DELAY_MS),
      new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    ]);
  }

  async #discoverFeeds(cfg, signal) {
    let data;
    try {
      data = await this.#fetchFeeds(cfg, signal);
    } catch (error) {
      signal?.throwIfAborted();
      console.log(
        `[qzone-interactions] 好友动态抓取失败，${Math.round(FEED_RETRY_DELAY_MS / 1000)} 秒后重试一次:`,
        cleanText(error?.message ?? error, 200)
      );
      await this.#waitBeforeFeedRetry(signal);
      signal?.throwIfAborted();
      data = await this.#fetchFeeds(cfg, signal);
    }
    const cutoff = Math.floor((this.now() - cfg.maxAgeHours * HOUR_MS) / 1000);
    let discovered = 0;
    for (const raw of data.feeds) {
      const post = parseQzoneFeed(raw);
      if (post.appid !== 311 || !post.tid || !post.uin || post.time < cutoff) continue;
      if (post.uin === String(this.onebot.selfId || '')) {
        this.#watchPost(post);
        this.#queueComments(post);
        continue;
      }
      const key = qzonePostKey(post);
      const existing = this.state.feeds.find((item) => item.key === key);
      if (existing) {
        existing.post = post;
        existing.updatedAt = this.now();
      } else {
        this.state.feeds.push({
          key,
          status: 'unread',
          discoveredAt: this.now(),
          updatedAt: this.now(),
          post
        });
        discovered += 1;
      }
      if (this.state.watchedPosts.some((item) => item.key === key)) this.#queueComments(post);
    }
    this.state.lastFeedPollAt = this.now();
    return discovered;
  }

  async #discoverReplies(cfg, signal) {
    const selfId = String(this.onebot.selfId || '');
    if (!selfId) throw new Error('无法确认当前登录 QQ');
    const candidates = new Map();
    // 主路径：自己的动态列表，评论数的权威来源。这个接口在 Qzone 侧常被限流（retcode=100），
    // 失败不致命：feed 轮会持续用 #watchPost 刷新自己动态的评论数，本轮退回"已关注动态 +
    // Cookie 详情接口"的兜底节奏即可，不再让整轮回复检查失败、触发退避。
    let countsReliable = false;
    try {
      const own = await this.onebot.call(
        'get_qzone_msg_list',
        { target_uin: Number(selfId), pos: 0, num: cfg.ownPostCount },
        30000,
        signal
      );
      if (!Array.isArray(own?.msglist)) throw new Error('自己的动态列表返回格式无效');
      countsReliable = true;
      for (const item of own.msglist) {
        const post = {
          uin: selfId,
          tid: String(item.tid || ''),
          nickname: resolveSelfName(getConfig().persona || {}, this.onebot.selfNickname || ''),
          content: cleanText(item.content, 1200),
          time: Number(item.time) || 0,
          commentCount: Number(item.comment_num) || 0
        };
        if (!post.tid) continue;
        // 自己的动态也必须受 maxAgeHours 约束：列表里可能还有几周前的旧动态，
        // 评论数一变就回复会让"只处理最近 N 小时"失效。
        const ageMs = this.now() - Number(post.time) * 1000;
        if (!post.time || ageMs > cfg.maxAgeHours * HOUR_MS) continue;
        const previous = this.state.watchedPosts.find((watch) => watch.key === qzonePostKey(post));
        this.#watchPost(post, { own: true });
        if (post.commentCount > 0
          && Number(previous?.scannedCommentCount) !== post.commentCount) {
          candidates.set(qzonePostKey(post), post);
        }
      }
    } catch (error) {
      this.log(`[qzone-interactions] 自己的动态列表不可用，本轮改用已关注动态兜底（${cleanText(error?.message ?? error, 120)}）`);
    }
    for (const watched of this.state.watchedPosts) {
      if (!watched.tid || !watched.uin) continue;
      const ageMs = this.now() - Number(watched.time) * 1000;
      if (ageMs > cfg.maxAgeHours * HOUR_MS) continue;
      if (candidates.has(watched.key)) continue;
      if (watched.own && !watched.conversationActive && countsReliable) {
        // 评论数可靠时，只在它变化后才值得拉一次详情
        if (Number(watched.commentCount) <= 0
          || Number(watched.scannedCommentCount) === Number(watched.commentCount)) continue;
      } else {
        // 评论数拿不到（限流兜底）或非自己的动态：按节奏定期拉详情，靠评论 key 去重
        const interval = ageMs < 6 * HOUR_MS
          ? cfg.replyIntervalMinutes * 60000
          : (ageMs < 24 * HOUR_MS ? 30 * 60000 : 2 * HOUR_MS);
        if (this.now() - Number(watched.lastDetailPollAt || 0) < interval) continue;
      }
      candidates.set(watched.key, { ...watched });
    }
    let discovered = 0;
    for (const post of [...candidates.values()]
      .sort((a, b) => Number(b.time) - Number(a.time))
      .slice(0, 20)) {
      signal?.throwIfAborted();
      try {
        const detail = await this.qzoneWeb.getPostDetail(post.uin, post.tid, signal);
        const before = this.state.comments.length;
        this.#queueComments({ ...post, ...detail });
        discovered += this.state.comments.length - before;
        this.#watchPost(
          { ...post, ...detail },
          {
            scannedCommentCount: Number(detail.commentCount) || detail.comments?.length || 0,
            lastDetailPollAt: this.now()
          }
        );
      } catch (error) {
        const watched = this.state.watchedPosts.find((item) => item.key === qzonePostKey(post));
        if (watched) {
          watched.lastDetailPollAt = this.now();
          watched.lastError = cleanText(error?.message ?? error, 300);
        }
      }
    }
    this.state.lastReplyPollAt = this.now();
    return discovered;
  }

  #batch(kind, cfg) {
    const feeds = kind === 'reply' ? [] : this.state.feeds
      .filter((item) => item.status === 'unread')
      .sort((a, b) => Number(b.post?.time || b.discoveredAt) - Number(a.post?.time || a.discoveredAt));
    const replies = kind === 'feed' ? [] : this.state.comments
      .filter((item) => item.status === 'unread')
      .sort((a, b) => Number(b.comment?.time || b.discoveredAt) - Number(a.comment?.time || a.discoveredAt));
    const candidates = [
      ...replies.map((item) => ({ type: 'reply', item })),
      ...feeds.map((item) => ({ type: 'feed', item }))
    ].slice(0, cfg.maxBatchItems);
    const root = getConfig();
    const systemPrompt = buildQzoneInteractionPrompt(root.persona, { accountNickname: this.onebot?.selfNickname || '' });
    const tools = openAiTools([this.#submitToolDef([], [], cfg)]);
    // 与主运行同口径：省 Token 模式夹住单次预算上限
    const hardLimit = Math.min(
      Math.max(16000, Number(root.api?.contextWindowTokens) || 1000000),
      Math.max(20000, cappedByTokenSaver(Number(root.api?.maxRunTokens) || 160000, tokenSaverCapsOf(root)?.maxRunTokens))
    );
    const budget = Math.max(4000, hardLimit - 8192);
    const selected = [];
    let estimatedTokens = estimateQzoneTokens(systemPrompt) + estimateQzoneTokens(tools) + 500;
    for (const candidate of candidates) {
      const publicItem = candidate.type === 'feed'
        ? publicPost(candidate.item.post)
        : publicReply(candidate.item);
      const cost = estimateQzoneTokens(publicItem) + 80;
      if (estimatedTokens + cost > budget) break;
      selected.push({ ...candidate, publicItem });
      estimatedTokens += cost;
    }
    return {
      feeds: selected.filter((item) => item.type === 'feed')
        .map((item, index) => ({ id: `feed-${index + 1}`, state: item.item, data: item.publicItem })),
      replies: selected.filter((item) => item.type === 'reply')
        .map((item, index) => ({ id: `reply-${index + 1}`, state: item.item, data: item.publicItem })),
      deferredFeeds: feeds.length - selected.filter((item) => item.type === 'feed').length,
      deferredReplies: replies.length - selected.filter((item) => item.type === 'reply').length,
      estimatedTokens,
      budget
    };
  }

  #submitToolDef(feeds, replies, cfg) {
    return {
      name: 'submit_qzone_interactions',
      description: '提交本批好友动态互动和评论回复决定。',
      parameters: {
        type: 'object',
        properties: {
          feedActions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                action: { type: 'string', enum: ['skip', 'like', 'comment', 'like_comment'] },
                content: { type: 'string', maxLength: cfg.commentMaxChars },
                reason: { type: 'string' }
              },
              required: ['id', 'action', 'content', 'reason']
            }
          },
          replyActions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                action: { type: 'string', enum: ['skip', 'reply'] },
                content: { type: 'string', maxLength: cfg.replyMaxChars },
                reason: { type: 'string' }
              },
              required: ['id', 'action', 'content', 'reason']
            }
          }
        },
        required: ['feedActions', 'replyActions']
      },
      execute: async (args) => ({
        content: JSON.stringify({
          accepted: true,
          counts: actionCounts(sanitizePlan(args, { feeds, replies }, cfg))
        })
      })
    };
  }

  async #decide(batch, cfg, session, signal) {
    const root = getConfig();
    const systemPrompt = buildQzoneInteractionPrompt(root.persona, { accountNickname: this.onebot?.selfNickname || '' });
    const defs = [this.#submitToolDef(batch.feeds, batch.replies, cfg)];
    const tools = openAiTools(defs);
    const userPrompt = [
      '以下条目是本轮能够放入上下文的全部未阅览项目，已按优先级和时间从新到旧排列。',
      `本轮最多点赞 ${cfg.maxLikesPerRun} 条、评论 ${cfg.maxCommentsPerRun} 条、回复 ${cfg.maxRepliesPerRun} 条。`,
      '【好友动态】',
      JSON.stringify(batch.feeds.map((item) => ({ id: item.id, ...item.data }))),
      '【待回复评论】',
      JSON.stringify(batch.replies.map((item) => ({ id: item.id, ...item.data })))
    ].join('\n\n');
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const usage = emptyUsage();
    let finalPlan = null;
    if (session) {
      session.systemPrompt = systemPrompt;
      session.userPrompt = userPrompt;
      session.promptLayout = QZONE_INTERACTION_PROMPT_VERSION;
      session.promptChars = systemPrompt.length + userPrompt.length;
      session.inputTools = structuredClone(tools);
      session.inputRequestOptions = { toolChoice: 'auto', temperature: 1 };
      this.sessions.update(session.id);
    }
    for (let round = 0; round < cfg.maxDecisionRounds && !finalPlan; round++) {
      signal.throwIfAborted();
      assertTimeAllowed('');
      if (session) {
        session.inputRound = round + 1;
        session.inputMessages = structuredClone(messages);
        session.inputPayloadChars = JSON.stringify({ messages, tools }).length;
        session.activity = '正在阅览空间动态…';
        this.sessions.update(session.id);
      }
      const response = await this.complete({
        messages,
        tools,
        // DeepSeek thinking mode rejects named/required tool choices.
        // The prompt and finalPlan validation still require this sole submit tool.
        toolChoice: 'auto',
        temperature: 1,
        purpose: 'write',   // 空间互动文案 = 写作类任务
        signal,
        cacheKey: `qq-agent:qzone-interactions:${qzoneInteractionPersonaHash(root.persona).slice(0, 24)}`
      });
      addUsage(usage, response.usage);
      usage.calls += 1;
      const message = response.message || {};
      const assistant = {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null,
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(resolveToolCalls(message).length ? { tool_calls: resolveToolCalls(message) } : {})
      };
      messages.push(assistant);
      if (session) {
        session.messages.push({ ...structuredClone(assistant), raw: response.raw ?? null });
        session.model = response.model || session.model;
        session.rounds = round + 1;
        session.usage = { ...usage };
        session.callUsage ||= [];
        const promptTokens = Number(response.usage?.prompt_tokens) || 0;
        const cachedTokens = Math.min(promptTokens, cachedTokensOfUsage(response.usage));
        session.callUsage.push({
          round: round + 1,
          promptTokens,
          cachedTokens,
          cacheHitRate: promptTokens ? cachedTokens / promptTokens : 0,
          completionTokens: Number(response.usage?.completion_tokens) || 0,
          totalTokens: Number(response.usage?.total_tokens) || 0
        });
      }
      const calls = resolveToolCalls(message);
      if (!calls.length) {
        messages.push({
          role: 'user',
          content: '必须调用 submit_qzone_interactions，不能只输出文本。'
        });
        continue;
      }
      for (const call of calls) {
        const name = String(call?.function?.name || '');
        let args = null;
        let result = '';
        let isError = false;
        if (name !== 'submit_qzone_interactions') {
          result = `错误：未知工具 ${name || '(空名称)'}`;
          isError = true;
        } else if (finalPlan) {
          result = '错误：本轮已经提交过有效决定';
          isError = true;
        } else {
          try {
            args = JSON.parse(String(call?.function?.arguments || '{}'));
            finalPlan = sanitizePlan(args, batch, cfg);
            result = JSON.stringify({ accepted: true, counts: actionCounts(finalPlan) });
          } catch (error) {
            result = `错误：${error instanceof SyntaxError
              ? '工具参数不是合法 JSON，请修正后重新提交'
              : error.message}`;
            isError = true;
          }
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: result
        });
        if (session) {
          session.messages.push({
            toolCall: {
              name,
              args,
              result,
              isError
            }
          });
        }
      }
      if (session) {
        session.activity = '';
        this.sessions.update(session.id);
        this.emit('session-update', { sessionId: session.id });
      }
    }
    if (!finalPlan) throw interactionError(
      'QZONE_INTERACTION_DECISION_INVALID',
      '模型未在轮次预算内提交有效互动决定',
      422
    );
    return { plan: finalPlan, usage, model: session?.model || root.api?.model || '' };
  }

  #findRoot(item) {
    if (item.rootComment) return item.rootComment;
    if (!item.comment.parentTid) return item.comment;
    return (item.context || []).find((comment) =>
      !comment.parentTid
      && String(comment.tid || comment.commentId) === String(item.comment.parentTid)
    ) || null;
  }

  async #pauseBetweenActions(cfg, count) {
    if (!count) return;
    const min = Math.min(cfg.actionDelayMinMs, cfg.actionDelayMaxMs);
    const max = Math.max(cfg.actionDelayMinMs, cfg.actionDelayMaxMs);
    const ms = Math.round(min + this.random() * (max - min));
    if (ms > 0) await this.sleep(ms);
  }

  async #executePlan(plan, batch, cfg, signal, run) {
    const feedMap = new Map(batch.feeds.map((item) => [item.id, item.state]));
    const replyMap = new Map(batch.replies.map((item) => [item.id, item.state]));
    let writes = 0;
    for (const action of plan.replyActions) {
      // 窗口关闭/手动停止后不再发起新的写入：未尝试的条目保持 unread，
      // 留给下一个活跃窗口重试；catch 里的 unknown 只覆盖"在途中止"。
      if (signal?.aborted) break;
      const item = replyMap.get(action.id);
      item.decision = action.action;
      item.reason = action.reason;
      item.updatedAt = this.now();
      if (action.action === 'skip') {
        item.status = 'reviewed';
        continue;
      }
      await this.#pauseBetweenActions(cfg, writes++);
      // ⚠️ 动作间隔是一次**不感知 abort 的 setTimeout**：中止正好落在这一步时，循环头那次
      // 检查已经过去了。下面 replyComment 带着已中止的 signal 会立刻抛错，被 catch 里的
      // `signal.aborted` 分支记成 unknown —— 而这条**根本没发出去**，本该保持 unread 留给
      // 下个窗口重试（与 docs/QZONE_INTERACTIONS.md 的不变量、以及本文件「写入前中止」
      // 那条用例直接矛盾）。所以等待**之后**必须再查一次（2026-10-04 全面复审 P2）。
      if (signal?.aborted) break;
      item.status = 'acting';
      item.replyContent = action.content;
      this.#save();
      try {
        const result = await this.qzoneWeb.replyComment({
          ownerUin: item.post.uin,
          tid: item.post.tid,
          comment: item.comment,
          rootComment: this.#findRoot(item),
          content: action.content,
          signal
        });
        item.status = 'replied';
        item.replyCommentId = result.commentId || '';
        item.updatedAt = this.now();
        this.#watchPost(item.post, {
          conversationActive: true,
          lastDetailPollAt: this.now()
        });
        run.actions.push({ type: 'reply', key: item.key, status: 'done' });
      } catch (error) {
        if (signal?.aborted) {
          // 走到这里说明中止发生在请求**在途**时（发出前的中止已被循环头拦截）：
          // 无法确认服务端是否已写入，按模块自身不变量（docs/QZONE_INTERACTIONS.md
          // 「写入发起后中断 → unknown，永不自动重试」）记 unknown 等人工核对。
          // 原来恢复成 unread 会把可能已发出的回复在下一轮再发一遍（5aaa134 引入的回归）。
          // break 是兜底：正常情况下循环头已经拦住了后续条目。
          item.status = 'unknown';
          item.error = 'aborted';
          item.updatedAt = this.now();
          run.actions.push({ type: 'reply', key: item.key, status: 'unknown', error: 'aborted' });
          this.#save();
          break;
        }
        item.status = 'unknown';
        item.error = cleanText(error?.message ?? error, 500);
        item.updatedAt = this.now();
        run.actions.push({ type: 'reply', key: item.key, status: 'unknown', error: item.error });
      }
      this.#save();
    }
    for (const action of plan.feedActions) {
      // 同 reply 循环：中止后不再发起新写入，未尝试条目保持 unread 可重试。
      if (signal?.aborted) break;
      const item = feedMap.get(action.id);
      item.decision = action.action;
      item.reason = action.reason;
      item.updatedAt = this.now();
      if (action.action === 'skip') {
        item.status = 'reviewed';
        continue;
      }
      const wantsComment = action.action === 'comment' || action.action === 'like_comment';
      const wantsLike = action.action === 'like' || action.action === 'like_comment';
      item.status = 'acting';
      item.commentContent = action.content;
      this.#save();
      if (wantsComment) {
        await this.#pauseBetweenActions(cfg, writes++);
        // 同 reply 循环：间隔等待不感知 abort，这里必须再查一次，否则"根本没发出去"
        // 的评论会被下面的 catch 记成 unknown（2026-10-04 全面复审 P2）。
        if (signal?.aborted) {
          // ⚠️ 本循环把 status 置 'acting' 在**等待之前**（reply 循环是在之后），
          // 所以中止早退时条目会卡在 acting —— 而 acting → unknown 的回收只发生在
          // **构造时**的恢复里（load 之后那段），运行期没人回收它：既不重试也不上报。
          // 2026-10-04 全面复审 P3 实测：111:k1:acting / run=done，两条路径语义不一致。
          // 这里退回 unread：本次根本没发出去，留给下个活跃窗口，与 reply 路径同口径。
          item.status = 'unread';
          item.commentContent = '';
          item.updatedAt = this.now();
          this.#save();
          break;
        }
        try {
          const result = await this.onebot.call('comment_qzone', {
            tid: item.post.tid,
            target_uin: Number(item.post.uin),
            content: action.content
          }, 30000, signal);
          item.commentStatus = 'done';
          item.commentId = String(result?.comment_id || '');
          this.#watchPost(item.post, { ownComment: action.content });
          run.actions.push({ type: 'comment', key: item.key, status: 'done' });
        } catch (error) {
          if (signal?.aborted) {
            // 同上：在途中止按 unknown 处理，绝不回到 unread 重来 —— 否则已发出的评论会被
            // 下一轮重新决策、重复发布（like_comment 里评论已 done 后点赞被中止的场景尤其如此）。
            // break：signal 已中止，后面未尝试的条目保持 unread 留待重试。
            item.commentStatus = 'unknown';
            item.status = 'unknown';
            item.error = 'aborted';
            run.actions.push({ type: 'comment', key: item.key, status: 'unknown', error: 'aborted' });
            this.#save();
            break;
          }
          item.commentStatus = 'unknown';
          item.status = 'unknown';
          item.error = cleanText(error?.message ?? error, 500);
          run.actions.push({ type: 'comment', key: item.key, status: 'unknown', error: item.error });
          this.#save();
          continue;
        }
      }
      if (wantsLike && !item.post.isLiked) {
        await this.#pauseBetweenActions(cfg, writes++);
        // 同上：间隔等待不感知 abort，这里必须再查一次（2026-10-04 全面复审 P2）
        if (signal?.aborted) {
          // ⚠️ 本循环把 status 置 'acting' 在**等待之前**（reply 循环是在之后），
          // 所以中止早退时条目会卡在 acting —— 而 acting → unknown 的回收只发生在
          // **构造时**的恢复里（load 之后那段），运行期没人回收它：既不重试也不上报。
          // 2026-10-04 全面复审 P3 实测：111:k1:acting / run=done，两条路径语义不一致。
          //
          // ⚠️⚠️ 但只有「评论还没发过」才允许退回 unread：like_comment 组合动作里评论阶段
          // 可能**已经成功**（commentStatus='done'，评论真实发出去了），这时退回 unread 会让
          // 下轮按 unread 重新决策 —— 模型看不到自己已评论过（commentContent 还被抹了），
          // 大概率再评一次，正是下面 1122 行注释自己划的红线（2026-10-04 复审 P1）。
          if (item.commentStatus === 'done') {
            item.status = 'reviewed';   // 保住评论成果；点赞这一下丢了就算了（低价值、不会重复）
          } else {
            item.status = 'unread';     // 本次确实什么都没发出去 → 留给下个活跃窗口
            item.commentContent = '';
          }
          item.updatedAt = this.now();
          this.#save();
          break;
        }
        try {
          await this.onebot.call('like_qzone', {
            tid: item.post.tid,
            target_uin: Number(item.post.uin),
            abstime: Number(item.post.time) || 0
          }, 30000, signal);
          item.likeStatus = 'done';
          run.actions.push({ type: 'like', key: item.key, status: 'done' });
        } catch (error) {
          if (signal?.aborted) {
            // 同上：点赞在途中止记 unknown；commentStatus 保持原值 —— 评论可能已经成功，
            // 不能因为点赞中止就被抹掉或跟着重做。break：未尝试的条目保持 unread 留待重试。
            item.likeStatus = 'unknown';
            item.status = 'unknown';
            item.error = 'aborted';
            run.actions.push({ type: 'like', key: item.key, status: 'unknown', error: 'aborted' });
            this.#save();
            break;
          }
          item.likeStatus = 'unknown';
          item.status = 'unknown';
          item.error = cleanText(error?.message ?? error, 500);
          run.actions.push({ type: 'like', key: item.key, status: 'unknown', error: item.error });
          this.#save();
          continue;
        }
      }
      item.status = 'reviewed';
      item.updatedAt = this.now();
      this.#save();
    }
  }

  #finishSession(session, run, error = null) {
    if (!session || !this.sessions?.current?.has(session.id)) return;
    session.usage = { ...run.usage };
    session.model = run.model || session.model;
    session.finishReason = error ? run.error : `动态 ${run.selectedFeeds}，回复 ${run.selectedReplies}`;
    session.outcome = {
      sent: run.actions.filter((action) => action.status === 'done').length,
      finishReason: session.finishReason
    };
    if (error) session.error = run.error;
    this.sessions.update(session.id);
    this.sessions.finish(session.id, error ? 'error' : 'done');
    this.emit('session-end', { sessionId: session.id, chatKey: session.chatKey });
  }

  async #run({ kind, source, includeExisting }) {
    // 双保险：#tick 已经挡住自动轮询，但 runNow 是另一条入口。
    if (!automationAllowed()) {
      this.log(`[qzone-interactions] 当前是 observe/暂停模式，跳过${source === 'manual' ? '手动' : '自动'}运行`);
      return { skipped: 'runtime-mode', reason: 'observe/paused' };
    }
    // 2026-10-06 复审 P2：持久化状态必须绑定账号。协议端（NapCat）换号登录后 selfId 变了，
    // 旧账号积压的动态/评论队列若照常出批，会以新账号身份对旧账号好友的动态点赞/评论、
    // 把回复发给旧账号的评论 —— daily-moments 对同一场景专门设了 MOMENT_ACCOUNT_CHANGED 闸，
    // 这里补齐同款防线：首次运行为空则回填当前账号；账号不匹配则拒绝执行（保留队列，
    // 换回原账号或清空状态后自动恢复）。
    const runSelfId = String(this.onebot?.selfId || '');
    if (!this.state.accountId) {
      if (runSelfId) {
        this.state.accountId = runSelfId;
        this.#save();
      }
    } else if (this.state.accountId !== runSelfId) {
      this.log(`[qzone-interactions] QQ 登录账号已改变（状态属于 ${this.state.accountId}，当前 ${runSelfId || '未知'}），本轮跳过执行；如确认切换账号，请清空 qzone-interactions 状态文件`);
      // 必须记失败走退避：裸 return 会让 lastFeedPollAt 停在过去，dueDelay 恒为 1000ms，
      // 巡检循环 1Hz 空转（2026-10-10 审查 C2）。账号不一致本身也值得让 owner 知道。
      this.#recordFailure('QQ 登录账号与 qzone-interactions 状态文件不一致，本轮跳过');
      return;
    }
    const cfg = normalizedConfig();
    const run = {
      id: crypto.randomUUID(),
      source,
      kind,
      status: 'running',
      startedAt: this.now(),
      endedAt: 0,
      discoveredFeeds: 0,
      discoveredReplies: 0,
      selectedFeeds: 0,
      selectedReplies: 0,
      deferredFeeds: 0,
      deferredReplies: 0,
      actions: [],
      usage: emptyUsage(),
      model: '',
      error: ''
    };
    this.state.runs.unshift(run);
    this.#save();
    const release = watchTimeWindow((error) => this.controller?.abort(error), '');
    let session = null;
    try {
      let feedOk = false;
      if (kind === 'all' || kind === 'feed') {
        try {
          run.discoveredFeeds = await this.#discoverFeeds(cfg, this.controller.signal);
          feedOk = true;
        } catch (error) {
          // 中止（手动停止/重启/离开活跃时段）照旧结束整轮，不算接口失败
          this.controller?.signal?.throwIfAborted();
          // 好友动态这一路不再让整轮失败：腾讯侧偶发繁忙很常见，照 get_qzone_msg_list 的既有做法
          // 记下来继续跑——本轮仍然检查评论回复、处理已积压的未读。失败计数、退避和
          // "连续 3 次才上报"由 #tick 统一处理，这里只留一条不出通知的日志。
          // 原因必须非空：下一轮要不要退避是看 feedError 真假的，空字符串会被当成"这轮没失败"，
          // 下次只隔 1 秒就又来一次——正是 2026-09-17 那次打密的形态。
          run.feedError = cleanText(error?.message ?? error, 500) || '好友动态接口调用失败（无错误信息）';
          console.log('[qzone-interactions] 好友动态本轮未取到，继续检查评论与积压:', run.feedError);
        }
      }
      if (kind === 'all' || kind === 'reply') {
        run.discoveredReplies = await this.#discoverReplies(cfg, this.controller.signal);
      }
      // 基线只在本轮真的读到动态时才立：读失败就立基线，会把"上线前已存在的动态"错当成新内容
      const baselineFeed = feedOk && !this.state.feedInitializedAt && (kind === 'all' || kind === 'feed');
      const baselineReply = !this.state.replyInitializedAt && (kind === 'all' || kind === 'reply');
      if (baselineFeed) this.state.feedInitializedAt = this.now();
      if (baselineReply) this.state.replyInitializedAt = this.now();
      if (source === 'scheduled' && !includeExisting && (baselineFeed || baselineReply)) {
        if (baselineFeed) {
          for (const item of this.state.feeds) if (item.status === 'unread') item.status = 'baseline';
        }
        if (baselineReply) {
          for (const item of this.state.comments) if (item.status === 'unread') item.status = 'baseline';
        }
        run.status = 'baseline';
        run.endedAt = this.now();
        this.#save();
        return { ok: true, run };
      }
      const batch = this.#batch(kind, cfg);
      run.selectedFeeds = batch.feeds.length;
      run.selectedReplies = batch.replies.length;
      run.deferredFeeds = batch.deferredFeeds;
      run.deferredReplies = batch.deferredReplies;
      run.estimatedInputTokens = batch.estimatedTokens;
      run.inputBudgetTokens = batch.budget;
      if (!batch.feeds.length && !batch.replies.length) {
        run.status = run.feedError ? 'partial-feed-error' : 'idle';
        run.endedAt = this.now();
        this.#save();
        return { ok: true, run };
      }
      session = this.sessions?.create({
        chatKey: 'system:qzone-interactions',
        trigger: 'qzone-interactions',
        triggerSummary: kind === 'reply' ? '检查空间评论回复' : '阅览好友动态'
      }) || null;
      if (session) {
        run.sessionId = session.id;
        session.chatName = '动态互动';
        session.model = getConfig().api?.model || '';
        session.conversationMode = 'legacy';
      }
      const decided = await this.#decide(batch, cfg, session, this.controller.signal);
      run.usage = decided.usage;
      run.model = decided.model;
      run.plan = decided.plan;
      // ⚠️ 这里**不要**提前把整批标成 reviewed（2026-10-03 全量审查）：下面 #executePlan 的两个
      // 循环头会在"手动停止/窗口关闭"时 break，未执行的条目必须保持 unread 留给下个活跃窗口重试 ——
      // 提前标记会让它们既没被互动、又永远不再进批次（下一轮只挑 unread），静默吞掉。
      // 状态由 #executePlan 逐条落（成功 reviewed / 失败 unknown / 未尝试保持原样）。
      this.#save();
      await this.#executePlan(decided.plan, batch, cfg, this.controller.signal, run);
      run.status = run.actions.some((action) => action.status === 'unknown')
        ? 'partial-unknown'
        : (run.feedError ? 'partial-feed-error' : 'done');
      run.endedAt = this.now();
      this.#save();
      this.#finishSession(session, run);
      return { ok: true, run };
    } catch (error) {
      run.status = error?.code === 'TIME_CONTROL_INACTIVE' ? 'deferred' : 'failed';
      run.error = cleanText(error?.message ?? error, 1000);
      run.endedAt = this.now();
      if (session) {
        run.usage = { ...session.usage };
        run.model = session.model || run.model;
      }
      this.#save();
      this.#finishSession(session, run, error);
      throw error;
    } finally {
      release();
    }
  }
}
