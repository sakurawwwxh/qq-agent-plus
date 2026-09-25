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
const { buildStickerContext, findSticker } = await import('../src/onebot/stickers.js');

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
