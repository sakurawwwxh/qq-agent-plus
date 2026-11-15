// Four credential-free replacement queues; all mutable draft state lives in state.
import { closeModelModal, loadSettings, modelModalShell } from '../app.js';
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';
import { state } from '../core/state.js';

const channels = [['chat', '主模型'], ['asr', '语音转文字'], ['tts', '语音回复（TTS）'], ['imageGen', '图片生成（按张计费）']];
const triggerOptions = [['http402', 'HTTP 402', true], ['http403', 'HTTP 403', true], ['quota429', '明确额度耗尽的 HTTP 429', true], ['http401', 'HTTP 401', false]];
const triggerDefaults = (raw) => Object.fromEntries(triggerOptions.map(([key, , fallback]) => [key, typeof raw?.[key] === 'boolean' ? raw[key] : fallback]));
const entryId = (e) => e ? `${e.source}:${e.providerId}:${e.model}` : '';
const entryLabel = (entry) => {
  if (!entry) return '';
  const p = (state.providers || []).find((v) => v.id === entry.providerId);
  return `${entry.model} · ${p?.displayName || entry.providerId}`;
};

function renderModelReplacementSection(config) {
  state.modelReplacementDirty = {};
  state.modelReplacementTriggerDirty = {};
  state.modelReplacementDraft = Object.fromEntries(channels.map(([key]) => {
    const c = config.modelReplacement?.[key] || {};
    return [key, { ...c, enabled: c.enabled === true, revision: c.revision || 0,
      entries: Array.isArray(c.entries) ? structuredClone(c.entries) : [null, null, null] }];
  }));
  state.modelReplacementTriggerDraft = Object.fromEntries(channels.map(([key]) => [key, {
    triggers: triggerDefaults(config.modelReplacement?.[key]?.triggers), revision: config.modelReplacement?.[key]?.revision || 0
  }]));
  return `<h3 id="settings-model-replacement">模型替换链</h3>
    <div class="hint">当模型接口返回本链已选择的错误条件时，按顺序替换当前模型并重试。空框跳过；切到最后一个有效模型立即关闭该条链，并保留最后的模型。不会循环。四条链独立运行，原有兜底模型保留。每条链使用自己的保存按钮；页面底部“保存设置”不保存或重置替换链。</div>
    <div id="model-replacement-editor">${triggerEditorHtml()}${channels.map(([key, label]) => {
      const c = state.modelReplacementDraft[key];
      return `<details data-replacement-channel="${key}" ${key === 'chat' ? 'open' : ''} style="margin-top:16px">
        <summary style="cursor:pointer;font-weight:600">${label}</summary>
        <fieldset data-replacement-fields="${key}" style="border:0;padding:0;margin:0;min-width:0">
        <div class="checkbox-row" style="margin-top:10px"><input type="checkbox" id="replacement-${key}-enabled" ${c.enabled ? 'checked' : ''} />
          <label for="replacement-${key}-enabled">启用${label}替换链</label></div>
        <div class="hint" data-replacement-progress="${key}">${progressHtml(c, key)}</div>
        <div data-replacement-rows="${key}">${rowsHtml(key)}</div>
        <button type="button" class="btn btn-small" data-replacement-add="${key}">＋ 添加模型</button>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button type="button" class="btn btn-primary" data-replacement-save="${key}">保存${label}替换链</button>
          <button type="button" class="btn btn-small" data-replacement-reload="${key}">重新读取此链</button>
        </div>
        </fieldset>
        <div class="hint" data-replacement-status="${key}" role="status" aria-live="polite"></div>
      </details>`;
    }).join('')}</div>
    <div id="model-replacement-hint" class="hint" role="status"></div>`;
}

