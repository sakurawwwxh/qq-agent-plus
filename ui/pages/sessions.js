// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import { renderLifecycleOverview } from '../app.js';
import { api } from '../core/api.js';
import {
  CONVERSATION_MODE_LABEL, SESSION_PAGE, STATUS_LABEL, THREAD_STATE_LABEL
} from '../core/constants.js';
import { patchKeyedList, initSessionScrollLoader } from '../core/dom-util.js';
import { $, $$, esc } from '../core/dom.js';
import {
  chatNameOf, fmtClock, fmtRate, fmtTime, fmtTok, fmtTokens, fmtWaitRemain, fmtYuan, formatChatTitle,
  formatReleaseNotes
} from '../core/format.js';
import {
  lifecycleRemainingText, lifecycleRunsFor, lifecycleStateOf, triggerKindLabel
} from '../core/lifecycle-labels.js';
import { startLifecycleTicker, startWaitTicker, state } from '../core/state.js';
function sessionStatusText(s) {
  const base = STATUS_LABEL[s.status] || s.status;
  return s.conversationMode === 'lifecycle' && ['done', 'noreply'].includes(s.status)
    ? `本轮${base}`
    : base;
}

function conversationStatusText(s) {
  const mode = s.conversationMode || 'legacy';
  const modeLabel = CONVERSATION_MODE_LABEL[mode] || mode;
  const threadLabel = THREAD_STATE_LABEL[lifecycleStateOf(s)];
  return threadLabel ? `${modeLabel} · ${threadLabel}` : modeLabel;
}

function renderSessionModeBand(s) {
  const mode = ['legacy', 'threaded', 'lifecycle'].includes(s.conversationMode)
    ? s.conversationMode
    : 'legacy';
  const stateLabel = THREAD_STATE_LABEL[lifecycleStateOf(s)]
    || (mode === 'legacy' ? '单轮运行' : '尚未建立线程');
  const detail = mode === 'legacy'
    ? '本轮按响应档位独立触发'
    : mode === 'threaded'
      ? '当前参与者可在续接窗口内确定性唤醒'
      : '生命周期内的新消息批次继续交给模型判断';
  const threadRef = s.threadId ? `线程 ${String(s.threadId).slice(0, 8)}` : '无持续线程';
  return `
    <div class="session-mode-band mode-${mode}">
      <div class="session-mode-name">${esc(CONVERSATION_MODE_LABEL[mode])}</div>
      <div class="session-mode-state">${esc(stateLabel)}</div>
      <div class="session-mode-detail">${esc(detail)}</div>
      <div class="session-mode-ref">${esc(threadRef)}</div>
    </div>`;
}

function renderSessionThreadTimeline(s) {
  const mode = ['threaded', 'lifecycle'].includes(s.conversationMode)
    ? s.conversationMode
    : '';
  if (!mode || !s.threadId) return '';
  const runs = mode === 'lifecycle'
    ? lifecycleRunsFor(s)
    : (state.sessions || [])
      .filter((entry) =>
        entry.conversationMode === mode
        && entry.chatKey === s.chatKey
        && entry.threadId === s.threadId)
      .slice()
      .sort((a, b) => Number(a.startedAt) - Number(b.startedAt));
  if (!runs.length) return '';
  const totalTokens = runs.reduce((sum, run) => sum + (Number(run.usage?.totalTokens) || 0), 0);
  const totalCalls = runs.reduce((sum, run) => sum + (Number(run.usage?.calls) || 0), 0);
  const totalCost = runs.reduce(
    (sum, run) => sum + (Number(run.sessionMetrics?.estimatedCost) || 0),
    0
  );
  const title = mode === 'lifecycle' ? '生命周期批次' : '续接线程批次';
  return `
    <section class="thread-timeline mode-${mode}">
      <div class="thread-timeline-head">
        <div>
          <strong>${title}</strong>
          <span>${esc(s.threadId)}</span>
        </div>
        <span>${runs.length} 批 · ${totalCalls} 次调用 · ${fmtTokens(totalTokens)} · ${fmtYuan(totalCost)}</span>
      </div>
      <div class="thread-run-list">
        ${runs.map((run, index) => `
          <button type="button"
            class="thread-run${run.id === s.id ? ' active' : ''}"
            data-thread-session-id="${esc(run.id)}"
            title="${esc(`${triggerKindLabel(run)} · ${run.triggerReason || ''} · ${run.trigger || ''}`)}">
            <span>#${index + 1} · ${esc(triggerKindLabel(run))}</span>
            <strong>${fmtClock(run.startedAt)}</strong>
            <small>${esc(sessionStatusText(run))} · ${fmtYuan(run.sessionMetrics?.estimatedCost)}</small>
          </button>`).join('')}
      </div>
    </section>`;
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    // 最近 2000 条封顶：会话索引可能很大，前端再有筛选和分页渲染；不再一次拉 100 万条。
    const data = await api('/api/sessions?limit=2000');
    state.sessions = data.sessions || [];
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
      if (active) selectSession(active.id);
    }
    // 当前打开的会话在等待/运行中时，也顺手刷新详情
    if (state.currentSessionId) {
      const cur = state.sessions.find((s) => s.id === state.currentSessionId);
      if (cur && (cur.status === 'running' || cur.status === 'waiting')) {
        loadSessionDetail(state.currentSessionId, { quiet: true });
      }
    }
  } catch (e) {
    if (!quiet) {
      console.error(e);
      const more = $('#session-more');
      if (more) more.textContent = `会话加载失败：${e?.message || e}（稍后自动重试）`;
    }
  }
}

