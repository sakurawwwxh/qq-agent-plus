// 2026-10-06 全项目复审（第 16 轮，6 路 code-reviewer）修复的行为用例。
// 每条都走真实链路断言行为，不锚源码文本；反向用例保证守卫不会变成"一律不放行"。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-review-2026-10-06-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ } });

const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig, getConfig } = await import('../src/core/config.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}
// 本机非回环 IPv4（用于模拟"远程攻击者"：连自己局域网地址时 remoteAddress 非回环）
const lanIp = (Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal) || {}).address || '';

function request(port, hostHeader, { method = 'GET', path: p, headers = {}, body = null, address = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: address, port, method, path: p, headers: { host: hostHeader, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
// SSE 拿到响应头就断线（事件流不会自己结束）
function sseProbe(port, address, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path: p, headers }, (res) => {
      resolve({ status: res.statusCode, contentType: String(res.headers['content-type'] || '') });
      res.destroy();
      req.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

// ── P2-1 / P3-5：console 暴露面（__replace__ 清令牌 / 查询串令牌收窄 / 本机判定改 remoteAddress）──
test('console：运行中绑非回环时拒绝 server 整节替换，令牌不落查询串，本机判定看 TCP 对端', async (t) => {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { host: '0.0.0.0', port, token: 'review-token-abcdefg' };
  cfg.runtime.mode = 'active';
  cfg.onebot = { ...cfg.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' };
  updateConfig(cfg);
  const { createApp } = await import('../src/console/app.js');
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const token = 'review-token-abcdefg';
  const auth = { 'x-console-token': token, 'content-type': 'application/json' };

  // a) 运行中（套接字绑 0.0.0.0）提交 server.__replace__ → 409，不落盘
  const rep = await request(port, `127.0.0.1:${port}`, {
    method: 'POST', path: '/api/config', headers: auth,
    body: JSON.stringify({ server: { __replace__: { host: '127.0.0.1', port } } })
  });
  assert.equal(rep.status, 409, `server.__replace__ 应被拒 409，实际 ${rep.status}：${rep.body.slice(0, 160)}`);

  // b) 查询串令牌收窄：普通端点 ?token= 不再放行；/api/events（EventSource 发不了头）保留
  const viaQuery = await request(port, `127.0.0.1:${port}`, { path: `/api/config?token=${encodeURIComponent(token)}` });
  assert.equal(viaQuery.status, 401, `普通端点不许再吃 ?token=，实际 ${viaQuery.status}`);
  const sse = await sseProbe(port, '127.0.0.1', `/api/events?token=${encodeURIComponent(token)}`, { host: `127.0.0.1:${port}` });
  assert.equal(sse.status, 200, '/api/events 的 ?token= 通道要保留');
  assert.match(sse.contentType, /text\/event-stream/);
  const viaHeader = await request(port, `127.0.0.1:${port}`, { path: '/api/config', headers: { 'x-console-token': token } });
  assert.equal(viaHeader.status, 200, '正常的头鉴权不受影响');

  // c) 本机判定：无令牌 + 伪造 Host: 127.0.0.1 的远程请求必须 401（旧实现只看 Host 头）
  const cfgNow = getConfig();
  setRuntimeConfig({ ...structuredClone(cfgNow), server: { ...cfgNow.server, token: '' } });
  const local = await request(port, `127.0.0.1:${port}`, { path: '/api/config' });
  assert.equal(local.status, 200, '真·本机（回环对端 + 回环 Host）访问不受影响');
  if (lanIp) {
    let reachable = true;
    try {
      const probe = await request(port, `127.0.0.1:${port}`, { path: '/healthz', address: lanIp });
      reachable = probe.status === 200;
    } catch { reachable = false; }
    if (reachable) {
      const spoof = await request(port, '127.0.0.1:9', { path: '/api/config', address: lanIp });
      assert.equal(spoof.status, 401, `伪造 Host 的远程请求必须 401，实际 ${spoof.status}`);
      const keySpoof = await request(port, '127.0.0.1:9', {
        path: '/api/onebot-key', address: lanIp, headers: { 'x-console-token': 'junk' }
      });
      assert.ok([401, 403].includes(keySpoof.status), `伪造 Host + 任意 x-console-token 不许读到明文密钥，实际 ${keySpoof.status}（401=authorize 先拦，403=key 守卫拦，都算挡住）`);
    } else {
      t.diagnostic('本机局域网地址不可达：远程伪造 Host / 非回环暴露面的安全回归今天没有被验证');
      t.skip('本机局域网地址不可达，跳过远程伪造用例');
    }
  } else {
    t.diagnostic('本机没有非回环 IPv4：远程伪造 Host / 非回环暴露面的安全回归今天没有被验证');
    t.skip('本机没有非回环 IPv4，跳过远程伪造用例');
  }
});

// ── P2-2：vision-scan 落盘失败只记日志，不把进程带崩 ──
test('vision-scan：config.json 写不进去时扫描照常完成、进程不崩', async (t) => {
  const { scanModelsVision } = await import('../src/llm/vision-scan.js');
  const cfgFile = path.join(root, 'config.json');
  // 用例自足：自己落一份 config.json，不依赖前面用例写过（单跑/过滤跑也必须能过）。
  setRuntimeConfig({ ...structuredClone(getConfig()), server: { ...getConfig().server, token: 'vision-tok-12345678' } });
  fs.writeFileSync(cfgFile, JSON.stringify(getConfig()), { mode: 0o600 });
  // 造"盘写不进去"必须跨平台确定：POSIX 下 rename 覆盖只读文件照样成功 —— chmod 造法在 Linux/CI
  // 上写盘其实完全成功，删掉 flushPending 的兜底也不会红（2026-10-07 复核 P1）。
  // 改为把 renameSync 打成 EPERM：两个平台都真的走失败分支，删兜底必然红。
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); };
  t.mock.method(fs, 'renameSync', eperm);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(
    { choices: [{ message: { content: '能看到' } }], usage: { total_tokens: 1 } }
  );
  t.after(() => { globalThis.fetch = originalFetch; });
  const emitted = [];
  const result = await scanModelsVision({
    providers: [{ id: 'p1', baseURL: 'https://p1.invalid/v1', apiKey: 'k', models: ['m1', 'm2'] }],
    emit: (kind, payload) => emitted.push({ kind, payload }),
    limit: 2,
    timeoutMs: 5000
  });
  assert.equal(result.total, 2, '扫描本身要跑完（落盘失败不许中断扫描/带崩进程）');
  assert.ok(
    emitted.some((e) => typeof e.payload?.error === 'string' && /结果落盘失败/.test(e.payload.error)),
    `必须上报落盘失败事件（否则这条修复完全不可观测），实际：${JSON.stringify(emitted.slice(0, 4))}`
  );
  assert.ok(fs.existsSync(cfgFile), '进程活着，文件还在');
});

test('vision-scan：扫描进行中的定时器那次落盘失败也被兜住（原始 P2 的形态）', async (t) => {
  const { scanModelsVision } = await import('../src/llm/vision-scan.js');
  const cfgFile = path.join(root, 'config.json');
  setRuntimeConfig({ ...structuredClone(getConfig()), server: { ...getConfig().server, token: 'vision-tok-12345678' } });
  fs.writeFileSync(cfgFile, JSON.stringify(getConfig()), { mode: 0o600 });
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EPERM: rename'), { code: 'EPERM' }); });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    // 第一个模型立刻返回（结果进 pending），第二个拖过 2 秒 —— 让"每 2 秒一拍"的定时器
    // 在扫描仍在进行时真的去落盘一次。这条定时器路径就是当初 P2 里"没有 .catch 兜底、
    // 裸抛会变成 uncaughtException 直接 process.exit(1)"的那个形态。
    if (calls === 2) await sleep(3200);
    return Response.json({ choices: [{ message: { content: '能看到' } }], usage: { total_tokens: 1 } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const emitted = [];
  const result = await scanModelsVision({
    providers: [{ id: 'p1', baseURL: 'https://p1.invalid/v1', apiKey: 'k', models: ['m1', 'm2'] }],
    emit: (kind, payload) => emitted.push({ kind, payload }),
    limit: 2,
    timeoutMs: 8000
  });
  assert.equal(result.total, 2, '定时器落盘失败不许中断扫描');
  assert.ok(
    emitted.some((e) => /结果落盘失败/.test(String(e.payload?.error || ''))),
    `定时器路径的落盘失败必须被兜住并上报，实际：${JSON.stringify(emitted.slice(0, 4))}`
  );
});

test('vision-scan：onlyModels 只探测指定模型（控制台按钮的成本上限）', async (t) => {
  const { scanModelsVision } = await import('../src/llm/vision-scan.js');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, req) => {
    calls.push(JSON.parse(req.body).model);
    return Response.json({ choices: [{ message: { content: '能看到' } }], usage: { total_tokens: 1 } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await scanModelsVision({
    providers: [{ id: 'p1', baseURL: 'https://p1.invalid/v1', apiKey: 'k', models: ['m1', 'm2', 'm3'] }],
    onlyModels: ['m2'],
    limit: 3,
    timeoutMs: 5000
  });
  assert.equal(result.total, 1);
  assert.deepEqual(calls, ['m2']);
});

// ── P2-6：replaceKnownFriends 尊重手工好友 override（双向）──
test('identity-store：快照刷新不清掉手工好友标记，override=0 也压得住好友列表', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'idstore-'));
  const { IdentityStore } = await import('../src/identity/identity-store.js');
  const store = new IdentityStore({ dataDir: dir });
  t.after(() => store.close());
  store.rebuild({ activityRows: [], legacyMemories: [], friends: [] });
  const flagOf = (uin) => {
    const row = store.listPeople(200).find((p) => String(p.userId ?? p.uin) === uin);
    return row == null ? null : Number(row.isFriend ?? row.is_friend);
  };

  store.upsertIdentityAsset({ userId: '10001', primaryName: '手工好友', chatKey: 'group:1', isFriend: true });
  store.replaceKnownFriends([], Date.now());   // 好友列表里没有这个人（快照刷新）
  assert.equal(flagOf('10001'), 1, '手工标记的好友不许被快照刷新清掉');

  store.upsertIdentityAsset({ userId: '10002', primaryName: '明确非好友', chatKey: 'group:1', isFriend: false });
  store.replaceKnownFriends([{ userId: '10002', nickname: '明确非好友' }], Date.now());
  assert.equal(flagOf('10002'), 0, 'override=0 要压过好友列表（与重建路径同口径）');

  store.replaceKnownFriends([{ userId: '10003', nickname: '普通好友' }], Date.now());
  assert.equal(flagOf('10003'), 1, '无 override 的好友照常按好友列表回填（守卫不许变成一律不改）');
});

// ── P3-2：waiting→aborted 的空跑会话不计 runs（双向）──
test('sessions：空跑会话不虚增当日 runs，真实运行照常计数', async (t) => {
  const { SessionRegistry } = await import('../src/core/sessions.js');
  const { todayKey } = await import('../src/core/util.js');
  const sessions = new SessionRegistry();
  t.after(() => sessions.close?.());
  const runsOf = () => Number(sessions.todayUsage(todayKey())?.runs) || 0;
  const before = runsOf();

  const s1 = sessions.create({ chatKey: 'group:601', trigger: [] });
  sessions.finish(s1.id, 'aborted');   // 预算 block/并发满这类早退：0 token、0 发送
  assert.equal(runsOf(), before, '空跑会话不许虚增当日 runs');

  const s2 = sessions.create({ chatKey: 'group:602', trigger: [] });
  s2.usage = { promptTokens: 30, completionTokens: 20, totalTokens: 50, cachedTokens: 0 };
  sessions.finish(s2.id, 'done');
  assert.equal(runsOf(), before + 1, '真实运行必须照常 +1（守卫不许变成一律不计）');

  // 非会话模型调用（记忆整理、群日报）也要入今日账：tokens 照记、runs 不计
  //（2026-10-07 复审 P3：此前整条链路对用量透明，控制台花费与预算判定都偏乐观）。
  const tokensOf = () => Number(sessions.todayUsage(todayKey())?.totalTokens) || 0;
  const tokensBefore = tokensOf();
  sessions.recordExternalUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300, cachedTokens: 0 }, { model: 'memory-model' });
  assert.equal(tokensOf(), tokensBefore + 300, '外部调用的 token 必须入账');
  assert.equal(runsOf(), before + 1, '外部调用不算一次会话运行（runs 不变）');
  sessions.recordExternalUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, {});
  assert.equal(tokensOf(), tokensBefore + 300, '0 token 的调用不产生任何变化');
});

// ── P3-4：发送失败路径的记账异常不掩盖真实错误、不丢 incident ──
test('sender：失败路径 finishSend 抛错时，原错误照抛、incident 照记', async (t) => {
  const { ChatStore } = await import('../src/core/store.js');
  const { SendQueue } = await import('../src/onebot/sender.js');
  // 发送闸要求 active 模式 + 会话在白名单（observe/paused 下 sendTextBatch 直接拒）
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['71'];
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: root, filename: `sender-${crypto.randomUUID()}.sqlite` });
  t.after(() => store.close());
  const incidents = [];
  const sender = new SendQueue({
    store,
    onebot: {
      sendText: async () => {
        throw Object.assign(new Error('Request timed out'), { cause: { code: 'ETIMEDOUT' } });
      }
    },
    onIncident: (error, info) => { incidents.push({ error, info }); return { id: 'inc-1' }; }
  });
  const finishCalls = [];
  store.finishSend = (id, patch) => { finishCalls.push(patch); throw new Error('SQLITE_BUSY: database is locked'); };

  // sendTextBatch 的口径：整批失败时抛"第N条「原文」：真实错误"（不是返回 failed 数组）。
  // 记账异常若不兜住，这里抛出来的就会是 SQLITE_BUSY 而不是真实传输错误。
  await assert.rejects(
    sender.sendTextBatch('group:71', ['你好'], { runId: 'run-71' }),
    /timed out/i,
    '调用方要拿到真实传输错误（记账异常不许改判/顶掉它）'
  );
  assert.equal(finishCalls.length, 1, '失败路径也要记账一次');
  // ETIMEDOUT 属 uncertain → 必须是 unknown。写成"failed 或 unknown 都行"等于对口径零约束
  //（2026-10-07 复核：把 classifyTransportFailure 改成一律 failed 也不会红）。
  assert.equal(finishCalls[0].outcome, 'unknown',
    `ETIMEDOUT = 可能已投递，必须 unknown；实际：${finishCalls[0]?.outcome}`);
  assert.equal(incidents.length, 1, 'incident 不能被记账异常顶掉');
});

