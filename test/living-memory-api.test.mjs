import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-living-memory-api-'));
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

function request(port, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* assert with raw response below */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', (error) => resolve({ status: 0, body: null, text: String(error?.message || error) }));
    if (payload) req.write(payload);
    req.end();
  });
}

test('living-memory routes use the Agent data directory without an external service', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await app.start();

  const before = await request(port, '/api/living-memory/status');
  assert.equal(before.status, 200, before.text);
  assert.equal(before.body?.status?.initialized, false);
  assert.equal(fs.existsSync(path.join(root, 'living-memory', 'living-memory.sqlite')), false);

  const configure = await request(port, '/api/config', {
    method: 'POST',
    body: { livingMemory: { enabled: true, graduated: true, mode: 'shadow', allowGlobal: true, groups: ['100'] } }
  });
  assert.equal(configure.status, 200, configure.text);

  const privateWrite = await request(port, '/api/living-memory/memories', {
    method: 'POST',
    body: { scopeKey: 'private:200', type: 'fact', summary: '私聊', content: '未开 allowPrivate 不应写入' }
  });
  assert.equal(privateWrite.status, 400, privateWrite.text);
  const otherGroup = await request(port, '/api/living-memory/memories', {
    method: 'POST',
    body: { scopeKey: 'group:200', type: 'fact', summary: '别的群', content: '不在 groups 白名单' }
  });
  assert.equal(otherGroup.status, 400, otherGroup.text);
  const bypass = await request(port, '/api/living-memory/memories', {
    method: 'POST',
    body: { scopeKey: 'group:100', type: 'fact', summary: '密码 abc', content: 'allowSensitive 不能从控制台绕过', allowSensitive: true }
  });
  assert.equal(bypass.status, 400, bypass.text);
  assert.match(bypass.body?.error || '', /拒绝保存/);

  const created = await request(port, '/api/living-memory/memories', {
    method: 'POST',
    body: { scopeKey: 'group:100', type: 'project', summary: '内置长期记忆', content: '卡片和向量由主进程写入 SQLite。', importance: 8 }
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body?.memory?.vectorStatus, 'none');
  assert.equal(fs.existsSync(path.join(root, 'living-memory', 'living-memory.sqlite')), true);

  const listed = await request(port, '/api/living-memory/memories?scopeKey=group%3A100');
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.body?.total, 1);
  assert.equal(listed.body?.entries?.[0]?.summary, '内置长期记忆');

  const pinned = await request(port, `/api/living-memory/memories/${created.body.memory.id}/pin`, {
    method: 'POST', body: { pinned: true }
  });
  assert.equal(pinned.status, 200, pinned.text);
  assert.equal(pinned.body?.memory?.pinned, true);
  const feedback = await request(port, `/api/living-memory/memories/${created.body.memory.id}/feedback`, {
    method: 'POST', body: { feedback: 'useful' }
  });
  assert.equal(feedback.status, 200, feedback.text);
  assert.equal(feedback.body?.memory?.feedback, 'useful');

  const second = await request(port, '/api/living-memory/memories', {
    method: 'POST',
    body: { scopeKey: 'group:100', type: 'project', summary: '另一条项目记录', content: '卡片和向量由主进程写入 SQLite。', importance: 4 }
  });
  assert.equal(second.status, 201, second.text);
  const duplicates = await request(port, `/api/living-memory/memories/${created.body.memory.id}/duplicates`);
  assert.equal(duplicates.status, 200, duplicates.text);
  assert.equal(duplicates.body?.entries?.some((item) => item.id === second.body.memory.id), true);
  const merged = await request(port, `/api/living-memory/memories/${created.body.memory.id}/merge`, {
    method: 'POST', body: { sourceIds: [second.body.memory.id], confirm: true }
  });
  assert.equal(merged.status, 200, merged.text);
  assert.equal(merged.body?.memory?.pinned, true);
  assert.equal(merged.body?.memory?.feedback, 'useful');
  const afterMerge = await request(port, `/api/living-memory/memories/${second.body.memory.id}`);
  assert.equal(afterMerge.status, 404, afterMerge.text);

  const archived = await request(port, `/api/living-memory/memories/${created.body.memory.id}/archive`, {
    method: 'POST', body: { confirm: true }
  });
  assert.equal(archived.status, 200, archived.text);
  const restored = await request(port, `/api/living-memory/memories/${created.body.memory.id}/restore`, {
    method: 'POST', body: { confirm: true }
  });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.body?.memory?.status, 'active');

  const recallTest = await request(port, '/api/living-memory/recall-test', {
    method: 'POST', body: { chatKey: 'owner-global', query: '长期记忆' }
  });
  assert.equal(recallTest.status, 200, recallTest.text);
  assert.equal(Array.isArray(recallTest.body?.entries), true);

  const deleteWithoutConfirm = await request(port, `/api/living-memory/memories/${created.body.memory.id}`, { method: 'DELETE' });
  assert.equal(deleteWithoutConfirm.status, 409, deleteWithoutConfirm.text);
});
