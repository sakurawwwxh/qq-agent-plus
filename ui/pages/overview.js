// 「总览」首页（2026-10-08）：把散在顶栏、用量页、异常页、设置页的关键状态收成一屏。
//
// 为什么要有它：以前打开控制台落在「会话」列表上，而"机器人连着没""今天花了多少""有没有
// 待处理异常""这台机器磁盘满没满"要分别去四个地方（顶栏一行、用量页、异常页、还得 ssh 看主机）。
// 这里只做**只读聚合**：一个数据源失败就少一格（不整页失败），所有数字都来自现成接口。
'use strict';

import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { applyIcons, iconSvg } from '../core/icons.js';
// switchTab 是 app.js 的模块导出（**不是** window 上的全局）。以前这里写 window.switchTab，
// 生产环境里那个函数根本不存在：点「全部异常 →」只会抛 TypeError，链接完全没反应
// （测试里看不出来，因为沙箱把模块拍平成普通脚本，函数恰好成了全局）。
import { switchTab } from '../app.js';
// 异常等级/状态的中文名与色块**复用常量表**：服务端的取值是 warning/acknowledged，
// 这里曾经自己写了一份 warn/acked 的小表，结果英文原样漏到界面上、色块也丢了
// （2026-10-08 审查）。
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STATE_LABELS } from '../core/constants.js';

const SEVERITY_LABEL = INCIDENT_SEVERITY_LABELS;
const STATE_LABEL = INCIDENT_STATE_LABELS;
const SEVERITY_CLASS = { critical: 'bad', error: 'bad', warning: 'warn', info: '' };

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// 时间一律按 **Asia/Shanghai** 解释：服务端按上海自然日切分用量（src/core/util.js 的
// todayKey/shanghaiDayStart），这里若用浏览器本地时区，非 UTC+8 的管理员会看到"今天的柱子
// 是 0 次"、时间戳与别的页也对不上（2026-10-08 审查）。上海没有夏令时，所以 +8h 取 UTC 字段
// 与 Asia/Shanghai 完全等价 —— 和服务端用的是同一个算法。
const ZONE_OFFSET_MS = 8 * 3600 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

/** 上海时区下的 YYYY-MM-DD（与服务端 todayKey 同口径，用于和 /api/usage/stats 的 day 对齐）。 */
function shDay(ts = Date.now()) {
  const n = Number(ts);
  const d = new Date((Number.isFinite(n) ? n : Date.now()) + ZONE_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0 || n > 8.64e15) return '—';
  const d = new Date(n + ZONE_OFFSET_MS);
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  return shDay(n) === shDay(Date.now()) ? `${hh}:${mm}` : `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${hh}:${mm}`;
}

function days(n) {
  const out = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i -= 1) out.push(shDay(now - i * 86400_000));
  return out;
}

/** KPI 卡：图标 + 标签 + 大数字 + 副行（副行可含 chip）。 */
function kpi({ icon, label, value, sub = '', chip = '', id = '' }) {
  return `
    <div class="kpi"${id ? ` id="${id}"` : ''}>
      <div class="kpi-head"><span class="kpi-ico">${iconSvg(icon, { size: 16 })}</span><span class="kpi-label">${esc(label)}</span></div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}${chip ? ` <span class="chip ${chip.cls || ''}">${esc(chip.text)}</span>` : ''}</div>
    </div>`;
}

