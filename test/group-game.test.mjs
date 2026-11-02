// 群游戏状态机测试（框架 + 数字炸弹 + 谁是卧底）：真 ChatStore、假发送器、可控时钟与随机数。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-games-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active', paused: false },
  allow: { private: ['100000001'] },
  api: { baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'mock', thinking: 'on' },
  groupGame: {
    enabled: true, chats: ['group:1'], allowPrivateInvite: true, maxDurationMin: 60, dailyLimitPerChat: 6,
    recruitSeconds: 0, games: ['number-bomb', 'undercover', 'werewolf']
  }
}));

const { GroupGameManager } = await import('../src/features/group-game.js');
const { ChatStore } = await import('../src/core/store.js');
const { updateConfig } = await import('../src/core/config.js');

function makeWorld({ rng = () => 0.42, limit = 6, players = 4, privateDm = false } = {}) {
  // 每个"世界"从零开始：games.json 是共享文件，不清会跨用例污染（上一局的局与每日计数都会带过来）
  fs.rmSync(path.join(dataDir, 'games.json'), { force: true });
  updateConfig({
    groupGame: {
      enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: privateDm,
      dailyLimitPerChat: limit, maxDurationMin: 60,
      recruitSeconds: 0, games: ['number-bomb', 'undercover', 'werewolf'], maxPlayers: 10, discussSeconds: 0
    }
  });
  const store = new ChatStore(0, { dataDir, filename: `games-${Math.random().toString(36).slice(2)}.sqlite` });
  // 活跃成员（activeMembers 取的是 self=0 的最近发言者）
  for (let i = 1; i <= players; i += 1) {
    store.appendIncoming('group:1', {
      mid: 100 + i, ts: Date.now() - i * 1000, senderId: `u${i}`, senderName: `群友${i}`, text: '在'
    }, { recordOnly: true });
  }
  const sent = [];
  // 记录 options：私聊豁免（gameScoped）这类标记只能从这里断言
  const sender = { sendTextBatch: async (chatKey, msgs, options = {}) => { sent.push({ chatKey, msgs: [...msgs], options }); return { message_id: sent.length }; } };
  let clock = Date.now();
  const mgr = new GroupGameManager({ store, sender, log: () => {}, now: () => clock, rng });
  return { store, sent, mgr, setClock: (v) => { clock = v; }, getClock: () => clock };
}

const say = (store, uid, name, text) => store.appendIncoming('group:1', {
  mid: 5000 + Math.floor(Math.random() * 100000), ts: Date.now(), senderId: uid, senderName: name, text
}, { recordOnly: true });

test('数字炸弹：区间收窄、越界提示、踩中即结束（rng 固定 → 炸弹 43）', async () => {
  const { store, sent, mgr } = makeWorld({ rng: () => 0.42 });
  const r = await mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  assert.equal(r.ok, true);
  assert.match(sent[0].msgs[0], /数字炸弹开局/);

  say(store, 'u1', '群友1', '我 12 点要开会，先撤了');
  await mgr.handleNewMessages('group:1');
  assert.equal(sent.length, 1, '聊天里带数字不算猜测（不误收窄、不刷屏）');

  say(store, 'u1', '群友1', '我猜 10');
  await mgr.handleNewMessages('group:1');
  assert.equal(sent.length, 1, '区间内的猜测不刷屏');

  say(store, 'u2', '群友2', '猜 200');
  await mgr.handleNewMessages('group:1');
  assert.match(sent.at(-1).msgs[0], /不在这段里/);

  say(store, 'u3', '群友3', '猜 43！');
  await mgr.handleNewMessages('group:1');
  assert.match(sent.at(-1).msgs[0], /踩中炸弹 43/);
  assert.equal(mgr.games.has('group:1'), false, '结束后清空');
});

test('谁是卧底：开局私聊发词 → 依次发言 → 投票淘汰 → 平民获胜', async () => {
  // rng 第 1 次选词组、第 2 次定卧底位置
  const seq = [0, 0.6];
  const { store, sent, mgr } = makeWorld({ rng: () => seq.shift() ?? 0 });
  const r = await mgr.start({ chatKey: 'group:1', gameId: 'undercover' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const privates = sent.filter((x) => x.chatKey.startsWith('private:'));
  assert.equal(privates.length, 4, '四人各发一条私聊词');
  assert.ok(privates.every((x) => /你的词是/.test(x.msgs[0])));
  const words = privates.map((x) => /「(.+?)」/.exec(x.msgs[0])[1]);
  assert.equal(new Set(words).size, 2, '只有两种词（平民词 + 卧底词）');
  // 卧底是第 3 个（floor(0.6*4)=2 → u3）
  const spyWord = words[2];
  assert.equal(words.filter((w) => w === spyWord).length, 1, '卧底词只有一个人拿到');

  // 依次发言（顺序 = activeMembers 的 lastTs 倒序 → u1,u2,u3,u4？以 state.order 为准）
  const order = mgr.games.get('group:1').state.order;
  for (const uid of order) say(store, uid, `群友${uid.slice(1)}`, '这是一种日常用品');
  await mgr.handleNewMessages('group:1');
  assert.equal(mgr.games.get('group:1').state.phase, 'vote');
  assert.match(sent.at(-1).msgs[0], /开始投票/);

  // 全员投 u3（卧底）→ 平民获胜；u3 自己不能投自己（插件会挡），改投 1
  for (const uid of order) say(store, uid, `群友${uid.slice(1)}`, uid === 'u3' ? '投 1' : '投 3');
  await mgr.handleNewMessages('group:1');
  const endMsg = sent.at(-1).msgs[0];
  assert.match(endMsg, /平民获胜/);
  assert.match(endMsg, /卧底是/);
  assert.equal(mgr.games.has('group:1'), false);
});

test('超时推进：没人描述 → 到点直接进投票（不点名、不刷"跳过"）；时长上限到点自动结束', async () => {
  const { sent, mgr, setClock, getClock } = makeWorld({ rng: () => 0 });
  await mgr.start({ chatKey: 'group:1', gameId: 'undercover' });
  setClock(getClock() + 200 * 1000);          // 超过 roundSeconds=150
  await mgr.tick();
  assert.equal(mgr.games.get('group:1')?.state.phase, 'vote', '描述阶段到点直接进投票');
  assert.match(sent.at(-1).msgs[0], /时间到|开始投票/);

  // 拨到超过 maxDurationMin（60 分钟）→ 自动收尾
  const g = mgr.games.get('group:1');
  if (g) setClock(g.deadlineAt + 1000);
  await mgr.tick();
  const lastMsg = sent.at(-1);
  assert.ok(lastMsg, '收尾时要有一条群消息');
  assert.match(lastMsg.msgs[0], /时间到了|结束/);
  assert.equal(mgr.games.has('group:1'), false);
});

test('谁是卧底：第 2 轮没人描述也会到点进投票（轮次切换即计时，不卡在发言阶段）', async () => {
  // 回归 2026-09-29 审查 P1：nextRound 把 phaseStartedAt 置 0，onTick 里 `0 || now` 恒等 now，
  // 150 秒计时永远不开始 → 整局卡到 45 分钟上限
  const { store, sent, mgr, setClock } = makeWorld({ rng: () => 0.6 });
  await mgr.start({ chatKey: 'group:1', gameId: 'undercover' });
  let order = mgr.games.get('group:1').state.order;
  for (const uid of order) say(store, uid, `群友${uid.slice(1)}`, '日常用品');
  await mgr.handleNewMessages('group:1');
  // 全员投票淘汰 u1（卧底是 u3）→ 进第 2 轮（u1 不能投自己，改投 u2）
  for (const uid of order) say(store, uid, `群友${uid.slice(1)}`, uid === 'u1' ? '投 2' : '投 1');
  await mgr.handleNewMessages('group:1');
  const st2 = mgr.games.get('group:1').state;
  assert.equal(st2.round, 2);
  assert.equal(st2.phase, 'speak');
  assert.ok(st2.phaseStartedAt > 0, '第 2 轮的计时起点必须在轮次切换时就设置');
  // 没人描述 → 150 秒后直接进投票（真人群不按点名说话，不该出现"XX 没接上"）
  setClock(st2.phaseStartedAt + 200 * 1000);
  await mgr.tick();
  assert.equal(mgr.games.get('group:1').state.phase, 'vote');
  assert.match(sent.at(-1).msgs[0], /时间到|开始投票/);
});

test('谁是卧底：投票阶段一票都没有 → 超时直接进下一轮，不空转', async () => {
  const { store, sent, mgr, setClock, getClock } = makeWorld({ rng: () => 0.6 });
  await mgr.start({ chatKey: 'group:1', gameId: 'undercover' });
  const order = mgr.games.get('group:1').state.order;
  for (const uid of order) say(store, uid, `群友${uid.slice(1)}`, '这是一种日常用品');
  await mgr.handleNewMessages('group:1');
  assert.equal(mgr.games.get('group:1').state.phase, 'vote');
  setClock(getClock() + 200 * 1000);   // 投票超时（roundSeconds=150）且 0 票
  await mgr.tick();
  const st = mgr.games.get('group:1').state;
  assert.equal(st.phase, 'speak', '直接进下一轮发言');
  assert.equal(st.round, 2);
  assert.match(sent.at(-1).msgs[0], /没人投票|第 2 轮/);
});

test('门控与限额：私聊未开 → 拒绝卧底；白名单外不认；每日上限封顶', async () => {
  const { mgr } = makeWorld({ limit: 1 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: false, dailyLimitPerChat: 1, maxDurationMin: 60 } });
  const denied = await mgr.start({ chatKey: 'group:1', gameId: 'undercover' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /允许私聊发身份/);

  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, dailyLimitPerChat: 1, maxDurationMin: 60 } });
  const first = await mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  assert.equal(first.ok, true);
  await mgr.stop('group:1', '测试');
  const second = await mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  assert.equal(second.ok, false);
  assert.match(second.error, /已经开过/);

  const outside = await mgr.start({ chatKey: 'group:999', gameId: 'number-bomb' });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /白名单/);
});

