// 管理员早报（Issue #42）：每天固定时刻，把过去 24 小时白名单群里的聊天
// 让模型用自己的口吻私聊给全局管理员，不是发到群里、也不是运行状态报告。
//
// 与「群日报」（group-digest）共用同一套约束：白名单制、默认关、消息太少跳过、
// 当天去重、不可运行时延迟补跑、发送结果不确定不自动重发（发送走 sender 的 outbox）。
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
import { idList } from '../core/list.js';

const STATE_FILE = path.join(DATA_DIR, 'admin-briefing-state.json');
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_MESSAGES = 5;             // 全部群加起来少于这个数就不打扰管理员
const MAX_GROUPS = 12;
const MAX_INPUT_CHARS = 6000;       // 喂给模型的样本上限
const MAX_LINES_PER_GROUP = 60;     // 单群最多抽这么多行，避免一个大群吃掉全部预算
const DEFER_MS = 30 * 60 * 1000;
const DEFER_MAX = 8;

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function beijingTime(ts) {
  try {
    return new Date(Number(ts) || 0).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch {
    return '--:--';
  }
}

/** 按小时分桶、每桶最多 2 条：消息多时也不会只看到某个时间点（请求里明确要求按时间段抽样）。 */
function stratifiedLines(rows, limit = MAX_LINES_PER_GROUP) {
  const buckets = new Map();
  for (const m of rows) {
    const hour = new Date(Number(m.ts) || 0).toLocaleString('en-US', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false
    });
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour).push(m);
  }
  const lines = [];
  for (const hour of [...buckets.keys()].sort()) {
    for (const m of buckets.get(hour).slice(-2)) {
      if (lines.length >= limit) return lines;
      const name = m.self
        ? '我'
        : displayNameOf(String(m.senderId || ''), String(m.senderName || ''));
      const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!text) continue;
      lines.push(`${beijingTime(m.ts)} ${name}: ${text}`);
    }
  }
  return lines;
}

export class AdminBriefingManager {
  constructor({ store, sender, sessions = null, log = console.log, now = () => Date.now() } = {}) {
    this.store = store;
    this.sender = sender;
    this.sessions = sessions;
    this.log = log;
    this.now = now;
    this.timer = null;
    this.deferTimer = null;
    this.deferAttempts = 0;
    this.running = false;
    this.stopped = true;
    this.lastRun = null;
  }

