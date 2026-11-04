// Tavily 搜索 provider + 聚合多源并发（PR #18）测试：
// 请求契约、结果解析、错误形态、聚合的去重/优先级/部分失败语义、源数上限、分发入口。
// 部分失败不影响整体、全部失败才报错——这是聚合模式对模型可见的核心承诺，用例必须钉死。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tavily-search-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
delete process.env.TAVILY_API_KEY;
// 隔离端口：与本文件不冲突的其他测试文件并行跑时不会互相 EADDRINUSE（同 web-search-doubao 的口径）。
// 端口选 22497：在 Linux（32768-60999）与 Windows（49152-65535）的临时端口范围之外。
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  server: { port: 22497, host: '127.0.0.1' }
}));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');

const setWebSearch = (patch) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, ...patch };
  updateConfig(cfg);
};

test('tavilySearch：POST JSON + Bearer 认证 + results 解析（空标题兜底、无 url 过滤）', async () => {
  setWebSearch({ provider: 'tavily', tavily: { apiKey: 'tvly-test', count: 3, searchDepth: 'advanced', timeoutMs: 15000 } });
  let captured = null;
  globalThis.fetch = async (url, opts = {}) => {
    captured = { url: String(url), method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ results: [
      { title: 'T1', url: 'https://a.example/x?utm=1', content: '内容A' },
      { title: '  ', url: 'https://b.example/', content: '内容B' },
      { url: 'https://c.example/' },
      { title: '无链接', content: 'x' }
    ] }) };
  };
  try {
    const { tavilySearch } = await import('../src/llm/web-search.js');
    const r = await tavilySearch('测试查询');
    assert.equal(captured.url, 'https://api.tavily.com/search');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers.authorization, 'Bearer tvly-test');
    assert.deepEqual(captured.body, { query: '测试查询', max_results: 3, search_depth: 'advanced' });
    assert.deepEqual(r.results, [
      { title: 'T1', url: 'https://a.example/x?utm=1', snippet: '内容A' },
      { title: '（无标题）', url: 'https://b.example/', snippet: '内容B' },
      { title: '（无标题）', url: 'https://c.example/', snippet: '' }
    ]);
  } finally { delete process.env.TAVILY_API_KEY; }
});

test('tavilySearch：count 夹到 ≤10；Key 回退环境变量 TAVILY_API_KEY', async () => {
  setWebSearch({ provider: 'tavily', tavily: { apiKey: 'tvly-test', count: 99 } });
  let captured = null;
  globalThis.fetch = async (url, opts = {}) => {
    captured = { headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ results: [] }) };
  };
  const { tavilySearch } = await import('../src/llm/web-search.js');
  // 空结果按"搜索失败"口径抛错（与其他 provider 一致），但请求体已经发出——夹取逻辑照样可验。
  await assert.rejects(() => tavilySearch('q'), /没有返回有效结果/);
  assert.equal(captured.body.max_results, 10);

  setWebSearch({ provider: 'tavily', tavily: { apiKey: '' } });
  process.env.TAVILY_API_KEY = 'env-key';
  try {
    globalThis.fetch = async (url, opts = {}) => {
      captured = { headers: opts.headers };
      return { ok: true, json: async () => ({ results: [{ title: 'a', url: 'https://e.example/' }] }) };
    };
    const { tavilySearch } = await import('../src/llm/web-search.js');
    await tavilySearch('q');
    assert.equal(captured.headers.authorization, 'Bearer env-key');
  } finally { delete process.env.TAVILY_API_KEY; }
});

test('tavilySearch：未配置 Key 明确报错；HTTP 错误带状态码与响应片段', async () => {
  setWebSearch({ provider: 'tavily', tavily: { apiKey: '' } });
  delete process.env.TAVILY_API_KEY;
  const { tavilySearch } = await import('../src/llm/web-search.js');
  await assert.rejects(() => tavilySearch('q'), /未配置 API Key/);

  setWebSearch({ provider: 'tavily', tavily: { apiKey: 'k' } });
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(() => tavilySearch('q'), /HTTP 429/);
});

