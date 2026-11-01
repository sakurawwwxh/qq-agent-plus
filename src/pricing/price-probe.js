// 渠道价探测：从用户自己那家渠道把"实付价"拉下来，做成可直接写进 modelPrices 的条目。
//
// 支持两类来源：
//   ① one-api / new-api 家族的公开 /api/pricing（返回模型倍率）→ 换算成 元/百万 token
//      依据：one-api 的额度单位是 1 美元 = 500000 quota；一次调用消耗
//        quota = (prompt_tokens + completion_tokens × completion_ratio) × model_ratio × group_ratio
//      所以 每 1M 输入 token = model_ratio × 2 美元，输出再乘 completion_ratio，
//      最后乘站点汇率（/api/status 的 usd_exchange_rate，取不到就用 7.2 并注明）。
//   ② 我们自己的价目表形状（in/out/cached，元/百万）→ 直接采用（见 docs/model-prices.md）
//
// 只做"探测 + 预览"：绝不自动写入配置。写入由用户确认（控制台按渠道键写进 api.modelPrices）。
// 所有失败都以 { ok:false, error } 返回，不抛异常。
import { normalizePriceFeed } from './price-feed.js';
import { readJsonBounded } from '../core/http-body.js';
import { getConfig } from '../core/config.js';
import { fetchJsonSafe } from './safe-fetch-json.js';

const DEFAULT_USD_RATE = 7.2;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_MODELS = 500;

/** 去掉 baseUrl 尾部的常见 API 路径，拿到站点根（one-api 的 /api/pricing 挂在根上）。 */
export function siteRootOf(baseUrl) {
  let raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    raw = raw.replace(/\/+$/, '');
    return /^[a-z]+:\/\//i.test(raw) ? raw : '';
  }
}

