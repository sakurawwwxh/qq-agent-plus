// 五个搜索 provider 的**契约测试**（zhipu / bocha / baidu / deepseek / bing）。
//
// 为什么补这一组：issue #38 的秘塔 bug（地址 + 请求体 + 响应路径三处都错）之所以能潜伏到用户
// 报障，是因为它**一条用例都没有** —— 而 tavily / doubao 有契约测试，所以它们的形状一直是对的。
// 这里按同一口径把剩下的补齐：地址、请求体字段名与类型、响应路径、以及"200 里带错误码"的形态
// （zhipu 401、bocha code≠200、qianfan code/error_code、bing 命中验证页）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-contracts-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
for (const key of ['ZHIPU_API_KEY', 'BOCHA_API_KEY', 'BAIDU_SEARCH_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[key];
// 端口避开 Linux/Windows 临时端口段，和别的 web-search 用例并行不冲突
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ server: { port: 22501, host: '127.0.0.1' } }));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { zhipuSearch, bochaSearch, baiduSearch, deepSeekSearch, bingSearch, so360Search, sogouSearch, bilibiliSearch } = await import('../src/llm/web-search.js');

const setWebSearch = (patch) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, ...patch };
  updateConfig(cfg);
};
const stub = (responder) => {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    return responder(calls.length, calls[calls.length - 1]);
  };
  return calls;
};

test('智谱：{search_engine, search_query, count} → search_result[]（title/link/content）', async () => {
  setWebSearch({ provider: 'zhipu', zhipu: { apiKey: 'zk', engine: 'search_pro', count: 12 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ search_result: [
      { title: 'T', link: 'https://a.example/', content: '摘要' },
      { title: '', link: 'https://b.example/', content: '' }
    ] })
  }));
  const r = await zhipuSearch('q');
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  assert.equal(calls[0].headers.authorization, 'Bearer zk');
  assert.deepEqual(calls[0].body, { search_engine: 'search_pro', search_query: 'q', count: 12 });
  assert.equal(r.results[0].title, 'T');
  assert.equal(r.results[0].url, 'https://a.example/');
  assert.equal(r.results[0].snippet, '摘要');
  assert.equal(r.results[1].title, '（无标题）', '空标题要兜底');
});

test('博查：{query, count, freshness, summary} → data.webPages.value[]（name/url/snippet）', async () => {
  setWebSearch({ provider: 'bocha', bocha: { apiKey: 'bk', count: 5 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ code: 200, data: { webPages: { value: [
      { name: '标题', url: 'https://a.example/', snippet: '摘' },
      { name: '只有 summary', url: 'https://b.example/', summary: '摘要兜底' },
      { name: '无链接' }
    ] } } })
  }));
  const r = await bochaSearch('q');
  assert.equal(calls[0].url, 'https://api.bochaai.com/v1/web-search');
  assert.deepEqual(calls[0].body, { query: 'q', count: 5, freshness: 'noLimit', summary: false });
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.example/', 'https://b.example/'], '无 url 的丢掉');
  assert.equal(r.results[1].snippet, '摘要兜底');

  // code≠200 是错误（HTTP 仍是 200）
  stub(() => ({ ok: true, json: async () => ({ code: 403, message: '额度用完' }) }));
  await assert.rejects(() => bochaSearch('q'), /额度用完/);
});

test('百度千帆：{messages, search_source, resource_type_filter} → references[]；code/error_code 两种错误字段都认', async () => {
  setWebSearch({ provider: 'baidu', baidu: { apiKey: 'bak', count: 8 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ references: [{ title: 'T', url: 'https://a.example/', content: '内容' }] })
  }));
  const r = await baiduSearch('q');
  assert.equal(calls[0].url, 'https://qianfan.baidubce.com/v2/ai_search/web_search');
  assert.equal(calls[0].headers.authorization, 'Bearer bak');
  assert.deepEqual(calls[0].body, {
    messages: [{ role: 'user', content: 'q' }],
    search_source: 'baidu_search_v2',
    resource_type_filter: [{ type: 'web', top_k: 8 }]
  });
  assert.equal(r.results[0].snippet, '内容');

  stub(() => ({ ok: true, json: async () => ({ code: 216003, message: '鉴权失败' }) }));
  await assert.rejects(() => baiduSearch('q'), /216003/);
  stub(() => ({ ok: true, json: async () => ({ error_code: 17, error_msg: '日额度超限' }) }));
  await assert.rejects(() => baiduSearch('q'), /17/);
});

