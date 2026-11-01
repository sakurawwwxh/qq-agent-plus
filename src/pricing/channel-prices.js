// 每渠道一份价目表：用户给某个渠道配一个 URL，我们拉它的价目，
// 拉到的价只在该渠道的调用上生效（用户手填的渠道价仍然优先）。
//
// 与 src/pricing/price-feed.js 的分工：
//   price-feed     一张全局表，按模型 id 覆盖内置表（项目/社区共享的公共参考价）
//   channel-prices 按渠道分表（用户自己那家渠道的实付价目）
// 存储：data/channel-prices.json —— 拉取结果与状态落盘，重启先用缓存；
// 配置：api.channelPriceFeeds = [{ vendor, url }]（用户意图留在 config 里）。
//
// 约束沿用 price-feed：全异步、错误都吞进状态、任何函数都不把异常抛给调用方。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from '../core/config.js';
import { setChannelPrices } from './model-prices.js';
import { normalizePriceFeed } from './price-feed.js';
import { probeChannelPrices } from './price-probe.js';
import { readJsonBounded } from '../core/http-body.js';
import { fetchJsonSafe } from './safe-fetch-json.js';

const FILE = path.join(DATA_DIR, 'channel-prices.json');
const CACHE_VERSION = 1;
const FETCH_TIMEOUT_MS = 15000;
const STALE_MS = 24 * 3600 * 1000;   // 启动时超过 24h 的缓存顺手刷新一次
const AUTO_PROBE_TTL_MS = 24 * 3600 * 1000;   // 同一个渠道 24h 内只自动探一次

/** { [vendor]: { url, ok, error, fetchedAt, count, dropped, prices } } */
let feeds = {};
/** { [vendor]: 上次自动探测时间 } —— 探测失败也要记，避免每次重启都去敲站点 */
let autoProbeAt = {};

function writeFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, feeds, autoProbeAt, removedAt }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch { /* 写不进去不影响查价（内存里已经有表） */ }
}

/**
 * 已经注入查价层的渠道（键集合）。
 * 用来在配置里删掉某个渠道时把注入**撤销**：只按 feeds 重新注入是不够的，
 * 删掉的那家会一直留在查价层里按老价算钱，直到重启。
 */
let injected = new Set();

/**
 * 被明确撤销、且当前配置里也没有的渠道。
 * 在飞的刷新（单次 fetch 最长 15s，探测更久）回来时按它丢弃结果 ——
 * 否则"删掉渠道"这个动作会被一个刚好晚到的响应复活：价目表重新注入查价层、
 * 还写回 data/channel-prices.json，直到下次保存配置或重启才干净。
 */
let revoked = new Set();

/**
 * 用户明确删掉过的渠道（落盘保留）。控制台删除只改内存里的 revoked 与配置，
 * 但"自动探测"是按"配置里没有它 + 24h 没探过"来决定的 —— 少了这块墓碑，
 * 重启进程满 24 小时后会把它重新探回来、静默撤销这次删除（2026-09-22 审查发现）。
 * 用户重新添加该渠道时清掉墓碑。
 */
let removedAt = {};

/** 注入/撤销一个渠道（同时维护 injected）。 */
function injectOne(vendor, prices) {
  const v = String(vendor || '').trim();
  if (!v) return;
  setChannelPrices(v, prices);
  const table = prices && typeof prices === 'object' && Object.keys(prices).length ? prices : null;
  if (table) injected.add(v);
  else injected.delete(v);
}

/** 把内存里的表注入查价层，并撤销已经不在表里的渠道。 */
function injectAll() {
  const keep = new Set(Object.keys(feeds));
  for (const vendor of injected) {
    if (!keep.has(vendor)) injectOne(vendor, null);
  }
  for (const [vendor, feed] of Object.entries(feeds)) {
    injectOne(vendor, feed?.prices || null);
  }
}

