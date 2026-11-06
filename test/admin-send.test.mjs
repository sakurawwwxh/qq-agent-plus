import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createActionStore } from '../src/admin/actions.js';
import { createSendService } from '../src/admin/send.js';

const cfg = {
  admin: { ownerUin: '10001' },
  allow: { groups: ['433397830', '433397831'] },
  deny: { groups: [] }
};

function fixture(t, { uncertain = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-send-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const audits = [];
  const calls = [];
  const messages = new Map();
  const effects = new Map();
  let seq = 0;
  const store = {
    getChatMeta: () => ({ held: 0 }),
    listChats: () => ['group:433397830', 'group:433397831'],
    findByMid: (chatKey, mid) => messages.get(`${chatKey}:${String(mid).replace(/^#/, '')}`) || null,
    hasUncertainEffects: () => uncertain
  };
  const onebot = {
    selfId: '999',
    async call(action) {
      if (action === 'get_group_list') return [
        { group_id: 433397830, group_name: '测试群' },
        { group_id: 433397831, group_name: '另一个群' }
      ];
      throw new Error(`unexpected ${action}`);
    },
    async getMsg() {
      return {
        message: [
          { type: 'text', data: { text: '被转发的消息' } },
          { type: 'image', data: { url: 'https://example.com/card.png' } }
        ]
      };
    },
    async deleteMessage(mid) { calls.push(['delete', mid]); }
  };
  const sender = {
    async sendTextBatch(target, list) {
      calls.push(['text', target, list]);
      return { sent: [{ text: list[0], messageId: `m${++seq}` }], failed: [] };
    },
    async sendImage(target, image) {
      calls.push(['image', target, image.url]);
      return { message_id: `m${++seq}` };
    },
    async sendForwardCard(target, nodes) {
      calls.push(['forward', target, nodes.length]);
      return { message_id: `m${++seq}` };
    },
    async groupFile(target, file) {
      calls.push(['file', target, file.name]);
      return { message_id: `m${++seq}` };
    },
    async voice(target, voice) {
      calls.push(['voice', target, voice.file]);
      return { message_id: `m${++seq}` };
    },
    async aiVoice(target, voice) {
      calls.push(['aiVoice', target, voice.text]);
      return { message_id: `m${++seq}` };
    }
  };
  const ledger = {
    begin({ idemKey, detail = {} }) {
      if (!effects.has(idemKey)) effects.set(idemKey, { id: `eff${++seq}`, kind: 'admin-send', state: 'planned', detail });
      const row = effects.get(idemKey);
      return { id: row.id, action: row.state === 'sent' ? 'done' : 'proceed', state: row.state };
    },
    settle(id, state, detail) {
      for (const row of effects.values()) if (row.id === id) Object.assign(row, { state, detail: { ...row.detail, ...detail } });
      return true;
    },
    get(_kind, idemKey) { return effects.get(idemKey) || null; },
    getById(id) { return [...effects.values()].find((row) => row.id === id) || null; }
  };
  const actions = createActionStore({ dataDir: dir });
  const send = createSendService({
    store, sender, onebot, effects: ledger, actions, getConfig: () => cfg,
    audit: (entry) => audits.push(entry), targetGapMs: 0, sleep: async () => {}
  });
  return { dir, send, actions, calls, messages, audits, store, sender, effects };
}

test('文字发送：先计划再确认，逐目标 EffectLedger 结算并留审计', async (t) => {
  const { send, calls, audits } = fixture(t);
  const plan = await send.plan({
    actor: '10001', targetsInput: ['433397830'], itemsInput: [{ type: 'text', text: '今晚八点狼人杀' }]
  });
  assert.match(plan.preview, /测试群/);
  assert.match(plan.preview, new RegExp(`确认 ${plan.code}`));
  assert.match(plan.action.preview, /确认 <码>/, '预览必须落盘，待批里才能核对');
  assert.doesNotMatch(plan.action.preview, new RegExp(plan.code), '动作文件不能存明文确认码');
  const started = send.confirmByCode({ code: plan.code, actor: '10001' });
  const result = await started.promise;
  assert.equal(result.state, 'sent');
  assert.equal(result.action.state, 'sent');
  assert.deepEqual(calls[0], ['text', 'group:433397830', ['今晚八点狼人杀']]);
  const target = result.action.results['group:433397830'];
  assert.equal(target.state, 'sent');
  assert.equal(target.messageIds.length, 1);
  assert.ok(audits.some((entry) => entry.action === 'admin.send.plan'));
  assert.ok(audits.some((entry) => entry.action === 'admin.send.result' && entry.ok === true));
});

test('媒体：图片/文件/语音/AI 语音/聊天记录卡片都走发送队列', async (t) => {
  const { send, calls, messages } = fixture(t);
  messages.set('private:10001:77', { self: false, text: '原消息', senderName: '管理员', media: [] });
  const plan = await send.plan({
    actor: '10001',
    targetsInput: ['433397830'],
    itemsInput: [
      { type: 'image', url: 'https://example.com/a.png' },
      { type: 'file', url: 'https://example.com/a.txt', name: 'a.txt' },
      { type: 'voice', url: 'https://example.com/a.mp3', seconds: 3 },
      { type: 'aiVoice', text: '你好' },
      { type: 'forward', messageId: '#77' }
    ]
  });
  const result = await send.confirmByCode({ code: plan.code, actor: '10001' }).promise;
  assert.equal(result.state, 'sent');
  assert.deepEqual(calls.map((call) => call[0]), ['image', 'file', 'voice', 'aiVoice', 'forward']);
});

test('messageId 媒体：计划里只存来源，执行时重新取新鲜 URL', async (t) => {
  const { send, calls, messages } = fixture(t);
  messages.set('private:10001:88', {
    self: false, text: '', senderName: '管理员',
    media: [{ kind: 'image', url: 'https://example.com/old.png' }]
  });
  const plan = await send.plan({
    actor: '10001', targetsInput: ['433397830'],
    itemsInput: [{ type: 'image', messageId: '#88' }]
  });
  const stored = plan.action.items[0];
  assert.equal(stored.messageId, '88');
  assert.equal(stored.url, undefined, '计划文件不能固化签名 URL');
  const result = await send.confirmByCode({ code: plan.code, actor: '10001' }).promise;
  assert.equal(result.state, 'sent');
  assert.equal(calls.at(-1)[0], 'image');
  assert.equal(calls.at(-1)[2], 'https://example.com/card.png');
});

test('命令级确认：错码累计到上限会取消动作，不会无限爆破', async (t) => {
  const { send, actions } = fixture(t);
  const plan = await send.plan({
    actor: '10001', targetsInput: ['433397830'], itemsInput: [{ type: 'text', text: 'x' }]
  });
  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => send.confirmByCode({ code: '000000', actor: '10001' }), /确认码不正确/);
  }
  assert.throws(() => send.confirmByCode({ code: '000000', actor: '10001' }), /错误次数过多/);
  assert.equal(actions.get(plan.action.id).state, 'cancelled');
});

