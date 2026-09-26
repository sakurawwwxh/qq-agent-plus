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

it('ASR 用自己的 Key，且与「联网搜索」开关解耦', () => {
  const withKey = structuredClone(DEFAULT_CONFIG);
  withKey.asr.apiKey = 'test-asr-key';
  assert.equal(asrAvailable(withKey), true, '自己的 Key + 开关默认开 → 可用');
  const searchOff = structuredClone(withKey);
  searchOff.webSearch.enabled = false;
  assert.equal(asrAvailable(searchOff), true, '关掉联网搜索不该顺带关掉语音转写');
  const asrOff = structuredClone(withKey);
  asrOff.asr.enabled = false;
  assert.equal(asrAvailable(asrOff), false, '自己的开关关掉就不可用');
  assert.equal(asrAvailable(structuredClone(DEFAULT_CONFIG)), false, '没配 Key 不注入工具（调用必失败，也防意外计费）');
  // 关键回归：只配了搜索 Key 不该开启语音转写（两套服务，不复用）
  const searchKeyOnly = structuredClone(DEFAULT_CONFIG);
  searchKeyOnly.webSearch.doubao.apiKey = 'search-key';
  assert.equal(asrAvailable(searchKeyOnly), false, '搜索 Key 不能当 ASR Key 用');
  const searchOffOnly = structuredClone(DEFAULT_CONFIG);
  searchOffOnly.webSearch.doubao.apiKey = 'search-key';
  searchOffOnly.asr.apiKey = 'asr-key';
  assert.equal(asrAvailable(searchOffOnly), true, 'ASR 有自己的 Key 时不受搜索 Key 影响');
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

// ── 多供应商（2026-09-26：用户要求"API 不一定要同一家、不一定要火山"）──

it('pcmToWav 产出合法 WAV 头（托管服务只吃带容器的文件）', async () => {
  const { pcmToWav } = await import('../src/llm/asr-openai.js');
  const pcm = Buffer.alloc(16000, 1);              // 0.5 秒 16k 单声道
  const wav = pcmToWav(pcm);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.subarray(12, 16).toString(), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1, 'PCM 格式');
  assert.equal(wav.readUInt16LE(22), 1, '单声道');
  assert.equal(wav.readUInt32LE(24), 16000, '16k 采样率');
  assert.equal(wav.readUInt32LE(28), 32000, '字节率 = 采样率×块对齐');
  assert.equal(wav.readUInt16LE(32), 2, '块对齐 = 声道×位深/8');
  assert.equal(wav.subarray(36, 40).toString(), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length);
});

it('OpenAI 兼容转写：拼端点、带 Bearer、解析 text（含错误路径）', async () => {
  const { openAiCompatibleTranscribe, transcriptionEndpoint } = await import('../src/llm/asr-openai.js');
  assert.equal(transcriptionEndpoint('https://api.groq.com/openai/v1/'), 'https://api.groq.com/openai/v1/audio/transcriptions');
  const calls = [];
  const text = await openAiCompatibleTranscribe(Buffer.from('wav'), {
    baseUrl: 'https://example.com/v1', apiKey: 'k-1', model: 'whisper-large-v3-turbo', language: 'zh',
    fetchFn: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization, isForm: typeof init.body?.append === 'function' });
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: ' 你好世界 ' }) };
    }
  });
  assert.equal(text, '你好世界', '去空白后返回文本');
  assert.deepEqual(calls, [{ url: 'https://example.com/v1/audio/transcriptions', auth: 'Bearer k-1', isForm: true }]);
  // 非 2xx 要抛错，并把响应片段带出来（用户自查用）
  await assert.rejects(
    () => openAiCompatibleTranscribe(Buffer.from('wav'), {
      baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm',
      fetchFn: async () => ({ ok: false, status: 401, text: async () => 'invalid api key' })
    }),
    /401.*invalid api key/
  );
  // 缺字段各自报清楚
  await assert.rejects(() => openAiCompatibleTranscribe(Buffer.from('wav'), { apiKey: 'k', model: 'm' }), /地址/);
  await assert.rejects(() => openAiCompatibleTranscribe(Buffer.from('wav'), { baseUrl: 'https://x/v1', model: 'm' }), /API Key/);
  await assert.rejects(() => openAiCompatibleTranscribe(Buffer.from('wav'), { baseUrl: 'https://x/v1', apiKey: 'k' }), /模型名/);
});

it('本机 whisper.cpp：参数拼装 + 缺模型时报错', async () => {
  const { whisperArgs, localWhisperTranscribe, WHISPER_BIN_CANDIDATES } = await import('../src/llm/asr-local.js');
  assert.deepEqual(WHISPER_BIN_CANDIDATES, ['whisper-cli', 'whisper-cpp', 'main']);
  const args = whisperArgs({ model: '/m/ggml-base.bin', wavPath: '/tmp/a.wav', outPrefix: '/tmp/a.out', language: 'zh' });
  assert.deepEqual(args, ['-m', '/m/ggml-base.bin', '-f', '/tmp/a.wav', '-otxt', '-of', '/tmp/a.out', '-np', '-l', 'zh']);
  assert.ok(whisperArgs({ model: 'm', wavPath: 'a', outPrefix: 'o', language: '', threads: 4 }).includes('-t'));
  await assert.rejects(() => localWhisperTranscribe('/tmp/x.wav', { model: '' }), /localModel/);
});

