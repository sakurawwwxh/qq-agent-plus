// 人类化：反 AI 味纯函数 + 发送端首条延迟/取消。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-humanize-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue, leadDelayFor } = await import('../src/onebot/sender.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { findAiTells, humanizeText, memeDensityPrompt, normalizeMemeUseLevel } = await import('../src/llm/humanize.js');
const { buildToolDefs } = await import('../src/tools/tools.js');

function baseConfig() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  setRuntimeConfig(cfg);
  return cfg;
}

function senderFor(store, onSend = () => {}) {
  return new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({ shut_up_timestamp: 0 }),
      sendText: async () => { onSend(); return { message_id: 1 }; }
    }
  });
}

it('反 AI 味：识别自指/免责，并去掉客服连接词', () => {
  const severe = '作为一个AI语言模型，我无法感受天气。希望对你有帮助！';
  const tells = findAiTells(severe);
  assert.ok(tells.some((tell) => tell.severity === 'severe'));
  const out = humanizeText(severe);
  assert.equal(out.severe, true);
  assert.doesNotMatch(out.text, /作为一个\s*AI|语言模型|希望对你有帮助/i);

  const soft = humanizeText('首先，我不太想去。其次，外面在下雨。总之，改天吧。');
  assert.equal(soft.severe, false);
  assert.doesNotMatch(soft.text, /首先|其次|总之/);
  assert.match(soft.text, /我不太想去/);

  // grounded（自然可靠）档保留结构词，只处理真正的自指/免责
  const grounded = humanizeText('首先，我不太想去。其次，外面在下雨。', { soft: false });
  assert.match(grounded.text, /首先/);
  assert.match(grounded.text, /其次/);
});

it('反 AI 味：正常口语不误伤', () => {
  const samples = ['刚吃完饭，懒得动。', '这也太离谱了吧', '你先睡，我再打一把', '留了  两个空格和\t制表符'];
  for (const text of samples) {
    const out = humanizeText(text);
    assert.equal(out.changed, false, text);
    assert.equal(out.text, text);
  }
  assert.equal(findAiTells('作为一个AI产品经理，我觉得这个方案可行。').length, 0,
    '“AI 产品经理”是职业，不是 AI 自指');
  assert.equal(findAiTells('我是AI换脸的，不是真人。').length, 0);
});

it('默认关闭：升级后发送节奏不变', () => {
  assert.equal(DEFAULT_CONFIG.humanize.enabled, false);
});

it('开启后首条按配置等待；关闭后回退普通节奏', async () => {
  const cfg = baseConfig();
  cfg.humanize = {
    ...cfg.humanize,
    enabled: true,
    replyDelay: { enabled: true, minMs: 120, maxMs: 120, perCharMs: 0, capMs: 120 }
  };
  setRuntimeConfig(cfg);
  // 纯函数断言首条延迟本身；不拿墙钟卡“关闭后 <100ms”——
  // 慢机器上一次普通调度就可能 158ms，原断言会把与人类化无关的调度延迟当成回归。
  assert.equal(leadDelayFor(cfg.humanize, ['hi']), 120);
  const store = new ChatStore(0, { dataDir: dir });
  const sender = senderFor(store);
  const started = Date.now();
  await sender.sendTextBatch('group:1', ['hi']);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 100, `应至少等待约 120ms，实际 ${elapsed}ms`);

  cfg.humanize = { ...cfg.humanize, enabled: false };
  setRuntimeConfig(cfg);
  assert.equal(leadDelayFor(cfg.humanize, ['hi']), null, '关闭后不能再加人类化首条延迟');
  // 仍然真发一次，确认关闭后链路可用（不判断墙钟上限）
  await sender.sendTextBatch('group:1', ['hi']);
  store.close();
});

