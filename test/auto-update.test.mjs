import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AutoUpdateManager,
  autoUpdatePaths,
  autoUpdatePending,
  consumeAutoUpdateRequest,
  failureDetail,
  readAutoUpdateState,
  writeAutoUpdateState
} from '../src/auto-update.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-auto-update-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(path.join(appDir, '.deployment.json'), JSON.stringify({
    root: appDir,
    data: dataDir,
    node: process.execPath,
    service: 'qq-agent-test',
    updateService: 'qq-agent-test-update'
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let config = {
    admin: { ownerUin: '900001' },
    autoUpdate: {
      enabled: false,
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6,
      networkRetries: 4,
      retryBaseMs: 1500,
      retryMaxMs: 15000,
      connectivityTimeoutSeconds: 20,
      fetchTimeoutSeconds: 300,
      forceHttp11: true,
      disableOnFailure: true
    },
    allow: { private: ['900001'] },
    allowAllWhenEmpty: false
  };
  const systemctlCalls = [];
  const notifications = [];
  const manager = new AutoUpdateManager({
    appDir,
    dataDir,
    config: () => config,
    updateConfig: (patch) => {
      config = {
        ...config,
        ...patch,
        admin: { ...config.admin, ...(patch.admin || {}) },
        autoUpdate: { ...config.autoUpdate, ...(patch.autoUpdate || {}) }
      };
      return config;
    },
    notifyAvailable: () => true,
    notify: async (text, ownerUin) => notifications.push({ text, ownerUin }),
    runSystemctl: (args) => {
      systemctlCalls.push(args);
      return { status: args.includes('is-active') ? 3 : 0, stdout: '', stderr: '' };
    },
    log: () => {}
  });
  return {
    appDir,
    dataDir,
    get config() { return config; },
    setAdmin(ownerUin) { config.admin = { ...config.admin, ownerUin }; },
    setAutoUpdate(patch) { config.autoUpdate = { ...config.autoUpdate, ...patch }; },
    setAllowPrivate(value) { config.allow.private = value; },
    manager,
    systemctlCalls,
    notifications
  };
}

test('updater launch failure disables automation and queues an administrator notice', async (t) => {
  const f = fixture(t);
  f.manager.runSystemctl = (args) => ({
    status: args.includes('is-active') ? 3 : 1,
    stdout: '',
    stderr: 'unit failed'
  });
  f.manager.resume({ ownerUin: '900001', intervalHours: 6 });

  assert.throws(() => f.manager.requestManual(), /unit failed/);
  await f.manager.resumeNotifications();

  const state = readAutoUpdateState(f.dataDir);
  assert.equal(f.config.autoUpdate.enabled, false);
  assert.equal(f.config.admin.ownerUin, '900001');
  assert.equal(state.status, 'failed');
  assert.equal(state.autoDisabled, true);
  assert.equal(state.notification.pending, false);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0].text, /自动更新已停止/);
});

test('launch failure can keep automatic updates enabled by policy', async (t) => {
  const f = fixture(t);
  f.setAutoUpdate({ enabled: true, disableOnFailure: false });
  f.manager.runSystemctl = (args) => ({
    status: args.includes('is-active') ? 3 : 1,
    stdout: '',
    stderr: 'temporary unit failure'
  });

  assert.throws(() => f.manager.requestManual(), /temporary unit failure/);
  await f.manager.resumeNotifications();

  const state = readAutoUpdateState(f.dataDir);
  assert.equal(f.config.autoUpdate.enabled, true);
  assert.equal(state.autoDisabled, false);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0].text, /保持启用/);
});

test('manual update queues the independent systemd updater', (t) => {
  const f = fixture(t);
  const status = f.manager.requestManual();

  assert.equal(status.status, 'queued');
  assert.equal(status.mode, 'manual');
  const request = consumeAutoUpdateRequest(f.dataDir);
  assert.equal(request.version, 1);
  assert.equal(request.mode, 'manual');
  assert.ok(Math.abs(request.requestedAt - status.startedAt) < 1000);
  assert.ok(f.systemctlCalls.some((args) =>
    args.includes('qq-agent-test-update.service') && args.includes('--no-block')));
});

