import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from '../core/config.js';
import { cappedByTokenSaver, tokenSaverCapsOf } from '../core/token-saver.js';
import {
  addUsage,
  cachedTokensOfUsage,
  chatCompletionWithRetry,
  emptyUsage
} from '../llm/llm.js';
import { safeFetchBinary, validateImageUrl } from '../llm/safe-fetch.js';
import { convertGifToStillStrip } from '../tools/image-downsample.js';
import { webFetch, webSearch } from '../llm/web-search.js';
import { buildMomentSystemPrompt, momentPersonaHash, MOMENT_PROMPT_VERSION } from '../llm/moment-prompt.js';
import { assertTimeAllowed, isTimeActive, watchTimeWindow, withTimeScope } from '../core/time-gate.js';
import { timeControlState } from '../core/time-control.js';
import { chatAllowed } from '../core/access.js';
import {
  MOMENT_MIN_GAP_MS,
  normalizeMomentWindows,
  updateMomentPlan
} from './moment-schedule.js';
import {
  formatClockTime,
  formatFullTime,
  formatShortTime,
  shanghaiDayStart,
  todayKey,
  ZONE_OFFSET_MS
} from '../core/util.js';
import { resolveToolCalls } from '../tools/inline-tools.js';

const STATE_FILE = path.join(DATA_DIR, 'daily-moments.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCKING_STATUSES = new Set([
  'running', 'skipped', 'publishing', 'published', 'publish-unknown', 'failed'
]);
const PUBLICATION_STATUSES = new Set(['publishing', 'published', 'publish-unknown']);
const automaticSource = (source) => source == null || ['scheduled', 'startup-catchup'].includes(source);
const automaticRecord = (record) => record.publicationSource === 'manual'
  ? false : automaticSource(record.source);

