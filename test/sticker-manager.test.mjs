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

test('prompt 用 localNote 优先；全角/半角引号查询也能命中', () => {
  const entries = [
    { id: 'st-1', desc: 'GIF', localNote: '哈士奇：指着镜头，适合威胁', url: 'https://example.com/1.png' },
    { id: 'st-2', desc: '他说"别动"', localNote: '', url: 'https://example.com/2.png' }
  ];
  const prompt = buildStickerContext(entries, 10);
  assert.match(prompt, /哈士奇：指着镜头/);
  assert.equal(prompt.includes('GIF'), false, '不能把采集时的格式名当成备注');
  assert.equal(findSticker(entries, '他说“别动”')?.id, 'st-2', '模型传全角引号也要命中半角备注');
});

test('send_sticker 找不到表情不刷异常面板', async () => {
  const manager = new StickerManager({ call: async () => [] });
  const tool = buildToolDefs().find((x) => x.name === 'send_sticker');
  const result = await tool.execute({
    chatKey: 'group:1',
    stickers: manager,
    sender: {},
    session: { leaseId: 'lease', triggerText: '测试', sent: [] },
    emit: () => {}
  }, { stickerId: 'missing-sticker' });
  assert.equal(result.isError, true);
  assert.equal(result.reportIncident, false, '预期内的"找不到"不该进异常库');
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


test('清单把两类来源标出来：QQ 收藏表情 vs 本地图库（发出去是图片）', () => {
  const entries = [
    { id: '10086_1', desc: '真表情', url: 'https://p.qpic.cn/qq_expression/x/1', source: 'qq', useCount: 1, lastUsedAt: 1 },
    { id: 'collected_-100', desc: '收藏的图片', url: 'https://multimedia.nt.qq.com.cn/download?fileid=x', source: 'ai', useCount: 0 },
    { id: 'manual_abc', desc: '手动上传的图', localFile: 'sticker-assets/manual_abc.png', source: 'manual', useCount: 0 }
  ];
  const prompt = buildStickerContext(entries, 10);
  assert.match(prompt, /真表情.*〔QQ收藏表情〕/);
  assert.match(prompt, /收藏的图片.*〔本地图库·发出去是图片〕/);
  assert.match(prompt, /手动上传的图.*〔本地图库·发出去是图片〕/);
  assert.match(prompt, /标〔QQ收藏表情〕的发出去是表情/);
});

test('收藏入库即落盘：发送走 base64（不再依赖会过期的消息链接）', async (t) => {
  const http = await import('node:http');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' + '0d0a2db4' + '0000000049454e44ae426082', 'hex');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  updateConfig({ security: { ...DEFAULT_CONFIG.security, allowPrivateImageHosts: true }, sticker: { ...DEFAULT_CONFIG.sticker, collectEnabled: true } });
  const manager = new StickerManager({ async call() { return []; } });
  const entry = await manager.collect('-555', { url: `http://127.0.0.1:${server.address().port}/a.png`, note: '本地图库测试' });
  assert.ok(entry.localFile, '要落盘（localFile 非空）');
  assert.ok(String(entry.localFile).startsWith('sticker-assets'), '落到托管目录 sticker-assets/ 下');
  const image = manager.readImage(entry.id);
  assert.ok(image?.buffer?.length, '能从托管目录读回来');
  const forSend = await manager.findForSend(entry.id);
  assert.match(forSend.url, /^base64:\/\//, '发送用 base64，不依赖原链接');
});

test('取不到图就不收藏（不是存一个迟早失效的链接）', async (t) => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  updateConfig({ security: { ...DEFAULT_CONFIG.security, allowPrivateImageHosts: true }, sticker: { ...DEFAULT_CONFIG.sticker, collectEnabled: true } });
  const manager = new StickerManager({ async call() { return []; } });
  await assert.rejects(
    () => manager.collect('-556', { url: `http://127.0.0.1:${server.address().port}/x.png`, note: 'x' }),
    /取不到/
  );
});


test('老条目链接失效时不发坏图（明确报"已失效"，而不是拿它当表情找不到）', async (t) => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"expired"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  updateConfig({ security: { ...DEFAULT_CONFIG.security, allowPrivateImageHosts: true } });
  const url = `http://127.0.0.1:${server.address().port}/dead.png`;
  const manager = new StickerManager({
    async call() { return []; },
    async getMsg() { throw new Error('源消息已过期'); }   // 刷新那条路走不通
  });
  manager.saveEntries([...manager.entries, {
    id: 'collected_-999', resId: 'collected_-999', url, source: 'ai', desc: '老条目',
    useCount: 0, lastUsedAt: 0, createdAt: new Date().toISOString()
  }]);
  await assert.rejects(() => manager.findForSend('collected_-999'), (error) => {
    assert.equal(error?.code, 'STICKER_LINK_DEAD');
    assert.match(String(error?.message || ''), /失效/);
    return true;
  });
});

test('收藏夹容量状态：满 500 时告诉控制台"新收藏会进本地库"', async () => {
  const manager = new StickerManager({
    async call(action) {
      assert.equal(action, 'fetch_custom_face_detail');
      return Array.from({ length: 500 }, (_, i) => ({ emojiId: `e${i}` }));
    }
  });
  const state = await manager.qqFavoritesState();
  assert.equal(state.limit, 500);
  assert.equal(state.count, 500);
  assert.equal(state.full, true);
});


test('表情策略里不再点名某张卡的专属表情（示例中性化）', () => {
  const hint = buildStickerStrategyHint(2);
  assert.equal(hint.includes('别墨迹'), false);
  assert.equal(hint.includes('大肥鱼'), false);
  assert.match(hint, /那行开头的备注名/);
});


test('收藏落盘后能真的发出去（AI 收藏 ≠ 只能发图片链接；P0 回归）', async (t) => {
  const http = await import('node:http');
  // 1×1 PNG（合法签名即可）
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' + '0d0a2db4' + '0000000049454e44ae426082', 'hex');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  updateConfig({ security: { ...DEFAULT_CONFIG.security, allowPrivateImageHosts: true }, sticker: { ...DEFAULT_CONFIG.sticker, collectEnabled: true } });
  const manager = new StickerManager({ async call() { return []; } });
  const entry = await manager.collect('-777', { url: `http://127.0.0.1:${server.address().port}/a.png`, note: 'P0 回归' });

  // 用真实的 send_sticker 工具 + 真实 manager：AI 收藏的条目不报"地址不合法"
  const senderCalls = [];
  const tool = buildToolDefs().find((x) => x.name === 'send_sticker');
  const ctx = {
    chatKey: 'group:1',
    signal: AbortSignal.timeout(20000),
    stickers: manager,
    session: { leaseId: 'lease-1', sent: [], feedbacks: [] },
    store: { hasUncertainEffects: () => false, findByMid: () => null, appendSelf: () => {} },
    sender: { sendSticker: async (chatKey, sticker) => { senderCalls.push(sticker); return { message_id: 1 }; } },
    onebot: { call: async () => [] },
    emit: () => {}
  };
  const result = await tool.execute(ctx, { stickerId: entry.localNote || 'P0 回归' });
  assert.equal(result?.isError, undefined, `不该被拒发：${JSON.stringify(result).slice(0, 160)}`);
  assert.equal(senderCalls.length, 1, '要真的走一次发送');
  assert.match(String(senderCalls[0].url), /^base64:\/\//, '发送用的是本地文件（base64），不是过期链接');
});

test('老条目探活：图比探活上限大也不算失效（P1 回归）', async (t) => {
  const http = await import('node:http');
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200 * 1024, 7)]);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(big); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  updateConfig({ security: { ...DEFAULT_CONFIG.security, allowPrivateImageHosts: true } });
  const manager = new StickerManager({ async call() { return []; }, async getMsg() { throw new Error('源消息已过期'); } });
  manager.saveEntries([...manager.entries, {
    id: 'collected_-888', resId: 'collected_-888', url: `http://127.0.0.1:${server.address().port}/big.png`,
    source: 'ai', desc: '大图老条目', useCount: 0, lastUsedAt: 0, createdAt: new Date().toISOString()
  }]);
  const found = await manager.findForSend('collected_-888');
  assert.ok(found, '链接是好的（只是图大），不能被判失效');
});