test('已提交未跑完的更新要能被认出来（控制台据此不再重复弹提示）', (t) => {
  const f = fixture(t);
  const stateFile = autoUpdatePaths(f.dataDir).state;
  const writeRaw = (patch) => fs.writeFileSync(stateFile, JSON.stringify({
    ...readAutoUpdateState(f.dataDir),
    ...patch
  }));

  // 点过「立即更新」→ queued：要认出来（不然部署完成前每次刷新都会再弹一次"发现新版本"）
  // 版本号也要记下来：更新器跑到 testing 阶段才会自己写 targetVersion，在那之前
  // 靠版本号比对会一直弹，所以控制台点更新时就把版本一起提交上来。
  f.manager.requestManual({ version: 'v9.9.9' });
  const pending = autoUpdatePending(f.dataDir);
  assert.equal(pending.status, 'queued');
  assert.equal(pending.mode, 'manual');
  assert.equal(pending.version, 'v9.9.9');

  // 不带版本地再提交一次（控制页那条路径）：上一次的版本必须被清掉，
  // 否则前端会拿旧版本跟新提示比对，照样弹
  writeRaw({ status: 'succeeded', targetVersion: 'v0.0.1' });
  f.manager.requestManual();
  assert.equal(autoUpdatePending(f.dataDir).version, '', '没带版本时不能留上一次的');

  // 跑完 / 失败：都不再抑制，失败时得让用户能再点一次
  writeRaw({ status: 'succeeded' });
  assert.equal(autoUpdatePending(f.dataDir), null);
  writeRaw({ status: 'failed' });
  assert.equal(autoUpdatePending(f.dataDir), null);

  // 卡住超过 30 分钟：当成没在跑，别把提示永久压住。
  // 基准是 progressAt（更新器每个阶段写一次，正常更新会一直续期）——
  // 既不能用 updatedAt（"检查新版本"存提示会刷新它），也不能只看 startedAt
  // （慢机器上一轮正常更新就可能超过 30 分钟）。
  writeRaw({
    status: 'deploying',
    targetVersion: 'v9.9.9',
    progressAt: 0,
    startedAt: Date.now() - 31 * 60 * 1000,
    updatedAt: Date.now()
  });
  assert.equal(autoUpdatePending(f.dataDir), null, '最近一次进度超时就该放开');

  // 反过来：跑了 40 分钟但阶段刚推进过（progressAt 新鲜）→ 仍然算"在跑"，别误放开
  writeRaw({
    status: 'deploying',
    targetVersion: 'v9.9.9',
    progressAt: Date.now() - 60 * 1000,
    startedAt: Date.now() - 40 * 60 * 1000
  });
  assert.notEqual(autoUpdatePending(f.dataDir), null, '阶段推进过就不该判成卡住');

  // 还在跑：带上目标版本，前端拿它跟提示里的版本比对
  writeRaw({ status: 'testing', mode: 'scheduled', targetVersion: 'v9.9.9', startedAt: Date.now() });
  assert.deepEqual(
    { status: autoUpdatePending(f.dataDir).status, version: autoUpdatePending(f.dataDir).version },
    { status: 'testing', version: 'v9.9.9' }
  );
});

test('connectivity probe is one-shot, does not require an administrator and never changes enable state', (t) => {
  const f = fixture(t);
  f.setAdmin('');
  f.setAutoUpdate({ enabled: false, nextAction: 'probe' });
  f.setAllowPrivate([]);

  const status = f.manager.requestManual();
  const request = consumeAutoUpdateRequest(f.dataDir);
  assert.equal(request.mode, 'probe');
  assert.equal(status.mode, 'probe');
  assert.equal(status.phase, 'connectivity');
  assert.equal(status.connectivity.status, 'queued');
  assert.equal(f.config.autoUpdate.nextAction, '');
  assert.equal(f.config.autoUpdate.enabled, false);
});

test('status exposes normalized network policy', (t) => {
  const f = fixture(t);
  f.setAutoUpdate({ networkRetries: 99, retryBaseMs: 5, disableOnFailure: false });
  const status = f.manager.status();
  assert.equal(status.networkRetries, 10);
  assert.equal(status.retryBaseMs, 100);
  assert.equal(status.disableOnFailure, false);
  assert.equal(status.forceHttp11, true);
  assert.equal(status.ownerUin, '900001');
});

test('resume and pause persist automatic update state through global admin', (t) => {
  const f = fixture(t);
  f.setAdmin('');
  f.manager.resume({ ownerUin: '900001', intervalHours: 12 });
  assert.equal(f.config.admin.ownerUin, '900001');
  assert.equal(f.config.autoUpdate.enabled, true);
  assert.equal(f.config.autoUpdate.intervalHours, 12);
  assert.equal(readAutoUpdateState(f.dataDir).status, 'idle');

  f.manager.pause();
  assert.equal(f.config.autoUpdate.enabled, false);
  assert.equal(readAutoUpdateState(f.dataDir).status, 'disabled');
});

