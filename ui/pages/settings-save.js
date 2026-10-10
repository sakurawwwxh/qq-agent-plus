// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」第二轮：设置域）。
// 设置页保存（saveConfig 的补丁装配与提交）
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（脚本内已核对，勿手改缩进）。
'use strict';


import { currentAppearance } from '../app.js';
import { api } from '../core/api.js';
import { appearancePatch } from '../core/appearance.js';
import { ASR_SERVICES } from '../core/constants.js';
import {
  identityPilotSettingsPatch, setStatusLabel, syncGraduatedFeatureNavigation
} from '../core/dom-util.js';
import { $, $$ } from '../core/dom.js';
import {
  asrHostOf, clampInt, hasOwnPrice, hostOfUrl, memThreshold, mulOf, normalizeAsrMax, normalizeImageGenMax,
  normalizeStickerCollectMax, normalizeStickerMax, parseList, sliderToTierUI
} from '../core/format.js';
import { pickedGroups, state } from '../core/state.js';
// 「平台能力」页的键表与配额行：渲染在 platform.js，这里只按同一份键名读控件
// （键名与 id 约定只维护一处；改名不同步时源码锚点用例会红）。
import { ALL_GATE_KEYS, QUOTA_ROWS, gateCheckboxId, gateDefaultOn, hydratePlatformGates } from './platform.js';
import { currentPersonaId } from './persona.js';
import { captureTimeControlRule } from './settings-bind.js';
import { syncThinkingUi } from './settings.js';
// 外观的数值夹紧搬到 ui/core/appearance.js 的 resolveAppearance —— 它已经是那条唯一入口，
// 这里再夹一遍等于同一个规则写两处，撤掉（原来只有圆角/缩放两处用它）。

/**
 * 数字控件的取值：**显式的 0 要留住**。
 *
 * 原来这几处写的是 `Number(val('#x', c.x)) || 默认值`，而 `Number('0')` 是 0（假值）——
 * 于是用户把「批次间隔」填 0（不要等待）、「触发概率」填 0（从不主动开口）、「温度」填 0
 * （贪心解码）保存后，存回去的却是 1200 / 0.25 / 0.8，界面上看着像"没保存"。
 * 这几个控件的 min 本来就写着 0，0 是文档化的合法值（2026-10-08 审查）。
 *
 * 语义：清空 / 非法 → 保持原值（再退回 fallback，与 memThreshold 的口径一致）；
 *       合法值 → 按 [min,max] 收口。
 */
