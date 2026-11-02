// B 站公开接口：热门 + 按兴趣搜索。只读、无登录、无 Cookie。
// 失败只降级为空列表，让生活层"今天没见闻"而不是把聊天链路带崩。
import { safeFetch } from '../llm/safe-fetch.js';

const POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type';
const HEADERS = {
  Referer: 'https://www.bilibili.com/',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
};

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const parts = String(value || '').split(':').map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = String(value || '').replace(/,/g, '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*(万|亿)?/.exec(text);
  if (!match) return 0;
  const scale = match[2] === '亿' ? 100000000 : (match[2] === '万' ? 10000 : 1);
  return Math.max(0, Math.round(Number(match[1]) * scale));
}

function normalizeVideo(raw, source) {
  const id = String(raw?.bvid || '').trim();
  if (!id) return null;
  const tags = [
    raw?.tname,
    ...(String(raw?.tag || '').split(','))
  ].map((tag) => stripTags(tag)).filter(Boolean);
  const pic = String(raw?.pic || raw?.cover || raw?.pic_url || '').trim();
  return {
    source: 'bilibili',
    via: source,
    id,
    title: stripTags(raw?.title),
    desc: stripTags(raw?.desc || raw?.description || ''),
    up: stripTags(raw?.owner?.name || raw?.author || ''),
    upMid: String(raw?.owner?.mid || raw?.mid || ''),
    duration: parseDuration(raw?.duration),
    play: parseCount(raw?.stat?.view ?? raw?.play ?? 0),
    pubdate: Number(raw?.pubdate ?? 0) || 0,
    tags: [...new Set(tags)].slice(0, 6),
    cover: pic.startsWith('//') ? `https:${pic}` : pic.replace(/^http:\/\//i, 'https://'),
    url: `https://www.bilibili.com/video/${id}`
  };
}

async function readJson(fetchImpl, url, maxBytes) {
  const response = await fetchImpl(url, { maxBytes, headers: HEADERS });
  if (response?.statusCode !== 200) throw new Error(`B 站返回 HTTP ${response?.statusCode || '?'}`);
  const data = JSON.parse(response.body || '{}');
  if (data?.code !== 0) throw new Error(`B 站返回 code=${data?.code}`);
  return data;
}

export async function fetchBilibiliPopular({ limit = 30, fetchImpl = safeFetch } = {}) {
  const pageSize = Math.min(50, Math.max(1, Number(limit) || 30));
  const data = await readJson(fetchImpl, `${POPULAR_URL}?ps=${pageSize}&pn=1`, 256 * 1024);
  return (data?.data?.list || []).map((item) => normalizeVideo(item, 'popular')).filter(Boolean);
}

export async function fetchBilibiliSearch(term, { limit = 10, fetchImpl = safeFetch } = {}) {
  const keyword = String(term || '').trim();
  if (!keyword) return [];
  const pageSize = Math.min(30, Math.max(1, Number(limit) || 10));
  const url = `${SEARCH_URL}?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1&page_size=${pageSize}`;
  const data = await readJson(fetchImpl, url, 256 * 1024);
  const payload = data?.data?.result ?? data?.result ?? [];
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
  return list.map((item) => normalizeVideo(item, `search:${keyword}`)).filter(Boolean);
}

/** 分数只用于排序：兴趣命中 > 播放量 > 新鲜度，超长视频扣分。 */
export function scoreCandidate(item, profile = {}) {
  const haystack = `${item?.title || ''} ${item?.desc || ''} ${(item?.tags || []).join(' ')} ${item?.up || ''}`.toLowerCase();
  let match = 0;
  for (const entry of profile?.terms || []) {
    const term = String(entry?.term || '').toLowerCase();
    if (!term) continue;
    if (haystack.includes(term)) match += Number(entry.weight) || 1;
  }
  const play = Math.log10(Math.max(1, Number(item?.play) || 0)) * 4;
  const ageDays = Math.max(0, (Date.now() / 1000 - (Number(item?.pubdate) || Date.now() / 1000)) / 86400);
  const freshness = Math.max(0, 20 - ageDays * 2);
  const duration = Number(item?.duration) || 0;
  const durationPenalty = duration > 1800 ? -10 : (duration > 0 && duration < 60 ? -5 : 0);
  return Math.round(match * 6 + play + freshness + durationPenalty);
}

/**
 * 觅食：热门打底 + 用画像里权重最高的几个词各搜一次。
 * 单个来源失败不影响其他来源；总结果按 id 去重。
 */
export async function forageBilibili({
  profile = {},
  limit = 30,
  minDurationSec = 60,
  maxDurationSec = 3600,
  excludeKeywords = [],
  fetchImpl = safeFetch,
  log = () => {}
} = {}) {
  const logger = typeof log === 'function' ? log : () => {};
  // 搜索词只用人设 topics / 显式关键词；没有就只拉热门。
  // 群聊高频词继续参与打分，但**绝不**直接拿去搜 B 站：terms 里可能混有私聊来源的词，
  // 外发到第三方搜索接口属于隐私泄漏（2026-11-02 全项目审查 P1）。
  const sourceTerms = Array.isArray(profile?.searchTerms)
    ? profile.searchTerms.map((term) => ({ term }))
    : [];
  const queries = sourceTerms
    .slice(0, 3)
    .map((entry) => String(entry?.term || '').trim())
    .filter(Boolean);
  const tasks = [fetchBilibiliPopular({ limit, fetchImpl })];
  for (const query of queries) tasks.push(fetchBilibiliSearch(query, { limit: 10, fetchImpl }));

  const settled = await Promise.allSettled(tasks);
  const items = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') items.push(...result.value);
    else logger(`[life-feed] 一个来源失败：${result.reason?.message || result.reason}`);
  }

  const excluded = excludeKeywords.map((word) => String(word || '').trim().toLowerCase()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.duration && item.duration < minDurationSec) continue;
    if (item.duration && item.duration > maxDurationSec) continue;
    const haystack = `${item.title} ${item.desc} ${(item.tags || []).join(' ')}`.toLowerCase();
    if (excluded.some((word) => haystack.includes(word))) continue;
    out.push(item);
  }
  return out;
}