function buildSessionDisplayItems(sessions = []) {
  const items = [];
  const grouped = new Map();
  for (const session of sessions) {
    const mode = ['legacy', 'threaded', 'lifecycle'].includes(session.conversationMode)
      ? session.conversationMode
      : 'legacy';
    const groupable = mode !== 'legacy' && Boolean(session.threadId);
    const displayKey = groupable
      ? `thread:${mode}:${session.chatKey}:${session.threadId}`
      : `session:${session.id}`;
    let item = grouped.get(displayKey);
    if (!item) {
      item = {
        ...session,
        displayKey,
        latestSessionId: session.id,
        sessionIds: [],
        runCount: 0,
        totalRounds: 0,
        totalSearches: 0,
        estimatedCost: 0,
        originTriggerKind: session.triggerKind || '',
        originTriggerReason: session.triggerReason || '',
        originTriggerAt: Number(session.startedAt) || 0,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          calls: 0
        }
      };
      grouped.set(displayKey, item);
      items.push(item);
    }
    item.sessionIds.push(session.id);
    item.runCount += 1;
    item.totalRounds += Number(session.rounds) || 0;
    item.totalSearches += Number(session.webSearchCount) || 0;
    item.estimatedCost += Number(session.sessionMetrics?.estimatedCost) || 0;
    if (mode === 'lifecycle'
      && (!item.originTriggerAt || Number(session.startedAt) < item.originTriggerAt)) {
      item.originTriggerKind = session.triggerKind || '';
      item.originTriggerReason = session.triggerReason || '';
      item.originTriggerAt = Number(session.startedAt) || 0;
    }
    if (session.lifecycle?.isCurrent) {
      item.lifecycle = session.lifecycle;
      item.threadState = session.lifecycle.state;
    }
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'calls']) {
      item.usage[key] += Number(session.usage?.[key]) || 0;
    }
  }
  return items;
}

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 筛选控件是 index.html 的静态元素，绑一次即可；筛选变化时退回第一页。
  if (box && !box.__sessionFilterBound) {
    box.__sessionFilterBound = true;
    for (const selector of ['#session-search', '#session-filter-status', '#session-filter-mode']) {
      const el = $(selector);
      if (!el) continue;
      el.addEventListener(selector === '#session-search' ? 'input' : 'change', () => {
        state.sessionLimit = SESSION_PAGE;
        renderSessionList();
      });
    }
  }
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  const q = String($('#session-search')?.value || '').trim().toLowerCase();
  const status = String($('#session-filter-status')?.value || 'all');
  const modeFilter = String($('#session-filter-mode')?.value || 'all');
  const all = (state.sessions || []).filter((s) => {
    if (status !== 'all' && String(s.status || '') !== status) return false;
    if (modeFilter !== 'all' && String(s.conversationMode || 'legacy') !== modeFilter) return false;
    if (!q) return true;
    return `${s.chatKey || ''} ${chatNameOf(s.chatKey) || ''} ${s.trigger || ''} ${s.triggerSummary || ''} ${s.triggerReason || ''}`
      .toLowerCase().includes(q);
  });
  const displayItems = buildSessionDisplayItems(all);
  const shown = displayItems.slice(0, state.sessionLimit);
  const rest = displayItems.length - shown.length;
  const sessionRows = shown.map((s) => {
    const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
    const waitHtml = s.status === 'waiting' && s.waitUntil
      ? `<span class="session-wait" data-until="${Number(s.waitUntil)}">等待中 · ${fmtWaitRemain(Number(s.waitUntil))}</span>`
      : '';
    const activityHtml = s.status === 'running' && s.activity
      ? `<span class="session-activity">${esc(s.activity)}</span>`
      : '';
    const searchHtml = Number(s.totalSearches) > 0
      ? `<span class="muted">搜 ${s.totalSearches}</span>`
      : '';
    const mode = ['legacy', 'threaded', 'lifecycle'].includes(s.conversationMode)
      ? s.conversationMode
      : 'legacy';
    const isNew = !state.seenSessionIds.has(s.displayKey);
    const selected = s.sessionIds.includes(state.currentSessionId);
    const runLabel = s.runCount > 1 ? `${s.runCount} 批` : '';
    const triggerLabel = mode === 'lifecycle'
      ? triggerKindLabel({
          triggerKind: s.originTriggerKind,
          triggerReason: s.originTriggerReason
        })
      : triggerKindLabel(s);
    const lifecycle = mode === 'lifecycle' ? (s.lifecycle || {}) : null;
    const lifecycleState = lifecycle?.state || lifecycleStateOf(s);
    const lifecycleRemain = mode === 'lifecycle'
      ? `<span class="lifecycle-remaining" data-deadline="${Number(lifecycle?.deadline) || 0}" data-lifecycle-state="${esc(lifecycleState)}">${esc(lifecycleRemainingText(lifecycle?.deadline, lifecycleState))}</span>`
      : '';
    return `
      <div class="session-item mode-${mode} ${s.runCount > 1 ? 'session-thread-group' : ''} ${selected ? 'selected' : ''} ${s.status === 'waiting' ? 'session-waiting-row' : ''} ${isNew ? 'new-item' : ''}"
        data-id="${esc(s.latestSessionId)}" data-display-key="${esc(s.displayKey)}" role="button" tabindex="0">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger" title="${esc(`${triggerLabel}：${s.trigger || ''}`)}"><span class="trigger-method">${esc(triggerLabel)}</span><span>${esc(s.trigger || '')}${runLabel ? ` · ${runLabel}` : ''}</span></div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${esc(sessionStatusText(s))}</span>
          <span class="mode-chip mode-${mode}">${esc(conversationStatusText(s))}</span>
          ${s.persona ? `<span class="persona-chip" title="这次运行用的角色卡">人设 ${esc(s.persona)}</span>` : ''}
          ${lifecycleRemain}
          ${waitHtml}
          ${activityHtml}
          ${s.status !== 'waiting' ? `<span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span>${mode === 'lifecycle' ? `<span>${fmtYuan(s.estimatedCost)}</span>` : ''}<span>${s.totalRounds || 0} 模型轮</span>${searchHtml}</span>` : ''}
        </div>
      </div>`;
  }).map((html, index) => ({ key: String(shown[index].displayKey), html }));
  // exit: true —— 会话行被筛掉时先塔缩再移除（见 ui/core/dom-util.js 与 style.css 的 rowOut）
  patchKeyedList(box, sessionRows, 'data-display-key', { exit: true });
  // 底部提示：还有多少条没显示 / 已全部显示
  const more = $('#session-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更多（还有 ${rest} 条）`
      : (displayItems.length > SESSION_PAGE ? `已显示全部 ${displayItems.length} 个窗口` : '');
  }
  // 头部显示总数（已显示 / 总数），便于确认分页是否真的加载完了
  const cnt = $('#session-count');
  if (cnt) {
    cnt.textContent = all.length
      ? `${shown.length}/${displayItems.length} 个窗口 · ${all.length} 次运行`
      : '';
  }
  for (const s of displayItems) state.seenSessionIds.add(s.displayKey);
  $$('.session-item', box).forEach((el) => {
    if (el.__bound) return;      // 增量更新会保留旧行，别重复绑定
    el.__bound = true;
    const activate = () => selectSession(el.dataset.id);
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  });
  // 等待中会话的剩余时间按 0.1s 本地刷新（不重新拉列表）
  if ($$('.session-wait[data-until]', box).length) startWaitTicker();
  if ($$('.lifecycle-remaining[data-deadline]').length) startLifecycleTicker();
  // 「滚到底加载更多」的监听挂在这里，而不是 app.js 的 init 末尾：**首次启动时配置还没填好**
  // （没模型 / 没白名单）时 init 会提前 return 带去设置页，那一刻 #session-list 还不存在，
  // 监听就挂空了 —— 列表永远停在 50 条，底部却写着"还有 N 条"。
  // 渲染完就挂，与 init 走哪条分支无关；attachScrollLoader 自带防重复绑定。
  // （与 chat.js 里 initChatScrollLoader 的处理方式一致。）
  initSessionScrollLoader();
}