it('等待期间中止：立刻取消，且不会发出消息', async () => {
  const cfg = baseConfig();
  cfg.humanize = {
    ...cfg.humanize,
    enabled: true,
    replyDelay: { enabled: true, minMs: 800, maxMs: 800, perCharMs: 0, capMs: 800 }
  };
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  let sends = 0;
  const sender = senderFor(store, () => { sends += 1; });
  const controller = new AbortController();
  const pending = sender.sendTextBatch('group:1', ['hi'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error) => error?.name === 'AbortError' || /abort/i.test(String(error?.message)));
  assert.equal(sends, 0, '中止后不能补发');
  store.close();
});

it('send_message：严重自指只拦一次，第二次用清洗后的正文发出', async () => {
  const cfg = baseConfig();
  cfg.humanize = { ...cfg.humanize, enabled: true, antiAi: { enabled: true, blockSevere: true } };
  setRuntimeConfig(cfg);
  const sends = [];
  const session = { id: 's1', leaseId: 'l1', sent: [] };
  const ctx = {
    kind: 'group',
    chatId: '1',
    chatKey: 'group:1',
    session,
    sender: {
      sendTextBatch: async (_key, messages) => {
        sends.push(messages);
        return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] };
      }
    },
    onebot: { selfId: '100' },
    emit: () => {}
  };
  const tool = buildToolDefs().find((entry) => entry.name === 'send_message');
  const first = await tool.execute(ctx, { messages: '作为一个AI语言模型，今天天气不错。' });
  assert.equal(first.isError, true);
  assert.equal(first.reportIncident, false, '预期内的重写提示不该进异常面板');
  assert.equal(sends.length, 0, '拦截时不能已经把消息发出去');
  assert.equal(session.humanizeWarned, true);

  const second = await tool.execute(ctx, { messages: '作为一个AI语言模型，今天天气不错。' });
  assert.ok(!second.isError);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], '今天天气不错。');
});

it('动作策略：单轮动作次数上限同样生效', async () => {
  const cfg = baseConfig();
  cfg.humanize = {
    ...cfg.humanize,
    enabled: true,
    actions: { enabled: true, maxPerRun: 1, pokeCooldownMs: 0 }
  };
  setRuntimeConfig(cfg);
  const makeCtx = () => ({
    kind: 'group', chatId: '1', chatKey: 'group:1',
    session: { id: 's5', leaseId: 'l5', sent: [] },
    actionMemory: new Map(),
    sender: { poke: async () => ({}) },
    store: { hasParticipant: () => true, findByMid: () => null },
    onebot: { selfId: '100' }, emit: () => {}
  });
  const tool = buildToolDefs().find((entry) => entry.name === 'send_poke');
  const ctx = makeCtx();
  assert.ok(!(await tool.execute(ctx, { targetUserId: '42' })).isError);
  const second = await tool.execute(ctx, { targetUserId: '42' });
  assert.equal(second.isError, true);
  assert.match(second.content, /上限/);
});

it('grounded 档保留“首先/其次”这类结构词', async () => {
  const cfg = baseConfig();
  cfg.humanize = { ...cfg.humanize, enabled: true, antiAi: { enabled: true, blockSevere: true } };
  setRuntimeConfig(cfg);
  const sends = [];
  const ctx = {
    kind: 'group', chatId: '1', chatKey: 'group:1', behaviorProfile: 'grounded',
    session: { id: 's6', leaseId: 'l6', sent: [] },
    sender: { sendTextBatch: async (_key, messages) => { sends.push(messages); return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] }; } },
    onebot: { selfId: '100' }, emit: () => {}
  };
  const tool = buildToolDefs().find((entry) => entry.name === 'send_message');
  const result = await tool.execute(ctx, { messages: '首先，我不太想去。其次，外面在下雨。' });
  assert.ok(!result.isError);
  assert.match(sends[0][0], /首先/);
  assert.match(sends[0][0], /其次/);
});

