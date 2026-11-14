// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

// ── 渲染钩子接线（改进方案 §11 C2「去插件化」）─────────────────────────────
// stable-features.js / status-refresh.js 原先直接改写这些全局（`window[name] = wrapped`、
// 裸赋值 `refreshStatus = ...`）。那只在"脚本顺序刚好、且双方都还是 classic script"时成立：
// ES module 的绑定只读、模块作用域也不挂 window，任何一步模块化都会让覆盖**静默失效**
// （页面看着正常，只是那段改造不再生效）。改为显式注册：由这里分发，顺序错了当场可见。
// 名字现在都在模块作用域里（不再挂全局），对外只有 QARegistry 一个出口，谁都不能背着底座改写。
// 底座一律带 `Impl` 后缀，插件可用 QARegistry.base(name) 取回原实现（避免自递归）。

import { api } from './core/api.js';
import { hasUnsavedModelReplacement } from './pages/model-replacement.js';
import {
  CORE_SERVICE_LINKS, SESSION_KEEP, THEME_ICON, THEME_LABEL, THEME_VALUES, UPDATE_ACTIVE_STATUSES,
  UPDATE_PHASE_LABELS, UPDATE_STATUS_LABELS
} from './core/constants.js';
import {
  afterRender, askForConfirmation, bindPeekToggle, closeDialog, hideLoading, initSessionScrollLoader,
  pollUntilReady, revealLoadingIfSlow, scheduleChatsRefresh, scheduleSessionRender, setBoxError,
  setLoadingStatus, syncGraduatedFeatureNavigation
} from './core/dom-util.js';
import { $, $$, esc } from './core/dom.js';
import {
  clampInt, fmtTime, formatElapsed, formatReleaseNotes, formatRevision, hostOfUrl, legacyServiceDeployed,
  onebotIssueText, serviceTileState, serviceUrl, uiServiceOfUrl, versionWithRevision
} from './core/format.js';
import { QARegistry } from './core/registry.js';
import { applyIcons, iconSvg } from './core/icons.js';
import { initSelectMenus } from './core/select-menu.js';
import { appearanceAttrs, appearancePatch, appearanceVars, resolveAppearance } from './core/appearance.js';
import { applyWithReveal } from './core/theme-transition.js';
// 侧栏那两个"参照控制台"的效果（悬停展开的图标条 + 会滑动的选中块）：实现在 core/side-nav.js
import { initSideNav, syncSideNav } from './core/side-nav.js';
import { initGlassRefract } from './core/glass-refract.js';
import { pendingSessionDetail, refreshIntervalMs, startUpdateProgressTicker, state } from './core/state.js';

// 导航/主题等静态节点上的 data-icon 在启动时统一注入 SVG（幂等，可重复调用）
applyIcons(document);
import { loadChats } from './pages/chat.js';
import { loadOverview } from './pages/overview.js';
import {
  loadAssetObservatory, loadExperimentalFeatureStatuses, loadFriendOpportunities, loadFriendProposals,
  loadIncomingFriendRequests, loadSlangFeaturePage, renderAssetObservatory, renderFriendFeaturePageImpl,
  renderIdentityFeaturePageImpl, renderIncidentFeaturePageImpl
} from './pages/features.js';
import { loadMemoryView, renderMemoryList } from './pages/memory.js';
import { loadLivingMemoryPage } from './pages/living-memory.js';
import { loadPluginsPage } from './pages/plugins.js';
import { stopQrPoll } from './pages/plugin-settings.js';
import { refreshPendingBadge } from './pages/plugin-pending.js';
import { loadSkillsPage } from './pages/skills.js';
import { renderExperimentalSettingsSectionImpl } from './pages/moments.js';
import { loadSessionDetail, loadSessions } from './pages/sessions.js';
import {
  renderSettingsImpl, resetMenuReveal, resolveTheme, startListPoller, syncPriceDialogBilling
} from './pages/settings.js';
import {
  ignoreUpdateVersion, pauseAutoUpdate, refreshStatusImpl, renderLifecycleOverviewImpl,
  renderUpdateCheckNote, resumePause, runManualUpdate, runUpdateFromNotice
} from './pages/status.js';
import { deletePriceDialog, loadUsageView, savePriceDialog } from './pages/usage.js';
QARegistry.register('renderExperimentalSettingsSection', renderExperimentalSettingsSectionImpl);
QARegistry.register('renderSettings', renderSettingsImpl);
QARegistry.register('renderIdentityFeaturePage', renderIdentityFeaturePageImpl);
QARegistry.register('renderFriendFeaturePage', renderFriendFeaturePageImpl);
QARegistry.register('renderIncidentFeaturePage', renderIncidentFeaturePageImpl);
QARegistry.register('refreshStatus', refreshStatusImpl);
QARegistry.register('renderLifecycleOverview', renderLifecycleOverviewImpl);
QARegistry.register('loadFriendFeaturePage', loadFriendFeaturePageImpl);

// html 变换：原实现先算完，返回值再过钩子链（对应原 wrapHtmlRenderer）
 
function renderExperimentalSettingsSection(c) {
  return QARegistry.transform('renderExperimentalSettingsSection', renderExperimentalSettingsSectionImpl(c), [c]);
}

function renderSettings(...args) { return afterRender('renderSettings', renderSettingsImpl, args); }
function renderIdentityFeaturePage(...args) { return afterRender('renderIdentityFeaturePage', renderIdentityFeaturePageImpl, args); }
function renderFriendFeaturePage(...args) { return afterRender('renderFriendFeaturePage', renderFriendFeaturePageImpl, args); }
function renderIncidentFeaturePage(...args) { return afterRender('renderIncidentFeaturePage', renderIncidentFeaturePageImpl, args); }

// 整体接管：插件 override 后由这里分发（原实现是底座）
function refreshStatus(...args) { return QARegistry.dispatch('refreshStatus', ...args); }
 
function renderLifecycleOverview(...args) { return QARegistry.dispatch('renderLifecycleOverview', ...args); }
function loadFriendFeaturePage(...args) { return QARegistry.dispatch('loadFriendFeaturePage', ...args); }

