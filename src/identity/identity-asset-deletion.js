// 人物资产删除的 SQL 收口（独立模块：identity-store.js 受 test/src-size.test.mjs 的行数基线约束）。
// 删除人物 = 落墓碑 + 取消未了结的好友请求/待评审机会；已有 allow.private 保留（删人物 ≠ 拉黑）。

/** 该 QQ 是否已被控制台删除（墓碑）。所有自动加白/重建路径都要先问它。 */
export function isIdentityAssetDeleted(db, uin) {
  const row = db.prepare(
    'SELECT deleted FROM identity_asset_overrides WHERE uin=?'
  ).get(uin);
  return Number(row?.deleted) === 1;
}

/** 老库升级：cancel_reason 是后加的列，建表后补一次。 */
export function ensureCancelReasonColumn(db) {
  const columns = db.prepare('PRAGMA table_info(incoming_friend_requests)').all();
  if (columns.some((column) => column.name === 'cancel_reason')) return;
  db.exec("ALTER TABLE incoming_friend_requests ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT ''");
}

/** 在删除人物的同一事务里调用：把 pending/deciding/approved/accepted/held_unknown/failed
 *  的入站请求和 queued/reviewing 的机会标成 cancelled，保留行用于审计与冷却。 */
export function cancelOpenFriendArtifacts(db, uin, now = Date.now()) {
  db.prepare(`
    UPDATE incoming_friend_requests
    SET status='cancelled', cancel_reason='person-deleted', updated_at=?
    WHERE uin=? AND status IN (
      'pending','deciding','approved','accepted','held_unknown','failed'
    )
  `).run(now, uin);
  db.prepare(`
    UPDATE friend_opportunities
    SET status='cancelled', reason='person-deleted',
      completed_at=CASE WHEN completed_at=0 THEN ? ELSE completed_at END,
      updated_at=?
    WHERE uin=? AND status IN ('queued','reviewing')
  `).run(now, now, uin);
}
