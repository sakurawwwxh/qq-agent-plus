// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import { closeModelModal, modelModalShell, refreshStatus } from '../app.js';
import { api } from '../core/api.js';
import { CHAT_MSG_PAGE, STICKER_LEVELS } from '../core/constants.js';
import { askForConfirmation, initChatScrollLoader, patchKeyedList } from '../core/dom-util.js';
import { $, $$, esc } from '../core/dom.js';
import {
  chatNameOf, fmtTime, fmtTok, formatChatTitle, groupSliderPosForUi, ioProfileOf, normalizeStickerCollectMax,
  normalizeStickerMax, paramActiveForProbability, segOfProbability, sliderDesc, sliderToTierUI,
  sliderToTierUI_tierToSlider
} from '../core/format.js';
import { state } from '../core/state.js';

/** 主动开话题的一个时段行（新增/删除共用同一份 HTML，避免两处漂移）。 */
export function proactiveWindowRowHtml(window = {}) {
  const start = esc(String(window.start ?? '09:00'));
  const end = esc(String(window.end ?? '24:00'));
  return `
    <div class="tc-window pro-window">
      <div class="field"><label>开始</label><input class="pro-start" type="time" value="${start}" /></div>
      <div class="field"><label>结束</label><input class="pro-end" type="text" inputmode="numeric" value="${end}" placeholder="24:00" /></div>
      <button type="button" class="icon-btn pro-remove" title="删除时段" aria-label="删除时段">×</button>
    </div>`;
}

function proactiveWindowsForUi(activeHours) {
  const list = Array.isArray(activeHours?.windows)
    ? activeHours.windows
    : (activeHours?.start && activeHours?.end ? [activeHours] : []);
  return list
    .filter((window) => window?.start && window?.end)
    .map((window) => ({ start: window.start, end: window.end }));
}

/** 主动发言时段：加一行 / 删一行。保存端按 .pro-window 逐行读取，这里只改 DOM。 */
function bindProactiveWindowEditor() {
  const box = $('#pro-windows');
  if (!box) return;
  $('#pro-add-window')?.addEventListener('click', () => {
    box.insertAdjacentHTML('beforeend', proactiveWindowRowHtml({ start: '09:00', end: '24:00' }));
  });
  box.addEventListener('click', (event) => {
    const button = event.target.closest('.pro-remove');
    if (button) button.closest('.pro-window')?.remove();
  });
}

/** 风格预设只改界面上的人味参数；保存仍走同一份 saveConfig。 */
/** 推荐配置：拟人化全家桶一键就位（总开关/低档延迟/反AI/气泡整形）。改的是界面值，保存仍走 saveConfig。 */
function bindHumanizeRecommend() {
  const button = $('#humanize-recommend');
  if (!button) return;
  button.addEventListener('click', () => {
    const master = $('#cfg-humanize-enabled');
    if (master) master.checked = true;
    const set = (id, value) => { const node = $(id); if (node) node.value = value; };
    set('#cfg-humanize-delay-min', '0.5');
    set('#cfg-humanize-delay-max', '1.8');
    set('#cfg-humanize-delay-perchar', '12');
    state.settingsDirty = true;
    const note = $('#cfg-dirty-note');
    if (note) note.textContent = '已套用推荐配置（记得保存）';
  });
}

