import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rmDirBestEffort } from './helpers/cleanup.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-identity-store-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => rmDirBestEffort(root));

const { ChatStore } = await import('../src/core/store.js');
const {
  IdentityStore,
  identityDatabasePath,
  readLegacyIdentityMemories
} = await import('../src/identity/identity-store.js');
const { IdentityPilotManager } = await import('../src/identity/identity-pilot.js');

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('identity pilot is promoted: legacy enabled:false no longer gates it', async (t) => {
  // 稳定特性策略（src/core/stable-feature-policy.js）把身份基建转正：
  // config.js 的 identityPilotEnabled() 恒为 true，旧的 enabled:false 只会
  // 留在原始配置里被忽略，不再阻止建库或索引。
  const dir = fs.mkdtempSync(path.join(root, 'promoted-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });
  let calls = 0;
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => ({ identityPilot: { enabled: false } }),
    onebot: { call: async () => { calls += 1; return []; } },
    log: () => {}
  });
  const status = await manager.start();
  assert.equal(status.enabled, true);
  assert.equal(status.active, true);
  assert.equal(fs.existsSync(identityDatabasePath(dir)), true);
  assert.equal(calls >= 1, true, '启动时应向 OneBot 拉取好友列表');
});

test('unifies the same QQ across chats and indexes legacy memory without modifying it', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'enabled-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });
  const now = Date.now();
  store.appendIncoming('group:100', {
    mid: 1, ts: now - 3000, senderId: '123456', senderName: '群名片甲', text: '群里消息'
  });
  store.appendIncoming('private:123456', {
    mid: 2, ts: now - 2000, senderId: '123456', senderName: '私聊昵称', text: '私聊消息'
  });
  store.appendIncoming('group:100', {
    mid: 3, ts: now - 1000, senderId: '999999', senderName: '被屏蔽者', text: '不应进入'
  });
  store.appendIncoming('group:200', {
    mid: 4, ts: now, senderId: '777777', senderName: '非白名单成员', text: '不应进入'
  });

  const memoryDir = path.join(dir, 'memory', 'group_100');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memoryFile = path.join(memoryDir, '123456.json');
  fs.writeFileSync(memoryFile, JSON.stringify({
    userId: '123456',
    name: '群名片甲',
    impressions: [
      { content: '喜欢讨论系统设计', createdAt: now - 5000 },
      { content: '喜欢讨论系统设计', createdAt: now - 4000 }
    ]
  }, null, 2));
  const privateMemoryDir = path.join(dir, 'memory', 'private_123456');
  fs.mkdirSync(privateMemoryDir, { recursive: true });
  fs.writeFileSync(path.join(privateMemoryDir, '123456.json'), JSON.stringify({
    userId: '123456',
    name: '私聊昵称',
    impressions: [
      { content: '只应在私聊上下文可见的印象', createdAt: now - 3500 }
    ]
  }, null, 2));
  const beforeHash = fileDigest(memoryFile);
  const beforeMtime = fs.statSync(memoryFile).mtimeMs;

  const cfg = {
    identityPilot: { enabled: true },
    allow: { groups: ['100'], private: ['123456'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: { 100: ['999999'] }
  };
  let friendCalls = 0;
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      call: async (action) => {
        assert.equal(action, 'get_friend_list');
        friendCalls += 1;
        return [{ user_id: 123456, nickname: '好友昵称', remark: '好友备注' }];
      }
    },
    log: () => {}
  });

  const status = await manager.start();
  assert.equal(status.active, true);
  assert.equal(status.people, 1);
  assert.equal(status.sources, 2);
  assert.equal(status.friends, 1);
  assert.equal(status.legacyMemories, 2);
  assert.equal(friendCalls, 1);
  // Windows 没有 POSIX 权限位，这条只能在 POSIX 上验证（fixture 已用 0600 创建）。
  if (process.platform !== 'win32') assert.equal(fs.statSync(identityDatabasePath(dir)).mode & 0o777, 0o600);

  const people = manager.listPeople();
  assert.equal(people.length, 1);
  assert.equal(people[0].userId, '123456');
  assert.equal(people[0].primaryName, '好友备注');
  assert.equal(people[0].chatCount, 2);
  assert.equal(people[0].messageCount, 2);
  assert.equal(people[0].legacyMemoryCount, 2);
  assert.deepEqual(
    new Set(people[0].aliases.map((item) => item.alias)),
    new Set(['群名片甲', '私聊昵称'])
  );
  assert.equal(fileDigest(memoryFile), beforeHash);
  assert.equal(fs.statSync(memoryFile).mtimeMs, beforeMtime);
  const groupView = manager.lookupPerson('123456', { chatKey: 'group:100' });
  assert.equal(groupView.currentContextMemories.length, 1);
  assert.equal(groupView.currentContextMemories[0].content, '喜欢讨论系统设计');
  assert.equal(groupView.otherContextMemoryCount, 1);
  assert.ok(!JSON.stringify(groupView).includes('只应在私聊上下文可见的印象'));
  const privateView = manager.lookupPerson('123456', { chatKey: 'private:123456' });
  assert.equal(privateView.currentContextMemories[0].content, '只应在私聊上下文可见的印象');
  assert.equal(manager.lookupPerson('777777', { chatKey: 'group:100' }), null);

  const stored = store.appendIncoming('group:100', {
    mid: 5, ts: now + 1000, senderId: '123456', senderName: '新群名片', text: '增量消息'
  });
  assert.equal(manager.observeMessage('group:100', stored), true);
  const updated = manager.listPeople()[0];
  assert.equal(updated.messageCount, 3);
  assert.ok(updated.aliases.some((item) => item.alias === '新群名片'));

  cfg.identityPilot.enabled = false;
  manager.stop();
  assert.equal(manager.active, false);
  assert.equal(manager.observeMessage('group:100', stored), false);
});

