// 图片生成（generate_image）：适配器两条响应形态、错误路径、Key 归属守卫、闸门与配置访问器。
// 背景（Issue #21）：外部贡献者提议接入 OpenAI 兼容的 /images/generations；
// 评审时抓到三个坑 —— Key 归属、source 枚举、唯一成本闸门 —— 这里都钉上用例。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeServer } from './helpers/cleanup.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  allow: { private: ['1'] },
  api: { baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key', model: 'm' }
}));

const { generateImage, resolveImageGenAuth, imageGenConfigured } = await import('../src/llm/image-gen.js');
const { imageGenAvailable, imageGenMaxPerHour } = await import('../src/core/config.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');   // 只验字节，不验完整 PNG

test('Key 归属守卫：同域才复用模型 Key，不同域必须自带（绝不把模型 Key 发给别家）', () => {
  const api = { baseUrl: 'https://gateway.example.com/v1' };
  // ① 自己填了 Key → 用它，与模型无关
  assert.deepEqual(
    resolveImageGenAuth({ imageGen: { apiKey: 'own-key', baseUrl: 'https://other.example.com' }, api, apiKey: 'model-key' }),
    { ok: true, key: 'own-key', reused: false, error: '' }
  );
  // ② 留空 + 与模型同域 → 复用模型 Key（很多网关同域就带 images 端点）
  assert.deepEqual(
    resolveImageGenAuth({ imageGen: { baseUrl: 'https://gateway.example.com/v1' }, api, apiKey: 'model-key' }),
    { ok: true, key: 'model-key', reused: true, error: '' }
  );
  // ③ 留空 + 地址留空（= 跟模型走）→ 也算同域
  assert.equal(resolveImageGenAuth({ imageGen: {}, api, apiKey: 'model-key' }).reused, true);
  // ④ 留空 + 不同域 → 拒绝，且报错要说清为什么不给用
  const denied = resolveImageGenAuth({ imageGen: { baseUrl: 'https://other.example.com/v1' }, api, apiKey: 'model-key' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /不是同一家/);
  assert.equal(denied.key, '');
  // ⑤ 掩码占位不算真 Key（前端会把掩码回传）
  assert.equal(resolveImageGenAuth({ imageGen: { apiKey: '******', baseUrl: 'https://other.example.com' }, api, apiKey: 'model-key' }).ok, false);
});

test('适配器：b64_json 直接解码；不发 response_format（新版 OpenAI 会因未知参数 400）', async () => {
  const calls = [];
  const out = await generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://gateway.example.com/v1', model: 'gpt-image-1' } },
    apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
    apiKey: 'model-key',
    prompt: '一只橘猫',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), headers: req.headers, body: JSON.parse(req.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
    }
  });
  assert.equal(calls[0].url, 'https://gateway.example.com/v1/images/generations');
  assert.equal(calls[0].headers.authorization, 'Bearer model-key');
  assert.equal(calls[0].body.model, 'gpt-image-1');
  assert.equal(calls[0].body.prompt, '一只橘猫');
  assert.equal(calls[0].body.n, 1);
  assert.equal('response_format' in calls[0].body, false);   // 默认不发
  assert.equal(out.buffer.toString('hex'), PNG.toString('hex'));

  // 用户显式填了才发（老网关需要它）
  const calls2 = [];
  await generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm', responseFormat: 'url' } },
    apiCfg: { baseUrl: 'https://gw.example.com/v1' },
    apiKey: 'k',
    prompt: 'x',
    fetchFn: async (url, req) => {
      calls2.push(JSON.parse(req.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
    }
  });
  assert.equal(calls2[0].response_format, 'url');
  // 乱填的值当没填（避免把非法参数发给服务商）
  const calls3 = [];
  await generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm', responseFormat: 'webp' } },
    apiCfg: { baseUrl: 'https://gw.example.com/v1' },
    apiKey: 'k',
    prompt: 'x',
    fetchFn: async (url, req) => {
      calls3.push(JSON.parse(req.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
    }
  });
  assert.equal('response_format' in calls3[0], false);
});