function rowsHtml(channel) {
  const entries = state.modelReplacementDraft[channel].entries;
  const count = Math.max(3, entries.length);
  return Array.from({ length: count }, (_, i) => `<div class="field" style="margin:10px 0">
    <label for="replacement-${channel}-${i}">替换模型 ${i + 1}</label>
    <div style="display:flex;gap:6px;min-width:0">
      <input type="text" readonly id="replacement-${channel}-${i}" data-replacement-pick="${i}" value="${esc(entryLabel(entries[i]))}" placeholder="点击选择模型（可留空）" style="flex:1;min-width:0;cursor:pointer" />
      <button type="button" class="btn btn-small" data-replacement-clear="${i}" aria-label="清空第 ${i + 1} 个模型">清空</button>
      ${i >= 3 ? `<button type="button" class="btn btn-small" data-replacement-remove="${i}" aria-label="删除第 ${i + 1} 个选择框">−</button>` : ''}
    </div></div>`).join('');
}
function progressHtml(c, channel) {
  return `${c.nextIndex ? `已推进到第 ${c.nextIndex} 个位置；` : ''}${c.lastModel ? `最近切换：${esc(c.lastModel)}${c.lastSwitchAt ? `（${esc(new Date(c.lastSwitchAt).toLocaleString())}）` : ''}。` : ''}重新启用或修改列表、顺序并单独保存后，从第一个有效选择开始。未修改直接保存不会重置进度。${channel === 'chat' ? '' : '请选择支持本用途的模型；专用服务需先保存对应凭据。TTS 使用目标服务已保存或默认的音色。'}`;
}
function hasUnsavedModelReplacement() {
  return Object.values(state.modelReplacementDirty || {}).some(Boolean)
    || Object.values(state.modelReplacementSaving || {}).some(Boolean)
    || Object.values(state.modelReplacementTriggerDirty || {}).some(Boolean)
    || state.modelReplacementTriggerSaving;
}
function chainNote(channel, message) {
  const el = document.querySelector(`[data-replacement-status="${channel}"]`);
  if (el) el.textContent = message;
}
function dirty(channel) {
  state.modelReplacementDirty[channel] = true;
  chainNote(channel, '此链有未保存改动，请使用本链的保存按钮。');
}
function rerenderRows(channel) {
  const el = document.querySelector(`[data-replacement-rows="${channel}"]`);
  if (el) el.innerHTML = rowsHtml(channel);
  dirty(channel);
}
function acceptChain(channel, chain, draft, ownSave = false) {
  // A full settings render may have happened while the request was in flight.
  // Never replace a newer form or touch another queue/general settings draft.
  if (state.modelReplacementDraft[channel] !== draft) return false;
  const rules = state.modelReplacementTriggerDraft[channel];
  if (!state.modelReplacementTriggerDirty[channel]) {
    state.modelReplacementTriggerDraft[channel] = { triggers: triggerDefaults(chain.triggers), revision: chain.revision };
  } else if (ownSave && rules.revision === draft.revision) {
    // Our list-only save does not change rules. Preserve its dirty rule draft.
    rules.revision = chain.revision;
  }
  refreshTriggerControls();
  state.config.modelReplacement ||= {};
  state.config.modelReplacement[channel] = structuredClone(chain);
  state.modelReplacementDraft[channel] = structuredClone(chain);
  state.modelReplacementDirty[channel] = false;
  const enabled = $(`#replacement-${channel}-enabled`);
  if (enabled) enabled.checked = chain.enabled;
  const rows = document.querySelector(`[data-replacement-rows="${channel}"]`);
  if (rows) rows.innerHTML = rowsHtml(channel);
  const progress = document.querySelector(`[data-replacement-progress="${channel}"]`);
  if (progress) progress.innerHTML = progressHtml(chain, channel);
  return true;
}
async function writeOrReloadChain(channel, reload = false) {
  if (state.modelReplacementSaving[channel] || state.modelReplacementTriggerSaving) return;
  const draft = state.modelReplacementDraft[channel];
  if (reload && state.modelReplacementDirty[channel]
    && !await askForConfirmation('重新读取只会丢弃此链尚未保存的改动，其他设置和链不受影响。确定继续？')) return;
  if (state.modelReplacementSaving[channel] || state.modelReplacementDraft[channel] !== draft) return;
  const fields = document.querySelector(`[data-replacement-fields="${channel}"]`);
  state.modelReplacementSaving[channel] = true;
  refreshTriggerControls();
  if (fields) fields.disabled = true;
  chainNote(channel, reload ? '正在读取此链…' : '正在保存此链…');
  try {
    const data = reload ? await api('/api/config') : await api('/api/model-replacement', {
      method: 'POST', body: JSON.stringify({ channel, enabled: draft.enabled, entries: draft.entries, revision: draft.revision })
    });
    const chain = reload ? data.modelReplacement[channel] : data.chain;
    if (acceptChain(channel, chain, draft, !reload)) chainNote(channel, reload ? '已重新读取此链。' : '此链已保存 ✓，其他链和普通设置不受影响。');
  } catch (error) {
    if (state.modelReplacementDraft[channel] === draft) chainNote(channel,
      error.code === 'REPLACEMENT_CONFLICT'
        ? '此链已在后台推进或被其他页面修改，本次未保存。请先记录本链改动，点击“重新读取此链”后核对；其他链草稿保留。'
        : `此链${reload ? '读取' : '保存'}失败：${error.message}`);
  } finally {
    state.modelReplacementSaving[channel] = false;
    refreshTriggerControls();
    if (fields) fields.disabled = false;
  }
}

