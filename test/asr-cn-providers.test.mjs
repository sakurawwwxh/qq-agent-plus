// 四家国内云转写适配器的单测（都不走 OpenAI 协议，各有签名/换取流程）。
// 说明：这些适配器没有用真实凭据端到端跑过，所以这里能钉住的是"请求形状与错误映射"；
// 其中腾讯的 TC3 签名派生是对着**官方 Python SDK 的 sign_tc3** 跑出的基准值交叉验证的（见下）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

const { canonicalRequest, tc3Sign, tc3Authorization, tencentTranscribe, TENCENT_ASR_HOST } =
  await import('../src/llm/asr-tencent.js');
const { iflytekSignedUrl, iflytekFrame, iflytekTextOf, iflytekTranscribe, IFLYTEK_FRAME_BYTES } =
  await import('../src/llm/asr-iflytek.js');
const { baiduTranscribe, baiduAccessToken, resetBaiduTokenCache, BAIDU_SPEECH_URL } =
  await import('../src/llm/asr-baidu.js');
const { dashscopeTranscribe, dashscopeEndpoint, DASHSCOPE_DEFAULT_MODEL } =
  await import('../src/llm/asr-dashscope.js');
const { pcmToWav } = await import('../src/llm/asr-openai.js');

/** 起一个假的 HTTP 服务当"服务商"，记录收到的请求，按需返回。 */
async function fakeHttp(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

test('腾讯云 TC3 签名：派生与官方 Python SDK 的 sign_tc3 输出一致', () => {
  // 基准值：用腾讯云官方 SDK（tencentcloud-sdk-python/common/sign.py 的 Sign.sign_tc3）
  // 对下面这组输入算出来的；我们的实现必须逐位相同。
  const secretKey = 'SECRETKEYEXAMPLE';
  const date = '2026-09-26';
  const service = 'asr';
  const stringToSign = [
    'TC3-HMAC-SHA256',
    '1790460000',
    '2026-09-26/asr/tc3_request',
    '608deef3c2ad7793cf11edc1f2cdba25a88b888d3feab248d785ea498f3a52b0'
  ].join('\n');
  assert.equal(tc3Sign(secretKey, date, service, stringToSign),
    '1e69a5554da990f44a26d500ab2f679efb4725322a012157171e86d0fab4c273',
    '签名派生必须与官方实现一致');
  // 同一个 string-to-sign 的规范串哈希也要对得上（规范串模板：头块每行带换行 + 模板再补一个换行）
  const payload = '{"Action":"SentenceRecognition","Version":"2019-06-14","EngSerViceType":"16k_zh","SourceType":1,"VoiceFormat":"wav","Data":"AAA=","DataLen":3}';
  const canonical = canonicalRequest({
    method: 'POST', uri: '/', query: '',
    headers: [['content-type', 'application/json; charset=utf-8'], ['host', TENCENT_ASR_HOST]],
    signedHeaders: 'content-type;host', payload
  });
  assert.equal(crypto.createHash('sha256').update(canonical, 'utf8').digest('hex'),
    '608deef3c2ad7793cf11edc1f2cdba25a88b888d3feab248d785ea498f3a52b0',
    '规范串模板变了这条会红（它是签名的另一半依据）');
  assert.equal(canonical.split('\n')[0], 'POST');
  assert.equal(canonical.split('\n')[2], '', 'query 为空 → 第 3 行是空行');
});

test('腾讯云一句话识别：请求形状正确，结果取 Response.Result', async (t) => {
  const fake = await fakeHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Response: { Result: '你好世界', RequestId: 'x' } }));
  });
  t.after(() => fake.close());
  const wav = pcmToWav(Buffer.alloc(1600));
  const text = await tencentTranscribe(wav, {
    secretId: 'AKIDEXAMPLE', secretKey: 'SECRETKEYEXAMPLE', region: 'ap-guangzhou',
    nowFn: () => 1790460000,
    fetchFn: async (url, init) => {
      // 把请求转发到假服务，同时核对发往的是腾讯的主机与必需头
      assert.equal(url, `https://${TENCENT_ASR_HOST}`);
      assert.match(init.headers.Authorization, /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{4}-\d{2}-\d{2}\/asr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
      assert.equal(init.headers['X-TC-Action'], 'SentenceRecognition');
      assert.equal(init.headers['X-TC-Timestamp'], '1790460000');
      const proxied = await fetch(`http://127.0.0.1:${fake.port}`, { method: 'POST', headers: init.headers, body: init.body });
      return proxied;
    }
  });
  assert.equal(text, '你好世界');
  const body = JSON.parse(fake.seen[0].body);
  assert.equal(body.SourceType, 1, '1 = 直接传音频数据');
  assert.equal(body.VoiceFormat, 'wav');
  assert.equal(body.DataLen, wav.length, 'DataLen 是编码前字节数');
  assert.equal(Buffer.from(body.Data, 'base64').length, wav.length, 'Data 是完整音频的 base64');
});