// ── P3-3：兜底跨渠道时标记 channelChanged；vendorOfBaseUrl 与 vendorOfConfig 同口径 ──
test('llm：跨渠道兜底响应带 channelChanged/originBaseUrl，vendor 解析函数行为不变', async (t) => {
  const { chatCompletionWithRetry } = await import('../src/llm/llm.js');
  const { vendorOfBaseUrl, vendorOfConfig } = await import('../src/pricing/model-prices.js');

  assert.equal(vendorOfBaseUrl(
    { providers: [{ id: 'a', baseURL: 'https://api.a.com/v1', displayName: 'A渠道' }] },
    'https://api.a.com/v1/'
  ), 'A渠道', 'providers 按 baseURL 匹配到 displayName');
  assert.equal(vendorOfBaseUrl({}, 'https://api.b.com/v1'), 'api.b.com', '无匹配回落 URL host');
  assert.equal(vendorOfBaseUrl({}, ''), null);
  assert.equal(
    vendorOfConfig({ api: { baseUrl: 'https://api.b.com/v1' }, providers: [] }),
    'api.b.com',
    'vendorOfConfig 重构后行为不变'
  );

  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api = {
    ...cfg.api, model: 'main-model', baseUrl: 'https://primary.example/v1', apiKey: 'k1', timeoutMs: 3000,
    fallback: { enabled: true, model: 'fb-model', baseUrl: 'https://fallback.example/v1', apiKey: 'k2' }
  };
  setRuntimeConfig(cfg);
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('primary.example')) {
      return new Response('{"error":{"message":"Unauthorized"}}', { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } });
  };
  t.after(() => { globalThis.fetch = originalFetch; setRuntimeConfig(structuredClone(DEFAULT_CONFIG)); });

  const response = await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'hi' }] }, 0);
  assert.equal(response.viaFallback, true, '前提：确实走了兜底');
  assert.equal(response.channelChanged, true, '兜底端点与主渠道不同 host → 必须标记 channelChanged');
  assert.match(String(response.originBaseUrl), /fallback\.example/, 'originBaseUrl 指向实际端点');

  // 同渠道兜底（fallback.baseUrl 为空 → 沿用主渠道）不算换渠道：
  // 桩让主渠道只失败一次（瞬时故障），兜底重试同渠道成功 —— channelChanged 应为 false
  const cfg2 = structuredClone(DEFAULT_CONFIG);
  cfg2.api = {
    ...cfg2.api, model: 'main-model', baseUrl: 'https://primary.example/v1', apiKey: 'k1', timeoutMs: 3000,
    fallback: { enabled: true, model: 'fb2', baseUrl: '', apiKey: 'k1' }
  };
  setRuntimeConfig(cfg2);
  let primaryFails = 1;
  globalThis.fetch = async (url) => {
    if (String(url).includes('primary.example') && primaryFails > 0) {
      primaryFails -= 1;
      return new Response('{"error":{"message":"Unauthorized"}}', { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } });
  };
  const same = await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'hi' }] }, 0);
  assert.equal(same.viaFallback, true);
  assert.equal(same.channelChanged, false, '同渠道换模型的兜底不算换渠道');
});

