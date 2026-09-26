// 语音/视频转文字：取文件 URL → ffmpeg 转 16k PCM → Seed-ASR (Agent Plan)。
// 聊天模型无关：任何模型都消费转写文本，音频理解不依赖多模态。
import { spawn } from 'node:child_process';
// fs/path/os 用顶层静态 import：函数体里的 `const { x } = await import(...)`
// 在 ops scan --strict 里会被判成"调用点有、定义没有"（CI 硬门禁），
// 而且这里也没有延迟加载的必要。
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFetchBinary } from '../llm/safe-fetch.js';
import { seedAsrTranscribe } from '../llm/seed-asr.js';
import { asrMaxPerHour, getConfig } from '../core/config.js';

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

function asrKeyOf() {
  // key 来源：config.webSearch.doubao.apiKey（同一个 ARK Agent Plan key）
  // config.js 的 getConfig() 是运行时单例，动态 import 拿最新配置
  return import('../core/config.js').then((m) => {
    const cfg = m.getConfig();
    return String(cfg?.webSearch?.doubao?.apiKey || '').trim();
  }).catch(() => '');
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

/** 主入口：给 tools-core 的 get_message_audio 工具用，返回转写文本。 */
export async function transcribeMessageAudio(ctx, entry) {
  const target = await currentMessageAudioUrl(ctx, entry);
  if (!target) return { ok: false, error: '这条消息里没有可识别的音频/视频内容' };
  let tmpFile = null;
  try {
    if (!target.url) {
      return { ok: false, error: `文件「${target.name || '未知'}」拿不到下载地址（协议端未提供 URL），暂无法转写` };
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
    const apiKey = await asrKeyOf();
    if (!apiKey) {
      return { ok: false, error: '未配置语音识别服务（缺少 ASR API Key），无法转写音频。请管理员在配置中补充 webSearch.doubao.apiKey 或等价 ASR key' };
    }
    try {
      const text = await seedAsrTranscribe(pcm, { apiKey, signal: ctx.signal });
      if (!text?.trim()) return { ok: false, error: '语音识别没有返回内容（可能整段是静音/无语音）' };
      return { ok: true, text: text.trim() };
    } catch (e) {
      return { ok: false, error: `语音识别失败：${String(e?.message ?? e)}` };
    }
  } finally {
    if (tmpFile) { try { rmSync(tmpFile, { force: true }); } catch { /* noop */ } }
  }
}
