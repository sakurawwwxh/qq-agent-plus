// #5 前置：密钥判定的单一实现。
// sanitizeConfigSecrets 从 src/console/app.js 逐字迁出 —— 本文件是"迁移没搬坏"的等价性护栏，
// 断言口径直接抄自迁出前的实现语义（删字段而非置空串、has* 布尔不连锁、三段特判）。
// 变异对照：把 delete node[key] 改成置空串、或去掉 providerKeys/tts.keys/providers 特判，用例必红。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { sanitizeConfigSecrets, redactSecretFields } = await import('../src/core/secret-keys.js');

test('sanitizeConfigSecrets：删字段而不是置空串，并补 hasXxx（前端回传语义的护栏）', () => {
  const out = sanitizeConfigSecrets({
    api: { apiKey: 'sk-abc', baseUrl: 'https://x' },
    webSearch: { deepseek: { apiKey: 'k2' } }
  });
  assert.equal(out.api.apiKey, undefined, '密钥字段必须整键删除（空串会在前端回传时覆盖真 Key）');
  assert.equal(out.api.hasApiKey, true);
  assert.equal(out.api.baseUrl, 'https://x');
  assert.equal(Object.prototype.hasOwnProperty.call(out.webSearch.deepseek, 'apiKey'), false);
  assert.equal(out.webSearch.deepseek.hasApiKey, true);
});

test('sanitizeConfigSecrets：*From 与 has* 布尔不脱敏（含"有/无"为 false 的口径）', () => {
  const out = sanitizeConfigSecrets({
    asr: { apiKey: '', apiKeyProvider: 'volc', secretKeyFrom: 'manual' },
    api: { hasApiKey: true }
  });
  // 现存语义（逐字迁出，不动）：字段名含 "apikey" 一律脱敏——连 apiKeyProvider 这种
  // "归属标识"也删；界面要的归属由 asrStatusOf 从原始配置另行下发（见 console/app.js）。
  assert.equal(out.asr.apiKeyProvider, undefined);
  assert.equal(out.asr.hasApiKeyProvider, true);
  assert.equal(out.asr.secretKeyFrom, 'manual');   // *From 排除
  assert.equal(out.asr.hasApiKey, false);          // 值为空 → false 标记，不是缺键
  assert.equal(out.api.hasApiKey, true);
  assert.equal(out.api.hasHasApiKey, undefined, '派生的 has* 布尔不得被二次处理');
});

test('sanitizeConfigSecrets：providerKeys / tts.keys / imageGen.keys / asr.keys / providers[].apiKey 特判', () => {
  const out = sanitizeConfigSecrets({
    providerKeys: { p1: 'sk-1', p2: '' },
    tts: { keys: { siliconflow: 'sk-x' }, service: 'siliconflow' },
    imageGen: { keys: { 'api.siliconflow.cn': 'sk-img' }, model: 'm' },
    asr: { keys: { 'openai|api.siliconflow.cn': { apiKey: 'sk-asr' }, tencent: { secretId: 'AKID', secretKey: 'SK' } } },
    providers: [{ id: 'p1', label: 'A', apiKey: 'sk-1' }, { id: 'p2', apiKey: '' }]
  });
  assert.deepEqual(out.providerKeys, {}, '密钥集合整体清空，不逐 key 暴露存在性');
  assert.deepEqual(out.providerKeyPresence, { p1: true, p2: false });
  assert.deepEqual(out.tts.keys, {}, 'tts 按服务 id 存的 keys 映射不得明文下发');
  assert.equal(out.tts.service, 'siliconflow');
  assert.deepEqual(out.imageGen.keys, {}, 'imageGen 按主机存的 keys 映射不得明文下发（"哪几家存过"走 keyHosts）');
  assert.equal(out.imageGen.model, 'm');
  assert.deepEqual(out.asr.keys, {}, 'asr 按服务槽位存的 keys 映射不得明文下发（"哪几家存过"走 keySlots）');
  assert.equal(out.providers[0].apiKey, undefined);
  assert.equal(out.providers[0].hasKey, true);
  assert.equal(out.providers[1].hasKey, false);
});

