// 只用合成正文和假协议端；所有拒绝条件都必须发生在网络写入之前。
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { closeServer, rmDirBestEffort } from './helpers/cleanup.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-private-text-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => rmDirBestEffort(root));
const { SendQueue } = await import('../src/onebot/sender.js');
const { ChatStore } = await import('../src/core/store.js');
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig, getConfig } = await import('../src/core/config.js');
const { buildToolDefs, executeTool, resetPlatformQuotasForTest, platformQuotaUsage } = await import('../src/tools/tools-core.js');
const { platformToolAllowed, privateFileMaxKiB } = await import('../src/core/platform-gates.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');
const { OneBotClient } = await import('../src/onebot/onebot.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { experimentalToolClass } = await import('../src/pilots/experimental-tool-scheduler.js');

let cfg;
beforeEach(() => {
  resetPlatformQuotasForTest();
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.private = ['2'];
  cfg.platform.privateFileSend = true;
  setRuntimeConfig(cfg);
});

function setup(t, call = async () => ({ file_id: 'synthetic-file', message_id: 7 })) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  const calls = [];
  const sent = [];
  const sender = new SendQueue({ store, onebot: { call: async (...args) => {
    calls.push(args);
    return call(...args);
  } }, onSent: (event) => sent.push(event) });
  assert.equal(typeof sender.privateTextFile, 'function');
  const ctx = { kind: 'private', chatId: '2', chatKey: 'private:2', sender, session: {} };
  return { store, sender, calls, sent, ctx };
}

const invoke = (ctx, args) => executeTool(buildToolDefs(), ctx, 'send_private_file', JSON.stringify(args));

test('大小设置：默认 64 KiB，非法值不能变成不限量，硬上限 256 KiB', () => {
  assert.equal(DEFAULT_CONFIG.platform.privateFileMaxKiB, 64);
  for (const raw of [undefined, null, false, true, '', '256', {}, [], 0, -1, NaN, Infinity]) {
    assert.equal(privateFileMaxKiB({ privateFileMaxKiB: raw }), 64);
  }
  for (const [raw, expected] of [[1, 1], [0.5, 1], [64, 64], [128.9, 128], [256, 256], [999999, 256]]) {
    assert.equal(privateFileMaxKiB({ privateFileMaxKiB: raw }), expected);
  }
});

test('大小设置：配置保存路径也归一化，不依赖浏览器输入范围', () => {
  for (const [value, expected] of [[512, 256], [0, 64], [-1, 64], ['unlimited', 64], [128.9, 128], [64, 64]]) {
    updateConfig({ platform: { privateFileMaxKiB: value } });
    assert.equal(getConfig().platform.privateFileMaxKiB, expected);
  }
});

test('大小设置：工具、提示词和真实队列统一使用当前配置', async (t) => {
  const { ctx, calls } = setup(t);
  cfg.platform.privateFileMaxKiB = 128; setRuntimeConfig(cfg);
  const def = buildToolDefs().find((item) => item.name === 'send_private_file');
  assert.ok(def.description.includes('128 KiB'));
  assert.ok(buildSystemPrompt({ persona: cfg.persona, platform: cfg.platform, chatKey: 'private:2' }).includes('128 KiB'));
  const result = await invoke(ctx, { text: '中'.repeat(30000) });
  assert.equal(JSON.parse(result.content).sent, true, result.content);
  assert.equal(calls.length, 1);
  const tooLarge = await invoke(ctx, { text: '中'.repeat(43691) });
  assert.equal(tooLarge.isError, true);
  assert.ok(tooLarge.content.includes('128 KiB'));
  assert.equal(calls.length, 1);
});

test('大小设置：即使手改过大，也只能发送至 256 KiB，边界外零上传', async (t) => {
  const { sender, calls } = setup(t);
  cfg.platform.privateFileMaxKiB = 999999; setRuntimeConfig(cfg);
  await sender.privateTextFile('private:2', { text: 'a'.repeat(256 * 1024) });
  await assert.rejects(async () => sender.privateTextFile('private:2', { text: 'a'.repeat(256 * 1024 + 1) }), /256 KiB/);
  assert.equal(calls.length, 1);
});

