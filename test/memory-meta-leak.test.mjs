// 人物印象元信息泄漏（插件仓库 issue #27，2026-11-01）：
// 整理 prompt 的【对象信息】被模型当印象抄回；修复为“元信息单独成段 + 写回前过滤 +
// 只返回元信息时放弃本轮（不能把原印象清空）”。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mem-meta-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { MemoryStore } = await import('../src/memory/memory.js');

function writeMember(userId, name, content) {
  const peopleDir = path.join(dir, 'memory', 'people');
  fs.mkdirSync(peopleDir, { recursive: true });
  fs.writeFileSync(path.join(peopleDir, `${userId}.json`), JSON.stringify({
    version: 2, userId, name, sourceChatKeys: ['group:1'], updatedAt: Date.now(),
    impressions: [{ content, createdAt: Date.now() - 1000, lastObservedAt: Date.now() - 1000, sourceChatKeys: ['group:1'] }]
  }), 'utf8');
}

function makeRunner() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api = { ...cfg.api, model: 'test', baseUrl: 'https://model.invalid/v1', apiKey: 'k' };
  cfg.sticker.enabled = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ store, onebot: {} });
  const memory = new MemoryStore();
  const runner = new Orchestrator({ store, sessions, sender, onebot: {}, stickers: {}, memory });
  return { runner, store, memory };
}

writeMember('123', '小明', '原有印象');
writeMember('456', '小红', '保留我');
const { runner, store, memory } = makeRunner();
store.appendIncoming('group:1', { mid: 1, text: '小明说话', senderId: '123', senderName: '小明' });
store.appendIncoming('group:1', { mid: 2, text: '小红说话', senderId: '456', senderName: '小红' });

const prompts = [];
globalThis.fetch = async (url, options = {}) => {
  const body = JSON.parse(String(options.body || '{}'));
  const user = String((body.messages || []).find((m) => m.role === 'user')?.content || '');
  prompts.push(user);
  const meta = [
    '群友 QQ：123', '当前名字：小明', '今天：2026-11-01（Asia/Shanghai）',
    '身份：这是机器人管理员本人（设置角色卡、管这台机器人的人）'
  ];
  const impressions = user.includes('群友 QQ：123')
    ? [...meta, '正常印象：爱聊游戏']
    : meta; // 456：模型只抄回元信息
  return Response.json({
    choices: [{ message: { content: JSON.stringify({ impressions }) } }],
    usage: { total_tokens: 10 }
  });
};

test('整理 prompt 把对象信息与印象条目分开；元信息不会被写回；只有元信息时保留原印象', async () => {
  // prompt 结构：对象信息在【需要整理的印象】之前；最近的发言只带本人消息
  await runner.consolidateMemoryForChat('group:1');
  const p123 = prompts.find((p) => p.includes('群友 QQ：123'));
  const p456 = prompts.find((p) => p.includes('群友 QQ：456'));
  assert.ok(p123 && p456, '两位成员都应被整理');
  for (const prompt of [p123, p456]) {
    assert.ok(prompt.includes('【对象信息】'));
    assert.ok(prompt.includes('【需要整理的印象】'));
    assert.ok(prompt.includes('【最近的发言】'));
    assert.ok(prompt.indexOf('【对象信息】') < prompt.indexOf('【需要整理的印象】'));
    assert.ok(prompt.indexOf('群友 QQ：') < prompt.indexOf('【需要整理的印象】'),
      '元信息必须放在印象段之前，不能和条目混在一起');
  }
  assert.ok(p123.includes('小明说话'), '整理 123 时要看到本人最近发言');
  assert.ok(!p123.includes('小红说话'), '不能把别人的发言混进 123 的样本');
  assert.ok(p456.includes('小红说话'));

  const members = memory.members('group:1');
  const ming = members.find((m) => String(m.userId) === '123');
  const hong = members.find((m) => String(m.userId) === '456');
  assert.deepEqual(ming?.impressions.map((e) => e.content), ['正常印象：爱聊游戏'],
    '模型抄回的元信息必须被过滤，只保留正常印象');
  assert.deepEqual(hong?.impressions.map((e) => e.content), ['保留我'],
    '模型只返回元信息时放弃本轮，不能把原印象清空');
});
