// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeUserText, escapeCqText } from '../core/util.js';

// QQ 系统表情对照表：把「[表情14]」渲染成「[表情14 微笑]」，让模型知道对方发的是哪个表情。
// 表来自容器内 QQ 自带的 sys-face-catalog.json，由 /home/ubuntu/export-face-names.sh 导出到数据目录。
let FACE_NAMES = null;
function faceNameOf(id) {
  if (FACE_NAMES === null) {
    try {
      const dir = process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data');
      FACE_NAMES = JSON.parse(fs.readFileSync(path.join(dir, 'face-names.json'), 'utf8')).bySid || {};
    } catch { FACE_NAMES = {}; }
  }
  return FACE_NAMES[String(id ?? '')] || '';
}

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

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
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
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
    try { old?.terminate(); } catch { /* ignore */ }
    this.#connectLoop();
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
      this.lastConnectError = String(error?.message ?? error);
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
      let alive = true;
      socket.on('pong', () => { alive = true; });
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (!isCurrent(socket)) return;
        if (!alive) { socket.terminate(); return; }
        alive = false;
        socket.ping();
      }, 30000);
      this.heartbeatTimer.unref?.();
      this.#setStatus(true);
      try {
        this.selfInfo = await this.call('get_login_info');
      } catch (error) {
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', (code, reason) => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      clearInterval(this.heartbeatTimer);
      this.#setStatus(false);
      if (!this.#closedByUs) this.#scheduleReconnect();
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = String(error?.message ?? error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      }
    });
  }

  close() {
    this.#closedByUs = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    const old = this.socket;
    this.socket = null;
    try { old?.terminate(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  #scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.reconnectAttempt++, 4));
    this.reconnectTimer = setTimeout(() => this.#connectLoop(), delay);
    this.reconnectTimer.unref?.();
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = 15000, signal) {
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
      },
      body: JSON.stringify(params),
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
      body = await res.json();
    } catch (cause) {
      throw new OneBotActionError(`OneBot ${action} 返回了无法解析的响应`, {
        action,
        outcome: 'unknown',
        httpStatus: res.status,
        cause
      });
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
  async sendSegments(kind, id, segments, signal) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params, 15000, signal);
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null, signal } = {}) {
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
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments, signal);
  }

  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null, signal } = {}) {
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
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    return this.sendSegments(kind, id, segments, signal);
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

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
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

  let title = '';
  let desc = '';
  let prompt = '';
  let nick = '';
  let uin = '';
  if (source.startsWith('{')) {
    try {
      const obj = JSON.parse(source);
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

  const body = [title, desc].filter(Boolean).join(' — ');
  const mine = selfId && uin && String(uin) === String(selfId);
  const tags = [prompt, mine ? '你自己的动态' : (nick ? `来自 ${nick}` : '')].filter(Boolean).join(' · ');
  if (!body && !tags) {
    // 认不出的卡片结构留一条样本（卡片少见，不会刷屏），以后按真实结构扩展解析
    try { console.log('[onebot] 未能解析的卡片样本：', source.slice(0, 240)); } catch { /* 忽略 */ }
    return '[卡片消息]';
  }
  return `[卡片${tags ? ' ' + tags : ''}${body ? '：' + body : ''}]`;
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
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
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
      media.push({ kind: 'audio', file: String(d.file ?? ''), url: String(d.url ?? '') });
    } else if (seg.type === 'file' && /\.(m4a|mp3|wav|amr|aac|ogg|flac|wma|mp4|mov|avi|mkv|webm)$/i.test(String(d.name ?? d.file ?? ''))) {
      media.push({ kind: 'audio', file: String(d.name ?? d.file ?? ''), url: String(d.url ?? '') });
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
 *   - 嵌套转发不再展开（深度 1 封顶，套娃截断）
 *   - 封顶：maxNodes 条 / maxChars 字符，超出注明"还有 N 条未展开"
 *   - 节点里的图片段同时提取到 media（url 新鲜，可用于取图/金句）
 *
 * @param {Array} nodes get_forward_msg 返回的 messages 数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
export async function expandForwardNodes(nodes, { maxNodes = 30, maxChars = 3000 } = {}) {
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
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      // 嵌套 forward 段清空 data → segmentsToText 输出 [转发消息] 占位（深度 1 封顶）
      const segs = nm.map((s) => (s?.type === 'forward' ? { type: 'forward', data: {} } : s));
      body = await segmentsToText(segs, {});
      media.push(...extractMediaFromSegments(segs));
    }
    body = sanitizeUserText(body.replace(/\s+/g, ' ').trim().slice(0, 200));
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = nodes.length - i - 1; break; }
  }

  const head = `[合并转发 共${nodes.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}
