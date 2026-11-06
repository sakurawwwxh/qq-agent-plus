// 管理员跨群发送：计划、确认、逐目标执行、撤回。
//
// 发送永远走 SendQueue（禁言预检/限频/白名单/outbox 都在里面），并且每个目标一条独立
// EffectLedger：一个群结果 unknown 不能把其他群或当前私聊一起拖成 held。
import { appendAudit } from '../core/audit-log.js';
import { describeItems, normalizeItems, refreshItem } from './media.js';
import { resolveTargets } from './targets.js';

const RECALL_WINDOW_MS = 5 * 60_000;

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageIdOf(value) {
  return value?.message_id ?? value?.messageId ?? value?.sent?.[0]?.messageId ?? null;
}

function auditSafe(fn, entry) {
  try { fn?.(entry); } catch { /* 审计失败不能影响发送结果 */ }
}

export function createSendService({
  store, sender, onebot, effects, actions, getConfig: getConfigFn, log = () => {},
  audit = appendAudit, now: nowFn = Date.now, targetGapMs = 1200, sleep = sleepDefault
} = {}) {
  if (!actions) throw new Error('admin send 需要 action store');
  if (!store || !sender || !onebot || !effects) throw new Error('admin send 缺少发送依赖');

  async function plan({ actor, targetsInput, itemsInput, source = 'command' } = {}) {
    const cfg = getConfigFn();
    const targets = await resolveTargets({
      input: targetsInput,
      cfg,
      onebot,
      store,
      getGroupList: null
    });
    const normalized = await normalizeItems({
      items: itemsInput,
      onebot,
      store,
      ownerChatKey: `private:${actor}`
    });
    const created = actions.create({
      actor,
      targets: targets.map((target) => target.chatKey),
      items: normalized.items
    });
    const { action, code } = created;
    const preview = [
      `准备发送到：${targets.map((target) => `${target.name}（${target.groupId}）`).join('、')}`,
      `内容：${describeItems(normalized.items)}`,
      `回复「确认 ${code}」执行；回复「取消 ${code}」放弃。`,
      `2 分钟内有效，动作 ${action.id}`
    ].join('\n');
    // 预览落盘供「待批」核对，但不能把明文确认码写进动作文件。
    actions.update(action.id, { preview: preview.replaceAll(code, '<码>') });
    auditSafe(audit, {
      action: 'admin.send.plan',
      target: action.id,
      ok: true,
      after: {
        actor, targets: targets.map((target) => target.chatKey),
        items: describeItems(normalized.items).slice(0, 300), source
      }
    });
    return { action, code, preview, targets };
  }

  function findByCode(code, actor) {
    return actions.findByCode(code, actor);
  }

  function cancelByCode(code, actor) {
    const action = actions.findByCode(code, actor);
    if (!action) throw new Error('确认码不存在或已过期');
    const cancelled = actions.cancel(action.id, actor);
    auditSafe(audit, {
      action: 'admin.send.cancel', target: cancelled.id, ok: true, after: { actor }
    });
    return cancelled;
  }

  function cancelById(actionId, actor) {
    const cancelled = actions.cancel(actionId, actor);
    auditSafe(audit, {
      action: 'admin.send.cancel', target: cancelled.id, ok: true, after: { actor, via: 'action-id' }
    });
    return cancelled;
  }

  /** 确认码验证通过后立即返回；真正发送在后台执行，完成后再私聊回报。 */
  function confirmByCode({ code, actor, onComplete = null } = {}) {
    // 不用 findByCode 预筛：否则错码永远进不到 confirm 的尝试计数，5 次锁定是死代码。
    const pending = actions.listPending().filter((item) => !actor || String(item.actor) === String(actor));
    if (!pending.length) throw new Error('没有待确认的发送动作（可能已过期或已处理）');
    let action = pending[0];
    if (pending.length > 1) {
      action = actions.findByCode(code, actor);
      if (!action) throw new Error('确认码不正确或已过期');
    }
    const confirmed = actions.confirm(action.id, code, actor);
    auditSafe(audit, {
      action: 'admin.send.confirm', target: confirmed.id, ok: true,
      after: { actor, targets: confirmed.targets }
    });
    const promise = execute(confirmed)
      .then((result) => {
        try { onComplete?.(result); } catch { /* 通知失败不能改判发送结果 */ }
        return result;
      })
      .catch((error) => {
        let failed = confirmed;
        try {
          failed = actions.finish(confirmed.id, {
            state: 'failed', results: confirmed.results || {}, error: String(error?.message ?? error)
          }) || confirmed;
        } catch { /* 落盘失败也要回报 */ }
        try { onComplete?.({ action: failed, ok: false, error: String(error?.message ?? error) }); } catch { /* 忽略 */ }
        return { action: failed, ok: false, error: String(error?.message ?? error) };
      });
    return { action: confirmed, promise };
  }

  async function execute(action) {
    const cfg = getConfigFn();
    const results = {};
    const record = (target, value) => {
      results[target] = value;
      try { actions.update(action.id, { results: { ...results } }); } catch (error) {
        log(`[admin-send] ${action.id} 结果落盘失败：${error?.message ?? error}`);
      }
    };
    for (let index = 0; index < action.targets.length; index += 1) {
      const target = action.targets[index];
      let began = null;
      try {
        await resolveTargets({ input: [target], cfg, onebot, store, getGroupList: null });
        if (store.getChatMeta?.(target)?.held) {
          record(target, { state: 'skipped', messageIds: [], items: [], completedAt: nowFn(), error: '目标群有未核对的发送，已跳过' });
          continue;
        }
        const idemKey = `admin-send:${action.id}:${target}`;
        began = effects.begin({
          kind: 'admin-send',
          chatKey: target,
          idemKey,
          detail: { actionId: action.id, target, actor: action.actor }
        });
        if (began.action !== 'proceed') {
          const row = effects.get('admin-send', idemKey);
          const messageIds = Array.isArray(row?.detail?.messageIds) ? row.detail.messageIds : [];
          record(target, {
            state: began.action === 'done' ? 'sent' : 'unknown',
            messageIds,
            items: [],
            completedAt: nowFn(),
            error: began.action === 'done' ? '' : '该目标的发送结果未知，请人工核对'
          });
          continue;
        }
        const sent = await sendItems(target, action.items, began.id, action.id, `private:${action.actor}`);
        const uncertain = store.hasUncertainEffects?.(began.id) === true || sent.uncertain;
        const partial = !uncertain && !sent.ok && (sent.messageIds.length > 0 || sent.items.some((item) => item.ok));
        const state = uncertain ? 'unknown' : (sent.ok ? 'sent' : (partial ? 'partial' : 'failed'));
        // EffectLedger 没有 partial：只要已经有外部写入但没全成，就按 unknown 处理，绝不自动重试。
        const effectState = uncertain || partial ? 'unknown' : (sent.ok ? 'sent' : 'failed');
        try {
          effects.settle(began.id, effectState, {
            messageIds: sent.messageIds,
            items: sent.items,
            error: sent.error || ''
          });
        } catch { /* 结算失败不改变已经发生的发送事实 */ }
        record(target, {
          state,
          messageIds: sent.messageIds,
          items: sent.items,
          completedAt: nowFn(),
          error: sent.error || ''
        });
      } catch (error) {
        // 单个目标的实现异常不能终止整批，也不能被当成“可证明没发出”的 failed 而自动重试。
        const uncertain = Boolean(began && store.hasUncertainEffects?.(began.id));
        if (began) {
          try { effects.settle(began.id, uncertain ? 'unknown' : 'failed', { error: String(error?.message ?? error) }); } catch { /* 忽略 */ }
        }
        record(target, {
          state: uncertain ? 'unknown' : 'failed',
          messageIds: [],
          items: [],
          completedAt: nowFn(),
          error: String(error?.message ?? error)
        });
      }
      if (index < action.targets.length - 1 && targetGapMs > 0) await sleep(targetGapMs);
    }
    const states = Object.values(results).map((item) => item.state);
    let state = 'sent';
    if (states.some((value) => value === 'unknown')) state = 'unknown';
    else if (states.some((value) => value === 'partial')) state = 'partial';
    else if (states.some((value) => value === 'failed' || value === 'skipped')) {
      state = states.some((value) => value === 'sent') ? 'partial' : 'failed';
    } else if (!states.length) state = 'failed';
    let finished = { ...action, state, results };
    try {
      finished = actions.finish(action.id, { state, results }) || finished;
    } catch (error) {
      log(`[admin-send] ${action.id} 终态落盘失败：${error?.message ?? error}`);
    }
    auditSafe(audit, {
      action: 'admin.send.result',
      target: action.id,
      ok: state === 'sent',
      after: {
        actor: action.actor, state,
        targets: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, {
          state: value.state, messageIds: value.messageIds, error: value.error
        }]))
      }
    });
    log(`[admin-send] ${action.id} ${state}：${Object.entries(results)
      .map(([key, value]) => `${key}=${value.state}`).join(', ')}`);
    return { action: finished, ok: state === 'sent', state, results };
  }

  async function sendItems(target, items, runId, actionId, ownerChatKey) {
    const messageIds = [];
    const itemResults = [];
    for (let index = 0; index < items.length; index += 1) {
      let item = items[index];
      try {
        // 计划阶段只存 messageId；这里重新取一次签名 URL，避免 2 分钟确认窗口内过期。
        item = await refreshItem(item, { onebot, store, ownerChatKey });
        let result;
        if (item.type === 'text') {
          result = await sender.sendTextBatch(target, [item.text], { runId, persona: false });
          const sentIds = (result?.sent || []).map((row) => row?.messageId).filter((mid) => mid != null).map(String);
          messageIds.push(...sentIds);
          if (Array.isArray(result?.failed) && result.failed.length) {
            throw new Error(result.failed.map((failure) => failure.error).join('；'));
          }
          itemResults.push({ type: 'text', ok: true, messageId: sentIds[0] || null, at: nowFn() });
          continue;
        } else if (item.type === 'image') {
          result = await sender.sendImage(target, {
            id: `admin-${actionId}-${index}`, url: item.url, desc: item.desc
          }, { runId });
        } else if (item.type === 'forward') {
          result = await sender.sendForwardCard(target, item.nodes, { runId });
        } else if (item.type === 'file') {
          result = await sender.groupFile(target, { file: item.url, name: item.name }, { runId });
        } else if (item.type === 'voice') {
          result = await sender.voice(target, {
            file: item.url, seconds: item.seconds, label: item.label
          }, { runId });
        } else if (item.type === 'aiVoice') {
          result = await sender.aiVoice(target, {
            character: item.character, text: item.text, label: item.text
          }, { runId });
        } else {
          throw new Error(`不支持的内容类型：${item.type}`);
        }
        const mid = messageIdOf(result);
        if (mid != null) messageIds.push(String(mid));
        itemResults.push({ type: item.type, ok: true, messageId: mid == null ? null : String(mid), at: nowFn() });
      } catch (error) {
        const uncertain = store.hasUncertainEffects?.(runId) === true;
        itemResults.push({
          type: item.type, ok: false, error: String(error?.message ?? error)
        });
        return {
          ok: false,
          uncertain,
          messageIds,
          items: itemResults,
          error: String(error?.message ?? error)
        };
      }
    }
    return { ok: true, uncertain: false, messageIds, items: itemResults, error: '' };
  }

  async function recall({ actionId, actor, latest = false } = {}) {
    const action = latest ? actions.last(actor) : actions.get(actionId);
    if (!action) throw new Error('找不到可撤回的发送动作');
    if (actor && String(action.actor) !== String(actor)) throw new Error('发送动作不属于当前管理员');
    if (['pending', 'executing', 'cancelled', 'expired'].includes(action.state)) {
      throw new Error(`动作 ${action.id} 当前状态是 ${action.state}，不能撤回`);
    }
    const recalled = [];
    const skipped = [];
    const errors = [];
    for (const [target, result] of Object.entries(action.results || {})) {
      if (result.state === 'unknown') {
        skipped.push({ target, messageId: '', reason: '该目标结果未知，先人工核对再撤回' });
        continue;
      }
      if (!['sent', 'partial'].includes(result.state)) continue;
      const completedAt = Number(result.completedAt || result.sentAt || action.executedAt) || 0;
      if (completedAt && nowFn() - completedAt > RECALL_WINDOW_MS) {
        skipped.push({ target, messageId: '', reason: '该目标已超过 5 分钟撤回窗口' });
        continue;
      }
      for (const mid of result.messageIds || []) {
        const entry = store.findByMid?.(target, mid);
        if (!entry?.self) {
          skipped.push({ target, messageId: mid, reason: '本地找不到机器人自己的这条消息，未撤回' });
          continue;
        }
        try {
          await onebot.deleteMessage(Number(mid));
          recalled.push({ target, messageId: mid });
        } catch (error) {
          errors.push({ target, messageId: mid, error: String(error?.message ?? error) });
        }
      }
    }
    actions.update(action.id, {
      recalledAt: nowFn(),
      recall: { recalled, skipped, errors }
    });
    auditSafe(audit, {
      action: 'admin.send.recall',
      target: action.id,
      ok: errors.length === 0,
      after: { actor, recalled, skipped, errors }
    });
    return { action, recalled, skipped, errors };
  }

  /**
   * 控制台核对 outbox 后，把它对应 admin-send effect 的目标结果回写到动作文件。
   * outbox 的 run_id 就是 effect.id；effect.detail 里有 actionId/target。
   */
  function reconcileEffect({ runId, result, messageId = null, chatKey = '' } = {}) {
    const effect = effects.getById?.(String(runId || ''));
    if (!effect || effect.kind !== 'admin-send') return false;
    const actionId = effect.detail?.actionId;
    const target = effect.detail?.target || chatKey;
    if (!actionId || !target) return false;
    const action = actions.get(actionId);
    if (!action || !['unknown', 'partial', 'failed'].includes(action.state)) return false;
    const results = { ...(action.results || {}) };
    const current = results[target] || { state: 'unknown', messageIds: [], items: [], error: '' };
    const ids = new Set(current.messageIds || []);
    if (messageId != null && String(messageId) !== '') ids.add(String(messageId));
    let targetState = current.state;
    if (result === 'sent') targetState = current.state === 'partial' ? 'partial' : 'sent';
    else if (result === 'failed') targetState = ['sent', 'partial'].includes(current.state) ? current.state : 'failed';
    else return false;
    results[target] = {
      ...current,
      state: targetState,
      messageIds: [...ids],
      completedAt: current.completedAt || nowFn(),
      error: result === 'failed' ? (current.error || '人工核对：未发送') : (current.error || '')
    };
    const states = Object.values(results).map((item) => item.state);
    let state = 'sent';
    if (states.some((value) => value === 'unknown')) state = 'unknown';
    else if (states.some((value) => value === 'partial')) state = 'partial';
    else if (states.some((value) => value === 'failed' || value === 'skipped')) {
      state = states.some((value) => value === 'sent') ? 'partial' : 'failed';
    } else if (!states.length) state = 'failed';
    const complete = Object.keys(results).length >= (action.targets || []).length
      && !states.some((value) => value === 'unknown');
    if (complete) actions.finish(action.id, { state, results });
    else actions.update(action.id, { results });
    auditSafe(audit, {
      action: 'admin.send.reconcile', target: action.id, ok: result === 'sent',
      after: { actor: 'console', effectId: runId, target, result, messageId, state }
    });
    return true;
  }

  return {
    plan, execute, confirmByCode, cancelByCode, cancelById, findByCode, recall, reconcileEffect,

    last: (actor) => actions.last(actor)
  };
}
