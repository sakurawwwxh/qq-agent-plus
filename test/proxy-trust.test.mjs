// 反代信任与 Cookie Secure（2026-10-31 复审）：
// - 只有 server.trustedProxies 命中 TCP 对端时才采信 x-forwarded-for 作为登录限流键；
// - 未配置时伪造 XFF 不能把失败分散掉（仍按代理地址计数并退避）；
// - 可信代理转发 x-forwarded-proto: https 时，登录 Cookie 加 Secure。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('可信代理下按真实客户端 IP 限流，HTTPS 转发时 Cookie 带 Secure', async (t) => {
  const { base, token } = await bootConsole(t, {
    config: { server: { trustedProxies: ['127.0.0.1', '10.0.0.0/8'] } }
  });
  const login = async (body, headers = {}) => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    return { status: res.status, cookie: res.headers.get('set-cookie') || '' };
  };

  await t.test('x-forwarded-proto: https → Secure', async () => {
    const ok = await login({ token }, { 'x-forwarded-proto': 'https' });
    assert.equal(ok.status, 200);
    assert.match(ok.cookie, /;\s*Secure/i);
    assert.match(ok.cookie, /HttpOnly/i);
  });

  await t.test('普通 HTTP → 不加 Secure', async () => {
    const ok = await login({ token });
    assert.equal(ok.status, 200);
    assert.doesNotMatch(ok.cookie, /;\s*Secure/i);
  });

  await t.test('可信代理：不同客户端 IP 各自计数，不会互相锁死', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const bad = await login({ token: 'wrong' }, { 'x-forwarded-for': `198.51.100.${i}` });
      assert.equal(bad.status, 401, `第 ${i} 个客户端应是 401`);
    }
    const other = await login({ token: 'wrong' }, { 'x-forwarded-for': '198.51.100.99' });
    assert.equal(other.status, 401, '新客户端不应被别的客户端失败拖累');
  });

  await t.test('可信代理：同一客户端连续失败会退避（伪造最左段无效）', async () => {
    for (let i = 0; i < 5; i += 1) {
      // 客户端自带一段伪造 XFF，代理把真实地址追加在末尾；限流必须按最右一跳算。
      const bad = await login({ token: 'wrong' }, {
        'x-forwarded-for': `1.2.3.${i}, 203.0.113.7`
      });
      assert.equal(bad.status, 401);
    }
    const blocked = await login({ token: 'wrong' }, { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' });
    assert.equal(blocked.status, 429);
  });

  await t.test('多级代理：从右往左剥可信跳，取真实客户端', async () => {
    // 标准追加链：客户端伪造 1.1.1.N → 真实客户端 198.51.100.20 → CDN 10.0.0.5（可信段）
    // TCP 对端是 nginx 127.0.0.1（也命中 trustedProxies）。
    for (let i = 0; i < 5; i += 1) {
      const bad = await login({ token: 'wrong' }, {
        'x-forwarded-for': `1.1.1.${i}, 198.51.100.20, 10.0.0.5`
      });
      assert.equal(bad.status, 401);
    }
    const blocked = await login({ token: 'wrong' }, {
      'x-forwarded-for': '9.9.9.9, 198.51.100.20, 10.0.0.5'
    });
    assert.equal(blocked.status, 429, '必须按 198.51.100.20 计数，而不是中间代理或伪造段');
    // 隔离断言：另一个客户端不能被 198.51.100.20 的桶拖累。
    // 旧实现取最右一跳（10.0.0.5）会让所有客户端共用一个桶，这条会红。
    const other = await login({ token: 'wrong' }, {
      'x-forwarded-for': '9.9.9.9, 198.51.100.21, 10.0.0.5'
    });
    assert.equal(other.status, 401, '不同真实客户端必须各有各的计数');
  });

  await t.test('未配置可信代理：伪造 XFF 不能绕过限流', async () => {
    const { updateConfig, getConfig } = await import('../src/core/config.js');
    const cfg = getConfig();
    updateConfig({ server: { ...cfg.server, trustedProxies: [] } });
    let last = null;
    for (let i = 0; i < 6; i += 1) {
      last = await login({ token: 'wrong' }, { 'x-forwarded-for': `192.0.2.${i}` });
      if (i < 5) assert.equal(last.status, 401, `第 ${i + 1} 次应仍是 401`);
    }
    assert.equal(last.status, 429, '第 6 次必须按代理地址退避，而不是被 XFF 分散');
  });
});
