// 「消息类型」开关（issue #34，2026-10-15）：按类型决定机器人读不读这类内容。
// 覆盖：默认值（都是开 —— 不偷偷改变现有部署的行为）、提示词口径随开关变、入站自动展开的
// 判定（含"被 @ 强制展开"）、以及控制台那一侧的接线（缺一处就是"看得见却存不下"）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-message-types-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');
const src = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('默认值：四个开关都默认开（保持既有行为，不偷偷改变已部署的实例）', () => {
  assert.equal(DEFAULT_CONFIG.messageTypes.expandForward, true, '合并转发默认仍然自动展开');
  assert.equal(DEFAULT_CONFIG.messageTypes.videoFrames, true, '视频画面默认仍然可看');
  assert.equal(DEFAULT_CONFIG.messageTypes.images, true, '消息里的图片/表情包默认仍然可看');
  assert.equal(DEFAULT_CONFIG.messageTypes.stickers, true, '表情库里的图默认仍然可看');
  assert.equal(DEFAULT_CONFIG.messageTypes.enrichTimeoutMs, 5000, '入站富化默认 5 秒预算');
});

test('enrichTimeoutMs 会被夹到 200–15000，非法值回落 5000', () => {
  try {
    updateConfig({ messageTypes: { enrichTimeoutMs: 1 } });
    assert.equal(getConfig().messageTypes.enrichTimeoutMs, 200);
    updateConfig({ messageTypes: { enrichTimeoutMs: 99999 } });
    assert.equal(getConfig().messageTypes.enrichTimeoutMs, 15000);
    updateConfig({ messageTypes: { enrichTimeoutMs: 'bad' } });
    assert.equal(getConfig().messageTypes.enrichTimeoutMs, 5000);
  } finally {
    updateConfig({ messageTypes: { enrichTimeoutMs: 5000 } });
  }
});

test('提示词：关掉视频画面后不再教它去调抽帧，且说清为什么看不到', () => {
  // 两条"画面能看"的措辞（ASR 开着/关着各一条），关掉后一条都不该在
  const seeVideo = (text) => /两样都能拿到|的\*\*画面\*\*可以用 get_message_images/.test(text);
  updateConfig({ api: { vision: true }, messageTypes: { videoFrames: true } });
  const on = buildSystemPrompt({ persona: DEFAULT_CONFIG.persona });
  assert.ok(seeVideo(on), '默认（开）时提示词要说明画面能看');
  const asrBranch = on.includes('可以用 get_message_audio');

  updateConfig({ messageTypes: { videoFrames: false } });
  try {
    const off = buildSystemPrompt({ persona: DEFAULT_CONFIG.persona });
    assert.ok(!seeVideo(off), '关掉后不能再教它调一个对视频什么都不给的工具');
    if (asrBranch) {
      // ASR 可用时视频仍有声音这条路 —— 要说清是"设置里关掉了画面"，否则模型会以为自己在瞎
      assert.match(off, /画面查看在设置里关掉了/);
    }
    // 触发器列表也要跟着收：还列着 [视频] 就等于教它去调一个对视频什么都不给的工具
    assert.ok(!/\[图片\] \/ \[表情包\] \/ \[视频\]/.test(off), '关掉后触发器列表里不该再列 [视频]');
    assert.match(off, /\[图片\] \/ \[表情包\]/, '图片/表情仍要列（那条路没关）');
  } finally {
    updateConfig({ messageTypes: { videoFrames: true } });
  }
});

test('工具描述跟着开关走：关掉视频画面后不再承诺"视频抽 4 帧"', async () => {
  const { buildToolDefs } = await import('../src/tools/tools-core.js');
  const desc = () => buildToolDefs().find((t) => t.name === 'get_message_images').description;
  updateConfig({ messageTypes: { videoFrames: true } });
  assert.match(desc(), /抽 4 帧/, '默认（开）时描述要说明视频画面怎么来');
  updateConfig({ messageTypes: { videoFrames: false } });
  try {
    assert.doesNotMatch(desc(), /抽 4 帧/, '关掉后描述不能再承诺抽帧');
    assert.match(desc(), /视频画面看不到/);
  } finally {
    updateConfig({ messageTypes: { videoFrames: true } });
  }
  // 老配置里根本没有这个键 → 处处都要按"开"回落（与 DEFAULT_CONFIG 同口径）。
  // 回落写成 `=== true` 这种时，升级后描述会突然改口说"视频画面看不到"。
  updateConfig({ messageTypes: { __replace__: {} } });
  assert.match(desc(), /抽 4 帧/, '缺键要按"开"回落');
  updateConfig({ messageTypes: { expandForward: true, videoFrames: true } });
});