test('重启恢复：进行中的局写盘后能在新实例里继续', async () => {
  const { store, mgr } = makeWorld({ rng: () => 0.1 });
  await mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'games.json'), 'utf8'));
  assert.ok(saved.games['group:1'], 'games.json 里有进行中的局');

  const sender = { sendTextBatch: async () => ({}) };
  const revived = new GroupGameManager({ store, sender, log: () => {}, now: () => Date.now(), rng: () => 0.1 });
  assert.equal(revived.games.has('group:1'), true, '新实例恢复该局');
  assert.equal(revived.summaryFor('group:1').includes('数字炸弹'), true);
});

test('狼人杀的私聊行动：入口接管（标记已读、发回执），非参与者不接管', async () => {
  const { store, sent, mgr } = makeWorld({ players: 6 });
  const r = await mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const state = mgr.games.get('group:1').state;
  const seer = state.roles.find((x) => x.role === 'seer');
  const villager = state.roles.find((x) => x.role === 'villager');
  const outsider = 'u99';
  sent.length = 0;

  // 预言家私聊查人 → 引擎接管：回执 + 查验结果，且这条私聊被标记已读（不再唤醒模型）
  const stored = store.appendIncoming(`private:${seer.userId}`, {
    mid: 'pm-1', ts: Date.now(), senderId: seer.userId, senderName: seer.name, text: '查 1', reply: null, media: []
  });
  const took = await mgr.consumePrivateAction(`private:${seer.userId}`, stored);
  assert.equal(took, true, '属于进行中的局 → 引擎接管');
  assert.equal(store.findByMid(`private:${seer.userId}`, 'pm-1').state, 'acked', '接管后要标记已读');
  assert.match(sent.at(-1).msgs[0], /查验结果/);
  assert.equal(sent.at(-1).chatKey, `private:${seer.userId}`);

  // 解析不了的私聊不接管（交回普通链路，玩家发了不至于没人理）
  const junk = store.appendIncoming(`private:${villager.userId}`, {
    mid: 'pm-2', ts: Date.now(), senderId: villager.userId, senderName: villager.name, text: '在吗晚上好', reply: null, media: []
  });
  const took2 = await mgr.consumePrivateAction(`private:${villager.userId}`, junk);
  assert.equal(took2, true, '平民夜里也会拿到一句"你没行动"的回执（属于游戏私聊）');

  // 不在局里的人：不接管
  const other = store.appendIncoming(`private:${outsider}`, {
    mid: 'pm-3', ts: Date.now(), senderId: outsider, senderName: '路人', text: '查 1', reply: null, media: []
  });
  assert.equal(await mgr.consumePrivateAction(`private:${outsider}`, other), false);

  // 水位：同一条不会被 tick 再喂一遍
  const before = sent.filter((x) => x.chatKey === `private:${seer.userId}`).length;
  await mgr.tick();
  // 按"这个会话发出的私聊总数"断言，别按文案筛：重放同一条动作产出的是"今晚已经查过"，
  // 按"查验结果"数的话水位回归也发现不了（2026-09-29 审查 P2）
  assert.equal(
    sent.filter((x) => x.chatKey === `private:${seer.userId}`).length,
    before,
    '同一条私聊不得被 tick 再喂一遍'
  );
  assert.equal(store.findByMid(`private:${seer.userId}`, 'pm-1').state, 'acked');
});

test('私聊豁免开关：关着不带标记、开着对在册玩家带 gameScoped（deny 语义在 access 层）', async () => {
  const off = makeWorld({ players: 6, privateDm: false });
  await off.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  const offPriv = off.sent.find((x) => x.chatKey.startsWith('private:'));
  assert.ok(offPriv, '开局要发身份私聊');
  assert.notEqual(offPriv.options?.gameScoped, true, '开关关着时不得带豁免标记');

  const on = makeWorld({ players: 6, privateDm: true });
  await on.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  const onPrivs = on.sent.filter((x) => x.chatKey.startsWith('private:'));
  assert.ok(onPrivs.length >= 6, '6 人各一条身份私聊');
  assert.ok(onPrivs.every((x) => x.options?.gameScoped === true), '开关开着且收件人在册 → 每条私聊都带豁免标记');
  // 引擎私聊必须在发送时就标明 game-secret（发送端才是首次写库者，见 test/game-secret-prompt.test.mjs）
  assert.ok(onPrivs.every((x) => x.options?.eventKind === 'game-secret'), '引擎私聊要带 game-secret 标记');
  const groupMsgs = on.sent.filter((x) => x.chatKey === 'group:1');
  assert.ok(groupMsgs.length > 0, '要有群消息才谈得上"不是 secret"');
  assert.ok(groupMsgs.every((x) => x.options?.eventKind !== 'game-secret'), '群里公开消息不是 secret');
});

test('群里的"各种人"（老游戏）：非参与者投票不计；退出有退路；数字炸弹谁都能猜', async () => {
  // 谁是卧底：没参加的人投"投 3"不计票
  const w1 = makeWorld({ rng: () => 0.6 });
  await w1.mgr.start({ chatKey: 'group:1', gameId: 'undercover' });
  const order1 = w1.mgr.games.get('group:1').state.order;
  for (const uid of order1) say(w1.store, uid, `群友${uid.slice(1)}`, '日常用品');
  await w1.mgr.handleNewMessages('group:1');
  w1.sent.length = 0;
  say(w1.store, 'u99', '围观群众', '投 1');       // 局外人投票
  await w1.mgr.handleNewMessages('group:1');
  assert.equal(Object.keys(w1.mgr.games.get('group:1').state.votes || {}).length, 0, '局外人的票不计');

  // 谁是卧底：局内人说"不玩了"→ 移出本局并播报（身份不公布）
  const quitter = order1[0];
  say(w1.store, quitter, `群友${quitter.slice(1)}`, '不玩了');
  await w1.mgr.handleNewMessages('group:1');
  const st = w1.mgr.games.get('group:1')?.state;
  assert.ok(!st || st.eliminated.includes(quitter), '退出的人要从本局移出');
  assert.ok(w1.sent.some((x) => /退出/.test(x.msgs[0])), '群里要播报退出');

  // 数字炸弹：围观者也能猜（公共游戏，刻意的）——踩中照样结算
  const w2 = makeWorld({ rng: () => 0.42 });   // 炸弹固定 43
  await w2.mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  w2.sent.length = 0;
  say(w2.store, 'u99', '围观群众', '猜 43！');
  await w2.mgr.handleNewMessages('group:1');
  assert.equal(w2.mgr.games.has('group:1'), false, '围观者猜中也要结算');
  assert.match(w2.sent.at(-1).msgs[0], /踩中炸弹 43/);
});

