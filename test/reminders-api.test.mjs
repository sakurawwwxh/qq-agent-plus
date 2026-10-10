// 控制台 GET /api/reminders：归属字段（from/to）透出。
// 2026-10-10 反馈：提醒列表要能看到"谁请你提醒谁"——字段必须原样送达前端（空归属给空串，
// 由前端决定显示"有人请你提醒"而不是编造名字）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reminders-api-'));
process.env.QQ_AGENT_DATA_DIR = root;

// 预写提醒文件：createApp 构造 ReminderStore 时直接读默认文件（DATA_DIR/reminders.json）
const now = Date.now();
fs.writeFileSync(path.join(root, 'reminders.json'), JSON.stringify({
  items: [
    { id: 'r1', chatKey: 'group:1', at: now + 600000, text: '去吃饭', createdBy: '彭于晏', targetName: '吴彦祖', status: 'pending', createdAt: now, firedAt: null, finishedAt: null },
    { id: 'r2', chatKey: 'group:1', at: now - 60000, text: '喝水', createdBy: '', targetName: '', status: 'fired', createdAt: now - 3600000, firedAt: now, finishedAt: now }
  ]
}, null, 1));

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// 起一个控制台实例（同 console-key-endpoints.test.mjs 的最小搭法：本机 + 不设令牌）。
async function boot(t) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  return { port };
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, body });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    req.end();
  });
}

test('GET /api/reminders：归属 from/to 透出，空归属给空串（不编造）', async (t) => {
  const { port } = await boot(t);
  const r = await get(port, '/api/reminders', { host: `127.0.0.1:${port}` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body?.ok, true);
  const pending = r.body?.pending?.find((x) => x.id === 'r1');
  assert.ok(pending, 'r1 应在待触发里');
  assert.equal(pending.from, '彭于晏');
  assert.equal(pending.to, '吴彦祖');
  assert.equal(pending.text, '去吃饭');
  const done = r.body?.recent?.find((x) => x.id === 'r2');
  assert.ok(done, 'r2 应在最近完成里');
  assert.equal(done.from, '');
  assert.equal(done.to, '');
  assert.equal(done.status, 'fired');
});
