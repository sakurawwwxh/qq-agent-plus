// 删除人物资产的一致性：墓碑落库后，待批好友请求/待评审机会必须一起取消，
// 已有 allow.private 保留（删人物 ≠ 拉黑），但任何链路都不能再把人自动加回白名单。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rmDirBestEffort } from './helpers/cleanup.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-identity-delete-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => rmDirBestEffort(root));

const { ChatStore } = await import('../src/core/store.js');
const { IdentityStore } = await import('../src/identity/identity-store.js');
const { IdentityPilotManager } = await import('../src/identity/identity-pilot.js');

function config() {
  return {
    identityPilot: {
      incomingFriendRequest: { enabled: true, autoWhitelist: true },
      friendProposal: {
        enabled: true,
        activeDispatchEnabled: true,
        ownerUin: '900001',
        minMessageCount: 1,
        cooldownDays: 30,
        maxPending: 10
      }
    },
    allow: { groups: ['100'], private: [] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
}

async function fixture(t, { onCall = null } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'pilot-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });
  const whitelisted = [];
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config,
    onebot: {
      selfId: '888888',
      call: async (action, params) => {
        if (onCall) await onCall(action, params);
        return [];
      }
    },
    notifyFriendProposal: async () => {},
    notifyIncomingFriendRequest: async () => {},
    allowPrivateUser: async (userId) => { whitelisted.push(userId); },
    log: () => {}
  });
  t.after(() => manager.stop());
  await manager.start();
  return { manager, store, dir, whitelisted };
}

function seedPerson(manager, userId = '123456') {
  manager.identityStore.upsertIdentityAsset({
    userId,
    primaryName: '人物甲',
    chatKey: 'group:100'
  });
}

function seedRequest(manager, userId = '123456', flag = 'flag-1') {
  return manager.receiveIncomingFriendRequest({
    userId,
    flag,
    comment: '想认识一下'
  });
}

function seedOpportunity(manager, userId = '123456', triggerKey = 'trigger-1') {
  return manager.identityStore.createFriendOpportunity({
    accountUin: '888888',
    userId,
    sourceChatKey: 'group:100',
    triggerKey,
    probability: 1,
    randomValue: 0
  });
}

test('删除人物：同事务取消待批请求与待评审机会，删提议与人物，保留白名单配置', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  const store = new IdentityStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmDirBestEffort(dir);
  });

  store.upsertIdentityAsset({ userId: '123456', primaryName: '甲', chatKey: 'group:1' });
  store.upsertIdentityAsset({ userId: '654321', primaryName: '乙', chatKey: 'group:1' });
  const opportunity = store.createFriendOpportunity({
    accountUin: '888888',
    userId: '123456',
    sourceChatKey: 'group:1',
    triggerKey: 'store-trigger-1',
    probability: 1,
    randomValue: 0
  });
  const request = store.createIncomingFriendRequest({
    userId: '123456',
    flag: 'flag-store-1'
  });
  assert.equal(opportunity.created, true);
  assert.equal(opportunity.opportunity.status, 'queued');
  store.db.prepare(`
    INSERT INTO friend_proposals (
      id, uin, source_chat_key, reason_code, reason, status, created_at, updated_at
    ) VALUES ('fp_delete', '123456', 'group:1', 'interest', '测试', 'pending', 1, 1)
  `).run();

  assert.equal(store.isIdentityAssetDeleted('123456'), false);
  assert.equal(store.deleteIdentityAsset('123456'), true);

  assert.equal(store.isIdentityAssetDeleted('123456'), true);
  assert.throws(() => store.upsertIdentityAsset({
    userId: '123456', primaryName: '复活', chatKey: 'group:1'
  }), /删除/, '编辑接口不能清墓碑复活人物');
  const revived = store.createFriendOpportunity({
    accountUin: '888888',
    userId: '123456',
    sourceChatKey: 'group:1',
    triggerKey: 'store-trigger-after-delete',
    probability: 1,
    randomValue: 0
  });
  assert.equal(revived.created, false);
  assert.equal(revived.reason, 'deleted-person', '删除后手动/在途评分不能新建好友机会');
  assert.equal(store.isIdentityAssetDeleted('654321'), false, '别人的墓碑不能串味');
  assert.equal(store.getPerson('123456', { chatKey: 'group:1' }), null, '人物行仍按原语义删除');
  assert.equal(
    store.getPerson('654321', { chatKey: 'group:1' })?.primaryName,
    '乙',
    '别的人物不受影响'
  );
  assert.equal(store.getFriendProposal('fp_delete'), null, 'friend_proposals 仍整行删除');

  // 好友列表快照刷新不能绕过墓碑把已删除人物加回来
  store.replaceKnownFriends([
    { userId: '123456', name: '甲' },
    { userId: '654321', name: '乙' }
  ]);
  assert.equal(store.getPerson('123456', { chatKey: 'group:1' }), null, '墓碑人物不能被好友快照复活');
  assert.equal(store.getPerson('654321', { chatKey: 'group:1' })?.primaryName, '乙', '其他好友照常处理');

  const cancelledRequest = store.getIncomingFriendRequest(request.request.id);
  assert.equal(cancelledRequest.status, 'cancelled');
  assert.equal(cancelledRequest.cancelReason, 'person-deleted');
  assert.equal(cancelledRequest.whitelistApplied, false, '取消的请求不能带白名单成功标记');

  const cancelledOpportunity = store.getFriendOpportunity(opportunity.opportunity.id);
  assert.equal(cancelledOpportunity.status, 'cancelled');
  assert.equal(cancelledOpportunity.reason, 'person-deleted');

  assert.equal(store.deleteIdentityAsset('999999'), false, '不存在的人物返回 false');
});

