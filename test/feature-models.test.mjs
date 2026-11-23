import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-feature-models-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const {
  normalizeFeatureModels, featureModelStatus, featureModelOverrides, FEATURE_MODEL_KEYS
} = await import('../src/core/feature-models.js');
const { chatCompletion } = await import('../src/llm/llm.js');

function cfg() {
  const c = structuredClone(DEFAULT_CONFIG);
  c.runtime = { ...c.runtime, mode: 'active' };
  c.api = { ...c.api, baseUrl: 'https://main.example/v1', provider: 'main', model: 'main-model', apiKey: 'main-key', extraBody: { authorization: 'main-secret' } };
  c.providers = [
    { id: 'main', displayName: 'Main', baseURL: 'https://main.example/v1', models: ['main-model'] },
    { id: 'cheap', displayName: 'Cheap', baseURL: 'https://cheap.example/v1', models: ['cheap-model'] }
  ];
  c.providerKeys = { main: 'main-key', cheap: 'cheap-key' };
  c.featureModels = normalizeFeatureModels({});
  return c;
}

test('feature model config normalizes all six tasks and is disabled by default', () => {
  const normalized = normalizeFeatureModels({ 'group-digest': { enabled: true, providerId: ' cheap ', model: ' cheap-model ' } });
  assert.deepEqual(Object.keys(normalized), [...FEATURE_MODEL_KEYS]);
  assert.equal(normalized['group-digest'].enabled, true);
  assert.equal(normalized['group-digest'].providerId, 'cheap');
  assert.equal(normalized['group-digest'].model, 'cheap-model');
  assert.equal(normalized['daily-moments'].enabled, false);
});

test('status/overrides refuse missing providers, models or keys instead of silently using the main channel', () => {
  const c = cfg();
  c.featureModels = normalizeFeatureModels({ 'group-digest': { enabled: true, providerId: 'missing', model: 'x' } });
  assert.equal(featureModelStatus(c, 'group-digest').ready, false);
  assert.match(featureModelStatus(c, 'group-digest').reason, /删除/);
  assert.equal(featureModelOverrides(c, 'group-digest'), null);

  c.featureModels = normalizeFeatureModels({ 'group-digest': { enabled: true, providerId: 'cheap', model: '' } });
  assert.match(featureModelStatus(c, 'group-digest').reason, /模型/);

  c.providerKeys = { main: 'main-key' };
  c.featureModels = normalizeFeatureModels({ 'group-digest': { enabled: true, providerId: 'cheap', model: 'cheap-model' } });
  assert.match(featureModelStatus(c, 'group-digest').reason, /密钥/);
  assert.equal(featureModelOverrides(c, 'group-digest'), null);
  // 顶层 api.apiKey 是手动模式遗留值，绝不能因为 provider id 相同就发给后台任务。
  c.api = { ...c.api, provider: 'cheap', apiKey: 'legacy-main-key' };
  assert.equal(featureModelStatus(c, 'group-digest').ready, false);
  assert.equal(featureModelOverrides(c, 'group-digest'), null);
});

test('feature overrides point at the provider, carry its key, and never carry main extraBody', () => {
  const c = cfg();
  c.featureModels = normalizeFeatureModels({ 'group-digest': { enabled: true, providerId: 'cheap', model: 'cheap-model' } });
  const overrides = featureModelOverrides(c, 'group-digest');
  assert.equal(overrides.baseUrl, 'https://cheap.example/v1');
  assert.equal(overrides.model, 'cheap-model');
  assert.equal(overrides.apiKey, 'cheap-key');
  assert.deepEqual(overrides.extraBody, {});
  assert.deepEqual(overrides.thinkingParams, {}, '跨 host 不继承主渠道思考参数');
});

test('chatCompletion routes a feature task to its own model without touching the main replacement chain', async (t) => {
  const c = cfg();
  c.featureModels = normalizeFeatureModels({ 'group-digest': { enabled: true, providerId: 'cheap', model: 'cheap-model' } });
  setRuntimeConfig(c);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({
      choices: [{ message: { content: '日报正文' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  });
  const response = await chatCompletion({
    messages: [{ role: 'user', content: '写日报' }],
    temperature: 0.7,
    purpose: 'write',
    feature: 'group-digest'
  });
  assert.equal(response.message.content, '日报正文');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/cheap\.example\/v1\/chat\/completions$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'cheap-model');
  assert.equal(body.authorization, undefined, '主渠道 extraBody 不能跟到后台任务');
  assert.equal(calls[0].options.headers.authorization, 'Bearer cheap-key');
  assert.notEqual(calls[0].url.includes('main.example'), true);
});
