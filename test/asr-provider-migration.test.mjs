// 默认 provider 从 local 改成 openai（2026-09-26）之后的一次性读盘迁移。
// 单独立文件：必须在 import config.js 之前写好 config.json，才能验"读盘那一刻"的行为。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asr-provider-migrate-'));
process.env.QQ_AGENT_DATA_DIR = root;
// 老配置：没显式存过 provider，但本机装过转写（<数据目录>/asr 是安装脚本/一键安装的落点）
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  api: { provider: 'deepseek', baseUrl: 'https://api.example.com/v1', model: 'x', apiKey: 'k' },
  asr: { enabled: true, apiKey: 'SOME-OLD-KEY', model: 'whisper-large-v3-turbo' }
}, null, 2));
fs.mkdirSync(path.join(root, 'asr'), { recursive: true });

const C = await import('../src/core/config.js');

test('装了本机转写的老配置：provider 回填 local，不会静默失效', () => {
  const cfg = C.getConfig();
  assert.equal(cfg.asr.provider, 'local', '看得出装过本机转写就回填 local');
  // 模型没就位时仍是"没配齐"，但 provider 语义没被悄悄换掉
  assert.equal(C.asrConfigured(cfg), C.asrLocalModel(cfg) !== '' && Boolean(C.findWhisperBinSync(cfg)));
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
