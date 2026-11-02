// 群游戏管理器：生命周期、持久化（重启恢复）、消息拉取、效果派发与超时。
// 游戏规则在 ./games/<id>.js 插件里（只产出 effects：要发的话 / 要结束），发送与存盘都由这里统一做。
// 设计要点（docs/research/GAME_HOSTING_DESIGN.md）：私密信息（词/身份）只走私聊，公开摘要不含隐藏信息。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from '../core/config.js';
import { displayNameOf } from '../core/display-name.js';
import { sanitizeUserText, ZONE_OFFSET_MS } from '../core/util.js';
import * as numberBomb from './games/number-bomb.js';
import * as undercover from './games/undercover.js';
import * as werewolf from './games/werewolf.js';

const FILE = path.join(DATA_DIR, 'games.json');
const PLUGINS = new Map([[numberBomb.meta.id, numberBomb], [undercover.meta.id, undercover], [werewolf.meta.id, werewolf]]);

const dayIndex = (ts) => Math.floor((Number(ts) + ZONE_OFFSET_MS) / 86400000);
// 可开局游戏的白名单默认值（与 DEFAULT_CONFIG.groupGame.games 同口径）
const DEFAULT_GAMES = ['number-bomb', 'undercover'];
// 报名信号（设计稿 §3.1 的 recruiting）：明确表达"想玩"才算，避免把只是插句话的围观者拉进局
const JOIN_RE = /(我玩|我要玩|我也玩|我来|我报名|报名|加我|带我|算我|拉我|我也来|参与|参加)|^\s*(\+1|＋1|1|11|111)\s*[!！。.~～…]?\s*$/;
// 否定/劝阻语境的直接跳过："别带我""不参与""我玩不动"都不是报名（子串匹配会误判，2026-09-29 审查 P1）
const JOIN_NEG_RE = /不|别|勿|甭|算了|不用|拒绝/;

/**
 * 引用回复在正文前会带 `[引用#123·我：…]`；插件解析器多为整句/关键词锚定，
 * 引用块里若碰巧含“投 3/刀 2”会把玩家的真实行动带偏。喂插件前先剥掉引用装饰。
 */
function stripQuotePrefix(text) {
  return String(text || '').replace(/^\s*(?:\[引用[^\]]*\]\s*)+/, '').trim();
}

export class GroupGameManager {
  constructor({ store, sender, effects = null, log = console.log, now = () => Date.now(), rng = Math.random, wake = null } = {}) {
    this.store = store;
    this.sender = sender;
    // 出站副作用账本：终局播报一局只发一次；结果未知时停止自动重试
    this.effects = effects;
    this.log = log;
    this.now = now;
    this.rng = rng;
    this.wake = wake;
    this.games = new Map();     // chatKey -> { gameId, state, startedAt, lastSeenId, deadlineAt }
    this.daily = new Map();     // chatKey -> { dayKey, count }
    this.timer = null;
    // 兜底扫描窗口内"入口路径已喂过引擎"的消息 id（防双喂的精确判据，见 #collectPrivateActions）：
    // 只在扫描进行时生效，不进任何落盘状态。
    this._privateScanActive = false;
    this._privateScanFedIds = new Set();
    this.#load();
  }