it('角色卡优先时不改卡的语气：严重自指也照原样发出', async () => {  const cfg = baseConfig();
  cfg.humanize = {
    ...cfg.humanize,
    enabled: true,
    respectPersonaCard: true,
    antiAi: { enabled: true, blockSevere: true }
  };
  setRuntimeConfig(cfg);
  const sends = [];
  const session = { id: 's2', leaseId: 'l2', sent: [] };
  const ctx = {
    kind: 'group',
    chatId: '1',
    chatKey: 'group:1',
    behaviorProfile: 'card',
    session,
    sender: {
      sendTextBatch: async (_key, messages) => {
        sends.push(messages);
        return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] };
      }
    },
    onebot: { selfId: '100' },
    emit: () => {}
  };
  const tool = buildToolDefs().find((entry) => entry.name === 'send_message');
  const result = await tool.execute(ctx, { messages: '作为一个AI语言模型，今天天气不错。' });
  assert.ok(!result.isError);
  assert.equal(sends.length, 1);
  assert.match(sends[0][0], /作为一个AI语言模型/, '卡优先时平台不应删改角色卡的措辞');
});

it('动作策略：同一种动作冷却跨运行生效，第二次会被拦下', async () => {
  const cfg = baseConfig();
  cfg.humanize = {
    ...cfg.humanize,
    enabled: true,
    actions: {
      enabled: true,
      maxPerRun: 4,
      pokeCooldownMs: 60000,
      stickerCooldownMs: 60000,
      voiceCooldownMs: 60000,
      reactCooldownMs: 60000
    }
  };
  setRuntimeConfig(cfg);
  let pokes = 0;
  const actionMemory = new Map();
  const makeCtx = (session) => ({
    kind: 'group',
    chatId: '1',
    chatKey: 'group:1',
    session,
    actionMemory,
    sender: { poke: async () => { pokes += 1; return {}; } },
    store: { hasParticipant: () => true, findByMid: () => null },
    onebot: { selfId: '100' },
    emit: () => {}
  });
  const tool = buildToolDefs().find((entry) => entry.name === 'send_poke');
  const first = await tool.execute(makeCtx({ id: 's3', leaseId: 'l3', sent: [] }), { targetUserId: '42' });
  assert.ok(!first.isError);
  const second = await tool.execute(makeCtx({ id: 's4', leaseId: 'l4', sent: [] }), { targetUserId: '42' });
  assert.equal(second.isError, true);
  assert.match(second.content, /刚刚用过|冷却/);
  assert.equal(pokes, 1, '冷却要跨运行生效，第二次不能再拍');
});

it('梗密度：四档各有明确口径；关闭拟人化时不注入；坏值回落 normal', () => {
  const at = (level, enabled = true) => memeDensityPrompt({ humanize: { enabled, memeUse: { level } } });
  assert.match(at('off'), /不要主动用网络梗/);
  assert.match(at('light'), /不主动抛新梗/);
  assert.match(at('normal'), /话题贴合时可以主动用一次/);
  assert.match(at('heavy'), /可以更主动地带梗/);
  assert.equal(at('heavy', false), '', '拟人化总开关关闭时不注入梗密度');
  assert.equal(normalizeMemeUseLevel('weird'), 'normal');
  assert.equal(normalizeMemeUseLevel('HEAVY'), 'heavy');
});

it('气泡整形：按角色声音参数把一段长回复拆成多条', async () => {
  const cfg = baseConfig();
  cfg.humanize = {
    ...cfg.humanize,
    enabled: true,
    replyDelay: { enabled: true, minMs: 0, maxMs: 0, perCharMs: 0, capMs: 0 }
  };
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  const sent = [];
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({ shut_up_timestamp: 0 }),
      sendText: async (_kind, _id, text) => { sent.push(text); return { message_id: sent.length }; }
    }
  });
  await sender.sendTextBatch('group:1', ['今天天气不错，我们出去走走吧。'], {
    persona: true,
    voice: { maxChars: 12, maxBubbles: 3, pauseMs: [0, 0] }
  });
  assert.ok(sent.length >= 2, `应拆成多条，实际 ${JSON.stringify(sent)}`);
  assert.equal(sent.join(''), '今天天气不错，我们出去走走吧。');
  store.close();
});

