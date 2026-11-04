// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 领取未读批次租约 → agent 用工具发言/决定不发言 → 成功后确认该批次
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import crypto from 'node:crypto';
import path from 'node:path';
import {
  DATA_DIR,
  asrAvailable,
  conversationConfigForChat,
  friendProposalEnabled,
  getConfig,
  identityPilotEnabled,
  imageGenAvailable,
  promptFriendProposalEnabled,
  slangPilotEnabled,
  storeConfigForChat,
  updateConfig
} from './config.js';
import { cappedByTokenSaver, effectiveRunLimits, tokenSaverCapsOf } from './token-saver.js';
import { filterBlockedHistory } from './blocklist.js';
import { redactText } from './redact.js';
// ── 主动开话题的时间段：窗口外不主动开口（聊天回复不受影响）──

// 主动开话题的"上次判定时间"要落盘：否则服务一重启，15 秒后的第一个 tick 就又能开一次话题，
// 表现就是"重启一下群里就多一次开话题"，跟"约 5 小时概率一次"的设定不符。
const PROACTIVE_STATE_FILE = path.join(DATA_DIR, 'proactive-state.json');
// 一次 tick 里合并多条到点提醒时，note 正文的总长度上限。note 进提示词时会被
// safeSlice(…, 600) 截一次，超过它的条目内容会被整段切掉、却已经在下面标记 fired。
// 400 给"【定时提醒】"前缀、迟到提示与尾句留足余量；放不下的条目继续留在 pending，
// 下一个 30 秒 tick 再派发（2026-09-29 审查 P1）。
const REMINDER_NOTE_BODY_MAX = 400;
// 主动唤醒被"接不了"（会话在跑 / 并发满 / 没配模型）时的重试间隔：
// 不设这个的话模型自安排的唤醒会在那些时刻被静默丢掉（2026-09-29 审查 P2）。
const WAKE_RETRY_MS = 60 * 1000;
/**
 * "我说了话但没人接" 的补话判定（纯函数，便于单测）。
 * 只给一次机会：20 分钟内不重复安排；有人刚说话/已有安排/不在发言时段都不安排。
 * followUpEnabled 是控制台里的独立开关（proactive.followUpEnabled）：关了就不安排，
 * 它跟"冷场开话题"(proactive.enabled) 互不影响。
 */
export function followUpPlan({
  sentCount = 0, unread = 0, lastFollowUpAt = 0, hasScheduledWake = false,
  windowActive = true, followUpEnabled = true, now = Date.now(), random = Math.random,
  followUpDelayMinutes = 10, followUpCooldownMinutes = 20
} = {}) {
  if (!followUpEnabled) return { schedule: false, reason: '补话开关已关闭' };
  if (!sentCount) return { schedule: false, reason: '本轮没发言' };
  if (unread > 0) return { schedule: false, reason: '有人刚说话，走正常回复' };
  if (hasScheduledWake) return { schedule: false, reason: '已有唤醒安排' };
  if (!windowActive) return { schedule: false, reason: '不在可主动发言的时段' };
  const base = Math.max(1, Number(followUpDelayMinutes) || 10);
  // 冷却必须长于「实际补话延迟 + 最大抖动」，否则把 delay 调大后条件恒成立，会无限补话。
  const cooldownMs = Math.max((base + 3) * 60000, (Number(followUpCooldownMinutes) || 20) * 60000);
  if (now - Number(lastFollowUpAt || 0) < cooldownMs) {
    return { schedule: false, reason: `${Math.round(cooldownMs / 60000)} 分钟内已经给过机会` };
  }
  return { schedule: true, minutes: base + Math.floor(random() * 3), reason: '发言后没人接话' };
}

