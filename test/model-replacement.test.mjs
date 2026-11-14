import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-model-replacement-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { normalizeModelReplacement, configureModelReplacement } = await import('../src/core/model-replacement-config.js');
const { createModelReplacement } = await import('../src/core/model-replacement.js');
const { replacementTargetPatch, replacementCatalog } = await import('../src/core/model-replacement-targets.js');
const { modelHttpError, isModelReplacementError } = await import('../src/llm/model-http-error.js');
const { DEFAULT_CONFIG, updateConfig, getConfig, reloadConfig } = await import('../src/core/config.js');
const { chatCompletionWithRetry } = await import('../src/llm/llm.js');
const { synthesizeSpeech } = await import('../src/llm/tts.js');
const { generateImage } = await import('../src/llm/image-gen.js');
const { runProvider } = await import('../src/tools/audio-transcribe.js');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const entry = (model, source = 'catalog') => ({ source, providerId: model, model });
function fixture(channel = 'chat', entries = ['A', 'B', 'C']) {
  const c = structuredClone(DEFAULT_CONFIG);
  c.providers = ['A', 'B', 'C', 'D'].map((id) => ({ id, displayName: id, baseURL: `https://${id.toLowerCase()}.example/v1`, models: [id] }));
  c.providerKeys = { A: 'key-A', B: 'key-B', C: 'key-C', D: 'key-D' };
  c.api = { ...c.api, provider: 'D', model: 'D', baseUrl: 'https://d.example/v1', apiKey: '', fallback: { enabled: false } };
  c.asr = { ...c.asr, provider: 'openai', model: 'D', baseUrl: 'https://d.example/v1', apiKey: 'key-D', apiKeyProvider: 'openai', apiKeyHost: 'd.example' };
  c.tts = { ...c.tts, enabled: true, provider: 'openai', model: 'D', baseUrl: 'https://d.example/v1', apiKey: 'key-D', apiKeyService: 'custom', voice: 'saved-voice', voices: { custom: 'saved-voice' }, voiceSlots: Object.fromEntries(['A', 'B', 'C', 'D'].map((id) => [JSON.stringify([`https://${id.toLowerCase()}.example/v1`, id]), `voice-${id}`])) };
  c.imageGen = { ...c.imageGen, enabled: true, model: 'D', baseUrl: 'https://d.example/v1', apiKey: 'key-D', apiKeyHost: 'd.example' };
  c.modelReplacement = normalizeModelReplacement({ [channel]: { enabled: true, entries: entries.map((m) => m ? entry(m) : null) } });
  return c;
}
function engine(initial) {
  let config = initial;
  const changes = [];
  const runner = createModelReplacement({
    read: () => config, now: () => 123,
    write: (patch) => {
      changes.push(patch);
      config = { ...config, ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'modelReplacement').map(([k, v]) => [k, v.__replace__ || v])),
        modelReplacement: { ...config.modelReplacement, ...patch.modelReplacement } };
      return config;
    }
  });
  return { ...runner, get: () => config, set: (v) => { config = v; }, changes };
}
const modelOf = (c, key) => (key === 'chat' ? c.api : c[key]).model;

test('default queues: four disabled queues, three empty positions, malformed fields and secrets stripped', () => {
  const n = normalizeModelReplacement({ chat: { enabled: true, entries: [null, { providerId: 'A', model: 'A', apiKey: 'never-store-this' }], nextIndex: -1, revision: NaN } });
  assert.deepEqual(Object.keys(n), ['chat', 'asr', 'tts', 'imageGen']);
  assert.equal(n.chat.nextIndex, 0);
  assert.equal(n.asr.enabled, false);
  assert.equal(n.asr.entries.length, 3);
  assert.equal(JSON.stringify(n).includes('never-store-this'), false);
  assert.equal(normalizeModelReplacement({ chat: { enabled: true, entries: [null] } }).chat.enabled, false);
  assert.equal(normalizeModelReplacement({ chat: { entries: [{ providerId: '__proto__', model: 'x' }] } }).chat.entries[0], null);
});

