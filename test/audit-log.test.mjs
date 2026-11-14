// #5 审计日志：落盘脱敏/追加/轮转/截断/分页/旁路语义全测。
// 变异对照：把 prepareValue 里的 redactSecretFields 摘掉（明文用例必红）；
// 把 queryAudit 的 500 上限改成 9999（上限用例必红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { appendAudit, queryAudit, pruneAudit } = await import('../src/core/audit-log.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-'));
const readAll = (dir) => fs.readdirSync(dir).sort()
  .map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');

test('含密钥的载荷落盘后全文无明文，标记 [redacted]', () => {
  const dir = tmp();
  appendAudit({
    dir,
    action: 'config.update',
    target: 'config',
    before: { api: { apiKey: 'sk-secret-abc' }, providerKeys: { p1: 'sk-p1' }, tts: { keys: { siliconflow: 'sk-tts' } } },
    after: { api: { apiKey: 'sk-secret-abc2' }, password: 'hunter2' },
    ok: true
  });
  const text = readAll(dir);
  for (const plain of ['sk-secret-abc', 'sk-p1', 'sk-tts', 'hunter2']) {
    assert.ok(!text.includes(plain), `明文不得落盘：${plain}`);
  }
  assert.ok(text.includes('[redacted]'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('追加写，不覆盖（两次写入 = 两行，顺序保持）', () => {
  const dir = tmp();
  appendAudit({ dir, action: 'a1', ok: true, at: 1700000000000 });
  appendAudit({ dir, action: 'a2', ok: true, at: 1700000001000 });
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).action, 'a1');
  assert.equal(JSON.parse(lines[1]).action, 'a2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('按自然月切文件；pruneAudit 按保留月数删除（dry-run 不删；未来月份不误删）', () => {
  const dir = tmp();
  appendAudit({ dir, action: 'old', ok: true, at: Date.UTC(2026, 0, 15, 12) });    // 2026-01
  appendAudit({ dir, action: 'new', ok: true, at: Date.UTC(2026, 2, 15, 12) });    // 2026-03
  appendAudit({ dir, action: 'future', ok: true, at: Date.UTC(2026, 4, 15, 12) }); // 2026-05（未来）
  assert.deepEqual(fs.readdirSync(dir).sort(),
    ['audit-202601.jsonl', 'audit-202603.jsonl', 'audit-202605.jsonl']);
  const now = Date.UTC(2026, 2, 20, 12);   // 以 2026-03 为"当下"
  const dry = pruneAudit({ dir, keepMonths: 2, now, dryRun: true });
  assert.deepEqual(dry.removed, ['audit-202601.jsonl']);
  assert.ok(fs.existsSync(path.join(dir, 'audit-202601.jsonl')), 'dry-run 不得删文件');
  const real = pruneAudit({ dir, keepMonths: 2, now });
  assert.deepEqual(real.removed, ['audit-202601.jsonl']);
  assert.ok(!fs.existsSync(path.join(dir, 'audit-202601.jsonl')));
  assert.deepEqual(real.kept.sort(), ['audit-202603.jsonl', 'audit-202605.jsonl'], '未来月份保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件权限：目录 0700、文件 0600（win32 跳过）', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  appendAudit({ dir, action: 'perm', ok: true, at: Date.UTC(2026, 5, 5, 12) });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'audit-202606.jsonl')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-10-01 审查（第五轮）：上面那条只覆盖"新建文件"这一条路 —— appendFileSync 的 mode 只在
// 创建时生效，已存在的文件不会被改权限（btrfs/旧版本留下的 0644 会一直留着）。这条锁住兜底 chmod。
// 变异对照：删掉 appendAudit 里的 chmodSync → 本条必红（0644 保持不动）。
test('文件已存在且权限宽松（0644）时追加写会收紧回 0600（win32 跳过）', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const file = path.join(dir, 'audit-202606.jsonl');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '{"action":"pre"}\n');
  fs.chmodSync(file, 0o644);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, '前置条件：文件确实是宽松权限（否则本条测不到东西）');
  appendAudit({ dir, action: 'after-chmod', ok: true, at: Date.UTC(2026, 5, 6, 12) });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '追加写后必须把权限收紧回 0600');
  assert.ok(fs.readFileSync(file, 'utf8').includes('after-chmod'), '内容照常追加（收紧权限不影响写入）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('queryAudit：新→旧分页、before 游标、limit 硬上限 500', () => {
  const dir = tmp();
  const base = Date.UTC(2026, 6, 1, 12);
  for (let i = 0; i < 510; i++) appendAudit({ dir, action: `a${i}`, ok: true, at: base + i * 1000 });
  const cap = queryAudit({ dir, limit: 9999 });
  assert.equal(cap.entries.length, 500, 'limit 硬上限 500（不做全量导出）');
  assert.equal(cap.entries[0].action, 'a509', '新→旧');
  const p1 = queryAudit({ dir, limit: 3 });
  assert.deepEqual(p1.entries.map((e) => e.action), ['a509', 'a508', 'a507']);
  assert.equal(p1.nextBefore, p1.entries[2].ts);
  const p2 = queryAudit({ dir, limit: 3, beforeTs: p1.nextBefore });
  assert.deepEqual(p2.entries.map((e) => e.action), ['a506', 'a505', 'a504'], '游标翻页不重不漏');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('queryAudit：同一毫秒的多条记录不会因 ts 游标被整组跳过（2026-10-01 审查）', () => {
  const dir = tmp();
  const at = Date.UTC(2026, 9, 1, 3);
  // 游标就是 ts 本身，翻页时 `ts === nextBefore` 会被跳过 —— 所以边界那一组必须整组返回。
  // 旧实现按 limit 截断，组里靠后的记录下一页会被游标整组跳过、永远查不到。
  for (const action of ['first', 'second', 'third']) appendAudit({ dir, action, ok: true, at });
  const p1 = queryAudit({ dir, limit: 2 });
  assert.deepEqual(p1.entries.map((e) => e.action), ['third', 'second', 'first'], '同一毫秒整组一并返回');
  assert.equal(p1.nextBefore, at);
  const p2 = queryAudit({ dir, limit: 2, beforeTs: p1.nextBefore });
  assert.deepEqual(p2.entries, [], '整组已取完：下一页既不该重复，也不该还有落下的');
  assert.equal(p2.nextBefore, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('单字段超 4KB 截断并标 truncated；未超的字段原样', () => {
  const dir = tmp();
  appendAudit({
    dir, action: 'big', ok: true, at: Date.UTC(2026, 7, 1, 12),
    after: { note: 'x'.repeat(5000), small: 'ok' }
  });
  const rec = queryAudit({ dir, limit: 1 }).entries[0];
  assert.equal(rec.truncated, true);
  assert.ok(rec.after.note.endsWith('…[截断]'));
  assert.equal(rec.after.note.length, 4096 + '…[截断]'.length);
  assert.equal(rec.after.small, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('整条 before+after 超 256KB：降级为仅 changed 顶层键并标 partial', () => {
  const dir = tmp();
  const wide = (tag) => Object.fromEntries(
    Array.from({ length: 90 }, (_, i) => [`f${i}`, `${tag}-${'z'.repeat(4096)}`])
  );
  appendAudit({
    dir, action: 'huge', ok: true, at: Date.UTC(2026, 8, 1, 12),
    before: { keepme: 'small-before', ...wide('b') },
    after: { keepme: 'small-after', ...wide('a') },
    changed: ['keepme']
  });
  const rec = queryAudit({ dir, limit: 1 }).entries[0];
  assert.equal(rec.partial, true);
  assert.deepEqual(Object.keys(rec.before), ['keepme']);
  assert.equal(rec.before.keepme, 'small-before');
  assert.equal(rec.after.keepme, 'small-after');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('旁路语义：落盘失败不抛（返回 null），只 console.warn', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'x');   // 文件挡在目录位置上 → mkdir 必失败
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let r;
  try { r = appendAudit({ dir: path.join(blocker, 'audit-log'), action: 'x', ok: true }); }
  finally { console.warn = orig; }
  assert.equal(r, null);
  assert.equal(warns.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('脱敏链：循环引用标 [circular] 且不丢记录；error 走 redactText 不落令牌', () => {
  const dir = tmp();
  const cyclic = { name: 'n' };
  cyclic.self = cyclic;
  appendAudit({
    dir, action: 'cyc', ok: false, at: Date.UTC(2026, 9, 1, 12),
    before: cyclic,
    error: 'fetch failed: https://x/?access_token=tok-9f8e7d'
  });
  const text = readAll(dir);
  assert.ok(!text.includes('tok-9f8e7d'), '错误文本里的令牌必须脱敏');
  const rec = queryAudit({ dir, limit: 1 }).entries[0];
  assert.equal(rec.before.self, '[circular]');
  assert.equal(rec.ok, false);
  assert.equal(rec.truncated, true, '配置形态脱敏在循环上失败 → 标 truncated');
  assert.ok(rec.error.includes('[redacted]'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 2026-09-30 审查 P1：审计会把**整份配置**落盘（config.update），而原来的脱敏只按字段名判，
//    按值扫（Bearer/sk-…，即 redactText 的规则）又只作用在 error 上。于是用户把凭据填进
//    api.extraBody / api.thinkingParams（文档推荐的高级逃生口）或自定义 header 时，
//    明文就会写进 audit-*.jsonl、并被 /api/audit 原样读回。以下用例锁住修复。
test('审计落盘：字段名不含关键词但值是密钥（extraBody/headers）也必须脱敏', () => {
  const dir = tmp();
  const payload = {
    api: {
      extraBody: { dskey_credential: 'sk-super-secret-value-1234567890' },
      thinkingParams: { low: { 'x-api-key': 'sk-another-secret-0987654321' } },
      headers: { Authorization: 'Bearer sk-bearer-secret-abcdefg' },
      myToken: 'sk-token-xyz'
    }
  };
  appendAudit({ dir, action: 'config.update', target: 'config', before: payload, after: payload, at: Date.UTC(2026, 9, 2, 12) });
  const text = readAll(dir);
  for (const secret of ['sk-super-secret-value-1234567890', 'sk-another-secret-0987654321',
    'sk-bearer-secret-abcdefg', 'sk-token-xyz']) {
    assert.ok(!text.includes(secret), `明文密钥不得落盘：${secret.slice(0, 12)}…`);
  }
  // 普通文本不受影响（别把脱敏做成一刀切）
  const dir2 = tmp();
  appendAudit({ dir: dir2, action: 'x', ok: true, before: { note: '普通文本不受影响' }, at: Date.UTC(2026, 9, 2, 12) });
  assert.ok(readAll(dir2).includes('普通文本不受影响'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('审计落盘：插件设置里的 biliCookie/userSession 这类非 secret 字段也要掩码', () => {
  const dir = tmp();
  appendAudit({
    dir, action: 'config.update', target: 'config', ok: true, at: Date.UTC(2026, 10, 14, 3),
    before: { plugins: { settings: { bili: { biliCookie: 'SESSDATA=secret-1', userSession: 'session-2', theme: 'dark' } } } }
  });
  const text = readAll(dir);
  assert.ok(!text.includes('secret-1'));
  assert.ok(!text.includes('session-2'));
  assert.ok(text.includes('dark'), '普通设置仍保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('审计落盘：header 类字段名（authorization / x-api-key / cookie）整值脱敏', () => {
  const dir = tmp();
  appendAudit({
    dir, action: 'x', ok: true, at: Date.UTC(2026, 9, 2, 12),
    before: {
      headers: { authorization: 'any-secret-1', 'x-api-key': 'any-secret-2', cookie: 'any-secret-3' },
      auth: 'any-secret-4'
    }
  });
  const text = readAll(dir);
  for (const s of ['any-secret-1', 'any-secret-2', 'any-secret-3', 'any-secret-4']) {
    assert.ok(!text.includes(s), `header 类字段的值必须整值脱敏：${s}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
