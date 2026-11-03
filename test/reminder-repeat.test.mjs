// 周期提醒（repeat）：daily/weekly/简化 cron、IANA 时区、抖动、免打扰、错过补最近一次。
// 纯函数与 store 行为分开验，全部不碰真实机器状态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-repeat-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const {
  validTimezone, zonedWallClock, nextDailyAt, nextWeeklyAt,
  parseCron5, nextCronAt, nextOccurrenceAt, normalizeRepeat, ReminderStore
} = await import('../src/core/reminders.js');

// 固定基准：2026-10-24 12:00 UTC = 上海 20:00（周六）
const BASE = Date.UTC(2026, 9, 24, 12, 0, 0);

test('周期提醒取消后，迟到的 markFired 不能把它复活', () => {
  const store = new ReminderStore(path.join(dir, 'cancel-race.json'));
  const now = Date.now();
  const item = store.add({
    chatKey: 'group:1', at: now + 60_000, text: '每天站会',
    repeat: { kind: 'daily', hour: 9, minute: 0, tz: 'Asia/Shanghai' }
  });
  store.cancel({ id: item.id, chatKey: 'group:1' });
  store.markFired(item.id, now + 120_000);
  const after = store.list('group:1', { includeDone: true }).find((x) => x.id === item.id);
  assert.equal(after.status, 'canceled', '取消必须压过异步派发收尾的 markFired');
});

test('夏令时：春季调时不跳成 46 小时后，秋季回拨返回严格未来', () => {
  // 美东 2026-03-08 春季调时：00:00 EST 之后，当天 23:00 已是 EDT。
  // 旧实现按挂钟分钟差 + 回读校正会再加一整天（实测 46 小时）。
  const springBase = Date.parse('2026-03-08T05:00:00Z');
  assert.equal(new Date(nextDailyAt({ hour: 23, minute: 0 }, 'America/New_York', springBase)).toISOString(),
    '2026-03-09T03:00:00.000Z');
  // 秋季回拨日：00:00 当天已经过去，下一次必须是第二天 00:00 EST（严格未来）。
  const fallBase = Date.parse('2026-11-01T04:00:00Z');
  const nextMidnight = nextDailyAt({ hour: 0, minute: 0 }, 'America/New_York', fallBase);
  assert.ok(nextMidnight > fallBase, '下一次必须严格晚于基准');
  assert.equal(new Date(nextMidnight).toISOString(), '2026-11-02T05:00:00.000Z');
  // 被跳过的挂钟时间（02:30 不存在）：落到跳变之后的临近时刻，不能提前一天/不触发。
  const gap = nextDailyAt({ hour: 2, minute: 30 }, 'America/New_York', springBase);
  assert.ok(gap > springBase && gap - springBase < 26 * 3600e3);
  assert.equal(zonedWallClock(gap, 'America/New_York').hour, 3);

  // 秋季回拨的重复小时：01:30 出现两次。基准夹在两次之间时，必须取还未来的那次，
  // 而不是跳过一整天/一周（2026-10-30 独立交叉审查抓到）。
  const between = Date.parse('2026-11-01T05:40:00Z');   // 纽约 01:40 EDT
  assert.equal(new Date(nextDailyAt({ hour: 1, minute: 30 }, 'America/New_York', between)).toISOString(),
    '2026-11-01T06:30:00.000Z', '第二次 01:30 EST 还在 50 分钟后');
  assert.equal(new Date(nextWeeklyAt({ weekday: 0, hour: 1, minute: 30 }, 'America/New_York', between)).toISOString(),
    '2026-11-01T06:30:00.000Z');
  // 基准在重复小时之前时，取最早的一次（01:30 EDT）。
  assert.equal(new Date(nextDailyAt({ hour: 1, minute: 30 }, 'America/New_York', Date.parse('2026-11-01T04:00:00Z'))).toISOString(),
    '2026-11-01T05:30:00.000Z');
  // 东半球回拨同理：伦敦 01:30 BST（00:30Z）比 01:30 GMT（01:30Z）更早。
  assert.equal(new Date(nextDailyAt({ hour: 1, minute: 30 }, 'Europe/London', Date.parse('2026-10-25T00:20:00Z'))).toISOString(),
    '2026-10-25T00:30:00.000Z');

  // 免打扰跨 DST：22:00-07:00 的顺延要落在本地 07:00，而不是 08:00。
  const quiet = nextOccurrenceAt(
    { repeat: { kind: 'daily', hour: 23, minute: 30, tz: 'America/New_York' } },
    Date.parse('2026-03-07T12:00:00Z'),
    { quiet: { start: '22:00', end: '07:00' } }
  );
  assert.equal(new Date(quiet).toISOString(), '2026-03-08T11:00:00.000Z');
  assert.deepEqual(zonedWallClock(quiet, 'America/New_York'), { hour: 7, minute: 0, dow: 0 });

  // 显式时区写错：返回 null（调用方标 failed），不能静默换成上海把提醒平移。
  assert.equal(nextOccurrenceAt(
    { repeat: { kind: 'daily', hour: 9, minute: 0, tz: 'America/New_Yrok' } },
    Date.now()
  ), null);
  // 非有限基准：返回 null（与其他"非法输入返回 null"的路径一致），不抛 RangeError。
  assert.equal(nextDailyAt({ hour: 9, minute: 0 }, 'Asia/Shanghai', Infinity), null);
  assert.equal(nextWeeklyAt({ weekday: 1, hour: 9, minute: 0 }, 'Asia/Shanghai', NaN), null);
  assert.equal(nextCronAt('0 9 * * *', 'Asia/Shanghai', Infinity), null);
  // 半小时间隔 DST 的时区（Lord Howe）也必须严格未来且挂钟正确。
  const lh = nextDailyAt({ hour: 2, minute: 15 }, 'Australia/Lord_Howe', Date.parse('2026-10-03T14:00:00Z'));
  assert.ok(lh > Date.parse('2026-10-03T14:00:00Z'));
  assert.deepEqual(zonedWallClock(lh, 'Australia/Lord_Howe').hour, 2);
});

