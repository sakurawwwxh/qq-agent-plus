// 插件写操作 journal：准入/结算/崩溃恢复必须是"一次落盘"的原子语义。
// 核心不变量：宁可留下 unknown 等人工核对，也不自动退款/重试（评论弹幕没有幂等键）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rmDirBestEffort } from './helpers/cleanup.mjs';

const {
  admitWrite, settleWriteOp, recoverWriteOps, resolveWriteOp, listWriteOps,
  grantApproval, checkApproval, refundApproval, revokeApproval, requestPendingApproval, approvePendingApproval,
  rejectPendingApproval, clearPluginGrants, resetPluginGrants, listPendingApprovals
} = await import('../src/plugins/grants.js');

function makeDir(t, label = 'journal-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qq-plugin-${label}`));
  t.after(() => rmDirBestEffort(dir));
  return dir;
}

const stateOf = (dir, id = 'p') => JSON.parse(
  fs.readFileSync(path.join(dir, 'plugin-grants', `${id}.json`), 'utf8')
);

test('准入原子性：floor/批准/配额都通过才同时扣减并写 journal', (t) => {
  const dir = makeDir(t);
  grantApproval(dir, 'p', 'write', { target: 'A', preview: 'hello', uses: 2, ttlMs: 60_000 });
  const admitted = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 60_000
  });
  assert.equal(admitted.admitted, true);
  assert.match(admitted.opId, /^wo_[a-f0-9]+$/);
  const state = stateOf(dir);
  assert.equal(state.approvals[0].usesLeft, 1, '批准扣一次');
  assert.equal(state.quota.counts.write, 1, '配额加一次');
  assert.ok(state.lastWriteAt > 0, 'floor 落盘');
  assert.equal(state.writeOps[admitted.opId].state, 'admitted');
  assert.equal(state.writeOps[admitted.opId].approval.receipt.target, 'A');
  assert.equal(listWriteOps(dir, 'p', { state: 'admitted' }).length, 1);
});

test('无目标的动作级批准不能被带 actionTarget 的工具当通配通行证', (t) => {
  const dir = makeDir(t);
  grantApproval(dir, 'p', 'like', { target: '', preview: 'hello', uses: 1, ttlMs: 60_000 });
  const denied = checkApproval(dir, 'p', 'like', {
    target: 'victim', preview: 'hello', requireTarget: true
  });
  assert.equal(denied.approved, false, '空目标批准不能匹配具体目标');
  const admission = admitWrite(dir, 'p', 'like', {
    target: 'victim', preview: 'hello', requireTarget: true, quotaLimit: 10, floorMs: 0
  });
  assert.equal(admission.admitted, false);
  assert.equal(admission.needsApproval, true);
  // 动作级工具自己仍可使用动作级批准。
  assert.equal(checkApproval(dir, 'p', 'like', { target: '', preview: 'hello' }).approved, true);
});

test('配额不足不扣批准；floor 不足不扣任何东西', (t) => {
  const dir = makeDir(t);
  grantApproval(dir, 'p', 'write', { target: 'A', preview: 'hello', uses: 1 });
  const noQuota = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 0, floorMs: 0
  });
  assert.equal(noQuota.admitted, false);
  assert.equal(noQuota.quotaExceeded, true);
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'A', preview: 'hello' }).approved, true,
    '被配额挡住时批准必须原封不动');

  const first = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 60_000
  });
  assert.equal(first.admitted, true);
  grantApproval(dir, 'p', 'write', { target: 'B', preview: 'hello', uses: 1 });
  const floored = admitWrite(dir, 'p', 'write', {
    target: 'B', preview: 'hello', quotaLimit: 3, floorMs: 60_000
  });
  assert.equal(floored.admitted, false);
  assert.equal(floored.rateLimited, true);
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'B', preview: 'hello' }).approved, true,
    'floor 拒绝不能烧批准');
});

