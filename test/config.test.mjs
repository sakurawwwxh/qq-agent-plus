import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-stable-'));
process.env.QQ_AGENT_DATA_DIR = dir;

fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  identityPilot: {
    enabled: false,
    graduated: false,
    incomingFriendRequest: {
      enabled: false,
      autoWhitelist: false,
      maxPending: 25
    },
    friendProposal: {
      enabled: false,
      graduated: false,
      activeDispatchEnabled: false,
      ownerUin: '12345678',
      mode: 'prompt',
      cooldownDays: 45,
      maxPending: 7
    }
  },
  slangPilot: {
    enabled: true,
    graduated: true,
    ownerUin: '45678901',
    minOccurrences: 2,
    webResearch: true,
    maxResearchRounds: 5
  },
  incidentPilot: {
    enabled: false,
    graduated: false,
    ownerUin: '87654321',
    retentionDays: 123
  },
  autoUpdate: {
    enabled: false,
    ownerUin: '56789012'
  },
  allow: { groups: [], private: [] },
  deny: { groups: [], private: ['12345678'] },
  ui: { refreshMs: 15000 }
}, null, 2));

const {
  DEFAULT_CONFIG,
  adminOwnerUin,
  friendProposalEnabled,
  friendRequestDispatchEnabled,
  getConfig,
  identityPilotEnabled,
  incomingFriendRequestEnabled,
  incidentPilotEnabled,
  promptFriendProposalEnabled,
  reloadConfig,
  slangPilotEnabled,
  triggeredFriendProposalEnabled,
  updateConfig
} = await import('../src/core/config.js');

