// 定时提醒：群友让机器人"X 点提醒我 Y" —— 落盘持久化（重启不丢），到点走主动唤醒，
// 由模型用人设口吻把提醒说出来（而不是系统模板直发）。
// 与 schedule_wake 的区别：那个是"给自己排开口时机"、内存态、每会话只留一条；
// 这里是"给别人设的承诺"、持久化、可多条、可查询/取消。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { minuteOfDayInZone, sanitizeUserText } from './util.js';

const FILE = path.join(DATA_DIR, 'reminders.json');
export const MAX_REMINDER_TEXT = 200;
const MAX_PER_CHAT = 10;      // 单个会话待触发上限（防刷）
const MAX_PENDING = 50;       // 全局待触发上限
const DONE_KEEP = 5;          // 每个会话保留最近几条已完成记录（供 list 查看）
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 最多 30 天后（再远没意义）
const EXPIRE_AFTER_MS = 12 * 60 * 60 * 1000;   // 离线导致迟到超过 12 小时 → 作废不补发

/** "HH:MM" → 下一次出现的绝对毫秒（按项目统一时区 UTC+8；已过则算明天）。非法返回 null。 */
export function nextAtFromHHMM(hhmm, now = Date.now()) {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const nowMin = minuteOfDayInZone(now);
  const targetMin = hour * 60 + minute;
  let deltaMin = targetMin - nowMin;
  if (deltaMin <= 0) deltaMin += 24 * 60;   // 已过（或就是此刻）→ 明天同一时刻
  return now + deltaMin * 60 * 1000;
}

export class ReminderStore {
  constructor(file = FILE) {
    this.file = file;
    this.items = this.#load();
  }

