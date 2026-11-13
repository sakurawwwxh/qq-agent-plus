// 群管理动作的授权判定（从 tools-core.js 拆出：文件行数基线只允许变小）。
// 关键不变量：授权只看管理员**自己键入**的正文，引用/转发/卡片里的原文一律不算命令。
import { getConfig } from '../core/config.js';
import { idList } from '../core/list.js';

const MODERATION_ACTION = {
  set_group_ban: 'ban',
  kick_group_member: 'kick',
  recall_message: 'recall',
  set_group_admin: 'admin'
};

/** 去掉引用块/合并转发/卡片块（可能嵌套方括号），只留下发送者自己写的字。 */
export function authoredText(value) {
  const text = String(value ?? '');
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] !== '[' || !/^\[(引用|合并转发|卡片|文件)/.test(text.slice(i, i + 12))) {
      out += text[i++];
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      if (text[j] === '[') depth += 1;
      else if (text[j] === ']' && --depth === 0) break;
    }
    i = j < text.length ? j + 1 : text.length;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 只认批次里**最后一条**管理员自己写的发言，且这条发言要真的在说对应的管理动作。
 * 群友先起哄、管理员随后回一句“收到”不能当成授权。
 */
export function adminRequest(ctx, actionPatterns = []) {
  const owner = String(getConfig().admin?.ownerUin || '').trim();
  if (!/^\d{5,15}$/.test(owner)) return { ok: false, reason: '未配置全局管理员，群管理动作不可用' };
  const entries = (ctx.triggerEntries || []).filter((entry) => !entry?.self);
  const last = entries[entries.length - 1];
  if (!last || String(last?.senderId || '') !== owner) {
    return { ok: false, reason: '群管理动作只能由全局管理员在群里明确要求时执行' };
  }
  const text = authoredText(last?.text);
  if (actionPatterns.length && !actionPatterns.some((re) => re.test(text))) {
    return { ok: false, reason: '管理员这条消息里没有明确的管理指令' };
  }
  return { ok: true, owner };
}

/** 每次执行工具时重读配置：运行中关闭开关必须立即生效，不能等这一轮结束。 */
export function moderationToolAllowed(name, ctx) {
  const action = MODERATION_ACTION[name];
  if (!action) return '';
  const mod = getConfig().moderation || {};
  if (mod.enabled === false) return '群管理已关闭';
  if (mod.actions?.[action] === false) return '这个群管理动作已被管理员关闭';
  const groups = idList(mod.groups);
  if (groups.length && !groups.includes(String(ctx?.chatId || ''))) return '本群没有开启群管理';
  return '';
}