test('pending deployment failure disables automatic updates and notifies once', async (t) => {
  const f = fixture(t);
  f.manager.resume({ ownerUin: '900001', intervalHours: 6 });
  writeAutoUpdateState(f.dataDir, {
    status: 'failed',
    mode: 'scheduled',
    phase: 'testing',
    targetRevision: 'a'.repeat(40),
    error: 'unit test failed',
    autoDisabled: true,
    notification: {
      pending: true,
      ownerUin: '900001',
      sentAt: 0,
      error: ''
    }
  });

  await f.manager.handlePendingFailure();
  await f.manager.handlePendingFailure();

  assert.equal(f.config.autoUpdate.enabled, false);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].ownerUin, '900001');
  assert.match(f.notifications[0].text, /自动更新已停止/);
  assert.equal(readAutoUpdateState(f.dataDir).notification.pending, false);
  assert.ok(fs.existsSync(autoUpdatePaths(f.dataDir).state));
});

test('更新失败通知：结果未知只记录不重发，确定没发出才保留 pending', async (t) => {
  // 审查抓出来的：beforeWrite 在自动更新这条链路上没人设置 → pending 永远是 false，
  // 于是"确定没发出去"的重试分支是死代码，同时文档承诺的"重连后继续发"也不成立。
  // 现在控制台的 notify 包装在未连接时抛 beforeWrite，这里把两种情形都钉住。
  for (const [caseName, errorPatch, wantPending, wantUnknown] of [
    ['结果未知（发送超时）', {}, false, true],
    ['确定没发出（未连接）', { beforeWrite: true }, true, false]
  ]) {
    const f = fixture(t);
    f.manager.resume({ ownerUin: '900001', intervalHours: 6 });
    f.manager.notify = async () => {
      throw Object.assign(new Error(caseName), errorPatch);
    };
    writeAutoUpdateState(f.dataDir, {
      status: 'failed',
      mode: 'scheduled',
      phase: 'testing',
      targetRevision: 'a'.repeat(40),
      error: 'unit test failed',
      autoDisabled: true,
      notification: { pending: true, ownerUin: '900001', sentAt: 0, error: '' }
    });
    await f.manager.handlePendingFailure().catch(() => {});
    const state = readAutoUpdateState(f.dataDir);
    assert.equal(state.notification.pending, wantPending, `${caseName}：pending 应为 ${wantPending}`);
    assert.equal(Boolean(state.notification.deliveryUnknown), wantUnknown, `${caseName}：deliveryUnknown 应为 ${wantUnknown}`);
  }
});

test('pending failure respects keep-enabled policy and still notifies once', async (t) => {
  const f = fixture(t);
  f.setAutoUpdate({ enabled: true, disableOnFailure: false });
  writeAutoUpdateState(f.dataDir, {
    status: 'failed',
    mode: 'scheduled',
    phase: 'connectivity',
    error: 'GnuTLS recv error (-110)',
    autoDisabled: false,
    notification: {
      pending: true,
      ownerUin: '900001',
      sentAt: 0,
      error: ''
    }
  });

  await f.manager.handlePendingFailure();
  await f.manager.handlePendingFailure();

  assert.equal(f.config.autoUpdate.enabled, true);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0].text, /保持启用/);
  assert.equal(readAutoUpdateState(f.dataDir).notification.pending, false);
});

test('失败通知发送前先落"结果未知"：发送途中崩溃重启不会把同一条再发一遍', async (t) => {
  const f = fixture(t);
  f.manager.resume({ ownerUin: '900001', intervalHours: 6 });
  let midSend = null;
  f.manager.notify = async () => {
    // 发送途中"崩溃"前，落盘状态必须已经是"结果未知"——否则重启 resume 会重发同一条
    midSend = readAutoUpdateState(f.dataDir).notification;
    throw new Error('connection reset');
  };
  writeAutoUpdateState(f.dataDir, {
    status: 'failed', mode: 'scheduled', phase: 'testing', targetRevision: 'b'.repeat(40),
    error: 'unit test failed', autoDisabled: true,
    notification: { pending: true, ownerUin: '900001', sentAt: 0, error: '' }
  });
  await f.manager.handlePendingFailure().catch(() => {});
  assert.ok(midSend, 'notify 应当被调用');
  assert.equal(midSend.pending, false, '发送开始前就该把 pending 落成 false');
  assert.equal(Boolean(midSend.deliveryUnknown), true, '发送开始前就该落"结果未知"');
  const state = readAutoUpdateState(f.dataDir);
  assert.equal(state.notification.pending, false, '结果未知的失败不保留 pending（否则 30 秒定时器会重发）');
  assert.equal(Boolean(state.notification.deliveryUnknown), true);
});

