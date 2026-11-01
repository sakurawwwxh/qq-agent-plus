// 模型价格探测 / 渠道价目表 / 价格表刷新路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// modelPricesPayload 仍在 app.js（GET /api/model-prices 也用它），通过依赖注入复用。
import { probeChannelPrices, capPrices } from '../../pricing/price-probe.js';
import { refreshChannelFeed, removeChannelFeed } from '../../pricing/channel-prices.js';
import { refreshPriceFeed } from '../../pricing/price-feed.js';
import { vendorOfConfig } from '../../pricing/model-prices.js';

export function registerPriceRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const updateConfig = deps.updateConfig;
  const auditWrite = deps.auditWrite;
  const modelPricesPayload = deps.modelPricesPayload;
  if (!router || !json || !readBody || !getConfig || !updateConfig || !auditWrite || !modelPricesPayload) {
    throw new Error('registerPriceRoutes 需要 router/json/readBody/getConfig/updateConfig/auditWrite/modelPricesPayload');
  }

  router.add('POST', '/api/model-prices/probe', async (req, res) => {
    const cfgNow = getConfig();
    const body = await readBody(req);
    const target = String(body.url || cfgNow.api?.baseUrl || '').trim();
    const probe = await probeChannelPrices({
      url: target,
      usdRate: body.usdRate,
      fetchImpl: undefined,
      timeoutMs: Math.min(30000, Math.max(3000, Number(body.timeoutMs) || 12000))
    });
    return json(res, 200, {
      ok: probe.ok,
      kind: probe.kind,
      sourceUrl: probe.sourceUrl,
      usdRate: probe.usdRate,
      group: probe.group,
      groupRatio: probe.groupRatio,
      modelCount: probe.modelCount,
      skipped: probe.skipped,
      tried: probe.tried,
      error: probe.error,
      vendor: vendorOfConfig(cfgNow) || '',
      prices: capPrices(probe.prices || {})
    });
  });
  router.add('POST', '/api/channel-prices', async (req, res) => {
    const body = await readBody(req);
    const vendor = String(body.vendor || '').trim();
    const feedUrl = String(body.url || '').trim();
    if (!vendor) return json(res, 400, { error: '缺少渠道名（vendor）' });
    if (!/^https?:\/\//i.test(feedUrl)) return json(res, 400, { error: '价目表 URL 必须以 http(s):// 开头' });
    // 先写配置（意图），再拉一次（结果）
    const current = getConfig();
    const feeds = Array.isArray(current.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
    const auditBeforeFeeds = structuredClone(feeds);   // feeds 是配置里的活引用，先拍审计快照
    const next = feeds.filter((f) => String(f?.vendor || '').trim() !== vendor);
    next.push({ vendor, url: feedUrl });
    updateConfig({ api: { ...(current.api || {}), channelPriceFeeds: next } });
    const status = await refreshChannelFeed(vendor, feedUrl);
    auditWrite('channel-prices.save', vendor, { req, before: auditBeforeFeeds, after: next });
    return json(res, 200, { ok: true, feeds: status });
  });
  router.add('POST', '/api/channel-prices/refresh', async (req, res) => {
    const body = await readBody(req);
    const vendor = String(body.vendor || '').trim();
    const current = getConfig();
    const feeds = Array.isArray(current.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
    const hit = feeds.find((f) => String(f?.vendor || '').trim() === vendor);
    if (!hit) return json(res, 404, { error: `没有这个渠道的价目表：${vendor}` });
    const status = await refreshChannelFeed(vendor, String(hit.url || '').trim());
    return json(res, 200, { ok: true, feeds: status });
  });
  router.add('POST', '/api/channel-prices/remove', async (req, res) => {
    const body = await readBody(req);
    const vendor = String(body.vendor || '').trim();
    if (!vendor) return json(res, 400, { error: '缺少渠道名（vendor）' });
    const current = getConfig();
    const feeds = Array.isArray(current.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
    updateConfig({
      api: {
        ...(current.api || {}),
        channelPriceFeeds: feeds.filter((f) => String(f?.vendor || '').trim() !== vendor)
      }
    });
    const status = removeChannelFeed(vendor);
    return json(res, 200, { ok: true, feeds: status });
  });
  router.add('POST', '/api/model-prices/refresh', async (req, res) => {
    const st = await refreshPriceFeed(getConfig().api?.priceRemoteUrl || '');
    return json(res, 200, { ok: st.ok, ...modelPricesPayload() });
  });
}
