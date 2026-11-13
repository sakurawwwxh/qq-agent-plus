// 按 message id 读取历史时的统一可见性闸门（从 tools-core.js 拆出守行数基线）。
// 两道规则缺一不可：game-secret 对模型永远不可见；屏蔽名单对历史消息同样生效。
import { filterBlockedHistory } from '../core/blocklist.js';

export const modelVisible = (m) => Boolean(m) && m.eventKind !== 'game-secret';

export function visibleEntry(ctx, mid) {
  const entry = ctx.store?.findByMid?.(ctx.chatKey, mid);
  return modelVisible(entry) && filterBlockedHistory([entry], ctx.chatKey).length ? entry : null;
}

/** 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。 */
export function midHint(ctx) {
  const mids = filterBlockedHistory(ctx.store.recent(ctx.chatKey, { limit: 60 }), ctx.chatKey)
    .filter(modelVisible)
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}
