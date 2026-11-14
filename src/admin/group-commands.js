// 群内 owner 只读命令：不经过模型，也不进入长期记忆/插件观察。
// 默认关闭；只在这些群里开启，并且仍只认全局管理员本人。
import { adminOwnerUin } from '../core/config.js';
import { idList } from '../core/list.js';
import { authoredText } from '../tools/moderation-auth.js';

function cleanCommand(text) {
  return authoredText(text)
    .replace(/^\s*@\S+\s*/, '')
    .replace(/^\s*[!/／]\s*/, '')
    .trim();
}

function pct(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function decisionText(decision) {
  if (!decision) return '最近没有可解释的回复决策。';
  const outcome = decision.outcome === 'skipped' ? '未回复'
    : decision.outcome === 'replied' ? '已回复'
      : decision.outcome === 'noreply' ? '运行了但未发言' : (decision.outcome || '已处理');
  const hits = [];
  if (decision.hits?.atMe) hits.push('@我');
  if (decision.hits?.pokeMe) hits.push('拍一拍');
  if (decision.hits?.replyToMe) hits.push('引用我');
  if (decision.hits?.keyword) hits.push('关键词');
  if (decision.hits?.probability) hits.push('概率');
  return `最近决策：${outcome}｜${decision.reason || '未触发'}｜档位 ${decision.tier ?? '-'}｜概率 ${pct(decision.percent)}%`
    + `｜待处理 ${decision.pendingCount ?? 0} 条${hits.length ? `｜命中 ${hits.join('/')}` : ''}`;
}

function behaviorCard(cfg) {
  const percent = pct(cfg.store?.randomPercent);
  const mode = cfg.conversation?.mode || 'legacy';
  const memory = cfg.livingMemory?.enabled === true
    ? (cfg.livingMemory.mode === 'active' ? '开启（回复前会召回本会话记忆）' : '开启（只记录，不注入聊天）')
    : '关闭';
  const game = cfg.groupGame?.enabled === true ? '开启（由系统主持）' : '关闭';
  return [
    '【本群机器人说明】',
    `回复策略：普通消息约 ${percent}% 概率回应；@、引用、拍一拍优先处理。`,
    `对话模式：${mode}；活跃时段和暂停状态以控制台设置为准。`,
    `长期记忆：${memory}；只用于本群/管理员允许的范围。`,
    `群游戏：${game}。`,
    '外部写操作（相册评论、点赞、资料修改等）按控制台「平台能力」和插件授权开关执行；敏感动作仍需要管理员确认。',
    '本说明只介绍行为，不包含密钥、配置原文或其他会话内容。'
  ].join('\n');
}

export function createGroupCommandService({
  getConfig, getStatus, getOrchestrator, getGroupGame, send, log = () => {}
} = {}) {
  const groupGameFn = getGroupGame;
  const sendReply = async (chatKey, text) => {
    const body = String(text || '').slice(0, 3000);
    if (!body) return;
    try { await send(chatKey, body); } catch (error) {
      log('[admin:group] 命令回复发送失败：', error?.message ?? error);
    }
  };

  async function handleGroupMessage({ chatKey, kind, stored, backlog = false, onAccepted = null } = {}) {
    const accepted = typeof onAccepted === 'function' ? onAccepted : null;
    if (kind !== 'group' || backlog || !stored || stored.self) return false;
    const cfg = getConfig?.() || {};
    const rule = cfg.admin?.groupCommands || {};
    if (rule.enabled !== true) return false;
    const groupId = String(chatKey || '').split(':')[1] || '';
    const chats = idList(rule.chats);
    if (chats.length && !chats.includes(groupId)) return false;
    const owner = String(adminOwnerUin(cfg) || '').trim();
    if (!/^\d{5,15}$/.test(owner) || String(stored.senderId || '') !== owner) return false;
    const command = cleanCommand(stored.text);
    if (!['状态', '行为卡', '最近决策', '结束游戏'].includes(command)) return false;
    // 先消费/标读，再执行命令：命令回复可能在发送队列里排队，不能让它在这段时间里
    // 仍以 pending 身份被 drain 再领一遍。
    if (accepted) {
      try { await accepted(); } catch (error) { log('[admin:group] 命令消息收口失败：', error?.message ?? error); }
    }
    try {
      if (command === '状态') {
        const snap = getStatus?.()?.snapshot?.() || {};
        const queues = snap.queues?.byState || {};
        const outbox = snap.outbox?.byState || {};
        const game = groupGameFn?.()?.games?.get(chatKey);
        const name = game ? (groupGameFn()?.summaryFor?.(chatKey, { includeBrief: false })?.split('\n')[0] || '进行中') : '无';
        await sendReply(chatKey, [
          `状态：${snap.cfg?.runtime?.mode || 'active'}${snap.cfg?.runtime?.paused ? '（已暂停）' : ''}`,
          `OneBot：${snap.onebot?.connected === false ? '离线' : '在线'}`,
          `入站：pending ${queues.pending || 0} / held ${queues.held || 0} / deferred ${queues.deferred || 0}`,
          `出站：sending ${outbox.sending || 0} / unknown ${outbox.unknown || 0}`,
          `游戏：${name}`
        ].join('｜'));
      } else if (command === '行为卡') {
        await sendReply(chatKey, behaviorCard(cfg));
      } else if (command === '最近决策') {
        await sendReply(chatKey, decisionText(getOrchestrator?.()?.decisionFor?.(chatKey)));
      } else {
        const result = await groupGameFn?.()?.stop?.(chatKey, '管理员命令');
        if (!result?.ok) await sendReply(chatKey, `没有结束游戏：${result?.error || '当前没有进行中的局'}`);
      }
      return true;
    } catch (error) {
      log('[admin:group] 命令执行失败：', error?.message ?? error);
      await sendReply(chatKey, `命令执行失败：${String(error?.message ?? error).slice(0, 160)}`);
      return true;
    }
  }

  return { handleGroupMessage };
}
