import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  LifeFeedManager,
  normalizedLifeFeedConfig,
  resolveInterestChatKeys
} from '../src/features/life-feed.js';
import { buildInterestProfile, tokenize } from '../src/features/life-feed-interest.js';
import { forageBilibili, scoreCandidate } from '../src/features/life-feed-source-bilibili.js';

const NOW = 1792900000000;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-life-feed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function fakeFetch(table) {
  return async (url) => {
    for (const [needle, payload] of table) {
      if (String(url).includes(needle)) {
        return { statusCode: 200, body: JSON.stringify(payload) };
      }
    }
    return { statusCode: 404, body: JSON.stringify({ code: -404, message: 'not found' }) };
  };
}

const POPULAR = {
  code: 0,
  data: {
    list: [
      {
        bvid: 'BV1aa', title: '深海潜水第一视角', desc: '海底 珊瑚', tname: '户外',
        duration: 600, pubdate: NOW / 1000 - 3600, owner: { name: '潜水员', mid: 11 },
        stat: { view: 120000 }
      },
      {
        bvid: 'BV1bb', title: '十秒广告', desc: '广告', tname: '生活',
        duration: 10, pubdate: NOW / 1000 - 600, owner: { name: '广告号', mid: 22 },
        stat: { view: 999999 }
      },
      {
        bvid: 'BV1cc', title: '独立游戏推荐', desc: '新玩法', tname: '游戏',
        duration: 900, pubdate: NOW / 1000 - 7200, owner: { name: '游戏UP', mid: 33 },
        stat: { view: 30000 }
      }
    ]
  }
};

test('配置归一化：夹紧数值、清洗关键词、只保留已知来源', () => {
  const cfg = normalizedLifeFeedConfig({
    enabled: true,
    sources: ['douyin', 'bilibili', 'rss', 'bilibili'],
    rssUrls: ['https://example.com/feed.xml', 'ftp://bad', 'https://example.com/feed.xml'],
    forageIntervalMinutes: 5,
    maxCandidates: 99999,
    maxOffersPerDay: 99,
    minDurationSec: 5000,
    maxDurationSec: 10,
    extraKeywords: ['  深海 ', '', '深海'],
    excludeKeywords: 'not-an-array'
  });
  assert.equal(cfg.forageIntervalMinutes, 5);
  assert.equal(cfg.maxCandidates, 10000);
  assert.equal(cfg.maxOffersPerDay, 99);
  assert.equal(cfg.minDurationSec, 5000);
  assert.equal(cfg.maxDurationSec, 5000);
  assert.deepEqual(cfg.sources, ['bilibili', 'rss']);
  assert.deepEqual(cfg.rssUrls, ['https://example.com/feed.xml']);
  assert.equal(cfg.rssPerForage, 10);
  assert.deepEqual(cfg.extraKeywords, ['深海']);
  assert.deepEqual(cfg.excludeKeywords, []);
});

test('兴趣画像：人设 topics + 群聊高频二元组', () => {
  const profile = buildInterestProfile({
    store: {
      recent: () => [
        { ts: NOW - 1000, text: '最近深海潜水很好看，独立游戏也不错' },
        { ts: NOW - 10 * 86400000, text: '这条太旧了不该进来' }
      ]
    },
    chatKeys: ['group:1'],
    personaTemplateId: 'xiaojingyu',
    now: NOW
  });
  const terms = profile.terms.map((item) => item.term);
  assert.ok(terms.includes('深海'), terms.join(','));
  assert.ok(terms.includes('潜水'), terms.join(','));
  assert.ok(!terms.includes('太旧'), '超出 7 天的消息不参与画像');
  assert.ok(profile.personaTopics.length > 0);
});

test('sources: 缺键用默认 bilibili+plugin，显式空数组表示一个都不开', () => {
  assert.deepEqual(normalizedLifeFeedConfig({}).sources, ['bilibili', 'plugin']);
  assert.deepEqual(normalizedLifeFeedConfig({ sources: [] }).sources, []);
  assert.deepEqual(normalizedLifeFeedConfig({ sources: ['rss'] }).sources, ['rss']);
});

