// 图片生成 Key 的归属（2026-10-01 审查 P1 + P2）：
//
//  P1：存过的 Key 要记着"是给哪家的地址存的"（imageGen.apiKeyHost）。不记的话，
//      "一键切换服务预设"（b97038f 的卖点）换个地址后，旧 Key 会以 Bearer 发给新主机 ——
//      静默事故，只会在别家后台留一条 401 或一笔意外计费。对照 asr 的 apiKeyProvider/apiKeyHost。
//  P2：/api/imagegen/key 在"同域复用模型 Key"时不能回显模型 Key 本体（否则点一次保存就把它
//      固化成 imageGen 自有 Key，"只发给同域"这条守卫从此对它失效）。留空即复用，不需要明文。
//
// 为什么必须"先写 config.json 再 import config.js"：迁移发生在读盘那一刻，
// 与其它用例共享模块实例的测试文件做不到（与 test/asr-credential-binding.test.mjs 同款）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-binding-'));
process.env.QQ_AGENT_DATA_DIR = root;

// 老配置：有 Key、但还没有归属字段（升级前形态）
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  api: { provider: 'deepseek', baseUrl: 'https://gateway.example.com/v1', model: 'm', apiKey: 'model-key' },
  imageGen: {
    enabled: true,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'zhipu-key',
    model: 'cogview-3-flash'
  }
}, null, 2));

const C = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { imageGenKeyStale, resolveImageGenAuth } = await import('../src/llm/image-gen.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, method, urlPath, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, body: parsed });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('读盘时给老配置补上"这把 Key 是给哪家地址存的"', () => {
  const cfg = C.getConfig();
  assert.equal(cfg.imageGen.apiKeyHost, 'open.bigmodel.cn', '按当前地址补记归属');
  assert.equal(imageGenKeyStale(cfg.imageGen, cfg.api), false, '刚补记的当然不算过期');
});

test('换成别家地址后：旧 Key 不生效（不算可用），界面拿得到 keyStale 说明', async (t) => {
  const port = await freePort();
  // 端口必须在 createApp/start 之前写进配置（监听地址是启动时读的）
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  // 控制台的真实形态：/api/config 下发的 imageGen 里**没有** apiKey/apiKeyHost
  // （secret-keys 按字段名删掉），用户一键切换预设后点保存，body 里只有新地址。
  const view = (await request(port, 'GET', '/api/config')).body.imageGen;
  assert.equal('apiKey' in view, false, '前提：下发的配置里没有明文 Key');
  const saved = await request(port, 'POST', '/api/config', {
    imageGen: { ...view, baseUrl: 'https://api.siliconflow.cn/v1' }
  });
  assert.equal(saved.status, 200, saved.text);
  const after = C.getConfig();
  assert.equal(after.imageGen.apiKeyHost, 'open.bigmodel.cn', '发送空 Key 时不能把归属改到新地址');
  assert.equal(after.imageGen.apiKey, 'zhipu-key', '旧 Key 还在配置里（留着，但不生效）');

  // 真正的守卫：适配器拒绝把旧 Key 发到新地址
  const auth = resolveImageGenAuth({ imageGen: after.imageGen, api: after.api, apiKey: after.api.apiKey });
  assert.equal(auth.ok, false, '换地址后旧 Key 不能继续用');
  assert.equal(auth.key, '');

  // 界面拿得到"要重填"的依据
  const cfgRes = await request(port, 'GET', '/api/config');
  assert.equal(cfgRes.status, 200, cfgRes.text);
  assert.equal(cfgRes.body.imageGen.keyStale, true);
  assert.equal(cfgRes.body.imageGen.keyHost, 'open.bigmodel.cn');
  assert.equal(/zhipu-key/.test(cfgRes.text), false, '配置下发里不得出现明文 Key');
});

test('提交新 Key 时记归属（这是"重填一次"的正路）', async (t) => {
  const port = await freePort();
  // 端口必须在 createApp/start 之前写进配置（监听地址是启动时读的）
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const saved = await request(port, 'POST', '/api/config', {
    imageGen: {
      ...C.getConfig().imageGen,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'sf-key-new'
    }
  });
  assert.equal(saved.status, 200, saved.text);
  const after = C.getConfig();
  assert.equal(after.imageGen.apiKey, 'sf-key-new');
  assert.equal(after.imageGen.apiKeyHost, 'api.siliconflow.cn', '归属跟着新地址走');

  const auth = resolveImageGenAuth({ imageGen: after.imageGen, api: after.api, apiKey: after.api.apiKey });
  assert.deepEqual(auth, { ok: true, key: 'sf-key-new', reused: false, error: '' });
});