test('腾讯云：签名/额度类错误要带上可操作提示', async (t) => {
  const fake = await fakeHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名验证失败' } } }));
  });
  t.after(() => fake.close());
  await assert.rejects(
    () => tencentTranscribe(pcmToWav(Buffer.alloc(800)), {
      secretId: 'a', secretKey: 'b',
      fetchFn: (url, init) => fetch(`http://127.0.0.1:${fake.port}`, { method: 'POST', headers: init.headers, body: init.body })
    }),
    /签名\/鉴权没通过/
  );
});

test('讯飞：签名 URL 与分帧协议', () => {
  const url = iflytekSignedUrl({ apiKey: 'KEY123', apiSecret: 'SECRET456', date: 'Fri, 26 Sep 2026 10:00:00 GMT' });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'wss:');
  assert.equal(parsed.host, 'iat-api.xfyun.cn');
  assert.equal(parsed.pathname, '/v2/iat');
  assert.equal(parsed.searchParams.get('host'), 'iat-api.xfyun.cn');
  assert.equal(parsed.searchParams.get('date'), 'Fri, 26 Sep 2026 10:00:00 GMT');
  const auth = Buffer.from(parsed.searchParams.get('authorization'), 'base64').toString('utf8');
  // authorization 里必须包含签名串，且签名 = base64(HMAC-SHA256(apiSecret, 签名原文))
  const signatureOrigin = 'host: iat-api.xfyun.cn\ndate: Fri, 26 Sep 2026 10:00:00 GMT\nGET /v2/iat HTTP/1.1';
  const expect = crypto.createHmac('sha256', 'SECRET456').update(signatureOrigin, 'utf8').digest('base64');
  assert.ok(auth.includes(`signature="${expect}"`), '签名内容对不上');
  assert.ok(auth.includes('api_key="KEY123"') && auth.includes('headers="host date request-line"'));

  const frame = JSON.parse(iflytekFrame({ appId: 'APP1', audio: Buffer.alloc(IFLYTEK_FRAME_BYTES), status: 0 }));
  assert.equal(frame.common.app_id, 'APP1');
  assert.equal(frame.business.language, 'zh_cn');
  assert.equal(frame.data.status, 0);
  assert.equal(frame.data.format, 'audio/L16;rate=16000');
  assert.equal(frame.data.encoding, 'raw');
  assert.equal(Buffer.from(frame.data.audio, 'base64').length, IFLYTEK_FRAME_BYTES, '40ms 一帧');
  // 结果拼装：ws[].cw[].w
  assert.equal(iflytekTextOf({ data: { result: { ws: [{ cw: [{ w: '你好' }] }, { cw: [{ w: '世界' }] }] } } }), '你好世界');
});