test('私聊静默消耗：插件认领但不回执的消息，同样标记已读、不唤醒模型', async () => {
  // 7 人局才有守卫（6 人局由女巫替掉守卫，2026-09-29）
  const { store, sent, mgr } = makeWorld({ players: 7 });
  await mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  const state = mgr.games.get('group:1').state;
  const guard = state.roles.find((r) => r.role === 'guard');
  const villager = state.roles.find((r) => r.role === 'villager');
  sent.length = 0;
  // 先正常提交一次（有回执）
  const first = store.appendIncoming(`private:${guard.userId}`, { mid: 's1', ts: Date.now(), senderId: guard.userId, senderName: guard.name, text: `守 ${state.roles.findIndex((r) => r.userId === villager.userId) + 1}`, reply: null, media: [] });
  assert.equal(await mgr.consumePrivateAction(`private:${guard.userId}`, first), true);
  sent.length = 0;
  // 同目标重复提交 → 插件静默消耗：接管（true）、标记已读、但一条消息都不发
  const again = store.appendIncoming(`private:${guard.userId}`, { mid: 's2', ts: Date.now(), senderId: guard.userId, senderName: guard.name, text: first.text, reply: null, media: [] });
  assert.equal(await mgr.consumePrivateAction(`private:${guard.userId}`, again), true, '静默也要算"接管"，否则会唤起模型');
  assert.equal(sent.length, 0, '静默消耗不发任何消息');
  assert.equal(store.findByMid(`private:${guard.userId}`, 's2').state, 'acked', '同样要标记已读');
});

test('白天讨论时长可配：discussSeconds 传进插件（0=插件默认），到点由插件推进', async () => {
  const { mgr } = makeWorld({ players: 6 });
  // 默认 0 → 插件用自己的默认（120 秒）
  await mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(mgr.games.get('group:1').state.discussSeconds, 120);
  mgr.games.delete('group:1');
  // 配置 300 → 插件照做
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, discussSeconds: 300, recruitSeconds: 0, games: ['number-bomb', 'undercover', 'werewolf'] } });
  await mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(mgr.games.get('group:1').state.discussSeconds, 300);
});

test('报名制：够人才发牌（报名阶段不发任何私聊）、到点人不够就取消、显式名单跳过报名', async () => {
  // 1) 开报名：只发公告，不发身份私聊
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 30, games: ['number-bomb', 'undercover', 'werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.text, /报名/);
  const st = w.mgr.games.get('group:1').state;
  assert.equal(st.phase, 'recruiting');
  assert.equal(w.sent.filter((x) => x.chatKey.startsWith('private:')).length, 0, '报名阶段一条私聊都不能发');
  assert.ok(w.sent.some((x) => /报名中/.test(x.msgs[0])), '要发报名公告');

  // 2) 报名者（发"我玩/报名"）：够 6 人才发牌
  const ids = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  for (const [i, uid] of ids.entries()) {
    say(w.store, uid, `群友${i + 1}`, i === 0 ? '我玩' : '报名');
    await w.mgr.tick();
    const cur = w.mgr.games.get('group:1')?.state;
    if (i < ids.length - 1) {
      assert.equal(cur.phase, 'recruiting', `还差 ${ids.length - 1 - i} 人，不能提前发牌`);
    }
  }
  const after = w.mgr.games.get('group:1').state;
  assert.notEqual(after.phase, 'recruiting', '够人就要发牌进局');
  assert.equal(after.roles.length, 6);
  assert.ok(w.sent.filter((x) => x.chatKey.startsWith('private:')).length >= 6, '发牌后才开始私聊发身份');

  // 3) 到点人不够 → 取消
  const w2 = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 20, games: ['number-bomb', 'undercover', 'werewolf'] } });
  await w2.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  say(w2.store, 'u1', '群友1', '我玩');
  await w2.mgr.tick();
  w2.setClock(w2.getClock() + 25 * 1000);
  await w2.mgr.tick();
  assert.equal(w2.mgr.games.has('group:1'), false, '人不够要取消并清状态');
  assert.ok(w2.sent.some((x) => /报名人数不够|这局先算了/.test(x.msgs[0])));

  // 4) 模型显式给名单 → 跳过报名，直接发牌（"就我们四个玩"）
  const w3 = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 30, games: ['number-bomb', 'undercover', 'werewolf'] } });
  const r3 = await w3.mgr.start({ chatKey: 'group:1', gameId: 'werewolf', players: ['群友1', '群友2', '群友3', '群友4', '群友5', '群友6'] });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(w3.mgr.games.get('group:1').state.phase, 'night', '显式名单直接开局');
});

test('审查回归：games 白名单、maxPlayers 生效、报名默认 45、否定式不入选、报名中移出白名单即取消', async () => {
  // ① games 白名单：没勾狼人杀 → 拒绝 start（以前 UI 勾选是死控件）
  const w1 = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['number-bomb', 'undercover'] } });
  const denied = await w1.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /控制台没被允许|没被允许/);

  // ② maxPlayers：控制台设 5 → 名单最多 5 人（用卧底：它的 state.roles 里能直接数名单；
  //     数字炸弹的 state 不保存名单，断言不了这件事，2026-09-29 审查 P2）
  const w2 = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['undercover'], maxPlayers: 5 } });
  const started2 = await w2.mgr.start({ chatKey: 'group:1', gameId: 'undercover' });
  assert.equal(started2.ok, true, JSON.stringify(started2));
  assert.equal(w2.mgr.games.get('group:1').state.roles.length, 5, 'maxPlayers 要真的截断名单（6 个活跃成员只发 5 张牌）');

  // ③ 报名默认值（键缺失 → 45）在 test/game-recruit-default.test.mjs 里单测（那边是干净配置）
  const w3 = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, dailyLimitPerChat: 6, games: ['number-bomb', 'undercover', 'werewolf'], recruitSeconds: 45 } });
  await w3.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(w3.mgr.games.get('group:1').state.phase, 'recruiting');

  // ④ 报名：常见说法都认（我玩/我也玩/我参加/我来/算我一个），否定式不认
  say(w3.store, 'u1', '群友1', '别带我，你们玩');
  say(w3.store, 'u2', '群友2', '我不参与');
  say(w3.store, 'u3', '群友3', '我玩');
  say(w3.store, 'u4', '群友4', '我也玩');
  say(w3.store, 'u5', '群友5', '我参加');
  say(w3.store, 'u6', '群友6', '我来');
  await w3.mgr.tick();
  const st = w3.mgr.games.get('group:1')?.state;
  // 够 6 人（u3,u4,u5,u6 + u1? 不）——u1/u2 被排除，只有 4 人 → 还在报名
  assert.ok(st && st.phase === 'recruiting', '人数不够应继续报名（u1/u2 不算）');
  const joiners = st.joiners.map((j) => j.userId).sort();
  assert.deepEqual(joiners, ['u3', 'u4', 'u5', 'u6'], '明确要玩的 4 人算报名：' + JSON.stringify(joiners));

  // ⑤ 报名中把群移出白名单 → 报名取消（不发身份私聊）
  updateConfig({ groupGame: { enabled: true, chats: [], allowPrivateInvite: true, dailyLimitPerChat: 6, games: ['number-bomb', 'undercover', 'werewolf'], recruitSeconds: 45 } });
  await w3.mgr.tick();
  assert.equal(w3.mgr.games.has('group:1'), false, '白名单外的报名要取消');
  assert.ok(w3.sent.some((x) => /报名取消/.test(x.msgs[0])));
  assert.equal(w3.sent.filter((x) => x.chatKey.startsWith('private:')).length, 0, '取消前也没发过私聊');
});

