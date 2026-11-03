import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用例自己造临时数据目录：**不许**碰仓库里的 data/（那里可能是真配置，含 Key）。
// 注意 ESM 的静态 import 会先于文件体执行，所以 src 模块必须用动态 import 放在这之后。
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-llm-test-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });

const {
  cachedTokensOfUsage,
  chatCompletion,
  chatCompletionWithRetry,
  isRetryableError,
  resolveApiKey
} = await import('../src/llm/llm.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

describe('LLM client', () => {
  it('选了 provider 但没有该家 Key 时绝不回退顶层 api.apiKey', () => {
    assert.equal(resolveApiKey({
      api: { provider: 'openrouter', apiKey: 'OLD-A6API-KEY' },
      providers: []
    }), '', '跨厂商不能把旧 Key 发给新端点');
    assert.equal(resolveApiKey({
      api: { provider: 'openrouter', apiKey: 'OLD-A6API-KEY' },
      providerKeys: { openrouter: 'OR-KEY' },
      providers: []
    }), 'OR-KEY');
    assert.equal(resolveApiKey({
      api: { provider: 'openrouter' },
      providers: [{ id: 'openrouter', apiKey: 'LEGACY-INLINE' }]
    }), 'LEGACY-INLINE', '老配置内联 Key 仍认');
    assert.equal(resolveApiKey({
      api: { provider: '', apiKey: 'MANUAL-KEY' },
      providers: []
    }), 'MANUAL-KEY', '手动模式仍用顶层 Key');
  });

  it('reads cached input tokens from supported provider response shapes', () => {
    assert.equal(cachedTokensOfUsage({
      prompt_tokens_details: { cached_tokens: 120 }
    }), 120);
    assert.equal(cachedTokensOfUsage({ prompt_cache_hit_tokens: 80 }), 80);
    assert.equal(cachedTokensOfUsage({ cached_tokens: 40 }), 40);
    assert.equal(cachedTokensOfUsage({}), 0);
  });

  it('strips local trace fields but preserves provider reasoning required by tool loops', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.messages[0].raw, undefined);
      assert.equal(body.messages[0].reasoning_content, 'private provider state');
      return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 25 } });
    };
    const result = await chatCompletion({ messages: [{
      role: 'assistant',
      content: 'hello',
      reasoning_content: 'private provider state',
      raw: { large: true }
    }],
      overrides: { baseUrl: 'https://example.com/v1', model: 'mock' } });
    assert.equal(result.usage.total_tokens, 25);
  });

  it('adds a cache routing key only for official OpenAI-compatible hosts', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const bodies = [];
    globalThis.fetch = async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    };
    await chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      cacheKey: 'stable-prefix',
      overrides: { baseUrl: 'https://api.openai.com/v1', model: 'mock' }
    });
    await chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      cacheKey: 'stable-prefix',
      overrides: { baseUrl: 'https://gateway.invalid/v1', model: 'mock' }
    });
    assert.equal(bodies[0].prompt_cache_key, 'stable-prefix');
    assert.equal(bodies[1].prompt_cache_key, undefined);
  });

  it('cancels while reading a stalled response body after receiving headers', async (t) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Run cancelled')), 100);
    t.after(() => clearTimeout(timer));
    await assert.rejects(chatCompletion({ messages: [], signal: controller.signal,
      overrides: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'mock' } }), /Run cancelled/);
  });

  it('does not retry authentication errors or explicitly cancelled requests', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.api.baseUrl = 'https://example.com/v1';
    setRuntimeConfig(cfg);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('unauthorized', { status: 401 }); };
    await assert.rejects(chatCompletionWithRetry({ messages: [] }), /401/);
    assert.equal(calls, 1);
    const signal = AbortSignal.abort(new Error('Run cancelled'));
    await assert.rejects(chatCompletionWithRetry({ messages: [], signal }), /cancelled/);
    assert.equal(calls, 1);
    assert.equal(isRetryableError(new Error('HTTP 503')), true);
    assert.equal(isRetryableError(new Error('HTTP 400')), false);
  });
  it('兜底地址换了主机却没配 api.fallback.apiKey：不切兜底（绝不把主渠道那把发过去）', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const seen = [];
    // 主渠道一律失败 → 才会走兜底那条路（否则断言根本走不到）
    globalThis.fetch = async (url, request) => {
      const href = String(url);
      seen.push({ href, auth: String(request?.headers?.authorization || request?.headers?.Authorization || '') });
      if (href.includes('primary.example.com')) return Response.json({ error: { message: 'overloaded' } }, { status: 503 });
      return Response.json({ choices: [{ message: { content: 'from-backup' } }] });
    };
    const config = await import('../src/core/config.js');
    const cfg = JSON.parse(JSON.stringify(config.DEFAULT_CONFIG));
    cfg.api.baseUrl = 'https://primary.example.com/v1';
    cfg.api.apiKey = 'PRIMARY-KEY';
    cfg.api.model = 'primary-model';
    cfg.api.fallback = { enabled: true, baseUrl: 'https://backup.example.com/v1', model: 'backup-model' };
    config.setRuntimeConfig(cfg);
    await assert.rejects(
      chatCompletionWithRetry({ messages: [{ role: 'user', content: 'hi' }] }, 0),
      /503/,
      '不切兜底时主渠道的错要如实抛出来'
    );
    assert.ok(!seen.some((s) => s.href.includes('backup.example.com')),
      '备用主机与主渠道不同、却没给备用 Key 时就不该往它发请求');
    assert.ok(!seen.some((s) => s.auth.includes('PRIMARY-KEY') && !s.href.includes('primary.example.com')),
      '更不能把主渠道那把发到别的主机');
    config.setRuntimeConfig(config.DEFAULT_CONFIG);
  })
  it('审核拦截恰好落在最后一轮：返回拦截结果而不是 null（曾经 throw null → 调用方 TypeError）', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let calls = 0;
    // isModerationRefusal 认的是 message.content 命中 high risk
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: 'This request was considered high risk.' } }] });
    };
    const response = await chatCompletionWithRetry({ messages: [{ role: 'user', content: 'hi' }] }, 0);
    assert.ok(response, '绝不能返回 null（调用方会直接读 response.model 而崩）');
    assert.equal(calls, 1, 'retries=0 时不该再重试');
    assert.match(String(response.message?.content || ''), /high risk/i, '如实返回服务商的拦截文案');
  })
});