test('结算 failed/skipped：一次落盘退批准与配额，重复结算不双退', (t) => {
  const dir = makeDir(t);
  grantApproval(dir, 'p', 'write', { target: 'A', preview: 'hello', uses: 1 });
  const admitted = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 0
  });
  assert.equal(settleWriteOp(dir, 'p', admitted.opId, { outcome: 'failed', note: '接口挂了' }), true);
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'A', preview: 'hello' }).approved, true,
    '确定失败要退批准');
  assert.equal(stateOf(dir).quota.counts.write, 0, '确定失败要退配额');
  assert.equal(stateOf(dir).writeOps[admitted.opId].state, 'settled-refunded');
  assert.equal(stateOf(dir).writes[0].outcome, 'failed');

  assert.equal(settleWriteOp(dir, 'p', admitted.opId, { outcome: 'failed' }), false, '重复结算幂等');
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'A', preview: 'hello' }).usesLeft, 1,
    '不能退两次');
  assert.equal(stateOf(dir).quota.counts.write, 0);
});

test('unknown：不退款不重试；人工核对未执行才退', (t) => {
  const dir = makeDir(t);
  grantApproval(dir, 'p', 'write', { target: 'A', preview: 'hello', uses: 1 });
  const admitted = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 0
  });
  assert.equal(settleWriteOp(dir, 'p', admitted.opId, { outcome: 'unknown', note: '超时' }), true);
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'A', preview: 'hello' }).approved, false,
    'unknown 不能退款（否则模型重试会重复写）');
  assert.equal(stateOf(dir).quota.counts.write, 1);
  assert.equal(listWriteOps(dir, 'p', { state: 'unknown' }).length, 1);

  const resolved = resolveWriteOp(dir, 'p', admitted.opId, { executed: false, by: 'admin' });
  assert.equal(resolved.state, 'resolved-refunded');
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'A', preview: 'hello' }).approved, true);
  assert.equal(stateOf(dir).quota.counts.write, 0);

  // 确认已执行：不退款
  grantApproval(dir, 'p', 'write', { target: 'B', preview: 'hello', uses: 1 });
  const second = admitWrite(dir, 'p', 'write', {
    target: 'B', preview: 'hello', quotaLimit: 3, floorMs: 0
  });
  settleWriteOp(dir, 'p', second.opId, { outcome: 'unknown' });
  const done = resolveWriteOp(dir, 'p', second.opId, { executed: true, by: 'admin' });
  assert.equal(done.state, 'resolved-executed');
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'B', preview: 'hello' }).approved, false,
    '确认已执行不能再退批准');
  assert.equal(stateOf(dir).quota.counts.write, 1);
});

test('崩溃恢复：旧 admitted → unknown、不退款、floor 保留、幂等', (t) => {
  const dir = makeDir(t);
  grantApproval(dir, 'p', 'write', { target: 'A', preview: 'hello', uses: 1 });
  const admitted = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 0, now: 1_000_000
  });
  assert.equal(admitted.admitted, true);

  assert.equal(recoverWriteOps(dir, 2_000_000, { now: 2_000_000 }), 1);
  const op = stateOf(dir).writeOps[admitted.opId];
  assert.equal(op.state, 'unknown');
  assert.match(op.note, /重启/);
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'A', preview: 'hello' }).approved, false);
  assert.equal(stateOf(dir).quota.counts.write, 1);
  assert.ok(stateOf(dir).lastWriteAt >= 1_000_000, '恢复后 floor 不能清零');
  assert.equal(recoverWriteOps(dir, 2_000_000, { now: 2_000_000 }), 0, '恢复幂等');
});

test('待批批准幂等：grant 已写但待批未删，重试不重复发通行证', (t) => {
  const dir = makeDir(t);
  const pending = requestPendingApproval(dir, {
    pluginId: 'p', action: 'write', label: '写', target: 'A', preview: 'hello'
  });
  const first = approvePendingApproval(dir, pending.id, { uses: 2, ttlMs: 60_000 });
  assert.equal(first.grant.usesLeft, 2);
  // 模拟"通行证已写、pending 未删"的崩溃现场：把原待批写回队列
  fs.writeFileSync(
    path.join(dir, 'plugin-grants', 'pending.json'),
    JSON.stringify([pending])
  );
  const again = approvePendingApproval(dir, pending.id, { uses: 2, ttlMs: 60_000 });
  assert.equal(again.duplicate, true);
  assert.equal(again.grant.usesLeft, 2, '重试不能把 2 次额度变成 4 次');
  assert.equal(listPendingApprovals(dir).length, 0);
});

