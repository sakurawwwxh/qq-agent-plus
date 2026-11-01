// 价目类 URL 的 SSRF 防线（2026-10-31 复审 P2）：
// 生产路径默认走 safe-fetch，127.0.0.1/RFC1918 一律拒绝；管理员显式
// security.allowPrivatePriceHosts=true（或调用参数 allowPrivate）才放行内网 one-api。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pricing-ssrf-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { probeChannelPrices } = await import('../src/pricing/price-probe.js');
const { refreshChannelFeed } = await import('../src/pricing/channel-prices.js');
const { refreshPriceFeed } = await import('../src/pricing/price-feed.js');
const { updateConfig, getConfig } = await import('../src/core/config.js');

function startServer(payload) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`
    }));
  });
}

const TABLE = { prices: { 'ssrf-model': { in: 1.5, out: 2.5, cached: 0.1 } } };

test('价格探测默认拒绝内网地址；显式 allowPrivate 才放行', async (t) => {
  const { server, url } = await startServer(TABLE);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const denied = await probeChannelPrices({ url });
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /禁止访问内网|内网\/本机/);
  assert.ok(denied.tried.length > 0, '失败也要如实记录试过的地址');

  const allowed = await probeChannelPrices({ url, allowPrivate: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.prices['ssrf-model']?.in, 1.5);
});

test('渠道价目表默认拒绝内网；allowPrivate 才加载', async (t) => {
  const { server, url } = await startServer(TABLE);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const denied = (await refreshChannelFeed('内网渠道', url)).find((row) => row.vendor === '内网渠道');
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /禁止访问内网|内网\/本机/);

  const allowed = (await refreshChannelFeed('内网渠道', url, { allowPrivate: true }))
    .find((row) => row.vendor === '内网渠道');
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
});

test('远程价格表默认拒绝内网；allowPrivate 才拉取', async (t) => {
  const { server, url } = await startServer(TABLE);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const denied = await refreshPriceFeed(url);
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /禁止访问内网|内网\/本机/);

  const allowed = await refreshPriceFeed(url, { allowPrivate: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
});


test('security.allowPrivatePriceHosts 配置键真的接线（不是只有 options 参数）', async (t) => {
  const { server, url } = await startServer(TABLE);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const cfg = getConfig();
  updateConfig({ security: { ...cfg.security, allowPrivatePriceHosts: true } });
  try {
    const allowed = await probeChannelPrices({ url });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
  } finally {
    updateConfig({ security: { ...getConfig().security, allowPrivatePriceHosts: false } });
  }
  const denied = await probeChannelPrices({ url });
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /禁止访问内网|内网\/本机/);
});
