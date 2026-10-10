// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';

// ── 记忆视图 ──

import { closeModelModal, loadSettings, modelModalShell } from '../app.js';
import { api } from '../core/api.js';
import { askForConfirmation, impressionMetaLabel } from '../core/dom-util.js';
import { $, $$, esc } from '../core/dom.js';
import { chatNameOf, fmtTime, formatChatTitle } from '../core/format.js';
import { startConsolidateTicker, state } from '../core/state.js';
async function loadMemoryView() {
  try {
    const [cfg, chats] = await Promise.all([api('/api/config'), api('/api/chats')]);
    state.config = cfg;
    const files = await api('/api/memory-files');
    state.memoryFiles = files.files || [];
    state.chats = chats.chats || [];
    // 用后端状态校正本地记录：覆盖"页面刚刷新""SSE 断连期间状态变化"两种情况。
    // 后端 consolidating 是唯一可信来源（它在 orchestrator 里真实维护）。
    for (const f of state.memoryFiles) {
      if (f.consolidating) {
        if (!state.consolidating[f.chatKey]) {
          state.consolidating[f.chatKey] = { startedAt: Date.now() };
        }
      } else if (state.consolidating[f.chatKey]) {
        // 后端已经不在整理，说明完成了（结果由 SSE 事件补充）
        delete state.consolidating[f.chatKey];
        if (!state.consolidateResult[f.chatKey]) {
          state.consolidateResult[f.chatKey] = { note: '整理完成', at: Date.now() };
        }
      }
    }
    renderMemoryList();
    if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

function renderMemoryList() {
  const box = $('#memory-items');
  const files = state.memoryFiles || [];
  const names = {};
  for (const c of state.chats || []) names[c.key] = formatChatTitle(c.key, chatNameOf(c.key));
  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何记忆（等机器人使用记忆工具后才会出现）</div>';
    return;
  }
  box.innerHTML = files.map((f) => {
    const key = f.chatKey;
    const busy = !!state.consolidating[key];
    // 整理中：在列表项上直接标出，切页签回来也能一眼看到
    // （2026-10-09 复核：原来写的 --color-background-warning 全仓无定义、又没兜底 →
    //   声明失效变 unset、白字贴透明底看不见；换成有定义的 --orange）
    const busyHtml = busy
      ? `<span class="unread-pill" style="background:var(--orange)">整理中…</span>`
      : '';
    const sub = busy
      ? '正在整理本群记忆'
      : [
          f.hasHandoff ? '有会话交接' : '',
          f.memberCount ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象` : '暂无群友印象'
        ].filter(Boolean).join(' · ');
    return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}" role="button" tabindex="0">
        <div class="chat-item-title">
          <span class="session-chat">${esc(names[key] || key)}</span>
          ${busyHtml}
        </div>
        <div class="chat-item-sub">${esc(sub)}</div>
        <div class="session-meta"><span>更新于 ${fmtTime(f.updatedAt || 0)}</span></div>
      </div>`;
  }).join('');
  $$('.chat-item', box).forEach((el) => {
    const open = () => {
      state.currentMemoryChatKey = el.dataset.key;
      renderMemoryList();
      loadMemoryDetail(state.currentMemoryChatKey);
    };
    el.addEventListener('click', open);
    // 键盘也要能进：这一列原来是纯 div（无 role/tabindex），Tab 直接跳过整列（2026-10-08 审查）。
    // 与「会话」「存档」两个列表同样的 Enter/Space 口径。
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  });
}

async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  // 竞态守卫：快速切群、或"整理 A 群"的推送触发的刷新与用户点击切到 B 群并发时，
  // 先发后到的响应会把右侧详情覆盖成另一个群的内容（2026-09-29 审查 P2）。
  // 与资产页 requestId、会话详情 currentSessionId 的写法同一口径。
  const seq = (state.memoryDetailSeq = (state.memoryDetailSeq || 0) + 1);
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [mem, cfg] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config')
    ]);
    if (seq !== state.memoryDetailSeq) return;
    const notes = cfg.memberNotes || {};
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const members = Array.isArray(mem.members) ? mem.members : [];
    const handoff = mem.handoff || null;
    const listText = (value) => (Array.isArray(value) ? value : []).join('\n');
    const ttlMinutes = handoff
      ? Math.max(5, Math.round(((Number(handoff.expiresAt) || 0) - (Number(handoff.updatedAt) || Date.now())) / 60000))
      : Number(cfg.memory?.handoffTtlMinutes) || 1440;
    const handoffMeta = handoff
      ? `更新于 ${fmtTime(handoff.updatedAt)} · 过期于 ${fmtTime(handoff.expiresAt)}${handoff.sourceSessionId ? ` · 来源 ${esc(handoff.sourceSessionId)}` : ''}`
      : '当前没有会话交接状态';
    const handoffHtml = `
      <details class="collapsible memory-handoff" open>
        <summary>会话交接状态</summary>
        <div class="coll-body">
          <div class="field-row">
            <div class="field"><label>当前话题</label><input type="text" id="mh-topic" maxlength="200" value="${esc(handoff?.topic || '')}" /></div>
            <div class="field"><label>有效时间（分钟）</label><input type="number" id="mh-ttl" min="5" max="10080" value="${esc(ttlMinutes)}" /></div>
          </div>
          <div class="field"><label>已知上下文</label><textarea id="mh-summary" maxlength="1200">${esc(handoff?.summary || '')}</textarea></div>
          <div class="field-row">
            <div class="field"><label>待验证假设（一行一条）</label><textarea id="mh-hypotheses">${esc(listText(handoff?.hypotheses))}</textarea></div>
            <div class="field"><label>关键证据（一行一条）</label><textarea id="mh-evidence">${esc(listText(handoff?.evidence))}</textarea></div>
          </div>
          <div class="field-row">
            <div class="field"><label>已确认事实（一行一条）</label><textarea id="mh-facts">${esc(listText(handoff?.facts))}</textarea></div>
            <div class="field"><label>已作决定（一行一条）</label><textarea id="mh-decisions">${esc(listText(handoff?.decisions))}</textarea></div>
          </div>
          <div class="field-row">
            <div class="field"><label>已排除方向（一行一条）</label><textarea id="mh-rejected">${esc(listText(handoff?.rejectedDirections))}</textarea></div>
            <div class="field"><label>未解决问题（一行一条）</label><textarea id="mh-questions">${esc(listText(handoff?.openQuestions))}</textarea></div>
          </div>
          <div class="field"><label>下一步意图</label><textarea id="mh-next-step" maxlength="400">${esc(handoff?.nextStep || '')}</textarea></div>
          <div class="memory-handoff-actions">
            <span id="mh-status" class="muted">${handoffMeta}</span>
            <button class="btn btn-danger" id="mh-clear" ${handoff ? '' : 'disabled'}>清除</button>
            <button class="btn btn-primary" id="mh-save">保存交接</button>
          </div>
        </div>
      </details>`;
    const membersHtml = kind === 'group'
      ? `<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>`
      : '';
    const rows = members.map((m) => {
      const who = notes[String(m.userId)] || m.name || m.userId || '某人';
      const qq = m.userId ? ` <span class="muted">(QQ ${esc(m.userId)})</span>` : '';
      const imps = m.impressions.map((e) => `- ${impressionMetaLabel(e)}${e.content}`).join('\n');
      return `<div class="collapsible" open>
        <summary>${esc(who)}${qq}（${m.impressions.length} 条）
          <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:8px">编辑</button>
          <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新记忆</button>
        </summary>
        <div class="coll-body">${esc(imps)}</div>
      </div>`;
    }).join('');
    // 整理状态从 state 恢复：切页签回来 / 刷新页面后依然可见
    const busy = !!state.consolidating[chatKey];
    const result = state.consolidateResult[chatKey];
    let consolidateStatusHtml = '';
    if (busy) {
      const started = state.consolidating[chatKey]?.startedAt || Date.now();
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">整理中…（已 ${sec}s）</span>`;
    } else if (result) {
      const ago = Math.max(0, Math.round((Date.now() - (result.at || 0)) / 1000));
      const when = ago < 60 ? `${ago}s 前` : `${Math.round(ago / 60)} 分钟前`;
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">${esc(result.note)}（${when}）</span>`;
    } else {
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted"></span>`;
    }
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的记忆</h2>
        <div class="sub">
          <span>每个群友一个文件：data/memory/${esc(chatKey.replace(':', '_'))}/&lt;QQ&gt;.json</span>
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群记忆'}</button>
          ${consolidateStatusHtml}
        </div>
      </div>
      ${handoffHtml}
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}
    `;
    const handoffPath = `/api/memory-files/${chatKey.replace(':', '_')}/handoff`;
    const lines = (id) => ($(id)?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    $('#mh-save')?.addEventListener('click', async () => {
      const btn = $('#mh-save');
      const status = $('#mh-status');
      btn.disabled = true;
      if (status) status.textContent = '保存中…';
      try {
        await api(handoffPath, {
          method: 'PUT',
          body: JSON.stringify({
            topic: ($('#mh-topic')?.value || '').trim(),
            summary: ($('#mh-summary')?.value || '').trim(),
            hypotheses: lines('#mh-hypotheses'),
            evidence: lines('#mh-evidence'),
            facts: lines('#mh-facts'),
            decisions: lines('#mh-decisions'),
            rejectedDirections: lines('#mh-rejected'),
            openQuestions: lines('#mh-questions'),
            nextStep: ($('#mh-next-step')?.value || '').trim(),
            ttlMinutes: Number($('#mh-ttl')?.value) || 1440
          })
        });
        await loadMemoryView();
      } catch (e) {
        btn.disabled = false;
        if (status) status.textContent = `保存失败：${e.message}`;
      }
    });
    $('#mh-clear')?.addEventListener('click', async () => {
      if (!await askForConfirmation('确定清除这个会话的交接状态？')) return;
      const btn = $('#mh-clear');
      btn.disabled = true;
      try {
        await api(handoffPath, { method: 'DELETE', body: '{}' });
        await loadMemoryView();
      } catch (e) {
        btn.disabled = false;
        const status = $('#mh-status');
        if (status) status.textContent = `清除失败：${e.message}`;
      }
    });
    const loadMembersBtn = $('#mem-load-members-btn');
    if (loadMembersBtn) loadMembersBtn.addEventListener('click', () => loadGroupMembers(chatId, chatKey));
    $$('.mem-edit-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        openMemberImpressModal(chatKey, m || { userId: el.dataset.qq, name: el.dataset.name, impressions: [] });
      });
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));
    // 针对单个群友更新记忆：有印象→整理合并；无印象→从聊天记录提炼
    $$('.mem-refresh-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        if (!/^\d{1,15}$/.test(uid)) { alert('该群友缺少 QQ 号，无法定位聊天记录'); return; }
        el.disabled = true;
        const old = el.textContent;
        el.textContent = '更新中…';
        // 同样记进 state，切页签回来后仍能看到进行中
        state.consolidating[chatKey] = { startedAt: Date.now() };
        delete state.consolidateResult[chatKey];
        startConsolidateTicker();
        renderMemoryList();
        try {
          await api('/api/memory-files/consolidate', {
            method: 'POST',
            body: JSON.stringify({ chatKey, userIds: [uid] })
          });
          el.textContent = '已提交 ✓';
        } catch (err) {
          // 请求在客户端就失败时不会有 SSE 的 consolidate-done 来收尾：
          // 必须自己把"整理中"摘掉，否则列表永远显示"整理中…"、计时器也一直空转
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${err.message}`, at: Date.now(), failed: true };
          el.textContent = '失败';
          alert(`更新记忆失败：${err.message}`);
          renderMemoryList();
        }
        setTimeout(() => { el.disabled = false; el.textContent = old; }, 2500);
      });
    });
    $('#mem-consolidate-btn')?.addEventListener('click', async () => {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      // 立刻记进 state：即使马上切走页签，回来也能看到"整理中"
      state.consolidating[chatKey] = { startedAt: Date.now() };
      delete state.consolidateResult[chatKey];
      startConsolidateTicker();
      renderMemoryList();
      if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
      if (status) status.textContent = '整理中…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        if (r.error) {
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${r.error}`, at: Date.now(), failed: true };
          if (status) status.textContent = `失败：${r.error}`;
          if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
        renderMemoryList();
      }
    });
    // 若本群正在整理，启动计时刷新（切回来时也能接着走）
    if (state.consolidating[chatKey]) startConsolidateTicker();
  } catch (e) {
    // 失败分支也要守：切群后旧请求晚失败，会把新群已经渲染好的详情换成"加载失败"
    // （与资产页的 catch 同一口径，2026-09-29 审查）
    if (seq !== state.memoryDetailSeq) return;
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */
function openMemberImpressModal(chatKey, member) {
  const isEdit = !!(member && member.userId);
  const userId = member?.userId || '';
  const name = member?.name || '';
  const imps = (member?.impressions || []).map((e) => e.content).join('\n');
  const cfg = state.config || {};
  const notes = cfg.memberNotes || {};
  const note = notes[String(userId)] || '';
  const overlay = modelModalShell({
    head: isEdit ? `编辑群友印象：${note || name || userId}` : '添加群友印象',
    body: `
      ${isEdit ? `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="mi-qq" value="${esc(userId)}" readonly /></div>
        <div class="field"><label>QQ 昵称</label><input type="text" id="mi-nickname" value="${esc(name)}" readonly /></div>
        <div class="field"><label>群内昵称</label><input type="text" id="mi-card" value="${esc(member?.card || '')}" readonly /></div>
      </div>
      <div class="field"><label>QQ agent 对群友的当前备注</label><input type="text" id="mi-note" value="${esc(note)}" placeholder="留空则使用原群名片/昵称" /></div>` : `
      <div class="field"><label>QQ 号（必填）</label><input type="text" id="mi-qq" value="${esc(userId)}" /></div>
      <div class="field"><label>名字（备注名/群名片/昵称）</label><input type="text" id="mi-name" value="${esc(name)}" /></div>`}
      <div class="field"><label>印象内容（一行一条；留空 = 删除该成员全部印象）</label><textarea id="mi-imps" style="min-height:160px" placeholder="老王喜欢钓鱼，周末常不在&#10;说话爱玩梗，别太认真">${esc(imps)}</textarea></div>`,
    foot: `<button class="btn" id="mi-cancel">取消</button>
           ${isEdit ? '<button class="btn btn-danger" id="mi-del">删除此人</button>' : ''}
           <button class="btn btn-primary" id="mi-save">保存</button>`
  });
  overlay.querySelector('#mi-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mi-save').addEventListener('click', async () => {
    const qq = ($('#mi-qq')?.value || '').trim();
    const nm = ($('#mi-name')?.value || $('#mi-nickname')?.value || '').trim();
    const newNote = ($('#mi-note')?.value || '').trim();
    const lines = ($('#mi-imps')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!/^\d{1,15}$/.test(qq)) { alert('QQ 号必须是数字'); return; }
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${qq}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nm, note: newNote, impressions: lines })
      });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mi-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!await askForConfirmation(`确定删除 ${note || name || userId} 在本会话里的印象？（其它会话记得的印象不受影响；服务端会留可回滚快照）`)) return;
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}

async function loadGroupMembers(chatId, chatKey) {
  const status = $('#mem-members-status');
  if (status) status.textContent = '拉取中…';
  try {
    const data = await api(`/api/groups/${chatId}/members`);
    state.groupMembers = data.members || [];
    state.groupMembersLoaded = true;
    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    const box = $('#mem-members');
    if (box) {
      box.innerHTML = `<div class="collapsible" open><summary>群成员（${state.groupMembers.length} 人）</summary><div class="coll-body"><table class="member-table">
        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:90px;text-align:right">备注</th></tr>
        ${state.groupMembers.map((m) => {
          const note = notes[String(m.userId)];
          return `<tr>
            <td>${esc(note || m.card || '—')}${note && (m.card || m.nickname) ? ` <span class="muted">(${esc(m.card || m.nickname)})</span>` : ''}</td>
            <td>${esc(m.nickname || '—')}</td>
            <td class="muted" style="font-size: var(--fs-xs)">${esc(m.userId)}</td>
            <td style="text-align:right"><button class="btn btn-small member-note-edit" data-qq="${esc(m.userId)}">编辑备注</button></td>
          </tr>`;
        }).join('')}
      </table></div></div>`;
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });
    }
    if (status) status.textContent = `已拉取 ${state.groupMembers.length} 人`;
  } catch (e) {
    if (status) status.textContent = `拉取失败：${e.message}`;
  }
}

/**
 * 群友备注（memberNotes）的唯一写入口。控制台两处会改它：会话记忆页的成员列表，
 * 以及人物记忆页的备注行——都走这里，避免"某个入口漏了 __replace__"再次发生。
 *
 * __replace__ 是必须的：普通深合并只遍历传上去的键，删掉某个键再整体回传是删不掉的
 * （服务端会把已有的备注原样并回来，于是清空/删除备注看着成功、实际没变；2026-09-29 审查 P1）。
 * 传空串表示删除这条备注。
 */
async function saveMemberNote(userId, note) {
  const key = String(userId ?? '').trim();
  if (!/^\d{1,15}$/.test(key)) throw new Error('缺少可用的 QQ 号');
  // 提交前**每次都重取现值**再拼整表：memberNotes 现在有两个写入方（控制台 + 群里让机器人
  // 用 set_member_note 记），拿旧快照拼 __replace__ 会把对方刚写进去的条目整表抹掉
  //（2026-10-10 复核：群里刚"以后叫他 X"，控制台保存另一条备注就把 X 丢了）。
  state.config = await api('/api/config') || state.config;
  const nextNotes = { ...(state.config?.memberNotes || {}) };
  const text = String(note ?? '').trim();
  if (text) nextNotes[key] = text; else delete nextNotes[key];
  const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: { __replace__: nextNotes } }) });
  if (data?.config) state.config = data.config;
  return data;
}

async function openMemberNoteModal(qq, chatKey) {
  const cfg = state.config || await api('/api/config');
  const notes = cfg.memberNotes || {};
  const oldNote = notes[String(qq)] || '';
  const member = (state.groupMembers || []).find((m) => String(m.userId) === String(qq));
  const displayName = member ? String(member.card || member.nickname || '') : '';
  const overlay = modelModalShell({
    head: `编辑备注：${oldNote || displayName || qq}`,
    body: `
      <div class="field"><label>QQ 号</label><input type="text" value="${esc(qq)}" readonly style="width:100%" /></div>
      <div class="field"><label>备注名</label><input type="text" id="mn-note" maxlength="200" value="${esc(oldNote)}" placeholder="${esc(displayName || '备注名（如 老王）')}" style="width:100%" /></div>
      <div class="hint">保存后，聊天记录、记忆、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
    foot: `<button class="btn" id="mn-cancel">取消</button>
           ${oldNote ? '<button class="btn btn-danger" id="mn-delete">删除备注</button>' : ''}
           <button class="btn btn-primary" id="mn-save">保存</button>`
  });
  overlay.querySelector('#mn-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mn-save').addEventListener('click', async () => {
    const name = $('#mn-note')?.value.trim() || '';
    try {
      await saveMemberNote(qq, name);
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mn-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    try {
      await saveMemberNote(qq, '');
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}

/** 选择记忆整理专用模型：复用模型目录选择器，保存到 config.memory.provider/model。 */
function openMemoryModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#mem-model-hint').textContent = '模型目录为空：请先到「模型 API」页签选服务预设或填地址添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择记忆整理模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  // 从 DOM 的隐藏字段读当前值（而非 state.config）：
  // 用户可能刚选过但还没保存，或 state 还没刷新，DOM 才是最新真相。
  const currentProvider = $('#cfg-mem-provider')?.value || state.config?.memory?.provider || '';
  const currentModel = $('#cfg-mem-model')?.value || state.config?.memory?.model || '';
  let activePid = currentProvider || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel && p.id === currentProvider ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size: var(--fs-xs)">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 必须把"是否跟随聊天模型"的当前勾选状态一并提交。
          // 否则：用户取消勾选（→ 只改了 DOM，state.config 仍是 true）后直接点模型，
          // 这次提交不带 useChatModel，随后 loadSettings() 又按 state.config(true)
          // 重新渲染 —— 复选框被打回"已勾选"，迫使必须先保存一次才能选模型。
          const useChatBox = $('#cfg-mem-usechat');
          const useChatModel = useChatBox ? !!useChatBox.checked
            : (state.config?.memory?.useChatModel !== false);
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ memory: { provider: pid, model, useChatModel } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#mem-model-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}


export { loadMemoryView, openMemoryModelPicker, renderMemoryList, saveMemberNote };