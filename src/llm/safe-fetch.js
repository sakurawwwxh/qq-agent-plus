// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程；
// - HTTPS GET/媒体下载优先 HTTP/2，连接层失败回落 HTTP/1.1（POST 不自动回落，避免重复写入）。
//
// 例外开关：security.allowPrivateImageHosts = true 时，图片下载跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import { getConfig } from '../core/config.js';

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

/** 默认 fake-ip 网段（RFC 2544）；可通过 security.fakeIpCidrs 追加 IPv6 fake-ip6。 */
export const DEFAULT_FAKE_IP_CIDRS = Object.freeze(['198.18.0.0/15']);

/**
 * 判断 DNS 解析结果是否落在配置的 fake-ip 网段。支持 IPv4 / IPv6 CIDR，
 * 也支持 ::ffff:198.18.x.x 这类内嵌 IPv4 形态。
 */
export function isFakeIpAddress(ip, cidrs = DEFAULT_FAKE_IP_CIDRS) {
  const raw = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw) return false;
  const embedded = raw.includes(':') ? parseEmbeddedIpv4(raw) : null;
  const target = embedded || raw;
  const family = net.isIP(target);
  if (!family) return false;
  const list = new net.BlockList();
  let added = false;
  for (const cidr of Array.isArray(cidrs) ? cidrs : DEFAULT_FAKE_IP_CIDRS) {
    const match = /^([0-9a-f:.]+)\/(\d{1,3})$/i.exec(String(cidr || '').trim());
    if (!match) continue;
    const base = match[1];
    const prefix = Number(match[2]);
    const type = net.isIP(base);
    if (!type) continue;
    if ((type === 4 && prefix > 32) || (type === 6 && prefix > 128)) continue;
    try {
      list.addSubnet(base, prefix, type === 4 ? 'ipv4' : 'ipv6');
      added = true;
    } catch { /* 坏 CIDR 跳过，不影响其他网段 */ }
  }
  if (!added) return false;
  return list.check(target, family === 4 ? 'ipv4' : 'ipv6');
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────

async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    // fake-ip 代理会把任意域名解析到配置的 fake-ip 网段；只放行"DNS 结果"，
    // 直接在 URL 里写这些 IP 仍会被上面的 net.isIP 分支拦住。
    const security = getConfig().security || {};
    const allowFakeIpDns = security.allowFakeIpDns !== false;
    const fakeCidrs = security.fakeIpCidrs;
    for (const { address } of addresses) {
      if (isPrivateIp(address) && !(allowFakeIpDns && isFakeIpAddress(address, fakeCidrs))) {
        throw new Error('域名解析到内网/本机地址，已阻止');
      }
    }
    const usable = addresses.find(({ address }) => !isPrivateIp(address) || isFakeIpAddress(address, fakeCidrs));
    return (usable || addresses[0]).address;
  }
  return addresses[0].address;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip }。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

export function readBounded(res, maxBytes, asText) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chunks = [];
    let total = 0;
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (asText) text += decoder.write(chunk);
      else chunks.push(chunk);
      // 只用字节数判断是否超限。**必须是 > 不能是 >=**：正好等于上限的响应是完整的，
      // 用 >= 会在读满那一刻就 destroy 并把它误标成 truncated（2026-10-09 审查）。
      //
      // truncated 标记由**读取路径**如实带出（不再让调用方拿 body 长度反推）：截断后的
      // 正文长度可能恰好等于上限（英文页截到 50000 字节就是），反推会漏标。
      if (total > maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        finish(resolve, {
          truncated: true,
          body: asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes)
        });
      }
    });
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end();
          // 自然读尽 = 没被截断（走到这里 total 必 ≤ maxBytes，slice 只是防御）
          finish(resolve, { truncated: false, body: sliceByCodePoints(text, maxBytes) });
        } else {
          finish(resolve, { truncated: false, body: Buffer.concat(chunks) });
        }
      }
    });
    res.on('error', (err) => finish(reject, err));
    // HTTP/2 的 RST_STREAM(NO_ERROR) 只会触发 close，不会触发 error；HTTP/1.1 的
    // 提前断连也可能只走到 close。没有这条，读体会永远等不到 settle（只能等超时）。
    res.on('close', () => {
      if (!settled) finish(reject, new Error('响应在读取完成前关闭'));
    });
  });
}

