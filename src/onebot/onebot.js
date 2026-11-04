// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText, formatQuoteRef } from '../core/util.js';
// QQ 系统表情对照表（离线导出表 + 协议端在线目录）在 face-catalog.js 里统一维护：
// 「[表情14]」渲染成「[表情14 微笑]」用它取名；send_face 的中文名 → 编号也读同一份。
import { faceNameOf, refreshFaceCatalog } from './face-catalog.js';
import { readJsonBounded } from '../core/http-body.js';

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;
// 心跳默认间隔。心跳的用途是发现"连接已经死了但 close 事件还没到"（半开连接），
// 不是所有实现都会回 pong —— 见下面 PING_KILL_WINDOW_MS 与 heartbeat 模式。
const HEARTBEAT_MS = 30000;
// "对端不吃 ping"的判定窗口：发出 ping 之后这么久内连接就断了、且这条连接从未回过 pong，
// 认定为对端把 PING 当断连信号（NapCat 4.18.x 的实测行为，Issue #22：发 ping 的同一瞬间
// close code=1006、全程 0 次 pong）。2 秒足够覆盖"同一次事件循环里就被销毁"的情形，
// 又不会把正常断线误判 —— 正常对端早就回过 pong 了。
const PING_KILL_WINDOW_MS = 2000;
const HEARTBEAT_MODES = new Set(['auto', 'on', 'off']);
// 发送超时：文本类 15 秒够用；**语音/图片这类要协议端转码或上传的段**很慢 ——
// 2026-09-29 实测一条 38KB（7 秒）的 mp3 走 send_private_msg 要 16.4 秒，正好卡在 15 秒
// 超时线上，于是模型发了语音却被记成 unknown（超时≠没发出去，但也确实可能没发出去）。
// 给媒体段留足余量，宁可等久一点也不要"发没发出去说不清"。
const TEXT_TIMEOUT_MS = 15000;
const MEDIA_TIMEOUT_MS = 60000;
// HTTP 请求体的安全上限。实测 SnowLuma 1.14.15 的 OneBot HTTP 端点对 body 有 ≈2MiB 的
// 硬上限：超过后服务端在 100-Continue 之后直接掐断连接（bot 侧表现为 undici
// "fetch failed"，真因 cause 是连接被重置）—— 生成贴纸发送是整张图的 base64，很容易
// 压线，这就是 Issue #21 "图发不出去、时好时坏" 的根因。超过阈值的请求自动改走
// WebSocket 通道（生产实测 1–14MB 帧全部正常应答，而贴纸链路的理论最大值
// ≈10.7MiB = 8MiB 原始图 × 4/3，在实测范围内且留有余量），其余流量保持原 HTTP 路线不动。
const HTTP_BODY_SAFE_MAX = 1536 * 1024;

/**
 * 图片消息段（贴纸与普通图片共用）：reply/at 校验只在一处维护。
 * asSticker=true 时带 sub_type/summary，让 QQ 按表情样式渲染；false 就是普通图片（可保存）。
 */
function imageMessageSegments(kind, imageUrl, { replyToMessageId = null, atUserId = null, asSticker = true } = {}) {
  const segments = [];
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const rid = String(replyToMessageId).trim();
    if (!/^-?[1-9]\d*$/.test(rid)) {
      throw new OneBotActionError('replyToMessageId 必须是非零整数', {
        action: kind === 'private' ? 'send_private_msg' : 'send_group_msg',
        outcome: 'failed'
      });
    }
    segments.push({ type: 'reply', data: { id: rid } });
  }
  if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
    const at = String(atUserId).trim();
    if (!/^\d+$/.test(at)) {
      throw new OneBotActionError('atUserId 必须是正整数 QQ 号，且不能为 all', {
        action: kind === 'private' ? 'send_private_msg' : 'send_group_msg',
        outcome: 'failed'
      });
    }
    segments.push({ type: 'at', data: { qq: at } });
  }
  segments.push({
    type: 'image',
    data: asSticker
      ? { file: String(imageUrl), sub_type: 1, summary: '[动画表情]' }
      : { file: String(imageUrl) }
  });
  return segments;
}

