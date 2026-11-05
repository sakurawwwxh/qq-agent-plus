import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMetrics } from '../src/console/metrics.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-metrics-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function boot(t) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await app.start();
  return { port, app };
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('createMetrics：状态分桶与 p50/p95', () => {
  const metrics = createMetrics();
  metrics.recordHttp(200, 10);
  metrics.recordHttp(200, 20);
  metrics.recordHttp(401, 30);
  const snap = metrics.snapshot();
  assert.equal(snap.requests.total, 3);
  assert.equal(snap.requests.byStatus['2xx'], 2);
  assert.equal(snap.requests.byStatus['4xx'], 1);
  assert.equal(snap.latencyMs.samples, 3);
  assert.ok(snap.latencyMs.p50 > 0);
  assert.ok(snap.latencyMs.p95 >= snap.latencyMs.p50);
  assert.equal(typeof snap.eventLoop.utilization, 'number');
  assert.ok(snap.eventLoop.utilization >= 0);
});

test('/api/metrics：真实请求计数、进程指标、脱敏；prometheus 输出可用', async (t) => {
  const { port } = await boot(t);
  await get(port, '/healthz');
  await get(port, '/api/status');

  const response = await get(port, '/api/metrics');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  const body = JSON.parse(response.text);
  assert.equal(body.ok, true);
  assert.ok(body.http.requests.total >= 2);
  assert.ok(body.http.requests.byStatus['2xx'] >= 2);
  assert.ok(body.process.rssBytes > 0);
  assert.equal(typeof body.process.uptimeSeconds, 'number');
  assert.equal(body.onebot.connected, false);
  assert.equal(typeof body.onebot.sendFailures, 'number');
  assert.ok(Array.isArray(body.plugins));
  assert.match(response.text, /"outbox"/);
  assert.equal(typeof body.outbox.total, 'number');
  assert.equal(typeof body.outbox.byState, 'object');
  assert.equal(typeof body.queues.oldestAgeMs, 'number');
  assert.equal(typeof body.unknown.total, 'number', 'unknown 数量要进指标');
  assert.equal(typeof body.unknown.oldestAgeMs, 'number');
  assert.equal(typeof body.mcp.restartAttempts, 'number', 'MCP 重启次数要进指标');
  assert.ok(Array.isArray(body.mcp.servers));
  assert.ok(body.host === null || typeof body.host.disk?.usedPercent === 'number');
  assert.equal(typeof body.llm.requests, 'number');
  assert.equal(typeof body.llm.failures, 'number');
  assert.equal(typeof body.llm.retries, 'number');
  assert.equal(typeof body.llm.costToday, 'number');
  // 指标里不能出现控制台令牌/密钥字段
  assert.doesNotMatch(response.text, /"(token|apiKey|secret|accessToken)"/);

  const prometheus = await get(port, '/api/metrics?format=prometheus');
  assert.equal(prometheus.status, 200);
  assert.match(prometheus.headers['content-type'], /text\/plain/);
  assert.match(prometheus.text, /qqagent_uptime_seconds \d+/);
  assert.match(prometheus.text, /qqagent_http_requests_total \d+/);
  assert.match(prometheus.text, /qqagent_outbox_pending \d+/);
  assert.match(prometheus.text, /qqagent_inbound_pending \d+/);
  assert.match(prometheus.text, /qqagent_inbound_oldest_age_seconds \d+/);
  assert.match(prometheus.text, /qqagent_outbox_unknown \d+/);
  assert.match(prometheus.text, /qqagent_outbox_unknown_oldest_age_seconds \d+/);
  assert.match(prometheus.text, /qqagent_mcp_restart_attempts_total \d+/);
  assert.match(prometheus.text, /qqagent_disk_used_ratio [\d.]+/);
  assert.match(prometheus.text, /qqagent_llm_requests_total \d+/);
  assert.match(prometheus.text, /qqagent_llm_failures_total \d+/);
  assert.match(prometheus.text, /qqagent_event_loop_utilization [\d.]+/);
});

test('Prometheus qqagent_outbox_pending 取 sending 桶，不是不存在的 pending 字段', async (t) => {
  const { port, app } = await boot(t);
  const insert = app.store.db.prepare('INSERT INTO outbox(id,run_id,chat_key,state,payload) VALUES (?,?,?,?,?)');
  insert.run('m1', 'r1', 'group:1', 'sending', '{}');
  insert.run('m2', 'r1', 'group:1', 'unknown', '{}');
  insert.run('m3', 'r1', 'group:1', 'sent', '{}');
  const prometheus = await get(port, '/api/metrics?format=prometheus');
  assert.match(prometheus.text, /qqagent_outbox_pending 1\n/);
  assert.match(prometheus.text, /qqagent_outbox_unknown 1\n/);
});

test('/api/health 返回最近巡检结果（没有文件时 health=null）', async (t) => {
  const { port } = await boot(t);
  const response = await get(port, '/api/health');
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.ok, true);
  assert.equal(body.health, null);
});
