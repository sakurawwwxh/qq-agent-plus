import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLATFORM_GATE_KEYS, PLATFORM_TOOL_GATES, platformToolAllowed
} from '../src/core/platform-gates.js';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/core/config.js';
import { buildSystemPrompt } from '../src/llm/prompt.js';

test('faceWrites 是独立的平台门控，只管 send_face', () => {
  assert.ok(PLATFORM_GATE_KEYS.includes('faceWrites'));
  assert.deepEqual(PLATFORM_TOOL_GATES.faceWrites, ['send_face']);
  assert.equal(DEFAULT_CONFIG.platform.faceWrites, true, '默认开，升级不改变既有行为');
  assert.equal(platformToolAllowed('send_face', {}), true);
  assert.equal(platformToolAllowed('send_face', { faceWrites: false }), false);
  assert.equal(platformToolAllowed('send_message', { faceWrites: false }), true);
  assert.equal(platformToolAllowed('send_sticker', { faceWrites: false }), true);
  assert.equal(platformToolAllowed('send_face', { faceWrites: true, perGroup: { '433': { faceWrites: false } } }, 'group:433'), false);
  assert.equal(platformToolAllowed('send_face', { faceWrites: true, perGroup: { '433': { faceWrites: false } } }, 'group:434'), true);
});

test('关闭 faceWrites 后提示词不再教 send_face，改用 emoji', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.sticker = { ...cfg.sticker, enabled: false };
  setRuntimeConfig(cfg);
  const off = buildSystemPrompt({ platform: { ...cfg.platform, faceWrites: false }, chatKey: 'group:1' });
  assert.doesNotMatch(off, /想表达情绪时可以用 send_face|想回同一个就用 send_face/);
  assert.match(off, /send_face 不在工具表里/);
  assert.match(off, /emoji/);
  const on = buildSystemPrompt({ platform: { ...cfg.platform, faceWrites: true }, chatKey: 'group:1' });
  assert.match(on, /想表达情绪可以用 send_face/);
});