function samePublicationScope(existing, target) {
  if (target.scheduleSlotId && existing.scheduleSlotId === target.scheduleSlotId) return true;
  if (existing.dayKey !== target.dayKey) return false;
  // An unresolved external write remains a hold across both publication paths.
  if (['publishing', 'publish-unknown'].includes(existing.status)) return true;
  if (automaticRecord(existing) !== automaticRecord(target)) return false;
  return !automaticRecord(target)
    || (existing.scheduleSlotId || '') === (target.scheduleSlotId || '');
}
const STYLE_SEEDS = [
  '随手吐槽', '生活碎片', '抽象观察', '今日见闻', '认真想一想', '冷幽默',
  '自言自语', '轻量研究', '情绪片段', '意外联想'
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function normalizedConfig(cfg = getConfig().dailyMoments || {}) {
  const visibility = [1, 4, 16, 64, 128].includes(Number(cfg.visibility))
    ? Number(cfg.visibility)
    : 4;
  return {
    enabled: cfg.enabled === true,
    hour: Math.min(23, Math.max(0, Number(cfg.hour) || 0)),
    minute: Math.min(59, Math.max(0, Number(cfg.minute) || 0)),
    scheduleWindows: normalizeMomentWindows(cfg.scheduleWindows),
    intervalDays: Math.min(30, Math.max(1, Math.round(Number(cfg.intervalDays) || 1))),
    startupCatchup: cfg.startupCatchup !== false,
    minMessagesPerGroup: Math.min(100, Math.max(0, Number(cfg.minMessagesPerGroup) || 0)),
    maxGroups: Math.min(50, Math.max(1, Number(cfg.maxGroups) || 12)),
    maxMessagesPerGroup: Math.min(300, Math.max(5, Number(cfg.maxMessagesPerGroup) || 80)),
    maxPromptChars: Math.min(500000, Math.max(20000, Number(cfg.maxPromptChars) || 120000)),
    allowImages: cfg.allowImages !== false,
    maxImages: Math.min(4, Math.max(0, Number(cfg.maxImages) || 0)),
    visibility,
    targetUins: (Array.isArray(cfg.targetUins) ? cfg.targetUins : [])
      .map(Number).filter(Number.isFinite).slice(0, 200),
    maxResearchCalls: Math.min(10, Math.max(0, Number(cfg.maxResearchCalls) || 0)),
    // 省 Token 模式：日说说的工具轮数也夹上限（关闭时上限为 null，原样取用户设置）。
    // ⚠️ 这里必须用**日说说自己的** cfg.maxRounds，不能借聊天模型的 api.maxRounds ——
    // 两者是不同的旋钮（日说说默认 8、聊天默认 12），换错了会让"轮次预算"多跑几轮、
    // 白烧 token（曾把 moment-publish 的用量用例跑成 180 vs 45）。
    maxRounds: Math.min(16, Math.max(2, cappedByTokenSaver(
      Number(cfg.maxRounds) || 8,
      tokenSaverCapsOf(getConfig())?.maxRounds
    )))
  };
}

function dayStartFromKey(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) throw new Error(`Invalid Shanghai day: ${dayKey}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - ZONE_OFFSET_MS;
}

export function nextDailyMomentAt(now = Date.now(), cfg = getConfig().dailyMoments || {}) {
  const c = normalizedConfig(cfg);
  const todayStart = shanghaiDayStart(now);
  const todayTarget = todayStart + (c.hour * 60 + c.minute) * 60 * 1000;
  return todayTarget > now ? todayTarget : todayTarget + DAY_MS;
}

function scheduledDayAt(now, cfg, startup) {
  const todayStart = shanghaiDayStart(now);
  const target = todayStart + (cfg.hour * 60 + cfg.minute) * 60 * 1000;
  if (now >= target) return todayKey(now);
  if (startup && cfg.startupCatchup) return todayKey(todayStart - 1);
  return '';
}

// 固定时刻模式的发送间隔：以上次成功发布为基准，满 intervalDays 天才到期。
// 没有发布记录（或间隔为 1）时视为到期；失败与跳过不重置基准，次日照常重试。
export function momentIntervalDue(now = Date.now(), cfg = getConfig().dailyMoments || {}, records = []) {
  const c = normalizedConfig(cfg);
  if (c.intervalDays <= 1) return true;
  let lastPublished = 0;
  for (const record of records || []) {
    if (!record || record.status !== 'published') continue;
    let at = Number(record.publishedAt) || Number(record.publishStartedAt) || 0;
    if (!at && record.dayKey) {
      try {
        at = dayStartFromKey(record.dayKey);
      } catch {
        at = 0;
      }
    }
    if (at > lastPublished) lastPublished = at;
  }
  if (!lastPublished) return true;
  const days = Math.round((shanghaiDayStart(now) - shanghaiDayStart(lastPublished)) / DAY_MS);
  return days >= c.intervalDays;
}

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\0/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function momentError(code, message, httpStatus = 409) {
  return Object.assign(new Error(message), { code, httpStatus });
}

function redactPublicContent(value, snapshot) {
  let text = cleanText(value, 1000).replace(/\b[1-9]\d{4,14}\b/g, '[号码已隐藏]');
  for (const group of snapshot.groups) {
    const groupName = cleanText(group.groupName, 100);
    if (groupName.length >= 2) text = text.split(groupName).join('某个群');
    const names = new Set([
      ...(group.memories || []).map((member) => member.name),
      ...(group.messages || []).filter((message) => !message.self).map((message) => message.sender)
    ]);
    for (const rawName of names) {
      const name = cleanText(rawName, 60);
      if ((snapshot.selfNames || []).includes(name)) continue;
      if (name.length >= 2) text = text.split(name).join('有人');
    }
  }
  return text;
}

function imageMime(buffer, contentType = '') {
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50 && buffer?.[2] === 0x4e) return 'image/png';
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8 && buffer?.[2] === 0xff) return 'image/jpeg';
  if (buffer?.toString('ascii', 0, 6) === 'GIF87a'
      || buffer?.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buffer?.toString('ascii', 0, 4) === 'RIFF'
      && buffer?.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return String(contentType || 'image/jpeg').split(';')[0];
}

function openAiTools(defs) {
  return defs.map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters
    }
  }));
}

function auditMessages(messages) {
  return structuredClone(messages).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    message.content = message.content.map((part) => {
      const url = String(part?.image_url?.url || '');
      if (part?.type !== 'image_url' || !url.startsWith('data:')) return part;
      return {
        ...part,
        image_url: {
          ...part.image_url,
          url: `[inline image omitted from audit snapshot; ${url.length} chars]`
        }
      };
    });
    return message;
  });
}

function sanitizeDecision(raw, snapshot, cfg) {
  const fail = (message) => { throw momentError('MOMENT_DECISION_INVALID', message, 422); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('提交参数必须为 JSON 对象');
  const source = raw;
  if (!['publish', 'skip'].includes(source.decision)) fail('decision 必须为 publish 或 skip');
  if (typeof source.reason !== 'string' || !source.reason.trim()) fail('reason 必须填写一句非空的决定理由');
  if (typeof source.content !== 'string') fail('content 必须为字符串');
  if (source.decision === 'publish' && !source.content.trim()) fail('发布正文不能为空');
  if (source.decision === 'skip' && source.content.trim()) fail('skip 时正文应为空；要发布请使用 publish');
  if (!Array.isArray(source.imageIds) || source.imageIds.some((id) => typeof id !== 'string')) {
    fail('imageIds 必须为图片 ID 数组，不配图时填 []');
  }
  if (source.decision === 'skip' && source.imageIds.length) fail('skip 时 imageIds 应为空数组');
  if (source.imageIds.length > cfg.maxImages) fail(`配图不能超过 ${cfg.maxImages} 张`);
  if (!Array.isArray(source.groupSummaries)) fail('groupSummaries 必须为内部群摘要数组');
  const decision = source.decision;
  const knownGroups = new Map(snapshot.groups.map((group) => [group.chatKey, group]));
  const submitted = new Map();
  for (const item of source.groupSummaries) {
    const chatKey = String(item?.chatKey || '');
    if (!knownGroups.has(chatKey) || submitted.has(chatKey)) fail('群摘要包含未知或重复的 chatKey');
    if (typeof item?.summary !== 'string' || !item.summary.trim()) fail('每个群的 summary 必须非空');
    submitted.set(chatKey, cleanText(item.summary, 500));
  }
  if (submitted.size !== knownGroups.size) fail('请为材料中的每个群提交一条内部摘要');
  const groupSummaries = snapshot.groups.map((group) => ({
    chatKey: group.chatKey,
    groupName: group.groupName,
    summary: submitted.get(group.chatKey)
  }));
  const knownImages = new Set(snapshot.imageCandidates.map((image) => image.id));
  if (source.imageIds.some((id) => !knownImages.has(id))) fail('只能选择本次候选图片 ID');
  if (!cfg.allowImages && source.imageIds.length) fail('配图已关闭，请使用空 imageIds');
  const imageIds = [...new Set(source.imageIds)];
  return {
    decision,
    reason: cleanText(source.reason, 500),
    content: decision === 'publish' ? redactPublicContent(source.content, snapshot) : '',
    imageIds: cfg.allowImages ? imageIds : [],
    groupSummaries
  };
}

export class DailyMomentsManager {
  constructor({
    store,
    memory,
    stickers,
    onebot,
    sessions = null,
    resolveChatName = async () => '',
    emit = null,
    complete = chatCompletionWithRetry,
    search = webSearch,
    fetchPage = webFetch,
    validateImage = validateImageUrl,
    fetchBinary = safeFetchBinary,
    setProactiveSuppressed = () => {},
    now = () => Date.now(),
    random = Math.random,
    log = console.log,
    stateFile = STATE_FILE
  }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.onebot = onebot;
    this.sessions = sessions;
    this.resolveChatName = resolveChatName;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.complete = complete;
    this.search = search;
    this.fetchPage = fetchPage;
    this.validateImage = validateImage;
    this.fetchBinary = fetchBinary;
    this.setProactiveSuppressed = setProactiveSuppressed;
    this.now = now;
    this.random = random;
    this.log = log;
    this.stateFile = stateFile;
    this.state = readJson(this.stateFile, { version: 1, records: [] });
    if (!Array.isArray(this.state.records)) this.state.records = [];
    if (!Array.isArray(this.state.scheduleSlots)) this.state.scheduleSlots = [];
    this.timer = null;
    this.running = null;
    this.controller = null;
    this.nextRunAt = 0;
    this.stopped = true;
    let recovered = false;
    for (const record of this.state.records) {
      if (!['running', 'publishing'].includes(record.status)) continue;
      const publishing = record.status === 'publishing';
      record.status = publishing ? 'publish-unknown' : 'interrupted';
      record.error = publishing
        ? '发布时服务中断，结果待核对，不会自动重发'
        : '生成期间服务中断，可以重新生成';
      record.endedAt = this.now();
      recovered = true;
    }
    for (const slot of this.state.scheduleSlots) {
      if (slot.status !== 'running') continue;
      const record = this.state.records.find((item) => item.scheduleSlotId === slot.id);
      slot.status = record?.status || 'interrupted';
      slot.reason = record?.error || '执行期间服务中断，未自动重试';
      recovered = true;
    }
    if (recovered) writeJson(this.stateFile, this.state);
  }

  start({ startup = true } = {}) {
    this.stop();
    const cfg = normalizedConfig();
    if (!cfg.enabled) return;
    const target = shanghaiDayStart(this.now()) + (cfg.hour * 60 + cfg.minute) * 60000;
    this.fixedSkipDay = !cfg.startupCatchup && this.now() >= target ? todayKey(this.now()) : '';
    this.#updatePlan(cfg, startup);
    this.stopped = false;
    this.#schedule(15000, startup);
  }

  reconfigure() {
    if (normalizedConfig().enabled) this.start({ startup: false });
    else this.stop();
  }

  stop() {
    this.stopped = true;
    this.scheduleVersion = (this.scheduleVersion || 0) + 1;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = 0;
  }

  abort() {
    this.controller?.abort(new Error('Daily moments stopped'));
  }

  status() {
    const cfg = normalizedConfig();
    const slots = this.state.scheduleSlots;
    const nextSlot = slots.find((slot) => slot.status === 'pending');
    return {
      enabled: cfg.enabled,
      running: Boolean(this.running),
      task: this.task || null,
      intervalDays: cfg.intervalDays,
      nextRunAt: !cfg.enabled ? 0 : cfg.scheduleWindows
        ? (nextSlot ? Math.max(nextSlot.at, this.nextRunAt || 0) : 0)
        : (this.nextRunAt || nextDailyMomentAt(this.now(), cfg)),
      scheduleMode: cfg.scheduleWindows ? 'windows' : 'fixed',
      scheduleSlots: cfg.scheduleWindows
        ? slots.filter((slot) => slot.endAt >= shanghaiDayStart(this.now())).map((slot) => ({ ...slot }))
        : [],
      lastScheduleCheck: this.state.lastScheduleCheck || null,
      latest: this.state.records[0] || null,
      records: this.state.records.slice(0, 14)
    };
  }

  async runNow({
    dayKey = todayKey(this.now()),
    publish = false,
    force = false,
    confirmDuplicateRisk = false
  } = {}) {
    return this.run({
      dayKey,
      publish,
      force,
      confirmDuplicateRisk,
      source: publish ? 'manual-publish' : 'manual-preview'
    });
  }

  async run(options = {}) {
    return this.#exclusive('generate', () => this.#run(options));
  }

  async #exclusive(task, execute) {
    if (this.running) throw momentError('MOMENT_BUSY', '已有动态任务正在执行，请等待完成');
    assertTimeAllowed('');
    this.setProactiveSuppressed(true);
    this.task = task;
    this.running = Promise.resolve().then(execute).finally(() => {
      this.running = null;
      this.controller = null;
      this.task = null;
      this.setProactiveSuppressed(false);
      this.emit('daily-moments-status', this.status());
    });
    this.emit('daily-moments-status', this.status());
    return this.running;
  }

  #schedule(delay, startup = false, targetAt = 0) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const wait = Math.max(1000, Number(delay) || 1000);
    const version = this.scheduleVersion;
    this.nextRunAt = Number(targetAt) || (this.now() + wait);
    this.timer = setTimeout(() => {
      this.#tick(startup, version).catch((error) => {
        this.log('[daily-moments] scheduler error:', error?.message ?? error);
        if (!this.stopped && version === this.scheduleVersion) this.#schedule(60000);
      });
    }, wait);
    this.timer.unref?.();
  }

  async #tick(startup, version) {
    if (this.stopped || version !== this.scheduleVersion) return;
    const cfg = normalizedConfig();
    if (!cfg.enabled) return;
    if (cfg.scheduleWindows) return this.#tickWindows(cfg, startup, version);
    const timeState = timeControlState(getConfig().timeControl, '', this.now());
    if (!timeState.active) {
      this.deferredDay ||= scheduledDayAt(this.now(), cfg, startup);
      this.#schedule(timeState.nextActiveAt ? timeState.nextActiveAt - this.now() + 1 : 60000);
      return;
    }
    if (cfg.enabled) {
      const dayKey = this.deferredDay || scheduledDayAt(this.now(), cfg, startup);
      this.deferredDay = '';
      const blocked = dayKey && this.#blockingRecord({ dayKey, source: 'scheduled' });
      if (dayKey && (blocked || dayKey === this.fixedSkipDay)) {
        this.#scheduleCheck({
          dayKey, status: blocked ? 'blocked' : 'missed',
          reason: blocked ? `定时任务已处理或发布结果待核对：${blocked.status}` : '启动时已错过固定时刻，未开启补跑',
          recordId: blocked?.id || ''
        });
      } else if (dayKey && !momentIntervalDue(this.now(), cfg, this.state.records)) {
        this.#scheduleCheck({
          dayKey, status: 'waiting',
          reason: `未到发送间隔（每 ${cfg.intervalDays} 天）`
        });
      } else if (dayKey) {
        try {
          await this.run({ dayKey, publish: true, source: startup ? 'startup-catchup' : 'scheduled' });
        } catch (error) {
          if (error?.code === 'TIME_CONTROL_INACTIVE') this.deferredDay = dayKey;
          else this.log('[daily-moments] run failed:', error?.message ?? error);
        }
      }
    }
    if (!this.stopped && version === this.scheduleVersion) {
      const next = this.deferredDay
        ? timeControlState(getConfig().timeControl, '', this.now()).nextActiveAt || this.now() + 60000
        : nextDailyMomentAt(this.now(), cfg);
      this.#schedule(
        Math.min(next - this.now() + 1000, 60 * 60 * 1000),
        false,
        next
      );
    }
  }

  #blockingRecord(target, publishingOnly = false) {
    return this.state.records.find((record) =>
      record.id !== target.id
      && samePublicationScope(record, target)
      && (publishingOnly ? PUBLICATION_STATUSES : BLOCKING_STATUSES).has(record.status));
  }

  #scheduleCheck(check) {
    this.state.lastScheduleCheck = { ...check, at: this.now() };
    writeJson(this.stateFile, this.state);
    this.emit('daily-moments-status', this.status());
  }

  #updatePlan(cfg, startup = false) {
    if (updateMomentPlan(this.state.scheduleSlots, cfg.scheduleWindows, this.now(), this.random, {
      startup, catchup: cfg.startupCatchup
    })) writeJson(this.stateFile, this.state);
  }

  async #tickWindows(cfg, startup, version) {
    this.#updatePlan(cfg);
    const pending = this.state.scheduleSlots.filter((slot) => slot.status === 'pending');
    const slot = pending.find((item) => item.at <= this.now());
    if (slot) {
      const root = getConfig();
      const time = timeControlState(root.timeControl, '', this.now());
      const unresolved = this.state.records.find((record) =>
        ['publishing', 'publish-unknown'].includes(record.status));
      const lastAttempt = this.state.records.reduce((latest, record) =>
        Math.max(latest, Number(record.publishStartedAt) || Number(record.publishedAt) || 0), 0);
      const reason = this.running ? '其他动态任务正在执行'
        : root.runtime?.mode !== 'active' || root.runtime?.paused ? '机器人处于观察或暂停状态'
        : !time.active ? '等待活跃时间'
        : unresolved ? '存在发布结果待核对的动态'
        : this.now() - lastAttempt < MOMENT_MIN_GAP_MS ? '等待发布间隔（5 分钟）'
        : '';
      if (reason) {
        if (slot.reason !== reason) {
          slot.reason = reason;
          this.#scheduleCheck({ dayKey: slot.dayKey, slotId: slot.id, status: 'waiting', reason });
        }
      } else {
        slot.status = 'running';
        slot.reason = '';
        writeJson(this.stateFile, this.state);
        try {
          const result = await this.run({
            dayKey: todayKey(this.now()), publish: true,
            source: startup ? 'startup-catchup' : 'scheduled', scheduleSlot: { ...slot }
          });
          slot.status = result.record.status;
          slot.recordId = result.record.id;
          slot.reason = result.record.error || result.record.reason || '';
        } catch (error) {
          const record = this.state.records.find((item) => item.scheduleSlotId === slot.id);
          slot.status = record?.status || (['MOMENT_BUSY', 'TIME_CONTROL_INACTIVE'].includes(error.code) ? 'pending' : 'failed');
          slot.recordId = record?.id || '';
          slot.reason = cleanText(error?.message ?? error, 1000);
        }
        this.#scheduleCheck({ dayKey: slot.dayKey, slotId: slot.id, status: slot.status, reason: slot.reason, recordId: slot.recordId });
      }
    }
    if (!this.stopped && version === this.scheduleVersion) {
      const next = this.state.scheduleSlots.find((item) => item.status === 'pending');
      const nextAt = next ? (next.at <= this.now() ? Math.min(next.endAt, this.now() + 30000) : next.at) : this.now() + 3600000;
      this.#schedule(Math.min(3600000, nextAt - this.now()), false, nextAt);
    }
  }

  #saveRecord(record) {
    const index = this.state.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.state.records[index] = record;
    else this.state.records.unshift(record);
    this.state.records = this.state.records.slice(0, 90);
    writeJson(this.stateFile, this.state);
    this.emit('daily-moments-status', this.status());
  }

  async #run({
    dayKey = todayKey(this.now()),
    publish = true,
    force = false,
    confirmDuplicateRisk = false,
    source = 'scheduled',
    scheduleSlot = null
  } = {}) {
    const cfg = normalizedConfig();
    dayStartFromKey(dayKey);
    const automatic = automaticSource(source);
    const previous = (publish || automatic) && this.#blockingRecord({
      dayKey, source, scheduleSlotId: scheduleSlot?.id || ''
    }, !automatic);
    if (previous && publish && force && !confirmDuplicateRisk) {
      throw momentError(
        'MOMENT_DUPLICATE_CONFIRMATION_REQUIRED',
        '该日期可能已经发布；重新运行需明确确认重复发布风险'
      );
    }
    const allowManualDuplicate = !automatic && publish && force && confirmDuplicateRisk;
    if (previous && !allowManualDuplicate) {
      return { ok: true, alreadyAttempted: true, record: previous };
    }
    if (publish && getConfig().runtime?.mode !== 'active') {
      throw new Error('当前不是 active 模式，禁止自动发布说说');
    }

    const record = {
      id: crypto.randomUUID(),
      dayKey,
      source,
      scheduleSlotId: scheduleSlot?.id || '',
      scheduleAt: scheduleSlot?.at || 0,
      scheduleEndAt: scheduleSlot?.endAt || 0,
      promptVersion: MOMENT_PROMPT_VERSION,
      personaHash: momentPersonaHash(getConfig().persona, this.onebot?.selfNickname || ''),
      accountId: String(this.onebot.selfId || ''),
      publishAttempted: false,
      status: 'running',
      startedAt: this.now(),
      endedAt: 0,
      groupCount: 0,
      groupSummaries: [],
      decision: '',
      reason: '',
      content: '',
      imageIds: [],
      imageCount: 0,
      imageErrors: [],
      researchCalls: 0,
      tid: '',
      usage: emptyUsage(),
      model: '',
      error: ''
    };
    this.#saveRecord(record);
    this.controller = new AbortController();
    const releaseTimeGuard = watchTimeWindow((error) => this.controller?.abort(error), '');
    let releaseGroupGuards = () => {};
    const timeout = setTimeout(() => this.controller?.abort(new Error('Daily moments run timed out')), 10 * 60 * 1000);
    timeout.unref?.();
    const windowTimeout = scheduleSlot ? setTimeout(() => this.controller?.abort(
      momentError('MOMENT_WINDOW_EXPIRED', '已超过允许发布时间范围，本次未发布')
    ), Math.max(1, scheduleSlot.endAt - this.now())) : null;
    windowTimeout?.unref?.();
    let session = null;

    try {
      const snapshot = await this.#collectSnapshot(dayKey, cfg);
      const timeScopes = ['', ...snapshot.groups.map((group) => group.chatKey)];
      releaseGroupGuards = watchTimeWindow((error) => this.controller?.abort(error), timeScopes);
      this.controller.signal.throwIfAborted();
      record.groupCount = snapshot.groups.length;
      if (!snapshot.groups.length) {
        Object.assign(record, {
          status: 'skipped',
          decision: 'skip',
          reason: '当天没有达到条件的群聊记录',
          endedAt: this.now()
        });
        this.#saveRecord(record);
        return { ok: true, record };
      }

      session = this.sessions?.create({
        chatKey: 'system:daily-moments',
        trigger: 'daily-moments',
        triggerSummary: `${dayKey} 每日群聊总结`
      }) || null;
      if (session) {
        record.sessionId = session.id;
        session.chatName = '每日动态';
        session.model = getConfig().api?.model || '';
        session.conversationMode = 'legacy';
      }

      const modelResult = await withTimeScope(timeScopes, () =>
        this.#decide(snapshot, cfg, session, this.controller.signal)
      );
      record.groupSummaries = modelResult.decision.groupSummaries;
      record.decision = modelResult.decision.decision;
      record.reason = modelResult.decision.reason;
      record.content = modelResult.decision.content;
      record.imageIds = modelResult.decision.imageIds;
      record.researchCalls = modelResult.researchCalls;
      record.researchSources = modelResult.researchSources;
      record.usage = modelResult.usage;
      record.model = modelResult.model;
      record.personaHash = modelResult.personaHash;
      record.imageRefs = record.imageIds.map((id) => {
        const candidate = snapshot.imageMap.get(id);
        const { prepared, fallbackUrl, ...ref } = candidate;
        return ref;
      });
      record.imageCount = record.imageIds.length;

      if (!publish) {
        record.status = 'preview';
        record.endedAt = this.now();
        this.#saveRecord(record);
        this.#finishSession(session, record);
        return { ok: true, preview: true, record };
      }
      if (record.decision !== 'publish' || !record.content) {
        record.status = 'skipped';
        record.endedAt = this.now();
        this.#saveRecord(record);
        this.#finishSession(session, record);
        return { ok: true, record };
      }

      const result = await this.#publishRecord(record, snapshot, this.controller.signal, {
        force,
        confirmDuplicateRisk
      });
      this.#finishSession(session, record);
      return result;
    } catch (error) {
      if (record.status !== 'publish-unknown') {
        record.status = error?.code === 'MOMENT_WINDOW_EXPIRED' ? 'missed'
          : error?.code === 'TIME_CONTROL_INACTIVE' ? 'deferred' : 'failed';
        if (session) {
          record.usage = { ...session.usage };
          record.model = session.model || record.model;
        }
        record.error = cleanText(error?.message ?? error, 1000);
        record.endedAt = this.now();
        this.#saveRecord(record);
      }
      this.#finishSession(session, record, error);
      throw error;
    } finally {
      releaseTimeGuard();
      releaseGroupGuards();
      clearTimeout(timeout);
      clearTimeout(windowTimeout);
    }
  }

  #assertPublishAllowed(record, signal) {
    signal?.throwIfAborted();
    assertTimeAllowed(['', ...(record.groupSummaries || []).map((group) => group.chatKey)]);
    const cfg = getConfig();
    if (automaticRecord(record) && record.scheduleSlotId) {
      const slot = this.state.scheduleSlots.find((item) => item.id === record.scheduleSlotId);
      const window = cfg.dailyMoments?.scheduleWindows?.find((item) =>
        `${item.start}-${item.end}` === slot?.windowKey);
      if (!window || slot.index >= window.count) {
        throw momentError('MOMENT_SCHEDULE_CHANGED', '本次计划已取消或修改，未发布');
      }
      if (this.now() >= record.scheduleEndAt) {
        throw momentError('MOMENT_WINDOW_EXPIRED', '已超过允许发布时间范围，本次未发布');
      }
    }
    if (cfg.runtime?.mode !== 'active' || cfg.runtime?.paused) {
      throw momentError('MOMENT_INACTIVE', '机器人处于观察或暂停状态，禁止发布');
    }
    if (['scheduled', 'startup-catchup'].includes(record.source) && cfg.dailyMoments?.enabled !== true) {
      throw momentError('MOMENT_DISABLED', '每日动态已关闭，取消本次自动发布');
    }
    if (record.accountId && record.accountId !== String(this.onebot.selfId || '')) {
      throw momentError('MOMENT_ACCOUNT_CHANGED', 'QQ 登录账号已改变，请重新生成草稿');
    }
    if (record.promptVersion !== MOMENT_PROMPT_VERSION
      || record.personaHash !== momentPersonaHash(cfg.persona, this.onebot?.selfNickname || '')) {
      throw momentError('MOMENT_PERSONA_CHANGED', '草稿的人设或提示词已过期，请按当前设置重新生成');
    }
    if ((record.groupSummaries || []).some((group) => !chatAllowed(group.chatKey, cfg))) {
      throw momentError('MOMENT_SOURCE_CHANGED', '素材会话已移出白名单，请重新生成');
    }
  }

  async #publishRecord(record, snapshot, signal, {
    force = false,
    confirmDuplicateRisk = false
  } = {}) {
    this.#assertPublishAllowed(record, signal);
    const blocked = this.#blockingRecord(record, true);
    if (blocked && force && !confirmDuplicateRisk) {
      throw momentError(
        'MOMENT_DUPLICATE_CONFIRMATION_REQUIRED',
        '该日期可能已经发布；发布草稿需明确确认重复发布风险'
      );
    }
    if (blocked && !(force && confirmDuplicateRisk)) {
      return { ok: true, alreadyAttempted: true, record: blocked };
    }
    const cfg = normalizedConfig();
    const imageSources = [];
    record.imageErrors = [];
    for (const imageId of cfg.allowImages ? record.imageIds.slice(0, cfg.maxImages) : []) {
      try {
        const prepared = await this.#loadImageCandidate(snapshot, imageId, signal);
        if (prepared?.uploadSource) imageSources.push(prepared.uploadSource);
        else record.imageErrors.push(`${imageId}: 图片来源已失效，本次不配此图`);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        record.imageErrors.push(`${imageId}: ${cleanText(error?.message ?? error, 240)}`);
      }
    }
    const duplicate = await this.#findDuplicate(record.content, signal);
    if (duplicate) {
      Object.assign(record, {
        status: 'published', tid: String(duplicate.tid),
        deduplicated: true, endedAt: this.now(), error: ''
      });
      this.#saveRecord(record);
      return { ok: true, deduplicated: true, record };
    }

    this.#assertPublishAllowed(record, signal);
    const latestCfg = normalizedConfig();
    const images = latestCfg.allowImages ? imageSources.slice(0, latestCfg.maxImages) : [];
    Object.assign(record, {
      status: 'publishing', publishAttempted: true, publishStartedAt: this.now(),
      imageCount: images.length, visibility: latestCfg.visibility, error: ''
    });
    this.#saveRecord(record);
    try {
      const result = await this.#publishMoment(record.content, images, latestCfg, signal);
      if (typeof result?.tid !== 'string' || !result.tid.trim()) {
        throw momentError('MOMENT_PUBLISH_UNKNOWN', 'Qzone 未返回说说 ID，发布结果待核对', 502);
      }
      Object.assign(record, {
        status: 'published', tid: result.tid, endedAt: this.now(), publishedAt: this.now()
      });
      this.#saveRecord(record);
      return { ok: true, record };
    } catch (error) {
      record.status = 'publish-unknown';
      record.error = cleanText(error?.message ?? error, 1000);
      record.endedAt = this.now();
      this.#saveRecord(record);
      throw error;
    }
  }

  async publishDraft(id, {
    force = false,
    confirmDuplicateRisk = false
  } = {}) {
    return this.#exclusive('publish-draft', async () => {
      const record = this.state.records.find((item) => item.id === id);
      if (!record) throw momentError('MOMENT_NOT_FOUND', '草稿不存在', 404);
      if (PUBLICATION_STATUSES.has(record.status)) {
        return { ok: true, alreadyAttempted: true, record };
      }
      if (record.status !== 'preview' || record.decision !== 'publish' || !record.content?.trim()) {
        throw momentError('MOMENT_NOT_DRAFT', '这不是可发布的草稿，请重新生成');
      }
      record.publicationSource = 'manual';
      this.controller = new AbortController();
      const scopes = ['', ...record.groupSummaries.map((group) => group.chatKey)];
      const release = watchTimeWindow((error) => this.controller?.abort(error), scopes);
      try {
        const snapshot = { imageMap: new Map((record.imageRefs || []).map((ref) => [ref.id, { ...ref }])) };
        return await this.#publishRecord(record, snapshot, this.controller.signal, {
          force,
          confirmDuplicateRisk
        });
      } catch (error) {
        if (!record.publishAttempted) {
          record.error = cleanText(error?.message ?? error, 1000);
          this.#saveRecord(record);
        }
        throw error;
      } finally {
        release();
      }
    });
  }

  async reconcile(id) {
    return this.#exclusive('reconcile', async () => {
      const record = this.state.records.find((item) => item.id === id);
      if (!record) throw momentError('MOMENT_NOT_FOUND', '记录不存在', 404);
      if (record.status === 'published') return { ok: true, matched: true, record };
      if (record.status !== 'publish-unknown' || !record.content) {
        throw momentError('MOMENT_NOT_UNCERTAIN', '该记录无需核对发布结果');
      }
      if (record.accountId && record.accountId !== String(this.onebot.selfId || '')) {
        throw momentError('MOMENT_ACCOUNT_CHANGED', '请使用发布时的 QQ 账号核对');
      }
      const found = await this.#findDuplicate(record.content);
      if (found) {
        Object.assign(record, { status: 'published', tid: String(found.tid), error: '', reconciledAt: this.now() });
        const slot = this.state.scheduleSlots.find((item) => item.id === record.scheduleSlotId);
        if (slot) {
          Object.assign(slot, { status: 'published', recordId: record.id, reason: '已在空间核对到发布结果' });
        }
        this.#saveRecord(record);
      }
      return { ok: true, matched: Boolean(found), record };
    });
  }

  /**
   * 人工终局：reconcile 只能靠"到空间里找到那条说说"来收敛，找不到时记录会一直停在
   * publish-unknown，#tickWindows 的 unresolved 检查会把**所有**时段的发布全部挡住，
   * 且记录没有保留期清理——等于功能无限期停摆。这里给管理员一个明确出口：
   *   missed → publish-missed（确认没发出去：解除阻断，同天允许重新发布）
   *   sent   → published（确认已发出：保持"这条已发布"的阻断语义，不会重发）
   * 只处理 publish-unknown / publishing 两种未决状态；必须由控制台带 confirm 调用。
   */
  async resolveRecord(id, { result = '' } = {}) {
    return this.#exclusive('resolve-record', async () => {
      const record = this.state.records.find((item) => item.id === id);
      if (!record) throw momentError('MOMENT_NOT_FOUND', '记录不存在', 404);
      if (!['publishing', 'publish-unknown'].includes(record.status)) {
        throw momentError('MOMENT_NOT_UNCERTAIN', '该记录无需人工核对', 409);
      }
      if (result === 'missed') {
        Object.assign(record, { status: 'publish-missed', error: '', resolvedAt: this.now() });
      } else if (result === 'sent') {
        Object.assign(record, { status: 'published', error: '', resolvedAt: this.now() });
      } else {
        throw momentError('MOMENT_RESOLVE_RESULT', 'result 必须是 missed（确认没发出去）或 sent（确认已发出）', 400);
      }
      const slot = this.state.scheduleSlots.find((item) => item.id === record.scheduleSlotId);
      if (slot) {
        Object.assign(slot, {
          status: record.status, recordId: record.id,
          reason: result === 'missed' ? '人工确认未发出，已解除待核对' : '人工确认已发出'
        });
      }
      this.#saveRecord(record);
      return { ok: true, record };
    });
  }

  #finishSession(session, record, error = null) {
    if (!session || !this.sessions?.current?.has(session.id)) return;
    session.usage = { ...record.usage };
    session.model = record.model || session.model;
    session.finishReason = record.reason || record.status;
    session.outcome = {
      sent: record.status === 'published' ? 1 : 0,
      finishReason: session.finishReason
    };
    if (record.status === 'published') {
      session.sent.push({
        type: 'qzone',
        text: record.content,
        at: formatClockTime(record.endedAt || this.now())
      });
    }
    if (error) session.error = cleanText(error?.message ?? error, 1000);
    this.sessions.update(session.id);
    this.sessions.finish(session.id, error ? 'error' : (record.status === 'published' ? 'done' : 'noreply'));
    this.emit('session-end', { sessionId: session.id, chatKey: session.chatKey });
  }

  async #collectSnapshot(dayKey, cfg) {
    const start = dayStartFromKey(dayKey);
    const end = start + DAY_MS;
    const rootConfig = getConfig();
    const allowed = new Set((rootConfig.allow?.groups || []).map(String));
    const chatKeys = this.store.listChats()
      .filter((chatKey) => {
        const [kind, id] = String(chatKey).split(':');
        if (kind !== 'group') return false;
        if (!isTimeActive(chatKey)) return false;
        return allowed.size ? allowed.has(id) : rootConfig.allowAllWhenEmpty === true;
      });
    const collected = [];

    for (const chatKey of chatKeys) {
      const [, groupId] = chatKey.split(':');
      const scanLimit = Math.min(2000, Math.max(cfg.maxMessagesPerGroup * 4, 200));
      const dayMessages = this.store.recent(chatKey, { limit: scanLimit, readOnly: true })
        .filter((message) => Number(message.ts) >= start && Number(message.ts) < end);
      const humanCount = dayMessages.filter((message) => !message.self).length;
      const members = this.memory.members(chatKey);
      const handoff = this.memory.getHandoff(chatKey);
      if (humanCount < cfg.minMessagesPerGroup && !members.length && !handoff) continue;
      const groupName = cleanText(await this.resolveChatName(groupId), 100) || groupId;
      collected.push({
        chatKey,
        groupName,
        humanCount,
        lastTs: dayMessages.at(-1)?.ts || 0,
        messages: dayMessages.slice(-cfg.maxMessagesPerGroup),
        members,
        handoff
      });
    }

    collected.sort((a, b) => b.humanCount - a.humanCount || b.lastTs - a.lastTs);
    const picked = collected.slice(0, cfg.maxGroups);
    const imageMap = new Map();
    let imageSeq = 0;
    const groups = picked.map((group) => {
      const messages = group.messages.map((message) => {
        const media = [];
        let imageIndex = 0;
        for (let index = 0; index < (message.media || []).length; index++) {
          const item = message.media[index];
          if (!cfg.allowImages || item?.kind !== 'image' || !item.url || imageMap.size >= 24) continue;
          const id = `image-${++imageSeq}`;
          imageMap.set(id, {
            id,
            type: 'message',
            chatKey: group.chatKey,
            mid: message.mid,
            mediaIndex: imageIndex++,
            fallbackUrl: String(item.url),
            label: `${group.groupName} / ${message.self ? '我' : message.senderName || '群友'} / ${cleanText(message.text, 100)}`
          });
          media.push(id);
        }
        return {
          at: formatShortTime(message.ts),
          self: message.self === true,
          sender: message.self ? (rootConfig.persona?.botName || '我') : cleanText(message.senderName || '群友', 60),
          text: cleanText(message.text, 260),
          images: media
        };
      });
      return {
        chatKey: group.chatKey,
        groupName: group.groupName,
        messageCount: group.humanCount,
        messages,
        memories: group.members.slice(0, 20).map((member) => ({
          name: cleanText(member.name || '群友', 60),
          impressions: member.impressions.slice(-3).map((item) => cleanText(item.content, 220))
        })),
        handoff: group.handoff ? {
          topic: group.handoff.topic,
          summary: group.handoff.summary,
          facts: group.handoff.facts,
          nextStep: group.handoff.nextStep
        } : null
      };
    });

    if (cfg.allowImages && imageMap.size < 24) {
      try {
        const entries = (await this.stickers.sync(false)).entries || [];
        for (const sticker of entries.slice(0, 10)) {
          if (!sticker?.id || !sticker?.url || imageMap.size >= 24) continue;
          const id = `image-${++imageSeq}`;
          imageMap.set(id, {
            id,
            type: 'sticker',
            stickerId: sticker.id,
            fallbackUrl: sticker.url,
            label: `收藏图：${cleanText(sticker.localNote || sticker.desc || '未备注', 160)}`
          });
        }
      } catch { /* 配图是可选项 */ }
    }

    while (JSON.stringify(groups).length > cfg.maxPromptChars) {
      const target = [...groups]
        .filter((group) => group.messages.length > 5)
        .sort((a, b) => b.messages.length - a.messages.length)[0];
      if (!target) break;
      target.messages.shift();
    }

    return {
      dayKey,
      start,
      end,
      selfNames: [rootConfig.persona?.botName, rootConfig.persona?.selfNickname, this.onebot.selfNickname]
        .filter(Boolean),
      groups,
      imageMap,
      imageCandidates: [...imageMap.values()].map((image) => ({
        id: image.id,
        description: image.label
      }))
    };
  }

  async #decide(snapshot, cfg, session, signal) {
    const rootConfig = getConfig();
    const style = STYLE_SEEDS[Math.floor(this.random() * STYLE_SEEDS.length)] || STYLE_SEEDS[0];
    const systemPrompt = buildMomentSystemPrompt(rootConfig.persona, { accountNickname: this.onebot?.selfNickname || '' });
    const personaHash = momentPersonaHash(rootConfig.persona, this.onebot?.selfNickname || '');
    const recentPosts = this.state.records.filter((record) => record.status === 'published')
      .slice(0, 5).map((record) => ({ day: record.dayKey, content: record.content }));
    const userPrompt = [
      `【上海时间】${formatFullTime(this.now())}`,
      `【总结日期】${snapshot.dayKey}`,
      `【可忽略的灵感】${style}。这不是规定的文风；与人设或素材不合适就不用。`,
      `【预算】最多研究 ${cfg.maxResearchCalls} 次；最多配图 ${cfg.maxImages} 张。`,
      '【最近已发动态】',
      JSON.stringify(recentPosts),
      '【群聊材料】',
      JSON.stringify(snapshot.groups),
      '【可选配图】',
      JSON.stringify(snapshot.imageCandidates)
    ].join('\n\n');
    const context = {
      snapshot,
      cfg,
      signal,
      researchCalls: 0,
      researchSources: [],
      inspectedImages: new Set(),
      visionEnabled: rootConfig.api?.vision !== false,
      searchEnabled: rootConfig.webSearch?.enabled !== false,
      finalDecision: null
    };
    const defs = this.#toolDefs(context);
    const tools = openAiTools(defs);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const usage = emptyUsage();
    let model = rootConfig.api?.model || '';
    let finalDecision = null;

    if (session) {
      session.systemPrompt = systemPrompt;
      session.userPrompt = userPrompt;
      session.promptChars = systemPrompt.length + userPrompt.length;
      session.promptLayout = MOMENT_PROMPT_VERSION;
      session.inputTools = structuredClone(tools);
      session.inputRequestOptions = { toolChoice: 'auto', temperature: 1 };
      this.sessions.update(session.id);
      this.emit('session-update', { sessionId: session.id });
    }

    for (let round = 0; round < cfg.maxRounds && !finalDecision; round++) {
      signal.throwIfAborted();
      assertTimeAllowed();
      // DeepSeek thinking mode rejects named/required tool choices, including
      // on the final retry. Validation below still requires an explicit submit.
      const toolChoice = 'auto';
      if (session) {
        session.inputRequestOptions.toolChoice = toolChoice;
        session.inputRound = round + 1;
        session.inputPayloadChars = JSON.stringify({ messages, tools }).length;
        session.inputMessages = auditMessages(messages);
        session.activity = '正在整理每日动态…';
        this.sessions.update(session.id);
        this.emit('session-update', { sessionId: session.id });
      }
      const response = await this.complete({
        messages,
        tools,
        toolChoice,
        temperature: 1,
        signal,
        cacheKey: `qq-agent:daily-moments:${personaHash.slice(0, 24)}`
      });
      model = response.model || model;
      addUsage(usage, response.usage);
      usage.calls += 1;
      if (session) {
        session.usage = { ...usage };
        session.model = model;
        session.rounds = round + 1;
        session.callUsage ||= [];
        const promptTokens = Number(response.usage?.prompt_tokens) || 0;
        const cachedTokens = Math.min(promptTokens, cachedTokensOfUsage(response.usage));
        session.callUsage.push({
          round: round + 1,
          promptTokens,
          cachedTokens,
          cacheHitRate: promptTokens ? cachedTokens / promptTokens : 0,
          completionTokens: Number(response.usage?.completion_tokens) || 0,
          totalTokens: Number(response.usage?.total_tokens) || 0
        });
      }
      const message = response.message || {};
      const assistant = {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : (message.content ?? null),
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(resolveToolCalls(message).length ? { tool_calls: resolveToolCalls(message) } : {})
      };
      messages.push(assistant);
      if (session) {
        session.messages.push({ ...structuredClone(assistant), raw: response.raw ?? null });
        session.activity = '';
        this.sessions.update(session.id);
        this.emit('session-update', { sessionId: session.id });
      }
      const calls = resolveToolCalls(message);
      if (!calls.length) {
        messages.push({
          role: 'user',
          content: '请继续，最终必须调用 submit_daily_moment 明确 publish 或 skip。'
        });
        continue;
      }

      const toolMessages = [];
      const imageMessages = [];
      for (const call of calls) {
        signal.throwIfAborted();
        assertTimeAllowed();
        const name = String(call?.function?.name || '');
        let args = null;
        let parseError = '';
        try {
          const raw = call?.function?.arguments;
          args = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object');
        } catch {
          parseError = '工具参数不是合法 JSON 对象。请按工具 schema 重新提交，字符串内双引号必须转义；不要把正文或摘要包成未转义的引号。';
        }
        const def = defs.find((item) => item.name === name);
        let result;
        try {
          if (parseError) result = { content: `错误：${parseError}`, isError: true };
          else if (context.finalDecision) result = { content: '已有有效决定，忽略后续操作', isError: true };
          else result = def
              ? await def.execute(args)
              : { content: `错误：未知工具 ${name}，本任务不能使用群聊工具`, isError: true };
        } catch (error) {
          result = { content: `错误：${error?.message ?? error}`, isError: true };
        }
        let content = '';
        let images = [];
        if (Array.isArray(result.content)) {
          content = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          images = result.content.filter((part) => part.type === 'image_url');
        } else {
          content = String(result.content ?? '');
        }
        toolMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content
        });
        if (images.length) {
          imageMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：这是候选图片 ${args?.imageId || ''}，仅供判断是否适合作为说说配图]` },
              ...images
            ]
          });
        }
        if (session) {
          session.messages.push({
            toolCall: {
              name,
              args,
              result: content.slice(0, 2000),
              isError: Boolean(result.isError)
            }
          });
        }
      }
      messages.push(...toolMessages, ...imageMessages);
      finalDecision = context.finalDecision;
    }

    if (!finalDecision) throw momentError(
      'MOMENT_DECISION_INVALID', '模型未在轮次预算内提交有效决定，本次生成失败；没有发布，可重新生成', 422
    );
    return {
      decision: finalDecision,
      researchCalls: context.researchCalls,
      researchSources: context.researchSources,
      usage,
      model,
      personaHash
    };
  }

  #toolDefs(context) {
    return [
      {
        name: 'web_search',
        description: '搜索实时信息、概念或聊天中值得深入研究的问题。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        },
        execute: async (args) => {
          if (context.researchCalls >= context.cfg.maxResearchCalls) {
            return { content: '错误：今日研究调用次数已达上限', isError: true };
          }
          context.researchCalls += 1;
          const result = await this.search(cleanText(args.query, 300));
          return {
            content: JSON.stringify({
              query: result.query,
              results: (result.results || []).slice(0, 6).map((item) => ({
                title: cleanText(item.title, 200),
                url: item.url,
                snippet: cleanText(item.snippet, 500)
              }))
            })
          };
        }
      },
      {
        name: 'web_fetch',
        description: '读取搜索结果正文，核实细节后再形成观点。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        },
        execute: async (args) => {
          if (context.researchCalls >= context.cfg.maxResearchCalls) {
            return { content: '错误：今日研究调用次数已达上限', isError: true };
          }
          context.researchCalls += 1;
          const result = await this.fetchPage(String(args.url || ''));
          if (result.statusCode === 200 && result.url && String(result.body || '').trim()) {
            context.researchSources.push(String(result.url));
            context.researchSources = [...new Set(context.researchSources)].slice(0, 10);
          }
          return {
            content: JSON.stringify({
              url: result.url,
              statusCode: result.statusCode,
              content: String(result.body || '').slice(0, 12000)
            })
          };
        }
      },
      {
        name: 'inspect_image_candidate',
        description: '查看一张候选图片；决定配图前先调用，不合适就不要选。',
        parameters: {
          type: 'object',
          properties: {
            imageId: { type: 'string', description: '可选配图列表中的 image-N' }
          },
          required: ['imageId']
        },
        execute: async (args) => {
          if (!context.cfg.allowImages || !context.visionEnabled) {
            return { content: '错误：配图已关闭', isError: true };
          }
          const imageId = String(args.imageId || '');
          const prepared = await this.#loadImageCandidate(
            context.snapshot,
            imageId,
            context.signal
          );
          if (!prepared) return { content: `错误：找不到候选图片 ${imageId}`, isError: true };
          context.inspectedImages.add(imageId);
          return {
            content: [
              { type: 'text', text: `候选图片 ${imageId}（若为 2×2 四宫格：那是动图 GIF 按时间顺序抽的 4 帧，阅读顺序左上→右上→左下→右下，黑格是填充不是画面内容）` },
              { type: 'image_url', image_url: { url: prepared.dataUrl } }
            ]
          };
        }
      },
      {
        name: 'submit_daily_moment',
        description: '提交每日群聊总结，并最终决定发布说说或跳过。只能在完成必要研究和看图后调用。',
        parameters: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['publish', 'skip'] },
            reason: { type: 'string', minLength: 1, description: '一句非空的决定理由，不输出推理过程' },
            content: { type: 'string', description: 'publish 时填写最终公开正文；skip 时为字符串 ""' },
            imageIds: {
              type: 'array',
              items: { type: 'string' },
              maxItems: context.cfg.maxImages,
              description: '仅填写已成功查看的候选图 ID；不配图填 []'
            },
            groupSummaries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  chatKey: { type: 'string' },
                  summary: { type: 'string', minLength: 1, description: '一至两句内部摘要，避免逐字引用带引号的长对话' }
                },
                required: ['chatKey', 'summary']
              }
            }
          },
          required: ['decision', 'reason', 'content', 'imageIds', 'groupSummaries']
        },
        execute: async (args) => {
          const decision = sanitizeDecision(args, context.snapshot, context.cfg);
          if (decision.imageIds.some((imageId) => !context.inspectedImages.has(imageId))) {
            throw momentError('MOMENT_DECISION_INVALID', '所选图片尚未成功查看，请先看图，或使用空 imageIds', 422);
          }
          context.finalDecision = decision;
          return { content: JSON.stringify({ accepted: true, decision: context.finalDecision.decision }) };
        }
      }
    ].filter((def) => {
      if (def.name === 'web_search' || def.name === 'web_fetch') {
        return context.searchEnabled && context.cfg.maxResearchCalls > 0;
      }
      if (def.name === 'inspect_image_candidate') {
        return context.visionEnabled && context.cfg.allowImages && context.cfg.maxImages > 0;
      }
      return true;
    });
  }

  async #resolveImageSource(snapshot, imageId) {
    const candidate = snapshot.imageMap.get(String(imageId || ''));
    if (!candidate) return '';
    if (candidate.type === 'sticker') {
      const sticker = await this.stickers.findForSend(candidate.stickerId);
      return String(sticker?.url || candidate.fallbackUrl || '');
    }
    if (candidate.type === 'message' && candidate.mid != null) {
      try {
        const message = await this.onebot.getMsg(candidate.mid);
        const images = (Array.isArray(message?.message) ? message.message : [])
          .filter((segment) => segment?.type === 'image');
        const image = images[candidate.mediaIndex] || images[0];
        const fresh = String(image?.data?.url || image?.data?.file || '').trim();
        if (fresh) return fresh;
      } catch { /* 使用落库地址兜底 */ }
    }
    return String(candidate.fallbackUrl || '');
  }

  async #loadImageCandidate(snapshot, imageId, signal) {
    const candidate = snapshot.imageMap.get(String(imageId || ''));
    if (!candidate) return null;
    if (candidate.prepared) return candidate.prepared;
    const source = await this.#resolveImageSource(snapshot, imageId);
    if (!source) return null;
    const safeUrl = await this.validateImage(source);
    const { buffer, contentType } = await this.fetchBinary(
      safeUrl,
      8 * 1024 * 1024,
      signal
    );
    if (!buffer?.length) throw new Error(`候选图片 ${imageId} 内容为空`);
    const mime = imageMime(buffer, contentType);
    // GIF 与消息图片同一收口：主流视觉网关不收 image/gif，且动图情绪在动作里——
    // 抽帧条转 JPEG 给模型判读；空间上传（uploadSource）仍用原始 GIF 保留动画。
    let visionBuffer = buffer;
    let visionMime = mime;
    if (mime === 'image/gif') {
      try {
        const strip = await convertGifToStillStrip(buffer, signal);
        if (strip?.length) { visionBuffer = strip; visionMime = 'image/jpeg'; }
      } catch { /* 转换失败回退原始 GIF */ }
    }
    const encoded = buffer.toString('base64');
    candidate.prepared = {
      dataUrl: `data:${visionMime};base64,${visionBuffer.toString('base64')}`,
      uploadSource: `base64://${encoded}`
    };
    return candidate.prepared;
  }

  async #findDuplicate(content, signal) {
    // 查重只是二次保险：协议端读不到列表（接口结构不稳定/未实现）时跳过，
    // 不阻断发布；同一 dayKey 是否已发过由发布闸门 #blockingRecord 把关。
    let data = null;
    try {
      data = typeof this.onebot.getQzoneMoments === 'function'
        ? await this.onebot.getQzoneMoments({ num: 30, signal })
        : await this.onebot.call('get_qzone_msg_list', { pos: 0, num: 30 }, 30000, signal);
    } catch (error) {
      console.log('[daily-moments] 空间列表读取失败，跳过查重继续发布：', error?.message ?? error);
      return null;
    }
    if (!Array.isArray(data?.msglist)) {
      console.log('[daily-moments] 空间列表结构异常，视为无历史说说继续发布');
      return null;
    }
    const target = cleanText(content, 1000);
    return data.msglist.find((item) =>
      item?.tid && cleanText(item.content, 1000) === target) || null;
  }

  async #publishMoment(content, images, cfg, signal) {
    if (typeof this.onebot.sendQzoneMoment === 'function') {
      return this.onebot.sendQzoneMoment(content, {
        images,
        ugcRight: cfg.visibility,
        targetUins: cfg.targetUins,
        signal
      });
    }
    const params = {
      content,
      images,
      ugc_right: cfg.visibility
    };
    if ([16, 128].includes(cfg.visibility)) params.target_uins = cfg.targetUins;
    return this.onebot.call('send_qzone_msg', params, 90000, signal);
  }
}
