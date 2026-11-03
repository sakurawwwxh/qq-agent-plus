// 会话留档存储（2026-10-30）：
//   1. 摘要索引侧车 —— 启动不再全量解析留档，索引缺失/损坏/外部文件都能自愈；
//   2. 压缩归档（.json.gz）—— 透明读取、幂等压缩、运行中不压；
//   3. 总量预算 —— 超限按最旧优先删，运行中/等待中的永不删；
//   4. 异步合并落盘 —— 旧的运行中快照不能覆盖 finish 的最终态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-storage-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { SessionRegistry, sessionFile } = await import('../src/core/sessions.js');
const { readSessionFile } = await import('../src/core/session-files.js');

const dir = path.join(dataDir, 'sessions');
const INDEX = path.join(dir, '.sessions-index.jsonl');

function writeSession(id, patch = {}, { ageDays = 0, extra = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const endedAt = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify({
    id, chatKey: 'group:1', status: 'done', startedAt: endedAt, endedAt, ...patch, pad: extra
  }));
  if (ageDays > 0) {
    const past = new Date(endedAt);
    fs.utimesSync(file, past, past);
  }
  return file;
}

const resetDir = () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
  }
};

const indexIds = () => {
  try {
    return fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)?.s?.id).filter(Boolean);
  } catch { return []; }
};

test('首次启动建立索引；之后不再解析已索引的留档（坏文件也照样列出）', () => {
  resetDir();
  writeSession('m1001');
  writeSession('m1002');
  writeSession('m1003');
  const first = new SessionRegistry(0);
  assert.deepEqual(first.index.map((e) => e.id).sort(), ['m1001', 'm1002', 'm1003']);
  assert.ok(fs.existsSync(INDEX), '首次启动要落一份索引');
  assert.equal(indexIds().length, 3, '索引里每个会话一条');

  // 把其中一个文件写成坏 JSON：如果启动还全量解析，这个会话会因为解析失败而消失。
  // 索引命中时必须保留它（证明启动没有读它）。
  fs.writeFileSync(path.join(dir, 'm1002.json'), '{oops');
  const second = new SessionRegistry(0);
  const ids = second.index.map((e) => e.id);
  assert.ok(ids.includes('m1002'), '已索引的留档不因文件内容坏掉而从列表消失（启动未全量解析）');
  assert.equal(second.index.find((e) => e.id === 'm1002')?.status, 'done', '状态来自索引摘要');
});

test('索引缺失或损坏时全量重建，不丢任何会话', () => {
  resetDir();
  writeSession('m2001');
  writeSession('m2002');
  fs.rmSync(INDEX, { force: true });
  const rebuilt = new SessionRegistry(0);
  assert.deepEqual(rebuilt.index.map((e) => e.id).sort(), ['m2001', 'm2002']);
  assert.ok(fs.existsSync(INDEX), '重建后要重新写索引');

  // 半截行 / 乱码：跳过坏行，其余照常；有效条数为 0 时按"索引不可用"全量重建
  fs.writeFileSync(INDEX, '{"v":1,"s":{"id":"m2001"}}\n{broken\n');
  const fromGood = new SessionRegistry(0);
  assert.ok(fromGood.index.some((e) => e.id === 'm2001'));
  fs.writeFileSync(INDEX, 'not json at all\n');
  const fromBad = new SessionRegistry(0);
  assert.deepEqual(fromBad.index.map((e) => e.id).sort(), ['m2001', 'm2002']);
});

test('外部新增的留档会被补进索引；索引里有但文件已删的条目被丢弃', () => {
  resetDir();
  writeSession('m3000');
  new SessionRegistry(0);                       // 先有索引，里面确实有 m3000
  assert.ok(indexIds().includes('m3000'), '前提：索引里有 m3000');
  writeSession('m3001');                        // 索引之外新增（恢复备份的场景）
  fs.rmSync(path.join(dir, 'm3000.json'), { force: true });   // 外部删除（索引里有的那条）
  const reg = new SessionRegistry(0);
  assert.ok(reg.index.some((e) => e.id === 'm3001'), '外部新增的文件不能从列表消失');
  assert.ok(!reg.index.some((e) => e.id === 'm3000'), '文件没了，摘要也要跟着丢');
});

