import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from '../core/config.js';
import { imageType } from '../core/image-type.js';
import { cappedByTokenSaver, tokenSaverCapsOf } from '../core/token-saver.js';
import {
  addUsage,
  cachedTokensOfUsage,
  chatCompletionWithRetry,
  emptyUsage
} from '../llm/llm.js';
import { safeFetchBinary, validateImageUrl } from '../llm/safe-fetch.js';
import { convertGifToStillStrip } from '../tools/image-downsample.js';
import { sanitizeUserText, settleWithDeadline } from '../core/util.js';
import { filterBlockedHistory } from '../core/blocklist.js';
import { displayNameOf } from '../core/display-name.js';
import { visibleImpressions } from '../core/memory-visibility.js';
import { webSearch } from '../llm/web-search.js';
import { fetchWebPage } from '../llm/web-page.js';
import { buildMomentSystemPrompt, momentPersonaHash, MOMENT_PROMPT_VERSION } from '../llm/moment-prompt.js';
import { assertTimeAllowed, isTimeActive, watchTimeWindow, withTimeScope } from '../core/time-gate.js';
import { timeControlState } from '../core/time-control.js';
import { chatAllowed } from '../core/access.js';
import {
  MOMENT_MIN_GAP_MS,
  normalizeMomentWindows,
  updateMomentPlan
} from './moment-schedule.js';
import {
  formatClockTime,
  formatFullTime,
  formatShortTime,
  shanghaiDayStart,
  todayKey,
  ZONE_OFFSET_MS
} from '../core/util.js';
import { resolveToolCalls } from '../tools/inline-tools.js';
import { newTraceId, withTrace } from '../core/logger.js';

const STATE_FILE = path.join(DATA_DIR, 'daily-moments.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCKING_STATUSES = new Set([
  'running', 'skipped', 'publishing', 'published', 'publish-unknown', 'failed'
]);
const PUBLICATION_STATUSES = new Set(['publishing', 'published', 'publish-unknown']);
const automaticSource = (source) => source == null || ['scheduled', 'startup-catchup'].includes(source);
const automaticRecord = (record) => record.publicationSource === 'manual'
  ? false : automaticSource(record.source);