function bar(percent, cls = '') {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<div class="meter ${cls}"><div class="meter-fill" style="width:${p}%"></div></div>`;
}

/** 近 N 天用量迷你柱状图：柱高按最大值归一，今天的柱子高亮。 */
function miniBars(rows) {
  const max = Math.max(1, ...rows.map((r) => Number(r.calls) || 0));
  return `<div class="bars">${rows.map((r, i) => {
    const calls = Number(r.calls) || 0;
    const h = Math.round((calls / max) * 100);
    const isToday = i === rows.length - 1;
    return `<div class="bars-col" title="${esc(r.day)}　${calls} 次调用　¥${(Number(r.cost) || 0).toFixed(3)}">
      <div class="bars-bar${isToday ? ' on' : ''}" style="height:${Math.max(calls ? 4 : 0, h)}%"></div>
      <div class="bars-x">${esc(String(r.day).slice(5))}</div>
    </div>`;
  }).join('')}</div>`;
}

function panel(title, sub, body, { icon = '', actions = '' } = {}) {
  return `
    <section class="panel">
      <div class="panel-head">
        ${icon ? `<span class="panel-ico">${iconSvg(icon, { size: 16 })}</span>` : ''}
        <div class="panel-titles"><h3>${esc(title)}</h3>${sub ? `<div class="panel-sub">${sub}</div>` : ''}</div>
        <div class="panel-actions">${actions}</div>
      </div>
      <div class="panel-body">${body}</div>
    </section>`;
}

async function loadOverview() {
  const box = document.getElementById('overview-page');
  if (!box) return;
  if (!box.dataset.ready) {
    box.innerHTML = '<div class="hint" style="padding:24px">正在读取总览…</div>';
  }
  // 六个数据源各自独立：任何一个失败都不该让整页空着
  const [status, usage, incidents, snowluma, host, config, health] = await Promise.all([
    api('/api/status').catch(() => null),
    api('/api/usage/stats?range=7d').catch(() => null),
    api('/api/incidents?limit=5').catch(() => null),
    api('/api/snowluma/version').catch(() => null),
    api('/api/host').catch(() => null),
    api('/api/config').catch(() => null),
    api('/api/health').catch(() => null)
  ]);

  const onebot = status?.onebot || {};
  const usageToday = status?.usage || {};
  const selfName = onebot?.self?.nickname ? String(onebot.self.nickname) : '';
  // 运行模式在 /api/status.orchestrator.mode 里；不要把 observe 误显示成"运行中"。
  const runMode = status?.orchestrator?.mode;
  const modeText = status?.paused ? '已暂停' : (runMode === 'observe' ? '观察模式' : '运行中');
  const modeChip = status?.paused ? { text: '暂停', cls: 'warn' } : null;

  // 首启体检：装完控制台最怕“不知道还差什么”。这五项是机器人能开口的最小集合，
  // 每项都给一个直达入口；全部完成后这块自动消失，不占老用户的空间。
  const asList = (value) => (Array.isArray(value) ? value : []);
  const allowOk = asList(config?.allow?.groups).length > 0
    || asList(config?.allow?.private).length > 0
    || config?.allowAllWhenEmpty === true;
  const modelOk = Boolean(config?.api?.baseUrl && config?.api?.model);
  const qqOk = Boolean(selfName || onebot?.self?.userId);
  const setupSteps = [
    {
      key: 'model',
      label: '模型 API',
      ok: modelOk,
      detail: modelOk ? '已配置' : '还没填地址、Key 或模型名',
      action: modelOk ? '' : '<button type="button" class="btn btn-small" data-open-settings="api">去配置</button>'
    },
    {
      key: 'onebot',
      label: 'OneBot 连接',
      ok: Boolean(onebot.connected),
      detail: onebot.connected ? '已连接' : (onebot.everConnected ? '连接断开' : '协议端还没连上'),
      action: onebot.connected ? '' : '<button type="button" class="btn btn-small" data-open-settings="onebot">看设置</button>'
    },
    {
      key: 'qq',
      label: 'QQ 登录',
      ok: qqOk,
      detail: qqOk ? `已登录${selfName ? ` · ${esc(selfName)}` : ''}` : '还没拿到登录信息',
      action: qqOk ? '' : '<button type="button" class="btn btn-small" data-setup-tab="control">去扫码</button>'
    },
    {
      key: 'allow',
      label: '聊天白名单',
      ok: allowOk,
      detail: allowOk ? '已配置' : '还没有群或私聊，机器人不会回任何消息',
      action: allowOk ? '' : '<button type="button" class="btn btn-small" data-open-settings="allow">去添加</button>'
    },
    {
      key: 'mode',
      label: '运行模式',
      ok: runMode === 'active',
      detail: runMode === 'active' ? '活跃' : '观察模式（只看不回）',
      action: runMode === 'active' ? '' : '<button type="button" class="btn btn-small" data-setup-tab="control">去切换</button>'
    }
  ];
  const setupDone = setupSteps.filter((step) => step.ok).length;
  const setupPanel = setupDone === setupSteps.length ? '' : panel(
    '开始使用',
    `${setupDone}/${setupSteps.length} 项就绪 · 按顺序做完，机器人就能在群里回复`,
    `<ul class="setup-list">${setupSteps.map((step) => `
      <li class="setup-row${step.ok ? ' is-done' : ''}">
        <span class="setup-mark">${iconSvg(step.ok ? 'check' : 'plus', { size: 14 })}</span>
        <span class="setup-main">
          <span class="setup-label">${esc(step.label)}</span>
          <span class="setup-detail">${step.detail}</span>
        </span>
        ${step.action ? `<span class="setup-action">${step.action}</span>` : ''}
      </li>`).join('')}</ul>`,
    { icon: 'sparkles' }
  );
  const healthResults = Array.isArray(health?.health?.lastResults) ? health.health.lastResults : [];
  const healthFailed = healthResults.filter((item) => item?.ok === false);
  // 出站账本里有"结果未知"的动作：可能已经生效、但没拿到确认。它**不是**巡检失败项
  // （巡检有自己的连续失败语义），单独在面板里列一行；也不宣称"已停止重试" ——
  // 直连写工具只登记不拦截，日报/提醒/终局才会按账本停。
  const unknownEffects = Number(status?.effects?.byState?.unknown) || 0;
  const effectRow = unknownEffects > 0
    ? `<li class="setup-row">
        <span class="setup-mark">${iconSvg('plus', { size: 14 })}</span>
        <span class="setup-main"><span class="setup-label">出站动作待核对</span>
          <span class="setup-detail">${unknownEffects} 个动作结果未知（可能已生效）：日报/提醒/终局已停止自动重试，直连写只记录；明细/改判见 node src/ops.js effects list</span></span>
      </li>`
    : '';
  const healthPanel = (healthFailed.length || effectRow) ? panel(
    '运行体检',
    healthFailed.length ? `${healthFailed.length} 项异常 · 最近一次巡检结果` : '有出站动作结果未知，需要人工核对',
    `<ul class="setup-list">${healthFailed.slice(0, 6).map((item) => `
      <li class="setup-row">
        <span class="setup-mark">${iconSvg('plus', { size: 14 })}</span>
        <span class="setup-main"><span class="setup-label">${esc(item.name || '检查项')}</span>
          <span class="setup-detail">${esc(item.detail || '异常')}</span></span>
        <span class="setup-action"><button type="button" class="btn btn-small" data-setup-tab="control">去处理</button></span>
      </li>`).join('')}${effectRow}</ul>`,
    { icon: 'sparkles' }
  ) : '';

  const incidentList = Array.isArray(incidents?.incidents) ? incidents.incidents : [];
  // 计数字段在 status.counts 里（open / acknowledged / resolved / critical）—— 别猜扁平键名
  const counts = incidents?.status?.counts || {};
  const openCount = Number(counts.open) || 0;
  const criticalCount = Number(counts.critical) || 0;
  const ackedCount = Number(counts.acknowledged) || 0;

  const slVersion = String(snowluma?.currentVersion || '');
  const slContainer = snowluma?.container === true;
  const slChip = slContainer ? { text: '容器模式', cls: 'ok' }
    : !snowluma?.installed ? { text: '未检测到', cls: '' }
      : snowluma?.outdated ? { text: `落后 → ${snowluma.targetVersion}`, cls: 'warn' }
        : snowluma?.belowRecommended ? { text: `低于推荐 ${snowluma.minRecommended}`, cls: 'warn' }
          : { text: '已是最新', cls: 'ok' };

  // 按天的行在 stats.days 里（不是 rows）；每天的次数用 exactCalls，runs 是另一维
  const statDays = Array.isArray(usage?.days) ? usage.days : [];
  const dayRows = days(7).map((day) => {
    const hit = statDays.find((r) => String(r.day) === day) || {};
    return { day, calls: Number(hit.exactCalls) || Number(hit.runs) || 0, cost: Number(hit.cost) || 0 };
  });
  const calls7d = Number(usage?.totals?.exactCalls) || Number(usage?.totals?.runs) || 0;

  // cacheHitRate 是**比例**（0.7456），要 ×100 才是百分比 —— 顶部状态条也是这么算的
  const cacheHit = (Number(status?.cacheHitRate) || 0) * 100;
  // 花费与顶部状态条同源：台账与会话口径取较大值（改价后台账可能仍是旧快照，
  // 不能因此把真实成本藏起来），旧后端没有 ledgerCost 时自然回退 cost.cost。
  const todayCost = Math.max(
    Number(status?.cost?.ledgerCost) || 0,
    Number(status?.cost?.cost) || 0,
    Number(usageToday.estimatedYuan) || 0
  );
  // 后台调用（记忆整理等）不写 session 文件，只在台账里；差额就是它们
  const bgCost = Math.max(0,
    (Number(status?.cost?.ledgerCost) || 0) - (Number(status?.cost?.cost) || 0));
  // 最近异常列表：没有记录时给一句空状态，不渲染空 <ul>
  const incidentBody = incidentList.length
    ? `<ul class="feed">
        ${incidentList.map((it) => `
          <li>
            <span class="feed-time">${fmtTime(it.lastAt)}</span>
            <span class="chip ${SEVERITY_CLASS[it.severity] || ''}">${esc(SEVERITY_LABEL[it.severity] || it.severity)}</span>
            <span class="feed-text" title="${esc(String(it.message || it.code || ''))}">${esc(String(it.message || it.code || '').slice(0, 90))}</span>
            ${it.count > 1 ? `<span class="muted">×${it.count}</span>` : ''}
            <span class="muted">${esc(STATE_LABEL[it.state] || it.state)}</span>
          </li>`).join('')}
      </ul>`
    : '<div class="hint">最近没有异常记录。</div>';
  const mem = host?.mem || null;
  const disk = host?.disk || null;
  // 会话留档占用（/api/status.storage）：磁盘快满时用户至少能看到是谁占的。
  const storage = status?.storage || null;
  const storageLine = storage
    ? `会话留档 ${fmtNum(storage.files)} 个 · ${fmtBytes(storage.bytes)}`
      + `${storage.compressedFiles ? `（已压缩 ${fmtNum(storage.compressedFiles)} 个）` : ''}`
      + ` · 上限 ${Number(storage.maxTotalBytes) > 0 ? fmtBytes(storage.maxTotalBytes) : '不限制'}`
      + `${Number(storage.maxTotalBytes) > 0 && storage.bytes >= Number(storage.maxTotalBytes) * 0.8 ? ' · 接近上限' : ''}`
    : '';

  box.dataset.ready = '1';
  box.innerHTML = `
    <div class="pane-head">
      <div>
        <h2>总览</h2>
        <div class="pane-sub">机器人、协议端与这台机器的当前状态 · 数据每次打开这一页时刷新</div>
      </div>
      <button class="btn btn-small" id="overview-refresh">${iconSvg('refresh', { size: 15 })}<span>刷新</span></button>
    </div>

    ${setupPanel}

    ${healthPanel}

    <div class="kpi-grid">
      ${kpi({
        icon: 'zap', label: '机器人', id: 'kpi-bot',
        value: `<span class="dot ${onebot.connected ? 'dot-on' : 'dot-off'}"></span>${esc(modeText)}`,
        sub: onebot.connected
          ? `OneBot 已连接${selfName ? ` · ${esc(selfName)}` : ''}`
          : (onebot.everConnected ? 'OneBot 未连接（曾连上过）' : 'OneBot 还没连上过'),
        chip: modeChip
      })}
      ${kpi({
        icon: 'activity', label: '今日运行',
        value: `${fmtNum(usageToday.runs)} <span class="kpi-unit">次</span>`,
        sub: `近 7 天 ${fmtNum(calls7d)} 次调用 · 联网 ${fmtNum(status?.webSearchCount)} 次`
      })}
      ${kpi({
        icon: 'coins', label: '今日花费（估算）',
        value: `¥${todayCost.toFixed(3)}`,
        sub: `缓存命中 ${cacheHit.toFixed(1)}% · ${fmtNum(usageToday.totalTokens)} tok`
          + (Number(usageToday.unpricedRuns) ? ` · ${usageToday.unpricedRuns} 次未计价` : '')
          // 后台调用（记忆整理等）不写 session 文件，只在台账里；差额就是它们
          + (bgCost > 0.0005 ? ` · 含后台 ¥${bgCost.toFixed(3)}` : '')
      })}
      ${kpi({
        icon: 'alert', label: '待处理异常',
        value: `${fmtNum(openCount)} <span class="kpi-unit">条</span>`,
        sub: `严重 ${criticalCount} · 已确认 ${ackedCount}`,
        chip: criticalCount ? { text: '需要处理', cls: 'bad' } : (openCount ? null : { text: '干净', cls: 'ok' })
      })}
      ${kpi({
        icon: 'globe', label: '协议端（SnowLuma）',
        value: slVersion ? `v${esc(slVersion)}` : (slContainer ? '由 compose 管理' : '—'),
        sub: slContainer
          ? '容器模式 · 更新请改 compose 里的镜像 tag'
          : (snowluma?.installed
            ? `容器${snowluma.running ? '运行中' : '未运行'} · 基线 v${esc(snowluma.targetVersion || '')}`
            : '没检测到协议端 compose 项目'),
        chip: slChip
      })}
    </div>

    <div class="grid-2">
      ${panel('连接与身份', '机器人接的是哪个协议端、用的哪个模型', `
        <dl class="kv">
          <dt>OneBot</dt><dd>${onebot.connected ? '<span class="chip ok">已连接</span> 正向 WebSocket + HTTP API' : '<span class="chip">未连接</span>（地址与令牌在「OneBot」设置页）'}</dd>
          <dt>机器人</dt><dd>${selfName ? `${esc(selfName)}${onebot.self?.userId ? ` · ${esc(onebot.self.userId)}` : ''}` : '（还没拿到登录信息）'}</dd>
          <dt>模型</dt><dd>${esc(status?.orchestrator?.model || '（未设置）')}</dd>
          <dt>协议端</dt><dd>${slVersion ? `v${esc(slVersion)}` : '—'} · <a href="#" id="overview-goto-onebot" class="panel-link" data-open-settings="onebot">去更新 / 看详情</a></dd>
        </dl>`, { icon: 'link' })}
      ${panel('最近异常', `最近 ${incidentList.length} 条 · 点标题看全部`, incidentBody,
      { icon: 'alert', actions: '<a href="#" id="overview-goto-incidents" class="panel-link">全部异常 →</a>' })}
    </div>

    ${panel('近 7 天用量', `共 ${fmtNum(calls7d)} 次调用 · ¥${(Number(usage?.totals?.cost) || 0).toFixed(3)}`,
    dayRows.some((r) => r.calls) ? miniBars(dayRows) : '<div class="hint">这 7 天没有调用记录。</div>', { icon: 'activity' })}

    ${panel('主机资源', host ? `${esc(host.hostname || '')}${host.cpuModel ? ` · ${esc(host.cpuModel)}` : ''}${host.cpuCount ? ` · ${host.cpuCount} 核` : ''}` : '没读到主机信息', host ? `
      <div class="grid-3">
        <div class="stat">
          <div class="stat-label">CPU 负载</div>
          <div class="stat-value">${host.loadavg ? host.loadavg.map((v) => v.toFixed(2)).join(' / ') : '<span class="muted">不可用</span>'}</div>
          <div class="stat-sub">1 / 5 / 15 分钟${host.loadavg ? '' : '（Windows 上 Linux 语义的 loadavg 不存在，看下面的进程内存）'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">内存</div>
          <div class="stat-value">${mem ? `${mem.usedPercent}%` : '—'}</div>
          ${mem ? bar(mem.usedPercent) : ''}
          <div class="stat-sub">${mem ? `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}` : '读不到'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">磁盘（数据目录）</div>
          <div class="stat-value">${disk ? `${disk.usedPercent}%` : '—'}</div>
          ${disk ? bar(disk.usedPercent, disk.usedPercent >= 90 ? 'bad' : disk.usedPercent >= 75 ? 'warn' : '') : ''}
          <div class="stat-sub">${disk ? `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}${disk.usedPercent >= 90 ? ' · 快满了' : ''}` : '读不到'}</div>
        </div>
      </div>
      <div class="hint" style="margin-top:8px">本进程 ${host.process ? `RSS ${fmtBytes(host.process.rss)} · 堆 ${fmtBytes(host.process.heapUsed)} / ${fmtBytes(host.process.heapTotal)}` : '—'}${host.process?.nodeVersion ? ` · Node ${esc(host.process.nodeVersion)}` : ''} · 运行 ${Math.floor((host.uptimeSec || 0) / 3600)} 小时</div>
      ${storageLine ? `<div class="hint" style="margin-top:4px">${storageLine}</div>` : ''}`
      : '<div class="hint">没读到主机信息（接口不可用）。</div>', { icon: 'cpu' })}
  `;

  applyIcons(box);
  animateKpiCounters(box);
  box.querySelectorAll('[data-setup-tab]').forEach((el) => {
    el.addEventListener('click', () => switchTab(el.dataset.setupTab));
  });
  document.getElementById('overview-refresh')?.addEventListener('click', () => { delete box.dataset.ready; loadOverview(); });
  // 「去更新 / 看详情」不在这里绑定：它带 data-open-settings="onebot"，由 app.js 里那**一个**
  // 全局委托处理（老写法是自己 switchTab + 派发一个 qa-settings-section 事件，而那个事件全仓
  // 没有任何监听者 —— 换分区这件事从来没发生）。
  document.getElementById('overview-goto-incidents')?.addEventListener('click', (e) => { e.preventDefault(); switchTab('incidents'); });
}

/** 上一次渲染时各 KPI 的数字（label → 数值）：用来“变了才滚，没变就直接显示”。 */
const KPI_SEEN = new Map();

/** KPI 计数动画的时长（ms）。比 CSS 里那四档时长长一点：数字滚动是“看清楚”而不是“反馈”。 */
const KPI_COUNT_MS = 520;

/**
 * KPI 大数字的计数动画：从“上一次的值”滚到“这一次的值”，首次进页面则从 0 起。
 *
 * 三条约束都是真实取舍，改之前先想清楚：
 *   ① 只在数字真的变了时才滚。总览页每次切回来都会重渲染，而多数 KPI 是不变的 ——
 *      每次都从 0 重滚一遍会让人以为数据在跳变，切页签时尤其吵。
 *   ② 版本号（v1.14.22）这类不滚：文本以字母打头的直接跳过。
 *   ③ 减弱/关闭动效、系统 prefers-reduced-motion 时一律直接显示终值（不滚）。
 *
 * 不去改渲染模板（kpi() 的 value 是调用方给的 HTML 片段），而是渲染后按文本节点处理：
 * 只动“数字打头”的那个纯文本节点，前缀（如 ¥）与后缀原样保留。
 */
function animateKpiCounters(root) {
  // 取视图的方式与其他 ui/core 模块一致（document.defaultView）—— 而且测试里有一条
  // 守卫在扫 `window.x =` 形状的全局挂载，直接写 window.xxx === 会被当成违规（它按字面扫）。
  const doc = root.ownerDocument || document;
  const view = doc.defaultView;
  const motionAttr = doc.documentElement.getAttribute('data-motion') || '';
  const reduceBySystem = Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  if (motionAttr || reduceBySystem) return;

  for (const card of root.querySelectorAll('.kpi')) {
    const val = card.querySelector('.kpi-value');
    const label = card.querySelector('.kpi-label')?.textContent?.trim() || '';
    if (!val || !label) continue;
    const node = Array.from(val.childNodes)
      .find((n) => n.nodeType === 3 && /\d/.test(n.nodeValue || ''));
    if (!node) continue;
    const raw = node.nodeValue || '';
    // 前缀（¥ / 空）+ 数字（允许千分位与小数）+ 后缀（空格之类）
    const m = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(\s*)$/.exec(raw);
    // 前缀带字母 = v1.2.3 这类版本号，不滚
    if (!m || /[a-z]/i.test(m[1])) continue;
    const target = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(target)) continue;
    const prev = KPI_SEEN.get(label);
    KPI_SEEN.set(label, target);
    const from = typeof prev === 'number' ? prev : 0;
    if (from === target) { node.nodeValue = raw; continue; }

    const decimals = (m[2].split('.')[1] || '').length;
    const grouped = m[2].includes(',');
    const format = (n) => {
      let s = n.toFixed(decimals);
      if (grouped) {
        const [whole, frac] = s.split('.');
        s = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
      }
      return `${m[1]}${s}${m[3]}`;
    };

    // 用视图的 requestAnimationFrame（拿不到就退成 setTimeout），与 ui/core 里那几个模块同口径
    const raf = view?.requestAnimationFrame?.bind(view)
      || ((fn) => setTimeout(() => fn(Date.now()), 16));
    const start = view?.performance?.now ? view.performance.now() : Date.now();
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / KPI_COUNT_MS));
      // 三次方缓出：与 style.css 的 --ease-out-quart 观感同族。CSS token 没法直接喂给 JS，
      // 这里取一个同族的近似即可（真要逐帧一致得把贝塞尔求解器抄进来，不值当）。
      const eased = 1 - Math.pow(1 - t, 3);
      node.nodeValue = format(from + (target - from) * eased);
      // 收尾一定回到渲染时的原串：避免 toFixed 留下不同的小数位（如 ¥12.340）
      if (t < 1) raf(step);
      else node.nodeValue = raw;
    };
    raf(step);
  }
}

export { loadOverview };