  #cfg() {
    const g = getConfig().groupGame || {};
    return {
      enabled: g.enabled === true,
      chats: Array.isArray(g.chats) ? g.chats.map((x) => String(x || '').trim()).filter(Boolean) : [],
      allowPrivateInvite: g.allowPrivateInvite === true,
      // 游戏期间私聊豁免（默认关）：开启后，引擎发给**本局在册玩家**的私聊不再要求对方
      // 在 allow.private 白名单里（报名=同意接收）；deny 仍然优先。模型自己的发送永远受白名单。
      allowGamePrivateDm: g.allowGamePrivateDm === true,
      // 结算是否公开词/身份（界面上那个勾；之前只有 UI 在写、引擎从不读，是个死开关）
      revealWords: g.revealWords !== false,
      // 白天讨论时长（秒；0 = 用插件默认：狼人杀/卧底都是 120）。到点直接进投票，
      // 中途过半人说"投吧"也会立刻进。
      discussSeconds: Math.min(600, Math.max(0, Number(g.discussSeconds) || 0)),
      // 开局报名时长（秒）：needsPrivate 的游戏先挂报名，够 minPlayers 才发牌；0 = 不报名，
      // 直接按"最近发过言的群友"发牌（旧行为）。**键缺失时按产品默认 45**（与文档/UI 一致），
      // 只有显式写 0 才是关闭（2026-09-29 审查：文档说默认开、代码缺省却是关）
      // 键缺失由 DEFAULT_CONFIG 兜（45）；显式写 null/'' 也按缺省处理，
      // 免得手改配置的实例出现"控制台显示 45、实际直接发牌"（只有显式 0 才是关闭报名）
      recruitSeconds: g.recruitSeconds === undefined || g.recruitSeconds === null || g.recruitSeconds === ''
        ? 45
        : Math.min(300, Math.max(0, Number(g.recruitSeconds) || 0)),
      // 这三个以前是"死配置"：UI 能填、引擎从不读（2026-09-29 审查 P1/P2）
      games: Array.isArray(g.games) ? g.games.map((x) => String(x || '').trim()).filter(Boolean) : DEFAULT_GAMES,
      maxPlayers: Number(g.maxPlayers) > 0 ? Math.min(30, Math.max(2, Number(g.maxPlayers))) : 0,
      roundSeconds: Math.min(600, Math.max(0, Number(g.roundSeconds) || 0)),
      maxDurationMin: Math.min(180, Math.max(5, Number(g.maxDurationMin) || 60)),
      dailyLimitPerChat: Math.min(50, Math.max(1, Number(g.dailyLimitPerChat) || 6))
    };
  }

  #load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (error) {
      // 首次运行没有文件是正常的；"文件在但坏了"不能静默按空处理 —— 下一次 #save 会把
      // 进行中的局与当天的开局限额一起覆盖掉（与 reminders 同一口径：留备份 + 告警）。
      if (error?.code !== 'ENOENT') {
        console.error(`[group-game] 读取 ${FILE} 失败，本次按"没有进行中的局"处理，原文件已备份为 .broken-<时间戳>：`, error?.message ?? error);
        try { fs.renameSync(FILE, `${FILE}.broken-${Date.now()}`); } catch { /* 备份失败就留在原处 */ }
      }
      return;
    }
    for (const [chatKey, item] of Object.entries(raw?.games || {})) {
      if (item && item.gameId && item.state) this.games.set(chatKey, item);
    }
    for (const [chatKey, d] of Object.entries(raw?.daily || {})) this.daily.set(chatKey, d);
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const body = JSON.stringify({
        games: Object.fromEntries(this.games),
        daily: Object.fromEntries(this.daily)
      }, null, 2);
      // 原子写：先写 .tmp 再 rename。tick 现在每 20 秒就可能写一次，中途被杀/断电留下
      // 半截 JSON 的话，#load 的 catch 会当成"首次运行"静默丢掉所有进行中的局（2026-09-29 审查）
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.chmodSync(tmp, 0o600);
      try {
        fs.renameSync(tmp, FILE);
      } catch {
        // Windows 上目标文件被占用时 rename 会 EPERM/EBUSY：退回直接写（丢掉原子性但不丢状态）
        fs.writeFileSync(FILE, body);
        try { fs.unlinkSync(tmp); } catch { /* 残留也无害 */ }
      }
    } catch (error) {
      this.log('[group-game] 存盘失败（不影响本局）:', error?.message ?? error);
    }
  }

  /** 启动推进循环（注意：与开局方法 start() 区分命名，JS 类里重名会互相覆盖）。 */
  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.log('[group-game] tick 出错:', e?.message ?? e)); }, 20000);
    if (this.timer.unref) this.timer.unref();
    if (this.games.size) this.log(`[group-game] 已从磁盘恢复 ${this.games.size} 局进行中的游戏`);
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reconfigure() { /* 配置变更随时生效（每次读 getConfig），无需重启循环 */ }

  status(chatKey = '') {
    const list = [...this.games.entries()].map(([key, g]) => ({
      chatKey: key,
      game: g.gameId,
      name: PLUGINS.get(g.gameId)?.meta.name || g.gameId,
      startedAt: g.startedAt,
      summary: this.summaryFor(key, { includeBrief: false })
    }));
    return { enabled: this.#cfg().enabled, running: list.filter((x) => !chatKey || x.chatKey === chatKey) };
  }

  /** 注入提示词的公开摘要（不含任何隐藏信息）。 */
  summaryFor(chatKey, { includeBrief = true } = {}) {
    const cfg = this.#cfg();
    // 关掉开关或把群移出白名单后，不许再把"进行中的局"注入提示词（否则它会一直挂到重启）
    if (!cfg.enabled) return '';
    if (!cfg.chats.includes(chatKey)) {
      // 私聊不是局的主会话：只给一段**角色无关**的提示，让模型别把玩家的私聊行动当闲聊乱接
      // （行动本身由引擎在入口接管、不进模型；这条是给"没解析出来、落到模型手里"的消息兜底）
      const asPlayer = this.#playerGameOfPrivate(chatKey);
      if (!asPlayer) return '';
      return `【进行中的游戏】${asPlayer.plugin.meta.name}正在进行，这位群友是参与者。`
        + '\n私聊里你若收到行动类消息（如"刀 3"/"守 2"/"查 1"），不要复述、不要解读、不要评论任何人的身份；'
        + '引擎已处理的行动你不会看到；没看懂的消息请让对方按引擎提示的格式重发一遍。';
    }
    const g = this.games.get(chatKey);
    if (!g) return '';
    const plugin = PLUGINS.get(g.gameId);
    if (!plugin) return '';
    if (g.state?.phase === 'recruiting') {
      const names = g.state.joiners.map((j) => j.name).join('、') || '（还没人）';
      return `【进行中的游戏】${plugin.meta.name}报名中：已报名 ${g.state.joiners.length}/${g.state.minPlayers} 人 —— ${names}。`
        + '\n主持要求：想玩的让他发一句「我玩」或「报名」；别替人报名、别催、别点名，人数够了系统会自动开局。';
    }
    const lines = [`【进行中的游戏】${plugin.meta.name}：`, plugin.summaryForModel(g.state)];
    if (includeBrief) lines.push(`主持要求：${plugin.hostBrief(g.state)}`);
    return lines.join('\n');
  }

  /**
   * 把"这条私聊已处理过"记进所有相关局的水位（归属局 + 其它在跑的局）。
   * 只推归属局的话，归属一换（owner 局结束/被 stop）旧局会从自己的旧水位把消息再吃一遍
   * （2026-09-29 审查 P1：实测「刀 2」在 owner 局结束后又被另一局执行了一次）。
   */
  #notePrivateSeen(id, uid) {
    const maxId = Number(id) || 0;
    const who = String(uid);
    for (const g of this.games.values()) {
      if (!(g.state?.roles || []).some((r) => String(r.userId) === who)) continue;
      g.privateSeen = g.privateSeen && typeof g.privateSeen === 'object' ? g.privateSeen : {};
      g.privateSeen[who] = Math.max(Number(g.privateSeen[who] || 0), maxId);
    }
  }

  /**
   * 这条私聊归哪一局：**最近开局、还没结束、且名单里有这个人**的那一局——单一归属。
   *
   * 只认这一个候选，它不认领就交给模型兜底，**绝不转给更早的局执行**：
   * 试过"逐局递补"会把 B 局白天的闲聊拿去当 A 局的夜间行动执行（还会把消息标已读、
   * 模型再也看不到），也会把玩家交给刚结束那局的刀/查喂给别的局（2026-09-29 第三轮审查 P1）。
   *
   * 若那最近一局已经结束（终局播报还在发的那几秒仍留在 games 里），返回空——
   * 那时他的私聊按普通聊天处理，同样不转给别的局。
   */
  #privateCandidates(chatKey) {
    // 入站（收玩家的私聊行动）不限定 \d+：生产里 uid 是 QQ 号，但测试世界用 u1/u2 这类 id。
    // 注意出站方向不对称：发送时的「游戏期间私聊豁免」只对**纯数字 QQ 号**生效
    // （src/core/access.js 的 assertCanSend 那道 /^\d+$/ 是私聊命名空间的安全网）——
    // 所以非数字 id 的世界里，行动收得进、身份/回执发不出（2026-09-29 审查 P2）。
    const m = /^private:([^:\s]+)$/.exec(String(chatKey || ''));
    if (!m) return [];
    const who = m[1];
    const owner = [...this.games.entries()]
      .map(([groupKey, g]) => ({ groupKey, game: g, plugin: PLUGINS.get(g.gameId) }))
      .filter((x) => x.plugin?.meta?.needsPrivate
        && typeof x.plugin.onPrivateMessage === 'function'
        && (x.game.state?.roles || []).some((r) => String(r.userId) === who))
      .sort((a, b) => Number(b.game.startedAt || 0) - Number(a.game.startedAt || 0))[0];
    if (!owner) return [];
    if (owner.game.state?.phase === 'ended') return [];   // 他的最近一局刚结束 → 按普通私聊交给模型
    return [owner];
  }

  /** private:uid 属于哪个进行中的局（玩家视角，用于提示词摘要）；不是参与者就返回 null。 */
  #playerGameOfPrivate(chatKey) {
    return this.#privateCandidates(chatKey)[0] || null;
  }

  /** 把一条私聊喂给归属局；它不认领（白天/看不懂）就返回 null，由调用方交回模型。 */
  #feedPrivate(chatKey, uid, text, ts) {
    const cleanText = stripQuotePrefix(text);
    for (const cand of this.#privateCandidates(chatKey)) {
      const out = cand.plugin.onPrivateMessage(cand.game.state, {
        userId: uid, text: cleanText, ts
      }, { now: this.now(), deadline: cand.game.deadlineAt });
      const claimed = Boolean(out?.effects?.length) || out?.consume === true;
      if (!claimed) continue;
      cand.game.state = out.state;
      return { ...cand, out };
    }
    return null;
  }

  /**
   * 私聊行动入口（由 ingest 在收到私聊消息时调用）：属于进行中的局就由引擎接管，
   * 返回 true 表示"已消费，不要再唤醒模型"。解析不了（无回执）时返回 false，
   * 让消息照常落到模型手里兜底（玩家不至于发了没人理）。
   */
  async consumePrivateAction(chatKey, message) {
    const cfg = this.#cfg();
    if (!cfg.enabled) return false;
    const uid = String(message?.senderId || '').split(':').pop();
    // 兜底扫描正在跑、且这条已被扫描喂过引擎：视为已消费，不重复喂（2026-10-12 复核 P3：
    // 双喂护栏做成双向的 —— 扫描侧跳过入口喂过的，入口侧跳过扫描喂过的）。
    if (this._privateScanActive && this._privateScanFedIds.has(`${chatKey}|${String(message?.id)}`)) return true;
    // 按"最近开局优先"逐个候选局试到有人认领；都没认领（非参与者/白天/已出局…）→ 交回普通链路。
    // 插件可以用 consume:true 表示"我认领了这条但不必回执"（重复提交、回执超配额）——静默消耗。
    const hit = this.#feedPrivate(chatKey, uid, String(message?.text || ''), Number(message?.ts) || this.now());
    if (hit && this._privateScanActive) this._privateScanFedIds.add(`${chatKey}|${String(message?.id)}`);
    if (!hit) {
      // 没被认领 = 这条是聊天（白天闲聊/看不懂），交给模型；但水位要推——否则兜底扫描
      // 在阶段变成"可行动"之后会把这条旧消息当行动补执行（2026-09-29 第三轮审查 P1）
      this.#notePrivateSeen(message?.id, uid);
      return false;
    }
    // 所有相关局（含别局）的水位一起推：owner 局结束后旧局不会把这条再吃一遍
    this.#notePrivateSeen(message?.id, uid);
    this.#save();
    await this.#applyEffects(hit.groupKey, hit.out.effects || []);
    // 就地标记已读：这条私聊不再唤醒模型（省调用 + 零泄密面）
    try { this.store.markRead(chatKey, [Number(message?.id)]); } catch { /* 标记失败不影响本局 */ }
    if (hit.out.state?.phase === 'ended') this.#finishIfEnded(hit.groupKey);
    return true;
  }

  /** tick 的兜底扫描：补处理"错过入口"（重启补课、引擎当时没在跑）的私聊行动。 */
  async #collectPrivateActions(groupKey) {
    const g = this.games.get(groupKey);
    if (!g) return;
    const plugin = PLUGINS.get(g.gameId);
    if (typeof plugin?.onPrivateMessage !== 'function') return;
    const players = (g.state?.roles || []).map((r) => String(r.userId));
    if (!players.length) return;
    g.privateSeen = g.privateSeen && typeof g.privateSeen === 'object' ? g.privateSeen : {};
    let dirty = false;
    // 防双喂标记（2026-10-12 审查，同日复核修正）：扫描窗口内"已被喂过引擎"的消息 id 记在
    // 实例集合里，入口路径与扫描共用 —— 入口在扫描的 await 间隙消费了某条 → 扫描跳过它；
    // 扫描喂了某条 → 入口跳过它。判据必须是"这条真的被喂过"（精确 id），不能用 max 水位：
    // 入口消费更新的消息会把水位抬过中间还没处理的旧 id，那些会漏执行。
    this._privateScanActive = true;
    this._privateScanFedIds.clear();
    try {
      // 扫描"所有含这些玩家的局"的候选：兜底不只补这一局，也补"归属在别处"的那些消息
      for (const uid of players) {
        // 这一局在扫描过程中结束了就不再喂后续消息（同一批里"狼全退"之后，后面那条
        // 「不玩了」还会再走一次结算，群里出现第二条身份表不同的终局播报；2026-09-29 对抗性验证 P2）
        if (this.games.get(groupKey)?.state?.phase === 'ended') break;
        const key = `private:${uid}`;
        // 水位取"该玩家在哪个局里的最大值"（#notePrivateSeen 会同时推所有局）
        const after = Math.max(...[...this.games.values()].map((x) => Number(x.privateSeen?.[uid] || 0)), 0);
        // 不看 readOnly：行动消息可能是 pending（入口没接管到的情况），水位保证不重放
        const rows = this.store.recent(key, { limit: 200, afterId: after });
        for (const m of rows) {
          if (this.games.get(groupKey)?.state?.phase === 'ended') break;
          // 延迟富化中的行正文还是占位符：先停在它这里，等放行后再从同一水位扫，
          // 不能把占位正文喂给插件、也不能把水位推过它（Issue #85）。
          if (m.state === 'deferred') break;
          const fedKey = `${key}|${String(m.id)}`;   // 消息 id 是每会话各自的序列，跨会话会重号：key 必须带 chatKey
          if (this._privateScanFedIds.has(fedKey)) continue;   // 扫描窗口内已被入口喂过
          this.#notePrivateSeen(m.id, uid);
          if (m.self) continue;
          const hit = this.#feedPrivate(key, uid, String(m.text || ''), Number(m.ts) || this.now());
          if (!hit) continue;   // 没有局认领（非行动消息/已出局…）→ 交给模型
          this._privateScanFedIds.add(fedKey);
          dirty = true;
          try { this.store.markRead(key, [Number(m.id)]); } catch { /* 忽略 */ }
          if (hit.out.effects?.length) {
            if (hit.out.effects.length) await this.#applyEffects(hit.groupKey, hit.out.effects);
          }
          if (hit.out.state?.phase === 'ended') this.#finishIfEnded(hit.groupKey);
        }
      }
    } finally {
      this._privateScanActive = false;
      this._privateScanFedIds.clear();
    }
    if (dirty) this.#save();
  }

  /**
   * 报名窗口推进：扫新群消息里的报名信号（JOIN_RE），够 minPlayers 就发牌；
   * 到点还不够就取消。报名阶段**不发任何私聊**——这是"别把围观群众拉进局"的关键。
   */
  async #collectRecruiting(chatKey) {
    const g = this.games.get(chatKey);
    if (!g?.recruiting || g.state?.phase !== 'recruiting') return;
    const cfg = this.#cfg();
    const plugin = PLUGINS.get(g.gameId);
    if (!plugin) return;
    // 群被移出白名单 / 整局时长到点：报名就地取消（解析不了的对象一律不发私聊）
    if (!cfg.chats.includes(chatKey) || this.now() >= Number(g.deadlineAt || 0)) {
      this.games.delete(chatKey);
      this.#save();
      await this.#applyEffects(chatKey, [{ type: 'public', text: `${plugin.meta.name}报名取消。` }]);
      return;
    }
    // 不带 readOnly：报名消息此刻可能还是 pending/leased（同一群里正好有一次模型运行在飞），
    // 取 readOnly 会把它们整批漏掉、45 秒到点直接"人数不够"（2026-09-29 审查 P2）
    const rows = this.store.recent(chatKey, { limit: 200, includeSelf: false, afterId: Number(g.lastSeenId || 0) });
    for (const m of rows) {
      // 报名消息不能为了等富化而错过 45 秒窗口：占位正文里通常已有用户自己写的
      // 「我玩/报名」，按它继续扫描；富化只会补充引用/转发细节，不会改变报名意图。
      g.lastSeenId = Math.max(Number(g.lastSeenId || 0), Number(m.id) || 0);
      const uid = String(m.senderId || '');
      if (!uid) continue;
      const joinText = stripQuotePrefix(m.text);
      if (!JOIN_RE.test(joinText) || JOIN_NEG_RE.test(joinText)) continue;
      if (g.state.joiners.some((j) => j.userId === uid)) continue;
      if (g.state.joiners.length >= g.state.maxPlayers) {
        // 人满了还来报：记下来，本轮末尾统一回一句"来晚了"（以前是默默丢掉、没有任何反馈）
        g.state.overflow = Array.isArray(g.state.overflow) ? g.state.overflow : [];
        if (!g.state.overflow.some((x) => x.userId === uid)) {
          g.state.overflow.push({ userId: uid, name: sanitizeUserText(String(m.senderName || uid)) });
          this.log(`[group-game] ${chatKey} 报名已满，忽略后来的：${m.senderName || uid}`);
        }
        continue;
      }
      // 姓名会进系统提示词（报名摘要），按全仓统一口径清洗段头
      g.state.joiners.push({ userId: uid, name: sanitizeUserText(String(m.senderName || uid)) });
      this.log(`[group-game] ${chatKey} 报名：${m.senderName || uid}（${g.state.joiners.length}/${g.state.minPlayers}）`);
    }
    this.#save();
    const now = this.now();
    if ((g.state.overflow || []).length) {
      const names = g.state.overflow.map((x) => x.name).join('、');
      await this.#applyEffects(chatKey, [{
        type: 'public',
        text: `👋 ${names} 来晚了一步：这局已经报满（${g.state.maxPlayers} 人上限），等下一局吧。`
      }]);
      g.state.overflow = [];
      this.#save();
    }
    if (g.state.joiners.length >= g.state.minPlayers) {
      const roster = g.state.joiners.slice(0, g.state.maxPlayers);
      const di = this.daily.get(chatKey);
      const today = dayIndex(now);
      const used = di && di.dayKey === today ? di.count : 0;
      this.games.delete(chatKey);
      await this.#dealNow(chatKey, plugin, roster, cfg, { today, used, now });
      return;
    }
    // 报名快截止（窗口 ≥30 秒时才提）且人还不够：提一句还剩多少、还差几人（只提一次）
    const recruitUntil = Number(g.state.recruitUntil || 0);
    if (!g.recruitWarned && cfg.recruitSeconds >= 30 && recruitUntil && recruitUntil - now <= 18 * 1000) {
      g.recruitWarned = true;
      this.#save();
      const have = g.state.joiners.length;
      const need = Math.max(0, Number(g.state.minPlayers || 0) - have);
      await this.#applyEffects(chatKey, [{
        type: 'public',
        text: `⏳ ${plugin.meta.name}报名马上截止（现在 ${have} 人${need > 0 ? `，还差 ${need} 人` : ''}），想玩的赶紧回「我玩」。`
      }]);
    }
    if (now >= Number(g.state.recruitUntil || 0)) {
      this.games.delete(chatKey);
      this.#save();
      await this.#applyEffects(chatKey, [{
        type: 'public',
        text: `${plugin.meta.name}报名人数不够（${g.state.joiners.length}/${g.state.minPlayers}），这局先算了。`
      }]);
    }
  }

  /** 局已结束（插件把 phase 标成 ended）→ 清状态并落盘。 */
  #finishIfEnded(groupKey) {
    const cur = this.games.get(groupKey);
    if (cur && cur.state?.phase === 'ended') {
      // 同 handleNewMessages 末尾：终局播报没送出去（pendingEnd）时保留，等重试（P1-1）
      if (cur.pendingEnd) { this.#save(); return; }
      this.games.delete(groupKey);
      this.#save();
    }
  }

  /** 开局。players 缺省用最近活跃成员；返回 { ok, text }（text 是可直接发给群里的说明）。 */
  async start({ chatKey, gameId, players = null }) {
    const cfg = this.#cfg();
    if (!cfg.enabled) return { ok: false, error: '群游戏未启用（设置 → 实验功能里打开）' };
    if (!cfg.chats.includes(chatKey)) return { ok: false, error: '这个群不在群游戏白名单里' };
    const plugin = PLUGINS.get(String(gameId || ''));
    if (!plugin) return { ok: false, error: `未知游戏：${gameId || '（没给）'}。可选：${[...PLUGINS.keys()].join(' / ')}` };
    // 控制台勾选白名单：没勾的游戏不许开（以前这个勾选是死控件，2026-09-29 审查 P1）
    if (!cfg.games.includes(plugin.meta.id)) {
      return { ok: false, error: `「${plugin.meta.name}」在控制台没被允许（设置 → 群游戏里勾上再开）` };
    }
    if (this.games.has(chatKey)) return { ok: false, error: '这个群已经有一局在进行了（先 stop 或等它结束）' };
    if (plugin.meta.needsPrivate && !cfg.allowPrivateInvite) {
      return { ok: false, error: `${plugin.meta.name}需要私聊发词/身份：先到控制台打开「允许私聊发身份」` };
    }
    const now = this.now();
    const di = this.daily.get(chatKey);
    const today = dayIndex(now);
    const used = di && di.dayKey === today ? di.count : 0;
    if (used >= cfg.dailyLimitPerChat) return { ok: false, error: `今天这个群已经开过 ${used} 局了（上限 ${cfg.dailyLimitPerChat}），明天再来` };

    const active = this.store.activeMembers(chatKey, 50).map((m) => ({ userId: String(m.userId), name: m.name }));
    const activeIds = new Set(active.map((p) => p.userId));
    // 模型看到的成员名是 displayNameOf（备注/代号优先），只索引群名片会让"设过备注的人"解析不到、
    // 名单被静默丢掉（2026-10-13 全项目审查 P3-2）。两种写法都索引。
    // 别名撞车（两个人同群名片，或某人的备注正好是别人的名片）时**宁缺勿错**：Map 后写覆盖
    // 会让人被静默解析成另一个人（身份/查验结果发错对象），与"重名不敢猜"的既有口径一致
    //（2026-10-14 复审 P3）。
    const idByName = new Map();
    const ambiguousNames = new Set();
    for (const p of active) {
      const display = String(displayNameOf(p.userId, p.name) || '').trim();
      for (const key of [String(p.name || '').trim(), display]) {
        if (!key) continue;
        if (idByName.has(key) && idByName.get(key) !== p.userId) { ambiguousNames.add(key); continue; }
        idByName.set(key, p.userId);
      }
    }
    for (const key of ambiguousNames) idByName.delete(key);
    const requested = Array.isArray(players) && players.length ? players : null;
    // 模型给的 players 必须先与本群已知成员求交集：只发给"报名者"这条不变量不能被
    // 一次提示注入绕过成"发给任意 QQ"（2026-09-28 审查 P3）。
    // 名单项支持 QQ 号或群名片——模型在消息里看得到名片、看不到号（2026-09-29 实测：
    // 用户说"就我们四个玩"时模型没法指定名单，默认会把最近发言的 9 人都卷进局）
    const resolvePlayer = (p) => {
      // 容错：工具层传的是 {userId, name}，直接调用（脚本/测试）时也可能只传一个字符串
      const uid = String((typeof p === 'string' ? p : p?.userId) ?? '').trim();
      const name = String((typeof p === 'string' ? p : (p?.name ?? p?.userId)) ?? '').trim();
      // 精确 userId 优先（QQ 号是纯数字，但不强制：脚本/非 QQ 适配器也可能用字符串 id）
      if (uid && activeIds.has(uid)) return { userId: uid, name: name || uid };
      const hit = idByName.get(name);
      return hit ? { userId: hit, name: name || hit } : null;
    };
    // 人数上限：控制台设的与插件自身上限取较小值（以前 UI 那个输入框是死配置）。
    // 再夹一次下限：控制台允许填到 2，而狼人杀最少 6 人——上限小于下限时报名制会
    // "先报满、再说人数不够"，这局永远开不出来且看不出去配置哪里错（2026-09-29 审查 P2）。
    const playerCap = Math.max(plugin.meta.minPlayers, Math.min(plugin.meta.maxPlayers, cfg.maxPlayers || plugin.meta.maxPlayers));
    const picked = requested ? requested.map(resolvePlayer).filter(Boolean) : active;
    // 同一个人可能被模型写两遍（QQ 号 + 名片，或重复名片）→ 按 userId 去重，
    // 否则他会拿到多张身份、胜负面全乱（2026-09-29 审查 P1）
    const roster = [...new Map(picked.map((p) => [p.userId, p])).values()].slice(0, playerCap);
    if (roster.length < plugin.meta.minPlayers) {
      // 报错要分清"名单对不上"和"群里活跃的人本来就不够"——否则模型给了 7 个人、
      // 却看到"最近发过言的群友只有 0 个"，会以为群里没人（2026-09-29 审查）
      return {
        ok: false,
        error: requested
          ? `${plugin.meta.name}至少要 ${plugin.meta.minPlayers} 个玩家：你给的名单里只有 ${roster.length} 个能用`
            + (requested.length > roster.length && roster.length === playerCap
              ? `——是被「每局人数上限 ${playerCap}」截断了，去控制台调大它`
              : '（名单要传 QQ 号，或与最近活跃成员一字不差的群友名；对不上的会被丢掉）')
          : `${plugin.meta.name}至少要 ${plugin.meta.minPlayers} 个最近发过言的群友（现在只有 ${roster.length} 个`
            + `${active.length > roster.length ? `——每局人数上限 ${playerCap} 把名单截断了，去控制台把「每局人数上限」调大` : ''}）`
      };
    }
    // 报名制（设计稿 §3.1）：需要私聊的游戏默认先挂报名，够人数才发牌 ——
    // 名单取"最近发言者"会把只是插句话的围观者直接拉进局、还给他发身份私聊（2026-09-29 模拟发现）。
    // 模型显式给了 players（"就我们四个玩"）就跳过报名，直接发牌。
    if (cfg.recruitSeconds > 0 && plugin.meta.needsPrivate && !requested) {
      const last = this.store.recent(chatKey, { limit: 1, includeSelf: true });
      const state = {
        phase: 'recruiting',
        joiners: [],
        recruitUntil: now + cfg.recruitSeconds * 1000,
        minPlayers: plugin.meta.minPlayers,
        maxPlayers: playerCap,
        gameName: plugin.meta.name
      };
      this.games.set(chatKey, {
        gameId: plugin.meta.id,
        // 每局唯一：终局播报的幂等键用它。不能用 gameId —— 那是游戏类型，
        // 同一个群第二局会被第一局的 sent 记录挡住，终局播报永久静默（2026-10-31 审查 P0）。
        instanceId: crypto.randomUUID(),
        state,
        startedAt: now,
        lastSeenId: last.length ? Number(last[0].id) || 0 : 0,
        deadlineAt: now + cfg.recruitSeconds * 1000 + Math.min(Number(cfg.maxDurationMin) || 60, plugin.meta.maxDurationMin || 60) * 60000,
        recruiting: true
      });
      this.#save();
      await this.#applyEffects(chatKey, [{
        type: 'public',
        text: `📣 ${plugin.meta.name}报名中：想玩的在群里发一句「我玩」或「报名」（够 ${plugin.meta.minPlayers} 人开局，`
          + `${cfg.recruitSeconds} 秒后截止；人不够就散了）。`
      }]);
      return { ok: true, text: `已开始报名：${plugin.meta.name}（${cfg.recruitSeconds} 秒内够 ${plugin.meta.minPlayers} 人开局）` };
    }
    return this.#dealNow(chatKey, plugin, roster, cfg, { today, used, now });
  }

  /** 发牌开局（报名够了/显式名单/不需要私聊的游戏都走这里）。 */
  async #dealNow(chatKey, plugin, roster, cfg, { today = dayIndex(this.now()), used = 0, now = this.now() } = {}) {
    const state = plugin.create({
      players: roster, rng: this.rng, now,
      reveal: cfg.revealWords, discussSeconds: cfg.discussSeconds, roundSeconds: cfg.roundSeconds
    });
    // 不带 readOnly：触发开局的那些消息此刻还是 leased，取 readOnly 会拿到更小的 id，
    // 下一轮 tick 会把它们再喂一遍（2026-09-28 审查 P3）
    const last = this.store.recent(chatKey, { limit: 1, includeSelf: true });
    const item = {
      gameId: plugin.meta.id,
      instanceId: crypto.randomUUID(),
      state,
      startedAt: now,
      lastSeenId: last.length ? Number(last[0].id) || 0 : 0,
      // 时长上限 = min(配置, 游戏自身上限)：之前直接用插件值，config.maxDurationMin 形同虚设
      deadlineAt: now + Math.min(Number(cfg.maxDurationMin) || 60, plugin.meta.maxDurationMin || 60) * 60000
    };
    // 私聊水位初始化：不写的话兜底扫描从 afterId=0 扫起，会把上一局的历史私聊
    // （旧行动、旧的"不玩了"）当本局行动重放（2026-09-29 审查 P0）
    if (plugin.meta.needsPrivate) {
      item.privateSeen = {};
      for (const p of roster) {
        const key = `private:${p.userId}`;
        const lastOne = this.store.recent(key, { limit: 1 });
        item.privateSeen[p.userId] = lastOne.length ? Number(lastOne[0].id) || 0 : 0;
      }
    }
    this.games.set(chatKey, item);
    this.daily.set(chatKey, { dayKey: today, count: used + 1 });
    this.#save();

    const applied = await this.#applyEffects(chatKey, typeof plugin.openingEffects === 'function'
      ? plugin.openingEffects(state)
      : [
        ...(plugin.meta.id === 'undercover'
          ? [{ type: 'public', text: `🕵️ 谁是卧底开局（第 ${used + 1} 局 / 今日）：${roster.length} 人 —— `
              + roster.map((p, i) => `${i + 1}=${sanitizeUserText(String(p.name || p.userId))}`).join('、')
              + '。词已私聊给大家（没收到就悄悄说一声），别直接说出来；投票发「投 3」或「投 @他」。' }]
          : [{ type: 'public', text: `💣 数字炸弹开局：1~100 里藏了一个数，谁踩中谁输。直接发你猜的数字就行。` }]),
        ...(state.roles
          ? state.roles.map((r) => ({ type: 'private', userId: r.userId, text: `【谁是卧底】你的词是「${r.word}」。用一句话描述它（别说得太直白），**想描述就在群里发，不用等点名**。` }))
          : [])
      ]);
    // 成功/失败分开报给模型：之前只有失败计数，模型会把"部分成功"说成"全都没收到"
    // （2026-09-29 实测：管理员明明收到了词，模型却说"你们应该一条都没收到"）
    const people = applied?.privatePeople || 0;
    const failed = applied?.privateFailed || 0;
    const text = `已开局：${plugin.meta.name}（${roster.length} 人）`
      + (plugin.meta.needsPrivate ? `，私聊已送达 ${people} 人` : '')
      + (failed
        ? `；有 ${failed} 人没发出去 —— 对方不在私聊白名单（或被管理员屏蔽）。`
          + '两个办法：① 把想玩的人加进「聊天白名单 → 私聊」（推荐顺手加好友，最稳）；'
          + '② 或在群游戏设置里打开「游戏期间私聊豁免（只对局内玩家）」。'
          + '先别重发，谁说没收到就单独补发给谁'
        : '');
    return { ok: true, text };
  }

  async stop(chatKey, reason = '人工中止') {
    const g = this.games.get(chatKey);
    if (!g) return { ok: false, error: '这个群没有进行中的游戏' };
    const name = PLUGINS.get(g.gameId)?.meta.name || g.gameId;
    const recruiting = g.recruiting === true;
    this.games.delete(chatKey);
    this.#save();
    await this.#applyEffects(chatKey, [{ type: 'public', text: recruiting ? `${name}报名取消。` : `${name}到此为止（${reason}）。` }]);
    return { ok: true };
  }

  /** 处理一批新消息（由 tick 从 store 拉取，不侵入实时链路）。 */
  async handleNewMessages(chatKey) {
    const g = this.games.get(chatKey);
    if (!g) return;
    const plugin = PLUGINS.get(g.gameId);
    if (!plugin) { this.games.delete(chatKey); this.#save(); return; }
    // 按 lastSeenId 增量取（上限 400）：固定"最新 40 条"的窗口在积压超过 40 条时
    // 会静默丢掉最老的票/猜测，而 lastSeenId 又被推到最新，下一轮不再补
    // （2026-09-29 审查 P2；重启补课 + 实时消息叠加时最容易触发）
    // 同上：白天/投票的消息可能还在模型那边跑（leased），只看 acked 会丢票
    const rows = this.store.recent(chatKey, { limit: 400, includeSelf: true, afterId: Number(g.lastSeenId || 0) });
    if (!rows.length) return;
    let state = g.state;
    const effects = [];
    for (const m of rows) {
      // 群聊的引用/@昵称可能还在后台富化：先停在它这里，别把占位正文喂给插件，
      // 也别把 lastSeenId 推过去（投票“投 @他”必须等 @昵称解析完）。
      if (m.state === 'deferred') break;
      g.lastSeenId = Math.max(Number(g.lastSeenId || 0), Number(m.id));
      if (m.self) continue;
      // "来晚了"提示：局开了以后，没在册的人发"我玩/报名"要有个回音（以前是默默忽略，
      // 人家以为报上了）。同一人每局只提醒一次。
      const uid = String(m.senderId || '');
      const cleanText = stripQuotePrefix(m.text);
      const inRoster = (state.roles || []).some((r) => String(r.userId) === uid);
      if (!inRoster && plugin.meta.needsPrivate && JOIN_RE.test(cleanText) && !JOIN_NEG_RE.test(cleanText)) {
        state.lateNoticed = Array.isArray(state.lateNoticed) ? state.lateNoticed : [];
        if (!state.lateNoticed.includes(uid)) {
          state.lateNoticed.push(uid);
          effects.push({ type: 'public', text: `👋 ${sanitizeUserText(String(m.senderName || uid))} 来晚了一步 —— 这局已经开了（${(state.roles || []).length} 人在玩），等下一局吧。` });
        }
        continue;   // 这条不喂插件（局外人本来就不参与判定）
      }
      const out = plugin.onMessage(state, {
        userId: String(m.senderId || ''),
        name: sanitizeUserText(String(m.senderName || '')),
        text: cleanText,
        ts: Number(m.ts) || this.now()
      }, { now: this.now(), deadline: g.deadlineAt });
      state = out.state;
      effects.push(...(out.effects || []));
      if (state.phase === 'ended') break;
    }
    g.state = state;
    this.#save();
    if (effects.length) await this.#applyEffects(chatKey, effects);
    if (state.phase === 'ended') {
      // 播报失败时 #applyEffects 会把 pendingEnd 挂在局上 —— 此时不能删局，
      // 交给下个 tick 开头的重试分支送达后收尾（2026-10-10 审查 P1-1：猜中炸弹/
      // 投票终局都走这条路，原来这里无条件删局会把终局播报永久丢掉）
      if (this.games.get(chatKey)?.pendingEnd) {
        this.#save();
        this.log(`[group-game] ${chatKey} 终局播报未送达，下个 tick 重试`);
      } else {
        this.games.delete(chatKey);
        this.#save();
      }
    }
  }

  async tick() {
    // 重入锁：tick 内部会 await 发送（协议端慢时单次能超过 20 秒的定时间隔），
    // 两个 tick 交错进同一局会重复发"来晚了一步"、甚至双份发牌（2026-09-29 审查 P2）
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#tickOnce();
    } finally {
      this.#ticking = false;
    }
  }

  async #tickOnce() {
    const cfg = this.#cfg();
    if (!cfg.enabled) {
      if (this.games.size) {
        const dropped = this.games.size;
        this.games.clear();
        this.#save();
        this.log(`[group-game] 群游戏已关闭：清掉 ${dropped} 局进行中的游戏`);
      }
      return;
    }
    for (const [chatKey, g] of [...this.games.entries()]) {
      try {
        if (g.recruiting) { await this.#collectRecruiting(chatKey); continue; }
        if (!cfg.chats.includes(chatKey)) {
          this.games.delete(chatKey);
          this.#save();
          this.log(`[group-game] ${chatKey} 已不在白名单，进行中的局就地结束`);
          continue;
        }
        // 上次终局播报没送出去：先重试播报，送达了才收尾（2026-10-10 审查 C1）
        if (g.pendingEnd) {
          // 退避（2026-10-12 审查）：原来每个 tick（20 秒）都试一次，协议端长时间发不出去时
          // 反复打日志/重试。改成 20s→40s→…→10 分钟封顶；退避点在 g 上、随 #save() 落盘，
          // 重启后不会立刻重打。
          if (Number(g.pendingEndRetryAt) > this.now()) continue;
          const name = PLUGINS.get(g.gameId)?.meta.name || '游戏';
          const idemKey = `game:${chatKey}:${g.instanceId || g.startedAt || crypto.randomUUID()}`;
          const began = this.effects?.begin({
            kind: 'game-final',
            chatKey,
            idemKey,
            detail: { gameId: g.gameId || '', instanceId: g.instanceId || '' }
          });
          if (began && (began.action === 'done' || began.action === 'review')) {
            // 已送达（done）或上次结果未知（review）：都不再发，直接收尾
            if (began.action === 'review') this.log(`[group-game] ${chatKey} 终局播报上次结果未知，停止自动重试`);
            delete g.pendingEnd;
            delete g.pendingEndRetryAt;
            delete g.pendingEndRetryAttempts;
            this.games.delete(chatKey);
            this.#save();
            continue;
          }
          if (began && began.action === 'in-flight') continue;
          const effectId = began?.id || null;
          try {
            await this.sender.sendTextBatch(chatKey, [`${name}结束：${g.pendingEnd}`.slice(0, 500)], { runId: effectId });
            if (effectId) this.effects.settle(effectId, 'sent', { retried: true });
          } catch (error) {
            // 与发送队列同一口径：能证明没送达才算 failed；否则未知，绝不自动重发
            const uncertain = effectId ? this.store.hasUncertainEffects(effectId) : true;
            if (effectId) {
              this.effects.settle(effectId, uncertain ? 'unknown' : 'failed', {
                error: String(error?.message ?? error).slice(0, 200)
              });
            }
            const attempts = Math.min(20, (Number(g.pendingEndRetryAttempts) || 0) + 1);
            g.pendingEndRetryAttempts = attempts;
            g.pendingEndRetryAt = this.now() + Math.min(20000 * 2 ** (attempts - 1), 10 * 60 * 1000);
            this.#save();
            this.log(`[group-game] ${chatKey} 终局播报重试失败（第 ${attempts} 次，${Math.round((g.pendingEndRetryAt - this.now()) / 1000)}s 后再试）:`, error);
            continue;
          }
          delete g.pendingEnd;
          delete g.pendingEndRetryAt;
          delete g.pendingEndRetryAttempts;
          this.games.delete(chatKey);
          this.#save();
          continue;
        }
        if (this.now() >= g.deadlineAt) {
          await this.#applyEffects(chatKey, [{ type: 'end', result: '时间到了，这局就先到这里。' }]);
          if (this.games.get(chatKey)?.pendingEnd) {
            this.#save();   // pendingEnd 要落盘，重启后也能续上重试
            this.log(`[group-game] ${chatKey} 终局播报未送达，下个 tick 重试`);
            continue;
          }
          this.games.delete(chatKey);
          this.#save();
          continue;
        }
        await this.handleNewMessages(chatKey);
        const cur = this.games.get(chatKey);
        if (!cur) continue;
        // 终局挂起（播报未送达）：不再推进 onTick / 私聊兜底，等下个 tick 的重试分支送达后收尾
        if (cur.state.phase === 'ended') continue;
        // 私聊行动通道的兜底扫描（入口已接管过的不重复：按每人水位增量取）
        await this.#collectPrivateActions(chatKey);
        const cur2 = this.games.get(chatKey);
        if (!cur2) continue;
        const plugin = PLUGINS.get(cur2.gameId);
        const out = plugin.onTick(cur2.state, { now: this.now(), deadline: cur2.deadlineAt });
        cur2.state = out.state;
        if (out.effects?.length) await this.#applyEffects(chatKey, out.effects);
        // 落盘放在发送之后：这条路以前只在 phase==='ended' 时存，重启会把最后一个阶段迁移吞掉
        // （重复"天亮了"、重复夜行动提示）。放发送后是刻意的——崩在中间只会让重启重播一次（自愈），
        // 反过来"先存后发"则会让"天亮了"这类播报永久丢失（2026-09-29 审查 P1）
        this.#save();
        if (cur2.state.phase === 'ended') {
          if (cur2.pendingEnd) {
            this.#save();
            this.log(`[group-game] ${chatKey} 终局播报未送达，下个 tick 重试`);
          } else {
            this.games.delete(chatKey);
            this.#save();
          }
        }
      } catch (error) {
        this.log(`[group-game] ${chatKey} 推进出错（跳过这一轮）:`, error);
      }
    }
  }

  /** 引擎发出的游戏私聊要登记 message id：ingest 落库时据此打 eventKind='game-secret'，
   *  提示词构建时再过滤掉（模型在私聊里不该看到身份/查验结果/行动回执）。 */
  #ticking = false;
  #secretMids = new Map();
  isSecretSelfMessage(chatKey, messageId) {
    const mid = String(messageId ?? '').trim();
    if (!mid) return false;
    return this.#secretMids.has(`${chatKey}|${mid}`);
  }
  #noteSecretMid(chatKey, messageId) {
    const mid = String(messageId ?? '').trim();
    if (!mid) return;
    this.#secretMids.set(`${chatKey}|${mid}`, this.now());
    if (this.#secretMids.size > 500) {
      const cutoff = this.now() - 6 * 3600 * 1000;
      for (const [k, ts] of this.#secretMids) if (ts < cutoff) this.#secretMids.delete(k);
    }
  }

  async #applyEffects(chatKey, effects) {
    const cfg = this.#cfg();
    let privateFailed = 0;
    let privateOk = 0;
    const privateUsers = new Set();
    for (const effect of effects) {
      try {
        if (!effect) continue;
        if (effect.type === 'public' && effect.text) {
          await this.sender.sendTextBatch(chatKey, [String(effect.text).slice(0, 500)], {});
        } else if (effect.type === 'private' && effect.text) {
          const uid = String(effect.userId || '');
          if (!cfg.allowPrivateInvite) {
            privateFailed += 1;
            this.log('[group-game] 跳过私聊消息（未开启「允许私聊发身份」）');
            continue;
          }
          // 游戏期间豁免（开关开启时）：只对**本局在册玩家**放宽私聊白名单；不在册一律不发，
          // 免得一次提示注入就把词/身份发给任意 QQ（把关放在这里，而不是只靠插件自觉）
          const roster = new Set((this.games.get(chatKey)?.state?.roles || []).map((r) => String(r.userId)));
          const gameScoped = cfg.allowGamePrivateDm && roster.has(uid);
          const res = await this.sender.sendTextBatch(`private:${uid}`, [String(effect.text).slice(0, 500)], {
            ...(gameScoped ? { gameScoped: true } : {}),
            // 身份/查验结果/行动回执：从落库那一刻就标成 game-secret（不进模型上下文）
            eventKind: 'game-secret'
          });
          // 登记这条私聊的 message id → 落库时标成 game-secret，不进模型上下文
          for (const s of (res?.sent || [])) this.#noteSecretMid(`private:${uid}`, s?.messageId);
          privateOk += 1;
          privateUsers.add(uid);
        } else if (effect.type === 'wake' && this.wake) {
          this.wake(chatKey, Number(effect.delayMs) || 60000, String(effect.note || ''), { kind: 'game' });
        } else if (effect.type === 'end') {
          const g = this.games.get(chatKey);
          const name = PLUGINS.get(g?.gameId)?.meta.name || '游戏';
          // 没有 g 的孤儿 end 用随机键（只留痕，不参与去重）；正常路径一定带 instanceId
          const gameKey = g ? (g.instanceId || g.startedAt || crypto.randomUUID()) : crypto.randomUUID();
          const idemKey = `game:${chatKey}:${gameKey}`;
          const began = this.effects?.begin({
            kind: 'game-final',
            chatKey,
            idemKey,
            detail: { gameId: g?.gameId || '', instanceId: g?.instanceId || '' }
          });
          if (began && began.action === 'done') {
            // 这一局的终局播报已经送达过（另一条路径/上一命）→ 不重复发
            if (g) delete g.pendingEnd;
            continue;
          }
          if (began && began.action === 'review') {
            // 上次结果未知：保留 pendingEnd 让重试分支按"未知"收尾，不再发送
            if (g) g.pendingEnd = String(effect.result || '');
            this.log(`[group-game] ${chatKey} 终局播报上次结果未知，停止自动重试`);
            continue;
          }
          if (began && began.action === 'in-flight') {
            // 另一条路径正在发这局的终局播报：挂起 pendingEnd，下个 tick 按账本 done/review 收尾，
            // 不能直接丢弃（否则调用方看到没有 pendingEnd 就把局删了，播报静默消失）
            if (g) {
              g.pendingEnd = String(effect.result || '');
              g.pendingEndRetryAt = this.now() + 20000;
            }
            continue;
          }
          const effectId = began?.id || null;
          try {
            await this.sender.sendTextBatch(
              chatKey,
              [`${name}结束：${String(effect.result || '')}`.slice(0, 500)],
              { runId: effectId }
            );
            if (effectId) this.effects.settle(effectId, 'sent');
            if (g) delete g.pendingEnd;
          } catch (error) {
            // 终局播报发不出去不能把局就地删掉 —— 挂起 pendingEnd 下个 tick 重试（2026-10-10 审查 C1）
            // 但"结果未知"不再重发：账本记 unknown，重试分支看到 review 就收尾。
            const uncertain = effectId ? this.store.hasUncertainEffects(effectId) : true;
            if (effectId) {
              this.effects.settle(effectId, uncertain ? 'unknown' : 'failed', {
                error: String(error?.message ?? error).slice(0, 200)
              });
            }
            if (g) g.pendingEnd = String(effect.result || '');
            throw error;
          }
        }
      } catch (error) {
        if (effect.type === 'private') privateFailed += 1;
        this.log('[group-game] 效果发送失败:', error);
      }
    }
    return { privateFailed, privateOk, privatePeople: privateUsers.size };
  }
}
