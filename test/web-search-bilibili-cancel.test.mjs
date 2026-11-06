import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bili-search-cancel-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.webSearch.provider = 'bilibili';
updateConfig(cfg);

const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const navBody = { data: { wbi_img: {
  img_url: 'https://example.test/abcdefghijklmnopqrstuvwxyz012345.png',
  sub_url: 'https://example.test/012345abcdefghijklmnopqrstuvwxyz.png'
} } };
const searchBody = { code: 0, data: { result: [{
  title: '合成结果', bvid: 'BV1xx411c7mD', description: '合成摘要'
}] } };
const response = (body) => ({ ok: true, json: async () => body });
const { webSearch, bilibiliSearch, resetBilibiliMixinCacheForTest } = await import('../src/llm/web-search.js');

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

test('B 站搜索：已取消的统一入口不发送签名或搜索请求', async (t) => {
  resetBilibiliMixinCacheForTest();
  const calls = [];
  mockFetch(t, async (url, { signal }) => {
    calls.push(String(url));
    signal.throwIfAborted();
    return response(String(url) === NAV ? navBody : searchBody);
  });
  const reason = new Error('synthetic-stop');
  await assert.rejects(webSearch('合成查询', { signal: AbortSignal.abort(reason) }),
    (error) => error === reason);
  assert.deepEqual(calls, []);
});

for (const stage of ['headers', 'body']) {
  test(`B 站搜索：签名请求等待 ${stage} 时取消，不等待内部超时或继续无签名搜索`, async (t) => {
    resetBilibiliMixinCacheForTest();
    const ac = new AbortController();
    const reason = new Error('synthetic-stop');
    const calls = [];
    let navSignal;
    let release;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    mockFetch(t, async (url, { signal }) => {
      calls.push(String(url));
      signal.throwIfAborted();
      if (String(url) !== NAV) return response(searchBody);
      navSignal = signal;
      const wait = () => new Promise((resolve, reject) => {
        release = () => reject(new Error('synthetic-cleanup'));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      });
      return stage === 'headers' ? wait() : { ok: true, json: wait };
    });
    const pending = bilibiliSearch('合成查询', { signal: ac.signal })
      .then((value) => ({ value }), (error) => ({ error }));
    await ready;
    ac.abort(reason);
    const aborted = navSignal.aborted;
    if (!aborted) release(); // 旧实现也及时收尾，避免反证挂到真实超时。
    const outcome = await pending;
    assert.equal(aborted, true, '签名请求也必须收到本轮取消信号');
    assert.equal(outcome.error, reason, '传播原始取消原因');
    assert.deepEqual(calls, [NAV], '取消不得降级成新的无签名搜索');
  });
}

test('B 站搜索：签名返回时取消，不缓存取消结果或继续发请求', async (t) => {
  resetBilibiliMixinCacheForTest();
  const ac = new AbortController();
  const reason = new Error('synthetic-stop');
  const calls = [];
  let first = true;
  mockFetch(t, async (url, { signal }) => {
    calls.push(String(url));
    signal.throwIfAborted();
    if (String(url) !== NAV) return response(searchBody);
    return { ok: true, json: async () => {
      if (first) { first = false; ac.abort(reason); }
      return navBody;
    } };
  });
  await assert.rejects(bilibiliSearch('合成查询', { signal: ac.signal }), (error) => error === reason);
  assert.deepEqual(calls, [NAV]);
  calls.length = 0;
  await bilibiliSearch('下一次查询');
  assert.equal(calls[0], NAV, '取消的签名准备不得更新成功缓存');
  assert.equal(calls.length, 2);
});

for (const failure of ['HTTP', 'JSON', 'timeout']) {
  test(`B 站搜索：普通签名 ${failure} 失败仍允许无签名搜索`, async (t) => {
    resetBilibiliMixinCacheForTest();
    const calls = [];
    mockFetch(t, async (url) => {
      calls.push(String(url));
      if (String(url) !== NAV) return response(searchBody);
      if (failure === 'HTTP') return { ok: false, status: 503 };
      if (failure === 'JSON') return { ok: true, json: async () => { throw new SyntaxError('synthetic-json'); } };
      throw new DOMException('synthetic-timeout', 'TimeoutError');
    });
    const result = await bilibiliSearch('合成查询');
    assert.equal(result.results[0].title, '合成结果');
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1]).searchParams.has('w_rid'), false);
  });
}

test('B 站搜索：成功缓存照常复用，取消调用不影响下一轮正常搜索', async (t) => {
  resetBilibiliMixinCacheForTest();
  const calls = [];
  mockFetch(t, async (url, { signal }) => {
    calls.push(String(url));
    signal.throwIfAborted();
    return response(String(url) === NAV ? navBody : searchBody);
  });
  await bilibiliSearch('第一次查询');
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.has('w_rid'), true);
  calls.length = 0;
  const reason = new Error('synthetic-stop');
  await assert.rejects(bilibiliSearch('取消查询', { signal: AbortSignal.abort(reason) }),
    (error) => error === reason);
  assert.deepEqual(calls, []);
  await bilibiliSearch('下一次查询');
  assert.equal(calls.length, 1, '正常调用继续复用已成功的缓存');
  assert.equal(new URL(calls[0]).searchParams.has('w_rid'), true);
});

test('B 站搜索：并发查询取消其中一个不取消另一个签名请求', async (t) => {
  resetBilibiliMixinCacheForTest();
  const navRequests = [];
  let searchCount = 0;
  mockFetch(t, async (url, { signal }) => {
    signal.throwIfAborted();
    if (String(url) !== NAV) { searchCount += 1; return response(searchBody); }
    return new Promise((resolve, reject) => {
      navRequests.push({ signal, resolve: () => resolve(response(navBody)), reject });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const ac = new AbortController();
  const reason = new Error('synthetic-stop');
  const cancelled = bilibiliSearch('取消查询', { signal: ac.signal })
    .then((value) => ({ value }), (error) => ({ error }));
  const active = bilibiliSearch('保留查询');
  assert.equal(navRequests.length, 2);
  ac.abort(reason);
  const wasAborted = navRequests[0].signal.aborted;
  if (!wasAborted) navRequests[0].reject(new Error('synthetic-cleanup'));
  navRequests[1].resolve();
  const [outcome, result] = await Promise.all([cancelled, active]);
  assert.equal(wasAborted, true);
  assert.equal(navRequests[1].signal.aborted, false);
  assert.equal(outcome.error, reason);
  assert.equal(result.results[0].title, '合成结果');
  assert.equal(searchCount, 1);
});
