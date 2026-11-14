// 小米 MiMo 语音合成（token-plan 的 chat/completions 音频输出）。
//
// 与其它 TTS 适配器不同，MiMo 走的是「聊天补全」接口：要说的内容放在 assistant 消息里，
// 一句导演指令放在可选的 user 消息里，音频从 choices[0].message.audio.data 取（base64）。
// 实测（2026-10-25，token-plan 账号）：
//   · POST https://token-plan-cn.xiaomimimo.com/v1/chat/completions
//   · 鉴权头是 `api-key`（不是 Authorization: Bearer）
//   · model: mimo-v2.5-tts（复刻音色用 mimo-v2.5-tts-voiceclone，voice 传 data:audio/...;base64,...）
//   · 有导演指令时 2.1s，没有时 1.8s；同一句的停顿与语气明显不同
// 这里只做说话，不做唱歌：唱歌要换声线/伴奏，属于另一条链路，别在这个适配器里混。
import { modelHttpError } from './model-http-error.js';
import { callJson } from './tts-http.js';

export const MIMO_DEFAULT_URL = 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions';
export const MIMO_DEFAULT_MODEL = 'mimo-v2.5-tts';
export const MIMO_DEFAULT_VOICE = 'mimo_default';
const MAX_TEXT_CHARS = 300;

/** 情绪词 → 导演提示。中英文都认，模型偶尔会把 enum 之外的中文词塞进来。 */
const EMOTIONS = {
  neutral: '平静、自然，不要刻意用力',
  happy: '开心、轻快，语气往上一点',
  sad: '低落、慢一点，句尾不要抬',
  angry: '生气，但别吼，压着声音说',
  soft: '温柔、轻声，像在耳边说话',
  excited: '兴奋、语速偏快，但别喊',
  tired: '疲惫、有点懒，说话带点拖',
  shy: '害羞，声音偏小、有点犹豫',
  playful: '俏皮、带点笑意，别播音腔',
  serious: '认真、沉稳，像在交代正事'
};
const EMOTION_ALIASES = {
  平静: 'neutral', 自然: 'neutral', 一般: 'neutral',
  开心: 'happy', 高兴: 'happy', 愉快: 'happy',
  难过: 'sad', 低落: 'sad', 伤心: 'sad',
  生气: 'angry', 愤怒: 'angry',
  温柔: 'soft', 轻声: 'soft',
  兴奋: 'excited', 激动: 'excited',
  累: 'tired', 疲惫: 'tired',
  害羞: 'shy', 害羞的: 'shy',
  俏皮: 'playful', 调皮: 'playful',
  认真: 'serious', 严肃: 'serious'
};

export function normalizeEmotion(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const chinese = String(value || '').trim();
  const key = EMOTION_ALIASES[chinese] || raw;
  return Object.hasOwn(EMOTIONS, key) ? key : '';
}

/**
 * 把「情绪 + 用户填的导演指令」拼成 MiMo 的 user 消息。
 * 导演指令写在最前面（它可以包含【角色】【场景】这类完整设定），情绪作为单独一行追加，
 * 避免情绪词被长指令淹没。没有情绪也没有自定义指令时仍给一段默认口语指导 ——
 * 实测同样的文本，有这段指导时停顿更自然、播音腔更少。
 */
export function mimoInstruction({ emotion = '', director = '' } = {}) {
  const lines = [];
  const base = String(director || '').trim();
  if (base) lines.push(base);
  const key = normalizeEmotion(emotion);
  if (key) lines.push(`【情绪】${EMOTIONS[key]}。`);
  lines.push('【场景】在 QQ 群里随口说话，不是在录节目。');
  lines.push('【指导】用自然口语，像真人聊天；句末自然收住，不要拖长音，不要播音腔。');
  return lines.join('\n');
}

/** baseUrl 允许填到 /v1 或完整的 /v1/chat/completions，两种都能用。 */
function endpointOf(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return MIMO_DEFAULT_URL;
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

/**
 * MiMo 语音合成。
 * cfg：baseUrl（默认 token-plan 官方）、apiKey、model、voice、format、director、timeoutMs。
 * args.emotion 由 send_voice 传入；args.instruction 可直接覆盖拼好的导演提示（测试/高级用法）。
 */
export async function synthesizeMimo({
  cfg,
  text,
  emotion = '',
  instruction = '',
  signal = null,
  fetchFn = fetch
} = {}) {
  const url = endpointOf(cfg?.baseUrl);
  const key = String(cfg?.apiKey || '').trim();
  const model = String(cfg?.model || MIMO_DEFAULT_MODEL).trim() || MIMO_DEFAULT_MODEL;
  const voice = String(cfg?.voice || MIMO_DEFAULT_VOICE).trim() || MIMO_DEFAULT_VOICE;
  const format = String(cfg?.format || 'mp3').trim() || 'mp3';
  const body = String(text || '').trim().slice(0, MAX_TEXT_CHARS);
  if (!key) throw new Error('MiMo 语音合成需要 API Key（token-plan 控制台里的 Key，填「API Key」那一栏）');
  if (!body) throw new Error('要合成的文本为空');

  const director = String(instruction || '').trim()
    || mimoInstruction({ emotion, director: cfg?.director });
  const messages = [];
  if (director) messages.push({ role: 'user', content: director });
  messages.push({ role: 'assistant', content: body });

  const { ok, status, parsed, text: raw } = await callJson(fetchFn, url, {
    headers: { 'api-key': key },
    body: { model, messages, audio: { format, voice } },
    timeoutMs: cfg?.timeoutMs,
    signal
  });

  const data = parsed?.choices?.[0]?.message?.audio?.data;
  if (ok === false || !data) {
    const detail = String(parsed?.error?.message || parsed?.message || raw || '').trim().slice(0, 200);
    throw modelHttpError(`MiMo 语音合成失败 HTTP ${status}${detail ? `：${detail}` : ''}`
      + '（检查 Key、模型名、音色；token-plan 的地址应以 /v1 结尾）', status, parsed);
  }
  const base64 = String(data).replace(/^data:[^,]*,/, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('MiMo 语音合成返回了空音频');
  return { buffer, format };
}