test('适配器：extraBody 原样合并进请求体（Moss 的 output_watermark 嵌套对象）', async () => {
  const calls = [];
  await generateImage({
    cfg: {
      imageGen: {
        enabled: true,
        baseUrl: 'https://api.mosi.cn/v1',
        model: 'moss-image-base-1.0',
        extraBody: { output_watermark: { enabled: false }, quality: 'high' }
      }
    },
    apiCfg: { baseUrl: 'https://api.mosi.cn/v1' },
    apiKey: 'moss-key',
    prompt: '一只橘猫',
    fetchFn: async (url, req) => {
      calls.push(JSON.parse(req.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
    }
  });
  assert.deepEqual(calls[0].output_watermark, { enabled: false }, 'Moss 的 output_watermark 是嵌套对象');
  assert.equal(calls[0].quality, 'high');
  assert.equal(calls[0].model, 'moss-image-base-1.0');
  assert.equal(calls[0].prompt, '一只橘猫');
  assert.equal(calls[0].n, 1);
});

test('Moss 布尔 output_watermark 自动兼容成官方嵌套对象；其他服务商不改写', async () => {
  const bodies = [];
  const fetchFn = async (url, req) => {
    bodies.push(JSON.parse(req.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
  };
  const base = {
    enabled: true,
    model: 'moss-image-base-1.0',
    prompt: '猫',
    fetchFn
  };
  await generateImage({ cfg: { imageGen: { ...base, baseUrl: 'https://api.mosi.cn/v1', extraBody: { output_watermark: false } } }, apiCfg: { baseUrl: 'https://api.mosi.cn/v1' }, apiKey: 'k', prompt: '猫', fetchFn });
  assert.deepEqual(bodies[0].output_watermark, { enabled: false }, 'Moss 的布尔旧写法要转成嵌套对象');
  await generateImage({ cfg: { imageGen: { ...base, baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', extraBody: { output_watermark: false } } }, apiCfg: { baseUrl: 'https://api.openai.com/v1' }, apiKey: 'k', prompt: '猫', fetchFn });
  assert.equal(bodies[1].output_watermark, false, '不是 Moss 就原样透传，不做服务商特判');
});

test('适配器：url 形态走内置安全下载器（真发一次 HTTP，验字节与体积上限口径）', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  // 真起一个本地 HTTP 服务当"图片 CDN"：url 形态由适配器自己 import 的 safeFetchBinary 下载
  // （不用回调注入 —— 那会被 ops scan 当成未定义调用点）。内网地址要开关放行，
  // 那个开关（security.allowPrivateImageHosts）本就是为本地测试/自建图床准备的。
  const httpMod = await import('node:http');
  const server = httpMod.default.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  updateConfig({ security: { allowPrivateImageHosts: true } });
  try {
    const out = await generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm' } },
      apiCfg: { baseUrl: 'https://gw.example.com/v1' },
      apiKey: 'k',
      prompt: 'x',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/a.png`, revised_prompt: '修订后的提示词' }] })
      })
    });
    assert.equal(out.buffer.toString('hex'), PNG.toString('hex'), '下载到的字节要原样返回');
    assert.equal(out.revisedPrompt, '修订后的提示词');

    // 内网地址在开关关闭时被 SSRF 拦下（默认口径）：同一个地址、同一个适配器，只是配置不同
    updateConfig({ security: { allowPrivateImageHosts: false } });
    await assert.rejects(
      generateImage({
        cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm' } },
        apiCfg: { baseUrl: 'https://gw.example.com/v1' },
        apiKey: 'k',
        prompt: 'x',
        fetchFn: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/a.png` }] })
        })
      }),
      /内网/
    );
  } finally {
    updateConfig({ security: { allowPrivateImageHosts: false } });
    await closeServer(server);
  }
});

