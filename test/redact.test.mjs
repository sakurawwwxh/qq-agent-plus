// 日志脱敏口径（src/core/redact.js）：incident-pilot 入库与 orchestrator 写 journal 共用。
// 背景：orchestrator 会把工具错误原文写进 journald，而 OneBot 的 access_token 挂在 URL
// 查询串上（src/onebot/onebot.js），真带上了就得在写日志这一步拦住。
import assert from 'node:assert/strict';
import test from 'node:test';

import { redactText } from '../src/core/redact.js';

test('redactText：Bearer 头与查询串里的令牌参数一律脱敏', () => {
  // 既有口径：Bearer 后面到空白为止全吃掉（连同结尾引号），这里保持原样不改语义
  const bearer = redactText('headers: {"authorization": "Bearer abc.def-123"}');
  assert.ok(!bearer.includes('abc.def-123'), '令牌本身不能留在文本里');
  assert.equal(bearer, 'headers: {"authorization": "Bearer [redacted]');
  // 本项目 OneBot 实际用的参数名（带下划线前缀，旧的纯 token/key 正则匹配不到）
  assert.equal(redactText('ws://127.0.0.1:3001/?access_token=SECRET123&x=1'), 'ws://127.0.0.1:3001/?access_token=[redacted]&x=1');
  assert.equal(redactText('GET /api?a=1&api_key=abcd1234'), 'GET /api?a=1&api_key=[redacted]');
  assert.equal(redactText('?apikey=k1&token=t2&secret=s3&password=p4&authorization=a5'),
    '?apikey=[redacted]&token=[redacted]&secret=[redacted]&password=[redacted]&authorization=[redacted]');
  // 百度换 token 的实际形态（asr-baidu.js）：client_id / client_secret 带下划线前缀
  assert.equal(redactText('POST /oauth/token?grant_type=client_credentials&client_id=AK123&client_secret=SK456'),
    'POST /oauth/token?grant_type=client_credentials&client_id=[redacted]&client_secret=[redacted]');
  // session-key 这类连字符/下划线变体也认
  assert.equal(redactText('GET /a?session-key=xyz'), 'GET /a?session-key=[redacted]');
});

test('redactText：JSON 体与 Basic/Cookie 头形态', () => {
  // 错误信息里原样回显请求体时的兜底（命中面故意偏宽，宁多脱勿漏）
  assert.equal(redactText('request body: {"apiKey":"abc123","model":"deepseek-v4"}'),
    'request body: {"apiKey":"[redacted]","model":"deepseek-v4"}');
  assert.equal(redactText('{"client_secret":"sk-abc","note":"keep"}'),
    '{"client_secret":"[redacted]","note":"keep"}');
  assert.equal(redactText('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic [redacted]');
  assert.match(redactText('Cookie: session=abc123; next'), /^Cookie: \[redacted\]/);
  // reasoning_effort 这类非敏感键不动
  assert.equal(redactText('{"reasoning_effort":"low"}'), '{"reasoning_effort":"low"}');
});

test('redactText：裸的 sk-/pk-/rk- 密钥前缀也脱敏（2026-09-30 #6 补）', () => {
  // 前面的查询串/JSON 形态拦不住"裸串"：错误文本、粘贴的配置里经常就是 key=sk-… 这种形态
  assert.equal(redactText('Authorization failed, key sk-abc123XYZ456789 rejected'),
    'Authorization failed, key sk-[redacted] rejected');
  assert.equal(redactText('pk_live_1234567890 and rk-test-abcdefgh'), 'pk-[redacted] and rk-[redacted]');
  // 太短的（不足 8 位）不误伤，避免把普通词吃掉
  assert.equal(redactText('sk-short'), 'sk-short');
  assert.equal(redactText('ask-something-long'), 'ask-something-long');
});

test('redactText：不该动的文本原样保留（只截断/去空字符）', () => {
  // 参数名相似的普通词不能误伤（前缀必须是 ? 或 &，且名字要对上）
  assert.equal(redactText('monkey=13 & tokenizer=x'), 'monkey=13 & tokenizer=x');
  assert.equal(redactText(`温度\u0000记录`), '温度记录');
  // max 截断与 trim
  assert.equal(redactText('   abcdef  ', 3), 'abc');
});

test('redactText：Cookie 多段、x-api-key 与 URL 里的 user:pass 也要脱敏（2026-10-30 交叉审查）', () => {
  // 旧规则 \S+ 只吃掉第一对，后面几对 skey/p_skey 会明文留下
  const cookie = redactText('Cookie: uin=o123; skey=SECRET1; p_skey=SECRET2');
  assert.equal(cookie, 'Cookie: [redacted]');
  assert.ok(!cookie.includes('SECRET1') && !cookie.includes('SECRET2'));

  // 头形式的 api key / authorization: Token 不在 Bearer|Basic 规则里
  assert.equal(redactText('x-api-key: abcd1234'), 'x-api-key: [redacted]');
  assert.equal(redactText('api-key: abcd1234'), 'api-key: [redacted]');
  assert.equal(redactText('authorization: Token abcd1234'), 'authorization: [redacted]');

  // URL 里内嵌的凭据（既不是查询串也不是头）
  const url = redactText('fetch https://user:pa55word@example.com/path');
  assert.ok(!url.includes('pa55word'));
  assert.ok(url.startsWith('fetch https://[redacted]@example.com'));

  // JSON 里带连字符的键名（x-api-key / api-key）也要认
  assert.equal(redactText('{"x-api-key":"abcd1234"}'), '{"x-api-key":"[redacted]"}');
  // 已经脱敏过的值不重复处理（幂等）
  assert.equal(redactText(redactText('x-api-key: abcd1234')), 'x-api-key: [redacted]');
});
