// 入站撤回同步：群/私聊的 recall notice 不再只是“没反应”。
// 目标：待处理的消息不再唤醒模型；已存档的正文改成占位、清空媒体与引用，
// 后续提示词与工具最多只看到“消息已撤回”。
import { noticeStamp } from './notice-dedup.js';
import { getConfig } from '../core/config.js';

const RECALLED_TEXT = '[消息已撤回]';
// recall notice 早于消息入库（协议端乱序）：先记账，等消息落库后立刻补一次撤回。
const PENDING_RECALL_TTL = 10 * 60 * 1000;
const MAX_PENDING_RECALLS = 1000;
const pendingRecalls = new Map();
const pendingKey = (chatKey, mid) => `${chatKey}\u0000${String(mid)}`;

function rememberPendingRecall(chatKey, mid, at = Date.now()) {
  for (const [key, time] of pendingRecalls) {
    if (at - time <= PENDING_RECALL_TTL) break;
    pendingRecalls.delete(key);
  }
  if (pendingRecalls.size >= MAX_PENDING_RECALLS) {
    const oldest = pendingRecalls.keys().next().value;
    if (oldest !== undefined) pendingRecalls.delete(oldest);
  }
  pendingRecalls.set(pendingKey(chatKey, mid), at);
}

/** 消息入库后调用：如果撤回通知先到，就地把这条新消息改成撤回占位。 */
export function applyPendingRecall(store, chatKey, mid, { emit = () => {}, log = () => {}, onRecalled = null } = {}) {
  const emitFn = typeof emit === 'function' ? emit : () => {};
  const logFn = typeof log === 'function' ? log : () => {};
  const onRecalledFn = typeof onRecalled === 'function' ? onRecalled : null;
  const key = pendingKey(chatKey, mid);
  const at = pendingRecalls.get(key);
  if (!at) return false;
  pendingRecalls.delete(key);
  if (Date.now() - at > PENDING_RECALL_TTL) return false;
  const changed = markRecalled(store, chatKey, mid);
  if (!changed) return false;
  try { emitFn('chat-update', chatKey); } catch { /* 刷新失败不影响撤回 */ }
  try { emitFn('message-recalled', { chatKey, id: changed.id, mid: changed.mid }); } catch { /* 同上 */ }
  if (onRecalledFn) { try { void Promise.resolve(onRecalledFn(chatKey, changed.mid)).catch(() => {}); } catch { /* 同步抛错也不影响撤回 */ } }
  logFn(`[recall] ${chatKey} 消息 ${mid} 的撤回通知先到，入库后已补标（原状态 ${changed.previousState}）`);
  return true;
}

/** 测试辅助：清空进程内待补撤回队列。 */
export function resetPendingRecalls() {
  pendingRecalls.clear();
}

function chatKeyOf(event) {
  if (event?.notice_type === 'group_recall' && event.group_id != null) {
    return `group:${event.group_id}`;
  }
  if (event?.notice_type === 'friend_recall' && event.user_id != null) {
    return `private:${event.user_id}`;
  }
  return '';
}

export function recallNoticeKey(chatKey, event) {
  const mid = event?.message_id ?? '';
  const operator = event?.operator_id ?? event?.user_id ?? '';
  return `recall:${chatKey}:${mid}:${operator}:`
    + noticeStamp(event, [event?.notice_type, mid, operator, event?.group_id, event?.user_id]);
}

/**
 * 按平台 mid 把消息改为撤回占位。
 * - pending：标已读，避免下一轮被领取；
 * - deferred：收口为 acked，防止富化任务稍后把原文写回；
 * - leased：不改 state（否则 ackLease 失效），只清正文/媒体；
 * - acked：只改存档。
 */
export function markRecalled(store, chatKey, mid) {
  if (!store || typeof store.findByMid !== 'function' || typeof store.db?.prepare !== 'function') return null;
  const row = store.findByMid(chatKey, mid);
  if (!row) return null;
  store.db.prepare(`UPDATE messages SET text=?, reply=NULL, media='[]', event_kind='recalled'
    WHERE chat_key=? AND id=?`).run(RECALLED_TEXT, chatKey, row.id);
  if (row.state === 'pending') {
    try { store.markRead(chatKey, [row.id]); } catch { /* 标记失败不影响占位已落库 */ }
  } else if (row.state === 'deferred') {
    try { store.finalizeDeferred(chatKey, row.id, { state: 'acked' }); } catch { /* 同上 */ }
  }
  return { id: row.id, mid: String(mid), previousState: row.state };
}

/**
 * 处理一条 recall notice。返回 true 表示事件已处理（即使没找到消息），
 * 调用方应停止后续 notice 分发。
 */
export function handleRecallNotice(event, { store, emit = () => {}, log = () => {}, dedup = null, onRecalled = null } = {}) {
  if (getConfig().conversation?.recallSyncEnabled === false) return false;
  const emitEvent = emit;
  const onRecalledFn = typeof onRecalled === 'function' ? onRecalled : null;
  const chatKey = chatKeyOf(event);
  const mid = event?.message_id;
  if (!chatKey || mid == null || String(mid) === '') return false;
  if (dedup?.alreadySeen?.(recallNoticeKey(chatKey, event))) return true;
  const changed = markRecalled(store, chatKey, mid);
  if (!changed) {
    rememberPendingRecall(chatKey, mid);
    log(`[recall] ${chatKey} 消息 ${mid} 尚未入库，已登记；入库后立即标记撤回`);
    return true;
  }
  try { emitEvent('chat-update', chatKey); } catch { /* 刷新失败不影响撤回 */ }
  try { emitEvent('message-recalled', { chatKey, id: changed.id, mid: changed.mid }); } catch { /* 同上 */ }
  if (onRecalledFn) { try { void Promise.resolve(onRecalledFn(chatKey, changed.mid)).catch(() => {}); } catch { /* 同步抛错也不影响撤回 */ } }
  log(`[recall] ${chatKey} 消息 ${mid} 已标记撤回（原状态 ${changed.previousState}）`);
  return true;
}
