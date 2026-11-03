// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig, DEFAULT_CONFIG } from '../core/config.js';
import { sleep, sleepAbortable, randInt, createSendChain, formatClockTime, todayKey } from '../core/util.js';
import { mdToPlain, splitForQQ } from '../llm/md-to-plain.js';
import { shapeBubbles } from '../llm/bubble-shape.js';
import { assertCanSend, chatAllowed } from '../core/access.js';
import { isTimeActive } from '../core/time-gate.js';
import { platformToolAllowed, privateFileMaxKiB } from '../core/platform-gates.js';
import { preparePrivateTextFile, privateTextFileError } from './private-text-file.js';
import { displayNameOf } from '../core/display-name.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('sender');

/**
 * 把正文里的 @昵称 展开成 text / at 段。只接受唯一命名的成员；重名、找不到、
 * 像邮箱/URL 里的 @ 一律保持原文。返回 null 表示没有任何可替换的 mention。
 * members: [{ userId, name }]，调用方负责把群名片与备注显示名都放进来。
 */
export function buildMentionParts(text, members = []) {
  const source = String(text ?? '');
  const owners = new Map();
  for (const member of Array.isArray(members) ? members : []) {
    const name = String(member?.name ?? '').trim();
    const userId = String(member?.userId ?? '').trim();
    if (!name || !/^\d+$/.test(userId)) continue;
    const key = name.toLowerCase();
    const ids = owners.get(key) || new Set();
    ids.add(userId);
    owners.set(key, ids);
  }
  const candidates = [...owners.entries()]
    .filter(([, ids]) => ids.size === 1)
    .map(([key, ids]) => ({ key, name: key, userId: [...ids][0] }))
    .sort((a, b) => b.name.length - a.name.length);
  if (!candidates.length) return null;

  const parts = [];
  let cursor = 0;
  let changed = false;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '@') continue;
    const prev = source[i - 1] || '';
    // 邮箱/URL 里的 @ 不转（a@b.com、https://x/@user）；中文正文里的“你好@张三”照转。
    if (prev && /[A-Za-z0-9._%+/-]/.test(prev)) continue;
    let matched = null;
    for (const candidate of candidates) {
      const end = i + 1 + candidate.name.length;
      if (end > source.length) continue;
      if (source.slice(i + 1, end).toLowerCase() !== candidate.key) continue;
      const after = source[end] || '';
      // 不能把“@张三丰”里的“张三”当成 mention（项目 isAtMe 同款边界）；邮箱的
      // “张三@qq.com”也不能把 qq 拆成 at。宁可少一个提醒，也不 @ 错人。
      if (after && /[A-Za-z0-9_.\u3400-\u9fff]/u.test(after)) continue;
      matched = { ...candidate, end };
      break;
    }
    if (!matched) continue;
    if (i > cursor) parts.push({ type: 'text', text: source.slice(cursor, i) });
    parts.push({ type: 'at', qq: matched.userId });
    cursor = matched.end;
    i = matched.end - 1;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < source.length) parts.push({ type: 'text', text: source.slice(cursor) });
  return parts;
}

function expandMemberNames(members = []) {
  const out = [];
  for (const member of Array.isArray(members) ? members : []) {
    const userId = String(member?.userId || '');
    const raw = String(member?.name || '').trim();
    if (!userId || !raw) continue;
    out.push({ userId, name: raw });
    const display = displayNameOf(userId, raw);
    if (display && display !== raw) out.push({ userId, name: display });
  }
  return out;
}

function mentionMembersFor(store, chatKey) {
  if (typeof store?.memberNames !== 'function') return [];
  return expandMemberNames(store.memberNames(chatKey, { limit: 10000 }) || []);
}

function directoryMembersFrom(list) {
  return expandMemberNames((Array.isArray(list) ? list : []).map((member) => ({
    userId: member?.user_id ?? member?.userId ?? '',
    name: member?.card || member?.nickname || member?.name || ''
  })));
}

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;

/**
 * 按证据给一次发送失败定性（重试判定与 outbox 记账必须同一口径）。
 *   definite  —— 能证明请求没被对方收到（连不上/解析不了/网络不可达），可以安全重试、按 failed 记账；
 *   uncertain —— 可能已经投递（超时、连接被重置、socket hang up、协议端 5xx），绝不自动重试，按 unknown 记账。
 * undici 的外层 message 恒为 "fetch failed"，真因在 cause 上，所以以 cause 为准 ——
 * 拿外层 message 当依据会把"连接被拒"误判成"结果未知"，于是该重试的永远不重试、
 * 还会被记成 critical 未知写入挂在"待处理"里（人工只能 resolveHeld 丢掉它）。
 */
