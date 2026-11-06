// 长期语义记忆页面：服务状态、召回验证、记忆维护与图谱解释。
// 版式与「技能」页保持一致：页头 + KPI + 页签；四个面板一次渲染、切换只切显隐，
// 这样设置里的输入值不会因为来回切页签而丢，浏览器冒烟也能稳定找到控件。
import { api } from '../core/api.js';
import { askForConfirmation, setBoxError, setHtmlIfChanged } from '../core/dom-util.js';
import { $, esc } from '../core/dom.js';
import { iconSvg } from '../core/icons.js';
import { state } from '../core/state.js';

const PAGE_SIZE = 10;

const TYPE_LABELS = {
  episode: '事件', fact: '事实', profile: '人物画像', preference: '偏好',
  commitment: '约定', project: '项目', rule: '规则'
};

const RECALL_MODE_LABELS = {
  hybrid: '混合检索',
  'hybrid-degraded': '关键词检索（语义分支暂时降级）',
  'lexical-pending-vectors': '关键词检索（等待首条向量记忆）',
  lexical: '关键词检索'
};

function lm() { return state.livingMemory; }
function config() { return lm().status?.config || state.config?.livingMemory || {}; }
function runtime() { return lm().status?.status || {}; }
function stats() { return runtime().stats || {}; }

function num(value) { return Number(value) || 0; }

function scopeTitle(key, chats = []) {
  const found = chats.find((chat) => chat.key === key);
  if (found?.chatName) return `${found.chatName}（${key.slice(key.indexOf(':') + 1)}）`;
  if (key === 'owner-global') return '管理员全局知识';
  return key.startsWith('group:') ? `群聊 ${key.slice(6)}` : `私聊 ${key.slice(8)}`;
}

function selectedScope() {
  return lm().selectedScope || '';
}

function shortDate(value) {
  const time = Number(value) || 0;
  if (!time) return '-';
  try { return new Date(time).toLocaleString('zh-CN', { hour12: false }); } catch { return '-'; }
}

function statePill(tone, text) {
  return `<span class="lm-state ${tone}"><i></i>${esc(text)}</span>`;
}

function recallModeLabel(mode) {
  return RECALL_MODE_LABELS[String(mode || '')] || String(mode || 'unknown');
}

function vectorLabel(memory) {
  if (memory.vectorStatus === 'ready') return '已向量化';
  if (memory.vectorStatus === 'none') return '仅关键词';
  if (memory.vectorStatus === 'error') return '向量失败';
  return '待处理';
}

function chatScopes() {
  const cfg = config();
  const chats = lm().chats || [];
  const list = chats.filter((chat) => /^group:\d+$/.test(chat.key));
  if (cfg.allowPrivate === true) list.push(...chats.filter((chat) => /^private:\d+$/.test(chat.key)));
  if (cfg.allowGlobal === true) list.push({ key: 'owner-global', chatName: '管理员全局知识' });
  return list;
}

function scopeOptionsHtml(selected) {
  return chatScopes().map((chat) =>
    `<option value="${esc(chat.key)}" ${chat.key === selected ? 'selected' : ''}>${esc(scopeTitle(chat.key, lm().chats))}</option>`
  ).join('');
}

function serviceNote() {
  const cfg = config();
  const rt = runtime();
  if (rt.ok === false) return statePill('bad', rt.error || '长期记忆初始化失败');
  if (cfg.enabled !== true) return statePill('idle', '已停用 · 不写入、不召回');
  // 新建的库是懒初始化的：还没提炼过第一条记忆时 initialized=false 是正常等待，不是故障。
  if (rt.initialized === false) return statePill('idle', '已启用 · 等待首条记忆');
  const embedding = rt.embedding?.configured === true;
  const ready = num(stats().vectorReady) > 0;
  if (!embedding) return statePill('ok', '本地存储 · 关键词检索');
  return statePill('ok', ready ? '本地存储 · 混合检索' : '本地存储 · 等待首条向量');
}

function modeLabel(cfg) {
  if (cfg.enabled !== true) return '关闭';
  return cfg.mode === 'active' ? '注入' : '影子';
}

function modeHint(cfg) {
  if (cfg.enabled !== true) return '不写入、不召回';
  return cfg.mode === 'active' ? '每次回复前自动召回并注入提示词' : '只记录召回结果，不会进入提示词';
}

function pageErrorHtml() {
  return lm().pageError ? `<div class="skills-error">${esc(lm().pageError)}</div>` : '';
}

// ── 概览 ────────────────────────────────────────────────────────────────

function recentRow(memory) {
  const archived = memory.status === 'archived';
  return `<button type="button" class="lm-recent-row${archived ? ' is-archived' : ''}" data-lm-open="${esc(memory.id)}">
    <span class="lm-type">${esc(TYPE_LABELS[memory.type] || memory.type || '记忆')}</span>
    <span class="lm-recent-main">
      <strong>${esc(memory.summary || memory.content || '未命名记忆')}</strong>
      <small>${esc(shortDate(memory.updatedAt))}${archived ? ' · 已归档' : ''}</small>
    </span>
    <span class="lm-recent-side">${esc(vectorLabel(memory))}</span>
  </button>`;
}