test('tokenize：剥 URL、拉丁词小写、过滤停用词', () => {
  const terms = tokenize('看看 https://b23.tv/abc 这个 DeepSeek 的独立游戏');
  assert.ok(terms.includes('deepseek'));
  assert.ok(terms.includes('独立'));
  assert.ok(!terms.includes('这个'));
});

test('打分：兴趣命中优先于纯播放量', () => {
  const profile = { terms: [{ term: '深海', weight: 3 }] };
  const matched = { title: '深海潜水', desc: '', tags: [], up: '', play: 1000, pubdate: NOW / 1000, duration: 600 };
  const popular = { title: '热门综艺', desc: '', tags: [], up: '', play: 5000000, pubdate: NOW / 1000, duration: 600 };
  assert.ok(scoreCandidate(matched, profile) > scoreCandidate(popular, profile) - 1000);
  assert.ok(scoreCandidate(matched, profile) > 0);
});

test('觅食：热门 + 搜索合并去重，过滤时长与排除词', async () => {
  const fetchImpl = fakeFetch([
    ['popular', POPULAR],
    ['search/type', { code: 0, data: { result: [{ bvid: 'BV1dd', title: '深海 纪录片', description: '海底', duration: '12:34', play: 88, pubdate: NOW / 1000, author: '纪录片UP', mid: 44, tag: '深海,纪录片' }] } }]
  ]);
  const items = await forageBilibili({
    profile: { terms: [{ term: '深海', weight: 3 }], searchTerms: ['深海'] },
    limit: 10,
    minDurationSec: 60,
    maxDurationSec: 3600,
    excludeKeywords: ['广告'],
    fetchImpl
  });
  const ids = items.map((item) => item.id).sort();
  assert.deepEqual(ids, ['BV1aa', 'BV1cc', 'BV1dd']);
  assert.equal(items.find((item) => item.id === 'BV1dd').duration, 754);
});

test('管理器：觅食入库、每日配额、手动分享、状态持久化', async (t) => {
  const dir = tempDir(t);
  const cfg = {
    lifeFeed: {
      enabled: true,
      maxPerForage: 10,
      maxOffersPerDay: 1,
      maxPicksPerDay: 1,
      minDurationSec: 60,
      maxDurationSec: 3600,
      groups: []
    },
    persona: { templateId: 'xiaojingyu' },
    allow: { groups: ['123'] },
    allowAllWhenEmpty: false
  };
  const store = {
    recent: () => [{ ts: NOW - 1000, text: '深海 潜水 独立游戏' }],
    // 与生产一致：store.listChats() 返回字符串数组（store.js: listChats）。
    listChats: () => ['group:123']
  };
  const fetchImpl = fakeFetch([['popular', POPULAR]]);
  const manager = new LifeFeedManager({
    dataDir: dir,
    store,
    config: () => cfg,
    fetchImpl,
    now: () => NOW,
    random: () => 0.5
  });

  const result = await manager.forageNow({ reason: 'test' });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.added >= 2);

  const first = manager.next({ count: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.items[0].title);

  const blocked = manager.next({ count: 1 });
  assert.match(blocked.error, /今天/);

  const manual = manager.takeForShare(first.items[0].id, { manual: true });
  assert.ok(manual.item, manual.error);

  const status = manager.status();
  assert.equal(status.todayOffers, 2);
  assert.equal(status.todayAutoOffers, 1);
  assert.equal(status.todayManualOffers, 1);
  assert.ok(status.candidateCount >= 2);

  // 新实例从磁盘恢复：上次觅食时间与候选都还在
  const reloaded = new LifeFeedManager({ dataDir: dir, store, config: () => cfg, fetchImpl, now: () => NOW });
  const status2 = reloaded.status();
  assert.equal(status2.lastForageAt, NOW);
  assert.equal(status2.candidateCount, status.candidateCount);
});

