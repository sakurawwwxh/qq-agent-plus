// 副作用账本改判后的 outbox 同步（CLI `ops effects resolve` 用）。
//
// 只处理 unknown：sending 仍在本进程发送队列里，提前改终态会让 finishSend 找不到行、
// hasUncertainEffects 失去证据，最终可能重复发送。控制台的核对接口同样是这个口径。
export function reconcileEffectOutbox(db, effectId, result) {
  const rows = db.prepare(`SELECT id, run_id AS runId, chat_key AS chatKey FROM outbox
    WHERE run_id=? AND state='unknown'`).all(String(effectId));
  if (!rows.length) return 0;
  const state = result === 'sent' ? 'reconciled_sent' : 'reconciled_failed';
  const error = result === 'sent' ? '管理员确认已发送' : '管理员确认未发送';
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('UPDATE outbox SET state=?, error=? WHERE id=?');
    for (const row of rows) changed += Number(update.run(state, error, row.id).changes) || 0;
    const groups = new Map();
    for (const row of rows) groups.set(`${row.chatKey}\n${row.runId}`, row);
    for (const row of groups.values()) {
      // sending 仍算未决：这时不能释放 held，等它正常记账/降级为 unknown 后再说。
      const remaining = Number(db.prepare(`SELECT COUNT(*) AS count FROM outbox
        WHERE run_id=? AND state IN ('sending','unknown')`).get(row.runId).count) || 0;
      if (remaining !== 0) continue;
      db.prepare(`UPDATE messages SET state='acked', lease_id=NULL
        WHERE chat_key=? AND state='held' AND lease_id=?`).run(row.chatKey, row.runId);
      db.prepare(`UPDATE runs SET state='acked', error=? WHERE id=? AND state='held'`)
        .run('管理员已核对全部未知写入', row.runId);
      db.prepare(`DELETE FROM outbox WHERE run_id=? AND state IN ('reconciled_sent','reconciled_failed')`)
        .run(row.runId);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw error;
  }
  return changed;
}
