// 拆出的六个域接口 smoke（knowledge/memes/mcp/living-memory/life-feed/skills）：
// 真 createApp + 真 HTTP + 真 token 鉴权，覆盖此前 0 条 HTTP 用例的域。
// 只打不依赖外网的端点；market 拉取用路由顺序静态断言兜底。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('拆出的六个域接口 smoke', async (t) => {
  const { base, request, app } = await bootConsole(t);

  await t.test('鉴权：无 token 的 /api/knowledge 返回 401', async () => {
    const res = await fetch(`${base}/api/knowledge`);
    assert.equal(res.status, 401);
  });

  await t.test('knowledge：GET 200；POST 缺文件名 400', async () => {
    const status = await request('GET', '/api/knowledge');
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(typeof status.body.enabled, 'boolean');

    const files = await request('GET', '/api/knowledge/files');
    assert.equal(files.status, 200);
    assert.ok(Array.isArray(files.body.files));

    const bad = await request('POST', '/api/knowledge/files', { content: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.ok, false);
  });

  await t.test('memes：GET 200；POST 缺字段 400；DELETE 不存在 404', async () => {
    const list = await request('GET', '/api/memes?chatKey=group:1');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.entries));

    const bad = await request('POST', '/api/memes', { chatKey: 'group:1' });
    assert.equal(bad.status, 400);

    const missing = await request('DELETE', '/api/memes', { id: 'no-such-meme' });
    assert.equal(missing.status, 404);
  });

  await t.test('mcp：GET /api/mcp 与 presets 200', async () => {
    const status = await request('GET', '/api/mcp');
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.ok(status.body.status);

    const presets = await request('GET', '/api/mcp/presets?query=fs');
    assert.equal(presets.status, 200);
    assert.ok(Array.isArray(presets.body.results));
  });

  await t.test('living-memory：status 200；缺 scope/query 400', async () => {
    const status = await request('GET', '/api/living-memory/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);

    const noScope = await request('GET', '/api/living-memory/memories');
    assert.equal(noScope.status, 400);

    const noQuery = await request('POST', '/api/living-memory/recall-test', { chatKey: 'group:1' });
    assert.equal(noQuery.status, 400);
  });

  await t.test('life-feed：status 200；forage/dismiss 缺 confirm/id 400', async () => {
    const status = await request('GET', '/api/life-feed/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);

    const forage = await request('POST', '/api/life-feed/forage', {});
    assert.equal(forage.status, 400);

    const dismiss = await request('POST', '/api/life-feed/dismiss', {});
    assert.equal(dismiss.status, 400);
  });

  await t.test('skills：GET 200；不存在 404；reload 200', async () => {
    const list = await request('GET', '/api/skills');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.skills));

    const missing = await request('GET', '/api/skills/no-such-skill');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.ok, false);

    const reload = await request('POST', '/api/skills/reload');
    assert.equal(reload.status, 200);
    assert.equal(reload.body.ok, true);
  });

  await t.test('knowledge：写入并删除一个文件', async () => {
    const created = await request('POST', '/api/knowledge/files', { name: 'smoke.md', content: 'hello' });
    assert.equal(created.status, 200);
    assert.equal(created.body.file?.name, 'smoke.md');
    const deleted = await request('DELETE', '/api/knowledge/files', { name: 'smoke.md' });
    assert.equal(deleted.status, 200);
  });

  await t.test('memes：写入后按 id 删除', async () => {
    const created = await request('POST', '/api/memes', { chatKey: 'group:1', term: 'smoke', meaning: '测试梗' });
    assert.equal(created.status, 200);
    const id = created.body.entry?.id;
    assert.ok(id, '创建要返回 id');
    const deleted = await request('DELETE', '/api/memes', { id });
    assert.equal(deleted.status, 200);
  });

  await t.test('skills：state 写入生效并可在列表读回', async () => {
    const state = await request('POST', '/api/skills/state', { enabled: true, enabledIds: [], perChat: {} });
    assert.equal(state.status, 200);
    assert.equal(state.body.enabled, true);
    const list = await request('GET', '/api/skills');
    assert.equal(list.status, 200);
    assert.equal(list.body.enabled, true);
    await request('POST', '/api/skills/state', { enabled: false, enabledIds: [], perChat: {} });
  });

  await t.test('mcp：reload 返回 200', async () => {
    const reload = await request('POST', '/api/mcp/reload');
    assert.equal(reload.status, 200);
    assert.equal(reload.body.ok, true);
  });

  await t.test('living-memory：graph 缺 scope 400', async () => {
    const graph = await request('GET', '/api/living-memory/graph');
    assert.equal(graph.status, 400);
  });

  await t.test('life-feed：share 的 chatKey 非法 400（不提前消费候选）', async () => {
    const share = await request('POST', '/api/life-feed/share', { confirm: true, chatKey: 'bad-key', bvid: 'x' });
    assert.equal(share.status, 400);
  });

  await t.test('路由顺序：/api/skills/market 必须早于 /api/skills/:id', () => {
    const routes = app.listRoutes();
    const market = routes.findIndex((r) => r.method === 'GET' && r.path === '/api/skills/market');
    const byId = routes.findIndex((r) => r.method === 'GET' && r.path === '/api/skills/:id');
    assert.ok(market >= 0 && byId >= 0, '两条路由都要存在');
    assert.ok(market < byId, `market 在 ${market}，:id 在 ${byId}；顺序反了会被 :id 抢先`);
  });

  await t.test('M2/M3 拆分域的只读接口 smoke', async (t2) => m2m3Smoke(t2, request));
});

