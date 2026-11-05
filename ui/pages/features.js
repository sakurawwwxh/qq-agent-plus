// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import {
  closeModelModal, loadFriendFeaturePage, loadIdentityFeaturePage, loadIncidentFeaturePage, modelModalShell,
  switchTab
} from '../app.js';
import { api } from '../core/api.js';
import {
  ASSET_KINDS, FRIEND_OPPORTUNITY_STATUS, FRIEND_PROPOSAL_REASON, FRIEND_PROPOSAL_STATUS,
  INCIDENT_SEVERITY_LABELS, INCIDENT_STATE_LABELS, INCOMING_FRIEND_STATUS, SLANG_RESEARCH_STATUS
} from '../core/constants.js';
import {
  askForConfirmation, identityPilotSettingsPatch, readAssetImage, setBoxError, setHtmlIfChanged,
  syncGraduatedFeatureNavigation
} from '../core/dom-util.js';
import { $, $$, esc } from '../core/dom.js';
import { iconSvg } from '../core/icons.js';
import { chatNameOf, clampInt, fmtTime, fmtTok, formatChatTitle } from '../core/format.js';
import { unzipStickerImages } from '../core/zip-images.js';
import { state } from '../core/state.js';
function assetStateText(active, exists, activeText = '运行中') {
  if (active) return activeText;
  if (exists) return '已存储 · 未接入';
  return '未接入';
}

function renderAssetSummary(overview) {
  const stickers = overview.stickers || {};
  const slang = overview.slang || {};
  const slangPilot = overview.slangPilot || {};
  return `
    <div class="asset-summary">
      <button type="button" class="asset-summary-item" data-asset-kind="stickers">
        <span>表情包</span><strong>${fmtTok(stickers.total)}</strong>
        <small>${stickers.enabled ? `已备注 ${fmtTok(stickers.annotated)}` : '功能已关闭'}</small>
      </button>
      <button type="button" class="asset-summary-item" data-asset-kind="slang">
        <span>黑话</span><strong>${fmtTok(slang.total)}</strong>
        <small>${assetStateText(slang.active, slang.exists)}</small>
      </button>
      <button type="button" class="asset-summary-item" data-asset-kind="slang-research">
        <span>黑话研究</span><strong>${fmtTok(
          (slangPilot.pendingResearch || 0) + (slangPilot.pendingAdmission || 0)
        )}</strong>
        <small>${slangPilot.active ? '等待审批' : '实验开关关闭'}</small>
      </button>
    </div>`;
}

function renderStickerAssets(data) {
  const entries = data?.entries || [];
  if (!entries.length) {
    return '<div class="empty-hint">当前表情包库为空</div>';
  }
  // QQ 收藏表情有上限（非会员 500）：满了之后新收藏只能进本地图库 —— 那种在群里是以"图片"
  // 发出去的（不是表情）。这句就是解释"为什么最近像图片"（2026-09-27 用户反馈）。
  const fav = data?.qqFavorites || null;
  const favHint = fav && (fav.full || (fav.count != null && fav.count >= 400))
    ? `<div class="hint" style="margin:0 0 8px">QQ 收藏表情已占 ${fav.count ?? '?'}/500`
      + `${fav.full ? '（已满）' : ''}：新收藏会存进本地图库 —— 本地图库的条目在群里以<strong>图片</strong>发出（不是表情），`
      + '上面标「AI 收藏 / 手动」的就是这一类。想让它当表情发，需要在手机 QQ 里腾出收藏位。</div>'
    : '';
  return favHint + `<div class="asset-sticker-grid">${entries.map((entry) => {
    const title = entry.localNote || entry.desc || entry.id;
    const tags = (entry.tags || []).map((tag) => `<span>${esc(tag)}</span>`).join('');
    const selected = (state.assetStickerSelectedIds || []).includes(String(entry.id));
    return `<article class="asset-sticker ${selected ? 'selected' : ''}">
      ${state.assetStickerSelectMode ? `<label class="asset-sticker-select"><input type="checkbox" data-sticker-select="${esc(entry.id)}" ${selected ? 'checked' : ''} aria-label="选择表情 ${esc(title)}" /></label>` : ''}
      <div class="asset-sticker-media">
        ${entry.hasImage
          ? `<img loading="lazy" src="/api/assets/stickers/image?id=${encodeURIComponent(entry.id)}" alt="${esc(title)}" />`
          : '<span class="muted">无图片</span>'}
      </div>
      <div class="asset-sticker-body">
        <strong title="${esc(title)}">${esc(title)}</strong>
        ${entry.desc && entry.localNote ? `<span title="${esc(entry.desc)}">${esc(entry.desc)}</span>` : ''}
        ${tags ? `<div class="asset-tags">${tags}</div>` : ''}
        <small>${entry.source === 'qq' ? 'QQ 收藏' : entry.source === 'ai' ? 'AI 收藏' : '手动'} · 使用 ${fmtTok(entry.useCount)} 次</small>
        <div class="asset-actions">
          <button type="button" class="btn btn-small asset-edit" data-asset-id="${esc(entry.id)}">编辑</button>
          <button type="button" class="btn btn-small btn-danger asset-delete" data-asset-id="${esc(entry.id)}">删除</button>
        </div>
      </div>
    </article>`;
  }).join('')}</div>`;
}