export function classifyTransportFailure(error) {
  const message = String(error?.message ?? error);
  const causeText = String(error?.cause?.code || error?.cause?.message || '');
  const evidence = causeText || message;
  // WS 帧级证据也是"确定未投递"：ws 的 send 回调报错（readyState 非 OPEN → 帧没写进 socket，
  // 文案 "WebSocket is not open: readyState …"）与发送途中连接被关（帧没写完/压缩中被打断 ——
  // 接收端只拿到残帧会被整帧丢弃；ws 8.x 的真实文案是 "The socket was closed while data was
  // being compressed" / "…blob was being read"）都意味着对方不可能收到完整帧。加进来之前
  // 这些错误既不匹配 definite 也不匹配 uncertain，结果"确定没送达"的消息既不重试、
  // 还落 unknown 挂人工核对（2026-10-07 复审）。
  const definite = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|WebSocket is not open|WS 发送失败|socket was closed while data was being (compressed|read)/i.test(evidence);
  const uncertain = !definite
    && /timeout|timed out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|fetch failed|network|HTTP 5\d\d|Unexpected status code: 5\d\d/i.test(evidence);
  return { evidence, definite, uncertain };
}

/** 被禁言时报给模型的错误文案（模型当轮可见，可直接决定"先不发言"）。 */
function muteError(untilTs) {
  if (!untilTs) return '本群全员禁言中，本轮先不发言';
  // 只写 HH:MM:SS 会让模型以为"今天就能发"：QQ 禁言最长 30 天，跨天时必须带上日期
  // （2026-09-26 审查：25 小时后的解禁时间被写成"预计 09:12:33 解除"）
  // ⚠️ 日期与时刻必须同一口径（都是上海时区，2026-10-09 审查）：原来用 getMonth()/getDate()
  // 取的是**宿主机本地时区**的日期，而 formatClockTime 固定按 Asia/Shanghai 格式化 ——
  // 部署在 TZ=UTC 的机器上，北京 0-8 点之间两者差一天，解禁日期会报错一天。
  const dayKey = todayKey(untilTs);
  const sameDay = dayKey === todayKey();
  const [, mm, dd] = dayKey.split('-');
  const when = sameDay
    ? formatClockTime(untilTs)
    : `${Number(mm)}月${Number(dd)}日 ${formatClockTime(untilTs)}`;
  return `本群禁言中（预计 ${when} 解除），本轮先不发言`;
}

/**
 * 禁言错误统一带 code：上层（工具收口）据此把它当"预期内失败"，不记进异常面板。
 * 被禁言期间每轮都会撞上，记成异常只会把控制台刷满。
 */
function mutedError(untilTs) {
  const error = new Error(muteError(untilTs));
  error.code = 'GROUP_MUTED';
  return error;
}

// QQ 的群禁言最长 30 天；这里放宽到 365 天，只拦"明显不是秒级时间戳"的值。
// 单位一旦被误读（有的实现给毫秒），拿原值比较就等于从此不再发言 —— 宁可漏拦
// （回到交给 QQ 服务端兜底的老行为），不可误封。超限值按未禁言处理，并留一行日志。
const MUTE_MAX_AHEAD_SEC = 365 * 24 * 3600;
/**
 * 1 / true 这种"标志位"形态：OneBot v11 没规定 group_all_shut 的单位，
 * NapCat 等实现回的是"是否全员禁言"的布尔/标志位。它是"禁言中、解除时间未知"，
 * 必须与"秒级时间戳"区别对待 —— 直接当秒级时间戳比大小的话 1 <= now → 永远拦不住，
 * 就退化成原来"发出后吃 result=120"的老行为（2026-09-26 审查）。
 * 返回 'flag' 表示标志位，0 表示没禁言，正数表示解禁秒级时间戳。
 */
export function muteMark(raw, nowSec) {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 'flag';
  const shut = Number(raw || 0);
  if (!Number.isFinite(shut) || shut <= nowSec) return 0;
  if (shut > nowSec + MUTE_MAX_AHEAD_SEC) {
    log.warn('[send] 禁言时间戳超出常识范围（>365 天），按未禁言处理:', raw);
    return 0;
  }
  return shut;
}

function muteUntilMs(raw, nowSec) {
  const shut = muteMark(raw, nowSec);
  if (shut === 'flag') return 0;              // 标志位没有解禁时间，交给下面单独判定
  if (!shut) return 0;
  return shut * 1000;                         // 超限值由 muteMark 一处兜住（超限即返回 0）
}

/**
 * 人类化首条延迟（纯函数，便于单测，不依赖墙钟）。
 * 未开启或 replyDelay 关闭时返回 null（调用方回退到普通 #gap）。
 */
export function leadDelayFor(humanize, parts) {
  const h = humanize;
  if (h?.enabled !== true || h?.replyDelay?.enabled === false) return null;
  const n = (Array.isArray(parts) ? parts : []).reduce((sum, part) => sum + String(part || '').length, 0);
  const min = Math.max(0, Math.min(30000, Number(h?.replyDelay?.minMs) || 0));
  const max = Math.max(min, Math.min(30000, Number(h?.replyDelay?.maxMs) || min));
  const perChar = Math.max(0, Math.min(200, Number(h?.replyDelay?.perCharMs) || 0));
  const cap = Math.max(max, Math.min(60000, Number(h?.replyDelay?.capMs) || 8000));
  const base = min + Math.random() * (max - min) + n * perChar;
  return Math.min(cap, Math.max(0, Math.round(base)));
}

