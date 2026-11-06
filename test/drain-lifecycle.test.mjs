// 停机收尾：发送链屏障、deadline 包装与 app.stop 的顺序约束（源码锚点）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createSendChain, settleWithDeadline } from '../src/core/util.js';
import { SendQueue } from '../src/onebot/sender.js';

test('createSendChain.idle 等待已入队任务（含失败任务）', async () => {
  const chain = createSendChain();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let done = false;
  chain(async () => { await gate; done = true; });
  chain(async () => { throw new Error('ignored'); });
  const idle = chain.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  release();
  await idle;
  assert.equal(done, true);
});

test('SendQueue.drain 等到所有会话发送链清空', async () => {
  const queue = new SendQueue({ onebot: {}, store: {} });
  const chain = createSendChain();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let sent = false;
  chain(async () => { await gate; sent = true; });
  queue.chains.set('group:1', chain);
  let drained = false;
  const draining = queue.drain({ timeoutMs: 1000 }).then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, false);
  assert.equal(drained, false);
  release();
  await draining;
  assert.equal(sent, true);
  assert.equal(drained, true);
});

test('settleWithDeadline 不因任务 reject 抛出，并在超时后返回', async () => {
  await settleWithDeadline([Promise.reject(new Error('boom'))], 100);
  const started = Date.now();
  await settleWithDeadline([new Promise(() => {})], 80);
  assert.ok(Date.now() - started >= 50);
});

test('app.stop 顺序：producer drain → 子进程/run → living memory → sender → onebot → store', () => {
  const source = fs.readFileSync(new URL('../src/console/app.js', import.meta.url), 'utf8');
  const at = (needle) => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, `找不到顺序锚点：${needle}`);
    return index;
  };
  const producerDrain = at('await settleWithDeadline([\n      dailyMoments.abort()');
  const pluginStop = at('await pluginRegistry.stop();');
  const orchestratorAbort = at('await settleWithDeadline([orchestrator.abortAll()], 5000);');
  const livingDrain = at('await settleWithDeadline([livingMemory.drain()], 5000);');
  const senderDrain = at('await sender.drain({ timeoutMs: 3000 });');
  const onebotClose = at('onebot.close();');
  const storeClose = at('store.close();');
  assert.ok(producerDrain < pluginStop, 'producer 收尾要早于插件停止');
  assert.ok(pluginStop < orchestratorAbort, '插件停止要早于对话 run 收尾');
  assert.ok(orchestratorAbort < livingDrain, '记忆运行时要在对话 run 之后关');
  assert.ok(livingDrain < senderDrain, '发送屏障要在所有 producer 之后');
  assert.ok(senderDrain < onebotClose, '先等发送队列，再关 transport');
  assert.ok(onebotClose < storeClose, 'store.close 必须最后');
});
