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
import { looksLikeSilk, silkToPcm } from '../llm/silk.js';

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
/** 只有 http(s) 才是能下载的地址；协议端有时只给本地文件名/路径，那种要去换地址。 */
const isFetchableUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

export async function currentMessageAudioUrl(ctx, entry) {
  const media = entry.media || [];
  if (entry.mid != null && typeof ctx.onebot?.getMsg === 'function') {
    try {
      const data = await ctx.onebot.getMsg(entry.mid);
      const segments = Array.isArray(data?.message) ? data.message : [];
      const fresh = [];
      for (const seg of segments) {
        const d = seg?.data ?? {};
        // 记录/视频段：只认能下载的 http(s) 地址。NapCat 在"视频只存在本地缓存"时只给
        // 文件名（没有 url），把它当 URL 去请求只会得到一句"URL 无效"（2026-09-26 实测）。
        if (seg?.type === 'record' || seg?.type === 'voice' || seg?.type === 'video') {
          const url = String(d.url || '');
          const name = String(d.file || d.name || '');
          if (isFetchableUrl(url)) fresh.push({ kind: 'audio', url, name, segment: seg.type });
          else if (name || url) fresh.push({ kind: 'audio', url: '', localOnly: true, name: name || url, segment: seg.type });
        } else if (seg?.type === 'file') {
          const name = String(d.name || d.file || '');
          const url = String(d.url || '');
          if (/\.(m4a|mp3|wav|amr|aac|ogg|flac|wma|mp4|mov|avi|mkv|webm|silk)$/i.test(name)) {
            fresh.push({
              kind: 'audio', url: isFetchableUrl(url) ? url : '', name,
              fileSegId: String(d.file_id || d.id || ''), segment: 'file'
            });
          }
        }
      }
      const usable = fresh.find((x) => x.url) || fresh[0];
      if (usable) return usable;
      // 兜底：任意 file 段（名字认不出扩展名也想试试，反正有 file_id 能换地址）
      const fileSeg = segments.find((s) => s?.type === 'file');
      if (fileSeg) {
        return {
          kind: 'audio', url: '',
          fileSegId: String(fileSeg.data?.file_id || fileSeg.data?.id || ''),
          name: String(fileSeg.data?.name || fileSeg.data?.file || '')
        };
      }
    } catch { /* 源消息过期时退到存档 */ }
  }
  const archived = media.find((m) => m?.kind === 'audio' && m.url);
  return archived ? { kind: 'audio', url: String(archived.url), name: String(archived.name || '') } : null;
}

/**
 * file 段没带 url 时，用 OneBot 的取地址接口换一个（群文件 / 私聊文件两套参数）。
 * 这是"别人发视频文件"那条路的关键一步：段里只有 file_id，没有可下载地址。
 */
