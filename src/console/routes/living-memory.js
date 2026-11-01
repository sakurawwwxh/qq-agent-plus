// 长期语义记忆路由（从 console/app.js 拆出，2026-10-31 结构整治 M1）。
// 数据与向量服务归 LivingMemoryRuntime 所有；这里只做 HTTP 包装与参数校验。

const livingMemoryScopes = (values) => [...new Set((Array.isArray(values) ? values : [values])
  .map((value) => String(value || '').trim())
  .filter((value) => /^(group|private):\d+$/.test(value) || value === 'owner-global'))];

export function registerLivingMemoryRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const livingMemory = deps.livingMemory;
  const emit = deps.emit;
  const auditWrite = deps.auditWrite;
  if (!router || !json || !readBody || !getConfig || !livingMemory || !emit || !auditWrite) {
    throw new Error('registerLivingMemoryRoutes 需要 router/json/readBody/getConfig/livingMemory/emit/auditWrite');
  }

  router.add('GET', '/api/living-memory/status', async (req, res) => {
    try {
      const status = await livingMemory.status();
      return json(res, 200, { ok: true, config: getConfig().livingMemory || {}, status });
    } catch (error) {
      // 服务暂未部署/令牌未配不是控制台 500：页面要能显示配置并解释为什么不可用。
      return json(res, 200, { ok: true, config: getConfig().livingMemory || {}, status: { ok: false, error: String(error?.message ?? error) } });
    }
  });
  router.add('GET', '/api/living-memory/memories', async (req, res, params, url) => {
    const scopes = livingMemoryScopes(url.searchParams.getAll('scopeKey'));
    if (!scopes.length) return json(res, 400, { ok: false, error: '至少提供一个 scopeKey' });
    try {
      const result = await livingMemory.list({
        scopeKeys: scopes,
        status: url.searchParams.get('status') || '',
        type: url.searchParams.get('type') || '',
        query: url.searchParams.get('query') || '',
        limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50)),
        offset: Math.max(0, Number(url.searchParams.get('offset')) || 0)
      });
      return json(res, 200, result);
    } catch (error) { return json(res, 502, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('POST', '/api/living-memory/recall-test', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const chatKey = String(body.chatKey || '').trim();
    if (!/^(group|private):\d+$/.test(chatKey) && chatKey !== 'owner-global') return json(res, 400, { ok: false, error: 'chatKey 格式错误' });
    const query = String(body.query || '').trim();
    if (!query) return json(res, 400, { ok: false, error: '请输入测试问题或关键词' });
    try {
      const result = await livingMemory.recallTest({ chatKey, query, limit: body.limit });
      return json(res, 200, { ok: true, ...result });
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('POST', '/api/living-memory/memories', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const scopeKey = String(body.scopeKey || '').trim();
    if (!livingMemoryScopes([scopeKey]).length) return json(res, 400, { ok: false, error: 'scopeKey 格式错误' });
    // 白名单而不是展开请求体：allowSensitive / status / 任意未知键都不能从控制台绕过服务端策略。
    const payload = {
      scopeKey,
      type: body.type,
      summary: body.summary,
      content: body.content,
      importance: body.importance,
      confidence: body.confidence,
      tags: body.tags,
      entities: body.entities,
      relations: body.relations,
      source: { origin: 'manual-console', createdAt: Date.now() }
    };
    try {
      const result = await livingMemory.create(payload);
      emit('living-memory-update', { chatKey: scopeKey, phase: 'manual-create', memoryId: result?.memory?.id || '' });
      auditWrite('living-memory.create', `living-memory:${scopeKey}`, { req, type: payload.type || 'episode' });
      return json(res, 201, result);
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('GET', /^\/api\/living-memory\/memories\/([0-9A-Za-z-]+)$/, async (req, res, params) => {
    try { return json(res, 200, await livingMemory.get(params[1])); }
    catch (error) { return json(res, 404, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('DELETE', /^\/api\/living-memory\/memories\/([0-9A-Za-z-]+)$/, async (req, res, params) => {
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '删除长期记忆需要 body.confirm === true' });
    try {
      const result = await livingMemory.remove(params[1]);
      auditWrite('living-memory.delete', `living-memory:${params[1]}`, { req });
      emit('living-memory-update', { phase: 'delete', memoryId: params[1] });
      return json(res, 200, result);
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('POST', /^\/api\/living-memory\/memories\/([0-9A-Za-z-]+)\/archive$/, async (req, res, params) => {
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '归档长期记忆需要 body.confirm === true' });
    try {
      const result = await livingMemory.archive(params[1]);
      auditWrite('living-memory.archive', `living-memory:${params[1]}`, { req });
      emit('living-memory-update', { phase: 'archive', memoryId: params[1] });
      return json(res, 200, result);
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('POST', /^\/api\/living-memory\/memories\/([0-9A-Za-z-]+)\/restore$/, async (req, res, params) => {
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '恢复长期记忆需要 body.confirm === true' });
    try {
      const result = await livingMemory.unarchive(params[1]);
      auditWrite('living-memory.restore', `living-memory:${params[1]}`, { req });
      emit('living-memory-update', { phase: 'restore', memoryId: params[1] });
      return json(res, 200, result);
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('GET', '/api/living-memory/graph', async (req, res, params, url) => {
    const scopes = livingMemoryScopes(url.searchParams.getAll('scopeKey'));
    if (!scopes.length) return json(res, 400, { ok: false, error: '至少提供一个 scopeKey' });
    try {
      const result = await livingMemory.graph({
        scopeKeys: scopes,
        memoryId: String(url.searchParams.get('memoryId') || ''),
        limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 160))
      });
      return json(res, 200, result);
    } catch (error) { return json(res, 502, { ok: false, error: String(error?.message ?? error) }); }
  });
}