test('promoted capabilities share one admin; slang purged; friend proposal retired', async (t) => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(DEFAULT_CONFIG.identityPilot.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.enabled, false);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.activeDispatchEnabled, false);
  assert.equal(DEFAULT_CONFIG.incidentPilot.enabled, true);
  assert.deepEqual(DEFAULT_CONFIG.slangPilot, { enabled: false, graduated: false });
  assert.equal(DEFAULT_CONFIG.admin.ownerUin, '');

  // Old installs had separate owner fields. Identity/Friends is the migration
  // priority. Current administrator consumers keep compatibility mirrors, while
  // retired slang research loses all owner/tuning configuration entirely.
  const cfg = getConfig();
  assert.equal(adminOwnerUin(cfg), '12345678');
  assert.equal(cfg.admin.ownerUin, '12345678');
  assert.equal(cfg.identityPilot.friendProposal.ownerUin, '12345678');
  assert.equal(cfg.incidentPilot.ownerUin, '12345678');
  assert.equal(cfg.autoUpdate.ownerUin, '12345678');
  assert.deepEqual(cfg.slangPilot, { enabled: false, graduated: false });
  assert.ok(cfg.allow.private.includes('12345678'));
  assert.ok(!cfg.deny.private.includes('12345678'));

  assert.equal(cfg.identityPilot.enabled, true);
  assert.equal(cfg.identityPilot.graduated, true);
  assert.equal(cfg.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(cfg.identityPilot.friendProposal.enabled, false);
  assert.equal(cfg.identityPilot.friendProposal.graduated, false);
  assert.equal(cfg.identityPilot.friendProposal.activeDispatchEnabled, false);
  assert.equal(cfg.identityPilot.incomingFriendRequest.autoWhitelist, false);
  assert.equal(cfg.identityPilot.incomingFriendRequest.maxPending, 25);
  assert.equal(cfg.identityPilot.friendProposal.mode, 'prompt');
  assert.equal(cfg.identityPilot.friendProposal.cooldownDays, 45);
  assert.equal(cfg.identityPilot.friendProposal.maxPending, 7);
  assert.equal(cfg.incidentPilot.enabled, true);
  assert.equal(cfg.incidentPilot.graduated, true);
  assert.equal(cfg.incidentPilot.retentionDays, 123);

  assert.equal(identityPilotEnabled({ identityPilot: { enabled: false } }), true);
  assert.equal(friendProposalEnabled({}), false);
  assert.equal(friendRequestDispatchEnabled({}), false);
  assert.equal(incomingFriendRequestEnabled({}), true);
  assert.equal(incidentPilotEnabled({ incidentPilot: { enabled: false } }), true);
  assert.equal(slangPilotEnabled({ slangPilot: { enabled: true } }), false);
  assert.equal(promptFriendProposalEnabled(cfg), true);
  assert.equal(triggeredFriendProposalEnabled(cfg), false);

  // Stale callers may still POST removed gates and old per-feature owners.
  // None can disable stable infrastructure, change the administrator
  // independently, or revive retired slang-research settings.
  const stale = updateConfig({
    identityPilot: {
      enabled: false,
      incomingFriendRequest: { enabled: false },
      friendProposal: {
        enabled: false,
        activeDispatchEnabled: false,
        ownerUin: '22222222'
      }
    },
    incidentPilot: { enabled: false, ownerUin: '33333333' },
    autoUpdate: { ownerUin: '44444444' },
    slangPilot: {
      enabled: true,
      graduated: true,
      ownerUin: '55555555',
      minOccurrences: 1,
      webResearch: true
    },
    ui: { refreshMs: 7000 }
  });

  assert.equal(stale.ui.refreshMs, 7000);
  assert.equal(stale.admin.ownerUin, '12345678');
  assert.equal(stale.identityPilot.friendProposal.ownerUin, '12345678');
  assert.equal(stale.incidentPilot.ownerUin, '12345678');
  assert.equal(stale.autoUpdate.ownerUin, '12345678');
  assert.deepEqual(stale.slangPilot, { enabled: false, graduated: false });
  assert.equal(stale.identityPilot.enabled, true);
  assert.equal(stale.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(stale.identityPilot.friendProposal.enabled, false);
  assert.equal(stale.identityPilot.friendProposal.activeDispatchEnabled, false);
  assert.equal(stale.incidentPilot.enabled, true);

  // The global setting is the only supported write path. It fans out to the
  // remaining compatibility mirrors and guarantees private admin access.
  const next = updateConfig({ admin: { ownerUin: '23456789' } });
  assert.equal(adminOwnerUin(next), '23456789');
  assert.equal(next.identityPilot.friendProposal.ownerUin, '23456789');
  assert.equal(next.incidentPilot.ownerUin, '23456789');
  assert.equal(next.autoUpdate.ownerUin, '23456789');
  assert.deepEqual(next.slangPilot, { enabled: false, graduated: false });
  assert.ok(next.allow.private.includes('23456789'));
  assert.ok(!next.deny.private.includes('23456789'));

  assert.throws(
    () => updateConfig({ admin: { ownerUin: 'not-a-qq' } }),
    /管理员 QQ 必须为 5 到 15 位数字/
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.ui.refreshMs, 7000);
  assert.equal(saved.admin.ownerUin, '23456789');
  assert.equal(saved.identityPilot.friendProposal.ownerUin, '23456789');
  assert.equal(saved.incidentPilot.ownerUin, '23456789');
  assert.equal(saved.autoUpdate.ownerUin, '23456789');
  assert.equal(saved.identityPilot.enabled, true);
  assert.equal(saved.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.enabled, false);
  assert.equal(saved.identityPilot.friendProposal.activeDispatchEnabled, false);
  assert.equal(saved.incidentPilot.enabled, true);
  assert.deepEqual(saved.slangPilot, { enabled: false, graduated: false });
});

