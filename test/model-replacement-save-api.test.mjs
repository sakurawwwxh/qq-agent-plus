import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('replacement saves are isolated from general settings and from other channels', async (t) => {
  const { base, root, request } = await bootConsole(t);
  const { getConfig, updateConfig, reloadConfig } = await import('../src/core/config.js');
  const { createModelReplacement } = await import('../src/core/model-replacement.js');
  const channels = ['chat', 'asr', 'tts', 'imageGen'];
  const entry = (model) => ({ source: 'catalog', providerId: 'test', model });
  updateConfig({
    providers: [{ id: 'test', displayName: 'Test', baseURL: 'https://test.example/v1', models: ['A', 'B', 'C'] }],
    providerKeys: { test: 'fake-test-key' },
    tts: { baseUrl: 'https://test.example/v1', voice: 'test-voice' },
    modelReplacement: Object.fromEntries(channels.map((channel) => [channel, {
      enabled: true, entries: [entry('A'), entry('B'), entry('C')],
      nextIndex: 1, revision: 8, lastModel: 'A', lastSwitchAt: 12345
    }]))
  });
  const snapshot = () => structuredClone(getConfig());
  const payload = (channel) => {
    const c = getConfig().modelReplacement[channel];
    return { channel, enabled: c.enabled, entries: structuredClone(c.entries), revision: c.revision };
  };

  await t.test('single-channel endpoint requires authentication', async () => {
    const res = await fetch(`${base}/api/model-replacement`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload('chat'))
    });
    assert.equal(res.status, 401);
  });
  await t.test('general save ignores even stale/forged replacement snapshots', async () => {
    const before = snapshot();
    const stale = structuredClone(before.modelReplacement);
    for (const c of Object.values(stale)) { c.enabled = false; c.entries = [null]; c.revision = 0; c.nextIndex = 0; }
    const result = await request('POST', '/api/config', { api: { temperature: 0.37 }, modelReplacement: stale });
    assert.equal(result.status, 200);
    assert.equal(getConfig().api.temperature, 0.37);
    assert.deepEqual(getConfig().modelReplacement, before.modelReplacement);
  });
  await t.test('each channel saves only itself and never changes the selected model/general settings', async () => {
    for (const channel of channels) {
      const before = snapshot();
      const result = await request('POST', '/api/model-replacement', { ...payload(channel), enabled: false });
      assert.equal(result.status, 200);
      assert.equal(result.body.channel, channel);
      assert.equal(result.body.chain.enabled, false);
      const expected = structuredClone(before);
      expected.modelReplacement[channel] = result.body.chain;
      assert.deepEqual(snapshot(), expected);
      assert.equal(result.body.chain.nextIndex, 1);
    }
  });
  await t.test('unchanged save preserves cursor, last switch and revision, including exhausted queues', async () => {
    for (const channel of channels) {
      const before = snapshot();
      assert.equal((await request('POST', '/api/model-replacement', payload(channel))).status, 200);
      assert.deepEqual(snapshot(), before);
    }
    updateConfig({ modelReplacement: { chat: { nextIndex: 3, enabled: false } } });
    const before = snapshot();
    assert.equal((await request('POST', '/api/model-replacement', payload('chat'))).status, 200);
    assert.deepEqual(snapshot(), before);
  });
  await t.test('re-enable/list edit restarts only its own chain; runtime progress makes old saves stale', async () => {
    const before = snapshot();
    const old = { ...payload('chat'), enabled: true };
    const saved = await request('POST', '/api/model-replacement', old);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.chain.nextIndex, 0);
    assert.equal(saved.body.chain.revision, before.modelReplacement.chat.revision + 1);
    const stale = payload('chat');
    createModelReplacement().advance('chat', getConfig());
    const advanced = snapshot();
    const rejected = await request('POST', '/api/model-replacement', stale);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'REPLACEMENT_CONFLICT');
    assert.deepEqual(snapshot(), advanced);
    const edited = await request('POST', '/api/model-replacement', { ...payload('chat'), entries: [entry('C'), entry('B')] });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.chain.nextIndex, 0);
    for (const channel of channels.slice(1)) assert.deepEqual(getConfig().modelReplacement[channel], before.modelReplacement[channel]);
  });
  await t.test('invalid or multi-channel payloads never write anything', async () => {
    for (const extra of [
      { channel: 'invalid' }, { nextIndex: 0 }, { api: { model: 'C' } },
      { modelReplacement: {} }, { revision: -1 }, { enabled: 'true' },
      { enabled: true, entries: [null, null, null] },
      { enabled: true, entries: [entry('missing')] }, { entries: 'invalid' }
    ]) {
      const before = snapshot();
      assert.equal((await request('POST', '/api/model-replacement', { ...payload('asr'), ...extra })).status, 400);
      assert.deepEqual(snapshot(), before);
    }
  });
  await t.test('concurrent saves to different channels do not overwrite each other', async () => {
    const result = await Promise.all(['asr', 'tts'].map((channel) => request('POST', '/api/model-replacement', {
      ...payload(channel), enabled: true, entries: [entry('B'), entry('C')]
    })));
    assert.deepEqual(result.map((r) => r.status), [200, 200]);
    for (const channel of ['asr', 'tts']) {
      assert.equal(getConfig().modelReplacement[channel].enabled, true);
      assert.deepEqual(getConfig().modelReplacement[channel].entries, [entry('B'), entry('C')]);
    }
    const before = snapshot();
    const disk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    for (const channel of channels) assert.deepEqual(disk.modelReplacement[channel], before.modelReplacement[channel]);
    reloadConfig();
    assert.deepEqual(getConfig().modelReplacement, before.modelReplacement);
  });
  await t.test('rule-only save changes only the selected triggers/revision, not progress or queue drafts', async () => {
    const triggers = { http402: false, http403: false, quota429: true, http401: true };
    for (const channel of channels) {
      const before = snapshot();
      const revision = before.modelReplacement[channel].revision;
      const result = await request('POST', '/api/model-replacement', { channel, triggers, revision });
      assert.equal(result.status, 200);
      const expected = structuredClone(before);
      expected.modelReplacement[channel].triggers = triggers;
      expected.modelReplacement[channel].revision += 1;
      assert.deepEqual(snapshot(), expected);
      const unchanged = snapshot();
      assert.equal((await request('POST', '/api/model-replacement', { channel, triggers, revision: revision + 1 })).status, 200);
      assert.deepEqual(snapshot(), unchanged);
      assert.equal((await request('POST', '/api/model-replacement', { channel, triggers, revision })).status, 409);
      assert.deepEqual(snapshot(), unchanged);
    }
    for (const extra of [
      { triggers: null }, { triggers: [] }, { triggers: {} }, { triggers: { ...triggers, http402: 'true' } },
      { triggers: { ...triggers, extra: true } }, { entries: [] }, { enabled: false }, { nextIndex: 0 }
    ]) {
      const before = snapshot();
      const result = await request('POST', '/api/model-replacement', { channel: 'chat', triggers,
        revision: before.modelReplacement.chat.revision, ...extra });
      assert.equal(result.status, 400); assert.deepEqual(snapshot(), before);
    }
    const disk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.deepEqual(disk.modelReplacement, snapshot().modelReplacement);
    reloadConfig(); assert.deepEqual(getConfig().modelReplacement, disk.modelReplacement);
  });
  await t.test('external config file conflict is not overwritten by an independent chain save', async () => {
    const file = path.join(root, 'config.json');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.api.model = 'external-edit';
    fs.writeFileSync(file, JSON.stringify(disk));
    const before = snapshot();
    const result = await request('POST', '/api/model-replacement', { ...payload('imageGen'), enabled: true });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'CONFIG_CONFLICT');
    assert.deepEqual(snapshot(), before);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).api.model, 'external-edit');
  });
});