async function m2m3Smoke(t, request) {

  const cases = [
    ['GET', '/api/providers', (b) => Array.isArray(b.providers)],
    ['GET', '/api/config', (b) => b && typeof b === 'object' && b.api && b.server],
    ['GET', '/api/backup/status', (b) => b.ok === true && typeof b.dir === 'string'],
    ['GET', '/api/sessions', (b) => Array.isArray(b.sessions)],
    ['GET', '/api/chats', (b) => Array.isArray(b.chats)],
    ['GET', '/api/status', (b) => b.usage && b.effects && typeof b.version === 'string'
      && typeof b.cost?.ledgerCost === 'number'],
    ['GET', '/api/storage', (b) => b.ok === true && Number.isInteger(b.files) && typeof b.keepFiles === 'number'],
    ['GET', '/api/usage/stats?range=7', (b) => b.ok === true && b.totals],
    ['GET', '/api/usage/breakdown?range=7', (b) => b.ok === true],
    ['GET', '/api/persona-templates', (b) => Array.isArray(b.templates) && b.templates.length > 0],
    ['GET', '/api/search-providers', (b) => Array.isArray(b.providers)],
    ['GET', '/api/memory-files', (b) => Array.isArray(b.files)],
    ['GET', '/api/assets/overview', (b) => b && typeof b === 'object'],
    ['GET', '/api/plugins', (b) => b && typeof b === 'object'],
    ['GET', '/api/plugins/pending-count', (b) => b.ok === true && Number.isInteger(b.count)],
    ['GET', '/api/group-policy', (b) => b.ok === true && Array.isArray(b.rows)],
    ['GET', '/api/tts/presets', (b) => b.ok === true && Array.isArray(b.services)],
    ['GET', '/api/platform/gates', (b) => Array.isArray(b.gates)],
    ['GET', '/api/incidents', (b) => b && Array.isArray(b.incidents)],
    ['GET', '/api/auto-update/status', (b) => b && typeof b === 'object'],
    ['GET', '/api/models/search-providers', () => true] // 不存在：只看下面的 404 口径
  ];

  for (const [method, route, check] of cases) {
    const res = await request(method, route);
    if (route === '/api/models/search-providers') {
      assert.equal(res.status, 404, `${route} 应 404`);
      continue;
    }
    assert.equal(res.status, 200, `${route} → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    assert.ok(check(res.body), `${route} 响应形状不符：${JSON.stringify(res.body).slice(0, 300)}`);
  }

  // 压缩接口也走一次真实 HTTP：没有会话时应当是幂等成功，不是 500。
  const compress = await request('POST', '/api/storage/compress');
  assert.equal(compress.status, 200, JSON.stringify(compress.body).slice(0, 300));
  assert.equal(compress.body.ok, true);

  // 明文密钥不得出现在配置响应里（本次拆分后 config 路由最容易把脱敏链搬丢）
  const config = await request('GET', '/api/config');
  const apiKey = config.body.api?.apiKey;
  assert.ok(apiKey === undefined || apiKey === '', 'api.apiKey 必须删除或置空');
  assert.equal(JSON.stringify(config.body).includes('"apiKey":"sk-'), false, '响应里不应有 sk- 明文');
}