test('Issue #17：备注命中不被标签擦边否决；整行粘贴（带标签/用量/stickerId）也能解析', () => {
  const base = (id, desc, tags, localNote = '') => ({ id, desc, localNote, tags, url: `https://example.com/${id}.png` });
  // 复现 A：另一个表情的 tag 是查询串的子串
  const a = [
    base('a', '立体大问号，配晚霞背景，适合表达疑惑/懵', ['疑惑']),
    base('b', '对面一脸懵逼', ['问号', '懵'])
  ];
  assert.equal(findSticker(a, '立体大问号')?.id, 'a');
  // 复现 B：模型把「备注 [标签]」整行复制进来（生产最常见形态）
  const b = [
    base('x', '海绵宝宝看破', ['看破', '懂了', '阴阳']),
    base('y', '坏笑舔嘴', ['阴阳'])
  ];
  assert.equal(findSticker(b, '海绵宝宝看破')?.id, 'x');
  assert.equal(findSticker(b, '海绵宝宝看破 [看破/懂了/阴阳]')?.id, 'x', '带标签的整行也要能解析');
  // 整行粘贴（含项目符号/用量/stickerId/来源标记）
  const line = '- 海绵宝宝看破 [看破/懂了/阴阳]（用过3次）（stickerId：x）（QQ收藏表情）';
  assert.equal(findSticker(b, line)?.id, 'x', '清单整行原样粘贴也能解析');
  assert.equal(findSticker(b, '（stickerId：y）')?.id, 'y', '从 stickerId 形态里抠 id');
  // 同级重名仍然宁缺勿错
  assert.equal(findSticker([...b, base('x2', '海绵宝宝看破', [])], '海绵宝宝看破'), null);
  // 标签级命中仍然可用（没有备注命中时，且该标签唯一）
  const c = [
    base('x', '海绵宝宝看破', ['看破', '阴阳']),
    base('y', '坏笑舔嘴', ['坏笑'])
  ];
  assert.equal(findSticker(c, '坏笑')?.id, 'y', '备注包含查询（只记得半句）命中');
  assert.equal(findSticker(c, '阴阳')?.id, 'x', '标签只属于 x 时也能命中 x');
  assert.equal(findSticker(b, '阴阳'), null, '同一标签命中多张时仍宁缺勿错');
  // 备注自身以括号结尾：不能被"剥短后的形态"劫持到别的条目（审查 2026-09-28）
  const d = [
    base('d1', '裂开', []),
    base('d2', '裂开（崩溃）', ['崩溃'])
  ];
  assert.equal(findSticker(d, '裂开（崩溃）')?.id, 'd2', '原文精确命中优先于剥短形态');
  assert.equal(findSticker(d, '裂开（崩溃） [崩溃]')?.id, 'd2', '截断行（无 stickerId）从最完整形态开始试');
  assert.equal(findSticker(d, '- 裂开（崩溃）')?.id, 'd2', '行首项目符号 + 括号结尾的备注');
});


