import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createActionStore } from '../src/admin/actions.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-actions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function make(t, clock) {
  const dir = tempDir(t);
  const store = createActionStore({ dataDir: dir, now: () => clock.value });
  return { dir, store };
}

const base = () => ({
  actor: '10001',
  targets: ['group:433397830'],
  items: [{ type: 'text', text: 'hello' }]
});

test('动作创建：6 位确认码，落盘后可读，且不存明文码', (t) => {
  const clock = { value: 1_700_000_000_000 };
  const { dir, store } = make(t, clock);
  const { action, code } = store.create(base());
  assert.match(code, /^\d{6}$/);
  assert.equal(action.state, 'pending');
  assert.equal(store.findByCode(code, '10001')?.id, action.id);
  const raw = fs.readFileSync(path.join(dir, 'admin-actions.json'), 'utf8');
  assert.doesNotMatch(raw, new RegExp(code), '确认码不能明文落盘');
  assert.equal(store.listPending().length, 1);
});

test('确认码错误累计尝试，超限取消；正确码进入 executing', (t) => {
  const clock = { value: 1_700_000_000_000 };
  const { store } = make(t, clock);
  const created = store.create(base());
  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => store.confirm(created.action.id, '000000', '10001'), /确认码不正确/);
  }
  assert.throws(() => store.confirm(created.action.id, '000000', '10001'), /错误次数过多/);
  assert.equal(store.get(created.action.id).state, 'cancelled');
});

test('确认码过期后不能再确认；pending 列表会清理', (t) => {
  const clock = { value: 1_700_000_000_000 };
  const { store } = make(t, clock);
  const created = store.create({ ...base(), ttlMs: 30_000 });
  clock.value += 31_000;
  assert.equal(store.listPending().length, 0);
  assert.throws(() => store.confirm(created.action.id, created.code, '10001'), /已过期/);
  assert.equal(store.get(created.action.id).state, 'expired');
});

test('进程重启：executing 变 unknown，绝不自动重发；终态 last 可查', (t) => {
  const clock = { value: 1_700_000_000_000 };
  const { dir, store } = make(t, clock);
  const created = store.create(base());
  store.confirm(created.action.id, created.code, '10001');
  assert.equal(store.get(created.action.id).state, 'executing');
  const reopened = createActionStore({ dataDir: dir, now: () => clock.value });
  assert.equal(reopened.get(created.action.id).state, 'unknown');
  reopened.finish(created.action.id, { state: 'sent', results: {} });
  assert.equal(reopened.last('10001').id, created.action.id);
});

test('执行中的动作不能被“取消”假成功（发送循环没有中断点）', (t) => {
  const clock = { value: 1_700_000_000_000 };
  const { store } = make(t, clock);
  const created = store.create(base());
  store.confirm(created.action.id, created.code, '10001');
  assert.throws(() => store.cancel(created.action.id, '10001'), /已开始发送/);
  assert.equal(store.get(created.action.id).state, 'executing');
});

test('同一时间只允许一个待确认动作，避免短码/内容被悄悄替换', (t) => {
  const clock = { value: 1_700_000_000_000 };
  const { store } = make(t, clock);
  store.create(base());
  assert.throws(() => store.create({ ...base(), items: [{ type: 'text', text: 'second' }] }), /已有一个待确认/);
});