function renderSlangAssets(data) {
  if (!data?.exists) {
    return '<div class="empty-hint">当前 Agent 没有黑话库</div>';
  }
  const entries = data.entries || [];
  if (!entries.length) return '<div class="empty-hint">黑话库为空</div>';
  const statusText = { candidate: '候选', confirmed: '已确认', rejected: '已拒绝' };
  return `<div class="asset-table-wrap"><table class="asset-table">
    <thead><tr><th>词条</th><th>含义</th><th>状态</th><th class="r">出现</th><th class="r">证据</th><th class="actions-col">操作</th></tr></thead>
    <tbody>${entries.map((entry) => `<tr>
      <td><strong>${esc(entry.content)}</strong>${entry.risk ? `<small>${esc(entry.risk)}</small>` : ''}</td>
      <td>${esc(entry.meaning || '-')}${entry.usage ? `<small>${esc(entry.usage)}</small>` : ''}</td>
      <td>${esc(statusText[entry.status] || entry.status)}<small>${entry.scope === 'chat-private' ? '仅来源群' : '全局'}</small></td>
      <td class="r">${fmtTok(entry.count)}</td>
      <td class="r">${fmtTok(entry.evidenceCount)}</td>
      <td><div class="asset-actions">
        <button type="button" class="btn btn-small asset-edit" data-asset-id="${esc(entry.id)}">编辑</button>
        <button type="button" class="btn btn-small btn-danger asset-delete" data-asset-id="${esc(entry.id)}">删除</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function renderSlangResearch(data) {
  if (data?.disabled) {
    return '<div class="empty-hint">黑话研究实验功能当前关闭</div>';
  }
  const entries = data?.discoveries || [];
  if (!entries.length) return '<div class="empty-hint">当前没有黑话研究记录</div>';
  return `<div class="asset-table-wrap"><table class="asset-table">
    <thead><tr><th>词条</th><th>来源</th><th>证据</th><th>研究结论</th><th>状态</th><th class="actions-col">操作</th></tr></thead>
    <tbody>${entries.map((entry) => {
      const evidence = (entry.evidence || []).slice(-2)
        .map((item) => item.text).filter(Boolean).join('；');
      let commands = '';
      if (entry.state === 'pending_research') {
        commands = `
          <button type="button" class="btn btn-small slang-research-action" data-id="${esc(entry.id)}" data-action="research-approve">研究</button>
          <button type="button" class="btn btn-small btn-danger slang-research-action" data-id="${esc(entry.id)}" data-action="research-reject">拒绝</button>`;
      } else if (entry.state === 'pending_admission') {
        commands = `
          <button type="button" class="btn btn-small slang-research-action" data-id="${esc(entry.id)}" data-action="admission-review">查看并收录</button>
          <button type="button" class="btn btn-small btn-danger slang-research-action" data-id="${esc(entry.id)}" data-action="admission-reject">拒绝</button>`;
      } else if (['research_failed', 'research_interrupted'].includes(entry.state)) {
        commands = `<button type="button" class="btn btn-small slang-research-action" data-id="${esc(entry.id)}" data-action="research-retry">重试</button>`;
      }
      const actions = `<div class="asset-actions">
        <button type="button" class="btn btn-small slang-research-action" data-id="${esc(entry.id)}" data-action="detail">详情</button>
        ${commands}
      </div>`;
      return `<tr>
        <td><strong>${esc(entry.displayTerm)}</strong><small><code>${esc(entry.id)}</code></small></td>
        <td>${esc(formatChatTitle(entry.scopeChatKey, chatNameOf(entry.scopeChatKey)))}<small>${fmtTok(entry.occurrenceCount)} 次 · ${fmtTok(entry.speakerCount)} 人</small></td>
        <td title="${esc(evidence)}">${esc(evidence || '-')}</td>
        <td>${esc(entry.research?.meaning || '-')}${entry.researchError ? `<small>${esc(entry.researchError)}</small>` : ''}</td>
        <td>${esc(SLANG_RESEARCH_STATUS[entry.state] || entry.state)}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

async function decideSlangResearch(entry, action) {
  if (action === 'detail') return openSlangResearchDetail(entry.id);
  if (action === 'admission-review') return openSlangAdmissionEditor(entry);
  const reject = action.endsWith('reject');
  const retry = action === 'research-retry';
  if (
    !retry
    && !await askForConfirmation(reject ? '拒绝这条黑话记录？' : '批准消耗模型 Token 研究这个词条？')
  ) {
    return;
  }
  const path = retry
    ? `/api/slang-pilot/discoveries/${encodeURIComponent(entry.id)}/retry`
    : action.startsWith('research-')
      ? `/api/slang-pilot/discoveries/${encodeURIComponent(entry.id)}/research-decision`
      : `/api/slang-pilot/discoveries/${encodeURIComponent(entry.id)}/admission-decision`;
  await api(path, {
    method: 'POST',
    body: JSON.stringify(retry ? {} : {
      decision: reject ? 'reject' : 'approve'
    })
  });
  state.assetOverview = null;
  state.assetDetail = null;
  await loadAssetObservatory();
}

async function openSlangResearchDetail(id) {
  const data = await api(`/api/slang-pilot/discoveries/${encodeURIComponent(id)}`);
  const entry = data.discovery;
  const research = entry.research || {};
  const evidence = (entry.evidence || []).map((item) => `
    <tr><td>${esc(fmtTime(item.at))}</td><td>${esc(item.senderName || item.senderId || '-')}</td><td>${esc(item.text || '-')}</td></tr>
  `).join('');
  const events = (entry.events || []).map((item) => `
    <tr><td>${esc(fmtTime(item.createdAt))}</td><td>${esc(item.stage)}</td><td>${esc(item.decision)}</td><td>${esc(item.decidedBy || '-')}</td></tr>
  `).join('');
  const overlay = modelModalShell({
    head: `黑话研究 · ${entry.displayTerm}`,
    body: `
      <div class="field-row">
        <div class="field"><label>状态</label><div>${esc(SLANG_RESEARCH_STATUS[entry.state] || entry.state)}</div></div>
        <div class="field"><label>来源</label><div>${esc(formatChatTitle(entry.scopeChatKey, chatNameOf(entry.scopeChatKey)))}</div></div>
        <div class="field"><label>统计</label><div>${fmtTok(entry.occurrenceCount)} 次 · ${fmtTok(entry.speakerCount)} 人</div></div>
      </div>
      ${research.meaning ? `<div class="field"><label>研究结论</label><div>${esc(research.meaning)}</div></div>` : ''}
      ${research.usage ? `<div class="field"><label>使用方式</label><div>${esc(research.usage)}</div></div>` : ''}
      ${research.risk ? `<div class="field"><label>误用风险</label><div>${esc(research.risk)}</div></div>` : ''}
      <div class="field"><label>证据</label><div class="asset-table-wrap"><table class="asset-table">
        <thead><tr><th>时间</th><th>发言人</th><th>原文</th></tr></thead>
        <tbody>${evidence || '<tr><td colspan="3">无</td></tr>'}</tbody>
      </table></div></div>
      <div class="field"><label>来源链接</label><div>${(entry.researchSources || []).map((url) => `<div><code>${esc(url)}</code></div>`).join('') || '-'}</div></div>
      <div class="field"><label>Token</label><div>${fmtTok(entry.researchUsage?.totalTokens || 0)}</div></div>
      <div class="field"><label>审批记录</label><div class="asset-table-wrap"><table class="asset-table">
        <thead><tr><th>时间</th><th>阶段</th><th>决定</th><th>操作者</th></tr></thead>
        <tbody>${events || '<tr><td colspan="4">无</td></tr>'}</tbody>
      </table></div></div>`,
    foot: '<button class="btn btn-primary" id="slang-detail-close">关闭</button>'
  });
  overlay.querySelector('#slang-detail-close').addEventListener('click', () =>
    closeModelModal(overlay));
}

function openSlangAdmissionEditor(entry) {
  const research = entry.research || {};
  const overlay = modelModalShell({
    head: '审核黑话研究结果',
    body: `
      <div class="field"><label>词条</label><input type="text" id="slang-admit-content" maxlength="80" value="${esc(research.canonical || entry.displayTerm)}" /></div>
      <div class="field"><label>含义</label><textarea id="slang-admit-meaning">${esc(research.meaning || '')}</textarea></div>
      <div class="field"><label>使用方式</label><textarea id="slang-admit-usage">${esc(research.usage || '')}</textarea></div>
      <div class="field"><label>例句</label><textarea id="slang-admit-example">${esc(research.example || '')}</textarea></div>
      <div class="field"><label>误用风险</label><textarea id="slang-admit-risk">${esc(research.risk || '')}</textarea></div>
      <div class="field"><label>使用范围</label><select id="slang-admit-scope">
        <option value="chat-private" ${research.recommendedScope === 'global-safe' ? '' : 'selected'}>仅来源群</option>
        <option value="global-safe" ${research.recommendedScope === 'global-safe' ? 'selected' : ''}>全局可用</option>
      </select></div>`,
    foot: '<button class="btn" id="slang-admit-cancel">取消</button><button class="btn btn-primary" id="slang-admit-save">加入候选库</button>'
  });
  overlay.querySelector('#slang-admit-cancel').addEventListener('click', () =>
    closeModelModal(overlay));
  overlay.querySelector('#slang-admit-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await withAssetWrite(async () => {
        await api(
          `/api/slang-pilot/discoveries/${encodeURIComponent(entry.id)}/admission-decision`,
          {
            method: 'POST',
            body: JSON.stringify({
              decision: 'approve',
              edits: {
                content: overlay.querySelector('#slang-admit-content').value,
                meaning: overlay.querySelector('#slang-admit-meaning').value,
                usage: overlay.querySelector('#slang-admit-usage').value,
                example: overlay.querySelector('#slang-admit-example').value,
                risk: overlay.querySelector('#slang-admit-risk').value,
                scope: overlay.querySelector('#slang-admit-scope').value
              }
            })
          }
        );
        await finishAssetMutation(overlay);
      });
    } catch (error) {
      alert(`收录失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function renderIdentityAssets(data) {
  if (!data?.exists) {
    return '<div class="empty-hint">尚未建立统一身份索引</div>';
  }
  const people = data?.entries || [];
  if (!people.length) return '<div class="empty-hint">统一身份库为空</div>';
  return `<div class="asset-table-wrap"><table class="asset-table">
    <thead><tr><th>QQ</th><th>首选名称</th><th>别名</th><th class="r">会话</th><th class="r">消息</th><th>好友</th><th>画像备注</th><th class="actions-col">操作</th></tr></thead>
    <tbody>${people.map((person) => {
      const aliases = [...new Set((person.aliases || []).map((item) =>
        typeof item === 'string' ? item : item?.alias).filter(Boolean))];
      return `<tr>
        <td><code>${esc(person.userId)}</code></td>
        <td>${esc(person.primaryName || '-')}</td>
        <td title="${esc(aliases.join(' / '))}">${esc(aliases.slice(0, 3).join(' / ') || '-')}</td>
        <td class="r">${fmtTok(person.chatCount)}</td>
        <td class="r">${fmtTok(person.messageCount)}</td>
        <td>${person.isFriend ? '是' : '否'}</td>
        <td>${esc(person.profileNote || '-')}${person.manuallyManaged ? '<small>人工维护</small>' : ''}</td>
        <td><div class="asset-actions">
          <button type="button" class="btn btn-small asset-edit" data-asset-id="${esc(person.userId)}">编辑</button>
          <button type="button" class="btn btn-small btn-danger asset-delete" data-asset-id="${esc(person.userId)}">删除</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function renderMemoryAssets(data) {
  const entries = data?.entries || [];
  if (!entries.length) return '<div class="empty-hint">当前没有会话记忆</div>';
  // 接口带 limit（默认 500，按最近更新截断）：截过就要说出来，否则用户以为"就这么多"
  // （2026-10-08 审查：limit 加了但界面没说）
  const total = Number(data?.total) || entries.length;
  const capped = total > entries.length
    ? `<div class="hint">共 ${total} 条，按最近更新只列前 ${entries.length} 条。</div>` : '';
  return `${capped}<div class="asset-table-wrap"><table class="asset-table">
    <thead><tr><th>会话</th><th>人物</th><th>印象</th><th>最近更新</th><th class="actions-col">操作</th></tr></thead>
    <tbody>${entries.map((entry, index) => `<tr>
      <td>${esc(formatChatTitle(entry.chatKey, chatNameOf(entry.chatKey)))}</td>
      <td><strong>${esc(entry.name || entry.userId)}</strong><small><code>${esc(entry.userId)}</code></small></td>
      <td>${esc((entry.impressions || []).map((item) => item.content).join('；') || '-')}</td>
      <td>${entry.updatedAt ? esc(fmtTime(entry.updatedAt)) : '-'}</td>
      <td><div class="asset-actions">
        <button type="button" class="btn btn-small asset-edit" data-asset-index="${index}">编辑</button>
        <button type="button" class="btn btn-small btn-danger asset-delete" data-asset-index="${index}">删除</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function assetChatOptions(selected = '') {
  const keys = new Set([
    ...(state.chats || []).map((chat) => chat.key),
    ...((state.assetOverview?.memory?.items || []).map((chat) => chat.chatKey)),
    selected
  ].filter(Boolean));
  return [...keys].map((chatKey) =>
    `<option value="${esc(chatKey)}">${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))}</option>`
  ).join('');
}

/** 本地资产写入在途（编辑/新增/收录保存）：期间到达的资产类 SSE 回声（asset-update /
 *  identity-pilot-update）一律跳过 —— 保存流程自己会用 finishAssetMutation 重拉收尾；
 *  不挡的话回声会再触发一次"清空+重拉"，表现为保存后整格重渲染两次、滚动被顶回顶部
 *  （2026-10-02 复审）。计数而非布尔：连续两次保存重叠时，先完成的一次不能把后一次的
 *  在途窗口提前清掉，否则后一次的回声漏进来照样双重重拉（2026-10-02 复审 P2）。 */
async function withAssetWrite(fn) {
  state.assetWriteInFlight = (Number(state.assetWriteInFlight) || 0) + 1;
  try { return await fn(); } finally {
    state.assetWriteInFlight = Math.max(0, (Number(state.assetWriteInFlight) || 0) - 1);
  }
}

function finishAssetMutation(overlay) {
  closeModelModal(overlay);
  if (state.tab === 'identity') {
    state.assetOverview = null;
    state.assetDetail = null;
    return loadIdentityFeaturePage();
  }
  // 不清空 overview/detail（清空会让页面先塌成"加载中…"、滚动位置被顶回顶部）；
  // 就地重拉后把手动滚动位置还原（与删图同一口径，2026-10-02 复审）。
  const scrollY = window.scrollY ?? 0;
  return loadAssetObservatory().finally(() => { window.scrollTo?.(0, scrollY); });
}

function openStickerBatchImport() {
  const overlay = modelModalShell({
    head: '批量导入表情包',
    body: `<div class="sticker-batch-progress"><progress id="sticker-batch-progress" max="1" value="0"></progress><span id="sticker-batch-progress-text">选择 ZIP 压缩包或多张图片（最多 100 张）</span></div><div class="field"><label for="sticker-batch-files">图片或 ZIP 压缩包（单张不超过 8 MiB）</label><input id="sticker-batch-files" type="file" accept=".zip,application/zip,image/png,image/jpeg,image/gif,image/webp" multiple /></div><p class="muted">使用当前配置的模型逐张分析，结果可修改后再选择性导入。</p><div id="sticker-batch-list" class="sticker-batch-list"></div>`,
    foot: '<button class="btn" id="sticker-batch-cancel">关闭</button><button class="btn" id="sticker-batch-analyze">分析图片</button><button class="btn btn-primary" id="sticker-batch-import" disabled>导入已勾选项</button>'
  });
  const filesInput = overlay.querySelector('#sticker-batch-files');
  const list = overlay.querySelector('#sticker-batch-list');
  const analyze = overlay.querySelector('#sticker-batch-analyze');
  const importer = overlay.querySelector('#sticker-batch-import');
  const progress = overlay.querySelector('#sticker-batch-progress');
  const progressText = overlay.querySelector('#sticker-batch-progress-text');
  const rows = [];
  const setProgress = (done, total, label) => { progress.max = Math.max(1, total); progress.value = done; progressText.textContent = `${label} ${done}/${total}`; };
  const draw = () => {
    list.innerHTML = rows.map((row, index) => `<article class="sticker-batch-row" data-row="${index}"><img src="${row.preview}" alt="待导入图片 ${index + 1}" /><div class="sticker-batch-fields"><label><input type="checkbox" data-field="selected" ${row.selected ? 'checked' : ''} /> 导入</label><label>名称<input data-field="desc" maxlength="80" value="${esc(row.desc)}" /></label><label>自动备注<textarea data-field="localNote" maxlength="300">${esc(row.localNote)}</textarea></label><label>标签<input data-field="tags" value="${esc(row.tags.join(', '))}" /></label><label>使用场景<textarea data-field="usage" maxlength="300">${esc(row.usage)}</textarea></label><small>${esc(row.status === 'error' ? row.error : row.status)}</small></div></article>`).join('');
    importer.disabled = !rows.some((row) => row.selected && row.status === '已分析');
  };
  filesInput.addEventListener('change', () => {
    rows.forEach((row) => URL.revokeObjectURL(row.preview)); rows.splice(0, rows.length);
    const selectedFiles = [...(filesInput.files || [])];
    (async () => {
      try {
        let files = [];
        for (const file of selectedFiles) files.push(...(/\.zip$/i.test(file.name) ? await unzipStickerImages(file) : [file]));
        if (files.length > 100) throw new Error('每批最多处理 100 张图片');
        files.forEach((file) => rows.push({ file, preview: URL.createObjectURL(file), status: '待分析', selected: true, desc: '', localNote: '', tags: [], usage: '' }));
        progressText.textContent = `已读取 ${rows.length} 张图片`;
      } catch (error) { progressText.textContent = `压缩包读取失败：${error.message}`; }
      draw();
    })();
  });
  list.addEventListener('input', (event) => {
    const field = event.target.dataset.field; const row = rows[Number(event.target.closest('[data-row]')?.dataset.row)];
    if (!row || !field) return;
    if (field === 'selected') row.selected = event.target.checked;
    else row[field] = field === 'tags' ? event.target.value.split(/[,，\s]+/).filter(Boolean) : event.target.value;
    importer.disabled = !rows.some((item) => item.selected && item.status === '已分析');
  });
  overlay.querySelector('#sticker-batch-cancel').addEventListener('click', () => { rows.forEach((row) => URL.revokeObjectURL(row.preview)); closeModelModal(overlay); });
  analyze.addEventListener('click', async () => {
    if (!rows.length) return alert('请先选择图片'); analyze.disabled = true;
    const pending = rows.filter((row) => row.status !== '已分析'); let done = 0;
    for (const row of pending) {
      setProgress(done, pending.length, '分析中');
      if (row.status === '已分析') continue;
      if (row.file.size > 8 * 1024 * 1024) { row.status = 'error'; row.error = '图片不能超过 8 MiB'; draw(); continue; }
      row.status = '分析中…'; draw();
      try { const imageDataUrl = await readAssetImage(row.file); const result = await api('/api/assets/stickers/analyze', { method: 'POST', body: JSON.stringify({ imageDataUrl }) }); Object.assign(row, result.metadata, { status: '已分析' }); }
      catch (error) { row.status = 'error'; row.error = error.message; } done += 1; setProgress(done, pending.length, '分析中'); draw();
    }
    analyze.disabled = false;
  });
  importer.addEventListener('click', async () => {
    importer.disabled = true; const selected = rows.filter((row) => row.selected && row.status === '已分析'); let imported = 0;
    await withAssetWrite(async () => {
      let done = 0;
      for (const row of selected) {
        try { await api('/api/assets/stickers', { method: 'POST', body: JSON.stringify({ imageDataUrl: await readAssetImage(row.file), desc: row.desc, localNote: row.localNote, tags: row.tags, usage: row.usage }) }); row.selected = false; row.status = '已导入'; imported += 1; }
        catch (error) { row.status = 'error'; row.error = error.message; } done += 1; setProgress(done, selected.length, '导入中'); draw();
      }
      if (imported) await finishAssetMutation(overlay);
    });
    if (!imported) importer.disabled = false;
  });
}

function openStickerAssetEditor(entry = null) {
  const editing = Boolean(entry);
  const overlay = modelModalShell({
    head: editing ? '编辑表情包' : '新增表情包',
    body: `
      ${editing ? '' : `
      <div class="field"><label>图片文件</label><input type="file" id="asset-sticker-file" accept="image/png,image/jpeg,image/gif,image/webp" /></div>
      <div class="field"><label>图片 URL</label><input type="text" id="asset-sticker-url" placeholder="未选择文件时使用" /></div>`}
      <div class="field"><label>名称</label><input type="text" id="asset-sticker-desc" maxlength="80" value="${esc(entry?.desc || '')}" /></div>
      <div class="field"><label>自动备注</label><textarea id="asset-sticker-note">${esc(entry?.localNote || '')}</textarea></div>
      <div class="field"><label>标签</label><input type="text" id="asset-sticker-tags" value="${esc((entry?.tags || []).join(', '))}" /></div>
      <div class="field"><label>使用场景</label><textarea id="asset-sticker-usage">${esc(entry?.usage || '')}</textarea></div>`,
    foot: '<button class="btn" id="asset-editor-cancel">取消</button><button class="btn btn-primary" id="asset-editor-save">保存</button>'
  });
  overlay.querySelector('#asset-editor-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#asset-editor-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const body = {
        desc: overlay.querySelector('#asset-sticker-desc').value,
        localNote: overlay.querySelector('#asset-sticker-note').value,
        tags: overlay.querySelector('#asset-sticker-tags').value
          .split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean),
        usage: overlay.querySelector('#asset-sticker-usage').value
      };
      if (!editing) {
        body.imageUrl = overlay.querySelector('#asset-sticker-url').value.trim();
        body.imageDataUrl = await readAssetImage(
          overlay.querySelector('#asset-sticker-file').files?.[0]
        );
      }
      await withAssetWrite(async () => {
        await api(
          editing
            ? `/api/assets/stickers/${encodeURIComponent(entry.id)}`
            : '/api/assets/stickers',
          { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }
        );
        await finishAssetMutation(overlay);
      });
    } catch (error) {
      alert(`保存失败：${error.message}`);
      button.disabled = false;
    }
  });
}

async function runStickerBulkAction(ids, label, action) {
  const progress = $('#asset-sticker-bulk-progress');
  const message = $('#asset-sticker-bulk-progress-text');
  if (progress) { progress.hidden = false; progress.max = ids.length; progress.value = 0; }
  let failed = 0;
  await withAssetWrite(async () => {
    for (let index = 0; index < ids.length; index += 1) {
      try { await action(ids[index]); } catch (error) { failed += 1; if (message) message.textContent = `${label} ${index + 1}/${ids.length}：${error.message}`; }
      if (progress) progress.value = index + 1;
      if (message && !failed) message.textContent = `${label} ${index + 1}/${ids.length}`;
    }
  });
  state.assetStickerSelectedIds = [];
  await loadAssetObservatory();
  const text = $('#asset-sticker-bulk-progress-text');
  if (text) text.textContent = failed ? `完成，${failed} 项失败` : '全部完成';
  if (failed) alert(`${label}：${ids.length - failed} 项成功，${failed} 项失败。失败项可重新选择后重试。`);
}

function openSlangAssetEditor(entry = null) {
  const editing = Boolean(entry);
  const overlay = modelModalShell({
    head: editing ? '编辑黑话' : '新增黑话',
    body: `
      <div class="field-row">
        <div class="field"><label>词条</label><input type="text" id="asset-slang-content" maxlength="80" value="${esc(entry?.content || '')}" /></div>
        <div class="field"><label>状态</label><select id="asset-slang-state">
          <option value="candidate" ${entry?.status === 'candidate' || !entry ? 'selected' : ''}>候选</option>
          <option value="confirmed" ${entry?.status === 'confirmed' ? 'selected' : ''}>已确认</option>
          <option value="rejected" ${entry?.status === 'rejected' ? 'selected' : ''}>已拒绝</option>
        </select></div>
      </div>
      <div class="field"><label>含义</label><textarea id="asset-slang-meaning">${esc(entry?.meaning || '')}</textarea></div>
      <div class="field"><label>使用方式</label><textarea id="asset-slang-usage">${esc(entry?.usage || '')}</textarea></div>
      <div class="field"><label>例句</label><textarea id="asset-slang-example">${esc(entry?.example || '')}</textarea></div>
      <div class="field"><label>误用风险</label><textarea id="asset-slang-risk">${esc(entry?.risk || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>使用范围</label><select id="asset-slang-scope">
          <option value="global-safe" ${entry?.scope === 'chat-private' ? '' : 'selected'}>全局可用</option>
          <option value="chat-private" ${entry?.scope === 'chat-private' ? 'selected' : ''}>仅来源会话</option>
        </select></div>
        <div class="field"><label>来源会话</label><input type="text" id="asset-slang-chat" list="asset-slang-chat-options" value="${esc(entry?.scopeChatKey || '')}" placeholder="group:群号" /><datalist id="asset-slang-chat-options">${assetChatOptions(entry?.scopeChatKey)}</datalist></div>
      </div>`,
    foot: '<button class="btn" id="asset-editor-cancel">取消</button><button class="btn btn-primary" id="asset-editor-save">保存</button>'
  });
  overlay.querySelector('#asset-editor-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#asset-editor-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const body = {
        content: overlay.querySelector('#asset-slang-content').value,
        status: overlay.querySelector('#asset-slang-state').value,
        meaning: overlay.querySelector('#asset-slang-meaning').value,
        usage: overlay.querySelector('#asset-slang-usage').value,
        example: overlay.querySelector('#asset-slang-example').value,
        risk: overlay.querySelector('#asset-slang-risk').value,
        scope: overlay.querySelector('#asset-slang-scope').value,
        scopeChatKey: overlay.querySelector('#asset-slang-chat').value.trim()
      };
      await withAssetWrite(async () => {
        await api(
          editing
            ? `/api/assets/slang/${encodeURIComponent(entry.id)}`
            : '/api/assets/slang',
          { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }
        );
        await finishAssetMutation(overlay);
      });
    } catch (error) {
      alert(`保存失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function openIdentityAssetEditor(entry = null) {
  const editing = Boolean(entry);
  const overlay = modelModalShell({
    head: editing ? '编辑人物' : '新增人物',
    body: `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="asset-person-uin" inputmode="numeric" value="${esc(entry?.userId || '')}" ${editing ? 'readonly' : ''} /></div>
        <div class="field"><label>首选名称</label><input type="text" id="asset-person-name" maxlength="60" value="${esc(entry?.primaryName || '')}" /></div>
      </div>
      <div class="field"><label>来源会话</label><input type="text" id="asset-person-chat" list="asset-chat-options" value="${esc(entry?.sourceChatKey || '')}" placeholder="group:群号 或 private:QQ号" /><datalist id="asset-chat-options">${assetChatOptions(entry?.sourceChatKey)}</datalist></div>
      <div class="field"><label>画像备注</label><textarea id="asset-person-note">${esc(entry?.profileNote || '')}</textarea></div>
      <div class="checkbox-row"><input type="checkbox" id="asset-person-friend" ${entry?.isFriend ? 'checked' : ''} /><label for="asset-person-friend">标记为好友</label></div>`,
    foot: '<button class="btn" id="asset-editor-cancel">取消</button><button class="btn btn-primary" id="asset-editor-save">保存</button>'
  });
  overlay.querySelector('#asset-editor-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#asset-editor-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const userId = overlay.querySelector('#asset-person-uin').value.trim();
      const body = {
        userId,
        primaryName: overlay.querySelector('#asset-person-name').value,
        chatKey: overlay.querySelector('#asset-person-chat').value.trim(),
        profileNote: overlay.querySelector('#asset-person-note').value,
        isFriend: overlay.querySelector('#asset-person-friend').checked
      };
      await withAssetWrite(async () => {
        await api(
          editing
            ? `/api/assets/identities/${encodeURIComponent(entry.userId)}`
            : '/api/assets/identities',
          { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }
        );
        await finishAssetMutation(overlay);
      });
    } catch (error) {
      alert(`保存失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function openMemoryAssetEditor(entry = null) {
  const editing = Boolean(entry);
  const overlay = modelModalShell({
    head: editing ? '编辑人物记忆' : '新增人物记忆',
    body: `
      <div class="field"><label>会话</label><input type="text" id="asset-memory-chat" list="asset-memory-chat-options" value="${esc(entry?.chatKey || '')}" ${editing ? 'readonly' : ''} placeholder="group:群号 或 private:QQ号" /><datalist id="asset-memory-chat-options">${assetChatOptions(entry?.chatKey)}</datalist></div>
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="asset-memory-uin" inputmode="numeric" value="${esc(entry?.userId || '')}" ${editing ? 'readonly' : ''} /></div>
        <div class="field"><label>名称</label><input type="text" id="asset-memory-name" maxlength="60" value="${esc(entry?.name || '')}" /></div>
      </div>
      <div class="field"><label>${editing ? '印象内容（一行一条）' : '记忆内容'}</label><textarea id="asset-memory-content" style="min-height:160px">${esc(editing ? (entry?.impressions || []).map((item) => item.content).join('\n') : '')}</textarea></div>`,
    foot: '<button class="btn" id="asset-editor-cancel">取消</button><button class="btn btn-primary" id="asset-editor-save">保存</button>'
  });
  overlay.querySelector('#asset-editor-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#asset-editor-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const content = overlay.querySelector('#asset-memory-content').value;
      const body = {
        chatKey: overlay.querySelector('#asset-memory-chat').value.trim(),
        userId: overlay.querySelector('#asset-memory-uin').value.trim(),
        name: overlay.querySelector('#asset-memory-name').value
      };
      if (editing) body.impressions = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      else body.content = content;
      await withAssetWrite(async () => {
        await api('/api/assets/memory', {
          method: editing ? 'PUT' : 'POST',
          body: JSON.stringify(body)
        });
        await finishAssetMutation(overlay);
      });
    } catch (error) {
      alert(`保存失败：${error.message}`);
      button.disabled = false;
    }
  });
}

function openAssetEditor(kind, entry = null) {
  if (kind === 'stickers') return openStickerAssetEditor(entry);
  if (kind === 'slang') return openSlangAssetEditor(entry);
  if (kind === 'identities') return openIdentityAssetEditor(entry);
  return openMemoryAssetEditor(entry);
}

async function deleteAsset(kind, entry, cardEl = null) {
  const label = kind === 'stickers'
    ? (entry.localNote || entry.desc || entry.id)
    : kind === 'slang'
      ? entry.content
      : kind === 'identities'
        ? (entry.primaryName || entry.userId)
        : (entry.name || entry.userId);
  if (!await askForConfirmation(`确定从 AI 资产中删除“${label}”？`)) return;
  let path;
  let body = { confirm: true };
  if (kind === 'stickers') path = `/api/assets/stickers/${encodeURIComponent(entry.id)}`;
  else if (kind === 'slang') path = `/api/assets/slang/${encodeURIComponent(entry.id)}`;
  else if (kind === 'identities') path = `/api/assets/identities/${encodeURIComponent(entry.userId)}`;
  else {
    path = '/api/assets/memory';
    body = { ...body, chatKey: entry.chatKey, userId: entry.userId };
  }
  // 删除在途标记：服务端是「先广播 SSE、后回 HTTP 响应」，SSE 的 delete 事件会比
  // 本响应先到 —— 若不挡住，asset-update 监听器会在这里的本地摘除完成前触发
  // 整格重渲染（缩略图全部重闪）并把概览计数减两次（2026-10-02 用户实测「等好久才消失」）。
  // 身份/记忆也一并标记：它们的删除不走就地摘除，但回声（identity-pilot-update）会在
  // 响应落地前先把身份页整页重拉一次，叠上删除收尾的重拉同样是两次（2026-10-02 复审）。
  const inFlight = { kind, id: String(entry.id ?? entry.userId ?? '') };
  state.assetDeleteInFlight = inFlight;
  try {
    const result = await api(path, { method: 'DELETE', body: JSON.stringify(body) });
      // 就地摘除（2026-10-02 用户反馈）：重拉整页会把缩略图全部重闪一遍、滚动位置被顶回去，
      // 看起来就像整页刷新。stickers 改为：本地状态摘掉这一条 + 概览计数就地减一 + 直接移除
      // 卡片节点 —— 不重拉接口、不重渲染网格，剩下的图纹丝不动；拿不到卡片节点才退回重渲染。
      // 其余类别维持重拉路径。
      const scrollY = window.scrollY ?? 0;
      if (kind === 'stickers') {
        let removed = false;
        if (state.assetDetail && Array.isArray(state.assetDetail.entries)) {
          const deletedKey = String(entry.id ?? '');
          const before = state.assetDetail.entries.length;
          state.assetDetail = {
            ...state.assetDetail,
            entries: state.assetDetail.entries.filter((item) => String(item.id ?? '') !== deletedKey),
          };
          removed = state.assetDetail.entries.length !== before;
        }
        // 只在确实从本地列表里摘掉了这条时才减计数：并发删另一张 / 中途刷新过时，条目可能
        // 已不在列表，而 SSE 的路径已经处理过计数，再减一次会少 1（2026-10-02 复审）。
        if (removed && state.assetOverview?.stickers && typeof state.assetOverview.stickers.total === 'number') {
          state.assetOverview.stickers.total = Math.max(0, state.assetOverview.stickers.total - 1);
        }
        // 卡片节点可能已被后续重渲染替换（脱离文档）——此时 remove() 只会删到旧节点、
        // 新卡片成残影；用 isConnected 判活，拿不准就退回重渲染（2026-10-02 复审）。
        if (cardEl && typeof cardEl.remove === 'function' && cardEl.isConnected !== false) {
          cardEl.remove();
          const countEl = document.querySelector('.asset-summary-item[data-asset-kind="stickers"] strong');
          if (countEl) countEl.textContent = fmtTok(state.assetOverview?.stickers?.total ?? 0);
        } else {
          renderAssetObservatory();
        }
      } else if (state.tab === 'identity') {
        state.assetOverview = null;
        state.assetDetail = null;
        await loadIdentityFeaturePage();
      } else {
        await loadAssetObservatory();
      }
      window.scrollTo?.(0, scrollY);
      if (result?.cleanupPending) {
        alert(result.warning || '资产已删除，但图片文件仍待清理');
      }
    } catch (error) {
      alert(`删除失败：${error.message}`);
    } finally {
      if (state.assetDeleteInFlight === inFlight) state.assetDeleteInFlight = null;
    }
  }

function renderAssetObservatory() {
  const box = $('#asset-page');
  if (!box) return;
  const overview = state.assetOverview || {};
  const kind = state.assetKind || 'stickers';
  const slangStatus = state.assetSlangStatus || '';
  const slangResearchState = state.assetSlangResearchState || '';
  let content = '<div class="empty-hint">加载中…</div>';
  if (state.assetDetail) {
    if (kind === 'stickers') content = renderStickerAssets(state.assetDetail);
    if (kind === 'slang') content = renderSlangAssets(state.assetDetail);
    if (kind === 'slang-research') content = renderSlangResearch(state.assetDetail);
  }
  box.innerHTML = `
    <div class="asset-head">
      <div><h2>AI 资产观测</h2><span class="muted">更新于 ${overview.generatedAt ? esc(fmtTime(overview.generatedAt)) : '-'}</span></div>
      <button type="button" class="btn btn-small" id="asset-refresh" title="刷新当前资产" aria-label="刷新当前资产">${iconSvg('refresh', { size: 15 })}<span>刷新</span></button>
    </div>
    ${renderAssetSummary(overview)}
    <div class="asset-toolbar">
      <div class="asset-kinds">
        ${ASSET_KINDS.map(([value, label]) =>
          `<button type="button" class="${kind === value ? 'active' : ''}" data-asset-kind="${value}">${label}</button>`
        ).join('')}
      </div>
      <div class="asset-toolbar-actions">
        ${kind === 'stickers' ? '<button type="button" class="btn btn-small" id="asset-sticker-batch">批量导入并分析</button>' : ''}
        ${kind === 'stickers' ? `<button type="button" class="btn btn-small" id="asset-sticker-select-mode">${state.assetStickerSelectMode ? '退出多选' : '多选管理'}</button>` : ''}
        ${kind === 'slang-research'
          ? ''
          : '<button type="button" class="btn btn-small btn-primary" id="asset-add">＋ 新增</button>'}
        <div class="asset-search">
        <input type="search" id="asset-query" value="${esc(state.assetQuery)}" placeholder="搜索" aria-label="搜索资产" />
        ${kind === 'slang' ? `<select id="asset-slang-status">
          <option value="" ${slangStatus ? '' : 'selected'}>全部状态</option>
          <option value="confirmed" ${slangStatus === 'confirmed' ? 'selected' : ''}>已确认</option>
          <option value="candidate" ${slangStatus === 'candidate' ? 'selected' : ''}>候选</option>
          <option value="rejected" ${slangStatus === 'rejected' ? 'selected' : ''}>已拒绝</option>
        </select>` : ''}
        ${kind === 'slang-research' ? `<select id="asset-slang-research-state">
          <option value="" ${slangResearchState ? '' : 'selected'}>全部阶段</option>
          <option value="pending_research" ${slangResearchState === 'pending_research' ? 'selected' : ''}>待研究审批</option>
          <option value="research_queued,researching" ${slangResearchState === 'research_queued,researching' ? 'selected' : ''}>研究中</option>
          <option value="pending_admission" ${slangResearchState === 'pending_admission' ? 'selected' : ''}>待入库审批</option>
          <option value="admitted_candidate" ${slangResearchState === 'admitted_candidate' ? 'selected' : ''}>已加入候选</option>
          <option value="research_failed,research_interrupted" ${slangResearchState === 'research_failed,research_interrupted' ? 'selected' : ''}>失败或中断</option>
          <option value="research_rejected,admission_rejected" ${slangResearchState === 'research_rejected,admission_rejected' ? 'selected' : ''}>已拒绝</option>
        </select>` : ''}
        <button type="button" class="btn btn-small" id="asset-search-btn">搜索</button>
        </div>
      </div>
    </div>
    ${kind === 'stickers' && state.assetStickerSelectMode ? `<div class="sticker-bulk-toolbar"><label><input id="asset-sticker-select-all" type="checkbox" /> 全选当前列表</label><span id="asset-sticker-selected-count">已选 ${state.assetStickerSelectedIds.length} 项</span><button class="btn btn-small" id="asset-sticker-bulk-analyze" ${state.assetStickerSelectedIds.length ? '' : 'disabled'}>AI 分析并写入</button><button class="btn btn-small btn-danger" id="asset-sticker-bulk-delete" ${state.assetStickerSelectedIds.length ? '' : 'disabled'}>批量删除</button><progress id="asset-sticker-bulk-progress" max="1" value="0" hidden></progress><span id="asset-sticker-bulk-progress-text" aria-live="polite"></span></div>` : ''}
    <div id="asset-content">${content}</div>`;

  $$('#asset-page [data-asset-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      state.assetKind = button.dataset.assetKind;
      state.assetQuery = '';
      state.assetSlangStatus = '';
      state.assetSlangResearchState = '';
      state.assetDetail = null;
      loadAssetObservatory();
    });
  });
  $('#asset-refresh')?.addEventListener('click', () =>
    loadAssetObservatory({ refreshStickers: kind === 'stickers' }));
  $('#asset-add')?.addEventListener('click', () => openAssetEditor(kind));
  $('#asset-sticker-batch')?.addEventListener('click', openStickerBatchImport);
  $('#asset-sticker-select-mode')?.addEventListener('click', () => {
    state.assetStickerSelectMode = !state.assetStickerSelectMode;
    state.assetStickerSelectedIds = [];
    renderAssetObservatory();
  });
  $('#asset-sticker-select-all')?.addEventListener('change', (event) => {
    state.assetStickerSelectedIds = event.target.checked
      ? (state.assetDetail?.entries || []).map((entry) => String(entry.id)) : [];
    renderAssetObservatory();
  });
  $$('#asset-content [data-sticker-select]').forEach((checkbox) => checkbox.addEventListener('change', () => {
    const id = String(checkbox.dataset.stickerSelect);
    const selected = new Set(state.assetStickerSelectedIds || []);
    if (checkbox.checked) selected.add(id); else selected.delete(id);
    state.assetStickerSelectedIds = [...selected];
    const count = $('#asset-sticker-selected-count');
    if (count) count.textContent = `已选 ${selected.size} 项`;
    $('#asset-sticker-bulk-analyze').disabled = selected.size === 0;
    $('#asset-sticker-bulk-delete').disabled = selected.size === 0;
    checkbox.closest('.asset-sticker')?.classList.toggle('selected', checkbox.checked);
  }));
  $('#asset-sticker-bulk-delete')?.addEventListener('click', async () => {
    const ids = [...state.assetStickerSelectedIds];
    if (ids.length && await askForConfirmation(`确定批量删除选中的 ${ids.length} 个表情包？此操作不可撤销。`)) {
      await runStickerBulkAction(ids, '删除中', async (id) => api(`/api/assets/stickers/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }));
    }
  });
  $('#asset-sticker-bulk-analyze')?.addEventListener('click', async () => {
    const ids = [...state.assetStickerSelectedIds];
    if (ids.length) await runStickerBulkAction(ids, 'AI 分析中', async (id) => {
      const result = await api('/api/assets/stickers/analyze', { method: 'POST', body: JSON.stringify({ stickerId: id }) });
      await api(`/api/assets/stickers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(result.metadata) });
    });
  });
  const search = () => {
    state.assetQuery = $('#asset-query')?.value || '';
    state.assetSlangStatus = $('#asset-slang-status')?.value || '';
    state.assetSlangResearchState = $('#asset-slang-research-state')?.value || '';
    loadAssetObservatory();
  };
  $('#asset-search-btn')?.addEventListener('click', search);
  $('#asset-query')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') search();
  });
  $('#asset-slang-status')?.addEventListener('change', search);
  $('#asset-slang-research-state')?.addEventListener('change', search);
  $$('#asset-content .slang-research-action').forEach((button) => {
    button.addEventListener('click', async () => {
      const entry = state.assetDetail?.discoveries?.find((item) =>
        item.id === button.dataset.id);
      if (!entry) return;
      button.disabled = true;
      try {
        await decideSlangResearch(entry, button.dataset.action);
      } catch (error) {
        alert(`操作失败：${error.message}`);
        button.disabled = false;
      }
    });
  });
  $$('#asset-content .asset-edit').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = button.dataset.assetIndex !== undefined
        ? state.assetDetail?.entries?.[Number(button.dataset.assetIndex)]
        : state.assetDetail?.entries?.find((item) =>
            String(item.id ?? item.userId) === String(button.dataset.assetId));
      if (entry) openAssetEditor(kind, entry);
    });
  });
  $$('#asset-content .asset-delete').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = button.dataset.assetIndex !== undefined
        ? state.assetDetail?.entries?.[Number(button.dataset.assetIndex)]
        : state.assetDetail?.entries?.find((item) =>
            String(item.id ?? item.userId) === String(button.dataset.assetId));
      if (entry) deleteAsset(kind, entry, button.closest('.asset-sticker'));
    });
  });
}

async function loadAssetObservatory({ refreshStickers = false } = {}) {
  const box = $('#asset-page');
  if (!box) return;
  const requestId = ++state.assetLoadSeq;
  const kind = state.assetKind;
  const assetQuery = state.assetQuery;
  const slangStatus = state.assetSlangStatus;
  const slangResearchState = state.assetSlangResearchState;
  if (!state.assetOverview) box.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [overview, chats] = await Promise.all([
      api('/api/assets/overview'),
      api('/api/chats').catch(() => ({ chats: [] }))
    ]);
    if (
      state.tab !== 'assets'
      || requestId !== state.assetLoadSeq
      || kind !== state.assetKind
    ) return;
    const query = encodeURIComponent(assetQuery || '');
    let detail;
    if (kind === 'stickers') {
      detail = await api(
        `/api/assets/stickers?limit=200&query=${query}${refreshStickers ? '&refresh=1' : ''}`
      );
    } else if (kind === 'slang') {
      detail = await api(
        `/api/assets/slang?limit=500&query=${query}&status=${encodeURIComponent(slangStatus || '')}`
      );
    } else if (kind === 'slang-research') {
      detail = await api(
        `/api/slang-pilot/discoveries?limit=500&query=${query}&state=${encodeURIComponent(slangResearchState || '')}`
      ).catch((error) => ({
        disabled: true,
        error: error.message,
        discoveries: []
      }));
    } else {
      detail = { entries: [] };
    }
    if (
      state.tab !== 'assets'
      || requestId !== state.assetLoadSeq
      || kind !== state.assetKind
      || assetQuery !== state.assetQuery
      || slangStatus !== state.assetSlangStatus
      || slangResearchState !== state.assetSlangResearchState
    ) return;
    state.assetOverview = overview;
    if (chats.chats?.length) state.chats = chats.chats;
    state.assetDetail = detail;
    renderAssetObservatory();
  } catch (error) {
    if (requestId !== state.assetLoadSeq || state.tab !== 'assets') return;
    box.innerHTML = `<div class="empty-hint">资产读取失败：${esc(error.message)}</div>`;
  }
}

async function decideIncomingFriendRequest(id, decision) {
  const action = decision === 'approve' ? '同意' : '拒绝';
  if (!await askForConfirmation(`${action}这条好友请求？结果未知时系统不会自动重试。`)) return;
  const result = await api(
    `/api/identity-pilot/incoming-friend-requests/${encodeURIComponent(id)}/decision`,
    {
      method: 'POST',
      body: JSON.stringify({ decision })
    }
  );
  await loadFriendFeaturePage();
  const status = $('#friend-feature-state');
  if (status) status.textContent = result.note;
}

async function loadIncomingFriendRequests(status) {
  const box = $('#identity-incoming-friend-requests');
  if (!box) return;
  const feature = status?.incomingFriendRequest || {};
  // 总开关开着、但统一身份库没起来（active=false，比如启动时出错）时，下面这个接口是 409：
  // 直接给提示，别让请求失败把整页（连同设置表单）换成一整块错误信息。
  if (status?.active === false) {
    box.innerHTML = '<div class="empty-hint">统一身份库没有启动：先看页面上提示的启动错误</div>';
    return;
  }
  if (!feature.enabled) {
    box.innerHTML = '<div class="empty-hint">入站好友请求审批当前关闭</div>';
    return;
  }
  let data;
  try {
    data = await api('/api/identity-pilot/incoming-friend-requests?limit=100');
  } catch (error) {
    // 外层是 Promise.allSettled，不再替它兜错：失败要显示在这个框里，
    // 否则页面看起来像"没有好友请求"，而不是"读不到"
    box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    return;
  }
  const requests = data.requests || [];
  if (!requests.length) {
    box.innerHTML = '<div class="empty-hint">当前没有收到好友请求</div>';
    return;
  }
  box.innerHTML = `<table class="identity-pilot-table">
    <thead><tr><th>申请人</th><th>验证消息</th><th>状态</th><th>白名单</th><th>时间</th><th>操作</th></tr></thead>
    <tbody>${requests.map((request) => `<tr>
      <td><strong>${esc(request.primaryName || request.userId)}</strong><small><code>${esc(request.userId)}</code></small></td>
      <td>${esc(request.comment || '（无）')}</td>
      <td>${esc(INCOMING_FRIEND_STATUS[request.status] || request.status)}${request.actionError ? `<small>${esc(request.actionError)}</small>` : ''}</td>
      <td>${request.whitelistApplied ? '已加入' : request.whitelistError ? `<span title="${esc(request.whitelistError)}">失败</span>` : '-'}</td>
      <td>${esc(fmtTime(request.createdAt))}</td>
      <td>${request.status === 'pending'
        ? `<button type="button" class="btn btn-small incoming-friend-decision" data-id="${esc(request.id)}" data-decision="approve">同意</button>
           <button type="button" class="btn btn-small btn-danger incoming-friend-decision" data-id="${esc(request.id)}" data-decision="reject">拒绝</button>`
        : '-'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  box.querySelectorAll('.incoming-friend-decision').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await decideIncomingFriendRequest(button.dataset.id, button.dataset.decision);
      } catch (error) {
        const node = $('#friend-feature-state');
        if (node) node.textContent = `审批失败：${error.message}`;
        button.disabled = false;
      }
    });
  });
}

async function decideFriendProposal(id, decision) {
  const activeDispatch = state.config?.identityPilot?.friendProposal?.activeDispatchEnabled === true;
  const confirmText = activeDispatch
    ? '批准这个好友候选并立即调用 SnowLuma 发送申请？发送结果未知时系统不会自动重试。'
    : '批准这个好友候选？主动发送实验开关未开启，批准后仍需在 QQ 客户端手动添加。';
  if (decision === 'approve' && !await askForConfirmation(confirmText)) {
    return;
  }
  const result = await api(`/api/identity-pilot/friend-proposals/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision })
  });
  await loadFriendFeaturePage();
  const status = $('#friend-feature-state');
  if (status) status.textContent = result.note;
}

async function loadFriendProposals(status) {
  const box = $('#identity-friend-proposals');
  const protocol = $('#identity-friend-protocol');
  if (!box) return;
  const feature = status?.friendProposal || {};
  if (protocol) {
    protocol.textContent = feature.activeDispatchEnabled
      ? `${feature.protocolNote || '主动发送实验协议已开启。'} 仅明确成功才标记已提交；结果未知时禁止自动重试。`
      : '主动发送实验开关已关闭；管理员批准后保留为待手动执行。';
  }
  if (!feature.enabled) {
    box.innerHTML = '<div class="empty-hint">主动好友候选当前关闭</div>';
    return;
  }
  // 同 loadIncomingFriendRequests：身份库没起来时下面两个接口都是 409
  if (status?.active === false) {
    box.innerHTML = '<div class="empty-hint">统一身份库没有启动：先看页面上提示的启动错误</div>';
    return;
  }
  let data;
  try {
    data = await api('/api/identity-pilot/friend-proposals?limit=100');
  } catch (error) {
    box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    return;
  }
  const proposals = data.proposals || [];
  if (!proposals.length) {
    box.innerHTML = '<div class="empty-hint">当前没有好友候选</div>';
    return;
  }
  box.innerHTML = `<table class="identity-pilot-table">
    <thead><tr><th>对象</th><th>理由</th><th>来源</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
    <tbody>${proposals.map((proposal) => `<tr>
      <td><strong>${esc(proposal.primaryName || proposal.userId)}</strong><small><code>${esc(proposal.userId)}</code></small></td>
      <td><strong>${esc(FRIEND_PROPOSAL_REASON[proposal.reasonCode] || proposal.reasonCode)}</strong><small>${esc(proposal.reason)}</small>${proposal.verificationMessage ? `<small>验证：${esc(proposal.verificationMessage)}</small>` : ''}</td>
      <td><code>${esc(proposal.sourceChatKey)}</code></td>
      <td>${esc(FRIEND_PROPOSAL_STATUS[proposal.status] || proposal.status)}${proposal.dispatchError ? `<small>${esc(proposal.dispatchError)}</small>` : ''}</td>
      <td>${esc(fmtTime(proposal.createdAt))}</td>
      <td>${proposal.status === 'pending'
        ? `<button type="button" class="btn btn-small proposal-decision" data-id="${esc(proposal.id)}" data-decision="approve">批准</button>
           <button type="button" class="btn btn-small proposal-decision" data-id="${esc(proposal.id)}" data-decision="reject">拒绝</button>`
        : '-'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  box.querySelectorAll('.proposal-decision').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await decideFriendProposal(button.dataset.id, button.dataset.decision);
      } catch (error) {
        const node = $('#friend-feature-state');
        if (node) node.textContent = `审批失败：${error.message}`;
        button.disabled = false;
      }
    });
  });
}

async function loadFriendOpportunities(status) {
  const box = $('#identity-friend-opportunities');
  if (!box) return;
  const feature = status?.friendProposal || {};
  if (!feature.enabled || feature.mode !== 'triggered') {
    box.innerHTML = '<div class="empty-hint">当前使用提示词提名模式，没有消息触发记录</div>';
    return;
  }
  // 同 loadIncomingFriendRequests：身份库没起来时下面这个接口是 409
  if (status?.active === false) {
    box.innerHTML = '<div class="empty-hint">统一身份库没有启动：先看页面上提示的启动错误</div>';
    return;
  }
  let data;
  try {
    data = await api('/api/identity-pilot/friend-opportunities?limit=100');
  } catch (error) {
    box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    return;
  }
  const opportunities = data.opportunities || [];
  if (!opportunities.length) {
    box.innerHTML = '<div class="empty-hint">尚无抽签或评估记录</div>';
    return;
  }
  box.innerHTML = `<table class="identity-pilot-table">
    <thead><tr><th>对象</th><th>结果</th><th>门槛快照</th><th>抽签</th><th>评分</th><th>时间</th></tr></thead>
    <tbody>${opportunities.map((item) => {
      const eligibility = item.eligibility || {};
      const review = item.review || {};
      return `<tr>
        <td><strong>${esc(item.primaryName || item.userId)}</strong><small><code>${esc(item.userId)}</code> · <code>${esc(item.sourceChatKey)}</code></small></td>
        <td>${esc(FRIEND_OPPORTUNITY_STATUS[item.status] || item.status)}${item.reason ? `<small>${esc(item.reason)}</small>` : ''}</td>
        <td>${fmtTok(eligibility.messageCount || 0)} 条 · ${fmtTok(eligibility.activeDays || 0)} 天 · ${fmtTok(eligibility.directExchanges || 0)} 次双向</td>
        <td>${(Number(item.probability || 0) * 100).toFixed(2)}%<small>随机值 ${Number(item.randomValue || 0).toFixed(4)}</small></td>
        <td>${Number.isFinite(Number(review.score)) ? `${Number(review.score).toFixed(1)} / 100` : '-'}</td>
        <td>${esc(fmtTime(item.createdAt))}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function bindFeatureAssetActions(rootSelector, kind, entries) {
  const root = $(rootSelector);
  if (!root) return;
  $$('.asset-edit', root).forEach((button) => {
    button.addEventListener('click', () => {
      const entry = button.dataset.assetIndex !== undefined
        ? entries[Number(button.dataset.assetIndex)]
        : entries.find((item) =>
            String(item.id ?? item.userId) === String(button.dataset.assetId));
      if (entry) openAssetEditor(kind, entry);
    });
  });
  $$('.asset-delete', root).forEach((button) => {
    button.addEventListener('click', () => {
      const entry = button.dataset.assetIndex !== undefined
        ? entries[Number(button.dataset.assetIndex)]
        : entries.find((item) =>
            String(item.id ?? item.userId) === String(button.dataset.assetId));
      if (entry) deleteAsset(kind, entry, button.closest('.asset-sticker'));
    });
  });
}

function renderIdentityFeaturePageImpl(status, identities, memories, options = {}) {
  const box = $('#identity-page');
  if (!box) return;
  const query = state.identityFeatureQuery || '';
  const __html = `
    <div class="asset-head">
      <div><h2>人物统一印象</h2><span class="muted" id="identity-feature-state">${status.active ? `运行中 · 最近索引 ${status.lastIndexedAt ? esc(fmtTime(status.lastIndexedAt)) : '-'}` : status.enabled ? `启动失败${status.error ? `：${esc(status.error)}` : ''}` : '当前已停用'}</span></div>
      <button type="button" class="btn btn-small" id="identity-feature-refresh" title="刷新人物与旧印象" aria-label="刷新人物与旧印象">${iconSvg('refresh', { size: 15 })}<span>刷新</span></button>
    </div>
    <div class="asset-summary">
      <div class="asset-summary-item"><span>统一人物</span><strong>${fmtTok(status.people)}</strong><small>按 QQ 号跨会话聚合</small></div>
      <div class="asset-summary-item"><span>身份别名</span><strong>${fmtTok(status.aliases)}</strong><small>${fmtTok(status.sources)} 个会话来源</small></div>
      <div class="asset-summary-item"><span>旧印象</span><strong>${fmtTok(status.legacyMemories)}</strong><small>来自现有记忆文件</small></div>
      <div class="asset-summary-item"><span>好友</span><strong>${fmtTok(status.friends)}</strong><small>当前好友关系快照</small></div>
    </div>
    <div class="asset-toolbar">
      <div>
        <strong>统一人物与旧印象</strong>
        <div class="hint">统一人物记录和原始旧印象分别维护，模型只按当前会话权限读取。</div>
      </div>
      <div class="asset-toolbar-actions">
        <button type="button" class="btn btn-small" id="identity-add-person">＋ 人物</button>
        <button type="button" class="btn btn-small" id="identity-add-memory">＋ 旧印象</button>
        <div class="asset-search">
          <input type="search" id="identity-feature-query" value="${esc(query)}" placeholder="搜索人物或印象" aria-label="搜索人物或印象" />
          <button type="button" class="btn btn-small" id="identity-feature-search">搜索</button>
        </div>
      </div>
    </div>
    <section class="settings-card">
      <h3>统一人物</h3>
      <div id="identity-feature-people">${renderIdentityAssets(identities)}</div>
    </section>
    <section class="settings-card">
      <h3>旧印象</h3>
      <div id="identity-feature-memories">${renderMemoryAssets(memories)}</div>
    </section>`;
  if (!setHtmlIfChanged(box, __html, options)) return;

  $('#identity-feature-refresh')?.addEventListener('click', () => loadIdentityFeaturePage());
  const search = () => {
    state.identityFeatureQuery = $('#identity-feature-query')?.value || '';
    // force：搜索框此刻正拿着焦点，不 force 的话这次"用户自己点的搜索"会被焦点守卫挡掉，
    // 结果还是上一批（2026-10-04 复审 P1）
    loadIdentityFeaturePage({ force: true });
  };
  $('#identity-feature-search')?.addEventListener('click', search);
  $('#identity-feature-query')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') search();
  });
  $('#identity-add-person')?.addEventListener('click', () => openAssetEditor('identities'));
  $('#identity-add-memory')?.addEventListener('click', () => openAssetEditor('memory'));
  bindFeatureAssetActions(
    '#identity-feature-people',
    'identities',
    identities.entries || []
  );
  bindFeatureAssetActions(
    '#identity-feature-memories',
    'memory',
    memories.entries || []
  );
}

function renderFriendFeaturePageImpl(c, status) {
  const friend = c.identityPilot?.friendProposal || {};
  const incoming = c.identityPilot?.incomingFriendRequest || {};
  const box = $('#friend-page');
  if (!box) return;
  const triggered = friend.triggered || {};
  const proposalCounts = status.friendProposal?.counts || {};
  const opportunityCounts = status.friendProposal?.opportunityCounts || {};
  const __html = `
    <div class="asset-head">
      <div><h2>好友管理</h2><span class="muted" id="friend-feature-state">${status.active ? '统一身份库运行中' : status.enabled ? '统一身份库启动失败' : '人物统一印象已停用'}</span></div>
      <div class="asset-head-actions">
        <button type="button" class="btn btn-small" id="friend-feature-refresh" title="刷新好友工作流" aria-label="刷新好友工作流">${iconSvg('refresh', { size: 15 })}<span>刷新</span></button>
        <button type="button" class="btn btn-primary btn-small" id="friend-feature-save">保存好友设置</button>
      </div>
    </div>
    <div class="asset-summary">
      <div class="asset-summary-item"><span>主动候选待审批</span><strong>${fmtTok(proposalCounts.pending)}</strong><small>管理员批准后发送</small></div>
      <div class="asset-summary-item"><span>消息触发评估</span><strong>${fmtTok(opportunityCounts.total)}</strong><small>${fmtTok(opportunityCounts.proposed)} 次提名</small></div>
      <div class="asset-summary-item"><span>评估中</span><strong>${fmtTok(opportunityCounts.active)}</strong><small>${fmtTok(opportunityCounts.reviewFailed)} 次失败</small></div>
      <div class="asset-summary-item"><span>好友关系快照</span><strong>${status.friendProposal?.friendStatusTrusted ? '可信' : '不可用'}</strong><small>${status.friendProposal?.friendSnapshotAt ? esc(fmtTime(status.friendProposal.friendSnapshotAt)) : '未知时不触发'}</small></div>
    </div>
    <div class="hint friend-save-result" id="friend-feature-save-result"></div>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>基础设置</h3><span class="muted">主动加好友已退役（Issue #10），以下主动配置不再生效；入站好友请求审批不受影响</span></div>
      </div>
      <div class="field-row">
        <!-- 管理员 QQ 的唯一编辑入口在「设置 → 模型 API → 全局管理员 QQ」：这里从第一次渲染起
             就是"提示 + hidden 镜像"，DOM 不再变化（原来渲染真输入框、随后被 stable-features 换成
             hidden，于是"切走再回来这一格就没了"）。保存路径读的仍是 #cfg-identity-friend-owner。 -->
        <div class="field"><label>好友审批管理员 QQ</label>
          <span class="hint" style="margin:0">统一在「设置 → 模型 API → 全局管理员 QQ」里配置
            <button type="button" class="link-btn" data-open-settings="api">去设置</button></span>
          <input type="hidden" id="cfg-identity-friend-owner" data-global-admin-mirror="true" value="${esc(friend.ownerUin || '')}" /></div>
        <div class="field"><label>候选生成模式</label><select id="cfg-identity-friend-mode"><option value="triggered" ${friend.mode === 'triggered' ? 'selected' : ''}>消息触发评估</option><option value="prompt" ${friend.mode !== 'triggered' ? 'selected' : ''}>旧版提示词提名</option></select></div>
        <div class="field"><label>旧模式最低累计消息</label><input type="number" id="cfg-identity-friend-min-messages" min="1" max="10000" value="${esc(friend.minMessageCount ?? 50)}" /></div>
        <div class="field"><label>同一用户冷却天数</label><input type="number" id="cfg-identity-friend-cooldown" min="1" max="365" value="${esc(friend.cooldownDays ?? 30)}" /></div>
        <div class="field"><label>主动候选待审批上限</label><input type="number" id="cfg-identity-friend-max-pending" min="1" max="100" value="${esc(friend.maxPending ?? 10)}" /></div>
      </div>
      <div class="checkbox-row switch-row">
        <input type="checkbox" id="cfg-identity-friend-dispatch" ${friend.activeDispatchEnabled === true ? 'checked' : ''} />
        <label for="cfg-identity-friend-dispatch">管理员批准后主动发送好友申请</label>
      </div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>触发条件</h3><span class="muted">消息进入评估队列前先过这些门槛</span></div>
      </div>
      <div class="field-row">
        <div class="field"><label>抽签概率（%）</label><input type="number" id="cfg-friend-trigger-probability" min="0" max="100" step="0.1" value="${esc((Number(triggered.probability ?? 0.05) * 100).toFixed(1))}" /></div>
        <div class="field"><label>统计窗口（天）</label><input type="number" id="cfg-friend-trigger-history-days" min="1" max="365" value="${esc(triggered.historyDays ?? 30)}" /></div>
        <div class="field"><label>最低有效发言</label><input type="number" id="cfg-friend-trigger-min-messages" min="0" max="10000" value="${esc(triggered.minMessages ?? 50)}" /></div>
        <div class="field"><label>最低活跃日</label><input type="number" id="cfg-friend-trigger-min-days" min="0" max="365" value="${esc(triggered.minActiveDays ?? 3)}" /></div>
        <div class="field"><label>最低双向交流</label><input type="number" id="cfg-friend-trigger-min-exchanges" min="0" max="1000" value="${esc(triggered.minDirectExchanges ?? 3)}" /></div>
        <div class="field"><label>触发消息最长延迟（分钟）</label><input type="number" id="cfg-friend-trigger-max-age" min="1" max="1440" value="${esc(triggered.maxTriggerAgeMinutes ?? 10)}" /></div>
        <div class="field"><label>好友快照最长缓存（分钟）</label><input type="number" id="cfg-friend-trigger-friend-age" min="1" max="1440" value="${esc(triggered.friendStatusMaxAgeMinutes ?? 15)}" /></div>
      </div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>频率与配额</h3><span class="muted">冷却、每日额度与提名分数线</span></div>
      </div>
      <div class="field-row">
        <div class="field"><label>抽签冷却（分钟）</label><input type="number" id="cfg-friend-trigger-draw-cooldown" min="1" max="10080" value="${esc(triggered.drawCooldownMinutes ?? 30)}" /></div>
        <div class="field"><label>每人每日抽签上限</label><input type="number" id="cfg-friend-trigger-max-draws" min="1" max="1000" value="${esc(triggered.maxDrawsPerUserPerDay ?? 6)}" /></div>
        <div class="field"><label>每日模型评估上限</label><input type="number" id="cfg-friend-trigger-max-reviews" min="0" max="1000" value="${esc(triggered.maxReviewsPerDay ?? 10)}" /></div>
        <div class="field"><label>提名分数线</label><input type="number" id="cfg-friend-trigger-threshold" min="0" max="100" value="${esc(triggered.scoreThreshold ?? 70)}" /></div>
        <div class="field"><label>模型跳过冷却（天）</label><input type="number" id="cfg-friend-trigger-skip-cooldown" min="0" max="365" value="${esc(triggered.skipCooldownDays ?? 7)}" /></div>
        <div class="field"><label>评估失败冷却（分钟）</label><input type="number" id="cfg-friend-trigger-error-cooldown" min="1" max="10080" value="${esc(triggered.errorCooldownMinutes ?? 60)}" /></div>
        <div class="field"><label>评估排队期限（秒）</label><input type="number" id="cfg-friend-trigger-queue-age" min="5" max="3600" value="${esc(triggered.maxQueueAgeSeconds ?? 120)}" /></div>
      </div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>评分权重</h3><span class="muted">四项权重共同决定提名分数</span></div>
      </div>
      <div class="field-row">
        <div class="field"><label>互动质量权重</label><input type="number" id="cfg-friend-weight-quality" min="0" max="100" value="${esc(triggered.weights?.quality ?? 40)}" /></div>
        <div class="field"><label>交流意愿权重</label><input type="number" id="cfg-friend-weight-interest" min="0" max="100" value="${esc(triggered.weights?.interest ?? 30)}" /></div>
        <div class="field"><label>双向投入权重</label><input type="number" id="cfg-friend-weight-reciprocity" min="0" max="100" value="${esc(triggered.weights?.reciprocity ?? 20)}" /></div>
        <div class="field"><label>关系稳定权重</label><input type="number" id="cfg-friend-weight-stability" min="0" max="100" value="${esc(triggered.weights?.stability ?? 10)}" /></div>
      </div>
      <div class="hint">已经是好友的用户不会进入抽签或模型评估；好友状态无法确认时同样不会触发。四项权重合计必须为 100。</div>
    </section>
    <section class="settings-card">
      <h3>入站好友请求</h3>
      <div class="field-row">
        <div class="field"><label>入站请求待审批上限</label><input type="number" id="cfg-identity-incoming-max-pending" min="1" max="500" value="${esc(incoming.maxPending ?? 50)}" /></div>
      </div>
      <div class="checkbox-row switch-row">
        <input type="checkbox" id="cfg-identity-incoming-auto-whitelist" ${incoming.autoWhitelist !== false ? 'checked' : ''} />
        <label for="cfg-identity-incoming-auto-whitelist">同意或确认成为好友后自动加入私聊白名单</label>
      </div>
      <div class="hint" id="identity-friend-protocol">${esc(status.friendProposal?.protocolNote || '')}</div>
    </section>
    <section class="settings-card" id="identity-incoming-friend-box">
      <h3>收到的好友请求</h3>
      <div class="identity-pilot-people" id="identity-incoming-friend-requests"></div>
    </section>
    <section class="settings-card" id="identity-friend-proposal-box">
      <h3>主动好友候选</h3>
      <div class="identity-pilot-people" id="identity-friend-proposals"></div>
    </section>
    <section class="settings-card" id="identity-friend-opportunity-box">
      <h3>消息触发与评估记录</h3>
      <div class="identity-pilot-people" id="identity-friend-opportunities"></div>
    </section>`;
  if (!setHtmlIfChanged(box, __html)) return;
  $('#friend-feature-refresh')?.addEventListener('click', () => loadFriendFeaturePage());
  $('#friend-feature-save')?.addEventListener('click', saveFriendFeatureConfig);
}

async function saveFriendFeatureConfig() {
  const c = state.config || await api('/api/config');
  const result = $('#friend-feature-save-result');
  const patch = {
    identityPilot: identityPilotSettingsPatch(
      c,
      c.identityPilot?.enabled === true,
      {
        ownerUin: $('#cfg-identity-friend-owner')?.value?.trim() || '',
        mode: $('#cfg-identity-friend-mode')?.value === 'prompt' ? 'prompt' : 'triggered',
        activeDispatchEnabled: $('#cfg-identity-friend-dispatch')?.checked === true,
        minMessageCount: clampInt($('#cfg-identity-friend-min-messages')?.value, 1, 10000, 50),
        cooldownDays: clampInt($('#cfg-identity-friend-cooldown')?.value, 1, 365, 30),
        maxPending: clampInt($('#cfg-identity-friend-max-pending')?.value, 1, 100, 10),
        triggered: {
          ...(c.identityPilot?.friendProposal?.triggered || {}),
          probability: Math.min(1, Math.max(0, Number($('#cfg-friend-trigger-probability')?.value) / 100 || 0)),
          historyDays: clampInt($('#cfg-friend-trigger-history-days')?.value, 1, 365, 30),
          minMessages: clampInt($('#cfg-friend-trigger-min-messages')?.value, 0, 10000, 50),
          minActiveDays: clampInt($('#cfg-friend-trigger-min-days')?.value, 0, 365, 3),
          minDirectExchanges: clampInt($('#cfg-friend-trigger-min-exchanges')?.value, 0, 1000, 3),
          maxTriggerAgeMinutes: clampInt($('#cfg-friend-trigger-max-age')?.value, 1, 1440, 10),
          friendStatusMaxAgeMinutes: clampInt($('#cfg-friend-trigger-friend-age')?.value, 1, 1440, 15),
          drawCooldownMinutes: clampInt($('#cfg-friend-trigger-draw-cooldown')?.value, 1, 10080, 30),
          maxDrawsPerUserPerDay: clampInt($('#cfg-friend-trigger-max-draws')?.value, 1, 1000, 6),
          maxReviewsPerDay: clampInt($('#cfg-friend-trigger-max-reviews')?.value, 0, 1000, 10),
          skipCooldownDays: clampInt($('#cfg-friend-trigger-skip-cooldown')?.value, 0, 365, 7),
          errorCooldownMinutes: clampInt($('#cfg-friend-trigger-error-cooldown')?.value, 1, 10080, 60),
          maxQueueAgeSeconds: clampInt($('#cfg-friend-trigger-queue-age')?.value, 5, 3600, 120),
          scoreThreshold: clampInt($('#cfg-friend-trigger-threshold')?.value, 0, 100, 70),
          weights: {
            quality: clampInt($('#cfg-friend-weight-quality')?.value, 0, 100, 40),
            interest: clampInt($('#cfg-friend-weight-interest')?.value, 0, 100, 30),
            reciprocity: clampInt($('#cfg-friend-weight-reciprocity')?.value, 0, 100, 20),
            stability: clampInt($('#cfg-friend-weight-stability')?.value, 0, 100, 10)
          }
        }
      },
      {
        autoWhitelist: $('#cfg-identity-incoming-auto-whitelist')?.checked !== false,
        maxPending: clampInt($('#cfg-identity-incoming-max-pending')?.value, 1, 500, 50)
      }
    )
  };
  if (result) result.textContent = '保存中…';
  try {
    const response = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(patch)
    });
    state.config = response.config;
    syncGraduatedFeatureNavigation(state.config);
    await loadFriendFeaturePage();
  } catch (error) {
    if (result) result.textContent = `保存失败：${error.message}`;
  }
}

