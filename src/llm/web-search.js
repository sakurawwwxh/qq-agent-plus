// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
import crypto from 'node:crypto';
import { getConfig } from '../core/config.js';
import { safeFetch } from './safe-fetch.js';
import { assertTimeAllowed, withTimeWindow } from '../core/time-gate.js';
import { readJsonBounded, readTextBounded } from '../core/http-body.js';

// 各上游响应体量上限（防畸形/超大响应把常驻进程读爆，只设超时挡不住这一点）。
// 搜索 API 返回的是结构化短文本，2 MiB 已远超正常结果；Bing 的 RSS/HTML 响应 1 MiB 足够。
const SEARCH_JSON_MAX_BYTES = 2 * 1024 * 1024;
const BING_HTML_MAX_BYTES = 1024 * 1024;
// RSS 先尝试 5 秒；回退 HTML 只使用总预算的剩余时间，不把原有 15 秒上限翻倍。
const BING_TOTAL_TIMEOUT_MS = 15_000;
const BING_RSS_TIMEOUT_MS = 5_000;
const BING_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9'
};

// B 站 wbi 签名：不带签名时，搜索几次后会只返回 v_voucher（人机验证），没有 result。
// 公开的 mixinKey 置换表；key 从 nav 接口的 wbi_img 文件名拼出来，缓存半小时。
const BILI_MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let biliMixinCache = { mix: '', at: 0 };

const biliEnc = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, '');

async function biliMixinKey() {
  if (biliMixinCache.mix && Date.now() - biliMixinCache.at < 30 * 60 * 1000) return biliMixinCache.mix;
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      referer: 'https://www.bilibili.com/'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`B 站 wbi key HTTP ${res.status}`);
  const data = await readSearchJson(res, 'B 站 wbi key 返回了无法解析的 JSON');
  const img = String(data?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0];
  const sub = String(data?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0];
  if (!img || !sub) throw new Error('B 站 wbi key 缺失');
  const raw = img + sub;
  const mix = BILI_MIXIN_TAB.map((n) => raw[n]).join('').slice(0, 32);
  biliMixinCache = { mix, at: Date.now() };
  return mix;
}

function biliSignedQuery(params, mix) {
  const qs = Object.keys(params).sort().map((k) => `${biliEnc(k)}=${biliEnc(params[k])}`).join('&');
  if (!mix) return qs;
  const wRid = crypto.createHash('md5').update(qs + mix).digest('hex');
  return `${qs}&w_rid=${wRid}`;
}

// provider 的 JSON 解析：只有 JSON 语法错误才转成「无法解析」；超限、超时、连接中断一律原样抛出 ——
// 它们对外含义不同，把"读正文时超时"伪装成"返回的 JSON 坏了"会让排障方向完全跑偏
//（慢供应商在响应头之后超时是常见故障，2026-10-17 审查 P3）。
function readSearchJson(res, message) {
  return readJsonBounded(res, SEARCH_JSON_MAX_BYTES).catch((error) => {
    if (error?.code === 'BODY_TOO_LARGE') throw error;
    if (error instanceof SyntaxError) throw new Error(message);
    throw error;
  });
}

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 聚合搜索：并发跑多个 provider，结果按来源标注合并去重。
 * config.webSearch.aggregate.sources = ['doubao','bing','baidu',...]（按优先级排序），
 * 任一源失败不影响整体；全部失败才抛错。
 * # ponytail: 简单并发+URL去重；排名融合（RRF）等结果多了再加。
 */
export async function aggregateSearch(query) {
  const cfg = getConfig().webSearch?.aggregate ?? {};
  const sources = (Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : ['doubao', 'bing'])
    .map(String).slice(0, 4);
  const perSource = Math.max(2, Math.min(6, Number(cfg.count) || 4));
  const settled = await Promise.allSettled(sources.map(async (name) => {
    const fn = { doubao: doubaoSearch, bing: bingSearch, baidu: baiduSearch, zhipu: zhipuSearch, bocha: bochaSearch, metaso: metasoSearch, tavily: tavilySearch, so360: so360Search, sogou: sogouSearch, bilibili: bilibiliSearch }[name];
    if (!fn) throw new Error(`未知搜索源: ${name}`);
    const r = await fn(query);
    return { source: name, results: (r.results || []).slice(0, perSource) };
  }));
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!ok.length) {
    const errs = settled.map((s) => `${s.reason?.message ?? s.reason}`).join('；');
    throw new Error(`聚合搜索全部源失败：${errs.slice(0, 300)}`);
  }
  // 合并去重：URL 优先级 = 源顺序（前面的源排名更高）；同一 URL 只保留第一次出现
  const seen = new Set();
  const results = [];
  for (const { source, results: items } of ok) {
    for (const item of items) {
      const url = String(item?.url || '').replace(/[#?].*$/, '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({ ...item, source });
    }
  }
  return { query, results, sources: ok.map((o) => o.source), failed: sources.filter((s) => !ok.some((o) => o.source === s)) };
}

function isBingSearchUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'bing.com' || hostname.endsWith('.bing.com');
  } catch {
    return false;
  }
}