test('DeepSeek：Search API → 结构化 results；404 时回退旧 Responses 文本', async () => {
  setWebSearch({ provider: 'deepseek', deepseek: { apiKey: 'dk', model: 'deepseek-v4-flash', count: 3 } });
  const calls = stub(() => ({ ok: true, json: async () => ({
    results: [{ title: '标题', url: 'https://example.com', summary: '摘要' }]
  }) }));
  const r = await deepSeekSearch('q');
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0].headers.authorization, 'Bearer dk');
  assert.equal(calls[0].body.query, 'q');
  assert.equal(calls[0].body.count, 3);
  assert.equal(calls[0].body.need_content, false);
  assert.equal(r.results[0].snippet, '摘要');

  // 老账号没有 /v1/tools/search：404 后回退旧 Responses（仍兼容 output[].content[]）
  let n = 0;
  const fallback = stub(() => {
    n += 1;
    if (n === 1) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ text: '分块' }, { text: '文本' }] }] }) };
  });
  const alt = await deepSeekSearch('q');
  assert.match(fallback[1].url, /\/responses$/);
  assert.equal(alt.results[0].snippet, '分块文本', 'output[].content[].text 拼接');
});

test('Bing：优先解析 RSS，保留 CDATA、实体和 maxResults', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 2 });
  const rss = '<?xml version="1.0"?><rss><channel>'
    + '<item><title>标题 A &amp; 说明</title><link>https://a.example/?x=1&amp;y=2</link>'
    + '<description><![CDATA[<b>摘要 A</b> &amp; 内容]]></description></item>'
    + '<item><title>无链接</title><description>应跳过</description></item>'
    + '<item><title>标题 B</title><link>https://b.example/</link><description>摘要 B</description></item>'
    + '<item><title>标题 C</title><link>https://c.example/</link><description>摘要 C</description></item>'
    + '</channel></rss>';
  const calls = stub(() => ({ ok: true, text: async () => rss }));
  const r = await bingSearch('测试');
  assert.equal(calls.length, 1, 'RSS 有结果时不应再请求 HTML');
  const requested = new URL(calls[0].url);
  assert.equal(requested.searchParams.get('q'), '测试');
  assert.equal(requested.searchParams.get('format'), 'rss');
  assert.deepEqual(r.results, [
    { title: '标题 A & 说明', url: 'https://a.example/?x=1&y=2', snippet: '摘要 A & 内容' },
    { title: '标题 B', url: 'https://b.example/', snippet: '摘要 B' }
  ]);
});

test('Bing：RSS 为空或请求失败时回退原 HTML 解析', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 3 });
  const html = '<ol><li class="b_algo"><h2><a href="https://a.example/">标题 A</a></h2><p>摘要 A</p></li>'
    + '<li class="b_algo"><h2><a href="https://b.example/">标题 B</a></h2><p>摘要 B</p></li>'
    + '<li class="b_algo"><h2><a href="https://c.example/">标题 C</a></h2><p>摘要 C</p></li>'
    + '<li class="b_algo"><h2><a href="https://d.example/">标题 D</a></h2><p>摘要 D</p></li></ol>';

  const emptyCalls = [];
  globalThis.fetch = async (url) => {
    emptyCalls.push(String(url));
    return { ok: true, text: async () => (new URL(url).searchParams.get('format') === 'rss'
      ? '<rss><channel></channel></rss>' : html) };
  };
  const emptyRss = await bingSearch('测试');
  assert.equal(emptyCalls.length, 2, 'RSS 空结果后要再请求 HTML');
  assert.equal(new URL(emptyCalls[0]).searchParams.get('format'), 'rss');
  assert.equal(new URL(emptyCalls[1]).searchParams.get('format'), null);
  assert.deepEqual(emptyRss.results.map((x) => x.url), ['https://a.example/', 'https://b.example/', 'https://c.example/']);

  const failedCalls = [];
  globalThis.fetch = async (url) => {
    failedCalls.push(String(url));
    if (new URL(url).searchParams.get('format') === 'rss') return { ok: false, status: 503 };
    return { ok: true, text: async () => html };
  };
  const failedRss = await bingSearch('测试');
  assert.equal(failedCalls.length, 2, 'RSS HTTP 失败后要再请求 HTML');
  assert.equal(failedRss.results.length, 3);

  const brokenCalls = [];
  globalThis.fetch = async (url) => {
    brokenCalls.push(String(url));
    return { ok: true, text: async () => (new URL(url).searchParams.get('format') === 'rss'
      ? '<rss><channel><item><title>未闭合' : html) };
  };
  const brokenRss = await bingSearch('测试');
  assert.equal(brokenCalls.length, 2, 'RSS 格式损坏后要再请求 HTML');
  assert.equal(brokenRss.results.length, 3);
});