test('sanitizeConfigSecrets：非对象形态的 keys 也要整包清空（手改坏配置不许明文下发）', () => {
  // 2026-10-02 全量审查实测：`"keys": "sk-xxx"` 既不匹配 SECRET_KEY_PATTERN（裸 key 是刻意排除的），
  // 又躲过"只有对象才清空"的判断 → 原样下发给浏览器。类型无关地清掉。
  const out = sanitizeConfigSecrets({
    tts: { keys: 'sk-tts-malformed' },
    imageGen: { keys: ['sk-img-a', 'sk-img-b'] },
    asr: { keys: 5, provider: 'openai' }
  });
  assert.deepEqual(out.tts.keys, {}, '字符串形态');
  assert.deepEqual(out.imageGen.keys, {}, '数组形态');
  assert.deepEqual(out.asr.keys, {}, '数字形态');
  assert.equal(out.asr.provider, 'openai', '同一段其它字段不受影响');
});

test('sanitizeConfigSecrets：返回副本，不改原对象', () => {
  const cfg = { api: { apiKey: 'sk-abc' } };
  sanitizeConfigSecrets(cfg);
  assert.equal(cfg.api.apiKey, 'sk-abc');
});

test('redactSecretFields：深层命中替换为 [redacted]；凭据集合整包替换（keys 映射不漏网）', () => {
  const out = redactSecretFields({
    api: { apiKey: 'sk-a', baseUrl: 'u' },
    tts: { keys: { siliconflow: 'sk-b' } },
    bare: { keys: { someService: 'sk-z' } },
    providers: [{ id: 'p', apiKey: 'sk-c' }],
    list: [{ token: 't' }, 'plain']
  });
  assert.equal(out.api.apiKey, '[redacted]');
  assert.equal(out.api.baseUrl, 'u');
  assert.equal(out.tts.keys, '[redacted]', '内部键名不含模式也不能漏（整包替换）');
  assert.equal(out.bare.keys, '[redacted]', '裸 keys 映射同口径（模式表不匹配裸 key，靠容器名补上）');
  assert.equal(out.providers[0].apiKey, '[redacted]');
  assert.equal(out.list[0].token, '[redacted]');
  assert.equal(out.list[1], 'plain');
});

test('redactSecretFields：has* 布尔与 *From 保留；循环引用不炸', () => {
  const node = { hasApiKey: false, apiKeyFrom: 'manual', password: 'p' };
  node.self = node;
  const out = redactSecretFields(node);
  assert.equal(out.hasApiKey, false);
  assert.equal(out.apiKeyFrom, 'manual');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.self, '[circular]');
});

test('sanitizeConfigSecrets：MCP env/args 用 ****** 掩码，不能把真 Key 从前端回传里冲掉', () => {
  const out = sanitizeConfigSecrets({
    mcp: {
      enabled: true,
      servers: [{
        id: 'github',
        command: 'npx',
        args: ['-y', '@x/y', '--token=ghp_secret', '--api-key', 'sk-live-secret'],
        env: { GITHUB_TOKEN: 'ghp_secret', DATABASE_URL: 'postgres://u:p@h/db', ROOT: '/data/knowledge' }
      }]
    }
  });
  const server = out.mcp.servers[0];
  assert.equal(server.env.GITHUB_TOKEN, '******');
  assert.equal(server.env.DATABASE_URL, '******', 'env 值一律掩码（键名不可靠）');
  assert.equal(server.env.ROOT, '******');
  assert.equal(server.args.at(-1), '******', '分参数写法的值也要掩');
  assert.equal(server.args.at(-2), '--api-key');
  assert.equal(server.args[0], '-y');
  assert.ok(!JSON.stringify(out).includes('sk-live-secret'));
  assert.ok(!JSON.stringify(out).includes('ghp_secret'));
});