test('响应滑条：滑条值就是概率；updateConfig 的兜底分支按老口径换算', async () => {
  // 说明：生产里老配置在**读盘时**就由 migrateConfig 迁移好了（见 config-migration.test.mjs），
  // 这里覆盖的是"没走读盘"的配置（setRuntimeConfig 注入那类）走 updateConfig 时的兜底换算
  const { updateConfig } = await import('../src/core/config.js');

  // 新语义：传什么就是多少概率（0 是合法值，不能被当成"没填"回落成 100）
  const zero = updateConfig({ store: { contextSliderPos: 0, sliderMode: 'probability' } });
  assert.equal(zero.store.randomPercent, 0, '0% = 只回 @ 和关键词');
  assert.equal(zero.store.contextTier, 1, '0% 归 1 档展示');
  const mid = updateConfig({ store: { contextSliderPos: 43, sliderMode: 'probability' } });
  assert.equal(mid.store.randomPercent, 43);
  assert.equal(mid.store.contextTier, 3);
  const full = updateConfig({ store: { contextSliderPos: 100, sliderMode: 'probability' } });
  assert.equal(full.store.randomPercent, 100);
  assert.equal(full.store.contextTier, 4, '100% = 全响应');

  // 老配置（四段式，没打标记）保存时换算：老 1/2 档不掷骰子 → 0%
  const legacy1 = updateConfig({ store: { contextSliderPos: 5, sliderMode: '', contextTier: 1, randomPercent: 0 } });
  assert.equal(legacy1.store.randomPercent, 0, '老 1 档（仅艾特）迁移成 0%');
  const legacy2 = updateConfig({ store: { contextSliderPos: 15, sliderMode: '', contextTier: 2, randomPercent: 0 } });
  assert.equal(legacy2.store.randomPercent, 0, '老 2 档（+关键词）迁移成 0%');
  const legacy3 = updateConfig({ store: { contextSliderPos: 55, sliderMode: '', contextTier: 3, randomPercent: 50 } });
  assert.equal(legacy3.store.randomPercent, 50, '老 3 档的概率原样保留');
  const legacy4 = updateConfig({ store: { contextSliderPos: 95, sliderMode: '', contextTier: 4, randomPercent: 100 } });
  assert.equal(legacy4.store.randomPercent, 100, '老 4 档（全响应）迁移成 100%');
  assert.equal(legacy4.store.sliderMode, 'probability', '迁移后要打上标记，别重复换算');

  // 老配置连滑条位置都没有（只有 tier/概率）也要能迁
  const legacyNoPos = updateConfig({ store: { contextSliderPos: null, sliderMode: '', contextTier: 3, randomPercent: 24.3 } });
  assert.equal(legacyNoPos.store.randomPercent, 24.3);
  const legacyNoPos4 = updateConfig({ store: { contextSliderPos: null, sliderMode: '', contextTier: 4, randomPercent: 0 } });
  assert.equal(legacyNoPos4.store.randomPercent, 100, '老 4 档没有位置时按全响应');

  // 分群滑条（存的是概率）跟着迁移
  const grouped = updateConfig({
    store: { sliderMode: '', contextTier: 4, randomPercent: 100, groupSliderPos: { '111': 5, '222': 55 } }
  });
  assert.deepEqual(grouped.store.groupSliderPos, { '111': 0, '222': 50 }, '分群的老位置也要换算成概率');
  // 界面保存分群表时带 __replace__（删掉的群要真删），这里用同一套写法
  const groupedNew = updateConfig({
    store: { sliderMode: 'probability', groupSliderPos: { __replace__: { '111': 30 } } }
  });
  assert.deepEqual(groupedNew.store.groupSliderPos, { '111': 30 }, '新语义下原样保留');
});

test('分群响应概率：单独设过的群按它算，别的群与私聊跟全局（0 也是合法值）', async () => {
  const { updateConfig, storeConfigForChat } = await import('../src/core/config.js');

  updateConfig({
    store: {
      sliderMode: 'probability', contextSliderPos: 50, unifiedTier: false,
      groupSliderPos: { __replace__: { '111': 30, '222': 0 } }
    }
  });
  assert.equal(storeConfigForChat('group:111').randomPercent, 30, '这个群按 30%');
  assert.equal(storeConfigForChat('group:111').contextTier, 3);
  assert.equal(storeConfigForChat('group:222').randomPercent, 0, '0% 是合法值：不能被当成"没设"回落全局');
  assert.equal(storeConfigForChat('group:222').contextTier, 1);
  assert.equal(storeConfigForChat('group:999').randomPercent, 50, '没单独设的群跟全局');
  assert.equal(storeConfigForChat('private:2').randomPercent, 50, '私聊永远跟全局');

  // 关掉统一开关之前，全局滑条仍然管所有群
  updateConfig({ store: { unifiedTier: true, groupSliderPos: { __replace__: {} } } });
  assert.equal(storeConfigForChat('group:111').randomPercent, 50);
});

test('保存白名单不会清掉屏蔽名单（旧页面不发 deny 时靠服务端保留现状）', async () => {
  // 背景（2026-09-23 全项目审查）：ui 的「保存白名单」以前无条件发 deny={groups:[],private:[]}，
  // 而 deepMerge 对数组是整体替换 —— --import-bridge / 手改 config.json 配的屏蔽名单被静默清空，
  // access.js 却还按（已经空了的）deny 判人。现在控制台有 deny 控件时显式提交；
  // 控件缺失/旧页面不发这个字段时，服务端必须保留原值。
  const { updateConfig } = await import('../src/core/config.js');

  updateConfig({ deny: { groups: ['999'], private: ['888'] } });
  assert.deepEqual(updateConfig({}).deny, { groups: ['999'], private: ['888'] }, '不带 deny 的保存要原样保留');

  // 界面「保存白名单」发的 patch 形状：只有 allow + allowAllWhenEmpty
  const afterAllowSave = updateConfig({ allow: { groups: ['123'], private: [] }, allowAllWhenEmpty: false });
  assert.deepEqual(afterAllowSave.deny, { groups: ['999'], private: ['888'] }, '保存白名单不能清掉 deny');
  assert.deepEqual(afterAllowSave.allow.groups, ['123']);
});

