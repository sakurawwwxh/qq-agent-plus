// 超大图片兜底（Issue #6）：群友发 >12MiB 的图时，常规拉取直接失败，
// 视觉模型什么都看不到。这里放宽上限取回全量，再用系统 ffmpeg 降采样到
// 2048px JPEG 交给视觉模型（实测 48MB PNG → 3.6MB JPEG）。
// ffmpeg 是可选能力：缺失或失败时抛出带指引的错误，绝不影响常规 ≤12MiB 路径。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeFetchBinary } from '../llm/safe-fetch.js';

// safe-fetch.js readBounded 的超限报错形态（"响应体超过 N 字节限制"）。
// 用报错形态识别"是不是拉超了"，其他错误（HTTP 4xx/5xx、SSRF 拦截）原样上抛。
export const OVERSIZE_LIMIT_RE = /响应体超过\s*\d+\s*字节限制/;

const PROBE_TTL_MS = 10 * 60 * 1000;
let probeCache = { at: 0, path: null };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 单次探测：启动 ffmpeg -version，按退出结果返回 {code} 或 {error}。 */
async function probeFfmpegOnce() {
  let child;
  try {
    child = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
  } catch {
    return { error: true };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 超时主动兜底 resolve：kill 后若进程成僵尸不触发 exit，不能永久挂住调用方
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ error: true });
    }, 5000);
    timer.unref?.();
    child.on('error', (error) => { clearTimeout(timer); resolve({ error }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code }); });
  });
}

/** 探测系统 ffmpeg（进程内缓存，含失败结果；失败 10 分钟后允许重探一次）。
 * Windows 上 spawn 偶发 EBUSY（AV 扫描/资源占用）：瞬态，重试一次再下结论。 */
export async function resolveFfmpeg() {
  const cached = probeCache.path;
  if (cached && Date.now() - probeCache.at < PROBE_TTL_MS) return cached;
  if (!cached && Date.now() - probeCache.at < PROBE_TTL_MS) return null;
  probeCache.at = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await probeFfmpegOnce();
    if (!outcome.error) {
      probeCache.path = outcome.code === 0 ? 'ffmpeg' : null;
      return probeCache.path;
    }
    if (attempt === 0) await sleep(250);
  }
  probeCache.path = null;
  return probeCache.path;
}

async function runFfmpegOnce(ffmpegPath, buffer, vf, signal) {
  signal?.throwIfAborted(); // 入口即中止：别让 ffmpeg 白跑 30 秒才被超时杀掉
  // 输入必须走临时文件：部分 Linux 发行版的 ffmpeg（如 Ubuntu 22.04 的 4.4.2）
  // 解 GIF 需要可 seek 的输入，从管道直读报 "pipe:0: Input/output error"
  // （Windows 的 ffmpeg 无此问题——这正是测试全绿、服务器翻车的根因）。
  // 输出保持 pipe:1（JPEG 顺序写，无需 seek）。
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ffmpeg-'));
  const inputPath = path.join(workDir, 'input');
  const cleanup = () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ } };
  let child;
  try {
    fs.writeFileSync(inputPath, buffer);
    child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-vf', vf,
      '-frames:v', '1',
      '-q:v', '5',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // 写入失败（磁盘满/权限）或 spawn 同步抛出（EINVAL 类）：清理后原样传播，
    // 错误信息不含"启动失败"，不会被 runFfmpeg 误判成 EBUSY 重试。
    cleanup();
    throw error;
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let stderr = '';
    let settled = false;
    let timer = null;
    const onAbort = () => settle(reject, new Error('已中止'));
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { child.kill(); } catch { /* 已退出 */ }
      cleanup();
      fn(value);
    };
    timer = setTimeout(() => settle(reject, new Error('ffmpeg 降采样超时（30 秒）')), 30000);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      // 保留尾部：ffmpeg 的真实报错在 stderr 的最后一行，头部只有 banner 噪音
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (error) => settle(reject, new Error(`ffmpeg 启动失败：${error.message}`)));
    child.on('close', (code) => {
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length) settle(resolve, out);
      else settle(reject, new Error(`ffmpeg 降采样失败（exit ${code}）：${stderr.trim().split('\n').pop() || '无错误输出'}`));
    });
  });
}

