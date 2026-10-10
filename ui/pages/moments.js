// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import { refreshStatus, renderSettings } from '../app.js';
import { api } from '../core/api.js';
import { MOMENT_STATUS_LABELS, QZONE_ACTION_LABELS, QZONE_RUN_LABELS } from '../core/constants.js';
import {
  askForConfirmation, experimentalFeatureLaunchPatch, requestExperimentOwnerUin,
  syncGraduatedFeatureNavigation
} from '../core/dom-util.js';
import { $, $$, esc } from '../core/dom.js';
import { chatNameOf, fmtTime, formatChatTitle } from '../core/format.js';
import { state } from '../core/state.js';
import { saveConfig } from './settings-save.js';
function renderExperimentalSettingsSectionImpl(c) {
  const enabled = c.identityPilot?.enabled === true;
  const slang = c.slangPilot || {};
  const incident = c.incidentPilot || {};
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
        <div class="control-key-row">
          <span><strong>群游戏</strong><small id="experiment-groupgame-state">${c.groupGame?.enabled === true ? '已启用' : '已停用'} · 实验中</small></span>
          <span class="settings-actions" style="margin:0">
            <label class="checkbox-row" style="margin:0"><input type="checkbox" id="cfg-game-enabled" ${c.groupGame?.enabled === true ? 'checked' : ''} /><span>启用</span></label>
          </span>
        </div>
      </div>
      <div class="hint">群游戏（数字炸弹 / 谁是卧底 / 狼人杀）的详细设置与「正在进行的局」在 <b>设置 → 群游戏</b>；
        这里只控制它是否运行（生命周期）。默认关、白名单制、每群同时一局。</div>
      <div class="hint" id="experiment-launch-result"></div>
    </section>`;
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
    <div id="daily-moments-status" class="daily-moments-status"><span class="muted">正在读取状态…</span></div>
    <h3 id="settings-digest">群日报</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-digest-enabled" ${c.groupDigest?.enabled === true ? 'checked' : ''} />
      <label for="cfg-digest-enabled">每天定时把「过去 24 小时群里聊了啥」汇总成一条发到指定群（默认关）</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-digest-time">发送时间（北京时间 HH:MM）</label>
        <input type="text" id="cfg-digest-time" value="${esc(c.groupDigest?.time || '09:30')}" placeholder="09:30" /></div>
      <div class="field"><label>发到哪些群（勾选机器人已加入的群）</label>
        <div id="cfg-digest-chats-box" class="group-checklist"><span class="muted">正在读取群列表…</span></div></div>
    </div>
    <div class="settings-actions">
      <button class="btn btn-small" id="digest-run-btn" type="button">立即试跑一次</button>
      <span id="digest-run-result" class="muted"></span>
      <span class="muted">试跑会真的把日报发到上面配置的群里</span>
    </div>`;
}

// ── 定时提醒（设置 → 定时提醒）──────────────────────────────────────────
// 提醒本身是聊天里说"X 点提醒我 Y"由模型用 remind 工具立的；这一页管两件事：
// 开关（关掉后工具与到期派发都停，数据保留）和已立提醒的查看/取消。
/**
 * 群游戏设置分区（2026-09-29 审查 P2）：这里放全部群游戏配置与「正在进行的局」。
 * 按 `docs/EXPERIMENTAL_FEATURE_STANDARD.md`，「实验功能」页只保留启停与转正动作，
 * 需要更多配置的特性必须有自己的页面（照本文件 renderRemindersSection 的样子做）。
 * 启停开关仍在「实验功能」页（那是生命周期控制面），这里只显示它的状态。
 */