test('崩溃残留的 running/waiting 启动时回收成 aborted，并写回文件', () => {
  resetDir();
  writeSession('m4001', { status: 'running', endedAt: null });
  const reg = new SessionRegistry(0);
  const summary = reg.index.find((e) => e.id === 'm4001');
  assert.equal(summary.status, 'aborted');
  assert.ok(summary.endedAt > 0, 'endedAt 要补上（否则详情头显示"进行中"）');
  const stored = readSessionFile(sessionFile('m4001'));
  assert.equal(stored.status, 'aborted', '文件本身也要改回来，不然列表说中止、详情说运行中');
  assert.equal(stored.waitUntil, null);
});

test('压缩：旧归档可透明读取、重复压缩幂等、运行中状态的旧文件不压', async () => {
  resetDir();
  writeSession('m5001', {}, { ageDays: 40 });
  const reg = new SessionRegistry(0);
  // 启动回收会把构造前就存在的 running 改成 aborted，所以"运行中不压"要在构造之后造：
  // 一份 status=running 且 mtime 很旧的文件（模拟另一个进程正在跑的会话）。
  writeSession('m5002', { status: 'running', endedAt: null }, { ageDays: 40 });
  const first = await reg.compressSessions(30);
  assert.equal(first.compressed, 1, '只有已结束的旧归档被压');
  assert.ok(fs.existsSync(path.join(dir, 'm5001.json.gz')), '压缩产物存在');
  assert.equal(fs.existsSync(path.join(dir, 'm5001.json')), false, '压缩后明文要删掉');
  assert.ok(fs.existsSync(path.join(dir, 'm5002.json')), '状态为 running 的旧文件不压');

  const stored = reg.get('m5001');
  assert.equal(stored?.id, 'm5001', '详情读取要能解压');
  assert.ok(reg.index.some((e) => e.id === 'm5001'), '列表仍然看得到');

  const again = await reg.compressSessions(30);
  assert.equal(again.compressed, 0, '已经压过的不重复压');
  const stats = reg.storageStats({ fresh: true });
  assert.ok(stats.compressedFiles >= 1);
  assert.ok(stats.bytes > 0);
});

test('总量预算：超限按最旧优先删，运行中/等待中的会话保留', async () => {
  resetDir();
  const reg = new SessionRegistry(0, { maxTotalMb: 1 });
  const big = 'x'.repeat(700 * 1024);
  const first = reg.create({ chatKey: 'group:1', trigger: 'message' });
  first.messages.push({ role: 'user', content: big });
  reg.finish(first.id, 'done');
  // id 前缀是毫秒时间戳的 base36：同一毫秒内的 id 靠随机后缀区分，排序不保证先后。
  // 拉开 5ms 才能断言"先删最旧的那份"。
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = reg.create({ chatKey: 'group:1', trigger: 'message' });
  second.messages.push({ role: 'user', content: big });
  reg.finish(second.id, 'done');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const running = reg.create({ chatKey: 'group:1', trigger: 'message' });
  running.messages.push({ role: 'user', content: big });
  reg.update(running.id);              // 触发一次落盘
  await new Promise((resolve) => setTimeout(resolve, 30));

  const result = reg.pruneSessions(90);
  assert.ok(result.removed >= 1, '超过 1MB 预算要删最旧的已完成会话');
  assert.equal(fs.existsSync(sessionFile(second.id)), false, '最旧的已结束会话先删');
  assert.equal(fs.existsSync(sessionFile(first.id)), false, '次旧的也会被删到预算以内');
  assert.equal(fs.existsSync(sessionFile(running.id)), true, '运行中的会话永远不删');
});

test('异步合并落盘：finish 的最终态不会被在途的 running 快照覆盖', async () => {
  resetDir();
  const reg = new SessionRegistry(0);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message' });
  // 撑大 payload，让异步写（writeFile + rename）明显晚于 finish 的同步写完成
  s.messages.push({ role: 'user', content: 'y'.repeat(400 * 1024) });
  reg.update(s.id);
  reg.update(s.id);                    // 同时只有一个写在飞，第二次只置脏位
  reg.finish(s.id, 'done');
  await new Promise((resolve) => setTimeout(resolve, 120));

  const stored = readSessionFile(sessionFile(s.id));
  assert.equal(stored.status, 'done', '最终文件必须是 finished 的 done，不是 running 旧快照');
  assert.ok(stored.endedAt > 0);
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '不能留下临时文件');
});

