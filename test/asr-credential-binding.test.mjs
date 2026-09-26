// 语音转写凭据的归属：凭据与"存它时的服务"绑定，OpenAI 兼容的还绑地址主机。
// 为什么单独一个文件：这里的关键用例要在**读盘那一刻**验证迁移（老配置没有归属字段），
// 所以必须先写 config.json 再 import config.js —— 与其它用例共享模块实例的测试文件做不到。
// 背景（2026-09-26 独立审查 + 实测复现）：
//   · 硅基流动 → Groq 换预设：都是 provider=openai，旧 Key 会被发到 api.groq.com
//   · 腾讯云 → 讯飞/百度：secretKey 字段三家共用，腾讯的 SecretKey 会被当成讯飞 APISecret 发出去
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asr-binding-'));
process.env.QQ_AGENT_DATA_DIR = root;

// 老配置：凭据都在，但没有任何"归属"字段（升级前的形态）
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  api: {
    provider: 'deepseek',
    baseUrl: 'https://api.example.com/v1',
    model: 'x',
    apiKey: 'k'
  },
  asr: {
    enabled: true,
    provider: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    apiKey: 'sk-siliconflow',
    secretId: 'AKID-tencent',
    secretKey: 'TENCENT_SK'
  }
}, null, 2));

const C = await import('../src/core/config.js');

test('读盘时给老配置补上凭据归属（provider + 地址主机）', () => {
  const cfg = C.getConfig();
  assert.equal(cfg.asr.apiKeyProvider, 'openai', 'Key 的归属按当前这家补记');
  assert.equal(cfg.asr.apiKeyHost, 'api.siliconflow.cn', 'OpenAI 兼容还要记地址主机');
  assert.equal(C.asrApiKey(cfg), 'sk-siliconflow', '补记不等于失效：原有配置照常能用');
  assert.equal(C.asrConfigured(cfg), true);
});

test('同 provider 换地址（硅基流动 → Groq）：旧 Key 不再算数', () => {
  const cfg = C.updateConfig({ asr: { baseUrl: 'https://api.groq.com/openai/v1' } });
  assert.equal(cfg.asr.provider, 'openai', 'provider 没变（这就是当初看不出来的原因）');
  assert.equal(C.asrApiKey(cfg), '', '换了地址就不该再拿旧 Key 去请求');
  assert.equal(C.asrConfigured(cfg), false);
  assert.equal(C.asrAvailable(cfg), false, '工具不该注入');
});

test('换回原地址：Key 还在（不是被删掉，只是"不对这家生效"）', () => {
  const cfg = C.updateConfig({ asr: { baseUrl: 'https://api.siliconflow.cn/v1' } });
  assert.equal(C.asrApiKey(cfg), 'sk-siliconflow');
  assert.equal(C.asrConfigured(cfg), true);
});

test('同一主机只是路径写法不同（/v1 → /v1/）：不该要求重填', () => {
  const cfg = C.updateConfig({ asr: { baseUrl: 'https://api.siliconflow.cn/v1/' } });
  assert.equal(C.asrApiKey(cfg), 'sk-siliconflow');
});

test('老配置里"归属未知"的 Secret 不因升级失效，但一旦记过归属就不再串用', () => {
  // 读盘时这份配置的 provider 是 openai，而 openai 不使用 secretId/secretKey
  // → 归属**不补**（无法判断它是给腾讯还是讯飞还是百度存的），保持"未绑定"的旧行为
  let cfg = C.updateConfig({ asr: { provider: 'tencent' } });
  assert.equal(Boolean(cfg.asr.secretIdProvider), false, '读盘不补、合并也不补：不把未知归属洗成当前这家');
  assert.equal(Boolean(cfg.asr.secretKeyProvider), false);
  assert.equal(C.asrConfigured(cfg), true, '老配置照常能用（不给升级中的实例制造"突然失效"）');

  // 用户按新流程重填一次（界面会带上 secretKeyProvider）→ 从此按归属判定
  cfg = C.updateConfig({ asr: { provider: 'iflytek', appId: 'APP1', apiKey: 'IFLYTEK_KEY', apiKeyProvider: 'iflytek', secretKey: 'IFLYTEK_SECRET', secretKeyProvider: 'iflytek' } });
  assert.equal(C.asrConfigured(cfg), true, '讯飞这一家重填后配齐');
  assert.equal(C.asrSecretKey(cfg), 'IFLYTEK_SECRET');

  // 再切到百度：讯飞的 APISecret 不该被当作百度 Secret 用
  cfg = C.updateConfig({ asr: { provider: 'baidu', apiKey: 'BAIDU_KEY', apiKeyProvider: 'baidu' } });
  assert.equal(C.asrSecretKey(cfg), '', '百度拿不到讯飞的 Secret');
  // 百度新式鉴权（bce-v3 Bearer）本来就不需要 Secret，所以这家仍是"配齐"的；
  // 关键是它不会把别家的 Secret 拼进换 token 的请求里（老式那条路只在拿到本家 Secret 时才走）
  assert.equal(C.asrConfigured(cfg), true);
});

