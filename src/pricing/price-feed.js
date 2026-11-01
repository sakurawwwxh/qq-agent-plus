// 远程价格表：从自托管 URL 拉取模型价格，按 id 覆盖内置表。
//
// 设计原则（按需求定死，勿改）：
//   1. 本地永远有一张表可用：内置表（代码里）+ 拉到的表落盘缓存，
//      服务器挂了、重启了、断网了都不影响查价
//   2. 定期拉取：启动时拉一次，之后每 24 小时重拉；失败过 3 小时再试
//   3. 对正常使用**零影响**：拉取全异步（不阻塞启动/请求），所有错误
//      都被吞进状态字段，这个模块的任何函数都不允许把异常抛给调用方
//
// 工作方式：
//   1. 启动时先应用磁盘缓存（上次拉到的表），再联网拉新
//   2. 之后每小时检查一次：成功表超过 24h 就重拉；上次失败超过 3h 就重试
//   3. 拉取失败不清表 —— 远程缓存 > 内置表，总有一张表可用
//
// 远程 JSON 格式（兼容四种外形，方便直接复用各种导出物）：
//   { "deepseek-v4-flash": { "in": 1.5, "out": 4.5, "cached": 0.05 } }   // 裸 map
//   { "prices": { ...同上... } }                                          // 带包裹
//   { "prices": [ { "id": "...", "in": 1.5, ... } ] }                     // 数组（listOfficialPrices 的产物）
//   [ { "id": "...", ... } ]                                              // 裸数组
// 条目字段：in/out 必填数字（元/百万 token），cached 可 null，
//           peak/image/note/src 可选，与内置表条目同构。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';
import { setRemotePrices } from './model-prices.js';
import { readJsonBounded } from '../core/http-body.js';
import { fetchJsonSafe } from './safe-fetch-json.js';

const CACHE_FILE = path.join(DATA_DIR, 'price-feed-cache.json');
const FETCH_TIMEOUT_MS = 10000;
const SUCCESS_INTERVAL_MS = 24 * 3600 * 1000;        // 成功后 24h 再拉
const FAILURE_RETRY_MS = 3 * 3600 * 1000;            // 失败过 3 小时重试
const TICK_MS = 3600 * 1000;                         // 每小时检查一次是否该拉

/**
 * 默认远程价格表：项目自己的 prices.json（仓库根目录那份，与内置表同结构）。
 * 留空即用这两个候选：优先 jsDelivr CDN（国内一般可达），raw.githubusercontent 只作兜底。
 * 想用自己的表就填 URL；`none` 表示完全不用远程表（只用内置表）。
 */
const DEFAULT_FEED_URLS = [
  'https://cdn.jsdelivr.net/gh/sakurawwwxh/qq-agent-plus@main/prices.json',
  'https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plus/main/prices.json'
];
const DISABLED_VALUES = new Set(['none', 'off', 'false', '0', 'disabled']);

/** 配置值 → 候选地址列表（空 = 项目默认；'none' = 关闭）。 */
export function priceFeedTargets(configured) {
  const raw = String(configured ?? '').trim();
  if (DISABLED_VALUES.has(raw.toLowerCase())) return [];
  if (raw) return [raw];
  return [...DEFAULT_FEED_URLS];
}

const status = {
  url: '',
  enabled: false,
  source: 'builtin',      // 'remote' = 在线拉的 | 'cache' = 磁盘缓存 | 'builtin' = 内置表
  fetchedAt: 0,           // 上次拉取（尝试）时间
  ok: false,              // 上次拉取是否成功
  error: '',
  sourceUrl: '',         // 实际生效的那个地址（默认会给两个候选）
  tag: '',                // 候选地址组合的指纹（缓存校验用）
  count: 0,               // 生效的远程条目数
  aliasCount: 0,          // 生效的远程别名数
  dropped: 0              // 校验被丢弃的条目数
};

let timer = null;
/** 正在跑的刷新：{ key, promise }。同一组地址的重复调用复用同一次请求。 */
let inFlight = null;

