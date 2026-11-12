// 机器人自主禁言：不是管理员命令通道，而是"被冒犯时的表达"。
// 情绪由模型判断，边界由代码硬夹：目标必须是本轮触发者、只对普通成员、
// 单次时长/同人冷却/每日次数都有上限，默认 dry-run。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/config-legacy.js';
import { getConfig } from '../core/config.js';
import { todayKey } from '../core/util.js';
import { classifyTransportFailure } from '../onebot/sender.js';

const STATE_FILE = path.join(DATA_DIR, 'mute-state.json');
const HISTORY_MS = 7 * 24 * 3600_000;
const DEFAULT_MAX_MINUTES = 60;
const DEFAULT_COOLDOWN_MINUTES = 360;
const DEFAULT_DAILY_LIMIT = 3;
let stateCache = null;

function configOf(cfg = getConfig()) {
  const raw = cfg?.mute || {};
  return {
    enabled: raw.enabled === true,
    dryRun: raw.dryRun !== false,
    maxMinutes: Math.min(1440, Math.max(1, Math.round(Number(raw.maxMinutes) || DEFAULT_MAX_MINUTES))),
    cooldownMinutes: Math.min(10080, Math.max(1, Math.round(Number(raw.cooldownMinutes) || DEFAULT_COOLDOWN_MINUTES))),
    dailyLimit: Math.min(20, Math.max(1, Math.round(Number(raw.dailyLimit) || DEFAULT_DAILY_LIMIT)))
  };
}

function emptyState() {
  return { version: 1, records: [], daily: {} };
}

function loadState(now = Date.now()) {
  if (stateCache) return stateCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    stateCache = {
      version: 1,
      records: Array.isArray(parsed?.records) ? parsed.records : [],
      daily: parsed?.daily && typeof parsed.daily === 'object' ? parsed.daily : {}
    };
  } catch {
    stateCache = emptyState();
  }
  pruneState(stateCache, now);
  return stateCache;
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flush: true });
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    console.warn('[mute] 写入本地记录失败（不影响已执行的禁言）:', error?.message || error);
  }
}

function pruneState(state, now) {
  state.records = state.records.filter((record) => Number(record?.at) > now - HISTORY_MS);
  const cutoff = todayKey(now - 8 * 24 * 3600_000);
  for (const key of Object.keys(state.daily)) {
    const day = key.split('|')[1] || '';
    if (day < cutoff) delete state.daily[key];
  }
}

function dailyKey(chatKey, now = Date.now()) {
  return `${chatKey}|${todayKey(now)}`;
}

function recordsFor(state, chatKey, userId) {
  return state.records.filter((record) => record.chatKey === chatKey && String(record.userId) === String(userId));
}

function latestBanRecord(state, chatKey, userId) {
  return recordsFor(state, chatKey, userId)
    .filter((record) => Number(record.minutes) > 0)
    .sort((a, b) => Number(b.at) - Number(a.at))[0] || null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message, metadata = {}) {
  return { content: `错误：${message}`, isError: true, ...metadata };
}

function normalizeTarget(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(text)) return '';
  return text.replace(/^0+(?=\d)/, '');
}

function displayName(member, uid) {
  const text = String(member?.card || member?.nickname || member?.name || member?.remark || '')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
  return text || String(uid || '');
}

async function memberInfo(ctx, userId) {
  if (typeof ctx.onebot?.getGroupMemberInfo !== 'function') throw new Error('协议端不支持查询群成员');
  return await ctx.onebot.getGroupMemberInfo(ctx.chatId, Number(userId));
}

async function listMembers(ctx) {
  if (typeof ctx.onebot?.getGroupMemberList !== 'function') throw new Error('协议端不支持查询群成员列表');
  const list = await ctx.onebot.getGroupMemberList(ctx.chatId);
  return Array.isArray(list) ? list : [];
}

function roleOf(member) {
  return String(member?.role || '').trim().toLowerCase();
}

function memberUid(member) {
  return String(member?.user_id ?? member?.userId ?? member?.uin ?? '').trim();
}

async function resolveTarget(ctx, raw) {
  const numeric = normalizeTarget(raw);
  if (numeric) {
    try {
      const member = await memberInfo(ctx, numeric);
      if (member) return { userId: numeric, member };
    } catch { /* 有的协议端只实现列表接口，下面用列表兜底 */ }
    const member = (await listMembers(ctx)).find((item) => memberUid(item) === numeric);
    if (member) return { userId: numeric, member };
    throw new Error(`本群没有找到 QQ ${numeric}`);
  }
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('target 不能为空');
  const members = await listMembers(ctx);
  const matches = members.filter((member) => {
    const names = [member?.card, member?.nickname, member?.name].map((value) => String(value || '').trim()).filter(Boolean);
    return names.includes(text);
  });
  if (matches.length === 1) return { userId: memberUid(matches[0]), member: matches[0] };
  if (!matches.length) throw new Error(`本群没有找到名为「${text}」的成员；不确定是谁就填 QQ 号`);
  throw new Error(`本群有 ${matches.length} 个「${text}」，请改填 QQ 号`);
}

