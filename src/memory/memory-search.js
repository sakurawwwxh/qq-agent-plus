// 记忆检索索引：SQLite FTS5 + 中文二元组。
//
// 不是向量检索：先用 FTS5 找候选，再用二元组覆盖率、FTS 排名与新鲜度重排。
// 这样 2 个汉字（“面馆”）也能命中，而 trigram 对 <3 字符是搜不到的。
// 索引是派生数据，损坏/不可用只会让搜索回落到空结果，不影响记忆正文与聊天。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase } from '../core/sqlite.js';
import { impressionVisible } from '../core/memory-visibility.js';

const MAX_QUERY_CHARS = 120;
const MAX_CANDIDATES = 240;

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

/** 中文按二元组、拉丁按词切；单字查询保留单字。 */
export function tokenizeText(text) {
  const source = String(text ?? '').toLowerCase();
  const tokens = [];
  const latin = source.match(/[a-z0-9_]{2,}/g) || [];
  tokens.push(...latin);
  const cjkRuns = source.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) || [];
  for (const run of cjkRuns) {
    const chars = [...run];
    // 单字也入索引：用户经常只记得一个人名/一个物件（“猫”“汤”）。
    // 单字命中很泛，最终排序仍由覆盖率 + 新鲜度压住。
    tokens.push(...chars);
    for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(tokens)];
}

function docIdOf(userId, content, createdAt) {
  return hash(`impression|${userId}|${createdAt}|${content}`);
}

export class MemorySearchIndex {
  constructor({ dataDir, filename = 'search.sqlite' } = {}) {
    this.file = path.join(dataDir, 'memory', filename);
    this.db = null;
    this.error = '';
    this.lastSignature = '';
    this.opened = false;
  }

