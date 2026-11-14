import { getConfig } from './config.js';

/**
 * 屏蔽名单兜底过滤：屏蔽生效前已存档的历史消息，也不能再进模型或工具结果。
 * 入口拦截只管"新消息"，这里管"老库存"。机器人自己的发言（self）不过滤。
 * 跨会话共享时按消息自己的群号取名单，不能只按当前会话过滤 —— 提示词与
 * get_recent_messages 必须同一口径，否则翻页能绕过提示词里的过滤。
 */
export function filterBlockedHistory(messages, chatKey, { crossScope = false } = {}) {
  const [kind, id] = String(chatKey || '').split(':');
  if (crossScope) {
    const blockedSets = new Map(Object.entries(getConfig().blocklist || {})
      .map(([group, list]) => [String(group), new Set((Array.isArray(list) ? list : []).map(String))]));
    return messages.filter((m) => {
      if (m.self) return true;
      const [mKind, groupId] = String(m.chatKey || '').split(':');
      if (mKind !== 'group' || !groupId) return true;
      return !blockedSets.get(String(groupId))?.has(String(m.senderId));
    });
  }
  if (kind === 'group' && id) {
    const blocked = new Set((getConfig().blocklist?.[id] || []).map(String));
    if (blocked.size) return messages.filter((m) => m.self || !blocked.has(String(m.senderId)));
  }
  return messages;
}

/** 当前配置下这个发送者是否被屏蔽（只对群聊生效；self 永远放行）。 */
export function isBlockedSender(chatKey, senderId) {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id || !senderId) return false;
  return (getConfig().blocklist?.[id] || []).map(String).includes(String(senderId));
}

/**
 * 把"屏蔽前已入库、还没被领取"的消息直接标成已读。
 * 只在 #wake 前调用：不带这一步时，claimUnread 会把屏蔽生效前入队的 pending 消息
 * 原样领进本轮 prompt，等于屏蔽只对新消息生效。
 */
export function purgeBlockedPending(store, chatKey) {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id || typeof store?.db?.prepare !== 'function') return 0;
  const blocked = [...new Set((getConfig().blocklist?.[id] || []).map(String).filter(Boolean))];
  if (!blocked.length) return 0;
  const marks = blocked.map(() => '?').join(',');
  return Number(store.db.prepare(`UPDATE messages SET state='acked', lease_id=NULL
    WHERE chat_key=? AND state='pending' AND sender_id IN (${marks})`)
    .run(chatKey, ...blocked).changes) || 0;
}