// ── P2-7：get_login_info 首连失败要重试（NapCat 重启竞态不该让 selfId 恒空）──
test('onebot：get_login_info 连续失败后重试，selfId 最终拿到', async (t) => {
  const { OneBotClient } = await import('../src/onebot/onebot.js');
  let fails = 2;
  const seen = [];
  const httpServer = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();   // 消费请求体（不消费则 'end' 不触发、连接悬挂）
    req.on('end', () => {
      // 假服务端也要看看请求长什么样：路径/方法错了照样回 200 的话，
      // "URL 拼错""令牌退化成查询串"这类回归会被静默放过（2026-10-07 复核）。
      if (req.method !== 'POST' || req.url !== '/get_login_info') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (fails > 0) {
        fails -= 1;
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 12345, nickname: 'testbot' } }));
    });
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const httpPort = httpServer.address().port;
  const wsServer = new WebSocketServer({ port: 0 });
  await new Promise((r) => wsServer.on('listening', r));
  const wsPort = wsServer.address().port;
  const bot = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    httpUrl: `http://127.0.0.1:${httpPort}`,
    heartbeat: 'auto',
    heartbeatMs: 1000
  });
  t.after(async () => {
    bot.close();
    await new Promise((r) => wsServer.close(r));
    await new Promise((r) => httpServer.close(r));
  });
  await bot.connect();
  const ok = await waitFor(() => bot.selfId === '12345', 15000);
  assert.ok(ok, `get_login_info 失败后应重试并最终拿到 selfId，实际：'${bot.selfId}'（HTTP 失败 ${2 - fails} 次后成功）`);
  assert.ok(seen.length >= 3, `500 两次 + 成功一次，至少 3 个请求，实际 ${seen.length}`);
  // 建联成功后客户端还会补一次系统表情目录（fetch_sys_faces，2026-10-07 协议端能力升级）；
  // 假服务端对它回 404，属于预期内的失败（补缺失败静默）。这里只约束请求形态：
  // 两个路径都必须是 POST 且不带查询串（令牌走请求头）。
  // 它是**建联后的异步补缺**，不能在拿到 selfId 时假定它已经发出 —— 机器忙时会差一条请求的距离
  // （2026-10-07 全量并行跑时偶发过一次"只看到 get_login_info"）。先等它出现再断言形态。
  await waitFor(() => seen.includes('POST /fetch_sys_faces'), 5000);
  assert.deepEqual([...new Set(seen)].sort(), ['POST /fetch_sys_faces', 'POST /get_login_info'],
    `请求形态必须恰好是 POST /get_login_info（令牌走请求头，不许出现在查询串），实际：${seen.join(', ')}`);
});

