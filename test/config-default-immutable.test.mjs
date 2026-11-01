// 读盘合并不得污染模块级 DEFAULT_CONFIG（2026-10-31 复核 P2）。
// loadConfig 会把 DEFAULT_CONFIG 与 config.json 深合并，然后对 asr 段做一次性迁移
// （applyAsrProviderFallback 直接改入参）。旧实现 deepMerge 是浅拷贝：配置里没有 asr 段时
// merged.asr 与 DEFAULT_CONFIG.asr 是同一个对象，迁移会把默认值永久改成 openai/providerDefaulted。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-default-immutable-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { DEFAULT_CONFIG, reloadConfig, getConfig } = await import('../src/core/config-legacy.js');

test('loadConfig 对没有 asr 段的配置做迁移时，不能改写 DEFAULT_CONFIG', () => {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ api: { model: 'only-api' } }, null, 2));
  const before = structuredClone(DEFAULT_CONFIG);
  const loaded = reloadConfig();

  assert.deepEqual(DEFAULT_CONFIG, before, 'DEFAULT_CONFIG 是只读基线，读盘迁移不能改它');
  // 迁移本身仍然生效：加载后的配置有 provider（用户没显式存过）
  assert.ok(String(loaded.asr?.provider || '').length > 0, '老配置仍要补上 asr.provider');
  assert.equal(getConfig().asr?.provider, loaded.asr.provider);
});
