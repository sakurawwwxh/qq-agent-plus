// 官方插件：B 站（apiVersion 2）。
//
// 读 + 观看 + 互动。写操作（点赞/投币/收藏/关注/评论/弹幕）一律：
//   1) 需要 Cookie（SESSDATA + bili_jct）；
//   2) 需要管理员在插件详情里批准（一张有时限、有次数的通行证）；
//   3) 消耗当天配额（宿主侧计数，跨天归零）。
// 投稿/发动态**不在本插件范围内**：那需要一个完整的创作者工具链，风险与维护成本都不是一个插件该背的。
//
// 视频下载走宿主的 media 能力（宿主校验 SSRF、限体积、ffmpeg 合流），插件进程不执行命令、也拿不到别的目录。
import crypto from 'node:crypto';
import { mergeLoginTokens } from './login-tokens.mjs';
import { resolveVideoQuery } from './video-ref.mjs';

const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

// 写请求留痕：走宿主日志。发完不等回执——回执 id 未登记，分发器自然丢弃。
let logSeq = 9_000_000;
const logHost = (message) => {
  logSeq += 1;
  send({ id: logSeq, method: 'cap.log.write', params: { level: 'info', message: String(message).slice(0, 300) } });
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://api.bilibili.com';
const REFERER = 'https://www.bilibili.com/';

let settings = {};
const pending = new Map();
let requestSeq = 0;
// 匿名设备指纹：B 站很多接口（搜索/详情）对"完全没有 buvid3 的新客户端"会返回空结果或 412。
// 没配置 buvid3 时用一个进程内随机值，格式与浏览器一致（末尾 infoc）；不涉及登录态。
const anonBuvid3 = `${crypto.randomUUID().replace(/-/g, '')}infoc`;
// 扫码登录的二维码渲染（vendor/qrcode.js，MIT，kazuhikoarase）：
// 上下两个模块合成一个半块字符，行数减半 —— 41×41 的码约 23 行，QQ 里能放下
import qrcode from './vendor/qrcode.js';
let pendingLogin = { key: '', url: '', at: 0 };

// SVG data URL：控制台网页直接 <img> 显示，不依赖 canvas、不经任何外部服务
function qrDataUrl(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const scale = 6;
  const size = (n + 4) * scale;
  const rects = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.isDark(r, c)) {
        rects.push(`<rect x="${(c + 2) * scale}" y="${(r + 2) * scale}" width="${scale}" height="${scale}"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#111">${rects.join('')}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function qrText(url) {
  // 用 L 级纠错：二维码模块更少，半块字符文本才装得进单条发言上限。
  const qr = qrcode(0, 'L');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const lines = [];
  for (let r = 0; r < n; r += 2) {
    let line = '';
    for (let c = 0; c < n; c += 1) {
      const top = qr.isDark(r, c);
      const bottom = r + 1 < n && qr.isDark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : '　';
    }
    lines.push(`　${line}　`);
  }
  const blank = `　${'　'.repeat(n)}　`;
  return [blank, ...lines, blank].join('\n');
}

const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

const num = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const setting = (key, fallback) => (settings && settings[key] !== undefined ? settings[key] : fallback);

// ── 凭据 ────────────────────────────────────────────────────────────────
async function cookies() {
  const result = await callHost('cap.secrets.get', {});
  const values = result?.values && typeof result.values === 'object' ? result.values : {};
  return {
    sessdata: values.sessdata || '',
    bili_jct: values.bili_jct || '',
    buvid3: values.buvid3 || '',
    dedeuserid: values.dedeuserid || ''
  };
}

async function authState() {
  const c = await cookies();
  return {
    // loggedIn = 可写（SESSDATA + bili_jct）；hasSession = 只读可用（有 SESSDATA 就够）
    loggedIn: Boolean(c.sessdata && c.bili_jct),
    hasSession: Boolean(c.sessdata),
    mid: c.dedeuserid || '',
    // csrf 字段：写工具的表单要用（auth.bili_jct）。以前漏了这个字段，
    // csrf 被当成字面量 "undefined" 发出去 → B 站必回 -111（Cookie 头是对的也没用）。
    bili_jct: c.bili_jct || '',
    cookie: [
      c.sessdata ? `SESSDATA=${c.sessdata}` : '',
      c.bili_jct ? `bili_jct=${c.bili_jct}` : '',
      `buvid3=${c.buvid3 || anonBuvid3}`,
      c.dedeuserid ? `DedeUserID=${c.dedeuserid}` : ''
    ].filter(Boolean).join('; ')
  };
}

async function requireLogin({ write = true } = {}) {
  const auth = await authState();
  if (write ? !auth.loggedIn : !auth.hasSession) {
    throw new Error(write
      ? '这个操作需要登录：请在插件设置里填 SESSDATA 与 bili_jct（浏览器登录 B 站后从 Cookie 复制）'
      : '这个操作需要登录：请填 SESSDATA（只读操作不要求 bili_jct）');
  }
  return auth;
}

/** 用 nav 读平台实际登录身份（不信任 Cookie 里的 DedeUserID，它可能过期或与当前账号不一致）。 */
async function navIdentity() {
  const nav = await httpJson(`${API}/x/web-interface/nav`, { auth: true, allowCodes: [-101] });
  return {
    isLogin: nav?.data?.isLogin === true,
    mid: String(nav?.data?.mid || ''),
    uname: String(nav?.data?.uname || '')
  };
}

/**
 * 写操作专用：登录态 + 主人账号核对。
 * 设置里填了 ownerMid（B 站 UID）后，平台实际登录的 mid 必须与它一致 —— 换账号/凭据失效时
 * 直接拒绝写入，而不是拿别人的账号点赞投币（humanism 插件同款做法）。
 */
async function requireWriteAuth() {
  const auth = await requireLogin();
  const expected = String(setting('ownerMid', '') || '').trim();
  if (!expected) return auth;
  if (!/^\d+$/.test(expected)) throw new Error('插件设置里的主人 UID（ownerMid）必须是纯数字');
  const who = await navIdentity();
  if (!who.isLogin) throw new Error('写操作前核对失败：当前登录态无效，请重新登录后再试');
  if (who.mid !== expected) {
    throw new Error(`当前登录的是 UID ${who.mid}（${who.uname || '未知账号'}），不是绑定的主人 UID ${expected}：`
      + '写操作已拒绝。要换账号请在控制台重新登录，或修改插件设置里的主人 UID');
  }
  auth.navMid = who.mid;
  auth.navUname = who.uname;
  return auth;
}

/** Cookie 里的 DedeUserID 可能缺失：收藏夹这类接口要 UID 时用 nav 的实际 mid 兜底。 */
async function accountMidOf(auth) {
  if (auth.mid) return auth.mid;
  const who = await navIdentity();
  if (!who.isLogin || !who.mid) throw new Error('拿不到当前账号 UID：请在插件设置里补 DedeUserID，或重新登录');
  return who.mid;
}

// ── HTTP ────────────────────────────────────────────────────────────────
function biliError(code, message) {
  const hints = {
    '-101': '账号未登录（Cookie 过期或没填）',
    '-111': 'CSRF 校验失败（bili_jct 不对）',
    '-352': '被 B 站风控拦截（-352）：换 IP/稍后再试，或降低频率',
    '-400': '请求参数不对',
    '-403': '没有权限（可能需要大会员/登录）',
    '-404': '内容不存在或已删除',
    '-509': '请求过于频繁，稍后再试',
    '-799': '请求过于频繁，稍后再试'
  };
  const hint = hints[String(code)] || message || 'B 站接口返回错误';
  return new Error(`${hint}（code=${code}${message && message !== hint ? `，${message}` : ''}）`);
}

/** 写请求发出后遇到的 5xx/超时/非 JSON：可能已经写成功，必须让宿主按"结果未知"处理。 */
function isUncertainWriteError(error) {
  return /HTTP 5\d\d|timed out|timeout|超时|ECONNRESET|EPIPE|fetch failed|network|socket hang up|不是 JSON/i
    .test(String(error?.message || error));
}

async function httpJson(url, { method = 'GET', form = null, auth = false, allowCodes = [], headers = {}, asText = false, decompress = false, withSetCookies = false } = {}) {
  const header = { 'user-agent': UA, referer: REFERER, 'accept-encoding': 'identity', ...headers };
  if (auth) {
    const state = await authState();
    if (state.cookie) header.cookie = state.cookie;
  } else {
    // 匿名请求也带 buvid3：搜索/详情对"完全没有设备标识"的请求会返回空结果或 412
    const c = await cookies();
    header.cookie = `buvid3=${c.buvid3 || anonBuvid3}`;
  }
  const verbMethod = String(method || 'GET').toUpperCase();
  let body;
  if (form) {
    body = new URLSearchParams(form).toString();
    header['content-type'] = 'application/x-www-form-urlencoded';
    header.origin = REFERER.slice(0, -1);
  }
  if (form) logHost(`${verbMethod} ${new URL(url).host}${new URL(url).pathname}`);
  // 读路径整体重试一次（含 B 站业务码 -352/-509 与 HTTP 412 的风控判定）；
  // 写路径绝不重试 —— "也许已经发出去了"的请求重发就是重复写入。
  const attempt = async () => {
    const result = await callHost('cap.http.request', { url, method, headers: header, body, maxChars: 200000, decompress, withSetCookies });
    const status = Number(result?.status) || 0;
    const text = String(result?.body ?? '');
    if (status !== 200) throw new Error(`B 站接口返回 HTTP ${status || '?'}`);
    if (asText) return text;
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('B 站接口返回的不是 JSON（可能被风控或需要登录）'); }
    const code = Number(data?.code);
    if (code !== 0 && !allowCodes.includes(code)) throw biliError(code, data?.message);
    // Set-Cookie（登录 poll 的凭据在响应头里）透传给调用方
    if (Array.isArray(result?.setCookies) && result.setCookies.length) data.setCookies = result.setCookies;
    return data;
  };
  try {
    return await attempt();
  } catch (error) {
    if (verbMethod === 'POST' && isUncertainWriteError(error)) {
      // 写请求已经发出：5xx/超时/非 JSON 不能当成"确定没写"，否则宿主退款→模型重试=重复评论/弹幕。
      throw Object.assign(new Error(String(error?.message ?? error)), { code: 'E_WRITE_UNKNOWN' });
    }
    const riskHit = verbMethod === 'GET' && /-352|412|-509/.test(String(error?.message || error));
    if (!riskHit) throw error;
    // 匿名读请求被风控是常态：两次退避（2.5s/5s）。写路径在上面已保证绝不进来
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      return await attempt();
    } catch (error2) {
      if (!/-352|412|-509/.test(String(error2?.message || error2))) throw error2;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return await attempt();
    }
  }
}

// ── WBI 签名 ─────────────────────────────────────────────────────────────
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
];
let wbiCache = { at: 0, mixin: '' };

async function wbiMixinKey() {
  if (wbiCache.mixin && Date.now() - wbiCache.at < 3600_000) return wbiCache.mixin;
  const nav = await httpJson(`${API}/x/web-interface/nav`, { auth: true, allowCodes: [-101] });
  const img = String(nav?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0];
  const sub = String(nav?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0];
  if (!img || !sub) throw new Error('拿不到 WBI 签名密钥（B 站接口变了或当前网络被拦）');
  const raw = img + sub;
  const mixin = MIXIN_KEY_ENC_TAB.map((index) => raw[index] || '').join('').slice(0, 32);
  wbiCache = { at: Date.now(), mixin };
  return mixin;
}

async function wbiUrl(path, params = {}) {
  const mixin = await wbiMixinKey();
  const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(signed).sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(signed[key]))}`)
    .join('&');
  const rid = crypto.createHash('md5').update(query + mixin).digest('hex');
  return `${API}${path}?${query}&w_rid=${rid}`;
}

// ── 数据整形 ─────────────────────────────────────────────────────────────
const bvLink = (bvid) => `https://www.bilibili.com/video/${bvid}`;
const userLink = (mid) => `https://space.bilibili.com/${mid}`;
const durationText = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

function videoRow(item) {
  return {
    bvid: item.bvid,
    title: String(item.title || '').replace(/<[^>]+>/g, ''),
    author: item.author || item.owner?.name || '',
    mid: item.mid || item.owner?.mid || '',
    play: Number(item.play ?? item.stat?.view) || 0,
    danmaku: Number(item.video_review ?? item.stat?.danmaku) || 0,
    duration: item.duration || durationText(item.duration),
    pubdate: Number(item.pubdate ?? item.created) || 0,
    url: item.bvid ? bvLink(item.bvid) : ''
  };
}

async function viewOf(id) {
  const query = await resolveVideoQuery(id, ({ url }) => callHost('cap.http.request', {
    url,
    method: 'GET',
    headers: {
      'user-agent': UA,
      referer: REFERER,
      'accept-encoding': 'gzip, br, deflate'
    },
    maxChars: 64 * 1024,
    decompress: true
  }));
  const data = await httpJson(`${API}/x/web-interface/view?${query}`);
  const v = data.data || {};
  return {
    aid: v.aid,
    bvid: v.bvid,
    cid: v.cid,
    title: v.title,
    desc: String(v.desc || '').slice(0, 800),
    author: v.owner?.name || '',
    mid: v.owner?.mid || '',
    duration: Number(v.duration) || 0,
    pubdate: Number(v.pubdate) || 0,
    stat: {
      view: Number(v.stat?.view) || 0,
      like: Number(v.stat?.like) || 0,
      coin: Number(v.stat?.coin) || 0,
      favorite: Number(v.stat?.favorite) || 0,
      danmaku: Number(v.stat?.danmaku) || 0,
      reply: Number(v.stat?.reply) || 0
    },
    pages: Array.isArray(v.pages) ? v.pages.map((p) => ({ page: p.page, cid: p.cid, title: p.part, duration: p.duration })) : []
  };
}

// ── 工具 ────────────────────────────────────────────────────────────────
  // ── 写操作的当前状态（幂等的依据：已做过就跳过，而不是重复做） ──
  async function likedState(bvid) {
    const data = await httpJson(`${API}/x/web-interface/archive/has/like?bvid=${encodeURIComponent(bvid)}`, { auth: true });
    return Number(data?.data) === 1;
  }
  async function coinState(bvid) {
    const data = await httpJson(`${API}/x/web-interface/archive/coins/info?bvid=${encodeURIComponent(bvid)}`, { auth: true });
    return Number(data?.data?.multiply) || 0;
  }
  async function relationState(mid) {
    const data = await httpJson(`${API}/x/relation?fid=${encodeURIComponent(mid)}`, { auth: true });
    const attribute = Number(data?.data?.attribute) || 0;
    return attribute === 2 || attribute === 3 || attribute === 6;
  }

/** 把正文里的 mm:ss / h:mm:ss 换成可跳转时间戳链接（评论/回复里用，显式传 timestamps:true 才开）。 */
function linkTimestamps(text, bvid) {
  const base = `https://www.bilibili.com/video/${bvid}`;
  return String(text || '').replace(/\b(\d{1,2}):(\d{2})\b/g, (all, mm, ss) =>
    `${all} ${base}?t=${Number(mm) * 60 + Number(ss)}`);
}

/** B 站消息中心未读（回复 / @ / 点赞）：只读，给模型决定要不要 use 现有评论能力回复。 */
async function notificationsFeed({ kind, limit } = {}) {
  const which = ['reply', 'at', 'like'].includes(String(kind)) ? String(kind) : 'reply';
  const n = num(limit, 20, 1, 50);
  const path = which === 'at' ? 'at' : (which === 'like' ? 'like' : 'reply');
  const data = await httpJson(`${API}/x/msgfeed/${path}?platform=web&mobi_app=web&build=0&ps=${n}`, { auth: true });
  const items = Array.isArray(data?.data?.items) ? data.data.items : [];
  const rows = items.slice(0, n).map((entry) => {
    const item = entry?.item && typeof entry.item === 'object' ? entry.item : {};
    return {
      id: String(entry?.id || item?.id || ''),
      user: String(entry?.user?.nickname || item?.user?.nickname || ''),
      title: String(item.title || '').slice(0, 120),
      source: String(item.source_content || '').slice(0, 300),
      reply: String(item.target_reply_content || '').slice(0, 300),
      url: String(item.uri || item.native_uri || ''),
      time: Number(entry?.reply_time || entry?.time || 0)
    };
  }).filter((row) => row.id || row.title || row.reply || row.source);
  return {
    kind: which,
    count: rows.length,
    items: rows,
    note: rows.length
      ? '未读列表来自 B 站消息中心；要回复某条评论，用 comment 并传 bvid + rpid。'
      : '没有未读，或接口未返回条目（需要登录 Cookie）。'
  };
}

const tools = {
  async search({ keyword, page, order } = {}) {
    const text = String(keyword || '').trim();
    if (!text) throw new Error('keyword 不能为空');
    const orderValue = ['relevance', 'click', 'pubdate'].includes(order) ? order : 'relevance';
    // B 站真实的排序值是 totalrank/click/pubdate；“relevance”是我们对外的说法
    const orderApi = orderValue === 'relevance' ? 'totalrank' : orderValue;
    const url = await wbiUrl('/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword: text, page: num(page, 1, 1, 50), order: orderApi
    });
    const data = await httpJson(url);
    let rows = (data?.data?.result || []).map(videoRow).filter((row) => row.bvid);
    let total = Number(data?.data?.numResults) || rows.length;
    if (!rows.length) {
      // WBI 接口偶尔对匿名请求返回 code=0 但空结果；老接口不需要签名，用它兜一次。
      // 两个接口的结果形状一致，映射沿用 videoRow。
      const fallback = await httpJson(`${API}/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(text)}&page=${num(page, 1, 1, 50)}&order=${orderApi}`);
      rows = (fallback?.data?.result || []).map(videoRow).filter((row) => row.bvid);
      total = Number(fallback?.data?.numResults) || rows.length;
    }
    return {
      keyword: text,
      page: num(page, 1, 1, 50),
      total,
      results: rows,
      note: rows.length ? '要读字幕/评论或看视频，用 video / watch 传 bvid。' : '没有搜到结果，换个关键词试试。'
    };
  },

  async video({ bvid, withComments = true, withSubtitles = false } = {}) {
    const info = await viewOf(bvid);
    const result = { ...info, url: bvLink(info.bvid), authorUrl: userLink(info.mid) };
    if (withComments) {
      const count = num(setting('commentCount', 20), 20, 5, 50);
      try {
        const data = await httpJson(`${API}/x/v2/reply?type=1&oid=${info.aid}&sort=1&ps=${count}&pn=1`, { allowCodes: [-404] });
        result.comments = (data?.data?.replies || []).map((reply) => ({
          user: reply.member?.uname || '',
          like: Number(reply.like) || 0,
          text: String(reply.content?.message || '').slice(0, 300)
        }));
      } catch (error) {
        result.commentsError = String(error?.message || error);
      }
    }
    if (withSubtitles) {
      try {
        const url = await wbiUrl('/x/player/wbi/v2', { bvid: info.bvid, cid: info.cid });
        const data = await httpJson(url, { auth: true, allowCodes: [-101] });
        result.subtitles = (data?.data?.subtitle?.subtitles || []).map((item) => ({
          lang: item.lan, label: item.lan_doc, url: String(item.subtitle_url || '').startsWith('//') ? `https:${item.subtitle_url}` : item.subtitle_url
        }));
      } catch (error) {
        result.subtitlesError = String(error?.message || error);
      }
    }
    return result;
  },

  async user({ mid, withVideos = true } = {}) {
    const id = String(mid || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('mid 必须是数字 UID');
    const card = await httpJson(`${API}/x/web-interface/card?mid=${id}`);
    const u = card?.data?.card || {};
    const result = {
      mid: id,
      name: u.name || '',
      sign: String(u.sign || '').slice(0, 300),
      fans: Number(card?.data?.follower) || 0,
      level: Number(u.level) || 0,
      url: userLink(id)
    };
    // 直播状态：这是独立域名（api.live.bilibili.com），失败不影响资料本身
    try {
      const live = await httpJson(`https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${id}`, { allowCodes: [-400, -404] });
      if (live?.data?.roomid) {
        result.live = {
          live: Number(live.data.liveStatus) === 1,
          title: String(live.data.title || ''),
          url: String(live.data.url || ''),
          online: Number(live.data.online) || 0
        };
      }
    } catch (error) {
      result.liveError = String(error?.message || error);
    }
    if (withVideos) {
      try {
        const url = await wbiUrl('/x/space/wbi/arc/search', { mid: id, pn: 1, ps: 6, order: 'pubdate' });
        const data = await httpJson(url, { auth: true, allowCodes: [-101, -352] });
        result.videos = (data?.data?.list?.vlist || []).map(videoRow);
      } catch (error) {
        result.videosError = String(error?.message || error);
      }
    }
    return result;
  },

  async popular({ kind } = {}) {
    if (kind === 'weekly') {
      // 每周必看两个接口比主接口更容易吃 -352：拿不到回落综合热门并如实说明
      try {
        const series = await httpJson(`${API}/x/web-interface/popular/series/list`);
        const latest = (series?.data?.list || [])[0];
        if (latest) {
          const one = await httpJson(`${API}/x/web-interface/popular/series/one?number=${latest.number}`);
          const list = (one?.data?.list || []).map(videoRow);
          if (list.length) return { kind: 'weekly', title: String(latest.subject || `第 ${latest.number} 期`), results: list };
        }
      } catch { /* 风控/空数据 → 回落 */ }
      const fallback = await httpJson(`${API}/x/web-interface/popular?ps=20&pn=1`);
      return { kind: 'popular', results: (fallback?.data?.list || []).map(videoRow), note: '每周必看暂时被 B 站风控拦住，这里返回综合热门。' };
    }
    if (kind === 'ranking') {
      const data = await httpJson(`${API}/x/web-interface/ranking/v2?rid=0&type=all`);
      return { kind: 'ranking', results: (data?.data?.list || []).map(videoRow) };
    }
    const data = await httpJson(`${API}/x/web-interface/popular?ps=20&pn=1`);
    return {
      kind: 'popular',
      results: (data?.data?.list || []).map(videoRow),
      note: ''
    };
  },

  async account({ what, mediaId, page, cursor, kind, limit } = {}, context = {}) {
    // 历史/收藏/关注/未读通知是管理员账号的私人数据：聊天里的模型不能替群友读。
    // 控制台直调走已鉴权的 callConsoleTool，带 context.channel='console'。
    if (['history', 'favorites', 'followings', 'notifications'].includes(String(what || ''))
      && context?.channel !== 'console' && context?.senderIsOwner !== true) {
      throw new Error('只有管理员可以查看 B 站历史/收藏/关注/通知；群友请让管理员自己来问');
    }
    // 只读接口有 SESSDATA 就够；doctor 要在 mid 检查之前（它就是用来排查配置缺项的）
    const auth = await requireLogin({ write: false });
    if (what === 'doctor' || what === 'whoami') {
      return probeStatus();
    }
    if (what === 'notifications') return notificationsFeed({ kind, limit });
    if (!auth.mid && what !== 'favorites') throw new Error('需要 DedeUserID：请在插件设置里补上（B 站 UID）');
    if (what === 'history') {
      // cursor 语义（ps 固定 20）：翻页用上一次返回的 nextCursor，不是页码
      const cursorParam = String(cursor || '').replace(/[^\w=&]/g, '').slice(0, 200);
      const data = await httpJson(`${API}/x/web-interface/history/cursor?ps=20${cursorParam ? `&cursor=${cursorParam}` : ''}`, { auth: true });
      return {
        what,
        results: (data?.data?.list || []).map((item) => ({
          title: item.title, author: item.author_name, bvid: item.history?.bvid, url: item.history?.bvid ? bvLink(item.history.bvid) : '',
          viewedAt: Number(item.view_at) || 0
        })),
        nextCursor: String(data?.data?.cursor?.next || ''),
        hasMore: data?.data?.cursor?.view_at ? true : false
      };
    }
    if (what === 'followings') {
      const data = await httpJson(`${API}/x/relation/followings?vmid=${auth.mid}&pn=${num(page, 1, 1, 50)}&ps=20`, { auth: true });
      return {
        what,
        results: (data?.data?.list || []).map((item) => ({ mid: item.mid, name: item.uname, sign: String(item.sign || '').slice(0, 160), url: userLink(item.mid) }))
      };
    }
    if (what === 'favorites') {
      if (!mediaId) {
        const data = await httpJson(`${API}/x/v3/fav/folder/created/list-all?up_mid=${auth.mid}`, { auth: true });
        return {
          what,
          folders: (data?.data?.list || []).map((folder) => ({ mediaId: folder.id, title: folder.title, count: folder.media_count }))
        };
      }
      const data = await httpJson(`${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=${num(page, 1, 1, 50)}&ps=20&platform=web`, { auth: true });
      return {
        what,
        mediaId,
        results: (data?.data?.medias || []).map((item) => ({ bvid: item.bvid, title: item.title, author: item.upper?.name || '', url: item.bvid ? bvLink(item.bvid) : '' }))
      };
    }
    throw new Error('what 只能是 whoami / doctor / history / favorites / followings');
  },

  // ── 扫码登录（聊天内完成，Cookie 进加密凭据、立即生效） ──
  async login({ action } = {}, context = {}) {
    const PASSPORT = 'https://passport.bilibili.com';
    // 只信宿主注入的 context.channel；模型传入的 channel 参数不能当控制台凭据。
    // （旧版前端只给 start 传 channel 的历史问题由宿主 callConsoleTool 统一补 context 解决。）
    const channel = context?.channel === 'console' ? 'console' : 'chat';
    // 聊天内登录/退出只允许管理员：私聊白名单里的普通好友不能把机器人绑到自己账号上，
    // 也不能把管理员的凭据清掉。控制台走已鉴权的 callConsoleTool，不受这条限制。
    // poll 只读且不产生凭据（凭据是 B 站确认后随响应回来的），并且 pendingLogin.chatKey
    // 已限制只能由发起登录的会话查询，因此同样豁免。
    if (channel !== 'console' && action !== 'status' && action !== 'poll' && context?.senderIsOwner !== true) {
      throw new Error('只有管理员可以扫码登录或退出 B 站；其他人请在控制台操作');
    }
    if (action === 'status') return probeStatus();
    if (action === 'logout') {
      // 群聊里任何一句诱导都不能清掉凭据：退出只允许私聊/控制台
      if (String(context?.chatKey || '').startsWith('group:')) {
        throw new Error('退出登录请在私聊或控制台操作（群里不让清凭据）');
      }
      await callHost('cap.secrets.set', { values: { sessdata: '', bili_jct: '', buvid3: '', dedeuserid: '' } });
      return { ok: true, note: '已退出登录，凭据已清除' };
    }
    if (action === 'start') {
      const data = await httpJson(`${PASSPORT}/x/passport-login/web/qrcode/generate?source=main-fe-header`, { headers: { origin: REFERER.slice(0, -1) } });
      const url = String(data?.data?.url || '');
      const key = String(data?.data?.qrcode_key || '');
      if (!url || !key) throw new Error('拿不到登录二维码（passport 接口没返回 url/qrcode_key）');
      pendingLogin = { key, url, at: Date.now(), origin: channel };
      if (channel === 'console') {
        // 控制台流程：二维码原文交回网页渲染（本地 SVG，不经第三方）；
        // 登录链接只在 B 站 ↔ 本机之间走，不落日志
        return { ok: true, channel: 'console', qrcodeDataUrl: qrDataUrl(url), note: '用手机 B 站 App 扫这个码，手机上点确认后点「查扫码结果」（8 分钟内有效）。' };
      }
      const target = String(context?.chatKey || '');
      if (!/^(group|private):\d+$/.test(target)) throw new Error('请在私聊或控制台发起登录（二维码要发到当前会话）');
      if (target.startsWith('group:')) {
        throw new Error('群聊里不能扫码登录：二维码会被任意群成员扫走并绑定成机器人的账号。请私聊机器人或在控制台操作');
      }
      pendingLogin = { ...pendingLogin, chatKey: target };
      // 二维码本体只在会话里发，登录链接（含会话密钥）绝不交给第三方二维码服务
      const codeText = qrText(url);
      // 超长会被宿主拒绝（cap.send.text 不静默截断）；提前给出可操作的提示
      if (codeText.length > 1400) {
        throw new Error('登录链接太长，二维码放不进一条消息：请在控制台 → 插件 → B 站 → 扫码登录');
      }
      await callHost('cap.send.text', { chatKey: target, text: codeText });
      return { ok: true, note: '二维码已发到本会话：用手机 B 站 App 扫码并在手机上点确认，然后说一声"好了"，我查结果（8 分钟内有效）。' };
    }
    if (action === 'poll') {
      if (!pendingLogin.key || Date.now() - pendingLogin.at > 8 * 60_000) {
        throw new Error('没有进行中的扫码，或二维码已过期：请重新开始登录');
      }
      if (channel !== 'console' && pendingLogin.origin === 'console') {
        throw new Error('这个扫码登录是在控制台发起的：请在控制台完成');
      }
      if (channel !== 'console' && pendingLogin.chatKey
        && String(context?.chatKey || '') !== pendingLogin.chatKey) {
        throw new Error('这个扫码登录不是在这个会话发起的：请回到发起登录的会话完成');
      }
      const data = await httpJson(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(pendingLogin.key)}&source=main-fe-header`, { headers: { origin: REFERER.slice(0, -1) }, withSetCookies: true });
      const code = Number(data?.data?.code);
      if (code === 86038) { pendingLogin = { key: '', url: '', at: 0 }; throw new Error('二维码已过期：请重新开始登录'); }
      if (code === 86101) return { ok: true, state: 'waiting', note: '还没扫码：打开手机 B 站 App 扫一下刚才那张码' };
      if (code === 86090) return { ok: true, state: 'scanned', note: '已扫码：请在手机上点确认' };
      if (code !== 0) throw new Error(`登录状态异常（code=${code}）：${data?.data?.message || ''}`);
      // 成功：回跳 URL（可能嵌套 crossDomain）与 Set-Cookie 按字段合并。
      // 解析在 login-tokens.mjs（纯函数，单测覆盖"URL 有 SESSDATA、Set-Cookie 只有 bili_jct"）。
      const creds = mergeLoginTokens(data?.data?.url, data?.setCookies);
      if (!creds.sessdata) throw new Error('登录确认成功，但响应里没有 SESSDATA（回跳 URL 与 Set-Cookie 都没有）——请把这个截图发给管理员排查');
      if (!creds.bili_jct) throw new Error('登录确认成功，但没拿到 bili_jct（写操作会全部失败）：请重新扫码，或在控制台插件详情里重新登录');
      const values = { sessdata: creds.sessdata, bili_jct: creds.bili_jct };
      // DedeUserID 缺失时显式清空（空串 = 删除），避免沿用上一个账号的 UID
      values.dedeuserid = creds.dedeuserid || '';
      if (pickBuvid()) values.buvid3 = pickBuvid();
      // buvid3 从 Cookie jar 里顺带取（没有也不挡登录）
      function pickBuvid() {
        for (const line of (Array.isArray(data?.setCookies) ? data.setCookies : [])) {
          const first = String(line).split(';')[0];
          if (/^buvid3=/i.test(first)) return first.slice(7);
        }
        return '';
      }
      await callHost('cap.secrets.set', { values });
      pendingLogin = { key: '', url: '', at: 0 };
      // 保存后实测一次：不把"接口返回了凭据"当成"登录有效"（可能已被风控/账号异常）
      const probe = await probeStatus();
      if (!probe.login) {
        return {
          ok: true,
          state: 'unverified',
          account: probe.uname || `UID ${creds.dedeuserid || '?'}`,
          note: `凭据已加密保存，但 B 站校验未通过（${probe.note}）。如果是风控，稍后点「检测登录」复查；持续无效请重新扫码`
        };
      }
      return { ok: true, state: 'done', account: probe.uname || `UID ${creds.dedeuserid || '?'}`, note: '登录成功，已安全保存并立即生效' };
    }
    throw new Error('action 只能是 start / poll / status / logout');
  },

  // ── 看懂一个视频（两段式：零下载读文字 → 按需抽帧并转文字） ──
  async read({ bvid, frames } = {}) {
    const info = await viewOf(bvid);
    const maxMin = num(setting('readMaxMinutes', 20), 20, 1, 30);
    const auth = await authState();
    const mediaHeaders = { referer: REFERER, 'user-agent': UA, cookie: auth.cookie || `buvid3=${anonBuvid3}` };
    const maxBytes = num(setting('maxFileMb', 60), 60, 5, 80) * 1024 * 1024;
    const out = {
      bvid: info.bvid, title: info.title, author: info.author,
      duration: info.duration, url: bvLink(info.bvid), stat: info.stat
    };

    // ── 第二段：抽帧 + 视觉描述（模型带着时间点回来） ──
    if (Array.isArray(frames) && frames.length) {
      const times = frames.slice(0, 6)
        .map((raw) => {
          const text = String(raw || '').trim();
          if (/^\d+$/.test(text)) return Number(text);
          const hit = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
          if (!hit) return NaN;
          return hit[3] !== undefined
            ? (Number(hit[1]) * 3600 + Number(hit[2]) * 60 + Number(hit[3])) * 1000
            : (Number(hit[1]) * 60 + Number(hit[2])) * 1000;
        })
        .filter((ms) => Number.isFinite(ms) && ms >= 0);
      if (!times.length) throw new Error('frames 里没有能识别的时间点（用 "02:31" 或毫秒数）');
      const qn = String(setting('quality', '32'));
      const playUrl = await wbiUrl('/x/player/wbi/playurl', { bvid: info.bvid, cid: info.cid, fnval: 16, fnver: 0, fourk: 1, qn });
      const play = await httpJson(playUrl, { auth: true, allowCodes: [-101] });
      const videos = [...(play?.data?.dash?.video || [])].filter((v) => v?.baseUrl || v?.base_url).sort((a, b) => Number(b.id) - Number(a.id));
      const wanted = Number(qn);
      const picked = videos.find((v) => Number(v.id) <= wanted) || videos[videos.length - 1];
      if (!picked) throw new Error('拿不到视频流（可能是番剧/付费/地区限制）');
      const name = `rd-v-${info.bvid}-${picked.id}.m4s`;
      // 24h 内重复读同一视频不重复下载（文件还在就复用）
      try { await callHost('cap.media.probe', { file: name }); } catch {
        await callHost('cap.media.download', { url: picked.baseUrl || picked.base_url, name, maxBytes, headers: mediaHeaders });
      }
      const shot = await callHost('cap.media.frames', { file: name, times, prefix: `fr${info.bvid.slice(2, 10).replace(/[^A-Za-z0-9]/g, '')}` });
      out.frames = [];
      for (const frame of shot.frames || []) {
        let description = '';
        try {
          description = (await callHost('cap.media.describe', { file: frame.file })).description;
        } catch (error) {
          description = `（这一帧无法描述：${String(error?.message || error).slice(0, 90)}）`;
        }
        out.frames.push({ atMs: frame.atMs, at: durationText(Math.floor(frame.atMs / 1000)), description });
      }
      return out;
    }

    // ── 第一段：文字材料（零下载） ──
    // ① 字幕轨（优先官方/AI 字幕，登录后可读的更多）
    let transcript = null;
    let transcriptSource = '';
    let transcriptError = '';
    try {
      const playerUrl = await wbiUrl('/x/player/wbi/v2', { bvid: info.bvid, cid: info.cid });
      const player = await httpJson(playerUrl, { auth: true, allowCodes: [-101] });
      const subs = (player?.data?.subtitle?.subtitles || []).filter((item) => item?.subtitle_url);
      if (!subs.length && player?.data?.subtitle?.need_login_subtitle === true) {
        // B 站明确说"有字幕轨但要登录"：与"根本没有字幕"是两种事，用户动作不同
        transcriptError = '这个视频有 AI 字幕轨，但需要登录才能读取（登录后重试即可）';
      } else {
        const pickedSub = subs.find((item) => /^zh/i.test(String(item.lan))) || subs[0];
        if (pickedSub) {
          const subUrl = String(pickedSub.subtitle_url).startsWith('//') ? `https:${pickedSub.subtitle_url}` : pickedSub.subtitle_url;
          const sub = await httpJson(subUrl, { auth: true });
          const body = Array.isArray(sub?.body) ? sub.body : [];
          if (body.length) {
            transcript = body.map((line) => ({ at: Math.floor((Number(line.from) || 0) * 1000), text: String(line.content || '') }));
            transcriptSource = `字幕（${pickedSub.lan_doc || pickedSub.lan}）`;
          }
        }
      }
    } catch (error) {
      transcriptError = String(error?.message || error).slice(0, 160);
    }
    // ② 无字幕 → 宿主语音转写（同语音消息一条链路，时长受设置上限）
    if (!transcript && setting('asrForRead', true) === true && info.duration <= maxMin * 60) {
      try {
        const qn = String(setting('quality', '32'));
        const playUrl = await wbiUrl('/x/player/wbi/playurl', { bvid: info.bvid, cid: info.cid, fnval: 16, fnver: 0, fourk: 1, qn });
        const play = await httpJson(playUrl, { auth: true, allowCodes: [-101] });
        const audio = [...(play?.data?.dash?.audio || [])].sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth))[0];
        if (audio) {
          const name = `rd-a-${info.bvid}.m4s`;
          try { await callHost('cap.media.probe', { file: name }); } catch {
            await callHost('cap.media.download', { url: audio.baseUrl || audio.base_url, name, maxBytes, headers: mediaHeaders });
          }
          const asr = await callHost('cap.asr.transcribe', { file: name });
          if (asr?.text) {
            transcript = [{ at: 0, text: asr.text }];
            transcriptSource = `语音转写（约 ${Math.round((asr.seconds || info.duration) / 60)} 分钟，无时间戳）`;
          }
        }
      } catch (error) {
        transcriptError = String(error?.message || error).slice(0, 160);
      }
    }
    if (transcript) {
      const full = transcript.map((line) => line.text).join('');
      out.transcriptSource = transcriptSource;
      out.transcript = full.length > 9000 ? `${full.slice(0, 9000)}…（文稿过长已截断，要点都在前文）` : full;
      if (transcript.length > 1) out.transcriptTimed = transcript.slice(0, 160);
    } else {
      out.transcriptNote = info.duration > maxMin * 60
        ? `视频超过 ${maxMin} 分钟，未做转写（太慢）：以下只有弹幕与评论`
        : (transcriptError || '没有可用字幕，转写也未成功');
    }

    // ③ 弹幕密度采样：30 秒一桶找峰，跳过片头 60 秒刷屏
    try {
      const raw = await httpJson(`${API}/x/v1/dm/list.so?oid=${info.cid}`, { asText: true, decompress: true });
      const rows = [];
      const dm = /<d p="([^"]*)">([^<]*)<\/d>/g;
      let hit;
      while ((hit = dm.exec(raw)) && rows.length < 3000) {
        rows.push({ atMs: Math.round((Number(hit[1].split(',')[0]) || 0) * 1000), text: hit[2] });
      }
      const buckets = new Map();
      for (const dan of rows) {
        if (dan.atMs < 60_000) continue;
        const bucket = Math.floor(dan.atMs / 30_000);
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket).push(dan);
      }
      const peaks = [...buckets.entries()]
        .map(([bucket, list]) => ({ bucket, count: list.length, top: list.slice().sort((a, b) => b.text.length - a.text.length)[0] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
      if (peaks.length) {
        out.danmakuPeaks = peaks.map((peak) => ({
          at: durationText(peak.bucket * 30), count: peak.count, sample: peak.top?.text || ''
        }));
      }
    } catch (error) {
      out.danmakuNote = String(error?.message || error).slice(0, 120);
    }

    // ④ 热门评论 + 前 3 条的楼中楼
    try {
      const data = await httpJson(`${API}/x/v2/reply?type=1&oid=${info.aid}&sort=1&ps=10&pn=1`, { allowCodes: [-404] });
      const tops = (data?.data?.replies || []).slice(0, 5);
      out.comments = [];
      for (const [index, reply] of tops.entries()) {
        const item = {
          user: reply.member?.uname || '',
          like: Number(reply.like) || 0,
          text: String(reply.content?.message || '').slice(0, 200)
        };
        if (index < 3 && Number(reply.rcount) > 0) {
          try {
            const sub = await httpJson(`${API}/x/v2/reply/reply?type=1&oid=${info.aid}&root=${reply.rpid}&ps=3&pn=1`, { auth: true, allowCodes: [-404] });
            item.subReplies = (sub?.data?.replies || []).slice(0, 3).map((child) => ({
              user: child.member?.uname || '',
              text: String(child.content?.message || '').slice(0, 120)
            }));
          } catch { /* 楼中楼拿不到不影响主评论 */ }
        }
        out.comments.push(item);
      }
    } catch (error) {
      out.commentsNote = String(error?.message || error).slice(0, 120);
    }

    out.hint = '文稿里如果有"要看画面才知道"的地方，把时间点用 frames 再调一次（例如 frames:["02:31"]），我会抽帧并转成文字描述。';
    return out;
  },

  async watch({ bvid, page, quality, send: sendFile } = {}, context = {}) {
    const info = await viewOf(bvid);
    const pageNo = num(page, 1, 1, Math.max(1, info.pages.length || 1));
    const cid = info.pages.find((item) => Number(item.page) === pageNo)?.cid || info.cid;
    const qn = String(quality || setting('quality', '32'));
    const playUrl = await wbiUrl('/x/player/wbi/playurl', {
      bvid: info.bvid, cid, fnval: 16, fnver: 0, fourk: 1, qn
    });
    const data = await httpJson(playUrl, { auth: true, allowCodes: [-101] });
    const dash = data?.data?.dash;
    if (!dash?.video?.length) throw new Error('这个视频没有可用的 DASH 流（可能是番剧/付费内容/地区限制）');
    const videos = [...dash.video].filter((item) => item?.baseUrl || item?.base_url).sort((a, b) => Number(b.id) - Number(a.id));
    const wanted = Number(qn);
    const audio = [...(dash.audio || [])].sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth))[0];
    if (!videos.length) throw new Error('没有取到视频流');
    const maxMb = num(setting('maxFileMb', 60), 60, 5, 80);
    const maxBytes = maxMb * 1024 * 1024;
    // 体积预估（带宽 × 时长，音视频合计）：超上限先降清晰度，别等下完了才失败
    const durationSec = info.duration || Number(data?.data?.timelength) / 1e6 || 0;
    const estimateMb = (stream) => (Number(stream?.bandwidth || 0) / 8) * durationSec / (1024 * 1024);
    const candidates = videos.filter((item) => Number(item.id) <= wanted);
    const ordered = candidates.length ? candidates : [...videos].reverse();
    let picked = ordered[0];
    for (const candidate of ordered) {
      if (estimateMb(candidate) + estimateMb(audio) <= maxMb) { picked = candidate; break; }
      picked = candidate;   // 都装不下时保最低档，让下载上限去给一句可读的错误
    }
    const qualityText = ({ 16: '360P', 32: '480P', 64: '720P', 80: '1080P' })[String(picked.id)] || `${picked.id}P`;
    const base = `bili-${info.bvid}-p${pageNo}`;
    const videoFile = `${base}-v${picked.id}.m4s`;
    const audioFile = `${base}-a${audio?.id || 'x'}.m4s`;
    const auth = await authState();
    const mediaHeaders = { referer: REFERER, 'user-agent': UA, cookie: auth.cookie || `buvid3=${anonBuvid3}` };
    const download = async (stream, name) => {
      const urls = [stream.baseUrl, stream.base_url, ...(stream.backupUrl || stream.backup_url || [])].filter(Boolean);
      let lastError = null;
      for (const url of urls) {
        try {
          return await callHost('cap.media.download', { url, name, maxBytes, headers: mediaHeaders });
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`下载失败：${lastError?.message || lastError}`);
    };
    const ensureDownloaded = async (stream, name) => {
      try { await callHost('cap.media.probe', { file: name }); return; } catch { /* 没缓存才下 */ }
      await download(stream, name);
    };
    await ensureDownloaded(picked, videoFile);
    if (audio) await ensureDownloaded(audio, audioFile);
    else throw new Error('没有取到音频流');
    const outFile = `${base}-${picked.id}.mp4`;
    const merged = await callHost('cap.media.merge', { video: videoFile, audio: audioFile, name: outFile });
    const probe = await callHost('cap.media.probe', { file: outFile }).catch(() => ({}));
    const canSend = context?.chatKey && String(context.chatKey).startsWith('group:')
      && setting('sendVideo', false) === true && sendFile !== false;
    let sent = false;
    let sendError = '';
    if (canSend) {
      try {
        await callHost('cap.send.file', {
          chatKey: String(context.chatKey),
          file: outFile,
          name: `${info.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.mp4`
        });
        sent = true;
      } catch (error) {
        sendError = String(error?.message || error);
      }
    }
    return {
      bvid: info.bvid,
      title: info.title,
      author: info.author,
      page: pageNo,
      quality: qualityText,
      duration: Number(probe?.duration) || info.duration,
      file: outFile,
      bytes: Number(merged?.bytes) || 0,
      sent,
      sendError,
      url: bvLink(info.bvid),
      note: sent
        ? '已把视频发到当前群。'
        : (canSend ? '视频已合流，但发送失败；' : '没有发送文件（未开启发送或不在群聊）；')
          + '文件保留在插件数据目录，链接可直接打开。'
    };
  },

  /**
   * 写操作由宿主统一把门（开关 → 对象级批准 → 配额，见宿主 plugins/registry.js），
   * 插件这里只负责：执行前查当前状态（幂等）、执行、写后回读核验。
   * 失败直接 throw —— 宿主会把已扣的批准与配额退回去。
   */
  async interact({ action, bvid, mid, undo, count } = {}) {
    const auth = await requireWriteAuth();
    if (!['like', 'coin', 'favorite', 'follow', 'triple'].includes(action)) {
      throw new Error('action 只能是 like / coin / favorite / follow / triple');
    }

    if (action === 'follow') {
      const target = String(mid || '').trim();
      if (!/^\d+$/.test(target)) throw new Error('follow 需要 mid（UP 主 UID）');
      const followed = await relationState(target);
      if (!undo && followed) return { ok: true, action, target, skipped: 'already-followed', verified: true };
      if (undo && !followed) return { ok: true, action, target, skipped: 'not-followed', verified: true };
      await httpJson(`${API}/x/relation/modify`, {
        method: 'POST', auth: true,
        form: { fid: target, act: undo ? 2 : 1, re_src: 11, csrf: auth.bili_jct }
      });
      const verified = (await relationState(target)) === !undo;
      return { ok: true, action, target, undo: Boolean(undo), verified };
    }

    const info = await viewOf(bvid);
    if (action === 'triple') {
      if (undo) throw new Error('triple 不支持撤销：请分别用 like / coin / favorite 的 undo');
      const accountMid = await accountMidOf(auth);
      // 先确认收藏夹存在，再动点赞/投币：否则收藏失败时前两步已经写出去，很难解释
      const folders = await httpJson(`${API}/x/v3/fav/folder/created/list-all?up_mid=${accountMid}`, { auth: true });
      const folder = (folders?.data?.list || [])[0];
      if (!folder) throw new Error('你的账号还没有收藏夹，先在 B 站网页建一个再一键三连');
      const inFolder = async () => {
        const list = await httpJson(`${API}/x/v3/fav/resource/list?media_id=${folder.id}&pn=1&ps=20&keyword=${encodeURIComponent(info.bvid)}&platform=web`, { auth: true });
        return (list?.data?.medias || []).some((item) => item.bvid === info.bvid);
      };
      const steps = {};

      const liked = await likedState(info.bvid);
      if (liked) steps.like = { skipped: 'already-liked', verified: true };
      else {
        await httpJson(`${API}/x/web-interface/archive/like`, {
          method: 'POST', auth: true, form: { bvid: info.bvid, like: 1, csrf: auth.bili_jct }
        });
        steps.like = { verified: await likedState(info.bvid) };
      }

      const given = await coinState(info.bvid);
      if (given >= 1) steps.coin = { skipped: `already-${given}-coins`, verified: true };
      else {
        await httpJson(`${API}/x/web-interface/coin/add`, {
          method: 'POST', auth: true, form: { bvid: info.bvid, multiply: 1, select_like: 0, csrf: auth.bili_jct }
        });
        steps.coin = { count: 1, verified: (await coinState(info.bvid)) >= 1 };
      }

      if (await inFolder()) steps.favorite = { skipped: 'already-favorited', folder: folder.title, verified: true };
      else {
        await httpJson(`${API}/x/v3/fav/resource/deal`, {
          method: 'POST', auth: true,
          form: { rid: info.aid, type: 2, add_media_ids: String(folder.id), del_media_ids: '', csrf: auth.bili_jct }
        });
        steps.favorite = { folder: folder.title, verified: await inFolder() };
      }

      const verified = Object.values(steps).every((step) => step.verified);
      return { ok: true, action, target: info.bvid, steps, verified, ...(verified ? {} : { partial: true }) };
    }

    if (action === 'like') {
      const liked = await likedState(info.bvid);
      if (!undo && liked) return { ok: true, action, target: info.bvid, skipped: 'already-liked', verified: true };
      if (undo && !liked) return { ok: true, action, target: info.bvid, skipped: 'not-liked', verified: true };
      await httpJson(`${API}/x/web-interface/archive/like`, {
        method: 'POST', auth: true,
        form: { bvid: info.bvid, like: undo ? 2 : 1, csrf: auth.bili_jct }
      });
      const verified = (await likedState(info.bvid)) === !undo;
      return { ok: true, action, target: info.bvid, undo: Boolean(undo), verified };
    }

    if (action === 'coin') {
      // 幂等：按差额补足到目标枚数，而不是盲目再投 N 枚
      const wantedTotal = num(count, 1, 1, 2);
      const given = await coinState(info.bvid);
      const need = wantedTotal - given;
      if (need <= 0) return { ok: true, action, target: info.bvid, skipped: `already-${given}-coins`, verified: true };
      await httpJson(`${API}/x/web-interface/coin/add`, {
        method: 'POST', auth: true,
        form: { bvid: info.bvid, multiply: need, select_like: 0, csrf: auth.bili_jct }
      });
      const verified = (await coinState(info.bvid)) >= wantedTotal;
      return { ok: true, action, target: info.bvid, count: need, total: wantedTotal, verified };
    }

    // favorite：收藏到默认收藏夹（第一个），写后回读确认
    const accountMid = await accountMidOf(auth);
    const folders = await httpJson(`${API}/x/v3/fav/folder/created/list-all?up_mid=${accountMid}`, { auth: true });
    const folder = (folders?.data?.list || [])[0];
    if (!folder) throw new Error('你的账号还没有收藏夹，先在 B 站网页建一个');
    const inFolder = async () => {
      const list = await httpJson(`${API}/x/v3/fav/resource/list?media_id=${folder.id}&pn=1&ps=20&keyword=${encodeURIComponent(info.bvid)}&platform=web`, { auth: true });
      return (list?.data?.medias || []).some((item) => item.bvid === info.bvid);
    };
    if (!undo && await inFolder()) return { ok: true, action, target: info.bvid, skipped: 'already-favorited', verified: true };
    await httpJson(`${API}/x/v3/fav/resource/deal`, {
      method: 'POST', auth: true,
      form: {
        rid: info.aid, type: 2,
        add_media_ids: undo ? '' : String(folder.id),
        del_media_ids: undo ? String(folder.id) : '',
        csrf: auth.bili_jct
      }
    });
    const verified = (await inFolder()) === !undo;
    return { ok: true, action, target: info.bvid, folder: folder.title, undo: Boolean(undo), verified };
  },

  async comment({ bvid, text, rpid, root, timestamps } = {}) {
    const auth = await requireWriteAuth();
    const body = String(text || '').trim();
    if (!body) throw new Error('评论内容不能为空');
    if (body.length > 500) throw new Error('评论最多 500 字');
    const info = await viewOf(bvid);
    const message = timestamps === true ? linkTimestamps(body, info.bvid) : body;
    if (message.length > 500) throw new Error('加时间戳链接后超过 500 字，请删短正文');
    const parent = String(rpid || '').trim();
    if (parent && !/^\d+$/.test(parent)) throw new Error('rpid 必须是评论的数字 rpid（可在 video 返回的评论里找到）');
    const rootId = String(root || '').trim();
    if (rootId && !/^\d+$/.test(rootId)) throw new Error('root 必须是数字 rpid（回复二级评论时传根评论 rpid）');
    const form = { oid: info.aid, type: 1, message, csrf: auth.bili_jct };
    if (parent) Object.assign(form, { parent: Number(parent), root: Number(rootId) || 0 });
    const data = await httpJson(`${API}/x/v2/reply/add`, { method: 'POST', auth: true, form });
    const replyId = Number(data?.data?.rpid) || 0;
    if (parent) {
      return {
        ok: true,
        bvid: info.bvid,
        rpid: replyId,
        parent: Number(parent),
        root: Number(rootId) || 0,
        url: bvLink(info.bvid),
        note: '回复已提交（B 站可能先审核，不一定立刻可见）。'
      };
    }
    // 回读核验：按 rpid 拉这条评论，拉不到不算 verified（可能被秒删/进审核）
    let verified = false;
    if (replyId) {
      try {
        const back = await httpJson(`${API}/x/v2/reply/view?type=1&oid=${info.aid}&root=${replyId}`, { auth: true });
        verified = Number(back?.data?.root?.rpid) === replyId || Number(back?.data?.replies?.[0]?.rpid) === replyId;
      } catch { verified = false; }
    }
    return { ok: true, bvid: info.bvid, rpid: replyId, verified, url: bvLink(info.bvid) };
  },

  async danmaku({ bvid } = {}) {
    const info = await viewOf(bvid);
    const raw = await httpJson(`${API}/x/v1/dm/list.so?oid=${info.cid}`, { asText: true, decompress: true });
    const rows = [];
    const re = /<d p="([^"]*)">([^<]*)<\/d>/g;
    let match;
    while ((match = re.exec(raw)) && rows.length < num(setting('danmakuCount', 30), 30, 10, 100)) {
      const parts = match[1].split(',');
      rows.push({ atMs: Math.round((Number(parts[0]) || 0) * 1000), mode: Number(parts[1]) || 1, text: match[2] });
    }
    if (!rows.length) {
      throw new Error('没有读到弹幕（接口可能返回了压缩数据，或这个视频关了弹幕）');
    }
    return { bvid: info.bvid, count: rows.length, results: rows };
  },

  async danmaku_send({ bvid, text, progressMs } = {}) {
    const auth = await requireWriteAuth();
    const want = String(text || '').trim();
    if (!want) throw new Error('弹幕内容不能为空');
    if (want.length > 100) throw new Error('弹幕最多 100 字');
    const info = await viewOf(bvid);
    const sendOnce = (endpoint) => httpJson(`${API}${endpoint}`, {
      method: 'POST', auth: true,
      form: {
        oid: info.cid, type: 1, msg: want,
        progress: num(progressMs, 5000, 0, Math.max(1000, info.duration * 1000)),
        bvid: info.bvid, csrf: auth.bili_jct
      }
    });
    try {
      await sendOnce('/x/v1/dm/post');
    } catch (error) {
      // 老接口被关时退回 v2（两个接口的参数一致）
      if (!/HTTP 404|-404/.test(String(error?.message || error))) throw error;
      await sendOnce('/x/v2/dm/post');
    }
    // 弹幕没有可靠的按条回读接口：不标 verified，宿主按发送接口 200 记成功
    return { ok: true, bvid: info.bvid, text: want, url: bvLink(info.bvid) };
  }
};


// 应用层自检（控制台"检测登录"按钮走这里）：一次 nav 实测，不猜"文件在不在"
async function probeStatus() {
  const c = await cookies();
  let apiOk = true;
  let login = false;
  let uname = '';
  let mid = '';
  if (c.sessdata) {
    try {
      const nav = await httpJson(`${API}/x/web-interface/nav`, { auth: true, allowCodes: [-101] });
      login = nav?.data?.isLogin === true;
      uname = login ? String(nav.data.uname || '').slice(0, 24) : '';
      mid = login ? String(nav.data.mid || '') : '';
    } catch { apiOk = false; }
  }
  const boundOwner = String(setting('ownerMid', '') || '').trim();
  return {
    ok: true,
    login,
    writable: Boolean(c.sessdata && c.bili_jct),
    mid,
    uname,
    owner: {
      configured: boundOwner,
      // null = 没绑定主人 UID（不限制）；true/false = 当前登录账号与绑定是否一致
      matches: boundOwner ? (Boolean(mid) && mid === boundOwner) : null
    },
    apiOk,
    note: login
      ? (c.bili_jct ? '登录有效' : '登录有效，但缺 bili_jct：读操作可用，写操作不可用')
      : (c.sessdata ? 'SESSDATA 已配置但登录态无效（可能过期）' : '未配置 Cookie（只读功能可用，写操作需要登录）'),
    configured: { sessdata: Boolean(c.sessdata), bili_jct: Boolean(c.bili_jct), buvid3: Boolean(c.buvid3), dedeuserid: Boolean(c.dedeuserid) }
  };
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message?.method === 'callTool') {
        const fn = tools[message.params?.name];
        if (!fn) send({ id: message.id, error: { code: 'E_NO_TOOL', message: `没有这个工具：${message.params?.name}` } });
        else {
          Promise.resolve()
            .then(() => fn(message.params?.args ?? {}, message.params?.context ?? {}))
            .then((result) => send({ id: message.id, result }))
            .catch((error) => send({ id: message.id, error: { code: error?.code || 'E_TOOL', message: String(error?.message || error) } }));
        }
      } else if (message?.method === 'init') {
        settings = message.params?.settings && typeof message.params.settings === 'object' ? message.params.settings : {};
        send({ id: message.id, result: { ok: true } });
      } else if (message?.method === 'probe') {
        Promise.resolve()
          .then(() => probeStatus())
          .then((result) => send({ id: message.id, result }))
          .catch((error) => send({ id: message.id, error: { code: 'E_PROBE', message: String(error?.message || error) } }));
      } else if (message?.method === 'ping') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'schedule') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'shutdown') {
        send({ id: message.id, result: {} });
        setTimeout(() => process.exit(0), 10);
      } else if (message?.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(Object.assign(new Error(message.error.message || '能力调用失败'), { code: message.error.code }));
          else entry.resolve(message.result ?? null);
        }
      }
    }
    index = buffer.indexOf('\n');
  }
});