function renderSlangFeaturePage(c, status) {
  const box = $('#slang-page');
  if (!box) return;
  const slang = c.slangPilot || {};
  const __html = `
    <div class="asset-head">
      <div><h2>黑话研究</h2><span class="muted">${status.active ? `运行中 · 待研究 ${fmtTok(status.pendingResearch)} · 待入库 ${fmtTok(status.pendingAdmission)}` : status.enabled ? `启动失败${status.error ? `：${esc(status.error)}` : ''}` : '当前已停用'}</span></div>
      <button type="button" class="btn btn-small" id="slang-feature-refresh" title="刷新黑话状态" aria-label="刷新黑话状态">${iconSvg('refresh', { size: 15 })}<span>刷新</span></button>
    </div>
    <section class="control-section">
      <div class="control-section-title">
        <div><h3>研究设置</h3><span class="muted">启停由“设置 → 实验功能”统一控制</span></div>
        <button type="button" class="btn btn-primary btn-small" id="slang-feature-save">保存研究设置</button>
      </div>
      <div class="field-row">
        <div class="field"><label>审批管理员 QQ</label>
          <span class="hint" style="margin:0">统一在「设置 → 模型 API → 全局管理员 QQ」里配置
            <button type="button" class="link-btn" data-open-settings="api">去设置</button></span>
          <input type="hidden" id="cfg-slang-owner" data-global-admin-mirror="true" value="${esc(slang.ownerUin || c.identityPilot?.friendProposal?.ownerUin || '')}" /></div>
        <div class="field"><label>最少出现次数</label><input type="number" id="cfg-slang-min-occurrences" min="2" max="20" value="${esc(slang.minOccurrences ?? 3)}" /></div>
        <div class="field"><label>最少发言人数</label><input type="number" id="cfg-slang-min-speakers" min="1" max="20" value="${esc(slang.minSpeakers ?? 2)}" /></div>
        <div class="field"><label>统计窗口（小时）</label><input type="number" id="cfg-slang-window-hours" min="1" max="720" value="${esc(slang.windowHours ?? 72)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>待处理总上限</label><input type="number" id="cfg-slang-max-pending" min="1" max="500" value="${esc(slang.maxPending ?? 100)}" /></div>
        <div class="field"><label>每群每日新增上限</label><input type="number" id="cfg-slang-daily-limit" min="1" max="50" value="${esc(slang.perChatDailyLimit ?? 5)}" /></div>
        <div class="field"><label>拒绝冷却天数</label><input type="number" id="cfg-slang-reject-cooldown" min="1" max="365" value="${esc(slang.rejectCooldownDays ?? 14)}" /></div>
        <div class="field"><label>每词证据上限</label><input type="number" id="cfg-slang-max-evidence" min="3" max="30" value="${esc(slang.maxEvidence ?? 12)}" /></div>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="cfg-slang-web-research" ${slang.webResearch !== false ? 'checked' : ''} />
        <label for="cfg-slang-web-research">管理员批准后联网研究</label>
      </div>
      <div class="field-row">
        <div class="field"><label>搜索结果上限</label><input type="number" id="cfg-slang-search-results" min="1" max="10" value="${esc(slang.maxSearchResults ?? 5)}" /></div>
        <div class="field"><label>正文抓取页数</label><input type="number" id="cfg-slang-fetch-pages" min="0" max="3" value="${esc(slang.maxFetchPages ?? 2)}" /></div>
        <div class="field"><label>格式纠正轮数</label><input type="number" id="cfg-slang-research-rounds" min="1" max="3" value="${esc(slang.maxResearchRounds ?? 2)}" /></div>
      </div>
      <div class="settings-actions">
        <button type="button" class="btn btn-small" data-open-slang-assets="slang-research">查看研究队列</button>
        <button type="button" class="btn btn-small" data-open-slang-assets="slang">查看黑话资产</button>
        <span class="hint" id="slang-feature-save-result"></span>
      </div>
    </section>`;
  if (!setHtmlIfChanged(box, __html)) return;
  $('#slang-feature-refresh')?.addEventListener('click', () => loadSlangFeaturePage());
  $('#slang-feature-save')?.addEventListener('click', saveSlangFeatureConfig);
  $$('[data-open-slang-assets]', box).forEach((button) => {
    button.addEventListener('click', () => {
      state.assetKind = button.dataset.openSlangAssets;
      state.assetDetail = null;
      switchTab('assets');
    });
  });
}

