// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」第二轮：设置域）。
// 设置页事件绑定；跨文件引用走 import，可变状态挂 state（见 AGENTS.md）。
'use strict';
import { currentThinkingRaw, loadSettings, refreshStatus, renderSettings, switchTab } from '../app.js';
import { api } from '../core/api.js';
import { bindModelReplacementControls } from './model-replacement.js';
import { ASR_SERVICES, MODEL_SERVICES_UI, QZONE_RUN_LABELS } from '../core/constants.js';
import { askForConfirmation, bindPeekToggle, requestExperimentOwnerUin, syncClampedInputs } from '../core/dom-util.js';
import { bindKeyToggles, fetchRealKey } from './key-toggles.js';
import { $, $$, esc } from '../core/dom.js';
import {
  asrSlotOf, hostOfUrl, mulOf, paramActiveForProbability, segOfProbability, sliderDesc
} from '../core/format.js';
import { state } from '../core/state.js';
import { loadExperimentalFeatureStatuses } from './features.js';
import { bindAdminBriefingRunButton } from './moments.js';
import { openMemoryModelPicker } from './memory.js';
import {
  cancelLivingMemoryGraduation, launchExperimentalFeature, loadDailyMomentsStatus, loadGroupGameView, loadQzoneInteractionStatus,
  loadRemindersView, momentStatusLabel, renderMomentWindowRow
} from './moments.js';
import { renderSessionPicker } from '../core/session-picker.js';
import {
  applyPersonaDraft, currentPersonaId, defaultPersonaFold, openPersonaCreateModal, parsePersonaCard,
  personaBaseCardId, personaDraftDirty, personaSectionBody, savedPersonaId, syncPersonaButtons
} from './persona.js';
import { saveConfig } from './settings-save.js';
import { bindImageGenPreset, bindTtsControls } from './settings-voice.js';
import { bindHumanizePreset, bindHumanizeRecommend, bindProactiveWindowEditor, loadHumanizeState } from './chat.js';
import { bindSearchTest } from './search-test.js';
import { hydrateExtensionStatus } from './settings-extensions.js';
import {
  openBlocklistModal, openModelAddModal, openModelDeleteModal, openModelPicker, openPriceDialog,
  openWhitelistPicker, renderTimeRuleEditor, startListPoller, syncThinkingUi
} from './settings.js';
import { loadTimeControlStatus, updateTimeControlLiveState } from './status.js';
import {
  addChannelFeed, onChannelFeedAction, openBatchPriceModal, refreshModelPriceCard, renderChannelFeeds,
  renderPriceFeedStatus, runChannelProbe
} from './usage.js';
/**
 * 把"正在编辑的小节"落回草稿。分节编辑框不是唯一数据源（#cfg-roletext 才是），
 * 所以保存、折叠、恢复这些会重画视图的动作之前都得先冲一次，否则刚打的字会消失。
 * @returns {boolean} 有改动被落回时 true
 */
function flushPersonaSectionEdit() {
  if (state.personaEditingSection < 0) return false;
  const roleBox = $('#cfg-roletext');
  const box = document.querySelector(`#persona-card-view .pd-edit-text[data-sec="${state.personaEditingSection}"]`);
  if (!roleBox || !box) return false;
  // 输入框内容与"按渲染规则解析出来的正文"逐字一致 → 这一节根本没改过，别写回。
  // replacePersonaSectionBody 会规范化行尾空白与多余空行：原样写回也会让正文与卡文件不再逐字节相同，
  // 保存时 currentPersonaId() 按整串比较就把它当成"自定义" → 静默解绑内置卡（用户什么都没改）。
  if (box.value === personaSectionBody(roleBox.value, state.personaEditingSection)) return false;
  const next = replacePersonaSectionBody(roleBox.value, state.personaEditingSection, box.value);
  if (next === roleBox.value) return false;
  roleBox.value = next;
  return true;
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

// 跨页控件：群勾选列表与群日报试跑按钮分布在"群游戏 / 每日动态"两个页面上，
// bindSettingsEvents 里按 settingsSection 分块，只有当前页会执行 —— 放那里会出现
// "切到该页也一直显示正在读取群列表"（2026-09-28 实测：列表永远不填充）。
// 所以这一类"哪个页面都要能绑"的控件单独在这里、每次渲染都跑一遍。
function bindCrossSectionControls() {
  const digestRunBtn = $('#digest-run-btn');
  if (digestRunBtn && !digestRunBtn.dataset.bound) {
    digestRunBtn.dataset.bound = '1';
    digestRunBtn.addEventListener('click', async () => {
      const out = $('#digest-run-result');
      if (out) out.textContent = '生成中…（先保存设置再试跑）';
      try {
        const r = await api('/api/group-digest/run', { method: 'POST' });
        if (!out) return;
        if (r.skipped === 'no-chats') out.textContent = '没有配置群（chats 为空）';
        else if (r.skipped === 'already-running') out.textContent = '正在跑，稍等';
        else out.textContent = JSON.stringify(r.results || r).slice(0, 220);
      } catch (e) { if (out) out.textContent = `失败：${e.message}`; }
    });
  }
  bindAdminBriefingRunButton();
  // 这三处按设计只发群，allowFriends:false；选择在弹窗里完成，群再多也不撑高页面。
  renderSessionPicker('cfg-game-chats-box', state.config?.groupGame?.chats || [], { allowFriends: false, title: '允许开局的群' });
  renderSessionPicker('cfg-digest-chats-box', state.config?.groupDigest?.chats || [], { allowFriends: false, title: '群日报发到哪些群' });
  renderSessionPicker('cfg-briefing-chats-box', state.config?.adminBriefing?.chats || [], { allowFriends: false, title: '早报汇报哪些群' });
  // 定时提醒页：列表加载 + 取消按钮（事件挂在列表容器上做委托，行是动态渲染的）
  const pendBox = $('#reminders-pending');
  if (pendBox && !pendBox.dataset.bound) {
    pendBox.dataset.bound = '1';
    pendBox.addEventListener('click', async (e) => {
      const btn = e.target?.closest?.('.reminder-cancel-btn');
      if (!btn) return;
      const row = btn.closest('.reminder-row');
      if (!row) return;
      btn.disabled = true;
      try {
        await api('/api/reminders/cancel', { method: 'POST', body: JSON.stringify({ id: row.dataset.id, chatKey: row.dataset.chatkey }) });
        await loadRemindersView();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '重试';
        if ($('#reminders-pending')) $('#reminders-pending').title = String(err?.message || err).slice(0, 120);
      }
    });
  }
  if ($('#settings-reminders')) {
    loadRemindersView();
    const refreshBtn = $('#reminders-refresh-btn');
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = '1';
      refreshBtn.addEventListener('click', loadRemindersView);
    }
  }
  // 群游戏「正在进行的局」：进这一页拉一次，刷新与结束按钮都在这里绑
  if ($('#gg-running')) {
    loadGroupGameView();
    const ggRefresh = $('#gg-refresh-btn');
    if (ggRefresh && !ggRefresh.dataset.bound) {
      ggRefresh.dataset.bound = '1';
      ggRefresh.addEventListener('click', loadGroupGameView);
    }
    const ggBox = $('#gg-running');
    if (ggBox && !ggBox.dataset.bound) {
      ggBox.dataset.bound = '1';
      ggBox.addEventListener('click', async (e) => {
        const btn = e.target?.closest?.('.gg-stop-btn');
        if (!btn) return;
        const row = btn.closest('.gg-row');
        if (!row) return;
        if (!await askForConfirmation('结束这一局？会往群里发一句"游戏到此为止"（身份与进行中的行动一并作废）。')) return;
        btn.disabled = true;
        btn.textContent = '结束中…';
        try {
          await api('/api/group-game/stop', { method: 'POST', body: JSON.stringify({ chatKey: row.dataset.chatkey }) });
          await loadGroupGameView();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '重试';
          ggBox.title = String(err?.message || err).slice(0, 120);
        }
      });
    }
  }
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

/** 是否"聊天单独设档"（配置里该供应商存的是按用途对象）。 */
function isSplitThinking(c) {
  const raw = currentThinkingRaw(c);
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw));
}