// ── P2-3：#wake 准备段（runningChats.add 之后、主 try 之前）抛错 → 必须清理并可再次唤醒 ──
test('orchestrator：唤醒准备段异常后 runningChats 被清理，会话不再卡死到重启', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime = { ...cfg.runtime, mode: 'active' };
  cfg.api = { ...cfg.api, model: 'test-model', baseUrl: 'https://api.example/v1', apiKey: 'k' };
  cfg.allow.groups = ['1'];
  cfg.memory.consolidateEnabled = false;
  cfg.sticker.enabled = false;
  setRuntimeConfig(cfg);
  const { ChatStore } = await import('../src/core/store.js');
  const { SessionRegistry } = await import('../src/core/sessions.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const store = new ChatStore(0, { dataDir: root, filename: `wake-setup-${Math.random().toString(36).slice(2, 8)}.sqlite` });
  const sessions = new SessionRegistry();
  const memory = { formatForPrompt: () => '', formatHandoffForPrompt: () => '', getHandoff: () => null, setHandoff: () => null, clearHandoff: () => {} };
  const sender = {
    sendTextBatch: async (_chatKey, messages) => ({
      sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: []
    })
  };
  const runner = new Orchestrator({
    store, sessions, memory, stickers: {}, sender,
    onebot: { selfId: '888', selfNickname: 'bot', getGroupInfo: async () => ({ group_name: 'test' }) }
  });
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls += 1;
    return Response.json({ choices: [{ message: { content: '好的' } }], usage: { total_tokens: 4 } });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await runner.abortAll();
    sessions.close?.();
    store.close();
  });

  store.appendIncoming('group:1', { mid: 61, text: '第一条', senderId: '42', senderName: 'm42' });
  // 弄断准备段（runningChats.add 之后、主 try 之前）的必经同步步骤。
  // ⚠️ 注入点选 sessions.update：claimUnread（#wake 更早处）等前置也会碰 store 的读方法，
  // 注入在那里会让异常发生在 add 之前，用例就咬不住"add 之后无保护"这个窗口了；
  // sessions.update 在本流程里的首次调用就是准备段那次（add 之后、主 try 之前）。
  // 错误消息带 "timed out" → isRetryableError=true → 租约以可重试口径落回 pending
  const origSessionsUpdate = sessions.update.bind(sessions);
  let setupBroken = true;
  sessions.update = (...args) => {
    if (setupBroken) {
      setupBroken = false;
      throw new Error('Request timed out: database disk image is malformed');
    }
    return origSessionsUpdate(...args);
  };
  await assert.rejects(() => runner.wake('group:1'), /malformed/, '准备段异常要如实上抛');
  sessions.update = origSessionsUpdate;
  // failLease(retryable) 的 available_at=now+5s：等窗口过了消息才可再被领取
  await sleep(5300);
  // 关键断言：runningChats 已被清理 —— 下一次唤醒能正常跑模型。
  // 没有准备段兜底时，runningChats 永不清除，这里 wake 会静默 return、模型一次都不调。
  store.appendIncoming('group:1', { mid: 62, text: '第二条', senderId: '42', senderName: 'm42' });
  await runner.wake('group:1');
  assert.ok(modelCalls >= 1, `异常后会话必须能再次被唤醒（模型实际调用 ${modelCalls} 次）——卡死在 runningChats 这条就红`);
});
