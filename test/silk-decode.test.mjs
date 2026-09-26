// QQ 语音（SILK）解码：ffmpeg 解不了 SILK，整条链路必须在本地先解成 16k PCM。
// 背景（2026-09-26 生产实测）：QQ 的 record 段文件名写着 .amr、CDN 回 content-type: audio/mp3，
// 实际字节却是 SILK（`.#!SILK_V3`）—— 直接喂 ffmpeg 只会得到 "Invalid data found"，用户看到的
// 就是"语音转文字失败"。这里覆盖：识别、解码成 16k、以及"解码结果与时长对不上要报错"。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode as silkEncode } from 'silk-wasm';

const { looksLikeSilk, silkToPcm, SILK_SAMPLE_RATE } = await import('../src/llm/silk.js');
const { audioBufferToPcm } = await import('../src/tools/audio-transcribe.js');

/** 合成一段单声道 s16le 正弦，当"语音"用（不落任何真实音频进仓库）。 */
function sinePcm(seconds, rate = 16000) {
  const n = Math.round(seconds * rate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    pcm.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  }
  return pcm;
}

let cache = null;
async function silkSample() {
  if (!cache) {
    const enc = await silkEncode(sinePcm(1), 16000);
    cache = Buffer.from(enc.data);
  }
  return cache;
}

test('认出 QQ 语音的 SILK（含带 0x02 前缀的写法），不误判别的字节', async () => {
  const silk = await silkSample();
  assert.equal(silk.subarray(0, 10).toString('latin1'), '\u0002#!SILK_V3');
  assert.equal(looksLikeSilk(silk), true);
  // 裸头（去掉 0x02）也要认：QQ 有的实现存的是不带前缀的写法
  assert.equal(looksLikeSilk(silk.subarray(1)), true);
  assert.equal(looksLikeSilk(Buffer.from('RIFF....WAVEfmt ')), false, 'WAV 不能被当成 SILK');
  assert.equal(looksLikeSilk(Buffer.alloc(4)), false, '太短的不算');
  assert.equal(looksLikeSilk(null), false);
});

test('SILK → 16k 单声道 PCM：字节数与时长对得上', async () => {
  const silk = await silkSample();
  const { pcm, durationMs } = await silkToPcm(silk);
  assert.equal(SILK_SAMPLE_RATE, 16000);
  assert.ok(Math.abs(durationMs - 1000) <= 40, `时长应约 1 秒，实际 ${durationMs}ms`);
  const expected = Math.round((durationMs / 1000) * 32000);
  assert.ok(Math.abs(pcm.length - expected) <= 3200, `字节数应约 ${expected}，实际 ${pcm.length}`);
});

test('audioBufferToPcm：SILK 走本地解码（结果与 silkToPcm 一致），不经过 ffmpeg', async () => {
  const silk = await silkSample();
  const pcm = await audioBufferToPcm(silk, { name: '72222204980746a00ededc4276f967fb.amr' });
  const direct = await silkToPcm(silk);
  assert.equal(pcm.length, direct.pcm.length);
  assert.ok(pcm.equals(direct.pcm), '两条路解出来应逐字节一致');
});

test('不是 SILK 的字节不会被误判成 SILK（会走 ffmpeg 那条路，并如实报错）', async () => {
  const junk = Buffer.concat([Buffer.from('not-a-media-file-at-all'.repeat(4)), Buffer.alloc(8)]);
  assert.equal(looksLikeSilk(junk), false);
  await assert.rejects(
    () => audioBufferToPcm(junk, { name: 'x.amr' }),
    /音频转换失败|ffmpeg 不可用|Invalid data/i,
    '非 SILK 的坏数据应走到 ffmpeg 并报转换失败，而不是被静默当成 SILK'
  );
});

test('SILK 一致性自检：解码出来的 PCM 与它自报的时长要对得上', async () => {
  // 这条自检是防"解码中途悄悄停住"的（实测截断样本时 silk-wasm 会连时长一起变短，
  // 所以它拦不住"下载被截断"那种情况 —— 别把它当成完整性校验）。
  const silk = await silkSample();
  const { pcm, durationMs } = await silkToPcm(silk);
  const expected = Math.round((durationMs / 1000) * 32000);
  assert.ok(Math.abs(pcm.length - expected) <= Math.max(3200, expected * 0.05),
    `PCM ${pcm.length} 字节 vs 时长 ${durationMs}ms 推出的约 ${expected} 字节，差得太多说明解码有问题`);
});
