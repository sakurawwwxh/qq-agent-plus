// 控制台「密钥控制」相关的两个端点/字段（2026-10-01）：
//  1) GET /api/onebot-key —— OneBot 的 WS / HTTP 令牌是"填过就看不见"的密钥
//     （/api/config 按字段名 accessToken/httpAccessToken 统一脱敏），控制台里
//     「显示」必须有一条受守卫的明文回读端点；
//  2) GET /api/status 带版本号 —— 控制台侧栏与控制页的版本徽标靠它（此前只显示提交号）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-console-keys-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

const PKG = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// 起一个控制台实例，返回 { port, get } —— get(path, headers) 走裸 http（便于伪造 Host）。
async function boot(t, token = '') {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token };
  cfg.runtime.mode = 'active';
  cfg.onebot = {
    ...cfg.onebot,
    wsUrl: 'ws://127.0.0.1:1',
    httpUrl: 'http://127.0.0.1:1',
    accessToken: 'ws-secret-abcdef',
    httpAccessToken: 'http-secret-ghijkl'
  };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  return { port, get };
}

function request(port, method, urlPath, { headers = {}, body = '' } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, body: parsed, headers: res.headers });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    if (body) req.setHeader('content-length', Buffer.byteLength(body));
    req.end(body);
  });
}

function get(port, urlPath, headers = {}) {
  return request(port, 'GET', urlPath, { headers });
}

test('GET /api/onebot-key 按 field 回读 WS / HTTP 令牌明文', async (t) => {
  const { port, get: fetchPath } = await boot(t);

  const ws = await fetchPath(port, '/api/onebot-key?field=ws', { host: `127.0.0.1:${port}` });
  assert.equal(ws.status, 200, ws.text);
  assert.equal(ws.body?.token, 'ws-secret-abcdef');

  const httpTok = await fetchPath(port, '/api/onebot-key?field=http', { host: `127.0.0.1:${port}` });
  assert.equal(httpTok.status, 200, httpTok.text);
  assert.equal(httpTok.body?.token, 'http-secret-ghijkl');

  // 没填过就是空串（不是 undefined）—— 前端据此把输入框留空
  updateConfig({ onebot: { ...DEFAULT_CONFIG.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: '' } });
  const empty = await fetchPath(port, '/api/onebot-key?field=ws', { host: `127.0.0.1:${port}` });
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.body?.token, '');
});

test('GET /api/onebot-key：未知字段 400；非本机来源读不到令牌', async (t) => {
  const { port, get: fetchPath } = await boot(t);

  const bad = await fetchPath(port, '/api/onebot-key?field=wss', { host: `127.0.0.1:${port}` });
  assert.equal(bad.status, 400, bad.text);
  assert.match(String(bad.body?.error || ''), /ws|http/);

  // 伪造一个非回环 Host、又不带令牌：正是"控制台暴露到公网且没设令牌"的场景 ——
  // 明文令牌绝不能让这种请求读到。鉴权层先拦（401 未授权），到不了端点。
  const evil = await fetchPath(port, '/api/onebot-key?field=ws', { host: 'evil.example.com' });
  assert.equal(evil.status, 401, evil.text);
  assert.equal(/ws-secret/.test(evil.text), false, '拒绝时不得泄漏令牌');

  // 守卫本身用源码断言锁住：这条路由必须声明 keyEndpoint（与 /api/api-key、
  // /api/search-key 同款）。合法配置下构造不出"该被 keyEndpoint 拒却放行"的请求 ——
  // 带令牌一律放行（令牌即完全管理凭据），不带令牌则先被鉴权层 401 挡掉，
  // 所以只能这样钉（与 test/imagegen-api.test.mjs 里那条同一约定）。
  const src = fs.readFileSync(path.resolve('src/console/app.js'), 'utf8');
  const at = src.indexOf("router.add('GET', '/api/onebot-key'");
  assert.ok(at > 0, '路由必须存在');
  assert.match(src.slice(at, at + 900), /keyEndpoint: true/, '必须走明文密钥端点的守卫');
});


test('设置 server.token 后，本机回环不能无令牌读取明文密钥', async (t) => {
  const { port, get: fetchPath } = await boot(t, 'localhost-token-123');
  const host = { host: `127.0.0.1:${port}` };
  const denied = await fetchPath(port, '/api/onebot-key?field=ws', host);
  assert.ok([401, 403].includes(denied.status), `无令牌应被拒绝，实际 ${denied.status}`);
  assert.equal(/ws-secret/.test(denied.text), false, '拒绝时不得泄漏令牌');

  const allowed = await fetchPath(port, '/api/onebot-key?field=ws', {
    ...host, 'x-console-token': 'localhost-token-123'
  });
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal(allowed.body?.token, 'ws-secret-abcdef');
});

test('POST /api/config：非法 JSON 返回 400 而不是 500', async (t) => {
  const { port } = await boot(t);
  const res = await request(port, 'POST', '/api/config', {
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: '{not-json'
  });
  assert.equal(res.status, 400, res.text);
  assert.match(String(res.body?.error || ''), /JSON/);
});

test('POST /api/config：英文校验错误也返回 400（不靠错误文案猜）', async (t) => {
  const { port } = await boot(t);
  const res = await request(port, 'POST', '/api/config', {
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ server: { port: 0 } })
  });
  assert.equal(res.status, 400, res.text);
  assert.match(String(res.body?.error || ''), /Invalid server port/);
});

test('静态资源 304 也带防点击劫持头（老缓存不会漏防护）', async (t) => {
  const { port } = await boot(t);
  const first = await request(port, 'GET', '/', { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(first.status, 200, first.text);
  const etag = first.headers?.etag;
  assert.ok(etag, 'HTML 响应应带 ETag');
  const second = await request(port, 'GET', '/', {
    headers: { host: `127.0.0.1:${port}`, 'if-none-match': etag }
  });
  assert.equal(second.status, 304, second.text);
  assert.equal(second.headers?.['x-frame-options'], 'DENY');
  assert.match(String(second.headers?.['content-security-policy'] || ''), /frame-ancestors 'none'/);
  assert.equal(second.headers?.['referrer-policy'], 'no-referrer');
});

test('POST /api/health/check 走同一份巡检并返回检查项', async (t) => {
  const { port } = await boot(t);
  const res = await request(port, 'POST', '/api/health/check', {
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(typeof res.body?.healthy, 'boolean');
  assert.ok(Array.isArray(res.body?.checks));
  assert.ok(res.body.checks.length > 0, '巡检至少要返回控制台/协议端等检查项');
});

test('GET /api/status 带版本号（控制台版本徽标的数据来源）', async (t) => {
  const { port, get: fetchPath } = await boot(t);
  const res = await fetchPath(port, '/api/status', { host: `127.0.0.1:${port}` });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body?.version, PKG.version, '版本号必须来自 package.json');
  assert.match(String(res.body?.version || ''), /^\d+\.\d+\.\d+/);
});

test('/api/config 仍然脱敏 OneBot 令牌（控制台不能从配置里白读明文）', async (t) => {
  const { port, get: fetchPath } = await boot(t);
  const res = await fetchPath(port, '/api/config', { host: `127.0.0.1:${port}` });
  assert.equal(res.status, 200, res.text);
  assert.equal(/ws-secret|http-secret/.test(res.text), false, '配置下发里不得出现令牌明文');
  assert.equal(res.body?.onebot?.hasAccessToken, true, '但要用 has* 标志告诉界面"存过没有"');
});
