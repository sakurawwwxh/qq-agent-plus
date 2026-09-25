// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/config.js';
import { sanitizeUserText } from '../core/util.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    localFile: /^sticker-assets\/[a-z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(String(entry.localFile || ''))
      ? String(entry.localFile)
      : '',
    md5: String(entry.md5 || '').trim().toUpperCase(),
    srcKey: String(entry.srcKey ?? '').trim(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    hidden: entry.hidden === true,
    metadataEdited: entry.metadataEdited === true,
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE, { strict = false } = {}) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      if (strict) throw new Error('表情库根节点必须是数组');
      return [];
    }
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (strict) {
      throw new Error(`表情库读取失败，已停止写入：${String(error?.message ?? error)}`, {
        cause: error
      });
    }
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  // stickers.json 含模型按群友暗示写入的 desc/localNote/tags：与隐私数据同口径（0700/0600）。
  // rename 后显式 chmod：btrfs 上 writeFileSync 的 mode 会丢失（Issue #11）。
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: old?.metadataEdited
        ? old.desc
        : String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  // 保护：这次一条都没拉到（接口失败/空列表）时不要剪枝——否则 QQ 一抖，本地库连备注一起被清空
  if (!fetchedIds.size) return out;
  // 剪枝只剪"没有任何本地数据"的条目：这次没出现的 QQ 收藏可能是被删了，也可能只是
  // 协议端没把它带回来（分页/上限/响应不全都算）。备注、标签、使用计数是模型自己攒的，
  // 不能因为一次同步就静默丢掉 —— 那种丢失没有任何备份可恢复。
  const hasLocalData = (e) => Boolean(String(e.localNote || e.usage || '').trim())
    || (Array.isArray(e.tags) && e.tags.length > 0)
    || Number(e.useCount) > 0;
  return out.filter((e) => e.source !== 'qq' || e.hidden || fetchedIds.has(e.id) || hasLocalData(e));
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  const visible = (Array.isArray(entries) ? entries : []).filter((entry) =>
    entry && entry.hidden !== true);
  const direct = visible.find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  });
  if (direct) return direct;
  const label = raw.toLowerCase();
  const exactLabels = visible.filter((entry) =>
    [entry.desc, entry.localNote].some((value) =>
      String(value || '').trim().toLowerCase() === label));
  if (exactLabels.length === 1) return exactLabels[0];
  // 模糊兜底：模型经常只记得备注里的半句，唯一命中就认它；多处命中仍然要求精确 id
  if (label.length >= 2) {
    const loose = visible.filter((entry) =>
      [entry.desc, entry.localNote, ...(Array.isArray(entry.tags) ? entry.tags : [])].some((value) => {
        const text = String(value || '').trim().toLowerCase();
        return text.length > 0 && (text.includes(label) || label.includes(text));
      }));
    if (loose.length === 1) return loose[0];
  }
  return null;
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : [])
    .map(normalizeStickerEntry)
    .filter((entry) => entry && !entry.hidden);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    // list_stickers 的输出会回传给模型（与 buildStickerContext 同一条注入通道），同口径清洗。
    desc: sanitizeUserText(e.desc || ''),
    localNote: sanitizeUserText(e.localNote || ''),
    tags: (e.tags || []).map((t) => sanitizeUserText(t)),
    useCount: e.useCount || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/** 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。 */
