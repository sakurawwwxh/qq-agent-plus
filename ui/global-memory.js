'use strict';


import { api } from './core/api.js';
import { esc } from './core/dom.js';
import { setHtmlIfChanged } from './core/dom-util.js';
import { state } from './core/state.js';
import { saveMemberNote } from './pages/memory.js';
(function globalPersonMemoryConsole() {
  let people = [];
  let selectedKey = '';
  let loadSeq = 0;


  const fmtTime = (ts) => {
    const n = Number(ts) || 0;
    if (!n) return '-';
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };


  function ensureStyle() {
    if (document.getElementById('global-memory-style')) return;
    const style = document.createElement('style');
    style.id = 'global-memory-style';
    style.textContent = `
      #view-people-memory { min-width:0; }
      #global-memory-list { display:flex; flex-direction:column; }
      #global-memory-items { overflow:auto; min-height:0; }
      .gm-head { display:flex; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--border, rgba(128,128,128,.2)); }
      .gm-head strong { flex:1; }
      /* 2026-10-09 复核：--border-color / --hover-bg 是写错的名字（全仓无定义）→ 永远走兜底的
         死灰色、不跟主题；改成真实 token（--border / --hover），兜底保留给脱离控制台的场景。 */
      .gm-person { display:block; width:100%; border:0; border-bottom:1px solid var(--border, rgba(128,128,128,.15)); background:transparent; color:inherit; text-align:left; padding:11px 12px; cursor:pointer; }
      .gm-person:hover, .gm-person.active { background:var(--hover, rgba(127,127,127,.10)); }
      .gm-person-title { display:flex; gap:8px; align-items:center; }
      .gm-person-title strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .gm-count { margin-left:auto; font-size: var(--fs-sm, 12px); opacity:.7; }
      .gm-sub { margin-top:4px; font-size: var(--fs-sm, 12px); opacity:.65; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .gm-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
      .gm-chip { display:inline-block; padding:2px 7px; margin:2px 4px 2px 0; border-radius:var(--r-pill, 999px); font-size: var(--fs-sm, 12px); background:rgba(127,127,127,.12); }
      .gm-memory { margin:10px 0; padding:12px; border:1px solid var(--border, rgba(128,128,128,.2)); border-radius:var(--r-input, 10px); }
      .gm-memory-content { white-space:pre-wrap; line-height:1.55; }
      .gm-memory-meta { margin-top:7px; font-size: var(--fs-sm, 12px); opacity:.65; }
      .gm-section { margin:16px 0; }
      .gm-section h3 { margin:0 0 8px; }
      .gm-note { padding:10px 12px; margin:0 0 12px; border-radius:var(--r-sm, 8px); background:rgba(127,127,127,.08); font-size: var(--fs-md, 13px); line-height:1.5; }
      .gm-empty { padding:24px 14px; opacity:.6; }
      .gm-status { font-size: var(--fs-sm, 12px); opacity:.75; }
      .gm-note-field { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .gm-note-field input { flex:1 1 240px; min-width:0; }
      .gm-anynote { padding:8px 12px; border-bottom:1px solid var(--border-color, rgba(128,128,128,.15)); font-size: var(--fs-md, 13px); }
      .gm-anynote > summary { cursor:pointer; opacity:.8; }
      .gm-anynote .gm-note-field { margin-top:8px; }
      /* 列表栏很窄：这一行的两个输入框各占满一行，别挤成两三个字符宽 */
      .gm-anynote .gm-note-field input { flex:1 1 100%; }
    `;
    document.head.appendChild(style);
  }

  function viewParts() {
    ensureStyle();
    const view = document.getElementById('view-people-memory');
    const list = document.getElementById('global-memory-list');
    const detail = document.getElementById('global-memory-detail');
    const items = document.getElementById('global-memory-items');
    return view && list && detail && items ? { view, list, detail, items } : null;
  }

  async function mapLimit(items, limit, worker) {
    if (!items.length) return [];
    const output = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        try { output[index] = await worker(items[index], index); }
        catch { output[index] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
  }

  function mergePerson(target, incoming) {
    if (!target) return structuredClone(incoming);
    const merged = { ...target };
    merged.name = incoming.name || merged.name;
    merged.updatedAt = Math.max(Number(merged.updatedAt) || 0, Number(incoming.updatedAt) || 0);
    merged.lastConsolidatedAt = Math.max(
      Number(merged.lastConsolidatedAt) || 0,
      Number(incoming.lastConsolidatedAt) || 0
    );
    merged.sourceChatKeys = [...new Set([
      ...(merged.sourceChatKeys || []),
      ...(incoming.sourceChatKeys || [])
    ].map(String).filter(Boolean))];

    const memoryMap = new Map();
    for (const item of [...(merged.impressions || []), ...(incoming.impressions || [])]) {
      const content = String(item?.content || '').trim();
      if (!content) continue;
      const old = memoryMap.get(content);
      if (!old) {
        memoryMap.set(content, structuredClone(item));
        continue;
      }
      old.createdAt = Math.min(Number(old.createdAt) || Infinity, Number(item.createdAt) || Infinity);
      if (!Number.isFinite(old.createdAt)) old.createdAt = 0;
      old.lastObservedAt = Math.max(Number(old.lastObservedAt) || 0, Number(item.lastObservedAt) || 0);
      old.sourceChatKeys = [...new Set([
        ...(old.sourceChatKeys || []),
        ...(item.sourceChatKeys || [])
      ].map(String).filter(Boolean))];
    }
    merged.impressions = [...memoryMap.values()].sort((a, b) =>
      (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
      - (Number(a.lastObservedAt) || Number(a.createdAt) || 0));
    return merged;
  }

  async function fetchPeople() {
    // /api/memory-files 仍是兼容入口；每个 detail 返回的是 GlobalPersonMemoryStore
    // 在该 sourceChatKey 可见的人物。这里只按 QQ 合并，sourceChatKeys 仅保留来源。
    const summary = await api('/api/memory-files');
    const files = Array.isArray(summary.files) ? summary.files : [];
    const sourceFiles = files.filter((file) => Number(file.impressionCount) > 0);
    const details = await mapLimit(sourceFiles, 6, async (file) => {
      const path = String(file.chatKey || '').replace(':', '_');
      if (!/^(group|private)_\d+$/.test(path)) return null;
      return api(`/api/memory-files/${path}`);
    });

    const map = new Map();
    for (const detail of details) {
      for (const member of Array.isArray(detail?.members) ? detail.members : []) {
        const userId = String(member.userId || '').trim();
        const key = userId || `name:${String(member.name || '')}`;
        if (!key || key === 'name:') continue;
        map.set(key, mergePerson(map.get(key), member));
      }
    }
    return [...map.entries()]
      .map(([key, member]) => ({ key, ...member }))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  }

  function renderList() {
    const box = document.getElementById('global-memory-items');
    if (!box) return;
    if (!people.length) {
      setHtmlIfChanged(box, '<div class="gm-empty">还没有人物长期记忆</div>');
      return;
    }
    // setHtmlIfChanged：内容没变就不碰 DOM。这个页面每 15s 轮询一次（还有一个 focus 监听），
    // 无条件 innerHTML 会把正在读长印象的人每 15 秒弹回顶部一次（2026-10-08 审查）。
    setHtmlIfChanged(box, people.map((person) => {
      const sources = person.sourceChatKeys || [];
      const title = person.name || person.userId || '未知人物';
      const subtitle = person.userId
        ? `QQ ${person.userId} · ${sources.length} 个来源会话`
        : `${sources.length} 个来源会话`;
      return `<button type="button" class="gm-person ${person.key === selectedKey ? 'active' : ''}" data-gm-key="${esc(person.key)}">
        <div class="gm-person-title"><strong>${esc(title)}</strong><span class="gm-count">${(person.impressions || []).length} 条</span></div>
        <div class="gm-sub">${esc(subtitle)}</div>
      </button>`;
    }).join(''));
    box.querySelectorAll('[data-gm-key]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedKey = button.dataset.gmKey || '';
        renderList();
        renderDetail();
      });
    });
  }

  function sourceFor(person) {
    return (person?.sourceChatKeys || [])
      .find((key) => /^(group|private):\d+$/.test(String(key))) || '';
  }

  async function consolidatePerson(person) {
    const chatKey = sourceFor(person);
    const userId = String(person?.userId || '').trim();
    if (!chatKey || !/^\d{1,15}$/.test(userId)) {
      throw new Error('缺少可用于整理的来源会话或 QQ 号');
    }
    await api('/api/memory-files/consolidate', {
      method: 'POST',
      body: JSON.stringify({ chatKey, userIds: [userId], force: true })
    });
  }

  async function deletePerson(person) {
    const userId = String(person?.userId || '').trim();
    if (!/^\d{1,15}$/.test(userId)) throw new Error('缺少可删除的 QQ 号');
    // 按钮写的是"删除全部人物记忆"：走全局删除路由（该 QQ 在所有会话的印象一起删，服务端会先留快照）。
    // ⚠️ 别改回 /api/memory-files/<chat>/members/<uid>：那条路由的语义是"只清这个来源"，
    // 跨群合并过的人物会删不干净，用户以为删了其实还在。
    await api(`/api/memory-files/global/members/${userId}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
  }

  let noteDraft = { key: '', value: '' };   // 备注输入中的草稿（见 renderDetail 的说明）

  function renderDetail() {
    const box = document.getElementById('global-memory-detail');
    if (!box) return;
    const person = people.find((item) => item.key === selectedKey);
    if (!person) {
      setHtmlIfChanged(box, '<div class="empty-hint">← 选择人物查看全局长期记忆</div>');
      return;
    }

    const sourceHtml = (person.sourceChatKeys || []).length
      ? person.sourceChatKeys.map((key) => `<span class="gm-chip">${esc(key)}</span>`).join('')
      : '<span class="muted">无来源记录</span>';
    const memories = person.impressions || [];
    const memoryHtml = memories.length
      ? memories.map((item) => {
          const sources = (item.sourceChatKeys || [])
            .map((key) => `<span class="gm-chip">${esc(key)}</span>`).join('');
          const at = Number(item.lastObservedAt) || Number(item.createdAt) || 0;
          return `<div class="gm-memory">
            <div class="gm-memory-content">${esc(item.content)}</div>
            <div class="gm-memory-meta">最近确认 ${esc(fmtTime(at))}</div>
            <div>${sources || '<span class="muted">无来源</span>'}</div>
          </div>`;
        }).join('')
      : '<div class="gm-empty">这个人目前没有长期印象</div>';
    const manageable = /^\d{1,15}$/.test(String(person.userId || ''))
      && Boolean(sourceFor(person));

    // 备注编辑放在人物记忆页：memberNotes 是按 QQ 全局的人物级数据，与长期印象同一层级。
    // （会话记忆页那份"拉取群成员列表（编辑备注）"按上游设计被 CSS 隐藏，见 ui/session-memory-view.js。）
    // 写入口是 app.js 的 saveMemberNote —— 它走 __replace__ 整体替换，清空才真的删得掉。
    const noteKey = /^\d{1,15}$/.test(String(person.userId || '')) ? String(person.userId) : '';
    const savedNote = noteKey ? String((state.config?.memberNotes || {})[noteKey] || '') : '';
    // 15 秒轮询会重建整块详情：不保留草稿的话，正在输入的字会被擦掉
    const noteValue = noteKey && noteDraft.key === noteKey ? noteDraft.value : savedNote;
    const noteHtml = noteKey ? `
      <div class="gm-section"><h3>备注（称呼/代号）</h3>
        <div class="gm-note-field">
          <input type="text" id="gm-note-input" maxlength="200" value="${esc(noteValue)}" placeholder="留空 = 不设备注（如 老王）" />
          <button class="btn btn-small" type="button" id="gm-note-save">保存备注</button>
          <span class="gm-status" id="gm-note-status"></span>
        </div>
        <div class="gm-status">备注用于聊天记录、记忆与提示词里的称呼（与“会话记忆”页共用同一份数据）；在群里让机器人"以后叫他 X"，它记的也是这一份。</div>
      </div>` : '';

    setHtmlIfChanged(box, `
      <div class="detail-header">
        <h2>${esc(person.name || person.userId || '未知人物')}</h2>
        <div class="sub">${person.userId ? `QQ ${esc(person.userId)} · ` : ''}${memories.length} 条全局长期印象</div>
        <div class="gm-toolbar">
          <button class="btn btn-small" type="button" id="gm-consolidate" ${manageable ? '' : 'disabled'}>重新整理人物记忆</button>
          <button class="btn btn-small btn-danger" type="button" id="gm-delete" ${manageable ? '' : 'disabled'}>删除全部人物记忆</button>
          <span class="gm-status" id="gm-action-status"></span>
        </div>
      </div>
      <div class="gm-note">
        人物长期记忆按 QQ 全局统一；来源会话只用于证据追溯，不限制这条记忆在哪个群可见。<br>
        群聊/私聊自己的 handoff 已独立到“会话记忆”页，并继续严格按 chatKey 隔离。
      </div>
      ${noteHtml}
      <div class="gm-section"><h3>来源会话</h3><div>${sourceHtml}</div></div>
      <div class="gm-section"><h3>长期印象</h3>${memoryHtml}</div>`);

    const status = box.querySelector('#gm-action-status');
    const noteInput = box.querySelector('#gm-note-input');
    const noteStatus = box.querySelector('#gm-note-status');
    noteInput?.addEventListener('input', () => { noteDraft = { key: noteKey, value: noteInput.value }; });
    box.querySelector('#gm-note-save')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      if (noteStatus) noteStatus.textContent = '保存中…';
      try {
        const value = String(noteInput?.value || '').trim();
        await saveMemberNote(noteKey, value);
        noteDraft = { key: '', value: '' };
        if (noteStatus) noteStatus.textContent = value ? '已保存' : '已清空';
      } catch (error) {
        if (noteStatus) noteStatus.textContent = `保存失败：${error?.message || error}`;
      } finally {
        button.disabled = false;
      }
    });
    box.querySelector('#gm-consolidate')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      if (status) status.textContent = '已提交整理任务…';
      try {
        await consolidatePerson(person);
        if (status) status.textContent = '整理中，完成后会自动刷新';
        setTimeout(() => loadGlobalMemory(true), 2500);
        setTimeout(() => loadGlobalMemory(true), 7000);
      } catch (error) {
        if (status) status.textContent = `整理失败：${error?.message || error}`;
        button.disabled = false;
      }
    });
    box.querySelector('#gm-delete')?.addEventListener('click', async (event) => {
      if (!window.confirm(`确定删除 ${person.name || person.userId} 的全部全局人物记忆？她在所有会话里的印象都会删掉（服务端会留一份可回滚快照），聊天记录不受影响。`)) return;
      const button = event.currentTarget;
      button.disabled = true;
      if (status) status.textContent = '正在删除…';
      try {
        await deletePerson(person);
        selectedKey = '';
        await loadGlobalMemory(true);
      } catch (error) {
        if (status) status.textContent = `删除失败：${error?.message || error}`;
        button.disabled = false;
      }
    });
  }

  async function loadGlobalMemory(force = false) {
    const ui = viewParts();
    if (!ui) return;
    const seq = ++loadSeq;
    if (force || !people.length) {
      ui.items.innerHTML = '<div class="gm-empty">正在读取全局人物记忆…</div>';
    }
    try {
      const next = await fetchPeople();
      if (seq !== loadSeq) return;
      people = next;
      if (selectedKey && !people.some((item) => item.key === selectedKey)) selectedKey = '';
      renderList();
      renderDetail();
    } catch (error) {
      if (seq !== loadSeq) return;
      ui.items.innerHTML = `<div class="gm-empty">加载失败：${esc(error?.message || error)}</div>`;
    }
  }

  function activateIfNeeded() {
    const view = document.getElementById('view-people-memory');
    if (!view?.classList.contains('active')) return;
    loadGlobalMemory(false);
  }

  document.getElementById('gm-refresh')?.addEventListener('click', () => loadGlobalMemory(true));

  // 按 QQ 设备注：名单里只有"进过记忆库的人"（说过话的），没说过话的群友靠这一行补上。
  // 写入口仍是 app.js 的 saveMemberNote（__replace__ 整体替换，留空即删除）。
  document.getElementById('gm-anynote-save')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = document.getElementById('gm-anynote-status');
    const qq = String(document.getElementById('gm-anynote-qq')?.value || '').trim();
    const note = String(document.getElementById('gm-anynote-text')?.value || '').trim();
    if (!/^\d{1,15}$/.test(qq)) {
      if (status) status.textContent = 'QQ 号要填纯数字';
      return;
    }
    button.disabled = true;
    if (status) status.textContent = '保存中…';
    try {
      await saveMemberNote(qq, note);
      const input = document.getElementById('gm-anynote-text');
      if (input) input.value = '';
      if (status) status.textContent = note ? `已保存：${qq}` : `已删除：${qq}`;
      await loadGlobalMemory(true);   // 名单里有这个人的话，详情里的备注行也要跟着更新
    } catch (error) {
      if (status) status.textContent = `保存失败：${error?.message || error}`;
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector('[data-tab="people-memory"]')?.addEventListener('click', () => {
    // app.js 的通用 tab handler 先完成视图切换；随后刷新人物全局视图。
    setTimeout(() => loadGlobalMemory(true), 0);
  });

  window.addEventListener('focus', activateIfNeeded);
  setInterval(() => {
    const view = document.getElementById('view-people-memory');
    if (view?.classList.contains('active')) loadGlobalMemory(false);
  }, 15000);
})();