function parseBingRss(xml, maxResults) {
  const results = [];
  const items = String(xml || '').matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi);
  for (const match of items) {
    const block = match[1];
    const pick = (tag) => {
      const found = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return found ? decodeHtml(found[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
    };
    const title = pick('title') || '（无标题）';
    const url = pick('link');
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, snippet: pick('description') });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function bingRssSearch(query, { searchUrl, maxResults, deadline }) {
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'rss');
  const timeoutMs = Math.max(1, Math.min(BING_RSS_TIMEOUT_MS, deadline - Date.now()));
  const res = await fetch(url, {
    headers: BING_HEADERS,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`Bing RSS HTTP ${res.status}`);
  const xml = await readTextBounded(res, BING_HTML_MAX_BYTES);
  return parseBingRss(xml, maxResults);
}

async function bingHtmlSearch(query, { searchUrl, maxResults, deadline }) {
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: BING_HEADERS,
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await readTextBounded(res, BING_HTML_MAX_BYTES);
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  // 与其他 provider 口径一致：空结果 = 搜索失败而不是"搜到了 0 条"。
  // Bing 是 HTML 抓取，命中验证页/同意页/改版 DOM 时这里会是空数组——
  // 不抛错的话模型只看到一个空列表，容易转而编造内容（Issue #9）。
  if (!results.length) throw new Error('Bing 搜索没有返回可解析的结果（可能命中验证页或页面结构变化，可换个搜索提供方）');
  return results;
}

/** Bing 搜索：优先 RSS，失败或为空时回退原 HTML 结果页。searchUrl 可换成非 Bing 地址。 */
export async function bingSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const deadline = Date.now() + BING_TOTAL_TIMEOUT_MS;
  if (isBingSearchUrl(searchUrl)) {
    try {
      const results = await bingRssSearch(query, { searchUrl, maxResults, deadline });
      if (results.length) return { query, results };
    } catch { /* RSS 不可用时保留原 HTML 解析路径 */ }
  }
  return { query, results: await bingHtmlSearch(query, { searchUrl, maxResults, deadline }) };
}

// 抖音站内内容基本不进 Bing 的索引；中文新梗在 Bing 上还常被拆成单字（"奶绿波"只剩"奶"）。
// 360 的网页结果能直接找到抖音视频和解释文章，作为中文/梗查询的补充源，Bing 仍保留。
// 只在疑似梗查询或极短的纯中文词上补一次，避免每次普通搜索都多打一个站。
const MEME_QUERY_RE = /梗|热梗|新梗|什么梗|什么意思|出处|抖音|快手|小红书/;

function isMemeQuery(query) {
  return MEME_QUERY_RE.test(String(query || ''));
}

const NON_MEME_SHORT_TERMS = new Set([
  '天气', '新闻', '时间', '日期', '价格', '股票', '汇率', '翻译', '作业', '论文', '代码', '报错',
  '电脑', '手机', '系统', '软件', '视频', '图片', '文件', '地址', '地图', '路线', '航班', '火车',
  '机票', '酒店', '餐厅', '电影', '游戏', '音乐', '小说', '你好', '在吗', '谢谢', '哈哈', '好的',
  '收到', '可以', '不行', '什么', '为什么', '怎么', '多少', '今天', '明天', '昨天', '周末',
  '上班', '下班', '吃饭', '睡觉'
]);

function isShortCjkTerm(query) {
  const text = String(query || '').trim();
  return /^[\u4e00-\u9fff]{2,6}$/.test(text) && !NON_MEME_SHORT_TERMS.has(text);
}

