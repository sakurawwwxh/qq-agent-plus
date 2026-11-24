import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  excludeHaystack,
  matchExcludeKeyword,
  normalizeExcludeKeywords
} from '../src/features/life-feed-source-bilibili.js';

// 2026-11-24：排除关键词匹配的两处修正。
//
// ① 匹配文本漏了 UP 名 —— 同一个文件的 scoreCandidate() 是含 up 的，两处不一致。
//    后果：按 UP 名排除永远失效。典型例子是 UP 叫「央视农业」的视频，
//    标题里通常不写"央视"，无论怎么把"央视"加进 excludeKeywords 都拦不住。
// ② RSS 来源完全不走 excludeKeywords（见 life-feed.test.mjs 的 RSS 用例）。

test('excludeHaystack：标题/简介/标签/UP 名都参与匹配', () => {
  const item = {
    title: '同样是水果腌肉 为啥有人是国宴',
    desc: '摘要文字',
    tags: ['三农', '美食'],
    up: '央视农业'
  };
  const hay = excludeHaystack(item);
  assert.match(hay, /水果腌肉/, '标题要参与');
  assert.match(hay, /摘要文字/, '简介要参与');
  assert.match(hay, /三农/, '标签要参与');
  assert.match(hay, /央视农业/, '★ UP 名要参与（此前漏掉，导致按 UP 排除失效）');
  // 统一转小写：上游关键词与文本都走 toLowerCase 比较
  assert.equal(hay, hay.toLowerCase());
});

test('excludeHaystack：缺字段不抛错', () => {
  assert.equal(excludeHaystack({}), '   ');
  assert.equal(excludeHaystack(null), '   ');
  assert.equal(excludeHaystack({ title: 'x' }), 'x   ');
});

test('★ 回归：UP 名命中排除词（修复前必然失败）', () => {
  // 这条视频标题里没有"央视"，只有 UP 名里有
  const item = { title: '同样是水果腌肉 为啥有人是国宴', desc: '', tags: ['三农'], up: '央视农业' };
  assert.equal(matchExcludeKeyword(item, ['央视']), '央视', 'UP 名里的"央视"必须命中');
  assert.equal(matchExcludeKeyword(item, ['央视农业']), '央视农业');
  // 反证：修复前 haystack 不含 up，这里会拿到空串
  assert.equal(matchExcludeKeyword(item, ['游戏']), '', '没命中返回空串');
});

test('matchExcludeKeyword：大小写不敏感', () => {
  // 注意：匹配是**原样子串**，不折叠空白 —— 标题写 "AI短剧"（无空格）才能命中 "ai短剧"。
  // 标题写 "AI 短剧"（有空格）时命中不了，这是 includes 语义的固有限制，
  // 不是本次要改的（改它等于引入分词，属于另一个量级的设计变更）。
  const noSpace = { title: 'AI短剧：霸总的一天', desc: '', tags: [], up: '' };
  assert.equal(matchExcludeKeyword(noSpace, ['ai短剧']), 'ai短剧');
  assert.equal(matchExcludeKeyword(noSpace, ['AI短剧']), 'ai短剧', '传入大写也要归一化后匹配');

  // 钉住这个限制，避免以后有人误以为"配了词就一定能拦住所有变体"
  const withSpace = { title: 'AI 短剧：霸总的一天', desc: '', tags: [], up: '' };
  assert.equal(matchExcludeKeyword(withSpace, ['ai短剧']), '', '含空格的标题不会被无空格词命中');
  assert.equal(matchExcludeKeyword(withSpace, ['ai 短剧']), 'ai 短剧', '要匹配含空格的写法，配置里也得带空格');
});

test('matchExcludeKeyword：返回命中的词而不只是布尔值', () => {
  // 返回词是为了让调用方能记"为什么被排除"的日志 —— 静默过滤排查成本很高
  const item = { title: '特厨探店|一碗十块', desc: '', tags: ['美食'], up: '某UP' };
  const hit = matchExcludeKeyword(item, ['广告', '探店', '手游']);
  assert.equal(hit, '探店', '要返回具体命中的那个词');
});

test('matchExcludeKeyword：空列表/非法入参不抛错', () => {
  const item = { title: 'x', desc: '', tags: [], up: '' };
  assert.equal(matchExcludeKeyword(item, []), '');
  assert.equal(matchExcludeKeyword(item, null), '');
  assert.equal(matchExcludeKeyword(item, undefined), '');
  assert.equal(matchExcludeKeyword(null, ['x']), '');
});

test('normalizeExcludeKeywords：去空、去首尾空白、转小写', () => {
  assert.deepEqual(
    normalizeExcludeKeywords([' 广告 ', '', 'AI短剧', null, '  ']),
    ['广告', 'ai短剧']
  );
  assert.deepEqual(normalizeExcludeKeywords('not-an-array'), []);
  assert.deepEqual(normalizeExcludeKeywords(null), []);
});

test('回归：标签单独命中（用户反馈的"孙策"那条，tag=手机游戏）', () => {
  // 标题里没写"王者荣耀"，但 B 站给的标签是"手机游戏"
  const item = { title: '孙策：我船的轨迹就像是你多变的表情', desc: '', tags: ['手机游戏'], up: '木下结草' };
  assert.equal(matchExcludeKeyword(item, ['手机游戏']), '手机游戏');
  assert.equal(matchExcludeKeyword(item, ['王者荣耀']), '', '标题没写就不该命中（这是配置层面的事）');
});

test('回归：不误伤 PVP（PV 相关不能用裸子串匹配）', () => {
  // 说明：这里只验证"匹配文本与命中返回"的行为。
  // PV/EV 预告片不能用裸 "pv" 排（"pvp".includes("pv") 为真），
  // 那属于调用方配置策略，不在本函数的职责内。
  const pvp = { title: '某游戏 PVP 竞技场实况', desc: '', tags: ['游戏'], up: '' };
  assert.equal(matchExcludeKeyword(pvp, ['PVP']), 'pvp', '配 PVP 时命中');
  // 配 "pv" 会误伤 PVP —— 这正是上游文档/使用者需要知道的坑，
  // 用例把它钉住，避免有人以为"配个 pv 就能排 PV 预告片"。
  assert.equal(matchExcludeKeyword(pvp, ['pv']), 'pv', '裸 pv 会命中 PVP（这就是不能这么配的原因）');
});