function numKeep(raw, current, min, max, fallback) {
  const text = String(raw ?? '').trim();
  const n = text === '' ? NaN : Number(text);
  if (!Number.isFinite(n)) {
    const keep = Number(current);
    return Number.isFinite(keep) ? Math.min(max, Math.max(min, keep)) : fallback;
  }
  return Math.min(max, Math.max(min, n));
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
      consolidateMinIntervalMs: Number(val('#cfg-mem-interval', c.memory?.consolidateMinIntervalMs ?? 21600000)) || 21600000,
      // 发现新人的门槛：这两项决定"聊天多但零印象"的人能不能进记忆
      discoverMinMessages: memThreshold(val('#cfg-mem-discover-min', c.memory?.discoverMinMessages ?? 20), c.memory?.discoverMinMessages, 500, 20),
      discoverMaxMembers: memThreshold(val('#cfg-mem-discover-max', c.memory?.discoverMaxMembers ?? 3), c.memory?.discoverMaxMembers, 20, 3),
      // #13 记忆可见性：默认 global + 不隐藏 = 历史行为
      visibility: {
        mode: val('#cfg-mem-visibility', c.memory?.visibility?.mode === 'perChat' ? 'perChat' : 'global'),
        hidePrivateInGroup: chk('#cfg-mem-hideprivate', c.memory?.visibility?.hidePrivateInGroup === true)
      }
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
    // 群游戏在本页只保留生命周期开关；详细配置与「正在进行的局」在「设置 → 群游戏」。
    // 两个页面各写一半 patch 段容易漏字段，所以这里只写 enabled 一个字段。
    patch.groupGame = {
      ...(c.groupGame || {}),
      enabled: chk('#cfg-game-enabled', c.groupGame?.enabled === true)
    };
  }

  if (sec === 'groupGame') {
    patch.groupGame = {
      ...(c.groupGame || {}),
      allowPrivateInvite: chk('#cfg-game-private', c.groupGame?.allowPrivateInvite === true),
      // 游戏期间私聊豁免：只影响引擎发给"本局在册玩家"的私聊；模型发送永远受白名单
      allowGamePrivateDm: chk('#cfg-game-privatedm', c.groupGame?.allowGamePrivateDm === true),
      dailyLimitPerChat: clampInt(val('#cfg-game-daily', c.groupGame?.dailyLimitPerChat ?? 6), 1, 50, 6),
      maxPlayers: clampInt(val('#cfg-game-maxplayers', c.groupGame?.maxPlayers ?? 10), 2, 30, 10),
      roundSeconds: clampInt(val('#cfg-game-round', c.groupGame?.roundSeconds ?? 0), 0, 600, 0),
      discussSeconds: clampInt(val('#cfg-game-discuss', c.groupGame?.discussSeconds ?? 0), 0, 600, 0),
      // 清空输入框 = 回到默认 45（与引擎"键缺失按 45"一致）；写 0 才是关闭报名
      recruitSeconds: clampInt(val('#cfg-game-recruit', c.groupGame?.recruitSeconds ?? 45) || 45, 0, 300, 45),
      revealWords: chk('#cfg-game-reveal', c.groupGame?.revealWords !== false),
      games: [
        ['number-bomb', '#cfg-game-bomb'],
        ['undercover', '#cfg-game-undercover'],
        ['werewolf', '#cfg-game-werewolf']
      ].filter(([, sel]) => chk(sel, sel === '#cfg-game-werewolf' ? false : true)).map(([id]) => id),
      ...(pickedGroups('cfg-game-chats-box') ? { chats: pickedGroups('cfg-game-chats-box') } : {})
    };
  }

  if (sec === 'reminders') {
    // 这一页只有一个开关；列表与取消是即时操作，不走保存
    patch.reminders = { enabled: chk('#cfg-reminders-enabled', c.reminders?.enabled !== false) };
  }

  if (sec === 'moments') {
    patch.groupDigest = {
      ...(c.groupDigest || {}),
      enabled: chk('#cfg-digest-enabled', c.groupDigest?.enabled === true),
      // HH:MM 之外的输入不采纳（"9点半"这类会静默不排程）：退回已保存的值，宁可不改也不存坏值
      time: (() => {
        const raw = String(val('#cfg-digest-time', '') || '').trim();
        return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(raw) ? raw : (c.groupDigest?.time || '09:30');
      })(),
      ...(pickedGroups('cfg-digest-chats-box') ? { chats: pickedGroups('cfg-digest-chats-box') } : {})
    };
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
      // 每日花费上限（改进方案 #8）：金额 0/非法 = 永不超限（宁可不拦，也不把 0 当"零预算即封锁"）
      budget: {
        ...(c.api?.budget || {}),
        enabled: chk('#cfg-budget-enabled', c.api?.budget?.enabled === true),
        dailyYuan: Number(val('#cfg-budget-daily', 20)) || 0,
        onExceed: val('#cfg-budget-onexceed', 'degrade') === 'block' ? 'block' : 'degrade'
      },
      // 思考模式：每供应商独立（thinkingByService[主机]）。只有用户真的动过控件才写，
      // 避免"保存别的字段"顺手改动；全局 api.thinking 保持不动（作为未配置供应商的兜底）。
      // 勾了「聊天单独设档」→ 存 {chat, default} 对象（各任务按用途取，与你手写的配置同形）；
      // 否则存单个语义值（'on' = 跟随服务商默认）。
      thinkingByService: (() => {
        const map = c.api?.thinkingByService || {};
        if (!state.thinkingTouched) return map;
        const host = hostOfUrl(val('#cfg-baseurl', c.api?.baseUrl) || c.api?.baseUrl);
        // 只写"用户点选时所在的那一家"：换家后没重新点选就保存，写出去的是界面的回退显示值，
        // 而且会盖到新家头上（审查 2026-09-28）。
        if (!host || host !== state.thinkingTouchedHost) return map;
        const segVal = (id) => document.querySelector(`#${id} .seg-item.selected`)?.dataset.v || '';
        if (document.querySelector('#cfg-thinking-split')?.checked) {
          const obj = {};
          for (const key of ['chat', 'judge', 'write', 'default']) {
            obj[key] = segVal(`thinking-seg-${key}`) || 'on';
          }
          return { ...map, [host]: obj };
        }
        const cb = document.querySelector('#cfg-thinking-default');
        if (cb && cb.checked) return { ...map, [host]: 'on' };
        const v = segVal('thinking-seg');
        if (v) return { ...map, [host]: v };
        return map;
      })(),
      // 自定义档位映射：非法 JSON 保留原值；清空要"真删"——deepMerge 只并集不删键，
      // 必须走 __replace__ 整体替换（否则删掉的键/清空动作永远不生效，实测）。
      thinkingParams: (() => {
        const node = document.querySelector('#cfg-thinking-params');
        if (!node) return c.api?.thinkingParams || {};   // 控件不在场（保存其他区块）→ 原值
        const raw = node.value.trim();
        if (!raw) return { __replace__: {} };
        try {
          const o = JSON.parse(raw);
          if (o && typeof o === 'object' && !Array.isArray(o)) return { __replace__: o };
          throw new Error('not-object');
        } catch {
          const h = document.querySelector('#cfg-thinking-params-hint');
          if (h) { h.textContent = 'JSON 解析失败：已保留原值。格式示例：{"low":{"reasoning_effort":"low"}}'; h.className = 'hint error'; }
          return c.api.thinkingParams || {};
        }
      })(),
      // 高级逃生口：非法 JSON 保留原值；同样要能"清空"（__replace__）——否则配错一个会让所有
      // 请求 400 的 extraBody 从界面上永远清不掉（实测）。
      extraBody: (() => {
        const node = document.querySelector('#cfg-extra-body');
        if (!node) return c.api?.extraBody || {};   // 控件不在场（保存其他区块）→ 原值
        const raw = node.value.trim();
        if (!raw) return { __replace__: {} };
        try {
          const o = JSON.parse(raw);
          if (o && typeof o === 'object' && !Array.isArray(o)) return { __replace__: o };
          throw new Error('not-object');
        } catch {
          const h = document.querySelector('#cfg-extra-body-hint');
          if (h) { h.textContent = 'JSON 解析失败：已保留原值。格式示例：{"reasoning":{"enabled":false}}'; h.className = 'hint error'; }
          return c.api.extraBody || {};
        }
      })(),
      temperature: numKeep(val('#cfg-temperature', c.api.temperature), c.api.temperature, 0, 2, 0.8),
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

  if (sec === 'asr') {
    // 语音识别的 Key 与搜索的 Key 各自独立：****** = 保持原 Key 不变，明文/新输入才更新
    const enteredAsrKey = val('#cfg-asr-key', '').trim();
    const enteredAsrSecretId = val('#cfg-asr-secretid', '').trim();
    const enteredAsrSecretKey = val('#cfg-asr-secretkey', '').trim();
    // 界面上只有两个模式 + 一个服务预设；这里把它们翻译成真实配置：
    //   免费本机 → provider=local；API Key → 火山=volc，其余=openai（地址来自预设或手填）
    const asrMode = val('#cfg-asr-mode', String(c.asr?.provider || 'local') === 'local' ? 'local' : 'api');
    const asrService = val('#cfg-asr-service', '');
    // provider 一律取自"当前选中的服务预设" —— 硬编码几个 id 会漏（新加的服务会静默落到 openai：
    // 2026-09-26 审查就抓到过同类问题，那次是 apiKeyProvider 读了个不存在的元素）
    const pickedService = ASR_SERVICES.find((item) => item.id === asrService);
    let asrProviderNext;
    if (asrMode === 'local') asrProviderNext = 'local';
    else if (pickedService) asrProviderNext = pickedService.provider;
    else asrProviderNext = String(c.asr?.provider || 'openai');   // 预设控件没渲染时保留原值
    patch.asr = {
      ...(c.asr || {}),
      enabled: chk('#cfg-asr', c.asr?.enabled !== false),
      provider: asrProviderNext,
      // 自己填 1-200；**清空 = 保持原值**（不是变成 1），其余一律走 normalizeAsrMax ——
      // 与显示口径、后端 config.asrMaxPerHour 完全一致（非正数/坏值按 12，不是夹到 1；
      // 2026-09-26 审查：原来用 clampInt 会把 -5 存成 1，和"非正数按 12"的文档口径打架）
      maxPerHour: normalizeAsrMax(
        val('#cfg-asr-max', '').trim() || c.asr?.maxPerHour
      ),
      baseUrl: val('#cfg-asr-baseurl', c.asr?.baseUrl || '').trim(),
      model: val('#cfg-asr-model', c.asr?.model || '').trim(),
      language: val('#cfg-asr-lang', c.asr?.language || '').trim(),
      localBin: val('#cfg-asr-bin', c.asr?.localBin || '').trim(),
      localModel: val('#cfg-asr-localmodel', c.asr?.localModel || '').trim(),
      // 少数几家要两个/三个凭据（百度/腾讯/讯飞）；掩码 ****** 表示保持原值不变。
      // 新填/替换凭据时都记下"是给哪家存的"：换了服务/地址后后端不再拿旧凭据去请求别家
      // （2026-09-26 审查，跨服务串用已实测）
      appId: val('#cfg-asr-appid', c.asr?.appId || '').trim(),
      ...(enteredAsrSecretId && enteredAsrSecretId !== '******'
        ? { secretId: enteredAsrSecretId, secretIdProvider: asrProviderNext } : {}),
      ...(enteredAsrSecretKey && enteredAsrSecretKey !== '******'
        ? { secretKey: enteredAsrSecretKey, secretKeyProvider: asrProviderNext } : {}),
      ...(enteredAsrKey && enteredAsrKey !== '******'
        ? {
          apiKey: enteredAsrKey,
          apiKeyProvider: asrProviderNext,
          // OpenAI 兼容还要记地址主机（硅基流动/Groq/OpenAI 都是 openai 这一家）
          ...(asrProviderNext === 'openai'
            ? { apiKeyHost: asrHostOf(val('#cfg-asr-baseurl', c.asr?.baseUrl || '')) }
            : {})
        }
        : {})
    };
      patch.tts = (() => {
        const t = c.tts || {};
        const keyNode = document.querySelector('#cfg-tts-key');
        const rawKey = keyNode ? keyNode.value.trim() : '';
        return {
          ...t,
          enabled: chk('#cfg-tts-enabled', t.enabled === true),
          // provider 必须跟着"当前选中的预设"走：少了它，火山/MiniMax 会被当 openai 兼容打（2026-09-28 审查 P1）
          provider: (() => {
            const opt = document.querySelector('#cfg-tts-service')?.selectedOptions?.[0];
            return opt?.dataset?.provider || t.provider || 'openai';
          })(),
          // Key 归属按"选中的预设 id"算（custom/openai/siliconflow/…）：自建地址不在预设
          // 主机表里，服务端只按地址反查会落到 provider 字符串上（2026-09-29 审查 P0）
          service: document.querySelector('#cfg-tts-service')?.value || '',
          baseUrl: String(val('#cfg-tts-baseurl', t.baseUrl || '') || '').trim(),
          appId: String(val('#cfg-tts-appid', t.appId || '') || '').trim(),
          cluster: String(val('#cfg-tts-cluster', t.cluster || '') || '').trim(),
          resourceId: String(val('#cfg-tts-resourceid', t.resourceId || '') || '').trim(),
          groupId: String(val('#cfg-tts-groupid', t.groupId || '') || '').trim(),
          model: String(val('#cfg-tts-model', t.model || '') || '').trim(),
          voice: String(val('#cfg-tts-voice', t.voice || '') || '').trim(),
          speed: Math.min(4, Math.max(0.25, Number(val('#cfg-tts-speed', t.speed ?? 1)) || 1)),
          gain: Math.min(10, Math.max(-10, Number(val('#cfg-tts-gain', t.gain ?? 0)) || 0)),
          // 只送"这一家新填的"；掩码/空 = 保持（服务端合并进 keys[这家]）
          apiKeyInput: rawKey === '******' ? '' : rawKey
        };
      })();
      // 图片生成：与 tts 同页（同一个 if 分支内），Key 语义也一样（掩码/空 = 保持原值）
      patch.imageGen = (() => {
        const g = c.imageGen || {};
        const keyNode = document.querySelector('#cfg-img-key');
        const rawKey = keyNode ? keyNode.value.trim() : '';
        return {
          ...g,
          enabled: chk('#cfg-img-enabled', g.enabled === true),
          baseUrl: String(val('#cfg-img-baseurl', g.baseUrl || '') || '').trim(),
          model: String(val('#cfg-img-model', g.model || '') || '').trim(),
          size: String(val('#cfg-img-size', g.size || '') || '').trim(),
          maxPerHour: normalizeImageGenMax(val('#cfg-img-max', g.maxPerHour), 6),   // 与运行期 imageGenMaxPerHour 同口径
          // 服务端据此合并：掩码/空 = 保持原 Key；新输入才替换
          ...(rawKey && rawKey !== '******' ? { apiKey: rawKey } : {})
        };
      })();
  }

  if (sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    const enteredDoubaoKey = val('#cfg-doubao-key', '').trim();
    const enteredTavilyKey = val('#cfg-tavily-key', '').trim();
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
      tavily: {
        ...(c.webSearch?.tavily || {}),
        ...(enteredTavilyKey && enteredTavilyKey !== '******' ? { apiKey: enteredTavilyKey } : {})
      },
      aggregate: {
        sources: val('#cfg-aggregate-sources', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 4),
        count: Math.min(6, Math.max(2, Number(val('#cfg-aggregate-count', '')) || 4))
      },
      // ⚠️ 这里**故意不带** webSearch.providers（自定义搜索服务列表）：它由「添加自定义搜索服务」
      // 按钮单独管理（POST /api/search-providers），且每家的 Key 存在 providers[].apiKey。
      // 以前这里回传了整份列表（上方 ...c.webSearch 已经带上了），而列表来自脱敏视图（apiKey 被删）
      // —— deepMerge 对数组是整体替换，于是"保存设置"一次就把所有自定义搜索服务的 Key 清空
      // （2026-10-03 全量审查实测）。置 undefined = 这一项本次不提交。
      providers: undefined
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
    patch.drainDelayMs = numKeep(val('#cfg-draindelay', c.drainDelayMs), c.drainDelayMs, 0, 600000, 1200);
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
      byLengthMs: numKeep(val('#cfg-bylength', c.send?.byLengthMs), c.send?.byLengthMs, 0, 1000, 20),
      hardSplitAt: Number(val('#cfg-hardsplit', c.send?.hardSplitAt)) || 0
      // typingIndicator 的控件在「平台能力」页 → 由下面 sec === 'platform' 的块负责保存；
      // 这里靠 ...c.send 原样带过，不读别的分区的控件
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      checkIntervalMinMs: Number(val('#cfg-pro-min', c.proactive?.checkIntervalMinMs)) || 1800000,
      checkIntervalMaxMs: Number(val('#cfg-pro-max', c.proactive?.checkIntervalMaxMs)) || 5400000,
      probability: numKeep(val('#cfg-pro-prob', c.proactive?.probability), c.proactive?.probability, 0, 1, 0.25),
      // 默认 true（与升级前行为一致）：没这个控件时才退回已保存配置
      followUpEnabled: chk('#cfg-pro-followup', c.proactive?.followUpEnabled !== false),
      selfWakeEnabled: chk('#cfg-pro-selfwake', c.proactive?.selfWakeEnabled !== false)
    };
    // 收藏总闸（2026-10-02 用户反馈"乱收藏"）：界面是**一个开关** = collectEnabled 与
    // autoCollect 一起开/一起关（自动收与主动收都归它管，两个名字太像、分开摆会造成误解）。
    // 两个键在配置里仍独立，手改可以只关"自动扫图"那条；手改出的混合状态在界面上显示为"关"，
    // 保存时按"一起关"落盘（控件缺失的旧页面按已保存值回退，不会误抹）。
    const stickerCollectOn = chk('#cfg-sticker-collect',
      c.sticker?.collectEnabled !== false && c.sticker?.autoCollect !== false);
    patch.sticker = {
      ...c.sticker,
      enabled: chk('#cfg-sticker', c.sticker?.enabled !== false),
      collectEnabled: stickerCollectOn,
      autoCollect: stickerCollectOn,
      // 输入框口径与"每小时最多转写"一致：清空保持原值、0/负数回默认、超出按 1~60 收口
      maxCollectPerHour: normalizeStickerCollectMax(
        val('#cfg-sticker-collect-max', '').trim() || c.sticker?.maxCollectPerHour
      ),
      // 先取界面实时值（没这个控件时才退回已保存配置），再钳到 0~3
      encourage: Math.min(3, Math.max(0, Number(
        $('#cfg-sticker-encourage') ? $('#cfg-sticker-encourage').value : (c.sticker?.encourage ?? 1)
      ) || 0)),
      // 输入框：清空保持原值、0/负数回默认、超出按 1~60 收口（与"每小时最多转写"同一口径）
      promptMaxStickers: normalizeStickerMax(
        val('#cfg-sticker-max', '').trim() || c.sticker?.promptMaxStickers
      )
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

  // 「平台能力」页的保存块（2026-10-07 复审 P1）：这些控件只由这个分区渲染，
  // 而这段装配原来挂在 chat 分区里 —— 在平台页点保存时 sec === 'platform'，
  // 连进去的机会都没有：patch 是空的、界面却提示"已保存"，开关只能手改 config.json 才生效。
  // 今后这个页面的任何新开关都必须进这个块。
  if (sec === 'platform') {
    // 「正在输入」控件在本页、配置键在 send 段：updateConfig 是 deepMerge，
    // 只带这一个键不会碰 send 段的其他字段。
    patch.send = {
      typingIndicator: chk('#cfg-typing', c.send?.typingIndicator !== false)
    };
    // 平台能力开关：与 DEFAULT_CONFIG.platform 一一对应，
    // 缺控件时按已保存值回退（旧页面/旧存档不会把开关误抹）。
    const platform = { ...c.platform };
    // 门控键（读/写分开的 15 项）：键名表与渲染同一份（platform.js）。
    // 缺控件时按已保存值回退、没存过就按内置默认取向 —— 渲染失败也不会把开关抹成默认。
    for (const key of ALL_GATE_KEYS) {
      const saved = typeof c.platform?.[key] === 'boolean' ? c.platform[key] : gateDefaultOn(key);
      platform[key] = chk(`#${gateCheckboxId(key)}`, saved);
    }
    // 音色（下拉；列表由 platform.js 异步补全）：缺控件时按已保存值回退
    platform.qqVoiceCharacter = String(val('#cfg-platform-voicechar', c.platform?.qqVoiceCharacter || '')).trim();
    // 写入闸门上限：**留空/非法 = 不写这一项**，让服务端的内置默认真正生效。
    // （原来写的是 ui 里那份 dflt —— 那是第二份真源：服务端以后收紧默认值，
    //   点过一次保存的实例就会把旧数字固化进 config，永远不跟着变。2026-10-07 审计 P2）
    // 用 __replace__ 整表替换：这样"清空输入框"能把 config 里那一项**真删掉**（回落默认），
    // 而不是留在那里让旧值继续生效。
    // 取整与服务端 platformQuotaLimit 同口径：夹到 1~200、向下取整（0<n<1 也不许变成 0 ——
    // 闸门内部把 0 当"不限量"）。
    const quotas = {};
    for (const [key] of QUOTA_ROWS) {
      const raw = String(val(`#cfg-platform-quota-${key}`, '')).trim();
      const n = Number(raw);
      if (!raw || !Number.isFinite(n) || n <= 0) continue;
      quotas[key] = Math.max(1, Math.min(200, Math.floor(n)));
    }
    platform.quotas = { __replace__: quotas };
    // 按群覆盖：草稿（platform.js 维护，切群不丢）里所有群的改动一次提交。
    // __replace__ 是必须的 —— 普通深合并删不掉"被清空的群"。
    // 草稿只在编辑器真渲染过之后才存在（白名单为空 / 渲染失败时它没有）：
    // 那种情况回落到已保存值，别拿空表把用户之前的覆盖悄悄清掉。
    const perGroupDraft = state.platformPerGroupDraft
      ?? (c.platform?.perGroup && typeof c.platform.perGroup === 'object' ? c.platform.perGroup : {});
    platform.perGroup = { __replace__: structuredClone(perGroupDraft) };
    // 全局行为开关（不属于工具门控）：已读标记 / 日报卡片仍走全局
    platform.readReceipts = chk('#cfg-platform-readreceipts', c.platform?.readReceipts === true);
    platform.forwardCards = chk('#cfg-platform-forwardcards', c.platform?.forwardCards !== false);
    patch.platform = platform;
  }

  if (sec === 'desktop' || sec === 'appearance') {
    // 外观那十来项都在"点了就生效"，这里只负责把它们持久化。取值一律走 appearancePatch：
    // 它是 ui/core/appearance.js 里那份"模型 → 可存对象"的唯一映射，加一个轴只改那一处，
    // 免得出现"界面能调、保存丢了"（这个坑本轮之前踩过：面板挂在别的 section 里就全存不下去）。
    const appearanceNow = appearancePatch(currentAppearance());
    patch.ui = {
      ...(c.ui || {}),
      ...appearanceNow,
      // 明暗落在 ui.theme 上（老字段，服务端与首屏内联脚本都在用），不是 ui.mode
      theme: appearanceNow.mode,
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      // 兜底与运行期 refreshIntervalMs 一样夹到 >=1000：原来不夹，界面显示 500、实际按 15000 跑
      refreshMs: Math.max(1000, Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000)
    };
    delete patch.ui.mode;
    // 不再回传 memberNotes：备注有自己的写入口（人物记忆页 saveMemberNote 的 __replace__ /
    // 模型工具 set_member_note），这里拿可能过期的快照做深合并，会把别处已删的备注合并复活
    //（2026-10-10 复核：深合并删不掉键，但能把控制台快照里还留着的键加回来）。
  }

  if (sec === 'onebot') {
    // 协议端自动更新开关（属于 autoUpdate 段；同一个区块里还有 agent 自己的自动更新设置）
    patch.autoUpdate = {
      ...(c.autoUpdate || {}),
      snowluma: {
        ...(c.autoUpdate?.snowluma || {}),
        enabled: chk('#cfg-snowluma-auto', c.autoUpdate?.snowluma?.enabled === true),
        // 默认开：勾选框未渲染（老页面）时保持服务端原值语义（!== false 即视为开）
        followBaseline: chk('#cfg-snowluma-follow-baseline', c.autoUpdate?.snowluma?.followBaseline !== false)
      }
    };
    // 这两个令牌的"保持不变"是**留空**（服务端不认 ****** 这个哨兵，真提交会把令牌
    // 改成字面量 ******），所以掩码一律当"没改"。控制台的「显示/隐藏」在隐藏时
    // 已把输入框还原成空，这里再兜一层，防别的路径把掩码留在框里。
    const tokenOf = (sel) => {
      const raw = val(sel, '').trim();
      return raw === '******' ? '' : raw;
    };
    const wsToken = tokenOf('#cfg-obtoken');
    const httpToken = tokenOf('#cfg-obhttptoken');
    // 心跳策略：只有三个合法值；界面里是下拉框，兜底仍按 auto（服务端也有一层兜底）。
    const hb = val('#cfg-wsheartbeat', 'auto').trim();
    // 补课窗口：留空/非法 = 不改（清空输入框就变成"一律不回复"太吓人），0 才是显式的"只补记录"。
    const rawWindow = val('#cfg-catchup-window', '').trim();
    const windowMin = rawWindow === '' ? null : Number(rawWindow);
    patch.onebot = {
      wsUrl: val('#cfg-wsurl', c.onebot?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.onebot?.httpUrl || '').trim(),
      wsHeartbeat: ['auto', 'on', 'off'].includes(hb) ? hb : 'auto',
      ...(windowMin !== null && Number.isFinite(windowMin) && windowMin >= 0
        ? { catchupReplyWindowMs: Math.round(windowMin * 60000) }
        : {}),
      ...(wsToken ? { accessToken: wsToken } : {}),
      ...(httpToken ? { httpAccessToken: httpToken } : {})
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  // 按群覆盖草稿作废：下次渲染从刚保存的配置重新克隆。不清的话，若别的标签页/直连 API
  // 改过 perGroup，本页再用陈旧草稿提交就会整体覆盖回去（__replace__ 是整表替换，2026-10-07 审计 P3）。
  state.platformPerGroupDraft = undefined;
  // 「平台能力」页的右列（工具清单 + "当前用量 x / 上限 y"）是**渲染时**拉的：保存后不重拉
  // 就会一直挂着旧上限，看起来像"改了没生效"（2026-10-07 用户实测反馈）。
  if (state.settingsSection === 'platform') void hydratePlatformGates();
  state.thinkingTouched = false;
  state.thinkingTouchedHost = '';
  // 思考区（摘要/提示/段位）跟着新配置立即刷新——否则"改了但摘要还是旧值"（2026-09-27 实测）。
  if (document.getElementById('thinking-seg-slot')) {
    syncThinkingUi(val('#cfg-baseurl', state.config?.api?.baseUrl) || state.config?.api?.baseUrl || '');
  }
  syncGraduatedFeatureNavigation(state.config);
  if (!quiet) setStatusLabel('#model-label', `模型：${state.config.api.model || '未设置'}`);
  return data;
}


export { saveConfig };