test('legacy memory scanner ignores name-only identities and leaves source bytes untouched', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'legacy-'));
  t.after(() => rmDirBestEffort(dir));
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const file = path.join(memoryDir, 'group_300.json');
  fs.writeFileSync(file, JSON.stringify({
    memberImpression: [
      { userId: '456789', target: '有号码', content: '稳定印象', createdAt: 1 },
      { target: '只有名字', content: '不能跨群归并', createdAt: 2 }
    ]
  }));
  const before = fs.readFileSync(file);
  const rows = readLegacyIdentityMemories(dir);
  assert.deepEqual(rows.map((row) => ({
    userId: row.userId, chatKey: row.chatKey, content: row.content
  })), [{ userId: '456789', chatKey: 'group:300', content: '稳定印象' }]);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('friend proposals require eligibility, deduplicate, cool down, and close on friend_add', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'friend-proposals-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  const cfg = {
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        ownerUin: '900001',
        minMessageCount: 2,
        cooldownDays: 30,
        maxPending: 2
      }
    },
    allow: { groups: ['100'], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
  const now = Date.now();
  for (let i = 1; i <= 2; i++) {
    store.appendIncoming('group:100', {
      mid: i,
      ts: now + i,
      senderId: '123456',
      senderName: '候选成员',
      text: `消息${i}`
    });
    store.appendIncoming('group:100', {
      mid: i + 10,
      ts: now + i,
      senderId: '654321',
      senderName: '冷却成员',
      text: `冷却消息${i}`
    });
  }
  const notices = [];
  const onebotActions = [];
  const sentRequests = [];
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      call: async (action) => {
        if (action === 'get_friend_list') onebotActions.push(action);
        if (action === 'get_login_info') return { user_id: 900001, nickname: 'bot' };
        return [];
      }
    },
    // 好友申请分发已转正（stable-feature-policy）：批准后走协议发送，
    // 这里注入桩件避免真实 SnowLuma 协议交互。
    sendFriendRequest: async (_onebot, request) => {
      sentRequests.push(request);
      return { accepted: true };
    },
    notifyFriendProposal: async (proposal, ownerUin) => {
      notices.push({ proposal, ownerUin });
    },
    log: () => {}
  });
  t.after(() => {
    manager.stop();
    rmDirBestEffort(dir);
  });
  await manager.start();

  const created = await manager.proposeFriend({
    userId: '123456',
    chatKey: 'group:100',
    reasonCode: 'frequent',
    reason: '已经连续聊了很多次',
    verificationMessage: '以后继续聊'
  });
  assert.equal(created.created, true);
  assert.equal(created.adminNotified, true);
  assert.equal(created.proposal.status, 'pending');
  assert.equal(created.proposal.notifiedAt > 0, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].ownerUin, '900001');

  const duplicate = await manager.proposeFriend({
    userId: '123456',
    chatKey: 'group:100',
    reasonCode: 'interest',
    reason: '重复候选不应新增'
  });
  assert.equal(duplicate.created, false);
  assert.equal(manager.listFriendProposals().length, 1);

  // 主动好友候选已退役（Issue #10 + QQ 账号风控）：manager 层的批准派发不可达，
  // 这里用 store 层状态机直接模拟"已派发并受理"，验证 close on friend_add 链路。
  await assert.rejects(
    () => manager.decideFriendProposal(
      created.proposal.id,
      'approve',
      { decidedBy: '900001' }
    ),
    /主动好友候选功能当前未启用/
  );
  const dispatching = manager.identityStore.decideFriendProposal(
    created.proposal.id,
    'approve',
    { decidedBy: '900001', dispatch: true }
  );
  assert.equal(dispatching.status, 'dispatching');
  const sent = manager.identityStore.completeFriendProposalDispatch(
    created.proposal.id,
    dispatching.dispatchAttemptId,
    'sent'
  );
  assert.equal(sent.status, 'sent');

  assert.equal(await manager.markFriendAdded('123456'), 1);
  assert.equal(manager.listFriendProposals()[0].status, 'accepted');
  assert.equal(manager.listPeople()[0].isFriend, true);
  assert.deepEqual(manager.status().friendProposal.counts, {
    total: 1,
    pending: 0,
    approvedManual: 0,
    dispatching: 0,
    sent: 0,
    heldUnknown: 0,
    failed: 0,
    accepted: 1,
    rejected: 0
  });

  const rejected = await manager.proposeFriend({
    userId: '654321',
    chatKey: 'group:100',
    reasonCode: 'banter',
    reason: '想以后继续互怼'
  });
  manager.identityStore.decideFriendProposal(
    rejected.proposal.id,
    'reject',
    { decidedBy: '900001' }
  );
  await assert.rejects(
    manager.proposeFriend({
      userId: '654321',
      chatKey: 'group:100',
      reasonCode: 'banter',
      reason: '冷却期内重复'
    }),
    /冷却期/
  );
});

