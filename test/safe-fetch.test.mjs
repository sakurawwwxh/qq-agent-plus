import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 用例自己造临时数据目录：**不许**碰仓库里的 data/（那里可能是真配置，含 Key）。
// 注意 ESM 的静态 import 会先于文件体执行，所以 src 模块必须用动态 import 放在这之后。
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-safe-fetch-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });

// pinned.test 只在本测试进程里解析到 127.0.0.1：用来证明 HTTP/2 连接用的是
// resolveSafeHost 校验过的 IP，而不是把域名交给 http2.connect 再解析一次。
const realDnsLookup = dns.promises.lookup;
dns.promises.lookup = async (hostname, options) => (
  hostname === 'pinned.test'
    ? [{ address: '127.0.0.1', family: 4 }]
    : hostname === 'fake-ip.test'
      ? [{ address: '198.18.0.5', family: 4 }]
      : hostname === 'fake-ip6.test'
        ? [{ address: 'fc00::5', family: 6 }]
        : hostname === 'private.test'
          ? [{ address: '10.0.0.8', family: 4 }]
          : realDnsLookup(hostname, options)
);

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { safeFetchBinary, readBounded, safeFetchRequest, validateFetchUrl } = await import('../src/llm/safe-fetch.js');

const TLS_DIR = path.join(import.meta.dirname, 'fixtures', 'tls');
const TLS_CERT = fs.readFileSync(path.join(TLS_DIR, 'localhost-cert.pem'));
const TLS_KEY = fs.readFileSync(path.join(TLS_DIR, 'localhost-key.pem'));
// 测试用自签证书只在本进程内被信任；不要用 NODE_TLS_REJECT_UNAUTHORIZED=0，
// 那会把“证书校验失败必须拒绝”的用例一起关掉。
tls.setDefaultCACertificates([...tls.getCACertificates('default'), TLS_CERT.toString()]);

test('fake-ip DNS：放行 198.18/15 的解析结果，但直连地址和真内网仍然拦截', async () => {
  const base = structuredClone(DEFAULT_CONFIG);
  setRuntimeConfig({ ...base, security: { ...base.security, allowFakeIpDns: true } });
  const ok = await validateFetchUrl('https://fake-ip.test/a');
  assert.equal(ok.ip, '198.18.0.5', 'DNS 解析到 fake-ip 段应放行');
  await assert.rejects(validateFetchUrl('http://198.18.0.5/a'), /内网\/本机地址/, 'URL 直接写 198.18 仍拒绝');
  await assert.rejects(validateFetchUrl('https://private.test/a'), /内网\/本机地址/, '真内网解析结果仍拒绝');

  setRuntimeConfig({ ...base, security: { ...base.security, allowFakeIpDns: false } });
  await assert.rejects(validateFetchUrl('https://fake-ip.test/a'), /内网\/本机地址/, '显式关闭后恢复拒绝');

  // fake-ip6 不默认放行；用户显式把网段加进 fakeIpCidrs 才生效。
  await assert.rejects(validateFetchUrl('https://fake-ip6.test/a'), /内网\/本机地址/, '默认不放行 IPv6 fake-ip');
  setRuntimeConfig({
    ...base,
    security: { ...base.security, allowFakeIpDns: true, fakeIpCidrs: ['198.18.0.0/15', 'fc00::/18'] }
  });
  const ok6 = await validateFetchUrl('https://fake-ip6.test/a');
  assert.equal(ok6.ip, 'fc00::5', '显式配置的 fake-ip6 网段可放行');
  setRuntimeConfig({ ...base, security: { ...base.security, allowFakeIpDns: true, fakeIpCidrs: ['bad', '999.1.1.1/8'] } });
  await assert.rejects(validateFetchUrl('https://fake-ip.test/a'), /内网\/本机地址/, '坏 CIDR 不能变成放行');
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  server.close();
  server.closeAllConnections?.();
}

test('safeFetchBinary rejects an oversized response instead of returning truncated bytes', async (t) => {
  setRuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    security: { allowPrivateImageHosts: true }
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([1, 2, 3, 4, 5]));
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    safeFetchBinary(`http://127.0.0.1:${port}/image`, 4),
    /超过 4 字节限制/
  );
});

test('safeFetchBinary accepts a response exactly at the byte limit', async (t) => {
  setRuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    security: { allowPrivateImageHosts: true }
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await safeFetchBinary(`http://127.0.0.1:${port}/image`, 4);
  assert.deepEqual(result.buffer, Buffer.from([1, 2, 3, 4]));
});

