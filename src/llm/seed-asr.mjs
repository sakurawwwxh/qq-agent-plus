// Seed-ASR (doubao-seed-asr-2.0) via Volcengine Agent Plan WebSocket.
// Framing verified live 2026-09-25: full request (flags=0x0) carries NO seq
// field but counts as global seq=1; audio chunks start at seq=2, last = -seq.
// Returns final transcript text; throws on server error.
import WebSocket from 'ws';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const WS_URL = 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async';
const RESOURCE = 'volc.seedasr.sauc.duration';

function hdr(mt, flags) {
  return Buffer.from([0x11, (mt << 4) | flags, 0x11, 0x00]);
}

function writeU32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function frameJson(payload) {
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
  return Buffer.concat([hdr(0x1, 0x0), writeU32(gz.length), gz]);
}

function frameAudio(pcm, last, seq) {
  const gz = gzipSync(pcm);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(last ? -seq : seq);
  return Buffer.concat([hdr(0x2, last ? 0x3 : 0x1), seqBuf, writeU32(gz.length), gz]);
}

function parseJson(msg) {
  const body = msg.subarray(4);
  const i = body.indexOf(0x7b); // '{'
  if (i < 0) return null;
  const s = body.subarray(i).toString('utf8');
  try { return JSON.parse(s); } catch { /* 按括号平衡截断 */ }
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') {
      if (--depth === 0) {
        try { return JSON.parse(s.slice(0, k + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export async function seedAsrTranscribe(pcmBuffer, { apiKey, signal, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (!apiKey) throw new Error('未配置语音识别服务（缺少 ASR API Key），无法转写音频');
  signal?.throwIfAborted?.();
  const reqid = randomUUID();
  const ws = new WebSocket(WS_URL, {
    headers: {
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': RESOURCE,
      'X-Api-Request-Id': reqid,
      'X-Api-Connect-Id': reqid
    },
    maxPayload: 10 * 1024 * 1024
  });
  return await new Promise((resolve, reject) => {
    let text = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { ws.close(); } catch { /* noop */ }
      fn(v);
    };
    // 会话级死线：服务端停摆/连接黑洞时兜底，不让 promise 永久挂起
    const timer = setTimeout(() => finish(reject, new Error(`ASR 会话超时（${Math.round(timeoutMs / 60000)} 分钟无结果）`)), timeoutMs);
    const onAbort = () => finish(reject, signal?.reason ?? new Error('已中止'));
    signal?.addEventListener('abort', onAbort, { once: true });
    ws.on('open', () => {
      ws.send(frameJson({
        user: { uid: 'qq-agent' },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true,
                   enable_ddc: true, show_utterances: true, enable_nonstream: false }
      }));
      const CHUNK = 64000;
      let seq = 1; // full request 占全局 seq=1，audio 从 2 开始
      let i = 0;
      const pump = () => {
        if (done) return;
        signal?.throwIfAborted?.();
        const chunk = pcmBuffer.subarray(i, Math.min(i + CHUNK, pcmBuffer.length));
        i += CHUNK;
        seq++;
        const last = i >= pcmBuffer.length;
        try { ws.send(frameAudio(chunk, last, seq)); } catch (e) { return finish(reject, e); }
        if (!last) setTimeout(pump, 20);
      };
      pump();
    });
    ws.on('message', (data) => {
      if (!Buffer.isBuffer(data)) return;
      const j = parseJson(data);
      if (!j) return;
      if (j.error) return finish(reject, new Error(`ASR 服务错误：${j.error}`));
      const t = j?.result?.text;
      if (t) text = t;
      if ((data[1] & 0xF) === 0x3) finish(resolve, text);
    });
    ws.on('close', (code) => {
      // 正常收尾 = 1000（服务端「finish last sequence」）；中途断线（1006 等）
      // 拿到的是半截转写，不能当完整结果。
      if (done) return;
      if (code === 1000) return finish(resolve, text);
      finish(reject, new Error(`ASR 连接中断（close ${code}），转写不完整`));
    });
    ws.on('error', (e) => finish(reject, new Error(`ASR 连接失败：${e.message}`)));
  });
}