test('审查回归：新局不重放上一局的历史私聊（私聊水位在发牌时初始化）', async () => {
  const w = makeWorld({ players: 6 });
  // 上一局留下的历史私聊（含像行动的内容）
  w.store.appendIncoming('private:u1', { mid: 'old-1', ts: Date.now() - 60000, senderId: 'u1', senderName: '群友1', text: '刀 2', reply: null, media: [] }, { recordOnly: true });
  w.store.appendIncoming('private:u1', { mid: 'old-2', ts: Date.now() - 59000, senderId: 'u1', senderName: '群友1', text: '不玩了', reply: null, media: [] }, { recordOnly: true });
  await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  w.sent.length = 0;
  await w.mgr.tick();
  await w.mgr.tick();
  const acted = w.sent.filter((x) => x.chatKey === 'private:u1' && /已记下|退出|查验/.test(x.msgs[0]));
  assert.equal(acted.length, 0, '新局不能把上一局的历史私聊当成本局行动：' + JSON.stringify(acted.map((x) => x.msgs[0])));
  assert.equal(w.mgr.games.get('group:1').state.roles.length, 6, '也不该被历史"不玩了"踢出人');
});

test('人满/开局后还有人报名：给一句"来晚了"的提示（同一人只提一次）', async () => {
  // ① 报名阶段满员：maxPlayers=4（卧底 minPlayers=4）→ 第 5 个报名者收到"来晚了一步"
  const w1 = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, dailyLimitPerChat: 6, recruitSeconds: 30, games: ['undercover'], maxPlayers: 4 } });
  await w1.mgr.start({ chatKey: 'group:1', gameId: 'undercover' });
  for (const uid of ['u1', 'u2', 'u3', 'u4', 'u5']) say(w1.store, uid, `群友${uid.slice(1)}`, '我玩');
  await w1.mgr.tick();
  assert.ok(w1.sent.some((x) => /来晚了一步|报满/.test(x.msgs[0])), '满员后要有人被回绝：' + JSON.stringify(w1.sent.map((x) => x.msgs[0])));
  assert.ok(w1.sent.some((x) => /来晚/.test(x.msgs[0]) && /群友5/.test(x.msgs[0])), '要指名道姓说清是谁晚了');

  // ② 开局之后才来报：也提示一次，且不重复
  const w2 = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  await w2.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  w2.sent.length = 0;
  say(w2.store, 'u99', '路人甲', '我玩');   // 局外人（不在名单里）
  await w2.mgr.tick();
  assert.equal(w2.sent.filter((x) => /来晚/.test(x.msgs[0])).length, 1, '来晚了要提示一次');
  say(w2.store, 'u99', '路人甲', '我也来');
  await w2.mgr.tick();
  assert.equal(w2.sent.filter((x) => /来晚/.test(x.msgs[0])).length, 1, '同一人不重复提示');
  // 在册玩家说"我玩"不该被提示
  const inside = w2.mgr.games.get('group:1').state.roles[0].userId;
  say(w2.store, inside, '局内人', '我玩');
  await w2.mgr.tick();
  assert.equal(w2.sent.filter((x) => /来晚/.test(x.msgs[0])).length, 1, '在册玩家不该被当成迟到的');
});

test('报名扫描不因 deferred 行错过 45 秒窗口：占位正文里的报名仍然生效', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: {
    enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false,
    dailyLimitPerChat: 6, recruitSeconds: 30, games: ['werewolf'], maxPlayers: 10
  } });
  const started = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const game = w.mgr.games.get('group:1');
  assert.equal(game.state.phase, 'recruiting');
  const before = Number(game.lastSeenId) || 0;
  const deferred = w.store.appendIncoming('group:1', {
    mid: 'deferred-join', ts: Date.now(), senderId: 'u1', senderName: '群友1', text: '报名', media: []
  }, { deferred: true });

  await w.mgr.tick();
  assert.ok(w.mgr.games.get('group:1').state.joiners.some((j) => j.userId === 'u1'),
    '占位正文里的报名信号也要生效，不能等富化');
  assert.ok((Number(w.mgr.games.get('group:1').lastSeenId) || 0) > before);

  w.store.finalizeDeferred('group:1', deferred.id);
  await w.mgr.tick();
  assert.equal(w.mgr.games.get('group:1').state.joiners.filter((j) => j.userId === 'u1').length, 1,
    '放行后不应重复报名');
});

test('引用回复里的“猜 42”不能盖过玩家真正说的“猜 10”', async () => {
  const w = makeWorld({ players: 6, rng: () => 0.42 });
  const started = await w.mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(w.mgr.games.get('group:1').state.secret, 43);
  say(w.store, 'u1', '群友1', '[引用#9·我：猜 42]猜 10');
  await w.mgr.handleNewMessages('group:1');
  const state = w.mgr.games.get('group:1').state;
  assert.equal(state.low, 10, '必须按真实正文猜 10，而不是引用块里的 42');
  assert.equal(state.high, 101);
});

test('handleNewMessages 遇到 deferred 行先停住，放行后再计猜测', async () => {
  const w = makeWorld({ players: 6, rng: () => 0.42 });
  const started = await w.mgr.start({ chatKey: 'group:1', gameId: 'number-bomb' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const before = Number(w.mgr.games.get('group:1').lastSeenId) || 0;
  const deferred = w.store.appendIncoming('group:1', {
    mid: 'deferred-guess', ts: Date.now(), senderId: 'u1', senderName: '群友1', text: '猜 10', media: []
  }, { deferred: true });

  await w.mgr.handleNewMessages('group:1');
  assert.equal(w.mgr.games.get('group:1').state.low, 0, 'deferred 正文不能被当成猜测');
  assert.equal(Number(w.mgr.games.get('group:1').lastSeenId) || 0, before, '水位不能越过 deferred');

  w.store.finalizeDeferred('group:1', deferred.id);
  await w.mgr.handleNewMessages('group:1');
  assert.equal(w.mgr.games.get('group:1').state.low, 10, '放行后要补上这次猜测');
});

test('审查回归：报名消息还是 pending（模型那边在飞）也必须能报上名', async () => {
  // 以前报名扫描带 readOnly（== 只看 acked），同一群里正好有一次模型运行在飞时，
  // 这批「我玩」对引擎不可见 → 45 秒到点直接"人数不够"（2026-09-29 审查 P2）
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 30, games: ['werewolf'] } });
  await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  // 关键：不用 recordOnly → 落库是 pending（模拟"编排器还没跑完这一批"）
  for (let i = 1; i <= 6; i += 1) {
    w.store.appendIncoming('group:1', { mid: 700 + i, ts: Date.now(), senderId: `u${i}`, senderName: `群友${i}`, text: '我玩', reply: null, media: [] });
  }
  await w.mgr.tick();
  const st = w.mgr.games.get('group:1')?.state;
  assert.equal(st?.phase !== 'recruiting', true, '待处理的报名也要算数：' + JSON.stringify(st?.phase));
  assert.equal(st.roles.length, 6, '6 个人都要进名单');
});

test('审查回归：白天讨论/投票消息是 pending 时也要计票', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, discussSeconds: 0, games: ['werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  w.mgr.games.get('group:1').state;
  // 发牌即夜间，而夜里群里说什么都不参与判定 → 先把第 1 夜（全员 AFK）推过去
  w.setClock(w.getClock() + 95 * 1000);
  await w.mgr.tick();
  const st = w.mgr.games.get('group:1').state;
  assert.equal(st.phase, 'day', '超时结算后应进入白天：' + st.phase);
  const target = st.roles[0];
  for (const m of st.roles) {
    w.store.appendIncoming('group:1', { mid: `v-${m.userId}`, ts: Date.now(), senderId: m.userId, senderName: m.name, text: `投 ${st.roles.indexOf(target) + 1}`, reply: null, media: [] });
  }
  await w.mgr.tick();
  const votes = w.mgr.games.get('group:1')?.state?.votes || {};
  assert.ok(Object.keys(votes).length >= 5, '待处理状态的票也要记下来：' + JSON.stringify(votes));
});