test('负消息 id：引用转发仍能解析（QQ message_id 可能为负）', async (t) => {
  const { send, messages } = fixture(t);
  messages.set('private:10001:-102', { self: false, text: '负数 id 的消息', senderName: '管理员', media: [] });
  const plan = await send.plan({
    actor: '10001', targetsInput: ['433397830'], itemsInput: [{ type: 'forward', messageId: '#-102' }]
  });
  assert.equal(plan.action.items[0].messageId, '-102');
});

test('部分发送：文字已送达、图片失败 → partial，EffectLedger 按 unknown 处理', async (t) => {
  const { send, sender } = fixture(t);
  sender.sendImage = async () => { throw new Error('image expired'); };
  const plan = await send.plan({
    actor: '10001', targetsInput: ['433397830'],
    itemsInput: [{ type: 'text', text: '先发文字' }, { type: 'image', url: 'https://example.com/a.png' }]
  });
  const result = await send.confirmByCode({ code: plan.code, actor: '10001' }).promise;
  assert.equal(result.state, 'partial');
  const target = result.action.results['group:433397830'];
  assert.equal(target.state, 'partial');
  assert.equal(target.messageIds.length, 1, '已送达的文字要保留 messageId，供撤回');
});

test('控制台核对 unknown 后回写管理员动作：目标变 sent、补 messageId、可撤回', async (t) => {
  const { send, actions, effects } = fixture(t, { uncertain: true });
  const plan = await send.plan({
    actor: '10001', targetsInput: ['433397830'], itemsInput: [{ type: 'text', text: '核对测试' }]
  });
  const result = await send.confirmByCode({ code: plan.code, actor: '10001' }).promise;
  assert.equal(result.state, 'unknown');
  const effect = [...effects.values()].find((row) => row.detail?.actionId === plan.action.id);
  assert.ok(effect);
  assert.equal(send.reconcileEffect({
    runId: effect.id, result: 'sent', messageId: 'm-reconciled', chatKey: 'group:433397830'
  }), true);
  const action = actions.get(plan.action.id);
  assert.equal(action.state, 'sent');
  assert.equal(action.results['group:433397830'].state, 'sent');
  assert.ok(action.results['group:433397830'].messageIds.includes('m-reconciled'));
});

test('发送失败且结果未知：动作与目标都标 unknown，不自动重试', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = {
    getChatMeta: () => ({ held: 0 }), listChats: () => ['group:433397830'],
    findByMid: () => null, hasUncertainEffects: () => true
  };
  const sender = { sendTextBatch: async () => { throw new Error('timeout'); } };
  const service = createSendService({
    store, sender, onebot: { selfId: '999', async call() { return [{ group_id: 433397830, group_name: '测试群' }]; } },
    effects: { begin: () => ({ id: 'e1', action: 'proceed' }), settle: () => true, get: () => null },
    actions: createActionStore({ dataDir: dir }),
    getConfig: () => cfg, targetGapMs: 0, sleep: async () => {}, audit: () => {}
  });
  const p = await service.plan({ actor: '10001', targetsInput: ['433397830'], itemsInput: [{ type: 'text', text: 'x' }] });
  const r = await service.confirmByCode({ code: p.code, actor: '10001' }).promise;
  assert.equal(r.state, 'unknown');
  assert.equal(r.action.results['group:433397830'].state, 'unknown');
});

test('撤回：只撤本地能证明是机器人自己的消息，别的会话/别人的消息跳过', async (t) => {
  const { send, calls, messages, actions } = fixture(t);
  const plan = await send.plan({
    actor: '10001', targetsInput: ['433397830'], itemsInput: [{ type: 'text', text: 'hi' }]
  });
  const result = await send.confirmByCode({ code: plan.code, actor: '10001' }).promise;
  const mid = result.action.results['group:433397830'].messageIds[0];
  messages.set(`group:433397830:${mid}`, { self: true, text: 'hi' });
  const recalled = await send.recall({ actionId: result.action.id, actor: '10001' });
  assert.equal(recalled.recalled.length, 1);
  assert.deepEqual(calls.at(-1), ['delete', Number(mid)]);
  assert.equal(actions.get(result.action.id).recall.recalled.length, 1);
});