function deny(ctx, reason) {
  console.log(`[mute][deny] ${ctx.chatKey || ''} ${reason}`);
  return err(reason, { reportIncident: false });
}

function parseMinutes(raw, maxMinutes) {
  if (raw === undefined || raw === null) return { minutes: Math.min(10, maxMinutes) };
  if (typeof raw === 'number' && Object.is(raw, -0)) return { error: 'minutes 必须是 0 或正整数（0 = 解禁）' };
  if (typeof raw === 'boolean' || Array.isArray(raw) || typeof raw === 'object') return { error: 'minutes 必须是 0 或正整数' };
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { error: 'minutes 必须是 0 或正整数（0 = 解禁）' };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) return { error: 'minutes 必须是 0 或正整数（0 = 解禁）' };
  if (value > maxMinutes) return { error: `单次禁言最多 ${maxMinutes} 分钟` };
  return { minutes: value };
}

function audit(ctx, action, detail) {
  const tag = action === 'dry-run' ? '[mute][dry-run]' : action === 'deny' ? '[mute][deny]' : `[mute]${action === 'failed' ? '[failed]' : ''}`;
  console.log(`${tag} ${ctx.chatKey || ''} ${detail}`);
}

// 测试/独立调用时没有副作用账本，直接执行；命名函数让 ops scan 能识别调用点。
function runDirect(_ctx, _kind, _detail, task) {
  return task();
}

