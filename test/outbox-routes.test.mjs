// 控制台 unknown 路由：批量核对的范围校验、逐条审计、effect 账本同步。
// store 行为在 store.test.mjs 里测；这里只锚路由层容易回归的编排。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerOutboxRoutes } from '../src/console/routes/outbox.js';

function harness(body, { singleResult = null } = {}) {
  const routes = [];
  const calls = { list: [], reconcile: [], single: [], audit: [], emit: [] };
  const store = {
    listUnknownOperations: (...args) => { calls.list.push(args); return [{ id: 'op1' }]; },
    unknownSummary: () => ({ total: 1, oldestAgeMs: 3_600_000 }),
    reconcileUnknownRows: (options) => {
      calls.reconcile.push(options);
      return {
        reconciled: 1,
        remaining: 0,
        operations: [{ operationId: 'op1', runId: 'run1', chatKey: 'group:1', result: 'sent', remaining: 0 }]
      };
    },
    reconcileUnknownOperation: (...args) => { calls.single.push(args); return singleResult; }
  };
  const effects = { settle: () => true, resolve: () => true };
  const router = { add: (method, pattern, handler) => routes.push({ method, pattern, handler }) };
  registerOutboxRoutes(router, {
    json: (res, status, payload) => { res.status = status; res.payload = payload; },
    readBody: async () => body,
    store,
    effects,
    auditWrite: (...args) => calls.audit.push(args),
    emit: (...args) => calls.emit.push(args)
  });
  const invoke = async (method, pathname) => {
    const pathOnly = pathname.split('?')[0];
    const route = routes.find((item) => item.method === method && item.pattern.test(pathOnly));
    assert.ok(route, `缺少路由 ${method} ${pathname}`);
    const res = {};
    const match = pathOnly.match(route.pattern);
    await route.handler({}, res, match, new URL(`http://127.0.0.1${pathname}`));
    return res;
  };
  return { calls, invoke };
}

test('批量核对：没有 ids/olderThanDays/all 一律拒绝，不能误清整个会话', async () => {
  const { calls, invoke } = harness({ result: 'sent', confirm: true });
  const res = await invoke('POST', '/api/chats/group_1/unknown-operations/reconcile');
  assert.equal(res.status, 409);
  assert.equal(calls.reconcile.length, 0, '范围不明确的请求不能落到 store');
});

test('批量核对：按选中 id 执行，逐条写审计并同步 effect 账本', async () => {
  const { calls, invoke } = harness({ result: 'sent', confirm: true, ids: ['op1'] });
  const res = await invoke('POST', '/api/chats/group_1/unknown-operations/reconcile');
  assert.equal(res.status, 200);
  assert.equal(res.payload.reconciled, 1);
  assert.deepEqual(calls.reconcile[0], {
    chatKey: 'group:1', ids: ['op1'], result: 'sent', before: 0, limit: 500
  });
  assert.equal(calls.audit.length, 1, '每条核对结果都要留审计');
  assert.equal(calls.audit[0][0], 'outbox.reconcile');
  assert.equal(calls.audit[0][2].after.batch, true);
  assert.deepEqual(calls.emit[0], ['chat-update', 'group:1']);
});

test('列表：olderThanDays 转成毫秒过滤，并返回会话摘要', async () => {
  const { calls, invoke } = harness({});
  const res = await invoke('GET', '/api/chats/group_1/unknown-operations?olderThanDays=2&limit=50');
  assert.equal(res.status, 200);
  assert.equal(res.payload.summary.total, 1);
  const args = calls.list[0];
  assert.equal(args[1], 50);
  assert.equal(args[2].olderThanMs, 2 * 86_400_000);
});

test('单条核对：不属于 URL 会话的记录按 404 处理', async () => {
  const { invoke } = harness({ result: 'sent', confirm: true });
  const res = await invoke('POST', '/api/chats/group_2/unknown-operations/op1/reconcile');
  assert.equal(res.status, 404, 'store 返回 null/其他会话时不能假装成功');
});

test('单条核对：把 URL 会话作为 chatKey 传给 store，store 返回别的会话时仍 404', async () => {
  const ok = harness({ result: 'sent', confirm: true }, {
    singleResult: { operationId: 'op1', runId: 'run1', chatKey: 'group:1', result: 'sent', remaining: 0 }
  });
  const res = await ok.invoke('POST', '/api/chats/group_1/unknown-operations/op1/reconcile');
  assert.equal(res.status, 200);
  assert.deepEqual(ok.calls.single[0], ['op1', 'sent', 'group:1']);
  assert.deepEqual(ok.calls.emit[0], ['chat-update', 'group:1']);

  const wrong = harness({ result: 'sent', confirm: true }, {
    singleResult: { operationId: 'op1', runId: 'run1', chatKey: 'group:2', result: 'sent', remaining: 0 }
  });
  const denied = await wrong.invoke('POST', '/api/chats/group_1/unknown-operations/op1/reconcile');
  assert.equal(denied.status, 404);
  assert.equal(wrong.calls.audit.length, 0, '未通过的核对不能留成功审计');
});

test('olderThanDays 非有限数字（Infinity/NaN）在列表与批量核对都按 400 拒绝', async () => {
  const list = harness({});
  assert.equal((await list.invoke('GET', '/api/chats/group_1/unknown-operations?olderThanDays=Infinity')).status, 400);
  assert.equal((await list.invoke('GET', '/api/chats/group_1/unknown-operations?olderThanDays=abc')).status, 400);
  assert.equal((await list.invoke('GET', '/api/chats/group_1/unknown-operations?olderThanDays=3651')).status, 400);
  assert.equal(list.calls.list.length, 0, '非法范围不能落到 store');

  const batch = harness({ result: 'sent', confirm: true, all: true, olderThanDays: Infinity });
  assert.equal((await batch.invoke('POST', '/api/chats/group_1/unknown-operations/reconcile')).status, 400);
  assert.equal(batch.calls.reconcile.length, 0);
});