test('手动分享占位不占自动领取额度：未发送时自动 next 仍可用', async (t) => {
  const dir = tempDir(t);
  const cfg = { lifeFeed: { enabled: true, maxPerForage: 10, maxOffersPerDay: 1, maxPicksPerDay: 1, minDurationSec: 60, maxDurationSec: 3600 } };
  const manager = new LifeFeedManager({
    dataDir: dir, store: null, config: () => cfg,
    fetchImpl: fakeFetch([['popular', POPULAR], ['search/type', { code: 0, data: { result: [] } }]]),
    now: () => NOW, random: () => 0.5
  });
  await manager.forageNow();
  const all = manager.status().candidates;
  assert.ok(all.length >= 2);
  const manual = manager.takeForShare(all[0].id, { manual: true });
  assert.ok(manual.item, manual.error);
  const auto = manager.next({ count: 1 });
  assert.ok(auto.items?.length, '只是点了手动分享（还没发送）不能把自动领取额度一起吃掉');
  const blocked = manager.next({ count: 1 });
  assert.match(blocked.error, /今天/);
});

test('分享名额发送前原子占位：并发时只有一个能拿到最后一次', async (t) => {
  const dir = tempDir(t);
  const cfg = { lifeFeed: { enabled: true, maxPerForage: 10, maxOffersPerDay: 1, maxPicksPerDay: 10, minDurationSec: 60, maxDurationSec: 3600 } };
  const manager = new LifeFeedManager({
    dataDir: dir, store: null, config: () => cfg,
    fetchImpl: fakeFetch([['popular', POPULAR], ['search/type', { code: 0, data: { result: [] } }]]),
    now: () => NOW, random: () => 0.5
  });
  await manager.forageNow();
  const all = manager.status().candidates;
  assert.ok(all.length >= 2);
  assert.ok(manager.reserveShare(all[0].id).item);
  assert.match(String(manager.reserveShare(all[0].id).error), /正在分享中/,
    '同一条候选被两个会话同时分享时必须拒绝第二次');
  assert.match(String(manager.reserveShare(all[1].id).error), /今天已经分享/);
  manager.releaseShare(all[0].id);
  assert.ok(manager.reserveShare(all[1].id).item, '释放后名额应该退回');
});

test('手动分享发送成功后也占用每日上限，不能绕过 maxOffersPerDay', async (t) => {
  const dir = tempDir(t);
  const cfg = { lifeFeed: { enabled: true, maxPerForage: 10, maxOffersPerDay: 1, maxPicksPerDay: 10, minDurationSec: 60, maxDurationSec: 3600 } };
  const manager = new LifeFeedManager({
    dataDir: dir, store: null, config: () => cfg,
    fetchImpl: fakeFetch([['popular', POPULAR], ['search/type', { code: 0, data: { result: [] } }]]),
    now: () => NOW, random: () => 0.5
  });
  await manager.forageNow();
  const all = manager.status().candidates;
  assert.ok(all.length >= 2);
  const first = manager.takeForShare(all[0].id, { manual: true });
  assert.ok(first.item, first.error);
  manager.feedback({ id: all[0].id, action: 'shared', manual: true });
  const second = manager.takeForShare(all[1].id, { manual: true });
  assert.match(String(second.error), /今天已经分享/);
});

test('一次领取的 count 不能冲破剩余领取额度', async (t) => {
  const dir = tempDir(t);
  const cfg = { lifeFeed: { enabled: true, maxPerForage: 10, maxOffersPerDay: 10, maxPicksPerDay: 1, minDurationSec: 60, maxDurationSec: 3600 } };
  const manager = new LifeFeedManager({
    dataDir: dir, store: null, config: () => cfg,
    fetchImpl: fakeFetch([['popular', POPULAR], ['search/type', { code: 0, data: { result: [] } }]]),
    now: () => NOW, random: () => 0.5
  });
  await manager.forageNow();
  const picked = manager.next({ count: 3 });
  assert.equal(picked.items.length, 1, '只剩 1 次领取额度时最多给 1 条');
});