for (const channel of ['chat', 'asr', 'tts', 'imageGen']) {
  test(`${channel}: D403→A403→B403→C; persist selection and disable at C before C is attempted`, async () => {
    const initial = fixture(channel);
    const e = engine(initial); const attempts = [];
    const result = await e.run(channel, initial, async (cfg) => {
      const m = modelOf(cfg, channel); attempts.push(m);
      if (m === 'C') { assert.equal(e.get().modelReplacement[channel].enabled, false); return 'success'; }
      throw modelHttpError('forbidden', 403);
    });
    assert.equal(result, 'success');
    assert.deepEqual(attempts, ['D', 'A', 'B', 'C']);
    assert.equal(modelOf(e.get(), channel), 'C');
    assert.equal(e.get().modelReplacement[channel].nextIndex, 3);
    assert.equal(e.get().modelReplacement[channel].lastSwitchAt, 123);
    assert.equal(e.changes.length, 3);
    for (const other of ['chat', 'asr', 'tts', 'imageGen'].filter((k) => k !== channel)) assert.deepEqual(e.get().modelReplacement[other], initial.modelReplacement[other]);
  });
}

test('skip blanks; one target disables immediately; final 403 never loops', async () => {
  const initial = fixture('chat', [null, 'A', null]);const e = engine(initial);const tried = [];
  await assert.rejects(e.run('chat', initial, async (c) => { tried.push(c.api.model); throw modelHttpError('forbidden', 403); }), /forbidden/);
  assert.deepEqual(tried, ['D', 'A']);
  assert.equal(e.get().modelReplacement.chat.enabled, false);
  assert.equal(e.get().api.model, 'A');
});

test('duplicates/current-model positions remain bounded and do not resend an identical failure', async () => {
  const initial = fixture('chat', ['D', 'A', 'A', 'C']);const e = engine(initial);const tried = [];
  await e.run('chat', initial, async (c) => { tried.push(c.api.model);if (c.api.model === 'C') return true;throw modelHttpError('forbidden', 403); });
  assert.deepEqual(tried, ['D', 'A', 'C']);
});

test('temporary errors and error prose mentioning HTTP403 do not advance', async () => {
  for (const error of [modelHttpError('quota', 429), modelHttpError('server', 500), modelHttpError('unauthorized', 401), new Error('tool returned HTTP 403')]) {
    const c = fixture();const e = engine(c);
    await assert.rejects(e.run('chat', c, async () => { throw error; }), (v) => v === error);
    assert.equal(e.changes.length, 0);
  }
});

test('disabled queue does not switch; pre-aborted call neither sends nor switches', async () => {
  const c = fixture();c.modelReplacement.chat.enabled = false;const e = engine(c);
  await assert.rejects(e.run('chat', c, async () => { throw modelHttpError('403', 403); }));
  assert.equal(e.changes.length, 0);
  await assert.rejects(e.run('chat', c, () => { assert.fail('must not invoke'); }, { signal: AbortSignal.abort() }));
});

test('two concurrent D failures both retry A, never consume A and B separately', async () => {
  const c = fixture();const e = engine(c);let calls = 0;let release;
  const gate = new Promise((r) => { release = r; });
  const invoke = async (cfg) => {
    if (cfg.api.model === 'D') { if (++calls === 2) release(); await gate;throw modelHttpError('403', 403); }
    return cfg.api.model;
  };
  assert.deepEqual(await Promise.all([e.run('chat', c, invoke), e.run('chat', c, invoke)]), ['A', 'A']);
  assert.equal(e.changes.length, 1);
});

test('stale failure retries final disabled target, but a manually edited queue is not consumed', async () => {
  const c = fixture('chat', ['A']);const e = engine(c);
  e.advance('chat', c);
  assert.equal(e.advance('chat', c).api.model, 'A');
  const edited = structuredClone(e.get());edited.modelReplacement.chat.revision++;edited.modelReplacement.chat.entries = [entry('B')];edited.modelReplacement.chat.enabled = true;
  e.set(edited);
  assert.equal(e.advance('chat', c), null);
});