test('提示词：关掉图片查看后不再教 get_message_images，但仍可查看表情库（另一个开关）', () => {
  updateConfig({ api: { vision: true }, sticker: { enabled: true }, messageTypes: { images: true, stickers: true } });
  const both = buildSystemPrompt({ persona: { botName: '测试', roleText: '' } });
  assert.ok(both.includes('可以用 get_message_images'), '默认要教消息图片怎么查看');
  assert.ok(both.includes('get_sticker_image 看图'), '默认要教表情库怎么查看');

  updateConfig({ messageTypes: { images: false } });
  try {
    const off = buildSystemPrompt({ persona: { botName: '测试', roleText: '' } });
    assert.ok(!off.includes('可以用 get_message_images'), '关掉后不能再教它调一个已被摘掉的工具');
    assert.ok(off.includes('get_sticker_image 看图'), '表情库的开关没关，那条路仍要教');
    assert.match(off, /看不到内容/, '要说清为什么看不到，避免模型编造画面');
    assert.match(off, /系统设置覆盖角色设定/, '角色卡里若写着看图工具，要用机制说明覆盖掉');
  } finally {
    updateConfig({ messageTypes: { images: true } });
  }
});

test('提示词：关掉表情查看后不再教 get_sticker_image，按备注名发送仍要教', () => {
  updateConfig({ api: { vision: true }, sticker: { enabled: true }, messageTypes: { images: true, stickers: false } });
  try {
    const off = buildSystemPrompt({ persona: { botName: '测试', roleText: '' } });
    assert.ok(!off.includes('get_sticker_image 看图'), '关掉后不能再教它查看表情库');
    assert.ok(off.includes('可以用 get_message_images'), '消息图片的开关没关，那条路仍要教');
    assert.match(off, /send_sticker/, '按备注名发送表情不受影响');
    assert.match(off, /系统设置覆盖角色设定/, '角色卡里若写着表情看图工具，要用机制说明覆盖掉');
  } finally {
    updateConfig({ messageTypes: { stickers: true } });
  }
});

test('提示词：两项都关时整体退回"看不到图"口径（不再逐条教看图）', () => {
  updateConfig({ api: { vision: true }, sticker: { enabled: true }, messageTypes: { images: false, stickers: false } });
  try {
    const off = buildSystemPrompt({ persona: { botName: '测试', roleText: '' } });
    assert.ok(!off.includes('看图（你能直接看懂图片内容）'), '两项都关时不该再出现教看图的句子');
    assert.match(off, /你无法查看图片内容/, '要退回整体口径');
    assert.match(off, /系统设置覆盖角色设定/, '两项都关时要说明工具确实不在');
  } finally {
    updateConfig({ messageTypes: { images: true, stickers: true } });
  }
});

test('提示词：关掉表情查看后，表情清单与策略段也不再教 get_sticker_image', () => {
  // 审查抓到的漏口：工具被摘掉了，但【可用表情包】清单的尾注与策略段还在说"先看一眼"。
  // 这两段由 onebot/stickers.js 生成，入参 vision 必须与 orchestrator 的摘除判定同一个。
  const entries = [
    { id: 's-note', desc: '无语', localNote: '', useCount: 2, tags: ['日常'], source: 'qq' },
    { id: 's-bare', desc: '', localNote: '', useCount: 0, tags: [], source: 'qq' }
  ];
  updateConfig({ api: { vision: true }, sticker: { enabled: true }, messageTypes: { stickers: true } });
  const on = buildSystemPrompt({ persona: { botName: '测试', roleText: '' }, stickerEntries: entries });
  assert.ok(on.includes('get_sticker_image'), '默认（开）时清单尾注要说明可以先看图');
  assert.ok(on.includes('s-bare'), '默认（开）时没备注的图也在清单里');

  updateConfig({ messageTypes: { stickers: false } });
  try {
    const off = buildSystemPrompt({ persona: { botName: '测试', roleText: '' }, stickerEntries: entries });
    assert.ok(!off.includes('先 get_sticker_image 看一眼'), '关掉后清单尾注与策略段都不该再教它看图');
    assert.ok(off.includes('get_sticker_image 不在工具表里'), '但要明确告诉模型这个工具确实没有');
    assert.ok(off.includes('list_stickers'), '列表工具仍可用');
    assert.ok(!off.includes('s-bare'), '没备注的图看不到，不该留在清单里（省 token，也避免诱导调不存在的工具）');
    assert.ok(off.includes('s-note'), '有备注的图仍要列出来（按备注名可以发）');
  } finally {
    updateConfig({ messageTypes: { stickers: true } });
  }
});

