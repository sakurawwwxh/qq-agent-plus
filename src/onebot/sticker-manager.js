// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractMediaFromSegments } from './onebot.js';
import { DATA_DIR, getConfig } from '../core/config.js';
import { IMAGE_EXTENSIONS, imageType } from '../core/image-type.js';
import { resolveSelfName } from '../core/util.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed,
  normalizeStickerEntry
} from './stickers.js';

const STICKER_ASSET_DIR = path.join(DATA_DIR, 'sticker-assets');
const MAX_STICKER_BYTES = 8 * 1024 * 1024;

function cleanMetadata(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 图片地址里的稳定标识（fileid 参数），用于自动收藏去重。 */
function stickerSourceKey(url) {
  const text = String(url || '');
  const fileid = /[?&]fileid=([^&]+)/.exec(text)?.[1];
  return fileid || text.slice(0, 120);
}

// 收藏判定的「判定标准」：配置 sticker.collectCriteria 填了就用它的，留空用下面这套内置默认。
// 默认值 = 现状（老 config.json 一字不改照旧跑）；上限 2000 字，防把判定请求撑爆。
export const STICKER_JUDGE_DEFAULT_CRITERIA = '判断标准只有一条：以后聊天时用得上吗。'
  + '值得收：真正的表情包——带字的梗图、猫猫狗狗、卡通形象、抽象搞笑图，能拿来表达情绪、吐槽或怼人的。'
  + '不值得收：本人或朋友的生活照、随手拍、自拍，以及跟聊天无关的截图（游戏、聊天记录、网页）、二维码、证件、广告、纯风景照。'
  + '拿不准就问自己一句：以后聊天时真会用上吗。会就用得上才收，不会就别收。';

/** 收藏判定的判定标准：配置里填了就用配置的，否则用内置默认（默认值即现状）。 */
export function stickerJudgeCriteria(config = {}) {
  const custom = String(config?.sticker?.collectCriteria || '').trim();
  return custom ? custom.slice(0, 2000) : STICKER_JUDGE_DEFAULT_CRITERIA;
}

import { chatCompletionWithRetry } from '../llm/llm.js';
import { safeFetchBinary, validateImageUrl } from '../llm/safe-fetch.js';
import { resolveToolCalls } from '../tools/inline-tools.js';
import { createLogger } from '../core/logger.js';
import { createQuota } from '../core/quota.js';

const log = createLogger('sticker');

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.storageError = null;
    try {
      this.entries = loadStickerStore(undefined, { strict: true });
    } catch (error) {
      this.entries = [];
      this.storageError = error;
    }
    this.syncedAt = 0;
    this.syncing = null;
    this.collectQuota = createQuota({ windowMs: 3600_000 });   // #9 双闸：每会话 + 全局（替换旧的 collectTimes 数组）
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  assertStorageWritable() {
    try {
      loadStickerStore(undefined, { strict: true });
      this.storageError = null;
    } catch (error) {
      this.storageError = error;
      throw error;
    }
  }

  saveEntries(entries) {
    this.assertStorageWritable();
    saveStickerStore(entries);
    this.entries = entries;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    try {
      this.assertStorageWritable();
    } catch (error) {
      return {
        entries: this.entries,
        fromCache: true,
        error: String(error?.message ?? error)
      };
    }
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) {
      if (!force) return this.syncing;
      // 强同步不能被在途的普通同步吞掉：调用方（QQ 收藏自动收藏路径）刚加完收藏就
      // force 同步，要的是"这份结果包含刚加的那条"；复用加收藏之前发起的在途请求，
      // 新 emoji 不在 entries 里 → 随后的 peek 落空、备注永久丢失（2026-10-07 复审）。
      // 等它 settle（成败都算）再实实在在地拉一次，并接管 this.syncing 的所有权，
      // 免得旧请求收尾时把链尾清掉。
      const inflight = this.syncing;
      const chained = inflight.catch(() => {}).then(() => this.#runSync());
      this.syncing = chained;
      chained.then(() => { if (this.syncing === chained) this.syncing = null; }, () => { if (this.syncing === chained) this.syncing = null; });
      return chained;
    }
    const run = this.#runSync();
    this.syncing = run;
    // 只有还归自己所有时才清：链式强同步会把 this.syncing 换成新链尾。
    run.then(() => { if (this.syncing === run) this.syncing = null; }, () => { if (this.syncing === run) this.syncing = null; });
    return run;
  }

  #runSync() {
    return (async () => {
      try {
        // 同步窗口固定按上限拉，**不能**挂在 sticker.promptMaxStickers 上 ——
        // 那个设置只决定"系统提示里常驻几条"，改小它会让同步只拉到一小截，
        // 而 mergeStickerLibrary 会把没出现在这次响应里的 QQ 收藏剪掉（连同备注、使用计数）。
        const count = 500;
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        const nextEntries = mergeStickerLibrary(this.entries, fetched);
        this.saveEntries(nextEntries);
        this.syncedAt = Date.now();
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      }
    })();
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  /** 只读查看当前本地快照，不触发 QQ 同步或刷新临时 URL。 */
  peek(ref) {
    return findSticker(this.entries, ref);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  /** QQ 消息图片 URL 带短期 rkey；发送 AI 收藏图前按原消息刷新。 */
  async findForSend(ref) {
    const sticker = await this.find(ref);
    if (sticker?.localFile) {
      const image = this.readImage(ref);
      if (!image) return null;
      return {
        ...sticker,
        url: `base64://${image.buffer.toString('base64')}`
      };
    }
    const messageId = /^collected_(-?\d+)$/.exec(String(sticker?.id || ''))?.[1];
    if (!sticker || sticker.source !== 'ai' || !messageId) return sticker;
    try {
      const data = await this.onebot.getMsg(Number(messageId));
      const segments = Array.isArray(data?.message) ? data.message : [];
      const image = segments.find((segment) => segment?.type === 'image');
      const freshUrl = String(image?.data?.url || image?.data?.file || '').trim();
      if (/^https?:\/\//i.test(freshUrl) && freshUrl !== sticker.url) {
        const refreshed = { ...sticker, url: freshUrl, updatedAt: new Date().toISOString() };
        this.saveEntries(
          this.entries.map((entry) => entry.id === sticker.id ? refreshed : entry)
        );
        return refreshed;
      }
    } catch { /* 源消息过期就退回下面"探活"这条路 */ }
    // 刷不到新链接（原消息已过期/被撤回）的早期条目只有一条老 URL：链接可能早就 400 了。
    // 直接发出去群友看到的是一张坏图 —— 先探一下，探不通就明确报"已失效"（2026-09-27）。
    try {
      const safeUrl = await validateImageUrl(sticker.url);
      try {
        // 只取一小段探活；"响应体超过 N 字节"说明图比这个上限大 —— 链接是好的，不能判死
        // （2026-09-27 审查 P1：绝大多数表情图都 >64KiB，那样会把好链接全判死）
        const { buffer } = await safeFetchBinary(safeUrl, 64 * 1024, AbortSignal.timeout(8000));
        if (!buffer?.length) throw new Error('内容为空');
      } catch (error) {
        if (!/响应体超过/.test(String(error?.message || ''))) throw error;
      }
    } catch (error) {
      const dead = new Error(`这张的图片链接已经失效（${String(error?.message ?? error)}），发出去会是一张坏图`);
      dead.code = 'STICKER_LINK_DEAD';
      throw dead;
    }
    return sticker;
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    if (result.entry) this.saveEntries(result.entries);
    return result.entry;
  }

  /**
   * 把图片字节落到托管目录（sticker-assets/），返回相对路径。
   * 两类条目共用：控制台上传的自定义表情、以及从消息里收藏下来的图（消息链接是临时的，
   * 不落盘就只能靠会过期的 URL 发出去 —— 2026-09-27 实测就有一条已 400）。
   * 顺手当校验用：非图片/超大直接抛错。
   */
  #writeAsset(imageBuffer, id) {
    const buffer = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer || []);
    if (!buffer.length) throw new Error('图片内容为空');
    if (buffer.length > MAX_STICKER_BYTES) throw new Error('图片不能超过 8 MiB');
    const contentType = imageType(buffer);
    if (!contentType) throw new Error('仅支持 PNG、JPEG、GIF 或 WebP 图片');
    // id 会进文件名：收藏那条链路用的是协议端给的 message_id（collected_<messageId>），
    // 不约束的话 `/../../x` 这种值能让落盘逸出 sticker-assets/（读路径本来就有 containment 校验，
    // 写路径此前没有；2026-09-29 审查 P2）。正常 id 只有字母数字下划线与连字符。
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(id))) {
      throw new Error(`表情 id 非法：${String(id).slice(0, 40)}`);
    }
    const relativeFile = `sticker-assets/${id}.${IMAGE_EXTENSIONS[contentType]}`;
    const file = path.join(DATA_DIR, relativeFile);
    const assetRoot = `${path.resolve(STICKER_ASSET_DIR)}${path.sep}`;
    if (!path.resolve(file).startsWith(assetRoot)) {
      throw new Error('表情路径非法');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer, { mode: 0o600, flush: true });
    fs.renameSync(tmp, file);
    return { relativeFile, file };
  }

  addManual({
    imageBuffer,
    desc = '',
    localNote = '',
    tags = [],
    usage = ''
  }) {
    this.assertStorageWritable();
    const id = `manual_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const { relativeFile, file } = this.#writeAsset(imageBuffer, id);
    const now = new Date().toISOString();
    const entry = normalizeStickerEntry({
      id,
      resId: id,
      localFile: relativeFile,
      desc: cleanMetadata(desc, 80),
      localNote: cleanMetadata(localNote, 300),
      tags: Array.isArray(tags)
        ? tags.map((tag) => cleanMetadata(tag, 40)).filter(Boolean).slice(0, 20)
        : [],
      usage: cleanMetadata(usage, 300),
      source: 'manual',
      metadataEdited: true,
      createdAt: now,
      updatedAt: now
    });
    const nextEntries = [...this.entries, entry];
    try {
      this.saveEntries(nextEntries);
    } catch (error) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      throw error;
    }
    return entry;
  }

  update(id, patch = {}) {
    const target = findSticker(this.entries, id);
    if (!target) return null;
    const index = this.entries.findIndex((entry) => entry.id === target.id);
    const next = normalizeStickerEntry({
      ...target,
      desc: patch.desc !== undefined ? cleanMetadata(patch.desc, 80) : target.desc,
      localNote: patch.localNote !== undefined
        ? cleanMetadata(patch.localNote, 300)
        : target.localNote,
      tags: patch.tags !== undefined
        ? (Array.isArray(patch.tags) ? patch.tags : [])
        : target.tags,
      usage: patch.usage !== undefined ? cleanMetadata(patch.usage, 300) : target.usage,
      metadataEdited: true,
      updatedAt: new Date().toISOString()
    });
    const nextEntries = [...this.entries];
    nextEntries[index] = next;
    this.saveEntries(nextEntries);
    return next;
  }

  remove(id) {
    const target = findSticker(this.entries, id);
    if (!target) return null;
    const nextEntries = target.source === 'qq'
      ? this.entries.map((entry) =>
        entry.id === target.id
          ? normalizeStickerEntry({ ...entry, hidden: true, updatedAt: new Date().toISOString() })
          : entry)
      : this.entries.filter((entry) => entry.id !== target.id);
    this.saveEntries(nextEntries);
    let cleanupPending = false;
    let warning = '';
    if (target.localFile) {
      try {
        fs.rmSync(path.join(DATA_DIR, target.localFile), { force: true });
      } catch (error) {
        cleanupPending = true;
        warning = `表情已从资产库移除，但图片文件清理失败：${String(error?.message ?? error)}`;
      }
    }
    return { removed: true, cleanupPending, warning };
  }

  readImage(ref) {
    const sticker = findSticker(this.entries, ref);
    if (!sticker?.localFile) return null;
    const file = path.resolve(DATA_DIR, sticker.localFile);
    const root = `${path.resolve(STICKER_ASSET_DIR)}${path.sep}`;
    if (!file.startsWith(root)) return null;
    try {
      const buffer = fs.readFileSync(file);
      const contentType = imageType(buffer);
      return contentType ? { buffer, contentType } : null;
    } catch {
      return null;
    }
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    if (result.entry) this.saveEntries(result.entries);
    return result.entry;
  }

  /**
   * 让模型自己挑图：看一眼这张图，判断值不值得收进表情库（像人挑表情包）。
   * 只处理别人发来的图片，同一张图只判断一次，每小时判断次数受限；
   * 判断失败/图片取不到就安静放弃，绝不影响聊天。
   */
  async autoCollect(chatKey, message) {
    const cfg = getConfig().sticker || {};
    // collectEnabled 是收藏总闸（2026-10-02）：关掉后连判断都不跑 —— 否则每次候选图都会
    // 白花一次看图判断，而且"优先加进 QQ 收藏"那条路（#addToQqFavorites，不走 collect()）
    // 会绕过总闸继续收。总闸必须在这里挡住。
    if (cfg.autoCollect !== true || cfg.collectEnabled === false || cfg.enabled === false || !this.enabled) return null;
    const media = (message?.media || []).find((item) => item?.kind === 'image' && item.url);
    if (!media) return null;
    const srcKey = String(media.file || '').trim() || stickerSourceKey(media.url);
    const urlKey = stickerSourceKey(media.url);
    if (!srcKey) return null;
    const fileKey = String(media.file || '').replace(/\.[a-z0-9]+$/i, '').toUpperCase();
    if (this.entries.some((entry) => entry.hidden !== true
      && (entry.srcKey === srcKey || entry.srcKey === urlKey
        || (fileKey && String(entry.md5 || '').toUpperCase() === fileKey)))) return null;
    if (!this.judgedKeys) this.judgedKeys = new Set();
    if (this.judgedKeys.has(srcKey)) return null;
    const now = Date.now();
    this.judgeTimes = (this.judgeTimes || []).filter((t) => now - t < 3600000);
    const cap = Math.max(1, Number(cfg.maxCollectPerHour) || 10);
    if (this.judgeTimes.length >= cap) return null;
    this.judgedKeys.add(srcKey);
    // 只增不减会随判过的图片数无限涨（约 10 张/小时封顶也一样）；超上限时丢最旧的一批
    if (this.judgedKeys.size > 2000) {
      const drop = this.judgedKeys.size - 1500;
      let removed = 0;
      for (const key of this.judgedKeys) {
        if (removed >= drop) break;
        this.judgedKeys.delete(key);
        removed += 1;
      }
    }
    this.judgeTimes.push(now);

    let pick = null;
    let usedUrl = media.url;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // 图片链接是一次性的：每次重新取一条新链接再下载，失败就再来一次
      const url = await this.#refreshImageUrl(message, media.url);
      usedUrl = url;
      try {
        pick = await this.#judgeSticker({ ...media, url }, message);
        break;
      } catch (error) {
        if (attempt < 3) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 800 * attempt);
            timer.unref?.();
          });
          continue;
        }
        // 三次都拿不到图就安静放弃，不要打扰群聊
        log.info('[sticker] 取图或判断失败（已重试 3 次），这次跳过：' + (error?.message ?? error));
        return null;
      }
    }
    if (!pick) {
      log.info('[sticker] 判断没有返回结果，这次跳过');
      return null;
    }
    log.info('[sticker] 判断：' + (pick.save ? '收下' : '不收') + ' —— ' + (pick.reason || '（没说理由）'));
    if (pick.save !== true) return null;
    const sender = String(message?.senderName || '').trim().slice(0, 12);
    const note = String(pick.note || '').trim() || (sender ? `自动收藏 · ${sender}` : '自动收藏');
    // 优先加进 QQ 收藏表情：链接稳定、QQ 客户端里也能用、发出去更可靠
    if (cfg.saveToQqFavorites !== false && !(await this.#qqFavoritesFull())) {
      const qq = await this.#addToQqFavorites(usedUrl);
      if (qq?.emojiId) {
        try {
          await this.sync(true);
        } catch { /* 拉不到就等下一次同步 */ }
        try {
          if (this.peek(qq.emojiId)) this.note(qq.emojiId, { note });
        } catch { /* 备注失败不影响收藏 */ }
        log.info('[sticker] 已加进 QQ 收藏表情：' + note);
        return this.peek(qq.emojiId) || { id: qq.emojiId, localNote: note, source: 'qq' };
      }
    }
    const entry = await this.collect(message?.mid, { url: usedUrl, srcKey, note, chatKey });
    if (entry && !entry.srcKey) {
      entry.srcKey = srcKey;
      this.saveEntries(this.entries);
    }
    return entry;
  }

  /**
   * QQ 收藏表情的容量状态（非会员 500 个）：控制台据此说明"新收藏会进本地库（发出去是图片）"。
   * 复用 #qqFavoritesFull 的 10 分钟缓存，别多打一次接口。
   */
  async qqFavoritesState() {
    const full = await this.#qqFavoritesFull();
    const count = Number.isFinite(this.qqCount) ? this.qqCount : null;
    return { count, limit: 500, full, checkedAt: this.qqCountAt || 0 };
  }

  /** QQ 收藏表情有上限（非会员 500 个）；满了就改存本地库。结果缓存 10 分钟。 */
  async #qqFavoritesFull() {
    const now = Date.now();
    if (this.qqCountAt && now - this.qqCountAt < 600000) return this.qqFull === true;
    if (typeof this.onebot?.call !== 'function') return false;
    // 失败也记一笔（60 秒）：协议端不可达时，表情页不必每次都等它超时（2026-09-27 审查 P2）
    if (this.qqFailAt && now - this.qqFailAt < 60000) return false;
    try {
      const data = await this.onebot.call('fetch_custom_face_detail', { count: 500 }, 30000, null);
      const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
      if (!list) return false;
      this.qqCountAt = now;
      this.qqCount = list.length;
      this.qqFull = list.length >= 500;
      if (this.qqFull) log.info('[sticker] QQ 收藏表情已满（' + list.length + '/500），这张改存本地库');
      return this.qqFull;
    } catch {
      this.qqFailAt = now;
      return false;
    }
  }

  /** 把图加进 QQ 收藏表情（协议端 add_custom_face）；成功返回 emojiId。 */
  async #addToQqFavorites(url) {
    if (typeof this.onebot?.call !== 'function' || !/^https?:\/\//i.test(String(url || ''))) return null;
    try {
      const res = await this.onebot.call('add_custom_face', { file: url }, 60000, null);
      const emojiId = String(res?.emoji_id || res?.resId || res?.data?.emoji_id || '').trim();
      return emojiId ? { emojiId } : null;
    } catch (error) {
      const msg = String(error?.message ?? error);
      const maybeFull = /full|limit|上限|超过|超出|500/i.test(msg);
      log.info('[sticker] 加进 QQ 收藏失败' + (maybeFull ? '（可能收藏已满）' : '') + '，改存本地库：' + msg);
      return null;
    }
  }

  /** 存档链接会过期：能刷新就刷新一次（拿最新一条带图消息的地址），限时 20 秒。 */
  async #refreshImageUrl(message, fallback) {
    if (message?.mid == null || typeof this.onebot?.getMsg !== 'function') return fallback;
    try {
      const data = await Promise.race([
        this.onebot.getMsg(message.mid),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 20000);
          timer.unref?.();
        })
      ]);
      const segments = Array.isArray(data?.message) ? data.message : [];
      const item = extractMediaFromSegments(segments).find((x) => x.kind === 'image' && x.url);
      return item?.url ? item.url : fallback;
    } catch {
      return fallback;
    }
  }

  /** 把图片转成 data URL（视觉模型看的就是它）。 */
  async #stickerDataUrl(url, signal) {
    const safeUrl = await validateImageUrl(url);
    const { buffer, contentType } = await safeFetchBinary(safeUrl, 4 * 1024 * 1024, signal);
    if (!buffer?.length) throw new Error('图片内容为空');
    const mime = /^image\//.test(String(contentType || '')) ? String(contentType) : 'image/jpeg';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  /** 判断一张图值不值得收（工具收藏与自动收藏共用同一口径：只收真正的表情包）。 */
  async judgeImage({ url = '', message = null, signal = null } = {}) {
    if (!url) return { save: false, reason: '这条消息里没有可收藏的图片' };
    return this.#judgeSticker({ url }, message, signal);
  }

  /** #9：把配置里的双闸限值同步到配额实例（全局 = maxCollectPerHour，会话 = maxCollectPerHourPerChat）。 */
  #configureCollectQuota() {
    const cfg = getConfig().sticker || {};
    this.collectQuota.configure({
      globalMax: Math.max(1, Number(cfg.maxCollectPerHour) || 10),
      perChatMax: Math.max(1, Number(cfg.maxCollectPerHourPerChat) || 3)
    });
  }

  /**
   * 收藏配额预检（#9 双闸：每会话 + 全局）：工具层在"看图判断"之前先问一句，别白跑一次视觉调用。
   * 只查不记 —— 真正的"扣/退"在 collect() 里（事前原子消费 + 失败退款，见 #collect 门面），
   * 这里只是让工具层在做视觉判断**之前**先问一句，省掉一次白跑的看图调用。
   * 返回 { ok, scope:'chat'|'global'|'' }。
   */
  collectPeek(now = Date.now(), chatKey = '') {
    this.#configureCollectQuota();
    return this.collectQuota.peek(chatKey, now);
  }

  /** 一次极小的视觉判断：这张图收不收？收的话备注写什么？ */
  async #judgeSticker(media, message, outerSignal = null) {
    const timeoutSignal = AbortSignal.timeout(90000);
    // 主运行被中止/超时后，这次视觉判断也该停（否则工具早返回了它还在跑）
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal;
    const dataUrl = await this.#stickerDataUrl(media.url, signal);
    const botName = resolveSelfName(getConfig().persona || {}, this.onebot?.selfNickname || '');
    const sender = String(message?.senderName || '群友').trim().slice(0, 20) || '群友';
    const tool = {
      type: 'function',
      function: {
        name: 'submit_sticker_pick',
        description: '提交对这张图的收藏决定。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            save: { type: 'boolean', description: 'true=值得收进表情库；false=不值得' },
            note: { type: 'string', maxLength: 24, description: 'save=true 时写一句简短备注（画的是什么/适合什么场合）；save=false 留空' },
            reason: { type: 'string', maxLength: 40, description: '一句话说明为什么收/不收（给日志看）' }
          },
          required: ['save']
        }
      }
    };
    const messagesUsed = [
      {
        role: 'system',
        content: `你是「${botName}」，一个混在 QQ 群里的普通群友，正在看群友刚发的一张图。`
          // 判定标准可配置：留空即内置默认（默认值 = 现状）；身份那句由代码补在前面。
          + stickerJudgeCriteria(getConfig())
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${sender} 发的这张图，收还是不收？` },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ];
    const ask = (messages) => chatCompletionWithRetry({
      messages,
      tools: [tool],
      toolChoice: { type: 'function', function: { name: 'submit_sticker_pick' } },
      temperature: 0.3,
      purpose: 'judge',   // 收不收这张表情 = 判断类任务
      signal,
      // 思考会先吃掉 80~595 个 token，200 会把它截断到一个字段都收不到
      maxTokens: 600
    });
    // 模型有时不用结构化 tool_calls，而是写成 <tool_call> Hermes 文本或裸 JSON。
    // 只认结构化调用会把这些决定整条丢掉（线上出现过"两次都没提交决定，这次跳过"）。
    const pickFromText = (text) => {
      const raw = String(text || '');
      const key = (name) => {
        const m = new RegExp('<parameter\\s*=\\s*' + name + '\\s*>([\\s\\S]*?)(?=<parameter\\s*=|</function>|</tool_call>|$)', 'i').exec(raw);
        return m ? m[1].trim() : undefined;
      };
      if (/<function\s*=\s*submit_sticker_pick/i.test(raw)) {
        const save = key('save');
        return { save: /^(true|是|收|yes)$/i.test(String(save ?? '')), note: key('note') || '', reason: key('reason') || '' };
      }
      const jsonMatch = raw.match(/\{[\s\S]*?"save"[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const obj = JSON.parse(jsonMatch[0]);
          if (typeof obj?.save === 'boolean') return obj;
        } catch { /* 不是合法 JSON，放弃 */ }
      }
      return null;
    };
    const pickArgs = (resp) => {
      const call = (resp?.message?.tool_calls || [])[0];
      if (call) {
        try { return JSON.parse(call.function?.arguments || '{}'); } catch { /* 参数坏了就落到文本解析 */ }
      }
      const fromText = pickFromText(resp?.message?.content) || pickFromText(resp?.message?.reasoning_content);
      if (fromText) return fromText;
      // 共享解析器兜住更多内联格式（<tool_call> 包裹的 JSON、带 name 的 JSON 等）
      const inline = resolveToolCalls(resp?.message)[0];
      if (inline?.function?.name === 'submit_sticker_pick') {
        try { return JSON.parse(inline.function.arguments || '{}'); } catch { return null; }
      }
      return null;
    };

    // 最多试 3 次：服务商的内容过滤是概率性的（同一张图多数时候能过），多给一次机会；
    // 同时把"被内容过滤"和"模型没提交"在日志里分开，便于判断到底是哪种原因。
    let response = null;
    let args = null;
    let filtered = 0;
    for (let attempt = 1; attempt <= 3 && !args; attempt += 1) {
      response = await ask(attempt === 1
        ? messagesUsed
        : [
          ...messagesUsed,
          { role: 'assistant', content: String(response?.message?.content || '（无内容）').slice(0, 200) },
          { role: 'user', content: '请用 submit_sticker_pick 工具正式提交你的决定（save: true/false）。' }
        ]);
      if (String(response?.finishReason || '') === 'content_filter') filtered += 1;
      args = pickArgs(response);
    }
    if (!args) {
      log.info('[sticker] 三次都没拿到决定'
        + (filtered ? `（其中 ${filtered} 次被服务商内容过滤：图片含敏感内容，属正常拦截）` : '')
        + '，这张跳过：' + String(response?.message?.content || '').slice(0, 100));
      return null;
    }
    if (!args) args = {};
    return {
      save: args.save === true,
      note: String(args.note || '').slice(0, 24),
      reason: String(args.reason || '').slice(0, 40)
    };
  }

  /**
   * 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。
   * 限频（#9 双闸：每会话 + 全局）用**事前原子消费**，失败/写库失败再 refund 退回 ——
   * 原来是 peek → 下载/判定/落库 → tryConsume（还忽略返回值）：两个并发收藏会双双通过 peek、
   * 都落库并超上限（quota.js 文件头把这个形态列为并发下封不住的反例；生图 2026-10-01 已修）。
   * 2026-10-03 全量审查。
   */
  async collect(messageId, opts = {}) {
    const chatKey = String(opts?.chatKey || '');
    const now = Date.now();
    this.#configureCollectQuota();
    const gate = this.collectQuota.tryConsume(chatKey, now);
    if (!gate.ok) {
      throw new Error(gate.scope === 'chat'
        ? '本会话收藏太频繁了（每小时有上限），过一会儿再收'
        : '收藏太频繁了（全局每小时有上限），过一会儿再收');
    }
    try {
      return await this.#collect(messageId, opts);
    } catch (error) {
      this.collectQuota.refund(chatKey, now);   // 没成功就退回去（不能白扣用户的额度）
      throw error;
    }
  }

  async #collect(messageId, { url, note = '', srcKey = '', signal } = {}) {
    note = String(note ?? '').slice(0, 300);
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      return this.note(id, { note: String(note || '') });
    }
    // 入库即落盘：消息图片的链接是临时地址（带 rkey、随时可能 400），只存 URL 的条目
    // 过一阵子就发不出去了（实测有一条已失效）。落盘后发送走 base64，永不过期。
    let localFile = '';
    let assetFile = '';
    try {
      const safeUrl = await validateImageUrl(url);
      const { buffer } = await safeFetchBinary(safeUrl, MAX_STICKER_BYTES, signal);
      const asset = this.#writeAsset(buffer, id);
      localFile = asset.relativeFile;
      assetFile = asset.file;
    } catch (error) {
      throw new Error(`这张图取不到（${String(error?.message ?? error)}），没有收藏`);
    }
    const entry = {
      id,
      resId: id,
      url,
      localFile,
      md5: '',
      srcKey: String(srcKey || '').trim() || stickerSourceKey(url),
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    try {
      this.saveEntries([...this.entries, entry]);
    } catch (error) {
      // 写库失败就别把刚落的图留在磁盘上（与 addManual 同款：失败要收尾干净）
      try { fs.rmSync(assetFile, { force: true }); } catch { /* 清不掉无害 */ }
      throw error;
    }
    return entry;
  }
}
