// 火山引擎「豆包大模型语音合成 2.0」适配器：POST /api/v3/tts/unidirectional（NDJSON 流式）。
//
// 鉴权两种写法（2026-09-28 用真实账号实测都支持）：
//   · X-Api-Key: <密钥>                      —— 语音技术控制台的新版密钥，只填这一个（推荐，不需要 AppID）
//   · X-Api-App-Id + X-Api-Access-Key        —— 老的 AppID + Access Token 组合
// 这里按「AppID 是纯数字就优先走第二套，否则走 X-Api-Key」决定；两套都填了也不会出错（优先 AppID 那套）。
//
// 请求体：{ user:{uid}, req_params:{ text, speaker, audio_params:{ format, sample_rate, speech_rate, loudness_ratio } } }
// 响应逐行 JSON：数据行 { code:0, data:"<base64 音频块>" }，出错行带非 0 code，正常结束时给 code=20000000。
// 参数口径（实测）：speech_rate 与 v1 的 speed_ratio 同量纲（-50~100，即 (倍率-1)*100）；
// loudness_ratio 是倍率（(0,10]），所以 dB 增益要按 10^(dB/20) 换算；format 支持 mp3/wav/ogg_opus。
import crypto from 'node:crypto';
import { modelHttpError } from './model-http-error.js';
import { callJson } from './tts-http.js';

const DEFAULT_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_RESOURCE = 'seed-tts-2.0';
/** 声音复刻资源（S_/icl_ 音色必须配它，否则报 55000000 资源不匹配）。 */
const CLONE_RESOURCE = 'seed-icl-2.0';
const SUCCESS_CODE = 20000000;
export const MAX_TTS_CHARS = 300;

/** 火山错误码 → 人能看懂的下一步（v1 与 v3 共用）。 */
export function explainVolcError(code, message = '') {
  const msg = String(message || '').trim();
  const byCode = {
    3001: 'AppID / Access Token 不对，或账号没开通语音合成（v1 接口要「应用管理」里的数字 AppID）',
    3003: 'Access Token 无效',
    3005: '音色不存在或没开通',
    45000010: '鉴权失败：Key 不对。豆包 2.0 填的是控制台密钥（X-Api-Key），不是 AppID/Access Token',
    45000030: '账号没开通这个资源（resource not granted）：去火山控制台「开通管理」开通对应服务。'
      + '用复刻音色时要确认已开通「声音复刻2.0字符版」；后付费音色还要单独开通「后付费音色服务」',
    45000000: '请求里没有带鉴权信息',
    55000000: '音色与「资源 ID」不匹配：这个音色属于另一套资源 —— 1.0 音色要 seed-tts-1.0；'
      + 'S_ 开头的复刻音色要 seed-icl-2.0（适配器会按音色自动切换，若仍报此错请检查「资源 ID」栏是否被手改过）'
  };
  const hint = byCode[Number(code)];
  if (hint) return `${msg || '火山返回错误'}（${hint}）`;
  return msg || '火山返回了未知错误';
}

/**
 * 合成资源 ID 按音色路由（2026-09-30 用户反馈 + 生产账号实测）：
 * 声音复刻音色（控制台给的 `S_xxx`，或批量查询接口给的 `icl_xxx`）必须配 `seed-icl-2.0` ——
 * 配默认的 seed-tts-2.0 会报 55000000「resource ID is mismatched with speaker related resource」。
 * 注意**大小写**：官方音色 `ICL_uranus_*`（大写 ICL_）是火山自营音色、跟普通 2.0 一样走 seed-tts-2.0，
 * 别误伤（实测该音色配 seed-tts-2.0 正常出音频）。
 * 用户显式填 `seed-icl-*` 时尊重（复刻 1.0 老音色要 seed-icl-1.0）。
 */
export function doubaoResourceIdForVoice(voice, configured = '') {
  const want = String(configured || '').trim();
  if (/^seed-icl-/i.test(want)) return want;
  const v = String(voice || '').trim();
  if (/^S_/.test(v) || /^icl_/.test(v)) return CLONE_RESOURCE;
  return want || DEFAULT_RESOURCE;
}