function bindHumanizePreset() {
  const select = $('#cfg-humanize-preset');
  if (!select) return;
  const presets = {
    natural: { min: '0.5', max: '1.8', perChar: '12' },
    active: { min: '0.3', max: '1.0', perChar: '8' },
    quiet: { min: '1.0', max: '3.0', perChar: '20' },
    companion: { min: '0.8', max: '2.5', perChar: '15' }
  };
  select.addEventListener('change', () => {
    const preset = presets[select.value] || presets.natural;
    const setValue = (id, value) => { const node = $(id); if (node) node.value = value; };
    setValue('#cfg-humanize-delay-min', preset.min);
    setValue('#cfg-humanize-delay-max', preset.max);
    setValue('#cfg-humanize-delay-perchar', preset.perChar);
    state.settingsDirty = true;
    const note = $('#cfg-dirty-note');
    if (note) note.textContent = '有未保存改动';
  });
}
/** 只读展示当前会注入提示词的状态；数值只给控制台看，不进提示词。 */
async function loadHumanizeState() {
  const box = $('#humanize-state-text');
  if (!box) return;
  try {
    const s = await api('/api/humanize/state');
    if (!s.enabled) { box.textContent = '拟人化表达未启用'; return; }
    if (!s.injected) {
      box.textContent = s.personaStateEnabled === false
        ? '状态功能已关闭（可在上方重新勾选）'
        : s.cardFirst
          ? '角色卡优先：状态不注入提示词（语气由角色卡决定）'
          : '当前档位不注入状态';
      return;
    }
    const energy = s.energy < 25 ? '低' : s.energy < 50 ? '偏低' : s.energy < 80 ? '正常' : '充足';
    const mood = s.mood > 25 ? '不错' : s.mood < -25 ? '较差' : s.mood < -10 ? '偏低' : '一般';
    const age = Math.max(0, Math.round((Date.now() - (Number(s.savedAt) || Date.now())) / 60000));
    box.textContent = `${s.activity}；精力${energy}，心情${mood}${age ? `；${age} 分钟前更新` : ''}`;
  } catch {
    box.textContent = '状态读取失败';
  }
}

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
  const storeSync = String(st.sqliteSynchronous || 'FULL').toUpperCase();
  const conversation = c.conversation || {};
  const proWindows = proactiveWindowsForUi(c.proactive?.activeHours);
  const humanize = c.humanize || {};
  const replyDelay = humanize.replyDelay || {};
  const delayMinMs = Number.isFinite(Number(replyDelay.minMs)) ? Number(replyDelay.minMs) : 500;
  const delayMaxMs = Number.isFinite(Number(replyDelay.maxMs)) ? Number(replyDelay.maxMs) : 1800;
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
    <details class="collapsible settings-advanced" id="wake-batch-advanced">
      <summary>高级：直接互动与攒批窗口</summary>
      <div class="field-row" style="margin-top:8px">
        <div class="field"><label for="cfg-direct-wake-delay">被 @ / 私聊 / 引用后的合并窗口（毫秒）</label>
          <input type="number" id="cfg-direct-wake-delay" min="0" max="2000" step="50" value="${esc(c.directWakeDelayMs ?? 300)}" />
          <div class="hint">直接互动不再等常规 8–12 秒，只留这点时间合并连发；默认 300，最大 2000。</div></div>
        <div class="field"><label for="cfg-max-batch-wait">普通消息最长攒批（毫秒）</label>
          <input type="number" id="cfg-max-batch-wait" min="100" max="20000" step="100" value="${esc(c.maxBatchWaitMs ?? 20000)}" />
          <div class="hint">连续来消息时最多等这么久就处理，默认 20000；调小更跟手，调大更容易合并。</div></div>
      </div>
    </details>

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
      <label for="cfg-proactive">会话安静时按概率发起话题</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pro-group" ${c.proactive?.groupEnabled !== false ? 'checked' : ''} />
      <label for="cfg-pro-group">群聊（独立节奏，按群白名单）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pro-private" ${c.proactive?.privateEnabled === true ? 'checked' : ''} />
      <label for="cfg-pro-private">私聊（独立节奏，按私聊白名单）</label></div>
    <div class="field-row">
      <div class="field"><label>判定方式</label><select id="cfg-pro-mode"><option value="shared" ${c.proactive?.scopeMode !== 'perChat' ? 'selected' : ''}>群聊/私聊各共用一次机会</option><option value="perChat" ${c.proactive?.scopeMode === 'perChat' ? 'selected' : ''}>每个群/私聊独立判定</option></select></div>
      <div class="field"><label>独立模式每轮最多开口</label><input type="number" id="cfg-pro-per-max" min="1" max="10" step="1" value="${esc(Number(c.proactive?.perChatMaxPerTick) || 2)}" /></div>
    </div>
    <div class="field pro-windows-field">
      <label>主动发言时段（仅在该时段内发起）</label>
      <div id="pro-windows" class="pro-windows">
        ${proWindows.map((window) => proactiveWindowRowHtml(window)).join('')}
      </div>
      <div class="settings-inline-actions">
        <button type="button" class="btn btn-small" id="pro-add-window">＋ 添加时段</button>
      </div>
      <div class="hint">${proWindows.length ? '按上面的时段生效；跨午夜会自动识别。' : '当前没有时段限制 = 全天都可以主动开口。'}</div>
    </div>
    <div class="field-row">
      <div class="field"><label>检查间隔下限（分钟）</label><input type="number" id="cfg-pro-min" min="1" value="${esc(Math.round((Number(c.proactive.checkIntervalMinMs) || 1800000) / 60000))}" /></div>
      <div class="field"><label>检查间隔上限（分钟）</label><input type="number" id="cfg-pro-max" min="2" value="${esc(Math.round((Number(c.proactive.checkIntervalMaxMs) || 5400000) / 60000))}" /></div>
      <div class="field"><label>触发概率（%）</label><input type="number" id="cfg-pro-prob" step="1" min="0" max="100" value="${esc(Math.round((Number(c.proactive.probability) || 0) * 100))}" /></div>
      <div class="field"><label>安静判定（分钟，至少 5 分钟）</label><input type="number" id="cfg-pro-idle" min="5" max="1440" step="1" value="${esc(Math.round((Number(c.proactive.idleThresholdMs) || 1800000) / 60000))}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pro-followup" ${c.proactive?.followUpEnabled !== false ? 'checked' : ''} />
      <label for="cfg-pro-followup">发言后无人回应时，稍后补一句</label></div>
    <div class="field-row" id="cfg-pro-followup-timing">
      <div class="field"><label for="cfg-pro-followup-delay">补话基准延迟（分钟）</label>
        <input type="number" id="cfg-pro-followup-delay" min="1" max="120" value="${esc(Number(c.proactive?.followUpDelayMinutes) > 0 ? Number(c.proactive.followUpDelayMinutes) : 10)}" /></div>
      <div class="field"><label for="cfg-pro-followup-cooldown">同一会话两次补话最小间隔（分钟）</label>
        <input type="number" id="cfg-pro-followup-cooldown" min="1" max="240" value="${esc(Number(c.proactive?.followUpCooldownMinutes) > 0 ? Number(c.proactive.followUpCooldownMinutes) : 20)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pro-selfwake" ${c.proactive?.selfWakeEnabled !== false ? 'checked' : ''} />
      <label for="cfg-pro-selfwake">允许模型给自己安排稍后的主动发言</label></div>
    <div class="hint">
      中间的「群聊 / 私聊」是范围：分别沿用「群白名单」与「私聊白名单」（deny 优先），两个都不勾就不主动开话题。
      群聊和私聊各自独立计时；默认「范围共用一次机会」= 每轮在所有群里挑一个、所有私聊里挑一个。选「每个群/私聊独立判定」后，每个会话各自按概率判定，并受「每轮最多开口」限制。
      后两条是补话与自安排唤醒，独立开关。完全不想让它主动开口，就把上面所有勾选都取消。
      私聊默认不勾：勾上后私聊白名单里的人（安静够久且没有未读时）也可能收到主动消息。
    </div>

    <h3>所有模式 · 回复行为</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-reply-guard" ${conversation.replyGuardEnabled !== false ? 'checked' : ''} />
      <label for="cfg-reply-guard">该回却没发时自动纠正一次（私聊 / 被 @ / 引用 / 点名）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-poke-reply" ${conversation.pokeReplyEnabled !== false ? 'checked' : ''} />
      <label for="cfg-poke-reply">拍一拍机器人时按直接互动回复（必回、即时处理）</label></div>
    <div class="hint">
      回复纠正只在“模型写了正文却没调用发送工具”时触发，会多跑一次模型；关掉后这类情况不再补救。
      拍一拍必回会跳过随机概率；关掉后拍一拍按普通群消息处理。
    </div>

    <h3>所有模式 · 失败兜底</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-failure-notice" ${c.failureNotice?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-failure-notice">模型最终失败时，直接互动（@ / 私聊 / 引用）回一句短说明</label></div>
    <div class="field"><label for="cfg-failure-notice-cooldown">同一会话冷却（分钟）</label>
      <input type="number" id="cfg-failure-notice-cooldown" min="1" max="240" value="${esc(Number(c.failureNotice?.cooldownMinutes) > 0 ? Number(c.failureNotice.cooldownMinutes) : 8)}" />
      <div class="hint">只在已经重试完仍失败时触发，不会暴露模型/密钥细节；普通群消息不会收到这条兜底。</div></div>

    <h3>所有模式 · 拟人化表达（实验性）</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-humanize-enabled" ${humanize.enabled === true ? 'checked' : ''} />
      <label for="cfg-humanize-enabled">启用拟人化表达与助手腔过滤</label>
      <button type="button" class="btn btn-small" id="humanize-recommend" style="margin-left:10px">推荐配置</button></div>
    <div class="field"><label for="cfg-humanize-preset">风格预设</label>
      <select id="cfg-humanize-preset">
        ${[['natural', '自然'], ['active', '活跃'], ['quiet', '安静'], ['companion', '陪聊']].map(([value, label]) =>
          `<option value="${value}" ${(humanize.preset || 'natural') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-humanize-delay-enabled" ${replyDelay.enabled !== false ? 'checked' : ''} />
      <label for="cfg-humanize-delay-enabled">发送前按字数延迟（私聊会先显示“正在输入”）</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-humanize-delay-min">最短等待（秒）</label>
        <input type="number" id="cfg-humanize-delay-min" min="0" max="30" step="0.1" value="${esc((delayMinMs / 1000).toFixed(1))}" /></div>
      <div class="field"><label for="cfg-humanize-delay-max">最长等待（秒）</label>
        <input type="number" id="cfg-humanize-delay-max" min="0" max="30" step="0.1" value="${esc((delayMaxMs / 1000).toFixed(1))}" /></div>
      <div class="field"><label for="cfg-humanize-delay-perchar">每字增加（毫秒）</label>
        <input type="number" id="cfg-humanize-delay-perchar" min="0" max="200" step="1" value="${esc(Number(replyDelay.perCharMs) || 0)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-humanize-antaienabled" ${humanize.antiAi?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-humanize-antaienabled">过滤助手式自指与客服收尾语</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-humanize-blocksevere" ${humanize.antiAi?.blockSevere !== false ? 'checked' : ''} />
      <label for="cfg-humanize-blocksevere">检测到明显的助手自指/免责时，要求重写一次</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-humanize-state-enabled" ${humanize.personaState?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-humanize-state-enabled">状态（精力/心情/当前活动）影响语气（同一人设跨群共享）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-humanize-relationship-enabled" ${humanize.relationship?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-humanize-relationship-enabled">记录与每个人的互动关系（仅对已有人物印象的人生效）</label></div>
    <div class="field"><label for="cfg-humanize-meme-level">梗密度（闲聊里的网络梗）</label>
      <select id="cfg-humanize-meme-level">
        <option value="off" ${(humanize.memeUse?.level || 'normal') === 'off' ? 'selected' : ''}>关闭：不主动用梗</option>
        <option value="light" ${(humanize.memeUse?.level || 'normal') === 'light' ? 'selected' : ''}>克制：只接对方用过的梗</option>
        <option value="normal" ${(humanize.memeUse?.level || 'normal') === 'normal' ? 'selected' : ''}>正常：贴合时用一次</option>
        <option value="heavy" ${(humanize.memeUse?.level || 'normal') === 'heavy' ? 'selected' : ''}>活跃：闲聊里更主动</option>
      </select>
      <div class="hint">只影响闲聊；技术、学习、情绪严肃场景仍不用梗。角色卡优先时也按这个档位收放。</div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-humanize-respect-card" ${humanize.respectPersonaCard !== false ? 'checked' : ''} />
      <label for="cfg-humanize-respect-card">角色卡优先时不覆盖角色语气（推荐）</label></div>
    <details class="collapsible settings-advanced" id="humanize-advanced">
      <summary>高级：作息、气泡与动作冷却</summary>
      <div class="field-row" style="margin-top:8px">
        <div class="field"><label for="cfg-humanize-sleep-start">作息开始（睡觉）</label>
          <input type="time" id="cfg-humanize-sleep-start" value="${esc(humanize.personaState?.sleepStart || '00:00')}" /></div>
        <div class="field"><label for="cfg-humanize-sleep-end">作息结束（起床）</label>
          <input type="time" id="cfg-humanize-sleep-end" value="${esc(humanize.personaState?.sleepEnd || '07:00')}" /></div>
        <div class="field"><label for="cfg-humanize-cap">等待封顶（秒）</label>
          <input type="number" id="cfg-humanize-cap" min="1" max="60" step="0.5" value="${esc((Number(replyDelay.capMs) > 0 ? Number(replyDelay.capMs) : 8000) / 1000)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="cfg-humanize-max-bubbles">一轮最多拆几条气泡</label>
          <input type="number" id="cfg-humanize-max-bubbles" min="1" max="8" value="${esc(Number(humanize.shape?.maxBubbles) > 0 ? Number(humanize.shape.maxBubbles) : 3)}" /></div>
        <div class="field"><label for="cfg-humanize-actions-max">每轮最多动作次数</label>
          <input type="number" id="cfg-humanize-actions-max" min="1" max="20" value="${esc(Number(humanize.actions?.maxPerRun) > 0 ? Number(humanize.actions.maxPerRun) : 4)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="cfg-humanize-cooldown-sticker">贴纸冷却（秒）</label>
          <input type="number" id="cfg-humanize-cooldown-sticker" min="0" max="3600" value="${esc((Number.isFinite(Number(humanize.actions?.stickerCooldownMs)) ? Number(humanize.actions.stickerCooldownMs) : 60000) / 1000)}" /></div>
        <div class="field"><label for="cfg-humanize-cooldown-poke">拍一拍冷却（秒）</label>
          <input type="number" id="cfg-humanize-cooldown-poke" min="0" max="3600" value="${esc((Number.isFinite(Number(humanize.actions?.pokeCooldownMs)) ? Number(humanize.actions.pokeCooldownMs) : 300000) / 1000)}" /></div>
        <div class="field"><label for="cfg-humanize-cooldown-voice">语音冷却（秒）</label>
          <input type="number" id="cfg-humanize-cooldown-voice" min="0" max="3600" value="${esc((Number.isFinite(Number(humanize.actions?.voiceCooldownMs)) ? Number(humanize.actions.voiceCooldownMs) : 600000) / 1000)}" /></div>
        <div class="field"><label for="cfg-humanize-cooldown-react">表情回应冷却（秒）</label>
          <input type="number" id="cfg-humanize-cooldown-react" min="0" max="3600" value="${esc((Number.isFinite(Number(humanize.actions?.reactCooldownMs)) ? Number(humanize.actions.reactCooldownMs) : 30000) / 1000)}" /></div>
      </div>
      <div class="hint">作息只影响状态提示词里"现在是否该困/精神"的文案；动作次数最少 1，冷却填 0 = 不限制该项。</div>
    </details>
    <div class="field">
      <label>当前状态（只读）</label>
      <div class="hint" id="humanize-state-text">读取中…</div>
    </div>
    <div class="hint">
      只影响发送时机与措辞，不改变角色设定。延迟仅作用于本轮第一条，后续气泡仍按发送保护里的间隔；
      暂停或中止会立即取消等待。默认关闭，建议从 0.5–2 秒开始观察。
    </div>

    <h3>所有模式 · 自主节奏（实验性）</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pacing-enabled" ${c.pacing?.enabled === true ? 'checked' : ''} />
      <label for="cfg-pacing-enabled">消息不即时唤醒，按自主节奏攒批处理</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-pacing-default">默认多久醒一次（分钟）</label>
        <input type="number" id="cfg-pacing-default" min="1" max="240" value="${esc(c.pacing?.defaultWakeMinutes ?? 20)}" /></div>
      <div class="field"><label for="cfg-pacing-min">两次自主醒来最短间隔（分钟）</label>
        <input type="number" id="cfg-pacing-min" min="1" max="240" value="${esc(c.pacing?.minWakeMinutes ?? 5)}" /></div>
    </div>
    <div class="field"><label for="cfg-pacing-max">最长沉默上限（分钟）</label>
      <input type="number" id="cfg-pacing-max" min="1" max="240" value="${esc(c.pacing?.maxSilenceMinutes ?? 45)}" /></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pacing-instant" ${c.pacing?.instantOnMention !== false ? 'checked' : ''} />
      <label for="cfg-pacing-instant">被 @ 时仍然立刻处理，不排队</label></div>
    <div class="hint">
      开启后普通消息先攒着，等机器人自己安排的时机统一处理；被 @ 或拍一拍时仍然立刻处理
      （拍一拍算不算直接互动看上一条开关）。私聊永远即时。默认关闭，仍在实验阶段，建议先在少量群里试。
    </div>

    <h3>所有模式 · 数据保留</h3>
    <div class="field-row">
      <div class="field"><label for="cfg-store-maxmessages">每个会话最多保留消息（0 = 不限）</label>
        <input type="number" id="cfg-store-maxmessages" min="0" max="1000000" value="${esc(st.maxMessagesPerChat ?? 0)}" /></div>
      <div class="field"><label for="cfg-store-keepsessions">会话审计文件保留条数（0 = 不限）</label>
        <input type="number" id="cfg-store-keepsessions" min="0" max="100000" value="${esc(st.keepSessionFiles ?? 2000)}" /></div>
    </div>
    <div class="field-row" style="margin-top:12px">
      <div class="field"><label for="cfg-store-compressdays">留档压缩：多少天前结束的压成 .gz（0 = 不压缩）</label>
        <input type="number" id="cfg-store-compressdays" min="0" max="3650" value="${esc(st.sessionCompressAfterDays ?? 30)}" /></div>
      <div class="field"><label for="cfg-store-sessionmb">留档总量上限（MB，0 = 不限）</label>
        <input type="number" id="cfg-store-sessionmb" min="0" max="1048576" value="${esc(st.sessionMaxTotalMb ?? 1024)}" /></div>
    </div>
    <div class="hint">
      消息保留上限只清理已经处理完的历史，不会删待处理或结果未知的消息，填 0 表示不清理，保存后即时生效。
      审计文件条数在下次重启后生效；占用磁盘时再调小。
      超过压缩天数的旧留档每天自动压成 .json.gz（可省约 90% 空间，控制台仍能正常查看）；
      总量超过上限时按最旧优先删除已结束的留档，运行中/等待中的永不删。
      当前占用在「总览 → 主机资源」里能看到。
    </div>
    <div class="field" style="margin-top:12px">
      <label for="cfg-store-ioprofile">磁盘写入策略</label>
      <select id="cfg-store-ioprofile">
        ${(() => {
          const current = ioProfileOf(st);
          const option = (value, label) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
          return [
            option('balanced', '均衡（推荐）：每 10 秒落盘一次，消息库 FULL'),
            option('low', '省 IO：每 30 秒落盘一次，消息库 NORMAL'),
            option('minimal', '最省 IO：每 60 秒落盘一次，消息库 NORMAL'),
            option('custom', '自定义：自己填落盘间隔和消息库同步级别')
          ].join('');
        })()}
      </select>
    </div>
    <div id="cfg-store-iocustom" class="field-row"${ioProfileOf(st) === 'custom' ? '' : ' style="display:none"'}>
      <div class="field"><label for="cfg-store-persistms">运行中会话落盘间隔（毫秒，2000~60000）</label>
        <input type="number" id="cfg-store-persistms" min="2000" max="60000" step="1000" value="${esc(st.sessionPersistMs ?? 10000)}" /></div>
      <div class="field"><label for="cfg-store-sqlitesync">消息库写入同步</label>
        <select id="cfg-store-sqlitesync">
          <option value="FULL" ${storeSync === 'FULL' ? 'selected' : ''}>FULL：最稳，每条提交都等落盘</option>
          <option value="NORMAL" ${storeSync === 'NORMAL' ? 'selected' : ''}>NORMAL：省磁盘 IOPS，掉电可能丢最近几条</option>
        </select></div>
    </div>
    <div class="hint">
      大多数服务器用「均衡」就行。磁盘 IOPS 紧张（例如 2 核 2G 小云盘、控制台常开）时选「省 IO」或「最省 IO」，
      会减少运行中会话的落盘频率，并把消息库改成 NORMAL 同步；代价是进程异常退出时最多丢对应间隔内的运行记录，
      消息库掉电可能丢最近几条提交。正常结束的会话始终立即完整落盘。选「自定义」才会显示具体数值。
    </div>
    <div class="settings-divider"></div>
    <h3>上下文分层</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-context-layering" ${st.contextLayering?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-context-layering">限制每轮实际带入的历史（默认开，防止 300 条历史把输入顶爆）</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-context-layer-messages">最多带最近多少条</label>
        <input type="number" id="cfg-context-layer-messages" min="1" max="500" value="${esc(Number(st.contextLayering?.maxHistoryMessages) > 0 ? Number(st.contextLayering.maxHistoryMessages) : 24)}" /></div>
      <div class="field"><label for="cfg-context-layer-chars">最多带多少字符</label>
        <input type="number" id="cfg-context-layer-chars" min="500" max="100000" step="500" value="${esc(Number(st.contextLayering?.maxHistoryChars) > 0 ? Number(st.contextLayering.maxHistoryChars) : 8000)}" /></div>
    </div>
    <div class="hint">关掉后完全按上面的响应档位条数（可能几千到几万字符）；开着时以这两个上限为准，字符上限还会被「过去状态最多字符数」再夹一次。Token 节省模式还会在此之上再夹一层。</div>

    <h3>所有模式 · 表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker-collect" ${(c.sticker?.collectEnabled !== false && c.sticker?.autoCollect !== false) ? 'checked' : ''} />
      <label for="cfg-sticker-collect">允许机器人自己收藏表情包（关掉后不再自动收，也不会在聊天里主动收；手动添加不受影响）</label></div>

    <div class="field">
      <label for="cfg-sticker-collect-max">每小时最多收藏（<span class="slider-now" id="cfg-sticker-collect-max-now">${normalizeStickerCollectMax(c.sticker?.maxCollectPerHour)}</span> 张）</label>
      <div class="tier-slider-wrap">
        <input type="range" id="cfg-sticker-collect-max" class="tier-slider" min="1" max="60" step="0.1"
          value="${normalizeStickerCollectMax(c.sticker?.maxCollectPerHour)}" aria-label="每小时最多收藏张数" />
      </div>
      <div class="hint">
        拖动设置 1-60（默认 10 张/小时）。全局上限；每个会话另有独立上限（默认 3 张/小时）。
        控制台里手动添加表情不受这两项影响。
      </div>
    </div>
    <div class="field">
      <label for="cfg-sticker-collect-max-perchat">每个会话每小时最多收藏（张）</label>
      <input type="number" id="cfg-sticker-collect-max-perchat" min="1" max="60" value="${esc(Number(c.sticker?.maxCollectPerHourPerChat) > 0 ? Number(c.sticker.maxCollectPerHourPerChat) : 3)}" />
      <div class="hint">防止单个群刷爆全局额度；默认 3。全局上限仍以上面那个滑条为准。</div>
    </div>

    <div class="field">
      <label for="cfg-sticker-collect-criteria">收藏的判定标准（留空 = 内置默认）</label>
      <textarea id="cfg-sticker-collect-criteria" rows="4" maxlength="2000" placeholder="只写「收什么 / 不收什么」；留空用内置默认（与之前版本完全一致）">${esc(c.sticker?.collectCriteria || '')}</textarea>
      <div class="hint">
        这段文字替换表情判定里的"判定标准"部分（"你是「谁」、正在看谁的图"仍由代码补充），
        只影响<b>哪些图会被收进表情库</b>，不影响聊天与发送。改完即时生效、不用重启；
        超 2000 字判定时只取前 2000。
      </div>
    </div>

    <div class="field">
      <label>发表情包的积极程度</label>
      <select id="cfg-sticker-encourage">
        ${STICKER_LEVELS.map(([v, label]) =>
          `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
        ).join('')}
      </select>
      <div class="hint">
        这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
      </div>
    </div>

    <div class="field">
      <label for="cfg-sticker-max">系统提示里的表情清单条数（<span class="slider-now" id="cfg-sticker-max-now">${normalizeStickerMax(c.sticker?.promptMaxStickers)}</span> 条）</label>
      <div class="tier-slider-wrap">
        <input type="range" id="cfg-sticker-max" class="tier-slider" min="1" max="60" step="0.1"
          value="${normalizeStickerMax(c.sticker?.promptMaxStickers)}" aria-label="表情清单条数" />
      </div>
      <div class="hint">
        拖动设置 1-60（默认 10）。清单一半放常用的，一半放没用过/很久没用的，发掉一张自动换下一张上来
        （不会再总是那几张）。条数越大能选的范围越宽，代价是每轮提示词变长；Token 节省模式还会再夹到
        3~5 条。库容量不受这一项影响。
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
      <div class="hint" style="margin:0 0 8px">
        「已读」= 已经被处理过的历史消息（机器人看过、回过，或当时决定不回的）。每次响应发给模型的是
        「这次要处理的新消息（未读）」+ 最近这么多条历史（已读），好让它知道前面在聊什么；
        条数越大上下文越全，每轮的提示词花费也越高。
      </div>
      <div class="tier-param${paramOn.at ? '' : ' dim'}">
        <label>① 被艾特时：发未读 + <input type="number" id="cfg-atcount" min="0" max="500" value="${esc(st.atCount ?? 20)}" /> 条已读</label>
        <div class="hint">有人 @ 机器人时<b>一定响应</b>，不受上面概率的影响。</div>
      </div>
      <div class="tier-param${paramOn.keyword ? '' : ' dim'}">
        <label>② 命中关键词时：发未读 + <input type="number" id="cfg-kwcount" min="0" max="500" value="${esc(st.keywordCount ?? 15)}" /> 条已读</label>
        <div class="hint">白名单关键词（每行一个，不区分大小写）；命中<b>一定响应</b>。留空就只回 @：</div>
        <textarea id="cfg-keywords" rows="3" placeholder="小鲸鱼&#10;bot">${esc((st.keywords || []).join('\n'))}</textarea>
      </div>
      <div class="keyword-blacklist-param">
        <label>消息关键词黑名单</label>
        <div class="hint">每行一个，普通文字不区分大小写。以 <code>re:</code> 开头可使用受限正则，如 <code>re:^转发.*抽奖$</code>；<code>re:</code> 只匹配消息前 2000 字，变长量词有组合上限（如 <code>a?</code> 最多 7 个）。命中后消息会在入口直接丢弃，黑名单优先于白名单。</div>
        <textarea id="cfg-blacklist-keywords" rows="3" placeholder="广告关键词&#10;re:^转发.*抽奖$">${esc((st.blacklistKeywords || []).join('\n'))}</textarea>
      </div>
      <div class="tier-param${paramOn.random ? '' : ' dim'}">
        <label>③ 按概率响应时：发未读 + <input type="number" id="cfg-randcount" min="0" max="500" value="${esc(st.randomCount ?? 8)}" /> 条已读</label>
        <div class="hint">概率在 0 和 100 之间时，普通消息按这个概率接。</div>
      </div>
      <div class="tier-param${paramOn.all ? '' : ' dim'}">
        <label>④ 全响应时：发未读 + <input type="number" id="cfg-allcount" min="0" max="500" value="${esc(st.allCount ?? 80)}" /> 条已读</label>
        <div class="hint">滑条拖到 <b>100%</b> 时，任何消息都响应。</div>
      </div>
      <div class="field" style="margin-top:10px">
        <label for="cfg-pastchars">过去状态最多字符数</label>
        <input type="number" id="cfg-pastchars" min="100" max="100000" step="1000" value="${esc(st.pastStateMaxChars ?? 24000)}" />
        <div class="hint">上限 100000。条数和字符数是两道闸门，先到哪道按哪道截；调大上下文更全，但每轮 token 花费也更高。</div>
      </div>
    </div>

    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">被屏蔽群员的消息不会存档、不会触发回复，也不会作为聊天背景发给模型。机器人自己的发言不受影响。</div>
    </div>`;
}

// 由 ui/core/widgets.js 机械拆出（2026-10-01，同一次「UI 结构治理」：把混装的叶子按域归位）。
// 从 app.js 机械切出（只切不改，语句逐字节一致）；跨文件引用走 import，可变状态挂 state。

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

function unknownAgeLabel(ageMs) {
  if (!ageMs) return '刚刚';
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return '不到 1 小时';
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

async function openUnknownOperations(chatKey) {
  const base = `/api/chats/${chatKey.replace(':', '_')}/unknown-operations`;
  let olderThanDays = 0;
  let operations = [];
  let summary = { total: 0, oldestAgeMs: 0 };

  const overlay = modelModalShell({
    head: `核对未知写入 · ${formatChatTitle(chatKey, chatNameOf(chatKey))}`,
    body: `<div class="chat-toolbar" style="margin:0 0 8px;flex-wrap:wrap">
        <label class="muted">只看
          <select data-unknown-age>
            <option value="0">全部</option>
            <option value="1">超过 1 天</option>
            <option value="3">超过 3 天</option>
            <option value="7">超过 7 天</option>
            <option value="30">超过 30 天</option>
          </select>
        </label>
        <button type="button" class="btn btn-small" data-unknown-select-all>全选</button>
        <button type="button" class="btn btn-small" data-unknown-batch="sent">批量确认已发送</button>
        <button type="button" class="btn btn-small" data-unknown-batch="failed">批量确认未发送</button>
        <button type="button" class="btn btn-small" data-unknown-export>导出 JSON</button>
        <span class="muted" data-unknown-summary></span>
      </div>
      <div data-unknown-list></div>`,
    foot: '<button type="button" class="btn" data-unknown-close>关闭</button>'
  });
  const listBox = overlay.querySelector('[data-unknown-list]');
  const summaryBox = overlay.querySelector('[data-unknown-summary]');
  const ageSelect = overlay.querySelector('[data-unknown-age]');

  const render = () => {
    summaryBox.textContent = summary.total
      ? `共 ${summary.total} 条待核对${summary.oldestAgeMs ? `，最老一条 ${unknownAgeLabel(summary.oldestAgeMs)}` : ''}`
      : '';
    if (!operations.length) {
      listBox.innerHTML = '<div class="empty-hint">没有待核对的外部写入</div>';
      return;
    }
    listBox.innerHTML = `<div class="control-key-list">${operations.map((operation) => `
      <div class="control-key-row">
        <span style="display:flex;gap:8px;align-items:flex-start">
          <input type="checkbox" data-unknown-pick value="${esc(operation.id)}" aria-label="选择这条记录" />
          <span><strong>${esc(operation.payload?.type || '外部操作')}</strong>
            <small>${esc(JSON.stringify(operation.payload || {}).slice(0, 180))}</small>
            <small>${esc(operation.error || '结果未知')} · ${esc(unknownAgeLabel(operation.ageMs))}前</small></span>
        </span>
        <span class="settings-actions" style="margin:0">
          <button type="button" class="btn btn-small" data-unknown-result="sent" data-operation-id="${esc(operation.id)}">确认已发送</button>
          <button type="button" class="btn btn-small" data-unknown-result="failed" data-operation-id="${esc(operation.id)}">确认未发送</button>
        </span>
      </div>`).join('')}</div>`;
  };

  const load = async () => {
    const query = olderThanDays > 0 ? `?olderThanDays=${olderThanDays}&limit=500` : '?limit=500';
    const data = await api(`${base}${query}`);
    operations = data.operations || [];
    summary = data.summary || { total: 0, oldestAgeMs: 0 };
    render();
  };

  const reconcile = async (ids, result) => {
    const sent = result === 'sent';
    const count = ids.length;
    if (!await askForConfirmation(sent
      ? `确认这 ${count} 条操作都已在 QQ 中看到成功？确认后不会再次发送。`
      : `确认这 ${count} 条操作都未成功？系统也不会自动重试。`)) return;
    // 单条核对走原端点（审计里不带 batch 标记）；多条才走批量端点。
    const path = ids.length === 1
      ? `${base}/${encodeURIComponent(ids[0])}/reconcile`
      : `${base}/reconcile`;
    const body = ids.length === 1 ? { result, confirm: true } : { ids, result, confirm: true };
    await api(path, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModelModal(overlay);
    await loadChats();
  };

  overlay.querySelector('[data-unknown-close]').addEventListener('click', () => closeModelModal(overlay));
  ageSelect.addEventListener('change', async () => {
    olderThanDays = Number(ageSelect.value) || 0;
    try { await load(); } catch (error) { alert(`读取失败：${error.message}`); }
  });
  overlay.querySelector('[data-unknown-select-all]').addEventListener('click', () => {
    listBox.querySelectorAll('[data-unknown-pick]').forEach((box) => { box.checked = true; });
  });
  overlay.querySelectorAll('[data-unknown-batch]').forEach((button) => {
    button.addEventListener('click', async () => {
      const ids = [...listBox.querySelectorAll('[data-unknown-pick]:checked')].map((box) => box.value);
      if (!ids.length) return alert('先勾选要核对的记录');
      try {
        button.disabled = true;
        await reconcile(ids, button.dataset.unknownBatch);
      } catch (error) {
        button.disabled = false;
        alert(`批量核对失败：${error.message}`);
      }
    });
  });
  overlay.querySelector('[data-unknown-export]').addEventListener('click', () => {
    const payload = JSON.stringify({
      chatKey, exportedAt: new Date().toISOString(), summary, operations
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `unknown-${chatKey.replace(':', '_')}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
  listBox.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-unknown-result]');
    if (!button) return;
    try {
      button.disabled = true;
      await reconcile([button.dataset.operationId], button.dataset.unknownResult);
    } catch (error) {
      // 失败时保留弹窗（用户可以再试或关掉），并给出明确反馈
      button.disabled = false;
      alert(`核对写入失败：${error.message}`);
    }
  });
  await load();
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
      threadLabel = '生命周期 · 活跃';
    } else if (mode === 'lifecycle' && c.thread?.state === 'listening') {
      threadLabel = '生命周期 · 监听';
    } else if (mode === 'lifecycle' && c.thread?.state === 'rollover_armed') {
      threadLabel = '等待续接';
    }
    const incidentControl = chatControlIcon(c);
    const showIncidentControl = c.key.startsWith('group:')
      && state.config?.incidentPilot?.enabled === true;
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${esc(c.key)}" role="button" tabindex="0">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.timeControl?.enabled ? `<span class="thread-pill">${c.timeControl.active ? '活跃时段' : '仅记录'}</span>` : ''}
          ${threadLabel ? `<span class="thread-pill mode-${mode}">${threadLabel}</span>` : ''}
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
          ${showIncidentControl ? `<button type="button" class="icon-btn chat-runtime-control" data-chat-runtime="${esc(c.key)}" title="${esc(incidentControl.label)}" aria-label="${esc(incidentControl.label)}">${incidentControl.icon}</button>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条 · 失败 ${c.failed || 0} · 待确认 ${c.held || 0}${c.thread ? ` · 线程 v${c.thread.version}` : ''}</span><span>${c.lastDecision ? `未回 ${esc(c.lastDecision.reason)} ${Number(c.lastDecision.percent) || 0}% · ` : ''}${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).map((html, index) => ({ key: String(visibleChats[index].key), html }));
  // 空状态也必须作为"带 key 的行"交给 patchKeyedList：这层提示没有 data-key，直接写
  // box.innerHTML 的话既不进 existing、也永远不会被删，列表重新有内容时会沉到最底部一直留着
  // （新行走 insertBefore(node, firstChild) 插到它前面；2026-10-01 审查）。
  const rows = visibleChats.length
    ? chatRows
    : [{ key: '__empty__', html: `<div class="list-head muted">${state.chats.length ? '没有匹配筛选条件的会话' : '还没有消息存档（等白名单里的群/好友来消息）'}</div>` }];
  // exit: true —— 行被筛掉/归档时先塔缩再移除（见 ui/core/dom-util.js 与 style.css 的 rowOut）
  patchKeyedList(box, rows, 'data-key', { exit: true });
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  $$('.chat-item', box).forEach((el) => {
    if (el.__bound) return;      // 增量更新会保留旧行，别重复绑定
    el.__bound = true;
    el.addEventListener('click', () => selectChat(el.dataset.key));
    // 键盘也要能进会话：存档列表原来是纯 div（无 role/tabindex），Tab 直接跳过整列 ——
    // 只能点鼠标才打得开（2026-10-08 审查）。与「会话」列表同样的 Enter/Space 口径。
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectChat(el.dataset.key);
    });
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
  // 注册给滚动加载器（模块求值期不碰 state：真 ESM 环境里有 TDZ / 环引用风险）
  state.chatLoadOlder = loadOlderChatMessages;
  try {
    const base = `/api/chats/${key.replace(':', '_')}/messages`;
    if (keepView && (state.chatMessages || []).length) {
      // 轮询只取"比当前最新一条更新的"，不再整页重拉（否则已加载的更早分页会被冲掉）
      const lastId = Number(state.chatMessages[state.chatMessages.length - 1]?.id) || 0;
      const data = await api(`${base}?limit=${CHAT_MSG_PAGE}&after=${lastId}`);
      if (state.currentChatKey !== key) return;
      const fresh = data.messages || [];
      if (!fresh.length) return;
      // 必须换新数组：chatMessagesNewestFirst() 用数组引用做排序缓存 key，
      // 原地 push 会让缓存永远命中，新消息渲染不出来；顺带按 id 去重（两个轮询重叠时
      // 会各自拉到同一批）。
      const known = new Set((state.chatMessages || []).map((m) => String(m.id)));
      const added = fresh.filter((m) => !known.has(String(m.id)));
      if (!added.length) return;
      state.chatMessages = [...state.chatMessages, ...added];
      updateChatMessagesBody(true);
      return;
    }

    const data = await api(`${base}?limit=${CHAT_MSG_PAGE}`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];
    state.chatHasMore = data.hasMore === true;
    state.chatNextBefore = Number(data.nextBefore) || 0;
    state.chatMsgLimit = CHAT_MSG_PAGE;
    renderChatMessages();
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 向上翻页：取比当前最老一条更早的一批，插到数组头部（表格末尾）。 */
async function loadOlderChatMessages() {
  if (state.chatLoadingOlder || !state.chatHasMore || !state.chatNextBefore) return 0;
  const key = state.currentChatKey;
  state.chatLoadingOlder = true;
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=${CHAT_MSG_PAGE}&before=${state.chatNextBefore}`);
    if (state.currentChatKey !== key) return 0;
    state.chatHasMore = data.hasMore === true;
    state.chatNextBefore = Number(data.nextBefore) || 0;
    const older = data.messages || [];
    if (!older.length) return 0;
    state.chatMessages = [...older, ...state.chatMessages];
    return older.length;
  } catch {
    return 0;
  } finally {
    state.chatLoadingOlder = false;
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
    try {
      await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
      loadChats();
      // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
      loadChatMessages(key, { keepView: true });
    } catch (error) {
      alert(`标记已读失败：${error.message}`);
    }
  });
  $('#chat-retry-btn')?.addEventListener('click', async () => {
    try {
      if (!await askForConfirmation('重新处理确定未发送成功的失败批次？')) return;
      await api(`/api/chats/${key.replace(':', '_')}/retry-failed`, { method: 'POST', body: '{"confirm":true}' });
      loadChats();
    } catch (error) {
      alert(`重试失败：${error.message}`);
    }
  });
  $('#chat-resolve-btn')?.addEventListener('click', async () => {
    try {
      if (state.config?.incidentPilot?.enabled === true) {
        await openUnknownOperations(key);
        return;
      }
      if (!await askForConfirmation('已核对 QQ 中的实际发送结果？确认后将结束待确认批次，不会重发。')) return;
      await api(`/api/chats/${key.replace(':', '_')}/resolve-held`, {
        method: 'POST', body: '{"confirm":true}'
      });
      loadChats();
    } catch (error) {
      alert(`核对失败：${error.message}`);
    }
  });
  $('#chat-thread-close-btn')?.addEventListener('click', async () => {
    try {
      if (!await askForConfirmation('结束当前对话线程？后续普通消息将重新遵循响应档位。')) return;
      await api(`/api/chats/${key.replace(':', '_')}/thread`, { method: 'DELETE', body: '{}' });
      await loadChats();
    } catch (error) {
      alert(`结束线程失败：${error.message}`);
    }
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
        method: 'POST', body: JSON.stringify({ text })
      });
      input.value = '';
      // 同理，保持当前分页与滚动位置
      loadChatMessages(key, { keepView: true });
    } catch (error) {
      alert(`发送失败：${error.message}`);
    }
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();
}

function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (state.chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    state.chatMsgSortCache = { src, newestFirst: sorted };
  }
  return state.chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  return `
    <tr class="${m.read ? '' : 'unread'}">
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
      ? `向下滚动加载更早的（已载入里还有 ${rest} 条）`
      : (state.chatHasMore
        ? '向下滚动加载更早的（还有更早的存档）'
        : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : ''));
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

function conversationModeForChat(chatKey, cfg = state.config) {
  const conversation = cfg?.conversation || {};
  if (conversation.unifiedMode !== false) return conversation.mode || 'legacy';
  const match = /^group:(\d+)$/.exec(String(chatKey || ''));
  return match && conversation.groupModes?.[match[1]]
    ? conversation.groupModes[match[1]]
    : (conversation.mode || 'legacy');
}


export { appendChatMessageRows, bindHumanizePreset, bindHumanizeRecommend, bindProactiveWindowEditor, loadChats, loadHumanizeState, renderChatSection, updateChatMessagesBody };