it('气泡整形：代码块和链接不被拆坏', async () => {
  const cfg = baseConfig();
  cfg.humanize = {
    ...cfg.humanize,
    enabled: true,
    replyDelay: { enabled: true, minMs: 0, maxMs: 0, perCharMs: 0, capMs: 0 }
  };
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  const sent = [];
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({ shut_up_timestamp: 0 }),
      sendText: async (_kind, _id, text) => { sent.push(text); return { message_id: sent.length }; }
    }
  });
  await sender.sendTextBatch('group:1', [
    '看这个：```js\nconst url = "https://example.com/a/b";\nconsole.log(url);\n```\n链接是 https://example.com/x 自己试。'
  ], { persona: true, voice: { maxChars: 20, maxBubbles: 3, pauseMs: [0, 0] }, preserveCode: true });
  const all = sent.join('\n');
  assert.match(all, /https:\/\/example\.com\/a\/b/);
  assert.match(all, /https:\/\/example\.com\/x/);
  assert.ok(sent.every((text) => !text.includes('```')), '围栏应被去掉');
  store.close();
});


for (const persona of [false, true]) {
  for (const preserveCode of [false, true]) {
    it(`URL 原样发送到协议端（persona=${persona}, preserveCode=${preserveCode}）`, async (t) => {
      const cfg = baseConfig();
      cfg.humanize = {
        ...cfg.humanize,
        enabled: true,
        replyDelay: { enabled: true, minMs: 0, maxMs: 0, perCharMs: 0, capMs: 0 }
      };
      setRuntimeConfig(cfg);
      const store = new ChatStore(0, { dataDir: dir });
      t.after(() => store.close());
      const sent = [];
      const messageId = 700 + Number(persona) * 10 + Number(preserveCode);
      const sender = new SendQueue({
        store,
        onebot: {
          selfId: '100',
          getGroupMemberInfo: async () => ({ shut_up_timestamp: 0 }),
          sendText: async (_kind, _id, text) => { sent.push(text); return { message_id: messageId }; }
        }
      });
      const url = 'https://example.org/package/__init__.py?filter=*a*&name=~~draft~~';
      const result = await sender.sendTextBatch('group:1', [`**下载** [源码](${url})`], {
        persona, preserveCode, voice: { maxChars: 12, maxBubbles: 3, pauseMs: [0, 0] }
      });
      assert.deepEqual(result.failed, []);
      assert.deepEqual(sent, [`下载 源码 (${url})`]);
      assert.equal(result.sent[0].text, sent[0]);
      assert.equal(store.findByMid('group:1', result.sent[0].messageId).text, sent[0]);
    });
  }
}

it('气泡整形只作用于人格回复：系统文本（日报/游戏/插件代发）不拆条', async () => {
  const cfg = baseConfig();
  cfg.humanize = {
    ...cfg.humanize,
    enabled: true,
    replyDelay: { enabled: true, minMs: 0, maxMs: 0, perCharMs: 0, capMs: 0 }
  };
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  const sent = [];
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({ shut_up_timestamp: 0 }),
      sendText: async (_kind, _id, text) => { sent.push(text); return { message_id: sent.length }; }
    }
  });
  // 不带 persona 的调用方（group-digest / group-game / 插件 send.text 都是这样调的）：
  // 长报告必须原样一条发出，按卡的每条字数硬拆只会把报表拆烂
  const first = `今日日报\n第一段。\n第二段。\n第三段。`;
  const second = '总结：一切正常。';
  await sender.sendTextBatch('group:1', [first, second], {});
  assert.equal(sent.length, 2, '系统文本不按气泡上限拆条');
  assert.equal(sent[0], first);
  store.close();
});
