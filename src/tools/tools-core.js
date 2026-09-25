// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../core/config.js';

// 消息 id 归一化：模型常把聊天记录里的 "#123" 连 # 一起传进来，而 OneBot 只认纯数字 id。
// store.js 里有一份同名函数但没导出，所以这里保留 tools 层自用的一份。
function normalizeMid(value) {
  return String(value ?? '').trim().replace(/^(?:#+|collected_)+/, '').trim();
}

/** 印象条目去掉"来自哪个会话"：工具契约写明不泄露其他群/私聊的来源。 */
function stripMemorySources(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { sourceChatKeys, ...rest } = entry;
  return rest;
}

// QQ 系统表情：中文名 → 编号。表由 /home/ubuntu/export-face-names.sh 从 SnowLuma 容器导出到数据目录。
let FACE_INDEX = null;
function faceIndex() {
  if (FACE_INDEX) return FACE_INDEX;
  FACE_INDEX = new Map();
  try {
    const dir = process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data');
    const bySid = JSON.parse(fs.readFileSync(path.join(dir, 'face-names.json'), 'utf8')).bySid || {};
    for (const [sid, name] of Object.entries(bySid)) {
      const key = String(name).trim();
      if (!key) continue;
      const prev = FACE_INDEX.get(key);
      const num = Number(sid);
      // 同名时优先数字较小的经典表情（0~103 那批）
      if (prev === undefined || (Number.isFinite(num) && num < Number(prev))) FACE_INDEX.set(key, sid);
    }
  } catch { /* 表不存在时退化为只认编号 */ }
  return FACE_INDEX;
}

function faceLookup(name) {
  const key = String(name ?? '').trim().replace(/^\/+/, '');
  if (!key) return { error: 'name 不能为空，请填表情中文名，如 微笑' };
  const idx = faceIndex();
  if (idx.has(key)) return { face: { id: idx.get(key), name: key } };
  if (/^\d+$/.test(key)) return { face: { id: key, name: `编号${key}` } };
  const like = [...idx.keys()].filter((n) => n.includes(key) || key.includes(n)).slice(0, 12);
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

import { normalizeMessageList, sanitizeUserText, unquoteJsonString } from '../core/util.js';
import { repairUnescapedStringQuotes } from '../core/json-repair.js';
import { formatStickerList } from '../onebot/stickers.js';
import { validateImageUrl, safeFetchBinary } from '../llm/safe-fetch.js';
import { webSearch, webFetch } from '../llm/web-search.js';
import { expandForwardNodes, extractMediaFromSegments } from '../onebot/onebot.js';
import { readForwardMessages } from '../onebot/forward-reader.js';
import { convertGifToStillStrip, fetchOversizedImageAsJpeg } from './image-downsample.js';


/**
 * 视觉模型用的 data URL 收口。GIF 特殊处理：主流视觉网关不接受 image/gif，
 * 且动图的情绪信息在动作里——用 ffmpeg 抽帧拼成 2x2 帧条转成 JPEG；
 * ffmpeg 缺失或转换失败时回退原始 GIF data URL（保持既有行为，不劣化）。
 */
async function toVisionDataUrl(buffer, mime, signal) {
  if (mime === 'image/gif') {
    try {
      const strip = await convertGifToStillStrip(buffer, signal);
      if (strip?.length) return `data:image/jpeg;base64,${strip.toString('base64')}`;
    } catch { /* 回退原始 GIF */ }
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

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message, metadata = {}) {
  return { content: `错误：${message}`, isError: true, ...metadata };
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

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  // 昵称入库时未清洗（ingest 只清洗 text），工具结果会回传给模型 —— 过同一道清洗。
  const lines = members.map((m) => `- ${sanitizeUserText(m.name)}：${m.userId}`).join('\n');
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
    if (!ctx.store?.findByMid?.(ctx.chatKey, reply)) {
      return `当前会话找不到要引用的消息 ${reply}。${midHint(ctx)}`;
    }
  }
  if (at) {
    if (ctx.kind !== 'group') return '私聊不需要 atUserId';
    if (!/^\d{1,15}$/.test(at)) {
      return `atUserId 必须是当前群成员的数字 QQ 号。${memberHint(ctx)}`;
    }
    if (!hasParticipant(ctx, at)) {
      const looksLikeMessageId = Boolean(ctx.store?.findByMid?.(ctx.chatKey, at));
      return `${at} 不是当前群中已出现的成员 QQ 号`
        + `${looksLikeMessageId ? '，它是消息 id；如需引用请改用 replyToMessageId' : ''}。${memberHint(ctx)}`;
    }
  }
  return '';
}

async function currentMessageImageUrls(ctx, entry) {
  let media = entry.media || [];
  if (entry.mid != null && typeof ctx.onebot?.getMsg === 'function') {
    try {
      const data = await ctx.onebot.getMsg(entry.mid);
      const segments = Array.isArray(data?.message) ? data.message : [];
      const fresh = extractMediaFromSegments(segments)
        .filter((item) => item.kind === 'image' && (item.url || item.file));
      if (fresh.length) {
        media = fresh;
        ctx.store?.updateByMid?.(ctx.chatKey, entry.mid, { appendMedia: fresh });
      }
    } catch {
      // Stored URLs remain a best-effort fallback when the source message expired.
    }
  }
  return media
    .filter((item) => item.kind === 'image')
    .map((item) => String(item.url || item.file || '').trim())
    .filter(Boolean)
    .slice(0, 4);
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
export function buildToolDefs() {
  return [
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          const targetError = messageTargetError(ctx, args);
          if (targetError) return err(targetError);
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
            runId: ctx.session.leaseId, signal: ctx.signal,
            preserveCode: ctx.behaviorProfile === 'grounded',
            replyToMessageId: normalizeMid(args.replyToMessageId) || null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
          ctx.emit('session-update', ctx.session.id);
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error, {
            incidentCaptured: error?.incidentCaptured === true
          });
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 直接填【可用表情包】里的备注名即可（如“别墨迹”），也接受完整 id。',
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
          const sticker = await ctx.stickers.findForSend(unquoteJsonString(args.stickerId));
          if (!sticker) return err(`找不到表情。${await stickerLookupHint(ctx, args.stickerId)}`);
          if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
          const targetError = messageTargetError(ctx, args);
          if (targetError) return err(targetError);
          const managedInline = sticker.source === 'manual'
            && Boolean(sticker.localFile)
            && sticker.url.startsWith('base64://');
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
            atUserId: args.atUserId ?? null
          });
          ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
        } catch (error) {
          return err(error?.message ?? error, {
            incidentCaptured: error?.incidentCaptured === true
          });
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
          if (!sticker) return err(`找不到表情。${await stickerLookupHint(ctx, args.stickerId)}`);
          if (!sticker.url) return err('该表情没有图片地址');
          const dataUrl = await downloadImageAsDataUrl(sticker.url, ctx.signal);
          return { content: imageParts(`表情 ${sticker.id}（你的备注：${sticker.localNote || sticker.desc || '无'}）（先判断情绪/态度再回应）：`, [dataUrl]) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sticker_note',
      description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
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
          if (!entry) return err(`找不到表情。${await stickerLookupHint(ctx, args.stickerId)}`);
          return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。',
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
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && m.url);
          if (!imageMedia) return err('该消息没有可收藏的图片');
          // 与 send_message/send_sticker 一样归一化：模型常传 "#123"，直接当 id 会生成
          // collected_#123，而刷新逻辑只认 collected_123，收藏的表情链接就永远不刷新。
          const saved = ctx.stickers.collect(normalizeMid(args.messageId), { url: imageMedia.url, note: String(args.note ?? '') });
          return ok({ collected: true, id: saved.id, note: saved.localNote });
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
          if (hit.error) return err(hit.error);
          const targetError = messageTargetError(ctx, args);
          if (targetError) return err(targetError);
          const result = await ctx.sender.sendFace(ctx.chatKey, hit.face, {
            runId: ctx.session.leaseId, signal: ctx.signal,
            replyToMessageId: normalizeMid(args.replyToMessageId) || null,
            atUserId: args.atUserId ?? null,
            text: args.text ? unquoteJsonString(args.text) : null
          });
          ctx.session.sent.push({ type: 'face', text: `${args.text ? unquoteJsonString(args.text) : ''}[表情:${hit.face.name}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, faceId: hit.face.id, name: hit.face.name, messageId: result?.message_id ?? null, note: '系统表情已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
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
          const note = String(args.note ?? '').slice(0, 200);
          const at = ctx.scheduleWake(Math.round(m * 60000), note);
          const when = new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
          return ok({ scheduled: true, minutes: Math.round(m), at: when, note, hint: '到点会作为主动机会唤醒你；不需要再回复这条结果。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          let target = args.targetUserId;
          if (target !== undefined && target !== null && String(target).trim() !== '') {
            const targetText = String(target).trim();
            if (!/^\d{1,15}$/.test(targetText)) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            if (ctx.kind === 'group' && !hasParticipant(ctx, targetText)) {
              const looksLikeMessageId = Boolean(ctx.store?.findByMid?.(ctx.chatKey, targetText));
              return err(`${targetText} 不是当前群中已出现的成员 QQ 号`
                + `${looksLikeMessageId ? '，它是消息 id' : ''}。${memberHint(ctx)}`);
            }
            if (ctx.kind === 'private' && String(ctx.chatId) !== targetText) {
              return err('私聊只能拍当前聊天对象，省略 targetUserId 即可');
            }
            target = Number(targetText);
            await ctx.sender.poke(ctx.chatKey, target, { runId: ctx.session.leaseId, signal: ctx.signal });
          } else {
            await ctx.sender.poke(ctx.chatKey, null, { runId: ctx.session.leaseId, signal: ctx.signal });
          }
          return ok({ poked: true });
        } catch (error) {
          return err(error?.message ?? error, {
            incidentCaptured: error?.incidentCaptured === true
          });
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 read_forward 展开看内容。',
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
        const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
        return ok({
          count: messages.length,
          messages: messages.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            sender: m.self ? '我' : sanitizeUserText(m.senderName),
            text: m.text
          }))
        });
      }
    },
    {
      name: 'read_forward',
      description: '展开查看合并转发的聊天记录。消息文本出现 [合并转发聊天记录] 或 [转发消息 …] 占位符时用。参数填那条转发消息前的 #数字（千万别用方括号里那串长 id，会过期报错）。展开结果会写回存档，以后再看就是展开的文本，不用重复调。',
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
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
          if (String(entry.text || '').startsWith('[合并转发 共')) {
            return ok({ messageId: entry.mid, text: entry.text, note: '该转发已展开（读的是存档）' });
          }
          const nodes = await readForwardMessages(ctx.onebot, entry.mid);
          const ex = await expandForwardNodes(nodes);
          if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
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
            name: sanitizeUserText(m.name),
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
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
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : sanitizeUserText(entry.senderName),
          senderId: entry.senderId,
          text: entry.text,
          reply: entry.reply
        });
      }
    },
    {
      name: 'get_message_images',
      description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] / [表情包] 时可用。id 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const urls = await currentMessageImageUrls(ctx, entry);
          if (!urls.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
          const dataUrls = [];
          const failed = [];
          for (const url of urls) {
            ctx.signal?.throwIfAborted();
            try { dataUrls.push(await downloadImageAsDataUrl(url, ctx.signal)); } catch (e) { failed.push(String(e?.message ?? e)); }
          }
          if (!dataUrls.length) return err(`图片获取失败：${failed.join('；')}`);
          const note = failed.length ? `（另有 ${failed.length} 张获取失败）` : '';
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
              const label = hit ? String(hit.localNote || hit.desc || '').trim() : '';
              if (label && !known.includes(label)) known.push(label);
            } catch { /* 查库失败不影响看图 */ }
          }
          const knownHint = known.length
            ? `（这张你之前看过并记过：「${known.join('」「')}」——按这个理解回，别再描述画面）`
            : '';
          return { content: imageParts(`消息 ${args.messageId} 的图片内容${note}${knownHint}（若是 2×2 四宫格：那是动图 GIF 按时间顺序抽的 4 帧，阅读顺序左上→右上→左下→右下，黑格是填充不是画面内容。先判断它想表达的情绪/态度：无语呆滞、嘲讽、卖萌、赞同、挑衅、摆烂、委屈…再针对态度回话，不要复述画面）：`, dataUrls) };
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
          const looksLikeMessageId = Boolean(ctx.store?.findByMid?.(ctx.chatKey, userId));
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
      description: '查看当前会话里你对群友的长期印象。不传 userId 返回全部；传 userId 只看某一个人。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' }
        }
      },
      async execute(ctx, args) {
        const mem = ctx.memory.query(ctx.chatKey);
        const userId = String(args.userId ?? '').trim();
        const list = userId
          ? mem.memberImpression.filter((e) => String(e.userId) === userId)
          : mem.memberImpression;
        // 印象是跨群共享的，但"来自哪个会话"不能交给模型：sourceChatKeys 里含 private:<QQ>，
        // 等于告诉模型"对方和机器人私聊过"。控制台的人物记忆页照旧能看来源。
        return ok({ memberImpression: list.map(stripMemorySources) });
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
        const { memorySourceChatKeys, ...rest } = person;
        return ok({
          ...rest,
          globalMemories: (person.globalMemories || []).map(stripMemorySources),
          currentContextMemories: (person.currentContextMemories || []).map(stripMemorySources)
        });
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
      name: 'web_search',
      description: '联网搜索（Bing），返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const result = await webSearch(String(args.query ?? ''));
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
      description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const result = await webFetch(String(args.url ?? ''));
          const body = String(result.body || '');
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated || body.length > 20000,
            // 正文整体进提示词：过段头弱化，别让网页里伪造的管理员/系统段头直达模型
            // （群消息/昵称/记忆/交接都过清洗，这是外部文本的最后一条漏网通道）
            content: sanitizeUserText(body.slice(0, 20000))
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'finish',
      description: '明确结束本次处理，并把下一次新会话需要的工作状态交接下去。summary 写本轮结论；话题还会继续时补充 topic/hypotheses/evidence/facts/decisions/rejectedDirections/openQuestions/nextStep。只写简洁、可检查的状态，不写逐步隐藏思维。话题已经完成且旧交接不再有用时设 clearHandoff=true。不调用也可以，直接结束文本输出同样代表结束。',
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
        const summary = String(args.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
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
        ctx.session.handoffDraft = draft;
        ctx.session.threadDisposition = ['active', 'listening', 'close'].includes(args.threadDisposition)
          ? args.threadDisposition
          : null;
        return ok({ finished: true, handoffPending: true });
      }
    }
  ];
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
      content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`
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
