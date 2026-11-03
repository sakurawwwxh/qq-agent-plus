// 省 Token 模式：只给几项"夹上限"，不改写用户已填的值；关闭时必须与升级前**完全一致**。
// 这是它的核心契约 —— 关掉就是关掉，任何一项都不许悄悄变。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-token-saver-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });

const {
  cappedByTokenSaver, normalizeTokenSaverMode, tokenSaverCaps, tokenSaverEffective, TOKEN_SAVER_MODES
} = await import('../src/core/token-saver.js');
const { resolveContextTier } = await import('../src/llm/prompt.js');
const { DEFAULT_CONFIG, setRuntimeConfig, getConfig, updateConfig } = await import('../src/core/config.js');
const { MemoryStore } = await import('../src/memory/memory.js');

function useConfig(patch = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api = { ...cfg.api, model: 'test', baseUrl: 'https://model.invalid/v1' };
  cfg.store = { ...cfg.store, atCount: 300, keywordCount: 100, randomCount: 60, allCount: 300, randomPercent: 50, contextLayering: { enabled: false, maxHistoryMessages: 24, maxHistoryChars: 8000 } };
  cfg.memory = { ...cfg.memory, handoffEnabled: true, handoffMaxChars: 4000 };
  Object.assign(cfg, patch);
  setRuntimeConfig(cfg);
  return cfg;
}