function overviewHtml() {
  const cfg = config();
  const st = stats();
  // 概览永远看当前范围的全量最近记忆，不受「记忆库」页签的状态筛选影响。
  const overview = lm().overviewList || { entries: [], total: 0 };
  const recent = (overview.entries || []).slice(0, 6);
  const total = Number(overview.total) || 0;
  const scope = selectedScope();
  const groups = Array.isArray(cfg.groups) ? cfg.groups.filter(Boolean) : [];
  const autoScope = cfg.allowPrivate === true ? '群聊 + 私聊' : '仅群聊';
  // 只有两三条记忆时，两栏里左卡会明显短一截，右侧空出一大块。少于 3 条就改成上下堆叠，
  // 新实例（0 条）则直接显示三步引导，不再留一张空卡片。
  const stacked = recent.length < 3;
  return `
  <div class="lm-kpis">
    <article class="lm-kpi"><span>活跃记忆</span><strong>${num(st.active)}</strong><small>全部 ${num(st.total)} 条</small></article>
    <article class="lm-kpi"><span>已向量化</span><strong>${num(st.vectorReady)}</strong><small>可参与语义检索</small></article>
    <article class="lm-kpi"><span>来源回合</span><strong>${num(st.turns)}</strong><small>本地 SQLite 留痕</small></article>
    <article class="lm-kpi"><span>运行模式</span><strong>${esc(modeLabel(cfg))}</strong><small>${esc(modeHint(cfg))}</small></article>
  </div>
  <div class="lm-overview-cols${stacked ? ' is-stacked' : ''}">
    <section class="lm-card">
      <div class="lm-card-head">
        <div><span class="lm-section-kicker">最近写入</span><h3>${esc(scope ? scopeTitle(scope, lm().chats) : '当前范围的记忆')}</h3><p>按更新时间倒序，最近的 6 条会出现在这里。</p></div>
        <div class="lm-card-head-actions">
          <select id="lm-overview-scope" class="lm-scope-select" aria-label="概览记忆范围">${scopeOptionsHtml(scope) || '<option value="">暂无会话</option>'}</select>
          <button type="button" class="btn btn-small" data-lm-jump="memories">管理全部</button>
        </div>
      </div>
      ${recent.length
        ? `<div class="lm-recent">${recent.map(recentRow).join('')}</div>`
        : (!scope
          ? '<div class="lm-empty">还没有可管理的会话。先在设置里启用长期记忆，并确认群聊已在允许范围内。</div>'
          : `<div class="lm-onboarding">
            <div class="lm-onboarding-step"><b>1</b><div><strong>确认长期记忆已开启</strong><small>${cfg.enabled === true ? `当前已启用 · ${esc(modeLabel(cfg))}` : '当前已停用，打开开关后才会开始记录'}</small></div><button type="button" class="btn btn-small" data-lm-jump="settings">看设置</button></div>
            <div class="lm-onboarding-step"><b>2</b><div><strong>在群里正常聊几轮</strong><small>累计 ${num(cfg.captureMinMessages) || 6} 个回合后会自动提炼；影子模式只记录，不影响回复。</small></div></div>
            <div class="lm-onboarding-step"><b>3</b><div><strong>回来核对，或手动补录</strong><small>提炼出的卡片会出现在这里；也可以直接写一条。</small></div><button type="button" class="btn btn-small" data-lm-jump="memories">打开记忆库</button></div>
          </div>`)}
      ${recent.length ? `<div class="lm-recent-foot">共 ${total} 条；完整列表在「记忆库」。</div>` : ''}
    </section>
    <section class="lm-card">
      <div class="lm-card-head">
        <div><span class="lm-section-kicker">运行策略</span><h3>现在会做什么</h3><p>详细参数在「设置」页签调整。</p></div>
        <button type="button" class="btn btn-small" data-lm-jump="settings">调整</button>
      </div>
      <dl class="lm-kv">
        <div><dt>运行模式</dt><dd>${esc(modeLabel(cfg))}<small>${esc(modeHint(cfg))}</small></dd></div>
        <div><dt>自动记忆</dt><dd>${esc(cfg.enabled === true ? autoScope : '关闭')}</dd></div>
        <div><dt>管理员全局知识</dt><dd>${cfg.allowGlobal === true ? '允许' : '关闭'}</dd></div>
        <div><dt>每轮召回</dt><dd>最多 ${num(cfg.maxRecallItems) || 6} 条<small>注入不超过 ${num(cfg.maxInjectChars) || 2400} 字</small></dd></div>
        <div><dt>来源回合保留</dt><dd>${Number(cfg.turnRetentionDays) === 0 ? '永久保留' : `${num(cfg.turnRetentionDays) || 7} 天`}</dd></div>
        <div><dt>生效群</dt><dd>${groups.length ? `${groups.length} 个指定群` : '所有群'}</dd></div>
      </dl>
      <p class="lm-card-note">影子模式只记录召回结果，不改写回复；确认命中质量后再切换到「注入」。</p>
    </section>
  </div>
  <section class="lm-card lm-graph-card">
    <div class="lm-card-head">
      <div><span class="lm-section-kicker">关系视图</span><h3>知识图谱</h3><p>实体与关系只来自当前会话范围内的记忆卡片。</p></div>
      <button type="button" class="btn btn-small" id="lm-graph-refresh">${iconSvg('refresh', { size: 13 })}刷新图谱</button>
    </div>
    ${graphHtml(lm().graph)}
  </section>`;
}

// ── 记忆库 ──────────────────────────────────────────────────────────────

function memoryToolbarHtml() {
  const cfg = config();
  const scope = selectedScope();
  return `<div class="lm-toolbar">
    <select id="lm-scope" class="lm-scope-select" aria-label="记忆范围">${scopeOptionsHtml(scope) || '<option value="">暂无会话</option>'}</select>
    <input type="search" id="lm-search" value="${esc(lm().search)}" placeholder="搜索摘要、正文、标签" aria-label="搜索长期记忆" />
    <select id="lm-status-filter" aria-label="记忆状态">
      <option value="" ${!lm().statusFilter ? 'selected' : ''}>全部状态</option>
      <option value="active" ${lm().statusFilter === 'active' ? 'selected' : ''}>仅活跃</option>
      <option value="archived" ${lm().statusFilter === 'archived' ? 'selected' : ''}>仅已归档</option>
    </select>
    <div class="lm-viewtoggle" role="group" aria-label="视图">
      <button type="button" class="lm-viewbtn ${lm().view === 'list' ? 'is-on' : ''}" data-lm-view="list" title="列表">${iconSvg('layers', { size: 14 })}</button>
      <button type="button" class="lm-viewbtn ${lm().view === 'grid' ? 'is-on' : ''}" data-lm-view="grid" title="卡片">${iconSvg('layout', { size: 14 })}</button>
    </div>
    <button type="button" class="btn btn-small ${lm().createOpen ? 'is-on' : ''}" id="lm-new-toggle" aria-expanded="${lm().createOpen ? 'true' : 'false'}">新建记忆</button>
    <button type="button" class="btn btn-small" id="lm-list-refresh" title="刷新列表">${iconSvg('refresh', { size: 14 })}</button>
  </div>
  ${cfg.allowPrivate !== true && scope.startsWith('private:') ? '<p class="lm-toolbar-note">当前私聊范围是之前选中的；私聊自动记忆关闭时不会再写入新记忆。</p>' : ''}`;
}

