// #85：富化预算。超时、abort、promise 拒绝都必须返回 fallback，
// 且后面的调用不能把已经用掉的预算重新计时。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTimeBudget } from '../src/core/time-budget.js';

test('超时返回 fallback，不把异常抛给调用方', async () => {
  const budget = createTimeBudget(30);
  const started = Date.now();
  const value = await budget.run(new Promise(() => {}), 'placeholder');
  assert.equal(value, 'placeholder');
  assert.ok(Date.now() - started >= 20);
  assert.ok(Date.now() - started < 500);
});

test('promise 拒绝也按 fallback 收尾', async () => {
  const budget = createTimeBudget(500);
  assert.equal(await budget.run(Promise.reject(new Error('network')), 'fallback'), 'fallback');
});

test('abort 立即收尾，并且后续 run 不再等待', async () => {
  const controller = new AbortController();
  const budget = createTimeBudget(5000, { signal: controller.signal });
  const pending = budget.run(new Promise(() => {}), 'stopped');
  controller.abort();
  const started = Date.now();
  assert.equal(await pending, 'stopped');
  assert.ok(Date.now() - started < 200);
  assert.equal(budget.expired, true);
  assert.equal(await budget.run(new Promise(() => {}), 'again'), 'again');
});

test('共享同一 deadline：前一个慢调用会压缩后一个的剩余预算', async () => {
  const budget = createTimeBudget(80);
  assert.equal(await budget.run(new Promise(() => {}), 'first'), 'first');
  const started = Date.now();
  assert.equal(await budget.run(new Promise(() => {}), 'second'), 'second');
  assert.ok(Date.now() - started < 60, '第二个调用不应重新拿到完整 80ms');
});
