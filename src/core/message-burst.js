// 同一发送者连续消息的分组与直接互动合并窗口。
// 只做纯函数，避免把逻辑塞进已经到行数上限的 orchestrator/store。
const MAX_DIRECT_WAIT_MS = 2000;

function senderOf(entry) {
  return String(entry?.senderId || '').trim();
}

/**
 * 按发送者把**连续**消息分组；中间有人插话就断开。
 * 同一发送者的相邻两条时间差超过 maxGapMs 也断开（默认 60 秒，覆盖一个批次内的连发）。
 */
export function groupMessageBursts(entries = [], { maxGapMs = 60_000 } = {}) {
  const groups = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const senderId = senderOf(entry);
    const ts = Number(entry.ts) || 0;
    const last = groups[groups.length - 1];
    const prev = last?.entries[last.entries.length - 1];
    const prevTs = Number(prev?.ts) || 0;
    const gap = ts && prevTs ? ts - prevTs : 0;
    const same = Boolean(last && senderId && senderId === last.senderId
      && gap >= 0 && gap <= Math.max(0, Number(maxGapMs) || 0));
    if (same) last.entries.push(entry);
    else groups.push({ senderId, entries: [entry] });
  }
  return groups;
}

/** 这批里有没有同一发送者的连续消息。 */
export function hasBurst(entries = []) {
  return groupMessageBursts(entries).some((group) => group.entries.length >= 2);
}

/** 给会话/决策解释用的轻量摘要，不携带正文。 */
export function burstMeta(entries = []) {
  const groups = groupMessageBursts(entries).filter((group) => group.entries.length >= 2);
  return {
    burstGroups: groups.length,
    burstMessages: groups.reduce((total, group) => total + group.entries.length, 0),
    burstSenders: groups.map((group) => group.senderId).filter(Boolean).slice(0, 8)
  };
}

/**
 * 直接互动（@/引用/拍一拍/私聊）的合并窗口。
 * 群聊在 300ms 内连发很容易被拆成两轮，因此单独给 1200ms；私聊保持原来的快速首响。
 */
export function directWakeDelayFor(chatKey, cfg = {}) {
  const group = String(chatKey || '').startsWith('group:');
  const burstEnabled = cfg?.conversation?.burstMergeEnabled !== false;
  const key = group && burstEnabled ? 'burstMergeDelayMs' : 'directWakeDelayMs';
  const fallback = group && burstEnabled ? 1200 : 300;
  const value = Number(cfg?.[key]);
  return Math.max(0, Math.min(MAX_DIRECT_WAIT_MS, Number.isFinite(value) ? value : fallback));
}
