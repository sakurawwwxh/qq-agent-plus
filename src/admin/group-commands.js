// 群内 owner 只读命令：不经过模型，也不进入长期记忆/插件观察。
// 默认关闭；只在这些群里开启，并且仍只认全局管理员本人。
import { adminOwnerUin } from '../core/config.js';
import { budgetStatus } from '../core/budget.js';
import { idList } from '../core/list.js';
import { todayKey } from '../core/util.js';
import { authoredText } from '../tools/moderation-auth.js';

const COMMANDS = [
  ['帮助', '列出可用命令'],
  ['状态', '运行模式、入站/出站队列和游戏状态'],
  ['今日用量', '今天的 token、运行次数和估算花费'],
  ['预算', '今日预算上限、已用金额和超限策略'],
  ['待核对', '积压未处理、待确认和结果不确定的发送'],
  ['记忆概览', '长期记忆总览和本群记忆条数'],
  ['最近决策', '最近一次为什么回/不回'],
  ['行为卡', '本群机器人的行为说明'],
  ['结束游戏', '结束本群正在进行的群游戏']
];
const ALIASES = new Set(['待处理']);

function cleanCommand(text) {
  return authoredText(text)
    .replace(/^\s*@\S+\s*/, '')
    .replace(/^\s*[!/／]\s*/, '')
    .trim();
}

function pct(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `¥${number.toFixed(2)}` : '¥0.00';
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

function helpText() {
  return ['【群主命令】', ...COMMANDS.map(([command, hint]) => `${command}：${hint}`)].join('\n');
}

function usageText(usage) {
  const total = Number(usage?.totalTokens) || 0;
  const features = Object.entries(usage?.byFeature || {})
    .map(([name, value]) => [name, Number(value?.calls) || 0])
    .filter(([, calls]) => calls > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  return [
    `今日用量：运行 ${Number(usage?.runs) || 0} 次｜token ${total}｜估算 ${money(usage?.estimatedYuan)}`,
    features.length ? `按任务：${features.map(([name, calls]) => `${name} ${calls} 次`).join('、')}` : '',
    Number(usage?.unpricedRuns) > 0 ? `另有 ${usage.unpricedRuns} 次模型调用没有价格记录，金额可能偏低。` : ''
  ].filter(Boolean).join('｜');
}

function budgetText(cfg, usage) {
  const budget = budgetStatus(cfg, usage);
  if (!budget.enabled) return '今日预算：未启用。';
  const policy = budget.onExceed === 'block' ? '达到上限后停止运行' : '达到上限后只回应 @';
  return `今日预算：${money(budget.spentYuan)} / ${money(budget.limitYuan)}${budget.exceeded ? '（已超限）' : ''}`
    + `｜策略：${policy}${budget.unpricedRuns ? `｜${budget.unpricedRuns} 次调用无价格记录` : ''}`;
}

function pendingText(snap) {
  const queues = snap?.queues?.byState || {};
  const outbox = snap?.outbox?.byState || {};
  const pending = Number(queues.pending) || 0;
  const held = Number(queues.held) || 0;
  const deferred = Number(queues.deferred) || 0;
  const unknown = Number(outbox.unknown) || 0;
  const sending = Number(outbox.sending) || 0;
  return `待核对：未处理 ${pending}｜待确认 ${held}｜延迟富化 ${deferred}｜发送中 ${sending}｜结果不确定 ${unknown}`
    + (held + deferred + unknown > 0 ? '。可到控制台会话详情里核对或重试。' : '。当前没有需要人工处理的项目。');
}

function memoryText(cfg, runtime, chatKey) {
  if (cfg?.livingMemory?.enabled !== true) return '长期记忆：未启用。';
  let status = {};
  try { status = runtime?.status?.() || {}; } catch { /* 读取失败时只报"已启用"，不影响命令回复 */ }
  const stats = status.stats || {};
  const scope = (stats.scopes || []).find((item) => item.scopeKey === chatKey);
  const embedding = status.embedding?.configured === true ? '向量召回已就绪' : '仅关键词召回';
  return `长期记忆：${cfg.livingMemory.mode === 'active' ? '回复前召回' : '只记录不注入'}`
    + `｜本群 ${Number(scope?.count) || 0} 条｜全局 ${Number(stats.active ?? stats.total) || 0} 条活跃`
    + `｜${embedding}｜来源回合 ${Number(stats.turns) || 0} 个`;
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
    if (!COMMANDS.some(([name]) => name === command) && !ALIASES.has(command)) return false;
    // 先消费/标读，再执行命令：命令回复可能在发送队列里排队，不能让它在这段时间里
    // 仍以 pending 身份被 drain 再领一遍。
    if (accepted) {
      try { await accepted(); } catch (error) { log('[admin:group] 命令消息收口失败：', error?.message ?? error); }
    }
    try {
      if (command === '帮助') {
        await sendReply(chatKey, helpText());
      } else if (command === '状态') {
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
      } else if (command === '今日用量') {
        const usage = getOrchestrator?.()?.sessions?.todayUsage?.(todayKey()) || {};
        await sendReply(chatKey, usageText(usage));
      } else if (command === '预算') {
        const usage = getOrchestrator?.()?.sessions?.todayUsage?.(todayKey()) || {};
        await sendReply(chatKey, budgetText(cfg, usage));
      } else if (command === '待核对' || command === '待处理') {
        await sendReply(chatKey, pendingText(getStatus?.()?.snapshot?.() || {}));
      } else if (command === '记忆概览') {
        await sendReply(chatKey, memoryText(cfg, getOrchestrator?.()?.livingMemory, chatKey));
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