// One rule editor, four independent drafts. Its save never includes model rows.
function triggerEditorHtml() {
  return `<section id="replacement-trigger-editor" style="margin-top:16px">
    <h4>自动替换触发条件</h4>
    <fieldset id="replacement-trigger-fields" style="border:0;padding:0;margin:0;min-width:0">
      <div class="field"><label for="replacement-trigger-channel">选择链路</label>
        <select id="replacement-trigger-channel">${channels.map(([key, label]) => `<option value="${key}" ${state.modelReplacementTriggerChannel === key ? 'selected' : ''}>${label}</option>`).join('')}</select>
      </div>
      ${triggerOptions.map(([key, label]) => `<div class="checkbox-row"><input type="checkbox" id="replacement-trigger-${key}" data-replacement-trigger="${key}" /><label for="replacement-trigger-${key}">${label}</label></div>`).join('')}
      <div class="hint">普通限流、超时和服务端异常不推进链。429 只认明确额度耗尽的结构化错误码，不猜测错误文字。403 不一定是额度耗尽，也可能是权限或访问限制。全部取消后，该链不会自动推进。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button type="button" class="btn btn-primary" id="replacement-trigger-save">保存此链触发条件</button>
        <button type="button" class="btn btn-small" id="replacement-trigger-reload">重新读取触发条件</button>
      </div>
    </fieldset>
    <div id="replacement-trigger-status" class="hint" role="status" aria-live="polite"></div>
  </section>`;
}
function triggerNote(message) {
  const note = $('#replacement-trigger-status');
  if (note) note.textContent = message;
}
function refreshTriggerControls() {
  const channel = state.modelReplacementTriggerChannel;
  const draft = state.modelReplacementTriggerDraft[channel];
  if (!draft || !$('#replacement-trigger-fields')) return;
  $('#replacement-trigger-fields').disabled = state.modelReplacementTriggerSaving || Boolean(state.modelReplacementSaving[channel]);
  for (const [key] of triggerOptions) $(`#replacement-trigger-${key}`).checked = draft.triggers[key];
}
async function writeOrReloadTriggers(reload = false) {
  const channel = state.modelReplacementTriggerChannel;
  const draft = state.modelReplacementTriggerDraft[channel];
  if (state.modelReplacementTriggerSaving || state.modelReplacementSaving[channel]) return;
  if (reload && state.modelReplacementTriggerDirty[channel]
    && !await askForConfirmation('只丢弃此链未保存的触发条件；模型列表和其他草稿不受影响。确定重新读取？')) return;
  if (state.modelReplacementTriggerSaving || state.modelReplacementSaving[channel]
    || state.modelReplacementTriggerDraft[channel] !== draft || state.modelReplacementTriggerChannel !== channel) return;
  state.modelReplacementTriggerSaving = true;
  refreshTriggerControls();
  const fields = document.querySelector(`[data-replacement-fields="${channel}"]`);
  if (fields) fields.disabled = true;
  triggerNote(reload ? '正在读取触发条件…' : '正在保存触发条件…');
  try {
    const data = reload ? await api('/api/config') : await api('/api/model-replacement', {
      method: 'POST', body: JSON.stringify({ channel, triggers: draft.triggers, revision: draft.revision })
    });
    if (state.modelReplacementTriggerDraft[channel] !== draft) return;
    const chain = reload ? data.modelReplacement[channel] : data.chain;
    const queueDraft = state.modelReplacementDraft[channel];
    if (!reload && queueDraft.revision === draft.revision) queueDraft.revision = chain.revision;
    state.config.modelReplacement[channel] = structuredClone(chain);
    state.modelReplacementTriggerDraft[channel] = { triggers: triggerDefaults(chain.triggers), revision: chain.revision };
    state.modelReplacementTriggerDirty[channel] = false;
    if (!state.modelReplacementDirty[channel]) acceptChain(channel, chain, queueDraft);
    triggerNote(reload ? '已重新读取此链触发条件。' : '触发条件已保存 ✓，模型列表、进度和其他设置不受影响。');
  } catch (error) {
    if (state.modelReplacementTriggerDraft[channel] === draft) triggerNote(error.code === 'REPLACEMENT_CONFLICT'
      ? '此链已在后台变化，本次未保存。草稿已保留，请重新读取触发条件后核对。'
      : `触发条件${reload ? '读取' : '保存'}失败：${error.message}`);
  } finally {
    state.modelReplacementTriggerSaving = false;
    if (fields) fields.disabled = false;
    refreshTriggerControls();
  }
}
function bindTriggerControls() {
  $('#replacement-trigger-channel').addEventListener('change', (event) => {
    state.modelReplacementTriggerChannel = event.target.value;
    refreshTriggerControls();
    triggerNote(state.modelReplacementTriggerDirty[event.target.value] ? '此链触发条件有未保存改动。' : '');
  });
  for (const [key] of triggerOptions) $(`#replacement-trigger-${key}`).addEventListener('change', (event) => {
    const channel = state.modelReplacementTriggerChannel;
    state.modelReplacementTriggerDraft[channel].triggers[key] = event.target.checked;
    state.modelReplacementTriggerDirty[channel] = true;
    triggerNote('此链触发条件有未保存改动，请使用本模块的保存按钮。');
  });
  $('#replacement-trigger-save').addEventListener('click', () => { void writeOrReloadTriggers(); });
  $('#replacement-trigger-reload').addEventListener('click', () => { void writeOrReloadTriggers(true); });
  refreshTriggerControls();
}