/** 启动时调用：先吃磁盘缓存（同步注入），再按需后台刷新。 */
export function initChannelPrices(feedsConfig = []) {
  // 1) 读缓存（配置里已经删掉的渠道不再注入，已经注入过的还要撤销 —— 见 injectAll）
  const wanted = new Set((Array.isArray(feedsConfig) ? feedsConfig : [])
    .map((f) => String(f?.vendor || '').trim())
    .filter(Boolean));
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const cached = data?.version === CACHE_VERSION && data.feeds && typeof data.feeds === 'object' ? data.feeds : {};
    autoProbeAt = (data?.autoProbeAt && typeof data.autoProbeAt === 'object') ? data.autoProbeAt : {};
    removedAt = (data?.removedAt && typeof data.removedAt === 'object') ? data.removedAt : {};
    feeds = {};
    for (const [vendor, feed] of Object.entries(cached)) {
      if (!wanted.has(vendor)) continue;
      feeds[vendor] = feed;
    }
  } catch {
    // 读不到缓存（首次启动 / 文件坏了）：保留内存里已有的表 —— "失败不清表"，
    // 但同样按配置过滤，删掉的渠道不能因为缓存读不出来就继续生效。
    for (const vendor of Object.keys(feeds)) {
      if (!wanted.has(vendor)) delete feeds[vendor];
    }
  }
  injectAll();

  // 配置里重新出现的渠道要解禁（删掉再加回来的情况）：撤销标记与墓碑都清掉
  for (const vendor of wanted) {
    revoked.delete(vendor);
    if (removedAt[vendor]) delete removedAt[vendor];
  }

  // 2) 缓存缺失或过旧的，后台拉一次（不阻塞启动，失败只记状态）
  for (const item of (Array.isArray(feedsConfig) ? feedsConfig : [])) {
    const vendor = String(item?.vendor || '').trim();
    const url = String(item?.url || '').trim();
    if (!vendor || !url) continue;
    const feed = feeds[vendor];
    const fresh = feed?.ok === true && Number(feed.fetchedAt || 0) > 0
      && Date.now() - Number(feed.fetchedAt) < STALE_MS;
    if (fresh && feed.url === url) continue;
    applyFeed(vendor, url);   // 立即重新拉（异步）
  }
}

/** 配置里现在有没有这个渠道。 */
function isConfiguredVendor(vendor) {
  return (getConfig().api?.channelPriceFeeds || [])
    .some((f) => String(f?.vendor || '').trim() === vendor);
}

/**
 * 结果还要不要：单次 fetch 最长 15 秒（探测更久），这期间用户完全可能把渠道删掉，
 * 一个刚好晚到的响应不能把删掉的表复活（2026-09-21 审查发现）。
 *   - 被明确撤销过（控制台删除）→ 丢弃；
 *   - 开始时在配置里、现在不在了（手工改 config 删掉）→ 丢弃；
 *   - 其余的照旧收下：首次登记（控制台"添加并拉取"是先写配置再拉，但模块本身
 *     也允许直接拉一个还没登记过的渠道）不该被误伤。
 */
function shouldKeepVendor(vendor, wasConfigured) {
  if (revoked.has(vendor)) return false;
  if (wasConfigured && !isConfiguredVendor(vendor)) return false;
  return true;
}

