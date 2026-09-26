// QQ 语音（SILK）解码。
//
// 背景（2026-09-26 生产实测）：QQ 的 record 段看起来是 .amr —— 文件名写着 `.amr`、CDN 还回
// `content-type: audio/mp3`，但实际字节是 **SILK**（文件头 `.#!SILK_V3`），而 ffmpeg 没有
// SILK 解码器，直接喂给它只会得到 "Invalid data found when processing input"
// （用户反馈"语音转文字失败"的根因就是这个）。协议端的 get_record 也不会转码：
// 传 out_format=mp3/wav 都只把同一个 CDN URL 原样返回（同一台 NapCat 上实测）。
//
// 所以这里自带解码：silk-wasm（WASM 实现，不需要本机编译），直接解成 16k 单声道 s16le PCM ——
// 与各家 ASR 期望的输入一致，连重采样都不用（decode 的第二参数就是输出采样率，实测 1 秒 = 32000 字节）。
import { decode as silkDecode, getDuration, isSilk } from 'silk-wasm';

/** 各家 ASR 都吃 16k 单声道。 */
export const SILK_SAMPLE_RATE = 16000;
/** SILK 文件头（QQ 的有两种写法：带 0x02 长度前缀、以及裸头）。 */
export const SILK_MAGIC = '#!SILK_V3';

/**
 * 是不是 QQ 语音的 SILK。
 * 以 silk-wasm 的判定为准，另留一条"文件头里出现 #!SILK_V3"的兜底
 * （库的判定更严格；兜底只为了让头部被少量脏字节污染的样本也能走对分支）。
 */
export function looksLikeSilk(buffer) {
  if (!buffer || buffer.length < 10) return false;
  try {
    if (isSilk(buffer)) return true;
  } catch { /* 库判定异常就退回看文件头 */ }
  return buffer.subarray(0, 16).toString('latin1').includes(SILK_MAGIC);
}

/** SILK → 16k 单声道 s16le PCM。返回 { pcm, durationMs }。 */
export async function silkToPcm(buffer, { sampleRate = SILK_SAMPLE_RATE } = {}) {
  const rate = Number(sampleRate) || SILK_SAMPLE_RATE;
  let durationMs = 0;
  try { durationMs = getDuration(buffer); } catch { /* 时长只是给日志/校验用，拿不到不算失败 */ }
  const { data, duration } = await silkDecode(buffer, rate);
  const pcm = Buffer.from(data);
  if (!pcm.length) throw new Error(`SILK 解码出来是空的（时长 ${duration || durationMs || '未知'}ms）`);
  return { pcm, durationMs: duration || durationMs };
}