it('供应商路由：按 asr.provider 选后端，配置齐才判定可用', async () => {
  const { asrProvider, asrConfigured, asrAvailable } = await import('../src/core/config.js');
  const base = structuredClone(DEFAULT_CONFIG);
  assert.equal(asrProvider(base), 'volc', '缺省仍是火山');
  assert.equal(asrProvider({ asr: { provider: 'OPENAI' } }), 'openai', '大小写不敏感');
  assert.equal(asrProvider({ asr: { provider: '乱写的' } }), 'volc', '坏值回落到默认供应商');
  // volc：只要 Key
  assert.equal(asrConfigured({ asr: { provider: 'volc', apiKey: '' } }), false);
  assert.equal(asrConfigured({ asr: { provider: 'volc', apiKey: 'k' } }), true);
  // openai 兼容：要 Key + 地址 + 模型名（服务不同，模型名不能猜）
  assert.equal(asrConfigured({ asr: { provider: 'openai', apiKey: 'k', baseUrl: 'https://x/v1' } }), false);
  assert.equal(asrConfigured({ asr: { provider: 'openai', apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' } }), true);
  // local：不要 Key，但要模型文件
  assert.equal(asrConfigured({ asr: { provider: 'local', localModel: '' } }), false);
  assert.equal(asrAvailable({ asr: { enabled: true, provider: 'local', localModel: '/m.bin' } }), true);
  assert.equal(asrAvailable({ asr: { enabled: false, provider: 'local', localModel: '/m.bin' } }), false);
});

// ── 审查跟进（2026-09-26）：本机转写"失败要 reject，不能挂死" + Key 与供应商绑定 ──

it('本机转写：子进程非零退出要 reject（不能挂死）+ 不泄漏临时文件', async () => {
  // 审查抓到的 Critical：早先 close 里先置 settled 再调 fail，而 fail 开头 `if (settled) return`
  // —— 非零退出时 Promise 永不 settle，整轮运行卡死、中止监听已摘、临时文件泄漏。
  // 这里用 node 自身当"坏二进制"（它不认识 whisper 的参数，必定非零退出），真实走一遍 close 路径。
  const { localWhisperTranscribe } = await import('../src/llm/asr-local.js');
  const wavPath = path.join(dir, 'hang-check.wav');
  fs.writeFileSync(wavPath, Buffer.alloc(64));
  // 用 Promise.race 兜底：万一"挂死"复现，这里是**测试失败**，而不是把整个套件挂到 CI 超时
  const started = Date.now();
  const settled = await Promise.race([
    localWhisperTranscribe(wavPath, { bin: process.execPath, model: '/tmp/nope.bin', language: 'zh', timeoutMs: 60000 })
      .then(() => 'resolved', (e) => e),
    new Promise((r) => setTimeout(() => r('hang'), 15000))
  ]);
  assert.notEqual(settled, 'hang', '子进程退出后必须立刻 settle（早先这里会永久挂住）');
  assert.match(String(settled?.message || ''), /本机转写失败|本机转写没有产出文本/);
  assert.ok(Date.now() - started < 15000, '必须是子进程退出就立刻 reject，不能等到超时');
  assert.equal(fs.existsSync(`${wavPath}.asr.txt`), false, '临时 txt 要清掉');
});

it('本机转写：二进制不存在时报"装好 whisper.cpp"的可自查错误', async () => {
  const { localWhisperTranscribe } = await import('../src/llm/asr-local.js');
  const wavPath = path.join(dir, 'missing-bin.wav');
  fs.writeFileSync(wavPath, Buffer.alloc(64));
  await assert.rejects(
    () => localWhisperTranscribe(wavPath, { bin: 'definitely-not-a-real-binary-xyz', model: '/tmp/nope.bin' }),
    /找不到|不可用/
  );
});

it('Key 与供应商绑定：换供应商后不再拿旧 Key 去请求别家', async () => {
  const { asrApiKey, asrKeySource, asrConfigured } = await import('../src/core/config.js');
  // 给火山存的 Key，provider 仍是 volc → 正常使用
  const volc = { asr: { provider: 'volc', apiKey: 'volc-key', apiKeyProvider: 'volc', baseUrl: '', model: '' } };
  assert.equal(asrApiKey(volc), 'volc-key');
  assert.equal(asrKeySource(volc), 'config');
  // 换成 openai 兼容后，同一个 Key 不再被取用（否则会把火山凭据发给别家）
  const switched = { asr: { provider: 'openai', apiKey: 'volc-key', apiKeyProvider: 'volc', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' } };
  assert.equal(asrApiKey(switched), '', '换供应商后旧 Key 不参与请求');
  assert.equal(asrConfigured(switched), false, '因此被判成没配齐（工具不注入）');
  // 老配置没记 provider（升级上来的）：按原样使用，不做断供
  assert.equal(asrApiKey({ asr: { provider: 'openai', apiKey: 'k', apiKeyProvider: '' } }), 'k');
});
