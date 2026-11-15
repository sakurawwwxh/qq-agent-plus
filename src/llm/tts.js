// 语音合成入口：按 provider 分发到各家适配器。
//   openai  —— OpenAI 兼容 POST /audio/speech（硅基流动 / OpenAI / 自建；实测过）
//   volc    —— 火山引擎「语音合成」v1 HTTP（openspeech.bytedance.com/api/v1/tts，AppID + Access Token）
//   doubao  —— 火山引擎「豆包语音合成 2.0」v3 HTTP 流式（api/v3/tts/unidirectional，X-Api-Key）
//   minimax —— MiniMax T2A v2（api.minimax.chat/v1/t2a_v2，音频是 hex 编码）
//   mimo    —— 小米 MiMo（token-plan 的 chat/completions 音频输出，支持导演指令/情绪）
// volc / minimax 按官方文档实现、机器上没有凭据未实测；doubao 2026-09-28 用真实账号实测通过
// （音频、语速、音量、格式、错误码都核过）。mimo 2026-10-25 用 token-plan 账号实测通过。
import crypto from 'node:crypto';
import { getConfig } from '../core/config.js';
import { modelHttpError } from './model-http-error.js';
import { withModelReplacement } from '../core/model-replacement.js';
import { synthesizeSpeech as openaiSpeech } from './tts-openai.js';
import { synthesizeDoubao, explainVolcError } from './tts-doubao.js';
import { synthesizeMimo } from './tts-mimo.js';
import { callJson } from './tts-http.js';
import { ttsServiceOfBaseUrl, ttsServiceOf, ttsKeyFor } from './tts-presets.js';

export { ttsConfigured } from './tts-openai.js';

/**
 * v1 的 cluster 按音色路由（官方 v1 文档：业务集群「标准音色、复刻等均不相同」，
 * 复刻音色要 volcano_icl；多个公开实现亦如此）。与 v3 的资源 ID 同一类坑：
 * 复刻音色配默认的 volcano_tts 会报「音色不存在/初始化引擎失败」。
 * 用户显式填 volcano_icl*（含并发版 volcano_icl_concurr）时尊重。
 * 注意大小写：官方自营音色 `ICL_uranus_*`（大写）不是复刻音色，别误伤。
 */
export function volcClusterForVoice(voice, configured = '') {
  const want = String(configured || '').trim();
  if (/^(volcano_icl|seed-icl)/i.test(want)) return want;
  const v = String(voice || '').trim();
  if (/^S_/.test(v) || /^icl_/.test(v)) return 'volcano_icl';
  return want || 'volcano_tts';
}

/** 火山引擎语音合成（v1 HTTP）。cfg：baseUrl（默认官方）、appId、apiKey（access token）、cluster、voice、speed。 */
export async function synthesizeVolc({ cfg, text, signal = null, fetchFn = fetch }) {
  const base = String(cfg?.baseUrl || 'https://openspeech.bytedance.com/api/v1/tts').trim().replace(/\/+$/, '');
  const appId = String(cfg?.appId || '').trim();
  const token = String(cfg?.apiKey || '').trim();
  const voice = String(cfg?.voice || '').trim();
  const cluster = volcClusterForVoice(voice, cfg?.cluster);
  const body = String(text || '').trim().slice(0, 300);
  if (!appId || !token) throw new Error('火山语音合成需要 AppID 与 Access Token（语音技术控制台里拿）');
  if (!voice) throw new Error('火山语音合成需要音色（voice_type，如 BV001_streaming）');
  if (!body) throw new Error('要合成的文本为空');
  const speed = Number(cfg?.speed);
  const req = {
    app: { appid: appId, token, cluster },
    user: { uid: 'qq-agent-plus' },
    audio: {
      voice_type: voice,
      encoding: 'mp3',
      speed_ratio: Number.isFinite(speed) && speed !== 1 ? Math.min(3, Math.max(0.2, speed)) : 1
    },
    request: { reqid: crypto.randomUUID(), text: body, operation: 'query', with_frontend: 1, frontend_type: 'unitTson' }
  };
  const { ok, status, parsed, text: raw } = await callJson(fetchFn, base, {
    headers: { authorization: `Bearer;${token}` },
    body: req,
    timeoutMs: cfg?.timeoutMs,
    signal
  });
  if (ok === false || !parsed || (parsed.code !== 3000 && !parsed.data)) {
    throw modelHttpError(`火山语音合成失败 HTTP ${status}：${explainVolcError(parsed?.code, parsed?.message || raw)}`, status, parsed);
  }
  const buffer = Buffer.from(String(parsed.data), 'base64');
  if (!buffer.length) throw new Error('火山语音合成返回了空音频');
  return { buffer, format: 'mp3' };
}

