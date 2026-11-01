// 会话快照 / 会话列表 / 暂停恢复 路由（从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// `/api/models` 也在这个连续块里：它原本就注册在 sessions 前面，保持原位。
// 注意：`/api/sessions/:id` 在 app.js 更靠后的位置，不在这里，路由顺序不能动。
import { listModels } from '../../llm/llm.js';
import { timeControlState } from '../../core/time-control.js';

export function registerSessionRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const emit = deps.emit;
  const getConfig = deps.getConfig;
  const sessions = deps.sessions;
  const store = deps.store;
  const orchestrator = deps.orchestrator;
  const buildSessionView = deps.buildSessionView;
  const getIncidentPilot = deps.getIncidentPilot;
  const getSlangPilot = deps.getSlangPilot;
  if (!router || !json || !readBody || !emit || !getConfig || !sessions || !store
    || !orchestrator || !buildSessionView || !getIncidentPilot || !getSlangPilot) {
    throw new Error('registerSessionRoutes 需要 router/json/readBody/emit/getConfig/sessions/store/orchestrator/buildSessionView/getter');
  }

  router.add('GET', '/api/models', async (req, res) => {
    try {
      const models = await listModels();
      return json(res, 200, { models });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/sessions', async (req, res, params, url) => {
    // 单次最多 2000 条；支持 offset 游标，避免控制台一次拉走全部历史。
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
    const now = Date.now();
    const threadCache = new Map();
    const rows = sessions.listSummaries(offset + limit).slice(offset);
    return json(res, 200, {
      sessions: rows.map((session) => buildSessionView(session, store, { now, threadCache })),
      offset,
      limit,
      nextOffset: offset + rows.length,
      hasMore: rows.length >= limit
    });
  });
  router.add('GET', '/api/chats', async (req, res) => {
    const cfgNow = getConfig();
    const incidentPilot = getIncidentPilot();
    const chats = store.listChats().map((key) => {
      const meta = store.getChatMeta(key);
      return {
        key,
        ...meta,
        lastDecision: orchestrator.decisionFor(key),
        incidentControl: incidentPilot?.getChatControl(key) || null,
        incidentDecision: incidentPilot?.chatDecision(key, meta) || null,
        ...(cfgNow.timeControl?.enabled
          ? { timeControl: timeControlState(cfgNow.timeControl, key) } : {})
      };
    })
      .sort((a, b) => b.lastTs - a.lastTs);
    // 附带群名，让 UI 能显示"群名（群号）"。
    // 群名要调 OneBot 拿，可能慢或失败 —— 用 allSettled 保证绝不影响主流程：
    // 拿不到的 chatName 为空，UI 自动退回只显示群号。
    await Promise.allSettled(chats.map(async (c) => {
      const m = /^group:(\d+)$/.exec(String(c.key || ''));
      if (!m) { c.chatName = ''; return; }
      try {
        c.chatName = await Promise.race([
          orchestrator.getChatName(m[1]),
          new Promise((resolve) => setTimeout(() => resolve(''), 3000))   // 3s 超时保护
        ]) || '';
      } catch { c.chatName = ''; }
    }));
    return json(res, 200, { chats });
  });
  router.add('POST', '/api/pause', async (req, res) => {
    const body = await readBody(req);
    const wasPaused = orchestrator.paused;
    orchestrator.setPaused(!!body.paused);
    if (body.paused) getSlangPilot()?.abortResearch('机器人已暂停');
    else getSlangPilot()?.resumeQueued();
    if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
      // 恢复时自动补处理暂停期间积压的未读消息
      orchestrator.drainBacklogAfterResume();
    }
    return json(res, 200, { ok: true, paused: orchestrator.paused });
  });
  router.add('DELETE', '/api/pause', async (req, res) => {
    orchestrator.setPaused(false);
    getSlangPilot()?.resumeQueued();
    const marked = {};
    for (const chatKey of store.listChats()) {
      const n = store.drainUnread(chatKey).length;
      if (n > 0) marked[chatKey] = n;
    }
    emit('chat-update', '*');
    return json(res, 200, { ok: true, paused: false, marked });
  });
}
