import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-manager-'));
process.env.QQ_AGENT_DATA_DIR = root;
fs.writeFileSync(path.join(root, 'stickers.json'), JSON.stringify([{
  id: 'collected_1701183958',
  resId: 'collected_1701183958',
  url: 'https://multimedia.nt.qq.com.cn/download?fileid=old&rkey=expired',
  source: 'ai',
  desc: 'test sticker'
}]));

const { StickerManager } = await import('../src/onebot/sticker-manager.js');
const { buildToolDefs } = await import('../src/tools/tools.js');
const { buildStickerContext, buildStickerStrategyHint, findSticker } = await import('../src/onebot/stickers.js');

test('refreshes a collected QQ image URL from its source message before sending', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const manager = new StickerManager({
    async call(action) {
      assert.equal(action, 'fetch_custom_face_detail');
      return [];
    },
    async getMsg(messageId) {
      calls.push(messageId);
      return {
        message: [{
          type: 'image',
          data: {
            url: 'https://multimedia.nt.qq.com.cn/download?fileid=fresh&rkey=current'
          }
        }]
      };
    }
  });

  const cached = manager.peek('collected_1701183958');
  assert.equal(cached.id, 'collected_1701183958');
  assert.deepEqual(calls, [], '只读观测本地快照不应触发 OneBot');

  const sticker = await manager.findForSend('collected_1701183958');

  assert.deepEqual(calls, [1701183958]);
  assert.match(sticker.url, /rkey=current$/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8'));
  assert.match(saved[0].url, /rkey=current$/);
});

test('manual uploaded stickers can be viewed and sent by agent tools', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new StickerManager({ call: async () => [] });
  const sticker = manager.addManual({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '本地测试'
  });
  const sent = [];
  const context = {
    chatKey: 'group:1',
    stickers: manager,
    sender: {
      sendSticker: async (_chatKey, value) => {
        sent.push(value);
        return { message_id: 7 };
      }
    },
    session: { leaseId: 'lease', triggerText: '测试', sent: [] },
    emit: () => {}
  };
  const tools = buildToolDefs();
  const send = tools.find((tool) => tool.name === 'send_sticker');
  const view = tools.find((tool) => tool.name === 'get_sticker_image');
  const sendResult = await send.execute(context, { stickerId: sticker.id });
  assert.equal(sendResult.isError, undefined);
  assert.match(sent[0].url, /^base64:\/\//);
  const viewResult = await view.execute(context, { stickerId: sticker.id });
  assert.equal(viewResult.isError, undefined);
  assert.equal(viewResult.content[1].type, 'image_url');
  assert.match(viewResult.content[1].image_url.url, /^data:image\/png;base64,/);

  const webp = manager.addManual({
    imageBuffer: Buffer.from('524946460400000057454250', 'hex'),
    desc: 'WebP 测试'
  });
  const webpSendResult = await send.execute(context, { stickerId: webp.id });
  assert.equal(webpSendResult.isError, undefined);
  assert.match(sent[1].url, /^base64:\/\//);
  const webpViewResult = await view.execute(context, { stickerId: webp.id });
  assert.equal(webpViewResult.isError, undefined);
  assert.match(webpViewResult.content[1].image_url.url, /^data:image\/webp;base64,/);
});

test('refuses to overwrite a corrupted sticker metadata file', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  const metadataFile = path.join(root, 'stickers.json');
  const corrupted = '{"id":';
  fs.writeFileSync(metadataFile, corrupted);
  const manager = new StickerManager({ call: async () => [] });

  assert.throws(() => manager.addManual({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '不应写入'
  }), /表情库读取失败，已停止写入/);
  assert.equal(fs.readFileSync(metadataFile, 'utf8'), corrupted);
  assert.equal(fs.existsSync(path.join(root, 'sticker-assets')), false);
});

test('reports pending cleanup when a deleted sticker image cannot be removed', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  const manager = new StickerManager({ call: async () => [] });
  const sticker = manager.addManual({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '待删除'
  });
  const imageFile = path.join(root, manager.entries.find((entry) =>
    entry.id === sticker.id).localFile);
  const originalRmSync = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.resolve(target) === path.resolve(imageFile)) {
      throw new Error('simulated cleanup failure');
    }
    return originalRmSync(target, options);
  });

  const result = manager.remove(sticker.id);
  t.mock.restoreAll();

  assert.equal(result.removed, true);
  assert.equal(result.cleanupPending, true);
  assert.match(result.warning, /simulated cleanup failure/);
  assert.equal(manager.peek(sticker.id), null);
  assert.equal(fs.existsSync(imageFile), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8')), []);
});