test('讯飞：本地假 WS 服务端跑通"首帧/中间帧/末帧 → 拼出文本"', async (t) => {
  const frames = [];
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.on('listening', resolve));
  const port = wss.address().port;
  t.after(() => new Promise((r) => wss.close(r)));
  wss.on('connection', (ws, req) => {
    assert.match(String(req.url), /^\/v2\/iat\?authorization=/, '必须带签名参数');
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      frames.push(msg.data.status);
      if (msg.data.status === 0) {
        ws.send(JSON.stringify({ code: 0, data: { status: 1, result: { ws: [{ cw: [{ w: '你好' }] }] } } }));
      }
      if (msg.data.status === 2) {
        ws.send(JSON.stringify({ code: 0, data: { status: 2, result: { ws: [{ cw: [{ w: '世界' }] }] } } }));
      }
    });
  });

  const pcm = Buffer.alloc(IFLYTEK_FRAME_BYTES * 3);   // 三帧 → 0/1/2
  const text = await iflytekTranscribe(pcm, {
    appId: 'APP1', apiKey: 'K', apiSecret: 'S', frameDelayMs: 0,
    url: `ws://127.0.0.1:${port}/v2/iat?authorization=x`,
    WebSocketImpl: WebSocket
  });
  assert.equal(text, '你好世界');
  assert.deepEqual(frames, [0, 1, 2], '帧序列必须是 首帧/中间帧/末帧');
});

test('讯飞：鉴权类错误码要给出可操作提示', async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.on('listening', resolve));
  const port = wss.address().port;
  t.after(() => new Promise((r) => wss.close(r)));
  wss.on('connection', (ws) => {
    ws.on('message', () => ws.send(JSON.stringify({ code: 10105, message: 'invalid authorization' })));
  });
  await assert.rejects(
    () => iflytekTranscribe(Buffer.alloc(IFLYTEK_FRAME_BYTES), {
      appId: 'APP1', apiKey: 'K', apiSecret: 'S', frameDelayMs: 0,
      url: `ws://127.0.0.1:${port}/v2/iat?authorization=x`, WebSocketImpl: WebSocket
    }),
    /鉴权失败：核对 APIKey\/APISecret/
  );
});

test('百度：新式 Key 走 Bearer，老式 Key+Secret 先换 token（带缓存）', async (t) => {
  resetBaiduTokenCache();
  const calls = [];
  const fake = await fakeHttp((req, res, body) => {
    if (String(req.url).includes('/oauth/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'TOKEN-1', expires_in: 2592000 }));
      return;
    }
    const parsed = body ? JSON.parse(body) : {};
    calls.push({ auth: req.headers.authorization || '', token: parsed.token || '', len: parsed.len, devPid: parsed.dev_pid });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ err_no: 0, result: ['今天的天气不错'] }));
  });
  t.after(() => fake.close());

  // ① 只有 API Key（控制台现在默认发 bce-v3/ALTAK-... 这种）→ 直接当 Bearer
  const bearerText = await baiduTranscribe(Buffer.alloc(3200, 1), {
    apiKey: 'bce-v3/ALTAK-xxx', cuid: 'test',
    fetchFn: (url, init) => fetch(`${url === BAIDU_SPEECH_URL ? `http://127.0.0.1:${fake.port}/server_api` : url}`, init)
  });
  assert.equal(bearerText, '今天的天气不错');
  assert.equal(calls[0].auth, 'Bearer bce-v3/ALTAK-xxx');
  assert.equal(calls[0].devPid, 1537);

  // ② 有 Secret Key → 换 token（第二次调用应命中缓存，不再打 token 接口）
  const before = fake.seen.length;
  await baiduTranscribe(Buffer.alloc(3200, 1), {
    apiKey: 'APIKEY', secretKey: 'SECRETKEY', cuid: 'test',
    fetchFn: (url, init) => fetch(
      String(url).includes('/oauth/') ? `http://127.0.0.1:${fake.port}/oauth/2.0/token` : `http://127.0.0.1:${fake.port}/server_api`,
      init)
  });
  assert.equal(calls[1].token, 'TOKEN-1', '老式鉴权要把 token 放进 body');
  const tokenCalls = fake.seen.filter((item) => String(item.url).includes('/oauth/')).length;
  assert.equal(tokenCalls, 1, 'token 只换一次（缓存生效）');
  assert.ok(fake.seen.length > before);
});

