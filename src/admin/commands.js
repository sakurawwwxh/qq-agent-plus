// 管理员私聊固定命令。只有全局管理员在私聊里发真实消息时才会命中；
// 这里不经过模型，避免“模型理解成别的意思”把群发指令做错。
import { adminOwnerUin } from '../core/config.js';


function stripCq(text) {
  return String(text || '').replace(/\[CQ:[^\]]*\]/g, '').trim();
}

/** 命令文本优先取 message 里的 text 段；message_format=string 时剥掉 CQ 码。 */
function eventText(event) {
  if (Array.isArray(event?.message)) {
    const text = event.message
      .filter((seg) => seg?.type === 'text')
      .map((seg) => String(seg?.data?.text || ''))
      .join('');
    if (text.trim()) return text;
  }
  return stripCq(event?.raw_message || event?.message || '');
}

function extractReplyMid(event) {
  const segments = Array.isArray(event?.message) ? event.message : [];
  const reply = segments.find((seg) => seg?.type === 'reply');
  if (reply?.data?.id != null) return String(reply.data.id);
  const match = /\[CQ:reply,id=(-?\d+)\]/.exec(String(event?.raw_message || ''));
  return match ? match[1] : '';
}


function formatAction(action) {
  const lines = [`动作 ${action.id}：${action.state}`];
  if (action.error) lines.push(`错误：${action.error}`);
  for (const [target, result] of Object.entries(action.results || {})) {
    const ids = (result.messageIds || []).length ? `，消息 ${result.messageIds.join(', ')}` : '';
    lines.push(`- ${target}：${result.state}${ids}${result.error ? `（${result.error}）` : ''}`);
  }
  if (action.recalledAt) lines.push('已执行过撤回核查；详情见审计。');
  return lines.join('\n');
}

function formatSendResult(result) {
  const action = result?.action || {};
  const lines = [`发送动作 ${action.id || ''}：${action.state || result?.state || 'unknown'}`];
  for (const [target, value] of Object.entries(action.results || {})) {
    const ids = Array.isArray(value.messageIds) && value.messageIds.length
      ? `，消息 ${value.messageIds.join(', ')}` : '';
    lines.push(`- ${target}：${value.state}${ids}${value.error ? `（${value.error}）` : ''}`);
    const failedItems = (value.items || []).filter((item) => item.ok === false);
    for (const item of failedItems) lines.push(`  · ${item.type} 失败：${item.error || '未知错误'}`);
  }
  if (result?.error) lines.push(`错误：${result.error}`);
  if (action.state === 'unknown') lines.push('有目标结果未知，请到目标群核对；不会自动重发。');
  return lines.join('\n');
}

function formatRecall(result) {
  const lines = [`撤回动作 ${result.action?.id || ''}：成功 ${result.recalled.length} 条`];
  for (const item of result.recalled) lines.push(`- ${item.target} #${item.messageId}`);
  if (result.skipped.length) {
    lines.push(`跳过 ${result.skipped.length} 条：`);
    for (const item of result.skipped.slice(0, 5)) {
      lines.push(`- ${item.target} #${item.messageId}：${item.reason}`);
    }
  }
  if (result.errors.length) {
    lines.push(`失败 ${result.errors.length} 条：`);
    for (const item of result.errors.slice(0, 5)) {
      lines.push(`- ${item.target} #${item.messageId}：${item.error}`);
    }
  }
  return lines.join('\n');
}

export function createCommandService({
  send, inbox, status, actions, getConfig: getConfigFn, reply = async () => {}, log = () => {}
} = {}) {
  if (!send || !inbox || !status || !actions || !getConfigFn) {
    throw new Error('admin command 缺少依赖');
  }

  async function handle(event) {
    if (event?.post_type !== 'message' || event?.message_type !== 'private') return { handled: false };
    const owner = adminOwnerUin(getConfigFn());
    if (!/^\d{5,15}$/.test(owner || '') || String(event.user_id || '') !== owner) {
      return { handled: false };
    }
    const text = eventText(event).trim();
    if (!text) return { handled: false };
    try {
      if (/^待批(?:列表)?$/.test(text)) {
        return { handled: true, reply: inbox.formatList() };
      }
      const verdict = /^(同意|批准|拒绝)\s+(\d{6})(?:\s+(\d{1,2}))?$/.exec(text);
      if (verdict) {
        const decision = verdict[1] === '拒绝' ? 'reject' : 'approve';
        const uses = Math.min(20, Math.max(1, Number(verdict[3]) || 1));
        const result = await inbox.decide({ code: verdict[2], decision, actor: owner, uses });
        return { handled: true, reply: result.reply };
      }
      const confirm = /^确认\s+(\d{6})$/.exec(text);
      if (confirm) {
        const started = send.confirmByCode({
          code: confirm[1],
          actor: owner,
          onComplete: (result) => {
            reply(formatSendResult(result)).catch(() => {});
          }
        });
        return {
          handled: true,
          reply: `已受理，正在发送到 ${started.action.targets.join('、')}；完成后会私聊结果。`
        };
      }
      const cancel = /^取消\s+(ad_[\w-]+|\d{6})$/.exec(text);
      if (cancel) {
        const action = cancel[1].startsWith('ad_')
          ? send.cancelById(cancel[1], owner)
          : send.cancelByCode(cancel[1], owner);
        return { handled: true, reply: `已取消发送动作 ${action.id}。` };
      }
      const recall = /^撤回\s+(ad_[\w-]+|刚才)$/.exec(text);
      if (recall) {
        const result = await send.recall({
          actionId: recall[1] === '刚才' ? '' : recall[1],
          actor: owner,
          latest: recall[1] === '刚才'
        });
        return { handled: true, reply: formatRecall(result) };
      }
      const sendMatch = /^发到群\s+(?:群\s*)?([^\s：:]+)\s*[：:]?\s*([\s\S]+)$/.exec(text);
      if (sendMatch) {
        const plan = await send.plan({
          actor: owner,
          targetsInput: [sendMatch[1]],
          itemsInput: [{ type: 'text', text: sendMatch[2] }],
          source: 'command'
        });
        return { handled: true, reply: plan.preview };
      }
      const forwardMatch = /^转发到群\s+(?:群\s*)?([^\s：:]+)\s*$/.exec(text);
      if (forwardMatch) {
        const messageId = extractReplyMid(event);
        if (!messageId) return { handled: true, reply: '请先引用一条消息，再发「转发到群 <群号>」。' };
        const plan = await send.plan({
          actor: owner,
          targetsInput: [forwardMatch[1]],
          itemsInput: [{ type: 'forward', messageId }],
          source: 'command'
        });
        return { handled: true, reply: plan.preview };
      }
      const actionInfo = /^动作\s+(ad_[\w-]+)$/.exec(text);
      if (actionInfo) {
        const action = actions.get(actionInfo[1]);
        if (!action) return { handled: true, reply: '找不到这个发送动作（可能已清理）。' };
        return { handled: true, reply: formatAction(action) };
      }
      if (text === '状态') return { handled: true, reply: status.format() };
      if (text === '健康') return { handled: true, reply: await status.health() };
      if (text === '未知发送') return { handled: true, reply: status.unknown() };
      if (text === '失败发送') return { handled: true, reply: status.failed() };
      return { handled: false };
    } catch (error) {
      log('[admin] 命令执行失败：', error?.message ?? error);
      return { handled: true, reply: `操作失败：${String(error?.message ?? error).slice(0, 300)}` };
    }
  }

  return { handle };
}