test('大小设置：调低后按 UTF-8 字节拒绝，空值和零仍按默认限制', async (t) => {
  const { sender, calls } = setup(t);
  cfg.platform.privateFileMaxKiB = 1; setRuntimeConfig(cfg);
  await sender.privateTextFile('private:2', { text: '中'.repeat(341) });
  await assert.rejects(async () => sender.privateTextFile('private:2', { text: '中'.repeat(342) }), /1 KiB/);
  cfg.platform.privateFileMaxKiB = 0; setRuntimeConfig(cfg);
  await assert.rejects(async () => sender.privateTextFile('private:2', { text: 'a'.repeat(65537) }), /64 KiB/);
  assert.equal(calls.length, 1);
});

test('大小设置：排队期间降低上限，原本合规的文件也必须在上传前重新检查', async (t) => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { sender, calls } = setup(t, async () => { started.resolve(); await gate.promise; return {}; });
  cfg.platform.privateFileMaxKiB = 256; setRuntimeConfig(cfg);
  const first = sender.privateTextFile('private:2', { text: '合成正文' });
  await started.promise;
  const next = sender.privateTextFile('private:2', { text: 'a'.repeat(128 * 1024) });
  const rejected = assert.rejects(next, { code: 'PRIVATE_FILE_SIZE_LIMIT', delivery: 'not_attempted' });
  cfg.platform.privateFileMaxKiB = 64; setRuntimeConfig(cfg);
  gate.resolve(); await first; await rejected;
  assert.equal(calls.length, 1);
});

for (const [code, change] of [
  ['PRIVATE_FILE_DISABLED', () => { cfg.platform.privateFileSend = false; }],
  ['PRIVATE_FILE_PAUSED', () => { cfg.runtime.paused = true; }],
  ['PRIVATE_FILE_MODE_BLOCKED', () => { cfg.runtime.mode = 'observe'; }],
  ['PRIVATE_FILE_ACCESS_DENIED', () => { cfg.deny.private = ['2']; }],
  ['PRIVATE_FILE_INACTIVE', () => { cfg.timeControl = { enabled: true, schedule: { mode: 'custom', windows: [] }, overrides: {} }; }]
]) {
  test(`安全回执：${code} 明确未上传，不暴露原始错误`, async (t) => {
    const { ctx, calls, store } = setup(t);
    change(); setRuntimeConfig(cfg);
    const result = await invoke(ctx, { text: 'synthetic-private-marker' });
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, code);
    assert.equal(result.delivery, 'not_attempted');
    assert.equal(result.autoRetry, false);
    assert.equal(result.reportIncident, false);
    assert.ok(!result.content.includes('synthetic-private-marker'));
    assert.equal(calls.length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  });
}

test('安全回执：限流和待核对写入分别说明原因，没有第二次上传', async (t) => {
  const { ctx, sender, store, calls } = setup(t);
  cfg.send.maxPerMinute = 1; setRuntimeConfig(cfg);
  await sender.privateTextFile('private:2', { text: '合成正文' });
  const rate = await invoke(ctx, { text: '合成正文' });
  assert.equal(rate.errorCode, 'PRIVATE_FILE_RATE_LIMITED');
  assert.equal(rate.delivery, 'not_attempted');
  assert.equal(rate.autoRetry, false);
  const pending = store.beginSend('private:2', 'pending-synthetic-run', { type: 'file', name: 'notes.txt' });
  store.finishSend(pending, { error: 'synthetic unknown', outcome: 'unknown' });
  const held = await invoke(ctx, { text: '合成正文' });
  assert.equal(held.errorCode, 'PRIVATE_FILE_HELD');
  assert.equal(held.delivery, 'not_attempted');
  assert.equal(held.autoRetry, false);
  assert.equal(calls.length, 1);
  assert.equal(platformQuotaUsage().privateFiles.used, 0, '未上传的分支要退还额度');
});