test('Bing：RSS 与 HTML 均命中验证页时仍明确报错', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 3 });
  const calls = stub(() => ({ ok: true, text: async () => '<html><body>请完成验证</body></html>' }));
  await assert.rejects(() => bingSearch('x'), /没有返回可解析的结果/);
  assert.equal(calls.length, 2);
});

test('Bing：非 Bing 自定义 searchUrl 不改请求，继续只走 HTML', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://search.example.test/search', maxResults: 2 });
  const html = '<ol><li class="b_algo"><h2><a href="https://a.example/">标题 A</a></h2><p>摘要 A</p></li></ol>';
  const calls = stub(() => ({ ok: true, text: async () => html }));
  const r = await bingSearch('测试');
  assert.equal(calls.length, 1);
  const requested = new URL(calls[0].url);
  assert.equal(requested.searchParams.get('q'), '测试');
  assert.equal(requested.searchParams.get('format'), null);
  assert.equal(r.results[0].url, 'https://a.example/');

  stub(() => ({ ok: true, text: async () => '<html><body>请完成验证</body></html>' }));
  await assert.rejects(() => bingSearch('x'), /没有返回可解析的结果/);
});

test('搜狗：取 vrwrap 里的 data-url 真实外链；没有真实地址的跳转跳过；空结果抛错', async () => {
  setWebSearch({ provider: 'sogou', maxResults: 3 });
  const html = '<div class="vrwrap" id="sogou_vr_1"><h3 class="vr-title">'
    + '<a href="/link?url=x" target="_blank">扎啤 是什么梗 - <em>抖音</em></a></h3>'
    + '<div class="fz-mid" id="cacheresult_summary_1">扎啤 是最近抖音上的新梗</div>'
    + '<div class="r-sech" data-url="https://www.douyin.com/shipin/7460674349780060198"></div></div>'
    + '<div class="vrwrap"><h3 class="vr-title"><a href="/link?url=y">没有真实地址的结果</a></h3></div>'
    + '<div class="vrwrap"><h3 class="vr-title"><a href="/link?url=z">站内导航</a></h3>'
    + '<div data-url="https://www.sogou.com/link?url=nav"></div></div>';
  const calls = stub(() => ({ ok: true, text: async () => html }));
  const r = await sogouSearch('扎啤 抖音 什么梗');
  assert.match(calls[0].url, /^https:\/\/www\.sogou\.com\/web\?query=/);
  assert.equal(r.results.length, 1, '只保留有 data-url 真实外链的结果');
  assert.equal(r.results[0].url, 'https://www.douyin.com/shipin/7460674349780060198');
  assert.equal(r.results[0].title, '扎啤 是什么梗 - 抖音');
  assert.match(r.results[0].snippet, /抖音上的新梗/);

  stub(() => ({ ok: true, text: async () => '<html><body>请输入验证码</body></html>' }));
  await assert.rejects(() => sogouSearch('x'), /没有返回可解析的结果/);
});