test('模式归一化：默认 off，坏值也一律 off', () => {
  assert.deepEqual(TOKEN_SAVER_MODES, ['off', 'balanced', 'aggressive']);
  for (const bad of [undefined, null, '', 'OFF?', 5, {}, [], true]) {
    assert.equal(normalizeTokenSaverMode(bad), 'off', `坏值应归一成 off：${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeTokenSaverMode('Balanced'), 'balanced');
  assert.equal(normalizeTokenSaverMode(' aggressive '), 'aggressive');
  assert.equal(tokenSaverCaps('off'), null, '关闭时没有上限表');
});

test('关闭模式：档位条数、运行预算、轮数都保持用户设置（与升级前一致）', () => {
  useConfig({ tokenSaver: { mode: 'off' } });
  const at = resolveContextTier({ triggerEntries: [{ text: '@机器人 在吗', mentionsSelf: true }], selfNickname: '机器人' });
  assert.equal(at.count, 300, '被艾特仍读 300 条');
  assert.equal(at.tier, 1);
  const keyword = resolveContextTier({ triggerEntries: [{ text: '关键词在此' }], cfg: { ...getConfig().store, keywords: ['关键词'] } });
  assert.equal(keyword.count, 100);
  const random = resolveContextTier({ triggerEntries: [{ text: '普通一句' }], roll: 1 });
  assert.equal(random.tier, 3);
  assert.equal(random.count, 60);
  const all = resolveContextTier({ triggerEntries: [{ text: '普通一句' }], roll: 1, cfg: { ...getConfig().store, randomPercent: 100 } });
  assert.equal(all.count, 300, '全响应仍读 300 条');
});

test('省 / 很省：档位条数被夹到上限（只夹不放大）', () => {
  useConfig({ tokenSaver: { mode: 'balanced' } });
  const at = resolveContextTier({ triggerEntries: [{ text: '@机器人', mentionsSelf: true }], selfNickname: '机器人' });
  assert.equal(at.count, 80, '省模式：被艾特读 80 条');
  const keyword = resolveContextTier({ triggerEntries: [{ text: '关键词在此' }], cfg: { ...getConfig().store, keywords: ['关键词'] } });
  assert.equal(keyword.count, 50);
  const random = resolveContextTier({ triggerEntries: [{ text: '普通一句' }], roll: 1 });
  assert.equal(random.count, 30);

  useConfig({ tokenSaver: { mode: 'aggressive' } });
  assert.equal(resolveContextTier({ triggerEntries: [{ text: '@机器人', mentionsSelf: true }], selfNickname: '机器人' }).count, 40);
  assert.equal(resolveContextTier({ triggerEntries: [{ text: '普通一句' }], roll: 1 }).count, 20);
});

test('只夹不放大：用户本来填得比上限还小的时候原样保留', () => {
  useConfig({ tokenSaver: { mode: 'aggressive' } });
  const small = { ...getConfig().store, atCount: 12 };
  assert.equal(resolveContextTier({ triggerEntries: [{ text: '@机器人', mentionsSelf: true }], selfNickname: '机器人', cfg: small }).count, 12);
  assert.equal(cappedByTokenSaver(12, 80), 12);
  assert.equal(cappedByTokenSaver(300, 80), 80);
  assert.equal(cappedByTokenSaver(300, null), 300, '上限为空时原样返回');
  assert.equal(cappedByTokenSaver(0, 80), 0, '0 是合法值（不读历史），不许被抬成 1');
});

test('配置层：默认 off、老配置迁移补 off、写回时归一化', () => {
  assert.equal(DEFAULT_CONFIG.tokenSaver?.mode, 'off', '默认关闭');
  // setRuntimeConfig 不走迁移，缺键/坏值的兼容由 updateConfig 与 loadConfig 保证：
  // 这里先删掉这个键再保存一次，deepMerge(DEFAULT_CONFIG) 必须把它补成 off
  const cfg = useConfig({ tokenSaver: undefined });
  delete cfg.tokenSaver;
  setRuntimeConfig(cfg);
  updateConfig({});
  assert.equal(getConfig().tokenSaver?.mode, 'off', '缺键时补 off');
  // updateConfig 归一化坏值
  updateConfig({ tokenSaver: { mode: 'nonsense' } });
  assert.equal(getConfig().tokenSaver.mode, 'off');
  updateConfig({ tokenSaver: { mode: 'balanced' } });
  assert.equal(getConfig().tokenSaver.mode, 'balanced');
  // 生效值对照表：用户值 / 生效值 / 是否被夹
  updateConfig({
    tokenSaver: { mode: 'off' },
    store: { ...getConfig().store, atCount: 300 },
    api: { ...getConfig().api, maxRunTokens: 160000, maxRounds: 12 }
  });
  const off = tokenSaverEffective(getConfig());
  assert.equal(off.active, false);
  assert.equal(off.rows.find((r) => r.key === 'atCount').effective, 300);
  assert.equal(off.rows.find((r) => r.key === 'maxRunTokens').effective, 160000);
  assert.ok(off.rows.every((r) => r.clamped === false), '关闭时没有被夹住的项');
  assert.ok(off.capsByMode.balanced && off.capsByMode.aggressive, '两档上限表都要给控制台');

  // 条数填 0 是合法值（= 不读历史）：界面的"你的设置/当前生效"必须显示 0，不能显示成默认 300
  updateConfig({ tokenSaver: { mode: 'balanced' }, store: { ...getConfig().store, atCount: 0 } });
  const zero = tokenSaverEffective(getConfig()).rows.find((r) => r.key === 'atCount');
  assert.equal(zero.user, 0, '0 不许被当成"没填"');
  assert.equal(zero.effective, 0);
  assert.equal(zero.clamped, false);
  updateConfig({ tokenSaver: { mode: 'balanced' }, store: { ...getConfig().store, atCount: 300 } });

  updateConfig({ tokenSaver: { mode: 'balanced' } });
  const on = tokenSaverEffective(getConfig());
  assert.equal(on.active, true);
  const at = on.rows.find((r) => r.key === 'atCount');
  assert.equal(at.user, 300);
  assert.equal(at.effective, 80);
  assert.equal(at.clamped, true);
  assert.equal(on.rows.find((r) => r.key === 'maxRunTokens').effective, 80000);
});

test('记忆：交接与印象注入的字符上限跟着模式走', () => {
  useConfig({ tokenSaver: { mode: 'off' } });
  const memory = new MemoryStore();
  // 印象块每人只注入最近 3 条，得靠"多个人"才撑得起来
  const longImpression = '内容'.repeat(120);
  for (const uid of ['90001', '90002', '90003', '90004', '90005', '90006']) {
    for (let k = 0; k < 3; k += 1) {
      memory.append('group:1', 'memberImpression', `第 ${k} 条：${longImpression}`, { userId: uid, target: `某人${uid.slice(-2)}` });
    }
  }
  const offBlock = memory.formatForPrompt('group:1');
  assert.ok(offBlock.length > 3000, `关闭模式下印象块能顶到 6000（实际 ${offBlock.length}）`);
  assert.ok(offBlock.length <= 6000);

  // 交接要多个字段一起填才够长（单字段有各自的字符上限）
  const longField = '很长的交接内容'.repeat(40);
  const offHandoff = memory.setHandoff('group:1', {
    summary: longField,
    evidence: Array.from({ length: 8 }, (_, i) => `${longField}#证据${i}`),
    facts: Array.from({ length: 3 }, (_, i) => `${longField}#事实${i}`)
  });
  const offHandoffText = memory.formatHandoffForPrompt('group:1');
  assert.ok(offHandoff && offHandoffText.length <= 4000, '关闭模式用用户设置 4000');
  assert.ok(offHandoffText.length > 2000, `关闭模式能给到 2000 以上（实际 ${offHandoffText.length}）`);

  // 换成"省"：两个上限都收一档
  updateConfig({ tokenSaver: { mode: 'balanced' } });
  const cappedBlock = memory.formatForPrompt('group:1');
  assert.ok(cappedBlock.length <= 3000, `省模式印象块 ≤3000（实际 ${cappedBlock.length}）`);
  assert.ok(cappedBlock.length > 0, '截断后仍要有内容');
  const cappedHandoff = memory.formatHandoffForPrompt('group:1');
  assert.ok(cappedHandoff.length <= 2000, `省模式交接 ≤2000（实际 ${cappedHandoff.length}）`);
});

test('分层上下文并入每个条数行的实际生效值，且不会被 0 值抬成 1', () => {
  const cfg = useConfig({
    tokenSaver: { mode: 'off' },
    store: {
      ...DEFAULT_CONFIG.store,
      atCount: 300, keywordCount: 100, randomCount: 60, allCount: 300,
      contextLayering: { enabled: true, maxHistoryMessages: 24, maxHistoryChars: 8000 }
    }
  });
  const table = tokenSaverEffective(cfg);
  const at = table.rows.find((row) => row.key === 'atCount');
  assert.equal(at.user, 300);
  assert.equal(at.effective, 24, '实际生效值要并入分层上限');
  assert.equal(at.layerLimited, true);
  const zero = tokenSaverEffective({
    ...cfg,
    store: { ...cfg.store, atCount: 0, keywordCount: 0, randomCount: 0, allCount: 0 }
  }).rows.find((row) => row.key === 'atCount');
  assert.equal(zero.user, 0, '0 是合法值，不能被抬成 1');
  assert.equal(zero.effective, 0);
});
