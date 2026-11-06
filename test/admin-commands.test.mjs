import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommandService } from '../src/admin/commands.js';

function fixture() {
  const calls = [];
  const send = {
    async plan(args) {
      calls.push(['plan', args]);
      return { preview: 'PREVIEW', action: { id: 'ad_1' }, code: '123456' };
    },
    findByCode(code, actor) {
      calls.push(['find', code, actor]);
      return code === '123456' ? { id: 'ad_1', targets: ['group:433397830'] } : null;
    },
    confirmByCode({ code, actor, onComplete }) {
      calls.push(['confirm', code, actor]);
      onComplete?.({ action: { id: 'ad_1', state: 'sent', results: {} } });
      return { action: { id: 'ad_1', targets: ['group:433397830'] } };
    },
    cancelByCode(code, actor) {
      calls.push(['cancel', code, actor]);
      return { id: 'ad_1' };
    },
    cancelById(actionId, actor) {
      calls.push(['cancelById', actionId, actor]);
      return { id: actionId };
    },
    async recall(args) {
      calls.push(['recall', args]);
      return { action: { id: 'ad_1' }, recalled: [], skipped: [], errors: [] };
    }
  };
  const inbox = {
    formatList: () => 'INBOX',
    async decide(args) { calls.push(['inbox', args]); return { reply: 'DECIDED' }; }
  };
  const status = {
    format: () => 'STATUS',
    async health() { calls.push(['health']); return 'HEALTH'; },
    unknown: () => 'UNKNOWN',
    failed: () => 'FAILED'
  };
  const replies = [];
  const service = createCommandService({
    send, inbox, status, actions: {}, getConfig: () => ({ admin: { ownerUin: '10001' } }),
    reply: async (text) => replies.push(text), log: () => {}
  });
  return { service, calls, replies };
}

function event(text, extra = {}) {
  return {
    post_type: 'message', message_type: 'private', user_id: '10001', raw_message: text,
    message: [{ type: 'text', data: { text } }], ...extra
  };
}

test('只处理管理员私聊的真实消息，群聊/别人/回显一律放行给原流程', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.handle(event('状态', { message_type: 'group' })), { handled: false });
  assert.deepEqual(await service.handle(event('状态', { user_id: '20002' })), { handled: false });
  assert.deepEqual(await service.handle(event('状态', { post_type: 'message_sent' })), { handled: false });
  assert.deepEqual(await service.handle(event('今天吃什么')), { handled: false });
});

test('发到群 → 预览；确认 → 后台发送；撤回 → 结果', async () => {
  const { service, calls } = fixture();
  const planned = await service.handle(event('发到群 433397830 今晚八点狼人杀'));
  assert.equal(planned.handled, true);
  assert.equal(planned.reply, 'PREVIEW');
  assert.equal(calls[0][0], 'plan');
  assert.equal(calls[0][1].targetsInput[0], '433397830');
  assert.equal(calls[0][1].itemsInput[0].text, '今晚八点狼人杀');

  const confirmed = await service.handle(event('确认 123456'));
  assert.match(confirmed.reply, /已受理/);
  assert.equal(calls.at(-1)[0], 'confirm');

  const recalled = await service.handle(event('撤回 刚才'));
  assert.match(recalled.reply, /撤回动作/);
  assert.equal(calls.at(-1)[0], 'recall');
  assert.equal(calls.at(-1)[1].latest, true);
});

test('转发到群读取引用消息；没有引用时给出可读提示', async () => {
  const { service, calls } = fixture();
  const noReply = await service.handle(event('转发到群 433397830'));
  assert.match(noReply.reply, /请先引用/);
  const withReply = await service.handle(event('转发到群 433397830', {
    message: [{ type: 'reply', data: { id: '77' } }, { type: 'text', data: { text: '转发到群 433397830' } }]
  }));
  assert.equal(withReply.reply, 'PREVIEW');
  assert.equal(calls.at(-1)[1].itemsInput[0].type, 'forward');
  assert.equal(calls.at(-1)[1].itemsInput[0].messageId, '77');
});

test('message_format=string：raw_message 带 CQ 引用时命令仍能命中', async () => {
  const { service, calls } = fixture();
  const result = await service.handle(event('[CQ:reply,id=-102]转发到群 433397830', {
    message: '[CQ:reply,id=-102]转发到群 433397830'
  }));
  assert.equal(result.reply, 'PREVIEW');
  assert.equal(calls.at(-1)[1].itemsInput[0].messageId, '-102');
});

test('审批/状态/健康命令；ap_ 编号仍交给插件原处理器', async () => {
  const { service, calls } = fixture();
  assert.equal((await service.handle(event('待批'))).reply, 'INBOX');
  assert.equal((await service.handle(event('同意 123456'))).reply, 'DECIDED');
  assert.equal((await service.handle(event('拒绝 123456 3'))).reply, 'DECIDED');
  assert.equal((await service.handle(event('状态'))).reply, 'STATUS');
  assert.equal((await service.handle(event('健康'))).reply, 'HEALTH');
  assert.equal((await service.handle(event('未知发送'))).reply, 'UNKNOWN');
  assert.equal((await service.handle(event('失败发送'))).reply, 'FAILED');
  assert.equal(calls.filter((call) => call[0] === 'inbox').length, 2);
  assert.deepEqual(await service.handle(event('同意 ap_abc')), { handled: false });
});
