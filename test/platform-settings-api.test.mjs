// 控制台「平台能力」页第二批（2026-10-07，设置细化）新增的两个数据源：
//   GET /api/platform/gates       —— 键/标签/工具/默认取向/配额默认（UI 不再手抄一份表）
//   GET /api/platform/quota-usage —— 平台写入闸门的当前用量（"已用 x / 上限 y"）
// 断言都对着 src/core/platform-gates.js 的键表做（同源），而不是抄一份期望值 ——
// 抄一份就失去了"服务端加键、UI 没跟上要红"的意义。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-platform-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { resetPlatformQuotasForTest } = await import('../src/tools/tools-core.js');
const gatesMod = await import('../src/core/platform-gates.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, body });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    req.end();
  });
}

/** 每个用例一个实例（同进程起两个实例时 Windows 上清理会 EPERM，且日志会互相干扰）。 */
async function boot(t, { mutate } = {}) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.allow = { ...cfg.allow, groups: ['433397830'] };
  cfg.onebot = { ...cfg.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: '' };
  mutate?.(cfg);
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    // Windows 上句柄可能还没释放（rm 会 EPERM）—— 清理失败不该让用例判失败
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
  });
  await app.start();
  return { port, app, get: (p, h = {}) => get(port, p, { host: `127.0.0.1:${port}`, ...h }) };
}

test('GET /api/platform/gates：键/标签/工具/默认取向与门控表同源', async (t) => {
  const { get: fetchPath } = await boot(t);
  const res = await fetchPath('/api/platform/gates');
  assert.equal(res.status, 200, res.text);
  const gates = res.body?.gates || [];
  assert.deepEqual(gates.map((g) => g.key), gatesMod.PLATFORM_GATE_KEYS, '顺序与键表一致');
  for (const g of gates) {
    assert.deepEqual(g.tools, gatesMod.PLATFORM_TOOL_GATES[g.key], `${g.key} 的工具清单要与门控表一致`);
    assert.equal(g.defaultOn, !gatesMod.PLATFORM_DEFAULT_OFF.has(g.key), `${g.key} 的默认取向`);
    assert.ok(g.label && g.label !== g.key, `${g.key} 要有中文标签`);
  }
  assert.deepEqual((res.body?.quotas || []).map((q) => q.key), gatesMod.PLATFORM_QUOTA_KEYS, '配额键表');
  for (const q of res.body.quotas) {
    assert.equal(q.default, gatesMod.PLATFORM_QUOTA_DEFAULTS[q.key], `${q.key} 的默认上限`);
  }
  // 一个工具只能归一个键：否则门控判定按"先命中的键"来，后一个键形同虚设
  const allTools = gates.flatMap((g) => g.tools);
  assert.equal(new Set(allTools).size, allTools.length, '一个工具只许归一个门控键');
  // 拆细后的关键断言：读写必须落在不同的键上（同键就失去了"只让它看"的意义）
  assert.ok(gatesMod.PLATFORM_GATE_KEYS.includes('reactions') && gatesMod.PLATFORM_GATE_KEYS.includes('reactionsWrite'));
  assert.ok(!gatesMod.PLATFORM_TOOL_GATES.reactions.includes('react_to_message'));
  assert.ok(gatesMod.PLATFORM_TOOL_GATES.reactionsWrite.includes('react_to_message'));
  assert.ok(gatesMod.PLATFORM_GATE_KEYS.includes('faceWrites'));
  assert.deepEqual(gatesMod.PLATFORM_TOOL_GATES.faceWrites, ['send_face']);
  assert.equal(gatesMod.PLATFORM_GATE_LABELS.faceWrites, '发 QQ 系统表情（小黄脸）');
});

test('GET /api/platform/quota-usage：默认空、消费后可见、上限改小立刻生效', async (t) => {
  resetPlatformQuotasForTest();
  const { get: fetchPath } = await boot(t, {
    mutate: (cfg) => { cfg.platform.quotas = { ...cfg.platform.quotas, reactionsPerHour: 2 }; }
  });
  const { buildToolDefs } = await import('../src/tools/tools-core.js');
  const def = buildToolDefs().find((d) => d.name === 'react_to_message');
  const ctx = {
    kind: 'group', chatId: '1', chatKey: 'group:1',
    session: { id: 's', sent: [], leaseId: 'l' },
    onebot: { reactToMessage: async () => ({}) },
    emit: () => {}
  };

  const before = await fetchPath('/api/platform/quota-usage');
  assert.equal(before.status, 200, before.text);
  assert.equal(before.body?.quotas?.reactions?.used, 0, '还没用过');
  assert.equal(before.body?.quotas?.reactions?.limit, 2, '上限要读配置（不是写死的 30）');
  assert.equal(before.body?.quotas?.avatars?.limit, 1, '没改的项按内置默认');

  const first = JSON.parse((await def.execute(ctx, { messageId: '1', emojiId: '14' })).content);
  assert.equal(first.reacted, true);
  const after = await fetchPath('/api/platform/quota-usage');
  assert.equal(after.body?.quotas?.reactions?.used, 1, '消费一次后用量要看得见');
  assert.deepEqual(after.body?.quotas?.reactions?.chats, [{ chatKey: 'group:1', count: 1 }], '分账到会话');

  const second = JSON.parse((await def.execute(ctx, { messageId: '1', emojiId: '14' })).content);
  assert.equal(second.reacted, true, '第 2 次仍在上限内');
  const third = await def.execute(ctx, { messageId: '1', emojiId: '14' });
  assert.equal(third.isError, true, '到配置的上限就该拒');
  assert.match(third.content, /上限 2 次/, '报错里要带配置的上限值（而不是写死的 30）');
  resetPlatformQuotasForTest();
});