for (const [delivery, failure] of [
  ['failed', () => Object.assign(new Error('synthetic-private-marker'), { outcome: 'failed' })],
  ['unknown', () => new Error('HTTP 502 synthetic-private-marker')]
]) {
  test(`安全回执：协议上传 ${delivery} 不回显原错误，也不建议自动重试`, async (t) => {
    const { ctx, calls, store } = setup(t, async () => { throw failure(); });
    const result = await invoke(ctx, { text: 'synthetic-private-marker' });
    assert.equal(result.delivery, delivery);
    assert.equal(result.errorCode, delivery === 'failed' ? 'PRIVATE_FILE_REJECTED' : 'PRIVATE_FILE_UNCONFIRMED');
    assert.equal(result.autoRetry, false);
    assert.ok(!result.content.includes('synthetic-private-marker'));
    assert.equal(store.db.prepare('SELECT state FROM outbox').get().state, delivery);
    assert.equal(calls.length, 1);
    assert.equal(platformQuotaUsage().privateFiles.used, delivery === 'failed' ? 0 : 1,
      delivery === 'failed' ? '确定未送达退额度' : '结果未知保留额度');
  });
}

test('安全回执：未识别的内部错误使用保守回执，不信任错误码或原始正文', async (t) => {
  const { ctx, calls } = setup(t);
  ctx.sender = { privateTextFile: async () => { throw Object.assign(new Error('synthetic-private-marker'), { code: '__proto__' }); } };
  const result = await invoke(ctx, { text: '合成正文' });
  assert.equal(result.errorCode, 'PRIVATE_FILE_UNCONFIRMED');
  assert.equal(result.delivery, 'unknown');
  assert.equal(result.autoRetry, false);
  assert.equal(platformQuotaUsage().privateFiles.used, 0, '无 code 的内部异常发生在真正上传前，要退还额度');
  assert.ok(!result.content.includes('synthetic-private-marker'));
  assert.equal(calls.length, 0);
});

test('私聊文本文件默认关闭，只有显式 true 且私聊上下文才进入工具表', () => {
  assert.equal(DEFAULT_CONFIG.platform.privateFileSend, false);
  for (const value of [undefined, false, 'true', 1, {}]) {
    assert.equal(platformToolAllowed('send_private_file', { privateFileSend: value }, 'private:2'), false);
  }
  assert.equal(platformToolAllowed('send_private_file', { privateFileSend: true }, 'private:2'), true);
  for (const chatKey of ['', 'group:2', 'private:abc', 'private:2:3']) {
    assert.equal(platformToolAllowed('send_private_file', { privateFileSend: true }, chatKey), false);
  }
  assert.equal(platformToolAllowed('send_private_file', { perGroup: { '2': { privateFileSend: true } } }, 'private:2'), false);
});

test('工具契约只暴露 text/name，写入走有序调度', () => {
  const def = buildToolDefs().find((d) => d.name === 'send_private_file');
  assert.ok(def);
  assert.deepEqual(Object.keys(def.parameters.properties).sort(), ['name', 'text']);
  assert.deepEqual(def.parameters.required, ['text']);
  assert.equal(def.parameters.additionalProperties, false);
  assert.equal(experimentalToolClass('send_private_file'), 'ordered-action');
});

