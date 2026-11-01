// 人设模板（内置 + 自定义）与换人设后的交接清理路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// PERSONAS / normalizeBehaviorProfile 用动态 import：人设模块较大，只在打开设置页时才加载。
export function registerPersonaRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const updateConfig = deps.updateConfig;
  const keyEndpointAllowed = deps.keyEndpointAllowed;
  const store = deps.store;
  const memory = deps.memory;
  const orchestrator = deps.orchestrator;
  const log = deps.log;
  if (!router || !json || !readBody || !getConfig || !updateConfig || !keyEndpointAllowed
    || !store || !memory || !orchestrator || !log) {
    throw new Error('registerPersonaRoutes 依赖不完整');
  }

  router.add('GET', '/api/persona-templates', async (req, res) => {
    const { PERSONAS } = await import('../../personas.js');
    const builtins = Object.entries(PERSONAS).map(([id, p]) => ({
      id, name: p.name, text: p.text, behaviorProfile: p.behaviorProfile || 'legacy', builtin: true
    }));
    const customs = (getConfig().customPersonas || []).map((p, i) => ({
      id: `custom_${i}`,
      name: p.name,
      text: p.text,
      customRules: p.customRules || '',
      behaviorProfile: p.behaviorProfile || 'legacy',
      builtin: false
    }));
    return json(res, 200, { templates: [...builtins, ...customs] });
  });
  router.add('POST', '/api/persona-templates', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const name = String(body.name ?? '').trim().slice(0, 50);
    const text = String(body.text ?? '').trim();
    if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
    const { normalizeBehaviorProfile } = await import('../../personas.js');
    let behaviorProfile;
    try {
      behaviorProfile = normalizeBehaviorProfile(body.behaviorProfile);
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
    // customRules 允许为空
    const entry = { name, text, behaviorProfile };
    if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
    const next = [...(getConfig().customPersonas || []), entry];
    updateConfig({ customPersonas: next });
    return json(res, 200, { ok: true, templates: next });
  });
  router.add('POST', '/api/persona/reset-handoffs', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    const body = await readBody(req).catch(() => ({}));
    // 破坏性操作统一 confirm 门槛（与删表情/删记忆那批接口同款）
    if (body?.confirm !== true) {
      return json(res, 409, { error: '清空交接是破坏性操作：请带 confirm=true 再调用（控制台按钮已带）' });
    }
    // 范围要含"只有交接、还没有聊天记录"的会话（记忆目录里可能有 group_*/private_*）
    const chats = [...new Set([...store.listChats(), ...(memory.listChats?.() || [])])];
    let closed = 0;
    for (const chatKey of chats) {
      try { memory.clearHandoff(chatKey); } catch { /* 单个会话失败不阻断其余 */ }
      try { if (store.closeConversationThread(chatKey, 'persona-changed')) closed += 1; } catch { /* 没有线程就跳过 */ }
    }
    // 在途运行会在结束时把"它那一轮"的交接写回来（那一轮用的是换卡前的提示词）：
    // 明确告诉调用方，必要时过一会儿再点一次（2026-09-27 审查 P2）
    const runs = Number(orchestrator?.activeRuns?.size ?? 0) || 0;   // chatKey -> sessionId
    log(`[persona] 换了人设：已清空 ${chats.length} 个会话的交接与线程状态`
      + (runs > 0 ? `（另有 ${runs} 个运行进行中，结束后会写回它们那轮的交接，可稍后再清一次）` : ''));
    return json(res, 200, {
      ok: true,
      chats: chats.length,
      threadsClosed: closed,
      activeRuns: runs,
      note: runs > 0 ? '有正在进行的会话：它们结束时会写回换卡前那轮的交接，建议过几分钟再清一次' : ''
    });
  });
}