test('时区：IANA 校验 fail-closed，挂钟读数正确', () => {
  assert.equal(validTimezone('Asia/Shanghai'), true);
  assert.equal(validTimezone('UTC'), true);
  assert.equal(validTimezone('Mars/Olympus'), false);
  assert.equal(validTimezone(''), false);
  const wall = zonedWallClock(BASE, 'Asia/Shanghai');
  assert.deepEqual(wall, { hour: 20, minute: 0, dow: 6 });   // 周六 20:00
  const utc = zonedWallClock(BASE, 'UTC');
  assert.deepEqual(utc, { hour: 12, minute: 0, dow: 6 });
});

test('daily：明天同一挂钟时刻；已过算明天；跨时区各自正确', () => {
  const sh = nextDailyAt({ hour: 9, minute: 30 }, 'Asia/Shanghai', BASE);
  assert.equal(zonedWallClock(sh, 'Asia/Shanghai').hour, 9);
  assert.equal(zonedWallClock(sh, 'Asia/Shanghai').minute, 30);
  assert.ok(sh > BASE);
  // 20:00 基准 → 次日 09:30（13.5 小时后）
  assert.ok(Math.abs((sh - BASE) / 3600000 - 13.5) < 0.02);
  // UTC 时区里 12:00 基准 → 当天 13:00
  const utc = nextDailyAt({ hour: 13, minute: 0 }, 'UTC', BASE);
  assert.equal(utc - BASE, 3600000);
});

test('weekly：按星期几滚动', () => {
  // 基准是周六；下一个周一 09:00（上海）
  const next = nextWeeklyAt({ weekday: 1, hour: 9, minute: 0 }, 'Asia/Shanghai', BASE);
  const wall = zonedWallClock(next, 'Asia/Shanghai');
  assert.equal(wall.dow, 1);
  assert.equal(wall.hour, 9);
  assert.ok(next > BASE);
});

test('cron：解析白名单与下一个匹配点', () => {
  assert.deepEqual([...parseCron5('30 9 * * 1-5').minutes], [30]);
  assert.equal(parseCron5('30 9 1 * *'), null, '日字段只认 *');
  assert.equal(parseCron5('99 9 * * *'), null);
  assert.equal(parseCron5('*/15 * * * *')?.minutes.size, 4);
  assert.ok(parseCron5('0 9 * * mon-fri').dows.has(1));
  assert.equal(parseCron5('0 9 * * 7')?.dows.has(0), true, '标准 cron 的 7 = 周日');
  assert.equal(parseCron5('0 9 * * 5-7')?.dows.has(0), true, '范围 5-7 也要归一');
  // 周一到周五 09:30：基准周六 → 下一个是周一
  const next = nextCronAt('30 9 * * mon-fri', 'Asia/Shanghai', BASE);
  assert.equal(zonedWallClock(next, 'Asia/Shanghai').dow, 1);
  // 步进：每 15 分钟 —— 基准 20:00 → 20:15
  const step = nextCronAt('*/15 * * * *', 'Asia/Shanghai', BASE);
  assert.equal(zonedWallClock(step, 'Asia/Shanghai').minute, 15);
});

