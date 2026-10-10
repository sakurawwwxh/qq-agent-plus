// 显示名口径（唯一真源）：按 QQ 号的「备注/代号」（config.memberNotes）优先，
// 其次消息携带的群名片/昵称，最后 QQ 号本身；统一过 sanitizeUserText（段头弱化）。
//
// 为什么要有这个模块：备注此前只在提示词的消息行里生效（prompt.js formatEntry），
// 工具结果（历史消息 / 成员列表 / 消息详情 / 成员提示）用的还是原始群名片 ——
// 同一个人在不同地方名字不一样，模型也就"有时喊群名片、有时喊备注"（2026-10-10 用户反馈）。
//
// 写入口两处：控制台「人物记忆页 → 备注」（/api/config 的 __replace__）与模型工具
// set_member_note（经 memory-global.setMemberNote）。
import { getConfig } from './config.js';
import { sanitizeUserText } from './util.js';

/** userId 与 fallback 都为空时返回空串（调用方自行决定"未知"这类兜底文案）。 */
export function displayNameOf(userId, fallback = '') {
  const id = String(userId ?? '');
  const note = String((getConfig().memberNotes || {})[id] || '').trim();
  return sanitizeUserText(note || String(fallback ?? '').trim() || id);
}