test('aggregateSearch：单源失败不影响整体；URL 去重保留优先级高的源；每源条数截断', async () => {
  setWebSearch({
    provider: 'aggregate',
    aggregate: { sources: ['tavily', 'doubao', 'bing'], count: 2 },
    tavily: { apiKey: 'tvly-ag' },
    doubao: { apiKey: 'db-ag' }
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://cn.bing.com')) return { ok: true, text: async () => '<html>验证码</html>' };
    if (u.includes('tavily')) return { ok: true, json: async () => ({ results: [
      { title: '共同页', url: 'https://x.example/1', content: 'tavily版' },
      { title: 'T独有', url: 'https://x.example/2', content: 't2' },
      { title: 'T第三条', url: 'https://x.example/9', content: 't9' }
    ] }) };
    return { ok: true, json: async () => ({ Result: { WebResults: [
      { Title: '共同页', Url: 'https://x.example/1?utm_source=q', Summary: 'doubao版' },
      { Title: 'D独有', Url: 'https://x.example/3', Summary: 'd3' },
      { Title: 'D独有2', Url: 'https://x.example/4', Summary: 'd4' }
    ] } }) };
  };
  const { aggregateSearch } = await import('../src/llm/web-search.js');
  const r = await aggregateSearch('测试');
  assert.deepEqual(r.sources, ['tavily', 'doubao'], 'bing 命中验证页解析失败，不应影响整体');
  assert.deepEqual(r.failed, ['bing']);
  assert.deepEqual(r.results.map((x) => `${x.source}:${x.url}`), [
    'tavily:https://x.example/1',
    'tavily:https://x.example/2',
    'doubao:https://x.example/3'
  ], 'count=2 每源截 2 条；tracking 参数不影响同一 URL 去重并保留前面的源');
  assert.equal(r.results[0].snippet, 'tavily版', '重复 URL 保留优先级高的源的内容');
  assert.equal(r.results[0].source, 'tavily', '结果带 source 标注');
});

test('aggregateSearch：保留页面身份 query，只忽略 tracking 参数与普通锚点', async () => {
  setWebSearch({
    provider: 'aggregate',
    aggregate: { sources: ['tavily', 'doubao'], count: 6 },
    tavily: { apiKey: 'tvly-id' },
    doubao: { apiKey: 'db-id' }
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('tavily')) return { ok: true, json: async () => ({ results: [
      { title: 'ID one', url: 'https://x.example/article?id=one&utm_source=a', content: 'a' },
      { title: 'ID two', url: 'https://x.example/article?id=two', content: 'b' },
      { title: '已排序', url: 'https://x.example/article?a=1&b=2', content: 'ab1' },
      { title: 'SPA one', url: 'https://x.example/spa#/one', content: 's1' },
      { title: 'SPA two', url: 'https://x.example/spa#/two', content: 's2' },
      { title: '普通锚点', url: 'https://x.example/plain#first', content: 'plain' }
    ] }) };
    return { ok: true, json: async () => ({ Result: { WebResults: [
      { Title: 'ID one dup', Url: 'https://x.example/article?utm_source=b&id=one', Summary: 'a2' },
      { Title: '顺序不同', Url: 'https://x.example/article?b=2&a=1', Summary: 'ab2' },
      { Title: 'ID two dup', Url: 'https://x.example/article?id=two&fbclid=tracking', Summary: 'b2' },
      { Title: '普通锚点 dup', Url: 'https://x.example/plain#second', Summary: 'plain2' },
      { Title: 'ID three', Url: 'https://x.example/article?id=three', Summary: 'c' }
    ] } }) };
  };
  const { aggregateSearch } = await import('../src/llm/web-search.js');
  const r = await aggregateSearch('测试');
  assert.deepEqual(r.results.map((x) => `${x.source}:${x.url}`), [
    'tavily:https://x.example/article?id=one&utm_source=a',
    'tavily:https://x.example/article?id=two',
    'tavily:https://x.example/article?a=1&b=2',
    'tavily:https://x.example/spa#/one',
    'tavily:https://x.example/spa#/two',
    'tavily:https://x.example/plain#first',
    'doubao:https://x.example/article?id=three'
  ], '身份 query 与 SPA route 必须保留；tracking、参数顺序与普通锚点只影响去重键');
  assert.equal(r.results[0].title, 'ID one', '返回原 URL、标题与靠前来源');
});

test('aggregateSearch：非法或相对 URL 不抛错，仍按原字符串保守去重', async () => {
  setWebSearch({
    provider: 'aggregate',
    aggregate: { sources: ['tavily'], count: 4 },
    tavily: { apiKey: 'tvly-invalid' }
  });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [
    { title: '相对地址', url: 'relative/path', content: 'a' },
    { title: '相对地址重复', url: 'relative/path', content: 'b' },
    { title: '普通文本', url: 'not a url', content: 'c' }
  ] }) });
  const { aggregateSearch } = await import('../src/llm/web-search.js');
  const r = await aggregateSearch('测试');
  assert.deepEqual(r.results.map((x) => x.url), ['relative/path', 'not a url']);
});

test('aggregateSearch：同名参数顺序可能表示有序列表，不能交换后误合并', async () => {
  setWebSearch({
    provider: 'aggregate',
    aggregate: { sources: ['tavily'], count: 4 },
    tavily: { apiKey: 'tvly-repeat' }
  });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [
    { title: '重复参数一', url: 'https://x.example/list?tag=one&tag=two', content: 'a' },
    { title: '重复参数二', url: 'https://x.example/list?tag=two&tag=one', content: 'b' },
    { title: '不同参数一', url: 'https://x.example/dict?a=1&b=2', content: 'c' },
    { title: '不同参数二', url: 'https://x.example/dict?b=2&a=1', content: 'd' }
  ] }) });
  const { aggregateSearch } = await import('../src/llm/web-search.js');
  const r = await aggregateSearch('测试');
  assert.deepEqual(r.results.map((x) => x.url), [
    'https://x.example/list?tag=one&tag=two',
    'https://x.example/list?tag=two&tag=one',
    'https://x.example/dict?a=1&b=2'
  ]);
});