// 使用已校验的 IP 发起 HTTP/1.1 请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestHttp1(url, ip, { asBinary = false, maxBytes = 50000, signal, headers, method = 'GET', body = null, wantSetCookies = false } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const verb = String(method || 'GET').toUpperCase();
    const payload = body === null || body === undefined || verb === 'GET' || verb === 'HEAD'
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    // 调用方只传静态 Accept 这类头（GitHub API 的 raw 内容）；不允许带换行，避免头注入
    const extraHeaders = {};
    for (const [key, value] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
      const name = String(key).toLowerCase();
      // host 不能由调用方覆盖（SSRF 校验按目标 URL 做 DNS/IP 钉扎）；其余是请求体头，GET 不需要
      if (['host', 'content-length', 'transfer-encoding'].includes(name)) continue;
      if (/[\r\n]/.test(String(key)) || /[\r\n]/.test(String(value))) continue;
      extraHeaders[name] = String(value);
    }
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: verb,
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...(payload ? { 'content-length': payload.length } : {}),
        ...extraHeaders
      },
      // RFC 6066 不允许把 IP 字面量当 SNI；空字符串让 TLS 不发 SNI，证书仍按 IP SAN 校验。
      servername: url.protocol !== 'https:'
        ? undefined
        : net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? '' : url.hostname,
      rejectUnauthorized: url.protocol === 'https:',
      signal,
      timeout: 20000
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        // 不要 resume() 排空响应体：它不计入 maxBytes，恶意目标可以一直吐数据把连接占住
        res.destroy();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBounded(res, maxBytes, !asBinary)
.then(({ body, truncated }) => resolve({
          statusCode, body, truncated,
          contentType: String(res.headers['content-type'] || ''),
          contentEncoding: String(res.headers['content-encoding'] || ''),
          // 默认不带（到处返回 Set-Cookie 是泄漏面）；显式要的调用方（扫码登录 poll）才拿得到
          ...(wantSetCookies ? { setCookies: res.headers['set-cookie'] || [] } : {})
        }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── HTTP/2 ───────────────────────────────────────────────────────────────
//
// Cloudflare 会对 HTTP/1.1 请求按版本/指纹挑战（e926/e621 等站点的 API 与图床都是
// HTTP/1.1 403、HTTP/2 200）。这里在 HTTPS GET 上先走 HTTP/2，连接/协议层失败再回落
// HTTP/1.1；两条路都继续使用已经校验并固定的 IP，DNS、重定向、凭据与体积规则不变。
//
// 为什么 POST 不自动回落：h2 请求可能已经到达对端，再发一次 h1 会造成重复写入。
// 插件的写请求继续只走 HTTP/1.1；读请求（GET）才享受 h2 优先与安全重试。
const HTTP2_TIMEOUT_MS = 20000;
const HTTP2_FALLBACK_CODE = 'E_HTTP2_FALLBACK';
const H2_HOP_BY_HOP = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'proxy-connection', 'upgrade', 'http2-settings', 'te'
]);

class Http2UnavailableError extends Error {
  constructor(cause) {
    super(`HTTP/2 不可用：${cause?.message ?? cause}`);
    this.name = 'Http2UnavailableError';
    this.code = HTTP2_FALLBACK_CODE;
    this.cause = cause;
  }
}