async function pickModel(channel, index) {
  const hint = $('#model-replacement-hint');
  let overlay;
  try {
    const catalog = await api('/api/model-replacement/catalog');
    const groups = (catalog[channel] || []).filter((g) => g.models?.length);
    if (!groups.length) throw new Error('还没有可选模型，请先在模型 API 中添加模型。');
    const selected = state.modelReplacementDraft[channel].entries[index];
    let active = groups.find((g) => g.models.some((m) => entryId(m) === entryId(selected)))?.id || groups[0].id;
    overlay = modelModalShell({
      head: `选择${channels.find(([key]) => key === channel)[1]}替换模型`,
      body: '<div class="model-modal-left" id="replacement-picker-left"></div><div class="model-modal-right" id="replacement-picker-right"></div>',
      foot: '<button type="button" class="btn" id="replacement-picker-cancel">取消</button>'
    });
    const left = overlay.querySelector('#replacement-picker-left');
    const right = overlay.querySelector('#replacement-picker-right');
    function renderPicker() {
      left.innerHTML = groups.map((g, i) => `<div class="mm-prov ${g.id === active ? 'active' : ''}" data-replacement-group="${i}" role="button" tabindex="0">${esc(g.label)}</div>`).join('');
      left.querySelectorAll('[data-replacement-group]').forEach((el) => {
        const select = () => { active = groups[Number(el.dataset.replacementGroup)].id; renderPicker(); };
        el.addEventListener('click', select);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
      });
      const group = groups.find((g) => g.id === active);
      right.innerHTML = group.models.map((m, i) => `<div class="mm-model" data-replacement-model="${i}" role="button" tabindex="0"><span class="mm-check">${entryId(m) === entryId(selected) ? '✓' : ''}</span><span>${esc(m.label || m.model)}</span><span class="muted">${esc(m.model)}</span></div>`).join('');
      right.querySelectorAll('[data-replacement-model]').forEach((el) => {
        const select = () => {
          const m = group.models[Number(el.dataset.replacementModel)];
          const entries = state.modelReplacementDraft[channel].entries;
          while (entries.length <= index) entries.push(null);
          entries[index] = { source: m.source, providerId: m.providerId, model: m.model };
          closeModelModal(overlay);
          rerenderRows(channel);
        };
        el.addEventListener('click', select);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
      });
    }
    renderPicker();
    overlay.querySelector('#replacement-picker-cancel').addEventListener('click', () => { closeModelModal(overlay); });
  } catch (error) {
    if (hint) hint.textContent = `选择失败：${error.message}`;
    if (overlay) closeModelModal(overlay);
  }
}

