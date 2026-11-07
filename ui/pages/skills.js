// 技能页：只读 Markdown 流程 + 工具白名单。
// 独立页面，不复用设置页的分区容器；开关和按会话覆盖即时写 /api/skills/state。
import { api } from '../core/api.js';
import { $, $$, esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';
import { iconSvg } from '../core/icons.js';

const skillsState = {
  enabled: false,
  enabledIds: [],
  perChat: {},
  skills: [],
  errors: [],
  chats: [],
  selectedId: '',
  selectedChat: '',
  detail: null,
  detailError: '',
  loadingDetail: false,
  view: 'market',
  market: null,
  marketError: '',
  marketLoading: false,
  marketQuery: '',
  marketPreview: null,
  marketPreviewId: '',
  marketPreviewError: '',
  marketBusyId: '',
  marketPage: 1,
  marketPageSize: 12,
  marketCategory: '',
  marketRange: 'all',
  marketSort: 'name',
  marketView: 'grid',
  marketDetailId: '',
  marketFiltersOpen: false
};

function skillsChatLabel(key) {
  const chat = skillsState.chats.find((item) => item.key === key);
  if (chat?.chatName) return `${chat.chatName}（${key}）`;
  if (String(key).startsWith('group:')) return `群 ${String(key).slice(6)}`;
  if (String(key).startsWith('private:')) return `私聊 ${String(key).slice(8)}`;
  return String(key);
}

function skillsStatus(text, error = false) {
  const node = $('#skills-status');
  if (!node) return;
  node.textContent = text;
  node.style.color = error ? 'var(--danger, #c0392b)' : '';
}

function skillsIsGlobal(id) {
  return skillsState.enabledIds.includes(id);
}

function skillsHasOverride(id) {
  return Object.values(skillsState.perChat).some((ids) => Array.isArray(ids) && ids.includes(id));
}

function skillsSelected() {
  return skillsState.skills.find((skill) => skill.id === skillsState.selectedId) || null;
}

function skillsEnabledCount() {
  return skillsState.skills.filter((skill) => skillsIsGlobal(skill.id)).length;
}

function skillsRenderKpis() {
  const sub = $('#skills-installed-sub');
  if (!sub) return;
  const overrides = Object.keys(skillsState.perChat).length;
  sub.textContent = `${skillsState.skills.length} 个技能 · ${skillsEnabledCount()} 个全局启用 · ${overrides} 个会话覆盖`;
}

function skillsRenderList() {
  const box = $('#skills-list');
  if (!box) return;
  if (!skillsState.skills.length) {
    box.innerHTML = '<div class="plugin-empty">没有找到技能。把技能目录放到 <code>skills/&lt;id&gt;/</code> 或 <code>data/skills/&lt;id&gt;/</code>，再点右上角「重新扫描」。</div>';
    return;
  }
  box.innerHTML = skillsState.skills.map((skill) => {
    const on = skillsIsGlobal(skill.id);
    const override = skillsHasOverride(skill.id);
    const state = on ? '全局启用' : override ? '按会话启用' : '未启用';
    const source = skill.source === 'user' ? 'data/skills（用户目录）' : '内置 skills 目录';
    return `<div class="plugin-row" data-skill-open="${esc(skill.id)}" tabindex="0" role="button" aria-label="查看 ${esc(skill.name)} 详情">
      <span class="skill-avatar">${iconSvg('sparkles', { size: 18 })}</span>
      <div class="plugin-row-main">
        <div class="plugin-row-top"><span class="plugin-name">${esc(skill.name)}</span><span class="plugin-ver">v${esc(skill.version)}</span><span class="plugin-state-text ${on ? 'idle' : 'off'}"><i></i>${esc(state)}</span></div>
        <div class="plugin-fact">${skill.allowedTools.length} 个工具 · ${esc(source)}</div>
        <div class="plugin-note">${esc(skill.description || '（没有说明）')}</div>
      </div>
      <div class="plugin-row-actions"><span class="plugin-fact">${on ? '已全局启用' : override ? '按会话启用' : '未启用'}</span></div>
    </div>`;
  }).join('');
}

function skillsRenderInstalled() {
  const list = $('#skills-list');
  const detail = $('#skills-detail');
  const selected = skillsSelected();
  if (list) list.hidden = Boolean(selected);
  if (detail) detail.hidden = !selected;
  skillsRenderKpis();
  if (selected) skillsRenderDetail();
  else skillsRenderList();
}

function skillsRenderDetail() {
  const box = $('#skills-detail');
  if (!box) return;
  const skill = skillsSelected();
  if (!skill) {
    box.innerHTML = '<div class="skills-detail-empty">选择左侧技能，查看它的工作流程和工具范围。</div>';
    return;
  }
  const back = '<div class="skills-detail-back"><button type="button" class="btn btn-small" data-skill-back>← 返回已安装</button></div>';
  if (skillsState.loadingDetail) {
    box.innerHTML = `${back}<div class="skills-detail-empty">正在读取技能说明…</div>`;
    return;
  }
  if (skillsState.detailError) {
    box.innerHTML = `<div class="skills-detail-empty is-error">技能说明读取失败：${esc(skillsState.detailError)}</div>`;
    return;
  }
  const detail = skillsState.detail && skillsState.detail.id === skill.id ? skillsState.detail : skill;
  const on = skillsIsGlobal(skill.id);
  const chatKeys = skillsState.chats.map((chat) => chat.key);
  const tools = (skill.allowedTools || []).map((tool) => `<span class="skills-chip">${esc(tool)}</span>`).join('');
  const triggers = (skill.triggers || []).map((trigger) => `<span class="skills-chip is-soft">${esc(trigger)}</span>`).join('');
  box.innerHTML = `${back}
    <div class="skills-detail-head">
      <div>
        <span class="skills-eyebrow">技能 · ${esc(skill.id)}</span>
        <h3>${esc(skill.name)} <span class="skills-version">v${esc(skill.version)}</span></h3>
        <p>${esc(skill.description || '（没有说明）')}</p>
      </div>
      <div class="skills-detail-actions">
        <label class="skills-switch">
          <input type="checkbox" class="sw" data-skill-global="${esc(skill.id)}" ${on ? 'checked' : ''} />
          <span>${on ? '已全局启用' : '全局停用'}</span>
        </label>
        ${skill.source === 'user' ? `<button type="button" class="btn btn-small btn-danger" data-skill-uninstall="${esc(skill.id)}">卸载</button>` : ''}
      </div>
    </div>
    <div class="skills-detail-grid">
      <div class="skills-detail-block"><h4>允许工具</h4><div class="skills-chips">${tools || '<span class="skills-chip is-soft">仅 finish</span>'}</div></div>
      <div class="skills-detail-block"><h4>触发词</h4><div class="skills-chips">${triggers || '<span class="skills-muted">没有预设触发词</span>'}</div></div>
      <div class="skills-detail-block"><h4>来源</h4><p class="skills-muted">${detail.source === 'user' ? 'data/skills（用户目录）' : '内置 skills 目录'}</p></div>
    </div>
    <section class="skills-doc-block">
      <h4>工作流程</h4>
      <pre class="skills-doc">${esc(detail.instructions || '（没有 SKILL.md 内容）')}</pre>
    </section>
    <section class="skills-chat-block">
      <h4>按会话启用</h4>
      ${skillsState.enabled === true || !Object.keys(skillsState.perChat || {}).length ? ''
        : '<p class="skills-muted" style="color:var(--warning, #e6a700)">全局技能包未启用，下面的按会话覆盖目前不会生效；请先打开上方「启用技能包」。</p>'}
      <p class="skills-muted">全局=${on ? '启用' : '停用'}。下面勾选多个群/私聊后一次保存；勾选状态和全局相同就回退为“跟随全局”，不同才建立覆盖。</p>
      ${chatKeys.length ? `
        <div class="skills-chat-tools"><button type="button" class="btn btn-small" data-skill-chat-all="1">全选</button><button type="button" class="btn btn-small" data-skill-chat-all="0">全不选</button><button type="button" class="btn btn-small btn-primary" id="skill-chat-save-all">保存勾选</button></div>
        <div class="skills-chat-list">${chatKeys.map((key) => {
          const ids = Array.isArray(skillsState.perChat[key]) ? skillsState.perChat[key] : null;
          const checked = ids ? ids.includes(skill.id) : on;
          return `<label class="skills-chat-row"><input type="checkbox" data-skill-chat="${esc(key)}" ${checked ? 'checked' : ''} /><span>${esc(skillsChatLabel(key))}</span><em>${ids ? '覆盖' : '跟随全局'}</em></label>`;
        }).join('')}</div>` : '<p class="skills-muted">还没有可配置的群或私聊。</p>'}
    </section>`;
}

function skillsMarketEntry(id) {
  return (skillsState.market?.skills || []).find((item) => item.id === id) || null;
}

function skillsMarketInstallLabel(entry) {
  if (entry.builtin) return '内置';
  if (entry.installed && entry.updateAvailable) return '更新';
  if (entry.installed) return '重新安装';
  return '安装';
}

function skillsMarketCard(entry) {
  const tools = (entry.allowedTools || []).length;
  const installed = entry.installed ? '<span class="plugin-state-text idle"><i></i>已安装</span>' : '';
  const action = entry.builtin
    ? '<span class="plugin-state-text off"><i></i>内置</span>'
    : (entry.installed && !entry.updateAvailable ? installed
      : `<button type="button" class="btn btn-small btn-primary" data-market-install="${esc(entry.id)}" ${skillsState.marketBusyId ? 'disabled' : ''}>${skillsState.marketBusyId === entry.id ? '安装中…' : skillsMarketInstallLabel(entry)}</button>`);
  return `<article class="plugin-card ${entry.installed ? 'is-installed' : ''} ${skillsState.marketDetailId === entry.id ? 'is-previewing' : ''}" data-market-open="${esc(entry.id)}" tabindex="0" role="button" aria-label="查看 ${esc(entry.name)} 详情">
    <div class="plugin-card-head">
      <span class="skill-avatar">${iconSvg('sparkles', { size: 16 })}</span>
      <div class="plugin-card-title"><span class="plugin-name">${esc(entry.name)}</span>${entry.category ? `<span class="plugin-tag">${esc(entry.category)}</span>` : ''}</div>
      <span class="plugin-card-action">${action}</span>
    </div>
    <div class="plugin-card-desc">${esc(entry.description || '（没有说明）')}</div>
    <div class="plugin-card-foot"><span class="pb-item">${esc(entry.author || '未署名')}</span><span class="pb-item">v${esc(entry.version)}</span><span class="pb-item">${tools} 个工具</span></div>
  </article>`;
}

function skillsMarketPreviewHtml() {
  if (!skillsState.marketPreviewId) return '';
  if (skillsState.marketPreviewError) return `<div class="skills-market-preview is-error">读取技能详情失败：${esc(skillsState.marketPreviewError)}</div>`;
  const preview = skillsState.marketPreview;
  if (!preview) return '<div class="skills-market-preview">正在读取技能详情…</div>';
  const entry = skillsMarketEntry(preview.entry.id) || preview.entry;
  const tools = (preview.manifest.allowedTools || []).map((tool) => `<span class="skills-chip">${esc(tool)}</span>`).join('');
  // 服务端已只放行 http(s)；前端再兜一层，避免旧缓存/别的索引源把 javascript: 塞进 href。
  const homepageUrl = /^https?:\/\//i.test(String(preview.entry.homepage || '')) ? String(preview.entry.homepage) : '';
  const homepage = homepageUrl ? `<a class="skills-market-link" href="${esc(homepageUrl)}" target="_blank" rel="noopener noreferrer">主页</a>` : '';
  return `<section class="skills-market-preview">
    <div class="skills-market-preview-head"><div><span class="skills-eyebrow">市场详情 · ${esc(preview.entry.id)}</span><h3>${esc(preview.manifest.name)} <span class="skills-version">v${esc(preview.manifest.version)}</span></h3><p>${esc(preview.manifest.description || '')}</p></div><div class="skills-market-actions">${homepage}${entry.localOnly ? '' : `<button type="button" class="btn btn-small btn-primary" data-market-install="${esc(preview.entry.id)}" ${entry.builtin || skillsState.marketBusyId ? 'disabled' : ''}>${skillsState.marketBusyId === preview.entry.id ? '安装中…' : skillsMarketInstallLabel(entry)}</button>`}${entry.installed && entry.installedSource === 'user' ? `<button type="button" class="btn btn-small btn-danger" data-market-uninstall="${esc(preview.entry.id)}">卸载</button>` : ''}</div></div>
    <div class="skills-detail-grid"><div class="skills-detail-block"><h4>允许工具</h4><div class="skills-chips">${tools || '<span class="skills-chip is-soft">仅 finish</span>'}</div></div><div class="skills-detail-block"><h4>文件与校验</h4><p class="skills-muted">${preview.entry.localOnly ? '本地技能目录（非市场包）' : Object.entries(preview.entry.files).map(([name, meta]) => `${esc(name)} · ${Number(meta.bytes) || 0}B`).join('<br>')}</p></div><div class="skills-detail-block"><h4>来源</h4><p class="skills-muted">${esc(preview.entry.author || '未署名')}<br><span class="skills-market-hash">${esc(String(preview.entry.sha256 || '').slice(0, 16))}</span></p></div></div>
    <section class="skills-doc-block"><h4>安装前预览（SKILL.md）</h4><pre class="skills-doc">${esc(preview.instructions || '（索引没有提供摘要，加载完整说明后可查看）')}</pre></section>
  </section>`;
}

function skillsMarketFacetsHtml(all) {
  const installed = all.filter((entry) => entry.installed).length;
  const updatable = all.filter((entry) => entry.updateAvailable).length;
  const categories = new Map();
  for (const entry of all) {
    const name = entry.category || '其他';
    categories.set(name, (categories.get(name) || 0) + 1);
  }
  const group = (label, rows) => `<div class="plugin-facet-group"><div class="plugin-facet-label">${esc(label)}</div>${rows.join('')}</div>`;
  const row = (label, count, on, attr) => `<button type="button" class="plugin-facet${on ? ' is-on' : ''}" ${attr}>${esc(label)}<span class="plugin-facet-n">${count}</span></button>`;
  const range = [
    row('全部', all.length, skillsState.marketRange === 'all', 'data-market-range="all"'),
    row('已安装', installed, skillsState.marketRange === 'installed', 'data-market-range="installed"'),
    row('有更新', updatable, skillsState.marketRange === 'updatable', 'data-market-range="updatable"')
  ];
  const cats = [...categories.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => row(name, count, skillsState.marketCategory === name, `data-market-category="${esc(name)}"`));
  const clear = (skillsState.marketRange !== 'all' || skillsState.marketCategory || skillsState.marketQuery)
    ? '<button type="button" class="plugin-facet plugin-facet-clear" data-market-clear="1">清除筛选</button>' : '';
  return group('范围', range) + group('分类', cats) + clear;
}

function skillsMarketSort(list, mode) {
  const copy = [...list];
  if (mode === 'version') {
    return copy.sort((a, b) => String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true })
      || String(a.name).localeCompare(String(b.name)));
  }
  if (mode === 'author') {
    return copy.sort((a, b) => String(a.author || '').localeCompare(String(b.author || ''))
      || String(a.name).localeCompare(String(b.name)));
  }
  return copy.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function skillsMarketPagination(page, totalPages, total) {
  if (totalPages <= 1) return '';
  const nums = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i += 1) {
    nums.push(`<button type="button" class="skills-market-page${i === page ? ' is-on' : ''}" data-market-page="${i}" aria-current="${i === page ? 'page' : 'false'}">${i}</button>`);
  }
  return `<nav class="skills-market-pagination" data-pages="${totalPages}" aria-label="技能市场分页">
    <button type="button" class="skills-market-page" data-market-page="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    ${nums.join('')}
    <button type="button" class="skills-market-page" data-market-page="next" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
    <span class="skills-market-page-summary">第 ${page} / ${totalPages} 页 · 共 ${total} 条</span>
  </nav>`;
}