test('currentRevision 以 deployed-revision 为准：状态文件里的旧值不能盖过它', (t) => {
  // 背景（2026-09-29 实测）：线上用未提交的本地树部署（deployed-revision = source-…）时，
  // 控制台"当前版本"却显示成状态文件里记的 4 天前提交 —— 因为 status() 优先用了 state.currentRevision。
  const f = fixture(t);
  writeAutoUpdateState(f.dataDir, {
    status: 'no-update', phase: 'complete', currentRevision: 'c'.repeat(40), lastCheckAt: Date.now()
  });
  assert.equal(f.manager.status().currentRevision, 'c'.repeat(40), '没有部署记录时回落到状态里的值');

  fs.writeFileSync(path.join(f.dataDir, 'deployed-revision'), 'source-20260929T111923Z\n');
  assert.equal(f.manager.status().currentRevision, 'source-20260929T111923Z', '有部署记录时必须显示实际部署的那个');

  fs.writeFileSync(path.join(f.dataDir, 'deployed-revision'), `${'d'.repeat(40)}\n`);
  assert.equal(f.manager.status().currentRevision, 'd'.repeat(40), '提交部署时显示提交号');
});

test('failureDetail：有 TAP 失败项就列失败项，不再拿输出结尾当详情（2026-10-10 事故）', () => {
  const stdout = [
    '# Subtest: some passing test',
    'ok 1 - some passing test',
    '  ---',
    "  type: 'test'",
    '  ...',
    'not ok 1048 - Issue \\#30：pull 阶段才发现没权限（例如 docker info 恰好能过）也要给可执行提示',
    '  ---',
    '  duration_ms: 1.0',
    "  type: 'test'",
    '  error: \'要说清"连 sudo 都试过了"，否则用户会以为没试\'',
    "  code: 'ERR_ASSERTION'",
    '  ...',
    '# Subtest: 女巫兜底/拒绝文案逐条钉住（狼刀未定/没看懂毒谁/不能毒自己/只剩毒药/通用提示）',
    'ok 1339 - 女巫兜底/拒绝文案逐条钉住（狼刀未定/没看懂毒谁/不能毒自己/只剩毒药/通用提示）',
    '  ---',
    "  type: 'test'",
    '  ...',
    '# tests 1452',
    '# pass 1417',
    '# fail 2'
  ].join('\n');
  const detail = failureDetail({ stdout, stderr: '', status: 1 });
  assert.ok(detail.includes('not ok 1048 - Issue'), detail);
  assert.ok(detail.includes('连 sudo 都试过了'), detail);
  assert.ok(detail.includes('# fail 2'), detail);
  assert.ok(!detail.includes('女巫兜底'), '不许再把结尾的无关通过项当详情：' + detail);
  // 没有 TAP 失败行时退回旧口径（stderr 优先）
  assert.equal(failureDetail({ stdout: 'junk tail', stderr: 'real error', status: 1 }), 'real error');
  // YAML 块形式（error: |- 的真实内容在后续缩进行，assert.equal 的 actual/expected 就在这）
  const block = failureDetail({
    stdout: ['not ok 3 - something', '  ---', '  error: |-', '    Expected values to be strictly equal:', '    ', '    15 !== 16', "  code: 'ERR_ASSERTION'", '  ...'].join('\n'),
    status: 1
  });
  assert.ok(block.includes('15 !== 16'), block);
  // describe() 内的失败：TAP 给 not ok 行加缩进（实测 4 空格/层），也要认；同级的下一条要能终止收集
  const nested = [
    '# Subtest: outer',
    '    not ok 1 - nested failing case',
    '      ---',
    '      error: |-',
    '        详情的真实内容',
    "      code: 'ERR_ASSERTION'",
    '    ok 2 - nested passing case'
  ].join('\n');
  const nd = failureDetail({ stdout: nested, status: 1 });
  assert.ok(nd.includes('not ok 1 - nested failing case'), nd);
  assert.ok(nd.includes('详情的真实内容'), nd);
  assert.ok(!nd.includes('nested passing case'), nd);
});
