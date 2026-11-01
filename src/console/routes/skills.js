// 技能路由（从 console/app.js 拆出，2026-10-31 结构整治 M1）。
// 注意注册顺序：/api/skills/market* 必须在 /api/skills/:id 之前，
// 否则 GET /api/skills/market 会被 :id 路由抢先命中。
import { getSkillRegistry } from '../../skills/registry.js';
import { listMarketSkills, previewMarketSkill, installMarketSkill, uninstallMarketSkill, marketIndexUrl } from '../../skills/market.js';

export function registerSkillRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const updateConfig = deps.updateConfig;
  const auditWrite = deps.auditWrite;
  const emit = deps.emit;
  if (!router || !json || !readBody || !getConfig || !updateConfig || !auditWrite || !emit) {
    throw new Error('registerSkillRoutes 需要 router/json/readBody/getConfig/updateConfig/auditWrite/emit');
  }

  router.add('GET', '/api/skills', async (req, res) => {
    const registry = getSkillRegistry();
    const cfg = getConfig().skills || {};
    const known = new Set(registry.list().map((skill) => skill.id));
    const enabledIds = new Set((Array.isArray(cfg.enabledIds) ? cfg.enabledIds : [])
      .map((id) => String(id || '').trim()).filter((id) => known.has(id)));
    const staleEnabledIds = (Array.isArray(cfg.enabledIds) ? cfg.enabledIds : [])
      .map((id) => String(id || '').trim()).filter((id) => id && !known.has(id));
    const perChat = cfg.perChat && typeof cfg.perChat === 'object' ? cfg.perChat : {};
    return json(res, 200, {
      ok: true,
      enabled: cfg.enabled === true,
      enabledIds: [...enabledIds],
      staleEnabledIds,
      perChat,
      skills: registry.list().map((skill) => ({
        ...skill,
        enabled: enabledIds.has(skill.id),
        perChat: Object.fromEntries(Object.entries(perChat)
          .filter(([, ids]) => Array.isArray(ids) && ids.includes(skill.id))
          .map(([chatKey]) => [chatKey, true]))
      })),
      errors: registry.errors
    });
  });
  router.add('GET', '/api/skills/market', async (req, res, params, url) => {
    try {
      const result = await listMarketSkills({ force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, { ...result, indexUrl: marketIndexUrl() });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error), indexUrl: marketIndexUrl() });
    }
  });
  router.add('GET', '/api/skills/market/preview', async (req, res, params, url) => {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return json(res, 400, { ok: false, error: '缺少技能 id' });
    try { return json(res, 200, await previewMarketSkill(id, { full: url.searchParams.get('full') === '1' })); }
    catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('POST', '/api/skills/market/install', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const result = await installMarketSkill({
        id: body.id,
        expectedSha256: body.expectedSha256,
        confirm: body.confirm === true
      });
      auditWrite('skills.market.install', `skill:${result.skill?.id || body.id}`, { req, version: result.skill?.version || '', updated: result.updated === true });
      emit('skills-update', { phase: 'market-install', id: result.skill?.id || body.id });
      return json(res, 200, result);
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('POST', '/api/skills/market/uninstall', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const result = await uninstallMarketSkill({ id: body.id, confirm: body.confirm === true });
      auditWrite('skills.market.uninstall', `skill:${result.id}`, { req });
      emit('skills-update', { phase: 'market-uninstall', id: result.id });
      return json(res, 200, result);
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });

  router.add('GET', '/api/skills/:id', async (req, res, params) => {
    const registry = getSkillRegistry();
    const skill = registry.get(params.id);
    if (!skill) return json(res, 404, { ok: false, error: '技能不存在' });
    const cfg = getConfig().skills || {};
    const perChat = cfg.perChat && typeof cfg.perChat === 'object' ? cfg.perChat : {};
    return json(res, 200, {
      ok: true,
      skill: {
        ...skill,
        instructions: skill.instructions,
        enabled: (Array.isArray(cfg.enabledIds) ? cfg.enabledIds : []).includes(skill.id),
        perChat: Object.fromEntries(Object.entries(perChat)
          .filter(([, ids]) => Array.isArray(ids) && ids.includes(skill.id))
          .map(([chatKey]) => [chatKey, true]))
      }
    });
  });

  router.add('POST', '/api/skills/reload', async (req, res) => {
    const registry = getSkillRegistry();
    registry.reload();
    auditWrite('skills.reload', 'skills', { req, skills: registry.list().length, errors: registry.errors.length });
    return json(res, 200, { ok: true, skills: registry.list(), errors: registry.errors });
  });
  router.add('POST', '/api/skills/state', async (req, res) => {
    try {
      const body = await readBody(req);
      const registry = getSkillRegistry();
      const known = new Set(registry.list().map((skill) => skill.id));
      const enabled = body.enabled === true;
      const enabledIds = [];
      const seen = new Set();
      for (const raw of Array.isArray(body.enabledIds) ? body.enabledIds : []) {
        const id = String(raw || '').trim();
        if (!id || seen.has(id)) continue;
        // 技能目录被删除/manifest 变坏时，配置里可能还留着 id。这里丢掉而不是 400，
        // 否则 UI 没有对应的勾选框可取消，整页会永远保存失败。
        if (!known.has(id)) continue;
        seen.add(id);
        enabledIds.push(id);
      }
      const perChat = {};
      if (body.perChat && typeof body.perChat === 'object' && !Array.isArray(body.perChat)) {
        for (const [chatKey, ids] of Object.entries(body.perChat)) {
          if (!/^(group|private):\d+$/.test(chatKey) || !Array.isArray(ids)) continue;
          const list = [];
          for (const raw of ids) {
            const id = String(raw || '').trim();
            if (!id || !known.has(id)) continue;
            if (!list.includes(id)) list.push(id);
          }
          perChat[chatKey] = list;
        }
      }
      updateConfig({ skills: { enabled, enabledIds, perChat: { __replace__: perChat } } });
      auditWrite('skills.state', 'skills', { req, enabled, count: enabledIds.length, perChat: Object.keys(perChat).length });
      emit('skills-update', { enabled, enabledIds, perChat });
      return json(res, 200, { ok: true, enabled, enabledIds, perChat });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message || error) });
    }
  });
}
