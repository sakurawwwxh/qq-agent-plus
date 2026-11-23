// 2026-10-04 推前复审的回归用例（对应未发版提交 v0.7.7..HEAD 的审查结论）。
//
// 这一批全是"上一轮加固自己引入的漏洞"与"两套口径不一致"，逐条钉住：
//  ① TTS 单槽 Key：切服务**并**填新 Key 时，旧 Key 必须先归档（否则下一轮切回就永久丢失）；
//  ② ASR 归档槽的条目类型守卫（与目标槽同一套，之前只给目标槽加）；
//  ③ asr.providerDefaulted 在整节替换（__replace__）里也要被剥掉；
//  ④ migrateConfig 不再给"归属未知"的 imageGen Key 补钉（合并路径补 = 绑到刚被改掉的地址）；
//  ⑤ migrateConfig 把 asr.keys 的标量条目归一成 {}；
//  ⑥ updateConfig 遇到非对象的段不再 500。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-review-1004-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig, getConfig, loadConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { ttsKeyFor } = await import('../src/llm/tts-presets.js');
const { imageGenKeyStale, resolveImageGenAuth } = await import('../src/llm/image-gen.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// 起一个只监听本机、observe 模式的控制台，返回请求助手
async function withConsole(t, seedConfig = () => {}) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'ws://127.0.0.1:1';
  seedConfig(cfg);
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const disk = () => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  return { port, request, disk };
}

test('① 切服务并填新 Key：旧的那把必须先归档，不能被归属钉改绑后清掉', async (t) => {
  const { request } = await withConsole(t, (cfg) => {
    // 存量实例形态：Key 只在单槽 tts.apiKey 里，keys 映射是空的
    cfg.tts = { ...cfg.tts, enabled: true, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'SK-SILICON-OLD' };
  });

  // 切到豆包并填一把新的 —— 这条路径之前完全绕过了归档分支
  let res = await request('/api/config', {
    method: 'POST',
    body: {
      tts: {
        enabled: true,
        provider: 'doubao',
        baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
        apiKeyInput: 'SK-DOUBAO-NEW'
      }
    }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  let now = getConfig().tts;
  assert.equal(now.keys?.siliconflow, 'SK-SILICON-OLD', '切走前要把上一家的 Key 归档进它自己的槽位');
  assert.equal(ttsKeyFor(now, 'doubao'), 'SK-DOUBAO-NEW', '新服务拿到的是新填的那把');
  // 单槽与归属钉必须指向同一把（之前是"旧 Key 留在单槽、钉却指向新服务"）
  assert.equal(String(now.apiKey || ''), 'SK-DOUBAO-NEW', '单槽装的是新填的那把');
  assert.equal(now.apiKeyService, 'doubao', '归属钉与单槽内容一致');
  // 运行端真正会取的那把（不给 serviceId = 当前服务）：必须是新填的那把，不能是上一家的
  assert.equal(ttsKeyFor(now), 'SK-DOUBAO-NEW', '当前服务实际发出去的必须是新 Key');

  // 关键一步：切回硅基流动、不填 Key。修复前这里会因为"归档位已被占用"而直接置空 → 永久丢失
  res = await request('/api/config', {
    method: 'POST',
    body: { tts: { enabled: true, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ttsKeyFor(getConfig().tts, 'siliconflow'), 'SK-SILICON-OLD', '切回原服务不用重填：归档那把自动回来了');
});

test('② asr.keys 里被手改成标量的槽位，归档时不摊成字符索引', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.asr = {
      ...cfg.asr,
      // 讯飞：凭据按 provider 分槽（apiKeyProvider/secretIdProvider/secretKeyProvider = tencent）
      provider: 'tencent',
      apiKey: 'SK-TENCENT-OLD',
      apiKeyProvider: 'tencent',
      secretId: 'SECRET-ID-OLD',
      secretIdProvider: 'tencent',
      secretKey: 'SECRET-KEY-OLD',
      secretKeyProvider: 'tencent'
    };
  });
  // ⚠️ 坏条目必须**在路由跑之前**进内存：种子 updateConfig 自己就走 migrateConfig，
  // 那道防线会把标量先归一成 {}，路由层就永远遇不到标量条目（用例反而测不到归档守卫）。
  // 这里模拟的是"配置文件被手改坏 / 由更老的版本写出"的状态。
  const corrupted = disk();
  corrupted.asr.keys = { tencent: 'SCALAR' };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(corrupted, null, 2));
  getConfig().asr.keys = { tencent: 'SCALAR' };

  // 保存一次（换服务、不带凭据）→ 归档循环要往 tencent 槽写
  // 磁盘是故意手改坏的，模拟管理员确认“用当前页面覆盖”。
  const res = await request('/api/config?force=1', {
    method: 'POST',
    body: { asr: { enabled: true, provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const tencent = disk().asr.keys?.tencent;
  assert.equal(typeof tencent, 'object', '归档目标槽必须被归一成条目对象，不能是字符串摊开的字符索引');
  assert.equal(Array.isArray(tencent), false, '槽位不能是数组');
  // 旧凭据确实按它自己的槽位归档下来了（没被这次保存顺手冲掉）
  assert.equal(tencent.apiKey, 'SK-TENCENT-OLD', '归属明确的那把要归档进自己的槽位');
  assert.equal(tencent.secretKey, 'SECRET-KEY-OLD');
  assert.deepEqual(Object.keys(tencent).filter((k) => /^\d+$/.test(k)), [], '不许出现字符索引键');
});

test('③ 整节替换里的 asr.providerDefaulted 也要被剥掉', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: 'https://api.openai.com/v1', providerDefaulted: true };
  });
  assert.equal(disk().asr.providerDefaulted, true, '前提：老标记确实在盘上');

  const res = await request('/api/config', {
    method: 'POST',
    body: { asr: { __replace__: { enabled: true, provider: 'openai', baseUrl: 'https://api.openai.com/v1', providerDefaulted: true } } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal('providerDefaulted' in disk().asr, false,
    '替换体里的 providerDefaulted 不许落盘（落盘就永久屏蔽 ASR_API_KEY 环境变量）');
  assert.equal(disk().asr.enabled, true, '替换体里的其它字段照常生效');
});

test('④ 合并路径不再给"归属未知"的 imageGen Key 补钉（读盘那次照旧补）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = { ...cfg.api, baseUrl: 'https://api.openai.com/v1' };
    // 老配置：单槽有 Key、没记归属
    cfg.imageGen = { ...cfg.imageGen, enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: 'SK-IMG-OLD', apiKeyHost: '' };
  });

// 前提（读盘语义）：给"有 Key 没归属"的老配置补钉，是 loadConfig 的职责，不是合并路径的
  const diskPath = path.join(root, 'config.json');
  const seedOnDisk = disk();
  seedOnDisk.imageGen.apiKeyHost = '';
  fs.writeFileSync(diskPath, JSON.stringify(seedOnDisk, null, 2));
  assert.equal(loadConfig().imageGen.apiKeyHost, 'api.openai.com',
    '读盘要给"有 Key 没归属"的老配置补上归属（migrateConfig 合并路径不做这件事）');

  // ⚠️ 落点断言：一次保存里既带新地址、又没带新 Key 时，那把"没记归属"的旧 Key **不许被补钉**
  //（补了就等于永久绑到新主机：换回原地址也对不上，用户的 Key 被锁死；
  //   而真发出去更糟 —— resolveImageGenAuth 会把它当新主机那把发出去）。
  updateConfig({
    imageGen: {
      ...getConfig().imageGen,
      enabled: true,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'SK-IMG-OLD',
      apiKeyHost: ''
    }
  });
  assert.equal(String(getConfig().imageGen.apiKeyHost || ''), '',
    '合并路径不许认领"归属未知"的凭据（路由层刻意不认领，migrateConfig 不能替它认领）');
  assert.equal(getConfig().imageGen.apiKey, 'SK-IMG-OLD', '值本身留着（没填新 Key = 不动现有那把）');

  // 换回原来那家的地址 → 那把 Key 仍然可用（这才是"没被锁死"的用户可见结果）
  updateConfig({ imageGen: { ...getConfig().imageGen, baseUrl: 'https://api.openai.com/v1', apiKeyHost: '' } });
  const restored = getConfig().imageGen;
  assert.equal(imageGenKeyStale(restored, { baseUrl: 'https://api.openai.com/v1' }), false,
    '换回原来的地址后那把 Key 仍然可用');
  assert.equal(resolveImageGenAuth({ imageGen: restored, api: { baseUrl: 'https://api.openai.com/v1' } }).key, 'SK-IMG-OLD',
    '运行端确实会取到原来那把');

  // 而"控制台真的提交了新 Key"时归属照旧要记（别把守卫做成"永远不记归属"）。
// 注意走**路由**：归属钉由路由层按本次提交的地址算（migrateConfig 不再兜这一手）。
  const submitted = await request('/api/config', {
    method: 'POST',
    body: { imageGen: { enabled: true, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'SK-IMG-NEW' } }
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(disk().imageGen.apiKeyHost, 'open.bigmodel.cn', '提交新 Key 时按新地址记归属');
  assert.equal(disk().imageGen.apiKey, 'SK-IMG-NEW');
  assert.equal(disk().imageGen.keys?.['open.bigmodel.cn'], 'SK-IMG-NEW', '新 Key 也存进"这家存过的"映射');
});

test('⑤ asr.keys 的标量条目在读盘时被归一成对象', async (t) => {
  await withConsole(t, (cfg) => {
    cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: 'https://api.openai.com/v1', keys: { tencent: 'SCALAR' } };
  });
  const diskPath = path.join(root, 'config.json');
  const onDisk = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
  onDisk.asr.keys = { tencent: 'SCALAR', 'openai|api.openai.com': { apiKey: 'SK-X' } };
  fs.writeFileSync(diskPath, JSON.stringify(onDisk, null, 2));
  // 读盘（migrateConfig 是它的必经口）之后标量条目不该还在
  const loaded = loadConfig();
  assert.deepEqual(loaded.asr.keys.tencent, {}, '标量条目归一成空对象');
  assert.equal(loaded.asr.keys['openai|api.openai.com'].apiKey, 'SK-X', '正常条目不受影响');
});

test('⑥ 段被送成标量/数组时按"没改这一段"处理，不 500', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = { ...cfg.api, baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' };
  });
  for (const section of ['api', 'conversation', 'dailyMoments', 'qzoneInteractions']) {
    const res = await request('/api/config', { method: 'POST', body: { [section]: '__replace__x' } });
    assert.equal(res.status, 200, `${section} 送标量应被忽略而不是 500：${JSON.stringify(res.body)}`);
  }
  // 同样试数组（deepMerge 与"必须是对象"的判定都按数组另算）
  for (const section of ['api', 'asr', 'tts', 'imageGen', 'persona']) {
    const res = await request('/api/config', { method: 'POST', body: { [section]: [1, 2] } });
    assert.equal(res.status, 200, `${section} 送数组应被忽略而不是 500：${JSON.stringify(res.body)}`);
  }
  // 坏输入不能把已有配置冲掉
  assert.equal(disk().api.baseUrl, 'https://api.openai.com/v1', '坏输入不许清空整段');
  assert.equal(disk().api.model, 'gpt-x');
});

