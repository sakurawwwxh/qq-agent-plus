// hasXxx 回填必须保留服务端真实键名的大小写（2026-10-31 盲审 P2）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('extraBody 的 Authorization 回填后仍是 Authorization', async (t) => {
  const { request } = await bootConsole(t);
  const { updateConfig, getConfig } = await import('../src/core/config.js');
  const cfg = getConfig();
  updateConfig({ api: { ...cfg.api, extraBody: { Authorization: 'Bearer sk-test-123' } } });

  const masked = await request('GET', '/api/config');
  assert.equal(masked.status, 200);
  assert.equal(masked.body.api.extraBody.Authorization, undefined, 'GET 不应回明文');
  assert.equal(masked.body.api.extraBody.hasAuthorization, true);

  // 用户在同一个框里改了别的字段并保存：占位名回填必须写到 Authorization。
  const saved = await request('POST', '/api/config', {
    api: { extraBody: { hasAuthorization: true, 'X-Extra': '1' } }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));
  const extra = getConfig().api.extraBody;
  assert.equal(extra.Authorization, 'Bearer sk-test-123', '真实键名不能变成小写 authorization');
  assert.equal(extra.authorization, undefined);
  assert.equal(extra['X-Extra'], '1');
});