function renderGroupGameSection(c) {
  const games = Array.isArray(c.groupGame?.games) ? c.groupGame.games : ['number-bomb', 'undercover'];
  const enabled = c.groupGame?.enabled === true;
  return `
    <h3 id="settings-groupgame">群游戏</h3>
    <div class="hint">系统负责轮次、计票与判定，模型只负责氛围与解说；卧底的词只走私聊，公开摘要里不含身份。
      默认关、白名单制、每群同时一局。</div>
    <div class="muted" style="margin:6px 0 10px;font-size: var(--fs-sm)">当前状态：<b>${enabled ? '已启用' : '已停用'}</b>
      —— 开关在「实验功能」页（生命周期），这里是详细设置与局面。</div>
    <div class="field-row">
      <div class="field"><label>允许开局的群（勾选机器人已加入的群）</label>
        <div id="cfg-game-chats-box" class="group-checklist"><span class="muted">正在读取群列表…</span></div></div>
      <div class="field"><label for="cfg-game-daily">每群每天最多开局数</label>
        <input type="number" id="cfg-game-daily" min="1" max="50" value="${esc(c.groupGame?.dailyLimitPerChat ?? 6)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-game-private" ${c.groupGame?.allowPrivateInvite === true ? 'checked' : ''} />
      <label for="cfg-game-private">允许私聊发词/身份（谁是卧底与狼人杀都必需；只发给报名/在册的人，失败不重试）</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-game-maxplayers">每局人数上限</label>
        <input type="number" id="cfg-game-maxplayers" min="2" max="30" value="${esc(c.groupGame?.maxPlayers ?? 10)}" /></div>
      <div class="field"><label for="cfg-game-round">单回合超时（秒，0=插件默认）</label>
        <input type="number" id="cfg-game-round" min="0" max="600" value="${esc(c.groupGame?.roundSeconds ?? 0)}" /></div>
      <div class="field"><label for="cfg-game-discuss">白天讨论时长（秒，0=插件默认 120）</label>
        <input type="number" id="cfg-game-discuss" min="0" max="600" value="${esc(c.groupGame?.discussSeconds ?? 0)}" /></div>
      <div class="field"><label for="cfg-game-recruit">开局报名时长（秒，0=不报名直接发牌）</label>
        <input type="number" id="cfg-game-recruit" min="0" max="300" value="${esc(c.groupGame?.recruitSeconds ?? 45)}" /></div>
    </div>
    <div class="hint">需要私聊的游戏（谁是卧底/狼人杀）默认先<strong>报名</strong>：想玩的在群里发一句「我玩」或「报名」，
      够人数才发牌、发牌才发私聊——不会把只是在群里插话的围观者拉进局（把报名时长设 0 就回到"按最近发言者直接发牌"）。</div>
    <div class="hint">白天讨论到点会自动进投票；中途<strong>超过半数</strong>存活玩家说一句「投吧 / 直接投」也会立刻开投
      （说「投 3」这种带目标的算投票，不算想开投）。讨论时长与单回合超时<strong>小于 30 秒按 30 秒生效</strong>（0 = 用插件默认）。</div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-game-bomb" ${games.includes('number-bomb') ? 'checked' : ''} />
      <label for="cfg-game-bomb">允许「数字炸弹」</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-game-undercover" ${games.includes('undercover') ? 'checked' : ''} />
      <label for="cfg-game-undercover">允许「谁是卧底」</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-game-werewolf" ${(Array.isArray(c.groupGame?.games) ? c.groupGame.games : []).includes('werewolf') ? 'checked' : ''} />
      <label for="cfg-game-werewolf">允许「狼人杀」（6~9 人，角色：狼/预言家/女巫/守卫/平民；夜里私聊提交行动，白天讨论投票；整局都在私聊，见下面的豁免开关）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-game-reveal" ${c.groupGame?.revealWords !== false ? 'checked' : ''} />
      <label for="cfg-game-reveal">谁是卧底/狼人杀结算时公开词与身份（关掉只公布胜方）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-game-privatedm" ${c.groupGame?.allowGamePrivateDm === true ? 'checked' : ''} />
      <label for="cfg-game-privatedm">游戏期间私聊豁免（只对局内玩家；默认关）</label></div>
    <div class="hint">私聊发送的两条路，任选其一即可让游戏跑起来：
      <b>① 白名单/加好友（推荐，最稳）</b>——把想玩的人加进「聊天白名单 → 私聊」，顺手加个好友更好；
      <b>② 打开本页的「游戏期间私聊豁免」</b>——只在本局进行中、只发给报名参加的那几个人、只发引擎文本，
      模型自己发消息仍受白名单限制（管理员屏蔽的人永远发不进）。谁是卧底只有发词一条私聊；狼人杀整局都要私聊，
      没有 ① 或 ② 就只有白名单里的人能收到。</div>
    <h3 style="margin-top:18px">正在进行的局</h3>
    <div id="gg-running"><span class="muted">正在读取…</span></div>
    <div class="settings-actions">
      <button class="btn btn-small" id="gg-refresh-btn" type="button">刷新</button>
      <span class="muted">局跑歪了可以就地结束（等效于让机器人执行「结束游戏」；结束时会在群里发一句说明）</span>
    </div>`;
}