test('tick 重入锁：慢发送 + 报名溢出时，两次 tick 不会双份发牌/双份播报', async () => {
  // 这条以前是假绿（只造了恰好 6 个报名者，第二个 tick 进去时早已发完牌）。
  // 要触发双份发牌，得让报名阶段有 await 点：12 个活跃成员、上限 9 → 有人溢出（要发"来晚了一步"）
  const w = makeWorld({ players: 12 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 30, games: ['werewolf'], maxPlayers: 9 } });
  await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  for (let i = 1; i <= 10; i += 1) {   // 10 人报名 → 9 张牌 + 1 个"来晚了"
    w.store.appendIncoming('group:1', { mid: 1000 + i, ts: Date.now(), senderId: `u${i}`, senderName: `群友${i}`, text: '我玩', reply: null, media: [] });
  }
  const inner = w.mgr.sender;
  w.mgr.sender = { sendTextBatch: async (chatKey, msgs, options) => { await new Promise((r) => setTimeout(r, 30)); return inner.sendTextBatch(chatKey, msgs, options); } };
  await Promise.all([w.mgr.tick(), w.mgr.tick()]);
  assert.equal(w.sent.filter((x) => /狼人杀开局/.test(x.msgs[0])).length, 1, '开局公告只能一条');
  assert.equal(
    w.sent.filter((x) => x.chatKey.startsWith('private:') && /你是\*\*/.test(x.msgs[0])).length,
    9,
    '身份私聊只能发一轮（9 张牌）'
  );
  assert.equal(w.sent.filter((x) => /来晚/.test(x.msgs[0])).length, 1, '"来晚了一步"只发一次');
});


test('局内玩家白天私聊：引擎必须交回模型（不接管），不然玩家日常私聊会被吞掉', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const st = w.mgr.games.get('group:1').state;
  const uid = st.roles[0].userId;
  // 夜里：非行动的话会被引擎接管（有回执）
  const nightRow = w.store.appendIncoming(`private:${uid}`, { mid: 'p-night', ts: Date.now(), senderId: uid, senderName: '群友', text: '嗯嗯聊点别的', reply: null, media: [] });
  assert.equal(await w.mgr.consumePrivateAction(`private:${uid}`, nightRow), true, '夜里闲聊也会被引擎回一句');
  // 白天：私聊照常聊天（引擎不碰）
  w.setClock(w.getClock() + 95 * 1000);
  await w.mgr.tick();
  assert.equal(w.mgr.games.get('group:1').state.phase, 'day', '过夜后进白天');
  const dayRow = w.store.appendIncoming(`private:${uid}`, { mid: 'p-day', ts: Date.now(), senderId: uid, senderName: '群友', text: '今天天气不错', reply: null, media: [] });
  assert.equal(await w.mgr.consumePrivateAction(`private:${uid}`, dayRow), false, '白天的私聊必须落回模型');
});

test('名单注入防护：模型给的名字/QQ 必须落在本群活跃成员里，编造的会被丢掉', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  // ① 混入一个不存在的 QQ 与一个不存在的名片 → 只剩 5 个合法人 → 人数不足直接拒绝
  // 模型给名单时用的是"QQ 号或群名片"（工具描述如此）——这里就按这个接口测
  const bad = await w.mgr.start({
    chatKey: 'group:1', gameId: 'werewolf',
    players: ['群友1', '群友2', '群友3', '群友4', '群友5', '88888888', '查无此人']
  });
  assert.equal(bad.ok, false, '只剩 5 个能对上，不该开局：' + JSON.stringify(bad));
  assert.match(bad.error, /名单里只有 5 个能用/, '报错要说清是名单对不上，别让模型以为群里没人：' + bad.error);
  assert.match(bad.error, /对不上的会被丢掉|截断/, '要点出为什么对不上：' + bad.error);
  // ② 够人时，编造的那些也不能混进名单
  const okStart = await w.mgr.start({
    chatKey: 'group:1', gameId: 'werewolf',
    players: ['群友1', '群友2', '群友3', '群友4', '群友5', '群友6', '88888888', '查无此人']
  });
  assert.equal(okStart.ok, true, JSON.stringify(okStart));
  const roster = w.mgr.games.get('group:1').state.roles.map((r) => r.userId);
  assert.equal(roster.length, 6, '名单里只留 6 个真实成员：' + JSON.stringify(roster));
  assert.equal(roster.includes('88888888'), false, '编造的 QQ 不得进名单');
  assert.equal(w.sent.some((x) => x.chatKey === 'private:88888888'), false, '更不能给编造的号发私聊');
});

test('私聊发不出去时的统计与文案：失败人数要报给群里（且不重试、不降级到群聊）', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  const inner = w.mgr.sender;
  let blocked = '';
  w.mgr.sender = {
    async sendTextBatch(chatKey, msgs, options) {
      if (chatKey.startsWith('private:') && !blocked) blocked = chatKey.split(':')[1];
      if (chatKey === `private:${blocked}`) throw new Error('Send blocked: 白名单');
      return inner.sendTextBatch(chatKey, msgs, options);
    }
  };
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(blocked, '测试要真的挡住一个人');
  assert.match(r.text, /没发出去|发不出去|没收到/, '要把失败人数说清楚：' + r.text);
  assert.equal(
    w.sent.some((x) => x.chatKey === 'group:1' && /你是\*\*/.test(x.msgs[0])),
    false,
    '身份绝不能降级发到群里'
  );
});

test('对抗性回归 F3：tick 里推进的阶段要立刻落盘（重启不能回滚成"又天亮一次"）', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  w.setClock(w.getClock() + 95 * 1000);
  await w.mgr.tick();                                   // 夜里超时 → 天亮（内存里 phase=day）
  assert.equal(w.mgr.games.get('group:1').state.phase, 'day');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'games.json'), 'utf8'));
  assert.equal(onDisk.games['group:1'].state.phase, 'day', 'tick 推进后的阶段必须已落盘：' + onDisk.games['group:1'].state.phase);
  // 模拟重启：新实例不该再喊一次"天亮了"
  const inner = w.mgr.sender;
  const sent2 = [];
  const mgr2 = new GroupGameManager({
    store: w.store,
    sender: { async sendTextBatch(k, msgs, options) { sent2.push({ k, t: msgs[0] }); return inner.sendTextBatch(k, msgs, options); } },
    log: () => {}, now: w.getClock, rng: () => 0
  });
  await mgr2.tick();
  assert.equal(sent2.some((x) => /天亮了/.test(x.t)), false, '重启后不得重播"天亮了"：' + JSON.stringify(sent2.map((x) => x.t)));
});

test('对抗性回归 F5：同一批私聊里局已结束，后面的退出不再执行（只能有一条终局播报）', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const st = w.mgr.games.get('group:1').state;
  const wolves = st.roles.filter((x) => x.role === 'wolf');
  const other = st.roles.find((x) => x.role !== 'wolf');
  for (const uid of [wolves[0].userId, wolves[1].userId, other.userId]) {
    w.store.appendIncoming(`private:${uid}`, { mid: `q-${uid}`, ts: Date.now(), senderId: uid, senderName: uid, text: '不玩了', reply: null, media: [] }, { recordOnly: true });
  }
  await w.mgr.tick();
  const ends = w.sent.filter((x) => x.chatKey === 'group:1' && /狼人杀结束：/.test(x.msgs[0]));
  assert.equal(ends.length, 1, '终局播报只能有一条（身份表打架就更糟）：' + ends.length);
});

