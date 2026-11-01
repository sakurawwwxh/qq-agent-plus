// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import {
  loadFriendFeaturePage, loadIdentityFeaturePage, loadIncidentFeaturePage, refreshStatus, renderBanner,
  renderControlHub, switchTab
} from '../app.js';
import { api } from '../core/api.js';
import { THREAD_STATE_LABEL } from '../core/constants.js';
import { askForConfirmation, closeDialog, setStatusLabel, updateOnebotStatusLine } from '../core/dom-util.js';
import { $, esc } from '../core/dom.js';
import {
  chatNameOf, fmtRemainingMs, fmtTime, fmtTok, fmtTokens, fmtYuan, formatChatTitle, mulOf, onebotIssueText
} from '../core/format.js';
import {
  lifecycleRemainingText, lifecycleRunsFor, lifecycleStateOf, triggerKindLabel
} from '../core/lifecycle-labels.js';
import { state } from '../core/state.js';
import { loadChats } from './chat.js';
import { loadExperimentalFeatureStatuses } from './features.js';
import { loadDailyMomentsStatus, loadQzoneInteractionStatus } from './moments.js';
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

function renderLifecycleOverviewImpl(s) {
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

// 「更新部署」里的上次更新检查说明：口径是「已发布的 Release」，
// 让"连不上 GitHub / 没有新 Release / 当前部署领先"这些情况都能看见，而不是完全无声。
// 容器部署：更新是"换镜像"，控制台里的"立即更新"没有可执行的 systemd 服务。
function containerManaged() {
  return state.config?.runtime?.container === true;
}

function renderUpdateCheckNote(update = {}) {
  if (containerManaged()) {
    return '当前以 Docker 容器运行：应用由镜像管理。升级时先把 compose 里的 QQ_AGENT_IMAGE 改到目标版本，'
      + '再 docker compose pull && docker compose up -d（数据卷不动）。';
  }
  const short = (value) => (value ? String(value).slice(0, 12) : '-');
  const check = update.updateNotice && typeof update.updateNotice === 'object' ? update.updateNotice : null;
  if (!check || (!check.checkedAt && !check.error)) {
    return '更新检查尚未运行：打开控制台时会自动检查一次。';
  }
  const when = check.checkedAt ? `（${esc(fmtTime(check.checkedAt))}）` : '';
  if (check.available) {
    return `上次更新检查${when}：发现新版本${check.version ? ` ${esc(check.version)}` : ''}`
      + `（当前 ${esc(short(check.deployed))} → 最新 ${esc(String(check.revision || '-'))}`
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
    // 新口径是「本地版本 >= Release 版本」，不再断言提交层面"已包含"（版本相等但提交
    // 分叉的部署也会落到这里；文案不能比实际保证更强）。
    return `上次更新检查${when}：本地版本${check.localVersion ? ` ${esc(check.localVersion)}` : ''}`
      + `不低于最新 Release${check.version ? ` ${esc(check.version)}` : ''}`
      + `（${esc(short(check.deployed))}），无需更新。`;
  }
  if (check.reason === 'unknown-deployed') {
    return `上次更新检查${when}：没有部署基线（deployed-revision 为空），无法判断当前版本`
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

async function refreshAutoUpdateStatus() {
  try {
    state.autoUpdateStatus = await api('/api/auto-update/status');
    if (state.tab === 'control') renderControlHub(state.integrationStatus || {});
  } catch {
    // A deployment restart can briefly interrupt polling; EventSource and the
    // next interval will reconnect without replacing the current status.
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
  const result = $('#auto-update-result');
  if (containerManaged()) {
    if (result) {
      result.textContent = '容器部署请先把 compose 里的 QQ_AGENT_IMAGE 改到目标版本，再执行 docker compose pull && docker compose up -d';
      result.className = 'control-result muted';
    }
    return;
  }
  if (!await askForConfirmation('立即检查 GitHub 最新代码并尝试部署？服务会在部署阶段短暂重启。')) {
    return;
  }
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

async function runUpdateFromNotice() {
  const result = $('#update-notice-result');
  const runBtn = $('#update-notice-run');
  if (containerManaged()) {
    if (result) {
      result.textContent = '容器部署请先把 compose 里的 QQ_AGENT_IMAGE 改到目标版本，再执行 docker compose pull && docker compose up -d';
      result.className = 'control-result muted';
    }
    return;
  }
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
    closeDialog($('#update-notice'));
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
  closeDialog($('#update-notice'));
}

// ── 状态栏 ──
// 底座：status-refresh.js 用 QARegistry.override 接管，改动点在它那边。
async function refreshStatusImpl() {
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
    const shown = Math.max(Number(c?.ledgerCost) || 0, Number(c?.cost) || 0);
    const costTxt = shown > 0 ? ` · ¥${shown.toFixed(3)}` : '';
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


export {
  ignoreUpdateVersion, lifecycleAggregate, loadTimeControlStatus, pauseAutoUpdate, refreshAutoUpdateStatus,
  refreshStatusImpl, renderLifecycleOverviewImpl, renderUpdateCheckNote, resumePause, runManualUpdate,
  runUpdateFromNotice, timeControlTargetOptions, updateTimeControlLiveState
};