function firstHeader(value) {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function setCookieValues(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function h2RequestHeaders(url, headers, payload, verb) {
  const extraHeaders = {};
  for (const [key, value] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    const name = String(key).toLowerCase();
    // host 由 :authority 承担；连接级头在 h2 里非法；content-length 由下面按 payload 重算。
    if (H2_HOP_BY_HOP.has(name) || name.startsWith(':')) continue;
    if (/[\r\n]/.test(String(key)) || /[\r\n]/.test(String(value))) continue;
    extraHeaders[name] = String(value);
  }
  return {
    ':method': verb,
    ':path': `${url.pathname || '/'}${url.search || ''}`,
    ':scheme': 'https',
    ':authority': url.host,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...(payload ? { 'content-length': String(payload.length) } : {}),
    ...extraHeaders
  };
}

function requestHttp2(url, ip, { asBinary = false, maxBytes = 50000, signal, headers, method = 'GET', body = null, wantSetCookies = false } = {}) {
  return new Promise((resolve, reject) => {
    const port = url.port || 443;
    const verb = String(method || 'GET').toUpperCase();
    const payload = body === null || body === undefined || verb === 'GET' || verb === 'HEAD'
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let session = null;
    let stream = null;
    let settled = false;
    let gotResponse = false;

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      try { stream?.close(); } catch { /* ignore */ }
      try { session?.close(); } catch { /* ignore */ }
      try { session?.destroy(); } catch { /* ignore */ }
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const unavailable = (error) => fail(new Http2UnavailableError(error));
    const onAbort = () => fail(signal?.reason ?? new Error('请求已取消'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      session = http2.connect(url.origin, {
        host: ip,
        port,
        // RFC 6066 不允许把 IP 字面量当 SNI；空字符串让 TLS 不发 SNI，证书仍按 IP SAN 校验。
        servername: net.isIP(hostname) ? '' : hostname,
        rejectUnauthorized: true,
        // 抓取客户端不使用 server push；关掉可以避免恶意源占满 reserved stream。
        settings: { enablePush: false }
      });
    } catch (error) {
      unavailable(error);
      return;
    }
    session.setTimeout(HTTP2_TIMEOUT_MS, () => fail(new Error(`请求超时：${url.hostname}`)));
    session.once('error', (error) => (gotResponse ? fail(error) : unavailable(error)));
    session.once('close', () => {
      if (settled) return;
      const error = new Error(`HTTP/2 连接已关闭：${url.hostname}`);
      if (gotResponse) fail(error);
      else unavailable(error);
    });

    try {
      stream = session.request(h2RequestHeaders(url, headers, payload, verb));
    } catch (error) {
      fail(error);
      return;
    }
    stream.setTimeout(HTTP2_TIMEOUT_MS, () => fail(new Error(`请求超时：${url.hostname}`)));
    stream.once('error', (error) => (gotResponse ? fail(error) : unavailable(error)));
    stream.once('response', (responseHeaders) => {
      gotResponse = true;
      const statusCode = Number(responseHeaders[':status']) || 0;
      const meta = {
        contentType: firstHeader(responseHeaders['content-type']),
        contentEncoding: firstHeader(responseHeaders['content-encoding'])
      };
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        settle({ statusCode, redirect: firstHeader(responseHeaders.location) });
        return;
      }
      readBounded(stream, maxBytes, !asBinary)
        .then(({ body: responseBody, truncated }) => settle({
          statusCode,
          body: responseBody,
          truncated,
          ...meta,
          ...(wantSetCookies ? { setCookies: setCookieValues(responseHeaders['set-cookie']) } : {})
        }))
        .catch(fail);
    });
    if (payload) stream.end(payload);
    else stream.end();
  });
}

async function requestOnce(url, ip, options = {}) {
  const verb = String(options.method || 'GET').toUpperCase();
  if (url.protocol === 'https:' && verb === 'GET') {
    try {
      return await requestHttp2(url, ip, options);
    } catch (error) {
      // 只在响应前连接/流失败时回落；已经拿到响应、被取消或超时都不能重试。
      if (error?.code !== HTTP2_FALLBACK_CODE || options.signal?.aborted) throw error;
    }
  }
  return requestHttp1(url, ip, options);
}

const MAX_REDIRECTS = 5;

const CREDENTIAL_HEADER_RE = /^(cookie|authorization|proxy-authorization)$/i;

function hasCredentialHeaders(headers) {
  if (!headers || typeof headers !== 'object') return false;
  return Object.keys(headers).some((key) => CREDENTIAL_HEADER_RE.test(key));
}

/** 跨源重定向时剥掉凭据头：白名单只说明"这个域可信"，不等于"可以把 Cookie 交给它"。 */
function stripCredentialHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADER_RE.test(key)) next[key] = value;
  }
  return next;
}

/**
 * 域名白名单判定：主机名精确命中，或命中列表里的某个父域（`api.example.com` 被 `example.com` 放行）。
 * 插件的 httpDomains 在**初始 URL 和每一跳重定向**上都要过这道判定 ——
 * 只查初始 URL 的话，白名单域一个 302 就能把请求（连同 Cookie）带到任意公网站。
 */
