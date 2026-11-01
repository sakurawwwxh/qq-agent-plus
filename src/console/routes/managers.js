// 群游戏 / 群日报 / 管理员早报 / 提醒 的控制台动作路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M2）。
// 这些管理器在 createApp 里都是 const，注册时值已存在，直接注入。
export function registerManagerRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const auditWrite = deps.auditWrite;
  const getConfig = deps.getConfig;
  const groupGame = deps.groupGame;
  const groupDigest = deps.groupDigest;
  const adminBriefing = deps.adminBriefing;
  const reminders = deps.reminders;
  if (!router || !json || !readBody || !auditWrite || !getConfig || !groupGame || !groupDigest || !adminBriefing) {
    throw new Error('registerManagerRoutes 需要 router/json/readBody/auditWrite/getConfig/各管理器');
  }

  router.add('POST', '/api/group-game/stop', async (req, res) => {
    // 管理员在控制台结束某一局（局跑歪/要收场时用）：与模型调 group_game stop 走同一入口
    const body = await readBody(req);
    const chatKey = String(body?.chatKey || '').trim();
    if (!/^group:[^:\s]+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 要写成 group:<群号>' });
    const out = await groupGame.stop(chatKey, '管理员在控制台结束');
    if (!out?.ok) return json(res, 404, { ok: false, error: out?.error || '这个群没有进行中的游戏' });
    return json(res, 200, { ok: true });
  });
  router.add('POST', '/api/group-digest/run', async (req, res) => {
    try {
      // 控制台手点是明确的人工重试：允许把"上次结果未知"改判后重发（自动补跑不会）
      const result = await groupDigest.runOnce({ forceUnknown: true });
      // 审计只留可核对的计数/状态，**不写生成的日报正文**（text 字段）
      auditWrite('group-digest.run', 'group-digest', {
        req,
        ok: true,
        after: {
          forced: true,
          skipped: result.skipped || '',
          results: (result.results || []).map((r) => ({
            chatKey: r.chatKey, ok: r.ok, skipped: r.skipped || '', chars: r.chars || 0,
            messages: r.messages || 0, error: r.error ? String(r.error).slice(0, 200) : ''
          }))
        }
      });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      auditWrite('group-digest.run', 'group-digest', {
        req, ok: false, error: String(error?.message ?? error).slice(0, 200)
      });
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/admin-briefing/run', async (req, res) => {
    try {
      const result = await adminBriefing.runOnce();
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/reminders', async (req, res) => {
    // 控制台的提醒管理页：待触发全量 + 最近完成的（fired/canceled/expired）。
    // 已完成的每个会话只保留最近几条（DONE_KEEP），这里再全局截断一次。
    if (!reminders) return json(res, 200, { ok: true, enabled: false, pending: [], recent: [] });
    const enabled = getConfig().reminders?.enabled !== false;
    const fmt = (it) => ({
      id: it.id, chatKey: it.chatKey, text: it.text, status: it.status || 'pending',
      at: it.at, createdAt: it.createdAt, finishedAt: it.finishedAt || null,
      // 归属（谁提的/提醒谁）：控制台列表要显示"谁请你提醒谁"（2026-10-10 反馈）
      from: String(it.createdBy || ''), to: String(it.targetName || ''),
      // 周期信息（v2.1）：kind 与下一次触发点（re-arm 后的 at 就是下一期）
      repeat: it.repeat?.kind || null
    });
    const pending = reminders.items
      .filter((it) => it.status === 'pending')
      .sort((a, b) => a.at - b.at)
      .map(fmt);
    const recent = reminders.items
      .filter((it) => it.status && it.status !== 'pending')
      .sort((a, b) => (b.finishedAt || b.at) - (a.finishedAt || a.at))
      .slice(0, 30)
      .map(fmt);
    return json(res, 200, { ok: true, enabled, pending, recent });
  });
  router.add('POST', '/api/reminders/cancel', async (req, res) => {
    // 管理员在控制台里取消：带 id + chatKey（与聊天里"算了别提醒了"同一存储操作）
    const body = await readBody(req);
    if (!reminders) return json(res, 400, { ok: false, error: '提醒功能不可用' });
    const hit = reminders.cancel({ id: String(body?.id || ''), chatKey: String(body?.chatKey || '') });
    if (!hit) return json(res, 404, { ok: false, error: '没找到这条待触发的提醒（可能已被触发或取消）' });
    return json(res, 200, { ok: true, canceled: hit.id });
  });
}
