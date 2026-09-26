// 阿里云百炼（DashScope）语音识别：走它的 OpenAI 兼容 chat 端点，把音频作为 input_audio 塞进消息。
// 为什么不用 /audio/transcriptions：实测（2026-09-26，国内 VPS 无 Key）该路由 404，而同一主机上
// 故意问一个不存在的路由也 404（先路由后鉴权）→ 那个路由确实不存在；DashScope 的 ASR 是
// chat/completions + input_audio 这种形态。paraformer-v2 / sensevoice-v1 只有异步文件识别，暂不适配。
import { getConfig } from '../core/config.js';

/** 默认地址与模型（控制台预设用；也允许用户改成别的兼容网关）。 */
export const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DASHSCOPE_DEFAULT_MODEL = 'qwen3-asr-flash';

export function dashscopeEndpoint(baseUrl) {
  return `${String(baseUrl || DASHSCOPE_BASE_URL).trim().replace(/[/]+$/, '')}/chat/completions`;
}

/**
 * 转写一段音频（16k 单声道 WAV）。返回纯文本；HTTP 非 2xx 时抛错并带上响应片段。
 * 端点是管理员配置的（不是消息内容来的），因此不做公网白名单校验。
 */
export async function dashscopeTranscribe(wavBuffer, {
  baseUrl, apiKey, model, timeoutMs = 5 * 60 * 1000, signal, fetchFn = fetch
} = {}) {
  if (!apiKey) throw new Error('未配置 API Key（aliyun 用百炼的 API Key）');
  const useModel = String(model || '').trim() || DASHSCOPE_DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('语音识别请求超时')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('已中止'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchFn(dashscopeEndpoint(baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: useModel,
        messages: [{
          role: 'user',
          content: [{
            type: 'input_audio',
            input_audio: { data: `data:audio/wav;base64,${wavBuffer.toString('base64')}`, format: 'wav' }
          }]
        }]
      }),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`语音识别服务返回 ${res.status}：${String(text).slice(0, 200)}`);
    let data = null;
    try { data = JSON.parse(text); } catch { /* 有的网关直接回纯文本 */ }
    const content = data?.choices?.[0]?.message?.content;
    // content 可能是字符串，也可能是分块数组
    const out = Array.isArray(content)
      ? content.map((part) => String(part?.text ?? '')).join('')
      : String(content ?? '');
    return out.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 从配置取这套参数（与其它供应商同一写法）。 */
export function dashscopeOptions(cfg = getConfig()) {
  return {
    baseUrl: String(cfg?.asr?.baseUrl || '').trim() || DASHSCOPE_BASE_URL,
    apiKey: String(cfg?.asr?.apiKey || '').trim() || String(process.env.ASR_API_KEY || '').trim(),
    model: String(cfg?.asr?.model || '').trim() || DASHSCOPE_DEFAULT_MODEL
  };
}
