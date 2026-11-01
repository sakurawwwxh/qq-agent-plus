// 成本口径的接口级回归：这几个数字直接影响用户对账单的理解，
// 所以用真实 createApp + 真实会话留档跑一遍，不只测纯函数。
//
// 覆盖：
//   1. 账户级包月（costMode=subscription）只有一个固定支出 —— 不能按"用过的模型数"翻倍；
//   2. 未定价 ≠ 免费：没价的调用不计成本，但要能被统计出来（不是 ¥0.00）；
//   3. 明细接口要带包月/本地/未定价计数，界面才不会把 ¥0.00 读成免费。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-usage-cost-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

/** 写一份会话留档（形状与 src/core/sessions.js 落盘的一致）。 */
function writeSession(name, { model, vendor = '', calls }) {
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = Date.now() - 60_000;
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
    id: name,
    chatKey: 'group:1',
    vendor,
    model,
    startedAt,
    messages: calls.map((c, i) => ({
      raw: {
        model,
        created: Math.floor((startedAt + i * 1000) / 1000),
        usage: { prompt_tokens: c.prompt, completion_tokens: c.completion }
      }
    }))
  }));
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function bootApp(extraApi = {}) {
  // freePort 是"先绑后关再复用"：并发测试文件同时在抢端口 + 生产实例的出站连接
  // 也在消耗临时端口，偶发 EADDRINUSE（服务器自动更新就栽在这里）。换端口重试。
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
    cfg.runtime.mode = 'observe';
    cfg.allow = { ...(cfg.allow || {}), groups: ['1'], private: [] };
    cfg.onebot = { ...(cfg.onebot || {}), wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: '' };
    // 不要在这条用例里碰网络：远程价格表关掉、Base URL 留空（否则会触发自动探测）
    cfg.api = {
      ...(cfg.api || {}),
      baseUrl: '',
      apiKey: '',
      model: 'deepseek-flash',
      useOfficialPrice: true,
      priceRemoteUrl: 'none',
      ...extraApi
    };
    updateConfig(cfg);
    const app = createApp({ log: () => {} });
    try {
      const bound = await app.start();
      const get = async (route) => {
        const res = await fetch(`http://127.0.0.1:${bound}${route}`);
        return { status: res.status, body: await res.json().catch(() => ({})) };
      };
      return { app, get };
    } catch (error) {
      lastError = error;
      // 无论哪种失败都先停掉可能已半启动的实例（listen 成功但后续步骤抛错时，
      // 不停服会挂住测试进程句柄）；EADDRINUSE 换端口重试，其他错误上抛。
      await app.stop().catch(() => {});
      if (!/EADDRINUSE/.test(String(error?.message ?? '')) && error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError;
}

test('账户级包月：多个模型也只有一个固定支出，不会按模型数翻倍', async (t) => {
  writeSession('s-flat-a', { model: 'model-a', calls: [{ prompt: 1_000_000, completion: 1_000_000 }] });
  writeSession('s-flat-b', { model: 'model-b', calls: [{ prompt: 500_000, completion: 200_000 }] });
  const { app, get } = await bootApp({ costMode: 'subscription', costMonthlyFee: 68 });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });

  const stats = await get('/api/usage/stats?range=today');
  assert.equal(stats.status, 200);
  const billing = stats.body.billing || {};
  assert.equal(billing.flatCalls, 2, '两次调用都算包月');
  assert.equal(billing.flatItems.length, 1, '账户月费只能有一条（不能一个模型一条）');
  assert.equal(billing.flatItems[0].amount, 68);
  assert.equal(billing.flatItems[0].accountLevel, true);
  // 包月不按 token 计价：区间成本仍是 0，但绝不能因此被当成"未定价"
  assert.equal(stats.body.totals.cost, 0);
  assert.equal(stats.body.totals.unpricedCalls, 0, '包月不是未定价');

  const status = await get('/api/status');
  assert.equal(status.body.cost.flatCost, 68, '顶栏的固定支出也是 ¥68，不是 ¥136');
  assert.equal(status.body.cost.flatCalls, 2);
});

test('未定价 ≠ 免费：没价的调用单独计数，明细接口也要带上', async (t) => {
  // 关掉官方价与一切兜底单价 → model-c 没有价
  writeSession('s-unpriced', { model: 'model-c', calls: [{ prompt: 2_000_000, completion: 100_000 }] });
  const { app, get } = await bootApp({
    costMode: 'official',
    useOfficialPrice: true,
    fallbackToCurrentModel: false,
    model: 'model-c'
  });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });

  const stats = await get('/api/usage/stats?range=today');
  const totals = stats.body.totals;
  assert.equal(totals.cost, 0);
  assert.equal(totals.unpricedCalls, 1, '未定价的调用要计数');
  assert.ok(totals.unpricedTokens >= 2_100_000);
  assert.ok(stats.body.unpriced.models.length >= 1, '未定价模型清单不能是空的');

  const breakdown = await get('/api/usage/breakdown?range=today&dim=chat&key=group:1&by=model');
  assert.equal(breakdown.status, 200);
  const row = (breakdown.body.rows || [])[0];
  assert.ok(row, '明细要有一行');
  assert.equal(row.unpricedCalls, 1, '明细行要带未定价计数（否则界面只剩 ¥0.00）');
  assert.equal(row.flatCalls, 0);
});

test('压缩归档（.json.gz）仍计入用量与明细，压缩不会让历史账目变少', async (t) => {
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = Date.now() - 60_000;
  const body = JSON.stringify({
    id: 's-gzip-1',
    chatKey: 'group:1',
    vendor: '',
    model: 'deepseek-flash',
    startedAt,
    messages: [{
      raw: {
        model: 'deepseek-flash',
        created: Math.floor(startedAt / 1000),
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }
      }
    }]
  });
  fs.writeFileSync(path.join(dir, 's-gzip-1.json.gz'), zlib.gzipSync(Buffer.from(body, 'utf8')));

  const { app, get } = await bootApp({ costMode: 'official', useOfficialPrice: true, fallbackToCurrentModel: false });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });

  const stats = await get('/api/usage/stats?range=today');
  assert.equal(stats.status, 200);
  const totals = stats.body.totals;
  assert.ok(totals.runs >= 1, '压缩归档里的调用要算进次数');
  assert.ok(totals.cost > 0, '压缩归档里的调用要算进成本（不能因为读不到而少算）');
  assert.equal(totals.unpricedCalls, 0, '有价的模型不该因为压缩被当成未定价');

  const breakdown = await get('/api/usage/breakdown?range=today&dim=chat&key=group:1&by=model');
  assert.equal(breakdown.status, 200);
  assert.ok((breakdown.body.rows || []).length >= 1, '明细里也要有这一行');

  // 存储占用面板：压缩文件数要如实上报
  const status = await get('/api/status');
  assert.ok(status.body.storage?.compressedFiles >= 1, '/api/status 要能看到压缩归档数量');
  assert.ok(status.body.storage?.bytes > 0);
});