function createHtml() {
  return `<section class="lm-create" id="lm-create-drawer" ${lm().createOpen ? '' : 'hidden'}>
    <div class="lm-create-head"><h4>手动新建记忆</h4><p>适合补录约定、项目背景或群里确认过的事实。不要输入密码、Token 或敏感资料。</p></div>
    <div class="lm-form-grid lm-form-grid-two">
      <label class="lm-field">类型<select id="lm-new-type">${Object.entries(TYPE_LABELS).map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('')}</select></label>
      <label class="lm-field">重要度<input id="lm-new-importance" type="number" min="0" max="10" step="0.1" value="5" /></label>
    </div>
    <label class="lm-field">摘要<input id="lm-new-summary" maxlength="260" placeholder="一句话概括这条长期记忆" /></label>
    <label class="lm-field">正文<textarea id="lm-new-content" rows="4" maxlength="1600" placeholder="保存有长期价值、可验证的信息"></textarea></label>
    <label class="lm-field">标签（逗号分隔）<input id="lm-new-tags" placeholder="项目, NAS, 约定" /></label>
    <div class="skills-error" id="lm-create-error" hidden></div>
    <div class="lm-create-actions"><button type="button" class="btn btn-small btn-primary" id="lm-create">创建记忆</button></div>
  </section>`;
}

function filteredEntries() {
  const query = String(lm().search || '').trim().toLowerCase();
  const entries = lm().list?.entries || [];
  if (!query) return entries;
  return entries.filter((memory) => [memory.summary, memory.content, ...(memory.tags || []), ...(memory.entities || [])]
    .join(' ').toLowerCase().includes(query));
}

function memoryPagerHtml(page, totalPages, total) {
  if (totalPages <= 1) return '';
  const nums = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i += 1) {
    nums.push(`<button type="button" class="plugin-page${i === page ? ' is-on' : ''}" data-lm-page="${i}" aria-current="${i === page ? 'page' : 'false'}">${i}</button>`);
  }
  return `<nav class="plugin-pagination" data-pages="${totalPages}" aria-label="长期记忆分页">
    <button type="button" class="plugin-page" data-lm-page="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    ${nums.join('')}
    <button type="button" class="plugin-page" data-lm-page="next" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
    <span class="plugin-page-summary">第 ${page} / ${totalPages} 页 · 共 ${total} 条</span>
  </nav>`;
}

function memoryRowHtml(memory) {
  const archived = memory.status === 'archived';
  const tags = (memory.tags || []).slice(0, 4).map((tag) => `<span>${esc(tag)}</span>`).join('');
  return `<article class="lm-memory-row${archived ? ' is-archived' : ''}" data-lm-open="${esc(memory.id)}" role="button" tabindex="0" aria-label="查看记忆：${esc(memory.summary || '未命名记忆')}">
    <div class="lm-memory-main">
      <div class="lm-memory-top">
        <span class="lm-type">${esc(TYPE_LABELS[memory.type] || memory.type || '记忆')}</span>
        <strong>${esc(memory.summary || memory.content || '未命名记忆')}</strong>
        ${archived ? '<span class="lm-flag">已归档</span>' : ''}
      </div>
      <p class="lm-memory-desc">${esc(memory.content || '')}</p>
      <div class="lm-memory-meta">
        <span>重要度 ${Number(memory.importance || 0).toFixed(1)}</span>
        <span>${esc(vectorLabel(memory))}</span>
        <span>${esc(shortDate(memory.updatedAt))}</span>
        ${tags ? `<span class="lm-tags">${tags}</span>` : ''}
      </div>
    </div>
    <div class="lm-memory-actions">
      ${archived
        ? `<button type="button" class="btn btn-small" data-lm-restore="${esc(memory.id)}">恢复</button>`
        : `<button type="button" class="btn btn-small" data-lm-archive="${esc(memory.id)}">归档</button>`}
      <button type="button" class="btn btn-small btn-danger" data-lm-delete="${esc(memory.id)}">删除</button>
    </div>
  </article>`;
}

function memoryListHtml() {
  const all = filteredEntries();
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(lm().page) || 1), totalPages);
  lm().page = page;
  const entries = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const hint = lm().list?.entries?.length === 0
    ? (selectedScope()
      ? '这个会话还没有长期记忆。启用影子模式后，让机器人完成若干轮有价值的对话即可自动提炼。'
      : '先选择一个会话；没有可选项时，请在设置里放宽记忆范围。')
    : '没有匹配当前搜索或状态筛选的记忆。';
  const loaded = lm().list?.entries?.length || 0;
  const serverTotal = Number(lm().list?.total) || all.length;
  return `<div class="lm-list-summary" id="lm-list-summary">${serverTotal ? `共 ${serverTotal} 条` : ''}${serverTotal > loaded ? ` · 当前显示最近 ${loaded} 条` : ''}${lm().search ? ` · 搜索「${esc(lm().search)}」` : ''}</div>
    <div id="lm-memory-list" class="lm-memory-list${lm().view === 'grid' ? ' is-grid' : ''}">${entries.length ? entries.map(memoryRowHtml).join('') : `<div class="lm-empty">${esc(hint)}</div>`}</div>
    <div id="lm-memory-pager">${memoryPagerHtml(page, totalPages, all.length)}</div>`;
}

