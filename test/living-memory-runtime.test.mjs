import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { LivingMemoryRuntime } from '../src/living-memory/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-living-memory-runtime-'));
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

function serviceFixture() {
  return {
    recalls: [],
    async recall(args) {
      this.recalls.push(args);
      return {
        mode: 'hybrid',
        entries: [{ id: 'm_1', type: 'project', summary: '本地 SQLite 向量记忆', content: '向量和卡片都保存在 Agent 数据目录。', importance: 8 }]
      };
    },
    recordTurn(raw) { this.recorded = raw; return { id: 'turn_1' }; },
    async upsertMemory(raw) { this.created = raw; return { ...raw, id: 'm_2' }; },
    health() { return { ok: true, stats: { total: 0, active: 0, vectorReady: 0, turns: 0, scopes: [] } }; },
    store: {
      listMemories: () => ({ entries: [], total: 0 }),
      getMemory: () => null,
      graph: () => ({ nodes: [], edges: [] })
    },
    removeMemory: () => null,
    archiveMemory: () => null,
    close() {}
  };
}

test('shadow mode audits semantic recall without injecting it into the prompt', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'shadow', autoInjectMinQueryChars: 1, autoInjectMinScore: 0 } }), service
  });
  const result = await runtime.recall({ chatKey: 'group:100', triggerEntries: [{ text: '之前的向量记忆方案是什么？' }] });
  assert.equal(result.text, '');
  assert.equal(result.entries.length, 1);
  assert.deepEqual(service.recalls[0].scopeKeys, ['group:100']);
  runtime.stop();
});

test('active mode injects only current scope memories and keeps private chat opt-in', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'active', maxInjectChars: 900, allowPrivate: false, autoInjectMinQueryChars: 1, autoInjectMinScore: 0 } }), service
  });
  const group = await runtime.recall({ chatKey: 'group:100', triggerEntries: [{ text: 'SQLite' }] });
  assert.match(group.text, /长期语义记忆/);
  const privateResult = await runtime.recall({ chatKey: 'private:100', triggerEntries: [{ text: 'SQLite' }] });
  assert.equal(privateResult.mode, 'disabled');
  assert.equal(service.recalls.length, 1);
  runtime.stop();
});

test('automatic recall skips low-signal messages but keeps explicit searches available', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'active', autoInjectMinQueryChars: 4 } }), service
  });
  const result = await runtime.recall({ chatKey: 'group:100', triggerEntries: [{ text: '？' }] });
  assert.equal(result.mode, 'low-signal-query');
  assert.equal(service.recalls.length, 0);
  runtime.stop();
});

test('default automatic threshold accepts normalized retrieval scores', async () => {
  const service = serviceFixture();
  service.recall = async () => ({
    mode: 'hybrid',
    entries: [{
      id: 'm_1', type: 'project', summary: 'SQLite 向量记忆', content: '向量和卡片保存在数据目录。', importance: 8,
      retrieval: { score: 0.62 }
    }]
  });
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'active', autoInjectMinQueryChars: 1 } }), service
  });
  const result = await runtime.recall({ chatKey: 'group:100', triggerEntries: [{ text: 'SQLite' }] });
  assert.equal(result.entries.length, 1);
  assert.match(result.text, /SQLite 向量记忆/);
  runtime.stop();
});

test('passive capture queues incoming messages without a bot reply', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, captureAllMessages: true, captureMinMessages: 60, captureIdleMs: 600000 } }), service
  });
  runtime.captureIncoming({
    chatKey: 'group:100',
    message: { text: '下周讨论向量记忆的迁移方案', senderName: '测试用户', senderId: '10001', ts: Date.now() }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.recorded.scopeKey, 'group:100');
  assert.match(JSON.stringify(service.recorded.payload), /下周讨论向量记忆/);
  runtime.stop();
});

test('关闭自动提炼后，完整消息捕获不再写入来源回合或安排提炼', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, autoCapture: false, captureAllMessages: true } }), service
  });
  runtime.captureIncoming({
    chatKey: 'group:100',
    message: { text: '这条完整捕获模式下也不应入库', senderName: '测试用户', senderId: '10001', ts: Date.now() }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.recorded, undefined);
  runtime.stop();
});

test('turn capture skips sensitive source text and never blocks the caller', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'shadow', captureMinMessages: 60, captureIdleMs: 600000 } }), service
  });
  runtime.captureTurn({
    chatKey: 'group:100', sessionId: 's1',
    triggerEntries: [{ text: '我的 API Key 是 should-not-store' }, { text: '下周讨论向量记忆' }],
    sent: [{ text: '好，我们下周讨论。' }]
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.recorded.scopeKey, 'group:100');
  const text = JSON.stringify(service.recorded.payload);
  assert.doesNotMatch(text, /should-not-store/);
  assert.match(text, /下周讨论向量记忆/);
  runtime.stop();
});

test('disabled runtime does not create its SQLite database while the page is only inspected', () => {
  const dataDir = path.join(root, `disabled-${Date.now()}-${Math.random()}`);
  const runtime = new LivingMemoryRuntime({
    dataDir,
    getConfig: () => ({ livingMemory: { enabled: false } })
  });
  assert.equal(runtime.status().initialized, false);
  assert.deepEqual(runtime.list({ scopeKeys: ['group:100'] }), { total: 0, entries: [] });
  assert.equal(fs.existsSync(path.join(dataDir, 'living-memory', 'living-memory.sqlite')), false);
  runtime.stop();
});
