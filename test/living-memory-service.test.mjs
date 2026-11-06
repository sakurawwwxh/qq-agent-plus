import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { readLivingMemoryEmbeddingConfig } from '../src/living-memory/embedding.js';
import { LivingMemoryService } from '../src/living-memory/service.js';
import { LivingMemoryStore } from '../src/living-memory/store.js';
import { normalizeLivingMemoryConfig } from '../src/living-memory/config.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-living-memory-'));
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

function fakeService() {
  const store = new LivingMemoryStore({ file: path.join(root, `memory-${Date.now()}-${Math.random()}.sqlite`) });
  const embeddingConfig = { enabled: true, model: 'test-embedding', dimensions: 3, recallTimeoutMs: 1200 };
  const embedder = {
    ready: () => true,
    async embed(input) {
      const values = Array.isArray(input) ? input : [input];
      return values.map(() => [0.1, 0.2, 0.3]);
    }
  };
  return new LivingMemoryService({ file: store.file, embeddingConfig, store, embedder, log: { warn() {} } });
}

test('living memory keeps scopes isolated while combining lexical and local vectors', async () => {
  const service = fakeService();
  const group = await service.upsertMemory({
    scopeKey: 'group:100', type: 'project', summary: 'NAS 上的向量记忆项目',
    content: '项目使用本地 SQLite 保存长期语义记忆。', importance: 8,
    tags: ['NAS', '向量记忆'], entities: ['SQLite']
  });
  await service.upsertMemory({
    scopeKey: 'group:200', type: 'fact', summary: '另一个群的私有约定',
    content: '这条信息不能泄露给其他群。', importance: 9, tags: ['私有']
  });
  assert.equal(group.vectorStatus, 'ready');
  const recalled = await service.recall({ scopeKeys: ['group:100'], query: 'SQLite 记忆', limit: 10 });
  assert.equal(recalled.entries.length, 1);
  assert.equal(recalled.entries[0].scopeKey, 'group:100');
  assert.equal(recalled.entries[0].id, group.id);
  service.close();
});

test('recall skips Embedding until the selected scope has a ready vector', async () => {
  const store = new LivingMemoryStore({ file: path.join(root, `pending-${Date.now()}-${Math.random()}.sqlite`) });
  const embedder = {
    calls: 0,
    ready: () => true,
    async embed() { this.calls += 1; throw new Error('不应在没有向量卡时调用 Embedding'); }
  };
  const service = new LivingMemoryService({
    file: store.file,
    embeddingConfig: { enabled: true, model: 'test-embedding', dimensions: 3, recallTimeoutMs: 1200 },
    store,
    embedder,
    log: { warn() {} }
  });
  const memory = store.upsertMemory({
    scopeKey: 'group:100', type: 'project', summary: 'NAS 长期记忆计划',
    content: '在 Agent 数据目录里保存向量和元数据。', importance: 8
  });

  const recalled = await service.recall({ scopeKeys: ['group:100'], query: 'NAS 记忆', deadlineMs: 300 });
  assert.equal(embedder.calls, 0);
  assert.equal(recalled.mode, 'lexical-pending-vectors');
  assert.equal(recalled.entries[0].id, memory.id);
  service.close();
});

test('recall preserves lexical results when the semantic branch exhausts its deadline', async () => {
  const service = fakeService();
  const saved = await service.upsertMemory({
    scopeKey: 'group:100', type: 'project', summary: 'SQLite 向量记忆项目',
    content: '项目使用 SQLite 保存长期语义记忆。', importance: 8
  });
  let embeddingTimeoutMs = 0;
  service.embedder = {
    ready: () => true,
    async embed(_input, { timeoutMs } = {}) {
      embeddingTimeoutMs = Number(timeoutMs) || 0;
      throw new Error('Embedding 请求超时');
    }
  };

  const recalled = await service.recall({ scopeKeys: ['group:100'], query: 'SQLite 记忆', deadlineMs: 700 });
  assert.ok(embeddingTimeoutMs >= 200 && embeddingTimeoutMs <= 700, `实际预算 ${embeddingTimeoutMs}ms`);
  assert.equal(recalled.mode, 'hybrid-degraded');
  assert.match(recalled.vectorError, /Embedding 请求超时/);
  assert.equal(recalled.entries[0].id, saved.id);
  service.close();
});

test('living memory rejects sensitive cards and removes the local vector with its row', async () => {
  const service = fakeService();
  await assert.rejects(
    service.upsertMemory({ scopeKey: 'group:100', summary: 'API Key', content: 'token=secret-value' }),
    /拒绝保存/
  );
  const saved = await service.upsertMemory({
    scopeKey: 'group:100', summary: '群约定', content: '周五晚上进行项目复盘。', importance: 5
  });
  const removed = service.removeMemory(saved.id);
  assert.equal(removed.id, saved.id);
  assert.equal(service.store.getMemory(saved.id), null);
  service.close();
});

test('living memory keeps structured reflection fields and immutable versions', () => {
  const store = new LivingMemoryStore({ file: path.join(root, `versions-${Date.now()}-${Math.random()}.sqlite`), turnRetentionDays: 0 });
  const first = store.upsertMemory({
    scopeKey: 'group:100', summary: '群内决定周五复盘', content: '张三提议周五进行项目复盘，机器人确认记录。',
    topics: ['项目复盘'], keyFacts: ['周五进行项目复盘'], participants: ['张三', '机器人'], sentiment: 'positive',
    source: { turnIds: ['turn-1'] }, reason: 'window-reflection'
  });
  const second = store.upsertMemory({
    ...first, summary: '群内确认周五复盘', reason: 'manual-correction'
  }, { id: first.id, reason: 'manual-correction' });
  assert.deepEqual(second.topics, ['项目复盘']);
  assert.equal(second.sentiment, 'positive');
  assert.equal(store.stats().versions, 2);
  store.recordTurn({ scopeKey: 'group:100', payload: { lines: [{ text: '永久来源' }] } });
  store.pruneExpired();
  assert.equal(store.stats().turns, 1, '0 天保留期表示永久保存来源回合');
  store.close();
});