test('对抗性回归 F6：一个人同时在两个群的两局里，一条私聊只被其中一局执行', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1', 'group:2'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  for (let i = 1; i <= 6; i += 1) {
    w.store.appendIncoming('group:2', { mid: 9000 + i, ts: Date.now() - i * 1000, senderId: `u${i}`, senderName: `群友${i}`, text: '在' }, { recordOnly: true });
  }
  const g1 = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  const g2 = await w.mgr.start({ chatKey: 'group:2', gameId: 'werewolf' });
  assert.equal(g1.ok, true, JSON.stringify(g1));
  assert.equal(g2.ok, true, JSON.stringify(g2));
  const uid = 'u1';
  w.sent.length = 0;
  w.store.appendIncoming(`private:${uid}`, { mid: 'cross-1', ts: Date.now(), senderId: uid, senderName: '群友1', text: '刀 2', reply: null, media: [] }, { recordOnly: true });
  await w.mgr.tick();
  const replies = w.sent.filter((x) => x.chatKey === `private:${uid}`);
  assert.equal(replies.length, 1, '一条私聊只能回一条（以前两局各吃一遍）：' + JSON.stringify(replies.map((x) => x.msgs[0])));
});

test('对抗性回归：出局者夜里私聊走带配额的"你已经出局了"（不是静默丢给模型）', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  const g = w.mgr.games.get('group:1');
  const dead = g.state.roles[0];
  dead.alive = false;                       // 让他出局（第 1 夜）
  w.sent.length = 0;
  let claimed = 0;
  for (let i = 0; i < 10; i += 1) {
    const row = w.store.appendIncoming('private:' + dead.userId, { mid: `dead-${i}`, ts: Date.now(), senderId: dead.userId, senderName: dead.name, text: `在吗 ${i}`, reply: null, media: [] });
    if (await w.mgr.consumePrivateAction(`private:${dead.userId}`, row)) claimed += 1;
  }
  assert.equal(claimed, 10, '这些消息都该被引擎接管（不落到模型）');
  const replies = w.sent.filter((x) => x.chatKey === `private:${dead.userId}`);
  assert.equal(replies.length, 4, '回执要夹在每人每夜 4 条：' + replies.length);
  assert.match(replies[0].msgs[0], /已经出局/, replies[0].msgs[0]);
});

test('对抗性回归：数字炸弹的越界提示每人每局只回一次（不能靠反复猜 0 刷群消息）', async () => {
  const bomb = await import('../src/features/games/number-bomb.js');
  let s = bomb.create({ rng: () => 0.42 });        // 炸弹 = 43
  let pubs = 0;
  for (let i = 0; i < 12; i += 1) {
    const out = bomb.onMessage(s, { userId: 'u1', name: '群友1', text: '猜 0' });
    pubs += out.effects.filter((e) => e.type === 'public').length;
    s = out.state;
  }
  assert.equal(pubs, 1, '同一个人反复越界只提醒一次：' + pubs);
  // 别人第一次越界照样有提醒（不是全局静音）
  const other = bomb.onMessage(s, { userId: 'u2', name: '群友2', text: '猜 0' });
  assert.equal(other.effects.filter((e) => e.type === 'public').length, 1, '换个人要提醒');
  // 正常收窄/命中不受影响
  const good = bomb.onMessage(other.state, { userId: 'u3', name: '群友3', text: '猜 43' });
  assert.equal(good.state.phase, 'ended', '踩中照常结束');
});

test('原子写：games.json 落盘不留 .tmp、内容可解析；文件损坏时按"没进行中的局"处理', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  w.setClock(w.getClock() + 95 * 1000);
  await w.mgr.tick();                        // 推进一次，确保落盘被调用
  const file = path.join(dataDir, 'games.json');
  assert.equal(fs.existsSync(`${file}.tmp`), false, '不能留下 .tmp');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.games['group:1'], '盘上要有进行中的局');
  assert.equal(parsed.games['group:1'].state.phase, 'day', '推进后的阶段要落盘');
  // 半截 JSON（模拟极端情况）：新实例按"首次运行"处理（现状如此，钉住以免无声改变）
  fs.writeFileSync(file, '{"games":{"group:1":{"gameId":"werewolf"');
  const { GroupGameManager: M } = await import('../src/features/group-game.js');
  const mgr2 = new M({ store: w.store, sender: { async sendTextBatch() { return { sent: [] }; } }, log: () => {}, now: w.getClock, rng: () => 0 });
  assert.equal(mgr2.games.size, 0, '损坏文件 → 丢掉进行中的局（现状）');
});

test('对抗性回归：owner 局结束后，另一局不能把旧私聊补吃一遍（水位要跨局推进）', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1', 'group:2'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  for (let i = 1; i <= 6; i += 1) {
    w.store.appendIncoming('group:2', { mid: 7000 + i, ts: Date.now() - i * 1000, senderId: `u${i}`, senderName: `群友${i}`, text: '在' }, { recordOnly: true });
  }
  const g1 = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  const g2 = await w.mgr.start({ chatKey: 'group:2', gameId: 'werewolf' });
  assert.equal(g1.ok && g2.ok, true, JSON.stringify([g1, g2]));
  w.sent.length = 0;
  w.store.appendIncoming('private:u1', { mid: 'old-1', ts: Date.now(), senderId: 'u1', senderName: '群友1', text: '刀 2', reply: null, media: [] }, { recordOnly: true });
  await w.mgr.tick();
  assert.equal(w.sent.filter((x) => x.chatKey === 'private:u1').length, 1, '只有归属局回执');
  // 归属局（后开的 group:2）结束 → 旧局不能把这条老消息再吃一遍
  await w.mgr.stop('group:2', '对抗性回归用例');
  w.sent.length = 0;
  await w.mgr.tick();
  assert.equal(
    w.sent.filter((x) => x.chatKey === 'private:u1').length,
    0,
    '补吃旧私聊了：' + JSON.stringify(w.sent.filter((x) => x.chatKey === 'private:u1').map((x) => x.msgs[0]))
  );
});

test('私聊侧的提示词摘要：归属局还在就有"进行中的游戏"，刚结束就空（不给模型上帝视角）', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  const uid = w.mgr.games.get('group:1').state.roles[0].userId;
  const live = w.mgr.summaryFor(`private:${uid}`);
  assert.match(live, /进行中的游戏/, live);
  assert.equal(/你是\*\*|查验结果|狼人(?!杀)/.test(live), false, '摘要不能泄露身份：' + live);
  w.mgr.games.get('group:1').state.phase = 'ended';
  assert.equal(w.mgr.summaryFor(`private:${uid}`), '', '刚结束的局不再给私聊提示');
});

test('对抗性回归：已结束（终局播报还在发）的局不再接管私聊、也不再播"退出了本局"', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  w.mgr.games.get('group:1').state.phase = 'ended';   // 模拟"已判胜、还没从 games 里删掉"的那几秒
  const row = w.store.appendIncoming('private:u1', { mid: 'end-1', ts: Date.now(), senderId: 'u1', senderName: '群友1', text: '我不玩了', reply: null, media: [] });
  assert.equal(await w.mgr.consumePrivateAction('private:u1', row), false, '已结束的局不该接管');
  w.sent.length = 0;
  await w.mgr.tick();
  assert.equal(w.sent.filter((x) => /退出了本局/.test(x.msgs[0])).length, 0, '不该再出现退出播报');
  assert.equal(w.sent.filter((x) => /结束：/.test(x.msgs[0])).length, 0, '也不该再补一条终局播报');
});