test('⑦ provider 送原型链上的属性名：被忽略，且控制台不会永久 500（2026-10-04 复审 P2）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'SK-LEGACY' };
  });

  // 前提：注入前一切正常
  assert.equal((await request('/api/config')).status, 200);

  // provider 直接决定槽位名；送 "constructor" 会让 keys 里出现同名槽位，
  // 之后 asrKeySlots 取到 Object.prototype.constructor 并抛 "list.includes is not a function"
  const attack = await request('/api/config', {
    method: 'POST',
    body: { asr: { enabled: true, provider: 'constructor', baseUrl: 'https://api.openai.com/v1', apiKey: 'SK-ATK' } }
  });
  assert.equal(attack.status, 200, `不该 500：${JSON.stringify(attack.body).slice(0, 120)}`);

  // 非法 provider 不落盘，槽位名也不产生
  assert.equal(disk().asr.provider, 'openai', '非法 provider 被忽略，沿用当前那家');
  const slots = Object.keys(disk().asr.keys || {});
  for (const name of slots) {
    assert.equal(Object.hasOwn(Object.prototype, name), false,
      `槽位名 "${name}" 撞上了 Object.prototype 上的属性 —— 这正是让 asrKeySlots 抛错的那一类`);
    assert.notEqual(name, '__proto__', '__proto__ 不许作为槽位名');
  }
  assert.equal(slots.includes('constructor'), false, '绝不能生成 constructor 槽位（修复的落点）');

  // 关键：控制台没有被这一下打成永久 500
  assert.equal((await request('/api/config')).status, 200, '注入之后 GET 仍要正常');
  // 再来一次"正常"保存也不能把状态搞坏
  assert.equal((await request('/api/config', {
    method: 'POST', body: { asr: { enabled: true, provider: 'openai', apiKey: 'SK-NEW' } }
  })).status, 200);
  assert.equal((await request('/api/config')).status, 200);
});

test('⑦ 附：ASR_PROVIDERS 里的合法值照常生效（别把守卫做成"永远不认新 provider"）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: 'https://api.openai.com/v1' };
  });
  for (const provider of ['tencent', 'iflytek', 'baidu', 'volc', 'local']) {
    const res = await request('/api/config', { method: 'POST', body: { asr: { enabled: true, provider } } });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 120));
    assert.equal(disk().asr.provider, provider, `合法 provider ${provider} 要能保存`);
  }
  // 空 provider = "没改这一项"，沿用当前值
  const cur = disk().asr.provider;
  await request('/api/config', { method: 'POST', body: { asr: { enabled: true, provider: '' } } });
  assert.equal(disk().asr.provider, cur, '空 provider 不该把当前那家冲掉');
});
test('⑦ 附二：配置里**已经有**毒槽位时也不抛错（旧版本留下的 / 手改的 config.json）', async () => {
  // provider 白名单只挡住"新产生"的坏槽位；已经躺在盘上的那些照样会被读到，
  // 所以读路径本身必须对原型链上的键名免疫 —— 否则升级前中招的实例永远起不来。
  const { asrKeySlots, asrCredentialFor } = await import('../src/core/config-legacy.js');
  const poisoned = {
    provider: 'constructor',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'SK-KEPT',
    apiKeyProvider: 'openai',
    apiKeyHost: 'api.openai.com',
    keys: {
      constructor: { apiKey: 'SK-POISON' },
      __proto__: { apiKey: 'SK-PROTO' },
      toString: { apiKey: 'SK-TOSTRING' },
      'openai|api.openai.com': { apiKey: 'SK-REAL' }
    }
  };

  let slots = null;
  assert.doesNotThrow(() => { slots = asrKeySlots(poisoned); },
    'asrKeySlots 碰到 constructor/__proto__/toString 这类键名不能抛（抛了就是整个控制台 500）');
  assert.equal(typeof slots, 'object', '返回的槽位表要是普通对象');
  for (const [name, kinds] of Object.entries(slots)) {
    assert.equal(Array.isArray(kinds), true, `槽位 ${name} 的取值必须是数组（原型链上的键会取到函数）`);
  }
  // 正常那家照常可见（不能因为防住坏键就把好的也一起丢了）
  assert.ok(slots['openai|api.openai.com']?.includes('apiKey'), '合法槽位照常上报');

  // 取凭据：合法那家照常取得到；keys 里没有的自有槽位不许顺着原型链取值
  //（keys 里有**自有**的 constructor 槽时读到它是合理的 —— 那只是名字古怪的普通槽位；
  //  真正的危险是 keys 没有该键时顺着原型链取到 Object.prototype 上的东西）
  assert.equal(asrCredentialFor(poisoned, 'apiKey', 'openai', 'https://api.openai.com/v1'), 'SK-REAL',
    '合法那家的凭据照常取得到');
  const withoutOwn = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', keys: {} };
  assert.equal(asrCredentialFor(withoutOwn, 'apiKey', 'constructor', ''), '',
    'keys 里没有该槽位时必须返回空，不能顺着原型链取到 Object.prototype.constructor');
});