/** 读取当前主题设置（localStorage 优先，其次上次同步到的后端值，再其次默认浅色）。 */
function getThemePref() {
  try {
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
    // 与首屏脚本同一优先级：没有本机显式选择时，用上次同步下来的后端值（否则首屏按它画、
    // 模块却按默认浅色纠正，等于闪一下）。'system' 也认 —— 交给 resolveTheme 按系统解析。
    const server = localStorage.getItem('qqa-theme-server');
    if (THEME_VALUES.includes(server)) return server;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  // 与 DEFAULTS.mode / index.html 的首屏脚本同一口径（2026-10-19：默认浅色）
  return 'light';
}

/** 应用主题到 <html>，并同步按钮图标。 */
function applyTheme(pref) {
  const actual = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', actual);
  const btn = $('#theme-btn');
  if (btn) {
    // 主题按钮也是 SVG 图标：原来这里塞 emoji（🌙/☀️/🖥️），各系统形状不一、还自带配色
    btn.innerHTML = iconSvg(THEME_ICON[pref] || THEME_ICON.dark, { size: 17 });
    btn.title = `主题：${THEME_LABEL[pref] || '暗色'}（点击切换）`;
  }
  try { localStorage.setItem('qqa-theme', pref); } catch { /* 忽略 */ }
}

/**
 * 外观设置（明暗 / 色板 / 强调色 / 背景 / 排版 / 微调 / 顶栏 / 无障碍）：localStorage 先落一次
 * "立刻生效"，拉到 config.ui 之后再以服务端为准覆盖一次（跨设备同步）。
 * 都失效时用默认值 —— 外观绝不该让控制台起不来。
 */
function getAppearancePref() {
  try {
    const raw = localStorage.getItem('qqa-appearance');
    if (raw) return JSON.parse(raw);
  } catch { /* 隐私模式 */ }
  return {};
}

/**
 * 把一份外观配置套到 <html> 上。
 * 两条通道：CSS 变量走内联样式（强调色的派生色要算，只能给值），其余轴走 data-* 属性
 * （色板 / 深色强度 / 侧栏样式 / 背景 / 字体 / 密度 / 动效 / 对比度）—— 属性能让 CSS
 * 选择器直接命中，省得每个轴都往内联样式里塞变量。
 * 变量值为 null 表示"移除这条内联属性"：主题微调的「重置」就是靠它把控制权还给色板。
 * data-theme 交给 applyTheme（它还要跟着"跟随系统"换按钮图标），这里不重复设。
 */
function applyAppearance(pref = {}) {
  const app = resolveAppearance(pref);
  const root = document.documentElement;
  // 应用即同步"想要的外观"：setAppearance 的合并基准就是它（见那里的注释）
  desiredAppearance = appearancePatch(app);
  for (const [k, v] of Object.entries(appearanceVars(app))) {
    if (v === null) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
  for (const [k, v] of Object.entries(appearanceAttrs(app))) {
    if (v) root.setAttribute(`data-${k}`, v);
    else root.removeAttribute(`data-${k}`);
  }
  applyTheme(app.mode);
  try { localStorage.setItem('qqa-appearance', JSON.stringify(appearancePatch(app))); } catch { /* 忽略 */ }
  state.appearance = app;
  // 广播一次"外观已生效"。走波纹时这个函数是在浏览器的更新回调里跑的（比调用点晚几十~几百
  // 毫秒），所以"调用点之后立刻刷新界面"是不可靠的 —— 设置页的选中态与色板预览必须挂在这里，
  // 否则会出现"生效值和亮着的那一格不一致"（实测：连点强调色后色值对了、高亮停在中间那个）。
  try { document.dispatchEvent(new CustomEvent('qqa:appearance')); } catch { /* 老浏览器没有 CustomEvent 也不影响外观本身 */ }
  return app;
}

/**
 * "想要的外观"（= 合并基准）。
 * 为什么不能直接用已生效的那份：走波纹时 applyAppearance 是被延后到浏览器的更新回调里执行的，
 * 在那之前 state.appearance 还是旧值。若以旧值做基准，回调一跑就会把用户紧接着做的下一次
 * 修改覆盖掉（实测：快速连点三个配色方案，最后生效的是第一个）。
 * 所以基准取"最近一次想要的状态"：连续操作会累积，延迟执行的回调拿到的也是最新的那一份。
 */
let desiredAppearance = null;

/** 当前生效的外观（还没算过就先从 localStorage 算一份）。 */
function currentAppearance() {
  return state.appearance || resolveAppearance(getAppearancePref());
}

/**
 * 改外观：合并 → 套用 → 存本机（不发请求）。
 * 外观遵循设置页的统一契约"点了就生效，点保存才落服务器"，所以这里不 POST ——
 * 否则拖一下滑条就是一串请求。`reveal` 只给离散的颜色/明暗变更用：换主题、换强调色、
 * 换色板走 View Transitions 的圆形波纹；连续型控件（滑条）不要开，否则拖一下就闪一次。
 */
function setAppearance(patch = {}, ev = null, { reveal = false } = {}) {
  desiredAppearance = { ...(desiredAppearance || appearancePatch(currentAppearance())), ...patch };
  // 注意 run 读的是 desiredAppearance 而不是快照：波纹的回调可能在几十~几百毫秒后才执行，
  // 那期间用户还可能再点一次 —— 那时要应用的是"最新那一份"，不是排队时的那一份。
  const run = () => applyAppearance(desiredAppearance);
  if (reveal) applyWithReveal(run, ev);
  else run();
  return desiredAppearance;
}

/**
 * 侧栏"固定"按钮的当前态（图标点亮 + 无障碍属性 + 提示文案）。
 * 与外观面板里那个开关同源（currentAppearance().sidebarPinned），所以两边永远一致。
 */
function syncSideRailButton() {
  const btn = $('#side-pin-btn');
  if (!btn) return;
  const pinned = currentAppearance().sidebarPinned === true;
  btn.classList.toggle('pinned', pinned);
  btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  const label = pinned ? '取消固定侧栏（改回悬停展开）' : '固定侧栏（常驻展开）';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/**
 * 点侧栏的图钉：立刻生效（localStorage）+ 尽力写回服务端。
 * 写回这一步与顶栏主题按钮同一口径（那边也是 POST /api/config 的 ui.theme）——
 * 不然在侧栏钉住、刷新一次又变回图标条（服务端那份没变）。
 */
function toggleSideRail() {
  const next = currentAppearance().sidebarPinned !== true;
  setAppearance({ sidebarPinned: next });
  syncSideRailButton();
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { sidebarPinned: next } }) })
    .catch(() => { /* 后端不可达时静默：本地已经生效 */ });
}

/** 点击顶栏按钮：暗 → 亮 → 跟随系统 → 暗。波纹从按钮处铺开。 */
function cycleTheme(ev) {
  const order = THEME_VALUES;
  const cur = (desiredAppearance || appearancePatch(currentAppearance())).mode;
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setAppearance({ mode: next }, ev, { reveal: true });
  // 尽力同步到后端，失败不影响本地使用
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    // 头 3 秒用短间隔（服务通常立刻可用，短间隔能让首屏更快进入），之后退回 1 秒避免空转
    await new Promise((r) => setTimeout(r, i < 12 ? 250 : 1000));
  }
  hideLoading();
  refreshStatus();
  // 首屏：默认落在「总览」——这里要显式拉一次（switchTab 只在点击时触发，
  // 启动时 DOM 上已经标好 active 类，不会自己加载）
  if (state.tab === 'overview') loadOverview();
  if (state.tab === 'sessions') loadSessions();
  if (state.tab === 'memory') loadMemoryView();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
 
