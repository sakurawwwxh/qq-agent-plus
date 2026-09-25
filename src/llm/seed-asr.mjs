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

export async function seedAsrTranscribe(pcmBuffer, { apiKey, signal } = {}) {
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
    const finish = (fn, v) => { if (!done) { done = true; try { ws.close(); } catch { /* noop */ } fn(v); } };
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
    ws.on('close', () => finish(resolve, text)); // close 1000 'finish last sequence' = success
    ws.on('error', (e) => finish(reject, new Error(`ASR 连接失败：${e.message}`)));
  });
}