// ── 第二轮复审仍未修的五条（F3–F7）──

test('⑧ F3：老配置内联在 providers[].apiKey 的 Key，「加/删模型」后不许丢（2026-10-04 P2）', async () => {
  // providers[] 里不留明文 Key 是既定约定，重建列表时都要剥掉 —— 但剥之前必须归档进
  // providerKeys。老配置（Key 直接写在 providers[] 里）一次「加模型」就永久丢失：
  // 实测装完能用，加一次模型之后运行期解析成空串，控制台也没处找回来。
  const { addModelsToProvider, removeModelFromProvider, currentProviders } =
    await import('../src/core/providers.js');
  const { getConfig } = await import('../src/core/config.js');

  // 造一份"老形态"：Key 内联，且 providerKeys 里没有
  const cfg = getConfig();
  cfg.providers = [{
    id: 'legacy-1', name: '旧服务', baseURL: 'https://legacy.example/v1',
    models: ['m1', 'm2'], modelNames: { m1: 'M1', m2: 'M2' }, apiKey: 'sk-LEGACY-INLINE'
  }];
  cfg.providerKeys = {};
  assert.equal(currentProviders()[0]?.apiKey, 'sk-LEGACY-INLINE', '前提：老配置装完运行期能用');

  addModelsToProvider('legacy-1', [{ id: 'm3', name: 'M3' }]);
  assert.equal(getConfig().providerKeys['legacy-1'], 'sk-LEGACY-INLINE',
    '剥掉内联字段之前必须先归档进 providerKeys（F3 的落点）');
  assert.equal(currentProviders()[0]?.apiKey, 'sk-LEGACY-INLINE', '加模型之后仍然能用那把 Key');
  assert.notEqual(getConfig().providers?.[0]?.apiKey, 'sk-LEGACY-INLINE', 'providers[] 里不留明文');

  removeModelFromProvider('legacy-1', 'm3');
  assert.equal(currentProviders()[0]?.apiKey, 'sk-LEGACY-INLINE', '删模型之后同样不能丢');
  // 已经在 providerKeys 里的不被内联那份覆盖（内联可能更旧）
  cfg.providers[0].apiKey = 'sk-OLDER-INLINE';
  addModelsToProvider('legacy-1', [{ id: 'm4', name: 'M4' }]);
  assert.equal(getConfig().providerKeys['legacy-1'], 'sk-LEGACY-INLINE', '已归档的值不被更旧的内联值覆盖');
});

test('⑨ F4：非对象的 __replace__ 当"这一项没给"，不许静默清空整段（2026-10-04 P3）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.asr = { ...cfg.asr, provider: 'tencent', secretId: 'AKID', secretKey: 'SECRET', secretIdProvider: 'tencent', secretKeyProvider: 'tencent' };
    cfg.tts = { ...cfg.tts, enabled: true, apiKey: 'SK-TTS' };
    cfg.imageGen = { ...cfg.imageGen, enabled: true, apiKey: 'SK-IMG' };
  });
  const res = await request('/api/config', {
    method: 'POST',
    body: {
      asr: { __replace__: null },
      tts: { __replace__: 'x' },
      imageGen: { __replace__: [] }
    }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 120));
  const onDisk = disk();
  for (const sec of ['asr', 'tts', 'imageGen']) {
    assert.equal(onDisk[sec] === null || onDisk[sec] === '' || Array.isArray(onDisk[sec]),
      false, `${sec} 段被非对象的 __replace__ 清掉了`);
  }
  assert.equal(onDisk.asr.secretKey, 'SECRET', 'asr 的凭据不能因为一个坏替换体消失');
  assert.equal(onDisk.tts.apiKey, 'SK-TTS', 'tts 的 Key 同理');
  assert.equal(onDisk.imageGen.apiKey, 'SK-IMG', 'imageGen 的 Key 同理');
  // 合法的对象替换体照旧生效（别把守卫做成"永远不许整节替换"）
  const ok = await request('/api/config', { method: 'POST', body: { imageGen: { __replace__: { enabled: true, baseUrl: 'https://zhipu.example/v1' } } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 120));
  assert.equal(disk().imageGen.baseUrl, 'https://zhipu.example/v1', '对象替换体要照常生效');
});

test('⑩ F6：对象/数组形态的密钥字段也要脱敏（2026-10-04 P3）', async () => {
  const { sanitizeConfigSecrets } = await import('../src/core/secret-keys.js');
  const out = sanitizeConfigSecrets({
    api: {
      extraBody: { authorization: { value: 'Bearer sk-AUTH-NESTED' } },
      apiKey: { value: 'sk-NESTED' },
      token: ['sk-ARR'],
      apiSecret: 'sk-PLAIN',
      safeField: 'not-a-secret'
    }
  });
  const text = JSON.stringify(out);
  for (const leak of ['sk-AUTH-NESTED', 'sk-NESTED', 'sk-ARR', 'sk-PLAIN']) {
    assert.equal(text.includes(leak), false, `${leak} 仍明文出现在脱敏结果里`);
  }
  assert.equal('apiKey' in out.api, false, '对象形态的 apiKey 要整条删掉');
  assert.equal('authorization' in out.api.extraBody, false, '嵌套在 extraBody 里的也要删');
  assert.equal('token' in out.api, false, '数组形态的 token 要整条删掉');
  assert.equal(out.api.safeField, 'not-a-secret', '非密钥字段不受影响');
  // hasXxx 仍要正确生成（界面靠它显示"已填"）
  assert.equal(out.api.hasApiKey, true, '对象形态也要算出 hasApiKey=true');
  assert.equal(out.api.hasToken, true);
  assert.equal(out.api.hasApiSecret, true);
});

test('⑪ F7：api / providers 的 has* 派生位不许落盘（2026-10-04 P3）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = { ...cfg.api, baseUrl: 'https://api.openai.com/v1' };
  });
  // 模拟"整份配置展开回传"的客户端：把 GET 看到的派生位原样送回来
  const res = await request('/api/config', {
    method: 'POST',
    body: {
      api: { baseUrl: 'https://api.openai.com/v1', hasApiKey: true, hasKey: true },
      providers: [{ id: 'p1', name: 'x', baseURL: 'https://x.example/v1', hasKey: true, hasApiKey: true }]
    }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 120));
  const onDisk = disk();
  assert.equal('hasApiKey' in (onDisk.api || {}), false, 'api.hasApiKey 不许落盘');
  assert.equal('hasKey' in (onDisk.api || {}), false, 'api.hasKey 不许落盘');
  assert.equal('hasKey' in (onDisk.providers?.[0] || {}), false, 'providers[].hasKey 不许落盘');
  assert.equal('hasApiKey' in (onDisk.providers?.[0] || {}), false, 'providers[].hasApiKey 不许落盘');
  // 正字段要照常写进去
  assert.equal(onDisk.api.baseUrl, 'https://api.openai.com/v1');
});