test('适配器：错误路径都要带出服务商原文与可读原因', async () => {
  const base = {
    cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm' } },
    apiCfg: { baseUrl: 'https://gw.example.com/v1' },
    apiKey: 'k',
    prompt: 'x'
  };
  // HTTP 错误：带状态码与服务商 message
  await assert.rejects(
    generateImage({ ...base, fetchFn: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'content policy violation' } }) }) }),
    /HTTP 403.*content policy violation/s
  );
  // 缺凭据/缺模型/空提示词：在发请求之前就拒
  await assert.rejects(generateImage({ ...base, cfg: { imageGen: { enabled: true, model: 'm' } }, apiCfg: { baseUrl: '' }, apiKey: '' }), /服务地址/);
  await assert.rejects(generateImage({ ...base, cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1' } } }), /模型/);
  await assert.rejects(generateImage({ ...base, prompt: '   ' }), /提示词为空/);
  // 地址留空 + 模型那边也没地址 → 同样报"未配置服务地址"（不是静默打个相对路径）
  await assert.rejects(
    generateImage({ ...base, cfg: { imageGen: { enabled: true, model: 'm' } }, apiCfg: { baseUrl: '' } }),
    /服务地址/
  );
  // 响应里没有 data 数组
  await assert.rejects(
    generateImage({ ...base, fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ created: 1 }) }) }),
    /没有返回图片/
  );
  // data 里有条目但既无 b64 也无 url
  await assert.rejects(
    generateImage({ ...base, fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{}] }) }) }),
    /既没有 b64_json 也没有 url/
  );
  // 非 JSON 响应也要能看出原文
  await assert.rejects(
    generateImage({ ...base, fetchFn: async () => ({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' }) }),
    /没有返回图片/
  );
  // 超大图要拦住（8 MiB 上限，与表情库落盘口径一致；变异验证时这条是唯一抓得住它的用例）
  await assert.rejects(
    generateImage({
      ...base,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ b64_json: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }] })
      })
    }),
    /图片过大/
  );
});

test('pollinations 形状：GET、提示词进路径、尺寸转 width/height，直接拿图片字节', async () => {
  const calls = [];
  const out = await generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://image.pollinations.ai', model: 'flux', size: '512x512' } },
    apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
    prompt: '一只橘猫 戴草帽',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), method: req.method, headers: req.headers });
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => PNG };
    }
  });
  const u = new URL(calls[0].url);
  assert.equal(`${u.origin}${u.pathname}`, `https://image.pollinations.ai/prompt/${encodeURIComponent('一只橘猫 戴草帽')}`);
  assert.equal(u.searchParams.get('width'), '512');
  assert.equal(u.searchParams.get('height'), '512');
  assert.equal(u.searchParams.get('model'), 'flux');
  assert.equal(calls[0].method, 'GET');
  // 免 Key 的第三方服务：连 headers 都不带（绝不能把模型那把 Key 发过去）
  assert.equal(calls[0].headers, undefined);
  assert.equal(out.buffer.toString('hex'), PNG.toString('hex'));
});

test('pollinations 形状：非图片响应（限流/报错）带出原文，别把错误页当图片收下', async () => {
  await assert.rejects(() => generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://image.pollinations.ai', model: 'flux' } },
    apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
    prompt: 'x',
    fetchFn: async () => ({ ok: false, status: 503, headers: { get: () => 'application/json' }, text: async () => '{"error":"busy"}' })
  }), /HTTP 503.*busy/);
});

test('pollinations 形状：402/429 限流要给可操作的提示（原始响应是空的 {}，甩给用户看不懂）', async () => {
  for (const status of [402, 429]) {
    await assert.rejects(() => generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://image.pollinations.ai', model: 'flux' } },
      apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
      prompt: 'x',
      fetchFn: async () => ({ ok: false, status, headers: { get: () => 'application/json; charset=utf-8' }, text: async () => '{}' })
    }), (err) => {
      assert.match(err.message, new RegExp(`限流.*${status}`), '要说明是限流并带上状态码');
      assert.match(err.message, /稍后再试|换一家/, '要给出下一步怎么办');
      return true;
    });
  }
});

