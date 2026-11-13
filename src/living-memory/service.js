import { Embedder, readLivingMemoryEmbeddingConfig } from './embedding.js';
import { LivingMemoryStore } from './store.js';
import { asText, clampInt, now, redactionReason, similarityTokens } from './util.js';

function embeddingText(memory) {
  return [memory.summary, memory.content, memory.tags.join(' '), memory.entities.join(' ')].filter(Boolean).join('\n');
}

function recencyScore(memory) {
  const days = Math.max(0, (now() - memory.updatedAt) / 86400000);
  return Math.max(0, 1 - days / 365);
}

function vectorNorm(vector) {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = Number(vector[index]) || 0;
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function cosineWithNorm(left, leftNorm, right) {
  if (!left || !right || left.length !== right.length || !left.length || !leftNorm) return 0;
  let dot = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    rightNorm += b * b;
  }
  if (!rightNorm) return 0;
  return dot / (leftNorm * Math.sqrt(rightNorm));
}

function boundedDeadlineMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(200, Math.min(15000, Math.round(parsed)));
}

function textSimilarity(left, right) {
  const a = similarityTokens(left);
  const b = similarityTokens(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  // Dice 比 Jaccard 更适合长短不一的中文改写：同一句话改一两个词仍能过 0.82，
  // Jaccard 会被分母里的新增 bigram 拉低到 0.7 左右。
  return (2 * common) / (a.size + b.size);
}

const MEMORY_TYPES = new Set(['episode', 'fact', 'profile', 'preference', 'commitment', 'project', 'rule']);

function normalizeType(value) {
  return MEMORY_TYPES.has(value) ? value : 'episode';
}

function subjectSet(value) {
  return new Set((Array.isArray(value) ? value : [])
    .map((item) => asText(item, 120).toLowerCase().trim()).filter(Boolean));
}

function intersects(a, b) {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

function subjectsCompatible(left, right) {
  const lp = subjectSet(left?.participants), rp = subjectSet(right?.participants);
  if (lp.size && rp.size) return intersects(lp, rp);
  // 来卡没有主体、旧卡有：不能合并，否则会用空主体覆盖已有归属。
  if (!lp.size && rp.size) return false;
  if (!lp.size && !rp.size) {
    const le = subjectSet(left?.entities), re = subjectSet(right?.entities);
    if (le.size && re.size) return intersects(le, re);
  }
  return true;
}

function mergeSource(previous, next) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const incoming = next && typeof next === 'object' ? next : {};
  const union = (key) => [...new Set([
    ...(Array.isArray(prev[key]) ? prev[key] : []),
    ...(Array.isArray(incoming[key]) ? incoming[key] : [])
  ])];
  return {
    ...prev,
    ...incoming,
    sessionIds: union('sessionIds'),
    turnIds: union('turnIds'),
    turnCount: Math.max(Number(prev.turnCount) || 0, Number(incoming.turnCount) || 0)
  };
}

function mergeList(previous, incoming, max = 64) {
  return [...new Set([
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(incoming) ? incoming : [])
  ].filter(Boolean))].slice(0, max);
}

export class LivingMemoryService {
  constructor({ file, embeddingConfig = null, store = null, embedder = null, log = console, turnRetentionDays = 7 } = {}) {
    this.embeddingConfig = embeddingConfig || readLivingMemoryEmbeddingConfig();
    this.store = store || new LivingMemoryStore({ file, turnRetentionDays });
    this.embedder = embedder || new Embedder(this.embeddingConfig);
    this.log = log;
  }

  health() {
    return {
      ok: true,
      storage: { kind: 'sqlite', ok: true },
      embedding: {
        configured: this.embedder.ready(),
        model: this.embeddingConfig.model || '',
        dimensions: this.embeddingConfig.dimensions || 0
      },
      stats: this.store.stats()
    };
  }

