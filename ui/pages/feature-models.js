// 后台任务模型路由：每项独立保存，主聊天模型不受影响。
import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { state } from '../core/state.js';

const FEATURES = [
  ['living-memory', '长期记忆提炼', '把对话提炼成长期记忆卡片'],
  ['memory-consolidation', '旧版记忆整理', '会话结束后的记忆整理（未启用时跟随记忆设置/主模型）'],
  ['group-digest', '群日报', '每天汇总群聊并发布'],
  ['admin-briefing', '管理员早报', '每天私聊管理员讲群里的见闻'],
  ['daily-moments', '每日动态（说说）', '生成并发布 QQ 空间说说'],
  ['qzone-interactions', '空间互动', '浏览好友动态并写评论/点赞']
];

function providers(config) {
  return Array.isArray(state.providers) && state.providers.length
    ? state.providers
    : (Array.isArray(config?.providers) ? config.providers : []);
}

function modelId(item) {
  return typeof item === 'string' ? item : item?.id;
}

function providerOptions(list, selected) {
  return `<option value="">跟随主模型</option>${list.map((provider) =>
    `<option value="${esc(provider.id)}" ${provider.id === selected ? 'selected' : ''}>${esc(provider.displayName || provider.id)}</option>`).join('')}`;
}

function modelOptions(list, providerId, selected) {
  const provider = list.find((item) => item.id === providerId);
  const models = (provider?.models || []).map(modelId).filter(Boolean);
  if (selected && !models.includes(selected)) models.push(selected);
  if (!models.length) return '<option value="">先选择提供商</option>';
  return `<option value="">选择模型</option>${models.map((model) =>
    `<option value="${esc(model)}" ${model === selected ? 'selected' : ''}>${esc(provider?.modelNames?.[model] || model)}</option>`).join('')}`;
}

function rowHtml(config, key, label, hint) {
  const entry = config?.featureModels?.[key] || {};
  const list = providers(config);
  return `<div class="field" data-feature-row="${key}" style="margin:12px 0;padding-top:10px;border-top:1px solid var(--line, rgba(127,127,127,.18))">
    <div class="checkbox-row"><input type="checkbox" id="feature-${key}-enabled" data-feature-enabled ${entry.enabled === true ? 'checked' : ''} />
      <label for="feature-${key}-enabled">${esc(label)}</label></div>
    <div class="hint">${esc(hint)}。关闭时跟随主模型。</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
      <select data-feature-provider aria-label="${esc(label)}提供商" style="min-width:140px">${providerOptions(list, entry.providerId || '')}</select>
      <select data-feature-model aria-label="${esc(label)}模型" style="min-width:180px;flex:1">${modelOptions(list, entry.providerId || '', entry.model || '')}</select>
      <button type="button" class="btn btn-small" data-feature-save>保存</button>
    </div>
    <div class="hint" data-feature-status role="status"></div>
  </div>`;
}

function renderFeatureModelsSection(config) {
  state.featureModelDirty = {};
  return `<h3 id="settings-feature-models" style="margin-top:22px">后台任务模型</h3>
    <div class="hint">记忆提炼、群日报、早报、每日动态和空间互动可以各自使用更便宜的模型；主聊天模型、替换链和兜底模型都不受影响。每项需要点自己的「保存」，底部「保存设置」不会保存本区；未启用的任务继续跟随主模型。跨服务商时不会继承主渠道的额外请求参数。</div>
    <div id="feature-models-editor">${FEATURES.map(([key, label, hint]) => rowHtml(config, key, label, hint)).join('')}</div>`;
}

function featureRowStatus(row, message, kind = '') {
  const status = row?.querySelector('[data-feature-status]');
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function syncModelSelect(row, config, reset = false) {
  const list = providers(config);
  const providerId = row.querySelector('[data-feature-provider]')?.value || '';
  const select = row.querySelector('[data-feature-model]');
  if (!select) return;
  const current = reset ? '' : select.value;
  select.innerHTML = modelOptions(list, providerId, current);
}

async function saveRow(row, key) {
  const button = row.querySelector('[data-feature-save]');
  const enabled = row.querySelector('[data-feature-enabled]')?.checked === true;
  const providerId = row.querySelector('[data-feature-provider]')?.value || '';
  const model = row.querySelector('[data-feature-model]')?.value || '';
  if (enabled && (!providerId || !model)) {
    featureRowStatus(row, '启用前请选择提供商和模型。', 'error');
    return;
  }
  button.disabled = true;
  featureRowStatus(row, '正在保存…');
  try {
    const data = await api('/api/feature-models', {
      method: 'POST',
      body: JSON.stringify({ feature: key, enabled, providerId, model })
    });
    state.config.featureModels ||= {};
    state.config.featureModels[key] = { enabled, providerId, model };
    state.featureModelDirty ||= {};
    state.featureModelDirty[key] = false;
    featureRowStatus(row, enabled ? `已保存并启用：${data.status?.model || model}` : '已保存：跟随主模型。', 'ok');
  } catch (error) {
    featureRowStatus(row, `保存失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshFeatureReadiness() {
  let data;
  try { data = await api('/api/feature-models'); } catch { return; }
  const features = data?.features || {};
  for (const [key] of FEATURES) {
    if (state.featureModelDirty?.[key]) continue;
    const row = document.querySelector(`[data-feature-row="${key}"]`);
    if (!row) continue;
    const status = features[key] || {};
    if (status.enabled !== true) { featureRowStatus(row, '跟随主模型。'); continue; }
    if (!status.ready) {
      featureRowStatus(row, `配置不可用：${status.reason || '未知原因'}；运行时会跟随主模型。`, 'error');
    } else if (status.catalogMissing) {
      featureRowStatus(row, '配置可用，但模型已不在当前提供商的模型目录里；建议重新选择。', 'error');
    } else {
      featureRowStatus(row, '配置可用。', 'ok');
    }
  }
}

function bindFeatureModelControls() {
  const root = document.querySelector('#feature-models-editor');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  void refreshFeatureReadiness();
  root.addEventListener('change', (event) => {
    const row = event.target.closest('[data-feature-row]');
    if (!row) return;
    if (event.target.matches('[data-feature-provider]')) {
      // 换提供商必须重选模型：旧模型 id 只属于上一家，不能跟着提交。
      syncModelSelect(row, state.config, true);
      state.featureModelDirty ||= {}; state.featureModelDirty[row.dataset.featureRow] = true;
      featureRowStatus(row, '提供商已修改，请重新选择模型后点本行「保存」。');
    } else if (event.target.matches('[data-feature-enabled], [data-feature-model]')) {
      state.featureModelDirty[row.dataset.featureRow] = true;
      featureRowStatus(row, '有未保存改动，点本行的「保存」。');
    }
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-feature-save]');
    if (!button) return;
    const row = button.closest('[data-feature-row]');
    if (row) void saveRow(row, row.dataset.featureRow);
  });
}

export { renderFeatureModelsSection, bindFeatureModelControls };
