import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../core/sqlite.js';
import {
  asText, clamp, clampInt, lexicalScore, now, parseJson, stableJson, uuid
} from './util.js';

const MEMORY_TYPES = new Set(['episode', 'fact', 'profile', 'preference', 'commitment', 'project', 'rule']);
const MEMORY_STATUSES = new Set(['active', 'archived', 'superseded']);
const MAX_TURNS = 5000;
const MAX_TURN_PAYLOAD_CHARS = 16000;

function jsonArray(value, limit = 64, itemMax = 160) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => asText(item, itemMax)).filter(Boolean))].slice(0, limit);
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeDuplicateText(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 400);
}

function cappedJson(value, max = MAX_TURN_PAYLOAD_CHARS) {
  const text = stableJson(value);
  return text.length <= max ? text : stableJson({ truncated: true, chars: text.length });
}

function rowToMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeKey: row.scope_key,
    type: row.type,
    status: row.status,
    summary: row.summary,
    content: row.content,
    importance: Number(row.importance) || 0,
    confidence: Number(row.confidence) || 0,
    tags: parseJson(row.tags_json, []),
    topics: parseJson(row.topics_json, []),
    keyFacts: parseJson(row.key_facts_json, []),
    participants: parseJson(row.participants_json, []),
    sentiment: row.sentiment || 'neutral',
    source: parseJson(row.source_json, {}),
    entities: parseJson(row.entities_json, []),
    relations: parseJson(row.relations_json, []),
    vectorStatus: row.vector_status,
    vectorError: row.vector_error || '',
    embeddingModel: row.embedding_model || '',
    vectorDimensions: Number(row.vector_dimensions) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    expiresAt: Number(row.expires_at) || 0,
    archivedAt: Number(row.archived_at) || 0
  };
}

function scopeList(values) {
  const list = [...new Set((Array.isArray(values) ? values : []).map((item) => asText(item, 80)))]
    .filter((item) => /^(group|private):\d+$/.test(item) || item === 'owner-global');
  return list;
}

function searchText(memory) {
  return [memory.summary, memory.content, memory.tags.join(' '), memory.entities.join(' ')].join('\n');
}

function packVector(vector) {
  if (!Array.isArray(vector) || !vector.length) return null;
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) bytes.writeFloatLE(Number(vector[index]) || 0, index * 4);
  return bytes;
}

function unpackVector(value) {
  if (!value) return null;
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length % 4 !== 0) return null;
  const vector = new globalThis.Float32Array(bytes.length / 4);
  for (let index = 0; index < vector.length; index += 1) vector[index] = bytes.readFloatLE(index * 4);
  return vector;
}

