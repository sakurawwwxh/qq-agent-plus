// 生活层：定期觅食 B 站公开内容，存候选队列，供主动发言轮次挑选分享。
//
// 为什么不放插件：插件协议没有 llm/agent/wake 能力，拿不到人设与上下文，
// 也不能触发一轮 agent（见 docs/PLUGINS.md 的能力表）。所以觅食与候选队列在宿主，
// 分享复用现有 send_message，不新增发送通道。
import fs from 'node:fs';
import path from 'node:path';
import { chatAllowed } from '../core/access.js';
import { buildInterestProfile } from './life-feed-interest.js';
import { forageBilibili, scoreCandidate } from './life-feed-source-bilibili.js';
import { forageRss } from './life-feed-source-rss.js';

const STATE_FILE = 'life-feed.json';
const CANDIDATE_TTL_MS = 7 * 86400000;
const SEEN_TTL_MS = 30 * 86400000;
const OFFER_TTL_MS = 7 * 86400000;
const MAX_RECORDS = 200;
const BACKOFF_MINUTES = [2, 4, 8, 16, 30];
// 设置边界集中在这里（服务端权威）：UI 不再各自写死一份，状态接口把这份 bounds 下发。
export const LIFE_FEED_BOUNDS = Object.freeze({
  forageIntervalMinutes: { min: 5, max: 10080 },
  maxCandidates: { min: 10, max: 10000 },
  maxPerForage: { min: 1, max: 500 },
  maxOffersPerDay: { min: 1, max: 500 },
  maxPicksPerDay: { min: 1, max: 100 },
  rssPerForage: { min: 1, max: 50 },
  cooldownDays: { min: 1, max: 30 },
  minDurationSec: { min: 0, max: 86400 },
  maxDurationSec: { min: 1, max: 86400 },
  extraKeywords: { min: 1, max: 200 },
  excludeKeywords: { min: 1, max: 200 },
  groups: { min: 1, max: 500 }
});

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function cleanList(value, maxItems, maxChars) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list
    .map((item) => String(item || '').trim().slice(0, maxChars))
    .filter(Boolean))]
    .slice(0, maxItems);
}

// 分享目标的老配置里只有裸群号；现在群和私聊共用一份名单，统一收敛成 `group:<群号>` /
// `private:<QQ>`。认不出的条目原样保留——它会永远匹配不上，但不会拖累已配置的目标。
function shareTargetKey(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return '';
  if (/^(group|private):\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `group:${raw}`;
  return raw;
}

function dayKey(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(now));
}

export function normalizedLifeFeedConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const B = LIFE_FEED_BOUNDS;
  const minDurationSec = clampInt(cfg.minDurationSec, B.minDurationSec.min, B.minDurationSec.max, 60);
  // 下限优先：用户把 min 设得比 max 大时，抬高 max，而不是悄悄把 min 降回去。
  const maxDurationSec = Math.max(minDurationSec, clampInt(cfg.maxDurationSec, B.maxDurationSec.min, B.maxDurationSec.max, 3600));
  return {
    enabled: cfg.enabled === true,
    graduated: cfg.graduated === true,
    sources: (() => {
      // 缺键 = 老配置/首次运行，沿用默认；显式空数组 = 用户取消了所有来源，必须尊重。
      if (!Array.isArray(cfg.sources)) return ['bilibili', 'plugin'];
      return [...new Set(cleanList(cfg.sources, 4, 20)
        .filter((source) => ['bilibili', 'plugin', 'rss'].includes(source)))];
    })(),
    forageIntervalMinutes: clampInt(cfg.forageIntervalMinutes, B.forageIntervalMinutes.min, B.forageIntervalMinutes.max, 360),
    maxCandidates: clampInt(cfg.maxCandidates, B.maxCandidates.min, B.maxCandidates.max, 200),
    maxPerForage: clampInt(cfg.maxPerForage, B.maxPerForage.min, B.maxPerForage.max, 30),
    maxOffersPerDay: clampInt(cfg.maxOffersPerDay, B.maxOffersPerDay.min, B.maxOffersPerDay.max, 2),
    maxPicksPerDay: clampInt(cfg.maxPicksPerDay, B.maxPicksPerDay.min, B.maxPicksPerDay.max, 10),
    shareMode: cfg.shareMode === 'manual' ? 'manual' : 'auto',
    // 群 `group:<群号>` 与私聊 `private:<QQ>` 共用一份目标名单；裸数字按老配置的群号处理。
    shareGroups: [...new Set(cleanList(cfg.shareGroups, B.groups.max, 32).map(shareTargetKey).filter(Boolean))],
    rssUrls: cleanList(cfg.rssUrls, 10, 500).filter((url) => /^https?:\/\//i.test(url)),
    rssPerForage: clampInt(cfg.rssPerForage, B.rssPerForage.min, B.rssPerForage.max, 10),
    cooldownDays: clampInt(cfg.cooldownDays, B.cooldownDays.min, B.cooldownDays.max, 7),
    minDurationSec: Math.min(minDurationSec, maxDurationSec),
    maxDurationSec: Math.max(minDurationSec, maxDurationSec),
    extraKeywords: cleanList(cfg.extraKeywords, B.extraKeywords.max, 20),
    excludeKeywords: cleanList(cfg.excludeKeywords, B.excludeKeywords.max, 20),
    // 兴趣来源同样是"会话"：群 group:<群号> 或私聊 private:<QQ>，裸群号按群处理。
    groups: [...new Set(cleanList(cfg.groups, B.groups.max, 32).map(shareTargetKey).filter(Boolean))]
  };
}