test('发送正文只在内存中编码，目标固定，沿用 outbox 和可见回复记账', async (t) => {
  const { ctx, calls, store, sent } = setup(t);
  const text = '合成资料\n第一行,第二行';
  const result = await invoke(ctx, { text, name: '资料.csv' });
  assert.equal(result.isError, undefined, result.content);
  assert.equal(JSON.parse(result.content).sent, true);
  assert.equal(calls.length, 1);
  const [action, params, timeout] = calls[0];
  assert.equal(action, 'upload_private_file');
  assert.deepEqual(Object.keys(params).sort(), ['file', 'name', 'user_id']);
  assert.equal(params.user_id, 2);
  assert.equal(params.name, '资料.csv');
  assert.equal(Buffer.from(params.file.slice('base64://'.length), 'base64').toString('utf8'), text);
  assert.ok(params.file.startsWith('base64://'));
  assert.equal(timeout, 120000);
  assert.equal(ctx.session.visibleReply, true);
  assert.equal(sent.length, 1);
  const row = store.db.prepare('SELECT state, payload FROM outbox').get();
  assert.equal(row.state, 'sent');
  assert.ok(!row.payload.includes(text));
  assert.ok(!row.payload.includes('base64://'));
});

for (const [label, args] of [
  ['URL', { text: '合成正文', url: 'https://example.invalid/file.txt' }],
  ['协议端路径', { text: '合成正文', file: '/synthetic/settings.json' }],
  ['file URL', { text: '合成正文', url: 'file:///synthetic/settings.json' }],
  ['任意收件人', { text: '合成正文', user_id: 3 }],
  ['另一会话', { text: '合成正文', chatKey: 'private:3' }],
  ['空正文', { text: ' \n\t' }],
  ['非字符串', { text: 42 }],
  ['对象正文', { text: { file: 'synthetic' } }],
  ['缺正文', { name: 'notes.txt' }],
  ['数组参数', ['合成正文']],
  ['超字节上限', { text: '中'.repeat(21846) }],
  ...['../notes.txt', 'a/b.txt', 'a\\b.txt', 'C:notes.txt', '.notes.txt',
    'notes.txt ', 'notes.txt.', 'notes\n.txt', 'notes\u202e.txt', 'CON.txt',
    'LPT1.csv', 'notes.exe', 'notes.pdf', 'notes.txt.exe', 'a'.repeat(121) + '.txt']
    .map((name) => [`文件名 ${JSON.stringify(name)}`, { text: '合成正文', name }])
]) {
  test(`拒绝 ${label}，工具和发送队列都没有协议调用`, async (t) => {
    const { ctx, sender, calls, store } = setup(t);
    const result = await invoke(ctx, args);
    assert.equal(result.isError, true, result.content);
    await assert.rejects(async () => sender.privateTextFile('private:2', args));
    assert.equal(calls.length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
    assert.ok(!ctx.session.visibleReply);
  });
}

test('合法边界：UTF-8 64 KiB、默认名及文本扩展名', async (t) => {
  const { sender, calls } = setup(t);
  await sender.privateTextFile('private:2', { text: 'a'.repeat(65536) });
  assert.equal(calls[0][1].name, 'notes.txt');
  for (const name of ['notes.txt', 'notes.md', 'notes.csv', 'notes.json', '中文.TXT']) {
    await sender.privateTextFile('private:2', { text: '合成正文', name });
    assert.equal(calls.at(-1)[1].name, name);
  }
});

test('路径和 URL 出现在正文里只是文字，绝不作为 file 参数透传', async (t) => {
  const { sender, calls } = setup(t);
  for (const text of ['file:///synthetic/settings.json', '/synthetic/settings.json', 'https://example.invalid/file.txt']) {
    await sender.privateTextFile('private:2', { text });
    assert.equal(calls.at(-1)[1].file, `base64://${Buffer.from(text).toString('base64')}`);
  }
});

test('权限、暂停、关闭开关、取消及非私聊均在写入前拒绝，不能用游戏豁免绕过', async (t) => {
  const { sender, calls } = setup(t);
  for (const mutate of [
    () => { cfg.platform.privateFileSend = false; },
    () => { cfg.runtime.paused = true; },
    () => { cfg.runtime.mode = 'observe'; },
    () => { cfg.deny.private = ['2']; },
    () => { cfg.allow.private = ['3']; }
  ]) {
    const previous = structuredClone(cfg);
    mutate(); setRuntimeConfig(cfg);
    await assert.rejects(async () => sender.privateTextFile('private:2', { text: '合成正文' }, { gameScoped: true }));
    cfg = previous; setRuntimeConfig(cfg);
  }
  for (const key of ['group:2', 'private:abc', 'private:2:3', `private:${Number.MAX_SAFE_INTEGER + 1}`]) {
    await assert.rejects(async () => sender.privateTextFile(key, { text: '合成正文' }));
  }
  await assert.rejects(async () => sender.privateTextFile('private:2', { text: '合成正文' }, { signal: AbortSignal.abort() }), { code: 'PRIVATE_FILE_CANCELLED', delivery: 'not_attempted' });
  assert.equal(calls.length, 0);
});

test('工具执行时重查开关与会话绑定，不能靠绕过工具表调用', async (t) => {
  const { ctx, calls } = setup(t);
  for (const changed of [{ kind: 'group' }, { chatId: '3' }, { chatKey: 'group:2' }]) {
    assert.equal((await invoke({ ...ctx, ...changed }, { text: '合成正文' })).isError, true);
  }
  cfg.platform.privateFileSend = false; setRuntimeConfig(cfg);
  assert.equal((await invoke(ctx, { text: '合成正文' })).isError, true);
  assert.equal(calls.length, 0);
});

test('排队期间撤销权限或开关、取消任务，下一份文件不能发出', async (t) => {
  const { sender, calls } = setup(t);
  for (const mode of ['gate', 'access', 'abort']) {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const started = Promise.withResolvers();
    sender.onebot.call = async (...args) => { calls.push(args); started.resolve(); await blocked; return {}; };
    const first = sender.privateTextFile('private:2', { text: '合成正文一' });
    await started.promise;
    const control = new AbortController();
    const next = sender.privateTextFile('private:2', { text: '合成正文二' }, { signal: control.signal });
    const rejected = assert.rejects(next);
    if (mode === 'gate') cfg.platform.privateFileSend = false;
    if (mode === 'access') cfg.deny.private = ['2'];
    if (mode === 'abort') control.abort();
    setRuntimeConfig(cfg);
    release(); await first; await rejected;
    cfg.platform.privateFileSend = true; cfg.deny.private = []; setRuntimeConfig(cfg);
  }
  assert.equal(calls.length, 3);
});

test('限流沿用发送队列，超过上限不再上传', async (t) => {
  const { sender, calls } = setup(t);
  cfg.send.maxPerMinute = 1; setRuntimeConfig(cfg);
  await sender.privateTextFile('private:2', { text: '合成正文' });
  await assert.rejects(() => sender.privateTextFile('private:2', { text: '合成正文' }), /频率/);
  assert.equal(calls.length, 1);
});

test('每日额度：达到上限后不再上传，回执不写异常面板', async (t) => {
  const { ctx, calls } = setup(t);
  cfg.platform.quotas.privateFilesPerDay = 2; setRuntimeConfig(cfg);
  for (let i = 0; i < 2; i += 1) {
    const result = await invoke(ctx, { text: `合成正文${i}` });
    assert.equal(result.isError, undefined, result.content);
  }
  const third = await invoke(ctx, { text: '合成正文3' });
  assert.equal(third.isError, true);
  assert.match(third.content, /上限（2 个）/);
  assert.equal(third.reportIncident, false);
  assert.equal(calls.length, 2);
  assert.equal(platformQuotaUsage().privateFiles.used, 2);
  assert.equal(platformQuotaUsage().privateFiles.limit, 2);
});

test('参数校验失败只回给模型，不写异常面板', async (t) => {
  const { ctx, calls } = setup(t);
  const result = await invoke(ctx, { text: '合成正文', name: 'notes.exe' });
  assert.equal(result.isError, true);
  assert.equal(result.reportIncident, false);
  assert.equal(calls.length, 0);
  assert.equal(platformQuotaUsage().privateFiles.used, 0, '参数校验失败不占额度');
});

test('每日额度：明确未送达退还，结果未知继续占用', async (t) => {
  let mode = 'failed';
  const { ctx, calls } = setup(t, async () => {
    if (mode === 'failed') throw Object.assign(new Error('synthetic failure'), { outcome: 'failed' });
    if (mode === 'unknown') throw new Error('HTTP 502 synthetic');
    return { file_id: 'synthetic-file', message_id: 7 };
  });
  cfg.platform.quotas.privateFilesPerDay = 1; setRuntimeConfig(cfg);

  const failed = await invoke(ctx, { text: '合成正文' });
  assert.equal(failed.delivery, 'failed');
  assert.equal(platformQuotaUsage().privateFiles.used, 0, '确定未送达要退还额度');

  mode = 'ok';
  const success = await invoke(ctx, { text: '合成正文' });
  assert.equal(success.isError, undefined, success.content);
  assert.equal(platformQuotaUsage().privateFiles.used, 1);

  resetPlatformQuotasForTest();
  mode = 'unknown';
  const unknown = await invoke(ctx, { text: '合成正文' });
  assert.equal(unknown.delivery, 'unknown');
  assert.equal(platformQuotaUsage().privateFiles.used, 1, '结果未知可能已送达，额度不能退回');
  assert.equal(calls.length, 3);
});

test('结果未知不自动重试；后续同租约发送阻断，聊天挂起待核对', async (t) => {
  const { ctx, sender, store, calls } = setup(t, async () => { throw new Error('HTTP 502 Bad Gateway'); });
  store.appendIncoming('private:2', { mid: 1, text: '合成请求', senderId: '2' });
  ctx.session.leaseId = 'synthetic-run';
  const result = await invoke(ctx, { text: '合成正文' });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(store.getChatMeta('private:2').held, 1);
  assert.equal(store.db.prepare('SELECT state FROM outbox').get().state, 'unknown');
  await assert.rejects(() => sender.privateTextFile('private:2', { text: '合成正文' }, { runId: 'synthetic-run' }), { code: 'PRIVATE_FILE_HELD' });
  await assert.rejects(() => sender.privateTextFile('private:2', { text: '合成正文' }), { code: 'PRIVATE_FILE_HELD' });
  await assert.rejects(() => sender.privateTextFile('private:2', { text: '合成正文' }, { runId: 'another-synthetic-run' }), { code: 'PRIVATE_FILE_HELD' });
  assert.equal(calls.length, 1);
  assert.ok(!ctx.session.visibleReply);
});

test('协议端错误不会将正文/base64 回显给模型', async (t) => {
  const text = 'synthetic-content-marker';
  const encoded = Buffer.from(text).toString('base64');
  const { ctx, store } = setup(t, async () => { throw new Error(`rejected ${text} base64://${encoded}`); });
  const result = await invoke(ctx, { text });
  assert.equal(result.isError, true);
  assert.ok(!result.content.includes(text));
  assert.ok(!result.content.includes(encoded));
  const rows = JSON.stringify(store.db.prepare('SELECT * FROM outbox').all());
  assert.ok(!rows.includes(text));
  assert.ok(!rows.includes(encoded));
});

test('确定未送达按 failed 记账，私聊文件也不自动重试', async (t) => {
  const { sender, calls, store } = setup(t, async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  });
  await assert.rejects(() => sender.privateTextFile('private:2', { text: '合成正文' }), /确定未送达/);
  assert.equal(calls.length, 1);
  assert.equal(store.db.prepare('SELECT state FROM outbox').get().state, 'failed');
  assert.equal(store.getChatMeta('private:2').held, 0);
});