/** 拉一个渠道的价目并落盘/注入（内部吞异常）。 */
export async function refreshChannelFeed(vendor, url, options = {}) {
  const v = String(vendor || '').trim();
  const target = String(url || '').trim();
  if (!v || !target) return channelPriceStatus();
  // 被撤销、**且配置里也没有**的渠道：不拉、不注入、不落盘（见 revoked 的注释）。
  // ⚠️ 必须带上"配置里也没有"这个条件：控制台「添加并拉取」只写配置、不会再走
  //    initChannelPrices（那里才解禁），所以同进程内把删掉的渠道加回来时，
  //    光看 revoked 会把这次拉取永久挡掉（审查发现）。
  const configured = isConfiguredVendor(v);
  if (revoked.has(v) && !configured) return channelPriceStatus();
  if (configured) {
    revoked.delete(v);                 // 配置里又有它了 → 解禁
    if (removedAt[v]) delete removedAt[v];
  }
  const wasConfigured = configured;
  // 生产路径走 safe-fetch（SSRF 防线）；fetchImpl 只给测试注入本地假实现。
  const fetchImpl = options.fetchImpl || null;
  const timeoutMs = Number(options.timeoutMs) || FETCH_TIMEOUT_MS;
  const allowPrivate = options.allowPrivate
    ?? getConfig().security?.allowPrivatePriceHosts === true;
  let loaded = null;   // { prices, url, dropped }
  let error = '';

  // ① 先按"价目 JSON"直接拉：用户自己配的地址通常是这种（in/out 价目或倍率表）。
  try {
    let payload;
    if (!fetchImpl) {
      payload = await fetchJsonSafe(target, { timeoutMs, allowPrivate });
    } else {
      const res = await fetchImpl(target, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 有界读（2MB）：价目文件不该无上限；超限与非法 JSON 分开报，别把"太大"说成"不合法"（2026-10-09 审查）
      try {
        payload = await readJsonBounded(res, 2 * 1024 * 1024);
      } catch (error) {
        throw new Error(error?.code === 'BODY_TOO_LARGE' ? '价目文件过大（超过 2MB）' : '返回的不是合法 JSON');
      }
    }
    const norm = normalizePriceFeed(payload);
    if (!norm || !Object.keys(norm.prices).length) throw new Error('没有可用的价格条目（需要 in/out 价目或倍率表）');
    loaded = { prices: norm.prices, url: target, dropped: norm.dropped || 0 };
  } catch (err) {
    error = String(err?.cause?.message ?? err?.message ?? err);
    // ② 直接拉失败就按"渠道探测"再试一次：中转站的价目常挂在 <base>/api/pricing，
    //    而且是 one-api 的倍率表（要按汇率/分组换算），直接拉 Base URL 只会拿到
    //    404 或 HTML。探测成功后记下真正命中的地址，下次少走一遍。
    try {
      const probe = await probeChannelPrices({ url: target, timeoutMs, fetchImpl: options.fetchImpl, allowPrivate });
      if (probe.ok && Object.keys(probe.prices || {}).length) {
        loaded = {
          prices: probe.prices,
          url: String(probe.sourceUrl || target).trim(),
          dropped: probe.skipped || 0
        };
        error = '';
      } else if (probe.error) {
        error = probe.error;
      }
    } catch (err2) {
      error = String(err2?.message ?? err2);
    }
  }

  if (loaded) {
    // 拉的过程中被删掉了：丢弃结果（见 shouldKeepVendor）
    if (!shouldKeepVendor(v, wasConfigured)) return channelPriceStatus();
    feeds[v] = {
      url: loaded.url,
      ok: true,
      error: '',
      fetchedAt: Date.now(),
      count: Object.keys(loaded.prices).length,
      dropped: loaded.dropped,
      prices: loaded.prices
    };
    injectOne(v, loaded.prices);
  } else {
    if (!shouldKeepVendor(v, wasConfigured)) return channelPriceStatus();   // 拉的过程中被删掉了
    const previous = feeds[v] || {};
    feeds[v] = {
      url: target,
      ok: false,
      error,
      fetchedAt: Date.now(),
      count: previous.count || 0,
      dropped: previous.dropped || 0,
      prices: previous.prices || {}   // 失败不清表：继续用上一次拉到的
    };
    injectOne(v, feeds[v].prices);
  }
  writeFile();
  return channelPriceStatus();
}

/** 不等待地拉一次（给启动时的后台刷新用）。 */
function applyFeed(vendor, url) {
  refreshChannelFeed(vendor, url).catch(() => { /* 内部已吞，这里是第二道保险 */ });
}

/** 删除一个渠道的价目表（同时从查价层撤掉）。 */
export function removeChannelFeed(vendor) {
  const v = String(vendor || '').trim();
  if (!v) return channelPriceStatus();
  revoked.add(v);
  removedAt[v] = Date.now();
  delete feeds[v];
  injectOne(v, null);
  writeFile();
  return channelPriceStatus();
}

/** 给控制台看的状态：每个渠道的地址、条数、上次时间、错误。 */
export function channelPriceStatus() {
  return Object.entries(feeds)
    .map(([vendor, feed]) => ({
      vendor,
      url: String(feed?.url || ''),
      ok: feed?.ok === true,
      error: String(feed?.error || ''),
      fetchedAt: Number(feed?.fetchedAt || 0),
      count: Number(feed?.count || 0),
      dropped: Number(feed?.dropped || 0),
      auto: feed?.auto === true
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}

/** 测试用：当前注入的渠道数与条目数。 */
export function channelPriceCounts() {
  const out = {};
  for (const [vendor, feed] of Object.entries(feeds)) {
    out[vendor] = Object.keys(feed?.prices || {}).length;
  }
  return out;
}

/**
 * 自动探测（"零配置"路径）：用户填了渠道地址但还没配任何渠道价目表时，
 * 后台自己探一次 —— 成功就把结果登记成该渠道的价目表（写进 config，
 * 之后按 24h 缓存刷新）；失败**完全静默**，回落到官方价估算。
 *
 * 约束：
 *   - 同一个渠道 24h 内只试一次（成功失败都算），避免每次重启都去敲对方站点
 *   - 已经有该渠道的价目表时不再探测
 *   - 任何异常都吞掉：这个函数绝不把错误抛给调用方
 */
export async function maybeAutoProbeChannel({ baseUrl, vendor, feedsConfig = [], options = {} } = {}) {
  try {
    const url = String(baseUrl || '').trim();
    const channel = String(vendor || '').trim();
    if (!url || !channel || !/^https?:\/\//i.test(url)) return { probed: false, reason: 'no-target' };
    const configured = (Array.isArray(feedsConfig) ? feedsConfig : [])
      .some((f) => String(f?.vendor || '').trim() === channel);
    if (configured) return { probed: false, reason: 'configured' };
    if (removedAt[channel]) return { probed: false, reason: 'removed' };   // 用户删过：别再自动探回来
    const last = Number(autoProbeAt[channel] || 0);
    if (last && Date.now() - last < AUTO_PROBE_TTL_MS) return { probed: false, reason: 'recent' };

    autoProbeAt[channel] = Date.now();
    writeFile();
    const probe = await probeChannelPrices({
      url,
      timeoutMs: Number(options.timeoutMs) || 12000,
      fetchImpl: options.fetchImpl
    });
    if (!probe.ok || !Object.keys(probe.prices || {}).length) {
      return { probed: true, ok: false, error: probe.error || '没有识别到价目' };
    }
    // 登记成该渠道的价目表（写 config + 落盘 + 注入）。
    // ⚠️ 必须登记**探测命中的那个价目地址**（probe.sourceUrl，通常是 <base>/api/pricing），
    //    而不是用户填的 Base URL —— 后者拉不到 JSON，后面每次刷新都会失败，
    //    且因为"该渠道已配置"再也不会自动重探，价格会永久冻结在首次探测的结果上。
    const priceUrl = String(probe.sourceUrl || url).trim();
    try {
      const current = options.getConfig ? options.getConfig() : null;
      const feeds = Array.isArray(current?.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
      if (!feeds.some((f) => String(f?.vendor || '').trim() === channel)) {
        const write = options.updateConfig || updateConfig;
        write({ api: { ...(current?.api || {}), channelPriceFeeds: [...feeds, { vendor: channel, url: priceUrl, auto: true }] } });
      }
    } catch { /* 写不进 config 也要把表用起来 */ }
    feeds[channel] = {
      url: priceUrl,
      ok: true,
      error: '',
      fetchedAt: Date.now(),
      count: Object.keys(probe.prices).length,
      dropped: probe.skipped || 0,
      prices: probe.prices,
      auto: true,
      source: probe.kind
    };
    injectOne(channel, probe.prices);
    writeFile();
    return { probed: true, ok: true, count: Object.keys(probe.prices).length, kind: probe.kind };
  } catch (error) {
    return { probed: true, ok: false, error: String(error?.message ?? error) };
  }
}
