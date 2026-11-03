// TTS 适配器 + 群日报的行为测试（2026-09-28）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-digest-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

// 临时配置：给 llm 一个能通过校验的网关地址（fetch 会被桩掉）
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active', paused: false },
  allow: { private: ['100000001'] },
  api: { baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'mock', thinking: 'on' },
  tts: { enabled: true, baseUrl: 'https://tts.example.com/v1', apiKey: 'tts-key', model: 'cosyvoice', voice: 'a' },
  groupDigest: { enabled: true, time: '09:30', chats: ['group:123'], maxChars: 300 }
}));

const { synthesizeSpeech, ttsConfigured } = await import('../src/llm/tts-openai.js');
const { GroupDigestManager } = await import('../src/features/group-digest.js');
const { ChatStore } = await import('../src/core/store.js');

test('synthesizeSpeech：请求形状正确、空音频/非 200 报错、未配置拒绝', async () => {
  const calls = [];
  const fakeFetch = async (url, req) => {
    calls.push({ url: String(url), body: JSON.parse(req.body), auth: req.headers.authorization });
    return new Response(Buffer.from('ID3fakeaudio'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const out = await synthesizeSpeech({
    cfg: { baseUrl: 'https://tts.example.com/v1', apiKey: 'k1', model: 'cosyvoice', voice: 'a', format: 'mp3' },
    text: '晚上好呀',
    fetchFn: fakeFetch
  });
  assert.equal(calls[0].url, 'https://tts.example.com/v1/audio/speech');
  assert.equal(calls[0].body.model, 'cosyvoice');
  assert.equal(calls[0].body.input, '晚上好呀');
  assert.equal(calls[0].body.response_format, 'mp3');
  assert.equal(calls[0].auth, 'Bearer k1');
  assert.equal(out.format, 'mp3');
  assert.ok(out.buffer.length > 0);

  await assert.rejects(
    synthesizeSpeech({ cfg: { baseUrl: 'https://x/v1', model: 'm' }, text: 'hi', fetchFn: async () => new Response('bad key', { status: 401 }) }),
    /HTTP 401/
  );
  await assert.rejects(
    synthesizeSpeech({ cfg: { baseUrl: 'https://x/v1', model: 'm' }, text: 'hi', fetchFn: async () => new Response(Buffer.alloc(0), { status: 200 }) }),
    /空音频/
  );
  await assert.rejects(synthesizeSpeech({ cfg: { baseUrl: '' }, text: 'hi', fetchFn: fakeFetch }), /Base URL/);
  assert.equal(ttsConfigured({ tts: { enabled: false, baseUrl: 'https://x' } }), false);
  assert.equal(ttsConfigured({ tts: { enabled: true, baseUrl: 'https://x' } }), false,
    'openai 兼容缺 model 时注入也必然失败');
  assert.equal(ttsConfigured({ tts: { enabled: true, baseUrl: 'https://x', model: 'm' } }), true);
  assert.equal(ttsConfigured({ tts: { enabled: true, provider: 'mimo' } }), true);
});

test('GroupDigestManager：消息够时生成一条并发送；不够时跳过', async () => {
  const store = new ChatStore(0, { dataDir, filename: 'digest-test.sqlite' });
  const now = Date.now();
  const appended = [];
  for (let i = 0; i < 8; i += 1) {
    // recordOnly=true → 直接落 acked（recent({readOnly:true}) 只读已确认历史）
    const saved = store.appendIncoming('group:123', {
      mid: 500 + i,
      ts: now - (8 - i) * 60000,
      senderId: 'u' + (i % 3),
      senderName: '群友' + (i % 3),
      text: '第' + i + '条消息，聊聊加班和外卖'
    }, { recordOnly: true });
    appended.push(saved.state);
  }
  assert.ok(appended.every((s) => s === 'acked'), 'appendIncoming(recordOnly) 应落 acked，实际：' + appended.join(','));
  const rows = store.recent('group:123', { limit: 400, includeSelf: true, readOnly: true });
  assert.equal(rows.length, 8, '已确认消息应能被日报读取');

  // 群日报现在会在**读消息与调模型之前**过门禁（观察模式 / 白名单外的群不花钱，
  // 2026-10-03 全量审查）→ 这条用例必须把配置摆成真实放行的样子，不能靠默认值恰好通过
  // ⚠️ 必须动态 import：静态 import 会被 ESM 提前求值，那时 QQ_AGENT_DATA_DIR 还没设 →
  // config 模块按默认数据目录加载，上面那份临时 config.json 根本不生效（本文件里其它 src 模块都是动态 import）
  const { getConfig, setRuntimeConfig } = await import('../src/core/config.js');
  const base = getConfig();
  setRuntimeConfig({
    ...base,
    allow: { ...(base.allow || {}), groups: ['123'] },
    deny: { ...(base.deny || {}), groups: [] }
  });
  const sent = [];
  const sender = { sendTextBatch: async (chatKey, msgs) => { sent.push({ chatKey, msgs }); return { message_id: 1 }; } };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: '昨晚你们仨从加班聊到外卖，还顺便骂了两句天气。' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
  });
  try {
    const mgr = new GroupDigestManager({ store, sender, log: () => {} });
    const r = await mgr.runOnce();
    assert.equal(r.ok, true);
    assert.equal(r.results[0].ok, true, JSON.stringify(r.results[0]));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatKey, 'group:123');
    assert.match(sent[0].msgs[0], /加班/);

    // 消息太少 → 跳过
    const store2 = new ChatStore(0, { dataDir, filename: 'digest-empty.sqlite' });
    store2.appendIncoming('group:123', { mid: 1, ts: now, senderId: 'u1', senderName: '甲', text: '在吗' }, { recordOnly: true });
    const mgr2 = new GroupDigestManager({ store: store2, sender, log: () => {} });
    const r2 = await mgr2.runOnce();
    assert.equal(r2.results[0].ok, false);
    assert.match(r2.results[0].error, /消息太少/);
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('GroupDigestManager：日报材料用备注/代号，不再喊群名片（2026-10-11 反馈）', async () => {
  const store = new ChatStore(0, { dataDir, filename: 'digest-alias.sqlite' });
  const now = Date.now();
  for (let i = 0; i < 8; i += 1) {
    store.appendIncoming('group:123', {
      mid: 700 + i, ts: now - (8 - i) * 60000,
      senderId: 'u1', senderName: '张三本尊',
      text: '第' + i + '条，讨论周末去哪玩'
    }, { recordOnly: true });
  }
  const { getConfig, setRuntimeConfig } = await import('../src/core/config.js');
  const base = getConfig();
  setRuntimeConfig({
    ...base,
    allow: { ...(base.allow || {}), groups: ['123'] },
    memberNotes: { u1: '老玩童' }
  });
  let promptText = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, req) => {
    const body = JSON.parse(req.body);
    promptText = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    return Response.json({
      choices: [{ message: { content: '老玩童他们周末想出去玩。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    });
  };
  try {
    const sender = { sendTextBatch: async () => ({ message_id: 1 }) };
    const mgr = new GroupDigestManager({ store, sender, log: () => {} });
    const r = await mgr.runOnce();
    assert.equal(r.ok, true, JSON.stringify(r.results[0]));
    assert.ok(promptText.includes('老玩童'), '日报材料（参与活跃 + 样本行）要用备注/代号');
    assert.equal(promptText.includes('张三本尊'), false, '不能再喊群名片');
  } finally {
    globalThis.fetch = origFetch;
  }
});