test('normalizeRepeat：字符串/对象/非法入参', () => {
  assert.deepEqual(normalizeRepeat('daily'), { kind: 'daily', hour: 9, minute: 0 });
  assert.equal(normalizeRepeat('weekly:mon').weekday, 1);
  assert.equal(normalizeRepeat({ kind: 'cron', cron: '0 9 * * 1-5' }).kind, 'cron');
  assert.throws(() => normalizeRepeat('nonsense'), /repeat 只支持/);
  assert.throws(() => normalizeRepeat({ kind: 'daily', hour: 99, minute: 0 }), /hour/);
  assert.throws(() => normalizeRepeat({ kind: 'daily', hour: 9, minute: 0, tz: 'Mars/Space' }), /IANA/);
  assert.throws(() => normalizeRepeat({ kind: 'cron', cron: '0 9 1 * *' }), /cron/);
});

test('抖动与免打扰：范围受夹、窗口内顺延到窗口结束', () => {
  const item = { repeat: { kind: 'daily', hour: 9, minute: 30, jitterMs: 600000 } };
  for (let i = 0; i < 20; i += 1) {
    const at = nextOccurrenceAt(item, BASE);
    const wall = zonedWallClock(at, 'Asia/Shanghai');
    const abs = wall.hour * 60 + wall.minute;
    // 09:30 + 最多 10 分钟抖动 → 落在 09:30–09:40（次日）
    assert.ok(abs >= 570 && abs <= 580, `wall=${JSON.stringify(wall)}`);
  }
  const quietItem = { repeat: { kind: 'daily', hour: 23, minute: 30 } };
  const pushed = nextOccurrenceAt(quietItem, BASE, { quiet: { start: '23:00', end: '07:00' } });
  const wall = zonedWallClock(pushed, 'Asia/Shanghai');
  assert.deepEqual([wall.hour, wall.minute], [7, 0], '23:30 落在免打扰 → 顺延到 07:00');
});

test('store：周期项触发后 re-arm，普通项照旧 fired', async () => {
  const file = path.join(dir, 'reminders-store.json');
  const store = new ReminderStore(file);
  const first = nextDailyAt({ hour: 9, minute: 0 }, 'Asia/Shanghai', Date.now());
  const { id } = store.add({
    chatKey: 'group:1', at: first, text: '站会', repeat: { kind: 'daily', hour: 9, minute: 0, tz: 'Asia/Shanghai' }
  });
  const armed = store.markFired(id);
  assert.equal(armed.rearmed, true);
  assert.equal(armed.status, 'pending');
  assert.ok(armed.nextAt > first);
  assert.equal(armed.fireCount, 1);
  // 提前调用（非到期时刻）：re-arm 必须严格指向未来，不能算回同一槽位
  const armedEarly = store.markFired(id);
  assert.ok(armedEarly.nextAt > armed.nextAt, '再次 re-arm 要跳到下一期，不能原地踏步');
  // 普通项
  const plain = store.add({ chatKey: 'group:1', at: Date.now() + 60000, text: '一次性的' });
  const done = store.markFired(plain.id);
  assert.equal(done.status, 'fired');
});

test('store：错过多次只补最近一次（超窗跳到未来，窗内保留晚触发）', () => {
  const file = path.join(dir, 'reminders-catchup.json');
  const store = new ReminderStore(file);
  // 一次性的旧 at 也要能构造 —— 直接造 repeat 项：at 在 20 小时前（超 12h 窗）
  const staleAt = Date.now() - 20 * 3600000;
  store.items.push({
    id: 'stale1', chatKey: 'group:1', at: staleAt, originalAt: staleAt, text: '超窗的',
    status: 'pending', createdAt: staleAt, deliveryAttempts: 0, firedAt: null, finishedAt: null,
    repeat: { kind: 'daily', hour: zonedWallClock(staleAt, 'Asia/Shanghai').hour, minute: 0 }, fireCount: 1, dueKeys: []
  });
  // 2 小时前到期（窗内）→ 保留晚触发
  const lateAt = Date.now() - 2 * 3600000;
  store.items.push({
    id: 'late1', chatKey: 'group:1', at: lateAt, originalAt: lateAt, text: '晚到的',
    status: 'pending', createdAt: lateAt, deliveryAttempts: 0, firedAt: null, finishedAt: null,
    repeat: { kind: 'daily', hour: zonedWallClock(lateAt, 'Asia/Shanghai').hour, minute: 0 }, fireCount: 1, dueKeys: []
  });
  const touched = store.reconcileRecurring();
  const stale = store.items.find((x) => x.id === 'stale1');
  const late = store.items.find((x) => x.id === 'late1');
  assert.ok(touched.some((t) => t.id === 'stale1'), '超窗项要被顺延');
  assert.ok(stale.at > Date.now(), '超窗项直接跳到未来触发点');
  assert.equal(stale.missedCount, 1);
  assert.equal(late.at, lateAt, '窗内的保留原 at（晚触发 = 补最近一次）');
  assert.equal(late.status, 'pending');
});

