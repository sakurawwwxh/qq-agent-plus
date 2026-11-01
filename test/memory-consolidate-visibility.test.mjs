import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-consolidate-visibility-'));
process.env.QQ_AGENT_DATA_DIR = dir;

const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { MemoryStore } = await import('../src/memory/memory.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

let sequence = 0;
function fixture(t, { visibility, shared = false, otherOnly = false, empty = false, otherOrigin = 'model', singleSource = false, otherPrivate = true, legacy = false, blocked = false } = {}) {
  const uid = String(100 + ++sequence);
  const group = String(sequence);
  const chatKey = `group:${group}`;
  const otherChat = otherPrivate ? `private:${uid}` : `group:${100 + sequence}`;
  const localText = 'current-source';
  const hiddenText = 'other-source';
  const replacement = 'updated-current-source';
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = [group];
  cfg.api = { ...cfg.api, model: 'fixture', baseUrl: 'https://model.invalid/v1', apiKey: 'fixture' };
  cfg.sticker.enabled = false;
  cfg.memory.useChatModel = true;
  cfg.memory.visibility = visibility || { mode: 'perChat', hidePrivateInGroup: false };
  cfg.memory.crossScopeSharedContext = shared;
  cfg.memory.discoverMinMessages = 5;
  cfg.memory.maxImpressionsPerMember = 5;
  if (blocked) cfg.blocklist = { [group]: [uid] };
  setRuntimeConfig(cfg);

  const store = new ChatStore(0, { dataDir: dir });
  const memory = new MemoryStore();
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ store, onebot: {} });
  const runner = new Orchestrator({ store, sessions, sender, onebot: {}, stickers: {}, memory });
  const oldFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('https://model.invalid/'), '不得发起真实网络请求');
    requests.push(JSON.parse(String(options.body || '{}')));
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ impressions: [replacement] }) } }],
      usage: { total_tokens: 10 }
    });
  };
  t.after(async () => {
    globalThis.fetch = oldFetch;
    await runner.abortAll();
    store.close();
  });

  if (!empty) {
    if (!otherOnly) {
      for (let n = 0; n < 5; n += 1) {
        memory.append(chatKey, 'memberImpression', `${localText}-${n}`, { userId: uid, target: 'Fixture user' });
      }
    }
    if (!singleSource) {
      memory.append(otherChat, 'memberImpression', hiddenText, { userId: uid, target: 'Fixture user', origin: otherOrigin });
    }
    if (legacy) {
      // 历史遗留的"只有名字、没有 QQ 号"记录：身份反查后可能指向 uid
      memory.append(chatKey, 'memberImpression', 'legacy-visible', { userId: '', target: 'Fixture user' });
    }
  }
  for (let n = 0; n < 5; n += 1) {
    store.appendIncoming(chatKey, {
      mid: `fixture-${sequence}-${n}`, senderId: uid, senderName: 'Fixture user', text: `Synthetic statement ${n}`
    });
  }
  return { uid, chatKey, store, memory, runner, requests, localText, hiddenText, replacement };
}

for (const visibility of [
  { mode: 'perChat', hidePrivateInGroup: false },
  { mode: 'global', hidePrivateInGroup: true }
]) {
  const label = visibility.mode === 'perChat' ? 'perChat' : 'hidePrivateInGroup';
  for (const explicit of [true, false]) {
    for (const force of [true, false]) {
      test(`${label}：${explicit ? '指定整理' : '发现活跃成员'}不能重新纳入不可见人物（force=${force}）`, async (t) => {
        const f = fixture(t, { visibility, otherPrivate: visibility.mode !== 'perChat' });
        const before = f.memory.getMember('', f.uid);
        const result = await f.runner.consolidateMemoryForChat(f.chatKey, {
          force, ...(explicit ? { userIds: [f.uid] } : {})
        });
        const after = f.memory.getMember('', f.uid);
        assert.deepEqual(after.impressions, before.impressions, '不可见记录及时间戳、来源均不能被截断或改写');
        assert.deepEqual(after.sourceChatKeys, before.sourceChatKeys);
        assert.equal(f.requests.length, 0, '被可见性保护排除的人不能再消耗模型调用');
        assert.equal(result.results.length, 0);
        assert.deepEqual(result.failed, []);
        assert.match(result.skipped.find((item) => item.userId === f.uid)?.reason || '', /不可见/);
        assert.ok(!JSON.stringify(result).includes(f.hiddenText), '跳过原因不泄露隐藏记录正文');
      });
    }
  }
}

test('共享最近上下文不解除人物记忆的整理可见性保护', async (t) => {
  const f = fixture(t, { shared: true, otherOrigin: 'manual' });
  const before = f.memory.getMember('', f.uid).impressions;
  await f.runner.consolidateMemoryForChat(f.chatKey, { userIds: [f.uid], force: true });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.memory.getMember('', f.uid).impressions, before);
});

test('默认 global 仍允许全局整理', async (t) => {
  const f = fixture(t, { visibility: { mode: 'global', hidePrivateInGroup: false } });
  const result = await f.runner.consolidateMemoryForChat(f.chatKey, { userIds: [f.uid], force: true });
  assert.equal(f.requests.length, 1);
  assert.ok(JSON.stringify(f.requests[0]).includes(f.hiddenText));
  assert.equal(result.results[0]?.isNew, false);
  assert.deepEqual(result.failed, []);
});