test('成功后的本地记账异常不把已发送文件改判失败', async (t) => {
  const { ctx, store, calls } = setup(t);
  store.appendSelf = () => { throw new Error('synthetic accounting failure'); };
  const result = await invoke(ctx, { text: '合成正文' });
  assert.equal(JSON.parse(result.content).sent, true);
  assert.equal(ctx.session.visibleReply, true);
  assert.equal(calls.length, 1);
  assert.equal(store.db.prepare('SELECT state FROM outbox').get().state, 'sent');
});

test('提示词只在私聊且显式启用时介绍纯文本文件能力', () => {
  const prompt = (chatKey, enabled) => buildSystemPrompt({ persona: cfg.persona, selfNickname: '测试机器人',
    platform: { ...cfg.platform, privateFileSend: enabled }, chatKey });
  assert.ok(prompt('private:2', true).includes('send_private_file'));
  assert.ok(!prompt('private:2', false).includes('send_private_file'));
  assert.ok(!prompt('group:2', true).includes('send_private_file'));
});

test('真实 OneBot HTTP 链路只收到当前目标和内存 base64（本机假协议端）', async (t) => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, params: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { file_id: 'synthetic-file' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const { sender } = setup(t);
  sender.onebot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: `http://127.0.0.1:${server.address().port}` });
  await sender.privateTextFile('private:2', { text: '合成资料', name: 'notes.md' });
  assert.deepEqual(calls, [{ path: '/upload_private_file', params: {
    user_id: 2, name: 'notes.md', file: `base64://${Buffer.from('合成资料').toString('base64')}`
  } }]);
});

