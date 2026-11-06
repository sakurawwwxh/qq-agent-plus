// 管理员跨群发送的目标解析。
//
// 目标只认 allow.groups：管理员能在控制台把群加入聊天白名单，就同时获得了“可以往这里
// 发管理员公告”的授权；不额外引入 admin.broadcastGroups，避免两套白名单漂移。
import { idList } from '../core/list.js';

export class AdminTargetError extends Error {
  constructor(message, { code = 'E_ADMIN_TARGET', candidates = [] } = {}) {
    super(message);
    this.name = 'AdminTargetError';
    this.code = code;
    this.candidates = candidates;
  }
}

/** 数字群号/group:数字 → 规范群号；其它返回空串。 */
export function normalizeGroupId(value) {
  const raw = String(value ?? '').trim();
  const match = /^(?:group\s*[:：]\s*)?0*([1-9]\d{4,14})$/.exec(raw);
  if (!match) return '';
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? String(id) : '';
}

function canonicalSet(values) {
  const out = new Set();
  for (const value of idList(values)) {
    const id = normalizeGroupId(value);
    if (id) out.add(id);
  }
  return out;
}

function groupRows(list) {
  return (Array.isArray(list) ? list : []).map((row) => {
    const id = normalizeGroupId(row?.group_id ?? row?.groupId ?? row?.id);
    return id ? { id, name: String(row?.group_name ?? row?.groupName ?? row?.name ?? id).trim() } : null;
  }).filter(Boolean);
}

async function readGroupList({ onebot, store, getGroupList }) {
  const groupListFn = typeof getGroupList === 'function' ? getGroupList : null;
  try {
    const list = typeof groupListFn === 'function'
      ? await groupListFn()
      : (typeof onebot?.call === 'function'
        ? await onebot.call('get_group_list', {}, 8000)
        : []);
    const rows = groupRows(list);
    if (rows.length) return rows;
  } catch { /* 协议端不支持/超时：退回本地会话表 */ }
  try {
    return (store?.listChats?.() || [])
      .filter((key) => String(key).startsWith('group:'))
      .map((key) => {
        const id = normalizeGroupId(key);
        return id ? { id, name: id } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function confirmMembership({ id, onebot, getGroupList }) {
  const groupListFn = typeof getGroupList === 'function' ? getGroupList : null;
  try {
    const list = typeof groupListFn === 'function'
      ? await groupListFn()
      : (typeof onebot?.call === 'function'
        ? await onebot.call('get_group_list', {}, 8000)
        : []);
    const rows = groupRows(list);
    if (rows.some((row) => row.id === id)) return '';
  } catch { /* 列表不可用：继续用成员信息兜底 */ }
  // get_group_list 可能分页/截断；get_group_info 对“机器人不在的群”也可能返回资料，
  // 不能拿来证明成员身份。用机器人自己的成员信息做最后确认，查不到就 fail-closed。
  const selfId = String(onebot?.selfId || '').trim();
  if (/^\d{5,15}$/.test(selfId) && typeof onebot?.getGroupMemberInfo === 'function') {
    try {
      const info = await onebot.getGroupMemberInfo(Number(id), Number(selfId));
      if (info) return '';
    } catch { /* 查不到就按不能确认处理 */ }
  }
  return '无法确认机器人是否在这个群里';
}

/**
 * @returns {Promise<Array<{chatKey:string, groupId:string, name:string}>>}
 */
export async function resolveTargets({
  input, cfg, onebot, store, getGroupList = null, max = 5
} = {}) {
  const allowed = canonicalSet(cfg?.allow?.groups);
  const denied = canonicalSet(cfg?.deny?.groups);
  if (!allowed.size) {
    throw new AdminTargetError('allow.groups 为空：请先在控制台把目标群加入聊天白名单', {
      code: 'E_ADMIN_NO_TARGETS'
    });
  }
  const values = (Array.isArray(input) ? input : [input])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  // 只说“发群里”时，如果白名单里恰好只有一个群，就默认发到它；多个群必须明确指定。
  if (!values.length && allowed.size === 1) values.push([...allowed][0]);
  if (!values.length) throw new AdminTargetError('没有指定目标群');
  if (values.length > max) throw new AdminTargetError(`一次最多发 ${max} 个群`);

  const groups = await readGroupList({ onebot, store, getGroupList });
  const byId = new Map(groups.map((row) => [row.id, row]));
  const out = [];
  const seen = new Set();

  for (const value of values) {
    let id = normalizeGroupId(value);
    let name = '';
    if (id) {
      name = byId.get(id)?.name || id;
    } else {
      const needle = value.replace(/^群\s*/, '').trim();
      const matches = groups.filter((row) => row.name === needle || row.id === needle);
      if (!matches.length) {
        throw new AdminTargetError(`没有找到群「${value}」；请用群号或完整群名`, {
          code: 'E_ADMIN_TARGET_UNKNOWN'
        });
      }
      if (matches.length > 1) {
        throw new AdminTargetError(`群名「${value}」不唯一，请用群号指定`, {
          code: 'E_ADMIN_TARGET_AMBIGUOUS',
          candidates: matches.map((row) => ({ id: row.id, name: row.name }))
        });
      }
      id = matches[0].id;
      name = matches[0].name;
    }
    if (denied.has(id)) throw new AdminTargetError(`群 ${id} 在 deny.groups 里，禁止发送`);
    if (!allowed.has(id)) throw new AdminTargetError(`群 ${id} 不在 allow.groups 白名单里`);
    if (String(id) === String(onebot?.selfId || '')) throw new AdminTargetError('不能把群号当机器人自己');
    const localKnown = (store?.listChats?.() || []).includes(`group:${id}`);
    const membership = localKnown ? '' : await confirmMembership({ id, onebot, getGroupList });
    if (membership) throw new AdminTargetError(`群 ${id}：${membership}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ chatKey: `group:${id}`, groupId: id, name: name || id });
  }
  return out;
}