function memoryDetailHtml(memory) {
  if (!memory) return '';
  const archived = memory.status === 'archived';
  const relations = (memory.relations || []).map((relation) => `<li>${esc(relation.source)} <b>${esc(relation.predicate || '关联')}</b> ${esc(relation.target)}</li>`).join('');
  const entities = (memory.entities || []).map((entity) => `<span>${esc(entity)}</span>`).join('');
  const tags = (memory.tags || []).map((tag) => `<span>${esc(tag)}</span>`).join('');
  const source = memory.source || {};
  return `<div class="lm-detail-top">
    <button type="button" class="btn btn-small" data-lm-back>← 返回记忆库</button>
    <div class="lm-detail-actions">
      ${archived
        ? `<button type="button" class="btn btn-small" data-lm-restore="${esc(memory.id)}">恢复</button>`
        : `<button type="button" class="btn btn-small" data-lm-archive="${esc(memory.id)}">归档</button>`}
      <button type="button" class="btn btn-small btn-danger" data-lm-delete="${esc(memory.id)}">删除</button>
    </div>
  </div>
  <article class="lm-detail-card">
    <header class="lm-detail-head">
      <div class="lm-detail-chips">
        <span class="lm-type">${esc(TYPE_LABELS[memory.type] || memory.type || '记忆')}</span>
        <span class="lm-state ${archived ? 'idle' : 'ok'}"><i></i>${archived ? '已归档' : '活跃'}</span>
      </div>
      <h3>${esc(memory.summary || '未命名记忆')}</h3>
      <p>${esc(scopeTitle(memory.scopeKey || selectedScope(), lm().chats))} · 更新于 ${esc(shortDate(memory.updatedAt))}</p>
    </header>
    <div class="lm-facts">
      <div><small>重要度</small><strong>${Number(memory.importance || 0).toFixed(1)}</strong></div>
      <div><small>置信度</small><strong>${Math.round((Number(memory.confidence) || 0) * 100)}%</strong></div>
      <div><small>向量状态</small><strong>${esc(vectorLabel(memory))}</strong></div>
      <div><small>创建时间</small><strong>${esc(shortDate(memory.createdAt))}</strong></div>
    </div>
    <section class="lm-detail-section"><h4>记忆正文</h4><div class="lm-prose">${esc(memory.content || '')}</div></section>
    <section class="lm-detail-section"><h4>标签</h4><div class="lm-tags">${tags || '<span class="is-soft">无</span>'}</div></section>
    <section class="lm-detail-section"><h4>实体</h4><div class="lm-tags">${entities || '<span class="is-soft">无</span>'}</div></section>
    <section class="lm-detail-section"><h4>关系</h4>${relations ? `<ul class="lm-relations">${relations}</ul>` : '<p class="lm-muted">暂无关系</p>'}</section>
    <section class="lm-detail-section"><h4>来源</h4><p class="lm-muted">会话：${esc((source.sessionIds || []).join('、') || '手动创建')} · 聚合 ${num(source.turnCount)} 个回合</p></section>
  </article>`;
}

function memoryViewHtml() {
  if (lm().detail) return memoryDetailHtml(lm().detail);
  return memoryToolbarHtml() + createHtml() + memoryListHtml();
}

function renderMemoryView() {
  const host = $('#lm-memory-view');
  if (host) host.innerHTML = memoryViewHtml();
}

// ── 召回测试 ────────────────────────────────────────────────────────────

function renderRecall(result) {
  if (!result) return '<div class="lm-empty">输入问题后运行测试；结果会显示最终注入文本和排序理由。</div>';
  if (result.error) return `<div class="skills-error">${esc(result.error)}</div>`;
  const rows = (result.entries || []).map((entry) => `<article class="lm-recall-row">
    <div><strong>${esc(entry.summary)}</strong><p>${esc(entry.content)}</p></div>
    <div><span>综合 ${Number(entry.retrieval?.score || 0).toFixed(3)}</span><small>语义 ${Number(entry.retrieval?.semantic || 0).toFixed(3)} · 关键词 ${Number(entry.retrieval?.lexical || 0)}</small></div>
  </article>`).join('');
  return `<div class="lm-recall-note"><strong>${esc(recallModeLabel(result.mode))}</strong>${result.vectorError ? ` · 向量降级：${esc(result.vectorError)}` : ''}</div>
    ${rows || '<div class="lm-empty">没有匹配记忆。</div>'}
    <details class="lm-injected"><summary>本轮会注入的上下文</summary><pre>${esc(result.injectedText || '影子模式或没有内容')}</pre></details>`;
}

function recallHtml() {
  return `<section class="lm-card">
    <div class="lm-card-head">
      <div><span class="lm-section-kicker">召回验证</span><h3>召回测试</h3><p>先在影子模式验证匹配质量、作用域和注入内容；不会真的发给 QQ。</p></div>
    </div>
    <div class="lm-recall-bar">
      <select id="lm-recall-scope" aria-label="召回测试范围">${scopeOptionsHtml(selectedScope()) || '<option value="">暂无会话</option>'}</select>
      <input id="lm-query" value="${esc(lm().query || '')}" placeholder="输入问题或关键词，例如：之前讨论过 NAS 向量记忆吗？" aria-label="召回测试问题" />
      <button type="button" class="btn btn-primary" id="lm-test">测试召回</button>
    </div>
    <div id="lm-recall-result">${renderRecall(lm().recallResult)}</div>
  </section>`;
}

// ── 设置 ────────────────────────────────────────────────────────────────

function settingCheck(id, checked, title, hint) {
  return `<label class="lm-check" for="${id}">
    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
    <span><strong>${esc(title)}</strong><small>${esc(hint)}</small></span>
  </label>`;
}