export class OneBotActionError extends Error {
  constructor(message, {
    action = '',
    outcome = 'unknown',
    retcode = null,
    httpStatus = null,
    cause
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OneBotActionError';
    this.action = action;
    this.outcome = outcome;
    this.retcode = retcode;
    this.httpStatus = httpStatus;
  }
}

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent, heartbeat = 'auto', heartbeatMs = HEARTBEAT_MS }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    // auto：第一次遇到"发 ping 就被断开"的对端后不再发 ping（NapCat，Issue #22）；
    // on：始终发；off：从不发。非法值一律按 auto（与配置里别的枚举字段同一套兜底口径）。
    this.heartbeatMode = HEARTBEAT_MODES.has(String(heartbeat)) ? String(heartbeat) : 'auto';
    this.heartbeatMs = Number(heartbeatMs) > 0 ? Number(heartbeatMs) : HEARTBEAT_MS;
    this.pingUnsupported = false;   // 本进程内"这个对端不吃 ping"的记忆（换协议端/升级后重启即忘）
    this.pongsSeen = 0;             // 当前连接的 pong 计数（只有一条连接是"当前"，用实例字段即可）
    this.lastPingAt = 0;
    // 入站新鲜度：协议端可能"连接还在、事件停了"（半开连接、上游卡死、账号被踢）。
    // 只看 connected 会把这种情况当成正常；巡检与控制台拿这两个时间判断"是不是早就不动了"。
    this.lastEventAt = 0;
    this.lastHeartbeatAt = 0;
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    // WS 调用通道：echo 序号 + 在途请求表（见 callViaWs）。只挂"当前 socket"的请求；
    // 断线/重连时由 #failAllWsPending 统一按 unknown 结清，不会挂着等超时。
    this.wsEchoSeq = 0;
    this.wsPending = new Map();
    this.#closedByUs = false;
    this.statusListeners = new Set();
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectAttempt = 0;
  }

  #closedByUs;

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  async connect() {
    this.#closedByUs = false;
    // 重入不许留下孤儿连接：第二次 connect（或 close 后重连定时器尚在时手动 connect）
    // 会把 this.socket 换成新 socket，旧 socket 的迟到事件全被 isCurrent 拦掉 ——
    // 它没有心跳、不会重连、也永远不会被 terminate，一直连着协议端静默丢事件。
    const old = this.socket;
    if (old) {
      this.socket = null;
      try { old.terminate(); } catch { /* ignore */ }
    }
    clearTimeout(this.reconnectTimer);
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.#closedByUs = false;
    // 连接态必须同步作废：新 socket 还在 CONNECTING 的握手窗口里 this.connected 若仍为 true，
    // callViaWs 会把大请求交给一个非 OPEN 的 socket —— ws 对 CONNECTING 是同步 throw，
    // 抛出去的是无 outcome 的裸 Error，会被记账成 unknown/critical 人工核对，
    // 而这一帧其实确定没发出去。顺手清掉上一轮的 ping 归因残留，避免误标"对端不吃 ping"。
    this.#setStatus(false);
    this.lastPingAt = 0;
    this.pongsSeen = 0;
    this.selfPingKill = false;
    try { old?.terminate(); } catch { /* ignore */ }
    this.#failAllWsPending('OneBot WebSocket 正在重连');
    this.#connectLoop();
  }

  /** lastConnectError 出口（控制台状态页/ops 巡检）不许携带 accessToken（退化 URL 报错会把原样 URL 带出来）。 */
  #redactToken(text) {
    const raw = String(text ?? '');
    return this.accessToken ? raw.split(this.accessToken).join('***') : raw;
  }

  #connectLoop() {
    if (this.#closedByUs) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {},
        handshakeTimeout: 15000
      });
    } catch (error) {
      this.lastConnectError = this.#redactToken(error?.message ?? error);
      this.#setStatus(false);
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;
    // 每个 socket 的事件处理器都先验证“我还是不是当前 socket”，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.reconnectAttempt = 0;
      // 已排的重连定时器必须作废：否则它稍后触发会再建一个连接并把它设为当前，
      // 把这条刚连上、带着心跳的 socket 变成没人认领的孤儿。
      clearTimeout(this.reconnectTimer);
      this.#startHeartbeat(socket);
      this.#setStatus(true);
      // 2026-10-06 复审 P2：selfInfo 全仓库只有这一处赋值，首连恰好失败一次（NapCat 重启
      // 竞态、HTTP 端瞬时不可达）就 selfId 恒空 —— 被艾特判定恒 false（degrade 模式下整体
      // 装死）、自己发的 message_sent 被当群友消息（有自回复循环风险）。带退避重试；
      // 连续失败则挂 60 秒单发重试直到拿到或连接失效（isCurrent 兜住旧 socket 迟到回调）。
      // 每次重连都重新拉：协议端可能在 noVNC 里换了 QQ，沿用旧 selfId 会让 Qzone/日报的
      // 账号绑定闸门误判成同一账号，用新登录去执行旧账号的待办（公开写错号）。
      const previousSelfId = this.selfId;
      this.selfInfo = null;
      const fetchLoginInfo = async (attempt) => {
        if (!isCurrent(socket)) return;
        try {
          const info = await this.call('get_login_info');
          if (!isCurrent(socket)) return;
          if (!info || typeof info !== 'object' || info.user_id == null) {
            throw new Error('get_login_info 返回空');
          }
          this.selfInfo = info;
          if (previousSelfId && String(info.user_id) !== previousSelfId) {
            console.warn(`[onebot] 登录账号已变化：${previousSelfId} -> ${info.user_id}`);
          }
        } catch (error) {
          if (attempt >= 10) {
            console.error(`[onebot] 获取登录信息已连续失败 ${attempt} 次，60 秒后继续重试:`, error?.message ?? error);
            setTimeout(() => { fetchLoginInfo(1); }, 60000).unref?.();
            return;
          }
          await new Promise((resolve) => { setTimeout(resolve, Math.min(2000 * attempt, 8000)).unref?.(); });
          return fetchLoginInfo(attempt + 1);
        }
      };
      await fetchLoginInfo(1);
      // 表情目录补缺（fetch_sys_faces）：离线导出表是某次快照，新表情只有线上有。
      // 每进程只试一次、失败静默，不阻塞建联（face-catalog.js 内部处理）。
      refreshFaceCatalog(this)
        .then((added) => { if (added) console.log('[onebot] 系统表情目录已并入在线补缺'); })
        .catch(() => {});
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      // 每个 OneBot 事件都带当前登录号：get_login_info 还没回来时先用它兜底，
      // 换号重连也不会继续拿旧 selfId 判“自己发的消息/账号绑定”。
      if (frame.self_id != null) {
        const eventSelfId = String(frame.self_id).trim();
        if (eventSelfId && eventSelfId !== this.selfId) {
          const previous = this.selfId;
          this.selfInfo = { ...(this.selfInfo || {}), user_id: eventSelfId };
          if (previous) {
            this.selfInfo.nickname = '';
            console.warn(`[onebot] 登录账号已变化：${previous} -> ${eventSelfId}`);
          }
        }
      }
      // 带 echo 且命中在途表的帧是 WS 调用的响应，先于事件分发结清（callViaWs）。
      // echo 由本进程生成（ws_<序号>），事件帧不会带，不存在误吞。
      if (frame.echo !== undefined && this.wsPending.has(frame.echo)) {
        const pending = this.wsPending.get(frame.echo);
        this.wsPending.delete(frame.echo);
        clearTimeout(pending.timer);
        if (pending.cleanupAbort) pending.cleanupAbort();
        pending.resolve(frame);
        return;
      }
      try { this.onEvent(frame); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
      // 只改时间戳，不拦截事件：新鲜度是"观测"，不是门禁。
      this.lastEventAt = Date.now();
      if (frame.post_type === 'meta_event' && frame.meta_event_type === 'heartbeat') {
        this.lastHeartbeatAt = this.lastEventAt;
      }
    });
    socket.on('close', (code, reasonBuffer) => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      clearInterval(this.heartbeatTimer);
      // 在途 WS 调用立即按 unknown 结清：连接都没了，等超时是白等（挂起方可能正拿着
      // 租约等这个结果）。
      this.#failAllWsPending('OneBot WebSocket 连接已断开');
      const wasConnected = this.connected;
      const reason = String(reasonBuffer || '').trim();
      // selfPingKill：上一拍 ping 后 30 秒没等到 pong，我们自己掐的（见 #startHeartbeat）。
      // 它同样要计入"对端不吃 ping"的归因 —— 否则"从不回 pong 也不主动断"的实现
      // 会被我们每 60 秒自杀一次、日志里却看不出任何原因。
      const killedByPing = this.selfPingKill === true
        || (this.lastPingAt > 0
          && Date.now() - this.lastPingAt <= PING_KILL_WINDOW_MS
          && this.pongsSeen === 0);
      this.selfPingKill = false;
      if (killedByPing && this.heartbeatMode === 'auto' && !this.pingUnsupported) {
        this.pingUnsupported = true;
        console.warn('[onebot] 对端在收到 WebSocket PING 后立即断开（NapCat 已知行为，见 Issue #22）：'
          + '本次运行不再发心跳 ping，改用 close/error 事件发现断线。要强制恢复发送，把 onebot.wsHeartbeat 设为 on');
      }
      this.#setStatus(false);
      // 首次连不上时不打日志（沿用"首连失败不刷屏"的约定，控制台状态行里已经有原因）；
      // "连上过再断"这条正是 Issue #22 里最难查的情形 —— 必须留下痕迹。
      if (wasConnected) {
        console.warn(`[onebot] 连接已断开（code=${code}${reason ? `, reason=${reason}` : ''}${killedByPing ? ', 紧随 PING 之后' : ''}）`);
      }
      if (!this.#closedByUs) this.#scheduleReconnect();
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = this.#redactToken(error?.message ?? error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      } else {
        console.warn(`[onebot] WebSocket 错误：${this.lastConnectError}`);
      }
    });
  }

  /**
   * 心跳：默认 30 秒一次 ping，超时未回 pong 就 terminate（发现半开连接）。
   * auto 模式下，一旦这条连接被判定为"对端不吃 ping"，后续连接直接不发 —— 每次连接都
   * 重新判断，但"不吃 ping"的记忆在本进程内保留（见 pingUnsupported）。
   */
  #startHeartbeat(socket) {
    const isCurrent = (s) => this.socket === s;
    if (this.heartbeatMode === 'off' || (this.heartbeatMode === 'auto' && this.pingUnsupported)) {
      this.lastPingAt = 0;
      return;
    }
    let alive = true;
    this.pongsSeen = 0;
    socket.on('pong', () => { alive = true; this.pongsSeen += 1; });
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!isCurrent(socket)) return;
      if (!alive) {
        // 30 秒没等到 pong：半开连接，或对端从不回 pong。留一行日志再掐 ——
        // 归因（pingUnsupported）交给 close 处理器用 selfPingKill 判定，
        // 否则这条路径既没日志也学不到"不吃 ping"，只会每 60 秒无声地自掐重连。
        console.warn('[onebot] 心跳 30 秒未收到 PONG，掐掉连接重连（对端可能不响应 ping）');
        this.selfPingKill = true;
        socket.terminate();
        return;
      }
      alive = false;
      this.lastPingAt = Date.now();
      socket.ping();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  close() {
    this.#closedByUs = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    const old = this.socket;
    this.socket = null;
    try { old?.terminate(); } catch { /* ignore */ }
    this.#failAllWsPending('OneBot WebSocket 已关闭');
    this.#setStatus(false);
  }

  #scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.reconnectAttempt++, 4));
    // 断线后"多久重连"也写进日志：Issue #22 里用户只能靠 catchup 计数反推断线循环，
    // 有这两行（断开 + 重连）就能直接从日志看出来。
    console.warn(`[onebot] ${Math.round(delay / 1000)} 秒后重连`);
    this.reconnectTimer = setTimeout(() => this.#connectLoop(), delay);
    this.reconnectTimer.unref?.();
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = TEXT_TIMEOUT_MS, signal) {
    // 超大请求体改走 WS（见 HTTP_BODY_SAFE_MAX 处的注释）。WS 未连接时回落 HTTP：
    // 新版协议端可能已放宽上限，保持今天的网络行为，比直接拒绝好。
    const bodyJson = JSON.stringify(params);
    if (Buffer.byteLength(bodyJson) > HTTP_BODY_SAFE_MAX) {
      // readyState 门禁：只有真正 OPEN 的 socket 才配接大请求 —— CONNECTING 时 ws 的
      // send() 是同步 throw（裸 Error、无 outcome），CLOSING/CLOSED 才走回调报错。
      if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
        return this.callViaWs(action, params, timeoutMs, signal);
      }
      console.warn(`[onebot] ${action} 请求体 ${Math.round(Buffer.byteLength(bodyJson) / 10485.76) / 100}MB 超过 HTTP 安全阈值且 WS 未连接，仍走 HTTP（可能被协议端掐断）`);
    }
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
      },
      body: bodyJson,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const hint = res.status === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 onebot.httpUrl）'
        : '';
      // 4xx = 请求被对方拒绝（令牌错、参数错、路径错、被限频），可以确定没有投递，
      // 不能标成 unknown —— 那会把整批消息压成 held 等人工核对。
      // 5xx / 网络中断才是真正"不知道对方有没有收到"。
      throw new OneBotActionError(`OneBot ${action} HTTP ${res.status}${hint}`, {
        action,
        outcome: res.status >= 400 && res.status < 500 ? 'failed' : 'unknown',
        httpStatus: res.status
      });
    }
    let body;
    try {
      // 有界读（8MB）：成员/文件列表这类响应可以很大，但绝不无上限（2026-10-09 审查）
      body = await readJsonBounded(res, 8 * 1024 * 1024);
    } catch (cause) {
      throw new OneBotActionError(
        cause?.code === 'BODY_TOO_LARGE'
          ? `OneBot ${action} 响应过大（超过 8MB 上限）`
          : `OneBot ${action} 返回了无法解析的响应`,
        {
          action,
          outcome: 'unknown',
          httpStatus: res.status,
          cause
        }
      );
    }
    // fail-closed：给了 status 就按 status 判（failed 一律算失败），只有没有 status 时才看 retcode。
    // 原来写成 `status !== 'ok' && status !== 'async' && retcode !== 0`，于是
    // {status:'failed', retcode:0} 这种自相矛盾的响应会被当成成功，消息没发却记为 sent。
    const statusFailed = body.status != null && body.status !== 'ok' && body.status !== 'async';
    const retcodeFailed = body.status == null && body.retcode != null && Number(body.retcode) !== 0;
    if (statusFailed || retcodeFailed) {
      throw new OneBotActionError(
        `OneBot ${action} 失败: retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`,
        {
          action,
          outcome: 'failed',
          retcode: body.retcode ?? body.status,
          httpStatus: res.status
        }
      );
    }
    return body.data;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind, id, segments, signal, { timeoutMs = TEXT_TIMEOUT_MS } = {}) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params, timeoutMs, signal);
  }

  async sendText(kind, id, text, options = {}) {
    return this.sendRichText(kind, id, [{ type: 'text', text: String(text ?? '') }], options);
  }

  /**
   * 发送带结构化段的消息（文本 / at）。给正文里的 @昵称 转真实 at 段用：
   * 文本段统一过 escapeCqText，at 段只接受数字 QQ 号。
   */
  async sendRichText(kind, id, parts, { replyToMessageId = null, atUserId = null, signal } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) {
        throw new OneBotActionError('replyToMessageId 必须是非零整数（消息 id 可能为负数）', {
          action: kind === 'private' ? 'send_private_msg' : 'send_group_msg',
          outcome: 'failed'
        });
      }
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) {
        throw new OneBotActionError('atUserId 必须是正整数 QQ 号，且不能为 all', {
          action: kind === 'private' ? 'send_private_msg' : 'send_group_msg',
          outcome: 'failed'
        });
      }
      segments.push({ type: 'at', data: { qq: at } });
    }
    for (const part of Array.isArray(parts) ? parts : []) {
      if (part?.type === 'at') {
        const qq = String(part.qq ?? '').trim();
        if (!/^\d+$/.test(qq)) continue;
        segments.push({ type: 'at', data: { qq } });
      } else if (typeof part?.text === 'string') {
        segments.push({ type: 'text', data: { text: escapeCqText(part.text) } });
      }
    }
    return this.sendSegments(kind, id, segments, signal);
  }

  /**
   * 与 call() 同语义的 WebSocket 调用通道。专门给超大请求体用：HTTP 端点有 body 上限
   * （SnowLuma 1.14.15 实测 ≈2MiB，超限直接掐连接，见 HTTP_BODY_SAFE_MAX），而贴纸发送
   * 是整张图 base64，很容易压线（Issue #21）。WS 是事件常驻连接，生产实测 1–14MB 帧全部
   * 正常应答（覆盖贴纸链路的理论最大值 ≈10.7MiB 并留有余量）。
   * echo 结清、超时、abort、断线结清的口径与 call() 完全一致：4xx 类明确失败，
   * 其余（断线/超时）一律 unknown —— "不知道对方收没收到"。
   */
  callViaWs(action, params = {}, timeoutMs = TEXT_TIMEOUT_MS, signal) {
    const socket = this.socket;
    if (!socket || !this.connected || socket.readyState !== WebSocket.OPEN) {
      // WS 通道不可用 = 这一帧确定没有写进任何连接，按 failed 结清（可重试）；
      // 不能标 unknown —— 那会升级成 critical 人工核对，而这里根本没有"可能已投递"。
      return Promise.reject(new OneBotActionError(`OneBot WebSocket 未连接，无法经 WS 发送 ${action}`, {
        action,
        outcome: 'failed'
      }));
    }
    const echo = `ws_${++this.wsEchoSeq}`;
    return new Promise((resolve, reject) => {
      const pending = { action, resolve, reject, timer: null, cleanupAbort: null };
      pending.timer = setTimeout(() => {
        this.wsPending.delete(echo);
        if (pending.cleanupAbort) pending.cleanupAbort();
        reject(new OneBotActionError(`OneBot ${action} WS 响应超时（${timeoutMs}ms）`, {
          action,
          outcome: 'unknown'
        }));
      }, timeoutMs);
      if (pending.timer.unref) pending.timer.unref();
      if (signal) {
        const onAbort = () => {
          clearTimeout(pending.timer);
          this.wsPending.delete(echo);
          reject(signal.reason ?? new Error('Run cancelled'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }
      this.wsPending.set(echo, pending);
      socket.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err) {
          // send 回调报错 = 帧确定没写进 socket（readyState 非 OPEN）—— 这是"确定未投递"，
          // 按 failed 结清走自动重试，与 sender.classifyTransportFailure 对 ECONNREFUSED 的
          // 口径一致；不能压成 unknown（那会升级成 critical 人工核对 + 消息 held）。
          // 超时与断线才是"结果未知"，维持 unknown。
          clearTimeout(pending.timer);
          this.wsPending.delete(echo);
          if (pending.cleanupAbort) pending.cleanupAbort();
          reject(new OneBotActionError(`OneBot ${action} WS 发送失败: ${err?.message ?? err}`, {
            action,
            outcome: 'failed'
          }));
        }
      });
    }).then((frame) => {
      // fail-closed 口径与 call() 逐字一致：给了 status 就按 status 判，没有 status 才看 retcode。
      const statusFailed = frame.status != null && frame.status !== 'ok' && frame.status !== 'async';
      const retcodeFailed = frame.status == null && frame.retcode != null && Number(frame.retcode) !== 0;
      if (statusFailed || retcodeFailed) {
        throw new OneBotActionError(
          `OneBot ${action} 失败: retcode=${frame.retcode ?? frame.status} ${frame.wording ?? ''}`,
          { action, outcome: 'failed', retcode: frame.retcode ?? frame.status }
        );
      }
      return frame.data;
    });
  }

  /** 断线/重连/主动关闭时把所有在途 WS 调用按 unknown 结清（ 与 HTTP 的"不知道收没收到"同口径）。 */
  #failAllWsPending(reason) {
    for (const pending of this.wsPending.values()) {
      clearTimeout(pending.timer);
      if (pending.cleanupAbort) pending.cleanupAbort();
      pending.reject(new OneBotActionError(`${reason}，${pending.action} 投递状态未知`, {
        action: pending.action,
        outcome: 'unknown'
      }));
    }
    this.wsPending.clear();
  }

  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null, signal } = {}) {
    // sub_type/summary 是「按表情样式发出」的呈现元数据：QQ 只有拿到它们才把这张图渲染成
    // 表情（否则就是普通图片，用户 2026-10-07 反馈的"发表情包变图片"）；SnowLuma ≥1.14.20 的上传
    // 管线才把它们真正带上线（群里 extData、私聊 bytesPbReserveC2c），旧版忽略、不报错。
    const segments = imageMessageSegments(kind, imageUrl, { replyToMessageId, atUserId, asSticker: true });
    return this.sendSegments(kind, id, segments, signal, { timeoutMs: MEDIA_TIMEOUT_MS });
  }

  /** 普通图片（不带表情标记，群友可直接保存）。生成图按配置走这里（issue #67）。 */
  async sendImage(kind, id, imageUrl, { replyToMessageId = null, atUserId = null, signal } = {}) {
    const segments = imageMessageSegments(kind, imageUrl, { replyToMessageId, atUserId, asSticker: false });
    return this.sendSegments(kind, id, segments, signal, { timeoutMs: MEDIA_TIMEOUT_MS });
  }

  /**
   * 私聊「正在输入…」。QQ 只有 1v1 会显示输入状态（群聊没有这个概念），
   * 所以 kind !== 'private' 直接 no-op；调用方一律 best-effort，失败不影响正常发送。
   */
  async setInputStatus(kind, id, typing = true, signal) {
    if (kind !== 'private') return null;
    return this.call('set_input_status', { user_id: Number(id), event_type: typing ? 1 : 0 }, 8000, signal);
  }

  /**
   * 给一条消息贴「表情回应」（对方消息下方会多一个表情）。emoji_id 用 QQ 系统表情编号
   * （与 send_face 同一套编号，如 128077 是 👍 那批新表情里的；经典小黄脸用 0~103 的编号）。
   */
  async reactToMessage(messageId, emojiId, set = true, signal) {
    return this.call('set_msg_emoji_like', {
      message_id: Number(messageId),
      emoji_id: String(emojiId),
      set: set === true
    }, 15000, signal);
  }

  /**
   * 发送合并转发（「聊天记录」卡片）。nodes 是 OneBot 的 node 段数组：
   *   [{ type: 'node', data: { user_id?, nickname, content: [{ type: 'text', data: { text } }] } }]
   * user_id 省略时协议端按机器人自己的账号兜底（SnowLuma 对伪造节点的宽松约定）。
   */
  async sendForwardMsg(kind, id, nodes, { signal } = {}) {
    const params = kind === 'private'
      ? { message_type: 'private', user_id: Number(id), messages: nodes }
      : { message_type: 'group', group_id: Number(id), messages: nodes };
    return this.call('send_forward_msg', params, MEDIA_TIMEOUT_MS, signal);
  }

  /** 把一条消息标为已读（协议端按消息自行判定群/私聊）。 */
  async markMessageRead(messageId, { signal } = {}) {
    return this.call('mark_msg_as_read', { message_id: Number(messageId) }, 15000, signal);
  }

  /**
   * QQ 内置语音角色目录（send_qq_voice 与控制台「音色」下拉共用，wire 形状只留一处）。
   * 协议端按分类返回 [[{type, characters:[{character_id, character_name}]}]]，这里展平为
   * [{characterId, name, category}]；同一个音色可能出现在多个分类里（协议端就是这么分的）。
   */
  async getAiCharacters(groupId, { signal } = {}) {
    const list = await this.call('get_ai_characters', { group_id: Number(groupId) }, 20000, signal);
    const flat = [];
    for (const group of (Array.isArray(list) ? list : [])) {
      for (const ch of (group?.characters ?? [])) {
        const characterId = String(ch?.character_id ?? '').trim();
        if (!characterId) continue;
        flat.push({
          characterId,
          name: String(ch?.character_name ?? '').trim(),
          category: String(group?.type ?? '').trim()
        });
      }
    }
    return flat;
  }

  /**
   * 换 QQ 头像（账号级，所有人都看得到）。file 是"图片源"：http(s) 直链、base64:// 或
   * 协议端能读到的本地路径（SnowLuma 的 image 字段三种都收）。
   */
  async setAvatar(file, { signal } = {}) {
    const source = String(file ?? '').trim();
    if (!source) throw new OneBotActionError('头像图片源不能为空', { action: 'set_qq_avatar', outcome: 'failed' });
    return this.call('set_qq_avatar', { file: source }, 60000, signal);
  }

  /**
   * 改 QQ 资料（昵称 / 个性说明 / 性别）。只带传进来的字段：没传的字段协议端不动。
   * 改昵称后要 refreshSelfInfo()，否则 @我 判定与提示词还在用旧名字。
   */
  async setProfile({ nickname, personalNote, sex } = {}, { signal } = {}) {
    const params = {};
    if (nickname !== undefined && nickname !== null && String(nickname).trim() !== '') params.nickname = String(nickname).trim();
    if (personalNote !== undefined && personalNote !== null) params.personal_note = String(personalNote);
    if (sex !== undefined && sex !== null && sex !== '') params.sex = Number(sex);
    if (!Object.keys(params).length) {
      throw new OneBotActionError('昵称 / 个性说明 / 性别至少要给一项', { action: 'set_qq_profile', outcome: 'failed' });
    }
    return this.call('set_qq_profile', params, 20000, signal);
  }

  /**
   * 重新拉一次登录信息。改过昵称之后必须刷新：@我 判定、提示词里的"你在群里的名字"、
   * 自己贴的表情回应去重都读 selfInfo/selfNickname（2026-10-07 换头像/改资料接入）。
   * 拉不到就沿用旧值（不能让一次刷新失败把已知身份清空）。
   */
  async refreshSelfInfo() {
    try {
      const info = await this.call('get_login_info', {}, 15000);
      if (info && typeof info === 'object') this.selfInfo = info;
    } catch { /* 沿用旧 selfInfo */ }
    return this.selfInfo;
  }

  async sendFace(kind, id, faceId, { replyToMessageId = null, atUserId = null, text = null, signal } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) {
        throw new OneBotActionError('replyToMessageId 必须是非零整数', {
          action: kind === 'private' ? 'send_private_msg' : 'send_group_msg',
          outcome: 'failed'
        });
      }
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) {
        throw new OneBotActionError('atUserId 必须是正整数 QQ 号，且不能为 all', {
          action: kind === 'private' ? 'send_private_msg' : 'send_group_msg',
          outcome: 'failed'
        });
      }
      segments.push({ type: 'at', data: { qq: at } });
    }
    if (text !== undefined && text !== null && String(text).trim() !== '') {
      segments.push({ type: 'text', data: { text: escapeCqText(String(text)) } });
    }
    segments.push({ type: 'face', data: { id: String(faceId) } });
    return this.sendSegments(kind, id, segments, signal);
  }

  async sendPoke(kind, id, targetUserId, signal) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }, 15000, signal);
    }
    if (!/^\d+$/.test(String(targetUserId ?? '').trim())) {
      throw new OneBotActionError('群聊拍一拍需要有效的目标 QQ 号', {
        action: 'group_poke',
        outcome: 'failed'
      });
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }, 15000, signal);
  }

  /** 发送语音（record 段）。file 支持 base64://（本地合成结果）或协议端可取的 URL/路径。 */
  async sendRecord(kind, id, file, { replyToMessageId = null, atUserId = null, signal } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) {
        throw new OneBotActionError('replyToMessageId 必须是非零整数', {
          action: kind === 'private' ? 'send_private_msg' : 'send_group_msg',
          outcome: 'failed'
        });
      }
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) {
        throw new OneBotActionError('atUserId 必须是正整数 QQ 号，且不能为 all', {
          action: kind === 'private' ? 'send_private_msg' : 'send_group_msg',
          outcome: 'failed'
        });
      }
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'record', data: { file: String(file) } });
    // 语音是最慢的一段（协议端要转码 + 上传）：用媒体超时，别用文本那份
    return this.sendSegments(kind, id, segments, signal, { timeoutMs: MEDIA_TIMEOUT_MS });
  }

  /** 群成员名单（OneBot v11 标准接口；大群协议端可能只给缓存，noCache 可强刷）。 */
  async getGroupMemberList(groupId, { noCache = false } = {}) {
    return this.call('get_group_member_list', { group_id: Number(groupId), no_cache: noCache === true });
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }

  async setGroupCard(groupId, userId, card, signal) {
    // 与 sendPoke 等写动作同款：把调用方的 signal 一路带下去，运行中止时不再发出写入
    //（2026-10-05 复审：原先签名没有 signal，工具侧传了也被静默丢掉）。
    return this.call('set_group_card',
      { group_id: Number(groupId), user_id: Number(userId), card: String(card ?? '') },
      TEXT_TIMEOUT_MS, signal);
  }

  async setGroupBan(groupId, userId, durationSeconds, signal) {
    return this.call('set_group_ban',
      { group_id: Number(groupId), user_id: Number(userId), duration: Math.max(0, Number(durationSeconds) || 0) },
      TEXT_TIMEOUT_MS, signal);
  }

  async kickGroupMember(groupId, userId, rejectAddRequest = false, signal) {
    return this.call('set_group_kick',
      { group_id: Number(groupId), user_id: Number(userId), reject_add_request: rejectAddRequest === true },
      TEXT_TIMEOUT_MS, signal);
  }

  async deleteMessage(messageId, signal) {
    return this.call('delete_msg', { message_id: Number(messageId) }, TEXT_TIMEOUT_MS, signal);
  }

  async setGroupAdmin(groupId, userId, enable, signal) {
    return this.call('set_group_admin',
      { group_id: Number(groupId), user_id: Number(userId), enable: enable === true },
      TEXT_TIMEOUT_MS, signal);
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null —— 解析引用原文。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 */
/**
 * 分享卡片（OneBot 的 json / xml 段）→ 可读文本。
 *
 * 群里转发说说、公众号文章、音乐时都是这两种段；旧实现只输出「[卡片消息]」，
 * 模型既看不到内容，也认不出"这是我自己空间动态被转进来了"。
 * 这里把常见字段抽出来，并在卡片作者就是机器人自己时标注「你自己的动态」。
 */
export function cardToText(seg, selfId = '') {
  const d = seg?.data ?? {};
  const raw = typeof d.data === 'string'
    ? d.data
    : (d.data && typeof d.data === 'object' ? JSON.stringify(d.data) : '');
  const source = String(raw || '').trim();
  if (!source) return '[卡片消息]';
  const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const pickXml = (re) => {
    const m = re.exec(source);
    if (!m) return '';
    return squash(String(m[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  };
  const videoHosts = ['bilibili.com', 'b23.tv', 'youtube.com', 'youtu.be', 'douyin.com', 'iesdouyin.com'];
  const videoUrlInText = (text) => {
    const decoded = text.replace(/&amp;/gi, '&');
    for (const match of decoded.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
      const quoted = /^["']/.test(decoded.slice(match.index + match[0].length));
      const candidate = decoded.trim() === match[0] || quoted
        ? match[0] : match[0].replace(/[)\]}.,!，。！？、）】”’]+$/u, '');
      try {
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        if (url.username || url.password) continue;
        if (videoHosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) return candidate;
      } catch { /* 非法 URL：继续找下一个候选 */ }
    }
    return '';
  };
  const findVideoUrl = (value, depth = 0) => {
    if (depth > 8) return '';
    if (typeof value === 'string') return videoUrlInText(value);
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) {
        const url = findVideoUrl(child, depth + 1);
        if (url) return url;
      }
    }
    return '';
  };

  let title = '';
  let desc = '';
  let prompt = '';
  let nick = '';
  let uin = '';
  let videoUrl = '';
  if (source.startsWith('{')) {
    try {
      const obj = JSON.parse(source);
      videoUrl = findVideoUrl(obj);
      const meta = obj?.meta && typeof obj.meta === 'object' ? obj.meta : {};
      const detail = meta.detail_1 || meta.news || meta.music || meta.detail || Object.values(meta)[0] || {};
      title = squash(detail.title || obj.title);
      desc = squash(detail.desc || obj.desc);
      prompt = squash(obj.prompt);
      nick = squash(detail.host?.nick);
      uin = squash(detail.host?.uin);
    } catch { /* 不是合法 JSON：交给下面的 XML 分支兜底 */ }
  }
  if (!title && !desc) {
    const brief = pickXml(/\bbrief="([^"]*)"/i);
    title = pickXml(/<title[^>]*>([\s\S]*?)<\/title>/i) || brief;
    desc = pickXml(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || pickXml(/<des[^>]*>([\s\S]*?)<\/des>/i);
    const src = pickXml(/<source[^>]*name="([^"]*)"/i);
    if (src && !prompt) prompt = src;
  }

  if (!videoUrl) videoUrl = videoUrlInText(source);
  // 非视频卡片（公众号/音乐/商品/小红书等）也要让模型拿到可引用的链接：
  // 只做文本抽取，不额外发网络请求；图片/头像类 URL 跳过，避免把缩略图当正文链接。
  if (!videoUrl) {
    const scan = source.replace(/\\\//g, '/').replace(/&amp;/gi, '&');
    for (const match of scan.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
      const candidate = match[0].replace(/[)\]}.,!，。！？、）】”’]+$/u, '');
      try {
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        if (url.username || url.password) continue;
        if (/\.(?:png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i.test(url.pathname)) continue;
        videoUrl = candidate;
        break;
      } catch { /* 非法 URL：继续找下一个 */ }
    }
  }
  const body = [title, desc, videoUrl].filter(Boolean).join(' — ');
  const mine = selfId && uin && String(uin) === String(selfId);
  const tags = [prompt, mine ? '你自己的动态' : (nick ? `来自 ${nick}` : '')].filter(Boolean).join(' · ');
  // 聊天记录卡片（app=com.tencent.multimsg，资源 id 在 detail_1.resid）单独标成「卡片聊天记录」：
  // 提示词里给模型的锚点就是这几个字（看见就用 read_forward 展开），而原来一律渲染成「[卡片…]」，
  // 那个锚点在消息正文里从来不存在 —— 模型既不会去展开，控制台的"卡片读不到"诊断也永远不触发
  //（2026-10-14 复审 P2）。判定与 forward-reader 取 resid 的口径一致（那里是唯一真源，这里只做标记）。
  const chatRecord = /com\.tencent\.multimsg/i.test(source)
    || /["']?resid["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i.test(source);
  const kind = chatRecord ? '卡片聊天记录' : '卡片';
  if (!body && !tags) {
    // 认不出的卡片结构留一条样本（卡片少见，不会刷屏），以后按真实结构扩展解析
    try { console.log('[onebot] 未能解析的卡片样本：', source.slice(0, 240)); } catch { /* 忽略 */ }
    return chatRecord ? '[卡片聊天记录]' : '[卡片消息]';
  }
  return `[${kind}${tags ? ' ' + tags : ''}${body ? '：' + body : ''}]`;
}