export function isHostAllowed(hostname, domains) {
  if (!Array.isArray(domains) || !domains.length) return true;
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return domains.some((raw) => {
    const domain = String(raw || '').toLowerCase().replace(/\.$/, '');
    if (!domain) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function assertAllowedHost(url, domains, label = '地址') {
  if (!isHostAllowed(url.hostname, domains)) {
    throw new Error(`${label} ${url.hostname} 不在允许的域名白名单里（跟随重定向时每一跳都会检查）`);
  }
}

/**
 * 抓取网页文本（默认 ≤50000 字符），SSRF 全防护（不做内网例外）。
 * `maxBytes` 只给"结构化文件"用（插件索引随条目增多会长过网页那份上限）；
 * 网页抓取保持默认值，避免把整页塞进上下文。
 */
export async function safeFetch(urlString, { maxBytes = 50000, signal, headers, allowPrivate = false } = {}) {
  const cap = Math.max(1, Math.floor(Number(maxBytes) || 50000));
  // allowPrivate 只给"管理员明确配置的内网价目表/自建服务"用；默认一律拦内网。
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  let hopHeaders = headers;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // signal 用于"整次抓取的总截止时间"：默认的 timeout 是**空闲超时**，对端每隔十几秒吐一个
    // 字节就能把连接一直吊着（慢速攻击面，2026-10-17 审查 P3）
    const result = await requestOnce(url, ip, { asBinary: false, maxBytes: cap, signal, headers: hopHeaders });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      // 跨跳不携带凭据头（与 safeFetchRequest / safeFetchBinary 同口径）：
      // 不能让一个 302 把 Authorization/Cookie 带到别的站点，哪怕域名白名单放行了。
      hopHeaders = stripCredentialHeaders(hopHeaders);
      continue;
    }
    const body = result.body || '';
    // truncated 由读取路径给出（"真的被截断"）：不能再拿长度反推 —— 截断后的正文可能
    // 恰好等于 50000 字节，反推会把它当成完整内容交给模型（2026-10-09 审查）。
    return { url: url.toString(), statusCode: result.statusCode, truncated: Boolean(result.truncated), body };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 带方法与请求体的安全抓取（插件 v2 用）。GET 之外的请求**不跟随重定向**：
 * 3xx 之后再带一次凭据（Cookie/Token）去别的地址，等于把凭据交给第一个会发 302 的服务器；
 * B 站的接口本来也不靠重定向，遇到就如实报错。
 *
 * 方法白名单只开 GET/POST：插件生态里没有 PUT/DELETE 的真实需求，
 * 每多一个动词就多一类"误删远端数据"的失败模式。
 */
export async function safeFetchRequest(urlString, {
  method = 'GET', headers = null, body = null, maxBytes = 50000, signal, decompress = false,
  allowedDomains = null, allowPrivate = false, withSetCookies = false
} = {}) {
  const verb = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(verb)) throw new Error(`不支持的请求方法：${verb}（只允许 GET / POST）`);
  const payload = body === null || body === undefined ? null : Buffer.from(String(body), 'utf8');
  if (payload && payload.length > 64 * 1024) throw new Error('请求体超过 64KB 上限');
  const cap = Math.max(1, Math.floor(Number(maxBytes) || 50000));
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  assertAllowedHost(url, allowedDomains, '请求');
  // 凭据只交给起始源：重定向到别的源（含 https→http 降级）时剥掉 Cookie/Authorization。
  // 白名单允许的是"这个域可以访问"，不是"可以把登录态转发给它"（2026-10-24 审查 P2）。
  let currentHeaders = headers;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, {
      asBinary: decompress, maxBytes: cap, signal, headers: currentHeaders, method: verb, body: payload,
      wantSetCookies: withSetCookies
    });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (verb !== 'GET') throw new Error(`请求被重定向（HTTP ${result.statusCode}）：已停止，避免把凭据带到另一个地址`);
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      const nextUrl = new URL(next);
      if (hasCredentialHeaders(currentHeaders)
        && (nextUrl.protocol !== url.protocol || nextUrl.host !== url.host)) {
        currentHeaders = stripCredentialHeaders(currentHeaders);
      }
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      assertAllowedHost(url, allowedDomains, '重定向');
      continue;
    }
    let text = result.body;
    if (decompress && Buffer.isBuffer(text)) {
      // 有些接口（B 站弹幕 XML）不看 accept-encoding，照样回 deflate/gzip。
      // 解压上限按 5 倍封顶：压缩炸弹不能靠一个 40KB 响应把宿主内存打满。
      const encoded = String(result.contentEncoding || '').toLowerCase();
      if (encoded.includes('gzip')) text = zlib.gunzipSync(text, { maxOutputLength: cap * 5 });
      else if (encoded.includes('br')) text = zlib.brotliDecompressSync(text, { maxOutputLength: cap * 5 });
      else if (encoded.includes('deflate')) {
        try { text = zlib.inflateSync(text, { maxOutputLength: cap * 5 }); } catch { text = zlib.inflateRawSync(text, { maxOutputLength: cap * 5 }); }
      }
      text = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
    }
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: Boolean(result.truncated),
      contentType: String(result.contentType || ''),
      body: text || '',
      // 扫码登录 poll 用：B 站成功时 Cookie 在 Set-Cookie 里（跨域回跳 URL 的查询串会被对方
      // 网关拦截/替换，不能依赖）。仅当调用方显式要时才有这个字段。
      ...(withSetCookies && Array.isArray(result.setCookies) ? { setCookies: result.setCookies } : {})
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024, signal, { allowPrivate = undefined, headers = null, allowedDomains = null } = {}) {
  // 插件媒体走这里时显式传 allowPrivate:false：图片那条隐私例外只属于管理员配的自建图床，
  // 不该被第三方插件继承（否则"允许内网图片"= 插件可以摸内网）。
  const allow = allowPrivate === undefined ? getConfig().security?.allowPrivateImageHosts === true : allowPrivate === true;
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate: allow });
  assertAllowedHost(url, allowedDomains, '下载');
  let currentHeaders = headers;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    signal?.throwIfAborted();
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes: maxBytes + 1, signal, headers: currentHeaders });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      const nextUrl = new URL(next);
      // 与 safeFetchRequest 同口径：跨源/降级重定向时剥掉凭据，别把 Cookie 交给 CDN 之外的域
      if (hasCredentialHeaders(currentHeaders)
        && (nextUrl.protocol !== url.protocol || nextUrl.host !== url.host)) {
        currentHeaders = stripCredentialHeaders(currentHeaders);
      }
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate: allow }));
      assertAllowedHost(url, allowedDomains, '重定向');
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    if (result.truncated || result.body.length > maxBytes) throw new Error(`响应体超过 ${maxBytes} 字节限制`);
    return { buffer: result.body, contentType: result.contentType };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}