test('重定向：同源保留凭据，跨源剥掉（白名单 ≠ 可以交 Cookie）', async (t) => {
  const seenTarget = [];
  const target = http.createServer((req, res) => {
    seenTarget.push({ url: req.url, cookie: req.headers.cookie || '', apiKey: req.headers['x-api-key'] || '' });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const targetPort = await listen(target);
  t.after(() => target.close());

  const seenSource = [];
  const source = http.createServer((req, res) => {
    if (req.url === '/same') {
      res.writeHead(302, { location: '/land' });
      res.end();
      return;
    }
    if (req.url === '/land') {
      seenSource.push({ cookie: req.headers.cookie || '' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/land` });
    res.end();
  });
  const sourcePort = await listen(source);
  t.after(() => source.close());

  const headers = { cookie: 'SESSDATA=secret', 'x-api-key': 'header-secret' };
  await safeFetchRequest(`http://127.0.0.1:${sourcePort}/same`, { headers, allowPrivate: true });
  assert.equal(seenSource.at(-1).cookie, 'SESSDATA=secret', '同源重定向保留凭据');

  await safeFetchRequest(`http://127.0.0.1:${sourcePort}/cross`, { headers, allowPrivate: true });
  assert.equal(seenTarget.at(-1).url, '/land');
  assert.equal(seenTarget.at(-1).cookie, '', '跨源（换端口也算）重定向必须剥掉 Cookie');
  assert.equal(seenTarget.at(-1).apiKey, '', '跨源重定向也必须剥掉 x-api-key');
});

test('readBounded：正好等于上限（自然读尽）不标 truncated；超过才中断并标（2026-10-09 审查）', async () => {
  // 旧实现用 `total >= maxBytes` 中断 + 拿 body 长度反推 truncated：正好一页（50000 字节）
  // 的完整响应会被误标成"截断"；而截断后的英文页长度恰好也是 50000，反推又会漏标。
  // 现在 truncated 由读取路径如实带出。
  const { EventEmitter } = await import('node:events');
  const fakeRes = () => {
    const ee = new EventEmitter();
    ee.destroyCalled = false;
    ee.destroy = () => { ee.destroyCalled = true; };
    return ee;
  };

  // ① 正好等于上限：完整响应，不许中断、不许标 truncated
  const exact = fakeRes();
  const p1 = readBounded(exact, 10, true);
  exact.emit('data', Buffer.from('0123456789'));
  exact.emit('end');
  assert.deepEqual(await p1, { body: '0123456789', truncated: false });
  assert.equal(exact.destroyCalled, false, '正好等于上限不该中断连接');

  // ② 超过一字节：中断 + 截到上限 + truncated=true
  const over = fakeRes();
  const p2 = readBounded(over, 10, true);
  over.emit('data', Buffer.from('0123456789ab'));
  assert.equal(over.destroyCalled, true, '超限必须中断连接');
  assert.deepEqual(await p2, { body: '0123456789', truncated: true });
});

test('域名白名单：初始 URL 与每一跳重定向都复检（isHostAllowed + 实际 302）', async () => {
  const { safeFetchRequest, safeFetchBinary, isHostAllowed } = await import('../src/llm/safe-fetch.js');

  // 纯函数口径：子域放行、同后缀不同域拒绝、大小写与结尾点归一
  assert.equal(isHostAllowed('api.bilibili.com', ['bilibili.com']), true);
  assert.equal(isHostAllowed('evilbilibili.com', ['bilibili.com']), false, '同后缀不同域不能放行');
  assert.equal(isHostAllowed('BILIBILI.COM.', ['bilibili.com']), true);
  assert.equal(isHostAllowed('x.com', []), true, '空名单 = 不启用域名限制');

  // 真实 302：127.0.0.1 在名单里，localhost 不在 —— 重定向到 localhost 必须被拦
  let bHits = 0;
  const serverB = http.createServer((_req, res) => { bHits += 1; res.writeHead(200); res.end('LEAK'); });
  const serverA = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://localhost:${serverB.address().port}/x` });
    res.end();
  });
  // 不指定 host：默认绑 ::（双栈），127.0.0.1 与 localhost(→::1) 都能到达 ——
  // 本机 localhost 优先解析成 ::1，只绑 127.0.0.1 的对照组会连接被拒
  await new Promise((resolve) => serverA.listen(0, resolve));
  await new Promise((resolve) => serverB.listen(0, resolve));
  const aUrl = `http://127.0.0.1:${serverA.address().port}/start`;
  await assert.rejects(
    safeFetchRequest(aUrl, { allowPrivate: true, allowedDomains: ['127.0.0.1'] }),
    /白名单/
  );
  await assert.rejects(
    safeFetchBinary(aUrl, 1000, undefined, { allowPrivate: true, allowedDomains: ['127.0.0.1'] }),
    /白名单/
  );
  assert.equal(bHits, 0, '被拦的重定向不能碰到达端');
  // 名单覆盖两台主机时放行（对照组：证明拒绝确实来自白名单而不是别的守卫）
  const allowed = await safeFetchRequest(aUrl, { allowPrivate: true, allowedDomains: ['127.0.0.1', 'localhost'] });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body, 'LEAK');
  serverA.close();
  serverB.close();
  // Node 19+ 的默认 agent 开 keep-alive：不掐掉存量连接的话，测试进程会因服务器句柄未释放而挂住
  serverA.closeAllConnections?.();
  serverB.closeAllConnections?.();
});

test('HTTPS GET 优先走 HTTP/2，且仍把请求发给已校验的 IP', async (t) => {
  const seen = [];
  const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT });
  server.on('stream', (stream, headers) => {
    seen.push(headers);
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('h2-ok');
  });
  const port = await listen(server);
  t.after(() => closeServer(server));

  const result = await safeFetchRequest(`https://127.0.0.1:${port}/h2`, { allowPrivate: true });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'h2-ok');
  assert.equal(seen[0][':method'], 'GET');
  assert.equal(seen[0][':path'], '/h2');
  assert.match(String(seen[0][':authority']), /^127\.0\.0\.1:/);
});

test('HTTP/2 连接固定到已校验的 IP，:authority 仍是原始域名', async (t) => {
  const seen = [];
  const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT });
  server.on('stream', (stream, headers) => {
    seen.push(headers);
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('pinned');
  });
  const port = await listen(server);
  t.after(() => closeServer(server));

  const result = await safeFetchRequest(`https://pinned.test:${port}/pinned`, { allowPrivate: true });
  assert.equal(result.body, 'pinned');
  assert.equal(seen[0][':authority'], `pinned.test:${port}`);
});