export async function resolveFileSegmentUrl(ctx, { fileSegId }, { signal } = {}) {
  const id = String(fileSegId || '').trim();
  if (!id) return '';
  const chatKey = String(ctx?.chatKey || '');
  const [kind, rawId] = chatKey.split(':');
  if (!rawId || typeof ctx?.onebot?.call !== 'function') return '';
  const action = kind === 'private' ? 'get_private_file_url' : 'get_group_file_url';
  const params = kind === 'private'
    ? { user_id: Number(rawId), file_id: id }
    : { group_id: Number(rawId), file_id: id };
  try {
    const data = await ctx.onebot.call(action, params, 15000, signal);
    const url = String(data?.url || data?.data?.url || '');
    return isFetchableUrl(url) ? url : '';
  } catch {
    return '';   // 取不到就交给上层给准确说明，不在这里抛
  }
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

/**
 * 这段音频"像不像有人在说话"：只看一个判据 —— **停顿比例**。
 * 说话总有换气/断句（20ms 帧级看，能量会在近静音与有声之间反复横跳）；纯音乐/音效/环境声
 * 往往是持续有能量（打击乐、爆炸声之间也没有真正的静音段）。
 *
 * 背景（用户 2026-09-26）：发了一段"打花火"的视频，音频只有音乐与动作音效、没有语音，
 * 而 ASR 对非语音会**编**出一段像模像样的中文（两个模型各编各的）。与其让模型把编的内容
 * 当事实讲，不如把这个信号如实给它："这段几乎没有停顿，可能主要是音乐/音效"。
 *
 * 保守起见只做"提示"不做"判定"：只有 3 秒以上 + 近静音帧占比 < 5% + 能量全程不低 才标记，
 * 宁可漏报（模型自己也能从内容判断），不要误报把真人语音说成噪音。
 */
export function analyzeSpeechiness(pcm, { frameMs = 20, bytesPerSecond = 32000 } = {}) {
  const bytesPerFrame = Math.max(2, Math.round(bytesPerSecond * frameMs / 1000 / 2) * 2);
  const frames = [];
  for (let i = 0; i + 2 <= pcm.length; i += bytesPerFrame) {
    let sum = 0;
    const end = Math.min(i + bytesPerFrame, pcm.length);
    for (let j = i; j + 1 < end; j += 2) {
      const v = pcm.readInt16LE(j) / 32768;
      sum += v * v;
    }
    frames.push(Math.sqrt(sum / Math.max(1, (end - i) / 2)));
  }
  if (!frames.length) return { seconds: 0, quietRatio: 1, maybeNonSpeech: false };
  const peak = Math.max(...frames);
  if (peak <= 0) return { seconds: frames.length * frameMs / 1000, quietRatio: 1, maybeNonSpeech: false };
  const quiet = frames.filter((rms) => rms < peak * 0.06).length;
  const quietRatio = quiet / frames.length;
  const seconds = frames.length * frameMs / 1000;
  return { seconds, quietRatio, maybeNonSpeech: seconds >= 3 && quietRatio < 0.05 };
}

/** 把"像不像有人说话"翻译成给模型的一句话（不确定时什么都不说）。 */
export function speechCaveat(info) {
  if (!info?.maybeNonSpeech) return '';
  return '（这段音频几乎没有停顿，可能主要是音乐/音效而不是人声 —— 自动识别在这种情况下会编内容，'
    + '别把上面的文字当作事实讲；如果它和画面也对不上，就照实说"没听到有人说话"。）';
}

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

/**
 * 下载到的音频字节 → 16k 单声道 s16le PCM。
 * 两条路：QQ 语音是 SILK（ffmpeg 解不了，见 src/llm/silk.js），其余走 ffmpeg 转码。
 * m4a/mp4 的 moov atom 常在尾部，ffmpeg 管道输入无法 seek —— 所以必须落盘成临时文件。
 */
export async function audioBufferToPcm(buffer, { name = '', signal } = {}) {
  if (looksLikeSilk(buffer)) {
    const { pcm, durationMs } = await silkToPcm(buffer);
    if (durationMs > 0) {
      // 一致性自检：SILK 头里的时长与解出来的字节数应当对得上（差太多说明解码中途出错了）
      const expected = Math.round(durationMs / 1000 * 32000);
      if (Math.abs(pcm.length - expected) > Math.max(3200, expected * 0.05)) {
        throw new Error(`SILK 解码结果与时长不符（${pcm.length} 字节 vs 约 ${expected} 字节），这条语音可能损坏`);
      }
    }
    return pcm;
  }
  const ext = /\.(m4a|mp3|wav|amr|aac|ogg|flac|wma|mp4|mov|avi|mkv|webm|silk)$/i.exec(String(name || ''))?.[1] || 'bin';
  const tmpFile = join(tmpdir(), `qa-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  writeFileSync(tmpFile, buffer);
  try {
    return await ffmpegToPcm(tmpFile, { signal });
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch { /* 清理失败无害 */ }
  }
}

/** 主入口：给 tools-core 的 get_message_audio 工具用，返回转写文本。 */
export async function transcribeMessageAudio(ctx, entry) {
  const target = await currentMessageAudioUrl(ctx, entry);
  if (!target) return { ok: false, error: '这条消息里没有可识别的音频/视频内容' };
  {
    if (!target.url && target.fileSegId) {
      // 群文件/私聊文件的段里常常只有 file_id：用 OneBot 的取地址接口换一个
      // （这是"别人发视频文件/音频文件"那条路的关键一步）
      const resolved = await resolveFileSegmentUrl(ctx, target, { signal: ctx.signal });
      if (resolved) target.url = resolved;
    }
    if (!target.url) {
      const what = target.segment === 'file' ? '文件' : '这条视频/语音';
      return {
        ok: false,
        error: `${what}「${target.name || '未知'}」拿不到下载地址：协议端只给了文件名、没给可下载的 URL`
          + '（NapCat 在视频只存在本地缓存时就是这样，且没有取视频地址的接口）。'
          + '可以让对方把这段视频/音频用「发送文件」的方式再发一次（本工具支持 .mp4/.mov/.m4a 等文件）。'
      };
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
    let pcm;
    try {
      pcm = await audioBufferToPcm(buffer, { name: target.name, signal: ctx.signal });
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
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
      // 非语音（音乐/音效）时 ASR 会编内容：把"这段几乎没有停顿"的信号一并交给模型，
      // 由它决定是否照实说"没听到有人说话"（2026-09-26 用户反馈"打花火视频"）
      const caveat = speechCaveat(analyzeSpeechiness(pcm));
      if (!text?.trim()) {
        return { ok: false, error: caveat ? '这段音频里没有识别到人声（可能只有音乐/音效）' : '语音识别没有返回内容（可能整段是静音/无语音）' };
      }
      return { ok: true, text: text.trim(), caveat };
    } catch (e) {
      return { ok: false, error: `语音识别失败：${String(e?.message ?? e)}` };
    }
  }
}