function mergeSearchResults(primary, extra, limit) {
  const seen = new Set();
  const results = [];
  // 梗查询把 360 放前面：Bing 的抖音首页/字面词会挤掉真正有用的视频和解释文章。
  for (const item of [...(extra?.results || []), ...(primary?.results || [])]) {
    const key = String(item?.url || '').replace(/[#?].*$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(item);
    if (results.length >= limit) break;
  }
  return results;
}

function rankMemeResults(results, core) {
  const c = String(core || '').toLowerCase();
  return results
    .map((item, index) => {
      const title = String(item?.title || '').toLowerCase();
      const snippet = String(item?.snippet || '').toLowerCase();
      const text = `${title} ${snippet}`;
      let host = '';
      try { host = new URL(String(item?.url || '')).hostname; } catch { /* 忽略坏链接 */ }
      let score = 0;
      if (c && title.includes(c)) score += 5;
      if (c && snippet.includes(c)) score += 3;
      if (/梗/.test(text)) score += 3;
      if (/(^|\.)douyin\.com$/i.test(host)) score += 2;
      return { item, index, score };
    })
    .filter((x) => x.item?.url)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}

function memeCore(query) {
  return String(query || '')
    .replace(/(什么意思|什么梗|热梗|新梗|出处|抖音|快手|小红书|梗)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 梗结果过滤：只留下“命中核心词/含梗解释”的条目，挡掉“奶”“喝”“city”这类字面字典结果。 */
function filterMemeResults(results, core) {
  const c = String(core || '').toLowerCase();
  const tokens = c.split(/\s+/).filter((t) => t.length >= 2);
  return (Array.isArray(results) ? results : []).filter((item) => {
    const text = `${item?.title || ''} ${item?.snippet || ''}`.toLowerCase();
    let score = 0;
    if (c && text.includes(c)) score += 5;
    if (/梗|什么梗|梗知识|梗百科|梗指南|梗科普|网络用语|流行语|意思/.test(text)) score += 4;
    for (const token of tokens) if (text.includes(token)) score += 2;
    // 多词核心（如“龙虾 OpenClaw”）允许 4 分：两个词都命中但标题没写“梗”也可能是解释文章。
    return score >= 5 || (tokens.length > 1 && score >= 4);
  });
}

async function bingTargetedMemeSearch(query) {
  // 搜狗/360 都会对机房 IP 做风控；被挡时用 Bing 的站内限定再试一次。
  // 先去掉“什么意思/梗/抖音”这类泛词，再用两种问法各查一次：
  //   · 短核心词对“奶绿波”这类新词更准；
  //   · 加“什么梗”对本身有常用义的词更准。
  // 结果按“含核心词 / 含梗 / 抖音域名”排序，避免通用词条压过梗解释。
  const core = memeCore(query);
  if (core.length < 2) throw new Error('没有可用的梗核心词');
  const queries = [
    `site:douyin.com ${core}`,
    `site:douyin.com ${core} 什么梗`,
    `site:douyin.com "${core}"`
  ];
  const settled = await Promise.allSettled(queries.map((q) => bingSearch(q)));
  const all = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value.results : []));
  const results = filterMemeResults(rankMemeResults(all, core), core)
    .filter((item, i, arr) => arr.findIndex((x) => x.url === item.url) === i);
  if (!results.length) throw new Error('Bing 站内限定没有返回梗相关结果');
  return { name: 'bing', result: { query, results } };
}

async function bilibiliMemeSearch(query) {
  const core = memeCore(query);
  if (core.length < 2) throw new Error('没有可用的梗核心词');
  const result = await bilibiliSearch(`${core} 梗`);
  const filtered = filterMemeResults(result.results, core);
  // 只有“奶绿波旗袍活动/喝大水新闻”这类相关视频、没有“梗/什么意思/梗知识”信号时，
  // 不让它抢先成功 —— 交给 Bing 站内限定去找百科/知乎/新闻的解释，避免模型只看到活动视频。
  const hasExplanation = filtered.some((item) => /梗|什么梗|梗知识|梗百科|梗指南|梗科普|网络用语|流行语|什么意思|意思/.test(`${item.title} ${item.snippet}`));
  if (!filtered.length || !hasExplanation) throw new Error('B 站没有返回梗解释类结果');
  return { name: 'bilibili', result: { ...result, results: filtered } };
}

async function supplementalSearch(query) {
  const core = memeCore(query);
  // 1) 搜狗如果返回的是带摘要的解释结果，单独用它就够了。
  try {
    const raw = await sogouSearch(query);
    const results = filterMemeResults(raw.results, core);
    if (results.length && results.some((item) => String(item.snippet || '').trim().length >= 12)) {
      return { names: ['sogou'], result: { ...raw, results } };
    }
  } catch { /* 搜狗风控，继续 */ }

  // 2) B 站标题负责“确认是哪个梗”，Bing 站内限定负责“给出意思/出处”。
  //    两边并发，谁成功用谁；都成功就合并排序 —— 只拿 B 站标题时模型会抱怨“没正文”。
  const settled = await Promise.allSettled([bilibiliMemeSearch(query), bingTargetedMemeSearch(query)]);
  const names = [];
  const all = [];
  for (const [index, out] of settled.entries()) {
    if (out.status !== 'fulfilled') continue;
    const result = out.value?.result || out.value;
    const results = filterMemeResults(result?.results, core);
    if (!results.length) continue;
    names.push(out.value?.name || ['bilibili', 'bing'][index]);
    all.push(...results);
  }
  if (all.length) {
    const merged = rankMemeResults(all, core).filter((item, i, arr) => arr.findIndex((x) => x.url === item.url) === i);
    return { names, result: { query, results: merged } };
  }

  // 3) 360 最后兜底。
  try {
    const raw = await so360Search(query);
    const results = filterMemeResults(raw.results, core);
    if (results.length) return { names: ['so360'], result: { ...raw, results } };
  } catch { /* 360 也会风控 */ }
  return null;
}

async function bingSearchWithSupplement(query, { forceSupplement = false } = {}) {
  let primary = null;
  let primaryError = null;
  try { primary = await bingSearch(query); } catch (error) { primaryError = error; }

  const memeQuery = isMemeQuery(query);
  const shortTerm = primary && isShortCjkTerm(query);
  const douyinOnly = primary && primary.results.every((r) => /^https?:\/\/(www\.)?douyin\.com\/(?:$|search|live)/i.test(String(r.url || '')));
  const needSupplement = forceSupplement || memeQuery || shortTerm || douyinOnly;
  if (!needSupplement) {
    if (primaryError) throw primaryError;
    return primary;
  }

  const extra = await supplementalSearch(query);
  if (!primary && !extra) throw primaryError;
  if (!primary) return { ...extra.result, fallbackFrom: 'bing', sources: extra.names?.length ? extra.names : ['bing'] };

  const core = memeCore(query);
  const primaryFiltered = core
    ? { ...primary, results: filterMemeResults(primary.results, core) }
    : primary;
  // 明确的梗查询/只剩抖音壳子：宁可不给结果，也别把“奶”“喝”“city”这类字面词塞给模型。
  // 只是“短中文词”触发的兜底（如“段头测试”）没有补充结果时，保留 Bing 原结果，避免误伤普通搜索。
  if (!extra) return (memeQuery || douyinOnly || forceSupplement) ? primaryFiltered : primary;

  const maxResults = Math.max(6, Math.min(10, Number(getConfig().webSearch?.maxResults) || 6));
  const sources = [...(extra.names || [])];
  if (primaryFiltered.results.length) sources.push('bing');
  return {
    query,
    results: mergeSearchResults(primaryFiltered, extra.result, maxResults),
    sources: [...new Set(sources)]
  };
}

/** 搜狗网页解析：无 Key，中文/抖音梗命中率比 Bing 好；优先取结果块里的 data-url 真实外链。 */
export async function sogouSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const url = new URL(String(cfg.sogou?.searchUrl || 'https://www.sogou.com/web'));
  url.searchParams.set('query', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`搜狗搜索 HTTP ${res.status}`);
  const html = await readTextBounded(res, BING_HTML_MAX_BYTES);
  const results = [];
  for (const block of html.split(/<div class="vrwrap/).slice(1)) {
    const anchor = block.match(/<h3 class="vr-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const title = decodeHtml(anchor[2]);
    const direct = block.match(/data-url="(https?:\/\/[^"]+)"/i);
    // 只有 /link?url=… 的跳转、没有 data-url 的结果直接跳过：web_fetch 跟不到真实页面，
    // 模型只能看到一个搜狗跳转地址，不如不要。
    const urlStr = direct ? decodeHtml(direct[1]) : '';
    if (!urlStr || !title) continue;
    let host = '';
    try { host = new URL(urlStr).hostname; } catch { continue; }
    if (/(^|\.)(sogou\.com|so\.com|360\.com|360kan\.com|bing\.com)$/i.test(host)) continue;
    if (results.some((r) => r.url === urlStr)) continue;
    const sn = block.match(/id="cacheresult_summary_\d+"[^>]*>([\s\S]*?)<\/div>/i)
      || block.match(/<div class="fz-mid[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({ title, url: urlStr, snippet: sn ? decodeHtml(sn[1]) : '' });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error('搜狗搜索没有返回可解析的结果（可能命中验证页或页面结构变化）');
  return { query, results };
}

/** B 站视频搜索（无 Key）：梗知识和梗百科类视频的标题/简介通常比网页搜索更直接。 */
export async function bilibiliSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const endpoint = new URL(String(cfg.bilibili?.searchUrl || 'https://api.bilibili.com/x/web-interface/wbi/search/type'));
  endpoint.search = '';
  // nav 取不到签名 key 时不阻塞：退回无签名请求，拿不到 result 会按空结果报错并走下一源。
  const mix = await biliMixinKey().catch(() => '');
  const params = { search_type: 'video', keyword: query, wts: Math.floor(Date.now() / 1000) };
  const url = `${endpoint.toString()}?${biliSignedQuery(params, mix)}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://www.bilibili.com/'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`B 站搜索 HTTP ${res.status}`);
  const data = await readSearchJson(res, 'B 站搜索返回了无法解析的 JSON');
  if (Number(data?.code) !== 0) {
    throw new Error(`B 站搜索错误（code ${data?.code ?? '未知'}）：${String(data?.message || '未知').slice(0, 120)}`);
  }
  const arr = Array.isArray(data?.data?.result) ? data.data.result : [];
  const results = [];
  for (const item of arr) {
    const title = decodeHtml(item?.title);
    let urlStr = String(item?.arcurl || '').trim();
    if (urlStr.startsWith('//')) urlStr = `https:${urlStr}`;
    if (!/^https?:\/\//i.test(urlStr) && item?.bvid) urlStr = `https://www.bilibili.com/video/${item.bvid}`;
    if (!title || !urlStr) continue;
    results.push({ title, url: urlStr, snippet: decodeHtml(item?.description || '') });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error('B 站搜索没有返回可解析的结果');
  return { query, results };
}

/** 360 网页解析：无 Key，中文/抖音梗命中率比 Bing 好。只取 data-mdurl 给出的真实外链。 */
export async function so360Search(query) {
  const cfg = getConfig().webSearch ?? {};
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const url = new URL(String(cfg.so360?.searchUrl || 'https://www.so.com/s'));
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`360 搜索 HTTP ${res.status}`);
  const html = await readTextBounded(res, BING_HTML_MAX_BYTES);
  const results = [];
  for (const block of html.split(/<li class="res-list"/).slice(1)) {
    const anchor = block.match(/<a[^>]*data-mdurl="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const urlStr = decodeHtml(anchor[1]);
    const title = decodeHtml(anchor[2]);
    if (!urlStr || !title) continue;
    let host = '';
    try { host = new URL(urlStr).hostname; } catch { continue; }
    // 站内导航/聚合页不是结果；抖音、知乎、百科、公众号等外链保留。
    if (/(^|\.)(so\.com|360\.com|360kan\.com|bing\.com|hao\.360\.com)$/i.test(host)) continue;
    if (results.some((r) => r.url === urlStr)) continue;
    const sn = block.match(/<span[^>]*class="[^"]*res-list-summary[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      || block.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title, url: urlStr, snippet: sn ? decodeHtml(sn[1]) : '' });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error('360 搜索没有返回可解析的结果（可能命中验证页或页面结构变化）');
  return { query, results };
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */
export async function webSearch(query, { meme = false } = {}) {
  assertTimeAllowed();
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'bing').toLowerCase();
  if (provider === 'aggregate') return aggregateSearch(clean);
  if (provider === 'deepseek') return deepSeekSearch(clean);
  if (provider === 'zhipu') return zhipuSearch(clean);
  if (provider === 'bocha') return bochaSearch(clean);
  if (provider === 'baidu') return baiduSearch(clean);
  if (provider === 'metaso') return metasoSearch(clean);
  if (provider === 'doubao') return doubaoSearch(clean);
  // Tavily 在设置页是可选项、Key 也有独立入口；漏掉这条分发会让它静默退回 Bing，
  // 用户以为在用自己的 Key，实际没有（2026-10-17 审查 P2）
  if (provider === 'tavily') return tavilySearch(clean);
  if (provider === 'so360') return so360Search(clean);
  if (provider === 'sogou') return sogouSearch(clean);
  if (provider === 'bilibili') return bilibiliSearch(clean);
  // 自定义：'custom'（旧单槽位）或 'custom:<id>'（设置页添加的多个之一）
  if (provider === 'custom' || provider.startsWith('custom:')) {
    return customSearch(clean, provider);
  }
  return bingSearchWithSupplement(clean, { forceSupplement: meme === true });
}

/**
 * DeepSeek 官方 Search API（2026-10-17 开放）优先，返回结构化 {title,url,summary}。
 * 文档：https://api-docs.deepseek.com/guides/search
 *
 * 老配置里的 baseUrl 还是 `/responses`：这里会剥掉 `/responses` 再拼 `/v1/tools/search`，
 * 不需要用户手改。只有新接口 404/405 或没有结果时，才回退到旧 Responses `web_search`
 * （旧接口拿不到 URL，仅作兼容兜底）。
 */
export function deepSeekSearch(query) {
  return withTimeWindow((signal) => deepSeekSearchRequest(query, signal));
}

async function deepSeekSearchRequest(query, signal) {
  const cfg = getConfig().webSearch?.deepseek ?? {};
  const apiKey = String(cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DeepSeek 搜索需要 API Key（设置里填，或环境变量 DEEPSEEK_API_KEY）');
  try {
    return await deepSeekToolsSearch({ query, cfg, apiKey, signal });
  } catch (error) {
    // 老账号/老地址可能还没开放 /v1/tools/*：只在这两种"接口不存在"的情况下退回旧接口。
    // 401/429/网络错误原样抛出，不能把 Key 或额度问题伪装成"搜索没结果"。
    if (!/HTTP (404|405)|没有返回结果/.test(String(error?.message || ''))) throw error;
    return deepSeekResponsesSearch({ query, cfg, apiKey, signal });
  }
}

async function deepSeekToolsSearch({ query, cfg, apiKey, signal }) {
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '').replace(/\/responses$/i, '');
  const endpoint = /\/v1$/i.test(base) ? `${base}/tools/search` : `${base}/v1/tools/search`;
  const maxResults = Math.min(10, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  const count = Math.min(50, Math.max(1, Number(cfg.count) || maxResults));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      count,
      ori_question: query,
      need_content: cfg.needContent === true
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 60000))])
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`DeepSeek 搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, 'DeepSeek 搜索返回了无法解析的 JSON');
  const results = (Array.isArray(data?.results) ? data.results : [])
    .map((item) => ({
      title: String(item?.title || item?.url || '搜索结果').trim(),
      url: String(item?.url || '').trim(),
      snippet: String(item?.summary || item?.snippet || item?.content || '').replace(/\s+/g, ' ').trim().slice(0, 500)
    }))
    .filter((item) => item.url)
    .slice(0, maxResults);
  if (!results.length) throw new Error('DeepSeek Search 没有返回结果');
  return { query, results };
}

/** 旧 Responses API 兜底：只返回一段总结，没有 URL（保留给未开放新接口的账号）。 */
async function deepSeekResponsesSearch({ query, cfg, apiKey, signal }) {
  const raw = String(cfg.baseUrl || 'https://api.deepseek.com/responses').trim().replace(/\/+$/, '');
  const baseUrl = /\/responses$/i.test(raw) ? raw : `${raw}/responses`;
  const model = String(cfg.model || 'deepseek-v4-flash');
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: `请联网搜索并回答（用中文，简洁、只给结论和关键信息）：${query}`,
      tools: [{ type: 'web_search' }],
      stream: false
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 60000))])
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`DeepSeek 搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, 'DeepSeek 搜索返回了无法解析的 JSON');
  const outputText = String(data?.output_text ?? '').trim();
  if (!outputText) {
    // 兼容不同字段位置
    const alt = data?.output?.find?.((item) => item?.type === 'message' && item?.content?.length)
      ?.content?.map((c) => c?.text ?? '').join('') ?? '';
    if (!alt) throw new Error('DeepSeek 搜索没有返回文本（可能是模型不支持 web_search 工具）');
    return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: alt }] };
  }
  return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: outputText }] };
}