/**
 * 提炼兴趣要读哪些会话：显式配置优先（群/私聊都认），没配就沿用聊天白名单（群 + 私聊），
 * 白名单留空且允许所有会话时，用最近有消息的会话。最多 20 个，避免一次读太多历史。
 * 私聊只参与词频排序（searchTerms 仍然只取人设与显式关键词），不会把私聊内容拿去搜 B 站。
 */
export function resolveInterestChatKeys({
  groups = [],
  allow = {},
  allowAllWhenEmpty = false,
  allChats = [],
  denied = null
} = {}) {
  // 手写配置里的非法条目（全角冒号、空串）不能算"配了显式来源"，否则会把后面
  // 白名单/所有会话的回退整段吃掉；deny 里的会话也不该再拿历史去提炼。
  const usable = (key) => /^(group|private):\d+$/.test(key) && !(denied && denied.has(key));
  const explicit = (Array.isArray(groups) ? groups : []).map(shareTargetKey).filter(usable);
  if (explicit.length) return [...new Set(explicit)].slice(0, 20);
  const fromAllow = [
    ...(Array.isArray(allow?.groups) ? allow.groups : []).map((id) => `group:${String(id).trim()}`),
    ...(Array.isArray(allow?.private) ? allow.private : []).map((id) => `private:${String(id).trim()}`)
  ].filter(usable);
  if (fromAllow.length) return [...new Set(fromAllow)].slice(0, 20);
  // 注意：allowAllWhenEmpty 是配置的**顶层**字段（不在 allow 里），调用方要显式传进来。
  if (allowAllWhenEmpty !== true) return [];
  // allChats 由调用方先按 deny/白名单口径过滤好（见 LifeFeedManager#chatKeys）。
  return [...new Set((Array.isArray(allChats) ? allChats : [])
    .map((key) => String(key || ''))
    .filter(usable))].slice(0, 20);
}

function emptyState() {
  return {
    version: 1,
    lastForageAt: 0,
    nextForageAt: 0,
    lastForageCount: 0,
    foraging: false,
    failStreak: 0,
    lastError: '',
    seen: [],
    candidates: [],
    offers: [],
    tagWeights: {},
    records: []
  };
}

function normalizeState(raw) {
  const state = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) };
  state.seen = Array.isArray(state.seen) ? state.seen.filter((item) => item && item.id) : [];
  state.candidates = Array.isArray(state.candidates) ? state.candidates.filter((item) => item && item.id) : [];
  state.offers = Array.isArray(state.offers) ? state.offers.filter((item) => item && item.id) : [];
  state.records = Array.isArray(state.records) ? state.records.slice(0, MAX_RECORDS) : [];
  state.tagWeights = state.tagWeights && typeof state.tagWeights === 'object' ? state.tagWeights : {};
  // 进程在觅食中途退出：标记为 interrupted，下一次照常开始，不把半个队列当真。
  if (state.foraging) {
    state.foraging = false;
    state.lastError = state.lastError || 'interrupted：上次觅食未完成';
  }
  return state;
}

function publicCandidate(item) {
  return {
    id: item.id,
    source: item.source || '',
    via: item.via || '',
    title: item.title,
    up: item.up,
    upMid: item.upMid,
    duration: item.duration,
    play: item.play,
    tags: item.tags || [],
    cover: item.cover || '',
    url: item.url,
    desc: item.desc,
    score: item.score,
    addedAt: item.addedAt,
    offeredAt: item.offeredAt || 0
  };
}

export class LifeFeedManager {
  constructor({
    dataDir,
    store,
    config = () => ({}),
    fetchImpl,
    now = () => Date.now(),
    random = Math.random,
    log = () => {},
    stateFile = ''
  } = {}) {
    this.dataDir = dataDir;
    this.store = store;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.log = log;
    this.stateFile = stateFile || path.join(dataDir, STATE_FILE);
    this.state = emptyState();
    this.loaded = false;
    this.started = false;
    this.timer = null;
  }