test('atomic persistence failure aborts before another provider is called', async () => {
  const c = fixture();let count = 0;
  const e = createModelReplacement({ read: () => c, write: () => { throw new Error('disk full'); } });
  await assert.rejects(e.run('chat', c, async () => { count++;throw modelHttpError('403', 403); }), /disk full/);
  assert.equal(count, 1);
});

test('editing/re-enabling resets progress, rejects stale saves and all-empty enabled chain', () => {
  const c = fixture().modelReplacement;c.chat.nextIndex = 2;c.chat.revision = 7;
  assert.throws(() => configureModelReplacement(c, { chat: { entries: [entry('A')], enabled: true, revision: 6 } }), (e) => e.httpStatus === 409);
  assert.throws(() => configureModelReplacement(c, { chat: { entries: [null], enabled: true, revision: 7 } }), /至少/);
  const n = configureModelReplacement(c, { chat: { entries: [null, entry('C')], enabled: true, revision: 7, nextIndex: 999 } });
  assert.equal(n.chat.nextIndex, 0);assert.equal(n.chat.revision, 8);
  const off = { ...c, chat: { ...c.chat, enabled: false } };
  assert.equal(configureModelReplacement(off, { chat: { ...off.chat, enabled: true } }).chat.nextIndex, 0);
});

test('catalog has all registered models; never reveals credentials', () => {
  const c = fixture();
  for (const ch of ['chat', 'asr', 'tts', 'imageGen']) {
    const catalog = replacementCatalog(c, ch);
    assert.deepEqual(catalog.filter((g) => g.id.startsWith('catalog:')).flatMap((g) => g.models.map((m) => m.model)), ['A', 'B', 'C', 'D']);
    assert.equal(JSON.stringify(catalog).includes('key-'), false);
  }
});

test('cross-provider selection resolves target keys, never sends a previous custom TTS key to another host', () => {
  const c = fixture();
  assert.equal(replacementTargetPatch(c, 'asr', entry('A')).asr.apiKey, 'key-A');
  assert.equal(replacementTargetPatch(c, 'tts', entry('A')).tts.apiKey, 'key-A');
  assert.equal(replacementTargetPatch(c, 'imageGen', entry('A')).imageGen.apiKey, 'key-A');
  delete c.providerKeys.A;c.tts.keys = { custom: 'old-secret' };
  assert.throws(() => replacementTargetPatch(c, 'tts', entry('A')), /密钥/);
  assert.throws(() => replacementTargetPatch(c, 'chat', entry('missing')), /删除/);
});

test('ASR native service reads matching owned credentials; TTS preset uses a saved/default target voice', () => {
  const c = fixture();c.asr.keys = { tencent: { secretId: 'id-tencent', secretKey: 'secret-tencent' } };
  const asr = replacementTargetPatch(c, 'asr', { source: 'service', providerId: 'tencent', model: '16k_zh' }).asr;
  assert.equal(asr.secretId, 'id-tencent');assert.equal(asr.provider, 'tencent');assert.equal(asr.apiKey, '');
  c.tts.keys = { openai: 'tts-openai-key' };
  const tts = replacementTargetPatch(c, 'tts', { source: 'service', providerId: 'openai', model: 'tts-1' }).tts;
  assert.equal(tts.provider, 'openai');assert.equal(tts.voice, 'alloy');assert.equal(tts.apiKey, 'tts-openai-key');
});

test('chat integration: chain runs before existing fallback; explicit per-task overrides never advance it', async (t) => {
  updateConfig(fixture());const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, req) => {
    const model = JSON.parse(req.body).model;seen.push(model);
    return model === 'C'
      ? new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
      : new Response('no', { status: 403 });
  });
  const out = await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'test' }] }, 0);
  assert.equal(out.model, 'C');assert.deepEqual(seen, ['D', 'A', 'B', 'C']);assert.equal(getConfig().api.model, 'C');
  updateConfig(fixture());seen.length = 0;
  await assert.rejects(chatCompletionWithRetry({ messages: [], overrides: { ...getConfig().api, apiKey: 'key-D' } }, 0), /403/);
  assert.deepEqual(seen, ['D']);assert.equal(getConfig().modelReplacement.chat.nextIndex, 0);
});

