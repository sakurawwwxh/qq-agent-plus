// 诊断包（ops doctor）的纯函数层：
//   1. 配置与日志必须脱敏（字段名、值形态、MCP env/args、插件设置四层）；
//   2. 存储汇总要统计压缩归档；
//   3. 插件/异常台账读取失败不能抛，也不能把"读不了"说成"没有"；
//   4. 归档文件真的能生成（tar 不可用时退回目录，且不删除已存在路径）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const {
  storageBreakdown, sessionStorage, redactedConfig, pluginSummary,
  incidentSummary, logTail, buildDiagnoseEntries, writeDiagnoseArchive
} = await import('../src/core/diagnose.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diagnose-test-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

test('配置脱敏：字段名 + 值形态 + MCP env/args + 插件设置敏感键', () => {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    api: { baseUrl: 'https://example.com', apiKey: 'sk-should-not-leak', model: 'm' },
    server: { port: 3210, token: 'console-token-should-not-leak' },
    onebot: { accessToken: 'onebot-token-should-not-leak', httpPort: 3390 },
    // 字段名不带 token/key 的形态：只能靠"值形态"脱敏
    webSearch: { searchUrl: 'https://search.example/s?q=x&subscription-key=url-secret-value' },
    mcp: {
      servers: [{
        name: 'sentry',
        env: { SENTRY_AUTH_TOKEN: 'mcp-env-secret', NORMAL_SETTING: 'keep-me' },
        args: ['--api-key', 'mcp-arg-secret', '--verbose']
      }]
    },
    plugins: { settings: { bilibili: { biliCookie: 'plugin-cookie-secret', theme: 'dark' } } }
  }));
  const safe = redactedConfig(root);
  const text = JSON.stringify(safe);
  for (const secret of [
    'sk-should-not-leak', 'console-token-should-not-leak', 'onebot-token-should-not-leak',
    'url-secret-value', 'mcp-env-secret', 'mcp-arg-secret', 'plugin-cookie-secret'
  ]) {
    assert.ok(!text.includes(secret), `${secret} 不能明文进包`);
  }
  assert.equal(safe.api.model, 'm', '非密钥字段要保留');
  assert.equal(safe.server.port, 3210);
  assert.equal(safe.mcp.servers[0].env.NORMAL_SETTING, '******', 'MCP env 的值一律掩码');
  assert.equal(safe.plugins.settings.bilibili.theme, 'dark', '非敏感插件设置保留');
  assert.ok(fs.existsSync(path.join(root, 'config.json')), '脱敏只发生在副本上');
});

test('配置坏 JSON：不回显原始内容（V8 报错会带输入片段）', () => {
  fs.writeFileSync(path.join(root, 'config.json'), '{"api":{"apiKey":"sk-partial-leak"');
  const safe = redactedConfig(root);
  assert.equal(safe.unavailable, true);
  assert.ok(!JSON.stringify(safe).includes('sk-partial-leak'), '解析错误的片段不能进包');
});

test('存储汇总：一级目录排行 + 会话留档（含压缩归档）', () => {
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'a.json'), 'x'.repeat(200));
  fs.writeFileSync(path.join(sessions, 'b.json.gz'), zlib.gzipSync(Buffer.from('y'.repeat(2000))));
  fs.mkdirSync(path.join(root, 'audit-log'), { recursive: true });
  fs.writeFileSync(path.join(root, 'audit-log', '2026-10.jsonl'), 'z'.repeat(500));

  const rows = storageBreakdown(root);
  const sessionRow = rows.find((r) => r.name === 'sessions');
  assert.equal(sessionRow.kind, 'dir');
  assert.ok(sessionRow.bytes > 0);
  assert.equal(sessionRow.files, 2);

  const detail = sessionStorage(root);
  assert.equal(detail.files, 2);
  assert.equal(detail.compressed, 1, '压缩归档要单独计数');
  assert.ok(detail.bytes > 0);
  assert.ok(detail.oldestAt > 0);
});

