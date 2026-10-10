import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-criteria-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { STICKER_JUDGE_DEFAULT_CRITERIA, stickerJudgeCriteria } = await import('../src/onebot/sticker-manager.js');

test('没配 collectCriteria 时用内置默认（默认值 = 现状）', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(stickerJudgeCriteria({}), STICKER_JUDGE_DEFAULT_CRITERIA);
  assert.equal(stickerJudgeCriteria({ sticker: {} }), STICKER_JUDGE_DEFAULT_CRITERIA);
  assert.equal(stickerJudgeCriteria({ sticker: { collectCriteria: '' } }), STICKER_JUDGE_DEFAULT_CRITERIA);
  assert.equal(stickerJudgeCriteria({ sticker: { collectCriteria: '   ' } }), STICKER_JUDGE_DEFAULT_CRITERIA);
  assert.equal(stickerJudgeCriteria({ sticker: { collectCriteria: null } }), STICKER_JUDGE_DEFAULT_CRITERIA);
});

test('配了 collectCriteria 时整段替换判定标准', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const custom = '判断标准：只收猫猫狗狗的图，别的都不收。';
  assert.equal(stickerJudgeCriteria({ sticker: { collectCriteria: custom } }), custom);
  // 前后空白不影响判定（存进来是空白串等于没配）
  assert.equal(stickerJudgeCriteria({ sticker: { collectCriteria: `  ${custom}  ` } }), custom);
});

test('collectCriteria 超长时截断到 2000 字（防撑爆判定请求）', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const got = stickerJudgeCriteria({ sticker: { collectCriteria: '啊'.repeat(2500) } });
  assert.equal(got.length, 2000);
});
