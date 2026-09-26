// get_message_audio：语音/视频转文字工具的单测。
// 真实 ASR 不在此测（需要 key + 网络），只测编排逻辑：URL 解析、无音频报错、key 缺失报错。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audio-transcribe-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { currentMessageAudioUrl, ffmpegToPcm, consumeAsrQuota, resetAsrQuota } = await import('../src/tools/audio-transcribe.js');
const { extractMediaFromSegments } = await import('../src/onebot/onebot.js');
const { asrAvailable, asrMaxPerHour, DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

it('extractMediaFromSegments 提取 record/video/音频文件段为 audio', () => {
  const media = extractMediaFromSegments([
    { type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg' } },
    { type: 'record', data: { file: 'b.amr', url: 'https://x/b.amr' } },
    { type: 'video', data: { file: 'c.mp4', url: 'https://x/c.mp4' } },
    { type: 'file', data: { name: '会议录音.m4a', url: 'https://x/rec.m4a' } },
    { type: 'file', data: { name: '文档.pdf', url: 'https://x/doc.pdf' } } // 非音频文件不提取
  ]);
  const audio = media.filter((m) => m.kind === 'audio');
  assert.equal(audio.length, 3, 'record/video/m4a 各一条，pdf 不算');
  assert.equal(audio[0].url, 'https://x/b.amr');
  assert.equal(audio[1].url, 'https://x/c.mp4');
  assert.equal(audio[2].url, 'https://x/rec.m4a');
});

it('currentMessageAudioUrl 优先从 getMsg 现取（URL 短期有效）', async () => {
  const ctx = {
    onebot: {
      getMsg: async () => ({
        message: [{ type: 'record', data: { file: 'x.amr', url: 'https://fresh/x.amr' } }]
      })
    }
  };
  const target = await currentMessageAudioUrl(ctx, { mid: 123, media: [] });
  assert.equal(target.url, 'https://fresh/x.amr');
});

it('getMsg 失败时退到 entry.media 存档', async () => {
  const ctx = { onebot: { getMsg: async () => { throw new Error('expired'); } } };
  const target = await currentMessageAudioUrl(ctx, {
    mid: 123,
    media: [{ kind: 'audio', url: 'https://archived/x.amr', name: 'x.amr' }]
  });
  assert.equal(target.url, 'https://archived/x.amr');
});

it('无音频内容返回 null', async () => {
  const target = await currentMessageAudioUrl({ onebot: undefined }, { mid: null, media: [] });
  assert.equal(target, null);
});

// 真 ffmpeg 链路：生成 2 秒 440Hz wav → 转 16k PCM，断言有产出且采样率正确。
// 环境探测一次：CI 的 ubuntu runner 上没有 ffmpeg（2026-09-26 实测 spawn ffmpeg ENOENT，
// 并把"无效输入报错"那条断言炸红过一次）；本机与生产服务器有。
// 缺 ffmpeg 时这两条**显式跳过**（skipped 计数可见），不再让断言悄悄失败或静默通过。
const ffmpegMissing = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return false; }
  catch { return true; }
})();
const FFMPEG_SKIP = ffmpegMissing ? '本环境没有 ffmpeg' : false;

it('ffmpegToPcm 真实转换：wav 输入产出 16k mono PCM', { skip: FFMPEG_SKIP }, async () => {
  const wavPath = path.join(dir, 'tone.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-ar', '44100', '-ac', '2', wavPath]);
  const pcm = await ffmpegToPcm(wavPath);
  // raw s16le 无文件头：2 秒 × 16000 采样 × 1 声道 × 2 字节 = 64000 字节。
  // 字节数精确匹配即证明采样率/声道/位深全部正确（ffprobe 探不了无头 PCM）。
  assert.equal(pcm.length, 64000);
});

it('ffmpegToPcm 无效输入报错而不是挂起', { skip: FFMPEG_SKIP }, async () => {
  const bad = path.join(dir, 'not-audio.bin');
  fs.writeFileSync(bad, Buffer.from('this is not audio content at all'));
  await assert.rejects(() => ffmpegToPcm(bad, { timeoutMs: 15000 }), /音频转换失败/);
});

// ── 合并后的跟进（2026-09-26 审查）──

it('ASR 的可用条件与「联网搜索」开关解耦', () => {
  const withKey = structuredClone(DEFAULT_CONFIG);
  withKey.webSearch.doubao.apiKey = 'test-key';
  assert.equal(asrAvailable(withKey), true, '有 key + 开关默认开 → 可用');
  const searchOff = structuredClone(withKey);
  searchOff.webSearch.enabled = false;
  assert.equal(asrAvailable(searchOff), true, '关掉联网搜索不该顺带关掉语音转写');
  const asrOff = structuredClone(withKey);
  asrOff.asr.enabled = false;
  assert.equal(asrAvailable(asrOff), false, '自己的开关关掉就不可用');
  const noKey = structuredClone(DEFAULT_CONFIG);
  assert.equal(asrAvailable(noKey), false, '没配 key 不注入工具（调用必失败，也防意外计费）');
});

it('每小时转写次数闸门：到上限就拒绝，跨小时自动重置', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.asr.maxPerHour = 3;
  setRuntimeConfig(cfg);
  assert.equal(asrMaxPerHour(cfg), 3);
  resetAsrQuota();
  const base = 1_790_000_000_000; // 固定时刻，避免跨真实小时边界
  assert.deepEqual(
    [consumeAsrQuota(base, cfg), consumeAsrQuota(base, cfg), consumeAsrQuota(base, cfg), consumeAsrQuota(base, cfg)],
    [true, true, true, false],
    '第 4 次应被拒'
  );
  assert.equal(consumeAsrQuota(base + 3600_000, cfg), true, '下一个小时恢复额度');
  resetAsrQuota();
});

it('坏值兜底：maxPerHour 非正数/离谱值都收敛到 12 / 200 上限', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.asr.maxPerHour = 0;
  assert.equal(asrMaxPerHour(cfg), 12);
  cfg.asr.maxPerHour = -5;
  assert.equal(asrMaxPerHour(cfg), 12);
  cfg.asr.maxPerHour = 9999;
  assert.equal(asrMaxPerHour(cfg), 200);
});