test('提示词：表情包总开关关闭时不再教 send_sticker / list_stickers', () => {
  // 与消息类型无关的另一道闸门：总开关关掉后五个贴纸工具都被摘掉（orchestrator），
  // 提示词不能再教它们（2026-10-17 审查 P1）
  updateConfig({ sticker: { enabled: false }, messageTypes: { images: true, stickers: true } });
  try {
    const p = buildSystemPrompt({ persona: { botName: '测试', roleText: '' } });
    assert.ok(!p.includes('send_sticker="发表情"'), '工具协议里的示例不能再用 send_sticker');
    assert.ok(!p.includes('发送：用 send_sticker'), '表情策略段不能再教怎么发');
    assert.match(p, /表情包功能已关闭/, '要明确说明工具确实不在');
  } finally {
    updateConfig({ sticker: { enabled: true } });
  }
});

test('入站：自动展开受开关控制，被 @ 时强制展开（锚点：这段在 console 的事件处理里，单测拿不到）', () => {
  const app = src('src/console/app.js');
  assert.ok(app.includes('const autoExpand = cfgNow.messageTypes?.expandForward !== false || mentionsSelf;'),
    '入站判定要同时看配置与"是否被 @"');
  assert.ok(app.includes('if (segments && looksForward && event.message_id != null && autoExpand) {'),
    '判定要真的用在展开入口上');
  assert.ok(/合并转发未自动展开（「消息类型」页关着）/.test(app),
    '跳过时要留一行日志（否则"为什么没展开"只能靠猜）');
});

test('控制台：侧栏入口、分区路由、控件、保存分支四件套齐全', () => {
  const settings = src('ui/pages/settings.js');
  assert.ok(settings.includes("['messageTypes', '消息类型']"), '侧栏要有入口');
  assert.ok(settings.includes('messageTypes: () => renderMessageTypesSection(c)'), '分区路由要接上');
  assert.ok(settings.includes('id="cfg-expand-forward"'), '合并转发开关要有控件');
  assert.ok(settings.includes('id="cfg-video-frames"'), '视频画面开关要有控件');
  assert.ok(settings.includes('id="cfg-mt-images"'), '图片查看开关要有控件');
  assert.ok(settings.includes('id="cfg-mt-stickers"'), '表情查看开关要有控件');
  assert.ok(settings.includes('图片输入'), '图片/表情要指到 api.vision 那个开关上（别造第二份真源）');
  const save = src('ui/pages/settings-save.js');
  assert.ok(save.includes("if (sec === 'messageTypes')"), '保存分支要在 messageTypes 段构造');
  // 两个 id 必须各归各的键：写成 chk('#cfg-video-frames') 去填 expandForward 时，
  // 控件与开关会互串，而"两个 id 都出现过"式的断言照样绿。
  assert.ok(save.includes("expandForward: chk('#cfg-expand-forward'"), 'expandForward 要读自己的控件');
  assert.ok(save.includes("videoFrames: chk('#cfg-video-frames'"), 'videoFrames 要读自己的控件（对调即串台）');
  assert.ok(save.includes("images: chk('#cfg-mt-images'"), 'images 要读自己的控件');
  assert.ok(save.includes("stickers: chk('#cfg-mt-stickers'"), 'stickers 要读自己的控件（对调即串台）');
});
