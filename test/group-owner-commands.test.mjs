// 群内 owner 只读命令：默认关闭、只认 owner、不处理引用/转发里的伪命令。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroupCommandService } from '../src/admin/group-commands.js';

function makeService({ enabled = true, chats = [], owner = '900001', decision = null, game = null } = {}) {
  const sent = [];
  const stopped = [];
  const service = createGroupCommandService({
    getConfig: () => ({ admin: { ownerUin: owner, groupCommands: { enabled, chats } } }),
    getStatus: () => ({
      snapshot: () => ({
        cfg: { runtime: { mode: 'active', paused: false } },
        queues: { byState: { pending: 2, held: 1, deferred: 3 } },
        outbox: { byState: { sending: 0, unknown: 1 } },
        onebot: { connected: true }
      })
    }),
    getOrchestrator: () => ({ decisionFor: () => decision }),
    getGroupGame: () => ({
      games: new Map(game ? [['group:1', game]] : []),
      summaryFor: () => '【进行中的游戏】谁是卧底：投票中',
      stop: async (chatKey) => { stopped.push(chatKey); return { ok: true }; }
    }),
    send: async (chatKey, text) => { sent.push({ chatKey, text }); },
    log: () => {}
  });
  return { service, sent, stopped };
}

const msg = (text, senderId = '900001') => ({ senderId, text, self: false });

test('只认 owner，且群命令总开关/群白名单必须打开', async () => {
  const { service, sent } = makeService({ enabled: false });
  assert.equal(await service.handleGroupMessage({ chatKey: 'group:1', kind: 'group', stored: msg('状态') }), false);

  const on = makeService({ chats: ['2'] });
  assert.equal(await on.service.handleGroupMessage({ chatKey: 'group:1', kind: 'group', stored: msg('状态') }), false, '不在白名单');
  assert.equal(await on.service.handleGroupMessage({ chatKey: 'group:1', kind: 'group', stored: msg('状态', '42') }), false, '非 owner');
  assert.equal(await on.service.handleGroupMessage({ chatKey: 'group:1', kind: 'private', stored: msg('状态') }), false, '私聊不处理');
  assert.equal(sent.length, 0);
});

test('owner 群内状态/行为卡/最近决策/结束游戏都直接回复，不经过模型', async () => {
  const { service, sent, stopped } = makeService({
    decision: { outcome: 'skipped', reason: '随机未命中', tier: 2, percent: 60, pendingCount: 4, hits: { probability: true } },
    game: { gameId: 'undercover' }
  });
  for (const command of ['状态', '/状态', '@机器人 状态', '行为卡', '最近决策', '结束游戏']) {
    assert.equal(await service.handleGroupMessage({ chatKey: 'group:1', kind: 'group', stored: msg(command) }), true, command);
  }
  assert.equal(sent.length, 5, '结束游戏由引擎自己播报，不重复补一条确认');
  assert.match(sent[0].text, /pending 2/);
  assert.match(sent.find((item) => /本群机器人说明/.test(item.text)).text, /回复策略/);
  assert.match(sent.find((item) => /最近决策/.test(item.text)).text, /随机未命中/);
  assert.deepEqual(stopped, ['group:1']);
});

test('引用/转发里的命令不算 owner 自己输入；backlog 重放也不执行', async () => {
  const { service, sent } = makeService();
  assert.equal(await service.handleGroupMessage({
    chatKey: 'group:1', kind: 'group', stored: msg('[引用#1·42：状态] ？')
  }), false);
  assert.equal(await service.handleGroupMessage({
    chatKey: 'group:1', kind: 'group', stored: msg('状态'), backlog: true
  }), false);
  assert.equal(sent.length, 0);
});