test('对抗性回归：私聊只归"最近开局、未结束"的那一局——它不认领就交给模型，绝不转给别的局', async () => {
  const build = async () => {
    const w = makeWorld({ players: 6 });
    updateConfig({ groupGame: { enabled: true, chats: ['group:1', 'group:2'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
    for (let i = 1; i <= 6; i += 1) {
      w.store.appendIncoming('group:2', { mid: 6000 + i, ts: Date.now() - i * 1000, senderId: `u${i}`, senderName: `群友${i}`, text: '在' }, { recordOnly: true });
    }
    await w.mgr.start({ chatKey: 'group:2', gameId: 'werewolf' });      // 先开（较旧）
    await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });      // 后开（归属）
    // startedAt 可能撞在同一毫秒 → 显式拉开，保证"最近开局"是 group:1（不然排序会退化成插入顺序）
    w.mgr.games.get('group:2').startedAt = Date.now() - 60_000;
    w.mgr.games.get('group:1').startedAt = Date.now();
    return w;
  };
  // ① 归属局在白天（白天私聊是聊天）→ 不执行，也**不转给**另一局
  {
    const w = await build();
    w.mgr.games.get('group:1').state.phase = 'day';
    w.sent.length = 0;
    const row = w.store.appendIncoming('private:u1', { mid: 'own-1', ts: Date.now(), senderId: 'u1', senderName: '群友1', text: '刀 2', reply: null, media: [] });
    assert.equal(await w.mgr.consumePrivateAction('private:u1', row), false, '归属局不认领 → 交给模型');
    assert.deepEqual(w.mgr.games.get('group:2').state.pending.wolves, {}, '绝不能转给更早的局执行');
    assert.equal(w.sent.length, 0, '也不该有任何回执');
  }
  // ② 归属局刚结束（终局播报还在发）→ 同样不转给另一局
  {
    const w = await build();
    w.mgr.games.get('group:1').state.phase = 'ended';
    w.sent.length = 0;
    const row = w.store.appendIncoming('private:u1', { mid: 'own-2', ts: Date.now(), senderId: 'u1', senderName: '群友1', text: '查 3', reply: null, media: [] });
    assert.equal(await w.mgr.consumePrivateAction('private:u1', row), false, '刚结束的归属局 → 按普通私聊');
    assert.deepEqual(w.mgr.games.get('group:2').state.pending.wolves, {}, '不能把给刚结束那局的行动喂给别的局');
    assert.deepEqual(w.mgr.games.get('group:2').state.pending.seer, '', '同上（查也不例外）');
  }
  // ③ 归属局里这个人已退出 → 由它回一句"你本来就不在局里"（不让别的局执行，这是已知取舍）
  {
    const w = await build();
    const mine = w.mgr.games.get('group:1').state.roles.find((r) => r.userId === 'u1');
    mine.alive = false;
    mine.quit = true;
    w.sent.length = 0;
    const row = w.store.appendIncoming('private:u1', { mid: 'own-3', ts: Date.now(), senderId: 'u1', senderName: '群友1', text: '刀 2', reply: null, media: [] });
    assert.equal(await w.mgr.consumePrivateAction('private:u1', row), true, '归属局要接住并回执');
    assert.equal(
      w.sent.some((x) => x.chatKey === 'private:u1' && /已经出局|本来就不在局里/.test(x.msgs[0])),
      true,
      '要告诉他已经不在那一局了：' + JSON.stringify(w.sent.map((x) => x.msgs[0]))
    );
    assert.deepEqual(w.mgr.games.get('group:2').state.pending.wolves, {}, '他的行动不会转给另一局（一次只玩一局）');
  }
});

test('对抗性回归：名单里的重复项要去重（不能一个人拿两张身份）', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  // ① 同一个名字写 6 遍 → 去重后只剩 1 个 → 人数不够，拒绝
  const bad = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf', players: Array(6).fill('群友1') });
  assert.equal(bad.ok, false, '一个人写 6 遍不该开出 6 人局：' + JSON.stringify(bad));
  assert.match(bad.error, /名单里只有 1 个能用/, bad.error);
  // ② 正常 6 人 + 重复项 → 去重后正好 6 人，且每人只拿一张牌 / 一条身份私聊
  const ok = await w.mgr.start({
    chatKey: 'group:1', gameId: 'werewolf',
    players: ['群友1', '群友1', '群友2', '群友3', '群友4', '群友5', '群友6']
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const roster = w.mgr.games.get('group:1').state.roles.map((r) => r.userId);
  assert.equal(roster.length, 6, '去重后正好 6 个：' + JSON.stringify(roster));
  assert.equal(new Set(roster).size, 6, '名单不能有重复的人');
  const idDms = w.sent.filter((x) => x.chatKey.startsWith('private:') && /你是\*\*/.test(x.msgs[0]));
  assert.equal(idDms.length, 6, '身份私聊按人去重（每人一张）：' + idDms.length);
  assert.equal(new Set(idDms.map((x) => x.chatKey)).size, 6, '同一个人不能收到两条身份');
});

test('数字炸弹：边界与文案（炸弹=1 / 炸弹=100、区间提示、摘要两种状态）', async () => {
  const bomb = await import('../src/features/games/number-bomb.js');
  // 炸弹 = 1（rng 0）
  let s = bomb.create({ rng: () => 0 });
  assert.equal(s.secret, 1);
  assert.equal(s.low, 0);
  assert.equal(s.high, 101, '区间要从 0/101 起（否则"炸弹是 1 或 100"时文案会说错）');
  // 还没收窄时猜 0 → 越界提示必须写清是 1~100
  const zero = bomb.onMessage(s, { userId: 'u1', name: '群友1', text: '猜 0' });
  assert.match(zero.effects[0].text, /1~100 之间/, zero.effects[0].text);
  const hit1 = bomb.onMessage(s, { userId: 'u2', name: '群友2', text: '猜 1' });
  assert.equal(hit1.state.phase, 'ended', '猜 1 要命中');
  assert.match(hit1.effects[0].result, /踩中炸弹 1/, hit1.effects[0].result);
  assert.match(bomb.summaryForModel(hit1.state), /已结束（群友2 踩中 1）/, bomb.summaryForModel(hit1.state));
  // 炸弹 = 100（rng 0.999）
  let t = bomb.create({ rng: () => 0.999 });
  assert.equal(t.secret, 100);
  assert.match(bomb.onMessage(t, { userId: 'u3', name: '群友3', text: '猜 100' }).effects[0].result, /踩中炸弹 100/);
  // 收窄后的区间提示要跟着变
  let u = bomb.create({ rng: () => 0.5 });
  u = bomb.onMessage(u, { userId: 'u4', name: '群友4', text: '猜 20' }).state;   // 20 < secret → low=20
  const narrowed = bomb.onMessage(u, { userId: 'u5', name: '群友5', text: '猜 99' });  // 99 > secret → high=99
  assert.equal(narrowed.state.low, 20);
  assert.equal(narrowed.state.high, 99);
  assert.match(bomb.summaryForModel(narrowed.state), /21~98 之间/, bomb.summaryForModel(narrowed.state));
  // 聊天里的数字不误收窄（直接断言区间没动）
  let v = bomb.create({ rng: () => 0.5 });
  const chat = bomb.onMessage(v, { userId: 'u6', name: '群友6', text: '我 12 点开会' });
  assert.equal(chat.state.low, v.low);
  assert.equal(chat.state.high, v.high);
  assert.equal(chat.effects.length, 0);
});

test('管理台视角：status 列出进行中的局，stop 就地结束并播报', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const st = w.mgr.status();
  assert.equal(st.enabled, true);
  assert.equal(st.running.length, 1, JSON.stringify(st));
  assert.equal(st.running[0].chatKey, 'group:1');
  assert.match(st.running[0].name, /狼人杀/);
  assert.match(String(st.running[0].summary || ''), /狼人杀/, '面板要能显示公开摘要：' + st.running[0].summary);
  w.sent.length = 0;
  const out = await w.mgr.stop('group:1', '管理员在控制台结束');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(w.mgr.status().running.length, 0, '结束后不该还在列表里');
  assert.ok(
    w.sent.some((x) => x.chatKey === 'group:1' && /到此为止/.test(x.msgs[0])),
    '结束要往群里发一句说明：' + JSON.stringify(w.sent.map((x) => x.msgs[0]))
  );
});

test('报名快截止时提一句「还差 N 人」（只提一次；窗口太短不提）', async () => {
  const w = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 30, games: ['werewolf'] } });
  await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  say(w.store, 'u1', '群友1', '我玩');            // 只来 1 个人
  await w.mgr.tick();
  w.sent.length = 0;
  const until = Number(w.mgr.games.get('group:1').state.recruitUntil);
  w.setClock(until - 10 * 1000);                  // 距截止 10 秒
  await w.mgr.tick();
  const hits = w.sent.filter((x) => x.chatKey === 'group:1' && /报名马上截止/.test(x.msgs[0]));
  assert.equal(hits.length, 1, JSON.stringify(w.sent.map((x) => x.msgs[0])));
  assert.match(hits[0].msgs[0], /现在 1 人，还差 5 人/, hits[0].msgs[0]);
  await w.mgr.tick();
  assert.equal(w.sent.filter((x) => /报名马上截止/.test(x.msgs[0])).length, 1, '只提一次');
  // 窗口太短（<30 秒）不提：避免刚挂出去就喊"马上截止"
  const w2 = makeWorld({ players: 6 });
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 10, games: ['werewolf'] } });
  await w2.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  w2.sent.length = 0;
  const until2 = Number(w2.mgr.games.get('group:1').state.recruitUntil);
  w2.setClock(until2 - 5 * 1000);
  await w2.mgr.tick();
  assert.equal(w2.sent.filter((x) => /报名马上截止/.test(x.msgs[0])).length, 0, '10 秒窗口不提');
});