test('⑫ F5：人物印象 / 异常日志两页的加载要有"只认最后一次"守卫（2026-10-04 P3）', async () => {
  // 这两条加载路径在 ui/app.js 里，要复现"慢的旧响应盖掉新结果"必须并发两个请求；
  // 而单独加载整个控制台会留下 1.5 秒自我续期的状态轮询（Node 定时器，window.close()
  // 停不掉，见 test/ui-preserve-editable.test.mjs 头注）—— 所以这里用源码锚点断言，
  // 强度弱于行为用例，如实标注：它能咬住"删掉守卫"，但证明不了竞态真的被挡住。
  const fs = await import('node:fs');
  const app = fs.readFileSync('ui/app.js', 'utf8');
  const state = fs.readFileSync('ui/core/state.js', 'utf8');
  assert.match(state, /state\.identityLoadToken\s*=\s*0/, 'state 上要有 identityLoadToken');
  assert.match(state, /state\.incidentLoadToken\s*=\s*0/, 'state 上要有 incidentLoadToken');
  for (const [fn, token] of [['loadIdentityFeaturePage', 'identityLoadToken'], ['loadIncidentFeaturePage', 'incidentLoadToken']]) {
    const start = app.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, `ui/app.js 里找不到 ${fn}`);
    // 窗口给足余量：identity 侧的守卫在 ~757 字符处，900 的窗口余量只剩 ~140，
    // 以后在函数头加长注释就会把守卫挤出窗口、断言假红（2026-10-04 复审 P3）
    const body = app.slice(start, start + 1300);
    assert.ok(body.includes(`++state.${token}`), `${fn} 每次加载要递增自己的序号`);
    assert.ok(body.includes(`if (token !== state.${token}) return;`),
      `${fn} 必须丢弃过期结果（只认最后一次）`);
    const catchAt = body.indexOf('catch (error) {');
    assert.ok(catchAt >= 0 && body.slice(catchAt).includes(`if (token !== state.${token}) return;`),
      `${fn} 的 catch 分支也要过同一道守卫（过期失败不许盖掉新结果）`);
  }
});

// ── 第三轮复审：F9（我引入的回归）+ F7 补漏 + F3 语义副作用 + F8 ──

test('⑬ F9：extraBody 里的自定义请求头要扛过「打开设置页 → 原样保存」（2026-10-04 P2）', async (t) => {
  // F6 把对象形态的密钥字段换成 hasXxx 之后，脱敏视图里就只剩 {hasAuthorization:true}；
  // 文本域原样回填 + 保存时原样 __replace__ 提交 → 用户的真配置被覆盖掉，还多一个
  // hasAuthorization 进请求体。这是修 F6 时引入的回归。
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = {
      ...cfg.api, baseUrl: 'https://api.example/v1',
      extraBody: { normal: 'ok', authorization: { scheme: 'Bearer', value: 'sk-AUTH-REAL' } }
    };
  });
  // 界面看到的（脱敏视图）
  const view = (await request('/api/config')).body;
  assert.equal('authorization' in view.api.extraBody, false, '前提：视图里没有明文');
  assert.equal(view.api.extraBody.hasAuthorization, true, '前提：视图里是 hasAuthorization 占位');

  // 用户什么都不改，直接保存（文本域原样回传）
  const echoed = JSON.parse(JSON.stringify(view.api.extraBody));
  assert.equal((await request('/api/config', {
    method: 'POST', body: { api: { baseUrl: 'https://api.example/v1', extraBody: { __replace__: echoed } } }
  })).status, 200);
  assert.deepEqual(disk().api.extraBody, { normal: 'ok', authorization: { scheme: 'Bearer', value: 'sk-AUTH-REAL' } },
    '原样保存不许吃掉真配置（F9 的落点）');
  assert.equal('hasAuthorization' in disk().api.extraBody, false, '也不许把 hasAuthorization 写进请求体');

  // 用户真要改 → 照常生效（别把守卫做成"永远不接受 extraBody"）
  await request('/api/config', {
    method: 'POST', body: { api: { baseUrl: 'https://api.example/v1', extraBody: { __replace__: { reasoning: { enabled: false } } } } }
  });
  assert.deepEqual(disk().api.extraBody, { reasoning: { enabled: false } }, '用户真改的内容要生效');
  // 用户真要清空 → 生效（配错一个会让所有请求 400 的逃生口必须能从界面清掉）
  await request('/api/config', {
    method: 'POST', body: { api: { baseUrl: 'https://api.example/v1', extraBody: { __replace__: {} } } }
  });
  assert.deepEqual(disk().api.extraBody, {}, '清空要生效');
});

test('⑭ F7 补漏：onebot 的 has* 派生位也不许落盘（2026-10-04 P3）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.onebot = { ...cfg.onebot, accessToken: 'ONEBOT-TOKEN', httpAccessToken: 'HTTP-TOKEN' };
  });
  const view = (await request('/api/config')).body;
  assert.equal((await request('/api/config', {
    method: 'POST',
    body: { onebot: { ...view.onebot, hasAccessToken: true, hasHttpAccessToken: true } }
  })).status, 200);
  assert.equal('hasAccessToken' in (disk().onebot || {}), false, 'onebot.hasAccessToken 不许落盘');
  assert.equal('hasHttpAccessToken' in (disk().onebot || {}), false, 'onebot.hasHttpAccessToken 不许落盘');
  assert.equal(disk().onebot.accessToken, 'ONEBOT-TOKEN', '真令牌不受影响');
});

test('⑮ F3：providerKeys 是权威存储 —— 两份 Key 不同时既不丢也不被换掉', async () => {
  // providerKeyValue 与 archiveInlineProviderKeys 必须同一套口径，否则会出现
  // 「读取看这份、落盘写那份」：一次与 Key 无关的「加模型」就把实际发出的 Key 换掉。
  // 2026-10-04 复审 P3：先做成「内联优先 + 归档以内联为准」，结果控制台刚写进去的
  // 新 Key 被旧的内联值覆盖掉（丢数据）。正解是**目录优先**（providerKeys 是权威存储，
  // providers[].apiKey 只是老配置残留），两边都不覆盖 —— 两份值都保住。
  const { addModelsToProvider, currentProviders } = await import('../src/core/providers.js');
  const { getConfig } = await import('../src/core/config.js');
  // ⚠️ updateConfig 会**替换**内存里的配置对象：每次改完都要重新 getConfig()，
  // 否则改到的是上一轮的过期对象（这个坑让本用例第一版假阴性）。
  const live = () => getConfig();

  // ① 只有内联那一份（老实例）：能用，且加模型后归档进目录，两份一致
  const c1 = live();
  c1.providers = [{ id: 'p1', name: 'x', baseURL: 'https://x.example/v1', models: ['m1'], apiKey: 'sk-ONLY-INLINE' }];
  c1.providerKeys = {};
  assert.equal(currentProviders()[0].apiKey, 'sk-ONLY-INLINE', '前提：只有内联时按内联兜底');
  addModelsToProvider('p1', [{ id: 'm2', name: 'M2' }]);
  assert.equal(live().providerKeys.p1, 'sk-ONLY-INLINE', '老实例的 Key 要归档进目录');
  assert.equal(currentProviders()[0].apiKey, 'sk-ONLY-INLINE', '归档后发出的 Key 不变');

  // ② 两份都在且不同：目录（控制台写的）为准，且**不许被内联那份覆盖**
  const c2 = live();
  c2.providers[0].apiKey = 'sk-OLD-INLINE';
  c2.providerKeys.p1 = 'sk-NEW-CATALOG';
  assert.equal(currentProviders()[0].apiKey, 'sk-NEW-CATALOG', '读取以目录为准（权威存储）');
  addModelsToProvider('p1', [{ id: 'm3', name: 'M3' }]);
  assert.equal(live().providerKeys.p1, 'sk-NEW-CATALOG',
    '控制台刚写入的 Key 不能被旧的内联残留覆盖（这条曾被写成内联优先，于是丢数据）');
  assert.equal(currentProviders()[0].apiKey, 'sk-NEW-CATALOG', '加模型之后实际发出的 Key 也不变');
});

