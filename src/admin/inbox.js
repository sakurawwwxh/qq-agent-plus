// 管理员统一审批收件箱：插件待批 + 入站好友申请 + 待确认的管理员发送动作。
//
// 插件/好友仍走各自原来的状态机与自动重放逻辑；这里只做聚合法与短码映射，
// 不复制授权语义，也不把待批的完整参数暴露到聊天里。
import crypto from 'node:crypto';
import { appendAudit } from '../core/audit-log.js';
import { listPendingApprovals } from '../plugins/grants.js';

const CODE_TTL_MS = 10 * 60_000;

function auditSafe(fn, entry) {
  try { fn?.(entry); } catch { /* 审计失败不影响审批 */ }
}

function fmtAge(expiresAt, now) {
  if (!expiresAt) return '';
  const mins = Math.max(0, Math.round((Number(expiresAt) - now) / 60_000));
  return mins > 0 ? `剩 ${mins} 分` : '即将过期';
}

function pluginItem(row) {
  return {
    type: 'plugin',
    id: String(row.id),
    title: `插件 ${row.pluginName || row.pluginId || ''}`.trim(),
    action: String(row.label || row.action || '写操作'),
    target: String(row.target || ''),
    preview: String(row.preview || '').slice(0, 200),
    expiresAt: Number(row.expiresAt) || 0,
    verdicts: ['approve', 'reject']
  };
}

function friendItem(row) {
  const name = String(row.primaryName || row.nickname || row.displayName || row.userId || '').trim();
  return {
    type: 'friend',
    id: String(row.id),
    title: `好友申请 ${name}`,
    action: String(row.verifyMessage || row.comment || '请求添加好友').slice(0, 160),
    target: String(row.userId || ''),
    preview: String(row.verifyMessage || row.comment || '').slice(0, 200),
    expiresAt: 0,
    verdicts: ['approve', 'reject']
  };
}

function sendItem(action) {
  return {
    type: 'send',
    id: String(action.id),
    title: '待确认的管理员发送',
    action: `目标：${(action.targets || []).join('、')}`,
    target: (action.targets || []).join('、'),
    preview: String(action.preview || '').slice(0, 200),
    expiresAt: Number(action.expiresAt) || 0,
    verdicts: []
  };
}

export function createInbox({
  dataDir, actions, getPluginRegistry, getIdentityPilot,
  audit = appendAudit, now: nowFn = Date.now
} = {}) {
  if (!dataDir || !actions) throw new Error('admin inbox 需要 dataDir 与 action store');
  const codes = new Map();   // code -> { key, expiresAt }
  const keys = new Map();    // key -> code

  function cleanup() {
    const at = nowFn();
    for (const [code, entry] of codes) {
      if (entry.expiresAt <= at) {
        codes.delete(code);
        keys.delete(entry.key);
      }
    }
  }

  function ensureCode(key) {
    cleanup();
    const existing = keys.get(key);
    if (existing) {
      const entry = codes.get(existing);
      if (entry && entry.expiresAt > nowFn()) return existing;
    }
    for (let i = 0; i < 50; i += 1) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      if (codes.has(code)) continue;
      codes.set(code, { key, expiresAt: nowFn() + CODE_TTL_MS });
      keys.set(key, code);
      return code;
    }
    throw new Error('审批短码生成失败，请稍后再试');
  }

  function list() {
    const items = [];
    for (const row of listPendingApprovals(dataDir)) {
      const item = pluginItem(row);
      // 只做展示；真正解析仍用插件待批自己的 ap_ 编号。
      items.push({ ...item, code: ensureCode(`plugin:${item.id}`) });
    }
    try {
      const identity = getIdentityPilot?.();
      const incoming = identity?.listIncomingFriendRequests?.({ status: 'pending', limit: 100 }) || [];
      for (const row of incoming) {
        const item = friendItem(row);
        items.push({ ...item, code: ensureCode(`friend:${item.id}`) });
      }
    } catch { /* 身份库未启动时只显示插件/发送项 */ }
    for (const action of actions.listPending()) {
      items.push(sendItem(action));
    }
    return items.sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity));
  }

  function formatList() {
    const items = list();
    if (!items.length) return '现在没有待批或待确认的动作。';
    const lines = items.slice(0, 10).map((item, index) => {
      const label = item.type === 'plugin' ? '插件'
        : item.type === 'friend' ? '好友' : '发送';
      const target = item.target ? ` → ${item.target}` : '';
      const age = fmtAge(item.expiresAt, nowFn());
      const code = item.code ? ` · 码 ${item.code}` : '';
      const actionId = item.type === 'send' ? ` · ${item.id}` : '';
      const preview = item.preview ? `\n   ${item.preview.replace(/\s+/g, ' ')}` : '';
      return `${index + 1}. [${label}] ${item.title}${target} · ${item.action}${code}${actionId}`
        + `${age ? ` · ${age}` : ''}${preview}`;
    });
    const plugins = items.filter((item) => item.type === 'plugin' || item.type === 'friend');
    const sends = items.filter((item) => item.type === 'send');
    const hints = [];
    if (plugins.length) hints.push('「同意 <码>」/「拒绝 <码>」');
    if (sends.length) hints.push('发送动作用创建时收到的「确认 <码>」；也可「取消 ad_xxx」');
    return `有 ${items.length} 条待处理：\n${lines.join('\n')}`
      + (hints.length ? `\n回复 ${hints.join(' 或 ')}。` : '');
  }

  async function decide({ code, decision, actor, uses = 1 } = {}) {
    cleanup();
    const entry = codes.get(String(code || ''));
    if (!entry) throw new Error('审批码不存在或已过期，请重新发送「待批」');
    const key = entry.key;
    const [type, id] = key.split(':');
    if (type === 'send') throw new Error('这是发送动作，请用创建时收到的「确认 <码>」执行');
    if (!['approve', 'reject'].includes(decision)) throw new Error('审批动作不合法');
    let reply = '';
    try {
      if (type === 'plugin') {
        const registry = getPluginRegistry?.();
        if (!registry?.handleOwnerApprovalText) throw new Error('插件注册表当前不可用');
        const text = `${decision === 'approve' ? '同意' : '拒绝'} ${id}`
          + (decision === 'approve' && Number(uses) > 1 ? ` ${Math.min(20, Number(uses))}` : '');
        const result = registry.handleOwnerApprovalText(text, actor);
        if (!result?.handled) throw new Error('插件审批当前不可用');
        reply = result.reply || '已处理。';
      } else if (type === 'friend') {
        const identity = getIdentityPilot?.();
        if (!identity?.decideIncomingFriendRequest) throw new Error('好友审批当前不可用');
        const result = await identity.decideIncomingFriendRequest(id, decision, { decidedBy: actor });
        reply = result?.note || (decision === 'approve' ? '已同意好友申请。' : '已拒绝好友申请。');
      } else {
        throw new Error('未知的待批类型');
      }
      // 一次性短码：成功后立即失效，避免同一码重复批准。
      codes.delete(String(code));
      keys.delete(key);
      auditSafe(audit, {
        action: 'admin.inbox.decision',
        target: `${type}:${id}`,
        ok: true,
        after: { actor, type, id, decision, uses: Number(uses) || 1, result: reply.slice(0, 200) }
      });
      return { ok: true, reply };
    } catch (error) {
      auditSafe(audit, {
        action: 'admin.inbox.decision',
        target: `${type}:${id}`,
        ok: false,
        after: { actor, type, id, decision, error: String(error?.message ?? error).slice(0, 200) }
      });
      throw error;
    }
  }

  return { list, formatList, decide };
}
