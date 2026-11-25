import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-proactive-pergroup-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const { DEFAULT_CONFIG, getConfig, updateConfig } = await import('../src/core/config.js');

test('proactive.perGroup 用 __replace__ 整表替换，删除的群覆盖不会残留在磁盘', () => {
  updateConfig({ proactive: { ...DEFAULT_CONFIG.proactive, perGroup: { 123: { enabled: false } } } });
  assert.deepEqual(getConfig().proactive.perGroup, { 123: { enabled: false } });

  updateConfig({ proactive: { perGroup: { __replace__: { 456: { enabled: true } } } } });
  assert.deepEqual(getConfig().proactive.perGroup, { 456: { enabled: true } }, '旧群覆盖必须被整表替换掉');

  updateConfig({ proactive: { perGroup: { __replace__: {} } } });
  assert.deepEqual(getConfig().proactive.perGroup, {}, '全部删除后回到跟随全局');
});