test('⑰ G1：目录里是掩码时，不能把内联真值归档丢掉（2026-10-04 复审 P3）', async () => {
  // 读取侧把 '******' 当"没有"（回退内联），归档侧若当成"已有"就跳过 → 重建时内联被剥掉，
  // 目录只剩掩码、读取又当它不存在 → 真 Key 彻底消失。两边口径必须一致。
  const { addModelsToProvider, currentProviders, setProviderKey, upsertProvider } = await import('../src/core/providers.js');
  const { getConfig } = await import('../src/core/config.js');
  const live = () => getConfig();

  const c1 = live();
  c1.providers = [{ id: 'p1', name: 'x', baseURL: 'https://x.example/v1', models: ['m1'], apiKey: 'sk-INLINE-REAL' }];
  c1.providerKeys = { p1: '******' };               // 目录里是掩码（老界面回传过掩码就会这样）
  assert.equal(currentProviders()[0].apiKey, 'sk-INLINE-REAL', '前提：掩码当没有，回退内联真值');

  addModelsToProvider('p1', [{ id: 'm2', name: 'M2' }]);
  assert.equal(live().providerKeys.p1, 'sk-INLINE-REAL', '归档要把真值写进目录（掩码不算"已有"）');
  assert.equal(currentProviders()[0].apiKey, 'sk-INLINE-REAL', '加模型之后那把 Key 仍然可用');

  // 入口也要堵：掩码 = "没改这一项"，不该被当成新 Key 写进存储
  const before = JSON.stringify(live().providerKeys);
  setProviderKey('p1', '******');
  assert.equal(JSON.stringify(live().providerKeys), before, 'setProviderKey 不接受掩码（掩码=保持原值）');
  assert.equal(currentProviders()[0].apiKey, 'sk-INLINE-REAL', '传掩码不会把 Key 清掉');

  // upsertProvider 同样不许把掩码当成新 Key 写进存储
  upsertProvider({ baseUrl: 'https://x.example/v1', apiKey: '******', models: [] });
  assert.equal(live().providerKeys.p1, 'sk-INLINE-REAL', 'upsertProvider 也不接受掩码');
  assert.equal(currentProviders()[0].apiKey, 'sk-INLINE-REAL', '传掩码后那把 Key 仍然可用');

  // 新建分支同样不许把掩码当成新 Key（此前只挡了既有分支）
  const created = upsertProvider({ baseUrl: 'https://brand-new.example.com/v1', apiKey: '******', models: [{ id: 'm1', name: 'M' }] });
  const newId = created.provider.id;
  assert.notEqual(live().providerKeys[newId], '******', '新建分支也不接受掩码');
  assert.equal(created.provider.apiKey, '', '新建时传掩码 = 这个新提供商没填 Key');
});

// ── 全面复审：预算/运行时与出站/工具（2026-10-04 两条独立深挖路线的发现）──

