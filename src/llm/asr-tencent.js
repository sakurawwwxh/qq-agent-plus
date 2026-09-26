// 腾讯云语音识别「一句话识别」：POST asr.tencentcloudapi.com，TC3-HMAC-SHA256 签名，音频 base64。
// 限制：单次 ≤60 秒、base64 后 ≤3MB（由上层分片）；16k_zh 支持 wav/pcm/mp3/m4a 等。
//
// 关于"验证到什么程度"（2026-09-26）：签名派生步骤（SecretDate/SecretService/SecretSigning/
// 最终 HMAC）是对着**官方 Python SDK 的 sign_tc3 实现**跑出基准值交叉验证过的（见测试里的固定向量）；
// 规范串按腾讯文档的模板逐行拼（method / uri / query / 头块（每行以换行结尾 + 模板再补一个换行，
// 因此头块与 SignedHeaders 之间是空行）/ SignedHeaders / payload 哈希）。
// 但这套适配器**没有用真实腾讯云凭据端到端跑过** —— 真机上若签名或参数不对，腾讯会回
// AuthFailure.SignatureFailure / InvalidParameter 之类的明确错误，会原文透给用户，便于一轮定位。
import crypto from 'node:crypto';
import { getConfig } from '../core/config.js';

export const TENCENT_ASR_HOST = 'asr.tencentcloudapi.com';
export const TENCENT_ASR_SERVICE = 'asr';
export const TENCENT_ASR_VERSION = '2019-06-14';
/** 引擎：16k_zh=中文普通话(16k)。其它可选 16k_en / 16k_yue / 16k_zh_en 等，控制台可改。 */
export const TENCENT_DEFAULT_ENGINE = '16k_zh';

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, message) => crypto.createHmac('sha256', key).update(message, 'utf8').digest();

/**
 * TC3 的规范串（导出便于测试：模板改动要能被用例挡住）。
 * 注意头块每行自带换行，模板在头块后再补一个换行 —— 所以头块与 SignedHeaders 之间是空行。
 */
export function canonicalRequest({ method, uri = '/', query = '', headers = [], signedHeaders, payload }) {
  const headerBlock = headers.map(([name, value]) => `${name.toLowerCase()}:${String(value).trim()}\n`).join('');
  return `${method}\n${uri}\n${query}\n${headerBlock}\n${signedHeaders}\n${sha256Hex(payload)}`;
}

/** TC3 签名（导出便于测试）：与官方 SDK 的 sign_tc3 同一套派生。 */
export function tc3Sign(secretKey, date, service, stringToSign) {
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  return crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');
}

/** 组装 Authorization 头（导出便于测试）。 */
export function tc3Authorization({ secretId, secretKey, date, service, stringToSign }) {
  const signature = tc3Sign(secretKey, date, service, stringToSign);
  return `TC3-HMAC-SHA256 Credential=${secretId}/${date}/${service}/tc3_request, `
    + `SignedHeaders=content-type;host, Signature=${signature}`;
}

/** 一句话识别：转写一段 16k 单声道 wav（≤60 秒，由上层分片）。返回纯文本。 */
export async function tencentTranscribe(wavBuffer, {
  secretId, secretKey, region = 'ap-guangzhou', engine = TENCENT_DEFAULT_ENGINE,
  timeoutMs = 60000, signal, fetchFn = fetch, nowFn = () => Math.floor(Date.now() / 1000)
} = {}) {
  if (!secretId) throw new Error('未配置腾讯云 SecretId');
  if (!secretKey) throw new Error('未配置腾讯云 SecretKey');
  const payload = JSON.stringify({
    Action: 'SentenceRecognition',
    Version: TENCENT_ASR_VERSION,
    EngSerViceType: String(engine || TENCENT_DEFAULT_ENGINE),
    SourceType: 1,                       // 1 = 直接传音频数据（base64）
    VoiceFormat: 'wav',
    Data: wavBuffer.toString('base64'),
    DataLen: wavBuffer.length            // 注意：是编码前的字节数
  });
  const timestamp = nowFn();
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);   // UTC 日期
  const contentType = 'application/json; charset=utf-8';
  const canonical = canonicalRequest({
    method: 'POST',
    uri: '/',
    query: '',
    headers: [['content-type', contentType], ['host', TENCENT_ASR_HOST]],
    signedHeaders: 'content-type;host',
    payload
  });
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, `${date}/${TENCENT_ASR_SERVICE}/tc3_request`, sha256Hex(canonical)].join('\n');
  const authorization = tc3Authorization({ secretId, secretKey, date, service: TENCENT_ASR_SERVICE, stringToSign });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('语音识别请求超时')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('已中止'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchFn(`https://${TENCENT_ASR_HOST}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'content-type': contentType,
        host: TENCENT_ASR_HOST,
        'X-TC-Action': 'SentenceRecognition',
        'X-TC-Version': TENCENT_ASR_VERSION,
        'X-TC-Timestamp': String(timestamp),
        ...(region ? { 'X-TC-Region': region } : {})
      },
      body: payload,
      signal: controller.signal
    });
    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch { /* 下面统一报错 */ }
    const err = data?.Response?.Error;
    if (err) {
      const hint = /SignatureFailure|AuthFailure/i.test(String(err.Code))
        ? '（签名/鉴权没通过：核对 SecretId/SecretKey 是否填反、是否属于同一账号、是否已开通语音识别）'
        : (/LimitExceeded|RequestLimitExceeded/i.test(String(err.Code)) ? '（请求超限：当日/当月免费额度可能用完了）' : '');
      throw new Error(`腾讯云语音识别失败：${err.Message || err.Code}（${err.Code}）${hint}`);
    }
    if (!res.ok) throw new Error(`腾讯云语音识别服务返回 ${res.status}：${String(body).slice(0, 200)}`);
    return String(data?.Response?.Result ?? '').trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 从配置取这套参数。 */
export function tencentOptions(cfg = getConfig()) {
  return {
    secretId: String(cfg?.asr?.secretId || '').trim(),
    secretKey: String(cfg?.asr?.secretKey || '').trim(),
    region: String(cfg?.asr?.region || '').trim() || 'ap-guangzhou',
    engine: String(cfg?.asr?.model || '').trim() || TENCENT_DEFAULT_ENGINE
  };
}
