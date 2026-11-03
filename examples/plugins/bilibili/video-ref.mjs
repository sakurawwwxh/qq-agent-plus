const BVID_RE = /^[Bb][Vv][0-9A-Za-z]{10}$/;
const AVID_RE = /^av\d+$/i;
const B23_CODE_RE = /^[A-Za-z0-9]{1,32}$/;

function videoQuery(value) {
  if (BVID_RE.test(value)) return `bvid=${encodeURIComponent(`BV${value.slice(2)}`)}`;
  if (AVID_RE.test(value)) return `aid=${value.slice(2)}`;
  return '';
}

function isBilibiliHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'bilibili.com' || host.endsWith('.bilibili.com');
}

function parseVideoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;

  if (url.hostname.toLowerCase() === 'b23.tv') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 1 && B23_CODE_RE.test(parts[0])) {
      const query = videoQuery(parts[0]);
      if (query) return { query };
      return { shortUrl: `https://b23.tv/${parts[0]}` };
    }
    if (parts.length === 2 && /^p\d+$/i.test(parts[1])) {
      const query = videoQuery(parts[0]);
      if (query) return { query };
    }
    return null;
  }

  if (!isBilibiliHost(url.hostname)) return null;
  const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/i);
  if (!match) return null;
  const query = videoQuery(match[1]);
  return query ? { query } : null;
}

/**
 * 把一个明确的视频输入归一化为 view API 查询参数。
 * 裸号本地解析；完整的 B 站视频 URL 也本地解析；普通 b23.tv 短码留待一次有界 HTTP 跟随。
 */
export function parseVideoRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const query = videoQuery(raw);
  if (query) return { query };
  return /^https?:\/\//i.test(raw) ? parseVideoUrl(raw) : null;
}

/** 解析一个标签里的属性：只按精确属性名取值，避免 `data-href` 被当成 `href`。 */
function attributesOf(tag) {
  const attrs = new Map();
  // 不要求属性前有空白：浏览器会容忍 `rel="canonical"href="..."` 这种缺空格的写法。
  // 正则按“名字=值”顺序匹配并跳过整个值，所以不会把 href 值里的 rel=... 当成属性。
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of String(tag || '').matchAll(re)) {
    const name = match[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** 从最终页里只取 canonical link，属性顺序与引号形式都不敏感。 */
export function extractCanonicalHref(html) {
  for (const match of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributesOf(match[0]);
    const rel = String(attrs.get('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!rel.includes('canonical')) continue;
    const href = String(attrs.get('href') || '').replace(/&amp;/gi, '&').trim();
    if (href) return href;
  }
  return '';
}

/** canonical 可能是绝对地址、站内绝对路径或协议相对地址；统一按 B 站站内基准解析。 */
function absoluteCanonical(href) {
  try {
    return new URL(href, 'https://www.bilibili.com/').toString();
  } catch {
    return '';
  }
}

/**
 * 解析不透明 b23.tv 短码。request 必须仍由插件宿主提供，测试里可以注入内存响应；
 * canonical 结果会再经过同一视频 URL 解析，不能直接信任页面里的任意跳转目标。
 */
export async function resolveVideoQuery(input, request) {
  const parsed = parseVideoRef(input);
  if (!parsed) throw new Error('需要 BV 号、av 号、B 站视频链接或 b23.tv 短链');
  if (parsed.query) return parsed.query;
  if (typeof request !== 'function') throw new Error('短链解析缺少宿主 HTTP 请求');

  const response = await request({ url: parsed.shortUrl });
  const status = Number(response?.status) || 0;
  if (status !== 200) throw new Error(`B 站短链返回 HTTP ${status || '?'}`);
  const canonical = extractCanonicalHref(response?.body);
  const target = canonical ? parseVideoRef(absoluteCanonical(canonical)) : null;
  if (!target?.query) throw new Error('B 站短链没有解析到有效视频地址');
  return target.query;
}
