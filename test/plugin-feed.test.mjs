import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 必须在加载 src 之前重定向数据目录：capabilities/config 首次 import 就可能触发
// 稳定特性迁移并把默认 data/config.json 落盘（2026-11-03 全量审查 P1）。
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-feed-test-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { createCapabilities } = await import('../src/plugins/capabilities.js');
const { CAP_METHODS } = await import('../src/plugins/protocol.js');
const { LifeFeedManager } = await import('../src/features/life-feed.js');

const NOW = 1792900000000;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-feed-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

test('cap.feed.publish：只收公开元数据、按 id 去重、每插件每天 20 条', (t) => {
  const dir = tempDir(t);
  const caps = createCapabilities({
    pluginId: 'demo',
    dataDir: dir,
    manifest: { capabilities: ['feed'] },
    now: () => NOW
  });
  const result = caps.methods[CAP_METHODS.feedPublish]({
    items: [
      { id: 'p1', title: '插件见闻', url: 'https://example.com/p1', up: 'UP', durationSec: 120, tags: ['游戏'], summary: '摘要', cover: 'https://example.com/c.jpg' },
      { id: 'p1', title: '重复', url: 'https://example.com/dup' },
      { id: 'bad', title: '没有链接', url: 'ftp://example.com/x' }
    ]
  });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'life-feed-inbox', 'demo.json'), 'utf8'));
  assert.equal(saved.pluginId, 'demo');
  assert.equal(saved.items[0].source, 'plugin:demo');
  assert.equal(saved.items[0].title, '插件见闻');
  assert.equal(saved.items[0].cover, 'https://example.com/c.jpg', 'https 封面要保留');

  // 同一天再发同一个 id：不重复收
  const again = caps.methods[CAP_METHODS.feedPublish]({ items: [{ id: 'p1', title: 'x', url: 'https://example.com/p1' }] });
  assert.equal(again.accepted, 0);
});

test('cap.feed.publish：内网封面地址被丢弃（协议端会去取，不能当 SSRF 跳板）', async (t) => {
  const { getConfig } = await import('../src/core/config.js');
  if (getConfig().security?.allowPrivateImageHosts === true) {
    t.skip('本机配置显式允许私网图片');
    return;
  }
  const dir = tempDir(t);
  const caps = createCapabilities({ pluginId: 'demo', dataDir: dir, manifest: { capabilities: ['feed'] }, now: () => NOW });
  const result = caps.methods[CAP_METHODS.feedPublish]({ items: [
    { id: 'p1', title: '本机', url: 'https://example.com/p1', cover: 'https://127.0.0.1:8443/a.jpg' },
    { id: 'p2', title: '元数据', url: 'https://example.com/p2', cover: 'https://169.254.169.254/latest/meta-data/' }
  ] });
  assert.equal(result.accepted, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'life-feed-inbox', 'demo.json'), 'utf8'));
  assert.deepEqual(saved.items.map((item) => item.cover), ['', ''], '内网封面必须清空，只保留安全地址');
});

test('生活层会吸收插件的见闻候选，并参与正常的分享选择', async (t) => {
  const dir = tempDir(t);
  // 先由插件写 inbox
  const caps = createCapabilities({
    pluginId: 'demo', dataDir: dir, manifest: { capabilities: ['feed'] }, now: () => NOW
  });
  caps.methods[CAP_METHODS.feedPublish]({
    items: [{ id: 'p1', title: '插件提交的见闻', url: 'https://example.com/p1', tags: ['游戏'], summary: '来自插件', cover: 'https://example.com/p1.jpg' }]
  });

  const cfg = {
    lifeFeed: {
      enabled: true, maxCandidates: 20, maxPerForage: 10, maxOffersPerDay: 2,
      minDurationSec: 0, maxDurationSec: 3600
    },
    persona: {},
    allow: { groups: [] }
  };
  const manager = new LifeFeedManager({
    dataDir: dir,
    store: { recent: () => [], listChats: () => [] },
    config: () => cfg,
    fetchImpl: async () => ({ statusCode: 200, body: JSON.stringify({ code: 0, data: { list: [] } }) }),
    now: () => NOW,
    random: () => 0.5
  });

  const result = await manager.forageNow({ reason: 'test' });
  assert.equal(result.ok, true, result.error);
  const status = manager.status();
  const item = status.candidates.find((candidate) => candidate.id === 'p1');
  assert.ok(item, '插件候选应进入队列');
  assert.equal(item.source, 'plugin:demo');
  assert.equal(item.cover, 'https://example.com/p1.jpg', '插件封面要透传到候选');

  const picked = manager.next({ count: 1 });
  assert.equal(picked.items[0].id, 'p1');

  // inbox 文件同时是插件的"当天 20 条/去重"状态，吸收后不能删；新实例读到它应仍认为 p1 已提交。
  assert.ok(fs.existsSync(path.join(dir, 'life-feed-inbox', 'demo.json')), '吸收后要保留插件配额状态文件');
  const caps2 = createCapabilities({
    pluginId: 'demo', dataDir: dir, manifest: { capabilities: ['feed'] }, now: () => NOW
  });
  const duplicate = caps2.methods[CAP_METHODS.feedPublish]({
    items: [{ id: 'p1', title: '重复', url: 'https://example.com/p1' }]
  });
  assert.equal(duplicate.accepted, 0, '插件当天的去重状态不能因为宿主吸收而丢失');
});