  #findNearDuplicate(raw) {
    const scopeKey = asText(raw?.scopeKey, 80);
    if (!scopeKey) return null;
    const type = normalizeType(raw?.type);
    const target = `${raw?.summary || ''}\n${raw?.content || ''}`;
    if (!target.trim()) return null;
    if (typeof this.store.listMemories !== 'function') return null;
    const candidates = this.store.listMemories({ scopeKeys: [scopeKey], status: 'active', type, limit: 80 }).entries;
    for (const candidate of candidates) {
      const similarity = textSimilarity(target, `${candidate.summary || ''}\n${candidate.content || ''}`);
      if (similarity < 0.82) continue;
      // 相似但主体不同（张三 vs 李四）不能合并，否则会把别人的事实覆盖掉。
      if (!subjectsCompatible(
        { participants: raw?.participants, entities: raw?.entities },
        { participants: candidate.participants, entities: candidate.entities }
      )) continue;
      return candidate;
    }
    return null;
  }

  async upsertMemory(raw) {
    // 服务层自己始终做敏感信息检查；allowSensitive 只用于内部迁移，不能从控制台传进来。
    const input = { ...raw, type: normalizeType(raw?.type) };
    const redactionText = [
      input.summary || '', input.content || '',
      ...(Array.isArray(input.tags) ? input.tags : []),
      ...(Array.isArray(input.topics) ? input.topics : []),
      ...(Array.isArray(input.keyFacts) ? input.keyFacts : []),
      ...(Array.isArray(input.participants) ? input.participants : []),
      ...(Array.isArray(input.entities) ? input.entities : []),
      ...(Array.isArray(input.relations)
        ? input.relations.flatMap((item) => [item?.source, item?.predicate, item?.target])
        : [])
    ].join('\n');
    const rejected = redactionReason(redactionText);
    if (rejected) throw new Error(`拒绝保存：${rejected}`);
    const duplicate = input.id ? null : this.store.findDuplicate({
      scopeKey: input.scopeKey,
      type: input.type,
      summary: input.summary,
      content: input.content,
      participants: input.participants,
      entities: input.entities
    }) || this.#findNearDuplicate(input);
    const normalized = duplicate && !input.id
      ? {
        ...input,
        id: duplicate.id,
        importance: Math.max(Number(input.importance) || 0, Number(duplicate.importance) || 0),
        // 主体字段取并集：来卡缺 participants/entities 时不能把旧卡已有归属清空。
        participants: mergeList(duplicate.participants, input.participants),
        entities: mergeList(duplicate.entities, input.entities),
        tags: mergeList(duplicate.tags, input.tags),
        topics: mergeList(duplicate.topics, input.topics),
        keyFacts: mergeList(duplicate.keyFacts, input.keyFacts, 100),
        // 合并更新必须保留旧批次的来源回合：否则删除记忆时旧 turn 永远清不掉。
        source: mergeSource(duplicate.source, input.source)
      }
      : input;
    const memory = this.store.upsertMemory(normalized, { id: normalized?.id || '' });
    if (!this.embedder.ready()) {
      // 没有配置 Embedding 时标成“仅关键词”；编辑已有向量记忆则保留旧向量。
      if (memory.vectorStatus === 'ready' && memory.vectorDimensions > 0) return memory;
      return this.store.setVectorState(memory.id, { status: 'none' });
    }
    if (memory.status !== 'active') {
      return this.store.setVectorState(memory.id, { status: 'stale', model: this.embeddingConfig.model });
    }
    try {
      const [vector] = await this.embedder.embed(embeddingText(memory));
      return this.store.setVectorState(memory.id, {
        status: 'ready',
        model: this.embeddingConfig.model,
        vector
      });
    } catch (error) {
      // 编辑时 store 已保留旧向量；这里只记错误，不把旧向量清掉。
      if (memory.vectorStatus === 'ready' && memory.vectorDimensions > 0) {
        this.log.warn?.('[living-memory] 重新向量化失败，继续沿用旧向量：', error?.message || error);
        return this.store.markVectorError(memory.id, `重新向量化失败：${error?.message || error}`);
      }
      this.log.warn?.('[living-memory] 向量化失败，已保留关键词可检索记忆：', error?.message || error);
      return this.store.setVectorState(memory.id, {
        status: 'error',
        error: String(error?.message || error),
        model: this.embeddingConfig.model
      });
    }
  }

  async recall({ scopeKeys, query, limit = 6, deadlineMs = 0, semantic = true, rrfK = 60, recentMemoryCount = 0 } = {}) {
    const maxItems = clampInt(limit, 1, 20, 6);
    const lexical = this.store.lexicalCandidates({ scopeKeys, query, limit: 800 });
    const ranked = new Map();
    const fusionK = clampInt(rrfK, 10, 200, 60);
    for (const [index, item] of lexical.entries()) ranked.set(item.memory.id, {
      memory: item.memory, lexical: item.score, lexicalRank: index + 1, semantic: 0, semanticRank: 0
    });

    let vectorError = '';
    let semanticAvailable = semantic && this.embedder.ready() && this.store.hasReadyVectors({
      scopeKeys,
      model: this.embeddingConfig.model
    });
    const deadline = boundedDeadlineMs(deadlineMs);
    const startedAt = now();
    const remainingMs = () => deadline ? Math.max(0, deadline - (now() - startedAt)) : 0;

    if (semanticAvailable) {
      try {
        const embeddingTimeoutMs = deadline
          ? Math.min(this.embeddingConfig.recallTimeoutMs, remainingMs())
          : this.embeddingConfig.recallTimeoutMs;
        if (embeddingTimeoutMs < 200) throw new Error('语义召回超出本轮时间预算，已使用关键词结果');
        const [queryVector] = await this.embedder.embed(asText(query, 4000), { timeoutMs: embeddingTimeoutMs });
        const candidates = this.store.vectorCandidates({
          scopeKeys,
          model: this.embeddingConfig.model,
          dimensions: queryVector.length,
          limit: this.embeddingConfig.vectorScanLimit
        });
        if (!candidates.length) {
          semanticAvailable = false;
        } else {
          const query = Float32Array.from(queryVector);
          const queryNorm = vectorNorm(query);
          const best = [];
          let checked = 0;
          for (const item of candidates) {
            // 向量 unpack/cosine 是同步 CPU 工作；每 64 条检查一次本轮预算，
            // 避免 deadline 只约束 embedding HTTP 而不管排序。
            if (deadline && (checked++ & 63) === 0 && remainingMs() <= 0) {
              throw new Error('语义召回超出本轮时间预算，已使用关键词结果');
            }
            const score = cosineWithNorm(query, queryNorm, item.vector);
            if (score > 0) best.push({ id: item.id, score });
          }
          best.sort((a, b) => b.score - a.score).splice(32);
          const memories = this.store.getMemories(best.map((item) => item.id));
          const byId = new Map(memories.map((memory) => [memory.id, memory]));
          for (const [index, match] of best.entries()) {
            const memory = byId.get(match.id);
            if (!memory) continue;
            const prior = ranked.get(memory.id) || { memory, lexical: 0, lexicalRank: 0, semantic: 0, semanticRank: 0 };
            prior.semantic = Math.max(prior.semantic, match.score);
            prior.semanticRank = index + 1;
            ranked.set(memory.id, prior);
          }
        }
      } catch (error) {
        vectorError = String(error?.message || error);
      }
    }

    const entries = [...ranked.values()].map((item) => {
      const rrf = (item.lexicalRank ? 1 / (fusionK + item.lexicalRank) : 0)
        + (item.semanticRank ? 1 / (fusionK + item.semanticRank) : 0);
      const semanticEvidence = Math.max(0, Math.min(1, (item.semantic - 0.28) / 0.42));
      const lexicalEvidence = Math.max(0, Math.min(1, item.lexical / 4));
      const evidence = Math.max(semanticEvidence, lexicalEvidence);
      const rankScore = Math.max(0, Math.min(1, rrf / 0.033));
      const score = evidence > 0
        ? Math.min(1, evidence * 0.82 + rankScore * 0.1 + (Number(item.memory.importance) || 0) / 10 * 0.05 + recencyScore(item.memory) * 0.03)
        : 0;
      return {
        ...item.memory,
        retrieval: {
          score: Math.round(score * 1000) / 1000,
          evidence: Math.round(evidence * 1000) / 1000,
          semantic: Math.round(item.semantic * 1000) / 1000,
          lexical: item.lexical, rrf: Math.round(rrf * 100000) / 100000,
          recency: Math.round(recencyScore(item.memory) * 1000) / 1000
        }
      };
    }).sort((a, b) => b.retrieval.score - a.retrieval.score || b.updatedAt - a.updatedAt).slice(0, maxItems);

    const mode = !semantic || !this.embedder.ready()
      ? 'lexical'
      : !semanticAvailable
        ? 'lexical-pending-vectors'
        : vectorError ? 'hybrid-degraded' : 'hybrid';
    const recentCount = clampInt(recentMemoryCount, 0, 4, 0);
    if (recentCount) {
      const existing = new Set(entries.map((item) => item.id));
      const recent = this.store.listMemories({ scopeKeys, status: 'active', limit: recentCount * 4 }).entries
        .filter((item) => now() - item.updatedAt <= 72 * 3600000
          && !existing.has(item.id)
          // 已过期但还没被每日 prune 扫到的卡不能再当“近期记忆”注入。
          && (!item.expiresAt || item.expiresAt > now()))
        .slice(0, recentCount);
      entries.push(...recent.map((item) => ({ ...item, retrieval: { score: 0, semantic: 0, lexical: 0, rrf: 0, recency: 1, recentFallback: true } })));
    }
    return { entries: entries.slice(0, maxItems + recentCount), vectorError, mode };
  }

  /**
   * Rebuild local vectors without changing a memory card's semantic timestamp.
   * It is used by the external-service migration and is deliberately opt-in:
   * normal startup never turns an Embedding provider into an unbounded job.
   */
  async reindexVectors({ limit = 100000, batchSize = 8, timeoutMs = 0, force = false, onProgress = null } = {}) {
    const report = { configured: this.embedder.ready(), candidates: 0, attempted: 0, ready: 0, failed: 0 };
    if (!this.embedder.ready()) return { ...report, reason: 'Embedding 未配置' };
    const items = this.store.vectorWork({ model: this.embeddingConfig.model, limit, force });
    report.candidates = items.length;
    const size = clampInt(batchSize, 1, 64, 8);
    const effectiveTimeoutMs = clampInt(timeoutMs, 0, 120000, 0);
    const notify = () => {
      if (typeof onProgress === 'function') onProgress({ ...report });
    };
    const saveReady = (memory, vector) => {
      this.store.setVectorState(memory.id, {
        status: 'ready', model: this.embeddingConfig.model, vector, preserveUpdatedAt: true
      });
      report.ready += 1;
    };
    const saveError = (memory, error) => {
      this.store.setVectorState(memory.id, {
        status: 'error', error: String(error?.message || error), model: this.embeddingConfig.model, preserveUpdatedAt: true
      });
      report.failed += 1;
    };

    for (let offset = 0; offset < items.length; offset += size) {
      const batch = items.slice(offset, offset + size);
      report.attempted += batch.length;
      const text = batch.map((memory) => embeddingText(memory));
      try {
        const vectors = await this.embedder.embed(text, { timeoutMs: effectiveTimeoutMs });
        if (vectors.length !== batch.length) throw new Error('Embedding 返回数量不匹配');
        batch.forEach((memory, index) => saveReady(memory, vectors[index]));
      } catch (batchError) {
        // A malformed single card must not make the rest of an import permanently unvectorizable.
        this.log.warn?.('[living-memory] 批量向量回填失败，改为逐条尝试：', batchError?.message || batchError);
        for (const memory of batch) {
          try {
            const [vector] = await this.embedder.embed(embeddingText(memory), { timeoutMs: effectiveTimeoutMs });
            saveReady(memory, vector);
          } catch (error) {
            saveError(memory, error);
          }
        }
      }
      notify();
    }
    return report;
  }

  archiveMemory(id) {
    return this.store.archiveMemory(id);
  }

  unarchiveMemory(id) {
    return this.store.unarchiveMemory(id);
  }

  removeMemory(id) {
    return this.store.removeMemory(id);
  }

  recordTurn(raw) {
    return this.store.recordTurn(raw);
  }

  prune() {
    return this.store.pruneExpired();
  }

  close() {
    this.store.close();
  }
}