test('⑱ A2/A1：预算闸门不按 manual 豁免 paced；block 下兜底回收不再反复排唤醒', async () => {
  // ⚠️ 这是**源码锚点**断言，强度弱于行为用例：要让 wake() 真的走到预算闸门，得把
  // Orchestrator 的 store/sessions/sender/runAgent 全套接上，第一版行为用例就是这么
  // 空过的（wake 在更早处就 return 了）。锚点能咬住「把修复改回去」，但证明不了
  // 预算超限时确实不会调模型 —— 那部分靠人工/线上核对。
  const src = fs.readFileSync('src/core/orchestrator.js', 'utf8');
  assert.match(src, /const budgetExempt = manual && !paced;/,
    'paced 不是人工：预算豁免必须区分两者');
  const gates = [...src.matchAll(/budget\.onExceed === '(block|degrade)' && !(\w+)/g)];
  assert.ok(gates.length >= 2, `前置条件：两道预算闸门，实际 ${gates.length}`);
  for (const g of gates) {
    assert.equal(g[2], 'budgetExempt', `预算闸门不能按 ${g[2]} 判（manual 会把 paced 一起豁免掉）`);
  }
  // block/degrade 都要挡：恢复循环、drainBacklogAfterResume 与提醒派发预检逐会话/逐派发走
  // #budgetWouldDrop（#budgetHardStop 已删 —— 它被 #budgetWouldDrop 完全覆盖，零调用方）。
  assert.doesNotMatch(src, /#budgetHardStop\(/, '死代码要删（判据已统一进 #budgetWouldDrop）');
  assert.ok((src.match(/this\.#budgetWouldDrop\(/g) || []).length >= 3,
    '兜底回收、恢复后排期、提醒派发三处都要先判「这个唤醒会不会被闸门丢掉」');
});
test('⑲ B1：协议端明确拒绝与结果不确定，走两条不同的记账口径', async () => {
  const { OneBotActionError } = await import('../src/onebot/onebot.js');
  // ⚠️ 下面两条只验证「构造器会保留 outcome/retcode 字段」—— isDefinite 是用例内的
  // 局部拷贝，不是生产实现；生产侧 definite 的计算若日后漂移，靠本用例末尾那条
  // 源码字符串锚点兜住，这两条管不到它。
  // 明确拒绝：带 outcome:'failed' 与 retcode —— 代码里判 definite 据此
  const definite = new OneBotActionError('retcode=100', { action: 'send_qzone_msg', outcome: 'failed', retcode: 100 });
  const isDefinite = (e) => e?.outcome === 'failed'
    || (e?.retcode !== undefined && e?.retcode !== null && e?.retcode !== '');
  assert.equal(isDefinite(definite), true, '前提：明确拒绝的错误能被判成 definite');

  // 结果不确定（超时 / 无 tid）：两者皆无，必须留在 publish-unknown 那一侧
  const uncertain = new Error('The operation was aborted due to timeout');
  assert.equal(isDefinite(uncertain), false, '超时类不该被当成明确拒绝（否则该记的待核对被吞掉）');

  // 记账口径本身（daily-moments 的 catch 分支）
  const src = fs.readFileSync('src/features/daily-moments.js', 'utf8');
  assert.ok(src.includes("record.status = definite ? 'failed' : 'publish-unknown';"),
    '明确拒绝记 failed、不确定记 publish-unknown（B1 的落点）');
});
test('⑳ B3：内联兜底里 arguments 是 JSON 字符串时要解出来，不能整包丢成 {}', async () => {
  const { parseInlineToolCalls } = await import('../src/tools/inline-tools.js');
  // OpenAI 的 function.arguments 就是**字符串**形态
  const asString = '<tool_call>' + JSON.stringify({ name: 'send_message', arguments: JSON.stringify({ content: '在吗' }) }) + '</tool_call>';
  const fromString = parseInlineToolCalls(asString);
  assert.equal(fromString.length, 1, '前提：解析出一条调用');
  assert.equal(fromString[0].name, 'send_message');
  assert.deepEqual(fromString[0].args, { content: '在吗' }, '字符串形态的参数不能整包丢掉');

  // 对象形态照旧
  const fromObject = parseInlineToolCalls('<tool_call>' + JSON.stringify({ name: 'send_message', arguments: { content: '在吗' } }) + '</tool_call>');
  assert.deepEqual(fromObject[0].args, { content: '在吗' });
  // 解不出来的字符串按空对象（而不是让整条调用崩掉）
  const broken = parseInlineToolCalls('<tool_call>' + JSON.stringify({ name: 'send_message', arguments: '{not json' }) + '</tool_call>');
  assert.deepEqual(broken[0].args, {}, '解不出的字符串按空对象');
});

test('⑳b P2：整段裸 JSON（无 <tool_call> 包裹）里的字符串 arguments 也要解出来', async () => {
  // 格式 4 的兜底原先按「非对象 → 整条丢弃」判：模型把 arguments 写成 JSON 字符串时调用被吞掉，
  // qzone/说说这类判断方会一直收到"必须调用 submit…"直到轮次耗尽失败（2026-10-05 全审）。
  const { resolveToolCalls } = await import('../src/tools/inline-tools.js');
  const plan = { feedActions: [{ id: 'feed-1', action: 'like', reason: '好' }], replyActions: [] };
  const bare = JSON.stringify({ name: 'submit_qzone_interactions', arguments: JSON.stringify(plan) });
  const calls = resolveToolCalls({ content: bare });
  assert.equal(calls.length, 1, '裸 JSON 兜底不能把整条调用吞掉');
  assert.equal(calls[0].function.name, 'submit_qzone_interactions');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), plan, '字符串形态的参数要解出来');

  // 对象形态照旧；原生 tool_calls 仍然优先
  const objForm = resolveToolCalls({ content: JSON.stringify({ name: 'send_message', arguments: { content: '在吗' } }) });
  assert.deepEqual(JSON.parse(objForm[0].function.arguments), { content: '在吗' });
  const native = resolveToolCalls({ tool_calls: [{ function: { name: 'x', arguments: '{}' } }], content: bare });
  assert.equal(native.length, 1);
  assert.equal(native[0].function.name, 'x', '有原生 tool_calls 时不走文本解析');
});
test('㉑ B2：中止落在动作间隔等待里时，未执行的条目保持 unread（不记 unknown）', async () => {
  const src = fs.readFileSync('src/features/qzone-interactions.js', 'utf8');
  // 两处「间隔等待之后、标记 acting 之前」都必须复查一次 abort
  const pauses = [...src.matchAll(/await this\.#pauseBetweenActions\(/g)];
  assert.ok(pauses.length >= 2, `前置条件：至少两处间隔等待，实际 ${pauses.length}`);
  let checked = 0;
  for (const m of pauses) {
    const after = src.slice(m.index, m.index + 900);
    if (/if \(signal\?\.aborted\)/.test(after)) checked += 1;
  }
  assert.equal(checked, pauses.length,
    '每次动作间隔等待之后都要复查 abort —— 间隔是不感知 abort 的 setTimeout，中止正好落在那里时，'
    + '下面那次调用根本没发出去却被 catch 记成 unknown（源码锚点断言，见下方说明）');
});

test('㉒ A4：resolveHeld 要清 never-acked 的 sent 行，但排除仍在途的租约', async () => {
  // 真行为在 store.test.mjs（「清残骸但绝不碰在途租约的证据」）；这里钉住源码口径。
  // 正则对空白/换行留容忍（等价重排不该假红），语义要有：按 chat_key 清 + 状态白名单 + 排除非终态租约。
  const src = fs.readFileSync('src/core/store.js', 'utf8');
  const start = src.indexOf('  resolveHeld(chatKey) {');
  assert.ok(start > 0, '前置条件：找得到 resolveHeld');
  // ⚠️ 剥注释再匹配：上面的注释里就写着"state NOT IN ('held','failed','acked')"这些词，
  // 不剥的话锚点可能被注释满足（2026-10-05 全审）。
  const body = src.slice(start, start + 2600).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ');
  assert.match(body, /DELETE FROM outbox WHERE chat_key\s*=\s*\?/,
    '残骸按 chat_key 清：主动唤醒没有 runs 行（runId 是合成值），只按终态 run 取交集永远清不掉它');
  assert.doesNotMatch(body, /state\s+IN\s*\([^)]*'sending'/,
    '在途 sending 不能按 chat_key 删除：主动唤醒/日报/群游戏的 run_id 不在 runs 表里，删了会丢未知证据');
  assert.match(body, /state\s+IN\s*\(\s*'unknown'\s*,\s*'sent'/,
    "租约从未 ack 的 'sent' / 主动唤醒的 'unknown' 只剩这一条清理路径，不清就是人工点完还留一地残骸");
  assert.match(body, /run_id\s+NOT\s+IN\s*\(\s*SELECT id FROM runs WHERE chat_key\s*=\s*\? AND state\s+NOT\s+IN\s*\(\s*'held'\s*,\s*'failed'\s*,\s*'acked'/,
    '在途租约（runs 里非终态的行）的证据必须排除：删了它 hasEffects=false → 整批消息回队重跑（P1）');
});
test('㉓ A5：discard 也要清节流时间戳（否则那个 Map 只涨不消）', async () => {
  const src = fs.readFileSync('src/core/sessions.js', 'utf8');
  const body = src.slice(src.indexOf('  discard(id) {'), src.indexOf('  discard(id) {') + 700);
  assert.ok(body.includes('this._lastPersistAt?.delete(id);'),
    'discard 与 finish 同款：会话没了，节流时间戳也要跟着清（否则反复丢弃 waiting 会让 Map 无界）');
});

test('㉔ A3：整理写回前要并回「快照之后新增」的印象', async () => {
  const src = fs.readFileSync('src/core/orchestrator.js', 'utf8');
  assert.ok(src.includes('appendedDuring'), '整理期间新增的印象要被识别出来');
  assert.ok(src.includes('replaceMember(chatKey, mem.userId, mem.name, merged)'),
    '写回要用「并回之后」的列表，而不是模型那份整表覆盖');
});

test('㉕ B4：消息已送达后，记账失败不能改判成「发送失败」抛出去', async () => {
  const src = fs.readFileSync('src/onebot/sender.js', 'utf8');
  const at = src.indexOf('finishSend(id, { messageId: data?.message_id });');
  assert.ok(at > 0, '前置条件：找到发送成功后的记账调用');
  const window = src.slice(at, at + 700);
  assert.ok(window.includes('catch (accountingError)'), '记账要单独兜住，不能落进外层的发送失败分支');
  assert.ok(!/catch \(accountingError\)[\s\S]{0,300}throw accountingError/.test(window),
    '兜住之后不能把记账错误再抛出去 —— 那会让模型以为没送达而重发');
});

test('㉖ B4 正解：送达后的记账（appendSelf + onSent）十二条写路径都要被单独兜住', async () => {
  // 上一版只包了 #deliver 里的 finishSend，而复现点是 appendSelf / onSent ——
  // 锚点认证了一个没覆盖复现路径的修复（2026-10-04 全面复审）。这里盯真正的落点。
  // 第六条是 set_group_card（PR#19 合并后补上的，2026-10-05 复审）；
  // 第七条是 sendForwardCard（合并转发卡片，2026-10-07 协议端能力接入）；
  // 第八~十条是 aiVoice / groupFile / albumPhoto（QQ 原生语音、群文件、群相册上传 ——
  // 2026-10-07 复审 P2 把三条从"直接 onebot.call"收进发送队列，同款兜底一并补上）；
  // 第十一条是 sendImage（生图按普通图片发送，issue #67）。
  // 第十二条是 privateTextFile（当前私聊的纯文本资料）。
  const src = fs.readFileSync('src/onebot/sender.js', 'utf8');
  assert.match(src, /#afterSent\(run\) \{/, '要有「送达后记账」的统一兜底');
  const wrapped = (src.match(/this\.#afterSent\(\(\) => \{/g) || []).length;
  assert.equal(wrapped, 12, `文本/贴纸/语音/拍一拍/表情/改群名片/转发卡片/QQ语音/群文件/群相册/普通图片/私聊文本文件 十二条写路径都要包（实际 ${wrapped}）`);
  // 每处包里必须真的同时含 appendSelf 与 onSent
  // 每处包里必须真的同时含 appendSelf 与 onSent（按出现位置取窗口：花括号嵌套正则不可靠）
  let from = 0;
  for (let i = 0; i < wrapped; i += 1) {
    const at = src.indexOf('this.#afterSent(() => {', from);
    const win = src.slice(at, at + 700);
    assert.ok(win.includes('appendSelf'), `第 ${i + 1} 处没含 appendSelf`);
    assert.ok(win.includes('onSent'), `第 ${i + 1} 处没含 onSent`);
    from = at + 1;
  }
  // 兜底里绝不能再把记账错误抛出去
  const helper = src.slice(src.indexOf('#afterSent(run) {'), src.indexOf('#afterSent(run) {') + 420);
  // 任意 throw 都算违规（正则别写窄成 \w*error —— 将来改名叫 err/e 就漏了）
  assert.ok(!/throw\s/.test(helper), '兜住之后不能把记账错误再抛出去（那会让模型重发 → 重复消息）');
});

test('㉗ R1：feed 路径中止早退要把 acting 退回 unread（与 reply 路径同口径）', async () => {
  const src = fs.readFileSync('src/features/qzone-interactions.js', 'utf8');
  const feed = src.slice(src.indexOf('for (const action of plan.feedActions) {'));
  // feed 循环把 status 置 'acting' 在**等待之前**，所以中止早退必须显式退回 unread；
  // acting → unknown 的回收只在构造时那段恢复里，运行期无人回收 → 卡住既不重试也不上报。
  const resets = (feed.match(/item\.status = 'unread';/g) || []).length;
  assert.ok(resets >= 2, `feed 的两处等待后早退都要退回 unread（实际 ${resets}）`);
});

// ── 第十一轮（自查）：两路独立审查的发现 ──

test('㉘ P1：feed 的 like_comment 组合动作，评论已成功后点赞中止不许退回 unread', async () => {
  const src = fs.readFileSync('src/features/qzone-interactions.js', 'utf8');
  // 点赞阶段的早退里必须有「评论已发过就不退回」的分支
  const likeStart = src.indexOf("if (wantsLike && !item.post.isLiked) {");
  const likeBody = src.slice(likeStart, likeStart + 1400);
  assert.ok(likeBody.includes("item.commentStatus === 'done'"),
    '点赞阶段中止要先看评论发没发过 —— like_comment 里评论已 done 时退回 unread，'
    + '下轮会重新决策并重复评论（commentContent 还被抹掉）');
  assert.ok(likeBody.includes("item.status = 'reviewed';"),
    '评论已发过 → 置 reviewed 保住成果（点赞丢了就丢了，低价值不会重复）');
});

test('㉙ P1：resolveHeld 的清理必须带 run_id 条件，不许按 chat_key 无差别删', async () => {
  // 真行为在 store.test.mjs（「清残骸但绝不碰在途租约的证据」）。这里只钉两条语义：
  // ① 清理语句必须触及 run_id；② 排除集按 runs 的租约状态判（非终态=在途）。
  // 写法上允许 NOT IN ('held','failed','acked') 或 state='leased' 两种等价形态。
  const src = fs.readFileSync('src/core/store.js', 'utf8');
  const start = src.indexOf('  resolveHeld(chatKey) {');
  assert.ok(start > 0, '前置条件：找得到 resolveHeld');
  // 同 ㉒：剥注释再匹配，别让锚点被注释里的同款文本满足（2026-10-05 全审）
  const body = src.slice(start, start + 2600).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ');
  const delAt = body.indexOf('DELETE FROM outbox');
  assert.ok(delAt > 0, '前置条件：找得到 outbox 清理语句');
  const del = body.slice(delAt, delAt + 400);
  assert.match(del, /run_id/,
    '清理要带 run_id 条件：按 chat_key 无差别删会删掉在途租约的证据 —— 该运行随后可重试收尾时 '
    + 'hasEffects=false → 整批消息回 pending 重跑 → 群里重复发言');
  assert.ok(/state\s+NOT\s+IN\s*\(\s*'held'\s*,\s*'failed'\s*,\s*'acked'/.test(del)
    || /state\s*=\s*'leased'/.test(del),
  '排除集要按 runs 里的租约状态判定（非终态 = 仍在途），不能靠别的字段绕过去');
});

test('㉚ P2：extraBody 提交里的 hasXxx 占位要回填成服务端真值（用户改了别的字段再保存）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = {
      ...cfg.api, baseUrl: 'https://api.example/v1',
      extraBody: { normal: 'ok', authorization: { scheme: 'Bearer', value: 'sk-AUTH-REAL' } }
    };
  });
  const view = (await request('/api/config')).body;
  assert.equal(view.api.extraBody.hasAuthorization, true, '前提：视图里是占位');
  // 用户改了 normal 字段（提交内容 ≠ 脱敏形态 → 逐字守卫不删），占位仍留在提交里
  const submitted = { normal: 'changed', hasAuthorization: true };
  assert.equal((await request('/api/config', {
    method: 'POST', body: { api: { baseUrl: 'https://api.example/v1', extraBody: { __replace__: submitted } } }
  })).status, 200);
  const after = disk().api.extraBody;
  assert.deepEqual(after.authorization, { scheme: 'Bearer', value: 'sk-AUTH-REAL' },
    '占位必须换回服务端真值（光靠"逐字相同→没改"守卫罩不住这个场景）');
  assert.equal('hasAuthorization' in after, false, '占位不许落盘（会以最高优先级并进每次模型请求）');
  assert.equal(after.normal, 'changed', '用户改的其它字段照常生效');
});

test('㉚b P2：用户在同一份提交里填了新 Key —— 真值优先，不能被旧值回填顶掉', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = {
      ...cfg.api, baseUrl: 'https://api.example/v1',
      extraBody: { normal: 'ok', authorization: { scheme: 'Bearer', value: 'sk-OLD' } }
    };
  });
  // 视图里没有 authorization（脱敏是整条删除 + hasAuthorization 标记），用户照着补了个新的
  const submitted = { normal: 'ok', authorization: { scheme: 'Bearer', value: 'sk-NEW' }, hasAuthorization: true };
  assert.equal((await request('/api/config', {
    method: 'POST', body: { api: { baseUrl: 'https://api.example/v1', extraBody: { __replace__: submitted } } }
  })).status, 200);
  const after = disk().api.extraBody;
  assert.deepEqual(after.authorization, { scheme: 'Bearer', value: 'sk-NEW' },
    '无条件回填服务端旧值会把刚填的新 Key 悄悄丢掉（用户以为换了 Key，其实还是旧的）');
  assert.equal('hasAuthorization' in after, false, '占位不许落盘');
});

test('㉛ P2：extraBody 清空不受回填影响（用户真要清掉整段）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = { ...cfg.api, extraBody: { authorization: { value: 'sk-X' } } };
  });
  await request('/api/config', {
    method: 'POST', body: { api: { baseUrl: 'x', extraBody: { __replace__: {} } } }
  });
  assert.deepEqual(disk().api.extraBody, {}, '清空要生效（回填只针对占位键，不针对空对象）');
});