export function buildStickerContext(entries, max = 10, { vision = true } = {}) {
  const all = (Array.isArray(entries) ? entries : [])
    .map(normalizeStickerEntry)
    .filter((entry) => entry && !entry.hidden);
  // 关闭图片输入（api.vision=false）时 get_sticker_image 会被从工具表里摘掉：没备注的表情
  // 既看不懂、也没法看图，留在清单里只是每轮多烧一行 token。所以那种配置下只列有备注的。
  const list = vision
    ? all
    : all.filter((entry) => Boolean(String(entry.desc || entry.localNote || '').trim()));
  if (!list.length) return '';
  // 名单上限 60：这是"给模型看多少"，不是库容量（同步一律拉 500，见 sticker-manager.sync）。
  const limit = Math.max(1, Math.min(60, Number(max) || 10));
  // 选图口径 = 常用保底 + 没用过的轮换。
  // 以前整份清单按 useCount 降序取前 N，发过的图永远占住名额 —— 几百个收藏里
  // 只有最先发出去的那几张能被模型看见（用户反馈"收藏了很多，但只会发那几张"）。
  // 现在一半留给"没用过/最久没用"的：发掉一张，下一张就自然顶上来。
  // 排序只看 useCount / lastUsedAt / createdAt / id，同一份库每轮结果完全一致 ——
  // 这段清单常驻系统提示、属于缓存前缀，不能每次运行都换一批。
  const hasNote = (e) => Boolean(String(e.desc || e.localNote || '').trim());
  const byUsage = [...list].sort((a, b) =>
    (b.useCount || 0) - (a.useCount || 0)
    || (hasNote(b) ? 1 : 0) - (hasNote(a) ? 1 : 0)
    || (b.lastUsedAt || 0) - (a.lastUsedAt || 0)
    || String(a.id).localeCompare(String(b.id)));
  const familiarCount = Math.max(1, Math.ceil(limit / 2));
  const familiar = byUsage.slice(0, familiarCount);
  const picked = new Set(familiar.map((e) => e.id));
  const rotation = list
    .filter((e) => !picked.has(e.id))
    .sort((a, b) =>
      ((a.lastUsedAt || 0) ? 1 : 0) - ((b.lastUsedAt || 0) ? 1 : 0)   // 没用过的排最前
      || (hasNote(b) ? 1 : 0) - (hasNote(a) ? 1 : 0)                  // 能看懂的优先
      || (a.lastUsedAt || 0) - (b.lastUsedAt || 0)                    // 用得越早越先上榜
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit - familiar.length);
  const top = [...familiar, ...rotation];
  const lines = top.map((e) => {
    // 备注/标签由模型按群友暗示写入（sticker_note 工具可写），最终拼进**系统提示**的
    // 【可用表情包】段 —— 不过清洗就是一个可持久化的注入位（写了每轮都在）。
    const label = sanitizeUserText(e.desc || e.localNote || '') || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.map((t) => sanitizeUserText(t)).join('/')}]` : '';
    const used = e.useCount ? `（用过${e.useCount}次）` : '（没用过）';
    return `- ${label}${extra}${used}（stickerId：${e.id}）`;
  });
  const scope = rotation.length
    ? `前 ${familiar.length} 个是常用的，后 ${rotation.length} 个是没用过/很久没用的（换着发，别老是同一张）`
    : `以下是常用的 ${top.length} 个`;
  // 关闭图片输入时不能提 get_sticker_image（那个工具已经不在工具表里了）
  const tail = vision
    ? '，完整列表可用 list_stickers 查询；没用过的可以先 get_sticker_image 看一眼再用'
    : '，完整列表可用 list_stickers 查询';
  return `【可用表情包】你的表情库里有 ${list.length} 个表情包（${scope}${tail}）：\n${lines.join('\n')}`;
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint(level = 1, { vision = true } = {}) {
  // 活跃度引导放在系统提示的策略段里（而不是"本次输入"的【表情包用法】）——
  // 同一主题两处引导会左右脑互搏（Kondius 2026-09-07）：策略讲时机、档位讲频率，
  // 合并成一处由档位直接改写频率行。
  // ⚠️ 索引严格对应 0~3 档，与 ui 的 STICKER_LEVELS 一致。
  const freqByLevel = [
    '表情包是备选项，不勉强；纯文字回应完全没问题。',
    '频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '频率：回应、吐槽、接梗时优先考虑配一个贴切的表情，让对话更有活人感；别每次都用同一张。',
    '频率：你是表情包爱好者——能配表情的地方尽量配，接梗/调侃/附和时几乎都会带一张，聊天要有表情包的烟火气；注意换着用，不要连发同一张。'
  ][Math.min(3, Math.max(0, Number(level) || 0))];
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安，都可以自然用；别人发了表情包/图片时，接完话基本都要回一张自己的。',
    `- ${freqByLevel}`,
    '- 选择：先看备注/笔记/标签能不能对上语境——完全贴切的优先，语义接近、氛围对的也可以用，不用等 100% 契合；只有明显不搭才别发。',
    // 关掉图片输入时 get_sticker_image 不在工具表里，这条要换口径：只让模型用看得懂的（有备注的）
    vision
      ? '- 清单里标「没用过」的也可以直接用，不确定是什么就先 get_sticker_image 看一眼；用掉一张，下一张没用过的会自己顶上来。'
      : '- 清单里标「没用过」的挑有备注的用（清单里没备注的不会列出来）；看不到图，别对没把握的图硬发挥。',
    '- 发送：用 send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 send_message 作为单独气泡发出，再单独发表情。',
    '- 选图很简单：stickerId 直接填【可用表情包】里的备注名（如“别墨迹”“大肥鱼”），备注里独特的一小段也行，系统会自动匹配；命中不唯一时才需要完整 id（可用 list_stickers 看全库）。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  // 封顶与 StickerManager.update / 收藏判定的口径一致：这两个字段会原样进系统提示的
  // 表情清单（buildStickerContext 用 desc || localNote 当标签），模型写多长就占多少 token。
  const cap = (value, max) => String(value ?? '').trim().slice(0, max);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? cap(patch.note, 300) : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map((s) => cap(s, 40)).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? cap(patch.usage, 300) : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