/**
 * 取一个价格数字：只接受"真的写了非负数字"（数字或数字串）。
 * null / 空串 / 布尔 / 负数 / 非数字串一律算坏值 —— `Number(null) === 0`、
 * `Number('') === 0` 会把它们悄悄变成"0 元免费价"，这正是本文档最忌讳的
 * "未定价 ≠ 免费"（见 docs/model-prices.md）。
 */
function priceNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/** 校验并规范化一条价格条目；不合格返回 null。 */
function normEntry(v) {
  if (!v || typeof v !== 'object') return null;
  const inVal = priceNumber(v.in), outVal = priceNumber(v.out);
  // 写了但写坏（null / 空串 / 负数 / 非数字）→ 整条丢弃，绝不当成 0 元
  if ((Object.hasOwn(v, 'in') && inVal === null) || (Object.hasOwn(v, 'out') && outVal === null)) return null;
  // 两边都没写数字：坏条目（0/0 是写出来的合法免费价，不算坏）
  if (inVal === null && outVal === null) return null;
  const e = {
    in: inVal ?? 0,
    out: outVal ?? 0,
    cached: priceNumber(v.cached)
  };
  if (v.peak && typeof v.peak === 'object') {
    const pi = priceNumber(v.peak.in), po = priceNumber(v.peak.out), pc = priceNumber(v.peak.cached);
    // peak 里某一档写坏时退回基础价即可，不因为一条坏数据丢掉整条价目
    e.peak = {
      in: pi ?? e.in,
      out: po ?? e.out,
      cached: pc ?? e.cached
    };
  }
  // 图片计费规则结构各异（capped/pixel/unknown），原样透传，由 imageTokens 解读
  if (v.image && typeof v.image === 'object') e.image = v.image;
  if (typeof v.note === 'string' && v.note) e.note = v.note;
  // 计费方式（token / flat 包月 / none 本地不计费）也允许由表提供
  const billing = String(v.billing ?? '').trim().toLowerCase();
  if (billing === 'flat') {
    e.billing = 'flat';
    const amount = Number(v.amount);
    e.amount = Number.isFinite(amount) && amount > 0 ? amount : 0;
    e.period = String(v.period ?? '').trim().toLowerCase() === 'day' ? 'day' : 'month';
  } else if (billing === 'none') {
    e.billing = 'none';
  }
  e.src = typeof v.src === 'string' && v.src ? v.src : 'remote';
  return e;
}

/**
 * 校验并规范化远程价格表的整个载荷。
 * 顺带接受可选的 aliases（{ "渠道叫法": "表内条目名" }），
 * 让别名表也能随远程价格表更新，不必等发版。
 * @returns {{ prices: object, aliases: object, dropped: number } | null} 载荷完全不可用返回 null
 */
export function normalizePriceFeed(data) {
  if (!data || typeof data !== 'object') return null;

  // 四种外形 → 统一的 [id, entry] 列表
  let pairs = [];
  let rawAliases = null;
  if (Array.isArray(data)) {
    pairs = data.map((x) => [x?.id, x]);
  } else if (Array.isArray(data.prices)) {
    pairs = data.prices.map((x) => [x?.id, x]);
    rawAliases = data.aliases;
  } else if (data.prices && typeof data.prices === 'object') {
    pairs = Object.entries(data.prices);
    rawAliases = data.aliases;
  } else {
    // 裸 map：排除明显的元数据键，避免把 {"updated": "..."} 当成模型
    rawAliases = data.aliases;
    pairs = Object.entries(data).filter(([k]) => !/^(updated|version|meta|comment|aliases)$/i.test(k));
  }

  const prices = {};
  let dropped = 0;
  for (const [id, v] of pairs) {
    const key = String(id ?? '').trim().toLowerCase();
    const e = normEntry(v);
    if (!key || !e) { dropped++; continue; }
    prices[key] = e;
  }
  // 空表一律判失败：返回 {} / {prices:[]} / 只有元数据键时，若当成成功就会
  // setRemotePrices({}) 清掉已生效的远程覆盖价，还会把空表写进磁盘缓存跨重启保留。
  if (!Object.keys(prices).length) return null;

  const aliases = {};
  if (rawAliases && typeof rawAliases === 'object' && !Array.isArray(rawAliases)) {
    for (const [from, to] of Object.entries(rawAliases)) {
      const key = String(from ?? '').trim().toLowerCase();
      if (!key) continue;
      // 字符串 = 永久别名；对象 = 带时间区间，原样透传给查价层
      if (typeof to === 'string') {
        const value = to.trim().toLowerCase();
        if (value && key !== value) aliases[key] = value;
        continue;
      }
      if (to && typeof to === 'object' && to.to) aliases[key] = { ...to, to: String(to.to).trim().toLowerCase() };
    }
  }
  return { prices, aliases, dropped };
}