test('群成员备注：__replace__ 才是"能删键"的写法，且写入时夹住长度与条目数', async () => {
  // 背景（2026-09-29 审查 P1）：控制台清空备注/删除备注是"从对象里删掉这个键再整体回传"，
  // 而 deepMerge 只遍历传上去的键 —— 缺的键会被服务端原样保留，于是"删除备注"看着成功、
  // 实际没变。这里钉住服务端语义 + UI 现在采用的 __replace__ 写法。
  const { updateConfig, getConfig } = await import('../src/core/config.js');

  updateConfig({ memberNotes: { __replace__: { '42': '老张', '43': '小李' } } });
  assert.deepEqual(getConfig().memberNotes, { '42': '老张', '43': '小李' });

  // 普通深合并删不掉键（这正是 UI 之前踩的坑）
  updateConfig({ memberNotes: { '43': '小李' } });
  assert.deepEqual(getConfig().memberNotes, { '42': '老张', '43': '小李' }, '普通合并不会删除缺的键');

  // 整体替换才能真正删掉
  updateConfig({ memberNotes: { __replace__: { '43': '小李' } } });
  assert.deepEqual(getConfig().memberNotes, { '43': '小李' }, '删掉的键必须真的消失');

  updateConfig({ memberNotes: { __replace__: {} } });
  assert.deepEqual(getConfig().memberNotes, {}, '清空备注列表');

  // 写入侧的长度/条数上界：备注值 200 字、空值不入库
  updateConfig({ memberNotes: { __replace__: { '44': 'x'.repeat(500), '45': '   ' } } });
  assert.equal(getConfig().memberNotes['44'].length, 200, '备注值夹到 200 字');
  assert.equal('45' in getConfig().memberNotes, false, '纯空白备注不入库');

  // 不改这一项时不动存量：把内存态换成一个超长的存量值，再保存无关字段 → 不能被截断
  // （这是"只在写入侧夹"的设计取舍：升级不该悄悄改写用户已有的配置）
  const { setRuntimeConfig } = await import('../src/core/config.js');
  setRuntimeConfig({ ...getConfig(), memberNotes: { '47': 'w'.repeat(400) } });
  updateConfig({ persona: { botName: '小鲸鱼' } });
  assert.equal(getConfig().memberNotes['47'].length, 400, '无关保存不回头截断存量值');
  updateConfig({ memberNotes: { __replace__: {} } });
});

test('人设正文与自定义规则在写入侧夹住长度（防止粘贴事故把提示词打爆）', async () => {
  const { updateConfig, getConfig } = await import('../src/core/config.js');
  const { PERSONAS } = await import('../src/personas.js').catch(() => ({ PERSONAS: null }));

  updateConfig({ persona: { roleText: 'z'.repeat(30000), customRules: 'r'.repeat(9000), templateId: '' } });
  assert.equal(getConfig().persona.roleText.length, 20000);
  assert.equal(getConfig().persona.customRules.length, 4000);

  // 恢复成默认人设卡，别影响同文件后续用例
  updateConfig({ persona: { roleText: PERSONAS?.xiaojingyu?.text ?? '默认人设', templateId: 'xiaojingyu' } });
});

test('表情判定标准在写入侧夹到 2000 字（控制台文本域同口径，2026-10-10）', async () => {
  const { updateConfig, getConfig, setRuntimeConfig } = await import('../src/core/config.js');

  updateConfig({ sticker: { collectCriteria: 'c'.repeat(2500) } });
  assert.equal(getConfig().sticker.collectCriteria.length, 2000, '超长按 2000 夹住');

  // 不改这一项时不动存量（与上面人设长文本同一设计取舍）：塞一个超长存量值，保存无关字段 → 不被截断
  setRuntimeConfig({ ...getConfig(), sticker: { ...getConfig().sticker, collectCriteria: 'x'.repeat(3000) } });
  updateConfig({ sticker: { enabled: true } });
  assert.equal(getConfig().sticker.collectCriteria.length, 3000, '无关保存不回头截断存量值');

  // 清空 = 回内置默认；别影响同文件后续用例
  updateConfig({ sticker: { collectCriteria: '' } });
  assert.equal(getConfig().sticker.collectCriteria, '');
});

