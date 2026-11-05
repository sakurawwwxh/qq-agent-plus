// unknown 外发的核对、批量核对与自动释放。
//
// store.js 只保留薄封装：这里既守住单文件行数闸门，也让单条核对、控制台批量核对和
// 恢复循环的“超期自动释放”共用同一套收尾口径（改一个 run 的 held、清终态行）。
// 所有写操作都通过 store 传入的事务函数执行，调用方决定事务边界。

function normalizeReason(result, fallback) {
  if (fallback) return fallback;
  return result === 'sent' ? '管理员确认已发送' : '管理员确认未发送';
}

function reconcileOne(db, operationId, result, reason) {
  // 只允许核对真正的 unknown：sending 仍在本进程发送队列里，提前改终态会让
  // finishSend 找不到行、hasUncertainEffects 失去证据，最终可能重复发送。
  const row = db.prepare(`SELECT id, run_id AS runId, chat_key AS chatKey
    FROM outbox WHERE id=? AND state='unknown'`).get(String(operationId || ''));
  if (!row) return null;
  db.prepare('UPDATE outbox SET state=?, error=? WHERE id=?').run(
    result === 'sent' ? 'reconciled_sent' : 'reconciled_failed',
    normalizeReason(result, reason),
    row.id
  );
  const remaining = Number(db.prepare(`SELECT COUNT(*) AS count FROM outbox
    WHERE run_id=? AND state IN ('sending','unknown')`).get(row.runId).count) || 0;
  if (remaining === 0) {
    // 按 run 释放 held：held 行的 lease_id 记的就是产生它的那个 run（见 failLease）。
    // 此前按 error 文本匹配，而租约过期产生的 held 文本是 'Lease expired or process
    // interrupted'，永远匹配不上 —— 于是逐条核对不会释放它，held 计数一直挂着，
    // 开了 unknownWritesBlockChat 的群会一直卡住。
    db.prepare(`UPDATE messages SET state='acked', lease_id=NULL
      WHERE chat_key=? AND state='held' AND lease_id=?`).run(row.chatKey, row.runId);
    db.prepare(`UPDATE runs SET state='acked', error=? WHERE id=? AND state='held'`)
      .run('管理员已核对全部未知写入', row.runId);
    // 这条路径不走 ackLease，已核对的终态行要在这里清掉，否则会长期累积。
    db.prepare(`DELETE FROM outbox
      WHERE run_id=? AND state IN ('reconciled_sent','reconciled_failed')`).run(row.runId);
  }
  return {
    operationId: row.id,
    runId: row.runId,
    chatKey: row.chatKey,
    result,
    remaining
  };
}

export function listUnknownOperations(db, chatKey, limit = 100, {
  includeSending = false, olderThanMs = 0
} = {}) {
  // 默认只列真正的 unknown：sending 仍在发送队列里，核对接口会拒绝它，
  // 列给控制台只会得到一排必然 404 的按钮。内部需要"在途证据"时显式 includeSending。
  const states = includeSending ? "IN ('sending','unknown')" : "= 'unknown'";
  const cutoff = Number(olderThanMs) > 0 ? Date.now() - Number(olderThanMs) : 0;
  const rows = db.prepare(`SELECT id, run_id AS runId, chat_key AS chatKey,
    state, payload, message_id AS messageId, error,
    created_at AS createdAt
    FROM outbox WHERE chat_key=? AND state ${states}
    ${cutoff ? 'AND created_at < ?' : ''}
    ORDER BY rowid DESC LIMIT ?`).all(
    String(chatKey || ''),
    ...(cutoff ? [cutoff] : []),
    Math.min(500, Math.max(1, Number(limit) || 100))
  ).map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
    return {
      ...row,
      payload,
      ageMs: row.createdAt ? Math.max(0, Date.now() - Number(row.createdAt)) : 0
    };
  });
  return rows;
}

/** 会话维度的 unknown 摘要：控制台标题、健康巡检和导出都看这一份口径。 */
export function unknownSummary(db, chatKey) {
  const row = db.prepare(`SELECT COUNT(*) AS total, MIN(created_at) AS oldest
    FROM outbox WHERE chat_key=? AND state='unknown'`).get(String(chatKey || ''));
  const oldestAt = Number(row?.oldest) || 0;
  return {
    total: Number(row?.total) || 0,
    oldestAt,
    oldestAgeMs: oldestAt ? Math.max(0, Date.now() - oldestAt) : 0
  };
}