test('TTS integration: retry generation only, persist the new model and its key', async () => {
  updateConfig(fixture('tts', ['A']));const seen = [];
  const out = await synthesizeSpeech({ cfg: getConfig().tts, text: 'test', fetchFn: async (_url, req) => {
    const m = JSON.parse(req.body).model;seen.push([m, req.headers.authorization]);
    return m === 'D' ? new Response('no', { status: 403 }) : new Response(Buffer.from('audio'), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  assert.equal(out.buffer.toString(), 'audio');assert.deepEqual(seen, [['D', 'Bearer key-D'], ['A', 'Bearer key-A']]);
  assert.equal(getConfig().tts.model, 'A');assert.equal(getConfig().modelReplacement.tts.enabled, false);
});

test('ASR integration: native chunk processing switches only failed chunk; no replay of earlier paid chunks', async (t) => {
  const c = fixture('asr', ['A']);c.asr.provider = 'aliyun';c.asr.apiKeyProvider = 'aliyun';c.asr.apiKeyHost = '';updateConfig(c);
  const seen = [];let first = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(String(url));
    if (String(url).includes('d.example') && first) { first = false;return new Response(JSON.stringify({ choices: [{ message: { content: 'first' } }] })); }
    if (String(url).includes('d.example')) return new Response('no', { status: 403 });
    return new Response(JSON.stringify({ text: 'second' }));
  });
  const text = await runProvider(getConfig(), Buffer.alloc(32000 * 56));
  assert.match(text, /first/);assert.match(text, /second/);
  assert.equal(seen.filter((u) => u.includes('d.example')).length, 2);
  assert.equal(seen.filter((u) => u.includes('a.example')).length, 1);
  assert.equal(getConfig().asr.model, 'A');
});

test('image integration: creation 403 switches; task-poll 403 never creates another billable task', async () => {
  updateConfig(fixture('imageGen', ['A']));const seen = [];
  const out = await generateImage({ cfg: getConfig(), apiCfg: getConfig().api, apiKey: 'key-D', prompt: 'cat', fetchFn: async (_url, req) => {
    const m = JSON.parse(req.body).model;seen.push(m);
    return m === 'D' ? new Response('no', { status: 403 }) : new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }));
  } });
  assert.equal(out.buffer.toString(), 'image');assert.deepEqual(seen, ['D', 'A']);
  const c = fixture('imageGen', ['A']);c.imageGen.baseUrl = 'https://api-inference.modelscope.cn/v1';c.imageGen.apiKeyHost = 'api-inference.modelscope.cn';updateConfig(c);
  let creates = 0;
  await assert.rejects(generateImage({ cfg: getConfig(), apiCfg: getConfig().api, prompt: 'cat', modelscopePollMs: 1, fetchFn: async (_url, req) => {
    if (req.method === 'POST') { creates++;return new Response(JSON.stringify({ task_id: 'already-created' })); }
    return new Response('no', { status: 403 });
  } }), /可能.*计费/);
  assert.equal(creates, 1);assert.equal(getConfig().modelReplacement.imageGen.nextIndex, 0);
});

test('persisted queue cursor and final disabled flag survive reload/migration', async () => {
  const c = fixture('chat', ['A']);updateConfig(c);
  const { advance } = createModelReplacement();advance('chat', getConfig());
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.api.model, 'A');assert.equal(saved.modelReplacement.chat.enabled, false);
  reloadConfig();
  assert.equal(getConfig().modelReplacement.chat.nextIndex, 1);
});