function settingsHtml() {
  const cfg = config();
  const injecting = cfg.enabled === true && cfg.mode === 'active';
  return `<section class="lm-card">
    <div class="lm-card-head"><div><span class="lm-section-kicker">生命周期</span><h3>运行、隐私与模式</h3><p>关闭后不写入、不召回；影子模式先记录召回结果，确认质量后再注入回复。</p></div></div>
    <div class="lm-option-grid">
      ${settingCheck('lm-enabled', cfg.enabled === true, '启用长期记忆', '总开关；关闭后不产生任何模型调用')}
      ${settingCheck('lm-auto-capture', cfg.autoCapture !== false, '自动提炼记忆', '关掉后只保留手动新建与召回；不会因为聊天自动写入新记忆')}
      ${settingCheck('lm-private', cfg.allowPrivate === true, '允许私聊自动记忆', '默认只记群聊，避免把私聊内容带进其他会话')}
      ${settingCheck('lm-global', cfg.allowGlobal === true, '允许管理员全局知识', '新增 owner-global 范围，只给管理员本人使用')}
      ${settingCheck('lm-capture-all', cfg.captureAllMessages === true, '捕获全部群消息', '不再依赖机器人是否回复；黑名单和敏感内容仍会在入口过滤')}
      ${settingCheck('lm-shadow-semantic', cfg.shadowSemantic === true, '影子模式也跑语义召回', '会调用 Embedding；关掉可省成本')}
    </div>
    <div class="lm-form-grid">
      <label class="lm-field">运行模式<select id="lm-mode">
        <option value="shadow" ${cfg.mode !== 'active' ? 'selected' : ''}>影子：记录召回，但不注入聊天</option>
        <option value="active" ${cfg.mode === 'active' ? 'selected' : ''}>主动注入：每次回复前自动召回</option>
      </select></label>
      <label class="lm-field">每轮最多召回<input id="lm-max-items" type="number" min="1" max="16" value="${num(cfg.maxRecallItems) || 6}" /></label>
      <label class="lm-field">注入上限（字符）<input id="lm-max-chars" type="number" min="300" max="8000" value="${num(cfg.maxInjectChars) || 2400}" /></label>
      <label class="lm-field">自动注入最多几条<input id="lm-auto-inject-items" type="number" min="1" max="8" value="${num(cfg.autoInjectMaxItems) || 3}" /></label>
      <label class="lm-field">自动注入最低相关度<input id="lm-auto-inject-score" type="number" min="0" max="1" step="0.05" value="${Number(cfg.autoInjectMinScore ?? 0.3)}" /></label>
      <label class="lm-field">相似记忆去重阈值<input id="lm-auto-inject-diversity" type="number" min="0.2" max="0.95" step="0.05" value="${Number(cfg.autoInjectDiversity ?? 0.68)}" /></label>
      <label class="lm-field">短消息自动注入门槛（字）<input id="lm-auto-inject-min-query" type="number" min="1" max="80" value="${num(cfg.autoInjectMinQueryChars) || 4}" /></label>
      <label class="lm-field">检索融合系数（RRF）<input id="lm-rrf-k" type="number" min="10" max="200" value="${num(cfg.rrfK) || 60}" /><small>值越大越平滑地融合关键词与向量排序</small></label>
      <label class="lm-field">近期记忆保留（条）<input id="lm-recent-memory-count" type="number" min="0" max="4" value="${num(cfg.recentMemoryCount)}" /><small>检索不命中时补入近期活跃记忆；填 0 关闭</small></label>
    </div>
    <div class="lm-injection-banner ${injecting ? 'is-active' : 'is-shadow'}"><strong>${injecting ? '主动注入已开启' : '当前不会注入聊天提示词'}</strong><span>${injecting ? '每次聊天运行会在模型调用前自动召回本会话的长期记忆；这不是由模型自行决定是否调用工具。' : '影子模式仍会生成记忆卡片和记录召回结果，但运行时刻意返回空文本。切换为「主动注入」并保存后才会出现在会话提示词中。'}</span></div>
    ${settingCheck('lm-auto-inject-recent-context', cfg.autoInjectRecentContext !== false, '用最近几句对话扩展自动召回查询', '避免只根据“？”、“上次呢”之类短消息召回无关旧记忆；仅用于检索，不会额外注入这几句。')}
  </section>
  <section class="lm-card">
    <div class="lm-card-head"><div><span class="lm-section-kicker">性能与范围</span><h3>提炼节奏与保留</h3><p>这些参数只在启用后生效；改完点下方保存。</p></div></div>
    <div class="lm-form-grid">
      <label class="lm-field">自动总结阈值（回合）<input id="lm-capture-min" type="number" min="2" max="60" value="${num(cfg.captureMinMessages) || 6}" /></label>
      <label class="lm-field">空闲多久后提炼（秒）<input id="lm-capture-idle" type="number" min="10" max="1800" step="5" value="${Math.round((num(cfg.captureIdleMs) || 90000) / 1000)}" /></label>
      <label class="lm-field">召回等待上限（毫秒）<input id="lm-recall-timeout" type="number" min="300" max="5000" step="100" value="${num(cfg.recallTimeoutMs) || 1800}" /></label>
      <label class="lm-field">来源回合保留（天）<input id="lm-turn-retention" type="number" min="0" max="3650" value="${num(cfg.turnRetentionDays)}" /><small>填 0 永久保留</small></label>
      <label class="lm-field lm-field-wide">启用的群号（留空＝所有群）<input id="lm-groups" value="${esc((cfg.groups || []).join(','))}" placeholder="123456, 234567" /></label>
    </div>
    <div class="skills-error" id="lm-save-error" hidden></div>
    <div class="lm-save-row">
      <button type="button" class="btn btn-primary" id="lm-save-config">保存长期记忆设置</button>
      <span class="lm-muted">向量模型地址与密钥由进程环境管理，不在网页中显示。</span>
    </div>
  </section>`;
}

// ── 页面骨架 ────────────────────────────────────────────────────────────

function graphHtml(graph) {
  // 首次加载时 /status 可能成功、list/graph 失败，此时 graph 还是 null；
  // 默认参数只兜 undefined，不能兜 null，否则错误页会在 renderPage 里再抛一次。
  const source = graph && typeof graph === 'object' ? graph : {};
  const nodes = Array.isArray(source.nodes) ? source.nodes.slice(0, 60) : [];
  const edges = Array.isArray(source.edges) ? source.edges.slice(0, 120) : [];
  if (!nodes.length) return '<div class="lm-empty">当前范围还没有可视化的实体关系。记忆里出现人名、项目名或联系方式后，图谱会自动长出来。</div>';
  const width = 760;
  const height = 340;
  const center = { x: width / 2, y: height / 2 };
  const positions = new Map(nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
    const radius = node.type === 'memory' ? 90 : 135;
    return [node.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }];
  }));
  const lines = edges.map((edge) => {
    const source = positions.get(edge.source); const target = positions.get(edge.target);
    return source && target ? `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" />` : '';
  }).join('');
  const marks = nodes.map((node) => {
    const point = positions.get(node.id);
    const label = String(node.label || '').slice(0, 16);
    return `<g class="${node.type === 'memory' ? 'memory-node' : 'entity-node'}"><circle cx="${point.x}" cy="${point.y}" r="${node.type === 'memory' ? 10 : 7}"/><text x="${point.x}" y="${point.y + 22}">${esc(label)}</text></g>`;
  }).join('');
  return `<div class="lm-graph-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="长期记忆关系图谱"><g class="lm-graph-edges">${lines}</g>${marks}</svg></div>`;
}

