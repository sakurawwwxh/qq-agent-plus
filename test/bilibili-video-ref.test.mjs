// B 站视频输入归一化：分享卡片已能保留 URL，插件必须把完整链接和 b23.tv 短链
// 收敛回 view API 的 bvid/aid 参数；坏 URL 不能进入宿主 HTTP。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseVideoRef,
  extractCanonicalHref,
  resolveVideoQuery
} from '../examples/plugins/bilibili/video-ref.mjs';

const BVID = 'BV1xx411c7mD';

test('裸 BVID 与 av 号归一化', () => {
  assert.deepEqual(parseVideoRef(BVID), { query: `bvid=${BVID}` });
  assert.deepEqual(parseVideoRef('bv1xx411c7mD'), { query: `bvid=${BVID}` });
  assert.deepEqual(parseVideoRef('bv1xx411c7md'), { query: 'bvid=BV1xx411c7md' },
    '只规范 BV 前缀，视频号主体的大小写保持原样');
  assert.deepEqual(parseVideoRef('av170001'), { query: 'aid=170001' });
  assert.deepEqual(parseVideoRef('AV170001'), { query: 'aid=170001' });
});

test('完整 B 站视频 URL 在本地归一化，query 与尾斜杠不影响 BVID', () => {
  assert.deepEqual(parseVideoRef(`https://www.bilibili.com/video/${BVID}/?p=2&share_source=qq`), {
    query: `bvid=${BVID}`
  });
  assert.deepEqual(parseVideoRef('https://www.bilibili.com/video/bv1xx411c7mD'), {
    query: `bvid=${BVID}`
  });
  assert.deepEqual(parseVideoRef('https://m.bilibili.com/video/av170001'), { query: 'aid=170001' });
  assert.deepEqual(parseVideoRef(`http://bilibili.com/video/${BVID}`), { query: `bvid=${BVID}` });
});

test('b23.tv 路径中直接带视频号时无需网络；不透明短码只交给宿主一次', () => {
  assert.deepEqual(parseVideoRef(`https://b23.tv/${BVID}/p7`), { query: `bvid=${BVID}` });
  assert.deepEqual(parseVideoRef('https://b23.tv/av170001'),
    { query: 'aid=170001' });
  assert.deepEqual(parseVideoRef('https://b23.tv/AbCdEf1?share_source=qq'),
    { shortUrl: 'https://b23.tv/AbCdEf1' });
});

test('只接受明确的 B 站视频链接，拒绝仿冒域、凭据、端口和其他资源', () => {
  const invalid = [
    '',
    'https://evil.example/video/BV1xx411c7mD',
    'https://bilibili.com.example.org/video/BV1xx411c7mD',
    'https://user:secret@www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com:444/video/BV1xx411c7mD',
    'ftp://www.bilibili.com/video/BV1xx411c7mD',
    'javascript:alert(1)',
    'https://www.bilibili.com/bangumi/play/ep12345',
    'https://www.bilibili.com/video/BV1xx411c7mD/extra',
    'BV123',
    'BV1xx411c7mDextra',
    'https://b23.tv/',
    'https://b23.tv/AbCdEf1/extra'
  ];
  for (const value of invalid) assert.equal(parseVideoRef(value), null, value);
});

test('canonical 解析不依赖属性顺序、引号形式或大小写', () => {
  assert.equal(
    extractCanonicalHref(`<head><link href='https://www.bilibili.com/video/${BVID}/?p=2' data-x="1" rel='alternate CANONICAL'></head>`),
    `https://www.bilibili.com/video/${BVID}/?p=2`
  );
  assert.equal(
    extractCanonicalHref(`<link rel=canonical href=https://www.bilibili.com/video/${BVID}>`),
    `https://www.bilibili.com/video/${BVID}`
  );
  assert.equal(extractCanonicalHref('<link rel="alternate" href="https://example.com/">'), '');
  assert.equal(
    extractCanonicalHref(`<link data-href="https://evil.example/" href="https://www.bilibili.com/video/${BVID}" rel="canonical">`),
    `https://www.bilibili.com/video/${BVID}`,
    'data-href 不能被当成 href'
  );
  assert.equal(
    extractCanonicalHref(`<link data-rel="canonical" href="https://evil.example/"><link rel="canonical" href="https://www.bilibili.com/video/${BVID}">`),
    `https://www.bilibili.com/video/${BVID}`,
    'data-rel 不能被当成 rel'
  );
  assert.equal(
    extractCanonicalHref(`<link href="https://www.bilibili.com/video/${BVID}/?rel=canonical" rel="canonical">`),
    `https://www.bilibili.com/video/${BVID}/?rel=canonical`,
    'href 值里的 rel=canonical 不能被误当成属性'
  );
  assert.equal(
    extractCanonicalHref(`<link rel="canonical"href="https://www.bilibili.com/video/${BVID}">`),
    `https://www.bilibili.com/video/${BVID}`,
    '浏览器能容错属性间缺空格，解析器也不该直接失败'
  );
});

test('相对 / 协议相对 canonical 按 B 站站内基准解析', async () => {
  const request = (href) => async () => ({ status: 200, body: `<link rel="canonical" href="${href}">` });
  assert.equal(await resolveVideoQuery('https://b23.tv/AbCdEf1', request(`/video/${BVID}`)), `bvid=${BVID}`);
  assert.equal(await resolveVideoQuery('https://b23.tv/AbCdEf1', request(`//www.bilibili.com/video/${BVID}`)), `bvid=${BVID}`);
  await assert.rejects(
    () => resolveVideoQuery('https://b23.tv/AbCdEf1', request(`//evil.example/video/${BVID}`)),
    /没有解析到有效视频地址/
  );
});

test('不透明短链经注入的宿主请求解析 canonical，本地输入不调用网络', async () => {
  const calls = [];
  const request = async ({ url }) => {
    calls.push(url);
    return {
      status: 200,
      body: `<html><head><link rel="canonical" href="https://www.bilibili.com/video/${BVID}/?p=2"></head></html>`
    };
  };

  assert.equal(await resolveVideoQuery('https://b23.tv/AbCdEf1', request), `bvid=${BVID}`);
  assert.deepEqual(calls, ['https://b23.tv/AbCdEf1']);

  calls.length = 0;
  assert.equal(await resolveVideoQuery(`https://www.bilibili.com/video/${BVID}`, request), `bvid=${BVID}`);
  assert.deepEqual(calls, [], '完整视频 URL 不应再请求短链');
});

test('短链 HTTP 成功但没有有效 canonical 时明确失败', async () => {
  await assert.rejects(
    () => resolveVideoQuery('https://b23.tv/AbCdEf1', async () => ({ status: 200, body: '<html>not found</html>' })),
    /没有解析到有效视频地址/
  );
  await assert.rejects(
    () => resolveVideoQuery('https://b23.tv/AbCdEf1', async () => ({
      status: 200,
      body: '<link rel="canonical" href="https://evil.example/video/BV1xx411c7mD">'
    })),
    /没有解析到有效视频地址/
  );
  await assert.rejects(
    () => resolveVideoQuery('https://b23.tv/AbCdEf1', async () => ({ status: 412, body: '' })),
    /HTTP 412/
  );
});