async function saveSlangFeatureConfig() {
  const c = state.config || await api('/api/config');
  const value = (selector, fallback = '') => $(selector)?.value ?? fallback;
  const patch = {
    slangPilot: {
      ...(c.slangPilot || {}),
      ownerUin: value('#cfg-slang-owner').trim(),
      minOccurrences: clampInt(value('#cfg-slang-min-occurrences'), 2, 20, 3),
      minSpeakers: clampInt(value('#cfg-slang-min-speakers'), 1, 20, 2),
      windowHours: clampInt(value('#cfg-slang-window-hours'), 1, 720, 72),
      maxPending: clampInt(value('#cfg-slang-max-pending'), 1, 500, 100),
      perChatDailyLimit: clampInt(value('#cfg-slang-daily-limit'), 1, 50, 5),
      rejectCooldownDays: clampInt(value('#cfg-slang-reject-cooldown'), 1, 365, 14),
      maxEvidence: clampInt(value('#cfg-slang-max-evidence'), 3, 30, 12),
      webResearch: $('#cfg-slang-web-research')?.checked !== false,
      maxSearchResults: clampInt(value('#cfg-slang-search-results'), 1, 10, 5),
      maxFetchPages: clampInt(value('#cfg-slang-fetch-pages'), 0, 3, 2),
      maxResearchRounds: clampInt(value('#cfg-slang-research-rounds'), 1, 3, 2)
    }
  };
  const result = $('#slang-feature-save-result');
  if (result) result.textContent = '保存中…';
  try {
    const response = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(patch)
    });
    state.config = response.config;
    syncGraduatedFeatureNavigation(state.config);
    await loadSlangFeaturePage();
  } catch (error) {
    if (result) result.textContent = `保存失败：${error.message}`;
  }
}