test('适配器取值也不串用（options 构造器走的是同一套绑定）', async () => {
  const { iflytekOptions } = await import('../src/llm/asr-iflytek.js');
  const { baiduOptions } = await import('../src/llm/asr-baidu.js');
  const { tencentOptions } = await import('../src/llm/asr-tencent.js');
  const { dashscopeOptions } = await import('../src/llm/asr-dashscope.js');
  const { openAiProviderOptions } = await import('../src/llm/asr-openai.js');
  // 每个断言用自己的配置对象：不依赖前一个用例留下的状态
  const iflytek = { asr: { provider: 'iflytek', appId: 'APP1', apiKey: 'IFLYTEK_KEY', apiKeyProvider: 'iflytek', secretKey: 'IFLYTEK_SECRET', secretKeyProvider: 'iflytek' } };
  assert.equal(iflytekOptions(iflytek).apiKey, 'IFLYTEK_KEY');
  assert.equal(iflytekOptions(iflytek).apiSecret, 'IFLYTEK_SECRET', '给讯飞存的能用');

  // 凭据是为别家存的：三家都拿不到
  const elsewhere = { asr: { provider: 'iflytek', appId: 'A', apiKey: 'K', apiKeyProvider: 'iflytek', secretKey: 'TENCENT_SK', secretKeyProvider: 'tencent' } };
  assert.equal(iflytekOptions(elsewhere).apiSecret, '', '讯飞拿不到腾讯的 SecretKey');
  assert.equal(baiduOptions(elsewhere).secretKey, '', '百度也拿不到');
  assert.equal(tencentOptions({ asr: { provider: 'tencent', secretId: 'AKID', secretIdProvider: 'iflytek', secretKey: 'SK', secretKeyProvider: 'iflytek' } }).secretId, '', '腾讯拿不到讯飞的 SecretId');

  // 阿里百炼的 Key 同样走绑定：给火山存的 Key 不能拿给百炼
  assert.equal(dashscopeOptions({ asr: { provider: 'aliyun', apiKey: 'VOLC_KEY', apiKeyProvider: 'volc' } }).apiKey, '');
  // openai 兼容：换地址后旧 Key 不参与（与 UI/设备判定同一套）
  assert.equal(openAiProviderOptions({ asr: { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'sk-siliconflow', apiKeyProvider: 'openai', apiKeyHost: 'api.siliconflow.cn' } }).apiKey, '');
});

test('控制台保存回传的运行时字段不落盘、也不改凭据归属', () => {
  // 先摆成"讯飞的 Key + 讯飞的 Secret"
  C.updateConfig({ asr: { provider: 'iflytek', appId: 'APP1', apiKey: 'IFLYTEK_KEY', apiKeyProvider: 'iflytek', secretKey: 'IFLYTEK_SECRET', secretKeyProvider: 'iflytek' } });
  const before = C.getConfig();
  // 模拟界面：patch = {...GET 到的 asr（含服务端附加的结论）, 真改动}
  const cfg = C.updateConfig({
    asr: {
      ...before.asr,
      configured: true, available: true, keySource: 'config', keyProvider: 'iflytek',
      secretIdUsable: false, secretKeyUsable: true,
      localBinResolved: '/nope/whisper-cli', localModelResolved: '/nope/ggml.bin',
      localManagedExists: false, localInstalled: false,
      hasApiKey: true, hasSecretKey: true
    }
  });
  const derived = ['configured', 'available', 'keySource', 'keyProvider', 'keyUsable', 'keyHost',
    'secretIdUsable', 'secretKeyUsable', 'localBinResolved', 'localModelResolved',
    'localManagedExists', 'localInstalled', 'hasApiKey', 'hasSecretKey'];
  for (const key of derived) {
    assert.equal(Object.prototype.hasOwnProperty.call(cfg.asr, key), false, `${key} 不该留在配置里`);
  }
  // 归属字段是配置本身，必须留着（apiKeyHost 是 openai 专用，这里 provider 是讯飞 → 不记）
  assert.equal(cfg.asr.apiKeyProvider, 'iflytek');
  assert.equal(cfg.asr.secretKeyProvider, 'iflytek');
});

test('provider 缺失的老配置不强行补归属（别把 Key 绑到默认的本机上）', () => {
  const asr = { enabled: true, apiKey: 'just-a-key' };
  C.pinStoredAsrCredentials(asr, '');               // provider 为空 → 什么都不记
  assert.equal(asr.apiKeyProvider, undefined, 'provider 缺失时不该把 Key 绑到任何一家');
  C.pinStoredAsrCredentials(asr, 'openai');         // 有 provider → 记归属（并记地址）
  assert.equal(asr.apiKeyProvider, 'openai');
  assert.equal(asr.apiKeyHost, undefined, '地址没填就不记主机（asrCredentialApplies 会跳过地址检查）');
});

test('读盘补记只针对"这家会用到"的凭据（腾讯的字段不记到 openai 名下）', () => {
  // 老配置：provider=openai，但 secretId/secretKey 还留着（只有腾讯/讯飞/百度会用）
  const asr = {
    provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-x', secretId: 'AKID', secretKey: 'SK'
  };
  C.pinStoredAsrCredentials(asr, 'openai');
  assert.equal(asr.apiKeyProvider, 'openai');
  assert.equal(asr.apiKeyHost, 'api.siliconflow.cn');
  assert.equal(asr.secretIdProvider, undefined, 'openai 不用 secretId → 不记（否则会挡住它真正的主人）');
  assert.equal(asr.secretKeyProvider, undefined);

  // 反过来：provider=tencent 的配置里那对凭据就是腾讯的 → 记上，之后换家必须重填
  const tc = C.updateConfig({ asr: { provider: 'tencent', secretId: 'AKID', secretKey: 'SK', apiKeyProvider: '', keyProvider: '' } });
  const tencentAsr = { provider: 'tencent', secretId: tc.asr.secretId, secretKey: tc.asr.secretKey };
  C.pinStoredAsrCredentials(tencentAsr, 'tencent');
  assert.equal(tencentAsr.secretIdProvider, 'tencent');
  assert.equal(tencentAsr.secretKeyProvider, 'tencent');
});