test('㉜ P2：预算闸门不吞到点提醒（markFired 在派发后才跑，必须先在派发前挡住）', async () => {
  // 行为用例在 orchestrator.test.mjs（顺延 + 反向"没超预算照样派发"）。这里防的是
  // 「把预检整段删掉」这类改动：只看 fireDueReminders 的语义点，不钉变量名/写法。
  const src = fs.readFileSync('src/core/orchestrator.js', 'utf8');
  const start = src.indexOf('fireDueReminders() {');
  assert.ok(start > 0, '前置条件：找得到 fireDueReminders');
  let end = src.indexOf('\n  }', start);
  if (end < 0 || end - start > 8000) end = start + 8000;
  const body = src.slice(start, end).replace(/\s+/g, ' ');
  assert.match(body, /#budgetWouldDrop\(/,
    '派发前要先算「这次唤醒会不会被预算闸门丢掉」（判据在 #budgetWouldDrop）');
  assert.match(body, /reminders\.deferTo\(/,
    '预算挡下的提醒要顺延到点时间，不然 12 小时作废窗口一过就真丢了');
  const deferAt = body.indexOf('deferTo(');
  const firedAt = body.indexOf('markFired(');
  assert.ok(firedAt > deferAt,
    '标记已触发只能发生在真正派发之后（被预算挡下时不许顺带 markFired）');
});

test('㉝ P2：两个 load 函数的 catch 也要过 token 守卫（过期失败不许盖掉新结果）', async () => {
  const src = fs.readFileSync('ui/app.js', 'utf8');
  for (const [fn, token] of [['loadIdentityFeaturePage', 'identityLoadToken'], ['loadIncidentFeaturePage', 'incidentLoadToken']]) {
    const start = src.indexOf(`async function ${fn}(`);
    const body = src.slice(start, src.indexOf('\n}', start));
    const catchAt = body.indexOf('catch (error) {');
    assert.ok(catchAt >= 0, `${fn} 要有 catch 分支`);
    assert.ok(body.slice(catchAt).includes(`if (token !== state.${token}) return;`),
      `${fn} 的 catch 分支同样要判序号：重叠加载时旧请求在新的渲染成功之后才失败，`
      + '「读取失败」会把后发的好结果整个盖掉');
  }
});

test('㉞ P3：记忆整理要先给"期间新增的"留配额（否则整批并不进去还虚报日志）', async () => {
  const src = fs.readFileSync('src/core/orchestrator.js', 'utf8');
  // 现在 fixed 还先装了手工印象（issue #55），所以配额基准是 fixed.length 而不是 appendedDuring.length。
  assert.match(src, /const fixed = \[\.\.\.manualContents\];/,
    '手工印象必须先占位，不能被模型输出挤掉');
  assert.match(src, /const room = Math\.max\(0, maxKeep - fixed\.length\);/,
    'clean 之前已 slice 到 maxKeep，先满再并一条都进不去（2026-10-04 复审 P3）');
  assert.match(src, /mergedCount \+= 1;/, '日志要按实际并回数打，不能按 appendedDuring.length 虚报');
});

test('㉟ P2：前端"解析失败→原样回传视图"（非 __replace__）同样不许把 hasXxx 落盘', async (t) => {
  // ui/pages/settings-save.js 的 extraBody/thinkingParams 在 JSON 非法或填了数组时
  // `return c.api.extraBody`（注释写的是"保留原值"）—— 这个形态不带 __replace__。
  // 服务端把它当成"视图原样回传 → 整项没改"，但早先那版的快速路径会把脱敏视图 clone 进
  // patch，等于把 hasXxx 占位**落盘**；之后每次模型请求都被 Object.assign(body, extraBody)
  // 带上（2026-10-05 复审真机探针实测：盘上出现 hasAuthorization:true）。
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = {
      ...cfg.api, baseUrl: 'https://api.example/v1',
      extraBody: { normal: 'ok', authorization: { scheme: 'Bearer', value: 'sk-REAL' } }
    };
  });
  const view = (await request('/api/config')).body;
  assert.equal(view.api.extraBody.hasAuthorization, true, '前提：视图里是占位');
  const echoed = JSON.parse(JSON.stringify(view.api.extraBody));   // 用户没改这个框
  assert.equal((await request('/api/config', {
    method: 'POST', body: { api: { baseUrl: 'https://api.example/v1', extraBody: echoed } }
  })).status, 200);
  const after = disk().api.extraBody;
  assert.deepEqual(after.authorization, { scheme: 'Bearer', value: 'sk-REAL' },
    '原样回传 = 这个框没改：真值要留住');
  assert.equal(after.normal, 'ok', '框里的内容照常保留');
  assert.equal(JSON.stringify(after).includes('hasAuthorization'), false,
    '占位不许落盘（会被 Object.assign 并进每次模型请求体）');
});