async function loadSlangFeaturePage() {
  const box = $('#slang-page');
  if (!box) return;
  box.__renderedHtml = null;   // 与 setBoxError 同理：直接写 innerHTML 就得清去重缓存，
  box.innerHTML = '<div class="empty-hint">正在读取黑话研究配置…</div>';   // 否则下轮 HTML 与缓存相同会被跳过
  try {
    const [cfg, status] = await Promise.all([
      api('/api/config'),
      api('/api/slang-pilot/status')
    ]);
    if (state.tab !== 'slang') return;
    state.config = cfg;
    syncGraduatedFeatureNavigation(cfg);
    renderSlangFeaturePage(cfg, status);
  } catch (error) {
    setBoxError(box, `<div class="empty-hint">黑话研究读取失败：${esc(error.message)}</div>`);
  }
}

function renderIncidentFeaturePageImpl(c, status, incidents = [], options = {}) {
  const box = $('#incident-page');
  if (!box) return;
  const settings = c.incidentPilot || {};
  const counts = status.counts || {};
  const __html = `
    <div class="asset-head">
      <div><h2>异常</h2><span class="muted">${status.active ? '异常处理试点运行中' : status.exists ? '试点已停用，保留只读日志' : '异常处理试点尚未启用'}</span></div>
      <button type="button" class="btn btn-small" id="incident-feature-refresh" title="刷新异常" aria-label="刷新异常">${iconSvg('refresh', { size: 15 })}<span>刷新</span></button>
    </div>
    <div class="asset-summary">
      <div class="asset-summary-item"><span>待处理</span><strong>${fmtTok(counts.open)}</strong><small>尚未确认或解决</small></div>
      <div class="asset-summary-item"><span>严重</span><strong>${fmtTok(counts.critical)}</strong><small>未解决严重异常</small></div>
      <div class="asset-summary-item"><span>已确认</span><strong>${fmtTok(counts.acknowledged)}</strong><small>已看到，尚未解决</small></div>
      <div class="asset-summary-item"><span>告警待发送</span><strong>${fmtTok(status.pendingNotifications)}</strong><small>OneBot 恢复后发送</small></div>
    </div>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>告警与策略</h3><span class="muted">启停由“设置 → 实验功能”统一控制</span></div>
        <button type="button" class="btn btn-primary btn-small" id="incident-feature-save">保存异常设置</button>
      </div>
      <div class="field-row">
        <div class="field"><label>告警管理员 QQ</label>
          <span class="hint" style="margin:0">统一在「设置 → 模型 API → 全局管理员 QQ」里配置
            <button type="button" class="link-btn" data-open-settings="api">去设置</button></span>
          <input type="hidden" id="cfg-incident-owner" data-global-admin-mirror="true" value="${esc(settings.ownerUin || '')}" /></div>
        <div class="field"><label>同类异常合并窗口（分钟）</label><input type="number" id="cfg-incident-window" min="1" max="1440" value="${esc(settings.duplicateWindowMinutes ?? 10)}" /></div>
        <div class="field"><label>已解决日志保留天数</label><input type="number" id="cfg-incident-retention" min="1" max="3650" value="${esc(settings.retentionDays ?? 90)}" /></div>
        <div class="field"><label>未知写入自动释放（天，0=关闭）</label><input type="number" id="cfg-outbox-auto-release" min="0" max="90" value="${esc(state.config?.outbox?.unknownAutoReleaseDays ?? 0)}" /></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-incident-warnings" ${settings.notifyWarnings !== false ? 'checked' : ''} />
        <label for="cfg-incident-warnings">警告级异常也通知管理员</label></div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-incident-unknown-block" ${settings.unknownWritesBlockChat === true ? 'checked' : ''} />
        <label for="cfg-incident-unknown-block">未知写入阻塞整个会话（兼容旧策略）</label></div>
      <div class="hint">关闭兼容策略后，未知旧写入仍不重试，但新消息可以继续处理。</div>
      <div class="hint" id="incident-feature-save-result"></div>
    </section>
    <section class="settings-card">
      <div class="control-section-title">
        <div><h3>异常日志</h3><span class="muted">删除日志不会解除未知写入或改变会话状态</span></div>
        <div class="settings-actions" style="margin:0">
          <input type="text" id="incident-search" placeholder="搜索异常 / 会话 / 代码" aria-label="搜索异常" value="${esc(state.incidentQuery || '')}" />
          <select id="incident-state-filter" aria-label="异常状态">
            <option value="">全部状态</option>
            ${Object.entries(INCIDENT_STATE_LABELS).map(([value, label]) =>
              `<option value="${value}" ${state.incidentState === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <select id="incident-severity-filter" aria-label="异常等级">
            <option value="">全部等级</option>
            ${Object.entries(INCIDENT_SEVERITY_LABELS).map(([value, label]) =>
              `<option value="${value}" ${state.incidentSeverity === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="table-wrap"><table class="usage-table incident-table">
        <thead><tr><th>时间</th><th>等级</th><th>来源</th><th>会话</th><th>异常</th><th>次数</th><th>状态</th><th></th></tr></thead>
        <tbody>${incidents.map((incident) => `<tr>
          <td>${esc(fmtTime(incident.lastAt))}</td>
          <td><span class="incident-severity severity-${esc(incident.severity)}">${esc(INCIDENT_SEVERITY_LABELS[incident.severity] || incident.severity)}</span></td>
          <td>${esc(incident.source || '-')}</td>
          <td>${esc(incident.chatKey || '-')}</td>
          <td><details><summary>${esc(String(incident.message || incident.code || '').slice(0, 160))}${String(incident.message || '').length > 160 ? ' …（点开看全文）' : ''}</summary>
            <div class="incident-detail"><code>${esc(incident.code)}</code>
              ${incident.sessionId ? `<div>Session：${esc(incident.sessionId)}</div>` : ''}
              ${incident.operationId ? `<div>Operation：${esc(incident.operationId)}</div>` : ''}
              ${incident.notifyError ? `<div>告警：${esc(incident.notifyError)}</div>` : ''}
              ${incident.resolution ? `<div>处理：${esc(incident.resolution)}</div>` : ''}
            </div></details></td>
          <td>${fmtTok(incident.count)}</td>
          <td>${esc(INCIDENT_STATE_LABELS[incident.state] || incident.state)}</td>
          <td><div class="settings-actions incident-actions">
            ${incident.state === 'open' ? `<button type="button" class="btn btn-small" data-incident-ack="${esc(incident.id)}">确认</button>` : ''}
            ${incident.state !== 'resolved' ? `<button type="button" class="btn btn-small" data-incident-resolve="${esc(incident.id)}">解决</button>` : ''}
            ${incident.state === 'resolved' ? `<button type="button" class="icon-btn" data-incident-delete="${esc(incident.id)}" title="删除日志" aria-label="删除日志">×</button>` : ''}
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${incidents.length ? '' : '<div class="empty-hint">当前筛选条件下没有异常日志</div>'}
    </section>`;
  if (!setHtmlIfChanged(box, __html, options)) return;

  $('#incident-feature-refresh')?.addEventListener('click', () => loadIncidentFeaturePage());
  $('#incident-feature-save')?.addEventListener('click', saveIncidentFeatureConfig);
  // force：选完筛选项焦点还在这个 <select> 上，不 force 的话表格不刷新 —— 用户看到的是
  // "筛选完全没反应"，而这一屏此刻正把没筛选的那批行当筛选结果看（2026-10-04 复审 P1）
  $('#incident-search')?.addEventListener('change', (event) => {
    state.incidentQuery = String(event.target.value || '').trim();
    loadIncidentFeaturePage({ force: true });
  });
  $('#incident-state-filter')?.addEventListener('change', (event) => {
    state.incidentState = event.target.value;
    loadIncidentFeaturePage({ force: true });
  });
  $('#incident-severity-filter')?.addEventListener('change', (event) => {
    state.incidentSeverity = event.target.value;
    loadIncidentFeaturePage({ force: true });
  });
  // 三个动作都要"失败看得见"：原来没有 try/catch，请求一失败就只剩一条控制台报错 ——
  // 按钮点了没反应、行还挂着"待处理"，用户只会以为界面卡了（2026-10-08 审查）。
  // 与同文件里的保存动作同一口径：出错弹一句原文，成功后重拉列表。
  const incidentAction = (selector, run) => {
    $$(selector, box).forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await run(button);
      } catch (error) {
        alert(error?.message || String(error));
      } finally {
        button.disabled = false;
      }
    }));
  };
  incidentAction('[data-incident-ack]', async (button) => {
    await api(`/api/incidents/${encodeURIComponent(button.dataset.incidentAck)}/acknowledge`, {
      method: 'POST', body: '{}'
    });
    loadIncidentFeaturePage();
  });
  incidentAction('[data-incident-resolve]', async (button) => {
    const resolution = prompt('填写处理结果');
    if (!resolution?.trim()) return;
    await api(`/api/incidents/${encodeURIComponent(button.dataset.incidentResolve)}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolution: resolution.trim() })
    });
    loadIncidentFeaturePage();
  });
  incidentAction('[data-incident-delete]', async (button) => {
    if (!await askForConfirmation('删除这条已解决的异常日志？业务状态和 Session 不会被删除。')) return;
    await api(`/api/incidents/${encodeURIComponent(button.dataset.incidentDelete)}`, {
      method: 'DELETE', body: JSON.stringify({ confirm: true })
    });
    loadIncidentFeaturePage();
  });
}

