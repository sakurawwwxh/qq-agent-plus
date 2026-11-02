// #85 停服竞态：慢富化正在等待时 stop() 不能陪它等完预算，
// 也不能把 deferred 行留在库里（应当立即按占位符放行）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ingest-stop-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.QQ_AGENT_SKIP_INDEX_WARM = '1';
process.env.QQ_AGENT_SKIP_NETWORK_PROBES = '1';
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { ChatStore } = await import('../src/core/store.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime = { ...cfg.runtime, mode: 'active' };
cfg.allow = { ...cfg.allow, groups: ['1'], private: [] };
cfg.messageTypes = { ...cfg.messageTypes, enrichTimeoutMs: 5000 };
cfg.api = { ...cfg.api, baseUrl: '', apiKey: '', model: 'mock-model' };
updateConfig(cfg);

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('stop() 会中止慢富化并放行 deferred，而不是等满 5 秒', async () => {
  const port = await freePort();
  updateConfig({ server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port, token: '' } });
  const app = createApp({ log: () => {} });
  app.onebot.selfInfo = { user_id: 888, nickname: 'bot' };
  app.onebot.getMsg = () => new Promise(() => {});
  app.orchestrator.onIncoming = () => {};
  await app.start();

  await app.onebot.onEvent({
    post_type: 'message', message_type: 'group', group_id: 1, message_id: 7001,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 42, nickname: '群友' },
    message: [
      { type: 'reply', data: { id: '9000' } },
      { type: 'text', data: { text: '看这个' } }
    ]
  });
  const before = app.store.recent('group:1', { limit: 10 }).find((row) => Number(row.mid) === 7001);
  assert.equal(before.state, 'deferred');

  const started = Date.now();
  await app.stop();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `stop 不应等满富化预算，实际 ${elapsed}ms`);

  // stop 关闭旧库后重新打开，确认行已经被放行而不是永远 deferred。
  const reopened = new ChatStore(0, { dataDir: root, filename: 'messages.sqlite' });
  try {
    const after = reopened.getMessage('group:1', before.id);
    assert.equal(after.state, 'pending', '停服时应按占位符放行');
    assert.match(after.text, /\[引用消息\]看这个/);
  } finally {
    reopened.close();
  }
});
