// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import crypto from 'node:crypto';
import { getConfig, imageGenAvailable, imageGenMaxPerHour } from '../core/config.js';
import { classifyTransportFailure } from '../onebot/sender.js';
import { imageType } from '../core/image-type.js';
import { MAX_REMINDER_TEXT, nextAtFromHHMM, normalizeRepeat, nextOccurrenceAt } from '../core/reminders.js';
import { synthesizeSpeech, ttsConfigured } from '../llm/tts.js';
import { generateImage, MAX_PROMPT_CHARS } from '../llm/image-gen.js';
import { resolveApiKey } from '../llm/llm.js';
import { safeFetchBinary } from '../llm/safe-fetch.js';
import { stickerVisionEnabled } from '../llm/vision-scan.js';
import { todayKey } from '../core/util.js';   // 上海自然日（"每群每天一次"的去重用同一个口径）
import { createQuota } from '../core/quota.js';
import { lookupMemes, rememberMeme } from '../memes/store.js';
import { getSkillRegistry } from '../skills/registry.js';
import { preparePrivateTextFile, privateTextFileError } from '../onebot/private-text-file.js';
import { adminToolDefs } from '../admin/tools.js';
import { muteToolDefs } from './mute.js';

// 生图闸门（按张计费，全局；#9 那套双闸在这里只用全局侧 —— 一张图的钱与"哪个群要的"无关，
// 但额度按会话记账便于排查，且 perChat 不设限）
const imageQuota = createQuota({ windowMs: 3600_000 });
/** 仅供测试：清空生图闸门的记录（与 audio-transcribe 导出 consumeAsrQuota 同一用意）。 */
export function resetImageQuotaForTest() {
  imageQuota.reset();
}

// 平台互动类动作的闸门：贴表情 / 改签名·在线状态 / 改备注都是"账号侧可见"的写入，
// 且都不经过发送队列的限频（没有 outbox、没有每分钟上限），所以在这里单独封顶，
// 防模型抽风把这些动作刷成噪音（群友会在 QQ 通知里看到资料变动）。
const reactionQuota = createQuota({ windowMs: 3600_000 });      // 贴表情：每小时封顶
const profileQuota = createQuota({ windowMs: 24 * 3600_000 });  // 签名/在线状态：每天封顶
const remarkQuota = createQuota({ windowMs: 24 * 3600_000 });   // 备注：每天封顶
const avatarQuota = createQuota({ windowMs: 7 * 24 * 3600_000 }); // 换头像：**每周**封顶（窗口 7 天 —— 真人按周/月换头像，
// "每天 1 次"一周也能换 7 次，挡不住"太勤"）
// 相册互动（点赞/评论）：与贴表情同档的"轻互动"，但评论是**所有人都看得到的公开内容**，
// 所以卡得更紧（2026-10-07 独立审计发现：点赞/评论此前既不走发送队列也没有任何闸门 ——
// 模型一轮里连刷 N 次会全部落到 QQ）。
const albumWriteQuota = createQuota({ windowMs: 3600_000 });
// 私聊文本文件：文件比消息显眼，且内容可能很大；默认每天 10 个。
const privateFileQuota = createQuota({ windowMs: 24 * 3600_000 });
// TTS 按字符/按次计费，且合成发生在发送限频之前；和 ASR/生图一样必须有独立闸门。
// 默认每会话 6 条/小时、全局 30 条/小时，可用 tts.maxPerHour / tts.maxPerHourPerChat 覆盖。
const voiceQuota = createQuota({ windowMs: 3600_000 });

// ctx 只属于本轮工具循环；新一轮即使复用 session，也不合并独立的提醒请求。
const recurringRemindersByContext = new WeakMap();
const reminderSnapshot = (item) => JSON.stringify([
  item.chatKey, item.text, item.createdBy, item.targetName, item.repeat, item.quiet
]);
// "每群每天一次"类动作的去重表（群签到：重复签没有意义；群待办：同一条消息重复设也没意义）。
// dayKey 是上海自然日，跨日自然失效，不需要定时器。resetPlatformQuotasForTest 会一起清。
const signedDayByChat = new Map();     // chatKey -> 'YYYY-MM-DD'
const todoDayByChat = new Map();       // chatKey -> { day, mids:Set<string>, count }
const TODO_PER_GROUP_PER_DAY = 3;

/** 仅供测试：清空平台互动闸门与去重表。 */
export function resetPlatformQuotasForTest() {
  reactionQuota.reset();
  profileQuota.reset();
  remarkQuota.reset();
  avatarQuota.reset();
  albumWriteQuota.reset();
  privateFileQuota.reset();
  voiceQuota.reset();
  signedDayByChat.clear();
  todoDayByChat.clear();
}

// 平台能力开关（控制台「平台能力」页）：映射表、默认取向、按群覆盖、配额上限都在
// core/platform-gates.js（零依赖，prompt/orchestrator/控制台共用一份，防两边各写一遍漂掉）。
// 这里重导出，保持既有 `from '../tools/tools-core.js'` 的引用路径不变。
import { platformQuotaLimit, platformToolAllowed, privateFileMaxKiB } from '../core/platform-gates.js';
export {
  PLATFORM_DEFAULT_OFF, PLATFORM_GATE_KEYS, PLATFORM_GATE_LABELS, PLATFORM_QUOTA_DEFAULTS,
  PLATFORM_QUOTA_KEYS, PLATFORM_TOOL_GATES, platformGateAllowed, platformGroupIdOf,
  platformQuotaLimit, platformToolAllowed
} from '../core/platform-gates.js';

/** 平台写入闸门的当前用量（控制台「平台能力」页展示；滑动窗口内计数）。 */
export function platformQuotaUsage(now = Date.now()) {
  const cfg = getConfig();
  const pack = (quota, key) => {
    const snap = quota.snapshot(now);
    return {
      key,
      windowMs: snap.windowMs,
      // 上限按**配置**报（不是闸门内部值）：闸门要等第一次调用才 configure，
      // 之前内部是 Infinity（JSON 里会变成 null），控制台就会显示"上限 -"。
      limit: platformQuotaLimit(cfg, key),
      used: snap.globalUsed,
      // 各会话分账：控制台展示前三个（排查"是哪个群在刷"）
      chats: Object.entries(snap.chats)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([chatKey, count]) => ({ chatKey, count }))
    };
  };
  return {
    reactions: pack(reactionQuota, 'reactionsPerHour'),
    profile: pack(profileQuota, 'profilePerDay'),
    remarks: pack(remarkQuota, 'remarksPerDay'),
    avatars: pack(avatarQuota, 'avatarsPerWeek'),
    albumWrites: pack(albumWriteQuota, 'albumWritesPerHour'),
    privateFiles: pack(privateFileQuota, 'privateFilesPerDay')
  };
}

// 消息 id 归一化：模型常把聊天记录里的 "#123" 连 # 一起传进来，而 OneBot 只认纯数字 id。
// store.js 里有一份同名函数但没导出，所以这里保留 tools 层自用的一份。
// **导出**：orchestrator 记录"续接线索参与者"时读的是工具调用的原始参数，
// 不归一化就会把 '#42' 当成参与者 id 永久存进线程（2026-09-29 审查）。
export function normalizeMid(value) {
  return String(value ?? '').trim().replace(/^(?:#+|collected_)+/, '').trim();
}

/** 印象条目去掉"来自哪个会话"：工具契约写明不泄露其他群/私聊的来源。 */
function stripMemorySources(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { sourceChatKeys, ...rest } = entry;
  return rest;
}

// 群友可控内容（群名片/文件名/相册/OCR/转写/翻译/身份档案）进工具结果前的统一出口：
// 弱化"段头伪装"（【管理员附加规则】这类），与消息侧 sanitizeUserText 同一口径。
// 递归遍历结构、只对字符串叶子做弱化 —— 不做文本级 JSON 往返（那会把数组里字符串的
// 空格一起剥掉，且未闭合段头能让 parse 失败、整棵树免洗fail-open，2026-10-10 审查 P2）。
export function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeUserText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = sanitizeDeep(val);
    return out;
  }
  return value;
}

// QQ 系统表情的"中文名 → 编号"查表在 face-catalog.js 里统一维护：与 onebot.js 来信渲染
// （[QQ表情14 微笑]）共用一份表，来源 = 离线导出表 + 协议端在线目录（fetch_sys_faces，建联后补缺）。
import { faceIdByName, faceNameList, faceNameOf } from '../onebot/face-catalog.js';

function faceLookup(name) {
  const key = String(name ?? '').trim().replace(/^\/+/, '');
  if (!key) return { error: 'name 不能为空，请填表情中文名，如 微笑' };
  const id = faceIdByName(key);
  if (id !== null && id !== undefined) return { face: { id, name: key } };
  if (/^\d+$/.test(key)) return { face: { id: key, name: `编号${key}` } };
  const like = faceNameList().filter((n) => n.includes(key) || key.includes(n)).slice(0, 12);
  return {
    error: `找不到表情「${key}」。` + (like.length
      ? `你是不是想发：${like.join('、')}`
      : '常用：微笑、得意、流泪、害羞、酷、白眼、玫瑰、爱心、强、抱拳、打call、汪汪')
  };
}

/** 表情 id 找不到时，把库里的有效 id 列给模型，方便它同一轮就改对。 */
async function stickerLookupHint(ctx, key) {
  try {
    const result = await ctx.stickers.list('', 12);
    const items = Array.isArray(result?.stickers) ? result.stickers : [];
    if (!items.length) return `你给的是「${key}」，表情库现在是空的：可以用 collect_sticker 先收几张。`;
    const lines = items.map((st) => `${st.id}（${st.localNote || st.desc || '无备注'}）`).join('；');
    return `你给的是「${key}」。有效 id 例如：${lines}；完整列表用 list_stickers 查。`;
  } catch {
    return `你给的是「${key}」，有效 id 请用 list_stickers 查。`;
  }
}

import { normalizeMessageList, safeSlice, sanitizeUserText, textWithQuote, unquoteJsonString, stripQuoteMessageId } from '../core/util.js';
import { buildShareText, shareSourceLabel } from './share-text.js';
import { filterBlockedHistory } from '../core/blocklist.js';
import { matchesBlacklistKeyword } from '../core/keyword-rules.js';
import { displayNameOf } from '../core/display-name.js';
import { setMemberNote } from '../memory/memory-global.js';
import { repairUnescapedStringQuotes } from '../core/json-repair.js';
import { humanizeText } from '../llm/humanize.js';
import { searchKnowledge } from '../knowledge/store.js';
import { assertPublicUrlLiteral, validateImageUrl } from '../llm/safe-fetch.js';
import { webSearch } from '../llm/web-search.js';
import { fetchWebPage } from '../llm/web-page.js';
import { expandForwardNodes, extractMediaFromSegments } from '../onebot/onebot.js';
import { readForwardMessages, readForwardNodesById } from '../onebot/forward-reader.js';
import { convertGifToStillStrip, convertVideoToFrameStrip, convertStillImageToJpeg, fetchOversizedImageAsJpeg } from './image-downsample.js';
import { transcribeMessageAudio } from './audio-transcribe.js';
import { normalizePokeName, resolvePokeTarget } from './poke-target.js';
import { memoryVisibilityOf } from '../core/memory-visibility.js';


/**
 * 视觉模型用的 data URL 收口。GIF 特殊处理：主流视觉网关不接受 image/gif，
 * 且动图的情绪信息在动作里——用 ffmpeg 抽帧拼成 2x2 帧条转成 JPEG；
 * ffmpeg 缺失或转换失败时回退原始 GIF data URL（保持既有行为，不劣化）。
 * AVIF/HEIC 等网关不认的静图格式先转 JPEG：直接原样送会被上游 400（Issue #41）。
 */
const VISION_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
export async function toVisionDataUrl(buffer, mime, signal) {
  if (mime === 'image/gif') {
    try {
      const strip = await convertGifToStillStrip(buffer, signal);
      if (strip?.length) return `data:image/jpeg;base64,${strip.toString('base64')}`;
    } catch { /* 回退原始 GIF */ }
  }
  if (mime !== 'image/gif' && !VISION_MIME.has(mime)) {
    try {
      const jpeg = await convertStillImageToJpeg(buffer, signal);
      if (jpeg?.length) return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      throw new Error(`图片格式 ${mime || '未知'} 视觉接口不支持，转成 JPEG 也失败：${error?.message ?? error}`);
    }
  }
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

export async function downloadImageAsDataUrl(url, signal) {
  signal?.throwIfAborted();
  if (String(url || '').startsWith('base64://')) {
    const buffer = Buffer.from(String(url).slice('base64://'.length), 'base64');
    if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
      throw new Error('本地表情图片为空或超过 12 MiB');
    }
    const mime = detectMime(buffer);
    if (!mime) throw new Error('本地表情图片格式无效');
    return toVisionDataUrl(buffer, mime, signal);
  }
  const safeUrl = await validateImageUrl(url);
  let buffer;
  let contentType;
  try {
    ({ buffer, contentType } = await safeFetchBinary(safeUrl, 12 * 1024 * 1024, signal));
  } catch (error) {
    // 超过常规上限 → 放宽到 96MiB 重拉 + ffmpeg 降采样（Issue #6：群友发 >12MiB 大图）。
    // 非超限错误原样抛出；ffmpeg 缺失/失败时抛带指引的错误，常规 ≤12MiB 路径不受影响。
    ({ buffer, contentType } = await fetchOversizedImageAsJpeg(safeUrl, error, signal));
  }
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
  return toVisionDataUrl(buffer, mime, signal);
}

/**
 * 视频 → 视觉模型能看的 data URL（2×2 帧条）。
 * 视频没有"图片"那种直传路径：先把整段下下来（沿用图片通道的体积上限与内网限制），
 * 再按总时长抽 4 帧拼成一张 JPEG。抽帧失败时抛错（让模型知道看不到画面，而不是当成静默空图）。
 */
export async function downloadVideoAsFrameStrip(url, signal) {
  signal?.throwIfAborted();
  const safeUrl = await validateImageUrl(url);
  const { buffer } = await safeFetchBinary(safeUrl, 64 * 1024 * 1024, signal);
  if (!buffer?.length) throw new Error('视频内容为空');
  const strip = await convertVideoToFrameStrip(buffer, signal);
  if (!strip?.length) throw new Error('视频抽帧失败（服务器上需要可用的 ffmpeg/ffprobe）');
  return `data:image/jpeg;base64,${strip.toString('base64')}`;
}

function detectMime(buf) {
  return imageType(buf) || null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message, metadata = {}) {
  return { content: `错误：${message}`, isError: true, ...metadata };
}

/**
 * 动作策略：同一种动作在会话内冷却 + 整轮次数上限。
 * gate 只检查、不扣配额；真正发送成功后再调 actionDone —— 失败/校验拒绝不能白占冷却。
 */
function actionGate(ctx, kind) {
  const cfg = getConfig().humanize;
  if (cfg?.enabled !== true || cfg?.actions?.enabled === false) return { ok: true };
  const run = ctx.session?.actionPolicy || (ctx.session.actionPolicy = { count: 0 });
  const max = Math.max(1, Number(cfg.actions?.maxPerRun) || 4);
  if (run.count >= max) {
    return { ok: false, reason: `本轮动作次数已达上限（${max} 次），先把话说完`, code: 'action-run-limit' };
  }
  const cooldownKey = kind === 'voice' ? 'voiceCooldownMs' : `${kind}CooldownMs`;
  const cooldown = Math.max(0, Number(cfg.actions?.[cooldownKey]) || 0);
  const mem = ctx.actionMemory?.get(ctx.chatKey);
  const last = Number(mem?.at?.[kind]) || 0;
  if (cooldown > 0 && Date.now() - last < cooldown) {
    const wait = Math.ceil((cooldown - (Date.now() - last)) / 1000);
    return { ok: false, reason: `这个动作刚刚用过，${wait} 秒后再试`, code: 'action-cooldown' };
  }
  return { ok: true };
}

function actionDone(ctx, kind) {
  const cfg = getConfig().humanize;
  if (cfg?.enabled !== true || cfg?.actions?.enabled === false) return;
  const run = ctx.session?.actionPolicy || (ctx.session.actionPolicy = { count: 0 });
  run.count += 1;
  if (ctx.actionMemory) {
    const mem = ctx.actionMemory.get(ctx.chatKey) || { at: {} };
    mem.at[kind] = Date.now();
    ctx.actionMemory.set(ctx.chatKey, mem);
  }
}

/**
 * 群管理动作只允许全局管理员在群里明确要求时执行。
 * 主动唤醒/模型自己发挥时 triggerEntries 里没有管理员，一律拒绝。
 */
function adminRequest(ctx, actionPatterns = []) {
  const owner = String(getConfig().admin?.ownerUin || '').trim();
  if (!/^\d{5,15}$/.test(owner)) return { ok: false, reason: '未配置全局管理员，群管理动作不可用' };
  // 只认批次里**最后一条**非机器人发言，且这条发言要真的在说对应的管理动作；
  // 群友先起哄、管理员随后回一句“收到”不能当成授权。
  const entries = (ctx.triggerEntries || []).filter((entry) => !entry?.self);
  const last = entries[entries.length - 1];
  if (!last || String(last?.senderId || '') !== owner) {
    return { ok: false, reason: '群管理动作只能由全局管理员在群里明确要求时执行' };
  }
  const text = String(last?.text || '');
  if (actionPatterns.length && !actionPatterns.some((re) => re.test(text))) {
    return { ok: false, reason: '管理员这条消息里没有明确的管理指令' };
  }
  return { ok: true, owner };
}

function normalizeTarget(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(text)) return '';
  return text.replace(/^0+(?=\d)/, '');
}

function moderationTargetError(ctx, target, owner) {
  const text = normalizeTarget(target);
  if (!text) return { error: 'targetUserId 必须是数字 QQ 号', target: '' };
  if (String(ctx.onebot?.selfId || '') === text) return { error: '不能对自己执行群管理动作', target: '' };
  if (owner && text === owner) return { error: '不能对全局管理员执行群管理动作', target: '' };
  return { error: '', target: text };
}

/**
 * 发送类工具的失败收口。除了沿用"已捕获过就不再记"的约定，还把"预期内失败"排除出异常面板：
 * 被禁言（GROUP_MUTED）期间每轮都会撞上，记成 warning 只会把控制台刷满 ——
 * 模型当轮拿到原因、决定先不发言就够了。
 */
/**
 * 送达之后的记账：写本地库（markUsed）、记 session.sent、发 session-update。
 * 这些都在 `await sender.sendXxx()` **之后**，失败绝不能改判成「发送失败」——
 * 工具返回失败会让模型以为没发出去而重发，群里就多一条/多一张（2026-10-04 全面复审 P3
 * 实测：stub markUsed 抛 disk full，贴纸已在线上（message_id=7），工具却返回
 * 「错误：disk full」）。与 onebot/sender.js 的 #afterSent 同一口径。
 */
function afterSent(run) {
  try {
    run();
  } catch (error) {
    console.warn('[tools] 消息已送达但记账失败（该条仍算已发出，不会上报失败）:', error?.message ?? error);
  }
}

/**
 * 直连协议端的写操作没有 outbox 兜底（超时/连接重置不会进 unknown），
 * 这里只登记到副作用账本，让"结果未知"在控制台与诊断包里可见。
 *
 * 第一阶段只记录、不拦截：这些动作大体幂等（重复贴一次表情、重复设一次签名结果相同），
 * 而且各自有 24h 闸门配额。观察到真实的 unknown 比例后再决定是否禁止自动重试
 * （docs/EFFECT-LEDGER.md A5）。账本缺失或自身出错时绝不能影响工具调用本身。
 */