test('拒绝待批要撤销已落盘的同源通行证', (t) => {
  const dir = makeDir(t);
  const pending = requestPendingApproval(dir, {
    pluginId: 'p', action: 'write', label: '写', target: 'A', preview: 'hello'
  });
  approvePendingApproval(dir, pending.id, { uses: 2, ttlMs: 60_000 });
  // 模拟"grant 已写、pending 未删"的崩溃现场
  fs.writeFileSync(path.join(dir, 'plugin-grants', 'pending.json'), JSON.stringify([pending]));
  const rejected = rejectPendingApproval(dir, pending.id);
  assert.equal(rejected.revokedGrants, 1);
  assert.equal(checkApproval(dir, 'p', 'write', { target: 'A', preview: 'hello' }).approved, false,
    '拒绝后不能还留着可用通行证');
  assert.equal(listPendingApprovals(dir).length, 0);
});

test('卸载归档 unknown；重置授权保留 unknown 与配额', (t) => {
  const dir = makeDir(t);
  grantApproval(dir, 'p', 'write', { target: 'A', preview: 'hello', uses: 1 });
  const admitted = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 0
  });
  settleWriteOp(dir, 'p', admitted.opId, { outcome: 'unknown' });

  const reset = resetPluginGrants(dir, 'p');
  assert.equal(reset.clearedApprovals, 1);
  assert.equal(stateOf(dir).writeOps[admitted.opId].state, 'unknown', '重置不能丢 unknown');
  assert.equal(stateOf(dir).quota.counts.write, 1, '重置不能清当天配额');

  clearPluginGrants(dir, 'p');
  assert.equal(fs.existsSync(path.join(dir, 'plugin-grants', 'p.json')), false);
  const archive = path.join(dir, 'plugin-grants', 'p.json.unknown.json');
  assert.ok(fs.existsSync(archive), '卸载要把 unknown 归档而不是直接删');
  const saved = JSON.parse(fs.readFileSync(archive, 'utf8'));
  assert.equal(saved.writeOps[admitted.opId].state, 'unknown');
});

test('迟到退款按 grantId 定位：不能加到后来同键的新通行证上', (t) => {
  const dir = makeDir(t);
  const oldGrant = grantApproval(dir, 'p', 'write', {
    target: 'A', preview: 'hello', uses: 2, ttlMs: 60_000
  });
  const admitted = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 0
  });
  assert.equal(admitted.admitted, true);
  const receipt = admitted.approvalReceipt;
  assert.equal(receipt.grantId, oldGrant.grantId);

  // 旧证被管理员撤销后，又批了一张 (动作,目标,预览) 完全相同的新证
  revokeApproval(dir, 'p', 'write', 'A');
  const newGrant = grantApproval(dir, 'p', 'write', {
    target: 'A', preview: 'hello', uses: 1, ttlMs: 60_000
  });
  assert.notEqual(newGrant.grantId, oldGrant.grantId);

  assert.equal(refundApproval(dir, 'p', receipt), true, '退款请求本身成功');
  const current = stateOf(dir).approvals.find((entry) => entry.grantId === newGrant.grantId);
  assert.equal(current.usesLeft, 1, '旧证的迟到退款不能给新证加额度');
});

test('额度耗尽后重新批准：旧 unknown 的迟到退款不能加到新证', (t) => {
  const dir = makeDir(t);
  const oldGrant = grantApproval(dir, 'p', 'write', {
    target: 'A', preview: 'hello', uses: 1, ttlMs: 60_000
  });
  const admitted = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 0
  });
  assert.equal(admitted.admitted, true);
  settleWriteOp(dir, 'p', admitted.opId, { outcome: 'unknown' });
  const newGrant = grantApproval(dir, 'p', 'write', {
    target: 'A', preview: 'hello', uses: 1, ttlMs: 60_000
  });
  assert.notEqual(newGrant.grantId, oldGrant.grantId, '重新批准必须发新证');
  assert.equal(refundApproval(dir, 'p', admitted.approvalReceipt), true);
  const current = stateOf(dir).approvals.find((entry) => entry.grantId === newGrant.grantId);
  assert.equal(current.usesLeft, 1, '旧 unknown 退款不能把新证变成 2 次');
});

test('grants 文件损坏：准入 fail-closed，不生成通配批准', (t) => {
  const dir = makeDir(t);
  fs.mkdirSync(path.join(dir, 'plugin-grants'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin-grants', 'p.json'), '{ broken json');
  const out = admitWrite(dir, 'p', 'write', {
    target: 'A', preview: 'hello', quotaLimit: 3, floorMs: 0
  });
  assert.equal(out.admitted, false);
  assert.equal(out.needsApproval, true);
});