/**
 * 通用「必须是公网 http(s) 地址」校验 —— 给**不经过 safe-fetch 抓取**、而是把地址
 * 原文交给协议端（OneBot）去下载的工具用。
 *
 * 为什么必须有这一层：safe-fetch 只管自己发出的请求。`send_group_file` / `set_my_avatar` /
 * `read_image_text` / `upload_to_group_album` 这类工具是把 `file`/`image` 参数原样交给协议端
 * 的 API，由协议端去取 —— 该请求完全在我们的网络层之外，safe-fetch 的内网/SSRF 防护一点也
 * 盖不到。而协议端（Docker 容器）是能顺着 docker bridge 访问宿主的，于是「模型被群消息里的
 * 提示词注入 → 调用工具时给一个内网地址」就成了一条现成的 SSRF + 数据外带通道（把内网响应
 * 当文件发进群）。2026-10-09 全面审查发现。
 *
 * 与 validateImageUrl 分开而不是复用它：这个的报错文案必须是通用的（不是「图片地址」），
 * 否则用户发文件失败时看到一句“图片地址不合法”会一头雾水。
 *
 * 内网例外沿用同一个开关（security.allowPrivateImageHosts，默认关）：本地测试/自建图床
 * 靠它放行，生产默认是 fail-closed 的。
 *
 * **为什么是同步的、而且不做 DNS**（2026-10-09 审查里踩过一次才定下来）：
 * 一开始这层复用了 validateFetchUrl（带 DNS 解析）。实测有两个问题：
 *   ① 它把每一次工具调用（读图/换头像/发文件/传相册）都绑到了“我们这边 DNS 可用”上，
 *      离线或内网部署下这些功能全部直接失败（test/sim-group-tools 当场变红就是这个原因）；
 *   ② 它并不能真的防 DNS rebinding —— 地址最终是**协议端**去解析的，我们解析到的 IP
 *      约束不了它的解析结果。多花一次网络往返，买到的安全感是假的。
 * 字面量检查零成本、零依赖，且能拦住实际攻击 payload 的绝大多数（提示词注入里几乎只会写
 * 127.0.0.1 / 169.254.169.254 / 10.x / 172.17.0.1 / localhost 这类字面量）。
 *
 * **已知未防护（明说，别当成漏洞又"修"回去）**：域名解析到内网（如
 * `http://169.254.169.254.nip.io/…`）这层拦不住 —— 地址最终由协议端解析，我们解析到的 IP
 * 约束不了它的结果。要闭合这条路只能改成"我们自己用 safeFetchBinary 取回、再把 base64
 * 交给协议端"（本地文件已经是这个模式），那是一次功能改造而不是加几行校验（2026-10-09 审查）。
 */
export function assertPublicUrlLiteral(raw, { label = '地址' } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error(`${label}不合法`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`只允许 http(s) 的${label}`);
  if (url.username || url.password) throw new Error(`${label}不能包含凭据`);
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // isPrivateIp 对非 IP 的字面量（普通域名）返回 false，只有真的是 IP 时才判内网
  if (isPrivateIp(host)) throw new Error(`${label}指向内网或本机，已拒绝`);
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')
    || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error(`${label}指向内网或本机，已拒绝`);
  }
  return url.toString();
}