  #load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      // 首次运行没有文件是正常的，只有"文件在但读不了"才值得报警并留档：
      // 静默返回空数组的后果是「提示没设成」——下一次 #save 会用空列表覆盖掉
      // 那份损坏文件，用户再也查不出提醒为什么消失（2026-09-29 审查 P2）。
      if (error?.code !== 'ENOENT') {
        console.error(`[reminder] 读取 ${this.file} 失败，本次按"没有提醒"处理，原文件已备份为 .broken-<时间戳>：`, error?.message ?? error);
        try { fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* 备份失败就留在原处，至少不覆盖 */ }
      }
      return [];
    }
    return Array.isArray(raw?.items) ? raw.items.filter((x) => x && x.id && x.chatKey && x.at) : [];
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // 与全仓其它落盘点同口径：tmp + rename 原子替换（此前这里是唯一的直接覆盖写），
      // flush 让 rename 之前数据已经落盘，避免断电后留下"改名成功、内容为空"的文件。
      const tmp = `${this.file}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
      fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), { encoding: 'utf8', mode: 0o600, flush: true });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (error) {
      // 落盘失败不影响内存态，但必须留痕：此前静默吞掉，磁盘满时用户看到"设好了"，
      // 重启后提醒全没了且没有任何线索（2026-09-29 审查 P2）。
      console.error('[reminder] 落盘失败（内存态继续用，重启会丢）:', error?.message ?? error);
    }
  }

  #prune() {
    // 每个会话只保留最近 DONE_KEEP 条已完成（fired/expired/canceled），pending 不剪
    const byChat = new Map();
    for (const it of this.items) {
      if (it.status === 'pending') continue;
      const list = byChat.get(it.chatKey) || [];
      list.push(it);
      byChat.set(it.chatKey, list);
    }
    const drop = new Set();
    for (const list of byChat.values()) {
      list.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      for (const it of list.slice(DONE_KEEP)) drop.add(it.id);
    }
    if (drop.size) this.items = this.items.filter((it) => !drop.has(it.id));
  }

  /** 新增一条提醒。返回 { id, at }；超出限制/参数非法时抛带可读原因的错。
   *  createdBy = 谁提的（"a 让你提醒 b"里的 a）；targetName = 提醒谁（b）。
   *  两者都是可选的事实信息，只用于到点派发时的话术归属（2026-10-10 用户反馈：
   *  此前不记归属，派发话术又套着"你给自己留过话"的框架，模型会自己圆归属）。 */
  add({ chatKey, at, text, createdBy = '', targetName = '' }) {
    const when = Number(at);
    // 提醒正文是"用户可诱导模型原样搬运"的文本，落盘前统一弱化段头（提示注入面，2026-09-28 审查 P2）
    const body = sanitizeUserText(String(text || '').trim()).slice(0, MAX_REMINDER_TEXT);
    if (!chatKey) throw new Error('缺少会话');
    if (!body) throw new Error('提醒内容不能为空');
    if (!Number.isFinite(when)) throw new Error('提醒时间不合法');
    const now = Date.now();
    if (when <= now + 5000) throw new Error('提醒时间必须晚于现在');
    if (when - now > MAX_DELAY_MS) throw new Error('最多只能设到 30 天后');
    // #9：先把"早就过期、还没被巡检标掉"的项标成 expired（它们才是真占着 pending 名额的那批），
    // 再剪留档，最后判上限 —— 否则用户会因为一堆早该作废的提醒而被告知"满了"。
    let expiredNow = false;
    for (const it of this.expired(now)) { it.status = 'expired'; it.finishedAt = now; expiredNow = true; }
    this.#prune();
    if (expiredNow) this.#save();
    const pendingNow = () => this.items.filter((it) => it.status === 'pending');
    if (pendingNow().filter((it) => it.chatKey === chatKey).length >= MAX_PER_CHAT) {
      throw new Error('本会话待触发提醒已达上限（10 条），先取消一些');
    }
    if (pendingNow().length >= MAX_PENDING) {
      throw new Error('全局提醒位已满（每人上限 10 条，共 50 条），先取消一些');
    }
    const item = {
      id: crypto.randomBytes(4).toString('hex'),
      chatKey,
      at: when,
      text: body,
      // 归属名与其他入口同口径（段头弱化 + 截断）：它们会进派发 note，也在注入面里
      createdBy: sanitizeUserText(String(createdBy || '').trim()).slice(0, 40),
      targetName: sanitizeUserText(String(targetName || '').trim()).slice(0, 40),
      status: 'pending',
      createdAt: now,
      firedAt: null,
      finishedAt: null
    };
    this.items.push(item);
    this.#save();
    return { id: item.id, at: item.at };
  }

  cancel({ id = '', chatKey = '' }) {
    const key = String(id || '').trim();
    // 不传 id 时：取消该会话**最近一条**待触发（"算了别提醒了"这种口语）。
    // 之前的写法 find(… && true) 恒命中数组里最早的一条，reverse 兜底是死代码
    // （2026-09-29 审查 P2：同一会话有两条 pending 时会取消错条）
    const hit = key
      ? this.items.find((it) => it.chatKey === chatKey && it.status === 'pending' && it.id === key)
      : [...this.items].reverse().find((it) => it.chatKey === chatKey && it.status === 'pending');
    if (!hit) return null;
    hit.status = 'canceled';
    hit.finishedAt = Date.now();
    this.#prune();
    this.#save();
    return hit;
  }

  list(chatKey, { includeDone = false } = {}) {
    return this.items
      .filter((it) => it.chatKey === chatKey && (includeDone || it.status === 'pending'))
      .sort((a, b) => a.at - b.at);
  }

  due(now = Date.now()) {
    return this.items.filter((it) => it.status === 'pending' && it.at <= now);
  }

  /** 迟到的提醒：超过 12 小时的直接作废（不补发一串"迟到的提醒"）。 */
  expired(now = Date.now()) {
    return this.items.filter((it) => it.status === 'pending' && it.at <= now - EXPIRE_AFTER_MS);
  }

  /**
   * 预算等外因挡住派发时，把到点时间显式顺延（2026-10-04 复审 P2）。
   * 只改 at、不动 status：12 小时作废时钟随新 at 重新起算 —— 否则持续超预算的当天，
   * "保持到期等明天"的提醒会在迟到满 12 小时时被 expired() 静默作废，与"顺延到明天"相反。
   */
  deferTo(id, at) {
    const hit = this.items.find((x) => x.id === id && x.status === 'pending');
    if (!hit) return null;
    hit.at = Number(at) || hit.at;
    this.#save();
    return hit;
  }

  markFired(id, now = Date.now()) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    it.status = 'fired';
    it.firedAt = now;
    it.finishedAt = now;
    this.#prune();
    this.#save();
    return it;
  }

  markExpired(id, now = Date.now()) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    it.status = 'expired';
    it.finishedAt = now;
    this.#prune();
    this.#save();
    return it;
  }
}

export { EXPIRE_AFTER_MS };

// ── 派发话术（唯一真源）────────────────────────────────────────────────────
// 到点唤醒时给模型的那条 note 由这里生成；orchestrator 只管条数预算与派发。
// 归属（谁提的/提醒谁）只作为事实写进来；缺归属时明确要求"别猜"——此前话术是
// "之前有人让你…"且外面套着"你之前给自己留过话"的框架，模型只能自己圆，会把
// 别人托的提醒说成被提醒人自己设的（2026-10-10 用户反馈）。

const REMINDER_AT_FMT = { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' };

/** 单条提醒在派发 note 里的预估占用（正文 + 归属名 + 引号/分隔开销）。
 *  派发侧的条数预算（orchestrator 的 REMINDER_NOTE_BODY_MAX）与 note 截断（600 字）
 *  必须同一口径：漏算归属名会让"装得下"的条目在截断后丢内容却照样被标记已触发。 */
export function reminderNoteCost(item) {
  return String(item?.text || '').length
    + String(item?.createdBy || '').length
    + String(item?.targetName || '').length
    + 8;
}

/** 把到点的一组提醒拼成唤醒 note（纯函数，便于单测）。 */
export function buildReminderNote(items, { now = Date.now(), lateMs = 3 * 60000 } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return '';
  const first = list[0];
  const at = new Date(first.at).toLocaleTimeString('zh-CN', REMINDER_AT_FMT);
  const late = now - first.at;
  const whoOf = (it) => {
    const from = String(it.createdBy || '').trim();
    const to = String(it.targetName || '').trim();
    if (from && to) return `${from}请你提醒${to}`;
    if (from) return `${from}请你提醒`;
    if (to) return `有人请你提醒${to}`;
    return '';
  };
  const body = list.length === 1
    ? `之前${String(first.createdBy || '').trim() || '有人'}让你在 ${at} 提醒`
      + `${String(first.targetName || '').trim() ? `${String(first.targetName).trim()}：` : '：'}${first.text}`
    : `到点了，要你提醒的事有 ${list.length} 件：${list.map((x) => `「${x.text}」${whoOf(x) ? `（${whoOf(x)}）` : ''}`).join('、')}`;
  const hasNames = list.some((x) => String(x.createdBy || '').trim() || String(x.targetName || '').trim());
  const howto = hasNames
    ? '现在自然地把这些说出来（一两句，别说"系统提醒"）：是谁请你提醒谁的要说清，别猜也别含糊。'
    : '现在自然地把这些说出来（一两句，别说"系统提醒"）：不确定是谁托你提醒的就别猜（说"有人托我提醒"即可），更不要说是被提醒的人自己设的。';
  return `【定时提醒】${body}${late > lateMs ? '（已经迟到了一点，顺口说明下）' : ''}。${howto}`;
}