function renderPage() {
  const box = $('#living-memory-page');
  if (!box) return;
  const st = stats();
  const tab = ['overview', 'memories', 'recall', 'settings'].includes(lm().tab) ? lm().tab : 'overview';
  lm().tab = tab;
  const total = num(lm().overviewList?.total ?? lm().list?.total ?? st.total);
  const tabs = [
    ['overview', '概览', ''],
    ['memories', '记忆库', ` <span class="plugin-tab-n">${total}</span>`],
    ['recall', '召回测试', ''],
    ['settings', '设置', '']
  ];
  const html = `<div class="pane-head lm-head">
    <div>
      <span class="skills-eyebrow">实验功能 · 本地优先</span>
      <h2>长期记忆</h2>
      <p class="skills-claim">把群聊里值得长期保留的事件、约定和项目记下来，回复前按会话范围召回；
        默认按会话隔离，不把其他群的内容带进当前回复。数据只存在本机 SQLite。</p>
    </div>
    <div class="lm-head-side">
      ${serviceNote()}
      <button type="button" class="btn btn-small" id="lm-refresh">${iconSvg('refresh', { size: 13 })}刷新</button>
      <div class="lm-head-meta">${num(st.active)} 条活跃 · ${num(st.vectorReady)} 条向量化</div>
    </div>
  </div>
  ${pageErrorHtml()}
  <div class="plugin-tabs lm-tabs" role="tablist" aria-label="长期记忆页面">
    ${tabs.map(([key, label, count]) => `<button type="button" class="plugin-tab${tab === key ? ' is-on' : ''}" role="tab" aria-selected="${tab === key ? 'true' : 'false'}" data-lm-tab="${key}">${label}${count}</button>`).join('')}
  </div>
  <div class="lm-tabpanel" data-lm-panel="overview" ${tab === 'overview' ? '' : 'hidden'}>${overviewHtml()}</div>
  <div class="lm-tabpanel" data-lm-panel="memories" ${tab === 'memories' ? '' : 'hidden'}><div id="lm-memory-view">${memoryViewHtml()}</div></div>
  <div class="lm-tabpanel" data-lm-panel="recall" ${tab === 'recall' ? '' : 'hidden'}>${recallHtml()}</div>
  <div class="lm-tabpanel" data-lm-panel="settings" ${tab === 'settings' ? '' : 'hidden'}>${settingsHtml()}</div>`;
  setHtmlIfChanged(box, html, { force: true });
  bindPage(box);
}

function setTab(tab) {
  const next = ['overview', 'memories', 'recall', 'settings'].includes(tab) ? tab : 'overview';
  lm().tab = next;
  document.querySelectorAll('#living-memory-page [data-lm-tab]').forEach((button) => {
    const on = button.dataset.lmTab === next;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('#living-memory-page [data-lm-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.lmPanel !== next;
  });
  const scroller = $('#view-living-memory');
  if (scroller) scroller.scrollTop = 0;
}

// ── 事件 ────────────────────────────────────────────────────────────────

function parseGroups(value) {
  return [...new Set(String(value || '').split(/[,，\s]+/).map((item) => item.trim()).filter((item) => /^\d{1,15}$/.test(item)))];
}

async function openMemory(id) {
  const result = await api(`/api/living-memory/memories/${encodeURIComponent(id)}`);
  lm().selectedMemoryId = id;
  lm().detail = result.memory || null;
  lm().pageError = '';
  renderMemoryView();
  const scroller = $('#view-living-memory');
  if (scroller) scroller.scrollTop = 0;
}

async function mutateMemory(id, action, message) {
  if (!await askForConfirmation(message)) return;
  if (action === 'archive') {
    await api(`/api/living-memory/memories/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
  } else if (action === 'restore') {
    await api(`/api/living-memory/memories/${encodeURIComponent(id)}/restore`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
  } else {
    await api(`/api/living-memory/memories/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
  }
  lm().detail = null;
  lm().selectedMemoryId = '';
  await loadLivingMemoryPage();
}

async function saveConfig(button) {
  const errorBox = $('#lm-save-error');
  if (errorBox) { errorBox.textContent = ''; errorBox.hidden = true; }
  button.disabled = true;
  try {
    const cfg = config();
    // 清空/非法 = 保持原值，不能把空串当 0 再夹成最小值（那会把“删掉重填”变成最激进配置）。
    const intValue = (selector, fallback) => {
      const raw = String($(selector)?.value ?? '').trim();
      const n = Number(raw);
      return raw !== '' && Number.isFinite(n) ? n : fallback;
    };
    const autoBox = $('#lm-auto-capture');
    const idleFallbackSec = Math.round((num(cfg.captureIdleMs) || 90000) / 1000);
    const idleRaw = intValue('#lm-capture-idle', idleFallbackSec);
    // 0/低于下限 = 保持原值；运行期本身也把下限收在 10 秒，不应借“填 0”把 90 秒静默变成 10 秒。
    const captureIdleSec = Math.max(10, Math.min(1800, idleRaw >= 10 ? idleRaw : idleFallbackSec));
    const checkedValue = (selector, fallback) => {
      const el = $(selector);
      return el ? el.checked : fallback;
    };
    const modeBox = $('#lm-mode');
    const retentionFallback = Number.isFinite(Number(cfg.turnRetentionDays))
      ? Number(cfg.turnRetentionDays) : 7;
    const patch = {
      enabled: checkedValue('#lm-enabled', cfg.enabled === true),
      graduated: cfg.graduated === true,
      mode: modeBox ? (modeBox.value === 'active' ? 'active' : 'shadow') : (cfg.mode === 'active' ? 'active' : 'shadow'),
      autoCapture: autoBox ? autoBox.checked : cfg.autoCapture !== false,
      captureIdleMs: Math.round(captureIdleSec * 1000),
      allowPrivate: checkedValue('#lm-private', cfg.allowPrivate === true),
      allowGlobal: checkedValue('#lm-global', cfg.allowGlobal === true),
      captureAllMessages: checkedValue('#lm-capture-all', cfg.captureAllMessages === true),
      shadowSemantic: checkedValue('#lm-shadow-semantic', cfg.shadowSemantic === true),
      turnRetentionDays: Math.max(0, Math.min(3650, intValue('#lm-turn-retention', retentionFallback))),
      maxInjectChars: Math.max(300, Math.min(8000, intValue('#lm-max-chars', num(cfg.maxInjectChars) || 2400))),
      maxRecallItems: Math.max(1, Math.min(16, intValue('#lm-max-items', num(cfg.maxRecallItems) || 6))),
      autoInjectMaxItems: Math.max(1, Math.min(8, intValue('#lm-auto-inject-items', num(cfg.autoInjectMaxItems) || 3))),
      autoInjectMinScore: Math.max(0, Math.min(1, intValue('#lm-auto-inject-score', Number(cfg.autoInjectMinScore) || 0.3))),
      autoInjectDiversity: Math.max(0.2, Math.min(0.95, intValue('#lm-auto-inject-diversity', Number(cfg.autoInjectDiversity) || 0.68))),
      autoInjectMinQueryChars: Math.max(1, Math.min(80, intValue('#lm-auto-inject-min-query', num(cfg.autoInjectMinQueryChars) || 4))),
      autoInjectRecentContext: checkedValue('#lm-auto-inject-recent-context', cfg.autoInjectRecentContext !== false),
      rrfK: Math.max(10, Math.min(200, intValue('#lm-rrf-k', num(cfg.rrfK) || 60))),
      recentMemoryCount: Math.max(0, Math.min(4, intValue('#lm-recent-memory-count', num(cfg.recentMemoryCount)))),
      recallTimeoutMs: Math.max(300, Math.min(5000, intValue('#lm-recall-timeout', num(cfg.recallTimeoutMs) || 1800))),
      captureMinMessages: Math.max(2, Math.min(60, intValue('#lm-capture-min', num(cfg.captureMinMessages) || 6))),
      groups: parseGroups($('#lm-groups')?.value)
    };
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ livingMemory: patch }) });
    state.config = result.config || state.config;
    lm().pageError = '';
    button.disabled = false;
    await loadLivingMemoryPage();
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = `保存失败：${error.message}`;
      errorBox.hidden = false;
    }
    button.disabled = false;
  }
}