test('标量 patch（{asr: 5}）按"这次没改"处理，不清空整段（否则连凭据映射一起丢）', async () => {
  const { updateConfig, getConfig } = await import('../src/core/config.js');
  updateConfig({ asr: { provider: 'tencent', baseUrl: '', model: '', apiKey: 'K', apiKeyProvider: 'tencent' } });
  updateConfig({ asr: 5 });
  const asr = getConfig().asr;
  assert.equal(asr.provider, 'tencent', '标量 patch 不该清空这一段');
  assert.equal(asr.apiKey, 'K', '凭据也不该丢');
  updateConfig({ tts: [] });
  assert.equal(typeof getConfig().tts, 'object', '数组 patch 同理');
});

test('tts 的派生位与 has[A-Z] 通配同样不落盘（hasApiKeyService 是 sanitize 生成的）', async () => {
  const { updateConfig, getConfig } = await import('../src/core/config.js');
  updateConfig({ tts: { hasApiKeyService: true, hasApiKey: true, keyServices: ['doubao'], currentService: 'doubao' } });
  const tts = getConfig().tts;
  assert.equal('hasApiKeyService' in tts, false, 'has[A-Z] 派生位一律不落盘（tts 段原先漏了通配）');
  assert.equal('hasApiKey' in tts, false);
  assert.equal('keyServices' in tts, false);
  assert.equal('currentService' in tts, false);
  assert.equal(String(tts.apiKeyService || ''), '', '归属字段本身是配置（默认空串），不能被当派生位删掉');
});

test('webSearch 的派生位（sanitize 生成的 hasApiKey）不落盘', async () => {
  const { updateConfig, getConfig } = await import('../src/core/config.js');
  updateConfig({
    webSearch: { deepseek: { hasApiKey: true, apiKey: 'K' }, hasApiKey: true, providers: [{ id: 'x', hasApiKey: true, apiKey: 'P' }] }
  });
  const ws = getConfig().webSearch;
  assert.equal('hasApiKey' in ws, false, '顶层派生位不落盘');
  assert.equal('hasApiKey' in ws.deepseek, false, '内置服务子对象里的派生位不落盘');
  assert.equal('hasApiKey' in ws.providers[0], false, '自定义服务列表里的派生位不落盘');
  assert.equal(ws.deepseek.apiKey, 'K', '真 Key 不受影响');
});

test('三个带凭据映射的段（asr/tts/imageGen）：手改坏成标量/数组时归一化成对象，keys 同理', async () => {
  // 2026-10-02 全量审查：非对象形态会让 { ...keys } 展开成字符索引的垃圾映射，
  // 还会绕过控制台下发的"整包清空"（那条在 secret-keys.js 单独修）。这里钉住落盘/合并侧的归一化。
  const { updateConfig, getConfig } = await import('../src/core/config.js');

  updateConfig({ asr: { __replace__: 'junk' } });
  assert.equal(Array.isArray(getConfig().asr), false, 'asr 段归一化成对象');
  assert.equal(typeof getConfig().asr, 'object');

  updateConfig({ imageGen: { enabled: true, keys: { __replace__: 'sk-leaked' } } });
  assert.deepEqual(getConfig().imageGen.keys, {}, 'imageGen.keys 归一化成空映射（字符串不许当映射用）');
  assert.equal(getConfig().imageGen.enabled, true, '同段其它字段不受影响');

  updateConfig({ tts: { keys: { __replace__: ['a', 'b'] } } });
  assert.deepEqual(getConfig().tts.keys, {}, 'tts.keys 同理');

  // 正常写入照旧
  updateConfig({ asr: { provider: 'tencent', keys: { tencent: { secretId: 'AKID', secretKey: 'SK' } } } });
  assert.deepEqual(getConfig().asr.keys.tencent, { secretId: 'AKID', secretKey: 'SK' });
});