test('prompt exposes sticker IDs and exact unique labels remain compatible', () => {
  const entries = [
    { id: 'sticker-1', desc: '无语团子', localNote: '', url: 'https://example.com/1.png' },
    { id: 'sticker-2', desc: '开心团子', localNote: '庆祝', url: 'https://example.com/2.png' }
  ];
  const prompt = buildStickerContext(entries, 10);
  assert.match(prompt, /无语团子.*stickerId：sticker-1/);
  assert.equal(findSticker(entries, '无语团子')?.id, 'sticker-1');
  assert.equal(findSticker(entries, '庆祝')?.id, 'sticker-2');
  assert.equal(findSticker([
    ...entries,
    { id: 'sticker-3', desc: '无语团子', url: 'https://example.com/3.png' }
  ], '无语团子'), null);
});

test('sticker list keeps familiar ones and rotates unused ones in', () => {
  // 复现用户反馈的场景：收藏很多，但发过的图永远占住名额，其余永远不露面。
  const entries = [];
  for (let i = 1; i <= 40; i++) {
    entries.push({
      id: `st-${String(i).padStart(2, '0')}`,
      desc: i <= 20 ? `备注${i}` : '',
      url: `https://example.com/${i}.png`,
      // 前 6 个用过；其中 1~3 是最近发过的，4~6 是更早发过的
      useCount: i <= 6 ? 3 : 0,
      lastUsedAt: i <= 3 ? 1_700_000_000_000 + i : (i <= 6 ? 1_600_000_000_000 + i : 0),
      createdAt: new Date(1_700_000_000_000 + i).toISOString()
    });
  }
  const ids = (text) => [...text.matchAll(/stickerId：([\w-]+)/g)].map((m) => m[1]);
  const prompt = buildStickerContext(entries, 10);
  const shown = ids(prompt);
  assert.equal(shown.length, 10, '清单条数按 max 取满');
  // 常用位（前一半）：只放用过的，按次数与最近使用排
  assert.deepEqual(shown.slice(0, 5).sort(), ['st-01', 'st-02', 'st-03', 'st-05', 'st-06']);
  // 轮换位：没用过的顶上来了（改造前这里是"发过的占满、其余永不出现"）
  assert.ok(shown.slice(5).every((id) => Number(id.slice(3)) > 6),
    `轮换位应全是没用过的，实际：${shown.join(',')}`);
  // 没用过的会标出来，模型才知道可以直接试
  assert.match(prompt, /（没用过）（stickerId：st-\d+）/);
  // 幂等：同一份库连着渲染两次结果完全一致（这段清单常驻系统提示、属于缓存前缀）
  assert.equal(buildStickerContext(entries, 10), prompt);
  // 用掉一张轮换位上的图 → 下一张没用过的顶上来
  const afterUse = entries.map((e) => e.id === 'st-07' ? { ...e, useCount: 1, lastUsedAt: Date.now() } : e);
  const next = ids(buildStickerContext(afterUse, 10));
  assert.equal(next.length, 10);
  assert.ok(!next.includes('st-07'), '用过的图离开轮换位');
  assert.ok(next.includes('st-12'), `下一张没用过的应补进来，实际：${next.join(',')}`);
  // 上限 60：手改配置写大了也不会把整库塞进提示词
  const big = [];
  for (let i = 0; i < 200; i++) big.push({ id: `b-${i}`, url: `https://example.com/b${i}.png` });
  assert.equal(ids(buildStickerContext(big, 500)).length, 60);
  assert.equal(ids(buildStickerContext(entries, 500)).length, 40);
});

test('全新表情库：不说"前几个是常用的"，也不让超长备注吃满提示词', () => {
  // 库刚建起来时前一半也没有用过的 —— 文案写"前 N 个是常用的"会与逐行的（没用过）打架（2026-09-26 审查）
  const fresh = [];
  for (let i = 1; i <= 12; i++) {
    fresh.push({ id: `n-${i}`, desc: `备注${i}`, url: `https://example.com/${i}.png`, useCount: 0, lastUsedAt: 0 });
  }
  const prompt = buildStickerContext(fresh, 10);
  assert.equal(prompt.includes('是常用的'), false, '一句"常用的"都不能有');
  assert.match(prompt, /都还没用过/);

  // 单行上限：备注 300 字（入库上限）也不该原样进提示词，否则 60 条 × 300 字 ≈ 1.8 万字符
  const long = [{ id: 'long-1', desc: '长'.repeat(300), url: 'https://example.com/l.png', useCount: 1, lastUsedAt: 1 }];
  const line = buildStickerContext(long, 1);
  assert.ok(line.includes('长'.repeat(60)), '前 60 字保留');
  assert.equal(line.includes('长'.repeat(61)), false, '第 61 字起截断');
  assert.match(line, /…/);
});