test('管理器：dismiss 进 seen 并从候选移除；重复觅食不重复入队', async (t) => {
  const dir = tempDir(t);
  const cfg = {
    lifeFeed: { enabled: true, maxPerForage: 10, maxOffersPerDay: 3, minDurationSec: 60, maxDurationSec: 3600 },
    persona: { templateId: 'xiaojingyu' },
    allow: { groups: [] }
  };
  const manager = new LifeFeedManager({
    dataDir: dir,
    store: { recent: () => [] },
    config: () => cfg,
    fetchImpl: fakeFetch([['popular', POPULAR]]),
    now: () => NOW,
    random: () => 0.5
  });
  await manager.forageNow();
  const before = manager.status().candidateCount;
  await manager.forageNow();
  assert.equal(manager.status().candidateCount, before, '同一批 BV 不应重复入队');

  const target = manager.status().candidates[0];
  assert.equal(manager.dismiss(target.id).ok, true);
  assert.equal(manager.status().candidates.some((item) => item.id === target.id), false);
  await manager.forageNow();
  assert.equal(manager.status().candidates.some((item) => item.id === target.id), false, 'seen 里的 BV 30 天内不再入队');
});

test('关闭时不创建状态文件，也不起定时器', (t) => {
  const dir = tempDir(t);
  const manager = new LifeFeedManager({
    dataDir: dir,
    config: () => ({ lifeFeed: { enabled: false } }),
    now: () => NOW
  });
  const started = manager.start();
  assert.equal(started.active, false);
  assert.equal(fs.existsSync(path.join(dir, 'life-feed.json')), false);
  manager.stop();
});

test('重启时进行中的觅食标记为 interrupted，不把半个队列当真', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'life-feed.json'), JSON.stringify({
    version: 1, foraging: true, lastError: '', seen: [], candidates: [], offers: [], records: []
  }));
  const manager = new LifeFeedManager({
    dataDir: dir,
    config: () => ({ lifeFeed: { enabled: true } }),
    now: () => NOW
  });
  const status = manager.status();
  assert.match(status.lastError, /interrupted/);
});

test('兴趣画像：结构化播报与他人消息才参与，机器人自己的播报不算兴趣', () => {
  const rows = [
    { ts: NOW - 1000, self: true, text: '今日天气 当前25℃ 体感27℃ 湿度60% 风速3级' },
    { ts: NOW - 1000, self: false, text: '当前气温25℃ 体感27℃ 湿度60% 风速3级 日出06:12 日落18:30' },
    { ts: NOW - 1000, self: false, text: '最近深海潜水很好看' }
  ];
  const profile = buildInterestProfile({
    store: {
      recent: (_chatKey, opts = {}) => rows.filter((row) => opts.includeSelf !== false || !row.self)
    },
    chatKeys: ['group:1'],
    personaTemplateId: 'xiaojingyu',
    now: NOW
  });
  const terms = profile.terms.map((item) => item.term);
  assert.ok(terms.includes('深海'), terms.join(','));
  assert.ok(!terms.includes('气温'), '天气播报的字段词不能进画像');
  assert.ok(!terms.includes('体感'), '机器人自己的播报更不能当成群友兴趣');
  assert.ok(profile.searchTerms.includes('深海与潜水视频'), '搜索词优先人设 topics');
  assert.ok(!profile.searchTerms.includes('天气'));
});