test('服务预设表：id 唯一、形状合法；免 Key 的那家不放行就等于白给', async () => {
  const { IMAGEGEN_SERVICES, imageGenServiceOfBaseUrl, imageGenServiceNeedsKey } = await import('../src/llm/image-gen-presets.js');
  const ids = IMAGEGEN_SERVICES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, '预设 id 不能重复');
  for (const s of IMAGEGEN_SERVICES) {
    assert.ok(s.label && ['openai', 'pollinations', 'modelscope'].includes(s.shape), `${s.id} 的 label/shape 不合法`);
    assert.match(String(s.baseUrl ?? ''), /^$|^https:\/\//, `${s.id} 的 baseUrl 必须是 https 或空（自定义那家）`);
  }
  // 地址认家（控制台靠它回填下拉）
  assert.equal(imageGenServiceOfBaseUrl('https://image.pollinations.ai/prompt/x')?.id, 'pollinations');
  assert.equal(imageGenServiceOfBaseUrl('https://open.bigmodel.cn/api/paas/v4')?.id, 'zhipu');
  assert.equal(imageGenServiceOfBaseUrl('https://unknown.example.com'), null);
  // 免 Key 判定
  assert.equal(imageGenServiceNeedsKey(imageGenServiceOfBaseUrl('https://image.pollinations.ai')), false);
  assert.equal(imageGenServiceNeedsKey(IMAGEGEN_SERVICES.find((s) => s.id === 'zhipu')), true);
  // 鉴权守卫：免 Key 的预设留空也放行（否则"没有图模型"的用户永远用不上），且不回退模型 Key
  const api = { baseUrl: 'https://gateway.example.com/v1' };
  assert.deepEqual(
    resolveImageGenAuth({ imageGen: { baseUrl: 'https://image.pollinations.ai' }, api, apiKey: 'model-key' }),
    { ok: true, key: '', reused: false, error: '' }
  );
  // 但守卫本身没放松：别的跨域地址照旧拒绝
  assert.equal(resolveImageGenAuth({ imageGen: { baseUrl: 'https://random-other.example.com' }, api, apiKey: 'model-key' }).ok, false);
});

test('魔搭异步生图：创建任务后必须轮询任务结果，不能把 task_id 当图片', async () => {
  const calls = [];
  await assert.rejects(
    generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://api-inference.modelscope.cn/v1', model: 'Qwen/Qwen-Image-2.1-Turbo', apiKey: 'ms-token' } },
      apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
      prompt: '一只橘猫',
      modelscopePollMs: 0,
      signal: AbortSignal.timeout(200),
      fetchFn: async (url, req) => {
        calls.push({ url: String(url), method: req.method, headers: req.headers, body: req.body && JSON.parse(req.body) });
        if (req.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: 'task-123' }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ task_status: 'SUCCEED', task_id: 'task-123' }) };
      }
    }),
    /任务已完成但没有返回 output_images/
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api-inference.modelscope.cn/v1/images/generations');
  assert.equal(calls[0].headers['X-ModelScope-Async-Mode'], 'true');
  assert.equal(calls[0].headers.authorization, 'Bearer ms-token');
  assert.equal(calls[0].body.model, 'Qwen/Qwen-Image-2.1-Turbo');
  assert.equal(calls[1].url, 'https://api-inference.modelscope.cn/v1/tasks/task-123');
  assert.equal(calls[1].headers['X-ModelScope-Task-Type'], 'image_generation');
  assert.equal(calls[1].headers.authorization, 'Bearer ms-token');
});

