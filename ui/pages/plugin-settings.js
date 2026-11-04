// 插件详情页的「插件设置」面板（v2/v2.1）：按 manifest.settings 渲染表单、凭据（加密）
// 写动作开关、待批请求与写审计。从 plugins.js 拆出来只为别让那个文件突破行数上限。
import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { pendingTargetHref } from './plugin-pending.js';

function hasPluginSettings(own) {
  const m = own?.manifest;
  if (!m || !own?.installed) return false;
  return Boolean(m.settings?.groups?.length || m.approvals?.length);
}

function settingsFieldHtml(field, values, secrets) {
  const value = values?.[field.key];
  if (field.type === 'boolean') {
    return `<label class="pd-field pd-field-check"><input type="checkbox" data-pd-field="${esc(field.key)}" data-pd-type="boolean"${value === true ? ' checked' : ''} /><span>${esc(field.label)}</span>${field.help ? `<small>${esc(field.help)}</small>` : ''}</label>`;
  }
  if (field.type === 'select') {
    const options = (field.options || []).map((option) => `<option value="${esc(option.value)}"${String(value) === option.value ? ' selected' : ''}>${esc(option.label)}</option>`).join('');
    return `<label class="pd-field"><span>${esc(field.label)}</span><select data-pd-field="${esc(field.key)}" data-pd-type="select">${options}</select>${field.help ? `<small>${esc(field.help)}</small>` : ''}</label>`;
  }
  if (field.type === 'secret') {
    const configured = secrets?.configured?.[field.key] === true;
    return `<label class="pd-field"><span>${esc(field.label)}${configured ? '<em class="pd-secret-on">已配置</em><button type="button" class="pd-secret-clear" data-pd-secret-clear="${esc(field.key)}">清除</button>' : ''}</span><input type="password" autocomplete="new-password" data-pd-field="${esc(field.key)}" data-pd-type="secret" data-pd-secret="1" placeholder="${configured ? '留空则不修改' : '未配置'}" />${field.help ? `<small>${esc(field.help)}</small>` : ''}</label>`;
  }
  const type = field.type === 'number' ? 'number' : 'text';
  const attrs = field.type === 'number'
    ? `${field.min !== undefined ? ` min="${esc(String(field.min))}"` : ''}${field.max !== undefined ? ` max="${esc(String(field.max))}"` : ''}`
    : '';
  return `<label class="pd-field"><span>${esc(field.label)}</span><input type="${type}"${attrs} value="${esc(value === undefined || value === null ? '' : String(value))}" placeholder="${esc(field.placeholder || '')}" data-pd-field="${esc(field.key)}" data-pd-type="${esc(field.type || 'text')}" />${field.help ? `<small>${esc(field.help)}</small>` : ''}</label>`;
}