async function runRecallTest(button) {
  const chatKey = selectedScope();
  const query = String($('#lm-query')?.value || '').trim();
  if (!chatKey || !query) {
    lm().pageError = '请选择会话并输入测试问题';
    renderPage();
    return;
  }
  button.disabled = true;
  lm().query = query;
  try {
    lm().recallResult = await api('/api/living-memory/recall-test', { method: 'POST', body: JSON.stringify({ chatKey, query }) });
    lm().pageError = '';
  } catch (error) {
    lm().recallResult = { error: error.message };
  } finally {
    button.disabled = false;
    const host = $('#lm-recall-result');
    if (host) host.innerHTML = renderRecall(lm().recallResult);
  }
}

async function createMemory(button) {
  const scopeKey = selectedScope();
  const summary = String($('#lm-new-summary')?.value || '').trim();
  const content = String($('#lm-new-content')?.value || '').trim();
  const errorBox = $('#lm-create-error');
  const fail = (message) => {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  };
  if (errorBox) { errorBox.textContent = ''; errorBox.hidden = true; }
  if (!scopeKey || !summary || !content) {
    fail('请选择会话，并填写摘要与正文。');
    return;
  }
  button.disabled = true;
  try {
    await api('/api/living-memory/memories', { method: 'POST', body: JSON.stringify({
      scopeKey, summary, content, type: $('#lm-new-type')?.value || 'episode',
      importance: Number($('#lm-new-importance')?.value) || 5,
      confidence: 1, tags: String($('#lm-new-tags')?.value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
    }) });
    lm().pageError = '';
    lm().createOpen = false;
    lm().page = 1;
    button.disabled = false;
    await loadLivingMemoryPage();
    return;
  } catch (error) {
    fail(`创建失败：${error.message}`);
  }
  button.disabled = false;
}

function bindPage(box) {
  if (box.dataset.bound === '1') return;
  box.dataset.bound = '1';

  box.addEventListener('click', async (event) => {
    const tab = event.target.closest('[data-lm-tab]');
    if (tab) { setTab(tab.dataset.lmTab); return; }
    const jump = event.target.closest('[data-lm-jump]');
    if (jump) { setTab(jump.dataset.lmJump); return; }
    if (event.target.closest('#lm-refresh') || event.target.closest('#lm-list-refresh')) {
      await loadLivingMemoryPage();
      return;
    }
    if (event.target.closest('#lm-graph-refresh')) {
      await loadLivingMemoryPage();
      return;
    }
    const view = event.target.closest('[data-lm-view]');
    if (view) {
      lm().view = view.dataset.lmView === 'grid' ? 'grid' : 'list';
      lm().page = 1;
      renderMemoryView();
      return;
    }
    const pageButton = event.target.closest('[data-lm-page]');
    if (pageButton) {
      const totalPages = Math.max(1, Number(pageButton.closest('.plugin-pagination')?.dataset.pages) || 1);
      const value = pageButton.dataset.lmPage;
      if (value === 'prev') lm().page = Math.max(1, (lm().page || 1) - 1);
      else if (value === 'next') lm().page = Math.min(totalPages, (lm().page || 1) + 1);
      else lm().page = Math.max(1, Number(value) || 1);
      renderMemoryView();
      return;
    }
    if (event.target.closest('#lm-new-toggle')) {
      lm().createOpen = !lm().createOpen;
      renderMemoryView();
      if (lm().createOpen) $('#lm-new-summary')?.focus();
      return;
    }
    if (event.target.closest('#lm-create')) { await createMemory(event.target.closest('#lm-create')); return; }
    if (event.target.closest('#lm-save-config')) { await saveConfig(event.target.closest('#lm-save-config')); return; }
    if (event.target.closest('#lm-test')) { await runRecallTest(event.target.closest('#lm-test')); return; }
    if (event.target.closest('[data-lm-back]')) {
      lm().detail = null;
      lm().selectedMemoryId = '';
      renderMemoryView();
      return;
    }
    const archive = event.target.closest('[data-lm-archive]');
    if (archive) {
      try { await mutateMemory(archive.dataset.lmArchive, 'archive', '归档这条长期记忆？归档后它不会再参与自动召回。'); }
      catch (error) { lm().pageError = `操作失败：${error.message}`; renderPage(); }
      return;
    }
    const restore = event.target.closest('[data-lm-restore]');
    if (restore) {
      try { await mutateMemory(restore.dataset.lmRestore, 'restore', '恢复这条长期记忆？恢复后会重新参与自动召回。'); }
      catch (error) { lm().pageError = `操作失败：${error.message}`; renderPage(); }
      return;
    }
    const remove = event.target.closest('[data-lm-delete]');
    if (remove) {
      try { await mutateMemory(remove.dataset.lmDelete, 'delete', '彻底删除这条长期记忆及其向量索引？此操作不可恢复。'); }
      catch (error) { lm().pageError = `操作失败：${error.message}`; renderPage(); }
      return;
    }
    const open = event.target.closest('[data-lm-open]');
    if (open) {
      try {
        setTab('memories');
        await openMemory(open.dataset.lmOpen);
      } catch (error) {
        lm().pageError = `读取记忆失败：${error.message}`;
        renderPage();
      }
    }
  });

  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // 行内还有归档/恢复/删除按钮：焦点在它们身上时，Enter/Space 属于按钮自己。
    if (event.target.closest?.('button, a, input, select, textarea')) return;
    const row = event.target.closest?.('[data-lm-open]');
    if (!row) return;
    event.preventDefault();
    setTab('memories');
    openMemory(row.dataset.lmOpen).catch((error) => {
      lm().pageError = `读取记忆失败：${error.message}`;
      renderPage();
    });
  });

  box.addEventListener('change', (event) => {
    if (event.target.id === 'lm-scope' || event.target.id === 'lm-recall-scope' || event.target.id === 'lm-overview-scope') {
      lm().selectedScope = event.target.value;
      lm().selectedMemoryId = '';
      lm().detail = null;
      lm().page = 1;
      void loadLivingMemoryPage();
      return;
    }
    if (event.target.id === 'lm-status-filter') {
      lm().statusFilter = event.target.value;
      lm().page = 1;
      void loadLivingMemoryPage();
    }
  });

  box.addEventListener('input', (event) => {
    if (event.target.id === 'lm-search') {
      lm().search = String(event.target.value || '');
      lm().page = 1;
      const list = $('#lm-memory-list');
      const pager = $('#lm-memory-pager');
      const summary = $('#lm-list-summary');
      const host = $('#lm-memory-view');
      if (!host) return;
      const all = filteredEntries();
      const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      const page = Math.min(Math.max(1, Number(lm().page) || 1), totalPages);
      lm().page = page;
      const entries = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      if (list) {
        list.className = `lm-memory-list${lm().view === 'grid' ? ' is-grid' : ''}`;
        list.innerHTML = entries.length
          ? entries.map(memoryRowHtml).join('')
          : '<div class="lm-empty">没有匹配当前搜索或状态筛选的记忆。</div>';
      }
      if (pager) pager.innerHTML = memoryPagerHtml(page, totalPages, all.length);
      if (summary) {
        const loaded = lm().list?.entries?.length || 0;
        const serverTotal = Number(lm().list?.total) || all.length;
        summary.textContent = `${serverTotal ? `共 ${serverTotal} 条` : ''}${serverTotal > loaded ? ` · 当前显示最近 ${loaded} 条` : ''}${lm().search ? ` · 搜索「${lm().search}」` : ''}`;
      }
      return;
    }
    if (event.target.id === 'lm-query') lm().query = String(event.target.value || '');
  });
}