for (const succeeds of [true, false]) {
  test(`ASR long single-upload→short-chunk provider: earlier paid chunks are never replayed (${succeeds})`, async (t) => {
    const c = fixture('asr', ['A', 'B']);
    c.modelReplacement.asr.entries[0] = { source: 'service', providerId: 'aliyun', model: 'qwen3-asr-flash' };
    c.asr.keys = { aliyun: { apiKey: 'native-aliyun-key' } };
    updateConfig(c);
    const seen = [];let nativeCount = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
      const u = String(url);
      if (u.includes('d.example')) { seen.push('D');return new Response('forbidden', { status: 403 }); }
      if (u.includes('dashscope')) {
        seen.push('aliyun');nativeCount++;
        return nativeCount === 1
          ? new Response(JSON.stringify({ choices: [{ message: { content: 'first' } }] }))
          : new Response('forbidden', { status: 403 });
      }
      seen.push('B');
      return succeeds ? new Response(JSON.stringify({ text: 'second' })) : new Response('forbidden', { status: 403 });
    });
    const run = runProvider(getConfig(), Buffer.alloc(32000 * 56));
    if (succeeds) assert.match(await run, /first.*second/s);
    else await assert.rejects(run, /403/);
    assert.deepEqual(seen, ['D', 'aliyun', 'aliyun', 'B']);
    assert.equal(getConfig().modelReplacement.asr.enabled, false);
  });
}

test('different custom TTS hosts never share an unqualified custom voice; endpoint/model profiles are independent', () => {
  const c = fixture();
  assert.equal(replacementTargetPatch(c, 'tts', entry('A')).tts.voice, 'voice-A');
  delete c.tts.voiceSlots;
  assert.throws(() => replacementTargetPatch(c, 'tts', entry('A')), /音色/);
});

test('manual credential rotation invalidates an in-flight old 403 without consuming the next model', () => {
  const c = fixture();const e = engine(c);const rotated = structuredClone(c);
  rotated.providerKeys.D = 'new-key-D';e.set(rotated);
  assert.equal(e.advance('chat', c), null);assert.equal(e.changes.length, 0);
});


test('chat integration: after final replacement also returns 403, existing fallback runs without restoring the exhausted chain', async (t) => {
  const cfg = fixture();
  cfg.api.fallback = { enabled: true, baseUrl: 'https://fallback.example/v1', model: 'fallback-model', apiKey: 'fallback-key' };
  updateConfig(cfg);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, req) => {
    const model = JSON.parse(req.body).model;seen.push(model);
    return model === 'fallback-model'
      ? new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: 'fallback ok' } }] }))
      : new Response('no', { status: 403 });
  });
  const out = await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'test' }] }, 0);
  assert.deepEqual(seen, ['D', 'A', 'B', 'C', 'fallback-model']);
  assert.equal(out.viaFallback, true);
  assert.equal(getConfig().api.model, 'C');
  assert.equal(getConfig().modelReplacement.chat.enabled, false);
  assert.equal(getConfig().modelReplacement.chat.nextIndex, 3);
});


test('trigger defaults migrate without changing cursor; rule-only saves preserve queue progress', () => {
  const legacy = { ...fixture().modelReplacement.chat, nextIndex: 2, revision: 9, lastModel: 'B', lastSwitchAt: 123 };
  delete legacy.triggers;
  const normalized = normalizeModelReplacement({ chat: legacy });
  assert.deepEqual(normalized.chat.triggers, { http402: true, http403: true, quota429: true, http401: false });
  for (const key of ['nextIndex', 'revision', 'lastModel', 'lastSwitchAt', 'entries', 'enabled']) assert.deepEqual(normalized.chat[key], legacy[key]);
  const triggers = { http402: false, http403: false, quota429: true, http401: true };
  const edited = configureModelReplacement(normalized, { chat: { triggers, revision: 9 } });
  assert.deepEqual(edited.chat, { ...normalized.chat, triggers, revision: 10 });
  assert.deepEqual(configureModelReplacement(edited, { chat: { triggers, revision: 10 } }), edited);
  const next = configureModelReplacement(edited, { chat: { enabled: true, entries: [entry('C')], revision: 10 } });
  assert.deepEqual(next.chat.triggers, triggers);
});