export async function segmentsToText(segments, { resolveReply = null, resolveAtName = null, includeReply = true, selfId = '' } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': {
        const faceName = faceNameOf(d.id);
        // 标成「QQ表情」：这个编号是 QQ 系统表情编号，不是表情库的 stickerId，
        // 不标清楚模型会拿它去查表情（今天 5 次「找不到表情 277/489/491/492」就是这么来的）
        out.push(faceName ? `[QQ表情${d.id ?? ''} ${faceName}]` : `[QQ表情${d.id ?? ''}]`);
        break;
      }
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            replyText = formatQuoteRef(await resolveReply(String(d.id)));
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json':
      case 'xml': out.push(cardToText(seg, selfId)); break;
      case 'forward': {
        // 不带 res_id：那个 id 会过期（payload is empty），打出来只会误导模型拿它当参数。
        // 模型要看内容用 read_forward 工具 + 消息前的 #数字。
        out.push('[合并转发聊天记录]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
    } else if (seg.type === 'record' || seg.type === 'voice') {
      media.push({ kind: 'audio', file: String(d.file ?? ''), url: String(d.url ?? '') });
    } else if (seg.type === 'video') {
      // 视频留两条：音轨给 get_message_audio 转文字，画面给 get_message_images 抽帧条（用户 2026-09-26 反馈
      // "发视频它只会说听声音"——因为之前只采了音轨，模型根本没有画面可看）。
      media.push({ kind: 'audio', file: String(d.file ?? ''), url: String(d.url ?? '') });
      media.push({ kind: 'video', file: String(d.file ?? ''), url: String(d.url ?? '') });
    } else if (seg.type === 'file' && /\.(m4a|mp3|wav|amr|aac|ogg|flac|wma|mp4|mov|avi|mkv|webm)$/i.test(String(d.name ?? d.file ?? ''))) {
      media.push({ kind: 'audio', file: String(d.name ?? d.file ?? ''), url: String(d.url ?? '') });
      // 视频类文件同样留一条"画面"（群文件发的视频也能看帧条）
      if (/\.(mp4|mov|avi|mkv|webm)$/i.test(String(d.name ?? d.file ?? ''))) {
        media.push({ kind: 'video', file: String(d.name ?? d.file ?? ''), url: String(d.url ?? '') });
      }
    }
  }
  return media;
}