// ── 数据 ────────────────────────────────────────────────────────────────

async function loadLivingMemoryPage() {
  const box = $('#living-memory-page');
  if (!box) return;
  try {
    const [status, chatData] = await Promise.all([
      api('/api/living-memory/status'),
      api('/api/chats')
    ]);
    const chats = chatData?.chats || [];
    lm().status = status;
    lm().chats = chats;
    const scopes = chatScopes();
    if (!scopes.some((chat) => chat.key === selectedScope())) {
      const first = scopes.find((chat) => chat.key.startsWith('group:')) || scopes[0];
      lm().selectedScope = first?.key || '';
    }
    const scope = selectedScope();
    const emptyList = { entries: [], total: 0 };
    const [overview, list, graph] = scope ? await Promise.all([
      api(`/api/living-memory/memories?scopeKey=${encodeURIComponent(scope)}&limit=6&status=`),
      api(`/api/living-memory/memories?scopeKey=${encodeURIComponent(scope)}&limit=200&status=${encodeURIComponent(lm().statusFilter || '')}`),
      api(`/api/living-memory/graph?scopeKey=${encodeURIComponent(scope)}&limit=160`)
    ]) : [emptyList, emptyList, { nodes: [], edges: [] }];
    lm().overviewList = overview;
    lm().list = list;
    lm().graph = graph;
    lm().pageError = '';
    if (lm().detail) {
      const current = (list.entries || []).find((memory) => memory.id === lm().detail.id);
      if (!current) {
        lm().detail = null;
        lm().selectedMemoryId = '';
      }
    }
    renderPage();
  } catch (error) {
    lm().pageError = `读取长期记忆失败：${error.message}`;
    if (!lm().status) {
      setBoxError(box, `<div class="pane-head lm-head"><div><span class="skills-eyebrow">实验功能 · 本地优先</span><h2>长期记忆</h2><p class="skills-claim">读取失败，请确认服务仍在运行。</p></div></div><div class="skills-error">${esc(lm().pageError)}</div>`);
      return;
    }
    renderPage();
  }
}

export { loadLivingMemoryPage };
