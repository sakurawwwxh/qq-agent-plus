import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGroupId, resolveTargets } from '../src/admin/targets.js';

const GROUPS = [
  { group_id: 433397830, group_name: '测试群' },
  { group_id: 433397831, group_name: '另一个群' }
];

function fakeOnebot({ rows = GROUPS, throwList = false, groups } = {}) {
  return {
    selfId: '999',
    async call(action) {
      if (action !== 'get_group_list') throw new Error(`unexpected ${action}`);
      if (throwList) throw new Error('unsupported');
      return rows;
    },
    getGroupInfo: groups
  };
}

const cfg = { allow: { groups: ['433397830', '433397831'] }, deny: { groups: [] } };

test('群号/群名解析，带前导零也会规范化', async () => {
  const onebot = fakeOnebot();
  const byId = await resolveTargets({ input: ['group:0433397830'], cfg, onebot, store: { listChats: () => [] } });
  assert.deepEqual(byId, [{ chatKey: 'group:433397830', groupId: '433397830', name: '测试群' }]);
  assert.equal(normalizeGroupId('group:433397830'), '433397830');
  const byName = await resolveTargets({ input: ['测试群'], cfg, onebot, store: { listChats: () => [] } });
  assert.equal(byName[0].chatKey, 'group:433397830');
});

test('白名单只有一个群时，不写目标默认发到它', async () => {
  const one = await resolveTargets({
    input: [], cfg: { allow: { groups: ['433397830'] } }, onebot: fakeOnebot(), store: { listChats: () => [] }
  });
  assert.deepEqual(one.map((item) => item.chatKey), ['group:433397830']);
});

test('群名歧义/未知群/不在白名单/空白名单都明确拒绝', async () => {
  const ambiguous = [...GROUPS, { group_id: 433397832, group_name: '测试群' }];
  await assert.rejects(
    () => resolveTargets({ input: ['测试群'], cfg, onebot: fakeOnebot({ rows: ambiguous }), store: { listChats: () => [] } }),
    (error) => error.code === 'E_ADMIN_TARGET_AMBIGUOUS' && error.candidates.length === 2
  );
  await assert.rejects(
    () => resolveTargets({ input: ['不存在'], cfg, onebot: fakeOnebot(), store: { listChats: () => [] } }),
    (error) => error.code === 'E_ADMIN_TARGET_UNKNOWN'
  );
  await assert.rejects(
    () => resolveTargets({
      input: ['433399999'], cfg: { allow: { groups: ['433397830'] } }, onebot: fakeOnebot(), store: { listChats: () => [] }
    }),
    /不在 allow.groups/
  );
  await assert.rejects(
    () => resolveTargets({ input: ['433397830'], cfg: { allow: { groups: [] } }, onebot: fakeOnebot(), store: { listChats: () => [] } }),
    (error) => error.code === 'E_ADMIN_NO_TARGETS'
  );
});

test('机器人不在群里时拒绝；协议端不支持群列表时退回本地会话表', async () => {
  await assert.rejects(
    () => resolveTargets({
      input: ['433397831'], cfg: { allow: { groups: ['433397831'] } },
      onebot: fakeOnebot({ rows: GROUPS.slice(0, 1) }), store: { listChats: () => [] }
    }),
    /机器人不在这个群|无法确认机器人是否在这个群/
  );
  const fallback = await resolveTargets({
    input: ['433397830'], cfg, onebot: fakeOnebot({ throwList: true }),
    store: { listChats: () => ['group:433397830', 'private:10001'] }
  });
  assert.equal(fallback[0].chatKey, 'group:433397830');
});