/** 应用一张表：注入查价层 + 更新状态。 */
function applyPrices(prices, source, aliases = null) {
  setRemotePrices(prices, aliases);
  status.source = source;
  status.count = Object.keys(prices).length;
  status.aliasCount = aliases ? Object.keys(aliases).length : 0;
}

/** 启动时先吃磁盘缓存（地址组合对得上才用）。 */
function applyDiskCache(targets, tag) {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data?.tag !== tag) return false;   // 缓存是另一组地址的，不能用
    const norm = normalizePriceFeed({ prices: data.prices, aliases: data.aliases });
    if (!norm) return false;
    applyPrices(norm.prices, 'cache', norm.aliases);
    status.dropped = norm.dropped;
    status.sourceUrl = String(data.url || '');
    return true;
  } catch {
    return false;
  }
}

function writeDiskCache(tag, url, prices, aliases = null) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    // 与其他落盘同口径锁 0600（缓存本身不敏感，但避免 umask 波动带来的文件权限漂移）
    fs.writeFileSync(tmp, JSON.stringify({ tag, url, fetchedAt: Date.now(), prices, aliases: aliases || {} }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* 缓存写不进去不影响使用 */ }
}

/**
 * 立即拉取一次远程价格表。
 *
 * 同一组地址已有请求在飞时复用那一次（手动「立即拉取」撞上启动/24h 定时那次时，
 * 后返回的旧结果会把新结果覆盖掉）；地址变了则等前一次结束再跑，
 * 免得新地址的配置被旧地址的结果盖回去。
 *
 * @param {string} configured 配置里的值：URL / ''（用默认地址）/ 'none'（关闭）
 * @returns {Promise<object>} 最新状态
 */
export function refreshPriceFeed(configured, options = {}) {
  const key = priceFeedTargets(configured).join(',');
  if (inFlight && inFlight.key === key) return inFlight.promise;
  // 没有人在飞时**同步启动**（跟以前一样，"调用即发请求"，不额外拖一个微任务）；
  // 地址换了才排队等前一次结束 —— 不然新地址的结果会被旧地址盖回去。
  const promise = inFlight
    ? inFlight.promise.catch(() => {}).then(() => refreshOnce(configured, options))
    : refreshOnce(configured, options);
  inFlight = { key, promise };
  // 结束（无论成败）都要把坑位让出来；这里同时充当 rejection 处理器，避免未捕获的 rejection
  promise.then(
    () => { if (inFlight?.promise === promise) inFlight = null; },
    () => { if (inFlight?.promise === promise) inFlight = null; }
  );
  return promise;
}

