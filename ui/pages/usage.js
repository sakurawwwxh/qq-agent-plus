// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import { closeModelModal, loadSettings, modelModalShell } from '../app.js';
import { api } from '../core/api.js';
import { TOOL_CAT_ORDER, TOOL_META, USAGE_RANGES } from '../core/constants.js';
import { $, $$, esc } from '../core/dom.js';
import { closeDialog } from '../core/dom-util.js';
import {
  chatNameOf, effectivePriceFor, fmtTime, fmtTok, fmtTokens, fmtYuan, formatChatTitle, hasOwnPrice,
  matchPriceTable, mulOf, priceTxt
} from '../core/format.js';
import { state } from '../core/state.js';
import { openPriceDialog } from './settings.js';

const FEATURE_LABELS = {
  chat: '聊天',
  'living-memory': '长期记忆提炼',
  'memory-consolidation': '记忆整理',
  'group-digest': '群日报',
  'admin-briefing': '管理员早报',
  external: '其他后台'
};
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
    box.innerHTML = '<div class="muted" style="font-size: var(--fs-sm)">还没有配置渠道价目表。用下面的「从渠道自动拉价」探测一次，或直接填 URL。</div>';
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
    sourceTxt = `内置官方价格表已匹配到「${eff.matched || model}」（${tag}）。这是估算口径，不是你的账单；`
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

/** 保存定价弹窗：只写 modelPrices 的一条（键 = 渠道：模型 或 模型）。 */
async function savePriceDialog() {
  const st = state.priceDialogState;
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
    closeDialog($('#price-dialog'));
    refreshModelPriceCard();
    // 用量页正在看的话，让它重算（价格变了）
    if (state.tab === 'usage') loadUsageView({ force: true });
  } catch (error) {
    if (result) { result.textContent = `保存失败：${error.message}`; result.className = 'control-result error'; }
  }
}