/** 全局 unknown 摘要：健康巡检 / 指标页看“全站还有多少没核对、最老多久”。 */
export function unknownSummaryAll(db) {
  const row = db.prepare(`SELECT COUNT(*) AS total, MIN(created_at) AS oldest
    FROM outbox WHERE state='unknown'`).get();
  const oldestAt = Number(row?.oldest) || 0;
  return {
    total: Number(row?.total) || 0,
    oldestAt,
    oldestAgeMs: oldestAt ? Math.max(0, Date.now() - oldestAt) : 0
  };
}

/**
 * 按条件批量核对 unknown。ids 为空时对 chatKey 下所有 unknown 生效；
 * before 是时间戳上界（只核对更早的行），limit 限制单次处理量。
 */
export function reconcileUnknownRows(db, runInTransaction, {
  chatKey = '', ids = [], result, before = 0, limit = 500
} = {}) {
  if (!['sent', 'failed'].includes(result)) {
    throw new Error('未知写入核对结果必须是 sent 或 failed');
  }
  const wanted = Array.isArray(ids)
    ? [...new Set(ids.map(String).filter(Boolean))].slice(0, 500)
    : [];
  if (!chatKey && wanted.length === 0) {
    throw new Error('批量核对需要 chatKey 或至少一条记录');
  }
  const max = Math.min(500, Math.max(1, Number(limit) || 500));
  // 落到本地常量：ops scan --strict 不认解构参数里的函数名，直接调会报未定义。
  const runTx = runInTransaction;
  return runTx(() => {
    let sql = "SELECT id FROM outbox WHERE state='unknown'";
    const params = [];
    if (chatKey) { sql += ' AND chat_key=?'; params.push(String(chatKey)); }
    if (wanted.length) {
      sql += ` AND id IN (${wanted.map(() => '?').join(',')})`;
      params.push(...wanted);
    }
    if (Number(before) > 0) { sql += ' AND created_at < ?'; params.push(Number(before)); }
    sql += ' ORDER BY rowid ASC LIMIT ?';
    params.push(max);
    const rows = db.prepare(sql).all(...params);
    const operations = [];
    for (const row of rows) {
      const done = reconcileOne(db, row.id, result);
      if (done) operations.push(done);
    }
    const remaining = chatKey
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM outbox
        WHERE chat_key=? AND state IN ('sending','unknown')`).get(String(chatKey)).count) || 0
      : 0;
    return { reconciled: operations.length, operations, remaining };
  });
}

/**
 * 超过 N 天、且同会话此后再没有新的 sending/unknown 的记录，按“已发送”留痕释放。
 * 默认关闭（config.outbox.unknownAutoReleaseDays=0）。只处理 unknown，不碰 sending：
 * 在途发送仍有本进程的收发方，交给 ageStaleSending/正常记账。
 */
export function autoReleaseStaleUnknown(db, runInTransaction, days, { now = Date.now() } = {}) {
  const ageDays = Number(days);
  if (!(ageDays > 0)) return { released: 0, chats: [], operations: [] };
  const cutoff = now - ageDays * 86_400_000;
  const runTx = runInTransaction;
  return runTx(() => {
    // HAVING newest < cutoff：只有整段会话都没有更新的未知/在途记录时才动，
    // 避免把“仍在持续产生 unknown 的群”按历史行一次性清空。
    const chats = db.prepare(`SELECT chat_key AS chatKey, MAX(created_at) AS newest
      FROM outbox WHERE state IN ('sending','unknown')
      GROUP BY chat_key HAVING newest < ?`).all(cutoff).map((row) => row.chatKey);
    const operations = [];
    for (const chatKey of chats) {
      const rows = db.prepare(`SELECT id FROM outbox
        WHERE chat_key=? AND state='unknown' AND created_at < ?`).all(chatKey, cutoff);
      for (const row of rows) {
        const done = reconcileOne(
          db,
          row.id,
          'sent',
          `超过 ${ageDays} 天自动释放：未确认送达，按已发送留痕`
        );
        if (done) operations.push(done);
      }
    }
    return { released: operations.length, chats, operations };
  });
}
