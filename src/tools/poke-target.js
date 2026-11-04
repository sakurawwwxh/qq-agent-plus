// send_poke 收到非数字 targetUserId 时按名字反查 QQ（模型常把聊天里看到的名字直接当 QQ 传，
// 光靠工具说明拦不住）。原则是「宁可报错也不猜人」：
//   - 当前群名片/备注精确命中优先，其次群名片前缀（至少 2 个字，单个 emoji 算 1 个字）；
//   - 历史群名片也参与唯一性判断：改名后旧名字撞到别人时一律报错，不能拍最新同名的另一个人；
//   - 历史精确命中不能压过当前名字的前缀命中（否则模型截断当前群名片时会拍回旧名字的人）；
//   - 只认唯一命中；重名、前缀歧义、历史名字过多都报错，让模型用 QQ 号指定。
// 纯数字（含 0）由调用方走原数字校验，不进入这里。
import { displayNameOf } from '../core/display-name.js';

// 单群历史上限：超过就不猜（QQ 群人数远低于这个量级；这里兜的是脏数据/恶意改名）。
const MAX_NAME_HISTORY = 20000;
// 歧义列表要回传给模型：只列前 10 个，避免一次失败把上下文灌满。
const MAX_LISTED_CANDIDATES = 10;
const graphemeSegmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });

/** 名字输入统一口径：去掉模型习惯加的 @ 前缀和它后面的空白，只做一次。 */
export function normalizePokeName(raw) {
  return String(raw ?? '').trim().replace(/^@+/, '').trim();
}

function graphemeCount(text) {
  return [...graphemeSegmenter.segment(text)].length;
}

function emptyError(raw) {
  return {
    error: `targetUserId 必须是 QQ 号，按名字也没有唯一对上的成员（收到：${JSON.stringify(raw)}）。`,
    hint: true
  };
}

/** 每个 QQ 最新一次出现的名字；lastTs 并列时标记为 tie，按“不确定当前名字”保守处理。 */
function latestNames(members) {
  const latest = new Map();
  const tied = new Set();
  for (const member of members) {
    const prev = latest.get(member.userId);
    if (!prev || member.lastTs > prev.lastTs) {
      latest.set(member.userId, member);
      tied.delete(member.userId);
    } else if (member.lastTs === prev.lastTs) {
      tied.add(member.userId);
    }
  }
  return { latest, tied };
}

/**
 * 把模型给的群名片/备注解析成 QQ 号。
 * 返回 { userId } 或 { error, hint }；hint=true 时调用方追加成员列表提示。
 */
export function resolvePokeTarget(ctx, raw) {
  const text = normalizePokeName(raw);
  const query = text.toLowerCase();
  if (!query) return emptyError(raw);

  // 旧 store 不提供历史名字时无法判断改名碰撞。宁可报错，也不要拿最新名字猜。
  if (typeof ctx.store?.memberNameHistory !== 'function') {
    return { error: '当前存储无法校验历史群名片，请用数字 QQ 号指定。', hint: true };
  }
  const rows = ctx.store.memberNameHistory(ctx.chatKey, { limit: MAX_NAME_HISTORY + 1 });
  if (rows.length > MAX_NAME_HISTORY) {
    return { error: '当前会话的历史群名片过多，按名字反查已停用；请用数字 QQ 号指定。', hint: true };
  }

  const members = rows.filter((member) => member.userId && member.name);
  const labelOf = (member) => displayNameOf(member.userId, member.name);
  const isExact = (member) => (
    member.name.toLowerCase() === query || labelOf(member).toLowerCase() === query
  );
  const pick = (matched) => {
    const byId = new Map();
    for (const member of matched) {
      if (!byId.has(member.userId)) byId.set(member.userId, member);
    }
    const ids = [...byId.keys()];
    if (ids.length === 1) return { userId: ids[0] };
    if (ids.length > 1) {
      const shown = ids.slice(0, MAX_LISTED_CANDIDATES);
      const list = shown.map((id) => `${labelOf(byId.get(id))}(${id})`).join('、');
      const more = ids.length > shown.length ? ` 等 ${ids.length} 人` : '';
      return { error: `有 ${ids.length} 个成员都能对上「${text}」，请用 QQ 号指定：${list}${more}` };
    }
    return null;
  };

  const exactRows = members.filter(isExact);
  const exact = pick(exactRows);
  if (exact) {
    if (exact.error) return exact;
    // “精确优先”只适用于当前名字。命中只来自历史名字时，若另一个人的当前名字/备注
    // 以这个查询开头（模型很可能只是截断了当前显示名），必须报歧义而不是拍旧人。
    const { latest, tied } = latestNames(members);
    const current = latest.get(exact.userId);
    const currentExact = !tied.has(exact.userId) && current && isExact(current);
    if (currentExact) return exact;
    const otherPrefixRows = [...latest.values()].filter((member) => (
      member.userId !== exact.userId
      && (member.name.toLowerCase().startsWith(query) || labelOf(member).toLowerCase().startsWith(query))
    ));
    if (otherPrefixRows.length) return pick([...exactRows, ...otherPrefixRows]);
    return exact;
  }

  if (graphemeCount(text) >= 2) {
    const prefix = pick(members.filter((member) => member.name.toLowerCase().startsWith(query)));
    if (prefix) return prefix;
  }

  const similar = [];
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.userId)) continue;
    if (member.name.toLowerCase().includes(query) || labelOf(member).toLowerCase().includes(query)) {
      seen.add(member.userId);
      similar.push(member);
      if (similar.length >= 3) break;
    }
  }
  const guess = similar.length
    ? `你是不是想找：${similar.map((member) => `${labelOf(member)}(${member.userId})`).join('、')}？`
    : '';
  return {
    error: `targetUserId 必须是 QQ 号，按名字也没有唯一对上的成员（收到：${JSON.stringify(raw)}）。${guess}`,
    hint: true
  };
}
