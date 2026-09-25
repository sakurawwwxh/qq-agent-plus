// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条
const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）
const CHAT_MSG_PAGE = 500;    // 存档页：首次加载条数
const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

const state = {
  tab: 'sessions',
  integrationStatus: null,
  autoUpdateStatus: null,
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  sessionInspectorTab: 'input',
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  memoryView: 'events',
  currentMemoryChatKey: null,
  identityFeatureQuery: '',
  incidentState: 'open',
  incidentSeverity: '',
  incidentChatKey: '',
  assetKind: 'stickers',
  assetQuery: '',
  assetSlangStatus: '',
  assetSlangResearchState: '',
  assetOverview: null,
  assetDetail: null,
  assetLoadSeq: 0,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {}   // chatKey -> { note, at, failed? }
};

function graduatedFeatureState(c = state.config || {}) {
  return {
    identity: c.identityPilot?.graduated === true,
    // 「好友管理」页承载入站好友申请的审批（该功能不受退役影响），导航入口
    // 不随 friendProposal 的退役隐藏——只隐藏会把入站审批一起藏掉。
    slang: c.slangPilot?.graduated === true,
    incidents: c.incidentPilot?.graduated === true
  };
}

function syncGraduatedFeatureNavigation(c = state.config || {}) {
  const features = graduatedFeatureState(c);
  for (const [feature, visible] of Object.entries(features)) {
    const tab = $(`[data-feature-nav="${feature}"]`);
    if (tab) tab.classList.toggle('hidden', !visible);
  }
}

// ── 工具函数 ──
// 控制台标识头：证明请求来自本控制台页面，而非外部网页冒用浏览器。
// 带自定义头的请求必须过 CORS 预检，天然挡住跨站脚本/表单的静默读取。
/** 数字加千分位（token 计数用）。 */
const fmtTok = (n) => (Number(n) || 0).toLocaleString('zh-CN');

/**
 * 金额格式化（成本用）。
 * 成本经常是小额（几分钱），固定两位小数会全显示成 ¥0.00 看不出差别，
 * 所以小于 1 时多给两位有效数字。
 */
const fmtYuan = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
};

/**
 * 用量页当前选中的时间范围（对应 USAGE_RANGES 里的值）。
 * 用 let 而不是 const：点范围按钮会改它，改完要重新拉取数据。
 */
let usageRange = '7';

/*
 * 工具的中文名与分类，用于"调用明细"弹窗。
 *
 * 用 emoji 当图标只是为了扫一眼好认 —— 这类"没什么实际用处但有趣"的细节，
 * 是特意保留的：一张纯数字的表格很无聊，分类 + 图标能让人真的去看一眼。
 */
const TOOL_META = {
  // 发言类
  send_message:      { name: '发消息',     cat: '发言',   icon: '💬' },
  send_sticker:      { name: '发表情包',   cat: '发言',   icon: '🎴' },
  send_poke:         { name: '戳一戳',     cat: '发言',   icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail:  { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images:  { name: '看图片',     cat: '查看', icon: '🖼️' },
  get_active_members:  { name: '看活跃群友', cat: '查看', icon: '👥' },
  // 表情包
  list_stickers:     { name: '列表情库',   cat: '表情',   icon: '📚' },
  get_sticker_image: { name: '看表情图',   cat: '表情',   icon: '🖼️' },
  collect_sticker:   { name: '收藏表情',   cat: '表情',   icon: '⭐' },
  sticker_note:      { name: '备注表情',   cat: '表情',   icon: '📝' },
  // 记忆
  memory_append:     { name: '记一条',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查记忆',     cat: '记忆',   icon: '🧠' },
  person_memory_lookup: { name: '查人物记忆', cat: '记忆', icon: '🧠' },
  friend_request_propose: { name: '提议加好友', cat: '记忆', icon: '＋' },
  memory_remove:     { name: '删记忆',     cat: '记忆',   icon: '🧹' },
  // 联网
  web_search:        { name: '联网搜索',   cat: '联网',   icon: '🌐' },
  web_fetch:         { name: '抓网页',     cat: '联网',   icon: '🔗' },
  // 其他
  report_feedback:   { name: '汇报反馈',   cat: '其他',   icon: '📣' },
  finish:            { name: '结束本次',   cat: '其他',   icon: '🏁' }
};

/** 分类的展示顺序（"其他"垫底） */
const TOOL_CAT_ORDER = ['发言', '查看', '表情', '记忆', '联网', '其他'];

/** 用量页的时间范围选项：[传给后端的值, 按钮文案] */
const USAGE_RANGES = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部']
];

const CONSOLE_MARKER = 'qq-agent-console';

/* ══════════════════════════════════════════════════════════════
   主题（明/暗/系统）
   ══════════════════════════════════════════════════════════════
   持久化两层：
     1. localStorage —— 立即生效，避免每次启动都等接口
     2. 后端 config.ui.theme —— 跨设备/重装后保留（尽力而为，失败不阻塞）
   首屏防闪由 index.html 的内联脚本负责（读 localStorage 直接设 data-theme）。
*/
const THEME_ICON = { dark: '🌙', light: '☀️', system: '🖥️' };
const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统' };
const THEME_VALUES = ['dark', 'light', 'system'];

/** 读取当前主题设置（localStorage 优先，其次系统偏好）。 */
function getThemePref() {
  try {
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'dark';
}

/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/** 应用主题到 <html>，并同步按钮图标。 */
function applyTheme(pref) {
  const actual = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', actual);
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = THEME_ICON[pref] || THEME_ICON.dark;
    btn.title = `主题：${THEME_LABEL[pref] || '暗色'}（点击切换）`;
  }
  try { localStorage.setItem('qqa-theme', pref); } catch { /* 忽略 */ }
}

/** 点击按钮：暗 → 亮 → 跟随系统 → 暗。 */
function cycleTheme() {
  const order = THEME_VALUES;
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
  applyTheme(next);
  // 尽力同步到后端，失败不影响本地使用
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      'x-console-token': CONSOLE_MARKER,
      ...(options.headers || {})
    },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const dialog = $('#console-login');
    if (dialog && !dialog.open) dialog.showModal();
    $('#loading-overlay')?.classList.add('hidden');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function askForConfirmation(message) {
  return new Promise((resolve) => {
    let settled = false;
    const overlay = modelModalShell({
      head: '确认操作',
      body: `<div style="white-space:pre-wrap">${esc(message)}</div>`,
      foot: '<button type="button" class="btn" data-confirm-cancel>取消</button>'
        + '<button type="button" class="btn btn-danger" data-confirm-accept>确认</button>',
      danger: true
    });
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      closeModelModal(overlay);
      resolve(confirmed);
    };
    overlay.querySelector('[data-confirm-cancel]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-confirm-accept]').addEventListener('click', () => finish(true));
    overlay.querySelector('.model-modal-close').addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(false);
    });
    overlay.querySelector('[data-confirm-cancel]').focus();
  });
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { waiting: '等待中', done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };
const CONVERSATION_MODE_LABEL = { legacy: '传统触发', threaded: '参与者续接', lifecycle: '完整生命周期' };
const THREAD_STATE_LABEL = {
  starting: '启动中',
  engaged: '续接窗口中',
  active: '活跃中',
  listening: '监听中',
  rollover_armed: '等待下一条消息续接',
  closed: '已结束'
};
const TRIGGER_KIND_LABEL = {
  mention: '@ 触发',
  keyword: '关键词触发',
  probability: '传统概率触发',
  all: '全部响应',
  lifecycle: '生命周期续接',
  rollover: '换代续接',
  reply: '引用触发',
  private: '私聊触发',
  manual: '控制台触发',
  proactive: '主动触发',
  retry: '失败重试',
  unknown: '其他触发'
};

function triggerKindOf(value) {
  if (typeof value === 'string') return value || 'unknown';
  if (value?.triggerKind) return value.triggerKind;
  const reason = String(value?.triggerReason || value?.contextReason || '');
  if (reason === '被艾特') return 'mention';
  if (reason === '关键词命中') return 'keyword';
  if (reason.startsWith('随机命中')) return 'probability';
  if (reason === '全部响应') return 'all';
  if (/生命周期：(?:活跃|监听)状态/.test(reason)) return 'lifecycle';
  if (/硬上限后的任意消息续接/.test(reason)) return 'rollover';
  if (/引用机器人/.test(reason)) return 'reply';
  if (reason === '私聊') return 'private';
  if (reason === '控制台主动唤醒') return 'manual';
  if (reason === '失败批次重试') return 'retry';
  return 'unknown';
}

function triggerKindLabel(value) {
  const kind = triggerKindOf(value);
  return TRIGGER_KIND_LABEL[kind] || TRIGGER_KIND_LABEL.unknown;
}

function lifecycleStateOf(s) {
  return s?.lifecycle?.state || s?.threadState || (s?.threadId ? 'closed' : 'starting');
}

function fmtRemainingMs(ms) {
  const seconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

function lifecycleRemainingText(deadline, lifecycleState) {
  if (lifecycleState === 'closed') return '已结束';
  if (lifecycleState === 'starting') return '建立中';
  if (!Number(deadline)) return '-';
  const remaining = Number(deadline) - Date.now();
  return remaining > 0 ? fmtRemainingMs(remaining) : '状态更新中';
}

function lifecycleRunsFor(s) {
  if (s?.conversationMode !== 'lifecycle' || !s?.threadId) return [];
  return (state.sessions || [])
    .filter((entry) =>
      entry.conversationMode === 'lifecycle'
      && entry.chatKey === s.chatKey
      && entry.threadId === s.threadId)
    .slice()
    .sort((a, b) => Number(a.startedAt) - Number(b.startedAt));
}

function lifecycleAggregate(s) {
  const groupedRuns = lifecycleRunsFor(s);
  const runs = groupedRuns.length ? groupedRuns : [s];
  const origin = runs[0];
  const current = runs.find((run) => run.lifecycle?.isCurrent)
    || (s.lifecycle ? s : null)
    || runs.at(-1)
    || s;
  return {
    runs,
    origin,
    lifecycle: current?.lifecycle || s.lifecycle || null,
    totalTokens: runs.reduce(
      (sum, run) => sum + (Number(run.usage?.totalTokens) || 0),
      0
    ),
    totalCalls: runs.reduce(
      (sum, run) => sum + (Number(run.usage?.calls) || 0),
      0
    ),
    estimatedCost: runs.reduce(
      (sum, run) => sum + (Number(run.sessionMetrics?.estimatedCost) || 0),
      0
    )
  };
}

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

function renderLifecycleOverview(s) {
  if (s.conversationMode !== 'lifecycle') return '';
  const aggregate = lifecycleAggregate(s);
  const lifecycle = aggregate.lifecycle || {};
  const lifecycleState = lifecycle.state || lifecycleStateOf(s);
  const deadline = Number(lifecycle.deadline) || 0;
  const hardDeadline = Number(lifecycle.hardDeadline) || 0;
  const hardRemaining = hardDeadline > Date.now()
    ? fmtRemainingMs(hardDeadline - Date.now())
    : '-';
  return `
    <section class="lifecycle-overview" aria-label="生命周期运行摘要">
      <div>
        <span>起始触发</span>
        <strong>${esc(triggerKindLabel(aggregate.origin))}</strong>
        <small>${esc(aggregate.origin?.triggerReason || '未记录具体判定')}</small>
      </div>
      <div>
        <span>当前状态</span>
        <strong>${esc(THREAD_STATE_LABEL[lifecycleState] || lifecycleState || '-')}</strong>
        <small>${lifecycle.isCurrent ? '当前线程' : lifecycleState === 'closed' ? '线程已关闭' : '等待线程建立'}</small>
      </div>
      <div>
        <span>生命周期剩余</span>
        <strong class="lifecycle-remaining" data-deadline="${deadline}" data-lifecycle-state="${esc(lifecycleState)}">${esc(lifecycleRemainingText(deadline, lifecycleState))}</strong>
        <small>${lifecycleState === 'rollover_armed' ? '可续接窗口' : `硬上限 ${hardRemaining}`}</small>
      </div>
      <div>
        <span>预估总消耗</span>
        <strong>${fmtYuan(aggregate.estimatedCost)}</strong>
        <small>${fmtTokens(aggregate.totalTokens)} · ${fmtTok(aggregate.totalCalls)} 次调用 · ${fmtTok(aggregate.runs.length)} 批</small>
      </div>
    </section>`;
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

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

// 启动提示默认由 CSS 静态隐藏（html.boot-silent .loading-overlay{opacity:0}），
// 正常进入（哪怕要一两秒）一秒都不会出现；只有超过 LOADING_REVEAL_MS 还没就绪
// （服务没起、协议端连不上、启动卡住）才加上 boot-show 淡入。index.html 里还有一份
// 8 秒兜底，负责"脚本压根没加载成功"时把提示显示出来。
const LOADING_REVEAL_MS = 5000;
let loadingRevealed = false;
let loadingRevealTimer = null;

function revealLoading() {
  if (appReady || loadingRevealed) return;
  if (!document.getElementById('loading-overlay')) return;
  loadingRevealed = true;
  document.documentElement.classList.remove('boot-silent');
  document.documentElement.classList.add('boot-show');
}

function revealLoadingIfSlow() {
  if (loadingRevealTimer) clearTimeout(loadingRevealTimer);
  loadingRevealTimer = setTimeout(revealLoading, LOADING_REVEAL_MS);
}

function hideLoading() {
  appReady = true;
  if (loadingRevealTimer) clearTimeout(loadingRevealTimer);
  try { clearTimeout(window.__bootRevealFallback); } catch { /* 忽略 */ }
  document.documentElement.classList.remove('boot-show');
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  if (!loadingRevealed) { el.remove(); return; }   // 从没显示过，直接摘掉
  setTimeout(() => el.remove(), 260);              // 等淡出动画
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) {
      // 首屏就卡在这儿的多半是协议端没起来，把原因直接写出来，别让人对着"正在连接"干等
      const why = onebotIssueText(status.onebot, { withRaw: false });
      setLoadingStatus(why ? `OneBot 还没连上：${why}` : '正在连接外部 OneBot 服务…');
    } else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请检查服务日志和 OneBot WS/HTTP 配置。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    // 头 3 秒用短间隔（服务通常立刻可用，短间隔能让首屏更快进入），之后退回 1 秒避免空转
    await new Promise((r) => setTimeout(r, i < 12 ? 250 : 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
  if (state.tab === 'memory') loadMemoryView();
}

// 列表按 key 做增量更新：已存在且内容未变的行，保持同一个 DOM 节点。
// 为什么需要它：以前列表是 box.innerHTML = rows.map(...) 整列重建，每次刷新
// （15 秒一次 + 推送）都会把每一行销毁重建——行上的悬停/选中态、正在跑的动画、
// 内部滚动位置全被重置，看起来就是"列表闪来闪去"。这里按 key 对齐：
//   · key 相同且 HTML 相同 → 复用原节点（什么都不做）
//   · key 相同但 HTML 变了 → 只替换这一行
//   · key 不存在 → 插入新节点；多余的 key → 删除
function patchKeyedList(container, entries, keyAttr = 'data-key') {
  if (!container) return;
  // 比较用的规范化：把"由本地 ticker 维护"的倒计时文本抹掉，
  // 否则每次刷新都判定成"行变了"，整行重建（倒计时还会闪回旧值）。
  const VOLATILE = /(<(?:span|strong)[^>]*data-(?:until|deadline)="[^"]*"[^>]*>)[\s\S]*?(<\/(?:span|strong)>)/g;
  const norm = (html) => String(html).replace(VOLATILE, '$1$2');
  const existing = new Map();
  for (const node of Array.from(container.children)) {
    const key = node.getAttribute && node.getAttribute(keyAttr);
    if (key) existing.set(key, node);
  }
  const makeNode = (html, key) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html).trim();
    const node = tpl.content.firstElementChild;
    if (!node) return null;
    node.setAttribute(keyAttr, key);
    node.__renderedHtml = html;
    node.__cmp = norm(html);
    return node;
  };
  const seen = new Set();
  let prev = null;
  for (const entry of entries) {
    const key = String(entry.key);
    if (seen.has(key)) continue;
    seen.add(key);
    let node = existing.get(key) || null;
    const cmp = norm(entry.html);
    if (node && node.__cmp !== cmp) {
      const fresh = makeNode(entry.html, key);
      if (fresh) { node.replaceWith(fresh); node = fresh; }
    } else if (!node) {
      node = makeNode(entry.html, key);
    }
    if (!node) continue;
    const wantNext = prev ? prev.nextElementSibling : container.firstElementChild;
    if (node !== wantNext) container.insertBefore(node, prev ? prev.nextSibling : container.firstChild);
    prev = node;
  }
  for (const [key, node] of existing) {
    if (!seen.has(key)) node.remove();
  }
}

// 只在内容真的变化时替换 DOM。
// 背景：控制页/异常页等会在每次状态刷新（15 秒一次 + 推送）时重建整块 HTML，
// 数据没变也照重建 —— 页面就"整页闪一下"。用这个函数收口：HTML 相同直接跳过。
function setHtmlIfChanged(el, html) {
  if (!el) return false;
  if (el.__renderedHtml === html) return false;
  el.__renderedHtml = html;
  el.innerHTML = html;
  return true;
}

// 状态条里的标签：文字会随数据变长，窄窗口下容易换行把整块内容顶下去。
// 统一通过这个 setter 写，顺便把完整文本放进 title，截断时鼠标悬停还能看到。
function setStatusLabel(selector, text) {
  const el = $(selector);
  if (!el) return;
  el.textContent = text;
  el.title = text;
}

// ── OneBot 连接失败的人话解释 ──
// 后端在 /api/status 的 onebot.error 里记着最近一次连接失败的原因（例如
// "connect ECONNREFUSED 127.0.0.1:3001"），但界面上以前只写"未连接"，用户只能猜。
// 这里把常见错误翻成能照着做的短句；原文附在括号里，方便直接复制去求助。
function onebotIssueText(ob, { withRaw = true } = {}) {
  if (!ob || ob.connected) return '';
  const raw = String(ob.error || '').trim();
  if (!raw) return ob.everConnected ? '连接已断开，正在自动重连' : '还没连上协议端，正在重试';
  let hint = '连接失败';
  if (/ECONNREFUSED/i.test(raw)) hint = '协议端没在这个端口监听（服务没启动或端口不对）';
  else if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) hint = '这个地址解析不了（WS 地址可能写错了）';
  else if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(raw)) hint = '连不到那台机器（地址或防火墙）';
  else if (/\b(401|403)\b|unauthorized|forbidden/i.test(raw)) hint = '对方拒绝了连接，多半是令牌不一致（协议端 onebot.json 的 accessToken 要和控制台里的 WS 令牌一致）';
  else if (/\b404\b|Unexpected server response/i.test(raw)) hint = '对方不是 WebSocket 协议端（地址或端口填错了）';
  return withRaw ? `${hint}（${raw}）` : hint;
}

// 设置页「OneBot」那一块的状态行：那一页就是来修"连不上"的地方，
// 所以当前状态和失败原因直接摊开写，不用去别处找。
function onebotStatusLineHtml() {
  const ob = state.status?.onebot;
  return ob?.connected
    ? `<div class="hint success">当前状态：已连接${ob.self ? `（${esc(ob.self.nickname)}）` : '（但没取到登录信息，确认协议端的 QQ 已登录）'}</div>`
    : `<div class="hint error">当前状态：未连接 —— ${esc(onebotIssueText(ob) || '正在等待首次连接')}</div>`;
}

// 状态刷新时只换这一行的文字，不重渲染整段表单（否则会清掉用户正在填的内容）
function updateOnebotStatusLine() {
  const el = $('#onebot-status-line');
  if (el) el.innerHTML = onebotStatusLineHtml();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  // 拆成"接口地址"与"模型"两步：合并判断时新手分不清到底缺哪个。
  // 出厂 baseUrl 为空，第一条会直接指出该填什么。
  const urlOk = !!String(cfg.api.baseUrl || '').trim();
  checks.push({
    ok: urlOk,
    label: urlOk ? `接口地址：${cfg.api.baseUrl}` : '还没有填接口地址（Base URL，必填）：官方 API 或中转站提供的 OpenAI 兼容地址',
    fix: urlOk ? null : 'settings-api'
  });
  const modelOk = !!String(cfg.api.model || '').trim();
  checks.push({
    ok: modelOk,
    label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（填好地址后点「获取列表」或手动添加）',
    fix: modelOk ? null : 'settings-api'
  });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
  const obIssue = onebotIssueText(status?.onebot);
  checks.push({
    ok: !!obOk,
    label: obOk
      ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}`
      : `OneBot 未连接 —— ${obIssue || '请检查设置中的 WS/HTTP 地址与令牌'}`,
    fix: obOk ? null : 'settings-onebot'
  });
  return { ready: urlOk && modelOk && allowOk && obOk, checks };
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  // 预算保险丝已移除：原先这里有一个 pauseReason === 'budget' 的分支
  if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    const why = onebotIssueText(s.onebot);
    html = `🔌 OneBot 还没连上：${why ? `${esc(why)}。` : ''}请确认外部协议服务已启动，且 WS/HTTP 地址正确。`;
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    const link = $('#banner-goto-settings');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  if (name === 'control') loadControlHub();
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  if (name === 'memory') loadMemoryView();
  if (name === 'identity') loadIdentityFeaturePage();
  if (name === 'friends') loadFriendFeaturePage();
  if (name === 'slang') loadSlangFeaturePage();
  if (name === 'incidents') loadIncidentFeaturePage();
  if (name === 'assets') loadAssetObservatory();
  if (name === 'usage') loadUsageView({ force: true });
  if (name === 'settings') loadSettings();
}

const CORE_SERVICE_LINKS = [
  { id: 'agent', name: 'QQ Agent', detail: '当前控制台', port: 3210, mark: 'AG' },
  { id: 'dsh', name: 'DeepSeek Harness', detail: '模型与会话', port: 3080, mark: 'DS' },
  { id: 'bridge', name: 'Bridge Console', detail: '旧架构运维', port: 3100, mark: 'BR' },
  { id: 'snowluma', name: 'SnowLuma', detail: 'QQ 网关', port: 5099, mark: 'SL' },
  { id: 'novnc', name: 'QQ 远程桌面', detail: '登录与客户端维护', port: 6081, mark: 'QQ' }
];

function serviceUrl(port, path = '/') {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  const hostname = location.hostname || new URL(location.href).hostname;
  return `${protocol}//${hostname}:${port}${path}`;
}

// 服务卡片的状态：旧架构（DSH / Bridge）没配置端点时是「未部署」，不是故障 ——
// 本仓库的部署栈不含它们（见 docs/LINUX.md），部署脚本也不会起。
// 配置过（后端给了 optional+configured）却连不上，才照旧报「不可达」。
function serviceTileState(id, status) {
  const online = id === 'agent' || status?.online === true;
  if (online) return { text: '在线', cls: 'online' };
  if (!status) return { text: '检测中', cls: 'offline' };
  if (status.optional === true && status.configured === false) return { text: '未部署', cls: 'idle' };
  return { text: '不可达', cls: 'offline' };
}

/** 旧架构服务是否落在本部署里（没配置 = 不显示指向它的入口）。 */
function legacyServiceDeployed(statuses, id) {
  const status = statuses.get(id);
  return !(status?.optional === true && status?.configured === false);
}

// 「更新部署」里的上次更新检查说明：口径是「已发布的 Release」，
// 让"连不上 GitHub / 没有新 Release / 当前部署领先"这些情况都能看见，而不是完全无声。
function renderUpdateCheckNote(update = {}) {
  const short = (value) => (value ? String(value).slice(0, 12) : '-');
  const check = update.updateNotice && typeof update.updateNotice === 'object' ? update.updateNotice : null;
  if (!check || (!check.checkedAt && !check.error)) {
    return '更新检查尚未运行：打开控制台时会自动检查一次。';
  }
  const when = check.checkedAt ? `（${esc(fmtTime(check.checkedAt))}）` : '';
  if (check.available) {
    return `上次更新检查${when}：发现新版本${check.version ? ` ${esc(check.version)}` : ''}`
      + `（当前 ${esc(short(check.deployed))} → 最新 ${esc(short(check.revision))}`
      + `${Number(check.commitCount) > 0 ? `，${Number(check.commitCount)} 个新提交` : ''}）。`;
  }
  if (check.reason === 'unconfigured') {
    return '未配置自动更新仓库，无法检查新版本。';
  }
  if (check.reason === 'no-release') {
    return `上次更新检查${when}：仓库尚未发布新的 Release，不提示更新`
      + '（只有发布 Release 才算新版本，branch 上的日常提交不会提示）。';
  }
  if (check.reason === 'ahead-of-release') {
    return `上次更新检查${when}：当前部署已包含最新 Release`
      + `${check.version ? ` ${esc(check.version)}` : ''}（${esc(short(check.deployed))}），无需更新。`;
  }
  if (check.reason === 'unknown-deployed') {
    return `上次更新检查${when}：当前部署不是 git 提交（可能是压缩包安装），无法比较版本`
      + `${check.version ? `；最新 Release 为 ${esc(check.version)}，可用「立即更新」安装该版本` : ''}。`;
  }
  if (check.reason === 'compare-failed') {
    const detail = String(check.error || '').trim().slice(0, 140);
    return `上次更新检查${when}：无法比较当前版本与该 Release${detail ? ` —— ${esc(detail)}` : ''}。`
      + '为避免装错版本，本次不提示也不更新；打开控制台会自动重试。';
  }
  if (check.reason === 'unreachable' || (!check.available && check.error)) {
    const detail = String(check.error || '').replace(/^Command failed:.*?:\s*/, '').trim().slice(0, 140);
    return `上次更新检查${when}：连不上 GitHub${detail ? ` —— ${esc(detail)}` : ''}。`
      + '打开控制台会自动重试；若持续失败请检查服务器出网，可用下方「测试 GitHub 连通性」定位。';
  }
  const latest = check.version ? `Release ${esc(check.version)} · ` : '';
  return `上次更新检查${when}：已是最新（${latest}当前 ${esc(short(check.deployed))}）。`;
}

// ── 更新进度：更新器把当前阶段写进状态文件（phase），排队阶段只有 status。
//    这里只做展示，不推断阶段；阶段起点用 progressAt（每次阶段推进都续期）。───────
const UPDATE_PHASE_LABELS = {
  startup: '启动更新器',
  connectivity: '检查网络连通性',
  checking: '检查最新版本',
  testing: '跑部署前测试',
  deploying: '部署（服务会短暂重启）',
  complete: '收尾'
};
const UPDATE_STATUS_LABELS = {
  queued: '等待更新器接手',
  checking: '检查最新版本',
  testing: '跑部署前测试',
  deploying: '部署（服务会短暂重启）'
};
// 「这轮更新在跑」的口径要与更新器一致（src/auto-update.js 的 ACTIVE_STATES）：
// status() 的 busy 只说明更新器进程在（跳过间隔、被禁用这类情形也留个进程），
// 那种时刻状态文件还停在上一轮的终态，单看 busy 会闪出一条"正在更新…收尾"的假进度行。
const UPDATE_ACTIVE_STATUSES = new Set(['queued', 'checking', 'testing', 'deploying']);

function formatElapsed(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}

function updateProgressStage(update = {}) {
  const status = String(update.status || '');
  if (update.busy !== true || !UPDATE_ACTIVE_STATUSES.has(status)) return '';
  const phase = String(update.phase || '');
  // 排队时 phase 还是上一轮的残留值，先看 status
  const label = status === 'queued'
    ? UPDATE_STATUS_LABELS.queued
    : (UPDATE_PHASE_LABELS[phase] || UPDATE_STATUS_LABELS[status] || '更新进行中');
  // targetVersion 只有"手动更新提交时"和"更新器解析出 Release 后"才有；
  // 不能拿 state.version 兜底 —— 那是状态文件的 schema 版本（恒为 1）。
  const version = String(update.targetVersion || '').trim();
  // 连通性测试（probe）只探通道、不部署，文案别说成"正在更新"
  const probe = String(update.mode || '') === 'probe';
  return probe ? `正在探测更新通道：${label}` : `正在更新${version ? `到 ${version}` : ''}：${label}`;
}

function updateProgressElapsed(update = {}) {
  if (update.busy !== true) return '';
  const now = Date.now();
  const started = Number(update.startedAt || 0) || Number(update.updatedAt || 0);
  const stageAt = Number(update.progressAt || 0) || started;
  const parts = [];
  if (stageAt) parts.push(`本阶段 ${formatElapsed((now - stageAt) / 1000)}`);
  if (started && stageAt && started !== stageAt) parts.push(`总计 ${formatElapsed((now - started) / 1000)}`);
  return parts.join(' · ');
}

function updateProgressText(update = {}) {
  const stage = updateProgressStage(update);
  if (!stage) return '';
  const elapsed = updateProgressElapsed(update);
  return elapsed ? `${stage} · ${elapsed}` : stage;
}

// 进度里的耗时每秒刷新；只在控制页且更新仍在跑时工作，跑完或切页后自动停。
// 注意：这里直接写 textContent —— setText 是 updateControlHubFields 里的局部函数，
// 模块作用域拿不到（曾经在这里调它，导致更新期间每秒抛一次 ReferenceError）。
let updateProgressTicker = null;
function startUpdateProgressTicker() {
  if (updateProgressTicker) return;
  updateProgressTicker = setInterval(() => {
    const box = document.getElementById('hub-deploy-progress');
    if (state.tab !== 'control' || state.autoUpdateStatus?.busy !== true || !box) {
      clearInterval(updateProgressTicker);
      updateProgressTicker = null;
      return;
    }
    const el = document.getElementById('hub-deploy-progress-elapsed');
    const next = updateProgressElapsed(state.autoUpdateStatus || {});
    if (el && el.textContent !== next) el.textContent = next;
  }, 1000);
}

function renderControlHub(data = {}) {
  const box = $('#control-page');
  if (!box) return;
  const statuses = new Map((data.services || []).map((service) => [service.id, service]));
  const update = state.autoUpdateStatus || {};
  const updateLabels = {
    idle: '等待检查',
    disabled: '已暂停',
    queued: '等待启动',
    checking: '检查更新',
    testing: '验证更新',
    deploying: '部署中',
    succeeded: '更新成功',
    'no-update': '已是最新',
    failed: '更新失败'
  };
  const updateState = update.status === 'failed'
    ? updateLabels.failed
    : update.enabled
      ? (updateLabels[update.status] || '等待检查')
      : '已暂停';
  const revision = (value) => value ? String(value).slice(0, 12) : '-';
  // 更新进度行：结构只建一次，这里的初值 + updateControlHubFields 里的实时同步
  // 一起保证"点完立即更新马上能看到阶段与耗时"。没有在跑时留空并隐藏。
  const progressLine = updateProgressText(update);
  const __html = `
    <div class="control-head">
      <div><h2>服务与访问控制</h2><span class="muted">统一入口</span></div>
      <button type="button" class="icon-btn" id="control-refresh" title="刷新服务状态" aria-label="刷新服务状态">↻</button>
    </div>
    <div class="control-service-grid">
      ${CORE_SERVICE_LINKS.map((service) => {
        const tile = serviceTileState(service.id, statuses.get(service.id));
        return `<a class="control-service" data-hub-service="${esc(service.id)}" href="${esc(serviceUrl(service.port))}" target="_blank" rel="noreferrer">
          <span class="control-service-mark">${esc(service.mark)}</span>
          <span class="control-service-copy"><strong>${esc(service.name)}</strong><small>${esc(service.detail)} · :${service.port}</small></span>
          <span class="control-service-state ${tile.cls}">${tile.text}</span>
        </a>`;
      }).join('')}
    </div>
    <section class="control-section">
      <div class="control-section-title">
        <div><h3>更新部署</h3><span class="muted">${esc(update.repository || '-')} · ${esc(update.branch || 'main')}</span></div>
        <span class="control-service-state ${update.status === 'failed' ? 'offline' : update.enabled ? 'online' : ''}" data-hub-deploy-state>${esc(updateState)}</span>
      </div>
      <div class="update-deploy-summary">
        <div><span>当前版本</span><strong data-hub-deploy="current">${esc(revision(update.currentRevision))}</strong></div>
        <div><span>目标版本</span><strong data-hub-deploy="target">${esc(revision(update.targetRevision))}${update.targetVersion ? ` · ${esc(update.targetVersion)}` : ''}</strong></div>
        <div><span>上次检查</span><strong data-hub-deploy="lastCheck">${update.lastCheckAt ? esc(fmtTime(update.lastCheckAt)) : '-'}</strong></div>
        <div><span>下次检查</span><strong data-hub-deploy="nextCheck">${update.nextCheckAt ? esc(fmtTime(update.nextCheckAt)) : '-'}</strong></div>
      </div>
      <div class="muted" data-hub-update-check style="margin-top:6px;font-size:12px;line-height:1.5">${renderUpdateCheckNote(update)}</div>
      <div class="update-deploy-progress${progressLine ? '' : ' hidden'}" id="hub-deploy-progress">
        <span class="loading-spinner" aria-hidden="true"></span>
        <span class="update-deploy-progress-text" id="hub-deploy-progress-text" role="status" aria-live="polite">${esc(updateProgressStage(update))}</span>
        <span class="update-deploy-progress-elapsed" id="hub-deploy-progress-elapsed" aria-hidden="true">${esc(updateProgressElapsed(update))}</span>
      </div>
      <div class="update-deploy-settings">
        <label><span>告警管理员 QQ</span><input type="text" id="auto-update-owner" inputmode="numeric" value="${esc(update.ownerUin || '')}" /></label>
        <label><span>检查间隔（小时）</span><input type="number" id="auto-update-interval" min="1" max="168" value="${esc(update.intervalHours || 6)}" /></label>
      </div>
      <div class="control-result error hidden" id="hub-deploy-error" style="margin-top:8px"></div>
      <div class="settings-actions">
        <button type="button" class="btn btn-small" id="auto-update-save" ${update.busy ? 'disabled' : ''}>保存设置</button>
        <button type="button" class="btn btn-primary btn-small" id="auto-update-run" ${!update.installed || update.busy ? 'disabled' : ''}>↻ 手动更新</button>
        <button type="button" class="btn btn-small" id="auto-update-pause" ${update.enabled && !update.busy ? '' : 'disabled'}>暂停自动更新</button>
        <button type="button" class="btn btn-small" id="auto-update-resume" ${!update.enabled && update.installed && !update.busy ? '' : 'disabled'}>恢复自动更新</button>
        <span id="auto-update-result" class="control-result muted" role="status" aria-live="polite"></span>
      </div>
    </section>
    <section class="control-section">
      <h3>密钥控制</h3>
      <div class="control-key-list">
        <button type="button" class="control-key-row" data-open-settings="api">
          <span><strong>模型 API Key</strong><small>模型 API</small></span><b>管理</b>
        </button>
        <button type="button" class="control-key-row" data-open-settings="search">
          <span><strong>搜索服务 Key</strong><small>搜索服务</small></span><b>管理</b>
        </button>
        <button type="button" class="control-key-row" data-open-settings="onebot">
          <span><strong>OneBot HTTP / WS Token</strong><small>OneBot</small></span><b>管理</b>
        </button>
        <button type="button" class="control-key-row" data-open-settings="desktop">
          <span><strong>QQ Agent 控制台 Token</strong><small>系统</small></span><b>管理</b>
        </button>
        <a class="control-key-row${legacyServiceDeployed(statuses, 'bridge') ? '' : ' hidden'}" data-hub-legacy-entry="bridge" href="${esc(serviceUrl(3100))}" target="_blank" rel="noreferrer">
          <span><strong>Bridge 控制台 Token</strong><small>旧架构控制台</small></span><b>打开</b>
        </a>
      </div>
    </section>
    <section class="control-section">
      <div class="control-section-title">
        <div><h3>SnowLuma 登录密钥</h3><span class="muted">修改后 SnowLuma WebUI 的现有登录会话会失效</span></div>
        <a class="btn btn-small" href="${esc(serviceUrl(5099, '/settings?tab=account'))}" target="_blank" rel="noreferrer">打开账号安全</a>
      </div>
      <form id="snowluma-password-form" class="control-password-form" autocomplete="off">
        <!-- 浏览器要求密码表单带用户名框（可隐藏），否则 F12 里会有一条 DOM 提示。
             这里是给 SnowLuma 改密钥、不是登录，放个隐藏占位即可。 -->
        <input type="text" id="snowluma-account" name="username" value="snowluma" autocomplete="username" hidden aria-hidden="true" tabindex="-1" />
        <label><span>当前密钥</span><input type="password" id="snowluma-current-password" autocomplete="current-password" required /></label>
        <label><span>新密钥</span><input type="password" id="snowluma-new-password" autocomplete="new-password" placeholder="至少 10 位，含大小写与符号" required /></label>
        <label><span>确认新密钥</span><input type="password" id="snowluma-confirm-password" autocomplete="new-password" required /></label>
        <button type="submit" class="btn btn-primary" id="snowluma-password-submit">更新密钥</button>
      </form>
      <div id="snowluma-password-result" class="control-result muted" role="status" aria-live="polite"></div>
    </section>`;
  // 结构只建一次：之后只更新易变字段（服务状态/部署状态/版本时间/按钮可用性）。
  // 之前每次刷新都整页重建，看起来是"整页闪一下"，也会把别的模块注入的内容抹掉。
  if (!box.__hubBuilt) {
    box.__hubBuilt = true;
    box.__renderedHtml = null;
    box.innerHTML = __html;
    bindControlHubHandlers();
    box.__renderedHtml = __html;
  }
  updateControlHubFields(box, statuses, update);
}

// 首次建结构后绑定一次事件即可（DOM 不再重建，不需要重复绑）
function bindControlHubHandlers() {
  const box = $('#control-page');
  if (!box) return;
  $('#control-refresh')?.addEventListener('click', () => loadControlHub({ force: true }));
  $('#auto-update-save')?.addEventListener('click', () => saveAutoUpdateSettings(false));
  $('#auto-update-run')?.addEventListener('click', runManualUpdate);
  $('#auto-update-resume')?.addEventListener('click', () => saveAutoUpdateSettings(true));
  $('#auto-update-pause')?.addEventListener('click', pauseAutoUpdate);
  $$('#control-page [data-open-settings]').forEach((button) => {
    button.addEventListener('click', () => {
      state.settingsSection = button.dataset.openSettings;
      switchTab('settings');
    });
  });
  $('#snowluma-password-form')?.addEventListener('submit', changeSnowLumaPassword);
}

// 控制页的易变字段：就地更新文本/类，不重建 DOM（也就不会闪）
function updateControlHubFields(box, statuses, update) {
  if (!box) return;
  const labels = {
    idle: '等待检查', disabled: '已暂停', queued: '等待启动', checking: '检查更新',
    testing: '验证更新', deploying: '部署中', succeeded: '更新成功',
    'no-update': '已是最新', failed: '更新失败'
  };
  const updateState = update.status === 'failed'
    ? labels.failed
    : update.enabled ? (labels[update.status] || '等待检查') : '已暂停';
  const revision = (value) => value ? String(value).slice(0, 12) : '-';
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };

  // 服务卡片状态
  for (const [id, status] of statuses) {
    const el = box.querySelector('[data-hub-service="' + id + '"] .control-service-state');
    if (!el) continue;
    const tile = serviceTileState(id, status);
    setText(el, tile.text);
    const cls = 'control-service-state ' + tile.cls;
    if (el.className !== cls) el.className = cls;
  }
  // 旧架构入口每次同步都跟着状态走：结构只在首次建，光在模板里判断的话，
  // 部署重启期间 integrations 拉取失败重建页面后，入口可能一直留在页面上（与"未部署"的卡片自相矛盾）。
  const legacyEntry = box.querySelector('[data-hub-legacy-entry="bridge"]');
  if (legacyEntry) legacyEntry.classList.toggle('hidden', !legacyServiceDeployed(statuses, 'bridge'));

  // 部署状态徽标
  const badge = box.querySelector('[data-hub-deploy-state]');
  if (badge) {
    setText(badge, updateState);
    const cls = 'control-service-state ' + (update.status === 'failed' ? 'offline' : update.enabled ? 'online' : '');
    if (badge.className !== cls) badge.className = cls;
  }

  // 版本与检查时间
  const summary = {
    current: revision(update.currentRevision),
    target: revision(update.targetRevision),
    lastCheck: update.lastCheckAt ? fmtTime(update.lastCheckAt) : '-',
    nextCheck: update.nextCheckAt ? fmtTime(update.nextCheckAt) : '-'
  };
  for (const [field, text] of Object.entries(summary)) {
    setText(box.querySelector('[data-hub-deploy="' + field + '"]'), text);
  }

  // 输入框：只在用户没在编辑、且值确实不同时同步
  const syncInput = (id, value) => {
    const el = document.getElementById(id);
    if (!el || document.activeElement === el) return;
    const next = String(value ?? '');
    if (el.value !== next) el.value = next;
  };
  syncInput('auto-update-owner', update.ownerUin || '');
  syncInput('auto-update-interval', update.intervalHours || 6);

  // 错误行
  const errorBox = document.getElementById('hub-deploy-error');
  if (errorBox) {
    setText(errorBox, update.error || '');
    errorBox.classList.toggle('hidden', !update.error);
  }

  // 更新进度：排队 / 检查 / 测试 / 部署 各阶段显示一行带耗时，跑完自动隐藏
  const progressBox = document.getElementById('hub-deploy-progress');
  if (progressBox) {
    const line = updateProgressText(update);
    // 阶段走 aria-live（变化时播报），耗时放 aria-hidden —— 否则读屏每秒念一次
    setText(document.getElementById('hub-deploy-progress-text'), updateProgressStage(update));
    setText(document.getElementById('hub-deploy-progress-elapsed'), updateProgressElapsed(update));
    progressBox.classList.toggle('hidden', !line);
    if (line) startUpdateProgressTicker();
  }

  // 按钮可用性 / 暂停与恢复的显隐
  const runBtn = document.getElementById('auto-update-run');
  if (runBtn) runBtn.disabled = !update.installed || update.busy === true;
  const saveBtn = document.getElementById('auto-update-save');
  if (saveBtn) saveBtn.disabled = update.busy === true;
  const pauseBtn = document.getElementById('auto-update-pause');
  if (pauseBtn) {
    pauseBtn.hidden = update.enabled !== true;
    pauseBtn.disabled = update.busy === true;
  }
  const resumeBtn = document.getElementById('auto-update-resume');
  if (resumeBtn) {
    resumeBtn.hidden = update.enabled === true;
    resumeBtn.disabled = !update.installed || update.busy === true;
  }
}

async function loadControlHub({ force = false } = {}) {
  const box = $('#control-page');
  if (!box) return;
  if ((!state.integrationStatus || force) && !box.__hubBuilt) {
    // 只有首次进入（还没有结构）才写占位；刷新时保留现有页面，避免"整页清空再重建"
    box.innerHTML = '<div class="empty-hint">正在检查服务…</div>';
  }
  try {
    const [integrations, update] = await Promise.all([
      api('/api/integrations/status'),
      api('/api/auto-update/status')
    ]);
    state.integrationStatus = integrations;
    state.autoUpdateStatus = update;
    if (state.tab === 'control') renderControlHub(state.integrationStatus);
  } catch (error) {
    // 读取失败（部署重启期间很常见）会把结构换成错误提示，此时必须把 __hubBuilt 归零：
    // 否则下一次成功刷新只跑 updateControlHubFields，元素已不在 DOM，页面永远停在
    // 这句错误提示上（按钮也失效）——进度行同样会被吞掉。
    box.__hubBuilt = false;
    box.__renderedHtml = null;
    box.innerHTML = `<div class="empty-hint">服务状态读取失败：${esc(error.message)}</div>`;
  }
}

async function refreshAutoUpdateStatus() {
  try {
    state.autoUpdateStatus = await api('/api/auto-update/status');
    if (state.tab === 'control') renderControlHub(state.integrationStatus || {});
  } catch {
    // A deployment restart can briefly interrupt polling; EventSource and the
    // next interval will reconnect without replacing the current status.
  }
}

function autoUpdateSettingsBody() {
  return {
    ownerUin: $('#auto-update-owner')?.value?.trim() || '',
    intervalHours: clampInt($('#auto-update-interval')?.value, 1, 168, 6)
  };
}

async function saveAutoUpdateSettings(resume) {
  const result = $('#auto-update-result');
  if (resume && !await askForConfirmation('恢复定时拉取 GitHub 并自动部署？部署失败时会自动暂停并通知管理员。')) {
    return;
  }
  if (result) result.textContent = resume ? '正在恢复…' : '正在保存…';
  try {
    const response = await api(
      resume ? '/api/auto-update/resume' : '/api/auto-update/settings',
      {
        method: resume ? 'POST' : 'PUT',
        body: JSON.stringify({
          ...autoUpdateSettingsBody(),
          ...(resume ? { confirm: true } : {})
        })
      }
    );
    state.autoUpdateStatus = response.status;
    renderControlHub(state.integrationStatus || {});
  } catch (error) {
    if (result) {
      result.textContent = `操作失败：${error.message}`;
      result.className = 'control-result error';
    }
  }
}

async function pauseAutoUpdate() {
  if (!await askForConfirmation('暂停自动更新？手动更新仍可使用。')) return;
  const result = $('#auto-update-result');
  if (result) result.textContent = '正在暂停…';
  try {
    const response = await api('/api/auto-update/pause', {
      method: 'POST',
      body: JSON.stringify({ confirm: true })
    });
    state.autoUpdateStatus = response.status;
    renderControlHub(state.integrationStatus || {});
  } catch (error) {
    if (result) result.textContent = `暂停失败：${error.message}`;
  }
}

async function runManualUpdate() {
  if (!await askForConfirmation('立即检查 GitHub 最新代码并尝试部署？服务会在部署阶段短暂重启。')) {
    return;
  }
  const result = $('#auto-update-result');
  if (result) result.textContent = '更新任务已提交…';
  try {
    const response = await api('/api/auto-update/run', {
      method: 'POST',
      body: JSON.stringify({ confirm: true })
    });
    state.autoUpdateStatus = response.status;
    renderControlHub(state.integrationStatus || {});
  } catch (error) {
    if (result) {
      result.textContent = `启动失败：${error.message}`;
      result.className = 'control-result error';
    }
  }
}

// ── 发现新版本提示（只在控制台打开时检查一次；失败静默）───────────────────────
async function checkUpdateNotice() {
  let payload = null;
  try {
    payload = await api('/api/auto-update/check');
  } catch {
    return;
  }
  const notice = payload?.notice || {};
  if (!notice.available) return;
  const version = String(notice.version || '');
  // 「忽略」只屏蔽这一个版本；出现新的 tag 时照常提示
  if (version && version === String(payload.ignoredVersion || '')) return;
  // 已经有一次部署在队列里/正在跑：别再弹。
  // 部署完成前 deployed-revision 还是旧的，光比版本会一直认为"有新版本没装"，
  // 于是每次刷新都弹一遍，看着像"点了更新没反应"（2026-09-21 反馈）。
  // 版本号可能还没解析出来（更新器跑到 testing 阶段才写），所以"排队中且不知道版本"
  // 也要压住；但 probe（只探连通性、不部署）不算。
  const pending = payload?.pending || null;
  if (pending && pending.mode !== 'probe'
    && (!pending.version || String(pending.version) === version)) return;
  openUpdateNoticeDialog(notice);
}

// Release 说明是 markdown；先整体转义，再把标题/加粗/列表替换成最小样式，
// 避免把 --- 之类的分隔线与标题混在一起时出现乱码感。
function formatReleaseNotes(body) {
  return esc(String(body || '').trim())
    .replace(/^#{1,6}\s*(.+)$/gm, '<strong>$1</strong>')
    .replace(/^[*-]\s+/gm, '• ')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function openUpdateNoticeDialog(notice) {
  const dialog = $('#update-notice');
  if (!dialog) return;
  const short = (value) => String(value || '').slice(0, 7);
  state.updateNoticeVersion = String(notice.version || '');
  $('#update-notice-title').textContent = notice.version ? `发现新版本 ${notice.version}` : '发现新版本';
  $('#update-notice-sub').textContent = [
    String(notice.name || '').trim(),
    `当前 ${short(notice.deployed) || '未知'} → 最新 ${short(notice.revision) || '未知'}`,
    Number(notice.commitCount) > 0 ? `${Number(notice.commitCount)} 个新提交` : ''
  ].filter(Boolean).join(' · ');
  $('#update-notice-notes').innerHTML = String(notice.body || '').trim()
    ? formatReleaseNotes(notice.body)
    : '本次更新还没有发布说明，可以先到仓库看提交记录。';
  const result = $('#update-notice-result');
  if (result) { result.textContent = ''; result.className = 'control-result muted'; }
  const runBtn = $('#update-notice-run');
  if (runBtn) runBtn.disabled = false;
  const ignoreBtn = $('#update-notice-ignore');
  if (ignoreBtn) ignoreBtn.hidden = !notice.version; // 没有 tag 时没法精确忽略
  if (!dialog.open) dialog.showModal();
}

async function runUpdateFromNotice() {
  const result = $('#update-notice-result');
  const runBtn = $('#update-notice-run');
  if (runBtn) runBtn.disabled = true;
  if (result) { result.textContent = '正在提交更新任务…'; result.className = 'control-result muted'; }
  try {
    const response = await api('/api/auto-update/run', {
      method: 'POST',
      // 带上当前提示的版本：写进状态里，"别再弹同一个版本"才能立刻生效
      body: JSON.stringify({ confirm: true, version: state.updateNoticeVersion || '' })
    });
    state.autoUpdateStatus = response.status;
    // 提交成功就关掉提示框，切到「控制 → 更新部署」：进度（阶段 + 已耗时）显示在那一块，
    // 由状态派生、整页重绘也不会丢。以前这里留着框只把按钮点灰，用户看不到任何进展
    // （2026-09-22 反馈）。
    $('#update-notice')?.close();
    switchTab('control');
  } catch (error) {
    // 提交失败：框留着，错误直接显示在框里
    if (runBtn) runBtn.disabled = false;
    if (result) { result.textContent = `启动失败：${error.message}`; result.className = 'control-result error'; }
  }
}

async function ignoreUpdateVersion() {
  const version = String(state.updateNoticeVersion || '');
  if (!version) return;
  try {
    await api('/api/auto-update/ignore', { method: 'POST', body: JSON.stringify({ version }) });
  } catch { /* 忽略失败就当作稍后处理，下次打开仍会提示 */ }
  $('#update-notice')?.close();
}

async function changeSnowLumaPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const currentPassword = $('#snowluma-current-password')?.value || '';
  const newPassword = $('#snowluma-new-password')?.value || '';
  const confirmPassword = $('#snowluma-confirm-password')?.value || '';
  const result = $('#snowluma-password-result');
  if (newPassword !== confirmPassword) {
    result.textContent = '两次输入的新密钥不一致。';
    result.className = 'control-result error';
    return;
  }
  if (
    newPassword.length < 10
    || !/[a-z]/.test(newPassword)
    || !/[A-Z]/.test(newPassword)
    || !/[^A-Za-z0-9\s]/.test(newPassword)
    || /\s/.test(newPassword)
  ) {
    result.textContent = '新密钥至少 10 位，且需包含大小写字母和特殊符号。';
    result.className = 'control-result error';
    return;
  }
  if (!await askForConfirmation('更新 SnowLuma 登录密钥并注销其现有 WebUI 会话？')) return;
  const button = $('#snowluma-password-submit');
  button.disabled = true;
  result.textContent = '正在更新…';
  result.className = 'control-result muted';
  try {
    await api('/api/integrations/snowluma/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    form.reset();
    result.textContent = 'SnowLuma 登录密钥已更新。';
    result.className = 'control-result success';
  } catch (error) {
    result.textContent = `更新失败：${error.message}`;
    result.className = 'control-result error';
  } finally {
    button.disabled = false;
  }
}

// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    // 状态条本身截断显示（顶栏高度锁死），失败原因放 title，鼠标悬停就能看到
    const obIssue = onebotIssueText(s.onebot);
    dot.title = obIssue ? `OneBot：${obIssue}` : 'OneBot 连接状态';
    label.title = obIssue;
    label.textContent = s.onebot.connected
      ? `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
      : 'OneBot 未连接';
    setStatusLabel('#model-label', `模型：${s.orchestrator.model || '未设置'}`);
    const u = s.usage;
    // 成本：查得到价就显示；查不到（未定价，转站/新模型常见）就不显示金额，
    // 只提示"含未定价调用"，避免让 ¥0 被读成"免费"。
    const c = s.cost;
    const costTxt = c && c.cost > 0 ? ` · ¥${c.cost.toFixed(3)}` : '';
    // 按账户口径换个说法：倍率=你的渠道价、按月付=包月（不按 token 算）
    const modeTxt = c?.costMode === 'subscription'
      ? (Number(c.costMonthlyFee) > 0 ? ` · 包月 ¥${Number(c.costMonthlyFee)}/月` : ' · 按月付')
      : (c?.costMode === 'multiplier' ? `（官方价 ×${mulOf(c.costMultiplier)}）` : '');
    const unpricedTxt = c && c.unpriced ? ' · 含未定价调用' : '';
    const rate = s.cacheHitRate;
    const rateTxt = rate > 0 ? ` · 缓存 ${Math.round(rate * 100)}%` : '';
    setStatusLabel('#usage-label', `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${rateTxt}${costTxt}${modeTxt}${unpricedTxt}`);
    setStatusLabel('#search-count-label', `搜索：${s.webSearchCount ?? u.webSearchCount ?? 0} 次`);
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    // 首次状态到达后放开运行模式下拉（此前禁用，避免把"还没加载"看成"观察模式"）
    const runtimeMode = $('#runtime-mode');
    if (runtimeMode && runtimeMode.disabled) runtimeMode.disabled = false;
    if ($('#runtime-mode')) $('#runtime-mode').value = s.orchestrator.mode || 'observe';
    if (s.timeControl?.enabled) {
      setStatusLabel('#model-label', $('#model-label').textContent + (s.timeControl.active ? ' · 活跃时段' : ' · 非活跃时段'));
    }
    if (state.tab === 'settings' && state.settingsSection === 'time-control') loadTimeControlStatus();
    if (state.tab === 'settings' && state.settingsSection === 'onebot') updateOnebotStatusLine();
    if (state.tab === 'settings' && state.settingsSection === 'moments') loadDailyMomentsStatus();
    if (state.tab === 'settings' && state.settingsSection === 'qzone-interactions') {
      loadQzoneInteractionStatus();
    }
    if (state.tab === 'settings' && state.settingsSection === 'experiments') {
      loadExperimentalFeatureStatuses();
    }
    if (state.tab === 'identity') loadIdentityFeaturePage();
    if (state.tab === 'friends') loadFriendFeaturePage();
    if (state.tab === 'incidents') loadIncidentFeaturePage();
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

$('#console-login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: $('#console-token').value })
  });
  if (response.ok) { location.reload(); return; }
  $('#console-login-error').textContent = 'Token 不正确';
});

$('#runtime-mode')?.addEventListener('change', async (event) => {
  const mode = event.target.value;
  if (
    mode === 'active'
    && !await askForConfirmation('确认旧实例已停用这些会话，或新实例使用不同 QQ 账号？启用时将跳过观察期间的积压消息。')
  ) {
    event.target.value = 'observe';
    return;
  }
  try {
    await api('/api/runtime', { method: 'POST',
      body: JSON.stringify({ mode, confirmExclusive: mode === 'active', skipBacklog: mode === 'active' }) });
  } catch (error) { alert(error.message); }
  await refreshStatus();
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 曾经来一条事件就全量重建一次会话列表 + 会话详情（含大提示词的 esc/innerHTML），
// 主线程被反复长阻塞，详情内容反而"更新缓慢"、还伴随滚动跳动。
// 现在：patch 立即进 state（数据不延迟），渲染合并到短定时器一次；
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转根本不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：
//    窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台
//    才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。
//    setTimeout 在后台页面仍会执行（最多被节流到 1s），远比不执行强。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => {
    // 新运行只刷新列表。用户已经在阅读某个 Session 时绝不抢占右侧详情；
    // currentSessionId 为空的首屏场景由 loadSessions 自行选择活动会话。
    loadSessions({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('session-update', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const id = data.sessionId;
    if (!id) return;
    // SSE 事件本身携带完整会话快照：patch 立即进 state，渲染走合批（见上）
    const patch = {
      id,
      chatKey: data.chatKey || '',
      status: data.status,
      waitUntil: data.waitUntil ?? null,
      activity: data.activity || '',
      webSearchCount: data.webSearchCount || 0,
      rounds: data.rounds || 0,
      usage: data.usage || null,
      messages: data.messages || [],
      triggerKind: data.triggerKind || '',
      triggerReason: data.triggerReason || '',
      conversationMode: data.conversationMode || 'legacy',
      threadId: data.threadId ?? null,
      threadState: data.threadState ?? null,
      lifecycle: data.lifecycle || null,
      promptLayout: data.promptLayout || '',
      lifecycleContinuation: data.lifecycleContinuation === true,
      callUsage: data.callUsage || [],
      sessionMetrics: data.sessionMetrics || null,
      triggerSummary: data.triggerSummary ?? '',
      startedAt: data.startedAt ?? 0
    };
    // sent/finishReason 等收尾字段：后端给了才进 patch。
    // 不能无脑写 null —— pending 合并时 null 会把之前已有的值冲掉。
    if (Array.isArray(data.sent)) patch.sent = data.sent;
    if (data.finishReason !== undefined) patch.finishReason = data.finishReason;
    if (data.error !== undefined) patch.error = data.error;
    if (data.endedAt !== undefined) patch.endedAt = data.endedAt;
    const existing = state.sessions.find((s) => s.id === id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.sessions.unshift({ ...patch, trigger: data.trigger || '', triggerSummary: data.triggerSummary || '', startedAt: data.startedAt ?? Date.now() });
      // 上限要大于一次可取的数量，否则新会话一进来就把旧的挤没了
      state.sessions = state.sessions.slice(0, SESSION_KEEP);
    }
    // 详情 patch 合并暂存，渲染合批到每帧一次（不再来一条事件全量重建一次）
    pendingSessionDetail.set(id, { ...pendingSessionDetail.get(id), ...patch });
    scheduleSessionRender();
  });
  es.addEventListener('session-end', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* 数据坏了也照常刷列表 */ }
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
    // ⚠️ 会话刚结束必须主动重拉一次详情：轮询只刷 running/waiting 的会话，
    //    最终态（sent / finishReason / error）之后再也不来 —— 不重拉的话，
    //    "已发送到 QQ"徽标和收尾状态只能等用户手动刷新才出现。
    const id = data.sessionId;
    if (id && id === state.currentSessionId) {
      pendingSessionDetail.delete(id);   // 丢弃残留的过期 patch，防止把刚拉的最终态回闪成旧值
      loadSessionDetail(id, { quiet: true });
    }
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('memory-update', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { data = { phase: 'refresh' }; }
    const phase = data.phase || '';
    const chatKey = data.chatKey || '';

    // 状态一律记进 state（不依赖当前 DOM），这样切走页签再切回也能恢复显示。
    // 原先只操作 DOM 且 tab 不对就 return，导致切回来完全看不出整理是否还在跑。
    if (phase === 'consolidate-start') {
      if (chatKey) state.consolidating[chatKey] = { startedAt: Date.now() };
    } else if (phase === 'consolidate-done') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) state.consolidateResult[chatKey] = { note: data.note || '整理完成', at: Date.now() };
    } else if (phase === 'consolidate-error') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) {
        state.consolidateResult[chatKey] = { note: `整理失败：${data.error || '未知错误'}`, at: Date.now(), failed: true };
      }
    }

    // 只有停在记忆页时才操作 DOM / 刷新列表
    if (state.tab !== 'memory') return;

    if (phase === 'consolidate-start') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = true;
      if (status) status.textContent = '整理中…';
      renderMemoryList();
    } else if (phase === 'consolidate-done') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = data.note || '整理完成';
      loadMemoryView();
    } else if (phase === 'consolidate-error') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = `整理失败：${data.error || '未知错误'}`;
      renderMemoryList();
    } else {
      loadMemoryView();
    }
  });
  es.addEventListener('onebot-status', () => {
    refreshStatus();
  });
  es.addEventListener('asset-update', () => {
    if (state.tab !== 'assets') return;
    state.assetOverview = null;
    state.assetDetail = null;
    loadAssetObservatory();
  });
  es.addEventListener('identity-pilot-update', () => {
    if (state.tab === 'settings' && state.settingsSection === 'experiments') {
      loadExperimentalFeatureStatuses();
    }
    if (state.tab === 'identity') loadIdentityFeaturePage();
    if (state.tab === 'friends') loadFriendFeaturePage();
  });
  es.addEventListener('slang-pilot-update', () => {
    if (state.tab === 'assets' && state.assetKind === 'slang-research') {
      state.assetOverview = null;
      state.assetDetail = null;
      loadAssetObservatory();
    }
    if (state.tab === 'settings' && state.settingsSection === 'experiments') {
      loadExperimentalFeatureStatuses();
    }
    if (state.tab === 'slang') loadSlangFeaturePage();
  });
  es.addEventListener('incident-pilot-update', () => {
    if (state.tab === 'settings' && state.settingsSection === 'experiments') {
      loadExperimentalFeatureStatuses();
    }
    if (state.tab === 'incidents') loadIncidentFeaturePage();
    if (state.tab === 'chats') loadChats({ quiet: true });
  });
  es.addEventListener('auto-update', () => {
    if (state.tab === 'control') loadControlHub({ force: true });
  });
  es.addEventListener('status', () => refreshStatus());
  es.addEventListener('feedback', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    // 一次全取：后端上限 2^20（约等于不限），前端靠分页渲染（SESSION_PAGE）避免卡顿
    const data = await api('/api/sessions?limit=1048576');
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
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」）；此前这里硬编码 4000，
// 配置项从未被读取 —— 用户改了完全没效果。
let listPoller = null;
function refreshIntervalMs() {
  const n = Number(state.config?.ui?.refreshMs);
  return Number.isFinite(n) && n >= 1000 ? n : 4000;
}
/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：曾经是被节流的事件直接丢弃 —— 快速滚动时
 *      事件密集，"抵达底部"那一下几乎总是落在 120ms 窗口内被扔掉，
 *      用户停手后又不会再有新事件 → 加载永远不触发，表现为
 *      "滚得快会滚不下去，像撞墙"。现在窗口内的事件会留下一个尾随定时器，
 *      停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发（曾经是 100px）：快速甩滚时惯性大，
 *      100px 的提前量太小，内容还没加载出来人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数会被多次调用（渲染一次调一次），
  //    曾经没做防护，结果加载 N 批就挂了 N 个监听器 ——
  //    滚一次会同时触发 N 次 onLoadMore，一次跳好几批，
  //    而且每个监听器各有自己的 last 变量，120ms 节流形同虚设。
  //    这里把状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用 —— 停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/** 会话列表：滚到底部再加载 SESSION_PAGE 条。 */
function initSessionScrollLoader() {
  attachScrollLoader('session-list', () => {
    const all = state.sessions || [];
    if (state.sessionLimit >= all.length) return;   // 已经全显示了
    state.sessionLimit = Math.min(all.length, state.sessionLimit + SESSION_PAGE);
    renderSessionList();
  });
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail —— 它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。曾经在它内部又套了一层 .archive-scroll 想做内层滚动，
 *   结果内层没有高度基准、被内容撑开，滚动事件全发生在外层，
 *   导致监听挂空、"继续滚动没反应"。现在只保留一层滚动容器。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）：
 *   曾经这里调 updateChatMessagesBody(true)，每批都要全量 sort + 全量
 *   innerHTML 重建（行数越滚越多），还有 scrollTop 补偿把视口"吸"在底部
 *   → 连锁触发下一批加载 → 主线程被反复长阻塞，
 *   表现为"滑到临界线继续向下滚动反应迟钝"。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => {
    const total = (state.chatMessages || []).length;
    const prev = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
    if (prev >= total) return;                     // 已经全显示了
    state.chatMsgLimit = Math.min(total, prev + CHAT_MSG_MORE);
    // 行数账本对不上（结构刚被轮询重建过等异常）→ 全量兜底；正常走追加
    if ((state.chatMsgRendered || 0) !== Math.min(prev, total)) {
      updateChatMessagesBody(true);
    } else {
      appendChatMessageRows(prev);
    }
  });
}

function startListPoller() {
  if (listPoller) clearInterval(listPoller);
  listPoller = setInterval(() => {
    if (state.tab === 'control') refreshAutoUpdateStatus();
    if (state.tab === 'sessions') loadSessions({ quiet: true });
    if (state.tab === 'chats') loadChats({ quiet: true });
    if (state.tab === 'usage') loadUsageView();   // 无 force：只更新数值，不重建 DOM
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
}
startListPoller();

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
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  const all = state.sessions || [];
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
        data-id="${s.latestSessionId}" data-display-key="${esc(s.displayKey)}" role="button" tabindex="0">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger"><span class="trigger-method">${esc(triggerLabel)}</span><span>${esc(s.trigger || '')}${runLabel ? ` · ${runLabel}` : ''}</span></div>
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
  patchKeyedList(box, sessionRows, 'data-display-key');
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
}

function updateSessionListSelection() {
  const selected = buildSessionDisplayItems(state.sessions || [])
    .find((item) => item.sessionIds.includes(state.currentSessionId));
  $$('.session-item', $('#session-items')).forEach((element) => {
    element.classList.toggle('selected', element.dataset.displayKey === selected?.displayKey);
  });
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

let waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(() => {
    const els = $$('.session-wait[data-until]');
    if (!els.length) {
      clearInterval(waitTicker);
      waitTicker = null;
      return;
    }
    for (const el of els) {
      const until = Number(el.dataset.until);
      const remain = until - Date.now();
      el.textContent = remain > 0 ? `等待中 · ${(remain / 1000).toFixed(1)}s` : '等待中 · 启动…';
    }
  }, 100);
}

let lifecycleTicker = null;
function startLifecycleTicker() {
  if (lifecycleTicker) return;
  lifecycleTicker = setInterval(() => {
    const elements = $$('.lifecycle-remaining[data-deadline]');
    if (!elements.length) {
      clearInterval(lifecycleTicker);
      lifecycleTicker = null;
      return;
    }
    for (const element of elements) {
      element.textContent = lifecycleRemainingText(
        Number(element.dataset.deadline),
        element.dataset.lifecycleState || ''
      );
    }
  }, 1000);
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
  lastDetailFp = null;
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

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

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

function fmtRate(rate, available) {
  return available ? `${(Math.min(1, Math.max(0, Number(rate) || 0)) * 100).toFixed(1)}%` : '-';
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

function renderSessionDetail(s, {
  scrollMode = null,
  scrollTop = null,
  timelineScrollLeft = null
} = {}) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  // json 模式切换也要触发重渲染
  const fp = `${s.id}|${s.status}|${s.conversationMode || 'legacy'}|${s.threadState || ''}|${s.lifecycle?.state || ''}|${s.lifecycle?.deadline || 0}|${s.triggerKind || ''}|${s.rounds || 0}|${s.inputRound || 0}|${s.inputPayloadChars || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.activity || ''}|${s.sessionMetrics?.estimatedCost || 0}|${state.sessionInspectorTab}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

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
    lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  detail.querySelectorAll('[data-context-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sessionInspectorTab = button.dataset.contextTab;
      lastDetailFp = null;
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

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function chatControlIcon(chat) {
  const mode = chat.incidentControl?.mode || 'auto';
  if (mode === 'blocked') return { icon: '■', label: '会话已阻塞' };
  if (mode === 'continue') return { icon: '▶', label: '会话强制继续' };
  if (chat.incidentDecision?.effectiveState === 'degraded') {
    return { icon: '!', label: '会话降级运行' };
  }
  return { icon: '◉', label: '会话自动处理' };
}

async function openChatRuntimeControl(chatKey) {
  const data = await api(`/api/chats/${chatKey.replace(':', '_')}/runtime-control`);
  const control = data.control || { mode: 'auto', reason: '', version: 0 };
  const overlay = modelModalShell({
    head: `会话运行控制 · ${formatChatTitle(chatKey, chatNameOf(chatKey))}`,
    body: `
      <div class="field"><label>运行模式</label>
        <select id="chat-runtime-mode">
          <option value="auto" ${control.mode === 'auto' ? 'selected' : ''}>自动处理（推荐）</option>
          <option value="blocked" ${control.mode === 'blocked' ? 'selected' : ''}>阻塞会话</option>
          <option value="continue" ${control.mode === 'continue' ? 'selected' : ''}>继续处理新消息</option>
        </select></div>
      <div class="field"><label>原因</label><input type="text" id="chat-runtime-reason" value="${esc(control.reason || '')}" placeholder="可选，记录人工操作原因" /></div>
      <div class="field"><label>积压消息</label>
        <select id="chat-runtime-backlog">
          <option value="keep">保留未读，暂不唤醒</option>
          <option value="recent">仅处理最近一批</option>
          <option value="discard">从下一条新消息开始</option>
        </select></div>
      <div class="hint">当前未读 ${fmtTok(data.unread)} 条，待核对写入 ${fmtTok(data.held)} 条。继续模式不会重试未知旧写入，也不能绕过全局观察、白名单或时间控制。</div>`,
    foot: '<button type="button" class="btn" data-control-cancel>取消</button>'
      + '<button type="button" class="btn btn-primary" data-control-save>保存</button>'
  });
  overlay.querySelector('[data-control-cancel]').addEventListener('click', () =>
    closeModelModal(overlay));
  overlay.querySelector('[data-control-save]').addEventListener('click', async () => {
    const mode = overlay.querySelector('#chat-runtime-mode').value;
    const button = overlay.querySelector('[data-control-save]');
    button.disabled = true;
    try {
      await api(`/api/chats/${chatKey.replace(':', '_')}/runtime-control`, {
        method: 'PUT',
        body: JSON.stringify({
          mode,
          reason: overlay.querySelector('#chat-runtime-reason').value.trim(),
          backlogAction: overlay.querySelector('#chat-runtime-backlog').value,
          expectedVersion: control.version,
          confirm: mode === 'continue'
        })
      });
      closeModelModal(overlay);
      await loadChats();
    } catch (error) {
      button.disabled = false;
      alert(error.message);
    }
  });
}

async function openUnknownOperations(chatKey) {
  const data = await api(`/api/chats/${chatKey.replace(':', '_')}/unknown-operations`);
  const operations = data.operations || [];
  const overlay = modelModalShell({
    head: `核对未知写入 · ${formatChatTitle(chatKey, chatNameOf(chatKey))}`,
    body: operations.length
      ? `<div class="control-key-list">${operations.map((operation) => `
          <div class="control-key-row">
            <span><strong>${esc(operation.payload?.type || '外部操作')}</strong>
              <small>${esc(JSON.stringify(operation.payload || {}).slice(0, 180))}</small>
              <small>${esc(operation.error || '结果未知')}</small></span>
            <span class="settings-actions" style="margin:0">
              <button type="button" class="btn btn-small" data-unknown-result="sent" data-operation-id="${esc(operation.id)}">确认已发送</button>
              <button type="button" class="btn btn-small" data-unknown-result="failed" data-operation-id="${esc(operation.id)}">确认未发送</button>
            </span>
          </div>`).join('')}</div>`
      : '<div class="empty-hint">没有待核对的外部写入</div>',
    foot: '<button type="button" class="btn" data-unknown-close>关闭</button>'
  });
  overlay.querySelector('[data-unknown-close]').addEventListener('click', () =>
    closeModelModal(overlay));
  overlay.querySelectorAll('[data-unknown-result]').forEach((button) => {
    button.addEventListener('click', async () => {
      const sent = button.dataset.unknownResult === 'sent';
      if (!await askForConfirmation(sent
        ? '确认已在 QQ 中看到这次操作成功？不会再次发送。'
        : '确认这次操作未成功？系统也不会自动重试。')) return;
      await api(
        `/api/chats/${chatKey.replace(':', '_')}/unknown-operations/${encodeURIComponent(button.dataset.operationId)}/reconcile`,
        {
          method: 'POST',
          body: JSON.stringify({
            result: button.dataset.unknownResult,
            confirm: true
          })
        }
      );
      closeModelModal(overlay);
      await loadChats();
    });
  });
}

function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  // 存档筛选（关键字 + 类型，纯前端过滤）；控件是 index.html 里的静态元素，绑一次即可
  if (!box.__archiveFilterBound) {
    box.__archiveFilterBound = true;
    $('#archive-search')?.addEventListener('input', () => renderChatList());
    $('#archive-filter-type')?.addEventListener('change', () => renderChatList());
  }
  const q = String($('#archive-search')?.value || '').trim().toLowerCase();
  const ftype = String($('#archive-filter-type')?.value || 'all');
  let visibleChats = state.chats;
  if (q) visibleChats = visibleChats.filter((c) => `${formatChatTitle(c.key, chatNameOf(c.key))} ${c.lastText || ''}`.toLowerCase().includes(q));
  if (ftype === 'group' || ftype === 'private') visibleChats = visibleChats.filter((c) => c.key.startsWith(`${ftype}:`));
  else if (ftype === 'failed') visibleChats = visibleChats.filter((c) => (c.failed || 0) > 0);
  else if (ftype === 'held') visibleChats = visibleChats.filter((c) => (c.held || 0) > 0);
  const chatRows = visibleChats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    const mode = conversationModeForChat(c.key);
    let threadLabel = '';
    if (mode === 'threaded' && Number(c.thread?.engagedUntil) > Date.now()) {
      threadLabel = '续接中';
    } else if (mode === 'lifecycle' && c.thread?.state === 'active') {
      threadLabel = '生命周期·活跃';
    } else if (mode === 'lifecycle' && c.thread?.state === 'listening') {
      threadLabel = '生命周期·监听';
    } else if (mode === 'lifecycle' && c.thread?.state === 'rollover_armed') {
      threadLabel = '等待续接';
    }
    const incidentControl = chatControlIcon(c);
    const showIncidentControl = c.key.startsWith('group:')
      && state.config?.incidentPilot?.enabled === true;
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.timeControl?.enabled ? `<span class="thread-pill">${c.timeControl.active ? '活跃时段' : '仅记录'}</span>` : ''}
          ${threadLabel ? `<span class="thread-pill mode-${mode}">${threadLabel}</span>` : ''}
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
          ${showIncidentControl ? `<button type="button" class="icon-btn chat-runtime-control" data-chat-runtime="${esc(c.key)}" title="${esc(incidentControl.label)}" aria-label="${esc(incidentControl.label)}">${incidentControl.icon}</button>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条 · 失败 ${c.failed || 0} · 待确认 ${c.held || 0}${c.thread ? ` · 线程 v${c.thread.version}` : ''}</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).map((html, index) => ({ key: String(visibleChats[index].key), html }));
  patchKeyedList(box, chatRows, 'data-key');
  if (!visibleChats.length) box.innerHTML = `<div class="list-head muted">${state.chats.length ? '没有匹配筛选条件的会话' : '还没有消息存档（等白名单里的群/好友来消息）'}</div>`;
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  $$('.chat-item', box).forEach((el) => {
    if (el.__bound) return;      // 增量更新会保留旧行，别重复绑定
    el.__bound = true;
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
  $$('[data-chat-runtime]', box).forEach((button) => {
    if (button.__bound) return;
    button.__bound = true;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openChatRuntimeControl(button.dataset.chatRuntime).catch((error) => alert(error.message));
    });
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=100000`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};
  const threadStatus = meta.thread
    ? `${meta.thread.mode} · ${meta.thread.state} · v${meta.thread.version}`
    : '无活动线程';

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span><span>${esc(threadStatus)}</span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">主动唤醒</button>
      ${key.startsWith('group:') && state.config?.incidentPilot?.enabled === true
        ? `<button type="button" class="icon-btn" id="chat-runtime-control" title="更改会话运行模式" aria-label="更改会话运行模式">${chatControlIcon(meta).icon}</button>`
        : ''}
      <span class="muted chat-action-result" id="chat-wake-result" role="status"></span>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <button class="btn btn-small" id="chat-retry-btn">重试失败批次</button>
      <button class="btn btn-small" id="chat-resolve-btn">核对未知写入</button>
      <button class="btn btn-small" id="chat-thread-close-btn" ${meta.thread ? '' : 'disabled'}>结束对话线程</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // 工具栏事件：只在这里绑一次
  $('#chat-wake-btn').addEventListener('click', async () => {
    const button = $('#chat-wake-btn');
    const result = $('#chat-wake-result');
    button.disabled = true;
    result.textContent = '正在唤醒…';
    try {
      const response = await api(`/api/chats/${key.replace(':', '_')}/wake`, {
        method: 'POST',
        body: '{}'
      });
      result.textContent = response.mode === 'unread'
        ? '已开始处理未读消息'
        : '已基于最近存档开始思考';
      await refreshStatus();
    } catch (error) {
      result.textContent = `唤醒失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  $('#chat-runtime-control')?.addEventListener('click', () =>
    openChatRuntimeControl(key).catch((error) => alert(error.message)));
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
    loadChatMessages(key, { keepView: true });
  });
  $('#chat-retry-btn')?.addEventListener('click', async () => {
    if (!await askForConfirmation('重新处理确定未发送成功的失败批次？')) return;
    await api(`/api/chats/${key.replace(':', '_')}/retry-failed`, { method: 'POST', body: '{"confirm":true}' });
    loadChats();
  });
  $('#chat-resolve-btn')?.addEventListener('click', async () => {
    if (state.config?.incidentPilot?.enabled === true) {
      await openUnknownOperations(key);
      return;
    }
    if (!await askForConfirmation('已核对 QQ 中的实际发送结果？确认后将结束待确认批次，不会重发。')) return;
    await api(`/api/chats/${key.replace(':', '_')}/resolve-held`, {
      method: 'POST', body: '{"confirm":true}'
    });
    loadChats();
  });
  $('#chat-thread-close-btn')?.addEventListener('click', async () => {
    if (!await askForConfirmation('结束当前对话线程？后续普通消息将重新遵循响应档位。')) return;
    await api(`/api/chats/${key.replace(':', '_')}/thread`, { method: 'DELETE', body: '{}' });
    await loadChats();
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
      method: 'POST', body: JSON.stringify({ text })
    });
    input.value = '';
    // 同理，保持当前分页与滚动位置
    loadChatMessages(key, { keepView: true });
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();
}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  return `
    <tr class="${m.read ? '' : 'unread'}" data-midrow="${m.id}">
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || total || 0;
    cnt.textContent = t
      ? `共 ${t} 条 · 已显示 ${shownCount} 条 · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

function renderUsageSkeleton() {
  const card = '<div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
  const row = '<div class="sk-row"></div>';
  // 五张卡一行（与正式页面一致），加载完成时布局不跳
  return `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <div class="usage-days"><span class="sk-line" style="width:180px"></span></div>
      </div>
      <div class="usage-cards">${card.repeat(5)}</div>
      <div class="sk-block">${row.repeat(5)}</div>
      <div class="sk-block">${row.repeat(4)}</div>
    </div>`;
}

/** 建骨架（只建一次，轮询走 updateUsagePage 以免滚动位置丢失）。 */
function renderUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;

  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <div class="usage-days">
          ${USAGE_RANGES.map(([v, label]) => `<button class="btn btn-small" data-range="${v}">${label}</button>`).join('')}
          <button class="btn btn-small" id="usage-refresh-btn" title="立即刷新">刷新</button>
        </div>
      </div>

      <!-- 估算成本放第一张：它是这张页的主指标（accent 描边/底色突出）。
           五张卡固定一行（曾经第一张跨两列、整体占两行，已按需求改单行）。 -->
      <div class="usage-cards">
        <div class="usage-card accent">
          <div class="uc-label" data-field="cost-label">估算成本</div>
          <div class="uc-value" data-field="cost">-</div>
          <div class="uc-sub" data-field="cost-sub">-</div>
        </div>
        <div class="usage-card clickable" id="runs-card" title="点击查看各类工具分别调用了多少次">
          <div class="uc-label">调用次数 <span class="uc-more">明细 ›</span></div>
          <div class="uc-value" data-field="runs">-</div>
          <div class="uc-sub" data-field="runs-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">搜索次数 <span class="uc-tag">不计入成本</span></div>
          <div class="uc-value" data-field="search">-</div>
          <div class="uc-sub" data-field="search-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">输入 token</div>
          <div class="uc-value" data-field="prompt">-</div>
          <div class="uc-sub" data-field="prompt-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">缓存命中率</div>
          <div class="uc-value" data-field="rate">-</div>
          <div class="usage-bar"><div class="usage-bar-fill ok" data-field="rate-bar" style="width:0%"></div></div>
          <div class="uc-sub" data-field="rate-sub">-</div>
        </div>
      </div>

      <!-- 首次引导：成本口径一次性三选一（选过或点过"以后再说"就不再出现） -->
      <div class="usage-guide hidden" data-block="cost-guide">
        <div class="ug-title">成本数字想更准？选一个就行（30 秒，之后不再问）</div>
        <div class="ug-options">
          <label class="radio-row"><input type="radio" name="guide-mode" value="official" checked />
            <span>按模型官方价估就行（默认；数字是估算，不是账单）</span></label>
          <label class="radio-row"><input type="radio" name="guide-mode" value="multiplier" />
            <span>我按渠道价：官方价 × <input type="number" id="guide-multiplier" step="0.01" min="0.01" value="1" style="width:72px" />（例如 0.5 = 打五折）</span></label>
          <label class="radio-row"><input type="radio" name="guide-mode" value="subscription" />
            <span>我按月付 ¥ <input type="number" id="guide-monthly" step="1" min="0" value="0" style="width:84px" /> /月（订阅套餐、本地自建）</span></label>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <button class="btn btn-primary btn-small" id="cost-guide-save">就用这个</button>
          <button class="btn btn-small" id="cost-guide-later">以后再说</button>
          <span class="hint" id="cost-guide-result"></span>
        </div>
      </div>

      <!-- 未定价提示条：有调用查不到单价时出现。这些调用不算钱，
           但不提示的话用户会以为成本是准的（或者以为模型免费）。 -->
      <div class="usage-unpriced hidden" data-block="unpriced">
        <div class="uu-head">
          <span class="uu-icon">!</span>
          <span class="uu-title" data-field="unpriced-title">-</span>
        </div>
        <div class="uu-list" data-field="unpriced-list"></div>
        <div class="uu-hint">这些调用在价格表里查不到单价，成本没有计入（不等于免费）。
          指定价格后本页会自动重算：<b>设置 → 模型价格</b>（开关关掉后可按模型/渠道手填，或配远程价格表）。</div>
      </div>

      <div data-block="days">
        <h3 class="usage-h3">按天</h3>
        <table class="usage-table clickable" data-table="days">
          <thead><tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th><th class="r">走势</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div data-block="chats">
        <h3 class="usage-h3">按会话</h3>
        <table class="usage-table clickable" data-table="chats">
          <thead><tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div data-block="models">
        <h3 class="usage-h3">按模型
          <button class="btn btn-small ub-expand" id="models-expand" style="display:none">展开全部</button>
        </h3>
        <table class="usage-table clickable" data-table="models">
          <thead><tr><th>模型（渠道：模型 id）</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  // 「调用次数」卡片可点开明细（骨架重建后重新绑定，所以放在 renderUsagePage 里）
  const runsCard = $('#usage-page #runs-card');
  if (runsCard) runsCard.addEventListener('click', () => openToolBreakdown());

  $$('#usage-page [data-range]').forEach((el) => {
    el.addEventListener('click', () => {
      usageRange = el.dataset.range;
      loadUsageView({ force: true });
    });
  });
  $('#usage-refresh-btn')?.addEventListener('click', () => loadUsageView({ force: true }));

  // 行点击 → 弹明细
  box.querySelector('[data-table="days"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('day', tr.dataset.key);
  });
  box.querySelector('[data-table="chats"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('chat', tr.dataset.key);
  });
  box.querySelector('[data-table="models"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('model', tr.dataset.key);
  });

  // 未定价提示条：每个模型一个按钮，点开就是定价弹窗（填完立即重算）
  box.querySelector('[data-field="unpriced-list"]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-price-model]');
    if (!btn) return;
    e.stopPropagation();
    openPriceDialog({
      model: btn.dataset.priceModel || '',
      vendor: btn.dataset.priceVendor || ''
    });
  });

  // 首次引导卡：三选一保存 / 以后再说（保存后不再出现）
  const guide = box.querySelector('[data-block="cost-guide"]');
  if (guide) {
    const syncGuide = () => {
      const picked = guide.querySelector('input[name="guide-mode"]:checked')?.value || 'official';
      const mult = guide.querySelector('#guide-multiplier');
      const monthly = guide.querySelector('#guide-monthly');
      if (mult) mult.disabled = picked !== 'multiplier';
      if (monthly) monthly.disabled = picked !== 'subscription';
    };
    guide.querySelectorAll('input[name="guide-mode"]').forEach((el) => el.addEventListener('change', syncGuide));
    syncGuide();
    const writeMode = async (patch, doneTxt) => {
      const result = guide.querySelector('#cost-guide-result');
      try {
        const res = await api('/api/config', { method: 'POST', body: JSON.stringify({ api: patch }) });
        if (res?.config) state.config = res.config;
        else {
          state.config = state.config || {};
          state.config.api = { ...(state.config.api || {}), ...patch };
        }
        if (result) { result.textContent = doneTxt; result.className = 'hint success'; }
        loadUsageView({ force: true });
      } catch (error) {
        if (result) { result.textContent = `保存失败：${error.message}`; result.className = 'hint error'; }
      }
    };
    guide.querySelector('#cost-guide-save')?.addEventListener('click', () => {
      const picked = guide.querySelector('input[name="guide-mode"]:checked')?.value || 'official';
      const patch = { costMode: picked, costGuideDismissed: true };
      if (picked === 'multiplier') patch.costMultiplier = mulOf(guide.querySelector('#guide-multiplier')?.value);
      if (picked === 'subscription') patch.costMonthlyFee = Number(guide.querySelector('#guide-monthly')?.value) || 0;
      writeMode(patch, '已按这个口径计算');
    });
    guide.querySelector('#cost-guide-later')?.addEventListener('click', () => {
      writeMode({ costGuideDismissed: true }, '好的，以后不再问');
    });
  }

  updateUsagePage(stats, st, prices);
}

/** 只更新数值与表格行，不碰骨架。 */
function updateUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;
  const t = stats?.totals || {};
  const cfg = state.config || {};

  // 统一存字符串：曾经这里把数字直接赋给 textContent（如 runs=0 时存的是数字 0
  // 而非 '0'）。浏览器会隐式转换所以显示没问题，但类型不一致会在别处埋雷
  // （比较、测试断言、序列化时都可能踩到）。这里显式转成字符串。
  const set = (f, v) => {
    const el = box.querySelector(`[data-field="${f}"]`);
    if (!el) return;
    const s = String(v);
    if (el.textContent !== s) el.textContent = s;
  };

  // 价格口径说明（不再显示"当前模型" —— 全天可能换过多个模型）
  const today = st?.usage || {};
  set('runs', t.runs || 0);
  set('runs-sub', `今日 ${today.runs ?? 0} 次`);
  // 搜索次数：只列数量，不参与成本计算（搜索通常是资源包或免费的）
  const searches = Number(stats?.searchCount) || 0;
  set('search', fmtTok(searches));
  set('search-sub', searches
    ? (Number(stats?.toolCounts?.web_search) || 0) + (Number(stats?.toolCounts?.web_fetch) || 0) === searches
      ? '联网搜索 + 抓网页'
      : '联网搜索 + 抓网页'
    : '本区间没有联网');
  set('prompt', fmtTok(t.promptTokens));
  set('prompt-sub', `输出 ${fmtTok(t.completionTokens)}`);
  set('rate', `${((t.cacheHitRate || 0) * 100).toFixed(1)}%`);
  set('rate-sub', `命中 ${fmtTok(t.cachedTokens)} / 输入 ${fmtTok(t.promptTokens)}`);
  set('cost', fmtYuan(t.cost));
  // 口径：实付（用户自己填的渠道价/自定义价）vs 估算（官方表、兜底）。
  // 只显示"估算成本"会让人以为数字是账单；只显示"实付"又会漏掉估算那部分。
  const actual = Number(t.actualCost) || 0;
  const estimate = Number(t.estimateCost) || 0;
  const hasActual = actual > 1e-9;
  const hasEstimate = estimate > 1e-9;
  // 包月/本地：不按 token 计价，作为固定支出单列，不计入上面的按量成本
  const billingInfo = stats?.billing || {};
  const flatItems = billingInfo.flatItems || [];
  const flatMonthly = flatItems.reduce((sum, item) => (item.period === 'month' ? sum + (Number(item.amount) || 0) : sum), 0);
  const flatDaily = flatItems.reduce((sum, item) => (item.period === 'day' ? sum + (Number(item.amount) || 0) : sum), 0);
  const hasFlat = flatItems.length > 0;
  const variable = hasActual || hasEstimate;
  set('cost-label', !variable && hasFlat
    ? '固定支出'
    : (hasActual && hasEstimate ? '成本（含估算）' : (hasActual ? '实付成本' : '估算成本')));
  const split = [];
  if (hasActual) split.push(`实付 ${fmtYuan(actual)}`);
  if (hasEstimate) split.push(`估算 ${fmtYuan(estimate)}`);
  const flatTxt = [
    flatMonthly > 0 ? `包月 ¥${flatMonthly}/月` : '',
    flatDaily > 0 ? `按天 ¥${flatDaily}/天` : ''
  ].filter(Boolean).join(' + ');
  if (flatTxt) split.push(`另有${flatTxt}`);
  if (Number(billingInfo.localCalls) > 0) split.push(`本地模型 ${Number(billingInfo.localCalls)} 次不计费`);
  // 账户口径 + 兜底估算的说明（人话，不用用户理解"口径"两个字）
  const costMode = String((state.config?.api?.costMode) || 'official');
  const multiplier = mulOf(state.config?.api?.costMultiplier);
  if (!flatTxt && hasEstimate && costMode !== 'multiplier') split.push('按官方价估算，不是账单');
  if (!flatTxt && hasActual && costMode === 'multiplier') split.push(`官方价 ×${multiplier}（你的渠道价）`);
  if (Number(t.fallbackCalls) > 0) split.push(`${Number(t.fallbackCalls)} 次按当前模型估算`);
  set('cost-sub', [stats?.rangeLabel || '', ...split].filter(Boolean).join(' · '));

  // 首次引导卡：口径还是默认、且没处理过时出现
  const guide = box.querySelector('[data-block="cost-guide"]');
  if (guide) {
    const dismissed = state.config?.api?.costGuideDismissed === true;
    const showGuide = !dismissed && costMode === 'official';
    guide.classList.toggle('hidden', !showGuide);
  }

  // 未定价提示条：多少调用没算钱、分别是哪些模型
  const un = stats?.unpriced || {};
  const unBlock = box.querySelector('[data-block="unpriced"]');
  if (unBlock) {
    const unpricedModels = un.models || [];
    if (Number(un.calls) > 0) {
      unBlock.classList.remove('hidden');
      set('unpriced-title',
        `${Number(un.calls)} 次调用没有价格（${fmtTokens(Number(un.tokens) || 0)} 未计入成本）`);
      const listEl = box.querySelector('[data-field="unpriced-list"]');
      if (listEl) {
        const chips = unpricedModels.map((x) => {
          const label = x.vendor ? `${x.vendor}：${x.model}` : (x.model || x.key || '');
          return `<button type="button" class="uu-chip" title="给这个模型定价（${esc(label)}）"`
            + ` data-price-model="${esc(x.model || x.key || '')}" data-price-vendor="${esc(x.vendor || '')}">`
            + `${esc(label)}<b>${Number(x.calls) || 0} 次</b><i>定价</i></button>`;
        });
        if (Number(un.more) > 0) chips.push(`<span class="uu-chip muted">等 ${Number(un.more)} 个</span>`);
        const html = chips.join('');
        if (listEl.dataset.sig !== html) { listEl.innerHTML = html; listEl.dataset.sig = html; }
      }
    } else {
      unBlock.classList.add('hidden');
    }
  }
  const bar = box.querySelector('[data-field="rate-bar"]');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, (t.cacheHitRate || 0) * 100)).toFixed(1)}%`;

  // 范围按钮高亮
  $$('#usage-page [data-range]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.range === String(usageRange));
  });

  // 单日/24小时 → 隐藏"按天"
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.style.display = (stats?.mode === 'days') ? '' : 'none';

  // 行数很多时（按模型常有几十行）默认只显示前 N 行，点"展开全部"再看全部。
  // 注意：后端不截断（保证求和一致），这里只是前端显示层面的折叠。
  const COLLAPSE_AT = 20;
  const fill = (name, list, build, opts = {}) => {
    const tbody = box.querySelector(`[data-table="${name}"] tbody`);
    if (!tbody) return;
    const wanted = list || [];
    const collapsed = Boolean(opts.collapsible) && wanted.length > COLLAPSE_AT
      && tbody.dataset.expanded !== '1';
    const shown = collapsed ? wanted.slice(0, COLLAPSE_AT) : wanted;
    const moreBtn = opts.expandBtn ? box.querySelector(opts.expandBtn) : null;
    if (moreBtn) {
      if (wanted.length > COLLAPSE_AT) {
        moreBtn.style.display = '';
        moreBtn.textContent = collapsed
          ? `展开全部（还有 ${wanted.length - COLLAPSE_AT} 行）`
          : '收起';
      } else {
        moreBtn.style.display = 'none';
      }
    }
    if (!wanted.length) {
      if (tbody.dataset.empty !== '1') {
        // 列数按表头算：按日期是 7 列、按会话/按模型是 6 列，写死会让空表多出一列
        const cols = tbody.closest('table')?.querySelectorAll('thead th').length || 6;
        tbody.innerHTML = `<tr><td colspan="${cols}" class="muted">无</td></tr>`;
        tbody.dataset.empty = '1';
      }
      return;
    }
    tbody.dataset.empty = '0';
    const html = shown.map(build).join('');
    if (tbody.dataset.sig !== html) { tbody.innerHTML = html; tbody.dataset.sig = html; }
  };

  // 成本单元格：整行都没有价格时不能显示成 ¥0.00（会被读成"免费"）
  const costCell = (row) => {
    const calls = Number(row.runs) || 0;
    const unpriced = Number(row.unpricedCalls) || 0;
    const flat = Number(row.flatCalls) || 0;
    const local = Number(row.localCalls) || 0;
    // 包月/本地不按 token 计价：金额没有意义，显示"—"+ 计费方式徽标
    if (calls > 0 && flat + local >= calls) {
      return `<span class="muted">—</span>${billingChip(row)}`;
    }
    if (unpriced <= 0) return fmtYuan(row.cost) + billingChip(row);
    const title = `其中有 ${unpriced} 次调用在价格表里查不到单价，未计入成本`;
    if (calls > 0 && unpriced >= calls) {
      return `<span class="uc-chip warn" title="${esc(title)}">未定价</span>`;
    }
    return `${fmtYuan(row.cost)}<span class="uc-chip warn" title="${esc(title)}">未定价 ${unpriced}</span>`;
  };

  // 计费方式徽标：包月（固定支出）/ 本地（不计费）
  const billingChip = (row) => {
    const items = Array.isArray(row.flatItems) ? row.flatItems : [];
    const monthly = items.reduce((sum, item) => (item.period === 'month' ? sum + (Number(item.amount) || 0) : sum), 0);
    const daily = items.reduce((sum, item) => (item.period === 'day' ? sum + (Number(item.amount) || 0) : sum), 0);
    const parts = [];
    if (Number(row.flatCalls) > 0) {
      const amountTxt = [monthly > 0 ? `¥${monthly}/月` : '', daily > 0 ? `¥${daily}/天` : ''].filter(Boolean).join(' + ');
      parts.push(`<span class="uc-chip" title="包月/订阅：按固定支出计，不按 token 计价">包月${amountTxt ? ` ${amountTxt}` : ''}</span>`);
    }
    if (Number(row.localCalls) > 0) {
      parts.push('<span class="uc-chip" title="本地/自建模型：只统计 token，不计费">本地</span>');
    }
    return parts.join('');
  };

  // 实付标记：这一行的价全部来自用户自己填的价（渠道价 / 自定义价），不是官方价估算
  const actualChip = (row) => {
    const calls = Number(row.runs) || 0;
    const actual = Number(row.actualCalls) || 0;
    if (calls > 0 && actual >= calls) {
      return '<span class="uc-chip ok" title="这一行的价是你自己填的（渠道价 / 自定义价），属于实付口径">实付</span>';
    }
    return '';
  };

  // 官方价匹配的提示：别名映射 / 近似匹配都标出来（用户自己定过价的不标）
  const matchNote = (m) => {
    const model = String(m.model || '');
    if (!model) return '';
    const api = (state.config || {}).api || {};
    const custom = api.modelPrices || {};
    if (custom[model] || custom[`${m.vendor}：${model}`]) return '';
    // 用页面本次拿到的价格表（prices 参数），别依赖 state 里那份可能还没加载
    const table = prices?.prices || state.modelPrices?.prices || [];
    const aliases = prices?.aliases || state.modelPrices?.aliases || null;
    const hit = matchPriceTable(model, table, aliases);
    if (!hit) return '';
    if (hit.confidence === 'alias') {
      return `<span class="uc-chip" title="${esc(`按别名映射计价：${hit.via}`)}">别名</span>`;
    }
    if (hit.confidence === 'fuzzy') {
      return `<span class="uc-chip" title="${esc(`近似匹配到 ${hit.matched}（${hit.via}）`)}">近似</span>`;
    }
    return '';
  };

  // 按天成本加“走势”列：比例条独立成列，不跟金额挤在同一个格子里
  const dayRows = stats?.days || [];
  const maxDayCost = Math.max(0, ...dayRows.map((d) => Number(d.cost) || 0));
  fill('days', dayRows, (d) => {
    const cost = Number(d.cost) || 0;
    const pct = maxDayCost > 0 ? Math.max(4, Math.round((cost / maxDayCost) * 100)) : 0;
    return `
    <tr data-key="${esc(d.day)}">
      <td>${esc(d.day)}</td>
      <td class="r">${d.runs}</td>
      <td class="r">${fmtTok(d.promptTokens)}</td>
      <td class="r">${fmtTok(d.completionTokens)}</td>
      <td class="r">${fmtTok(d.cachedTokens)}</td>
      <td class="r">${((d.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r usage-trend-td"><span class="usage-cost-bar" aria-hidden="true" title="相对所选区间内成本最高的一天"><i style="width:${pct}%"></i></span></td>
      <td class="r">${costCell(d)}</td>
    </tr>`;
  });

  fill('chats', stats?.chats, (c) => `
    <tr data-key="${esc(c.key)}">
      <td>${esc(formatChatTitle(c.key, chatNameOf(c.key)))}</td>
      <td class="r">${c.runs}</td>
      <td class="r">${fmtTok(c.promptTokens)}</td>
      <td class="r">${fmtTok(c.completionTokens)}</td>
      <td class="r">${((c.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${costCell(c)}</td>
    </tr>`);

  // 模型与供应商分两列显示：同一个 id 走不同渠道是不同的"商品"，
  // 价格可能差很多（中转站加价、:free 版本等），必须能区分开。
  fill('models', stats?.models, (m) => `
    <tr data-key="${esc(m.key)}">
      <td>${esc(m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key))}${actualChip(m)}${matchNote(m)}</td>
      <td class="r">${m.runs}</td>
      <td class="r">${fmtTok(m.promptTokens)}</td>
      <td class="r">${fmtTok(m.completionTokens)}</td>
      <td class="r">${((m.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${costCell(m)}</td>
    </tr>`, { collapsible: true, expandBtn: '#models-expand' });
}

/** 峰谷拆分条（弹窗外部上方展示；没用到分时段计价的模型则不显示）。 */
/**
 * 加载用量页。
 *
 * @param {boolean} force  true = 重建整个页面骨架（切换页签、切换时间范围、点刷新）；
 *                         false = 轮询刷新，只更新数值与表格行，不重建 DOM。
 *
 * ── 为什么要分开 ──
 * 轮询每 15 秒一次，如果每次都重建 DOM，用户正在看的行会被重新渲染、
 * 滚动位置也会丢。所以轮询走"只更新数值"这条路。
 *
 * ── 加载为什么快 ──
 * 1. 三个接口用 Promise.all **并行**请求（串行会慢 3 倍）
 * 2. 骨架屏**立即**显示，不等数据回来 —— 用户切过去马上看到布局，不会"黑一会"
 * 3. 竞态防护：请求期间用户可能切走或改了时间范围，回来时丢弃过期结果
 */
let usageLoadToken = 0;          // 每次加载递增，用于丢弃过期结果
let usageLastData = null;        // 上一次加载成功的数据：{ range, stats, st, prices }
                                 // 用于切回用量页时先立即画出旧内容，避免"黑一下"

async function loadUsageView({ force = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;

  // ── 轮询刷新：只更新数值，不重建 DOM ──
  if (!force) {
    try {
      const [stats, st] = await Promise.all([
        api(`/api/usage/stats?range=${usageRange}`),
        api('/api/status')
      ]);
      // 用户可能已经切走页签了，那就别动了
      if (state.tab !== 'usage') return;
      state.usageStats = stats;
      // ⚠️ 价格不用再请求：启动时已加载进 state.modelPrices（/api/model-prices），
      //    更新时按需拉取即可。曾经这里请求了一个**不存在的** /api/usage/prices，
      //    404 会让整个 Promise.all reject → 用量页永远加载失败。
      updateUsagePage(stats, st, state.modelPrices || {});
    } catch (e) { /* 轮询失败静默，不打扰用户 */ }
    return;
  }

  // ── 强制重建 ──
  const token = ++usageLoadToken;
  const range = usageRange;

  // ★ 先用上一次的数据立即渲染（如果有的话），而不是先画骨架等网络。
  //   后端统计的冷启动实测约 200ms（要遍历全部会话文件），热数据只要 24ms；
  //   但缓存 TTL 只有 5 秒、轮询 4 秒一次，切回用量页时缓存经常已经过期，
  //   于是每次都要等那 200ms —— 表现就是"点过去黑一下"。
  //   有旧数据时直接先画出来（0ms 可见），再在后台拉新的覆盖。
  const cached = usageLastData && usageLastData.range === range ? usageLastData : null;
  if (cached) {
    state.usageStats = cached.stats;
    renderUsagePage(cached.stats, cached.st, cached.prices);
  } else {
    box.innerHTML = renderUsageSkeleton();
  }

  try {
    const [stats, st, priceData, cfgData] = await Promise.all([
      api(`/api/usage/stats?range=${range}`),
      api('/api/status'),
      // 价格表：模型行的「别名 / 近似」标记要用它。设置页只在打开时才加载，
      // 所以这里自己拉一份（并行，不额外增加等待）。
      api('/api/model-prices').catch(() => null),
      // 配置：成本口径（官方价 / 渠道倍率 / 按月付）与引导卡状态要用
      api('/api/config').catch(() => null)
    ]);
    if (priceData) state.modelPrices = priceData;
    if (cfgData) state.config = cfgData;
    const prices = state.modelPrices || {};
    // 竞态：期间用户切走了页签、或又点了别的时间范围 → 这次结果作废
    if (token !== usageLoadToken) return;
    if (state.tab !== 'usage' || usageRange !== range) return;

    state.usageStats = stats;
    usageLastData = { range, stats, st, prices };

    if (cached) {
      // 已有页面：只更新数值，不重建（避免打断用户的滚动/交互）
      updateUsagePage(stats, st, prices);
    } else {
      // ⚠️ renderUsagePage 不返回字符串 —— 它内部自己写 box.innerHTML、
      //    绑定事件、并调用 updateUsagePage 填数值。
      //    所以这里只能"直接调用"，不能再赋值（赋 undefined 会把页面清空）。
      renderUsagePage(stats, st, prices);
    }
  } catch (e) {
    if (token !== usageLoadToken) return;
    // 旧数据还在页面上就别用错误覆盖它（用户至少能看到上一次的数字）
    if (!cached) box.innerHTML = `<div class="empty-hint">用量加载失败：${esc(e?.message || e)}</div>`;
  }
}

function peakSplitHtml(sum) {
  if (!sum || !sum.hasPeakModel) return '';
  if (!(sum.peakCost > 0 || sum.offPeakCost > 0)) return '';
  const ratio = sum.peakRatio || 0;
  return `
    <div class="usage-peak">
      <div class="up-title">峰谷拆分</div>
      <div class="up-row">
        <span class="up-dot peak"></span>
        <span class="up-label">高峰时段</span>
        <span class="up-val">${fmtYuan(sum.peakCost)}</span>
        <span class="up-bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${(ratio * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-row">
        <span class="up-dot off"></span>
        <span class="up-label">闲时</span>
        <span class="up-val">${fmtYuan(sum.offPeakCost)}</span>
        <span class="up-bar"><i class="off" style="width:${((1 - ratio) * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${((1 - ratio) * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-hint">高峰 = 北京时间工作日 9:00-12:00、14:00-18:00；周末全天闲时。</div>
    </div>`;
}

/**
 * 点表格行 → 弹明细。
 * dim 决定可选的第二个维度：
 *   chat  → 按模型 / 按天
 *   model → 按会话 / 按天
 *   day   → 按模型 / 按会话
 */
function openUsageBreakdown(dim, key) {
  const tabs = {
    chat: [['model', '各模型'], ['day', '各天']],
    model: [['chat', '各群聊'], ['day', '各天']],
    day: [['model', '各模型'], ['chat', '各群聊']]
  }[dim] || [['model', '各模型']];

  const dimLabel = { chat: '会话', model: '模型', day: '日期' }[dim] || '';
  let activeBy = tabs[0][0];

  const overlay = modelModalShell({
    head: `明细：${dimLabel} ${esc(key)}`,
    body: `
      <div class="ub-wrap">
        <div class="ub-tabs" id="ub-tabs">${tabs.map(([v, l]) => `<button class="btn btn-small" data-by="${v}">${l}</button>`).join('')}</div>
        <div id="ub-peak"></div>
        <div class="ub-scroll">
          <table class="usage-table">
            <thead><tr><th id="ub-col">项目</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody id="ub-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>`,
    foot: `<button class="btn" id="ub-close">关闭</button>`
  });

  const bodyEl = overlay.querySelector('#ub-body');
  const peakEl = overlay.querySelector('#ub-peak');
  const colEl = overlay.querySelector('#ub-col');

  async function load() {
    bodyEl.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
    try {
      const r = await api(`/api/usage/breakdown?range=${encodeURIComponent(usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${activeBy}`);
      peakEl.innerHTML = peakSplitHtml(r.totals);
      colEl.textContent = { model: '模型', chat: '会话', day: '日期' }[activeBy] || '项目';
      // 成本列：包月/本地/未定价不能只显示 ¥0.00（会被读成免费）
      const costCell = (x) => {
        const items = Array.isArray(x.flatItems) ? x.flatItems : [];
        const monthly = items.reduce((s2, it) => (it.period === 'month' ? s2 + (Number(it.amount) || 0) : s2), 0);
        const daily = items.reduce((s2, it) => (it.period === 'day' ? s2 + (Number(it.amount) || 0) : s2), 0);
        const chips = [];
        if (Number(x.flatCalls) > 0) {
          const amount = [monthly > 0 ? `¥${monthly}/月` : '', daily > 0 ? `¥${daily}/天` : ''].filter(Boolean).join(' + ');
          chips.push(`<span class="uc-chip" title="包月/订阅：按固定支出计，不按 token 计价">包月${amount ? ` ${amount}` : ''}</span>`);
        }
        if (Number(x.localCalls) > 0) chips.push('<span class="uc-chip" title="本地/自建模型：只统计 token，不计费">本地</span>');
        if (Number(x.unpricedCalls) > 0) chips.push(`<span class="uc-chip warn" title="没有价格：这些调用没算进成本，不是免费">未定价 ${Number(x.unpricedCalls)}</span>`);
        const money = Number(x.cost) || 0;
        const head = (money > 0 || !chips.length) ? fmtYuan(money) : '—';
        return [head, ...chips].join(' ');
      };
      bodyEl.innerHTML = (r.rows || []).length
        ? r.rows.map((x) => `
            <tr>
              <td>${esc(activeBy === 'chat'
                ? formatChatTitle(x.key, chatNameOf(x.key))
                : (x.vendor ? `${x.vendor}：${x.model}` : (x.model ?? x.key)))}</td>
              <td class="r">${x.runs}</td>
              <td class="r">${fmtTok(x.promptTokens)}</td>
              <td class="r">${fmtTok(x.completionTokens)}</td>
              <td class="r">${((x.cacheHitRate || 0) * 100).toFixed(0)}%</td>
              <td class="r">${costCell(x)}</td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="muted">无数据</td></tr>';
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="6" class="muted">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((el) => {
    el.addEventListener('click', () => {
      activeBy = el.dataset.by;
      overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
      load();
    });
  });
  overlay.querySelector('#ub-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
  load();
}

// ── AI 资产观测 ──
const ASSET_KINDS = [
  ['stickers', '表情包'],
  ['slang', '黑话'],
  ['slang-research', '黑话研究']
];

function assetStateText(active, exists, activeText = '运行中') {
  if (active) return activeText;
  if (exists) return '已存储 · 未接入';
  return '未接入';
}

function renderAssetSummary(overview) {
  const stickers = overview.stickers || {};
  const slang = overview.slang || {};
  const slangPilot = overview.slangPilot || {};
  return `
    <div class="asset-summary">
      <button type="button" class="asset-summary-item" data-asset-kind="stickers">
        <span>表情包</span><strong>${fmtTok(stickers.total)}</strong>
        <small>${stickers.enabled ? `已备注 ${fmtTok(stickers.annotated)}` : '功能已关闭'}</small>
      </button>
      <button type="button" class="asset-summary-item" data-asset-kind="slang">
        <span>黑话</span><strong>${fmtTok(slang.total)}</strong>
        <small>${assetStateText(slang.active, slang.exists)}</small>
      </button>
      <button type="button" class="asset-summary-item" data-asset-kind="slang-research">
        <span>黑话研究</span><strong>${fmtTok(
          (slangPilot.pendingResearch || 0) + (slangPilot.pendingAdmission || 0)
        )}</strong>
        <small>${slangPilot.active ? '等待审批' : '实验开关关闭'}</small>
      </button>
    </div>`;
}

function renderStickerAssets(data) {
  const entries = data?.entries || [];
  if (!entries.length) {
    return '<div class="empty-hint">当前表情包库为空</div>';
  }
  return `<div class="asset-sticker-grid">${entries.map((entry) => {
    const title = entry.localNote || entry.desc || entry.id;
    const tags = (entry.tags || []).map((tag) => `<span>${esc(tag)}</span>`).join('');
    return `<article class="asset-sticker">
      <div class="asset-sticker-media">
        ${entry.hasImage
          ? `<img loading="lazy" src="/api/assets/stickers/image?id=${encodeURIComponent(entry.id)}" alt="${esc(title)}" />`
          : '<span class="muted">无图片</span>'}
      </div>
      <div class="asset-sticker-body">
        <strong title="${esc(entry.id)}">${esc(title)}</strong>
        ${entry.desc && entry.localNote ? `<span>${esc(entry.desc)}</span>` : ''}
        ${tags ? `<div class="asset-tags">${tags}</div>` : ''}
        <small>${entry.source === 'qq' ? 'QQ 收藏' : entry.source === 'ai' ? 'AI 收藏' : '手动'} · 使用 ${fmtTok(entry.useCount)} 次</small>
        <div class="asset-actions">
          <button type="button" class="btn btn-small asset-edit" data-asset-id="${esc(entry.id)}">编辑</button>
          <button type="button" class="btn btn-small btn-danger asset-delete" data-asset-id="${esc(entry.id)}">删除</button>
        </div>
      </div>
    </article>`;
  }).join('')}</div>`;
}

function renderSlangAssets(data) {
  if (!data?.exists) {
    return '<div class="empty-hint">当前 Agent 没有黑话库</div>';
  }
  const entries = data.entries || [];
  if (!entries.length) return '<div class="empty-hint">黑话库为空</div>';
  const statusText = { candidate: '候选', confirmed: '已确认', rejected: '已拒绝' };
  return `<div class="asset-table-wrap"><table class="asset-table">
    <thead><tr><th>词条</th><th>含义</th><th>状态</th><th>出现</th><th>证据</th><th>操作</th></tr></thead>
    <tbody>${entries.map((entry) => `<tr>
      <td><strong>${esc(entry.content)}</strong>${entry.risk ? `<small>${esc(entry.risk)}</small>` : ''}</td>
      <td>${esc(entry.meaning || '-')}${entry.usage ? `<small>${esc(entry.usage)}</small>` : ''}</td>
      <td>${esc(statusText[entry.status] || entry.status)}<small>${entry.scope === 'chat-private' ? '仅来源群' : '全局'}</small></td>
      <td class="r">${fmtTok(entry.count)}</td>
      <td class="r">${fmtTok(entry.evidenceCount)}</td>
      <td><div class="asset-actions">
        <button type="button" class="btn btn-small asset-edit" data-asset-id="${esc(entry.id)}">编辑</button>
        <button type="button" class="btn btn-small btn-danger asset-delete" data-asset-id="${esc(entry.id)}">删除</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

const SLANG_RESEARCH_STATUS = {
  pending_research: '待研究审批',
  research_queued: '等待研究',
  researching: '研究中',
  research_interrupted: '研究中断',
  research_failed: '研究失败',
  pending_admission: '待入库审批',
  admitted_candidate: '已加入候选',
  research_rejected: '已拒绝研究',
  admission_rejected: '已拒绝收录'
};

function renderSlangResearch(data) {
  if (data?.disabled) {
    return '<div class="empty-hint">黑话研究实验功能当前关闭</div>';
  }
  const entries = data?.discoveries || [];
  if (!entries.length) return '<div class="empty-hint">当前没有黑话研究记录</div>';
  return `<div class="asset-table-wrap"><table class="asset-table">
    <thead><tr><th>词条</th><th>来源</th><th>证据</th><th>研究结论</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${entries.map((entry) => {
      const evidence = (entry.evidence || []).slice(-2)
        .map((item) => item.text).filter(Boolean).join('；');
      let commands = '';
      if (entry.state === 'pending_research') {
        commands = `
          <button type="button" class="btn btn-small slang-research-action" data-id="${esc(entry.id)}" data-action="research-approve">研究</button>
          <button type="button" class="btn btn-small btn-danger slang-research-action" data-id="${esc(entry.id)}" data-action="research-reject">拒绝</button>`;
      } else if (entry.state === 'pending_admission') {
        commands = `
          <button type="button" class="btn btn-small slang-research-action" data-id="${esc(entry.id)}" data-action="admission-review">查看并收录</button>
          <button type="button" class="btn btn-small btn-danger slang-research-action" data-id="${esc(entry.id)}" data-action="admission-reject">拒绝</button>`;
      } else if (['research_failed', 'research_interrupted'].includes(entry.state)) {
        commands = `<button type="button" class="btn btn-small slang-research-action" data-id="${esc(entry.id)}" data-action="research-retry">重试</button>`;
      }
      const actions = `<div class="asset-actions">
        <button type="button" class="btn btn-small slang-research-action" data-id="${esc(entry.id)}" data-action="detail">详情</button>
        ${commands}
      </div>`;
      return `<tr>
        <td><strong>${esc(entry.displayTerm)}</strong><small><code>${esc(entry.id)}</code></small></td>
        <td>${esc(formatChatTitle(entry.scopeChatKey, chatNameOf(entry.scopeChatKey)))}<small>${fmtTok(entry.occurrenceCount)} 次 · ${fmtTok(entry.speakerCount)} 人</small></td>
        <td title="${esc(evidence)}">${esc(evidence || '-')}</td>
        <td>${esc(entry.research?.meaning || '-')}${entry.researchError ? `<small>${esc(entry.researchError)}</small>` : ''}</td>
        <td>${esc(SLANG_RESEARCH_STATUS[entry.state] || entry.state)}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

async function decideSlangResearch(entry, action) {
  if (action === 'detail') return openSlangResearchDetail(entry.id);
  if (action === 'admission-review') return openSlangAdmissionEditor(entry);
  const reject = action.endsWith('reject');
  const retry = action === 'research-retry';
  if (
    !retry
    && !await askForConfirmation(reject ? '拒绝这条黑话记录？' : '批准消耗模型 Token 研究这个词条？')
  ) {
    return;
  }
  const path = retry
    ? `/api/slang-pilot/discoveries/${encodeURIComponent(entry.id)}/retry`
    : action.startsWith('research-')
      ? `/api/slang-pilot/discoveries/${encodeURIComponent(entry.id)}/research-decision`
      : `/api/slang-pilot/discoveries/${encodeURIComponent(entry.id)}/admission-decision`;
  await api(path, {
    method: 'POST',
    body: JSON.stringify(retry ? {} : {
      decision: reject ? 'reject' : 'approve'
    })
  });
  state.assetOverview = null;
  state.assetDetail = null;
  await loadAssetObservatory();
}

async function openSlangResearchDetail(id) {
  const data = await api(`/api/slang-pilot/discoveries/${encodeURIComponent(id)}`);
  const entry = data.discovery;
  const research = entry.research || {};
  const evidence = (entry.evidence || []).map((item) => `
    <tr><td>${esc(fmtTime(item.at))}</td><td>${esc(item.senderName || item.senderId || '-')}</td><td>${esc(item.text || '-')}</td></tr>
  `).join('');
  const events = (entry.events || []).map((item) => `
    <tr><td>${esc(fmtTime(item.createdAt))}</td><td>${esc(item.stage)}</td><td>${esc(item.decision)}</td><td>${esc(item.decidedBy || '-')}</td></tr>
  `).join('');
  const overlay = modelModalShell({
    head: `黑话研究 · ${entry.displayTerm}`,
    body: `
      <div class="field-row">
        <div class="field"><label>状态</label><div>${esc(SLANG_RESEARCH_STATUS[entry.state] || entry.state)}</div></div>
        <div class="field"><label>来源</label><div>${esc(formatChatTitle(entry.scopeChatKey, chatNameOf(entry.scopeChatKey)))}</div></div>
        <div class="field"><label>统计</label><div>${fmtTok(entry.occurrenceCount)} 次 · ${fmtTok(entry.speakerCount)} 人</div></div>
      </div>
      ${research.meaning ? `<div class="field"><label>研究结论</label><div>${esc(research.meaning)}</div></div>` : ''}
      ${research.usage ? `<div class="field"><label>使用方式</label><div>${esc(research.usage)}</div></div>` : ''}
      ${research.risk ? `<div class="field"><label>误用风险</label><div>${esc(research.risk)}</div></div>` : ''}
      <div class="field"><label>证据</label><div class="asset-table-wrap"><table class="asset-table">
        <thead><tr><th>时间</th><th>发言人</th><th>原文</th></tr></thead>
        <tbody>${evidence || '<tr><td colspan="3">无</td></tr>'}</tbody>
      </table></div></div>
      <div class="field"><label>来源链接</label><div>${(entry.researchSources || []).map((url) => `<div><code>${esc(url)}</code></div>`).join('') || '-'}</div></div>
      <div class="field"><label>Token</label><div>${fmtTok(entry.researchUsage?.totalTokens || 0)}</div></div>
      <div class="field"><label>审批记录</label><div class="asset-table-wrap"><table class="asset-table">
        <thead><tr><th>时间</th><th>阶段</th><th>决定</th><th>操作者</th></tr></thead>
        <tbody>${events || '<tr><td colspan="4">无</td></tr>'}</tbody>
      </table></div></div>`,
    foot: '<button class="btn btn-primary" id="slang-detail-close">关闭</button>'
  });
  overlay.querySelector('#slang-detail-close').addEventListener('click', () =>
    closeModelModal(overlay));
}

function openSlangAdmissionEditor(entry) {
  const research = entry.research || {};
  const overlay = modelModalShell({
    head: '审核黑话研究结果',
    body: `
      <div class="field"><label>词条</label><input type="text" id="slang-admit-content" maxlength="80" value="${esc(research.canonical || entry.displayTerm)}" /></div>
      <div class="field"><label>含义</label><textarea id="slang-admit-meaning">${esc(research.meaning || '')}</textarea></div>
      <div class="field"><label>使用方式</label><textarea id="slang-admit-usage">${esc(research.usage || '')}</textarea></div>
      <div class="field"><label>例句</label><textarea id="slang-admit-example">${esc(research.example || '')}</textarea></div>
      <div class="field"><label>误用风险</label><textarea id="slang-admit-risk">${esc(research.risk || '')}</textarea></div>
      <div class="field"><label>使用范围</label><select id="slang-admit-scope">
        <option value="chat-private" ${research.recommendedScope === 'global-safe' ? '' : 'selected'}>仅来源群</option>
        <option value="global-safe" ${research.recommendedScope === 'global-safe' ? 'selected' : ''}>全局可用</option>
      </select></div>`,
    foot: '<button class="btn" id="slang-admit-cancel">取消</button><button class="btn btn-primary" id="slang-admit-save">加入候选库</button>'
  });
  overlay.querySelector('#slang-admit-cancel').addEventListener('click', () =>
    closeModelModal(overlay));
  overlay.querySelector('#slang-admit-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api(
        `/api/slang-pilot/discoveries/${encodeURIComponent(entry.id)}/admission-decision`,
        {
          method: 'POST',
          body: JSON.stringify({
            decision: 'approve',
            edits: {
              content: overlay.querySelector('#slang-admit-content').value,
              meaning: overlay.querySelector('#slang-admit-meaning').value,
              usage: overlay.querySelector('#slang-admit-usage').value,
              example: overlay.querySelector('#slang-admit-example').value,
              risk: overlay.querySelector('#slang-admit-risk').value,
              scope: overlay.querySelector('#slang-admit-scope').value
            }
          })
        }
      );
      await finishAssetMutation(overlay);
    } catch (error) {
      alert(`收录失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function renderIdentityAssets(data) {
  if (!data?.exists) {
    return '<div class="empty-hint">尚未建立统一身份索引</div>';
  }
  const people = data?.entries || [];
  if (!people.length) return '<div class="empty-hint">统一身份库为空</div>';
  return `<div class="asset-table-wrap"><table class="asset-table">
    <thead><tr><th>QQ</th><th>首选名称</th><th>别名</th><th>会话</th><th>消息</th><th>好友</th><th>画像备注</th><th>操作</th></tr></thead>
    <tbody>${people.map((person) => {
      const aliases = [...new Set((person.aliases || []).map((item) =>
        typeof item === 'string' ? item : item?.alias).filter(Boolean))];
      return `<tr>
        <td><code>${esc(person.userId)}</code></td>
        <td>${esc(person.primaryName || '-')}</td>
        <td title="${esc(aliases.join(' / '))}">${esc(aliases.slice(0, 3).join(' / ') || '-')}</td>
        <td class="r">${fmtTok(person.chatCount)}</td>
        <td class="r">${fmtTok(person.messageCount)}</td>
        <td>${person.isFriend ? '是' : '否'}</td>
        <td>${esc(person.profileNote || '-')}${person.manuallyManaged ? '<small>人工维护</small>' : ''}</td>
        <td><div class="asset-actions">
          <button type="button" class="btn btn-small asset-edit" data-asset-id="${esc(person.userId)}">编辑</button>
          <button type="button" class="btn btn-small btn-danger asset-delete" data-asset-id="${esc(person.userId)}">删除</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function renderMemoryAssets(data) {
  const entries = data?.entries || [];
  if (!entries.length) return '<div class="empty-hint">当前没有会话记忆</div>';
  return `<div class="asset-table-wrap"><table class="asset-table">
    <thead><tr><th>会话</th><th>人物</th><th>印象</th><th>最近更新</th><th>操作</th></tr></thead>
    <tbody>${entries.map((entry, index) => `<tr>
      <td>${esc(formatChatTitle(entry.chatKey, chatNameOf(entry.chatKey)))}</td>
      <td><strong>${esc(entry.name || entry.userId)}</strong><small><code>${esc(entry.userId)}</code></small></td>
      <td>${esc((entry.impressions || []).map((item) => item.content).join('；') || '-')}</td>
      <td>${entry.updatedAt ? esc(fmtTime(entry.updatedAt)) : '-'}</td>
      <td><div class="asset-actions">
        <button type="button" class="btn btn-small asset-edit" data-asset-index="${index}">编辑</button>
        <button type="button" class="btn btn-small btn-danger asset-delete" data-asset-index="${index}">删除</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function assetChatOptions(selected = '') {
  const keys = new Set([
    ...(state.chats || []).map((chat) => chat.key),
    ...((state.assetOverview?.memory?.items || []).map((chat) => chat.chatKey)),
    selected
  ].filter(Boolean));
  return [...keys].map((chatKey) =>
    `<option value="${esc(chatKey)}">${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))}</option>`
  ).join('');
}

function readAssetImage(file) {
  if (!file) return Promise.resolve('');
  if (file.size > 8 * 1024 * 1024) return Promise.reject(new Error('表情图片不能超过 8 MiB'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function finishAssetMutation(overlay) {
  closeModelModal(overlay);
  state.assetOverview = null;
  state.assetDetail = null;
  return state.tab === 'identity'
    ? loadIdentityFeaturePage()
    : loadAssetObservatory();
}

function openStickerAssetEditor(entry = null) {
  const editing = Boolean(entry);
  const overlay = modelModalShell({
    head: editing ? '编辑表情包' : '新增表情包',
    body: `
      ${editing ? '' : `
      <div class="field"><label>图片文件</label><input type="file" id="asset-sticker-file" accept="image/png,image/jpeg,image/gif,image/webp" /></div>
      <div class="field"><label>图片 URL</label><input type="text" id="asset-sticker-url" placeholder="未选择文件时使用" /></div>`}
      <div class="field"><label>名称</label><input type="text" id="asset-sticker-desc" maxlength="80" value="${esc(entry?.desc || '')}" /></div>
      <div class="field"><label>AI 备注</label><textarea id="asset-sticker-note">${esc(entry?.localNote || '')}</textarea></div>
      <div class="field"><label>标签</label><input type="text" id="asset-sticker-tags" value="${esc((entry?.tags || []).join(', '))}" /></div>
      <div class="field"><label>使用场景</label><textarea id="asset-sticker-usage">${esc(entry?.usage || '')}</textarea></div>`,
    foot: '<button class="btn" id="asset-editor-cancel">取消</button><button class="btn btn-primary" id="asset-editor-save">保存</button>'
  });
  overlay.querySelector('#asset-editor-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#asset-editor-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const body = {
        desc: overlay.querySelector('#asset-sticker-desc').value,
        localNote: overlay.querySelector('#asset-sticker-note').value,
        tags: overlay.querySelector('#asset-sticker-tags').value
          .split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean),
        usage: overlay.querySelector('#asset-sticker-usage').value
      };
      if (!editing) {
        body.imageUrl = overlay.querySelector('#asset-sticker-url').value.trim();
        body.imageDataUrl = await readAssetImage(
          overlay.querySelector('#asset-sticker-file').files?.[0]
        );
      }
      await api(
        editing
          ? `/api/assets/stickers/${encodeURIComponent(entry.id)}`
          : '/api/assets/stickers',
        { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }
      );
      await finishAssetMutation(overlay);
    } catch (error) {
      alert(`保存失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function openSlangAssetEditor(entry = null) {
  const editing = Boolean(entry);
  const overlay = modelModalShell({
    head: editing ? '编辑黑话' : '新增黑话',
    body: `
      <div class="field-row">
        <div class="field"><label>词条</label><input type="text" id="asset-slang-content" maxlength="80" value="${esc(entry?.content || '')}" /></div>
        <div class="field"><label>状态</label><select id="asset-slang-state">
          <option value="candidate" ${entry?.status === 'candidate' || !entry ? 'selected' : ''}>候选</option>
          <option value="confirmed" ${entry?.status === 'confirmed' ? 'selected' : ''}>已确认</option>
          <option value="rejected" ${entry?.status === 'rejected' ? 'selected' : ''}>已拒绝</option>
        </select></div>
      </div>
      <div class="field"><label>含义</label><textarea id="asset-slang-meaning">${esc(entry?.meaning || '')}</textarea></div>
      <div class="field"><label>使用方式</label><textarea id="asset-slang-usage">${esc(entry?.usage || '')}</textarea></div>
      <div class="field"><label>例句</label><textarea id="asset-slang-example">${esc(entry?.example || '')}</textarea></div>
      <div class="field"><label>误用风险</label><textarea id="asset-slang-risk">${esc(entry?.risk || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>使用范围</label><select id="asset-slang-scope">
          <option value="global-safe" ${entry?.scope === 'chat-private' ? '' : 'selected'}>全局可用</option>
          <option value="chat-private" ${entry?.scope === 'chat-private' ? 'selected' : ''}>仅来源会话</option>
        </select></div>
        <div class="field"><label>来源会话</label><input type="text" id="asset-slang-chat" list="asset-slang-chat-options" value="${esc(entry?.scopeChatKey || '')}" placeholder="group:群号" /><datalist id="asset-slang-chat-options">${assetChatOptions(entry?.scopeChatKey)}</datalist></div>
      </div>`,
    foot: '<button class="btn" id="asset-editor-cancel">取消</button><button class="btn btn-primary" id="asset-editor-save">保存</button>'
  });
  overlay.querySelector('#asset-editor-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#asset-editor-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const body = {
        content: overlay.querySelector('#asset-slang-content').value,
        status: overlay.querySelector('#asset-slang-state').value,
        meaning: overlay.querySelector('#asset-slang-meaning').value,
        usage: overlay.querySelector('#asset-slang-usage').value,
        example: overlay.querySelector('#asset-slang-example').value,
        risk: overlay.querySelector('#asset-slang-risk').value,
        scope: overlay.querySelector('#asset-slang-scope').value,
        scopeChatKey: overlay.querySelector('#asset-slang-chat').value.trim()
      };
      await api(
        editing
          ? `/api/assets/slang/${encodeURIComponent(entry.id)}`
          : '/api/assets/slang',
        { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }
      );
      await finishAssetMutation(overlay);
    } catch (error) {
      alert(`保存失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function openIdentityAssetEditor(entry = null) {
  const editing = Boolean(entry);
  const overlay = modelModalShell({
    head: editing ? '编辑人物' : '新增人物',
    body: `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="asset-person-uin" inputmode="numeric" value="${esc(entry?.userId || '')}" ${editing ? 'readonly' : ''} /></div>
        <div class="field"><label>首选名称</label><input type="text" id="asset-person-name" maxlength="60" value="${esc(entry?.primaryName || '')}" /></div>
      </div>
      <div class="field"><label>来源会话</label><input type="text" id="asset-person-chat" list="asset-chat-options" value="${esc(entry?.sourceChatKey || '')}" placeholder="group:群号 或 private:QQ号" /><datalist id="asset-chat-options">${assetChatOptions(entry?.sourceChatKey)}</datalist></div>
      <div class="field"><label>画像备注</label><textarea id="asset-person-note">${esc(entry?.profileNote || '')}</textarea></div>
      <div class="checkbox-row"><input type="checkbox" id="asset-person-friend" ${entry?.isFriend ? 'checked' : ''} /><label for="asset-person-friend">标记为好友</label></div>`,
    foot: '<button class="btn" id="asset-editor-cancel">取消</button><button class="btn btn-primary" id="asset-editor-save">保存</button>'
  });
  overlay.querySelector('#asset-editor-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#asset-editor-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const userId = overlay.querySelector('#asset-person-uin').value.trim();
      const body = {
        userId,
        primaryName: overlay.querySelector('#asset-person-name').value,
        chatKey: overlay.querySelector('#asset-person-chat').value.trim(),
        profileNote: overlay.querySelector('#asset-person-note').value,
        isFriend: overlay.querySelector('#asset-person-friend').checked
      };
      await api(
        editing
          ? `/api/assets/identities/${encodeURIComponent(entry.userId)}`
          : '/api/assets/identities',
        { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }
      );
      await finishAssetMutation(overlay);
    } catch (error) {
      alert(`保存失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function openMemoryAssetEditor(entry = null) {
  const editing = Boolean(entry);
  const overlay = modelModalShell({
    head: editing ? '编辑人物记忆' : '新增人物记忆',
    body: `
      <div class="field"><label>会话</label><input type="text" id="asset-memory-chat" list="asset-memory-chat-options" value="${esc(entry?.chatKey || '')}" ${editing ? 'readonly' : ''} placeholder="group:群号 或 private:QQ号" /><datalist id="asset-memory-chat-options">${assetChatOptions(entry?.chatKey)}</datalist></div>
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="asset-memory-uin" inputmode="numeric" value="${esc(entry?.userId || '')}" ${editing ? 'readonly' : ''} /></div>
        <div class="field"><label>名称</label><input type="text" id="asset-memory-name" maxlength="60" value="${esc(entry?.name || '')}" /></div>
      </div>
      <div class="field"><label>${editing ? '印象内容（一行一条）' : '记忆内容'}</label><textarea id="asset-memory-content" style="min-height:160px">${esc(editing ? (entry?.impressions || []).map((item) => item.content).join('\n') : '')}</textarea></div>`,
    foot: '<button class="btn" id="asset-editor-cancel">取消</button><button class="btn btn-primary" id="asset-editor-save">保存</button>'
  });
  overlay.querySelector('#asset-editor-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#asset-editor-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const content = overlay.querySelector('#asset-memory-content').value;
      const body = {
        chatKey: overlay.querySelector('#asset-memory-chat').value.trim(),
        userId: overlay.querySelector('#asset-memory-uin').value.trim(),
        name: overlay.querySelector('#asset-memory-name').value
      };
      if (editing) body.impressions = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      else body.content = content;
      await api('/api/assets/memory', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(body)
      });
      await finishAssetMutation(overlay);
    } catch (error) {
      alert(`保存失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function openAssetEditor(kind, entry = null) {
  if (kind === 'stickers') return openStickerAssetEditor(entry);
  if (kind === 'slang') return openSlangAssetEditor(entry);
  if (kind === 'identities') return openIdentityAssetEditor(entry);
  return openMemoryAssetEditor(entry);
}

async function deleteAsset(kind, entry) {
  const label = kind === 'stickers'
    ? (entry.localNote || entry.desc || entry.id)
    : kind === 'slang'
      ? entry.content
      : kind === 'identities'
        ? (entry.primaryName || entry.userId)
        : (entry.name || entry.userId);
  if (!await askForConfirmation(`确定从 AI 资产中删除“${label}”？`)) return;
  let path;
  let body = { confirm: true };
  if (kind === 'stickers') path = `/api/assets/stickers/${encodeURIComponent(entry.id)}`;
  else if (kind === 'slang') path = `/api/assets/slang/${encodeURIComponent(entry.id)}`;
  else if (kind === 'identities') path = `/api/assets/identities/${encodeURIComponent(entry.userId)}`;
  else {
    path = '/api/assets/memory';
    body = { ...body, chatKey: entry.chatKey, userId: entry.userId };
  }
  try {
    const result = await api(path, { method: 'DELETE', body: JSON.stringify(body) });
    state.assetOverview = null;
    state.assetDetail = null;
    if (state.tab === 'identity') await loadIdentityFeaturePage();
    else await loadAssetObservatory();
    if (result?.cleanupPending) {
      alert(result.warning || '资产已删除，但图片文件仍待清理');
    }
  } catch (error) {
    alert(`删除失败：${error.message}`);
  }
}

function renderAssetObservatory() {
  const box = $('#asset-page');
  if (!box) return;
  const overview = state.assetOverview || {};
  const kind = state.assetKind || 'stickers';
  const slangStatus = state.assetSlangStatus || '';
  const slangResearchState = state.assetSlangResearchState || '';
  let content = '<div class="empty-hint">加载中…</div>';
  if (state.assetDetail) {
    if (kind === 'stickers') content = renderStickerAssets(state.assetDetail);
    if (kind === 'slang') content = renderSlangAssets(state.assetDetail);
    if (kind === 'slang-research') content = renderSlangResearch(state.assetDetail);
  }
  box.innerHTML = `
    <div class="asset-head">
      <div><h2>AI 资产观测</h2><span class="muted">更新于 ${overview.generatedAt ? esc(fmtTime(overview.generatedAt)) : '-'}</span></div>
      <button type="button" class="icon-btn" id="asset-refresh" title="刷新当前资产" aria-label="刷新当前资产">↻</button>
    </div>
    ${renderAssetSummary(overview)}
    <div class="asset-toolbar">
      <div class="asset-kinds">
        ${ASSET_KINDS.map(([value, label]) =>
          `<button type="button" class="${kind === value ? 'active' : ''}" data-asset-kind="${value}">${label}</button>`
        ).join('')}
      </div>
      <div class="asset-toolbar-actions">
        ${kind === 'slang-research'
          ? ''
          : '<button type="button" class="btn btn-small btn-primary" id="asset-add">＋ 新增</button>'}
        <div class="asset-search">
        <input type="search" id="asset-query" value="${esc(state.assetQuery)}" placeholder="搜索" />
        ${kind === 'slang' ? `<select id="asset-slang-status">
          <option value="" ${slangStatus ? '' : 'selected'}>全部状态</option>
          <option value="confirmed" ${slangStatus === 'confirmed' ? 'selected' : ''}>已确认</option>
          <option value="candidate" ${slangStatus === 'candidate' ? 'selected' : ''}>候选</option>
          <option value="rejected" ${slangStatus === 'rejected' ? 'selected' : ''}>已拒绝</option>
        </select>` : ''}
        ${kind === 'slang-research' ? `<select id="asset-slang-research-state">
          <option value="" ${slangResearchState ? '' : 'selected'}>全部阶段</option>
          <option value="pending_research" ${slangResearchState === 'pending_research' ? 'selected' : ''}>待研究审批</option>
          <option value="research_queued,researching" ${slangResearchState === 'research_queued,researching' ? 'selected' : ''}>研究中</option>
          <option value="pending_admission" ${slangResearchState === 'pending_admission' ? 'selected' : ''}>待入库审批</option>
          <option value="admitted_candidate" ${slangResearchState === 'admitted_candidate' ? 'selected' : ''}>已加入候选</option>
          <option value="research_failed,research_interrupted" ${slangResearchState === 'research_failed,research_interrupted' ? 'selected' : ''}>失败或中断</option>
          <option value="research_rejected,admission_rejected" ${slangResearchState === 'research_rejected,admission_rejected' ? 'selected' : ''}>已拒绝</option>
        </select>` : ''}
        <button type="button" class="btn btn-small" id="asset-search-btn">搜索</button>
        </div>
      </div>
    </div>
    <div id="asset-content">${content}</div>`;

  $$('#asset-page [data-asset-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      state.assetKind = button.dataset.assetKind;
      state.assetQuery = '';
      state.assetSlangStatus = '';
      state.assetSlangResearchState = '';
      state.assetDetail = null;
      loadAssetObservatory();
    });
  });
  $('#asset-refresh')?.addEventListener('click', () =>
    loadAssetObservatory({ refreshStickers: kind === 'stickers' }));
  $('#asset-add')?.addEventListener('click', () => openAssetEditor(kind));
  const search = () => {
    state.assetQuery = $('#asset-query')?.value || '';
    state.assetSlangStatus = $('#asset-slang-status')?.value || '';
    state.assetSlangResearchState = $('#asset-slang-research-state')?.value || '';
    loadAssetObservatory();
  };
  $('#asset-search-btn')?.addEventListener('click', search);
  $('#asset-query')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') search();
  });
  $('#asset-slang-status')?.addEventListener('change', search);
  $('#asset-slang-research-state')?.addEventListener('change', search);
  $$('#asset-content .slang-research-action').forEach((button) => {
    button.addEventListener('click', async () => {
      const entry = state.assetDetail?.discoveries?.find((item) =>
        item.id === button.dataset.id);
      if (!entry) return;
      button.disabled = true;
      try {
        await decideSlangResearch(entry, button.dataset.action);
      } catch (error) {
        alert(`操作失败：${error.message}`);
        button.disabled = false;
      }
    });
  });
  $$('#asset-content .asset-edit').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = button.dataset.assetIndex !== undefined
        ? state.assetDetail?.entries?.[Number(button.dataset.assetIndex)]
        : state.assetDetail?.entries?.find((item) =>
            String(item.id ?? item.userId) === String(button.dataset.assetId));
      if (entry) openAssetEditor(kind, entry);
    });
  });
  $$('#asset-content .asset-delete').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = button.dataset.assetIndex !== undefined
        ? state.assetDetail?.entries?.[Number(button.dataset.assetIndex)]
        : state.assetDetail?.entries?.find((item) =>
            String(item.id ?? item.userId) === String(button.dataset.assetId));
      if (entry) deleteAsset(kind, entry);
    });
  });
}

async function loadAssetObservatory({ refreshStickers = false } = {}) {
  const box = $('#asset-page');
  if (!box) return;
  const requestId = ++state.assetLoadSeq;
  const kind = state.assetKind;
  const assetQuery = state.assetQuery;
  const slangStatus = state.assetSlangStatus;
  const slangResearchState = state.assetSlangResearchState;
  if (!state.assetOverview) box.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [overview, chats] = await Promise.all([
      api('/api/assets/overview'),
      api('/api/chats').catch(() => ({ chats: [] }))
    ]);
    if (
      state.tab !== 'assets'
      || requestId !== state.assetLoadSeq
      || kind !== state.assetKind
    ) return;
    const query = encodeURIComponent(assetQuery || '');
    let detail;
    if (kind === 'stickers') {
      detail = await api(
        `/api/assets/stickers?limit=200&query=${query}${refreshStickers ? '&refresh=1' : ''}`
      );
    } else if (kind === 'slang') {
      detail = await api(
        `/api/assets/slang?limit=500&query=${query}&status=${encodeURIComponent(slangStatus || '')}`
      );
    } else if (kind === 'slang-research') {
      detail = await api(
        `/api/slang-pilot/discoveries?limit=500&query=${query}&state=${encodeURIComponent(slangResearchState || '')}`
      ).catch((error) => ({
        disabled: true,
        error: error.message,
        discoveries: []
      }));
    } else {
      detail = { entries: [] };
    }
    if (
      state.tab !== 'assets'
      || requestId !== state.assetLoadSeq
      || kind !== state.assetKind
      || assetQuery !== state.assetQuery
      || slangStatus !== state.assetSlangStatus
      || slangResearchState !== state.assetSlangResearchState
    ) return;
    state.assetOverview = overview;
    if (chats.chats?.length) state.chats = chats.chats;
    state.assetDetail = detail;
    renderAssetObservatory();
  } catch (error) {
    if (requestId !== state.assetLoadSeq || state.tab !== 'assets') return;
    box.innerHTML = `<div class="empty-hint">资产读取失败：${esc(error.message)}</div>`;
  }
}

// ── 记忆视图 ──
async function loadMemoryView() {
  try {
    const [cfg, chats] = await Promise.all([api('/api/config'), api('/api/chats')]);
    state.config = cfg;
    const files = await api('/api/memory-files');
    state.memoryFiles = files.files || [];
    state.chats = chats.chats || [];
    // 用后端状态校正本地记录：覆盖"页面刚刷新""SSE 断连期间状态变化"两种情况。
    // 后端 consolidating 是唯一可信来源（它在 orchestrator 里真实维护）。
    for (const f of state.memoryFiles) {
      if (f.consolidating) {
        if (!state.consolidating[f.chatKey]) {
          state.consolidating[f.chatKey] = { startedAt: Date.now() };
        }
      } else if (state.consolidating[f.chatKey]) {
        // 后端已经不在整理，说明完成了（结果由 SSE 事件补充）
        delete state.consolidating[f.chatKey];
        if (!state.consolidateResult[f.chatKey]) {
          state.consolidateResult[f.chatKey] = { note: '整理完成', at: Date.now() };
        }
      }
    }
    renderMemoryList();
    if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

// 整理中的计时刷新：让"已 Ns"持续走动，并在没有活跃任务时自动停掉。
// 整理可能持续几十秒，用户切走再切回时靠它维持可见状态。
let consolidateTicker = null;
function startConsolidateTicker() {
  if (consolidateTicker) return;
  consolidateTicker = setInterval(() => {
    const active = Object.keys(state.consolidating);
    if (!active.length) {
      clearInterval(consolidateTicker);
      consolidateTicker = null;
      if (state.tab === 'memory') renderMemoryList();
      return;
    }
    if (state.tab !== 'memory') return;
    // 只更新计时文本，不重建整个详情页（避免打断用户阅读/滚动）
    const key = state.currentMemoryChatKey;
    const el = $('#mem-consolidate-status');
    if (key && state.consolidating[key] && el) {
      const sec = Math.max(0, Math.round((Date.now() - (state.consolidating[key].startedAt || Date.now())) / 1000));
      el.textContent = `整理中…（已 ${sec}s）`;
    }
    renderMemoryList();
  }, 1000);
}

function renderMemoryList() {
  const box = $('#memory-items');
  const files = state.memoryFiles || [];
  const names = {};
  for (const c of state.chats || []) names[c.key] = formatChatTitle(c.key, chatNameOf(c.key));
  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何记忆（等机器人使用记忆工具后才会出现）</div>';
    return;
  }
  box.innerHTML = files.map((f) => {
    const key = f.chatKey;
    const busy = !!state.consolidating[key];
    // 整理中：在列表项上直接标出，切页签回来也能一眼看到
    const busyHtml = busy
      ? `<span class="unread-pill" style="background:var(--color-background-warning)">整理中…</span>`
      : '';
    const sub = busy
      ? '正在整理本群记忆'
      : [
          f.hasHandoff ? '有会话交接' : '',
          f.memberCount ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象` : '暂无群友印象'
        ].filter(Boolean).join(' · ');
    return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(names[key] || key)}</span>
          ${busyHtml}
        </div>
        <div class="chat-item-sub">${esc(sub)}</div>
        <div class="session-meta"><span>更新于 ${fmtTime(f.updatedAt || 0)}</span></div>
      </div>`;
  }).join('');
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => {
      state.currentMemoryChatKey = el.dataset.key;
      renderMemoryList();
      loadMemoryDetail(state.currentMemoryChatKey);
    });
  });
}

/** 记忆页每条印象前面的标记：「[09-20 · 模型记的] 」——多老 + 谁写的，一眼分得开。
 *  时间戳以前会被每次整理刷成当天（已修），所以这个日期现在真能当"年龄"看。
 *  今年的只显示月-日；往年的要带年份，否则 1 月看到 [12-20] 会像是"还没到的那天"。 */
function impressionMetaLabel(entry) {
  const raw = Number(entry?.lastObservedAt || entry?.createdAt) || 0;
  // 坏数据（负数/纳秒级/超范围）会让 toISOString 抛 RangeError，整页记忆一起挂 —— 回退成 ??
  const at = Number.isFinite(raw) && raw > 0 && raw <= 8.64e15 ? raw : 0;
  const shanghai = (ts) => new Date(ts + 8 * 60 * 60 * 1000).toISOString();
  const thisYear = shanghai(Date.now()).slice(0, 4);
  let when = '??-??';
  if (at > 0) {
    const key = shanghai(at);
    when = key.startsWith(thisYear) ? key.slice(5, 10) : key.slice(0, 10);
  }
  const origin = { model: '模型记的', consolidated: '整理改写', manual: '手动编辑' }[entry?.origin] || '早先的';
  return `[${when} · ${origin}] `;
}

async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [mem, cfg] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config')
    ]);
    const notes = cfg.memberNotes || {};
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const members = Array.isArray(mem.members) ? mem.members : [];
    const handoff = mem.handoff || null;
    const listText = (value) => (Array.isArray(value) ? value : []).join('\n');
    const ttlMinutes = handoff
      ? Math.max(5, Math.round(((Number(handoff.expiresAt) || 0) - (Number(handoff.updatedAt) || Date.now())) / 60000))
      : Number(cfg.memory?.handoffTtlMinutes) || 1440;
    const handoffMeta = handoff
      ? `更新于 ${fmtTime(handoff.updatedAt)} · 过期于 ${fmtTime(handoff.expiresAt)}${handoff.sourceSessionId ? ` · 来源 ${esc(handoff.sourceSessionId)}` : ''}`
      : '当前没有会话交接状态';
    const handoffHtml = `
      <details class="collapsible memory-handoff" open>
        <summary>会话交接状态</summary>
        <div class="coll-body">
          <div class="field-row">
            <div class="field"><label>当前话题</label><input type="text" id="mh-topic" maxlength="200" value="${esc(handoff?.topic || '')}" /></div>
            <div class="field"><label>有效时间（分钟）</label><input type="number" id="mh-ttl" min="5" max="10080" value="${esc(ttlMinutes)}" /></div>
          </div>
          <div class="field"><label>已知上下文</label><textarea id="mh-summary" maxlength="1200">${esc(handoff?.summary || '')}</textarea></div>
          <div class="field-row">
            <div class="field"><label>待验证假设（一行一条）</label><textarea id="mh-hypotheses">${esc(listText(handoff?.hypotheses))}</textarea></div>
            <div class="field"><label>关键证据（一行一条）</label><textarea id="mh-evidence">${esc(listText(handoff?.evidence))}</textarea></div>
          </div>
          <div class="field-row">
            <div class="field"><label>已确认事实（一行一条）</label><textarea id="mh-facts">${esc(listText(handoff?.facts))}</textarea></div>
            <div class="field"><label>已作决定（一行一条）</label><textarea id="mh-decisions">${esc(listText(handoff?.decisions))}</textarea></div>
          </div>
          <div class="field-row">
            <div class="field"><label>已排除方向（一行一条）</label><textarea id="mh-rejected">${esc(listText(handoff?.rejectedDirections))}</textarea></div>
            <div class="field"><label>未解决问题（一行一条）</label><textarea id="mh-questions">${esc(listText(handoff?.openQuestions))}</textarea></div>
          </div>
          <div class="field"><label>下一步意图</label><textarea id="mh-next-step" maxlength="400">${esc(handoff?.nextStep || '')}</textarea></div>
          <div class="memory-handoff-actions">
            <span id="mh-status" class="muted">${handoffMeta}</span>
            <button class="btn btn-danger" id="mh-clear" ${handoff ? '' : 'disabled'}>清除</button>
            <button class="btn btn-primary" id="mh-save">保存交接</button>
          </div>
        </div>
      </details>`;
    const membersHtml = kind === 'group'
      ? `<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>`
      : '';
    const rows = members.map((m) => {
      const who = notes[String(m.userId)] || m.name || m.userId || '某人';
      const qq = m.userId ? ` <span class="muted">(QQ ${esc(m.userId)})</span>` : '';
      const imps = m.impressions.map((e) => `- ${impressionMetaLabel(e)}${e.content}`).join('\n');
      return `<div class="collapsible" open>
        <summary>${esc(who)}${qq}（${m.impressions.length} 条）
          <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:8px">编辑</button>
          <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新记忆</button>
        </summary>
        <div class="coll-body">${esc(imps)}</div>
      </div>`;
    }).join('');
    // 整理状态从 state 恢复：切页签回来 / 刷新页面后依然可见
    const busy = !!state.consolidating[chatKey];
    const result = state.consolidateResult[chatKey];
    let consolidateStatusHtml = '';
    if (busy) {
      const started = state.consolidating[chatKey]?.startedAt || Date.now();
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">整理中…（已 ${sec}s）</span>`;
    } else if (result) {
      const ago = Math.max(0, Math.round((Date.now() - (result.at || 0)) / 1000));
      const when = ago < 60 ? `${ago}s 前` : `${Math.round(ago / 60)} 分钟前`;
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">${esc(result.note)}（${when}）</span>`;
    } else {
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted"></span>`;
    }
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的记忆</h2>
        <div class="sub">
          <span>每个群友一个文件：data/memory/${esc(chatKey.replace(':', '_'))}/&lt;QQ&gt;.json</span>
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群记忆'}</button>
          ${consolidateStatusHtml}
        </div>
      </div>
      ${handoffHtml}
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}
    `;
    const handoffPath = `/api/memory-files/${chatKey.replace(':', '_')}/handoff`;
    const lines = (id) => ($(id)?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    $('#mh-save')?.addEventListener('click', async () => {
      const btn = $('#mh-save');
      const status = $('#mh-status');
      btn.disabled = true;
      if (status) status.textContent = '保存中…';
      try {
        await api(handoffPath, {
          method: 'PUT',
          body: JSON.stringify({
            topic: ($('#mh-topic')?.value || '').trim(),
            summary: ($('#mh-summary')?.value || '').trim(),
            hypotheses: lines('#mh-hypotheses'),
            evidence: lines('#mh-evidence'),
            facts: lines('#mh-facts'),
            decisions: lines('#mh-decisions'),
            rejectedDirections: lines('#mh-rejected'),
            openQuestions: lines('#mh-questions'),
            nextStep: ($('#mh-next-step')?.value || '').trim(),
            ttlMinutes: Number($('#mh-ttl')?.value) || 1440
          })
        });
        await loadMemoryView();
      } catch (e) {
        btn.disabled = false;
        if (status) status.textContent = `保存失败：${e.message}`;
      }
    });
    $('#mh-clear')?.addEventListener('click', async () => {
      if (!await askForConfirmation('确定清除这个会话的交接状态？')) return;
      const btn = $('#mh-clear');
      btn.disabled = true;
      try {
        await api(handoffPath, { method: 'DELETE', body: '{}' });
        await loadMemoryView();
      } catch (e) {
        btn.disabled = false;
        const status = $('#mh-status');
        if (status) status.textContent = `清除失败：${e.message}`;
      }
    });
    const loadMembersBtn = $('#mem-load-members-btn');
    if (loadMembersBtn) loadMembersBtn.addEventListener('click', () => loadGroupMembers(chatId, chatKey));
    $$('.mem-edit-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        openMemberImpressModal(chatKey, m || { userId: el.dataset.qq, name: el.dataset.name, impressions: [] });
      });
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));
    // 针对单个群友更新记忆：有印象→整理合并；无印象→从聊天记录提炼
    $$('.mem-refresh-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        if (!/^\d{1,15}$/.test(uid)) { alert('该群友缺少 QQ 号，无法定位聊天记录'); return; }
        el.disabled = true;
        const old = el.textContent;
        el.textContent = '更新中…';
        // 同样记进 state，切页签回来后仍能看到进行中
        state.consolidating[chatKey] = { startedAt: Date.now() };
        delete state.consolidateResult[chatKey];
        startConsolidateTicker();
        renderMemoryList();
        try {
          await api('/api/memory-files/consolidate', {
            method: 'POST',
            body: JSON.stringify({ chatKey, userIds: [uid] })
          });
          el.textContent = '已提交 ✓';
        } catch (err) {
          // 请求在客户端就失败时不会有 SSE 的 consolidate-done 来收尾：
          // 必须自己把"整理中"摘掉，否则列表永远显示"整理中…"、计时器也一直空转
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${err.message}`, at: Date.now(), failed: true };
          el.textContent = '失败';
          alert(`更新记忆失败：${err.message}`);
          renderMemoryList();
        }
        setTimeout(() => { el.disabled = false; el.textContent = old; }, 2500);
      });
    });
    $('#mem-consolidate-btn')?.addEventListener('click', async () => {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      // 立刻记进 state：即使马上切走页签，回来也能看到"整理中"
      state.consolidating[chatKey] = { startedAt: Date.now() };
      delete state.consolidateResult[chatKey];
      startConsolidateTicker();
      renderMemoryList();
      if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
      if (status) status.textContent = '整理中…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        if (r.error) {
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${r.error}`, at: Date.now(), failed: true };
          if (status) status.textContent = `失败：${r.error}`;
          if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
        renderMemoryList();
      }
    });
    // 若本群正在整理，启动计时刷新（切回来时也能接着走）
    if (state.consolidating[chatKey]) startConsolidateTicker();
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */
function openMemberImpressModal(chatKey, member) {
  const isEdit = !!(member && member.userId);
  const userId = member?.userId || '';
  const name = member?.name || '';
  const imps = (member?.impressions || []).map((e) => e.content).join('\n');
  const cfg = state.config || {};
  const notes = cfg.memberNotes || {};
  const note = notes[String(userId)] || '';
  const overlay = modelModalShell({
    head: isEdit ? `编辑群友印象：${note || name || userId}` : '添加群友印象',
    body: `
      ${isEdit ? `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="mi-qq" value="${esc(userId)}" readonly /></div>
        <div class="field"><label>QQ 昵称</label><input type="text" id="mi-nickname" value="${esc(name)}" readonly /></div>
        <div class="field"><label>群内昵称</label><input type="text" id="mi-card" value="${esc(member?.card || '')}" readonly /></div>
      </div>
      <div class="field"><label>QQ agent 对群友的当前备注</label><input type="text" id="mi-note" value="${esc(note)}" placeholder="留空则使用原群名片/昵称" /></div>` : `
      <div class="field"><label>QQ 号（必填）</label><input type="text" id="mi-qq" value="${esc(userId)}" /></div>
      <div class="field"><label>名字（备注名/群名片/昵称）</label><input type="text" id="mi-name" value="${esc(name)}" /></div>`}
      <div class="field"><label>印象内容（一行一条；留空 = 删除该成员全部印象）</label><textarea id="mi-imps" style="min-height:160px" placeholder="老王喜欢钓鱼，周末常不在&#10;说话爱玩梗，别太认真">${esc(imps)}</textarea></div>`,
    foot: `<button class="btn" id="mi-cancel">取消</button>
           ${isEdit ? '<button class="btn btn-danger" id="mi-del">删除此人</button>' : ''}
           <button class="btn btn-primary" id="mi-save">保存</button>`
  });
  overlay.querySelector('#mi-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mi-save').addEventListener('click', async () => {
    const qq = ($('#mi-qq')?.value || '').trim();
    const nm = ($('#mi-name')?.value || $('#mi-nickname')?.value || '').trim();
    const newNote = ($('#mi-note')?.value || '').trim();
    const lines = ($('#mi-imps')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!/^\d{1,15}$/.test(qq)) { alert('QQ 号必须是数字'); return; }
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${qq}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nm, note: newNote, impressions: lines })
      });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mi-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!await askForConfirmation(`确定删除 ${note || name || userId} 在本会话里的印象？（其它会话记得的印象不受影响；服务端会留可回滚快照）`)) return;
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}

async function loadGroupMembers(chatId, chatKey) {
  const status = $('#mem-members-status');
  if (status) status.textContent = '拉取中…';
  try {
    const data = await api(`/api/groups/${chatId}/members`);
    state.groupMembers = data.members || [];
    state.groupMembersLoaded = true;
    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    const box = $('#mem-members');
    if (box) {
      box.innerHTML = `<div class="collapsible" open><summary>群成员（${state.groupMembers.length} 人）</summary><div class="coll-body"><table class="member-table">
        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:90px;text-align:right">备注</th></tr>
        ${state.groupMembers.map((m) => {
          const note = notes[String(m.userId)];
          return `<tr>
            <td>${esc(note || m.card || '—')}${note && (m.card || m.nickname) ? ` <span class="muted">(${esc(m.card || m.nickname)})</span>` : ''}</td>
            <td>${esc(m.nickname || '—')}</td>
            <td class="muted" style="font-size:11px">${esc(m.userId)}</td>
            <td style="text-align:right"><button class="btn btn-small member-note-edit" data-qq="${esc(m.userId)}">编辑备注</button></td>
          </tr>`;
        }).join('')}
      </table></div></div>`;
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });
    }
    if (status) status.textContent = `已拉取 ${state.groupMembers.length} 人`;
  } catch (e) {
    if (status) status.textContent = `拉取失败：${e.message}`;
  }
}

async function openMemberNoteModal(qq, chatKey) {
  const cfg = state.config || await api('/api/config');
  const notes = cfg.memberNotes || {};
  const oldNote = notes[String(qq)] || '';
  const member = (state.groupMembers || []).find((m) => String(m.userId) === String(qq));
  const displayName = member ? String(member.card || member.nickname || '') : '';
  const overlay = modelModalShell({
    head: `编辑备注：${oldNote || displayName || qq}`,
    body: `
      <div class="field"><label>QQ 号</label><input type="text" value="${esc(qq)}" readonly style="width:100%" /></div>
      <div class="field"><label>备注名</label><input type="text" id="mn-note" value="${esc(oldNote)}" placeholder="${esc(displayName || '备注名（如 老王）')}" style="width:100%" /></div>
      <div class="hint">保存后，聊天记录、记忆、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
    foot: `<button class="btn" id="mn-cancel">取消</button>
           ${oldNote ? '<button class="btn btn-danger" id="mn-delete">删除备注</button>' : ''}
           <button class="btn btn-primary" id="mn-save">保存</button>`
  });
  overlay.querySelector('#mn-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mn-save').addEventListener('click', async () => {
    const name = $('#mn-note')?.value.trim() || '';
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    if (name) nextNotes[String(qq)] = name; else delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mn-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}
async function loadSettings() {
  const [cfg, tplData, provData, visionData, priceData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [], failed: true })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/model-prices').catch(() => ({ prices: [], current: null }))
  ]);
  state.config = cfg;
  syncGraduatedFeatureNavigation(cfg);
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.modelPrices = priceData || { prices: [], current: null };
  state.personaTemplates = {};
  state.personaTemplatesVersion = (state.personaTemplatesVersion || 0) + 1;   // 卡库变了：让卡库/正文的缓存指纹失效
  state.personaTemplatesFailed = tplData.failed === true;
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = {
    name: t.name, text: t.text, customRules: t.customRules || '',
    behaviorProfile: t.behaviorProfile || 'legacy', builtin: !!t.builtin
  };
  renderSettings();
}

/** 设置页「远程价格表」状态行：来源（在线/缓存/内置）、时间、条目数、错误。 */
/**
 * 渠道价目表列表（设置页）：每个渠道的地址、条数、上次时间、错误 + 拉取/删除。
 * 数据来自 /api/model-prices 的 channelFeeds（后端 src/pricing/channel-prices.js）。
 */
function renderChannelFeeds() {
  const box = $('#channel-feeds');
  if (!box) return;
  const feeds = state.modelPrices?.channelFeeds || [];
  if (!feeds.length) {
    box.innerHTML = '<div class="muted" style="font-size:12px">还没有配置渠道价目表。用下面的「从渠道自动拉价」探测一次，或直接填 URL。</div>';
    return;
  }
  box.innerHTML = feeds.map((f) => {
    const when = f.fetchedAt ? fmtTime(f.fetchedAt) : '-';
    const state1 = f.ok
      ? `生效中：${f.count} 条 · 上次拉取 ${when}${f.dropped ? ` · ${f.dropped} 条不合格` : ''}`
      : `拉取失败：${esc(f.error || '未知错误')}${f.count ? ` · 仍在用上次的 ${f.count} 条` : ''}`;
    return `<div class="cf-row">
      <div class="cf-main"><strong>${esc(f.vendor)}</strong><span class="muted">${esc(f.url)}</span></div>
      <div class="cf-state ${f.ok ? 'ok' : 'bad'}">${state1}</div>
      <div class="cf-actions">
        <button class="btn btn-small" data-feed-refresh="${esc(f.vendor)}">立即拉取</button>
        <button class="btn btn-small" data-feed-remove="${esc(f.vendor)}">删除</button>
      </div>
    </div>`;
  }).join('');
}

/** 探测渠道价：只预览，不写配置。 */
async function runChannelProbe() {
  const statusEl = $('#probe-status');
  const resultEl = $('#probe-result');
  const btn = $('#probe-btn');
  const url = String($('#probe-url')?.value || '').trim();
  if (btn) btn.disabled = true;
  if (resultEl) { resultEl.classList.add('hidden'); resultEl.innerHTML = ''; }
  if (statusEl) { statusEl.textContent = '探测中…（读渠道的 /api/pricing）'; statusEl.className = 'hint'; }
  try {
    const res = await api('/api/model-prices/probe', { method: 'POST', body: JSON.stringify({ url }) });
    state.probeResult = res;
    renderProbeResult(res);
  } catch (error) {
    if (statusEl) { statusEl.textContent = `探测失败：${error.message}`; statusEl.className = 'hint error'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 渲染探测结果：识别方式 + 预览表 + 写入按钮（只写入在用的 / 全部写入）。 */
async function renderProbeResult(res) {
  const statusEl = $('#probe-status');
  const resultEl = $('#probe-result');
  if (!resultEl) return;
  if (!res?.ok) {
    if (statusEl) {
      statusEl.textContent = res?.error || '探测失败';
      statusEl.className = 'hint error';
    }
    if (Array.isArray(res?.tried) && res.tried.length) {
      resultEl.classList.remove('hidden');
      resultEl.innerHTML = `<div class="muted" style="font-size:12px">试过的地址：<br>${res.tried.map((u) => esc(u)).join('<br>')}</div>`;
    }
    return;
  }
  const entries = Object.entries(res.prices || {});
  const kindTxt = res.kind === 'one-api'
    ? `按 one-api/new-api 倍率换算（分组 ${esc(res.group || 'default')} ×${res.groupRatio} · 汇率 ${res.usdRate}）`
    : '直接读到的价目表（元/百万 token）';
  const vendor = String(res.vendor || state.modelPrices?.currentVendor || '');
  if (statusEl) {
    statusEl.textContent = `识别到 ${res.modelCount} 个模型：${kindTxt}`
      + `${res.skipped ? `；${res.skipped} 条按次计费已跳过` : ''}`;
    statusEl.className = 'hint';
  }

  // 在用的模型：当前模型 + 最近 30 天用量里出现过的
  const used = new Set();
  const current = String(state.config?.api?.model || '').trim();
  if (current) used.add(current);
  try {
    const stats = await api('/api/usage/stats?range=30');
    for (const m of (stats?.models || [])) if (m?.model) used.add(String(m.model));
  } catch { /* 拿不到用量就只按当前模型 */ }
  const usedHits = entries.filter(([model]) => used.has(model));

  const preview = entries.slice(0, 12).map(([model, p]) => (
    `<tr><td>${esc(model)}${used.has(model) ? '<span class="uc-chip">在用</span>' : ''}</td>`
    + `<td class="r">${p.in}</td><td class="r">${p.out}</td><td class="r">${p.cached ?? '-'}</td></tr>`
  )).join('');
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = `
    <table class="usage-table" style="margin-top:4px">
      <thead><tr><th>模型</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th></tr></thead>
      <tbody>${preview}</tbody>
    </table>
    ${entries.length > 12 ? `<div class="muted" style="font-size:12px;margin-top:4px">…等共 ${entries.length} 个模型</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
      <button class="btn btn-primary btn-small" id="probe-apply-used"
        ${usedHits.length ? '' : 'disabled'}>写入在用的 ${usedHits.length} 个</button>
      <button class="btn btn-small" id="probe-apply-all">全部写入（${entries.length} 个）</button>
    </div>
    <div class="hint" style="margin-top:4px">写入后价格以「${esc(vendor || '当前渠道')}：模型」为键存进自定义价格，只对该渠道生效；官方表不动。</div>`;

  const write = async (rows) => {
    if (!rows.length) return;
    const hx = $('#probe-status');
    const vendorLabel = vendor || state.modelPrices?.currentVendor || '';
    if (!vendorLabel) {
      if (hx) { hx.textContent = '拿不到当前渠道名，无法写成渠道价：请先在「手动添加提供商」里配好渠道。'; hx.className = 'hint error'; }
      return;
    }
    const patch = {};
    for (const [model, p] of rows) {
      patch[`${vendorLabel}：${model}`] = { in: p.in, out: p.out, cached: p.cached ?? p.in, note: p.note || '' };
    }
    try {
      const saved = await api('/api/config', { method: 'POST', body: JSON.stringify({ api: { modelPrices: patch } }) });
      if (saved?.config) state.config = saved.config;
      else {
        state.config = state.config || {};
        state.config.api = state.config.api || {};
        state.config.api.modelPrices = { ...(state.config.api.modelPrices || {}), ...patch };
      }
      if (hx) { hx.textContent = `已写入 ${rows.length} 条渠道价（${vendorLabel}）。用量页会按新价重算。`; hx.className = 'hint success'; }
      await loadSettings();
      if (state.tab === 'usage') loadUsageView({ force: true });
    } catch (error) {
      if (hx) { hx.textContent = `写入失败：${error.message}`; hx.className = 'hint error'; }
    }
  };
  $('#probe-apply-used')?.addEventListener('click', () => write(usedHits));
  $('#probe-apply-all')?.addEventListener('click', () => write(entries));
}

/** 添加/更新一个渠道价目表并立即拉取。 */
async function addChannelFeed() {
  const hint = $('#channel-feed-hint');
  const vendor = String($('#channel-feed-vendor')?.value || '').trim()
    || String(state.modelPrices?.currentVendor || '');
  const url = String($('#channel-feed-url')?.value || '').trim();
  if (!vendor || !url) {
    if (hint) { hint.textContent = '渠道名（或先在提供商里配好当前渠道）与价目表 URL 都要填。'; hint.className = 'hint error'; }
    return;
  }
  if (hint) { hint.textContent = `正在拉取 ${vendor} 的价目表…`; hint.className = 'hint'; }
  try {
    const res = await api('/api/channel-prices', { method: 'POST', body: JSON.stringify({ vendor, url }) });
    if (state.modelPrices) state.modelPrices.channelFeeds = res.feeds || [];
    renderChannelFeeds();
    const hit = (res.feeds || []).find((f) => f.vendor === vendor);
    if (hint) {
      hint.textContent = hit?.ok
        ? `已生效：${hit.count} 条（${vendor}）`
        : `配置已保存，但拉取失败：${hit?.error || '未知错误'}`;
      hint.className = `hint ${hit?.ok ? 'success' : 'error'}`;
    }
    if ($('#channel-feed-url')) $('#channel-feed-url').value = '';
  } catch (error) {
    if (hint) { hint.textContent = `添加失败：${error.message}`; hint.className = 'hint error'; }
  }
}

/** 渠道价目表行上的「立即拉取」「删除」。 */
async function onChannelFeedAction(event) {
  const refreshBtn = event.target.closest('[data-feed-refresh]');
  const removeBtn = event.target.closest('[data-feed-remove]');
  if (!refreshBtn && !removeBtn) return;
  const hint = $('#channel-feed-hint');
  const vendor = refreshBtn ? refreshBtn.dataset.feedRefresh : removeBtn.dataset.feedRemove;
  try {
    const res = refreshBtn
      ? await api('/api/channel-prices/refresh', { method: 'POST', body: JSON.stringify({ vendor }) })
      : await api('/api/channel-prices/remove', { method: 'POST', body: JSON.stringify({ vendor }) });
    if (state.modelPrices) state.modelPrices.channelFeeds = res.feeds || [];
    renderChannelFeeds();
    if (hint) {
      if (removeBtn) { hint.textContent = `已删除 ${vendor} 的价目表`; hint.className = 'hint'; }
      else {
        const hit = (res.feeds || []).find((f) => f.vendor === vendor);
        hint.textContent = hit?.ok ? `${vendor}：拉取成功，${hit.count} 条` : `${vendor}：拉取失败（${hit?.error || '未知错误'}）`;
        hint.className = `hint ${hit?.ok ? 'success' : 'error'}`;
      }
    }
    if (state.tab === 'usage') loadUsageView({ force: true });
  } catch (error) {
    if (hint) { hint.textContent = `操作失败：${error.message}`; hint.className = 'hint error'; }
  }
}

function renderPriceFeedStatus() {
  const el = $('#price-feed-status');
  if (!el) return;
  const r = state.modelPrices?.remote;
  el.className = 'hint';
  if (!r || !r.enabled) {
    el.textContent = '远程价格表已关闭（只用内置表）。想用项目默认表就把输入框清空保存，或填自己的表 URL。';
    return;
  }
  const when = r.fetchedAt ? fmtTime(r.fetchedAt) : '-';
  const droppedTxt = r.dropped ? `，${r.dropped} 条不合格被丢弃` : '';
  const from = r.sourceUrl ? ` · ${r.sourceUrl}` : (r.url ? '' : ' · 项目默认地址');
  // 地址改了、新地址还没拉成功：生效的仍是上一组地址拉到的表。
  // 这条必须排在"生效中"前面 —— 否则界面会拿新地址 + 旧数据说"已生效"。
  if (r.sourceStale) {
    el.className = 'hint error';
    el.textContent = `新地址还没拉到（${r.error || '拉取失败'}），当前生效的仍是上一次成功拉取的 ${r.sourceUrl}`
      + `（${when}${droppedTxt}）。想彻底改用新地址，先把它调通。`;
    return;
  }
  if (r.ok && r.source === 'remote') {
    el.textContent = `远程表生效中：${r.count} 条覆盖内置表 · 上次拉取 ${when}${from}${droppedTxt}`;
  } else if (!r.ok && r.source === 'cache') {
    el.textContent = `暂时拉不到（${r.error || '未知错误'}），正在用上次缓存的远程表（${r.count} 条）· ${when}`;
  } else if (!r.ok) {
    el.textContent = `拉取失败（${r.error || '未知错误'}），暂用内置表 · ${when}`;
  } else {
    el.textContent = `已应用本地缓存（${r.count} 条），正在拉取最新…`;
  }
}

/**
 * 在内置价格表里匹配模型（前端版）。
 *
 * 前端是无模块单文件，拿不到 src/pricing/model-prices.js 的导出，所以这里实现一份
 * 与后端 matchModelId 完全相同的逻辑（改后端时这里要一起改）：
 *   候选名（原样 → 去渠道前缀 → 去叫法后缀/日期后缀 → 点号归并）
 *   → 别名 → 表内精确 → 前缀匹配（取最长）
 * 返回条目并带上 confidence/via：'alias'（按别名）/ 'fuzzy'（近似）要在界面上标出来。
 * 别名表来自 /api/model-prices 的 aliases（内置 + 远程）。
 */
function matchPriceTable(modelId, table, aliases = null) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return null;
  const list = Array.isArray(table) ? table : Object.entries(table || {}).map(([id, e]) => ({ id, ...e }));
  if (!list.length) return null;
  const aliasMap = aliases || state.modelPrices?.aliases || {};

  const byId = new Map();
  for (const x of list) {
    const key = String(x?.id ?? '').toLowerCase();
    if (key) byId.set(key, x);
  }

  // 候选名（与后端 modelIdCandidates 一致）
  const candidates = [];
  const push = (id, confidence, via) => {
    if (id && !candidates.some((c) => c.id === id)) candidates.push({ id, confidence, via });
  };
  const suffixes = [':free', ':beta', ':latest', '-free', '-beta', '-latest',
    '-preview', '-exp', '-experimental', '-thinking', '-nothink', '-nonthinking', '-non-thinking'];
  push(raw, 'exact', '');
  const bare = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
  if (bare !== raw) push(bare, 'exact', '去渠道前缀');
  for (const base of [raw, bare]) {
    let id = base;
    for (const suffix of suffixes) {
      if (id.endsWith(suffix) && id.length > suffix.length) id = id.slice(0, -suffix.length);
    }
    if (id !== base) push(id, 'normalized', '去掉叫法后缀');
    const noDate = id.replace(/-(?:\d{4}|\d{6}|\d{8})$/, '');
    if (noDate !== id) push(noDate, 'normalized', '去掉日期快照后缀');
  }
  for (const cand of [...candidates]) {
    const minor = cand.id.replace(/v(\d+)\.(\d+)/g, 'v$1');
    if (minor !== cand.id) push(minor, 'fuzzy', '点号版本归并');
    const dashed = cand.id.replace(/\./g, '-');
    if (dashed !== cand.id) push(dashed, 'fuzzy', '点号转连字符');
  }

  for (const cand of candidates) {
    const alias = aliasMap[cand.id];
    if (alias && byId.has(alias)) {
      return { ...byId.get(alias), matched: alias, confidence: 'alias', via: `${cand.id} → ${alias}` };
    }
    if (byId.has(cand.id)) {
      return { ...byId.get(cand.id), matched: cand.id, confidence: cand.confidence, via: cand.via };
    }
  }

  for (const cand of candidates) {
    let best = null;
    for (const key of byId.keys()) {
      if (
        cand.id === key
        || cand.id.startsWith(`${key}/`) || cand.id.startsWith(`${key}-`)
        || cand.id.startsWith(`${key}@`) || cand.id.startsWith(`${key}:`)
      ) {
        if (!best || key.length > best.length) best = key;
      }
    }
    if (best) return { ...byId.get(best), matched: best, confidence: 'prefix', via: '前缀匹配' };
  }
  return null;
}

/**
 * 渠道倍率：没填 = 1；填了 0 就是 0（免费渠道）。与后端 parseMultiplier 保持一致 ——
 * 不能用 `Number(x) || 1`，那会把用户填的 0 悄悄变成原价。
 */
function mulOf(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 1;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** 价格展示：最多 4 位小数并去掉尾随 0（0.0500 → 0.05）。 */
function priceTxt(value) {
  return (Number(value) || 0).toFixed(4).replace(/\.?0+$/, '') || '0';
}

/**
 * 手填的一条价目算不算"填了价"：判据是写没写 in/out 字段（0 是合法价，代表免费），
 * 与后端 hasManualPrice 保持一致。
 */
function hasOwnPrice(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (String(entry.billing ?? '').trim()) return true;
  for (const key of ['in', 'out']) {
    const value = entry[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (Number.isFinite(Number(value))) return true;
  }
  return false;
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * ⚠️ 关键：所有输入都读**界面控件的实时值**，不读 state.config。
 *   否则没点「保存设置」之前，开关/模型名怎么改都是旧值，
 *   看起来就像"按了没反应" —— 这与"可编辑性只跟开关绑定"的意图直接冲突。
 *
 * 匹配判断在本地用 state.modelPrices.prices 算，不读 state.modelPrices.current
 * —— 后者是后端按「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function refreshModelPriceCard() {
  const modelEl = $('#pc-model');
  const noteEl = $('#pc-note');
  const effEl = $('#pc-effective');
  const inputNoteEl = $('#pc-input-note');
  const inEl = $('#cfg-price-in');
  const outEl = $('#cfg-price-out');
  const cachedEl = $('#cfg-price-cached');
  if (!modelEl) return;

  const cfg = state.config || {};
  const api = cfg.api || {};

  // 实时值：优先界面控件，退回已保存配置
  const box = $('#cfg-useofficialprice');
  const modelInput = $('#cfg-model');
  const useOfficial = box ? box.checked : (api.useOfficialPrice !== false);
  const model = String((modelInput ? modelInput.value : api.model) || '').trim();
  const vendor = state.modelPrices?.currentVendor || '';

  modelEl.textContent = model ? (vendor ? `${model} · ${vendor}` : model) : '（未选择模型）';

  // ── 两组控件的分工（2026-09-21 拆开，别再合并）──
  //   #pc-effective   生效价：查价链路算出来的结果，只读展示
  //   #cfg-price-*    自填单价：只在"保存真的会生效"时可编辑 ——
  //                   官方价开关开着、或这个模型走渠道价时，保存会被守卫跳过，
  //                   那就不该让用户以为改了有用（判据与 collectConfig 的 priceEditable 一致）。
  const customMap = api.modelPrices || {};
  const ownPrice = (model && hasOwnPrice(customMap[model])) ? customMap[model] : null;
  const channelKey = model && vendor ? `${vendor}：${model}` : '';
  const hasChannelPrice = Boolean(channelKey && hasOwnPrice(customMap[channelKey]));
  const editable = !useOfficial && !hasChannelPrice;

  if (!model) {
    if (effEl) effEl.textContent = '—';
    [inEl, outEl, cachedEl].forEach((el) => { if (el) { el.value = 0; el.disabled = true; } });
    if (noteEl) noteEl.textContent = '先在上方选择一个模型，才能查看/设定它的单价。';
    if (inputNoteEl) inputNoteEl.textContent = '';
    return;
  }

  // 生效价按与后端一致的链路算：渠道价 → 自定义价 → 账户口径 → 渠道价目表 →
  // 官方/远程表（×倍率）→ 兜底 → 未定价。
  // 界面开关与已保存配置一致时，直接用后端算好的权威结果（渠道价目表那层只有后端知道）；
  // 只有用户刚拨了开关还没保存时才临时本地重算，避免"按了没反应"。
  const savedOfficial = api.useOfficialPrice !== false;
  const eff = useOfficial === savedOfficial
    ? effectivePriceFor(model, vendor)
    : effectivePriceFor(model, vendor, { useOfficialPrice: useOfficial });
  let sourceTxt = '';

  if (eff.billing === 'flat') {
    const periodTxt = eff.period === 'day' ? '元/天' : '元/月';
    sourceTxt = `包月/订阅：¥${Number(eff.amount) || 0}${periodTxt} —— 这些调用不按 token 计价，`
      + '用量页把订阅费作为固定支出单列，不计入按量成本。改计费方式用下面的「给这个模型定价」。';
  } else if (eff.billing === 'none') {
    sourceTxt = '本地/自建模型：只统计 token，不计费（也不算"未定价"）。';
  } else if (eff.source === 'channel') {
    sourceTxt = `正在使用你为「${vendor}」这个渠道单独填的价（实付口径，覆盖官方价）。`;
  } else if (eff.source === 'channel-table') {
    sourceTxt = `正在使用「${vendor}」这个渠道拉到的价目表（实付口径）。`;
  } else if (eff.source === 'custom') {
    sourceTxt = '正在使用你为这个模型填的价（实付口径，覆盖官方价）。';
  } else if (eff.source === 'remote') {
    sourceTxt = '这个价来自远程价格表（你配置的那份），可以直接改；改完就变成你自己的价。';
  } else if (eff.source === 'multiplier') {
    sourceTxt = `正在按「${eff.via || `官方价 ×${mulOf(api.costMultiplier)}`}」折算（你声明的渠道价）——`
      + '这是实付口径的估算，不是账单原样；换口径在下面的「成本怎么算」。';
  } else if (eff.source === 'manual') {
    sourceTxt = '官方价格表没有命中，正在用「全局兜底单价」估算 —— 想让这个模型更准，用下面的「给这个模型定价」。';
  } else if (eff.source === 'unmatched') {
    sourceTxt = `未定价：价格表里没有「${model}」这一条 —— 用量页会把它的成本算成 0（不是免费）。`
      + '用下面的「给这个模型定价」填一条就行。';
  } else {
    const tag = eff.src === 'official' ? '厂商官方定价页直取' : '二手折算，仅供参考';
    sourceTxt = `内置官方价格表已匹配到「${eff.matched || model}」（${tag}）。这是**估算**口径，不是你的账单；`
      + '要按实付价算，用下面的「给这个模型定价」。';
    if (eff.confidence === 'alias') {
      sourceTxt += `　按别名映射：${eff.via}。`;
    } else if (eff.confidence === 'fuzzy') {
      sourceTxt += `　近似匹配：${eff.via}（价格可能与实际型号有差异）。`;
    } else if (eff.confidence === 'normalized') {
      sourceTxt += `　匹配时${eff.via}。`;
    }
    if (eff.peak) {
      sourceTxt += `　该模型分时段计价（高峰 ${eff.peak.in}/${eff.peak.out}/${eff.peak.cached}）。`;
    }
    if (eff.image) {
      sourceTxt += '　支持图片输入：' + (eff.image.mode === 'capped'
        ? `每张封顶 ${eff.image.maxTokensPerImage} token`
        : eff.image.mode === 'pixel'
          ? `每张 = 宽×高/${eff.image.divisor}+${eff.image.base} token`
          : '换算规则待补');
    }
  }

  // 生效价：只读展示（包月/不计费/未定价直接写字，不摆一排数字）
  if (effEl) {
    effEl.textContent = eff.billing === 'flat'
      ? `包月 ¥${Number(eff.amount) || 0}/${eff.period === 'day' ? '天' : '月'}`
      : eff.billing === 'none'
        ? '不计费（只统计 token）'
        : eff.unpriced
          ? '未定价（价格表里没有这个模型）'
          : `输入 ${priceTxt(eff.in)} · 输出 ${priceTxt(eff.out)} · 缓存命中 ${priceTxt(eff.cached)}（元/百万）`;
  }

  // 自填单价：只放"用户自己填的数"（该模型的自定义价 → 全局兜底），
  // 不再把生效价填进来 —— 那正是过去"一个控件兼两种含义"的根源。
  const savedIn = ownPrice ? ownPrice.in : api.priceInputPerM;
  const savedOut = ownPrice ? ownPrice.out : api.priceOutputPerM;
  const savedCached = ownPrice ? ownPrice.cached : api.priceCachedPerM;
  if (inEl) { inEl.value = Number(savedIn) || 0; inEl.disabled = !editable; }
  if (outEl) { outEl.value = Number(savedOut) || 0; outEl.disabled = !editable; }
  if (cachedEl) { cachedEl.value = Number(savedCached) || 0; cachedEl.disabled = !editable; }
  const card = $('#model-price-card');
  if (card) card.classList.toggle('locked', !editable);
  if (inputNoteEl) {
    inputNoteEl.textContent = editable
      ? '填你的实付价，保存后覆盖上面的价格表；三项全 0 = 清除自定义。'
      : hasChannelPrice
        ? `这个模型用的是「${vendor}」的渠道价（只对该渠道生效），所以这三个框停用；要改就用下面的「给这个模型定价」另存一条。`
        : '「用内置官方价格表估算」开着，这三个框保存时会被忽略；走中转站要自填，先关掉上面那个开关。';
  }
  if (noteEl) noteEl.textContent = sourceTxt;
}

/**
 * 前端版查价链路（与后端 resolveModelPrice 保持一致，改后端时要一起改）：
 *   ① 渠道价 modelPrices[渠道：模型]  ② 自定义价 modelPrices[模型]
 *   ③ 官方/远程价格表（useOfficialPrice !== false 时）  ④ 全局兜底单价  ⑤ 未定价
 * 返回里带 kind：actual（实付）/ estimate（估算）/ unpriced（未定价），界面据此标口径。
 *
 * @param {string} model 模型 id
 * @param {string} vendor 渠道名（可空）
 * @param {object} [overrides] 覆盖 config.api 的实时值（如界面上的开关）
 */
function effectivePriceFor(model, vendor, overrides = null) {
  const api = { ...((state.config || {}).api || {}), ...(overrides || {}) };
  const customMap = api.modelPrices || {};
  const id = String(model || '').trim();
  if (!id) {
    return { in: 0, out: 0, cached: 0, source: 'unmatched', kind: 'unpriced', unpriced: true, confidence: 'none', via: '', locked: true, billing: 'token' };
  }

  // 没有临时覆盖时，优先用后端算好的权威结果（渠道价目表那层只有后端知道）
  const detail = state.modelPrices?.currentDetail;
  if (!overrides && detail && String(detail.model || '') === id
    && String(detail.vendor || '') === String(vendor || '')) {
    return { ...detail };
  }

  // 计费方式（与后端 billingOf 一致）
  const billingShape = (entry) => {
    const raw = String(entry?.billing ?? '').trim().toLowerCase();
    if (raw === 'flat') {
      return { billing: 'flat', amount: Number(entry.amount) || 0, period: String(entry.period) === 'day' ? 'day' : 'month' };
    }
    if (raw === 'none') return { billing: 'none', amount: 0, period: 'month' };
    return { billing: 'token', amount: 0, period: 'month' };
  };

  const customShape = (entry, source, matched, via) => {
    const bill = billingShape(entry);
    const perToken = bill.billing === 'token';
    return {
      in: perToken ? Number(entry.in) || 0 : 0,
      out: perToken ? Number(entry.out) || 0 : 0,
      cached: perToken ? (entry.cached == null ? Number(entry.in) || 0 : Number(entry.cached) || 0) : 0,
      peak: perToken ? (entry.peak || null) : null,
      source,
      matched,
      via,
      confidence: source,
      kind: 'actual',
      unpriced: false,
      locked: false,
      ...bill
    };
  };

  if (vendor) {
    const key = `${vendor}：${id}`;
    const hit = customMap[key];
    if (hasOwnPrice(hit)) return customShape(hit, 'channel', key, `渠道价（${vendor}）`);
  }
  const own = customMap[id];
  if (hasOwnPrice(own)) return customShape(own, 'custom', id, '自定义价');

  // 账户口径：按月付（与后端 ③ 一致）—— 固定月费，不按 token 算
  const costMode = String(api.costMode || 'official');
  const monthlyFee = Number(api.costMonthlyFee) || 0;
  if (costMode === 'subscription' && monthlyFee > 0) {
    return {
      in: 0, out: 0, cached: 0, peak: null, image: null,
      billing: 'flat', amount: monthlyFee, period: 'month',
      source: 'subscription', matched: null, via: `按月付 ¥${monthlyFee}/月`,
      confidence: 'manual', kind: 'actual', unpriced: false, locked: false
    };
  }

  if (api.useOfficialPrice !== false) {
    const hit = matchPriceTable(id, state.modelPrices?.prices || [], state.modelPrices?.aliases || null);
    if (hit) {
      const remote = hit.remote === true;
      // 渠道倍率（与后端 ⑤ 一致）：官方/远程表的价按用户声明的倍率折算，
      // 折算后是"实付"口径，所以卡片不能再按"官方估算"解释。
      const mul = costMode === 'multiplier' ? mulOf(api.costMultiplier) : 1;
      const discounted = mul !== 1;
      const scale = (value) => Number((((Number(value) || 0) * mul)).toFixed(6));
      const peak = hit.peak
        ? (discounted
          ? { in: scale(hit.peak.in), out: scale(hit.peak.out), cached: hit.peak.cached == null ? scale(hit.cached) : scale(hit.peak.cached) }
          : hit.peak)
        : null;
      const bill = billingShape(hit);
      const perToken = bill.billing === 'token';
      return {
        in: perToken ? scale(hit.in) : 0,
        out: perToken ? scale(hit.out) : 0,
        cached: perToken ? (hit.cached == null ? scale(hit.in) : scale(hit.cached)) : 0,
        peak: perToken ? peak : null,
        image: perToken ? (hit.image || null) : null,
        src: hit.src || '',
        source: discounted ? 'multiplier' : (remote ? 'remote' : 'official'),
        matched: hit.matched,
        confidence: discounted ? 'manual' : (hit.confidence || 'exact'),
        via: discounted ? `官方价 ×${mul}` : (hit.via || ''),
        kind: discounted ? 'actual' : 'estimate',
        unpriced: false,
        locked: discounted ? false : !remote,
        ...bill
      };
    }
    return { in: 0, out: 0, cached: 0, source: 'unmatched', kind: 'unpriced', unpriced: true, confidence: 'none', via: '', locked: true, billing: 'token' };
  }

  const fi = Number(api.priceInputPerM) || 0;
  const fo = Number(api.priceOutputPerM) || 0;
  if (fi || fo) {
    return {
      in: fi,
      out: fo,
      cached: Number(api.priceCachedPerM) || fi,
      source: 'manual',
      matched: null,
      via: '全局兜底单价',
      confidence: 'manual',
      kind: 'estimate',
      unpriced: false,
      locked: false,
      billing: 'token',
      amount: 0,
      period: 'month'
    };
  }
  return { in: 0, out: 0, cached: 0, source: 'unmatched', kind: 'unpriced', unpriced: true, confidence: 'none', via: '', locked: false, billing: 'token' };
}

/** 定价弹窗当前编辑的对象：{ model, vendor }。 */
let priceDialogState = null;

/** 计费方式切换时：包月只显示"金额"，token 只显示三档单价。 */
function syncPriceDialogBilling() {
  const billing = String($('#price-dialog-billing')?.value || 'token');
  const flatRow = $('#price-dialog-flat-row');
  for (const id of ['#price-dialog-token-row', '#price-dialog-token-row-2', '#price-dialog-token-row-3']) {
    const el = $(id);
    if (el) el.style.display = billing === 'flat' ? 'none' : '';
  }
  if (flatRow) flatRow.style.display = billing === 'flat' ? '' : 'none';
  const hint = $('#price-dialog-hint');
  if (hint) {
    hint.textContent = billing === 'flat'
      ? '包月/订阅：这些调用不按 token 计价，面板把它作为固定支出单列（不计入按量成本）。'
      : billing === 'none'
        ? '本地/自建模型：只统计 token，不计费（也不再算"未定价"）。'
        : '只写这一条价：同一个模型在不同渠道可以分别定价；官方价格表不会被改动，用量页会立刻按新价重算。';
  }
}

/**
 * 打开「给这个模型定价」弹窗。
 * 渠道下拉：当前渠道（默认）→ 全部渠道 → 配置里已出现过的渠道。
 * 预填当前生效价；保存只写这一条（官方表不动）。
 */
function openPriceDialog({ model, vendor } = {}) {
  const dlg = $('#price-dialog');
  if (!dlg) return;
  const cfg = state.config || {};
  const api = cfg.api || {};
  const customMap = api.modelPrices || {};
  const currentVendor = String(vendor || state.modelPrices?.currentVendor || '');
  const modelId = String(model || api.model || '').trim();
  priceDialogState = { model: modelId, vendor: currentVendor };

  const channels = new Set();
  for (const key of Object.keys(customMap)) {
    const i = key.indexOf('：');
    if (i > 0) channels.add(key.slice(0, i));
  }
  if (currentVendor) channels.delete(currentVendor);
  const options = [];
  if (currentVendor) options.push({ value: currentVendor, label: `当前渠道（${currentVendor}）` });
  options.push({ value: '', label: '全部渠道（不分渠道）' });
  for (const v of [...channels].sort()) options.push({ value: v, label: v });
  const select = $('#price-dialog-channel');
  if (select) {
    select.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    select.value = currentVendor;
  }

  const eff = effectivePriceFor(modelId, currentVendor);
  for (const [id, value] of [['#price-dialog-in', eff.in], ['#price-dialog-out', eff.out], ['#price-dialog-cached', eff.cached]]) {
    const el = $(id);
    if (el) el.value = Number(value) || 0;
  }
  const billingSel = $('#price-dialog-billing');
  if (billingSel) billingSel.value = eff.billing === 'flat' ? 'flat' : (eff.billing === 'none' ? 'none' : 'token');
  const amountEl = $('#price-dialog-amount');
  if (amountEl) amountEl.value = Number(eff.amount) || '';
  const periodEl = $('#price-dialog-period');
  if (periodEl) periodEl.value = eff.period === 'day' ? 'day' : 'month';
  syncPriceDialogBilling();

  const title = $('#price-dialog-title');
  if (title) title.textContent = modelId ? `给「${modelId}」定价` : '给模型定价';
  const sub = $('#price-dialog-sub');
  if (sub) {
    sub.textContent = eff.kind === 'unpriced'
      ? '这个模型现在没有价（成本算 0）。填一条只影响它，官方价格表不会被改动。'
      : `当前生效价来自：${eff.via || eff.source}。保存后这条价优先于官方价。`;
  }
  const result = $('#price-dialog-result');
  if (result) { result.textContent = ''; result.className = 'control-result muted'; }
  const delBtn = $('#price-dialog-delete');
  if (delBtn) delBtn.style.display = (eff.source === 'channel' || eff.source === 'custom') ? '' : 'none';
  if (!dlg.open) dlg.showModal();
}

/** 保存定价弹窗：只写 modelPrices 的一条（键 = 渠道：模型 或 模型）。 */
async function savePriceDialog() {
  const st = priceDialogState;
  const result = $('#price-dialog-result');
  if (!st?.model) return;
  const vendor = String($('#price-dialog-channel')?.value || '');
  const billing = String($('#price-dialog-billing')?.value || 'token');
  const num = (sel) => Number(String($(sel)?.value ?? '').trim()) || 0;
  const key = vendor ? `${vendor}：${st.model}` : st.model;
  let entry;
  if (billing === 'flat') {
    const amount = num('#price-dialog-amount');
    if (!(amount > 0)) {
      if (result) { result.textContent = '包月要填金额（元）。'; result.className = 'control-result error'; }
      return;
    }
    entry = { billing: 'flat', amount, period: String($('#price-dialog-period')?.value || 'month') };
  } else if (billing === 'none') {
    entry = { billing: 'none' };
  } else {
    const inV = num('#price-dialog-in');
    const outV = num('#price-dialog-out');
    if (!inV && !outV) {
      if (result) { result.textContent = '输入/输出至少要填一个非 0 的数。'; result.className = 'control-result error'; }
      return;
    }
    entry = { in: inV, out: outV, cached: num('#price-dialog-cached') };
  }
  try {
    const res = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ api: { modelPrices: { [key]: entry } } })
    });
    if (res?.config) state.config = res.config;
    else {
      // 接口没回整体配置时，本地也要记上，否则卡片/重算还在用旧价
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = { ...(state.config.api.modelPrices || {}), [key]: entry };
    }
    if (result) { result.textContent = `已保存：${key}`; result.className = 'control-result success'; }
    $('#price-dialog')?.close();
    refreshModelPriceCard();
    // 用量页正在看的话，让它重算（价格变了）
    if (state.tab === 'usage') loadUsageView({ force: true });
  } catch (error) {
    if (result) { result.textContent = `保存失败：${error.message}`; result.className = 'control-result error'; }
  }
}

/** 删除当前正在生效的那条自定义/渠道价。 */
async function deletePriceDialog() {
  const st = priceDialogState;
  const result = $('#price-dialog-result');
  if (!st?.model) return;
  const vendor = String($('#price-dialog-channel')?.value || '');
  const key = vendor ? `${vendor}：${st.model}` : st.model;
  const next = { ...((state.config?.api?.modelPrices) || {}) };
  if (!(key in next)) {
    if (result) { result.textContent = `没有找到 ${key} 这条自定义价。`; result.className = 'control-result error'; }
    return;
  }
  delete next[key];
  try {
    const res = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ api: { modelPrices: { __replace__: next } } })
    });
    if (res?.config) state.config = res.config;
    else {
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = next;
    }
    if (result) { result.textContent = `已删除：${key}`; result.className = 'control-result success'; }
    $('#price-dialog')?.close();
    refreshModelPriceCard();
    if (state.tab === 'usage') loadUsageView({ force: true });
  } catch (error) {
    if (result) { result.textContent = `删除失败：${error.message}`; result.className = 'control-result error'; }
  }
}

/**
 * 批量自定义价格编辑：左列选供应商 → 右列该供应商的模型 →
 * 官方表（输入/输出/缓存命中）参考列 + 自定义单价输入列。
 *
 * 曾经的候选列表是"当前模型 + 已自定义 + 用量统计里出现过的" ——
 * 没调用过的模型根本进不了名单，想提前给没用过的新模型定价都做不到。
 * 现在按供应商目录浏览，全量模型都可设定。
 *
 * 两个细节：
 *   1. 编辑暂存在 edits 里（input 事件实时写入），切换供应商不丢未保存的修改
 *   2. 目录之外但已自定义的模型归到虚拟供应商「已自定义（目录外）」，
 *      保证旧条目永远能找到、能清除
 */
function openBatchPriceModal() {
  const cfg = state.config || {};
  const customMap = cfg.api?.modelPrices || {};
  // 编辑暂存：以已保存的自定义价为起点，用户的每一次输入都先落在这里
  const edits = {};
  for (const [k, v] of Object.entries(customMap)) edits[k] = { ...(v || {}) };

  // 左列数据：供应商目录 + 虚拟供应商（目录外已自定义的模型）
  const catalogModels = new Set();
  for (const p of (state.providers || [])) for (const m of (p.models || [])) catalogModels.add(m);
  const orphanCustoms = Object.keys(customMap).filter((k) => !catalogModels.has(k)).sort();
  const lefts = (state.providers || []).map((p) => ({
    id: p.id, name: p.displayName || p.id, models: p.models || [], names: p.modelNames || {}
  }));
  if (orphanCustoms.length) {
    lefts.push({ id: '__custom__', name: `已自定义（目录外 ${orphanCustoms.length}）`, models: orphanCustoms, names: {} });
  }

  if (!lefts.length) {
    modelModalShell({
      head: '批量自定义价格编辑',
      body: '<div class="empty-hint">模型目录为空：请先在「模型 API」页签添加提供商。</div>',
      foot: ''
    });
    return;
  }

  let activePid = lefts[0].id;
  let kw = '';   // 搜索关键词（中转站供应商可能有几百个模型，没搜索没法用）

  const overlay = modelModalShell({
    head: '批量自定义价格编辑',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="bp-search" placeholder="搜索模型…" autocomplete="off" />
        <span class="muted" style="font-size:12px;white-space:nowrap">留空 = 不自定义（走官方表/兜底）</span>
      </div>
      <div class="ma-body dual">
        <div class="model-modal-left" id="bp-left"></div>
        <div class="model-modal-right" id="bp-right"></div>
      </div>
      <div id="bp-hint" class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        输入框占位符与模型名悬停提示均为官方价（元/百万 token）；修改只写入你的配置，不会改动官方价格表。
      </div>`,
    foot: `<button class="btn" id="bp-cancel">取消</button>
           <button class="btn btn-primary" id="bp-save">保存</button>`
  });

  const left = overlay.querySelector('#bp-left');
  const right = overlay.querySelector('#bp-right');
  const hintEl = overlay.querySelector('#bp-hint');

  function renderLeft() {
    left.innerHTML = lefts.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.name)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }

  function rowHtml(p, m) {
    if (kw && !m.toLowerCase().includes(kw) && !String(p.names[m] || '').toLowerCase().includes(kw)) return '';
    const off = matchPriceTable(m, state.modelPrices?.prices || []);
    const c = edits[m] || {};
    // 官方价不占列（太挤）：placeholder 里有，模型名悬停也有
    const offTitle = off ? `官方价：输入 ${off.in} / 输出 ${off.out} / 缓存 ${off.cached ?? '—'}（元/百万）` : '官方价格表未收录';
    // 计费方式在这里看不到就会"静默变味"：包月/本地条目必须自己标出来，
    // 否则用户改一下缓存列，包月就变成了按 token 计价。
    const billBadge = c.billing === 'flat'
      ? `<span class="uc-chip" title="包月/订阅：按固定支出计，不按 token 计价">包月 ${Number(c.amount) || 0}${c.period === 'day' ? '/天' : '/月'}</span>`
      : (c.billing === 'none' ? '<span class="uc-chip" title="本地/自建模型：只统计 token，不计费">本地</span>' : '');
    return `
      <tr data-model="${esc(m)}">
        <td title="${esc(offTitle)}">${esc(p.names[m] || m)}${billBadge}<div class="muted" style="font-size:11px">${esc(m)}</div></td>
        <td><input type="number" step="0.01" min="0" class="bp-in" value="${esc(c.in ?? '')}" placeholder="${off ? off.in : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-out" value="${esc(c.out ?? '')}" placeholder="${off ? off.out : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-cached" value="${esc(c.cached ?? '')}" placeholder="${off ? (off.cached ?? 0) : 0}" /></td>
        <td><button class="bp-del" title="清除该模型的自定义价">清除</button></td>
      </tr>`;
  }

  function renderRight() {
    const p = lefts.find((x) => x.id === activePid);
    const models = p ? p.models : [];
    right.innerHTML = `
      <table class="usage-table">
        <thead><tr>
          <th>模型（悬停看官方价）</th>
          <th>自定义 输入</th><th>自定义 输出</th><th>自定义 缓存命中</th><th></th>
        </tr></thead>
        <tbody id="bp-body">
          ${models.map((m) => rowHtml(p, m)).join('') || '<tr><td colspan="5" class="muted">没有匹配的模型</td></tr>'}
        </tbody>
      </table>`;
    // 输入实时落进 edits：切换供应商/搜索重渲染后不丢未保存的修改
    right.querySelectorAll('#bp-body tr[data-model]').forEach((tr) => {
      const m = tr.dataset.model;
      const sync = () => {
        const num = (sel) => {
          const v = String(tr.querySelector(sel)?.value ?? '').trim();
          return v === '' ? null : (Number(v) || 0);
        };
        const i = num('.bp-in'), o = num('.bp-out'), c = num('.bp-cached');
        if (i === null && o === null && c === null) {
          delete edits[m];
          return;
        }
        // 计费方式不在这张表里编辑：只动缓存列不该把"包月/本地"静默变成按 token 计价。
        // 只有在输入/输出列写了数字（= 明确要按 token 定价）时才转成 token 口径。
        const prev = edits[m] || {};
        const tokenIntent = i !== null || o !== null;
        // 输入/输出空着、只填了缓存命中：这不算"要按 token 定价"。写进去会得到
        // in:0/out:0 的"明确免费价"，把官方价变成 0 元 —— 按"清掉自定义价"处理。
        if (!tokenIntent && !String(prev.billing || '').trim()) { delete edits[m]; return; }
        const next = { ...prev, in: i ?? 0, out: o ?? 0, cached: c ?? (i ?? 0) };
        if (tokenIntent) { delete next.billing; delete next.amount; delete next.period; }
        edits[m] = next;
      };
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', sync));
    });
    right.querySelectorAll('#bp-body .bp-del').forEach((el) => {
      el.addEventListener('click', () => {
        const tr = el.closest('tr[data-model]');
        if (!tr) return;
        delete edits[tr.dataset.model];
        tr.querySelectorAll('input').forEach((i) => { i.value = ''; });
      });
    });
  }

  overlay.querySelector('#bp-search')?.addEventListener('input', (e) => {
    kw = String(e.target.value || '').trim().toLowerCase();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#bp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bp-save').addEventListener('click', async () => {
    // 保存的就是 edits 本身（输入时已实时同步，不用再扫 DOM）
    const next = edits;
    try {
      hintEl.textContent = '保存中…';
      // 用 __replace__ 整体替换：普通深合并传对象是删不掉旧键的，
      // 用户点"清除"某行后保存，旧条目会复活。
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { modelPrices: { __replace__: next } } })
      });
      // 更新本地状态，避免下次打开还是旧值
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = next;
      closeModelModal(overlay);
      refreshModelPriceCard();
      $('#provider-action-hint').textContent = `已保存 ${Object.keys(next).length} 个模型的自定义单价。`;
    } catch (e) {
      hintEl.textContent = `保存失败：${e.message}`;   // textContent 不吃 HTML，esc() 会把实体原样显示出来
    }
  });
}

function findPersonaTemplateId(roleText, behaviorProfile = 'legacy', customRules = '') {
  return Object.entries(state.personaTemplates || {}).find(([, p]) =>
    p.text === roleText && (p.behaviorProfile || 'legacy') === behaviorProfile
      && (p.customRules || '') === customRules)?.[0] || '';
}

function currentPersonaId() {
  return findPersonaTemplateId(
    $('#cfg-roletext')?.value ?? '',
    $('#cfg-behavior-profile')?.value || 'legacy',
    $('#cfg-customrules')?.value ?? ''
  );
}

/** 草稿与生效配置不一致时，卡库/详情头要跟着草稿说，不能只认已保存的那份。 */
function personaDraftState() {
  const cfg = state.config || {};
  return {
    id: currentPersonaId(),
    roleText: $('#cfg-roletext')?.value ?? (cfg.persona?.roleText || ''),
    behaviorProfile: $('#cfg-behavior-profile')?.value || cfg.persona?.behaviorProfile || 'legacy',
    customRules: $('#cfg-customrules')?.value ?? (cfg.persona?.customRules || '')
  };
}

function syncPersonaButtons() {
  const draft = personaDraftState();
  refreshPersonaFold(draft.roleText);
  const tpl = state.personaTemplates[draft.id];
  // 卡库还没读出来时，"匹配不到任何卡"并不等于"正文被改过" —— 下面几处提示都要区分这两种情况
  const templatesKnown = Object.keys(state.personaTemplates || {}).length > 0;
  const delBtn = $('#del-persona-btn');
  if (delBtn) delBtn.classList.toggle('hidden', !String(draft.id).startsWith('custom_'));
  const hint = $('#persona-pick-hint');
  // 正文与内置模板不一致时（升级改了模板而实例里存的是旧正文，或管理员手改过），
  // 选择框会是空的，容易让人以为人设丢了 —— 用提示行说明这是按自定义处理。
  const hasText = String(draft.roleText || '').trim().length > 0;
  if (hint) {
    hint.textContent = tpl
      ? (tpl.builtin ? `内置卡：跟着 roles/ 下的卡文件走，改卡重启即生效。` : `自定义卡「${tpl.name}」。`)
      : (hasText
        ? (templatesKnown ? '当前正文与内置模板不一致（按自定义处理，可在上面的卡库里点一张卡换回来）'
          : (state.personaTemplatesFailed ? '人设卡读取失败，刷新页面重试。' : '正在读取人设卡…'))
        : '');
  }
  // 详情视图：正文、档位、绑定状态都按草稿渲染。
  // 「恢复本节 / 恢复整张卡」按**草稿那张卡**取文件正文（不是 config 里已保存的绑定）——
  // 刚在卡库点了另一张卡、还没保存时，用旧绑定会把两张卡的内容拼在一起。
  const baseTpl = state.personaTemplates[personaBaseCardId()];
  const fileText = baseTpl?.builtin ? baseTpl.text : '';
  // 只有内容真的变了才重画：人设页的输入事件（改名字、改附加规则、改正文）都会走到这里，
  // 每次都重画 15KB 正文 + 5 张卡的话，打字时每敲一键都要多花约 10ms。
  const viewKey = [draft.roleText, personaEditingSection,
    [...personaCollapsedSections].sort((a, b) => a - b).join(','), fileText].join('\u0000');
  const detail = $('#persona-card-view');
  if (detail && viewKey !== personaViewKey) {
    personaViewKey = viewKey;
    detail.innerHTML = renderPersonaCardBody(draft.roleText, {
      collapsed: personaCollapsedSections,
      editing: personaEditingSection,
      fileText
    });
  }
  const restoreBtn = $('#restore-persona-btn');
  if (restoreBtn) {
    const dirty = Boolean(fileText) && String(draft.roleText || '').trim() !== String(fileText).trim();
    restoreBtn.classList.toggle('hidden', !dirty);
  }
  const note = $('#persona-edit-note');
  if (note) {
    // 提示只在"草稿与卡文件不一致"时留着；一旦恢复成卡文件原文就自动消失
    const dirty = Boolean(fileText)
      ? String(draft.roleText || '').trim() !== String(fileText).trim()
      : true;
    note.textContent = dirty ? personaEditNote : '';
  }
  const title = $('#persona-view-title');
  if (title) title.textContent = tpl?.name || (hasText ? (templatesKnown ? '自定义正文' : '角色设定') : '（还没设置角色设定）');
  const profileChip = $('#persona-view-profile');
  if (profileChip) profileChip.textContent = draft.behaviorProfile === 'grounded' ? '自然可靠' : '原版群友';
  const bindChip = $('#persona-view-binding');
  if (bindChip) {
    const boundId = String((state.config?.persona?.templateId) || '');
    bindChip.className = 'chip';
    if (tpl?.builtin) {
      // 只有草稿正文就是这张卡的正文、且实例确实绑着它，才算"正在跟随卡文件"
      bindChip.classList.add(draft.id === boundId ? 'ok' : 'warn');
      bindChip.textContent = draft.id === boundId ? '跟随卡文件' : '保存后跟随卡文件';
    } else if (tpl) {
      bindChip.textContent = '自定义卡';
    } else if (hasText && templatesKnown) {
      bindChip.classList.add('warn');
      bindChip.textContent = '自定义正文 · 与卡文件解绑';
    } else if (hasText) {
      // 卡库还没读出来（或读取失败）时别断言"已解绑"——那时根本不知道有没有对应的卡
      bindChip.textContent = state.personaTemplatesFailed ? '卡库读取失败' : '读取卡库中…';
    } else {
      bindChip.textContent = '';
    }
  }
  const gridKey = [state.personaTemplatesVersion || 0,
    String(state.config?.persona?.templateId || ''),
    state.config?.persona?.roleText || '', state.config?.persona?.behaviorProfile || '',
    state.config?.persona?.customRules || '', draft.roleText, draft.behaviorProfile, draft.customRules].join('\u0000');
  const grid = $('#persona-grid');
  if (grid && gridKey !== personaGridKey) {
    personaGridKey = gridKey;
    grid.innerHTML = renderPersonaGrid(state.config || {}, draft);
  }
  // 折叠按钮的文案要跟着实际状态走（折叠状态是跨分区保留的，不能只靠点击时改文字）
  const expandBtn = $('#persona-expand-btn');
  if (expandBtn) {
    const total = parsePersonaCard(draft.roleText).sections.length;
    expandBtn.textContent = total > 0 && personaCollapsedSections.size >= total ? '全部展开' : '全部收起';
  }
}

function applyPersonaDraft(tpl, id = '') {
  $('#cfg-roletext').value = tpl.text;
  $('#cfg-customrules').value = tpl.customRules || '';
  $('#cfg-behavior-profile').value = tpl.behaviorProfile || 'legacy';
  personaEditingSection = -1;
  personaEditNote = '';
  // 记下"草稿是从哪张卡来的"：没保存之前 config 里还是旧绑定，
  // 「恢复本节 / 恢复整张卡」必须按草稿这张卡来，否则会把两张卡拼在一起。
  personaDraftCardId = id || findPersonaTemplateId(tpl.text, tpl.behaviorProfile || 'legacy', tpl.customRules || '');
  syncPersonaButtons();
}

/**
 * 草稿对应的内置卡 id：正文与某张内置卡完全一致就用那张；否则用用户最近点的那张
 * （点完卡再逐节改，正文就不完全一致了，但"基准卡"还是它）。
 */
function personaBaseCardId() {
  const draft = personaDraftState();
  const exact = findPersonaTemplateId(draft.roleText, draft.behaviorProfile, draft.customRules);
  if (exact && state.personaTemplates[exact]?.builtin) return exact;
  const picked = String(personaDraftCardId || '');
  return picked && state.personaTemplates[picked]?.builtin ? picked : '';
}

/**
 * 把"正在编辑的小节"落回草稿。分节编辑框不是唯一数据源（#cfg-roletext 才是），
 * 所以保存、折叠、恢复这些会重画视图的动作之前都得先冲一次，否则刚打的字会消失。
 * @returns {boolean} 有改动被落回时 true
 */
function flushPersonaSectionEdit() {
  if (personaEditingSection < 0) return false;
  const roleBox = $('#cfg-roletext');
  const box = document.querySelector(`#persona-card-view .pd-edit-text[data-sec="${personaEditingSection}"]`);
  if (!roleBox || !box) return false;
  // 输入框内容与"按渲染规则解析出来的正文"逐字一致 → 这一节根本没改过，别写回。
  // replacePersonaSectionBody 会规范化行尾空白与多余空行：原样写回也会让正文与卡文件不再逐字节相同，
  // 保存时 currentPersonaId() 按整串比较就把它当成"自定义" → 静默解绑内置卡（用户什么都没改）。
  if (box.value === personaSectionBody(roleBox.value, personaEditingSection)) return false;
  const next = replacePersonaSectionBody(roleBox.value, personaEditingSection, box.value);
  if (next === roleBox.value) return false;
  roleBox.value = next;
  return true;
}

// ── 角色正文的结构化渲染 ──
// 卡正文是 markdown，只给一个大 textarea 太糙：这里解析成分节面板 ——
// 「你的标志」渲染成一排标签、「AI 味黑名单」渲染成打叉标签、示例渲染成聊天气泡，
// 让人一眼看出这张卡会让它怎么说话。保存仍然以 #cfg-roletext 的原文为准（视图只读）。
/** 管理员附加规则的常用例子：点一下就填进去，省得对着空白框发呆。 */
const PERSONA_RULE_EXAMPLES = [
  '别装傻、别反问，不想接就安静',
  '说话短一点，一轮最多两条',
  '被怼只淡淡带过，不还嘴',
  '称呼固定用「老板」',
  '不用网络梗和颜文字'
];

let personaCollapsedSections = new Set();
let personaFoldKey = null;
let personaEditingSection = -1;   // 正在按小节编辑的序号；-1 = 没在编辑
let personaEditNote = '';         // 小节编辑后的提示（"还得点保存设置"这类）
let personaViewKey = null;        // 上次画正文视图用的内容指纹（没变就跳过重画）
let personaGridKey = null;        // 同上，卡库
let personaViewTimer = null;      // 正文输入时的合并渲染定时器
let personaDraftCardId = '';      // 草稿是从哪张卡来的（点卡时记下）

/**
 * 默认折叠策略：只展开"你是谁"和"你的标志"，其余小节收起来。
 * 一张卡的正文能有三千多像素，全展开会把下面的名字/参与度/附加规则/保存按钮压到很远，
 * 用起来像"页面滚不动"。想看全的点「全部展开」。
 */
function defaultPersonaFold(roleText) {
  const card = parsePersonaCard(roleText);
  const folded = new Set();
  card.sections.forEach((section, index) => {
    if (!/你是谁|标志|招牌/.test(section.name)) folded.add(index);
  });
  return folded;
}

/**
 * 正文变了就更新折叠基准：换了另一张卡就按默认折叠重算，
 * 只是改了某一节（小节数没变）就保留用户当前展开/收起的状态。
 */
function refreshPersonaFold(roleText) {
  const key = String(roleText || '');
  if (personaFoldKey === key) return;
  const previousKey = personaFoldKey;
  const sameShape = previousKey !== null
    && parsePersonaCard(previousKey).sections.length === parsePersonaCard(key).sections.length;
  personaFoldKey = key;
  if (!sameShape) {
    personaCollapsedSections = defaultPersonaFold(key);
    personaEditingSection = -1;
  }
}

const PERSONA_SECTION_EMOJI = {
  你是谁: '🪪',
  说话方式: '💬',
  偏好: '🍜',
  工具: '🧰',
  分寸: '🧭'
};

/** 行内格式：`code`、**加粗**（先转义再替换，避免注入）。 */
function personaInline(text) {
  return esc(String(text))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * 把角色正文解析成 { title, sections: [{ num, name, blocks, from, to }] }。
 * 只认卡里实际用的写法：一级标题、`## 一、小节`、`>` 引用、`-`/`1.` 列表、正文续行，
 * 以及示例段的 `群友：/你不要：/你可以：/或者：`（同一组群友发言归到一个气泡组里）。
 *
 * from / to 是这一节在原始文本里的行号区间（`from` 是小节标题那一行、`to` 是下一节标题
 * 那一行或文末，左闭右开）—— 按小节编辑时要靠它把改动精确地拼回去。
 */
/**
 * 解析结果按"整段文本"缓存一份：人设页一次同步会解析同一段正文好几次
 * （默认折叠、卡库简介、正文渲染、取单节正文…），3~4KB 的正文每次重解析不划算。
 * 调用方都只读返回值，不要改它。
 */
let personaParseCache = { text: null, card: null };

function parsePersonaCard(text) {
  const source = String(text || '');
  if (personaParseCache.text === source) return personaParseCache.card;
  const card = { title: '', sections: [] };
  let section = null;
  const blocks = () => (section ? section.blocks : (card.intro ||= []));
  const lastBlock = () => blocks()[blocks().length - 1];
  const lines = String(text || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+$/, '');
    if (!line.trim()) continue;
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) { card.title = h1[1].trim(); continue; }
    const h2 = line.match(/^##\s*(?:([一二三四五六七八九十]+|\d+)\s*[、.．]\s*)?(.*)$/);
    if (h2) {
      if (section) section.to = index;
      section = { num: (h2[1] || '').trim(), name: (h2[2] || '').trim(), blocks: [], from: index, to: lines.length };
      card.sections.push(section);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const last = lastBlock();
      if (last?.type === 'quote') last.lines.push(quote[1]);
      else blocks().push({ type: 'quote', lines: [quote[1]] });
      continue;
    }
    const listItem = line.match(/^\s*(?:[-*]|\d+[.．])\s+(.*)$/);
    if (listItem) {
      const last = lastBlock();
      if (last?.type === 'list') last.items.push(listItem[1]);
      else blocks().push({ type: 'list', items: [listItem[1]] });
      continue;
    }
    const turn = line.trim().match(/^(群友|你不要|你可以|或者|但|示例)[：:]\s*(.*)$/);
    if (turn) {
      const role = turn[1] === '群友' ? 'peer' : (turn[1] === '你不要' ? 'bad' : 'ok');
      const last = lastBlock();
      if (role === 'peer' || last?.type !== 'example') {
        blocks().push({ type: 'example', turns: [{ role, text: turn[2] }] });
      } else {
        last.turns.push({ role, text: turn[2] });
      }
      continue;
    }
    // 续行：接到上一段/上一条列表项后面（卡里的换行大多是折行，不是新句）
    const last = lastBlock();
    if (last?.type === 'list' && last.items.length) last.items[last.items.length - 1] += ` ${line.trim()}`;
    else if (last?.type === 'p') last.text += ` ${line.trim()}`;
    else blocks().push({ type: 'p', text: line.trim() });
  }
  personaParseCache = { text: source, card };
  return card;
}

/** 取某一节的正文（不含小节标题那一行）。 */
function personaSectionBody(text, index) {
  const source = String(text || '');
  const section = parsePersonaCard(source).sections[index];
  if (!section) return '';
  return source.split(/\r?\n/).slice(section.from + 1, section.to).join('\n').replace(/^\n+|\n+$/g, '');
}

/**
 * 用 newBody 替换第 index 节的正文，其余部分原样保留（小节标题不动）。
 * "按小节编辑"就落在这里：正文全文仍是唯一数据源，只是改哪节拼哪节。
 * 标题与正文之间的空行、正文与下一节之间的空行，都按原文的样子决定 ——
 * 这样"原样写回"逐字节不变，编辑别的节也不会把整篇格式弄乱。
 */
function replacePersonaSectionBody(text, index, newBody) {
  const source = String(text || '');
  const section = parsePersonaCard(source).sections[index];
  if (!section) return source;
  const lines = source.split(/\r?\n/);
  const blankAfterHeader = lines[section.from + 1] !== undefined && !lines[section.from + 1].trim();
  const blankBeforeNext = section.to < lines.length && !String(lines[section.to - 1] ?? '').trim();
  const body = String(newBody ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  const next = lines.slice(0, section.from + 1);   // 含小节标题那行
  if (body) {
    if (blankAfterHeader) next.push('');
    next.push(...body.split('\n'));
    if (blankBeforeNext) next.push('');
  }
  next.push(...lines.slice(section.to));
  return next.join('\n');
}

function renderPersonaBlock(block, { asTags = '' } = {}) {
  if (block.type === 'quote') {
    return `<div class="pd-quote">${block.lines.map(personaInline).join('<br>')}</div>`;
  }
  if (block.type === 'list') {
    if (asTags) {
      return `<div class="pd-tags">${block.items.map((item) => `<span class="pd-tag ${asTags}">${personaInline(item)}</span>`).join('')}</div>`;
    }
    return `<ul class="pd-list">${block.items.map((item) => `<li>${personaInline(item)}</li>`).join('')}</ul>`;
  }
  if (block.type === 'example') {
    const MARK = { peer: '', bad: '✗', ok: '✓' };
    return `<div class="pd-chat">${block.turns.map((t) => `
      <div class="pd-msg ${t.role}">
        <span class="mark">${MARK[t.role] || ''}</span>
        <span class="bubble">${t.role === 'peer' ? '<span class="who">群友 </span>' : ''}${personaInline(t.text)}</span>
      </div>`).join('')}</div>`;
  }
  if (block.type === 'p') return `<p>${personaInline(block.text)}</p>`;
  return '';
}

const PERSONA_TAG_SECTIONS = /标志|招牌/;
const PERSONA_BAD_SECTIONS = /黑名单|禁止|不要/;

/**
 * 把卡正文渲染成分节视图。
 * @param {object} options
 *   collapsed  收起来的小节序号集合
 *   editing    正在按小节编辑的序号（-1 = 没在编辑）
 *   fileText   这张卡对应的卡文件正文（有值时每节出现「恢复本节」）
 */
function renderPersonaCardBody(text, { collapsed = new Set(), showTitle = true, editing = -1, fileText = '' } = {}) {
  const card = parsePersonaCard(text);
  if (!card.sections.length) {
    return `<div class="pd-empty">这段正文还没分节，点「编辑正文」直接改；想有分节视图就按内置卡的写法用 <code>## 一、小节名</code>。</div>`;
  }
  const fileCard = fileText ? parsePersonaCard(fileText) : null;
  const sections = card.sections.map((sec, i) => {
    const isStar = PERSONA_TAG_SECTIONS.test(sec.name);
    const isBad = PERSONA_BAD_SECTIONS.test(sec.name);
    const emoji = isStar ? '✨' : (isBad ? '🚫' : (PERSONA_SECTION_EMOJI[sec.name.replace(/（.*?）/g, '')] || ''));
    const body = sec.blocks.map((block) => renderPersonaBlock(block, {
      asTags: isStar ? 'star' : (isBad ? 'bad' : '')
    })).join('');
    const chips = [];
    if (isStar) chips.push('<span class="chip star">招牌特征</span>');
    if (/示例/.test(sec.name)) chips.push('<span class="chip">✓ 可用 / ✗ 禁用</span>');
    const isEditing = editing === i;
    // 卡文件里同一节还在、而且写法不同 → 给一个"只把这一节改回卡文件写法"的入口
    const fileBody = fileCard && fileCard.sections[i] && fileCard.sections[i].name === sec.name
      ? personaSectionBody(fileText, i) : null;
    const canRevert = fileBody !== null && fileBody !== personaSectionBody(text, i);
    const actions = `
      <span class="pd-sec-actions">
        ${canRevert ? `<button type="button" class="pd-sec-revert" data-sec="${i}">恢复本节</button>` : ''}
        <button type="button" class="pd-sec-edit" data-sec="${i}">${isEditing ? '正在编辑' : '编辑'}</button>
      </span>`;
    const sectionBody = isEditing
      ? `<div class="pd-edit">
           <textarea class="pd-edit-text" data-sec="${i}" spellcheck="false" placeholder="这一节的正文（markdown）。小节标题不在这里改。">${esc(personaSectionBody(text, i))}</textarea>
           <div class="pd-edit-row">
             <button type="button" class="btn btn-small btn-primary pd-sec-save" data-sec="${i}">保存本节</button>
             <button type="button" class="btn btn-small pd-sec-cancel">取消</button>
             <span class="muted pd-edit-hint">保存只是改草稿；要生效还得点底部那条「保存设置」。</span>
           </div>
         </div>`
      : body;
    return `
      <div class="pd-sec ${collapsed.has(i) && !isEditing ? 'collapsed' : ''} ${isEditing ? 'editing' : ''}" data-sec="${i}">
        <div class="pd-sec-head">
          <span class="idx">${esc(sec.num || String(i + 1))}</span>
          <span class="name">${emoji ? `${emoji} ` : ''}${esc(sec.name)}</span>
          ${chips.join('')}
          ${actions}
          <span class="caret">▾</span>
        </div>
        <div class="pd-sec-body">${sectionBody}</div>
      </div>`;
  }).join('');
  const head = showTitle && card.title
    ? `<div class="pd-headline">${esc(card.title)}</div>`
    : '';
  return `${head}${sections}`;
}

/** 卡库里的一张卡：草稿中的那张会高亮，真正生效且绑着卡文件的那张挂「使用中」。 */
/** 卡库简介（取自「你是谁」第一段）按卡正文缓存 —— 卡库每次重画都要用 5 次。 */
const personaDescCache = new Map();

function personaCardDesc(tpl) {
  const key = `${tpl.name}\u0000${tpl.text.length}\u0000${tpl.text.slice(0, 24)}`;
  if (personaDescCache.has(key)) return personaDescCache.get(key);
  const parsed = parsePersonaCard(tpl.text);
  const sec = parsed.sections.find((s) => s.name.includes('你是谁'));
  const text = sec?.blocks.find((b) => b.type === 'p')?.text || '';
  const desc = text.length > 46 ? `${text.slice(0, 46)}…` : text;
  personaDescCache.set(key, desc);
  return desc;
}

function renderPersonaGrid(c, draft = {}) {
  const draftText = draft.roleText ?? c.persona?.roleText ?? '';
  const draftProfile = draft.behaviorProfile ?? c.persona?.behaviorProfile ?? 'legacy';
  const draftRules = draft.customRules ?? c.persona?.customRules ?? '';
  const draftId = findPersonaTemplateId(draftText, draftProfile, draftRules);
  const savedId = findPersonaTemplateId(
    c.persona?.roleText || '', c.persona?.behaviorProfile || 'legacy', c.persona?.customRules || ''
  );
  const boundId = String(c.persona?.templateId || '');
  const templates = Object.entries(state.personaTemplates || {});
  if (!templates.length) {
    // 区分"卡库还没读出来/读取失败"和"真的一张卡都没有"，别让人以为人设丢了
    return state.personaTemplatesFailed
      ? '<div class="pd-empty">人设卡读取失败，刷新页面重试。</div>'
      : '<div class="pd-empty">正在读取人设卡…</div>';
  }
  return templates.map(([id, tpl]) => {
    const isDraft = id === draftId;
    const isInUse = id === savedId && id === boundId;
    const desc = personaCardDesc(tpl);
    return `
      <div class="persona-card ${isDraft ? 'selected' : ''}" data-persona-id="${esc(id)}" role="button" tabindex="0">
        <div class="pc-top">
          <span class="pc-name">${esc(tpl.name)}</span>
          ${isInUse ? '<span class="chip ok">使用中</span>' : (isDraft ? '<span class="chip">草稿中</span>' : '')}
        </div>
        <div class="pc-meta">
          <span class="pc-tag">${tpl.behaviorProfile === 'grounded' ? '自然可靠' : '原版群友'}</span>
          <span class="pc-src">${tpl.builtin ? '内置 · 跟随卡文件' : '自定义'}</span>
        </div>
        <div class="pc-desc">${esc(desc)}</div>
      </div>`;
  }).join('');
}

/** 人设卡库：点一张卡就把它的正文填进草稿（保存后才生效）。 */
function renderPersonaLibrary(c) {
  return `
    <div class="persona-lib">
      <div class="persona-lib-head">
        <span class="pl-title">人设卡库</span>
        <span class="spacer"></span>
        <button class="btn btn-small" id="persona-expand-btn">全部收起</button>
        <button class="btn btn-small" id="new-persona-btn">＋ 新建自定义卡</button>
        <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义卡</button>
      </div>
      <div class="persona-grid" id="persona-grid">${renderPersonaGrid(c)}</div>
    </div>
    <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;
function bindModelDdDismiss() {
  if (modelDdDismissBound) return;
  modelDdDismissBound = true;
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dd');
    if (!dd || dd.hidden || dd.contains(e.target)) return;
    const btn = document.getElementById('model-pick-btn');
    if (btn && btn.contains(e.target)) return;   // 按钮自己负责开合
    dd.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const dd = document.getElementById('model-dd');
    if (dd && !dd.hidden && e.key === 'Escape') dd.hidden = true;
  });
}

function renderProviderColumn(c) {
  const provs = state.providers || [];
  // 提供商目录为空时给出可直接操作的指引。
  if (!provs.length) {
    return '<div class="muted" style="padding:10px;font-size:12px;line-height:1.7">'
      + '目录还是空的。先在右边「手动添加提供商」填上接口地址和 API Key，'
      + '点「获取列表」拉取模型，或直接手动填模型 id 后点「确认添加」。'
      + '不知道去哪弄？DeepSeek、智谱、Kimi、OpenAI 等官网的开放平台都能申请到 Key。'
      + '</div>';
  }
  let html = '<div class="mdd-prov" data-pid="__manual__"><span class="mdd-prov-name">（手动输入模型名）</span></div>';
  for (const p of provs) {
    const warn = [!p.hasKey ? '⚠无密钥' : '', p.needsBaseUrl ? '⚠需补地址' : ''].filter(Boolean).join(' ');
    const visionOk = (p.models || []).filter((m) => visionVerdictOf(p.id, m) === 'vision').length;
    const meta = warn || `${p.models.length} 模型${visionOk ? ` · ${visionOk} 可看图` : ' · 0 可看图'}`;
    html += `<div class="mdd-prov" data-pid="${esc(p.id)}">
      <span class="mdd-prov-name">${esc(p.displayName || p.id)}</span>
      <span class="mdd-prov-meta">${esc(meta)}</span>
    </div>`;
  }
  return html;
}

function renderModelColumn(pid, c) {
  if (pid === '__manual__') {
    return '<div class="muted" style="padding:12px;font-size:12px">选此项后直接在下方"模型"输入框填任意模型名，并手动填 Base URL / Key。</div>';
  }
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) return '';
  const current = `${c.api.provider || ''}|||${c.api.model || ''}`;
  return `<div class="mp-provider"><span>${esc(p.displayName || p.id)}${p.anthropicOrigin ? ' · Anthropic 协议' : ''}</span><span class="mp-url">${esc(p.baseURL || '无端点')}</span></div>
    ${p.models.map((m) => {
      const v = `${p.id}|||${m}`;
      return `<div class="mp-row${v === current ? ' current' : ''}" data-v="${esc(v)}"><span class="mp-name">${esc(m)}</span>${visionBadge(p.id, m)}</div>`;
    }).join('')}`;
}

function applyProviderPick(value, { silent = false } = {}) {
  const hint = $('#provider-hint');
  const store = $('#cfg-provider');
  if (!value || value === '__manual__') {
    store.value = '';
    if (!silent) hint.textContent = '手动模式：直接在下面填 Base URL / Key / 模型名。';
    return;
  }
  const [pid, model] = value.split('|||');
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) { hint.textContent = '未找到该提供商，请重新添加。'; return; }
  store.value = pid;
  $('#cfg-model').value = model;
  // 价格卡片直接读界面控件的值，这里只需要通知它刷新
  refreshModelPriceCard();
  const notes = [];
  if (p.baseURL) {
    $('#cfg-baseurl').value = p.baseURL;
    notes.push(`端点 ${p.baseURL}`);
  } else {
    notes.push('⚠ 该提供商地址未知，请手动填 Base URL');
  }
  if (p.hasKey) {
    $('#cfg-apikey').value = '******';
    $('#cfg-apikey').type = 'password';
    const toggleBtn = $('#cfg-apikey-toggle');
    if (toggleBtn) toggleBtn.textContent = '显示';
    notes.push('该提供商已保存密钥（显示为 ******，点「显示」查看明文，输入新 Key 可替换）');
  } else {
    $('#cfg-apikey').value = '';
    $('#cfg-apikey').type = 'password';
    const toggleBtn = $('#cfg-apikey-toggle');
    if (toggleBtn) toggleBtn.textContent = '显示';
    notes.push('⚠ 该提供商没有可用密钥，请手动粘贴 API Key');
  }
  const vr = (state.visionResults || {})[`${pid}|||${model}`];
  if (vr && (vr.verdict === 'vision' || vr.verdict === 'no-vision')) {
    notes.push(vr.verdict === 'vision' ? '✅ 该模型支持图片输入' : '🚫 该模型不支持图片输入');
  }
  hint.textContent = `已选 ${p.displayName || p.id} · ${model}：${notes.join('；')}`;
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['api', '模型 API'],
    ['search', '搜索服务'],
    ['memory', '记忆'],
    ['experiments', '实验功能'],
    ['moments', '每日动态'],
    ['qzone-interactions', '动态互动'],
    ['time-control', '时间控制'],
    ['token-saver', '省 Token'],
    ['persona', '人设'],
    ['allow', '聊天白名单'],
    ['chat', '聊天设置'],
    ['desktop', '系统'],
    ['onebot', 'OneBot']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row" ${s?.onebot?.connected ? '' : `title="${esc(onebotIssueText(s?.onebot) || '正在等待首次连接')}"`}><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${esc(s.orchestrator.model)}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}</button>`).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    memory: () => renderMemorySettingsSection(c),
    experiments: () => renderExperimentalSettingsSection(c),
    moments: () => renderDailyMomentsSection(c),
    'qzone-interactions': () => renderQzoneInteractionSection(c),
    'time-control': () => renderTimeControlSection(c),
    'token-saver': () => renderTokenSaverSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  // 保存条放在内容**末尾**并 sticky 贴底：长页面（人设页能滚好几屏）里从顶部就能看到它，
  // 一直悬在视口底部，滚到底时正好落在内容末尾。以前它渲染在最前面，既不悬浮又容易
  // 和分区里自己的保存按钮撞车（人设页就多过一个"保存人设修改"，其实调的是同一个保存）。
  return `
    ${render()}
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>`;
}

function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field"><label>模型目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
        <span id="provider-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    </div>
    <div class="field-row">
      <div class="field"><label>当前 Base URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-baseurl" readonly value="${esc(c.api.baseUrl)}" style="flex:1" />
          <button class="btn btn-small" id="fetch-current-models-btn">获取列表</button>
        </div></div>
      <div class="field"><label>当前 API Key</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-apikey" value="${esc((currentProvider?.hasKey || c.api.apiKey) ? '******' : '')}" placeholder="输入新 Key 可替换；留空保存则保持原 Key" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-apikey-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
      <div class="field"><label>单次运行累计 Token 上限</label><input type="number" id="cfg-max-run-tokens" min="20000" max="1000000" step="10000" value="${esc(c.api.maxRunTokens ?? 160000)}" /></div>
      <div class="field"><label>模型上下文窗口（Token）</label><input type="number" id="cfg-context-window-tokens" min="16000" max="2000000" step="10000" value="${esc(c.api.contextWindowTokens ?? 1000000)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
      <label for="cfg-vision">图片输入（关闭则移除看图工具，模型只会看到 [图片] 占位符）</label>
      <span id="vision-switch-hint" class="muted" style="font-size:12px;align-self:center"></span></div>
    <div class="settings-divider"></div>

    <h3>成本怎么算</h3>
    <div class="hint" style="margin-bottom:8px">选一个就行，不用逐个模型配。默认第一项。</div>
    <div id="cost-mode-block">
      <label class="radio-row"><input type="radio" name="cost-mode" value="official"
        ${(!c.api.costMode || c.api.costMode === 'official') ? 'checked' : ''} />
        <span>按模型官方价估（数字是估算，不是你的账单）</span></label>
      <label class="radio-row"><input type="radio" name="cost-mode" value="multiplier"
        ${c.api.costMode === 'multiplier' ? 'checked' : ''} />
        <span>我按渠道价：官方价 ×
          <input type="number" id="cfg-cost-multiplier" step="0.01" min="0" value="${esc(c.api.costMultiplier ?? 1)}" style="width:80px" />
          （例如 0.5 = 打五折；中转站常用；填 0 = 这个渠道不花钱）</span></label>
      <label class="radio-row"><input type="radio" name="cost-mode" value="subscription"
        ${c.api.costMode === 'subscription' ? 'checked' : ''} />
        <span>我按月付 ¥
          <input type="number" id="cfg-cost-monthly" step="1" min="0" value="${esc(c.api.costMonthlyFee ?? 0)}" style="width:90px" />
          /月（订阅套餐、本地自建；不按 token 算）</span></label>
      <label class="checkbox-row" style="margin-top:6px"><input type="checkbox" id="cfg-fallback-current"
        ${c.api.fallbackToCurrentModel !== false ? 'checked' : ''} />
        <label for="cfg-fallback-current">没有价格的模型按「当前模型」的价估算（推荐：避免出现"未定价"）</label></label>
      <div class="hint" id="cost-mode-status" style="margin-top:4px"></div>
    </div>

    <details class="collapsible settings-advanced" id="price-advanced">
      <summary>高级：逐模型定价 / 渠道价目表 / 远程价格表</summary>
      <div class="checkbox-row" style="margin-top:8px"><input type="checkbox" id="cfg-useofficialprice" ${c.api.useOfficialPrice !== false ? 'checked' : ''} />
        <label for="cfg-useofficialprice">用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）</label></div>

      <div class="field" style="margin-top:6px"><label>远程价格表 URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-price-remote-url" placeholder="留空 = 项目默认价格表；none = 关闭" value="${esc(c.api.priceRemoteUrl || '')}" style="flex:1" />
          <button class="btn btn-small" id="price-feed-refresh-btn" title="不等定时，立即拉一次">立即拉取</button>
        </div>
        <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
      </div>

      <!-- 从渠道自动拉价（探测）：把中转站/自建渠道公布的价格拉下来，写成"渠道价" -->
      <div class="settings-divider"></div>
      <h3>从渠道自动拉价</h3>
    <div class="field">
      <label>渠道地址（默认用上面的 Base URL；one-api / new-api 站会读它的 /api/pricing 倍率）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="probe-url" placeholder="https://api.example.com/provider/v1"
          value="${esc(c.api.baseUrl || '')}" style="flex:1" />
        <button class="btn btn-small" id="probe-btn">探测</button>
      </div>
      <div class="hint" id="probe-status" style="margin-top:4px">探测只做预览，不会改动任何配置；确认后才写成"渠道价"。</div>
      <div id="probe-result" class="hidden" style="margin-top:8px"></div>
    </div>

    <!-- 渠道价目表：每个渠道一份，自动拉取（配置里的 channelPriceFeeds） -->
    <div class="field" style="margin-top:10px"><label>渠道价目表（每个渠道一份，启动时自动刷新）</label>
      <div id="channel-feeds"></div>
      <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
        <input type="text" id="channel-feed-vendor" placeholder="渠道名（留空用当前渠道）" style="flex:1;min-width:160px" />
        <input type="text" id="channel-feed-url" placeholder="价目表 URL（http(s)://…/pricing.json）" style="flex:2;min-width:200px" />
        <button class="btn btn-small" id="channel-feed-add">添加并拉取</button>
      </div>
      <div class="hint" id="channel-feed-hint" style="margin-top:4px">拉到的价只在该渠道的调用上生效；手填的价仍然优先。</div>
    </div>

    <!-- 当前模型的价格卡片：切换模型时内容跟着变 -->
    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">生效价</span>
          <span class="pc-effective" id="pc-effective">—</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
      <div class="pc-subhead">自填单价（元/百万 token）</div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-input-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="pc-price-btn">给这个模型定价</button>
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px;align-self:center">填你的渠道实付价（覆盖官方价）；也可为多个模型分别设定</span>
    </div>
    </details>

    <div class="settings-divider"></div>

    <h3>手动添加提供商</h3>
    <div class="field"><label>Base URL（可填写）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-baseurl" placeholder="例如 https://api.deepseek.com/v1 或 https://open.bigmodel.cn/api/paas/v4" value="${esc(currentProvider?.baseURL || c.api.baseUrl || '')}" style="flex:1" />
        <button class="btn btn-small" id="fetch-models-btn">获取列表</button>
      </div></div>
    <div class="field"><label>API Key（手动添加时填写）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="new-apikey" placeholder="sk-..." autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="new-apikey-toggle" type="button">显示</button>
      </div></div>
    <div class="field"><label>模型 id（两列：左侧模型 ID，右侧模型目录中显示的名字；可添加多行）</label>
      <div id="model-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
      </div>
      <div class="hint">「获取列表」会从上面的 Base URL 拉取模型，并在弹窗里勾选加入列表。</div></div>
    <div class="field-row">
      <div class="field"><button class="btn btn-primary" id="confirm-add-provider-btn">确认添加</button></div>
      <div class="field"><button class="btn btn-danger" id="delete-model-btn">删除模型…</button></div>
    </div>
    <div class="hint" id="provider-action-hint"></div>`;
}


function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        <option value="doubao" ${prov === 'doubao' ? 'selected' : ''}>豆包搜索（火山 Agent Plan）</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-chat')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="doubao-search-fields" style="${prov === 'doubao' ? '' : 'display:none'}">
      <label>豆包搜索 API Key（火山 Agent Plan 搜索服务 Key / 环境变量 DOUBAO_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-doubao-key" value="${esc(c.webSearch?.doubao?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-doubao-key-toggle" type="button">显示</button>
      </div></div>

    <h3>添加自定义搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>名称（自己辨认用）</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>接口地址 / 搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''}">
      <div class="field"><label>记忆整理模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div>
    <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
    <div class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</div>`;
}

function renderExperimentalSettingsSection(c) {
  const enabled = c.identityPilot?.enabled === true;
  const friend = c.identityPilot?.friendProposal || {};
  const incoming = c.identityPilot?.incomingFriendRequest || {};
  const slang = c.slangPilot || {};
  const incident = c.incidentPilot || {};
  const autoFriendEnabled = enabled
    && friend.enabled === true
    && incoming.enabled === true;
  return `
    <section class="experimental-settings">
      <h3 id="settings-experiments">实验功能</h3>
      <div class="hint">这里只控制实验功能是否运行，以及是否固化为正式入口。固化后，详细设置和业务数据在独立页面维护。</div>
      <div class="control-key-list" style="margin-top:14px">
        <div class="control-key-row">
          <span><strong>人物统一印象</strong><small id="experiment-identity-state">${enabled ? '已启用' : '已停用'} · ${c.identityPilot?.graduated === true ? '已固化' : '实验中'}</small></span>
          <span class="settings-actions" style="margin:0">
            <label class="checkbox-row" style="margin:0"><input type="checkbox" id="cfg-identity-pilot-enabled" ${enabled ? 'checked' : ''} /><span>启用</span></label>
            <button type="button" class="btn btn-small ${c.identityPilot?.graduated === true ? '' : 'btn-primary'}"
              id="launch-identity-feature" ${c.identityPilot?.graduated === true ? 'disabled' : ''}>
              ${c.identityPilot?.graduated === true ? '已固化' : '固化上线'}
            </button>
          </span>
        </div>
        <div class="control-key-row">
          <span><strong>自动好友添加</strong><small id="experiment-auto-friend-state">已退役（Issue #10：协议端不支持且易触发风控）</small></span>
          <span class="settings-actions" style="margin:0">
            <label class="checkbox-row" style="margin:0"><input type="checkbox" id="cfg-auto-friend-enabled" disabled /><span>启用</span></label>
            <button type="button" class="btn btn-small" id="launch-auto-friend-feature" disabled>已退役</button>
          </span>
        </div>
        <div class="control-key-row">
          <span><strong>黑话语料库</strong><small id="slang-pilot-state">${slang.enabled === true ? '已启用' : '已停用'} · ${slang.graduated === true ? '已固化' : '实验中'}</small></span>
          <span class="settings-actions" style="margin:0">
            <label class="checkbox-row" style="margin:0"><input type="checkbox" id="cfg-slang-pilot-enabled" ${slang.enabled === true ? 'checked' : ''} /><span>启用</span></label>
            <button type="button" class="btn btn-small ${slang.graduated === true ? '' : 'btn-primary'}"
              id="launch-slang-feature" ${slang.graduated === true ? 'disabled' : ''}>
              ${slang.graduated === true ? '已固化' : '固化上线'}
            </button>
          </span>
        </div>
        <div class="control-key-row">
          <span><strong>异常处理基础设施</strong><small id="incident-pilot-state">${incident.enabled === true ? '已启用' : '已停用'} · ${incident.graduated === true ? '已固化' : '实验中'}</small></span>
          <span class="settings-actions" style="margin:0">
            <label class="checkbox-row" style="margin:0"><input type="checkbox" id="cfg-incident-pilot-enabled" ${incident.enabled === true ? 'checked' : ''} /><span>启用</span></label>
            <button type="button" class="btn btn-small ${incident.graduated === true ? '' : 'btn-primary'}"
              id="launch-incident-feature" ${incident.graduated === true ? 'disabled' : ''}>
              ${incident.graduated === true ? '已固化' : '固化上线'}
            </button>
          </span>
        </div>
      </div>
      <div class="hint" id="experiment-launch-result"></div>
    </section>`;
}

function identityPilotSettingsPatch(
  c,
  enabled,
  friendProposal = null,
  incomingFriendRequest = null
) {
  return {
    ...(c.identityPilot || {}),
    enabled: enabled === true,
    incomingFriendRequest: {
      ...(c.identityPilot?.incomingFriendRequest || {}),
      ...(incomingFriendRequest || {})
    },
    friendProposal: {
      ...(c.identityPilot?.friendProposal || {}),
      ...(friendProposal || {})
    }
  };
}

function experimentalFeatureLaunchPatch(c, feature, ownerUin = '') {
  const current = c.identityPilot || {};
  if (feature === 'identity') {
    return {
      identityPilot: {
        ...current,
        enabled: true,
        graduated: true
      }
    };
  }
  if (feature === 'auto-friend') {
    return {
      identityPilot: {
        ...current,
        enabled: true,
        incomingFriendRequest: {
          ...(current.incomingFriendRequest || {}),
          enabled: true,
          autoWhitelist: true
        },
        friendProposal: {
          ...(current.friendProposal || {}),
          enabled: true,
          graduated: true,
          activeDispatchEnabled: true,
          ownerUin: String(ownerUin || current.friendProposal?.ownerUin || '').trim()
        }
      }
    };
  }
  if (feature === 'slang') {
    return {
      slangPilot: {
        ...(c.slangPilot || {}),
        enabled: true,
        graduated: true,
        ownerUin: String(
          ownerUin
          || c.slangPilot?.ownerUin
          || c.identityPilot?.friendProposal?.ownerUin
          || ''
        ).trim()
      }
    };
  }
  if (feature === 'incidents') {
    return {
      incidentPilot: {
        ...(c.incidentPilot || {}),
        enabled: true,
        graduated: true,
        ownerUin: String(
          ownerUin
          || c.incidentPilot?.ownerUin
          || c.identityPilot?.friendProposal?.ownerUin
          || c.slangPilot?.ownerUin
          || ''
        ).trim()
      }
    };
  }
  throw new Error(`未知实验功能：${feature}`);
}

function requestExperimentOwnerUin(feature, current = '') {
  return new Promise((resolve) => {
    const allow = (state.config?.allow?.private || []).map(String);
    const overlay = modelModalShell({
      head: feature === 'auto-friend'
        ? '配置好友审批管理员'
        : feature === 'incidents'
          ? '配置异常告警管理员'
          : '配置黑话审批管理员',
      body: `
        <div class="field">
          <label>管理员 QQ</label>
          <input type="text" id="experiment-owner-uin" inputmode="numeric"
            list="experiment-owner-options" value="${esc(current)}" />
          <datalist id="experiment-owner-options">
            ${allow.map((uin) => `<option value="${esc(uin)}"></option>`).join('')}
          </datalist>
        </div>
        <div class="hint" id="experiment-owner-error">管理员必须在私聊白名单中。</div>`,
      foot: '<button type="button" class="btn" data-owner-cancel>取消</button>'
        + '<button type="button" class="btn btn-primary" data-owner-confirm>继续上线</button>'
    });
    const finish = (value) => {
      closeModelModal(overlay);
      resolve(value);
    };
    overlay.querySelector('[data-owner-cancel]').addEventListener('click', () => finish(''));
    overlay.querySelector('.model-modal-close').addEventListener('click', () => finish(''));
    overlay.querySelector('[data-owner-confirm]').addEventListener('click', () => {
      const value = overlay.querySelector('#experiment-owner-uin').value.trim();
      const allowed = state.config?.allowAllWhenEmpty === true || allow.includes(value);
      if (!/^\d{5,15}$/.test(value) || !allowed) {
        overlay.querySelector('#experiment-owner-error').textContent =
          '请输入私聊白名单中的有效 QQ 号。';
        return;
      }
      finish(value);
    });
  });
}

async function launchExperimentalFeature(feature) {
  const button = feature === 'identity'
    ? $('#launch-identity-feature')
    : feature === 'auto-friend'
      ? $('#launch-auto-friend-feature')
      : feature === 'incidents'
        ? $('#launch-incident-feature')
        : $('#launch-slang-feature');
  const result = $('#experiment-launch-result');
  let ownerUin = feature === 'slang'
    ? state.config?.slangPilot?.ownerUin
      || state.config?.identityPilot?.friendProposal?.ownerUin
      || ''
    : feature === 'incidents'
      ? state.config?.incidentPilot?.ownerUin
        || state.config?.identityPilot?.friendProposal?.ownerUin
        || state.config?.slangPilot?.ownerUin
        || ''
      : state.config?.identityPilot?.friendProposal?.ownerUin || '';
  const ownerAllowed = state.config?.allowAllWhenEmpty === true
    || (state.config?.allow?.private || []).map(String).includes(String(ownerUin));
  if (
    ['auto-friend', 'slang', 'incidents'].includes(feature)
    && (!/^\d{5,15}$/.test(ownerUin) || !ownerAllowed)
  ) {
    ownerUin = await requestExperimentOwnerUin(feature, ownerUin);
    if (!ownerUin) return;
  }
  const message = feature === 'identity'
    ? '固化上线人物统一印象？上线后会按 QQ 号聚合白名单会话中的身份和既有印象，并显示独立页面。'
    : feature === 'auto-friend'
      ? '固化上线自动好友添加？Agent 可提交好友候选，管理员批准后会立即发送申请；收到的好友申请仍需管理员审批。发送结果未知时不会自动重试。'
      : feature === 'incidents'
        ? '固化上线异常处理基础设施？上线后会记录异常、向管理员告警，并允许逐群控制自动、阻塞或继续。结果未知的旧写入不会自动重试。'
        : '固化上线黑话语料库？上线后会启用本地发现和审批流程，并显示独立页面。';
  if (!await askForConfirmation(message)) return;
  if (button) button.disabled = true;
  if (result) result.textContent = '正在上线…';
  try {
    const response = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(experimentalFeatureLaunchPatch(state.config, feature, ownerUin))
    });
    state.config = response.config;
    syncGraduatedFeatureNavigation(state.config);
    renderSettings();
    const currentResult = $('#experiment-launch-result');
    if (currentResult) {
      currentResult.textContent = feature === 'identity'
        ? '人物统一印象已固化上线'
        : feature === 'auto-friend'
          ? '自动好友添加已固化上线'
          : feature === 'incidents'
            ? '异常处理基础设施已固化上线'
            : '黑话语料库已固化上线';
    }
    refreshStatus();
  } catch (error) {
    if (button) button.disabled = false;
    if (result) result.textContent = `上线失败：${error.message}`;
    throw error;
  }
}

async function loadExperimentalFeatureStatuses() {
  const identityNode = $('#experiment-identity-state');
  const friendNode = $('#experiment-auto-friend-state');
  const slangNode = $('#slang-pilot-state');
  const incidentNode = $('#incident-pilot-state');
  const [identityResult, slangResult, incidentResult] = await Promise.allSettled([
      api('/api/identity-pilot/status'),
      api('/api/slang-pilot/status'),
      api('/api/incident-pilot/status')
  ]);
  if (identityResult.status === 'fulfilled') {
    const identity = identityResult.value;
    if (identityNode) {
      identityNode.textContent = `${identity.active ? '运行中' : identity.enabled ? '启动失败' : '已停用'} · ${state.config?.identityPilot?.graduated === true ? '已固化' : '实验中'}`;
    }
    if (friendNode) {
      const active = identity.active
        && identity.friendProposal?.enabled === true
        && identity.incomingFriendRequest?.enabled === true;
      friendNode.textContent = `${active ? '运行中' : '已停用'} · ${state.config?.identityPilot?.friendProposal?.graduated === true ? '已固化' : '实验中'}`;
    }
  } else {
    for (const node of [identityNode, friendNode]) {
      if (node) node.textContent = `状态读取失败：${identityResult.reason?.message || identityResult.reason}`;
    }
  }
  if (slangNode && slangResult.status === 'fulfilled') {
    const slang = slangResult.value;
    slangNode.textContent = `${slang.active ? '运行中' : slang.enabled ? '启动失败' : '已停用'} · ${state.config?.slangPilot?.graduated === true ? '已固化' : '实验中'}`;
  } else if (slangNode) {
    slangNode.textContent = `状态读取失败：${slangResult.reason?.message || slangResult.reason}`;
  }
  if (incidentNode && incidentResult.status === 'fulfilled') {
    const incident = incidentResult.value;
    incidentNode.textContent =
      `${incident.active ? '运行中' : incident.enabled ? '启动失败' : '已停用'} · `
      + `${state.config?.incidentPilot?.graduated === true ? '已固化' : '实验中'}`;
  } else if (incidentNode) {
    incidentNode.textContent =
      `状态读取失败：${incidentResult.reason?.message || incidentResult.reason}`;
  }
}

const FRIEND_PROPOSAL_STATUS = {
  pending: '待审批',
  approved_manual: '已批准 · 待手动执行',
  dispatching: '发送中',
  sent: '已提交申请',
  held_unknown: '发送结果未知',
  failed: '发送失败',
  accepted: '已成为好友',
  rejected: '已拒绝'
};

const FRIEND_PROPOSAL_REASON = {
  interest: '感兴趣',
  frequent: '互动频繁',
  banter: '想继续互怼'
};

const FRIEND_OPPORTUNITY_STATUS = {
  lottery_miss: '抽签未命中',
  review_budget: '评估预算已满',
  queued: '等待评估',
  reviewing: '评估中',
  skipped: '模型跳过',
  proposed: '已生成候选',
  review_failed: '评估失败',
  cancelled: '已取消',
  expired: '队列过期',
  interrupted: '重启中断'
};

const INCOMING_FRIEND_STATUS = {
  pending: '待审批',
  deciding: '处理中',
  approved: '已同意 · 等待好友事件',
  held_unknown: '处理结果未知',
  failed: '处理失败',
  accepted: '已成为好友',
  rejected: '已拒绝'
};

async function decideIncomingFriendRequest(id, decision) {
  const action = decision === 'approve' ? '同意' : '拒绝';
  if (!await askForConfirmation(`${action}这条好友请求？结果未知时系统不会自动重试。`)) return;
  const result = await api(
    `/api/identity-pilot/incoming-friend-requests/${encodeURIComponent(id)}/decision`,
    {
      method: 'POST',
      body: JSON.stringify({ decision })
    }
  );
  await loadFriendFeaturePage();
  const status = $('#friend-feature-state');
  if (status) status.textContent = result.note;
}

async function loadIncomingFriendRequests(status) {
  const box = $('#identity-incoming-friend-requests');
  if (!box) return;
  const feature = status?.incomingFriendRequest || {};
  // 总开关开着、但统一身份库没起来（active=false，比如启动时出错）时，下面这个接口是 409：
  // 直接给提示，别让请求失败把整页（连同设置表单）换成一整块错误信息。
  if (status?.active === false) {
    box.innerHTML = '<div class="empty-hint">统一身份库没有启动：先看页面上提示的启动错误</div>';
    return;
  }
  if (!feature.enabled) {
    box.innerHTML = '<div class="empty-hint">入站好友请求审批当前关闭</div>';
    return;
  }
  let data;
  try {
    data = await api('/api/identity-pilot/incoming-friend-requests?limit=100');
  } catch (error) {
    // 外层是 Promise.allSettled，不再替它兜错：失败要显示在这个框里，
    // 否则页面看起来像"没有好友请求"，而不是"读不到"
    box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    return;
  }
  const requests = data.requests || [];
  if (!requests.length) {
    box.innerHTML = '<div class="empty-hint">当前没有收到好友请求</div>';
    return;
  }
  box.innerHTML = `<table class="identity-pilot-table">
    <thead><tr><th>申请人</th><th>验证消息</th><th>状态</th><th>白名单</th><th>时间</th><th>操作</th></tr></thead>
    <tbody>${requests.map((request) => `<tr>
      <td><strong>${esc(request.primaryName || request.userId)}</strong><small><code>${esc(request.userId)}</code></small></td>
      <td>${esc(request.comment || '（无）')}</td>
      <td>${esc(INCOMING_FRIEND_STATUS[request.status] || request.status)}${request.actionError ? `<small>${esc(request.actionError)}</small>` : ''}</td>
      <td>${request.whitelistApplied ? '已加入' : request.whitelistError ? `<span title="${esc(request.whitelistError)}">失败</span>` : '-'}</td>
      <td>${esc(fmtTime(request.createdAt))}</td>
      <td>${request.status === 'pending'
        ? `<button type="button" class="btn btn-small incoming-friend-decision" data-id="${esc(request.id)}" data-decision="approve">同意</button>
           <button type="button" class="btn btn-small btn-danger incoming-friend-decision" data-id="${esc(request.id)}" data-decision="reject">拒绝</button>`
        : '-'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  box.querySelectorAll('.incoming-friend-decision').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await decideIncomingFriendRequest(button.dataset.id, button.dataset.decision);
      } catch (error) {
        const node = $('#friend-feature-state');
        if (node) node.textContent = `审批失败：${error.message}`;
        button.disabled = false;
      }
    });
  });
}

async function decideFriendProposal(id, decision) {
  const activeDispatch = state.config?.identityPilot?.friendProposal?.activeDispatchEnabled === true;
  const confirmText = activeDispatch
    ? '批准这个好友候选并立即调用 SnowLuma 发送申请？发送结果未知时系统不会自动重试。'
    : '批准这个好友候选？主动发送实验开关未开启，批准后仍需在 QQ 客户端手动添加。';
  if (decision === 'approve' && !await askForConfirmation(confirmText)) {
    return;
  }
  const result = await api(`/api/identity-pilot/friend-proposals/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision })
  });
  await loadFriendFeaturePage();
  const status = $('#friend-feature-state');
  if (status) status.textContent = result.note;
}

async function loadFriendProposals(status) {
  const box = $('#identity-friend-proposals');
  const protocol = $('#identity-friend-protocol');
  if (!box) return;
  const feature = status?.friendProposal || {};
  if (protocol) {
    protocol.textContent = feature.activeDispatchEnabled
      ? `${feature.protocolNote || '主动发送实验协议已开启。'} 仅明确成功才标记已提交；结果未知时禁止自动重试。`
      : '主动发送实验开关已关闭；管理员批准后保留为待手动执行。';
  }
  if (!feature.enabled) {
    box.innerHTML = '<div class="empty-hint">主动好友候选当前关闭</div>';
    return;
  }
  // 同 loadIncomingFriendRequests：身份库没起来时下面两个接口都是 409
  if (status?.active === false) {
    box.innerHTML = '<div class="empty-hint">统一身份库没有启动：先看页面上提示的启动错误</div>';
    return;
  }
  let data;
  try {
    data = await api('/api/identity-pilot/friend-proposals?limit=100');
  } catch (error) {
    box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    return;
  }
  const proposals = data.proposals || [];
  if (!proposals.length) {
    box.innerHTML = '<div class="empty-hint">当前没有好友候选</div>';
    return;
  }
  box.innerHTML = `<table class="identity-pilot-table">
    <thead><tr><th>对象</th><th>理由</th><th>来源</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
    <tbody>${proposals.map((proposal) => `<tr>
      <td><strong>${esc(proposal.primaryName || proposal.userId)}</strong><small><code>${esc(proposal.userId)}</code></small></td>
      <td><strong>${esc(FRIEND_PROPOSAL_REASON[proposal.reasonCode] || proposal.reasonCode)}</strong><small>${esc(proposal.reason)}</small>${proposal.verificationMessage ? `<small>验证：${esc(proposal.verificationMessage)}</small>` : ''}</td>
      <td><code>${esc(proposal.sourceChatKey)}</code></td>
      <td>${esc(FRIEND_PROPOSAL_STATUS[proposal.status] || proposal.status)}${proposal.dispatchError ? `<small>${esc(proposal.dispatchError)}</small>` : ''}</td>
      <td>${esc(fmtTime(proposal.createdAt))}</td>
      <td>${proposal.status === 'pending'
        ? `<button type="button" class="btn btn-small proposal-decision" data-id="${esc(proposal.id)}" data-decision="approve">批准</button>
           <button type="button" class="btn btn-small proposal-decision" data-id="${esc(proposal.id)}" data-decision="reject">拒绝</button>`
        : '-'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  box.querySelectorAll('.proposal-decision').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await decideFriendProposal(button.dataset.id, button.dataset.decision);
      } catch (error) {
        const node = $('#friend-feature-state');
        if (node) node.textContent = `审批失败：${error.message}`;
        button.disabled = false;
      }
    });
  });
}

async function loadFriendOpportunities(status) {
  const box = $('#identity-friend-opportunities');
  if (!box) return;
  const feature = status?.friendProposal || {};
  if (!feature.enabled || feature.mode !== 'triggered') {
    box.innerHTML = '<div class="empty-hint">当前使用提示词提名模式，没有消息触发记录</div>';
    return;
  }
  // 同 loadIncomingFriendRequests：身份库没起来时下面这个接口是 409
  if (status?.active === false) {
    box.innerHTML = '<div class="empty-hint">统一身份库没有启动：先看页面上提示的启动错误</div>';
    return;
  }
  let data;
  try {
    data = await api('/api/identity-pilot/friend-opportunities?limit=100');
  } catch (error) {
    box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    return;
  }
  const opportunities = data.opportunities || [];
  if (!opportunities.length) {
    box.innerHTML = '<div class="empty-hint">尚无抽签或评估记录</div>';
    return;
  }
  box.innerHTML = `<table class="identity-pilot-table">
    <thead><tr><th>对象</th><th>结果</th><th>门槛快照</th><th>抽签</th><th>评分</th><th>时间</th></tr></thead>
    <tbody>${opportunities.map((item) => {
      const eligibility = item.eligibility || {};
      const review = item.review || {};
      return `<tr>
        <td><strong>${esc(item.primaryName || item.userId)}</strong><small><code>${esc(item.userId)}</code> · <code>${esc(item.sourceChatKey)}</code></small></td>
        <td>${esc(FRIEND_OPPORTUNITY_STATUS[item.status] || item.status)}${item.reason ? `<small>${esc(item.reason)}</small>` : ''}</td>
        <td>${fmtTok(eligibility.messageCount || 0)} 条 · ${fmtTok(eligibility.activeDays || 0)} 天 · ${fmtTok(eligibility.directExchanges || 0)} 次双向</td>
        <td>${(Number(item.probability || 0) * 100).toFixed(2)}%<small>随机值 ${Number(item.randomValue || 0).toFixed(4)}</small></td>
        <td>${Number.isFinite(Number(review.score)) ? `${Number(review.score).toFixed(1)} / 100` : '-'}</td>
        <td>${esc(fmtTime(item.createdAt))}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function bindFeatureAssetActions(rootSelector, kind, entries) {
  const root = $(rootSelector);
  if (!root) return;
  $$('.asset-edit', root).forEach((button) => {
    button.addEventListener('click', () => {
      const entry = button.dataset.assetIndex !== undefined
        ? entries[Number(button.dataset.assetIndex)]
        : entries.find((item) =>
            String(item.id ?? item.userId) === String(button.dataset.assetId));
      if (entry) openAssetEditor(kind, entry);
    });
  });
  $$('.asset-delete', root).forEach((button) => {
    button.addEventListener('click', () => {
      const entry = button.dataset.assetIndex !== undefined
        ? entries[Number(button.dataset.assetIndex)]
        : entries.find((item) =>
            String(item.id ?? item.userId) === String(button.dataset.assetId));
      if (entry) deleteAsset(kind, entry);
    });
  });
}

function renderIdentityFeaturePage(status, identities, memories) {
  const box = $('#identity-page');
  if (!box) return;
  const query = state.identityFeatureQuery || '';
  const __html = `
    <div class="asset-head">
      <div><h2>人物统一印象</h2><span class="muted" id="identity-feature-state">${status.active ? `运行中 · 最近索引 ${status.lastIndexedAt ? esc(fmtTime(status.lastIndexedAt)) : '-'}` : status.enabled ? `启动失败${status.error ? `：${esc(status.error)}` : ''}` : '当前已停用'}</span></div>
      <button type="button" class="icon-btn" id="identity-feature-refresh" title="刷新人物与旧印象" aria-label="刷新人物与旧印象">↻</button>
    </div>
    <div class="asset-summary">
      <div class="asset-summary-item"><span>统一人物</span><strong>${fmtTok(status.people)}</strong><small>按 QQ 号跨会话聚合</small></div>
      <div class="asset-summary-item"><span>身份别名</span><strong>${fmtTok(status.aliases)}</strong><small>${fmtTok(status.sources)} 个会话来源</small></div>
      <div class="asset-summary-item"><span>旧印象</span><strong>${fmtTok(status.legacyMemories)}</strong><small>来自现有记忆文件</small></div>
      <div class="asset-summary-item"><span>好友</span><strong>${fmtTok(status.friends)}</strong><small>当前好友关系快照</small></div>
    </div>
    <div class="asset-toolbar">
      <div>
        <strong>统一人物与旧印象</strong>
        <div class="hint">统一人物记录和原始旧印象分别维护，模型只按当前会话权限读取。</div>
      </div>
      <div class="asset-toolbar-actions">
        <button type="button" class="btn btn-small" id="identity-add-person">＋ 人物</button>
        <button type="button" class="btn btn-small" id="identity-add-memory">＋ 旧印象</button>
        <div class="asset-search">
          <input type="search" id="identity-feature-query" value="${esc(query)}" placeholder="搜索人物或印象" />
          <button type="button" class="btn btn-small" id="identity-feature-search">搜索</button>
        </div>
      </div>
    </div>
    <section class="control-section">
      <h3>统一人物</h3>
      <div id="identity-feature-people">${renderIdentityAssets(identities)}</div>
    </section>
    <section class="control-section">
      <h3>旧印象</h3>
      <div id="identity-feature-memories">${renderMemoryAssets(memories)}</div>
    </section>`;
  if (!setHtmlIfChanged(box, __html)) return;

  $('#identity-feature-refresh')?.addEventListener('click', () => loadIdentityFeaturePage());
  const search = () => {
    state.identityFeatureQuery = $('#identity-feature-query')?.value || '';
    loadIdentityFeaturePage();
  };
  $('#identity-feature-search')?.addEventListener('click', search);
  $('#identity-feature-query')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') search();
  });
  $('#identity-add-person')?.addEventListener('click', () => openAssetEditor('identities'));
  $('#identity-add-memory')?.addEventListener('click', () => openAssetEditor('memory'));
  bindFeatureAssetActions(
    '#identity-feature-people',
    'identities',
    identities.entries || []
  );
  bindFeatureAssetActions(
    '#identity-feature-memories',
    'memory',
    memories.entries || []
  );
}

async function loadIdentityFeaturePage() {
  const box = $('#identity-page');
  if (!box) return;
  if (!box.__renderedHtml) box.innerHTML = '<div class="empty-hint">正在读取人物与旧印象…</div>';
  try {
    const query = encodeURIComponent(state.identityFeatureQuery || '');
    const [cfg, status, identities, memories, chats] = await Promise.all([
      api('/api/config'),
      api('/api/identity-pilot/status'),
      api(`/api/assets/identities?limit=500&query=${query}`),
      api(`/api/assets/memory?query=${query}`),
      api('/api/chats').catch(() => ({ chats: [] }))
    ]);
    if (state.tab !== 'identity') return;
    state.config = cfg;
    state.chats = chats.chats || state.chats;
    syncGraduatedFeatureNavigation(cfg);
    renderIdentityFeaturePage(status, identities, memories);
  } catch (error) {
    box.innerHTML = `<div class="empty-hint">人物统一印象读取失败：${esc(error.message)}</div>`;
  }
}

function renderFriendFeaturePage(c, status) {
  const box = $('#friend-page');
  if (!box) return;
  const friend = c.identityPilot?.friendProposal || {};
  const incoming = c.identityPilot?.incomingFriendRequest || {};
  const triggered = friend.triggered || {};
  const proposalCounts = status.friendProposal?.counts || {};
  const opportunityCounts = status.friendProposal?.opportunityCounts || {};
  const incomingCounts = status.incomingFriendRequest?.counts || {};
  const __html = `
    <div class="asset-head">
      <div><h2>好友管理</h2><span class="muted" id="friend-feature-state">${status.active ? '统一身份库运行中' : status.enabled ? '统一身份库启动失败' : '人物统一印象已停用'}</span></div>
      <button type="button" class="icon-btn" id="friend-feature-refresh" title="刷新好友工作流" aria-label="刷新好友工作流">↻</button>
    </div>
    <div class="asset-summary">
      <div class="asset-summary-item"><span>主动候选待审批</span><strong>${fmtTok(proposalCounts.pending)}</strong><small>管理员批准后发送</small></div>
      <div class="asset-summary-item"><span>消息触发评估</span><strong>${fmtTok(opportunityCounts.total)}</strong><small>${fmtTok(opportunityCounts.proposed)} 次提名</small></div>
      <div class="asset-summary-item"><span>评估中</span><strong>${fmtTok(opportunityCounts.active)}</strong><small>${fmtTok(opportunityCounts.reviewFailed)} 次失败</small></div>
      <div class="asset-summary-item"><span>好友关系快照</span><strong>${status.friendProposal?.friendStatusTrusted ? '可信' : '不可用'}</strong><small>${status.friendProposal?.friendSnapshotAt ? esc(fmtTime(status.friendProposal.friendSnapshotAt)) : '未知时不触发'}</small></div>
    </div>
    <section class="control-section">
      <div class="control-section-title">
        <div><h3>运行设置</h3><span class="muted">主动加好友已退役（Issue #10），下表配置不再生效；入站好友请求审批不受影响</span></div>
        <button type="button" class="btn btn-primary btn-small" id="friend-feature-save">保存好友设置</button>
      </div>
      <div class="field-row">
        <div class="field"><label>好友审批管理员 QQ</label><input type="text" id="cfg-identity-friend-owner" inputmode="numeric" value="${esc(friend.ownerUin || '')}" /></div>
        <div class="field"><label>候选生成模式</label><select id="cfg-identity-friend-mode"><option value="triggered" ${friend.mode === 'triggered' ? 'selected' : ''}>消息触发评估</option><option value="prompt" ${friend.mode !== 'triggered' ? 'selected' : ''}>旧版提示词提名</option></select></div>
        <div class="field"><label>旧模式最低累计消息</label><input type="number" id="cfg-identity-friend-min-messages" min="1" max="10000" value="${esc(friend.minMessageCount ?? 50)}" /></div>
        <div class="field"><label>同一用户冷却天数</label><input type="number" id="cfg-identity-friend-cooldown" min="1" max="365" value="${esc(friend.cooldownDays ?? 30)}" /></div>
        <div class="field"><label>主动候选待审批上限</label><input type="number" id="cfg-identity-friend-max-pending" min="1" max="100" value="${esc(friend.maxPending ?? 10)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>抽签概率（%）</label><input type="number" id="cfg-friend-trigger-probability" min="0" max="100" step="0.1" value="${esc((Number(triggered.probability ?? 0.05) * 100).toFixed(1))}" /></div>
        <div class="field"><label>统计窗口（天）</label><input type="number" id="cfg-friend-trigger-history-days" min="1" max="365" value="${esc(triggered.historyDays ?? 30)}" /></div>
        <div class="field"><label>最低有效发言</label><input type="number" id="cfg-friend-trigger-min-messages" min="0" max="10000" value="${esc(triggered.minMessages ?? 50)}" /></div>
        <div class="field"><label>最低活跃日</label><input type="number" id="cfg-friend-trigger-min-days" min="0" max="365" value="${esc(triggered.minActiveDays ?? 3)}" /></div>
        <div class="field"><label>最低双向交流</label><input type="number" id="cfg-friend-trigger-min-exchanges" min="0" max="1000" value="${esc(triggered.minDirectExchanges ?? 3)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>触发消息最长延迟（分钟）</label><input type="number" id="cfg-friend-trigger-max-age" min="1" max="1440" value="${esc(triggered.maxTriggerAgeMinutes ?? 10)}" /></div>
        <div class="field"><label>好友快照最长缓存（分钟）</label><input type="number" id="cfg-friend-trigger-friend-age" min="1" max="1440" value="${esc(triggered.friendStatusMaxAgeMinutes ?? 15)}" /></div>
        <div class="field"><label>抽签冷却（分钟）</label><input type="number" id="cfg-friend-trigger-draw-cooldown" min="1" max="10080" value="${esc(triggered.drawCooldownMinutes ?? 30)}" /></div>
        <div class="field"><label>每人每日抽签上限</label><input type="number" id="cfg-friend-trigger-max-draws" min="1" max="1000" value="${esc(triggered.maxDrawsPerUserPerDay ?? 6)}" /></div>
        <div class="field"><label>每日模型评估上限</label><input type="number" id="cfg-friend-trigger-max-reviews" min="0" max="1000" value="${esc(triggered.maxReviewsPerDay ?? 10)}" /></div>
        <div class="field"><label>提名分数线</label><input type="number" id="cfg-friend-trigger-threshold" min="0" max="100" value="${esc(triggered.scoreThreshold ?? 70)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>模型跳过冷却（天）</label><input type="number" id="cfg-friend-trigger-skip-cooldown" min="0" max="365" value="${esc(triggered.skipCooldownDays ?? 7)}" /></div>
        <div class="field"><label>评估失败冷却（分钟）</label><input type="number" id="cfg-friend-trigger-error-cooldown" min="1" max="10080" value="${esc(triggered.errorCooldownMinutes ?? 60)}" /></div>
        <div class="field"><label>评估排队期限（秒）</label><input type="number" id="cfg-friend-trigger-queue-age" min="5" max="3600" value="${esc(triggered.maxQueueAgeSeconds ?? 120)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>互动质量权重</label><input type="number" id="cfg-friend-weight-quality" min="0" max="100" value="${esc(triggered.weights?.quality ?? 40)}" /></div>
        <div class="field"><label>交流意愿权重</label><input type="number" id="cfg-friend-weight-interest" min="0" max="100" value="${esc(triggered.weights?.interest ?? 30)}" /></div>
        <div class="field"><label>双向投入权重</label><input type="number" id="cfg-friend-weight-reciprocity" min="0" max="100" value="${esc(triggered.weights?.reciprocity ?? 20)}" /></div>
        <div class="field"><label>关系稳定权重</label><input type="number" id="cfg-friend-weight-stability" min="0" max="100" value="${esc(triggered.weights?.stability ?? 10)}" /></div>
      </div>
      <div class="hint">已经是好友的用户不会进入抽签或模型评估；好友状态无法确认时同样不会触发。四项权重合计必须为 100。</div>
      <div class="checkbox-row">
        <input type="checkbox" id="cfg-identity-friend-dispatch" ${friend.activeDispatchEnabled === true ? 'checked' : ''} />
        <label for="cfg-identity-friend-dispatch">管理员批准后主动发送好友申请</label>
      </div>
      <div class="field-row">
        <div class="field"><label>入站请求待审批上限</label><input type="number" id="cfg-identity-incoming-max-pending" min="1" max="500" value="${esc(incoming.maxPending ?? 50)}" /></div>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="cfg-identity-incoming-auto-whitelist" ${incoming.autoWhitelist !== false ? 'checked' : ''} />
        <label for="cfg-identity-incoming-auto-whitelist">同意或确认成为好友后自动加入私聊白名单</label>
      </div>
      <div class="hint" id="identity-friend-protocol">${esc(status.friendProposal?.protocolNote || '')}</div>
      <div class="hint" id="friend-feature-save-result"></div>
    </section>
    <section class="control-section" id="identity-incoming-friend-box">
      <h3>收到的好友请求</h3>
      <div class="identity-pilot-people" id="identity-incoming-friend-requests"></div>
    </section>
    <section class="control-section" id="identity-friend-proposal-box">
      <h3>Agent 主动好友候选</h3>
      <div class="identity-pilot-people" id="identity-friend-proposals"></div>
    </section>
    <section class="control-section" id="identity-friend-opportunity-box">
      <h3>消息触发与评估记录</h3>
      <div class="identity-pilot-people" id="identity-friend-opportunities"></div>
    </section>`;
  if (!setHtmlIfChanged(box, __html)) return;
  $('#friend-feature-refresh')?.addEventListener('click', () => loadFriendFeaturePage());
  $('#friend-feature-save')?.addEventListener('click', saveFriendFeatureConfig);
}

async function saveFriendFeatureConfig() {
  const c = state.config || await api('/api/config');
  const result = $('#friend-feature-save-result');
  const patch = {
    identityPilot: identityPilotSettingsPatch(
      c,
      c.identityPilot?.enabled === true,
      {
        ownerUin: $('#cfg-identity-friend-owner')?.value?.trim() || '',
        mode: $('#cfg-identity-friend-mode')?.value === 'prompt' ? 'prompt' : 'triggered',
        activeDispatchEnabled: $('#cfg-identity-friend-dispatch')?.checked === true,
        minMessageCount: clampInt($('#cfg-identity-friend-min-messages')?.value, 1, 10000, 50),
        cooldownDays: clampInt($('#cfg-identity-friend-cooldown')?.value, 1, 365, 30),
        maxPending: clampInt($('#cfg-identity-friend-max-pending')?.value, 1, 100, 10),
        triggered: {
          ...(c.identityPilot?.friendProposal?.triggered || {}),
          probability: Math.min(1, Math.max(0, Number($('#cfg-friend-trigger-probability')?.value) / 100 || 0)),
          historyDays: clampInt($('#cfg-friend-trigger-history-days')?.value, 1, 365, 30),
          minMessages: clampInt($('#cfg-friend-trigger-min-messages')?.value, 0, 10000, 50),
          minActiveDays: clampInt($('#cfg-friend-trigger-min-days')?.value, 0, 365, 3),
          minDirectExchanges: clampInt($('#cfg-friend-trigger-min-exchanges')?.value, 0, 1000, 3),
          maxTriggerAgeMinutes: clampInt($('#cfg-friend-trigger-max-age')?.value, 1, 1440, 10),
          friendStatusMaxAgeMinutes: clampInt($('#cfg-friend-trigger-friend-age')?.value, 1, 1440, 15),
          drawCooldownMinutes: clampInt($('#cfg-friend-trigger-draw-cooldown')?.value, 1, 10080, 30),
          maxDrawsPerUserPerDay: clampInt($('#cfg-friend-trigger-max-draws')?.value, 1, 1000, 6),
          maxReviewsPerDay: clampInt($('#cfg-friend-trigger-max-reviews')?.value, 0, 1000, 10),
          skipCooldownDays: clampInt($('#cfg-friend-trigger-skip-cooldown')?.value, 0, 365, 7),
          errorCooldownMinutes: clampInt($('#cfg-friend-trigger-error-cooldown')?.value, 1, 10080, 60),
          maxQueueAgeSeconds: clampInt($('#cfg-friend-trigger-queue-age')?.value, 5, 3600, 120),
          scoreThreshold: clampInt($('#cfg-friend-trigger-threshold')?.value, 0, 100, 70),
          weights: {
            quality: clampInt($('#cfg-friend-weight-quality')?.value, 0, 100, 40),
            interest: clampInt($('#cfg-friend-weight-interest')?.value, 0, 100, 30),
            reciprocity: clampInt($('#cfg-friend-weight-reciprocity')?.value, 0, 100, 20),
            stability: clampInt($('#cfg-friend-weight-stability')?.value, 0, 100, 10)
          }
        }
      },
      {
        autoWhitelist: $('#cfg-identity-incoming-auto-whitelist')?.checked !== false,
        maxPending: clampInt($('#cfg-identity-incoming-max-pending')?.value, 1, 500, 50)
      }
    )
  };
  if (result) result.textContent = '保存中…';
  try {
    const response = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(patch)
    });
    state.config = response.config;
    syncGraduatedFeatureNavigation(state.config);
    await loadFriendFeaturePage();
  } catch (error) {
    if (result) result.textContent = `保存失败：${error.message}`;
  }
}

async function loadFriendFeaturePage() {
  const box = $('#friend-page');
  if (!box) return;
  if (!box.__renderedHtml) box.innerHTML = '<div class="empty-hint">正在读取好友工作流…</div>';
  try {
    const [cfg, status] = await Promise.all([
      api('/api/config'),
      api('/api/identity-pilot/status')
    ]);
    if (state.tab !== 'friends') return;
    state.config = cfg;
    syncGraduatedFeatureNavigation(cfg);
    renderFriendFeaturePage(cfg, status);
    // 三个列表各自把失败显示在自己的框里（各自的 try/catch）：用 allSettled 而不是 all，
    // 一个接口出错不会把整页（含下面的设置表单与刷新按钮）换成一整块错误信息。
    await Promise.allSettled([
      loadIncomingFriendRequests(status),
      loadFriendProposals(status),
      loadFriendOpportunities(status)
    ]);
  } catch (error) {
    box.innerHTML = `<div class="empty-hint">好友管理读取失败：${esc(error.message)}</div>`;
  }
}

function renderSlangFeaturePage(c, status) {
  const box = $('#slang-page');
  if (!box) return;
  const slang = c.slangPilot || {};
  const __html = `
    <div class="asset-head">
      <div><h2>黑话研究</h2><span class="muted">${status.active ? `运行中 · 待研究 ${fmtTok(status.pendingResearch)} · 待入库 ${fmtTok(status.pendingAdmission)}` : status.enabled ? `启动失败${status.error ? `：${esc(status.error)}` : ''}` : '当前已停用'}</span></div>
      <button type="button" class="icon-btn" id="slang-feature-refresh" title="刷新黑话状态" aria-label="刷新黑话状态">↻</button>
    </div>
    <section class="control-section">
      <div class="control-section-title">
        <div><h3>研究设置</h3><span class="muted">启停由“设置 → 实验功能”统一控制</span></div>
        <button type="button" class="btn btn-primary btn-small" id="slang-feature-save">保存研究设置</button>
      </div>
      <div class="field-row">
        <div class="field"><label>审批管理员 QQ</label><input type="text" id="cfg-slang-owner" inputmode="numeric" value="${esc(slang.ownerUin || c.identityPilot?.friendProposal?.ownerUin || '')}" /></div>
        <div class="field"><label>最少出现次数</label><input type="number" id="cfg-slang-min-occurrences" min="2" max="20" value="${esc(slang.minOccurrences ?? 3)}" /></div>
        <div class="field"><label>最少发言人数</label><input type="number" id="cfg-slang-min-speakers" min="1" max="20" value="${esc(slang.minSpeakers ?? 2)}" /></div>
        <div class="field"><label>统计窗口（小时）</label><input type="number" id="cfg-slang-window-hours" min="1" max="720" value="${esc(slang.windowHours ?? 72)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>待处理总上限</label><input type="number" id="cfg-slang-max-pending" min="1" max="500" value="${esc(slang.maxPending ?? 100)}" /></div>
        <div class="field"><label>每群每日新增上限</label><input type="number" id="cfg-slang-daily-limit" min="1" max="50" value="${esc(slang.perChatDailyLimit ?? 5)}" /></div>
        <div class="field"><label>拒绝冷却天数</label><input type="number" id="cfg-slang-reject-cooldown" min="1" max="365" value="${esc(slang.rejectCooldownDays ?? 14)}" /></div>
        <div class="field"><label>每词证据上限</label><input type="number" id="cfg-slang-max-evidence" min="3" max="30" value="${esc(slang.maxEvidence ?? 12)}" /></div>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="cfg-slang-web-research" ${slang.webResearch !== false ? 'checked' : ''} />
        <label for="cfg-slang-web-research">管理员批准后联网研究</label>
      </div>
      <div class="field-row">
        <div class="field"><label>搜索结果上限</label><input type="number" id="cfg-slang-search-results" min="1" max="10" value="${esc(slang.maxSearchResults ?? 5)}" /></div>
        <div class="field"><label>正文抓取页数</label><input type="number" id="cfg-slang-fetch-pages" min="0" max="3" value="${esc(slang.maxFetchPages ?? 2)}" /></div>
        <div class="field"><label>格式纠正轮数</label><input type="number" id="cfg-slang-research-rounds" min="1" max="3" value="${esc(slang.maxResearchRounds ?? 2)}" /></div>
      </div>
      <div class="settings-actions">
        <button type="button" class="btn btn-small" data-open-slang-assets="slang-research">查看研究队列</button>
        <button type="button" class="btn btn-small" data-open-slang-assets="slang">查看黑话资产</button>
        <span class="hint" id="slang-feature-save-result"></span>
      </div>
    </section>`;
  if (!setHtmlIfChanged(box, __html)) return;
  $('#slang-feature-refresh')?.addEventListener('click', () => loadSlangFeaturePage());
  $('#slang-feature-save')?.addEventListener('click', saveSlangFeatureConfig);
  $$('[data-open-slang-assets]', box).forEach((button) => {
    button.addEventListener('click', () => {
      state.assetKind = button.dataset.openSlangAssets;
      state.assetDetail = null;
      switchTab('assets');
    });
  });
}

async function saveSlangFeatureConfig() {
  const c = state.config || await api('/api/config');
  const value = (selector, fallback = '') => $(selector)?.value ?? fallback;
  const patch = {
    slangPilot: {
      ...(c.slangPilot || {}),
      ownerUin: value('#cfg-slang-owner').trim(),
      minOccurrences: clampInt(value('#cfg-slang-min-occurrences'), 2, 20, 3),
      minSpeakers: clampInt(value('#cfg-slang-min-speakers'), 1, 20, 2),
      windowHours: clampInt(value('#cfg-slang-window-hours'), 1, 720, 72),
      maxPending: clampInt(value('#cfg-slang-max-pending'), 1, 500, 100),
      perChatDailyLimit: clampInt(value('#cfg-slang-daily-limit'), 1, 50, 5),
      rejectCooldownDays: clampInt(value('#cfg-slang-reject-cooldown'), 1, 365, 14),
      maxEvidence: clampInt(value('#cfg-slang-max-evidence'), 3, 30, 12),
      webResearch: $('#cfg-slang-web-research')?.checked !== false,
      maxSearchResults: clampInt(value('#cfg-slang-search-results'), 1, 10, 5),
      maxFetchPages: clampInt(value('#cfg-slang-fetch-pages'), 0, 3, 2),
      maxResearchRounds: clampInt(value('#cfg-slang-research-rounds'), 1, 3, 2)
    }
  };
  const result = $('#slang-feature-save-result');
  if (result) result.textContent = '保存中…';
  try {
    const response = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(patch)
    });
    state.config = response.config;
    syncGraduatedFeatureNavigation(state.config);
    await loadSlangFeaturePage();
  } catch (error) {
    if (result) result.textContent = `保存失败：${error.message}`;
  }
}

async function loadSlangFeaturePage() {
  const box = $('#slang-page');
  if (!box) return;
  box.innerHTML = '<div class="empty-hint">正在读取黑话研究配置…</div>';
  try {
    const [cfg, status] = await Promise.all([
      api('/api/config'),
      api('/api/slang-pilot/status')
    ]);
    if (state.tab !== 'slang') return;
    state.config = cfg;
    syncGraduatedFeatureNavigation(cfg);
    renderSlangFeaturePage(cfg, status);
  } catch (error) {
    box.innerHTML = `<div class="empty-hint">黑话研究读取失败：${esc(error.message)}</div>`;
  }
}

const INCIDENT_SEVERITY_LABELS = {
  info: '信息', warning: '警告', error: '错误', critical: '严重'
};
const INCIDENT_STATE_LABELS = {
  open: '待处理', acknowledged: '已确认', resolved: '已解决'
};

function renderIncidentFeaturePage(c, status, incidents = []) {
  const box = $('#incident-page');
  if (!box) return;
  const settings = c.incidentPilot || {};
  const counts = status.counts || {};
  const __html = `
    <div class="asset-head">
      <div><h2>异常</h2><span class="muted">${status.active ? '异常处理试点运行中' : status.exists ? '试点已停用，保留只读日志' : '异常处理试点尚未启用'}</span></div>
      <button type="button" class="icon-btn" id="incident-feature-refresh" title="刷新异常" aria-label="刷新异常">↻</button>
    </div>
    <div class="asset-summary">
      <div class="asset-summary-item"><span>待处理</span><strong>${fmtTok(counts.open)}</strong><small>尚未确认或解决</small></div>
      <div class="asset-summary-item"><span>严重</span><strong>${fmtTok(counts.critical)}</strong><small>未解决严重异常</small></div>
      <div class="asset-summary-item"><span>已确认</span><strong>${fmtTok(counts.acknowledged)}</strong><small>已看到，尚未解决</small></div>
      <div class="asset-summary-item"><span>告警待发送</span><strong>${fmtTok(status.pendingNotifications)}</strong><small>OneBot 恢复后发送</small></div>
    </div>
    <section class="control-section">
      <div class="control-section-title">
        <div><h3>告警与策略</h3><span class="muted">启停由“设置 → 实验功能”统一控制</span></div>
        <button type="button" class="btn btn-primary btn-small" id="incident-feature-save">保存异常设置</button>
      </div>
      <div class="field-row">
        <div class="field"><label>告警管理员 QQ</label><input type="text" id="cfg-incident-owner" inputmode="numeric" value="${esc(settings.ownerUin || '')}" /></div>
        <div class="field"><label>同类异常合并窗口（分钟）</label><input type="number" id="cfg-incident-window" min="1" max="1440" value="${esc(settings.duplicateWindowMinutes ?? 10)}" /></div>
        <div class="field"><label>已解决日志保留天数</label><input type="number" id="cfg-incident-retention" min="1" max="3650" value="${esc(settings.retentionDays ?? 90)}" /></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-incident-warnings" ${settings.notifyWarnings !== false ? 'checked' : ''} />
        <label for="cfg-incident-warnings">警告级异常也通知管理员</label></div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-incident-unknown-block" ${settings.unknownWritesBlockChat === true ? 'checked' : ''} />
        <label for="cfg-incident-unknown-block">未知写入阻塞整个会话（兼容旧策略）</label></div>
      <div class="hint">关闭兼容策略后，未知旧写入仍不重试，但新消息可以继续处理。</div>
      <div class="hint" id="incident-feature-save-result"></div>
    </section>
    <section class="control-section">
      <div class="control-section-title">
        <div><h3>异常日志</h3><span class="muted">删除日志不会解除未知写入或改变会话状态</span></div>
        <div class="settings-actions" style="margin:0">
          <select id="incident-state-filter" aria-label="异常状态">
            <option value="">全部状态</option>
            ${Object.entries(INCIDENT_STATE_LABELS).map(([value, label]) =>
              `<option value="${value}" ${state.incidentState === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <select id="incident-severity-filter" aria-label="异常等级">
            <option value="">全部等级</option>
            ${Object.entries(INCIDENT_SEVERITY_LABELS).map(([value, label]) =>
              `<option value="${value}" ${state.incidentSeverity === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="table-wrap"><table class="usage-table incident-table">
        <thead><tr><th>时间</th><th>等级</th><th>来源</th><th>会话</th><th>异常</th><th>次数</th><th>状态</th><th></th></tr></thead>
        <tbody>${incidents.map((incident) => `<tr>
          <td>${esc(fmtTime(incident.lastAt))}</td>
          <td><span class="incident-severity severity-${esc(incident.severity)}">${esc(INCIDENT_SEVERITY_LABELS[incident.severity] || incident.severity)}</span></td>
          <td>${esc(incident.source || '-')}</td>
          <td>${esc(incident.chatKey || '-')}</td>
          <td><details><summary>${esc(String(incident.message || incident.code || '').slice(0, 160))}${String(incident.message || '').length > 160 ? ' …（点开看全文）' : ''}</summary>
            <div class="incident-detail"><code>${esc(incident.code)}</code>
              ${incident.sessionId ? `<div>Session：${esc(incident.sessionId)}</div>` : ''}
              ${incident.operationId ? `<div>Operation：${esc(incident.operationId)}</div>` : ''}
              ${incident.notifyError ? `<div>告警：${esc(incident.notifyError)}</div>` : ''}
              ${incident.resolution ? `<div>处理：${esc(incident.resolution)}</div>` : ''}
            </div></details></td>
          <td>${fmtTok(incident.count)}</td>
          <td>${esc(INCIDENT_STATE_LABELS[incident.state] || incident.state)}</td>
          <td><div class="settings-actions incident-actions">
            ${incident.state === 'open' ? `<button type="button" class="btn btn-small" data-incident-ack="${esc(incident.id)}">确认</button>` : ''}
            ${incident.state !== 'resolved' ? `<button type="button" class="btn btn-small" data-incident-resolve="${esc(incident.id)}">解决</button>` : ''}
            ${incident.state === 'resolved' ? `<button type="button" class="icon-btn" data-incident-delete="${esc(incident.id)}" title="删除日志" aria-label="删除日志">×</button>` : ''}
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${incidents.length ? '' : '<div class="empty-hint">当前筛选条件下没有异常日志</div>'}
    </section>`;
  if (!setHtmlIfChanged(box, __html)) return;

  $('#incident-feature-refresh')?.addEventListener('click', () => loadIncidentFeaturePage());
  $('#incident-feature-save')?.addEventListener('click', saveIncidentFeatureConfig);
  $('#incident-state-filter')?.addEventListener('change', (event) => {
    state.incidentState = event.target.value;
    loadIncidentFeaturePage();
  });
  $('#incident-severity-filter')?.addEventListener('change', (event) => {
    state.incidentSeverity = event.target.value;
    loadIncidentFeaturePage();
  });
  $$('[data-incident-ack]', box).forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/incidents/${encodeURIComponent(button.dataset.incidentAck)}/acknowledge`, {
      method: 'POST', body: '{}'
    });
    loadIncidentFeaturePage();
  }));
  $$('[data-incident-resolve]', box).forEach((button) => button.addEventListener('click', async () => {
    const resolution = prompt('填写处理结果');
    if (!resolution?.trim()) return;
    await api(`/api/incidents/${encodeURIComponent(button.dataset.incidentResolve)}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolution: resolution.trim() })
    });
    loadIncidentFeaturePage();
  }));
  $$('[data-incident-delete]', box).forEach((button) => button.addEventListener('click', async () => {
    if (!await askForConfirmation('删除这条已解决的异常日志？业务状态和 Session 不会被删除。')) return;
    await api(`/api/incidents/${encodeURIComponent(button.dataset.incidentDelete)}`, {
      method: 'DELETE', body: JSON.stringify({ confirm: true })
    });
    loadIncidentFeaturePage();
  }));
}

async function saveIncidentFeatureConfig() {
  const c = state.config || await api('/api/config');
  const result = $('#incident-feature-save-result');
  if (result) result.textContent = '保存中…';
  try {
    const response = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        incidentPilot: {
          ...(c.incidentPilot || {}),
          ownerUin: $('#cfg-incident-owner')?.value?.trim() || '',
          notifyWarnings: $('#cfg-incident-warnings')?.checked !== false,
          unknownWritesBlockChat: $('#cfg-incident-unknown-block')?.checked === true,
          duplicateWindowMinutes: clampInt($('#cfg-incident-window')?.value, 1, 1440, 10),
          retentionDays: clampInt($('#cfg-incident-retention')?.value, 1, 3650, 90)
        }
      })
    });
    state.config = response.config;
    await loadIncidentFeaturePage();
  } catch (error) {
    if (result) result.textContent = `保存失败：${error.message}`;
  }
}

async function loadIncidentFeaturePage() {
  const box = $('#incident-page');
  if (!box) return;
  if (!box.__renderedHtml) box.innerHTML = '<div class="empty-hint">正在读取异常日志…</div>';
  try {
    const params = new URLSearchParams({ limit: '200' });
    if (state.incidentState) params.set('state', state.incidentState);
    if (state.incidentSeverity) params.set('severity', state.incidentSeverity);
    const [cfg, data] = await Promise.all([
      api('/api/config'),
      api(`/api/incidents?${params}`)
    ]);
    if (state.tab !== 'incidents') return;
    state.config = cfg;
    syncGraduatedFeatureNavigation(cfg);
    renderIncidentFeaturePage(cfg, data.status || {}, data.incidents || []);
  } catch (error) {
    box.innerHTML = `<div class="empty-hint">异常日志读取失败：${esc(error.message)}</div>`;
  }
}

const TIME_RULE_LABELS = {
  inherit: '继承全局', 'deepseek-offpeak': 'DS 低峰时段',
  custom: '自定义时段', always: '全天活跃'
};
const TIME_DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function renderTimeControlSection(c) {
  if (state.timeControlConfig !== c) {
    state.timeControlConfig = c;
    state.timeControlDraft = structuredClone(c.timeControl || {
      enabled: false, schedule: { mode: 'deepseek-offpeak', windows: [] }, overrides: {}
    });
  }
  state.timeControlTarget ||= '';
  return `
    <section class="time-control-settings">
      <h3>时间控制</h3>
      <div class="checkbox-row">
        <input type="checkbox" id="tc-enabled" ${state.timeControlDraft.enabled ? 'checked' : ''} />
        <label for="tc-enabled">启用时间控制</label>
      </div>
      <div class="time-control-summary">
        <span>Asia/Shanghai · UTC+8</span><span id="tc-live-state"></span>
      </div>
      <div class="field"><label for="tc-target">配置对象</label>
        <select id="tc-target">${timeControlTargetOptions()}</select>
      </div>
      <div id="tc-rule-editor">${renderTimeRuleEditor()}</div>
      <div class="time-control-summary" id="tc-next-change"></div>
    </section>`;
}

function timeControlTargetOptions() {
  const c = state.timeControlConfig || state.config || {};
  const keys = [...new Set([
    ...(state.chats || []).map((chat) => chat.key),
    ...(state.timeControlStatus?.chats || []).map((chat) => chat.chatKey),
    ...(c.allow?.groups || []).map((id) => `group:${id}`),
    ...(c.allow?.private || []).map((id) => `private:${id}`),
    ...Object.keys(state.timeControlDraft?.overrides || {})
  ])].filter((key) => /^(group|private):\d+$/.test(key)).sort();
  if (state.timeControlTarget && !keys.includes(state.timeControlTarget)) keys.push(state.timeControlTarget);
  return [['', '全局默认（含每日动态）'], ...keys.map((key) => [key, formatChatTitle(key, chatNameOf(key))])]
    .map(([key, label]) => `<option value="${esc(key)}" ${state.timeControlTarget === key ? 'selected' : ''}>${esc(label)}</option>`)
    .join('');
}

function renderTimeRuleEditor() {
  const draft = state.timeControlDraft;
  const key = state.timeControlTarget;
  const rule = key ? draft.overrides[key] || { mode: 'inherit', windows: [] } : draft.schedule;
  const modes = key ? Object.keys(TIME_RULE_LABELS) : Object.keys(TIME_RULE_LABELS).filter((mode) => mode !== 'inherit');
  const preset = rule.mode === 'deepseek-offpeak' ? `
    <dl class="time-control-preset">
      <dt>周一至周五</dt><dd>00:00–09:00 / 12:00–14:00 / 18:00–24:00</dd>
      <dt>周六、周日</dt><dd>全天</dd>
    </dl>` : '';
  return `
    <div class="field"><label for="tc-mode">活跃规则</label>
      <select id="tc-mode">${modes.map((mode) =>
        `<option value="${mode}" ${rule.mode === mode ? 'selected' : ''}>${TIME_RULE_LABELS[mode]}</option>`
      ).join('')}</select>
    </div>
    ${preset}
    ${rule.mode === 'custom' ? `
      <div id="tc-windows">
        ${(rule.windows || []).map((window, index) => `
          <div class="tc-window" data-index="${index}">
            <div class="tc-days">${TIME_DAYS.map((label, i) =>
              `<label><input type="checkbox" data-day="${i + 1}" ${(window.days || []).includes(i + 1) ? 'checked' : ''} />${label}</label>`
            ).join('')}</div>
            <div class="field"><label>开始</label><input class="tc-start" type="time" value="${esc(window.start)}" /></div>
            <div class="field"><label>结束</label><input class="tc-end" type="text" inputmode="numeric" value="${esc(window.end)}" placeholder="24:00" /></div>
            <button type="button" class="icon-btn tc-remove" data-index="${index}" title="删除时间段" aria-label="删除时间段">×</button>
          </div>`).join('')}
      </div>
      <button type="button" class="icon-btn" id="tc-add" title="添加时间段" aria-label="添加时间段">+</button>
    ` : ''}`;
}

function captureTimeControlRule() {
  const mode = $('#tc-mode')?.value;
  if (!mode || !state.timeControlDraft) return;
  const key = state.timeControlTarget;
  const old = key ? state.timeControlDraft.overrides[key] : state.timeControlDraft.schedule;
  const windows = $('#tc-windows') ? $$('.tc-window').map((row) => ({
    days: $$('input[data-day]:checked', row).map((input) => Number(input.dataset.day)),
    start: $('.tc-start', row).value,
    end: $('.tc-end', row).value.trim()
  })) : (old?.windows || []);
  if (key) {
    if (mode === 'inherit') delete state.timeControlDraft.overrides[key];
    else state.timeControlDraft.overrides[key] = { mode, windows };
  } else state.timeControlDraft.schedule = { mode, windows };
}

function updateTimeControlLiveState() {
  const status = state.timeControlStatus;
  const current = state.timeControlTarget
    ? status?.chats?.find((chat) => chat.chatKey === state.timeControlTarget) : status?.global;
  const label = $('#tc-live-state');
  if (label) label.textContent = !current?.enabled ? '时间控制未启用' : current.active ? '当前活跃' : '当前仅记录';
  const next = $('#tc-next-change');
  if (next) next.textContent = current?.enabled && current.nextChangeAt
    ? `下次切换：${new Date(current.nextChangeAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
    : '';
}

async function loadTimeControlStatus() {
  if (!$('#tc-target')) return;
  try {
    state.timeControlStatus = await api('/api/time-control/status');
    const target = $('#tc-target');
    if (!target) return;
    target.innerHTML = timeControlTargetOptions();
    updateTimeControlLiveState();
  } catch (error) {
    if ($('#tc-live-state')) $('#tc-live-state').textContent = error.message;
  }
}

function bindTimeControlEvents() {
  const editor = $('#tc-rule-editor');
  const redraw = () => { editor.innerHTML = renderTimeRuleEditor(); updateTimeControlLiveState(); };
  $('#tc-enabled').addEventListener('change', (event) => {
    state.timeControlDraft.enabled = event.target.checked;
  });
  $('#tc-target').addEventListener('change', (event) => {
    captureTimeControlRule();
    state.timeControlTarget = event.target.value;
    redraw();
  });
  editor.addEventListener('change', (event) => {
    captureTimeControlRule();
    if (event.target.id === 'tc-mode') redraw();
  });
  editor.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    captureTimeControlRule();
    const rule = state.timeControlTarget
      ? state.timeControlDraft.overrides[state.timeControlTarget] : state.timeControlDraft.schedule;
    if (button.id === 'tc-add' && rule.windows.length < 32) {
      rule.windows.push({ days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00' });
    } else if (button.classList.contains('tc-remove')) rule.windows.splice(Number(button.dataset.index), 1);
    redraw();
  });
  loadTimeControlStatus();
}

const MOMENT_STATUS_LABELS = {
  running: '生成中', preview: '草稿', skipped: '决定不发布',
  publishing: '发布中', published: '已发布', 'publish-unknown': '发布结果待核对',
  'publish-missed': '已核对·确认未发出',
  failed: '生成失败', interrupted: '生成已中断', deferred: '等待活跃时间',
  missed: '已错过窗口', cancelled: '已取消', pending: '待执行'
};
const momentStatusLabel = (record) => record?.status === 'preview' && record.decision === 'skip'
  ? '预览：决定不发布' : (MOMENT_STATUS_LABELS[record?.status] || record?.status || '-');

function renderDailyMomentsSection(c) {
  const moments = c.dailyMoments || {};
  const visibility = Number(moments.visibility) || 4;
  const randomMode = Array.isArray(moments.scheduleWindows);
  const hour = Number(moments.hour ?? 23);
  const minute = String(moments.minute ?? 30).padStart(2, '0');
  const interval = Math.min(30, Math.max(1, Math.round(Number(moments.intervalDays) || 1)));
  const intervalIsPreset = [1, 2, 3, 5, 7].includes(interval);
  const windows = moments.scheduleWindows || [{
    start: `${String(hour).padStart(2, '0')}:${minute}`,
    end: `${String((hour + 1) % 24).padStart(2, '0')}:${minute}`, count: 1
  }];
  return `
    <h3 id="settings-moments">每日动态</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-moments-enabled" ${moments.enabled === true ? 'checked' : ''} />
      <label for="cfg-moments-enabled">启用每日群聊总结与说说决策</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-moments-catchup" ${moments.startupCatchup !== false ? 'checked' : ''} />
      <label for="cfg-moments-catchup" id="cfg-moments-catchup-label">${randomMode ? '重启后在未结束的范围内补跑' : '服务错过固定时刻后补跑'}</label></div>
    <div class="field"><label for="cfg-moments-schedule-mode">定时方式（上海时间）</label>
      <select id="cfg-moments-schedule-mode">
        <option value="windows" ${randomMode ? 'selected' : ''}>时间范围内随机发布</option>
        <option value="fixed" ${randomMode ? '' : 'selected'}>固定时刻</option>
      </select>
    </div>
    <div id="moment-fixed-time" ${randomMode ? 'hidden' : ''}>
      <div class="field-row">
        <div class="field"><label>执行小时（上海时间）</label><input type="number" id="cfg-moments-hour" min="0" max="23" value="${esc(moments.hour ?? 23)}" /></div>
        <div class="field"><label>执行分钟</label><input type="number" id="cfg-moments-minute" min="0" max="59" value="${esc(moments.minute ?? 30)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="cfg-moments-interval">发送间隔</label>
          <select id="cfg-moments-interval">
            <option value="1" ${interval === 1 ? 'selected' : ''}>每天</option>
            <option value="2" ${interval === 2 ? 'selected' : ''}>每 2 天</option>
            <option value="3" ${interval === 3 ? 'selected' : ''}>每 3 天</option>
            <option value="5" ${interval === 5 ? 'selected' : ''}>每 5 天</option>
            <option value="7" ${interval === 7 ? 'selected' : ''}>每 7 天</option>
            <option value="custom" ${intervalIsPreset ? '' : 'selected'}>自定义</option>
          </select></div>
        <div class="field" id="moment-interval-custom-wrap" ${intervalIsPreset ? 'hidden' : ''}>
          <label for="cfg-moments-interval-custom">自定义天数（1-30）</label>
          <input type="number" id="cfg-moments-interval-custom" min="1" max="30" value="${esc(interval)}" /></div>
      </div>
      <div class="hint">发送间隔以上次成功发布为基准：满 N 天才发下一篇；没到期的日子不读群聊、不调模型。失败不顺延，次日重试。</div>
    </div>
    <div id="moment-random-windows" ${randomMode ? '' : 'hidden'}>
      <div id="moment-window-rows">${windows.map(renderMomentWindowRow).join('')}</div>
      <button type="button" class="btn btn-small" id="moment-window-add" title="添加时间范围" aria-label="添加时间范围">+</button>
    </div>
    <div class="field-row">
      <div class="field"><label>说说可见范围</label>
        <select id="cfg-moments-visibility">
          <option value="1" ${visibility === 1 ? 'selected' : ''}>所有人可见</option>
          <option value="4" ${visibility === 4 ? 'selected' : ''}>好友可见</option>
          <option value="64" ${visibility === 64 ? 'selected' : ''}>仅自己可见</option>
        </select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每群最低消息数</label><input type="number" id="cfg-moments-min-messages" min="0" max="100" value="${esc(moments.minMessagesPerGroup ?? 3)}" /></div>
      <div class="field"><label>最多汇总群数</label><input type="number" id="cfg-moments-max-groups" min="1" max="50" value="${esc(moments.maxGroups ?? 12)}" /></div>
      <div class="field"><label>每群最多读取消息</label><input type="number" id="cfg-moments-max-messages" min="5" max="300" value="${esc(moments.maxMessagesPerGroup ?? 80)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-moments-images" ${moments.allowImages !== false ? 'checked' : ''} />
      <label for="cfg-moments-images">允许模型查看并选择近期群图或收藏图</label></div>
    <div class="field-row">
      <div class="field"><label>单条说说最多配图</label><input type="number" id="cfg-moments-max-images" min="0" max="4" value="${esc(moments.maxImages ?? 1)}" /></div>
      <div class="field"><label>最多研究调用</label><input type="number" id="cfg-moments-research" min="0" max="10" value="${esc(moments.maxResearchCalls ?? 4)}" /></div>
      <div class="field"><label>模型最大轮次</label><input type="number" id="cfg-moments-rounds" min="2" max="16" value="${esc(moments.maxRounds ?? 8)}" /></div>
    </div>
    <div class="settings-actions">
      <button class="btn btn-small" id="daily-moments-preview-btn">生成新草稿</button>
      <button class="btn btn-primary btn-small" id="daily-moments-run-btn">立即总结并执行</button>
      <span id="daily-moments-action-result" class="muted"></span>
    </div>
    <div id="daily-moments-status" class="daily-moments-status"><span class="muted">正在读取状态…</span></div>`;
}

function renderMomentWindowRow(window) {
  return `<div class="moment-window-row">
    <div class="field"><label>开始</label><input type="time" class="moment-window-start" aria-label="范围开始时间" value="${esc(window.start)}" required /></div>
    <div class="field"><label>结束</label><input type="time" class="moment-window-end" aria-label="范围结束时间" value="${esc(window.end)}" required /></div>
    <div class="field"><label>计划条数</label><input type="number" class="moment-window-count" aria-label="计划条数" min="1" max="10" value="${esc(window.count)}" required /></div>
    <button type="button" class="btn btn-small moment-window-remove" title="删除时间范围" aria-label="删除时间范围">&times;</button>
  </div>`;
}

function renderMomentSchedule(status) {
  const slots = status.scheduleSlots || [];
  const check = status.lastScheduleCheck;
  return `${check?.reason ? `<div class="field"><label>最近调度结果</label><div>${esc(check.reason)}</div></div>` : ''}
    ${slots.length ? `<details class="moment-schedule" open><summary>随机发布计划（上海时间）</summary>
      <div class="table-wrap"><table class="usage-table"><thead><tr>
        <th>日期</th><th>时间范围</th><th>随机时间</th><th>状态</th><th>原因</th>
      </tr></thead><tbody>${slots.map((slot) => `<tr>
        <td>${esc(slot.dayKey)}</td><td>${esc(slot.windowKey)}</td>
        <td>${esc(fmtTime(slot.at))}</td><td>${esc(MOMENT_STATUS_LABELS[slot.status] || slot.status)}</td>
        <td>${esc(slot.reason || '-')}</td>
      </tr>`).join('')}</tbody></table></div>
    </details>` : ''}`;
}

async function loadDailyMomentsStatus() {
  const box = $('#daily-moments-status');
  if (!box) return;
  try {
    const status = await api('/api/daily-moments/status');
    const records = Array.isArray(status.records) ? status.records : [];
    const latest = records.find((record) => record.id === state.currentMomentId) || status.latest;
    const alreadyPublishedThatDay = records.some((record) =>
      record.id !== latest?.id
      && record.dayKey === latest?.dayKey
      && (record.publicationSource === 'manual' || !['scheduled', 'startup-catchup'].includes(record.source)
        || ['publishing', 'publish-unknown'].includes(record.status))
      && ['publishing', 'published', 'publish-unknown'].includes(record.status));
    for (const button of $$('#daily-moments-preview-btn,#daily-moments-run-btn')) button.disabled = status.running;
    const publishable = latest?.status === 'preview' && latest.decision === 'publish' && latest.content;
    // 待核对记录可能与"当前选中"不是同一条（阻断期间手动生成过预览草稿就会这样）：
    // 按钮必须跟着未决记录走，否则入口藏在旧记录里、面板上看不到，阻断却仍在。
    const unresolvedRecord = records.find((record) => record.status === 'publish-unknown');
    const blockingRecord = records.find((record) => ['publishing', 'publish-unknown'].includes(record.status));
    box.innerHTML = `
      <div class="field-row">
        <div class="field"><label>任务状态</label><div>${status.running ? '运行中' : (status.enabled ? '等待中' : '已关闭')}</div></div>
        <div class="field"><label>下次执行</label><div>${status.nextRunAt ? esc(fmtTime(status.nextRunAt)) : '-'}</div></div>
        <div class="field"><label>当前记录</label><div>${latest ? esc(`${latest.dayKey} · ${momentStatusLabel(latest)}`) : '-'}</div></div>
      </div>
      ${renderMomentSchedule(status)}
      ${blockingRecord && blockingRecord.id !== latest?.id ? `<div class="hint">有一条「${esc(momentStatusLabel(blockingRecord))}」的记录（${esc(blockingRecord.dayKey || '-')}）正在挡住所有时段的发布；下面的人工确认/核对按钮针对这条记录。</div>` : ''}
      ${latest?.content ? `<div class="field"><label>正文</label><div class="daily-moments-content">${esc(latest.content)}</div></div>` : ''}
      ${latest?.reason ? `<div class="field"><label>决定理由</label><div>${esc(latest.reason)}</div></div>` : ''}
      ${latest?.error ? `<div class="moment-error" role="alert">${esc(latest.error)}</div>` : ''}
      ${latest?.tid ? `<div class="field"><label>说说 ID</label><code>${esc(latest.tid)}</code></div>` : ''}
      ${latest?.imageErrors?.length ? `<div class="moment-error">${latest.imageErrors.map(esc).join('<br>')}</div>` : ''}
      <div class="settings-actions">
        ${publishable ? `<button type="button" class="btn btn-primary btn-small" id="moment-publish-draft" ${status.running ? 'disabled' : ''}>发布这份草稿</button>` : ''}
        ${unresolvedRecord ? `<button type="button" class="btn btn-small" id="moment-reconcile" ${status.running ? 'disabled' : ''}>核对空间发布结果</button>
        <button type="button" class="btn btn-small" id="moment-resolve-missed" ${status.running ? 'disabled' : ''}>人工确认未发出</button>
        <button type="button" class="btn btn-small" id="moment-resolve-sent" ${status.running ? 'disabled' : ''}>人工确认已发出</button>` : ''}
      </div>
      ${latest?.groupSummaries?.length ? `<details class="moment-summaries"><summary>内部群摘要（${latest.groupSummaries.length}）</summary>
        ${latest.groupSummaries.map((group) => `<div class="field"><label>${esc(group.groupName || group.chatKey)}</label><div>${esc(group.summary)}</div></div>`).join('')}
      </details>` : ''}
      ${records.length ? `<div class="table-wrap"><table class="usage-table">
        <thead><tr><th>日期</th><th>来源</th><th>状态</th><th>群数</th><th>配图</th><th>时间</th><th></th></tr></thead>
        <tbody>${records.slice(0, 7).map((record) => `<tr>
          <td>${esc(record.dayKey || '-')}</td>
          <td>${record.publicationSource !== 'manual' && ['scheduled', 'startup-catchup'].includes(record.source) ? '定时' : '手动'}</td>
          <td>${esc(momentStatusLabel(record))}</td>
          <td>${Number(record.groupCount) || 0}</td>
          <td>${Number(record.imageCount) || 0}</td>
          <td>${record.endedAt || record.startedAt ? esc(fmtTime(record.endedAt || record.startedAt)) : '-'}</td>
          <td><button type="button" class="btn btn-small" data-moment-select="${esc(record.id)}">查看</button></td>
        </tr>`).join('')}</tbody>
      </table></div>` : ''}`;
    $$('[data-moment-select]', box).forEach((button) => button.addEventListener('click', () => {
      state.currentMomentId = button.dataset.momentSelect;
      loadDailyMomentsStatus();
    }));
    const recordAction = async (action, targetId) => {
      if (action === 'publish') {
        const visibility = $('#cfg-moments-visibility')?.selectedOptions?.[0]?.textContent || '当前可见范围';
        const duplicateWarning = alreadyPublishedThatDay
          ? '\n\n今天已有发布记录；继续会再发布一条动态。'
          : '';
        if (!await askForConfirmation(`确认发布这份草稿？（${visibility}）${duplicateWarning}\n\n${String(latest.content).slice(0, 180)}`)) return;
      }
      const hint = $('#daily-moments-action-result');
      const buttons = $$('#daily-moments-preview-btn,#daily-moments-run-btn,#moment-publish-draft,#moment-reconcile,#moment-resolve-missed,#moment-resolve-sent');
      buttons.forEach((button) => { button.disabled = true; });
      if (hint) hint.textContent = action === 'publish' ? '发布中…' : '核对中…';
      try {
        if (action === 'publish') await saveConfig({ quiet: true });
        const result = await api(`/api/daily-moments/records/${targetId || latest.id}/${action}`, {
          method: 'POST',
          body: JSON.stringify({
            confirm: action === 'publish',
            force: action === 'publish',
            confirmDuplicateRisk: action === 'publish'
          })
        });
        state.currentMomentId = result.record?.id || targetId || latest.id;
        if (hint) hint.textContent = result.matched === false
          ? '近期列表未找到，仍需人工核对；未重发'
          : `${result.alreadyAttempted ? '未重复发布：' : ''}${momentStatusLabel(result.record)}`;
      } catch (error) {
        if (hint) hint.textContent = error.message;
      } finally {
        buttons.forEach((button) => { button.disabled = false; });
        await loadDailyMomentsStatus();
      }
    };
    $('#moment-publish-draft')?.addEventListener('click', () => recordAction('publish'));
    $('#moment-reconcile')?.addEventListener('click', () => recordAction('reconcile', unresolvedRecord?.id));
    // 自动核对（reconcile）在空间里找不到那条说说时，记录会一直停在待核对并挡住所有
    // 时段的发布；这两个按钮是人工终局：确认未发出（解除阻断）或确认已发出（保持阻断）。
    const resolveAction = async (result, targetId) => {
      const warning = result === 'missed'
        ? '确认这条说说【没有发出去】？确认后解除待核对状态，当天可以重新发布；若它实际已发出，可能造成重复发布。'
        : '确认这条说说【已经发出】？确认后按已发布处理，不会再为这条重发。';
      if (!await askForConfirmation(warning)) return;
      const hint = $('#daily-moments-action-result');
      const buttons = $$('#daily-moments-preview-btn,#daily-moments-run-btn,#moment-publish-draft,#moment-reconcile,#moment-resolve-missed,#moment-resolve-sent');
      buttons.forEach((button) => { button.disabled = true; });
      if (hint) hint.textContent = '记录人工核对结果…';
      try {
        const res = await api(`/api/daily-moments/records/${targetId || latest.id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ confirm: true, result })
        });
        if (hint) hint.textContent = `已记录：${momentStatusLabel(res.record)}`;
      } catch (error) {
        if (hint) hint.textContent = `人工核对失败：${error.message}`;
      } finally {
        buttons.forEach((button) => { button.disabled = false; });
        await loadDailyMomentsStatus();
      }
    };
    $('#moment-resolve-missed')?.addEventListener('click', () => resolveAction('missed', unresolvedRecord?.id));
    $('#moment-resolve-sent')?.addEventListener('click', () => resolveAction('sent', unresolvedRecord?.id));
  } catch (error) {
    box.innerHTML = `<span class="muted">状态读取失败：${esc(error.message)}</span>`;
  }
}

const QZONE_RUN_LABELS = {
  running: '运行中',
  baseline: '已建立初始基线',
  idle: '没有新内容',
  done: '已完成',
  'partial-unknown': '部分结果待核对',
  'partial-feed-error': '好友动态未取到',
  failed: '执行失败',
  interrupted: '执行中断',
  deferred: '等待活跃时间'
};

const QZONE_ACTION_LABELS = {
  like: '点赞',
  comment: '评论',
  reply: '回复'
};

function renderQzoneRunDetails(record) {
  const details = Array.isArray(record.details) ? record.details : [];
  if (!details.length) return '';
  return `<tr class="qzone-run-detail-row"><td colspan="7">
    <div class="qzone-run-details">${details.map((detail) => {
      const post = detail.post || {};
      const operations = (detail.operations || [])
        .map((operation) => QZONE_ACTION_LABELS[operation.type] || operation.type)
        .join('、');
      return `<div class="qzone-run-detail">
        <strong>对应动态 · ${esc(post.author || '好友')}</strong>
        <div>${esc(post.content || '（无正文）')}</div>
        ${detail.comment ? `<small>收到 ${esc(detail.comment.author || '好友')}：${esc(detail.comment.content || '')}</small>` : ''}
        ${detail.response ? `<small>${detail.kind === 'reply' ? '回复' : '评论'}：${esc(detail.response)}</small>` : ''}
        <small>操作：${esc(operations || detail.decision || '-')} · ${esc(detail.reason || '未记录理由')}</small>
      </div>`;
    }).join('')}</div>
  </td></tr>`;
}

function renderQzoneInteractionSection(c) {
  const q = c.qzoneInteractions || {};
  return `
    <h3 id="settings-qzone-interactions">动态互动</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-qzi-enabled" ${q.enabled === true ? 'checked' : ''} />
      <label for="cfg-qzi-enabled">启用好友动态阅览、点赞评论与评论回复</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-qzi-catchup" ${q.startupCatchup === true ? 'checked' : ''} />
      <label for="cfg-qzi-catchup">首次启用时处理已有内容</label></div>
    <div class="field-row">
      <div class="field"><label>好友动态检查间隔（分钟）</label><input type="number" id="cfg-qzi-feed-interval" min="5" max="1440" value="${esc(q.feedIntervalMinutes ?? 60)}" /></div>
      <div class="field"><label>评论回复检查间隔（分钟）</label><input type="number" id="cfg-qzi-reply-interval" min="1" max="1440" value="${esc(q.replyIntervalMinutes ?? 5)}" /></div>
      <div class="field"><label>只处理最近（小时）</label><input type="number" id="cfg-qzi-max-age" min="1" max="720" value="${esc(q.maxAgeHours ?? 72)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每次抓取动态数</label><input type="number" id="cfg-qzi-feed-count" min="1" max="50" value="${esc(q.feedFetchCount ?? 30)}" /></div>
      <div class="field"><label>检查自己的动态数</label><input type="number" id="cfg-qzi-own-count" min="1" max="30" value="${esc(q.ownPostCount ?? 10)}" /></div>
      <div class="field"><label>单批最多提交条目</label><input type="number" id="cfg-qzi-batch-items" min="1" max="50" value="${esc(q.maxBatchItems ?? 20)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-qzi-likes" ${q.allowLikes !== false ? 'checked' : ''} />
      <label for="cfg-qzi-likes">允许自主点赞</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-qzi-comments" ${q.allowComments !== false ? 'checked' : ''} />
      <label for="cfg-qzi-comments">允许自主评论好友动态</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-qzi-replies" ${q.allowReplies !== false ? 'checked' : ''} />
      <label for="cfg-qzi-replies">允许自主回复动态评论</label></div>
    <div class="field-row">
      <div class="field"><label>每轮最多点赞</label><input type="number" id="cfg-qzi-max-likes" min="0" max="20" value="${esc(q.maxLikesPerRun ?? 3)}" /></div>
      <div class="field"><label>每轮最多评论</label><input type="number" id="cfg-qzi-max-comments" min="0" max="10" value="${esc(q.maxCommentsPerRun ?? 2)}" /></div>
      <div class="field"><label>每轮最多回复</label><input type="number" id="cfg-qzi-max-replies" min="0" max="20" value="${esc(q.maxRepliesPerRun ?? 5)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>评论最长字符</label><input type="number" id="cfg-qzi-comment-chars" min="5" max="200" value="${esc(q.commentMaxChars ?? 60)}" /></div>
      <div class="field"><label>回复最长字符</label><input type="number" id="cfg-qzi-reply-chars" min="5" max="200" value="${esc(q.replyMaxChars ?? 60)}" /></div>
      <div class="field"><label>写操作随机间隔（毫秒）</label>
        <div style="display:flex;gap:8px">
          <input type="number" id="cfg-qzi-delay-min" min="0" max="10000" step="100" value="${esc(q.actionDelayMinMs ?? 700)}" />
          <input type="number" id="cfg-qzi-delay-max" min="0" max="15000" step="100" value="${esc(q.actionDelayMaxMs ?? 1800)}" />
        </div></div>
    </div>
    <div class="settings-actions">
      <button class="btn btn-primary btn-small" id="qzi-run-feed-btn">立即阅览好友动态</button>
      <button class="btn btn-small" id="qzi-run-reply-btn">立即检查评论回复</button>
      <span id="qzi-action-result" class="muted"></span>
    </div>
    <div id="qzone-interactions-status" class="daily-moments-status"><span class="muted">正在读取状态…</span></div>`;
}

async function loadQzoneInteractionStatus() {
  const box = $('#qzone-interactions-status');
  if (!box) return;
  try {
    const status = await api('/api/qzone-interactions/status');
    const records = Array.isArray(status.records) ? status.records : [];
    const latest = records[0];
    // 好友动态抓取失败不再让整轮失败：原因记在 feedError 上，这里照样把它显示出来
    const runAlert = latest?.error || (latest?.feedError ? `好友动态未取到：${latest.feedError}` : '');
    for (const button of $$('#qzi-run-feed-btn,#qzi-run-reply-btn')) {
      button.disabled = status.running;
    }
    box.innerHTML = `
      <div class="field-row">
        <div class="field"><label>任务状态</label><div>${status.running ? '运行中' : (status.enabled ? '等待中' : '已关闭')}</div></div>
        <div class="field"><label>下次检查</label><div>${status.nextRunAt ? esc(fmtTime(status.nextRunAt)) : '-'}</div></div>
        <div class="field"><label>未阅览动态</label><div>${Number(status.unreadFeeds) || 0}</div></div>
        <div class="field"><label>待决定回复</label><div>${Number(status.unreadReplies) || 0}</div></div>
        <div class="field"><label>结果待核对</label><div>${Number(status.uncertain) || 0}</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label>上次好友动态检查</label><div>${status.lastFeedPollAt ? esc(fmtTime(status.lastFeedPollAt)) : '-'}</div></div>
        <div class="field"><label>上次评论检查</label><div>${status.lastReplyPollAt ? esc(fmtTime(status.lastReplyPollAt)) : '-'}</div></div>
      </div>
      ${runAlert ? `<div class="moment-error" role="alert">${esc(runAlert)}</div>` : ''}
      ${records.length ? `<div class="table-wrap"><table class="usage-table">
        <thead><tr><th>时间</th><th>类型</th><th>状态</th><th>动态</th><th>回复</th><th>写操作</th><th>延后</th></tr></thead>
        <tbody>${records.slice(0, 10).map((record) => `
          <tr>
            <td>${record.startedAt ? esc(fmtTime(record.startedAt)) : '-'}</td>
            <td>${esc(record.kind || '-')}</td>
            <td>${esc(QZONE_RUN_LABELS[record.status] || record.status || '-')}</td>
            <td>${Number(record.selectedFeeds) || 0}</td>
            <td>${Number(record.selectedReplies) || 0}</td>
            <td>${Array.isArray(record.actions) ? record.actions.length : 0}</td>
            <td>${(Number(record.deferredFeeds) || 0) + (Number(record.deferredReplies) || 0)}</td>
          </tr>
          ${renderQzoneRunDetails(record)}`).join('')}</tbody>
      </table></div>` : ''}`;
  } catch (error) {
    box.innerHTML = `<span class="muted">状态读取失败：${esc(error.message)}</span>`;
  }
}

function renderPersonaSection(c) {
  const roleText = c.persona.roleText || '';
  refreshPersonaFold(roleText);
  // 整个设置页会重画 DOM：正文视图与卡库都要按当前状态（折叠/编辑中）画一次，
  // 并把指纹清空，交给随后的 syncPersonaButtons 校一遍。
  personaViewKey = null;
  personaGridKey = null;
  return `
    <h3>人设</h3>
    ${renderPersonaLibrary(c)}
    <div class="persona-detail">
      <div class="pd-head">
        <span class="pd-title" id="persona-view-title"></span>
        <span class="chip" id="persona-view-profile"></span>
        <span class="chip" id="persona-view-binding"></span>
        <span class="spacer"></span>
        <button class="btn btn-small hidden" id="restore-persona-btn">恢复整张卡</button>
        <button class="btn btn-small" id="toggle-persona-edit">编辑全文</button>
      </div>
      <div class="pd-body" id="persona-card-view">${renderPersonaCardBody(roleText)}</div>
    </div>
    <div class="hint" id="persona-edit-note"></div>
    <div class="field hidden" id="persona-raw-field">
      <label>角色设定（原文）</label>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(roleText)}</textarea>
      <div class="hint">上面那屏是这份原文的读法，保存的也是这份原文。平时逐节改就够了（每节右上角有「编辑」「恢复本节」）；
        这里改一个字也会<strong>解除与内置卡的绑定</strong>（正文归你自己管），想重新跟随卡文件，回上面的卡库里点一下那张卡。</div>
    </div>
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>交流策略</label>
        <select id="cfg-behavior-profile">
          <option value="legacy" ${c.persona.behaviorProfile !== 'grounded' ? 'selected' : ''}>原版群友</option>
          <option value="grounded" ${c.persona.behaviorProfile === 'grounded' ? 'selected' : ''}>自然可靠</option>
        </select></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div class="hint">交流策略：「原版群友」那套允许装傻、随口应付、不有求必应；「自然可靠」不装傻、说话有据。嫌它冲或想让它听话，选后者。角色设定里写了相反的脾气时，以角色设定为准（它优先级更高）；参与度（安静/普通/活跃）不受角色设定影响。</div>
    <div class="field"><label>管理员附加规则（可选；排在所有平台规则之后 —— 想压过默认风格就写这里）</label>
      <div class="pd-tags" id="persona-rule-chips">
        ${PERSONA_RULE_EXAMPLES.map((rule) => `<button type="button" class="pd-tag rule-chip" data-rule="${esc(rule)}">＋ ${esc(rule)}</button>`).join('')}
      </div>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px" placeholder="例如：别装傻、别反问，不接话就安静；称呼固定用「老板」；被怼只淡淡带过">${esc(c.persona.customRules || '')}</textarea>
      <div class="hint">冲突时优先级：安全规则 &gt; 这里 &gt; 角色设定 &gt; 平台默认风格。角色的口吻/称呼/脾气写在「角色设定」里就行，这里的硬要求会盖过平台默认风格。上面几个例子点一下就加进去，可以再改。</div></div>
    <div class="hint">改完记得点页面最下面那条<strong>「保存设置」</strong>（一直悬在底部）——它保存的就是这一页的人设。</div>`;
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <label for="cfg-allowallwhenempty">白名单留空时允许所有会话</label></div>
    <div class="hint">说明：勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。</div>`;
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return String(chatKey || '');
}

function conversationModeForChat(chatKey, cfg = state.config) {
  const conversation = cfg?.conversation || {};
  if (conversation.unifiedMode !== false) return conversation.mode || 'legacy';
  const match = /^group:(\d+)$/.exec(String(chatKey || ''));
  return match && conversation.groupModes?.[match[1]]
    ? conversation.groupModes[match[1]]
    : (conversation.mode || 'legacy');
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * ⚠️ 必须与 src/core/tier-slider.js 保持完全一致 —— 后端保存配置时会用它
 *    **重新权威换算**档位与概率，所以前端即使算错也不会影响实际行为；
 *    但两边不一致会让"界面显示的档位"和"实际生效的档位"对不上，造成困惑。
 *    ui/app.js 是普通 script（非 ES module），无法 import，只能镜像一份。
 */
/** 概率取值（与后端 tier-slider.js 的 clampProbability 同一套规则）。 */
function clampProbabilityUI(value, fallback = 100) {
  // 与后端一致：先判"有没有值"，Number(null)/Number('') 都是 0，不能拿来当概率
  const missing = value === undefined || value === null || String(value).trim() === '';
  const n = missing ? NaN : Number(value);
  if (!Number.isFinite(n)) return Math.min(100, Math.max(0, Number(fallback) || 0));
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/** 滑条值 = 概率；tier 只用来选读多少条与展示触发方式。 */
function sliderToTierUI(pos) {
  const probability = clampProbabilityUI(pos, 100);
  return {
    tier: probability <= 0 ? 1 : (probability >= 100 ? 4 : 3),
    randomPercent: probability
  };
}

/** 老四段式滑条位置 → 概率（与后端 legacySliderToProbability 同一套规则）。 */
function legacySliderToProbabilityUI(pos) {
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return 100;
  const p = Math.min(100, Math.max(0, raw));
  if (p <= 20) return 0;
  if (p >= 90) return 100;
  return Math.round(((p - 20) / 70) * 1000) / 10;
}

/**
 * 已保存配置 → 滑条位置。存的就是概率；
 * 老配置（四段式，没打 sliderMode 标记）要先按老口径换算 ——
 * 否则界面会把"老 1 档的位置 5"当成"5% 概率"显示并回写，用户一保存就被悄悄改掉。
 */
function sliderToTierUI_tierToSlider(st) {
  const rawPos = st?.contextSliderPos;
  // ⚠️ 不能用 Number(rawPos) 判有没有值：Number(null) === 0，会把"没设位置"当成"位置 0"
  const hasPos = rawPos !== undefined && rawPos !== null && String(rawPos).trim() !== '';
  const legacyMode = String(st?.sliderMode || '') !== 'probability';
  if (hasPos) {
    return legacyMode ? legacySliderToProbabilityUI(rawPos) : clampProbabilityUI(rawPos);
  }
  const t = Math.min(4, Math.max(1, Number(st?.contextTier) || 4));
  if (t >= 4) return 100;
  if (t <= 2) return 0;
  return clampProbabilityUI(st?.randomPercent, 0);
}

/** 分群表：老配置的值也要换算成概率（界面上显示的与保存的都按新语义）。 */
function groupSliderPosForUi(st) {
  const map = st?.groupSliderPos || {};
  if (String(st?.sliderMode || '') === 'probability') return map;
  const out = {};
  for (const [groupId, pos] of Object.entries(map)) out[groupId] = legacySliderToProbabilityUI(pos);
  return out;
}

/** 概率落在刻度条的哪一段（只影响高亮）。 */
function segOfProbability(value) {
  const p = clampProbabilityUI(value);
  if (p <= 0) return 1;
  if (p >= 100) return 4;
  return p < 50 ? 2 : 3;
}

/** 四个"读取条数"参数里哪些现在用得上：被 @ / 关键词那两条始终算数。 */
function paramActiveForProbability(value) {
  const p = clampProbabilityUI(value);
  return { at: true, keyword: true, random: p > 0 && p < 100, all: p >= 100 };
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const p = clampProbabilityUI(pos);
  let main;
  if (p <= 0) main = '<b>0%</b>：普通消息不回（标记已读、不调模型）；<b>被 @ 或命中关键词一定回</b>';
  else if (p >= 100) main = '<b>100% · 全响应</b>：任何消息都回';
  else main = `普通消息 <b>${p}%</b> 概率回（大约每 100 批接 ${p} 批）；<b>被 @ 或命中关键词一定回</b>`;
  // 档位管的是"它没在跟人对话时，要不要接这句话"。下面两条路不受档位限制，
  // 不写清楚就会被当成"档位调了没生效"。
  return main
    + '<br><span class="muted">档位只管群聊里"要不要搭话"：私聊被直接找时总会回；'
    + '对话模式是「参与者续接 / 完整生命周期」时，刚跟你说过话的人在活跃窗口内的消息也直接回（这两条不看概率）。</span>';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

function renderConversationModePanels(conversation = {}) {
  const activeMode = ['legacy', 'threaded', 'lifecycle'].includes(conversation.mode)
    ? conversation.mode
    : 'legacy';
  const modes = [
    ['legacy', '传统触发', '按规则启动'],
    ['threaded', '参与者续接', '短窗口延续'],
    ['lifecycle', '完整生命周期', '持续批次判断']
  ];
  const panelAttrs = (mode) =>
    `class="conversation-mode-panel${activeMode === mode ? '' : ' hidden'} mode-${mode}" `
    + `data-conversation-panel="${mode}" aria-hidden="${activeMode === mode ? 'false' : 'true'}"`;

  return `
    <div class="conversation-mode-shell mode-${activeMode}" id="conversation-mode-shell" data-mode="${activeMode}">
      <div class="conversation-mode-switch" role="tablist" aria-label="默认对话模式">
        ${modes.map(([mode, label, subtitle]) => `
          <button type="button"
            class="conversation-mode-option mode-${mode}${activeMode === mode ? ' active' : ''}"
            data-conversation-mode="${mode}" role="tab"
            aria-selected="${activeMode === mode ? 'true' : 'false'}">
            <span>${label}</span>
            <small>${subtitle}</small>
          </button>`).join('')}
      </div>
      <input type="hidden" id="cfg-conversation-mode" value="${activeMode}" />

      <div class="conversation-mode-stage">
        <section ${panelAttrs('legacy')}>
          <div class="conversation-mode-heading">
            <div>
              <strong>传统触发</strong>
              <span>每个消息批次独立判断</span>
            </div>
            <span class="mode-state-token">无持续线程</span>
          </div>
          <div class="conversation-mode-flow" aria-label="传统触发流程">
            <span>响应档位</span><i></i><span>单次运行</span><i></i><span>结束</span>
          </div>
          <dl class="conversation-mode-facts">
            <div><dt>启动条件</dt><dd>@ / 关键词 / 概率</dd></div>
            <div><dt>后续消息</dt><dd>重新判断触发条件</dd></div>
            <div><dt>上下文</dt><dd>按档位读取消息</dd></div>
          </dl>
        </section>

        <section ${panelAttrs('threaded')}>
          <div class="conversation-mode-heading">
            <div>
              <strong>参与者续接</strong>
              <span>机器人发言后为当前参与者保留续接窗口</span>
            </div>
            <span class="mode-state-token">参与者限定</span>
          </div>
          <div class="conversation-mode-flow" aria-label="参与者续接流程">
            <span>首次触发</span><i></i><span>参与者续接</span><i></i><span>线程过期</span>
          </div>
          <div class="field-row conversation-mode-fields">
            <div class="field"><label>确定性续接窗口（秒）</label><input type="number" id="cfg-cont-window" min="10" max="1800" value="${esc(Math.round((conversation.continuationWindowMs ?? 180000) / 1000))}" /></div>
            <div class="field"><label>线程空闲过期（分钟）</label><input type="number" id="cfg-thread-ttl" min="5" max="1440" value="${esc(Math.round((conversation.threadTtlMs ?? 1800000) / 60000))}" /></div>
            <div class="field"><label>续接读取历史条数</label><input type="number" id="cfg-cont-history" min="1" max="500" value="${esc(conversation.continuationContextCount ?? 100)}" /></div>
          </div>
        </section>

        <section ${panelAttrs('lifecycle')}>
          <div class="conversation-mode-heading">
            <div>
              <strong>完整生命周期</strong>
              <span>生命周期内每批消息都进入模型判断</span>
            </div>
            <span class="mode-state-token">持久化线程</span>
          </div>
          <div class="conversation-mode-flow" aria-label="完整生命周期流程">
            <span>监听</span><i></i><span>活跃</span><i></i><span>硬上限</span><i></i><span>待续接</span>
          </div>
          <div class="field-row conversation-mode-fields">
            <div class="field"><label>监听空闲结束（分钟）</label><input type="number" id="cfg-life-silent" min="1" max="60" value="${esc(Math.round((conversation.silentIdleMs ?? 300000) / 60000))}" /></div>
            <div class="field"><label>活跃空闲结束（分钟）</label><input type="number" id="cfg-life-active" min="1" max="120" value="${esc(Math.round((conversation.activeIdleMs ?? 1200000) / 60000))}" /></div>
            <div class="field"><label>生命周期硬上限（分钟）</label><input type="number" id="cfg-life-hard" min="5" max="240" value="${esc(Math.round((conversation.hardLifetimeMs ?? 1800000) / 60000))}" /></div>
          </div>
          <div class="field-row conversation-mode-fields">
            <div class="field"><label>硬上限后待续接（分钟）</label><input type="number" id="cfg-life-rollover" min="1" max="60" value="${esc(Math.round((conversation.rolloverArmedMs ?? 600000) / 60000))}" /></div>
            <div class="field"><label>首次读取历史条数</label><input type="number" id="cfg-life-history" min="1" max="500" value="${esc(conversation.lifecycleContextCount ?? 100)}" /></div>
            <div class="field"><label>换代输入上限（Token）</label><input type="number" id="cfg-life-tokens" min="5000" max="500000" step="1000" value="${esc(conversation.lifecycleRolloverInputTokens ?? 32000)}" /></div>
            <div class="field"><label>追加上下文兜底（字符）</label><input type="number" id="cfg-life-chars" min="20000" max="1000000" step="10000" value="${esc(conversation.maxTranscriptChars ?? 240000)}" /></div>
          </div>
        </section>
      </div>
    </div>`;
}

function renderChatSection(c) {
  const st = c.store || {};
  const conversation = c.conversation || {};
  // 滑条位置是唯一真相，而且**滑条上的数字就是概率**（与后端 tier-slider.js 同一套规则）
  const sliderPos = sliderToTierUI_tierToSlider(st);
  const { randomPercent: curPct } = sliderToTierUI(sliderPos);
  // 刻度高亮与参数高亮都按"当前概率落在哪一段"来点
  const curSeg = segOfProbability(curPct);
  const paramOn = paramActiveForProbability(curPct);
return `
    <h3>对话模式</h3>
    ${renderConversationModePanels(conversation)}

    <div class="conversation-scope">
      <div class="conversation-scope-heading">
        <strong>应用范围</strong>
        <span>模式参数按类型共用，群聊只选择使用哪一种模式</span>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-conversation-unified" ${conversation.unifiedMode !== false ? 'checked' : ''} />
        <label for="cfg-conversation-unified">所有群聊统一使用默认模式</label></div>
      <div id="conversation-pergroup-wrap"${conversation.unifiedMode === false ? '' : ' style="display:none"'}>
        <div class="field-row">
          <div class="field"><label>选择群聊</label><select id="conversation-group-select"></select></div>
          <div class="field"><label>该群模式</label>
            <select id="conversation-group-mode">
              <option value="legacy">传统触发</option>
              <option value="threaded">参与者续接</option>
              <option value="lifecycle">完整生命周期</option>
            </select>
          </div>
        </div>
        <input type="hidden" id="conversation-group-json" value="${esc(JSON.stringify(conversation.groupModes || {}))}" />
        <div class="conversation-scope-actions">
          <button class="btn btn-small btn-danger" id="conversation-group-clear-btn">清除该群覆盖</button>
          <span class="hint">未覆盖的群聊与私聊跟随默认模式。</span>
        </div>
      </div>
    </div>

    <h3>所有模式 · 运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>未思考等待最短值（毫秒）</label><input type="number" id="cfg-wakedelay-min" min="0" max="20000" value="${esc(c.wakeDelayMinMs ?? c.wakeDelayMs ?? 8000)}" /></div>
      <div class="field"><label>未思考等待最长值（毫秒）</label><input type="number" id="cfg-wakedelay-max" min="0" max="20000" value="${esc(c.wakeDelayMaxMs ?? c.wakeDelayMs ?? 12000)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>

    <h3>所有模式 · 发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每小时最多发送</label><input type="number" id="cfg-maxperhour" min="1" value="${esc(c.send.maxPerHour ?? 500)}" /></div>
      <div class="field"><label>按字数附加间隔（毫秒/字）</label><input type="number" id="cfg-bylength" min="0" value="${esc(c.send.byLengthMs ?? 20)}" /></div>
      <div class="field"><label>QQ 硬限制切分长度（0 = 不切）</label><input type="number" id="cfg-hardsplit" min="0" value="${esc(c.send.hardSplitAt ?? 4000)}" /></div>
    </div>

    <h3>所有模式 · 主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div class="field-row">
      <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
      <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pro-followup" ${c.proactive?.followUpEnabled !== false ? 'checked' : ''} />
      <label for="cfg-pro-followup">说完话没人接，过十来分钟补一句（"？"/"人呢"）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pro-selfwake" ${c.proactive?.selfWakeEnabled !== false ? 'checked' : ''} />
      <label for="cfg-pro-selfwake">允许模型给自己安排稍后的主动发言</label></div>
    <div class="hint">
      这三项互不影响：只取消第一条，机器人仍可能在说完话没人接时补一句、也可能按自己安排的时机开口；
      完全不想让它主动开口就把三个都取消。后两项在较早版本里一直生效，本版起可以在控制台关掉。
    </div>

    <h3>所有模式 · 表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <div class="field">
      <label>发表情包的积极程度</label>
      <select id="cfg-sticker-encourage">
        ${STICKER_LEVELS.map(([v, label], i) =>
          `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
        ).join('')}
      </select>
      <div class="hint">
        这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
      </div>
    </div>

    <div class="field">
      <label>系统提示里的表情清单条数</label>
      <input type="number" id="cfg-sticker-max" min="1" max="60" value="${esc(c.sticker?.promptMaxStickers ?? 10)}" />
      <div class="hint">
        清单一半放常用的，一半放没用过/很久没用的，发掉一张自动换下一张上来（不会再总是那几张）。
        调大能选的范围更宽，代价是每轮提示词变长；省 Token 模式还会再夹到 3~5 条。库容量不受这一项影响。
      </div>
    </div>

    <h3>首次唤醒与历史</h3>
    <div class="hint conversation-trigger-hint" id="conversation-trigger-hint"></div>

    <div class="checkbox-row"><input type="checkbox" id="cfg-unifiedtier" ${st.unifiedTier !== false ? 'checked' : ''} />
      <label for="cfg-unifiedtier">统一设置响应概率（关掉就能给每个白名单群聊单独拖）</label></div>

    <!-- 统一模式：一个滑条管所有会话（原行为） -->
    <div id="tier-unified-wrap"${st.unifiedTier === false ? ' style="display:none"' : ''}>
    <div class="tier-slider-wrap">
      <input type="range" id="ctx-tier-slider" class="tier-slider"
             min="0" max="100" step="0.5" value="${esc(sliderPos)}"
             aria-label="响应概率滑条" />
      <div class="tier-scale" id="tier-scale">
        <span class="tier-seg seg1${curSeg === 1 ? ' on' : ''}" data-seg="1" style="flex:12">0% · 只回 @/关键词</span>
        <span class="tier-seg seg2${curSeg === 2 ? ' on' : ''}" data-seg="2" style="flex:30">约 33%</span>
        <span class="tier-seg seg3${curSeg === 3 ? ' on' : ''}" data-seg="3" style="flex:30">约 66%</span>
        <span class="tier-seg seg4${curSeg === 4 ? ' on' : ''}" data-seg="4" style="flex:28">100% · 全响应</span>
      </div>
    </div>

    <div class="hint" id="ctx-tier-note" style="margin-top:8px">${sliderDesc(sliderPos)}</div>
    </div>

    <!-- 分群模式：下拉选群，各拖各的。滑条实时值是 DOM，切换群时先收进隐藏 JSON 再换 -->
    <div id="tier-pergroup-wrap"${st.unifiedTier === false ? '' : ' style="display:none"'}>
      <div class="field"><label>选择要单独设置的群聊（来自白名单）</label>
        <select id="tier-group-select"></select>
      </div>
      <input type="hidden" id="tier-group-json" value="${esc(JSON.stringify(groupSliderPosForUi(st)))}" />
      <div class="tier-slider-wrap">
        <input type="range" id="ctx-tier-slider-g" class="tier-slider"
               min="0" max="100" step="0.5" value="${esc(sliderPos)}"
               aria-label="该群响应概率滑条" />
        <div class="tier-scale" id="tier-scale-g">
          <span class="tier-seg seg1" data-seg="1" style="flex:12">0% · 只回 @/关键词</span>
          <span class="tier-seg seg2" data-seg="2" style="flex:30">约 33%</span>
          <span class="tier-seg seg3" data-seg="3" style="flex:30">约 66%</span>
          <span class="tier-seg seg4" data-seg="4" style="flex:28">100% · 全响应</span>
        </div>
      </div>
      <div class="hint" id="ctx-tier-note-g" style="margin-top:8px"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-small btn-danger" id="tier-group-clear-btn">清除该群的单独设置</button>
        <span class="hint" style="margin:0">没单独设置过的群聊和所有私聊，跟随上方统一滑条的概率。</span>
      </div>
    </div>

    <div class="tier-params">
      <div class="tier-param${paramOn.at ? '' : ' dim'}">
        <label>① 被艾特时：发未读 + <input type="number" id="cfg-atcount" min="0" max="500" value="${esc(st.atCount ?? 20)}" /> 条已读</label>
        <div class="hint">有人 @ 机器人时<b>一定响应</b>，不受上面概率的影响。</div>
      </div>
      <div class="tier-param${paramOn.keyword ? '' : ' dim'}">
        <label>② 命中关键词时：发未读 + <input type="number" id="cfg-kwcount" min="0" max="500" value="${esc(st.keywordCount ?? 15)}" /> 条已读</label>
        <div class="hint">关键词（每行一个，不区分大小写）；命中<b>一定响应</b>。留空就只回 @：</div>
        <textarea id="cfg-keywords" rows="3" placeholder="小鲸鱼&#10;bot">${esc((st.keywords || []).join('\n'))}</textarea>
      </div>
      <div class="tier-param${paramOn.random ? '' : ' dim'}">
        <label>③ 按概率响应时：发未读 + <input type="number" id="cfg-randcount" min="0" max="500" value="${esc(st.randomCount ?? 8)}" /> 条已读</label>
        <div class="hint">概率在 0 和 100 之间时，普通消息按这个概率接。</div>
      </div>
      <div class="tier-param${paramOn.all ? '' : ' dim'}">
        <label>④ 全响应时：发未读 + <input type="number" id="cfg-allcount" min="0" max="500" value="${esc(st.allCount ?? 80)}" /> 条已读</label>
        <div class="hint">滑条拖到 <b>100%</b> 时，任何消息都响应。</div>
      </div>
    </div>

    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">被屏蔽群员的消息不会存档、不会触发回复，也不会作为聊天背景发给模型。机器人自己的发言不受影响。</div>
    </div>`;
}

function renderTokenSaverSection(c) {
  const mode = ['off', 'balanced', 'aggressive'].includes(c.tokenSaver?.mode) ? c.tokenSaver.mode : 'off';
  const saver = state.status?.tokenSaver || null;
  const caps = saver?.capsByMode || {};
  // 档位条数按 被艾特/关键词/随机 三档说明（allCount 与被艾特档同值），数字全部来自服务端上限表
  const summarize = (m) => {
    const k = caps[m];
    if (!k) return '';
    return `档位读 ${k.atCount}/${k.keywordCount}/${k.randomCount} 条，轮数 ≤${k.maxRounds}、单次预算 ≤${Math.round(k.maxRunTokens / 10000)} 万 token，`
      + `交接 ≤${k.handoffMaxChars} 字符、印象 ≤${k.memoryBlockChars} 字符、表情清单 ≤${k.promptMaxStickers} 条`;
  };
  const rows = (saver?.rows || []).map((row) => `<tr>
      <td>${esc(row.label)}</td>
      <td class="muted">${esc(row.user)}</td>
      <td>${row.clamped ? `<strong>${esc(row.effective)}</strong> <span class="muted">（被夹住）</span>` : esc(row.effective)}</td>
    </tr>`).join('');
  return `
    <h3 id="settings-token-saver">省 Token</h3>
    <div class="hint" style="margin-bottom:8px">开启后只给下面这些项<b>夹上限</b>，不改写你在各分区填的值 —— 关掉立刻恢复原样。
      每次模型调用的固定底（系统提示 + 工具定义，约 1.2 万-1.5 万 token）不受此影响，
      想再省就配合「聊天设置」的响应概率与「搜索服务 / 图片输入」开关。</div>
    <label class="radio-row"><input type="radio" name="token-saver-mode" value="off" ${mode === 'off' ? 'checked' : ''} />
      <span>关闭：完全按你自己的设置</span></label>
    <label class="radio-row"><input type="radio" name="token-saver-mode" value="balanced" ${mode === 'balanced' ? 'checked' : ''} />
      <span>省：${esc(summarize('balanced') || '档位条数、轮数、预算、交接/印象、表情清单都收一档')}</span></label>
    <label class="radio-row"><input type="radio" name="token-saver-mode" value="aggressive" ${mode === 'aggressive' ? 'checked' : ''} />
      <span>很省：${esc(summarize('aggressive') || '再收一档，接话更省但读的历史更少')}</span></label>
    <div class="settings-divider"></div>
    <h3>实际生效值</h3>
    ${rows
      ? `<div class="table-wrap"><table class="usage-table"><thead><tr><th>项目</th><th>你的设置</th><th>当前生效</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="hint">正在读取生效值…（刷新页面后显示）</div>'}
    <div class="hint" style="margin-top:8px">改完点底部「保存设置」生效；效果在「用量」页按天看得到。</div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>控制台安全</h3>
    <div class="field-row">
      <div class="field"><label>当前 Token</label>
        <input type="password" id="cfg-console-token-current" autocomplete="current-password"
          placeholder="${c.server?.hasToken ? '输入当前 Token' : '当前未设置 Token'}" /></div>
      <div class="field"><label>新 Token</label>
        <input type="password" id="cfg-console-token-new" autocomplete="new-password"
          placeholder="16-128 位字母、数字或 . _ ~ -" /></div>
      <div class="field"><label>确认新 Token</label>
        <input type="password" id="cfg-console-token-confirm" autocomplete="new-password"
          placeholder="再次输入新 Token" /></div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:18px">
      <button type="button" class="btn btn-small" id="change-console-token-btn">更新控制台 Token</button>
      <span class="hint" id="console-token-result">更新后旧 Token 和其他已登录会话立即失效。</span>
    </div>
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${THEME_VALUES.map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">外部 OneBot v11 服务</h3>
    <div class="hint" style="margin-bottom:10px">协议端由 Linux 运维独立管理。本服务只连接正向 WebSocket 和 HTTP API。</div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.onebot.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.onebot.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken"
        placeholder="${c.onebot.hasAccessToken ? '已保存；留空保持不变' : '未设置'}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填）</label><input type="password" id="cfg-obhttptoken"
        placeholder="${c.onebot.hasHttpAccessToken ? '已保存；留空保持不变' : '未设置'}" /></div>
    </div>
    <div id="onebot-status-line">${onebotStatusLineHtml()}</div>
    <div class="hint">改完 OneBot 地址或令牌后，执行 <code>manage.sh restart</code> 生效（连接只在启动时建立一次，改完不重启还是旧地址）。</div>`;
}

function bindSettingsEvents(c) {
  if (state.settingsSection === 'time-control') bindTimeControlEvents();
  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    // 人设页的分节编辑框不是唯一数据源：#cfg-roletext 才是。保存前先把正在编辑的
    // 那一节落回草稿，否则"边编辑边点保存"会存下旧正文（界面还提示"已保存"）。
    if (flushPersonaSectionEdit()) {
      personaEditNote = '';
      syncPersonaButtons();
    }
    try {
      await saveConfig();
      const res = $('#cfg-save-result');
      res.textContent = '已保存 ✓';
      res.classList.remove('saved-flash');
      void res.offsetWidth;
      res.classList.add('saved-flash');
      // 保存成功后，人设页那条"还没生效"的提示就没意义了，清掉它
      if (state.settingsSection === 'persona') {
        personaEditNote = '';
        const note = $('#persona-edit-note');
        if (note) note.textContent = '';
      }
      refreshStatus().then(() => {
        // 省 Token 的"实际生效值"表按 /api/status 渲染：保存完要等状态回来再重画一次，
        // 否则切了档位、表格还显示上一档的数字（要刷新页面才对得上）。
        if (state.settingsSection !== 'token-saver') return;
        const section = state.settingsSection;
        renderSettings();
        // 重画会把上面写好的"已保存 ✓"连同节点一起换掉 —— 这里补写一次，
        // 否则在省 Token 页点保存看不到任何成功反馈（数字本来就低于上限时尤其明显）。
        if (state.settingsSection !== section) return;
        const again = $('#cfg-save-result');
        if (again) {
          again.textContent = '已保存 ✓';
          again.classList.remove('saved-flash');
          void again.offsetWidth;
          again.classList.add('saved-flash');
        }
      }).catch(() => {});
      startListPoller();   // 刷新间隔可能刚被改过，用新值重启轮询
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    }
  });

  if ((state.settingsSection || 'api') === 'experiments') {
    loadExperimentalFeatureStatuses();
    [
      ['#launch-identity-feature', 'identity'],
      ['#launch-auto-friend-feature', 'auto-friend'],
      ['#launch-slang-feature', 'slang'],
      ['#launch-incident-feature', 'incidents']
    ].forEach(([selector, feature]) => {
      $(selector)?.addEventListener('click', () =>
        launchExperimentalFeature(feature).catch(() => {}));
    });
    [
      '#cfg-identity-pilot-enabled',
      '#cfg-auto-friend-enabled',
      '#cfg-slang-pilot-enabled',
      '#cfg-incident-pilot-enabled'
    ].forEach((selector) => {
      const toggle = $(selector);
      toggle?.addEventListener('change', async () => {
        if (selector === '#cfg-auto-friend-enabled' && toggle.checked) {
          const identityToggle = $('#cfg-identity-pilot-enabled');
          if (identityToggle) identityToggle.checked = true;
        }
        if (selector === '#cfg-identity-pilot-enabled' && !toggle.checked) {
          const friendToggle = $('#cfg-auto-friend-enabled');
          if (friendToggle) friendToggle.checked = false;
        }
        if (selector === '#cfg-incident-pilot-enabled' && toggle.checked) {
          let ownerUin = String(state.config?.incidentPilot?.ownerUin || '').trim();
          const ownerAllowed = state.config?.allowAllWhenEmpty === true
            || (state.config?.allow?.private || []).map(String).includes(ownerUin);
          if (!/^\d{5,15}$/.test(ownerUin) || !ownerAllowed) {
            ownerUin = await requestExperimentOwnerUin('incidents', ownerUin);
            if (!ownerUin) {
              toggle.checked = false;
              return;
            }
            state.config.incidentPilot = {
              ...(state.config.incidentPilot || {}),
              ownerUin
            };
          }
        }
        toggle.disabled = true;
        const result = $('#experiment-launch-result');
        if (result) result.textContent = '保存中…';
        try {
          await saveConfig({ quiet: true });
          renderSettings();
        } catch (error) {
          toggle.checked = !toggle.checked;
          toggle.disabled = false;
          if (result) result.textContent = `保存失败：${error.message}`;
        }
      });
    });
  }

  if ((state.settingsSection || 'api') === 'moments') {
    loadDailyMomentsStatus();
    $('#cfg-moments-schedule-mode')?.addEventListener('change', (event) => {
      const randomMode = event.target.value === 'windows';
      $('#moment-fixed-time').hidden = randomMode;
      $('#moment-random-windows').hidden = !randomMode;
      $('#cfg-moments-catchup-label').textContent = randomMode
        ? '重启后在未结束的范围内补跑' : '服务错过固定时刻后补跑';
    });
    const syncIntervalCustom = () => {
      const wrap = $('#moment-interval-custom-wrap');
      if (wrap) wrap.hidden = $('#cfg-moments-interval')?.value !== 'custom';
    };
    $('#cfg-moments-interval')?.addEventListener('change', syncIntervalCustom);
    syncIntervalCustom();
    const refreshWindowButtons = () => {
      const rows = $$('#moment-window-rows .moment-window-row');
      $('#moment-window-add').disabled = rows.length >= 8;
      rows.forEach((row) => { row.querySelector('.moment-window-remove').disabled = rows.length <= 1; });
    };
    $('#moment-window-add')?.addEventListener('click', () => {
      $('#moment-window-rows').insertAdjacentHTML('beforeend', renderMomentWindowRow({
        start: '18:00', end: '19:00', count: 1
      }));
      refreshWindowButtons();
    });
    $('#moment-window-rows')?.addEventListener('click', (event) => {
      const button = event.target.closest('.moment-window-remove');
      if (button) {
        button.closest('.moment-window-row').remove();
        refreshWindowButtons();
      }
    });
    refreshWindowButtons();
    const runMoments = async (publish) => {
      const buttons = $$('#daily-moments-run-btn,#daily-moments-preview-btn,#moment-publish-draft,#moment-reconcile');
      const result = $('#daily-moments-action-result');
      if (publish && !await askForConfirmation('立即重新汇总今天的群聊，并允许模型按决定发布一条说说？如果今天已有发布记录，本次仍会生成并可能再发布一条。')) return;
      state.currentMomentId = null;
      buttons.forEach((button) => { button.disabled = true; });
      result.textContent = publish ? '正在总结并执行…' : '正在生成预览…';
      try {
        await saveConfig({ quiet: true });
        const response = await api('/api/daily-moments/run', {
          method: 'POST',
          body: JSON.stringify({
            publish,
            confirm: publish,
            force: publish,
            confirmDuplicateRisk: publish
          })
        });
        const record = response.record || {};
        state.currentMomentId = record.id || null;
        result.textContent = response.alreadyAttempted
          ? `未重复发布：${momentStatusLabel(record)}`
          : `${publish ? '执行完成' : '草稿生成完成'}：${momentStatusLabel(record)}${record.tid ? ` · ${record.tid}` : ''}`;
        await loadDailyMomentsStatus();
      } catch (error) {
        result.textContent = `执行失败：${error.message}`;
      } finally {
        buttons.forEach((button) => { button.disabled = false; });
        await loadDailyMomentsStatus();
      }
    };
    $('#daily-moments-preview-btn')?.addEventListener('click', () => runMoments(false));
    $('#daily-moments-run-btn')?.addEventListener('click', () => runMoments(true));
  }

  if ((state.settingsSection || 'api') === 'qzone-interactions') {
    loadQzoneInteractionStatus();
    const runInteractions = async (kind) => {
      const label = kind === 'feed' ? '阅览好友动态并允许模型点赞或评论' : '检查新评论并允许模型回复';
      if (!await askForConfirmation(`确认立即${label}？`)) return;
      const buttons = $$('#qzi-run-feed-btn,#qzi-run-reply-btn');
      const result = $('#qzi-action-result');
      buttons.forEach((button) => { button.disabled = true; });
      result.textContent = '执行中…';
      try {
        await saveConfig({ quiet: true });
        const response = await api('/api/qzone-interactions/run', {
          method: 'POST',
          body: JSON.stringify({ kind, confirm: true })
        });
        const run = response.run || {};
        result.textContent = `${QZONE_RUN_LABELS[run.status] || run.status || '完成'}：动态 ${Number(run.selectedFeeds) || 0}，回复 ${Number(run.selectedReplies) || 0}`;
      } catch (error) {
        result.textContent = `执行失败：${error.message}`;
      } finally {
        buttons.forEach((button) => { button.disabled = false; });
        await loadQzoneInteractionStatus();
      }
    };
    $('#qzi-run-feed-btn')?.addEventListener('click', () => runInteractions('feed'));
    $('#qzi-run-reply-btn')?.addEventListener('click', () => runInteractions('reply'));
  }

  $('#change-console-token-btn')?.addEventListener('click', async () => {
    const button = $('#change-console-token-btn');
    const result = $('#console-token-result');
    const currentToken = $('#cfg-console-token-current')?.value || '';
    const newToken = ($('#cfg-console-token-new')?.value || '').trim();
    const confirmToken = ($('#cfg-console-token-confirm')?.value || '').trim();
    if (newToken !== confirmToken) {
      result.textContent = '两次输入的新 Token 不一致';
      return;
    }
    button.disabled = true;
    result.textContent = '更新中…';
    try {
      const response = await api('/api/console-token', {
        method: 'POST',
        body: JSON.stringify({ currentToken, newToken, confirmToken })
      });
      for (const id of ['#cfg-console-token-current', '#cfg-console-token-new', '#cfg-console-token-confirm']) {
        const input = $(id);
        if (input) input.value = '';
      }
      if (state.config?.server) state.config.server.hasToken = true;
      result.textContent = response.accessFileUpdated === false
        ? 'Token 已更新；服务器凭据提示文件更新失败，请使用 manage.sh token 查看。'
        : 'Token 已更新，当前浏览器已自动使用新 Token。';
    } catch (error) {
      result.textContent = `更新失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields',
      doubao: '#doubao-search-fields'
    };
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) el.style.display = provider === v ? '' : 'none';
    }
    const manage = $('#custom-provider-manage');
    if (manage) manage.style.display = v.startsWith('custom:') ? '' : 'none';
  });

  // ── 自定义搜索服务：添加 / 测试 / 删除 ──
  $('#add-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#add-search-provider-hint');
    const baseUrl = ($('#new-sp-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (hint) hint.textContent = '添加中…';
    try {
      const r = await api('/api/search-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: ($('#new-sp-name')?.value || '').trim(),
          type: $('#new-sp-type')?.value || 'openai',
          baseUrl,
          apiKey: ($('#new-sp-apikey')?.value || '').trim(),
          model: ($('#new-sp-model')?.value || '').trim()
        })
      });
      // 添加后直接选中它（省一次手动切换）
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { provider: `custom:${r.provider.id}` } })
      });
      if (hint) hint.textContent = '已添加并选中 ✓';
      for (const id of ['#new-sp-name', '#new-sp-baseurl', '#new-sp-apikey', '#new-sp-model']) {
        const el = $(id);
        if (el) el.value = '';
      }
      await loadSettings();
    } catch (e) {
      if (hint) hint.textContent = `添加失败：${e.message}`;
    }
  });

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    if (!await askForConfirmation(`确定删除搜索服务「${name}」？`)) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });

  // ── 响应档位滑条：拖动时即时反馈（档位 + 概率 + 参数高亮）──
  // ⚠️ 档位的唯一真相是滑条的 value（DOM 实时值），不用全局变量记录 ——
  //   曾经用过 window.__ctxTier，结果每次重渲染重新绑定事件时被"未保存的旧配置"
  //   无条件覆盖（选了 2 档，切走再切回就变回 4 档），还踩了 `|| 4` 的 falsy 陷阱。
  const tierSlider = $('#ctx-tier-slider');
  if (tierSlider) {
    const sync = () => {
      const pos = Number(tierSlider.value);
      // 提示行：显示当前概率与"哪些一定回"
      const note = $('#ctx-tier-note');
      if (note) note.innerHTML = sliderDesc(pos);
      // 参数区高亮：①②（被 @ / 关键词）始终算数；③ 概率在中间时用得上；④ 只有 100% 才用得上
      const on = paramActiveForProbability(pos);
      const actives = [on.at, on.keyword, on.random, on.all];
      document.querySelectorAll('.tier-param').forEach((el, idx) => {
        el.classList.toggle('dim', !actives[idx]);
      });
      // 刻度段高亮：概率落在哪一段就点亮哪一段。
      // ⚠️ 之前这段完全没做，颜色全靠 CSS 写死（.s1 永远亮、.s4 永远橙），
      //    所以拖动滑条时刻度毫无反应 —— 看起来就像"没生效"。
      const seg = segOfProbability(pos);
      document.querySelectorAll('#tier-scale .tier-seg').forEach((el) => {
        el.classList.toggle('on', Number(el.dataset.seg) === seg);
      });
      // 滑条填充色（用 CSS 变量告诉样式当前百分比）
      tierSlider.style.setProperty('--pos', pos + '%');
    };
    tierSlider.addEventListener('input', sync);
    sync();   // 初始同步一次
  }

  // ── 对话模式：分段切换器只展示当前模式相关参数 ──
  const conversationModeInput = $('#cfg-conversation-mode');
  const conversationModeShell = $('#conversation-mode-shell');
  const conversationModeHint = $('#conversation-trigger-hint');
  const triggerHints = {
    legacy: '每批消息都依据以下档位决定是否启动。',
    threaded: '没有有效续接线程时使用以下档位；续接对象直接进入运行。',
    lifecycle: '没有活动生命周期时使用以下档位；生命周期内消息不再受档位拦截。'
  };
  const syncConversationMode = (mode) => {
    const next = ['legacy', 'threaded', 'lifecycle'].includes(mode) ? mode : 'legacy';
    if (conversationModeInput) conversationModeInput.value = next;
    if (conversationModeShell) {
      conversationModeShell.dataset.mode = next;
      conversationModeShell.className = `conversation-mode-shell mode-${next}`;
    }
    document.querySelectorAll('[data-conversation-mode]').forEach((button) => {
      const active = button.dataset.conversationMode === next;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-conversation-panel]').forEach((panel) => {
      const active = panel.dataset.conversationPanel === next;
      panel.classList.toggle('hidden', !active);
      panel.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
    if (conversationModeHint) conversationModeHint.textContent = triggerHints[next];
  };
  document.querySelectorAll('[data-conversation-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      syncConversationMode(button.dataset.conversationMode);
      conversationModeInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  syncConversationMode(conversationModeInput?.value);

  // ── 对话机制：全局默认 + 分群覆盖 ──
  const conversationUnified = $('#cfg-conversation-unified');
  if (conversationUnified) conversationUnified.addEventListener('change', () => {
    const wrap = $('#conversation-pergroup-wrap');
    if (wrap) wrap.style.display = conversationUnified.checked ? 'none' : '';
  });
  const conversationGroup = $('#conversation-group-select');
  if (conversationGroup) {
    const modeSelect = $('#conversation-group-mode');
    const defaultMode = $('#cfg-conversation-mode');
    const jsonEl = $('#conversation-group-json');
    const readMap = () => { try { return JSON.parse(jsonEl.value || '{}'); } catch { return {}; } };
    const writeMap = (map) => { jsonEl.value = JSON.stringify(map); };
    const allowIds = (c.allow?.groups || []).map(String);
    const extraIds = Object.keys(readMap()).filter((id) => !allowIds.includes(id));
    const ids = [...allowIds, ...extraIds];
    conversationGroup.innerHTML = ids.length
      ? ids.map((id) => `<option value="${esc(id)}">${esc(id)}${extraIds.includes(id) ? '（已不在白名单）' : ''}</option>`).join('')
      : '<option value="">（白名单为空，先去「白名单」页签加群）</option>';
    api('/api/onebot/groups').then((data) => {
      const names = new Map((data.groups || []).map((group) => [String(group.id), group.name]));
      conversationGroup.querySelectorAll('option').forEach((option) => {
        const name = names.get(option.value);
        if (name) option.textContent = `${name}（${option.value}）${extraIds.includes(option.value) ? ' · 已不在白名单' : ''}`;
      });
    }).catch(() => {});
    const loadConversationGroup = () => {
      const gid = conversationGroup.value;
      const map = readMap();
      modeSelect.value = map[gid] || defaultMode?.value || 'legacy';
    };
    conversationGroup.addEventListener('change', loadConversationGroup);
    modeSelect.addEventListener('change', () => {
      const gid = conversationGroup.value;
      if (!gid) return;
      const map = readMap();
      map[gid] = modeSelect.value;
      writeMap(map);
    });
    defaultMode?.addEventListener('change', () => {
      const gid = conversationGroup.value;
      if (gid && readMap()[gid] === undefined) loadConversationGroup();
    });
    $('#conversation-group-clear-btn')?.addEventListener('click', () => {
      const gid = conversationGroup.value;
      if (!gid) return;
      const map = readMap();
      delete map[gid];
      writeMap(map);
      loadConversationGroup();
    });
    loadConversationGroup();
  }

  // ── 统一/分群开关：切换两块 UI 的显隐 ──
  const unifiedChk = $('#cfg-unifiedtier');
  if (unifiedChk) unifiedChk.addEventListener('change', () => {
    const on = unifiedChk.checked;
    const uw = $('#tier-unified-wrap'); if (uw) uw.style.display = on ? '' : 'none';
    const pw = $('#tier-pergroup-wrap'); if (pw) pw.style.display = on ? 'none' : '';
  });

  // ── 分群档位：下拉选群 + 每群一条滑条 ──
  // ⚠️ 唯一真相是隐藏 input 里的 JSON（tier-group-json），滑条每次 input 都即时写回 ——
  //    不用全局变量（这个文件里"全局变量被重渲染覆盖"的坑已经踩过两次了）。
  const groupSel = $('#tier-group-select');
  if (groupSel) {
    const jsonEl = $('#tier-group-json');
    const gSlider = $('#ctx-tier-slider-g');
    const gNote = $('#ctx-tier-note-g');
    const readMap = () => { try { return JSON.parse(jsonEl.value || '{}'); } catch { return {}; } };
    const writeMap = (m) => { jsonEl.value = JSON.stringify(m); };

    // 群列表 = 白名单群 ∪ 已单独设置过的群（后者标"已不在白名单"，留着让用户能清理）
    const allowIds = (c.allow?.groups || []).map(String);
    const extraIds = Object.keys(readMap()).filter((id) => !allowIds.includes(id));
    const ids = [...allowIds, ...extraIds];
    groupSel.innerHTML = ids.length
      ? ids.map((id) => `<option value="${esc(id)}">${esc(id)}${extraIds.includes(id) ? '（已不在白名单）' : ''}</option>`).join('')
      : '<option value="">（白名单为空，先去「白名单」页签加群）</option>';
    // 异步补群名（协议端不在线就保持纯 QQ 号，不影响使用）
    api('/api/onebot/groups').then((d) => {
      const names = new Map((d.groups || []).map((g) => [String(g.id), g.name]));
      groupSel.querySelectorAll('option').forEach((o) => {
        const n = names.get(o.value);
        if (n) o.textContent = `${n}（${o.value}）${extraIds.includes(o.value) ? ' · 已不在白名单' : ''}`;
      });
    }).catch(() => {});

    const syncG = () => {
      const pos = Number(gSlider.value);
      if (gNote) gNote.innerHTML = sliderDesc(pos);
      // 参数高亮跟着"当前这个群"的概率走（统一滑条隐藏时，①②③④ 的灰显会误导）
      const on = paramActiveForProbability(pos);
      const actives = [on.at, on.keyword, on.random, on.all];
      document.querySelectorAll('.tier-param').forEach((el, idx) => {
        el.classList.toggle('dim', !actives[idx]);
      });
      const seg = segOfProbability(pos);
      document.querySelectorAll('#tier-scale-g .tier-seg')
        .forEach((el) => el.classList.toggle('on', Number(el.dataset.seg) === seg));
      gSlider.style.setProperty('--pos', pos + '%');
    };
    const loadGroup = () => {
      const gid = groupSel.value;
      const m = readMap();
      // 没单独设置过的群：从全局滑条当前值起步，所见即所得
      // 注意 0 是合法位置（1 档），不能写 `|| 100`
      const globalPos = Number($('#ctx-tier-slider')?.value);
      gSlider.value = m[gid] !== undefined ? m[gid] : (Number.isFinite(globalPos) ? globalPos : 100);
      syncG();
    };
    groupSel.addEventListener('change', loadGroup);
    gSlider.addEventListener('input', () => {
      syncG();
      const gid = groupSel.value;
      if (!gid) return;
      const m = readMap(); m[gid] = Number(gSlider.value); writeMap(m);
    });
    $('#tier-group-clear-btn')?.addEventListener('click', () => {
      const gid = groupSel.value;
      if (!gid) return;
      const m = readMap(); delete m[gid]; writeMap(m); loadGroup();
    });
    loadGroup();
  }

  // ── 屏蔽名单 ──
  $('#blocklist-btn')?.addEventListener('click', () => openBlocklistModal());

  // ── 主题选择器（设置页「界面」区）──
  const themePicker = $('#theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('[data-theme-opt]').forEach((el) => {
      const pick = () => {
        applyTheme(el.dataset.themeOpt);
        themePicker.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === el));
      };
      el.addEventListener('click', pick);
      // 键盘可达：Enter / Space 等价点击
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // 直接在模型输入框里改模型时也要刷新 —— 只有从目录里选才会走另一条路径。
  // 用 input 而非 change：边打字边更新，避免"点了别处才变"的迟滞感。
  const modelInput = $('#cfg-model');
  if (modelInput) modelInput.addEventListener('input', () => refreshModelPriceCard());
  refreshModelPriceCard();

  // 批量自定义价格编辑
  $('#batch-price-btn')?.addEventListener('click', () => openBatchPriceModal());
  // 给"当前模型"定价（渠道价/自定义价，覆盖官方价）
  $('#pc-price-btn')?.addEventListener('click', () => openPriceDialog({
    model: String($('#cfg-model')?.value || state.config?.api?.model || '').trim(),
    vendor: state.modelPrices?.currentVendor || ''
  }));

  // ── 从渠道自动拉价（探测）+ 渠道价目表管理 ──
  renderChannelFeeds();
  $('#probe-btn')?.addEventListener('click', runChannelProbe);
  $('#channel-feed-add')?.addEventListener('click', addChannelFeed);
  $('#channel-feeds')?.addEventListener('click', onChannelFeedAction);

  // ── 成本口径三选一：只让被选中的那一项可填 ──
  const syncCostModeInputs = () => {
    const picked = $('input[name="cost-mode"]:checked')?.value || 'official';
    const mult = $('#cfg-cost-multiplier');
    const monthly = $('#cfg-cost-monthly');
    if (mult) mult.disabled = picked !== 'multiplier';
    if (monthly) monthly.disabled = picked !== 'subscription';
    const status = $('#cost-mode-status');
    if (status) {
      status.textContent = picked === 'multiplier'
        ? `官方价 ×${mulOf(mult?.value)} = 你的渠道价（按实付口径显示）`
        : picked === 'subscription'
          ? `按 ¥${Number(monthly?.value) || 0}/月 固定支出显示，不再按 token 算`
          : '按内置官方价格表估算：数字是估算，不是你的账单';
    }
  };
  $$('input[name="cost-mode"]').forEach((el) => el.addEventListener('change', syncCostModeInputs));
  ['#cfg-cost-multiplier', '#cfg-cost-monthly'].forEach((sel) => $(sel)?.addEventListener('input', syncCostModeInputs));
  syncCostModeInputs();

  // ── 远程价格表：状态展示 + 立即拉取 ──
  renderPriceFeedStatus();
  $('#price-feed-refresh-btn')?.addEventListener('click', async () => {
    const statusEl = $('#price-feed-status');
    // URL 改了还没保存就先拉会拉到旧地址 —— 先顺手保存配置再拉
    try { await saveConfig({ quiet: true }); } catch { /* 保存失败也继续尝试拉取 */ }
    if (statusEl) statusEl.textContent = '正在拉取…';
    try {
      const r = await api('/api/model-prices/refresh', { method: 'POST', body: '{}' });
      // 合并而不是整体替换：响应里没有的字段（渠道价目表状态等）必须留住，
      // 否则这一下会把渠道价、别名、渠道价目表清单全部抹掉，卡片当场显示错价。
      state.modelPrices = {
        ...(state.modelPrices || {}),
        prices: r.prices,
        current: r.current,
        remote: r.remote,
        currentVendor: r.currentVendor ?? state.modelPrices?.currentVendor,
        currentDetail: r.currentDetail ?? state.modelPrices?.currentDetail,
        aliases: r.aliases ?? state.modelPrices?.aliases,
        channelFeeds: r.channelFeeds ?? state.modelPrices?.channelFeeds
      };
      renderPriceFeedStatus();
      refreshModelPriceCard();   // 价格可能变了，当前模型卡片跟着刷
    } catch (e) {
      if (statusEl) statusEl.textContent = `拉取失败：${e.message}`;
    }
  });

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    const box = $('#mem-model-box');
    if (box) box.style.display = memUseChat.checked ? 'none' : '';
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 替换成真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['new-apikey-toggle', 'new-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key'],
    ['cfg-doubao-key-toggle', 'cfg-doubao-key']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：显示真实 Key（若之前是掩码/空占位）
          input.type = 'text';
          input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住；用户改了的新 Key 也盖住
          const current = input.value || '';
          input.type = 'password';
          if (real && (current === real || current === '' || current === '******')) {
            input.value = '******';
          } else if (!real && current === '') {
            input.value = '';
          } else if (current) {
            // 用户输入了新 Key：保持新值（密码态下浏览器会显示圆点）
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以“显示”必须向后端专用端点要明文，不能直接读 state.config）
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': 'deepseek',
    'cfg-zhipu-key': 'zhipu',
    'cfg-bocha-key': 'bocha',
    'cfg-baidu-key': 'baidu',
    'cfg-metaso-key': 'metaso',
    'cfg-doubao-key': 'doubao'
  };

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId];
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      return String(r.apiKey || '');
    }
    return '';
  }
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  // 拿当前 API Key 的真实值：如果输入框里是用户刚输入的新 Key（非掩码非空），优先用；否则向后端取
  async function currentApiKey() {
    const input = $('#cfg-apikey');
    const raw = (input?.value || '').trim();
    if (raw && raw !== '******') return raw;          // 用户明文输入的新 Key / 刚点过“显示”的明文
    return await fetchRealKey('cfg-apikey');          // 掩码/空 → 用后端真实 Key
  }

  // 连通性测试：抽成公共逻辑，两个入口共用
  // （健康卡片的 test-api-btn 与模型区块的 test-provider-btn 做的是同一件事）
  async function runConnectivityTest(btn, out, idleLabel) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      // 只把"用户新输入的明文 Key"传给服务端；若是掩码/空则不传，
      // 让服务端用自己保存的 Key —— 不依赖明文读取端点，未设 token 时也能测试。
      const input = $('#cfg-apikey');
      const raw = (input?.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }

  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', () => runConnectivityTest(testProviderBtn, $('#provider-test-result'), '测试连通性'));

  // 健康卡片上的「测试一下」：此前 renderHealthCard 渲染后从未绑定事件
  // （绑的是 test-provider-btn，id 不匹配），按钮点了完全没反应。
  const testApiBtn = $('#test-api-btn');
  if (testApiBtn) testApiBtn.addEventListener('click', () => runConnectivityTest(testApiBtn, $('#test-api-result'), '测试一下'));

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const key = await currentApiKey();
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:44%">模型 ID</th><th style="width:44%">模型目录显示名</th><th></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="如 智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!apiKey) { $('#provider-action-hint').textContent = '请填写 API Key（提供商必须带密钥才能测试连通性/在线探测图片能力）'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      $('#provider-action-hint').textContent = r.created ? '已添加新提供商，并自动切换为当前模型。' : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    const vhint = $('#model-vision-hint');
    if (box) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && r.verdict === 'no-vision') {
        box.checked = false;
        box.disabled = true;
        hint.textContent = '此模型不支持图片输入';
      } else {
        box.disabled = false;
        box.checked = state.config.api.vision !== false;
        hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
      }
    }
    if (vhint) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
        vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
      } else {
        vhint.textContent = '';
      }
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    $$('.vbadge').forEach((el) => { el.style.display = show ? '' : 'none'; });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  // 附加规则/交流策略：变化很便宜（卡库有指纹、解析有缓存），即时同步
  for (const selector of ['#cfg-customrules', '#cfg-behavior-profile']) {
    $(selector)?.addEventListener('input', syncPersonaButtons);
    $(selector)?.addEventListener('change', syncPersonaButtons);
  }
  // 角色正文：整段正文每敲一键都要重画分节视图（约 10ms），打字时按 140ms 合并成一次；
  // 失焦/提交立刻同步，不会留下过期视图。
  $('#cfg-roletext')?.addEventListener('input', () => {
    if (personaViewTimer) clearTimeout(personaViewTimer);
    personaViewTimer = setTimeout(() => { personaViewTimer = null; syncPersonaButtons(); }, 140);
  });
  $('#cfg-roletext')?.addEventListener('change', () => {
    if (personaViewTimer) { clearTimeout(personaViewTimer); personaViewTimer = null; }
    syncPersonaButtons();
  });
  // 卡库：点一张卡（或回车/空格）就把它的正文填进草稿。事件挂在容器上 ——
  // syncPersonaButtons 会重画卡库，挂在卡片上会被重画冲掉。
  const personaGrid = $('#persona-grid');
  if (personaGrid) {
    const pickCard = (target) => {
      const card = target?.closest?.('.persona-card');
      const id = card?.dataset?.personaId;
      const tpl = id ? state.personaTemplates[id] : null;
      if (tpl) applyPersonaDraft(tpl, id);
    };
    personaGrid.addEventListener('click', (event) => pickCard(event.target));
    personaGrid.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pickCard(event.target); }
    });
  }
  // 正文视图：点小节标题折叠/展开；小节上的「编辑/保存本节/取消/恢复本节」按钮优先处理
  const personaView = $('#persona-card-view');
  if (personaView) {
    personaView.addEventListener('click', (event) => {
      const roleBox = $('#cfg-roletext');
      const button = event.target?.closest?.('button');
      const buttonIsAction = button && (button.classList.contains('pd-sec-edit')
        || button.classList.contains('pd-sec-save')
        || button.classList.contains('pd-sec-cancel')
        || button.classList.contains('pd-sec-revert'));
      if (buttonIsAction && roleBox) {
        const idx = Number(button.closest('.pd-sec')?.dataset?.sec);
        if (!Number.isFinite(idx)) return;
        const baseTpl = state.personaTemplates[personaBaseCardId()];
        if (button.classList.contains('pd-sec-edit')) {
          // 全文编辑框和分节编辑框只留一个：开了分节就把「编辑全文」收起来
          const rawField = $('#persona-raw-field');
          if (rawField) {
            rawField.classList.add('hidden');
            const toggle = $('#toggle-persona-edit');
            if (toggle) toggle.textContent = '编辑全文';
          }
          // 切到另一节继续编辑时，先把当前这节未保存的改动落回草稿，别让输入白白丢掉
          if (flushPersonaSectionEdit()) {
            personaEditNote = '上一节已更新（还没生效）：确认无误后点底部那条「保存设置」。';
          }
          personaEditingSection = personaEditingSection === idx ? -1 : idx;
        } else if (button.classList.contains('pd-sec-save')) {
          const box = personaView.querySelector(`.pd-edit-text[data-sec="${idx}"]`);
          if (box) {
            roleBox.value = replacePersonaSectionBody(roleBox.value, idx, box.value);
            personaEditingSection = -1;
            // 刚保存的这一节保持展开：别让它立刻折回去，看起来像"没保存上"
            personaCollapsedSections.delete(idx);
            personaEditNote = '这一节已更新（还没生效）：确认无误后点底部那条「保存设置」。';
          }
        } else if (button.classList.contains('pd-sec-cancel')) {
          personaEditingSection = -1;
        } else if (button.classList.contains('pd-sec-revert')) {
          // 先落回正在编辑的那一节（可能是另一节），再恢复本节
          const flushed = flushPersonaSectionEdit();
          if (baseTpl?.builtin) {
            roleBox.value = replacePersonaSectionBody(roleBox.value, idx, personaSectionBody(baseTpl.text, idx));
            personaEditingSection = -1;
            personaCollapsedSections.delete(idx);
            personaEditNote = `${flushed ? '上一节已更新；' : ''}这一节已恢复成卡文件「${baseTpl.name}」里的写法（还没生效）：记得点底部的「保存设置」。`;
          }
        }
        syncPersonaButtons();
        return;
      }
      const head = event.target?.closest?.('.pd-sec-head');
      const sec = head?.closest?.('.pd-sec');
      if (!sec) return;
      const idx = Number(sec.dataset.sec);
      if (!Number.isFinite(idx)) return;
      // 正在编辑的那节不许收起：一收起就会重画视图，输入框里没保存的字会丢
      if (idx === personaEditingSection) return;
      // 收起/展开会重画整个视图（viewKey 里含折叠集合）：先把正在编辑的另一节落回草稿，
      // 否则它的输入框会被按旧正文重建 —— 刚敲的字静默消失
      flushPersonaSectionEdit();
      if (personaCollapsedSections.has(idx)) personaCollapsedSections.delete(idx);
      else personaCollapsedSections.add(idx);
      syncPersonaButtons();
    });
  }
  // 整张卡恢复成卡文件原文（手改乱了就用它撤回）—— 同样按草稿那张卡
  const restoreBtn = $('#restore-persona-btn');
  if (restoreBtn) restoreBtn.addEventListener('click', () => {
    flushPersonaSectionEdit();
    const baseTpl = state.personaTemplates[personaBaseCardId()];
    const roleBox = $('#cfg-roletext');
    if (!baseTpl?.builtin || !roleBox) return;
    roleBox.value = baseTpl.text;
    personaEditingSection = -1;
    personaCollapsedSections = defaultPersonaFold(baseTpl.text);
    personaEditNote = `正文已恢复成卡文件「${baseTpl.name}」的原文（还没生效）：点底部的「保存设置」确认。`;
    syncPersonaButtons();
  });
  const expandBtn = $('#persona-expand-btn');
  if (expandBtn) expandBtn.addEventListener('click', () => {
    // 折叠会重画视图：先把正在编辑的那节落回草稿，否则输入框里的字会没
    flushPersonaSectionEdit();
    const total = parsePersonaCard($('#cfg-roletext')?.value || '').sections.length;
    // 只要还有展开的就全收，全收了就全展 —— 一个按钮两种状态，省一个开关
    if (personaCollapsedSections.size < total) {
      personaCollapsedSections = new Set(Array.from({ length: total }, (_, i) => i));
      expandBtn.textContent = '全部展开';
    } else {
      personaCollapsedSections = new Set();
      expandBtn.textContent = '全部收起';
    }
    syncPersonaButtons();
  });
  // 「编辑全文」：平时看分节视图（逐节可编辑），点它才露出整段原文 textarea
  const editToggle = $('#toggle-persona-edit');
  if (editToggle) editToggle.addEventListener('click', () => {
    const field = $('#persona-raw-field');
    if (!field) return;
    const collapsed = field.classList.toggle('hidden');
    if (!collapsed) {
      // 开整段编辑前，先把分节编辑框里的内容落回草稿，并收起它（两种编辑框只留一个）
      flushPersonaSectionEdit();
      personaEditingSection = -1;
      syncPersonaButtons();
      editToggle.textContent = '收起全文编辑';
      $('#cfg-roletext')?.focus();
    } else {
      editToggle.textContent = '编辑全文';
    }
  });
  // 附加规则的示例标签：点一下追加到 textarea（已经写过就不重复加）
  const ruleChips = $('#persona-rule-chips');
  if (ruleChips) ruleChips.addEventListener('click', (event) => {
    const chip = event.target?.closest?.('.rule-chip');
    const rule = chip?.dataset?.rule;
    const box = $('#cfg-customrules');
    if (!rule || !box) return;
    if (String(box.value).includes(rule)) return;
    box.value = box.value.trim() ? `${box.value.replace(/\s+$/, '')}\n${rule}` : rule;
    syncPersonaButtons();
  });
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!await askForConfirmation(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      await loadSettings();
      applyPersonaDraft(state.personaTemplates.xiaojingyu, 'xiaojingyu');
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

}

// ── 模型选择/添加/删除 模态框 ──
function closeModelModal(overlay) {
  if (overlay) overlay.remove();
}

/**
 * 弹窗外壳。
 * 主体方向判定：body **以 `<div class="model-modal-left"` 开头**才加 .row（横向），
 * 其余一律纵向堆叠。
 * ⚠️ 曾经只要 body 里"包含" model-modal-left 就加 row —— 但复合结构的弹窗
 *    （顶部工具栏 + 中部双栏 + 底部提示，如批量价格编辑、模型添加）需要的是
 *    外层纵向、双栏在 .ma-body 内部横向。误判成 row 后，工具栏与提示文
 *    两个 flex 项把宽度吃光，.ma-body（flex:1, basis 0）被挤成 0 宽，
 *    整个内容区隐形（2026-09-05 批量价格弹窗"空白"事故）。
 */
function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}">
      <div class="model-modal-head">
        <span>${esc(head)}</span>
        <button class="model-modal-close">×</button>
      </div>
      <div class="model-modal-body${/^\s*<div class="model-modal-left"/.test(String(body)) ? ' row' : ''}">${body}</div>
      ${foot ? `<div class="model-modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

/**
 * 调用明细弹窗：点「调用次数」卡片打开，列出各类工具分别被调用了多少次。
 *
 * 这东西对省钱没什么实际帮助 —— 但一张纯数字的成本表太无聊了，
 * 而"机器人这周发了 133 条消息、戳了 6 次、翻了 3 次聊天记录"这类数字
 * 恰恰是最能反映它"活成什么样"的。所以做出来，纯粹因为好看又好玩。
 */
function openToolBreakdown() {
  const counts = (state.usageStats && state.usageStats.toolCounts) || {};
  const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);

  if (!total) {
    modelModalShell({
      head: '调用明细',
      body: '<div class="empty-hint">这个时间区间内还没有任何工具调用记录。</div>'
    });
    return;
  }

  const max = Math.max(...entries.map(([, n]) => n));

  // 按分类分组，分类内按次数降序
  const byCat = new Map();
  for (const [key, n] of entries) {
    const meta = TOOL_META[key] || { name: key, cat: '其他', icon: '🔧' };
    if (!byCat.has(meta.cat)) byCat.set(meta.cat, []);
    byCat.get(meta.cat).push({ key, n, ...meta });
  }
  const cats = TOOL_CAT_ORDER.filter((c) => byCat.has(c));
  for (const c of byCat.keys()) if (!cats.includes(c)) cats.push(c);

  const rows = cats.map((cat) => {
    const items = byCat.get(cat).sort((a, b) => b.n - a.n);
    const catTotal = items.reduce((a, x) => a + x.n, 0);
    return `
      <div class="tb-cat">
        <div class="tb-cat-head">
          <span>${esc(cat)}</span>
          <span class="tb-cat-sum">${catTotal} 次 · ${(catTotal / total * 100).toFixed(0)}%</span>
        </div>
        ${items.map((it) => `
          <div class="tb-row">
            <span class="tb-icon">${it.icon}</span>
            <span class="tb-name">${esc(it.name)}</span>
            <span class="tb-code">${esc(it.key)}</span>
            <span class="tb-bar"><i style="width:${(it.n / max * 100).toFixed(1)}%"></i></span>
            <span class="tb-n">${it.n}</span>
          </div>`).join('')}
      </div>`;
  }).join('');

  // 一句话小结（让这堆数字有个"人味"的结论）
  const say = counts.send_message ? `发了 ${counts.send_message} 条消息` : '一条都没发';
  const poke = counts.send_poke ? `、戳了 ${counts.send_poke} 次` : '';
  const sticker = counts.send_sticker ? `、贴了 ${counts.send_sticker} 张表情` : '';
  const search = (Number(counts.web_search) || 0) + (Number(counts.web_fetch) || 0);
  const searchTxt = search ? `、联网查了 ${search} 次` : '';

  modelModalShell({
    head: `调用明细（${state.usageStats?.rangeLabel || ''} · 共 ${total} 次）`,
    body: `
      <div class="tool-breakdown">
        <div class="tb-lead">这段时间里，机器人${say}${poke}${sticker}${searchTxt}。</div>
        ${rows}
      </div>`,
    foot: '<div class="muted" style="font-size:11.5px">工具调用本身不额外计费，成本来自它们消耗的 token。</div>'
  });
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>交流策略</label>
        <select id="new-persona-profile">
          <option value="legacy" ${$('#cfg-behavior-profile')?.value !== 'grounded' ? 'selected' : ''}>原版群友</option>
          <option value="grounded" ${$('#cfg-behavior-profile')?.value === 'grounded' ? 'selected' : ''}>自然可靠</option>
        </select>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本">${esc($('#cfg-roletext')?.value || '')}</textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则">${esc($('#cfg-customrules')?.value || '')}</textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    const behaviorProfile = overlay.querySelector('#new-persona-profile').value;
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules, behaviorProfile })
      });
      closeModelModal(overlay);
      await loadSettings();
      applyPersonaDraft({ name, text, customRules, behaviorProfile });
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点底部的「保存设置」使当前填写生效。`;
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '模型目录为空：请先在下方的“手动添加提供商”里添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 只更新 provider/model/baseUrl；apiKey 保持当前已保存值，不把密钥回写到接口请求里
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 选择记忆整理专用模型：复用模型目录选择器，保存到 config.memory.provider/model。 */
function openMemoryModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#mem-model-hint').textContent = '模型目录为空：请先到「模型 API」页签添加提供商。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择记忆整理模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  // 从 DOM 的隐藏字段读当前值（而非 state.config）：
  // 用户可能刚选过但还没保存，或 state 还没刷新，DOM 才是最新真相。
  const currentProvider = $('#cfg-mem-provider')?.value || state.config?.memory?.provider || '';
  const currentModel = $('#cfg-mem-model')?.value || state.config?.memory?.model || '';
  let activePid = currentProvider || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel && p.id === currentProvider ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 必须把"是否跟随聊天模型"的当前勾选状态一并提交。
          // 否则：用户取消勾选（→ 只改了 DOM，state.config 仍是 true）后直接点模型，
          // 这次提交不带 useChatModel，随后 loadSettings() 又按 state.config(true)
          // 重新渲染 —— 复选框被打回"已勾选"，迫使必须先保存一次才能选模型。
          const useChatBox = $('#cfg-mem-usechat');
          const useChatModel = useChatBox ? !!useChatBox.checked
            : (state.config?.memory?.useChatModel !== false);
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ memory: { provider: pid, model, useChatModel } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#mem-model-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
/**
 * “获取列表”后的勾选添加弹窗。
 *
 * 两个针对中转站的优化：
 *   1. 搜索框：中转站常返回几百上千个模型，没有搜索就没法用
 *   2. 双列模式：若模型 id 普遍带 "/"（OpenRouter 风格的 vendor/model），
 *      拆成左厂商 / 右模型两列，比一长条列表好找得多；否则保持单列 + 搜索
 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const all = (remoteModels || []).slice();

  // 有多少比例的 id 是 vendor/model 形式？超过一半就启用双列
  const slashed = all.filter((m) => String(m).includes('/'));
  const dual = all.length > 0 && slashed.length / all.length >= 0.5;

  // 预先按厂商分组（仅双列模式用）
  const groups = new Map();
  for (const m of all) {
    const s = String(m);
    const vendor = dual ? (s.includes('/') ? s.slice(0, s.indexOf('/')) : '(其他)') : '';
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(s);
  }
  const vendorList = [...groups.keys()].sort((a, b) => {
    if (a === '(其他)') return 1;
    if (b === '(其他)') return -1;
    return groups.get(b).length - groups.get(a).length;
  });

  const countText = `共 ${all.length} 个模型${dual ? ` · ${vendorList.length} 个厂商` : ''}`;

  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="ma-search" placeholder="搜索模型或厂商…" autocomplete="off" />
        <span class="muted" id="ma-count" style="font-size:12px;white-space:nowrap">${esc(countText)}</span>
      </div>
      <div class="ma-body ${dual ? 'dual' : 'single'}">
        ${dual ? '<div class="model-modal-left" id="ma-left"></div>' : ''}
        <div class="model-modal-right" id="ma-right"></div>
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });

  const searchEl = overlay.querySelector('#ma-search');
  const countEl = overlay.querySelector('#ma-count');
  const right = overlay.querySelector('#ma-right');
  const left = dual ? overlay.querySelector('#ma-left') : null;

  let activeVendor = dual ? vendorList[0] : '';
  let keyword = '';

  // 渲染成 checkbox 行
  const rowHtml = (m) => {
    const added = existingIds.has(m);
    const modelPart = dual && String(m).includes('/') ? String(m).slice(String(m).indexOf('/') + 1) : String(m);
    return `
      <label class="mm-model">
        <input type="checkbox" class="ma-check" value="${esc(m)}" ${added ? 'checked disabled' : ''} />
        <span class="mm-model-text">${esc(modelPart)}</span>
        ${added ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
      </label>`;
  };

  function matches(m) {
    if (!keyword) return true;
    return String(m).toLowerCase().includes(keyword);
  }

  function renderRight() {
    const pool = dual ? (groups.get(activeVendor) || []) : all;
    const list = pool.filter(matches);
    right.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<div class="muted" style="padding:10px">没有匹配的模型</div>';
    // 更新计数：显示当前筛选出来的数量
    countEl.textContent = keyword
      ? `${list.length} / ${dual ? pool.length : all.length}`
      : countText;
  }

  function renderLeft() {
    if (!left) return;
    const vendors = vendorList.filter((v) => (groups.get(v) || []).some(matches));
    left.innerHTML = vendors.length
      ? vendors.map((v) => `
          <div class="mm-prov ${v === activeVendor ? 'active' : ''}" data-vendor="${esc(v)}">
            ${esc(v)} <span class="muted" style="font-size:11px">${(groups.get(v) || []).filter(matches).length}</span>
          </div>`).join('')
      : '<div class="muted" style="padding:10px">没有匹配的厂商</div>';
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => {
        activeVendor = el.dataset.vendor;
        renderLeft();
        renderRight();
      });
    });
    // 当前厂商被搜索过滤掉了 → 自动切到第一个可见的
    if (vendors.length && !vendors.includes(activeVendor)) {
      activeVendor = vendors[0];
      renderLeft();
      renderRight();
    }
  }

  // 搜索：输入时同时刷两列（双列模式下左列的计数也要跟着变）
  searchEl.addEventListener('input', () => {
    keyword = String(searchEl.value || '').trim().toLowerCase();
    renderLeft();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      $('#provider-action-hint').textContent = `已加入 ${newModels.length} 个模型。`;
      loadSettings();
    } catch (e) {
      $('#provider-action-hint').textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!await askForConfirmation(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          renderRight();
          loadSettings();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'token-saver') {
    const picked = $('input[name="token-saver-mode"]:checked')?.value;
    patch.tokenSaver = {
      mode: ['off', 'balanced', 'aggressive'].includes(picked) ? picked : (c.tokenSaver?.mode || 'off')
    };
  }

  if (sec === 'time-control') {
    captureTimeControlRule();
    patch.timeControl = {
      ...structuredClone(state.timeControlDraft),
      enabled: chk('#tc-enabled'),
      overrides: { __replace__: structuredClone(state.timeControlDraft.overrides) }
    };
  }

  if (sec === 'memory') {
    patch.memory = {
      ...(c.memory || {}),
      consolidateEnabled: chk('#cfg-mem-consolidate', c.memory?.consolidateEnabled !== false),
      useChatModel: chk('#cfg-mem-usechat', c.memory?.useChatModel !== false),
      provider: val('#cfg-mem-provider', c.memory?.provider || '').trim(),
      model: val('#cfg-mem-model', c.memory?.model || '').trim(),
      consolidateMinIntervalMs: Number(val('#cfg-mem-interval', c.memory?.consolidateMinIntervalMs ?? 21600000)) || 21600000
    };
  }

  if (sec === 'experiments') {
    const autoFriendEnabled = chk(
      '#cfg-auto-friend-enabled',
      c.identityPilot?.friendProposal?.enabled === true
        && c.identityPilot?.incomingFriendRequest?.enabled === true
    );
    patch.identityPilot = identityPilotSettingsPatch(
      c,
      chk('#cfg-identity-pilot-enabled', c.identityPilot?.enabled === true)
        || autoFriendEnabled,
      {
        enabled: autoFriendEnabled,
        activeDispatchEnabled: autoFriendEnabled
      },
      {
        enabled: autoFriendEnabled,
        autoWhitelist: true
      }
    );
    patch.slangPilot = {
      ...(c.slangPilot || {}),
      enabled: chk('#cfg-slang-pilot-enabled', c.slangPilot?.enabled === true)
    };
    patch.incidentPilot = {
      ...(c.incidentPilot || {}),
      enabled: chk('#cfg-incident-pilot-enabled', c.incidentPilot?.enabled === true)
    };
  }

  if (sec === 'moments') {
    patch.dailyMoments = {
      ...(c.dailyMoments || {}),
      enabled: chk('#cfg-moments-enabled', c.dailyMoments?.enabled === true),
      startupCatchup: chk('#cfg-moments-catchup', c.dailyMoments?.startupCatchup !== false),
      hour: clampInt(val('#cfg-moments-hour', c.dailyMoments?.hour), 0, 23, 23),
      minute: clampInt(val('#cfg-moments-minute', c.dailyMoments?.minute), 0, 59, 30),
      scheduleWindows: val('#cfg-moments-schedule-mode', 'fixed') === 'windows'
        ? $$('#moment-window-rows .moment-window-row').map((row) => ({
          start: row.querySelector('.moment-window-start').value,
          end: row.querySelector('.moment-window-end').value,
          count: Number(row.querySelector('.moment-window-count').value)
        }))
        : null,
      intervalDays: (() => {
        const picked = val('#cfg-moments-interval', String(c.dailyMoments?.intervalDays || 1));
        return picked === 'custom'
          ? clampInt(val('#cfg-moments-interval-custom', c.dailyMoments?.intervalDays), 1, 30, 3)
          : clampInt(picked, 1, 30, 1);
      })(),
      minMessagesPerGroup: clampInt(
        val('#cfg-moments-min-messages', c.dailyMoments?.minMessagesPerGroup),
        0, 100, 3
      ),
      maxGroups: clampInt(val('#cfg-moments-max-groups', c.dailyMoments?.maxGroups), 1, 50, 12),
      maxMessagesPerGroup: clampInt(
        val('#cfg-moments-max-messages', c.dailyMoments?.maxMessagesPerGroup),
        5, 300, 80
      ),
      allowImages: chk('#cfg-moments-images', c.dailyMoments?.allowImages !== false),
      maxImages: clampInt(val('#cfg-moments-max-images', c.dailyMoments?.maxImages), 0, 4, 1),
      visibility: clampInt(val('#cfg-moments-visibility', c.dailyMoments?.visibility), 1, 64, 4),
      maxResearchCalls: clampInt(
        val('#cfg-moments-research', c.dailyMoments?.maxResearchCalls),
        0, 10, 4
      ),
      maxRounds: clampInt(val('#cfg-moments-rounds', c.dailyMoments?.maxRounds), 2, 16, 8)
    };
  }

  if (sec === 'qzone-interactions') {
    patch.qzoneInteractions = {
      ...(c.qzoneInteractions || {}),
      enabled: chk('#cfg-qzi-enabled', c.qzoneInteractions?.enabled === true),
      startupCatchup: chk('#cfg-qzi-catchup', c.qzoneInteractions?.startupCatchup === true),
      feedIntervalMinutes: clampInt(
        val('#cfg-qzi-feed-interval', c.qzoneInteractions?.feedIntervalMinutes),
        5, 1440, 60
      ),
      replyIntervalMinutes: clampInt(
        val('#cfg-qzi-reply-interval', c.qzoneInteractions?.replyIntervalMinutes),
        1, 1440, 5
      ),
      feedFetchCount: clampInt(
        val('#cfg-qzi-feed-count', c.qzoneInteractions?.feedFetchCount),
        1, 50, 30
      ),
      ownPostCount: clampInt(
        val('#cfg-qzi-own-count', c.qzoneInteractions?.ownPostCount),
        1, 30, 10
      ),
      maxAgeHours: clampInt(
        val('#cfg-qzi-max-age', c.qzoneInteractions?.maxAgeHours),
        1, 720, 72
      ),
      maxBatchItems: clampInt(
        val('#cfg-qzi-batch-items', c.qzoneInteractions?.maxBatchItems),
        1, 50, 20
      ),
      allowLikes: chk('#cfg-qzi-likes', c.qzoneInteractions?.allowLikes !== false),
      allowComments: chk('#cfg-qzi-comments', c.qzoneInteractions?.allowComments !== false),
      allowReplies: chk('#cfg-qzi-replies', c.qzoneInteractions?.allowReplies !== false),
      maxLikesPerRun: clampInt(
        val('#cfg-qzi-max-likes', c.qzoneInteractions?.maxLikesPerRun),
        0, 20, 3
      ),
      maxCommentsPerRun: clampInt(
        val('#cfg-qzi-max-comments', c.qzoneInteractions?.maxCommentsPerRun),
        0, 10, 2
      ),
      maxRepliesPerRun: clampInt(
        val('#cfg-qzi-max-replies', c.qzoneInteractions?.maxRepliesPerRun),
        0, 20, 5
      ),
      commentMaxChars: clampInt(
        val('#cfg-qzi-comment-chars', c.qzoneInteractions?.commentMaxChars),
        5, 200, 60
      ),
      replyMaxChars: clampInt(
        val('#cfg-qzi-reply-chars', c.qzoneInteractions?.replyMaxChars),
        5, 200, 60
      ),
      actionDelayMinMs: clampInt(
        val('#cfg-qzi-delay-min', c.qzoneInteractions?.actionDelayMinMs),
        0, 10000, 700
      ),
      actionDelayMaxMs: clampInt(
        val('#cfg-qzi-delay-max', c.qzoneInteractions?.actionDelayMaxMs),
        0, 15000, 1800
      )
    };
  }

  if (sec === 'api') {
    // ⚠️ 模型名与开关状态必须读**界面实时值**（c.api 是上次保存的旧值）：
    // 用户可能改了模型/开关但还没保存过，用旧值会把价格存到错误的模型名下。
    const curModel = String(($('#cfg-model')?.value ?? c.api?.model) || '').trim();
    const officialOn = ($('#cfg-useofficialprice')?.checked) ?? (c.api?.useOfficialPrice !== false);
    // 卡片上的「自填单价」三个框只在真能生效时可编辑（与 refreshModelPriceCard 同一判据）：
    // 官方价开关开着、或这个模型走渠道价时它们停用，这时保持配置里的原值 ——
    // 读停用框里的值写进配置，会凭空造出一条「全局兜底单价」（对所有未定价模型生效）。
    const vendorNow = String(state.modelPrices?.currentVendor || '').trim();
    const hasChannelPrice = Boolean(
      vendorNow && curModel && hasOwnPrice((c.api?.modelPrices || {})[`${vendorNow}：${curModel}`])
    );
    const priceEditable = !officialOn && !hasChannelPrice;
    const priceIn = priceEditable ? (Number(val('#cfg-price-in', 0)) || 0) : (Number(c.api.priceInputPerM) || 0);
    const priceOut = priceEditable ? (Number(val('#cfg-price-out', 0)) || 0) : (Number(c.api.priceOutputPerM) || 0);
    const priceCached = priceEditable ? (Number(val('#cfg-price-cached', 0)) || 0) : (Number(c.api.priceCachedPerM) || 0);
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12,
      maxRunTokens: clampInt(
        val('#cfg-max-run-tokens', c.api.maxRunTokens),
        20000, 1000000, 160000
      ),
      contextWindowTokens: clampInt(
        val('#cfg-context-window-tokens', c.api.contextWindowTokens),
        16000, 2000000, 1000000
      ),
      // 成本核算：官方价开关（走中转站时通常要关掉开关自己填）
      useOfficialPrice: chk('#cfg-useofficialprice', c.api.useOfficialPrice !== false),
      // 账户级口径三选一：官方价估算 / 渠道倍率 / 按月付
      costMode: (() => {
        const picked = $('input[name="cost-mode"]:checked')?.value;
        return ['official', 'multiplier', 'subscription'].includes(picked) ? picked : (c.api.costMode || 'official');
      })(),
      costMultiplier: mulOf(val('#cfg-cost-multiplier', c.api.costMultiplier ?? 1)),
      costMonthlyFee: Number(val('#cfg-cost-monthly', c.api.costMonthlyFee ?? 0)) || 0,
      // 没有价格的模型按当前模型的价估算（默认开）
      fallbackToCurrentModel: chk('#cfg-fallback-current', c.api.fallbackToCurrentModel !== false),
      // 远程价格表 URL：留空 = 只用内置表
      priceRemoteUrl: val('#cfg-price-remote-url', c.api.priceRemoteUrl || '').trim(),
      // 全局兜底单价：仅当没有模型级价格时生效
      priceInputPerM: priceIn,
      priceOutputPerM: priceOut,
      priceCachedPerM: priceCached
    };
    // 把当前模型的单价存进 modelPrices[模型]（只影响这一个模型，不动内置官方表）。
    // 官方价开关打开时不写（那时输入框禁用，读到的就是官方价，写进去会凭空多一条自定义价）；
    // 这个模型已经有**渠道价**时也不写 —— 卡片显示的正是那条渠道价，
    // 存成 modelPrices[模型] 会把"只对这个渠道生效"悄悄扩大成所有渠道。
    if (curModel && priceEditable) {
      const nextMap = { ...(c.api?.modelPrices || {}) };
      const i = Number(val('#cfg-price-in', 0)) || 0;
      const o = Number(val('#cfg-price-out', 0)) || 0;
      const ca = Number(val('#cfg-price-cached', 0)) || 0;
      // 输入/输出才是"按 token 定价"的表达：只填缓存命中不算一条价（写进去会变成
      // in:0/out:0 的"明确免费价"，把官方价直接算成 0 元）。
      if (i || o) {
        nextMap[curModel] = { in: i, out: o, cached: ca || i };
      } else if (!String(nextMap[curModel]?.billing || '').trim()) {
        delete nextMap[curModel];   // 全 0（且不是包月/不计费）= 清除自定义，回落到官方表
      }
      // 同样需要整体替换，否则 delete 掉的那一项会在合并时复活
      patch.api.modelPrices = { __replace__: nextMap };
    }
    // 当前 API Key：只有用户在框里输入了非掩码的新值才走 /api/providers/set-key；
    // 掩码/留空都表示不改。
    const apiKeyInput = $('#cfg-apikey');
    const enteredApiKey = (apiKeyInput?.value || '').trim();
    if (enteredApiKey && enteredApiKey !== '******') {
      const pid = c.api?.provider;
      if (pid) {
        // 目录提供商的 Key 单独存（不能覆盖别的提供商的 Key）
        await api('/api/providers/set-key', {
          method: 'POST',
          body: JSON.stringify({ providerId: pid, apiKey: enteredApiKey })
        });
      } else {
        patch.api.apiKey = enteredApiKey;
      }
    }
  }

  if (sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    const enteredDoubaoKey = val('#cfg-doubao-key', '').trim();
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'bing'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search',
      deepseek: {
        ...(c.webSearch?.deepseek || {}),
        ...(enteredDsKey && enteredDsKey !== '******' ? { apiKey: enteredDsKey } : {}),
        model: val('#cfg-ds-searchmodel', c.webSearch?.deepseek?.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
      },
      zhipu: {
        ...(c.webSearch?.zhipu || {}),
        ...(enteredZhipuKey && enteredZhipuKey !== '******' ? { apiKey: enteredZhipuKey } : {}),
        engine: val('#cfg-zhipu-engine', c.webSearch?.zhipu?.engine || 'search_std')
      },
      bocha: {
        ...(c.webSearch?.bocha || {}),
        ...(enteredBochaKey && enteredBochaKey !== '******' ? { apiKey: enteredBochaKey } : {})
      },
      baidu: {
        ...(c.webSearch?.baidu || {}),
        ...(enteredBaiduKey && enteredBaiduKey !== '******' ? { apiKey: enteredBaiduKey } : {})
      },
      metaso: {
        ...(c.webSearch?.metaso || {}),
        ...(enteredMetasoKey && enteredMetasoKey !== '******' ? { apiKey: enteredMetasoKey } : {})
      },
      doubao: {
        ...(c.webSearch?.doubao || {}),
        ...(enteredDoubaoKey && enteredDoubaoKey !== '******' ? { apiKey: enteredDoubaoKey } : {})
      },
      // 自定义搜索服务走 webSearch.providers 数组（由「添加自定义搜索服务」按钮维护），
      // 不在这里随表单提交 —— 避免每次保存都把动态列表覆盖掉。
      providers: c.webSearch?.providers || []
    };
  }

  if (sec === 'persona') {
    // 模板 id 跟着正文一起存：绑着内置卡（比如"猫娘（二次元）"）时后端会按 roles/*.md
    // 刷新正文，卡文件改了不用再来这里重选一次；手写了正文、或选的是自定义卡时这里为空，
    // 正文就按自定义处理，不会被文件覆盖。
    const roleTextDraft = val('#cfg-roletext', c.persona.roleText || '');
    const pickedId = currentPersonaId();
    let templateId = pickedId.startsWith('custom_') ? '' : pickedId;
    if (!templateId && roleTextDraft === (c.persona.roleText || '')) {
      // 模板没匹配上但正文一个字没动（典型：模板列表还没加载成功就要保存别的字段）
      // 就别把原有的绑定清掉——正文没变，绑定关系也不该变。
      templateId = c.persona.templateId || '';
    }
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      behaviorProfile: val('#cfg-behavior-profile', c.persona.behaviorProfile || 'legacy'),
      roleText: roleTextDraft,
      customRules: val('#cfg-customrules', c.persona.customRules || ''),
      templateId
    };
  }

  if (sec === 'allow') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    // 这里以前无条件发 deny = { groups: [], private: [] }：界面里没有 deny 的编辑控件，
    // 于是"保存白名单"会把 --import-bridge / 手改 config.json 配的屏蔽名单静默清空
    // （access.js 仍按 deny 拦人，但名单已经没了 = 被屏蔽的群/人重新可用）。
    // 不传这个字段，服务端会原样保留现有 deny。
    // 原先这里硬编码 false：只要点过保存就把该开关永久重置，
    // 而 UI 里根本没有输入控件 —— 只能手改 JSON，改完一保存就丢。改为读取复选框。
    const allowAllBox = $('#cfg-allowallwhenempty');
    patch.allowAllWhenEmpty = allowAllBox ? !!allowAllBox.checked : (c.allowAllWhenEmpty === true);
  }

  if (sec === 'chat') {
    let wakeDelayMinMs = clampInt(
      val('#cfg-wakedelay-min', c.wakeDelayMinMs ?? c.wakeDelayMs),
      0, 20000, 8000
    );
    let wakeDelayMaxMs = clampInt(
      val('#cfg-wakedelay-max', c.wakeDelayMaxMs ?? c.wakeDelayMs),
      0, 20000, 12000
    );
    if (wakeDelayMinMs > wakeDelayMaxMs) {
      [wakeDelayMinMs, wakeDelayMaxMs] = [wakeDelayMaxMs, wakeDelayMinMs];
    }
    patch.wakeDelayMinMs = wakeDelayMinMs;
    patch.wakeDelayMaxMs = wakeDelayMaxMs;
    patch.wakeDelayMs = Math.round((wakeDelayMinMs + wakeDelayMaxMs) / 2);
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.conversation = {
      ...(c.conversation || {}),
      mode: val('#cfg-conversation-mode', c.conversation?.mode || 'legacy'),
      unifiedMode: chk('#cfg-conversation-unified', c.conversation?.unifiedMode !== false),
      groupModes: {
        __replace__: (() => {
          try { return JSON.parse($('#conversation-group-json')?.value || '{}'); } catch { return {}; }
        })()
      },
      continuationWindowMs: clampInt(
        val('#cfg-cont-window', (c.conversation?.continuationWindowMs ?? 180000) / 1000),
        10, 1800, 180
      ) * 1000,
      threadTtlMs: clampInt(
        val('#cfg-thread-ttl', (c.conversation?.threadTtlMs ?? 1800000) / 60000),
        5, 1440, 30
      ) * 60000,
      continuationContextCount: clampInt(
        val('#cfg-cont-history', c.conversation?.continuationContextCount),
        1, 500, 100
      ),
      silentIdleMs: clampInt(
        val('#cfg-life-silent', (c.conversation?.silentIdleMs ?? 300000) / 60000),
        1, 60, 5
      ) * 60000,
      activeIdleMs: clampInt(
        val('#cfg-life-active', (c.conversation?.activeIdleMs ?? 1200000) / 60000),
        1, 120, 20
      ) * 60000,
      hardLifetimeMs: clampInt(
        val('#cfg-life-hard', (c.conversation?.hardLifetimeMs ?? 1800000) / 60000),
        5, 240, 30
      ) * 60000,
      rolloverArmedMs: clampInt(
        val('#cfg-life-rollover', (c.conversation?.rolloverArmedMs ?? 600000) / 60000),
        1, 60, 10
      ) * 60000,
      lifecycleContextCount: clampInt(
        val('#cfg-life-history', c.conversation?.lifecycleContextCount),
        1, 500, 100
      ),
      lifecycleRolloverInputTokens: clampInt(
        val('#cfg-life-tokens', c.conversation?.lifecycleRolloverInputTokens),
        5000, 500000, 32000
      ),
      maxTranscriptChars: clampInt(
        val('#cfg-life-chars', c.conversation?.maxTranscriptChars),
        20000, 1000000, 240000
      )
    };
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      // 回退值必须与 config.js 的 DEFAULT_CONFIG.send.maxPerMinute 一致（80）
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 80,
      maxPerHour: Number(val('#cfg-maxperhour', c.send?.maxPerHour)) || 500,
      byLengthMs: Number(val('#cfg-bylength', c.send?.byLengthMs)) || 20,
      hardSplitAt: Number(val('#cfg-hardsplit', c.send?.hardSplitAt)) || 0
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      checkIntervalMinMs: Number(val('#cfg-pro-min', c.proactive?.checkIntervalMinMs)) || 1800000,
      checkIntervalMaxMs: Number(val('#cfg-pro-max', c.proactive?.checkIntervalMaxMs)) || 5400000,
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability)) || 0.25,
      // 默认 true（与升级前行为一致）：没这个控件时才退回已保存配置
      followUpEnabled: chk('#cfg-pro-followup', c.proactive?.followUpEnabled !== false),
      selfWakeEnabled: chk('#cfg-pro-selfwake', c.proactive?.selfWakeEnabled !== false)
    };
    patch.sticker = {
      ...c.sticker,
      enabled: chk('#cfg-sticker', c.sticker?.enabled !== false),
      // 先取界面实时值（没这个控件时才退回已保存配置），再钳到 0~3
      encourage: Math.min(3, Math.max(0, Number(
        $('#cfg-sticker-encourage') ? $('#cfg-sticker-encourage').value : (c.sticker?.encourage ?? 1)
      ) || 0)),
      // 上限 60 与 stickers.js 的 buildStickerContext 一致
      promptMaxStickers: clampInt(val('#cfg-sticker-max', c.sticker?.promptMaxStickers), 1, 60, 10)
    };
    // 读取历史档位（替代原来的「最多条数 + 字符预算」两个固定值）
    patch.store = {
      ...(c.store || {}),
      // 档位 = 滑条位置换算（唯一真相是滑条的实时 value）。
      // 后端 updateConfig 还会用 tier-slider.js 再权威换算一次，双保险。
      contextTier: (() => {
        const sl = $('#ctx-tier-slider');
        const pos = sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
        return sliderToTierUI(pos).tier;
      })(),
      // 滑条位置存下来，重开设置页能还原到用户拖动的位置
      contextSliderPos: (() => {
        const sl = $('#ctx-tier-slider');
        return sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
      })(),
      // 3 档概率由滑条位置线性决定（不再让用户单独填数字）
      randomPercent: (() => {
        const sl = $('#ctx-tier-slider');
        const pos = sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
        return sliderToTierUI(pos).randomPercent;
      })(),
      // 下界是 0 不是 1：四个输入框都写着 min="0"，后端也把 0 当合法值（= 不读历史），
      // 夹到 1 会让"填 0"静默变成"读 1 条"，与界面和文档都对不上。
      atCount: clampInt(val('#cfg-atcount', c.store?.atCount), 0, 500, 20),
      keywordCount: clampInt(val('#cfg-kwcount', c.store?.keywordCount), 0, 500, 15),
      keywords: String($('#cfg-keywords')?.value || '')
        .split('\n').map((x) => x.trim()).filter(Boolean),
      randomCount: clampInt(val('#cfg-randcount', c.store?.randomCount), 0, 500, 8),
      allCount: clampInt(val('#cfg-allcount', c.store?.allCount), 0, 500, 80),
      // 统一开关 + 分群滑条表（__replace__：删掉的群设置要真删，深合并做不到）
      unifiedTier: chk('#cfg-unifiedtier', c.store?.unifiedTier !== false),
      // 明确声明语义：滑条上的数字就是概率（后端据此跳过老配置迁移）
      sliderMode: 'probability',
      groupSliderPos: {
        __replace__: (() => { try { return JSON.parse($('#tier-group-json')?.value || '{}'); } catch { return {}; } })()
      }
    };
    // 清掉已废弃的两个字段，避免残留配置误导后来读代码的人
    delete patch.store.pastStateLimit;
    delete patch.store.pastStateMaxChars;
  }

  if (sec === 'desktop') {
    patch.ui = {
      ...(c.ui || {}),
      // 主题在点选项时就已应用并写入 localStorage，这里把它一并存到后端以便跨设备保留
      theme: getThemePref(),
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      refreshMs: Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000
    };
    patch.memberNotes = {
      ...(c.memberNotes || {})
    };
  }

  if (sec === 'onebot') {
    const wsToken = val('#cfg-obtoken', '').trim();
    const httpToken = val('#cfg-obhttptoken', '').trim();
    patch.onebot = {
      wsUrl: val('#cfg-wsurl', c.onebot?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.onebot?.httpUrl || '').trim(),
      ...(wsToken ? { accessToken: wsToken } : {}),
      ...(httpToken ? { httpAccessToken: httpToken } : {})
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  syncGraduatedFeatureNavigation(state.config);
  if (!quiet) setStatusLabel('#model-label', `模型：${state.config.api.model || '未设置'}`);
  return data;
}

// ── 屏蔽名单 ──
// 左栏选白名单群聊，右栏拉取群成员逐个勾选；勾选 = 屏蔽。
// 弹窗内的改动只落在 pending 工作副本上，点「保存设置」才一次性 POST。
function openBlocklistModal() {
  const cfg = state.config || {};
  const allowIds = (cfg.allow?.groups || []).map(String);
  if (!allowIds.length) {
    modelModalShell({
      head: '屏蔽名单',
      body: '<div class="empty-hint">白名单为空——先去「白名单」页签添加群聊，再来屏蔽群员。</div>'
    });
    return;
  }
  const pending = structuredClone(cfg.blocklist || {});
  const selfId = String(cfg.onebot?.selfId || '');
  let activeGid = allowIds[0];
  let members = [];       // 当前群成员缓存（{userId, nickname, card}）
  let kw = '';

  const overlay = modelModalShell({
    head: '屏蔽名单',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="bl-left"></div>
        <div class="model-modal-right" id="bl-right"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        勾选 = 屏蔽：被屏蔽群员的消息不存档、不触发回复、不进提示词背景。
      </div>`,
    foot: `<span class="muted" id="bl-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn" id="bl-cancel">取消</button>
           <button class="btn btn-primary" id="bl-save">保存设置</button>`
  });
  const left = overlay.querySelector('#bl-left');
  const right = overlay.querySelector('#bl-right');
  const statusEl = overlay.querySelector('#bl-status');

  const groupNames = new Map();   // 异步补群名
  function renderLeft() {
    left.innerHTML = allowIds.map((id) =>
      `<div class="mm-prov ${id === activeGid ? 'active' : ''}" data-gid="${esc(id)}">${esc(groupNames.get(id) || id)}<div class="muted" style="font-size:11px">${esc(id)}</div></div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activeGid = el.dataset.gid; renderLeft(); loadMembers(); });
    });
  }
  api('/api/onebot/groups').then((d) => {
    for (const g of (d.groups || [])) groupNames.set(String(g.id), g.name);
    renderLeft();
  }).catch(() => {});

  function isBlocked(uid) { return (pending[activeGid] || []).map(String).includes(String(uid)); }

  function renderRight() {
    const filtered = kw
      ? members.filter((m) => `${m.card} ${m.nickname} ${m.userId}`.toLowerCase().includes(kw))
      : members;
    const rows = filtered.map((m) => {
      const label = m.card || m.nickname || m.userId;
      return `<label class="bl-member">
        <input type="checkbox" class="bl-chk" data-uid="${esc(m.userId)}" ${isBlocked(m.userId) ? 'checked' : ''} />
        <span class="bl-name">${esc(label)}</span>
        <span class="muted" style="font-size:11px">${esc(m.userId)}</span>
      </label>`;
    }).join('');
    right.innerHTML = `
      <div class="ma-toolbar">
        <input type="text" id="bl-search" placeholder="搜索群员（昵称 / 群名片 / QQ 号）…" autocomplete="off" value="${esc(kw)}" />
      </div>
      <div id="bl-list">${rows || '<div class="empty-hint" style="padding:18px">没有匹配的群员</div>'}</div>`;
    right.querySelector('#bl-search').addEventListener('input', (e) => { kw = e.target.value.trim().toLowerCase(); renderRight(); });
    right.querySelectorAll('.bl-chk').forEach((chkEl) => {
      chkEl.addEventListener('change', () => {
        const uid = chkEl.dataset.uid;
        const set = new Set((pending[activeGid] || []).map(String));
        if (chkEl.checked) set.add(uid); else set.delete(uid);
        if (set.size) pending[activeGid] = [...set]; else delete pending[activeGid];
        const n = (pending[activeGid] || []).length;
        statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
      });
    });
  }

  async function loadMembers() {
    right.innerHTML = '<div class="empty-hint" style="padding:18px">正在拉取群成员…</div>';
    try {
      const d = await api(`/api/groups/${activeGid}/members`);
      // 机器人自己列出来也没意义（自己的消息本来就不走这条管道）
      members = (d.members || []).filter((m) => String(m.userId) !== selfId);
      kw = '';
      renderRight();
      const n = (pending[activeGid] || []).length;
      statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
    } catch (e) {
      right.innerHTML = `<div class="empty-hint" style="padding:18px">拉取失败：${esc(e.message)}（OneBot 在线才能拿到群成员列表）</div>`;
    }
  }

  overlay.querySelector('#bl-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bl-save').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#bl-save');
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    try {
      // __replace__：清空的群要从配置里真删掉，深合并做不到
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ blocklist: { __replace__: pending } }) });
      state.config = data.config;
      closeModelModal(overlay);
    } catch (e) {
      statusEl.textContent = `保存失败：${e.message}`;
      saveBtn.disabled = false;
    }
  });

  renderLeft();
  loadMembers();
}

// ── 标签页切换 ──
// ⚠️ 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
//    结果漏了 usage 分支 —— 点「用量」页签只切了视图、从不加载内容，
//    页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
//    两条路径各维护一份必然再次分叉，所以这里只准调 switchTab。
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── 启动 ──
(async function init() {
  // 主题：先按本地偏好应用（index.html 的内联脚本已做过一次，这里同步按钮图标），
  // 再用后端配置覆盖（若用户换了设备，以后端为准）。
  applyTheme(getThemePref());
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    // 仅在"跟随系统"时响应系统主题变化
    mq?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  } catch { /* 老浏览器不支持 addEventListener，忽略 */ }
  $('#theme-btn')?.addEventListener('click', cycleTheme);

  // 「发现新版本」弹窗的三个按钮
  $('#update-notice-later')?.addEventListener('click', () => $('#update-notice')?.close());
  $('#update-notice-run')?.addEventListener('click', runUpdateFromNotice);
  $('#update-notice-ignore')?.addEventListener('click', ignoreUpdateVersion);

  // 「给模型定价」弹窗：入口在用量页（未定价提示条）与设置页（价格卡片），
  // 但按钮监听必须在这里一次性绑好 —— 挂在设置页渲染里会导致"从未打开设置页时
  // 弹窗里的按钮点了没反应"。
  $('#price-dialog-save')?.addEventListener('click', savePriceDialog);
  $('#price-dialog-delete')?.addEventListener('click', deletePriceDialog);
  $('#price-dialog-cancel')?.addEventListener('click', () => $('#price-dialog')?.close());
  $('#price-dialog-billing')?.addEventListener('change', syncPriceDialogBilling);

  // 地址栏带 ?token= 时先自动登录（供快捷方式/脚本免输令牌）；
  // 成功后清掉地址栏里的明文令牌再重载，避免留在浏览历史里。
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('token');
    if (t) {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: t })
      });
      if (res.ok) {
        // 只把地址栏里的明文令牌抹掉（不重载页面）：重载会让控制台白屏闪一下。
        // 服务器已在响应里下发 Cookie，抹掉地址栏后继续正常启动即可。
        u.searchParams.delete('token');
        history.replaceState(null, '', u.toString());
      }
    }
  } catch { /* 自动登录失败就按原流程弹登录框 */ }
  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  revealLoadingIfSlow();
  await bootLoop();

  // 主题：以后端配置为准（跨设备同步），仅当后端确实存过才覆盖本地
  try {
    const cfg0 = await api('/api/config');
    state.config = cfg0;
    syncGraduatedFeatureNavigation(cfg0);
    const t = cfg0?.ui?.theme;
    if (THEME_VALUES.includes(t)) {
      applyTheme(t);
      // 记一份"后端主题"，供下次首屏的内联脚本直接使用（否则会先按系统色画一版再被覆盖）
      try { localStorage.setItem('qqa-theme-server', t); } catch { /* 忽略 */ }
    }
    else if (cfg0 && !('ui' in cfg0)) { /* 后端还没这个字段，保持本地值 */ }
  } catch { /* 接口不可用就用本地的 */ }

  // 发现新版本提示：打开控制台时查一次（后端缓存 30 分钟），失败静默
  checkUpdateNotice().catch(() => {});

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    // 复用上面那次 /api/config 的结果，少一次请求（首屏更快）
    const cfg = state.config || await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      setInterval(refreshStatus, 15000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
  // 首次 startListPoller() 在配置加载前执行，会落到 4000ms 兜底值，导致会话列表每 4 秒重建一次（界面闪烁）；
  // 配置就绪后重新校准一次轮询间隔
  startListPoller();
  loadSessions();
  loadMemoryView();
  initSessionScrollLoader();
})();