function settingsFormHtml(data) {
  const groups = data.schema?.groups || [];
  // 常驻登录徽标：打开面板就能看到“当前登录是谁”，不用点检测按钮
  const login = data.loginInfo || null;
  const loginBadge = login
    ? `<div class="pd-login-badge${login.login ? ' is-on' : ''}">当前登录：${login.login
      ? `${esc(String(login.uname || '已登录'))}（${new Date(Number(login.measuredAt) || Date.now()).toLocaleTimeString()} 实测有效）`
      : esc(String(login.note || '未登录'))}</div>`
    : '';
  // 解密失败必须当错误喊出来：显示成"未配置"会诱导用户重填，而真正的问题是密钥文件坏了
  const secretError = data.secrets?.ok === false && data.secrets?.error
    ? `<div class="plugin-warn bad">凭据无法解密：${esc(String(data.secrets.error))}。恢复 data/plugin-secrets/.key 或删除该插件的凭据文件后重新配置。</div>`
    : '';
  const groupsHtml = groups.map((group) => `
    <div class="pd-settings-group">
      <div class="pd-settings-group-title">${esc(group.title)}</div>
      ${group.description ? `<div class="plugin-note">${esc(group.description)}</div>` : ''}
      ${(group.fields || []).map((field) => settingsFieldHtml(field, data.values, data.secrets)).join('')}
    </div>`).join('');
  const approvals = data.approvals || [];
  const grants = data.grants?.approvals || {};
  const quota = data.grants?.quota || {};
  const switches = data.switches || {};
  // 写动作：每个动作一个独立开关（默认关，关=模型看不见这个工具）＋ 当前有效批准 ＋ 今日配额
  const approvalHtml = approvals.length ? `
    <div class="pd-settings-group">
      <div class="pd-settings-group-title">写操作</div>
      <div class="plugin-note">每个动作独立开关，默认关：不开，模型根本看不到这个工具。开启后每次执行还要你批准具体目标（批哪条视频就只会动哪条），批准一次只管一次、10 分钟内有效。</div>
      ${approvals.map((item) => {
    const on = switches[item.action] === true;
    const grant = grants[item.action];
    const state = grant && grant.usesLeft > 0
      ? `已批准：剩 ${grant.usesLeft} 次${(grant.targets || []).length ? `（目标：${grant.targets.slice(0, 3).map(esc).join('、')}${grant.targets.length > 3 ? '…' : ''}）` : ''}`
      : '无有效批准';
    const used = quota[item.action] ? `今日 ${quota[item.action].used}/${quota[item.action].limit}` : '';
    return `<div class="pd-approval-row">
          <div class="pd-approval-main"><strong>${esc(item.label)}</strong><span>${esc(item.description || item.action)}</span></div>
          <div class="pd-approval-state${on ? ' is-on' : ''}">${esc(state)}${used ? ` · ${esc(used)}` : ''}</div>
          <div class="pd-approval-actions">
            <label class="pd-switch"><input type="checkbox" data-pd-write-switch="${esc(item.action)}"${on ? ' checked' : ''} /><span>允许使用</span></label>
          </div>
        </div>`;
  }).join('')}
    </div>` : '';
  // 待批请求：模型刚请求过、等你点头的操作（批准的是具体目标，不是类别）
  const pendingList = Array.isArray(data.pending) ? data.pending : [];
  const pendingHtml = pendingList.length ? `
    <div class="pd-settings-group">
      <div class="pd-settings-group-title">待你批准（${pendingList.length}）</div>
      ${pendingList.map((item) => {
        const href = pendingTargetHref(item.target);
        return `
        <div class="pd-approval-row is-pending">
          <div class="pd-approval-main">
            <strong>${esc(item.label || item.action)}</strong>
            <span>目标：${href
              ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(item.target)}</a>`
              : esc(item.target || '(未指明)')}</span>
            <span class="muted">待批编号：${esc(item.id)}</span>
            ${item.preview ? `<span>内容：${esc(item.preview.slice(0, 160))}${Number(item.previewLength) > 160 ? ` …（共 ${Number(item.previewLength)} 字，批准绑定完整正文）` : ''}</span>` : ''}
            ${item.notify?.ok === false ? `<span class="plugin-warn bad">QQ 通知未送达${item.notify.error ? `：${esc(String(item.notify.error).slice(0, 120))}` : ''}；请直接在这里批准。</span>` : ''}
          </div>
          <div class="pd-approval-state">${esc(new Date(Number(item.expiresAt)).toLocaleTimeString())} 前有效</div>
          <div class="pd-approval-actions">
            <button type="button" class="btn btn-small btn-primary" data-pd-approve-pending="${esc(item.id)}" data-pd-decision="approve">批准一次</button>
            <button type="button" class="btn btn-small" data-pd-approve-pending="${esc(item.id)}" data-pd-decision="approve" data-pd-uses="5">批准 5 次</button>
            <button type="button" class="btn btn-small" data-pd-approve-pending="${esc(item.id)}" data-pd-decision="reject">拒绝</button>
          </div>
        </div>`;
      }).join('')}
    </div>` : '';
  // 写审计：这个插件最近干过什么（宿主侧记录，不是插件自报）
  const allWrites = Array.isArray(data.writes) ? data.writes : [];
  const writes = allWrites.slice(0, 10);
  const hiddenWrites = allWrites.length - writes.length;
  // 宿主侧的内部报错话术 → 人话 + 去哪里修
  const noteHint = (item) => {
    const n = String(item.note || '');
    if (/follow 需要 mid/.test(n)) return '关注需要目标 UID：确认参数里带了 UP 主的数字 UID';
    if (/CSRF|csrf/.test(n)) return '登录态失效或不完整：重新扫码登录';
    if (/需要登录/.test(n)) return '未登录：去上面扫码登录';
    if (/至少间隔/.test(n)) return '两次写操作间隔不足 60 秒：稍后再试';
    if (/配额/.test(n)) return '今天这个动作的次数用完了：明天自动恢复';
    if (/没有打开|开关/.test(n)) return '动作开关没开：在「写操作」里打开对应动作';
    return n.slice(0, 80);
  };
  const writesHtml = writes.length ? `
    <div class="pd-settings-group">
      <div class="pd-settings-group-title">最近写操作${hiddenWrites > 0 ? `（共 ${allWrites.length} 条，显示最近 10 条）` : ''}</div>
      ${writes.map((item) => `<div class="pd-write-row">
        <span class="pd-write-at">${esc(new Date(Number(item.at)).toLocaleString())}</span>
        <span class="pd-write-action">${esc(item.action)}${item.target ? ` → ${esc(item.target)}` : ''}</span>
        <span class="pd-write-outcome is-${esc(item.outcome)}">${esc({ ok: '成功', failed: '失败(已退额度)', denied: '被拒', pending: '待批', unknown: '结果未确认' }[item.outcome] || item.outcome)}</span>
        ${item.note ? `<span class="pd-write-note">${esc(noteHint(item))}</span>` : ''}
      </div>`).join('')}
    </div>` : '';
  if (!groupsHtml && !approvalHtml && !pendingHtml && !writesHtml) {
    return '<div class="plugin-note">这个插件没有需要填写的设置。</div>';
  }
  return `${secretError}${loginBadge}${groupsHtml}${pendingHtml}${approvalHtml}${writesHtml}
    <div class="pd-settings-actions">
      <button type="button" class="btn btn-primary btn-small" data-pd-settings-save="${esc(data.id)}">保存设置</button>
      <button type="button" class="btn btn-small" data-pd-probe="${esc(data.id)}">检测登录</button>
      <button type="button" class="btn btn-small" data-pd-qr-login="${esc(data.id)}">扫码登录</button>
      <span class="pd-settings-status" data-pd-settings-status></span>
    </div>`;
}

async function hydratePluginSettings(id) {
  const block = Array.from(document.querySelectorAll('[data-pd-settings]'))
    .find((node) => node.getAttribute('data-pd-settings') === id);
  const body = block?.querySelector('.pd-settings-body');
  if (!body) return;
  try {
    // 非保存类的刷新（切写开关、批待批、扫码成功）也会重建整块表单：
    // 先把用户正在填、还没保存的值记下来，重建后放回去 —— 否则输了一半的 Cookie 会突然消失。
    const draft = snapshotFields(body);
    const data = await api(`/api/plugins/settings?id=${encodeURIComponent(id)}`);
    if (!body.isConnected) return;
    body.innerHTML = settingsFormHtml(data);
    restoreFields(body, draft);
  } catch (error) {
    body.innerHTML = `<div class="plugin-warn bad">设置读取失败：${esc(String(error?.message || error))}</div>`;
  }
}

function snapshotFields(body) {
  const out = new Map();
  for (const el of body.querySelectorAll('[data-pd-field]')) {
    out.set(el.getAttribute('data-pd-field'), {
      type: el.getAttribute('data-pd-type'),
      value: el.value,
      checked: Boolean(el.checked)
    });
  }
  return out;
}

/** 重建表单后恢复未保存的草稿值。secret 输入框不恢复（避免把明文重新塞回页面）。 */
function restoreFields(body, draft) {
  if (!draft?.size) return;
  for (const el of body.querySelectorAll('[data-pd-field]')) {
    const saved = draft.get(el.getAttribute('data-pd-field'));
    if (!saved) continue;
    if (saved.type === 'boolean') el.checked = saved.checked;
    else if (saved.type === 'select') el.value = saved.value;
    else if (saved.type !== 'secret' && el.type !== 'password') el.value = saved.value;
  }
}

function setSettingsStatus(id, text, tone = '') {
  const block = Array.from(document.querySelectorAll('[data-pd-settings]'))
    .find((node) => node.getAttribute('data-pd-settings') === id);
  const status = block?.querySelector('[data-pd-settings-status]');
  if (!status) return;
  status.textContent = text;
  status.className = `pd-settings-status${tone ? ` is-${tone}` : ''}`;
}

async function savePluginSettings(id) {
  const block = Array.from(document.querySelectorAll('[data-pd-settings]'))
    .find((node) => node.getAttribute('data-pd-settings') === id);
  if (!block) return;
  const values = {};
  for (const input of block.querySelectorAll('[data-pd-field]')) {
    const key = input.getAttribute('data-pd-field');
    const type = input.getAttribute('data-pd-type');
    if (type === 'boolean') values[key] = input.checked === true;
    else if (type === 'number') values[key] = input.value === '' ? '' : Number(input.value);
    else if (type === 'secret') {
      // 留空 = 不改（不是"清空"）；要清空用单独的按钮，避免误把已存 Cookie 抹掉
      if (String(input.value || '').length) values[key] = input.value;
    } else values[key] = input.value;
  }
  setSettingsStatus(id, '保存中…');
  try {
    const saved = await api('/api/plugins/settings', { method: 'POST', body: JSON.stringify({ id, values }) });
    // 先重取（密文字段要变回“已配置”、批准次数要刷新），再写状态 ——
    // 反过来的话 hydrate 会把刚写的“已保存”一起冲掉，用户只看到表单闪一下。
    await hydratePluginSettings(id);
    setSettingsStatus(id, saved?.reloaded === false ? '已保存（插件重载失败，可在台账手动重载）' : '已保存，插件已重载', 'success');
  } catch (error) {
    setSettingsStatus(id, `保存失败：${String(error?.message || error)}`, 'error');
  }
}

async function toggleWriteSwitch(id, action, enabled) {
  try {
    await api('/api/plugins/write-switch', {
      method: 'POST',
      body: JSON.stringify({ id, action, enabled })
    });
    await hydratePluginSettings(id);
    setSettingsStatus(id, enabled
      ? `已允许「${action}」：模型的下一次对话起能看到这个工具（执行仍需逐次批准）`
      : `已关闭「${action}」：模型的下一次对话起不再看到这个工具`, 'success');
  } catch (error) {
    setSettingsStatus(id, `开关失败：${String(error?.message || error)}`, 'error');
  }
}

async function decidePendingApproval(id, pendingId, decision, uses = 1) {
  try {
    const result = await api('/api/plugins/approval', {
      method: 'POST',
      body: JSON.stringify({ id, pendingId, decision, uses })
    });
    await hydratePluginSettings(id);
    if (decision === 'reject') {
      setSettingsStatus(id, '已拒绝该请求', 'success');
      return;
    }
    if (result?.retry) {
      setSettingsStatus(id, result.retry.ok
        ? `已批准并自动执行：${String(result.retry.message || '成功')}`
        : `已批准；自动重试失败：${String(result.retry.message || '未知原因')}`,
      result.retry.ok ? 'success' : 'error');
      return;
    }
    setSettingsStatus(id, '已批准一次；模型下次调用会直接执行', 'success');
  } catch (error) {
    setSettingsStatus(id, `处理失败：${String(error?.message || error)}`, 'error');
  }
}

// ── 控制台内扫码登录：网页发码 → <img> 显示 → 自动轮询 → 成功刷新面板 ──
let qrPollTimer = null;
// 每次启动/取消都换一代：在途请求返回时如果代号变了就不再续期 ——
// 否则点「取消」后，上一个还没回来的请求会继续安排下一轮（2026-10-24 审查 P2）。
let qrPollGen = 0;

function stopQrPoll() {
  qrPollGen += 1;
  if (qrPollTimer) { clearTimeout(qrPollTimer); qrPollTimer = null; }
}

function setQrPanel(id, html) {
  const block = Array.from(document.querySelectorAll('[data-pd-settings]'))
    .find((node) => node.getAttribute('data-pd-settings') === id);
  if (!block) return;
  let panel = block.querySelector('[data-pd-qr-panel]');
  if (!html) { if (panel) panel.remove(); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'pd-qr-panel';
    panel.setAttribute('data-pd-qr-panel', '1');
    const actions = block.querySelector('.pd-settings-actions');
    if (actions) actions.parentNode.insertBefore(panel, actions);
    else block.appendChild(panel);
  }
  panel.innerHTML = html;
}

const QR_DONE_HTML = (account) => `<div class="plugin-warn good">登录成功：${esc(String(account || ''))}。Cookie 已加密保存并立即生效。</div>`;

async function startQrLogin(id) {
  stopQrPoll();
  // 必须在 await 之前拿代号：start 请求可能几秒才回来；期间用户切页/返回目录会再次
  // stopQrPoll()。若 await 后才读 qrPollGen，迟到的响应会拿到新代号并重新起轮询。
  const gen = qrPollGen;
  setQrPanel(id, '<div class="plugin-note">正在向 B 站请求登录二维码…</div>');
  try {
    const result = await api('/api/plugins/call', {
      method: 'POST',
      body: JSON.stringify({ id, tool: 'login', args: { action: 'start', channel: 'console' } })
    });
    if (gen !== qrPollGen) return;
    if (!result?.ok || result?.channel !== 'console') {
      setQrPanel(id, `<div class="plugin-warn bad">二维码请求失败：${esc(String(result?.error || '插件没返回控制台渠道'))}</div>`);
      return;
    }
    setQrPanel(id, `
      <div class="pd-qr-title">用手机 B 站 App 扫这个码，在手机上点确认</div>
      <img class="pd-qr-img" src="${esc(result.qrcodeDataUrl || '')}" alt="登录二维码" width="220" height="220" />
      <div class="pd-qr-status" data-pd-qr-status>等待扫码中…（8 分钟内有效）</div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn btn-small" data-pd-qr-poll="${esc(id)}">查扫码结果</button>
        <button type="button" class="btn btn-small" data-pd-qr-stop>取消</button>
      </div>`);
    const poll = async () => {
      if (gen !== qrPollGen) return;
      try {
        const r = await api('/api/plugins/call', {
          method: 'POST',
          body: JSON.stringify({ id, tool: 'login', args: { action: 'poll', channel: 'console' } })
        });
        if (gen !== qrPollGen) return;
        const statusNode = blockStatusNode();
        if (r?.ok && r?.state === 'done') {
          stopQrPoll();
          // 先刷新表单（登录态徽标从这里出来），**再**写成功面板 ——
          // 顺序反过来 hydrate 会把刚写的面板冲掉，用户就“看不到登录信息”（线上实测踩过）
          await hydratePluginSettings(id);
          setQrPanel(id, QR_DONE_HTML(r.account));
          return;
        }
        if (r?.ok && r?.state === 'unverified') {
          stopQrPoll();
          await hydratePluginSettings(id);
          setQrPanel(id, `<div class="plugin-warn">${esc(String(r.note || '凭据已保存，但登录校验未通过'))}</div>`);
          return;
        }
        if (statusNode) {
          statusNode.textContent = r?.ok && r?.state === 'scanned' ? '已扫码：请在手机上点确认'
            : (r?.ok ? '等待扫码中…' : `轮询失败：${esc(String(r?.error || ''))}`);
        }
        if (r?.ok) {
          if (gen === qrPollGen) qrPollTimer = setTimeout(poll, 3000);
        } else { stopQrPoll(); setQrPanel(id, `<div class="plugin-warn bad">${esc(String(r?.error || '轮询失败'))}</div>`); }
      } catch (error) {
        stopQrPoll();
        setQrPanel(id, `<div class="plugin-warn bad">${esc(String(error?.message || error))}</div>`);
      }
    };
    qrPollTimer = setTimeout(poll, 3000);
  } catch (error) {
    setQrPanel(id, `<div class="plugin-warn bad">扫码登录启动失败：${esc(String(error?.message || error))}</div>`);
  }
}

const blockStatusNode = () => document.querySelector('[data-pd-qr-status]');

async function pollQrOnce(id) {
  try {
    const r = await api('/api/plugins/call', {
      method: 'POST',
      body: JSON.stringify({ id, tool: 'login', args: { action: 'poll', channel: 'console' } })
    });
    if (r?.ok && r?.state === 'done') {
      stopQrPoll();
      await hydratePluginSettings(id);
      setQrPanel(id, QR_DONE_HTML(r.account));
    } else if (r?.ok && r?.state === 'unverified') {
      stopQrPoll();
      await hydratePluginSettings(id);
      setQrPanel(id, `<div class="plugin-warn">${esc(String(r.note || '凭据已保存，但登录校验未通过'))}</div>`);
    } else if (r?.ok) {
      const statusNode = blockStatusNode();
      if (statusNode) statusNode.textContent = r.state === 'scanned' ? '已扫码：请在手机上点确认' : '等待扫码中…';
    } else {
      stopQrPoll();
      setQrPanel(id, `<div class="plugin-warn bad">${esc(String(r?.error || '轮询失败'))}</div>`);
    }
  } catch (error) {
    stopQrPoll();
    setQrPanel(id, `<div class="plugin-warn bad">${esc(String(error?.message || error))}</div>`);
  }
}

async function probePlugin(id) {
  setSettingsStatus(id, '检测中…');
  try {
    const result = await api('/api/plugins/probe', { method: 'POST', body: JSON.stringify({ id }) });
    if (result?.ok !== true) {
      setSettingsStatus(id, `检测失败：${String(result?.error || '未知')}`, 'error');
      return;
    }
    const info = result.info || {};
    const ownerNote = info.owner?.configured
      ? (info.owner.matches ? `｜主人绑定一致（UID ${info.owner.configured}）` : `｜⚠ 当前账号不是绑定的主人 UID ${info.owner.configured}，写操作会被拒绝`)
      : '';
    const line = info.login === true
      ? `登录有效（${info.uname || '已登录'}${info.mid ? `，UID ${info.mid}` : ''}）${ownerNote}`
      : (info.apiOk === false ? 'B 站接口不可达' : `${String(info.note || '未登录')}${ownerNote}`);
    setSettingsStatus(id, `检测结果：${line}`, info.login === true && info.owner?.matches !== false ? 'success' : (info.owner?.matches === false ? 'error' : ''));
  } catch (error) {
    setSettingsStatus(id, `检测失败：${String(error?.message || error)}`, 'error');
  }
}

async function clearPluginSecretField(id, key) {
  try {
    // 接口约定：secret 传空串 = 删除该字段（表单“留空保存”走的是跳过，两条路径分开）
    await api('/api/plugins/settings', { method: 'POST', body: JSON.stringify({ id, values: { [key]: '' } }) });
    await hydratePluginSettings(id);
    setSettingsStatus(id, `已清除 ${key}`, 'success');
  } catch (error) {
    setSettingsStatus(id, `清除失败：${String(error?.message || error)}`, 'error');
  }
}

export {
  hasPluginSettings,
  hydratePluginSettings,
  savePluginSettings,
  toggleWriteSwitch,
  decidePendingApproval,
  clearPluginSecretField,
  probePlugin,
  startQrLogin,
  pollQrOnce,
  setSettingsStatus,
  stopQrPoll
};