test('百度：错误码 3307（音频过长）要翻译成人话', async () => {
  await assert.rejects(
    () => baiduTranscribe(Buffer.alloc(3200), {
      apiKey: 'k',
      fetchFn: async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ err_no: 3307, err_msg: 'speech quality error' })
      })
    }),
    /音频过长（超过 60 秒，需要分片）/
  );
});

test('阿里百炼：请求形状（chat + input_audio）与文本抽取', async () => {
  const seen = [];
  const text = await dashscopeTranscribe(pcmToWav(Buffer.alloc(1600)), {
    apiKey: 'sk-test', model: '', // 空模型要走默认值
    fetchFn: async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '你好' } }] }) };
    }
  });
  assert.equal(text, '你好');
  assert.equal(seen[0].url, `${dashscopeEndpoint('')}`);
  assert.match(seen[0].url, /compatible-mode\/v1\/chat\/completions$/);
  assert.equal(seen[0].auth, 'Bearer sk-test');
  // 与字面量比，不要与模块里的常量比：常量被改成任何值这条断言都会过（自证式断言，2026-09-26 审查）
  assert.equal(seen[0].body.model, 'qwen3-asr-flash', '没填模型时用默认 qwen3-asr-flash');
  assert.equal(DASHSCOPE_DEFAULT_MODEL, 'qwen3-asr-flash', '常量本身也得是文档里那个名字');
  const part = seen[0].body.messages[0].content[0];
  assert.equal(part.type, 'input_audio');
  assert.match(part.input_audio.data, /^data:audio\/wav;base64,/);
  // 分块 content 也要能拼
  const chunked = await dashscopeTranscribe(pcmToWav(Buffer.alloc(800)), {
    apiKey: 'k',
    fetchFn: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: [{ text: '甲' }, { text: '乙' }] } }] })
    })
  });
  assert.equal(chunked, '甲乙');
});

test('阿里百炼：HTTP 错误要带响应片段', async () => {
  await assert.rejects(
    () => dashscopeTranscribe(pcmToWav(Buffer.alloc(800)), {
      apiKey: 'k',
      fetchFn: async () => ({ ok: false, status: 401, text: async () => 'invalid api key' })
    }),
    /401.*invalid api key/
  );
});

// ── 路由与分片（审查指出：最危险的新逻辑此前没有覆盖）──

test('路由与分片：百度/腾讯/阿里超过 55 秒会被切片，逐段转写后拼接', async (t) => {
  const { runProvider, SHORT_API_CHUNK_SECONDS } = await import('../src/tools/audio-transcribe.js');
  assert.equal(SHORT_API_CHUNK_SECONDS, 55);
  const calls = { baidu: 0, tencent: 0, aliyun: 0 };
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init) => {
    const text = String(url);
    if (text.includes('vop.baidu.com')) { calls.baidu += 1; return json({ err_no: 0, result: ['甲'] }); }
    if (text.includes('asr.tencentcloudapi.com')) { calls.tencent += 1; return json({ Response: { Result: '乙' } }); }
    if (text.includes('dashscope')) { calls.aliyun += 1; return json({ choices: [{ message: { content: '丙' } }] }); }
    throw new Error(`未预期的请求：${text}`);
  };
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  const pcm = Buffer.alloc(32000 * 130);   // 130 秒 → 55/55/20 三片

  const cfgBaidu = { asr: { provider: 'baidu', enabled: true, apiKey: 'k', secretKey: '' } };
  assert.equal(await runProvider(cfgBaidu, pcm), '甲甲甲', '三片拼接');
  assert.equal(calls.baidu, 3, '百度应发 3 次请求');

  const cfgTencent = { asr: { provider: 'tencent', enabled: true, secretId: 'id', secretKey: 'sk' } };
  assert.equal(await runProvider(cfgTencent, pcm), '乙乙乙');
  assert.equal(calls.tencent, 3);

  const cfgAliyun = { asr: { provider: 'aliyun', enabled: true, apiKey: 'k' } };
  assert.equal(await runProvider(cfgAliyun, pcm), '丙丙丙');
  assert.equal(calls.aliyun, 3, '阿里也按 55 秒分片');

  // 短音频只发一次
  calls.baidu = 0;
  await runProvider(cfgBaidu, Buffer.alloc(32000 * 10));
  assert.equal(calls.baidu, 1);
});