test('B 站：视频搜索 JSON → 标题/简介/真实视频地址；code≠0 与空结果都报错', async () => {
  setWebSearch({ provider: 'bilibili', maxResults: 3 });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: { result: [
        { title: '【梗知识】<em>扎啤</em>', description: '扎啤是测试中约定的含义', arcurl: '//www.bilibili.com/video/BV1xx', bvid: 'BV1xx' },
        { title: '只有 bvid', description: '', bvid: 'BV2yy' },
        { title: '', bvid: 'BV3zz' }
      ] }
    })
  }));
  const r = await bilibiliSearch('扎啤 梗');
  const searchCall = calls.find((c) => String(c.url).includes('/wbi/search/type'));
  assert.ok(searchCall, '必须打到 B 站搜索接口');
  assert.match(searchCall.url, /search_type=video/);
  assert.match(searchCall.url, /keyword=%E6%89%8E%E5%95%A4/);
  assert.equal(searchCall.headers.referer, 'https://www.bilibili.com/');
  assert.deepEqual(r.results.map((x) => x.url), [
    'https://www.bilibili.com/video/BV1xx',
    'https://www.bilibili.com/video/BV2yy'
  ]);
  assert.match(r.results[0].title, /【梗知识】\s*扎啤/);
  assert.match(r.results[0].snippet, /测试中约定/);

  stub(() => ({ ok: true, json: async () => ({ code: -412, message: '请求被拦截' }) }));
  await assert.rejects(() => bilibiliSearch('x'), /-412/);
  stub(() => ({ ok: true, json: async () => ({ code: 0, data: { result: [] } }) }));
  await assert.rejects(() => bilibiliSearch('x'), /没有返回可解析的结果/);
});

test('B 站 wbi：拿到 nav key 时搜索请求带 wts 与 w_rid 签名', async () => {
  setWebSearch({ provider: 'bilibili' });
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/x/web-interface/nav')) {
      return {
        ok: true,
        json: async () => ({ code: -101, data: { wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
        } } })
      };
    }
    return {
      ok: true,
      json: async () => ({ code: 0, data: { result: [{ title: '梗', description: '', bvid: 'BV1' }] } })
    };
  };
  const r = await bilibiliSearch('扎啤 梗');
  assert.equal(r.results[0].url, 'https://www.bilibili.com/video/BV1');
  const searchUrl = calls.find((u) => u.includes('/wbi/search/type'));
  assert.match(searchUrl, /[?&]wts=\d+/);
  assert.match(searchUrl, /[?&]w_rid=[a-f0-9]{32}/);
});

test('B 站标题和 Bing 站内解释会合并：不能只给模型一堆没正文的标题', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 6 });
  const bingGeneric = '<ol><li class="b_algo"><h2><a href="https://www.douyin.com/">抖音</a></h2><p>抖音</p></li></ol>';
  const bili = { code: 0, data: { result: [
    { title: '扎啤 是什么梗？【梗学堂】', description: '素材来源于网络', bvid: 'BV1meme' }
  ] } };
  const targeted = '<ol><li class="b_algo"><h2><a href="https://www.douyin.com/video/123">扎啤梗在网络啥意思 - 抖音</a></h2><p>扎啤是测试中约定的含义</p></li></ol>';
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
    if (u.includes('sogou.com')) return { ok: true, text: async () => '<html>验证码</html>' };
    if (u.includes('/x/web-interface/nav')) return { ok: true, json: async () => ({ code: 0, data: {} }) };
    if (u.includes('/wbi/search/type')) return { ok: true, json: async () => bili };
    if (u.includes('site:douyin.com')) return { ok: true, text: async () => targeted };
    return { ok: true, text: async () => bingGeneric };
  };
  const { webSearch } = await import('../src/llm/web-search.js');
  const result = await webSearch('扎啤 梗 什么意思');
  assert.ok(result.results.some((x) => x.url.includes('bilibili.com/video/BV1meme')), 'B 站标题要合并进结果');
  assert.ok(result.results.some((x) => /测试中约定的含义/.test(x.snippet || '')), 'Bing 的解释摘要也要合并');
  assert.ok(result.sources.includes('bilibili') && result.sources.includes('bing'));
});