test('觅食搜索词：有人设 topics 时不拿群聊高频词去搜 B 站', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('popular')) return { statusCode: 200, body: JSON.stringify({ code: 0, data: { list: [] } }) };
    return { statusCode: 200, body: JSON.stringify({ code: 0, data: { result: [] } }) };
  };
  await forageBilibili({
    profile: {
      terms: [{ term: '天气', weight: 30 }, { term: '今日', weight: 14 }],
      searchTerms: ['深海与潜水视频', '独立游戏的新玩法']
    },
    limit: 5,
    fetchImpl
  });
  const searches = urls.filter((url) => url.includes('search/type'));
  assert.ok(searches.some((url) => url.includes(encodeURIComponent('深海与潜水视频'))));
  assert.ok(!searches.some((url) => decodeURIComponent(url).includes('keyword=天气')), '群聊高频词不能直接成为搜索词');
});

test('没有 searchTerms 时只拉热门，profile.terms（可能含私聊词）绝不上 wire', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('popular')) return { statusCode: 200, body: JSON.stringify({ code: 0, data: { list: [] } }) };
    return { statusCode: 200, body: JSON.stringify({ code: 0, data: { result: [] } }) };
  };
  await forageBilibili({
    profile: {
      terms: [{ term: '私聊里的秘密词', weight: 30 }],
      searchTerms: []
    },
    limit: 5,
    fetchImpl
  });
  assert.equal(urls.filter((url) => url.includes('search/type')).length, 0);
  assert.ok(!urls.some((url) => decodeURIComponent(url).includes('私聊里的秘密词')));
});

test('候选入库：同一 UP 与同一标签在队列里也限流', async (t) => {
  const dir = tempDir(t);
  const list = Array.from({ length: 15 }, (_, index) => ({
    bvid: `BVW${index}`,
    title: `天气预报 ${index}`,
    desc: '',
    tname: '天气',
    duration: 600,
    pubdate: NOW / 1000,
    owner: { name: `UP${index % 2}`, mid: 100 + (index % 2) },
    stat: { view: 1000 }
  }));
  const manager = new LifeFeedManager({
    dataDir: dir,
    store: null,
    config: () => ({ lifeFeed: { enabled: true, maxCandidates: 200, maxPerForage: 30 } }),
    fetchImpl: fakeFetch([
      ['popular', { code: 0, data: { list } }],
      ['search/type', { code: 0, data: { result: [] } }]
    ]),
    now: () => NOW
  });
  await manager.forageNow();
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'life-feed.json'), 'utf8'));
  assert.ok(state.candidates.length > 0);
  assert.ok(state.candidates.length <= 6, `同一标签最多 8 条且同一 UP 最多 3 条，实际 ${state.candidates.length}`);
  const byUp = new Map();
  for (const item of state.candidates) byUp.set(item.upMid, (byUp.get(item.upMid) || 0) + 1);
  for (const count of byUp.values()) assert.ok(count <= 3);
});