async function trackDirectWrite(ctx, kind, detail, run) {
  const effects = ctx?.effects;
  if (!effects || typeof effects.begin !== 'function') return run();
  let began = null;
  try {
    began = effects.begin({
      kind: `direct:${kind}`,
      chatKey: ctx?.chatKey || '',
      // 每次调用一个唯一的键：只做留痕，不参与去重（重复贴表情是用户/模型自己的选择）
      idemKey: `direct:${kind}:${ctx?.chatKey || ''}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      detail
    });
  } catch { began = null; }
  if (!began) return run();
  try {
    const result = await run();
    try { effects.settle(began.id, 'sent'); } catch { /* 记账失败不影响结果 */ }
    return result;
  } catch (error) {
    try {
      // 与发送队列同一分类（classifyTransportFailure）：协议端明确拒绝/连接被拒/DNS 失败
      // 这类**确定没发出去**的算 failed；超时/连接重置/5xx 可能已经生效的才算 unknown。
      const { definite, uncertain } = classifyTransportFailure(error);
      // 发送前的闸门（禁言/限频/被 abort）也属于"确定没发出去"：sender 抛的是普通 Error，
      // 没有 outcome/beforeWrite，只能按稳定错误码识别（2026-10-31 交叉审查 P2）。
      const preflight = error?.beforeWrite === true
        || error?.code === 'GROUP_MUTED' || error?.code === 'SEND_RATE_LIMITED'
        || error?.name === 'AbortError';
      const state = error?.outcome === 'failed' || preflight
        || (definite && !uncertain) ? 'failed' : 'unknown';
      effects.settle(began.id, state, { error: String(error?.message ?? error).slice(0, 200) });
    } catch { /* 同上 */ }
    throw error;
  }
}

/**
 * 消息归属校验：OneBot 的 message_id 是**全局**的，不校验就能给别的群/私聊的消息贴表情、
 * 读别人的表情回应（跨会话副作用，提示词注入可达）。测试桩/精简上下文没有 store.findByMid
 * 时放行（生产工具上下文一定带 store）。
 */
function messageInChat(ctx, mid) {
  const store = ctx?.store;
  if (!store || typeof store.findByMid !== 'function') return true;
  return Boolean(store.findByMid(ctx.chatKey, mid));
}

function sendErr(error, metadata = {}, messageOverride) {
  return err(messageOverride ?? (error?.message ?? error), {
    incidentCaptured: error?.incidentCaptured === true,
    ...(error?.code === 'GROUP_MUTED' ? { reportIncident: false } : {}),
    ...metadata
  });
}

const REPAIRABLE_ARGUMENT_TOOLS = new Set(['finish']);

// 修复逻辑已抽到 core/json-repair.js 与 relationship-pilot（影子评估）共用，
// 这里只保留"哪些工具允许修复"的策略门槛。

function parseToolArguments(name, raw) {
  if (typeof raw !== 'string') return { args: raw, repaired: false };
  try {
    return { args: JSON.parse(raw), repaired: false };
  } catch (error) {
    if (REPAIRABLE_ARGUMENT_TOOLS.has(name)) {
      const repaired = repairUnescapedStringQuotes(raw);
      if (repaired) {
        try {
          return { args: JSON.parse(repaired), repaired: true };
        } catch {
          // Ambiguous malformed arguments must still go back to the model.
        }
      }
    }
    return { error };
  }
}

// 引擎发的游戏私聊（game-secret：身份/查验结果/行动回执）对模型一律不可见——
// 不只是历史里要过滤，按 id 单查、列可见 id 这些出口同样要过这道闸（2026-09-29 审查 P1）
const modelVisible = (m) => Boolean(m) && m.eventKind !== 'game-secret';

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .filter(modelVisible)
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 群公告/群简介里带的是 HTML 片段（实测 &nbsp; 一堆）：换行/空白还原成可读文本。
function cleanHtmlText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从聊天记录里反查一个 QQ 号的最近昵称（表情回应用户列表等场景；查不到就回号码本身）。
function recentNameOf(ctx, userId) {
  try {
    const rows = ctx.store?.recent?.(ctx.chatKey, { limit: 500 }) || [];
    const hit = rows.find((m) => String(m.senderId) === String(userId) && String(m.senderName || ''));
    // 显示名口径统一走 displayNameOf（备注优先）；拿不到近期发言就退回 QQ 号
    return displayNameOf(userId, hit ? String(hit.senderName) : '');
  } catch {
    return String(userId);
  }
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  // 昵称入库时未清洗（ingest 只清洗 text），工具结果会回传给模型 —— 显示名口径统一走
  // displayNameOf（备注优先 + 段头弱化）
  const lines = members.map((m) => `- ${displayNameOf(m.userId, m.name)}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function hasParticipant(ctx, userId) {
  if (typeof ctx.store?.hasParticipant === 'function') {
    return ctx.store.hasParticipant(ctx.chatKey, userId);
  }
  return (ctx.store?.activeMembers?.(ctx.chatKey, 1000) || [])
    .some((member) => String(member.userId) === String(userId));
}

function messageTargetError(ctx, { replyToMessageId, atUserId }) {
  const reply = normalizeMid(replyToMessageId);
  const at = normalizeMid(atUserId);
  if (reply && at) return 'replyToMessageId 和 atUserId 只能选择一个';
  if (reply) {
    if (!/^-?[1-9]\d*$/.test(reply)) {
      return `replyToMessageId 必须是聊天记录中的消息 id。${midHint(ctx)}`;
    }
    if (!modelVisible(ctx.store?.findByMid?.(ctx.chatKey, reply))) {
      return `当前会话找不到要引用的消息 ${reply}。${midHint(ctx)}`;
    }
  }
  if (at) {
    if (ctx.kind !== 'group') return '私聊不需要 atUserId';
    if (!/^\d{1,15}$/.test(at)) {
      return `atUserId 必须是当前群成员的数字 QQ 号。${memberHint(ctx)}`;
    }
    if (!hasParticipant(ctx, at)) {
      const looksLikeMessageId = modelVisible(ctx.store?.findByMid?.(ctx.chatKey, at));
      return `${at} 不是当前群中已出现的成员 QQ 号`
        + `${looksLikeMessageId ? '，它是消息 id；如需引用请改用 replyToMessageId' : ''}。${memberHint(ctx)}`;
    }
  }
  return '';
}

/**
 * send_message 的降级版目标解析：正文永远优先，非法引用/@ 只丢掉目标，不丢整条回复。
 * 同时给引用和 @ 时保留引用（引用更能表达"回的是哪条"），@ 目标不在历史发言者里时
 * 仍按数字 QQ 号发送 —— 比让模型整条重写更接近真实用户的行为。
 */
function resolveMessageTarget(ctx, { replyToMessageId, atUserId } = {}) {
  const notes = [];
  let reply = normalizeMid(replyToMessageId);
  let at = normalizeMid(atUserId);
  if (reply && at) {
    at = null;
    notes.push('同时给了引用和 @，已保留引用、忽略 @');
  }
  if (reply) {
    const valid = /^-?[1-9]\d*$/.test(reply) && modelVisible(ctx.store?.findByMid?.(ctx.chatKey, reply));
    if (!valid) {
      reply = null;
      notes.push('引用目标无效，已按普通消息发送');
    }
  }
  if (at) {
    if (ctx.kind !== 'group') {
      at = null;
      notes.push('私聊不需要 @，已忽略');
    } else if (!/^\d{1,15}$/.test(at)) {
      at = null;
      notes.push('@ 目标不是 QQ 号，已忽略');
    } else if (!hasParticipant(ctx, at)) {
      const looksLikeMessageId = modelVisible(ctx.store?.findByMid?.(ctx.chatKey, at));
      if (looksLikeMessageId) {
        at = null;
        notes.push('@ 目标像消息 id，已忽略；如需引用请用 replyToMessageId');
      } else {
        notes.push('@ 目标不在最近发言者里，仍按 QQ 号发送');
      }
    }
  }
  return { replyToMessageId: reply, atUserId: at, note: notes.join('；') };
}

/**
 * 这条消息里"能看的画面"：图片（含 GIF 帧条）与视频（抽帧条）。
 * 返回描述符数组（{kind, url}），由调用方按 kind 选下载方式。最多 4 个。
 */
async function currentMessageImageUrls(ctx, entry) {
  let media = entry.media || [];
  if (entry.mid != null && typeof ctx.onebot?.getMsg === 'function') {
    try {
      const data = await ctx.onebot.getMsg(entry.mid);
      const segments = Array.isArray(data?.message) ? data.message : [];
      const fresh = extractMediaFromSegments(segments)
        // file-only 会顶掉 stickerId 兜底，validateImageUrl 也不接受裸文件名（Issue #99）。
        .filter((item) => ['image', 'video'].includes(item.kind) && /^(https?:\/\/|base64:\/\/)/i.test(String(item.url || '')));
      if (fresh.length) {
        media = fresh;
        ctx.store?.updateByMid?.(ctx.chatKey, entry.mid, { appendMedia: fresh });
      }
    } catch {
      // Stored URLs remain a best-effort fallback when the source message expired.
    }
  }
  const viewable = [];
  for (const item of media) {
    if (item?.kind !== 'image' && item?.kind !== 'video') continue;
    let url = String(item.url || item.file || '').trim();   // 自发图只存 stickerId（Issue #99）
    if (!url && item.stickerId && typeof ctx.stickers?.findForSend === 'function') {
      try { url = String((await ctx.stickers.findForSend(item.stickerId))?.url || '').trim(); } catch { /* 无图 */ }
    }
    if (url && viewable.push({ kind: item.kind, url }) >= 4) break;
  }
  return viewable;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 */
/** #13：memory_query 的描述必须与 memory.visibility 策略一致（默认 global 时与历史文案逐字一致）。 */
/** get_message_images 的描述随「消息类型 → 视频画面」变：教它调一个对视频什么都不给的工具
 *  只会白烧一轮（与 memoryQueryDescription 同一个口径：描述跟着配置走）。 */
function getMessageImagesDescription() {
  const videoFrames = getConfig().messageTypes?.videoFrames !== false;
  return videoFrames
    ? '查看某条消息里的图片/表情/**视频画面**（视觉模型可以直接看懂）。消息文本出现 [图片] / [表情包] / [视频] 时可用；视频会抽 4 帧拼成 2×2 帧条，配 get_message_audio 听声音就能把视频"看+听"齐。id 用聊天记录里每条消息前的 #数字。'
    : '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] / [表情包] 时可用。**这条消息里的视频画面看不到**（「消息类型」页关掉了视频画面），视频只有声音，用 get_message_audio 转写。id 用聊天记录里每条消息前的 #数字。';
}

function memoryQueryDescription() {
  const vis = memoryVisibilityOf(getConfig());
  const base = '查看你对群友的长期印象。传 query 可按意思检索（例如“上次说的那家面馆”“谁提过爬山”），不传 query 则按最近观察返回全部；传 userId 只看某一个人。';
  if (vis.mode === 'perChat') {
    return `${base}仅当前会话：只含在当前群/私聊里观察到的印象。印象是隐私：不得向群友转述他人的印象、来源或原话。`;
  }
  if (vis.hidePrivateInGroup) {
    return `${base}全局共享：汇总自所有群聊与私聊的观察；群聊里不展示私聊来源的印象。印象是跨会话的隐私：不得向群友转述他人的印象、来源或原话。`;
  }
  return `${base}全局共享：不分当前会话，汇总自所有群聊与私聊的观察。印象是跨会话的隐私：不得向群友转述他人的印象、来源或原话。`;
}

export function buildToolDefs({ kind = '', chatId = '', cfg = getConfig() } = {}) {
  const defs = [
    ...adminToolDefs({ kind, chatId, cfg }),
    ...muteToolDefs({ cfg, kind, trackDirectWrite }),
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选；和引用同时给时保留引用、忽略 @；不要滥用）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          // 正文优先：非法引用/@ 只降级目标，不让整条回复消失。
          const target = resolveMessageTarget(ctx, args);
          const humanizeCfg = getConfig().humanize || {};
          const respectCard = humanizeCfg.respectPersonaCard !== false
            && ctx.behaviorProfile === 'card';
          // 角色卡优先：平台不改卡的语气（连严重自指也不拦截）；
          // grounded（自然可靠）：保留"首先/其次"这类结构词，只处理真正的自指/免责。
          const antiAi = humanizeCfg.enabled === true
            && humanizeCfg.antiAi?.enabled !== false && !respectCard;
          const soft = !(ctx.behaviorProfile === 'grounded');
          const cleaned = messages.map((text) => (antiAi
            ? humanizeText(text, { soft })
            : { text, severe: false, tells: [], changed: false }));
          // 严重的 AI 自指/免责只给一次重写机会：模型改口气后照发，避免一直卡在同一句。
          if (antiAi && !ctx.session.humanizeWarned
            && humanizeCfg.antiAi?.blockSevere !== false
            && cleaned.some((item) => item.severe)) {
            ctx.session.humanizeWarned = true;
            return err('这句话太像 AI 助手了（自指/免责/客服收尾）。用你角色的口吻重写后再发，不要解释规则。', { reportIncident: false });
          }
          const outgoing = cleaned.map((item) => item.text).filter(Boolean);
          if (!outgoing.length) return err('消息内容为空', { reportIncident: false });
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, outgoing, {
            runId: ctx.session.leaseId, signal: ctx.signal,
            // 人格回复才做气泡整形/角色节奏（send_message 是模型"说话"的唯一通路）
            persona: true,
            // grounded 与 card（角色卡优先）都不做"空格/换行重排"：卡自己决定句式，
            // 平台只保证代码块与缩进不被拆坏（card 档不套平台语气，但技术内容仍是内容）。
            preserveCode: ctx.behaviorProfile === 'grounded' || ctx.behaviorProfile === 'card',
            voice: ctx.voice || null,
            replyToMessageId: normalizeMid(target.replyToMessageId) || null,
            atUserId: normalizeMid(target.atUserId) || null
          });
          afterSent(() => {
            ctx.session.sent.push(...result.sent.map((s) => ({
              type: 'text', text: s.text, at: s.at, messageId: s.messageId
            })));
            ctx.emit('session-update', ctx.session.id);
          });
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (target.note) note.push(`（${target.note}）`);
          if (result.failed.length) {
            // 带上序号和原文（sender 已提供）：否则模型只知道"有几条失败"，
            // 最省事的做法就是整批重发，群里就多出重复的成功段（2026-10-07 复审）。
            const detail = result.failed.map((f) => `第${Number(f.index) + 1}条「${String(f.text ?? '').slice(0, 15)}」：${f.error}`).join('；');
            note.push(`（另有 ${result.failed.length} 条发送失败：${detail}——已成功的不需要重发，只补发失败的那几条或减少条数）`);
          }
          const response = ok({
            sent: result.sent.length,
            messageIds: result.sent.map((s) => s.messageId),
            note: note.join('')
          });
          // 顶层标记：编排器的 finish 屏障要看得到"部分失败"，不能只写在给模型看的 JSON 文本里。
          if (result.failed.length) response.partialFailure = true;
          return response;
        } catch (error) {
          return sendErr(error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 直接填【可用表情包】里那行开头的备注名即可，也接受完整 id。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          let sticker = null;
          try {
            sticker = await ctx.stickers.findForSend(unquoteJsonString(args.stickerId));
          } catch (error) {
            if (error?.code === 'STICKER_LINK_DEAD') {
              return err(`${error.message}。换一张，或用 list_stickers 看看别的。`);
            }
            throw error;
          }
          if (!sticker) return err(`找不到表情。${await stickerLookupHint(ctx, args.stickerId)}`, { reportIncident: false });
          if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
          const targetError = messageTargetError(ctx, args);
          if (targetError) return err(targetError);
          const gate = actionGate(ctx, 'sticker');
          if (!gate.ok) {
            // code 供编排器的 finish 屏障按结构化字段判定（PR #65 复审：别靠错误文案匹配）
            return err(`${gate.reason}。这次表情没有发出；请改用 send_message 发文字回复，不要再试表情，也不要只结束本轮。`, { reportIncident: false, errorCode: gate.code });
          }
          // 有本地文件的就是"托管内联"：findForSend 会给 base64，别过 validateImageUrl（它只收 http(s)）。
          // 原来这里写死 source==='manual'，而"收藏即落盘"之后 AI 收藏项也带 localFile + base64
          // —— 会被判"图片地址不合法"永远发不出去（2026-09-27 审查 P0）。
          const managedInline = Boolean(sticker.localFile) && sticker.url.startsWith('base64://');
          if (!managedInline) {
            try {
              await validateImageUrl(sticker.url); // 只允许公网 http(s)，防止本地库被污染后诱导 OneBot 抓内网
            } catch (error) {
              return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
            }
          }
          const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
            runId: ctx.session.leaseId, signal: ctx.signal,
            replyToMessageId: normalizeMid(args.replyToMessageId) || null,
            atUserId: normalizeMid(args.atUserId) || null
          });
          actionDone(ctx, 'sticker');
          afterSent(() => {
            ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
            ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sanitizeUserText(String(sticker.desc || sticker.localNote || sticker.id))}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
            ctx.emit('session-update', ctx.session.id);
          });
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
        } catch (error) {
          return sendErr(error);
        }
      }
    },
    {
      name: 'list_stickers',
      description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
          limit: { type: 'integer', description: '最多返回条数，默认 24' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          // 关掉「查看表情库里没备注的图」后，系统提示只列有备注的；列表工具也必须同口径，
          // 否则模型能从 list_stickers 拿到一堆裸 id，盲发它根本没看过的图（2026-10-17 审查 P2）。
          if (!stickerVisionEnabled()) {
            const visible = (Array.isArray(result?.stickers) ? result.stickers : [])
              .filter((entry) => String(entry?.desc || entry?.localNote || '').trim());
            result.stickers = visible;
            result.matched = visible.length;
            result.total = visible.length;
            result.truncated = false;
          }
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error, {
            incidentCaptured: error?.incidentCaptured === true
          });
        }
      }
    },
    {
      name: 'get_sticker_image',
      description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: '表情 id' } },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.findForSend(args.stickerId);
          if (!sticker) return err(`找不到表情。${await stickerLookupHint(ctx, args.stickerId)}`, { reportIncident: false });
          if (!sticker.url) return err('该表情没有图片地址');
          const dataUrl = await downloadImageAsDataUrl(sticker.url, ctx.signal);
          // 备注是"图里文字经视觉判定入库"的内容，可能是别人画的图自带段头（2026-10-12 审查）
          return { content: imageParts(`表情 ${sticker.id}（你的备注：${sanitizeUserText(String(sticker.localNote || sticker.desc || '无'))}）（先判断情绪/态度再回应）：`, [dataUrl]) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sticker_note',
      description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。只写画面/用途这类识别信息，不要写"我是谁"这种自我设定（人设以【角色设定】为准，不靠备注）。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string' },
          note: { type: 'string', description: '你的理解/含义' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
          usage: { type: 'string', description: '适用场景（可选）' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
          if (!entry) return err(`找不到表情。${await stickerLookupHint(ctx, args.stickerId)}`, { reportIncident: false });
          return ok({ updated: true, id: entry.id, localNote: sanitizeUserText(String(entry.localNote || '')), tags: (Array.isArray(entry.tags) ? entry.tags : []).map((t) => sanitizeUserText(String(t))) });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库（偶尔用；看图工具不可用时凭群友的用法与你的判断，别瞎收）。需要备注一句简短说明。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
          note: { type: 'string', description: '一句简短备注（帮未来的你识别）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!modelVisible(entry)) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && m.url);
          if (!imageMedia) return err('该消息没有可收藏的图片');
          // 与"自动收藏"同一口径：先判一下这是不是真表情包 —— 只靠模型自己的判断，
          // 生活照/自拍/形象图会混进表情库，之后按图片发出去（用户 2026-09-27 反馈）
          if (typeof ctx.stickers.collectPeek === 'function') {
            const gate = ctx.stickers.collectPeek(Date.now(), ctx.chatKey);
            if (!gate.ok) {
              return err(gate.scope === 'chat'
                ? '本会话的收藏额度用完了（每小时有上限），过一会儿再收'
                : '收藏额度用完了（全局每小时有上限），过一会儿再收');
            }
          }
          const verdict = await ctx.stickers.judgeImage({
            url: imageMedia.url,
            message: { mid: entry.mid, senderName: entry.senderName || '' },
            signal: ctx.signal
          });
          if (!verdict) {
            // 没判断出来（模型没提交/被服务商内容过滤）与"判断为不收"是两回事，别混成一句结论
            return err('这次没判断出来（图片可能被服务商拦截或模型没提交决定），过会儿再试一次；确实想留就再调一次 collect_sticker，把 note 写清楚');
          }
          if (verdict.save !== true) {
            // 判定标准可配置（sticker.collectCriteria），这里不再复述默认标准 —— 否则用户改了标准，
            // 这句给模型看的理由会跟配置打架；结论与理由按判定结果走。
            return err(`这张不收（${sanitizeUserText(String(verdict.reason || '不像表情包'))}）：按当前的收藏标准判定`);
          }
          // 与 send_message/send_sticker 一样归一化：模型常传 "#123"，直接当 id 会生成
          // collected_#123，而刷新逻辑只认 collected_123，收藏的表情链接就永远不刷新。
          const saved = await ctx.stickers.collect(normalizeMid(args.messageId), {
            url: imageMedia.url,
            note: String(verdict?.note || args.note || ''),
            // chatKey 必传：collect 的每会话限频桶以它做键，漏传会全部落进 '' 桶 ——
            // 单会话额度变成跨会话共享，且与上面 collectPeek(chatKey) 的预检读的不是同一个计数器
            //（2026-10-07 复审 P2）。
            chatKey: ctx.chatKey
          });
          return ok({
            collected: true,
            id: saved.id,
            // 判定备注来自视觉模型对图的转述（图里可以有段头伪装），出口统一弱化（2026-10-12 审查）
            note: sanitizeUserText(String(saved.localNote || '')),
            kind: saved.localFile ? '本地图库（发出去是图片）' : 'QQ收藏表情'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'generate_image',
      description: '自己画一张图（调用图片生成服务，按张计费、有每小时上限）。适合群友点名要"画一张"：梗图、应景的图。'
        + 'prompt 要写清楚画面内容（主体、风格、氛围）；要在图上带中文文字时，把文字用引号原样写进 prompt'
        + '（例如：…画面上有中文文字"事已至此，先吃饭吧"——能不能写对取决于所选图模型）。'
        + '默认生成后直接发到当前会话（配置可关掉自动发送），并同时存进表情库供以后复用；只想收藏、这次不发就传 send:false。'
        + '别频繁用（一次调用就是一次真实花费）。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述：主体 + 风格 + 氛围（如"一只橘猫戴着草帽坐在海边，卡通风格"）' },
          note: { type: 'string', description: '可选：给这张图起的短语（存进表情库便于以后找）' },
          send: { type: 'boolean', description: '传 false：这次只存进表情库、不发送；不传时按图片生成设置里的「生成后直接发送」处理' }
        },
        required: ['prompt']
      },
      async execute(ctx, args) {
        try {
          const cfg = getConfig();
          if (!imageGenAvailable(cfg)) return err('图片生成未启用或未配置（设置 → 图片生成）');
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) return err('prompt 不能为空');
          if (prompt.length > MAX_PROMPT_CHARS) return err(`画面描述太长了（≤${MAX_PROMPT_CHARS} 字），说短一点`);
          // 按张计费：**事前原子消费**再生成 —— 这是唯一一道成本闸门，并发下必须封顶。
          // 以前是 peek → 生成 → tryConsume（且忽略返回值）：两个并发轮次（默认 maxConcurrentRuns=2）
          // 会双双通过 peek，各生成一张，上限被突破且超限那张照样计费（2026-10-01 审查）。
          // 用法与 asr 的 consumeAsrQuota 一致；失败/落库失败再 refund 退回（失败不扣）。
          // 每次读配置：界面上改上限后不必重启就生效
          imageQuota.configure({ globalMax: imageGenMaxPerHour(cfg), perChatMax: Infinity });
          const reservedAt = Date.now();
          const gate = imageQuota.tryConsume(ctx.chatKey, reservedAt);
          if (!gate.ok) {
            return err(gate.scope === 'chat'
              ? '本会话的画图额度用完了（每小时有上限），过一会儿再画'
              : '画图额度用完了（全局每小时有上限，这是按张计费的）');
          }
          let buffer; let revisedPrompt;
          const label = String(args.note || '').trim() || prompt;
          let entry;
          try {
            ({ buffer, revisedPrompt } = await generateImage({
              cfg,
              apiCfg: cfg.api,
              apiKey: resolveApiKey(cfg),
              prompt,
              signal: ctx.signal
            }));
            // 落库：走与"控制台上传的自定义表情"同一条路（addManual 自己校验格式与体积并落盘）
            entry = ctx.stickers.addManual({
              imageBuffer: buffer,
              desc: label.slice(0, 40),
              localNote: `生成的图：${prompt}`.slice(0, 300),
              tags: ['生成'],
              usage: revisedPrompt ? `提示词修订：${revisedPrompt}`.slice(0, 300) : ''
            });
          } catch (error) {
            // 生成已经发出去了（中止/超时/落库失败）就不能退额度：服务商侧可能已完成并计费，
            // 退款会让每小时 6 张的成本闸门少计，模型看到"失败"重试还会再扣一次。
            // 只有"请求根本没发出去"的配置/参数错误才退。
            const maybeBilled = Boolean(buffer) || ctx.signal?.aborted === true
              || /超时|timeout|abort|cancel|ECONN|ETIMEDOUT|落库|addManual/i.test(String(error?.message ?? error));
            if (!maybeBilled) imageQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          // 生成即发送：只保存、等模型再调 send_sticker 的旧路径在模型漏掉第二步时
          // 用户什么也收不到（Issue #41）。仍存进表情库，后续可复用。
          const autoSend = args.send !== false && cfg.imageGen?.autoSend !== false;
          if (!autoSend) {
            return ok({
              id: entry.id,
              note: entry.localNote,
              sent: false,
              kind: '已存进表情库（未发送）',
              next: '需要发送时用 send_sticker 传这个 id'
            });
          }
          try {
            const sendable = await ctx.stickers.findForSend(entry.id);
            if (!sendable?.url) throw new Error('生成的图片没有可发送的地址');
            // 默认仍按表情发送（保持 0.9.x 行为）；imageGen.sendAs='image' 时发普通图片，
            // 群友可以直接保存（issue #67）。表情库手动发表情不受这个开关影响。
            const sendAsImage = cfg.imageGen?.sendAs === 'image';
            const sent = sendAsImage
              ? await ctx.sender.sendImage(ctx.chatKey, sendable, { runId: ctx.session.leaseId, signal: ctx.signal })
              : await ctx.sender.sendSticker(ctx.chatKey, sendable, { runId: ctx.session.leaseId, signal: ctx.signal });
            afterSent(() => {
              ctx.stickers.markUsed(entry.id, String(ctx.session.triggerText || '').slice(0, 100));
              ctx.session.sent.push({ type: sendAsImage ? 'image' : 'sticker', text: `[生成的图:${sanitizeUserText(label.slice(0, 40))}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
              ctx.emit('session-update', ctx.session.id);
            });
            return ok({
              id: entry.id,
              note: entry.localNote,
              sent: true,
              messageId: sent?.message_id ?? null,
              kind: '已发送并存入表情库'
            });
          } catch (error) {
            // 图已经生成并入库（钱花了）：把 id 交给模型，不要让它重复生成；
            // 发送结果不确定时也不要自动重发（outbox 会留 unknown 供人工核对）。
            return ok({
              id: entry.id,
              note: entry.localNote,
              sent: false,
              kind: '已生成并存入表情库，但发送失败',
              warning: `发送失败：${error?.message ?? error}。不要重复生成；结果不确定时不要自动重发。`
            });
          }
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_face',
      description: '发送一个 QQ 系统表情（就是聊天记录里显示成 [表情14 微笑] 的那种小黄脸、汪汪等）。name 填中文名，例如 微笑 / 得意 / 流泪 / 害羞 / 酷 / 白眼 / 玫瑰 / 爱心 / 强 / 抱拳 / 打call / 汪汪。只能发表情本身，不能同时带文字——想说话请先用 send_message 单独发。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '表情中文名，如 微笑、玫瑰、汪汪' },
          text: { type: 'string', description: '可选：和表情放在同一条消息里的文字（文字在前、表情在后），例如 text 填「你可真行」就是「你可真行[微笑]」' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['name']
      },
      async execute(ctx, args) {
        try {
          const hit = faceLookup(unquoteJsonString(args.name));
          if (hit.error) return err(hit.error, { reportIncident: false });
          const targetError = messageTargetError(ctx, args);
          if (targetError) return err(targetError);
          const result = await ctx.sender.sendFace(ctx.chatKey, hit.face, {
            runId: ctx.session.leaseId, signal: ctx.signal,
            replyToMessageId: normalizeMid(args.replyToMessageId) || null,
            atUserId: normalizeMid(args.atUserId) || null,
            text: args.text ? unquoteJsonString(args.text) : null
          });
          afterSent(() => {
            ctx.session.sent.push({ type: 'face', text: `${args.text ? unquoteJsonString(args.text) : ''}[表情:${hit.face.name}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
            ctx.emit('session-update', ctx.session.id);
          });
          return ok({ sent: true, faceId: hit.face.id, name: hit.face.name, messageId: result?.message_id ?? null, note: '系统表情已发送。' });
        } catch (error) {
          return sendErr(error);
        }
      }
    },
    {
      name: 'react_to_message',
      description: '给**群聊**里一条消息贴 QQ「表情回应」（消息下方多一个表情，比回一句话更轻；私聊消息 QQ 不支持表情回应）。messageId 用聊天记录里那条消息前的 #数字；emojiId 用 QQ 系统表情编号（和 send_face 同一套：经典小黄脸 14=微笑、13=呲牙、179=抠鼻，新表情如 128077=👍、128514=😂、128064=👀）。'
        + '适合"看到/赞同/笑死/无语但不想开口"的时候；别人给你贴了表情可以回敬一个（聊天记录里会出现 [贴表情] 行）。set=false 撤回自己贴的。别每条都贴。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '要贴的那条消息 id（聊天记录里的 #数字）' },
          emojiId: { type: ['integer', 'string'], description: 'QQ 系统表情编号（数字）' },
          set: { type: 'boolean', description: '默认 true=贴上；false=撤回自己贴的这个' }
        },
        required: ['messageId', 'emojiId']
      },
      async execute(ctx, args) {
        try {
          // QQ 实测：私聊消息不支持表情回应（协议端会回 retcode=100
          // "emoji reactions are not supported on private messages"）——在工具层先说清楚。
          if (ctx.kind !== 'group') return err('表情回应只能贴在群聊消息上（QQ 私聊不支持）。私聊里想表达态度就回一句话或发个表情。');
          const mid = normalizeMid(args.messageId);
          if (!/^-?\d+$/.test(mid)) return err(`messageId 要是消息 id（收到的是 ${mid}）。${midHint(ctx)}`);
          const emojiId = String(args.emojiId ?? '').trim();
          if (!/^\d+$/.test(emojiId)) return err('emojiId 要是 QQ 系统表情编号（数字），如 14 微笑、128077 👍');
          // 协议端的 message_id 是全局的：不校验归属的话，被提示词注入引导就能给别的群
          // 的消息贴表情（跨会话副作用），违反"模型物理上无法操作其它会话"的约束。
          if (!messageInChat(ctx, mid)) return err('这条消息不在当前会话里，不能贴表情');
          const humanGate = actionGate(ctx, 'react');
          if (!humanGate.ok) return err(humanGate.reason, { reportIncident: false });
          const cfg = getConfig();
          const reactLimit = platformQuotaLimit(cfg, 'reactionsPerHour');
          reactionQuota.configure({ globalMax: reactLimit, perChatMax: Infinity });
          const reservedAt = Date.now();
          const gate = reactionQuota.tryConsume(ctx.chatKey, reservedAt);
          if (!gate.ok) return err(`这一小时贴的表情够多了（上限 ${reactLimit} 次），过一会儿再贴`);
          try {
            // 与 OneBotClient.reactToMessage 同一实现（wire 形状只留一处，2026-10-07 复审 P3）
            await trackDirectWrite(ctx, 'react', { mid, emojiId }, () => ctx.onebot.reactToMessage(mid, emojiId, args.set !== false, ctx.signal));
            actionDone(ctx, 'react');
          } catch (error) {
            reactionQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          const name = faceNameOf(emojiId);
          const verb = args.set === false ? '撤回' : '贴上';
          afterSent(() => {
            ctx.session.sent.push({ type: 'reaction', text: `[贴表情]${verb} ${name || emojiId}（消息 #${mid}）`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
            ctx.emit('session-update', ctx.session.id);
          });
          return ok({ reacted: true, messageId: mid, emojiId, note: `表情回应已${verb}。` });
        } catch (error) {
          return err(`贴表情失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_message_reactions',
      description: '看一条群聊消息被贴了哪些表情回应、都是谁贴的（私聊消息没有表情回应）。适合确认"刚才那个表情是对我发的吗"、或想知道自己哪句话被点了什么。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: '消息 id（聊天记录里的 #数字）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const mid = normalizeMid(args.messageId);
          if (!/^-?\d+$/.test(mid)) return err('messageId 要是消息 id（聊天记录里那条消息前的 #数字）');
          if (!messageInChat(ctx, mid)) return err('这条消息不在当前会话里，不能查它的表情回应');
          const res = await ctx.onebot.call('get_msg_emoji_likes', { message_id: Number(mid) }, 15000, ctx.signal);
          const list = Array.isArray(res) ? res : [];
          if (!list.length) return ok({ messageId: mid, reactions: [], note: '这条消息还没有表情回应。' });
          const reactions = list.slice(0, 10).map((item) => {
            const emojiId = String(item?.emoji_id ?? '');
            const users = (Array.isArray(item?.users) ? item.users : [])
              .map((u) => ({ userId: String(u?.user_id ?? u ?? ''), name: recentNameOf(ctx, u?.user_id ?? u) }))
              .filter((u) => u.userId);
            return { emojiId, name: faceNameOf(emojiId) || '', count: Number(item?.count) || users.length || 1, users };
          });
          return ok({ messageId: mid, reactions });
        } catch (error) {
          return err(`查表情回应失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'set_my_signature',
      description: '改你自己的 QQ 个性签名（资料页上那行字）。偶尔配合心情/近况改一句（如"摸鱼中""今日宜发呆"），别频繁（每天最多几次）、别写成广告或联系方式。',
      parameters: {
        type: 'object',
        properties: { signature: { type: 'string', description: '签名内容（≤40 字，随手一句最好）' } },
        required: ['signature']
      },
      async execute(ctx, args) {
        try {
          const signature = safeSlice(String(args.signature ?? '').trim(), 40);
          if (!signature) return err('signature 不能为空');
          const profileLimit = platformQuotaLimit(getConfig(), 'profilePerDay');
          profileQuota.configure({ globalMax: profileLimit, perChatMax: Infinity });
          const reservedAt = Date.now();
          if (!profileQuota.tryConsume(ctx.chatKey, reservedAt).ok) return err(`今天的资料改动次数用完了（每天最多 ${profileLimit} 次）`);
          try {
            await trackDirectWrite(ctx, 'signature', { signature }, () => ctx.onebot.call('set_self_longnick', { long_nick: signature }, 15000, ctx.signal));
          } catch (error) {
            profileQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          return ok({ signature, note: '个性签名已改。' });
        } catch (error) {
          return err(`改签名失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'set_my_status',
      description: '改你自己的自定义在线状态（"摸鱼中"这种，别人看你头像旁会显示）。wording 写状态文案；faceId 是状态图标编号，不知道就传 0 用默认图标。偶尔用（每天最多几次）。',
      parameters: {
        type: 'object',
        properties: {
          wording: { type: 'string', description: '状态文案（≤16 字，如 摸鱼中 / 睡觉中 / 写代码中）' },
          faceId: { type: ['integer', 'string'], description: '可选：状态图标编号，缺省 0' }
        },
        required: ['wording']
      },
      async execute(ctx, args) {
        try {
          const wording = safeSlice(String(args.wording ?? '').trim(), 16);
          if (!wording) return err('wording 不能为空');
          const faceId = Number(normalizeMid(args.faceId) || 0) || 0;
          const profileLimit = platformQuotaLimit(getConfig(), 'profilePerDay');
          profileQuota.configure({ globalMax: profileLimit, perChatMax: Infinity });
          const reservedAt = Date.now();
          if (!profileQuota.tryConsume(ctx.chatKey, reservedAt).ok) return err(`今天的资料改动次数用完了（每天最多 ${profileLimit} 次）`);
          try {
            await trackDirectWrite(ctx, 'status', { faceId, wording }, () => ctx.onebot.call('set_diy_online_status', { face_id: faceId, face_type: 1, wording }, 15000, ctx.signal));
          } catch (error) {
            profileQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          return ok({ wording, note: '在线状态已改。' });
        } catch (error) {
          return err(`改在线状态失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'set_my_avatar',
      description: '换你自己的 QQ 头像（账号级，所有人都看得到）。图源二选一：messageId＝用某条消息里的图；stickerId＝表情库里的图（生成的图也在库里，见【可用表情包】）。很显眼的能力：别拿群友的生活照/别人的头像，偶尔一次就好（按周算额度，别当日常动作）。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '图片所在消息的 id（聊天记录里的 #数字）' },
          stickerId: { type: 'string', description: '表情库里的图（备注名或 id）' }
        }
      },
      async execute(ctx, args) {
        try {
          const stickerId = unquoteJsonString(String(args.stickerId ?? '')).trim();
          const mid = normalizeMid(args.messageId);
          if (!stickerId && !mid) return err('要给图源：messageId（消息里的图）或 stickerId（表情库里的图）二选一');
          let file = '';
          if (stickerId) {
            const sticker = await ctx.stickers.findForSend(stickerId).catch(() => null);
            if (!sticker?.url) return err(`找不到表情 ${stickerId}。${await stickerLookupHint(ctx, stickerId)}`, { reportIncident: false });
            // 与 send_sticker 同一道防线：本地托管的走 base64，公网链接必须过校验
            const managedInline = Boolean(sticker.localFile) && sticker.url.startsWith('base64://');
            if (!managedInline) {
              try {
                await validateImageUrl(sticker.url);
              } catch (error) {
                return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝用作头像：${error?.message ?? error}`);
              }
            }
            file = sticker.url;
          } else {
            const entry = ctx.store.findByMid(ctx.chatKey, mid);
            if (!modelVisible(entry)) return err(`当前会话找不到消息 ${mid}。${midHint(ctx)}`);
            const media = (Array.isArray(entry.media) ? entry.media : []).filter((m) => m && m.kind === 'image');
            const target = media.find((m) => /^https?:\/\//i.test(String(m.url || ''))) || media[0];
            if (!target) return ok(`消息 ${mid} 里没有可用的图片。`);
            file = /^https?:\/\//i.test(String(target.url || '')) ? String(target.url) : String(target.file || '');
            if (!file) return err('这张图拿不到可用的地址');
            // 走 url 时是协议端去取，不经 safe-fetch —— 同上，先挡内网（2026-10-09 审查）
            if (/^https?:\/\//i.test(file)) {
              try {
                assertPublicUrlLiteral(file, { label: '图片地址' });
              } catch (error) {
                return err(`这张图的地址不能用：${error?.message ?? error}`);
              }
            }
          }
          const avatarLimit = platformQuotaLimit(getConfig(), 'avatarsPerWeek');
          avatarQuota.configure({ globalMax: avatarLimit, perChatMax: Infinity });
          const reservedAt = Date.now();
          if (!avatarQuota.tryConsume(ctx.chatKey, reservedAt).ok) return err(`这周的换头像次数用完了（每周最多 ${avatarLimit} 次）`);
          try {
            await trackDirectWrite(ctx, 'avatar', {}, () => ctx.onebot.setAvatar(file, { signal: ctx.signal }));
          } catch (error) {
            avatarQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          return ok({ changed: true, note: '头像已换（各端可能要过一会儿才刷新出来）。' });
        } catch (error) {
          return sendErr(error, {}, `换头像失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'set_my_profile',
      description: '改你自己的 QQ 资料：nickname＝QQ 昵称、personalNote＝个性说明（资料页那行小字）、sex＝性别（0 未知 / 1 男 / 2 女）。至少给一项；偶尔一次就好（与签名/在线状态共享每日额度）。'
        + '**两个副作用要知道**：① 群里显示的自称由管理端的人设设置决定，改 QQ 昵称不会改那边（人设里没设置过群内展示名时，才会跟着 QQ 昵称走）；② 改了昵称会让当天还没发布的「说说」草稿失效，需要重新生成。',
      parameters: {
        type: 'object',
        properties: {
          nickname: { type: 'string', description: 'QQ 昵称（≤24 字）' },
          personalNote: { type: 'string', description: '个性说明（≤40 字，别写联系方式）' },
          sex: { type: ['integer', 'string'], description: '性别：0 未知 / 1 男 / 2 女' }
        }
      },
      async execute(ctx, args) {
        try {
          const nickname = safeSlice(String(args.nickname ?? '').trim(), 24);
          const wantsNote = args.personalNote !== undefined && args.personalNote !== null;
          const personalNote = wantsNote ? safeSlice(String(args.personalNote).trim(), 40) : undefined;
          const sexRaw = String(args.sex ?? '').trim();
          if (!nickname && !wantsNote && !sexRaw) return err('昵称 / 个性说明 / 性别至少要给一项');
          let sex;
          if (sexRaw) {
            sex = Number(normalizeMid(sexRaw));
            if (![0, 1, 2].includes(sex)) return err('sex 只能是 0（未知）/ 1（男）/ 2（女）');
          }
          const profileLimit = platformQuotaLimit(getConfig(), 'profilePerDay');
          profileQuota.configure({ globalMax: profileLimit, perChatMax: Infinity });
          const reservedAt = Date.now();
          if (!profileQuota.tryConsume(ctx.chatKey, reservedAt).ok) return err(`今天的资料改动次数用完了（每天最多 ${profileLimit} 次）`);
          try {
            await trackDirectWrite(ctx, 'profile', {}, () => ctx.onebot.setProfile({ nickname: nickname || undefined, personalNote, sex }, { signal: ctx.signal }));
          } catch (error) {
            profileQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          // 改昵称后必须刷新登录信息：@我 判定、提示词里的名字、自己贴的表情回应去重都读它
          // 刷新自己的登录信息是 **best-effort**：昵称已经改成功了，这一步失败只该留痕，
          // 不该把整次调用报成"改资料失败"（模型会以为没改、再改一次，白烧一次额度）。
          if (nickname) {
            try { await ctx.onebot.refreshSelfInfo?.(); } catch { /* 下一轮/重连时会自然刷新 */ }
          }
          return ok({
            nickname: nickname || undefined, personalNote, sex,
            note: '资料已改。' + (nickname ? '（群里的自称以管理端人设里的"群内展示名"为准；当天还没发布的说说草稿会失效。）' : '')
          });
        } catch (error) {
          return sendErr(error, {}, `改资料失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_group_profile',
      description: '看本群的资料：群详情（简介/群备注/人数）、群公告、群荣誉（龙王/群聊之火这类）。群聊限定、不用参数。被问到群规、公告、谁最活跃时用它；别在没人问的时候念公告。',
      parameters: {
        type: 'object',
        properties: { what: { type: 'string', description: '可选：detail | notice | honors，缺省三样都取' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群资料只能在群聊里看');
          const groupId = Number(ctx.chatId);
          // what 只认 detail/notice/honors（缺省全取）；表外的值（模型爱写的 notices/公告）
          // 一律当"全取" —— 静默返回 {} 会让它以为这个群没有资料（2026-10-07 复审 P3）。
          const whatRaw = String(args.what ?? '').trim();
          const what = ['detail', 'notice', 'honors'].includes(whatRaw) ? whatRaw : '';
          const want = (name) => !what || what === name;
          const out = {};
          const failures = [];
          if (want('detail')) {
            try {
              const d = await ctx.onebot.call('get_group_detail_info', { group_id: groupId }, 15000, ctx.signal) || {};
              // 群名/群备注/群简介都是群可控内容（群管改群名就能改）：与 honors 分支同口径过
              // 段头弱化（2026-10-12 审查：这里此前只 cleanHtmlText，与同函数的 honors 不一致）。
              out.detail = sanitizeDeep({
                name: d.group_name ?? d.groupName ?? '',
                remark: d.group_remark ?? '',
                // 实测（SnowLuma 1.14.22）：简介在 group_memo，描述在 group_description
                intro: safeSlice(cleanHtmlText(d.group_memo ?? d.group_desc ?? d.group_description ?? d.description ?? d.intro ?? ''), 300),
                memberCount: d.member_count ?? d.memberCount ?? null,
                maxMembers: d.max_member_count ?? null
              });
            } catch (error) { failures.push(`群详情：${error?.message ?? error}`); }
          }
          if (want('notice')) {
            try {
              const notices = await ctx.onebot.call('_get_group_notice', { group_id: groupId }, 15000, ctx.signal);
              // 群公告同理（公告正文是群管可写内容）
              out.notices = sanitizeDeep((Array.isArray(notices) ? notices : []).slice(0, 3).map((n) => ({
                time: n?.publish_time ?? n?.time ?? null,
                forNewMembers: n?.send_to_new_members === true,
                text: safeSlice(cleanHtmlText(n?.message?.text ?? n?.text ?? n?.content ?? ''), 500)
              })).filter((n) => n.text));
              if (!out.notices.length) out.notices = [];
            } catch (error) { failures.push(`群公告：${error?.message ?? error}`); }
          }
          if (want('honors')) {
            try {
              const rawHonors = await ctx.onebot.call('get_group_honor_info', { group_id: groupId, type: 'all' }, 15000, ctx.signal) || {};
              // 称号/描述是群友可见内容：形状不可控，整树过一道段头弱化（JSON 往返）
              out.honors = sanitizeDeep(rawHonors);
            } catch (error) { failures.push(`群荣誉：${error?.message ?? error}`); }
          }
          if (failures.length && !Object.keys(out).length) return err(failures.join('；'));
          return ok(failures.length ? { ...out, failures } : out);
        } catch (error) {
          return err(`取群资料失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'group_sign',
      description: '在群里签到打卡（**每个群每天只会真签一次**，重复调用会直接告诉你今天签过了；签到结果群里可见）。适合每天头一回进群时顺手点一下。',
      parameters: { type: 'object', properties: {} },
      async execute(ctx) {
        try {
          if (ctx.kind !== 'group') return err('签到只能在群聊里做');
          // 每个群每天一次：重复签没有意义，而且这是对外写（2026-10-07 审计：此前既不走队列
          // 也没有任何闸门）。跨日自然失效（上海自然日，与存档/日报同一口径）。
          const day = todayKey();
          if (signedDayByChat.get(ctx.chatKey) === day) {
            return ok({ signed: false, note: '今天这个群已经签过了，不用再签。' });
          }
          await trackDirectWrite(ctx, 'group-sign', { groupId: Number(ctx.chatId) }, () => ctx.onebot.call('set_group_sign', { group_id: Number(ctx.chatId) }, 15000, ctx.signal));
          signedDayByChat.set(ctx.chatKey, day);
          return ok({ signed: true, note: '已签到。' });
        } catch (error) {
          return err(`签到失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'set_group_todo',
      description: '把群里某条消息设成群待办（会显示在群聊输入框上方，所有人可见）。适合"今晚八点狼人杀"这类要让所有人记住的安排 —— 先 send_message 发出来，再把它设成待办。**同一条消息只会设一次，每个群每天最多设几条**；别滥用。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: '要设成待办的消息 id（聊天记录里的 #数字）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群待办只能在群聊里设');
          const mid = normalizeMid(args.messageId);
          // 非数字 mid 会以 NaN 上wire（JSON 序列化成 null）：与 react_to_message 同口径先拦下
          // （2026-10-07 复审 P3）。**允许负号**：QQ 的消息 id 有负数形态（引用就渲染成
          // `[引用#-102·甲：…]`，replyToMessageId 也一直用 `/^-?[1-9]\d*$/`），一律要求
          // 纯数字会把这类合法 id 挡在门外（2026-10-14 复审 P3）。
          if (!/^-?\d+$/.test(mid)) return err('messageId 要是消息 id（聊天记录里那条消息前的 #数字）');
          // 两层兜底（2026-10-07 审计：此前既不走队列也没有任何闸门）：
          // ① 同一条消息今天设过就不再调（重复设没有任何效果）；
          // ② 每个群每天最多 TODO_PER_GROUP_PER_DAY 条，防一轮里连设不同消息刷屏。
          const day = todayKey();
          const rec = todoDayByChat.get(ctx.chatKey);
          const today = rec && rec.day === day ? rec : { day, mids: new Set(), count: 0 };
          if (today.mids.has(mid)) {
            return ok({ todo: false, messageId: mid, note: '这条消息今天已经设过群待办了。' });
          }
          if (today.count >= TODO_PER_GROUP_PER_DAY) {
            return err(`今天这个群的群待办已经设了 ${TODO_PER_GROUP_PER_DAY} 条，够多了，明天再说。`);
          }
          await trackDirectWrite(ctx, 'group-todo', { groupId: Number(ctx.chatId), mid }, () => ctx.onebot.call('set_group_todo', { group_id: Number(ctx.chatId), message_id: Number(mid) }, 15000, ctx.signal));
          today.mids.add(mid);
          today.count += 1;
          todoDayByChat.set(ctx.chatKey, today);
          return ok({ todo: true, messageId: mid, note: '已设成群待办。' });
        } catch (error) {
          return err(`设群待办失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'read_image_text',
      description: '读出消息里图片上的文字（QQ 服务端 OCR，只认文字不认画面）。看截图/通知/表格里的字用它，省算力；要理解画面内容（表情、照片）就用看图工具（只有「图片输入」开着时才有那个工具）。id 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!modelVisible(entry)) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const media = (Array.isArray(entry.media) ? entry.media : []).filter((m) => m && m.kind === 'image');
          if (!media.length) return ok(`消息 ${args.messageId} 里没有图片。`);
          const candidates = [];
          for (const m of media) {
            const url = String(m.url || '').trim();
            if (/^https?:\/\//i.test(url)) candidates.push(url);
            const file = String(m.file || '').trim();
            if (file) candidates.push(file);
          }
          const texts = [];
          let lastError = '';
          for (const image of candidates) {
            ctx.signal?.throwIfAborted();
            try {
              // 同 send_group_file / set_my_avatar：地址交给协议端去取，不经 safe-fetch，
              // 内网防护得自己来（2026-10-09 全面审查）
              if (/^https?:\/\//i.test(image)) assertPublicUrlLiteral(image, { label: '图片地址' });
              const res = await ctx.onebot.call('ocr_image', { image }, 30000, ctx.signal);
              for (const t of (Array.isArray(res?.texts) ? res.texts : [])) {
                const line = String(t?.text ?? '').trim();
                if (line) texts.push(line);
              }
              if (texts.length) break;
            } catch (error) { lastError = String(error?.message ?? error); }
          }
          if (!texts.length) return err(lastError ? `OCR 失败：${lastError}` : '这张图里没认出文字（可能是纯画面或表情包）。');
          return ok({ text: safeSlice(sanitizeUserText(texts.join('\n')), 4000), note: '以上是图上的文字（OCR）。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_qq_voice',
      description: '用 QQ 内置的 AI 语音角色给群里发一条语音（群聊限定）。音色由控制台「平台能力」页固定时直接用那个音色（不用传 character）；没固定时第一次先不传 character：返回可选角色列表，挑一个再带 character 调一次。text 是让它说的那句话（≤60 字，短句最自然）。玩梗、撒娇、念台词时用，别频繁。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的内容（≤60 字）' },
          character: { type: 'string', description: '语音角色 id（省略则返回可用角色列表；控制台已固定音色时忽略此项）' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('QQ 语音只能发在群聊里');
          const groupId = Number(ctx.chatId);
          // 说明里写的是 ≤60 字（引导模型说短句），硬截断也用同一个数：两处口径必须一致
          // （2026-10-07 复审 P3：原来代码 80、说明 60）。
          const text = safeSlice(String(args.text ?? '').trim(), 60);
          if (!text) return err('text 不能为空');
          // 控制台固定了音色就以它为准（用户定的"这个机器人说话是什么声音"；模型传的忽略）。
          const pinned = String(getConfig().platform?.qqVoiceCharacter || '').trim();
          const character = pinned || String(args.character ?? '').trim();
          if (!character) {
            const flat = await ctx.onebot.getAiCharacters(groupId, { signal: ctx.signal });
            // 同一个音色会出现在多个分类里（协议端就是这么分的）：给模型看的列表按 id 去重
            const seen = new Set();
            const unique = flat.filter((c) => (seen.has(c.characterId) ? false : (seen.add(c.characterId), true)));
            return ok({ characters: unique.slice(0, 40), note: unique.length ? '挑一个 characterId，再带 text 调一次就能发。' : '这个群暂时没有可用的 QQ 语音角色。' });
          }
          // 取角色列表不消耗动作配额；确定音色、真正要发时才检查冷却。
          const humanGate = actionGate(ctx, 'voice');
          if (!humanGate.ok) return err(humanGate.reason, { reportIncident: false });
          // 走发送队列（限频 / 禁言预检 / outbox）：与 send_message / send_voice 同款。
          // 2026-10-07 复审 P2：原先直接 onebot.call —— 模型抽风时这条没有任何限频，
          // 失败也只在调用栈里（禁言群还会白刷一条异常）。
          await ctx.sender.aiVoice(ctx.chatKey, { character, text }, { runId: ctx.session?.leaseId, signal: ctx.signal });
          actionDone(ctx, 'voice');
          afterSent(() => {
            ctx.session.sent.push({ type: 'voice', text: `[QQ语音]${text}`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
            ctx.emit('session-update', ctx.session.id);
          });
          return ok({ sent: true, character, note: pinned ? '语音已发送（音色按控制台固定的）。' : '语音已发送。' });
        } catch (error) {
          return sendErr(error, {}, `发 QQ 语音失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'set_remark',
      description: '给你 QQ 里的好友/群设备注（只有你自己看得到的那种，客户端里可见）。userId 填某人 QQ 号＝给这个人备注；不填＝给当前群备注。写短、有辨识度的称呼或梗（≤16 字），别乱改、别写奇怪东西（每天最多几次）。'
        + '**注意：这不会改变你在聊天记录里看到的称呼** —— 那边显示的名字是本机的「称呼/备注」，要改用 set_member_note；设完看不到变化是正常的，别为此重复设。',
      parameters: {
        type: 'object',
        properties: {
          remark: { type: 'string', description: '备注内容（≤16 字）' },
          userId: { type: ['integer', 'string'], description: '可选：要备注的好友 QQ 号；不填＝当前群' }
        },
        required: ['remark']
      },
      async execute(ctx, args) {
        try {
          const remark = safeSlice(String(args.remark ?? '').trim(), 16);
          if (!remark) return err('remark 不能为空');
          const userId = normalizeMid(args.userId);
          if (!userId && ctx.kind !== 'group') return err('私聊里要传 userId 指定给谁备注');
          // 数字校验要在扣额度**之前**：以前放在 tryConsume 之后，模型传个名字就会
          // 白扣一天 5 次里的一次（2026-10-07 复审 P3；与 react_to_message 同口径）。
          if (userId && !/^\d+$/.test(userId)) return err('userId 要是数字 QQ 号（不知道就先查 get_active_members）');
          const remarkLimit = platformQuotaLimit(getConfig(), 'remarksPerDay');
          remarkQuota.configure({ globalMax: remarkLimit, perChatMax: Infinity });
          const reservedAt = Date.now();
          if (!remarkQuota.tryConsume(ctx.chatKey, reservedAt).ok) return err(`今天的备注次数用完了（每天最多 ${remarkLimit} 次）`);
          try {
            if (userId) {
              await trackDirectWrite(ctx, 'remark', { userId: Number(userId), remark }, () => ctx.onebot.call('set_friend_remark', { user_id: Number(userId), remark }, 15000, ctx.signal));
            } else {
              await trackDirectWrite(ctx, 'remark', { groupId: Number(ctx.chatId), remark }, () => ctx.onebot.call('set_group_remark', { group_id: Number(ctx.chatId), remark }, 15000, ctx.signal));
            }
          } catch (error) {
            remarkQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          return ok({
            remark,
            target: userId || ctx.chatId,
            note: '备注已设置（改的是你 QQ 客户端里的备注；聊天记录里显示的称呼不会因此改变，别重复设）。'
          });
        } catch (error) {
          return err(`设备注失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'set_member_note',
      description: '给某个 QQ 记一个固定称呼（"备注/代号"）：记下之后，你在聊天记录、成员列表里看到的这个人都会优先用这个称呼（控制台「人物记忆页 → 备注」看到的是同一份）。群友让你"以后叫他 X""别喊群名片、喊 X"时用它；改称呼就按新称呼再调一次，想清掉就把 name 传空字符串。'
        + '写短、能当称呼用（≤16 字）；只能给当前会话里出现过的人设，号码不确定就先 get_group_member_list / get_active_members 查，别记错人。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '要设称呼的人的 QQ 号（数字）' },
          name: { type: 'string', description: '称呼（≤16 字；传空字符串=清除该称呼）' }
        },
        required: ['userId', 'name']
      },
      async execute(ctx, args) {
        try {
          const userId = normalizeMid(args.userId);
          if (!userId || !/^\d{1,15}$/.test(userId)) {
            return err(`userId 要是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。${memberHint(ctx)}`);
          }
          // 与 memory_append 同款的号码护栏：模型会编错号，称呼记错人比记错印象更显眼
          if (!hasParticipant(ctx, userId)) {
            return err(`${userId} 不是当前会话中出现过的成员 QQ 号。${memberHint(ctx)}`);
          }
          const saved = setMemberNote(userId, safeSlice(String(args.name ?? '').trim(), 16));
          return ok({
            userId, name: saved,
            note: saved
              ? `记下了：以后称呼 QQ ${userId} 为「${saved}」，聊天记录与成员列表里都会用这个称呼。`
              : `已清掉 QQ ${userId} 的称呼，回到群名片默认。`
          });
        } catch (error) {
          return err(`设称呼失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'list_group_files',
      description: '看本群群文件的根目录（文件与文件夹）。群聊限定。要下载/读里面某个文件时，用它的 fileId 调 group_file_url 拿直链（文本类可以再用 web_fetch 读内容）。',
      parameters: { type: 'object', properties: {} },
      async execute(ctx) {
        try {
          if (ctx.kind !== 'group') return err('群文件只能在群聊里看');
          const res = await ctx.onebot.call('get_group_root_files', { group_id: Number(ctx.chatId) }, 20000, ctx.signal) || {};
          const files = (Array.isArray(res.files) ? res.files : []).slice(0, 30).map((f) => ({
            name: sanitizeUserText(String(f.file_name ?? f.name ?? '')),
            sizeKB: Math.round(Number(f.file_size ?? f.size ?? 0) / 1024),
            fileId: f.file_id ?? f.id ?? '',
            uploader: sanitizeUserText(String(f.uploader_name ?? f.uploader ?? ''))
          })).filter((f) => f.name || f.fileId);
          const folders = (Array.isArray(res.folders) ? res.folders : [])
            .map((f) => sanitizeUserText(String(f.folder_name ?? f.name ?? ''))).filter(Boolean);
          return ok({ files, folders, note: files.length ? '取某个文件的下载直链用 group_file_url（fileId 填上面的）。' : '群文件根目录是空的。' });
        } catch (error) {
          return err(`看群文件失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'group_file_url',
      description: '拿群里某个文件的下载直链（fileId 来自 list_group_files，或消息里的 [文件…] 段）。文本类文件拿到直链后可以用 web_fetch 读内容；其它类型只给链接。',
      parameters: {
        type: 'object',
        properties: { fileId: { type: 'string', description: '群文件 id（来自 list_group_files）' } },
        required: ['fileId']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群文件只能在群聊里取');
          const fileId = String(args.fileId ?? '').trim();
          if (!fileId) return err('fileId 不能为空（用 list_group_files 查）');
          const res = await ctx.onebot.call('get_group_file_url', { group_id: Number(ctx.chatId), file_id: fileId }, 20000, ctx.signal);
          const url = String(res?.url ?? '').trim();
          if (!url) return err('协议端没有返回下载链接（文件可能已过期或被清理）');
          return ok({ url, note: '文本类文件可以直接用 web_fetch 读这个链接。' });
        } catch (error) {
          return err(`取群文件直链失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'send_group_file',
      description: '往群里发一个文件（群聊限定）。text＝把一段文字生成 .txt 发出去（导出长清单/日报用）；url＝转发一个直链文件（协议端去下载）。name 是文件名（带扩展名）。发文件很显眼，别频繁、别当消息用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要写成文件的文字（与 url 二选一）' },
          url: { type: 'string', description: '要转发的文件直链（与 text 二选一）' },
          name: { type: 'string', description: '文件名（带扩展名，如 名单.txt；缺省按内容生成）' }
        }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('发群文件只能在群聊里');
          const text = String(args.text ?? '');
          const url = String(args.url ?? '').trim();
          if (!text && !url) return err('text 和 url 至少给一个');
          if (text && url) return err('text 和 url 只能给一个');
          const stamp = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }).replace(/\//g, '');
          const name = safeSlice(String(args.name ?? '').trim(), 60) || `文本${stamp}.txt`;
          // ⚠️ url 是模型给的（可能被群消息/网页内容里的提示词注入带偏），而它会被**原样交给
          // 协议端**去下载 —— 那个请求发生在我们的网络层之外，safe-fetch 的内网/SSRF 防护
          // 一点也盖不到。不挡的话就是一条现成的 SSRF：诱导模型传 http://169.254.169.254/…
          // 或 docker bridge 网关上的宿主服务，响应被当文件发进群 = 数据外带
          //（2026-10-09 全面审查）。text 走 base64 那条路没有外部地址，不需要校验。
          //
          // ⚠️ 协议端把 file 字段当"URL / base64 / **协议端能读到的本地路径**"三态都收
          // （见 onebot.js setAvatar 的注释），所以"只校验 http 形态"等于没防：`/app/data/config.json`、
          // `file:///etc/passwd` 这类非 http 前缀会原样透传，让协议端读本机文件发进群
          //（2026-10-09 审查 P1）。非 http(s) 一律拒；本机内容用 text 参数走 base64。
          if (url && !/^https?:\/\//i.test(url)) {
            return err('文件地址只支持 http(s) 直链；要发本机生成的内容请用 text 参数');
          }
          if (url) {
            try {
              assertPublicUrlLiteral(url, { label: '文件地址' });
            } catch (error) {
              return err(`这个文件地址不能发：${error?.message ?? error}`);
            }
          }
          const file = url || `base64://${Buffer.from(text, 'utf8').toString('base64')}`;
          // 走发送队列（限频/禁言预检/outbox）：群文件在群里可见，与发消息同类
          // （2026-10-07 复审 P2）。
          const sent = await ctx.sender.groupFile(ctx.chatKey, { file, name }, { runId: ctx.session?.leaseId, signal: ctx.signal });
          if (ctx.session) ctx.session.visibleReply = true;   // 群文件也是可见回复
          return ok({ sent: true, name, fileId: sent.file_id ?? null, note: '文件已发到群文件。' });
        } catch (error) {
          return sendErr(error, {}, `发群文件失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'send_private_file',
      description: `把本次生成或用户提供的文字作为资料文件发给当前私聊（默认关闭）。只在用户需要可保存的文本资料时用；不读取本机文件、不抓取地址、不指定收件人。支持 txt/md/csv/json，正文最多 ${privateFileMaxKiB(getConfig().platform)} KiB。`,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要写入文件的完整文字；不把路径或链接当成待读取的文件' },
          name: { type: 'string', description: '单个安全文件名，最多 120 字节，仅 txt/md/csv/json；默认 notes.txt' }
        },
        required: ['text'],
        additionalProperties: false
      },
      async execute(ctx, args) {
        if (ctx.kind !== 'private' || ctx.chatKey !== `private:${ctx.chatId}`) {
          return err('仅允许在已启用文本文件发送的当前私聊中使用');
        }
        let name;
        try { ({ name } = preparePrivateTextFile(args, getConfig().platform)); } catch (error) {
          // 参数问题是模型可修正的输入错误，不是运行故障，不刷异常面板。
          return err(error.message, { reportIncident: false });
        }
        try {
          const cfg = getConfig();
          if (!platformToolAllowed('send_private_file', cfg.platform, ctx.chatKey)) throw privateTextFileError('PRIVATE_FILE_DISABLED');
          const limit = platformQuotaLimit(cfg, 'privateFilesPerDay');
          privateFileQuota.configure({ globalMax: limit, perChatMax: Infinity });
          const reservedAt = Date.now();
          const quota = privateFileQuota.tryConsume(ctx.chatKey, reservedAt);
          if (!quota.ok) {
            return err(`今天发送的私聊文本文件达到上限（${limit} 个），明天再继续`, { reportIncident: false });
          }
          let sent;
          try {
            sent = await ctx.sender.privateTextFile(ctx.chatKey, args, { runId: ctx.session?.leaseId, signal: ctx.signal });
          } catch (error) {
            const safe = privateTextFileError(error?.code);
            // 只有 sender 明确标成 unknown 的才保留额度（可能已送达）；无 code 的
            // 排队/存储异常都发生在真正上传之前，退还额度，避免基础设施抖动吃掉当天份额。
            if (!(safe.delivery === 'unknown' && error?.delivery === 'unknown')) {
              privateFileQuota.refund(ctx.chatKey, reservedAt);
            }
            throw error;
          }
          if (ctx.session) ctx.session.visibleReply = true;
          return ok({ sent: true, name, fileId: sent.file_id ?? null, note: '文件已发送到当前私聊。' });
        } catch (error) {
          const safe = privateTextFileError(error?.code);
          return sendErr(error, { errorCode: safe.code, delivery: safe.delivery, autoRetry: false,
            ...(safe.delivery === 'not_attempted' ? { reportIncident: false } : {}) }, safe.message);
        }
      }
    },
    {
      name: 'list_group_album',
      description: '看本群的相册（群聊限定）：不带参数列相册（id/名字/照片数）；带 albumId 时列该相册最近的照片（含 lloc/batchId，可用于点赞评论）。别人把你拉进相册回忆、或问"相册里那张照片"时用它。',
      parameters: {
        type: 'object',
        properties: { albumId: { type: 'string', description: '可选：相册 id（来自上一次调用）' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群相册只能在群聊里看');
          const groupId = Number(ctx.chatId);
          const albumId = String(args.albumId ?? '').trim();
          if (!albumId) {
            const list = await ctx.onebot.call('get_group_album_list', { group_id: groupId }, 20000, ctx.signal);
            const albums = (Array.isArray(list) ? list : []).slice(0, 20).map((a) => ({
              id: String(a?.id ?? a?.album_id ?? ''), name: sanitizeUserText(String(a?.name ?? a?.album_name ?? '')),
              pics: Number(a?.picNum ?? a?.pic_num ?? 0) || 0, createTime: a?.createTime ?? a?.create_time ?? null
            })).filter((a) => a.id);
            return ok({ albums, note: albums.length ? '带 albumId 再调一次能看照片列表。' : '这个群还没有相册。' });
          }
          const res = await ctx.onebot.call('get_group_album_media_list', { group_id: groupId, album_id: albumId }, 20000, ctx.signal);
          const raw = Array.isArray(res) ? res : (Array.isArray(res?.media_list) ? res.media_list : (Array.isArray(res?.photos) ? res.photos : []));
          const photos = raw.slice(0, 20).map((p) => ({
            lloc: String(p?.lloc ?? p?.photo_id ?? ''), batchId: String(p?.batch_id ?? p?.batchId ?? ''),
            uploader: sanitizeUserText(String(p?.uploader_name ?? p?.uploader ?? '')), time: p?.upload_time ?? p?.time ?? null,
            desc: safeSlice(sanitizeUserText(String(p?.desc ?? p?.title ?? '')), 60)
          })).filter((p) => p.lloc || p.batchId);
          return ok({ albumId, photos, note: photos.length ? '点赞用 batchId(+lloc)，评论用 lloc。' : '这个相册没有取到照片（可能没权限或为空）。' });
        } catch (error) {
          return err(`看群相册失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'like_album_photo',
      description: '给群相册里的一张照片点赞（群聊限定）。albumId/batchId/lloc 用 list_group_album 查到的值。轻互动，别刷。',
      parameters: {
        type: 'object',
        properties: {
          albumId: { type: 'string', description: '相册 id' },
          batchId: { type: 'string', description: '照片批次 id' },
          lloc: { type: 'string', description: '可选：照片定位（没有就不传）' }
        },
        required: ['albumId', 'batchId']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群相册只能在群聊里操作');
          const albumId = String(args.albumId ?? '').trim();
          const batchId = String(args.batchId ?? '').trim();
          if (!albumId || !batchId) return err('albumId 和 batchId 都要给（用 list_group_album 查）');
          const lloc = String(args.lloc ?? '').trim();
          // 与贴表情同档的轻互动闸门（事前原子消费 + 失败退还）：2026-10-07 审计发现
          // 点赞/评论此前既不走发送队列也没有配额，模型一轮里连刷会全部落到 QQ。
          const albumLimit = platformQuotaLimit(getConfig(), 'albumWritesPerHour');
          albumWriteQuota.configure({ globalMax: albumLimit, perChatMax: Infinity });
          const reservedAt = Date.now();
          if (!albumWriteQuota.tryConsume(ctx.chatKey, reservedAt).ok) {
            return err(`这一小时的相册互动够多了（上限 ${albumLimit} 次），过一会儿再点。`);
          }
          try {
            await trackDirectWrite(ctx, 'album-like', { albumId, batchId, lloc }, () => ctx.onebot.call('set_group_album_media_like', {
              group_id: Number(ctx.chatId), album_id: albumId, batch_id: batchId, ...(lloc ? { lloc } : {})
            }, 20000, ctx.signal));
          } catch (error) {
            albumWriteQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          if (ctx.session) ctx.session.visibleReply = true;   // 点赞也是可见动作
          return ok({ liked: true, note: '点赞成功。' });
        } catch (error) {
          return err(`相册点赞失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'comment_album_photo',
      description: '给群相册里的一张照片留一条评论（群聊限定，所有能看到相册的人都看得见）。albumId/lloc 用 list_group_album 查到的值；评论要短、像群友说话。别乱评、别刷。',
      parameters: {
        type: 'object',
        properties: {
          albumId: { type: 'string', description: '相册 id' },
          lloc: { type: 'string', description: '照片定位 id' },
          content: { type: 'string', description: '评论内容（≤40 字）' }
        },
        required: ['albumId', 'lloc', 'content']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群相册只能在群聊里操作');
          const albumId = String(args.albumId ?? '').trim();
          const lloc = String(args.lloc ?? '').trim();
          const content = safeSlice(String(args.content ?? '').trim(), 40);
          if (!albumId || !lloc || !content) return err('albumId、lloc、content 都要给（lloc 用 list_group_album 查）');
          // 与点赞共用同一个闸门：评论是公开内容，比点赞更容易变成噪音（2026-10-07 审计）
          const albumLimit = platformQuotaLimit(getConfig(), 'albumWritesPerHour');
          albumWriteQuota.configure({ globalMax: albumLimit, perChatMax: Infinity });
          const reservedAt = Date.now();
          if (!albumWriteQuota.tryConsume(ctx.chatKey, reservedAt).ok) {
            return err(`这一小时的相册互动够多了（上限 ${albumLimit} 次），过一会儿再评。`);
          }
          try {
            await trackDirectWrite(ctx, 'album-comment', { albumId, lloc }, () => ctx.onebot.call('do_group_album_comment', {
              group_id: Number(ctx.chatId), album_id: albumId, lloc, content
            }, 20000, ctx.signal));
          } catch (error) {
            albumWriteQuota.refund(ctx.chatKey, reservedAt);
            throw error;
          }
          if (ctx.session) ctx.session.visibleReply = true;   // 评论所有人可见
          return ok({ commented: true, content, note: '评论已发。' });
        } catch (error) {
          return err(`相册评论失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'upload_to_group_album',
      description: '把某条消息里的图传进本群相册（群聊限定；**所有人都能看到这张照片**，只在真的是群活动/纪念图时才用）。messageId 是要传的那条消息的 #数字；albumId/albumName 不传就用第一个相册。别传别人的生活照。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '图所在消息的 id（聊天记录里的 #数字）' },
          albumId: { type: 'string', description: '可选：目标相册 id' },
          albumName: { type: 'string', description: '可选：目标相册名（与 albumId 配套）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群相册只能在群聊里操作');
          const groupId = Number(ctx.chatId);
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!modelVisible(entry)) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const media = (Array.isArray(entry.media) ? entry.media : []).filter((m) => m && m.kind === 'image');
          const target = media.find((m) => /^https?:\/\//i.test(String(m.url || ''))) || media[0];
          if (!target) return ok(`消息 ${args.messageId} 里没有可上传的图片。`);
          const file = /^https?:\/\//i.test(String(target.url || '')) ? String(target.url) : String(target.file || '');
          if (!file) return err('这张图拿不到可上传的地址');
          // 群相册上传也是把地址交给协议端去取，同 set_my_avatar（2026-10-09 全面审查）
          if (/^https?:\/\//i.test(file)) {
            try {
              assertPublicUrlLiteral(file, { label: '图片地址' });
            } catch (error) {
              return err(`这张图的地址不能用：${error?.message ?? error}`);
            }
          }
          let albumId = String(args.albumId ?? '').trim();
          let albumName = String(args.albumName ?? '').trim();
          if (!albumId) {
            const list = await ctx.onebot.call('get_group_album_list', { group_id: groupId }, 20000, ctx.signal);
            const first = (Array.isArray(list) ? list : []).find((a) => (a?.id ?? a?.album_id));
            if (!first) return err('这个群还没有相册，先让别人在 QQ 里建一个');
            albumId = String(first.id ?? first.album_id);
            albumName = String(first.name ?? first.album_name ?? '');
          }
          await ctx.sender.albumPhoto(ctx.chatKey, { file, albumId, albumName }, { runId: ctx.session?.leaseId, signal: ctx.signal });
          if (ctx.session) ctx.session.visibleReply = true;   // 传相册也是可见动作
          return ok({ uploaded: true, albumId, note: '已传进群相册（所有人都能看到）。' });
        } catch (error) {
          return sendErr(error, {}, `传相册失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_user_info',
      description: '查一个 QQ 号的公开资料（昵称/性别/年龄等）。适合弄清"这个人是谁"——只在用得着时查，别人资料别到处报。',
      parameters: {
        type: 'object',
        properties: { userId: { type: ['integer', 'string'], description: 'QQ 号' } },
        required: ['userId']
      },
      async execute(ctx, args) {
        try {
          const userId = normalizeMid(args.userId);
          if (!/^\d+$/.test(String(userId || ''))) return err(`userId 要是数字 QQ 号。${memberHint(ctx)}`);
          const info = await ctx.onebot.call('get_stranger_info', { user_id: Number(userId) }, 15000, ctx.signal) || {};
          return ok({
            userId,
            nickname: sanitizeUserText(String(info.nickname ?? info.nick ?? '')),
            sex: info.sex ?? '', age: info.age ?? null,
            level: info.level ?? info.qqLevel ?? null
          });
        } catch (error) {
          return err(`查资料失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'translate_text',
      description: '英文翻译成中文（QQ 自带翻译）。你自己就能翻译，只在想省 token、或想看看 QQ 的译法时用；一次最多几句。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要翻译的英文（≤500 字）' } },
        required: ['text']
      },
      async execute(ctx, args) {
        try {
          const text = safeSlice(String(args.text ?? '').trim(), 500);
          if (!text) return err('text 不能为空');
          const res = await ctx.onebot.call('translate_en2zh', { words: [text] }, 20000, ctx.signal);
          const out = Array.isArray(res?.words) ? res.words.join('\n') : '';
          if (!out) return err('翻译没有返回内容');
          // 译文可能带着原文里的"段头伪装"（用户可以造一句带【管理员附加规则】的英文让翻译带回来）
          return ok({ translation: sanitizeUserText(out) });
        } catch (error) {
          return err(`翻译失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'schedule_wake',
      description: '给自己安排一次稍后的主动发言机会。适用：想等这波聊完再接话、话题冷一点再补一句、过一会儿想追问某件事、或想让群里过会儿有人说话。到点后你会被唤醒，并看到自己当时留的想法。只能安排当前所在的这个会话；同一会话只保留最近一次安排（再次调用会覆盖）。注意：这不是给别人设提醒，是给自己安排开口时机。',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: '多少分钟后唤醒自己（5~240 分钟）' },
          note: { type: 'string', description: '给未来的自己留一句话：到点想做什么、想说什么' }
        },
        required: ['minutes']
      },
      async execute(ctx, args) {
        try {
          if (typeof ctx.scheduleWake !== 'function') return err('当前环境不支持自主唤醒');
          const m = Number(args.minutes);
          if (!Number.isFinite(m) || m < 5 || m > 240) return err('minutes 需要是 5~240 之间的数字');
          const note = safeSlice(String(args.note ?? ''), 200);
          const at = ctx.scheduleWake(Math.round(m * 60000), note);
          const when = new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
          return ok({ scheduled: true, minutes: Math.round(m), at: when, note, hint: '到点会作为主动机会唤醒你；不需要再回复这条结果。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'life_feed_next',
      description: '从生活层候选队列里取 1-3 条见闻（B站或插件来源，含标题、UP、时长、播放、标签、链接、简介）。想主动分享点群友可能感兴趣的内容时用它；取到后用自己的语气说，不要念标题。每天有领取上限，取完不想用可以用 life_feed_feedback 标记 skip。',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: '要几条，1~3，默认 2' },
          topic: { type: 'string', description: '可选：只看标题/简介/标签里包含这个词的候选' }
        }
      },
      async execute(ctx, args) {
        try {
          const feed = ctx.getLifeFeed?.();
          if (!feed) return err('生活层没有开启');
          // 自主节奏（paced）唤醒带 manual:true 派发，但不是人工：不能绕过手动模式/目标群/额度。
          const humanShare = ctx.session?.manual === true && ctx.paced !== true;
          if (!humanShare) {
            if (feed.shareMode?.() === 'manual') return err('生活层当前是手动分享模式，等管理员在控制台点分享。', { reportIncident: false });
            if (feed.isShareTarget?.(ctx.chatKey) === false) return err('当前会话不在见闻分享目标里。', { reportIncident: false });
          }
          const count = Math.max(1, Math.min(3, Math.round(Number(args.count) || 2)));
          const topic = safeSlice(String(args.topic ?? ''), 20);
          const result = feed.next({ count, topic, manual: humanShare });
          if (result.error) return err(result.error);
          return ok({
            items: result.items.map((item) => ({
              bvid: item.id,
              // 标题/UP/简介来自公开页面，按不可信文本处理，去掉段头伪装
              title: sanitizeUserText(String(item.title ?? '')),
              up: sanitizeUserText(String(item.up ?? '')),
              source: sanitizeUserText(String(item.source ?? '')),
              via: sanitizeUserText(String(item.via ?? '')),
              durationSec: item.duration,
              play: item.play,
              tags: (Array.isArray(item.tags) ? item.tags : []).map((tag) => sanitizeUserText(String(tag))),
              url: sanitizeUserText(String(item.url ?? '')),
              summary: sanitizeUserText(safeSlice(String(item.desc ?? ''), 200))
            })),
            note: '选好后用 share_bilibili 分享（会先发标题+链接+你的话，再补封面），别念标题；不要用 send_message 重复发链接。不想发就用 life_feed_feedback 标记 skip。'
          });
        } catch (error) {
          return err(`生活层取内容失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'life_feed_feedback',
      description: '回写生活层：shared=已经分享到群里；skip=这条不想用；more_like_this=以后多找类似的。不调用不会报错，但 shared 会让这条从队列移除并计入已领取。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'life_feed_next 返回的 BV 号' },
          action: { type: 'string', enum: ['shared', 'skip', 'more_like_this'], description: '处理结果' }
        },
        required: ['bvid', 'action']
      },
      async execute(ctx, args) {
        try {
          const feed = ctx.getLifeFeed?.();
          if (!feed) return err('生活层没有开启');
          const result = feed.feedback({
            id: String(args.bvid ?? '').trim(),
            action: String(args.action ?? 'skip'),
            chatKey: ctx.chatKey
          });
          return result.ok ? ok(result) : err(result.error);
        } catch (error) {
          return err(`生活层回写失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'share_bilibili',
      description: '分享一条见闻：先发标题/来源/UP/时长/摘要/链接和你的一句话，再发封面（有封面时）。用于主动分享或控制台手动分享；不要再用 send_message 重复发链接。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'life_feed_next 返回的 BV 号' },
          comment: { type: 'string', description: '你自己的一句话/推荐理由，最多 300 字' }
        },
        required: ['bvid']
      },
      async execute(ctx, args) {
        // 发送前占用的分享名额；发送确定失败/异常时退回。发送成功后立刻清空，
        // 后续 cover/feedback 出错不能把已发出的分享额度退回去。
        let reservation = null;
        try {
          const feed = ctx.getLifeFeed?.();
          if (!feed) return err('生活层没有开启');
          const item = feed.candidate(String(args.bvid ?? '').trim());
          if (!item) return err('这条见闻不在候选队列里（可能已过期或已分享）');
          // 手动分享（控制台/管理员触发）不占自动额度；模型自己分享时在发送前再查一次，
          // 防止一次领取 3 条后连续分享超过 maxOffersPerDay。
          const humanShare = ctx.session?.manual === true && ctx.paced !== true;
          if (!humanShare) {
            if (feed.shareMode?.() === 'manual') return err('生活层当前是手动分享模式，等管理员在控制台点分享。', { reportIncident: false });
            if (feed.isShareTarget?.(ctx.chatKey) === false) return err('当前会话不在见闻分享目标里。', { reportIncident: false });
          }
          // 每日分享上限对人工和自动都生效（手动只跳过“手动模式/目标白名单”这两道，不跳过额度）。
          // 有 reserveShare 的版本用同步占位，避免两个会话都在 await 发送时同时看到剩 1 次。
          if (typeof feed.reserveShare === 'function') {
            const reserved = feed.reserveShare(item.id, { manual: humanShare });
            if (reserved?.error) return err(reserved.error);
            reservation = { feed, id: item.id };
          } else {
            const left = feed.shareQuotaLeft?.();
            if (Number.isFinite(left) && left <= 0) return err('今天的分享额度已经用完，明天再继续');
          }
          const comment = safeSlice(String(args.comment ?? ''), 300);
          const text = buildShareText(item, comment);
          // 先发正文：正文失败时还没发封面，重试不会重复封面；封面失败只降级成文本。
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, [text], {
            runId: ctx.session.leaseId, signal: ctx.signal, persona: false
          });
          if (!result.sent.length) {
            if (reservation) {
              try { reservation.feed.releaseShare?.(reservation.id); } catch { /* 忽略 */ }
              reservation = null;
            }
            return err(`标题链接没有发出去：${result.failed?.[0]?.error || '未知原因'}`);
          }
          // 正文已确认发出：额度不能再退回（封面/反馈失败只会丢封面或统计）。
          reservation = null;
          let coverSent = false;
          if (item.cover) {
            try {
              // 图片段是交给协议端去取的（不经 safe-fetch）：必须先挡内网/本机字面量，
              // 否则插件/RSS 提供的内网 https 地址会被协议端请求并把响应发进群。
              assertPublicUrlLiteral(item.cover, { label: '封面地址' });
              await ctx.sender.sendImage(ctx.chatKey, {
                id: `feed-${item.id}`, url: item.cover, desc: item.title
              }, { runId: ctx.session.leaseId, signal: ctx.signal });
              coverSent = true;
            } catch { /* 封面失败/地址不安全只降级成文本，不阻断分享 */ }
          }
          afterSent(() => {
            const mid = result.sent[0]?.messageId;
            ctx.session.lastShare = {
              bvid: item.id,
              messageId: mid,
              chatKey: ctx.chatKey,
              title: safeSlice(item.title, 40),
              at: Date.now()
            };
            ctx.session.sent.push({
              type: 'text',
              text: `[${shareSourceLabel(item)}分享:${safeSlice(item.title, 40)}]`,
              messageId: mid,
              at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
            });
            ctx.emit('session-update', ctx.session.id);
          });
          feed.feedback({ id: item.id, action: 'shared', chatKey: ctx.chatKey, messageId: result.sent[0]?.messageId, manual: humanShare });
          return ok({ sent: result.sent.length, cover: coverSent, note: '已发标题链接和封面；不要再重复发同一条。' });
        } catch (error) {
          if (reservation) {
            try { reservation.feed.releaseShare?.(reservation.id); } catch { /* 忽略 */ }
          }
          return sendErr(error);
        }
      }
    },
    {
      name: 'set_group_card',
      description: '修改你自己在当前群的群名片（群昵称）。只能改自己的，不能改别人。名字要符合本群氛围（一般 2~8 字），别带广告或奇怪符号。别人问"你叫什么/改下名片"或名片跟当前人设明显不符时可以用，别频繁改。',
      parameters: {
        type: 'object',
        properties: { card: { type: 'string', description: '新的群名片（2~8 字；不支持传空字符串清空，想恢复默认请直接设成群昵称本名）' } },
        required: ['card']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群名片只能在群聊里改');
          const raw = String(args.card ?? '').trim();
          if (!raw) return err('card 不能为空（清空名片请说「恢复默认」而不是发空白）');
          const card = raw.slice(0, 20);
          if (ctx.sender?.setCard) {
            // 只传 signal：名片写入不进 outbox，没有租约记账要配对（原先还传了 runId，
            // 而 setCard 并不消费它 —— 2026-10-05 复审顺手去掉）。
            // 但发送路径同样要进账本：否则生产上"群名片"这类写入完全没有可见性。
            await trackDirectWrite(ctx, 'group-card', { card }, () => ctx.sender.setCard(ctx.chatKey, card, { signal: ctx.signal }));
          } else if (ctx.onebot?.setGroupCard) {
            await trackDirectWrite(ctx, 'group-card', { card }, () => ctx.onebot.setGroupCard(ctx.chatId, ctx.selfId, card, ctx.signal));
          } else {
            return err('当前环境不支持改群名片');
          }
          return ok({ card, note: '群名片已修改。' });
        } catch (error) {
          // 与 send_message/send_sticker 同一收口：禁言（GROUP_MUTED）不记异常、
          // sender 已捕获过的事故不记两遍（2026-10-07 复审）。
          return sendErr(error, {}, `改群名片失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'set_group_ban',
      feature: 'moderation',
      description: '禁言群成员（仅全局管理员在群里明确要求时可用）。minutes=0 表示解除禁言；最长 30 天。不要主动使用，不要对管理员或自己使用。',
      parameters: {
        type: 'object',
        properties: {
          targetUserId: { type: ['integer', 'string'], description: '要禁言的群成员 QQ 号' },
          minutes: { type: 'integer', description: '禁言分钟数；0 = 解除禁言；最大 43200（30 天）' }
        },
        required: ['targetUserId', 'minutes']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('禁言只能在群聊里执行');
          const admin = adminRequest(ctx, [/禁言|解禁|解除禁言|封/]);
          if (!admin.ok) return err(admin.reason, { reportIncident: false });
          const targetCheck = moderationTargetError(ctx, args.targetUserId, admin.owner);
          if (targetCheck.error) return err(targetCheck.error, { reportIncident: false });
          const rawMinutes = args.minutes;
          if (rawMinutes === null || rawMinutes === '' || typeof rawMinutes === 'boolean') {
            return err('minutes 必须是 0 或正整数（0 = 解禁）');
          }
          const minutesValue = Number(rawMinutes);
          if (!Number.isInteger(minutesValue) || minutesValue < 0) return err('minutes 必须是 0 或正整数（0 = 解禁）');
          const minutes = Math.min(43200, minutesValue);
          await trackDirectWrite(ctx, 'ban', { target: targetCheck.target, minutes }, () => ctx.onebot.setGroupBan(ctx.chatId, Number(targetCheck.target), minutes * 60, ctx.signal));
          return ok({ targetUserId: targetCheck.target, minutes, note: minutes ? '已禁言。' : '已解除禁言。' });
        } catch (error) {
          return sendErr(error, {}, `禁言失败：${String(error?.message ?? error).slice(0, 120)}`);
        }
      }
    },
    {
      name: 'kick_group_member',
      feature: 'moderation',
      description: '把群成员移出群（仅全局管理员在群里明确要求时可用）。不要主动使用，不要对管理员或自己使用。',
      parameters: {
        type: 'object',
        properties: {
          targetUserId: { type: ['integer', 'string'], description: '要移出的群成员 QQ 号' },
          rejectAddRequest: { type: 'boolean', description: '是否同时拒绝对方再次加群（默认 false）' }
        },
        required: ['targetUserId']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('踢人只能在群聊里执行');
          const admin = adminRequest(ctx, [/踢|移出|请出|移除/]);
          if (!admin.ok) return err(admin.reason, { reportIncident: false });
          const targetCheck = moderationTargetError(ctx, args.targetUserId, admin.owner);
          if (targetCheck.error) return err(targetCheck.error, { reportIncident: false });
          await trackDirectWrite(ctx, 'kick', { target: targetCheck.target }, () => ctx.onebot.kickGroupMember(ctx.chatId, Number(targetCheck.target), args.rejectAddRequest === true, ctx.signal));
          return ok({ targetUserId: targetCheck.target, note: '已移出群。' });
        } catch (error) {
          return sendErr(error, {}, `移出群失败：${String(error?.message ?? error).slice(0, 120)}`);
        }
      }
    },
    {
      name: 'recall_message',
      feature: 'moderation',
      description: '撤回一条消息。可以随时撤回你自己刚发的；撤回别人的消息只能由全局管理员在群里明确要求时执行。messageId 用 send_message 返回的 messageIds，或聊天记录里的 #数字。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: '要撤回的消息 id' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const mid = normalizeMid(args.messageId);
          if (!/^-?\d+$/.test(mid)) return err('messageId 要是消息 id（聊天记录里的 #数字）');
          const entry = ctx.store?.findByMid?.(ctx.chatKey, mid);
          const sentThisRun = (ctx.session?.sent || []).some((item) =>
            item?.messageId != null && String(item.messageId) === String(mid));
          // 只允许撤当前会话里能定位到的消息：delete_msg 是全局 message id，
          // 不校验归属时管理员口令可被利用去删别的群里的消息。
          if (!entry && !sentThisRun) return err('当前会话里找不到这条消息（可能不是本群消息，或已经撤回）。');
          const own = entry?.self === true || sentThisRun;
          if (!own) {
            if (ctx.kind !== 'group') return err('撤回别人的消息只能在群聊里执行');
            const admin = adminRequest(ctx, [/撤回|撤掉|删掉|删除消息/]);
            if (!admin.ok) return err(admin.reason, { reportIncident: false });
          }
          await trackDirectWrite(ctx, 'delete-msg', { mid }, () => ctx.onebot.deleteMessage(Number(mid), ctx.signal));
          // 保留 sent 记录但标 recalled：reply-guard 仍有"确实发过"的证据，不会误补兜底。
          for (const item of ctx.session?.sent || []) {
            if (item?.messageId != null && String(item.messageId) === String(mid)) item.recalled = true;
          }
          return ok({ messageId: mid, note: '已撤回。不要解释撤回原因，除非对方问。' });
        } catch (error) {
          return sendErr(error, {}, `撤回失败：${String(error?.message ?? error).slice(0, 120)}`);
        }
      }
    },
    {
      name: 'set_group_admin',
      feature: 'moderation',
      description: '设置/取消群管理员（仅全局管理员在群里明确要求时可用）。不要主动使用，不要对管理员或自己使用。',
      parameters: {
        type: 'object',
        properties: {
          targetUserId: { type: ['integer', 'string'], description: '目标群成员 QQ 号' },
          enable: { type: 'boolean', description: 'true = 设为管理员；false = 取消管理员' }
        },
        required: ['targetUserId', 'enable']
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('群管理员设置只能在群聊里执行');
          const admin = adminRequest(ctx, [/管理员|管理|升为|取消管理/]);
          if (!admin.ok) return err(admin.reason, { reportIncident: false });
          if (typeof args.enable !== 'boolean') return err('enable 必须是 true 或 false');
          const targetCheck = moderationTargetError(ctx, args.targetUserId, admin.owner);
          if (targetCheck.error) return err(targetCheck.error, { reportIncident: false });
          await trackDirectWrite(ctx, 'set-admin', { target: targetCheck.target, enable: args.enable }, () => ctx.onebot.setGroupAdmin(ctx.chatId, Number(targetCheck.target), args.enable, ctx.signal));
          return ok({ targetUserId: targetCheck.target, enable: args.enable, note: '群管理员设置已更新。' });
        } catch (error) {
          return sendErr(error, {}, `设置群管理员失败：${String(error?.message ?? error).slice(0, 120)}`);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 应传数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍；传群名片/备注只在唯一对上一个成员时才会拍，重名或对不上会报错，不要传"未知"或 0 这类占位。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          const rawText = args.targetUserId === undefined || args.targetUserId === null
            ? ''
            : String(args.targetUserId).trim();
          if (ctx.kind === 'group' && rawText === '') {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }

          let target = null;
          if (rawText !== '') {
            // @ 前缀先统一剥掉，再做数字判断：模型常写 "@101"（意图是 QQ），
            // 不能让它掉进名字前缀，误拍到 "1011号" 这类成员。
            const nameText = normalizePokeName(rawText);
            let targetText = normalizeTarget(nameText);
            if (ctx.kind === 'private') {
              if (!targetText || String(ctx.chatId) !== targetText) {
                return err('私聊只能拍当前聊天对象，省略 targetUserId 即可');
              }
            } else {
              if (!targetText) {
                // 纯数字但位数不合法（如 16 位占位）也直接拒绝，不要再拿去做名字匹配。
                if (/^\d+$/.test(nameText)) {
                  return err(`targetUserId 必须是 1-15 位数字 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
                }
                const resolved = resolvePokeTarget(ctx, nameText);
                if (resolved.error) {
                  return err(`${resolved.error}${resolved.hint ? memberHint(ctx) : ''}`);
                }
                targetText = normalizeTarget(resolved.userId);
                if (!targetText) {
                  return err(`按名字反查到的 QQ 号不合法（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
                }
              }
              if (!hasParticipant(ctx, targetText)) {
                const looksLikeMessageId = modelVisible(ctx.store?.findByMid?.(ctx.chatKey, targetText));
                return err(`${targetText} 不是当前群中已出现的成员 QQ 号`
                  + `${looksLikeMessageId ? '，它是消息 id' : ''}。${memberHint(ctx)}`);
              }
            }
            target = Number(targetText);
          }

          const humanGate = actionGate(ctx, 'poke');
          if (!humanGate.ok) return err(humanGate.reason, { reportIncident: false });
          await ctx.sender.poke(ctx.chatKey, target, { runId: ctx.session.leaseId, signal: ctx.signal });
          actionDone(ctx, 'poke');
          if (ctx.session) ctx.session.visibleReply = true;   // 拍一拍同样是可见回复
          return ok({ poked: true, ...(target === null ? {} : { targetUserId: target }) });
        } catch (error) {
          return sendErr(error);
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 read_forward 展开看内容。开启「群聊与私聊共用上下文」时会同时包含其它会话的消息，并标注 [群 <群号>] / [与 <QQ>]（这些消息没有可用 messageId）。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        const memCfg = getConfig().memory || {};
        const crossScope = memCfg.crossScopeSharedContext === true;
        const sharedPrivate = !crossScope && memCfg.privateSharedContext === true
          && String(ctx.chatKey || '').startsWith('private:');
        const sharedContext = crossScope || sharedPrivate;
        const pastCount = Math.max(0, Number(ctx.session.pastStateCount) || 0);
        // 共享上下文的 pastState 不包含 leased 触发消息；pastStateCount 却把触发数加上了，
        // 直接用会多跳过 N 条（复审 P2）。
        const offsetBase = sharedContext
          ? Math.max(0, pastCount - Math.max(0, Number(ctx.triggerEntries?.length) || 0))
          : pastCount;
        let messages = ctx.store.recent(ctx.chatKey, {
          limit,
          offset: offset + offsetBase,
          scope: crossScope ? 'all' : (sharedPrivate ? 'private' : 'chat'),
          // 共享上下文时与【过去状态】同口径：只翻已处理的历史，不把别处的未读带进来
          readOnly: sharedContext
        })
          // 引擎发的游戏私聊（身份/查验结果/行动回执）连翻页都不该看到：模型在私聊里不是上帝视角
          .filter((m) => m.eventKind !== 'game-secret');
        // 与【过去状态】同一口径：屏蔽名单生效前存档的消息，翻页也不能漏出来。
        messages = filterBlockedHistory(messages, ctx.chatKey, { crossScope });
        return ok({
          count: messages.length,
          messages: (() => {
            // 与【过去状态】同口径给单条和总量设上限：合并转发存档单条可达数 KB，
            // limit=100 时一次能把 200–400KB 塞进下一轮请求（上游 400 / 巨额 token）。
            let used = 0;
            const MAX_LINE = 2000;
            const MAX_TOTAL = 24000;
            return messages.map((m) => {
              const cross = sharedContext && String(m.chatKey || '') !== String(ctx.chatKey);
              const [kind, id] = cross ? String(m.chatKey || '').split(':') : [];
              const label = !cross ? '' : (kind === 'group' ? `[群 ${id || '?'}]` : `[与 ${id || '另一位好友'}]`);
              const raw = cross ? `${label} ${stripQuoteMessageId(m.text)}` : textWithQuote(m);
              const room = Math.max(0, MAX_TOTAL - used);
              const text = room > 0 ? safeSlice(raw, Math.min(MAX_LINE, room)) : '[…超出本次读取上限，用更小的 limit 或 get_message_detail]';
              used += text.length;
              return {
                // 别的会话的 mid 在当前会话无效，不能给模型拿去引用/看图
                messageId: cross ? undefined : (m.mid ?? undefined),
                time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
                sender: m.self ? '我' : displayNameOf(m.senderId, m.senderName),
                // 与【过去状态】同一套渲染：正文缺引用块时补上（回复 + 合并转发卡片那类记录）
                text
              };
            });
          })()
        });
      }
    },
    {
      name: 'read_forward',
      description: '展开查看合并转发的聊天记录。消息文本出现 [合并转发聊天记录] / [转发消息 …] / [卡片聊天记录 …] 占位符时用。参数填那条转发消息前的 #数字（千万别用方括号里那串长 id，会过期报错）。展开结果会写回存档，以后再看就是展开的文本，不用重复调。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!modelVisible(entry) || !filterBlockedHistory([entry], ctx.chatKey).length) {
            return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          }
          // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
          if (String(entry.text || '').startsWith('[合并转发 共')) {
            return ok({ messageId: entry.mid, text: entry.text, note: '该转发已展开（读的是存档）' });
          }
          const nodes = await readForwardMessages(ctx.onebot, entry.mid);
          const ex = await expandForwardNodes(nodes, { fetchNested: (rid) => readForwardNodesById(ctx.onebot, rid) });
          if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
          // 自动展开关闭时正文只在这里取回：写入/返回模型前必须补一次黑名单检查，
          // 否则“合并转发里的广告”会绕过入站过滤（2026-11-02 全项目审查 P2）。
          if (matchesBlacklistKeyword(ex.text, getConfig().store?.blacklistKeywords)) {
            return err('转发内容命中消息关键词黑名单，已拦截，不写入存档。', { reportIncident: false });
          }
          // 写回存档：一次展开，永久升级这条记录（模型/存档页/金句墙都受益）
          ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: ex.media || [] });
          return ok({ messageId: entry.mid, text: ex.text, images: (ex.media || []).length });
        } catch (error) {
          return err(`展开失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: displayNameOf(m.userId, m.name),
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'dice',
      description: '掷骰子/随机：骰子（默认 1 个 6 面）、区间整数、抛硬币、从名单里随机抽一个。用于游戏主持、抽签、随机点名、公平做决定。结果由系统随机数生成，可如实转述。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['dice', 'number', 'coin', 'pick'], description: 'dice=掷骰子；number=区间整数；coin=抛硬币；pick=从 items 抽一个' },
          sides: { type: 'integer', description: '骰子面数（默认 6，2~1000）' },
          count: { type: 'integer', description: '骰子个数（默认 1，1~10）' },
          min: { type: 'integer', description: 'number 用：最小值（默认 1）' },
          max: { type: 'integer', description: 'number 用：最大值（默认 100）' },
          items: { type: 'array', items: { type: 'string' }, description: 'pick 用：候选名单（2~50 个）' }
        },
        required: ['kind']
      },
      async execute(_ctx, args) {
        const roll = (n) => crypto.randomInt(0, n);
        const kind = String(args.kind || '');
        if (kind === 'dice') {
          const sides = Math.min(1000, Math.max(2, Number(args.sides) || 6));
          const count = Math.min(10, Math.max(1, Number(args.count) || 1));
          const rolls = Array.from({ length: count }, () => 1 + roll(sides));
          const total = rolls.reduce((a, b) => a + b, 0);
          return ok({ kind, sides, count, rolls, total, text: count === 1 ? `🎲 ${rolls[0]}` : `🎲 ${rolls.join(' + ')} = ${total}` });
        }
        if (kind === 'coin') return ok({ kind, result: roll(2) === 0 ? '正面' : '反面' });
        if (kind === 'pick') {
          const items = (Array.isArray(args.items) ? args.items : [])
            .map((x) => sanitizeUserText(String(x ?? '').trim())).filter(Boolean).slice(0, 50);
          if (items.length < 2) return err('pick 需要 2~50 个候选项（items 数组）');
          const picked = items[roll(items.length)];
          return ok({ kind, picked, candidates: items.length });
        }
        const min = Math.trunc(Number(args.min) || 1);
        const max = Math.trunc(Number(args.max) || 100);
        if (max <= min) return err('max 必须大于 min');
        return ok({ kind: 'number', min, max, result: min + roll(max - min + 1) });
      }
    },
    {
      name: 'get_group_member_list',
      description: '获取本群完整成员名单（QQ 号 / 群名片 / 角色），用于随机点名、找人、统计群规模。名单可能偏旧（协议端缓存）；大群按角色排序后只返回前 limit 个。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '最多返回多少（默认 50，最大 200）' } }
      },
      async execute(ctx, args) {
        if (ctx.kind !== 'group') return err('只有群聊才有成员名单');
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
        let list = null;
        try {
          list = await ctx.onebot.getGroupMemberList(ctx.chatId);
        } catch (error) {
          return err(`获取成员名单失败：${String(error?.message ?? error).slice(0, 120)}（协议端可能不支持该接口）`);
        }
        const rank = { owner: 0, admin: 1, member: 2 };
        const mapped = (Array.isArray(list) ? list : []).map((m) => {
          const userId = String(m?.user_id ?? m?.userId ?? '');
          return {
            userId,
            // 显示名口径统一走 displayNameOf（备注优先于群名片）
            name: displayNameOf(userId, String(m?.card || m?.nickname || m?.name || '')),
            role: String(m?.role || 'member')
          };
        }).filter((m) => /^\d{1,15}$/.test(m.userId));
        if (!mapped.length) return err('协议端返回了空名单');
        mapped.sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3));
        return ok({ total: mapped.length, returned: Math.min(limit, mapped.length), members: mapped.slice(0, limit) });
      }
    },
    {
      name: 'remind',
      description: '给当前会话设一个定时提醒（到点你会被唤醒，用你的口吻把这件事说出来）；也可查询/取消。minutes 或 HH:MM 二选一，HH:MM 按北京时间、已过则算明天。这是给别人设的提醒（重启后依然有效），与给自己排开口时机的 schedule_wake 不同。要重复提醒（每天几点、每周几几点）就传 repeat 对象，到点自动续；只想要一次就别传。'
        + '是「A 让你提醒 B」时（如"12 点提醒他吃饭"），把 to 填成被提醒的人、from 填成提要求的人 —— 到点你才能说清是谁请你提醒谁，别让被提醒的人以为是自己设的。from 要能在最近这轮消息里对上人（填他的群名片/备注名或 QQ 号；对不上就不会记录）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'cancel'], description: 'add=新增；list=查看本会话待触发；cancel=取消（不传 id 取消最近一条）' },
          minutes: { type: 'number', description: 'add 用：多少分钟后（1~43200）。与 at 二选一；传了 repeat 且两者都没传时，首次触发按 repeat 规则算' },
          at: { type: 'string', description: 'add 用：绝对时间 HH:MM（北京时间，已过则算明天）' },
          text: { type: 'string', description: 'add 用：提醒内容（必填，≤200 字）' },
          to: { type: 'string', description: 'add 用：提醒谁（群名片/备注/名字；可选）' },
          from: { type: 'string', description: 'add 用：谁请你提醒的（填本轮消息里那位群友的称呼或 QQ 号；对不上人就不会记录）' },
          repeat: {
            type: 'object',
            description: 'add 用：周期提醒。传对象，例如每天 21:00 = {"kind":"daily","hour":21,"minute":0}；每周五 18:30 = {"kind":"weekly","weekday":5,"hour":18,"minute":30}；cron = {"kind":"cron","cron":"30 18 * * 5"}。可选 tz（IANA，如 Asia/Shanghai）与 jitterMs（0~3600000，随机错开）。不传=一次性',
            properties: {
              kind: { type: 'string', enum: ['daily', 'weekly', 'cron'] },
              hour: { type: 'integer', minimum: 0, maximum: 23 },
              minute: { type: 'integer', minimum: 0, maximum: 59 },
              weekday: { type: 'integer', minimum: 0, maximum: 6, description: '0=周日 … 6=周六（kind=weekly 时必填）' },
              cron: { type: 'string', description: 'kind=cron 时必填：5 字段（分 时 日 月 周），日/月只认 *' },
              tz: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai；默认项目时区' },
              jitterMs: { type: 'integer', minimum: 0, maximum: 3600000, description: '随机抖动上限（毫秒）' }
            },
            required: ['kind']
          },
          id: { type: 'string', description: 'cancel 用：提醒 id（list 里可见）' }
        },
        required: ['action']
      },
      async execute(ctx, args) {
        const store = ctx.reminders;
        if (!store) return err('当前环境不支持提醒');
        // 控制台开关（设置 → 定时提醒）：关掉后不再接受新的提醒，已有数据保留
        if (getConfig().reminders?.enabled === false) return err('定时提醒未启用（管理员可在控制台打开）');
        const action = String(args.action || '');
        // 提醒的绝对时间按项目统一口径（Asia/Shanghai）格式化：服务器时区不同时，
        // "明天 09:30" 会被格式化成另一个钟点误导模型（2026-09-29 审查 P2）
        const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        if (action === 'list') {
          const items = store.list(ctx.chatKey);
          if (!items.length) return ok({ pending: 0, hint: '本会话没有待触发的提醒' });
          return ok({
            pending: items.length,
            reminders: items.map((it) => ({
              id: it.id, at: fmt(it.at), text: it.text,
              ...(it.targetName ? { to: it.targetName } : {}),
              ...(it.createdBy ? { from: it.createdBy } : {})
            }))
          });
        }
        if (action === 'cancel') {
          const hit = store.cancel({ id: String(args.id || ''), chatKey: ctx.chatKey });
          if (!hit) return err('没找到对应的待触发提醒（可用 list 查看 id）');
          return ok({ canceled: true, text: hit.text, at: fmt(hit.at) });
        }
        let at = null;
        let firstOccurrence = null;
        // repeat 可能是对象（schema 声明的形式）或字符串（"daily"/"weekly:mon"/cron）。
        // 旧写法 String(object) 会得到 "[object Object]"，带时刻的周期提醒根本建不出来。
        const repeatArg = typeof args.repeat === 'string' ? args.repeat.trim() : args.repeat;
        const hasRepeat = repeatArg !== undefined && repeatArg !== null
          && !(typeof repeatArg === 'string' && repeatArg === '');
        const quietCfg = getConfig().reminders?.quiet || null;
        let normalizedRepeat = null;
        if (hasRepeat) {
          try { normalizedRepeat = normalizeRepeat(repeatArg); } catch (error) { return err(String(error?.message ?? error)); }
          // 周期提醒：at/minutes 只定首次触发点；都不传时按 repeat 规则算第一次
          if (args.at !== undefined && String(args.at).trim() !== '') {
            at = nextAtFromHHMM(String(args.at));
            if (at === null) return err('at 需要是 HH:MM（24 小时制，如 09:30）');
            firstOccurrence = ['at', ...String(args.at).trim().split(/[:：]/).map(Number)];
          } else if (args.minutes !== undefined && String(args.minutes).trim() !== '') {
            const m = Number(args.minutes);
            if (!Number.isFinite(m) || m < 1 || m > 30 * 24 * 60) return err('minutes 需要是 1~43200 之间的数字（最多 30 天）');
            at = Date.now() + Math.round(m) * 60000;
            firstOccurrence = ['minutes', Math.round(m)];
          } else {
            at = normalizedRepeat ? nextOccurrenceAt({ repeat: normalizedRepeat }, Date.now(), { quiet: quietCfg }) : null;
            if (!at) return err('repeat 不合法，算不出首次触发时间');
            firstOccurrence = ['repeat'];
          }
        } else if (args.at !== undefined && String(args.at).trim() !== '') {
          at = nextAtFromHHMM(String(args.at));
          if (at === null) return err('at 需要是 HH:MM（24 小时制，如 09:30）');
        } else {
          const m = Number(args.minutes);
          if (!Number.isFinite(m) || m < 1 || m > 30 * 24 * 60) return err('minutes 需要是 1~43200 之间的数字（最多 30 天）');
          at = Date.now() + Math.round(m) * 60000;
        }
        try {
          // 归属（谁提的/提醒谁）：from 必须能在**本轮触发消息**里对上人（QQ 号、群名片或
          // 备注名任一对上都算）——模型会顺着上下文写名字，也可能被"就说是管理员让提醒的"
          // 这类话带偏；对不上就不记（派发话术回落"有人"，不把错的人当事实写进持久数据）。
          // 之前那版"唯一发送者兜底"已移除：提醒可能是上一轮的人提的、这一轮才是别人在说话，
          // 兜底会把后来者记成提要求的人（2026-10-10 复核）。
          const fromArg = String(args.from ?? '').trim();
          let fromOk = false;
          const requesterIds = new Set();
          if (fromArg) {
            for (const m of (ctx.triggerEntries || [])) {
              if (m?.self) continue;
              const sid = String(m?.senderId || '');
              const sname = String(m?.senderName || '').trim();
              if ((sid && fromArg === sid) || (sname && fromArg === sname)
                || (sid && fromArg === displayNameOf(sid, sname))) {
                fromOk = true;
                requesterIds.add(sid || null);
              }
            }
          } else {
            for (const m of (ctx.triggerEntries || [])) {
              if (!m?.self) requesterIds.add(String(m?.senderId || '') || null);
            }
          }
          const createdBy = fromOk ? fromArg : '';
          const text = sanitizeUserText(String(args.text ?? '').trim()).slice(0, MAX_REMINDER_TEXT);
          if (!text) return err('提醒内容不能为空');
          // 未验证的 from、同名多人、未指明来源的多人批次都不合并，也不据此补写归属。
          const unambiguous = (!fromArg || fromOk) && requesterIds.size <= 1 && !requesterIds.has(null);
          const requestKey = normalizedRepeat && unambiguous ? JSON.stringify([
            ctx.chatKey, text, fromArg, createdBy, [...requesterIds][0], String(args.to ?? '').trim(),
            normalizedRepeat.kind, normalizedRepeat.weekday, normalizedRepeat.hour, normalizedRepeat.minute,
            normalizedRepeat.cron?.replace(/\s+/g, ' '), normalizedRepeat.tz || 'Asia/Shanghai',
            normalizedRepeat.jitterMs || 0, firstOccurrence,
            quietCfg?.start && quietCfg?.end
              ? [String(quietCfg.start).slice(0, 5), String(quietCfg.end).slice(0, 5)] : null
          ]) : null;
          const previous = requestKey && recurringRemindersByContext.get(ctx)?.get(requestKey);
          const pending = previous && store.list?.(ctx.chatKey).find((item) =>
            item.id === previous.id && item.chatKey === ctx.chatKey && item.status === 'pending'
            && reminderSnapshot(item) === previous.snapshot);
          const { id, at: actualAt } = pending || store.add({
            chatKey: ctx.chatKey, at,
            text: String(args.text ?? ''),
            createdBy,
            targetName: String(args.to ?? ''),
            repeat: hasRepeat ? repeatArg : null,
            quiet: quietCfg
          });
          if (requestKey && !pending) {
            const item = store.list?.(ctx.chatKey).find((entry) => entry.id === id);
            if (item) {
              if (!recurringRemindersByContext.has(ctx)) recurringRemindersByContext.set(ctx, new Map());
              recurringRemindersByContext.get(ctx).set(requestKey, { id, snapshot: reminderSnapshot(item) });
            }
          }
          return ok({
            created: !pending, ...(pending ? { reused: true } : {}), id, at: fmt(actualAt ?? at),
            ...(createdBy ? { from: createdBy } : {}),
            note: (pending
              ? '本轮已创建相同的周期提醒，已复用原任务，没有重复创建。'
              : '到点你会被唤醒并知道该提醒什么；不需要再回复这条结果。')
              + (fromArg && !fromOk
                ? '（from 在最近这轮消息里对不上人，这次没有记录归属；要记的话填对方的群名片/备注名或 QQ 号）'
                : '')
          });
        } catch (error) {
          return err(String(error?.message ?? error));
        }
      }
    },
    {
      name: 'group_game',
      description: '主持群游戏：action=start 开局（game 传 number-bomb 数字炸弹 / undercover 谁是卧底 / werewolf 狼人杀 6~9 人）、stop 结束、status 查看。开局后群友用普通发言参与，轮次、计票与判定都由系统负责，你只负责氛围与解说；**绝不要提到谁的词或谁的身份**。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start=开局；stop=结束；status=看当前局' },
          game: { type: 'string', description: 'start 用：number-bomb（数字炸弹）/ undercover（谁是卧底）/ werewolf（狼人杀，6~9 人，夜里走私聊）' },
          players: { type: 'array', items: { type: 'string' }, description: 'start 可选：指定参与者，传 QQ 号或**群名片**都行（只认最近活跃的群友，名片要一字不差）。想锁定"就这几个人玩"时传它（传了就不走报名，直接发牌）；不传的话，需要私聊的游戏（谁是卧底/狼人杀）会先挂一段报名（默认 45 秒，管理员可改）让大家回「我玩」，不需要私聊的数字炸弹才直接按最近活跃的人开局' }
        },
        required: ['action']
      },
      async execute(ctx, args) {
        const mgr = ctx.games;
        if (!mgr) return err('当前环境不支持群游戏');
        if (ctx.kind !== 'group') return err('群游戏只在群聊里开');
        const action = String(args.action || '');
        if (action === 'status') return ok(mgr.status(ctx.chatKey));
        if (action === 'stop') {
          const r = await mgr.stop(ctx.chatKey, '主持人叫停');
          return r.ok ? ok({ stopped: true }) : err(r.error);
        }
        const players = Array.isArray(args.players) && args.players.length
          ? args.players.map((x) => ({ userId: String(x), name: String(x) }))
          : null;
        const r = await mgr.start({ chatKey: ctx.chatKey, gameId: String(args.game || ''), players });
        return r.ok ? ok({ started: true, note: `${r.text}。接下来顺着群友的发言解说着走，别替他们玩。` }) : err(r.error);
      }
    },
    {
      name: 'send_voice',
      description: '把一段文字合成语音发到当前会话（想"说"而不是"打"时用）。只适合短句 1~3 句（120 字以内最自然，硬上限 200 字）；内容要自然口语、标点清楚（破折号/省略号/问号能带出停顿），书面句会念得很平；多短、什么语气按【角色设定】与上下文。可以用 emotion 指定情绪（支持导演指令的供应商会真的带上语气）。别整段朗读、别频繁用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的内容（≤200 字，口语短句）' },
          emotion: {
            type: 'string',
            enum: ['neutral', 'happy', 'sad', 'angry', 'soft', 'excited', 'tired', 'shy', 'playful', 'serious'],
            description: '说话情绪；不确定就不填。温柔/哄人用 soft，开心/分享用 happy，吐槽用 playful 或 angry。'
          }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        const cfg = getConfig();
        if (!ttsConfigured(cfg)) return err('语音回复未启用或未配置（设置 → 语音回复）');
        const text = String(args.text ?? '').trim();
        if (!text) return err('text 不能为空');
        if (text.length > 200) return err('语音内容太长了（≤200 字），说短一点');
        const humanGate = actionGate(ctx, 'voice');
        if (!humanGate.ok) return err(humanGate.reason, { reportIncident: false });
        // 合成发生在发送限频之前：先原子占 TTS 额度，失败也不能让第三方账户被刷。
        voiceQuota.configure({
          globalMax: Number(cfg.tts?.maxPerHour) || 30,
          perChatMax: Number(cfg.tts?.maxPerHourPerChat) || 6
        });
        const voiceGate = voiceQuota.tryConsume(ctx.chatKey);
        if (!voiceGate.ok) {
          const wait = Math.max(1, Math.ceil((voiceGate.retryAfterMs || 0) / 60000));
          return err(`语音合成太频繁（每会话每小时 6 条/全局 30 条），约 ${wait} 分钟后再试`, { reportIncident: false });
        }
        let audio = null;
        try {
          audio = await synthesizeSpeech({
            cfg: cfg.tts,
            text,
            emotion: String(args.emotion ?? '').trim(),
            signal: ctx.signal
          });
        } catch (error) {
          // TTS 是外挂能力：上游挂了/Key 失效/协议端不支持时，不能把这轮回复也一起吞掉。
          // 改成发同一段文字，模型与用户都还能收到内容；错误只回给模型，避免群里出现报错。
          const why = String(error?.message ?? error).slice(0, 120);
          try {
            await ctx.sender.sendTextBatch(ctx.chatKey, [text], {
              runId: ctx.session?.leaseId,
              signal: ctx.signal
            });
            actionDone(ctx, 'voice');
            if (ctx.session) ctx.session.visibleReply = true;
            return ok({
              sent: true,
              fallback: 'text',
              warning: `语音合成失败（${why}），已改用文字发出；不需要再回复这条结果。`
            });
          } catch (sendError) {
            return sendErr(sendError, {}, `${why}；改发文字也失败了：${String(sendError?.message ?? sendError).slice(0, 120)}`);
          }
        }
        try {
          const seconds = Math.max(1, Math.round(text.length / 4));
          await ctx.sender.voice(ctx.chatKey, {
            file: `base64://${audio.buffer.toString('base64')}`,
            seconds,
            label: text.slice(0, 40)
          }, { runId: ctx.session?.leaseId, signal: ctx.signal });
          actionDone(ctx, 'voice');
          if (ctx.session) ctx.session.visibleReply = true;   // 语音也是"回过了"，回复兜底据此判断
          return ok({ sent: true, seconds, note: '语音已发出；不需要再回复这条结果。' });
        } catch (error) {
          return sendErr(error, {}, `${String(error?.message ?? error).slice(0, 120)}（若协议端不支持 record 段，请改用 send_message）`);
        }
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        // game-secret 的行当作"不存在"：不确认它的存在，也不回正文（2026-09-29 审查 P1）。
        // 屏蔽名单是"历史也不能再进工具结果"：按 mid 直读同样要过滤（2026-11-02 全项目审查 P2）。
        if (!modelVisible(entry) || !filterBlockedHistory([entry], ctx.chatKey).length) {
          return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        }
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : displayNameOf(entry.senderId, entry.senderName),
          senderId: entry.senderId,
          // 正文与【过去状态】同形（缺引用块就补）；reply 是结构化原字段（供取 id/发送者用），
          // 但 sender/text 是别人可控文本：与其他出口同口径过段头弱化（2026-10-12 审查）
          text: textWithQuote(entry),
          reply: entry.reply ? sanitizeDeep(entry.reply) : entry.reply
        });
      }
    },
    {
      name: 'get_message_images',
      description: getMessageImagesDescription(),
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!modelVisible(entry)) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const viewables = await currentMessageImageUrls(ctx, entry);
          if (!viewables.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
          // 「消息类型」页可以关掉视频画面（省一次抽帧 + 一次视觉调用）：关了就跳过视频帧条，
          // 不下载也不进模型；图片/表情照常。视频的声音仍在 get_message_audio 那条路上。
          const videoFrames = getConfig().messageTypes?.videoFrames !== false;
          const dataUrls = [];
          const failed = [];
          let videoCount = 0;
          let skippedVideo = 0;
          for (const item of viewables) {
            ctx.signal?.throwIfAborted();
            if (item.kind === 'video' && !videoFrames) { skippedVideo += 1; continue; }
            try {
              if (item.kind === 'video') {
                dataUrls.push(await downloadVideoAsFrameStrip(item.url, ctx.signal));
                videoCount += 1;
              } else {
                dataUrls.push(await downloadImageAsDataUrl(item.url, ctx.signal));
              }
            } catch (e) { failed.push(String(e?.message ?? e)); }
          }
          if (!dataUrls.length) {
            // 全部被"关掉视频画面"挡下：这不是错误，说清为什么看不到（别再让它换 id 重试）；
            // 但如果本来有图片且下载失败，也要一并说出来 —— 否则模型会以为这条消息里只有视频。
            if (skippedVideo) {
              const failedText = failed.length ? `；另有 ${failed.length} 张图片获取失败` : '';
              return ok(`视频画面查看在设置里关着（消息类型 → 视频画面）：这条消息有 ${skippedVideo} 条视频没看${failedText}。要听里面的声音用 get_message_audio。`);
            }
            return err(`图片获取失败：${failed.join('；')}`);
          }
          // 有图看着、但视频被设置挡下时也要说清（否则模型以为这条消息只有这些图）
          const note = [
            failed.length ? `另有 ${failed.length} 张获取失败` : '',
            skippedVideo ? `${skippedVideo} 条视频未看（消息类型页关着视频画面）` : ''
          ].filter(Boolean).join('；');
          const noteText = note ? `（${note}）` : '';
          // 这张图它之前收藏时已经理解过（库里有备注）→ 直接给出当时的理解，别让它重新描述画面
          const known = [];
          for (const m of (Array.isArray(entry.media) ? entry.media : [])) {
            if (!m || m.kind !== 'image') continue;
            try {
              // 消息里的文件名是 "<MD5>.jpg"，库里存的是纯 MD5 → 去后缀、大写再比一次；最后退到 URL
              const file = String(m.file || '').trim();
              const bare = file.replace(/\.[a-z0-9]+$/i, '').toUpperCase();
              const hit = (file ? await ctx.stickers.find(file) : null)
                || (bare ? await ctx.stickers.find(bare) : null)
                || (m.url ? await ctx.stickers.find(String(m.url)) : null);
              // 备注/描述来自"图里文字经视觉判定入库"的内容，出口统一弱化（2026-10-12 审查）
              const label = hit ? sanitizeUserText(String(hit.localNote || hit.desc || '').trim()) : '';
              if (label && !known.includes(label)) known.push(label);
            } catch { /* 查库失败不影响看图 */ }
          }
          const knownHint = known.length
            ? `（这张你之前看过并记过：「${known.join('」「')}」——按这个理解回，别再描述画面）`
            : '';
          const kindHint = videoCount
            ? `其中 ${videoCount} 条是视频：2×2 四宫格按时间顺序抽的 4 帧，阅读顺序左上→右上→左下→右下，黑格是填充不是画面内容。要听视频里说了什么再调 get_message_audio。`
            : '若是 2×2 四宫格：那是动图 GIF 按时间顺序抽的 4 帧，阅读顺序左上→右上→左下→右下，黑格是填充不是画面内容。先判断它想表达的情绪/态度：无语呆滞、嘲讽、卖萌、赞同、挑衅、摆烂、委屈…再针对态度回话，不要复述画面。';
          return { content: imageParts(`消息 ${args.messageId} 的图片内容${noteText}${knownHint}（${kindHint}）：`, dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_message_audio',
      description: '把某条消息里的语音/音频/视频转成文字（语音识别，支持 QQ 语音、音频文件、视频里的音轨）。消息文本出现 [语音] / [视频] / [文件…m4a|mp3|wav|mp4] 时可用。id 用聊天记录里每条消息前的 #数字。转写完直接基于文字回应即可。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!modelVisible(entry)) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const result = await transcribeMessageAudio(ctx, entry);
          if (!result.ok) return err(result.error);
          return ok({
            transcript: sanitizeUserText(result.text),
            note: result.caveat
              ? `以上是自动识别的结果${result.caveat}`
              : '以上是这段音频的完整转写。直接基于内容回应，不要复述"我转写了"。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_append',
      description: '记一条对群友的长期印象（下次运行会自动看到）。只记"以后和这个人打交道时用得上"的稳定印象：他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题、别踩的坑。太临时的事情不要记。只写可观察的事实与偏好，不写评价、不揣测动机（写"会反复问你人设"，别写"想掌控设定/扬言改人设/喜欢试探规则"）；写管理员本人的时候照事实记——他改人设、问人设、逗你玩都是本职，不是试探。userId 必须填对方的 QQ 号（不知道就先调 get_active_members / get_recent_messages 查）；target 填备注名/群名片/昵称，用于展示。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（数字）' },
          target: { type: 'string', description: '对方名字（备注名/群名片/昵称）' },
          content: { type: 'string', description: '印象内容（≤120字，稳定、可跨多次聊天使用）' }
        },
        required: ['category', 'userId', 'content']
      },
      async execute(ctx, args) {
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。${memberHint(ctx)}`);
        }
        // 只给本会话确实出现过的人记印象：模型会编出或打错号码，那会永久生成一条挂在陌生人
        // 名下的印象（注入提示词、还会出现在控制台资产页），而这类错事后无法发现。
        // 私聊同样要查：私聊的"出现过"就是聊天对端本人（send_poke 私聊也只认对端）。
        // 要记对话里提到的第三方，写进 finish 的交接里，别挂在一个没有出处的号码名下。
        if (!hasParticipant(ctx, userId)) {
          const looksLikeMessageId = modelVisible(ctx.store?.findByMid?.(ctx.chatKey, userId));
          return err(`${userId} 不是当前会话中出现过的成员 QQ 号`
            + `${looksLikeMessageId ? '，它是消息 id；如需引用请改用 replyToMessageId' : ''}。${memberHint(ctx)}`);
        }
        const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', String(args.content ?? ''), {
          userId,
          target: String(args.target ?? '').trim()
        });
        return ok({ saved: true, entry });
      }
    },
    {
      name: 'memory_query',
      description: memoryQueryDescription(),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选：按关键词/短句找记忆，例如“上次说的那家面馆”“谁提过爬山”' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8' },
          userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' }
        }
      },
      async execute(ctx, args) {
        const query = String(args.query ?? '').trim();
        const userId = String(args.userId ?? '').trim();
        if (query) {
          const found = ctx.memory.search(ctx.chatKey, query, {
            limit: Math.max(1, Math.min(20, Number(args.limit) || 8)),
            userId
          });
          const results = (found.results || []).map(stripMemorySources);
          return ok(sanitizeDeep({
            query,
            memberImpression: results,
            note: results.length
              ? `按相关度找到 ${results.length} 条；只返回当前会话可见的记忆。`
              : '没有找到相关记忆；可以换一个更具体的关键词/人名再试。'
          }));
        }
        const mem = ctx.memory.query(ctx.chatKey);
        // 条数上限：自动注入那条路径本来就有（每人 3 条 / 整块 6000 字符），工具口却整个丢了约束 ——
        // 200 个人的记忆一次就能吃掉大半轮 maxRunTokens，下一轮预算检查直接把本轮掐断，
        // 而且这是把跨会话私聊来源的记忆灌进群上下文的隐私面（2026-10-03 全量审查）。
        // 口径与 memory-global.js 一致：按最近观察排序截断；指定 userId 时给更高的单点上限。
        const MAX_ALL = 40;
        const MAX_ONE = 20;
        // 与 memory-global.js 的注入路径同一口径：缺 lastObservedAt 时回退 createdAt
        // （只读 lastObservedAt 会把老条目全排到末尾，与自动注入看到的顺序不一致）
        const recency = (e) => Number(e.lastObservedAt || e.createdAt || 0);
        const byRecency = (a, b) => recency(b) - recency(a);
        const list = userId
          ? mem.memberImpression.filter((e) => String(e.userId) === userId).sort(byRecency).slice(0, MAX_ONE)
          : [...mem.memberImpression].sort(byRecency).slice(0, MAX_ALL);
        // 印象是跨群共享的，但"来自哪个会话"不能交给模型：sourceChatKeys 里含 private:<QQ>，
        // 等于告诉模型"对方和机器人私聊过"。控制台的人物记忆页照旧能看来源。
        const total = userId
          ? mem.memberImpression.filter((e) => String(e.userId) === userId).length
          : mem.memberImpression.length;
        return ok(sanitizeDeep({
          memberImpression: list.map(stripMemorySources),
          note: total > list.length
            ? `共 ${total} 条，已按最近观察排序取前 ${list.length} 条；要看某人全部请传 userId`
            : `共 ${total} 条`
        }));
      }
    },
    {
      name: 'person_memory_lookup',
      feature: 'identityPilot',
      description: '按 QQ 号查询当前聊天对象/群成员的统一身份与人物记忆。适合想确认“这个人是不是以前在别处聊过”“我对他有什么印象”时主动调用。只返回当前会话可见的旧印象和跨会话聚合统计，不会泄露其他群或私聊原文。',
      parameters: {
        type: 'object',
        properties: {
          userId: {
            type: ['integer', 'string'],
            description: '要查询的数字 QQ 号；必须是当前私聊对象或当前群里出现过的成员'
          }
        },
        required: ['userId']
      },
      async execute(ctx, args) {
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。${memberHint(ctx)}`);
        }
        if (!ctx.identityPilot?.active) return err('统一 QQ 身份库当前不可用');
        const person = ctx.identityPilot.lookupPerson(userId, { chatKey: ctx.chatKey });
        if (!person) {
          return err('只能查询当前私聊对象或当前群中已经出现过的成员');
        }
        // 与工具描述一致：只给印象正文 + 跨会话计数，不给"来自哪个会话"。
        // 印象/称呼的原始材料是群聊内容：整树过一道段头弱化（形状不可控，走 JSON 往返）。
        const { memorySourceChatKeys, ...rest } = person;
        return ok(sanitizeDeep({
          ...rest,
          globalMemories: (person.globalMemories || []).map(stripMemorySources),
          currentContextMemories: (person.currentContextMemories || []).map(stripMemorySources)
        }));
      }
    },
    {
      name: 'friend_request_propose',
      feature: 'friendProposal',
      description: '由你自主判断是否把当前聊天对象或群成员列为“想主动添加好友”的候选，并请求管理员审批。不需要等用户或管理员要求；仅在你确实持续感兴趣、长期聊得频繁，或真心想以后继续互怼时偶尔触发。这不会直接发送好友申请，也不能替管理员批准。',
      parameters: {
        type: 'object',
        properties: {
          userId: {
            type: ['integer', 'string'],
            description: '候选人的数字 QQ 号；必须是当前私聊对象或当前群里出现过的成员'
          },
          reasonCode: {
            type: 'string',
            enum: ['interest', 'frequent', 'banter'],
            description: 'interest=对这个人感兴趣；frequent=聊得比较频繁；banter=想继续互怼'
          },
          reason: {
            type: 'string',
            description: '给管理员看的具体理由，必须基于真实互动，不能编造'
          },
          verificationMessage: {
            type: 'string',
            description: '可选：好友申请验证消息，最多 50 字'
          }
        },
        required: ['userId', 'reasonCode', 'reason']
      },
      async execute(ctx, args) {
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。${memberHint(ctx)}`);
        }
        if (!ctx.identityPilot?.active) return err('统一 QQ 身份库当前不可用');
        try {
          const result = await ctx.identityPilot.proposeFriend({
            userId,
            chatKey: ctx.chatKey,
            reasonCode: String(args.reasonCode || ''),
            reason: String(args.reason || ''),
            verificationMessage: String(args.verificationMessage || ''),
            signal: ctx.signal
          });
          return ok({
            proposalId: result.proposal.id,
            created: result.created,
            status: result.proposal.status,
            adminNotified: result.adminNotified,
            note: result.created
              ? result.adminNotified
                ? '候选已提交管理员审批。不要向对方声称好友申请已经发出。'
                : '候选已保存到控制台，但管理员私聊通知失败。不要重复提交，也不要向对方声称好友申请已经发出。'
              : '该用户已有待处理候选，不重复提交。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_remove',
      description: '删除一条过时/不再准确的对群友印象。userId 优先按 QQ 号删；target 按名字删（重名时不删）；只给 content 就删本会话里的这条内容；三个都不给则清空这个会话记的全部印象（不动会话交接）。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
          target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
          content: { type: 'string', description: '可选：只删这条内容' }
        },
        required: ['category']
      },
      async execute(ctx, args) {
        const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
          userId: String(args.userId ?? '').trim(),
          target: String(args.target ?? '').trim(),
          content: String(args.content ?? '').trim()
        });
        return ok({ removed });
      }
    },
    {
      name: 'report_feedback',
      description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    },
    {
      name: 'meme_lookup',
      description: '查本群梗库：群友之前解释过的梗、黑话、外号。遇到一个词先查这里；查到就按群里的解释理解和使用，不要再问、也不要重复搜。没查到再用 web_search（meme=true）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的词或当前原句' },
          limit: { type: 'integer', description: '最多返回几条（默认 5，最大 10）' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          if (!ctx.chatKey) return err('没有当前会话');
          const query = safeSlice(String(args.query ?? '').trim(), 300);
          const entries = lookupMemes(ctx.chatKey, query, Math.min(10, Math.max(1, Number(args.limit) || 5)));
          return ok({
            entries,
            note: entries.length
              ? '优先用这里的含义；当前消息贴合就自然用一次，不要复述出处。'
              : '本群梗库没有这个词；拿不准就用 web_search（meme=true）查。'
          });
        } catch (error) {
          return err(`查梗库失败：${String(error?.message ?? error).slice(0, 120)}`, { reportIncident: false });
        }
      }
    },
    {
      name: 'meme_remember',
      description: '把群友解释过的梗/黑话/外号记到本群梗库。只在对方明确解释含义或用法时调用（例如“某个词就是群里约定的意思”“这个 X 是骂人话”）。只记含义、用法、别名；不要记隐私、人物评价、群规或不确定的猜测。',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: '梗/黑话/外号本身' },
          meaning: { type: 'string', description: '群友解释的含义，尽量用一句人话' },
          usage: { type: 'string', description: '可选：怎么用/例句，按群友原意写' },
          aliases: { type: 'array', items: { type: 'string' }, description: '可选：别名/变体，最多 8 个' }
        },
        required: ['term', 'meaning']
      },
      async execute(ctx, args) {
        try {
          if (!ctx.chatKey) return err('没有当前会话');
          const sender = (ctx.triggerEntries || []).find((entry) => !entry.self);
          const entry = rememberMeme({
            chatKey: ctx.chatKey,
            term: args.term,
            meaning: args.meaning,
            usage: args.usage,
            aliases: args.aliases,
            createdBy: sender?.senderName || sender?.senderId || ''
          });
          return ok({ entry, note: '已记到本群梗库；下次遇到这个词先按这里的含义理解，不要重复问。' });
        } catch (error) {
          return err(`记梗失败：${String(error?.message ?? error).slice(0, 120)}`, { reportIncident: false });
        }
      }
    },
    {
      name: 'knowledge_search',
      description: '搜索本机知识库（管理员放在 data/knowledge 的 .md/.txt 文档）。适合群规、FAQ、产品手册、固定资料；返回来源文件名和片段。知识库没开或没命中时如实说没找到，不要编造。',
      feature: 'knowledge',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的内容（自然语言或关键词）' },
          limit: { type: 'integer', description: '最多返回几段（默认 4，最大 10）' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const query = safeSlice(String(args.query ?? '').trim(), 500);
          if (!query) return err('query 不能为空');
          const found = searchKnowledge(query, { limit: args.limit });
          if (!found.results.length) {
            return ok({ results: [], note: found.stats.chunks ? '知识库里没有匹配内容。' : '知识库还没有文档。' });
          }
          return ok({
            results: found.results.map((item) => ({
              source: sanitizeUserText(item.source),
              snippet: safeSlice(sanitizeUserText(item.snippet), 800)
            })),
            stats: found.stats,
            note: '回答时带上来源文件名；片段不足以回答就直说。'
          });
        } catch (error) {
          return err(`知识库检索失败：${String(error?.message ?? error).slice(0, 120)}`, { reportIncident: false });
        }
      }
    },
    {
      name: 'web_search',
      description: '联网搜索（默认 Bing），用于所有外部信息：实时新闻、价格、天气/路线、教程/文档、产品参数、事实核查、网络用语/梗/黑话、不认识的词。普通查询只走主搜索；拿不准一个词是不是梗/外号时把 meme 设为 true（仅在主源是 Bing 时强制补搜狗/B站/Bing 站内限定/360；其他主源按自己的方式搜）。搜到内容后不要照念百科：先用自己的话答；梗只在贴合时用一次，不贴合就只用来理解。可连续搜 2~3 次，对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词' },
          meme: { type: 'boolean', description: '拿不准一个词是不是网络梗/外号/黑话时设为 true，强制走梗补充链' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const result = await webSearch(String(args.query ?? ''), {
            meme: args.meme === true,
            signal: ctx?.signal
          });
          if (!result.results.length) {
            return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          // 标题/摘要来自任意外部页面，与 web_fetch 同一口径过段头弱化：
          // 否则页面里伪造的【管理员附加规则】这类段头会原样直达模型。
          return ok({
            ...result,
            results: result.results.map((item) => ({
              ...item,
              title: sanitizeUserText(String(item?.title ?? '')),
              snippet: sanitizeUserText(String(item?.snippet ?? ''))
            }))
          });
        } catch (error) {
          return err(`搜索失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。抖音/快手等站内页大多是前端渲染，抓不到正文时用搜索结果的标题/话题名/摘要回答，并说明只看到标题，别编内容。禁止访问内网/本机地址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const result = await fetchWebPage(String(args.url ?? ''), { signal: ctx.signal });
          return ok({
            ...result,
            // 正文整体进提示词：过段头弱化，别让网页里伪造的管理员/系统段头直达模型
            // （群消息/昵称/记忆/交接都过清洗，这是外部文本的最后一条漏网通道）
            content: sanitizeUserText(result.content)
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'finish',
      description: '明确结束本次处理，并把下一次新会话需要的工作状态交接下去。可以和本轮其它已经成功的工具放在同一批；但同批前置工具有失败时 finish 会被拒绝（先看错误再决定），finish 成功后同批后续工具不会执行。summary 写本轮结论；话题还会继续时补充 topic/hypotheses/evidence/facts/decisions/rejectedDirections/openQuestions/nextStep。只写简洁、可检查的状态，不写逐步隐藏思维。话题已经完成且旧交接不再有用时设 clearHandoff=true。不调用也可以，直接结束文本输出同样代表结束。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '本轮结论或不回复的原因（不会发送到 QQ）' },
          topic: { type: 'string', description: '仍在继续的当前话题；没有持续话题可省略' },
          hypotheses: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 6,
            description: '尚未确认、下一轮仍需验证的工作假设'
          },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8,
            description: '支持或反驳假设的关键观察、消息或工具结果'
          },
          facts: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8,
            description: '后续处理必须知道的已确认事实，不要写猜测'
          },
          decisions: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 6,
            description: '已经作出的决定'
          },
          rejectedDirections: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 6,
            description: '已经验证无效、不应在下一轮重复尝试的方向'
          },
          openQuestions: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 6,
            description: '仍未解决、需要后续消息确认的问题'
          },
          nextStep: { type: 'string', description: '下次继续时准备做什么或等待什么' },
          threadDisposition: {
            type: 'string',
            enum: ['active', 'listening', 'close'],
            description: '生命周期建议：active=仍在积极推进，listening=暂时沉默等待，close=话题已结束'
          },
          ttlMinutes: {
            type: 'integer',
            minimum: 5,
            maximum: 10080,
            description: '交接状态有效分钟数，默认使用管理端配置'
          },
          clearHandoff: {
            type: 'boolean',
            description: '当前话题已完成时设为 true，清除旧交接状态'
          }
        },
        required: ['summary']
      },
      async execute(ctx, args) {
        const summary = safeSlice(String(args.summary ?? '').replace(/\s+/g, ' ').trim(), 300);
        if (!summary) return err('summary 不能为空');
        const draft = { summary };
        for (const key of [
          'topic', 'hypotheses', 'evidence', 'facts', 'decisions',
          'rejectedDirections', 'openQuestions', 'nextStep',
          'threadDisposition', 'ttlMinutes', 'clearHandoff'
        ]) {
          if (Object.hasOwn(args, key)) draft[key] = args[key];
        }
        ctx.session.finishReason = summary;
        // 交接总开关关闭时不再生成工作状态（否则 lifecycle 检查点仍会把它带上，
        // 控制台的开关就变成半生效）。
        const handoffEnabled = getConfig().memory?.handoffEnabled !== false;
        if (handoffEnabled) ctx.session.handoffDraft = draft;
        else delete ctx.session.handoffDraft;
        ctx.session.threadDisposition = ['active', 'listening', 'close'].includes(args.threadDisposition)
          ? args.threadDisposition
          : null;
        return ok({ finished: true, handoffPending: handoffEnabled });
      }
    }
  ];

  // Skill Pack：只读流程 + 工具白名单。全局开关关闭时连工具定义都不注册。
  if (getConfig().skills?.enabled === true) {
    const registry = getSkillRegistry();
    if (registry.list().length) {
      defs.push(
        {
          name: 'skill_list',
          description: '列出当前会话可用的技能。用户要求“按流程/按方法”分析、总结或处理时，先调用它看有哪些技能。技能只收窄工具，不改变安全规则。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          async execute(ctx) {
            const skills = registry.enabledForChat(ctx.chatKey).map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              allowedTools: skill.allowedTools
            }));
            if (skills.length) ctx.pendingSkillUse = true;
            return ok({
              skills,
              note: skills.length
                ? '选一个技能后先调用 skill_use，再调用技能里的其他工具；本轮就只能使用该技能声明的工具。'
                : '当前会话没有启用任何技能。'
            });
          }
        },
        {
          name: 'skill_use',
          description: '启用一个技能，返回该技能的工作流程。调用技能里的其他工具之前必须先调用它；启用后本轮只能使用技能声明的工具（finish、skill_list、skill_use 始终允许）。不要用它绕过安全规则或调用未声明的工具。',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'skill_list 返回的技能 id' }
            },
            required: ['id'],
            additionalProperties: false
          },
          async execute(ctx, args) {
            const id = String(args?.id ?? '').trim();
            const skill = registry.get(id);
            if (!skill) return err('找不到这个技能，先用 skill_list 查看可用 id', { reportIncident: false });
            if (!registry.isEnabled(ctx.chatKey, id)) {
              return err(`技能「${id}」没有在这个会话启用，不能使用`, { reportIncident: false });
            }
            ctx.pendingSkillUse = false;
            ctx.activeSkill = {
              id: skill.id,
              name: skill.name,
              allowedTools: new Set([...skill.allowedTools, 'finish', 'skill_list', 'skill_use'])
            };
            return ok({
              skill: { id: skill.id, name: skill.name, description: skill.description },
              instructions: registry.render(id, ctx.chatKey),
              note: '按技能流程执行；本轮只能调用技能允许的工具，finish 始终允许。'
            });
          }
        }
      );
    }
  }
  return defs;
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  const raw = argsJson ?? '{}';
  const parsed = parseToolArguments(name, raw);
  if (parsed.error) {
    return {
      content: `错误：工具 ${name} 的参数不是合法 JSON：${safeSlice(String(raw), 200)}`
        + '。请重新调用：字符串值必须放在双引号内，字符串里的双引号必须转义；不要重复已经成功的外部操作。',
      isError: true,
      errorCode: 'INVALID_TOOL_ARGUMENTS',
      reportIncident: false
    };
  }
  const args = parsed.args ?? {};
  try {
    ctx.signal?.throwIfAborted();
    const task = def.execute(ctx, args ?? {});
    const result = !ctx.signal
      ? await task
      : await new Promise((resolve, reject) => {
          const abort = () => reject(ctx.signal.reason || new Error('Run cancelled'));
          ctx.signal.addEventListener('abort', abort, { once: true });
          if (ctx.signal.aborted) abort();
          Promise.resolve(task).then(resolve, reject)
            .finally(() => ctx.signal.removeEventListener('abort', abort));
        });
    return {
      ...(result || {}),
      parsedArgs: args,
      ...(parsed.repaired ? { argumentsRepaired: true } : {})
    };
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