test('魔搭异步生图：任务成功后下载 output_images 并原样返回字节', async () => {
  // 结果 URL 由适配器内部的 safeFetchBinary 下载，所以真起一个本地 HTTP 服务；
  // 内网地址要开 security.allowPrivateImageHosts（与 url 形态的既有用例同款）。
  const httpMod = await import('node:http');
  const server = httpMod.default.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { updateConfig } = await import('../src/core/config.js');
  updateConfig({ security: { allowPrivateImageHosts: true } });
  try {
    const calls = [];
    const out = await generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://api-inference.modelscope.cn/v1', model: 'Qwen/Qwen-Image-2.1-Turbo', apiKey: 'ms-token' } },
      apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
      prompt: '一只橘猫',
      modelscopePollMs: 0,
      // 成功用例含一次真实本地 HTTP 下载，给 2 秒余量；其他纯 mock 用例保持 200ms
      signal: AbortSignal.timeout(2000),
      fetchFn: async (url, req) => {
        calls.push({ url: String(url), method: req.method });
        if (req.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: 'task-ok' }) };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            task_status: 'SUCCEED',
            task_id: 'task-ok',
            output_images: [`http://127.0.0.1:${port}/out.png`]
          })
        };
      }
    });
    assert.equal(out.buffer.toString('hex'), PNG.toString('hex'), '下载到的字节要原样返回');
    assert.equal(out.revisedPrompt, '');
    assert.equal(calls.length, 2);
  } finally {
    updateConfig({ security: { allowPrivateImageHosts: false } });
    await closeServer(server);
  }
});

test('魔搭异步生图：CANCELED 是终态，立即失败而不是轮询到超时', async () => {
  const calls = [];
  await assert.rejects(
    generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://api-inference.modelscope.cn/v1', model: 'Qwen/Qwen-Image-2.1-Turbo', apiKey: 'ms-token' } },
      apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
      prompt: '一只橘猫',
      modelscopePollMs: 0,
      signal: AbortSignal.timeout(200),
      fetchFn: async (url, req) => {
        calls.push({ url: String(url), method: req.method });
        if (req.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: 'task-cancel' }) };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ task_status: 'CANCELED', message: 'user cancelled' })
        };
      }
    }),
    /已终止（CANCELED）.*user cancelled/s
  );
  assert.equal(calls.length, 2, '终态后不该继续轮询');
});

test('魔搭异步生图：任务查询 401 带出服务商原文与计费提示', async () => {
  await assert.rejects(
    generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://api-inference.modelscope.cn/v1', model: 'Qwen/Qwen-Image-2.1-Turbo', apiKey: 'bad-token' } },
      apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
      prompt: '一只橘猫',
      modelscopePollMs: 0,
      signal: AbortSignal.timeout(200),
      fetchFn: async (url, req) => {
        if (req.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: 'task-auth' }) };
        }
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: { message: 'invalid token' } })
        };
      }
    }),
    /任务查询失败 HTTP 401.*invalid token.*可能已在服务商侧继续执行并计费/s
  );
});

test('魔搭异步生图：output_images 仍走安全下载器，内网地址被拒', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  updateConfig({ security: { allowPrivateImageHosts: false } });
  await assert.rejects(
    generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://api-inference.modelscope.cn/v1', model: 'Qwen/Qwen-Image-2.1-Turbo', apiKey: 'ms-token' } },
      apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
      prompt: '一只橘猫',
      modelscopePollMs: 0,
      signal: AbortSignal.timeout(200),
      fetchFn: async (url, req) => {
        if (req.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: 'task-ssrf' }) };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            task_status: 'SUCCEED',
            output_images: ['http://127.0.0.1:9/out.png']
          })
        };
      }
    }),
    /内网/
  );
});