test('别名撞车（某人的备注 = 另一个人的群名片）时宁缺勿错：不解析成任何一个人', async () => {
  // u1 的备注写成 u2 的群名片 → 键「群友2」同时指向两个人
  const w1 = makeWorld({ players: 4 });
  updateConfig({ memberNotes: { u1: '群友2' } });
  const hit = await w1.mgr.start({ chatKey: 'group:1', gameId: 'number-bomb', players: ['群友2'] });
  assert.equal(hit.ok, false, '撞车的名字不该被静默解析成某一个人（原来是 Map 后写覆盖 → 身份/查验结果发错对象）');
  // 光断言 ok:false 咬不住：解析成 u2 时也会因为"只有 1 个能用"而失败。要钉住"一个都没解析到"。
  assert.match(hit.error, /只有 0 个能用/, '撞车的键必须整个作废，不能落到某一个人身上');

  // 对照组一：没撞车的名字照常解析（别把整张表都废掉）
  const w2 = makeWorld({ players: 4 });
  updateConfig({ memberNotes: { u1: '群友2' } });
  const fine = await w2.mgr.start({ chatKey: 'group:1', gameId: 'number-bomb', players: ['群友3', '群友4'] });
  assert.equal(fine.ok, true, `没撞车的名字仍要能开局：${fine.error || ''}`);

  // 对照组二：没有备注时，两个名片各自可解析
  //   注意 memberNotes 必须用 __replace__ 清空：普通深合并删不掉键（备注会一直留着）
  const w3 = makeWorld({ players: 4 });
  updateConfig({ memberNotes: { __replace__: {} } });
  const back = await w3.mgr.start({ chatKey: 'group:1', gameId: 'number-bomb', players: ['群友1', '群友2'] });
  assert.equal(back.ok, true, `没有备注时名片应可解析：${back.error || ''}`);
});

const { EffectLedger } = await import('../src/core/effects.js');

test('终局播报接入账本：送达记 sent，同一局再次 begin 直接 done', async () => {
  const w = makeWorld({ players: 6 });
  const effects = new EffectLedger(w.store.db);
  w.mgr.effects = effects;
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const st = w.mgr.games.get('group:1').state;
  const wolves = st.roles.filter((x) => x.role === 'wolf');
  const other = st.roles.find((x) => x.role !== 'wolf');
  for (const uid of [wolves[0].userId, wolves[1].userId, other.userId]) {
    w.store.appendIncoming(`private:${uid}`, { mid: `q-${uid}`, ts: Date.now(), senderId: uid, senderName: uid, text: '不玩了', reply: null, media: [] }, { recordOnly: true });
  }
  await w.mgr.tick();
  const ends = w.sent.filter((x) => x.chatKey === 'group:1' && /狼人杀结束：/.test(x.msgs[0]));
  assert.equal(ends.length, 1);
  const row = w.store.db.prepare("SELECT id, state, detail FROM effects WHERE kind='game-final'").get();
  assert.ok(row, '终局播报要进账本');
  assert.equal(row.state, 'sent');
  const instanceId = JSON.parse(row.detail).instanceId;
  assert.ok(instanceId, '每局必须有唯一 instanceId（不能用游戏类型做幂等键）');
  const again = effects.begin({ kind: 'game-final', chatKey: 'group:1', idemKey: `game:group:1:${instanceId}` });
  assert.equal(again.action, 'done', '同一局的终局播报不能再发一次');
});

test('终局播报结果未知：账本 unknown，下个 tick 停止重试而不是重发', async () => {
  const w = makeWorld({ players: 6 });
  const effects = new EffectLedger(w.store.db);
  w.mgr.effects = effects;
  w.store.hasUncertainEffects = () => true;   // 模拟 outbox 里有本次未知行
  let finalCalls = 0;
  w.mgr.sender = {
    sendTextBatch: async (_chatKey, msgs) => {
      if (/结束：/.test(String(msgs?.[0] || ''))) {
        finalCalls += 1;
        throw Object.assign(new Error('socket timeout'), { outcome: 'unknown' });
      }
      return { message_id: 1 };
    }
  };
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });
  const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const st = w.mgr.games.get('group:1').state;
  const wolves = st.roles.filter((x) => x.role === 'wolf');
  const other = st.roles.find((x) => x.role !== 'wolf');
  for (const uid of [wolves[0].userId, wolves[1].userId, other.userId]) {
    w.store.appendIncoming(`private:${uid}`, { mid: `q-${uid}`, ts: Date.now(), senderId: uid, senderName: uid, text: '不玩了', reply: null, media: [] }, { recordOnly: true });
  }
  await w.mgr.tick();
  assert.equal(finalCalls, 1);
  const row = w.store.db.prepare("SELECT state FROM effects WHERE kind='game-final'").get();
  assert.equal(row.state, 'unknown');
  assert.ok(w.mgr.games.get('group:1')?.pendingEnd, '未知时要挂起 pendingEnd 等下个 tick 收尾');

  // 下个 tick（越过退避时间）：账本 review → 不再发，直接收尾
  w.setClock(w.getClock() + 30 * 60 * 1000);
  await w.mgr.tick();
  assert.equal(finalCalls, 1, '结果未知绝不重发');
  assert.equal(w.mgr.games.has('group:1'), false, '收尾要清掉挂起的局');
});

test('同一群同一种游戏开第二局：终局播报照常发（幂等键按局而不是游戏类型）', async () => {
  const w = makeWorld({ players: 6 });
  const effects = new EffectLedger(w.store.db);
  w.mgr.effects = effects;
  updateConfig({ groupGame: { enabled: true, chats: ['group:1'], allowPrivateInvite: true, allowGamePrivateDm: false, dailyLimitPerChat: 6, recruitSeconds: 0, games: ['werewolf'] } });

  const playOne = async (tag) => {
    const r = await w.mgr.start({ chatKey: 'group:1', gameId: 'werewolf' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const st = w.mgr.games.get('group:1').state;
    const wolves = st.roles.filter((x) => x.role === 'wolf');
    const other = st.roles.find((x) => x.role !== 'wolf');
    for (const uid of [wolves[0].userId, wolves[1].userId, other.userId]) {
      w.store.appendIncoming(`private:${uid}`, { mid: `q-${tag}-${uid}`, ts: Date.now(), senderId: uid, senderName: uid, text: '不玩了', reply: null, media: [] }, { recordOnly: true });
    }
    await w.mgr.tick();
  };

  await playOne('a');
  await playOne('b');
  const ends = w.sent.filter((x) => x.chatKey === 'group:1' && /狼人杀结束：/.test(x.msgs[0]));
  assert.equal(ends.length, 2, '两局都要有终局播报：' + JSON.stringify(w.sent.map((x) => x.msgs[0])));
  const rows = w.store.db.prepare("SELECT state FROM effects WHERE kind='game-final'").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.state === 'sent'));
});