test('share_bilibili：先发标题链接再发封面，并把候选标记为 shared', async (t) => {
  const dir = tempDir(t);
  const list = [{
    bvid: 'BV1share', title: '深海潜水第一视角', desc: '海底',
    tname: '户外', duration: 600, pubdate: NOW / 1000,
    owner: { name: '潜水员', mid: 11 }, stat: { view: '1.2万' },
    pic: '//i0.hdslb.com/bfs/archive/cover.jpg'
  }];
  const manager = new LifeFeedManager({
    dataDir: dir,
    store: null,
    config: () => ({ lifeFeed: { enabled: true } }),
    fetchImpl: fakeFetch([
      ['popular', { code: 0, data: { list } }],
      ['search/type', { code: 0, data: { result: [] } }]
    ]),
    now: () => NOW
  });
  await manager.forageNow();
  const candidate = manager.status().candidates[0];
  assert.equal(candidate.cover, 'https://i0.hdslb.com/bfs/archive/cover.jpg');
  assert.equal(candidate.play, 12000, '中文播放量要能解析');

  const images = [];
  const sent = [];
  const ctx = {
    chatKey: 'group:1',
    session: { id: 's1', leaseId: 'lease', sent: [] },
    getLifeFeed: () => manager,
    sender: {
      sendImage: async (_chatKey, image) => { images.push(image); return { message_id: 1 }; },
      sendTextBatch: async (_chatKey, messages) => {
        sent.push(...messages);
        return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] };
      }
    },
    emit: () => {}
  };
  const { buildToolDefs, executeTool } = await import('../src/tools/tools.js');
  const tool = buildToolDefs().find((item) => item.name === 'share_bilibili');
  assert.ok(tool, '要有 share_bilibili 工具');
  const result = await executeTool([tool], ctx, 'share_bilibili', JSON.stringify({ bvid: 'BV1share', comment: '这个潜水视角很稳' }));
  assert.equal(result.isError, undefined, result.content);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, 'https://i0.hdslb.com/bfs/archive/cover.jpg');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /【B站】深海潜水第一视角/);
  assert.match(sent[0], /UP：潜水员/);
  assert.match(sent[0], /时长 10:00/);
  assert.match(sent[0], /海底/);
  assert.match(sent[0], /BV1share/);
  assert.match(sent[0], /这个潜水视角很稳/);
  assert.equal(ctx.session.sent.length, 1);
  assert.equal(ctx.session.lastShare.bvid, 'BV1share', '分享后要记住 bvid，供补话追问');
  assert.equal(ctx.session.lastShare.messageId, 1, '分享消息 id 要记下来');
  assert.equal(manager.candidate('BV1share'), null, '分享后应从候选队列移除');
});

test('分享配置：模式默认自动，目标群与兴趣来源群相互独立', () => {
  const cfg = normalizedLifeFeedConfig({
    enabled: true,
    shareMode: 'manual',
    shareGroups: ['group:1', 'group:2', 'group:1'],
    groups: ['group:9']
  });
  assert.equal(cfg.shareMode, 'manual');
  assert.deepEqual(cfg.shareGroups, ['group:1', 'group:2']);
  assert.deepEqual(cfg.groups, ['group:9'], '分享目标不能写回兴趣来源群');
  assert.equal(normalizedLifeFeedConfig({ shareMode: 'weird' }).shareMode, 'auto');

  const defaultManager = new LifeFeedManager({
    dataDir: tempDirForOnly(),
    config: () => ({ lifeFeed: { enabled: false } }),
    now: () => NOW
  });
  assert.equal(defaultManager.shareMode(), 'auto');
  assert.equal(defaultManager.isShareTarget('group:123'), true, '空目标 = 交给聊天白名单判断');
});