export class LivingMemoryStore {
  constructor({ file, turnRetentionDays = 7 } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.file = file;
    const requestedRetention = Number(turnRetentionDays);
    this.turnRetentionDays = Number.isFinite(requestedRetention) && requestedRetention === 0
      ? 0 : Math.max(1, Math.min(3650, Math.round(requestedRetention || 7)));
    // 统一走 src/core/sqlite.js：缺 node:sqlite 时由它在真正打开时给人话错误，
    // 而不是让整个进程在模块加载期抛裸栈。
    this.db = openDatabase(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        tags_json TEXT NOT NULL,
        topics_json TEXT NOT NULL DEFAULT '[]',
        key_facts_json TEXT NOT NULL DEFAULT '[]',
        participants_json TEXT NOT NULL DEFAULT '[]',
        sentiment TEXT NOT NULL DEFAULT 'neutral',
        source_json TEXT NOT NULL,
        entities_json TEXT NOT NULL,
        relations_json TEXT NOT NULL,
        search_text TEXT NOT NULL,
        vector_status TEXT NOT NULL DEFAULT 'pending',
        vector_error TEXT NOT NULL DEFAULT '',
        embedding_model TEXT NOT NULL DEFAULT '',
        vector_blob BLOB,
        vector_dimensions INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope_status_updated
        ON memories(scope_key, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_scope_type
        ON memories(scope_key, type);
      CREATE INDEX IF NOT EXISTS idx_memories_expires
        ON memories(expires_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_scope_created ON turns(scope_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at);
      CREATE TABLE IF NOT EXISTS memory_versions (
        memory_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(memory_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_versions_created ON memory_versions(memory_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS capture_state (
        scope_key TEXT PRIMARY KEY,
        last_seen_message_id TEXT NOT NULL DEFAULT '',
        last_extracted_message_id TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      -- 迁移脚本会导入旧外置服务留下的 operations；运行时暂不读写这张表。
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operations_status_created ON operations(status, created_at ASC);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name || '')));
    if (!columns.has('vector_blob')) this.db.exec('ALTER TABLE memories ADD COLUMN vector_blob BLOB');
    if (!columns.has('vector_dimensions')) this.db.exec('ALTER TABLE memories ADD COLUMN vector_dimensions INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('topics_json')) this.db.exec("ALTER TABLE memories ADD COLUMN topics_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has('key_facts_json')) this.db.exec("ALTER TABLE memories ADD COLUMN key_facts_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has('participants_json')) this.db.exec("ALTER TABLE memories ADD COLUMN participants_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has('sentiment')) this.db.exec("ALTER TABLE memories ADD COLUMN sentiment TEXT NOT NULL DEFAULT 'neutral'");
  }

  close() {
    this.db.close();
  }

  upsertMemory(raw, { id = '', reason = 'create-or-update' } = {}) {
    const time = now();
    const memory = {
      id: asText(id || raw?.id, 100) || uuid(),
      scopeKey: asText(raw?.scopeKey, 80),
      type: MEMORY_TYPES.has(raw?.type) ? raw.type : 'episode',
      status: MEMORY_STATUSES.has(raw?.status) ? raw.status : 'active',
      summary: asText(raw?.summary, 800),
      content: asText(raw?.content || raw?.summary, 6000),
      importance: clamp(raw?.importance, 0, 10, 3),
      confidence: clamp(raw?.confidence, 0, 1, 0.7),
      tags: jsonArray(raw?.tags, 16, 64),
      topics: jsonArray(raw?.topics, 8, 80),
      keyFacts: jsonArray(raw?.keyFacts, 12, 300),
      participants: jsonArray(raw?.participants, 24, 120),
      sentiment: ['positive', 'neutral', 'negative', 'mixed'].includes(raw?.sentiment) ? raw.sentiment : 'neutral',
      source: jsonObject(raw?.source),
      entities: jsonArray(raw?.entities, 32, 80),
      relations: Array.isArray(raw?.relations) ? raw.relations.slice(0, 64) : [],
      expiresAt: Math.max(0, Number(raw?.expiresAt) || 0),
      embeddingModel: asText(raw?.embeddingModel, 200)
    };
    if (!scopeList([memory.scopeKey]).length) throw new Error('scopeKey 必须是 group:<QQ号>、private:<QQ号> 或 owner-global');
    if (!memory.summary || !memory.content) throw new Error('记忆摘要与正文不能为空');
    const previous = this.getMemory(memory.id);
    const previousVector = previous?.vectorStatus === 'ready' ? this.getVectorRow(memory.id) : null;
    const createdAt = previous?.createdAt || time;
    const archivedAt = memory.status === 'archived' ? (previous?.archivedAt || time) : 0;
    const data = {
      ...memory,
      // 编辑已有记忆时先保留旧向量：Embedding 失败也不会把它降级成只能关键词检索。
      vectorStatus: previousVector ? 'ready' : 'pending',
      vectorError: previousVector ? '正在重新向量化，暂时沿用旧向量' : '',
      vectorBlob: previousVector?.blob ?? null,
      vectorDimensions: previousVector?.dimensions ?? 0,
      createdAt,
      updatedAt: time,
      archivedAt,
      searchText: searchText(memory)
    };
    this.db.prepare(`
      INSERT INTO memories (
        id, scope_key, type, status, summary, content, importance, confidence,
        tags_json, topics_json, key_facts_json, participants_json, sentiment,
        source_json, entities_json, relations_json, search_text,
        vector_status, vector_error, embedding_model, vector_blob, vector_dimensions,
        created_at, updated_at, expires_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope_key=excluded.scope_key, type=excluded.type, status=excluded.status,
        summary=excluded.summary, content=excluded.content, importance=excluded.importance,
        confidence=excluded.confidence, tags_json=excluded.tags_json, topics_json=excluded.topics_json,
        key_facts_json=excluded.key_facts_json, participants_json=excluded.participants_json, sentiment=excluded.sentiment,
        source_json=excluded.source_json,
        entities_json=excluded.entities_json, relations_json=excluded.relations_json, search_text=excluded.search_text,
        vector_status=excluded.vector_status, vector_error=excluded.vector_error,
        embedding_model=excluded.embedding_model, vector_blob=excluded.vector_blob,
        vector_dimensions=excluded.vector_dimensions, updated_at=excluded.updated_at,
        expires_at=excluded.expires_at, archived_at=excluded.archived_at
    `).run(
      data.id, data.scopeKey, data.type, data.status, data.summary, data.content,
      data.importance, data.confidence, stableJson(data.tags), stableJson(data.topics), stableJson(data.keyFacts), stableJson(data.participants), data.sentiment,
      stableJson(data.source),
      stableJson(data.entities), stableJson(data.relations), data.searchText,
      data.vectorStatus, data.vectorError, data.embeddingModel, data.vectorBlob, data.vectorDimensions, data.createdAt,
      data.updatedAt, data.expiresAt, data.archivedAt
    );
    const saved = this.getMemory(data.id);
    const version = Number(this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM memory_versions WHERE memory_id = ?').get(saved.id)?.version || 0) + 1;
    this.db.prepare('INSERT INTO memory_versions(memory_id, version, reason, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(saved.id, version, asText(reason, 120) || 'create-or-update', cappedJson(saved, 24000), time);
    return saved;
  }

  getMemory(id) {
    return rowToMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(asText(id, 100)));
  }

  getVectorRow(id) {
    const row = this.db.prepare('SELECT vector_blob AS blob, vector_dimensions AS dimensions FROM memories WHERE id = ?')
      .get(asText(id, 100));
    return row ? { blob: row.blob ?? null, dimensions: Number(row.dimensions) || 0 } : null;
  }

  /** 同一 scope + 类型下，摘要或正文归一化后完全相同的卡片视为重复。 */
  findDuplicate({ scopeKey, type = '', summary = '', content = '' } = {}) {
    const targetSummary = normalizeDuplicateText(summary);
    const targetContent = normalizeDuplicateText(content);
    if (!targetSummary && !targetContent) return null;
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE scope_key = ? AND status = 'active' AND type = ?
      ORDER BY updated_at DESC LIMIT 200
    `).all(asText(scopeKey, 80), MEMORY_TYPES.has(type) ? type : 'episode');
    for (const row of rows) {
      const memory = rowToMemory(row);
      if (targetSummary && normalizeDuplicateText(memory.summary) === targetSummary) return memory;
      if (targetContent && normalizeDuplicateText(memory.content) === targetContent) return memory;
    }
    return null;
  }

  markVectorError(id, error = '') {
    this.db.prepare('UPDATE memories SET vector_error = ? WHERE id = ?')
      .run(asText(error, 600), asText(id, 100));
    return this.getMemory(id);
  }

  getMemories(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map((id) => asText(id, 100)).filter(Boolean))];
    if (!list.length) return [];
    return this.db.prepare(`SELECT * FROM memories WHERE id IN (${list.map(() => '?').join(', ')})`)
      .all(...list).map(rowToMemory);
  }

  listMemories({ scopeKeys, status = '', type = '', query = '', limit = 50, offset = 0 } = {}) {
    const scopes = scopeList(scopeKeys);
    if (!scopes.length) return { total: 0, entries: [] };
    const parts = [`scope_key IN (${scopes.map(() => '?').join(', ')})`];
    const values = [...scopes];
    if (MEMORY_STATUSES.has(status)) { parts.push('status = ?'); values.push(status); }
    if (MEMORY_TYPES.has(type)) { parts.push('type = ?'); values.push(type); }
    const cleanQuery = asText(query, 300);
    if (cleanQuery) {
      parts.push('(summary LIKE ? OR content LIKE ? OR tags_json LIKE ? OR entities_json LIKE ?)');
      const like = `%${cleanQuery}%`;
      values.push(like, like, like, like);
    }
    const where = parts.join(' AND ');
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${where}`).get(...values)?.count) || 0;
    const safeLimit = clampInt(limit, 1, 200, 50);
    const safeOffset = clampInt(offset, 0, 10_000_000, 0);
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...values, safeLimit, safeOffset);
    return { total, entries: rows.map(rowToMemory) };
  }

  lexicalCandidates({ scopeKeys, query, limit = 800 }) {
    const scopes = scopeList(scopeKeys);
    if (!scopes.length) return [];
    const time = now();
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE scope_key IN (${scopes.map(() => '?').join(', ')})
        AND status = 'active'
        AND (expires_at = 0 OR expires_at > ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...scopes, time, clampInt(limit, 1, 2000, 800)).map(rowToMemory);
    return rows.map((memory) => ({ memory, score: lexicalScore(query, `${memory.summary}\n${memory.content}\n${memory.tags.join(' ')}\n${memory.entities.join(' ')}`) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  hasReadyVectors({ scopeKeys, model = '' } = {}) {
    const scopes = scopeList(scopeKeys);
    if (!scopes.length) return false;
    const values = [...scopes, now()];
    const modelClause = asText(model, 200) ? ' AND embedding_model = ?' : '';
    if (modelClause) values.push(asText(model, 200));
    const row = this.db.prepare(`
      SELECT 1 AS present FROM memories
      WHERE scope_key IN (${scopes.map(() => '?').join(', ')})
        AND status = 'active'
        AND vector_status = 'ready'
        AND vector_blob IS NOT NULL
        AND (expires_at = 0 OR expires_at > ?)
        ${modelClause}
      LIMIT 1
    `).get(...values);
    return Boolean(row?.present);
  }

  vectorCandidates({ scopeKeys, model = '', dimensions = 0, limit = 5000 } = {}) {
    const scopes = scopeList(scopeKeys);
    const embeddingModel = asText(model, 200);
    const vectorDimensions = clampInt(dimensions, 1, 8192, 0);
    if (!scopes.length || !embeddingModel || !vectorDimensions) return [];
    const rows = this.db.prepare(`
      SELECT id, vector_blob FROM memories
      WHERE scope_key IN (${scopes.map(() => '?').join(', ')})
        AND status = 'active'
        AND vector_status = 'ready'
        AND embedding_model = ?
        AND vector_dimensions = ?
        AND vector_blob IS NOT NULL
        AND (expires_at = 0 OR expires_at > ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...scopes, embeddingModel, vectorDimensions, now(), clampInt(limit, 1, 20000, 5000));
    return rows.map((row) => ({ id: String(row.id || ''), vector: unpackVector(row.vector_blob) }))
      .filter((item) => item.id && item.vector?.length === vectorDimensions);
  }

  vectorWork({ model = '', limit = 100000, force = false } = {}) {
    const embeddingModel = asText(model, 200);
    if (!embeddingModel) return [];
    const values = [];
    const staleClause = force
      ? ''
      : ` AND (
        vector_status != 'ready'
        OR embedding_model != ?
        OR vector_blob IS NULL
        OR vector_dimensions <= 0
      )`;
    if (!force) values.push(embeddingModel);
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE status = 'active'
      ${staleClause}
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(...values, clampInt(limit, 1, 100000, 100000));
    return rows.map(rowToMemory);
  }

  setVectorState(id, { status, error = '', model = '', vector = null, preserveUpdatedAt = false } = {}) {
    const nextStatus = ['pending', 'ready', 'stale', 'error', 'none'].includes(status) ? status : 'error';
    const packed = nextStatus === 'ready' ? packVector(vector) : null;
    const dimensions = packed ? Math.floor(packed.length / 4) : 0;
    const storedStatus = packed ? nextStatus : (nextStatus === 'ready' ? 'error' : nextStatus);
    const vectorError = packed ? '' : (nextStatus === 'ready' ? '向量数据无效' : asText(error, 600));
    const updatedClause = preserveUpdatedAt ? '' : ', updated_at = ?';
    const values = [storedStatus, vectorError, asText(model, 200), packed, dimensions];
    if (!preserveUpdatedAt) values.push(now());
    values.push(asText(id, 100));
    this.db.prepare(`UPDATE memories
      SET vector_status = ?, vector_error = ?, embedding_model = ?, vector_blob = ?, vector_dimensions = ?${updatedClause}
      WHERE id = ?`)
      .run(...values);
    return this.getMemory(id);
  }

  removeMemory(id) {
    const memory = this.getMemory(id);
    if (!memory) return null;
    // 来源回合可能被同一批次的其它卡片共同引用；只删「已无任何 memory 引用」的 turn。
    // 用 SAVEPOINT 包住，删卡与清 turn 要么一起成功，要么都不落盘。
    const turnIds = [...new Set(
      (Array.isArray(memory.source?.turnIds) ? memory.source.turnIds : [])
        .map((item) => asText(item, 100))
        .filter(Boolean)
    )];
    this.db.exec('SAVEPOINT living_memory_remove');
    try {
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(memory.id);
      if (turnIds.length) {
        this.db.prepare(`
          DELETE FROM turns
          WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
            AND NOT EXISTS (
              SELECT 1
              FROM memories AS m, json_each(
                CASE
                  WHEN json_valid(m.source_json) THEN
                    CASE WHEN json_type(m.source_json, '$.turnIds') = 'array'
                      THEN m.source_json ELSE '{}' END
                  ELSE '{}'
                END,
                '$.turnIds'
              ) AS ref
              WHERE CAST(ref.value AS TEXT) = turns.id
            )
        `).run(JSON.stringify(turnIds));
      }
      this.db.exec('RELEASE living_memory_remove');
    } catch (error) {
      try { this.db.exec('ROLLBACK TO living_memory_remove'); } catch { /* 已自动回滚 */ }
      try { this.db.exec('RELEASE living_memory_remove'); } catch { /* 已释放 */ }
      throw error;
    }
    return memory;
  }

  archiveMemory(id) {
    const memory = this.getMemory(id);
    if (!memory) return null;
    this.db.prepare("UPDATE memories SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
      .run(now(), now(), memory.id);
    return this.getMemory(memory.id);
  }

  unarchiveMemory(id) {
    const memory = this.getMemory(id);
    if (!memory) return null;
    this.db.prepare("UPDATE memories SET status = 'active', archived_at = 0, updated_at = ? WHERE id = ?")
      .run(now(), memory.id);
    return this.getMemory(memory.id);
  }

  recordTurn(raw) {
    const scopeKey = asText(raw?.scopeKey, 80);
    if (!scopeList([scopeKey]).length) throw new Error('turn 的 scopeKey 无效');
    const row = {
      id: uuid(),
      scopeKey,
      sessionId: asText(raw?.sessionId, 120),
      payload: jsonObject(raw?.payload),
      createdAt: now()
    };
    this.db.prepare('INSERT INTO turns (id, scope_key, session_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.scopeKey, row.sessionId, cappedJson(row.payload), row.createdAt);
    return { ...row };
  }

  captureState(scopeKey) {
    const scope = asText(scopeKey, 80);
    if (!scopeList([scope]).length) return null;
    return this.db.prepare('SELECT scope_key AS scopeKey, last_seen_message_id AS lastSeenMessageId, last_extracted_message_id AS lastExtractedMessageId, updated_at AS updatedAt FROM capture_state WHERE scope_key = ?').get(scope) || null;
  }

  updateCaptureState(scopeKey, { lastSeenMessageId, lastExtractedMessageId } = {}) {
    const scope = asText(scopeKey, 80);
    if (!scopeList([scope]).length) throw new Error('capture state scope 无效');
    const previous = this.captureState(scope) || {};
    const nextSeen = asText(lastSeenMessageId ?? previous.lastSeenMessageId, 100);
    const nextExtracted = asText(lastExtractedMessageId ?? previous.lastExtractedMessageId, 100);
    const updatedAt = now();
    this.db.prepare('INSERT INTO capture_state(scope_key, last_seen_message_id, last_extracted_message_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope_key) DO UPDATE SET last_seen_message_id=excluded.last_seen_message_id, last_extracted_message_id=excluded.last_extracted_message_id, updated_at=excluded.updated_at')
      .run(scope, nextSeen, nextExtracted, updatedAt);
    return this.captureState(scope);
  }

  pruneExpired() {
    const time = now();
    const rows = this.db.prepare("SELECT id FROM memories WHERE expires_at > 0 AND expires_at <= ? AND status = 'active'").all(time);
    this.db.prepare("UPDATE memories SET status = 'archived', archived_at = ?, updated_at = ? WHERE expires_at > 0 AND expires_at <= ? AND status = 'active'")
      .run(time, time, time);
    const cutoff = time - this.turnRetentionDays * 86400000;
    let turnsRemoved = this.turnRetentionDays > 0
      ? Number(this.db.prepare('DELETE FROM turns WHERE created_at < ?').run(cutoff).changes) || 0
      : 0;
    const totalTurns = Number(this.db.prepare('SELECT COUNT(*) AS count FROM turns').get()?.count) || 0;
    if (this.turnRetentionDays > 0 && totalTurns > MAX_TURNS) {
      turnsRemoved += Number(this.db.prepare(`
        DELETE FROM turns WHERE id IN (
          SELECT id FROM turns ORDER BY created_at ASC LIMIT ?
        )
      `).run(totalTurns - MAX_TURNS).changes) || 0;
    }
    return { archived: rows.map((row) => row.id), turnsRemoved };
  }

  graph({ scopeKeys, memoryId = '', limit = 160 } = {}) {
    const scopes = scopeList(scopeKeys);
    if (!scopes.length) return { nodes: [], edges: [] };
    const filters = [`scope_key IN (${scopes.map(() => '?').join(', ')})`, "status = 'active'"];
    const values = [...scopes];
    if (memoryId) { filters.push('id = ?'); values.push(asText(memoryId, 100)); }
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${filters.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
      .all(...values, clampInt(limit, 1, 500, 160)).map(rowToMemory);
    const nodes = new Map();
    const edges = [];
    for (const memory of rows) {
      nodes.set(`memory:${memory.id}`, { id: `memory:${memory.id}`, type: 'memory', label: memory.summary.slice(0, 90), memoryId: memory.id, importance: memory.importance });
      for (const entity of memory.entities) {
        const entityId = `entity:${entity}`;
        if (!nodes.has(entityId)) nodes.set(entityId, { id: entityId, type: 'entity', label: entity });
        edges.push({ id: `${memory.id}:entity:${entity}`, source: `memory:${memory.id}`, target: entityId, type: 'mentions' });
      }
      for (const relation of memory.relations) {
        const source = asText(relation?.source, 80);
        const target = asText(relation?.target, 80);
        if (!source || !target) continue;
        const sourceId = `entity:${source}`;
        const targetId = `entity:${target}`;
        if (!nodes.has(sourceId)) nodes.set(sourceId, { id: sourceId, type: 'entity', label: source });
        if (!nodes.has(targetId)) nodes.set(targetId, { id: targetId, type: 'entity', label: target });
        edges.push({ id: `${memory.id}:relation:${source}:${target}`, source: sourceId, target: targetId, type: asText(relation?.predicate, 48) || 'related' });
      }
    }
    return { nodes: [...nodes.values()], edges };
  }

  stats() {
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count) || 0;
    const active = Number(this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'").get()?.count) || 0;
    const vectorReady = Number(this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE vector_status = 'ready'").get()?.count) || 0;
    const turns = Number(this.db.prepare('SELECT COUNT(*) AS count FROM turns').get()?.count) || 0;
    const scopes = this.db.prepare('SELECT scope_key AS scopeKey, COUNT(*) AS count FROM memories GROUP BY scope_key ORDER BY count DESC LIMIT 100')
      .all().map((row) => ({ scopeKey: row.scopeKey, count: Number(row.count) || 0 }));
    const versions = Number(this.db.prepare('SELECT COUNT(*) AS count FROM memory_versions').get()?.count) || 0;
    return { total, active, vectorReady, turns, versions, scopes, scopeCount: scopes.length, turnRetentionDays: this.turnRetentionDays };
  }
}