test('friend proposal validation enforces message threshold and administrator configuration', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'friend-proposal-validation-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });
  const cfg = {
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        ownerUin: '900001',
        minMessageCount: 3,
        cooldownDays: 30,
        maxPending: 1
      }
    },
    allow: { groups: ['100'], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
  store.appendIncoming('group:100', {
    mid: 1,
    ts: Date.now(),
    senderId: '123456',
    senderName: '候选成员',
    text: '只有一条'
  });
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: { call: async () => [] },
    log: () => {}
  });
  t.after(() => manager.stop());
  await manager.start();
  await assert.rejects(
    manager.proposeFriend({
      userId: '123456',
      chatKey: 'group:100',
      reasonCode: 'interest',
      reason: '互动不足'
    }),
    /互动消息不足/
  );
  cfg.identityPilot.friendProposal.ownerUin = '';
  await assert.rejects(
    manager.proposeFriend({
      userId: '123456',
      chatKey: 'group:100',
      reasonCode: 'interest',
      reason: '没有管理员'
    }),
    /管理员 QQ/
  );
});

test('friend proposal is retired: approval is rejected even with legacy enabled config', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'friend-dispatch-retired-'));
  const store = new ChatStore(0, { dataDir: dir });
  const cfg = {
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        activeDispatchEnabled: true,
        ownerUin: '900001',
        minMessageCount: 1,
        cooldownDays: 30,
        maxPending: 2
      }
    },
    allow: { groups: ['100'], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      selfId: '888888',
      connected: true,
      call: async () => []
    },
    sendFriendRequest: async () => {
      throw new Error('退役功能绝不能到达发包层');
    },
    log: () => {}
  });
  // 单钩子保证顺序：先 manager.stop()（关 identity 库句柄）再删目录，
  // 否则 Windows 上 sqlite 句柄未释放会 EBUSY。
  t.after(() => {
    manager.stop();
    store.close();
    rmDirBestEffort(dir);
  });
  await manager.start();
  // 主动好友候选已退役（Issue #10 + QQ 账号风控）：功能门硬编码关闭，
  // 即使旧配置 enabled:true、即使存在真实的 pending 提案，也不能批准派发。
  manager.identityStore.observe('group:100', {
    senderId: '123456',
    senderName: '候选成员',
    ts: Date.now()
  });
  const created = manager.identityStore.createFriendProposal({
    userId: '123456',
    sourceChatKey: 'group:100',
    reasonCode: 'interest',
    reason: '退役验证：旧配置不得批准派发',
    verificationMessage: '继续聊',
    minMessageCount: 1
  });
  assert.equal(created.created, true);
  await assert.rejects(
    () => manager.decideFriendProposal(created.proposal.id, 'approve', { decidedBy: '900001' }),
    /主动好友候选功能当前未启用/
  );
  assert.equal(manager.identityStore.getFriendProposal(created.proposal.id).status, 'pending');
});

