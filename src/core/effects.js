// 出站副作用账本（docs/EFFECT-LEDGER.md 的落地实现）。
//
// 解决的是同一类问题：机器人"对外做了一件事"之后，进程崩了/超时了，到底做没做？
// 现在散落在 outbox（只覆盖发送队列）、群日报的日期标记、提醒的"有没有自述"、
// 群游戏的 pendingEnd 里，各自口径不同。账本给它们一个共同落点：
//
//   planned --发送/执行--> sent | failed | unknown
//
// 规则（写死在这里，调用方不用记）：
//   - unknown 是终态，**绝不自动重试**；要重试必须人工先核对。
//   - 同一 (kind, idemKey) 同时只能有一条；再次 begin 会返回已有状态与 action。
//   - failed 允许 begin 重置为 planned（能证明没做成的失败可以再试）。
//   - planned 超过 TTL（默认 15 分钟）自动转 unknown —— 只可能来自上一条命/崩溃。
//   - detail 只放排障需要的最小字段（目标、日期、结果码），正文按现有口径截断。
//
// 与 outbox 的分工：outbox 记"每条消息怎么发出去的"，账本记"这个业务动作成没成"。
// 需要逐条消息级别的可靠性时仍以 outbox 为准。
import crypto from 'node:crypto';

const STATES = new Set(['planned', 'sent', 'unknown', 'failed', 'skipped']);
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export class EffectLedger {
  /**
   * @param {import('node:sqlite').DatabaseSync} db 与 outbox 同一个库（messages.sqlite）
   * @param {{now?: () => number, ttlMs?: number, sweep?: boolean}} [options]
   */
  constructor(db, { now = Date.now, ttlMs = DEFAULT_TTL_MS, sweep = true } = {}) {
    if (!db) throw new Error('EffectLedger 需要数据库句柄');
    this.db = db;
    this.now = now;
    this.ttlMs = Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS);
    // 进程启动时把上一条命留下的 planned 转成 unknown：进程都换了，不可能还在执行。
    // 同时清一次过期记录（与 runs/outbox 构造时清理同口径；ledger-retention 的每日任务
    // 在"每天重启"的部署里可能永远等不到第二个自然日）。
    if (sweep) {
      // 构造只发生在进程启动：此刻**任何** planned 都属于上一条命，不可能还在执行。
      // 旧实现只清扫超过 TTL（15 分钟）的记录，重启若落在动作窗口内，旧记录会继续
      // 返回 in-flight，日报/游戏播报因此被当成"今天已完成"跳过（2026-10-31 审查 P2）。
      this.markStalePlanned({ olderThanMs: 0, minAgeMs: 0 });
      this.prune();
    }
  }

  #byKey(kind, idemKey) {
    return this.db.prepare('SELECT * FROM effects WHERE kind=? AND idem_key=?')
      .get(String(kind), String(idemKey));
  }

  #byId(id) {
    return this.db.prepare('SELECT * FROM effects WHERE id=?').get(String(id));
  }

  /**
   * 登记一次副作用。返回 { id, action, state, duplicate }：
   *   action = 'proceed'   可以执行
   *          | 'done'      已经成功过（含 skipped），不要再执行
   *          | 'review'    上次结果未知，停止自动重试，等人工核对
   *          | 'in-flight' 同一动作正在执行，跳过本次
   *   retried = true 表示这条是 failed 之后的重新尝试（沿用同一个 id）。
   */
  begin({ kind, chatKey = '', idemKey, detail = {}, ttlMs } = {}) {
    const k = String(kind || '').trim();
    const key = String(idemKey || '').trim();
    if (!k || !key) throw new Error('effect 需要 kind 与 idemKey');
    const now = this.now();
    const ttl = Math.max(60_000, Number(ttlMs) || this.ttlMs);
    let row = this.#byKey(k, key);
    if (!row) {
      const id = crypto.randomUUID();
      try {
        this.db.prepare(`INSERT INTO effects(id,kind,chat_key,idem_key,state,detail,created_at)
          VALUES (?,?,?,?,'planned',?,?)`).run(id, k, String(chatKey || ''), key, safeJson(detail), now);
        return { id, action: 'proceed', state: 'planned', duplicate: false };
      } catch (error) {
        // 唯一索引竞争：另一个调用先插入了，按已有行处理（不让异常冒到业务层）
        row = this.#byKey(k, key);
        if (!row) throw error;
      }
    }

    if (row.state === 'sent' || row.state === 'skipped') {
      return { id: row.id, action: 'done', state: row.state, duplicate: true };
    }
    if (row.state === 'unknown') {
      return { id: row.id, action: 'review', state: 'unknown', duplicate: true };
    }
    if (row.state === 'failed') {
      // 合并而不是替换：resolve 写入的 resolvedBy/resolvedAt 要留在这条记录上（审计）
      const merged = { ...parseJson(row.detail), ...(detail || {}) };
      this.db.prepare(`UPDATE effects SET state='planned', detail=?, created_at=?, settled_at=0
        WHERE id=? AND state='failed'`).run(safeJson(merged), now, row.id);
      return { id: row.id, action: 'proceed', state: 'planned', duplicate: true, retried: true };
    }
    // state === 'planned'
    if (now - Number(row.created_at) >= ttl) {
      const merged = { ...parseJson(row.detail), staleReason: 'planned-exceeded-ttl' };
      this.db.prepare("UPDATE effects SET state='unknown', detail=?, settled_at=? WHERE id=? AND state='planned'")
        .run(safeJson(merged), now, row.id);
      return { id: row.id, action: 'review', state: 'unknown', duplicate: true };
    }
    return { id: row.id, action: 'in-flight', state: 'planned', duplicate: true };
  }

  /**
   * 结算。只允许 planned → 终态；重复 settle 同一状态幂等返回 true。
   * 已经 unknown 的记录不允许被后续轮次改成 sent（那是另一条命的事，人工核对）。
   */
  settle(id, state, detail = {}) {
    const next = String(state || '');
    if (!STATES.has(next) || next === 'planned') throw new Error(`无效的 effect 状态: ${next}`);
    const row = this.#byId(id);
    if (!row) return false;
    if (row.state === next) return true;
    if (row.state !== 'planned') return false;
    const merged = { ...parseJson(row.detail), ...(detail && typeof detail === 'object' ? detail : {}) };
    const result = this.db.prepare(`UPDATE effects SET state=?, detail=?, settled_at=?
      WHERE id=? AND state='planned'`).run(next, safeJson(merged), this.now(), String(id));
    return Number(result.changes) > 0;
  }

  /**
   * 人工核对后改判：只允许 unknown → sent/failed（写 resolvedAt/resolvedBy 便于追责）。
   * 用于"确实没发出去，想当天重试"或"确认已经发出"的场景；不提供把 sent 改回 planned。
   */
  resolve(id, state, detail = {}) {
    const next = String(state || '');
    if (next !== 'sent' && next !== 'failed') throw new Error(`resolve 只接受 sent|failed: ${next}`);
    const row = this.#byId(id);
    if (!row || row.state !== 'unknown') return false;
    const merged = { ...parseJson(row.detail), ...(detail || {}), resolvedAt: this.now(), resolvedBy: 'manual' };
    const result = this.db.prepare(`UPDATE effects SET state=?, detail=?, settled_at=?
      WHERE id=? AND state='unknown'`).run(next, safeJson(merged), this.now(), String(id));
    return Number(result.changes) > 0;
  }

  get(kind, idemKey) {
    const row = this.#byKey(kind, idemKey);
    if (!row) return null;
    return { ...row, detail: parseJson(row.detail) };
  }

  /** 列表（控制台/ops 排障用）：默认最近 50 条，可按状态过滤。 */
  list({ state = '', limit = 50 } = {}) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = state
      ? this.db.prepare('SELECT * FROM effects WHERE state=? ORDER BY created_at DESC LIMIT ?').all(String(state), n)
      : this.db.prepare('SELECT * FROM effects ORDER BY created_at DESC LIMIT ?').all(n);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      chatKey: row.chat_key,
      state: row.state,
      detail: parseJson(row.detail),
      createdAt: Number(row.created_at) || 0,
      settledAt: Number(row.settled_at) || 0
    }));
  }

  /**
   * 启动清理：把超过 TTL 仍停在 planned 的记录标成 unknown（上一条命崩溃留下的）。
   * @returns {number} 转成 unknown 的条数
   */
  markStalePlanned({ olderThanMs = this.ttlMs, minAgeMs = 60_000 } = {}) {
    const now = this.now();
    // minAgeMs 是"运行期批量清扫"的下限（避免把刚写入的当陈旧）；启动清扫显式传 0。
    const cutoff = now - Math.max(0, Number(minAgeMs) || 0, Number(olderThanMs) || 0);
    // 不用 SQL 的 json_set：不同发行版/构建的 SQLite JSON1 支持不一，逐行在 JS 里合并更稳。
    const rows = this.db.prepare("SELECT id, detail FROM effects WHERE state='planned' AND created_at < ?")
      .all(cutoff);
    if (!rows.length) return 0;
    const update = this.db.prepare("UPDATE effects SET state='unknown', detail=?, settled_at=? WHERE id=? AND state='planned'");
    let changed = 0;
    for (const row of rows) {
      const merged = { ...parseJson(row.detail), staleReason: 'process-restart' };
      changed += Number(update.run(safeJson(merged), now, row.id).changes) || 0;
    }
    return changed;
  }

  /** 保留期清理：只删已结算的旧记录，planned/unknown 永不自动删。 */
  prune(retentionDays = DEFAULT_RETENTION_DAYS) {
    const days = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    const result = this.db.prepare(`DELETE FROM effects
      WHERE state IN ('sent','failed','skipped') AND settled_at > 0 AND settled_at < ?`).run(cutoff);
    return Number(result.changes) || 0;
  }

  /** 控制台 / 诊断包用：低基数计数。 */
  stats({ unknownWithinMs = 24 * 60 * 60 * 1000 } = {}) {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM effects GROUP BY state').all();
    const byState = { planned: 0, sent: 0, unknown: 0, failed: 0, skipped: 0 };
    let total = 0;
    for (const row of rows) {
      const state = String(row?.state || '');
      const n = Number(row.n) || 0;
      byState[state] = n;
      total += n;
    }
    const since = this.now() - Math.max(0, Number(unknownWithinMs) || 0);
    // 按 created_at 过滤（effects_state_created 索引正好覆盖）；unknown 的 settled_at
    // 是"转成 unknown 的时刻"，与 created_at 通常只差几分钟。
    const unknownRecent = Number(this.db.prepare(
      "SELECT COUNT(*) AS n FROM effects WHERE state='unknown' AND created_at >= ?"
    ).get(since)?.n) || 0;
    return { total, byState, unknownRecent };
  }
}

export const EFFECT_STATES = [...STATES];