async function executeMute(ctx, args, { trackDirectWrite } = {}) {
  const cfg = configOf(getConfig());
  if (!cfg.enabled) return deny(ctx, '主动禁言没有启用');
  if (ctx.kind !== 'group') return deny(ctx, '主动禁言只能在群聊里使用');
  const selfId = String(ctx.onebot?.selfId || ctx.selfId || '').trim();
  if (!selfId) return deny(ctx, '拿不到机器人自己的 QQ 号');
  const parsed = parseMinutes(args?.minutes, cfg.maxMinutes);
  if (parsed.error) return deny(ctx, parsed.error);
  const minutes = parsed.minutes;

  let target;
  let selfInfo;
  try {
    selfInfo = await memberInfo(ctx, selfId);
    if (!['admin', 'owner'].includes(roleOf(selfInfo))) return deny(ctx, '机器人不是群管理员，不能禁言');
    target = await resolveTarget(ctx, args?.target);
  } catch (error) {
    return deny(ctx, String(error?.message ?? error));
  }
  const uid = String(target.userId || '');
  if (!uid) return deny(ctx, '没有解析出目标 QQ 号');
  if (uid === selfId) return deny(ctx, '不能禁言自己');
  const owner = String(getConfig()?.admin?.ownerUin || '').trim();
  if (owner && uid === owner) return deny(ctx, '不能禁言全局管理员');
  const triggerIds = new Set((ctx.triggerEntries || [])
    .filter((entry) => !entry?.self)
    .map((entry) => String(entry?.senderId || ''))
    .filter(Boolean));
  if (!triggerIds.has(uid)) {
    return deny(ctx, `只能对你这一轮真正被惹到的人动手；${displayName(target.member, uid)} 这一轮没惹你`);
  }
  const role = roleOf(target.member);
  if (role !== 'member') return deny(ctx, '只能对普通群成员执行；群主、管理员或角色未知的目标不行');
  if (!(Number(target.member?.join_time) > 0)) return deny(ctx, '目标不在本群（join_time 为空）');
  const name = displayName(target.member, uid);
  const emotion = String(args?.emotion || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const reason = String(args?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const now = Date.now();
  const state = loadState(now);

  if (minutes === 0) {
    const record = latestBanRecord(state, ctx.chatKey, uid);
    if (!record) return deny(ctx, `只能解除你自己下过的禁言；${name} 不在可解除记录里`);
    if (record.unmutedAt) return deny(ctx, `${name} 的这条禁言已经解除过了`);
    const currentUntil = Number(target.member?.shut_up_timestamp) || 0;
    if (!(currentUntil > 0)) return deny(ctx, `${name} 当前没有生效中的禁言`);
    const mineEnd = Math.floor(Number(record.at) / 1000) + Number(record.minutes) * 60;
    if (currentUntil > mineEnd + 120) return deny(ctx, '当前禁言看起来被人加罚过，不能替你解除');
    if (cfg.dryRun) {
      audit(ctx, 'dry-run', `计划解除 ${name}(${uid}) 的禁言`);
      return ok({ action: 'unmute-dry-run', target: uid, name, minutes: 0, note: `（试运行）我本来打算把 ${name} 放出来` });
    }
    try {
      if (typeof ctx.onebot?.setGroupBan !== 'function') throw new Error('协议端不支持禁言');
      await (trackDirectWrite || runDirect)(ctx, 'ban', { target: uid, minutes: 0, mode: 'auto-unmute' }, () => ctx.onebot.setGroupBan(ctx.chatId, Number(uid), 0, ctx.signal));
    } catch (error) {
      const { uncertain } = classifyTransportFailure(error);
      audit(ctx, uncertain ? 'failed' : 'failed', `解除 ${name}(${uid}) 失败：${String(error?.message ?? error).slice(0, 160)}`);
      return err(uncertain ? `没拿到协议端确认，${name} 的禁言可能还在 —— 别重复操作` : `解除禁言失败：${String(error?.message ?? error).slice(0, 160)}`);
    }
    record.unmutedAt = now;
    saveState(state);
    audit(ctx, 'unmute', `解除 ${name}(${uid}) 的禁言${reason ? `，理由：${reason}` : ''}`);
    return ok({ action: 'unmute', target: uid, name, minutes: 0, note: `已经把 ${name} 放出来了` });
  }

  const last = latestBanRecord(state, ctx.chatKey, uid);
  if (last && now - Number(last.at) < cfg.cooldownMinutes * 60_000) {
    const wait = Math.ceil((cfg.cooldownMinutes * 60_000 - (now - Number(last.at))) / 60_000);
    return deny(ctx, `这人刚处理过，还得再等 ${wait} 分钟`);
  }
  const key = dailyKey(ctx.chatKey, now);
  const todayCount = Number(state.daily[key]) || 0;
  if (todayCount >= cfg.dailyLimit) return deny(ctx, `今天已经禁言 ${todayCount} 次，到上限 ${cfg.dailyLimit} 次了`);
  if (cfg.dryRun) {
    audit(ctx, 'dry-run', `计划禁言 ${name}(${uid}) ${minutes} 分钟${emotion ? `，情绪：${emotion}` : ''}`);
    return ok({ action: 'mute-dry-run', target: uid, name, minutes, emotion, note: `（试运行）我本来打算让 ${name} 安静 ${minutes} 分钟` });
  }

  let outcome = 'sent';
  try {
    if (typeof ctx.onebot?.setGroupBan !== 'function') throw new Error('协议端不支持禁言');
    await (trackDirectWrite || runDirect)(ctx, 'ban', { target: uid, minutes, mode: 'auto-mute' }, () => ctx.onebot.setGroupBan(ctx.chatId, Number(uid), minutes * 60, ctx.signal));
  } catch (error) {
    const { uncertain } = classifyTransportFailure(error);
    outcome = uncertain ? 'unknown' : 'failed';
    audit(ctx, 'failed', `禁言 ${name}(${uid}) 失败：${String(error?.message ?? error).slice(0, 160)}`);
    if (outcome === 'unknown') {
      state.records.push({ chatKey: ctx.chatKey, userId: uid, at: now, minutes, unknown: true, emotion, reason });
      state.daily[key] = todayCount + 1;
      saveState(state);
      return err(`没拿到协议端确认，${name} 可能已经被禁言了 —— 别重复操作`);
    }
    return err(`禁言失败：${String(error?.message ?? error).slice(0, 160)}`);
  }
  state.records.push({ chatKey: ctx.chatKey, userId: uid, at: now, minutes, emotion, reason });
  state.daily[key] = todayCount + 1;
  saveState(state);
  audit(ctx, 'mute', `禁言 ${name}(${uid}) ${minutes} 分钟${emotion ? `，情绪：${emotion}` : ''}${reason ? `，理由：${reason}` : ''}`);
  return ok({ action: 'mute', target: uid, name, minutes, emotion, note: `行吧，${name} 先安静 ${minutes} 分钟` });
}

export function muteToolDefs({ cfg = getConfig(), kind = '', trackDirectWrite } = {}) {
  if (configOf(cfg).enabled !== true || kind !== 'group') return [];
  return [{
    name: 'mute_member',
    description: '在群里让某个人安静一会儿（禁言）。这是你自己的脾气，不是管理工具：只能是这一轮真的惹到你的人（正在跟你说话、刷屏挑衅的那位），不能替别人出头。minutes 传 0 表示解除你自己之前禁的禁言；不确定是谁、或者只是有点不爽，就先别动手。它有三道硬上限（单次最长、同一人冷却、每群每天次数）。只有群聊里能用，你得是群主或管理员，而且不能动群主、管理员和你主人。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: '要禁言的人：QQ 号最好；也可以填群名片/昵称（本群唯一时才有效）' },
        minutes: { type: 'number', description: '禁言多少分钟（正整数，0 = 解除你自己下的禁言；不填默认 10 分钟）' },
        emotion: { type: 'string', description: '你此刻的情绪（厌恶/伤心/愤怒/烦躁），只做留档' },
        reason: { type: 'string', description: '一句话说清为什么，比如「一直刷屏骂人」' }
      },
      required: ['target']
    },
    async execute(ctx, args) {
      return executeMute(ctx, args, { trackDirectWrite });
    }
  }];
}

/** 仅供测试：清空进程内状态与落盘文件。 */
export function resetMuteStateForTest() {
  stateCache = null;
  try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ }
}

export { configOf as normalizeMuteConfig };
