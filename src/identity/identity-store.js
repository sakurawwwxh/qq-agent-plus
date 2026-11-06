import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase } from '../core/sqlite.js';
import { DATA_DIR } from '../core/config.js';
import {
  cancelOpenFriendArtifacts,
  ensureCancelReasonColumn,
  isIdentityAssetDeleted as hasIdentityAssetTombstone
} from './identity-asset-deletion.js';

const DB_NAME = 'identity-pilot.sqlite';
const FRIEND_PROPOSAL_REASONS = new Set(['interest', 'frequent', 'banter']);
const OPEN_FRIEND_PROPOSAL_STATES = new Set([
  'pending',
  'approved_manual',
  'dispatching',
  'sent',
  'held_unknown'
]);
// 入站好友请求里"还没了结"的状态：与触发闸门、friend_add 收尾用的集合一致
// （identity-store.js 里那两处 `status IN (...)`）。保留期清理不能删这些。
// failed 是终态（决策入口只接受 pending，不会重试）——列在这里等于永远不清、表只涨不缩
//（2026-10-12 审查）。
const OPEN_INCOMING_REQUEST_STATES = new Set([
  'pending',
  'deciding',
  'approved',
  'held_unknown'
]);

function ensureColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((column) => column.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function normalizeUin(value) {
  const uin = String(value ?? '').trim();
  return /^\d{1,15}$/.test(uin) && Number(uin) > 0 ? uin : '';
}

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function cleanMemory(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function proposalView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.uin),
    primaryName: String(row.primary_name || ''),
    sourceChatKey: String(row.source_chat_key || ''),
    reasonCode: String(row.reason_code || ''),
    reason: String(row.reason || ''),
    verificationMessage: String(row.verification_message || ''),
    status: String(row.status || ''),
    createdAt: Number(row.created_at) || 0,
    decidedAt: Number(row.decided_at) || 0,
    decidedBy: String(row.decided_by || ''),
    notifiedAt: Number(row.notified_at) || 0,
    notifyError: String(row.notify_error || ''),
    cooldownUntil: Number(row.cooldown_until) || 0,
    dispatchAttemptId: String(row.dispatch_attempt_id || ''),
    dispatchStartedAt: Number(row.dispatch_started_at) || 0,
    dispatchedAt: Number(row.dispatched_at) || 0,
    dispatchError: String(row.dispatch_error || ''),
    opportunityId: String(row.opportunity_id || ''),
    updatedAt: Number(row.updated_at) || 0
  };
}

