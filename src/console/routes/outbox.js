// 会话 unknown 外发的查看 / 单条核对 / 批量核对路由（从 console/app.js 拆出）。
// 批量核对按行写审计：管理员一次操作可以清很多条，但每条都要能追溯到操作者与结果。
export function registerOutboxRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const store = deps.store;
  const effects = deps.effects;
  const auditWrite = deps.auditWrite;
  const emit = deps.emit;
  if (!router || !json || !readBody || !store || !effects || !auditWrite || !emit) {
    throw new Error('registerOutboxRoutes 需要 router/json/readBody/store/effects/auditWrite/emit');
  }

  const keyOf = (params) => `${params[1]}:${params[2]}`;
  const olderThanMs = (days) => {
    const n = Number(days);
    return Number.isFinite(n) && n > 0 ? Math.min(3650, n) * 86_400_000 : 0;
  };
  const validDays = (days) => {
    const n = Number(days);
    return Number.isFinite(n) && n >= 0 && n <= 3650;
  };

  // run_id 可能就是副作用账本的 effect id（日报/提醒等）：admin 核对完 outbox 后
  // 账本同步改判，否则「未知写入」标了已发送、日报仍显示 unknown 甚至会被强制重发。
  // 只在该 run 的所有未知行都核对完、且确认"已发送"时同步账本：
  // 标 sent 是保守方向（宁可不去重发，也不重复发）；标 failed 交给日报的显式重试路径。
  const settleEffect = (operation, result) => {
    if (!operation.runId || operation.remaining !== 0 || result !== 'sent') return;
    try {
      // 账本可能停在 planned（发送后、结算前崩溃且 15 分钟内重启）或 unknown；
      // settle 处理 planned，resolve 处理 unknown，两者互补才能覆盖全部非终态。
      const settled = effects.settle(String(operation.runId), 'sent', {
        reason: 'outbox-reconcile', operationId: operation.operationId, resolvedBy: 'manual'
      });
      if (!settled) {
        effects.resolve(String(operation.runId), 'sent', {
          reason: 'outbox-reconcile', operationId: operation.operationId
        });
      }
    } catch { /* 账本改判失败不影响 outbox 核对结果 */ }
  };

  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/unknown-operations$/, async (req, res, params, url) => {
    const key = keyOf(params);
    const limit = Number(url?.searchParams?.get('limit')) || 100;
    const rawDays = url?.searchParams?.get('olderThanDays');
    const days = rawDays == null ? 0 : Number(rawDays);
    if (!validDays(days)) return json(res, 400, { error: 'olderThanDays 必须是 0–3650 的有限数字' });
    return json(res, 200, {
      operations: store.listUnknownOperations(key, limit, {
        olderThanMs: olderThanMs(days)
      }),
      summary: store.unknownSummary(key)
    });
  });

  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/unknown-operations\/([\w-]+)\/reconcile$/, async (req, res, params) => {
    const body = await readBody(req);
    if (body.confirm !== true || !['sent', 'failed'].includes(body.result)) {
      return json(res, 409, { error: '核对未知写入需要明确结果和确认' });
    }
    const key = keyOf(params);
    try {
      const result = store.reconcileUnknownOperation(params[3], body.result, key);
      if (!result || result.chatKey !== key) {
        return json(res, 404, { error: '未知写入不存在或已核对' });
      }
      settleEffect(result, body.result);
      auditWrite('outbox.reconcile', key, {
        req,
        after: { operationId: result.operationId, runId: result.runId || '', result: body.result, remaining: result.remaining }
      });
      emit('chat-update', key);
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });

  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/unknown-operations\/reconcile$/, async (req, res, params) => {
    const body = await readBody(req);
    if (body.confirm !== true || !['sent', 'failed'].includes(body.result)) {
      return json(res, 409, { error: '批量核对需要明确结果和确认' });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    const rawDays = body.olderThanDays;
    const days = rawDays == null ? 0 : Number(rawDays);
    if (!validDays(days)) {
      return json(res, 400, { error: 'olderThanDays 必须是 0–3650 的有限数字' });
    }
    // 没有明确范围就拒绝：避免一个字段缺失的请求把整个会话的 unknown 全标成同一结果。
    if (ids.length === 0 && !(days > 0) && body.all !== true) {
      return json(res, 409, { error: '批量核对需要 ids、olderThanDays 或 all=true 之一' });
    }
    const key = keyOf(params);
    try {
      const out = store.reconcileUnknownRows({
        chatKey: key,
        ids,
        result: body.result,
        before: days > 0 ? Date.now() - olderThanMs(days) : 0,
        limit: 500
      });
      for (const operation of out.operations) {
        settleEffect(operation, body.result);
        auditWrite('outbox.reconcile', key, {
          req,
          after: {
            operationId: operation.operationId,
            runId: operation.runId || '',
            result: body.result,
            remaining: operation.remaining,
            batch: true
          }
        });
      }
      emit('chat-update', key);
      return json(res, 200, {
        ok: true,
        reconciled: out.reconciled,
        remaining: out.remaining,
        operations: out.operations
      });
    } catch (error) {
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });
}