test('unknown friend request result is held and a crashed dispatch is recovered as unknown', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'friend-dispatch-unknown-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  const cfg = {
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        activeDispatchEnabled: true,
        ownerUin: '900001',
        minMessageCount: 1,
        cooldownDays: 30,
        maxPending: 2
      }
    },
    allow: { groups: ['100'], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
  for (const userId of ['123456', '654321']) {
    store.appendIncoming('group:100', {
      mid: Number(userId),
      ts: Date.now(),
      senderId: userId,
      senderName: `候选${userId}`,
      text: '测试未知结果'
    });
  }
  let attempts = 0;
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      selfId: '888888',
      connected: true,
      call: async () => []
    },
    sendFriendRequest: async () => {
      attempts += 1;
      throw new Error('socket closed after write');
    },
    log: () => {}
  });
  t.after(() => manager.stop());
  await manager.start();
  const first = await manager.proposeFriend({
    userId: '123456',
    chatKey: 'group:100',
    reasonCode: 'frequent',
    reason: '经常聊天'
  });
  // 主动好友候选已退役：manager 派发不可达（功能门硬拦截），发包层绝不可达。
  await assert.rejects(
    () => manager.decideFriendProposal(
      first.proposal.id,
      'approve',
      { decidedBy: '900001' }
    ),
    /主动好友候选功能当前未启用/
  );
  assert.equal(attempts, 0);

  // 崩溃恢复路径改用 store 层状态机验证：派发后写入 held_unknown（结果未知），
  // 且绝不自动重试。
  const dispatching = manager.identityStore.decideFriendProposal(
    first.proposal.id,
    'approve',
    { decidedBy: '900001', dispatch: true }
  );
  assert.equal(dispatching.status, 'dispatching');
  const held = manager.identityStore.completeFriendProposalDispatch(
    first.proposal.id,
    dispatching.dispatchAttemptId,
    'held_unknown',
    { error: 'socket closed after write (模拟派发时崩溃)' }
  );
  assert.equal(held.status, 'held_unknown');
  assert.match(held.dispatchError, /socket closed/);

  const second = await manager.proposeFriend({
    userId: '654321',
    chatKey: 'group:100',
    reasonCode: 'banter',
    reason: '继续互怼'
  });
  manager.identityStore.decideFriendProposal(
    second.proposal.id,
    'approve',
    { decidedBy: '900001', dispatch: true }
  );
  manager.stop();
  const reopened = new IdentityStore({ dataDir: dir });
  t.after(() => reopened.close());
  assert.equal(reopened.getFriendProposal(second.proposal.id).status, 'held_unknown');
  assert.match(
    reopened.getFriendProposal(second.proposal.id).dispatchError,
    /结果确认前重启/
  );
  t.after(() => rmDirBestEffort(dir));
});