function incomingRequestView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.uin),
    primaryName: String(row.primary_name || ''),
    comment: String(row.comment || ''),
    status: String(row.status || ''),
    decision: String(row.decision || ''),
    cancelReason: String(row.cancel_reason || ''),
    createdAt: Number(row.created_at) || 0,
    decidedAt: Number(row.decided_at) || 0,
    decidedBy: String(row.decided_by || ''),
    notifiedAt: Number(row.notified_at) || 0,
    notifyError: String(row.notify_error || ''),
    actionAttemptId: String(row.action_attempt_id || ''),
    actionStartedAt: Number(row.action_started_at) || 0,
    actionCompletedAt: Number(row.action_completed_at) || 0,
    actionError: String(row.action_error || ''),
    whitelistApplied: Boolean(row.whitelist_applied),
    whitelistError: String(row.whitelist_error || ''),
    updatedAt: Number(row.updated_at) || 0
  };
}

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function friendOpportunityView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    accountUin: String(row.account_uin || ''),
    userId: String(row.uin),
    primaryName: String(row.primary_name || ''),
    sourceChatKey: String(row.source_chat_key || ''),
    parentSessionId: String(row.parent_session_id || ''),
    triggerKey: String(row.trigger_key || ''),
    triggerMessageIds: parseJsonArray(row.trigger_message_ids),
    triggerReason: String(row.trigger_reason || ''),
    status: String(row.status || ''),
    reason: String(row.reason || ''),
    probability: Number(row.probability) || 0,
    randomValue: Number(row.random_value) || 0,
    eligibility: parseJsonObject(row.eligibility_json),
    config: parseJsonObject(row.config_json),
    review: parseJsonObject(row.review_json),
    usage: parseJsonObject(row.usage_json),
    model: String(row.model || ''),
    proposalId: String(row.proposal_id || ''),
    createdAt: Number(row.created_at) || 0,
    startedAt: Number(row.started_at) || 0,
    completedAt: Number(row.completed_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

function identityPersonView(row, aliases = []) {
  if (!row) return null;
  let profile = {};
  try {
    const value = JSON.parse(row.profile_json || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) profile = value;
  } catch { /* keep empty */ }
  return {
    userId: String(row.uin),
    primaryName: String(row.primary_name || ''),
    firstSeenAt: Number(row.first_seen_at) || 0,
    lastSeenAt: Number(row.last_seen_at) || 0,
    messageCount: Number(row.message_count) || 0,
    chatCount: Number(row.chat_count) || 0,
    isFriend: Boolean(row.is_friend),
    manuallyManaged: Boolean(row.manually_managed),
    sourceChatKey: String(row.manual_source_chat_key || ''),
    legacyMemoryCount: Number(row.legacy_memory_count) || 0,
    safeProfile: profile,
    aliases: aliases.map((alias) => ({
      ...alias,
      seenCount: Number(alias.seenCount) || 0,
      firstSeenAt: Number(alias.firstSeenAt) || 0,
      lastSeenAt: Number(alias.lastSeenAt) || 0
    }))
  };
}

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function chatKeyFromName(name) {
  const match = /^(group|private)_(\d+)$/.exec(String(name || ''));
  return match ? `${match[1]}:${match[2]}` : '';
}

export function identityDatabasePath(dataDir = DATA_DIR) {
  return path.join(dataDir, DB_NAME);
}

/**
 * 只读扫描旧版会话内印象。不会调用 MemoryStore，因其加载过程可能执行历史迁移。
 */
export function readLegacyIdentityMemories(
  dataDir = DATA_DIR,
  { allowSource = () => true } = {}
) {
  const memoryDir = path.join(dataDir, 'memory');
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch { return rows; }

  const add = (chatKey, userId, content, createdAt, sourceFile) => {
    const uin = normalizeUin(userId);
    const text = cleanMemory(content);
    if (!uin || !text || !allowSource(chatKey, uin)) return;
    rows.push({
      userId: uin,
      chatKey,
      content: text,
      observedAt: Number(createdAt) || 0,
      sourceFile: path.relative(dataDir, sourceFile)
    });
  };

  for (const name of names) {
    const full = path.join(memoryDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }

    if (stat.isDirectory()) {
      const chatKey = chatKeyFromName(name);
      if (!chatKey) continue;
      let files = [];
      try { files = fs.readdirSync(full); } catch { continue; }
      for (const filename of files) {
        if (!/^\d{1,15}\.json$/.test(filename)) continue;
        const file = path.join(full, filename);
        const raw = readJson(file);
        if (!raw) continue;
        const userId = normalizeUin(raw.userId) || filename.slice(0, -5);
        for (const impression of Array.isArray(raw.impressions) ? raw.impressions : []) {
          add(chatKey, userId, impression?.content, impression?.createdAt, file);
        }
      }
      continue;
    }

    const legacyMatch = /^(group|private)_(\d+)\.json$/.exec(name);
    if (!legacyMatch) continue;
    const chatKey = `${legacyMatch[1]}:${legacyMatch[2]}`;
    const raw = readJson(full);
    for (const impression of Array.isArray(raw?.memberImpression) ? raw.memberImpression : []) {
      add(
        chatKey,
        impression?.userId || (/^\d{1,15}$/.test(String(impression?.target || ''))
          ? impression.target
          : ''),
        impression?.content,
        impression?.createdAt,
        full
      );
    }
  }
  return rows;
}

export class IdentityStore {
  constructor({ dataDir = DATA_DIR, filename = identityDatabasePath(dataDir) } = {}) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = openDatabase(filename);
    try { fs.chmodSync(filename, 0o600); } catch { /* best effort */ }
    // journal_mode/synchronous 是本库既有持久化口径；busy_timeout/foreign_keys 由 core/sqlite.js 统一设置
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        uin TEXT PRIMARY KEY,
        primary_name TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        chat_count INTEGER NOT NULL DEFAULT 0,
        is_friend INTEGER NOT NULL DEFAULT 0,
        legacy_memory_count INTEGER NOT NULL DEFAULT 0,
        profile_json TEXT NOT NULL DEFAULT '{}',
        profile_updated_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_sources (
        uin TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uin, chat_key),
        FOREIGN KEY (uin) REFERENCES people(uin) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS identity_aliases (
        uin TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        alias TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uin, chat_key, alias),
        FOREIGN KEY (uin) REFERENCES people(uin) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS legacy_memory_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uin TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        content TEXT NOT NULL,
        observed_at INTEGER NOT NULL DEFAULT 0,
        source_file TEXT NOT NULL DEFAULT '',
        UNIQUE (uin, chat_key, content),
        FOREIGN KEY (uin) REFERENCES people(uin) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS identity_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_asset_overrides (
        uin TEXT PRIMARY KEY,
        primary_name TEXT NOT NULL DEFAULT '',
        profile_json TEXT NOT NULL DEFAULT '{}',
        is_friend INTEGER,
        source_chat_key TEXT NOT NULL DEFAULT '',
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS friend_proposals (
        id TEXT PRIMARY KEY,
        uin TEXT NOT NULL,
        source_chat_key TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        verification_message TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        decided_at INTEGER NOT NULL DEFAULT 0,
        decided_by TEXT NOT NULL DEFAULT '',
        notified_at INTEGER NOT NULL DEFAULT 0,
        notify_error TEXT NOT NULL DEFAULT '',
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incoming_friend_requests (
        id TEXT PRIMARY KEY,
        request_flag TEXT NOT NULL UNIQUE,
        uin TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        decision TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        decided_at INTEGER NOT NULL DEFAULT 0,
        decided_by TEXT NOT NULL DEFAULT '',
        notified_at INTEGER NOT NULL DEFAULT 0,
        notify_error TEXT NOT NULL DEFAULT '',
        action_attempt_id TEXT NOT NULL DEFAULT '',
        action_started_at INTEGER NOT NULL DEFAULT 0,
        action_completed_at INTEGER NOT NULL DEFAULT 0,
        action_error TEXT NOT NULL DEFAULT '',
        whitelist_applied INTEGER NOT NULL DEFAULT 0,
        whitelist_error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS friend_opportunities (
        id TEXT PRIMARY KEY,
        account_uin TEXT NOT NULL,
        uin TEXT NOT NULL,
        source_chat_key TEXT NOT NULL,
        parent_session_id TEXT NOT NULL DEFAULT '',
        trigger_key TEXT NOT NULL UNIQUE,
        trigger_message_ids TEXT NOT NULL DEFAULT '[]',
        trigger_reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        probability REAL NOT NULL DEFAULT 0,
        random_value REAL NOT NULL DEFAULT 0,
        eligibility_json TEXT NOT NULL DEFAULT '{}',
        config_json TEXT NOT NULL DEFAULT '{}',
        review_json TEXT NOT NULL DEFAULT '{}',
        usage_json TEXT NOT NULL DEFAULT '{}',
        model TEXT NOT NULL DEFAULT '',
        proposal_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS identity_people_recent ON people(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS identity_sources_chat ON identity_sources(chat_key, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS identity_memories_person ON legacy_memory_refs(uin, observed_at DESC);
      CREATE INDEX IF NOT EXISTS friend_proposals_recent
        ON friend_proposals(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS friend_proposals_person
        ON friend_proposals(uin, created_at DESC);
      CREATE INDEX IF NOT EXISTS incoming_friend_requests_recent
        ON incoming_friend_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS friend_opportunities_recent
        ON friend_opportunities(created_at DESC);
      CREATE INDEX IF NOT EXISTS friend_opportunities_person
        ON friend_opportunities(account_uin, uin, created_at DESC);
      CREATE INDEX IF NOT EXISTS friend_opportunities_status
        ON friend_opportunities(status, created_at DESC);
    `);
    ensureColumn(
      this.db,
      'friend_proposals',
      'dispatch_attempt_id',
      "TEXT NOT NULL DEFAULT ''"
    );
    ensureColumn(
      this.db,
      'friend_proposals',
      'dispatch_started_at',
      'INTEGER NOT NULL DEFAULT 0'
    );
    ensureColumn(
      this.db,
      'friend_proposals',
      'dispatched_at',
      'INTEGER NOT NULL DEFAULT 0'
    );
    ensureColumn(
      this.db,
      'friend_proposals',
      'dispatch_error',
      "TEXT NOT NULL DEFAULT ''"
    );
    ensureColumn(
      this.db,
      'friend_proposals',
      'opportunity_id',
      "TEXT NOT NULL DEFAULT ''"
    );
    ensureCancelReasonColumn(this.db);
    const now = Date.now();
    this.db.prepare(`
      UPDATE friend_proposals
      SET status='held_unknown',
        dispatch_error=CASE
          WHEN dispatch_error='' THEN '服务在发送结果确认前重启'
          ELSE dispatch_error
        END,
        updated_at=?
      WHERE status='dispatching'
    `).run(now);
    this.db.prepare(`
      UPDATE incoming_friend_requests
      SET status='held_unknown',
        action_error=CASE
          WHEN action_error='' THEN '服务在好友请求处理结果确认前重启'
          ELSE action_error
        END,
        updated_at=?
      WHERE status='deciding'
    `).run(now);
    this.db.prepare(`
      UPDATE friend_opportunities
      SET status='interrupted',
        reason=CASE
          WHEN reason='' THEN '服务在好友评估完成前重启'
          ELSE reason
        END,
        completed_at=?,
        updated_at=?
      WHERE status IN ('queued','reviewing')
    `).run(now, now);
    // 每次进程启动清一次台账（见 pruneLedgers）：这三张表只增不删会一直涨
    try { this.pruneLedgers(); } catch { /* 清理失败不影响启动 */ }
  }

  /**
   * 台账保留期清理：删掉 N 天前**已了结**的行。
   * 三张表都是"每次事件写一行"的账本（好友机会 / 提议 / 收到的加好友请求），
   * 没有保留策略的话会无限增长：设置页要一直翻、备份也跟着变大。
   * 未决状态不删 —— 那是等管理员处理的待办，删掉等于把它丢掉。
   */
  pruneLedgers(retentionDays = 90) {
    const cutoff = Date.now() - Math.max(1, Number(retentionDays) || 90) * 24 * 60 * 60 * 1000;
    // ⚠️ "未决"集合必须与实际状态名对齐：写错一个名字，删掉的就是"等管理员处理"的待办。
    //    2026-09-21 审查发现过一版错法（friend_proposals 抄了 incoming 的状态名，
    //    于是 approved_manual / sent 这些真·未决会被清掉）—— 所以这里直接引用上面两个常量。
    const inList = (set) => [...set].map((name) => `'${name}'`).join(', ');
    try {
      // 'skipped' 不能删：模型"跳过这个人"的冷却期就记在这一行的 completed_at 上
      // （skipCooldownDays 最长可配到 365 天，比这里的保留期长）——删了会对同一个人重新抽签
      this.db.prepare(`
        DELETE FROM friend_opportunities
        WHERE created_at < ? AND status NOT IN ('queued','reviewing','skipped')
      `).run(cutoff);
      // 冷却期（cooldownDays 最长 365 天）也读这几行：冷却没过期就先留着
      this.db.prepare(`
        DELETE FROM friend_proposals
        WHERE created_at < ? AND status NOT IN (${inList(OPEN_FRIEND_PROPOSAL_STATES)})
          AND cooldown_until < ?
      `).run(cutoff, cutoff);
      this.db.prepare(`
        DELETE FROM incoming_friend_requests
        WHERE created_at < ? AND status NOT IN (${inList(OPEN_INCOMING_REQUEST_STATES)})
      `).run(cutoff);
    } catch { /* 清理失败不影响运行 */ }
  }

  /** 每日低峰维护：截断 WAL 并刷新查询计划统计；失败不抛（由保留期调度统一记日志）。 */
  maintain() {
    let checkpointed = false;
    let optimized = false;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); checkpointed = true; } catch { /* busy/只读副本 */ }
    try { this.db.exec('PRAGMA optimize'); optimized = true; } catch { /* 老 SQLite 没有 optimize 也继续 */ }
    return { checkpointed, optimized };
  }

  close() {
    this.db.close();
  }

  rebuild({ activityRows = [], legacyMemories = [], friends = [], now = Date.now() } = {}) {
    const people = new Map();
    const sources = new Map();
    const aliases = new Map();
    const memories = new Map();
    const friendMap = new Map();
    const overrides = new Map(this.db.prepare(
      'SELECT * FROM identity_asset_overrides'
    ).all().map((row) => [String(row.uin), row]));
    const hiddenUins = new Set(
      [...overrides.values()]
        .filter((row) => Number(row.deleted) === 1)
        .map((row) => String(row.uin))
    );

    const person = (uin) => {
      if (!people.has(uin)) {
        people.set(uin, {
          uin,
          primaryName: '',
          firstSeenAt: 0,
          lastSeenAt: 0,
          messageCount: 0,
          chatCount: 0,
          isFriend: false,
          legacyMemoryCount: 0
        });
      }
      return people.get(uin);
    };

    for (const friend of friends || []) {
      const uin = normalizeUin(friend?.userId ?? friend?.user_id);
      if (!uin || hiddenUins.has(uin)) continue;
      const name = cleanName(friend?.remark || friend?.name || friend?.nickname);
      friendMap.set(uin, name);
      const row = person(uin);
      row.isFriend = true;
      if (name) row.primaryName = name;
    }

    for (const raw of activityRows || []) {
      const uin = normalizeUin(raw?.userId);
      const chatKey = String(raw?.chatKey || '');
      if (!uin || hiddenUins.has(uin) || !/^(group|private):\d+$/.test(chatKey)) continue;
      const count = Math.max(0, Number(raw.messageCount) || 0);
      const firstSeenAt = Number(raw.firstSeenAt) || 0;
      const lastSeenAt = Number(raw.lastSeenAt) || 0;
      const sourceKey = `${uin}\u0000${chatKey}`;
      const source = sources.get(sourceKey) || {
        uin, chatKey, messageCount: 0, firstSeenAt: 0, lastSeenAt: 0
      };
      source.messageCount += count;
      source.firstSeenAt = source.firstSeenAt
        ? Math.min(source.firstSeenAt, firstSeenAt || source.firstSeenAt)
        : firstSeenAt;
      source.lastSeenAt = Math.max(source.lastSeenAt, lastSeenAt);
      sources.set(sourceKey, source);

      const name = cleanName(raw.name);
      if (name) {
        const aliasKey = `${sourceKey}\u0000${name}`;
        const alias = aliases.get(aliasKey) || {
          uin, chatKey, alias: name, seenCount: 0, firstSeenAt: 0, lastSeenAt: 0
        };
        alias.seenCount += count;
        alias.firstSeenAt = alias.firstSeenAt
          ? Math.min(alias.firstSeenAt, firstSeenAt || alias.firstSeenAt)
          : firstSeenAt;
        alias.lastSeenAt = Math.max(alias.lastSeenAt, lastSeenAt);
        aliases.set(aliasKey, alias);
      }

      const row = person(uin);
      row.messageCount += count;
      row.firstSeenAt = row.firstSeenAt
        ? Math.min(row.firstSeenAt, firstSeenAt || row.firstSeenAt)
        : firstSeenAt;
      if (lastSeenAt >= row.lastSeenAt && name && !friendMap.has(uin)) {
        row.primaryName = name;
      }
      row.lastSeenAt = Math.max(row.lastSeenAt, lastSeenAt);
    }

    for (const raw of legacyMemories || []) {
      const uin = normalizeUin(raw?.userId);
      const chatKey = String(raw?.chatKey || '');
      const content = cleanMemory(raw?.content);
      if (
        !uin
        || hiddenUins.has(uin)
        || !/^(group|private):\d+$/.test(chatKey)
        || !content
      ) continue;
      const key = `${uin}\u0000${chatKey}\u0000${content}`;
      memories.set(key, {
        uin,
        chatKey,
        content,
        observedAt: Number(raw.observedAt) || 0,
        sourceFile: String(raw.sourceFile || '').slice(0, 500)
      });
      person(uin);
    }

    for (const override of overrides.values()) {
      if (Number(override.deleted) === 1) continue;
      const uin = normalizeUin(override.uin);
      if (!uin) continue;
      const row = person(uin);
      const manualName = cleanName(override.primary_name);
      if (manualName) row.primaryName = manualName;
      if (override.is_friend !== null && override.is_friend !== undefined) {
        row.isFriend = Boolean(override.is_friend);
      }
      const chatKey = String(override.source_chat_key || '');
      if (/^(group|private):\d+$/.test(chatKey)) {
        const sourceKey = `${uin}\u0000${chatKey}`;
        if (!sources.has(sourceKey)) {
          sources.set(sourceKey, {
            uin,
            chatKey,
            messageCount: 0,
            firstSeenAt: Number(override.created_at) || now,
            lastSeenAt: Number(override.updated_at) || now
          });
        }
      }
    }

    for (const source of sources.values()) {
      person(source.uin).chatCount += 1;
    }
    for (const memory of memories.values()) {
      person(memory.uin).legacyMemoryCount += 1;
    }

    const previous = new Map(this.db.prepare(
      'SELECT uin, profile_json, profile_updated_at, created_at FROM people'
    ).all().map((row) => [String(row.uin), row]));

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM identity_aliases; DELETE FROM identity_sources; DELETE FROM legacy_memory_refs; DELETE FROM people;');
      const insertPerson = this.db.prepare(`
        INSERT INTO people (
          uin, primary_name, first_seen_at, last_seen_at, message_count, chat_count,
          is_friend, legacy_memory_count, profile_json, profile_updated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of people.values()) {
        const old = previous.get(row.uin);
        const override = overrides.get(row.uin);
        insertPerson.run(
          row.uin,
          cleanName(override?.primary_name) || friendMap.get(row.uin) || row.primaryName,
          row.firstSeenAt,
          row.lastSeenAt,
          row.messageCount,
          row.chatCount,
          override?.is_friend === null || override?.is_friend === undefined
            ? (row.isFriend ? 1 : 0)
            : (Number(override.is_friend) ? 1 : 0),
          row.legacyMemoryCount,
          override?.profile_json || old?.profile_json || '{}',
          Number(override?.updated_at) || Number(old?.profile_updated_at) || 0,
          Number(old?.created_at) || now,
          now
        );
      }
      for (const uin of friendMap.keys()) {
        this.db.prepare(`
          UPDATE friend_proposals
          SET status='accepted', decided_at=CASE WHEN decided_at=0 THEN ? ELSE decided_at END,
            updated_at=?
          WHERE uin=? AND status IN (
            'pending','approved_manual','dispatching','sent','held_unknown','failed'
          )
        `).run(now, now, uin);
        this.db.prepare(`
          UPDATE incoming_friend_requests
          SET status='accepted',
            action_completed_at=CASE
              WHEN action_completed_at=0 THEN ? ELSE action_completed_at
            END,
            updated_at=?
          WHERE uin=? AND status IN (
            'pending','deciding','approved','held_unknown','failed'
          )
        `).run(now, now, uin);
      }

      const insertSource = this.db.prepare(`
        INSERT INTO identity_sources
          (uin, chat_key, message_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of sources.values()) {
        insertSource.run(
          row.uin, row.chatKey, row.messageCount, row.firstSeenAt, row.lastSeenAt
        );
      }

      const insertAlias = this.db.prepare(`
        INSERT INTO identity_aliases
          (uin, chat_key, alias, seen_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of aliases.values()) {
        insertAlias.run(
          row.uin, row.chatKey, row.alias, row.seenCount, row.firstSeenAt, row.lastSeenAt
        );
      }

      const insertMemory = this.db.prepare(`
        INSERT INTO legacy_memory_refs
          (uin, chat_key, content, observed_at, source_file)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of memories.values()) {
        insertMemory.run(
          row.uin, row.chatKey, row.content, row.observedAt, row.sourceFile
        );
      }
      this.db.prepare(`
        INSERT INTO identity_meta(key, value) VALUES ('last_indexed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(String(now));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.status();
  }

  observe(chatKey, message) {
    const uin = normalizeUin(message?.senderId);
    const source = String(chatKey || '');
    if (!uin || !/^(group|private):\d+$/.test(source) || message?.self) return false;
    const override = this.db.prepare(
      'SELECT primary_name, deleted FROM identity_asset_overrides WHERE uin=?'
    ).get(uin);
    if (Number(override?.deleted) === 1) return false;
    const observedName = cleanName(message?.senderName);
    const primaryName = cleanName(override?.primary_name) || observedName;
    const at = Number(message?.ts) || Date.now();
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO people (
          uin, primary_name, first_seen_at, last_seen_at, message_count, chat_count,
          is_friend, legacy_memory_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 1, 0, 0, ?, ?)
        ON CONFLICT(uin) DO UPDATE SET
          primary_name=CASE WHEN excluded.primary_name!='' THEN excluded.primary_name ELSE people.primary_name END,
          first_seen_at=CASE WHEN people.first_seen_at=0 THEN excluded.first_seen_at ELSE MIN(people.first_seen_at, excluded.first_seen_at) END,
          last_seen_at=MAX(people.last_seen_at, excluded.last_seen_at),
          message_count=people.message_count+1,
          updated_at=excluded.updated_at
      `).run(uin, primaryName, at, at, now, now);
      this.db.prepare(`
        INSERT INTO identity_sources
          (uin, chat_key, message_count, first_seen_at, last_seen_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(uin, chat_key) DO UPDATE SET
          message_count=identity_sources.message_count+1,
          first_seen_at=CASE WHEN identity_sources.first_seen_at=0 THEN excluded.first_seen_at ELSE MIN(identity_sources.first_seen_at, excluded.first_seen_at) END,
          last_seen_at=MAX(identity_sources.last_seen_at, excluded.last_seen_at)
      `).run(uin, source, at, at);
      if (observedName) {
        this.db.prepare(`
          INSERT INTO identity_aliases
            (uin, chat_key, alias, seen_count, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(uin, chat_key, alias) DO UPDATE SET
            seen_count=identity_aliases.seen_count+1,
            first_seen_at=CASE WHEN identity_aliases.first_seen_at=0 THEN excluded.first_seen_at ELSE MIN(identity_aliases.first_seen_at, excluded.first_seen_at) END,
            last_seen_at=MAX(identity_aliases.last_seen_at, excluded.last_seen_at)
        `).run(uin, source, observedName, at, at);
      }
      this.db.prepare(`
        UPDATE people SET chat_count=(
          SELECT COUNT(*) FROM identity_sources WHERE identity_sources.uin=people.uin
        ) WHERE uin=?
      `).run(uin);
      this.db.prepare(`
        INSERT INTO identity_meta(key, value) VALUES ('last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(String(now));
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  status() {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS people,
        COALESCE(SUM(message_count),0) AS messages,
        COALESCE(SUM(is_friend),0) AS friends,
        COALESCE(SUM(legacy_memory_count),0) AS legacyMemories
      FROM people
    `).get();
    const aliases = this.db.prepare('SELECT COUNT(*) AS count FROM identity_aliases').get();
    const sources = this.db.prepare('SELECT COUNT(*) AS count FROM identity_sources').get();
    const indexed = this.db.prepare(
      "SELECT value FROM identity_meta WHERE key='last_indexed_at'"
    ).get();
    return {
      people: Number(totals.people) || 0,
      messages: Number(totals.messages) || 0,
      friends: Number(totals.friends) || 0,
      legacyMemories: Number(totals.legacyMemories) || 0,
      aliases: Number(aliases.count) || 0,
      sources: Number(sources.count) || 0,
      lastIndexedAt: Number(indexed?.value) || 0
    };
  }

  listPeople(limit = 100) {
    const rows = this.db.prepare(`
      SELECT p.*,
        CASE WHEN o.uin IS NULL THEN 0 ELSE 1 END AS manually_managed,
        COALESCE(
          NULLIF(o.source_chat_key, ''),
          (SELECT s.chat_key FROM identity_sources s
            WHERE s.uin=p.uin ORDER BY s.last_seen_at DESC LIMIT 1),
          ''
        ) AS manual_source_chat_key
      FROM people p
      LEFT JOIN identity_asset_overrides o ON o.uin=p.uin AND o.deleted=0
      ORDER BY p.last_seen_at DESC, p.message_count DESC, p.uin
      LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 100)));
    const aliasStmt = this.db.prepare(`
      SELECT alias, chat_key AS chatKey, seen_count AS seenCount,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM identity_aliases WHERE uin=?
      ORDER BY last_seen_at DESC, seen_count DESC
    `);
    return rows.map((row) => identityPersonView(row, aliasStmt.all(row.uin)));
  }

  listKnownFriends() {
    return this.db.prepare(`
      SELECT uin AS userId, primary_name AS nickname
      FROM people WHERE is_friend=1
      ORDER BY uin
    `).all().map((row) => ({
      userId: String(row.userId),
      nickname: String(row.nickname || '')
    }));
  }

  replaceKnownFriends(friends = [], now = Date.now()) {
    const normalized = new Map();
    for (const friend of friends) {
      const uin = normalizeUin(friend?.userId ?? friend?.user_id);
      if (!uin) continue;
      normalized.set(
        uin,
        cleanName(friend?.remark || friend?.name || friend?.nickname)
      );
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE people SET is_friend=0, updated_at=?').run(now);
      const upsert = this.db.prepare(`
        INSERT INTO people (
          uin, primary_name, first_seen_at, last_seen_at, message_count,
          chat_count, is_friend, legacy_memory_count, created_at, updated_at
        ) VALUES (?, ?, 0, 0, 0, 0, 1, 0, ?, ?)
        ON CONFLICT(uin) DO UPDATE SET
          primary_name=CASE
            WHEN excluded.primary_name!='' THEN excluded.primary_name
            ELSE people.primary_name
          END,
          is_friend=1,
          updated_at=excluded.updated_at
      `);
      for (const [uin, name] of normalized) {
        upsert.run(uin, name, now, now);
        this.db.prepare(`
          UPDATE friend_proposals
          SET status='accepted',
            decided_at=CASE WHEN decided_at=0 THEN ? ELSE decided_at END,
            updated_at=?
          WHERE uin=? AND status IN (
            'pending','approved_manual','dispatching','sent','held_unknown','failed'
          )
        `).run(now, now, uin);
        this.db.prepare(`
          UPDATE incoming_friend_requests
          SET status='accepted',
            action_completed_at=CASE
              WHEN action_completed_at=0 THEN ? ELSE action_completed_at
            END,
            updated_at=?
          WHERE uin=? AND status IN (
            'pending','deciding','approved','held_unknown','failed'
          )
        `).run(now, now, uin);
        this.db.prepare(`
          UPDATE friend_opportunities
          SET status='cancelled', reason='already-friend',
            completed_at=?, updated_at=?
          WHERE account_uin!='' AND uin=?
            AND status IN ('queued','reviewing')
        `).run(now, now, uin);
      }
      // 2026-10-06 复审 P2：管理员经身份资产手工标记的 is_friend 是持久 override（重建路径
      // 尊重它），快照刷新却把它无差别清零 —— ≤15 分钟内"已是好友"闸门失效，可对同一人
      // 重复发申请。归零/好友回填之后把**非空** override 补回来；is_friend 为 NULL 的
      // override 不动（与重建路径 `override?.is_friend == null ? 行值 : override 值` 同口径）。
      const reapply = this.db.prepare('UPDATE people SET is_friend=?, updated_at=? WHERE uin=?');
      for (const override of this.db.prepare(
        'SELECT uin, is_friend FROM identity_asset_overrides WHERE deleted=0 AND is_friend IS NOT NULL'
      ).all()) {
        const overrideUin = normalizeUin(override.uin);
        if (overrideUin) reapply.run(Number(override.is_friend) ? 1 : 0, now, overrideUin);
      }
      this.db.prepare(`
        INSERT INTO identity_meta(key, value) VALUES ('friend_snapshot_at', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(String(now));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return normalized.size;
  }

  isKnownFriend(userId) {
    const uin = normalizeUin(userId);
    if (!uin) return false;
    return Boolean(this.db.prepare(
      'SELECT 1 FROM people WHERE uin=? AND is_friend=1'
    ).get(uin));
  }

  lastFriendOpportunityAt(accountUin, userId) {
    const account = normalizeUin(accountUin);
    const uin = normalizeUin(userId);
    if (!account || !uin) return 0;
    return Number(this.db.prepare(`
      SELECT MAX(created_at) AS at
      FROM friend_opportunities
      WHERE account_uin=? AND uin=?
    `).get(account, uin)?.at) || 0;
  }

  triggeredCandidateBlockReason(userId, sourceChatKey, {
    accountUin = '',
    now = Date.now(),
    drawCooldownMs = 0,
    dayStart = 0,
    maxDrawsPerDay = 0
  } = {}) {
    const uin = normalizeUin(userId);
    const source = String(sourceChatKey || '');
    const account = normalizeUin(accountUin);
    if (!uin || !/^(group|private):\d+$/.test(source)) return 'invalid-candidate';
    const person = this.db.prepare('SELECT is_friend FROM people WHERE uin=?').get(uin);
    if (!person || !this.hasSource(uin, source)) return 'unknown-person';
    if (Number(person.is_friend)) return 'already-friend';
    const latestProposal = this.db.prepare(`
      SELECT status, cooldown_until
      FROM friend_proposals
      WHERE uin=?
      ORDER BY created_at DESC LIMIT 1
    `).get(uin);
    if (latestProposal && OPEN_FRIEND_PROPOSAL_STATES.has(String(latestProposal.status))) {
      return 'proposal-open';
    }
    if (Number(latestProposal?.cooldown_until) > now) return 'proposal-cooldown';
    const incoming = this.db.prepare(`
      SELECT 1 FROM incoming_friend_requests
      WHERE uin=? AND status IN ('pending','deciding','approved','held_unknown')
      LIMIT 1
    `).get(uin);
    if (incoming) return 'incoming-request-open';
    const running = this.db.prepare(`
      SELECT 1 FROM friend_opportunities
      WHERE account_uin=? AND uin=? AND status IN ('queued','reviewing')
      LIMIT 1
    `).get(account, uin);
    if (running) return 'review-open';
    const latest = this.db.prepare(`
      SELECT created_at, status, completed_at, config_json
      FROM friend_opportunities
      WHERE account_uin=? AND uin=?
      ORDER BY created_at DESC LIMIT 1
    `).get(account, uin);
    if (latest && Number(drawCooldownMs) > 0
      && Number(latest.created_at) + Number(drawCooldownMs) > now) {
      return 'draw-cooldown';
    }
    if (latest?.status === 'skipped') {
      const config = parseJsonObject(latest.config_json);
      const until = Number(latest.completed_at)
        + Math.max(0, Number(config.skipCooldownDays) || 0) * 86400000;
      if (until > now) return 'model-skip-cooldown';
    }
    if (latest?.status === 'review_failed') {
      const config = parseJsonObject(latest.config_json);
      const until = Number(latest.completed_at)
        + Math.max(0, Number(config.errorCooldownMinutes) || 0) * 60000;
      if (until > now) return 'review-error-cooldown';
    }
    if (Number(maxDrawsPerDay) > 0) {
      const draws = Number(this.db.prepare(`
        SELECT COUNT(*) AS n FROM friend_opportunities
        WHERE account_uin=? AND uin=? AND created_at>=?
      `).get(account, uin, Math.max(0, Number(dayStart) || 0)).n) || 0;
      if (draws >= Number(maxDrawsPerDay)) return 'daily-draw-limit';
    }
    return '';
  }

  createFriendOpportunity({
    accountUin,
    userId,
    sourceChatKey,
    parentSessionId = '',
    triggerKey,
    triggerMessageIds = [],
    triggerReason = '',
    eligibility = {},
    config = {},
    probability = 0.05,
    randomValue = 1,
    dayStart = 0,
    maxDrawsPerDay = 6,
    maxReviewsPerDay = 10,
    drawCooldownMs = 1800000,
    now = Date.now()
  }) {
    const account = normalizeUin(accountUin);
    const uin = normalizeUin(userId);
    const source = String(sourceChatKey || '');
    const key = String(triggerKey || '').trim().slice(0, 500);
    if (!account || !uin || !/^(group|private):\d+$/.test(source) || !key) {
      return { created: false, reason: 'invalid-candidate', opportunity: null };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.db.prepare(
        'SELECT * FROM friend_opportunities WHERE trigger_key=?'
      ).get(key);
      if (duplicate) {
        this.db.exec('COMMIT');
        return {
          created: false,
          reason: 'duplicate-trigger',
          opportunity: friendOpportunityView(duplicate)
        };
      }
      const blocked = this.triggeredCandidateBlockReason(uin, source, {
        accountUin: account,
        now,
        drawCooldownMs,
        dayStart,
        maxDrawsPerDay
      });
      if (blocked) {
        this.db.exec('COMMIT');
        return { created: false, reason: blocked, opportunity: null };
      }
      const chance = Math.min(1, Math.max(0, Number(probability) || 0));
      const selected = chance >= 1
        || (chance > 0 && Number(randomValue) < chance);
      let status = selected ? 'queued' : 'lottery_miss';
      let reason = selected ? '' : 'lottery-miss';
      if (selected) {
        const reviews = Number(this.db.prepare(`
          SELECT COUNT(*) AS n FROM friend_opportunities
          WHERE account_uin=? AND created_at>=?
            AND status IN ('queued','reviewing','skipped','proposed','review_failed')
        `).get(account, Math.max(0, Number(dayStart) || 0)).n) || 0;
        if (reviews >= Math.max(0, Number(maxReviewsPerDay) || 0)) {
          status = 'review_budget';
          reason = 'daily-review-limit';
        }
      }
      const id = `fo_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      this.db.prepare(`
        INSERT INTO friend_opportunities (
          id, account_uin, uin, source_chat_key, parent_session_id,
          trigger_key, trigger_message_ids, trigger_reason, status, reason,
          probability, random_value, eligibility_json, config_json,
          created_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        account,
        uin,
        source,
        String(parentSessionId || '').slice(0, 100),
        key,
        JSON.stringify(triggerMessageIds),
        cleanMemory(triggerReason),
        status,
        reason,
        chance,
        Number(randomValue),
        JSON.stringify(eligibility),
        JSON.stringify(config),
        now,
        ['lottery_miss', 'review_budget'].includes(status) ? now : 0,
        now
      );
      this.db.exec('COMMIT');
      return {
        created: true,
        reason,
        opportunity: this.getFriendOpportunity(id)
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getFriendOpportunity(id) {
    return friendOpportunityView(this.db.prepare(`
      SELECT fo.*, p.primary_name
      FROM friend_opportunities fo
      LEFT JOIN people p ON p.uin=fo.uin
      WHERE fo.id=?
    `).get(String(id || '')));
  }

  listFriendOpportunities({ status = '', limit = 100 } = {}) {
    const value = String(status || '').trim();
    const size = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = value
      ? this.db.prepare(`
          SELECT fo.*, p.primary_name
          FROM friend_opportunities fo
          LEFT JOIN people p ON p.uin=fo.uin
          WHERE fo.status=?
          ORDER BY fo.created_at DESC LIMIT ?
        `).all(value, size)
      : this.db.prepare(`
          SELECT fo.*, p.primary_name
          FROM friend_opportunities fo
          LEFT JOIN people p ON p.uin=fo.uin
          ORDER BY fo.created_at DESC LIMIT ?
        `).all(size);
    return rows.map(friendOpportunityView);
  }

  beginFriendReview(id, now = Date.now()) {
    const opportunity = this.getFriendOpportunity(id);
    if (!opportunity) throw new Error('好友评估机会不存在');
    if (opportunity.status !== 'queued') {
      throw new Error(`好友评估机会状态已改变：${opportunity.status}`);
    }
    if (this.isKnownFriend(opportunity.userId)) {
      this.finishFriendReview(id, 'cancelled', {
        reason: 'already-friend',
        now
      });
      return null;
    }
    const result = this.db.prepare(`
      UPDATE friend_opportunities
      SET status='reviewing', started_at=?, updated_at=?
      WHERE id=? AND status='queued'
    `).run(now, now, opportunity.id);
    if (result.changes !== 1) throw new Error('好友评估机会已被其他任务处理');
    return this.getFriendOpportunity(opportunity.id);
  }

  finishFriendReview(id, status, {
    reason = '',
    review = {},
    usage = {},
    model = '',
    proposal = null,
    now = Date.now()
  } = {}) {
    if (!['skipped', 'proposed', 'review_failed', 'cancelled', 'expired'].includes(status)) {
      throw new Error('好友评估结果状态无效');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const opportunity = this.getFriendOpportunity(id);
      if (!opportunity) throw new Error('好友评估机会不存在');
      if (!['queued', 'reviewing'].includes(opportunity.status)) {
        throw new Error(`好友评估机会状态已改变：${opportunity.status}`);
      }
      let finalStatus = status;
      let finalReason = cleanMemory(reason);
      let proposalId = '';
      if (this.isKnownFriend(opportunity.userId)) {
        finalStatus = 'cancelled';
        finalReason = 'already-friend';
      } else if (status === 'proposed') {
        const latestProposal = this.db.prepare(`
          SELECT status, cooldown_until
          FROM friend_proposals
          WHERE uin=?
          ORDER BY created_at DESC LIMIT 1
        `).get(opportunity.userId);
        if (
          latestProposal
          && OPEN_FRIEND_PROPOSAL_STATES.has(String(latestProposal.status))
        ) {
          finalStatus = 'cancelled';
          finalReason = 'proposal-open';
        } else if (Number(latestProposal?.cooldown_until) > now) {
          finalStatus = 'cancelled';
          finalReason = 'proposal-cooldown';
        } else {
          const pending = Number(this.db.prepare(
            "SELECT COUNT(*) AS n FROM friend_proposals WHERE status='pending'"
          ).get().n) || 0;
          const maxPending = Math.min(
            100,
            Math.max(1, Number(proposal?.maxPending) || 10)
          );
          if (pending >= maxPending) {
            finalStatus = 'cancelled';
            finalReason = 'pending-limit';
          } else {
            proposalId = `fp_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
            const cooldownUntil = now + Math.min(
              365,
              Math.max(1, Number(proposal?.cooldownDays) || 30)
            ) * 86400000;
            this.db.prepare(`
              INSERT INTO friend_proposals (
                id, uin, source_chat_key, reason_code, reason,
                verification_message, status, created_at, cooldown_until,
                updated_at, opportunity_id
              ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
            `).run(
              proposalId,
              opportunity.userId,
              opportunity.sourceChatKey,
              FRIEND_PROPOSAL_REASONS.has(proposal?.reasonCode)
                ? proposal.reasonCode
                : 'interest',
              cleanMemory(proposal?.reason).slice(0, 240),
              cleanMemory(proposal?.verificationMessage).slice(0, 50),
              now,
              cooldownUntil,
              now,
              opportunity.id
            );
          }
        }
      }
      this.db.prepare(`
        UPDATE friend_opportunities
        SET status=?, reason=?, review_json=?, usage_json=?, model=?,
          proposal_id=?, completed_at=?, updated_at=?
        WHERE id=?
      `).run(
        finalStatus,
        finalReason,
        JSON.stringify(review),
        JSON.stringify(usage),
        String(model || '').slice(0, 200),
        proposalId,
        now,
        now,
        opportunity.id
      );
      this.db.exec('COMMIT');
      return {
        opportunity: this.getFriendOpportunity(opportunity.id),
        proposal: proposalId ? this.getFriendProposal(proposalId) : null
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cancelFriendReviews(reason = 'feature-reconfigured', now = Date.now()) {
    return this.db.prepare(`
      UPDATE friend_opportunities
      SET status='cancelled', reason=?, completed_at=?, updated_at=?
      WHERE status IN ('queued','reviewing')
    `).run(cleanMemory(reason), now, now).changes;
  }

  friendOpportunityStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(status='lottery_miss') AS lotteryMiss,
        SUM(status='review_budget') AS reviewBudget,
        SUM(status IN ('queued','reviewing')) AS active,
        SUM(status='skipped') AS skipped,
        SUM(status='proposed') AS proposed,
        SUM(status='review_failed') AS reviewFailed,
        SUM(status IN ('cancelled','expired','interrupted')) AS cancelled
      FROM friend_opportunities
    `).get();
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      Number(value) || 0
    ]));
  }

  upsertIdentityAsset({
    userId,
    primaryName = '',
    chatKey = '',
    isFriend = false,
    profileNote = '',
    now = Date.now()
  }) {
    const uin = normalizeUin(userId);
    const name = cleanName(primaryName);
    if (!uin) throw new Error('人物 QQ 号必须为正整数');
    if (!name) throw new Error('人物名称不能为空');
    const existing = this.db.prepare(
      'SELECT profile_json FROM people WHERE uin=?'
    ).get(uin);
    const existingSource = this.db.prepare(`
      SELECT chat_key FROM identity_sources
      WHERE uin=? ORDER BY last_seen_at DESC LIMIT 1
    `).get(uin);
    const source = String(chatKey || existingSource?.chat_key || '').trim();
    if (source && !/^(group|private):\d+$/.test(source)) {
      throw new Error('来源会话格式必须为 group:<群号> 或 private:<QQ号>');
    }
    if (!existing && !source) throw new Error('新增人物必须指定来源会话');
    let profile = {};
    try {
      const parsed = JSON.parse(existing?.profile_json || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) profile = parsed;
    } catch { /* replace malformed profile with a clean object */ }
    const note = cleanMemory(profileNote);
    if (note) profile.note = note;
    else delete profile.note;
    const profileJson = JSON.stringify(profile);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO identity_asset_overrides (
          uin, primary_name, profile_json, is_friend, source_chat_key,
          deleted, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(uin) DO UPDATE SET
          primary_name=excluded.primary_name,
          profile_json=excluded.profile_json,
          is_friend=excluded.is_friend,
          source_chat_key=excluded.source_chat_key,
          deleted=0,
          updated_at=excluded.updated_at
      `).run(uin, name, profileJson, isFriend ? 1 : 0, source, now, now);
      this.db.prepare(`
        INSERT INTO people (
          uin, primary_name, first_seen_at, last_seen_at, message_count, chat_count,
          is_friend, legacy_memory_count, profile_json, profile_updated_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?)
        ON CONFLICT(uin) DO UPDATE SET
          primary_name=excluded.primary_name,
          is_friend=excluded.is_friend,
          profile_json=excluded.profile_json,
          profile_updated_at=excluded.profile_updated_at,
          updated_at=excluded.updated_at
      `).run(uin, name, now, now, isFriend ? 1 : 0, profileJson, now, now, now);
      if (source) {
        this.db.prepare(`
          INSERT INTO identity_sources (
            uin, chat_key, message_count, first_seen_at, last_seen_at
          ) VALUES (?, ?, 0, ?, ?)
          ON CONFLICT(uin, chat_key) DO NOTHING
        `).run(uin, source, now, now);
        this.db.prepare(`
          UPDATE people SET chat_count=(
            SELECT COUNT(*) FROM identity_sources WHERE identity_sources.uin=people.uin
          ) WHERE uin=?
        `).run(uin);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const row = this.db.prepare(`
      SELECT p.*,
        1 AS manually_managed,
        COALESCE(o.source_chat_key, '') AS manual_source_chat_key
      FROM people p
      JOIN identity_asset_overrides o ON o.uin=p.uin AND o.deleted=0
      WHERE p.uin=?
    `).get(uin);
    const aliases = this.db.prepare(`
      SELECT alias, chat_key AS chatKey, seen_count AS seenCount,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM identity_aliases WHERE uin=?
      ORDER BY last_seen_at DESC, seen_count DESC
    `).all(uin);
    return identityPersonView(row, aliases);
  }

  isIdentityAssetDeleted(userId) {
    const uin = normalizeUin(userId);
    return uin ? hasIdentityAssetTombstone(this.db, uin) : false;
  }

  deleteIdentityAsset(userId, now = Date.now()) {
    const uin = normalizeUin(userId);
    if (!uin) throw new Error('人物 QQ 号必须为正整数');
    const existing = this.db.prepare('SELECT 1 FROM people WHERE uin=?').get(uin);
    if (!existing) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 墓碑先落库：同一个事务里后续的取消/删除都基于它，避免并发链路
      // （friend_add 事件、启动重排）在事务提交前又把人加回白名单。
      this.db.prepare(`
        INSERT INTO identity_asset_overrides (
          uin, primary_name, profile_json, is_friend, source_chat_key,
          deleted, created_at, updated_at
        ) VALUES (?, '', '{}', NULL, '', 1, ?, ?)
        ON CONFLICT(uin) DO UPDATE SET
          deleted=1,
          updated_at=excluded.updated_at
      `).run(uin, now, now);
      // 留下现有 allow.private（删人物 ≠ 拉黑），但终止待批请求，防止批准后又被自动加白。
      cancelOpenFriendArtifacts(this.db, uin, now);
      this.db.prepare('DELETE FROM friend_proposals WHERE uin=?').run(uin);
      this.db.prepare('DELETE FROM people WHERE uin=?').run(uin);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createIncomingFriendRequest({
    userId,
    flag,
    comment = '',
    maxPending = 50,
    now = Date.now()
  }) {
    const uin = normalizeUin(userId);
    const requestFlag = String(flag || '').trim().slice(0, 500);
    if (!uin) throw new Error('好友请求必须包含有效 QQ 号');
    if (!requestFlag) throw new Error('好友请求缺少 OneBot flag');
    const existing = this.db.prepare(`
      SELECT r.*, p.primary_name
      FROM incoming_friend_requests r
      LEFT JOIN people p ON p.uin=r.uin
      WHERE r.request_flag=?
    `).get(requestFlag);
    if (existing) return { created: false, request: incomingRequestView(existing) };
    const openForUser = this.db.prepare(`
      SELECT r.*, p.primary_name
      FROM incoming_friend_requests r
      LEFT JOIN people p ON p.uin=r.uin
      WHERE r.uin=? AND r.status='pending'
      ORDER BY r.created_at DESC LIMIT 1
    `).get(uin);
    if (openForUser) {
      this.db.prepare(`
        UPDATE incoming_friend_requests
        SET request_flag=?, comment=?, updated_at=?
        WHERE id=? AND status='pending'
      `).run(requestFlag, cleanMemory(comment), now, openForUser.id);
      return {
        created: false,
        refreshed: true,
        request: this.getIncomingFriendRequest(openForUser.id)
      };
    }
    const pending = Number(this.db.prepare(`
      SELECT COUNT(*) AS n FROM incoming_friend_requests WHERE status='pending'
    `).get().n) || 0;
    if (pending >= Math.min(500, Math.max(1, Number(maxPending) || 50))) {
      throw new Error('待审批入站好友请求已达上限');
    }
    const id = `fr_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    this.db.prepare(`
      INSERT INTO incoming_friend_requests (
        id, request_flag, uin, comment, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, requestFlag, uin, cleanMemory(comment), now, now);
    return { created: true, request: this.getIncomingFriendRequest(id) };
  }

  getIncomingFriendRequest(id) {
    return incomingRequestView(this.db.prepare(`
      SELECT r.*, p.primary_name
      FROM incoming_friend_requests r
      LEFT JOIN people p ON p.uin=r.uin
      WHERE r.id=?
    `).get(String(id || '').trim()));
  }

  listIncomingFriendRequests({ status = '', limit = 100 } = {}) {
    const normalizedStatus = String(status || '').trim();
    const size = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = normalizedStatus
      ? this.db.prepare(`
          SELECT r.*, p.primary_name
          FROM incoming_friend_requests r
          LEFT JOIN people p ON p.uin=r.uin
          WHERE r.status=?
          ORDER BY r.created_at DESC LIMIT ?
        `).all(normalizedStatus, size)
      : this.db.prepare(`
          SELECT r.*, p.primary_name
          FROM incoming_friend_requests r
          LEFT JOIN people p ON p.uin=r.uin
          ORDER BY r.created_at DESC LIMIT ?
        `).all(size);
    return rows.map(incomingRequestView);
  }

  markIncomingFriendRequestNotification(
    id,
    { notified = false, error = '', now = Date.now() } = {}
  ) {
    this.db.prepare(`
      UPDATE incoming_friend_requests
      SET notified_at=?, notify_error=?, updated_at=?
      WHERE id=?
    `).run(
      notified ? now : 0,
      String(error || '').slice(0, 500),
      now,
      String(id || '')
    );
    return this.getIncomingFriendRequest(id);
  }

  beginIncomingFriendRequestDecision(
    id,
    decision,
    { decidedBy = '', now = Date.now() } = {}
  ) {
    const request = this.getIncomingFriendRequest(id);
    if (!request) throw new Error('入站好友请求不存在');
    if (request.status !== 'pending') throw new Error(`入站好友请求已处理：${request.status}`);
    if (!['approve', 'reject'].includes(decision)) {
      throw new Error('审批决定必须是 approve 或 reject');
    }
    const attemptId = `fi_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const result = this.db.prepare(`
      UPDATE incoming_friend_requests
      SET status='deciding', decision=?, decided_at=?, decided_by=?,
        action_attempt_id=?, action_started_at=?, action_completed_at=0,
        action_error='', updated_at=?
      WHERE id=? AND status='pending'
    `).run(
      decision,
      now,
      String(decidedBy || '').slice(0, 80),
      attemptId,
      now,
      now,
      request.id
    );
    if (result.changes !== 1) throw new Error('入站好友请求状态已改变，请刷新后重试');
    return {
      ...this.getIncomingFriendRequest(request.id),
      requestFlag: this.db.prepare(
        'SELECT request_flag AS requestFlag FROM incoming_friend_requests WHERE id=?'
      ).get(request.id).requestFlag
    };
  }

  completeIncomingFriendRequestDecision(
    id,
    attemptId,
    outcome,
    { error = '', now = Date.now() } = {}
  ) {
    if (!['approved', 'rejected', 'failed', 'held_unknown'].includes(outcome)) {
      throw new Error('入站好友请求处理结果无效');
    }
    const result = this.db.prepare(`
      UPDATE incoming_friend_requests
      SET status=?, action_completed_at=?, action_error=?, updated_at=?
      WHERE id=? AND status='deciding' AND action_attempt_id=?
    `).run(
      outcome,
      ['approved', 'rejected'].includes(outcome) ? now : 0,
      String(error || '').slice(0, 500),
      now,
      String(id || ''),
      String(attemptId || '')
    );
    if (result.changes !== 1) {
      const request = this.getIncomingFriendRequest(id);
      if (!request) throw new Error('入站好友请求不存在');
      if (request.status === 'accepted') return request;
      throw new Error(`入站好友请求状态已改变：${request.status}`);
    }
    return this.getIncomingFriendRequest(id);
  }

  markIncomingFriendWhitelist(
    id,
    { applied = false, error = '', now = Date.now() } = {}
  ) {
    this.db.prepare(`
      UPDATE incoming_friend_requests
      SET whitelist_applied=?, whitelist_error=?, updated_at=?
      WHERE id=?
    `).run(
      applied ? 1 : 0,
      String(error || '').slice(0, 500),
      now,
      String(id || '')
    );
    return this.getIncomingFriendRequest(id);
  }

  listFriendProposals({ status = '', limit = 100 } = {}) {
    const normalizedStatus = String(status || '').trim();
    const size = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = normalizedStatus
      ? this.db.prepare(`
          SELECT fp.*, p.primary_name
          FROM friend_proposals fp
          LEFT JOIN people p ON p.uin=fp.uin
          WHERE fp.status=?
          ORDER BY fp.created_at DESC
          LIMIT ?
        `).all(normalizedStatus, size)
      : this.db.prepare(`
          SELECT fp.*, p.primary_name
          FROM friend_proposals fp
          LEFT JOIN people p ON p.uin=fp.uin
          ORDER BY fp.created_at DESC
          LIMIT ?
        `).all(size);
    return rows.map(proposalView);
  }

  getFriendProposal(id) {
    return proposalView(this.db.prepare(`
      SELECT fp.*, p.primary_name
      FROM friend_proposals fp
      LEFT JOIN people p ON p.uin=fp.uin
      WHERE fp.id=?
    `).get(String(id || '').trim()));
  }

  createFriendProposal({
    userId,
    sourceChatKey,
    reasonCode,
    reason,
    verificationMessage = '',
    minMessageCount = 50,
    cooldownDays = 30,
    maxPending = 10,
    now = Date.now()
  }) {
    const uin = normalizeUin(userId);
    const source = String(sourceChatKey || '');
    const code = FRIEND_PROPOSAL_REASONS.has(reasonCode) ? reasonCode : '';
    const reasonText = cleanMemory(reason).slice(0, 240);
    const verification = cleanMemory(verificationMessage).slice(0, 50);
    if (!uin) throw new Error('好友候选必须使用数字 QQ 号');
    if (!/^(group|private):\d+$/.test(source)) throw new Error('好友候选来源会话无效');
    if (!code) throw new Error('好友候选原因必须是 interest、frequent 或 banter');
    if (!reasonText) throw new Error('好友候选必须说明具体原因');

    const person = this.db.prepare('SELECT * FROM people WHERE uin=?').get(uin);
    if (!person || !this.hasSource(uin, source)) {
      throw new Error('只能提议当前会话中已经出现过的人');
    }
    if (Number(person.is_friend)) throw new Error('对方已经是好友');
    const threshold = Math.min(10000, Math.max(1, Number(minMessageCount) || 50));
    if ((Number(person.message_count) || 0) < threshold) {
      throw new Error(`互动消息不足：当前 ${Number(person.message_count) || 0}，至少需要 ${threshold}`);
    }

    const latest = this.db.prepare(`
      SELECT fp.*, p.primary_name
      FROM friend_proposals fp
      LEFT JOIN people p ON p.uin=fp.uin
      WHERE fp.uin=?
      ORDER BY fp.created_at DESC
      LIMIT 1
    `).get(uin);
    if (latest && OPEN_FRIEND_PROPOSAL_STATES.has(String(latest.status))) {
      return { created: false, proposal: proposalView(latest), reason: 'already-open' };
    }
    if (latest && Number(latest.cooldown_until) > now) {
      throw new Error(`该用户仍在好友提议冷却期，${new Date(Number(latest.cooldown_until)).toLocaleString('zh-CN', { hour12: false })} 后可再次提议`);
    }
    const pending = Number(this.db.prepare(
      "SELECT COUNT(*) AS n FROM friend_proposals WHERE status='pending'"
    ).get().n) || 0;
    const pendingLimit = Math.min(100, Math.max(1, Number(maxPending) || 10));
    if (pending >= pendingLimit) throw new Error(`待审批好友候选已达上限 ${pendingLimit}`);

    const id = `fp_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const cooldownUntil = now + Math.min(365, Math.max(1, Number(cooldownDays) || 30))
      * 86400000;
    this.db.prepare(`
      INSERT INTO friend_proposals (
        id, uin, source_chat_key, reason_code, reason, verification_message,
        status, created_at, cooldown_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      id,
      uin,
      source,
      code,
      reasonText,
      verification,
      now,
      cooldownUntil,
      now
    );
    return { created: true, proposal: this.getFriendProposal(id), reason: '' };
  }

  markFriendProposalNotification(id, { notified = false, error = '', now = Date.now() } = {}) {
    this.db.prepare(`
      UPDATE friend_proposals
      SET notified_at=?, notify_error=?, updated_at=?
      WHERE id=?
    `).run(notified ? now : 0, String(error || '').slice(0, 500), now, String(id || ''));
    return this.getFriendProposal(id);
  }

  decideFriendProposal(id, decision, {
    decidedBy = '',
    dispatch = false,
    now = Date.now()
  } = {}) {
    const proposal = this.getFriendProposal(id);
    if (!proposal) throw new Error('好友候选不存在');
    if (proposal.status === 'accepted') return proposal;
    if (decision === 'approve' && proposal.status === 'approved_manual' && !dispatch) return proposal;
    if (proposal.status !== 'pending') throw new Error(`好友候选已处理：${proposal.status}`);
    const status = decision === 'approve'
      ? dispatch
        ? 'dispatching'
        : 'approved_manual'
      : decision === 'reject'
        ? 'rejected'
        : '';
    if (!status) throw new Error('审批决定必须是 approve 或 reject');
    const attemptId = status === 'dispatching'
      ? `fd_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
      : '';
    this.db.prepare(`
      UPDATE friend_proposals
      SET status=?, decided_at=?, decided_by=?,
        dispatch_attempt_id=?, dispatch_started_at=?,
        dispatched_at=0, dispatch_error='', updated_at=?
      WHERE id=? AND status='pending'
    `).run(
      status,
      now,
      String(decidedBy || ''),
      attemptId,
      status === 'dispatching' ? now : 0,
      now,
      proposal.id
    );
    return this.getFriendProposal(proposal.id);
  }

  completeFriendProposalDispatch(id, attemptId, outcome, {
    error = '',
    now = Date.now()
  } = {}) {
    const status = ['sent', 'held_unknown', 'failed'].includes(outcome)
      ? outcome
      : '';
    if (!status) throw new Error('好友申请发送结果无效');
    const result = this.db.prepare(`
      UPDATE friend_proposals
      SET status=?, dispatched_at=?, dispatch_error=?, updated_at=?
      WHERE id=? AND status='dispatching' AND dispatch_attempt_id=?
    `).run(
      status,
      status === 'sent' ? now : 0,
      String(error || '').slice(0, 500),
      now,
      String(id || ''),
      String(attemptId || '')
    );
    if (result.changes !== 1) {
      const proposal = this.getFriendProposal(id);
      if (!proposal) throw new Error('好友候选不存在');
      if (proposal.status === 'accepted') return proposal;
      throw new Error(`好友候选发送状态已改变：${proposal.status}`);
    }
    return this.getFriendProposal(id);
  }

  markFriendAdded(userId, now = Date.now()) {
    const uin = normalizeUin(userId);
    if (!uin) return 0;
    this.db.prepare('UPDATE people SET is_friend=1, updated_at=? WHERE uin=?').run(now, uin);
    const proposals = this.db.prepare(`
      UPDATE friend_proposals
      SET status='accepted', decided_at=CASE WHEN decided_at=0 THEN ? ELSE decided_at END,
        updated_at=?
      WHERE uin=? AND status IN (
        'pending','approved_manual','dispatching','sent','held_unknown','failed'
      )
    `).run(now, now, uin).changes;
    const incoming = this.db.prepare(`
      UPDATE incoming_friend_requests
      SET status='accepted',
        action_completed_at=CASE WHEN action_completed_at=0 THEN ? ELSE action_completed_at END,
        updated_at=?
      WHERE uin=? AND status IN ('pending','deciding','approved','held_unknown','failed')
    `).run(now, now, uin).changes;
    const opportunities = this.db.prepare(`
      UPDATE friend_opportunities
      SET status='cancelled', reason='already-friend',
        completed_at=?, updated_at=?
      WHERE uin=? AND status IN ('queued','reviewing')
    `).run(now, now, uin).changes;
    return { proposals, incoming, opportunities };
  }

  friendProposalStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='approved_manual' THEN 1 ELSE 0 END) AS approvedManual,
        SUM(CASE WHEN status='dispatching' THEN 1 ELSE 0 END) AS dispatching,
        SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status='held_unknown' THEN 1 ELSE 0 END) AS heldUnknown,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM friend_proposals
    `).get();
    return {
      total: Number(row.total) || 0,
      pending: Number(row.pending) || 0,
      approvedManual: Number(row.approvedManual) || 0,
      dispatching: Number(row.dispatching) || 0,
      sent: Number(row.sent) || 0,
      heldUnknown: Number(row.heldUnknown) || 0,
      failed: Number(row.failed) || 0,
      accepted: Number(row.accepted) || 0,
      rejected: Number(row.rejected) || 0
    };
  }

  incomingFriendRequestStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='deciding' THEN 1 ELSE 0 END) AS deciding,
        SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status='held_unknown' THEN 1 ELSE 0 END) AS heldUnknown,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM incoming_friend_requests
    `).get();
    return {
      total: Number(row.total) || 0,
      pending: Number(row.pending) || 0,
      deciding: Number(row.deciding) || 0,
      approved: Number(row.approved) || 0,
      heldUnknown: Number(row.heldUnknown) || 0,
      failed: Number(row.failed) || 0,
      accepted: Number(row.accepted) || 0,
      rejected: Number(row.rejected) || 0
    };
  }

  hasSource(userId, chatKey) {
    const uin = normalizeUin(userId);
    const source = String(chatKey || '');
    if (!uin || !source) return false;
    return Boolean(this.db.prepare(
      'SELECT 1 FROM identity_sources WHERE uin=? AND chat_key=?'
    ).get(uin, source));
  }

  /**
   * 返回适合模型使用的受限人物视图。
   * 原始跨会话记忆不会返回；模型只能看到当前会话的旧印象和聚合计数。
   */
  getPerson(userId, { chatKey, maxAliases = 8, maxMemories = 6 } = {}) {
    const uin = normalizeUin(userId);
    const source = String(chatKey || '');
    if (!uin || !source) return null;
    const row = this.db.prepare('SELECT * FROM people WHERE uin=?').get(uin);
    if (!row) return null;
    const sourceRow = this.db.prepare(`
      SELECT message_count AS messageCount, first_seen_at AS firstSeenAt,
        last_seen_at AS lastSeenAt
      FROM identity_sources WHERE uin=? AND chat_key=?
    `).get(uin, source);
    if (!sourceRow) return null;
    const aliases = this.db.prepare(`
      SELECT alias, chat_key AS chatKey, seen_count AS seenCount, last_seen_at AS lastSeenAt
      FROM identity_aliases WHERE uin=?
      ORDER BY last_seen_at DESC, seen_count DESC
    `).all(uin);
    const currentMemories = this.db.prepare(`
      SELECT content, observed_at AS observedAt
      FROM legacy_memory_refs
      WHERE uin=? AND chat_key=?
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `).all(uin, source, Math.min(12, Math.max(1, Number(maxMemories) || 6)));
    let profile = {};
    try { profile = JSON.parse(row.profile_json || '{}'); } catch { profile = {}; }
    const uniqueAliases = [];
    const seenAliases = new Set();
    for (const alias of aliases) {
      const name = cleanName(alias.alias);
      if (!name || seenAliases.has(name)) continue;
      seenAliases.add(name);
      uniqueAliases.push(name);
      if (uniqueAliases.length >= Math.min(20, Math.max(1, Number(maxAliases) || 8))) break;
    }
    const currentMemoryCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM legacy_memory_refs WHERE uin=? AND chat_key=?
    `).get(uin, source);
    return {
      userId: uin,
      primaryName: String(row.primary_name || ''),
      aliases: uniqueAliases,
      isFriend: Boolean(row.is_friend),
      firstSeenAt: Number(row.first_seen_at) || 0,
      lastSeenAt: Number(row.last_seen_at) || 0,
      messageCount: Number(row.message_count) || 0,
      chatCount: Number(row.chat_count) || 0,
      currentChatMessageCount: Number(sourceRow.messageCount) || 0,
      currentContextMemories: currentMemories.map((memory) => ({
        content: cleanMemory(memory.content).slice(0, 160),
        observedAt: Number(memory.observedAt) || 0
      })),
      otherContextMemoryCount: Math.max(
        0,
        (Number(row.legacy_memory_count) || 0) - (Number(currentMemoryCount.count) || 0)
      ),
      safeProfile: profile && typeof profile === 'object' ? profile : {}
    };
  }
}