test('searchResultDedupeKey：tracking、hash 路由、参数顺序与坏 URL 的完整口径', async () => {
  const { searchResultDedupeKey: key } = await import('../src/llm/web-search.js');
  const same = [
    ['https://x.example/a?id=1&utm_source=1', 'https://x.example/a?id=1'],
    ['https://x.example/a?id=1&UTM_SOURCE=1', 'https://x.example/a?id=1'],
    ['https://x.example/a?id=1&fbclid=x', 'https://x.example/a?id=1'],
    ['https://x.example/a?id=1&gclid=x', 'https://x.example/a?id=1'],
    ['https://x.example/a?id=1&dclid=x', 'https://x.example/a?id=1'],
    ['https://x.example/a?id=1&mkt_tok=x', 'https://x.example/a?id=1'],
    ['https://x.example/a?id=1&_ga=x', 'https://x.example/a?id=1'],
    ['https://x.example/a?id=1&share_source=x', 'https://x.example/a?id=1'],
    ['https://x.example/a?b=2&a=1', 'https://x.example/a?a=1&b=2'],
    ['https://x.example/a?q=a+b', 'https://x.example/a?q=a%20b'],
    ['https://x.example/a#section', 'https://x.example/a'],
    ['https://x.example/a?utm_source=x#/route', 'https://x.example/a#/route']
  ];
  for (const [left, right] of same) {
    assert.equal(key(left), key(right), `${left} 应与 ${right} 去重`);
  }

  const different = [
    ['https://x.example/a?id=one', 'https://x.example/a?id=two'],
    ['https://x.example/a#/one', 'https://x.example/a#/two'],
    ['https://x.example/a#!/one', 'https://x.example/a#!/two'],
    ['https://x.example/a#!app=1', 'https://x.example/a#!app=2'],
    ['https://x.example/a#?page=1', 'https://x.example/a#?page=2'],
    ['https://x.example/a?tag=one&tag=two', 'https://x.example/a?tag=two&tag=one'],
    ['https://x.example/a?q=a%2Bb', 'https://x.example/a?q=a+b'],
    ['https://x.example/a', 'http://x.example/a'],
    ['https://x.example/a', 'https://x.example/a/'],
    ['relative/path', 'relative/other'],
    ['ftp://x.example/a?utm_source=1', 'ftp://x.example/a?utm_source=2']
  ];
  for (const [left, right] of different) {
    assert.notEqual(key(left), key(right), `${left} 不能与 ${right} 合并`);
  }
  assert.equal(key(''), '');
  assert.equal(key('relative/path'), 'relative/path');
});

test('aggregateSearch：全部源失败才报错，错误信息带各源原因', async () => {
  setWebSearch({ provider: 'aggregate', aggregate: { sources: ['doubao'], count: 4 }, doubao: { apiKey: '' } });
  const { aggregateSearch } = await import('../src/llm/web-search.js');
  await assert.rejects(
    () => aggregateSearch('q'),
    (e) => /全部源失败/.test(e.message) && /API Key/.test(e.message),
    '全失败的报错要能把各源原因带给模型'
  );
});

test('aggregateSearch：源数上限 4；未知源名只算该源失败，不炸全局', async () => {
  setWebSearch({
    provider: 'aggregate',
    aggregate: { sources: ['baidu', 'zhipu', 'bocha', 'metaso', 'tavily', 'doubao'], count: 3 },
    tavily: { apiKey: 'k' }
  });
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
  const { aggregateSearch } = await import('../src/llm/web-search.js');
  await assert.rejects(
    () => aggregateSearch('测试'),
    (e) => {
      assert.match(e.message, /全部源失败/);
      assert.match(e.message, /百度/);
      assert.doesNotMatch(e.message, /Tavily/, '第 5 个源应被 slice(0,4) 截掉，不应被请求');
      assert.doesNotMatch(e.message, /豆包/, '第 6 个源同理');
      return true;
    }
  );

  setWebSearch({ provider: 'aggregate', aggregate: { sources: ['tavily', 'no-such-src'], count: 2 }, tavily: { apiKey: 'k' } });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [{ title: 'a', url: 'https://y.example/' }] }) });
  const r = await aggregateSearch('测试');
  assert.deepEqual(r.failed, ['no-such-src']);
  assert.equal(r.results.length, 1);
});

test('webSearch：provider=aggregate 时走聚合分发，结果带 source', async () => {
  setWebSearch({ provider: 'aggregate', aggregate: { sources: ['tavily'], count: 2 }, tavily: { apiKey: 'k' } });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [{ title: 'a', url: 'https://z.example/', content: 'b' }] }) });
  const { webSearch } = await import('../src/llm/web-search.js');
  const r = await webSearch('测试');
  assert.equal(r.results[0].source, 'tavily');
});
