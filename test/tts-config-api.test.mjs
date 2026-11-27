// TTS 配置接口的 Key 归属与脱敏（2026-09-29 审查 P0/P1 的回归）：
//  - 「自定义/自建」预设的 Key 必须落 keys.custom（之前落 keys.openai，运行时读不到，
//    还会把硅基流动的 Key 发给自建地址）；
//  - /api/config 不得下发 tts.keys 明文（SECRET_KEY_PATTERN 匹配不到 keys 这个字段名）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-config-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { ttsServiceOf, ttsKeyFor } = await import('../src/llm/tts-presets.js');
const { synthesizeSpeech } = await import('../src/llm/tts.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('自建网关的 Key 存进 keys.custom，运行时也按 custom 取；/api/config 不下发明文', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.api = { ...cfg.api, baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' };
  cfg.tts = { ...cfg.tts, enabled: true, baseUrl: 'https://my-gw.example/v1', model: 'cosy', voice: 'a' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  // 1) 用「自定义/自建」预设保存（provider=openai、地址不在预设表里、带 service=custom）
  const saved = await request('/api/config', {
    method: 'POST',
    body: { tts: { ...getConfig().tts, service: 'custom', provider: 'openai', apiKeyInput: 'sk-selfhosted' } }
  });
  assert.equal(saved.status, 200);
  // Key 明文不出现在响应里的任何地方
  assert.equal(JSON.stringify(saved.body).includes('sk-selfhosted'), false, '/api/config 响应不得含明文 Key');
  assert.deepEqual(saved.body.config?.tts?.keys, {}, 'keys 必须整体脱敏');
  assert.ok(saved.body.config?.tts?.keyServices?.includes('custom'), 'keyServices 要说明 custom 存过');
  // 落盘归属正确
  assert.equal(getConfig().tts.keys.custom, 'sk-selfhosted');
  assert.equal(getConfig().tts.keys.openai, undefined, '不能再落 keys.openai（旧 bug）');

  // 2) 运行端按同一归属取 Key：未知 openai 地址 → custom 服务
  assert.equal(ttsServiceOf({ provider: 'openai', baseUrl: 'https://my-gw.example/v1' }).id, 'custom');
  assert.equal(ttsKeyFor({ provider: 'openai', baseUrl: 'https://my-gw.example/v1', apiKey: '', keys: { custom: 'sk-selfhosted', siliconflow: 'sk-sf' } }), 'sk-selfhosted');

  // 3) 端到端：发出去的 Authorization 用的是自建那把，不是硅基流动的
  const calls = [];
  await synthesizeSpeech({
    cfg: { ...getConfig().tts, keys: { custom: 'sk-selfhosted', siliconflow: 'sk-sf' } },
    text: '归属测试',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), auth: req.headers.authorization });
      return new Response(Buffer.from('ID3ok'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
  });
  assert.match(calls[0].url, /^https:\/\/my-gw\.example\/v1\/audio\/speech$/);
  assert.equal(calls[0].auth, 'Bearer sk-selfhosted');

  // 4) 切到自定义且地址为空：不能把这次保存归到上一家（voice/Key 都会存错）
  const emptyCustom = await request('/api/config', {
    method: 'POST',
    body: {
      tts: {
        enabled: true, service: 'custom', provider: 'openai', baseUrl: '',
        model: 'custom-model', voice: 'custom-voice', apiKeyInput: 'sk-custom-empty'
      }
    }
  });
  assert.equal(emptyCustom.status, 200, JSON.stringify(emptyCustom.body));
  assert.equal(getConfig().tts.voices.custom, 'custom-voice');
  assert.equal(getConfig().tts.keys.custom, 'sk-custom-empty');
});