test('only real model status + exact quota identifiers trigger; never error prose or ordinary rate limits', () => {
  for (const status of [402, 403]) assert.equal(isModelReplacementError(modelHttpError('failure', status)), true);
  assert.equal(isModelReplacementError(modelHttpError('failure', 401)), false);
  assert.equal(isModelReplacementError(modelHttpError('failure', 401), { http401: true }), true);
  assert.equal(isModelReplacementError(modelHttpError('failure', 403), { http403: false }), false);
  for (const body of [
    { error: { code: 'insufficient_quota' } }, { error: { type: 'insufficient_quota' } },
    { code: 'insufficient_balance' }, { error: { code: 'billing_hard_limit_reached' } }
  ]) {
    const error = modelHttpError('failure', 429, JSON.stringify(body));
    assert.equal(isModelReplacementError(error), true);
    assert.equal(isModelReplacementError(error, { quota429: false }), false);
  }
  for (const body of [null, 'insufficient_quota', '<html>quota</html>',
    { error: { code: 'rate_limit_exceeded', message: 'insufficient_quota' } },
    { error: { code: 'quota_exceeded' } }, { code: { insufficient_quota: true } }]) {
    assert.equal(isModelReplacementError(modelHttpError('余额不足 insufficient_quota HTTP 402', 429, body)), false);
  }
  for (const status of [200, 400, 404, 500, 503]) assert.equal(isModelReplacementError(modelHttpError('failure', status, { error: { code: 'insufficient_quota' } })), false);
  assert.equal(isModelReplacementError(Object.assign(new Error('HTTP 402'), { status: 402 })), false);
});

for (const channel of ['chat', 'asr', 'tts', 'imageGen']) {
  test(`${channel}: configured 402 / quota429 / optional 401 advance; disabled rules never consume a position`, async () => {
    for (const [status, body] of [[402, null], [403, null], [429, { error: { code: 'insufficient_quota' } }], [401, null]]) {
      const c = fixture(channel, ['A']); c.modelReplacement[channel].triggers.http401 = true;
      const e = engine(c);
      const result = await e.run(channel, c, async (cfg) => {
        if (modelOf(cfg, channel) === 'D') throw modelHttpError('rejected', status, body);
        return modelOf(cfg, channel);
      });
      assert.equal(result, 'A'); assert.equal(e.changes.length, 1);
      const off = fixture(channel); off.modelReplacement[channel].triggers = { http402: false, http403: false, quota429: false, http401: false };
      const stopped = engine(off);
      await assert.rejects(stopped.run(channel, off, async () => { throw modelHttpError('rejected', status, body); }));
      assert.equal(stopped.changes.length, 0);
    }
  });
}

test('chat quota429 bypasses transient retry and switches; ordinary429 uses fallback without consuming chain', async (t) => {
  updateConfig(fixture('chat', ['A'])); const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, req) => {
    const model = JSON.parse(req.body).model; seen.push(model);
    return model === 'D'
      ? new Response(JSON.stringify({ error: { message: 'x'.repeat(600), code: 'insufficient_quota' } }), { status: 429 })
      : new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  assert.equal((await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'test' }] })).model, 'A');
  assert.deepEqual(seen, ['D', 'A']);
  const cfg = fixture('chat', ['A']);
  cfg.api.fallback = { enabled: true, baseUrl: 'https://fallback.example/v1', model: 'F', apiKey: 'fallback-key' };
  updateConfig(cfg); seen.length = 0;
  t.mock.method(globalThis, 'fetch', async (_url, req) => {
    const model = JSON.parse(req.body).model; seen.push(model);
    return model === 'D' ? new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 })
      : new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  assert.equal((await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'test' }] }, 0)).viaFallback, true);
  assert.deepEqual(seen, ['D', 'F']); assert.equal(getConfig().modelReplacement.chat.nextIndex, 0);
});