  #cfg() {
    return normalizedLifeFeedConfig(this.config()?.lifeFeed);
  }

  /** observe/暂停时停止自动觅食：外发搜索请求本身也是"自动行为"。 */
  #runtimeAllowsAutomation() {
    const runtime = this.config()?.runtime || {};
    return runtime.mode === 'active' && !runtime.paused;
  }

  #personaTemplateId() {
    return String(this.config()?.persona?.templateId || '').trim();
  }

  #chatKeys(cfg) {
    const cfgNow = this.config() || {};
    const allow = cfgNow.allow || {};
    const deny = cfgNow.deny || {};
    const denyOf = (kind, list) => (Array.isArray(list) ? list : [])
      .map((id) => `${kind}:${String(id).trim()}`)
      .filter((key) => /^(group|private):\d+$/.test(key));
    const denied = new Set([...denyOf('group', deny.groups), ...denyOf('private', deny.private)]);
    // 只用"有效 id"判断白名单是否为空：allow 里只有空串/脏值时应当落到后面的回退。
    const hasValidId = (list) => (Array.isArray(list) ? list : [])
      .some((id) => /^\d+$/.test(String(id).trim()));
    const hasAllowList = hasValidId(allow.groups) || hasValidId(allow.private);
    // 只有"既没显式来源、白名单也为空、又允许所有会话"时才需要扫会话表；
    // 否则每次觅食/取候选都白查一次 chats 表。
    let allChats = [];
    if (!cfg.groups.length && !hasAllowList && cfgNow.allowAllWhenEmpty === true) {
      try {
        // 回退到"所有会话"时仍尊重 deny 与运行口径，被屏蔽的会话不参与提炼。
        allChats = (this.store?.listChats?.() || [])
          .map((key) => String(key || ''))
          .filter((key) => chatAllowed(key, cfgNow));
      } catch { allChats = []; }
    }
    return resolveInterestChatKeys({
      groups: cfg.groups,
      allow,
      allowAllWhenEmpty: cfgNow.allowAllWhenEmpty === true,
      allChats,
      denied
    });
  }

  #intervalMs(cfg) {
    const base = cfg.forageIntervalMinutes * 60000;
    const jitter = 0.8 + this.random() * 0.4;
    return Math.round(base * jitter);
  }

  #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.state = normalizeState(raw);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        try { fs.renameSync(this.stateFile, `${this.stateFile}.broken-${this.now()}`); } catch { /* 忽略 */ }
        this.log(`[life-feed] 状态文件读不出来，已留档并重建：${error?.message || error}`);
      }
      this.state = emptyState();
    }
  }

  #save() {
    this.#load();
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (error) {
      this.log(`[life-feed] 状态写盘失败：${error?.message || error}`);
    }
  }

  #prune(now) {
    const state = this.state;
    state.seen = state.seen.filter((item) => now - Number(item.at || 0) < SEEN_TTL_MS).slice(-2000);
    state.candidates = state.candidates.filter((item) => now - Number(item.addedAt || 0) < CANDIDATE_TTL_MS);
    state.offers = state.offers.filter((item) => now - Number(item.at || 0) < OFFER_TTL_MS).slice(-500);
    state.records = state.records.slice(0, MAX_RECORDS);
  }

  #schedule(delayMs) {
    this.#clearTimer();
    const delay = Math.max(60_000, Math.min(Number(delayMs) || 60_000, 7 * 86400000));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#tick();
    }, delay);
    this.timer.unref?.();
    return delay;
  }

  #clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async #tick() {
    const cfg = this.#cfg();
    if (!cfg.enabled) {
      this.started = false;
      return;
    }
    if (!this.#runtimeAllowsAutomation()) {
      this.#schedule(60000);
      return;
    }
    await this.forageNow({ reason: 'schedule' });
    if (!this.started) return;
    const next = Number(this.state.nextForageAt) || (this.now() + this.#intervalMs(cfg));
    this.#schedule(next - this.now());
  }

  start() {
    const cfg = this.#cfg();
    if (!cfg.enabled) {
      this.started = false;
      this.#clearTimer();
      return { active: false, nextForageAt: 0 };
    }
    this.#load();
    this.#prune(this.now());
    if (!this.state.nextForageAt) {
      // 第一次开启：1 分钟后先跑一次，让用户很快看到队列；之后按 interval。
      this.state.nextForageAt = this.now() + 60_000;
      this.#save();
    }
    this.started = true;
    this.#schedule(this.state.nextForageAt - this.now());
    return { active: true, nextForageAt: this.state.nextForageAt };
  }

  stop() {
    this.started = false;
    this.#clearTimer();
  }

  reconfigure() {
    const wasStarted = this.started;
    this.stop();
    if (!this.#cfg().enabled) return wasStarted ? this.status() : { active: false };
    return this.start();
  }

  status() {
    const cfg = this.#cfg();
    if (!cfg.enabled) {
      return {
        enabled: false,
        graduated: cfg.graduated,
        started: false,
        shareMode: cfg.shareMode,
        shareGroups: cfg.shareGroups,
        candidates: [],
        candidateCount: 0,
        todayOffers: 0,
        todayAutoOffers: 0,
        todayManualOffers: 0,
        maxOffersPerDay: cfg.maxOffersPerDay,
        limits: LIFE_FEED_BOUNDS,
        lastForageAt: 0,
        nextForageAt: 0,
        lastForageCount: 0,
        failStreak: 0,
        lastError: ''
      };
    }
    this.#load();
    const now = this.now();
    this.#prune(now);
    const day = dayKey(now);
    const todayOffers = this.state.offers.filter((item) => item.day === day);
    const todayManualOffers = todayOffers.filter((item) => item.manual === true).length;
    const todayAutoOffers = todayOffers.length - todayManualOffers;
    const lastShare = this.state.records.find((item) => item.action === 'shared' || item.action === 'manual-share');
    const summarize = (days) => {
      const since = now - days * 86400000;
      const stats = { shared: 0, skipped: 0, moreLike: 0, bySource: {} };
      for (const record of this.state.records) {
        if (Number(record.at) < since) continue;
        if (record.action === 'shared') stats.shared += 1;
        else if (record.action === 'skip') stats.skipped += 1;
        else if (record.action === 'more-like-this') stats.moreLike += 1;
        else continue;
        const source = String(record.source || 'unknown');
        stats.bySource[source] = (stats.bySource[source] || 0) + 1;
      }
      return stats;
    };
    return {
      enabled: true,
      graduated: cfg.graduated,
      started: this.started,
      shareMode: cfg.shareMode,
      shareGroups: cfg.shareGroups,
      candidates: this.state.candidates
        .slice()
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, 30)
        .map(publicCandidate),
      candidateCount: this.state.candidates.length,
      todayOffers: todayOffers.length,
      todayAutoOffers,
      todayManualOffers,
      todayPicks: todayAutoOffers,
      todayShares: this.state.records.filter((item) => item.day === day && item.action === 'shared').length,
      // 手动分享的真实回执：manual-share = 已排队；shared = 已发送（带 messageId）
      lastShare: lastShare ? {
        id: lastShare.id,
        action: lastShare.action,
        messageId: lastShare.messageId || null,
        chatKey: lastShare.chatKey || '',
        at: lastShare.at
      } : null,
      maxOffersPerDay: cfg.maxOffersPerDay,
      maxPicksPerDay: cfg.maxPicksPerDay,
      // 控制台可解释"为什么最近总推/不推某类"：正向、负向权重都下发（不含内部候选正文）
      tagWeights: { ...(this.state.tagWeights || {}) },
      limits: LIFE_FEED_BOUNDS,
      lastForageAt: this.state.lastForageAt,
      nextForageAt: this.state.nextForageAt,
      lastForageCount: this.state.lastForageCount,
      shareStats: { '7d': summarize(7), '30d': summarize(30) },
      sourceStatus: { ...(this.state.sourceStatus || {}) },
      failStreak: this.state.failStreak,
      lastError: this.state.lastError
    };
  }

  async forageNow({ reason = 'manual' } = {}) {
    const cfg = this.#cfg();
    if (!cfg.enabled) return { ok: false, error: '生活层没有开启' };
    this.#load();
    if (this.state.foraging) return { ok: false, error: '上一次觅食还没结束' };

    this.state.foraging = true;
    this.#save();
    const now = this.now();
    try {
      const profile = this.#profileFor(cfg, now);
      const items = [];
      const errors = [];
      const sourceStatus = { ...(this.state.sourceStatus || {}) };
      if (cfg.sources.includes('plugin')) {
        const pluginAdded = this.#ingestPluginInbox(profile, cfg, now);
        sourceStatus.plugin = { enabled: true, lastCount: pluginAdded, lastError: '' };
      } else {
        sourceStatus.plugin = { enabled: false, lastCount: 0, lastError: '' };
      }
      if (cfg.sources.includes('bilibili')) {
        try {
          const bili = await forageBilibili({
            profile,
            limit: cfg.maxPerForage,
            minDurationSec: cfg.minDurationSec,
            maxDurationSec: cfg.maxDurationSec,
            excludeKeywords: cfg.excludeKeywords,
            fetchImpl: this.fetchImpl,
            log: this.log
          });
          items.push(...bili);
          sourceStatus.bilibili = { enabled: true, lastCount: bili.length, lastError: '' };
        } catch (error) {
          errors.push(error);
          sourceStatus.bilibili = { enabled: true, lastCount: 0, lastError: String(error?.message ?? error) };
        }
      } else {
        sourceStatus.bilibili = { enabled: false, lastCount: 0, lastError: '' };
      }
      if (cfg.sources.includes('rss') && cfg.rssUrls.length) {
        try {
          const rss = await forageRss({
            urls: cfg.rssUrls,
            limit: cfg.rssPerForage,
            fetchImpl: this.fetchImpl,
            log: this.log
          });
          items.push(...rss);
          sourceStatus.rss = { enabled: true, lastCount: rss.length, lastError: '' };
        } catch (error) {
          errors.push(error);
          sourceStatus.rss = { enabled: true, lastCount: 0, lastError: String(error?.message ?? error) };
        }
      } else {
        sourceStatus.rss = { enabled: cfg.sources.includes('rss'), lastCount: 0, lastError: '' };
      }
      this.state.sourceStatus = sourceStatus;
      if (!items.length && errors.length) throw errors[0];
      const added = (this.state.sourceStatus.plugin?.lastCount || 0) + this.#merge(items, cfg, profile, now);
      this.state.lastForageAt = now;
      this.state.lastForageCount = added;
      this.state.nextForageAt = now + this.#intervalMs(cfg);
      this.state.failStreak = 0;
      this.state.lastError = '';
      this.state.foraging = false;
      this.#prune(now);
      this.#save();
      this.log(`[life-feed] ${reason} 觅食完成：新增 ${added} 条，候选 ${this.state.candidates.length} 条`);
      return { ok: true, added, candidates: this.state.candidates.length, nextForageAt: this.state.nextForageAt };
    } catch (error) {
      this.state.foraging = false;
      this.state.failStreak = Math.min(BACKOFF_MINUTES.length, Number(this.state.failStreak || 0) + 1);
      this.state.lastError = String(error?.message || error).slice(0, 300);
      const minutes = BACKOFF_MINUTES[Math.min(this.state.failStreak - 1, BACKOFF_MINUTES.length - 1)];
      this.state.nextForageAt = now + minutes * 60000;
      this.#save();
      this.log(`[life-feed] 觅食失败（连续 ${this.state.failStreak} 次，${minutes} 分钟后重试）：${this.state.lastError}`);
      return { ok: false, error: this.state.lastError, failStreak: this.state.failStreak, nextForageAt: this.state.nextForageAt };
    }
  }

  #profileFor(cfg, now) {
    return buildInterestProfile({
      store: this.store,
      chatKeys: this.#chatKeys(cfg),
      personaTemplateId: this.#personaTemplateId(),
      extraKeywords: cfg.extraKeywords,
      now
    });
  }

  /**
   * 插件提交的见闻候选（cap.feed.publish 写到 data/life-feed-inbox/<id>.json）。
   * 插件不能调模型、不能发消息；这里只把它们并进队列，由正常的主动发言链路决定用不用。
   */
  #ingestPluginInbox(profileSource, cfg, now) {
    // profile 可能很贵（最多 20 个会话 × 800 条消息分词）：只有真的发现新条目才求值。
    // 控制台每次刷新 / 每次 life_feed_next 都会 drainInbox，inbox 里常常只剩"当天已吸收"的文件。
    const profileOf = typeof profileSource === 'function' ? profileSource : () => profileSource;
    let profileCache = null;
    const profile = () => (profileCache ||= profileOf());
    const inbox = path.join(this.dataDir, 'life-feed-inbox');
    let files = [];
    try { files = fs.readdirSync(inbox).filter((name) => name.endsWith('.json')); } catch { return 0; }
    const known = new Set([
      ...this.state.candidates.map((item) => item.id),
      ...this.state.seen.map((item) => item.id)
    ]);
    let added = 0;
    for (const name of files) {
      const file = path.join(inbox, name);
      // 插件侧用这个文件保存"当天已提交的 id"做 20 条配额，不能吸收完就删；
      // 只清两天以前的旧文件（跨天后配额状态本来就重置了），避免生活层关闭时永久堆积。
      try {
        if (now - fs.statSync(file).mtimeMs > 2 * 86400000) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch { /* 读不到 mtime 就按正常文件处理 */ }
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const source = String(payload?.pluginId || name.replace(/\.json$/, ''));
      for (const item of Array.isArray(payload?.items) ? payload.items : []) {
        const id = String(item?.id || '').trim();
        if (!id || known.has(id)) continue;
        const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
        const score = scoreCandidate({
          title: item.title,
          desc: item.summary,
          tags,
          up: item.up,
          play: 0,
          pubdate: 0,
          duration: item.durationSec
        }, profile()) + tags.reduce((sum, tag) => sum + (Number(this.state.tagWeights[tag]) || 0) * 2, 0);
        this.state.candidates.push({
          source: `plugin:${source}`,
          via: 'plugin',
          id,
          title: String(item.title || ''),
          desc: String(item.summary || ''),
          up: String(item.up || ''),
          upMid: '',
          duration: Number(item.durationSec) || 0,
          play: 0,
          pubdate: 0,
          tags,
          url: String(item.url || ''),
          cover: /^https:\/\//i.test(String(item.cover || '')) ? String(item.cover).slice(0, 500) : '',
          score,
          addedAt: now
        });
        known.add(id);
        added += 1;
      }
    }
    if (added) {
      this.state.candidates.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      this.state.candidates = this.state.candidates.slice(0, cfg.maxCandidates);
    }
    return added;
  }

  #merge(items, cfg, profile, now) {
    const known = new Set([
      ...this.state.candidates.map((item) => item.id),
      ...this.state.seen.map((item) => item.id)
    ]);
    // 队列层面也要有配额：只在 #pick 限 UP/标签的话，候选池早被同一种日更视频占满。
    const upCounts = new Map();
    const tagCounts = new Map();
    for (const candidate of this.state.candidates) {
      if (candidate.upMid) upCounts.set(candidate.upMid, (upCounts.get(candidate.upMid) || 0) + 1);
      for (const tag of candidate.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    let added = 0;
    for (const item of items) {
      if (known.has(item.id)) continue;
      if (item.upMid && (upCounts.get(item.upMid) || 0) >= 3) continue;
      const tags = item.tags || [];
      if (tags.some((tag) => (tagCounts.get(tag) || 0) >= 8)) continue;
      const tagBoost = tags.reduce((sum, tag) => sum + (Number(this.state.tagWeights[tag]) || 0) * 2, 0);
      const score = scoreCandidate(item, profile) + tagBoost;
      this.state.candidates.push({ ...item, score, addedAt: now });
      known.add(item.id);
      if (item.upMid) upCounts.set(item.upMid, (upCounts.get(item.upMid) || 0) + 1);
      for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      added += 1;
    }
    this.state.candidates.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    this.state.candidates = this.state.candidates.slice(0, cfg.maxCandidates);
    return added;
  }

  #quotaLeft(cfg, day) {
    // 手动分享是用户自己点的，不占自动份额：否则点两次没发出去，自动分享当天就没了。
    const picks = this.state.offers.filter((item) => item.day === day && item.manual !== true).length;
    // share-reserved 是发送前的原子占位：发送失败 releaseShare 会退回；
    // 发送成功 feedback('shared') 会把占位转换成 shared，不重复计数。
    const shares = this.state.records.filter((item) =>
      item.day === day && (item.action === 'shared' || item.action === 'share-reserved')).length;
    return {
      pickLeft: Math.max(0, (Number(cfg.maxPicksPerDay) || 10) - picks),
      shareLeft: Math.max(0, (Number(cfg.maxOffersPerDay) || 2) - shares)
    };
  }

  #pick({ count = 1, topic = '', manual = false } = {}) {
    const cfg = this.#cfg();
    const now = this.now();
    const day = dayKey(now);
    this.#load();
    let take = Math.max(1, Number(count) || 1);
    if (!manual) {
      const quota = this.#quotaLeft(cfg, day);
      if (quota.pickLeft <= 0) return { error: `今天已经领取 ${cfg.maxPicksPerDay} 次了，明天再继续` };
      if (quota.shareLeft <= 0) return { error: `今天已经分享 ${cfg.maxOffersPerDay} 次了，明天再继续` };
      // 一次 count=3 不能把只剩 1 次的领取额度冲破。
      take = Math.min(take, quota.pickLeft);
    }
    const offeredToday = new Set(this.state.offers.filter((item) => item.day === day).map((item) => item.id));
    const usedUp = new Set(this.state.offers.filter((item) => item.day === day).map((item) => item.upMid).filter(Boolean));
    const tagCounts = new Map();
    for (const offer of this.state.offers.filter((item) => item.day === day)) {
      for (const tag of offer.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    const needle = String(topic || '').trim().toLowerCase();
    // 已分享/跳过的 UP 和标签做跨天冷却，不再只看当天 offers；否则热门 UP 天天霸榜。
    const cooldownDays = Math.max(1, Math.min(30, Number(cfg.cooldownDays) || 7));
    const cooldownSince = now - cooldownDays * 86400000;
    const cooledUps = new Set();
    const cooledTags = new Map();
    for (const seen of this.state.seen) {
      if (Number(seen.at) < cooldownSince) continue;
      if (seen.upMid) cooledUps.add(String(seen.upMid));
      for (const tag of seen.tags || []) cooledTags.set(tag, (cooledTags.get(tag) || 0) + 1);
    }
    const picked = [];
    const sorted = this.state.candidates
      .filter((item) => !offeredToday.has(item.id))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    for (const item of sorted) {
      if (picked.length >= take) break;
      if (needle) {
        const haystack = `${item.title} ${item.desc} ${(item.tags || []).join(' ')}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      if (!manual) {
        if (item.upMid && (usedUp.has(item.upMid) || cooledUps.has(String(item.upMid)))) continue;
        if ((item.tags || []).some((tag) => (tagCounts.get(tag) || 0) >= 2 || (cooledTags.get(tag) || 0) >= 3)) continue;
      }
      picked.push(item);
      if (item.upMid) usedUp.add(item.upMid);
      for (const tag of item.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    if (!picked.length) return { error: '队列里没有可分享的候选（可能都分享过或分数太低）' };

    for (const item of picked) {
      item.offeredAt = now;
      this.state.offers.push({
        day,
        id: item.id,
        upMid: item.upMid,
        tags: item.tags || [],
        at: now,
        manual
      });
      this.state.records.unshift({ at: now, action: manual ? 'manual-offer' : 'offer', id: item.id, day });
    }
    this.#prune(now);
    this.#save();
    return { items: picked.map(publicCandidate) };
  }

  /** 立即吸收插件 inbox（不只等下一次 6 小时觅食）；控制台刷新和模型取候选前都会走。 */
  drainInbox() {
    const cfg = this.#cfg();
    if (!cfg.enabled || !cfg.sources.includes('plugin')) return 0;
    try {
      const inbox = path.join(this.dataDir, 'life-feed-inbox');
      if (!fs.readdirSync(inbox).some((name) => name.endsWith('.json'))) return 0;
    } catch { return 0; }
    this.#load();
    const now = this.now();
    const added = this.#ingestPluginInbox(() => this.#profileFor(cfg, now), cfg, now);
    if (added) this.#save();
    return added;
  }

  /** 今天还剩几次自动分享（手动分享不受此限，但会占用已分享计数）。 */
  shareQuotaLeft() {
    const cfg = this.#cfg();
    this.#load();
    return this.#quotaLeft(cfg, dayKey(this.now())).shareLeft;
  }

  /** auto = 主动轮次可自行分享；manual = 只有控制台手动唤醒能分享。 */
  shareMode() {
    return this.#cfg().shareMode;
  }

  /** 分享目标白名单：空 = 沿用聊天白名单；配置后只允许列出的群 / 私聊。 */
  isShareTarget(chatKey) {
    const targets = (this.#cfg().shareGroups || []).map(shareTargetKey).filter(Boolean);
    if (!targets.length) return true;
    const key = shareTargetKey(chatKey);
    return targets.includes(key);
  }

  next({ count = 2, topic = '', manual = false } = {}) {
    this.drainInbox();
    return this.#pick({ count, topic, manual });
  }

  takeForShare(id, { manual = true } = {}) {
    const cfg = this.#cfg();
    const now = this.now();
    const day = dayKey(now);
    this.#load();
    // 每日分享上限对自动和手动一视同仁（手动原本只扣份额、不检查，能绕过上限）。
    const quota = this.#quotaLeft(cfg, day);
    if (quota.shareLeft <= 0) return { error: `今天已经分享 ${cfg.maxOffersPerDay} 次了` };
    if (!manual && quota.pickLeft <= 0) return { error: `今天已经领取 ${cfg.maxPicksPerDay} 次了` };
    const item = this.state.candidates.find((candidate) => candidate.id === String(id || ''));
    if (!item) return { error: '这条候选不在队列里（可能已过期或已被分享）' };
    item.offeredAt = now;
    this.state.offers.push({ day, id: item.id, upMid: item.upMid, tags: item.tags || [], at: now, manual: manual === true });
    this.state.records.unshift({ at: now, action: 'manual-share', id: item.id, day, source: item.source || '' });
    // 这里只排队、不占分享名额：模型真正调用 share_bilibili 时 reserveShare 才做原子占位。
    // 手动点的这次如果最终没发出去，不会把自动领取一起挡住。
    this.#prune(now);
    this.#save();
    return { item: publicCandidate(item) };
  }

  /**
   * 发送前原子占用一个分享名额。并发会话都在 await 发送结果，先 peek 再发送会同时
   * 看到剩余 1 次而各发一条（2026-11-03 全量审查 P2）。同步检查+落库，只有一个能成功。
   */
  reserveShare(id, { manual = false } = {}) {
    const key = String(id || '').trim();
    const cfg = this.#cfg();
    const now = this.now();
    const day = dayKey(now);
    this.#load();
    const item = this.state.candidates.find((candidate) => candidate.id === key);
    if (!item) return { error: '这条候选不在队列里（可能已过期或已被分享）' };
    const existing = this.state.records.find((record) =>
      record.day === day && record.id === key && record.action === 'share-reserved');
    if (existing) {
      // 同一条候选正在被另一个会话发送：不能再发一次（占位按 id 去重，二次放行会
      // 真正发出两条却只记一次额度）。超过 10 分钟的占位视为崩溃残留，清掉重来。
      if (now - Number(existing.at || 0) < 10 * 60_000) {
        return { error: '这条见闻正在分享中，请稍后再试' };
      }
      this.state.records = this.state.records.filter((record) => record !== existing);
    }
    const quota = this.#quotaLeft(cfg, day);
    if (quota.shareLeft <= 0) return { error: `今天已经分享 ${cfg.maxOffersPerDay} 次了` };
    this.state.records.unshift({ at: now, action: 'share-reserved', id: key, day, source: item.source || '', manual: manual === true });
    this.#prune(now);
    this.#save();
    return { item: publicCandidate(item), reserved: true };
  }

  /** 分享没有真正进入发送链路/确定失败时，把 offer、排队记录与占位一起撤回。 */
  releaseShare(id) {
    const key = String(id || '').trim();
    const day = dayKey(this.now());
    this.#load();
    this.state.offers = this.state.offers.filter((item) =>
      !(item.id === key && item.manual === true && item.day === day));
    this.state.records = this.state.records.filter((item) =>
      !(item.id === key && item.day === day
        && (item.action === 'manual-share' || item.action === 'share-reserved')));
    this.#save();
    return { ok: true };
  }

  feedback({ id, action = 'skip', chatKey = '', messageId = null, manual = false } = {}) {
    const key = String(id || '').trim();
    const verb = ['shared', 'skip', 'more_like_this'].includes(action) ? action : 'skip';
    this.#load();
    const item = this.state.candidates.find((candidate) => candidate.id === key);
    if (!item) {
      // 候选可能已被并发的第一次分享移除；shared/skip 仍要把占位清掉，不能留下
      // 一条永远占着额度的 share-reserved。
      if (verb === 'shared' || verb === 'skip') {
        const day = dayKey(this.now());
        const before = this.state.records.length;
        this.state.records = this.state.records.filter((record) =>
          !(record.id === key && record.day === day && record.action === 'share-reserved'));
        if (this.state.records.length !== before) this.#save();
      }
      return { ok: false, error: '候选不存在' };
    }
    if (verb === 'more_like_this') {
      for (const tag of item.tags || []) {
        this.state.tagWeights[tag] = Math.min(50, (Number(this.state.tagWeights[tag]) || 0) + 1);
      }
      this.state.records.unshift({ at: this.now(), action: 'more-like-this', id: key, chatKey, source: item.source || '' });
      this.#save();
      return { ok: true, action: verb };
    }
    this.state.candidates = this.state.candidates.filter((candidate) => candidate.id !== key);
    if (verb === 'shared' || verb === 'skip') {
      // shared = 占位转正（先删 share-reserved 再写 shared，额度只算一次）；
      // skip = 放弃分享，占位必须退回。
      const day = dayKey(this.now());
      this.state.records = this.state.records.filter((record) =>
        !(record.id === key && record.day === day && record.action === 'share-reserved'));
    }
    // shared 给正反馈、skip 给负反馈：只在 more_like_this 时加权的旧口径会让 skip 永远不收敛。
    const delta = verb === 'shared' ? 1 : -1;
    for (const tag of item.tags || []) {
      const next = (Number(this.state.tagWeights[tag]) || 0) + delta;
      this.state.tagWeights[tag] = Math.max(-10, Math.min(50, next));
    }
    this.state.seen.push({
      id: key, at: this.now(), upMid: item.upMid || '',
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : []
    });
    this.state.records.unshift({
      at: this.now(), action: verb, id: key, chatKey, day: dayKey(this.now()),
      source: item.source || '',
      ...(manual === true ? { manual: true } : {}),
      ...(messageId === null || messageId === undefined ? {} : { messageId })
    });
    this.#prune(this.now());
    this.#save();
    return { ok: true, action: verb };
  }

  /** 按 id 取一条候选（分享工具用；不改变队列）。 */
  candidate(id) {
    this.#load();
    const item = this.state.candidates.find((entry) => entry.id === String(id || ''));
    return item ? publicCandidate(item) : null;
  }

  /** 清空候选队列（不动 seen / offers / 反馈权重）：用于画像或搜索词修正后立刻重来。 */
  clearCandidates() {
    this.#load();
    const removed = this.state.candidates.length;
    this.state.candidates = [];
    this.state.records.unshift({ at: this.now(), action: 'clear-candidates', removed });
    this.#save();
    return { ok: true, removed };
  }

  dismiss(id) {
    return this.feedback({ id, action: 'skip' });
  }
}