test('坏形状的 allow/deny/blocklist/providers/customPersonas/store keywords 归一化', () => {
  updateConfig({
    allow: { groups: '123456', private: { a: 1 } },
    deny: { groups: null, private: 'x' },
    blocklist: { '123': '456' },
    providers: {},
    customPersonas: {},
    // blacklistKeywords 故意不放在这里：它是"显式提交必须是数组"，坏形状会 400（见下方用例）；
    // 手改文件的坏形状仍由 migrateConfig 清洗成 []。
    store: { keywords: 'not-an-array' }
  });
  const cfg = getConfig();
  assert.deepEqual(cfg.allow.groups, []);
  assert.ok(Array.isArray(cfg.allow.private), '私聊名单必须是数组（管理员 QQ 可能被自动补入）');
  assert.deepEqual(cfg.deny.groups, []);
  assert.ok(Array.isArray(cfg.deny.private));
  assert.deepEqual(cfg.blocklist['123'], []);
  assert.deepEqual(cfg.providers, []);
  assert.deepEqual(cfg.customPersonas, []);
  assert.deepEqual(cfg.store.keywords, []);
  assert.deepEqual(cfg.store.blacklistKeywords, []);
});

test('消息关键词黑白名单保留为数组，并校验正则规则', () => {
  updateConfig({ store: { keywords: ['小鲸鱼'], blacklistKeywords: ['广告', '抽奖'] } });
  assert.deepEqual(getConfig().store.blacklistKeywords, ['广告', '抽奖']);
  assert.throws(() => updateConfig({ store: { blacklistKeywords: ['re:('] } }),
    (error) => error.httpStatus === 400 && /黑名单规则/.test(error.message));
});

test('updateConfig 的校验错误带 httpStatus=400 标记（控制台据此区分用户输入）', () => {
  assert.throws(() => updateConfig({ server: { port: 0 } }),
    (error) => error.httpStatus === 400 && /Invalid server port/.test(error.message));
  assert.throws(() => updateConfig({ runtime: { mode: 'nope' } }),
    (error) => error.httpStatus === 400 && /Invalid runtime mode/.test(error.message));
});

test('黑名单规则：保存时非数组直接 400；手改配置加载时丢弃不安全规则', () => {
  assert.throws(() => updateConfig({ store: { blacklistKeywords: '广告' } }),
    (error) => error.httpStatus === 400 && /数组/.test(error.message));
  // 整段替换形状也要校验，不能靠加载期 sanitize 静默兜底
  assert.throws(() => updateConfig({ store: { __replace__: { blacklistKeywords: ['re:(a+)+'] } } }),
    (error) => error.httpStatus === 400 && /黑名单规则/.test(error.message));

  const file = path.join(dir, 'config.json');
  const original = fs.readFileSync(file, 'utf8');
  try {
    const raw = JSON.parse(original);
    raw.store = {
      ...(raw.store || {}),
      blacklistKeywords: ['广告', 're:^a*a*a*b$', 're:^转发.*抽奖$', 're:(a+)+']
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    const cfg = reloadConfig();
    assert.deepEqual(cfg.store.blacklistKeywords, ['广告', 're:^转发.*抽奖$'],
      '手改的不安全/非法规则在加载时被丢弃（fail-closed）');
  } finally {
    fs.writeFileSync(file, original);
    reloadConfig();
  }
});

test('unknown 自动释放策略：默认关闭，越界值收敛到 0–90 天', () => {
  const file = path.join(dir, 'config.json');
  const original = fs.readFileSync(file, 'utf8');
  try {
    assert.equal(DEFAULT_CONFIG.outbox.unknownAutoReleaseDays, 0, '默认关闭');
    // 归一化在保存路径（updateConfig）跑，与 incidentPilot 的数值段同口径。
    updateConfig({ outbox: { unknownAutoReleaseDays: 999 } });
    assert.equal(getConfig().outbox.unknownAutoReleaseDays, 90, '上限 90 天');
    updateConfig({ outbox: { unknownAutoReleaseDays: -3 } });
    assert.equal(getConfig().outbox.unknownAutoReleaseDays, 0, '负数按关闭处理');
  } finally {
    fs.writeFileSync(file, original);
    reloadConfig();
  }
});

test('配置代次：成功替换/重载后自增，校验失败保持不变', async () => {
  const { updateConfig, reloadConfig, getConfigGeneration } = await import('../src/core/config.js');
  const before = getConfigGeneration();
  updateConfig({ runtime: { paused: false } });
  const afterUpdate = getConfigGeneration();
  assert.ok(afterUpdate > before, '成功保存必须换代');

  assert.throws(() => updateConfig({ admin: { ownerUin: 'not-a-uin' } }));
  assert.equal(getConfigGeneration(), afterUpdate, '校验失败不能换代');

  reloadConfig();
  assert.ok(getConfigGeneration() > afterUpdate, '重载磁盘配置也要换代');
});