/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。 */
export async function webFetch(url, { signal, maxBytes, headers } = {}) {
  // safeFetch 的 `timeout` 只是空闲超时；慢速响应（每隔十几秒吐一个字节）能把请求吊很久。
  // 这里再叠一个整次抓取的总截止时间，并保留调用方（本轮运行）的中止信号。
  const total = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, total]) : total;
  return safeFetch(url, { signal: combined, maxBytes, headers });
}

/** 智谱 Web Search API（结构化结果：标题/链接/摘要/网站名/日期）。 */
export async function zhipuSearch(query) {
  const cfg = getConfig().webSearch?.zhipu ?? {};
  const apiKey = String(cfg.apiKey || process.env.ZHIPU_API_KEY || '').trim();
  if (!apiKey) throw new Error('智谱搜索需要 API Key（设置里填，或环境变量 ZHIPU_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/web_search').replace(/\/+$/, '');
  const engine = String(cfg.engine || 'search_std');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ search_engine: engine, search_query: query, count }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`智谱搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '智谱搜索返回了无法解析的 JSON');
  const arr = Array.isArray(data?.search_result) ? data.search_result : [];
  const results = arr
    .filter((r) => r?.link || r?.url)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.link ?? r.url ?? ''),
      snippet: String(r.content ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('智谱搜索没有返回有效结果（检查 API Key 或搜索引擎编码）');
  return { query, results };
}

/** 博查 Web Search API（国内中文优化，网页结果在 data.webPages.value）。 */
export async function bochaSearch(query) {
  const cfg = getConfig().webSearch?.bocha ?? {};
  const apiKey = String(cfg.apiKey || process.env.BOCHA_API_KEY || '').trim();
  if (!apiKey) throw new Error('博查搜索需要 API Key（设置里填，或环境变量 BOCHA_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://api.bochaai.com/v1/web-search').replace(/\/+$/, '');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query, count, freshness: 'noLimit', summary: false }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`博查搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '博查搜索返回了无法解析的 JSON');
  if (data?.code && Number(data.code) !== 200) {
    throw new Error(`博查搜索 API 错误（code ${data.code}）：${data.message || data.msg || '未知'}`);
  }
  const arr = Array.isArray(data?.data?.webPages?.value) ? data.data.webPages.value : [];
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.name ?? r.title ?? '').trim() || '（无标题）',
      url: String(r.url ?? ''),
      snippet: String(r.snippet ?? r.summary ?? r.content ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('博查搜索没有返回网页结果');
  return { query, results };
}