test('㊱ P2：extraBody 数组元素里的密钥键也要回填（否则 __replace__ 会把真 Key 静默删掉）', async (t) => {
  // 脱敏会递归数组元素（secret-keys.js），数组元素里也只剩 hasXxx；而 unmaskSubmitted
  // 早先对数组直接原样返回 → __replace__ 整段替换时真 Key 被删掉、占位落盘
  //（2026-10-05 复审真机探针实测）。
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = {
      ...cfg.api, baseUrl: 'https://api.example/v1',
      extraBody: { normal: 'ok', headers: [{ authorization: 'Bearer sk-X' }] }
    };
  });
  const view = (await request('/api/config')).body;
  assert.deepEqual(view.api.extraBody.headers, [{ hasAuthorization: true }], '前提：数组元素里也只剩占位');
  const submitted = JSON.parse(JSON.stringify(view.api.extraBody));
  submitted.other = 'changed';   // 用户改了别处，数组原样带回
  assert.equal((await request('/api/config', {
    method: 'POST', body: { api: { baseUrl: 'https://api.example/v1', extraBody: { __replace__: submitted } } }
  })).status, 200);
  // ⚠️ 只断言相关字段，不 deepEqual 整个 extraBody：console 的 updateConfig 是深合并，
  // 同一文件里前一条用例留下的键会带进本用例（2026-10-05 实测：整对象断言会假红）。
  const after = disk().api.extraBody;
  assert.deepEqual(after.headers, [{ authorization: 'Bearer sk-X' }],
    '数组元素里的真 Key 要按元素回填回来');
  assert.equal(after.other, 'changed', '用户改的其它字段照常生效');
  assert.equal(JSON.stringify(after).includes('hasAuthorization'), false, '占位不许落盘');
});

test('㊲ P3：#wake 与派发预检的「这批未读里有没有 @」必须用同一窗口', async () => {
  // 50 vs 100 的偏差（2026-10-05 复审）：@ 落在第 51–100 条时，派发预检判"会丢"而
  // #wake 照常派发 → 到点提醒被无谓顺延 24 小时。行为用例在 orchestrator.test.mjs
  //（「@ 落在第 51–100 条未读里时 degrade 不会丢这次唤醒」）；这里防止窗口被改小。
  // 2026-10-06 复审收口：四处判定口统一走 #unreadScanLimit()（= max(100, batchLimit)，
  // 与 claimUnread 的领取窗口对齐）—— batchLimit 调大后窗口跟着走，比固定 100 更强。
  const src = fs.readFileSync('src/core/orchestrator.js', 'utf8');
  // ⚠️ 匹配前**必须剥注释**：函数头注释里就写着 `peekUnread(chatKey, 100)`，
  // 不剥的话把代码窗口改成 50、注释不动，这条锚点照样绿（2026-10-05 全审实测的假绿）。
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const regions = {
    '派发预检 #budgetWouldDrop': ['#budgetWouldDrop(chatKey) {', 1000],
    'degrade 闸门 #wake': ['if (!proactive) {', 500],
    'pacing 的 @ 例外': ['if (this.#pacingApplies(chatKey)) {', 500],
    '#predictTier 的未读扫描': ['#predictTier(chatKey, { roll } = {}) {', 500]
  };
  for (const [name, [anchor, span]] of Object.entries(regions)) {
    const at = src.indexOf(anchor);
    assert.ok(at > 0, `前置条件：找得到 ${name}`);
    assert.match(stripComments(src.slice(at, at + span)), /peekUnread\(chatKey, this\.#unreadScanLimit\(\)\)/,
      `${name} 要走 #unreadScanLimit()（≥ claimUnread 的 batchLimit，看少了会把 @ 漏判）`);
  }
});