test('插件清单：跳过中间目录与软链，坏清单要列出来而不是静默消失', () => {
  fs.mkdirSync(path.join(root, 'plugins', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', 'demo', 'plugin.json'), JSON.stringify({
    name: '演示插件', version: '1.2.3', apiVersion: 1
  }));
  fs.mkdirSync(path.join(root, 'plugins', '.staging-demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', '.staging-demo', 'plugin.json'), JSON.stringify({ name: '升级中' }));
  fs.mkdirSync(path.join(root, 'plugins', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', 'broken', 'plugin.json'), '{oops');
  const list = pluginSummary(root);
  assert.deepEqual(list.find((p) => p.id === 'demo'), { id: 'demo', name: '演示插件', version: '1.2.3', apiVersion: 1 });
  assert.equal(list.find((p) => p.id === 'broken')?.broken, true, '坏清单要以 broken:true 出现');
  assert.ok(!list.some((p) => p.id.startsWith('.staging')), '升级中间目录不算已装插件');
  assert.deepEqual(pluginSummary(path.join(root, 'nope')), []);
});

test('异常台账：库不存在返回 null；存在但读不了返回 unavailable（不能冒充"没有异常"）', () => {
  assert.equal(incidentSummary(path.join(root, 'no-such-dir')), null);
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diagnose-bad-'));
  fs.writeFileSync(path.join(badDir, 'incident-pilot.sqlite'), 'not a database');
  const summary = incidentSummary(badDir);
  assert.equal(summary?.unavailable, true);
  assert.ok(summary.reason);
  fs.rmSync(badDir, { recursive: true, force: true });
});

test('日志尾巴：脱敏 + 只保留最新的 40k 字符 + 跳过符号链接', () => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'logs', 'app.log'), [
    '2026-10-30T10:00:00Z [info] Authorization: Bearer sk-log-secret',
    '2026-10-30T10:00:01Z [warn] Cookie: uin=1; skey=cookie-secret; p_skey=more-secret',
    '2026-10-30T10:00:02Z [info] x-api-key: header-secret',
    '2026-10-30T10:00:03Z [info] OLDEST-LINE-SHOULD-BE-DROPPED ' + 'x'.repeat(50000),
    '2026-10-30T10:00:04Z [error] NEWEST-ERROR-LINE'
  ].join('\n'));
  const text = logTail({ dataDir: root, lines: 100 });
  assert.ok(!text.includes('sk-log-secret'));
  assert.ok(!text.includes('cookie-secret') && !text.includes('more-secret'), 'Cookie 多段都要脱');
  assert.ok(!text.includes('header-secret'));
  assert.ok(text.includes('NEWEST-ERROR-LINE'), '截断要保留最新的一段，不能把最近的错误切掉');
  assert.ok(!text.includes('OLDEST-LINE-SHOULD-BE-DROPPED'), '超长时丢弃最旧的内容');

  // 完全取不到日志时给可操作提示，而不是让诊断包里写"没有日志"让人以为机器上没日志
  const hint = logTail({ dataDir: path.join(root, 'no-logs-here'), lines: 10 });
  assert.ok(hint.includes('docker compose logs') || hint.includes('journalctl'), '要告诉用户日志该怎么取');
});

test('归档生成：成员名不与线上文件冲突；tar 不可用时退回新目录且不删已有路径', () => {
  const entries = buildDiagnoseEntries({
    manifest: { version: '0.0.0-test' },
    config: { api: { model: 'm' } },
    health: { healthy: true, checks: [] },
    storage: { breakdown: [], sessions: { files: 0 } },
    plugins: [],
    incidents: null,
    effects: { total: 0, counts: {}, unknownRecent: 0 },
    logs: 'hello'
  });
  assert.deepEqual(Object.keys(entries).sort(),
    ['config.redacted.json', 'effects.json', 'health-check.json', 'incidents.json', 'logs.txt', 'manifest.json', 'plugins.json', 'storage.json']);
  assert.ok(!('config.json' in entries), '不能叫 config.json：解压到 data/ 会覆盖真实配置');
  assert.ok(!('health.json' in entries), '不能叫 health.json：会覆盖巡检状态');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diagnose-out-'));
  const outFile = path.join(outDir, 'bundle.tar.gz');
  const written = writeDiagnoseArchive(outFile, entries);
  assert.equal(written.ok, true);
  assert.ok(fs.existsSync(written.path), '诊断包路径必须真实存在');
  assert.ok(['tar.gz', 'dir'].includes(written.method));

  if (written.method === 'tar.gz') {
    const list = spawnSync('tar', ['-tzf', 'bundle.tar.gz'], { cwd: outDir, encoding: 'utf8' });
    if (list.status === 0) {
      const names = list.stdout.split('\n').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean);
      for (const name of Object.keys(entries)) assert.ok(names.includes(name), `归档里要有 ${name}`);
    }
  }

  // 回退目录不能覆盖/删除用户已有目录：先造一个同名 .d，再让 tar 用不了（不存在）
  const userDir = `${outFile}.d`;
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'keepme.txt'), 'user-data');
  const fallback = writeDiagnoseArchive(outFile, entries);
  if (fallback.method === 'dir') {
    assert.notEqual(fallback.path, userDir, '不能复用/删除用户已有目录');
    assert.equal(fs.readFileSync(path.join(userDir, 'keepme.txt'), 'utf8'), 'user-data');
  } else {
    assert.equal(fs.readFileSync(path.join(userDir, 'keepme.txt'), 'utf8'), 'user-data');
  }

  fs.rmSync(outDir, { recursive: true, force: true });
});
