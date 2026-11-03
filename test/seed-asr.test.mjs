// 火山 Seed-ASR：用本地 WebSocketServer 钉住帧方向、最终文本和错误映射。
// 这家适配器此前零功能覆盖，帧头/seq/gzip 任一回归只会在生产付费调用时暴露。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const { seedAsrTranscribe } = await import('../src/llm/seed-asr.js');

function replyFrame(payload) {
  return Buffer.concat([
    Buffer.from([0x00, 0x13, 0x00, 0x00]),
    Buffer.from(JSON.stringify(payload), 'utf8')
  ]);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server.address().port;
}

test('Seed-ASR：收到最终 text 帧后返回转写文本', async (t) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const port = await listen(wss);
  t.after(() => new Promise((resolve) => wss.close(resolve)));
  let frames = 0;
  wss.on('connection', (ws) => {
    ws.on('message', () => {
      frames += 1;
      // 第一帧是 full request JSON；收到后回最终结果（模拟服务端只返回一段文本）。
      if (frames === 1) setTimeout(() => ws.send(replyFrame({ result: { text: '你好世界' } })), 5);
    });
  });
  const text = await seedAsrTranscribe(Buffer.alloc(4000), {
    apiKey: 'test-key',
    wsUrl: `ws://127.0.0.1:${port}`,
    timeoutMs: 2000
  });
  assert.equal(text, '你好世界');
  assert.ok(frames >= 1, '客户端必须发出请求帧');
});

test('Seed-ASR：服务端 error 帧映射成可读错误', async (t) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const port = await listen(wss);
  t.after(() => new Promise((resolve) => wss.close(resolve)));
  wss.on('connection', (ws) => {
    ws.on('message', () => setTimeout(() => ws.send(replyFrame({ error: 'quota exceeded' })), 5));
  });
  await assert.rejects(
    () => seedAsrTranscribe(Buffer.alloc(1000), {
      apiKey: 'test-key',
      wsUrl: `ws://127.0.0.1:${port}`,
      timeoutMs: 2000
    }),
    /ASR 服务错误.*quota exceeded/
  );
});

test('Seed-ASR：缺 Key 与已中止在建立连接前就失败', async () => {
  await assert.rejects(() => seedAsrTranscribe(Buffer.alloc(10), {}), /缺少 ASR API Key/);
  const controller = new AbortController();
  controller.abort(new Error('用户停止'));
  await assert.rejects(
    () => seedAsrTranscribe(Buffer.alloc(10), { apiKey: 'k', signal: controller.signal }),
    /用户停止/
  );
});
