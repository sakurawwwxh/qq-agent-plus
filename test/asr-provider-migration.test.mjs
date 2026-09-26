// 默认 provider 从 local 改成 openai（2026-09-26）之后的一次性读盘迁移。
// 单独立文件：必须在 import config.js 之前写好 config.json，才能验"读盘那一刻"的行为。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asr-provider-migrate-'));
process.env.QQ_AGENT_DATA_DIR = root;
// 老配置：没显式存过 provider，但本机装过转写（照安装脚本的落点摆出"模型 + 二进制"两样，
// 因为判据现在与运行期一致：两样都能解析到才算"装过"）
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  api: { provider: 'deepseek', baseUrl: 'https://api.example.com/v1', model: 'x', apiKey: 'k' },
  asr: { enabled: true, apiKey: 'SOME-OLD-KEY', model: 'whisper-large-v3-turbo' }
}, null, 2));
const managedAsr = path.join(root, 'asr');
fs.mkdirSync(path.join(managedAsr, 'whisper.cpp', 'build', 'bin'), { recursive: true });
fs.writeFileSync(path.join(managedAsr, 'ggml-small.bin'), 'stub');
fs.writeFileSync(path.join(managedAsr, 'whisper.cpp', 'build', 'bin', 'whisper-cli'), '');

const C = await import('../src/core/config.js');

test('装了本机转写的老配置：provider 回填 local，不会静默失效', () => {
  const cfg = C.getConfig();
  assert.equal(cfg.asr.provider, 'local', '看得出装过本机转写就回填 local');
  // 模型与二进制都在（就在 <数据目录>/asr 下）→ 迁移后仍判定"配齐"，也就是升级不掉功能
  assert.equal(C.asrLocalModel(cfg).endsWith('ggml-small.bin'), true);
  assert.equal(Boolean(C.findWhisperBinSync(cfg)), true);
  assert.equal(C.asrConfigured(cfg), true, '迁移不该把能用的本机转写判成不可用');
});

test('没装本机转写的老配置：用新默认，但未知归属的凭据不会被记到默认服务名下', () => {
  const asr = { enabled: true, apiKey: 'SOME-OLD-KEY', model: 'm', apiKeyProvider: '', apiKeyHost: '' };
  assert.equal(C.applyAsrProviderFallback(asr, { localInstalled: false }), 'openai');
  assert.equal(asr.apiKeyProvider, 'local', '归属未知 → 记到用不到凭据的 local 名下');
  const cfg = { asr: { ...asr, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' } };
  assert.equal(C.asrApiKey(cfg), '', '不该把这把 Key 发到用户从没选过的预置服务');
  assert.equal(C.asrConfigured(cfg), false, '判定为没配齐 → 不注入工具、不产生费用');
});

test('显式存过 provider 的配置：迁移不插手', () => {
  const asr = { provider: 'volc', apiKey: 'VOLC_KEY', apiKeyProvider: 'volc' };
  C.pinStoredAsrCredentials(asr, asr.provider);
  assert.equal(asr.provider, 'volc');
  assert.equal(asr.apiKeyProvider, 'volc');
});

test('存的那把 Key 不适用时，环境变量 ASR_API_KEY 仍然生效（文档承诺过）', () => {
  process.env.ASR_API_KEY = 'env-key';
  const cfg = { asr: { provider: 'openai', apiKey: 'x', apiKeyProvider: 'volc', baseUrl: 'https://api.siliconflow.cn/v1', model: 'm' } };
  assert.equal(C.asrApiKey(cfg), 'env-key');
  delete process.env.ASR_API_KEY;
  assert.equal(C.asrApiKey(cfg), '', 'env 撤掉就不再回落');
});

test('读盘迁移不写坏旧配置（保留其它字段与真凭据）', () => {
  const cfg = C.getConfig();
  assert.equal(cfg.api.apiKey, 'k', '其它段落原样保留');
  assert.equal(cfg.asr.apiKey, 'SOME-OLD-KEY', '凭据本身不动（只是它不适用）');
});


test('显式存在 PATH/标准位置的 whisper.cpp 时，迁移也要判成 local（不能只看安装脚本落点）', () => {
  const asr = { enabled: true, model: 'm' };   // 没写 localBin/localModel，也不是 <数据目录>/asr 那种装法
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const binName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  fs.writeFileSync(path.join(fakeBin, binName), '');
  const modelFile = path.join(root, 'ggml-small.bin');
  fs.writeFileSync(modelFile, 'x');
  const savedPath = process.env.PATH;
  const savedModel = process.env.WHISPER_MODEL;
  process.env.PATH = fakeBin + path.delimiter + (savedPath || '');
  process.env.WHISPER_MODEL = modelFile;      // 与环境变量/标准位置同类的"运行期能解析到"
  try {
    const localLooksInstalled = C.asrLocalModel({ asr }) !== '' && Boolean(C.findWhisperBinSync({ asr }));
    assert.equal(localLooksInstalled, true, '运行期解析得到就该算装过');
    assert.equal(C.applyAsrProviderFallback(asr, { localInstalled: localLooksInstalled }), 'local');
  } finally {
    process.env.PATH = savedPath;
    if (savedModel === undefined) delete process.env.WHISPER_MODEL; else process.env.WHISPER_MODEL = savedModel;
  }
});

test('provider 只是"升级默认值"时不吃环境变量 Key；保存过一次后恢复', () => {
  const asr = { enabled: true, model: 'm', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' };
  C.applyAsrProviderFallback(asr, { localInstalled: false });
  assert.equal(asr.providerDefaulted, true, '标记要落下来');
  process.env.ASR_API_KEY = 'env-key-must-not-leak';
  assert.equal(C.asrApiKey({ asr }), '', '用户没选过这家，不该拿部署级 env Key 去请求');
  assert.equal(C.asrConfigured({ asr }), false, '判定为没配齐 → 不注入工具');
  delete asr.providerDefaulted;                // 控制台保存一次等于确认
  assert.equal(C.asrApiKey({ asr }), 'env-key-must-not-leak', '确认后 env Key 照常生效');
  delete process.env.ASR_API_KEY;
});

test('Key 来源如实上报：存的那把不适用时，真正生效的是环境变量', () => {
  process.env.ASR_API_KEY = 'env-key-2';
  const cfg = { asr: { provider: 'openai', apiKey: 'stored-for-volc', apiKeyProvider: 'volc', baseUrl: 'https://api.siliconflow.cn/v1', model: 'm' } };
  assert.equal(C.asrApiKey(cfg), 'env-key-2');
  assert.equal(C.asrKeySource(cfg), 'env', '界面要据此显示"Key 来自环境变量"');
  const applied = { asr: { ...cfg.asr, apiKeyProvider: 'openai' } };
  assert.equal(C.asrKeySource(applied), 'config', '存的那把适用时才是 config');
  delete process.env.ASR_API_KEY;
});