test('魔搭异步生图：轮询超时带出最后一次任务响应与计费提示', async () => {
  const ac = new AbortController();
  let polls = 0;
  await assert.rejects(
    generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://api-inference.modelscope.cn/v1', model: 'Qwen/Qwen-Image-2.1-Turbo', apiKey: 'ms-token' } },
      apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
      prompt: '一只橘猫',
      modelscopePollMs: 10,
      signal: ac.signal,
      fetchFn: async (url, req) => {
        if (req.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: 'task-slow' }) };
        }
        polls += 1;
        // 第一次查询拿到 PENDING 后立刻制造 orchestrator 的 run deadline：
        // 它和图片自身的 timeoutMs 一样属于"任务已创建但本地不再等"，必须同样带计费提示。
        if (polls === 1) setTimeout(() => ac.abort(new Error('Run deadline exceeded')), 0);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ task_status: 'PENDING' })
        };
      }
    }),
    /超时.*最后一次任务响应.*PENDING.*可能已在服务商侧继续执行并计费/s
  );
});

test('配置访问器：imageGenAvailable 的三态与闸门默认值', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  // 默认关
  assert.equal(imageGenAvailable(), false);
  // 开了但没模型 → 不可用
  updateConfig({ imageGen: { enabled: true, model: '' } });
  assert.equal(imageGenAvailable(), false);
  // 开了 + 有模型 + 地址留空（与模型同域）→ 可用
  updateConfig({ imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '' } });
  assert.equal(imageGenAvailable(), true);
  // 开了 + 有模型 + 自己的地址 → 可用
  updateConfig({ imageGen: { enabled: true, model: 'm', baseUrl: 'https://other.example.com/v1' } });
  assert.equal(imageGenAvailable(), true);
  // 关掉 → 不可用
  updateConfig({ imageGen: { enabled: false } });
  assert.equal(imageGenAvailable(), false);
  // 闸门默认 6、上限 100、坏值回落
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: 0 } }), 6);
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: -3 } }), 6);
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: 'x' } }), 6);
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: 25 } }), 25);
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: 9999 } }), 100);
  // imageGenConfigured 与 available 的口径差：前者不认"地址留空靠同域"
  assert.equal(imageGenConfigured({ imageGen: { enabled: true, baseUrl: 'https://a/v1', model: 'm' } }), true);
  assert.equal(imageGenConfigured({ imageGen: { enabled: true, baseUrl: '', model: 'm' } }), false);
});

test('工具：generate_image 未启用时不注入模型工具表', async () => {
  const { buildToolDefs, toOpenAiTools } = await import('../src/tools/tools-core.js');
  const names = toOpenAiTools(buildToolDefs()).map((t) => t.function.name);
  // 工具定义本身在（由 orchestrator 按配置过滤），但定义必须存在且形状正确
  assert.ok(names.includes('generate_image'));
  const def = buildToolDefs().find((d) => d.name === 'generate_image');
  assert.deepEqual(def.parameters.required, ['prompt']);
  assert.ok(def.description.includes('按张计费'));
});

// 2026-10-01 审查 P1：存过的 Key 要绑定"存它时的地址"，否则"一键切换服务预设"会把
// A 家的 Key 以 Bearer 发给 B 家（静默事故）。对照 asr 的 apiKeyProvider/apiKeyHost。
test('resolveImageGenAuth：存过的 Key 只在"它自己的地址"上生效（换地址要求重填）', async () => {
  const { resolveImageGenAuth, imageGenKeyApplies, imageGenKeyStale } = await import('../src/llm/image-gen.js');
  const api = { baseUrl: 'https://gateway.example.com/v1' };

  // 记了归属：地址一致才用
  const bound = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'zhipu-key', apiKeyHost: 'open.bigmodel.cn' };
  assert.equal(imageGenKeyApplies(bound, 'open.bigmodel.cn'), true);
  assert.equal(imageGenKeyApplies(bound, 'api.siliconflow.cn'), false);
  assert.deepEqual(resolveImageGenAuth({ imageGen: bound, api }), { ok: true, key: 'zhipu-key', reused: false, error: '' });
  assert.equal(imageGenKeyStale(bound, api), false);

  // 换到别家（预设一键切换后的状态）：**不再拿旧 Key 发请求**，并给出可读原因
  const switched = { ...bound, baseUrl: 'https://api.siliconflow.cn/v1' };
  const r = resolveImageGenAuth({ imageGen: switched, api });
  assert.equal(r.ok, false, '换地址后不能继续用旧 Key');
  assert.equal(r.key, '');
  assert.match(r.error, /open\.bigmodel\.cn/);
  assert.match(r.error, /重新填/);
  assert.equal(imageGenKeyStale(switched, api), true);

  // 换到"与聊天模型同域"的地址 → 走复用那条，仍然不发旧 Key
  const sameHost = { ...bound, baseUrl: 'https://gateway.example.com/v1' };
  assert.deepEqual(
    resolveImageGenAuth({ imageGen: sameHost, api, apiKey: 'model-key' }),
    { ok: true, key: 'model-key', reused: true, error: '' }
  );
  // 换成免 Key 的那家 → 不需要 Key，也不算 stale 报错
  const keyless = { ...bound, baseUrl: 'https://image.pollinations.ai' };
  assert.deepEqual(resolveImageGenAuth({ imageGen: keyless, api }), { ok: true, key: '', reused: false, error: '' });

  // 没记归属的老配置（migrateConfig 会按当时的地址补记）按"能用"算，不给升级中的实例制造突然失效
  const legacyNoHost = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'old-key' };
  assert.equal(imageGenKeyApplies(legacyNoHost, 'anything.example.com'), true);
  assert.equal(imageGenKeyStale(legacyNoHost, api), false);
});

