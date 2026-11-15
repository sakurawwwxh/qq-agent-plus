// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import { updateProgressElapsed } from '../app.js';
import { $, $$ } from './dom.js';
import { lifecycleRemainingText } from './lifecycle-labels.js';
import { renderMemoryList } from '../pages/memory.js';
const state = {
  tab: 'overview',   // 首屏落地页：与 index.html 里标了 active 的 tab 保持一致（2026-10-08 总览页）
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
  autoFollowRunning: true,
  settingsSection: 'api',
  modelReplacementDraft: {},
  modelReplacementDirty: {},
  modelReplacementSaving: {},
  modelReplacementTriggerDraft: {},
  modelReplacementTriggerDirty: {},
  modelReplacementTriggerChannel: 'chat',
  modelReplacementTriggerSaving: false,
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
  assetStickerSelectMode: false,
  assetStickerSelectedIds: [],
  assetLoadSeq: 0,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {},   // chatKey -> { note, at, failed? }
  livingMemory: {
    status: null,
    chats: [],
    tab: 'overview',
    selectedScope: '',
    query: '',
    search: '',
    view: 'list',
    page: 1,
    createOpen: false,
    selectedMemoryId: '',
    detail: null,
    recallResult: null,
    list: null,
    overviewList: null,
    graph: null,
    statusFilter: '',
    pageError: ''
  }
};

// ── 跨文件共享的可变单元 ──
// 2026-10-01 ESM 化：这些原先是模块级 `let`，靠 classic script 的全局词法环境互相读写。
// ES module 的 import 绑定**只读**（写它 TypeError），所以一概挂到 state 上（属性可写）。
// ⚠ 初始化必须留在**本文件**：`state.X = ...` 是模块求值期就执行的一行，谁写谁就得保证
// state 已经初始化。core/state.js ↔ app.js ↔ pages/* 在同一个 import 环上，别的文件
// （尤其 pages/persona.js）完全可能先求值 —— 那时 state 还在 TDZ 里，浏览器直接白屏。
// 这件事由 test/ui-module-graph.test.mjs 的 TDZ 用例盯着（它就是这么发现 persona 那三格的）。
state.personaCollapsedSections = new Set();
state.personaEditingSection = -1;   // 正在按小节编辑的序号；-1 = 没在编辑
state.personaEditNote = '';         // 小节编辑后的提示（"还得点保存设置"这类）

/**
 * 用量页当前选中的时间范围（对应 USAGE_RANGES 里的值）。
 */
state.usageRange = '7';

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingStatus = $('#loading-status');

const loadingLogs = $('#loading-logs');

state.appReady = false;

state.bootLogs = [];

state.loadingRevealed = false;

state.loadingRevealTimer = null;

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

state.sessionRenderScheduled = false;

// 存档页的刷新合并：chat-update 是"每条落库消息推一次"，而选中某个群时每次都会重拉
// 该会话整段历史（limit=100000）并重建整张消息表 —— 活跃群里等于每分钟几十次全量
// 下载 + 重绘，界面明显卡顿（2026-09-29 审查 P2）。合并到 1.5 秒一次；
// keepView 仍然生效，所以滚出来的内容不会被刷回去。
state.chatsRefreshTimer = null;

// 顶栏状态同样合并：chat-update 是每条消息一次，而 status-refresh.js 重写过的 refreshStatus
// 在人物印象 / 异常处理页会各自整页重拉（5 个接口 / 2 个接口 + 整串模板重算）——
// 只合并存档页的话，这两个页面的请求量一点没少（2026-09-29 审查 P2）。
state.statusRefreshTimer = null;

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」）；此前这里硬编码 4000，
// 配置项从未被读取 —— 用户改了完全没效果。
state.listPoller = null;

function refreshIntervalMs(fallback = 4000) {
  const n = Number(state.config?.ui?.refreshMs);
  return Number.isFinite(n) && n >= 1000 ? n : fallback;
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

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
state.lastDetailFp = null;

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
state.chatMsgSortCache = { src: null, newestFirst: [] };

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
state.usageLoadToken = 0;          // 每次加载递增，用于丢弃过期结果

// 人物印象页 / 异常日志页的同类竞态防护（2026-10-04 复审 P3）：这两页的加载路径原先只有
// `state.tab !== …` 判断，挡不住**同一个页签内**的乱序 —— 用户连点两次筛选项时，先发的
// 请求后到，会把后发的结果盖回去，界面显示的是上一次筛选的数据。口径与 usageLoadToken 一致。
state.identityLoadToken = 0;
state.incidentLoadToken = 0;

state.usageLastData = null;        // 上一次加载成功的数据：{ range, stats, st, prices }

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

/** 定价弹窗当前编辑的对象：{ model, vendor }。 */
state.priceDialogState = null;

state.personaViewTimer = null;      // 正文输入时的合并渲染定时器

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
state.personaParseCache = { text: null, card: null };

/** 卡库里的一张卡：草稿中的那张会高亮，真正生效且绑着卡文件的那张挂「使用中」。 */
/** 卡库简介（取自「你是谁」第一段）按卡正文缓存 —— 卡库每次重画都要用 5 次。 */
const personaDescCache = new Map();

export {
  loadingLogs, loadingStatus, pendingSessionDetail, personaDescCache, refreshIntervalMs,
  startConsolidateTicker, startLifecycleTicker, startUpdateProgressTicker, startWaitTicker, state
};
