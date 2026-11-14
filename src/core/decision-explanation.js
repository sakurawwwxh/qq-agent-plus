// 回复决策快照 + 有界持久化。
// 目的：控制台能回答“这轮为什么回/不回”，而不是只有一条内存里的百分比。
import fs from 'node:fs';
import path from 'node:path';
import { burstMeta } from './message-burst.js';

function count(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function idsOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => entry?.id)
    .filter((id) => id !== null && id !== undefined)
    .slice(0, 20);
}

/** 生成稳定、可 JSON 落盘的决策快照；不保存消息正文。 */
export function buildDecisionSnapshot({
  chatKey,
  tierResult = {},
  pendingEntries = [],
  cfg = {},
  budget = null,
  selfId = '',
  conversationMode = '',
  outcome = 'skipped',
  roll = undefined,
  now = Date.now()
} = {}) {
  const entries = Array.isArray(pendingEntries) ? pendingEntries : [];
  const reason = String(tierResult.reason || '未触发');
  const self = String(selfId || '');
  const burst = burstMeta(entries);
  return {
    at: now,
    chatKey: String(chatKey || ''),
    outcome,
    shouldRespond: tierResult.shouldRespond === true,
    tier: count(tierResult.tier),
    reason,
    percent: count(cfg?.store?.randomPercent, 0),
    roll: roll === undefined
      ? (tierResult.roll === undefined ? null : count(tierResult.roll))
      : count(roll),
    pendingCount: entries.length,
    messageIds: idsOf(entries),
    hits: {
      atMe: entries.some((entry) => entry?.mentionsSelf === true),
      pokeMe: entries.some((entry) => entry?.eventKind === 'poke'
        && String(entry?.targetUserId || '') === self),
      replyToMe: entries.some((entry) => self && String(entry?.reply?.senderId || '') === self),
      keyword: /关键词/.test(reason),
      probability: /随机|概率/.test(reason)
    },
    budget: budget && typeof budget === 'object' ? {
      enabled: budget.enabled === true,
      exceeded: budget.exceeded === true,
      onExceed: String(budget.onExceed || ''),
      spentYuan: count(budget.spentYuan),
      limitYuan: count(budget.limitYuan)
    } : null,
    conversationMode: String(conversationMode || ''),
    contextCount: count(tierResult.count),
    burst
  };
}

/**
 * 最近决策的环形日志：整体最多 limit 条，每个会话最多 perChat 条。
 * 落盘失败只记日志，不影响聊天主链路。
 */
export function createDecisionLog({ file, limit = 500, perChat = 20, log = console } = {}) {
  const max = Math.max(1, Number(limit) || 500);
  const chatMax = Math.max(1, Number(perChat) || 20);
  let items = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw?.items)) {
      items = raw.items.filter((item) => item && item.chatKey && item.at).slice(-max);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log.warn?.('[decision-log] 读取失败，按空日志继续：', error?.message ?? error);
  }

  const persist = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      log.warn?.('[decision-log] 写入失败：', error?.message ?? error);
    }
  };

  return {
    set(chatKey, decision) {
      const key = String(chatKey || '');
      if (!key || !decision) return decision || null;
      const entry = { ...decision, chatKey: key };
      items.push(entry);
      let seen = 0;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i]?.chatKey !== key) continue;
        seen += 1;
        if (seen > chatMax) items.splice(i, 1);
      }
      while (items.length > max) items.shift();
      persist();
      return entry;
    },
    get(chatKey) {
      const key = String(chatKey || '');
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i]?.chatKey === key) return items[i];
      }
      return null;
    },
    list(chatKey, n = chatMax) {
      const key = String(chatKey || '');
      return items.filter((item) => item.chatKey === key).slice(-Math.max(1, Number(n) || chatMax)).reverse();
    },
    delete(chatKey) {
      const key = String(chatKey || '');
      const before = items.length;
      items = items.filter((item) => item.chatKey !== key);
      if (items.length !== before) persist();
    },
    get size() { return items.length; }
  };
}
