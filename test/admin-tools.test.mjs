import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-tools-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { buildToolDefs } = await import('../src/tools/tools-core.js');
const { clearAdminServices, setAdminServices } = await import('../src/admin/index.js');
const { experimentalToolClass } = await import('../src/pilots/experimental-tool-scheduler.js');

const cfg = { admin: { ownerUin: '10001' }, allow: { groups: ['433397830'] }, deny: { groups: [] } };
const ctx = { kind: 'private', chatId: '10001', cfg };

test('管理员工具只在 owner 私聊可见，群聊/普通私聊完全看不到', () => {
  const admin = buildToolDefs({ kind: 'private', chatId: '10001', cfg }).map((tool) => tool.name);
  assert.ok(admin.includes('admin_send'));
  assert.ok(admin.includes('admin_inbox'));
  assert.ok(admin.includes('admin_status'));
  assert.ok(!buildToolDefs({ kind: 'group', chatId: '1', cfg }).some((tool) => tool.name.startsWith('admin_')));
  assert.ok(!buildToolDefs({ kind: 'private', chatId: '20002', cfg }).some((tool) => tool.name.startsWith('admin_')));
  assert.ok(!buildToolDefs().some((tool) => tool.name.startsWith('admin_')));
});

test('调度器把 admin_send 归为写动作，其余归为只读', () => {
  assert.equal(experimentalToolClass('admin_send'), 'ordered-read');
  assert.equal(experimentalToolClass('admin_inbox'), 'parallel-read');
  assert.equal(experimentalToolClass('admin_status'), 'parallel-read');
});

test('admin_send 只创建待确认计划，不直接发送；非 owner 执行被拒绝', async () => {
  const calls = [];
  setAdminServices({
    send: {
      async plan(args) {
        calls.push(args);
        return { preview: 'PREVIEW', action: { id: 'ad_1' }, code: '123456' };
      }
    },
    inbox: { formatList: () => 'INBOX' },
    status: { format: () => 'STATUS' }
  });
  try {
    const defs = buildToolDefs({ kind: 'private', chatId: '10001', cfg });
    const sendDef = defs.find((tool) => tool.name === 'admin_send');
    const result = await sendDef.execute(ctx, { target: '433397830', messages: 'hello' });
    assert.equal(result.isError, false);
    assert.match(result.content, /PREVIEW/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].targetsInput[0], '433397830');
    assert.deepEqual(calls[0].itemsInput, [{ type: 'text', text: 'hello' }]);

    const denied = await sendDef.execute({ kind: 'private', chatId: '20002', cfg }, { target: '1', messages: 'x' });
    assert.equal(denied.isError, true);

    const inboxDef = defs.find((tool) => tool.name === 'admin_inbox');
    assert.equal((await inboxDef.execute(ctx, {})).content, 'INBOX');
    const statusDef = defs.find((tool) => tool.name === 'admin_status');
    assert.equal((await statusDef.execute(ctx, {})).content, 'STATUS');
  } finally {
    clearAdminServices();
  }
});