function activeHoursMinuteOf(value, end = false) {
  if (end && String(value) === '24:00') return 1440;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 解析时间段：支持 {start,end} 或 {windows:[{start,end},…]}；未配置 = 全天。 */
export function proactiveWindows(raw) {
  const list = [];
  const push = (w) => {
    const start = activeHoursMinuteOf(w?.start);
    const end = activeHoursMinuteOf(w?.end, true);
    if (start != null && end != null && start !== end) list.push({ start, end });
  };
  if (Array.isArray(raw?.windows)) raw.windows.forEach(push);
  else push(raw);
  return list;
}

/** 现在是否在某个窗口内；不在时给出最近的窗口开始时间。 */
export function proactiveWindowState(raw, now) {
  const windows = proactiveWindows(raw);
  if (!windows.length) return { active: true, nextActiveAt: now };
  const minute = minuteOfDayInZone(now);
  let best = null;
  for (const w of windows) {
    const wrap = w.start > w.end;
    const active = wrap ? (minute >= w.start || minute < w.end) : (minute >= w.start && minute < w.end);
    if (active) return { active: true, nextActiveAt: now };
    const delta = minute < w.start ? w.start - minute : 1440 - minute + w.start;
    if (best == null || delta < best) best = delta;
  }
  return { active: false, nextActiveAt: now + best * 60000 };
}


import { safeSlice } from './util.js';
import { canRun, chatAllowed } from './access.js';
import { idList } from './list.js';
import { assertTimeAllowed, isTimeActive, TimeControlError, timeUntilActive, watchTimeWindow, withTimeScope } from './time-gate.js';
import { vendorOfConfig, vendorOfBaseUrl } from '../pricing/model-prices.js';
import { budgetStatus } from './budget.js';
import { readOwnerUin } from './notify-owner.js';
import { notePersonaInteraction, personaStatePrompt } from './persona-state.js';
import { memeDensityPrompt } from '../llm/humanize.js';
import { memesForPrompt } from '../memes/store.js';
import { visibleImpressions, memoryVisibilityOf } from './memory-visibility.js';
import { knowledgeEnabled } from '../knowledge/store.js';
import { buildReminderNote, reminderNoteCost } from './reminders.js';
import { ZONE_OFFSET_MS, minuteOfDayInZone, randInt, createEventBus, todayKey, sanitizeUserText } from './util.js';
import { readFollowUpAt, readProactiveAttempts, readProactiveState, writeFollowUpAt, writeProactiveAttempt, writeProactiveChatAttempts } from './proactive-state.js';
import { buildSystemPrompt, buildUserPrompt, isAtMe, resolveContextTier } from '../llm/prompt.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, emptyUsage, isRetryableError } from '../llm/llm.js';
import { buildToolDefs, toOpenAiTools, executeTool, platformToolAllowed } from '../tools/tools.js';
import { normalizeMid } from '../tools/tools-core.js';
import { skillGateMessage } from '../skills/registry.js';
import { visionEnabled } from '../llm/vision-scan.js';
import { resolvePersona, voiceForPersona } from '../personas.js';
import { currentProviders } from './providers.js';
import { buildSlangContextForChat } from '../console/asset-observer.js';
import { parseInlineToolCalls } from '../tools/inline-tools.js';
import { createLogger, newTraceId, withTrace } from './logger.js';
import { ttsConfigured } from '../llm/tts-openai.js';

const log = createLogger('orchestrator');

function handoffParticipantIds(triggerEntries) {
  return [...new Set((triggerEntries || [])
    .filter((m) => !m?.self && m?.senderId !== null && m?.senderId !== undefined)
    .map((m) => String(m.senderId).trim())
    .filter(Boolean))];
}

function continuationParticipantIds(session, triggerEntries, store, chatKey) {
  const ids = [];
  for (const item of session?.messages || []) {
    const call = item?.toolCall;
    if (!call || !['send_message', 'send_sticker', 'send_poke'].includes(call.name)) continue;
    // 与 tools 层的校验/发送同口径归一化：模型会把 '#42' 这种形态传进来，
    // 直接存进 participantIds 的话后续 `participants.has(senderId)` 永远不命中
    // （该人再发言就不会触发确定性续接；2026-09-29 审查）。
    const atUserId = normalizeMid(call.args?.atUserId ?? call.args?.targetUserId ?? '');
    if (atUserId) ids.push(atUserId);
    const replyId = call.args?.replyToMessageId;
    if (replyId !== undefined && replyId !== null && String(replyId).trim()) {
      const replied = store.findByMid?.(chatKey, replyId);
      if (replied?.senderId && !replied.self) ids.push(String(replied.senderId));
    }
  }
  if (!ids.length) {
    const last = [...(triggerEntries || [])].reverse()
      .find((m) => !m?.self && String(m?.senderId || '').trim());
    if (last) ids.push(String(last.senderId));
  }
  return [...new Set(ids)].slice(0, 8);
}

function lastSentText(session) {
  return (session?.sent || [])
    .map((entry) => String(entry?.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('；')
    .slice(0, 600);
}

function hasInlineImage(messages) {
  return (messages || []).some((message) => Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'image_url'
      && String(part?.image_url?.url || '').startsWith('data:')));
}

function imagePartCount(messages) {
  return (messages || []).reduce((total, message) => total + (
    Array.isArray(message?.content)
      ? message.content.filter((part) => part?.type === 'image_url').length
      : 0
  ), 0);
}

function modelMessagesForAudit(messages) {
  return structuredClone(messages || []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    message.content = message.content.map((part) => {
      const url = String(part?.image_url?.url || '');
      if (part?.type !== 'image_url' || !url.startsWith('data:')) return part;
      const mime = /^data:([^;,]+)/.exec(url)?.[1] || 'application/octet-stream';
      return {
        ...part,
        image_url: {
          ...part.image_url,
          url: `[inline ${mime} omitted from audit snapshot; ${url.length} chars]`
        }
      };
    });
    return message;
  });
}

export function estimateNextPromptTokens({
  messages,
  tools,
  previousPromptTokens = 0,
  previousEstimateChars = 0,
  previousImageCount = 0
}) {
  const auditMessages = modelMessagesForAudit(messages);
  const estimateChars = JSON.stringify({ messages: auditMessages, tools }).length;
  const imageCount = imagePartCount(messages);
  const textTokens = previousPromptTokens > 0 && previousEstimateChars > 0
    ? Math.ceil(estimateChars * previousPromptTokens / previousEstimateChars * 1.08)
    : Math.ceil(estimateChars * 0.55);
  // 图片的 base64 字节不是文本 Token。只为本轮新加入的图片预留视觉编码预算；
  // 已存在图片的成本已经包含在上一轮真实 prompt_tokens 比例里。
  const newImages = Math.max(0, imageCount - Math.max(0, Number(previousImageCount) || 0));
  return {
    estimatedPromptTokens: textTokens + newImages * 4096,
    estimateChars,
    imageCount,
    auditMessages
  };
}

export function randomWakeDelay(config = getConfig(), random = Math.random) {
  const legacy = Math.max(0, Number(config?.wakeDelayMs) || 0);
  let min = Number.isFinite(Number(config?.wakeDelayMinMs))
    ? Math.max(0, Number(config.wakeDelayMinMs))
    : legacy;
  let max = Number.isFinite(Number(config?.wakeDelayMaxMs))
    ? Math.max(0, Number(config.wakeDelayMaxMs))
    : legacy;
  if (min > max) [min, max] = [max, min];
  const ratio = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(min + (max - min) * ratio);
}

/**
 * 「冷场开话题」每轮真的发言的概率：0 是合法取值（= 不再随机开话题），别用 `|| 默认值` 把它吞掉；
 * 越界值夹到 [0,1]，非数字才回落到默认 0.25（2026-10-01 审查）。
 */
export function proactiveProbability(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.25;
}

/**
 * 冷场开话题的作用范围。默认群聊开、私聊关（与升级前行为一致）；
 * tick 的早退与候选选择共用这一处，避免两处各写一份默认值后漂移。
 */
export function proactiveScopes(cfg = {}) {
  return {
    groups: cfg.proactive?.groupEnabled !== false,
    private: cfg.proactive?.privateEnabled === true
  };
}

/**
 * 挑出这次"冷场主动开话题"可以去的会话（纯函数，便于单测）。
 *
 * 作用范围由控制台两个复选框决定：
 *   · 群聊（proactive.groupEnabled，默认开）：沿用 allow.groups / allowAllWhenEmpty；
 *   · 私聊（proactive.privateEnabled，默认关）：沿用 allow.private（deny 优先、名单空时看
 *     allowAllWhenEmpty），与平时回复私聊的白名单规则一致，不另建名单。
 */
export function proactiveCandidates({
  chatKeys = [], cfg = {}, metaOf = () => ({}), now = Date.now(),
  canWake = () => true, isRunning = () => false
} = {}) {
  // 注入点先落本地 const（ops scan --strict 只认 const/let；同 capabilities.js 约定）
  const metaOfFn = metaOf;
  const canWakeFn = canWake;
  const isRunningFn = isRunning;
  const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
  const allowGroups = idList(cfg.allow?.groups);
  const scopes = proactiveScopes(cfg);
  const out = [];
  for (const chatKey of chatKeys) {
    const [kind, id] = String(chatKey).split(':');
    if (kind === 'group') {
      if (!scopes.groups) continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
    } else if (kind === 'private') {
      if (!scopes.private) continue;
    } else {
      continue;
    }
    if (!canWakeFn(chatKey)) continue;
    if (isRunningFn(chatKey)) continue;
    const meta = metaOfFn(chatKey) || {};
    if (meta.unread > 0) continue;
    if (now - (Number(meta.lastTs) || 0) < idleMs) continue;
    out.push(chatKey);
  }
  return out;
}

export function triggerKindForTier(result = {}, {
  manual = false,
  proactive = false,
  chatKey = ''
} = {}) {
  const tier = Number(result?.tier);
  const reason = String(result?.reason || '');
  if (manual) return 'manual';
  if (proactive) return 'proactive';
  if (reason === '私聊' || String(chatKey).startsWith('private:')) return 'private';
  if (tier === 1 || reason === '被艾特') return 'mention';
  if (tier === 2 || reason === '关键词命中') return 'keyword';
  if (tier === 3 || reason.startsWith('随机命中')) return 'probability';
  if (tier === 4 || reason === '全部响应') return 'all';
  if (tier === 5 || /引用机器人/.test(reason)) return 'reply';
  if (tier === 6 || /生命周期：(?:活跃|监听)状态/.test(reason)) return 'lifecycle';
  if (tier === 7 || /硬上限后的任意消息续接/.test(reason)) return 'rollover';
  if (tier === 8 || reason === '失败批次重试') return 'retry';
  return 'unknown';
}

/**
 * 是否该跑一次自动记忆整理（纯函数，便于单测）。
 *
 * 触发规则：
 *   - 一条印象都没有时：**允许跑一次**。整理里的"发现新人"那条路
 *     （发言够多但零印象的人 → 新建印象）正是给这种情况准备的；如果这里也按
 *     "印象数 > 阈值"卡住，新装实例的自动整理就永远不会触发 ——
 *     印象数从 0 开始，永远够不到阈值，于是谁都没有人物记忆。
 *   - 已经有印象时：按阈值来（全群总数超过 minImpressions，或某人超过 maxPerMember）。
 */
export function shouldAutoConsolidate({
  impressionCount = 0,
  memberCounts = [],
  minImpressions = 4,
  maxPerMember = 5
} = {}) {
  const total = Number(impressionCount) || 0;
  if (total <= 0) return true;
  if (total > Math.max(1, Number(minImpressions) || 4)) return true;
  return memberCounts.some((count) => Number(count) > Math.max(2, Number(maxPerMember) || 5));
}

/**
 * 同一份记忆的两条记录合成一条时用（遗留条目反查出的 QQ 与本人记录指向同一个人）：
 * 按正文去重，保留先出现那条的时间戳与来源。
 */
function mergeImpressionLists(base = [], extra = []) {
  const out = [...(Array.isArray(base) ? base : [])];
  const seen = new Set(out.map((e) => String(e?.content ?? '')));
  for (const entry of Array.isArray(extra) ? extra : []) {
    const content = String(entry?.content ?? '');
    if (!content || seen.has(content)) continue;
    seen.add(content);
    out.push(entry);
  }
  return out;
}

/**
 * 记忆整理的结果能不能采纳（纯函数，便于单测）。
 *
 * 规则（整理模式只在"合并/删减/按事实改写"的范围内可信）：
 *   - 新建模式：条数不受限（本来就是从零提炼）；
 *   - 条数减少或持平：采纳；
 *   - 比原来多 1 条、且总字数没有明显变多（≤20% 或 80 字内）：采纳 —— 这是"把一条混着两件事的印象拆开"
 *     的正常改写。以前一律按"条数变多 = 疑似幻觉"拒绝，好改写会被旧文本顶回去
 *     （实测：模型想把"扬言改人设"那条改干净，拆成 4 条就被拦下）；
 *   - 条数多出 2 条以上、或总字数明显膨胀：拒绝（那才像在编内容）。
 *
 * @returns {string} 拒绝原因；可以采纳时返回空串。
 */
/**
 * finish 的同批屏障（issue #58）：finish 可以与其它工具同批，但
 *  - 同批前面已有工具失败时，finish 不许提交（否则模型以为答完了，实际消息没发出去）；
 *  - finish 成功之后，同批后面的工具不再执行（不能再产生副作用）。
 * 返回空串 = 放行；返回非空串 = 这条工具要返回的拒绝原因。
 */
export function finishBarrierBlock(name, {
  finished = false,
  priorFailure = false,
  unsentDeliveryFailure = false
} = {}) {
  if (finished) return '未执行：finish 已形成本轮终止边界，之后的工具不能再产生副作用。';
  if (name === 'finish' && unsentDeliveryFailure) {
    return 'finish 未执行：本轮尝试发送内容但尚未成功送达。请立即改用 send_message 发送文字回复；不要重试表情，也不要只结束本轮。';
  }
  if (name === 'finish' && priorFailure) {
    return 'finish 未执行：本轮前置工具有失败项，需要先查看错误并重新决定。';
  }
  return '';
}

export function consolidationRejectionReason({ isNew = false, existing = [], next = [] } = {}) {
  // 形状护栏先于 isNew：新建模式同样不能收坏结构 —— 否则对象条目会被 String() 成
  // "[object Object]" 落进记忆（isNew 以前直接短路掉这两道检查，2026-10-10 审查 A1）。
  // 结果必须是数组：`{"result":[…]}` 这类坏结构以前会被就地当成 [] 处理，
  // 于是"模型答歪了"和"模型明说没有可保留的"长得一模一样 —— 前者会把印象全清空。
  if (!Array.isArray(next)) return '结果不是 impressions 数组（疑似坏结构）';
  // 非字符串条目（弱模型偶尔返回对象/数字）会把无意义的 `[object Object]` 写进记忆，
  // 而按 String() 计数的字数护栏又看不见它（对象只算 15 个字符），直接拒绝。
  if (next.some((item) => typeof item !== 'string')) return '结果里有非字符串条目（疑似坏结构）';
  if (isNew) return '';
  const prev = Array.isArray(existing) ? existing : [];
  const list = next;
  const prevChars = prev.reduce((n, e) => n + String(e?.content ?? '').length, 0);
  const nextChars = list.reduce((n, e) => n + String(e ?? '').length, 0);
  const grew = nextChars - prevChars;
  if (list.length <= prev.length) {
    // 条数没变多，但字数翻倍地涨 = 在往里塞新内容（每条上限 120 字、最多 5 条，
    // 正常改写不会涨这么多），也拒绝
    if (prevChars > 0 && nextChars > prevChars * 2 + 80) {
      return `结果字数暴涨（${prevChars}→${nextChars} 字），疑似幻觉`;
    }
    return '';
  }
  if (list.length === prev.length + 1 && grew <= Math.max(80, Math.round(prevChars * 0.2))) {
    return '';
  }
  return `结果变多（${prev.length}→${list.length} 条、${prevChars}→${nextChars} 字），疑似幻觉`;
}

/**
 * 裸名字要独立成词：左边不能紧贴名字字符，否则「小鲸」会吃掉「小鲸鱼」。
 * 右边分两档：中文没有空格，3 字及以上的名字允许直接接正文（「小鲸鱼在吗」）；
 * 2 字以内的短名仍要求右边界，否则「小鲸」会在「小鲸鱼」里误命中。
 * 紧跟在 @ 后面的出现交给 isAtMe（它要求名字右侧有边界）。
 */
function containsStandaloneName(text, name) {
  const isNameChar = (char) => Boolean(char) && /[\w\u3400-\u9fff]/.test(char);
  let index = text.indexOf(name);
  while (index !== -1) {
    const before = text[index - 1];
    if (before !== '@' && !isNameChar(before)) {
      const after = text[index + name.length];
      if (!isNameChar(after) || name.length >= 3) return true;
    }
    index = text.indexOf(name, index + 1);
  }
  return false;
}

/** 拍一拍命中的是机器人自己（群拍 target_id / 私聊拍自己都会落到 targetUserId）。 */
function isPokeAtBot(message, selfId) {
  if (getConfig().conversation?.pokeReplyEnabled === false) return false;
  return message?.eventKind === 'poke'
    && String(message?.targetUserId || '') === String(selfId || '');
}

/** 引用机器人自己的发言：和 @/拍一拍 一样属于直接互动。 */
function isReplyToBot(message, selfId) {
  const reply = message?.reply;
  return Boolean(reply && selfId && String(reply.senderId || '') === String(selfId));
}

/** 拍一拍/引用也算"被直接点名"：档位、自主节奏、降级闸门与回复纠正共用这一口径。 */
function mentionsOrPokesBot(message, selfId) {
  return message?.mentionsSelf === true || isPokeAtBot(message, selfId) || isReplyToBot(message, selfId);
}


/**
 * 这条消息是不是"明确在问机器人"：私聊、被 @、引用/回复它、文本里提到它在该群的名字。
 * 只用于"该回却没发"的补救判定 —— 不参与是否唤醒（档位那边有自己的判定）。
 */
export function isDirectedAtBot({ kind, triggerEntries = [], persona = {}, selfId = '', accountNickname = '' } = {}) {
  if (kind === 'private') return true;
  if (triggerEntries.some((message) => isPokeAtBot(message, selfId))) return true;
  const names = [persona.selfNickname, persona.botName, accountNickname]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const lowered = names.map((name) => name.toLowerCase());
  const nameSet = new Set(lowered);
  return (Array.isArray(triggerEntries) ? triggerEntries : []).some((message) => {
    if (message?.mentionsSelf === true) return true;
    const reply = message?.reply;
    if (reply) {
      if (selfId && String(reply.senderId || '') === String(selfId)) return true;
      const repliedName = String(reply.sender || '').trim().toLowerCase();
      if (repliedName && nameSet.has(repliedName)) return true;
    }
    // 引用的原文、展开的合并转发、卡片聊天记录都是"转述"，里面出现名字不等于在叫它
    //（2026-10-18 审查：B 引用 A 的话、而 A 的话里有机器人名字时曾被误判为"在问它"）
    const raw = String(message?.text || '');
    if (/^\[(?:合并转发|卡片聊天记录)/.test(raw)) return false;
    const body = raw.replace(/^\[引用[^\]]*\]/, '');
    // @昵称 / @QQ号 / CQ:at 与提示词同口径。字符串上报时 mentionsSelf 恒为 false，
    // 只能靠这里兜住（2026-10-19 发版前审查：此前会漏掉 CQ 码形态的 @）。
    if (isAtMe(body, { selfNickname: persona.selfNickname, botName: persona.botName, selfId })) {
      return true;
    }
    const lowerBody = body.toLowerCase();
    return lowered.some((name) => containsStandaloneName(lowerBody, name));
  });
}

export class Orchestrator {
  constructor({
    store,
    memory,
    livingMemory = null,
    stickers,
    sender,
    sessions,
    onebot,
    reminders = null,
    effects = null,
    getGames = null,
    emit = null,
    random = Math.random,
    getIdentityPilot = null,
    getIncidentPilot = null,
    getPlugins = null,
    getMcp = null,
    getLifeFeed = null
  }) {
    this.store = store;
    this.memory = memory;
    this.livingMemory = livingMemory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.reminders = reminders;
    // 出站副作用账本（可选）：日报/提醒/游戏终局用它做幂等与 unknown 留痕
    this.effects = effects;
    this.getPlugins = typeof getPlugins === 'function' ? getPlugins : null;
    this.getMcp = typeof getMcp === 'function' ? getMcp : null;
    this.getLifeFeed = typeof getLifeFeed === 'function' ? getLifeFeed : null;
    this.getGames = typeof getGames === 'function' ? getGames : null;
    this.random = random;
    this.getIdentityPilot = typeof getIdentityPilot === 'function' ? getIdentityPilot : (() => null);
    this.getIncidentPilot = typeof getIncidentPilot === 'function'
      ? getIncidentPilot
      : (() => null);
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    this.toolDefs = buildToolDefs();

    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.directPending = new Set();    // 这批等待来自 @/私聊/引用：普通消息不能把它延长回 8-12 秒
    this.lastDecisions = new Map();    // chatKey -> 最近一次"不回"的档位/原因（内存态，够控制台排查）
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    this.firstPendingAt = new Map();
    this.controllers = new Map();
    this.runTasks = new Set();
    this.retryTimer = null;
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    // 本进程此刻仍在执行的租约 id。兜底回收必须绕开它们 —— 否则「租约先到期、执行还活着」
    // 的窗口里回收会把消息放回 pending，而那个执行稍后照样发出去 → 同一批被答两遍。
    // 详见 store.recoverExpired 的注释（2026-10-09 全面审查）。
    this.liveLeases = new Set();
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.actionMemory = new Map();     // chatKey -> { at: { kind: ts } }（动作冷却跨轮）
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    // 预判时掷出的随机骰子：{ chatKey -> { roll, at } }。
    // 概率档下"要不要回"是随机的，预判（建等待会话）与实跑（真跑）必须用同一次，
    // 否则界面会自相矛盾（2026-09-22 审查发现）。
    this.pendingRolls = new Map();
    this.paused = getConfig().runtime?.paused === true;
    this.pauseReason = null;
    this.proactiveTimers = new Map();   // scope(group/private) -> timer：两个范围各自排程
    this.proactiveEpoch = 0;            // 重启循环时 +1：旧 tick 不能再排新 timer
    this.proactiveSuppressions = new Set();
    // 模型自己安排的「稍后主动发言」：chatKey -> { at, note, timer }
    this.scheduledWakes = new Map();
    this.scheduledWakeTicker = null;
    this.aborted = false;
  }

  setProactiveSuppressed(reason, suppressed) {
    const key = String(reason || 'background-task');
    if (suppressed) this.proactiveSuppressions.add(key);
    else this.proactiveSuppressions.delete(key);
  }

  #chatRuntimeDecision(chatKey) {
    const meta = this.store.getChatMeta(chatKey);
    const pilot = this.getIncidentPilot();
    if (pilot?.active) return pilot.chatDecision(chatKey, meta);
    return {
      allowed: Number(meta.held) === 0,
      mode: 'legacy',
      effectiveState: Number(meta.held) > 0 ? 'blocked' : 'normal',
      reason: Number(meta.held) > 0 ? '该会话存在发送结果待确认' : ''
    };
  }

  enforceChatControl(chatKey) {
    const decision = this.#chatRuntimeDecision(chatKey);
    if (decision.allowed) return decision;
    clearTimeout(this.wakeTimers.get(chatKey));
    this.wakeTimers.delete(chatKey);
    this.pendingWake.delete(chatKey);
    this.directPending.delete(chatKey);
    this.firstPendingAt.delete(chatKey);
    const waiting = this.pendingSessions.get(chatKey);
    if (waiting) this.#discardWaiting(waiting);
    this.pendingSessions.delete(chatKey);
    this.controllers.get(chatKey)?.abort(Object.assign(
      new Error(decision.reason || '会话已被管理员阻塞'),
      { code: 'CHAT_BLOCKED' }
    ));
    return decision;
  }

  enforceTimeControl() {
    if (getConfig().timeControl?.enabled !== true) return;
    for (const chatKey of this.store.listChats()) {
      if (isTimeActive(chatKey)) continue;
      clearTimeout(this.wakeTimers.get(chatKey));
      this.wakeTimers.delete(chatKey);
      this.pendingWake.delete(chatKey);
      this.directPending.delete(chatKey);
      this.firstPendingAt.delete(chatKey);
      const waiting = this.pendingSessions.get(chatKey);
      if (waiting) this.#discardWaiting(waiting);
      this.pendingSessions.delete(chatKey);
      this.controllers.get(chatKey)?.abort(new TimeControlError(chatKey));
      // Only pending inputs are retired; held/leased deliveries retain their audit state.
      if (this.store.markAllRead(chatKey)) this.emit('chat-update', chatKey);
    }
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) <= 0) continue;
      // 同兜底回收：已有活跃租约的会话由那次执行的收尾自己 drain，这里再排一次只会
      // 空转出一个立刻被中止的会话（2026-10-09 全面审查，与上面 ticker 同一类问题）。
      if (this.store.hasLeasedRun(chatKey)) continue;
      if (this.#budgetWouldDrop(chatKey)) continue;   // 同兜底回收：会丢的唤醒就不排
      this.scheduleWake(chatKey, 0);
    }
  }

  /**
   * 这次唤醒会不会被 #wake 里的预算闸门**直接丢掉**（而不是"稍后再来"）。
   * 给"派发前预检"用：提醒这类派发完就 markFired 的路径，必须先在这里挡住 ——
   * #wake 闸门只管"这轮不跑"，管不了"派发侧已经把提醒记成已触发"（那等于把
   * 到点的提醒内容吞掉，2026-10-04 复审 P2）。
   * block：一律会丢。degrade：群里当前未读里没有 @ 的会丢（闸门判的就是这个）。
   */
  #budgetHardBlock() {
    const b = budgetStatus(getConfig(), this.sessions?.todayUsage?.(todayKey()) || {});
    return Boolean(b.enabled && b.exceeded && b.onExceed === 'block');
  }

  #budgetWouldDrop(chatKey) {
    const b = budgetStatus(getConfig(), this.sessions?.todayUsage?.(todayKey()) || {});
    if (!b.enabled || !b.exceeded) return false;
    if (b.onExceed === 'block') return true;
    if (!String(chatKey).startsWith('group:')) return false;   // 私聊不受 degrade 影响
    // ⚠️ 窗口必须与 #wake 的 degrade 闸门一致（#unreadScanLimit = min(100, batchLimit)，即
    // claimUnread 真正领取的批次大小）：
    // 闸门看的是「这次要处理的那批未读里有没有 @」。窗口偏小时，落在窗口之后的 @ 会被这里
    // 判成"会丢"，提醒被无谓顺延 24 小时（#wake 其实照常派发）—— 2026-10-05 复审实测。
    if (typeof this.store.somePending === 'function') {
      return !this.store.somePending(chatKey, { test: (m) => mentionsOrPokesBot(m, this.onebot.selfId) });
    }
    const pending = this.store.peekUnread(chatKey, this.#unreadScanLimit()) || [];
    return !pending.some((m) => mentionsOrPokesBot(m, this.onebot.selfId));
  }

  /**
   * 自动释放"未知已消解"的 held（Issue #84）。
   * 回收循环每 5 秒先回收过期租约、再走这里：过期租约可能当场产生 held，
   * 而它们的 outbox 如果已经终结，这一轮就该解除会话阻塞，不能等人工点「核对」。
   */
  releaseResolvedHeld() {
    let result;
    try {
      result = this.store.autoReleaseResolvedHeld();
    } catch (error) {
      log.error('[held] 自动释放检查失败（下一轮再试）：', error?.message ?? error);
      return { released: [], kept: [] };
    }
    for (const item of result.released) {
      log.info(`[held] 自动释放 ${item.chatKey} run=${item.runId}：${item.messages} 条消息`
        + `（${item.reason}，outbox=${JSON.stringify(item.outbox)}）`);
      try { this.emit('chat-update', item.chatKey); } catch { /* 控制台刷新失败不影响释放 */ }
    }
    return result;
  }

  /**
   * 长跑进程的 deferred 兜底：富化任务异常/停服竞态可能留下永久不可见的行。
   * 这是最后兜底，不是队列调度：同一会话的富化是串行的，队列可能正常排几十秒；
   * 只在 5 分钟仍未放行时才按占位符收掉，且 app 侧任务真正开始时会把 deferred_at 刷新。
   */
  releaseStaleDeferred() {
    const timeout = Math.max(200, Number(getConfig().messageTypes?.enrichTimeoutMs) || 5000);
    const olderThanMs = Math.max(5 * 60 * 1000, timeout * 4 + 5000);
    let chats = [];
    try {
      chats = this.store.releaseStaleDeferred?.({ olderThanMs }) || [];
    } catch (error) {
      log.error('[ingest] 兜底放行 deferred 失败（下一轮再试）：', error?.message ?? error);
      return [];
    }
    for (const chatKey of chats) {
      log.warn(`[ingest] ${chatKey} 的延迟富化超过 ${Math.round(olderThanMs / 1000)}s，按占位符放行`);
      try { this.emit('chat-update', chatKey); } catch { /* 控制台刷新失败不影响放行 */ }
    }
    return chats;
  }

  startRecoveryLoop() {
    clearInterval(this.retryTimer);
    // 启动首轮与周期 tick 同口径：SQLITE_BUSY/磁盘暂时不可用不能把整个进程带崩，
    // 更不能让 retryTimer 没装上。下一轮 5 秒后重试。
    try {
      this.store.recoverExpired(Date.now(), { live: this.liveLeases });
      this.releaseResolvedHeld();
      this.releaseStaleDeferred();
      this.store.expireConversationThreads?.();
    } catch (error) {
      log.error('[recovery] 启动首轮回收失败（5 秒后重试）：', error?.message ?? error);
    }
    this.retryTimer = setInterval(() => {
      // 兜底回收不能把进程带走：SQLITE_BUSY、磁盘满、库损坏都可能在恢复期间抛出，
      // 而 server.js 的 uncaughtException 会直接 process.exit(1)。下一个 tick 再试即可。
      try {
        this.store.recoverExpired(Date.now(), { live: this.liveLeases });
        this.releaseResolvedHeld();
        this.releaseStaleDeferred();
        this.store.expireConversationThreads?.();
        if (this.paused || this.aborted) return;
        // ⚠️ 「今天别再花钱」（onExceed=block）时**不能**继续给有未读的会话排唤醒：
        // wake 会在预算闸门处直接 return，未读原地不动 → 下一个 tick 又排一次 ——
        // 每 tick 新建并中止一个会话、当日 runs 计一次，永不停止（2026-10-04 全面复审 P2
        // 实测：5 tick → 5 个会话文件、runs=5、模型调用 0；配合会话保留策略会挤掉真实历史）。
        // ⚠️ degrade 同样会空转（只是没有模型调用与 runs 计数）：wake 走到 degrade 闸门 →
        // 建好的等待会话被立刻丢弃 → 未读原地不动 → 下个 tick 再来。所以这里**逐会话**判
        // 「这个唤醒会不会被预算闸门丢掉」，会丢的就不排（2026-10-04 复审 P2）。
        for (const key of this.store.listChats()) {
          // ⚠️ hasLeasedRun：硬崩溃后 runs 表会留下未过期的 leased 残行，此时排唤醒 →
          // claimUnread 返回 null → 静默中止，每 5 秒建一个空会话（详见 store.recoverExpired）。
          if (!canRun(key) || this.runningChats.has(key) || this.pendingWake.has(key)
            || this.store.hasLeasedRun(key)
            || !this.#chatRuntimeDecision(key).allowed
            || this.store.unreadCount(key) <= 0) continue;
          if (this.#budgetWouldDrop(key)) continue;
          // 自主节奏：兜底回收也不能绕过 pacing 直接排 8–12 秒的即时唤醒，
          // 否则普通消息会在十几秒内被处理，概率档下还会被 markRead 静默丢弃
          // （2026-10-31 盲审 P1）。只保证"有一次 paced 安排"，已存在则不顶掉。
          if (this.#pacingApplies(key)) {
            const pending = this.store.peekUnread(key, this.#unreadScanLimit()) || [];
            const mentioned = pending.some((message) => mentionsOrPokesBot(message, this.onebot.selfId));
            if (!(mentioned && getConfig().pacing?.instantOnMention !== false)) {
              this.#ensurePacedWake(key);
              continue;
            }
          }
          this.scheduleWake(key);
        }
      } catch (error) {
        log.error('[recovery] 兜底回收这一轮出错（不影响下一轮）:', error?.message ?? error);
      }
    }, 5000);
    this.retryTimer.unref?.();
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /**
   * 说了话但没人接 —— 安排一次短唤醒，让自己决定要不要补一句。
   * 真人在群里说完没动静时，偶尔会补一句短的（"？""人呢""算了"），也会就此打住；
   * 这里只给一次机会，避免变成刷屏。
   */
  #maybeScheduleFollowUp(chatKey, session) {
    try {
      const cfgNow = getConfig();
      // 主动私聊默认关闭：补话也不能绕过这个范围开关。
      if (chatKey.startsWith('private:') && cfgNow.proactive?.privateEnabled !== true) return;
      const window = proactiveWindowState(cfgNow.proactive?.activeHours, Date.now());
      const now = Date.now();
      const plan = followUpPlan({
        sentCount: Array.isArray(session?.sent) ? session.sent.length : 0,
        unread: this.store.unreadCount(chatKey),
        lastFollowUpAt: Math.max(
          Number(readFollowUpAt(PROACTIVE_STATE_FILE, chatKey)) || 0,
          Number(this.followUpAt?.get(chatKey)) || 0
        ),
        hasScheduledWake: this.scheduledWakes?.has(chatKey) === true,
        windowActive: window.active === true,
        // 独立开关：关掉后不再安排（已经排上的那份会在派发时被作废）
        followUpEnabled: cfgNow.proactive?.followUpEnabled !== false,
        followUpDelayMinutes: cfgNow.proactive?.followUpDelayMinutes,
        followUpCooldownMinutes: cfgNow.proactive?.followUpCooldownMinutes,
        now
      });
      if (!plan.schedule) {
        if (plan.reason === '补话开关已关闭') log.info(`[follow-up] ${chatKey} 跳过：补话开关已关闭`);
        return;
      }
      if (!this.followUpAt) this.followUpAt = new Map();
      this.followUpAt.set(chatKey, now);
      writeFollowUpAt(PROACTIVE_STATE_FILE, chatKey, now);
      const share = session?.lastShare;
      const note = share
        ? `【系统提醒】你刚才分享了「${String(share.title || '').slice(0, 40)}」，到现在没人接话。想补就补一句针对这条的短话（例如问有没有人看过、补一个细节）——只有这一次机会，不补就到此为止；也可以判断没必要，直接安静结束。`
        : '【系统提醒】你刚才发过言，到现在没人接话。想补就补一句很短的（“？”/“人呢”/“算了”）——只有这一次机会，不补就到此为止；也可以判断没必要，直接安静结束。';
      this.scheduleInitiativeWake(chatKey, plan.minutes * 60 * 1000, note, { kind: 'followUp' });
      log.info(`[follow-up] ${chatKey} 发言后没人接话，${plan.minutes} 分钟后给它一次补话机会`);
    } catch { /* 安排不上也不影响正常回复 */ }
  }

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey, incoming = null) {
    if (this.paused || this.aborted || !canRun(chatKey)) return;
    if (!this.#chatRuntimeDecision(chatKey).allowed) return;
    if (this.runningChats.has(chatKey)) return;   // 运行结束后 drain 会接管
    // 直接互动（私聊 / @ / 拍一拍 / 引用机器人）走短聚批；普通群消息仍按 8-12 秒攒批。
    // 拍一拍/贴表情等事件调用方可能不传 payload，此时从当前未读里判断是否直接互动。
    const direct = chatKey.startsWith('private:')
      || (incoming
        ? mentionsOrPokesBot(incoming, this.onebot.selfId)
        : (this.store.peekUnread(chatKey, this.#unreadScanLimit()) || [])
          .some((message) => mentionsOrPokesBot(message, this.onebot.selfId)));
    // 自主节奏：不即时唤醒，攒着等"自己安排的醒来"统一处理；被 @ 时例外
    if (this.#pacingApplies(chatKey)) {
      // 窗口与 #wake / #budgetWouldDrop 同口径（#unreadScanLimit）：@ 落在窗口后半段时同样
      // 算"被 @ 了"，不该因为看少了而被丢进自主节奏排队。
      const pending = this.store.peekUnread(chatKey, this.#unreadScanLimit()) || [];
      const mentioned = pending.some((m) => mentionsOrPokesBot(m, this.onebot.selfId));
      if (!(mentioned && getConfig().pacing?.instantOnMention !== false)) {
        this.#ensurePacedWake(chatKey);
        return;
      }
    }
    const directDelay = Math.max(0, Math.min(2000, Number(getConfig().directWakeDelayMs) || 300));
    this.scheduleWake(chatKey, direct ? directDelay : null, { direct });
  }

  /** 最近一次"为什么没回"（档位/原因/概率）；没有记录返回 null。 */
  decisionFor(chatKey) {
    return this.lastDecisions?.get(String(chatKey)) || null;
  }

  /** 自主节奏是否作用于该会话（按 pacing.scope 判定）。 */
  #pacingApplies(chatKey) {
    const p = getConfig().pacing || {};
    if (p.enabled !== true) return false;
    // 硬规则：私聊里每句话都是直接对它说的 —— 永远即时回复，不排队
    if (chatKey.startsWith('private:')) return false;
    const scope = String(p.scope || 'group');
    if (scope === 'all') return true;
    return chatKey.startsWith('group:');
  }

  // 未读扫描窗口：全部判定口（degrade 闸门 / #budgetWouldDrop / 即时@例外 / #predictTier）共用。
  // 必须**等于**实际领取的批次大小：claimUnread 内部把它夹在 100 以内（store.js 的
  // Math.min(100, …)），所以窗口开得更大反而有害 —— 超预算的群里，第 101 条之后的 @ 会让
  // degrade 闸门判"有 @，可以回"，而真正领到的 100 条里没有 @，于是没被 @ 也回了一句
  // （2026-10-08 审查）。两处取同一个值，别再各算一份。
  #unreadScanLimit() {
    return Math.min(100, Math.max(1, Number(getConfig().store?.batchLimit) || 100));
  }

  /** 确保该会话有一次自主节奏唤醒安排；已有且在合理范围内则不动。 */
  #ensurePacedWake(chatKey) {
    const p = getConfig().pacing || {};
    const minMs = Math.max(60000, (Number(p.minWakeMinutes) || 5) * 60000);
    const maxMs = Math.max(minMs, (Number(p.maxSilenceMinutes) || 45) * 60000);
    const defMs = Math.max(minMs, Math.min(maxMs, (Number(p.defaultWakeMinutes) || 20) * 60000));
    const existing = this.scheduledWakes.get(chatKey);
    // 已有安排是模型自安排的唤醒（selfWake）或任何带留言的安排时不要顶掉：
    // scheduleInitiativeWake 是单槽覆盖，会把留言一起清掉 —— fireDueScheduledWakes 专门
    // 为 selfWake 绕开重排以保留言，这里却会先把槽覆写掉（2026-10-06 复审 P3：pacing 开启时
    // 群里来一条普通消息，模型 2 小时后带留言的唤醒就被换成 20 分钟后的无留言 paced）。
    if (existing && (existing.kind === 'selfWake' || String(existing.note || '').trim())) return;
    if (existing && existing.at - Date.now() <= maxMs) return;
    this.scheduleInitiativeWake(chatKey, defMs, '', { paced: true });
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。 */
  /**
   * 对"当前这批未读"做档位预判：这批消息值不值得机器人响应？
   *
   * scheduleWake（建等待会话前）与 wake（真正运行前）共用这一个函数，
   * 避免两处各写一份判定、日后逻辑漂移。
   *
   * 注意：这里**不消费**未读（用 peekUnread 只看不取），
   * 所以防抖窗口期间每次来新消息都可以重新预判 ——
   * 先来一句闲聊（不命中、不显示），接着有人 @ 机器人（命中、立刻显示）。
   *
   * @returns {{shouldRespond:boolean, tier:number, count:number, reason:string}}
   */
  #predictTier(chatKey, { roll } = {}) {
    const cfg = getConfig();
    // 按群人设：判定"是否在回复机器人"要用这个群生效的名字（可能与全局不同）
    const persona = resolvePersona(cfg, chatKey);
    const conversation = conversationConfigForChat(chatKey);
    const entries = this.store.peekUnread(chatKey, this.#unreadScanLimit()) || [];
    if (chatKey.startsWith('private:')) {
      const caps = tokenSaverCapsOf(cfg);
      return {
        shouldRespond: entries.length > 0,
        tier: 4,
        // 私聊与群聊同口径：省 Token 模式下也要夹（以前这里直接取 atCount，模式对它不生效）
        // 0 是合法值（= 不读历史）：不能写成 `|| 300`，否则 off 档下与升级前不一致、
        // 界面显示"生效 0"而私聊实际读 300（审查抓出来的"表与实际不符"）。
        count: cappedByTokenSaver(cfg.store?.atCount, caps?.atCount),
        reason: '私聊',
        conversationMode: conversation.mode
      };
    }
    const result = resolveContextTier({
      triggerEntries: entries,
      selfNickname: persona.selfNickname || this.onebot.selfNickname || '',
      botName: persona.botName || '',
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey),  // 按会话取档位：统一开关关闭时各群可以有独立滑条
      roll,                               // 传入已固定的骰子：预判与实跑必须用同一次
      conversationMode: conversation.mode
    });
    // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
    if (entries.length === 0) {
      return { ...result, shouldRespond: false, reason: '无未读', conversationMode: conversation.mode };
    }
    if (entries.some((entry) => Number(entry.attempts) > 0)) {
      // 与正式领取同一口径按 mode 取上下文条数：原来固定读 lifecycleContextCount
      // （任何 mode 都有默认值），默认配置下 @ 批次首轮读 300 条、重试只读 100 条。
      const retryContext = conversation.mode === 'lifecycle'
        ? conversation.lifecycleContextCount
        : conversation.mode === 'threaded'
          ? conversation.continuationContextCount
          : storeConfigForChat(chatKey).allCount;
      return {
        tier: 8,
        count: cappedByTokenSaver(Math.min(
          500,
          Math.max(1, Number(retryContext) || result.count || 100)
        ), tokenSaverCapsOf(getConfig())?.allCount),
        reason: '失败批次重试',
        shouldRespond: true,
        conversationMode: conversation.mode
      };
    }
    if (result.shouldRespond) return { ...result, conversationMode: conversation.mode };
    if (conversation.mode === 'lifecycle') {
      return this.#lifecycleTier(chatKey, entries, result, conversation);
    }
    if (conversation.mode === 'threaded') {
      return this.#continuationTier(chatKey, entries, result, conversation);
    }
    return { ...result, conversationMode: 'legacy' };
  }

  #isReplyToSelf(chatKey, entries) {
    const cfg = getConfig();
    const persona = resolvePersona(cfg, chatKey);
    const selfId = String(cfg.onebot?.selfId || this.onebot.selfId || '');
    const names = new Set([
      persona.selfNickname,
      this.onebot.selfNickname,
      persona.botName
    ].map((v) => String(v || '').trim()).filter(Boolean));
    return entries.some((m) => {
      if (selfId && String(m.reply?.senderId || '') === selfId) return true;
      return names.has(String(m.reply?.sender || '').trim());
    });
  }

  /**
   * 把这批消息的最后一条标为已读（platform.readReceipts，默认关）。
   * 只发最后一条：QQ 的已读是"读到某条"的语义，后面的自然覆盖前面的。
   * best-effort —— 失败只打个日志，绝不影响运行收尾。
   */
  #markBatchRead(chatKey, entries) {
    const mids = (Array.isArray(entries) ? entries : [])
      .map((m) => m?.mid)
      .filter((v) => v !== null && v !== undefined && String(v) !== '');
    const last = mids[mids.length - 1];
    if (last === undefined) return;
    Promise.resolve()
      .then(() => this.onebot.markMessageRead?.(last))
      .catch((error) => log.warn(`[orchestrator] ${chatKey} 标已读失败（不影响本轮）：${error?.message ?? error}`));
  }

  #continuationTier(chatKey, entries, fallback, conversation) {
    // 与手动/主动唤醒同口径：省 Token 模式夹上限（关闭时上限为 null，原样取会话配置）
    const count = cappedByTokenSaver(
      Math.min(500, Math.max(1, Number(conversation?.continuationContextCount) || 100)),
      tokenSaverCapsOf(getConfig())?.allCount
    );
    if (this.#isReplyToSelf(chatKey, entries)) {
      return {
        tier: 5, count, reason: '续接：引用机器人',
        shouldRespond: true, conversationMode: 'threaded'
      };
    }

    const thread = this.store.getConversationThread?.(chatKey);
    if (!thread || thread.mode !== 'threaded' || thread.engagedUntil <= Date.now()) {
      return { ...fallback, conversationMode: 'threaded' };
    }
    const participants = new Set((thread.participantIds || []).map(String));
    const sameParticipant = entries.some((m) => participants.has(String(m.senderId || '')));
    if (!sameParticipant) return { ...fallback, conversationMode: 'threaded' };
    return {
      tier: 5,
      count,
      reason: '续接：参与者在活跃窗口内继续发言',
      shouldRespond: true,
      threadId: thread.threadId,
      conversationMode: 'threaded'
    };
  }

  #lifecycleTier(chatKey, entries, fallback, conversation) {
    // 同上：生命周期续接读多少条也吃上限
    const count = cappedByTokenSaver(
      Math.min(500, Math.max(1, Number(conversation?.lifecycleContextCount) || 100)),
      tokenSaverCapsOf(getConfig())?.allCount
    );
    const thread = this.store.getConversationThread?.(chatKey);
    if (thread?.mode === 'lifecycle') {
      if (thread.state === 'rollover_armed') {
        return {
          tier: 7, count, reason: '生命周期：硬上限后的任意消息续接',
          shouldRespond: true, threadId: thread.threadId,
          conversationMode: 'lifecycle', lifecycleState: thread.state
        };
      }
      if (thread.state === 'active' || thread.state === 'listening') {
        return {
          tier: 6, count, reason: `生命周期：${thread.state === 'active' ? '活跃' : '监听'}状态`,
          shouldRespond: true, threadId: thread.threadId,
          conversationMode: 'lifecycle', lifecycleState: thread.state
        };
      }
    }
    if (this.#isReplyToSelf(chatKey, entries)) {
      return {
        tier: 5, count, reason: '生命周期：引用机器人',
        shouldRespond: true, conversationMode: 'lifecycle'
      };
    }
    return { ...fallback, conversationMode: 'lifecycle' };
  }

  #applySessionTrigger(session, result, options = {}) {
    if (!session) return;
    session.triggerKind = triggerKindForTier(result, options);
    session.triggerReason = String(result?.reason || '').slice(0, 160);
    session.contextTier = Number.isFinite(Number(result?.tier))
      ? Number(result.tier)
      : null;
  }

  #applyThreadSnapshot(session, thread, fallbackState = null) {
    if (!session) return;
    session.threadState = thread?.state || fallbackState || session.threadState || null;
    session.threadOpenedAt = Number(thread?.openedAt) || Number(session.threadOpenedAt) || 0;
    session.threadIdleDeadline = Number(thread?.idleDeadline) || 0;
    session.threadHardDeadline = Number(thread?.hardDeadline) || 0;
    session.threadResumeArmedUntil = Number(thread?.resumeArmedUntil) || 0;
    session.threadExpiresAt = Number(thread?.expiresAt) || 0;
    session.threadCloseReason = String(thread?.closeReason || '');
  }

  #applyWaitingConversation(session, predicted, chatKey) {
    if (!session) return;
    const mode = ['legacy', 'threaded', 'lifecycle'].includes(predicted?.conversationMode)
      ? predicted.conversationMode
      : conversationConfigForChat(chatKey).mode;
    const currentThread = mode !== 'legacy'
      ? this.store.getConversationThread?.(chatKey)
      : null;
    const thread = currentThread?.mode === mode ? currentThread : null;
    session.conversationMode = mode;
    session.threadId = predicted?.threadId || thread?.threadId || null;
    this.#applyThreadSnapshot(
      session,
      thread,
      predicted?.lifecycleState || (mode === 'lifecycle' && !session.threadId ? 'starting' : null)
    );
    session.lifecycleContinuation = mode === 'lifecycle' && Boolean(session.threadId);
    this.#applySessionTrigger(session, predicted, { chatKey });
  }

  scheduleWake(chatKey, delay = null, { direct = false } = {}) {
    if (this.paused || this.aborted || !canRun(chatKey)) return;
    if (!this.#chatRuntimeDecision(chatKey).allowed) return;
    const now = Date.now();
    // 已经排了直接互动的短聚批：后面的普通消息不能把它顶回 8-12 秒随机窗口。
    if (this.pendingWake.has(chatKey) && !direct && this.directPending.has(chatKey)) return;
    if (!this.firstPendingAt.has(chatKey)) this.firstPendingAt.set(chatKey, now);
    if (direct) this.directPending.add(chatKey);
    const hardLimit = Math.min(20000, Math.max(100, Number(getConfig().maxBatchWaitMs) || 20000));
    const desired = delay ?? randomWakeDelay(getConfig(), this.random);
    const ms = Math.max(0, Math.min(desired, this.firstPendingAt.get(chatKey) + hardLimit - now));
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);

    // 等待窗口 > 0：在会话页立刻创建“等待中”会话，并随新消息重置倒计时
    //
    // ⚠️ 先预判再创建：档位非 4 时，若这批消息确定不会响应，
    //    就**不创建**"等待中"会话 —— 否则用户会在会话页看到一堆
    //    等半天最后变成"中止"的条目，既干扰又让人以为出了错。
    //    窗口结束前若来了新消息且命中，届时再创建（见下面 pendingSessions 分支）。
    if (ms > 0 && !this.runningChats.has(chatKey)) {
      // 概率档下"要不要回"是随机的：预判与实跑必须是同一次掷骰，
      // 否则会出现"会话页显示等待中、随后又干净消失"或者反过来的自相矛盾
      // （2026-09-22 审查发现）。这里掷一次存起来，wake 时取走。
      const roll = this.random() * 100;
      this.pendingRolls.set(chatKey, { roll, at: Date.now() });
      // 这一段里有 store 读（#predictTier 的档位判定、#applyWaitingConversation 的写回）：
      // 中间抛出去就会留下上面 #abortSchedule 注释里那两笔烂账，所以整体兜住（2026-10-08 审查）。
      try {
      const predicted = this.#predictTier(chatKey, { roll });
      if (predicted.shouldRespond === false) {
        // 不响应：把已存在的等待会话撤掉（例如刚被艾特、随后判定又不成立的情况）
        const stale = this.pendingSessions.get(chatKey);
        if (stale) {
          this.#discardWaiting(stale);   // 干净消失，不留"中止"
          this.pendingSessions.delete(chatKey);
        }
        this.emit('chat-update', chatKey);
        // 定时器仍然保留：窗口内可能来新消息，届时重新预判
      } else {
      const unread = this.store.peekUnread(chatKey, 3);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const waitUntil = Date.now() + ms;
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        const s = this.sessions.current.get(existing);
        if (s && s.status === 'waiting') {
          s.waitUntil = waitUntil;
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.#applyWaitingConversation(s, predicted, chatKey);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        const session = this.sessions.create({
          chatKey,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.#applyWaitingConversation(session, predicted, chatKey);
        this.sessions.update(session.id);
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      this.emit('chat-update', chatKey);
      }
      } catch (error) {
        // 预测/创建"等待中"会话途中失败：把排程痕迹与会话一起收掉，别留下半成品。
        // 收完必须返回 —— 否则下面照常安装定时器，把刚收掉的排程原样装回去（2026-10-10 审查 A3）。
        this.#abortSchedule(chatKey, error);
        return;
      }
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      this.directPending.delete(chatKey);
      this.wakeTimers.delete(chatKey);
      this.firstPendingAt.delete(chatKey);
      const waitingId = this.pendingSessions.get(chatKey);
      this.pendingSessions.delete(chatKey);
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        return;
      }
      const task = this.wake(chatKey, { waitingSessionId: waitingId ?? null })
        .catch((error) => log.error(`[orchestrator] wake ${chatKey} 出错:`, error))
        .finally(() => this.runTasks.delete(task));
      this.runTasks.add(task);
    }, ms);
    this.wakeTimers.set(chatKey, timer);
    return true;
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用于档位判定"这次不响应"的场景 —— 用户看到的应该是"什么都没发生"，
   * 而不是一条等了半天最后标着"中止"的条目（那会让人以为机器人坏了）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #budgetNotifiedDay = '';

  /** 「今天的额度用完了」这句按 chatKey × 天去重：没有它，兜底回收每 5~25s 重排一次就会在群里刷屏。 */
  #budgetSaid = new Map();

  /** 模型最终失败时给直接互动的一句兜底：按会话冷却，避免故障期间刷屏。 */
  #failureNoticeAt = new Map();

  /**
   * 正在派发、还没确认播报的提醒 id。标记已触发改到了唤醒完成之后（2026-10-20），
   * 这中间状态仍是 pending；没有这个集合，30 秒后的下一轮会把同一条再派一次。
   */
  #remindersInFlight = new Set();

  /**
   * 额度用完的固定文案：同一天同一会话只发一次（2026-10-03 全量审查：原来无条件发，
   * 而该分支又不消费未读 → 兜底回收无限重排 → 同一天同一个群能刷出几十条）。
   * 跨天自动重来；条目按天淘汰（只保留当天的，内存不涨）。
   */
  async #maybeSayBudgetExhausted(chatKey) {
    const day = todayKey();
    if (this.#budgetSaid.get(chatKey) === day) return;
    this.#budgetSaid.set(chatKey, day);
    if (this.#budgetSaid.size > 500) {
      for (const [key, seenDay] of this.#budgetSaid) if (seenDay !== day) this.#budgetSaid.delete(key);
    }
    try { await this.sender.sendTextBatch(chatKey, ['今天的额度用完了，明天再聊'], {}); }
    catch { /* 发送失败不阻断 */ }
  }

  /**
   * 模型重试耗尽、直接互动（@/私聊/引用）一条都没发出去时，给等的人一句可见的兜底。
   * 只做一次短句 + 每会话冷却；普通群消息、主动唤醒、观察/安静时段都不发。
   */
  async #maybeSayFailureNotice(chatKey, {
    triggerEntries = [], sentCount = 0, proactive = false, manual = false, timeClosed = false
  } = {}) {
    if (proactive || manual || timeClosed || sentCount > 0) return;
    const cfg = getConfig().failureNotice || {};
    if (cfg.enabled === false) return;
    const direct = chatKey.startsWith('private:')
      || (triggerEntries || []).some((m) => mentionsOrPokesBot(m, this.onebot.selfId));
    if (!direct) return;
    const cooldownMs = Math.max(60000, (Number(cfg.cooldownMinutes) || 8) * 60000);
    const now = Date.now();
    if (now - Number(this.#failureNoticeAt.get(chatKey) || 0) < cooldownMs) return;
    this.#failureNoticeAt.set(chatKey, now);
    if (this.#failureNoticeAt.size > 500) {
      for (const [key, at] of this.#failureNoticeAt) {
        if (now - Number(at) > cooldownMs) this.#failureNoticeAt.delete(key);
      }
    }
    try { await this.sender.sendTextBatch(chatKey, ['卡了一下，等下再说'], { persona: true }); }
    catch { /* 兜底文案发不出去也不影响收尾 */ }
  }

  /**
   * 超限当天私聊管理员一次（改进方案 #8/J.3：去重键 = dayKey，内存态即可 —— 重启最多重发一条，
   * 不值得为此落盘）。发送走主进程 sender（WS 通道）；失败静默，不影响拦截逻辑。
   */
  #maybeNotifyBudgetExceeded(budget) {
    const day = todayKey();
    if (this.#budgetNotifiedDay === day) return;
    this.#budgetNotifiedDay = day;
    const owner = readOwnerUin(getConfig());
    if (!/^\d{5,15}$/.test(owner)) return;
    const unpriced = budget.unpricedRuns > 0 ? `（另有 ${budget.unpricedRuns} 次运行未计价，未计入金额）` : '';
    const text = `每日花费已达上限：估算已用 ¥${budget.spentYuan.toFixed(2)} / ¥${budget.limitYuan}${unpriced}。`
      + (budget.onExceed === 'block'
        ? '超限策略＝停止：新消息将不处理，明天自动恢复。'
        : '超限策略＝降级：群里只回应 @，私聊不受限，明天自动恢复。');
    Promise.resolve(this.sender?.sendTextBatch?.(`private:${owner}`, [text], {})).catch(() => { /* 通知失败静默 */ });
  }

  #discardWaiting(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  #finishWaiting(sessionId, status, error = '') {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /** 兼容旧调用方的布尔接口。 */
  forceWake(chatKey) {
    return this.requestManualWake(chatKey).ok;
  }

  /** 手动触发一次处理，并返回供控制台展示的明确结果。 */
  requestManualWake(chatKey, { wakeNote = '' } = {}) {
    if (this.aborted) return { ok: false, reason: 'Agent 正在停止' };
    if (this.paused) return { ok: false, reason: 'Agent 已暂停' };
    if (!canRun(chatKey)) {
      return { ok: false, reason: '当前运行模式、白名单或时间控制不允许唤醒' };
    }
    const chatDecision = this.#chatRuntimeDecision(chatKey);
    if (!chatDecision.allowed) {
      return { ok: false, reason: chatDecision.reason || '该会话当前被阻塞' };
    }
    if (this.runningChats.has(chatKey)) {
      return { ok: false, reason: '该会话正在处理中' };
    }
    // 硬崩溃会留下未过期的 leased 残行：此时手动唤醒 → claimUnread 返回 null → 静默中止，
    // 控制台却显示"已触发"。与自动路径（ticker/drainBacklog 的 hasLeasedRun 闸门）同一口径
    //（2026-10-10 审查 A2）；正常情况下回收器几秒内清掉残行，稍后重试即可。
    if (this.store.hasLeasedRun(chatKey)) {
      return { ok: false, reason: '该会话有未回收的运行租约（上次运行可能硬崩溃），几秒后重试' };
    }
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      return { ok: false, reason: '当前并发已满，请稍后重试' };
    }
    if (!String(getConfig().api.model || '').trim()) {
      return { ok: false, reason: '模型未设置' };
    }

    // 如果自动防抖已经建了 waiting Session，手动唤醒应复用它并立刻开始，
    // 否则旧定时器稍后还会再跑一次，造成重复 Session。
    clearTimeout(this.wakeTimers.get(chatKey));
    this.wakeTimers.delete(chatKey);
    this.pendingWake.delete(chatKey);
    this.directPending.delete(chatKey);
    this.firstPendingAt.delete(chatKey);
    const waitingSessionId = this.pendingSessions.get(chatKey) || null;
    this.pendingSessions.delete(chatKey);
    const mode = this.store.unreadCount(chatKey) > 0 ? 'unread' : 'context';
    this.wake(chatKey, { manual: true, waitingSessionId, wakeNote }).catch((error) =>
      log.error(`[orchestrator] manual wake ${chatKey} 出错:`, error));
    return { ok: true, mode };
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  wake(chatKey, options = {}) {
    // #6：每次运行一个 trace id —— 运行期日志自动带 [id] 前缀，/api/status 的 lastTraceId
    // 记录"最近一次运行"（拿它去 journalctl / 日志文件捞整条链路）
    const task = withTrace(newTraceId(), () => withTimeScope(chatKey, () => this.#wake(chatKey, options)));
    this.runTasks.add(task);
    task.then(() => this.runTasks.delete(task), () => this.runTasks.delete(task));
    return task;
  }

  /**
   * #wake 的前置判定：能不能跑、要不要现在跑。返回 false ＝ 这一轮不跑（该收的会话已收掉）。
   *
   * 为什么单独成一个方法：这一段里有 **store 读写**（canRun 读配置、#chatRuntimeDecision 会
   * getChatMeta 并把过期线程写回）。任何一步抛出都会让 waiting 会话永远停在"等待中" —— 调用方
   * 已经把它从 pendingSessions 摘掉了，控制台清不掉、abortAll 也够不到它，直到重启。
   * 与 2026-10-06（add 之后）、2026-10-07（claimUnread 之后）修的两处是同一类窗口，
   * 这次把 add 之前的这一段也圈进来（2026-10-08 审查）。
   */
  #wakePreflight(chatKey, waitingSessionId) {
    if (!canRun(chatKey)) { if (waitingSessionId) this.#discardWaiting(waitingSessionId); return false; }
    if (!this.#chatRuntimeDecision(chatKey).allowed) {
      if (waitingSessionId) this.#discardWaiting(waitingSessionId);
      return false;
    }
    if (this.aborted) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return false; }
    if (this.paused) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return false; }
    if (this.runningChats.has(chatKey)) return false;

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return false;
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      if (waitingSessionId) this.#discardWaiting(waitingSessionId);
      this.scheduleWake(chatKey, 3000);
      return false;
    }
    return true;
  }

  /**
   * 排程/唤醒中途出错时把这一次的痕迹清干净。不清的话有两笔烂账：
   *   · pendingWake 会永久占着这个会话 —— 恢复循环 `pendingWake.has(key)` 直接 continue，
   *     这个群从此不会被自动唤醒（只有新消息能救回来）；
   *   · 刚刚 create 出来的"等待中"会话不在 pendingSessions 里，谁也收不掉。
   */
  #abortSchedule(chatKey, error) {
    log.error(`[orchestrator] 排程失败（${chatKey}）：`, error);
    this.pendingWake.delete(chatKey);
    this.directPending.delete(chatKey);
    const timer = this.wakeTimers.get(chatKey);
    if (timer) { clearTimeout(timer); this.wakeTimers.delete(chatKey); }
    this.firstPendingAt.delete(chatKey);
    this.pendingRolls.delete(chatKey);
    const waitingId = this.pendingSessions.get(chatKey);
    this.pendingSessions.delete(chatKey);
    if (waitingId) this.#finishWaiting(waitingId, 'aborted', '排程失败');
  }

  async #wake(chatKey, { proactive = false, manual = false, waitingSessionId = null, wakeNote = '', paced = false } = {}) {
    try {
      if (!this.#wakePreflight(chatKey, waitingSessionId)) return;
    } catch (error) {
      log.error(`[orchestrator] 唤醒前置判定失败（${chatKey}）：`, error);
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '前置判定失败');
      return;
    }

    // 未命中时只确认本次判定的快照；运行批次在模型处理成功后确认。
    const cfgNow = getConfig();
    // 2026-10-07 复审 P2：这段前置区（配置读取、预算判定、未读扫描、档位解析、claimUnread
    // 的 sqlite 读写）任何一步抛出，都会让 waiting 会话永远停在 waiting —— 调用方已把它从
    // pendingSessions 摘掉，控制台"等待中"清不掉、abortAll 也够不到它，直到重启。
    // 与 10-06 修的"add 之后准备段"是同一类窗口，范围补齐 add 之前。
    let conversation = null;
    let pendingEntries = [];
    let claimFromId = 0;   // degrade：@ 在扫描窗之外时，从这条开始领取
    let tierResult = null;
    let runTimeoutMs = 0;
    let lease = null;
    let triggerEntries = [];
    try {
    conversation = conversationConfigForChat(chatKey);
    // ── 每日预算拦截（改进方案 #8/J.3）──
    // block：本次运行不进行（active 模式下同一天同一会话只回一句固定文案）；degrade：只回应 @ ——
    // 群聊里非 @ 触发直接跳过、消息保留未读（等被 @ 或明天）。两者都只影响**新**运行，
    // 不打断进行中的会话；私聊、手动唤醒与主动唤醒不受 degrade 限制。
    // ⚠️ 这一段必须在 `if (!proactive)` **之外**：原来整段被塞在里面，于是"停止"策略下
    // 冷场开话题、模型自安排唤醒这些 proactive 唤醒照常整轮跑模型、照常花钱 ——
    // 管理员设 block 的意思就是"今天别再花钱"（2026-10-03 全量审查）。
    const budget = budgetStatus(getConfig(), this.sessions?.todayUsage?.(todayKey()) || {});
    // ⚠️ **自主节奏唤醒（paced）不是人工**：#ensurePacedWake 用 manual:true 派发它，是为了绕开
    // 唤醒侧的闸门（wakeBlockedNow / proactive 判定），但它**照样要花钱**。预算闸门若也按
    // `!manual` 判，开了 pacing 的实例在 onExceed=block 之后照样每轮整跑模型，管理员设的
    // 「今天别再花钱」形同虚设（2026-10-04 全面复审 P2 实测：block 与 degrade 下均有 12 次
    // 模型调用）。真正人工触发的（控制台点一下）才豁免。
    const budgetExempt = manual && !paced;
    if (budget.enabled && budget.exceeded) {
      if (budget.notify) this.#maybeNotifyBudgetExceeded(budget);
      if (budget.onExceed === 'block' && !budgetExempt) {
        const activeMode = String(getConfig().runtime?.mode || 'active') !== 'observe';
        // 只在"有新消息"这一路回话：主动/自主节奏唤醒没有人在等，插一句只会变成刷屏。
        if (activeMode && !proactive && !paced) await this.#maybeSayBudgetExhausted(chatKey);
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '本轮额度已用完');
        return;
      }
    }
    if (!proactive) {
      // peekUnread 只看不取，limit 给足以免漏判（判定用的是这批的文本；与 claimUnread 的
      // batchLimit 同窗口，见 #unreadScanLimit）
      pendingEntries = this.store.peekUnread(chatKey, this.#unreadScanLimit()) || [];
      // 取用预判时那颗骰子（超过 2 分钟就当过期，避免串到后面的批次）
      const pendingRoll = this.pendingRolls.get(chatKey);
      this.pendingRolls.delete(chatKey);
      const roll = pendingRoll && Date.now() - pendingRoll.at < 120000 ? pendingRoll.roll : undefined;
      // degrade 只拦"新消息触发"的这一路（主动唤醒不在这个分支里，上面的 block 已经先判过了）
      if (budget.enabled && budget.exceeded && budget.onExceed === 'degrade' && !budgetExempt
        && String(chatKey).startsWith('group:')) {
        // 闸门要扫**整段未读**：degrade 下不 ack 任何消息，积压破扫描窗后最旧的一批里
        // 可能永远没有 @，新 @ 排在队尾 —— 只看 peekUnread 的窗口会让该群当天彻底失联。
        const mentionMatcher = { test: (entry) => mentionsOrPokesBot(entry, this.onebot.selfId) };
        const inWindow = pendingEntries.some((entry) => mentionsOrPokesBot(entry, this.onebot.selfId));
        const hit = typeof this.store.findPending === 'function'
          ? this.store.findPending(chatKey, mentionMatcher)
          : (inWindow ? { id: 0 } : null);
        if (!hit && !inWindow) {
          if (waitingSessionId) this.#discardWaiting(waitingSessionId);
          return;   // 保留未读：被 @ 时（或跨日重置后）自然会再进这里
        }
        // @ 不在这一批里：从 @ 那条开始领。否则闸门判"有 @"、实际领到的却是更早的
        // 一批普通消息 —— degrade 的"只回 @"变成连续空跑模型，还把普通消息当回复对象。
        if (hit && !inWindow) claimFromId = hit.id;
      }

      const predicted = this.#predictTier(chatKey, roll === undefined ? {} : { roll });
      // degrade 下队尾命中的 @ 必回：档位是基于"最旧一批"预测的，不该把一个明确的 @ 判成不响应。
      if (claimFromId > 0) predicted.shouldRespond = true;
      const manualContextCount = cappedByTokenSaver(Math.min(500, Math.max(
        1,
        Number(conversation.mode === 'lifecycle'
          ? conversation.lifecycleContextCount
          : conversation.mode === 'threaded'
            ? conversation.continuationContextCount
            : storeConfigForChat(chatKey).allCount) || 100
      )), tokenSaverCapsOf(getConfig())?.allCount);
      if (pendingEntries.length === 0) {
        if (!manual) {
          if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
          return; // 自动唤醒没有未读时不空跑
        }
        // 控制台主动唤醒即使没有未读，也应基于最近存档运行一次。
        proactive = true;
        tierResult = {
          ...predicted,
          tier: 4,
          count: manualContextCount,
          shouldRespond: true,
          reason: paced ? '自主节奏唤醒' : '控制台主动唤醒'
        };
      }

      // 复用 scheduleWake 那一份判定逻辑，避免两处各写一套、日后漂移
      const tierResult0 = predicted;
      tierResult ||= manual
        ? {
            ...tierResult0,
            tier: 4,
            count: manualContextCount,
            shouldRespond: true,
            reason: paced ? '自主节奏唤醒' : '控制台主动唤醒'
          }
        : tierResult0;

      if (!manual && tierResult0.shouldRespond === false) {
        // 不响应：沉入历史（已读），不产生会话、不消耗 token。
        // 防抖窗口内后续到达的消息同样是"未读"状态，会在下一次唤醒时
        // 被一起判定 —— 若期间有人艾特机器人，它们会作为已读上下文带上。
        const marked = this.store.markRead(chatKey, pendingEntries.map((m) => m.id));
        // 关键：让等待会话**干净消失**，而不是标成"中止"留在列表里
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        const decision = {
          at: Date.now(),
          tier: Number(tierResult0.tier) || 0,
          reason: String(tierResult0.reason || '未触发'),
          percent: Number(storeConfigForChat(chatKey).randomPercent) || 0
        };
        this.lastDecisions.set(chatKey, decision);
        if (this.lastDecisions.size > 500) this.lastDecisions.delete(this.lastDecisions.keys().next().value);
        this.emit('chat-update', chatKey);
        if (marked) {
          log.info(`[orchestrator] ${chatKey} ${marked} 条未命中触发条件（概率 ${decision.percent}%，${decision.reason}），已标记已读、不响应`);
        }
        if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey);
        return;
      }
    }

    runTimeoutMs = Math.min(240000, Math.max(1000, Number(cfgNow.api.runTimeoutMs) || 180000));
    lease = proactive ? null : this.store.claimUnread(chatKey, {
      limit: cfgNow.store.batchLimit, maxChars: cfgNow.store.batchMaxChars, leaseMs: runTimeoutMs + 60000,
      fromId: claimFromId
    });
    triggerEntries = lease?.messages || [];
    if (!proactive && triggerEntries.length === 0) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return; // 没有未读就不空跑
    }
    if (proactive && !tierResult) {
      // 主动开口（冷场开话题 / 自我安排的唤醒）没有触发消息，**不能**走随机档：
      // 概率 0 时 resolveContextTier 会给 count=0，提示词就变成"暂无历史记录，这是你第一次
      // 参与这个会话"（2026-09-22 审查发现）。主动开口一律带全量上下文。
      tierResult = {
        tier: 4,
        count: cappedByTokenSaver(Math.min(500, Math.max(
          1,
          Number(conversation.mode === 'lifecycle'
            ? conversation.lifecycleContextCount
            : conversation.mode === 'threaded'
              ? conversation.continuationContextCount
              : storeConfigForChat(chatKey).allCount) || 100
        )), tokenSaverCapsOf(getConfig())?.allCount),
        shouldRespond: true,
        reason: '主动机会'
      };
    }

    // ── 档位：响应时带多少条已读历史 ──
    // 在唤醒时算一次并固定下来（尤其是随机档的骰子结果），
    // 否则后续每次渲染提示词都会重新掷，会话记录与提示词会对不上。
    tierResult ||= resolveContextTier({
      triggerEntries,
      selfNickname: resolvePersona(cfgNow, chatKey).selfNickname || this.onebot.selfNickname || '',
      botName: resolvePersona(cfgNow, chatKey).botName || '',
      selfId: cfgNow.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey),  // 与 #predictTier 同一来源，保证预判/实跑一致
      conversationMode: conversation.mode
    });
    } catch (error) {
      // 前置区答案：会话落终态（否则永远等待中），原样上抛让调用方照旧记日志/告警。
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', String(error?.message ?? error));
      throw error;
    }

    this.runningChats.add(chatKey);
    // 租约在这里登记为「在跑」：再往后的任何出口（准备段抛错、主 try 的 finally）都会注销它。
    // 登记点放在 claimUnread 之后是安全的 —— 租约 `expires_at` 至少还有 runTimeoutMs+60s，
    // 而 recoverExpired 只回收 `expires_at <= now` 的行，这段间隔不可能被扫到。
    if (lease?.id) this.liveLeases.add(lease.id);
    // 2026-10-06 复审 P2：add 与主 try 之间原本是一大段无保护的同步准备 —— sqlite 读线程
    // （#applyWaitingConversation → getConversationThread 里还有 BEGIN IMMEDIATE）、会话落盘、
    // emit 监听器都可能抛（磁盘满/库损坏/监听器异常）。一旦抛出，主 try 的 finally 不会执行，
    // runningChats 就永远不清：该会话此后被 onIncoming、恢复循环、手动唤醒、主动候选全部绕开，
    // 静默卡死到重启。准备段单独兜底：清掉已挂上的控制器/定时器/租约，会话落终态后原样上抛。
    const [kind, chatId] = String(chatKey).split(':');
    let controller = null;
    let runTimer = null;
    let releaseTimeGuard = null;
    let seq = 0;
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    let createdSession = false;
    try {
      seq = (this.runSeq.get(chatKey) || 0) + 1;
      this.runSeq.set(chatKey, seq);

      // 触发摘要
      const first = triggerEntries[0];
      const triggerSummary = manual
        ? (paced ? '到点唤醒' : '控制台主动唤醒')
        : proactive
        ? '主动机会（冷场开话题）'
        : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

      // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒）才新建
      if (session && session.status === 'waiting') {
        this.sessions.current.get(waitingSessionId).status = 'running';
        this.sessions.current.get(waitingSessionId).waitUntil = null;
        this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
        this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
        this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
        session = this.sessions.current.get(waitingSessionId);
      } else {
        session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
        createdSession = true;
      }
      // 手动唤醒可绕过自动分享额度（用户自己点的）；工具侧据此判断。
      session.manual = manual === true;
      this.#applyWaitingConversation(session, tierResult, chatKey);
      this.#applySessionTrigger(session, tierResult, { manual, proactive, chatKey });
      this.sessions.update(session.id);
      if (createdSession) {
        this.emit('session-start', {
          sessionId: session.id,
          chatKey,
          triggerSummary,
          triggerKind: session.triggerKind,
          triggerReason: session.triggerReason
        });
      } else {
        this.emit('session-update', session.id);
      }
      this.activeRuns.set(chatKey, session.id);
      session.leaseId = lease?.id || session.id;
      controller = new AbortController();
      this.controllers.set(chatKey, controller);
      runTimer = setTimeout(() => controller.abort(new Error('Run deadline exceeded')), runTimeoutMs);
      releaseTimeGuard = watchTimeWindow((error) => controller.abort(error), chatKey);
      this.emit('chat-update', chatKey);
    } catch (setupError) {
      if (runTimer !== null) clearTimeout(runTimer);
      releaseTimeGuard?.();
      if (controller) this.controllers.delete(chatKey);
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      if (lease?.id) this.liveLeases.delete(lease.id);
      try {
        if (session && session.status === 'running') this.sessions.finish(session.id, 'error');
        if (lease) {
          const setupTimeClosed = setupError?.code === 'TIME_CONTROL_INACTIVE' || !isTimeActive(chatKey);
          if (setupTimeClosed && !this.store.hasEffects(lease.id)) this.store.ackLease(lease.id);
          else this.store.failLease(lease.id, setupError, { retryable: !setupTimeClosed && isRetryableError(setupError) });
        }
      } catch (cleanupError) {
        log.warn(`[orchestrator] ${chatKey} 唤醒准备段中断后的清理失败：${cleanupError?.message ?? cleanupError}`);
      }
      throw setupError;
    }

    try {
      const runResult = await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, wakeNote, paced, seq,
        manual, contextLimit: tierResult.count, tierInfo: tierResult, conversation, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (conversation.mode === 'lifecycle') {
        // 回复已经发出去了：收尾写库失败（SQLITE_BUSY/磁盘满）不能把整批打成 held ——
        // 那会让该会话的后续唤醒全被 held 闸门挡住，而实际上用户已经收到回复。
        // 与 threaded 分支同一口径：只记录，不影响本轮的 ack。
        try {
          const handoff = this.#commitSessionHandoff(session, { chatKey, triggerEntries });
          this.#commitConversationThread(session, {
            chatKey, triggerEntries, handoff, conversation, runResult,
            leaseId: lease?.id || '', runId: session.leaseId
          });
        } catch (error) {
          session.threadError = String(error?.message ?? error);
          log.warn(`[lifecycle] ${chatKey} 收尾写库失败:`, session.threadError);
          // 失败的事务会把 ack 一起回滚；不补 ack 的话租约到期后 recoverExpired 看到
          // outbox 的 sent 行会把整批打成 held，整个会话从此不再回话。回复已经发出去了，
          // 这里 best-effort 收口（失败只记日志）。
          try {
            if (lease?.id) this.store.ackLease(lease.id);
            else this.store.completeRun(session.leaseId);
          } catch (ackError) {
            log.warn(`[lifecycle] ${chatKey} 收尾失败后补 ack 也失败:`, ackError?.message ?? ackError);
          }
        }
      } else {
        if (lease) this.store.ackLease(lease.id);
        else this.store.completeRun(session.leaseId);
        const handoff = this.#commitSessionHandoff(session, { chatKey, triggerEntries });
        this.#commitConversationThread(session, {
          chatKey, triggerEntries, handoff, conversation, runResult
        });
      }
      // 已读回执（platform.readReceipts，默认关）：这批处理完就在 QQ 里标已读，
      // 各端未读数不再堆积；默认关是因为它会改变"你自己打开机器人 QQ 时的未读观感"。
      if (getConfig().platform?.readReceipts === true) this.#markBatchRead(chatKey, triggerEntries);
      const status = session.sent.length > 0 ? 'done' : 'noreply';
      this.sessions.finish(session.id, status);
      // 写入走异步缓冲；总结、Embedding 或记忆服务失败绝不能拖慢/打断当前聊天回合。
      this.livingMemory?.captureTurn?.({
        chatKey,
        sessionId: session.id,
        triggerEntries,
        sent: session.sent
      });
      this.emit('session-end', { sessionId: session.id, chatKey, status,
        sent: session.sent.length, finishReason: session.finishReason, usage: session.usage });
      // 主动好友候选已整体退役（Issue #10，见 docs/KNOWN-ISSUES.md）：
      // 不再把成功回合喂给身份试点的提案管线，否则每个回合都会白烧一次模型评估、
      // 建出永远不会被派发的提案、还给管理员发一条"回复同意好友"的死信。
      if (!manual && !proactive && triggerEntries.length > 0 && friendProposalEnabled()) {
        const identityPilot = this.getIdentityPilot();
        identityPilot?.handleSuccessfulTurn?.({
          chatKey,
          triggerEntries,
          parentSessionId: session.id,
          triggerReason: tierResult?.reason || '',
          repliedThisRun: session.sent.length > 0
        }).catch((error) => {
          log.warn(`[identity-pilot] ${chatKey} 消息触发评估失败：${error?.message ?? error}`);
        });
      }
    } catch (error) {
      session.error = String(error?.message ?? error);
      const timeClosed = error?.code === 'TIME_CONTROL_INACTIVE' || !isTimeActive(chatKey);
      if (!/Delivery uncertain; batch held/.test(session.error)) {
        this.getIncidentPilot()?.capture(error, {
          source: 'orchestrator',
          category: 'session',
          severity: timeClosed ? 'info' : 'error',
          chatKey,
          sessionId: session.id,
          details: { rounds: session.rounds, sentCount: session.sent.length }
        });
        await this.#maybeSayFailureNotice(chatKey, {
          triggerEntries,
          sentCount: session.sent.length,
          proactive,
          manual,
          timeClosed
        }).catch(() => {});
      }
      // 租约/outbox 收尾单独包一层：sqlite 忙、磁盘满这类错误不能让下面的 sessions.finish
      // 被跳过 —— 否则会话会永久停在 running（控制台一直"运行中"，用量也不计账，2026-10-13 全项目审查 P2）。
      try {
        if (lease) {

          // 时间窗口关闭打断在途批次：无效果（模型没说话、无发送）时直接归档（ack）——
          // 这是文档化的刻意设计（README："非活跃期消息仅归档，不积压自动补回复"，
          // test/time-control-integration.test.mjs "prevents retry" 钉住了该语义），
          // 管理员可见性由上面的 info 级 incident 记录兜底。有发送效果时走 failLease
          // 进 held/failed 人工核对，不自动重试。
          if (timeClosed && !this.store.hasEffects(lease.id)) this.store.ackLease(lease.id);
          else this.store.failLease(lease.id, session.error, {
            // 「本轮跑超时」不能当可重试：同一批上下文再跑 1-2 次只会把模型费用翻倍，
            // 且非发送类工具的副作用（写记忆/提醒/生图）可能被重复执行。
            retryable: !timeClosed
              && controller.signal.reason?.message !== 'Run deadline exceeded'
              && (isRetryableError(error) || controller.signal.aborted)
          });
        } else {
          // 主动唤醒（无租约）失败也要收 outbox 的尾巴：成功路径会清掉 sent/failed 残行，
          // 失败路径漏了这步 → 残行永远留在 outbox（只能手动 resolveHeld，2026-10-10 审查 A4）。
          // unknown 行不动（本来就要人工核对）。
          this.store.completeRun(session.leaseId);
        }
      } catch (cleanupError) {
        log.warn('[orchestrator] 收尾失败（会话仍会正常收口）:', cleanupError?.message ?? cleanupError);
      }
      const status = timeClosed ? 'aborted' : 'error';
      this.sessions.finish(session.id, status);
      this.emit('session-end', { sessionId: session.id, chatKey, status, error: session.error });
    } finally {
      releaseTimeGuard();
      clearTimeout(runTimer);
      this.controllers.delete(chatKey);
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      if (lease?.id) this.liveLeases.delete(lease.id);
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      const pacedNow = this.#pacingApplies(chatKey);
      const unread = this.store.unreadCount(chatKey);
      if (!pacedNow && unread > 0) {
        // drainDelayMs 的 0 是合法值（"连续批次之间不额外等"）：0 应当落到 200ms 的硬下限，
        // 而不是被 `|| 1200` 当成没配（2026-10-08 审查，与 sender 的 byLengthMs 同一类）
        const drainRaw = Number(getConfig().drainDelayMs);
        const drainDelay = Math.max(200, Number.isFinite(drainRaw) ? drainRaw : 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
      // 自主节奏：本次处理完，确保还留着下一次"自己醒来"的安排
      if (pacedNow) this.#ensurePacedWake(chatKey);
      // 说了话但没人接：给一次"要不要补一句"的机会（真人也常补一句"？""人呢"）
      if (!pacedNow && unread === 0) this.#maybeScheduleFollowUp(chatKey, session);
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
    return { sessionId: session.id, status: session.sent.length > 0 ? 'done' : 'noreply', sent: session.sent };
  }

  #commitSessionHandoff(session, { chatKey, triggerEntries }) {
    const cfg = getConfig();
    if (cfg.memory?.handoffEnabled === false || typeof this.memory?.setHandoff !== 'function') return null;

    let draft = session.handoffDraft;
    if (!draft && session.sent.length > 0) {
      const previous = typeof this.memory.getHandoff === 'function'
        ? this.memory.getHandoff(chatKey)
        : null;
      const incoming = (triggerEntries || [])
        .slice(-4)
        .map((m) => `${m.senderName || m.senderId || '群友'}：${String(m.text || '').replace(/\s+/g, ' ').trim()}`)
        .filter((line) => !line.endsWith('：'))
        .join('；')
        .slice(0, 500);
      const reply = lastSentText(session);
      const turnSummary = [
        incoming ? `本轮收到：${incoming}` : '',
        reply ? `本轮回复：${reply}` : ''
      ].filter(Boolean).join('；');
      draft = {
        topic: previous?.topic || safeSlice(String(triggerEntries?.[0]?.text || reply), 200),
        summary: [previous?.summary, turnSummary].filter(Boolean).join('；').slice(-1200)
      };
      session.handoffFallback = true;
    }
    if (!draft) return null;

    try {
      const handoff = this.memory.setHandoff(chatKey, draft, {
        sourceSessionId: session.id,
        participantIds: handoffParticipantIds(triggerEntries),
        lastReply: lastSentText(session)
      });
      session.handoffUpdated = draft.clearHandoff !== true && Boolean(handoff);
      session.handoffCleared = draft.clearHandoff === true;
      session.handoffUpdatedAt = handoff?.updatedAt || Date.now();
      this.emit('memory-update', {
        chatKey,
        phase: session.handoffCleared ? 'handoff-clear' : 'handoff-update'
      });
      return handoff;
    } catch (error) {
      session.handoffError = String(error?.message ?? error);
      log.warn(`[memory] ${chatKey} 保存会话交接失败:`, session.handoffError);
      return null;
    }
  }

  #commitConversationThread(session, {
    chatKey,
    triggerEntries,
    handoff,
    conversation,
    runResult = null,
    leaseId = '',
    runId = ''
  }) {
    const mode = conversation?.mode || 'legacy';
    const currentMode = conversationConfigForChat(chatKey).mode;
    if (currentMode !== mode) {
      if (mode === 'lifecycle') {
        this.store.commitLifecycleRun({
          chatKey, leaseId, runId, persistThread: false, closeReason: 'mode-changed'
        });
      } else {
        this.store.closeConversationThread?.(chatKey, 'mode-changed');
      }
      this.#applyThreadSnapshot(session, null, 'closed');
      session.threadCloseReason = 'mode-changed';
      return;
    }
    if (mode === 'legacy') return;
    const lastMessageId = Math.max(0, ...(triggerEntries || []).map((m) => Number(m.id) || 0));
    const lastHumanAt = Math.max(0, ...(triggerEntries || []).map((m) => Number(m.ts) || 0));
    const participantIds = mode === 'threaded'
      ? continuationParticipantIds(session, triggerEntries, this.store, chatKey)
      : handoffParticipantIds(triggerEntries);
    if (mode === 'lifecycle') {
      const hasOpenWork = Boolean(
        handoff?.nextStep
        || handoff?.openQuestions?.length
        || handoff?.hypotheses?.length
      );
      const disposition = session.threadDisposition
        || (session.sent.length > 0 || hasOpenWork ? 'active' : 'listening');
      const closeReason = session.threadDisposition === 'close'
        ? 'model-close'
        : '';
      const persistThread = triggerEntries.length > 0
        || session.sent.length > 0
        || Boolean(session.threadDisposition);
      // 关掉会话交接后，旧会话对象里残留的 handoffDraft 也不能再进检查点
      const draftForCheckpoint = getConfig().memory?.handoffEnabled === false ? null : session.handoffDraft;
      const checkpointState = handoff || draftForCheckpoint || {
        summary: session.sent.length
          ? `本轮已发送 ${session.sent.length} 条消息`
          : '本轮已读取消息并保持沉默',
        lastReply: lastSentText(session)
      };
      const result = this.store.commitLifecycleRun({
        chatKey,
        leaseId,
        runId,
        persistThread,
        closeReason,
        threadOptions: {
          disposition,
          participantIds,
          topic: handoff?.topic || session.handoffDraft?.topic || '',
          lastMessageId,
          lastHumanAt,
          lastAgentAt: session.sent.length ? Date.now() : 0,
          promptHash: session.promptPrefixHash || '',
          promptTokens: session.callUsage?.at(-1)?.promptTokens || 0,
          silentIdleMs: conversation?.silentIdleMs,
          activeIdleMs: conversation?.activeIdleMs,
          hardLifetimeMs: conversation?.hardLifetimeMs,
          rolloverArmedMs: conversation?.rolloverArmedMs,
          acceptedAt: session.startedAt
        },
        checkpointState,
        sourceMessageIds: (triggerEntries || []).map((m) => m.id),
        messages: runResult?.providerTranscriptDelta || [],
        maxTranscriptChars: conversation?.maxTranscriptChars,
        forceRollover: runResult?.forceThreadRollover || '',
        rolloverArmedMs: conversation?.rolloverArmedMs
      });
      session.threadId = result.thread?.threadId || session.threadId || null;
      this.#applyThreadSnapshot(session, result.thread, closeReason ? 'closed' : null);
      if (closeReason) session.threadCloseReason = closeReason;
      session.threadTranscriptChars = result.transcriptChars;
      return;
    }

    if (session.handoffDraft?.clearHandoff === true) {
      this.store.closeConversationThread?.(chatKey, 'handoff-cleared');
      return;
    }
    try {
      if (mode === 'threaded') {
        if (!session.sent.length || typeof this.store.upsertConversationThread !== 'function') return;
        const thread = this.store.upsertConversationThread(chatKey, {
          participantIds,
          topic: handoff?.topic || session.handoffDraft?.topic || '',
          lastMessageId,
          lastHumanAt,
          lastAgentAt: Date.now(),
          continuationWindowMs: conversation?.continuationWindowMs,
          ttlMs: conversation?.threadTtlMs
        });
        session.threadId = thread.threadId;
        session.threadState = thread.state;
        this.store.appendThreadCheckpoint(
          chatKey,
          thread.threadId,
          session.id,
          handoff || session.handoffDraft || {
            summary: `本轮已发送 ${session.sent.length} 条消息`,
            lastReply: lastSentText(session)
          },
          (triggerEntries || []).map((m) => m.id)
        );
      }
    } catch (error) {
      session.threadError = String(error?.message ?? error);
      log.warn(`[thread] ${chatKey} 保存线程状态失败:`, session.threadError);
    }
  }

  /**
   * 该回却没发时的补救：私聊 / 被 @ / 引用机器人 / 点名，模型只输出了正文（QQ 里看不到）。
   * 先做**一次**纠正请求（只给 send_message，避免重新执行别的操作），仍没发就发一条固定说明。
   * 发送结果不确定（outbox 可能已写出）时一律不动 —— 那种情况交人工核对，绝不补发。
   */
  async #ensureDirectedReply({
    session, messages, ctx, toolDefs, persona, kind, triggerEntries,
    proactive, manual, signal, runLimits, roundsExhausted
  }) {
    if (getConfig().conversation?.replyGuardEnabled === false) {
      session.replyCorrection = 'skipped';
      return;
    }
    if (proactive || manual) return;
    if (session.sent.length > 0 || session.visibleReply === true) return;
    if (!Array.isArray(triggerEntries) || !triggerEntries.length) {
      // 触发条目被另一轮 claim 走等场景会走到这里；此前静默 return，会话里
      // replyCorrection=null 与"没走到 guard"分不清（issue #64 附带的私聊现象）
      session.replyCorrection = 'skipped';
      log.warn(`[reply-guard] ${session.chatKey || kind || ''} 触发条目为空，跳过回复纠正`);
      return;
    }
    let directed = isDirectedAtBot({
      kind, triggerEntries, persona,
      selfId: this.onebot.selfId,
      accountNickname: this.onebot.selfNickname
    });
    if (!directed && session.triggerKind === 'keyword') {
      // 关键词命中是"必回"档（prompt.js 的 tier 2），名字边界判不出"在叫它"不代表不用回
      // （issue #64：两字昵称/名字前接汉字时名字判定失败，模型写好的正文被静默丢弃）。
      // 只在模型确实写出了正文草稿时纠正；「（这条不用接）」类自注和空内容仍保持沉默。
      const draft = [...messages].reverse().find((message) => message?.role === 'assistant');
      const draftText = String(draft?.content ?? '').trim();
      if (draftText && !/^[（(【\[]/.test(draftText)) directed = true;
    }
    if (!directed) return;
    if (this.store.hasUncertainEffects?.(session.leaseId)) {
      // 可能已经发出去了：补发会造成重复，交给人工核对
      session.replyCorrection = 'skipped';
      return;
    }

    const fallbackText = roundsExhausted
      ? '这条我还没处理完，稍后再试。'
      : '这条我暂时处理不了，稍后再试。';
    const sendTool = toolDefs.find((tool) => tool.name === 'send_message');
    // 预算：主循环是"已用 + 本次估算 > 上限"就停，所以这里也要把这次请求的体量算进去，
    // 否则会把主循环刚刚拒掉的那次调用原样再发一遍（2026-10-18 审查 P2）
    const lastPromptTokens = Number(session.callUsage?.at(-1)?.promptTokens)
      || Math.ceil((Number(session.inputEstimateChars) || 0) / 2)
      || 4000;
    const budgetLeft = (Number(session.usage?.totalTokens) || 0) + lastPromptTokens < runLimits.maxRunTokens;
    let sendFailed = false;

    if (sendTool && budgetLeft) {
      try {
        const response = await chatCompletionWithRetry({
          messages: [...messages, {
            role: 'user',
            content: '你上一轮把回答写成了正文，没有调用 send_message —— 用户在 QQ 里收不到这段文字。'
              + '请用 send_message 重新回答：能答就直接答；做不了（功能没启用、没有权限、没有这个工具）就简短说明原因。'
              + '不要重复执行其它工具，也不要解释这条系统提示。'
          }],
          tools: toOpenAiTools([sendTool]),
          signal,
          // 用 chat 的思考档位：'reply-correction' 不在 api.thinking 的映射表里，会退回 default（常常是思考开）
          purpose: 'chat'
        });
        addUsage(session.usage, response.usage);
        session.usage.calls += 1;
        session.replyCorrectionUsage = response.usage;
        // 与主循环同口径：兜底渠道换过端点时，成本记到实际渠道；per-call 台账也要有一行
        session.model = response.model || session.model;
        if (response.channelChanged && response.originBaseUrl) {
          session.vendor = vendorOfBaseUrl(getConfig(), response.originBaseUrl) || session.vendor;
        }
        session.callUsage ||= [];
        session.callUsage.push({
          round: (session.rounds || 0) + 1,
          promptTokens: Number(response.usage?.prompt_tokens) || 0,
          cachedTokens: 0,
          cacheHitRate: 0,
          completionTokens: Number(response.usage?.completion_tokens) || 0,
          totalTokens: Number(response.usage?.total_tokens) || 0,
          correction: true
        });
        const rawMessage = response.message || {};
        let calls = (Array.isArray(rawMessage.tool_calls) ? rawMessage.tool_calls : [])
          .filter((call) => call && typeof call === 'object')
          .map((call) => ({
            name: String(call.function?.name ?? ''),
            args: typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {})
          }));
        if (!calls.length && typeof rawMessage.content === 'string' && rawMessage.content) {
          // 少数模型把工具调用写成文本：只在明确是 send_message 时执行
          calls = parseInlineToolCalls(rawMessage.content)
            .filter((call) => call?.name === 'send_message')
            .map((call) => ({ name: 'send_message', args: JSON.stringify(call.args ?? {}) }));
        }
        for (const call of calls) {
          if (call.name !== 'send_message') continue;
          // 走与主循环同一个执行器：禁言预检、限频、outbox 记账全部复用。
          // 注意 send_message 对"整批失败"仍返回 ok（失败明细在正文里），所以以
          // session.sent 是否真的增加判定，而不是看 isError。
          const before = session.sent.length;
          const sentResult = await executeTool(toolDefs, ctx, 'send_message', call.args);
          if (session.sent.length === before) {
            // 只有"明确被拒"（禁言/限频）才放弃兜底；参数写错、目标非法这类失败仍要发固定说明，
            // 否则这条消息会一句回复都没有（2026-10-18 审查 P2）
            const reason = String(sentResult?.content || '');
            sendFailed = /禁言|限频|频率|太快|muted|rate.?limit/i.test(reason);
          }
          // 不 break：同一纠正响应里若有多条 send_message（模型没合成一个数组），后半句同样要发；
          // 主循环也是逐条执行，这里保持同一口径。
        }
      } catch (error) {
        if (signal?.aborted) return;
        log.warn(`[reply-guard] ${session.chatKey || ''} 纠正请求失败：${error?.message ?? error}`);
      }
    }

    if (session.sent.length > 0) {
      session.replyCorrection = 'corrected';
      session.finishReason ||= '该回未发，已自动纠正';
      log.info(`[reply-guard] ${session.chatKey || ''} 首轮未发送 → 已纠正并发出一条`);
      return;
    }
    if (sendFailed) {
      // 纠正轮的发送被明确拒绝（禁言/限频）：不再补发兜底，避免二次打扰或重复失败
      session.replyCorrection = 'failed';
      log.warn(`[reply-guard] ${session.chatKey || ''} 首轮未发送，纠正轮发送被拒（禁言/限频？）`);
      return;
    }
    // 纠正仍没发（或预算不足跳过）：发一条固定说明，绝不转发模型正文
    try {
      await executeTool(toolDefs, ctx, 'send_message', JSON.stringify({ messages: [fallbackText] }));
    } catch (error) {
      log.warn(`[reply-guard] ${session.chatKey || ''} 兜底发送异常：${error?.message ?? error}`);
    }
    if (session.sent.length > 0) {
      session.replyCorrection = 'fallback';
      session.finishReason ||= '该回未发，已发送兜底说明';
      log.info(`[reply-guard] ${session.chatKey || ''} 首轮未发送 → 已发送兜底说明`);
    } else {
      session.replyCorrection = 'failed';
      log.warn(`[reply-guard] ${session.chatKey || ''} 首轮未发送，兜底也失败（禁言/限频？）`);
    }
  }

  async #runAgent(session, {
    kind,
    chatId,
    chatKey,
    triggerEntries,
    proactive,
    wakeNote = '',
    paced = false,
    manual = false,
    seq,
    contextLimit = null,
    tierInfo = null,
    conversation = null,
    signal
  }) {
    const cfg = getConfig();
    // 本轮生效的人设：全局 persona + 这个群的覆盖（见 personas.resolvePersona）。
    // 一次解析、多处共用 —— 提示词、群内显示名、运行记录必须是同一份，
    // 否则会出现"提示词是猫娘、落款还是小鲸鱼"。
    const persona = resolvePersona(cfg, chatKey);
    // 人类化状态：有真实互动才轻微抬心情/掉精力；关闭时整条链路不碰。
    if (cfg.humanize?.enabled === true && triggerEntries?.length) {
      notePersonaInteraction(persona, { kind: 'incoming' });
      if (cfg.humanize?.relationship?.enabled !== false) {
        try {
          for (const userId of handoffParticipantIds(triggerEntries)) {
            this.memory.noteInteraction?.(userId, { at: Date.now() });
          }
        } catch { /* 关系记忆写盘失败不能打断本轮回复 */ }
      }
    }
    const conversationCfg = conversation || conversationConfigForChat(chatKey);
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const selfNickname = kind === 'group' ? (persona.selfNickname || this.onebot.selfNickname || persona.botName) : persona.botName;
    let thread = conversationCfg.mode !== 'legacy'
      ? this.store.getConversationThread?.(chatKey)
      : null;
    if (thread && thread.mode !== conversationCfg.mode) thread = null;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    // 直接查最新一条 self；活跃群 100 条窗口里可能已经没有自己，误判成“从没发过言”。
    const selfLastMessageAt = typeof this.store.lastSelfMessageAt === 'function'
      ? this.store.lastSelfMessageAt(chatKey)
      : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 表情包总开关：关掉时连动作类工具带清单一起摘（见下方 toolDefs 过滤，2026-10-02 用户反馈）
    const stickerEnabled = cfg.sticker?.enabled !== false;
    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (stickerEnabled) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }
    const slangContext = slangPilotEnabled(cfg)
      ? buildSlangContextForChat(chatKey, { max: 8 })
      : '';
    const incidentContext = this.getIncidentPilot()?.active
      ? this.getIncidentPilot().contextForChat(chatKey, this.store.getChatMeta(chatKey))
      : '';

    // 工具集按配置过滤：工具列表属于缓存前缀，必须先固定后再决定是否复用生命周期 transcript。
    // 口径收敛在 vision-scan.visionEnabled：只读 api.vision 会漏掉"模型不支持图片"那一半
    const canSeeImages = visionEnabled(cfg);
    // 「消息类型」页的两个细开关（默认开），叠加在"模型能不能看图"之上：
    // 关掉后对应工具必须一起摘掉 —— 提示词那边按同一判定收敛，两边漏一边就会出现
    // "教了但调不到"或"调得到却没教"，两种都白花一轮模型往返。
    const viewMessageImages = canSeeImages && cfg.messageTypes?.images !== false;
    const viewLibraryStickers = canSeeImages && cfg.messageTypes?.stickers !== false;
    const searchEnabled = cfg.webSearch?.enabled !== false;
    // ASR 有自己的开关与供应商（asr.enabled / asr.provider / asr.apiKey），与"联网搜索"解耦：
    // 关掉搜索的人不该顺带失去语音转写（2026-09-26 审查）。判定收敛在 config.asrAvailable()。
    const asrEnabled = asrAvailable(cfg);
    const identityPilot = this.getIdentityPilot();
    const identityAvailable = identityPilotEnabled(cfg) && identityPilot?.active === true;
    const friendProposalAvailable = identityAvailable && friendProposalEnabled() && promptFriendProposalEnabled(cfg);
    // 模型自安排唤醒的独立开关：关掉后连工具带提示词一起摘掉，
    // 否则模型还会去调一个"安排了也不会开口"的工具（生成一串假的"我到点再说"）。
    const selfWakeEnabled = cfg.proactive?.selfWakeEnabled !== false;
    // 图片生成按张计费：没开/没配就不注入工具，否则模型会去调一个必然失败的画图工具
    const imageGenEnabled = imageGenAvailable(cfg);
    // 每轮现建一份：工具描述里有随配置变化的文案（例如 get_message_images 会写"抽 4 帧"或
    // "视频画面看不到"）。构造函数里建一次的话，控制台改完设置（不重启）后提示词已经变了、
    // 工具描述还是旧的，模型会收到互相矛盾的两段（2026-10-17 审查 P2）。
    // 生活层没开：工具与提示词一起撤（与 schedule_wake / generate_image 同一口径）。
    // 开了但当前是"仅手动"或本群不在分享目标里：自动轮次同样撤掉，避免模型调用必然被拒的工具；
    // 控制台手动唤醒（manual）仍然放行 —— 那是管理员明确指定的一次分享。
    const lifeFeed = this.getLifeFeed?.();
    // 自主节奏（paced）唤醒虽然带着 manual:true 派发，但它不是人工触发：不能借这个标记
    // 绕过"仅手动"、分享目标群和分享额度。只有控制台手动唤醒才算 human。
    const humanShare = manual && !paced;
    const lifeFeedUsable = cfg.lifeFeed?.enabled === true
      && (humanShare || (lifeFeed?.shareMode?.() !== 'manual' && lifeFeed?.isShareTarget?.(chatKey) !== false));
    const toolDefs = buildToolDefs().filter((d) => {
      if (!viewMessageImages && d.name === 'get_message_images') return false;
      if (!viewLibraryStickers && d.name === 'get_sticker_image') return false;
      // 表情包总开关关掉：发送/列表/看图/收藏四个工具一并摘掉。原先只撤了提示词里的清单，
      // 工具还留着 —— 模型仍会发旧库里的表情，而【可用表情包】已被抽走、没有新选项，
      // 只能反复用记得的那一个（2026-10-02 用户反馈："不开那个按钮，它就一直发一个表情"）。
      // 与 schedule_wake / generate_image 是同一口径：开关关掉就连工具带提示词一起撤。
      if (!stickerEnabled && (d.name === 'send_sticker' || d.name === 'list_stickers'
        || d.name === 'get_sticker_image' || d.name === 'collect_sticker'
        || d.name === 'sticker_note')) return false;   // sticker_note 是第五个，别再漏（2026-10-03）
      // 收藏总闸关掉（表情包功能还开着）：只摘"主动收藏"这一个工具 —— 发送/列表/看图不受影响；
      // 留着的话模型会去调一个必然失败的收藏（还先白花一次看图判断，2026-10-02）。
      if (cfg.sticker?.collectEnabled === false && d.name === 'collect_sticker') return false;
      // 语音回复与提醒：提示词侧已按开关收敛（prompt.js 里 send_voice 只在 tts 开启时教、
      // remind 只在 reminders 开启时教），工具表却没跟上 —— 模型调过去必然失败，白花一轮
      // 模型往返（send_voice 的描述还极具诱导性）。与上面几项同一口径（2026-10-03 全量审查）。
      if (!ttsConfigured(cfg) && d.name === 'send_voice') return false;
      if (cfg.reminders?.enabled === false && d.name === 'remind') return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      if (!selfWakeEnabled && d.name === 'schedule_wake') return false;
      if (!lifeFeedUsable
        && (d.name === 'life_feed_next' || d.name === 'life_feed_feedback' || d.name === 'share_bilibili')) return false;
      // 群游戏引擎关掉：group_game 工具一并摘掉 —— 提示词侧（prompt.js 玩法与工具箱）
      // 只在开启时教"主持小游戏"，工具表却恒在，模型仍会去调一个必然报错的工具
      //（group-game.js 对 enabled=false 直接拒），白花一轮（2026-10-10 审查 D3）。
      if (cfg.groupGame?.enabled !== true && d.name === 'group_game') return false;
      // ASR 按量计费：开关关掉或没配 key 就不注入，避免模型调用必失败；也防误配置导致意外计费
      if (!asrEnabled && d.name === 'get_message_audio') return false;
      // 生图的唯一发送路径是"进表情库 → send_sticker"；表情包功能关掉时那条路也没了，
      // 留着它会真的花钱生成一张发不出去的图（2026-10-17 审查）
      if ((!imageGenEnabled || !stickerEnabled) && d.name === 'generate_image') return false;
      // 平台能力开关（2026-10-07 协议端 1.14.22 能力接入，控制台「平台能力」页）：
      // 关掉就连工具带提示词一起撤 —— 与"表情包/搜索/ASR"同一口径，
      // 留着只会让模型去调一个必然不可用的工具。映射表在 core/platform-gates.js（与测试共用一份）。
      // **带上 chatKey**：控制台可以按群覆盖（platform.perGroup），工具表与提示词必须同判。
      if (!platformToolAllowed(d.name, cfg.platform, chatKey)) return false;
      if (d.feature === 'identityPilot' && !identityAvailable) return false;
      if (d.feature === 'friendProposal' && !friendProposalAvailable) return false;
      if (d.feature === 'knowledge' && !knowledgeEnabled(cfg)) return false;
      if (d.feature === 'moderation') {
        const mod = cfg.moderation || {};
        if (mod.enabled === false) return false;
        const action = {
          set_group_ban: 'ban',
          kick_group_member: 'kick',
          recall_message: 'recall',
          set_group_admin: 'admin'
        }[d.name];
        if (action && mod.actions?.[action] === false) return false;
        const groups = idList(mod.groups);
        if (groups.length && !groups.includes(String(chatId))) return false;
      }
      return true;
    });
    // 插件工具：**不放进 buildToolDefs()**（那份是内置工具表，另有"每个工具都要有调度分类"
    // 的契约，见 test/experimental-tool-scheduler.test.mjs），而是每轮现取现追加。
    // 授权由注册表自己收口（总开关 / enabledIds / 进程状态 / manifest 声明，默认拒）——
    // 内置工具的默认是"放行"（platformToolAllowed 对未登记工具返回 true），插件绝不能沿用那个默认。
    const pluginToolDefs = this.getPlugins?.()?.toolDefsFor?.() ?? [];
    const mcpToolDefs = this.getMcp?.()?.toolDefsFor?.() ?? [];
    const builtinToolDefs = toolDefs;   // 前缀哈希用它（见下），插件/MCP 工具只按名字参与
    if (pluginToolDefs.length) toolDefs.push(...pluginToolDefs);
    if (mcpToolDefs.length) toolDefs.push(...mcpToolDefs);
    const openAiTools = toOpenAiTools(toolDefs);
    const baseSystemPrompt = buildSystemPrompt({
      // 按群生效的人设（缺省 = 全局）
      persona,
      // 与【此刻状态】用同一个名字（群名片优先），否则同一次请求里会出现两个"你在群里的名字"
      selfNickname,
      identityPilotAvailable: identityAvailable,
      friendProposalAvailable,
      // 表情清单与游戏状态是动态的：走 buildUserPrompt，不再进 system 前缀（Issue #86）。
      // 平台能力的"教不教"必须与上面工具表的"给不给"同判（含按群覆盖）：同一个 chatKey。
      platform: cfg.platform,
      chatKey
    });
    // 状态行放本轮 user 消息，不拼进 system prompt：system 前缀参与 cacheKey/线程续接判定，
    // 每半小时变一次会让前缀缓存和 lifecycle 线程反复失效。
    const personaStateLine = personaStatePrompt(persona);
    // 长期语义记忆属于每轮临时上下文：放入 user 内容而非 system 前缀，避免检索结果变化让
    // lifecycle 线程与前缀缓存失效。服务不可用时仅跳过召回，聊天主链路照常。
    let livingRecall = { text: '', entries: [], mode: 'disabled' };
    try {
      livingRecall = await this.livingMemory?.recall?.({ chatKey, triggerEntries, signal }) || livingRecall;
    } catch (error) {
      log.warn(`[living-memory] ${chatKey} 召回异常，已跳过：`, error?.message ?? error);
    }
    const triggerText = (triggerEntries || []).map((entry) => String(entry?.text || '')).join('\n');
    const humanLines = [
      personaStateLine,
      livingRecall.text,
      memeDensityPrompt(cfg),
      memesForPrompt(chatKey, triggerText, { level: cfg?.humanize?.memeUse?.level })
    ].filter(Boolean).join('\n\n');
    const systemPrompt = baseSystemPrompt;
    const promptPrefixHash = crypto.createHash('sha256')
      .update(String(cfg.api.provider || ''))
      .update('\0')
      .update(String(cfg.api.baseUrl || ''))
      .update('\0')
      .update(String(cfg.api.model || ''))
      .update('\0')
      .update(systemPrompt)
      .update('\0')
      // 前缀哈希：内置工具算完整 schema；插件工具**只算名字**（排序后）。
      // 插件跑起来/崩掉重启会让"当前有哪些插件工具"抖动，但工具集其实没变 ——
      // 那种抖动不该被当成"前缀变了"去关掉在途的对话线程（2026-10-15 复审 P3-3）。
      .update(JSON.stringify(toOpenAiTools(builtinToolDefs)))
      .update('\0')
      .update(pluginToolDefs.map((def) => def.name).sort().join(','))
      .update('\0')
      .update(mcpToolDefs.map((def) => def.name).sort().join(','))
      .digest('hex');

    let priorProviderMessages = [];
    if (conversationCfg.mode === 'lifecycle' && thread?.mode === 'lifecycle'
      && ['active', 'listening'].includes(thread.state)) {
      if (thread.promptHash && thread.promptHash !== promptPrefixHash) {
        this.store.closeConversationThread?.(chatKey, 'prompt-prefix-changed');
        thread = null;
      } else if (thread.promptTokens >= Math.min(
        500000,
        Math.max(5000, Number(conversationCfg.lifecycleRolloverInputTokens) || 32000)
      )) {
        const previousThreadId = thread.threadId;
        const previousPromptTokens = thread.promptTokens;
        this.store.armLifecycleRollover?.(
          chatKey,
          'input-token-budget',
          conversationCfg.rolloverArmedMs
        );
        thread = this.store.getConversationThread?.(chatKey);
        session.contextRollover = {
          reason: 'input-token-budget',
          previousThreadId,
          promptTokens: previousPromptTokens,
          threshold: Number(conversationCfg.lifecycleRolloverInputTokens) || 32000
        };
      } else {
        priorProviderMessages = this.store.getThreadTurns?.(thread.threadId) || [];
      }
    }
    const threadCheckpoint = conversationCfg.mode === 'lifecycle' && thread
      ? this.store.latestThreadCheckpoint?.(chatKey)
      : null;
    const lifecycleContinuation = priorProviderMessages.length > 0;

    // 首轮带完整上下文；生命周期后续轮只附加增量，旧消息保持字节级稳定以命中 DeepSeek 前缀缓存。
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      gameContext: this.getGames?.()?.summaryFor(chatKey) || '',
      slangContext,
      incidentContext,
      selfNickname,
      // 按群人设：点名标签与"刚换过卡"的提醒都用这个群生效的那份
      botName: persona.botName,
      personaChangedAt: Number(persona.changedAt) || 0,
      // 点名标签的文本兜底要用它认「@QQ号」与 CQ 码形态（存档里的 mentionsSelf 才是主判据）。
      // 取值与上面的档位判定保持一致，否则两处会对同一条消息给出不同判断。
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      manual,
      // 到点唤醒（定时提醒/自安排）与"控制台手动唤醒"在提示词里要说清区别：
      // paced 唤醒不能说成"管理员从控制台唤醒"（2026-10-10 复核）
      paced,
      contextLimit,
      tierInfo,
      thread,
      threadCheckpoint,
      conversationMode: conversationCfg.mode,
      lifecycleContinuation,
      session
    });

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length
      + JSON.stringify(priorProviderMessages).length;
    session.model = cfg.api.model;
    session.conversationMode = conversationCfg.mode;
    session.lifecycleContinuation = lifecycleContinuation;
    session.threadId = thread?.threadId || null;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    session.livingMemory = {
      mode: livingRecall.mode || 'disabled',
      recalled: Array.isArray(livingRecall.entries) ? livingRecall.entries.length : 0,
      ids: (livingRecall.entries || []).map((entry) => String(entry?.id || '')).filter(Boolean).slice(0, 12)
    };
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const privateChat = String(chatKey).startsWith('private:');
    const wakeLead = wakeNote
      ? (String(wakeNote).startsWith('【系统提醒】')
        ? safeSlice(String(wakeNote), 300)
        : `这是你自己之前安排的：${safeSlice(String(wakeNote), 300)}。现在时间到了，看看当前情况决定要不要说话。`)
      : (privateChat
        ? '（主动机会）私聊里已经安静了一会儿，你想起了对方。'
        : '（主动机会）群里已经安静了一会儿。');
    const selfWakeOn = cfg.proactive?.selfWakeEnabled !== false;
    // 600 而不是 200：定时提醒合并派发时 note 可能有多条（单条正文上限 200），
    // 这里截到 200 会把第二条整体截掉，而它们已经被 markFired（2026-09-29 审查 P2）
    // 定时提醒（【定时提醒】标记）是"别人托的承诺"，不能套"你给自己留过话"的自留话框架 ——
    // 此前两者混在同一条分支里，模型收到"你自己留的 + 有人让你"的矛盾信号，会自己圆归属
    //（2026-10-10 用户反馈：把别人托的提醒说成被提醒人自己设的）。提醒走逐字 + 简短收尾。
    const isReminderNote = String(wakeNote).startsWith('【定时提醒】');
    const pacedLead = (wakeNote
      ? (isReminderNote
        ? `${safeSlice(String(wakeNote), 600)}\n`
        : `你之前给自己留过话：${safeSlice(String(wakeNote), 600)}\n`)
      : '')
      + (isReminderNote
        ? '把提醒自然地说出来即可；说完就结束，不用给自己安排下一次唤醒。'
        : '这些消息是攒着等你按自己的节奏来看的。决定要不要说话、说什么；不想接就安静结束'
          + (selfWakeOn
            ? '，并用 schedule_wake 给自己安排下一次醒来的时间（比如几分钟后、或二三十分钟后）。'
            : '。（自安排唤醒已关闭，不用安排下次唤醒，系统会按配置的节奏再唤醒你。）'));
    const proactiveVariety = '先看【过去状态】里你自己最近几次主动发言：不要重复它们的主题、开头或时间点'
      + '（刚说过“群里没人/几点了/吃饭”，这次就换一个来源）。可以换：群友最近提过的事、你刚看到的具体东西、'
      + '一个具体问题、自己的怪念头；每次只选一个。没有新东西就安静。';
    const wakeTail = String(wakeNote).startsWith('【系统提醒】')
      ? '就按上面那条提醒处理：想补就补一句很短的，补完就放下；不想补就安静结束。'
      : (privateChat
        ? '你可以主动找个由头说一句（分享点见闻、接着上次的话题、或单纯问候一下），也可以判断现在不该打扰就安静结束。'
          + proactiveVariety
          + (lifeFeedUsable
            ? '想分享点具体的见闻，可以调用 life_feed_next 看看队列里有什么。' : '')
        : '你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。'
          + proactiveVariety
          + (lifeFeedUsable
            ? '今天想分享点见闻的话，可以调用 life_feed_next 看看队列里有什么。' : ''));
    // 手动唤醒（控制台「见闻→分享」、手动触发）也可能带 wakeNote；此前只有 paced 分支
    // 使用 note，manual 的提醒被丢掉，用户点了分享却什么都没发生。
    const manualNote = manual && wakeNote
      ? (isReminderNote || String(wakeNote).startsWith('【系统提醒】')
        ? safeSlice(String(wakeNote), 600)
        : `这是你自己之前安排的：${safeSlice(String(wakeNote), 600)}。`)
      : '';
    const currentUserMessage = {
      role: 'user',
      content: (humanLines ? `${humanLines}\n\n` : '') + (proactive && !manual
        ? `${userPrompt}\n\n【本次唤醒】${wakeLead}${wakeTail}`
        : (paced
          ? `${userPrompt}\n\n【本次唤醒】${pacedLead}`
          : (manualNote
            ? `${userPrompt}\n\n【本次唤醒】${manualNote}`
              + (String(wakeNote).startsWith('【系统提醒】') ? `\n${wakeTail}` : '')
            : userPrompt)))
    };
    const messages = [
      { role: 'system', content: systemPrompt },
      ...structuredClone(priorProviderMessages),
      currentUserMessage
    ];
    const transcriptStart = 1 + priorProviderMessages.length;
    session.injectedMessages = modelMessagesForAudit(priorProviderMessages);
    session.injectedMessageChars = JSON.stringify(priorProviderMessages).length;
    session.inputTools = structuredClone(openAiTools);
    session.inputRequestOptions = {
      toolChoice: 'auto',
      temperature: cfg.api.temperature ?? 0.8
    };

    session.promptLayout = lifecycleContinuation
      ? 'deepseek-lifecycle-append-v1'
      : 'stable-prefix-v2';
    session.promptPrefixHash = promptPrefixHash;

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: persona.botName,
      behaviorProfile: persona.behaviorProfile || 'legacy',
      voice: voiceForPersona(persona),
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      identityPilot,
      stickers: this.stickers,
      sender: this.sender,
      session,
      // 自主节奏（paced）也会带 manual:true 派发；工具侧必须能区分“管理员手动”与“到点自动”。
      paced,
      // 动作冷却跨轮：session 每次运行都新建，冷却时间不能只存在 session 上。
      actionMemory: this.actionMemory,
      signal,
      emit: (type, payload) => this.emit(type, payload),
      // 让模型能给自己安排一次稍后的主动发言
      scheduleWake: (delayMs, note) => this.scheduleInitiativeWake(chatKey, delayMs, note),
      // 定时提醒（remind 工具）：持久化的"给别人的承诺"，到点走主动唤醒
      reminders: this.reminders,
      // 出站副作用账本：直连协议端的写工具用它登记（只记录，不拦截正常调用）
      effects: this.effects,
      // 本轮触发消息（remind 的 from 兜底要判断"是否只有一个发送者"；只带最小字段）
      triggerEntries: (triggerEntries || []).map((m) => ({
        senderId: m?.senderId || '', senderName: m?.senderName || '', self: Boolean(m?.self),
        // 群管理授权要核对管理员这句到底说了什么；只留文本片段，不带媒体/原始段。
        text: safeSlice(String(m?.text || ''), 300)
      })),
      // 群游戏（group_game 工具）：进行中的局由管理器负责推进与判定
      games: this.getGames?.() || null,
      // 生活层（见闻）：候选队列由宿主管理；工具只取/回写，不直接发消息
      getLifeFeed: () => this.getLifeFeed?.() || null
    };

    // 省 Token 模式：轮数与单次运行预算夹上限（关闭时与升级前逐字一致）
    const runLimits = effectiveRunLimits(cfg);
    const maxRounds = runLimits.maxRounds;
    let finish = false;
    let completed = false;
    // 发送动作跨模型轮次失败时仍要阻止“只总结、不回复”的 finish；有任何内容送达后解除。
    let unsentDeliveryFailure = false;
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      signal.throwIfAborted();
      if (this.aborted || !canRun(chatKey)) throw new Error('Run cancelled');
      const maxRunTokens = runLimits.maxRunTokens;
      const requestPayloadChars = JSON.stringify({
        messages,
        tools: openAiTools
      }).length;
      const previousCall = session.callUsage?.at(-1);
      const estimate = estimateNextPromptTokens({
        messages,
        tools: openAiTools,
        previousPromptTokens: Number(previousCall?.promptTokens) || 0,
        previousEstimateChars: Number(session.inputEstimateChars) || 0,
        previousImageCount: Number(session.inputImageCount) || 0
      });
      const {
        estimatedPromptTokens,
        estimateChars: requestEstimateChars,
        imageCount: requestImageCount,
        auditMessages: requestAuditMessages
      } = estimate;
      const outputReserveTokens = 2048;
      // 预算检查要放过第一轮：估算只是"字符数折算"的粗估，一个繁忙会话的
      // 已读历史 + 触发批就能把估算顶到预算线以上 —— 若在 round 0 就 break，
      // 这批消息会被 ack 掉、一次模型都没调、也不会重试（用户永远等不到回复）。
      if (round > 0 && session.usage.totalTokens + estimatedPromptTokens + outputReserveTokens > maxRunTokens) {
        session.budgetStopped = true;
        session.budgetStopReason = 'next-call-budget';
        session.estimatedNextPromptTokens = estimatedPromptTokens;
        session.finishReason ||= session.sent.length
          ? '已发送内容，因本轮 Token 预算不足安全结束'
          : '本轮 Token 预算不足，已安全结束';
        completed = true;
        break;
      }
      session.inputRound = round + 1;
      session.inputPayloadChars = requestPayloadChars;
      session.inputEstimateChars = requestEstimateChars;
      session.inputImageCount = requestImageCount;
      session.tokenEstimator = 'audit-chars-plus-image-reserve-v2';
      session.inputHasOmittedImages = hasInlineImage(messages);
      session.inputMessages = requestAuditMessages;
      markActivity('正在思考…');
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      const response = await chatCompletionWithRetry({
        messages,
        tools: openAiTools,
        signal,
        cacheKey: `qq-agent:${promptPrefixHash.slice(0, 32)}`,
        purpose: 'chat'
      });
      signal.throwIfAborted();
      session.model = response.model || session.model;
      // 2026-10-06 复审 P3：兜底模型接管且端点真的换了渠道时，成本要记到实际渠道名下
      //（model-prices 的约定就是"会话用它自己记录的 vendor"）—— 否则渠道价/渠道价目表
      // 会按主渠道单价给兜底模型计价，而渠道价目表可自动注入，错价路径生产可达。
      if (response.channelChanged && response.originBaseUrl) {
        session.vendor = vendorOfBaseUrl(getConfig(), response.originBaseUrl) || session.vendor;
      }
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;
      const promptTokens = Number(response.usage?.prompt_tokens) || 0;
      const cachedTokens = Number(
        response.usage?.prompt_tokens_details?.cached_tokens
        ?? response.usage?.prompt_cache_hit_tokens
        ?? response.usage?.cached_tokens
      ) || 0;
      session.callUsage ||= [];
      session.callUsage.push({
        round: round + 1,
        promptTokens,
        cachedTokens: Math.min(promptTokens, cachedTokens),
        cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
        completionTokens: Number(response.usage?.completion_tokens) || 0,
        totalTokens: Number(response.usage?.total_tokens) || 0
      });

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const reasoningContent = typeof msg.reasoning_content === 'string'
        ? msg.reasoning_content
        : null;
      // 2026-10-06 复审 P2：部分网关/自部署推理服务返回的 tool_calls 形态不规整（缺 id、
      // 非数组、null 项）。缺 id 的 tool 消息下一轮会被多数 OpenAI 兼容端点整请求 400 拒掉，
      // isRetryableError 判 false → 批次转人工、被 @ 的消息当场无人回。与 inline 路径自造
      // inline_${round}_${i} 同口径：进 messages 前先归一化 —— 补 id、补 type、参数字符串化
      //（id 要同步落在 providerAssistant.tool_calls 上，保证 assistant/tool 配对一致）。
      const normalizedToolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
        .filter((c) => c && typeof c === 'object')
        .map((c, i) => ({
          ...c,
          id: c.id || `toolcall_${round}_${i}`,
          type: c.type || 'function',
          function: {
            name: String(c.function?.name ?? ''),
            arguments: typeof c.function?.arguments === 'string'
              ? c.function.arguments
              : JSON.stringify(c.function?.arguments ?? {})
          }
        }));
      const finalToolCalls = normalizedToolCalls.length ? normalizedToolCalls : undefined;
      const providerAssistant = {
        role: 'assistant',
        content: finalContent,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(finalToolCalls ? { tool_calls: finalToolCalls } : {})
      };
      const assistantEntry = {
        ...providerAssistant,
        raw: response.raw ?? null
      };
      messages.push(providerAssistant);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = normalizedToolCalls;
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        completed = true;
        break;
      }

      // finish 是终止标记，必须最后执行：模型偶尔会把它排在 send_message 前面，
      // 若按原顺序执行，finish 先成功 → 外层的 !finish 立刻退出循环，后面的 send_message
      // 即便被屏障拒绝也没有下一轮让模型补发，消息就静默丢了（复审 P1）。
      if (toolCalls.length > 1) {
        const ordered = [
          ...toolCalls.filter((call) => call?.function?.name !== 'finish'),
          ...toolCalls.filter((call) => call?.function?.name === 'finish')
        ];
        if (ordered.some((call, index) => call !== toolCalls[index])) {
          toolCalls = ordered;
          const lastAssistant = messages[messages.length - 1];
          if (lastAssistant?.role === 'assistant') lastAssistant.tool_calls = toolCalls;
          const live = this.sessions.current.get(session.id);
          const liveLast = live?.messages?.[live.messages.length - 1];
          if (liveLast?.role === 'assistant') liveLast.tool_calls = structuredClone(toolCalls);
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
        }
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 只在"同一批 tool_calls"内有效：上一批的失败不挡下一批（模型可能已经在新一批里修正了）。
      let priorFailure = false;
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      for (const call of toolCalls) {
        signal.throwIfAborted();
        if (!canRun(chatKey)) throw new Error('Run cancelled');
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        // 技能白名单只收窄本轮工具；finish/skill_list/skill_use 在 skill_use 时已加入集合。
        // send_message 永远放行：模型可能只是想“看看有哪些技能，然后正常回一句”；
        // 不能因为列过一次技能就把正常回复也堵死。
        const skillGate = skillGateMessage(ctx.activeSkill, ctx.pendingSkillUse, name, safeParse(argsRaw));
        const blocked = finishBarrierBlock(name, {
          finished: finish,
          priorFailure,
          unsentDeliveryFailure: unsentDeliveryFailure && session.sent.length === 0 && session.visibleReply !== true
        }) || skillGate;
        const result = blocked
          ? { content: blocked, isError: true, reportIncident: false, skillBlocked: Boolean(skillGate) }
          : await executeTool(toolDefs, ctx, name, argsRaw);
        if (
          result.isError
          && result.incidentCaptured !== true
          && result.reportIncident !== false
        ) {
          // 工具报错也写一行 journal（Issue #17 反馈：只进控制台异常面板、journal 里查不到，
          // 排查时容易漏）。同一判定口径：reportIncident:false 的工具照旧不刷。
          // 脱敏走 incident-pilot 同款规则——错误串里可能带上 URL 查询串里的 access_token。
          log.warn(`[tool] ${name} 出错：${redactText(String(result.content || '工具执行失败').replace(/\s+/g, ' '), 160)}`);
          this.getIncidentPilot()?.capture(new Error(String(result.content || '工具执行失败')), {
            source: `tool:${name}`,
            category: 'tool',
            severity: 'warning',
            chatKey,
            sessionId: session.id,
            details: { tool: name }
          });
        }
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({
          toolCall: {
            name,
            args: result.parsedArgs ?? safeParse(argsRaw),
            result: safeSlice(contentStr, 2000),
            isError: !!result.isError,
            ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            ...(result.argumentsRepaired ? { argumentsRepaired: true } : {})
          }
        });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (this.store.hasUncertainEffects(session.leaseId)) {
          throw new Error('Delivery uncertain; batch held for operator review');
        }
        // 部分发送失败（sendTextBatch 有 failed 但至少一条成功）不算 isError，
        // 但同样不能把 finish 提交掉，否则失败的那几条永远没有下一轮补发（复审 P1）。
        // 技能白名单拦截不是"工具坏了"：不让它把 finish 屏障也一起触发，否则模型被挡住一次
        // 就再也收不了尾。真正的工具失败仍然照旧挡 finish。
        if ((result.isError && result.skillBlocked !== true) || result.partialFailure === true) priorFailure = true;
        if (name === 'send_sticker'
          && result.isError
          && (result.errorCode === 'action-cooldown' || /这个动作刚刚用过/.test(contentStr))
          && session.sent.length === 0
          && session.visibleReply !== true) {
          // 表情被冷却拦下且本轮还什么都没有送到：拦住"只 finish 不回复"（PR #65）。
          // visibleReply（拍一拍/点赞/传相册等）已算"回过"，不必再逼一条文字。
          unsentDeliveryFailure = true;
        }
        if (name === 'finish' && !result.isError) finish = true;
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    signal.throwIfAborted();
    // 该回却没发：只有正文、没有 send_message（QQ 里看不到）。一次纠正 + 固定兜底。
    // 放在轮数判定之前：跑满轮数且一条没发，同样属于"该回未发"，兜底文案会区分这两种原因。
    await this.#ensureDirectedReply({
      session, messages, ctx, toolDefs, persona, kind, triggerEntries,
      proactive, manual, signal, runLimits,
      roundsExhausted: !finish && !completed
    });
    // 轮次用尽是"干不完活"的护栏，不是"需要人工核对"的故障：与 token 预算同口径，
    // 当作本轮正常收尾（已经说的话照常发出、消息正常 ack），并在会话里标注原因。
    // 不能标成可重试去重跑整轮：一条跑满 maxRounds 的会话重跑同样会跑满，成本放大且无解。
    if (!finish && !completed) {
      completed = true;
      session.roundBudgetStopped = true;
      session.finishReason ||= session.sent.length
        ? '已发送内容，因本轮模型轮数用尽安全结束'
        : '本轮模型轮数用尽，已安全结束';
    }
    const providerTranscriptDelta = conversationCfg.mode === 'lifecycle'
      ? structuredClone(messages.slice(transcriptStart))
      : [];
    // 普通 assistant 文本不会发到 QQ，它只是本次运行的内部输出。下一生命周期轮次
    // 不应把它伪装成机器人曾经说过的话；移除后仍能完整命中上一请求的输入边界。
    const tail = providerTranscriptDelta.at(-1);
    const terminalReasoning = tail?.role === 'assistant' && !tail.tool_calls?.length
      ? tail.reasoning_content
      : '';
    if (tail?.role === 'assistant' && !tail.tool_calls?.length) providerTranscriptDelta.pop();
    providerTranscriptDelta.push({
      role: 'assistant',
      content: session.sent.length
        ? lastSentText(session)
        : '（本轮未向 QQ 发送消息）',
      ...(terminalReasoning ? { reasoning_content: terminalReasoning } : {})
    });
    const containsInlineImage = hasInlineImage(providerTranscriptDelta);
    return {
      providerTranscriptDelta: containsInlineImage ? [] : providerTranscriptDelta,
      forceThreadRollover: containsInlineImage ? 'multimodal-context' : ''
    };
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  // ── 模型自主安排的稍后发言 ──────────────────────────────────────────────
  // 与 proactive 定时器不同：这是模型自己决定"过一会儿再来看看"，
  // 到点后按主动机会唤醒，并把模型当时留下的想法一起注入。
  startScheduledWakeTicker() {
    if (this.scheduledWakeTicker) return;
    this.scheduledWakeTicker = setInterval(() => {
      // 不空吞：这条链路会碰 sqlite（SQLITE_BUSY/库锁）——静默抛每 30 秒一次，运维从日志里
      // 看不出"机器人不说话了"和"本来就没到点"的区别（2026-10-03 全量审查）。
      try { this.fireDueScheduledWakes(); }
      catch (error) { log.error('[wake] 自安排唤醒调度出错（不影响下一轮）:', error?.message ?? error); }
    }, 30000);
    if (this.scheduledWakeTicker.unref) this.scheduledWakeTicker.unref();
  }

  fireDueScheduledWakes() {
    const now = Date.now();
    const cfgNow = getConfig();
    for (const [chatKey, item] of [...this.scheduledWakes.entries()]) {
      if (!item || item.at > now) continue;
      const kind = item.kind || (item.paced ? 'paced' : 'selfWake');
      // 开关关掉后，已经排上队的主动开口一并作废（不然关了开关旧的安排还会冒出来一次）
      const blocked = (kind === 'followUp' && cfgNow.proactive?.followUpEnabled === false)
        || (kind === 'selfWake' && cfgNow.proactive?.selfWakeEnabled === false);
      this.scheduledWakes.delete(chatKey);
      if (item.timer) clearTimeout(item.timer);
      if (blocked) {
        log.info(`[wake] ${chatKey} 跳过：${kind === 'followUp' ? '补话' : '自安排唤醒'}开关已关闭，这次安排作废`);
        continue;
      }
      // 会话被移出允许列表（allow.groups/private 改动）后不该再唤醒：显式作废并记日志，
      // 不能放任它走到 #wake 被 canRun 静默拒掉 —— 那时安排已删、留言无声消失（2026-10-12 审查）。
      // 与静默时段不同：白名单不会自己恢复，顺延只会无限重排，所以直接作废。
      if (!item.paced && !chatAllowed(chatKey)) {
        log.info(`[wake] ${chatKey} 不在允许列表里，这次唤醒作废（留言不再保留）：${String(item.note || '').slice(0, 60)}`);
        continue;
      }
      // 时间/模式维（2026-10-10 补，与 fireDueReminders 同款）：#wakePreflight 的 canRun 会
      // 静默拒掉这次唤醒而安排已删 —— 静默段顺延到窗口恢复（留言原样保留）；观察模式无法
      // 兑现，作废并记日志，避免留下每分钟重排的空转。
      if (this.#wakeTimeBlocked(chatKey)) {
        if (getConfig().runtime?.mode !== 'active') {
          log.info(`[wake] ${chatKey} 观察模式下自安排唤醒无法兑现，留言作废（切回 active 后可重新安排）`);
          continue;
        }
        const wait = timeUntilActive(chatKey);
        const at = Date.now() + Math.min(Math.max(wait, 60 * 1000), 24 * 60 * 60 * 1000);
        const timer = setTimeout(() => { try { this.fireDueScheduledWakes(); } catch { /* 忽略 */ } }, (at - Date.now()) + 50);
        if (timer.unref) timer.unref();
        this.scheduledWakes.set(chatKey, { ...item, at, timer });
        continue;
      }
      // 任何主动唤醒（冷场、自安排、补话）到点时如果已经有未读：让普通回复链路接管，
      // 不能再按"主动开口"跑一轮 —— 否则同一批消息可能先被主动轮次回了，drain 又回一次。
      if (!item.paced && this.store.unreadCount(chatKey) > 0) {
        const pending = this.store.peekUnread(chatKey, this.#unreadScanLimit()) || [];
        const direct = chatKey.startsWith('private:')
          || pending.some((m) => mentionsOrPokesBot(m, this.onebot.selfId));
        const directDelay = Math.max(0, Math.min(2000, Number(cfgNow.directWakeDelayMs) || 300));
        log.info(`[wake] ${chatKey} 已有未读，主动唤醒改为普通回复`);
        this.scheduleWake(chatKey, direct ? directDelay : null, { direct });
        continue;
      }
      if (!item.paced) {
        const window = proactiveWindowState(cfgNow.proactive?.activeHours, now);
        if (!window.active) {
          // 静默时段不主动开口：顺延到下一个活跃窗口
          this.scheduleInitiativeWake(chatKey, Math.max(60000, window.nextActiveAt - now + 1000), item.note, { kind });
          continue;
        }
      }
      // 到点但会话现在接不了这次唤醒（在跑 / 被阻塞 / 并发满 / 没配模型）：#wake 在这些分支上是
      // **静默 return**，而上面已经把安排删掉了 —— 模型给自己留的那句"我过会儿回来看"就永久消失
      // （与定时提醒同一类静默丢失，2026-09-29 审查）。顺延一轮再试，而不是丢掉。
      // paced 不在此列：它每次运行结束都会由 #ensurePacedWake 重新排，不需要这里兜。
      // 不走 scheduleInitiativeWake 重排：那个函数按默认 noteLimit(200) 截断留言，这里原样保留。
      // 只有 block 会让 proactive 唤醒也静默 return；degrade 只挡非 proactive（私聊/主动
      // 唤醒照常），不能把它一起顺延 24 小时，否则"过会儿回来看"的留言会被无谓压一天。
      const budgetDrop = !item.paced && this.#budgetHardBlock();
      if (!item.paced && (budgetDrop || this.#wakeBlockedNow(chatKey, cfgNow))) {
        const delay = budgetDrop ? 24 * 60 * 60 * 1000 : WAKE_RETRY_MS;
        const timer = setTimeout(() => { try { this.fireDueScheduledWakes(); } catch { /* 忽略 */ } }, delay + 50);
        if (timer.unref) timer.unref();
        this.scheduledWakes.set(chatKey, { ...item, at: Date.now() + delay, timer });
        if (budgetDrop) log.info(`[wake] ${chatKey} 预算闸门会丢掉这次主动唤醒，顺延 24 小时（留言保留）`);
        continue;
      }
      this.wake(chatKey, item.paced
        ? { manual: true, paced: true, wakeNote: item.note }
        : { proactive: true, wakeNote: item.note })
        .catch((error) => log.error('[orchestrator] 自主唤醒出错:', error));
    }
  }

  /**
   * 这一轮 #wake 会不会因为"接不了"而静默丢弃（在跑 / 被暂停 / 被阻塞 / 并发满 / 没配模型）。
   * 主动派发（提醒、自安排唤醒）都必须在**派发前**问一次，否则会先标记完成/先删安排、
   * 再被 #wake 静默吞掉（2026-09-29 审查：同一模式在两处各犯过一次）。
   */
  #wakeBlockedNow(chatKey, cfg = getConfig()) {
    if (this.aborted || this.paused) return true;
    if (this.runningChats.has(chatKey)) return true;
    if (!this.#chatRuntimeDecision(chatKey).allowed) return true;
    if (!String(cfg.api?.model || '').trim()) return true;
    return this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2);
  }

  // 派发预检的时间/模式维：#wakePreflight 的 canRun（src/core/access.js）还含
  // runtime.mode==='active' 与 isTimeActive —— 预算维 2026-10-04 已对齐，时间/模式维
  // 2026-10-10 补上同款：漏了就会出现"先 markFired/销毁安排、唤醒却被 canRun 静默拒掉"。
  #wakeTimeBlocked(chatKey) {
    if (getConfig().runtime?.mode !== 'active') return true;   // observe：派不出去
    return !isTimeActive(chatKey);
  }

  /** 安排一次稍后的主动发言（模型调用 schedule_wake / 补话 / 自主节奏唤醒共用）。 */
  scheduleInitiativeWake(chatKey, delayMs, note = '', { paced = false, kind = '', noteLimit = 200 } = {}) {
    const minMs = 60 * 1000;
    const maxMs = 4 * 60 * 60 * 1000;
    const wait = Math.max(minMs, Math.min(Number(delayMs) || minMs, maxMs));
    const at = Date.now() + wait;
    const prev = this.scheduledWakes.get(chatKey);
    if (prev?.timer) clearTimeout(prev.timer);
    const timer = setTimeout(() => { try { this.fireDueScheduledWakes(); } catch { /* 忽略 */ } }, wait + 50);
    if (timer.unref) timer.unref();
    // kind 只用于派发时按开关作废（followUp=补话 / selfWake=模型自安排 / paced=自主节奏），不进提示词
    const label = kind || (paced ? 'paced' : 'selfWake');
    this.scheduledWakes.set(chatKey, { at, note: safeSlice(String(note || ''), noteLimit), timer, paced, kind: label });
    return at;
  }

  /** 定时提醒循环：到期 → 用主动唤醒让模型把提醒说出来（重启后由落盘数据继续）。 */
  startReminderLoop() {
    if (this.reminderTimer) return;
    const tick = () => {
      try { this.fireDueReminders(); } catch (error) { log.error('[reminder] 派发出错（不影响下一轮）:', error?.message ?? error); }
    };
    tick();
    this.reminderTimer = setInterval(tick, 30000);
    if (this.reminderTimer.unref) this.reminderTimer.unref();
  }

  stopReminderLoop() {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    this.reminderTimer = null;
  }

  fireDueReminders() {
    if (!this.reminders) return;
    // 控制台开关（设置 → 定时提醒）：关掉后不派发，已存数据保留，重新打开继续用
    if (getConfig().reminders?.enabled === false) return;
    const now = Date.now();
    // 离线太久（迟到 >12 小时）的直接作废：不补发一串"迟到的提醒"。
    // 周期项例外：作废整条会让"每天 9 点吃药"永久消失，改为跳过这一期、re-arm 到下一次
    //（2026-10-31 盲审 P2；暂停/held 超过 12 小时也会走到这里）。
    for (const item of this.reminders.expired(now)) {
      if (item.repeat && typeof item.repeat === 'object') {
        this.reminders.skipOccurrence(item.id, now);
        log.info(`[reminder] 周期提醒错过一期，已跳到下一次：${item.chatKey} ${String(item.text).slice(0, 30)}`);
        continue;
      }
      this.reminders.markExpired(item.id, now);
      log.info(`[reminder] 过期作废（迟到超过 12 小时）：${item.chatKey} ${String(item.text).slice(0, 30)}`);
    }
    // 同一会话多条同时到期：**合并成一条 note 只排一次唤醒** —— scheduledWakes 每会话单槽，
    // 逐条排会互相覆盖：先排的被顶掉，却已经标记 fired，内容就永久丢了（2026-09-28 审查 P2）。
    const byChat = new Map();
    for (const item of this.reminders.due(now)) {
      if (this.aborted) continue;
      if (this.#remindersInFlight.has(item.id)) continue;
      if (!canRun(item.chatKey)) {
        // canRun 含 isTimeActive 与 runtime.mode（access.js）：静默段/观察模式下派不出去。
        // 这里必须顺延而不是干等 —— 干等的话，持续静默超过 12 小时会被上面的 expired()
        // 静默作废（deferTo 重置作废时钟；2026-10-10 审查）。白名单被清空等其它原因不值得
        // 动到点时间，保持原样每 tick 重试。只在"新到点时间确实更晚"时才写，避免每 tick 落盘。
        if (this.#wakeTimeBlocked(item.chatKey)) {
          const wait = timeUntilActive(item.chatKey);
          const later = now + (wait > 0 ? Math.min(wait, 24 * 60 * 60 * 1000) : 30 * 60 * 1000);
          if (later > item.at + 60 * 1000) this.reminders.deferTo(item.id, later);
        }
        continue;
      }
      if (!byChat.has(item.chatKey)) byChat.set(item.chatKey, []);
      byChat.get(item.chatKey).push(item);
    }
    for (const [chatKey, items] of byChat) {
      // 一次只合并"能完整写进 note"的条目：note 在 #wake 里被 safeSlice(…, 600) 截断，
      // 而下面会对合并进来的每一条 markFired。无限合并（单条正文 200 字 × 每会话最多 10 条）
      // 会让第 4 条起的内容被截掉却照样标记已触发 —— 内容永久丢失（2026-09-29 审查 P1）。
      // 第一条无论如何都进（否则会永远卡在同一条上）；放不下的留到下一轮 tick 继续。
      // 预算口径在 reminderNoteCost（正文 + 归属名 + 引号/分隔开销），与 note 截断同一口径。
      const chosen = [];
      let bodyChars = 0;
      for (const item of items) {
        const cost = reminderNoteCost(item);
        if (chosen.length && bodyChars + cost > REMINDER_NOTE_BODY_MAX) break;
        chosen.push(item);
        bodyChars += cost;
      }
      // 派发话术的唯一真源在 reminders.buildReminderNote（含"谁提的/提醒谁"的归属）
      // **直接唤醒**，不走 scheduledWakes：那是"每会话单槽"，两批提醒只要落在相邻 tick
      // （30 秒一轮）就会互相顶掉——先被顶掉的那批已经标记 fired，内容永久丢失。
      // 2026-09-28 服务器实测：相隔 5 秒的两条提醒，第一条"喝水"从未发出。
      // manual+paced 与原先 paced:true 的派发形态一致：不按概率跳过、也不受活跃时段顺延。
      //
      // 派发前同步预检 #wake 的"静默空转"闸门（会话在跑 / 会话被阻塞 / 并发满 / 无模型，
      // 判据统一在 #wakeBlockedNow 里，与自安排唤醒共用）+ 该会话已有未过期租约：
      // 这些判断在 #wake 里也是同步做的，这里不满足就**本轮不派发、不 markFired**，
      // 留在 due() 里 30 秒后再试 —— 否则提醒被标成已发却永远没人说（2026-09-29 审查 P1）。
      // 最后那条租约闸门对应 #wake 里 claimUnread 取不到租约的静默 return：
      // 硬崩溃（kill -9/OOM）会留下 runs.state='leased' 的残行，recoverExpired 最多 5 秒后回收。
      const budgetDrop = this.#budgetWouldDrop(chatKey);
      const dispatchable = !this.#wakeBlockedNow(chatKey)
        && !this.store.hasLeasedRun(chatKey)
        && !budgetDrop;
      if (!dispatchable) {
        // ⚠️ 只有"预算会丢"这一类才顺延（瞬时的在跑/断线不值得动到点时间）：
        // 上面注释说"明天预算重置后自然补发"，但 reminders 的 expired() 对迟到满
        // 12 小时的条目会静默作废 —— 持续超预算一整天，到点的提醒照样丢。
        // 显式把到点时间顺延 24 小时（作废窗口 12 小时 → 充分错开），
        // deferTo 只改 at、不动 status，作废时钟随新 at 重新起算（2026-10-04 复审 P2）。
        if (budgetDrop) {
          const later = Date.now() + 24 * 60 * 60 * 1000;
          for (const it of chosen) this.reminders.deferTo(it.id, later);
          log.info(`[reminder] 预算超限，${chosen.length} 条顺延 24 小时后补发`);
        }
        continue;
      }
      // 账本（docs/EFFECT-LEDGER.md）：每条提醒按「提醒 id + 计划触发时刻」幂等。
      //   done      → 上一条命已经播报过，直接 markFired，不再唤醒（崩溃/重启不重复提醒）
      //   review    → 上次结果未知，停止自动重试，等人工核对
      //   in-flight → 同一进程正在处理，本轮跳过
      // 这三类都不进 note：已经发过/不打算再发的正文不能再喂给模型，否则它会再说一遍。
      const batch = [];
      for (const it of chosen) {
        // 幂等键用 occurrenceId，不能用 at：at 会被 deferTo（静默段/预算）改写，
        // 崩溃后顺延再派发就会换键，账本里的 planned/unknown 对不上，于是重复提醒。
        const occurrenceId = this.reminders.ensureOccurrenceId?.(it.id) || String(Number(it.at) || 0);
        const began = this.effects?.begin({
          kind: 'reminder',
          chatKey,
          idemKey: `reminder:${it.id}:${occurrenceId}`,
          detail: { reminderId: it.id, occurrenceId, at: Number(it.at) || 0 }
        });
        if (began) {
          if (began.action === 'done') {
            this.reminders.markFired(it.id, now);
            log.info(`[reminder] ${chatKey} ${it.id} 已由上一轮播报，跳过`);
            continue;
          }
          if (began.action === 'review') {
            if (it.repeat) {
              // 周期项只作废这一期：markFired 会重算下一次并换 occurrenceId。
              // 用 failDelivery 会把整条每日/每周提醒永久停掉（2026-10-31 审查 P2）。
              this.reminders.markFired(it.id, now);
              log.error(`[reminder] ${chatKey} ${it.id} 本期投递结果未知，跳过本期并重排下一次`);
            } else {
              this.reminders.failDelivery(it.id, '上一次投递结果未知，已停止自动重试，请人工核对');
              log.error(`[reminder] ${chatKey} ${it.id} 上次投递结果未知，停止自动重试`);
            }
            continue;
          }
          if (began.action === 'in-flight') continue;
        }
        batch.push({ it, effectId: began?.id || null });
      }
      if (!batch.length) continue;
      const settleAll = (state, detail = {}) => {
        for (const pair of batch) {
          if (pair.effectId) this.effects.settle(pair.effectId, state, detail);
        }
      };
      // 连续未确认播报：一次性提醒耗尽后停用（未知不能重发）；周期项耗尽只跳过本期，
      // 必须 re-arm 到下一次，否则“每天 9 点吃药”会在一次网关故障后永久消失。
      const retryOrRearm = (pair, later) => {
        // 周期项已经用完重试次数：直接跳过本期并 re-arm，不能先 retryLater 置 failed
        //（#prune 可能在 markFired 前把这条已完成记录清掉，导致永久停用）。
        if (pair.it.repeat && typeof pair.it.repeat === 'object'
          && Number(pair.it.deliveryAttempts) >= 3) {
          this.reminders.markFired(pair.it.id, now);
          return 'rearmed';
        }
        const retry = this.reminders.retryLater(pair.it.id, later, { maxAttempts: 3 });
        if (!retry.exhausted) return retry.missing ? 'missing' : 'retry';
        if (pair.it.repeat && typeof pair.it.repeat === 'object') {
          this.reminders.markFired(pair.it.id, now);
          return 'rearmed';
        }
        return 'exhausted';
      };
      const note = buildReminderNote(batch.map((pair) => pair.it), { now });
      // 只把**本次唤醒新产生**的 unknown 当成本轮结果不确定：历史遗留的 unknown/sending
      // （上次硬崩溃、别的 run 的残行）不该让每条提醒一上来就放弃重试。
      const unknownBefore = new Set(this.store.listUnknownOperations(chatKey).map((op) => op.id));
      for (const pair of batch) this.#remindersInFlight.add(pair.it.id);
      this.wake(chatKey, { manual: true, paced: true, wakeNote: note })
        .then((result) => {
          // 只认**本轮唤醒自己发出的消息**。用 hasSelfSince 会把日报/游戏/插件的自发消息
          // 误当成提醒已播报，提醒正文就永久丢了（2026-11-03 第五轮复审 A3）。
          const delivered = Array.isArray(result?.sent) && result.sent.length > 0;
          if (delivered) {
            settleAll('sent', { deliveredAt: Date.now() });
            for (const pair of batch) this.reminders.markFired(pair.it.id, now);
            log.info(`[reminder] 已播报 ${batch.length} 条：${chatKey} ${batch.map((pair) => String(pair.it.text)).join(' / ')}`);
            return;
          }
          // 发送结果不确定（outbox unknown）时绝不自动重试：换一轮 lease 后
          // 原来的 hasUncertainEffects 看不到这批副作用，重说一遍就会重复提醒。
          const uncertain = this.store.listUnknownOperations(chatKey)
            .some((op) => !unknownBefore.has(op.id));
          if (uncertain) {
            settleAll('unknown', { reason: 'outbox-unknown' });
            for (const pair of batch) {
              // 周期项不能被一次“结果未知”永久停掉：跳过本期、重排下一次；
              // 一次性提醒仍保留人工核对语义（未知绝不自动重发）。
              if (pair.it.repeat && typeof pair.it.repeat === 'object') {
                this.reminders.markFired(pair.it.id, now);
              } else {
                this.reminders.failDelivery(pair.it.id, '发送结果未知，已停止自动重试，请人工核对');
              }
            }
            log.error(`[reminder] 有未确认的外发，${batch.length} 条提醒停止自动重试：${chatKey}`);
            return;
          }
          // 本轮确实一条都没发：失败可重试（账本 failed 允许重新 begin）
          settleAll('failed', { reason: 'no-send' });
          const later = Date.now() + 5 * 60 * 1000;
          let exhausted = 0;
          let rearmed = 0;
          for (const pair of batch) {
            const outcome = retryOrRearm(pair, later);
            if (outcome === 'exhausted') exhausted += 1;
            else if (outcome === 'rearmed') rearmed += 1;
          }
          if (exhausted || rearmed) {
            const retried = batch.length - exhausted - rearmed;
            log.error(`[reminder] ${exhausted + rearmed} 条连续未确认播报，已停止自动重试`
              + (rearmed ? `（其中 ${rearmed} 条周期提醒已重排下一期）` : '')
              + (retried ? `；另外 ${retried} 条 5 分钟后重试` : '') + `：${chatKey}`);
          } else {
            log.warn(`[reminder] 本轮未检测到发送，${batch.length} 条 5 分钟后重试：${chatKey}`);
          }
        })
        .catch((error) => {
          // 唤醒本身抛错：没有任何发送证据，按 failed 处理（允许下一次重试）
          settleAll('failed', { reason: 'wake-error', error: String(error?.message ?? error).slice(0, 200) });
          const later = Date.now() + 5 * 60 * 1000;
          let exhausted = 0;
          let rearmed = 0;
          for (const pair of batch) {
            const outcome = retryOrRearm(pair, later);
            if (outcome === 'exhausted') exhausted += 1;
            else if (outcome === 'rearmed') rearmed += 1;
          }
          const retried = batch.length - exhausted - rearmed;
          log.error(`[reminder] 唤醒出错，`
            + (exhausted ? `${exhausted} 条已停止重试` : '')
            + (exhausted && rearmed ? '，' : '')
            + (rearmed ? `${rearmed} 条周期提醒已重排下一期` : '')
            + ((exhausted || rearmed) && retried ? '，' : '')
            + (retried ? `${retried} 条 5 分钟后重试` : '')
            + ':', error?.message ?? error);
        })
        .finally(() => {
          for (const pair of batch) this.#remindersInFlight.delete(pair.it.id);
        });
      const deferred = items.length - chosen.length;
      // 全文进日志（单条正文 ≤200 字）：先记下派发内容，播报结果在 then/catch 里补。
      log.info(`[reminder] 到点派发 ${batch.length} 条：${chatKey} ${batch.map((pair) => String(pair.it.text)).join(' / ')}`
        + (deferred > 0 ? `（另有 ${deferred} 条本轮装不进提示词，30 秒后继续派发）` : ''));
    }
  }

  startProactiveLoop() {
    this.stopProactiveLoop();
    const epoch = ++this.proactiveEpoch;
    const scopeLabel = (scope) => (scope === 'private' ? '私聊' : '群聊');
    const schedule = (scope, delay) => {
      if (epoch !== this.proactiveEpoch) return;   // 这一轮已被 stop/restart 作废
      const timer = setTimeout(() => { tick(scope).catch(() => {}); }, delay);
      timer.unref?.();
      this.proactiveTimers.set(scope, timer);
    };
    const tick = async (scope) => {
      if (epoch !== this.proactiveEpoch) return;   // stop/restart 后旧 tick 直接作废
      const cfg = getConfig();
      const nowTick = Date.now();
      const window = proactiveWindowState(cfg.proactive?.activeHours, nowTick);
      // 窗口外：下一次直接排到窗口开始，不白白消耗一个间隔
      const next = window.active
        ? randInt(
          Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
          Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
        )
        : Math.max(60000, window.nextActiveAt - nowTick + 1000);
      schedule(scope, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (!window.active) return;
      const scopes = proactiveScopes(cfg);
      if (scope === 'group' ? !scopes.groups : !scopes.private) return;
      // 距该范围上次判定不足一个间隔就跳过：重启/另一个范围判定都不额外换来一次机会
      const minGapMs = Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000);
      const attempts = readProactiveAttempts(PROACTIVE_STATE_FILE);
      if (nowTick - attempts[scope] < minGapMs) {
        log.info(`[proactive] 跳过（${scopeLabel(scope)}）：距上次判定不足一个间隔`);
        return;
      }
      if (this.proactiveSuppressions.size > 0) {
        log.info(`[proactive] 跳过（${scopeLabel(scope)}）：有后台任务在跑`);
        return;
      }
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) {
        log.info(`[proactive] 跳过（${scopeLabel(scope)}）：并发任务已满`);
        return;
      }
      if (cfg.proactive?.scopeMode === 'perChat') {
        // perChat：每个群/私聊各自判定；概率仍按会话独立掷，但每轮最多开 maxPerTick 个，
        // 避免几十个群同时命中造成刷屏。
        const candidates = this.#proactiveCandidates(cfg, scope);
        if (!candidates.length) {
          log.info(`[proactive] 跳过（${scopeLabel(scope)}）：没有安静下来的会话，45 分钟后再看`);
          clearTimeout(this.proactiveTimers.get(scope));
          schedule(scope, 45 * 60 * 1000);
          return;
        }
        const state = readProactiveState(PROACTIVE_STATE_FILE);
        const minGapMs = Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000);
        const maxPerTick = Math.max(1, Math.min(10, Number(cfg.proactive?.perChatMaxPerTick) || 2));
        const chance = proactiveProbability(cfg.proactive?.probability);
        let sent = 0;
        const touched = [];
        for (const chatKey of candidates) {
          if (sent >= maxPerTick) break;
          if (nowTick - Number(state.chats[chatKey] || 0) < minGapMs) continue;
          touched.push(chatKey);
          if (this.random() > chance) continue;
          if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) break;
          sent += 1;
          log.info(`[proactive] 主动开话题（${scopeLabel(scope)}·独立） → ${chatKey}`);
          this.wake(chatKey, { proactive: true }).catch((error) => log.error('[orchestrator] proactive 出错:', error));
        }
        // 一轮只落盘一次：群多时不要为每个候选读/写整份状态文件。
        writeProactiveChatAttempts(PROACTIVE_STATE_FILE, touched, nowTick);
        if (!sent) log.info(`[proactive] 跳过（${scopeLabel(scope)}）：本轮独立判定没有命中`);
        return;
      }
      if (this.random() > proactiveProbability(cfg.proactive?.probability)) {
        // 摇了不发言也算把这个范围这一轮用掉；另一个范围的机会不受影响
        log.info(`[proactive] 跳过（${scopeLabel(scope)}）：这次摇到了不发言`);
        writeProactiveAttempt(PROACTIVE_STATE_FILE, scope, nowTick);
        return;
      }
      // 只在该范围里挑一个"安静且允许"的会话
      const candidates = this.#proactiveCandidates(cfg, scope);
      if (!candidates.length) {
        // 选中的会话都正热闹、或都在忙：这不算消耗，45 分钟后再看，别白瞎一个间隔
        log.info(`[proactive] 跳过（${scopeLabel(scope)}）：没有安静下来的会话，45 分钟后再看`);
        clearTimeout(this.proactiveTimers.get(scope));
        schedule(scope, 45 * 60 * 1000);
        return;
      }
      // 真要开口了，才把该范围这一轮用掉（另一个范围仍有自己的机会）
      writeProactiveAttempt(PROACTIVE_STATE_FILE, scope, nowTick);
      const chatKey = candidates[Math.floor(this.random() * candidates.length)];
      log.info(`[proactive] 主动开话题（${scopeLabel(scope)}） → ${chatKey}`);
      this.wake(chatKey, { proactive: true }).catch((error) => log.error('[orchestrator] proactive 出错:', error));
    };
    const scopes = proactiveScopes(getConfig());
    // 两个范围错开启动，避免重启/保存配置后同一秒同时判定、同时开口。
    if (scopes.groups) schedule('group', 15000);
    if (scopes.private) schedule('private', 45000);
  }

  #proactiveCandidates(cfg, scope) {
    const prefix = scope === 'private' ? 'private:' : 'group:';
    return proactiveCandidates({
      chatKeys: this.store.listChats().filter((key) => String(key).startsWith(prefix)),
      cfg,
      metaOf: (chatKey) => this.store.getChatMeta(chatKey),
      canWake: (chatKey) => canRun(chatKey),
      isRunning: (chatKey) => this.runningChats.has(chatKey)
    });
  }

  // ── 群友印象自动整理 ──
  // 触发条件（二者同时满足）：印象条数超过阈值，且距上次整理超过冷却时间。
  //
  // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
  // → 自动整理永远不触发。改为可配置（config.memory.consolidateMinImpressions），
  // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (!canRun(chatKey)) return;
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      // 整理是后台付费模型调用，不是"回 @ 的那一句"；当日预算用尽后也要停，
      // 否则 block/degrade 只是挡住了聊天，整理仍会继续花钱（2026-10-20 审查）。
      const budget = budgetStatus(cfg, this.sessions?.todayUsage?.(todayKey()) || {});
      if (budget.enabled && budget.exceeded) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || Orchestrator.MEMORY_THRESHOLDS.memberImpression);
      // 触发条件二选一：
      //   A. 全群印象总数超过阈值
      //   B. 任一成员的印象条数超过上限
      // 只看总数会在"人少"的群里彻底失灵 —— 比如 3 位成员各 1 条，
      // 总数 3 永远够不到阈值，自动整理形同虚设。
      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 5);
      if (!shouldAutoConsolidate({
        impressionCount: st.counts?.memberImpression,
        memberCounts: (st.members || []).map((m) => m.count),
        minImpressions,
        maxPerMember
      })) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error) => log.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  /**
   * 整理群友印象 —— 唯一入口。
   * 手动按钮、自动整理、针对特定群友，三种用法都走这里，避免逻辑分叉走样。
   *
   * @param {string} chatKey  会话 key
   * @param {object} [opts]
   * @param {string[]} [opts.userIds]  只整理这些人（指定群友时用）；不传 = 按规则筛选全部
   * @param {boolean} [opts.force]     跳过冷却/门槛检查（手动触发时用）
   * @returns {Promise<{ok, note, changed, results, skipped, failed}>}
   *
   * 身份识别（"同一个人"的判定）：
   *   1) 优先用记忆里的 userId（QQ 号）匹配聊天记录 senderId；
   *   2) 匹配不到时，用备注名/记忆名反查 senderName，命中后把 QQ 号回写进记忆；
   *   3) 仍匹配不到但有名字 → 允许整理（历史遗留的"按名字存"条目不能永远排队）；
   *   4) 既无名也无号 → 跳过。
   */
  consolidateMemoryForChat(chatKey, options = {}) {
    return withTimeScope(chatKey, async () => {
      assertTimeAllowed();
      return this.#consolidateMemoryForChat(chatKey, options);
    });
  }

  async #consolidateMemoryForChat(chatKey, { userIds = null, force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const vis = memoryVisibilityOf(cfg);
    // 只要这个人的任何一条印象在当前会话不可见（私聊来源/perChat），就跳过整理：
    // 整理模型看到的是全量印象、写回也会整份替换，混着整理会把不可见内容带进群或删掉。
    const invisibleMembers = [];
    const existing = this.memory.members(chatKey).filter((member) => {
      const impressions = Array.isArray(member.impressions) ? member.impressions : [];
      if (visibleImpressions(impressions, chatKey, vis).length === impressions.length) return true;
      invisibleMembers.push(member);
      return false;
    });
    // 被可见性排除不等于没有记忆，不能在指定目标或发现新人时重新纳入。
    const invisibleUserIds = new Set(invisibleMembers.map((member) => String(member.userId || '')));
    // 反查名字后 uid 可能指向一个"不在 members(chatKey) 里"的人（只有私聊/其他群来源），
    // invisibleMembers 是在反查前算的，所以必须在 resolve 之后再按最终 impressions 查一次，
    // 否则隐藏来源的正文会被送给整理模型并写进当前群（2026-11-01 复审 P1）。
    const resolvedHasInvisible = (member) => {
      const list = Array.isArray(member?.impressions) ? member.impressions : [];
      return visibleImpressions(list, chatKey, vis).length !== list.length;
    };

    // ── 选出要整理的人 ──
    const targets = [];
    const skipped = invisibleMembers
      .filter((member) => !only || only.has(String(member.userId || '')))
      .map((member) => ({
        userId: member.userId,
        name: member.name,
        reason: '存在当前会话不可见的印象，跳过整理'
      }));
    const skippedUserIds = new Set(skipped.map((item) => String(item.userId || '')));
    // 名字反查可能把一条"可见的遗留名字记录"指到已经进 invisibleUserIds 的 QQ 号上：
    // 这种目标同样不能整理，否则 #resolveIdentity 会把该人的隐藏来源印象一并读出来。
    const skipInvisible = (member) => {
      const uid = String(member.userId || '');
      if (skippedUserIds.has(uid)) return;
      skippedUserIds.add(uid);
      skipped.push({ userId: member.userId, name: member.name, reason: '存在当前会话不可见的印象，跳过整理' });
    };

    // 指定群友但记忆里还没有 → 也要能"新建"印象（这是本功能的关键价值：
    // 聊了 200 条却零印象的人，可以手动让他被分析一次）
    if (only) {
      for (const uid of only) {
        if (invisibleUserIds.has(uid)) continue;
        const found = existing.find((m) => String(m.userId || '') === uid);
        if (found) {
          const resolved = this.#resolveIdentity(chatKey, found, stats, notes);
          if (invisibleUserIds.has(String(resolved.userId || '')) || resolvedHasInvisible(resolved)) {
            skipInvisible(resolved);
            continue;
          }
          targets.push({ ...resolved, isNew: false });
          continue;
        }
        // 记忆里没有这个人：用聊天记录里的名字兜底，允许新建
        const name = stats.uidToName.get(uid) || notes[uid] || '';
        if (!name && !stats.memberMsgCount.get(uid)) {
          skipped.push({ userId: uid, name: '', reason: '聊天记录里没有此人发言' });
          continue;
        }
        targets.push({
          userId: uid,
          name: name || `QQ ${uid}`,
          impressions: [],
          isNew: true
        });
      }
    } else {
      // 先整理记忆里已有的人
      const knownUserIds = new Set(invisibleUserIds);
      // 反查之后，同一个人的两条记录（"只有名字的遗留条目" + 本人的记录）会指向同一个 QQ 号：
      // 必须并成一条再送给模型 —— 分开整理的话，后写回的那条会把前一条的并集结果覆盖掉。
      const targetByUid = new Map();
      for (const mem of existing) {
        const resolved = this.#resolveIdentity(chatKey, mem, stats, notes);
        const uid = String(resolved.userId || '');
        if ((uid && invisibleUserIds.has(uid)) || resolvedHasInvisible(resolved)) {
          // 记进 knownUserIds：否则后面的“发现活跃成员”会把这个刚被跳过的人当新人再整理一次。
          if (uid) knownUserIds.add(uid);
          skipInvisible(resolved);
          continue;
        }
        if (uid) knownUserIds.add(uid);
        if (this.#shouldSkip(resolved, force)) {
          skipped.push({
            userId: resolved.userId,
            name: resolved.name,
            reason: this.#skipReason(resolved)
          });
          continue;
        }
        const dup = uid ? targetByUid.get(uid) : null;
        if (dup) {
          dup.impressions = mergeImpressionLists(dup.impressions, resolved.impressions);
          if (!dup.name && resolved.name) dup.name = resolved.name;
          continue;
        }
        const target = { ...resolved, isNew: false };
        if (uid) targetByUid.set(uid, target);
        targets.push(target);
      }

      // 再"发现"聊天记录里的活跃群友：他们发言很多却没有任何印象。
      // 没有这一步，记忆为空的群（如刚启用记忆的群）点整理只会得到
      // "没有可整理的群友"，功能形同虚设。
      // 两端都夹：只夹下界的话，手输 9999 会存进配置并让"发现新人"事实上永久失效
      const discoverMin = Math.min(500, Math.max(1,
        Number(cfg.memory?.discoverMinMessages) || Orchestrator.DISCOVER_MIN_MESSAGES));
      const discoverMax = Math.min(20, Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || Orchestrator.DISCOVER_MAX_MEMBERS));
      const discovered = [...stats.memberMsgCount.entries()]
        .filter(([uid, n]) => n >= discoverMin && !knownUserIds.has(uid))
        .sort((a, b) => b[1] - a[1])
        .slice(0, discoverMax);
      for (const [uid, n] of discovered) {
        targets.push({
          userId: uid,
          name: stats.uidToName.get(uid) || notes[uid] || `QQ ${uid}`,
          impressions: [],
          isNew: true,
          discoveredFrom: n
        });
      }
    }

    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';

    if (!targets.length) {
      // 没对象也要记一次时间戳，否则零印象的会话每次运行都会重扫一遍聊天记录
      try { this.memory.markConsolidated?.(chatKey); } catch { /* 锦上添花 */ }
      return {
        ok: true,
        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,
        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }

    // ── 逐个整理 ──
    const results = [];
    const failed = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.aborted) break;
      assertTimeAllowed();
      const before = mem.impressions.map((e) => e.content);
      try {
        const next = await this.#consolidateOneMember(chatKey, mem, { force, stats });
        if (!next) { failed.push({ userId: mem.userId, name: mem.name, reason: '模型返回无法解析' }); continue; }
        const after = next.impressions.map((e) => e.content);
        const isChanged = after.length !== before.length || after.some((c, i) => c !== before[i]);
        if (isChanged) changed += 1;
        results.push({
          userId: mem.userId,
          name: mem.name,
          before: before.length,
          after: after.length,
          changed: isChanged,
          isNew: !!mem.isNew
        });
      } catch (error) {
        failed.push({ userId: mem.userId, name: mem.name, reason: String(error?.message ?? error) });
      }
    }

    const discoveredCount = targets.filter((t) => t.isNew).length;
    const note = this.#buildConsolidateNote({
      total: targets.length, changed, failed, skipped, only, discoveredCount
    });
    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    return { ok: true, note, changed, results, skipped, failed };
  }

  /** 统计会话里各成员的出现次数与名字（用于身份识别与"新建印象"）。 */
  #scanChatActivity(chatKey) {
    const memberMsgCount = new Map();
    const nameMsgCount = new Map();
    const nameToUserId = new Map();
    const nameToUids = new Map();   // 名字 → 出现过的 QQ 号集合：nameToUserId 是"先见到先赢"，看不出重名
    const uidToName = new Map();
    // 与提示词/工具结果同一口径：屏蔽名单生效前存档的消息也不能作为整理材料。
    for (const m of filterBlockedHistory(this.store.recent(chatKey, { limit: 2000 }), chatKey)) {
      if (m.self || !m.senderId) continue;
      const uid = String(m.senderId);
      memberMsgCount.set(uid, (memberMsgCount.get(uid) || 0) + 1);
      const nm = String(m.senderName || '').trim();
      // 跳过占位名（历史脏数据：拍一拍事件曾把 senderName 写成"（拍一拍事件）"）
      if (nm && !PLACEHOLDER_NAMES.has(nm)) {
        nameMsgCount.set(nm, (nameMsgCount.get(nm) || 0) + 1);
        if (!nameToUserId.has(nm)) nameToUserId.set(nm, uid);
        if (!nameToUids.has(nm)) nameToUids.set(nm, new Set());
        nameToUids.get(nm).add(uid);
        if (!uidToName.has(uid)) uidToName.set(uid, nm);
      }
    }
    return { memberMsgCount, nameMsgCount, nameToUserId, nameToUids, uidToName };
  }

  /** 确定一个记忆条目的 QQ 号（必要时反查名字并回写记忆文件）。 */
  #resolveIdentity(chatKey, mem, stats, notes) {
    const own = String(mem.userId || '').trim();
    let userId = own;
    let impressions = mem.impressions || [];
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    // 只有"自己没带 QQ 号的遗留条目"才按名字反查：条目已经带了号码就以它为准 ——
    // 名字映射是"先见到先赢"的启发式，把一个号码改写成同名另一个人的之后，
    // 这轮整理的结果会写到别人头上（重名时尤其危险）。
    if (!/^\d{1,15}$/.test(userId) && msgCount < Orchestrator.MEMBER_MIN_MESSAGES) {
      for (const name of [notes[userId], mem.name, userId].filter(Boolean)) {
        const uids = stats.nameToUids.get(name);
        // 同名多个号：不敢猜，宁可这条不整理，也不能把印象挂错人
        if (!uids || uids.size !== 1) continue;
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName < Orchestrator.MEMBER_MIN_MESSAGES) continue;
        const matched = [...uids][0];
        if (matched) {
          userId = matched;
          msgCount = byName;
          try {
            // 合并写入，不能整份替换：这个人名下可能已经有印象（他也在这个群里说过话），
            // replace 会拿这条遗留记录的内容把人家原有的印象全部覆盖掉。
            this.memory.adoptImpressions(chatKey, userId, mem.name, impressions);
            // 送模型整理的必须是**合并后**的全量印象：否则模型看不到本人原有的印象，
            // 写回时（replace 是整份替换）那些印象会连同这次整理一起消失。
            const merged = this.memory.getMember(chatKey, userId);
            if (merged?.impressions?.length) impressions = merged.impressions;
          } catch { /* 回写失败不阻塞整理 */ }
        }
        break;
      }
    }
    return { ...mem, userId, impressions, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved, force) {
    // 没有数字 QQ 号的条目（旧数据里"按名字存"的遗留）无法写回：replaceMember 只接受数字 uid。
    // 必须在**调模型之前**跳过，否则每轮整理都白烧一次调用、再在写回时抛错记成 failed。
    // 这个检查不能放在 force 之后：控制台手动整理默认 force=true，否则每次点都白烧一次。
    if (!/^\d{1,15}$/.test(String(resolved.userId || '').trim())) return true;
    if (force) return false;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved) {
    if (!/^\d{1,15}$/.test(String(resolved.userId || '').trim())) {
      return '这条历史印象只有名字、没有 QQ 号，无法合并（不消耗模型调用）';
    }
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }) {
    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';
    const head = only ? '已整理指定群友' : '已整理';
    const discoverNote = discoveredCount > 0 ? `（其中 ${discoveredCount} 位是新建印象）` : '';
    const body = changed > 0
      ? `${head} ${total} 位${discoverNote}，其中 ${changed} 位印象有更新`
      : `${head} ${total} 位${discoverNote}，内容无需改动（印象已足够精简）`;
    const failNote = failed.length
      ? `；${failed.length} 位失败（已保留原印象）`
      : '';
    return body + failNote + skippedNote;
  }

  /** 记录整理时间，供冷却判断使用。 */
  #markConsolidated(chatKey, userIds) {
    const now = Date.now();
    try {
      this.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      log.warn('[memory] 记录整理时间失败:', error?.message ?? error);
    }
  }

  /**
   * 整理单个群友的印象。
   *
   * 两种模式：
   *   - 整理模式（已有印象）：合并重复、删过时，只减不增，绝不发明新事实
   *   - 新建模式（isNew，针对零印象的活跃群友）：读他最近的发言，提炼长期印象
   *
   * 新建模式是本功能的关键补充：实测有群友聊了 200+ 条却零印象，
   * 而模型日常几乎不主动调 memory_append —— 没有这个入口就永远补不上。
   */
  async #consolidateOneMember(chatKey, mem, { force = false, stats = null } = {}) {
    const existing = mem.impressions || [];
    const isNew = !!mem.isNew || (!existing.length && !!force);

    const { system, user } = isNew
      ? this.#buildNewImpressionPrompt(chatKey, mem, stats)
      : this.#buildConsolidatePrompt(mem, chatKey);

    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    assertTimeAllowed();

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      log.warn(`[memory] ${isNew ? '新建' : '整理'} ${chatKey}/${mem.userId || mem.name} 结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_MEMORY) {
        log.warn('[memory][debug] 原始返回 =', JSON.stringify(String(res?.message?.content ?? '')).slice(0, 1500));
      }
      return null;
    }

    // 兜底：模型仍可能把【对象信息】抄进输出。只过滤精确的元信息前缀，
    // 不误删正常印象；过滤在护栏之前做，避免多出的元信息行把"结果变多"护栏触发。
    const META_PREFIXES = ['群友 QQ：', '当前名字：', '今天：', '身份：这是机器人管理员本人'];
    const isMetaImpression = (value) => typeof value === 'string'
      && META_PREFIXES.some((prefix) => value.trim().startsWith(prefix));
    const hadMetaLines = Array.isArray(parsed.impressions) && parsed.impressions.some(isMetaImpression);
    const parsedImpressions = Array.isArray(parsed.impressions)
      ? parsed.impressions.filter((item) => !isMetaImpression(item))
      : parsed.impressions;
    // 只抄回元信息、没有任何有效条目：这是模型答歪了，不是"用户没有可保留的印象"。
    // 继续写回会把现有印象整份清空（2026-11-01 issue #27）。
    if (hadMetaLines && Array.isArray(parsedImpressions) && parsedImpressions.length === 0) {
      log.warn(`[memory] 整理 ${chatKey}/${mem.userId} 放弃：模型只返回了对象信息，保留原印象`);
      return null;
    }
    const raw = Array.isArray(parsedImpressions) ? parsedImpressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;

    const rejection = consolidationRejectionReason({ isNew, existing, next: parsedImpressions });
    if (rejection) {
      log.warn(`[memory] 整理 ${chatKey}/${mem.userId} 放弃：${rejection}`);
      return null;
    }

    // 整理期间控制台可能改了记忆：写回前必须重读当前值，不能拿 await 之前的快照写回。
    // 这样"整理中途删掉/改掉手工条目"不会被旧快照复活（复审 P2）。
    const snapshotTexts = new Set(existing.map((e) => String(e?.content ?? '').trim()));
    const currentRow = (this.memory.members(chatKey) || [])
      .find((m) => String(m?.userId || '') === String(mem.userId || ''));
    if (!isNew && !currentRow) {
      // 整理期间管理员把这个人的记忆删了：不能拿 await 前的 existing 旧快照复活它。
      log.warn(`[memory] 整理 ${chatKey}/${mem.userId} 放弃：整理期间记忆已被删除`);
      return null;
    }
    if (!isNew && !(Array.isArray(currentRow?.sourceChatKeys) ? currentRow.sourceChatKeys : [])
      .includes(String(chatKey || '').trim())) {
      log.warn(`[memory] 整理 ${chatKey}/${mem.userId} 放弃：记忆来源已不含当前会话`);
      return null;
    }
    const currentImpressions = currentRow?.impressions || existing;
    // 控制台手写的（origin=manual）条目是用户的明确输入，模型无权改写/删除。
    // 不依赖模型"听话"：写回前强制把**当前**手工条目并进结果，且不占模型输出的配额。
    // replace 对正文逐字相同的条目会沿用旧 origin，所以 manual 来源不会丢（issue #55）。
    const manualContents = [...new Set(currentImpressions
      .filter((e) => String(e?.origin || '') === 'manual')
      .map((e) => String(e?.content ?? '').trim())
      .filter(Boolean))];
    // 存储层单次 replace 上限跟 memory.maxImpressionsPerPerson（默认 50）走；
    // 手工条目已经占满时无法再塞自动条目，宁可跳过本轮整理，也不能让 replace 把用户写的尾部静默截掉（复审 P2）。
    const manualLimit = Math.max(5, Math.min(200, Math.round(Number(getConfig().memory?.maxImpressionsPerPerson) || 50)));
    if (manualContents.length >= manualLimit) {
      log.warn(`[memory] 整理 ${chatKey}/${mem.userId} 跳过：手工印象已有 ${manualContents.length} 条（存储上限 ${manualLimit}），先人工清理再整理`);
      return null;
    }
    // 模型有时会把整理前看到的 "（记于 …）" 尾注一起抄回来；不归一化就会在手工条目旁边
    // 多出一条"内容相同但来源是 consolidated"的副本（issue #55 的第 4 条）。
    const impressionKey = (text) => String(text ?? '')
      .replace(/（记于[^）]*）\s*$/, '')
      .replace(/\(记于[^)]*\)\s*$/, '')
      .trim();
    const manualKeys = new Set(manualContents.map(impressionKey));
    // 整理期间被删/改掉的手工条目：模型可能把旧正文抄回来，按旧 key 一并挡掉，避免复活。
    const staleManualKeys = new Set(existing
      .filter((e) => String(e?.origin || '') === 'manual')
      .map((e) => impressionKey(String(e?.content ?? '').trim()))
      .filter((key) => key && !manualKeys.has(key)));
    const blockedManualKeys = new Set([...manualKeys, ...staleManualKeys]);
    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .filter((content) => !blockedManualKeys.has(impressionKey(content)))
      .slice(0, maxKeep)
      .map((content) => safeSlice(content, 120));

    // ⚠️ 整理期间的 `memory_append` 不能被这次写回整表覆盖（2026-10-04 全面复审 P2 实测：
    // 快照是上面 await 之前取的，模型跑完这一分钟里新写进去的印象会被 replaceMember 静默抹掉）。
    // 写回前重读一次当前值，把「快照里没有、现在有」的条目并回去；模型对已有条目的
    // 增删改照旧生效（那正是整理要做的事），只补它看不见的那部分。
    const appendedDuring = currentImpressions
      .map((e) => String(e?.content ?? '').trim())
      .filter((t) => t && !snapshotTexts.has(t) && !blockedManualKeys.has(impressionKey(t)));
    // 配额顺序：手工条目 > 整理期间新增 > 模型输出。手工条目超过 maxKeep 时也全保留
    // （用户明确写下的内容比"每人最多 5 条"的软上限优先；存储层上限见 memory.maxImpressionsPerPerson）。
    const fixed = [...manualContents];
    let mergedCount = 0;
    for (const text of appendedDuring) {
      if (fixed.length >= maxKeep) break;
      if (fixed.includes(text)) continue;
      fixed.push(safeSlice(text, 120));
      mergedCount += 1;
    }
    const room = Math.max(0, maxKeep - fixed.length);
    const merged = [...fixed, ...clean.slice(0, room)];
    if (mergedCount) {
      log.info(`[memory] 整理 ${chatKey}/${mem.userId}：并回整理期间新增的 ${mergedCount} 条印象`);
    }
    if (manualContents.length) {
      log.info(`[memory] 整理 ${chatKey}/${mem.userId}：保留 ${manualContents.length} 条手工印象`);
    }

    return this.memory.replaceMember(chatKey, mem.userId, mem.name, merged);
  }

  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem, chatKey) {
    // 与"今天"同口径（上海）：原来用 UTC，凌晨产生的印象在模型眼里会算成前一天。
    // 坏时间戳（负数/纳秒级/超范围）必须先夹住：toISOString 碰到 Invalid Date 会抛 RangeError，
    // 这条人物会因此永远整理不了（异常被记成 failed，坏值本身没人清理）。
    // 上界要扣掉时区偏移：格式化时会再加 ZONE_OFFSET_MS，贴着 8.64e15 的值加完就溢出成 Invalid Date
    const clampTs = (t) => {
      const raw = Number(t) || 0;
      return Number.isFinite(raw) && raw > 0 && raw <= 8.64e15 - ZONE_OFFSET_MS ? raw : 0;
    };
    const fmtTs = (t) => {
      const at = clampTs(t);
      return at ? new Date(at + ZONE_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ') : '日期未知';
    };
    const cfg = getConfig();
    // 整理这次调用是"另一个进程"：它看不到角色卡，也不知道谁是管理员。
    // 不点明身份的话，"他改人设、问人设"就容易被写成性格缺陷（"扬言改人设提示词"就是这么来的）。
    const ownerUin = String(cfg?.admin?.ownerUin || '').trim();
    // 必须挡住"两边都是空串"：没配管理员时 '' === '' 会把匿名遗留条目当成管理员本人
    const isOwner = Boolean(ownerUin) && ownerUin === String(mem.userId || '').trim();
    // 要算"90 天前"就得知道今天，整理这次调用看不到别的时间来源
    const today = todayKey();
    // 已有印象的人也要能看到最近的发言：否则整理只能合并/删除，结构上无法变丰富
    // （2026-11-01 插件仓库 issue #25）。只取该成员最近 30 条、每条 200 字，作为补充证据。
    const sample = chatKey
      ? filterBlockedHistory(this.store.recentBySender(chatKey, String(mem.userId || ''), 30), chatKey)
        .map((m) => safeSlice(String(m.text || ''), 200))
        .filter(Boolean)
      : [];
    // 元信息和印象条目必须分开：0.9.12/0.9.13 加了子标题后，元信息成了"子标题前的
    // 孤立段落"，模型会把它们当印象抄回库里（2026-11-01 插件仓库 issue #27 实测）。
    const metaLines = [`群友 QQ：${sanitizeUserText(String(mem.userId || ''))}`, `当前名字：${sanitizeUserText(String(mem.name || ''))}`, `今天：${today}（Asia/Shanghai）`];
    if (isOwner) metaLines.push('身份：这是机器人管理员本人（设置角色卡、管这台机器人的人）');
    const entryLines = [];
    const manual = (mem.impressions || []).filter((e) => String(e?.origin || '') === 'manual');
    const automatic = (mem.impressions || []).filter((e) => String(e?.origin || '') !== 'manual');
    const pushEntry = (e) => {
      const created = clampTs(e.createdAt);
      const observed = clampTs(e.lastObservedAt);
      entryLines.push(`- ${sanitizeUserText(e.content)}（记于 ${fmtTs(created)}${observed && observed !== created ? `，最近观察到 ${fmtTs(observed)}` : ''}）`);
    };
    if (manual.length) {
      entryLines.push('', '【手工印象：用户亲自写的，必须原样逐字保留，不得改写、合并或删除】');
      manual.forEach(pushEntry);
    }
    if (automatic.length) {
      entryLines.push('', '【自动积累的印象：可以按下面的规则合并、改写或删除】');
      automatic.forEach(pushEntry);
    }
    const maxKeep = Number(cfg.memory?.maxImpressionsPerMember) || 5;
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你只做合并、改写与删除，或依据【最近的发言】做有原文依据的补充；绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 把同义/重复的印象合并成一条。冲突时以**最近观察到的**为准；拿不准就保留较新的一条，别自己裁量。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        '3. 只有被反复观察到、或对方明确说出来的，才算稳定特征；只出现过一次的拌嘴、玩笑、临时要求，不要升级成"他是什么人"。',
        '4. 很久没再被观察到（记于/观察到都在 90 天前）、近期也没新证据提到的，直接删掉。',
        `5. 最多保留 ${maxKeep} 条，每条不超过 120 字。`,
        '6. 只写可观察的事实与偏好（爱聊什么、什么口气、玩什么梗、有哪些雷点），不写评价、不揣测动机：',
        '   写"会反复问人设、爱逗人表演"，不要写"想掌控设定""扬言改人设""喜欢试探规则"这类带立场的说法。',
        '7. 如果写的是管理员本人：他改人设、问人设、逗你玩都是本职，不是"试探"或"施压"，照事实记就行。',
        '8. 【手工印象】段里的每一条都必须原样逐字出现在输出里：不得改写、合并、删除，也不受第 1-7 条约束；输出时只写正文，不要带段标题。',
        ...(sample.length ? [
          '9. 可以依据【最近的发言】补充稳定特征，但每条必须有原文依据；不要逐条复述、不要记流水账。'
            + '已有印象已满时，用有近期证据的稳定特征替换过时/重复条目，不要为凑数新增。'
        ] : []),
        '原则：所有信息只能来自原文，语义不变，宁少勿错；没有可保留的时输出空数组。',
        '',
        '【对象信息】（只用于判断身份与时间，不是印象条目；不要写进输出）',
        ...metaLines,
        '',
        '【需要整理的印象】（下面以「- 」开头的才是印象条目）',
        ...entryLines,
        ...(sample.length ? [
          '',
          '【最近的发言】（只作补充证据，不要逐条复述）',
          ...sample
        ] : []),
      ].join('\n')
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey, mem) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    const uid = String(mem.userId || '');
    const safeName = sanitizeUserText(safeSlice(String(mem.name || ''), 60));
    const sample = filterBlockedHistory(this.store.recent(chatKey, { limit: 2000 }), chatKey)
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => safeSlice(String(m.text || ''), 200))
      .filter(Boolean);

    return {
      system: '你是聊天机器人的记忆模块，负责从聊天记录里提炼对某一位群友的长期印象。只提炼"以后跟这个人打交道用得上"的稳定特征，严格依据给定的发言，不要编造。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        `下面是群友（QQ ${uid}${(safeName && `，名字 ${safeName}`) || ''}${(uid && String(getConfig()?.admin?.ownerUin || '').trim() === uid) ? '，**这是机器人管理员本人**（设置角色卡、管这台机器人的人）' : ''}）最近的部分发言，请提炼对他的长期印象：`,
        '1. 只保留稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。',
        '2. 不要记一次性事件、临时话题，也不要记录流水账。',
        `3. 最多 ${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。`,
        '4. 只写可观察的事实与偏好，不写评价、不揣测动机：写"爱反复问人设、爱逗人表演"，',
        '   不要写"想掌控设定""扬言改人设""喜欢试探规则"这类带立场的说法。',
        '5. 宁少勿错：信息不足就少写，不要脑补。',
        '6. 若实在提炼不出任何稳定特征，输出空数组。',
        '',
        sample.length ? sample.join('\n') : '（没有抓到该群友的发言）'
      ].join('\n')
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      // 记忆整理 = 判断/总结类任务（与聊天、写作可各自设思考档位）。
      const response = await chatCompletion({ messages, temperature: 0.2, purpose: 'judge' });
      this.#recordExternalUsage(response);
      return response;
    }
    const providers = currentProviders();
    const p = providers.find((x) => x.id === mem.provider);
    if (!p?.baseURL || !p?.apiKey || !mem.model) {
      throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    const response = await chatCompletion({
      messages,
      temperature: 0.2,
      purpose: 'judge',
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });
    this.#recordExternalUsage(response, mem.model);
    return response;
  }

  /** 非会话模型调用（记忆整理）计入今日台账：此前整条链路对用量完全透明（2026-10-07 复审 P3）。 */
  #recordExternalUsage(response, model = '') {
    try {
      const usage = emptyUsage();
      addUsage(usage, response?.usage);
      usage.calls = 1;
      const vendor = response?.originBaseUrl
        ? vendorOfBaseUrl(getConfig(), response.originBaseUrl) : '';
      this.sessions?.recordExternalUsage?.(usage, { model: model || response?.model || '', vendor });
    } catch { /* 记账失败不影响主流程 */ }
  }

  stopProactiveLoop() {
    this.proactiveEpoch = (this.proactiveEpoch || 0) + 1;
    for (const timer of this.proactiveTimers.values()) clearTimeout(timer);
    this.proactiveTimers.clear();
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    try {
      updateConfig({ runtime: { paused: this.paused } });
    } finally {
      // updateConfig 在 config.json 被外部改过时会抛 CONFIG_CONFLICT（路由返回 409）。
      // 落盘失败不能只改一半内存：正在跑的 run 仍要中止、状态仍要广播，否则用户看到
      // "保存失败"但机器人已经半暂停（或恢复后积压没被处理）。
      if (this.paused) {
        for (const controller of this.controllers.values()) controller.abort(new Error('Run cancelled'));
      }
      this.pauseReason = this.paused ? reason : null;
      this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
    }
  }

  async abortAll() {
    this.aborted = true;
    clearInterval(this.retryTimer);
    for (const controller of this.controllers.values()) controller.abort(new Error('Run cancelled'));
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    this.firstPendingAt.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.stopProactiveLoop();
    // 提醒循环与自安排唤醒 ticker 也是常驻 interval：不停掉的话 abortAll 之后它们还在跑
    //（测试里表现为进程被定时器吊着、状态被悄悄推进；2026-10-12 审查）。
    this.stopReminderLoop();
    if (this.scheduledWakeTicker) clearInterval(this.scheduledWakeTicker);
    this.scheduledWakeTicker = null;
    for (const item of this.scheduledWakes.values()) item?.timer && clearTimeout(item.timer);
    this.scheduledWakes.clear();
    await Promise.allSettled([...this.runTasks]);
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      mode: cfg.runtime?.mode || 'observe',
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      consolidating: [...this.consolidating],
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（已抽到 src/tools/inline-tools.js，判断类模块共用） ──
export { parseInlineToolCalls };


/**
 * 聊天记录里可能出现的占位名（非真实昵称）。
 * 来源：历史版本的拍一拍事件把 senderName 硬编码成"（拍一拍事件）"。
 * 取名字时必须跳过，否则记忆里会出现"某人的名字叫（拍一拍事件）"。
 */
const PLACEHOLDER_NAMES = new Set([
  '（拍一拍事件）',
  '(拍一拍事件)',
  '未知',
  '某人'
]);

/**
 * 从模型输出里稳健提取 JSON 对象。
 *
 * 模型并不总会乖乖只吐 JSON，常见变体：
 *   1) ```json\n{...}\n```            —— Markdown 代码块
 *   2) "好的，这是整理结果：\n{...}"   —— 前后带解释文字
 *   3) '{"impressions":[...]}'        —— 用了单引号
 *   4) 结尾多了个逗号                  —— 尾随逗号
 * 原实现只会剥掉"整段被 ``` 包裹"这一种，其余全部解析失败 → 整理静默放弃。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 1) 先尝试直接解析
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }

  // 2) 剥掉 ``` 代码块（可能在中间任意位置）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());

  // 3) 取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    // 修正常见瑕疵后重试：尾随逗号、单引号
    try {
      const fixed = cand
        .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
        .replace(/'/g, '"');                     // 单引号 → 双引号
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
    // 兜底：只抽 impressions 数组
    const arrMatch = cand.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrMatch) {
      try {
        const items = JSON.parse('[' + arrMatch[1].replace(/,\s*$/, '') + ']');
        return { impressions: items };
      } catch { /* 继续 */ }
    }
  }
  return null;
}
