// 会话详情里的“最近决策记录”：读取 /api/chats/decisions 的历史，而不是只看内存里的最后一条。
import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { fmtTime } from '../core/format.js';
import { state } from '../core/state.js';

function outcomeLabel(outcome) {
  if (outcome === 'skipped') return '未回复';
  if (outcome === 'replied') return '已回复';
  if (outcome === 'noreply') return '运行了但未发言';
  return outcome || '已处理';
}

function itemHtml(decision) {
  const hits = [];
  if (decision.hits?.atMe) hits.push('@我');
  if (decision.hits?.pokeMe) hits.push('拍一拍');
  if (decision.hits?.replyToMe) hits.push('引用我');
  if (decision.hits?.keyword) hits.push('关键词');
  if (decision.hits?.probability) hits.push('概率');
  const burst = decision.burst?.burstGroups ? ` · 合并 ${esc(decision.burst.burstMessages)} 条连发` : '';
  return `<div class="chat-decision"><strong>${esc(fmtTime(decision.at))} · ${esc(outcomeLabel(decision.outcome))}</strong>
    <span>${esc(decision.reason || '未触发')} · 档位 ${esc(decision.tier ?? '-')} · 概率 ${esc(decision.percent ?? 0)}% · 待处理 ${esc(decision.pendingCount ?? 0)} 条${hits.length ? ` · 命中 ${esc(hits.join('/'))}` : ''}${burst}</span></div>`;
}

async function loadChatDecisionHistory(key) {
  const host = document.querySelector('#chat-decision-history');
  if (!host || !key) return;
  try {
    const data = await api(`/api/chats/decisions?chatKey=${encodeURIComponent(key)}&limit=10`);
    if (state.currentChatKey !== key) return;
    const items = Array.isArray(data.decisions) ? data.decisions : [];
    const body = host.querySelector('[data-chat-decisions]');
    if (body) body.innerHTML = items.length ? items.map(itemHtml).join('') : '<div class="hint">暂无决策记录</div>';
  } catch (error) {
    if (state.currentChatKey !== key) return;
    const body = host.querySelector('[data-chat-decisions]');
    if (body) body.innerHTML = `<div class="hint">读取最近决策失败：${esc(error.message)}</div>`;
  }
}

export { loadChatDecisionHistory };

// <details> 的 toggle 不冒泡，用捕获阶段监听；展开时补一次最新历史。
document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (details?.id !== 'chat-decision-history' || !details.open) return;
  void loadChatDecisionHistory(state.currentChatKey);
}, true);
