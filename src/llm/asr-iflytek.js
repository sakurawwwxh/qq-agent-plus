// 讯飞「语音听写」(IAT)：只有 WebSocket 一条路（wss://iat-api.xfyun.cn/v2/iat），
// 需要在 URL 上带 HMAC-SHA256 签名的 authorization / date / host；音频按 40ms 一帧（1280 字节）
// 用 JSON 帧推上去，status 0=首帧 1=中间 2=末帧。单次 ≤60 秒（由上层分片）。
//
// 验证程度（2026-09-26）：签名串格式与分帧协议按官方文档实现，并用本地假 WS 服务端跑了端到端
// （握手参数、帧序列、结果拼装、错误分支都在用例里）；但**没有用真实讯飞凭据跑过**，
// 真机上若 app_id/Key 不对或签名过期，讯飞会回明确错误码（10105/10106/11200 等），会原文透出。
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { getConfig } from '../core/config.js';

export const IFLYTEK_HOST = 'iat-api.xfyun.cn';
export const IFLYTEK_PATH = '/v2/iat';
/** 一帧 40ms：16000Hz × 2 字节 × 0.04s = 1280 字节（官方建议值）。 */
export const IFLYTEK_FRAME_BYTES = 1280;

/** RFC1123 格式的 GMT 时间（讯飞要求 date 与服务端时差 ≤300 秒）。 */
export function rfc1123(date = new Date()) {
  return `${date.toUTCString()}`;
}

/** 拼签名 URL（导出便于测试：这段是鉴权的全部依据）。 */
export function iflytekSignedUrl({ apiKey, apiSecret, date = rfc1123(), host = IFLYTEK_HOST, path: urlPath = IFLYTEK_PATH }) {
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${urlPath} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin, 'utf8').digest('base64');
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", `
    + `headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, 'utf8').toString('base64');
  const params = new URLSearchParams({ authorization, date, host });
  return `wss://${host}${urlPath}?${params.toString()}`;
}

/** 一帧的 JSON（导出便于测试）。format 用 audio/L16;rate=16000 + encoding=raw（即裸 PCM）。 */
export function iflytekFrame({ appId, audio, status, business = {} }) {
  return JSON.stringify({
    common: { app_id: appId },
    business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin', ...business },
    data: {
      status,
      format: 'audio/L16;rate=16000',
      encoding: 'raw',
      audio: audio ? Buffer.from(audio).toString('base64') : ''
    }
  });
}

/** 从讯飞的返回里取文本：data.result.ws[].cw[].w 拼起来。 */
export function iflytekTextOf(message) {
  const ws = message?.data?.result?.ws;
  if (!Array.isArray(ws)) return '';
  const parts = [];
  for (const piece of ws) {
    const cw = Array.isArray(piece?.cw) ? piece.cw : [];
    for (const item of cw) if (item?.w) parts.push(String(item.w));
    // 标点用 wp 字段（开了标点才有）
    if (typeof piece?.wp === 'string') parts.push(piece.wp);
  }
  return parts.join('');
}

/**
 * 转写一段 16k 单声道 PCM（≤60 秒，由上层分片）。返回纯文本。
 * frameDelayMs 默认按 40ms 一帧的节奏推流（讯飞对推流速度敏感），测试里可设 0。
 */
export async function iflytekTranscribe(pcmBuffer, {
  appId, apiKey, apiSecret, business = {}, timeoutMs = 0, signal, frameDelayMs = 40,
  WebSocketImpl = WebSocket, url: urlOverride = ''
} = {}) {
  if (!appId) throw new Error('未配置讯飞 AppID');
  if (!apiKey || !apiSecret) throw new Error('未配置讯飞 APIKey / APISecret');
  const url = urlOverride || iflytekSignedUrl({ apiKey, apiSecret });
  const ws = new WebSocketImpl(url, { maxPayload: 8 * 1024 * 1024 });
  return await new Promise((resolve, reject) => {
    let done = false;
    let text = '';
    let timer = null;
    const settle = (fn, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { ws.close(); } catch { /* 已关闭 */ }
      fn(value);
    };
    const onAbort = () => settle(reject, signal?.reason ?? new Error('已中止'));
    signal?.addEventListener('abort', onAbort, { once: true });
    // 超时必须按音频长度给：推流本身就是 40ms 一帧（55 秒的片要推 55 秒），
    // 固定 60 秒会让所有较长的片必然超时（2026-09-26 审查抓到）。留 30 秒握手与收尾余量。
    const budgetMs = timeoutMs > 0 ? timeoutMs : Math.max(60000, Math.round(pcmBuffer.length / 32000 * 1000) + 30000);
    timer = setTimeout(() => settle(reject, new Error('讯飞语音听写超时（推完音频后仍没拿到完整结果）')), budgetMs);

    ws.on('open', async () => {
      try {
        const chunks = [];
        for (let i = 0; i < pcmBuffer.length; i += IFLYTEK_FRAME_BYTES) {
          chunks.push(pcmBuffer.subarray(i, Math.min(i + IFLYTEK_FRAME_BYTES, pcmBuffer.length)));
        }
        if (!chunks.length) chunks.push(Buffer.alloc(0));
        for (let i = 0; i < chunks.length; i += 1) {
          if (done) return;
          // 单片（只有一个帧块，含极短的尾块）要用 status=2：讯飞把"只有末帧"当一次性输入收下；
          // 只发 0 不给 2 的话服务端永远不返回最终结果，只能等超时（审查抓到）。
          const status = chunks.length === 1 ? 2 : (i === 0 ? 0 : (i === chunks.length - 1 ? 2 : 1));
          ws.send(iflytekFrame({ appId, audio: chunks[i], status, business }));
          if (frameDelayMs > 0 && i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, frameDelayMs));
          }
        }
      } catch (error) {
        settle(reject, new Error(`讯飞推流失败：${String(error?.message ?? error)}`));
      }
    });
    ws.on('message', (raw) => {
      let message = null;
      try { message = JSON.parse(String(raw)); } catch { return; }
      const code = Number(message?.code ?? 0);
      if (code !== 0) {
        const hint = {
          10105: '（鉴权失败：核对 APIKey/APISecret）', 10106: '（参数不对：核对 AppID 与语言参数）',
          10163: '（AppID 与 Key 不匹配）', 11200: '（当日免费额度用完了？）',
          10165: '（超过 60 秒：需要分片）'
        }[code];
        settle(reject, new Error(`讯飞语音听写失败：${message?.message || '未知错误'}（code=${code}${hint ? '，' + hint : ''}）`));
        return;
      }
      text += iflytekTextOf(message);
      if (Number(message?.data?.status) === 2) settle(resolve, text.trim());
    });
    ws.on('error', (error) => settle(reject, new Error(`讯飞连接失败：${String(error?.message ?? error)}`)));
    ws.on('close', (code) => {
      // 正常收尾讯飞也会关连接；已经拿到最终结果时上面已经 settle 了
      if (!done) settle(resolve, text.trim());
      void code;
    });
  });
}

/** 从配置取这套参数。 */
export function iflytekOptions(cfg = getConfig()) {
  return {
    appId: String(cfg?.asr?.appId || '').trim(),
    apiKey: String(cfg?.asr?.apiKey || '').trim() || String(process.env.ASR_API_KEY || '').trim(),
    apiSecret: String(cfg?.asr?.secretKey || '').trim()
  };
}
