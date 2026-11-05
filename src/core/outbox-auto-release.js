// 恢复循环里的 unknown 超期释放（策略默认关闭）。
//
// 单独成文件有两个原因：orchestrator.js 正卡在行数闸门上；这个策略也需要在日志里
// 说清楚“为什么自动放行”，否则运维只看到 held 消失却找不到操作者。
import { getConfig } from './config.js';
import { appendAudit } from './audit-log.js';
import { createLogger } from './logger.js';

const log = createLogger('outbox');

export function releaseStaleUnknown({ store, effects, emit } = {}) {
  // 手改 config.json 可能绕过保存期归一化：这里再收敛一次（0–90 天）。
  const days = Math.min(90, Math.max(0, Math.round(Number(getConfig().outbox?.unknownAutoReleaseDays) || 0)));
  if (!(days > 0) || typeof store?.autoReleaseStaleUnknown !== 'function') {
    return { released: 0, chats: [], operations: [] };
  }
  let result;
  try {
    result = store.autoReleaseStaleUnknown(days);
  } catch (error) {
    // 磁盘满/SQLITE_BUSY 下一轮再试，不能把 5 秒恢复循环带崩。
    log.error('[outbox] 超期未知写入自动释放失败（下一轮再试）：', error?.message ?? error);
    return { released: 0, chats: [], operations: [] };
  }
  if (!result?.released) return result;
  // 与人工核对同一口径：整个 run 的未知行都清完时，副作用账本同步改判“已发送”。
  for (const item of result.operations) {
    // 自动释放没有“操作者”，但必须留下和人工核对同粒度的审计：哪条、哪个 run、
    // 按什么策略、还剩多少。否则 outbox 终态行被清掉后只剩一句汇总日志。
    appendAudit({
      action: 'outbox.auto-release',
      target: item.chatKey,
      ok: true,
      after: {
        operationId: item.operationId,
        runId: item.runId || '',
        result: 'sent',
        remaining: item.remaining,
        policyDays: days
      }
    });
    if (!item.runId || item.remaining !== 0) continue;
    try {
      const settled = effects?.settle?.(String(item.runId), 'sent', {
        reason: 'outbox-auto-release', operationId: item.operationId, resolvedBy: 'policy'
      });
      if (!settled) {
        effects?.resolve?.(String(item.runId), 'sent', {
          reason: 'outbox-auto-release', operationId: item.operationId
        });
      }
    } catch { /* 账本改判失败不影响 outbox 释放 */ }
  }
  log.warn(`[outbox] 按策略自动释放 ${result.released} 条超过 ${days} 天的未知写入：`
    + `${result.chats.join(', ')}（按已发送留痕，不再阻塞会话）`);
  for (const chatKey of result.chats) {
    try { emit?.('chat-update', chatKey); } catch { /* 控制台刷新失败不影响释放 */ }
  }
  return result;
}
