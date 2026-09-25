'use strict';

// app.js 的 refreshStatus 同时承担顶部状态栏和业务页面刷新。
// chat-update / 15 秒状态轮询都会调用它，导致好友管理页被整页重建并闪烁。
// 这里仅保留全局状态与必要的当前页状态刷新；好友工作流由
// identity-pilot-update、切页、手动刷新和审批操作各自负责刷新。
refreshStatus = async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    // 前端构建戳变了 → 服务端已更新，提示刷新。
    // 控制台是单页应用：部署只换服务器上的文件，已打开的页面还在跑旧 JS/CSS，
    // 此前只能靠人记得按 F5（2026-09-26 用户反馈"服务器上的没变"就是这么来的）。
    if (s.uiBuild) {
      if (!state.uiBuildAtLoad) state.uiBuildAtLoad = s.uiBuild;
      else if (state.uiBuildAtLoad !== s.uiBuild && !document.querySelector('#ui-build-banner')) {
        const banner = document.createElement('button');
        banner.id = 'ui-build-banner';
        banner.type = 'button';
        banner.textContent = '控制台已更新 · 点击刷新';
        banner.addEventListener('click', () => location.reload());
        document.body.appendChild(banner);
      }
    }
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    // 状态条被顶栏高度锁死、超长会截断，所以失败原因只放 title（悬停可见）
    const obIssue = onebotIssueText(s.onebot);
    dot.title = obIssue ? `OneBot：${obIssue}` : 'OneBot 连接状态';
    label.title = obIssue;
    label.textContent = s.onebot.connected
      ? `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
      : 'OneBot 未连接';
    setStatusLabel('#model-label', `模型：${s.orchestrator.model || '未设置'}`);
    const u = s.usage;
    const c = s.cost;
    const costTxt = c && c.cost > 0 ? ` · ¥${c.cost.toFixed(3)}` : '';
    // 口径后缀与 app.js 保持一致：包月/倍率/未定价都要在顶栏说明，别让金额被误读
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
    // 与 app.js 的状态处理同一语义：首次状态到达后放开运行模式下拉
    // （index.html 初始为 disabled，避免把"还没加载"看成"观察模式"）
    const runtimeMode = $('#runtime-mode');
    if (runtimeMode && runtimeMode.disabled) runtimeMode.disabled = false;
    if (runtimeMode) runtimeMode.value = s.orchestrator.mode || 'observe';
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
    if (state.tab === 'incidents') loadIncidentFeaturePage();
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
};

// 生命周期线程可能在某次模型 Session 已经结束之后，才由恢复循环因为空闲/硬上限
// 真正关闭。旧 Session 因此不一定有 threadCloseReason；会话详情仍保留了当时的
// idleDeadline / hardDeadline / resumeArmedUntil，可据此恢复一个可解释的结束原因。
const LIFECYCLE_CLOSE_REASON_LABELS = Object.freeze({
  'model-close': '模型主动结束生命周期',
  'mode-changed': '会话模式发生变化',
  'silent-idle': '监听状态空闲超时',
  'active-idle': '活跃状态空闲超时',
  'hard-lifetime': '达到生命周期硬上限，进入待续接窗口',
  'hard-lifetime-silent': '达到生命周期硬上限',
  'rollover-expired': '硬上限后的待续接窗口到期',
  'context-budget': '上下文预算达到上限，进入待续接窗口',
  expired: '续接窗口到期',
  closed: '生命周期已关闭'
});

function lifecycleEndReasonMeta(s) {
  if (s?.conversationMode !== 'lifecycle') return null;
  const aggregate = lifecycleAggregate(s);
  const lifecycle = aggregate?.lifecycle || {};
  const lifecycleState = lifecycle.state || lifecycleStateOf(s);
  if (lifecycleState !== 'closed') return null;

  const explicit = String(lifecycle.closeReason || s.threadCloseReason || '').trim();
  if (explicit) {
    return {
      text: LIFECYCLE_CLOSE_REASON_LABELS[explicit] || explicit,
      detail: `系统记录：${explicit}`
    };
  }

  const now = Date.now();
  const idleDeadline = Number(lifecycle.idleDeadline || s.threadIdleDeadline) || 0;
  const hardDeadline = Number(lifecycle.hardDeadline || s.threadHardDeadline) || 0;
  const resumeArmedUntil = Number(lifecycle.resumeArmedUntil || s.threadResumeArmedUntil) || 0;
  const lastState = String(s.threadState || '');

  // 生命周期曾处于活跃态且硬上限后的续接窗口也已经过去：最终结束点是 rollover expiry。
  if (lastState === 'active' && hardDeadline > 0 && hardDeadline <= now
      && resumeArmedUntil > 0 && resumeArmedUntil <= now
      && (!idleDeadline || hardDeadline <= idleDeadline)) {
    return {
      text: '硬上限后的待续接窗口到期',
      detail: '根据历史截止时间推断'
    };
  }

  if (idleDeadline > 0 && idleDeadline <= now
      && (!hardDeadline || idleDeadline < hardDeadline)) {
    return {
      text: lastState === 'listening' ? '监听状态空闲超时' : '活跃状态空闲超时',
      detail: '根据历史截止时间推断'
    };
  }

  if (hardDeadline > 0 && hardDeadline <= now) {
    return {
      text: '达到生命周期硬上限',
      detail: '根据历史截止时间推断'
    };
  }

  if (resumeArmedUntil > 0 && resumeArmedUntil <= now) {
    return {
      text: '待续接窗口到期',
      detail: '根据历史截止时间推断'
    };
  }

  return { text: '生命周期已关闭', detail: '未记录具体关闭原因' };
}

// 不复制 app.js 的大段渲染逻辑，只在原生命周期摘要尾部追加“结束原因”。
const renderLifecycleOverviewBase = renderLifecycleOverview;
renderLifecycleOverview = function renderLifecycleOverviewWithEndReason(s) {
  const html = renderLifecycleOverviewBase(s);
  const reason = lifecycleEndReasonMeta(s);
  if (!html || !reason) return html;
  const item = `
      <div class="lifecycle-end-reason">
        <span>结束原因</span>
        <strong>${esc(reason.text)}</strong>
        <small>${esc(reason.detail)}</small>
      </div>`;
  return html.replace(/<\/section>\s*$/, `${item}\n    </section>`);
};

function installManualFriendReviewButton() {
  const refresh = $('#friend-feature-refresh');
  if (!refresh || $('#friend-manual-review')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small';
  button.id = 'friend-manual-review';
  button.textContent = '手动触发评分';
  button.title = '忽略自动触发条件，直接对指定 QQ 进行好友评分';
  button.disabled = state.config?.identityPilot?.friendProposal?.enabled !== true;
  refresh.parentNode.insertBefore(button, refresh);
  button.addEventListener('click', () => {
    openManualFriendReviewDialog().catch((error) => alert(`手动好友评分失败：${error.message}`));
  });
}

async function openManualFriendReviewDialog() {
  const data = await api('/api/identity-pilot/people?limit=500');
  const people = Array.isArray(data.people) ? data.people : [];
  const options = people.map((person) => {
    const name = person.primaryName || person.userId;
    const suffix = person.isFriend ? ' · 已是好友' : '';
    return `<option value="${esc(person.userId)}" data-chat="${esc(person.sourceChatKey || '')}">${esc(name)} · ${esc(person.userId)}${suffix}</option>`;
  }).join('');

  const overlay = modelModalShell({
    head: '手动触发好友评分',
    body: `
      <div class="hint" style="margin-bottom:12px">
        手动触发不检查概率、最低消息数、活跃天数、直接互动次数、抽签冷却或每日评估额度。
        如果对方已经是好友，仍会完整评分并生成 Session 审计，但不会生成或发送好友申请。
      </div>
      <div class="field">
        <label>从身份库选择（可选）</label>
        <select id="manual-friend-person">
          <option value="">手动输入 QQ 号</option>
          ${options}
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label>QQ 号</label>
          <input type="text" id="manual-friend-uin" inputmode="numeric" placeholder="123456789" />
        </div>
        <div class="field">
          <label>来源会话（可选）</label>
          <input type="text" id="manual-friend-chat" placeholder="group:群号 或 private:QQ号" />
        </div>
      </div>
      <div class="hint">来源会话留空时优先使用身份库最近来源；仍没有来源时按 private:&lt;QQ号&gt; 评分。</div>
      <div id="manual-friend-result" class="control-result muted" style="margin-top:12px" role="status"></div>`,
    foot: '<button type="button" class="btn" id="manual-friend-cancel">关闭</button>'
      + '<button type="button" class="btn btn-primary" id="manual-friend-run">开始评分</button>'
  });

  const select = overlay.querySelector('#manual-friend-person');
  const uinInput = overlay.querySelector('#manual-friend-uin');
  const chatInput = overlay.querySelector('#manual-friend-chat');
  const result = overlay.querySelector('#manual-friend-result');
  const runButton = overlay.querySelector('#manual-friend-run');

  overlay.querySelector('#manual-friend-cancel').addEventListener('click', () => closeModelModal(overlay));
  select.addEventListener('change', () => {
    const option = select.selectedOptions?.[0];
    if (!option?.value) return;
    uinInput.value = option.value;
    chatInput.value = option.dataset.chat || '';
  });

  runButton.addEventListener('click', async () => {
    const userId = uinInput.value.trim();
    const chatKey = chatInput.value.trim();
    if (!/^\d{1,15}$/.test(userId) || Number(userId) <= 0) {
      result.textContent = 'QQ 号必须是正整数。';
      result.className = 'control-result error';
      return;
    }
    if (chatKey && !/^(group|private):\d+$/.test(chatKey)) {
      result.textContent = '来源会话格式必须为 group:<群号> 或 private:<QQ号>。';
      result.className = 'control-result error';
      return;
    }

    runButton.disabled = true;
    result.textContent = '正在读取聊天证据并调用模型评分…';
    result.className = 'control-result muted';
    try {
      const response = await api('/api/identity-pilot/friend-review/manual', {
        method: 'POST',
        body: JSON.stringify({ userId, chatKey })
      });
      const review = response.review || {};
      const ratings = review.ratings || {};
      result.className = 'control-result success';
      result.innerHTML = `
        <strong>${esc(response.note || '评分完成')}</strong><br>
        总分：${esc(review.score ?? '-')} / 100 · 模型决定：${esc(review.decision || '-')}<br>
        质量 ${esc(ratings.quality ?? '-')} / 4 · 兴趣 ${esc(ratings.interest ?? '-')} / 4 ·
        互惠 ${esc(ratings.reciprocity ?? '-')} / 4 · 稳定 ${esc(ratings.stability ?? '-')} / 4<br>
        ${response.alreadyFriend
          ? '对象当前已经是好友：仅评分，不生成/发送好友申请。'
          : response.proposal
            ? '已生成好友候选；仍需管理员批准后才会发送好友请求。'
            : '未生成新的好友候选。'}
        ${response.friendSnapshotFresh === false
          ? `<br><span class="muted">注意：好友列表刷新失败，本次“是否已是好友”使用本地快照：${esc(response.friendSnapshotError || '')}</span>`
          : ''}`;
      await loadFriendFeaturePage();
    } catch (error) {
      result.textContent = `评分失败：${error.message}`;
      result.className = 'control-result error';
    } finally {
      runButton.disabled = false;
    }
  });
}

// 好友页原渲染完成后补一个手动入口，不改动 app.js 的大块页面实现。
const loadFriendFeaturePageBase = loadFriendFeaturePage;
loadFriendFeaturePage = async function loadFriendFeaturePageWithManualReview(...args) {
  const value = await loadFriendFeaturePageBase(...args);
  installManualFriendReviewButton();
  return value;
};