/** runFfmpegOnce 的重试壳：Windows 瞬态 EBUSY 重试一次，其他错误直接抛。 */
async function runFfmpeg(ffmpegPath, buffer, vf, signal) {
  try {
    return await runFfmpegOnce(ffmpegPath, buffer, vf, signal);
  } catch (error) {
    if (!/启动失败/.test(String(error?.message ?? ''))) throw error;
    await sleep(250);
    return runFfmpegOnce(ffmpegPath, buffer, vf, signal);
  }
}

/**
 * 常规上限拉取抛出"超限"时调用：放宽到 largeCap 重拉一次，确认拿到的确实是
 * 图片（content-type image/*）后交给 ffmpeg 降采样成 JPEG。
 * 拿不到图 / 二次拉取失败 → 把原始超限错误抛回去（贴近真相）；
 * ffmpeg 缺失 → 抛带安装指引的错误；降采样失败 → 抛 ffmpeg 的具体错误。
 */
export async function fetchOversizedImageAsJpeg(safeUrl, originalError, signal, {
  cap = 12 * 1024 * 1024,
  largeCap = 96 * 1024 * 1024
} = {}) {
  if (!OVERSIZE_LIMIT_RE.test(String(originalError?.message ?? ''))) throw originalError;
  const ffmpegPath = await resolveFfmpeg();
  if (!ffmpegPath) {
    throw new Error(`${originalError.message}；图片超过 ${Math.round(cap / 1024 / 1024)} MiB 且系统未安装 ffmpeg，无法自动降采样（安装 ffmpeg 后即可支持超大图）`);
  }
  let buffer;
  let contentType;
  try {
    ({ buffer, contentType } = await safeFetchBinary(safeUrl, largeCap, signal));
  } catch (error) {
    // 二次拉取被中止（时间窗关闭/手动停止）时如实抛中止，别伪装成超限错误
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw originalError; // 其他二次拉取失败：原始超限错误更贴近真相
  }
  if (!buffer?.length || !/^image\//i.test(String(contentType || ''))) throw originalError;
  // 动图走帧条（与常规 GIF 路径同一口径，别只给模型一帧）；其他图按尺寸降采样
  let vf = "scale='min(2048,iw)':-2";
  if (/^image\/gif/i.test(String(contentType || ''))) {
    vf = gifStripVf(await countGifFrames(ffmpegPath, buffer, signal));
  }
  const jpeg = await runFfmpeg(ffmpegPath, buffer, vf, signal);
  return { buffer: jpeg, contentType: 'image/jpeg' };
}

/** 数 GIF 总帧数：-f null 全量解一遍，取 stderr 末尾 progress 的 frame= N。
 * 数不出（异常流/超时/中止）返回 null，由调用方退回"取前 4 帧"的保底滤镜。 */
async function countGifFrames(ffmpegPath, buffer, signal) {
  signal?.throwIfAborted();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ffmpeg-'));
  const inputPath = path.join(workDir, 'input');
  const cleanup = () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ } };
  let child;
  try {
    fs.writeFileSync(inputPath, buffer);
  } catch {
    cleanup();
    return null;
  }
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timer = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { child.kill(); } catch { /* 已退出 */ }
      cleanup();
      resolve(value);
    };
    const onAbort = () => settle(null);
    try {
      child = spawn(ffmpegPath, [
        '-hide_banner', '-i', inputPath,
        '-map', '0:v:0', '-f', 'null', '-'
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      cleanup();
      resolve(null);
      return;
    }
    timer = setTimeout(() => settle(null), 30000);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', () => settle(null));
    child.on('close', () => {
      const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
      const total = matches.length ? parseInt(matches[matches.length - 1][1], 10) : 0;
      settle(total > 0 ? total : null);
    });
  });
}

