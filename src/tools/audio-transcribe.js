// 语音/视频转文字：取文件 URL → ffmpeg 转 16k PCM → 交给配置的语音识别服务。
// 聊天模型无关：任何模型都消费转写文本，音频理解不依赖多模态。
// 供应商可换（见 config.asr.provider）：火山 Seed-ASR / 任意 OpenAI 兼容服务 / 本机 whisper.cpp。
import { spawn } from 'node:child_process';
// fs/path/os 用顶层静态 import：函数体里的 `const { x } = await import(...)`
// 在 ops scan --strict 里会被判成"调用点有、定义没有"（CI 硬门禁），
// 而且这里也没有延迟加载的必要。
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFetchBinary } from '../llm/safe-fetch.js';
import { seedAsrTranscribe } from '../llm/seed-asr.js';
import {
  asrApiKey, asrConfigured, asrLocalBin, asrLocalModel, asrMaxPerHour, asrProvider, getConfig
} from '../core/config.js';
import { openAiCompatibleTranscribe, openAiProviderOptions, pcmToWav } from '../llm/asr-openai.js';
import { localWhisperTranscribe, resolveWhisperBin } from '../llm/asr-local.js';
import { dashscopeOptions, dashscopeTranscribe } from '../llm/asr-dashscope.js';
import { baiduOptions, baiduTranscribe } from '../llm/asr-baidu.js';
import { tencentOptions, tencentTranscribe } from '../llm/asr-tencent.js';
import { iflytekOptions, iflytekTranscribe } from '../llm/asr-iflytek.js';

const AUDIO_MAX_BYTES = 200 * 1024 * 1024; // 200MB：QQ 文件上限内
// PCM 全量进内存：16kHz 单声道 s16 = 32KB/s，15 分钟约 28.8MB（上限按这个算）。
// 更要防的是"群友连发长语音刷账单"，所以再加一道每小时次数闸门（asr.maxPerHour）。
const ASR_MAX_PCM_SECONDS = 60 * 15;

// 跨会话共享的小时窗口计数器（进程内）。restart 归零对"按量计费"这个目的够用：
// 它防的是同一个群里连着刷，不是精确计费对账。
const asrQuota = { hour: -1, used: 0 };
/** 取一次转写配额；额度用尽返回 false。导出仅供测试。 */
export function consumeAsrQuota(now = Date.now(), cfg = getConfig()) {
  const hour = Math.floor(now / 3600000);
  if (asrQuota.hour !== hour) { asrQuota.hour = hour; asrQuota.used = 0; }
  const limit = asrMaxPerHour(cfg);
  if (asrQuota.used >= limit) return false;
  asrQuota.used += 1;
  return true;
}
/** 测试用：重置窗口。 */
export function resetAsrQuota() { asrQuota.hour = -1; asrQuota.used = 0; }

