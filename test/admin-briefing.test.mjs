// 管理员早报（Issue #42）：观察模式/无管理员不跑；正常时私聊管理员并当天去重。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-briefing-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const { AdminBriefingManager } = await import('../src/features/admin-briefing.js');
const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

const OWNER = '123456789';

function rowsFor(chatId, count = 12) {
  // 跨 6 个小时、每个小时 2 条：验证按小时分层抽样
  return Array.from({ length: count }, (_, i) => ({
    mid: `m${chatId}-${i}`,
    ts: Date.now() - (6 - Math.floor(i / 2)) * 3600 * 1000,
    self: false,
    senderId: String(100 + i),
    senderName: `群友${i}`,
    text: `群 ${chatId} 的第 ${i} 条消息`,
    eventKind: 'message'
  }));
}

function fixture({ mode = 'active', owner = OWNER, allow = ['1'], senderResult = null, chats = [] } = {}) {
  fs.rmSync(path.join(root, 'admin-briefing-state.json'), { force: true });
  const stats = { modelCalls: 0, sent: [], targets: [], recentKeys: [] };
  const manager = new AdminBriefingManager({
    store: {
      recent: (chatKey) => { stats.recentKeys.push(chatKey); return rowsFor(String(chatKey).split(':')[1]); },
      listChats: () => ['group:1']
    },
    sender: {
      sendTextBatch: async (chatKey, messages) => {
        stats.targets.push(chatKey);
        stats.sent.push(...messages);
        return senderResult ?? { sent: messages.map((text, i) => ({ text, messageId: i + 1 })), failed: [] };
      }
    }
  });
  updateConfig({
    ...DEFAULT_CONFIG,
    runtime: { ...DEFAULT_CONFIG.runtime, mode },
    allow: { groups: allow, private: [] },
    admin: { ownerUin: owner },
    adminBriefing: { ...DEFAULT_CONFIG.adminBriefing, enabled: true, chats, maxChars: 200 }
  });
  globalThis.fetch = async (url, req) => {
    stats.modelCalls += 1;
    stats.lastPrompt = String(req?.body || '');
    return Response.json({
      choices: [{ message: { content: '昨天群里在聊海边，阿甲那句话挺逗，我看了半天。' } }],
      usage: { total_tokens: 5 }
    });
  };
  return { manager, stats };
}

test('观察模式：早报不调模型也不发', async () => {
  const f = fixture({ mode: 'observe' });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 0);
  assert.equal(f.stats.sent.length, 0);
});

test('没有管理员 QQ：直接跳过，不花钱', async () => {
  const f = fixture({ owner: '' });
  const r = await f.manager.runOnce();
  assert.equal(r.skipped, 'no-admin');
  assert.equal(f.stats.modelCalls, 0);
});

test('正常跑：私聊管理员，样本按小时分散，当天只发一次', async () => {
  const f = fixture();
  const first = await f.manager.runOnce();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(f.stats.targets.length, 1);
  assert.equal(f.stats.targets[0], `private:${OWNER}`, '只私聊管理员，不发群');
  assert.match(f.stats.sent[0], /海边/);
  assert.match(f.stats.lastPrompt, /【group:1/);
  // 分层抽样：6 个小时桶都要有代表，不能只取最新两条
  const hours = new Set(rowsFor('1').map((m) => new Date(m.ts).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false
  })));
  assert.equal(hours.size, 6, '样本应跨 6 个小时');
  for (const hour of hours) {
    assert.ok(f.stats.lastPrompt.includes(`${hour}:`), `缺少 ${hour} 点的样本`);
  }

  const second = await f.manager.runOnce({ skipDone: true });
  assert.equal(second.skipped, 'already-sent-today');
  assert.equal(f.stats.sent.length, 1, '当天不能重复发');
});

test('chats 接受 group: 前缀（控制台写法），且只读被选中的群', async () => {
  const f = fixture({ allow: ['123456789', '987654321'], chats: ['group:123456789'] });
  const r = await f.manager.runOnce();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([...new Set(f.stats.recentKeys)], ['group:123456789'], '没勾选的群不能读');
});

test('发送结果不确定：今天不再自动重试（避免重复私聊），手动触发仍可重试', async () => {
  const f = fixture({ senderResult: { sent: [], failed: [{ error: 'unknown' }] } });
  const first = await f.manager.runOnce();
  assert.equal(first.ok, false);
  const second = await f.manager.runOnce({ skipDone: true });
  assert.equal(second.skipped, 'already-sent-today', '不确定就不能自动重发');
  const manual = await f.manager.runOnce();
  assert.equal(manual.ok, false, '手动触发是明确意图，仍会尝试');
});

test('stop 后模型才返回：不再私聊管理员，也不落 sending/sent', async () => {
  const f = fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    f.stats.modelCalls += 1;
    await gate;
    return Response.json({
      choices: [{ message: { content: '这是一条不该发出去的早报。' } }],
      usage: { total_tokens: 5 }
    });
  };
  const running = f.manager.runOnce();
  for (let i = 0; i < 100 && f.stats.modelCalls === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.stats.modelCalls, 1);
  f.manager.stop();
  release();
  const result = await running;
  assert.equal(result.skipped, 'stopped');
  assert.equal(f.stats.sent.length, 0, '停机后不能再发');
  const stateFile = path.join(root, 'admin-briefing-state.json');
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(!['sending', 'sent'].includes(state.status), `不能留下已发送状态：${state.status}`);
  }
});
