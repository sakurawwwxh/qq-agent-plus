// 群日报：每天固定时刻，把"昨天群里聊了啥"汇总成一条（模型生成、口语化）发到配置的群。
// 白名单制（groupDigest.chats 列表），默认关；发送走 sender 的正常通道（限频/留档与普通发言一致）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';
import { vendorOfBaseUrl } from '../pricing/model-prices.js';
import { todayKey } from '../core/util.js';
import { canRun } from '../core/access.js';
import { filterBlockedHistory } from '../core/blocklist.js';
import { chatCompletion, addUsage, emptyUsage } from '../llm/llm.js';
import { nextAtFromHHMM } from '../core/reminders.js';
import { displayNameOf } from '../core/display-name.js';
import { newTraceId, withTrace } from '../core/logger.js';

const MIN_MESSAGES = 5;          // 少于这个数不生成（"昨天没人说话"没必要日报）
const WINDOW_MS = 24 * 60 * 60 * 1000;
const SAMPLE_CHARS = 2200;       // 喂给模型的聊天样本上限（省 token）
const STATE_FILE = path.join(DATA_DIR, 'group-digest-state.json');
const DEFER_MS = 30 * 60 * 1000; // 被观察/暂停挡下时的当日重试间隔
const DEFER_MAX = 8;             // 最多重试 8 次（约 4 小时覆盖），之后等下一个计划日

export class GroupDigestManager {
  constructor({ store, sender, sessions = null, effects = null, log = console.log, now = () => Date.now() } = {}) {
    this.store = store;
    this.sender = sender;
    this.sessions = sessions;
    // 出站副作用账本：同一天同一个群只发一次（幂等键用"归属日"，不是发送时刻）
    this.effects = effects;
    this.log = log;
    this.now = now;
    this.timer = null;
    this.deferTimer = null;
    this.deferAttempts = 0;
    this.running = false;
    this.lastRun = null;
  }

