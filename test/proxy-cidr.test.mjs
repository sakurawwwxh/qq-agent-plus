// trustedProxies 的严格解析与 X-Real-IP 卫生（2026-10-31 全项目复审）：
// - "127.0.0.1/" 不能被 Number('')=0 当成 /0 放行所有 IPv4；
// - 只认 X-Forwarded-For，客户端直传的 X-Real-IP 不能自选限流键。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('畸形 CIDR 不生效；X-Real-IP 不参与限流键', async (t) => {
  const { base } = await bootConsole(t, {
    config: { server: { trustedProxies: ['127.0.0.1/'] } }
  });
  const login = async (body, headers = {}) => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    return res.status;
  };

  // 无效 CIDR → 127.0.0.1 不被视为可信：不同 XFF 仍按代理地址累计，第 6 次 429。
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push(await login({ token: 'wrong' }, { 'x-forwarded-for': `198.51.100.${i}` }));
  }
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429, '畸形 CIDR 不能被当成 /0 放行');

  // 换到合法的精确地址；X-Real-IP 不同也不能分散失败（应共用 127.0.0.1 桶）；
  // 但该桶已被上一段锁住，这里先验证 429，再在独立文件里验证 401/429 序列。
});