test('incoming friend requests notify once, require approval, and add the private whitelist', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'incoming-friend-request-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });
  const cfg = {
    identityPilot: {
      enabled: true,
      incomingFriendRequest: {
        enabled: true,
        autoWhitelist: true
      },
      friendProposal: {
        enabled: true,
        activeDispatchEnabled: true,
        ownerUin: '900001',
        minMessageCount: 1,
        cooldownDays: 30,
        maxPending: 10
      }
    },
    allow: { groups: ['100'], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
  const calls = [];
  const notices = [];
  const whitelisted = [];
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      call: async (action, params) => {
        calls.push({ action, params });
        return [];
      }
    },
    notifyIncomingFriendRequest: async (request, ownerUin) => {
      notices.push({ request, ownerUin });
    },
    allowPrivateUser: async (userId) => {
      whitelisted.push(userId);
    },
    log: () => {}
  });
  t.after(() => manager.stop());
  await manager.start();

  const first = await manager.receiveIncomingFriendRequest({
    userId: '123456',
    flag: 'request-flag-1',
    comment: '想认识一下'
  });
  assert.equal(first.created, true);
  assert.equal(first.request.status, 'pending');
  assert.equal(first.request.notifiedAt > 0, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].ownerUin, '900001');

  const duplicate = await manager.receiveIncomingFriendRequest({
    userId: '123456',
    flag: 'request-flag-1',
    comment: '重复事件'
  });
  assert.equal(duplicate.created, false);
  assert.equal(notices.length, 1, '同一 OneBot flag 不应重复通知管理员');
  const refreshed = await manager.receiveIncomingFriendRequest({
    userId: '123456',
    flag: 'request-flag-2',
    comment: '重新发送申请'
  });
  assert.equal(refreshed.created, false);
  assert.equal(refreshed.refreshed, true);
  assert.equal(notices.length, 1, '同一用户的待审批请求只保留一条');

  const approved = await manager.decideIncomingFriendRequest(
    first.request.id,
    'approve',
    { decidedBy: '900001', remark: '新朋友' }
  );
  assert.equal(approved.execution, 'approved');
  assert.equal(approved.request.status, 'approved');
  assert.equal(approved.request.whitelistApplied, true);
  assert.deepEqual(whitelisted, ['123456']);
  assert.deepEqual(calls.at(-1), {
    action: 'set_friend_add_request',
    params: {
      flag: 'request-flag-2',
      approve: true,
      remark: '新朋友'
    }
  });
  await assert.rejects(
    manager.decideIncomingFriendRequest(first.request.id, 'approve', {
      decidedBy: '900001'
    }),
    /已处理：approved/
  );
  assert.equal(calls.filter((item) => item.action === 'set_friend_add_request').length, 1);

  assert.equal(await manager.markFriendAdded('123456'), 1);
  const accepted = manager.listIncomingFriendRequests()[0];
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.whitelistApplied, true);
  assert.equal(manager.status().incomingFriendRequest.counts.accepted, 1);

  const rejectedRequest = await manager.receiveIncomingFriendRequest({
    userId: '654321',
    flag: 'request-flag-reject',
    comment: '请拒绝'
  });
  const rejected = await manager.decideIncomingFriendRequest(
    rejectedRequest.request.id,
    'reject',
    { decidedBy: '900001' }
  );
  assert.equal(rejected.execution, 'rejected');
  assert.equal(rejected.request.status, 'rejected');
  assert.deepEqual(calls.at(-1), {
    action: 'set_friend_add_request',
    params: {
      flag: 'request-flag-reject',
      approve: false
    }
  });
  assert.deepEqual(whitelisted, ['123456']);
});