test('HTTP/2 不可用时 HTTPS GET 回落 HTTP/1.1', async (t) => {
  const versions = [];
  const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    versions.push(req.httpVersion);
    res.end('h1-ok');
  });
  const port = await listen(server);
  t.after(() => closeServer(server));

  const result = await safeFetchRequest(`https://127.0.0.1:${port}/fallback`, { allowPrivate: true });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'h1-ok');
  assert.deepEqual(versions, ['1.1'], 'h2 连接失败后只应发一次 h1 请求');
});

test('HTTP/2 重定向：同源保留 Cookie，跨源剥掉', async (t) => {
  const targetHits = [];
  const target = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT });
  target.on('stream', (stream, headers) => {
    targetHits.push(String(headers.cookie || ''));
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('target');
  });
  const targetPort = await listen(target);
  t.after(() => closeServer(target));

  const sourceHits = [];
  const source = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT });
  source.on('stream', (stream, headers) => {
    if (headers[':path'] === '/same') {
      stream.respond({ ':status': 302, location: '/land' });
      stream.end();
      return;
    }
    if (headers[':path'] === '/land') {
      sourceHits.push(String(headers.cookie || ''));
      stream.respond({ ':status': 200, 'content-type': 'text/plain' });
      stream.end('same');
      return;
    }
    stream.respond({ ':status': 302, location: `https://127.0.0.1:${targetPort}/land` });
    stream.end();
  });
  const sourcePort = await listen(source);
  t.after(() => closeServer(source));

  const headers = { cookie: 'SESSDATA=secret' };
  await safeFetchRequest(`https://127.0.0.1:${sourcePort}/same`, { headers, allowPrivate: true });
  assert.equal(sourceHits.at(-1), 'SESSDATA=secret', '同源重定向保留 Cookie');

  const cross = await safeFetchRequest(`https://127.0.0.1:${sourcePort}/cross`, { headers, allowPrivate: true });
  assert.equal(cross.body, 'target');
  assert.equal(targetHits.at(-1), '', '跨源重定向必须剥掉 Cookie');
});

