import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Embedder, readLivingMemoryEmbeddingConfig } from './embedding.js';
import { LivingMemoryService } from './service.js';
import { LivingMemoryStore } from './store.js';
import { asText, clamp, clampInt, parseJson, stableJson } from './util.js';

const MEMORY_TYPES = new Set(['episode', 'fact', 'profile', 'preference', 'commitment', 'project', 'rule']);
const MEMORY_STATUSES = new Set(['active', 'archived', 'superseded']);
const SCOPE_PATTERN = /^(group|private):\d+$|^owner-global$/;
const REQUIRED_MEMORY_COLUMNS = [
  'id', 'scope_key', 'type', 'status', 'summary', 'content', 'importance', 'confidence',
  'tags_json', 'source_json', 'entities_json', 'relations_json', 'created_at', 'updated_at'
];

function absoluteFile(value, label) {
  const file = path.resolve(String(value || ''));
  if (!value || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label}不存在或不是文件：${file}`);
  return file;
}

function timestamp(value, fallback = Date.now()) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function jsonValue(value, fallback, fn) {
  const parsed = parseJson(value, fallback);
  return stableJson(fn(parsed) ? parsed : fallback);
}

function arrayValue(value) {
  return jsonValue(value, [], Array.isArray);
}

function objectValue(value) {
  return jsonValue(value, {}, (item) => item && typeof item === 'object' && !Array.isArray(item));
}

function textFromJson(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.map((item) => asText(item, 160)).filter(Boolean).join(' ') : '';
}

function sourceColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name || '')));
}

function quickCheck(db, label) {
  const rows = db.prepare('PRAGMA quick_check').all();
  const passed = rows.length === 1 && Object.values(rows[0]).some((value) => String(value).toLowerCase() === 'ok');
  if (!passed) throw new Error(`${label}完整性检查失败`);
}

function readLegacySnapshot(sourceFile) {
  const file = absoluteFile(sourceFile, '旧长期记忆数据库');
  // A legacy database normally keeps `journal_mode=WAL`. SQLite needs to open
  // its shared-memory sidecar even for a SELECT, so `readOnly:true` fails for
  // a stopped legacy store mounted read-only. Open an operator-made snapshot
  // read/write instead, then make the connection query-only before inspection.
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA query_only = ON;');
    quickCheck(db, '旧长期记忆数据库');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name || '')));
    for (const table of ['memories', 'turns']) {
      if (!tables.has(table)) throw new Error(`旧长期记忆数据库缺少 ${table} 表`);
    }
    const columns = sourceColumns(db, 'memories');
    const missing = REQUIRED_MEMORY_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length) throw new Error(`旧长期记忆数据库 memories 表缺少字段：${missing.join(', ')}`);
    const memories = db.prepare('SELECT * FROM memories ORDER BY created_at ASC, id ASC').all();
    const turns = db.prepare('SELECT * FROM turns ORDER BY created_at ASC, id ASC').all();
    const operations = tables.has('operations')
      ? db.prepare('SELECT * FROM operations ORDER BY created_at ASC, id ASC').all()
      : [];
    const byScope = new Map();
    for (const row of memories) {
      const key = asText(row.scope_key, 80) || 'invalid';
      byScope.set(key, (byScope.get(key) || 0) + 1);
    }
    return {
      file,
      memories,
      turns,
      operations,
      summary: {
        memories: memories.length,
        turns: turns.length,
        operations: operations.length,
        active: memories.filter((row) => String(row.status) === 'active').length,
        vectorReady: memories.filter((row) => String(row.vector_status) === 'ready').length,
        scopes: [...byScope.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([scopeKey, count]) => ({ scopeKey, count }))
      }
    };
  } finally {
    db.close();
  }
}

function normalizeMemory(row) {
  const id = asText(row?.id, 100);
  const scopeKey = asText(row?.scope_key, 80);
  const summary = asText(row?.summary, 800);
  const content = asText(row?.content || summary, 6000);
  if (!id || !SCOPE_PATTERN.test(scopeKey) || !summary || !content) return null;
  const type = MEMORY_TYPES.has(row?.type) ? row.type : 'episode';
  const status = MEMORY_STATUSES.has(row?.status) ? row.status : 'active';
  const tagsJson = arrayValue(row?.tags_json);
  const entitiesJson = arrayValue(row?.entities_json);
  const participantsJson = arrayValue(row?.participants_json);
  const relationsJson = arrayValue(row?.relations_json);
  const sourceJson = objectValue(row?.source_json);
  const searchText = asText(row?.search_text, 8000) || [summary, content, textFromJson(tagsJson), textFromJson(entitiesJson)].filter(Boolean).join('\n');
  const createdAt = timestamp(row?.created_at);
  const updatedAt = timestamp(row?.updated_at, createdAt);
  return {
    id,
    scopeKey,
    type,
    status,
    summary,
    content,
    importance: clamp(row?.importance, 0, 10, 3),
    confidence: clamp(row?.confidence, 0, 1, 0.7),
    tagsJson,
    sourceJson,
    entitiesJson,
    participantsJson,
    relationsJson,
    searchText,
    vectorStatus: status === 'active' ? 'pending' : 'none',
    embeddingModel: asText(row?.embedding_model, 200),
    createdAt,
    updatedAt,
    expiresAt: timestamp(row?.expires_at, 0),
    archivedAt: timestamp(row?.archived_at, 0)
  };
}

function normalizeTurn(row) {
  const id = asText(row?.id, 100);
  const scopeKey = asText(row?.scope_key, 80);
  if (!id || !SCOPE_PATTERN.test(scopeKey)) return null;
  return {
    id,
    scopeKey,
    sessionId: asText(row?.session_id, 120),
    payloadJson: objectValue(row?.payload_json),
    createdAt: timestamp(row?.created_at)
  };
}

function normalizeOperation(row) {
  const id = asText(row?.id, 100);
  const kind = asText(row?.kind, 120);
  const status = asText(row?.status, 64);
  if (!id || !kind || !status) return null;
  return {
    id,
    kind,
    status,
    payloadJson: objectValue(row?.payload_json),
    error: asText(row?.error, 2000),
    createdAt: timestamp(row?.created_at),
    updatedAt: timestamp(row?.updated_at, timestamp(row?.created_at))
  };
}

function targetFile(value) {
  const file = path.resolve(String(value || ''));
  if (!value) throw new Error('必须提供目标长期记忆数据库路径');
  return file;
}

export function inspectLegacyLivingMemory({ sourceFile } = {}) {
  const snapshot = readLegacySnapshot(sourceFile);
  return { sourceFile: snapshot.file, ...snapshot.summary };
}

/**
 * Copy cards and source turns from the retired HTTP/Qdrant service into the
 * embedded SQLite store. Existing IDs are never overwritten, so this is safe
 * to resume after an interrupted deployment. Qdrant vectors are intentionally
 * not copied: their storage format is external and model compatibility must be
 * proven by regenerating local Float32 vectors.
 */
export async function migrateLegacyLivingMemory({
  sourceFile,
  targetFile: requestedTarget,
  reembed = false,
  forceVectors = false,
  reindexLimit = 100000,
  reindexBatchSize = 8,
  reindexTimeoutMs = 0,
  embeddingConfig = null,
  embedder = null,
  onProgress = null,
  log = console
} = {}) {
  const snapshot = readLegacySnapshot(sourceFile);
  const destination = targetFile(requestedTarget);
  if (path.resolve(snapshot.file) === destination) throw new Error('旧数据库与目标数据库不能是同一个文件');
  const store = new LivingMemoryStore({ file: destination });
  const report = {
    source: { file: snapshot.file, ...snapshot.summary },
    targetFile: destination,
    imported: { memories: 0, turns: 0, operations: 0 },
    skipped: { invalidMemories: 0, invalidTurns: 0, invalidOperations: 0, existingMemories: 0, existingTurns: 0, existingOperations: 0 },
    reindex: null
  };
  try {
    const insertMemory = store.db.prepare(`
      INSERT OR IGNORE INTO memories (
        id, scope_key, type, status, summary, content, importance, confidence,
        tags_json, source_json, entities_json, participants_json, relations_json, search_text,
        vector_status, vector_error, embedding_model, vector_blob, vector_dimensions,
        created_at, updated_at, expires_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, NULL, 0, ?, ?, ?, ?)
    `);
    const insertTurn = store.db.prepare(
      'INSERT OR IGNORE INTO turns (id, scope_key, session_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertOperation = store.db.prepare(
      "INSERT OR IGNORE INTO operations (id, kind, status, payload_json, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const raw of snapshot.memories) {
        const memory = normalizeMemory(raw);
        if (!memory) {
          report.skipped.invalidMemories += 1;
          continue;
        }
        const result = insertMemory.run(
          memory.id, memory.scopeKey, memory.type, memory.status, memory.summary, memory.content,
          memory.importance, memory.confidence, memory.tagsJson, memory.sourceJson, memory.entitiesJson,
          memory.participantsJson, memory.relationsJson, memory.searchText, memory.vectorStatus, memory.embeddingModel,
          memory.createdAt, memory.updatedAt, memory.expiresAt, memory.archivedAt
        );
        if (result.changes) report.imported.memories += 1;
        else report.skipped.existingMemories += 1;
      }
      for (const raw of snapshot.turns) {
        const turn = normalizeTurn(raw);
        if (!turn) {
          report.skipped.invalidTurns += 1;
          continue;
        }
        const result = insertTurn.run(turn.id, turn.scopeKey, turn.sessionId, turn.payloadJson, turn.createdAt);
        if (result.changes) report.imported.turns += 1;
        else report.skipped.existingTurns += 1;
      }
      for (const raw of snapshot.operations) {
        const operation = normalizeOperation(raw);
        if (!operation) {
          report.skipped.invalidOperations += 1;
          continue;
        }
        const result = insertOperation.run(
          operation.id, operation.kind, operation.status, operation.payloadJson, operation.error,
          operation.createdAt, operation.updatedAt
        );
        if (result.changes) report.imported.operations += 1;
        else report.skipped.existingOperations += 1;
      }
      store.db.exec('COMMIT');
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* transaction is already closed */ }
      throw error;
    }
    if (reembed) {
      const service = new LivingMemoryService({
        file: destination,
        store,
        embeddingConfig: embeddingConfig || readLivingMemoryEmbeddingConfig(),
        embedder: embedder || undefined,
        log
      });
      report.reindex = await service.reindexVectors({
        limit: clampInt(reindexLimit, 1, 100000, 100000),
        batchSize: clampInt(reindexBatchSize, 1, 64, 8),
        timeoutMs: clampInt(reindexTimeoutMs, 0, 120000, 0),
        force: forceVectors === true,
        onProgress
      });
    }
    report.target = store.stats();
    return report;
  } finally {
    store.close();
  }
}

export async function reindexLivingMemory({
  file,
  embeddingConfig = null,
  embedder = null,
  limit = 100000,
  batchSize = 8,
  timeoutMs = 0,
  force = false,
  onProgress = null,
  log = console
} = {}) {
  const store = new LivingMemoryStore({ file: targetFile(file) });
  try {
    const service = new LivingMemoryService({
      file: store.file,
      store,
      embeddingConfig: embeddingConfig || readLivingMemoryEmbeddingConfig(),
      embedder: embedder || new Embedder(embeddingConfig || readLivingMemoryEmbeddingConfig()),
      log
    });
    return await service.reindexVectors({ limit, batchSize, timeoutMs, force, onProgress });
  } finally {
    store.close();
  }
}