test('incoming friend request keeps an unknown result and never retries automatically', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'incoming-friend-request-unknown-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });
  const cfg = {
    identityPilot: {
      enabled: true,
      incomingFriendRequest: { enabled: true, autoWhitelist: true },
      friendProposal: {
        enabled: false,
        ownerUin: '900001',
        minMessageCount: 1,
        cooldownDays: 30,
        maxPending: 10
      }
    },
    allow: { groups: [], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
  let attempts = 0;
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      call: async (action) => {
        if (action === 'get_friend_list') return [];
        attempts += 1;
        throw new Error('socket closed after write');
      }
    },
    notifyIncomingFriendRequest: async () => {},
    log: () => {}
  });
  t.after(() => manager.stop());
  await manager.start();
  const created = await manager.receiveIncomingFriendRequest({
    userId: '654321',
    flag: 'request-flag-unknown',
    comment: ''
  });
  const result = await manager.decideIncomingFriendRequest(
    created.request.id,
    'approve',
    { decidedBy: '900001' }
  );
  assert.equal(result.execution, 'held-unknown');
  assert.equal(result.request.status, 'held_unknown');
  assert.match(result.request.actionError, /socket closed/);
  await assert.rejects(
    manager.decideIncomingFriendRequest(created.request.id, 'approve', {
      decidedBy: '900001'
    }),
    /已处理：held_unknown/
  );
  assert.equal(attempts, 1);

  const interrupted = await manager.receiveIncomingFriendRequest({
    userId: '777777',
    flag: 'request-flag-interrupted',
    comment: '测试重启恢复'
  });
  manager.identityStore.beginIncomingFriendRequestDecision(
    interrupted.request.id,
    'approve',
    { decidedBy: '900001' }
  );
  manager.stop();
  const reopened = new IdentityStore({ dataDir: dir });
  t.after(() => reopened.close());
  const recovered = reopened.getIncomingFriendRequest(interrupted.request.id);
  assert.equal(recovered.status, 'held_unknown');
  assert.match(recovered.actionError, /结果确认前重启/);
});