/**
 * 展开合并转发节点为可读文本（纯函数，便于测试）。
 *
 * 背景：OneBot 事件里的 forward 段只有一个 res_id 占位符，
 * 需要 get_forward_msg 拿回节点数组（本函数处理的就是这个数组）。
 * 实测 NapCat：{ message_id } 可用；res_id 会过期（payload is empty），别依赖。
 *
 * 规则：
 *   - 每个节点一行「昵称: 内容」，内容复用 segmentsToText（@/图片/表情等占位一致）
 *   - 嵌套转发展开**一层**（深度 2 封顶；再深写占位），取数上限 maxNestedFetches（默认 3），
 *     取不到/超预算都写成占位，让模型知道自己没看全
 *   - 封顶：maxNodes 条 / maxChars 字符，超出注明"还有 N 条未展开"
 *   - 节点里的图片段同时提取到 media（url 新鲜，可用于取图/金句）
 *
 * @param {Array} nodes get_forward_msg 返回的 messages 数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
export async function expandForwardNodes(nodes, options = {}) {
  const state = {
    fetchNested: typeof options.fetchNested === 'function' ? options.fetchNested : null,
    // 一次展开最多为"记录里的记录"取几次：防一条记录里塞十几个嵌套把协议端打满
    maxNestedFetches: Math.max(0, Math.min(10, Number(options.maxNestedFetches ?? 3) || 0)),
    nestedFetches: 0
  };
  return expandNodesOnce(nodes, { ...options, depth: 0 }, state);
}

async function expandNodesOnce(nodes, { maxNodes = 30, maxChars = 3000, depth = 0 } = {}, state) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lines = [];
  const media = [];
  let truncated = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (lines.length >= maxNodes) { truncated = nodes.length - i; break; }
    const n = nodes[i] || {};
    // 节点名来自 QQ 侧（群名片可任意字符），与消息文本同一套清洗
    const name = sanitizeUserText(String(n.sender?.card || n.sender?.nickname || n.user_id || '?'));
    const nm = n.message ?? n.content;
    let body = '';
    const nestedBlocks = [];
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      const plain = nm.filter((s) => s?.type !== 'forward');
      body = await segmentsToText(plain, {});
      media.push(...extractMediaFromSegments(plain));
      for (const seg of nm.filter((s) => s?.type === 'forward')) {
        nestedBlocks.push(await nestedForwardBlock(seg, depth, state));
      }
    }
    body = sanitizeUserText(body.replace(/\s+/g, ' ').trim().slice(0, 200));
    if (body) lines.push(`${name}: ${body}`);
    // 内层记录单独成行（不受上面 200 字截断），缩进 + ↳ 让"记录里的记录"一眼看出来
    for (const block of nestedBlocks) {
      if (!block) continue;
      lines.push(block);
    }
    if (lines.join('\n').length > maxChars) { truncated = nodes.length - i - 1; break; }
  }

  const head = `[合并转发 共${nodes.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}

/**
 * 记录里的记录：有资源 id 且还有取数预算时现取一层并展开（深度 2 封顶）。
 * 取不到 / 超预算 / 更深一层 —— 都如实写成占位，别让模型以为看全了。
 */
async function nestedForwardBlock(seg, depth, state) {
  const rid = forwardIdFromData(seg?.data);
  if (!rid) return '    [嵌套转发（没有资源 id）]';
  if (!state.fetchNested || depth >= 1) return '    [嵌套转发（未展开）]';
  if (state.nestedFetches >= state.maxNestedFetches) return '    [嵌套转发（超出取数上限，未展开）]';
  state.nestedFetches += 1;
  let nodes = null;
  try { nodes = await state.fetchNested(rid); } catch { nodes = null; }
  if (!nodes?.length) return '    [嵌套转发（取回失败，未展开）]';
  const sub = await expandNodesOnce(nodes, { maxNodes: 8, maxChars: 900, depth: depth + 1 }, state);
  if (!sub?.text) return '    [嵌套转发（内容为空）]';
  return sub.text.split('\n').map((line, index) => (index === 0 ? `    ↳ ${line}` : `    ${line}`)).join('\n');
}