async function saveIncidentFeatureConfig() {
  const c = state.config || await api('/api/config');
  const result = $('#incident-feature-save-result');
  if (result) result.textContent = '保存中…';
  try {
    const response = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        incidentPilot: {
          ...(c.incidentPilot || {}),
          ownerUin: $('#cfg-incident-owner')?.value?.trim() || '',
          notifyWarnings: $('#cfg-incident-warnings')?.checked !== false,
          unknownWritesBlockChat: $('#cfg-incident-unknown-block')?.checked === true,
          duplicateWindowMinutes: clampInt($('#cfg-incident-window')?.value, 1, 1440, 10),
          retentionDays: clampInt($('#cfg-incident-retention')?.value, 1, 3650, 90)
        },
        // 超期自动释放是独立配置段：默认 0（关闭），开启前要明确知道“未确认也按已发送留痕”。
        outbox: {
          ...(c.outbox || {}),
          unknownAutoReleaseDays: clampInt($('#cfg-outbox-auto-release')?.value, 0, 90, 0)
        }
      })
    });
    state.config = response.config;
    await loadIncidentFeaturePage();
  } catch (error) {
    if (result) result.textContent = `保存失败：${error.message}`;
  }
}

// 由 ui/core/widgets.js 机械拆出（2026-10-01，同一次「UI 结构治理」：把混装的叶子按域归位）。
// 从 app.js 机械切出（只切不改，语句逐字节一致）；跨文件引用走 import，可变状态挂 state。