/** 候选探测地址：站点根的 /api/pricing、/api/status，以及用户直接给的地址。 */
export function probeCandidates(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  const root = siteRootOf(raw);
  const out = [];
  const push = (url) => {
    if (url && !out.includes(url)) out.push(url);
  };
  // 用户直接把 /api/pricing 填进来时优先用它
  if (/\/api\/(pricing|status)$/i.test(raw)) push(raw);
  if (root) {
    push(`${root}/api/pricing`);
    push(`${root}/api/status`);
  }
  if (raw && !/\/api\/(pricing|status)$/i.test(raw)) push(`${raw}/api/pricing`);
  return out;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从 /api/status 或 /api/pricing 里找站点汇率（美元 → 人民币）。
 * 也接受直接给一个数字/数字串（调用方显式指定汇率，如 probeChannelPrices 的 usdRate）。
 */
export function pickUsdRate(...payloads) {
  for (const payload of payloads) {
    if (typeof payload === 'number' || (typeof payload === 'string' && payload.trim() !== '')) {
      const direct = num(payload);
      if (direct > 1 && direct < 20) return direct;
      continue;
    }
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    for (const key of ['usd_exchange_rate', 'usd_rate', 'exchange_rate', 'rate']) {
      const rate = num(data?.[key]);
      if (rate > 1 && rate < 20) return rate;
    }
  }
  return 0;
}

/** 从 group_ratio 里挑一个分组倍率：优先 default，其次唯一项，最后取第一项。 */
export function pickGroupRatio(groupRatio) {
  if (!groupRatio || typeof groupRatio !== 'object') return { group: '', ratio: 1 };
  const entries = Object.entries(groupRatio)
    .map(([group, ratio]) => [group, num(ratio)])
    .filter(([, ratio]) => ratio > 0);
  if (!entries.length) return { group: '', ratio: 1 };
  const preferred = entries.find(([group]) => group.toLowerCase() === 'default') || entries[0];
  return { group: preferred[0], ratio: preferred[1] };
}

/**
 * one-api 风格载荷 → 元/百万 token 价目。
 * @returns {{ prices: object, skipped: number, group: string, groupRatio: number }}
 */
export function oneApiPricesToTable(payload, usdRate) {
  const data = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
  const { group, ratio: groupRatio } = pickGroupRatio(payload?.group_ratio);
  const rate = num(usdRate) || DEFAULT_USD_RATE;
  const prices = {};
  let skipped = 0;
  for (const item of data) {
    const model = String(item?.model_name ?? item?.model ?? '').trim();
    const modelRatio = num(item?.model_ratio ?? item?.ratio);
    // quota_type !== 0 是"按次计费"（不是按 token），我们算不了，跳过并计数
    const byTokens = item?.quota_type == null || Number(item.quota_type) === 0;
    if (!model || !modelRatio || !byTokens) { skipped += 1; continue; }
    const completionRatio = num(item?.completion_ratio) || 1;
    const inPrice = modelRatio * 2 * groupRatio * rate;
    const outPrice = inPrice * completionRatio;
    prices[model] = {
      in: Number(inPrice.toFixed(6)),
      out: Number(outPrice.toFixed(6)),
      cached: Number(inPrice.toFixed(6)),
      note: `渠道自动探测：倍率 ${modelRatio}${completionRatio !== 1 ? ` / 补全 ${completionRatio}` : ''}`
        + `${group ? ` · 分组 ${group} ×${groupRatio}` : ''} · 汇率 ${rate}`
    };
  }
  return { prices, skipped, group, groupRatio };
}

/**
 * 探测一个渠道的价目。
 * @param {{url?:string, usdRate?:number, timeoutMs?:number, fetchImpl?:Function}} options
 * @returns {Promise<{ok:boolean, kind:'table'|'one-api'|'', sourceUrl:string, usdRate:number,
 *   group:string, groupRatio:number, prices:object, modelCount:number, skipped:number,
 *   tried:string[], error:string}>}
 */
export async function probeChannelPrices(options = {}) {
  // 生产路径走 safe-fetch（SSRF 防线）；fetchImpl 只给测试注入本地假实现。
  const fetchImpl = options.fetchImpl || null;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const allowPrivate = options.allowPrivate
    ?? getConfig().security?.allowPrivatePriceHosts === true;
  const candidates = probeCandidates(options.url);
  const tried = [];
  const result = {
    ok: false,
    kind: '',
    sourceUrl: '',
    usdRate: 0,
    group: '',
    groupRatio: 1,
    prices: {},
    modelCount: 0,
    skipped: 0,
    tried,
    error: ''
  };
  if (!candidates.length) {
    result.error = '请先填写渠道地址（Base URL），例如 https://api.example.com/provider/v1';
    return result;
  }

  const fetchJson = async (url) => {
    tried.push(url);
    if (!fetchImpl) return fetchJsonSafe(url, { timeoutMs, allowPrivate });
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 有界读（2MB）：探测目标响应不该无上限（2026-10-09 审查）
    return readJsonBounded(res, 2 * 1024 * 1024);
  };

  let statusPayload = null;
  const failures = [];
  for (const url of candidates) {
    let payload;
    try {
      payload = await fetchJson(url);
    } catch (error) {
      failures.push(`${url}：${String(error?.message ?? error)}`);
      continue;
    }

    // ① 我们自己的价目表形状（in/out/cached）——直接采用
    const norm = normalizePriceFeed(payload);
    if (norm && Object.keys(norm.prices).length) {
      result.ok = true;
      result.kind = 'table';
      result.sourceUrl = url;
      result.prices = norm.prices;
      result.modelCount = Object.keys(norm.prices).length;
      result.skipped = norm.dropped || 0;
      return result;
    }

    // ② one-api / new-api 的倍率表
    const list = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    const hasRatios = list.some((item) => num(item?.model_ratio ?? item?.ratio));
    if (hasRatios) {
      // 汇率可能在同一个载荷里，也可能在 /api/status 里
      let rate = pickUsdRate(payload, options.usdRate);
      if (!rate) {
        const root = siteRootOf(url);
        const statusUrl = `${root || url}/api/status`;
        try {
          statusPayload = await fetchJson(statusUrl);
          rate = pickUsdRate(statusPayload);
        } catch { /* 取不到就用默认值，下面注明 */ }
      }
      const { prices, skipped, group, groupRatio } = oneApiPricesToTable(payload, rate || DEFAULT_USD_RATE);
      if (!Object.keys(prices).length) {
        failures.push(`${url}：识别到倍率表，但没有可用条目（可能都是按次计费）`);
        continue;
      }
      result.ok = true;
      result.kind = 'one-api';
      result.sourceUrl = url;
      result.usdRate = rate || DEFAULT_USD_RATE;
      result.group = group;
      result.groupRatio = groupRatio;
      result.prices = prices;
      result.modelCount = Object.keys(prices).length;
      result.skipped = skipped;
      return result;
    }

    failures.push(`${url}：返回的不是可识别的价目表（既没有 in/out 价目，也没有模型倍率）`);
  }

  result.error = failures.length
    ? `探测失败：${failures.slice(0, 3).join('；')}`
    : '探测失败：没有可用的候选地址';
  return result;
}

/** 只保留需要的键，挡住过大的响应（价格条目上限）。 */
export function capPrices(prices, limit = MAX_MODELS) {
  const keys = Object.keys(prices || {});
  if (keys.length <= limit) return prices;
  const out = {};
  for (const key of keys.slice(0, limit)) out[key] = prices[key];
  return out;
}