test('分享目标白名单：配置后只允许列出的群，手动会话仍可分享', async (t) => {
  const dir = tempDir(t);
  const cfg = {
    lifeFeed: { enabled: true, shareMode: 'manual', shareGroups: ['group:1'] }
  };
  // 候选可以从状态文件里预置，避免为了两个守卫跑一次完整觅食。
  fs.writeFileSync(path.join(dir, 'life-feed.json'), JSON.stringify({
    version: 1,
    candidates: [{
      id: 'BVguard', source: 'bilibili', title: '守卫测试', up: 'UP', upMid: 1,
      duration: 600, play: 1000, tags: [], cover: '', url: 'https://www.bilibili.com/video/BVguard',
      desc: '', score: 10, addedAt: NOW
    }],
    offers: [], records: [], seen: []
  }));
  const manager = new LifeFeedManager({ dataDir: dir, config: () => cfg, now: () => NOW });
  assert.equal(manager.shareMode(), 'manual');
  assert.equal(manager.isShareTarget('group:1'), true);
  assert.equal(manager.isShareTarget('group:2'), false);
  assert.equal(manager.isShareTarget('private:9'), false);
  assert.deepEqual(manager.status().shareGroups, ['group:1']);
  assert.equal(manager.status().shareMode, 'manual');

  const { buildToolDefs, executeTool } = await import('../src/tools/tools.js');
  const tool = buildToolDefs().find((item) => item.name === 'share_bilibili');
  const baseCtx = {
    chatKey: 'group:1',
    session: { id: 's1', leaseId: 'lease', sent: [] },
    getLifeFeed: () => manager,
    sender: {
      sendTextBatch: async (_chatKey, messages) => ({
        sent: messages.map((text, i) => ({ text, messageId: i + 1 })), failed: []
      }),
      sendImage: async () => ({ message_id: 1 })
    },
    emit: () => {}
  };

  const autoResult = await executeTool([tool], baseCtx, 'share_bilibili', JSON.stringify({ bvid: 'BVguard' }));
  assert.equal(autoResult.isError, true, '手动模式不能由自动轮次分享');
  assert.match(autoResult.content, /手动分享模式/);
  assert.equal(manager.candidate('BVguard')?.id, 'BVguard', '被拒后候选要保留');

  const targetCtx = {
    ...baseCtx,
    chatKey: 'group:2',
    getLifeFeed: () => ({
      candidate: (id) => manager.candidate(id),
      shareMode: () => 'auto',
      isShareTarget: () => false,
      shareQuotaLeft: () => 1,
      feedback: (args) => manager.feedback(args)
    })
  };
  const wrongGroup = await executeTool([tool], targetCtx, 'share_bilibili', JSON.stringify({ bvid: 'BVguard' }));
  assert.equal(wrongGroup.isError, true, '不在分享目标里的群不能自动分享');
  assert.match(wrongGroup.content, /分享目标/);

  // paced 唤醒带着 manual:true 派发，但它是机器人自己醒的，不是人工，不能绕过手动模式。
  const pacedCtx = { ...baseCtx, paced: true, session: { ...baseCtx.session, manual: true } };
  const pacedResult = await executeTool([tool], pacedCtx, 'share_bilibili', JSON.stringify({ bvid: 'BVguard' }));
  assert.equal(pacedResult.isError, true, '自主节奏唤醒不能借 manual 标记分享');
  assert.match(pacedResult.content, /手动分享模式/);

  const nextTool = buildToolDefs().find((item) => item.name === 'life_feed_next');
  const autoNext = await executeTool([nextTool], baseCtx, 'life_feed_next', JSON.stringify({ count: 1 }));
  assert.equal(autoNext.isError, true, '手动模式下自动轮次也不能领取候选');
  assert.match(autoNext.content, /手动分享模式/);

  const manualCtx = { ...baseCtx, session: { ...baseCtx.session, manual: true } };
  const manualResult = await executeTool([tool], manualCtx, 'share_bilibili', JSON.stringify({ bvid: 'BVguard' }));
  assert.equal(manualResult.isError, undefined, manualResult.content);
  assert.equal(manager.candidate('BVguard'), null);
  const sharedRecord = manager.status();
  assert.equal(sharedRecord.todayShares, 1);
  assert.equal(manager.shareQuotaLeft(), 1, '真正发送成功的分享仍占每日防刷屏额度');
});

test('兴趣来源支持私聊：显式名单优先，否则沿用白名单里的群 + 私聊', () => {
  assert.deepEqual(resolveInterestChatKeys({ groups: ['private:9', '42'] }), ['private:9', 'group:42']);
  assert.deepEqual(
    resolveInterestChatKeys({ allow: { groups: ['1'], private: ['9'] } }),
    ['group:1', 'private:9'],
    '没配置显式来源时，白名单里的私聊也参与提炼'
  );
  assert.deepEqual(resolveInterestChatKeys({ allow: { groups: [], private: [] } }), []);
  assert.deepEqual(
    resolveInterestChatKeys({
      allowAllWhenEmpty: true,
      allChats: ['group:1', 'private:9', 'weird', 'group:1']
    }),
    ['group:1', 'private:9'],
    '允许所有会话时只取规范的 group:/private: 键并去重'
  );
  assert.deepEqual(
    resolveInterestChatKeys({ allowAllWhenEmpty: false, allChats: ['group:1'] }),
    [],
    '开关是配置顶层字段，不能从 allow 里猜'
  );
  assert.deepEqual(
    resolveInterestChatKeys({ groups: ['group：9'], allow: { groups: ['1'] } }),
    ['group:1'],
    '非法显式条目不能算"配过来源"、把白名单回退吃掉'
  );
  assert.deepEqual(
    resolveInterestChatKeys({ groups: ['group:1', 'group:2'], denied: new Set(['group:2']) }),
    ['group:1'],
    'deny 的会话不参与兴趣提炼'
  );
});