test('删除后：新入站请求直接忽略，审批/补记好友都不能再加白名单', async (t) => {
  const f = await fixture(t);
  seedPerson(f.manager);
  const opportunity = seedOpportunity(f.manager);
  assert.equal(opportunity.created, true);
  const request = await seedRequest(f.manager);
  assert.equal(request.created, true);
  const controller = new AbortController();
  f.manager.friendReviewControllers.set(opportunity.opportunity.id, controller);

  assert.equal(f.manager.deleteIdentityAsset('123456'), true);
  assert.equal(controller.signal.aborted, true, '在途好友评估必须被 abort');

  const again = await seedRequest(f.manager, '123456', 'flag-2');
  assert.equal(again.ignored, true);
  assert.equal(again.reason, 'person-deleted');

  await assert.rejects(
    f.manager.decideIncomingFriendRequest(request.request.id, 'approve', {
      decidedBy: '900001'
    }),
    /已处理：cancelled|人物资产已被删除/
  );
  assert.deepEqual(f.whitelisted, []);

  assert.equal(await f.manager.markFriendAdded('123456'), 0);
  assert.deepEqual(f.whitelisted, [], 'friend_add 事件不能把删除的人重新加白');
});

test('审批与删除竞态：协议端已同意但本地已删，只取消本地记录、不加白', async (t) => {
  let managerRef = null;
  const f = await fixture(t, {
    onCall: async (action) => {
      if (action === 'set_friend_add_request') {
        managerRef.deleteIdentityAsset('123456');
      }
    }
  });
  managerRef = f.manager;
  seedPerson(f.manager);
  const request = await seedRequest(f.manager);

  const result = await f.manager.decideIncomingFriendRequest(
    request.request.id,
    'approve',
    { decidedBy: '900001' }
  );
  assert.equal(result.request.status, 'cancelled');
  assert.equal(result.request.cancelReason, 'person-deleted');
  assert.equal(result.request.whitelistApplied, false);
  assert.match(result.note, /人物资产已被删除/);
  assert.deepEqual(f.whitelisted, [], '删除后的批准绝不能调用 allowPrivateUser');
});

test('启动重排：旧 accepted 账本也不能把已删人物补回白名单', async (t) => {
  const f = await fixture(t);
  seedPerson(f.manager);
  // 模拟老版本留下的 accepted 行：删除事务没来得及取消（升级前就存在）。
  f.manager.identityStore.db.prepare(`
    INSERT INTO incoming_friend_requests (
      id, request_flag, uin, status, created_at, updated_at
    ) VALUES ('ifr_legacy_accepted', 'flag-legacy', '123456', 'accepted', 1, 1)
  `).run();
  assert.equal(f.manager.deleteIdentityAsset('123456'), true);

  // 老数据：accepted 行被删除事务改成 cancelled 后，重排依然不能加白。
  // 再手动塞一条 accepted，专门验证 #syncKnownFriendWhitelists 的墓碑守卫。
  f.manager.identityStore.db.prepare(`
    INSERT INTO incoming_friend_requests (
      id, request_flag, uin, status, created_at, updated_at
    ) VALUES ('ifr_legacy_again', 'flag-legacy-2', '123456', 'accepted', 1, 1)
  `).run();
  f.manager.onebot.call = async () => [{ user_id: '123456', nickname: '人物甲' }];
  await f.manager.reindex();
  assert.deepEqual(f.whitelisted, [], '墓碑存在时启动/重排同步必须跳过');
});