test('prompt never teaches get_sticker_image when image input is off', () => {
  // 关闭图片输入时 get_sticker_image 会被从工具表里摘掉（orchestrator 的工具过滤）：
  // 提示词再提它就是"教模型调一个不存在的工具"，而没备注的图那种配置下本来也看不懂。
  const entries = [
    { id: 'st-1', desc: '无语团子', url: 'https://example.com/1.png', useCount: 2 },
    { id: 'st-2', desc: '', url: 'https://example.com/2.png' }
  ];
  const withVision = buildStickerContext(entries, 10);
  assert.match(withVision, /get_sticker_image/);
  assert.match(withVision, /可先看图/, '能看图时才说"可先看图"');
  const noVision = buildStickerContext(entries, 10, { vision: false });
  assert.doesNotMatch(noVision, /get_sticker_image/);
  assert.doesNotMatch(noVision, /可先看图/);
  assert.match(noVision, /无语团子/, '有备注的仍然要列出来');
  assert.doesNotMatch(noVision, /st-2/, '没备注且看不到图的图不占清单名额');
  // 一张有备注的都没有时整段不出现（否则会留下一串看不懂的 id）
  assert.equal(buildStickerContext([{ id: 'st-9', url: 'https://example.com/9.png' }], 10, { vision: false }), '');
  // 策略段同理：两种配置都不能提那个工具
  assert.match(buildStickerStrategyHint(2), /get_sticker_image/);
  assert.doesNotMatch(buildStickerStrategyHint(2, { vision: false }), /get_sticker_image/);
});


test('库大而用过的少时，清单多带没用过的进来（用户反馈"还是用旧表情包"）', () => {
  // 39 张里只有 11 张用过 —— 常用位原来固定占一半名额，每次都是同一批老图排最前
  const entries = [];
  for (let i = 1; i <= 39; i += 1) {
    entries.push({
      id: `s${String(i).padStart(2, '0')}`, desc: `备注${i}`, url: `https://example.com/${i}.png`,
      useCount: i <= 11 ? 5 : 0, lastUsedAt: i <= 11 ? 1_700_000_000_000 + i : 0,
      createdAt: new Date(1_700_000_000_000 + i).toISOString()
    });
  }
  const ids = (text) => [...text.matchAll(/stickerId：([\w-]+)/g)].map((m) => m[1]);
  const prompt = buildStickerContext(entries, 30);
  const shown = ids(prompt);
  assert.equal(shown.length, 30, '条数按上限取满');
  const usedShown = shown.filter((id) => Number(id.slice(1)) <= 11);
  assert.equal(usedShown.length, 11, '用过的都还在（常用保底），但不占没有意义的名额');
  assert.equal(shown.length - usedShown.length, 19, '剩下的名额全给没用过的');
  assert.match(prompt, /库里还有 28 张没发过/, '抬头要写出库里还有多少张没用过');
  assert.match(prompt, /优先挑后面这批没见过的用/);
  // 幂等（这段清单常驻系统提示、属于缓存前缀）
  assert.equal(buildStickerContext(entries, 30), prompt);
});

test('表情策略里明确写了"优先用没用过的"（不靠模型自觉）', () => {
  const hint = buildStickerStrategyHint(3);
  assert.match(hint, /换新的/);
  assert.match(hint, /没用过」的优先用/);
});


test('抬头在"只有一个/全都没用过"与"全都用过"两个边界不再自相矛盾', () => {
  // 只有一个（limit=1 或库里就一张）且没用过：不能说"以下是常用的"
  const single = [{ id: 'only-1', desc: '唯一一张', url: 'u', useCount: 0, createdAt: '2026-01-01' }];
  const p1 = buildStickerContext(single, 1);
  assert.equal(p1.includes('是常用的'), false, '一张没用过的不能说"常用的"');
  assert.match(p1, /都还没用过/);

  // 全部用过（没有未用过的）：不能再劝"优先挑没见过的"，也不能写"库里还有 0 张没发过"
  const allUsed = [];
  for (let i = 1; i <= 12; i += 1) {
    allUsed.push({ id: `u-${i}`, desc: `备注${i}`, url: 'u', useCount: 3, lastUsedAt: 1_700_000_000_000 + i, createdAt: '2026-01-01' });
  }
  const p2 = buildStickerContext(allUsed, 4);
  assert.equal(p2.includes('没见过的'), false, '库里没有没用过的，就别劝它挑新的');
  assert.equal(p2.includes('还有 0 张没发过'), false);
  assert.match(p2, /最近没用过的/);
});
