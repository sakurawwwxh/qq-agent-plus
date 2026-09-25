// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig, DEFAULT_CONFIG } from '../core/config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from '../core/util.js';
import { mdToPlain, splitForQQ } from '../llm/md-to-plain.js';
import { assertCanSend } from '../core/access.js';

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
  const definite = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i.test(evidence);
  const uncertain = !definite
    && /timeout|timed out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|fetch failed|network|HTTP 5\d\d|Unexpected status code: 5\d\d/i.test(evidence);
  return { evidence, definite, uncertain };
}

/** 被禁言时报给模型的错误文案（模型当轮可见，可直接决定"先不发言"）。 */
function muteError(untilTs) {
  return untilTs
    ? `本群禁言中（预计 ${formatClockTime(untilTs)} 解除），本轮先不发言`
    : '本群全员禁言中，本轮先不发言';
}

export class SendQueue {
  constructor({ onebot, store, onSent = null, onIncident = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    this.onIncident = typeof onIncident === 'function' ? onIncident : () => {};
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
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
      if (cached.muted) throw new Error(muteError(cached.untilTs));
      return;
    }
    const entry = { muted: false, untilTs: 0, checkedAt: now };
    try {
      const groupId = chatKey.slice('group:'.length);
      const selfId = this.onebot.selfId;
      if (selfId) {
        // 优先查自己的成员信息：shut_up_timestamp = 禁言截止的 epoch 秒（0 = 未禁言）
        const info = await this.onebot.getGroupMemberInfo(groupId, selfId);
        const shut = Number(info?.shut_up_timestamp || 0);
        if (shut > now / 1000) { entry.muted = true; entry.untilTs = shut * 1000; }
      } else {
        // 拿不到自身 uin 时退查全员禁言标志
        const info = await this.onebot.getGroupInfo(groupId);
        if (Number(info?.group_all_shut || 0) > 0) entry.muted = true;
      }
    } catch { /* 查询失败不能阻塞正常发送 */ }
    this.#muteCache.set(chatKey, entry);
    if (entry.muted) throw new Error(muteError(entry.untilTs));
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

  #gap(text, isLast) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  async #deliver(chatKey, options, payload, send) {
    await this.#assertNotMuted(chatKey);
    assertCanSend(chatKey, options.signal);
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
          console.log(`[sender] 发送失败（可确认未送达），1.5 秒后重试一次（${message.slice(0, 80)}）`);
          await sleep(1500);
        }
      }
      this.store.finishSend(id, { messageId: data?.message_id });
      return data;
    } catch (error) {
      // 记账口径与重试判定一致：能证明没送达的算 failed（可被"重试失败批次"捞回来），
      // 其余算 unknown（持有待人工核对）。以前只看 error.outcome —— 那只在 OneBotActionError 上有，
      // 裸 fetch 失败永远落进 unknown：一次"连接被拒"会被记成 critical 未知写入、回复静默丢失。
      const { definite, uncertain } = classifyTransportFailure(error);
      const outcome = error?.outcome === 'failed' || error?.outcome === 'unknown'
        ? error.outcome
        : (definite && !uncertain ? 'failed' : 'unknown');
      this.store.finishSend(id, {
        error: error?.message ?? error,
        outcome
      });
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
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts = [];
    for (const m of list) {
      const plain = mdToPlain(String(m ?? ''), { preserveCode: options.preserveCode === true });
      if (!plain) continue;
      // 最后防线：任何上游畸形路径漏下来的 "[object Object]" 到这儿直接拦掉，
      // 用户永远不该在 QQ 里看到这串字符。全被拦 → 下方抛"消息内容为空"回给模型。
      if (/^\[object Object\]$/.test(plain)) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const promises = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      const gap = this.#gap(text, isLast);
      promises.push(chain(async () => {
        assertCanSend(chatKey, options.signal);
        if (options.runId && this.store.hasUncertainEffects(options.runId)) throw new Error('Previous send delivery is uncertain');
        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);
        const data = await this.#deliver(chatKey, options, { type: 'text', text }, () => this.onebot.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null,
          signal: options.signal
        }));
        const ts = Date.now();
        let targetUserId = String(options.atUserId || '');
        if (!targetUserId && options.replyToMessageId != null) {
          const replied = this.store.findByMid(chatKey, options.replyToMessageId);
          if (replied && !replied.self) targetUserId = String(replied.senderId || '');
        }
        if (!targetUserId && kind === 'private') targetUserId = String(id);
        this.store.appendSelf(chatKey, {
          text,
          ts,
          mid: data?.message_id ?? null,
          targetUserId,
          eventKind: 'message'
        });
        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
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
      if (sent.length === 0) throw new Error(detail);
      console.warn(`[sender] 部分发送失败（${failed.length}/${parts.length}）：${detail}`);
    }
    return { sent, failed };
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
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      const data = await this.#deliver(chatKey, options, { type: 'sticker', id: sticker.id }, () => this.onebot.sendSticker(kind, id, sticker.url, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null,
        signal: options.signal
      }));
      const ts = Date.now();
      let targetUserId = String(options.atUserId || '');
      if (!targetUserId && options.replyToMessageId != null) {
        const replied = this.store.findByMid(chatKey, options.replyToMessageId);
        if (replied && !replied.self) targetUserId = String(replied.senderId || '');
      }
      if (!targetUserId && kind === 'private') targetUserId = String(id);
      this.store.appendSelf(chatKey, {
        text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`,
        ts,
        mid: data?.message_id ?? null,
        targetUserId,
        eventKind: 'message'
      });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      return { message_id: data?.message_id ?? null };
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
      this.store.appendSelf(chatKey, {
        text: `[拍一拍] 你拍了拍${target}`,
        ts,
        mid: data?.message_id ?? null,
        targetUserId: String(targetUserId || (kind === 'private' ? id : '')),
        eventKind: 'poke'
      });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
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
      this.store.appendSelf(chatKey, { text: label, ts, mid: data?.message_id ?? null, eventKind: 'face' });
      this.onSent?.({ chatKey, text: label, messageId: data?.message_id ?? null });
      return data;
    });
  }
}