test('讯飞：单片音频补空首帧 + 末帧 status=2（帧序与"必须给末帧"两头都要满足）', async (t) => {
  const { iflytekTranscribe } = await import('../src/llm/asr-iflytek.js');
  const frames = [];
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.on('listening', resolve));
  const port = wss.address().port;
  t.after(() => new Promise((r) => wss.close(r)));
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      frames.push({ status: msg.data.status, bytes: String(msg.data.audio || '').length });
      if (msg.data.status === 2) {
        ws.send(JSON.stringify({ code: 0, data: { status: 2, result: { ws: [{ cw: [{ w: '短' }] }] } } }));
      }
    });
  });
  // 只有 1 帧（≤1280 字节）的短音频
  const text = await iflytekTranscribe(Buffer.alloc(600), {
    appId: 'A', apiKey: 'K', apiSecret: 'S', frameDelayMs: 0,
    url: `ws://127.0.0.1:${port}/v2/iat?authorization=x`, WebSocketImpl: WebSocket
  });
  assert.equal(text, '短');
  // 官方要求"第一帧 status=0、最后一帧必须 status=2"。单片两个身份都占：先发空首帧、再发音频末帧。
  assert.deepEqual(frames.map((f) => f.status), [0, 2], '单片要空首帧(0) + 音频末帧(2)');
  assert.equal(frames[0].bytes, 0, '首帧不带音频');
  assert.ok(frames[1].bytes > 0, '末帧带音频');
});

test('讯飞：异常断开不能把半截文本当成功（否则报成"可能整段是静音"）', async (t) => {
  const { iflytekTranscribe } = await import('../src/llm/asr-iflytek.js');
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.on('listening', resolve));
  const port = wss.address().port;
  t.after(() => new Promise((r) => wss.close(r)));
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      // 先给半句结果，再用 1011/1006 这种异常码断开
      if (msg.data.status === 2 || msg.data.status === 0) {
        ws.send(JSON.stringify({ code: 0, data: { status: 1, result: { ws: [{ cw: [{ w: '半句' }] }] } } }));
        setTimeout(() => { try { ws.close(1011); } catch { /* 已关 */ } }, 10);
      }
    });
  });
  await assert.rejects(
    () => iflytekTranscribe(Buffer.alloc(600), {
      appId: 'A', apiKey: 'K', apiSecret: 'S', frameDelayMs: 0,
      url: `ws://127.0.0.1:${port}/v2/iat?authorization=x`, WebSocketImpl: WebSocket
    }),
    /连接被中断（close 1011）/
  );
});

test('讯飞：wp 保留字段里出现哨兵值时不能拼进正文', async () => {
  const { iflytekTextOf } = await import('../src/llm/asr-iflytek.js');
  assert.equal(iflytekTextOf({ data: { result: { ws: [{ cw: [{ w: '你好' }], wp: '-1' }] } } }), '你好');
  assert.equal(iflytekTextOf({ data: { result: { ws: [{ cw: [{ w: '你好' }], wp: '，' }] } } }), '你好，');
});