function renderRemindersSection(c) {
  return `
    <h3 id="settings-reminders">定时提醒</h3>
    <div class="hint">群友说「明天 9 点提醒我交作业」时它会把提醒记下来（落盘、重启不丢），到点用它自己的口吻说出来。
      限制：单条 ≤200 字、最多设到 30 天后、单会话待触发 10 条 / 全局 50 条、离线导致迟到超 12 小时作废不补发。</div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-reminders-enabled" ${c.reminders?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-reminders-enabled">启用定时提醒（关掉后不再接受新提醒、到点也不派发；已存数据保留，重新打开继续用）</label></div>
    <h3 style="margin-top:18px">待触发</h3>
    <div id="reminders-pending"><span class="muted">正在读取…</span></div>
    <h3 style="margin-top:18px">最近完成（触发 / 取消 / 过期）</h3>
    <div id="reminders-recent"><span class="muted">正在读取…</span></div>
    <div class="settings-actions">
      <button class="btn btn-small" id="reminders-refresh-btn" type="button">刷新</button>
      <span class="muted">取消某条立即生效，不需要保存；上面的开关改完要点「保存设置」</span>
    </div>`;
}

/** 定时提醒页的列表加载（待触发 + 最近完成），取消后也走这里刷新。 */
async function loadRemindersView() {
  const pendBox = $('#reminders-pending');
  const recBox = $('#reminders-recent');
  if (!pendBox) return;   // 不在这一页（其他页面的渲染会走到这里，直接跳过）
  let r = null;
  try { r = await api('/api/reminders'); } catch (e) {
    pendBox.innerHTML = `<span class="muted">读取失败：${esc(e?.message || e)}</span>`;
    if (recBox) recBox.innerHTML = '';
    return;
  }
  const rows = (items, done) => items.map((it) => {
    const time = new Date(it.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const statusLabel = { fired: '已触发', canceled: '已取消', expired: '已过期' }[it.status] || String(it.status || '');
    // 归属（谁提的/提醒谁）：与提醒到点派发时的话术同源（字段来自 config 的 memberNotes 口径）
    const from = String(it.from || '').trim();
    const to = String(it.to || '').trim();
    const attr = from && to ? `${from} 请你提醒 ${to}`
      : from ? `${from} 请你提醒`
      : to ? `有人请你提醒 ${to}` : '';
    return `<div class="reminder-row" data-id="${esc(it.id)}" data-chatkey="${esc(it.chatKey)}">`
      + `<span class="reminder-when">${esc(time)}</span>`
      + `<span class="reminder-chat">${esc(formatChatTitle(it.chatKey, chatNameOf(it.chatKey)))}</span>`
      + (attr ? `<span class="reminder-attr" title="${esc(attr)}">${esc(attr)}</span>` : '')
      + `<span class="reminder-text">${esc(it.text)}</span>`
      + (done ? `<span class="muted">${esc(statusLabel)}</span>` : '<button type="button" class="btn btn-small reminder-cancel-btn">取消</button>')
      + '</div>';
  }).join('');
  pendBox.innerHTML = (r?.pending || []).length ? rows(r.pending, false) : '<span class="muted">没有待触发的提醒（群友说"X 点提醒我 Y"就会出现在这里）</span>';
  if (recBox) recBox.innerHTML = (r?.recent || []).length ? rows(r.recent, true) : '<span class="muted">暂无完成记录</span>';
}

/** 群游戏「正在进行的局」：列表 + 就地结束（管理员收场用）。 */
async function loadGroupGameView() {
  const box = $('#gg-running');
  if (!box) return;   // 不在这一页（其他页面的渲染也会走到这里）
  let r = null;
  try { r = await api('/api/group-game/status'); } catch (e) {
    box.innerHTML = `<span class="muted">读取失败：${esc(e?.message || e)}</span>`;
    return;
  }
  if (!r?.enabled) {
    box.innerHTML = '<span class="muted">群游戏当前是关闭的（在「设置 → 实验功能」打开开关后，这里才会显示进行中的局）</span>';
    return;
  }
  const list = Array.isArray(r.running) ? r.running : [];
  if (!list.length) {
    box.innerHTML = '<span class="muted">当前没有进行中的局</span>';
    return;
  }
  box.innerHTML = list.map((g) => {
    const mins = Math.max(0, Math.round((Date.now() - Number(g.startedAt || 0)) / 60000));
    const summary = String(g.summary || '').replace(/^【[^】]*】/, '').trim();
    return `<div class="gg-row" data-chatkey="${esc(g.chatKey)}">`
      + `<span class="gg-chat">${esc(formatChatTitle(g.chatKey, chatNameOf(g.chatKey)))}</span>`
      + `<span class="gg-name">${esc(g.name || g.game || '')}</span>`
      + `<span class="gg-summary">${esc(summary)}</span>`
      + `<span class="gg-age">已跑 ${mins} 分钟</span>`
      + '<button type="button" class="btn btn-small gg-stop-btn">结束</button>'
      + '</div>';
  }).join('');
}

function renderMomentWindowRow(window) {
  return `<div class="moment-window-row">
    <div class="field"><label>开始</label><input type="time" class="moment-window-start" aria-label="范围开始时间" value="${esc(window.start)}" required /></div>
    <div class="field"><label>结束</label><input type="time" class="moment-window-end" aria-label="范围结束时间" value="${esc(window.end)}" required /></div>
    <div class="field"><label>计划条数</label><input type="number" class="moment-window-count" aria-label="计划条数" min="1" max="10" value="${esc(window.count)}" required /></div>
    <button type="button" class="btn btn-small moment-window-remove" title="删除时间范围" aria-label="删除时间范围">&times;</button>
  </div>`;
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

// ── 群多选：查机器人已加入的群，让用户勾选（比手填 group:xxx 好用）──
// 数据来自 OneBot 的 get_group_list（后端 /api/onebot/groups）。配置里有、但当前不在名单里的
// （退群/改名/协议端未连接）也照样列出来，避免一次保存把既有配置静默丢掉。
// 群多起来（几十上百个）纯勾选没法用，所以列表带滚动，并在群数 ≥3 时给筛选框、≥2 时给
// 全选/清空（作用于当前可见行）与已选计数。
async function renderGroupChecklist(boxId, selected) {
  const box = document.querySelector('#' + boxId);
  if (!box) return;
  let groups = [];
  try {
    const r = await api('/api/onebot/groups');
    groups = Array.isArray(r?.groups) ? r.groups : [];
  } catch { /* 拿不到就只列已配置的 */ }
  const sel = new Set((Array.isArray(selected) ? selected : []).map((x) => String(x)));
  const seen = new Set();
  const items = [];
  for (const g of groups) {
    const key = 'group:' + g.id;
    seen.add(key);
    items.push({ key, name: String(g.name ?? ''), id: String(g.id), stale: false });
  }
  for (const key of sel) {
    if (seen.has(key)) continue;
    items.push({ key, name: key, id: '', stale: true });
  }
  if (!items.length) {
    box.innerHTML = '<span class="muted">拿不到群列表（协议端未连接或接口不可用）：刷新页面重试，或先让机器人在群里说句话记录会话。</span>';
    return;
  }
  const showFilter = items.length >= 3;
  const showBulk = items.length >= 2;
  const rowHtml = (it) => '<label class="group-checklist-row" data-search="' + esc((it.name + ' ' + it.id).toLowerCase()) + '">'
    + '<input type="checkbox" class="group-check" value="' + esc(it.key) + '"' + (sel.has(it.key) ? ' checked' : '') + ' />'
    + '<span class="group-checklist-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>'
    + (it.stale
      ? '<span class="group-checklist-stale">不在当前群列表</span>'
      : '<span class="group-checklist-id">' + esc(it.id) + '</span>')
    + '</label>';
  box.innerHTML = [
    (showFilter || showBulk) ? '<div class="group-checklist-bar">'
      + (showFilter ? '<input type="search" class="group-checklist-filter" placeholder="筛选群名或群号" />' : '')
      + (showBulk ? '<button type="button" class="btn btn-small group-checklist-all">全选</button>'
        + '<button type="button" class="btn btn-small group-checklist-none">清空</button>' : '')
      + '<span class="group-checklist-count muted"></span></div>' : '',
    '<div class="group-checklist-list">', items.map(rowHtml).join(''), '</div>',
    '<div class="group-checklist-empty muted" hidden>没有匹配的群</div>',
  ].join('');
  // 行已渲染 = 这份列表可用；加载中 / 拉取失败（只有提示文案）时不置位，
  // 保存那一步据此跳过 chats，避免在"还没读完"的窗口里把白名单存成空。
  box.dataset.loaded = '1';
  // 事件：筛选/全选/清空只作用在当前可见行；计数在勾选后刷新（pickedGroups 读的是
  // input.group-check:checked，行被筛掉不影响它——被筛掉的行只是隐藏，勾选状态仍在）。
  const rows = [...box.querySelectorAll('.group-checklist-row')];
  const filterEl = box.querySelector('.group-checklist-filter');
  const countEl = box.querySelector('.group-checklist-count');
  const emptyEl = box.querySelector('.group-checklist-empty');
  const visibleRows = () => rows.filter((r) => !r.classList.contains('is-hidden'));
  const refreshCount = () => {
    if (!countEl) return;
    const all = [...box.querySelectorAll('input.group-check')];
    countEl.textContent = '已选 ' + all.filter((n) => n.checked).length + ' / ' + all.length;
  };
  const applyFilter = () => {
    const q = (filterEl?.value || '').trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const hit = !q || (row.dataset.search || '').includes(q);
      row.classList.toggle('is-hidden', !hit);
      if (hit) shown += 1;
    }
    if (emptyEl) emptyEl.hidden = shown > 0;
  };
  const setVisibleChecked = (checked) => {
    for (const row of visibleRows()) {
      const cb = row.querySelector('input.group-check');
      if (cb) cb.checked = checked;
    }
    refreshCount();
  };
  filterEl?.addEventListener('input', applyFilter);
  box.querySelector('.group-checklist-all')?.addEventListener('click', () => setVisibleChecked(true));
  box.querySelector('.group-checklist-none')?.addEventListener('click', () => setVisibleChecked(false));
  box.querySelector('.group-checklist-list')?.addEventListener('change', (e) => {
    if (e.target?.classList?.contains('group-check')) refreshCount();
  });
  refreshCount();
}

// 由 ui/core/widgets.js 机械拆出（2026-10-01，同一次「UI 结构治理」：把混装的叶子按域归位）。
// 从 app.js 机械切出（只切不改，语句逐字节一致）；跨文件引用走 import，可变状态挂 state。

const momentStatusLabel = (record) => record?.status === 'preview' && record.decision === 'skip'
  ? '预览：决定不发布' : (MOMENT_STATUS_LABELS[record?.status] || record?.status || '-');

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


export {
  launchExperimentalFeature, loadDailyMomentsStatus, loadGroupGameView, loadQzoneInteractionStatus,
  loadRemindersView, momentStatusLabel, renderDailyMomentsSection, renderExperimentalSettingsSectionImpl,
  renderGroupChecklist, renderGroupGameSection, renderMomentWindowRow, renderQzoneInteractionSection,
  renderRemindersSection
};