test('readBounded：响应在 end 之前 close 时立即失败，不等超时', async () => {
  // HTTP/2 的 RST_STREAM(NO_ERROR) 与 HTTP/1.1 的提前断连都可能只触发 close、不触发 error；
  // 这里用假流把这条路径钉住，避免回归成“等 20 秒会话超时”。
  const { EventEmitter } = await import('node:events');
  const fake = new EventEmitter();
  fake.destroy = () => {};
  const pending = readBounded(fake, 100, true);
  fake.emit('data', Buffer.from('partial'));
  fake.emit('close');
  await assert.rejects(pending, /读取完成前关闭/);
});

test('HTTP/2 响应同样受体积上限约束', async (t) => {
  const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT });
  server.on('stream', (stream) => {
    stream.respond({ ':status': 200, 'content-type': 'image/png' });
    stream.end(Buffer.alloc(5));
  });
  const port = await listen(server);
  t.after(() => closeServer(server));

  await assert.rejects(
    safeFetchBinary(`https://127.0.0.1:${port}/image`, 4, undefined, { allowPrivate: true }),
    /超过 4 字节限制/
  );
});

test('HTTP/2 响应头映射：Set-Cookie 只在显式要求时返回', async (t) => {
  const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT });
  server.on('stream', (stream) => {
    stream.respond({
      ':status': 200,
      'content-type': 'text/plain',
      'set-cookie': ['a=1; Path=/', 'b=2; Path=/']
    });
    stream.end('ok');
  });
  const port = await listen(server);
  t.after(() => closeServer(server));

  const withCookies = await safeFetchRequest(`https://127.0.0.1:${port}/cookies`, {
    allowPrivate: true,
    withSetCookies: true
  });
  assert.deepEqual(withCookies.setCookies, ['a=1; Path=/', 'b=2; Path=/']);

  const withoutCookies = await safeFetchRequest(`https://127.0.0.1:${port}/cookies`, { allowPrivate: true });
  assert.equal('setCookies' in withoutCookies, false, '默认不把 Set-Cookie 暴露给调用方');
});

test('解压：压缩响应被 maxBytes 截断时仍尽量解出前缀', async (t) => {
  const html = `<html><head><link rel="canonical" href="https://www.bilibili.com/video/BV1xx411c7mD"></head>${'x'.repeat(50000)}</html>`;
  for (const encoding of ['gzip', 'br']) {
    const body = encoding === 'gzip'
      ? zlib.gzipSync(Buffer.from(html))
      : zlib.brotliCompressSync(Buffer.from(html));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding });
      res.end(body);
    });
    const port = await listen(server);
    t.after(() => closeServer(server));

    // 解压输出上限是 maxBytes * 5；完整流也要给足输出空间。
    const complete = await safeFetchRequest(`http://127.0.0.1:${port}/page`, {
      allowPrivate: true,
      decompress: true,
      maxBytes: Math.max(body.length, Math.ceil(Buffer.byteLength(html) / 5) + 16)
    });
    assert.equal(complete.body, html, `${encoding} 完整流要完整解出`);

    // brotli 的块比 gzip 大，截到一半时可能还解不出任何字节；保留 90% 模拟“尾部缺一点”。
    const keep = encoding === 'br' ? 0.9 : 0.5;
    const result = await safeFetchRequest(`http://127.0.0.1:${port}/page`, {
      allowPrivate: true,
      decompress: true,
      maxBytes: Math.max(1, Math.floor(body.length * keep))
    });
    assert.equal(result.truncated, true, `${encoding} 应在解压前被体积上限截断`);
    assert.match(result.body, /rel="canonical"/, `${encoding} 被截断后仍要能解出页面前缀`);
  }
});

test('POST 继续走 HTTP/1.1，不因 h2 失败而重复发送', async (t) => {
  const versions = [];
  const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    versions.push(req.httpVersion);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => res.end(`POST:${body}:${req.httpVersion}`));
  });
  const port = await listen(server);
  t.after(() => closeServer(server));

  const result = await safeFetchRequest(`https://127.0.0.1:${port}/write`, {
    method: 'POST',
    body: 'hello',
    allowPrivate: true
  });
  assert.equal(result.body, 'POST:hello:1.1');
  assert.deepEqual(versions, ['1.1']);
});

test('已取消的 signal 不再发起 HTTP/2 连接', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    safeFetchRequest('https://127.0.0.1:1/never', { allowPrivate: true, signal: controller.signal }),
    (error) => {
      assert.equal(error.name, 'AbortError', '取消语义要与 HTTP/1.1 路径一致');
      return true;
    }
  );
});