test('上传中的取消信号传到协议端，未确认的中断保持 unknown 且不重发', async (t) => {
  const started = Promise.withResolvers();
  const { sender, calls, store } = setup(t, async (_action, _params, _timeout, signal) => {
    started.resolve();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const control = new AbortController();
  const promise = sender.privateTextFile('private:2', { text: '合成正文' }, { signal: control.signal });
  const rejected = assert.rejects(promise, /结果未知/);
  await started.promise;
  control.abort();
  await rejected;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], control.signal);
  assert.equal(store.db.prepare('SELECT state FROM outbox').get().state, 'unknown');
});

for (const [chatKey, enabled] of [['private:2', true], ['private:2', false], ['group:1', true]]) {
  test(`编排集成：${chatKey} enabled=${enabled}，工具可见性与回复闭环一致`, async (t) => {
    const { store, sender, calls } = setup(t);
    cfg.allow.groups = ['1'];
    cfg.platform.privateFileSend = enabled;
    cfg.api.model = 'test'; cfg.api.baseUrl = 'https://model.invalid';
    cfg.sticker.enabled = false; cfg.memory.consolidateEnabled = false;
    setRuntimeConfig(cfg);
    const sessions = new SessionRegistry();
    let textSends = 0;
    sender.onebot.sendText = async () => { textSends++; return { message_id: 8 }; };
    const runner = new Orchestrator({ store, sender, sessions, onebot: sender.onebot,
      stickers: {}, memory: { formatForPrompt: () => '' } });
    const oldFetch = globalThis.fetch;
    t.after(async () => { globalThis.fetch = oldFetch; await runner.abortAll(); });
    let requests = 0;
    const available = enabled && chatKey.startsWith('private:');
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tools.some((item) => item.function.name === 'send_private_file'), available);
      requests++;
      const fn = available && requests === 1
        ? { name: 'send_private_file', arguments: JSON.stringify({ text: '合成资料', name: 'notes.txt' }) }
        : { name: 'finish', arguments: JSON.stringify({ summary: '合成用例已处理' }) };
      return Response.json({ choices: [{ message: { tool_calls: [{ id: `synthetic-${requests}`, type: 'function', function: fn }] } }],
        usage: { total_tokens: 10 } });
    };
    store.appendIncoming(chatKey, { mid: 1, text: '请整理为一份文本资料', senderId: '2' });
    await runner.wake(chatKey);
    assert.ok(requests > 0 && requests <= 3);
    assert.notEqual(sessions.listSummaries(1)[0].status, 'error');
    assert.equal(calls.filter(([action]) => action === 'upload_private_file').length, available ? 1 : 0);
    if (available) assert.equal(textSends, 0, '文件已经是可见回复，不应再触发空回复补发');
  });
}