test('meme=true 强制走梗补充：即使 Bing 已覆盖字面词，也会补 B 站/站内解释', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 6 });
  const primary = '<ol><li class="b_algo"><h2><a href="https://baike.baidu.com/item/%E6%89%8E%E5%95%A4">扎啤_百度百科</a></h2><p>扎啤是生啤</p></li></ol>';
  const bili = { code: 0, data: { result: [
    { title: '扎啤 是什么梗？【梗学堂】', description: '梗科普', bvid: 'BV1meme' }
  ] } };
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
    if (u.includes('sogou.com')) return { ok: true, text: async () => '<html>验证码</html>' };
    if (u.includes('/x/web-interface/nav')) return { ok: true, json: async () => ({ code: 0, data: {} }) };
    if (u.includes('/wbi/search/type')) return { ok: true, json: async () => bili };
    if (u.includes('site:douyin.com')) return { ok: true, text: async () => '<html></html>' };
    return { ok: true, text: async () => primary };
  };
  const { webSearch } = await import('../src/llm/web-search.js');
  const bare = await webSearch('扎啤');
  assert.ok(bare.sources.includes('bilibili'), '裸词短词也会自动补梗，不必等模型加 meme=true');
  const result = await webSearch('扎啤', { meme: true });
  assert.ok(result.sources.includes('bilibili'), 'meme=true 必须触发梗补充');
  assert.ok(result.results.some((x) => x.url.includes('BV1meme')), '应带回 B 站梗解释');
});

test('B 站只有活动视频、没有梗解释时，不让它抢先，退给 Bing 站内解释', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 6 });
  const bingGeneric = '<ol><li class="b_algo"><h2><a href="https://www.douyin.com/">抖音</a></h2><p>抖音</p></li></ol>';
  const biliOnlyEvent = { code: 0, data: { result: [
    { title: '奶绿波 旗袍雅韵专场', description: '', bvid: 'BV1event' }
  ] } };
  const targeted = '<ol><li class="b_algo"><h2><a href="https://baike.baidu.com/item/%E5%A5%B6%E7%BB%BF%E6%B3%A2">奶绿波</a></h2><p>春运广告牌误读带火的梗</p></li></ol>';
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
    if (u.includes('/x/web-interface/nav')) return { ok: true, json: async () => ({ code: 0, data: {} }) };
    if (u.includes('/wbi/search/type')) return { ok: true, json: async () => biliOnlyEvent };
    if (u.includes('site:douyin.com')) return { ok: true, text: async () => targeted };
    return { ok: true, text: async () => bingGeneric };
  };
  const { webSearch } = await import('../src/llm/web-search.js');
  const result = await webSearch('奶绿波 什么意思');
  assert.ok(result.results.some((x) => x.url.includes('baike.baidu.com/item/%E5%A5%B6%E7%BB%BF%E6%B3%A2')), '应改用 Bing 站内限定拿解释页');
  assert.deepEqual(result.sources, ['bing']);
});

test('360：解析 data-mdurl 真实外链；跳过站内导航；空结果抛错', async () => {
  setWebSearch({ provider: 'so360', maxResults: 3 });
  const html = '<ul>'
    + '<li class="res-list" data-result-type="richsum"><h3 class="res-title">'
    + '<a href="https://www.so.com/link?m=x" data-mdurl="https://www.douyin.com/video/123?from=360box" target="_blank">奶绿波 原视频</a></h3>'
    + '<div><span class="res-list-summary" data-result-summary>奶绿波 是 2026 年春运广告牌误读带火的梗</span></div></li>'
    + '<li class="res-list"><h3 class="res-title">'
    + '<a href="https://www.so.com/link?m=y" data-mdurl="https://post.smzdm.com/p/anvw3xv2/" target="_blank">古井贡酒 <em>奶绿波</em></a></h3></li>'
    + '<li class="res-list"><h3 class="res-title">'
    + '<a href="https://www.so.com/link?m=z" data-mdurl="https://www.so.com/link?m=nav" target="_blank">站内导航</a></h3></li>'
    + '</ul>';
  const calls = stub(() => ({ ok: true, text: async () => html }));
  const r = await so360Search('奶绿波 什么意思');
  assert.match(calls[0].url, /^https:\/\/www\.so\.com\/s\?q=/);
  assert.deepEqual(r.results.map((x) => x.url), [
    'https://www.douyin.com/video/123?from=360box',
    'https://post.smzdm.com/p/anvw3xv2/'
  ], '保留抖音/解释文章，跳过 so.com 站内链接');
  assert.equal(r.results[0].title, '奶绿波 原视频');
  assert.match(r.results[0].snippet, /春运广告牌/);

  stub(() => ({ ok: true, text: async () => '<html><body>安全验证</body></html>' }));
  await assert.rejects(() => so360Search('x'), /没有返回可解析的结果/);
});

