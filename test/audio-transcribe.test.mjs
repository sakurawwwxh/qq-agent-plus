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
  withKey.asr.provider = 'volc';            // 默认是 API Key 的托管服务（openai），这里换成火山测
  withKey.asr.apiKey = 'test-asr-key';
  assert.equal(asrAvailable(withKey), true, '火山的 Key + 开关默认开 → 可用');
  const searchOff = structuredClone(withKey);
  searchOff.webSearch.enabled = false;
  assert.equal(asrAvailable(searchOff), true, '关掉联网搜索不该顺带关掉语音转写');
  const asrOff = structuredClone(withKey);
  asrOff.asr.enabled = false;
  assert.equal(asrAvailable(asrOff), false, '自己的开关关掉就不可用');
  assert.equal(asrAvailable(structuredClone(DEFAULT_CONFIG)), false,
    '默认（API Key 的托管服务）没填 Key 时不注入工具 —— 既不会调用失败，也不会产生费用');
  // 关键回归：只配了搜索 Key 不该开启语音转写（两套服务，不复用）
  const searchKeyOnly = structuredClone(DEFAULT_CONFIG);
  searchKeyOnly.webSearch.doubao.apiKey = 'search-key';
  assert.equal(asrAvailable(searchKeyOnly), false, '搜索 Key 不能当 ASR Key 用');
  const searchOffOnly = structuredClone(DEFAULT_CONFIG);
  searchOffOnly.webSearch.doubao.apiKey = 'search-key';
  searchOffOnly.asr.provider = 'volc';      // 用 Key 的那家要显式选
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
  const { whisperArgs, localWhisperTranscribe } = await import('../src/llm/asr-local.js');
  const { WHISPER_BIN_CANDIDATES } = await import('../src/core/config.js');
  assert.deepEqual(WHISPER_BIN_CANDIDATES, ['whisper-cli', 'whisper-cpp', 'main']);
  const args = whisperArgs({ model: '/m/ggml-base.bin', wavPath: '/tmp/a.wav', outPrefix: '/tmp/a.out', language: 'zh' });
  assert.deepEqual(args, ['-m', '/m/ggml-base.bin', '-f', '/tmp/a.wav', '-otxt', '-of', '/tmp/a.out', '-np', '-l', 'zh']);
  assert.ok(whisperArgs({ model: 'm', wavPath: 'a', outPrefix: 'o', language: '', threads: 4 }).includes('-t'));
  await assert.rejects(() => localWhisperTranscribe('/tmp/x.wav', { model: '' }), /localModel/);
});