/** 删除当前正在生效的那条自定义/渠道价。 */
async function deletePriceDialog() {
  const st = state.priceDialogState;
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
    closeDialog($('#price-dialog'));
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
      body: '<div class="empty-hint">模型目录为空：请先在「模型 API」页签选服务预设或填地址添加。</div>',
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
        <span class="muted" style="font-size: var(--fs-sm);white-space:nowrap">留空 = 不自定义（走官方表/兜底）</span>
      </div>
      <div class="ma-body dual">
        <div class="model-modal-left" id="bp-left"></div>
        <div class="model-modal-right" id="bp-right"></div>
      </div>
      <div id="bp-hint" class="muted" style="font-size: var(--fs-sm);flex-shrink:0;margin-top:8px">
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
        <td title="${esc(offTitle)}">${esc(p.names[m] || m)}${billBadge}<div class="muted" style="font-size: var(--fs-xs)">${esc(m)}</div></td>
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

// 由 ui/core/widgets.js 机械拆出（2026-10-01，同一次「UI 结构治理」：把混装的叶子按域归位）。
// 从 app.js 机械切出（只切不改，语句逐字节一致）；跨文件引用走 import，可变状态挂 state。

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

      <div data-block="features">
        <h3 class="usage-h3">今日按功能</h3>
        <table class="usage-table" data-table="features">
          <thead><tr><th>功能</th><th class="r">调用</th><th class="r">Token</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  // 「调用次数」卡片可点开明细（骨架重建后重新绑定，所以放在 renderUsagePage 里）
  const runsCard = $('#usage-page #runs-card');
  if (runsCard) runsCard.addEventListener('click', () => openToolBreakdown());

  $$('#usage-page [data-range]').forEach((el) => {
    el.addEventListener('click', () => {
      state.usageRange = el.dataset.range;
      loadUsageView({ force: true });
    });
  });
  $('#usage-refresh-btn')?.addEventListener('click', () => loadUsageView({ force: true }));

  // 行点击 → 弹明细（键盘同样：Enter/Space）
  for (const [table, kind] of [['days', 'day'], ['chats', 'chat'], ['models', 'model']]) {
    const host = box.querySelector(`[data-table="${table}"]`);
    if (!host) continue;
    host.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-key]');
      if (tr) openUsageBreakdown(kind, tr.dataset.key);
    });
    host.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr[data-key]');
      if (!tr) return;
      e.preventDefault();
      openUsageBreakdown(kind, tr.dataset.key);
    });
  }

  // 「按模型」表的展开/收起（超过 20 行才显示）。2026-10-09 审查：这个按钮原先只被
  // fill() 改文案，全仓没有点击监听、也没有地方置 expanded —— 是死的，模型多时永远看不全。
  box.querySelector('#models-expand')?.addEventListener('click', () => {
    const tbody = box.querySelector('[data-table="models"] tbody');
    if (!tbody) return;
    tbody.dataset.expanded = tbody.dataset.expanded === '1' ? '0' : '1';
    updateUsagePage(stats, st, prices);
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
  // 主数字 searchCount 是**联网动作总数**（服务端把 web_search 与 web_fetch 一起记进 webSearchCount），
  // 所以副标题给的是拆分。原来两个分支写成同一句字面量（死逻辑，2026-10-01 审查）：
  // 真正要区分的是"搜了没抓" / "抓了没搜" / "两者都有"——抓页要下正文、更占上下文。
  const searches = Number(stats?.searchCount) || 0;
  const searched = Number(stats?.toolCounts?.web_search) || 0;
  const fetched = Number(stats?.toolCounts?.web_fetch) || 0;
  set('search', fmtTok(searches));
  set('search-sub', !searches
    ? '本区间没有联网'
    : (searched && fetched
      ? `搜索 ${fmtTok(searched)} 次 + 抓网页 ${fmtTok(fetched)} 次`
      : (searched ? '只做了联网搜索（没抓网页）'
        : (fetched ? '只抓了网页（没走搜索）'
          // 有总数却没有工具明细（老会话的 messages 里没有 toolCall 记录）：这里只能说不清，
          // 不能默认"只抓了网页"——那是凭空的结论（2026-10-01 第五轮审查）。
          : '明细未记录（工具计数是较新版本才记的）'))));
  set('prompt', fmtTok(t.promptTokens));
  set('prompt-sub', `输出 ${fmtTok(t.completionTokens)}`);
  set('rate', `${((t.cacheHitRate || 0) * 100).toFixed(1)}%`);
  set('rate-sub', `命中 ${fmtTok(t.cachedTokens)} / 输入 ${fmtTok(t.promptTokens)}`);
  // 今日区间优先台账口径（含记忆整理等后台调用）；历史区间仍用会话聚合。
  // 改价后 ledgerCost 可能还是旧的 0/低值，取 max 避免把真实成本藏起来（2026-11-01 复审）。
  const ledgerCost = Number(st?.cost?.ledgerCost) || 0;
  const shownCost = stats?.range === 'today'
    ? Math.max(ledgerCost, Number(t.cost) || 0)
    : (Number(t.cost) || 0);
  set('cost', fmtYuan(shownCost));
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
    el.classList.toggle('btn-primary', el.dataset.range === String(state.usageRange));
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
    if (tbody.dataset.sig !== html) {
      tbody.innerHTML = html;
      tbody.dataset.sig = html;
      // 明细是"点这一行"打开的，键盘也要能开：<tr> 不是原生可聚焦元素，得自己补 tabindex/role
      for (const tr of tbody.querySelectorAll('tr[data-key]')) {
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
      }
    }
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

  const features = Object.entries(stats?.features || {})
    .map(([key, value]) => ({ key, ...(value || {}) }))
    .sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));
  fill('features', features, (f) => `
    <tr data-key="${esc(f.key)}">
      <td>${esc(FEATURE_LABELS[f.key] || f.key)}</td>
      <td class="r">${Number(f.calls) || 0}</td>
      <td class="r">${fmtTok(Number(f.tokens) || 0)}</td>
      <td class="r">${fmtYuan(Number(f.cost) || 0)}</td>
    </tr>`);
}