test('索引行数远多于有效条目时启动压实（避免 jsonl 无界增长）', () => {
  resetDir();
  writeSession('m7001');
  writeSession('m7002');
  // 模拟长期运行后的沉淀：同一个会话被追加很多次（旧实现没有压实）
  const lines = [];
  for (let i = 0; i < 2000; i += 1) {
    lines.push(JSON.stringify({ v: 1, s: { id: i % 2 ? 'm7001' : 'm7002', status: 'done', startedAt: 1 } }));
  }
  fs.writeFileSync(INDEX, `${lines.join('\n')}\n`);
  const reg = new SessionRegistry(0);
  assert.deepEqual(reg.index.map((e) => e.id).sort(), ['m7001', 'm7002']);
  const compacted = fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean);
  assert.equal(compacted.length, 2, '启动后索引只剩有效条目');
});

test('索引说 done、文件还是 running（终态写失败）→ 下次启动按元信息发现并修正', () => {
  resetDir();
  writeSession('m8001');
  new SessionRegistry(0);                       // 索引与文件都是 done
  // 模拟"finish 写盘失败但索引已追加"：文件被旧的 running 快照覆盖，mtime/size 都变了
  writeSession('m8001', { status: 'running', endedAt: null, lastRound: 9 });
  const reg = new SessionRegistry(0);
  const summary = reg.index.find((e) => e.id === 'm8001');
  assert.equal(summary.status, 'aborted', '启动要发现文件与索引不一致，并按崩溃残留回收');
  assert.equal(readSessionFile(sessionFile('m8001')).status, 'aborted', '文件也要写回');
});

test('启动清理：超过 1 小时的 .tmp 残留删掉，新的留着', () => {
  resetDir();
  fs.mkdirSync(dir, { recursive: true });
  const oldTmp = path.join(dir, 'x.json.123.tmp');
  const newTmp = path.join(dir, 'y.json.456.tmp');
  fs.writeFileSync(oldTmp, 'old');
  fs.writeFileSync(newTmp, 'new');
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldTmp, past, past);
  new SessionRegistry(0);
  assert.equal(fs.existsSync(oldTmp), false, '陈旧临时文件要清掉');
  assert.equal(fs.existsSync(newTmp), true, '可能属于另一个正在写的实例，不能删');
});

test('总量预算把读不出来的坏留档也算进去（否则预算永远达不到上限）', () => {
  resetDir();
  fs.mkdirSync(dir, { recursive: true });
  // 坏文件：预算统计必须包含它（只统计"能解析的"会让损坏文件永久占盘）
  fs.writeFileSync(path.join(dir, 'm9000.json'), 'x'.repeat(700 * 1024));
  writeSession('m9001', {}, { ageDays: 0 });
  // 让 m9001 也够大：把 pad 字段撑起来
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'm9001.json'), 'utf8'));
  data.pad = 'y'.repeat(700 * 1024);
  fs.writeFileSync(path.join(dir, 'm9001.json'), JSON.stringify(data));

  const reg = new SessionRegistry(0, { maxTotalMb: 1 });
  const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(!remaining.includes('m9000.json'), '最旧的坏文件应先被预算删掉');
  assert.ok(remaining.includes('m9001.json'), '删到上限内就停手');
  assert.ok(reg.storageStats().bytes <= 1024 * 1024);
});

test('finish 写盘失败：索引不写"匹配的元信息"，下次启动重读并重试（P1 回归）', () => {
  resetDir();
  const reg = new SessionRegistry(0);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message' });
  const file = sessionFile(s.id);

  // 让 finish 的同步写失败（磁盘满/被占用）：只拦这个会话的 tmp 写
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function patched(target, ...rest) {
    if (String(target).startsWith(file) && String(target).endsWith('.tmp')) {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return realWrite.call(fs, target, ...rest);
  };
  try { reg.finish(s.id, 'done'); } finally { fs.writeFileSync = realWrite; }

  // 磁盘上仍是 create 时的 running 快照
  assert.equal(readSessionFile(file).status, 'running', '前提：finish 没写成功');
  // 索引最后一条同 id 记录必须"没有元信息"，表示下次启动要重读
  const lines = fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const last = lines.filter((item) => item?.s?.id === s.id).at(-1);
  assert.ok(last, 'finish 仍要追加一条摘要（列表里能看到这次运行）');
  assert.equal(last.f, undefined, '写盘失败不能带 f，否则下次启动会信任错误的 done 摘要');

  // 重启：重读文件 → 崩溃残留回收成 aborted，而不是信任内存里的 done
  const reg2 = new SessionRegistry(0);
  assert.equal(reg2.index.find((e) => e.id === s.id)?.status, 'aborted');
  assert.equal(readSessionFile(file).status, 'aborted', '文件也要写回 aborted');
});