function samePublicationScope(existing, target) {
  if (target.scheduleSlotId && existing.scheduleSlotId === target.scheduleSlotId) return true;
  if (existing.dayKey !== target.dayKey) return false;
  // An unresolved external write remains a hold across both publication paths.
  if (['publishing', 'publish-unknown'].includes(existing.status)) return true;
  if (automaticRecord(existing) !== automaticRecord(target)) return false;
  return !automaticRecord(target)
    || (existing.scheduleSlotId || '') === (target.scheduleSlotId || '');
}
const STYLE_SEEDS = [
  '随手吐槽', '生活碎片', '抽象观察', '今日见闻', '认真想一想', '冷幽默',
  '自言自语', '轻量研究', '情绪片段', '意外联想'
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // 状态文件坏掉时留档 .broken-<时间戳> 再回默认：直接回默认会让下一次落盘把损坏文件
    // 覆盖掉，事后无从排查（与 reminders / group-game 同口径；2026-10-12 审查）。
    if (error?.code !== 'ENOENT') {
      console.error(`[daily-moments] 读取 ${file} 失败，按默认状态处理，原文件已备份为 .broken-<时间戳>：`, error?.message ?? error);
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

function normalizedConfig(cfg = getConfig().dailyMoments || {}) {
  const visibility = [1, 4, 16, 64, 128].includes(Number(cfg.visibility))
    ? Number(cfg.visibility)
    : 4;
  return {
    enabled: cfg.enabled === true,
    source: ['self', 'group', 'mixed'].includes(String(cfg.source || '')) ? String(cfg.source) : 'self',
    autoPublish: cfg.autoPublish === true,
    hour: Math.min(23, Math.max(0, Number(cfg.hour) || 0)),
    minute: Math.min(59, Math.max(0, Number(cfg.minute) || 0)),
    scheduleWindows: normalizeMomentWindows(cfg.scheduleWindows),
    intervalDays: Math.min(30, Math.max(1, Math.round(Number(cfg.intervalDays) || 1))),
    startupCatchup: cfg.startupCatchup !== false,
    minMessagesPerGroup: Math.min(100, Math.max(0, Number(cfg.minMessagesPerGroup) || 0)),
    maxGroups: Math.min(50, Math.max(1, Number(cfg.maxGroups) || 12)),
    maxMessagesPerGroup: Math.min(300, Math.max(5, Number(cfg.maxMessagesPerGroup) || 80)),
    maxPromptChars: Math.min(500000, Math.max(20000, Number(cfg.maxPromptChars) || 120000)),
    allowImages: cfg.allowImages !== false,
    maxImages: Math.min(4, Math.max(0, Number(cfg.maxImages) || 0)),
    visibility,
    targetUins: (Array.isArray(cfg.targetUins) ? cfg.targetUins : [])
      .map(Number).filter(Number.isFinite).slice(0, 200),
    maxResearchCalls: Math.min(10, Math.max(0, Number(cfg.maxResearchCalls) || 0)),
    // 省 Token 模式：日说说的工具轮数也夹上限（关闭时上限为 null，原样取用户设置）。
    // ⚠️ 这里必须用**日说说自己的** cfg.maxRounds，不能借聊天模型的 api.maxRounds ——
    // 两者是不同的旋钮（日说说默认 8、聊天默认 12），换错了会让"轮次预算"多跑几轮、
    // 白烧 token（曾把 moment-publish 的用量用例跑成 180 vs 45）。
    maxRounds: Math.min(16, Math.max(2, cappedByTokenSaver(
      Number(cfg.maxRounds) || 8,
      tokenSaverCapsOf(getConfig())?.maxRounds
    )))
  };
}

function dayStartFromKey(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) throw new Error(`Invalid Shanghai day: ${dayKey}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - ZONE_OFFSET_MS;
}

export function nextDailyMomentAt(now = Date.now(), cfg = getConfig().dailyMoments || {}) {
  const c = normalizedConfig(cfg);
  const todayStart = shanghaiDayStart(now);
  const todayTarget = todayStart + (c.hour * 60 + c.minute) * 60 * 1000;
  return todayTarget > now ? todayTarget : todayTarget + DAY_MS;
}

function scheduledDayAt(now, cfg, startup) {
  const todayStart = shanghaiDayStart(now);
  const target = todayStart + (cfg.hour * 60 + cfg.minute) * 60 * 1000;
  if (now >= target) return todayKey(now);
  if (startup && cfg.startupCatchup) return todayKey(todayStart - 1);
  return '';
}

// 固定时刻模式的发送间隔：以上次成功发布为基准，满 intervalDays 天才到期。
// 没有发布记录（或间隔为 1）时视为到期；失败与跳过不重置基准，次日照常重试。
export function momentIntervalDue(now = Date.now(), cfg = getConfig().dailyMoments || {}, records = []) {
  const c = normalizedConfig(cfg);
  if (c.intervalDays <= 1) return true;
  let lastPublished = 0;
  for (const record of records || []) {
    if (!record || record.status !== 'published') continue;
    let at = Number(record.publishedAt) || Number(record.publishStartedAt) || 0;
    if (!at && record.dayKey) {
      try {
        at = dayStartFromKey(record.dayKey);
      } catch {
        at = 0;
      }
    }
    if (at > lastPublished) lastPublished = at;
  }
  if (!lastPublished) return true;
  const days = Math.round((shanghaiDayStart(now) - shanghaiDayStart(lastPublished)) / DAY_MS);
  return days >= c.intervalDays;
}

function cleanText(value, max = 500) {
  // 过 sanitizeUserText：这里处理的全是**外部文本**（群友消息、群名、昵称、印象），而它们最终进的是
  // 带段头结构的提示词（【群聊材料】【总结日期】…）。伪造段头就能冒充系统段 —— sanitizeUserText 的
  // 关键词表里本来就收录了 daily-moments 的段头，说明本应洗，只是漏了这条路径（2026-10-01 审查；
  // 聊天侧 tools-core 的同通道已经洗了，这里是绕过去的第二入口）。
  return sanitizeUserText(String(value ?? '').replace(/\0/g, '').replace(/[ \t]+/g, ' ').trim()).slice(0, max);
}

function momentError(code, message, httpStatus = 409) {
  return Object.assign(new Error(message), { code, httpStatus });
}

function redactPublicContent(value, snapshot) {
  // 用**数字边界**而不是 \b：`QQ12345678`、`id1234567` 这类紧贴字母的号码，\b 匹配不到会原样外发（2026-10-13 审查 P3）。
  // 先把链接摘出来：源头链接里带一串数字很常见（`/p/12345`），连它一起换掉会把正文里唯一
  // 可核实的东西弄成 `[号码已隐藏]`（2026-10-14 复审）。占位符用 \0 包住，号码替换必然穿不过去。
  const urls = [];
  let text = cleanText(value, 1000).replace(/https?:\/\/[^\s，。！？；、"'”）)】]+/g, (url) => `\0${urls.push(url) - 1}\0`);
  text = text.replace(/(?<!\d)[1-9]\d{4,14}(?!\d)/g, '[号码已隐藏]');
  text = text.replace(/\0(\d+)\0/g, (_m, index) => urls[Number(index)] ?? '');
  for (const group of snapshot.groups) {
    const groupName = cleanText(group.groupName, 100);
    if (groupName.length >= 2) text = text.split(groupName).join('某个群');
    const names = new Set([
      ...(group.memories || []).map((member) => member.name),
      ...(group.messages || []).filter((message) => !message.self).map((message) => message.sender)
    ]);
    for (const rawName of names) {
      const name = cleanText(rawName, 60);
      if ((snapshot.selfNames || []).includes(name)) continue;
      if (name.length >= 2) text = text.split(name).join('有人');
    }
  }
  return text;
}

function imageMime(buffer, contentType = '') {
  // 魔数优先（服务端给的 Content-Type 常是 application/octet-stream）；
  // 认不出才回退到它，最后兜一个 jpeg —— 视觉接口只认这几家的 MIME。
  return imageType(buffer) || String(contentType || 'image/jpeg').split(';')[0];
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

function auditMessages(messages) {
  return structuredClone(messages).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    message.content = message.content.map((part) => {
      const url = String(part?.image_url?.url || '');
      if (part?.type !== 'image_url' || !url.startsWith('data:')) return part;
      return {
        ...part,
        image_url: {
          ...part.image_url,
          url: `[inline image omitted from audit snapshot; ${url.length} chars]`
        }
      };
    });
    return message;
  });
}

function buildMomentCandidates(groups, max = 6) {
  const scored = [];
  for (const group of groups) {
    const messages = Array.isArray(group.messages) ? group.messages : [];
    for (const message of messages) {
      const text = String(message?.text || '').trim();
      if (text.length < 4 || text.length > 220) continue;
      if (/^\[(?:图片|表情包|语音|视频|文件)/.test(text)) continue;
      if (/https?:\/\//i.test(text)) continue;
      if (/^(?:收到|好的|哈哈|草|6|？|\?|在吗|早|晚安|谢谢|1|2)$/.test(text)) continue;
      const score = (message.self ? 3 : 0)
        + (text.length >= 8 ? 2 : 0)
        + (/[?？!！…]/.test(text) ? 1 : 0)
        + (Array.isArray(message.images) && message.images.length ? 1 : 0);
      scored.push({ text, self: message.self === true, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  const seen = new Set();
  for (const item of scored) {
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    picked.push({ id: `moment-${picked.length + 1}`, text: item.text, self: item.self });
    if (picked.length >= Math.max(1, Math.min(8, Number(max) || 6))) break;
  }
  return picked;
}

/**
 * 「我的一天」式纪事判断（启发式，只拦最明显的形态）。
 *
 * 素材是当天的**完整日志**，模型很容易把它复述成按时间线走的纪要 —— 线上实测过
 * 「九点、十一点半、两点、四点、七点、十点，一格一格敲过去」「回我的总共三句」
 * 「全天最长的一条是两个字的」这类正文。提示词已经写了禁令但压不干净（实测过：
 * 加了禁令后仍有一半样本在数次数），所以这里再加一道硬闸。
 *
 * 判断错一次的代价只是让模型重写一次（调用方把重写上限设为一次、第二次照收），
 * 不会因为风格判断把当天的发布卡死。
 */
/**
 * 诚实边界硬闸（self 模式）：正文断言了“我”的现实行动/现场，而 self 素材里根本没有
 * 这些事实 —— 提示词管不住的，这里拦一次让模型改成观点/感受（只重写一次，第二次照收，
 * 与纪事体同口径：风格判断不能把当天的发布卡死）。
 * 观点（“我觉得/我想去”）不算；带明确过去时间的动作（今天/刚/上周 去/吃/买/见）才算。
 */
/** 当前人设的兴趣库（roles/interests.json，self 模式的素材引擎）。读不到给空，不挡发布。 */
function loadPersonaInterests() {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('../../roles/interests.json', import.meta.url), 'utf8'));
    const perCard = raw && typeof raw === 'object' ? raw : {};
    const templateId = String(getConfig().persona?.templateId || '').trim();
    const hit = templateId && perCard[templateId] ? perCard[templateId] : null;
    return hit ? { topics: hit.topics || [], stances: hit.stances || [] } : { topics: [], stances: [] };
  } catch {
    return { topics: [], stances: [] };
  }
}

/**
 * self 查重：与最近已发动态的相似度（字符 4-gram Jaccard）。过近 = 换汤不换药，
 * 拒一次让模型换角度重写；没有历史或历史很短时直接放行。
 */
export function similarityReason(text, previous = []) {
  const t = String(text || '').replace(/\s+/g, '');
  if (t.length < 12 || !Array.isArray(previous) || !previous.length) return '';
  const grams = (str) => {
    const set = new Set();
    for (let i = 0; i <= str.length - 4; i += 1) set.add(str.slice(i, i + 4));
    return set;
  };
  const mine = grams(t);
  for (const prev of previous) {
    const text = String(prev || '').replace(/\s+/g, '');
    if (text.length < 12) continue;
    const theirs = grams(text);
    if (!theirs.size) continue;
    let hit = 0;
    for (const g of mine) if (theirs.has(g)) hit += 1;
    if (hit / Math.max(1, Math.min(mine.size, theirs.size)) > 0.45) {
      return '与最近发过的动态太像（大段同样的表达）';
    }
  }
  return '';
}

export function fabricationReason(text) {
  const t = String(text || '');
  if (!t.trim()) return '';
  const action = /(今天|刚|刚刚|上午|下午|晚上|昨天|上周|周末)[^。！？\n]{0,12}?(去|到)了|我(今天|刚|刚刚)[^。！？\n]{0,10}?(吃了|买了|看了|见了|遇到|拿到|做了)|我刚(吃完|到家|下班|跑完)/;
  if (action.test(t)) return '断言了现实行动（去了/吃了/买了这类“我做过”的现场）';
  return '';
}

export function dayRecapReason(text) {
  const t = String(text || '');
  if (!t.trim()) return '';
  // 「N 点」类时间点：裸的「一点」不算（快一点 / 简单一点 / 差一点 / 多留一点 都是口语，
  // 一篇正常动态里出现三次很常见）；带时间前缀的（下午一点）才算。
  // 比较前先把"时间前缀"归一掉：同一个时刻写成「凌晨三点」+「三点」+「三点」时，那本是
  // 同一件事说了三遍，原来会被算成"两种写法"而误判成时间线（2026-10-14 复审）。
  // 后缀 `(?!式)` 放行「三点式支架 / 五点式安全带」这类不含时间的用法。
  // 阿拉伯数字也收（3点起床 / 5点跑步）：提示词的反例是中文数字，模型混用时闸门不能等于不存在。
  const clockPrefix = /^(?:凌晨|早上|上午|中午|下午|傍晚|晚上|半夜|清晨|夜里)/;
  const clockOf = (token) => token.replace(/\s+/g, '').replace(clockPrefix, '');
  const all = t.match(/(?:凌晨|早上|上午|中午|下午|傍晚|晚上|半夜|清晨|夜里)?\s*[零〇一二三四五六七八九十百两\d]{1,3}\s*点(?:半|整|\d{1,2}\s*分?)?(?!式)/g) || [];
  // 只滤掉口语里的**裸「一点」**（快一点 / 简单一点 / 差一点 / 多留一点，一篇正常动态出现三次很常见）；
  // 「一点半/一点整」是真时间，不能一起滤掉，否则"一点半、三点、五点"这种时间线会漏过去。
  const clocks = all.map(clockOf).filter((token) => !/^一点$/.test(token))
    .concat(t.match(/\d{1,2}\s*[:：]\s*\d{2}/g) || []);
  // 三处以上、且有至少两种写法，才算"按时间线讲当天"
  if (clocks.length >= 3 && new Set(clocks).size >= 2) {
    return '出现了三处以上具体时间点';
  }
  // 不写具体钟点、但按早中晚一路推进，同样是"我的一天"；线上 9/30 的样本就是这样漏过去的。
  const periods = t.match(/早上|上午|中午|下午|傍晚|晚上|夜里|凌晨/g) || [];
  if (periods.length >= 3) return '出现了从早到晚的时间段';
  if (/(今天群里|群里今天|一天下来|一整天|我的一天|从早到晚)/.test(t)) {
    return '出现了“今天群里/一天下来”这类日报口径';
  }
  // 统计口径：必须紧挨"次/回"这类计数才算（"一共就这点事""一共三个人搭话"不算）
  if (/(回我的?总共|总共\s*[^。！？\n]{0,6}?(?:次|回)|一共\s*[^。！？\n]{0,6}?(?:次|回)|全天最长|全天最短|一天里我)/.test(t)) {
    return '出现了“总共 / 全天最长”这类统计口径';
  }
  const counts = t.match(/(?:回了|报了|发了|念了|数了)\s*[零一二三四五六七八九十两\d]{1,3}\s*(?:次|回|句|条)/g) || [];
  if (counts.length >= 2) return '在两处数自己说了几次、别人回了几句';
  return '';
}

function sanitizeDecision(raw, snapshot, cfg, { allowRecap = false } = {}) {
  const fail = (message) => { throw momentError('MOMENT_DECISION_INVALID', message, 422); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('提交参数必须为 JSON 对象');
  const source = raw;
  if (!['publish', 'skip'].includes(source.decision)) fail('decision 必须为 publish 或 skip');
  if (typeof source.reason !== 'string' || !source.reason.trim()) fail('reason 必须填写一句非空的决定理由');
  if (typeof source.content !== 'string') fail('content 必须为字符串');
  if (source.decision === 'publish' && !source.content.trim()) fail('发布正文不能为空');
  if (source.decision === 'skip' && source.content.trim()) fail('skip 时正文应为空；要发布请使用 publish');
  if (!Array.isArray(source.imageIds) || source.imageIds.some((id) => typeof id !== 'string')) {
    fail('imageIds 必须为图片 ID 数组，不配图时填 []');
  }
  if (source.decision === 'skip' && source.imageIds.length) fail('skip 时 imageIds 应为空数组');
  if (source.imageIds.length > cfg.maxImages) fail(`配图不能超过 ${cfg.maxImages} 张`);
  if (!Array.isArray(source.groupSummaries)) fail('groupSummaries 必须为内部群摘要数组');
  const decision = source.decision;
  const knownGroups = new Map(snapshot.groups.map((group) => [group.chatKey, group]));
  const submitted = new Map();
  for (const item of source.groupSummaries) {
    const chatKey = String(item?.chatKey || '');
    if (!knownGroups.has(chatKey) || submitted.has(chatKey)) fail('群摘要包含未知或重复的 chatKey');
    if (typeof item?.summary !== 'string' || !item.summary.trim()) fail('每个群的 summary 必须非空');
    submitted.set(chatKey, cleanText(item.summary, 500));
  }
  if (submitted.size !== knownGroups.size) fail('请为材料中的每个群提交一条内部摘要');
  const groupSummaries = snapshot.groups.map((group) => ({
    chatKey: group.chatKey,
    groupName: group.groupName,
    summary: submitted.get(group.chatKey)
  }));
  const knownImages = new Set(snapshot.imageCandidates.map((image) => image.id));
  if (source.imageIds.some((id) => !knownImages.has(id))) fail('只能选择本次候选图片 ID');
  if (!cfg.allowImages && source.imageIds.length) fail('配图已关闭，请使用空 imageIds');
  const imageIds = [...new Set(source.imageIds)];
  const content = decision === 'publish' ? redactPublicContent(source.content, snapshot) : '';
  if (decision === 'publish' && snapshot.source === 'self') {
    const fabricated = fabricationReason(content);
    if (fabricated) {
      const error = momentError('MOMENT_DECISION_INVALID',
        `正文${fabricated}，但今天没有任何现实素材。改成观点、感受或打算（“想吃”“想去”），不要写成已经发生的事。`, 422);
      error.fabricationRejected = true;
      throw error;
    }
  }
  if (decision === 'publish' && snapshot.source === 'self') {
    const dup = similarityReason(content, (snapshot.recentPublished || []));
    if (dup) {
      const error = momentError('MOMENT_DECISION_INVALID',
        `正文${dup}。换个角度重写：换一个话题或换一种说法，不要沿用上次的大段表达。`, 422);
      error.duplicateRejected = true;
      throw error;
    }
  }
  if (decision === 'publish' && !allowRecap) {
    const recap = dayRecapReason(content);
    if (recap) {
      const error = momentError('MOMENT_DECISION_INVALID',
        `正文${recap}，读起来像在给当天做纪要。请压成一件事重写：不排时间线、不做统计、不逐条引用群友，只写你此刻最想说的那一点，其余素材丢掉。`, 422);
      error.recapRejected = true;
      throw error;
    }
  }
  return {
    decision,
    reason: cleanText(source.reason, 500),
    content,
    imageIds: cfg.allowImages ? imageIds : [],
    groupSummaries
  };
}

export class DailyMomentsManager {
  constructor({
    store,
    memory,
    stickers,
    onebot,
    sessions = null,
    resolveChatName = async () => '',
    emit = null,
    complete = chatCompletionWithRetry,
    search = webSearch,
    fetchPage = fetchWebPage,
    validateImage = validateImageUrl,
    fetchBinary = safeFetchBinary,
    setProactiveSuppressed = () => {},
    getLifeFeed = null,
    now = () => Date.now(),
    random = Math.random,
    log = console.log,
    stateFile = STATE_FILE
  }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.onebot = onebot;
    this.sessions = sessions;
    this.resolveChatName = resolveChatName;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.complete = complete;
    this.search = search;
    this.fetchPage = fetchPage;
    this.validateImage = validateImage;
    this.fetchBinary = fetchBinary;
    this.setProactiveSuppressed = setProactiveSuppressed;
    this.getLifeFeed = typeof getLifeFeed === 'function' ? getLifeFeed : (() => null);
    this.now = now;
    this.random = random;
    this.log = log;
    this.stateFile = stateFile;
    this.state = readJson(this.stateFile, { version: 1, records: [] });
    if (!Array.isArray(this.state.records)) this.state.records = [];
    if (!Array.isArray(this.state.scheduleSlots)) this.state.scheduleSlots = [];
    this.timer = null;
    this.running = null;
    this.controller = null;
    this.nextRunAt = 0;
    this.stopped = true;
    this.abortRequested = false;
    let recovered = false;
    for (const record of this.state.records) {
      if (!['running', 'publishing'].includes(record.status)) continue;
      const publishing = record.status === 'publishing';
      record.status = publishing ? 'publish-unknown' : 'interrupted';
      record.error = publishing
        ? '发布时服务中断，结果待核对，不会自动重发'
        : '生成期间服务中断，可以重新生成';
      record.endedAt = this.now();
      recovered = true;
    }
    for (const slot of this.state.scheduleSlots) {
      if (slot.status !== 'running') continue;
      const record = this.state.records.find((item) => item.scheduleSlotId === slot.id);
      slot.status = record?.status || 'interrupted';
      slot.reason = record?.error || '执行期间服务中断，未自动重试';
      recovered = true;
    }
    if (recovered) writeJson(this.stateFile, this.state);
  }

  start({ startup = true } = {}) {
    this.stop();
    this.abortRequested = false;
    const cfg = normalizedConfig();
    if (!cfg.enabled) return;
    const target = shanghaiDayStart(this.now()) + (cfg.hour * 60 + cfg.minute) * 60000;
    this.fixedSkipDay = !cfg.startupCatchup && this.now() >= target ? todayKey(this.now()) : '';
    this.#updatePlan(cfg, startup);
    this.stopped = false;
    this.#schedule(15000, startup);
  }

  reconfigure() {
    if (normalizedConfig().enabled) this.start({ startup: false });
    else {
      this.stop();
      void this.abort();
    }
  }

  stop() {
    this.stopped = true;
    this.scheduleVersion = (this.scheduleVersion || 0) + 1;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = 0;
  }

  abort(timeoutMs = 5000) {
    const running = this.running;
    this.abortRequested = true;
    this.controller?.abort(momentError('MOMENT_STOPPED', '每日动态已停止'));
    if (!running) return Promise.resolve();
    return settleWithDeadline([running], timeoutMs);
  }

  status() {
    const cfg = normalizedConfig();
    const slots = this.state.scheduleSlots;
    const nextSlot = slots.find((slot) => slot.status === 'pending');
    return {
      enabled: cfg.enabled,
      running: Boolean(this.running),
      task: this.task || null,
      intervalDays: cfg.intervalDays,
      nextRunAt: !cfg.enabled ? 0 : cfg.scheduleWindows
        ? (nextSlot ? Math.max(nextSlot.at, this.nextRunAt || 0) : 0)
        : (this.nextRunAt || nextDailyMomentAt(this.now(), cfg)),
      scheduleMode: cfg.scheduleWindows ? 'windows' : 'fixed',
      scheduleSlots: cfg.scheduleWindows
        ? slots.filter((slot) => slot.endAt >= shanghaiDayStart(this.now())).map((slot) => ({ ...slot }))
        : [],
      lastScheduleCheck: this.state.lastScheduleCheck || null,
      latest: this.state.records[0] || null,
      records: this.state.records.slice(0, 14)
    };
  }

  async runNow({
    dayKey = todayKey(this.now()),
    publish = false,
    force = false,
    confirmDuplicateRisk = false
  } = {}) {
    return this.run({
      dayKey,
      publish,
      force,
      confirmDuplicateRisk,
      source: publish ? 'manual-publish' : 'manual-preview'
    });
  }

  async run(options = {}) {
    return this.#exclusive('generate', () => this.#run(options));
  }

  async #exclusive(task, execute) {
    if (this.running) throw momentError('MOMENT_BUSY', '已有动态任务正在执行，请等待完成');
    // 「核对 / 确认结果 / 编辑草稿」都是本地操作：编辑不在活跃时段也应该能做
    //（否则管理员只能等窗口，草稿会被卡住 —— 2026-10-24 审查 P2）。
    if (!['reconcile', 'resolve-record', 'edit-draft'].includes(task)) assertTimeAllowed('');
    this.setProactiveSuppressed(true);
    this.task = task;
    this.running = Promise.resolve().then(execute).finally(() => {
      this.running = null;
      this.controller = null;
      this.task = null;
      this.setProactiveSuppressed(false);
      this.emit('daily-moments-status', this.status());
    });
    this.emit('daily-moments-status', this.status());
    return this.running;
  }

  #schedule(delay, startup = false, targetAt = 0) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const wait = Math.max(1000, Number(delay) || 1000);
    const version = this.scheduleVersion;
    this.nextRunAt = Number(targetAt) || (this.now() + wait);
    this.timer = setTimeout(() => {
      withTrace(newTraceId(), () => this.#tick(startup, version)).catch((error) => {
        this.log('[daily-moments] scheduler error:', error);
        if (!this.stopped && version === this.scheduleVersion) this.#schedule(60000);
      });
    }, wait);
    this.timer.unref?.();
  }

  async #tick(startup, version) {
    if (this.stopped || version !== this.scheduleVersion) return;
    const cfg = normalizedConfig();
    if (!cfg.enabled) return;
    if (cfg.scheduleWindows) return this.#tickWindows(cfg, startup, version);
    const timeState = timeControlState(getConfig().timeControl, '', this.now());
    if (!timeState.active) {
      this.deferredDay ||= scheduledDayAt(this.now(), cfg, startup);
      this.#schedule(timeState.nextActiveAt ? timeState.nextActiveAt - this.now() + 1 : 60000);
      return;
    }
    // 暂停/观察期间不跑：run() 要等模型返回后才在发布闸门抛 MOMENT_INACTIVE，而那个错误
    // 会被记成 failed 并进入阻断集合 —— 当天剩下的定时轮次全被挡掉（白花一次模型调用）。
    // 每分钟再检查一次，恢复后由正常的到期判定决定补发还是等下一个点。
    const runtime = getConfig().runtime || {};
    if (runtime.mode !== 'active' || runtime.paused) {
      // 不要在这里钉 deferredDay：暂停跨天后它会把"旧的一天"带进恢复后的运行。
      // 恢复时由 scheduledDayAt 重新判断（当天已过点就补发当天，未到点就等）；
      // startup 要继续传，否则启动时暂停会把"昨天错过点"的启动补发吞掉。
      this.#schedule(60000, startup);
      return;
    }
    if (cfg.enabled) {
      const dayKey = this.deferredDay || scheduledDayAt(this.now(), cfg, startup);
      this.deferredDay = '';
      const draft = dayKey && !cfg.autoPublish
        ? this.state.records.find((record) => record.dayKey === dayKey && record.status === 'preview')
        : null;
      const blocked = dayKey && (this.#blockingRecord({ dayKey, source: 'scheduled' }) || draft);
      if (dayKey && (blocked || dayKey === this.fixedSkipDay)) {
        this.#scheduleCheck({
          dayKey, status: blocked ? 'blocked' : 'missed',
          reason: blocked ? `定时任务已处理或发布结果待核对：${blocked.status}` : '启动时已错过固定时刻，未开启补跑',
          recordId: blocked?.id || ''
        });
      } else if (dayKey && !momentIntervalDue(this.now(), cfg, this.state.records)) {
        this.#scheduleCheck({
          dayKey, status: 'waiting',
          reason: `未到发送间隔（每 ${cfg.intervalDays} 天）`
        });
      } else if (dayKey) {
        try {
          await this.run({ dayKey, publish: cfg.autoPublish === true, source: startup ? 'startup-catchup' : 'scheduled' });
        } catch (error) {
          // MOMENT_BUSY（腾讯侧忙）与 TIME_CONTROL_INACTIVE 同样要"保持到期"：
          // 丢了 deferredDay 就等于跳过今天（窗口模式本来就把它判 pending，
          // 固定时刻模式却直接放走 —— 2026-10-10 审查 C3）。
          if (error?.code === 'TIME_CONTROL_INACTIVE' || error?.code === 'MOMENT_BUSY') this.deferredDay = dayKey;
          else this.log('[daily-moments] run failed:', error);
        }
      }
    }
    if (!this.stopped && version === this.scheduleVersion) {
      const next = this.deferredDay
        ? timeControlState(getConfig().timeControl, '', this.now()).nextActiveAt || this.now() + 60000
        : nextDailyMomentAt(this.now(), cfg);
      this.#schedule(
        Math.min(next - this.now() + 1000, 60 * 60 * 1000),
        false,
        next
      );
    }
  }

  #blockingRecord(target, publishingOnly = false) {
    return this.state.records.find((record) =>
      record.id !== target.id
      && samePublicationScope(record, target)
      && (publishingOnly ? PUBLICATION_STATUSES : BLOCKING_STATUSES).has(record.status));
  }

  #scheduleCheck(check) {
    this.state.lastScheduleCheck = { ...check, at: this.now() };
    writeJson(this.stateFile, this.state);
    this.emit('daily-moments-status', this.status());
  }

  #updatePlan(cfg, startup = false) {
    if (updateMomentPlan(this.state.scheduleSlots, cfg.scheduleWindows, this.now(), this.random, {
      startup, catchup: cfg.startupCatchup
    })) writeJson(this.stateFile, this.state);
  }

  #interruptSlot(slot) {
    const record = this.state.records.find((item) => item.scheduleSlotId === slot.id);
    slot.status = record?.status && record.status !== 'running' ? record.status : 'interrupted';
    slot.recordId = record?.id || '';
    slot.reason = record?.error || '执行已停止';
    writeJson(this.stateFile, this.state);
  }

  async #tickWindows(cfg, startup, version) {
    this.#updatePlan(cfg);
    const pending = this.state.scheduleSlots.filter((slot) => slot.status === 'pending');
    const slot = pending.find((item) => item.at <= this.now());
    if (slot) {
      const root = getConfig();
      const time = timeControlState(root.timeControl, '', this.now());
      const unresolved = this.state.records.find((record) =>
        ['publishing', 'publish-unknown'].includes(record.status));
      const lastAttempt = this.state.records.reduce((latest, record) =>
        Math.max(latest, Number(record.publishStartedAt) || Number(record.publishedAt) || 0), 0);
      const reason = this.running ? '其他动态任务正在执行'
        : root.runtime?.mode !== 'active' || root.runtime?.paused ? '机器人处于观察或暂停状态'
        : !time.active ? '等待活跃时间'
        : unresolved ? '存在发布结果待核对的动态'
        : this.now() - lastAttempt < MOMENT_MIN_GAP_MS ? '等待发布间隔（5 分钟）'
        : '';
      if (reason) {
        if (slot.reason !== reason) {
          slot.reason = reason;
          this.#scheduleCheck({ dayKey: slot.dayKey, slotId: slot.id, status: 'waiting', reason });
        }
      } else {
        slot.status = 'running';
        slot.reason = '';
        writeJson(this.stateFile, this.state);
        try {
          const result = await this.run({
            // 用槽位自己的 dayKey：跨午夜的槽在 0 点后执行时，todayKey 已是新的一天，
            // 查重/记录会挂错日期（2026-10-10 审查 C4）
            dayKey: slot.dayKey, publish: cfg.autoPublish === true,
            source: startup ? 'startup-catchup' : 'scheduled', scheduleSlot: { ...slot }
          });
          // 停机/重排后旧 tick 不能再把 slot 写回 running 或覆盖新一代计划。
          if (this.stopped || version !== this.scheduleVersion) return this.#interruptSlot(slot);
          slot.status = result.record.status;
          slot.recordId = result.record.id;
          slot.reason = result.record.error || result.record.reason || '';
        } catch (error) {
          if (this.stopped || version !== this.scheduleVersion) return this.#interruptSlot(slot);
          const record = this.state.records.find((item) => item.scheduleSlotId === slot.id);
          // 错误码优先于记录状态：被时间控制/忙碌打断时必须回 pending（窗口还开着就该再试），
          // 而 #run 已经把记录写成 'deferred' —— 那个值不在任何恢复分支里，计划会被静默吞掉（2026-10-13 全项目审查 P2-2）。
          slot.status = ['MOMENT_BUSY', 'TIME_CONTROL_INACTIVE'].includes(error.code)
            ? 'pending'
            : (record?.status || 'failed');
          slot.recordId = record?.id || '';
          slot.reason = cleanText(error?.message ?? error, 1000);
        }
        this.#scheduleCheck({ dayKey: slot.dayKey, slotId: slot.id, status: slot.status, reason: slot.reason, recordId: slot.recordId });
      }
    }
    if (!this.stopped && version === this.scheduleVersion) {
      const next = this.state.scheduleSlots.find((item) => item.status === 'pending');
      const nextAt = next ? (next.at <= this.now() ? Math.min(next.endAt, this.now() + 30000) : next.at) : this.now() + 3600000;
      this.#schedule(Math.min(3600000, nextAt - this.now()), false, nextAt);
    }
  }

  #saveRecord(record) {
    const index = this.state.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.state.records[index] = record;
    else this.state.records.unshift(record);
    this.state.records = this.state.records.slice(0, 90);
    writeJson(this.stateFile, this.state);
    this.emit('daily-moments-status', this.status());
  }

  async #run({
    dayKey = todayKey(this.now()),
    publish = true,
    force = false,
    confirmDuplicateRisk = false,
    source = 'scheduled',
    scheduleSlot = null
  } = {}) {
    const cfg = normalizedConfig();
    dayStartFromKey(dayKey);
    const automatic = automaticSource(source);
    const previous = (publish || automatic) && this.#blockingRecord({
      dayKey, source, scheduleSlotId: scheduleSlot?.id || ''
    }, !automatic);
    if (previous && publish && force && !confirmDuplicateRisk) {
      throw momentError(
        'MOMENT_DUPLICATE_CONFIRMATION_REQUIRED',
        '该日期可能已经发布；重新运行需明确确认重复发布风险'
      );
    }
    const allowManualDuplicate = !automatic && publish && force && confirmDuplicateRisk;
    if (previous && !allowManualDuplicate) {
      return { ok: true, alreadyAttempted: true, record: previous };
    }
    if (publish && getConfig().runtime?.mode !== 'active') {
      throw new Error('当前不是 active 模式，禁止自动发布说说');
    }

    const record = {
      id: crypto.randomUUID(),
      dayKey,
      source,
      scheduleSlotId: scheduleSlot?.id || '',
      scheduleAt: scheduleSlot?.at || 0,
      scheduleEndAt: scheduleSlot?.endAt || 0,
      promptVersion: MOMENT_PROMPT_VERSION,
      personaHash: momentPersonaHash(getConfig().persona, this.onebot?.selfNickname || ''),
      accountId: String(this.onebot.selfId || ''),
      publishAttempted: false,
      status: 'running',
      startedAt: this.now(),
      endedAt: 0,
      groupCount: 0,
      groupSummaries: [],
      decision: '',
      reason: '',
      content: '',
      imageIds: [],
      imageCount: 0,
      imageErrors: [],
      researchCalls: 0,
      tid: '',
      usage: emptyUsage(),
      model: '',
      error: ''
    };
    this.#saveRecord(record);
    this.controller = new AbortController();
    if (this.abortRequested) this.controller.abort(momentError('MOMENT_STOPPED', '每日动态已停止'));
    const releaseTimeGuard = watchTimeWindow((error) => this.controller?.abort(error), '');
    let releaseGroupGuards = () => {};
    const timeout = setTimeout(() => this.controller?.abort(new Error('Daily moments run timed out')), 10 * 60 * 1000);
    timeout.unref?.();
    const windowTimeout = scheduleSlot ? setTimeout(() => this.controller?.abort(
      momentError('MOMENT_WINDOW_EXPIRED', '已超过允许发布时间范围，本次未发布')
    ), Math.max(1, scheduleSlot.endAt - this.now())) : null;
    windowTimeout?.unref?.();
    let session = null;

    try {
      const snapshot = await this.#collectSnapshot(dayKey, cfg);
      const timeScopes = ['', ...snapshot.groups.map((group) => group.chatKey)];
      releaseGroupGuards = watchTimeWindow((error) => this.controller?.abort(error), timeScopes);
      this.controller.signal.throwIfAborted();
      record.groupCount = snapshot.groups.length;
      record.contentSource = snapshot.source;
      if (!snapshot.groups.length && snapshot.source !== 'self') {
        Object.assign(record, {
          status: 'skipped',
          decision: 'skip',
          reason: '当天没有达到条件的群聊记录',
          endedAt: this.now()
        });
        this.#saveRecord(record);
        return { ok: true, record };
      }

      session = this.sessions?.create({
        chatKey: 'system:daily-moments',
        trigger: 'daily-moments',
        triggerSummary: `${dayKey} 每日动态`
      }) || null;
      if (session) {
        record.sessionId = session.id;
        session.chatName = '每日动态';
        session.model = getConfig().api?.model || '';
        session.conversationMode = 'legacy';
      }

      const modelResult = await withTimeScope(timeScopes, () =>
        this.#decide(snapshot, cfg, session, this.controller.signal)
      );
      record.groupSummaries = modelResult.decision.groupSummaries;
      record.decision = modelResult.decision.decision;
      record.reason = modelResult.decision.reason;
      record.content = modelResult.decision.content;
      record.imageIds = modelResult.decision.imageIds;
      record.researchCalls = modelResult.researchCalls;
      record.researchSources = modelResult.researchSources;
      record.usage = modelResult.usage;
      record.model = modelResult.model;
      record.personaHash = modelResult.personaHash;
      record.imageRefs = record.imageIds.map((id) => {
        const candidate = snapshot.imageMap.get(id);
        const { prepared, fallbackUrl, ...ref } = candidate;
        return ref;
      });
      record.imageCount = record.imageIds.length;

      if (!publish) {
        record.status = 'preview';
        record.endedAt = this.now();
        this.#saveRecord(record);
        this.#finishSession(session, record);
        return { ok: true, preview: true, record };
      }
      if (record.decision !== 'publish' || !record.content) {
        record.status = 'skipped';
        record.endedAt = this.now();
        this.#saveRecord(record);
        this.#finishSession(session, record);
        return { ok: true, record };
      }

      const result = await this.#publishRecord(record, snapshot, this.controller.signal, {
        force,
        confirmDuplicateRisk
      });
      this.#finishSession(session, record);
      return result;
    } catch (error) {
      if (record.status !== 'publish-unknown') {
        record.status = error?.code === 'MOMENT_WINDOW_EXPIRED' ? 'missed'
          : error?.code === 'MOMENT_STOPPED' ? 'interrupted'
            : error?.code === 'TIME_CONTROL_INACTIVE' ? 'deferred' : 'failed';
        if (session) {
          record.usage = { ...session.usage };
          record.model = session.model || record.model;
        }
        record.error = cleanText(error?.message ?? error, 1000);
        record.endedAt = this.now();
        this.#saveRecord(record);
      }
      this.#finishSession(session, record, error);
      throw error;
    } finally {
      releaseTimeGuard();
      releaseGroupGuards();
      clearTimeout(timeout);
      clearTimeout(windowTimeout);
    }
  }

  #assertPublishAllowed(record, signal) {
    signal?.throwIfAborted();
    assertTimeAllowed(['', ...(record.groupSummaries || []).map((group) => group.chatKey)]);
    const cfg = getConfig();
    if (automaticRecord(record) && record.scheduleSlotId) {
      const slot = this.state.scheduleSlots.find((item) => item.id === record.scheduleSlotId);
      const window = cfg.dailyMoments?.scheduleWindows?.find((item) =>
        `${item.start}-${item.end}` === slot?.windowKey);
      if (!window || slot.index >= window.count) {
        throw momentError('MOMENT_SCHEDULE_CHANGED', '本次计划已取消或修改，未发布');
      }
      if (this.now() >= record.scheduleEndAt) {
        throw momentError('MOMENT_WINDOW_EXPIRED', '已超过允许发布时间范围，本次未发布');
      }
    }
    if (cfg.runtime?.mode !== 'active' || cfg.runtime?.paused) {
      throw momentError('MOMENT_INACTIVE', '机器人处于观察或暂停状态，禁止发布');
    }
    if (['scheduled', 'startup-catchup'].includes(record.source) && cfg.dailyMoments?.enabled !== true) {
      throw momentError('MOMENT_DISABLED', '每日动态已关闭，取消本次自动发布');
    }
    if (record.accountId && record.accountId !== String(this.onebot.selfId || '')) {
      throw momentError('MOMENT_ACCOUNT_CHANGED', 'QQ 登录账号已改变，请重新生成草稿');
    }
    if (record.promptVersion !== MOMENT_PROMPT_VERSION
      || record.personaHash !== momentPersonaHash(cfg.persona, this.onebot?.selfNickname || '')) {
      throw momentError('MOMENT_PERSONA_CHANGED', '草稿的人设或提示词已过期，请按当前设置重新生成');
    }
    if ((record.groupSummaries || []).some((group) => !chatAllowed(group.chatKey, cfg))) {
      throw momentError('MOMENT_SOURCE_CHANGED', '素材会话已移出白名单，请重新生成');
    }
  }

  async #publishRecord(record, snapshot, signal, {
    force = false,
    confirmDuplicateRisk = false
  } = {}) {
    this.#assertPublishAllowed(record, signal);
    const blocked = this.#blockingRecord(record, true);
    if (blocked && force && !confirmDuplicateRisk) {
      throw momentError(
        'MOMENT_DUPLICATE_CONFIRMATION_REQUIRED',
        '该日期可能已经发布；发布草稿需明确确认重复发布风险'
      );
    }
    if (blocked && !(force && confirmDuplicateRisk)) {
      return { ok: true, alreadyAttempted: true, record: blocked };
    }
    const cfg = normalizedConfig();
    const imageSources = [];
    record.imageErrors = [];
    for (const imageId of cfg.allowImages ? record.imageIds.slice(0, cfg.maxImages) : []) {
      try {
        const prepared = await this.#loadImageCandidate(snapshot, imageId, signal);
        if (prepared?.uploadSource) imageSources.push(prepared.uploadSource);
        else record.imageErrors.push(`${imageId}: 图片来源已失效，本次不配此图`);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        record.imageErrors.push(`${imageId}: ${cleanText(error?.message ?? error, 240)}`);
      }
    }
    const duplicate = await this.#findDuplicate(record.content, signal);
    if (duplicate) {
      Object.assign(record, {
        status: 'published', tid: String(duplicate.tid),
        deduplicated: true, endedAt: this.now(), error: ''
      });
      this.#saveRecord(record);
      return { ok: true, deduplicated: true, record };
    }

    this.#assertPublishAllowed(record, signal);
    const latestCfg = normalizedConfig();
    const images = latestCfg.allowImages ? imageSources.slice(0, latestCfg.maxImages) : [];
    Object.assign(record, {
      status: 'publishing', publishAttempted: true, publishStartedAt: this.now(),
      imageCount: images.length, visibility: latestCfg.visibility, error: ''
    });
    this.#saveRecord(record);
    try {
      const result = await this.#publishMoment(record.content, images, latestCfg, signal);
      if (typeof result?.tid !== 'string' || !result.tid.trim()) {
        throw momentError('MOMENT_PUBLISH_UNKNOWN', 'Qzone 未返回说说 ID，发布结果待核对', 502);
      }
      Object.assign(record, {
        status: 'published', tid: result.tid, endedAt: this.now(), publishedAt: this.now()
      });
      this.#saveRecord(record);
      return { ok: true, record };
    } catch (error) {
      // ⚠️ 只有**结果不确定**的失败才记 publish-unknown（超时 / 无 tid / 发送中重启 ——
      // 见 docs/DAILY_MOMENTS.md 那张表）。协议端**明确拒绝**（OneBotActionError 带
      // outcome:'failed' 与 retcode，如 retcode=100）是有确定答复的：这条根本没发出去，
      // 记成待核对会让 unresolved 挡住**所有**后续时段，直到人工去点 resolveRecord()
      //（2026-10-04 全面复审 P2：一个明确的拒绝就能把整条排期卡死）。
      const definite = error?.outcome === 'failed'
        || (error?.retcode !== undefined && error?.retcode !== null && error?.retcode !== '');
      record.status = definite ? 'failed' : 'publish-unknown';
      record.error = cleanText(error?.message ?? error, 1000);
      record.endedAt = this.now();
      this.#saveRecord(record);
      throw error;
    }
  }

  /** 编辑预览草稿的正文（发布前的人工修正）。只允许 preview+publish 决策的草稿。 */
  async editDraft(id, { content } = {}) {
    return this.#exclusive('edit-draft', async () => {
      const record = this.state.records.find((item) => item.id === id);
      if (!record) throw momentError('MOMENT_NOT_FOUND', '草稿不存在', 404);
      if (record.status !== 'preview' || record.decision !== 'publish') {
        throw momentError('MOMENT_NOT_DRAFT', '只有待发布的草稿可以编辑', 409);
      }
      const text = String(content ?? '').trim();
      if (!text) throw momentError('MOMENT_DECISION_INVALID', '正文不能为空', 422);
      if (text.length > 2000) throw momentError('MOMENT_DECISION_INVALID', '正文太长（上限 2000 字）', 422);
      // 先校验、后赋值：record 是内存里同一个对象，旧实现先写 record.content 再校验，
      // 校验失败只抛错不落盘 —— 但内存已经是违规正文，之后直接点发布就会把它发出去
      //（2026-10-24 审查 P1）。
      if (record.contentSource === 'self') {
        const fabricated = fabricationReason(text);
        if (fabricated) {
          throw momentError('MOMENT_DECISION_INVALID', `编辑后的正文${fabricated}，self 模式不发现实行动断言`, 422);
        }
      }
      record.content = text;
      record.editedAt = this.now();
      record.editedBy = 'manual';
      this.#saveRecord(record);
      return { ok: true, record };
    });
  }

  async publishDraft(id, {
    force = false,
    confirmDuplicateRisk = false
  } = {}) {
    return this.#exclusive('publish-draft', async () => {
      // 停机/停用收尾期间不再发起新的 Qzone 写：否则进程被杀后记录会停在 publishing 变成 unknown。
      if (this.abortRequested) throw momentError('MOMENT_STOPPED', '服务正在停止，本次发布已取消', 409);
      const record = this.state.records.find((item) => item.id === id);
      if (!record) throw momentError('MOMENT_NOT_FOUND', '草稿不存在', 404);
      if (PUBLICATION_STATUSES.has(record.status)) {
        return { ok: true, alreadyAttempted: true, record };
      }
      if (record.status !== 'preview' || record.decision !== 'publish' || !record.content?.trim()) {
        throw momentError('MOMENT_NOT_DRAFT', '这不是可发布的草稿，请重新生成');
      }
      // 发布前再判一次事实边界：旧实现只在编辑入口校验，内存被绕过（或手改记录）后
      // 违规正文仍能直接发出去（2026-10-24 审查 P1）。
      if (record.contentSource === 'self') {
        const fabricated = fabricationReason(record.content);
        if (fabricated) {
          throw momentError('MOMENT_DECISION_INVALID', `这份草稿${fabricated}，self 模式不发现实行动断言；请编辑后再发布`, 422);
        }
      }
      record.publicationSource = 'manual';
      this.controller = new AbortController();
      const scopes = ['', ...record.groupSummaries.map((group) => group.chatKey)];
      const release = watchTimeWindow((error) => this.controller?.abort(error), scopes);
      try {
        const snapshot = { imageMap: new Map((record.imageRefs || []).map((ref) => [ref.id, { ...ref }])) };
        return await this.#publishRecord(record, snapshot, this.controller.signal, {
          force,
          confirmDuplicateRisk
        });
      } catch (error) {
        if (!record.publishAttempted) {
          record.error = cleanText(error?.message ?? error, 1000);
          this.#saveRecord(record);
        }
        throw error;
      } finally {
        release();
      }
    });
  }

  async reconcile(id) {
    return this.#exclusive('reconcile', async () => {
      const record = this.state.records.find((item) => item.id === id);
      if (!record) throw momentError('MOMENT_NOT_FOUND', '记录不存在', 404);
      if (record.status === 'published') return { ok: true, matched: true, record };
      if (record.status !== 'publish-unknown' || !record.content) {
        throw momentError('MOMENT_NOT_UNCERTAIN', '该记录无需核对发布结果');
      }
      if (record.accountId && record.accountId !== String(this.onebot.selfId || '')) {
        throw momentError('MOMENT_ACCOUNT_CHANGED', '请使用发布时的 QQ 账号核对');
      }
      const found = await this.#findDuplicate(record.content);
      if (found) {
        Object.assign(record, { status: 'published', tid: String(found.tid), error: '', reconciledAt: this.now() });
        const slot = this.state.scheduleSlots.find((item) => item.id === record.scheduleSlotId);
        if (slot) {
          Object.assign(slot, { status: 'published', recordId: record.id, reason: '已在空间核对到发布结果' });
        }
        this.#saveRecord(record);
      }
      return { ok: true, matched: Boolean(found), record };
    });
  }

  /**
   * 人工终局：reconcile 只能靠"到空间里找到那条说说"来收敛，找不到时记录会一直停在
   * publish-unknown，#tickWindows 的 unresolved 检查会把**所有**时段的发布全部挡住，
   * 且记录没有保留期清理——等于功能无限期停摆。这里给管理员一个明确出口：
   *   missed → publish-missed（确认没发出去：解除阻断，同天允许重新发布）
   *   sent   → published（确认已发出：保持"这条已发布"的阻断语义，不会重发）
   * 只处理 publish-unknown / publishing 两种未决状态；必须由控制台带 confirm 调用。
   */
  async resolveRecord(id, { result = '' } = {}) {
    return this.#exclusive('resolve-record', async () => {
      const record = this.state.records.find((item) => item.id === id);
      if (!record) throw momentError('MOMENT_NOT_FOUND', '记录不存在', 404);
      if (!['publishing', 'publish-unknown'].includes(record.status)) {
        throw momentError('MOMENT_NOT_UNCERTAIN', '该记录无需人工核对', 409);
      }
      if (result === 'missed') {
        Object.assign(record, { status: 'publish-missed', error: '', resolvedAt: this.now() });
      } else if (result === 'sent') {
        Object.assign(record, { status: 'published', error: '', resolvedAt: this.now() });
      } else {
        throw momentError('MOMENT_RESOLVE_RESULT', 'result 必须是 missed（确认没发出去）或 sent（确认已发出）', 400);
      }
      const slot = this.state.scheduleSlots.find((item) => item.id === record.scheduleSlotId);
      if (slot) {
        Object.assign(slot, {
          status: record.status, recordId: record.id,
          reason: result === 'missed' ? '人工确认未发出，已解除待核对' : '人工确认已发出'
        });
      }
      this.#saveRecord(record);
      return { ok: true, record };
    });
  }

  #finishSession(session, record, error = null) {
    if (!session || !this.sessions?.current?.has(session.id)) return;
    session.usage = { ...record.usage };
    session.model = record.model || session.model;
    session.finishReason = record.reason || record.status;
    session.outcome = {
      sent: record.status === 'published' ? 1 : 0,
      finishReason: session.finishReason
    };
    if (record.status === 'published') {
      session.sent.push({
        type: 'qzone',
        text: record.content,
        at: formatClockTime(record.endedAt || this.now())
      });
    }
    if (error) session.error = cleanText(error?.message ?? error, 1000);
    this.sessions.update(session.id);
    this.sessions.finish(session.id, error ? 'error' : (record.status === 'published' ? 'done' : 'noreply'));
    this.emit('session-end', { sessionId: session.id, chatKey: session.chatKey });
  }

  async #collectSnapshot(dayKey, cfg) {
    const start = dayStartFromKey(dayKey);
    const end = start + DAY_MS;
    const rootConfig = getConfig();
    if (cfg.source === 'self') {
      return {
        dayKey,
        start,
        end,
        source: 'self',
        selfNames: [rootConfig.persona?.botName, rootConfig.persona?.selfNickname, this.onebot.selfNickname]
          .filter(Boolean),
        groups: [],
        momentCandidates: [],
        imageMap: new Map(),
        imageCandidates: [],
        // 查重数据源：最近 5 条已发正文（self 模式不收集群聊，但已发历史要防自我重复）
        recentPublished: this.state.records.filter((record) => record.status === 'published')
          .slice(0, 5).map((record) => record.content)
      };
    }
    // 白名单/黑名单口径只留 chatAllowed 一处：这里原来手抄了一份 allow 的判断、**漏了 deny.groups**
    // （deny 没有界面控件，只能手改 config.json）** —— 被管理员屏蔽的群，当天消息照样进模型提示词。
    // #assertPublishAllowed 用的也是 chatAllowed，但它在模型跑完之后才抛，等于只挡了发布没挡外发。
    const chatKeys = this.store.listChats()
      .filter((chatKey) => String(chatKey).startsWith('group:'))
      .filter((chatKey) => isTimeActive(chatKey))
      .filter((chatKey) => chatAllowed(chatKey, rootConfig));
    const collected = [];

    for (const chatKey of chatKeys) {
      const [, groupId] = chatKey.split(':');
      const scanLimit = Math.min(2000, Math.max(cfg.maxMessagesPerGroup * 4, 200));
      const dayMessages = filterBlockedHistory(
        this.store.recent(chatKey, { limit: scanLimit, readOnly: true }), chatKey
      ).filter((message) => Number(message.ts) >= start && Number(message.ts) < end);
      const humanCount = dayMessages.filter((message) => !message.self).length;
      const members = this.memory.members(chatKey);
      const handoff = this.memory.getHandoff(chatKey);
      if (humanCount < cfg.minMessagesPerGroup && !members.length && !handoff) continue;
      const groupName = cleanText(await this.resolveChatName(groupId), 100) || groupId;
      collected.push({
        chatKey,
        groupName,
        humanCount,
        lastTs: dayMessages.at(-1)?.ts || 0,
        messages: dayMessages.slice(-cfg.maxMessagesPerGroup),
        members,
        handoff
      });
    }

    collected.sort((a, b) => b.humanCount - a.humanCount || b.lastTs - a.lastTs);
    const picked = collected.slice(0, cfg.maxGroups);
    const imageMap = new Map();
    let imageSeq = 0;
    const groups = picked.map((group) => {
      const messages = group.messages.map((message) => {
        const media = [];
        let imageIndex = 0;
        for (let index = 0; index < (message.media || []).length; index++) {
          const item = message.media[index];
          if (!cfg.allowImages || item?.kind !== 'image' || !item.url || imageMap.size >= 24) continue;
          const id = `image-${++imageSeq}`;
          imageMap.set(id, {
            id,
            type: 'message',
            chatKey: group.chatKey,
            mid: message.mid,
            mediaIndex: imageIndex++,
            fallbackUrl: String(item.url),
            label: `${group.groupName} / ${message.self ? '我' : displayNameOf(String(message.senderId || ''), message.senderName || '群友')} / ${cleanText(message.text, 100)}`
          });
          media.push(id);
        }
        return {
          at: formatShortTime(message.ts),
          self: message.self === true,
          sender: message.self
            ? (rootConfig.persona?.botName || '我')
            : cleanText(displayNameOf(String(message.senderId || ''), message.senderName || '群友'), 60),
          text: cleanText(message.text, 260),
          images: media
        };
      });
      return {
        chatKey: group.chatKey,
        groupName: group.groupName,
        messageCount: group.humanCount,
        messages,
        memories: group.members.slice(0, 20).map((member) => ({
          name: cleanText(member.name || '群友', 60),
          // 与记忆读侧同一口径：perChat / hidePrivateInGroup 下，私聊来源的印象不能因为
          // 「这个人也在本群说过话」就被写进公开说说（2026-10-19 全项目审查 P2）。
          impressions: visibleImpressions(member.impressions, group.chatKey)
            .slice(-3).map((item) => cleanText(item.content, 220))
        })),
        // 交接文本是模型从群消息整理出来的（很可能原样搬了群友的话），而它是**另一条**注入路径：
        // 整个 snapshot.groups 会被 JSON.stringify 进写说说的提示词（见下面 userPrompt 的拼装），
        // 所以要和记忆读侧（memory-global.formatHandoffForPrompt 必洗）同一口径。
        // 2026-10-01 审查：A1 只洗了群材料，这四行漏了 —— 群友伪造段头被模型写进交接后正好绕过去。
        handoff: group.handoff ? {
          topic: cleanText(group.handoff.topic, 200),
          summary: cleanText(group.handoff.summary, 1200),
          facts: (Array.isArray(group.handoff.facts) ? group.handoff.facts : [])
            .slice(0, 8).map((item) => cleanText(item, 240)).filter(Boolean),
          nextStep: cleanText(group.handoff.nextStep, 400)
        } : null
      };
    });

    if (cfg.allowImages && imageMap.size < 24) {
      try {
        const entries = (await this.stickers.sync(false)).entries || [];
        for (const sticker of entries.slice(0, 10)) {
          if (!sticker?.id || !sticker?.url || imageMap.size >= 24) continue;
          const id = `image-${++imageSeq}`;
          imageMap.set(id, {
            id,
            type: 'sticker',
            stickerId: sticker.id,
            fallbackUrl: sticker.url,
            label: `收藏图：${cleanText(sticker.localNote || sticker.desc || '未备注', 160)}`
          });
        }
      } catch { /* 配图是可选项 */ }
    }

    while (JSON.stringify(groups).length > cfg.maxPromptChars) {
      const target = [...groups]
        .filter((group) => group.messages.length > 5)
        .sort((a, b) => b.messages.length - a.messages.length)[0];
      if (!target) break;
      target.messages.shift();
    }

    return {
      dayKey,
      start,
      end,
      source: cfg.source,
      selfNames: [rootConfig.persona?.botName, rootConfig.persona?.selfNickname, this.onebot.selfNickname]
        .filter(Boolean),
      recentPublished: this.state.records.filter((record) => record.status === 'published')
        .slice(0, 5).map((record) => record.content),
      groups,
      momentCandidates: buildMomentCandidates(groups),
      imageMap,
      imageCandidates: [...imageMap.values()].map((image) => ({
        id: image.id,
        description: image.label
      }))
    };
  }

  async #decide(snapshot, cfg, session, signal) {
    const rootConfig = getConfig();
    const style = STYLE_SEEDS[Math.floor(this.random() * STYLE_SEEDS.length)] || STYLE_SEEDS[0];
    const systemPrompt = buildMomentSystemPrompt(rootConfig.persona, { accountNickname: this.onebot?.selfNickname || '' });
    const personaHash = momentPersonaHash(rootConfig.persona, this.onebot?.selfNickname || '');
    const recentPosts = this.state.records.filter((record) => record.status === 'published')
      .slice(0, 5).map((record) => ({ day: record.dayKey, content: record.content }));
    const groupsForPrompt = snapshot.groups.map(({ messages, ...group }) => group);
    const source = snapshot.source === 'self' ? 'self' : (snapshot.source === 'mixed' ? 'mixed' : 'group');
    // self 的素材引擎：人设兴趣库（roles/interests.json）＋ 可选研究由头（配置里开了搜索就允许搜一个真实话题再写观点）
    const interests = loadPersonaInterests();
    const lifeFeedIdeas = source !== 'group' && rootConfig.dailyMoments?.useLifeFeed === true
      ? (this.getLifeFeed?.()?.status?.().candidates || []).slice(0, 3)
      : [];
    const lifeFeedLine = lifeFeedIdeas.length
      ? `【可参考的见闻（不是必须发）】${lifeFeedIdeas.map((item) => sanitizeUserText(
        `${String(item.title || '')}（${item.source === 'bilibili' ? 'B站' : item.source || '见闻'}）${item.url}`
      )).join('；')}。`
        + '只借一个点写自己的感受，不要复述标题、不要写成播报；没兴趣就忽略。'
      : '';
    const materialLines = source === 'self'
      ? [
        '【自己的动态】（不引用群聊；从你的兴趣、观点或此刻在想的事里挑一件。可以表达感受、观察、疑问或吐槽，不虚构现实行动和现场。）',
        `【你的兴趣与立场（参考，不是任务）】${JSON.stringify(interests)}`,
        ...(lifeFeedLine ? [lifeFeedLine] : []),
        rootConfig.webSearch?.enabled !== false ? '可以先用一次搜索找一个今天真实发生的话题当由头（搜到的事实照实写，别编）。' : '没有外部素材也没关系，一条想法就够。'
      ]
      : source === 'mixed'
        ? [
          '【自己的动态】以人设为主：写你自己的兴趣、观点或此刻在想的事。',
          `【你的兴趣与立场（参考）】${JSON.stringify(interests)}`,
          ...(lifeFeedLine ? [lifeFeedLine] : []),
          '【群聊材料】最多点缀一句（比如"群里今天聊到X，我倒觉得…"），禁止转述或汇总群聊。',
          JSON.stringify({ candidates: snapshot.momentCandidates.slice(0, 3), groups: groupsForPrompt })
        ]
        : [
          '【群聊材料】（候选瞬间 + 群背景；只挑一个瞬间写，不需要转述或汇总）',
          JSON.stringify({ candidates: snapshot.momentCandidates, groups: groupsForPrompt })
        ];
    const summaryLines = source === 'self'
      ? ['【内部群摘要】本次没有收集群聊，提交时 groupSummaries 必须为空数组 []。']
      : ['【内部群摘要】提交时按 chatKey 原样填回 groupSummaries；只是留档，不要写进正文。',
        JSON.stringify(snapshot.groups.map((group) => ({ chatKey: group.chatKey, groupName: group.groupName })))];
    const userPrompt = [
      `【上海时间】${formatFullTime(this.now())}`,
      `【总结日期】${snapshot.dayKey}`,
      `【内容来源】${source === 'self' ? '人设自己的动态' : source === 'mixed' ? '人设为主，群聊见闻可选' : '群聊见闻'}`,
      `【可忽略的灵感】${style}。这不是规定的文风；与人设或素材不合适就不用。`,
      `【预算】最多研究 ${cfg.maxResearchCalls} 次；最多配图 ${cfg.maxImages} 张。`,
      '【最近已发动态】',
      JSON.stringify(recentPosts),
      ...materialLines,
      ...summaryLines,
      '【可选配图】',
      JSON.stringify(snapshot.imageCandidates)
    ].join('\n\n');
    const context = {
      snapshot,
      cfg,
      signal,
      researchCalls: 0,
      researchSources: [],
      inspectedImages: new Set(),
      visionEnabled: rootConfig.api?.vision !== false,
      searchEnabled: rootConfig.webSearch?.enabled !== false,
      finalDecision: null,
      recapRetryUsed: false,    // 「纪事体」只强制重写一次，见 dayRecapReason
      extraRounds: 0            // 退回重写给的那一轮预算：不能让重写落在最后一轮上，否则当天直接失败
    };
    const defs = this.#toolDefs(context);
    const tools = openAiTools(defs);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const usage = emptyUsage();
    let model = rootConfig.api?.model || '';
    let finalDecision = null;

    if (session) {
      session.systemPrompt = systemPrompt;
      session.userPrompt = userPrompt;
      session.promptChars = systemPrompt.length + userPrompt.length;
      session.promptLayout = MOMENT_PROMPT_VERSION;
      session.inputTools = structuredClone(tools);
      session.inputRequestOptions = { toolChoice: 'auto', temperature: 1 };
      this.sessions.update(session.id);
      this.emit('session-update', { sessionId: session.id });
    }

    for (let round = 0; round < cfg.maxRounds + (context.extraRounds || 0) && !finalDecision; round++) {
      signal.throwIfAborted();
      assertTimeAllowed();
      // DeepSeek thinking mode rejects named/required tool choices, including
      // on the final retry. Validation below still requires an explicit submit.
      const toolChoice = 'auto';
      if (session) {
        session.inputRequestOptions.toolChoice = toolChoice;
        session.inputRound = round + 1;
        session.inputPayloadChars = JSON.stringify({ messages, tools }).length;
        session.inputMessages = auditMessages(messages);
        session.activity = '正在整理每日动态…';
        this.sessions.update(session.id);
        this.emit('session-update', { sessionId: session.id });
      }
      const response = await this.complete({
        messages,
        tools,
        toolChoice,
        temperature: 1,
        purpose: 'write',   // 每日动态（说说）= 写作类任务
        signal,
        cacheKey: `qq-agent:daily-moments:${personaHash.slice(0, 24)}`
      });
      model = response.model || model;
      addUsage(usage, response.usage);
      usage.calls += 1;
      if (session) {
        session.usage = { ...usage };
        session.model = model;
        session.rounds = round + 1;
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
      const message = response.message || {};
      const assistant = {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : (message.content ?? null),
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(resolveToolCalls(message).length ? { tool_calls: resolveToolCalls(message) } : {})
      };
      messages.push(assistant);
      if (session) {
        session.messages.push({ ...structuredClone(assistant), raw: response.raw ?? null });
        session.activity = '';
        this.sessions.update(session.id);
        this.emit('session-update', { sessionId: session.id });
      }
      const calls = resolveToolCalls(message);
      if (!calls.length) {
        messages.push({
          role: 'user',
          content: '请继续，最终必须调用 submit_daily_moment 明确 publish 或 skip。'
        });
        continue;
      }

      const toolMessages = [];
      const imageMessages = [];
      for (const call of calls) {
        signal.throwIfAborted();
        assertTimeAllowed();
        const name = String(call?.function?.name || '');
        let args = null;
        let parseError = '';
        try {
          const raw = call?.function?.arguments;
          args = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object');
        } catch {
          parseError = '工具参数不是合法 JSON 对象。请按工具 schema 重新提交，字符串内双引号必须转义；不要把正文或摘要包成未转义的引号。';
        }
        const def = defs.find((item) => item.name === name);
        let result;
        try {
          if (parseError) result = { content: `错误：${parseError}`, isError: true };
          else if (context.finalDecision) result = { content: '已有有效决定，忽略后续操作', isError: true };
          else result = def
              ? await def.execute(args)
              : { content: `错误：未知工具 ${name}，本任务不能使用群聊工具`, isError: true };
        } catch (error) {
          result = { content: `错误：${error?.message ?? error}`, isError: true };
        }
        let content = '';
        let images = [];
        if (Array.isArray(result.content)) {
          content = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          images = result.content.filter((part) => part.type === 'image_url');
        } else {
          content = String(result.content ?? '');
        }
        toolMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content
        });
        if (images.length) {
          imageMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：这是候选图片 ${args?.imageId || ''}，仅供判断是否适合作为说说配图]` },
              ...images
            ]
          });
        }
        if (session) {
          session.messages.push({
            toolCall: {
              name,
              args,
              result: content.slice(0, 2000),
              isError: Boolean(result.isError)
            }
          });
        }
      }
      messages.push(...toolMessages, ...imageMessages);
      finalDecision = context.finalDecision;
    }

    if (!finalDecision) throw momentError(
      'MOMENT_DECISION_INVALID', '模型未在轮次预算内提交有效决定，本次生成失败；没有发布，可重新生成', 422
    );
    return {
      decision: finalDecision,
      researchCalls: context.researchCalls,
      researchSources: context.researchSources,
      usage,
      model,
      personaHash
    };
  }

  #toolDefs(context) {
    return [
      {
        name: 'web_search',
        description: '搜索实时信息、概念或聊天中值得深入研究的问题。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        },
        execute: async (args) => {
          if (context.researchCalls >= context.cfg.maxResearchCalls) {
            return { content: '错误：今日研究调用次数已达上限', isError: true };
          }
          context.researchCalls += 1;
          const result = await this.search(cleanText(args.query, 300));
          return {
            content: JSON.stringify({
              query: result.query,
              results: (result.results || []).slice(0, 6).map((item) => ({
                title: cleanText(item.title, 200),
                url: item.url,
                snippet: cleanText(item.snippet, 500)
              }))
            })
          };
        }
      },
      {
        name: 'web_fetch',
        description: '读取搜索结果正文，核实细节后再形成观点。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        },
        execute: async (args) => {
          if (context.researchCalls >= context.cfg.maxResearchCalls) {
            return { content: '错误：今日研究调用次数已达上限', isError: true };
          }
          context.researchCalls += 1;
          const result = await this.fetchPage(String(args.url || ''));
          if (result.statusCode === 200 && result.url && String(result.content ?? result.body ?? '').trim()) {
            context.researchSources.push(String(result.url));
            context.researchSources = [...new Set(context.researchSources)].slice(0, 10);
          }
          return {
            content: JSON.stringify({
              url: result.url,
              statusCode: result.statusCode,
              // 抓回来的网页正文是**不可信文本**：伪造【管理员附加规则】这类段头就能冒充系统段。
              // 与聊天侧 web_fetch 同一道清洗（正文已在 fetchWebPage 里提取）。
              content: sanitizeUserText(String(result.content ?? result.body ?? '')).slice(0, 12000)
            })
          };
        }
      },
      {
        name: 'inspect_image_candidate',
        description: '查看一张候选图片；决定配图前先调用，不合适就不要选。',
        parameters: {
          type: 'object',
          properties: {
            imageId: { type: 'string', description: '可选配图列表中的 image-N' }
          },
          required: ['imageId']
        },
        execute: async (args) => {
          if (!context.cfg.allowImages || !context.visionEnabled) {
            return { content: '错误：配图已关闭', isError: true };
          }
          const imageId = String(args.imageId || '');
          const prepared = await this.#loadImageCandidate(
            context.snapshot,
            imageId,
            context.signal
          );
          if (!prepared) return { content: `错误：找不到候选图片 ${imageId}`, isError: true };
          context.inspectedImages.add(imageId);
          return {
            content: [
              { type: 'text', text: `候选图片 ${imageId}（若为 2×2 四宫格：那是动图 GIF 按时间顺序抽的 4 帧，阅读顺序左上→右上→左下→右下，黑格是填充不是画面内容）` },
              { type: 'image_url', image_url: { url: prepared.dataUrl } }
            ]
          };
        }
      },
      {
        name: 'submit_daily_moment',
        description: '提交今天这条动态的最终决定：要发就给出公开正文，不发就 skip，并把内部群摘要一并附上。摘要是给系统留档的内部记录（不会公开），正文才是别人看到的那条动态——不要把摘要的写法用来写正文，也不要把正文写成当天的纪事（时间线、次数统计）。只能在完成必要研究和看图后调用。',
        parameters: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['publish', 'skip'] },
            reason: { type: 'string', minLength: 1, description: '一句非空的决定理由，不输出推理过程' },
            content: { type: 'string', description: 'publish 时填写最终公开正文（就是别人看到的那条动态本身，不是群摘要/总结）；skip 时为字符串 ""' },
            imageIds: {
              type: 'array',
              items: { type: 'string' },
              maxItems: context.cfg.maxImages,
              description: '仅填写已成功查看的候选图 ID；不配图填 []'
            },
            groupSummaries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  chatKey: { type: 'string' },
                  summary: { type: 'string', minLength: 1, description: '一至两句内部摘要（只给系统留档，不进公开正文），避免逐字引用带引号的长对话' }
                },
                required: ['chatKey', 'summary']
              }
            }
          },
          required: ['decision', 'reason', 'content', 'imageIds', 'groupSummaries']
        },
        execute: async (args) => {
          // 确定性的校验先做（图片没看过这种改一次就能过），别让风格闸门抢在前面多绕一轮。
          const requested = Array.isArray(args?.imageIds) ? args.imageIds : [];
          if (requested.some((imageId) => !context.inspectedImages.has(imageId))) {
            throw momentError('MOMENT_DECISION_INVALID', '所选图片尚未成功查看，请先看图，或使用空 imageIds', 422);
          }
          let decision;
          try {
            decision = sanitizeDecision(args, context.snapshot, context.cfg, { allowRecap: context.recapRetryUsed === true });
          } catch (error) {
            if (error?.recapRejected && !context.recapRetryUsed) {
              context.recapRetryUsed = true;
              context.extraRounds = 1;   // 给这次重写单独一轮，避免"提交正好落在最后一轮"时当天发布失败
            }
            throw error;
          }
          // 图片"看过没有"已经在上面（调 sanitizeDecision 之前）查过，这里不再重复。
          context.finalDecision = decision;
          return { content: JSON.stringify({ accepted: true, decision: context.finalDecision.decision }) };
        }
      }
    ].filter((def) => {
      if (def.name === 'web_search' || def.name === 'web_fetch') {
        return context.searchEnabled && context.cfg.maxResearchCalls > 0;
      }
      if (def.name === 'inspect_image_candidate') {
        return context.visionEnabled && context.cfg.allowImages && context.cfg.maxImages > 0;
      }
      return true;
    });
  }

  async #resolveImageSource(snapshot, imageId) {
    const candidate = snapshot.imageMap.get(String(imageId || ''));
    if (!candidate) return '';
    if (candidate.type === 'sticker') {
      const sticker = await this.stickers.findForSend(candidate.stickerId);
      return String(sticker?.url || candidate.fallbackUrl || '');
    }
    if (candidate.type === 'message' && candidate.mid != null) {
      try {
        const message = await this.onebot.getMsg(candidate.mid);
        const images = (Array.isArray(message?.message) ? message.message : [])
          .filter((segment) => segment?.type === 'image');
        const image = images[candidate.mediaIndex] || images[0];
        const fresh = String(image?.data?.url || image?.data?.file || '').trim();
        if (fresh) return fresh;
      } catch { /* 使用落库地址兜底 */ }
      // 草稿发布通常是次日：QQ 图片链接/ getMsg 可能已失效。用本条消息落库时保存的媒体地址兜底，
      // 不把易过期 URL 写进状态文件（2026-11-03 复核 P2）。
      try {
        const row = this.store.findByMid?.(candidate.chatKey, candidate.mid);
        const media = Array.isArray(row?.media) ? row.media[candidate.mediaIndex] || row.media[0] : null;
        const stored = String(media?.url || media?.file || '').trim();
        if (stored) return stored;
      } catch { /* 继续走 fallbackUrl */ }
    }
    return String(candidate.fallbackUrl || '');
  }

  async #loadImageCandidate(snapshot, imageId, signal) {
    const candidate = snapshot.imageMap.get(String(imageId || ''));
    if (!candidate) return null;
    if (candidate.prepared) return candidate.prepared;
    const source = await this.#resolveImageSource(snapshot, imageId);
    if (!source) return null;
    let buffer;
    let contentType = '';
    if (source.startsWith('base64://')) {
      // 本地库表情：findForSend 对 localFile 条目返回整图 base64（见 sticker-manager）。
      // 这里以前统一走 http(s) 校验 + 抓取，本地图会被直接拒掉 —— 候选列表里
      // 上传/生成的图永远轮不到，说说配图对它们永久失败（2026-10-07 复审）。
      // 上限与本地库写入口一致（MAX_STICKER_BYTES = 8MiB）。
      buffer = Buffer.from(source.slice('base64://'.length), 'base64');
      if (!buffer.length) throw new Error(`候选图片 ${imageId} 内容为空`);
      if (buffer.length > 8 * 1024 * 1024) throw new Error(`候选图片 ${imageId} 超过 8MB，不能用于说说配图`);
    } else {
      const safeUrl = await this.validateImage(source);
      ({ buffer, contentType } = await this.fetchBinary(
        safeUrl,
        8 * 1024 * 1024,
        signal
      ));
      if (!buffer?.length) throw new Error(`候选图片 ${imageId} 内容为空`);
    }
    const mime = imageMime(buffer, contentType);
    // GIF 与消息图片同一收口：主流视觉网关不收 image/gif，且动图情绪在动作里——
    // 抽帧条转 JPEG 给模型判读；空间上传（uploadSource）仍用原始 GIF 保留动画。
    let visionBuffer = buffer;
    let visionMime = mime;
    if (mime === 'image/gif') {
      try {
        const strip = await convertGifToStillStrip(buffer, signal);
        if (strip?.length) { visionBuffer = strip; visionMime = 'image/jpeg'; }
      } catch { /* 转换失败回退原始 GIF */ }
    }
    const encoded = buffer.toString('base64');
    candidate.prepared = {
      dataUrl: `data:${visionMime};base64,${visionBuffer.toString('base64')}`,
      uploadSource: `base64://${encoded}`
    };
    return candidate.prepared;
  }

  async #findDuplicate(content, signal) {
    // 查重只是二次保险：协议端读不到列表（接口结构不稳定/未实现）时跳过，
    // 不阻断发布；同一 dayKey 是否已发过由发布闸门 #blockingRecord 把关。
    let data = null;
    try {
      data = typeof this.onebot.getQzoneMoments === 'function'
        ? await this.onebot.getQzoneMoments({ num: 30, signal })
        : await this.onebot.call('get_qzone_msg_list', { pos: 0, num: 30 }, 30000, signal);
    } catch (error) {
      console.log('[daily-moments] 空间列表读取失败，跳过查重继续发布：', error?.message ?? error);
      return null;
    }
    if (!Array.isArray(data?.msglist)) {
      console.log('[daily-moments] 空间列表结构异常，视为无历史说说继续发布');
      return null;
    }
    const target = cleanText(content, 1000);
    return data.msglist.find((item) =>
      item?.tid && cleanText(item.content, 1000) === target) || null;
  }

  async #publishMoment(content, images, cfg, signal) {
    if (typeof this.onebot.sendQzoneMoment === 'function') {
      return this.onebot.sendQzoneMoment(content, {
        images,
        ugcRight: cfg.visibility,
        targetUins: cfg.targetUins,
        signal
      });
    }
    const params = {
      content,
      images,
      ugc_right: cfg.visibility
    };
    if ([16, 128].includes(cfg.visibility)) params.target_uins = cfg.targetUins;
    return this.onebot.call('send_qzone_msg', params, 90000, signal);
  }
}
