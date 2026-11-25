// 主动开话题的按群覆盖：只存有显式覆盖的群；未出现的群继续跟随全局 groupEnabled。
import { esc } from '../core/dom.js';
import { state } from '../core/state.js';

function proactiveGroupDraft() {
  state.proactivePerGroupDraft ||= {};
  return state.proactivePerGroupDraft;
}

function proactiveGroupLabel(groupId) {
  const chat = (state.chats || []).find((item) => item.key === `group:${groupId}`);
  return chat?.chatName ? `${chat.chatName}（${groupId}）` : `群 ${groupId}`;
}

function proactiveGroupRowsHtml() {
  const entries = Object.entries(proactiveGroupDraft()).sort(([a], [b]) => String(a).localeCompare(String(b), 'zh-CN'));
  if (!entries.length) return '<div class="hint">当前所有群都跟随上面的全局开关。添加群号后可以单独开启或关闭。</div>';
  return entries.map(([groupId, value]) => {
    const mode = value?.enabled === true ? 'on' : value?.enabled === false ? 'off' : 'follow';
    return `<div class="field-row" data-proactive-group-row="${esc(groupId)}" style="align-items:flex-end">
      <div class="field"><label>${esc(proactiveGroupLabel(groupId))}</label><div class="hint">${esc(groupId)}</div></div>
      <div class="field"><label>主动开话题</label>
        <select data-proactive-group-value="${esc(groupId)}">
          <option value="follow" ${mode === 'follow' ? 'selected' : ''}>跟随全局</option>
          <option value="on" ${mode === 'on' ? 'selected' : ''}>开启</option>
          <option value="off" ${mode === 'off' ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <button type="button" class="btn btn-small" data-proactive-group-remove="${esc(groupId)}">删除覆盖</button>
    </div>`;
  }).join('');
}

function renderProactiveGroupEditor(config) {
  state.proactivePerGroupDraft = structuredClone(config.proactive?.perGroup || {});
  return `<div class="field" id="cfg-proactive-pergroup-editor">
    <label>按群控制主动发言</label>
    <div class="hint">这里的设置覆盖上面的「群聊」全局开关；没有单独配置的群继续跟随全局。群号必须在聊天白名单里才会参与主动发言。</div>
    <div data-proactive-group-rows>${proactiveGroupRowsHtml()}</div>
    <div class="settings-inline-actions">
      <input type="text" id="cfg-proactive-group-id" inputmode="numeric" placeholder="群号，例如 123456" style="max-width:220px" />
      <button type="button" class="btn btn-small" data-proactive-group-add>＋ 添加群覆盖</button>
    </div>
    <div class="hint" data-proactive-group-note></div>
  </div>`;
}

function markProactiveGroupDirty(note) {
  state.settingsDirty = true;
  const el = document.querySelector('#cfg-dirty-note');
  if (el) el.textContent = note || '有未保存改动';
}

function bindProactiveGroupEditor() {
  const root = document.querySelector('#cfg-proactive-pergroup-editor');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  const holder = root.querySelector('[data-proactive-group-rows]');
  const note = root.querySelector('[data-proactive-group-note]');
  const rerender = () => { if (holder) holder.innerHTML = proactiveGroupRowsHtml(); };
  const setNote = (text) => { if (note) note.textContent = text || ''; };

  root.addEventListener('change', (event) => {
    const select = event.target.closest('[data-proactive-group-value]');
    if (!select) return;
    const groupId = select.dataset.proactiveGroupValue;
    if (select.value === 'follow') delete proactiveGroupDraft()[groupId];
    else proactiveGroupDraft()[groupId] = { enabled: select.value === 'on' };
    rerender();
    setNote(`已修改群 ${groupId} 的覆盖，记得保存。`);
    markProactiveGroupDirty();
  });

  root.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-proactive-group-remove]');
    if (remove) {
      delete proactiveGroupDraft()[remove.dataset.proactiveGroupRemove];
      rerender();
      setNote('已删除群覆盖，记得保存。');
      markProactiveGroupDirty();
      return;
    }
    if (!event.target.closest('[data-proactive-group-add]')) return;
    const input = root.querySelector('#cfg-proactive-group-id');
    const groupId = String(input?.value || '').trim();
    if (!/^\d{5,15}$/.test(groupId)) {
      setNote('群号必须是 5–15 位数字。');
      return;
    }
    proactiveGroupDraft()[groupId] ||= { enabled: true };
    rerender();
    if (input) input.value = '';
    setNote(`已添加群 ${groupId} 的覆盖，记得保存。`);
    markProactiveGroupDirty();
  });
}

export { renderProactiveGroupEditor, bindProactiveGroupEditor };