async function refreshOnce(configured, options = {}) {
  // 生产路径走 safe-fetch（SSRF 防线）；fetchImpl 只给测试注入本地假实现。
  const fetchImpl = options.fetchImpl || null;
  const timeoutMs = Number(options.timeoutMs) || FETCH_TIMEOUT_MS;
  const allowPrivate = options.allowPrivate
    ?? getConfig().security?.allowPrivatePriceHosts === true;
  const targets = priceFeedTargets(configured);
  status.url = String(configured ?? '').trim();
  status.fetchedAt = Date.now();
  status.tag = targets.join(',');
  if (!targets.length) {
    status.enabled = false;
    status.sourceUrl = '';
    return priceFeedStatus();
  }
  status.enabled = true;
  const failures = [];
  for (const url of targets) {
    try {
      let data;
      if (!fetchImpl) {
        data = await fetchJsonSafe(url, { timeoutMs, allowPrivate });
      } else {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 有界读（2MB）：超限与非法 JSON 分开报（2026-10-09 审查）
        try {
          data = await readJsonBounded(res, 2 * 1024 * 1024);
        } catch (error) {
          throw new Error(error?.code === 'BODY_TOO_LARGE' ? '价格文件过大（超过 2MB）' : '返回的不是合法 JSON');
        }
      }
      const norm = normalizePriceFeed(data);
      if (!norm) throw new Error('JSON 里没有可用的价格条目');
      applyPrices(norm.prices, 'remote', norm.aliases);
      status.ok = true;
      status.error = '';
      status.dropped = norm.dropped;
      status.sourceUrl = url;
      writeDiskCache(targets.join(','), url, norm.prices, norm.aliases);
      return priceFeedStatus();
    } catch (error) {
      failures.push(`${url}：${String(error?.cause?.message ?? error?.message ?? error)}`);
    }
  }
  // 全都失败：不清表，继续用远程缓存/内置表，下次重试
  status.ok = false;
  status.error = failures.join('；');
  return priceFeedStatus();
}

/**
 * 初始化远程价格表：吃缓存 → 立即拉 → 起定时检查。
 * 幂等：配置值没变就什么都不做（配置保存时会再次调这里）。
 * 配置值：URL / ''（用项目默认价格表）/ 'none'（关闭）。
 *
 * ⚠️ 所有不带 await 的调用都挂 .catch(() => {})：
 *    refreshPriceFeed 内部已全 catch，这里是第二道保险 ——
 *    这个模块绝不允许以任何方式影响主程序（未捕获的 rejection 也算）。
 */
export function initPriceFeed(configured) {
  const targets = priceFeedTargets(configured);
  const key = targets.join(',') || 'disabled';
  status.url = String(configured ?? '').trim();
  if (!targets.length) {
    if (timer) { clearInterval(timer); timer = null; }
    status.enabled = false;
    status.sourceUrl = '';
    // 切成 `none` 要当场回落到内置表：以前只清 enabled/sourceUrl，进程里生效的还是上一张
    // 远程表（界面却写着"远程价格表已关闭"），要重启才真的只用内置表。
    // 磁盘缓存留着不清 —— 那是有意的设计：重新启用时先用缓存顶上，拉到新的再覆盖。
    status.source = 'builtin';
    status.ok = false;
    status.error = '';
    status.fetchedAt = 0;
    status.tag = '';
    setRemotePrices({});
    return;
  }
  // 地址没变就什么都不做 —— 注意要在动定时器**之前**返回：
  // 配置保存时也会调这里，先 clearInterval 再 return 会让 24h 刷新永久停摆。
  if (status.tag === key && status.enabled) return;
  if (timer) { clearInterval(timer); timer = null; }
  status.tag = key;
  status.enabled = true;
  applyDiskCache(targets, key);            // 先用缓存顶上，拉到新的再覆盖
  refreshPriceFeed(configured).catch(() => {});   // 启动即拉（异步，不阻塞启动）
  timer = setInterval(() => {
    const age = Date.now() - (status.fetchedAt || 0);
    if (status.ok && age < SUCCESS_INTERVAL_MS) return;
    if (!status.ok && age < FAILURE_RETRY_MS) return;
    refreshPriceFeed(status.url).catch(() => {});
  }, TICK_MS);
  timer.unref?.();   // 别让定时器拖着进程不退出（测试/脚本场景）
}

/** 当前状态（给 /api/model-prices 与设置页展示）。 */
export function priceFeedStatus() {
  // 换了地址、新地址又没拉成功时，生效的还是上一组地址拉到的表（status.sourceUrl 是旧地址）：
  // 界面必须能说出"新地址还没生效"，否则看起来像新地址已经生效了。
  const targets = priceFeedTargets(status.url);
  return {
    ...status,
    sourceStale: Boolean(status.sourceUrl) && !targets.includes(status.sourceUrl)
  };
}
