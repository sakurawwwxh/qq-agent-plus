// 会话（chats）运行时控制 / 消息 / 导出 / 唤醒 / 线程 / 试发 / 已读 路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// `/api/runtime` 也放这里：它与"观察/暂停"是同一个运行时开关，和 chats 紧挨着注册。
// 注意路由注册顺序：本模块整体替换原 app.js 中同一位置的连续块，顺序与快照一致。
import { conversationConfigForChat } from '../../core/config.js';
import { assertCanSend } from '../../core/access.js';
import { textWithQuote } from '../../core/util.js';

export function registerChatRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const emit = deps.emit;
  const log = deps.log;
  const store = deps.store;
  const orchestrator = deps.orchestrator;
  const sender = deps.sender;
  const onebot = deps.onebot;
  const updateConfig = deps.updateConfig;
  const groupDigest = deps.groupDigest;
  const adminBriefing = deps.adminBriefing;
  const getIncidentPilot = deps.getIncidentPilot;
  const getSlangPilot = deps.getSlangPilot;
  if (!router || !json || !readBody || !emit || !log || !store || !orchestrator || !sender
    || !onebot || !updateConfig || !groupDigest || !adminBriefing || !getIncidentPilot || !getSlangPilot) {
    throw new Error('registerChatRoutes 需要 router/json/readBody/emit/log/store/orchestrator/sender/onebot/updateConfig/管理器/getter');
  }

  router.add('POST', '/api/runtime', async (req, res) => {
    const body = await readBody(req);
    if (!['observe', 'active'].includes(body.mode)) return json(res, 400, { error: 'Invalid mode' });
    if (body.mode === 'active' && body.confirmExclusive !== true) {
      return json(res, 409, { error: 'Confirm that the old instance is disabled for these chats or use a different QQ account.' });
    }
    if (body.mode === 'observe') {
      for (const controller of orchestrator.controllers.values()) controller.abort(new Error('Run cancelled'));
      getSlangPilot()?.abortResearch('机器人已切换到观察模式');
    }
    if (body.skipBacklog === true) for (const key of store.listChats()) store.markAllRead(key);
    updateConfig({ runtime: { mode: body.mode } });
    // 观察/暂停会挡住日报/早报；切回 active 时立刻重排并补跑当天错过的（否则要等重启）。
    groupDigest.reconfigure();
    adminBriefing.reconfigure();
    if (body.mode === 'active') getSlangPilot()?.resumeQueued();
    emit('status', { mode: body.mode });
    return json(res, 200, { ok: true, mode: body.mode });
  });

  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/(retry-failed|resolve-held)$/, async (req, res, params) => {
    const body = await readBody(req);
    const key = `${params[1]}:${params[2]}`;
    if (body.confirm !== true) return json(res, 409, { error: 'Explicit confirmation required' });
    const count = params[3] === 'retry-failed' ? store.retryFailed(key) : store.resolveHeld(key);
    emit('chat-update', key);
    return json(res, 200, { ok: true, count });
  });
  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/runtime-control$/, async (req, res, params) => {
    const key = `${params[1]}:${params[2]}`;
    const meta = store.getChatMeta(key);
    const incidentPilot = getIncidentPilot();
    return json(res, 200, {
      control: incidentPilot?.getChatControl(key) || {
        chatKey: key, mode: 'auto', reason: '', version: 0
      },
      decision: incidentPilot?.chatDecision(key, meta) || {
        allowed: meta.held === 0,
        mode: 'legacy',
        effectiveState: meta.held > 0 ? 'blocked' : 'normal',
        reason: meta.held > 0 ? '存在发送结果待确认' : ''
      },
      unread: meta.unread,
      held: meta.held
    });
  });
  router.add('PUT', /^\/api\/chats\/(group|private)_(\d+)\/runtime-control$/, async (req, res, params) => {
    const incidentPilot = getIncidentPilot();
    if (!incidentPilot?.active) {
      return json(res, 409, { error: '异常处理实验当前未启用' });
    }
    const key = `${params[1]}:${params[2]}`;
    const body = await readBody(req);
    if (!['auto', 'blocked', 'continue'].includes(body.mode)) {
      return json(res, 400, { error: 'mode 必须是 auto、blocked 或 continue' });
    }
    if (body.mode === 'continue' && body.confirm !== true) {
      return json(res, 409, { error: '继续处理需要显式确认' });
    }
    const control = incidentPilot.setChatControl(key, {
      mode: body.mode,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      updatedBy: 'console'
    });
    const decision = orchestrator.enforceChatControl(key);
    let backlog = { action: 'keep', marked: 0, kept: store.unreadCount(key) };
    if (decision.allowed && body.backlogAction === 'discard') {
      backlog = { action: 'discard', marked: store.markAllRead(key), kept: 0 };
    } else if (decision.allowed && body.backlogAction === 'recent') {
      backlog = { action: 'recent', ...store.keepLatestPending(key) };
      if (backlog.kept > 0) orchestrator.scheduleWake(key, 0);
    }
    emit('chat-update', key);
    return json(res, 200, { ok: true, control, decision, backlog });
  });
  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/messages$/, async (req, res, params, url) => {
    const chatKey = `${params[1]}:${params[2]}`;
    // 服务端游标分页：默认 500，普通上限 2000。旧客户端传 limit=100000 仍然兼容，但会被封顶。
    const requested = Number(url.searchParams.get('limit'));
    const limit = Math.min(2000, Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : 500));
    const beforeId = Math.max(0, Number(url.searchParams.get('before')) || 0);
    const afterId = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const rows = store.recent(chatKey, { limit: limit + 1, beforeId, afterId });
    const hasMore = rows.length > limit;
    if (hasMore) {
      if (afterId) rows.pop(); else rows.shift();
    }
    const messages = rows.map((m) => ({
      id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
      // 与提示词同一套渲染：正文缺引用块时补上（回复 + 合并转发卡片那类记录）
      text: textWithQuote(m), self: m.self, read: m.read, reply: m.reply,
      media: m.media || []
    }));
    const meta = store.getChatMeta?.(chatKey) || {};
    return json(res, 200, {
      chatKey,
      messages,
      hasMore,
      nextBefore: messages.length ? Number(messages[0].id) || 0 : 0,
      nextAfter: messages.length ? Number(messages[messages.length - 1].id) || 0 : afterId,
      total: Number(meta.total) || 0
    });
  });
  // 全量导出：单独入口，流式写出，避免把十万条塞进控制台的一次响应。
  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/export$/, async (req, res, params, url) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const format = String(url.searchParams.get('format') || 'jsonl').toLowerCase() === 'csv' ? 'csv' : 'jsonl';
    const safeName = chatKey.replace(':', '_');
    const MAX_ROWS = 200000;
    res.writeHead(200, {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="${safeName}.${format}"`,
      'cache-control': 'no-store'
    });
    // 背压：大导出最多 20 万行，忽略 write 返回值会把剩余内容全缓存在进程内、
    // 并长时间占住事件循环（2026-10-31 复核 P2）。
    const writeChunk = (chunk) => {
      if (res.write(chunk)) return Promise.resolve();
      if (res.destroyed || res.writableEnded) return Promise.reject(new Error('客户端已断开'));
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          res.off('drain', onDrain);
          res.off('close', onClose);
        };
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); reject(new Error('客户端已断开')); };
        res.once('drain', onDrain);
        res.once('close', onClose);
      });
    };
    if (format === 'csv') await writeChunk('\uFEFFid,ts,senderId,senderName,self,text\n');
    // CSV 公式注入：群成员的昵称/正文以 = + - @ 开头时，Excel/WPS 会当公式执行。
    // 前置单引号后仍是可读文本，但不再可执行（2026-10-31 盲审 P2）。
    const csvCell = (value) => {
      let text = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    // 从最老一条开始正向分页：`afterId=0` 在 store.recent 里是"最新 N 条"，
    // 直接用它会让 >5000 条的会话只导出最近 5000 条、旧消息静默丢失（2026-10-31 盲审 P1）。
    let from = store.firstMessageId ? store.firstMessageId(chatKey) : 0;
    let wrote = 0;
    try {
      while (wrote < MAX_ROWS && from > 0) {
        const page = store.recent(chatKey, { fromId: from, limit: 5000 });
        if (!page.length) break;
        for (const message of page) {
          if (wrote >= MAX_ROWS) break;
          if (format === 'csv') {
            await writeChunk(`${csvCell(message.id)},${Number(message.ts) || 0},${csvCell(message.senderId)},`
              + `${csvCell(message.senderName)},${message.self ? 1 : 0},${csvCell(message.text)}
`);
          } else {
            await writeChunk(`${JSON.stringify({
              id: message.id,
              mid: message.mid,
              ts: message.ts,
              senderId: message.senderId,
              senderName: message.senderName,
              self: Boolean(message.self),
              text: message.text,
              reply: message.reply || null
            })}
`);
          }
          wrote += 1;
        }
        const lastId = Number(page[page.length - 1].id) || 0;
        if (!lastId) break;
        from = lastId + 1;
      }
    } catch (error) {
      log(`[export] ${chatKey} ${format} 中断：${String(error?.message ?? error)}`);
      return;
    }
    log(`[export] ${chatKey} ${format} ${wrote} 条`);
    res.end();
  });
  router.add('GET', /^\/api\/groups\/(\d+)\/members$/, async (req, res, params) => {
    try {
      const list = await onebot.call('get_group_member_list', { group_id: Number(params[1]) });
      const members = (Array.isArray(list) ? list : (list?.data ?? []))
        .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
        .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
      return json(res, 200, { members });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/wake$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const result = orchestrator.requestManualWake(chatKey);
    return json(res, result.ok ? 202 : 409, result);
  });
  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/thread$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    return json(res, 200, {
      chatKey,
      mode: conversationConfigForChat(chatKey).mode,
      thread: store.getConversationThread(chatKey),
      checkpoint: store.latestThreadCheckpoint(chatKey)
    });
  });
  router.add('DELETE', /^\/api\/chats\/(group|private)_(\d+)\/thread$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const closed = store.closeConversationThread(chatKey, 'operator');
    emit('chat-update', chatKey);
    return json(res, 200, { ok: true, closed });
  });
  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/test-send$/, async (req, res, params) => {
    const body = await readBody(req);
    const text = String(body.text ?? '').trim();
    if (!text) return json(res, 400, { error: '消息内容为空' });
    try {
      const chatKey = `${params[1]}:${params[2]}`;
      assertCanSend(chatKey);
      const decision = getIncidentPilot()?.chatDecision(chatKey, store.getChatMeta(chatKey));
      if (decision && !decision.allowed) {
        return json(res, 409, { error: decision.reason || '该会话当前被阻塞' });
      }
      const data = await sender.sendTextBatch(chatKey, [text]);
      emit('chat-update', chatKey);
      return json(res, 200, { ok: true, messageId: data.sent[0]?.messageId ?? null });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const drained = store.drainUnread(chatKey);
    return json(res, 200, { ok: true, marked: drained.length });
  });
}
