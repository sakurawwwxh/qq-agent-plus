// 拍一拍/贴表情没有平台消息 id，协议端重放时不能落两条并重复唤醒。
import assert from 'node:assert/strict';
import test from 'node:test';

const { createNoticeDedup, emojiNoticeKey, pokeNoticeKey } = await import('../src/console/notice-dedup.js');

test('同一事件签名只放行一次；时间不同/目标不同视为新事件', () => {
  const dedup = createNoticeDedup({ now: () => 1_700_000_000_000 });
  const first = pokeNoticeKey('group:1', '42', '999', { time: 100, sub_type: 'poke' });
  assert.equal(dedup.alreadySeen(first), false);
  assert.equal(dedup.alreadySeen(first), true, '重放的同一条 notice 必须被丢掉');

  const later = pokeNoticeKey('group:1', '42', '999', { time: 101, sub_type: 'poke' });
  assert.equal(dedup.alreadySeen(later), false, '不同时间戳是新的拍一拍');

  const otherTarget = pokeNoticeKey('group:1', '42', '888', { time: 100, sub_type: 'poke' });
  assert.equal(dedup.alreadySeen(otherTarget), false, '拍不同的人是新事件');
});

test('没有 time 时用字段签名去重（同字段重放仍被挡住）', () => {
  const dedup = createNoticeDedup({ now: () => 1_700_000_000_000 });
  const event = { sub_type: 'add', message_id: 'm1', likes: [{ emoji_id: '1', count: 1 }] };
  const key = emojiNoticeKey('group:1', '42', event);
  assert.equal(dedup.alreadySeen(key), false);
  assert.equal(dedup.alreadySeen(emojiNoticeKey('group:1', '42', event)), true);
});

test('TTL 过期后同一签名可以再次处理；表大小有上限', () => {
  let clock = 1_700_000_000_000;
  const dedup = createNoticeDedup({ ttlMs: 1000, max: 2, now: () => clock });
  const key = 'k1';
  assert.equal(dedup.alreadySeen(key), false);
  clock += 1001;
  assert.equal(dedup.alreadySeen(key), false, 'TTL 外的事件不应被永久去重');

  // 超过 max 时淘汰最旧的，且不会无限增长
  assert.equal(dedup.alreadySeen('k2'), false);
  assert.equal(dedup.alreadySeen('k3'), false);
  assert.equal(dedup.alreadySeen('k1'), false, '最旧的条目已被淘汰');
});
