// 唤醒批里的点名标签：必须只有"真的点了机器人"才写（@我），@ 给别人不能算。
//
// 背景（Issue #4，2026-09-22）：判定用的是 text.startsWith('@')，于是任何以 @ 开头的消息
// ——@群友、@群里另一个机器人、@全体成员——都被标成（@我），模型看到自己的位置被点名，
// 就把别人的指令接下来了。同一处还漏了 CQ 码上报（message_format=string）的真 @：
// 那种部署下 mentionsSelf 恒为 false，文本里只有 [CQ:at,qq=…]，一条标签都不打。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-trigger-labels-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { DEFAULT_CONFIG, getConfig, updateConfig } = await import('../src/core/config.js');
const { buildTriggerBlock, buildUserPrompt, isAtMe } = await import('../src/llm/prompt.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.api = { ...cfg.api, baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: '' };
cfg.persona = { ...cfg.persona, botName: '小鲸鱼' };
cfg.allow = { ...cfg.allow, groups: ['1'], private: [] };
updateConfig(cfg);
const baseCfg = structuredClone(cfg);

const CTX = { selfNickname: '小鲸鱼', selfId: '888' };
const msg = (text, extra = {}) => ({
  id: 1, mid: 1, ts: Date.now(), senderId: '10086', senderName: 'User1', self: false, text, ...extra
});
const labelsOf = (message, ctx = CTX) => buildTriggerBlock([message], ctx)
  .match(/（([^）]*)）$/)?.[1]?.split('/') ?? [];

test('@ 给别人不是「@我」：@群友、@别的机器人都不算点名', () => {
  // Issue #4 的原始形态：群里另一个机器人被 @，以前这里会写（@我）
  assert.deepEqual(labelsOf(msg('@小呱呱 /今日猪猪', { mentionsSelf: false })), ['艾特别人']);
  assert.deepEqual(labelsOf(msg('@小明 你看这个', { mentionsSelf: false })), ['艾特别人']);
  assert.ok(!labelsOf(msg('@小明 你看这个', { mentionsSelf: false })).includes('@我'));
});

test('@全体成员 不是「@我」（它是喊所有人，档位判定也不当召唤）', () => {
  assert.deepEqual(labelsOf(msg('@全体成员 通知一下', { mentionsSelf: false })), ['艾特全体']);
  assert.deepEqual(labelsOf(msg('[CQ:at,qq=all] 都看下', { mentionsSelf: false })), ['艾特全体']);
});

test('真被 @ 的四条路径都要写「@我」', () => {
  // 1) 存档里的 mentionsSelf（按原始消息段算的，群名片改过也对得上）
  assert.ok(labelsOf(msg('@老鲸 在吗', { mentionsSelf: true })).includes('@我'));
  // 2) 文本里的群名片/机器人名
  assert.ok(labelsOf(msg('@小鲸鱼 在吗', { mentionsSelf: false })).includes('@我'));
  // 3) CQ 码上报（message_format=string 的部署，mentionsSelf 恒为 false）
  assert.ok(labelsOf(msg('[CQ:at,qq=888] 在吗', { mentionsSelf: false })).includes('@我'));
  // 4) @ 的名字没解析出来时的兜底形态 @QQ号（在开头）
  assert.ok(labelsOf(msg('@888 在吗', { mentionsSelf: false })).includes('@我'));
  // 非存档来源（控制台预览、旧数据）没有 mentionsSelf 字段，文本兜底要继续管用
  assert.ok(labelsOf(msg('@小鲸鱼 在吗')).includes('@我'));
});

test('转发记录/引用预览里的 @ 是别人的话，不算叫我', () => {
  // 合并转发里的 at 段没解析名字，落到存档里就是 @QQ号 形态；那是转述的内容，
  // 不是这条消息在叫我（以前只在开头认，就是为了挡这些）
  const fwd = msg('[合并转发 共2条]\n张三：@888 帮我查下\n李四：收到', { mentionsSelf: false });
  assert.deepEqual(labelsOf(fwd), []);
  // 真·引用消息在存档里一定带结构化 reply（「引用」标签现在以它为准：只看正文前缀的话，
  // 群友手打一条以 [引用… 开头的普通消息也会被贴上标签）
  const quoted = msg('[引用 小明：@888 帮我看下]这啥意思', {
    mentionsSelf: false,
    reply: { messageId: '9001', sender: '小明', text: '@888 帮我看下' }
  });
  assert.deepEqual(labelsOf(quoted), ['引用']);
  // 别人的号在转发里，也不该说成"别人在 @ 别人"——转述内容不参与点名牌
  const fwdOther = msg('[合并转发 共1条]\n张三：@999 查下', { mentionsSelf: false });
  assert.deepEqual(labelsOf(fwdOther), []);
});

test('名字前缀与大小写：@小鲸鱼 不是叫「小鲸」', () => {
  // 机器人名是「小鲸」、群里还有个「小鲸鱼」：短名字不能吃掉长名字（v0.6.9 会判成 @我）。
  // 名字存在 persona.botName 里，这条用改配置摆场景，跑完还原。
  // 「提到我」是宽松的子串信号（名字出现在正文里就算），@ 判定才要求名字后面是边界。
  const name = getConfig().persona.botName;
  const as = (value) => updateConfig({ ...structuredClone(baseCfg), persona: { ...baseCfg.persona, botName: value } });
  const shortCtx = { selfNickname: '小鲸', selfId: '888' };
  try {
    as('小鲸');
    const other = labelsOf(msg('@小鲸鱼 在吗', { mentionsSelf: false }), shortCtx);
    assert.deepEqual(other, ['艾特别人', '提到我', '提问']);
    assert.ok(!other.includes('@我'), '「小鲸鱼」不是叫「小鲸」，不能算 @我');
    assert.deepEqual(labelsOf(msg('@小鲸 在吗', { mentionsSelf: false }), shortCtx), ['@我', '提到我', '提问']);
    // 名字后面跟标点/空格/表情都算边界
    assert.ok(labelsOf(msg('@小鲸，在吗', { mentionsSelf: false }), shortCtx).includes('@我'));
    assert.ok(labelsOf(msg('@小鲸🐳 在吗', { mentionsSelf: false }), shortCtx).includes('@我'));
    // 名字里的正则元字符按字面处理，不能当成模式
    as('a.b');
    const dotted = { selfNickname: 'a.b', selfId: '888' };
    assert.ok(labelsOf(msg('@a.b 在吗', { mentionsSelf: false }), dotted).includes('@我'));
    assert.deepEqual(labelsOf(msg('@axb 在吗', { mentionsSelf: false }), dotted), ['艾特别人', '提问']);
  } finally {
    as(name);
  }
  // 大小写不敏感：名片写成 Whale、群友打 @whale 也要认
  //（否则同一个括号里会自相矛盾地出现「艾特别人/提到我」）
  const whale = labelsOf(msg('@whale 在吗', { mentionsSelf: false }), { selfNickname: 'Whale', selfId: '888' });
  assert.ok(whale.includes('@我'));
  assert.ok(!whale.includes('艾特别人'));
});

test('同时 @ 别人和 @ 我：只写「@我」，不写「艾特别人」', () => {
  const labels = labelsOf(msg('@小明 还有@小鲸鱼', { mentionsSelf: true }));
  assert.ok(labels.includes('@我'));
  assert.ok(!labels.includes('艾特别人'));
});

test('没有 @ 的消息不打点名牌：邮箱、只打一个 @、普通聊天都不算', () => {
  assert.deepEqual(labelsOf(msg('发我邮箱 a@example.com', { mentionsSelf: false })), []);
  assert.deepEqual(labelsOf(msg('今天天气不错', { mentionsSelf: false })), []);
  assert.deepEqual(labelsOf(msg('在吗', { mentionsSelf: false })), ['提问']);
  // @ 后面只有空格/标点（手打一个 @ 就发出去了）：算不出指向，不贴点名牌，
  // 也不该像以前那样按"以 @ 开头"记成 @我
  assert.deepEqual(labelsOf(msg('@ 小鲸鱼 在吗', { mentionsSelf: false })), ['提到我', '提问']);
  assert.deepEqual(labelsOf(msg('@ 全体成员 通知一下', { mentionsSelf: false })), []);
  assert.deepEqual(labelsOf(msg('报价 a @ example.com', { mentionsSelf: false })), []);
});

test('不知道自己 QQ 号时，数字形态的 @ 不贴「艾特别人」', () => {
  // get_login_info 还没回来时 selfId 是空的：这时 [CQ:at,qq=888] 到底是不是自己判断不了，
  // 宁可什么都不贴，也不能贴成「艾特别人」（那是把真被 @ 说成没被 @）
  assert.deepEqual(labelsOf(msg('[CQ:at,qq=888] 在吗', { mentionsSelf: false }), { selfNickname: '小鲸鱼' }), ['提问']);
  assert.deepEqual(labelsOf(msg('@888 在吗', { mentionsSelf: false }), { selfNickname: '小鲸鱼' }), ['提问']);
  // 知道自己的 QQ 号时，别人的号照样标出来
  assert.deepEqual(labelsOf(msg('[CQ:at,qq=888] 在吗', { mentionsSelf: false }), { selfId: '999' }), ['艾特别人', '提问']);
});

test('@ 判定与档位判定同源：isAtMe 认 @QQ号 形态', () => {
  const opt = { selfNickname: '小鲸鱼', botName: '小鲸鱼', selfId: '888' };
  assert.ok(isAtMe('@888 在吗', opt), '@QQ号 是 @ 名字没解析出来时的兜底形态');
  assert.ok(!isAtMe('@8880 在吗', opt), 'QQ 号后面接着数字不算（@8880 是别人）');
  assert.ok(isAtMe('@老鲸 在吗', { ...opt, selfNickname: '老鲸' }), '群名片改过也认');
  assert.ok(!isAtMe('@小明 在吗', opt), '@别人不算');
});

test('端到端：本次唤醒那一段里不再把别人的点名标成（@我）', () => {
  const batch = buildUserPrompt({
    store: { recent: () => [], listChats: () => [] },
    memory: { formatForPrompt: () => '' },
    chatKey: 'group:1', chatId: '1', chatName: '测试群', kind: 'group',
    triggerEntries: [
      msg('@小呱呱 /远行商人', { mentionsSelf: false }),
      msg('@小鲸鱼 帮我看下', { mentionsSelf: true })
    ],
    ...CTX
  }).split('【本次唤醒】')[1];
  const lines = batch.split('\n');
  const first = lines.find((line) => line.includes('@小呱呱 /远行商人'));
  const second = lines.find((line) => line.includes('@小鲸鱼 帮我看下'));
  assert.ok(first && second, batch);
  assert.match(first, /（艾特别人）$/, `别人被 @ 的那条不该写 @我：${first}`);
  assert.ok(!first.includes('@我'));
  assert.ok(second.includes('@我'), `真被 @ 的那条要写 @我：${second}`);
});
