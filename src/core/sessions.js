// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json（老归档压缩后为 <id>.json.gz）；索引落盘在
// data/sessions/.sessions-index.jsonl（追加式摘要日志），启动只读它，不再全量解析留档。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DATA_DIR, getConfig } from './config.js';
import { estimateCost } from '../llm/llm.js';
import { vendorOfConfig } from '../pricing/model-prices.js';
import { todayKey } from './util.js';
import { isSessionFileName, sessionIdOfFile, listSessionFiles, readSessionFile } from './session-files.js';

const gzipAsync = promisify(zlib.gzip);
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// 摘要索引（追加式 JSONL）。隐藏名 + 不是 .json 后缀，不会被留档扫描当成会话文件。
const INDEX_FILE = path.join(SESSIONS_DIR, '.sessions-index.jsonl');
const INDEX_FORMAT = 1;

// 本模块固定指向自己的留档目录（session-files.js 本身不绑定目录，好让 ops 复用）。
const sessionFiles = () => listSessionFiles(SESSIONS_DIR);

/**
 * 列举失败返回 null（与"目录为空"区分）。调用方在 null 时必须放弃本轮清理/压实：
 * 把 EACCES/EBUSY 当成"文件全被删了"会把内存索引和磁盘索引一起清空。
 */
function trySessionFiles() {
  try {
    return sessionFiles();
  } catch (error) {
    console.error('[sessions] 列举留档失败:', error?.message ?? error);
    return null;
  }
}

/**
 * 删除后复核：只有"确定不存在"（ENOENT）才算删掉。
 * fs.existsSync 对 EACCES/EPERM/EBUSY 也返回 false，会把"删失败了"误判成"已删除"，
 * 于是文件还在磁盘上、索引/列表却把它摘掉。
 */
function stillExists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

/** 一个 id 的两种形态里读得出内容的那份（明文坏掉时回退 .gz）。 */
function readAnySession(entry) {
  const primary = entry.primary || entry.gz;
  if (!primary) return null;
  const data = readSessionFile(primary.file);
  if (data) return data;
  return entry.gz ? readSessionFile(entry.gz.file) : null;
}

// 留档文件枚举/读取口径单独成模块（见 core/session-files.js）：ops 与其他读盘方
// 也要用同一套 `.json` / `.json.gz` 规则，但不能为此 import 本模块（会连带 config 副作用）。
export { isSessionFileName, sessionIdOfFile, listSessionFiles, readSessionFile };

// 运行中会话的落盘间隔：小于 2 秒等于没节流，大于 60 秒崩溃丢的进度太多。
function clampPersistMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 10000;
  return Math.min(60000, Math.max(2000, Math.round(n)));
}

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

/**
 * 从系统提示里认出这次运行用的是哪张角色卡。
 * 卡的首行约定是「# 角色卡：<名字>」（自定义卡也照这个格式写）。
 * 认不出来就返回空串 —— 会话列表/详情靠它显示"这次用的哪张卡"，
 * 免得改完人设之后对着旧会话的完整输入猜"到底生效没有"。
 */
