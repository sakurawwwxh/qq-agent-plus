'use strict';

// 关系状态 V1：只在“设置 → 实验功能”里出现。V1 永远是 Shadow Mode：
// 可以评估并记录，但绝不改变主聊天 prompt / 回复策略。

import { api } from './core/api.js';
import { esc } from './core/dom.js';
(function relationshipPilotSettings() {
  let rendering = false;
  let timer = null;
  let refreshTimer = null;
  let saveQueue = Promise.resolve();
  let saveVersion = 0;


  const clamp = (value, min, max, fallback) => Math.min(
    max,
    Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback)
  );

  const pct = (value, signed = false) => {
    const n = Number(value) || 0;
    const scaled = Math.round(n * 100);
    return signed && scaled > 0 ? `+${scaled}` : String(scaled);
  };


  function settingsOf(config = {}) {
    const raw = config.relationshipPilot || {};
    return {
      enabled: raw.enabled === true,
      minNewMessages: Math.round(clamp(raw.minNewMessages, 4, 50, 8)),
      minBatchMessages: Math.round(clamp(raw.minBatchMessages, 2, 20, 3)),
      minBatchAgeMinutes: Math.round(clamp(raw.minBatchAgeMinutes, 30, 1440, 360)),
      maxEvaluationsPerDay: Math.round(clamp(raw.maxEvaluationsPerDay, 1, 200, 20)),
      frictionHalfLifeHours: clamp(raw.frictionHalfLifeHours, 6, 720, 48)
    };
  }

  function statusText(config, status) {
    const settings = settingsOf(config);
    if (!config?.identityPilot?.enabled) return '依赖“人物统一印象”；请先启用人物实验';
    if (!settings.enabled) return '已停用 · 不建关系库、不增加模型调用';
    const rel = status?.relationshipPilot || {};
    if (!rel.active) return `已启用 · Shadow Mode · ${rel.error ? `启动异常：${rel.error}` : '等待人物库启动'}`;
    const counts = rel.counts || {};
    const queue = Number(rel.queuedEvaluations) + Number(rel.runningEvaluations);
    return `Shadow Mode · 人物 ${Number(counts.states) || 0} · 事件 ${Number(counts.events) || 0} · 未解决边界 ${Number(counts.openFlags) || 0}${queue ? ` · 队列 ${queue}` : ''}`;
  }

  function renderPreview(row, people = []) {
    const box = row.querySelector('#relationship-shadow-preview');
    if (!box) return;
    const withState = (Array.isArray(people) ? people : [])
      .filter((person) => person?.relationship)
      .sort((a, b) => Number(b.relationship?.updatedAt) - Number(a.relationship?.updatedAt))
      .slice(0, 8);
    if (!withState.length) {
      box.innerHTML = '<div class="muted" style="margin-top:8px">尚无关系状态；产生足够的新互动后才会进行影子评估。</div>';
      return;
    }
    box.innerHTML = `<div class="table-wrap" style="margin-top:8px"><table class="usage-table">
      <thead><tr><th>人物</th><th>熟悉</th><th>亲近倾向</th><th>近期摩擦</th><th>最近事件</th></tr></thead>
      <tbody>${withState.map((person) => {
        const rel = person.relationship || {};
        const event = rel.recentEvents?.[0];
        const who = person.primaryName || person.userId;
        const eventText = event
          ? `${event.type} ${pct(event.deltaAffinity, true)} / ${pct(event.deltaFriction, true)}`
          : '—';
        return `<tr>
          <td><strong>${esc(who)}</strong><small><code>${esc(person.userId)}</code></small></td>
          <td>${pct(rel.familiarity)}</td>
          <td>${pct(rel.affinity, true)}</td>
          <td>${pct(rel.friction)}</td>
          <td title="${esc(event?.summary || '')}">${esc(eventText)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }

  function fill(row, config, status = null, people = []) {
    const settings = settingsOf(config);
    const enabled = row.querySelector('#cfg-relationship-pilot-enabled');
    if (enabled) {
      enabled.checked = settings.enabled;
      enabled.disabled = config?.identityPilot?.enabled !== true;
    }
    const fields = {
      '#cfg-relationship-min-new': settings.minNewMessages,
      '#cfg-relationship-min-batch': settings.minBatchMessages,
      '#cfg-relationship-batch-age': settings.minBatchAgeMinutes,
      '#cfg-relationship-daily-budget': settings.maxEvaluationsPerDay,
      '#cfg-relationship-friction-half-life': settings.frictionHalfLifeHours
    };
    // 15 秒轮询不能覆盖用户正在编辑但还没保存的值：整行有焦点时只刷新状态/预览，不动输入框。
    const editing = row.contains(document.activeElement)
      && document.activeElement?.matches('input, textarea, select');
    for (const [selector, value] of Object.entries(fields)) {
      const input = row.querySelector(selector);
      if (input) {
        if (!editing) input.value = String(value);
        input.disabled = config?.identityPilot?.enabled !== true;
      }
    }
    const state = row.querySelector('#experiment-relationship-state');
    if (state) state.textContent = statusText(config, status);
    renderPreview(row, settings.enabled ? people : []);
  }

  async function readState(row) {
    const config = await api('/api/config');
    const [status, peopleResult] = await Promise.all([
      api('/api/identity-pilot/status').catch(() => ({})),
      config?.identityPilot?.enabled && config?.relationshipPilot?.enabled
        ? api('/api/identity-pilot/people?limit=12').catch(() => ({ people: [] }))
        : Promise.resolve({ people: [] })
    ]);
    if (document.body.contains(row)) fill(row, config, status, peopleResult.people || []);
    return { config, status, people: peopleResult.people || [] };
  }

  function draftOf(row) {
    return {
      enabled: row.querySelector('#cfg-relationship-pilot-enabled')?.checked === true,
      minNewMessages: Math.round(clamp(row.querySelector('#cfg-relationship-min-new')?.value, 4, 50, 8)),
      minBatchMessages: Math.round(clamp(row.querySelector('#cfg-relationship-min-batch')?.value, 2, 20, 3)),
      minBatchAgeMinutes: Math.round(clamp(row.querySelector('#cfg-relationship-batch-age')?.value, 30, 1440, 360)),
      maxEvaluationsPerDay: Math.round(clamp(row.querySelector('#cfg-relationship-daily-budget')?.value, 1, 200, 20)),
      frictionHalfLifeHours: clamp(row.querySelector('#cfg-relationship-friction-half-life')?.value, 6, 720, 48)
    };
  }

  async function persistDraft(row, draft, version) {
    const state = row.querySelector('#experiment-relationship-state');
    if (state && version === saveVersion) state.textContent = '保存中…';
    try {
      // 这里只读取配置，不调用 readState()/fill()：保存前刷新 UI 会把用户刚修改的
      // checkbox/value 用旧配置覆盖，导致“勾上 → 保存中 → 自动关闭”。
      const config = await api('/api/config');
      if (config?.identityPilot?.enabled !== true) {
        if (version === saveVersion && document.body.contains(row)) fill(row, config, null, []);
        return;
      }
      const patch = {
        relationshipPilot: {
          ...(config.relationshipPilot || {}),
          ...draft
        }
      };
      await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      // relationshipPilot 是独立配置；后端 status/observe 钩子会按最新配置即时同步启停。
      if (version === saveVersion) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await readState(row);
      }
    } catch (error) {
      if (state && version === saveVersion) state.textContent = `保存失败：${error?.message || error}`;
    }
  }

  function save(row) {
    // 必须在任何 await / 配置刷新之前同步快照用户输入。
    const draft = draftOf(row);
    const version = ++saveVersion;
    // 串行保存，避免快速连续修改时较慢的旧请求最后落盘覆盖新请求。
    saveQueue = saveQueue.then(
      () => persistDraft(row, draft, version),
      () => persistDraft(row, draft, version)
    );
    return saveQueue;
  }

  async function ensureRow() {
    if (rendering || document.getElementById('experiment-relationship-row')) return;
    const heading = document.getElementById('settings-experiments');
    const section = heading?.closest('.experimental-settings');
    const list = section?.querySelector('.control-key-list');
    if (!list) return;
    rendering = true;
    try {
      const row = document.createElement('div');
      row.className = 'control-key-row';
      row.id = 'experiment-relationship-row';
      row.innerHTML = `
        <span style="min-width:300px;flex:1">
          <strong>关系状态 / 好感度</strong>
          <small id="experiment-relationship-state">读取中…</small>
          <small>V1 固定 Shadow Mode：只记录 familiarity / affinity / friction 与事件账本，不影响聊天回复。数值仅用于实验观察。</small>
          <details style="margin-top:6px">
            <summary class="muted" style="cursor:pointer">评估参数</summary>
            <div class="field-row" style="margin-top:8px">
              <label class="field"><span>直接触发条数</span><input id="cfg-relationship-min-new" type="number" min="4" max="50" /></label>
              <label class="field"><span>低频最少条数</span><input id="cfg-relationship-min-batch" type="number" min="2" max="20" /></label>
              <label class="field"><span>低频间隔 / 分钟</span><input id="cfg-relationship-batch-age" type="number" min="30" max="1440" /></label>
              <label class="field"><span>每日评估上限</span><input id="cfg-relationship-daily-budget" type="number" min="1" max="200" /></label>
              <label class="field"><span>摩擦半衰期 / 小时</span><input id="cfg-relationship-friction-half-life" type="number" min="6" max="720" /></label>
            </div>
          </details>
          <details style="margin-top:6px">
            <summary class="muted" style="cursor:pointer">观察样本（最近更新）</summary>
            <div id="relationship-shadow-preview"></div>
          </details>
        </span>
        <span class="settings-actions" style="margin:0;align-items:center">
          <span class="muted">Shadow</span>
          <label class="checkbox-row" style="margin:0">
            <input type="checkbox" id="cfg-relationship-pilot-enabled" />
            <span>启用</span>
          </label>
        </span>`;
      list.appendChild(row);
      await readState(row);
      row.querySelector('#cfg-relationship-pilot-enabled')?.addEventListener('change', () => save(row));
      row.querySelectorAll('input[type="number"]').forEach((input) => {
        input.addEventListener('change', () => save(row));
      });
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        if (document.body.contains(row)) readState(row).catch(() => {});
      }, 15000);
    } catch {
      // 实验增强失败不能影响设置页主体。
    } finally {
      rendering = false;
    }
  }

  function scheduleEnsure() {
    clearTimeout(timer);
    timer = setTimeout(() => ensureRow().catch(() => {}), 20);
  }

  const observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scheduleEnsure, { once: true });
  scheduleEnsure();
})();