test('memory versions keep only the latest 20 snapshots per card', () => {
  const store = new LivingMemoryStore({ file: path.join(root, `version-cap-${Date.now()}-${Math.random()}.sqlite`) });
  let saved = null;
  for (let i = 0; i < 25; i += 1) {
    saved = store.upsertMemory({
      scopeKey: 'group:100', summary: `第 ${i} 版摘要`, content: `第 ${i} 版正文`
    }, { id: saved?.id || '', reason: `edit-${i}` });
  }
  assert.equal(store.stats().versions, 20, '版本快照不能无界增长');
  store.close();
});

test('removing a card also removes its version snapshots', async () => {
  const service = fakeService();
  const first = await service.upsertMemory({
    scopeKey: 'group:100', summary: '初版', content: '第一版正文'
  });
  await service.upsertMemory({
    id: first.id, scopeKey: 'group:100', summary: '二版', content: '第二版正文'
  });
  assert.equal(service.store.stats().versions, 2);
  service.removeMemory(first.id);
  assert.equal(service.store.stats().versions, 0, '删卡必须连版本快照一起删，否则正文仍可读');
  service.close();
});

test('unarchiving an expired card clears its expiry so recall can see it again', () => {
  const store = new LivingMemoryStore({ file: path.join(root, `unarchive-${Date.now()}-${Math.random()}.sqlite`) });
  const expired = store.upsertMemory({
    scopeKey: 'group:100', summary: '过期卡片', content: '过期正文'
  });
  store.db.prepare("UPDATE memories SET status='archived', archived_at=?, expires_at=? WHERE id=?")
    .run(Date.now(), Date.now() - 1000, expired.id);
  const restored = store.unarchiveMemory(expired.id);
  assert.equal(restored.status, 'active');
  assert.equal(restored.expiresAt, 0, '已过期卡恢复后要清掉过期时间');
  assert.equal(restored.archivedAt, 0);

  const future = store.upsertMemory({
    scopeKey: 'group:100', summary: '未过期卡片', content: '未过期正文', expiresAt: Date.now() + 86400000
  });
  store.archiveMemory(future.id);
  const kept = store.unarchiveMemory(future.id);
  assert.ok(kept.expiresAt > Date.now(), '未过期卡的过期时间要保留');
  store.close();
});

test('redaction covers structured fields, not just summary/content', async () => {
  const service = fakeService();
  await assert.rejects(
    service.upsertMemory({
      scopeKey: 'group:100', summary: '群内约定', content: '正常正文',
      keyFacts: ['管理员密码是 abc123']
    }),
    /拒绝保存/,
    'keyFacts 里的凭据同样不能入库'
  );
  await assert.rejects(
    service.upsertMemory({
      scopeKey: 'group:100', summary: '群内约定', content: '正常正文',
      participants: ['身份证 110101199001011234']
    }),
    /拒绝保存/,
    'participants 里的证件号同样不能入库'
  );
  service.close();
});

test('embedding configuration stays in process environment and long-memory defaults stay disabled', () => {
  const config = normalizeLivingMemoryConfig({
    enabled: true,
    mode: 'invalid',
    serviceUrl: 'http://legacy.example.test:8788',
    recallTimeoutMs: 999999,
    maxInjectChars: 1,
    groups: ['1', 'group:2', '3', 'bad']
  });
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'shadow');
  assert.equal(config.recallTimeoutMs, 5000);
  assert.equal(config.maxInjectChars, 300);
  assert.deepEqual(config.groups, ['1', '3']);
  assert.equal('serviceUrl' in config, false);
  assert.equal(normalizeLivingMemoryConfig({ turnRetentionDays: 0 }).turnRetentionDays, 0);
  assert.equal(normalizeLivingMemoryConfig({}).recallTimeoutMs, 1800);
  const cleared = normalizeLivingMemoryConfig({
    autoInjectMinScore: null,
    autoInjectDiversity: '',
    autoInjectMaxItems: null,
    turnRetentionDays: null
  });
  assert.equal(cleared.autoInjectMinScore, 0.3, 'null/空值应回默认，而不是变成 0');
  assert.equal(cleared.autoInjectDiversity, 0.68);
  assert.equal(cleared.autoInjectMaxItems, 3);
  assert.equal(cleared.turnRetentionDays, 7);
  assert.equal(normalizeLivingMemoryConfig({ autoInjectMinScore: 0 }).autoInjectMinScore, 0, '显式 0 要保留');
  const embedding = readLivingMemoryEmbeddingConfig({
    LIVING_MEMORY_EMBEDDING_BASE_URL: 'https://embed.example.com/v1/',
    LIVING_MEMORY_EMBEDDING_API_KEY: 'secret',
    LIVING_MEMORY_EMBEDDING_MODEL: 'embed-test'
  });
  assert.equal(embedding.enabled, true);
  assert.equal(embedding.baseUrl, 'https://embed.example.com/v1');
  assert.equal(embedding.apiKey, 'secret');
});