export class SendQueue {
/**
   * 送达之后的记账：把自己发出去的话写进库 + 通知 onSent。
   * 这些都是**发送成功之后**的副作用，失败绝不能把一次已经送达的发送改判成失败：
   * 文本/贴纸/语音/拍一拍/表情五条路径的 appendSelf + onSent 都在 Promise.allSettled
   * 的链里，任一处抛错都会被汇总成 failed → 告诉模型「发送失败」→ 模型重发 →
   * 群里出现两条一样的消息（2026-10-04 全面复审 P3 实测：stub appendSelf 抛 disk full，
   * sendCalls=1、outbox=sent，却上报 toolOutcome=发送失败）。
   * 写不进去的账留给人工核对，这里只记日志。
   */
  #afterSent(run) {
    try {
      // 刻意写成 run.call(null)：ops scan 按「标识符(」收集调用点，直接写 run( 会把参数名
      // 当成一个未定义的全局函数报出来（2026-10-04 全面复审）。
      return run.call(null);
    } catch (error) {
      log.warn('[sender] 消息已送达但记账失败（该条仍算已发出，不会上报失败）:', error?.message ?? error);
      return null;
    }
  }

  /**
   * 送达后记账要用的「被引用消息的作者」。**这一步已经在 send() 成功之后**，所以库读也必须
   * 自己兜住：findByMid 抛错（磁盘/库损坏这类不受 busy_timeout 管的错）会让整条 promise
   * reject → sendTextBatch 把这条记成 failed → 模型以为没发出去、重发 → 群里两条一样的消息。
   * 与 #afterSent 同源的漏兜（2026-10-05 全审：三处 findByMid 都在兜底之外）。
   */
  #replyTarget(chatKey, options) {
    const at = String(options.atUserId || '');
    if (at || options.replyToMessageId == null) return at;
    try {
      const replied = this.store.findByMid(chatKey, options.replyToMessageId);
      if (replied && !replied.self) return String(replied.senderId || '');
    } catch (error) {
      log.warn('[sender] 消息已送达，但查被引用消息失败（这条按无引用记账）:', error?.message ?? error);
    }
    return at;
  }

  constructor({ onebot, store, onSent = null, onIncident = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    this.onIncident = typeof onIncident === 'function' ? onIncident : () => {};
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    this.mentionCache = new Map(); // chatKey -> { at, members }（协议端成员名单，10 分钟缓存）
    this.mentionDirectoryPending = new Map(); // chatKey -> Promise
  }

  async #refreshMentionDirectory(chatKey) {
    if (this.mentionDirectoryPending.has(chatKey)) return this.mentionDirectoryPending.get(chatKey);
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' || typeof this.onebot?.getGroupMemberList !== 'function') {
      this.mentionCache.set(chatKey, { at: Date.now(), members: [] });
      return;
    }
    const task = (async () => {
      let timer = null;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('成员名单获取超时')), 4000);
        });
        const list = await Promise.race([this.onebot.getGroupMemberList(id), timeout]);
        this.mentionCache.set(chatKey, { at: Date.now(), members: directoryMembersFrom(list) });
      } catch (error) {
        // 不是所有协议端都支持/允许拉完整群成员；失败就只退回消息表里的发言人，
        // 不能因为成员名单接口不可用而让回复发不出去。
        log.warn(`[sender] ${chatKey} 拉取群成员名单失败，@昵称 仅使用最近发言人:`, error?.message ?? error);
        this.mentionCache.set(chatKey, { at: Date.now(), members: [] });
      } finally {
        if (timer) clearTimeout(timer);
        this.mentionDirectoryPending.delete(chatKey);
      }
    })();
    this.mentionDirectoryPending.set(chatKey, task);
    return task;
  }

  async #mentionMembersFor(chatKey) {
    let recent = [];
    try {
      recent = mentionMembersFor(this.store, chatKey);
    } catch (error) {
      // 成员表读失败只放弃这次 @ 展开，纯文本仍要照常发出去。
      log.warn('[sender] 读取成员表失败，本次不展开 @昵称:', error?.message ?? error);
    }
    const cached = this.mentionCache.get(chatKey);
    if (!cached || Date.now() - cached.at > 10 * 60 * 1000) {
      await this.#refreshMentionDirectory(chatKey);
    }
    const directory = this.mentionCache.get(chatKey)?.members || [];
    // buildMentionParts 会按名字去重；这里保留两份，让“最近发言人”和完整名单互相兜底。
    return [...recent, ...directory];
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  // 群禁言前置检测：被禁言时直接把原因报给模型，而不是发出后吃协议端拒发
  // （result=120 / retcode 120），模型既不知道失败原因，还会原话重试。
  // 结果缓存 60 秒：批量发送不应逐条查；查询失败不阻塞发送，交给 QQ 服务端兜底。
  #muteCache = new Map(); // chatKey -> { muted: boolean, untilTs: number, checkedAt: number }
  async #assertNotMuted(chatKey) {
    if (!chatKey.startsWith('group:')) return;
    const cached = this.#muteCache.get(chatKey);
    const now = Date.now();
    if (cached && now - cached.checkedAt < 60_000) {
      // 缓存的是"当时被禁言 + 解禁时间"：解禁时间已过就不能再拦，
      // 否则短禁言（1 分钟级）解除后这一分钟内仍会被拒，而且报的还是已经过去的时间（2026-09-26 审查）。
      if (cached.muted && (cached.untilTs > now || cached.untilTs === 0)) throw mutedError(cached.untilTs);
      if (cached.muted) { /* 已到期：往下重新查一次，别用过期的结论 */ }
      else return;
    }
    const entry = { muted: false, untilTs: 0, checkedAt: now };
    const nowSec = now / 1000;
    try {
      const groupId = chatKey.slice('group:'.length);
      const selfId = this.onebot.selfId;
      // 两个来源都要看：单独禁言在成员信息上，全员禁言在群信息上，协议端不一定互相带
      // （2026-09-26 审查：只查成员信息会漏掉"全员禁言"这种它本来就要拦的情形）。
      // 两边各自兜错：任一个接口缺失或失败，都不该把另一个的结果一起丢掉。
      const selfInfo = (selfId && typeof this.onebot.getGroupMemberInfo === 'function')
        ? await this.onebot.getGroupMemberInfo(groupId, selfId).catch(() => null)
        : null;
      const groupInfo = typeof this.onebot.getGroupInfo === 'function'
        ? await this.onebot.getGroupInfo(groupId).catch(() => null)
        : null;
      const shut = Math.max(
        muteUntilMs(selfInfo?.shut_up_timestamp, nowSec),
        muteUntilMs(groupInfo?.group_all_shut, nowSec)
      );
      if (shut > 0) { entry.muted = true; entry.untilTs = shut; }
      // 全员禁言以标志位形态返回时没有解禁时间：同样要拦，但文案说"解除时间未知"
      else if (muteMark(groupInfo?.group_all_shut, nowSec) === 'flag') { entry.muted = true; entry.untilTs = 0; }
    } catch { /* 查询失败不能阻塞正常发送 */ }
    this.#muteCache.set(chatKey, entry);
    if (entry.muted) throw mutedError(entry.untilTs);
  }

  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    // 回退值必须与 config.js 的默认值一致（80）。此前这里是 8，
    // 配置缺失/为 0 时限频突然收紧 10 倍，行为不可预测。
    if (minute.length >= Math.max(1, Number(cfg.maxPerMinute) || DEFAULT_MAX_PER_MINUTE)) {
      throw new Error(`发送频率超限（每分钟最多 ${cfg.maxPerMinute || DEFAULT_MAX_PER_MINUTE} 条），请等一会再发`);
    }
    if (hour.length >= Math.max(1, Number(cfg.maxPerHour) || DEFAULT_MAX_PER_HOUR)) {
      throw new Error(`发送频率超限（每小时最多 ${cfg.maxPerHour} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  #gap(text, isLast, voice) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    // 角色卡自己的节奏优先：猫娘/损友不该等跟技术宅一样久。只在开了人类化时生效。
    const pause = voice?.pauseMs;
    if (getConfig().humanize?.enabled === true && Array.isArray(pause) && pause.length === 2) {
      const vmin = Math.max(0, Math.min(30000, Number(pause[0]) || 0));
      const vmax = Math.max(vmin, Math.min(30000, Number(pause[1]) || vmin));
      // 200ms 是绝对下限（与下面普通路径同款）：voice-profiles 写 [0,0] 不能造成零间隔连发刷屏
      return Math.max(200, randInt(vmin, vmax));
    }
    // byLengthMs 的 0 是合法值（"不按字数附加延迟"，控制台那个框 min="0"）——
    // 用 `|| 20` 会把它吞掉，界面上填了 0、实际每条仍按 20ms/字延迟（2026-10-08 审查）。
    const perChar = Number(cfg.byLengthMs);
    const byLength = Math.min(8000, String(text || '').length * (Number.isFinite(perChar) ? Math.max(0, perChar) : 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  /**
   * 人类化首条延迟：按本批总字数模拟"看完再打字"，不改变后续气泡的间隔。
   * 未开启时返回 null（调用方回退到原来的 #gap），保证升级前后发送节奏逐字一致。
   */
  #leadDelay(parts) {
    return leadDelayFor(getConfig().humanize, parts);
  }

  /**
   * 私聊「正在输入…」（群聊没有这个能力，协议端侧会 no-op）。开关 send.typingIndicator
   * 默认开；纯装饰，任何失败（协议端不支持、超时）都吞掉，绝不影响本次发送。
   */
  async #signalTyping(kind, id, options) {
    if (kind !== 'private') return;
    if (getConfig().send?.typingIndicator === false) return;
    if (typeof this.onebot?.setInputStatus !== 'function') return;
    try {
      await this.onebot.setInputStatus('private', id, true, options?.signal);
    } catch { /* 输入状态只是装饰 */ }
  }

  async #deliver(chatKey, options, payload, send) {
    await this.#assertNotMuted(chatKey);
    // gameScoped：只由群游戏管理器对"本局在册玩家"设置（access.assertCanSend 里放宽 allow.private）
    assertCanSend(chatKey, options.signal, { gameScoped: options.gameScoped === true });
    const id = this.store.beginSend(chatKey, options.runId, payload);
    try {
      let data = null;
      for (let attempt = 1; ; attempt += 1) {
        try {
          data = await send();
          break;
        } catch (error) {
          const message = String(error?.message ?? error);
          // 只有"能证明请求没被对方收到"的错误才自动重试（definite）；
          // 超时、连接被重置、socket hang up、协议端 5xx 都可能发生在"对方已经收下并发出去了"之后——
          // 重发会让群里出现两条一样的消息，而 outbox 只记一条，人工核对也看不到重复。
          const { definite, uncertain } = classifyTransportFailure(error);
          if (attempt >= 2 || !definite || uncertain || options.signal?.aborted) throw error;
          log.info(`[sender] 发送失败（可确认未送达），1.5 秒后重试一次（${message.slice(0, 80)}）`);
          // 等待要可中止；中止后必须抛**第一次的 definite 错误**，不能抛 AbortError ——
          // 后者会被归类为 unknown，把一个可安全重试的"确定未送达"变成人工核对阻塞。
          try {
            await sleepAbortable(1500, options.signal);
          } catch {
            throw error;
          }
          if (options.signal?.aborted) throw error;
        }
      }
      try {
        this.store.finishSend(id, { messageId: data?.message_id });
      } catch (accountingError) {
        // 消息**已经送达**（上面拿到 data 就是证据）。记账失败绝不能改判成"发送失败"再抛出去 ——
        // 那会让模型以为没发出去而重发，群里就多一条一模一样的内容（2026-10-04 全面复审 P3）。
        // 该行留在 sending，控制台"未知写入"里能人工核对 —— 这本来就是 sending 状态的用途。
        log.warn('[sender] 消息已送达但 outbox 记账失败（该行留在 sending，待人工核对）:',
          accountingError?.message ?? accountingError);
      }
      return data;
    } catch (error) {
      // 记账口径与重试判定一致：能证明没送达的算 failed（可被"重试失败批次"捞回来），
      // 其余算 unknown（持有待人工核对）。以前只看 error.outcome —— 那只在 OneBotActionError 上有，
      // 裸 fetch 失败永远落进 unknown：一次"连接被拒"会被记成 critical 未知写入、回复静默丢失。
      const { definite, uncertain } = classifyTransportFailure(error);
      const outcome = error?.outcome === 'failed' || error?.outcome === 'unknown'
        ? error.outcome
        : (definite && !uncertain ? 'failed' : 'unknown');
      try {
        this.store.finishSend(id, {
          error: error?.message ?? error,
          outcome
        });
      } catch (accountingError) {
        // 与成功路径同口径（2026-10-04 复审修的是成功路径，失败路径是漏网之鱼，2026-10-06 复审 P3）：
        // 记账失败只记日志、原错误照抛 —— 否则真实错误被 sqlite 错误顶掉、incident 整段跳过、
        // 本该记 failed 自动重试的 definite 失败被升级成"未知写入"人工核对。
        log.warn('[sender] 发送失败后 outbox 记账也失败（该行留在 sending，待人工核对）:',
          accountingError?.message ?? accountingError);
      }
      try {
        const incident = this.onIncident(error, {
          source: 'sender',
          category: 'external_write',
          severity: outcome === 'unknown' ? 'critical' : 'error',
          outcome,
          chatKey,
          operationId: id,
          details: { type: payload?.type || 'unknown', runId: options.runId || '' }
        });
        if (incident && error && typeof error === 'object') error.incidentCaptured = true;
      } catch { /* 异常记录失败不能改变原发送结果 */ }
      throw error;
    }
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId, preserveCode }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const humanizeCfg = getConfig().humanize;
    // 气泡整形只作用于"人格回复"（send_message 路径传 persona:true）。
    // 日报/群游戏结算/管理员简报/插件代发这类系统文本有自己的格式，按卡的每条字数硬拆只会拆坏。
    // 整形在 Markdown 转换之前做：代码围栏、URL、行内代码还在原文里，拆分器能整段保护它们。
    const shaped = humanizeCfg?.enabled === true && humanizeCfg?.shape?.enabled !== false
      && options.persona === true
      ? shapeBubbles(list, {
        maxBubbles: options.voice?.maxBubbles ?? humanizeCfg?.shape?.maxBubbles,
        maxChars: options.voice?.maxChars ?? humanizeCfg?.shape?.maxChars
      })
      : list;
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts = [];
    for (const m of shaped) {
      const plain = mdToPlain(String(m ?? ''), { preserveCode: options.preserveCode === true });
      if (!plain) continue;
      // 最后防线：任何上游畸形路径漏下来的 "[object Object]" 到这儿直接拦掉，
      // 用户永远不该在 QQ 里看到这串字符。全被拦 → 下方抛"消息内容为空"回给模型。
      if (/^\[object Object\]$/.test(plain)) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');
    // 显式 atUserId 优先；只有正文里真的出现 @ 才查成员表并展开成 at 段。
    const mentionMembers = kind === 'group' && !options.atUserId && parts.some((text) => text.includes('@'))
      ? await this.#mentionMembersFor(chatKey) : [];

    const chain = this.#chain(chatKey);
    const promises = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      // 首条：开了人类化才用它（可为 0），否则回退到原来的 #gap —— 关闭时发送节奏与升级前一致。
      const lead = i === 0 ? this.#leadDelay(parts) : null;
      const gap = lead === null ? this.#gap(text, isLast, options.voice) : lead;
      const mentionParts = mentionMembers.length && text.includes('@')
        ? buildMentionParts(text, mentionMembers) : null;
      promises.push(chain(async () => {
        assertCanSend(chatKey, options.signal, { gameScoped: options.gameScoped === true });
        if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
        this.#checkRate(chatKey);
        // 先亮"正在输入"再等间隔：对方看到的状态是"它正在打字"，而不是干等（私聊限定）。
        await this.#signalTyping(kind, id, options);
        if (gap > 0) await sleepAbortable(gap, options.signal);
        const data = await this.#deliver(chatKey, options, { type: 'text', text }, () => (
          mentionParts
            ? this.onebot.sendRichText(kind, id, mentionParts, {
              replyToMessageId: i === 0 ? options.replyToMessageId : null,
              signal: options.signal
            })
            : this.onebot.sendText(kind, id, text, {
              replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
              atUserId: i === 0 ? options.atUserId : null,
              signal: options.signal
            })
        ));
        const ts = Date.now();
        let targetUserId = this.#replyTarget(chatKey, options);
        if (!targetUserId && kind === 'private') targetUserId = String(id);
        this.#afterSent(() => {
          this.store.appendSelf(chatKey, {
          text,
          ts,
          mid: data?.message_id ?? null,
          targetUserId,
          // 引擎私聊（群游戏的 game-secret）由调用方指定 eventKind：发送端是首次写库者，
          // 落库时就得是正确的类型，不能等 ingest 回显（按 mid 幂等、不会回填；2026-09-29 审查 P0）
          eventKind: options.eventKind || 'message'
          });
        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        });        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') sent.push(r.value);
      // 带上 index 和原文：调用方需要知道"哪一条"失败了（才能重发或告知模型）。
      // 原先 failed 里只有 error，没有任何定位信息。
      else failed.push({ index: i, text: parts[i], error: String(r.reason?.message ?? r.reason) });
    }
    // 部分成功也要让调用方知道：原先只在"全败"时抛错，部分成功会静默丢消息
    if (failed.length > 0) {
      const detail = failed.map((f) => `第${f.index + 1}条「${String(f.text).slice(0, 20)}」：${f.error}`).join('；');
      if (sent.length === 0) {
        // 组合出来的新错误必须继承原始错误码：上层（工具收口）靠 code 区分"预期内失败"
        // （如 GROUP_MUTED 本群禁言）与真事故。失败原因一致时才继承，混着不同原因就不猜。
        const codes = new Set(settled
          .filter((r) => r.status === 'rejected' && r.reason?.code)
          .map((r) => r.reason.code));
        const error = new Error(detail);
        if (codes.size === 1) error.code = [...codes][0];
        throw error;
      }
      log.warn(`[sender] 部分发送失败（${failed.length}/${parts.length}）：${detail}`);
    }
    return { sent, failed };
  }

  /** 发一张「聊天记录」卡片（合并转发）。nodes 格式见 onebot.sendForwardMsg。 */
  sendForwardCard(chatKey, nodes, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      const data = await this.#deliver(chatKey, options, { type: 'forward', nodes: nodes.length }, () => this.onebot.sendForwardMsg(kind, id, nodes, {
        signal: options.signal
      }));
      const ts = Date.now();
      let targetUserId = this.#replyTarget(chatKey, options);
      if (!targetUserId && kind === 'private') targetUserId = String(id);
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, {
          text: `[聊天记录卡片]${nodes.length}条`,
          ts,
          mid: data?.message_id ?? null,
          targetUserId,
          eventKind: 'message'
        });
        this.onSent?.({ chatKey, text: '[聊天记录卡片]', messageId: data?.message_id ?? null });
      });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 与 sendTextBatch 同一道防线：上一次发送结果 unknown（超时/5xx）时停止后续发送，
      // 避免"不知道发没发出去"的消息与表情/拍一拍叠加出多笔 unknown 记账。
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      await this.#signalTyping(kind, id, options); // 私聊发表情前同样先亮输入状态
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      const data = await this.#deliver(chatKey, options, { type: 'sticker', id: sticker.id }, () => this.onebot.sendSticker(kind, id, sticker.url, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null,
        signal: options.signal
      }));
      const ts = Date.now();
      let targetUserId = this.#replyTarget(chatKey, options);
      if (!targetUserId && kind === 'private') targetUserId = String(id);
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, {
        text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`,
        ts,
        mid: data?.message_id ?? null,
        targetUserId,
        eventKind: 'message'
        });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      });      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 发送一张普通图片（不带表情标记，群友可直接保存）。生成图按 imageGen.sendAs='image'
   * 走这条；与 sendSticker 共用限频、禁言预检、outbox 记账与不确定结果防线（issue #67）。
   */
  sendImage(chatKey, image, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      await this.#signalTyping(kind, id, options);
      await sleep(randInt(600, 1500));
      const data = await this.#deliver(chatKey, options, { type: 'image', id: image.id }, () => this.onebot.sendImage(kind, id, image.url, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null,
        signal: options.signal
      }));
      const ts = Date.now();
      let targetUserId = this.#replyTarget(chatKey, options);
      if (!targetUserId && kind === 'private') targetUserId = String(id);
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, {
          text: `[图片:${image.desc || image.localNote || image.id}]`,
          ts,
          mid: data?.message_id ?? null,
          targetUserId,
          eventKind: 'message'
        });
        this.onSent?.({ chatKey, text: '[图片]', messageId: data?.message_id ?? null });
      });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * QQ 原生 AI 语音（send_qq_voice 工具）：群聊限定，协议端 SnowLuma ≥1.14.20。
   * 走 #deliver —— 与文本/语音/贴纸同款：限频、禁言预检、outbox 记账。
   * （2026-10-07 复审 P2：原先工具直接 onebot.call，模型抽风时没有任何限频。）
   */
  aiVoice(chatKey, { character, text, label = '' } = {}, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group') throw new Error('QQ 原生语音只能发在群聊里');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500));
      const data = await this.#deliver(chatKey, options, { type: 'ai-voice', character },
        () => this.onebot.call('send_group_ai_record', {
          group_id: Number(id), character, text
        }, 60000, options.signal));
      const ts = Date.now();
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, {
          text: `[QQ语音]${String(label || text).slice(0, 60)}`,
          ts,
          mid: data?.message_id ?? null,
          targetUserId: '',
          eventKind: 'message'
        });
        this.onSent?.({ chatKey, text: '[QQ语音]', messageId: data?.message_id ?? null });
      });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 当前私聊的纯文本资料：不接受路径/URL/接收人，权限与未知投递沿用发送队列。
   */
  privateTextFile(chatKey, args, options = {}) {
    if (!/^private:[1-9]\d*$/.test(String(chatKey))) throw new Error('文本文件只能发给当前私聊');
    const id = Number(String(chatKey).slice('private:'.length));
    if (!Number.isSafeInteger(id)) throw new Error('私聊标识无效');
    const { file, name, bytes } = preparePrivateTextFile(args, getConfig().platform);
    const check = () => {
      if (!platformToolAllowed('send_private_file', getConfig().platform, chatKey)) {
        throw privateTextFileError('PRIVATE_FILE_DISABLED');
      }
      if (bytes > privateFileMaxKiB(getConfig().platform) * 1024) throw privateTextFileError('PRIVATE_FILE_SIZE_LIMIT');
      // 不接受群游戏的私聊豁免，排队后与真正上传前都重新检查。
      try {
        assertCanSend(chatKey, options.signal);
      } catch {
        // 只解释原访问检查的拒绝原因，不代替或放宽它。
        const cfg = getConfig();
        const code = options.signal?.aborted ? 'PRIVATE_FILE_CANCELLED'
          : !isTimeActive(chatKey) ? 'PRIVATE_FILE_INACTIVE'
          : cfg.runtime?.paused ? 'PRIVATE_FILE_PAUSED'
          : cfg.runtime?.mode !== 'active' ? 'PRIVATE_FILE_MODE_BLOCKED'
          : !chatAllowed(chatKey, cfg) ? 'PRIVATE_FILE_ACCESS_DENIED' : 'PRIVATE_FILE_BLOCKED';
        throw privateTextFileError(code);
      }
    };
    check();
    return this.#chain(chatKey)(async () => {
      check();
      if (this.store.getChatMeta(chatKey).held || (options.runId && this.store.hasUncertainEffects(options.runId))) {
        throw privateTextFileError('PRIVATE_FILE_HELD');
      }
      try { this.#checkRate(chatKey); } catch (error) {
        if (String(error?.message || '').startsWith('发送频率超限')) throw privateTextFileError('PRIVATE_FILE_RATE_LIMITED');
        throw error;
      }
      const data = await this.#deliver(chatKey, { ...options, gameScoped: false }, { type: 'file', name }, async () => {
        check();
        try {
          return await this.onebot.call('upload_private_file', { user_id: id, file, name }, 120000, options.signal);
        } catch (error) {
          // 协议端可能回显 file/正文，不能把原错误存进台账或 incident。
          // 私聊文件保守地不自动重试；仅保留原有 failed/unknown 定性供人工核对。
          const { definite, uncertain } = classifyTransportFailure(error);
          const outcome = error?.outcome === 'failed' || error?.outcome === 'unknown'
            ? error.outcome : (definite && !uncertain ? 'failed' : 'unknown');
          throw privateTextFileError(outcome === 'failed' ? 'PRIVATE_FILE_REJECTED' : 'PRIVATE_FILE_UNCONFIRMED');
        }
      });
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, { text: `[私聊文件]${name}`, ts: Date.now(),
          mid: data?.message_id ?? null, targetUserId: String(id), eventKind: 'message' });
        this.onSent?.({ chatKey, text: '[私聊文件]', messageId: data?.message_id ?? null });
      });
      return { file_id: data?.file_id ?? null, message_id: data?.message_id ?? null };
    });
  }

  /**
   * 往群里发一个文件（send_group_file 工具）：群聊限定。文件在群里可见，与发消息同类，
   * 同样走 #deliver（限频/禁言预检/outbox；上传 5xx 后的"结果未知"也能在控制台核对）。
   */
  groupFile(chatKey, { file, name }, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group') throw new Error('群文件只能发在群聊里');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      const data = await this.#deliver(chatKey, options, { type: 'file', name },
        () => this.onebot.call('upload_group_file', {
          group_id: Number(id), file, name
        }, 120000, options.signal));
      const ts = Date.now();
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, {
          text: `[群文件]${String(name || '').slice(0, 60)}`,
          ts,
          mid: data?.message_id ?? null,
          targetUserId: '',
          eventKind: 'message'
        });
        this.onSent?.({ chatKey, text: '[群文件]', messageId: data?.message_id ?? null });
      });
      return { file_id: data?.file_id ?? null, message_id: data?.message_id ?? null };
    });
  }

  /**
   * 把一张图传进群相册（upload_to_group_album 工具）：群聊限定、开关默认关。
   * 同样是"所有人都看得到"的写操作，走 #deliver —— 限频 / 禁言预检 / outbox
   * （上传 120 秒超时后的"结果未知"能在控制台核对，而不是只留在调用栈里）。
   */
  albumPhoto(chatKey, { file, albumId, albumName }, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group') throw new Error('群相册只能在群聊里操作');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      const data = await this.#deliver(chatKey, options, { type: 'album-photo', albumId },
        () => this.onebot.call('upload_image_to_qun_album', {
          group_id: Number(id), album_id: albumId, album_name: albumName || albumId, file
        }, 120000, options.signal));
      const ts = Date.now();
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, {
          text: `[群相册]上传了一张照片（${String(albumName || albumId).slice(0, 40)}）`,
          ts,
          mid: data?.message_id ?? null,
          targetUserId: '',
          eventKind: 'message'
        });
        this.onSent?.({ chatKey, text: '[群相册]', messageId: data?.message_id ?? null });
      });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 发送语音（本地合成的音频 → base64 record 段）。发送成功后留档，否则下次运行不知道自己发过语音。 */
  voice(chatKey, { file, seconds = 0, label = '' } = {}, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500));
      const data = await this.#deliver(chatKey, options, { type: 'voice', seconds }, () => this.onebot.sendRecord(kind, id, file, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null,
        signal: options.signal
      }));
      const ts = Date.now();
      let targetUserId = this.#replyTarget(chatKey, options);
      if (!targetUserId && kind === 'private') targetUserId = String(id);
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, {
        text: `[语音${seconds ? `${seconds}秒` : ''}:${String(label || '').slice(0, 40)}]`,
        ts,
        mid: data?.message_id ?? null,
        targetUserId,
        eventKind: 'message'
        });
      this.onSent?.({ chatKey, text: '[语音]', messageId: data?.message_id ?? null, voice: seconds });
      });      return { message_id: data?.message_id ?? null };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 与 sendTextBatch 同一道防线：上次发送结果 unknown 时停止后续发送。
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      await sleep(randInt(300, 900));
      const data = await this.#deliver(chatKey, options, { type: 'poke', targetUserId },
        () => this.onebot.sendPoke(kind, id, targetUserId, options.signal));
      const ts = Date.now();
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, {
        text: `[拍一拍] 你拍了拍${target}`,
        ts,
        mid: data?.message_id ?? null,
        targetUserId: String(targetUserId || (kind === 'private' ? id : '')),
        eventKind: 'poke'
        });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      });      return data;
    });
  }

  /** 发送一个 QQ 系统表情（小黄脸/汪汪这类）。face = { id, name }。 */
  sendFace(chatKey, face, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 与 sendTextBatch 同一道防线：上次发送结果 unknown 时停止后续发送。
      if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
      this.#checkRate(chatKey);
      await sleep(randInt(300, 900));
      const data = await this.#deliver(chatKey, options,
        { type: 'face', faceId: String(face?.id ?? ''), faceName: face?.name ?? '' },
        () => this.onebot.sendFace(kind, id, face?.id, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null,
          text: options.text ?? null,
          signal: options.signal
        }));
      const ts = Date.now();
      const label = (options.text ? String(options.text) : '') + (face?.name ? `[表情：${face.name}]` : `[表情：${face?.id ?? ''}]`);
      this.#afterSent(() => {
        this.store.appendSelf(chatKey, { text: label, ts, mid: data?.message_id ?? null, eventKind: 'face' });
      this.onSent?.({ chatKey, text: label, messageId: data?.message_id ?? null });
      });      return data;
    });
  }

  /** 改自己在群里的群名片。改完留档，下次运行模型才知道当前名片是什么。 */
  setCard(chatKey, card, { signal } = {}) {
    const [kind, id] = String(chatKey).split(':');
    const text = String(card ?? '').trim();
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (kind !== 'group') throw new Error('群名片只能在群聊里改');
      await this.#assertNotMuted(chatKey);
      this.#checkRate(chatKey);
      await sleep(randInt(300, 900));
      // 等待期间运行被中止：别再发出写入（工具侧传了 signal 就必须真的用上）
      signal?.throwIfAborted();
      const data = await this.onebot.setGroupCard(id, this.onebot.selfId, text, signal);
      // ⚠️ 与五条发送路径同口径：**改名片已经成功**，之后的记账失败不能把结果改判成失败
      //（2026-10-05 复审 P3：这条写路径漏了 #afterSent —— appendSelf 抛 disk full 时，
      //  工具会回"改群名片失败"，可名片其实已经改了，模型会以为没改成）。
      this.#afterSent(() => {
        const label = `[改群名片] 现在叫「${text}」`;
        this.store.appendSelf(chatKey, { text: label, ts: Date.now(), mid: null, eventKind: 'card' });
        this.onSent?.({ chatKey, text: label, messageId: null });
      });
      return data;
    });
  }
}
