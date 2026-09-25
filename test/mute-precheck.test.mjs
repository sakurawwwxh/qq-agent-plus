// 群禁言前置检测：#deliver 在发送前查自身 shut_up_timestamp，被禁言时直接报错给模型。
// 背景（2026-09-25 生产实测）：bot 被禁言后仍硬发，协议端返回 result=120 拒发，
// incident 聚成一堆 critical「send group message rejected」，模型不知道原因还会原话重试。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mute-precheck-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime.mode = 'active';
cfg.allow.groups = ['1'];
setRuntimeConfig(cfg);

const nowSec = () => Math.floor(Date.now() / 1000);

it('被禁言时发送直接报「禁言中」，消息不进 outbox', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  let sendCalled = 0;
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({ shut_up_timestamp: nowSec() + 600 }),
      sendText: async () => { sendCalled += 1; return { message_id: 1 }; }
    }
  });
  await assert.rejects(
    () => sender.sendTextBatch('group:1', ['hi']),
    /禁言中/
  );
  assert.equal(sendCalled, 0, '禁言时不应调用协议端发送');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0, '禁言拦截发生在 beginSend 之前，不产生 outbox 记录');
  store.close();
});

it('未禁言时正常发送，且 60 秒内复用缓存不再查询', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  let queryCount = 0;
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => { queryCount += 1; return { shut_up_timestamp: 0 }; },
      sendText: async () => ({ message_id: 1 })
    }
  });
  const r = await sender.sendTextBatch('group:1', ['a', 'b']);
  assert.equal(r.sent.length, 2);
  assert.ok(queryCount >= 1, '至少查询一次');
  const afterFirst = queryCount;
  await sender.sendTextBatch('group:1', ['c']);
  assert.equal(queryCount, afterFirst, '60 秒缓存窗口内不重复查询');
  store.close();
});

it('查询失败不阻塞发送（退化为 QQ 服务端兜底）', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => { throw new Error('bridge down'); },
      sendText: async () => ({ message_id: 1 })
    }
  });
  const r = await sender.sendTextBatch('group:1', ['hi']);
  assert.equal(r.sent.length, 1);
  store.close();
});

it('私聊会话不做禁言检测', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  const cfg2 = structuredClone(DEFAULT_CONFIG);
  cfg2.runtime.mode = 'active';
  cfg2.allow.groups = ['1'];
  cfg2.allow.private = ['200'];
  setRuntimeConfig(cfg2);
  let queryCount = 0;
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => { queryCount += 1; return { shut_up_timestamp: nowSec() + 600 }; },
      sendText: async () => ({ message_id: 1 })
    }
  });
  const r = await sender.sendTextBatch('private:200', ['hi']);
  assert.equal(r.sent.length, 1);
  assert.equal(queryCount, 0, '私聊不应触发群成员查询');
  store.close();
});