// 滑条填充色的终点必须对齐滑块**球心**：range 的球心在轨道两端各内缩半个球宽，
// 纯百分比渐变在低值时会露出"球和条没连上"的缝（2026-10-02 用户实测：10/60 时差约 6px；
// 另外两个滑条恰好停在高位、填充多出一两个像素盖住球心，所以看不出来）。用 calc 精确对齐。
// 18px 与 style.css 里 ::-webkit-slider-thumb 的宽度一致 —— 改样式时这里要同步。
const SLIDER_THUMB_PX = 18;
function sliderFillPos(ratio) {
  const n = Number(ratio);
  const r = Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  return `calc(${SLIDER_THUMB_PX / 2}px + ${Number(r.toFixed(4))} * (100% - ${SLIDER_THUMB_PX}px))`;
}

// 设置页事件绑定：原先 1544 行的单函数按安全边界切成 4 段；顺序、条件、守卫未动。
function bindSettingsEvents(c) {
  bindSettingsSaveAndSections();
  bindSettingsListsAndGroups(c);
  bindSettingsModelsAndKeys(c);
  bindSettingsPersonaAndVision();
  bindProactiveWindowEditor();
  bindHumanizePreset(); bindHumanizeRecommend(); if (state.settingsSection === 'chat') loadHumanizeState();
}