test('单一可见来源仍可正常整理', async (t) => {
  const f = fixture(t, { singleSource: true });
  const result = await f.runner.consolidateMemoryForChat(f.chatKey, { userIds: [f.uid], force: true });
  assert.equal(f.requests.length, 1);
  assert.equal(result.results[0]?.isNew, false);
  assert.ok(f.memory.getMember('', f.uid).impressions.some((entry) => entry.content === f.replacement));
});

test('真正的新人物仍可通过活跃成员发现建立记忆', async (t) => {
  const f = fixture(t, { empty: true });
  const result = await f.runner.consolidateMemoryForChat(f.chatKey);
  assert.equal(f.requests.length, 1);
  assert.equal(result.results[0]?.isNew, true);
  assert.deepEqual(result.failed, []);
  assert.ok(f.memory.getMember('', f.uid).impressions.some((entry) => entry.content === f.replacement));
});

test('已在其他会话有记录的人首次出现在当前会话时仍可合并', async (t) => {
  const f = fixture(t, { otherOnly: true });
  const other = f.memory.getMember('', f.uid).impressions[0];
  const result = await f.runner.consolidateMemoryForChat(f.chatKey, { userIds: [f.uid] });
  const after = f.memory.getMember('', f.uid).impressions;
  assert.equal(f.requests.length, 1);
  assert.equal(result.results[0]?.isNew, true);
  assert.deepEqual(after.find((entry) => entry.content === f.hiddenText), other);
  assert.ok(after.some((entry) => entry.content === f.replacement));
});

test('历史名字记录反查到不可见人物时也不能绕过排除', async (t) => {
  const f = fixture(t, { legacy: true });
  const beforeHidden = f.memory.getMember('', f.uid).impressions.find((entry) => entry.content === f.hiddenText);
  assert.ok(beforeHidden);
  const result = await f.runner.consolidateMemoryForChat(f.chatKey, { force: true });
  assert.equal(f.requests.length, 0, '不能把隐藏来源印象送去模型');
  const after = f.memory.getMember('', f.uid).impressions;
  assert.deepEqual(after.find((entry) => entry.content === f.hiddenText), beforeHidden, '隐藏来源记录不能被截断或改写');
  assert.ok(result.skipped.some((item) => String(item.userId) === f.uid && /不可见/.test(item.reason)));
});

test('屏蔽名单生效前存档的发言不能作为整理材料', async (t) => {
  const f = fixture(t, { empty: true, blocked: true });
  const result = await f.runner.consolidateMemoryForChat(f.chatKey);
  assert.equal(f.requests.length, 0, '被屏蔽群员的发言不能进整理模型');
  assert.equal(f.memory.getMember('', f.uid).impressions.length, 0, '不能为被屏蔽群员新建印象');
  assert.equal(result.results.length, 0);
});

test('混合批次仍整理可见人物，指定目标不带无关的跳过项', async (t) => {
  const f = fixture(t);
  const before = f.memory.getMember('', f.uid).impressions;
  const otherUid = '999';
  f.memory.append(f.chatKey, 'memberImpression', 'eligible-member', { userId: otherUid, target: 'Other fixture user' });
  const batch = await f.runner.consolidateMemoryForChat(f.chatKey, { force: true });
  assert.deepEqual(batch.results.map((item) => item.userId), [otherUid]);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.memory.getMember('', f.uid).impressions, before);
  assert.ok(batch.skipped.some((item) => item.userId === f.uid));
  const selected = await f.runner.consolidateMemoryForChat(f.chatKey, { userIds: [otherUid], force: true });
  assert.deepEqual(selected.results.map((item) => item.userId), [otherUid]);
  assert.equal(selected.skipped.length, 0);
});

test('只有名字的遗留记录 + 仅私聊来源：反查后也不能绕过可见性', async (t) => {
  const f = fixture(t, { otherOnly: true, legacy: true });
  const before = f.memory.getMember('', f.uid).impressions
    .find((entry) => entry.content === f.hiddenText);
  assert.ok(before, '前提：该人只有私聊来源的印象');
  const result = await f.runner.consolidateMemoryForChat(f.chatKey, { force: true });
  assert.equal(f.requests.length, 0, '不能把私聊来源的正文送去整理模型');
  const after = f.memory.getMember('', f.uid).impressions;
  assert.deepEqual(after.find((entry) => entry.content === f.hiddenText), before,
    '隐藏来源记录不能被改写/截断');
  assert.ok(result.skipped.some((item) => String(item.userId) === f.uid && /不可见/.test(item.reason)));
});

test('force 手动整理也不能为“只有名字”的条目白烧模型调用', async (t) => {
  const f = fixture(t, { empty: true });
  f.memory.append(f.chatKey, 'memberImpression', 'ghost-impression', { userId: '', target: 'Ghost Name' });
  const result = await f.runner.consolidateMemoryForChat(f.chatKey, { force: true });
  // 活跃群友仍可走“发现新人”建立印象，但不能把无法反查 QQ 号的 ghost 条目送去模型。
  assert.ok(!JSON.stringify(f.requests).includes('ghost-impression'), '名字遗留条目不能进模型');
  assert.ok(result.skipped.some((item) => /只有名字|QQ 号/.test(item.reason)));
  assert.deepEqual(result.failed, []);
});