test('收藏总闸关闭时自动收藏直接跳过：不判断、不花模型调用（2026-10-02 反馈）', async () => {
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  updateConfig({ sticker: { ...DEFAULT_CONFIG.sticker, enabled: true, autoCollect: true, collectEnabled: false } });
  const manager = new StickerManager({ async call() { throw new Error('不该调协议端'); } });
  // 防变异路径碰真实网络：真去判断时这里会立刻抛错（而不是去 fetch example.com）
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('总闸关闭时不该有任何网络调用'); };
  try {
    const result = await manager.autoCollect('group:1', {
      mid: 'm1',
      media: [{ kind: 'image', url: 'https://example.com/a.png', file: 'a.png' }]
    });
    assert.equal(result, null, '总闸关闭时不该收藏');
    // judgeTimes 在"进入判断"之前就会记一笔 —— 它为空才证明连判断都没跑
    // （否则"优先加进 QQ 收藏"那条路会绕过总闸、还会白花一次看图调用）
    assert.equal((manager.judgeTimes || []).length, 0, '总闸关闭时不该进入判断');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('收藏双闸（#9）：会话额度互不影响；全局额度共享（配额在 manager 实例上）', async () => {
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  updateConfig({ sticker: { ...DEFAULT_CONFIG.sticker, collectEnabled: true, maxCollectPerHour: 4, maxCollectPerHourPerChat: 2 } });
  const manager = new StickerManager({ async call() { return []; } });
  const t0 = Date.now();
  assert.equal(manager.collectPeek(t0, 'group:1').ok, true);
  manager.collectQuota.tryConsume('group:1', t0);
  manager.collectQuota.tryConsume('group:1', t0 + 1);
  const chatDenied = manager.collectPeek(t0 + 2, 'group:1');
  assert.equal(chatDenied.ok, false);
  assert.equal(chatDenied.scope, 'chat');
  assert.equal(manager.collectPeek(t0 + 2, 'group:2').ok, true, '别的会话不受影响');
  manager.collectQuota.tryConsume('group:2', t0 + 3);
  manager.collectQuota.tryConsume('group:2', t0 + 4);
  const globalDenied = manager.collectPeek(t0 + 5, 'group:3');
  assert.equal(globalDenied.ok, false, '全局 4 张已满，第三个会话也受限');
  assert.equal(globalDenied.scope, 'global');
});


test('收藏配额记账：成功扣一次、取不到图退还（事前原子消费，2026-10-03 全量审查）', async (t) => {
  const http = await import('node:http');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' + '0d0a2db4' + '0000000049454e44ae426082', 'hex');
  const server = http.createServer((req, res) => {
    if (req.url.includes('missing')) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  updateConfig({
    security: { ...DEFAULT_CONFIG.security, allowPrivateImageHosts: true },
    sticker: { ...DEFAULT_CONFIG.sticker, collectEnabled: true, maxCollectPerHour: 5, maxCollectPerHourPerChat: 5 }
  });
  const manager = new StickerManager({ async call() { return []; } });
  const chatKey = 'group:quota-1';
  const base = manager.collectQuota.snapshot();
  const port = server.address().port;
  await manager.collect('-601', { url: `http://127.0.0.1:${port}/a.png`, note: 'x', chatKey });
  const afterOk = manager.collectQuota.snapshot();
  assert.equal((afterOk.chats[chatKey] || 0) - (base.chats[chatKey] || 0), 1, '收藏成功要扣一次额度');
  await assert.rejects(() => manager.collect('-602', { url: `http://127.0.0.1:${port}/missing.png`, note: 'x', chatKey }), /取不到/);
  const afterFail = manager.collectQuota.snapshot();
  assert.equal((afterFail.chats[chatKey] || 0) - (base.chats[chatKey] || 0), 1, '失败的那次要退还（净消耗仍为 1）');
});

test('控制台预览失效的收藏表情：返回 404，不把 STICKER_LINK_DEAD 记成系统异常', () => {
  const app = fs.readFileSync(new URL('../src/console/routes/assets.js', import.meta.url), 'utf8');
  const at = app.indexOf("router.add('GET', '/api/assets/stickers/image'");
  assert.ok(at > 0, '图片路由结构变了就更新这条用例');
  const slice = app.slice(at, at + 1800);
  assert.match(slice, /error\?\.code === 'STICKER_LINK_DEAD'\) return json\(res, 404/,
    '失效链只是预览失败，直接 404；抛出去会在异常面板留红项');
});