// ── 设置页绑定·第 1/4 段：保存按钮 + 实验/动态/语音三个分区块 ──
// 由原 bindSettingsEvents 按"两侧无共享局部名"的安全边界切出，语句一字未改。
function bindSettingsSaveAndSections() {
  if (state.settingsSection === 'time-control') bindTimeControlEvents();
  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    // 人设页的分节编辑框不是唯一数据源：#cfg-roletext 才是。保存前先把正在编辑的
    // 那一节落回草稿，否则"边编辑边点保存"会存下旧正文（界面还提示"已保存"）。
    if (flushPersonaSectionEdit()) {
      state.personaEditNote = '';
      syncPersonaButtons();
    }
    try {
      await saveConfig();
      const res = $('#cfg-save-result');
      res.textContent = '已保存 ✓';
      res.title = res.textContent;   // 胶囊里的状态行会省略，完整文案挂在 title 上
      res.classList.remove('saved-flash');
      void res.offsetWidth;
      res.classList.add('saved-flash');
      // 回填被夹过的字段（服务端存下来的值可能与框里显示的不一样）
      syncClampedInputs();
      // 回填会补发 input 事件，清"未保存"必须放在它之后。
      state.settingsDirty = false;
      const dirty = $('#cfg-dirty-note'); if (dirty) dirty.textContent = '';
      // 保存成功后，人设页那条"还没生效"的提示就没意义了，清掉它
      if (state.settingsSection === 'persona') {
        state.personaEditNote = '';
        const note = $('#persona-edit-note');
        if (note) note.textContent = '';
      }
      refreshStatus().then(() => {
        // 省 Token 的"实际生效值"表按 /api/status 渲染：保存后要等状态回来再重画一次。
        if (state.settingsSection !== 'token-saver') return;
        const section = state.settingsSection;
        renderSettings();
        // 重画会换掉"已保存 ✓"节点，这里补写一次。
        if (state.settingsSection !== section) return;
        const again = $('#cfg-save-result');
        if (again) {
          again.textContent = '已保存 ✓';
          again.title = again.textContent;
          again.classList.remove('saved-flash');
          void again.offsetWidth;
          again.classList.add('saved-flash');
        }
      }).catch(() => {});
      startListPoller();   // 刷新间隔可能刚被改过，用新值重启轮询
      if (['knowledge', 'memes'].includes(state.settingsSection)) void hydrateExtensionStatus();
    } catch (e) {
      const res = $('#cfg-save-result');
      res.textContent = `保存失败：${e.message}`;
      res.title = res.textContent;
    }
  });

  if ((state.settingsSection || 'api') === 'experiments') {
    loadExperimentalFeatureStatuses();
    $('#lm-open-console')?.addEventListener('click', () => switchTab('living-memory'));
    $('#lm-ungraduate')?.addEventListener('click', () => cancelLivingMemoryGraduation().catch(() => {}));
    Object.entries({ '#launch-identity-feature': 'identity', '#launch-auto-friend-feature': 'auto-friend', '#launch-slang-feature': 'slang', '#launch-incident-feature': 'incidents', '#launch-living-memory-feature': 'living-memory' }).forEach(([selector, feature]) => {
      $(selector)?.addEventListener('click', () =>
        launchExperimentalFeature(feature).catch(() => {}));
    });
    ['#cfg-identity-pilot-enabled', '#cfg-auto-friend-enabled', '#cfg-slang-pilot-enabled', '#cfg-incident-pilot-enabled', '#cfg-living-memory-enabled'].forEach((selector) => {
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
        if (selector === '#cfg-living-memory-enabled') state.config.livingMemory = { ...(state.config.livingMemory || {}), enabled: toggle.checked === true };
        toggle.disabled = true;
        const result = $('#experiment-launch-result');
        if (result) result.textContent = '保存中…';
        try {
          await saveConfig({ quiet: true });
          if (selector === '#cfg-living-memory-enabled') { // 原地更新，避免整页重渲染让卡片闪一下
            toggle.disabled = false; if (result) result.textContent = '已保存';
            void loadExperimentalFeatureStatuses(); return;
          }
          renderSettings();
        } catch (error) {
          toggle.checked = !toggle.checked;
          if (selector === '#cfg-living-memory-enabled' && state.config?.livingMemory) state.config.livingMemory = { ...state.config.livingMemory, enabled: toggle.checked === true };
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

  // 语音转文字：模式（免费本机 / API Key）切换字段；服务预设填地址；模型从官网拉
  if ((state.settingsSection || 'api') === 'asr') {
    const modeSel = $('#cfg-asr-mode');
    const serviceSel = $('#cfg-asr-service');
    const syncAsrFields = () => {
      const mode = modeSel ? modeSel.value : 'local';
      const localBox = $('#asr-local-mode');
      const apiBox = $('#asr-api-mode');
      if (localBox) localBox.style.display = mode === 'local' ? '' : 'none';
      if (apiBox) apiBox.style.display = mode === 'api' ? '' : 'none';
      // 地址/模型行按"这家要不要地址"决定（火山/讯飞/腾讯/百度都不要），别再写死供应商名单
      const picked = ASR_SERVICES.find((x) => x.id === (serviceSel ? serviceSel.value : ''));
      const openaiFields = $('#asr-openai-fields');
      if (openaiFields) openaiFields.style.display = picked?.needsBaseUrl === false ? 'none' : '';
    };
    if (modeSel) modeSel.addEventListener('change', syncAsrFields);
    if (serviceSel) serviceSel.addEventListener('change', () => {
      const item = ASR_SERVICES.find((x) => x.id === serviceSel.value);
      const urlEl = $('#cfg-asr-baseurl');
      const modelEl = $('#cfg-asr-model');
      if (item && !item.needsBaseUrl) {
        // 这一家不用地址与模型（火山/讯飞/腾讯/百度）：清掉，免得把别家的旧值带过去
        if (urlEl) urlEl.value = '';
        if (modelEl) modelEl.value = '';
      } else if (item && urlEl) {
        const changed = urlEl.value.trim() !== String(item.baseUrl).trim();
        urlEl.value = item.baseUrl;
        // 换了一家就清掉模型：各家模型名不通用，留着会"看起来配好了、实际每次调用必失败"（审查抓到）
        if (changed && modelEl) modelEl.value = '';
      }
      // 拉过的列表属于上一家，一起收起来
      const pick = $('#cfg-asr-model-pick');
      if (pick) { pick.style.display = 'none'; pick.innerHTML = ''; }
      const modelsHint = $('#asr-models-hint');
      if (modelsHint) modelsHint.style.display = 'none';
      // 字段显隐/说明按新服务整体重画：比逐个 toggle 可靠（服务多了以后容易漏）
      // 先把当前草稿落到 state.config 上，重画才不会把它们丢回去
      const draft = state.config || {};
      const prevAsr = draft.asr || {};
      const nextProvider = item?.provider || 'openai';
      const nextBaseUrl = urlEl ? urlEl.value : (draft.asr?.baseUrl || '');
      // 凭据按"这家存过没有"自动填回（2026-10-02 用户要求：切换服务预设时 Key 跟着切换）：
      // 存过 → 显示掩码（保存时服务端取回这家存过的那把）；没存过 → 留空等用户填。
      // 槽位口径与后端 asrCredentialSlot 一致；keySlots 是服务端下发的布尔口径（不下发明文）。
      const slot = asrSlotOf(nextProvider, nextBaseUrl);
      const slotKinds = draft.asr?.keySlots?.[slot] || [];
      const setCred = (id, kind) => {
        const el = $(id);
        if (el) el.value = slotKinds.includes(kind) ? '******' : '';
      };
      setCred('#cfg-asr-key', 'apiKey');
      setCred('#cfg-asr-secretid', 'secretId');
      setCred('#cfg-asr-secretkey', 'secretKey');
      // 与旧行为对齐的"换了一家"判据：凭据域（槽位）变了没有
      const serviceChanged = slot !== asrSlotOf(prevAsr.provider, prevAsr.baseUrl);
      draft.asr = {
        ...(draft.asr || {}),
        provider: item?.provider || 'openai',
        baseUrl: urlEl ? urlEl.value : (draft.asr?.baseUrl || ''),
        model: modelEl ? modelEl.value : (draft.asr?.model || ''),
        appId: $('#cfg-asr-appid')?.value ?? draft.asr?.appId,
        apiKey: ($('#cfg-asr-key')?.value || '') === '******' ? draft.asr?.apiKey : ($('#cfg-asr-key')?.value || draft.asr?.apiKey),
        secretId: ($('#cfg-asr-secretid')?.value || '') === '******' ? draft.asr?.secretId : ($('#cfg-asr-secretid')?.value || draft.asr?.secretId),
        secretKey: ($('#cfg-asr-secretkey')?.value || '') === '******' ? draft.asr?.secretKey : ($('#cfg-asr-secretkey')?.value || draft.asr?.secretKey),
        hasApiKey: Boolean($('#cfg-asr-key')?.value),
        hasSecretId: Boolean($('#cfg-asr-secretid')?.value),
        hasSecretKey: Boolean($('#cfg-asr-secretkey')?.value),
        // 草稿层面的"凭据要重填"标记：保存后由服务端的 keyUsable/secretKeyUsable 接管。
        // 这家存过（已自动填回掩码）就不该再说"请重填"。
        credentialStale: serviceChanged && slotKinds.length === 0,
        keyUsable: serviceChanged ? slotKinds.includes('apiKey') : draft.asr?.keyUsable,
        secretIdUsable: serviceChanged ? slotKinds.includes('secretId') : draft.asr?.secretIdUsable,
        secretKeyUsable: serviceChanged ? slotKinds.includes('secretKey') : draft.asr?.secretKeyUsable
      };
      state.settingsSection = 'asr';
      // ⚠️ 这里**不能** renderSettings()（2026-10-03 全量审查）：那一整块重画会把同分区里其它
      // 还没保存的输入（TTS 的音色/语速、图片生成的模型/尺寸…）统统退回后端上次保存的值 ——
      // 与 2026-10-02「屏蔽名单搜索框只能输一个字」同族（那次是输入回调重画了含输入框自己的
      // 整栏，这次是切下拉把整块重画了）。同页的 TTS / 图片生成切换都是**就地更新**，这里对齐。
      const wants = (kind) => !item || (item.creds || []).includes(kind);
      const setFieldVisibility = (id, kind) => {
        const el = $(`#${id}`);
        if (el) el.style.display = wants(kind) ? '' : 'none';
      };
      setFieldVisibility('asr-appid-field', 'appId');
      setFieldVisibility('asr-key-field', 'key');
      setFieldVisibility('asr-secretid-field', 'secretId');
      setFieldVisibility('asr-secretkey-field', 'secretKey');
      const serviceNote = $('#asr-service-note');
      if (serviceNote) serviceNote.textContent = item?.note || '';
      const baseUrlRow = $('#asr-openai-fields');
      if (baseUrlRow) baseUrlRow.style.display = item && item.needsBaseUrl === false ? 'none' : '';
      syncAsrFields();
    });
    syncAsrFields();
    bindTtsControls();
    bindImageGenPreset();

    // 语音回复试听：合成一条样例在浏览器里播（不占群聊）
    const ttsTestBtn = $('#tts-test-btn');
    if (ttsTestBtn) ttsTestBtn.addEventListener('click', async () => {
      const out = $('#tts-test-result');
      if (out) out.textContent = '合成中…';
      try {
        const r = await api('/api/tts/test', { method: 'POST', body: JSON.stringify({ text: '大家好呀，我是小鲸鱼，这是一条试听。' }) });
        if (r.ok && r.audio) {
          const audio = new Audio(`data:audio/${r.format === 'wav' ? 'wav' : 'mpeg'};base64,${r.audio}`);
          await audio.play().catch(() => {});
          if (out) out.textContent = '已合成并开始播放（先保存设置再试听才生效）';
        } else if (out) out.textContent = r.error || '合成失败';
      } catch (e) { if (out) out.textContent = `失败：${e.message}`; }
    });

    // 图片生成：Key 提示（写清"不同域不复用模型 Key"这条守卫）+「显示」+「试画一张」
    {
      const keyHint = $('#cfg-img-key-hint');
      if (keyHint) {
        const g = state.config?.imageGen || {};
        const host = (u) => { try { return new URL(String(u || '')).host.toLowerCase(); } catch { return ''; } };
        const aHost = host(g.baseUrl || state.config?.api?.baseUrl);
        const bHost = host(state.config?.api?.baseUrl);
        const sameHost = Boolean(aHost && bHost && aHost === bHost);
        const hasOwnKey = Boolean(g.hasApiKey);
        // 存过的 Key 记着"是给哪家的地址存的"（imageGen.apiKeyHost）：换地址后它不再被使用，
        // 这里如实说明"要重填"，别让用户以为留空就还是它在生效（2026-10-01 审查 P1）。
        keyHint.textContent = g.keyStale === true
          ? `存过的 Key 是给 ${g.keyHost || '另一个地址'} 的，当前地址要重新填一次才生效（不会把旧 Key 发给新地址）。`
          : hasOwnKey
          ? '已存过 Key（留空 = 保持不变）。'
          : (sameHost
            ? '地址与聊天模型同域：留空就会复用模型那把 Key。想用别的账号或别的网关就单独填一把。'
            : '地址与聊天模型不同域：必须单独填 Key —— 不会把模型那把 Key 发到这里（防串用）。');
      }
      const imgTestBtn = $('#img-test-btn');
      if (imgTestBtn) imgTestBtn.addEventListener('click', async () => {
        const out = $('#img-test-result');
        if (out) out.textContent = '画图要十几秒到一分钟，稍等…';
        imgTestBtn.disabled = true;
        try {
          const r = await api('/api/imagegen/test', { method: 'POST', body: JSON.stringify({}) });
          if (r.ok && r.image) {
            if (out) out.innerHTML = `画好了（${Math.round((r.bytes || 0) / 1024)} KB，按张计费）<br><img src="${r.image}" alt="试画结果" style="max-width:260px;margin-top:6px;border-radius:var(--r-sm)" />`;
          } else if (out) {
            out.textContent = r.error || '画图失败';
          }
        } catch (e) { if (out) out.textContent = `失败：${e.message}`; }
        finally { imgTestBtn.disabled = false; }
      });
      // 「显示」按钮已并入统一的 keyToggles 表（下面），这里不再单独绑定 ——
      // 两处都监听同一个按钮会点一次触发两次，且只有那张表能正确处理「隐藏」。
    }
    // 拉模型列表：从服务商官网的 /models 拉（预设里的模型名会过时，官网不会）
    const fetchModelsBtn = $('#asr-fetch-models-btn');
    if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
      const hintEl = $('#asr-models-hint');
      const pick = $('#cfg-asr-model-pick');
      const url = $('#cfg-asr-baseurl')?.value?.trim() || '';
      if (!url) {
        if (hintEl) {
          hintEl.style.display = '';
          hintEl.textContent = '这一家（如火山 Seed-ASR）不用选模型，也就没有列表可拉；'
            + '只有 OpenAI 兼容的服务才需要：先在「服务预设」里选硅基流动 / Groq，或自己填服务地址。';
        }
        return;
      }
      fetchModelsBtn.disabled = true;
      if (hintEl) { hintEl.style.display = ''; hintEl.textContent = '正在从服务商拉取…'; }
      try {
        const submitted = ($('#cfg-asr-key')?.value || '').trim();
        const res = await api('/api/asr/models', {
          method: 'POST',
          body: JSON.stringify({ baseUrl: url, apiKey: submitted === '******' ? '' : submitted })
        });
        const models = res.models || [];
        if (!models.length) {
          if (hintEl) hintEl.textContent = '这家没有返回任何模型（列表是空的）。';
          return;
        }
        if (pick) {
          pick.style.display = '';
          pick.innerHTML = '<option value="">（选择一个模型）</option>'
            + models.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
          pick.onchange = () => { const field = $('#cfg-asr-model'); if (field && pick.value) field.value = pick.value; };
        }
        if (hintEl) {
          // 被排除的语音合成（TTS）要说出来：否则用户对着官网的"语音"分类数数，会觉得我们漏了
          const ttsNote = res.ttsCount
            ? ` 另有 ${res.ttsCount} 个是文字转语音的（${(res.ttsSample || []).join('、')}${res.ttsCount > (res.ttsSample || []).length ? ' 等' : ''}）—— 它们不能转写，已排除。`
            : '';
          hintEl.textContent = res.speechOnly
            ? `这家有 ${res.speechCount} 个可转写的语音模型（共 ${res.total} 个模型）：${models.slice(0, 8).join('、')}${models.length > 8 ? ' …' : ''}。选一个即填入上面的模型框。${ttsNote}`
            : `这家没认出语音模型（共 ${res.total} 个），已把全部列出来；挑一个能转写的填进去，或直接手填模型名。`;
        }
      } catch (error) {
        const msg = String(error?.message ?? error);
        if (hintEl) {
          hintEl.textContent = /401|403|invalid|Forbidden|Token/i.test(msg)
            ? `服务商拒绝了这次请求（${msg}）—— 多数家要先有 Key 才给列模型：先把 Key 填进下面的输入框（新 Key 会随这次请求一起发过去），再点一次。`
            : `拉取失败：${msg}。也可以直接把模型名手填进上面的输入框。`;
        }
      } finally {
        fetchModelsBtn.disabled = false;
      }
    });

    // 「安装本机转写」：POST 起安装，然后轮询状态把进度写到那块 hint 里
    const installBtn = $('#asr-install-btn');
    if (installBtn) installBtn.addEventListener('click', async () => {
      const box = $('#asr-install-progress');
      const hint = $('#asr-install-hint');
      const paint = (st) => {
        if (!box) return;
        box.style.display = '';
        if (st.running) {
          const pct = st.percent != null ? ` ${st.percent}%` : '';
          box.textContent = `安装中：${st.phase || '准备中'}${pct}…（日志在下面，装完自动生效）`;
        }
      };
      installBtn.disabled = true;
      if (hint) hint.textContent = '正在启动安装…';
      try {
        await api('/api/asr/install', { method: 'POST' });
        // 轮询到结束（最多 35 分钟；构建 + 466MB 下载都算上）
        const deadline = Date.now() + 35 * 60 * 1000;
        for (;;) {
          const st = await api('/api/asr/install-status');
          paint(st);
          if (!st.running) {
            if (st.ok) {
              const msg = `安装完成 ✓ 已生效。<br><span class="muted">${esc((st.log || []).slice(-3).join(' / '))}</span>`;
              if (hint) hint.textContent = '';
              await loadSettings().catch(() => {});   // 重新拉配置：装完的路径要立刻显示出来
              renderSettings();
              // 重画会把上面那块提示连同节点一起换掉 —— 重画后再写一次（同「保存设置」提示的处理）
              const after = $('#asr-install-progress');
              if (after) { after.style.display = ''; after.innerHTML = msg; }
            } else if (box) {
              box.innerHTML = `安装失败：${esc(st.error || '看上面的输出')}<br><span class="muted">${esc((st.log || []).slice(-4).join(' / '))}</span>`;
            }
            break;
          }
          if (Date.now() > deadline) { if (box) box.textContent = '等待超时，可刷新页面看最新状态。'; break; }
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (error) {
        if (box) { box.style.display = ''; box.textContent = `启动失败：${String(error?.message ?? error)}`; }
      } finally {
        installBtn.disabled = false;
      }
    });

    // 「删除本机转写」：删的是托管目录（模型 + 构建产物），删前先确认
    const uninstallBtn = $('#asr-uninstall-btn');
    if (uninstallBtn) uninstallBtn.addEventListener('click', async () => {
      const box = $('#asr-install-progress');
      const ok = await askForConfirmation(`删除本机转写会移除已下载的模型与构建产物（约 500MB），配置里的路径也会清空。
之后语音消息会退回「听不了语音」，随时可以重新安装。

注意：只有安装脚本放在 <数据目录>/asr 里的文件会被删；你自己另外装的 whisper.cpp 或模型不会被碰。`
      );
      if (!ok) return;
      uninstallBtn.disabled = true;
      if (box) { box.style.display = ''; box.textContent = '正在删除…'; }
      try {
        const res = await api('/api/asr/uninstall', { method: 'POST', body: JSON.stringify({ confirm: true }) });
        const mb = res?.freedBytes ? `，释放 ${(res.freedBytes / 1048576).toFixed(0)}MB` : '';
        const kept = (res?.keptOutside || []).length
          ? `<br><span class="muted">这些不在托管目录里，没有删除：${esc((res.keptOutside || []).join(' / '))}</span>`
          : '';
        const msg = `已完整卸载本机转写${mb}。${kept}`;
        await loadSettings().catch(() => {});
        renderSettings();
        const after = $('#asr-install-progress');
        if (after) { after.style.display = ''; after.innerHTML = msg; }
      } catch (error) {
        if (box) box.textContent = `删除失败：${String(error?.message ?? error)}`;
      } finally {
        uninstallBtn.disabled = false;
      }
    });

  }
}

// ── 设置页绑定·第 2/4 段：空间互动/控制台令牌/搜索服务商/上下文层级/会话模式/群与层级 ──
// 由原 bindSettingsEvents 按"两侧无共享局部名"的安全边界切出，语句一字未改。
function bindSettingsListsAndGroups(c) {

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

  // 控制台 Token 这三格是"正在输入"的（没有已保存的明文可回读）→ 只做本地明文开关
  for (const field of ['current', 'new', 'confirm']) {
    bindPeekToggle(`cfg-console-token-${field}-peek`, `cfg-console-token-${field}`);
  }
  bindSearchTest();
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
      doubao: '#doubao-search-fields',
      tavily: '#tavily-search-fields',
      aggregate: '#aggregate-search-fields'
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
  // 新增时填的 Key 也是"正在输入"的（还没保存、没有回读端点）→ 本地明文开关，
  // 免得自己粘贴的那串 Key 看不出来对不对。
  bindPeekToggle('new-sp-apikey-peek', 'new-sp-apikey');
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
      // 滑条填充色（用 CSS 变量告诉样式当前百分比；终点对齐球心，见 sliderFillPos 注释）
      tierSlider.style.setProperty('--pos', sliderFillPos(pos / 100));
    };
    tierSlider.addEventListener('input', sync);
    sync();   // 初始同步一次
  }

  // ── 表情清单条数 / 每小时最多收藏：同款 1~60 滑条（2026-10-02 用户要求"做移动条"）。
  //    手感（用户当天又反馈"一卡一卡"）靠两件事：① step=0.1 —— 60 格的 step=1 拖起来一格一格跳，
  //    细步长跟手（显示与保存仍四舍五入成整数）；② 填充色按**原始值**算，不用四舍五入值，
  //    否则填充会比滑块慢半格。方向键单独处理成按 1 走（不然按十下才动一格）。
  for (const [sliderSel, nowSel] of [
    ['#cfg-sticker-max', '#cfg-sticker-max-now'],
    ['#cfg-sticker-collect-max', '#cfg-sticker-collect-max-now']
  ]) {
    const slider = $(sliderSel);
    if (!slider) continue;
    const now = $(nowSel);
    const syncStickerSlider = () => {
      const min = Number(slider.min) || 1;
      const max = Number(slider.max) || 60;
      const raw = Number(slider.value);
      const v = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : min;
      const text = String(Math.round(v));
      if (now && now.textContent !== text) now.textContent = text;   // 只在整数值变化时写 DOM
      slider.style.setProperty('--pos', sliderFillPos((v - min) / Math.max(1, max - min)));
    };
    slider.addEventListener('input', syncStickerSlider);
    slider.addEventListener('keydown', (event) => {
      const delta = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
      if (!delta) return;
      const min = Number(slider.min) || 1;
      const max = Number(slider.max) || 60;
      const cur = Number(slider.value);
      event.preventDefault();
      slider.value = String(Math.min(max, Math.max(min, Math.round(Number.isFinite(cur) ? cur : min) + delta)));
      syncStickerSlider();
    });
    syncStickerSlider();
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

  const ioProfile = $('#cfg-store-ioprofile'), ioCustom = $('#cfg-store-iocustom');
  const syncIo = () => { if (ioCustom) ioCustom.style.display = ioProfile?.value === 'custom' ? '' : 'none'; };
  ioProfile?.addEventListener('change', syncIo); syncIo();

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
      gSlider.style.setProperty('--pos', sliderFillPos(pos / 100));
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

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // #cfg-model 是 hidden input（模型只能从选择器里改，选完 loadSettings() 重渲染 → 这里会重跑），
  // 所以不挂 input 监听 —— 挂在 hidden input 上的 input 事件永远不会触发（2026-10-01 审查）。
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
}

// ── 设置页绑定·第 3/4 段：记忆/模型与密钥/连通性/服务预设/思考控制 ──
// 由原 bindSettingsEvents 按"两侧无共享局部名"的安全边界切出，语句一字未改。
function bindSettingsModelsAndKeys(c) {

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    const box = $('#mem-model-box');
    if (box) box.style.display = memUseChat.checked ? 'none' : '';
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());
  // ── 模型 API 区块事件 ──
  // 密钥输入框的「显示 / 隐藏」已抽到 ui/pages/key-toggles.js（该文件顶到 max-lines 上限）：
  // 表在那边，新增一处密钥只要往 KEY_TOGGLES 里加一行 + 接一条受守卫的回读端点。
  bindKeyToggles();
  // 点击文本框弹出选择模态框（无“选择”按钮）
  bindModelReplacementControls();
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  // 模型服务区的提示统一走这里：写 state + DOM，loadSettings() 重渲染后仍能显示
  // （此前保存成功会顺手重渲染，把刚写好的提示清掉，用户看不到结果）。
  function setProviderHint(text) {
    state.lastProviderHint = String(text || '');
    const el = document.getElementById('provider-action-hint');
    if (el) el.textContent = state.lastProviderHint;
  }
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

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    if (!base) { setProviderHint('当前 Base URL 为空'); return; }
    btn.textContent = '拉取中…';
    try {
      const key = await currentApiKey();
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      const models = r.models || [];
      setProviderHint(models.length
        ? `已拉取 ${models.length} 个模型：在弹窗里勾选加入；清单里没有的可在下面「模型 id」手填。`
        : '该地址返回了空列表：请在下面「模型 id」里手动填模型名（例：见服务预设下方的说明）。');
      openModelAddModal(base, key, models);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      const msg = String(e?.message ?? e);
      // 把"为什么拉不到"说清楚：401/403 基本都是 Key 不对（换服务后旧 Key 不会沿用）；
      // 404/无列表则是该服务不提供清单，让用户去手填，而不是以为功能坏了。
      const isAuth = /HTTP 40[13]|令牌|invalid|unauthorized|authentication|API key/i.test(msg);
      const isNoList = /HTTP 404|not found|no models|not support/i.test(msg);
      setProviderHint(isAuth
        ? `拉取失败：${msg} —— 多半是 Key 不对：换服务后请填这家的 API Key（旧 Key 不会自动沿用），或确认这家是否给这个地址发了 Key。`
        : isNoList
          ? `拉取失败：${msg} —— 该服务可能不提供模型列表，请在下面「模型 id」里手动填（例：见服务预设下方的说明）。`
          : `拉取失败：${msg}`);
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
    const norm = (u) => String(u || '').trim().replace(/[/]+$/, '');
    const baseUrl = $('#cfg-baseurl').value.trim();
    const rawKey = $('#cfg-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    const pid = $('#cfg-provider')?.value || '';
    // 先按选中项找；没有选中项（直接填地址的部署）就按地址匹配已有提供商——
    // 否则这类部署"给当前服务补个模型"会被误要求填 Key（2026-09-27 实测）。
    const cur = (state.providers || []).find((x) => x.id === pid)
      || (state.providers || []).find((x) => norm(x.baseURL) === norm(baseUrl));
    // 空/掩码 = 沿用已保存的 Key（合并块里预填的就是它）；只有填了新明文才覆盖。
    const keyKept = !rawKey || rawKey === '******';
    if (!baseUrl) { setProviderHint('请填写 Base URL'); return; }
    if (keyKept && !(cur && norm(cur.baseURL) === norm(baseUrl) && cur.hasKey)) {
      setProviderHint('请填写 API Key（新服务必须带密钥）'); return;
    }
    if (!models.length) { setProviderHint('请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'); return; }
    try {
      const preset = document.querySelector('#new-service-preset')?.value || '';
      const apiKey = keyKept ? '' : rawKey;
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models, preset }) });
      setProviderHint(r.created ? '已添加并切换为当前服务。' : '已保存（同地址合并模型，Key 未改动）。');
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      setProviderHint(`添加失败：${e.message}`);
    }
  });

  const newServicePreset = $('#new-service-preset');
  if (newServicePreset) newServicePreset.addEventListener('change', () => {
    const svc = MODEL_SERVICES_UI.find((x) => x.id === newServicePreset.value);
    const note = $('#new-service-note');
    const input = $('#cfg-baseurl');
    const oldHost = hostOfUrl(input?.value || '');
    if (svc && svc.id === 'custom' && input) {
      // 选「自定义」= 我要填自己的地址：清空地址框，思考区随之切到"未识别"的说明，
      // 而不是继续显示上一家的档位与提示（2026-09-28 实测反馈）。
      input.value = '';
    } else if (svc && svc.baseUrl && input) {
      input.value = svc.baseUrl;
    }
    const newHost = hostOfUrl(input?.value || '');
    if (note) note.textContent = svc ? svc.note : '';
    // 换了主机：Key 框里的掩码属于旧服务，清掉并提示——否则会拿旧 Key 去请求新服务，
    // 表现为"获取列表失败/401"，用户会误以为"这家拉不到列表"（2026-09-27 实测反馈）。
    const keyBox = $('#cfg-apikey');
    const hostChanged = oldHost !== newHost;
    if (keyBox && keyBox.value === '******' && oldHost && hostChanged) {
      keyBox.value = '';
      if (note) {
        note.textContent = newHost
          ? `${svc ? svc.note : ''}（换了服务：请填这家的 API Key）`
          : `${svc ? svc.note : ''}（请填你的服务地址与 API Key）`;
      }
    }
    syncThinkingUi(input?.value || '');
  });

  // 思考模式分段选择：委托到稳定容器（两条档位条随供应商切换会重建，委托保证点击始终有效）。
  // 点段位=显式选择：统一模式下自动取消「跟随默认」；分设模式下两条互不影响。
  const thinkingControls = $('#thinking-controls');
  const thinkingDefaultCb = $('#cfg-thinking-default');
  const thinkingSplitCb = $('#cfg-thinking-split');
  if (thinkingControls) {
    thinkingControls.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.seg-item');
      if (!btn) return;
      const seg = btn.closest('.seg');
      seg?.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('selected', b === btn));
      if (seg && seg.id === 'thinking-seg' && thinkingDefaultCb && !(thinkingSplitCb && thinkingSplitCb.checked)) {
        thinkingDefaultCb.checked = false;
        seg.classList.remove('dim');
      }
      state.thinkingTouched = true;
      // 记下"动的是哪一家的档位条"：换家后未重新点选时，保存不得把回退显示值物化到新家
      //（审查 2026-09-28）。三个入口（统一条/跟随默认/分设开关）同口径。
      state.thinkingTouchedHost = hostOfUrl($('#cfg-baseurl')?.value || '');
    });
  }
  if (thinkingDefaultCb) {
    thinkingDefaultCb.addEventListener('change', () => {
      const seg = document.getElementById('thinking-seg');
      if (seg) seg.classList.toggle('dim', thinkingDefaultCb.checked);
      state.thinkingTouched = true;
      state.thinkingTouchedHost = hostOfUrl($('#cfg-baseurl')?.value || '');
    });
    // 初始置灰同步不算"用户动过控件"
    const seg0 = document.getElementById('thinking-seg');
    if (seg0) seg0.classList.toggle('dim', thinkingDefaultCb.checked);
  }
  if (thinkingSplitCb) {
    thinkingSplitCb.addEventListener('change', () => {
      state.thinkingTouched = true;
      state.thinkingTouchedHost = hostOfUrl($('#cfg-baseurl')?.value || '');
      // 勾/取消即时重建两条档位条（不用等保存）
      syncThinkingUi($('#cfg-baseurl')?.value || '', undefined, thinkingSplitCb.checked);
    });
  }
  // 地址变化（选预设/手改）→ 思考区立即跟着换家，不用等保存
  const baseUrlInputForThink = $('#cfg-baseurl');
  if (baseUrlInputForThink) baseUrlInputForThink.addEventListener('input', () => syncThinkingUi(baseUrlInputForThink.value));
  // 自定义档位映射：边填边预览（解析失败就按空处理，不打断输入）
  const thinkingParamsInput = $('#cfg-thinking-params');
  if (thinkingParamsInput) thinkingParamsInput.addEventListener('input', () => {
    let parsed;
    try {
      const raw = thinkingParamsInput.value.trim();
      const o = raw ? JSON.parse(raw) : {};
      parsed = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch { parsed = {}; }
    syncThinkingUi($('#cfg-baseurl')?.value || '', parsed);
  });

  const probeThinkingBtn = $('#probe-thinking-btn');
  if (probeThinkingBtn) probeThinkingBtn.addEventListener('click', async () => {
    const out = $('#probe-thinking-result');
    const show = (text) => {
      state.lastProbeNote = text;   // 落到 state：设置页重渲染后结果还在，不再闪一下就没
      if (out) { out.textContent = text; out.style.display = ''; }
    };
    if (out) { out.textContent = '探测中…（发一条最小请求）'; out.style.display = ''; }
    // 快照：探测要几秒钟，响应回来时输入框可能已被改掉——合并与刷新一律用点击时的值
    //（否则"已实测"会标到没测过的地址上，审查 2026-09-28）。
    const urlNow = String(document.querySelector('#cfg-baseurl')?.value || '').trim();
    const pid = String(state.config?.api?.provider || '');
    const prov = (state.providers || []).find((x) => x && x.id === pid) || null;
    const sameProviderHost = !!(prov && hostOfUrl(prov.baseURL || '') === hostOfUrl(urlNow));
    const rawKeyNow = String(document.querySelector('#cfg-apikey')?.value || '').trim();
    const keyKept = !rawKeyNow || rawKeyNow === '******';
    // 与后端 storedKeyAllowedFor 同口径（整条 URL 归一化，不只比主机）——否则同主机不同路径
    // 的地址后端不会发已存 Key、前端却不给指引，用户只看到裸 401（复审 2026-09-28）。
    const normUrl = (v) => String(v || '').trim().replace(/\/+$/, '').toLowerCase();
    const knownUrls = [state.config?.api?.baseUrl, ...(state.providers || []).map((p) => p?.baseURL)]
      .map(normUrl).filter(Boolean);
    const knownHost = knownUrls.includes(normUrl(urlNow));
    probeThinkingBtn.disabled = true;
    try {
      // 用"你此刻选中的档位"实测（不用先保存）：分设模式发四行现值对象（后端按 chat 档实测），
      // 统一条发单值；勾了跟随默认按配置走；额外参数也按输入框现值（解析失败则退回已保存值）。
      let thinkingNow;
      if (document.querySelector('#cfg-thinking-default')?.checked) {
        thinkingNow = 'on';
      } else if (document.querySelector('#cfg-thinking-split')?.checked) {
        const segVal = (id) => document.querySelector(`#${id} .seg-item.selected`)?.dataset.v || '';
        thinkingNow = {};
        for (const key of ['chat', 'judge', 'write', 'default']) thinkingNow[key] = segVal(`thinking-seg-${key}`) || 'on';
      } else {
        thinkingNow = document.querySelector('#thinking-seg .seg-item.selected')?.dataset.v || undefined;
      }
      let extraNow;
      try {
        const raw = String(document.querySelector('#cfg-extra-body')?.value || '').trim();
        if (raw) extraNow = JSON.parse(raw);
      } catch { /* 输入框 JSON 非法：忽略，探测按已保存值走 */ }
      const r = await api('/api/providers/probe-thinking', {
        method: 'POST',
        body: JSON.stringify({
          // providerId 只在"实测地址就是该 provider 存的地址"时带上：否则结论会记到
          // 没被实测的 provider 名下（审查 2026-09-28）。
          providerId: sameProviderHost ? pid : '',
          model: state.config?.api?.model || '',
          thinking: thinkingNow,
          extraBody: extraNow,
          baseUrl: urlNow,
          apiKey: keyKept ? '' : rawKeyNow
        })
      });
      const res = r?.result || {};
      // 不整页 loadSettings()：那会把刚填、还没保存的地址/Key/档位抹掉（实测反馈）。
      // 只把探测结论并入本地状态，再就地刷新思考区（提示/摘要/档位条）。
      if (state.config?.api) {
        state.config.api.thinkingProbe = {
          checkedAt: Date.now(),
          ok: res.ok === true,
          canDisable: (res.canDisable === undefined ? null : res.canDisable),
          reasoningTokens: Number(res.reasoningTokens) || 0,
          note: String(res.note || '').slice(0, 300),
          baseUrl: urlNow
        };
      }
      syncThinkingUi(urlNow);
      const suffix = (keyKept && !knownHost && res.ok === false)
        ? '（提示：未保存的地址不会使用已保存的 Key；该服务需要鉴权时，先在上方填这家的 Key 再测。）'
        : '';
      show(`${res.note || '完成'}${suffix}`);
    } catch (e) {
      show(`失败：${e.message}`);
    } finally {
      probeThinkingBtn.disabled = false;
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
}

// ── 设置页绑定·第 4/4 段：视觉开关/人设编辑 ──
// 由原 bindSettingsEvents 按"两侧无共享局部名"的安全边界切出，语句一字未改。
function bindSettingsPersonaAndVision() {

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
  // 用户手动改交流策略后，点卡只换正文、不把刚选的档位吞掉（applyPersonaDraft 会消费并清掉）
  $('#cfg-behavior-profile')?.addEventListener('change', () => { state.personaProfileTouched = true; });
  // 角色正文：整段正文每敲一键都要重画分节视图（约 10ms），打字时按 140ms 合并成一次；
  // 失焦/提交立刻同步，不会留下过期视图。
  $('#cfg-roletext')?.addEventListener('input', () => {
    if (state.personaViewTimer) clearTimeout(state.personaViewTimer);
    state.personaViewTimer = setTimeout(() => { state.personaViewTimer = null; syncPersonaButtons(); }, 140);
  });
  $('#cfg-roletext')?.addEventListener('change', () => {
    if (state.personaViewTimer) { clearTimeout(state.personaViewTimer); state.personaViewTimer = null; }
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
            state.personaEditNote = '上一节已更新（还没生效）：确认无误后点底部那条「保存设置」。';
          }
          state.personaEditingSection = state.personaEditingSection === idx ? -1 : idx;
        } else if (button.classList.contains('pd-sec-save')) {
          const box = personaView.querySelector(`.pd-edit-text[data-sec="${idx}"]`);
          if (box) {
            roleBox.value = replacePersonaSectionBody(roleBox.value, idx, box.value);
            state.personaEditingSection = -1;
            // 刚保存的这一节保持展开：别让它立刻折回去，看起来像"没保存上"
            state.personaCollapsedSections.delete(idx);
            state.personaEditNote = '这一节已更新（还没生效）：确认无误后点底部那条「保存设置」。';
          }
        } else if (button.classList.contains('pd-sec-cancel')) {
          state.personaEditingSection = -1;
        } else if (button.classList.contains('pd-sec-revert')) {
          // 先落回正在编辑的那一节（可能是另一节），再恢复本节
          const flushed = flushPersonaSectionEdit();
          if (baseTpl?.builtin) {
            roleBox.value = replacePersonaSectionBody(roleBox.value, idx, personaSectionBody(baseTpl.text, idx));
            state.personaEditingSection = -1;
            state.personaCollapsedSections.delete(idx);
            state.personaEditNote = `${flushed ? '上一节已更新；' : ''}这一节已恢复成卡文件「${baseTpl.name}」里的写法（还没生效）：记得点底部的「保存设置」。`;
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
      if (idx === state.personaEditingSection) return;
      // 收起/展开会重画整个视图（viewKey 里含折叠集合）：先把正在编辑的另一节落回草稿，
      // 否则它的输入框会被按旧正文重建 —— 刚敲的字静默消失
      flushPersonaSectionEdit();
      if (state.personaCollapsedSections.has(idx)) state.personaCollapsedSections.delete(idx);
      else state.personaCollapsedSections.add(idx);
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
    state.personaEditingSection = -1;
    state.personaCollapsedSections = defaultPersonaFold(baseTpl.text);
    state.personaEditNote = `正文已恢复成卡文件「${baseTpl.name}」的原文（还没生效）：点底部的「保存设置」确认。`;
    syncPersonaButtons();
  });
  const expandBtn = $('#persona-expand-btn');
  if (expandBtn) expandBtn.addEventListener('click', () => {
    // 折叠会重画视图：先把正在编辑的那节落回草稿，否则输入框里的字会没
    flushPersonaSectionEdit();
    const total = parsePersonaCard($('#cfg-roletext')?.value || '').sections.length;
    // 只要还有展开的就全收，全收了就全展 —— 一个按钮两种状态，省一个开关
    if (state.personaCollapsedSections.size < total) {
      state.personaCollapsedSections = new Set(Array.from({ length: total }, (_, i) => i));
      expandBtn.textContent = '全部展开';
    } else {
      state.personaCollapsedSections = new Set();
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
      state.personaEditingSection = -1;
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
  // 换卡后"断奶"：清掉各群的会话交接与线程状态（不动聊天记录与记忆）
  const resetHandoffBtn = $('#persona-reset-handoff-btn');
  if (resetHandoffBtn) resetHandoffBtn.addEventListener('click', async () => {
    // 分节编辑框里的字还没落回 #cfg-roletext，先冲一次 —— 逐节编辑是主路径，漏了它
    // 下面这层判定读到的是旧正文，等于守卫白做（2026-10-12 独立审查）。
    flushPersonaSectionEdit();
    // 草稿还没保存就先拦：交接清了、人设没换，机器人还是原来的人设，看着像"清了个寂寞"
    //（用户反馈的"清空之后还是之前的人设"多半就卡在这一步，2026-10-12）。
    if (personaDraftDirty()) {
      const text = '人设改动还没保存：先点页面最底下的「保存设置」，再点「换人设后清空交接」。'
        + '现在清的话只会清掉它的工作备注，机器人还是原来的人设。';
      const hint = $('#persona-reset-handoff-hint');
      if (hint) hint.textContent = text;
      alert(text);
      return;
    }
    const NL = String.fromCharCode(10);
    const confirmed = await askForConfirmation(
      '清空所有群的【上次会话交接】并关闭进行中的对话线程？' + NL + NL
      + '· 不删聊天记录、不删记忆（只清"交接"与线程状态）' + NL
      + '· 换完角色卡后点它，可以避免它继续沿用上一张卡的口癖与自称'
    );
    if (!confirmed) return;
    resetHandoffBtn.disabled = true;
    try {
      const res = await api('/api/persona/reset-handoffs', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      const hint = $('#persona-reset-handoff-hint');
      // 有在途运行时要如实提示：那一轮结束时会把换卡前的交接写回（后端在 note 里写明了）。
      const activeNote = res.note ? ` ${res.note}` : '';
      if (hint) hint.textContent = `已清空 ${res.chats || 0} 个群的交接（关闭了 ${res.threadsClosed || 0} 个进行中的线程）。${activeNote}`;
    } catch (error) {
      const hint = $('#persona-reset-handoff-hint');
      if (hint) hint.textContent = `清空失败：${error?.message ?? error}`;
    } finally {
      resetHandoffBtn.disabled = false;
    }
  });

  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    // 正在用的正文是"拷进配置的快照"，删卡不会把它一起删掉 —— 用着这张卡时先把这层说破，
    // 否则"删了卡以为就换人设了"（2026-10-12 用户反馈）。
    const wasInUse = savedPersonaId() === id;
    const NL = String.fromCharCode(10);
    if (!await askForConfirmation(`确定删除自定义人设「${tpl.name}」？`
      + (wasInUse
        ? NL + NL + '注意：机器人正在用的就是这张卡 —— 删除只是把卡从库里移走，它还会继续用这份正文；要真正换掉，删完点最底下的「保存设置」。'
        : ''))) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
      return;
    }
    // 删除已经成功；后面的刷新/回填失败**不能**再报"删除失败"（2026-10-09 审查：
    // loadSettings 失败时 personaTemplates 会是空对象，applyPersonaDraft(undefined) 抛
    // TypeError 被同一个 catch 吞掉 → 界面弹"删除失败"，而库里其实已经删掉了）。
    try {
      await loadSettings();
      const fallback = state.personaTemplates.xiaojingyu;
      if (fallback) applyPersonaDraft(fallback, 'xiaojingyu');
      if (wasInUse) {
        $('#persona-pick-hint').textContent = '已删除。机器人仍在用被删卡的那份正文 —— 点最底下的「保存设置」'
          + '换成默认卡（想用别的卡先在卡库点一张），换完建议再点一次「换人设后清空交接」。';
      }
    } catch (e) {
      $('#persona-pick-hint').textContent = `已删除，但人设卡刷新失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));
}
export { bindCrossSectionControls, bindSettingsEvents, captureTimeControlRule, isSplitThinking };