test('插件 inbox 全是已吸收条目时不再重建兴趣画像（惰性求值）', (t) => {
  const dir = tempDir(t);
  const inbox = path.join(dir, 'life-feed-inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'p1.json'), JSON.stringify({
    pluginId: 'p1',
    items: [{ id: 'BVknown', title: '已知条目', url: 'https://www.bilibili.com/video/BVknown' }]
  }));
  fs.writeFileSync(path.join(dir, 'life-feed.json'), JSON.stringify({
    version: 1, candidates: [], seen: [{ id: 'BVknown', at: NOW }], offers: [], records: []
  }));
  let recentCalls = 0;
  const cfg = {
    lifeFeed: { enabled: true, sources: ['plugin'], groups: ['group:1'] },
    allow: { groups: ['1'] }
  };
  const manager = new LifeFeedManager({
    dataDir: dir,
    store: { recent: () => { recentCalls += 1; return []; }, listChats: () => ['group:1'] },
    config: () => cfg,
    now: () => NOW
  });
  assert.equal(manager.drainInbox(), 0, '所有条目都已吸收过');
  assert.equal(recentCalls, 0, '没有新条目就不该读会话历史/重建画像（控制台刷新会反复触发）');
});

test('兴趣来源：白名单为空且允许所有会话时，按会话表提炼并跳过被屏蔽的会话', async (t) => {
  const dir = tempDir(t);
  const requested = [];
  const cfg = {
    lifeFeed: { enabled: true, sources: ['rss'], groups: [], rssUrls: [] },
    allow: { groups: [], private: [] },
    deny: { groups: ['2'], private: [] },
    allowAllWhenEmpty: true
  };
  const store = {
    recent: (key) => { requested.push(key); return []; },
    listChats: () => ['group:1', 'group:2', 'private:9', 'weird']
  };
  const manager = new LifeFeedManager({ dataDir: dir, store, config: () => cfg, now: () => NOW });
  const result = await manager.forageNow({ reason: 'test' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([...requested].sort(), ['group:1', 'private:9'],
    '只读规范会话键，deny 里的 group:2 与非会话键 weird 都不能进画像');
});

test('分享目标支持私聊：群与 private:<QQ> 共用一份名单，老配置的裸群号照旧生效', () => {
  const cfg = normalizedLifeFeedConfig({
    enabled: true,
    shareGroups: ['group:1', 'private:9', '42', 'private:9']
  });
  assert.deepEqual(cfg.shareGroups, ['group:1', 'private:9', 'group:42'], '去重并把裸群号补成 group:');
  const manager = new LifeFeedManager({
    dataDir: tempDirForOnly(),
    config: () => ({ lifeFeed: cfg }),
    now: () => NOW
  });
  assert.equal(manager.isShareTarget('private:9'), true, '配置了私聊目标，私聊会话可以自动分享');
  assert.equal(manager.isShareTarget('group:42'), true, '裸群号按群处理');
  assert.equal(manager.isShareTarget('group:1'), true);
  assert.equal(manager.isShareTarget('private:8'), false, '未列出的私聊仍然不行');
  assert.equal(manager.isShareTarget('group:9'), false, '私聊目标不能顺带放行同号群');
});

function tempDirForOnly() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-life-feed-'));
  process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}
