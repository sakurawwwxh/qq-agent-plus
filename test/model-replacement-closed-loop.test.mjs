import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-model-replacement-loop-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { DEFAULT_CONFIG } = await import('../src/core/config.js');
const { normalizeModelReplacement, resetModelReplacementProgress } = await import('../src/core/model-replacement-config.js');
const { replacementReadiness, replacementTargetPatch } = await import('../src/core/model-replacement-targets.js');
const { createModelReplacement } = await import('../src/core/model-replacement.js');
const { modelHttpError } = await import('../src/llm/model-http-error.js');

const entry = (model) => ({ source: 'catalog', providerId: model, model });

function fixture(entries = ['A', 'B']) {
  const c = structuredClone(DEFAULT_CONFIG);
  c.providers = ['A', 'B', 'C'].map((id) => ({ id, displayName: id, baseURL: `https://${id.toLowerCase()}.example/v1`, models: [id] }));
  c.providerKeys = { A: 'key-A', B: 'key-B' };
  c.api = { ...c.api, provider: 'C', model: 'C', baseUrl: 'https://c.example/v1', apiKey: '' };
  c.modelReplacement = normalizeModelReplacement({ chat: { enabled: true, entries: entries.map(entry) } });
  return c;
}

test('readiness reports each target separately and does not leak credentials', () => {
  const c = fixture();
  c.modelReplacement.chat.entries = [entry('A'), entry('missing'), null];
  const result = replacementReadiness(c, 'chat');
  assert.equal(result.total, 2);
  assert.equal(result.readyCount, 1);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.entries[0].ready, true);
  assert.equal(result.entries[1].ready, false);
  assert.match(result.entries[1].reason, /删除/);
  assert.equal(result.entries[2].empty, true);
  assert.equal(JSON.stringify(result).includes('key-A'), false);
});

test('TTS readiness exposes the resolved voice and an explicit per-target voice wins', () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.tts = { ...c.tts, enabled: true, provider: 'openai', baseUrl: 'https://other.example/v1', model: 'm', apiKey: 'old', keys: { siliconflow: 'tts-key' }, voices: {}, voiceSlots: {} };
  const target = { source: 'service', providerId: 'siliconflow', model: 'FunAudioLLM/CosyVoice2-0.5B', voice: 'bella' };
  const patch = replacementTargetPatch(c, 'tts', target);
  assert.equal(patch.tts.voice, 'FunAudioLLM/CosyVoice2-0.5B:bella');
  c.modelReplacement = normalizeModelReplacement({ tts: { enabled: true, entries: [target] } });
  const result = replacementReadiness(c, 'tts');
  assert.equal(result.entries[0].ready, true);
  assert.equal(result.entries[0].voice, 'FunAudioLLM/CosyVoice2-0.5B:bella');
});

test('advance records bounded switch history with reason and previous model', () => {
  const initial = fixture();
  let config = initial;
  const runner = createModelReplacement({
    read: () => config, now: () => 500,
    write: (patch) => {
      config = {
        ...config,
        ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'modelReplacement').map(([key, value]) => [key, value.__replace__ || value])),
        modelReplacement: { ...config.modelReplacement, ...patch.modelReplacement }
      };
      return config;
    }
  });
  const next = runner.advance('chat', config, modelHttpError('forbidden', 403));
  assert.ok(next);
  const chain = next.modelReplacement.chat;
  assert.equal(chain.nextIndex, 1);
  assert.equal(chain.lastModel, 'A');
  assert.equal(chain.history.length, 1);
  assert.deepEqual(chain.history[0], { at: 500, model: 'A', fromModel: '', status: 403, index: 0 });
  // 第二跳的 fromModel 会接上上一跳，历史新→旧。
  const second = runner.advance('chat', next, modelHttpError('payment required', 402));
  assert.ok(second);
  const history = second.modelReplacement.chat.history;
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { at: 500, model: 'B', fromModel: 'A', status: 402, index: 1 });
});

test('reset progress keeps entries/history but rewinds the cursor and clears last switch summary', () => {
  const c = fixture(['A', 'B']);
  c.modelReplacement.chat.nextIndex = 2;
  c.modelReplacement.chat.lastModel = 'B';
  c.modelReplacement.chat.lastSwitchAt = 900;
  c.modelReplacement.chat.history = [{ at: 900, model: 'B', fromModel: 'A', status: 403, index: 1 }];
  c.modelReplacement.chat.revision = 4;
  const reset = resetModelReplacementProgress(c.modelReplacement, 'chat', 4);
  assert.equal(reset.nextIndex, 0);
  assert.equal(reset.enabled, true);
  assert.equal(reset.lastModel, '');
  assert.equal(reset.lastSwitchAt, 0);
  assert.equal(reset.history.length, 1);
  assert.equal(reset.revision, 5);
  assert.throws(() => resetModelReplacementProgress(c.modelReplacement, 'chat', 3), /后台变化/);
});