  #cfg() {
    const raw = getConfig().groupDigest || {};
    return {
      enabled: raw.enabled === true,
      time: String(raw.time || '09:30'),
      chats: Array.isArray(raw.chats) ? raw.chats.map((x) => String(x || '').trim()).filter(Boolean) : [],
      maxChars: Math.min(600, Math.max(80, Number(raw.maxChars) || 300))
    };
  }

  start() {
    this.reconfigure();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
  }

  /** 持久化的"最近一次真正跑完的日期"（内存里那份重启就没了，补跑判断要靠它）。 */
  /**
   * 今天已经发过哪些群：{ any, done, legacy }。
   *  - done = 今天已完成的群（新状态逐群记）；
   *  - 老状态只有 lastRanDay（历史版本 / 外部写入）→ legacy=true，视为「今天整体跑过了」，保持旧口径；
   *  - any = 今天跑没跑过（单独判断"一个群都没发出去"时用）。
   */
  #todayDone(day = todayKey(this.now())) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state?.lastRanDay !== day) return { any: false, done: new Set(), legacy: false };
      if (Array.isArray(state.doneChats)) return { any: state.doneChats.length > 0, done: new Set(state.doneChats), legacy: false };
      return { any: true, done: new Set(), legacy: true };
    } catch { return { any: false, done: new Set(), legacy: false }; }
  }

  // 每群发完就落盘「已完成的群」：只在整轮结束时写的话，多群串行发到一半被重启（每次部署都会重启）
  // 会让下一次启动把已经收到日报的群再发一遍（2026-10-13 全项目审查 P2-3）。
  #writeProgress(done, day = todayKey(this.now())) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      // 归属日由调用方传入：一轮跨过午夜时，日期必须还是"开始那一轮"的日子。
      // 用写盘时刻的 todayKey 会把第二天标成已发（2026-10-30 审查 P2）。
      fs.writeFileSync(tmp, JSON.stringify({ lastRanDay: day, doneChats: [...done] }), { mode: 0o600 });
      fs.renameSync(tmp, STATE_FILE);
    } catch { /* 状态写不进去只影响重启后的补跑判断 */ }
  }

  /** 全部群都被"观察/暂停/白名单"挡下时的当日重试（30 分钟一次，最多 8 次）。 */
  #scheduleDefer() {
    if (this.deferAttempts >= DEFER_MAX) return;   // 放弃当天，等下一个计划日
    this.deferAttempts += 1;
    // 覆盖句柄前先清旧的：手动「立即运行」+ 自动补跑可能各排一个，旧的会变成孤儿，
    // 关闭功能后 stop() 清不到它，30 分钟后仍可能发日报（2026-10-19 复审 P2）。
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = setTimeout(() => {
      this.deferTimer = null;
      withTrace(newTraceId(), () => this.runOnce({ skipDone: true })).catch((error) => this.log('[group-digest] 补跑出错:', error));
    }, DEFER_MS);
    if (this.deferTimer.unref) this.deferTimer.unref();
    this.log(`[group-digest] 当前不可运行，${DEFER_MS / 60000} 分钟后重试（第 ${this.deferAttempts} 次）`);
  }

  reconfigure() {
    this.stop();
    this.deferAttempts = 0;
    const cfg = this.#cfg();
    if (!cfg.enabled) return;
    const at = nextAtFromHHMM(cfg.time, this.now());
    if (at === null) {
      this.log('[group-digest] 时间格式不合法（应为 HH:MM），已停用');
      return;
    }
    // 补跑（2026-10-12 审查）：进程在计划时刻之后才启动（或计划时刻整段关机）时，
    // 原先直接排到下一天 —— 当天整日跳过、无任何记录。当天这个时刻已过且今天没跑过
    // → 立即补一次（与 daily-moments 的 startupCatchup 同一语义）。
    // 判定看的是**还有哪些群没发**，不是"今天有没有跑过"：多群串行发到一半被重启（部署即重启）时，
    // 用后者的口径会把剩下的群整天咽掉 —— 既没有日报也没有任何记录（2026-10-14 复审 P3）。
    // legacy 状态（老文件只有 lastRanDay）例外：不知道跑了哪些群，按旧口径整体当已跑过。
    const todayOccurrence = todayKey(at) === todayKey(this.now()) ? at : at - 24 * 60 * 60 * 1000;
    const doneToday = this.#todayDone();
    const pending = doneToday.legacy ? [] : cfg.chats.filter((chatKey) => !doneToday.done.has(chatKey));
    if (this.now() >= todayOccurrence && pending.length) {
      this.log(`[group-digest] 今天的计划时刻已过，还有 ${pending.length} 个群没发，立即补跑一次`);
      withTrace(newTraceId(), () => this.runOnce({ skipDone: true })).catch((error) => this.log('[group-digest] 补跑出错:', error));
    }
    const wait = Math.max(1000, at - this.now());
    this.timer = setTimeout(() => {
      withTrace(newTraceId(), () => this.runOnce({ skipDone: true })).catch((error) => this.log('[group-digest] 运行出错:', error));
      this.reconfigure();   // 排下一天
    }, wait);
    if (this.timer.unref) this.timer.unref();
    this.log(`[group-digest] 已排程：${cfg.time}，群 ${cfg.chats.length} 个`);
  }

  status() {
    const cfg = this.#cfg();
    return {
      enabled: cfg.enabled,
      time: cfg.time,
      chats: cfg.chats,
      running: this.running,
      lastRun: this.lastRun
    };
  }

  /** 立即跑一轮（控制台手动触发/测试用）。返回每个群的执行结果。 */
  async runOnce({ skipDone = false, forceUnknown = false } = {}) {
    if (this.running) return { skipped: 'already-running' };
    const cfg = this.#cfg();
    // 自动补跑（skipDone）必须尊重 enabled：关闭功能时 stop() 可能已经错过某个在途补跑，
    // 手动「立即运行」不传 skipDone，仍按显式意图执行（2026-10-19 复审 P2）。
    if (skipDone && !cfg.enabled) return { skipped: 'disabled' };
    if (!cfg.chats.length) return { skipped: 'no-chats' };
    this.running = true;
    const results = [];
    // 归属日：整轮只算一次。跨午夜时发送时刻已经是第二天，但这一轮仍属于开始那天。
    const day = todayKey(this.now());
    try {
      const done = this.#todayDone(day).done;
      for (const chatKey of cfg.chats) {
        // 只对**自动**路径跳过：控制台手点重跑是明确意图，不该被「今天发过」挡下。
        if (skipDone && done.has(chatKey)) { results.push({ chatKey, ok: true, skipped: 'already-sent-today' }); continue; }
        try {
          const r = await this.#digestOne(chatKey, cfg, day, { forceUnknown });
          results.push({ chatKey, ...r });
          // 被观察/暂停/白名单挡下的群不算"今天已完成"：否则 30 分钟后的补跑会把它们
          // 当 already-sent-today 跳过，当天日报永久丢失（2026-10-19 全项目审查 P2）。
          const blocked = r.ok === false && /观察\/暂停|还在发送中/.test(String(r.error || ''));
          if (!blocked) {
            done.add(chatKey);
            this.#writeProgress(done, day);
          }
        } catch (error) {
          const msg = String(error?.message ?? error).slice(0, 200);
          results.push({ chatKey, ok: false, error: msg });
          this.log(`[group-digest] ${chatKey} 失败：${msg}`, error);
        }
      }
      this.lastRun = { at: this.now(), results };
      // 有群被观察/暂停挡下：30 分钟后重试（skipDone 会跳过已经发成功的群，只补没发的）。
      const anyBlocked = results.some((r) => r.ok === false && /观察\/暂停|还在发送中/.test(String(r.error || '')));
      if (anyBlocked) {
        this.#scheduleDefer();
      } else {
        this.deferAttempts = 0;
      }
      return { ok: true, results };
    } finally {
      this.running = false;
    }
  }

  async #digestOne(chatKey, cfg, day = todayKey(this.now()), { forceUnknown = false } = {}) {
    if (!String(chatKey).startsWith('group:')) return { ok: false, error: '只支持群聊' };
    // 门禁放在**读消息与调模型之前**：原来只在最后 sendTextBatch 时才被 access 挡住，
    // 于是观察/暂停模式、已移出白名单（allow）或被手改 deny 的群，每天照样读 400 条消息 +
    // 调一次 chatCompletion 才被拒 —— 白花钱还把群消息送出了网（2026-10-03 全量审查）。
    if (!canRun(chatKey)) return { ok: false, error: '观察/暂停模式，或该会话不在白名单内' };
    // 账本（docs/EFFECT-LEDGER.md）：幂等键用**归属日**，跨午夜补跑/部署重启都不会把
    // 同一份日报发两遍；上次结果未知时停止自动重试，等人工核对后再手动运行。
    let began = this.effects?.begin({
      kind: 'digest',
      chatKey,
      idemKey: `digest:${chatKey}:${day}`,
      detail: { day }
    });
    if (began?.action === 'review') {
      // 人工点「立即试跑一次」= 明确确认要重试：把 unknown 改判为 failed（留 resolvedBy 审计）
      // 再重新 begin。自动补跑（skipDone）绝不做这一步 —— unknown 不自动重试。
      if (forceUnknown && this.effects?.resolve) {
        // 上次发送留下的 outbox unknown 行还挂在同一个 effect id 上：sender 的
        // hasUncertainEffects 会在真正发送前直接抛错，不清掉人工恢复永远走不通。
        // 管理员明确点了重试 = 接受"可能重复"的风险，这里按"确认未发送"核对掉。
        let cleared = true;
        for (const op of this.store.listUnknownOperations?.(chatKey, 500) || []) {
          if (String(op.runId || '') !== String(began.id)) continue;
          if (!this.store.reconcileUnknownOperation?.(op.id, 'failed')) cleared = false;
        }
        if (!cleared) return { ok: false, error: '清理上次未知发送失败，请稍后再试' };
        this.effects.resolve(began.id, 'failed', { reason: 'manual-force' });
        began = this.effects.begin({
          kind: 'digest',
          chatKey,
          idemKey: `digest:${chatKey}:${day}`,
          detail: { day }
        });
        if (began?.action !== 'proceed') return { ok: false, error: '强制重试没有生效，请检查账本状态' };
      } else {
        return { ok: false, error: '上一次日报投递结果未知，已停止自动重试（可在控制台点「立即试跑一次」确认重试）' };
      }
    }
    if (began) {
      if (began.action === 'done') return { ok: true, skipped: 'effect-done' };
      if (began.action === 'in-flight') return { ok: false, error: '上一轮日报还在发送中' };
    }
    const effectId = began?.id || null;
    let settled = false;
    const settle = (state, detail = {}) => { settled = true; if (effectId) this.effects.settle(effectId, state, detail); };
    try {
      const since = this.now() - WINDOW_MS;
      const rows = filterBlockedHistory(
        this.store.recent(chatKey, { limit: 400, includeSelf: true, readOnly: true }), chatKey
      ).filter((m) => Number(m?.ts) >= since);
      // 媒体/分享占位不是系统噪声：日报里保留它们，才能看到群里发过图、卡片、转发和分享。
      const mediaPlaceholder = /^\[(?:图片|表情包|卡片|合并转发|视频|语音|B站分享|插件分享)/;
      const speakable = rows.filter((m) => {
        const text = String(m?.text || '').trim();
        if (!text) return false;
        return !/^\[/.test(text) || mediaPlaceholder.test(text);
      });
      if (rows.length < MIN_MESSAGES) {
        // 没发出去，也还没调模型：按 failed 结算（允许稍后手动再跑），
        // 不留下 planned 让下一次 begin 当成"在途"而永久卡住。
        settle('failed', { stage: 'too-few-messages', messages: rows.length });
        return { ok: false, error: `消息太少（${rows.length} 条），跳过` };
      }
      // 参与者统计（含机器人自己的发言）
      const byUser = new Map();
      for (const m of rows) {
        const uid = String(m?.senderId || '');
        if (!uid) continue;
        // 称呼统一（2026-10-11 反馈：日报还喊群名片）——备注/代号优先，与聊天提示词同一口径
        const cur = byUser.get(uid) || { name: displayNameOf(uid, String(m?.senderName || '')), count: 0 };
        cur.count += 1;
        byUser.set(uid, cur);
      }
      const top = [...byUser.values()].sort((a, b) => b.count - a.count).slice(0, 4);
      // 样本：从 tail 往前取，直到字符上限（越新越重要）
      const sample = [];
      let used = 0;
      for (const m of [...speakable].reverse()) {
        const line = `${m.self ? '我' : displayNameOf(String(m?.senderId || ''), String(m?.senderName || ''))}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 120)}`;
        if (used + line.length > SAMPLE_CHARS) break;
        sample.push(line);
        used += line.length;
      }
      sample.reverse();
      const prompt = [
        '下面是一段群聊记录（最近的排在后）。请写一条"群日报"发给群里：用你的口吻，1~3 句短句（分条发就传数组的写法不需要，这里只要一条文本，句间用换行），',
        '概括这段时间群里聊了什么、有什么好玩的事；不列清单、不用"总结/日报如下"这类公文腔，像群友随口复盘。',
        `参与活跃：${top.map((t) => `${t.name}(${t.count}条)`).join('、')}；总消息 ${rows.length} 条。`,
        '',
        sample.join('\n')
      ].join('\n');
      let r;
      try {
        r = await chatCompletion({
        messages: [
          { role: 'system', content: '你是这个群里的普通群友，用口语聊天，不用 Markdown、不列条目、不写"大家"之类的客服腔。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        purpose: 'write'
        // 不设 maxTokens：思考模型（如 Command Code 上的 deepseek）的思考 token 也吃这个预算，
        // 压太小会出现"思考完预算没了 → content 为空"（2026-09-28 服务器实测）。输出长度用 maxChars 截。
        });
      } catch (error) {
        // 模型没产出 = 明确没发出去：failed 允许下一次（手动/次日）重来
        settle('failed', { stage: 'model', error: String(error?.message ?? error).slice(0, 200) });
        throw error;
      }
      // 群日报的模型调用也花钱：计入今日台账（此前完全没账，2026-10-07 复审 P3）。
      try {
        const usage = emptyUsage();
        addUsage(usage, r?.usage);
        usage.calls = 1;
        const vendor = r?.originBaseUrl ? vendorOfBaseUrl(getConfig(), r.originBaseUrl) : '';
        this.sessions?.recordExternalUsage?.(usage, { model: r?.model || '', vendor });
      } catch { /* 记账失败不影响发布 */ }
      const text = String(r.message?.content || '').trim().slice(0, cfg.maxChars);
      if (!text) {
        settle('failed', { stage: 'model', error: 'empty-content' });
        return { ok: false, error: '模型没有产出内容' };
      }
      // 发送形态：默认走「聊天记录」卡片（platform.forwardCards，2026-10-07 协议端能力升级）。
      // 卡片把一段较长的汇总收在一个可展开的气泡里，比一长串文字更清爽；
      // 关掉开关（控制台「平台能力」）就回到原来的纯文本发送。
      const appCfg = getConfig();
      // asCard 报告"真的走了卡片"：sender 没有这个能力（老接线/降级）时会回落文本，
      // 只看开关键就会回一个与实际不符的 true（2026-10-07 复审 P3）。
      const asCard = appCfg.platform?.forwardCards !== false && typeof this.sender.sendForwardCard === 'function';
      try {
        if (asCard) {
          const nickname = String(appCfg.persona?.selfNickname || '').trim() || '群日报';
          // runId 传 effect id：sender 的 outbox 会挂在这条副作用上，失败时能区分
          // "确定没发出去"与"结果未知"（后者绝不自动重发）。
          await this.sender.sendForwardCard(chatKey, [{
            type: 'node',
            data: { nickname, content: [{ type: 'text', data: { text } }] }
          }], { runId: effectId });
        } else {
          await this.sender.sendTextBatch(chatKey, [text], { runId: effectId });
        }
      } catch (error) {
        const msg = String(error?.message ?? error).slice(0, 200);
        const uncertain = effectId ? this.store.hasUncertainEffects(effectId) : true;
        settle(uncertain ? 'unknown' : 'failed', { stage: 'send', error: msg });
        return {
          ok: false,
          error: uncertain ? `发送结果未知，已停止自动重试，请人工核对：${msg}` : msg
        };
      }
      settle('sent', { asCard, chars: text.length, messages: rows.length });
      return { ok: true, chars: text.length, messages: rows.length, text, asCard };
    } finally {
      if (!settled) settle('failed', { stage: 'unexpected' });
    }
  }
}