async function loadExperimentalFeatureStatuses() {
  const identityNode = $('#experiment-identity-state');
  const friendNode = $('#experiment-auto-friend-state');
  const slangNode = $('#slang-pilot-state');
  const incidentNode = $('#incident-pilot-state');
  const livingNode = $('#living-memory-state');
  const livingBadge = $('#living-memory-badge');
  const [identityResult, slangResult, incidentResult, livingResult] = await Promise.allSettled([
      api('/api/identity-pilot/status'),
      api('/api/slang-pilot/status'),
      api('/api/incident-pilot/status'),
      api('/api/living-memory/status')
  ]);
  if (identityResult.status === 'fulfilled') {
    const identity = identityResult.value;
    if (identityNode) {
      identityNode.textContent = `${identity.active ? '运行中' : identity.enabled ? '启动失败' : '已停用'} · ${state.config?.identityPilot?.graduated === true ? '已固化' : '实验中'}`;
    }
    if (friendNode) {
      const active = identity.active
        && identity.friendProposal?.enabled === true
        && identity.incomingFriendRequest?.enabled === true;
      friendNode.textContent = `${active ? '运行中' : '已停用'} · ${state.config?.identityPilot?.friendProposal?.graduated === true ? '已固化' : '实验中'}`;
    }
  } else {
    for (const node of [identityNode, friendNode]) {
      if (node) node.textContent = `状态读取失败：${identityResult.reason?.message || identityResult.reason}`;
    }
  }
  if (slangNode && slangResult.status === 'fulfilled') {
    const slang = slangResult.value;
    slangNode.textContent = `${slang.active ? '运行中' : slang.enabled ? '启动失败' : '已停用'} · ${state.config?.slangPilot?.graduated === true ? '已固化' : '实验中'}`;
  } else if (slangNode) {
    slangNode.textContent = `状态读取失败：${slangResult.reason?.message || slangResult.reason}`;
  }
  if (incidentNode && incidentResult.status === 'fulfilled') {
    const incident = incidentResult.value;
    incidentNode.textContent =
      `${incident.active ? '运行中' : incident.enabled ? '启动失败' : '已停用'} · `
      + `${state.config?.incidentPilot?.graduated === true ? '已固化' : '实验中'}`;
  } else if (incidentNode) {
    incidentNode.textContent =
      `状态读取失败：${incidentResult.reason?.message || incidentResult.reason}`;
  }
  if (livingNode && livingResult.status === 'fulfilled') {
    const payload = livingResult.value || {};
    const cfg = payload.config || state.config?.livingMemory || {};
    const status = payload.status || {};
    const active = Number(status.stats?.active) || 0;
    const mode = cfg.graduated === true ? '已固化' : '实验中';
    if (livingBadge) {
      livingBadge.textContent = mode;
      livingBadge.classList.toggle('is-solid', cfg.graduated === true);
    }
    if (status.ok === false) {
      livingNode.textContent = `初始化失败：${status.error || '未知错误'}`;
    } else {
      const running = cfg.enabled !== true ? '已停用' : status.initialized === false ? '等待首条记忆' : '运行中';
      const recall = cfg.mode === 'active' ? '注入模式' : '影子模式';
      livingNode.textContent = `${running} · ${recall} · ${active} 条活跃记忆`;
    }
  } else if (livingNode) {
    livingNode.textContent = `状态读取失败：${livingResult.reason?.message || livingResult.reason}`;
  }
}


export {
  loadAssetObservatory, loadExperimentalFeatureStatuses, loadFriendOpportunities, loadFriendProposals,
  loadIncomingFriendRequests, loadSlangFeaturePage, renderAssetObservatory, renderFriendFeaturePageImpl,
  renderIdentityFeaturePageImpl, renderIncidentFeaturePageImpl
};