function updateSessionListSelection() {
  const selected = buildSessionDisplayItems(state.sessions || [])
    .find((item) => item.sessionIds.includes(state.currentSessionId));
  $$('.session-item', $('#session-items')).forEach((element) => {
    element.classList.toggle('selected', element.dataset.displayKey === selected?.displayKey);
  });
}

async function selectSession(id, { preserveDetail = false } = {}) {
  if (!id) return;
  const sessionView = $('#view-sessions');
  if (id === state.currentSessionId) {
    sessionView?.classList.add('mobile-detail-open');
    return;
  }
  const detail = $('#session-detail');
  const scrollTop = preserveDetail ? detail?.scrollTop ?? 0 : 0;
  const timelineScrollLeft = preserveDetail
    ? detail?.querySelector('.thread-run-list')?.scrollLeft ?? 0
    : 0;
  state.currentSessionId = id;
  sessionView?.classList.add('mobile-detail-open');
  state.sessionDetail = null;
  state.lastDetailFp = null;
  updateSessionListSelection();
  if (!preserveDetail && detail) {
    detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  }
  await loadSessionDetail(id, {
    scrollMode: preserveDetail ? 'preserve' : 'top',
    scrollTop,
    timelineScrollLeft
  });
}

async function loadSessionDetail(id, {
  quiet = false,
  scrollMode = null,
  scrollTop = null,
  timelineScrollLeft = null
} = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    if (state.currentSessionId !== id) return;
    state.sessionDetail = s;
    if (state.tab === 'sessions') {
      renderSessionDetail(s, { scrollMode, scrollTop, timelineScrollLeft });
    }
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function sessionInjectedMessages(s) {
  if (Array.isArray(s.injectedMessages)) return s.injectedMessages;
  const input = Array.isArray(s.inputMessages) ? s.inputMessages : [];
  return s.lifecycleContinuation && input.length > 2 ? input.slice(1, -1) : [];
}

function sessionModelRequest(s) {
  const options = s.inputRequestOptions || {};
  const tools = Array.isArray(s.inputTools) ? s.inputTools : [];
  return {
    model: s.model || '',
    messages: Array.isArray(s.inputMessages) ? s.inputMessages : [],
    ...(tools.length ? { tools, tool_choice: options.toolChoice || 'auto' } : {}),
    ...(Number.isFinite(Number(options.temperature))
      ? { temperature: Number(options.temperature) }
      : {})
  };
}

function sessionMetricsOf(s) {
  const usage = s.usage || {};
  const calls = Array.isArray(s.callUsage) ? s.callUsage : [];
  const supplied = s.sessionMetrics || {};
  const promptTokens = Number(supplied.promptTokens ?? usage.promptTokens) || 0;
  const completionTokens = Number(supplied.completionTokens ?? usage.completionTokens) || 0;
  const cachedTokens = Math.min(
    promptTokens,
    Number(supplied.cachedTokens ?? usage.cachedTokens) || 0
  );
  const first = calls[0] || {};
  const firstPromptTokens = Number(first.promptTokens) || 0;
  const firstCachedTokens = Math.min(
    firstPromptTokens,
    Number(first.cachedTokens) || 0
  );
  return {
    modelCalls: Number(supplied.modelCalls ?? usage.calls) || calls.length,
    firstCallCacheHitRate: Number.isFinite(Number(supplied.firstCallCacheHitRate))
      ? Number(supplied.firstCallCacheHitRate)
      : (firstPromptTokens ? firstCachedTokens / firstPromptTokens : 0),
    cacheHitRate: Number.isFinite(Number(supplied.cacheHitRate))
      ? Number(supplied.cacheHitRate)
      : (promptTokens ? cachedTokens / promptTokens : 0),
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: Number(supplied.totalTokens ?? usage.totalTokens)
      || promptTokens + completionTokens,
    toolCalls: Number(supplied.toolCalls)
      || (s.messages || []).filter((message) => message?.toolCall).length,
    webSearchCount: Number(supplied.webSearchCount ?? s.webSearchCount) || 0,
    estimatedCost: Number(supplied.estimatedCost) || 0
  };
}

function renderSessionContextInspector(s) {
  const tabs = ['injected', 'input', 'reasoning'];
  const active = tabs.includes(state.sessionInspectorTab) ? state.sessionInspectorTab : 'input';
  const injected = sessionInjectedMessages(s);
  const request = sessionModelRequest(s);
  const tools = Array.isArray(s.inputTools) ? s.inputTools : [];
  const calls = Array.isArray(s.callUsage) ? s.callUsage : [];
  const metrics = sessionMetricsOf(s);
  const payloadChars = Number(s.inputPayloadChars)
    || JSON.stringify({ messages: request.messages, tools }).length;
  const reasoning = (s.messages || [])
    .filter((message) => message?.role === 'assistant')
    .map((message, index) => ({
      round: index + 1,
      content: String(
        message.reasoning_content
        || message.raw?.choices?.[0]?.message?.reasoning_content
        || ''
      ).trim()
    }))
    .filter((entry) => entry.content);

  let body = '';
  if (active === 'injected') {
    body = injected.length
      ? `<pre class="context-json">${esc(JSON.stringify({
          threadId: s.threadId || null,
          messages: injected
        }, null, 2))}</pre>`
      : '<div class="context-empty">本轮没有复用上一生命周期的 provider transcript。</div>';
  } else if (active === 'reasoning') {
    body = reasoning.length
      ? `<div class="reasoning-list">${reasoning.slice().reverse().map((entry, index) => `
          <section class="reasoning-entry">
            <div class="reasoning-entry-head">第 ${entry.round} 轮${index === 0 ? ' · 最新' : ''}</div>
            <pre>${esc(entry.content)}</pre>
          </section>`).join('')}</div>`
      : `<div class="context-empty">${s.status === 'running'
          ? '模型请求进行中；当前接口为非流式，推理内容会在本轮响应完成后出现。'
          : '本次模型响应没有返回 reasoning_content。'}</div>`;
  } else {
    // 完整输入的可读转写：按角色分块，正文用与 Release 说明同一套
    // "先整体转义再最小 markdown"的安全渲染（formatReleaseNotes，esc 纪律不变）。
    // 此前是把整包请求 JSON 塞 <pre>，提示词里的 markdown 全变成 \n 转义串，难以阅读；
    // 原始 JSON 仍保留在折叠区，审计用途不变。
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const roleLabel = { system: '系统提示', user: '会话消息', assistant: '模型', tool: '工具返回' };
    const msgBody = (message) => {
      const parts = [];
      const calls = message?.tool_calls || [];
      if (Array.isArray(message?.content)) {
        for (const part of message.content) {
          if (part?.type === 'text') parts.push(`<div class="context-msg-text">${formatReleaseNotes(String(part.text || ''))}</div>`);
          else if (part?.type === 'image_url') parts.push('<div class="context-msg-text context-msg-dim">（内联图片：二进制不进审计文件，仅保留消息结构）</div>');
          else parts.push(`<div class="context-msg-text">${esc(JSON.stringify(part))}</div>`);
        }
      } else if (message?.content != null && String(message.content) !== '') {
        const text = String(message.content);
        parts.push(message.role === 'tool'
          ? `<pre class="context-json">${esc(text)}</pre>`
          : `<div class="context-msg-text">${formatReleaseNotes(text)}</div>`);
      }
      for (const call of calls) {
        const fn = call?.function || {};
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        parts.push(`<div class="context-msg-tool">调用工具 <code>${esc(fn.name || '?')}</code>`
          + `${args && args !== '{}' ? `<pre class="context-json">${esc(args)}</pre>` : ''}</div>`);
      }
      return parts.join('') || '<div class="context-msg-text context-msg-dim">（空内容）</div>';
    };
    body = `
      ${s.inputHasOmittedImages
        ? '<div class="context-warning">内联图片二进制未重复写入审计文件；消息结构和原始字符体积已保留。</div>'
        : ''}
      ${tools.length
        ? ''
        : '<div class="context-warning">该 Session 创建于完整请求审计上线前，工具 schema 未留存。</div>'}
      ${messages.map((message, index) => `
        <section class="context-msg context-msg-${esc(message?.role || 'unknown')}">
          <div class="context-msg-head"><span>#${index + 1} · ${esc(roleLabel[message?.role] || message?.role || '未知')}</span></div>
          <div class="context-msg-body">${msgBody(message)}</div>
        </section>`).join('') || '<div class="context-empty">该轮没有留存消息。</div>'}
      <details class="context-raw-json">
        <summary>原始请求 JSON（审计用，与发给模型的内容逐字一致）</summary>
        <pre class="context-json">${esc(JSON.stringify(request, null, 2))}</pre>
      </details>`;
  }

  return `
    <section class="context-inspector">
      <div class="context-inspector-head">
        <div>
          <strong>模型上下文</strong>
          <span>Session 全局统计 · ${fmtTok(metrics.modelCalls)} 次模型调用</span>
        </div>
        <span class="context-layout">${esc(s.promptLayout || 'stable-prefix-v2')}</span>
      </div>
      <div class="context-metrics">
        <div><span>首轮缓存命中率</span><strong>${fmtRate(metrics.firstCallCacheHitRate, metrics.modelCalls > 0)}</strong><small>首轮输入</small></div>
        <div><span>总缓存命中率</span><strong>${fmtRate(metrics.cacheHitRate, metrics.promptTokens > 0)}</strong><small>全部模型调用</small></div>
        <div><span>总输出 Token</span><strong>${fmtTok(metrics.completionTokens)}</strong><small>token</small></div>
        <div><span>总输入 Token</span><strong>${fmtTok(metrics.promptTokens)}</strong><small>token</small></div>
        <div><span>总缓存 Token</span><strong>${fmtTok(metrics.cachedTokens)}</strong><small>token</small></div>
        <div><span>总工具次数</span><strong>${fmtTok(metrics.toolCalls)}</strong><small>次</small></div>
        <div><span>总联网次数</span><strong>${fmtTok(metrics.webSearchCount)}</strong><small>次</small></div>
        <div><span>预估成本</span><strong>${fmtYuan(metrics.estimatedCost)}</strong><small>${(() => {
          // 这个数字只含按 token 计价的部分：包月/本地/未定价必须点出来，
          // 否则 ¥0.00 会被读成"这次没花钱"。
          const notes = [];
          if (Number(metrics.unpricedCalls) > 0) notes.push(`含 ${Number(metrics.unpricedCalls)} 次未定价调用`);
          if (Number(metrics.flatCalls) > 0) notes.push(`${Number(metrics.flatCalls)} 次按包月计（不计入）`);
          if (Number(metrics.localCalls) > 0) notes.push(`${Number(metrics.localCalls)} 次本地模型（不计费）`);
          return notes.length ? notes.join('；') : '与用量页同口径';
        })()}</small></div>
      </div>
      <div class="context-request-summary">
        当前展示第 ${Number(s.inputRound) || Math.max(1, calls.length)} 轮请求快照
        · 请求体 ${fmtTok(payloadChars)} 字符
        · 注入历史 ${fmtTok(injected.length)} 条
        · 工具定义 ${fmtTok(tools.length)} 个
      </div>
      ${calls.length ? `
        <div class="context-call-table-wrap">
          <table class="context-call-table">
            <thead><tr><th>轮次</th><th>输入</th><th>缓存</th><th>命中率</th><th>未缓存</th><th>输出</th><th>总量</th></tr></thead>
            <tbody>${calls.map((call) => {
              const input = Number(call.promptTokens) || 0;
              const cached = Math.min(input, Number(call.cachedTokens) || 0);
              return `<tr><td>第 ${Number(call.round) || '-'} 轮</td><td>${fmtTok(input)}</td><td>${fmtTok(cached)}</td><td>${fmtRate(input ? cached / input : 0, input > 0)}</td><td>${fmtTok(Math.max(0, input - cached))}</td><td>${fmtTok(call.completionTokens)}</td><td>${fmtTok(call.totalTokens)}</td></tr>`;
            }).join('')}</tbody>
          </table>
        </div>` : ''}
      <div class="context-tabs" role="tablist" aria-label="模型上下文检查器">
        <button type="button" data-context-tab="injected" class="${active === 'injected' ? 'active' : ''}" aria-selected="${active === 'injected'}">注入对话 · ${injected.length}</button>
        <button type="button" data-context-tab="input" class="${active === 'input' ? 'active' : ''}" aria-selected="${active === 'input'}">完整输入 · ${request.messages.length}</button>
        <button type="button" data-context-tab="reasoning" class="${active === 'reasoning' ? 'active' : ''}" aria-selected="${active === 'reasoning'}">模型推理 · ${reasoning.length}</button>
      </div>
      <div class="context-tab-body" data-active-context-tab="${active}">${body}</div>
    </section>`;
}

function renderSessionDecision(s) {
  const bits = [];
  if (s.contextTier !== undefined && s.contextTier !== null) bits.push(`档位 ${s.contextTier}`);
  if (s.contextLimit !== undefined && s.contextLimit !== null) bits.push(`上下文 ${s.contextLimit} 条`);
  if (s.contextReason) bits.push(s.contextReason);
  if (s.rounds) bits.push(`${s.rounds} 轮模型`);
  if (s.budgetStopped) bits.push(`预算停止：${s.budgetStopReason || '已到上限'}`);
  if (s.livingMemory?.recalled) bits.push(`召回记忆 ${s.livingMemory.recalled} 条`);
  if (s.burst?.burstGroups) bits.push(`合并 ${s.burst.burstMessages} 条同人连发`);
  if (!bits.length) return '';
  return `<div class="chat-decision"><strong>本轮决策</strong><span>${esc(bits.join(' · '))}</span></div>`;
}

function renderSessionDetail(s, {
  scrollMode = null,
  scrollTop = null,
  timelineScrollLeft = null
} = {}) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  // json 模式切换也要触发重渲染
  const fp = `${s.id}|${s.status}|${s.conversationMode || 'legacy'}|${s.threadState || ''}|${s.lifecycle?.state || ''}|${s.lifecycle?.deadline || 0}|${s.triggerKind || ''}|${s.rounds || 0}|${s.inputRound || 0}|${s.inputPayloadChars || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.activity || ''}|${s.sessionMetrics?.estimatedCost || 0}|${s.contextTier ?? ''}|${s.contextLimit ?? ''}|${s.contextReason || ''}|${s.budgetStopped ? 1 : 0}|${s.livingMemory?.recalled || 0}|${s.burst?.burstGroups || 0}|${s.burst?.burstMessages || 0}|${state.sessionInspectorTab}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (state.lastDetailFp === fp) return;
  const firstRender = state.lastDetailFp === null;
  state.lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const keepTimelineScroll = timelineScrollLeft
    ?? detail.querySelector('.thread-run-list')?.scrollLeft
    ?? 0;
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const statusBadge = `<span class="status-badge status-${s.status}">${esc(sessionStatusText(s))}</span>`;
  const metrics = sessionMetricsOf(s);

  const html = [];
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}
        <button type="button" class="icon-btn session-mobile-back" id="session-mobile-back" title="返回会话列表" aria-label="返回会话列表">←</button>
        <button class="btn btn-small" id="json-mode-btn" style="margin-left:10px">JSON 模式</button>
      </h2>
      <div class="sub">
        <span>触发方式：${esc(triggerKindLabel(s))}${s.triggerReason ? ` · ${esc(s.triggerReason)}` : ''}</span>
        <span>人设：${esc(s.persona || '（这次运行没记录到角色卡）')}</span>
        <span>触发消息：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · ${s.conversationMode === 'lifecycle' ? '本轮结束' : '结束'} ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${fmtTok(metrics.modelCalls)} 次模型调用 · ${fmtTok(metrics.toolCalls)} 次工具调用</span>
      </div>
    </div>
    ${renderSessionModeBand(s)}
    ${renderSessionDecision(s)}
    ${renderLifecycleOverview(s)}
    ${renderSessionThreadTimeline(s)}`);

  const jsonMode = state.sessionJsonMode === s.id;
  if (jsonMode) {
    // JSON 模式：原模原样展示输入给模型的内容 + 模型返回的原始内容
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      conversationMode: s.conversationMode || 'legacy',
      threadId: s.threadId || null,
      threadState: s.threadState || null,
      lifecycle: s.lifecycle || null,
      triggerKind: s.triggerKind || '',
      triggerReason: s.triggerReason || '',
      contextTier: s.contextTier ?? null,
      contextLimit: s.contextLimit ?? null,
      contextReason: s.contextReason || '',
      rounds: s.rounds || 0,
      budgetStopped: s.budgetStopped === true,
      budgetStopReason: s.budgetStopReason || '',
      livingMemory: s.livingMemory || null,
      burst: s.burst || null,
      promptLayout: s.promptLayout || '',
      callUsage: s.callUsage || [],
      sessionMetrics: metrics,
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      injectedMessages: sessionInjectedMessages(s),
      currentModelRequest: sessionModelRequest(s),
      inputRound: s.inputRound || 0,
      inputPayloadChars: s.inputPayloadChars || 0,
      inputHasOmittedImages: s.inputHasOmittedImages === true,
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.content,
        reasoning_content: m.reasoning_content ?? null,
        tool_calls: m.tool_calls ?? null,
        raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({
        toolCall: m.toolCall
      })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    html.push(`
      <details class="collapsible" open>
        <summary>JSON 模式（模型输入/输出的原始内容）</summary>
        <div class="coll-body" style="max-height:none">${esc(JSON.stringify(raw, null, 2))}</div>
      </details>`);
  } else {
    html.push(renderSessionContextInspector(s));
  }

  html.push('<div class="msg-flow">');
  if (!jsonMode) {
    for (const item of s.messages || []) {
      if (item.toolCall) {
        html.push(`
          <div class="tool-card ${item.toolCall.isError ? 'tool-error' : ''}">
            <div class="tool-head"><span class="tool-name">${esc(item.toolCall.name)}</span></div>
            <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
            <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
          </div>`);
      } else if (item.toolImages) {
        html.push(`
          <div class="tool-card">
            <div class="tool-head"><span class="tool-name">${esc(item.toolImages.tool)}</span>
            <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
          </div>`);
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
        html.push(`
          <div class="bubble bubble-assistant">
            <div class="asr-label">模型文本（不发送）</div>
            ${esc(text || '（无文本输出，仅调用工具）')}
          </div>`);
      }
    }
    // 发出的消息
    for (const sent of s.sent || []) {
      html.push(`
        <div class="sent-badge">
          <div class="asr-label">已发送到 QQ${sent.at ? ` · ${sent.at}` : ''}</div>
          ${esc(sent.text)}
        </div>`);
    }
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  if (detail.querySelector('.lifecycle-remaining[data-deadline]')) {
    startLifecycleTicker();
  }
  $('#session-mobile-back')?.addEventListener('click', () => {
    $('#view-sessions')?.classList.remove('mobile-detail-open');
  });
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  const jsonBtn = $('#json-mode-btn');
  if (jsonBtn) jsonBtn.addEventListener('click', () => {
    state.sessionJsonMode = state.sessionJsonMode === s.id ? null : s.id;
    state.lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  detail.querySelectorAll('[data-context-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sessionInspectorTab = button.dataset.contextTab;
      state.lastDetailFp = null;
      renderSessionDetail(s);
    });
  });
  detail.querySelectorAll('[data-thread-session-id]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.threadSessionId !== state.currentSessionId) {
        selectSession(button.dataset.threadSessionId, { preserveDetail: true });
      }
    });
  });
  const threadRunList = detail.querySelector('.thread-run-list');
  if (threadRunList) {
    threadRunList.scrollLeft = keepTimelineScroll;
    threadRunList.addEventListener('wheel', (event) => {
      if (threadRunList.scrollWidth <= threadRunList.clientWidth
        || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const next = Math.min(
        threadRunList.scrollWidth - threadRunList.clientWidth,
        Math.max(0, threadRunList.scrollLeft + event.deltaY)
      );
      if (next === threadRunList.scrollLeft) return;
      event.preventDefault();
      threadRunList.scrollLeft = next;
    }, { passive: false });
  }
  if (scrollMode === 'top') {
    detail.scrollTop = 0;
  } else if (scrollMode === 'preserve') {
    detail.scrollTop = Number(scrollTop) || 0;
  } else if (s.status === 'running' && wasAtBottom) {
    detail.scrollTop = detail.scrollHeight;      // 用户原本贴底时才跟随新增内容
  } else if (firstRender) {
    detail.scrollTop = 0;
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  // 说明：此处原先有一段"运行中每 2s 自递归拉详情"的兜底轮询，已移除。
  // 原因：renderSessionDetail 会被 SSE 事件和 4s 主轮询反复调用，每次都新起一个
  // setTimeout 且从不取消旧的，切换/高频刷新时 timer 会不断累积；
  // 而下面的 4s 主轮询（loadSessions）已经会对 running/waiting 的会话刷新详情，
  // 功能完全覆盖，2s 递归属于纯重复请求。
}


export { loadSessionDetail, loadSessions, renderSessionDetail, renderSessionList };