test('media adapters pass structured quota codes, retaining generation-only safety', async () => {
  const errorBody = JSON.stringify({ error: { message: 'x'.repeat(600), code: 'insufficient_quota' } });
  updateConfig(fixture('tts', ['A'])); const voices = [];
  const tts = await synthesizeSpeech({ text: 'test', fetchFn: async (_url, req) => {
    const model = JSON.parse(req.body).model; voices.push(model);
    return model === 'D' ? new Response(errorBody, { status: 429 }) : new Response(Buffer.from('voice'));
  } });
  assert.equal(tts.buffer.toString(), 'voice'); assert.deepEqual(voices, ['D', 'A']);
  updateConfig(fixture('imageGen', ['A'])); const images = [];
  const image = await generateImage({ cfg: getConfig(), apiCfg: getConfig().api, apiKey: 'key-D', prompt: 'cat', fetchFn: async (_url, req) => {
    const model = JSON.parse(req.body).model; images.push(model);
    return model === 'D' ? new Response(errorBody, { status: 429 })
      : new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }));
  } });
  assert.equal(image.buffer.toString(), 'image'); assert.deepEqual(images, ['D', 'A']);
});


test('ASR structured quota429 switches only the failed chunk', async (t) => {
  const cfg = fixture('asr', ['A']); cfg.asr.provider = 'aliyun'; cfg.asr.apiKeyProvider = 'aliyun'; cfg.asr.apiKeyHost = ''; updateConfig(cfg);
  const seen = []; let first = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(String(url));
    if (String(url).includes('d.example') && first) {
      first = false; return new Response(JSON.stringify({ choices: [{ message: { content: 'first' } }] }));
    }
    if (String(url).includes('d.example')) return new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 });
    return new Response(JSON.stringify({ text: 'second' }));
  });
  assert.match(await runProvider(getConfig(), Buffer.alloc(32000 * 56)), /first.*second/);
  assert.equal(seen.filter((u) => u.includes('d.example')).length, 2);
  assert.equal(seen.filter((u) => u.includes('a.example')).length, 1);
});

test('native TTS adapters preserve friendly errors and classify HTTP failures, not business errors in HTTP200', async () => {
  const { synthesizeVolc, synthesizeMinimax } = await import('../src/llm/tts.js');
  const { synthesizeDoubao } = await import('../src/llm/tts-doubao.js');
  const { synthesizeMimo } = await import('../src/llm/tts-mimo.js');
  for (const invoke of [synthesizeVolc, synthesizeMinimax, synthesizeDoubao, synthesizeMimo]) {
    for (const status of [200, 401, 402, 403, 429]) {
      await assert.rejects(invoke({ cfg: { apiKey: 'fake-key', appId: '12345', groupId: 'group', voice: 'v' }, text: 'test',
        fetchFn: async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status })
      }), (error) => {
        assert.equal(isModelReplacementError(error), [402, 403, 429].includes(status));
        return true;
      });
    }
  }
});

test('image task-poll errors never resubmit a billable creation for any selected condition', async () => {
  for (const status of [401, 402, 403, 429]) {
    const cfg = fixture('imageGen', ['A']); cfg.imageGen.baseUrl = 'https://api-inference.modelscope.cn/v1';
    cfg.imageGen.apiKeyHost = 'api-inference.modelscope.cn'; cfg.modelReplacement.imageGen.triggers.http401 = true; updateConfig(cfg);
    let creates = 0;
    await assert.rejects(generateImage({ cfg: getConfig(), apiCfg: getConfig().api, prompt: 'cat', modelscopePollMs: 1,
      fetchFn: async (_url, req) => {
        if (req.method === 'POST') { creates++; return new Response(JSON.stringify({ task_id: 'already-created' })); }
        return new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status });
      }
    }), /可能.*计费/);
    assert.equal(creates, 1); assert.equal(getConfig().modelReplacement.imageGen.nextIndex, 0);
  }
});


test('final model quota429 goes to fallback without repeated futile calls or restarting the chain', async (t) => {
  const cfg = fixture('chat', ['A']);
  cfg.api.fallback = { enabled: true, baseUrl: 'https://fallback.example/v1', model: 'F', apiKey: 'fallback-key' }; updateConfig(cfg);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, req) => {
    const model = JSON.parse(req.body).model; seen.push(model);
    return model === 'F'
      ? new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
      : new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 });
  });
  assert.equal((await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'test' }] })).viaFallback, true);
  assert.deepEqual(seen, ['D', 'A', 'F']); assert.equal(getConfig().api.model, 'A');
  assert.equal(getConfig().modelReplacement.chat.enabled, false);
});