test('custom TTS Key 绑定主机：换地址不填新 Key 不会复用旧 Key', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.tts = {
    ...cfg.tts, enabled: true, provider: 'openai', baseUrl: 'https://gw-a.example/v1',
    model: 'cosy', voice: 'a', apiKey: '', apiKeyHost: 'gw-a.example', keys: { custom: 'sk-a' }
  };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start();
  const request = async (body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  const switched = await request({ tts: {
    enabled: true, service: 'custom', provider: 'openai', baseUrl: 'https://gw-b.example/v1', model: 'cosy', voice: 'b'
  } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(getConfig().tts.apiKeyHost, 'gw-a.example', '没填新 Key 时保留旧主机归属钉');
  assert.equal(ttsKeyFor(getConfig().tts), '', '旧主机 Key 不得发给新主机');

  const replaced = await request({ tts: {
    enabled: true, service: 'custom', provider: 'openai', baseUrl: 'https://gw-b.example/v1',
    model: 'cosy', voice: 'b', apiKeyInput: 'sk-b'
  } });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(getConfig().tts.apiKeyHost, 'gw-b.example');
  assert.equal(ttsKeyFor(getConfig().tts), 'sk-b');
});

test('TTS 单槽 Key 的归属：切到没存过 Key 的服务会清掉它，切回来能用自己那把（2026-10-03）', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'ws://127.0.0.1:1';
  // 老配置形态：单槽 apiKey（归当前这家），keys 映射为空
  cfg.tts = { ...cfg.tts, enabled: true, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'SK-SILICON' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const { ttsKeyFor, ttsServiceOf } = await import('../src/llm/tts-presets.js');
  const { getConfig: live } = await import('../src/core/config.js');

  // 切到豆包（这家的 keys 里没有记录）、Key 框留空 → 单槽那把必须被清掉（不能发给豆包）
  let res = await request('/api/config', {
    method: 'POST',
    body: { tts: { enabled: true, provider: 'doubao', baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', apiKeyInput: '' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  let now = live().tts;
  assert.equal(String(now.apiKey || ''), '', '不沿用上一家的单槽 Key（宁可显示未填）');
  assert.equal(ttsKeyFor(now, 'doubao'), '', '豆包拿不到硅基流动那把');
  assert.equal(String(now.apiKeyService || ''), '', '活动槽的归属一并清掉');
  // ⚠️ 但那把 Key 不能凭空消失（2026-10-03 复审）：存量实例的 Key 只存在于 tts.apiKey 一个字段里
  //（keys 映射是控制台从 2026-09-29 起才写的），直接清空 = 永久丢失、控制台也找不回来。
  assert.equal(now.keys?.siliconflow, 'SK-SILICON', '切走前要归档进原归属的槽位（切回去能自动填回）');

  // 切回硅基流动并填上 → 归属记住；之后"什么都不填"地保存也不能丢
  res = await request('/api/config', {
    method: 'POST',
    body: { tts: { enabled: true, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B', apiKeyInput: 'SK-NEW-SILICON' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  now = live().tts;
  assert.equal(now.apiKeyService, 'siliconflow', '新填的 Key 归属记在这一家');
  assert.equal(ttsKeyFor(now, 'siliconflow'), 'SK-NEW-SILICON');
  assert.equal(ttsKeyFor(now, 'doubao'), '', '别家仍然拿不到');

  // 无关的一次保存（没碰 Key）不能把归属或 Key 弄丢
  res = await request('/api/config', { method: 'POST', body: { tts: { enabled: true, voice: 'claude' } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  now = live().tts;
  assert.equal(ttsKeyFor(now, 'siliconflow'), 'SK-NEW-SILICON', '空/掩码 = 保持原值');
  assert.ok(ttsServiceOf(now), '服务识别不受影响');
  // 不重新填 Key、直接切回硅基流动 → 归档的那把自动回来了（这一段是"不丢数据"的正面断言）
  res = await request('/api/config', {
    method: 'POST',
    body: { tts: { enabled: true, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ttsKeyFor(live().tts, 'siliconflow'), 'SK-NEW-SILICON', '切回原服务不用重填（用的是映射里那把）');

  // ② 客户端直接送归属钉 → 被忽略（归属只由服务端按本次提交算）
  res = await request('/api/config', {
    method: 'POST',
    body: { tts: { enabled: true, provider: 'doubao', baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', apiKeyService: 'doubao' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.notEqual(String(live().tts.apiKeyService || ''), 'doubao',
    '客户端送的归属钉不能生效（否则能把别家的旧 Key 改绑给当前这家）');

  // ③ 音色按服务记住：切到另一家再切回来，原音色不能被上一家的覆盖
  res = await request('/api/config', {
    method: 'POST',
    body: {
      tts: {
        enabled: true, provider: 'doubao',
        baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
        voice: 'ICL_TEST_DOUBAO'
      }
    }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(live().tts.voices.doubao, 'ICL_TEST_DOUBAO');

  res = await request('/api/config', {
    method: 'POST',
    body: {
      tts: {
        enabled: true, provider: 'mimo',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        model: 'mimo-v2.5-tts', voice: 'Chloe'
      }
    }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(live().tts.voices.doubao, 'ICL_TEST_DOUBAO', '切到 MiMo 不能冲掉豆包的音色记忆');
  assert.equal(live().tts.voices.mimo, 'Chloe');

  res = await request('/api/config', {
    method: 'POST',
    body: {
      tts: {
        enabled: true, provider: 'doubao',
        baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
        voice: live().tts.voices.doubao
      }
    }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(live().tts.voice, 'ICL_TEST_DOUBAO', '切回豆包要恢复它自己的音色，不是 MiMo 的 Chloe');
  assert.equal(live().tts.voices.doubao, 'ICL_TEST_DOUBAO');
  assert.equal(live().tts.voices.mimo, 'Chloe');
  const view = await request('/api/config');
  assert.equal(view.body.tts.voices.doubao, 'ICL_TEST_DOUBAO', 'voices 要下发给控制台用于切换恢复');
  assert.equal(view.body.tts.voices.mimo, 'Chloe');
});
