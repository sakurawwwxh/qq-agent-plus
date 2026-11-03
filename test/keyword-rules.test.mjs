// 关键词黑名单规则（PR #80 + 2026-10-31 加固）：
//   - 普通条目大小写不敏感包含；re: 前缀是受限正则
//   - 拒绝可拖垮事件循环的顺序量词/嵌套重复/超大重复/断言/反向引用
//   - 配置加载时清洗（fail-closed），保存时校验
//   - 编译缓存 + 正则输入截断
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesBlacklistKeyword,
  sanitizeBlacklistKeywordRules,
  validateBlacklistKeywordRules
} from '../src/core/keyword-rules.js';

test('普通条目：大小写不敏感包含匹配', () => {
  assert.equal(matchesBlacklistKeyword('这是 SPAM 广告', ['spam']), true);
  assert.equal(matchesBlacklistKeyword('普通聊天', ['spam']), false);
  assert.equal(matchesBlacklistKeyword('', ['spam']), false);
  assert.equal(matchesBlacklistKeyword('x', 'not-an-array'), false);
  assert.equal(matchesBlacklistKeyword('x', []), false);
});

test('re: 前缀：锚定/字符类/单个量词可用', () => {
  assert.equal(matchesBlacklistKeyword('转发限时抽奖', ['re:^转发.*抽奖$']), true);
  assert.equal(matchesBlacklistKeyword('普通聊天', ['re:^转发.*抽奖$']), false);
  assert.equal(matchesBlacklistKeyword('价格 123 元', ['re:^\\D+\\d+\\D+$']), false, '两个不限量词要拒绝');
  assert.equal(matchesBlacklistKeyword('aaaa', ['re:^a{1,10}$']), true);
  assert.equal(validateBlacklistKeywordRules(['re:^转发.*抽奖$']), '');
  // 少量选择点是允许的：`a?` 两个 = 4 种组合；单个 {0,199} = 200 种
  assert.equal(validateBlacklistKeywordRules(['re:^a?b?c$']), '');
  assert.equal(validateBlacklistKeywordRules(['re:^a{0,199}$']), '');
});

test('不安全的正则：顺序量词/嵌套重复/超大重复/断言/反向引用全部拒绝', () => {
  // 这是实测能卡死 10 秒以上的形态：多个并列的 * 在长消息上灾难性回溯
  assert.match(validateBlacklistKeywordRules(['re:^a*a*a*a*a*b$']), /不限长度的量词/);
  assert.match(validateBlacklistKeywordRules(['re:^a+a+a+b$']), /不限长度的量词/);
  assert.match(validateBlacklistKeywordRules(['re:^a{1,}a{2,}b$']), /不限长度的量词/);
  assert.match(validateBlacklistKeywordRules(['re:(a+)+']), /量词|不能重复/);
  // ? 也是量词：^(a?){200}b$ 是嵌套量词爆炸，不能漏检（2026-11-01 盲审）
  assert.match(validateBlacklistKeywordRules(['re:^(a?){200}b$']), /不能重复|变长量词/);
  assert.match(validateBlacklistKeywordRules(['re:(?=广告)广告']), /不支持/);
  assert.match(validateBlacklistKeywordRules(['re:(a)\\1']), /不支持/);
  assert.match(validateBlacklistKeywordRules(['re:^a{1,100000}$']), /上下界/);
  // 顺序量词的变体：多个 {0,n}、一串 a? —— 选择点按乘积预算拒绝（2026-10-31 复审 P1）
  assert.match(validateBlacklistKeywordRules(['re:^a{0,1000}a{0,1000}a{0,1000}b$']), /变长量词组合/);
  assert.match(validateBlacklistKeywordRules(['re:^a{0,100}a{0,100}a{0,100}b$']), /变长量词组合/);
  assert.match(validateBlacklistKeywordRules([`re:^${'a?'.repeat(40)}b$`]), /变长量词组合/);
  assert.match(validateBlacklistKeywordRules(['re:(']), /无效/);
  assert.match(validateBlacklistKeywordRules(['re:']), /不能为空/);
});

test('防御性：即使把不安全规则直接喂给匹配函数，也会被跳过且不卡住', () => {
  const rules = [
    're:^a*a*a*a*a*a*a*a*a*a*b$',
    're:^a{0,1000}a{0,1000}a{0,1000}b$',
    `re:^${'a?'.repeat(40)}b$`
  ];
  const text = 'a'.repeat(3000);
  const started = Date.now();
  for (const rule of rules) assert.equal(matchesBlacklistKeyword(text, [rule]), false);
  assert.ok(Date.now() - started < 200, '不安全规则不能在匹配路径上被编译执行');
});

test('输入截断：正则只看前 2000 字，普通字面量仍全量匹配', () => {
  const padded = 'x'.repeat(2500);
  assert.equal(matchesBlacklistKeyword(`${padded}广告`, ['re:^x+广告$']), false);
  assert.equal(matchesBlacklistKeyword(`${padded}广告`, ['广告']), true);
});

test('sanitize：非法/不安全条目丢弃，合法条目保留，超上限截断', () => {
  const cleaned = sanitizeBlacklistKeywordRules([
    '广告', '', '  ', 're:^转发.*抽奖$', 're:^a*a*a*b$', 're:(', 're:(a+)+', 42
  ]);
  assert.deepEqual(cleaned, ['广告', 're:^转发.*抽奖$', '42']);
  assert.deepEqual(sanitizeBlacklistKeywordRules('not-an-array'), []);
  const many = Array.from({ length: 120 }, (_, i) => `kw${i}`);
  assert.equal(sanitizeBlacklistKeywordRules(many).length, 100);
});

test('编译缓存正确：规则切换后立即生效，不会拿旧正则', () => {
  assert.equal(matchesBlacklistKeyword('广告来了', ['广告']), true);
  assert.equal(matchesBlacklistKeyword('广告来了', ['抽奖']), false);
  assert.equal(matchesBlacklistKeyword('广告来了', ['广告']), true);
  assert.equal(matchesBlacklistKeyword('转发抽奖', ['re:^转发.*抽奖$']), true);
  assert.equal(matchesBlacklistKeyword('转发抽奖', ['re:^广告']), false);
});

test('性能：合法正则匹配 5 万字消息也在毫秒级（只看前 2000 字）', () => {
  // 命中点在前 2000 字内，后面再挂 5 万字的尾巴：正则不应把整条消息都啃一遍
  const text = `转发${'x'.repeat(1990)}抽奖${'y'.repeat(50000)}`;
  const started = Date.now();
  assert.equal(matchesBlacklistKeyword(text, ['re:^转发.*抽奖']), true);
  const cost = Date.now() - started;
  assert.ok(cost < 200, `实际 ${cost}ms`);
});
