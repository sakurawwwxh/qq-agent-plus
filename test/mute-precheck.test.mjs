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

// ── 以下为合并后的跟进（2026-09-26 审查）──

it('全员禁言：成员信息没标禁言、群信息标了也要拦', async () => {
  // 只查成员信息会漏掉"全员禁言"这种它本来就要拦的情形；两个来源取较晚的截止时间。
  const store = new ChatStore(0, { dataDir: dir });
  let sendCalled = 0;
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({ shut_up_timestamp: 0 }),
      getGroupInfo: async () => ({ group_all_shut: nowSec() + 300 }),
      sendText: async () => { sendCalled += 1; return { message_id: 1 }; }
    }
  });
  await assert.rejects(() => sender.sendTextBatch('group:1', ['hi']), /禁言中/);
  assert.equal(sendCalled, 0);
  store.close();
});

it('禁言错误带 GROUP_MUTED，发送工具据此不进异常面板', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({ shut_up_timestamp: nowSec() + 600 }),
      getGroupInfo: async () => ({}),
      sendText: async () => ({ message_id: 1 })
    }
  });
  const muted = await sender.sendTextBatch('group:1', ['hi']).then(() => null, (e) => e);
  assert.equal(muted?.code, 'GROUP_MUTED');

  const { buildToolDefs } = await import('../src/tools/tools-core.js');
  const send = buildToolDefs().find((tool) => tool.name === 'send_message');
  const ctx = {
    chatKey: 'group:1', kind: 'group', chatId: '1', selfId: '100',
    sender, store,
    session: { leaseId: null, sent: [], id: 's1' },
    signal: undefined,
    emit: () => {}
  };
  const blocked = await send.execute(ctx, { messages: ['hi'] });
  assert.equal(blocked.isError, true);
  assert.match(String(blocked.content), /禁言中/);
  assert.equal(blocked.reportIncident, false, '禁言不该再记 warning 异常');

  // 对照：普通发送失败仍照旧上报异常（别把口子开太大）
  const broken = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({}),
      getGroupInfo: async () => ({}),
      sendText: async () => { throw new Error('bridge down'); }
    }
  });
  const failed = await send.execute({ ...ctx, sender: broken }, { messages: ['hi'] });
  assert.equal(failed.isError, true);
  assert.notEqual(failed.reportIncident, false);
  store.close();
});

it('毫秒级/离谱的禁言时间戳按未禁言处理（宁可漏拦，不可误封）', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  let sendCalled = 0;
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      // 误把毫秒当秒用就等于从此不再发言：这种值必须忽略
      getGroupMemberInfo: async () => ({ shut_up_timestamp: (nowSec() + 600) * 1000 }),
      getGroupInfo: async () => ({}),
      sendText: async () => { sendCalled += 1; return { message_id: 1 }; }
    }
  });
  const r = await sender.sendTextBatch('group:1', ['hi']);
  assert.equal(r.sent.length, 1, '离谱时间戳不拦发送');
  assert.equal(sendCalled, 1);
  store.close();
});

// ── 2026-09-26 独立审查跟进：标志位形态 + 缓存到期 ──

it('全员禁言以标志位（1/true）返回时同样要拦：不能当秒级时间戳比大小', async () => {
  // 生产实测（2026-09-26）：协议端 get_group_info 的 group_all_shut 是 0/1 标志位，
  // 不是秒级时间戳。当时间戳比大小的话 1 <= now → 永远拦不住，退化成"发出后吃 result=120"。
  for (const flag of [1, true, '1']) {
    const store = new ChatStore(0, { dataDir: dir });
    let sendCalled = 0;
    const sender = new SendQueue({
      store,
      onebot: {
        selfId: '100',
        getGroupMemberInfo: async () => ({ shut_up_timestamp: 0 }),
        getGroupInfo: async () => ({ group_all_shut: flag }),
        sendText: async () => { sendCalled += 1; return { message_id: 1 }; }
      }
    });
    await assert.rejects(() => sender.sendTextBatch('group:1', ['hi']), /全员禁言/);
    assert.equal(sendCalled, 0, `标志位 ${flag} 时不该发出去`);
    store.close();
  }
});

it('短禁言到期后不再拦（缓存里存的是"解禁时间"，过期就得重查）', async () => {
  // 旧行为：缓存命中只看"60 秒内查过"，不看解禁时间是否已过 ——
  // 1 分钟级的禁言解除后，仍会被拒最多 60 秒，报的还是已经过去的时间（2026-09-26 审查）。
  const store = new ChatStore(0, { dataDir: dir });
  let sendCalled = 0;
  let memberShut = nowSec() + 1;                 // 1 秒后自动解除
  const sender = new SendQueue({
    store,
    onebot: {
      selfId: '100',
      getGroupMemberInfo: async () => ({ shut_up_timestamp: memberShut }),
      getGroupInfo: async () => ({ group_all_shut: 0 }),
      sendText: async () => { sendCalled += 1; return { message_id: 1 }; }
    }
  });
  await assert.rejects(() => sender.sendTextBatch('group:1', ['hi']), /禁言中/);
  memberShut = 0;                                 // 服务端侧已解除
  await new Promise((r) => setTimeout(r, 1200));
  await sender.sendTextBatch('group:1', ['hi again']);   // 缓存里 untilTs 已过 → 应重新查询并放行
  assert.equal(sendCalled, 1, '到期后应能发出');
  store.close();
});