test('工具契约：remind 的 schema 必须声明 repeat（否则模型传对象进不来）', async () => {
  const { buildToolDefs } = await import('../src/tools/tools-core.js');
  const remind = buildToolDefs().find((d) => d.name === 'remind');
  assert.ok(remind, '要有 remind 工具');
  const repeat = remind.parameters?.properties?.repeat;
  assert.ok(repeat, 'parameters.properties.repeat 不能缺（2026-10-24 审查：描述承诺可传，schema 里没有）');
  assert.equal(repeat.type, 'object');
  for (const field of ['kind', 'hour', 'minute', 'weekday', 'cron', 'tz', 'jitterMs']) {
    assert.ok(repeat.properties?.[field], `repeat.${field} 要在 schema 里声明`);
  }
  assert.deepEqual(repeat.required, ['kind']);
  assert.match(remind.parameters.properties.minutes.description, /repeat/, 'minutes 的说明要讲清和 repeat 的关系');
});

test('工具路径：对象形式的 repeat 能建出带时刻的周期提醒，且不强制 minutes', async () => {
  const { buildToolDefs } = await import('../src/tools/tools-core.js');
  const remind = buildToolDefs().find((d) => d.name === 'remind');
  const store = new ReminderStore(path.join(dir, 'reminders-tool.json'));
  const ctx = { reminders: store, chatKey: 'group:1', triggerEntries: [] };

  const result = await remind.execute(ctx, {
    action: 'add', text: '站会', repeat: { kind: 'daily', hour: 21, tz: 'Asia/Shanghai' }
  });
  assert.equal(result.isError, undefined, `对象 repeat 应成功：${result.content}`);
  const payload = JSON.parse(result.content);
  assert.equal(payload.created, true);
  const item = store.items.find((x) => x.id === payload.id);
  assert.deepEqual(item.repeat, { kind: 'daily', hour: 21, minute: 0, tz: 'Asia/Shanghai' },
    '只给 hour 时 minute 按 0（"每天 21 点"不该被要求补分钟）');
  assert.ok(item.at > Date.now(), '首次触发点要算在未来');

  // 字符串旧写法继续兼容（默认 09:00）
  const legacy = await remind.execute(ctx, { action: 'add', text: '周报', repeat: 'weekly:5' });
  assert.equal(legacy.isError, undefined, `字符串 repeat 应继续可用：${legacy.content}`);
  const legacyId = JSON.parse(legacy.content).id;
  assert.equal(store.items.find((x) => x.id === legacyId).repeat.kind, 'weekly');

  // 非法 repeat 返回可读错误，不抛
  const bad = await remind.execute(ctx, { action: 'add', text: 'x', repeat: { kind: 'daily', hour: 25 } });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /hour|repeat/i);
});


test('occurrenceId：顺延/短重试不改键，周期项 re-arm 时换新键（账本幂等键）', () => {
  const store = new ReminderStore(path.join(dir, 'reminders-occurrence.json'));
  const first = nextDailyAt({ hour: 9, minute: 0 }, 'Asia/Shanghai', Date.now());
  const { id } = store.add({
    chatKey: 'group:1', at: first, text: '站会', repeat: { kind: 'daily', hour: 9, minute: 0, tz: 'Asia/Shanghai' }
  });
  const occ = store.ensureOccurrenceId(id);
  assert.ok(occ, '第一次派发要生成 occurrenceId');
  assert.equal(store.ensureOccurrenceId(id), occ, '同一期重复获取不变');

  store.deferTo(id, Date.now() + 3600_000);
  assert.equal(store.items.find((x) => x.id === id).occurrenceId, occ, 'deferTo 改 at 但不能换键');
  store.retryLater(id, Date.now() + 5 * 60_000);
  assert.equal(store.items.find((x) => x.id === id).occurrenceId, occ, 'retryLater 也不能换键');

  // 周期项触发后进入下一期：必须换新的 occurrenceId，否则账本 done 会挡住明天的提醒
  store.markFired(id);
  const next = store.items.find((x) => x.id === id);
  assert.equal(next.occurrenceId, undefined, 're-arm 时清空');
  const occ2 = store.ensureOccurrenceId(id);
  assert.notEqual(occ2, occ, '下一期是新的 occurrence');
});