test('台账保留期清理：90 天前已了结的删掉，未决的留着', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'prune-ledgers-'));
  const store = new IdentityStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });

  const old = Date.now() - 120 * 24 * 60 * 60 * 1000;
  const fresh = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const addOpportunity = store.db.prepare(`
    INSERT INTO friend_opportunities (id, account_uin, uin, source_chat_key, trigger_key, status, created_at, updated_at)
    VALUES (?, '1000', '2000', 'group:1', ?, ?, ?, ?)
  `);
  addOpportunity.run('fo_old_done', 'k1', 'proposed', old, old);
  addOpportunity.run('fo_old_open', 'k2', 'queued', old, old);
  addOpportunity.run('fo_new_done', 'k3', 'proposed', fresh, fresh);
  const addProposal = store.db.prepare(`
    INSERT INTO friend_proposals (id, uin, source_chat_key, reason_code, reason, status, created_at, updated_at)
    VALUES (?, '2000', 'group:1', 'manual', 'r', ?, ?, ?)
  `);
  addProposal.run('fp_old_done', 'rejected', old, old);
  // 这两条是"等管理员处理"的真·未决（批准的提案要手动去 QQ 发起 / 已发送等好友确认），
  // 曾经因为状态名抄错被清掉 —— 用例把它们钉住。
  addProposal.run('fp_old_approved_manual', 'approved_manual', old, old);
  addProposal.run('fp_old_sent', 'sent', old, old);
  const addRequest = store.db.prepare(`
    INSERT INTO incoming_friend_requests (id, request_flag, uin, status, created_at, updated_at)
    VALUES (?, ?, '2000', ?, ?, ?)
  `);
  addRequest.run('ifr_old_decided', 'flag-decided', 'accepted', old, old);
  addRequest.run('ifr_old_pending', 'flag-pending', 'pending', old, old);
  // held_unknown = "结果未知，等管理员去 QQ 客户端核对"，必须留
  addRequest.run('ifr_old_held', 'flag-held', 'held_unknown', old, old);

  store.pruneLedgers();

  const idsOf = (sql) => store.db.prepare(sql).all().map((row) => row.id).sort();
  assert.deepEqual(
    idsOf('SELECT id FROM friend_opportunities'),
    ['fo_new_done', 'fo_old_open'],
    '过期的已了结机会要删掉；未过期的、以及还在排队的不许动'
  );
  assert.deepEqual(
    idsOf('SELECT id FROM friend_proposals'),
    ['fp_old_approved_manual', 'fp_old_sent'],
    '90 天前已了结的提议要清掉；approved_manual / sent 是等管理员处理的，必须留着'
  );
  assert.deepEqual(
    idsOf('SELECT id FROM incoming_friend_requests'),
    ['ifr_old_held', 'ifr_old_pending'],
    '未决的入站请求必须留着（含结果未知那些）'
  );
});

test('台账清理的边界：保留期可传参，恰好卡在保留期内的不删', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'prune-boundary-'));
  const store = new IdentityStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });

  const day = 24 * 60 * 60 * 1000;
  const add = store.db.prepare(`
    INSERT INTO friend_opportunities (id, account_uin, uin, source_chat_key, trigger_key, status, created_at, updated_at)
    VALUES (?, '1000', '2000', 'group:1', ?, 'proposed', ?, ?)
  `);
  add.run('fo_91d', 'b1', Date.now() - 91 * day, Date.now() - 91 * day);
  add.run('fo_89d', 'b2', Date.now() - 89 * day, Date.now() - 89 * day);

  const ids = () => store.db.prepare('SELECT id FROM friend_opportunities ORDER BY id').all().map((r) => r.id);

  store.pruneLedgers(90);
  assert.deepEqual(ids(), ['fo_89d'], '超期 91 天的删掉、89 天的留着');

  // 保留期可传参：收紧到 7 天 → 89 天那条也该走
  store.pruneLedgers(7);
  assert.deepEqual(ids(), []);
});

test('friend_add 自动白名单只补 allow，不清管理员手写的 deny.private', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'friend-add-deny-'));
  t.after(() => rmDirBestEffort(dir));
  const calls = [];
  const manager = new IdentityPilotManager({
    store: null,
    dataDir: dir,
    config: () => ({
      identityPilot: { incomingFriendRequest: { autoWhitelist: true } }
    }),
    onebot: { selfId: '888888', call: async () => [] },
    allowPrivateUser: async (userId, options) => { calls.push({ userId, options }); },
    log: () => {}
  });
  manager.identityStore = {
    listIncomingFriendRequests: () => [{ id: 7, userId: '123456', status: 'pending', whitelistApplied: false }],
    listFriendProposals: () => [],
    markFriendAdded: () => ({ proposals: 0, incoming: 1, opportunities: 0 }),
    markIncomingFriendWhitelist: () => {}
  };
  assert.equal(await manager.markFriendAdded('123456'), 1);
  assert.deepEqual(calls, [{ userId: '123456', options: { clearDeny: false } }]);
});
