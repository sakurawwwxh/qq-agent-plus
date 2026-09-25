// get_message_audio：语音/视频转文字工具的单测。
// 真实 ASR 不在此测（需要 key + 网络），只测编排逻辑：URL 解析、无音频报错、key 缺失报错。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audio-transcribe-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { currentMessageAudioUrl } = await import('../src/tools/audio-transcribe.js');
const { extractMediaFromSegments } = await import('../src/onebot/onebot.js');

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