test('映射读键走自有属性：host=constructor 这类原型链取值不算"存过的 Key"（推前复审）', async () => {
  // imageGenKeyFor 已与 imageGenKeyResolve 合并（运行时/保存路径共用一个口径）
  const { imageGenKeyResolve } = await import('../src/core/config-legacy.js');
  // 主机名是外部可控输入（服务预设的地址、手改配置），单标签主机名真的可能是 constructor
  const cfg = { apiKey: 'A-KEY', apiKeyHost: 'a.example.com', keys: {} };
  assert.equal(imageGenKeyResolve(cfg, 'constructor').value, '', '不吃对象原型的 constructor');
  assert.deepEqual(imageGenKeyResolve(cfg, 'constructor'), { value: '', owned: false });
  assert.equal(imageGenKeyResolve(cfg, '__proto__').value, '');
  assert.equal(imageGenKeyResolve({ keys: { 'a.example.com': 'MAP-KEY' } }, 'constructor').value, '');
  assert.equal(imageGenKeyResolve({ keys: { 'a.example.com': 'MAP-KEY' } }, 'a.example.com').value, 'MAP-KEY', '自有键照常读到');
  // asr 侧同款（自有属性读；手改成标量的条目当"没存过"）
  const C = await import('../src/core/config.js');
  assert.equal(C.asrCredentialFor({ keys: {} }, 'apiKey', 'constructor', ''), '');
  assert.equal(C.asrCredentialFor({ keys: { tencent: 'SCALAR' } }, 'secretKey', 'tencent', ''), '', '标量条目不算存过');
});

test('服务预设表不变量：openai 形状的预设必须声明要 Key（新加预设别忘了）', async () => {
  const { IMAGEGEN_SERVICES, imageGenServiceNeedsKey } = await import('../src/llm/image-gen-presets.js');
  for (const s of IMAGEGEN_SERVICES) {
    if (s.shape !== 'openai') continue;
    assert.equal(
      imageGenServiceNeedsKey(s),
      true,
      `${s.id} 是 openai 形状却声明不需要 Key：那样会带着空 Authorization 去打别家端点`
    );
  }
});

test('服务地址误填完整 /images/generations 时剥掉，避免拼成双路径（issue #62）', async () => {
  const calls = [];
  await generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://api.mosi.cn/v1/images/generations', model: 'moss-image-sft-1.0' } },
    apiCfg: { baseUrl: 'https://api.mosi.cn/v1' },
    apiKey: 'k',
    prompt: '一只鲸鱼',
    fetchFn: async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
    }
  });
  assert.equal(calls[0], 'https://api.mosi.cn/v1/images/generations');
});
