// 记忆搜索 / 记忆文件（群记忆、交接、成员印象）路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// 破坏性删除一律 confirm 门槛；整理动作异步入队，进度通过 memory-update 事件回报。
import { idList } from '../../core/list.js';

export function registerMemoryRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const memory = deps.memory;
  const orchestrator = deps.orchestrator;
  const emit = deps.emit;
  if (!router || !json || !readBody || !getConfig || !memory || !orchestrator || !emit) {
    throw new Error('registerMemoryRoutes 需要 router/json/readBody/getConfig/memory/orchestrator/emit');
  }

  router.add('GET', '/api/memory/search', async (req, res, params, url) => {
    const query = String(url.searchParams.get('query') || '').trim().slice(0, 120);
    if (!query) return json(res, 400, { ok: false, error: 'query 不能为空' });
    const chatKey = String(url.searchParams.get('chatKey') || '').trim();
    if (chatKey && !/^(group|private):\d+$/.test(chatKey)) {
      return json(res, 400, { ok: false, error: 'chatKey 格式错误' });
    }
    const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 8));
    try {
      const found = memory.search(chatKey, query, { limit });
      return json(res, 200, {
        ok: true,
        query,
        chatKey,
        total: found.total,
        mode: found.index?.available ? 'fts5' : 'fallback',
        results: (found.results || []).map(({ sourceChatKeys: _sources, ...entry }) => entry)
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message || error) });
    }
  });

  router.add('GET', '/api/memory-files', async (req, res) => {
    const files = memory.listChats().map((chatKey) => {
      const members = memory.members(chatKey);
      const handoff = memory.getHandoff(chatKey);
      const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
      return {
        chatKey,
        impressionCount,
        memberCount: members.length,
        hasHandoff: Boolean(handoff),
        handoffExpiresAt: handoff?.expiresAt || 0,
        updatedAt: Math.max(
          Number(handoff?.updatedAt) || 0,
          0,
          ...members.map((m) => Number(m.updatedAt) || 0)
        )
      };
    });
    // 白名单里的群没有记忆也要显示
    const seen = new Set(files.map((f) => f.chatKey));
    // 补上白名单里还没有记忆的会话（缺字段也要有默认值，前端统一处理）
    for (const gid of idList(getConfig().allow?.groups)) {
      const key = `group:${String(gid)}`;
      if (!seen.has(key)) {
        files.push({
          chatKey: key, impressionCount: 0, memberCount: 0,
          hasHandoff: false, handoffExpiresAt: 0, updatedAt: 0, consolidating: false
        });
      }
    }
    for (const uid of idList(getConfig().allow?.private)) {
      const key = `private:${String(uid)}`;
      if (!seen.has(key)) {
        files.push({
          chatKey: key, impressionCount: 0, memberCount: 0,
          hasHandoff: false, handoffExpiresAt: 0, updatedAt: 0, consolidating: false
        });
      }
    }
    // 带上"正在整理"状态：切页签后前端靠它恢复提示，
    // 否则用户切走再切回，完全看不出整理是在跑还是已经中断。
    const busy = orchestrator.consolidating;
    for (const f of files) f.consolidating = busy.has(f.chatKey);
    files.sort((a, b) => b.updatedAt - a.updatedAt);
    return json(res, 200, { files, consolidating: [...busy], stats: memory.stats() });
  });
  router.add('POST', '/api/memory-files/consolidate', async (req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const chatKey = String(body.chatKey || '');
      if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });

      // 可选：只整理指定的群友（QQ 号数组）。不传 = 整理全群。
      // 传了但记忆里还没有此人时，会从聊天记录里新建印象。
      let userIds = null;
      if (body.userIds != null) {
        const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
        userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
        if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
      }
      // 手动触发：跳过门槛/冷却检查，且对零印象的人启用"新建印象"模式
      const force = body.force !== false;

      if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
      orchestrator.consolidating.add(chatKey);
      emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
      orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
        .then((result) => {
          emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) });
        })
        .catch((error) => {
          emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) });
        })
        .finally(() => orchestrator.consolidating.delete(chatKey));
      return json(res, 202, { ok: true, started: true });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('GET', /^\/api\/memory-files\/(group|private)_(\d+)$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    return json(res, 200, {
      ...memory.query(chatKey),
      members: memory.members(chatKey),
      handoff: memory.getHandoff(chatKey)
    });
  });
  router.add('PUT', /^\/api\/memory-files\/(group|private)_(\d+)\/handoff$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const body = await readBody(req).catch(() => ({}));
    try {
      const handoff = memory.setHandoff(chatKey, body, { sourceSessionId: 'console' });
      emit('memory-update', { chatKey, phase: handoff ? 'handoff-update' : 'handoff-clear' });
      return json(res, 200, { ok: true, handoff });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/memory-files\/(group|private)_(\d+)\/handoff$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    memory.clearHandoff(chatKey);
    emit('memory-update', { chatKey, phase: 'handoff-clear' });
    return json(res, 200, { ok: true });
  });
  router.add('DELETE', /^\/api\/memory-files\/global\/members\/(\d{1,15})$/, async (req, res, params) => {
    // 破坏性操作统一 confirm 门槛（与全站口径一致）：global 版跨所有会话删除。
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '删除人物记忆需要 body.confirm === true' });
    const content = String(body?.content ?? '').trim();
    // 带 content = 只删这一条；不带 = 删除这个人的全部印象（原有语义）。
    const removed = content
      ? memory.remove('', 'memberImpression', { userId: params[1], content })
      : memory.removeMember('', params[1]);
    emit('memory-update', { chatKey: '' });
    return json(res, 200, { ok: true, removed });
  });
  router.add('PUT', /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const body = await readBody(req).catch(() => ({}));
    try {
      const member = memory.editMemberImpression(chatKey, {
        userId: params[3],
        name: String(body.name ?? ''),
        // 只在显式传了 note 时才动备注：缺席＝保留现值（省略即删除会把称呼静默清掉，2026-10-13 审查）
        ...(Object.prototype.hasOwnProperty.call(body, 'note') ? { note: body.note ?? '' } : {}),
        impressions: body.impressions ?? []
      });
      emit('memory-update', { chatKey });
      return json(res, 200, { ok: true, member });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/, async (req, res, params) => {
    // 同上：删除成员印象也要 confirm（该路径的快照对 name-only 成员缺位，误删更难恢复）。
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '删除成员印象需要 body.confirm === true' });
    const chatKey = `${params[1]}:${params[2]}`;
    memory.removeMember(chatKey, params[3]);
    emit('memory-update', { chatKey });
    return json(res, 200, { ok: true });
  });

}