function skillsRenderMarket() {
  const box = $('#skills-market-view');
  if (!box) return;
  const count = $('#skills-market-count');
  if (count) count.textContent = Array.isArray(skillsState.market?.skills) ? String(skillsState.market.skills.length) : '';
  if (skillsState.marketDetailId) {
    box.innerHTML = `<div class="skills-market-detail"><div class="skills-market-detail-back"><button type="button" class="btn btn-small" data-market-close>← 返回技能市场</button></div>${skillsMarketPreviewHtml() || '<div class="skills-market-preview">正在读取技能详情…</div>'}</div>`;
    return;
  }
  if (skillsState.marketLoading && !skillsState.market) {
    box.innerHTML = '<div class="skills-empty">正在读取技能索引…</div>';
    return;
  }
  if (!skillsState.market && skillsState.marketError) {
    box.innerHTML = `<div class="skills-market-error">${esc(skillsState.marketError)}<div class="skills-market-actions"><button type="button" class="btn btn-small" data-market-refresh>重试</button></div></div>`;
    return;
  }
  const data = skillsState.market;
  if (!data) { box.innerHTML = ''; return; }
  const query = skillsState.marketQuery.trim().toLowerCase();
  const all = Array.isArray(data.skills) ? data.skills : [];
  const list = all.filter((entry) => {
    if (skillsState.marketRange === 'installed' && !entry.installed) return false;
    if (skillsState.marketRange === 'updatable' && !entry.updateAvailable) return false;
    if (skillsState.marketCategory && (entry.category || '其他') !== skillsState.marketCategory) return false;
    return !query || `${entry.name} ${entry.id} ${entry.description} ${entry.author} ${entry.category}`.toLowerCase().includes(query);
  });
  const sorted = skillsMarketSort(list, skillsState.marketSort);
  const totalPages = Math.max(1, Math.ceil(sorted.length / skillsState.marketPageSize));
  const page = Math.min(Math.max(1, Number(skillsState.marketPage) || 1), totalPages);
  skillsState.marketPage = page;
  const pageList = sorted.slice((page - 1) * skillsState.marketPageSize, page * skillsState.marketPageSize);
  const index = data.index || {};
  const when = index.fetchedAt ? new Date(index.fetchedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  box.innerHTML = `<div class="plugin-layout${skillsState.marketFiltersOpen ? ' is-filters-open' : ''}">
    <aside class="plugin-facets">${skillsMarketFacetsHtml(all)}</aside>
    <div class="plugin-main">
      <div class="plugin-toolbar">
        <input type="search" id="skills-market-search" value="${esc(skillsState.marketQuery)}" placeholder="搜技能 / 作者 / 描述 / 分类" aria-label="搜索技能市场" />
        <button type="button" class="btn btn-small plugin-filter-toggle${skillsState.marketFiltersOpen ? ' is-on' : ''}" data-skills-filters="1">${iconSvg('filter', { size: 13 })}<span>筛选</span></button>
        <div class="plugin-viewtoggle" role="group" aria-label="视图"><button type="button" class="plugin-view ${skillsState.marketView === 'grid' ? 'is-on' : ''}" data-market-view="grid" title="卡片">${iconSvg('layout', { size: 14 })}</button><button type="button" class="plugin-view ${skillsState.marketView === 'list' ? 'is-on' : ''}" data-market-view="list" title="列表">${iconSvg('layers', { size: 14 })}</button></div>
        <select id="skills-market-sort" class="plugin-sort" aria-label="技能排序"><option value="name" ${skillsState.marketSort === 'name' ? 'selected' : ''}>按名称</option><option value="version" ${skillsState.marketSort === 'version' ? 'selected' : ''}>按版本</option><option value="author" ${skillsState.marketSort === 'author' ? 'selected' : ''}>按作者</option></select>
        <button type="button" class="plugin-view skills-market-refresh${skillsState.marketLoading ? ' is-loading' : ''}" data-market-refresh title="刷新索引" aria-label="刷新索引" ${skillsState.marketLoading ? 'disabled' : ''}>${iconSvg('refresh', { size: 14 })}</button>
      </div>
      ${index.stale && index.error ? `<div class="skills-market-note">索引暂时不可用，正在使用缓存：${esc(index.error)}</div>` : ''}
      ${skillsState.marketError ? `<div class="skills-market-note">${esc(skillsState.marketError)}</div>` : ''}
      <div id="skills-market-list" class="plugin-grid${skillsState.marketView === 'list' ? ' is-list' : ''}">${pageList.map(skillsMarketCard).join('') || '<div class="skills-empty">没有匹配的技能。</div>'}</div>
      ${skillsMarketPagination(page, totalPages, sorted.length)}
      <div class="plugin-index-foot"><span>${esc(index.name || '技能索引')}${index.stale ? ' · 使用本地缓存' : ''}${when ? ` · ${esc(when)}` : ''}</span></div>
    </div>
  </div>`;
}

async function skillsLoadMarket(force = false) {
  skillsState.marketLoading = true;
  skillsState.marketError = '';
  if (skillsState.view === 'market') skillsRenderMarket();
  try {
    const result = await api(`/api/skills/market${force ? '?refresh=1' : ''}`);
    skillsState.market = result;
    skillsState.marketError = '';
  } catch (error) {
    skillsState.marketError = `技能市场暂时不可用：${error?.message || error}`;
  } finally {
    skillsState.marketLoading = false;
    if (skillsState.view === 'market') skillsRenderMarket();
  }
}

async function skillsLoadMarketPreview(id, { full = true } = {}) {
  skillsState.marketDetailId = id;
  skillsState.marketPreviewId = id;
  skillsState.marketPreview = null;
  skillsState.marketPreviewError = '';
  skillsRenderMarket();
  const entry = skillsMarketEntry(id);
  if (entry?.localOnly) {
    try {
      const result = await api(`/api/skills/${encodeURIComponent(id)}`);
      const skill = result?.skill || {};
      skillsState.marketPreview = {
        ok: true, previewOnly: false, entry: { ...entry, files: {} },
        instructions: skill.instructions || '（本地技能没有 SKILL.md 内容）',
        manifest: { id: skill.id || id, name: skill.name || entry.name, version: skill.version || entry.version, description: skill.description || entry.description, allowedTools: skill.allowedTools || entry.allowedTools || [], triggers: skill.triggers || entry.triggers || [] }
      };
    } catch (error) { skillsState.marketPreviewError = String(error?.message || error); }
    skillsRenderMarket();
    return;
  }
  try {
    const result = await api(`/api/skills/market/preview?id=${encodeURIComponent(id)}${full ? '&full=1' : ''}`);
    if (skillsState.marketPreviewId === id) skillsState.marketPreview = result;
  } catch (error) {
    if (skillsState.marketPreviewId === id) skillsState.marketPreviewError = String(error?.message || error);
  } finally {
    if (skillsState.marketPreviewId === id) {
      skillsRenderMarket();
      // 窄屏上预览在卡片下方；点“查看”后把它带到视口内，否则看起来像没反应。
      requestAnimationFrame(() => {
        if (window.innerWidth > 720) return;
        document.querySelector('.skills-market-preview')?.scrollIntoView({ block: 'nearest' });
      });
    }
  }
}

async function skillsInstallMarket(id) {
  const entry = skillsMarketEntry(id);
  if (!entry) return;
  const tools = (entry.allowedTools || []).join('、') || '（无额外工具）';
  const ok = await askForConfirmation(`安装技能「${entry.name}」v${entry.version}？允许工具：${tools}。来源：${entry.homepage || entry.author || '未知'}。技能只读 Markdown、不执行代码；安装后可在技能页随时卸载。`);
  if (!ok) return;
  skillsState.marketBusyId = id;
  skillsRenderMarket();
  try {
    await api('/api/skills/market/install', {
      method: 'POST',
      body: JSON.stringify({ id, expectedSha256: entry.sha256, confirm: true })
    });
    skillsStatus(`已安装技能「${entry.name}」；默认未启用，可在已安装列表里打开。`);
    skillsState.market = null;
    skillsState.marketPreview = null;
    skillsState.marketPreviewId = '';
    skillsState.marketDetailId = '';
    await skillsLoad();
    await skillsLoadMarket(true);
  } catch (error) {
    skillsStatus(`安装失败：${error?.message || error}`, true);
    skillsRenderMarket();
  } finally {
    skillsState.marketBusyId = '';
    skillsRenderMarket();
  }
}

async function skillsUninstallMarket(id) {
  const entry = skillsMarketEntry(id);
  const skill = skillsState.skills.find((item) => item.id === id);
  const name = entry?.name || skill?.name || id;
  if (!await askForConfirmation(`卸载技能「${name}」？只会删除 data/skills/${id}；内置技能不能卸载。`)) return;
  try {
    await api('/api/skills/market/uninstall', { method: 'POST', body: JSON.stringify({ id, confirm: true }) });
    skillsStatus(`已卸载技能「${name}」。`);
    skillsState.market = null;
    skillsState.marketPreview = null;
    skillsState.marketPreviewId = '';
    skillsState.marketDetailId = '';
    skillsState.selectedId = '';
    skillsState.detail = null;
    await skillsLoad();
    await skillsLoadMarket(true);
  } catch (error) {
    skillsStatus(`卸载失败：${error?.message || error}`, true);
    skillsRenderMarket();
  }
}

function skillsSwitchView(view) {
  skillsState.view = ['market', 'publish'].includes(view) ? view : 'installed';
  const installed = $('#skills-installed-view');
  const market = $('#skills-market-view');
  const publish = $('#skills-publish-view');
  if (installed) installed.hidden = skillsState.view !== 'installed';
  if (market) market.hidden = skillsState.view !== 'market';
  if (publish) publish.hidden = skillsState.view !== 'publish';
  const reload = $('#skills-reload');
  if (reload) reload.hidden = skillsState.view !== 'installed';
  document.querySelectorAll('[data-skills-view]').forEach((button) => {
    const on = button.dataset.skillsView === skillsState.view;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (skillsState.view === 'market') {
    skillsRenderMarket();
    if (!skillsState.market && !skillsState.marketLoading) void skillsLoadMarket(false);
  } else if (skillsState.view === 'installed') {
    skillsRenderInstalled();
  }
}

function skillsRender() {
  const count = $('#skills-count');
  if (count) count.textContent = `${skillsState.skills.length} 个`;
  const installedCount = $('#skills-installed-count');
  if (installedCount) installedCount.textContent = String(skillsState.skills.length);
  const marketCount = $('#skills-market-count');
  if (marketCount) marketCount.textContent = Array.isArray(skillsState.market?.skills) ? `${skillsState.market.skills.length}` : '';
  const master = $('#skills-enabled');
  if (master) master.checked = skillsState.enabled === true;
  skillsStatus(skillsState.enabled
    ? `技能包已启用 · ${skillsEnabledCount()} 个全局启用`
    : '技能包未启用；关闭时不会注册 skill_list / skill_use。');
  const errors = $('#skills-errors');
  if (errors) {
    errors.innerHTML = skillsState.errors.length
      ? `<div class="skills-error">有 ${skillsState.errors.length} 个技能目录没有加载：${skillsState.errors.map((item) => `${esc(item.id || '(未命名)')}：${esc(item.error)}`).join('；')}</div>`
      : '';
  }
  if (skillsState.view === 'market' || skillsState.view === 'publish') {
    skillsSwitchView(skillsState.view);
    return;
  }
  skillsRenderInstalled();
}

async function skillsLoadDetail(id) {
  if (!id) return;
  skillsState.loadingDetail = true;
  skillsState.detailError = '';
  skillsRenderDetail();
  try {
    const result = await api(`/api/skills/${encodeURIComponent(id)}`);
    if (skillsState.selectedId !== id) return;
    skillsState.detail = result?.skill || null;
  } catch (error) {
    if (skillsState.selectedId === id) skillsState.detailError = String(error?.message || error);
  } finally {
    skillsState.loadingDetail = false;
    skillsRenderDetail();
  }
}

async function skillsSaveState(next = {}) {
  try {
    const result = await api('/api/skills/state', {
      method: 'POST',
      body: JSON.stringify({
        enabled: next.enabled ?? skillsState.enabled,
        enabledIds: next.enabledIds ?? skillsState.enabledIds,
        perChat: next.perChat ?? skillsState.perChat
      })
    });
    skillsState.enabled = result.enabled === true;
    skillsState.enabledIds = Array.isArray(result.enabledIds) ? result.enabledIds : [];
    skillsState.perChat = result.perChat && typeof result.perChat === 'object' ? result.perChat : {};
    skillsStatus('已保存；下一轮会话生效。');
    skillsRender();
  } catch (error) {
    skillsStatus(`保存失败：${error?.message || error}`, true);
  }
}

async function skillsLoad() {
  try {
    const [data, chats] = await Promise.all([
      api('/api/skills'),
      api('/api/chats').catch(() => ({ chats: [] }))
    ]);
    skillsState.enabled = data.enabled === true;
    skillsState.enabledIds = Array.isArray(data.enabledIds) ? data.enabledIds : [];
    skillsState.perChat = data.perChat && typeof data.perChat === 'object' ? data.perChat : {};
    skillsState.skills = Array.isArray(data.skills) ? data.skills : [];
    skillsState.errors = Array.isArray(data.errors) ? data.errors : [];
    skillsState.chats = Array.isArray(chats.chats) ? chats.chats : [];
    if (skillsState.selectedId && !skillsState.skills.some((skill) => skill.id === skillsState.selectedId)) {
      skillsState.selectedId = '';
      skillsState.detail = null;
    }
    skillsRender();
  } catch (error) {
    skillsStatus(`读取失败：${error?.message || error}`, true);
    skillsRenderDetail();
  }
}

function skillsBind(root) {
  if (root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  root.addEventListener('change', (event) => {
    if (event.target?.id === 'skills-enabled') {
      void skillsSaveState({ enabled: event.target.checked });
      return;
    }
    const global = event.target?.closest?.('[data-skill-global]');
    if (global) {
      const id = global.dataset.skillGlobal;
      const set = new Set(skillsState.enabledIds);
      if (global.checked) set.add(id); else set.delete(id);
      void skillsSaveState({ enabledIds: [...set] });
      return;
    }
    if (event.target?.id === 'skills-market-sort') {
      skillsState.marketSort = event.target.value || 'name';
      skillsState.marketPage = 1;
      skillsRenderMarket();
    }
  });
  root.addEventListener('input', (event) => {
    if (event.target?.id !== 'skills-market-search') return;
    skillsState.marketQuery = String(event.target.value || '');
    skillsState.marketPage = 1;
    const box = $('#skills-market-view');
    if (box) {
      // 只重绘市场区，避免搜索框自己丢焦点。
      const caret = event.target.selectionStart;
      skillsRenderMarket();
      const next = $('#skills-market-search');
      if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch { /* 忽略 */ } }
    }
  });
  root.addEventListener('click', async (event) => {
    const view = event.target?.closest?.('[data-skills-view]');
    if (view) {
      skillsSwitchView(view.dataset.skillsView);
      // 换子页时回到顶部，否则从预览/详情滚到底部再切页会落在另一个页面的半截。
      const scroller = $('#skills-page');
      if (scroller) scroller.scrollTop = 0;
      return;
    }
    if (event.target?.closest?.('[data-market-refresh]')) {
      // 保留当前列表，刷新期间只转图标；拉取失败也还能看旧数据。
      void skillsLoadMarket(true);
      return;
    }
    if (event.target?.closest?.('[data-market-close]')) {
      skillsState.marketPreview = null;
      skillsState.marketPreviewId = '';
      skillsState.marketPreviewError = '';
      skillsState.marketDetailId = '';
      skillsRenderMarket();
      return;
    }
    if (event.target?.closest?.('[data-skills-filters]')) {
      skillsState.marketFiltersOpen = !skillsState.marketFiltersOpen;
      skillsRenderMarket();
      return;
    }
    const marketRange = event.target?.closest?.('[data-market-range]');
    if (marketRange) {
      skillsState.marketRange = marketRange.dataset.marketRange || 'all';
      skillsState.marketPage = 1;
      skillsRenderMarket();
      return;
    }
    if (event.target?.closest?.('[data-market-clear]')) {
      skillsState.marketRange = 'all';
      skillsState.marketCategory = '';
      skillsState.marketQuery = '';
      skillsState.marketPage = 1;
      skillsRenderMarket();
      return;
    }
    const marketCategory = event.target?.closest?.('[data-market-category]');
    if (marketCategory) {
      skillsState.marketCategory = marketCategory.dataset.marketCategory === skillsState.marketCategory ? '' : marketCategory.dataset.marketCategory;
      skillsState.marketPage = 1;
      skillsRenderMarket();
      return;
    }
    const marketView = event.target?.closest?.('[data-market-view]');
    if (marketView) {
      skillsState.marketView = marketView.dataset.marketView === 'list' ? 'list' : 'grid';
      skillsState.marketPage = 1;
      skillsRenderMarket();
      return;
    }
    const marketPage = event.target?.closest?.('[data-market-page]');
    if (marketPage) {
      const totalPages = Math.max(1, Number(marketPage.closest('.skills-market-pagination')?.dataset.pages) || 1);
      const value = marketPage.dataset.marketPage;
      if (value === 'prev') skillsState.marketPage = Math.max(1, (skillsState.marketPage || 1) - 1);
      else if (value === 'next') skillsState.marketPage = Math.min(totalPages, (skillsState.marketPage || 1) + 1);
      else skillsState.marketPage = Math.max(1, Number(value) || 1);
      skillsRenderMarket();
      return;
    }
    const marketInstall = event.target?.closest?.('[data-market-install]');
    if (marketInstall) { void skillsInstallMarket(marketInstall.dataset.marketInstall); return; }
    const marketUninstall = event.target?.closest?.('[data-market-uninstall]');
    if (marketUninstall) { void skillsUninstallMarket(marketUninstall.dataset.marketUninstall); return; }
    const marketOpen = event.target?.closest?.('[data-market-open]');
    if (marketOpen) { void skillsLoadMarketPreview(marketOpen.dataset.marketOpen); return; }
    if (event.target?.closest?.('[data-skill-back]')) {
      skillsState.selectedId = '';
      skillsState.detail = null;
      skillsRenderInstalled();
      return;
    }
    const skillUninstall = event.target?.closest?.('[data-skill-uninstall]');
    if (skillUninstall) { void skillsUninstallMarket(skillUninstall.dataset.skillUninstall); return; }
    const open = event.target?.closest?.('[data-skill-open]');
    if (open) {
      skillsState.selectedId = open.dataset.skillOpen;
      skillsState.detail = null;
      skillsRenderInstalled();
      void skillsLoadDetail(skillsState.selectedId);
      return;
    }
    if (event.target?.closest?.('#skills-reload')) {
      try {
        const result = await api('/api/skills/reload', { method: 'POST', body: '{}' });
        skillsState.skills = Array.isArray(result.skills) ? result.skills : [];
        skillsState.errors = Array.isArray(result.errors) ? result.errors : [];
        if (!skillsState.skills.some((skill) => skill.id === skillsState.selectedId)) {
          skillsState.selectedId = skillsState.skills[0]?.id || '';
          skillsState.detail = null;
        }
        skillsStatus(`已重新扫描：${skillsState.skills.length} 个技能。`);
        skillsRender();
        if (skillsState.selectedId) void skillsLoadDetail(skillsState.selectedId);
      } catch (error) {
        skillsStatus(`扫描失败：${error?.message || error}`, true);
      }
      return;
    }
    if (event.target?.closest?.('[data-skill-chat-all]')) {
      const want = event.target.closest('[data-skill-chat-all]').dataset.skillChatAll === '1';
      $$('[data-skill-chat]').forEach((box) => { box.checked = want; });
      return;
    }
    if (event.target?.closest?.('#skill-chat-save-all')) {
      const on = skillsIsGlobal(skillsState.selectedId);
      const perChat = { ...skillsState.perChat };
      for (const box of $$('[data-skill-chat]')) {
        const key = box.dataset.skillChat;
        const desired = box.checked;
        const current = Array.isArray(perChat[key]) ? [...perChat[key]] : null;
        if (desired === on) {
          if (!current) continue;
          const next = current.filter((id) => id !== skillsState.selectedId);
          if (next.length) perChat[key] = next; else delete perChat[key];
          continue;
        }
        const next = current || [...skillsState.enabledIds];
        if (desired && !next.includes(skillsState.selectedId)) next.push(skillsState.selectedId);
        if (desired) perChat[key] = next;
        else perChat[key] = next.filter((id) => id !== skillsState.selectedId);
      }
      await skillsSaveState({ perChat });
    }
  });
}

function loadSkillsPage() {
  const box = $('#skills-page');
  if (!box) return;
  if (box.dataset.ready !== '1') {
    box.innerHTML = `
      <div class="pane-head skills-head">
        <div>
          <span class="skills-eyebrow">方法 · 流程</span>
          <h2>技能</h2>
          <p class="skills-claim">让机器人按一套方法做事：只读 Markdown 流程 + 工具白名单，不执行第三方代码。
            启用后模型会先选择技能，再在允许的工具范围内完成当前任务。</p>
        </div>
        <div class="skills-master">
          <label class="skills-switch"><input type="checkbox" class="sw" id="skills-enabled" /> <span>启用技能包</span></label>
          <button class="btn btn-small" id="skills-reload" type="button">${iconSvg('refresh', { size: 14 })}重新扫描</button>
          <div class="skills-master-status" id="skills-status"></div>
        </div>
      </div>
      <div class="plugin-tabs skills-tabs" role="tablist" aria-label="技能页面">
        <button type="button" class="plugin-tab is-on" role="tab" aria-selected="true" data-skills-view="market">技能市场<span class="plugin-tab-n" id="skills-market-count"></span></button>
        <button type="button" class="plugin-tab" role="tab" aria-selected="false" data-skills-view="installed">已安装<span class="plugin-tab-n" id="skills-installed-count"></span></button>
        <button type="button" class="plugin-publish-cta" role="tab" aria-selected="false" data-skills-view="publish">${iconSvg('upload', { size: 13 })}<span>提交技能</span></button>
      </div>
      <div id="skills-installed-view">
        <div class="plugin-pane-head"><span class="plugin-sec-sub" id="skills-installed-sub"></span></div>
        <div class="skills-errors" id="skills-errors"></div>
        <div id="skills-list" class="plugin-ledger"></div>
        <section id="skills-detail" class="skills-detail is-full" hidden></section>
      </div>
      <div id="skills-market-view" class="skills-market" hidden></div>
      <div id="skills-publish-view" class="skills-publish" hidden>
        <div class="skills-publish-card">
          <span class="skills-eyebrow">官方市场 · 审核制</span>
          <h3>提交一个技能</h3>
          <p>官方技能市场只收只读 Markdown 流程与工具白名单，不执行代码。把 <code>skill.json</code> / <code>SKILL.md</code> 托管到公开地址，生成索引条目后提交；维护者审核后合并，普通用户在「技能市场」刷新即可看到。</p>
          <ol class="skills-publish-steps">
            <li>运行 <code>npm run skill:pack -- ./my-skill --base-url &lt;公开目录&gt;</code> 生成带 sha256 的索引条目。</li>
            <li>通过提交表单或 PR 提交到官方索引。</li>
            <li>维护者运行 <code>npm run skill:check</code> 后合并。</li>
          </ol>
          <div class="skills-market-actions"><a class="btn btn-primary" href="https://github.com/sakurawwwxh/qq-agent-skills/issues/new?template=skill-submission.yml" target="_blank" rel="noopener noreferrer">打开技能提交表单</a><a class="btn" href="https://github.com/sakurawwwxh/qq-agent-skills/blob/main/README.md" target="_blank" rel="noopener noreferrer">阅读提交指南</a></div>
        </div>
      </div>`;
    box.dataset.ready = '1';
  }
  skillsBind(box);
  void skillsLoad();
}

export { loadSkillsPage };