/** MiniMax T2A v2。cfg：baseUrl（默认官方）、apiKey、groupId、model、voice、speed、gain(vol)。 */
export async function synthesizeMinimax({ cfg, text, signal = null, fetchFn = fetch }) {
  const base = String(cfg?.baseUrl || 'https://api.minimax.chat').trim().replace(/\/+$/, '');
  const key = String(cfg?.apiKey || '').trim();
  const groupId = String(cfg?.groupId || '').trim();
  const model = String(cfg?.model || 'speech-01-turbo').trim();
  const voice = String(cfg?.voice || '').trim();
  const body = String(text || '').trim().slice(0, 300);
  if (!key) throw new Error('MiniMax 需要 API Key');
  if (!groupId) throw new Error('MiniMax 需要 GroupId（控制台 → 账户信息里）');
  if (!voice) throw new Error('MiniMax 需要音色（voice_id，如 female-shaonv）');
  if (!body) throw new Error('要合成的文本为空');
  const speed = Number(cfg?.speed);
  const gain = Number(cfg?.gain);
  const req = {
    model,
    text: body,
    stream: false,
    voice_setting: {
      voice_id: voice,
      speed: Number.isFinite(speed) && speed !== 1 ? Math.min(2, Math.max(0.5, speed)) : 1,
      // MiniMax 的 vol 是倍率（(0,10]，默认 1）不是 dB：按 10^(dB/20) 换算并夹紧，
      // 免得把 -10 之类的 dB 值原样发过去被判非法（2026-09-28 自查）
      vol: Number.isFinite(gain) && gain !== 0
        ? Math.min(10, Math.max(0.1, Math.pow(10, Math.min(10, Math.max(-10, gain)) / 20)))
        : 1,
      pitch: 0
    },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' }
  };
  const url = `${base}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;
  const { ok, status, parsed, text: raw } = await callJson(fetchFn, url, {
    headers: { authorization: `Bearer ${key}` },
    body: req,
    timeoutMs: cfg?.timeoutMs,
    signal
  });
  const statusCode = parsed?.base_resp?.status_code;
  if (ok === false || !parsed || (statusCode !== undefined && statusCode !== 0) || !parsed?.data?.audio) {
    throw modelHttpError(`MiniMax 语音合成失败 HTTP ${status}：${String(parsed?.base_resp?.status_msg || raw).slice(0, 200)}`, status, parsed);
  }
  const buffer = Buffer.from(String(parsed.data.audio), 'hex');   // T2A v2 的音频是 hex 编码
  if (!buffer.length) throw new Error('MiniMax 语音合成返回了空音频');
  return { buffer, format: 'mp3' };
}

/** 统一入口：按 cfg.provider 分发（缺省 openai 兼容）。 */
export async function synthesizeSpeech(args = {}) {
  const current = getConfig();
  const initial = { ...current, tts: args.cfg || current.tts };
  return withModelReplacement('tts', initial, (cfg) => synthesizeSpeechOnce({ ...args, cfg: cfg.tts }), { signal: args.signal });
}

async function synthesizeSpeechOnce(args = {}) {
  // 地址决定实际打到谁家：先用 baseUrl 反查预设（火山 v1 与豆包 v3 同域名、按路径区分），
  // 认不出才用配置里的 provider（手写的 config.json 也就不用再猜 provider）
  const declared = String(args?.cfg?.provider || '').trim().toLowerCase();
  const inferred = ttsServiceOfBaseUrl(args?.cfg?.baseUrl || '')?.provider || '';
  const provider = inferred || (['openai', 'volc', 'volcengine', 'doubao', 'minimax', 'mimo'].includes(declared) ? declared : 'openai');
  // Key 按"当前这家"取（keys 映射 → 旧的单 apiKey 兜底），再交给适配器
  const resolved = { ...(args.cfg || {}), apiKey: ttsKeyFor(args?.cfg, ttsServiceOf(args?.cfg)?.id) };
  const next = { ...args, cfg: resolved };
  if (provider === 'mimo') return synthesizeMimo(next);
  if (provider === 'doubao') return synthesizeDoubao(next);
  if (provider === 'volc' || provider === 'volcengine') return synthesizeVolc(next);
  if (provider === 'minimax') return synthesizeMinimax(next);
  return openaiSpeech(next);
}
