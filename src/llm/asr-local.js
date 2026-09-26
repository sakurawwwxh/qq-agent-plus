// 本机语音转写（whisper.cpp）：不联网、不需要 Key、没有按量费用 —— 音频不出本机。
// 代价是要自己装一次二进制 + 模型，且 CPU 转写比托管服务慢（短语音够用）。
// 只依赖一个可执行文件，不引 python 运行时；参数按 whisper.cpp 现役 CLI（whisper-cli）写。
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

/** whisper.cpp 的检测名（不同发行版/包管理器给的名字不一样，按顺序找）。 */
export const WHISPER_BIN_CANDIDATES = ['whisper-cli', 'whisper-cpp', 'main'];

/** 拼 whisper.cpp 参数（导出仅供测试：命令行别在别处再抄一份）。 */
export function whisperArgs({ model, wavPath, outPrefix, language = 'zh', threads = 0 } = {}) {
  const args = ['-m', model, '-f', wavPath, '-otxt', '-of', outPrefix, '-np'];
  if (language) args.push('-l', language);
  const n = Number(threads) || 0;
  if (n > 0) args.push('-t', String(n));
  return args;
}

/**
 * 本机转写：把 wav 交给 whisper.cpp，读回它写的 <outPrefix>.txt。
 * 超时/中止都会杀掉子进程；模型或二进制缺失时给出可自查的错误文案。
 */
export async function localWhisperTranscribe(wavPath, {
  bin = WHISPER_BIN_CANDIDATES[0], model, language = 'zh', threads = 0,
  timeoutMs = 10 * 60 * 1000, signal
} = {}) {
  if (!model) throw new Error('未配置本机转写的模型文件路径（asr.localModel）');
  const outPrefix = `${wavPath}.asr`;
  const textFile = `${outPrefix}.txt`;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const child = spawn(bin, whisperArgs({ model, wavPath, outPrefix, language, threads }), {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    const cleanup = () => { try { rmSync(textFile, { force: true }); } catch { /* 清不掉无害 */ } };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('本机转写超时')), timeoutMs);
    const onAbort = () => fail(signal?.reason ?? new Error('已中止'));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', () => { /* 文本走 -otxt 落盘，stdout 只是进度 */ });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-500); });
    child.on('error', (e) => fail(new Error(
      `本机转写不可用（找不到 ${bin}）：${e.message}。装好 whisper.cpp 后在控制台填它的可执行文件与模型路径`
    )));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        if (code !== 0) {
          fail(new Error(`本机转写失败（${bin} 退出码 ${code}）：${stderr.trim().slice(-200) || '无输出'}`));
          return;
        }
        const text = readFileSync(textFile, 'utf8');
        cleanup();
        resolve(String(text).trim());
      } catch (error) {
        fail(new Error(`本机转写没有产出文本（${bin} 退出码 ${code}）：${String(error?.message ?? error)}`));
      }
    });
  });
}