  #open() {
    if (this.opened) return Boolean(this.db);
    this.opened = true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      this.db = openDatabase(this.file);
      this.db.exec(`
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          doc_id UNINDEXED,
          user_id UNINDEXED,
          name UNINDEXED,
          content UNINDEXED,
          kind UNINDEXED,
          created_at UNINDEXED,
          observed_at UNINDEXED,
          origin UNINDEXED,
          sources UNINDEXED,
          tokens,
          tokenize='unicode61'
        );
      `);
      try { fs.chmodSync(this.file, 0o600); } catch { /* Windows / 只读文件系统 */ }
    } catch (error) {
      this.db = null;
      this.error = String(error?.message || error);
    }
    return Boolean(this.db);
  }

  get available() {
    return this.opened ? Boolean(this.db) : false;
  }

  #signature(members) {
    const h = crypto.createHash('sha1');
    for (const member of [...members].sort((a, b) => String(a.userId).localeCompare(String(b.userId)))) {
      h.update(`${member.userId}\0${member.name}\0`);
      for (const entry of member.impressions || []) {
        h.update(`${entry.content}\0${entry.createdAt}\0${entry.lastObservedAt}\0${entry.origin}\0${(entry.sourceChatKeys || []).join(',')}\0`);
      }
    }
    return h.digest('hex');
  }

  #ensureIndex(members) {
    if (!this.db) return false;
    const signature = this.#signature(members);
    if (signature === this.lastSignature) return true;
    try {
      const stored = this.db.prepare("SELECT value FROM meta WHERE key='signature'").get();
      if (stored?.value === signature) {
        this.lastSignature = signature;
        return true;
      }
      const insert = this.db.prepare(`INSERT INTO memory_fts
        (doc_id,user_id,name,content,kind,created_at,observed_at,origin,sources,tokens)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('DELETE FROM memory_fts');
        for (const member of members) {
          const name = String(member.name || member.userId || '');
          for (const entry of member.impressions || []) {
            const content = String(entry.content || '');
            if (!content) continue;
            insert.run(
              docIdOf(member.userId, content, entry.createdAt),
              String(member.userId || ''),
              name,
              content,
              'impression',
              String(Number(entry.createdAt) || 0),
              String(Number(entry.lastObservedAt) || Number(entry.createdAt) || 0),
              String(entry.origin || ''),
              JSON.stringify(entry.sourceChatKeys || []),
              tokenizeText(`${name} ${content}`).join(' ')
            );
          }
        }
        this.db.prepare("INSERT INTO meta(key,value) VALUES ('signature',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(signature);
        this.db.exec('COMMIT');
        this.lastSignature = signature;
        return true;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      }
    } catch (error) {
      this.error = String(error?.message || error);
      return false;
    }
  }

  #rows(queryTokens, { userId, chatKey, visibility }) {
    if (!queryTokens.length) return [];
    const ftsQuery = queryTokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
    // 先限定本次查询的范围，避免其他人物/不可见来源占满 240 个候选。
    const where = ['memory_fts MATCH ?'];
    const params = [ftsQuery];
    if (userId) {
      where.push('user_id = ?');
      params.push(userId);
    }
    if (visibility?.mode === 'perChat') {
      where.push('EXISTS (SELECT 1 FROM json_each(memory_fts.sources) WHERE CAST(value AS TEXT) = ?)');
      params.push(String(chatKey || ''));
    }
    if (visibility?.hidePrivateInGroup && String(chatKey || '').startsWith('group:')) {
      where.push("NOT EXISTS (SELECT 1 FROM json_each(memory_fts.sources) WHERE substr(CAST(value AS TEXT), 1, 8) = 'private:')");
    }
    try {
      return this.db.prepare(`SELECT doc_id,user_id,name,content,kind,created_at,observed_at,origin,sources,tokens,
        bm25(memory_fts) AS rank FROM memory_fts WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`)
        .all(...params, MAX_CANDIDATES);
    } catch (error) {
      this.error = String(error?.message || error);
      return [];
    }
  }

  /**
   * 检索。完整成员快照用于建索引；候选按本次人物/可见范围选取，
   * 返回前仍逐条检查可见性，不依赖索引内容或上一次查询的范围。
   */
  search({ members, query, chatKey = '', visibility = null, userId = '', limit = 8 } = {}) {
    if (!this.#open()) return [];
    const text = String(query ?? '').trim().slice(0, MAX_QUERY_CHARS);
    if (!text) return [];
    const queryTokens = tokenizeText(text);
    if (!queryTokens.length) return [];
    if (!this.#ensureIndex(members)) return [];
    const wantedUser = String(userId || '').trim();
    const rows = this.#rows(queryTokens, { userId: wantedUser, chatKey, visibility });
    const qset = new Set(queryTokens);
    const now = Date.now();
    const scored = [];
    const seenDocs = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (seenDocs.has(row.doc_id)) continue;
      seenDocs.add(row.doc_id);
      if (wantedUser && String(row.user_id) !== wantedUser) continue;
      let sources = [];
      try { sources = JSON.parse(row.sources || '[]'); } catch { sources = []; }
      if (visibility && !impressionVisible({ sourceChatKeys: sources }, chatKey, visibility)) continue;
      const docTokens = new Set(String(row.tokens || '').split(' ').filter(Boolean));
      let overlap = 0;
      for (const token of qset) if (docTokens.has(token)) overlap += 1;
      const coverage = overlap / qset.size;
      // 单字/虚词会让 FTS 的 OR 命中很多噪音；低于覆盖率的候选直接丢掉。
      // 1–2 字查询仍有单字/二元组覆盖，不会被误伤。
      if (coverage < 0.25) continue;
      const keywordScore = 1 - (index / Math.max(1, rows.length));
      const observed = Number(row.observed_at || row.created_at) || 0;
      const ageDays = observed > 0 ? Math.max(0, (now - observed) / 86400000) : 3650;
      const recency = 1 / (1 + ageDays / 365);
      const score = 0.6 * coverage + 0.25 * keywordScore + 0.15 * recency;
      scored.push({
        userId: String(row.user_id || ''),
        target: String(row.name || row.user_id || '某人'),
        content: String(row.content || ''),
        createdAt: Number(row.created_at) || 0,
        lastObservedAt: observed,
        origin: String(row.origin || ''),
        sourceChatKeys: sources,
        score: Math.round(score * 1000) / 1000,
        coverage: Math.round(coverage * 1000) / 1000
      });
    }
    scored.sort((a, b) => b.score - a.score || b.lastObservedAt - a.lastObservedAt);
    return scored.slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
  }

  stats(members = null) {
    if (!this.#open()) return { available: false, error: this.error, docs: 0, bytes: 0 };
    if (Array.isArray(members)) this.#ensureIndex(members);
    let docs = 0;
    try { docs = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_fts').get()?.n) || 0; } catch { /* ignore */ }
    let bytes = 0;
    try { bytes = fs.statSync(this.file).size; } catch { /* ignore */ }
    return { available: true, error: this.error, docs, bytes, file: this.file };
  }

  close() {
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
    this.opened = true;
  }
}
