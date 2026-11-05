import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-search-scope-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { impressionVisible } = await import('../src/core/memory-visibility.js');
const { MemorySearchIndex } = await import('../src/memory/memory-search.js');
const { MemoryStore } = await import('../src/memory/memory-global.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');
let memory;

const at = Date.UTC(2026, 0, 1);
const targetId = '9001';
const targetText = 'project 项目 needle synthetic target record';
function member(userId, content, sourceChatKeys) {
  return { userId, name: 'Synthetic', impressions: [{
    content, sourceChatKeys, createdAt: at, lastObservedAt: at, origin: 'model'
  }] };
}
function fixture(count, sources = ['private:1']) {
  return [
    ...Array.from({ length: count }, (_, i) => member(String(10000 + i), 'project 项目', sources)),
    member(targetId, targetText, ['group:1'])
  ];
}
function indexFor(t) {
  const index = new MemorySearchIndex({ dataDir: fs.mkdtempSync(path.join(dir, 'index-')) });
  t.after(() => index.close());
  return index;
}

after(() => {
  memory?.close();
  // Only remove this test's freshly created temporary directory.
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const scopes = [
  { name: '指定人物', userId: targetId, visibility: { mode: 'global', hidePrivateInGroup: false } },
  { name: 'perChat', visibility: { mode: 'perChat', hidePrivateInGroup: false } },
  { name: '群聊隐藏私聊来源', visibility: { mode: 'global', hidePrivateInGroup: true } }
];
for (const scope of scopes) {
  for (const count of [239, 240]) {
    for (const query of ['project', '项目']) {
      test(`记忆检索 ${scope.name}：${count} 条其他匹配记录不挤掉 ${query} 的目标`, (t) => {
        const index = indexFor(t);
        const members = fixture(count);
        const found = index.search({ members, query, chatKey: 'group:1', ...scope });
        assert.equal(index.available, true);
        assert.equal(index.error, '', '必须由正常索引查询命中');
        assert.deepEqual(found.map((row) => row.userId), [targetId]);
        assert.equal(found[0].content, targetText);
        assert.equal(index.stats().docs, count + 1, '索引仍保留全部人物和来源');
      });
    }
  }
}

test('记忆检索：候选来源筛选与现有可见性规则一致', (t) => {
  const index = indexFor(t);
  const sources = [[], ['group:1'], ['group:10'], ['private:1'],
    ['group:1', 'group:10'], ['group:1', 'private:1'],
    ['private:10'], ['Private:1'], ['group:1', 'Private:1']];
  const members = sources.map((keys, i) => member(String(10000 + i), 'project', keys));
  for (const chatKey of ['group:1', 'group:10', 'private:1', '']) {
    for (const mode of ['global', 'perChat']) {
      for (const hidePrivateInGroup of [false, true]) {
        const visibility = { mode, hidePrivateInGroup };
        for (const userId of ['', '10005']) {
          const expected = members.filter((m) => (!userId || m.userId === userId)
            && impressionVisible(m.impressions[0], chatKey, visibility)).map((m) => m.userId).sort();
          const found = index.search({ members, query: 'project', chatKey, visibility, userId, limit: 50 });
          assert.equal(index.error, '');
          assert.deepEqual(found.map((row) => row.userId).sort(), expected,
            JSON.stringify({ chatKey, visibility, userId }));
        }
      }
    }
  }
});

test('记忆检索：组合人物与会话条件，不匹配任一条件就不返回', (t) => {
  const index = indexFor(t);
  const members = fixture(240, ['group:10']);
  const opts = { members, query: 'project', chatKey: 'group:1',
    visibility: { mode: 'perChat', hidePrivateInGroup: true } };
  assert.deepEqual(index.search({ ...opts, userId: targetId }).map((row) => row.userId), [targetId]);
  assert.deepEqual(index.search({ ...opts, userId: '10000' }), []);
  assert.deepEqual(index.search({ ...opts, userId: '99999' }), []);
  assert.deepEqual(index.search({ ...opts, userId: "9001' OR 1=1 --" }), []);
  assert.deepEqual(index.search({ ...opts, query: 'notpresent' }), []);
  assert.equal(index.error, '');
});

test('记忆检索：切换查询范围不改变全局索引与普通搜索结果', (t) => {
  const index = indexFor(t);
  const members = fixture(240);
  const opts = { members, query: 'project', chatKey: 'group:1' };
  const before = index.search(opts);
  assert.equal(before.length, 8);
  assert.ok(before.every((row) => row.userId !== targetId));
  assert.deepEqual(index.search({ ...opts, userId: targetId }).map((row) => row.userId), [targetId]);
  assert.deepEqual(index.search(opts), before);
  assert.equal(index.stats().docs, 241);
  assert.equal(index.error, '');
});

test('记忆检索：范围内结果仍遵守返回数量上限', (t) => {
  const index = indexFor(t);
  const members = fixture(300, ['group:1']);
  const opts = { members, query: 'project', chatKey: 'group:1',
    visibility: { mode: 'perChat', hidePrivateInGroup: false } };
  assert.equal(index.search({ ...opts, limit: 3 }).length, 3);
  assert.equal(index.search({ ...opts, limit: 1000 }).length, 50);
  assert.equal(index.error, '');
});

updateConfig(structuredClone(DEFAULT_CONFIG));
memory = new MemoryStore();
for (const m of fixture(240)) {
  memory.append(m.impressions[0].sourceChatKeys[0], 'memberImpression', m.impressions[0].content,
    { userId: m.userId, target: m.name });
}
const defs = buildToolDefs();
for (const scope of scopes) {
  test(`memory_query ${scope.name}：找回范围内记录且剥离来源`, async () => {
    updateConfig({ memory: { visibility: scope.visibility } });
    const ctx = { chatKey: 'group:1', memory, session: {} };
    const result = await executeTool(defs, ctx, 'memory_query',
      JSON.stringify({ query: '项目', userId: scope.userId, limit: 3 }));
    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content);
    assert.deepEqual(data.memberImpression.map((row) => row.userId), [targetId]);
    assert.doesNotMatch(result.content, /sourceChatKeys|private:1|group:1/);
    assert.equal(memory.searchIndex.available, true);
    assert.equal(memory.searchIndex.error, '', '不依赖索引故障后的内存回退');
  });
}

test('memory_query 无关键词：仍可列举指定人物，且不返回来源', async () => {
  updateConfig({ memory: { visibility: { mode: 'global', hidePrivateInGroup: false } } });
  const result = await executeTool(defs, { chatKey: 'group:1', memory, session: {} },
    'memory_query', JSON.stringify({ userId: targetId }));
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content).memberImpression.map((row) => row.userId), [targetId]);
  assert.doesNotMatch(result.content, /sourceChatKeys|private:1|group:1/);
});
