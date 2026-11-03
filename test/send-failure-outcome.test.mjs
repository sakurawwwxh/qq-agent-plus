// 发送失败的定性：能证明"没送达"的算 failed（可被「重试失败批次」捞回来），
// 可能已经投递的才算 unknown（持有待人工核对）。
//
// 背景（2026-09-23 全项目审查）：以前 outbox 的 outcome 只看 error.outcome，而那只在
// OneBotActionError 上才有；裸 undici 失败（ECONNREFUSED 等）永远落进 unknown ——
// 一次"连接被拒"会被记成 critical 未知写入挂在"待处理"，回复静默丢失且不可重试。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-outcome-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue, classifyTransportFailure } = await import('../src/onebot/sender.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime.mode = 'active';
cfg.allow.groups = ['1'];
setRuntimeConfig(cfg);

const fetchFailure = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

it('classifyTransportFailure：连不上=确定没送达，超时/重置/5xx=结果未知', () => {
  const refused = classifyTransportFailure(fetchFailure('ECONNREFUSED'));
  assert.equal(refused.definite, true);
  assert.equal(refused.uncertain, false);

  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE']) {
    const r = classifyTransportFailure(fetchFailure(code));
    assert.equal(r.definite, false, code);
    assert.equal(r.uncertain, true, code);
  }
  assert.equal(classifyTransportFailure(new Error('HTTP 502 Bad Gateway')).uncertain, true, '协议端 5xx 可能已转发');
  assert.equal(classifyTransportFailure(new Error('Request timeout after 15000ms')).uncertain, true);

  // WS 帧级证据 = 确定未投递：send 回调报错（帧没写进 socket）与发送途中连接被关
  //（帧没写完/压缩中被打断 —— 接收端只拿到残帧会被整帧丢弃）。2026-10-07 复审：这两类
  // 以前既不 definite 也不 uncertain —— "确定没送达"的消息既不重试、还落 unknown 挂人工核对。
  // 文案用 ws 8.x 源码里的真实字符串（node_modules/ws/lib/websocket.js / sender.js）。
  const wsSendFail = new Error('OneBot send_group_msg WS 发送失败: WebSocket is not open: readyState 2 (CLOSING)');
  assert.equal(classifyTransportFailure(wsSendFail).definite, true, 'WS 帧未写出 = 确定未投递');
  const wsMidFrame = new Error('The socket was closed while data was being compressed');
  assert.equal(classifyTransportFailure(wsMidFrame).definite, true, '发送中连接被关 = 残帧必被丢弃');
});

// outbox 的落库状态（记账口径就是它）：failed = 确认没送达、可重试；unknown = 可能已投递、持有待核对。
const outboxState = (store, chatKey) => store.db
  .prepare("SELECT state FROM outbox WHERE chat_key=? ORDER BY rowid DESC LIMIT 1")
  .get(chatKey)?.state;

it('确认未送达的裸 fetch 失败记成 failed（可重试），不占"待核对"', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  const sender = new SendQueue({ store, onebot: { sendText: async () => { throw fetchFailure('ECONNREFUSED'); } } });
  await assert.rejects(() => sender.sendTextBatch('group:1', ['hi']));
  assert.equal(store.getChatMeta('group:1').held, 0, '确定没送达的不该记成未知写入');
  assert.equal(outboxState(store, 'group:1'), 'failed', '要记成 failed，人工「重试失败批次」才捞得回来');
  store.close();
});

it('重试等待中暂停/停止：保留第一次"确定未送达"的定性，不升级成 unknown', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  let calls = 0;
  const sender = new SendQueue({
    store,
    onebot: { sendText: async () => { calls += 1; throw fetchFailure('ECONNREFUSED'); } }
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(() => sender.sendTextBatch('group:1', ['hi'], { signal: controller.signal }));
  assert.equal(calls, 1, '中止后不能再发第二次');
  assert.equal(store.getChatMeta('group:1').held, 0, '确定没送达不能变成待核对');
  assert.equal(outboxState(store, 'group:1'), 'failed');
  store.close();
});

it('结果未知的失败仍记成 unknown（持有待人工核对）', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  const sender = new SendQueue({ store, onebot: { sendText: async () => { throw fetchFailure('ECONNRESET'); } } });
  await assert.rejects(() => sender.sendTextBatch('group:1', ['hi']));
  assert.equal(store.getChatMeta('group:1').held, 1, '可能已投递的要持有，等人工核对');
  assert.equal(outboxState(store, 'group:1'), 'unknown');
  assert.equal(store.listUnknownOperations('group:1').length, 1, '未知写入要出现在待核对清单里');
  store.close();
});