/**
 * GIF 帧条滤镜：按帧序号均匀采样 4 帧拼 2x2，tpad 克隆尾帧保证不足 4 帧也满格。
 * 旧口径 fps=2 按时间轴采样，行为完全由时长决定：≤0.2s 采 0 帧整单失败、
 * 0.3~1.9s 采 1~3 帧 tile 补黑格、≥2s 只见开头 1.5s——本机与服务器双实测确认。
 * 帧序号步长对帧率/时长免疫；数不出总帧数时退回"前 4 帧 + 克隆补格"，保底无黑格。
 */
function gifStripVf(frameCount) {
  const step = frameCount && frameCount > 4 ? Math.ceil(frameCount / 4) : 1;
  const select = step > 1 ? `select=not(mod(n\\,${step})),` : '';
  return `${select}scale=512:-2,tpad=stop_mode=clone:stop=3,tile=2x2`;
}

/**
 * GIF → JPEG 帧条（Issue 反馈：模型读不了 GIF——主流视觉网关不接受
 * image/gif，且动图的情绪信息在动作里，单帧会丢）。
 * 做法：先数总帧数，再按帧序号均匀采样 4 帧拼成 2x2 帧条输出单张 JPEG
 * （gifStripVf）；透明背景按 ffmpeg 默认合成（黑底）。
 * 返回 JPEG Buffer；ffmpeg 缺失或转换失败返回 null，由调用方回退原始 GIF。
 */
/**
 * 视频时长（秒）：ffprobe 拿不到就按 10 秒估 —— 只影响抽帧间隔，不影响"能不能看"。
 * ffprobe 与 ffmpeg 同目录（resolveFfmpeg 返回的路径直接换名字）。
 */
async function probeVideoSeconds(ffmpegPath, buffer, signal) {
  // ffprobe 与 ffmpeg 同目录；resolveFfmpeg 可能给裸名字（靠 PATH 找），dirname 之后仍是裸名字 ✓
  const probePath = path.join(path.dirname(String(ffmpegPath) || ''), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ffprobe-'));
  const inputPath = path.join(workDir, 'input');
  try {
    fs.writeFileSync(inputPath, buffer);
    const out = await new Promise((resolve) => {
      const child = spawn(probePath, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(''); }, 8000);
      signal?.addEventListener('abort', () => { try { child.kill(); } catch { /* 已退出 */ } resolve(''); }, { once: true });
      child.stdout.on('data', (c) => { text = (text + c).slice(-200); });
      child.on('error', () => { clearTimeout(timer); resolve(''); });
      child.on('close', () => { clearTimeout(timer); resolve(text); });
    });
    const seconds = Number(String(out).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch {
    return 0;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
}

/**
 * 视频 → JPEG 帧条（2×2 四宫格，与 GIF 同一口径）。
 * 为什么要有它：视频给模型的默认只有音轨（get_message_audio 转写），画面本身它看不到 ——
 * 用户 2026-09-26 反馈"发视频它只回一句视频只能听声"。做法：按总时长均匀抽 4 帧拼一张 JPEG
 * （fps=4/时长 + tile=2x2），时长未知时按 10 秒估。返回 JPEG Buffer；ffmpeg 缺失/转换失败返回 null。
 */
export async function convertVideoToFrameStrip(buffer, signal) {
  const ffmpegPath = await resolveFfmpeg();
  if (!ffmpegPath) return null;
  try {
    const probed = await probeVideoSeconds(ffmpegPath, buffer, signal);
    const seconds = probed > 0 ? probed : 10;
    const rate = 4 / Math.max(1, Math.min(600, seconds));   // 整段均匀 4 帧；超长视频也只看开头这段里的 4 帧
    const vf = `fps=${rate.toFixed(6)},scale=320:-2,tile=2x2`;
    const jpeg = await runFfmpeg(ffmpegPath, buffer, vf, signal);
    return jpeg?.length ? jpeg : null;
  } catch {
    return null;
  }
}

export async function convertGifToStillStrip(buffer, signal) {
  const ffmpegPath = await resolveFfmpeg();
  if (!ffmpegPath) return null;
  try {
    const frameCount = await countGifFrames(ffmpegPath, buffer, signal);
    const jpeg = await runFfmpeg(ffmpegPath, buffer, gifStripVf(frameCount), signal);
    if (!jpeg?.length) return null;
    return jpeg;
  } catch {
    return null;
  }
}
