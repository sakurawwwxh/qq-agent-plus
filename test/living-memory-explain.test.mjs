// 长期记忆召回解释：分数与来源回合要能从控制台数据里还原，且不丢字段。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LivingMemoryStore } from '../src/living-memory/store.js';
import { LivingMemoryService } from '../src/living-memory/service.js';
import { explainRecall } from '../src/living-memory/explain.js';
import { LivingMemoryRuntime } from '../src/living-memory/runtime.js';

test('explainRecall：保留 retrieval，并补出来源回合的行摘要', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lm-explain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new LivingMemoryStore({ file: path.join(dir, 'lm.sqlite') });
  const service = new LivingMemoryService({
    store,
    embedder: { ready: () => false, embed: async () => [] },
    embeddingConfig: { enabled: false, model: '', dimensions: 0 },
    log: { warn() {} }
  });
  const turn = store.recordTurn({
    scopeKey: 'group:1',
    payload: { lines: [{ role: 'user', senderName: '张三', text: '我在用 NAS 存照片' }] }
  });
  await service.upsertMemory({
    scopeKey: 'group:1', type: 'fact', summary: '张三用 NAS', content: '张三在用 NAS 存照片。',
    participants: ['张三'], source: { turnIds: [turn.id], turnCount: 1 }
  });
  const result = await service.recall({ scopeKeys: ['group:1'], query: 'NAS', semantic: false });
  const explained = explainRecall(result, store);
  assert.ok(explained.entries.length >= 1);
  const entry = explained.entries[0];
  assert.ok(entry.retrieval && typeof entry.retrieval.score === 'number');
  assert.ok(Array.isArray(entry.sourceTurns));
  assert.equal(entry.sourceTurns[0].id, turn.id);
  assert.equal(entry.sourceTurns[0].lines[0].sender, '张三');
  assert.match(entry.sourceTurns[0].lines[0].text, /NAS/);
  service.close();
});

test('forgetParticipant 只删指定 scope 里匹配的参与者，不跨 scope', async () => {
  const removed = [];
  const pages = [
    { total: 3, entries: [
      { id: 'a', participants: ['张三'] },
      { id: 'b', participants: ['李四'] },
      { id: 'c', participants: ['张三', '李四'] }
    ] }
  ];
  const fakeStore = {
    listMemories: ({ offset }) => pages[offset] || { total: 3, entries: [] }
  };
  const runtime = new LivingMemoryRuntime({
    getConfig: () => ({ livingMemory: { enabled: true, groups: ['1'] } }),
    dataDir: os.tmpdir(),
    service: { store: fakeStore, removeMemory: (id) => { removed.push(id); return { id }; } }
  });
  const result = await runtime.forgetParticipant({ scopeKey: 'group:1', participant: '张三' });
  assert.equal(result.removed, 2);
  assert.deepEqual(removed, ['a', 'c']);
  await assert.rejects(
    () => runtime.forgetParticipant({ scopeKey: 'group:2', participant: '张三' }),
    /不在长期记忆允许范围/
  );
});

test('explainRecall：坏 turn / 空 source 不影响召回结果', () => {
  assert.deepEqual(explainRecall(null, null), null);
  const result = { entries: [{ id: 'm1', retrieval: { score: 1 }, source: { turnIds: ['missing'] } }] };
  const store = { db: { prepare: () => ({ get: () => undefined }) } };
  const out = explainRecall(result, store);
  assert.equal(out.entries[0].retrieval.score, 1);
  assert.deepEqual(out.entries[0].sourceTurns, []);
});
