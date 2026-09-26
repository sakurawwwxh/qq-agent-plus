// 通用「OpenAI 兼容」语音转写：POST {baseUrl}/audio/transcriptions，multipart 上传音频文件。
// 覆盖绝大多数托管服务（OpenAI / Groq / SiliconFlow / 自建 faster-whisper 网关…），
// 所以用户换服务只需要改 baseUrl + model，不用等我们适配。
import { asrApiKey, getConfig } from '../core/config.js';

/** 16k 单声道 s16 PCM 套一个 WAV 头（托管服务普遍只吃带容器的文件，裸 PCM 不收）。 */
export function pcmToWav(pcm, { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt 块长度
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 拼转写端点：baseUrl 允许写成 https://host/v1 或 https://host/v1/。 */
export function transcriptionEndpoint(baseUrl) {
  return `${String(baseUrl || '').trim().replace(/\/+$/, '')}/audio/transcriptions`;
}

/**
 * 通用 OpenAI 兼容转写。返回纯文本；HTTP 非 2xx 时抛错（带上响应片段，便于用户自查）。
 * 端点由管理员在配置里指定（不是从消息内容来的），所以这里不做公网白名单校验。
 */
export async function openAiCompatibleTranscribe(wavBuffer, {
  baseUrl, apiKey, model, language = '', timeoutMs = 5 * 60 * 1000, signal, fetchFn = fetch
} = {}) {
  if (!baseUrl) throw new Error('未配置语音识别服务的地址（asr.baseUrl）');
  if (!apiKey) throw new Error('未配置语音识别服务的 API Key（asr.apiKey）');
  if (!model) throw new Error('未配置语音识别模型名（asr.model）');

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  if (language) form.append('language', language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('语音识别请求超时')), timeoutMs);
  // 已经中止的 signal 要在发请求之前就退出：只挂监听的话，请求会照发（取消后仍计费）
  if (signal?.aborted) throw signal.reason ?? new Error('已中止');
  const onAbort = () => controller.abort(signal?.reason ?? new Error('已中止'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchFn(transcriptionEndpoint(baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`语音识别服务返回 ${res.status}：${String(body).slice(0, 200)}`);
    let data = null;
    try { data = JSON.parse(body); } catch { /* 有的服务直接回纯文本 */ }
    return String(data ? (data.text ?? data?.result?.text ?? '') : body).trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 从配置里取 OpenAI 兼容那几个字段（默认 provider 预设：地址/模型留空时按预设补）。 */
export function openAiProviderOptions(cfg = getConfig()) {
  return {
    baseUrl: String(cfg?.asr?.baseUrl || '').trim(),
    apiKey: asrApiKey(cfg),   // 只认 asr.apiKey / ASR_API_KEY（读法与工具注入闸门共用一处实现）
    model: String(cfg?.asr?.model || '').trim(),
    language: String(cfg?.asr?.language || '').trim()
  };
}
