// 只认 X-Forwarded-For：X-Real-IP 由客户端直传时不能作为限流键（否则可绕过退避）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('X-Real-IP 不参与限流键，连续失败按连接地址退避', async (t) => {
  const { base } = await bootConsole(t, {
    config: { server: { trustedProxies: ['127.0.0.1'] } }
  });
  const login = async (realIp) => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': realIp },
      body: JSON.stringify({ token: 'wrong' })
    });
    return res.status;
  };
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push(await login(`192.0.2.${i}`));
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429, 'X-Real-IP 变化不能绕过按连接地址的退避');
});