/** 百度千帆 AI Search（web_search，返回 references）。 */
export async function baiduSearch(query) {
  const cfg = getConfig().webSearch?.baidu ?? {};
  const apiKey = String(cfg.apiKey || process.env.BAIDU_SEARCH_API_KEY || '').trim();
  if (!apiKey) throw new Error('百度搜索需要 API Key（设置里填，或环境变量 BAIDU_SEARCH_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://qianfan.baidubce.com/v2/ai_search/web_search').replace(/\/+$/, '');
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: query }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: topK }]
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`百度搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '百度搜索返回了无法解析的 JSON');
  // 千帆的错误字段有两种写法（`error_code` 与 `code`）—— 只认前一种时会把它当成功、
  // 最后报成"没有有效结果"，把真实原因盖掉（与秘塔那类 200+错误体同型）
  if (data?.error_code && Number(data.error_code) !== 0) {
    throw new Error(`百度搜索 API 错误（code ${data.error_code}）：${data.error_msg || data.message || '未知'}`);
  }
  if (data?.code && Number(data.code) !== 200 && Number(data.code) !== 0) {
    throw new Error(`百度搜索 API 错误（code ${data.code}）：${data.message || '未知'}`);
  }
  const arr = Array.isArray(data?.references) ? data.references : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('百度搜索没有返回有效结果');
  return { query, results };
}

/**
 * 秘塔 AI 搜索（metaso.cn，每天 100 次免费）。
 *
 * 官方接口是 `POST /api/v1/search`（issue #38 报的就是这个）：原来的实现三处都不对 ——
 * 地址写成 `/api/open/v1/search`（404）、请求体用 `{ query, top_k }`（官方是 `q` + `scope` + `size`）、
 * 响应读 `results|data|sources`（官方是 `webpages[]`）。三处任一错都拿不到结果，所以它其实从未成功过。
 * 契约（2026-10-17 对照官方 playground 与两个公开实现核对）：
 *   请求 { q, scope: 'webpage', size, includeSummary, includeRawContent, conciseSnippet }
 *   响应 { webpages: [{ title, link|url, snippet|summary }] }；出错时 HTTP 仍是 200，body 里是 { errCode, errMsg }。
 */
export async function metasoSearch(query) {
  const cfg = getConfig().webSearch?.metaso ?? {};
  const apiKey = String(cfg.apiKey || process.env.METASO_API_KEY || '').trim();
  const endpoint = String(cfg.baseUrl || 'https://metaso.cn/api/v1/search').replace(/\/+$/, '');
  // size 是**数字**，官方上限 50（写字符串会被拒）
  const size = Math.min(50, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      q: query,
      scope: 'webpage',
      size,
      includeSummary: false,
      includeRawContent: false,
      conciseSnippet: false
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`秘塔搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '秘塔搜索返回了无法解析的 JSON');
  // 官方出错时 HTTP 也是 200：body 里带 errCode/errMsg（例如密钥无效是 2005），不认它就会
  // 被当成"没有返回有效结果"，把真正的原因（Key 错了 / 额度用完）盖掉
  const errCode = Number(data?.errCode);
  if (Number.isFinite(errCode) && errCode !== 0 && errCode !== 200) {
    throw new Error(`秘塔搜索返回错误（${errCode}）：${String(data?.errMsg || data?.message || '未说明原因').slice(0, 200)}`);
  }
  const arr = Array.isArray(data?.webpages) ? data.webpages
    : Array.isArray(data?.documents) ? data.documents
    : Array.isArray(data?.results) ? data.results
    : [];
  const results = arr
    .filter((r) => r?.link || r?.url)
    .map((r) => ({
      title: String(r.title ?? '').trim() || '（无标题）',
      url: String(r.link ?? r.url ?? ''),
      snippet: String(r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('秘塔搜索没有返回有效结果（可能已用完免费额度，或 Key 没有搜索权限）');
  return { query, results };
}

/**
 * 豆包搜索（火山引擎 Agent Plan 订阅自带的联网搜索服务，2026-06 起替代原联网
 * 搜索 Beta；每月免费额度，无需单独付费 API Key）。Key 可直接复用 Agent Plan 的，
 * 也可用环境变量 DOUBAO_SEARCH_API_KEY。
 * 接口特点：请求体字段 PascalCase（Query / SearchType / Count / NeedContent），
 * 响应解析 Result.WebResults[]（Title / Url / Summary）。
 */
export async function doubaoSearch(query) {
  const cfg = getConfig().webSearch?.doubao ?? {};
  const apiKey = String(cfg.apiKey || process.env.DOUBAO_SEARCH_API_KEY || '').trim();
  if (!apiKey) throw new Error('豆包搜索未配置 API Key（火山 Agent Plan 搜索服务 Key，或环境变量 DOUBAO_SEARCH_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://open.feedcoopapi.com/search_api/web_search').replace(/\/+$/, '');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      Query: query,
      SearchType: 'web',
      Count: Math.min(10, Math.max(1, Number(cfg.count) || 6)),
      NeedContent: true
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`豆包搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '豆包搜索返回了无法解析的 JSON');
  // 火山这套接口失败时也返回 HTTP 200，错误信息在 ResponseMetadata.Error 里、
  // Result 为 null（Issue #8）：invalid_api_key / 10403 服务未开通 / 10406 10412
  // 额度用尽 / 700429 QPS 超限——处置方式完全不同，必须把真实错误抛出来。
  const apiError = data?.ResponseMetadata?.Error;
  if (apiError) {
    const code = String(apiError.Code ?? apiError.CodeN ?? '未知错误码');
    const message = String(apiError.Message ?? '').trim() || '无错误信息';
    throw new Error(`豆包搜索失败（${code}）：${message}`);
  }
  const arr = Array.isArray(data?.Result?.WebResults) ? data.Result.WebResults : [];
  const results = arr
    .filter((r) => r?.Url || r?.url)
    .map((r) => ({
      title: String(r.Title ?? r.title ?? '').trim() || '（无标题）',
      url: String(r.Url ?? r.url ?? ''),
      snippet: String(r.Summary ?? r.summary ?? r.Content ?? r.content ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('豆包搜索没有返回有效结果（可能搜索额度已用完或 Key 无搜索权限）');
  return { query, results };
}

/**
 * 解析自定义搜索配置。
 * providerId 形如 'custom:abc123' 时从 webSearch.providers 数组里取对应项；
 * 否则退回旧的单槽位 webSearch.custom（兼容早期配置）。
 */
function resolveCustomConfig(providerId = null) {
  const ws = getConfig().webSearch ?? {};
  if (providerId && String(providerId).startsWith('custom:')) {
    const id = String(providerId).slice('custom:'.length);
    const found = (Array.isArray(ws.providers) ? ws.providers : []).find((p) => String(p?.id) === id);
    if (found) return found;
    // 列表里找不到 → 回退单槽位，避免配置丢失后完全搜不了
  }
  return ws.custom ?? {};
}

/**
 * 用户自定义的搜索服务（provider = 'custom' 或 'custom:<id>'）。
 *
 * 两种类型：
 *   - 'openai'：POST 一个 JSON 搜索接口。为兼容各家实现，会尝试多种常见请求体字段
 *     （query / q / messages）与响应结构（results / data / sources / references / webPages）。
 *     适合 SearXNG、Tavily、自建聚合搜索等。
 *   - 'bing'：GET 一个搜索页并用 b_algo 块解析（兼容 Bing 结果格式的引擎，如部分 SearXNG 实例）。
 */
export function customSearch(query, providerId = null) {
  return withTimeWindow((signal) => customSearchRequest(query, providerId, signal));
}

async function customSearchRequest(query, providerId, signal) {
  const cfg = resolveCustomConfig(providerId);
  const type = String(cfg.type || 'openai').toLowerCase();

  if (type === 'bing') {
    return bingSearchWithUrl(query, String(cfg.baseUrl || ''));
  }

  const endpoint = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('自定义搜索未配置接口地址（设置 → 模型 API → 搜索提供方 → 自定义）');
  const apiKey = String(cfg.apiKey || '').trim();
  const model = String(cfg.model || '').trim();
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  // 兼容多种请求体：优先 query / q，带 model 时额外附上 messages（Responses API 风格）
  const body = { query, q: query, top_k: topK, count: topK };
  if (model) {
    body.model = model;
    body.messages = [{ role: 'user', content: query }];
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))])
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`自定义搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '自定义搜索返回了无法解析的 JSON');

  // 兜住各家字段名
  const arr = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.sources) ? data.sources
    : Array.isArray(data?.references) ? data.references
    : Array.isArray(data?.webPages?.value) ? data.webPages.value
    : Array.isArray(data) ? data
    : [];

  const results = arr
    .filter((r) => r && (r.url || r.link))
    .map((r) => ({
      title: String(r.title ?? r.name ?? r.headline ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? r.body ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) {
    throw new Error('自定义搜索没有返回可识别的结果（请检查接口返回是否包含 results/data/sources 等数组，或改用 bing 类型抓页面）');
  }
  return { query, results };
}

/** 用指定 URL 跑一次 Bing 结果的 HTML 解析（供自定义 bing 类型复用）。 */
async function bingSearchWithUrl(query, searchUrl) {
  const cfg = getConfig().webSearch ?? {};
  const url = String(searchUrl || cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const target = new URL(url);
  target.searchParams.set('q', query);
  const res = await fetch(target, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`自定义搜索（bing 类型）HTTP ${res.status}`);
  const html = await readTextBounded(res, BING_HTML_MAX_BYTES);
  const results = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error('自定义搜索（bing 类型）没有解析到结果，请确认该引擎返回 b_algo 结构');
  return { query, results };
}

/**
 * Tavily 搜索（tavily.com，专为 LLM 设计的搜索 API，免费档 1000 次/月）。
 * POST https://api.tavily.com/search { api_key, query, max_results } 或 Bearer 头。
 * 响应 results[]: { title, url, content, score }。
 */
export async function tavilySearch(query) {
  const cfg = getConfig().webSearch?.tavily ?? {};
  const apiKey = String(cfg.apiKey || process.env.TAVILY_API_KEY || '').trim();
  if (!apiKey) throw new Error('Tavily 未配置 API Key（config.webSearch.tavily.apiKey 或环境变量 TAVILY_API_KEY）');
  const res = await fetch(String(cfg.baseUrl || 'https://api.tavily.com/search'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      max_results: Math.min(10, Math.max(1, Number(cfg.count) || 5)),
      search_depth: String(cfg.searchDepth || 'basic')
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, 'Tavily 返回了无法解析的 JSON');
  const arr = Array.isArray(data?.results) ? data.results : [];
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.title ?? '').trim() || '（无标题）',
      url: String(r.url),
      snippet: String(r.content ?? '').trim()
    }));
  if (!results.length) throw new Error('Tavily 没有返回有效结果');
  return { query, results };
}