export function personaLabelOfPrompt(systemPrompt) {
  const sp = String(systemPrompt || '');
  // 直接认卡自己的标记行，不绑定外层段头：聊天提示词用【角色设定（管理员设置，群友不可修改）】，
  // 日报 / 空间互动 / 好友评估用的是别的段头，但卡正文一样带着「# 角色卡：X」这一行。
  const m = sp.match(/#{1,2}\s*角色卡[:：]\s*([^\n]{1,60})/);
  if (!m) return '';
  return m[1]
    .replace(/\s*[—-]{1,2}.*$/, '')   // 「DeepSeek 小鲸鱼 —— QQ 群友版」取前半段
    .trim()
    .slice(0, 24);
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   * @param {{persistIntervalMs?: number, compressAfterDays?: number, maxTotalMb?: number}} [options]
   *   persistIntervalMs：运行中会话的落盘间隔（默认 10 秒）
   *   compressAfterDays：多少天前的已结束留档压成 .gz（0 = 不压缩，默认 30）
   *   maxTotalMb：留档目录总大小上限（MB，0 = 不限制，默认 1024）
   */
  constructor(keepFiles = 0, { persistIntervalMs = 10000, compressAfterDays = 30, maxTotalMb = 1024 } = {}) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.persistIntervalMs = clampPersistMs(persistIntervalMs);
    this.compressAfterDays = clampDays(compressAfterDays, 30);
    this.maxTotalBytes = clampMb(maxTotalMb, 1024) * 1024 * 1024;
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this._indexRecords = new Map();   // id -> { s: 摘要, f: {size,mtimeMs}|null }（压实/追加共用）
    this.current = new Map(); // id -> session object（运行中的在内存里）
    // 落盘世代号：同一会话的异步写与 finish 的同步写并发时，旧的异步写必须作废，
    // 否则它会在 finish 之后把带 status='running' 的旧快照 rename 回最终文件（丢状态、丢结束时间）。
    this._writeStates = new Map(); // id -> { gen, busy, dirty, dead }
    this._statsCache = null;
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    this.#cleanupTmp();
    this.#loadIndex();
    this.pruneSessions();   // 与运行台账同款：构造时清一次（常驻期间每日调度再跑）
  }

  /** 控制台保存后即时生效，不必重启。 */
  setPersistIntervalMs(ms) { this.persistIntervalMs = clampPersistMs(ms); }

  /** 存储策略随配置热更新（压缩天数 / 总量预算）；不重建索引。 */
  setStoragePolicy({ compressAfterDays, maxTotalMb } = {}) {
    if (compressAfterDays !== undefined) this.compressAfterDays = clampDays(compressAfterDays, this.compressAfterDays);
    if (maxTotalMb !== undefined) this.maxTotalBytes = clampMb(maxTotalMb, this.maxTotalBytes / (1024 * 1024)) * 1024 * 1024;
    this._statsCache = null;
  }

  /**
   * 清掉写盘崩溃留下的临时文件（`*.json.<pid>[.<gen>].tmp`）。
   * 一小时内的不动：可能属于另一个正在写的进程/实例。不清理的话这些文件
   * 永远不参与保留期与预算（不在留档枚举里），磁盘只增不减。
   */
  #cleanupTmp() {
    try {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const name of fs.readdirSync(SESSIONS_DIR)) {
        if (!name.endsWith('.tmp')) continue;
        const file = path.join(SESSIONS_DIR, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
        } catch { /* 被别的进程删了 */ }
      }
    } catch { /* 列举失败不阻断启动 */ }
  }

  /**
   * 建立内存索引（启动唯一入口）。
   *
   * 历史做法是 readdir + 逐个 JSON.parse 全部留档：1312 个文件 / 111MB 文本要 3.1 秒，
   * 且完全同步，直接顶在启动路径上（2026-10-30 实测）。现在优先读追加式摘要日志：
   *   - 命中索引 → 只解析"索引里没有的文件"与"元信息变了/上次没跑完"的少数几张；
   *   - 没有索引/索引损坏 → 一次性全量扫描（老用户首次升级），扫完马上写索引；
   *   - 索引里有、磁盘上已没有的条目直接丢弃（外部删除/手工清理自愈）；
   *   - 外部新放进来的文件（恢复备份）会被单独解析并补进索引，不会从列表里消失。
   *
   * 索引行里除摘要外还记 `f:{size,mtimeMs}`：启动时只 stat 不 parse，元信息对得上就信任摘要。
   * 这样"终态写失败但索引已追加成功"（列表说 done、文件还是 running）也能在下次启动被发现并修正 ——
   * 否则那条记录会永远卡在 running：既不压缩、也不按保留期/预算回收。
   */
  #loadIndex() {
    const files = trySessionFiles();
    if (!files) {
      // 列举失败（EACCES/EBUSY/EMFILE…）不能当成"目录真的空了"——那会把索引压实成空文件。
      console.error('[sessions] 读取留档目录失败，本次启动保留空索引、不重写磁盘索引');
      return;
    }
    // 同一 id 的 .json 与 .json.gz 并存时优先未压缩那份（压缩收尾崩溃的残留）；
    // 但明文坏掉时要能回退读 .gz，所以两种形态都留着。
    const byId = new Map();   // id -> { primary?, gz? }
    for (const f of files) {
      const cur = byId.get(f.id) || {};
      if (f.compressed) cur.gz = f;
      else cur.primary = f;
      byId.set(f.id, cur);
    }
    const pick = (entry) => entry.primary || entry.gz;

    const cached = this.#readIndexLog();
    this._indexLines = cached?.lines || 0;
    const records = cached?.map ?? new Map();   // id -> { s: 摘要, f: {size,mtimeMs}|null }
    let dirty = cached === null;

    for (const id of [...records.keys()]) {
      if (!byId.has(id)) { records.delete(id); dirty = true; }
    }

    // 元信息校验：文件在上次写索引后又变过（运行中被杀、终态写失败、外部改写）→ 重读这一份。
    // 正常情况下这里只有 0–2 个文件不一致。
    for (const [id, rec] of records) {
      const entry = byId.get(id);
      if (!entry) continue;
      const meta = rec.f;
      if (meta && Number.isFinite(Number(meta.size))) {
        let stat;
        try { stat = fs.statSync(pick(entry).file); } catch { continue; }
        if (stat.size === Number(meta.size) && Math.abs(stat.mtimeMs - Number(meta.mtimeMs)) < 2) continue;
      }
      // 没有元信息 = 上次写盘失败后的索引行（或 stat 失败）：必须读文件确认，不能信任摘要。
      const data = readAnySession(entry);
      if (!data?.id) continue;
      rec.s = this.#summary(data);
      rec.f = this.#fileMeta(id);
      dirty = true;
    }

    // 索引里没有的文件：首次升级（cached === null）时是全部，之后只有外部放入的。
    for (const [id, entry] of byId) {
      if (records.has(id)) continue;
      const data = readAnySession(entry);
      if (!data?.id) continue;
      records.set(id, { s: this.#summary(data), f: this.#fileMeta(id) });
      dirty = true;
    }

    // 硬崩溃残留的 running/waiting：必须读原文件才能确认（索引里的状态只是上次写的摘要），
    // 而进程刚起来不可能有真的在跑的会话；不回收的话控制台会一直显示"运行中"。
    for (const [id, rec] of records) {
      if (rec.s.status !== 'running' && rec.s.status !== 'waiting') continue;
      const entry = byId.get(id);
      if (!entry) continue;
      const data = readAnySession(entry);
      if (!data?.id) continue;
      if (data.status === 'running' || data.status === 'waiting') {
        data.status = 'aborted';
        data.waitUntil = null;
        // endedAt 也要补：控制台的详情头用它区分"· 结束"与"· 进行中"，
        // 只改 status 会出现"中止徽标 + 进行中"同屏矛盾（2026-09-29 审查 P2）。
        data.endedAt = data.endedAt ?? Date.now();
        data.abortedAt = Date.now();
        const repaired = this.#writeSessionFileSync(sessionFile(id), data);
        if (repaired && entry.gz) {
          // 读的是压缩归档、写回的是明文：删掉旧归档，避免下次又读到 running 的旧副本。
          // 写回失败时绝不能删 —— 那份 .gz 是唯一还能读的副本。
          try { fs.rmSync(entry.gz.file, { force: true }); } catch { /* ignore */ }
        }
        if (!repaired) {
          // 写回失败：内存里虽然改成了 aborted，但磁盘上仍是 running。
          // 不能把"已修正"写进索引（否则下次启动 stat 匹配、永远不再重试），
          // 保持原摘要并置 f=null 强制下次重读重试。
          rec.f = null;
          dirty = true;
          continue;
        }
      }
      rec.s = this.#summary(data);      // 用真实 usage/结束时间刷新摘要
      rec.f = this.#fileMeta(id);       // 写回后元信息也变了
      dirty = true;
    }

    this._indexRecords = records;
    this.index = [...records.values()].map((rec) => rec.s).sort(compareSummaryDesc);
    // 索引行数明显多于有效条目（历次追加/删除的沉淀）就在启动时压实一次
    if (dirty || (cached && cached.lines > this.index.length * 2 + 500)) this.#compactIndex();
  }

  /** 读追加式索引日志；不存在/全是坏行返回 null（触发全量重建）。 */
  #readIndexLog() {
    let text = '';
    try { text = fs.readFileSync(INDEX_FILE, 'utf8'); } catch { return null; }
    const map = new Map();   // id -> { s, f }
    let lines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        const obj = JSON.parse(line);
        const s = obj?.s;
        if (!s?.id) continue;
        const f = obj?.f && Number.isFinite(Number(obj.f.size))
          ? { size: Number(obj.f.size), mtimeMs: Number(obj.f.mtimeMs) || 0 }
          : null;
        map.set(String(s.id), { s, f });
      } catch { /* 半行（崩溃时写了半条）：跳过，下次压实会重写 */ }
    }
    return map.size ? { map, lines } : null;
  }

  /** 整份重写索引（原子替换）。只在启动/压实/大规模变更时调用，不在热路径。 */
  #compactIndex() {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      const body = this.index.map((entry) => {
        // 记录里的 f=null 是"写盘失败、必须重读"的标记，不能被重新 stat 出来的
        // "旧文件元信息"覆盖（那会让下次启动误以为摘要仍然有效）。
        const rec = this._indexRecords?.get(entry.id);
        const f = rec ? rec.f : this.#fileMeta(entry.id);
        return JSON.stringify({ v: INDEX_FORMAT, s: entry, ...(f ? { f } : {}) });
      }).join('\n');
      fs.writeFileSync(tmp, body ? `${body}\n` : '', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, INDEX_FILE);
      // chmod 目标必须是 rename 之后的 INDEX_FILE：对 tmp 做会 ENOENT，
      // 被 catch 吞掉后 _indexLines 永不复位 → 之后每次 append 都全量重写索引。
      try { fs.chmodSync(INDEX_FILE, 0o600); } catch { /* 平台不支持就算了 */ }
      this._indexLines = this.index.length;
    } catch (error) {
      // 索引写不了不影响正确性：下次启动退化为全量扫描
      console.error('[sessions] 索引压实失败:', error?.message ?? error);
    }
  }

  /** 留档文件的 {size,mtimeMs}，用于启动时判断摘要是否过期。 */
  #fileMeta(id) {
    for (const file of [sessionFile(id), `${sessionFile(id)}.gz`]) {
      try {
        const stat = fs.statSync(file);
        return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
      } catch { /* 试下一形态 */ }
    }
    return null;
  }

  /** 文件形态变了（压缩）后刷新索引里的元信息，避免下次启动把它当"过期摘要"再解压一遍。 */
  #refreshIndexMeta(id) {
    const rec = this._indexRecords?.get(String(id));
    if (!rec) return;
    rec.f = this.#fileMeta(id);
    this.#appendIndex(rec.s, rec.f);
  }

  /**
   * 追加一条摘要（create/finish 各一条，约 2 行/次运行）。
   * `meta` 省略（undefined）= 现场 stat；显式传 null = **写盘失败，必须重读**，不能拿旧文件
   * 的 size/mtime 冒充"摘要与文件一致"（否则下次启动会信任错误的 done 摘要）。
   */
  #appendIndex(summary, meta) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
      const f = meta === undefined ? this.#fileMeta(summary.id) : meta;
      const line = JSON.stringify({ v: INDEX_FORMAT, s: summary, ...(f ? { f } : {}) });
      fs.appendFileSync(INDEX_FILE, `${line}\n`, { mode: 0o600 });
      this._indexLines = (this._indexLines || 0) + 1;
      const id = String(summary.id);
      const rec = this._indexRecords?.get(id);
      if (rec) { rec.s = summary; rec.f = f; }
      else this._indexRecords?.set(id, { s: summary, f });   // 新会话也要进记录表，否则压实会重新 stat
      // 常驻进程也要压实：不压实就是又一个无界增长文件。阈值和启动时同一口径。
      if (this._indexLines > Math.max(1000, this.index.length * 2)) this.#compactIndex();
    } catch { /* 索引是缓存，写失败只影响下次启动速度 */ }
  }

  /**
   * 只改写会话文件本身（原子替换 + 0600，紧凑 JSON）。
   * 不走 #persist：它会在"非运行态"时累加今日用量，而启动回收不是一次真实运行，
   * 每重启一次就把这轮用量重复记一次。
   */
  #writeSessionFileSync(file, session) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
      fs.writeFileSync(tmp, JSON.stringify(session), { encoding: 'utf8', mode: 0o600, flush: true });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
      return true;
    } catch (error) {
      console.error('[sessions] 写留档失败:', error?.message ?? error);
      return false;
    }
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      vendor: s.vendor ?? '',
      trigger: s.triggerSummary ?? '',
      triggerKind: s.triggerKind ?? '',
      triggerReason: s.triggerReason ?? s.contextReason ?? '',
      contextTier: s.contextTier ?? null,
      contextLimit: s.contextLimit ?? null,
      contextReason: s.contextReason ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0,
      budgetStopped: s.budgetStopped === true,
      budgetStopReason: s.budgetStopReason ?? '',
      livingMemory: s.livingMemory ?? null,
      burst: s.burst ?? null,
      conversationMode: s.conversationMode ?? 'legacy',
      threadId: s.threadId ?? null,
      threadState: s.threadState ?? null,
      threadOpenedAt: s.threadOpenedAt ?? 0,
      threadIdleDeadline: s.threadIdleDeadline ?? 0,
      threadHardDeadline: s.threadHardDeadline ?? 0,
      threadResumeArmedUntil: s.threadResumeArmedUntil ?? 0,
      threadExpiresAt: s.threadExpiresAt ?? 0,
      threadCloseReason: s.threadCloseReason ?? '',
      promptLayout: s.promptLayout ?? '',
      persona: personaLabelOfPrompt(s.systemPrompt),
      lifecycleContinuation: s.lifecycleContinuation === true,
      callUsage: s.callUsage ?? []
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      triggerKind: '',
      triggerReason: '',
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      injectedMessages: [],
      injectedMessageChars: 0,
      inputMessages: [],
      inputTools: [],
      inputRequestOptions: {},
      inputRound: 0,
      inputPayloadChars: 0,
      inputHasOmittedImages: false,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    const persisted = this.#persist(session);
    const summary = this.#summary(session);
    this.index.unshift(summary);
    // 不在这里按 keepFiles 截断内存索引：截断会让压实丢掉更老条目的摘要，
    // 下次启动把它们当"索引里没有的文件"重新解析（等于白改）。磁盘侧由 finish() 驱逐。
    // 写盘没成功就不写元信息：下次启动看到"无元信息"会重读文件，不会把内存摘要当成事实
    this.#appendIndex(summary, persisted ? this.#fileMeta(session.id) : null);
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    return this.#readStored(id);
  }

  /** 读盘（自动识别压缩归档）：先试 .json，再试 .json.gz。 */
  #readStored(id) {
    const plain = readSessionFile(sessionFile(id));
    if (plain) return plain;
    return readSessionFile(`${sessionFile(id)}.gz`);
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    return this.#readStored(id);
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    // 作废在途的异步写：否则它可能在本函数同步落盘之后把旧的 running 快照 rename 回来
    this.#invalidateWrite(id);
    const persisted = this.#persist(s);
    const summary = this.#summary(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = summary;
    else this.index.unshift(summary);
    this.#appendIndex(summary, persisted ? this.#fileMeta(id) : null);
    // 清理超出保留数的旧文件：与 pruneSessions 同一保护口径 —— 正在跑/等待中的会话不删
    //（长线程会话可能是最"旧"的文件，运行到一半被删会让本轮记录与用量消失），
    // 删掉的同步从内存索引收缩，避免"列表里点开却是空文件"（2026-10-12 审查）。
    this.#enforceKeepFiles();
    return s;
  }

  /**
   * keepFiles 驱逐（finish 后调用）。按 id 升序 = 最旧在前；同一 id 的明文与 .gz 一起删。
   * 状态优先取内存索引（避免为了判"是不是 running"再解析一遍文件），索引里没有才读盘。
   */
  #enforceKeepFiles() {
    if (!(this.keepFiles > 0)) return;
    try {
      const files = sessionFiles();
      const ids = [...new Set(files.map((f) => f.id))].sort();
      if (ids.length <= this.keepFiles) return;
      const statusById = new Map(this.index.map((e) => [String(e.id), e.status]));
      const dropped = new Set();
      for (const id of ids.slice(0, ids.length - this.keepFiles)) {
        let status = statusById.get(id);
        if (!status) {
          const entry = files.find((f) => f.id === id);
          status = entry ? readSessionFile(entry.file)?.status : '';
        }
        if (status === 'running' || status === 'waiting') continue;
        let killed = false;
        let leftover = false;
        for (const f of files) {
          if (f.id !== id) continue;
          try { fs.unlinkSync(f.file); killed = true; } catch { /* 下面复核 */ }
          if (stillExists(f.file)) leftover = true;
        }
        // 两种形态只删掉一份（或一份都没删掉）时不能从索引摘：文件还在，列表会"点开又有"
        if (killed && !leftover) dropped.add(id);
      }
      if (dropped.size) {
        this.index = this.index.filter((e) => !dropped.has(String(e.id)));
        for (const id of dropped) this._indexRecords?.delete(String(id));
        this._statsCache = null;
      }
    } catch { /* ignore */ }
  }

  /**
   * 会话留档保留期（2026-10-10 审查）：默认 90 天（与运行台账 pruneRuns 同口径）。
   * 之前只有 keepFiles>0 才会清、默认 0 = 永不清理 —— 连跑数月就是无界增长（磁盘 +
   * 启动时全量读进内存的 index）。构造时清一次，常驻期间由每日保留期调度
   * （retentionPruneTargets）复用同一方法。正在跑/等待中的会话不删。
   * @returns {{ removed: number, kept: number }}
   */
  pruneSessions(retentionDays = 90) {
    const days = Math.max(1, Number(retentionDays) || 90);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    const files = trySessionFiles();
    if (!files) return { removed, kept: 0 };
    if (!files.length) return { removed, kept: 0 };
    // 同一 id 的明文与 .gz 都留着：明文读不出时回退 .gz，别把能读的数据当成坏文件
    const byId = new Map();   // id -> { primary?, gz? }
    for (const f of files) {
      const cur = byId.get(f.id) || {};
      if (f.compressed) cur.gz = f;
      else cur.primary = f;
      byId.set(f.id, cur);
    }
    const deletedIds = new Set();
    for (const [id, entry] of byId) {
      // 文件名就是会话 id（sessionFile 的口径）；先按 mtime 预筛：最近写过的文件不可能
      // "结束于保留期之前"，不必解析 —— 把每日调度的同步读取量压到只剩旧文件（P3-1）。
      // （启动回收重写过的新 mtime 文件，会在 mtime 老化后的下一轮被清。）
      try {
        const primary = entry.primary || entry.gz;
        if (fs.statSync(primary.file).mtimeMs >= cutoff) continue;
        const data = readAnySession(entry);
        // 读不出内容的旧文件不在这里删：一次瞬时 EACCES/EBUSY 就会变成误删。
        // 它们会由总量预算兜底（预算统计目录下所有文件，超限时按最旧删）。
        if (!data?.id) continue;
        // 正在跑/等待中的不能删（硬崩溃残留会由启动回收改成 aborted，下次就按时间判了）；
        // 其余按"结束时间（缺了用开始时间）"判旧。
        const active = data.status === 'running' || data.status === 'waiting';
        const ended = Number(data.endedAt) || Number(data.startedAt) || 0;
        if (!active && ended && ended < cutoff) {
          let allGone = true;
          for (const f of files) {
            if (f.id !== id) continue;
            try { fs.rmSync(f.file, { force: true }); } catch { /* 下面复核 */ }
            if (stillExists(f.file)) allGone = false;
          }
          // 删不掉的文件仍算保留：不能从索引/列表里摘掉（否则详情能打开、列表却看不见）
          if (!allGone) continue;
          removed += 1;
          deletedIds.add(id);
        }
      } catch { /* 坏文件不动（预算超限时才处理） */ }
    }
    // 总量预算（0 = 不限制）：按"最旧先删"压到上限以内，运行中/等待中永不删。
    const budget = this.#enforceBudget();
    if (removed > 0 || budget.removed > 0) {
      // 只摘掉真正删掉的 id —— 解析失败/stat 失败的文件还在磁盘上，不能从列表里消失
      for (const id of budget.deletedIds) deletedIds.add(id);
      this.index = this.index.filter((e) => !deletedIds.has(String(e.id)));
      for (const id of deletedIds) this._indexRecords?.delete(String(id));
      this._statsCache = null;
    }
    return { removed: removed + budget.removed, kept: Math.max(0, byId.size - deletedIds.size) };
  }

  /**
   * 留档目录总量预算。返回 { removed, deletedIds }。
   * 统计**目录下所有留档文件**（含解析失败、明文 + .gz 两份、压缩归档）：
   * 只统计"能认出来的"会让损坏文件永久占用磁盘，预算是假的。
   * 只在 pruneSessions 里调用（启动一次 + 每日一次），全量 stat 的代价可以接受。
   */
  #enforceBudget() {
    if (!(this.maxTotalBytes > 0)) return { removed: 0, deletedIds: new Set() };
    const files = trySessionFiles();
    if (!files) return { removed: 0, deletedIds: new Set() };
    const perId = new Map();
    for (const f of files) {
      let size = 0;
      try { size = fs.statSync(f.file).size; } catch { continue; }
      const cur = perId.get(f.id) || { bytes: 0, files: [], primary: null, gz: null };
      cur.bytes += size;
      cur.files.push(f.file);
      if (f.compressed) cur.gz = f; else cur.primary = f;
      perId.set(f.id, cur);
    }
    let total = 0;
    for (const v of perId.values()) total += v.bytes;
    const deletedIds = new Set();
    if (total <= this.maxTotalBytes) return { removed: 0, deletedIds };
    const statusById = new Map(this.index.map((e) => [String(e.id), e.status]));
    for (const id of [...perId.keys()].sort()) {   // id 前缀是 base36 时间戳，升序 = 最旧在前
      if (total <= this.maxTotalBytes) break;
      let status = statusById.get(id);
      if (!status) {
        const data = readAnySession({ primary: perId.get(id).primary, gz: perId.get(id).gz });
        status = data?.status || '';
      }
      if (status === 'running' || status === 'waiting') continue;
      const entry = perId.get(id);
      let allGone = true;
      for (const file of entry.files) {
        try { fs.rmSync(file, { force: true }); } catch { /* 下面复核 */ }
        if (stillExists(file)) allGone = false;
      }
      // 有一个删不掉（Windows 上 AV/索引器持句柄很常见）：不扣字节、也不从索引摘掉，
      // 否则文件还在磁盘上、列表却看不见，且这一轮会少删一份。
      if (!allGone) continue;
      total -= entry.bytes;
      deletedIds.add(id);
    }
    return { removed: deletedIds.size, deletedIds };
  }

  /**
   * 把 N 天前结束的留档压成 .gz（默认 30 天，0 = 关闭）。返回 { compressed, bytesBefore, bytesAfter }。
   *
   * 只在每日保留期调度里跑（启动不压：1312 个文件 gzip 要 1–2 秒，会拖慢启动）。
   * 每次最多处理 maxFiles 个，避免一次占满事件循环；没压完的下一轮继续。
   * 顺序是"写 .gz → rename → 删明文"：任何一步崩溃都至少留一份完整文件，
   * 下次启动按 id 去重时优先明文，压缩会在下一轮重试。
   */
  async compressSessions(olderThanDays = this.compressAfterDays, { maxFiles = 100 } = {}) {
    const days = clampDays(olderThanDays, 0);
    if (!(days > 0)) return { compressed: 0, bytesBefore: 0, bytesAfter: 0 };
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let compressed = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;
    const files = trySessionFiles();
    if (!files) return { compressed, bytesBefore, bytesAfter };
    for (const entry of files) {
      if (compressed >= maxFiles) break;
      if (entry.compressed) continue;
      try {
        const stat = fs.statSync(entry.file);
        if (stat.mtimeMs >= cutoff) continue;
        const data = readSessionFile(entry.file);
        if (!data?.id) continue;
        if (data.status === 'running' || data.status === 'waiting') continue;
        const ended = Number(data.endedAt) || Number(data.startedAt) || 0;
        if (ended >= cutoff) continue;
        // 目录里已经有同名 .gz（上次 rename 后崩溃、没删掉明文）：直接删明文即可
        const target = `${entry.file}.gz`;
        if (fs.existsSync(target)) {
          fs.rmSync(entry.file, { force: true });
          this.#refreshIndexMeta(entry.id);
          compressed += 1;
          bytesBefore += stat.size;
          bytesAfter += fs.statSync(target).size;
          continue;
        }
        // 异步 gzip：100 个较大留档同步压缩会把事件循环阻塞数秒到数十秒，
        // 期间入站/SSE/心跳全部停摆。gzipAsync 每次 await 让出事件循环。
        const gz = await gzipAsync(fs.readFileSync(entry.file), { level: 9 });
        const tmp = `${target}.${process.pid}.tmp`;
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        fs.writeFileSync(tmp, gz, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, target);
        // 保留原文件时间：不留的话保留期（按 mtime 预筛）与用量扫描（按 mtime 跳过窗口外）
        // 都会把"刚压过的旧归档"当成最近写过，90 天保留期实际被拉长，用量重算每次多读一批。
        try { fs.utimesSync(target, stat.atime, stat.mtime); } catch { /* ignore */ }
        // 与 discard() 抢跑：读文件之后它可能已被删掉。这时刚写出的 .gz 必须一起删，
        // 否则一个"从未真正开始"的会话会在下次启动时以压缩归档的形态重新出现。
        if (!fs.existsSync(entry.file)) {
          try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
          continue;
        }
        fs.rmSync(entry.file, { force: true });
        this.#refreshIndexMeta(entry.id);
        compressed += 1;
        bytesBefore += stat.size;
        bytesAfter += gz.length;
      } catch { /* 单个文件失败不影响其余 */ }
    }
    if (compressed) this._statsCache = null;
    return { compressed, bytesBefore, bytesAfter };
  }

  /**
   * 留档占用（控制台展示）。缓存 30 秒：/api/status 每 15 秒轮询一次，
   * 而 1300 个文件全量 stat 约 10ms，没必要每次请求都算。
   */
  storageStats({ fresh = false } = {}) {
    if (!fresh && this._statsCache && Date.now() - this._statsCache.at < 30000) {
      return { ...this._statsCache.value };
    }
    let fileCount = 0;
    let compressedFiles = 0;
    let bytes = 0;
    let compressedBytes = 0;
    let oldestAt = 0;
    const files = trySessionFiles();
    if (!files) return this._statsCache ? { ...this._statsCache.value } : {
      files: 0, compressedFiles: 0, bytes: 0, compressedBytes: 0, oldestAt: null,
      keepFiles: this.keepFiles, compressAfterDays: this.compressAfterDays, maxTotalBytes: this.maxTotalBytes
    };
    for (const entry of files) {
      let stat;
      try { stat = fs.statSync(entry.file); } catch { continue; }
      fileCount += 1;
      bytes += stat.size;
      if (entry.compressed) { compressedFiles += 1; compressedBytes += stat.size; }
      if (!oldestAt || stat.mtimeMs < oldestAt) oldestAt = stat.mtimeMs;
    }
    const value = {
      files: fileCount,
      compressedFiles,
      bytes,
      compressedBytes,
      oldestAt: oldestAt || null,
      keepFiles: this.keepFiles,
      compressAfterDays: this.compressAfterDays,
      maxTotalBytes: this.maxTotalBytes
    };
    this._statsCache = { at: Date.now(), value };
    return { ...value };
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    // 与 finish() 同款：节流时间戳要随会话一起清（2026-10-04 全面复审 P3）。
    // 丢弃不写文件、也不进 index，_lastPersistAt 就成了唯一没人回收的按会话键 ——
    // 反复丢弃 waiting 会话（预算降级、时间窗、block 都会走这条路）就只涨不消
    //（实测 50 次丢弃后 Map size = 50，无界）。
    this._lastPersistAt?.delete(id);
    // 作废在途异步写并标记 dead：否则它可能在删除之后把文件重新 rename 出来
    const state = this._writeStates.get(id);
    if (state) {
      state.gen += 1;
      state.dead = true;
      state.dirty = false;
      if (!state.busy) this._writeStates.delete(id);   // 没有在途写就不会再有 settle
    }
    this._indexRecords?.delete(String(id));
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    for (const suffix of ['.json', '.json.gz']) {
      try {
        const f = path.join(SESSIONS_DIR, `${id}${suffix}`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
    this._statsCache = null;
    return this.index.length < before;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    let webSearchCount = 0;
    // 每日预算（改进方案 #8）的当日额度来源：此前这里的返回是 6 个 token 字段的白名单，
    // 漏传 estimatedYuan/unpricedRuns 会让 budgetStatus 永远读到 0（拦截失效，2026-09-30
    // 由集成用例抓到）。
    let estimatedYuan = 0;
    let unpricedRuns = 0;
    let byFeature = {};
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
        webSearchCount = data.webSearchCount || 0;
        estimatedYuan = Number(data.estimatedYuan) || 0;
        unpricedRuns = Number(data.unpricedRuns) || 0;
        byFeature = data.byFeature && typeof data.byFeature === 'object' && !Array.isArray(data.byFeature)
          ? data.byFeature : {};
      }
    } catch { /* 无记录 */ }
    // 加上运行中的。token 与**估算金额**都要加：只加 token 时，并发运行的会话在结束落盘前
    // 不计入当日花费，日预算会被"在途数 × 单次预算"地超出（2026-10-19 全项目审查 P2）。
    // 与 #mergeTodayUsage 同一套估价口径：会话结束时会再按同一份 usage 合并一次，
    // 但那时它已从 this.current 移除，不会重复计。
    for (const s of this.current.values()) {
      const usage = s.usage || {};
      const total = Number(usage.totalTokens) || 0;
      promptTokens += Number(usage.promptTokens) || 0;
      completionTokens += Number(usage.completionTokens) || 0;
      totalTokens += total;
      cachedTokens += Number(usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
      try {
        const cfgNow = getConfig();
        const est = estimateCost({
          promptTokens: Number(usage.promptTokens) || 0,
          completionTokens: Number(usage.completionTokens) || 0,
          totalTokens: total,
          cachedTokens: Number(usage.cachedTokens) || 0
        }, {
          model: s.model || cfgNow.api?.model,
          at: Date.now(),
          vendor: s.vendor || vendorOfConfig(cfgNow)
        });
        const cost = Number(est?.cost) || 0;
        estimatedYuan += cost;
        if (total > 0 && est?.unpriced === true) unpricedRuns += 1;
      } catch { /* 估价失败不影响 token 统计（最坏情况＝这项当天少算） */ }
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount, estimatedYuan, unpricedRuns, byFeature };
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    // 2026-10-06 复审 P3：waiting 会话被 finish 成 aborted（预算 block、并发满、无未读等
    // 早退路径）时 0 token、0 发送 —— 与启动回收"不是一次真实运行就不计"的口径对齐
    //（启动回收为此专门写了不 bump 的 #writeSessionFileSync），这类会话不计 runs，
    // 否则预算 block 期间每条进群消息都虚增一次"运行次数"。
    if (!(Number(s.usage?.totalTokens) > 0) && !(s.sent?.length > 0)) return;
    // 按"结束时刻"归属。用 startedAt 的话，跨零点的会话会把它的数字按开始那天算，发现文件
    // 是另一天就把新一天已累计的量重置成 0；之后当天的会话又因 dayKey 不匹配一直少算。
    this.#mergeTodayUsage({
      promptTokens: Number(s.usage?.promptTokens) || 0,
      completionTokens: Number(s.usage?.completionTokens) || 0,
      totalTokens: Number(s.usage?.totalTokens) || 0,
      cachedTokens: Number(s.usage?.cachedTokens) || 0,
      runs: 1,
      webSearchCount: Number(s.webSearchCount) || 0
    }, { model: s.model, vendor: s.vendor, feature: 'chat' });
  }

  /**
   * 非会话类模型调用（记忆整理、群日报等）计入今日台账：这些调用照样花钱，此前完全没有账
   * —— 控制台"今日花费"与预算判定都偏乐观（2026-10-07 复审 P3）。
   * 与 #bumpTodayUsage 共用同一份文件与估价口径，但不计 runs（不是一次会话运行）。
   */
  recordExternalUsage(usage, { model = '', vendor = '', feature = 'external' } = {}) {
    const totalTokens = Number(usage?.totalTokens) || 0;
    if (!(totalTokens > 0)) return;
    this.#mergeTodayUsage({
      promptTokens: Number(usage.promptTokens) || 0,
      completionTokens: Number(usage.completionTokens) || 0,
      totalTokens,
      cachedTokens: Number(usage.cachedTokens) || 0,
      runs: 0,
      webSearchCount: 0
    }, { model, vendor, feature });
  }

  /** 把一份用量增量并进 usage-today.json（读盘合并 → 估算金额 → 原子落盘）。 */
  #mergeTodayUsage(delta, { model = '', vendor = '', feature = 'chat' } = {}) {
    const dayKey = todayKey(Date.now());
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    if (!data.byFeature || typeof data.byFeature !== 'object' || Array.isArray(data.byFeature)) data.byFeature = {};
    data.promptTokens += delta.promptTokens;
    data.completionTokens += delta.completionTokens;
    data.totalTokens += delta.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + delta.cachedTokens;
    data.runs += delta.runs;
    data.webSearchCount = (data.webSearchCount || 0) + delta.webSearchCount;
    let cost = 0;
    // 估算金额（改进方案 #8/J.3）：按实际模型估价；价格缺失记 0 并计 unpricedRuns
    // —— budgetStatus 会把它暴露给控制台，防"没价＝永远不超限"的静默失效。
    try {
      const cfgNow = getConfig();
      const est = estimateCost({ ...delta }, {
        model: model || cfgNow.api?.model,
        at: Date.now(),
        // 调用方记录过 vendor（兜底模型接管后记实际渠道）就优先用它；
        // 拿当前配置倒推历史是错的（vendorOfConfig 注释同款约定）。
        vendor: vendor || vendorOfConfig(cfgNow)
      });
      cost = Number(est?.cost) || 0;
      data.estimatedYuan = (Number(data.estimatedYuan) || 0) + cost;
      if (delta.totalTokens > 0 && est?.unpriced === true) data.unpricedRuns = (Number(data.unpricedRuns) || 0) + 1;
    } catch { /* 估价失败不影响用量累加（最坏情况＝这项当天少算） */ }
    const key = String(feature || 'external').slice(0, 40) || 'external';
    const bucket = data.byFeature[key] || { tokens: 0, cost: 0, calls: 0 };
    bucket.tokens = (Number(bucket.tokens) || 0) + (Number(delta.totalTokens) || 0);
    bucket.cost = (Number(bucket.cost) || 0) + cost;
    bucket.calls = (Number(bucket.calls) || 0) + 1;
    data.byFeature[key] = bucket;
    const tmp = path.join(DATA_DIR, `usage-today.json.${process.pid}.tmp`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));
    fs.chmodSync(path.join(DATA_DIR, 'usage-today.json'), 0o600); // btrfs 兜底（Issue #11）
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < this.persistIntervalMs) return;
    this._lastPersistAt.set(s.id, now);
    this.#persistAsync(s);
  }

  /** 让某会话在途的异步写作废（finish 的同步写之前调用）。 */
  #invalidateWrite(id) {
    const state = this._writeStates.get(id);
    if (!state) return;
    state.gen += 1;
    state.dirty = false;
    // 没有在途写时不会有人再调用 settle，这条世代状态必须当场回收（否则每次运行漏一条）
    if (!state.busy) this._writeStates.delete(id);
  }

  /**
   * 异步合并落盘（2026-10-30）：节流命中后不再同步 writeFileSync 整份会话。
   * 同一会话同时只有一个写在飞，期间的新状态只置脏位，写完再用最新快照补一次。
   * finish() 仍同步落最终态，并通过世代号让在途的旧快照作废 ——
   * 不会出现"最终文件被 running 旧快照覆盖"。崩溃最多丢一个节流间隔的运行中进度。
   */
  #persistAsync(s) {
    let state = this._writeStates.get(s.id);
    if (!state) {
      state = { gen: 0, busy: false, dirty: false, dead: false };
      this._writeStates.set(s.id, state);
    }
    state.gen += 1;
    if (state.busy) { state.dirty = true; return; }
    this.#flushAsync(s, state);
  }

  #flushAsync(s, state) {
    state.busy = true;
    const gen = state.gen;
    let payload;
    try {
      payload = JSON.stringify(s);
    } catch (error) {
      state.busy = false;
      console.error('[sessions] 会话序列化失败:', error?.message ?? error);
      return;
    }
    const file = sessionFile(s.id);
    const tmp = `${file}.${process.pid}.${gen}.tmp`;
    const settle = () => {
      state.busy = false;
      if (state.dead) { this._writeStates.delete(s.id); return; }
      if (state.dirty) { state.dirty = false; this.#flushAsync(s, state); return; }
      // 会话已结束：不会再有人给它排新的异步写（update 找不到 current 里的对象），
      // 这条世代状态必须回收 —— 否则"finish 打断在途写"的每个会话都会在 Map 里留一条。
      if (!this.current.has(s.id)) this._writeStates.delete(s.id);
    };
    (async () => {
      try {
        await fs.promises.mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
        // rename 前再判一次：finish/discard 已经同步写过或删过文件，这份旧快照必须作废
        if (state.gen !== gen || state.dead) {
          await fs.promises.rm(tmp, { force: true });
          return;
        }
        // 必须是**同步** rename：检查与替换之间不能有 await。异步 rename 已提交到线程池后，
        // 主线程仍会插进 finish() 的同步写；线程池里的旧 rename 晚一步完成，就把 running
        // 旧快照盖回最终文件（2026-10-30 交叉审查 P1）。寄存器检查 + renameSync 之间
        // 没有事件循环机会，才真正排除这个窗口。
        fs.renameSync(tmp, file);
        if (state.dead) {
          // discard 与 rename 抢跑：删掉刚写出来的僵尸文件
          fs.rmSync(file, { force: true });
          return;
        }
        fs.chmodSync(file, 0o600);
      } catch (error) {
        try { await fs.promises.rm(tmp, { force: true }); } catch { /* ignore */ }
        console.error('[sessions] 异步落盘失败:', error?.message ?? error);
      } finally {
        settle();
      }
    })();
  }

  #persist(s) {
    try {
      // 会话 JSON 含完整聊天记录、系统提示词与逐轮模型输入输出：目录 0700 / 文件 0600，
      // 与 config.json 的口径一致（原来不带 mode，权限正确性全靠 data/ 恰好是 0700）。
      // rename 后显式 chmod：btrfs 上 writeFileSync 的 mode 会丢失（Issue #11）。
      fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
      // 紧凑 JSON：运行中每 10 秒整份重写，缩进会白白多写三成字节（Issue #45）。
      // 文件仍可被 JSON.parse / 人眼查看，只是不再逐行缩进。
      fs.writeFileSync(tmp, JSON.stringify(s), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, sessionFile(s.id));
      fs.chmodSync(sessionFile(s.id), 0o600);
      if (s.status !== 'running' && s.status !== 'waiting') this.#bumpTodayUsage(s);
      return true;
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
      return false;
    }
  }
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}

/** 索引排序：新的在前；同一毫秒按 id 兜底（id 前缀是 base36 时间戳）。 */
function compareSummaryDesc(a, b) {
  const diff = (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0);
  if (diff) return diff;
  return String(b.id).localeCompare(String(a.id));
}

/** 压缩天数：0 是合法值（关闭），非法值回落到 fallback。 */
function clampDays(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(3650, Math.round(n));
}

/** 总量上限（MB）：0 是合法值（不限制），非法值回落到 fallback。 */
function clampMb(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(1024 * 1024, Math.round(n));
}