async function loadUsageView({ force = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;

  // ── 轮询刷新：只更新数值，不重建 DOM ──
  if (!force) {
    // 首载失败过的话，错误页里没有 [data-field] 骨架：轮询只改数值会永远停在"加载失败"
    // （切走再回来才自愈）。发现没有骨架就直接走一次强制重建（2026-10-12 审查）。
    if (!$('#usage-page [data-field="runs"]')) return loadUsageView({ force: true });
    try {
      const [stats, st] = await Promise.all([
        api(`/api/usage/stats?range=${state.usageRange}`),
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
  const token = ++state.usageLoadToken;
  const range = state.usageRange;

  // ★ 先用上一次的数据立即渲染（如果有的话），而不是先画骨架等网络。
  //   后端统计的冷启动实测约 200ms（要遍历全部会话文件），热数据只要 24ms；
  //   但缓存 TTL 只有 5 秒、轮询 4 秒一次，切回用量页时缓存经常已经过期，
  //   于是每次都要等那 200ms —— 表现就是"点过去黑一下"。
  //   有旧数据时直接先画出来（0ms 可见），再在后台拉新的覆盖。
  const cached = state.usageLastData && state.usageLastData.range === range ? state.usageLastData : null;
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
    if (token !== state.usageLoadToken) return;
    if (state.tab !== 'usage' || state.usageRange !== range) return;

    state.usageStats = stats;
    state.usageLastData = { range, stats, st, prices };

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
    if (token !== state.usageLoadToken) return;
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
    // head 由 modelModalShell 统一 esc：这里再 esc 一次会双重转义（& 显示成 &amp;）
    head: `明细：${dimLabel} ${key}`,
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

  // 2026-10-09 审查：快速切换维度时两个请求会并发 —— 先发的后到会覆盖新视图，
  // 且 URL 里的 by 在发起时求值、列名/表体用的是 await 之后的 activeBy（表头与数据错位）。
  // 用递增令牌丢弃过期响应，并把 by 在发起时快照，两者都同一口径。
  let loadToken = 0;
  async function load() {
    const myToken = ++loadToken;
    const by = activeBy;
    bodyEl.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
    try {
      const r = await api(`/api/usage/breakdown?range=${encodeURIComponent(state.usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${by}`);
      if (myToken !== loadToken) return;   // 已有更新的请求在途：这次响应作废
      peakEl.innerHTML = peakSplitHtml(r.totals);
      colEl.textContent = { model: '模型', chat: '会话', day: '日期' }[by] || '项目';
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
              <td>${esc(by === 'chat'
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
      if (myToken !== loadToken) return;   // 过期请求的失败同样不许覆盖新视图
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
      resultEl.innerHTML = `<div class="muted" style="font-size: var(--fs-sm)">试过的地址：<br>${res.tried.map((u) => esc(u)).join('<br>')}</div>`;
    }
    return;
  }
  const entries = Object.entries(res.prices || {});
  // 这段最终进 textContent（下面 statusEl.textContent）—— 写 textContent 不需要转义，
  // esc 会把 & 之类显示成实体（2026-10-09 审查）。
  const kindTxt = res.kind === 'one-api'
    ? `按 one-api/new-api 倍率换算（分组 ${res.group || 'default'} ×${res.groupRatio} · 汇率 ${res.usdRate}）`
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
    ${entries.length > 12 ? `<div class="muted" style="font-size: var(--fs-sm);margin-top:4px">…等共 ${entries.length} 个模型</div>` : ''}
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
      if (hx) { hx.textContent = '拿不到当前渠道名，无法写成渠道价：请先在「模型 API」里配好渠道。'; hx.className = 'hint error'; }
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
    foot: '<div class="muted" style="font-size: var(--fs-xs)">工具调用本身不额外计费，成本来自它们消耗的 token。</div>'
  });
}


export {
  addChannelFeed, deletePriceDialog, loadUsageView, onChannelFeedAction, openBatchPriceModal,
  refreshModelPriceCard, renderChannelFeeds, renderPriceFeedStatus, runChannelProbe, savePriceDialog
};