test('Bing 对梗查询结果太差时自动补搜狗，并把抖音结果排在前面', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 6 });
  const bingHtml = '<ol><li class="b_algo"><h2><a href="https://www.douyin.com/">抖音</a></h2><p>抖音 - 记录美好生活</p></li>'
    + '<li class="b_algo"><h2><a href="https://baike.baidu.com/item/%E5%A5%B6">奶</a></h2><p>奶的字义</p></li></ol>';
  const sogouHtml = '<div class="vrwrap"><h3 class="vr-title">'
    + '<a href="/link?url=x" target="_blank">奶绿波 原视频</a></h3>'
    + '<div class="fz-mid" id="cacheresult_summary_1">奶绿波 是春运广告牌误读带火的梗</div>'
    + '<div class="r-sech" data-url="https://www.douyin.com/video/7619643383979831013"></div></div>';
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    return {
      ok: true,
      text: async () => (u.includes('bing.com') ? bingHtml : sogouHtml)
    };
  };
  const { webSearch } = await import('../src/llm/web-search.js');
  const result = await webSearch('奶绿波 什么意思');
  assert.equal(calls.length, 3, 'Bing RSS + Bing HTML + 搜狗各一次');
  assert.equal(new URL(calls[0]).searchParams.get('format'), 'rss');
  assert.equal(new URL(calls[1]).searchParams.get('format'), null);
  assert.equal(result.results[0].url, 'https://www.douyin.com/video/7619643383979831013', '抖音结果前置');
  assert.deepEqual(result.sources, ['sogou'], 'Bing 只返回抖音首页壳子时不应算进来源');
  assert.ok(!result.results.some((x) => x.url === 'https://www.douyin.com/'), '字面/壳子结果要被过滤');
});

test('搜狗/360 都被风控时，用 Bing 站内限定核心词兜底', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 6 });
  const genericBing = '<ol><li class="b_algo"><h2><a href="https://www.douyin.com/">抖音</a></h2><p>抖音</p></li></ol>';
  const targetedBing = '<ol><li class="b_algo"><h2><a href="https://baike.baidu.com/item/%E5%A5%B6%E7%BB%BF%E6%B3%A2">奶绿波</a></h2><p>春运广告牌误读带火的梗</p></li></ol>';
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('sogou.com') || u.includes('so.com')) {
      return { ok: true, text: async () => '<html>请输入验证码</html>' };
    }
    return { ok: true, text: async () => (decodeURIComponent(u).includes('site:douyin.com') ? targetedBing : genericBing) };
  };
  const { webSearch } = await import('../src/llm/web-search.js');
  const result = await webSearch('奶绿波 什么意思');
  assert.ok(calls.some((u) => {
    const decoded = decodeURIComponent(u).replace(/\+/g, ' ');
    return decoded.includes('site:douyin.com 奶绿波');
  }), `应发出站内限定查询：${JSON.stringify(calls)}`);
  assert.ok(result.results.some((x) => x.url.includes('baike.baidu.com')), '应带回解释页');
  assert.deepEqual(result.sources, ['bing'], '两个 Bing 查询合并后来源不重复');
});

test('Tavily：provider=tavily 真的走 Tavily（此前静默退回 Bing）', async () => {
  // 设置页把 Tavily 列为可选、Key 也有独立入口；dispatch 漏了它时 webSearch 会一路落到
  // Bing，用户以为在用自己的 Key，实际没有（2026-10-17 审查 P2）
  setWebSearch({ provider: 'tavily', tavily: { apiKey: 'tv-key', count: 3 } });
  const calls = stub(() => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [{ title: '结果', url: 'https://example.com/a', content: '摘要' }] })
  }));
  const { webSearch } = await import('../src/llm/web-search.js');
  const result = await webSearch('测试查询');
  assert.match(calls[0].url, /api\.tavily\.com\/search/, '必须打到 Tavily，而不是 Bing');
  assert.equal(calls[0].headers.authorization, 'Bearer tv-key', 'Key 要带上');
  assert.deepEqual(result.results, [{ title: '结果', url: 'https://example.com/a', snippet: '摘要' }]);
});
