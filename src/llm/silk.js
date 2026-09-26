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
// 延迟加载依赖：silk-wasm 是"只有 QQ 语音才用到"的能力，做成启动硬依赖的话，
// 一个 `git pull` 后忘记 `npm ci` 的部署会直接起不来（2026-09-26 审查：静态 import 会把
// node_modules 没更新升级成整服务不可用）。这里改成用的时候再加载，缺了只影响 SILK 这一条路。
let silkLib = null;
let silkLibError = null;
async function loadSilk() {
  if (silkLib) return silkLib;
  if (silkLibError) throw silkLibError;
  try {
    silkLib = await import('silk-wasm');
    return silkLib;
  } catch (error) {
    silkLibError = new Error('这条语音是 QQ 的 SILK 格式，但服务器上没装解码依赖（silk-wasm）：'
      + '在安装目录跑一次 `npm ci`（或 npm install）再重试');
    silkLibError.cause = error;
    throw silkLibError;
  }
}

/** 各家 ASR 都吃 16k 单声道。 */
export const SILK_SAMPLE_RATE = 16000;
/** SILK 文件头（QQ 的有两种写法：带 0x02 长度前缀、以及裸头）。 */
export const SILK_MAGIC = '#!SILK_V3';

/**
 * 是不是 QQ 语音的 SILK。
 * 以 silk-wasm 的判定为准，另留一条"文件头里出现 #!SILK_V3"的兜底
 * （库的判定更严格；兜底只为了让头部被少量脏字节污染的样本也能走对分支）。
 */
export async function looksLikeSilk(buffer) {
  if (!buffer || buffer.length < 10) return false;
  // 先看文件头再问库：文件头这一条不依赖依赖包，deploy 漏装时也能立刻认出 SILK 并给出可照做的报错
  if (buffer.subarray(0, 16).toString('latin1').includes(SILK_MAGIC)) return true;
  try {
    const lib = await loadSilk();
    return Boolean(lib.isSilk(buffer));
  } catch {
    return false;   // 认不出来就当不是（上层会走 ffmpeg 并如实报错）
  }
}

/** SILK → 16k 单声道 s16le PCM。返回 { pcm, durationMs }。 */
export async function silkToPcm(buffer, { sampleRate = SILK_SAMPLE_RATE } = {}) {
  const lib = await loadSilk();
  const rate = Number(sampleRate) || SILK_SAMPLE_RATE;
  let durationMs = 0;
  try { durationMs = lib.getDuration(buffer); } catch { /* 时长只是给日志/校验用，拿不到不算失败 */ }
  const { data, duration } = await lib.decode(buffer, rate);
  const pcm = Buffer.from(data);
  if (!pcm.length) throw new Error(`SILK 解码出来是空的（时长 ${duration || durationMs || '未知'}ms）`);
  return { pcm, durationMs: duration || durationMs };
}