it('供应商路由：按 asr.provider 选后端，配置齐才判定可用', async () => {
  const { asrProvider, asrConfigured, asrAvailable } = await import('../src/core/config.js');
  const base = structuredClone(DEFAULT_CONFIG);
  assert.equal(asrProvider(base), 'openai', '缺省是 API Key 的托管服务（用户要求）');
  assert.equal(asrProvider({ asr: { provider: 'OPENAI' } }), 'openai', '大小写不敏感');
  assert.equal(asrProvider({ asr: { provider: '乱写的' } }), 'openai', '坏值回落到默认供应商');
  assert.equal(asrProvider({ asr: { provider: 'volc' } }), 'volc', '显式写了火山就还是火山（老配置不受影响）');
  // volc：只要 Key
  assert.equal(asrConfigured({ asr: { provider: 'volc', apiKey: '' } }), false);
  assert.equal(asrConfigured({ asr: { provider: 'volc', apiKey: 'k' } }), true);
  // openai 兼容：要 Key + 地址 + 模型名（服务不同，模型名不能猜）
  assert.equal(asrConfigured({ asr: { provider: 'openai', apiKey: 'k', baseUrl: 'https://x/v1' } }), false);
  assert.equal(asrConfigured({ asr: { provider: 'openai', apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' } }), true);
  // local：不要 Key，但要模型文件
  assert.equal(asrConfigured({ asr: { provider: 'local', localModel: '' } }), false);
  // 本机要"模型 + 能跑的二进制"两样齐（用 node 自己当二进制替身）
  assert.equal(asrAvailable({ asr: { enabled: true, provider: 'local', localModel: '/m.bin', localBin: process.execPath } }), true);
  assert.equal(asrAvailable({ asr: { enabled: false, provider: 'local', localModel: '/m.bin', localBin: process.execPath } }), false);
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

// ── 默认是托管服务；本机转写（零 Key）仍是一等选项 ──

it('默认供应商是 API Key 的托管服务；本机转写的路径按"配置 > 环境变量 > 标准位置"解析', async () => {
  const { asrProvider, ASR_DEFAULT_PROVIDER, asrLocalModel, asrLocalBin, asrConfigured } =
    await import('../src/core/config.js');
  const { DEFAULT_CONFIG } = await import('../src/core/config.js');
  assert.equal(ASR_DEFAULT_PROVIDER, 'openai', '默认是 API Key 的托管服务（用户 2026-09-26 要求）');
  assert.equal(asrProvider(structuredClone(DEFAULT_CONFIG)), 'openai');
  assert.equal(asrProvider({ asr: {} }), 'openai', '没写 provider 也走托管服务');
  // 显式选 local 时，本机那套解析规则照旧
  assert.equal(asrProvider({ asr: { provider: 'local' } }), 'local');

  // 配置里的路径优先（哪怕文件不存在也按配置来：探测失败会给出可自查的报错）
  assert.equal(asrLocalModel({ asr: { localModel: '/opt/m.bin' } }), '/opt/m.bin');
  assert.equal(asrLocalBin({ asr: { localBin: '/opt/whisper-cli' } }), '/opt/whisper-cli');

  // 环境变量次之
  process.env.WHISPER_MODEL = '/env/m.bin';
  process.env.WHISPER_BIN = '/env/bin';
  assert.equal(asrLocalModel({ asr: {} }), '/env/m.bin');
  assert.equal(asrLocalBin({ asr: {} }), '/env/bin');
  delete process.env.WHISPER_MODEL;
  delete process.env.WHISPER_BIN;

  // 都没有 → 自动找 <数据目录>/asr/ 下的 ggml-*.bin（偏好 small → base → tiny），二进制回落到候选名
  const asrDir = path.join(dir, 'asr');
  fs.mkdirSync(asrDir, { recursive: true });
  fs.writeFileSync(path.join(asrDir, 'ggml-tiny.bin'), 'x');
  fs.writeFileSync(path.join(asrDir, 'ggml-base.bin'), 'x');
  fs.writeFileSync(path.join(asrDir, 'notes.txt'), 'x');           // 非模型文件要忽略
  assert.equal(asrLocalModel({ asr: {} }), path.join(asrDir, 'ggml-base.bin'), '有 base 就优先 base（比 tiny 好）');
  assert.equal(asrConfigured({ asr: { provider: 'local', localBin: process.execPath } }), true,
    '自动找到模型 + 给了可用的二进制 → 算配齐');
  // 候选链：PATH 里真有 whisper-cpp（不是首选名）时也要能找到它 —— 早先这里恒返回
  // 'whisper-cli'，把"显式指定"和"默认候选"混为一谈，导致回退链成了死代码（审查抓到）。
  const fakeBinDir = path.join(dir, 'bin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const fakeName = process.platform === 'win32' ? 'whisper-cpp.exe' : 'whisper-cpp';
  fs.writeFileSync(path.join(fakeBinDir, fakeName), 'x');
  const savedPath = process.env.PATH;
  process.env.PATH = fakeBinDir;
  try {
    // Windows 上会带 .exe（spawn 也能吃不带后缀的，但显式更稳）
    assert.match(asrLocalBin({ asr: {} }), /^whisper-cpp(\.exe)?$/, '按候选名依次找，命中 whisper-cpp');
    assert.equal(asrLocalBin({ asr: { localBin: '/opt/my-cli' } }), '/opt/my-cli', '配置优先于探测');
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
  fs.rmSync(asrDir, { recursive: true, force: true });
});

it('本机转写超时按音频长度放大（固定 10 分钟会把长音频一律掐成超时）', async () => {
  const { localTimeoutMs } = await import('../src/tools/audio-transcribe.js');
  assert.equal(localTimeoutMs(0), 68 * 1000, '空输入也留 60 秒底');
  assert.equal(localTimeoutMs(30 * 32000), 300 * 1000, '30 秒音频 → 约 5 分钟');
  assert.equal(localTimeoutMs(900 * 32000), 30 * 60 * 1000, '15 分钟音频 → 封顶 30 分钟');
});

it('二进制探测：显式指定却跑不起来要如实返回 null（不偷偷换别的）', async () => {
  const { resolveWhisperBin } = await import('../src/llm/asr-local.js');
  assert.equal(await resolveWhisperBin('definitely-not-a-real-binary-xyz'), null);
  // node 自己能跑 --help（退出 0），用它当"存在的二进制"验证探测正向路径
  assert.equal(await resolveWhisperBin(process.execPath), process.execPath);
});

it('安装脚本：参数解析与模型地址（坏参数要报清楚）', async () => {
  const { parseArgs, modelUrl, MODEL_CHOICES, MODEL_MIRRORS } = await import('../scripts/install-asr-local.mjs');
  const def = parseArgs([]);
  assert.equal(def.model, 'small');
  assert.equal(def.writeConfig, true);
  assert.deepEqual(MODEL_MIRRORS, ['https://hf-mirror.com', 'https://huggingface.co'], '默认先试国内镜像');
  assert.equal(modelUrl('https://hf-mirror.com/', 'base'),
    'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin');
  assert.equal(MODEL_CHOICES.small.file, 'ggml-small.bin');
  assert.equal(parseArgs(['--model', 'base', '--no-write-config', '--mirror', 'https://x']).writeConfig, false);
  assert.throws(() => parseArgs(['--model', 'huge']), /不认识的模型/);
  assert.throws(() => parseArgs(['--bogus']), /未知参数/);
  assert.throws(() => parseArgs(['--model']), /缺少取值/);
});

// ── 审查跟进（第二轮）：回退链、判定连二进制、原子写配置 ──

it('没找到二进制时 asrLocalBin 返回空（候选链才会真正生效）', async () => {
  const { asrLocalBin, findWhisperBinSync, WHISPER_BIN_CANDIDATES } = await import('../src/core/config.js');
  // 审查抓到的 Critical：早先 asrLocalBin 兜底返回 'whisper-cli'，而 resolveWhisperBin 把"非空"
  // 当成用户显式指定 → 探测失败直接 return null，whisper-cpp / main 这两条回退永远轮不到。
  const env = process.env.PATH;
  process.env.PATH = dir;                       // 空前缀下没有任何候选名
  try {
    assert.equal(findWhisperBinSync(), null);
    assert.equal(asrLocalBin({ asr: {} }), '', '找不到就如实返回空');
    // 配置/环境变量给了值就照样返回（那是用户显式指定的）
    assert.equal(asrLocalBin({ asr: { localBin: '/opt/bin' } }), '/opt/bin');
    process.env.WHISPER_BIN = '/env/bin';
    assert.equal(asrLocalBin({ asr: {} }), '/env/bin');
  } finally {
    delete process.env.WHISPER_BIN;
    process.env.PATH = env;
  }
  assert.ok(WHISPER_BIN_CANDIDATES.includes('whisper-cpp'), '候选链里保留 whisper-cpp');
});

it('本机转写要"模型 + 能跑的二进制"两样齐才算可用', async () => {
  const { asrConfigured, asrAvailable } = await import('../src/core/config.js');
  const model = path.join(dir, 'asr', 'ggml-tiny.bin');
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, 'x');
  // 有模型、但 PATH 里找不到任何 whisper 二进制 → 仍判不可用（否则工具注入了、调用必失败）
  const env = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.equal(asrConfigured({ asr: { provider: 'local' } }), false);
    assert.equal(asrAvailable({ asr: { provider: 'local' } }), false);
    // 配置里给了可用的二进制（用 node 自己当替身）→ 判可用
    assert.equal(asrConfigured({ asr: { provider: 'local', localBin: process.execPath } }), true);
  } finally {
    process.env.PATH = env;
  }
  fs.rmSync(path.dirname(model), { recursive: true, force: true });
});

it('安装脚本写配置是原子的：写完不留 .tmp，内容包含新指针', async () => {
  const { writeConfigPointers } = await import('../scripts/install-asr-local.mjs');
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ api: { apiKey: 'keep-me' }, asr: { enabled: true } }, null, 2));
  writeConfigPointers(cfgFile, '/opt/whisper-cli', '/opt/ggml-small.bin');
  const parsed = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(parsed.asr.localBin, '/opt/whisper-cli');
  assert.equal(parsed.asr.localModel, '/opt/ggml-small.bin');
  assert.equal(parsed.asr.provider, 'local');
  assert.equal(parsed.api.apiKey, 'keep-me', '别的字段原样保留');
  assert.equal(fs.existsSync(`${cfgFile}.${process.pid}.tmp`), false, '不留临时文件');
  fs.rmSync(cfgFile, { force: true });
});

it('安装脚本：--restart 选项与默认值（装完要能重启让配置生效）', async () => {
  const { parseArgs } = await import('../scripts/install-asr-local.mjs');
  assert.equal(parseArgs([]).restart, false, '默认不擅自重启服务');
  assert.equal(parseArgs(['--restart']).restart, true);
  assert.equal(parseArgs(['--print-only']).printOnly, true);
});


// ── 媒体定位：文件段换地址 / 协议端只给文件名时的说明（2026-09-26 视频反馈跟进）──

it('文件段只有 file_id 时用 get_group_file_url / get_private_file_url 换地址', async () => {
  const { resolveFileSegmentUrl } = await import('../src/tools/audio-transcribe.js');
  const calls = [];
  const onebot = { call: async (action, params) => { calls.push({ action, params }); return { url: 'https://cdn.example.com/x.mp4' }; } };
  assert.equal(await resolveFileSegmentUrl({ chatKey: 'group:123', onebot }, { fileSegId: 'F1' }),
    'https://cdn.example.com/x.mp4');
  assert.deepEqual(calls[0], { action: 'get_group_file_url', params: { group_id: 123, file_id: 'F1' } });

  assert.equal(await resolveFileSegmentUrl({ chatKey: 'private:456', onebot }, { fileSegId: 'F2' }),
    'https://cdn.example.com/x.mp4');
  assert.deepEqual(calls[1], { action: 'get_private_file_url', params: { user_id: 456, file_id: 'F2' } });

  // 没有 file_id / 协议端报错 / 返回的不是 http 地址 → 都返回空串，由上层给准确说明
  assert.equal(await resolveFileSegmentUrl({ chatKey: 'group:1', onebot }, { fileSegId: '' }), '');
  assert.equal(await resolveFileSegmentUrl({ chatKey: 'group:1', onebot: { call: async () => { throw new Error('boom'); } } }, { fileSegId: 'F3' }), '');
  assert.equal(await resolveFileSegmentUrl({ chatKey: 'group:1', onebot: { call: async () => ({ url: 'file:///tmp/x.mp4' }) } }, { fileSegId: 'F4' }), '');
});

it('协议端只给文件名（没有 URL）时说清楚，不再去请求一个文件名', async () => {
  const { currentMessageAudioUrl, transcribeMessageAudio } = await import('../src/tools/audio-transcribe.js');
  const ctx = {
    chatKey: 'group:1',
    signal: AbortSignal.timeout(5000),
    onebot: { getMsg: async () => ({ message: [{ type: 'video', data: { file: 'abc.mp4' } }] }) }
  };
  const target = await currentMessageAudioUrl(ctx, { mid: 'v1' });
  assert.equal(target.url, '', '没给 URL 就不该把文件名当 URL');
  assert.equal(target.localOnly, true);
  assert.equal(target.name, 'abc.mp4');
  const out = await transcribeMessageAudio(ctx, { mid: 'v1' });
  assert.equal(out.ok, false);
  assert.match(out.error, /拿不到下载地址/);
  assert.match(out.error, /发送文件/, '要给出可照做的替代做法');
});


// ── 非语音判定：音乐/音效不该被当成"人声转写"讲给群友（2026-09-26 打花火视频反馈）──

it('停顿比例：连续有声（音乐/音效）标记为非语音，有停顿的说话不标记', async () => {
  const { analyzeSpeechiness, speechCaveat } = await import('../src/tools/audio-transcribe.js');
  const tone = (seconds, { gaps = [] } = {}) => {
    const n = Math.round(seconds * 16000);
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) {
      const t = i / 16000;
      const inGap = gaps.some(([a, b]) => t >= a && t < b);
      const v = inGap ? 0 : Math.round(9000 * Math.sin(2 * Math.PI * 220 * t));
      pcm.writeInt16LE(v, i * 2);
    }
    return pcm;
  };
  // 连续 10 秒（音乐/音效那种持续能量）→ 标记
  const continuous = analyzeSpeechiness(tone(10));
  assert.equal(continuous.maybeNonSpeech, true, `近静音占比 ${continuous.quietRatio.toFixed(3)} 应判为非语音`);
  assert.match(speechCaveat(continuous), /音乐\/音效|没听到/);
  // 说话那种节奏（每句之间留 0.5 秒停顿）→ 不标记
  const spoken = analyzeSpeechiness(tone(10, { gaps: [[2, 2.5], [4.5, 5], [7, 7.5]] }));
  assert.equal(spoken.maybeNonSpeech, false, `近静音占比 ${spoken.quietRatio.toFixed(3)} 不该判为非语音`);
  assert.equal(speechCaveat(spoken), '');
  // 太短（3 秒以内）不下结论：短语音很难从停顿上判断
  assert.equal(analyzeSpeechiness(tone(2)).maybeNonSpeech, false);
  // 全静音：不是"非语音"（走"没有内容"那条分支）
  assert.equal(analyzeSpeechiness(Buffer.alloc(16000 * 2 * 5)).maybeNonSpeech, false);
});

it('转写结果带上"可能是音乐/音效"的提示（工具层原样带给模型）', async () => {
  const { speechCaveat, analyzeSpeechiness } = await import('../src/tools/audio-transcribe.js');
  const info = analyzeSpeechiness(Buffer.alloc(0));
  assert.equal(speechCaveat(info), '', '空音频不给提示');
  assert.equal(speechCaveat({ maybeNonSpeech: false }), '');
  assert.match(speechCaveat({ maybeNonSpeech: true }), /别把上面的文字当作事实/);
});


it('语音段只给文件名时用 get_record 换地址（实测 NapCat 会返回 CDN URL）', async () => {
  const { resolveRecordUrl } = await import('../src/tools/audio-transcribe.js');
  const calls = [];
  const ctx = { chatKey: 'group:1', onebot: { call: async (action, params) => { calls.push({ action, params }); return { file: 'https://cdn.example.com/a.amr' }; } } };
  assert.equal(await resolveRecordUrl(ctx, { name: 'abc.amr' }), 'https://cdn.example.com/a.amr');
  assert.deepEqual(calls[0], { action: 'get_record', params: { file: 'abc.amr' } });
  // 没有文件名 / 协议端报错 / 回的不是 http 地址 → 空串（上层给准确说明）
  assert.equal(await resolveRecordUrl(ctx, { name: '' }), '');
  assert.equal(await resolveRecordUrl({ onebot: { call: async () => { throw new Error('x'); } } }, { name: 'a.amr' }), '');
  assert.equal(await resolveRecordUrl({ onebot: { call: async () => ({ file: 'file:///tmp/a.amr' }) } }, { name: 'a.amr' }), '');
});

it('推流型供应商的长度闸门留了 60 秒余量（原来 30 秒会贴着运行死线）', async () => {
  const { pacedAudioLimitSeconds } = await import('../src/tools/audio-transcribe.js');
  const cfg = { api: { runTimeoutMs: 180000 } };
  assert.equal(pacedAudioLimitSeconds(cfg, 'iflytek'), 120, '180-60');
  assert.equal(pacedAudioLimitSeconds(cfg, 'local'), 60, '再砍半（本机约 2 倍实时）');
  assert.equal(pacedAudioLimitSeconds(cfg, 'openai'), 0, '一次上传的服务不受限');
  // 配置把运行时限调小时，闸门跟着收紧
  assert.equal(pacedAudioLimitSeconds({ api: { runTimeoutMs: 60000 } }, 'iflytek'), 30, '最少留 30 秒');
});


it('空音频给"内容为空"的准确报错（不是一句 ffmpeg 转换失败）', async () => {
  const { audioBufferToPcm } = await import('../src/tools/audio-transcribe.js');
  await assert.rejects(() => audioBufferToPcm(Buffer.alloc(0), { name: 'x.amr' }), /音频内容为空/);
});
