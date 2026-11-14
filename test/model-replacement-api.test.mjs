import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-model-replacement-api-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { createModelReplacement } = await import('../src/core/model-replacement.js');

test('authenticated model replacement config/catalog API: validation, no secrets, stale-save protection', async (t) => {
  const probe = http.createServer();await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;await new Promise((r) => probe.close(r));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: 'test-console-token' };
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  for (const k of ['proactive','dailyMoments','qzoneInteractions','groupDigest','adminBriefing','reminders','autoUpdate']) cfg[k] = { ...cfg[k], enabled: false };
  cfg.api = { ...cfg.api, baseUrl: 'https://d.example/v1', provider: 'D', model: 'D' };
  cfg.providers = ['A','D'].map((id) => ({ id, displayName: id, baseURL: `https://${id.toLowerCase()}.example/v1`, models: [id] }));
  cfg.providerKeys = { A: 'private-provider-key-A', D: 'private-provider-key-D' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop();fs.rmSync(dir, { recursive: true, force: true }); });
  await app.start();
  const request = async (route, body, authenticated = true) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-console-token': 'test-console-token' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await request('/api/model-replacement/catalog', null, false)).status, 401);
  const catalog = await request('/api/model-replacement/catalog');
  assert.equal(catalog.status, 200);assert.equal(catalog.body.chat.length, 2);
  assert.equal(JSON.stringify(catalog.body).includes('private-provider-key'), false);
  // Saving two custom endpoints archives each voice by exact endpoint/model,
  // ignoring a stale client-supplied voiceSlots map.
  const slot = (host, model) => JSON.stringify([host, model]);
  let voiceSaved = await request('/api/config', { tts: { service: 'custom', provider: 'openai', baseUrl: 'https://voice-a.example/v1', model: 'voice-model-a', voice: 'voice-a' } });
  assert.equal(voiceSaved.status, 200, JSON.stringify(voiceSaved.body));
  voiceSaved = await request('/api/config', { tts: { service: 'custom', provider: 'openai', baseUrl: 'https://voice-b.example/v1', model: 'voice-model-b', voice: 'voice-b', voiceSlots: { forged: 'not-accepted' } } });
  assert.equal(voiceSaved.status, 200, JSON.stringify(voiceSaved.body));
  assert.equal(getConfig().tts.voiceSlots[slot('https://voice-a.example/v1', 'voice-model-a')], 'voice-a');
  assert.equal(getConfig().tts.voiceSlots[slot('https://voice-b.example/v1', 'voice-model-b')], 'voice-b');
  assert.equal(getConfig().tts.voiceSlots.forged, undefined);
  const entry = { source: 'catalog', providerId: 'A', model: 'A' };
  const chainBody = { channel: 'chat', enabled: true, entries: [entry, null, null], revision: 0 };
  // General settings must ignore replacement queues, including forged cursors.
  let saved = await request('/api/config', { modelReplacement: { chat: { ...chainBody, nextIndex: 200 } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(getConfig().modelReplacement.chat.enabled, false);
  assert.equal((await request('/api/model-replacement', { ...chainBody, nextIndex: 200 })).status, 400);
  saved = await request('/api/model-replacement', chainBody);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(getConfig().modelReplacement.chat.nextIndex, 0);
  assert.equal(JSON.stringify(saved.body).includes('private-provider-key'), false);
  const stale = getConfig().modelReplacement.chat;
  createModelReplacement().advance('chat', getConfig());
  assert.equal(getConfig().api.model, 'A');assert.equal(getConfig().modelReplacement.chat.enabled, false);
  saved = await request('/api/model-replacement', {
    channel: 'chat', enabled: true, entries: stale.entries, revision: stale.revision
  });
  assert.equal(saved.status, 409);assert.equal(getConfig().api.model, 'A');
  const rev = getConfig().modelReplacement.chat.revision;
  assert.equal((await request('/api/model-replacement', { ...chainBody, entries: [null], revision: rev })).status, 400);
  assert.equal((await request('/api/model-replacement', { ...chainBody, entries: [{ ...entry, model: 'deleted' }], revision: rev })).status, 400);
  const status = await request('/api/status');
  assert.equal(status.body.modelReplacement.chat.enabled, false);
  assert.equal(status.body.modelReplacement.chat.lastModel, 'A');
  assert.equal(JSON.stringify(status.body).includes('private-provider-key'), false);
});