/** 解析 NDJSON 流式响应：取出所有音频块，并记住最后一处非 0 code（错误或结束码）。 */
export function parseTtsStream(text) {
  const chunks = [];
  let code = 0;
  let message = '';
  let headerCode = 0;
  let headerMessage = '';
  const lines = String(text || '').split(/\r?\n/);
  let parsedLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let json = null;
    try { json = JSON.parse(line); } catch { continue; }
    parsedLines += 1;
    const h = json.header;
    if (h && Number(h.code)) { headerCode = Number(h.code); headerMessage = String(h.message || ''); }
    if (json.data) {
      try { chunks.push(Buffer.from(String(json.data), 'base64')); } catch { /* 坏块跳过 */ }
    }
    const c = Number(json.code || 0);
    if (c && c !== SUCCESS_CODE) { code = c; message = String(json.message || ''); }
  }
  return { buffer: Buffer.concat(chunks), code, message, headerCode, headerMessage, parsedLines };
}

/**
 * 豆包大模型语音合成 2.0。
 * cfg：baseUrl（默认官方）、apiKey（X-Api-Key 密钥）/ appId + apiKey（AppID 模式下 apiKey = Access Token）、
 *      resourceId（默认 seed-tts-2.0；克隆音色会自动改走 seed-icl-2.0，见 doubaoResourceIdForVoice）、
 *      voice（speaker 音色 ID）、format、speed（倍率）、gain（dB）、timeoutMs。
 */
export async function synthesizeDoubao({ cfg, text, signal = null, fetchFn = fetch }) {
  const base = String(cfg?.baseUrl || DEFAULT_URL).trim().replace(/\/+$/, '');
  const key = String(cfg?.apiKey || '').trim();
  const appId = String(cfg?.appId || '').trim();
  const voice = String(cfg?.voice || '').trim();
  const resourceId = doubaoResourceIdForVoice(voice, cfg?.resourceId);
  const format = String(cfg?.format || 'mp3').trim() || 'mp3';
  const body = String(text || '').trim().slice(0, MAX_TTS_CHARS);
  if (!key) throw new Error('豆包语音合成需要 API Key（控制台里拿的密钥，填「API Key」那一栏）');
  if (!voice) throw new Error('豆包语音合成需要音色（speaker，如 zh_female_vv_uranus_bigtts）');
  if (!body) throw new Error('要合成的文本为空');

  const speed = Number(cfg?.speed);
  const gain = Number(cfg?.gain);
  const audioParams = {
    format,
    sample_rate: 24000,
    speech_rate: Number.isFinite(speed) && speed !== 1
      ? Math.min(100, Math.max(-50, Math.round((speed - 1) * 100)))
      : 0,
    // 与 MiniMax 同一个坑：配置里是 dB，接口要倍率 → 10^(dB/20)
    loudness_ratio: Number.isFinite(gain) && gain !== 0
      ? Math.min(10, Math.max(0.1, Math.pow(10, Math.min(10, Math.max(-10, gain)) / 20)))
      : 1
  };
  // AppID 只可能是纯数字（用户把"资源 ID/音色"填进来时不是数字）→ 这样判不会误走 AppID 那套
  const useAppIdAuth = /^\d{5,15}$/.test(appId);
  const headers = {
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': crypto.randomUUID(),
    ...(useAppIdAuth
      ? { 'X-Api-App-Id': appId, 'X-Api-Access-Key': key }
      : { 'X-Api-Key': key })
  };
  const { ok, status, text: raw } = await callJson(fetchFn, base, {
    headers,
    body: { user: { uid: 'qq-agent-plus' }, req_params: { text: body, speaker: voice, audio_params: audioParams } },
    timeoutMs: cfg?.timeoutMs,
    signal
  });
  const { buffer, code, message, headerCode, headerMessage, parsedLines } = parseTtsStream(raw);
  if (ok === false || !buffer.length) {
    const errCode = headerCode || code;
    const detail = errCode
      ? explainVolcError(errCode, headerMessage || message)
      : `响应里没有音频数据：${String(raw).slice(0, 200)}`;
    throw modelHttpError(`豆包语音合成失败 HTTP ${status}：${detail}`
      + (parsedLines ? '' : '（响应不像 NDJSON，检查「服务地址」是不是填成了 v1 或别家接口）'), status, raw);
  }
  return { buffer, format };
}