  #cfg() {
    const raw = getConfig().adminBriefing || {};
    return {
      enabled: raw.enabled === true,
      time: HHMM_RE.test(String(raw.time || '')) ? String(raw.time) : '09:30',
      // 前端勾选框的 value 是 group:<群号>（与群日报一致），手写配置也可能只写群号：两种都收。
      chats: idList(raw.chats)
        .map((x) => String(x).trim().replace(/^group:/i, ''))
        .filter((x) => /^\d{5,15}$/.test(x)),
      maxChars: Math.min(600, Math.max(80, Number(raw.maxChars) || 300))
    };
  }

  /** 全局管理员 QQ（设置 → 管理员）；未配置就不跑，绝不猜一个收件人。 */
  #target() {
    const owner = String(getConfig().admin?.ownerUin || '').trim();
    return /^\d{5,15}$/.test(owner) ? `private:${owner}` : '';
  }

  #state() {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return { day: String(state?.day || ''), status: String(state?.status || '') };
    } catch {
      return { day: '', status: '' };
    }
  }

  /** 当天只要尝试过（含 sending/unknown/failed）就不再自动发：宁可少发一次，也不重复私聊管理员。 */
  #todayDone() {
    const state = this.#state();
    return state.day === todayKey(this.now()) && state.status !== '';
  }

  #writeState(status, day = todayKey(this.now())) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ day, status, at: this.now() }), { mode: 0o600 });
      fs.renameSync(tmp, STATE_FILE);
    } catch { /* 状态写不进去只影响重启后的补跑判断 */ }
  }

  #scheduleDefer() {
    if (this.deferAttempts >= DEFER_MAX) return;
    this.deferAttempts += 1;
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = setTimeout(() => {
      this.deferTimer = null;
      withTrace(newTraceId(), () => this.runOnce({ skipDone: true }))
        .catch((error) => this.log('[admin-briefing] 补跑出错:', error));
    }, DEFER_MS);
    if (this.deferTimer.unref) this.deferTimer.unref();
    this.log(`[admin-briefing] 当前不可运行，${DEFER_MS / 60000} 分钟后重试（第 ${this.deferAttempts} 次）`);
  }

  reconfigure() {
    this.stop();
    this.deferAttempts = 0;
    this.stopped = false;
    this.#scheduleNextDay({ startupCatchup: true });
  }

  /**
   * 排下一天的定时器。不能直接复用 reconfigure()：定时回调和补跑逻辑会先把
   * 30 分钟 defer 排上，reconfigure 里的 stop() 会把它清掉（当天永久丢失）。
   */
  #scheduleNextDay({ startupCatchup = false } = {}) {
    const gen = (this.scheduleGen || 0) + 1;
    this.scheduleGen = gen;
    const cfg = this.#cfg();
    if (!cfg.enabled) return;
    if (!this.#target()) {
      this.log('[admin-briefing] 未配置管理员 QQ，已停用');
      return;
    }
    const at = nextAtFromHHMM(cfg.time, this.now());
    if (at === null) {
      this.log('[admin-briefing] 时间格式不合法（应为 HH:MM），已停用');
      return;
    }
    // 当天计划时刻已过且还没发 → 启动时补跑一次（与群日报/动态同一语义）
    const todayOccurrence = todayKey(at) === todayKey(this.now()) ? at : at - 24 * 60 * 60 * 1000;
    if (startupCatchup && this.now() >= todayOccurrence && !this.#todayDone()) {
      this.log('[admin-briefing] 今天的计划时刻已过且还没发，立即补跑一次');
      withTrace(newTraceId(), () => this.runOnce({ skipDone: true }))
        .catch((error) => this.log('[admin-briefing] 补跑出错:', error));
    }
    const wait = Math.max(1000, at - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      withTrace(newTraceId(), () => this.runOnce({ skipDone: true }))
        .catch((error) => this.log('[admin-briefing] 运行出错:', error))
        .finally(() => {
          // 只有"当前这一代"定时器才能排下一天：配置保存会重建定时器，
          // 旧回调的 finally 不能给新定时器再叠一个。
          if (!this.stopped && gen === this.scheduleGen) this.#scheduleNextDay();
        });
    }, wait);
    if (this.timer.unref) this.timer.unref();
    this.log(`[admin-briefing] 已排程：${cfg.time} → 管理员私聊`);
  }

  start() { this.reconfigure(); }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.timer = null;
    this.deferTimer = null;
  }

  status() {
    const cfg = this.#cfg();
    return {
      enabled: cfg.enabled,
      time: cfg.time,
      chats: cfg.chats,
      maxChars: cfg.maxChars,
      target: this.#target(),
      running: this.running,
      lastRun: this.lastRun
    };
  }

  /** 配置里的群优先；留空 = 所有当前可运行的白名单群。 */
  #groupKeys(cfg) {
    const keys = cfg.chats.length
      ? cfg.chats.map((id) => `group:${id}`)
      : idList(getConfig().allow?.groups).map((id) => `group:${id}`);
    return [...new Set(keys)].filter((key) => canRun(key));
  }

  async runOnce({ skipDone = false } = {}) {
    if (this.running) return { skipped: 'already-running' };
    const cfg = this.#cfg();
    if (skipDone && !cfg.enabled) return { skipped: 'disabled' };
    const target = this.#target();
    if (!target) return { skipped: 'no-admin' };
    if (!canRun(target)) {
      if (skipDone) this.#scheduleDefer();
      return { skipped: 'blocked', error: '观察/暂停模式，或管理员不在私聊白名单' };
    }
    if (skipDone && this.#todayDone()) return { skipped: 'already-sent-today' };

    const groupKeys = this.#groupKeys(cfg);
    if (!groupKeys.length) {
      // 有群但此刻全部不可运行（观察/暂停/非活跃时段）→ 30 分钟后补跑；
      // 一个群都没配/没在白名单 → 不重试。
      if (skipDone && idList(getConfig().allow?.groups).length) this.#scheduleDefer();
      return { skipped: 'no-groups' };
    }
    this.running = true;
    // 跨午夜完成时按"开始这一天"落盘，否则会把第二天标成已发、次日早报被跳过。
    const runDay = todayKey(this.now());
    try {
      const since = this.now() - WINDOW_MS;
      const groups = groupKeys.slice(0, MAX_GROUPS).map((chatKey) => {
        const rows = filterBlockedHistory(
          this.store.recent(chatKey, { limit: 500, includeSelf: true, readOnly: true }), chatKey
        ).filter((m) => Number(m.ts) >= since && m.eventKind !== 'game-secret');
        return { chatKey, rows, lines: stratifiedLines(rows) };
      }).sort((a, b) => b.rows.length - a.rows.length);
      const totalMessages = groups.reduce((sum, g) => sum + g.rows.length, 0);
      if (totalMessages < MIN_MESSAGES) {
        this.#writeState('skipped', runDay);
        this.lastRun = { at: this.now(), skipped: 'too-few', totalMessages };
        return { skipped: 'too-few', totalMessages };
      }

      const perGroupBudget = Math.max(300, Math.floor(MAX_INPUT_CHARS / groups.length));
      const sections = [];
      let used = 0;
      for (const g of groups) {
        if (!g.lines.length) continue;
        const body = [];
        for (const line of g.lines) {
          if (used + line.length > MAX_INPUT_CHARS || body.join('\n').length > perGroupBudget) break;
          body.push(line);
          used += line.length;
        }
        if (body.length) sections.push(`【${g.chatKey}，共 ${g.rows.length} 条】\n${body.join('\n')}`);
      }
      if (!sections.length) {
        this.#writeState('skipped', runDay);
        return { skipped: 'no-speakable' };
      }

      const prompt = [
        '下面是过去 24 小时（北京时间，截至现在）几个群里的聊天样本，已按小时分散抽样。',
        '请以你自己的口吻，私聊给管理员讲讲昨天在群里看到的事。',
        '要求：',
        '- 第一人称、像私下闲聊，不要"总结/汇报如下"这类公文腔，不要 Markdown、不要分条列清单；',
        '- 挑真正有意思的、让你有反应的事说；可以提到让你印象深的群友，并说清为什么；',
        '- 不同群的事分开说，别混在一起；不要罗列所有消息；',
        '- 没有值得说的就一两句话带过，别硬凑；',
        `- 全文不超过 ${cfg.maxChars} 字。`,
        '',
        sections.join('\n\n')
      ].join('\n');

      const r = await chatCompletion({
        messages: [
          { role: 'system', content: '你在 QQ 群里和群友聊天，现在是在私下跟管理员说话。用自然口语，不写公告、不列条目。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        purpose: 'write'
      });
      try {
        const usage = emptyUsage();
        addUsage(usage, r?.usage);
        usage.calls = 1;
        const vendor = r?.originBaseUrl ? vendorOfBaseUrl(getConfig(), r.originBaseUrl) : '';
        this.sessions?.recordExternalUsage?.(usage, { model: r?.model || '', vendor });
      } catch { /* 记账失败不影响发送 */ }

      const text = String(r.message?.content || '').trim().slice(0, cfg.maxChars);
      if (!text) {
        this.#writeState('failed', runDay);
        return { ok: false, error: '模型没有产出内容' };
      }
      // 发送前先落 sending：进程在发送途中被重启时，不能又走一次启动补跑重复私聊。
      this.#writeState('sending', runDay);
      let sent;
      try {
        sent = await this.sender.sendTextBatch(target, [text], {});
      } catch (error) {
        this.#writeState('unknown', runDay);
        return { ok: false, error: `发送失败或结果不确定，今天不再自动重试：${error?.message ?? error}` };
      }
      const delivered = Array.isArray(sent?.sent) ? sent.sent.length : 0;
      if (!delivered) {
        this.#writeState('unknown', runDay);
        return { ok: false, error: '发送结果不确定，今天不再自动重试（等人工核对/下一天）' };
      }
      this.#writeState('sent', runDay);
      this.deferAttempts = 0;
      this.lastRun = { at: this.now(), ok: true, chars: text.length, groups: sections.length, totalMessages };
      return { ok: true, chars: text.length, groups: sections.length, totalMessages };
    } finally {
      this.running = false;
    }
  }
}