function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  // 预算保险丝已移除：原先这里有一个 pauseReason === 'budget' 的分支
  if (state.paused) {
    show = true;
    html = '机器人已暂停，不会处理任何消息。';
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
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

function switchTab(name) {
  // 点击当前已激活的**设置**页签时不要 loadSettings()：那会重建表单，把用户刚改、
  // 尚未保存的输入静默冲掉（2026-10-31 盲审 P2）。其它页签保持原有刷新语义，
  // 首屏/测试也可能需要靠 switchTab 初始化侧栏滑块。
  if (state.tab === name && name === 'settings' && (state.settingsDirty || hasUnsavedModelReplacement())) return;
  // 统一守卫：所有入口（页签点击、待批徽标、实验页跳转）都经过这里，
  // 不能只挂在 .tab 的 click 上，否则别的入口会静默丢掉未保存的设置。
  if (state.tab === 'settings' && name !== 'settings' && (state.settingsDirty || hasUnsavedModelReplacement()) && !state.switchTabBypass) {
    void askForConfirmation('设置页有未保存的改动，离开后会丢失。确定离开？').then((ok) => {
      if (!ok) return;
      state.switchTabBypass = true;
      try { switchTab(name); } finally { state.switchTabBypass = false; }
    });
    return;
  }
  // 离开插件页时停掉扫码轮询：设置块会随着页面切换消失，但定时器原本会继续
  // 每 3 秒打一次 /api/plugins/call，最长打到二维码过期。
  if (state.tab === 'plugins' && name !== 'plugins') stopQrPoll();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  // 侧栏：把"会滑动的选中块"挪到新页签上，并同步 aria-current（都按 .active 现推，见 core/side-nav.js）
  syncSideNav();
  if (name === 'overview') loadOverview();
  if (name === 'control') loadControlHub();
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  if (name === 'memory') loadMemoryView();
  if (name === 'living-memory') loadLivingMemoryPage({ force: true });
  if (name === 'identity') loadIdentityFeaturePage();
  if (name === 'friends') loadFriendFeaturePage();
  if (name === 'slang') loadSlangFeaturePage();
  if (name === 'incidents') loadIncidentFeaturePage();
  if (name === 'assets') loadAssetObservatory();
  if (name === 'skills') loadSkillsPage();
  if (name === 'plugins') loadPluginsPage({ force: true });
  void refreshPendingBadge();
  if (name === 'usage') loadUsageView({ force: true });
  if (name === 'settings') {
    // 进设置页时忘掉"这个分区已经露过脸"：用户可能手动把菜单滚走了，当前项得再带进视野一次
    resetMenuReveal();
    loadSettings();
  }
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
  const revision = formatRevision;
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
    <section class="settings-card" id="control-qq-login">
      <div class="control-section-title">
        <div><h3>QQ 登录</h3><span class="muted">扫码在 SnowLuma 远程桌面里完成</span></div>
        <a class="btn btn-primary btn-small" href="${esc(serviceUrl(6081))}" target="_blank" rel="noreferrer">打开扫码登录</a>
      </div>
      <div class="control-service-copy" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span id="control-qq-state" class="chip">检测中…</span>
        <span class="muted">打开远程桌面 → 扫码登录 QQ → 回到这里看到「OneBot 已连接」。</span>
      </div>
      <details class="hint" style="margin-top:8px">
        <summary>扫码失败 / 登录后还是未连接？</summary>
        <ul style="margin:6px 0 0 18px;padding:0;line-height:1.7">
          <li>二维码过期：刷新远程桌面页面重新扫码。</li>
          <li>提示设备或风控验证：在远程桌面里按提示完成，不要频繁重复登录。</li>
          <li>登录成功但 OneBot 未连接：检查「设置 → OneBot」的地址与令牌，或重启协议端。</li>
          <li>远程桌面密码：见安装结束打印的 <code>deployment-access.txt</code> 里的 noVNC password。</li>
        </ul>
      </details>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>一键体检</h3><span class="muted">控制台 / 协议端 / 入站 / 磁盘 / 更新状态</span></div>
        <button type="button" class="btn btn-small" id="control-health-run">开始体检</button>
      </div>
      <div id="control-health-result" class="control-result muted" role="status" aria-live="polite">点「开始体检」检查当前运行状态。</div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>运行指标与审计</h3><span class="muted">进程 / HTTP / 队列 / LLM / 最近写操作</span></div>
        <button type="button" class="btn btn-small" id="control-observability-refresh">刷新指标</button>
      </div>
      <div id="control-observability" class="control-result muted" role="status" aria-live="polite">点「刷新指标」加载当前运行指标与最近审计。</div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>数据备份</h3><span class="muted">只显示备份与校验；真正恢复需 SSH 执行命令</span></div>
        <div class="settings-actions" style="margin:0">
          <button type="button" class="btn btn-small" id="control-backup-refresh">刷新</button>
          <button type="button" class="btn btn-primary btn-small" id="control-backup-run">立即备份</button>
        </div>
      </div>
      <div id="control-backup-status" class="control-result muted" role="status" aria-live="polite">正在读取备份状态…</div>
      <div id="control-backup-output" class="control-result muted" role="status" aria-live="polite"></div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>存储维护</h3><span class="muted">按保留天数把已结束的会话留档压成 .gz（幂等，不删除）</span></div>
        <button type="button" class="btn btn-small" id="control-storage-compress">立即压缩留档</button>
      </div>
      <div id="control-storage-output" class="control-result muted" role="status" aria-live="polite">压缩天数与总量上限在「设置 → 聊天设置 → 数据保留」里调整。</div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>群策略总览</h3><span class="muted">只读；修改仍走各自设置页</span></div>
        <button type="button" class="btn btn-small" id="control-group-policy-refresh">刷新</button>
      </div>
      <div class="table-wrap" id="control-group-policy"><div class="muted" style="padding:8px">点「刷新」加载已入库群的策略。</div></div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>更新部署</h3><span class="muted">${esc(update.repository || '-')} · ${esc(update.branch || 'main')}</span></div>
        <span class="control-service-state ${update.status === 'failed' ? 'offline' : update.enabled ? 'online' : ''}" data-hub-deploy-state>${esc(updateState)}</span>
      </div>
      <div class="update-deploy-summary">
        <div><span>当前版本</span><strong data-hub-deploy="current">${esc(versionWithRevision(state.appVersion, update.currentRevision))}</strong></div>
        <div><span>目标版本</span><strong data-hub-deploy="target">${esc(revision(update.targetRevision))}${update.targetVersion ? ` · ${esc(update.targetVersion)}` : ''}</strong></div>
        <div><span>上次检查</span><strong data-hub-deploy="lastCheck">${update.lastCheckAt ? esc(fmtTime(update.lastCheckAt)) : '-'}</strong></div>
        <div><span>下次检查</span><strong data-hub-deploy="nextCheck">${update.nextCheckAt ? esc(fmtTime(update.nextCheckAt)) : '-'}</strong></div>
      </div>
      <div class="muted" data-hub-update-check style="margin-top:6px;font-size: var(--fs-sm);line-height:1.5">${renderUpdateCheckNote(update)}</div>
      <div class="update-deploy-progress${progressLine ? '' : ' hidden'}" id="hub-deploy-progress">
        <span class="loading-spinner" aria-hidden="true"></span>
        <span class="update-deploy-progress-text" id="hub-deploy-progress-text" role="status" aria-live="polite">${esc(updateProgressStage(update))}</span>
        <span class="update-deploy-progress-elapsed" id="hub-deploy-progress-elapsed" aria-hidden="true">${esc(updateProgressElapsed(update))}</span>
      </div>
      <div class="update-deploy-settings">
        <!-- 管理员 QQ 的唯一编辑入口在「设置 → 模型 API → 全局管理员 QQ」。这里原来渲染一个真输入框，
             stable-features 随后会把它换成 hidden 镜像 —— 于是"第一次进来有这一格、切走再回来就没了"。
             现在从一开始就是"提示 + hidden 镜像"：DOM 不再变化，保存路径（读 #auto-update-owner 的值）
             与既有的 syncAdminInputs 同步逻辑照旧。 -->
        <label><span>告警管理员 QQ</span>
          <span class="hint" style="margin:0">统一在「设置 → 模型 API → 全局管理员 QQ」里配置
            <button type="button" class="link-btn" data-open-settings="api">去设置</button></span>
          <input type="hidden" id="auto-update-owner" data-global-admin-mirror="true" value="${esc(update.ownerUin || '')}" />
        </label>
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
    <section class="settings-card">
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
        <!-- 「语音转文字」这一页里住着三块各自独立的密钥（语音合成 / 语音识别 / 图片生成），
             都是"填过就看不见"的，所以各给一行入口（三行都跳到同一个设置分区）。 -->
        <button type="button" class="control-key-row" data-open-settings="asr">
          <span><strong>语音回复 Key</strong><small>设置 → 语音转文字 · 语音合成</small></span><b>管理</b>
        </button>
        <button type="button" class="control-key-row" data-open-settings="asr">
          <span><strong>语音转文字 Key</strong><small>设置 → 语音转文字 · 语音识别</small></span><b>管理</b>
        </button>
        <button type="button" class="control-key-row" data-open-settings="asr">
          <span><strong>图片生成 Key</strong><small>设置 → 语音转文字 · 图片生成</small></span><b>管理</b>
        </button>
        <button type="button" class="control-key-row" data-open-settings="desktop">
          <span><strong>QQ Agent 控制台 Token</strong><small>系统</small></span><b>管理</b>
        </button>
        <a class="control-key-row${legacyServiceDeployed(statuses, 'bridge') ? '' : ' hidden'}" data-hub-legacy-entry="bridge" href="${esc(serviceUrl(3100))}" target="_blank" rel="noreferrer">
          <span><strong>Bridge 控制台 Token</strong><small>旧架构控制台</small></span><b>打开</b>
        </a>
      </div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>SnowLuma 登录密钥</h3><span class="muted">修改后 SnowLuma WebUI 的现有登录会话会失效</span></div>
        <a class="btn btn-small" href="${esc(serviceUrl(5099, '/settings?tab=account'))}" target="_blank" rel="noreferrer">打开账号安全</a>
      </div>
      <form id="snowluma-password-form" class="control-password-form" autocomplete="off">
        <!-- 浏览器要求密码表单带用户名框（可隐藏），否则 F12 里会有一条 DOM 提示。
             这里是给 SnowLuma 改密钥、不是登录，放个隐藏占位即可。 -->
        <input type="text" id="snowluma-account" name="username" value="snowluma" autocomplete="username" hidden aria-hidden="true" tabindex="-1" />
        <label><span>当前密钥</span>
          <div class="pw-row">
            <input type="password" id="snowluma-current-password" autocomplete="current-password" required />
            <button type="button" class="btn btn-small" id="snowluma-current-peek">显示</button>
          </div></label>
        <label><span>新密钥</span>
          <div class="pw-row">
            <input type="password" id="snowluma-new-password" autocomplete="new-password" placeholder="至少 10 位，含大小写与符号" required />
            <button type="button" class="btn btn-small" id="snowluma-new-peek">显示</button>
          </div></label>
        <label><span>确认新密钥</span>
          <div class="pw-row">
            <input type="password" id="snowluma-confirm-password" autocomplete="new-password" required />
            <button type="button" class="btn btn-small" id="snowluma-confirm-peek">显示</button>
          </div></label>
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

const HEALTH_CHECK_LABELS = {
  'console-healthz': '控制台',
  'onebot-status': 'OneBot',
  'protocol-version': '协议端版本',
  'docker-socket': 'Docker 权限',
  'outbound-freshness': '入站水位',
  'disk-space': '磁盘余量',
  'auto-update': '自动更新',
  'deploy-interrupted': '部署中断',
  'sqlite-integrity': '消息库完整性',
  plugins: '插件'
};

async function runControlHealth() {
  const btn = $('#control-health-run');
  const box = $('#control-health-result');
  if (!btn || !box) return;
  btn.disabled = true;
  box.className = 'control-result muted';
  box.textContent = '正在体检…（最多十几秒）';
  try {
    const result = await api('/api/health/check', { method: 'POST', body: '{}' });
    const checks = Array.isArray(result?.checks) ? result.checks : [];
    if (result?.error) {
      box.className = 'control-result error';
      box.textContent = `体检失败：${result.error}`;
      return;
    }
    if (!checks.length) {
      box.className = 'control-result error';
      box.textContent = '体检没有返回检查项，请查看服务日志。';
      return;
    }
    const failed = checks.filter((check) => !check.ok);
    if (result.healthy) {
      box.className = 'control-result success';
      box.textContent = `体检通过：${checks.length} 项都正常。`;
      return;
    }
    box.className = 'control-result error';
    box.innerHTML = `<div>发现 ${failed.length} 项异常：</div>
      <ul class="feed">${failed.map((check) => `
        <li><span class="chip bad">异常</span><span>${esc(HEALTH_CHECK_LABELS[check.name] || check.name)}${check.detail ? `：${esc(check.detail)}` : ''}</span></li>`).join('')}</ul>`;
  } catch (error) {
    box.className = 'control-result error';
    box.textContent = `体检失败：${error.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function loadControlObservability() {
  const btn = $('#control-observability-refresh');
  const box = $('#control-observability');
  if (!btn || !box) return;
  btn.disabled = true;
  box.className = 'control-result muted';
  box.textContent = '正在读取指标与审计…';
  const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;
  try {
    const [metrics, audit] = await Promise.all([
      api('/api/metrics'),
      api('/api/audit?limit=20')
    ]);
    const http = metrics.http || {};
    const statuses = http.requests?.byStatus || {};
    const queues = metrics.queues?.byState || {};
    const outbox = metrics.outbox?.byState || {};
    const unknown = metrics.unknown || {};
    const mcp = metrics.mcp || {};
    const disk = metrics.host?.disk || {};
    const unknownAge = Number(unknown.oldestAgeMs) > 0
      ? `${Math.max(1, Math.floor(Number(unknown.oldestAgeMs) / 86400000))} 天` : '-';
    const entries = Array.isArray(audit.entries) ? audit.entries : [];
    box.className = 'control-result';
    box.innerHTML = `
      <div class="update-deploy-summary">
        <div><span>进程 RSS</span><strong>${esc(mb(metrics.process?.rssBytes))}</strong></div>
        <div><span>堆内存</span><strong>${esc(mb(metrics.process?.heapUsedBytes))}</strong></div>
        <div><span>HTTP 请求 / p95</span><strong>${Number(http.requests?.total) || 0} / ${Number(http.latencyMs?.p95) || 0} ms</strong></div>
        <div><span>HTTP 5xx</span><strong>${Number(statuses['5xx']) || 0}</strong></div>
        <div><span>LLM 请求 / 兜底 / 失败</span><strong>${Number(metrics.llm?.requests) || 0} / ${Number(metrics.llm?.fallbackUses) || 0} / ${Number(metrics.llm?.failures) || 0}</strong></div>
        <div><span>入站队列 pending / leased / held</span><strong>${Number(queues.pending) || 0} / ${Number(queues.leased) || 0} / ${Number(queues.held) || 0}</strong></div>
        <div><span>出站 pending / failed</span><strong>${Number(outbox.pending) || 0} / ${Number(outbox.failed) || 0}</strong></div>
        <div><span>待核对 unknown / 最老</span><strong>${Number(unknown.total) || 0} / ${esc(unknownAge)}</strong></div>
        <div><span>MCP 重启中 / 累计重试 / 隔离生效</span><strong>${Number(mcp.restarting) || 0} / ${Number(mcp.restartAttempts) || 0} / ${Number(mcp.permissionActive) || 0}</strong></div>
        <div><span>磁盘已用</span><strong>${disk.usedPercent == null ? '不可用' : `${esc(disk.usedPercent)}%`}</strong></div>
        <div><span>OneBot</span><strong>${metrics.onebot?.connected ? '已连接' : '未连接'}</strong></div>
      </div>
      <div class="table-wrap" style="margin-top:10px"><table class="usage-table">
        <thead><tr><th>时间</th><th>操作</th><th>目标</th><th>结果</th></tr></thead>
        <tbody>${entries.length ? entries.map((entry) => `<tr>
          <td>${esc(fmtTime(entry.ts))}</td>
          <td>${esc(entry.action || '-')}</td>
          <td>${esc(entry.target || '-')}</td>
          <td>${entry.ok === false ? `<span class="chip bad">失败</span> ${esc(String(entry.error || '').slice(0, 80))}` : '<span class="chip">成功</span>'}</td>
        </tr>`).join('') : '<tr><td colspan="4" class="muted">还没有审计记录</td></tr>'}</tbody>
      </table></div>`;
  } catch (error) {
    box.className = 'control-result error';
    box.textContent = `指标读取失败：${error.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function loadBackupStatus() {
  const box = $('#control-backup-status');
  if (!box) return;
  box.className = 'control-result muted';
  box.textContent = '正在读取备份状态…';
  try {
    const data = await api('/api/backup/status');
    const files = Array.isArray(data.files) ? data.files : [];
    const mb = (bytes) => `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;
    box.className = 'control-result';
    box.innerHTML = `
      <div class="muted">目录：${esc(data.dir || '-')} · 密钥：${data.keyExists ? '已找到' : '未找到'}</div>
      <div class="table-wrap" style="margin-top:8px"><table class="usage-table">
        <thead><tr><th>备份文件</th><th>大小</th><th>时间</th><th></th></tr></thead>
        <tbody>${files.length ? files.map((file) => `<tr>
          <td>${esc(file.name)}</td>
          <td>${esc(mb(file.bytes))}</td>
          <td>${esc(fmtTime(file.mtime))}</td>
          <td><div class="settings-actions" style="margin:0">
            <button type="button" class="btn btn-small" data-backup-verify="${esc(file.name)}">校验</button>
            <button type="button" class="btn btn-small btn-danger" data-backup-restore="${esc(file.name)}">恢复</button>
          </div></td>
        </tr>`).join('') : '<tr><td colspan="4" class="muted">还没有备份文件</td></tr>'}</tbody>
      </table></div>
      ${data.restoreCli ? `<div class="hint" style="margin-top:8px">恢复（SSH）：<code>${esc(data.restoreCli)}</code></div>` : ''}`;
    box.querySelectorAll('[data-backup-verify]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        const out = $('#control-backup-output');
        if (out) { out.className = 'control-result muted'; out.textContent = '正在校验备份（dry-run）…'; }
        try {
          const result = await api('/api/backup/verify', {
            method: 'POST', body: JSON.stringify({ file: button.dataset.backupVerify })
          });
          if (out) {
            out.className = `control-result ${result.ok ? 'success' : 'error'}`;
            out.textContent = String(result.output || (result.ok ? '校验通过' : '校验失败')).slice(0, 4000);
          }
        } catch (error) {
          if (out) { out.className = 'control-result error'; out.textContent = `校验失败：${error.message}`; }
        } finally {
          button.disabled = false;
        }
      });
    });
    box.querySelectorAll('[data-backup-restore]').forEach((button) => {
      button.addEventListener('click', async () => {
        const file = button.dataset.backupRestore;
        const out = $('#control-backup-output');
        if (!await askForConfirmation(`恢复会用「${file}」覆盖当前数据目录。\n\n恢复前数据会留档到 data.pre-restore-*；服务会短暂停止并重启，控制台可能断开几秒。继续？`)) return;
        if (!await askForConfirmation('最后确认：真的执行恢复？恢复期间机器人离线，完成后刷新控制台。')) return;
        button.disabled = true;
        if (out) { out.className = 'control-result muted'; out.textContent = '恢复已排队，等待服务重启…'; }
        try {
          const result = await api('/api/backup/restore', {
            method: 'POST', body: JSON.stringify({ confirm: true, file })
          });
          if (out) { out.className = 'control-result success'; out.textContent = result.note || '恢复已排队'; }
        } catch (error) {
          if (out) {
            out.className = 'control-result error';
            out.textContent = `恢复请求中断（可能已开始）：${error.message}。完成后刷新页面确认服务状态。`;
          }
        } finally {
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    box.className = 'control-result error';
    box.textContent = `备份状态读取失败：${error.message}`;
  }
}

async function runBackupNow() {
  const btn = $('#control-backup-run');
  const out = $('#control-backup-output');
  if (!btn) return;
  if (!await askForConfirmation('立即执行一次加密备份？\n\n备份会短暂停止服务再重新拉起，控制台可能断开几秒；大实例需要几分钟。')) return;
  btn.disabled = true;
  if (out) { out.className = 'control-result muted'; out.textContent = '正在提交备份任务…'; }
  try {
    const result = await api('/api/backup/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (out) {
      out.className = `control-result ${result.ok ? 'success' : 'error'}`;
      out.textContent = String(result.note || (result.ok ? '备份已排队' : '备份失败')).slice(0, 4000);
    }
  } catch (error) {
    if (out) { out.className = 'control-result error'; out.textContent = `备份请求中断（可能已开始）：${error.message}`; }
  } finally {
    btn.disabled = false;
  }
}

async function runStorageCompress() {
  const btn = $('#control-storage-compress');
  const out = $('#control-storage-output');
  if (!btn) return;
  btn.disabled = true;
  if (out) { out.className = 'control-result muted'; out.textContent = '正在压缩…'; }
  try {
    const result = await api('/api/storage/compress', { method: 'POST', body: '{}' });
    const saved = Math.max(0, Number(result.bytesBefore) - Number(result.bytesAfter));
    if (out) {
      out.className = 'control-result success';
      out.textContent = `本次压缩 ${Number(result.compressed) || 0} 个留档，省 ${(saved / 1024 / 1024).toFixed(1)} MB；当前共 ${Number(result.storage?.files) || 0} 个文件。`;
    }
  } catch (error) {
    if (out) { out.className = 'control-result error'; out.textContent = `压缩失败：${error.message}`; }
  } finally {
    btn.disabled = false;
  }
}

async function loadGroupPolicy() {
  const box = $('#control-group-policy');
  if (!box) return;
  box.innerHTML = '<div class="muted" style="padding:8px">正在读取群策略…</div>';
  try {
    const data = await api('/api/group-policy');
    const rows = Array.isArray(data.rows) ? data.rows : [];
    box.innerHTML = rows.length
      ? `<table class="usage-table"><thead><tr><th>群</th><th>白名单</th><th>响应概率</th><th>会话模式</th><th>时间控制</th><th>群游戏</th><th>说说</th></tr></thead><tbody>
        ${rows.map((row) => `<tr>
          <td>${esc(row.chatKey)}</td>
          <td>${row.allowed ? '是' : '否'}</td>
          <td>${Number(row.randomPercent) || 0}%</td>
          <td>${esc(row.conversationMode || 'legacy')}</td>
          <td>${row.timeControl?.enabled ? (row.timeControl.active ? '活跃中' : '非活跃') : '未启用'}</td>
          <td>${row.groupGame ? '开' : '关'}</td>
          <td>${row.dailyMoments ? '开' : '关'}</td>
        </tr>`).join('')}
      </tbody></table>`
      : '<div class="muted" style="padding:8px">还没有已入库的群。</div>';
  } catch (error) {
    box.innerHTML = `<div class="control-result error">群策略读取失败：${esc(error.message)}</div>`;
  }
}

// 首次建结构后绑定一次事件即可（DOM 不再重建，不需要重复绑）
function bindControlHubHandlers() {
  const box = $('#control-page');
  if (!box) return;
  $('#control-refresh')?.addEventListener('click', () => loadControlHub({ force: true }));
  $('#control-health-run')?.addEventListener('click', runControlHealth);
  $('#control-observability-refresh')?.addEventListener('click', loadControlObservability);
  $('#control-backup-refresh')?.addEventListener('click', loadBackupStatus);
  $('#control-backup-run')?.addEventListener('click', runBackupNow);
  $('#control-storage-compress')?.addEventListener('click', runStorageCompress);
  $('#control-group-policy-refresh')?.addEventListener('click', loadGroupPolicy);
  void loadBackupStatus();
  void loadGroupPolicy();
  $('#auto-update-save')?.addEventListener('click', () => saveAutoUpdateSettings(false));
  $('#auto-update-run')?.addEventListener('click', runManualUpdate);
  $('#auto-update-resume')?.addEventListener('click', () => saveAutoUpdateSettings(true));
  $('#auto-update-pause')?.addEventListener('click', pauseAutoUpdate);
  // 「去设置」这种跳转按钮改由全局委托处理（见 init）：它现在出现在控制页、人物印象页、
  // 异常处理页、观测页——原来只绑 #control-page，别处的按钮点了没反应。
  // SnowLuma 改密钥的三格也是"正在输入"的 → 本地明文开关
  for (const field of ['current', 'new', 'confirm']) {
    bindPeekToggle(`snowluma-${field}-peek`, `snowluma-${field}-password`);
  }
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
  const revision = formatRevision;
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

  // QQ 登录状态：控制页的扫码入口旁边要能直接看到"登没登上"，不然用户扫码后
  // 还得回总览看 OneBot 状态。
  const onebot = state.status?.onebot || {};
  const qqState = document.getElementById('control-qq-state');
  if (qqState) {
    const nick = onebot.self?.nickname ? String(onebot.self.nickname) : '';
    const text = onebot.connected
      ? `OneBot 已连接${nick ? ` · ${nick}` : ''}`
      : (onebot.everConnected ? 'OneBot 未连接（曾连上过）' : 'OneBot 还没连上');
    setText(qqState, text);
    qqState.className = `chip ${onebot.connected ? 'ok' : (onebot.everConnected ? 'warn' : '')}`;
  }

  // 部署状态徽标
  const badge = box.querySelector('[data-hub-deploy-state]');
  if (badge) {
    setText(badge, updateState);
    const cls = 'control-service-state ' + (update.status === 'failed' ? 'offline' : update.enabled ? 'online' : '');
    if (badge.className !== cls) badge.className = cls;
  }

  // 版本与检查时间
  const summary = {
    current: versionWithRevision(state.appVersion, update.currentRevision),
    target: revision(update.targetRevision),
    lastCheck: update.lastCheckAt ? fmtTime(update.lastCheckAt) : '-',
    nextCheck: update.nextCheckAt ? fmtTime(update.nextCheckAt) : '-'
  };
  for (const [field, text] of Object.entries(summary)) {
    setText(box.querySelector('[data-hub-deploy="' + field + '"]'), text);
  }

  // 上次更新检查的说明也要跟着刷新：它原先只在首建 HTML 时渲染一次，之后 SSE 推来的新结论
  // （连不上 GitHub / 发现新 Release / 已是最新）都进不了这一行（2026-10-01 审查）。
  setText(box.querySelector('[data-hub-update-check]'), renderUpdateCheckNote(update));

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
    // 这句错误提示上（按钮也失效）——进度行同样会被吞掉。setBoxError 同时清 __renderedHtml。
    setBoxError(box, `<div class="empty-hint">服务状态读取失败：${esc(error.message)}</div>`);
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

// ── 发现新版本提示（只在控制台打开时检查一次；失败静默）───────────────────────
async function checkUpdateNotice() {
  // 容器部署由镜像管理：弹"发现新版本 / 立即更新"只会把用户引到一个点不动的按钮。
  if (state.config?.runtime?.container === true) return;
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

function openUpdateNoticeDialog(notice) {
  const dialog = $('#update-notice');
  if (!dialog) return;
  // deployed 是提交 SHA，截 7 位；revision 是 Release tag，不能按 SHA 截断
  //（v0.10.10 截成 v0.10.1 会被读成另一个版本）
  const shortSha = (value) => String(value || '').slice(0, 7);
  state.updateNoticeVersion = String(notice.version || '');
  $('#update-notice-title').textContent = notice.version ? `发现新版本 ${notice.version}` : '发现新版本';
  $('#update-notice-sub').textContent = [
    String(notice.name || '').trim(),
    `当前 ${shortSha(notice.deployed) || '未知'} → 最新 ${String(notice.revision || '').trim() || '未知'}`,
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

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// 登录框的 Token 是"正在输入"的（没有已保存的明文可回读）→ 本地明文开关，
// 免得粘贴/手打的 40 位令牌看不出对不对。
bindPeekToggle('console-token-peek', 'console-token');

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

function scheduleStatusRefresh() {
  if (state.statusRefreshTimer) return;
  state.statusRefreshTimer = setTimeout(() => {
    state.statusRefreshTimer = null;
    refreshStatus();
  }, 1500);
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
    if (state.tab === 'chats') scheduleChatsRefresh();
    scheduleStatusRefresh();
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
      // 用户正在详情里编辑（交接/备注输入框有焦点）时不要整块重绘：SSE 由模型写回触发，
      // loadMemoryDetail 会先写"加载中"再重建，把未保存的输入冲掉。只刷左侧列表。
      const detail = $('#memory-detail');
      const active = document.activeElement;
      const editing = Boolean(detail && active && detail.contains(active)
        && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || '') || active.isContentEditable));
      if (editing) renderMemoryList();
      else loadMemoryView();
    }
  });
  es.addEventListener('living-memory-update', (event) => {
    if (state.tab !== 'living-memory') return;
    // 每条消息都会产生 recall 事件；把它也当成整页刷新会让页面在聊天时不停重绘、丢焦点。
    let phase = '';
    try { phase = JSON.parse(event.data)?.phase || ''; } catch { /* 忽略坏帧 */ }
    if (phase === 'recall' || phase === 'recall-error') return;
    loadLivingMemoryPage({ force: true });
  });
  es.addEventListener('onebot-status', () => {
    refreshStatus();
    // 扫码登录后首启清单/控制页的 QQ 状态要立刻跟着变，不要等下一次 15s 轮询。
    if (state.tab === 'overview') loadOverview();
    if (state.tab === 'control') renderControlHub(state.integrationStatus || {});
  });
  es.addEventListener('asset-update', (event) => {
    if (state.tab !== 'assets') return;
    // 本地资产写入（编辑/新增/收录保存）在途：回声一律跳过 —— 保存流程自己会用
    // finishAssetMutation 重拉收尾，不挡的话会再触发一次"清空+重拉"
    // （双重重渲染 + 滚动被顶回顶部，2026-10-02 复审）。
    if (state.assetWriteInFlight) return;
    // delete 事件就地摘除（2026-10-02）：deleteAsset 已经在本地把条目和卡片摘掉了，
    // 这里若再走"清空 + 重拉"，整格缩略图会重闪一遍、滚动位置丢失 —— 用户看到的
    // 就是"删一张图整页刷新"。就地过滤是幂等的：自己的删除过滤后一无所获（不重渲染、
    // 不重复减计数），别人的删除才真的摘掉一条并重渲染。
    let payload = {};
    try { payload = JSON.parse(event.data || '{}'); } catch { /* 兼容空载荷 */ }
    // 在途守卫：服务端先广播 SSE、后回 DELETE 响应，自己的删除事件会比本地摘除先到。
    // 这条必须跳过，交给 deleteAsset 的本地流程收尾 —— 否则会提前整格重渲染（缩略图全部
    // 重闪、看起来像整页刷新）并把概览计数减两次（2026-10-02 用户实测「等好久才消失」）。
    if (payload.action === 'delete' && state.assetDeleteInFlight
      && state.assetDeleteInFlight.kind === payload.kind
      && state.assetDeleteInFlight.id === String(payload.id ?? '')) return;
    if (payload.action === 'delete' && (payload.kind === 'stickers' || payload.kind === 'slang')) {
      let removed = false;
      if (state.assetDetail && Array.isArray(state.assetDetail.entries)) {
        const key = String(payload.id ?? '');
        const before = state.assetDetail.entries.length;
        state.assetDetail = {
          ...state.assetDetail,
          entries: state.assetDetail.entries.filter((item) => String(item.id ?? '') !== key),
        };
        removed = state.assetDetail.entries.length !== before;
      }
      if (removed) {
        // 概览计数就地减一：汇总卡渲染的是 stickers.total / slang.total，不跟着减的话
        // 列表少一条而卡片还挂着旧数字（2026-10-02 复审：原先只减 stickers）。
        const bucket = state.assetOverview?.[payload.kind];
        if (bucket && typeof bucket.total === 'number') {
          bucket.total = Math.max(0, bucket.total - 1);
        }
        renderAssetObservatory();
      }
      return;
    }
    state.assetOverview = null;
    state.assetDetail = null;
    loadAssetObservatory();
  });
  es.addEventListener('identity-pilot-update', () => {
    // 本地身份/记忆的保存或删除在途：这条多半是自己请求的回声（服务端 /api/assets/identities
    // 写库、/api/assets/memory 经 refreshIdentityAfterAssetMutation 都会广播该事件）——
    // 跳过重拉，交给保存流程的 finishAssetMutation / 删除收尾自己刷新；不挡的话同一份数据
    // 拉两遍、页面闪两下（2026-10-02 复审 P1：资产页保存修好后，身份/记忆两处仍被这条回声穿透）。
    if (state.assetWriteInFlight || state.assetDeleteInFlight) return;
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
    // 与上面几个事件同一道守卫：载荷坏了不能把监听器抛出去（其它事件都有 try/catch，
    // 这里原来是裸的 —— 2026-10-01 审查）
    let d = null;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d?.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// 早起的轮询：配置还没读到，先用兜底间隔跑起来（配置就绪后 init() 里会再校准一次）。
// 2026-10-01 ESM 化：这一行原先是模块顶层的裸调用 —— 模块求值期就执行，而 app.js 会被
// core/state.js 的依赖链先求值（core/state.js ↔ app.js ↔ pages/* 是同一个 import 环），
// 那会儿 `state` 还在 TDZ 里 → Cannot access 'state' before initialization → 白屏。
// 顶层语句只留"注册/绑定 DOM"这类不读 state 的动作，真要开跑的挪进 init()。
// 真模块语义下加载整棵 ui/ 的用例（test/ui-real-modules.test.mjs）盯这件事。

async function loadSettings() {
  let cfg; let tplData; let provData; let visionData; let priceData;
  try {
    [cfg, tplData, provData, visionData, priceData] = await Promise.all([
      api('/api/config'),
      api('/api/persona-templates').catch(() => ({ templates: [], failed: true })),
      api('/api/providers').catch(() => ({ providers: [] })),
      api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
      api('/api/model-prices').catch(() => ({ prices: [], current: null }))
    ]);
  } catch (error) {
    // 配置接口是这一页的根数据，挂掉时整页渲染不了：要**看得见**地说一句，
    // 而不是留一个未处理的 Promise 拒绝（控制台里静默一片、页面还是上一次的内容）。
    // 其余四个接口各自带 .catch，所以只有 /api/config 会走到这里（2026-10-08 二轮审查）。
    setBoxError($('#settings-form'), `<div class="empty-hint">读取配置失败：${esc(error?.message || error)}</div>`);
    return;
  }
  state.config = cfg;
  // 配置已从服务端重读，页面上任何"未保存"提示都不再成立（切走再回来时尤其明显）。
  state.settingsDirty = false;
  state.modelReplacementDirty = {};
  state.modelReplacementTriggerDirty = {};
  // 外观以服务端为准再套一次（localStorage 那份只是"打开就生效"的快速通道）。
  // ⚠️ 但**明暗不能跟着服务端回放**：顶栏的主题按钮只写 localStorage（不落服务端配置），
  //    进设置页时若直接 applyAppearance(cfg.ui)，服务端存着的旧 mode 会把它盖回去 ——
  //    表现为"浅色模式下点设置自动变深色"（2026-10-19 用户实测）。与启动时同口径：
  //    其余轴按服务端，mode 用当前本地偏好，theme 传 undefined 防止它再覆盖一次。
  applyAppearance({ ...(cfg?.ui || {}), mode: getThemePref(), theme: undefined });
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

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

async function loadIdentityFeaturePage(options = {}) {
  const box = $('#identity-page');
  if (!box) return;
  // 竞态：连点两次筛选时，先发的请求后到会把后发的结果盖回去（2026-10-04 复审 P3）
  const token = ++state.identityLoadToken;
  if (!box.__renderedHtml) box.innerHTML = '<div class="empty-hint">正在读取人物与旧印象…</div>';
  try {
    const query = encodeURIComponent(state.identityFeatureQuery || '');
    const [cfg, status, identities, memories, chats] = await Promise.all([
      api('/api/config'),
      api('/api/identity-pilot/status'),
      api(`/api/assets/identities?limit=500&query=${query}`),
      api(`/api/assets/memory?query=${query}&limit=500`),
      api('/api/chats').catch(() => ({ chats: [] }))
    ]);
    if (token !== state.identityLoadToken) return;
    if (state.tab !== 'identity') return;
    state.config = cfg;
    state.chats = chats.chats || state.chats;
    syncGraduatedFeatureNavigation(cfg);
    renderIdentityFeaturePage(status, identities, memories, options);
  } catch (error) {
    // 序号守卫不能只护成功分支：重叠加载时**旧的那份**在新的已经渲染之后才失败，
    // 不挡的话「读取失败」会把后发的好结果整个盖掉（2026-10-04 复审 P2）。
    if (token !== state.identityLoadToken) return;
    setBoxError(box, `<div class="empty-hint">人物统一印象读取失败：${esc(error.message)}</div>`);
  }
}

async function loadFriendFeaturePageImpl() {
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
    setBoxError(box, `<div class="empty-hint">好友管理读取失败：${esc(error.message)}</div>`);
  }
}

async function loadIncidentFeaturePage(options = {}) {
  const box = $('#incident-page');
  if (!box) return;
  // 竞态：连点两次筛选时，先发的请求后到会把后发的结果盖回去（2026-10-04 复审 P3）
  const token = ++state.incidentLoadToken;
  if (!box.__renderedHtml) box.innerHTML = '<div class="empty-hint">正在读取异常日志…</div>';
  try {
    const params = new URLSearchParams({ limit: '200' });
    if (state.incidentState) params.set('state', state.incidentState);
    if (state.incidentSeverity) params.set('severity', state.incidentSeverity);
    if (state.incidentQuery) params.set('query', state.incidentQuery);
    const [cfg, data] = await Promise.all([
      api('/api/config'),
      api(`/api/incidents?${params}`)
    ]);
    if (token !== state.incidentLoadToken) return;
    if (state.tab !== 'incidents') return;
    state.config = cfg;
    syncGraduatedFeatureNavigation(cfg);
    renderIncidentFeaturePage(cfg, data.status || {}, data.incidents || [], options);
  } catch (error) {
    if (token !== state.incidentLoadToken) return;   // 同上：过期失败不许盖掉新结果
    setBoxError(box, `<div class="empty-hint">异常日志读取失败：${esc(error.message)}</div>`);
  }
}

/** 当前地址对应的设置原值：优先"该供应商自己的条"，没有退回全局（与服务端 effectiveThinkingRaw 同口径）。
 *  「跟随服务商默认」＝ 配置里没有具体思考要求（'on' / true / 未设置）。 */
function currentThinkingRaw(c) {
  const host = hostOfUrl(c.api?.baseUrl);
  const map = c.api?.thinkingByService;
  if (host && map && typeof map === 'object' && map[host] != null) return map[host];
  return c.api?.thinking;
}
/** 当前渠道可用的档位（内置=预设清单；自定义/表外=映射里的键）。 */
function thinkingStops(c) {
  const service = uiServiceOfUrl(c.api?.baseUrl);
  const params = c.api?.thinkingParams && typeof c.api.thinkingParams === 'object' && !Array.isArray(c.api.thinkingParams)
    ? c.api.thinkingParams : null;
  const levels = (!service || service.id === 'custom') && params
    ? ['off', 'low', 'medium', 'high', 'max'].filter((lv) => params[lv] && typeof params[lv] === 'object')
    : (service ? service.levels : []);
  return levels.filter((l) => ['off', 'low', 'medium', 'high', 'max'].includes(l));
}
/** 渲染一条档位分段（ChatGPT 式：一排档位块，选中项实心高亮）。
 *  只列当前渠道可用的档位；「跟随服务商默认」不是强度轴上的一个点，单独用勾选框表达；
 *  渠道没有可调档位时（未实测 / 官方不支持）不出控件，如实说明。
 *  withOn=true 时最左多一格「默认」（"聊天单独设档"的两条用它表达各行的默认）。 */
function renderThinkingSeg(id, stops, cur, service, withOn) {
  const offApprox = Boolean(service && service.canDisable === false);
  const label = (v2) => (v2 === 'on' ? '默认'
    : v2 === 'off' ? (offApprox ? '关闭（近似）' : '关闭')
      : ({ low: '低', medium: '中', high: '高', max: '最高' }[v2] || v2));
  const title = (v2) => (v2 === 'off' && offApprox
    ? '该渠道不支持真正关闭思考：将按最低档发送（实测）'
    : (v2 === 'on' ? '跟随服务商默认（不干预）' : ''));
  const all = withOn ? ['on', ...stops] : stops;
  return `<div class="seg" id="${id}" data-stops="${all.join(',')}" role="group" aria-label="思考模式">
      ${all.map((v2) => `<button type="button" class="seg-item${v2 === cur ? ' selected' : ''}" data-v="${v2}"${title(v2) ? ` title="${title(v2)}"` : ''}>${label(v2)}</button>`).join('')}
    </div>`;
}

// ── 模型选择/添加/删除 模态框 ──
/**
 * 关弹窗。先加 `.closing` 播退场（150ms：整层淡出 + 卡片微收 + 糊一下），再摘节点。
 * 为什么需要兜底计时器：`.closing` 只是个"变透明"的类，万一过渡没跑（用户开了"关闭全部动效"、
 * 或者浏览器不支持 `@starting-style` 那套），节点会一直挂在页面上 —— 那是"关不掉的弹窗"，
 * 比没有动画严重得多。所以 220ms 后无条件摘掉，且只摘一次。
 */
function closeModelModal(overlay) {
  if (!overlay || overlay.dataset.closing === '1') return;
  overlay.dataset.closing = '1';
  overlay.classList.add('closing');
  const done = () => { if (overlay.isConnected) overlay.remove(); };
  overlay.addEventListener('transitionend', (e) => { if (e.target === overlay) done(); });
  setTimeout(done, 220);
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

// ── 人设选择/添加 模态框 ──

// ── 标签页切换 ──
// ⚠️ 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
//    结果漏了 usage 分支 —— 点「用量」页签只切了视图、从不加载内容，
//    页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
//    两条路径各维护一份必然再次分叉，所以这里只准调 switchTab。
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});
// 侧栏待批徽标：点它进插件页，并让插件页自动打开第一条待批。
document.querySelector('[data-pending-badge]')?.addEventListener('click', (event) => {
  event.stopPropagation();
  try { sessionStorage.setItem('qa-plugin-pending-jump', '1'); } catch { /* 隐私模式：只少一次自动跳转 */ }
  switchTab('plugins');
});

// ── 启动 ──
async function init() {
  // 先在配置就绪之前把轮询跑起来（兜底间隔，见下面 startListPoller 的注释）——
  // 放到这里而不是模块顶层，是因为模块求值期读 state 会踩 TDZ。
  startListPoller();
  // 原生 select 的展开列表接管成主题内的 listbox（幂等，一次性委托）
  initSelectMenus();
  // 主题：先按本地偏好应用（index.html 的内联脚本已做过一次，这里同步按钮图标），
  // 再用后端配置覆盖（若用户换了设备，以后端为准）。
  applyTheme(getThemePref());
  applyAppearance(getAppearancePref());
  // 侧栏：绑定"悬停展开/失焦收起"与滑块对位（幂等，切页签时还会再同步一次）
  initSideNav();
  // 边缘折射：只绑定一次（幂等）。它自己挂 qqa:appearance / resize / DOM 变动的重扫，
  // 所以这里不用在每次 applyAppearance 之后再手动同步一次。
  initGlassRefract();
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    // 仅在"跟随系统"时响应系统主题变化
    mq?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  } catch { /* 老浏览器不支持 addEventListener，忽略 */ }
  $('#theme-btn')?.addEventListener('click', cycleTheme);
  // 侧栏图钉：点一下切换固定/悬停展开；外观面板改的同一项也要让这颗按钮跟着亮/灭
  $('#side-pin-btn')?.addEventListener('click', toggleSideRail);
  document.addEventListener('qqa:appearance', syncSideRailButton);
  syncSideRailButton();

  // 浮层（模型选择、确认框、定价弹窗…）都能用 Esc 关掉：三个构造器都把"怎么收尾"挂在
  // `.model-modal-close` 那颗按钮上，点它就等于走各家自己的收尾路径（Promise 不会悬着）。
  // 原生 <dialog> 自己处理 Esc，这里只管 .model-modal-overlay 这一类（2026-10-08 审查）。
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const overlays = document.querySelectorAll('.model-modal-overlay');
    overlays[overlays.length - 1]?.querySelector('.model-modal-close')?.click();
  });

  // 「去设置」按钮：全局委托一次。用 closest 现查，所以对"渲染时机"不敏感
  //（换成每页各自绑定，就会出现"某页的按钮点了没反应"）。
  document.addEventListener('click', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('[data-open-settings]') : null;
    if (!btn) return;
    // 入口不限于按钮：总览页的「去更新 / 看详情」是 <a href="#">，不拦默认行为就会把
    // 地址栏改成 `#` 并塞一条历史记录（对 <button> 调 preventDefault 无副作用）。
    ev.preventDefault();
    state.settingsSection = btn.dataset.openSettings;
    switchTab('settings');
  });

  // 「发现新版本」弹窗的三个按钮
  $('#update-notice-later')?.addEventListener('click', () => closeDialog($('#update-notice')));
  $('#update-notice-run')?.addEventListener('click', runUpdateFromNotice);
  $('#update-notice-ignore')?.addEventListener('click', ignoreUpdateVersion);

  // 「给模型定价」弹窗：入口在用量页（未定价提示条）与设置页（价格卡片），
  // 但按钮监听必须在这里一次性绑好 —— 挂在设置页渲染里会导致"从未打开设置页时
  // 弹窗里的按钮点了没反应"。
  $('#price-dialog-save')?.addEventListener('click', savePriceDialog);
  $('#price-dialog-delete')?.addEventListener('click', deletePriceDialog);
  $('#price-dialog-cancel')?.addEventListener('click', () => closeDialog($('#price-dialog')));
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
        // 兜底：早于这次登录发出的请求可能已经拿到 401 并把登录框弹了出来
        // （令牌此时已经生效，再让人输一遍没有意义）。api() 侧已经用地址栏令牌
        // 避免了这条 401，这里只处理其它来源留下的框。
        const loginDialog = $('#console-login');
        if (loginDialog?.open) loginDialog.close();
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
    // 其余外观轴也要在首屏就以后端为准（2026-10-12 审查）：此前只有打开设置页
    // （loadSettings → applyAppearance(cfg.ui)）才会套用，换设备首屏一直是默认外观。
    // 主题不由这里决定：把上面那块已经定下的有效值钉进 mode，让本次覆盖只动其余轴。
    if (cfg0 && 'ui' in cfg0 && cfg0.ui) {
      const effectiveTheme = THEME_VALUES.includes(t) ? t : getThemePref();
      applyAppearance({ ...cfg0.ui, mode: effectiveTheme, theme: undefined });
    }
  } catch { /* 接口不可用就用本地的 */ }

  // 发现新版本提示：打开控制台时查一次（后端缓存 30 分钟），失败静默
  checkUpdateNotice().catch(() => {});

  // 首启引导：关键配置（模型/白名单）没填时留在总览，让「开始使用」清单告诉用户
  // 还差哪几步，而不是直接甩进设置页（那样用户只看到一堆表单，不知道先填哪个）。
  try {
    // 复用上面那次 /api/config 的结果，少一次请求（首屏更快）
    const cfg = state.config || await api('/api/config');
    const allowReady = (Array.isArray(cfg.allow?.groups) && cfg.allow.groups.length > 0)
      || (Array.isArray(cfg.allow?.private) && cfg.allow.private.length > 0)
      || cfg.allowAllWhenEmpty === true;
    const ready = Boolean(cfg.api?.model) && allowReady;
    if (!ready) {
      // 启动兜底只负责补齐轮询；不要在这里强制切回总览 —— 用户可能已经在首屏
      // 点进了功能页（或从总览清单跳到设置），抢回来会让人刚打开的页面闪回。
      connectSSE();
      refreshStatus();
      startListPoller();   // 配置已就绪，把 4s 兜底轮询校准到 ui.refreshMs
      setInterval(() => { refreshStatus(); void refreshPendingBadge(); }, refreshIntervalMs(15000));
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(() => { refreshStatus(); void refreshPendingBadge(); }, refreshIntervalMs(15000));
  connectSSE();
  // 首次 startListPoller() 在配置加载前执行，会落到 4000ms 兜底值，导致会话列表每 4 秒重建一次（界面闪烁）；
  // 配置就绪后重新校准一次轮询间隔
  startListPoller();
  loadSessions();
  loadMemoryView();
  initSessionScrollLoader();
}

// 启动：**必须等模块图全部求值完**再跑 init。
// 2026-10-01 ESM 化：init 一上来就读 state（core/state.js ↔ app.js ↔ pages/* 是同一个
// import 环），模块求值期读它会踩 TDZ → "Cannot access 'state' before initialization" → 白屏。
//
// 判据是"还没 complete"，不是"还在 loading" —— **浏览器里 module 脚本执行期 readyState 已经是
// 'interactive'**（HTML 规范：解析结束后先置 interactive，再跑 defer/module 脚本，最后才发
// DOMContentLoaded 并把状态置成 complete）。第一版写成 `=== 'loading'`，本地剥壳沙箱与
// 强制 readyState 的用例都测不出来，真浏览器一打开就白屏（服务器烟测抓到，见 ADR 0005）。
// 只有脚本晚于 DOMContentLoaded 才走直接跑那一支（动态加载/极端缓存情形）。
if (document.readyState === 'complete') init();
else document.addEventListener('DOMContentLoaded', init, { once: true });


export {
  applyAppearance, applyTheme, closeModelModal, currentAppearance, currentThinkingRaw,
  getAppearancePref, getThemePref, loadFriendFeaturePage,
  loadIdentityFeaturePage, loadIncidentFeaturePage, loadSettings, modelModalShell, refreshStatus,
  renderBanner, renderControlHub, renderExperimentalSettingsSection, renderLifecycleOverview,
  renderSettings, renderThinkingSeg, setAppearance, switchTab, thinkingStops, updateProgressElapsed
};