/** ffmpeg 转 16k mono s16le PCM（文件路径输入，导出仅供测试）。 */
export function ffmpegToPcm(inputPath, { timeoutMs = 10 * 60 * 1000, signal } = {}) {
  // ⚠️ 必须用文件路径而不是 pipe:0：m4a/mp4 的 moov atom 常在文件尾部，
  // 管道输入无法 seek，demux 直接失败（moov atom not found / partial file）。
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error',
      '-i', inputPath,
      '-vn',                    // 视频：丢画面只留音轨
      '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* noop */ } reject(e); } };
    const timer = setTimeout(() => fail(new Error('音频转换超时')), timeoutMs);
    const onAbort = () => fail(signal?.reason ?? new Error('已中止'));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > ASR_MAX_PCM_SECONDS * 32000) { // 16k*2byte
        return fail(new Error(`音频过长（超过 ${ASR_MAX_PCM_SECONDS / 60} 分钟），暂不支持`));
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-500); });
    child.on('error', (e) => fail(new Error(`ffmpeg 不可用：${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && size > 0) return resolve(Buffer.concat(chunks));
      reject(new Error(`音频转换失败（ffmpeg ${code}）：${stderr.trim().slice(-200) || '无输出'}`));
    });
  });
}

/**
 * 从消息 entry 提取可转写的音频 URL。
 * 优先 getMsg 现取（URL 短期有效），退到 entry.media 存档。
 */
export async function currentMessageAudioUrl(ctx, entry) {
  let media = entry.media || [];
  if (entry.mid != null && typeof ctx.onebot?.getMsg === 'function') {
    try {
      const data = await ctx.onebot.getMsg(entry.mid);
      const segments = Array.isArray(data?.message) ? data.message : [];
      const fresh = [];
      for (const seg of segments) {
        const d = seg?.data ?? {};
        if (seg?.type === 'record' || seg?.type === 'voice') fresh.push({ kind: 'audio', url: String(d.url || d.file || '') });
        else if (seg?.type === 'video') fresh.push({ kind: 'audio', url: String(d.url || d.file || '') });
        else if (seg?.type === 'file') {
          const name = String(d.name || d.file || '');
          if (/\.(m4a|mp3|wav|amr|aac|ogg|flac|wma|mp4|mov|avi|mkv|webm)$/i.test(name)) {
            fresh.push({ kind: 'audio', url: String(d.url || ''), name });
          }
        }
      }
      const usable = fresh.filter((x) => x.url);
      if (usable.length) return usable[0];
      // file 段的 url 可能为空：OneBot 侧已有 file_id 缓存，可通过 get_file/get_*_file_url 换取
      const fileSeg = segments.find((s) => s?.type === 'file');
      if (fileSeg) {
        return { kind: 'audio', url: '', fileSegId: String(fileSeg.data?.file_id || fileSeg.data?.id || ''), name: String(fileSeg.data?.name || '') };
      }
    } catch { /* 源消息过期时退到存档 */ }
  }
  const archived = media.find((m) => m?.kind === 'audio' && m.url);
  return archived ? { kind: 'audio', url: String(archived.url), name: String(archived.name || '') } : null;
}

/**
 * 按配置的供应商转写：三个后端各自处理"要什么输入"的差异，主流程只管路由。
 * 火山吃裸 PCM（WS 分片），OpenAI 兼容吃带容器的文件，本机 whisper.cpp 吃文件路径。
 */
/**
 * 四家国内云的「短语音」接口单次都只收 ≤60 秒：更长的音频由这里切片后逐段转写再拼起来。
 * 55 秒一段（留余量），片与片之间不做重叠 —— 切在词中间时那一处可能略糙，这是短接口的固有代价。
 */
export const SHORT_API_CHUNK_SECONDS = 55;
/** OpenAI 兼容服务多为 25MB 上传上限：留出余量，超过就分片（15 分钟音频约 28.8MB）。 */
export const OPENAI_WAV_MAX_BYTES = 20 * 1024 * 1024;
/**
 * 按音频实际时长推流的供应商（本机 whisper 约 1.5~2 倍实时、讯飞按 40ms/帧真实节奏）。
 * 它们转不了长音频：一次运行有总时限（默认 180 秒、上限 240 秒），超了必然中途被掐断。
 * 与其让用户等两分钟拿一句 "Run deadline exceeded"，不如提前说清并给替代方案（2026-09-26 审查）。
 */
export const PACED_ASR_PROVIDERS = ['local', 'iflytek'];

/** 把 PCM 切成若干段（导出便于测试）。 */
export function chunkPcm(pcm, seconds = SHORT_API_CHUNK_SECONDS, bytesPerSecond = 32000) {
  const size = Math.max(1, Math.round(seconds * bytesPerSecond));
  const out = [];
  for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, Math.min(i + size, pcm.length)));
  return out.length ? out : [pcm];
}

/**
 * 逐片转写后拼接：中文/标点直接相连（这几家自带标点），但只要两侧都是西文单词字符
 * 就补一个空格 —— 55 秒切在词中间时，否则会拼出 helloworld（2026-09-26 审查）。
 */
export function joinChunkTexts(texts) {
  let out = '';
  for (const raw of texts) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(text)) out += ' ';
    out += text;
  }
  return out;
}

async function transcribeInChunks(pcm, perChunk, { signal } = {}) {
  const pieces = chunkPcm(pcm);
  const texts = [];
  for (let i = 0; i < pieces.length; i += 1) {
    signal?.throwIfAborted();
    try {
      const text = await perChunk(pieces[i], { signal });
      if (text) texts.push(String(text));
    } catch (error) {
      // 已经转写（也已经计费）的前几片别白丢：把进度写进错误里，用户至少知道钱花在哪、要不要重试
      const detail = String(error?.message ?? error);
      throw new Error(pieces.length > 1
        ? `第 ${i + 1}/${pieces.length} 片转写失败（前 ${texts.length} 片已出结果）：${detail}`
        : detail);
    }
  }
  return joinChunkTexts(texts);
}

export async function runProvider(cfg, pcm, { signal } = {}) {
  const provider = asrProvider(cfg);
  if (provider === 'local') return await localTranscribe(cfg, pcm, signal);
  if (provider === 'openai') {
    const wav = pcmToWav(pcm);
    // 多数 OpenAI 兼容服务对上传体积有 25MB 上限，而 15 分钟 = 28.8MB 必被拒。
    // 正常长度的语音仍然整段发（保留上下文与标点），只有超限的才切片（2026-09-26 审查）。
    if (wav.length <= OPENAI_WAV_MAX_BYTES) {
      return await openAiCompatibleTranscribe(wav, { ...openAiProviderOptions(cfg), signal });
    }
    return await transcribeInChunks(pcm, (piece) => openAiCompatibleTranscribe(
      pcmToWav(piece), { ...openAiProviderOptions(cfg), signal }
    ), { signal });
  }
  if (provider === 'aliyun') {
    // 百炼走的是 chat 接口：单请求能吃多长没有公开上限（未实测），所以与短接口一样分片，
    // 免得长音频整条被服务端拒掉（2026-09-26 审查意见）。
    return await transcribeInChunks(pcm, (piece) => dashscopeTranscribe(pcmToWav(piece), { ...dashscopeOptions(cfg), signal }), { signal });
  }
  if (provider === 'baidu') {
    return await transcribeInChunks(pcm, (piece) => baiduTranscribe(piece, { ...baiduOptions(cfg), signal }), { signal });
  }
  if (provider === 'tencent') {
    return await transcribeInChunks(pcm, (piece) => tencentTranscribe(pcmToWav(piece), { ...tencentOptions(cfg), signal }), { signal });
  }
  if (provider === 'iflytek') {
    return await transcribeInChunks(pcm, (piece) => iflytekTranscribe(piece, { ...iflytekOptions(cfg), signal }), { signal });
  }
  return await seedAsrTranscribe(pcm, { apiKey: asrApiKey(cfg), signal });
}

/**
 * 本机转写的超时：按音频长度放大（CPU 约 1.5~2 倍实时，2 核小机器上 15 分钟音频要跑很久）。
 * 60 秒起步，约 8 倍音频时长封顶 30 分钟 —— 固定 10 分钟会把长音频一律掐成"超时"。
 */
export function localTimeoutMs(pcmBytes) {
  const seconds = Math.max(1, Math.round(Number(pcmBytes || 0) / 32000));   // 16k 单声道 s16 = 32KB/s
  return Math.min(30 * 60 * 1000, 60 * 1000 + seconds * 8 * 1000);
}

/**
 * 按真实时长推流的供应商，单次运行最多能转多少秒音频：
 * 预算 = 运行总时限（默认 180 秒，上限 240 秒）减去握手/下载/转码/模型轮次的余量；
 * 本机 whisper 约 2 倍实时，能转的时长再砍半。返回 0 表示"不做这道闸门"（一次上传的服务不受限）。
 */
export function pacedAudioLimitSeconds(cfg, provider) {
  if (!PACED_ASR_PROVIDERS.includes(provider)) return 0;
  const runMs = Math.min(240000, Number(cfg?.api?.runTimeoutMs) || 180000);
  const budget = Math.max(30, Math.round(runMs / 1000) - 30);
  return provider === 'local' ? Math.floor(budget / 2) : budget;
}

/** 本机转写：whisper.cpp 只吃文件，所以把 PCM 套 WAV 头落盘再调用（fs/path/os 都在文件顶层 import）。 */
async function localTranscribe(cfg, pcm, signal) {
  const configured = asrLocalBin(cfg);
  const bin = await resolveWhisperBin(configured);
  if (!bin) {
    const named = String(cfg?.asr?.localBin || '').trim();
    throw new Error(named
      // 配置里填了路径却跑不起来：必须把那条路径说出来，否则用户只能猜（2026-09-26 审查）
      ? `本机转写不可用：配置里的可执行文件跑不起来（${named}）。核对路径，或清空后让服务自动找 `
        + 'whisper-cli；也可以把「识别服务」换成火山或 OpenAI 兼容服务'
      : '本机转写没装好（找不到 whisper.cpp 可执行文件）：在服务器上跑一次 '
        + '`node scripts/install-asr-local.mjs` 即可；也可以把「识别服务」换成火山或 OpenAI 兼容服务');
  }
  const wavPath = join(tmpdir(), `qa-asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  writeFileSync(wavPath, pcmToWav(pcm));
  try {
    return await localWhisperTranscribe(wavPath, {
      bin,
      model: asrLocalModel(cfg),
      language: String(cfg?.asr?.language || 'zh').trim(),
      timeoutMs: localTimeoutMs(pcm.length),
      signal
    });
  } finally {
    try { rmSync(wavPath, { force: true }); } catch { /* 清不掉无害 */ }
  }
}

/** 主入口：给 tools-core 的 get_message_audio 工具用，返回转写文本。 */
export async function transcribeMessageAudio(ctx, entry) {
  const target = await currentMessageAudioUrl(ctx, entry);
  if (!target) return { ok: false, error: '这条消息里没有可识别的音频/视频内容' };
  let tmpFile = null;
  try {
    if (!target.url) {
      return { ok: false, error: `文件「${target.name || '未知'}」拿不到下载地址（协议端未提供 URL），暂无法转写` };
    }
    // "压根没配好"要在扣配额/下载之前就判掉：否则用户白扣一次额度、白下载转码一遍，
    // 最后才看到"还没配好"（2026-09-26 审查）。
    if (!asrConfigured(getConfig())) {
      return { ok: false, error: '语音识别还没配好，无法转写音频。请管理员在控制台「设置 → 语音转文字」里把当前供应商填齐（或设环境变量 ASR_API_KEY）' };
    }
    // 配额在"确定要下载+转码"这一步才扣：调错消息（没有音频/拿不到地址）不该消耗额度，
    // 但下载与转码本身就占资源，所以在下载前扣。按量计费的服务，这道闸门是真金白银。
    if (!consumeAsrQuota()) {
      return { ok: false, error: `本小时的语音转写次数已用完（上限 ${asrMaxPerHour(getConfig())} 次/小时，可在控制台「语音转文字」里调整），稍后再试` };
    }
    let buffer;
    try {
      ({ buffer } = await safeFetchBinary(target.url, AUDIO_MAX_BYTES, ctx.signal));
    } catch (e) {
      return { ok: false, error: `音频下载失败：${String(e?.message ?? e)}` };
    }
    // m4a/mp4 的 moov atom 常在尾部，ffmpeg 管道输入无法 seek——必须落盘成临时文件
    const ext = /\.(m4a|mp3|wav|amr|aac|ogg|flac|wma|mp4|mov|avi|mkv|webm)$/i.exec(target.name || '')?.[1] || 'bin';
    tmpFile = join(tmpdir(), `qa-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    writeFileSync(tmpFile, buffer);
    let pcm;
    try {
      pcm = await ffmpegToPcm(tmpFile, { signal: ctx.signal });
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      try { rmSync(tmpFile, { force: true }); } catch { /* 清理失败无害 */ }
      tmpFile = null;
    }
    const cfg = getConfig();
    if (!asrConfigured(cfg)) {
      return { ok: false, error: '语音识别还没配好，无法转写音频。请管理员在控制台「设置 → 语音转文字」里把当前供应商填齐（或设环境变量 ASR_API_KEY）' };
    }
    // 按真实时长推流的供应商转不完长音频：提前说清，别让用户等两分钟才拿到一句超时
    const pacedLimit = pacedAudioLimitSeconds(cfg, asrProvider(cfg));
    if (pacedLimit > 0 && pcm.length > pacedLimit * 32000) {
      const seconds = Math.round(pcm.length / 32000);
      return { ok: false, error: `音频太长（${seconds} 秒）：当前这家的转写要按音频实际时长逐帧推流，`
        + `一次运行时限里大约只能转 ${pacedLimit} 秒，再长会中途超时。`
        + '可以换「火山 / 硅基流动」这类一次上传的服务，或把音频截短后再发' };
    }
    try {
      const text = await runProvider(cfg, pcm, { signal: ctx.signal });
      if (!text?.trim()) return { ok: false, error: '语音识别没有返回内容（可能整段是静音/无语音）' };
      return { ok: true, text: text.trim() };
    } catch (e) {
      return { ok: false, error: `语音识别失败：${String(e?.message ?? e)}` };
    }
  } finally {
    if (tmpFile) { try { rmSync(tmpFile, { force: true }); } catch { /* noop */ } }
  }
}