function bindModelReplacementControls() {
  const root = $('#model-replacement-editor');
  if (!root) return;
  bindTriggerControls();
  for (const [channel] of channels) {
    $(`#replacement-${channel}-enabled`).addEventListener('change', (e) => {
      state.modelReplacementDraft[channel].enabled = e.target.checked;
      dirty(channel);
    });
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-replacement-pick], [data-replacement-clear], [data-replacement-add], [data-replacement-remove], [data-replacement-save], [data-replacement-reload]');
    if (!button) return;
    const channel = button.closest('[data-replacement-channel]').dataset.replacementChannel;
    if (state.modelReplacementSaving[channel] || state.modelReplacementTriggerSaving) return;
    if (button.hasAttribute('data-replacement-save')) { void writeOrReloadChain(channel); return; }
    if (button.hasAttribute('data-replacement-reload')) { void writeOrReloadChain(channel, true); return; }
    const entries = state.modelReplacementDraft[channel].entries;
    if (button.hasAttribute('data-replacement-pick')) void pickModel(channel, Number(button.dataset.replacementPick));
    else if (button.hasAttribute('data-replacement-clear')) { entries[Number(button.dataset.replacementClear)] = null; rerenderRows(channel); }
    else if (button.hasAttribute('data-replacement-remove')) { entries.splice(Number(button.dataset.replacementRemove), 1); rerenderRows(channel); }
    else if (entries.length < 64) { while (entries.length < 3) entries.push(null); entries.push(null); rerenderRows(channel); }
    else $('#model-replacement-hint').textContent = '每条链最多 64 个选择框。';
  });
}

// Reuse the existing status refresh, not another timer. Never discard a dirty
// form to display automatic progress; a stale save is rejected by the server.
async function syncModelReplacementStatus(status) {
  if (!state.config?.modelReplacement || !status.modelReplacement) return;
  const changed = channels.some(([key]) => (state.config.modelReplacement[key]?.revision || 0) !== status.modelReplacement[key]?.revision);
  if (!changed) return;
  if (state.settingsDirty || hasUnsavedModelReplacement()) {
    const hint = $('#model-replacement-hint');
    if (hint) hint.textContent = '替换链已在后台变化，未覆盖当前草稿。各链可用“重新读取此链”核对；普通设置的保存不会重置替换链。';
    return;
  }
  if (state.tab === 'settings' && state.settingsSection === 'api' && !document.querySelector('.model-modal-overlay')) await loadSettings();
}

export { renderModelReplacementSection, bindModelReplacementControls, hasUnsavedModelReplacement, syncModelReplacementStatus };
