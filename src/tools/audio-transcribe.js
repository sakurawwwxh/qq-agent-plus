// 语音/视频转文字：取文件 URL → ffmpeg 转 16k PCM → Seed-ASR (Agent Plan)。
// 聊天模型无关：任何模型都消费转写文本，音频理解不依赖多模态。
import { spawn } from 'node:child_process';
import { safeFetchBinary } from '../llm/safe-fetch.js';
import { seedAsrTranscribe } from '../llm/seed-asr.mjs';

const AUDIO_MAX_BYTES = 200 * 1024 * 1024; // 200MB：QQ 文件上限内
const ASR_MAX_PCM_SECONDS = 60 * 60;       // 最长转 1 小时

function ffmpegToPcm(inputPath, { timeoutMs = 10 * 60 * 1000 } = {}) {
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
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > ASR_MAX_PCM_SECONDS * 32000) { // 16k*2byte
        child.kill('SIGKILL');
        return reject(new Error('音频过长（超过 1 小时），暂不支持'));
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-500); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ffmpeg 不可用：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && size > 0) return resolve(Buffer.concat(chunks));
      reject(new Error(`音频转换失败（ffmpeg ${code}）：${stderr.trim().slice(-200) || '无输出'}`));
    });
    child.stdin.on('error', () => { /* EPIPE 时由 close 收尾 */ });
    child.stdin.end(buffer);
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
    let buffer;
    try {
      ({ buffer } = await safeFetchBinary(target.url, AUDIO_MAX_BYTES, ctx.signal));
    } catch (e) {
      return { ok: false, error: `音频下载失败：${String(e?.message ?? e)}` };
    }
    // m4a/mp4 的 moov atom 常在尾部，ffmpeg 管道输入无法 seek——必须落盘成临时文件
    const { writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
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
