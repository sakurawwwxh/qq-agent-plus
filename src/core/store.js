import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase } from './sqlite.js';
import { DATA_DIR } from './config.js';
import { safeSlice } from './util.js';

function entry(row) {
  if (!row) return null;
  let reply = null;
  // reply 是历史里写入的 JSON 文本：一行坏数据不应该让整个会话读取抛错（threadEntry 同款护栏）
  if (row.reply) { try { reply = JSON.parse(row.reply); } catch { reply = null; } }
  return {
    ...row, chatKey: String(row.chat_key || ''), senderId: row.sender_id, senderName: row.sender_name,
    self: !!row.self, read: row.state === 'acked',
    reply,
    media: JSON.parse(row.media || '[]'),
    mentionsSelf: Boolean(row.mentions_self),
    targetUserId: String(row.target_user_id || ''),
    eventKind: String(row.event_kind || 'message')
  };
}

function threadEntry(row) {
  if (!row) return null;
  let participantIds = [];
  try {
    participantIds = JSON.parse(row.participant_ids || '[]').map(String);
  } catch { /* keep empty */ }
  return {
    chatKey: row.chat_key,
    threadId: row.thread_id,
    mode: row.mode || 'threaded',
    state: row.state,
    disposition: row.disposition || 'active',
    topic: row.topic || '',
    participantIds,
    openedAt: Number(row.opened_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    lastHumanAt: Number(row.last_human_at) || 0,
    lastAgentAt: Number(row.last_agent_at) || 0,
    engagedUntil: Number(row.engaged_until) || 0,
    idleDeadline: Number(row.idle_deadline) || 0,
    hardDeadline: Number(row.hard_deadline) || 0,
    resumeArmedUntil: Number(row.resume_armed_until) || 0,
    expiresAt: Number(row.expires_at) || 0,
    lastMessageId: Number(row.last_message_id) || 0,
    promptHash: row.prompt_hash || '',
    transcriptChars: Number(row.transcript_chars) || 0,
    promptTokens: Number(row.prompt_tokens) || 0,
    version: Number(row.version) || 1,
    closeReason: row.close_reason || ''
  };
}

function ensureColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((column) => column.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

// 模型常把提示词里的 "#123" 连 # 一起传进来；消息 id 本身只可能是数字（可为负）。
function normalizeMid(value) {
  return String(value ?? '').trim().replace(/^(?:#+|collected_)+/, '').trim();
}

// WAL 下 synchronous=NORMAL 仍然保证崩溃一致性，只是掉电可能丢最近几条提交；
// 默认 FULL 保持原口径，磁盘 IOPS 紧张时由 store.sqliteSynchronous 切到 NORMAL（Issue #45）。
function normalizeSynchronous(value) {
  return String(value || '').toUpperCase() === 'NORMAL' ? 'NORMAL' : 'FULL';
}

export class ChatStore {
  constructor(maxPerChat = 0, { dataDir = DATA_DIR, filename, synchronous = 'FULL' } = {}) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.transactionDepth = 0;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // filename 只用于测试隔离：给相对名时按 dataDir 解析，避免落到进程 CWD（2026-09-28 踩过：
    // 相对名把测试库建进了仓库根目录，残留文件让后续运行读到旧行、排查绕了一大圈）。
    this.db = openDatabase(
      filename
        ? (path.isAbsolute(filename) ? filename : path.join(dataDir, filename))
        : path.join(dataDir, 'messages.sqlite')
    );
    // journal_mode/synchronous 是本库既有持久化口径（WAL 会产生 -wal/-shm，manage.sh backup
    // 对本库走一致性快照）；busy_timeout/foreign_keys 由 core/sqlite.js 统一设置
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=${normalizeSynchronous(synchronous)};
      CREATE TABLE IF NOT EXISTS chats (chat_key TEXT PRIMARY KEY, next_id INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS messages (
        chat_key TEXT NOT NULL, id INTEGER NOT NULL, mid TEXT, ts INTEGER NOT NULL,
        sender_id TEXT, sender_name TEXT, text TEXT NOT NULL, self INTEGER NOT NULL DEFAULT 0,
        reply TEXT, media TEXT NOT NULL DEFAULT '[]',
        mentions_self INTEGER NOT NULL DEFAULT 0,
        target_user_id TEXT NOT NULL DEFAULT '',
        event_kind TEXT NOT NULL DEFAULT 'message',
        state TEXT NOT NULL DEFAULT 'pending', lease_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0, error TEXT,
        deferred_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chat_key, id), UNIQUE (chat_key, mid)
      );
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(chat_key, state, available_at, id);
      -- getChatMeta 在每条入站消息和 5 秒 tick 上都会跑；failed/held 用更窄的 partial
      -- 索引，避免每次计数都扫整段会话历史。
      CREATE INDEX IF NOT EXISTS messages_failed ON messages(chat_key) WHERE state='failed';
      CREATE INDEX IF NOT EXISTS messages_held ON messages(chat_key) WHERE state='held';
      -- getChatMeta 取"最新一条"按 ts 排序（历史导入的 ts 可能乱序）；没有这个索引
      -- 时 SQLite 要对整个会话做临时排序。
      CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_key, ts DESC, id DESC);
      -- 成员表/@昵称解析按 sender 取最新一条；没有它会在会话历史里反复求 MAX(id)。
      CREATE INDEX IF NOT EXISTS messages_member_latest ON messages(chat_key, sender_id, id DESC) WHERE self=0;
      -- 群聊/私聊共用上下文按 ts 跨会话取最新 N 条；不加这条会每次唤醒全表扫描 + 排序
      -- （messages_chat_ts 以 chat_key 开头，跨会话的 ORDER BY ts 用不上）。
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts DESC, id DESC);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, state TEXT NOT NULL,
        expires_at INTEGER NOT NULL, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_lease_per_chat ON runs(chat_key) WHERE state='leased';
      -- 5 秒一次的 recoverExpired 全表扫（state='leased' AND expires_at<=?）：没有这个索引
      -- 时随 runs 行数线性变慢，而 runs 是全仓唯一没有回收纪律的账本（2026-10-07 复审）。
      CREATE INDEX IF NOT EXISTS runs_leased_expiry ON runs(state, expires_at);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, run_id TEXT, chat_key TEXT NOT NULL,
        state TEXT NOT NULL, payload TEXT NOT NULL, message_id TEXT, error TEXT,
        created_at INTEGER NOT NULL DEFAULT 0
      );
      -- getChatMeta 每 5 秒扫 outbox(chat_key,state)；没有索引会随历史行线性变慢。
      CREATE INDEX IF NOT EXISTS outbox_chat_state ON outbox(chat_key, state);
      -- held 自动释放按 run_id 查这批外发是否已终结；没有它每个 held 批次都扫全表。
      CREATE INDEX IF NOT EXISTS outbox_run_state ON outbox(run_id, state);
      CREATE TABLE IF NOT EXISTS conversation_threads (
        chat_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'threaded', state TEXT NOT NULL,
        disposition TEXT NOT NULL DEFAULT 'active',
        topic TEXT NOT NULL DEFAULT '', participant_ids TEXT NOT NULL DEFAULT '[]',
        opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_human_at INTEGER NOT NULL DEFAULT 0, last_agent_at INTEGER NOT NULL DEFAULT 0,
        engaged_until INTEGER NOT NULL DEFAULT 0, idle_deadline INTEGER NOT NULL DEFAULT 0,
        hard_deadline INTEGER NOT NULL DEFAULT 0, resume_armed_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
        prompt_hash TEXT NOT NULL DEFAULT '', transcript_chars INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        close_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS conversation_threads_expiry
        ON conversation_threads(state, expires_at);
      CREATE TABLE IF NOT EXISTS thread_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        chat_key TEXT NOT NULL, run_id TEXT, version INTEGER NOT NULL,
        state_json TEXT NOT NULL, source_message_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_checkpoints_lookup
        ON thread_checkpoints(chat_key, thread_id, version DESC);
      CREATE TABLE IF NOT EXISTS thread_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        chat_key TEXT NOT NULL, run_id TEXT, sequence INTEGER NOT NULL,
        message_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(thread_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS thread_turns_lookup
        ON thread_turns(thread_id, sequence);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
      -- 出站副作用账本（docs/EFFECT-LEDGER.md）：所有"对外做了一件事"的操作
      -- 在执行前 planned、结果确定后结算；unknown 是终态，绝不自动重试。
      -- 与 outbox 的区别：outbox 只覆盖走发送队列的消息，账本覆盖日报/提醒/游戏终局等
      -- 业务动作，幂等键由业务给（如 digest:<群>:<日期>）。
      CREATE TABLE IF NOT EXISTS effects (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        chat_key TEXT NOT NULL DEFAULT '',
        idem_key TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        settled_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS effects_kind_idem ON effects(kind, idem_key);
      CREATE INDEX IF NOT EXISTS effects_state_created ON effects(state, created_at);
    `);
    ensureColumn(this.db, 'conversation_threads', 'mode', "TEXT NOT NULL DEFAULT 'threaded'");
    ensureColumn(this.db, 'conversation_threads', 'disposition', "TEXT NOT NULL DEFAULT 'active'");
    ensureColumn(this.db, 'conversation_threads', 'idle_deadline', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'conversation_threads', 'hard_deadline', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'conversation_threads', 'resume_armed_until', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'conversation_threads', 'prompt_hash', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'conversation_threads', 'transcript_chars', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'conversation_threads', 'prompt_tokens', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'messages', 'mentions_self', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'messages', 'target_user_id', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'messages', 'event_kind', "TEXT NOT NULL DEFAULT 'message'");
    // 延迟富化（Issue #85）：入站先落占位、后台展开/解析后再放行。
    // release_state 记住放行时该回 pending 还是 acked（静默段/补历史只存档，不触发唤醒）。
    // deferred_at 用于长跑进程的兜底清扫：富化任务异常/停机竞态留下的行，不能被永久藏起来。
    ensureColumn(this.db, 'messages', 'release_state', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'messages', 'deferred_at', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'outbox', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_deferred
      ON messages(deferred_at) WHERE state='deferred'`);
    // /api/metrics 的 queueStats 按 state 聚合、取 MIN(ts/deferred_at)；默认保留期 0 时
    // 消息表无界，不能每次抓指标都线性扫全历史（2026-11-02 全项目审查 P2）。
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_queue_stats
      ON messages(state, ts, deferred_at)
      WHERE state IN ('pending','leased','held','deferred')`);
    // getChatMeta 的 total 不能再用 COUNT(*) 扫全历史（每条入站消息 + 5 秒 tick 都调），
    // 但也不能用 next_id-1：保留期清理会删掉旧行，那样会虚报"还有 N 条没加载"。
    // 维护一个随插入/清理增减的计数，老库首次启动按现有行数回填一次。
    // 两进程同时首启时 ALTER/标记都可能撞车：ALTER 的 duplicate column 视为已加，
    // 标记与回填放进同一个 BEGIN IMMEDIATE，避免一个进程先写标记、另一个读到 0。
    try {
      ensureColumn(this.db, 'chats', 'message_count', 'INTEGER NOT NULL DEFAULT 0');
    } catch (error) {
      if (!/duplicate column name/i.test(String(error?.message || ''))) throw error;
    }
    this.#transaction(() => {
      const claimed = this.db.prepare(
        "INSERT OR IGNORE INTO migrations(name) VALUES ('chats_message_count')"
      ).run();
      if (!Number(claimed?.changes)) return;
      this.db.exec(`UPDATE chats SET message_count=(
        SELECT COUNT(*) FROM messages WHERE messages.chat_key=chats.chat_key)`);
    });
    // runs 是全仓唯一没有回收纪律的账本（每次带租约的运行 +1，常驻不删，5 秒全表扫）：
    // 进程启动时清掉终态且早已过期的行。expires_at 记的是"租约到期时刻"，用它当近似创建时间，
    // 90 天前的终态行已无诊断价值（2026-10-07 复审 P3）。
    // ⚠️ 2026-10-09 审查：原先只有这一次启动清理 —— 服务连跑数月不重启就等于永不清理
    //（与三个台账踩过同一个坑，a465539 修了它们却漏了本表）。清理由 pruneRuns() 承担，
    // 常驻期间由 console 的每日保留期调度复用同一方法（retentionPruneTargets）。
    this.pruneRuns();
    this.pruneOutbox();
    this.#importJson(dataDir);
  }

  #transaction(fn) {
    if (this.transactionDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    let committed = false;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      // 回滚失败（COMMIT 已抛出 / 连接坏了）不能把原始错误吞掉：附在 cause 上再抛原错误
      //（2026-10-12 审查：原先裸 ROLLBACK 抛出会顶替掉真正的失败原因）。
      if (!committed) {
        try { this.db.exec('ROLLBACK'); } catch (rollbackError) { error.cause ??= rollbackError; }
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  #importJson(dataDir) {
    const dir = path.join(dataDir, 'messages');
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).filter((s) => /^(group|private)_\d+\.json$/.test(s))) {
      if (this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get(name)) continue;
      // Fail closed on corrupt legacy files; never replace them with an empty database.
      // 解析失败必须带上文件名：这条错误会让构造失败 → createApp 抛 → 进程退出，
      // 而 systemd 只会反复重启；不带文件名的话线上根本看不出是哪个归档坏了
      // （2026-09-29 审查 P2）。修法：把那份 json 改名/移走后重启即可跳过该文件。
      let state;
      try {
        state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, ''));
      } catch (error) {
        throw new Error(`Invalid legacy message archive: ${name} (${error?.message ?? error})`);
      }
      const key = state.chatKey || name.replace(/^(group|private)_/, '$1:').replace(/\.json$/, '');
      if (!Array.isArray(state.messages)) throw new Error(`Invalid legacy message archive: ${name}`);
      this.#transaction(() => {
        for (const m of state.messages) {
          this.#append(key, m, m.self ? 'acked' : m.read ? 'acked' : 'pending');
        }
        this.db.prepare('INSERT INTO migrations(name) VALUES (?)').run(name);
      });
    }
  }

  #append(chatKey, m, state) {
    const mid = m.mid == null ? null : String(m.mid);
    if (mid !== null) {
      const existing = this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND mid=?').get(chatKey, mid);
      if (existing) {
        // 首次落库与"后来才知道它是引擎私聊"可能竞速（发送端先写、回显后到，或反之）：
        // 命中重复时把 game-secret 补上，避免这行永远留在模型可见的历史里（2026-09-29 审查）
        if (m.eventKind === 'game-secret' && existing.event_kind !== 'game-secret') {
          this.db.prepare("UPDATE messages SET event_kind='game-secret' WHERE chat_key=? AND mid=?").run(chatKey, mid);
          return { ...entry({ ...existing, event_kind: 'game-secret' }), duplicate: true, marked: true };
        }
        return { ...entry(existing), duplicate: true };
      }
    }
    this.db.prepare('INSERT OR IGNORE INTO chats(chat_key) VALUES (?)').run(chatKey);
    const id = this.db.prepare('SELECT next_id FROM chats WHERE chat_key=?').get(chatKey).next_id;
    this.db.prepare(`INSERT INTO messages
      (chat_key,id,mid,ts,sender_id,sender_name,text,self,reply,media,
       mentions_self,target_user_id,event_kind,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      chatKey, id, mid, Number(m.ts) || Date.now(), String(m.senderId || ''),
      String(m.senderName || ''), String(m.text || ''), m.self ? 1 : 0,
      m.reply ? JSON.stringify(m.reply) : null, JSON.stringify(m.media || []),
      m.mentionsSelf ? 1 : 0, String(m.targetUserId || ''),
      String(m.eventKind || 'message'), state
    );
    this.db.prepare('UPDATE chats SET next_id=next_id+1, message_count=message_count+1 WHERE chat_key=?').run(chatKey);
    if (this.maxPerChat > 0) {
      // Retention must never evict unprocessed or uncertain messages.
      const removed = this.db.prepare(`DELETE FROM messages WHERE chat_key=? AND state='acked' AND id <
        COALESCE((SELECT id FROM messages WHERE chat_key=? ORDER BY id DESC LIMIT 1 OFFSET ?),0)`)
        .run(chatKey, chatKey, this.maxPerChat - 1);
      if (removed.changes) {
        this.db.prepare('UPDATE chats SET message_count=MAX(0, message_count-?) WHERE chat_key=?')
          .run(Number(removed.changes), chatKey);
      }
    }
    return entry(this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND id=?').get(chatKey, id));
  }

  appendIncoming(chatKey, message, { recordOnly = false, deferred = false } = {}) {
    return this.#transaction(() => {
      const recorded = this.#append(
        chatKey,
        { ...message, self: false },
        deferred ? 'deferred' : (recordOnly ? 'acked' : 'pending')
      );
      if (deferred && !recorded.duplicate) {
        const releaseState = recordOnly ? 'acked' : 'pending';
        this.db.prepare('UPDATE messages SET release_state=?, deferred_at=? WHERE chat_key=? AND id=?')
          .run(releaseState, Date.now(), chatKey, recorded.id);
        recorded.releaseState = releaseState;
      }
      return recorded;
    });
  }

  appendSelf(chatKey, message) {
    return this.#transaction(() => this.#append(chatKey, {
      ...message, self: true, senderId: 'self', senderName: '我'
    }, 'acked'));
  }

  /**
   * 入站延迟富化的收尾（Issue #85）。
   * 消息先以 state='deferred' 落库：不进 unread、不会被唤醒；后台解析引用/@昵称/合并转发，
   * 过完黑名单后 updateDeferredMessage() 再 finalizeDeferred() 放行。
   * release_state 区分"放行后要等模型处理（pending）"还是"只存档（acked）"。
   */
  getMessage(chatKey, id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND id=?').get(chatKey, id);
    return row ? entry(row) : null;
  }

  updateDeferredMessage(chatKey, id, { text, reply = null, media = [] } = {}) {
    return this.db.prepare(`UPDATE messages SET text=?, reply=?, media=?
      WHERE chat_key=? AND id=? AND state='deferred'`).run(
      String(text ?? ''),
      reply ? JSON.stringify(reply) : null,
      JSON.stringify(Array.isArray(media) ? media : []),
      chatKey,
      id
    ).changes;
  }

  /** 富化任务真正开始/继续排队时刷新年龄：兜底清扫只该收"开始后卡住"的行。 */
  touchDeferred(chatKey, id) {
    return this.db.prepare(`UPDATE messages SET deferred_at=?
      WHERE chat_key=? AND id=? AND state='deferred'`).run(Date.now(), chatKey, id).changes;
  }

  /** 把 deferred 放行为 pending/acked；state 不传时按落库时的 release_state。 */
  finalizeDeferred(chatKey, id, { state = '' } = {}) {
    return this.#transaction(() => {
      const row = this.db.prepare(
        "SELECT release_state FROM messages WHERE chat_key=? AND id=? AND state='deferred'"
      ).get(chatKey, id);
      if (!row) return '';
      const target = state === 'acked' || state === 'pending'
        ? state
        : (row.release_state === 'acked' ? 'acked' : 'pending');
      this.db.prepare("UPDATE messages SET state=?, release_state='', deferred_at=0 WHERE chat_key=? AND id=? AND state='deferred'")
        .run(target, chatKey, id);
      return target;
    });
  }

  /** 富化后命中黑名单：这条还没被模型看到，按"从未落库"处理，并同步总数。 */
  dropDeferredMessage(chatKey, id) {
    // 先把正文改成拦截占位并标记 acked，再删行：万一 DELETE 失败/进程正好退出，
    // 留下的行也不会把黑名单正文带进后续提示词（启动清扫只会按 acked 放行）。
    const marked = this.db.prepare(`UPDATE messages
      SET release_state='acked', text='[内容已拦截]', reply=NULL, media='[]'
      WHERE chat_key=? AND id=? AND state='deferred'`).run(chatKey, id).changes;
    if (!marked) return false;
    return this.#transaction(() => {
      const removed = this.db.prepare("DELETE FROM messages WHERE chat_key=? AND id=? AND state='deferred'")
        .run(chatKey, id).changes;
      if (removed) {
        this.db.prepare('UPDATE chats SET message_count=MAX(0, message_count-1) WHERE chat_key=?').run(chatKey);
      }
      return Boolean(removed);
    });
  }

  /**
   * 把未完成的 deferred 按占位符放行。
   * @param {{olderThanMs?: number}} [options] 0 = 全部（启动）；大于 0 时只处理卡了这么久的行，
   *   供长跑进程的回收循环兜底（富化任务异常、停服竞态留下的残行）。
   */
  releaseStaleDeferred({ olderThanMs = 0 } = {}) {
    const age = Math.max(0, Number(olderThanMs) || 0);
    const where = age > 0
      ? "state='deferred' AND (deferred_at=0 OR deferred_at<=?)"
      : "state='deferred'";
    const params = age > 0 ? [Date.now() - age] : [];
    if (!this.db.prepare(`SELECT 1 FROM messages WHERE ${where} LIMIT 1`).get(...params)) return [];
    return this.#transaction(() => {
      const chats = this.db.prepare(`SELECT DISTINCT chat_key FROM messages WHERE ${where}`)
        .all(...params).map((row) => row.chat_key);
      if (!chats.length) return [];
      this.db.prepare(`UPDATE messages
        SET state=CASE WHEN release_state='acked' THEN 'acked' ELSE 'pending' END,
            release_state='', deferred_at=0
        WHERE ${where}`).run(...params);
      return chats;
    });
  }

  setMaxPerChat(cap) { this.maxPerChat = Math.max(0, Number(cap) || 0); }

  /** 控制台保存后即时生效；正在进行的写入不受影响（PRAGMA 对后续事务生效）。 */
  setSynchronous(mode) {
    this.db.exec(`PRAGMA synchronous=${normalizeSynchronous(mode)}`);
  }
  listChats() { return this.db.prepare('SELECT chat_key FROM chats ORDER BY chat_key').all().map((r) => r.chat_key); }

  /** 发送 outbox 的各状态计数（低基数，控制台 /api/metrics 用）。 */
  outboxStats() {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM outbox GROUP BY state').all();
    const byState = {};
    let total = 0;
    for (const row of rows) {
      const state = String(row?.state || 'unknown');
      const count = Number(row.n) || 0;
      byState[state] = count;
      total += count;
    }
    return { total, byState };
  }

  /** 入站处理队列的低基数计数与最老一条的年龄（控制台 /api/metrics 用）。 */
  queueStats() {
    const rows = this.db.prepare(`SELECT state, COUNT(*) AS n,
      MIN(CASE WHEN state='deferred' AND deferred_at>0 THEN deferred_at ELSE ts END) AS oldest
      FROM messages WHERE state IN ('pending','leased','held','deferred') GROUP BY state`).all();
    const byState = { pending: 0, leased: 0, held: 0, deferred: 0 };
    let oldestAt = 0;
    for (const row of rows) {
      const state = String(row?.state || '');
      if (Object.hasOwn(byState, state)) byState[state] = Number(row.n) || 0;
      const oldest = Number(row?.oldest) || 0;
      if (oldest && (!oldestAt || oldest < oldestAt)) oldestAt = oldest;
    }
    return {
      byState,
      oldestAt,
      oldestAgeMs: oldestAt ? Math.max(0, Date.now() - oldestAt) : 0
    };
  }
  close() { this.db.close(); }

  getChatMeta(chatKey) {
    // total 走 chats 上维护的计数（插入/保留期清理同步增减），不再对整段历史做 COUNT(*)；
    // 其余状态各走自己的窄索引。这个函数在每条入站消息和 5 秒 tick 上都会调用。
    const total = Number(this.db.prepare('SELECT message_count FROM chats WHERE chat_key=?').get(chatKey)?.message_count) || 0;
    const unread = Number(this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_key=? AND state IN ('pending','leased')").get(chatKey)?.n) || 0;
    const failed = Number(this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_key=? AND state='failed'").get(chatKey)?.n) || 0;
    const heldMessages = Number(this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_key=? AND state='held'").get(chatKey)?.n) || 0;
    const counts = { total, unread, failed };
    const uncertain = this.db.prepare(`SELECT COUNT(DISTINCT COALESCE(run_id,id)) AS held
      FROM outbox WHERE chat_key=? AND state IN ('sending','unknown')`).get(chatKey).held;
    const last = this.db.prepare('SELECT ts,text FROM messages WHERE chat_key=? ORDER BY ts DESC, id DESC LIMIT 1').get(chatKey);
    const thread = this.getConversationThread(chatKey);
    return {
      chatKey, ...counts, held: Math.max(Number(heldMessages) || 0, Number(uncertain) || 0),
      lastTs: last?.ts || 0, lastText: last?.text || '',
      thread: thread ? {
        threadId: thread.threadId,
        mode: thread.mode,
        state: thread.state,
        disposition: thread.disposition,
        topic: thread.topic,
        participantCount: thread.participantIds.length,
        engagedUntil: thread.engagedUntil,
        idleDeadline: thread.idleDeadline,
        hardDeadline: thread.hardDeadline,
        resumeArmedUntil: thread.resumeArmedUntil,
        expiresAt: thread.expiresAt,
        transcriptChars: thread.transcriptChars,
        version: thread.version
      } : null
    };
  }

  unreadCount(chatKey) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_key=? AND self=0
      AND state='pending' AND available_at<=?`).get(chatKey, Date.now()).n;
  }

  peekUnread(chatKey, limit = 3, fromId = 0) {
    const take = Math.max(1, Number(limit) || 3);
    if (Number(fromId) > 0) {
      return this.db.prepare(`SELECT * FROM messages WHERE chat_key=? AND self=0
        AND state='pending' AND available_at<=? AND id>=? ORDER BY id LIMIT ?`)
        .all(chatKey, Date.now(), Number(fromId), take).map(entry);
    }
    return this.db.prepare(`SELECT * FROM messages WHERE chat_key=? AND self=0
      AND state='pending' AND available_at<=? ORDER BY id LIMIT ?`)
      .all(chatKey, Date.now(), take).map(entry);
  }

  /**
   * 逐条扫未读，matcher.test 命中即停。给 degrade 闸门用：只看最旧一批（peekUnread）时，
   * 积压超过扫描窗的 @ 会被判成"没被 @"，整段未读就此永远不处理（当天对 @ 完全无反应）。
   * 只取判定需要的列，keyset 分页（id 递增），避免 OFFSET 越翻越慢。
   */
  somePending(chatKey, matcher) {
    return Boolean(this.findPending(chatKey, matcher));
  }

  /** 与 somePending 同一次扫描，返回命中的那条（带 id，degrade 闸门用它从 @ 处开始领取）。 */
  findPending(chatKey, matcher) {
    if (!matcher || typeof matcher.test !== 'function') return null;
    const now = Date.now();
    const stmt = this.db.prepare(`SELECT id, mentions_self, event_kind, target_user_id, reply
      FROM messages WHERE chat_key=? AND self=0 AND state='pending' AND available_at<=? AND id>?
      ORDER BY id LIMIT 500`);
    let lastId = -1;
    // 上限只是防病态积压（几十万条）把 CPU 吃满；正常量级几页就扫完。
    for (let page = 0; page < 40; page += 1) {
      const rows = stmt.all(chatKey, now, lastId);
      if (!rows.length) return null;
      for (const row of rows) {
        let reply = null;
        if (row.reply) { try { reply = JSON.parse(row.reply); } catch { reply = null; } }
        const candidate = {
          id: Number(row.id),
          mentionsSelf: Boolean(row.mentions_self),
          eventKind: String(row.event_kind || 'message'),
          targetUserId: String(row.target_user_id || ''),
          reply
        };
        if (matcher.test(candidate)) return candidate;
      }
      const nextId = Number(rows[rows.length - 1].id);
      // id 超出 Number 安全整数时 Number() 会舍入；不前进就停，避免同一页无限循环。
      if (!Number.isFinite(nextId) || nextId <= lastId) return null;
      lastId = nextId;
    }
    return null;
  }

  markRead(chatKey, ids) {
    return this.#transaction(() => {
      let n = 0;
      const stmt = this.db.prepare(`UPDATE messages SET state='acked' WHERE chat_key=? AND id=? AND state='pending'`);
      for (const id of ids) n += stmt.run(chatKey, id).changes;
      return n;
    });
  }

  markAllRead(chatKey) {
    return this.db.prepare(`UPDATE messages SET state='acked' WHERE chat_key=? AND state='pending'`).run(chatKey).changes;
  }

  keepLatestPending(chatKey, { limit = 100, maxChars = 32000 } = {}) {
    return this.#transaction(() => {
      const pending = this.db.prepare(`SELECT id, text FROM messages
        WHERE chat_key=? AND state='pending' ORDER BY id DESC`).all(chatKey);
      const keep = new Set();
      let chars = 0;
      for (const row of pending) {
        const length = Math.min(String(row.text || '').length, 2000) + 100;
        if (keep.size >= Math.max(1, Number(limit) || 100)) break;
        if (keep.size && chars + length > Math.max(1000, Number(maxChars) || 32000)) break;
        keep.add(Number(row.id));
        chars += length;
      }
      const mark = this.db.prepare(`UPDATE messages SET state='acked'
        WHERE chat_key=? AND id=? AND state='pending'`);
      let discarded = 0;
      for (const row of pending) {
        if (!keep.has(Number(row.id))) discarded += mark.run(chatKey, row.id).changes;
      }
      return { kept: keep.size, discarded };
    });
  }

  // Administrative compatibility API. Agent execution uses claimUnread/ackLease instead.
  drainUnread(chatKey) {
    const messages = this.peekUnread(chatKey, 1000000);
    this.markRead(chatKey, messages.map((m) => m.id));
    return messages;
  }

  // 该会话是否已有未回收的运行租约（leased）。claimUnread 会因此返回 null，
  // 调用方（尤其是"到点派发提醒"这类会标记已完成的路径）需要在派发前先查这个，
  // 否则会在静默空转之后照样把提醒标成已触发（2026-09-29 审查 P1）。
  hasLeasedRun(chatKey) {
    return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE chat_key=? AND state='leased'").get(chatKey));
  }

  claimUnread(chatKey, { limit = 100, maxChars = 32000, leaseMs = 240000, fromId = 0 } = {}) {
    return this.#transaction(() => {
      if (this.hasLeasedRun(chatKey)) return null;
      // fromId：degrade 闸门在队尾发现 @ 时，从那条开始领，别让更早的普通消息把 @ 挤出批次。
      const pending = this.peekUnread(chatKey, Math.min(100, Math.max(1, limit)), fromId);
      const messages = [];
      let chars = 0;
      for (const m of pending) {
        const cut = safeSlice(m.text, 2000);
        const length = cut.length + 100;
        if (messages.length && chars + length > maxChars) break;
        messages.push({ ...m, text: cut.length < m.text.length ? `${cut} [truncated; use get_message_detail]` : m.text });
        chars += length;
      }
      if (!messages.length) return null;
      const id = crypto.randomUUID();
      this.db.prepare("INSERT INTO runs(id,chat_key,state,expires_at) VALUES (?,?,'leased',?)")
        .run(id, chatKey, Date.now() + leaseMs);
      const update = this.db.prepare("UPDATE messages SET state='leased',lease_id=?,attempts=attempts+1 WHERE chat_key=? AND id=?");
      for (const m of messages) update.run(id, chatKey, m.id);
      return { id, messages };
    });
  }

  ackLease(id) {
    return this.#transaction(() => {
      const changed = this.db.prepare("UPDATE messages SET state='acked',lease_id=NULL WHERE lease_id=? AND state='leased'").run(id).changes;
      this.db.prepare("UPDATE runs SET state='acked' WHERE id=? AND state='leased'").run(id);
      this.db.prepare("DELETE FROM outbox WHERE run_id=? AND state IN ('sent','failed','reconciled_sent','reconciled_failed')").run(id);
      return changed;
    });
  }

  completeRun(id) {
    return this.db.prepare("DELETE FROM outbox WHERE run_id=? AND state IN ('sent','failed')").run(id).changes;
  }

  hasEffects(id) {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE run_id=? AND state IN ('sending','sent','unknown') LIMIT 1").get(id);
  }

  hasUncertainEffects(id) {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE run_id=? AND state IN ('sending','unknown') LIMIT 1").get(id);
  }

  failLease(id, error, { retryable = true, delayMs = 5000, maxAttempts = 3 } = {}) {
    return this.#transaction(() => {
      const held = this.hasEffects(id);
      // held 的行把 run id 留在 lease_id 上（leased 之外的状态没有 lease 语义）：否则租约
      // 过期产生的 held 只剩 error 文本可认，逐条核对就永远释放不掉它们。
      this.db.prepare(`UPDATE messages SET state=CASE WHEN ? THEN 'held'
        WHEN attempts>=? OR ? THEN 'failed' ELSE 'pending' END,
        lease_id=CASE WHEN ? THEN ? ELSE NULL END,available_at=?,error=? WHERE lease_id=? AND state='leased'`)
        .run(held ? 1 : 0, maxAttempts, retryable ? 0 : 1, held ? 1 : 0, id, Date.now() + delayMs, String(error).slice(0, 1000), id);
      this.db.prepare("UPDATE runs SET state=?,error=? WHERE id=? AND state='leased'")
        .run(held ? 'held' : 'failed', String(error).slice(0, 1000), id);
      return held;
    });
  }

  /**
   * 回收「过期且没交回」的租约：硬崩溃/SIGKILL 留下的残行，以及执行真的卡死超过租约的情况。
   *
   * `live`＝本进程此刻仍在执行的那些租约 id，**必须排除**。理由：租约是 runTimeoutMs+60s，
   * 而那句 `setTimeout(() => controller.abort(...))` 只有在下一个 `signal.throwIfAborted()`
   * 检查点才生效 —— 执行卡在一个不响应 abort 的 await 里（工具内没有 signal 的长网络/转码）时，
   * 租约会先到期。此时回收会以 hasEffects()==false 把消息放回 pending、把 run 置 failed，
   * 可那个执行还活着：它稍后照样把消息发出去，收尾的 ackLease/failLease 因为 state 已不是
   * 'leased' 而 0 行生效 —— 同一个批次于是留在 pending，被下一个 drain 再处理一遍（重复回复）。
   * 把「还在跑的」留给它自己的收尾路径处理，才不会有这个窗口（2026-10-09 全面审查）。
   */
  recoverExpired(now = Date.now(), { live = null } = {}) {
    const runs = this.db.prepare("SELECT id FROM runs WHERE state='leased' AND expires_at<=?").all(now);
    let recovered = 0;
    for (const run of runs) {
      if (live && live.has(run.id)) continue;
      this.failLease(run.id, 'Lease expired or process interrupted', { delayMs: 0 });
      recovered += 1;
    }
    return recovered;
  }

  /**
   * 清掉终态且早已过期的运行行（expires_at 当创建时间的近似；leased 行不归保留期管）。
   * 启动时清一次，之后由每日保留期调度复用（console/app.js 的 retentionPruneTargets）——
   * 只清一次等于永不清理（2026-10-09 审查，与三个台账同一教训）。
   * 清理失败不影响调用方（启动路径与每日调度都不该被它拖住）。
   * @param {number} retentionDays 保留天数（默认 90，与启动清理的旧口径一致）
   * @returns {number} 实际删除的行数
   */
  pruneRuns(retentionDays = 90) {
    const days = Math.max(1, Number(retentionDays) || 90);
    try {
      const result = this.db.prepare("DELETE FROM runs WHERE state != 'leased' AND expires_at <= ?")
        .run(Date.now() - days * 24 * 3600 * 1000);
      return Number(result?.changes) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * 清掉无 runId 的终态 outbox 行（插件 send、群游戏、日报、额度提示都不带 runId）。
   * 这些行没有"运行收尾按 run_id 删"的回收路径；不设上限会无界增长（含消息正文）。
   * 保留最近 keep 条，按 rowid 倒序；启动与每日保留期调度都会调用。
   * @returns {number} 实际删除的行数
   */
  pruneOutbox({ keep = 2000 } = {}) {
    const limit = Math.max(1, Number(keep) || 2000);
    const terminal = "state IN ('sent','failed','reconciled_sent','reconciled_failed')";
    try {
      const result = this.db.prepare(`DELETE FROM outbox
        WHERE (run_id IS NULL OR run_id='') AND ${terminal}
          AND rowid NOT IN (
            SELECT rowid FROM outbox WHERE (run_id IS NULL OR run_id='') AND ${terminal}
            ORDER BY rowid DESC LIMIT ?
          )`).run(limit);
      // runs 保留期清理后，带 run_id 的终态 outbox 行会变成孤儿；它们没有别的回收路径。
      const orphan = this.db.prepare(`DELETE FROM outbox
        WHERE run_id IS NOT NULL AND run_id != '' AND ${terminal}
          AND run_id NOT IN (SELECT id FROM runs)`).run();
      return (Number(result?.changes) || 0) + (Number(orphan?.changes) || 0);
    } catch {
      return 0;
    }
  }

  retryFailed(chatKey) {
    // Unknown/partially sent batches require operator review and are deliberately excluded.
    return this.db.prepare(`UPDATE messages SET state='pending',attempts=0,available_at=0
      WHERE chat_key=? AND state='failed'`).run(chatKey).changes;
  }

  resolveHeld(chatKey) {
    return this.#transaction(() => {
      const messages = this.db.prepare("UPDATE messages SET state='acked' WHERE chat_key=? AND state='held'").run(chatKey).changes;
      // ⚠️ 'sending'/'unknown'/'sent' 都是 failLease 里 hasEffects 的判据：按 chat_key
      // 无差别删，正在运行租约的在途证据也被清掉，该运行随后可重试收尾时
      // hasEffects=false → 整批消息回 pending 重跑，群里重复发言（2026-10-04 复审 P1/P2）。
      // ⚠️ 但只按 `runs` 里的终态行取交集也不行：**主动唤醒没有 runs 行**（#wake 里
      // proactive → lease=null，runId 是合成值），它的 unknown 残骸 run_id 在 runs 里
      // 根本不存在，永远清不掉、控制台一直显示"待核对"
      //（delivery-integration「无输入租约的主动发送」用例钉的就是这个）。
      // 口径：按 chat_key 清残骸（含 never-acked 的 'sent'/'failed' —— 正常收尾由 ackLease
      // 删它们，租约从未 ack 的那些只剩这一条清理路径，不清就永久累积成残骸，复审 P3），
      // 但**排除仍在途的租约**（runs 里非终态的行）；run_id 为空的（从未绑过租约）
      // 没有可保护的在途证据，一并清。
      const outbox = this.db.prepare(`DELETE FROM outbox WHERE chat_key=?
        AND state IN ('sending','unknown','sent','failed','reconciled_sent','reconciled_failed')
        AND (run_id IS NULL OR run_id NOT IN (
          SELECT id FROM runs WHERE chat_key=? AND state NOT IN ('held','failed','acked')))`)
        .run(String(chatKey || ''), String(chatKey || '')).changes;
      this.db.prepare("UPDATE runs SET state='acked' WHERE chat_key=? AND state='held'").run(chatKey);
      // 「核对 N 条」的 N：held 消息是主项；终态残骸只在**没有** held 消息时才作为计数
      //（求和会把"1 条消息 + 它自己的 outbox 记账行"算成 2，store.test.mjs 钉的就是这个）。
      // 只用 Math.max(messages, outbox) 的旧行为在"只剩 sent/reconciled 残骸"时报 0，
      // 控制台显示"核对 0 条"（2026-10-04 复审 P3）。
      return messages > 0 ? messages : outbox;
    });
  }

  /**
   * 自动释放"未知已消解"的 held 批次（Issue #84）。
   *
   * held 的语义是"这批外发结果未知"。未知的唯一依据是该 run 的 outbox 仍有非终态行
   * （sending/unknown，或脏数据里的其它状态）；一旦这些行全部终结（sent/failed/
   * reconciled_*）或已被清空，未知就消解了，此时把该 run 的 held 消息置 acked 不会重跑，
   * 会话可以从"发送结果待确认"里恢复。
   *
   * 安全边界：
   *   - 严格按 messages.lease_id + outbox.run_id 的 run 粒度处理，绝不按 chat 无差别删；
   *   - 有 sending/unknown 的一律保留，继续等人工核对；
   *   - lease_id 为空的历史 held 按会话级 outbox 判断：仍有 sending/unknown 才保留人工；
   *   - 释放语义与手动 resolveHeld 一致：ack 丢弃（不自动重发），但记录日志/计数便于审计。
   *     过期十几小时的批次如果自动重发，反而会在群里突然冒出旧消息。
   *
   * @returns {{released: Array<{chatKey:string,runId:string,messages:number,reason:string,outbox:object}>, kept: Array<{chatKey:string,runId:string,messages:number,reason:string,outbox:object}>}}
   */
  autoReleaseResolvedHeld() {
    const terminal = new Set(['sent', 'failed', 'reconciled_sent', 'reconciled_failed']);
    // 空转时不进写事务：回收循环 5 秒一次，不能为了一个空查询每 tick 抢 SQLite 写锁。
    if (!this.db.prepare("SELECT 1 FROM messages WHERE state='held' LIMIT 1").get()) {
      return { released: [], kept: [] };
    }
    return this.#transaction(() => {
      const candidates = this.db.prepare(`SELECT chat_key AS chatKey, lease_id AS runId, COUNT(*) AS messages
        FROM messages WHERE state='held'
        GROUP BY chat_key, lease_id
        ORDER BY chat_key, lease_id`).all();
      const released = [];
      const kept = [];
      for (const candidate of candidates) {
        const chatKey = String(candidate.chatKey || '');
        const runId = String(candidate.runId || '');
        const messages = Number(candidate.messages) || 0;
        if (!runId) {
          // 老版本留下的 held 没记 lease_id。无法按 run 对应，但可以按会话级证据判断：
          // 该会话只要还有 sending/unknown，就仍可能有外发在途 → 保留；
          // 全部终结/根本没有 outbox → 未知已消解，ack 旧消息不会重发。
          const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM outbox WHERE chat_key=? GROUP BY state')
            .all(chatKey);
          const outbox = {};
          for (const row of rows) outbox[String(row.state || 'unknown')] = Number(row.n) || 0;
          if (Object.keys(outbox).some((state) => !terminal.has(state))) {
            kept.push({ chatKey, runId: '', messages, reason: 'missing-lease-unresolved', outbox });
            continue;
          }
          const changed = Number(this.db.prepare(`UPDATE messages SET state='acked', lease_id=NULL
            WHERE chat_key=? AND state='held' AND (lease_id IS NULL OR lease_id='')`)
            .run(chatKey).changes) || 0;
          if (changed) {
            released.push({
              chatKey,
              runId: '',
              messages: changed,
              reason: Object.keys(outbox).length ? 'missing-lease-resolved' : 'missing-lease-no-outbox',
              outbox
            });
          }
          continue;
        }
        const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM outbox WHERE run_id=? GROUP BY state')
          .all(runId);
        const outbox = {};
        for (const row of rows) outbox[String(row.state || 'unknown')] = Number(row.n) || 0;
        const unresolved = Object.entries(outbox).filter(([state]) => !terminal.has(state));
        if (unresolved.length) {
          kept.push({ chatKey, runId, messages, reason: 'outbox-unresolved', outbox });
          continue;
        }
        const changed = Number(this.db.prepare(`UPDATE messages SET state='acked', lease_id=NULL
          WHERE chat_key=? AND state='held' AND lease_id=?`).run(chatKey, runId).changes) || 0;
        if (!changed) continue;   // 另一轮已经处理过这批
        this.db.prepare(`UPDATE runs SET state='acked',
          error=CASE WHEN error IS NULL OR error='' THEN ?
            ELSE error || '；外发结果已确认，自动释放 held' END
          WHERE id=? AND state='held'`)
          .run('外发结果已确认，自动释放 held', runId);
        // 与 ackLease 的正常收尾一致：终态 outbox 行在这里清掉；unknown/sending 已在上面排除。
        this.db.prepare(`DELETE FROM outbox WHERE run_id=?
          AND state IN ('sent','failed','reconciled_sent','reconciled_failed')`).run(runId);
        released.push({
          chatKey,
          runId,
          messages: changed,
          reason: Object.keys(outbox).length ? 'outbox-terminal' : 'no-outbox',
          outbox
        });
      }
      return { released, kept };
    });
  }

  listUnknownOperations(chatKey, limit = 100) {
    return this.db.prepare(`SELECT id, run_id AS runId, chat_key AS chatKey,
      state, payload, message_id AS messageId, error
      FROM outbox WHERE chat_key=? AND state IN ('sending','unknown')
      ORDER BY rowid DESC LIMIT ?`).all(
      String(chatKey || ''),
      Math.min(500, Math.max(1, Number(limit) || 100))
    ).map((row) => {
      let payload = {};
      try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
      return { ...row, payload };
    });
  }

  reconcileUnknownOperation(operationId, result) {
    if (!['sent', 'failed'].includes(result)) {
      throw new Error('未知写入核对结果必须是 sent 或 failed');
    }
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT id, run_id AS runId, chat_key AS chatKey
        FROM outbox WHERE id=? AND state IN ('sending','unknown')`).get(String(operationId || ''));
      if (!row) return null;
      this.db.prepare(`UPDATE outbox SET state=?, error=? WHERE id=?`).run(
        result === 'sent' ? 'reconciled_sent' : 'reconciled_failed',
        result === 'sent' ? '管理员确认已发送' : '管理员确认未发送',
        row.id
      );
      const remaining = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM outbox
        WHERE run_id=? AND state IN ('sending','unknown')`).get(row.runId).count) || 0;
      if (remaining === 0) {
        // 按 run 释放 held：held 行的 lease_id 记的就是产生它的那个 run（见 failLease）。
        // 此前按 error 文本匹配，而租约过期产生的 held 文本是 'Lease expired or process
        // interrupted'，永远匹配不上 —— 于是逐条核对不会释放它，held 计数一直挂着，
        // 开了 unknownWritesBlockChat 的群会一直卡住。
        this.db.prepare(`UPDATE messages SET state='acked', lease_id=NULL
          WHERE chat_key=? AND state='held' AND lease_id=?`).run(row.chatKey, row.runId);
        this.db.prepare(`UPDATE runs SET state='acked', error=? WHERE id=? AND state='held'`)
          .run('管理员已核对全部未知写入', row.runId);
        // 这条路径不走 ackLease，已核对的终态行要在这里清掉，否则会长期累积。
        this.db.prepare(`DELETE FROM outbox
          WHERE run_id=? AND state IN ('reconciled_sent','reconciled_failed')`).run(row.runId);
      }
      return {
        operationId: row.id,
        runId: row.runId,
        chatKey: row.chatKey,
        result,
        remaining
      };
    });
  }

  beginSend(chatKey, runId, payload) {
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO outbox(id,run_id,chat_key,state,payload,created_at) VALUES (?,?,?,'sending',?,?)")
      .run(id, runId || null, chatKey, JSON.stringify(payload), Date.now());
    return id;
  }

  finishSend(id, { messageId, error, outcome = 'unknown' } = {}) {
    const state = error ? (outcome === 'failed' ? 'failed' : 'unknown') : 'sent';
    this.db.prepare('UPDATE outbox SET state=?,message_id=?,error=? WHERE id=?')
      .run(state, messageId == null ? null : String(messageId),
        error ? String(error).slice(0, 1000) : null, id);
  }

  /**
   * 启动时把上一条命留下的 sending 行收口成 unknown：写入方进程已不存在，
   * "仍在发送"不再成立。否则这些行既没有终态出口，也永远不会进入人工核对清单，
   * 会让 getChatMeta().held 永久挡住整个会话（2026-11-03 复核 P1）。
   */
  markStaleSendingUnknown() {
    return this.db.prepare(`UPDATE outbox SET state='unknown',
      error=COALESCE(NULLIF(error,''), '进程重启，发送结果未知')
      WHERE state='sending'`).run().changes;
  }

  expireConversationThreads(now = Date.now(), chatKey = '') {
    const rows = chatKey
      ? this.db.prepare(`SELECT * FROM conversation_threads
        WHERE chat_key=? AND state!='closed'`).all(chatKey)
      : this.db.prepare(`SELECT * FROM conversation_threads WHERE state!='closed'`).all();
    const transitions = [];
    for (const row of rows) {
      let nextState = '';
      let reason = '';
      if ((row.mode || 'threaded') === 'lifecycle') {
        if (row.state === 'rollover_armed') {
          if (Number(row.resume_armed_until) > 0 && Number(row.resume_armed_until) <= now) {
            nextState = 'closed';
            reason = 'rollover-expired';
          }
          } else {
            const idleDeadline = Number(row.idle_deadline) || 0;
            const hardDeadline = Number(row.hard_deadline) || 0;
            const idleDue = idleDeadline > 0 && idleDeadline <= now;
            const hardDue = hardDeadline > 0 && hardDeadline <= now;
            if (idleDue && (!hardDue || idleDeadline < hardDeadline)) {
              nextState = 'closed';
              reason = row.disposition === 'listening' ? 'silent-idle' : 'active-idle';
            } else if (hardDue) {
              nextState = row.disposition === 'active' && Number(row.resume_armed_until) > now
                ? 'rollover_armed'
                : 'closed';
              reason = nextState === 'rollover_armed' ? 'hard-lifetime' : 'hard-lifetime-silent';
            }
        }
      } else if (Number(row.expires_at) > 0 && Number(row.expires_at) <= now) {
        nextState = 'closed';
        reason = 'expired';
      }
      if (nextState) transitions.push({ row, nextState, reason });
    }
    if (!transitions.length) return 0;
    this.#transaction(() => {
      for (const { row, nextState, reason } of transitions) {
        this.db.prepare(`UPDATE conversation_threads SET state=?,close_reason=?,
          transcript_chars=0,prompt_tokens=0,updated_at=?,version=version+1 WHERE chat_key=?`)
          .run(nextState, reason, now, row.chat_key);
        this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(row.thread_id);
      }
    });
    return transitions.length;
  }

  getConversationThread(chatKey, now = Date.now()) {
    this.expireConversationThreads(now, chatKey);
    const row = this.db.prepare('SELECT * FROM conversation_threads WHERE chat_key=?').get(chatKey);
    return !row || row.state === 'closed' ? null : threadEntry(row);
  }

  upsertConversationThread(chatKey, {
    participantIds = [],
    topic = '',
    lastMessageId = 0,
    lastHumanAt = 0,
    lastAgentAt = Date.now(),
    continuationWindowMs = 180000,
    ttlMs = 1800000
  } = {}) {
    const now = Date.now();
    this.expireConversationThreads(now, chatKey);
    return this.#transaction(() => {
      const row = this.db.prepare('SELECT * FROM conversation_threads WHERE chat_key=?').get(chatKey);
      const current = row && row.state !== 'closed' ? threadEntry(row) : null;
      const existing = current?.mode === 'threaded' ? current : null;
      if (!existing && current?.threadId) {
        this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(current.threadId);
      }
      const participants = [...new Set([
        ...(existing?.participantIds || []),
        ...(Array.isArray(participantIds) ? participantIds : [])
      ].map((id) => String(id).trim()).filter(Boolean))].slice(0, 32);
      const thread = {
        chatKey,
        threadId: existing?.threadId || crypto.randomUUID(),
        mode: 'threaded',
        state: 'engaged',
        disposition: 'active',
        topic: String(topic || existing?.topic || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        participantIds: participants,
        openedAt: existing?.openedAt || now,
        updatedAt: now,
        lastHumanAt: Math.max(Number(lastHumanAt) || 0, existing?.lastHumanAt || 0),
        lastAgentAt: Number(lastAgentAt) || now,
        engagedUntil: now + Math.max(1000, Number(continuationWindowMs) || 180000),
        idleDeadline: 0,
        hardDeadline: 0,
        resumeArmedUntil: 0,
        expiresAt: now + Math.max(60000, Number(ttlMs) || 1800000),
        lastMessageId: Math.max(Number(lastMessageId) || 0, existing?.lastMessageId || 0),
        promptHash: '',
        transcriptChars: 0,
        promptTokens: 0,
        version: (existing?.version || 0) + 1,
        closeReason: ''
      };
      this.db.prepare(`INSERT INTO conversation_threads
        (chat_key,thread_id,mode,state,disposition,topic,participant_ids,opened_at,updated_at,
         last_human_at,last_agent_at,engaged_until,idle_deadline,hard_deadline,
         resume_armed_until,expires_at,last_message_id,prompt_hash,transcript_chars,version,
         close_reason,prompt_tokens)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chat_key) DO UPDATE SET
          thread_id=excluded.thread_id,mode=excluded.mode,state=excluded.state,
          disposition=excluded.disposition,topic=excluded.topic,
          participant_ids=excluded.participant_ids,opened_at=excluded.opened_at,
          updated_at=excluded.updated_at,last_human_at=excluded.last_human_at,
          last_agent_at=excluded.last_agent_at,engaged_until=excluded.engaged_until,
          idle_deadline=excluded.idle_deadline,hard_deadline=excluded.hard_deadline,
          resume_armed_until=excluded.resume_armed_until,expires_at=excluded.expires_at,
          last_message_id=excluded.last_message_id,prompt_hash=excluded.prompt_hash,
          transcript_chars=excluded.transcript_chars,version=excluded.version,
          close_reason=excluded.close_reason,prompt_tokens=excluded.prompt_tokens`)
        .run(
          thread.chatKey, thread.threadId, thread.mode, thread.state, thread.disposition,
          thread.topic, JSON.stringify(thread.participantIds), thread.openedAt,
          thread.updatedAt, thread.lastHumanAt, thread.lastAgentAt, thread.engagedUntil,
          thread.idleDeadline, thread.hardDeadline, thread.resumeArmedUntil,
          thread.expiresAt, thread.lastMessageId, thread.promptHash,
          thread.transcriptChars, thread.version, thread.closeReason, thread.promptTokens
        );
      return thread;
    });
  }

  updateLifecycleThread(chatKey, {
    disposition = 'listening',
    participantIds = [],
    topic = '',
    lastMessageId = 0,
    lastHumanAt = 0,
    lastAgentAt = 0,
    promptHash = '',
    promptTokens = null,
    silentIdleMs = 300000,
    activeIdleMs = 1200000,
    hardLifetimeMs = 1800000,
    rolloverArmedMs = 600000,
    acceptedAt = null,
    now = Date.now()
  } = {}) {
    const acceptedTime = Number(acceptedAt) || now;
    this.expireConversationThreads(Math.min(now, acceptedTime), chatKey);
    return this.#transaction(() => {
      const row = this.db.prepare('SELECT * FROM conversation_threads WHERE chat_key=?').get(chatKey);
      const current = row && row.state !== 'closed' ? threadEntry(row) : null;
      const reusable = current?.mode === 'lifecycle' && current.state !== 'rollover_armed';
      const openedAt = reusable ? current.openedAt : now;
      const hardDeadline = reusable
        ? current.hardDeadline
        : now + Math.max(60000, Number(hardLifetimeMs) || 1800000);
      const resumeArmedUntil = hardDeadline + Math.max(60000, Number(rolloverArmedMs) || 600000);
      const normalizedDisposition = disposition === 'active' ? 'active' : 'listening';
      const idleMs = normalizedDisposition === 'active'
        ? Math.max(60000, Number(activeIdleMs) || 1200000)
        : Math.max(10000, Number(silentIdleMs) || 300000);
      const idleDeadline = now + idleMs;
      const activeAtHardDeadline = normalizedDisposition === 'active'
        || (reusable && current.disposition === 'active' && acceptedTime <= hardDeadline);
      const state = now >= hardDeadline
        ? (activeAtHardDeadline ? 'rollover_armed' : 'closed')
        : normalizedDisposition;
      const participants = [...new Set([
        ...(reusable ? current.participantIds : []),
        ...(Array.isArray(participantIds) ? participantIds : [])
      ].map((id) => String(id).trim()).filter(Boolean))].slice(0, 32);
      const thread = {
        chatKey,
        threadId: reusable ? current.threadId : crypto.randomUUID(),
        mode: 'lifecycle',
        state,
        disposition: state === 'rollover_armed' ? 'active' : normalizedDisposition,
        topic: String(topic || (reusable ? current.topic : '') || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        participantIds: participants,
        openedAt,
        updatedAt: now,
        lastHumanAt: Math.max(Number(lastHumanAt) || 0, reusable ? current.lastHumanAt : 0),
        lastAgentAt: Math.max(Number(lastAgentAt) || 0, reusable ? current.lastAgentAt : 0),
        engagedUntil: 0,
        idleDeadline,
        hardDeadline,
        resumeArmedUntil,
        expiresAt: state === 'rollover_armed' ? resumeArmedUntil : Math.min(idleDeadline, hardDeadline),
        lastMessageId: Math.max(Number(lastMessageId) || 0, reusable ? current.lastMessageId : 0),
        promptHash: String(promptHash || (reusable ? current.promptHash : '') || '').slice(0, 100),
        transcriptChars: reusable ? current.transcriptChars : 0,
        promptTokens: promptTokens !== null && promptTokens !== undefined
          && Number.isFinite(Number(promptTokens))
          ? Math.max(0, Math.round(Number(promptTokens)))
          : (reusable ? current.promptTokens : 0),
        version: (reusable ? current.version : 0) + 1,
        closeReason: state === 'rollover_armed' ? 'hard-lifetime' : (state === 'closed' ? 'hard-lifetime-silent' : '')
      };
      if (!reusable && current?.threadId) {
        this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(current.threadId);
      }
      this.db.prepare(`INSERT INTO conversation_threads
        (chat_key,thread_id,mode,state,disposition,topic,participant_ids,opened_at,updated_at,
         last_human_at,last_agent_at,engaged_until,idle_deadline,hard_deadline,
         resume_armed_until,expires_at,last_message_id,prompt_hash,transcript_chars,version,
         close_reason,prompt_tokens)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chat_key) DO UPDATE SET
          thread_id=excluded.thread_id,mode=excluded.mode,state=excluded.state,
          disposition=excluded.disposition,topic=excluded.topic,
          participant_ids=excluded.participant_ids,opened_at=excluded.opened_at,
          updated_at=excluded.updated_at,last_human_at=excluded.last_human_at,
          last_agent_at=excluded.last_agent_at,engaged_until=excluded.engaged_until,
          idle_deadline=excluded.idle_deadline,hard_deadline=excluded.hard_deadline,
          resume_armed_until=excluded.resume_armed_until,expires_at=excluded.expires_at,
          last_message_id=excluded.last_message_id,prompt_hash=excluded.prompt_hash,
          transcript_chars=excluded.transcript_chars,version=excluded.version,
          close_reason=excluded.close_reason,prompt_tokens=excluded.prompt_tokens`)
        .run(
          thread.chatKey, thread.threadId, thread.mode, thread.state, thread.disposition,
          thread.topic, JSON.stringify(thread.participantIds), thread.openedAt,
          thread.updatedAt, thread.lastHumanAt, thread.lastAgentAt, thread.engagedUntil,
          thread.idleDeadline, thread.hardDeadline, thread.resumeArmedUntil,
          thread.expiresAt, thread.lastMessageId, thread.promptHash,
          thread.transcriptChars, thread.version, thread.closeReason, thread.promptTokens
        );
      if (state === 'rollover_armed' || state === 'closed') {
        this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(thread.threadId);
        thread.transcriptChars = 0;
        thread.promptTokens = 0;
      }
      return state === 'closed' ? null : thread;
    });
  }

  armLifecycleRollover(chatKey, reason = 'context-budget', armedMs = 600000) {
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT thread_id FROM conversation_threads
        WHERE chat_key=? AND mode='lifecycle' AND state!='closed'`).get(chatKey);
      if (!row) return false;
      const now = Date.now();
      const until = now + Math.max(60000, Number(armedMs) || 600000);
      const changed = this.db.prepare(`UPDATE conversation_threads
        SET state='rollover_armed',disposition='active',resume_armed_until=?,
            expires_at=?,updated_at=?,close_reason=?,transcript_chars=0,
            prompt_tokens=0,version=version+1
        WHERE chat_key=?`).run(
          until, until, now, String(reason).slice(0, 100), chatKey
        ).changes;
      this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(row.thread_id);
      return changed > 0;
    });
  }

  closeConversationThread(chatKey, reason = 'closed') {
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT thread_id FROM conversation_threads
        WHERE chat_key=? AND state!='closed'`).get(chatKey);
      if (!row) return false;
      const changed = this.db.prepare(`UPDATE conversation_threads SET state='closed',
        close_reason=?,transcript_chars=0,prompt_tokens=0,updated_at=?,version=version+1
        WHERE chat_key=? AND state!='closed'`)
        .run(String(reason).slice(0, 100), Date.now(), chatKey).changes > 0;
      this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(row.thread_id);
      return changed;
    });
  }

  appendThreadTurns(chatKey, threadId, runId, messages = []) {
    if (!Array.isArray(messages) || !messages.length) return { added: 0, chars: 0 };
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT transcript_chars FROM conversation_threads
        WHERE chat_key=? AND thread_id=? AND mode='lifecycle'
        AND state IN ('active','listening')`).get(chatKey, threadId);
      if (!row) return { added: 0, chars: 0 };
      let sequence = Number(this.db.prepare(`SELECT COALESCE(MAX(sequence),0) AS n
        FROM thread_turns WHERE thread_id=?`).get(threadId).n) || 0;
      const insert = this.db.prepare(`INSERT INTO thread_turns
        (thread_id,chat_key,run_id,sequence,message_json,created_at)
        VALUES (?,?,?,?,?,?)`);
      let chars = 0;
      for (const message of messages) {
        const json = JSON.stringify(message);
        chars += json.length;
        insert.run(threadId, chatKey, runId || null, ++sequence, json, Date.now());
      }
      const total = (Number(row.transcript_chars) || 0) + chars;
      this.db.prepare(`UPDATE conversation_threads SET transcript_chars=?,
        updated_at=? WHERE chat_key=? AND thread_id=?`)
        .run(total, Date.now(), chatKey, threadId);
      return { added: messages.length, chars: total };
    });
  }

  getThreadTurns(threadId) {
    const rows = this.db.prepare(`SELECT message_json FROM thread_turns
      WHERE thread_id=? ORDER BY sequence`).all(threadId);
    const messages = [];
    for (const row of rows) {
      try {
        const message = JSON.parse(row.message_json);
        if (['user', 'assistant', 'tool'].includes(message?.role)) messages.push(message);
      } catch { /* skip corrupt turn */ }
    }
    return messages;
  }

  commitLifecycleRun({
    chatKey,
    leaseId = '',
    runId = '',
    persistThread = true,
    closeReason = '',
    threadOptions = {},
    checkpointState = {},
    sourceMessageIds = [],
    messages = [],
    maxTranscriptChars = 240000,
    forceRollover = '',
    rolloverArmedMs = 600000
  } = {}) {
    return this.#transaction(() => {
      const acknowledged = leaseId
        ? this.ackLease(leaseId)
        : this.completeRun(runId);
      if (closeReason) {
        this.closeConversationThread(chatKey, closeReason);
        return { acknowledged, thread: null, checkpoint: null, transcriptChars: 0 };
      }
      if (!persistThread) {
        return { acknowledged, thread: this.getConversationThread(chatKey), checkpoint: null, transcriptChars: 0 };
      }

      let thread = this.updateLifecycleThread(chatKey, threadOptions);
      if (!thread) return { acknowledged, thread: null, checkpoint: null, transcriptChars: 0 };
      const checkpoint = this.appendThreadCheckpoint(
        chatKey,
        thread.threadId,
        runId,
        checkpointState,
        sourceMessageIds
      );
      let transcriptChars = thread.transcriptChars;
      if (messages.length) {
        transcriptChars = this.appendThreadTurns(
          chatKey,
          thread.threadId,
          runId,
          messages
        ).chars;
      }
      const maxChars = Math.min(1000000, Math.max(20000, Number(maxTranscriptChars) || 240000));
      if (forceRollover || transcriptChars > maxChars) {
        this.armLifecycleRollover(
          chatKey,
          forceRollover || 'context-budget',
          rolloverArmedMs
        );
        thread = this.getConversationThread(chatKey);
        transcriptChars = 0;
      }
      return { acknowledged, thread, checkpoint, transcriptChars };
    });
  }

  appendThreadCheckpoint(chatKey, threadId, runId, state, sourceMessageIds = []) {
    const thread = this.db.prepare(`SELECT version FROM conversation_threads
      WHERE chat_key=? AND thread_id=? AND state!='closed'`).get(chatKey, threadId);
    if (!thread) return null;
    const createdAt = Date.now();
    const result = this.db.prepare(`INSERT INTO thread_checkpoints
      (thread_id,chat_key,run_id,version,state_json,source_message_ids,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
        threadId, chatKey, runId || null, Number(thread.version) || 1,
        JSON.stringify(state || {}),
        JSON.stringify((sourceMessageIds || []).map(Number).filter(Number.isFinite)),
        createdAt
      );
    this.db.prepare(`DELETE FROM thread_checkpoints WHERE chat_key=? AND id NOT IN (
      SELECT id FROM thread_checkpoints WHERE chat_key=? ORDER BY id DESC LIMIT 200
    )`).run(chatKey, chatKey);
    return {
      id: Number(result.lastInsertRowid),
      threadId,
      chatKey,
      runId: runId || null,
      version: Number(thread.version) || 1,
      state: structuredClone(state || {}),
      sourceMessageIds: (sourceMessageIds || []).map(Number).filter(Number.isFinite),
      createdAt
    };
  }

  latestThreadCheckpoint(chatKey) {
    const row = this.db.prepare(`SELECT * FROM thread_checkpoints
      WHERE chat_key=? ORDER BY id DESC LIMIT 1`).get(chatKey);
    if (!row) return null;
    let state = {};
    let sourceMessageIds = [];
    try { state = JSON.parse(row.state_json || '{}'); } catch { /* keep empty */ }
    try { sourceMessageIds = JSON.parse(row.source_message_ids || '[]'); } catch { /* keep empty */ }
    return {
      id: Number(row.id),
      threadId: row.thread_id,
      chatKey: row.chat_key,
      runId: row.run_id,
      version: Number(row.version) || 1,
      state,
      sourceMessageIds,
      createdAt: Number(row.created_at) || 0
    };
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true, readOnly = false, afterId = 0, beforeId = 0, fromId = null, scope = 'chat' } = {}) {
    // afterId：增量消费按 id **升序**取"游标之后最早的一批"；积压超过 limit 时下一轮继续，
    // 不能按 DESC 取最新 N 条再 reverse —— 那会把落在窗口外的最老消息静默跳过（游戏丢票）。
    // beforeId：控制台向上翻页，取"比这个 id 更老的最新 N 条"，仍按时间正序返回。
    // 非增量调用仍保持"最新 N 条、按时间正序返回"的既有语义。
    // fromId：显式从"最老一条"开始正向取（全量导出用）；与 afterId 不同，0 也有意义。
    // scope='private'：只给"私聊共享上下文"用，读所有 private:*，按 ts 排序（跨会话没有可比 id）。
    // scope='all'：群聊与私聊共用上下文（issue #14 第二项），读所有会话，同样按 ts 排序。
    const after = Number(afterId) > 0 ? Number(afterId) : 0;
    const before = !after && Number(beforeId) > 0 ? Number(beforeId) : 0;
    const filters = `${includeSelf ? '' : 'AND self=0'} ${readOnly ? "AND state='acked'" : ''}`;
    if (scope === 'private' && String(chatKey || '').startsWith('private:')) {
      const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_key LIKE 'private:%' ${filters}
        ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
        .all(Math.max(1, Number(limit) || 1), Math.max(0, Number(offset) || 0));
      return rows.reverse().map(entry);
    }
    if (scope === 'all') {
      const rows = this.db.prepare(`SELECT * FROM messages WHERE 1=1 ${filters}
        ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
        .all(Math.max(1, Number(limit) || 1), Math.max(0, Number(offset) || 0));
      return rows.reverse().map(entry);
    }
    if (fromId !== null && fromId !== undefined) {
      const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_key=? ${filters}
        AND id >= ? ORDER BY id ASC LIMIT ?`)
        .all(chatKey, Math.max(0, Number(fromId) || 0), Math.max(1, Number(limit) || 1));
      return rows.map(entry);
    }
    if (after) {
      const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_key=? ${filters}
        AND id > ? ORDER BY id ASC LIMIT ?`)
        .all(chatKey, after, Math.max(1, Number(limit) || 1));
      return rows.map(entry);
    }
    if (before) {
      const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_key=? ${filters}
        AND id < ? ORDER BY id DESC LIMIT ?`)
        .all(chatKey, before, Math.max(1, Number(limit) || 1));
      return rows.reverse().map(entry);
    }
    const rows = this.db.prepare(`SELECT * FROM messages WHERE chat_key=? ${filters}
      ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(chatKey, Math.max(1, Number(limit) || 1), Math.max(0, Number(offset) || 0));
    return rows.reverse().map(entry);
  }

  /** 某成员最近 N 条发言（时间正序；只读、不含自己）。记忆整理用来补充新证据。 */
  recentBySender(chatKey, userId, limit = 30) {
    const rows = this.db.prepare(`SELECT * FROM messages
      WHERE chat_key=? AND self=0 AND sender_id=? ORDER BY id DESC LIMIT ?`)
      .all(String(chatKey), String(userId), Math.max(1, Math.min(200, Number(limit) || 30)));
    return rows.reverse().map(entry);
  }

  /** 该会话最老一条消息的 id（没有返回 0）。全量导出从这里正向分页。 */
  firstMessageId(chatKey) {
    const row = this.db.prepare('SELECT MIN(id) AS id FROM messages WHERE chat_key=?').get(String(chatKey));
    return Number(row?.id) || 0;
  }

  /**
   * 该会话在 ts 之后有没有自己的消息落库。
   * 提醒确认用它而不是"最新 N 条里翻"：唤醒期间涌入的消息可以把刚发出的自述挤出窗口。
   */
  hasSelfSince(chatKey, ts) {
    return !!this.db.prepare('SELECT 1 FROM messages WHERE chat_key=? AND self=1 AND ts>=? LIMIT 1')
      .get(String(chatKey), Number(ts) || 0);
  }

  findByMid(chatKey, mid) {
    return entry(this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND mid=?').get(chatKey, normalizeMid(mid)));
  }

  findByLocalId(chatKey, localId) {
    return entry(this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND id=?').get(chatKey, Number(localId)));
  }

  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const m = this.findByMid(chatKey, mid);
    if (!m) return false;
    const media = [...m.media];
    const seen = new Set(media.map((v) => v.url));
    for (const v of appendMedia) {
      if (v?.url && !seen.has(v.url)) { media.push(v); seen.add(v.url); }
    }
    // 查找用的是归一化后的 mid，更新也必须用同一个值，
    // 否则传 "#123" 时会"找到条目、更新 0 行、却返回 true"。
    this.db.prepare('UPDATE messages SET text=?,media=? WHERE chat_key=? AND mid=?')
      .run(text == null ? m.text : String(text), JSON.stringify(media), chatKey, normalizeMid(mid));
    return true;
  }

  activeMembers(chatKey, limit = 10) {
    return this.db.prepare(`SELECT sender_id AS userId, sender_name AS name, MAX(ts) AS lastTs,
      COUNT(*) AS count FROM messages WHERE chat_key=? AND self=0
      GROUP BY sender_id ORDER BY lastTs DESC LIMIT ?`).all(chatKey, Math.max(1, limit));
  }

  /**
   * 本会话成员名单（最近一次名字，按名字长度倒序：@ 解析时最长匹配先命中）。
   * 只读 message 表的 sender_name；备注优先的显示名由调用方用 displayNameOf 叠加。
   */
  memberNames(chatKey, { limit = 5000 } = {}) {
    return this.db.prepare(`SELECT m.sender_id AS userId, m.sender_name AS name, m.ts AS lastTs,
      g.count AS count
      FROM messages m
      JOIN (
        SELECT chat_key, sender_id, MAX(id) AS maxId, COUNT(*) AS count
        FROM messages
        WHERE chat_key=? AND self=0 AND sender_id<>'' AND sender_name<>''
        GROUP BY chat_key, sender_id
      ) g ON m.id=g.maxId AND m.chat_key=g.chat_key AND m.sender_id=g.sender_id
      ORDER BY length(m.sender_name) DESC, m.ts DESC LIMIT ?`)
      .all(chatKey, Math.max(1, Math.min(10000, Number(limit) || 5000)))
      .map((row) => ({ userId: String(row.userId || ''), name: String(row.name || ''), lastTs: Number(row.lastTs) || 0, count: Number(row.count) || 0 }));
  }

  /**
   * 按昵称找 QQ：精确命中优先，其次成员名以该昵称开头；多个不同 QQ 命中就返回 null。
   * 宁可不 @，也不能因为重名猜错人。
   */
  memberByName(chatKey, name) {
    const query = String(name ?? '').trim().replace(/^@+/, '').toLowerCase();
    if (!query) return null;
    const members = this.memberNames(chatKey).filter((member) => member.name);
    const unique = (rows) => {
      const ids = new Set(rows.map((row) => row.userId));
      return ids.size === 1 ? rows[0] : null;
    };
    return unique(members.filter((member) => member.name.toLowerCase() === query))
      || unique(members.filter((member) => member.name.toLowerCase().startsWith(query)));
  }

  /**
   * 这些 QQ 各自在哪些会话露过面、在那边叫什么；不搬消息内容。
   * 返回 { [userId]: [{ chatKey, name, lastTs, count }] }。
   */
  personChatIndex(userIds = []) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
      .map((id) => String(id ?? '').trim()).filter((id) => /^\d{1,15}$/.test(id)))].slice(0, 200);
    if (!ids.length) return {};
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT m.chat_key AS chatKey, m.sender_id AS userId,
      m.sender_name AS name, m.ts AS lastTs, g.count AS count
      FROM messages m
      JOIN (
        SELECT chat_key, sender_id, MAX(id) AS maxId, COUNT(*) AS count
        FROM messages
        WHERE self=0 AND sender_id IN (${placeholders})
        GROUP BY chat_key, sender_id
      ) g ON m.id=g.maxId AND m.chat_key=g.chat_key AND m.sender_id=g.sender_id
      ORDER BY m.ts DESC LIMIT 1000`).all(...ids);
    const out = Object.fromEntries(ids.map((id) => [id, []]));
    for (const row of rows) {
      const userId = String(row.userId || '');
      if (!out[userId]) continue;
      out[userId].push({
        chatKey: String(row.chatKey || ''),
        name: String(row.name || ''),
        lastTs: Number(row.lastTs) || 0,
        count: Number(row.count) || 0
      });
    }
    return out;
  }

  hasParticipant(chatKey, userId) {
    const id = String(userId ?? '').trim();
    if (!id) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM messages
      WHERE chat_key=? AND self=0 AND sender_id=? LIMIT 1`).get(chatKey, id));
  }

  /** 实验身份库启用时才调用：为跨会话 QQ 查询创建索引。 */
  ensureIdentityLookupIndex() {
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_sender_time
      ON messages(sender_id, ts DESC) WHERE self=0`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_chat_sender_time
      ON messages(chat_key, sender_id, ts DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_chat_target_time
      ON messages(chat_key, target_user_id, ts DESC) WHERE self=1`);
  }

  friendEligibilityMetrics(chatKey, userId, {
    since = 0,
    until = Date.now(),
    exchangeWindowMs = 300000,
    selfId = ''
  } = {}) {
    const source = String(chatKey || '');
    const uin = String(userId || '').trim();
    if (!/^(group|private):\d+$/.test(source) || !/^\d{1,15}$/.test(uin)) {
      return { messageCount: 0, activeDays: 0, directExchanges: 0 };
    }
    const start = Math.max(0, Number(since) || 0);
    const end = Math.max(start, Number(until) || Date.now());
    const incoming = this.db.prepare(`
      SELECT id, ts, reply, mentions_self
      FROM messages
      WHERE chat_key=? AND self=0 AND sender_id=? AND ts BETWEEN ? AND ?
        AND event_kind='message'
      ORDER BY ts, id
      LIMIT 10000
    `).all(source, uin, start, end);
    const activeDays = new Set(incoming.map((row) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date(Number(row.ts) || 0)))).size;
    const privateChat = source === `private:${uin}`;
    const directIncoming = incoming.filter((row) => {
      if (privateChat) return true;
      if (Number(row.mentions_self)) return true;
      try {
        const reply = row.reply ? JSON.parse(row.reply) : null;
        return ['self', String(selfId || '')].includes(String(reply?.senderId || ''));
      } catch {
        return false;
      }
    });
    const outgoing = this.db.prepare(`
      SELECT id, ts
      FROM messages
      WHERE chat_key=? AND self=1 AND ts BETWEEN ? AND ?
        AND event_kind='message'
        AND (?=1 OR target_user_id=?)
      ORDER BY ts, id
      LIMIT 10000
    `).all(source, start, end, privateChat ? 1 : 0, uin);
    let directExchanges = 0;
    let lastExchangeAt = -Infinity;
    let outgoingIndex = 0;
    for (const input of directIncoming) {
      while (
        outgoingIndex < outgoing.length
        && Number(outgoing[outgoingIndex].ts) < Number(input.ts) - exchangeWindowMs
      ) outgoingIndex += 1;
      const output = outgoing[outgoingIndex];
      if (!output || Math.abs(Number(output.ts) - Number(input.ts)) > exchangeWindowMs) continue;
      const at = Math.max(Number(input.ts), Number(output.ts));
      if (at - lastExchangeAt < exchangeWindowMs) continue;
      directExchanges += 1;
      lastExchangeAt = at;
      outgoingIndex += 1;
    }
    return {
      messageCount: incoming.length,
      activeDays,
      directExchanges
    };
  }

  friendReviewHistory(chatKey, userId, {
    since = 0,
    until = Date.now(),
    maxCandidate = 24,
    maxAgent = 24,
    maxChars = 12000
  } = {}) {
    const source = String(chatKey || '');
    const uin = String(userId || '').trim();
    if (!/^(group|private):\d+$/.test(source) || !/^\d{1,15}$/.test(uin)) {
      return { messages: [], evidenceIds: [], truncated: false };
    }
    const privateChat = source === `private:${uin}`;
    const candidateRows = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_key=? AND self=0 AND sender_id=? AND ts BETWEEN ? AND ?
        AND event_kind='message'
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(
      source,
      uin,
      Math.max(0, Number(since) || 0),
      Number(until) || Date.now(),
      Math.min(100, Math.max(1, Number(maxCandidate) || 24))
    );
    const agentRows = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_key=? AND self=1 AND ts BETWEEN ? AND ?
        AND event_kind='message'
        AND (?=1 OR target_user_id=?)
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(
      source,
      Math.max(0, Number(since) || 0),
      Number(until) || Date.now(),
      privateChat ? 1 : 0,
      uin,
      Math.min(100, Math.max(1, Number(maxAgent) || 24))
    );
    const rows = [...candidateRows, ...agentRows]
      .sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.id) - Number(b.id));
    const messages = [];
    let chars = 0;
    let truncated = false;
    for (const row of rows) {
      const text = String(row.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const size = text.length + 120;
      if (messages.length && chars + size > Math.max(1000, Number(maxChars) || 12000)) {
        truncated = true;
        continue;
      }
      const id = `message:${source}:${row.id}`;
      messages.push({
        id,
        at: Number(row.ts) || 0,
        speaker: Number(row.self) ? 'agent' : 'candidate',
        text
      });
      chars += size;
    }
    return {
      messages,
      evidenceIds: messages.map((message) => message.id),
      truncated
    };
  }

  /**
   * 返回按 QQ / 会话 / 昵称聚合的只读活动快照。
   * 不在构造阶段自动执行，确保实验开关关闭时数据库结构和查询成本均不变化。
   */
  identityActivityRows() {
    return this.db.prepare(`
      SELECT sender_id AS userId, chat_key AS chatKey, sender_name AS name,
        COUNT(*) AS messageCount, MIN(ts) AS firstSeenAt, MAX(ts) AS lastSeenAt
      FROM messages
      WHERE self=0 AND sender_id!=''
      GROUP BY sender_id, chat_key, sender_name
      ORDER BY lastSeenAt DESC
    `).all().map((row) => ({
      userId: String(row.userId || ''),
      chatKey: String(row.chatKey || ''),
      name: String(row.name || ''),
      messageCount: Number(row.messageCount) || 0,
      firstSeenAt: Number(row.firstSeenAt) || 0,
      lastSeenAt: Number(row.lastSeenAt) || 0
    }));
  }
}