test('/api/imagegen/key：同域复用时不回显模型 Key（P2）', async (t) => {
  const port = await freePort();
  const cfg = C.getConfig();
  // 清掉自有 Key，改成"与聊天模型同域"：这时才会走复用那条（都在 start 之前设好）
  C.updateConfig({
    server: { ...cfg.server, host: '127.0.0.1', port, token: '' },
    imageGen: { ...cfg.imageGen, baseUrl: 'https://gateway.example.com/v1', apiKey: '', apiKeyHost: '', keys: { __replace__: {} } },
    // 这条测的是"同域复用模型 Key"的手动模式；provider 非空时顶层 apiKey 是旧字段，
    // 按安全口径不能复用（见 resolveApiKey 的回归用例）。
    api: { ...cfg.api, provider: '', baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key' }
  });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const res = await request(port, 'GET', '/api/imagegen/key');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.reused, true, '确实是复用模型 Key 那种情形');
  assert.equal(res.body.apiKey, '', '复用时不回显模型 Key —— 留空即生效，回显会被保存固化成自有 Key');
  assert.equal(/model-key/.test(res.text), false, '响应里不得出现模型 Key 明文');
});

test('老配置"地址留空（跟模型同域）+ 有 Key"：归属落到模型主机，升级不改行为', () => {
  // 空 baseUrl 是最常见的老形态（"跟聊天模型同域"就是它的默认值）。归属记成模型主机，
  // 换地址后照样不生效 —— 但升级那一刻不会突然把一直好用的 Key 判成"要重填"。
  // 迁移发生在读盘那一刻，所以必须换一个数据目录、换一个进程。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-legacy-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    api: { provider: 'deepseek', baseUrl: 'https://gateway.example.com/v1', model: 'm', apiKey: 'model-key' },
    imageGen: { enabled: true, baseUrl: '', apiKey: 'legacy-key', model: 'gpt-image-1' }
  }, null, 2));
  const configUrl = new URL('../src/core/config.js', import.meta.url).href;
  const code = [
    `process.env.QQ_AGENT_DATA_DIR = ${JSON.stringify(dir)};`,
    `const { getConfig } = await import(${JSON.stringify(configUrl)});`,
    'const g = getConfig().imageGen;',
    'console.log(JSON.stringify({ host: g.apiKeyHost, baseUrl: g.baseUrl }));'
  ].join('\n');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.deepEqual(JSON.parse(out.stdout.trim()), { host: 'gateway.example.com', baseUrl: '' });
});

test('保存时剔掉 GET 的派生字段：视图别名 keyHost 不落盘', async (t) => {
  const port = await freePort();
  const cfg = C.getConfig();
  C.updateConfig({
    server: { ...cfg.server, host: '127.0.0.1', port, token: '' },
    imageGen: {
      ...cfg.imageGen,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'zhipu-key',
      apiKeyHost: 'open.bigmodel.cn'
    }
  });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  // 前端形态：GET 的视图整份展开回传（含 keyHost / available / keyStale / hasApiKey）
  const view = (await request(port, 'GET', '/api/config')).body.imageGen;
  assert.equal(view.keyHost, 'open.bigmodel.cn', '前提：GET 确实下发了视图别名 keyHost');
  assert.equal(view.keyStale, false);
  const saved = await request(port, 'POST', '/api/config', { imageGen: { ...view } });
  assert.equal(saved.status, 200, saved.text);

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).imageGen;
  assert.equal('keyHost' in onDisk, false, '视图别名不落盘（真身是 apiKeyHost，两个说法会互相打架）');
  assert.equal('keyStale' in onDisk, false);
  assert.equal('available' in onDisk, false);
  assert.equal(onDisk.apiKeyHost, 'open.bigmodel.cn', '真身还在，归属没被洗掉');
  assert.equal(onDisk.apiKey, 'zhipu-key', 'Key 本身不受影响');
});

test('视图布尔口径 keyHosts 走 migrateConfig 的派生名单：非控制台写入也不落盘', async () => {
  // 控制台的保存块会显式删 keyHosts，但 updateConfig 还有别的调用方（脚本/测试/手写 API）——
  // 派生名单是"所有写入路径的必经口"那条防线（2026-10-02 全量审查：原来只有 asr 的 keySlots 在名单里）
  const cfg = C.updateConfig({ imageGen: { keyHosts: ['evil.example.com'], keyStale: true, keyHost: 'evil.example.com' } });
  assert.equal('keyHosts' in cfg.imageGen, false, 'keyHosts 不该留在配置里');
  assert.equal('keyStale' in cfg.imageGen, false);
  assert.equal('keyHost' in cfg.imageGen, false);
});

test('同一次 POST 里既换模型地址又填图 Key：归属按**新**地址钉（不能钉到改动前的旧主机）', async (t) => {
  const port = await freePort();
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  C.updateConfig({ imageGen: { enabled: true, baseUrl: '', model: 'img-1', apiKey: '', apiKeyHost: '', keys: { __replace__: {} } } });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const saved = await request(port, 'POST', '/api/config', {
    api: { baseUrl: 'https://new-model.example.com/v1', apiKey: 'model-key' },
    imageGen: { baseUrl: '', model: 'img-1', apiKey: 'sk-follow-model' }
  });
  assert.equal(saved.status, 200, saved.text);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(onDisk.imageGen.apiKeyHost, 'new-model.example.com',
    'imageGen 地址留空 = 跟随模型，pin 要用"本次 patch 之后"的模型地址（旧实现用改动前的，钉到 gateway.example.com）');
  assert.equal(onDisk.imageGen.apiKey, 'sk-follow-model');
  assert.deepEqual(Object.keys(onDisk.imageGen.keys || {}), ['new-model.example.com'], '记忆也记在新主机名下');
  // 运行期与保存期同源：按新地址能取到这把我们刚填的 Key（钉错主机时运行期会“要重填”）
  const auth = resolveImageGenAuth({ imageGen: onDisk.imageGen, api: onDisk.api });
  assert.equal(auth.ok, true, auth.error);
  assert.equal(auth.key, 'sk-follow-model');
  assert.equal(imageGenKeyStale(onDisk.imageGen, onDisk.api), false, '钉对了就不该标"要重填"');
});

