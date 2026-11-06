// 管理员跨会话发送动作的持久化与确认码。
//
// 这里只存“发送计划”，不直接发送：模型/固定命令先创建动作，管理员用 6 位确认码
// 在确定性路径里确认后才执行。动作落盘是为了让进程重启后仍能看到“执行中/结果未知”，
// 而不是把一条已经发到群里的消息彻底遗忘。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SEND_CODE_TTL_MS = 2 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
const MAX_KEEP = 100;
const KEEP_MS = 24 * 60 * 60 * 1000;

export class AdminActionError extends Error {
  constructor(message, { code = 'E_ADMIN_ACTION', action = null } = {}) {
    super(message);
    this.name = 'AdminActionError';
    this.code = code;
    this.action = action;
  }
}

function codeHash(salt, code) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function sameHash(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newActionId() {
  return `ad_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * @param {{dataDir: string, now?: () => number}} options
 */
export function createActionStore({ dataDir, now: nowFn = Date.now } = {}) {
  if (!dataDir) throw new Error('admin action store 需要 dataDir');
  const file = path.join(dataDir, 'admin-actions.json');
  let actions = [];
  let lastCode = '';

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw?.actions)) actions = raw.actions;
    } catch {
      actions = [];
    }
  }

  function save() {
    const cutoff = nowFn() - KEEP_MS;
    // 终态动作保留一天，供“撤回刚才”和审计排查；pending 不受保留期影响。
    actions = actions.filter((item) => {
      const at = Number(item.createdAt) || 0;
      return item.state === 'pending' || item.state === 'executing' || at >= cutoff;
    }).slice(-MAX_KEEP);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, actions }), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* 权限设不上不影响内容 */ }
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* 同上 */ }
  }

  function expirePending() {
    const at = nowFn();
    let changed = false;
    for (const item of actions) {
      if (item.state === 'pending' && Number(item.expiresAt) <= at) {
        item.state = 'expired';
        item.updatedAt = at;
        changed = true;
      }
    }
    if (changed) save();
  }

  function get(id) {
    expirePending();
    return actions.find((item) => item.id === String(id || '')) || null;
  }

  function listPending() {
    expirePending();
    return actions.filter((item) => item.state === 'pending');
  }

  function listUnknown() {
    expirePending();
    return actions.filter((item) => ['unknown', 'executing'].includes(item.state));
  }

  function findByCode(code, actor = '') {
    expirePending();
    const value = String(code || '');
    if (!/^\d{6}$/.test(value)) return null;
    return actions.find((item) => item.state === 'pending'
      && (!actor || String(item.actor) === String(actor))
      && sameHash(item.codeHash, codeHash(item.codeSalt, value))) || null;
  }

  function create({ actor, targets, items, ttlMs = SEND_CODE_TTL_MS } = {}) {
    if (!String(actor || '').trim()) throw new AdminActionError('发送动作缺少管理员身份');
    if (!Array.isArray(targets) || !targets.length) throw new AdminActionError('发送动作没有目标群');
    if (!Array.isArray(items) || !items.length) throw new AdminActionError('发送动作没有内容');
    // 同一时刻最多只放一个待确认动作：确认码是短数字，历史 pending 越多越容易撞。
    // 管理员可以取消旧的再建新的，避免默默替换掉还没确认的内容。
    const existing = listPending();
    if (existing.length) {
      throw new AdminActionError('已有一个待确认的发送动作，请先「确认」或「取消」它。', {
        code: 'E_ADMIN_ACTION_PENDING',
        action: existing[0]
      });
    }
    let code = '';
    for (let i = 0; i < 20; i += 1) {
      code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      if (code !== lastCode) break;
    }
    lastCode = code;
    const salt = crypto.randomBytes(16).toString('hex');
    const at = nowFn();
    const action = {
      id: newActionId(),
      actor: String(actor),
      targets: targets.map(String),
      items,
      state: 'pending',
      createdAt: at,
      updatedAt: at,
      expiresAt: at + Math.max(30_000, Math.min(10 * 60_000, Number(ttlMs) || SEND_CODE_TTL_MS)),
      codeSalt: salt,
      codeHash: codeHash(salt, code),
      attempts: 0,
      results: {}
    };
    actions.push(action);
    save();
    return { action, code };
  }

  function confirm(id, code, actor = '') {
    const action = get(id);
    if (!action) throw new AdminActionError('发送动作不存在或已清理', { code: 'E_ADMIN_ACTION_NOT_FOUND' });
    if (action.state === 'expired') {
      throw new AdminActionError('确认码已过期，请重新创建发送动作', { code: 'E_ADMIN_CODE_EXPIRED', action });
    }
    if (action.state !== 'pending') {
      throw new AdminActionError(`发送动作当前状态是 ${action.state}，不能再确认`, {
        code: 'E_ADMIN_ACTION_STATE', action
      });
    }
    if (actor && String(action.actor) !== String(actor)) {
      throw new AdminActionError('发送动作不属于当前管理员', { code: 'E_ADMIN_ACTION_OWNER', action });
    }
    if (Number(action.expiresAt) <= nowFn()) {
      action.state = 'expired';
      action.updatedAt = nowFn();
      save();
      throw new AdminActionError('确认码已过期，请重新创建发送动作', { code: 'E_ADMIN_CODE_EXPIRED', action });
    }
    action.attempts = (Number(action.attempts) || 0) + 1;
    if (action.attempts > MAX_CODE_ATTEMPTS) {
      action.state = 'cancelled';
      action.updatedAt = nowFn();
      save();
      throw new AdminActionError('确认码错误次数过多，动作已取消', { code: 'E_ADMIN_CODE_LOCKED', action });
    }
    if (!sameHash(action.codeHash, codeHash(action.codeSalt, String(code || '')))) {
      action.updatedAt = nowFn();
      save();
      throw new AdminActionError(`确认码不正确（还可尝试 ${Math.max(0, MAX_CODE_ATTEMPTS - action.attempts)} 次）`, {
        code: 'E_ADMIN_CODE', action
      });
    }
    action.state = 'executing';
    action.updatedAt = nowFn();
    action.executedAt = nowFn();
    save();
    return action;
  }

  function cancel(id, actor = '') {
    const action = get(id);
    if (!action) throw new AdminActionError('发送动作不存在或已清理', { code: 'E_ADMIN_ACTION_NOT_FOUND' });
    if (actor && String(action.actor) !== String(actor)) {
      throw new AdminActionError('发送动作不属于当前管理员', { code: 'E_ADMIN_ACTION_OWNER', action });
    }
    // executing 不能“假取消”：发送循环没有中断点，回复已取消但消息继续发出比拒绝更危险。
    if (action.state !== 'pending') {
      throw new AdminActionError(`发送动作当前状态是 ${action.state}，不能取消（已开始发送请等待完成后撤回）`, { code: 'E_ADMIN_ACTION_STATE', action });
    }
    action.state = 'cancelled';
    action.updatedAt = nowFn();
    save();
    return action;
  }

  function update(id, patch = {}) {
    const action = get(id);
    if (!action) return null;
    Object.assign(action, patch, { updatedAt: nowFn() });
    save();
    return action;
  }

  function finish(id, { state, results, error = '' } = {}) {
    return update(id, {
      state: state || 'unknown',
      results: results || {},
      error: String(error || ''),
      completedAt: nowFn()
    });
  }

  /** 进程重启：执行中的动作不可能还在跑；标 unknown，绝不自动重发。 */
  function recover() {
    const at = nowFn();
    let changed = false;
    for (const item of actions) {
      if (item.state === 'executing') {
        item.state = 'unknown';
        item.error = '进程重启，发送结果未知，请到目标群核对';
        item.updatedAt = at;
        changed = true;
      } else if (item.state === 'pending' && Number(item.expiresAt) <= at) {
        item.state = 'expired';
        item.updatedAt = at;
        changed = true;
      }
    }
    if (changed) save();
    return actions.filter((item) => item.state === 'unknown').length;
  }

  function last(actor = '') {
    expirePending();
    // 返回该 owner 最近一次动作（不限状态）：撤回入口自己校验状态，
    // 避免“最新动作还在 executing 时，撤回 刚才 反而撤掉上一条”的危险行为。
    return [...actions].reverse().find((item) =>
      (!actor || String(item.actor) === String(actor))) || null;
  }

  load();
  recover();

  return {
    file,
    create,
    get,
    listPending,
    listUnknown,
    findByCode,
    confirm,
    cancel,
    update,
    finish,
    recover,
    last,
    /** 仅供测试/诊断：当前内存中的动作快照。 */
    snapshot: () => actions.map((item) => ({ ...item }))
  };
}