test('「显示」按钮带上表单里的目标主机：给那个主机存过的，不给当前这家的明文', async (t) => {
  const port = await freePort();
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  C.updateConfig({
    imageGen: {
      enabled: true, baseUrl: 'https://a.example.com/v1', model: 'm',
      apiKey: 'sk-active-a', apiKeyHost: 'a.example.com',
      keys: { __replace__: { 'b.example.com': 'sk-stored-b' } }
    }
  });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const plain = async (q = '') => (await request(port, 'GET', `/api/imagegen/key${q}`)).body.apiKey;
  assert.equal(await plain('?host=b.example.com'), 'sk-stored-b', '表单切到 B → 回显 B 存过的');
  assert.equal(await plain('?host=zzz.example.com'), '', '没存过的主机回空（不许拿 A 的顶上）');
  assert.equal(await plain(), 'sk-active-a', '不带 host = 当前这家（A）');
});

test('整节替换体里的归属钉不算数：按替换体的地址重算（推前复审）', async (t) => {
  const port = await freePort();
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  C.updateConfig({
    imageGen: {
      enabled: true, baseUrl: 'https://a.example.com/v1', model: 'm',
      apiKey: 'sk-a', apiKeyHost: 'a.example.com', keys: { __replace__: {} }
    }
  });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  // 地址指向 A、钉子却写 evil：不重算的话 delete 删不到替换体里的 pin，evil 直接生效
  const saved = await request(port, 'POST', '/api/config', {
    imageGen: {
      __replace__: {
        enabled: true, baseUrl: 'https://a.example.com/v1', model: 'm',
        apiKey: 'sk-a', apiKeyHost: 'evil.example.com'
      }
    }
  });
  assert.equal(saved.status, 200, saved.text);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).imageGen;
  assert.equal(onDisk.apiKeyHost, 'a.example.com', '归属钉由服务端按替换体的地址重算，不认客户端写的');
  assert.equal(Boolean(onDisk.keys?.['evil.example.com']), false, '不许把 Key 记到伪造的主机名下');
});

test('api.__replace__ 里换模型地址：图 Key 的归属跟着**新**地址（推前复审）', async (t) => {
  const port = await freePort();
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  C.updateConfig({ api: { baseUrl: 'https://old-model.example.com/v1' } });
  C.updateConfig({ imageGen: { enabled: true, baseUrl: '', model: 'img-1', apiKey: '', apiKeyHost: '', keys: { __replace__: {} } } });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const saved = await request(port, 'POST', '/api/config', {
    api: { __replace__: { baseUrl: 'https://new-model.example.com/v1', apiKey: 'mk', model: 'm' } },
    imageGen: { baseUrl: '', model: 'img-1', apiKey: 'sk-follow-model' }
  });
  assert.equal(saved.status, 200, saved.text);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(onDisk.api.baseUrl, 'https://new-model.example.com/v1', '前提：替换体生效了');
  assert.equal(onDisk.imageGen.apiKeyHost, 'new-model.example.com',
    'pin 要读替换体里的新模型地址（旧实现读节点层，读不到 → 钉到旧主机）');
  assert.deepEqual(Object.keys(onDisk.imageGen.keys || {}), ['new-model.example.com']);
});

test('整节替换（__replace__）也不能把客户端 keys 写进配置：服务端把自己的映射钉回替换对象', async (t) => {
  const port = await freePort();
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  C.updateConfig({
    imageGen: {
      enabled: true, baseUrl: 'https://a.example.com/v1', model: 'm',
      apiKey: 'sk-a', apiKeyHost: 'a.example.com', keys: { __replace__: {} }
    }
  });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  // deepMerge 的整节替换约定会把我们算好的 keys 丢掉 —— 2026-10-02 全量审查实测的绕过路径
  const saved = await request(port, 'POST', '/api/config', {
    imageGen: {
      __replace__: {
        enabled: true, baseUrl: 'https://a.example.com/v1', model: 'm',
        keys: { 'evil.example.com': 'sk-evil' }
      }
    }
  });
  assert.equal(saved.status, 200, saved.text);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).imageGen;
  assert.equal(Boolean(onDisk.keys?.['evil.example.com']), false, '客户端整节替换里的 keys 必须被忽略');
  assert.equal(onDisk.keys?.['a.example.com'], 'sk-a', '服务端自己的映射被钉回替换对象（切走前的归档没丢）');
});
