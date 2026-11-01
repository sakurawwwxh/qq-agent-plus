import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

// config-legacy 在模块求值期按 env 固定 DATA_DIR：先建临时目录，再动态 import。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-conflict-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { updateConfig, reloadConfig, getConfig, getConfigConflict, setRuntimeConfig } = await import('../src/core/config-legacy.js');
const configFile = path.join(dir, 'config.json');

test('config.json 被外部修改后再保存：默认拒绝写入并留备份，force 才覆盖', () => {
  updateConfig({ api: { model: 'before' } });
  const external = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  external.api.model = 'external-edit';
  fs.writeFileSync(configFile, `${JSON.stringify(external, null, 2)}\n`);

  // 注入一个**会被归一化改写、且不在本次 patch 分支里**的值：浅拷贝实现会把
  // conversation 与 base 共享，写盘失败前 migrateConfig 就地把它夹到 5000，
  // 回滚后的 previousConfig 已被污染（2026-10-31 复核 P2）。
  setRuntimeConfig({
    ...getConfig(),
    conversation: { ...(getConfig().conversation || {}), lifecycleRolloverInputTokens: 1 }
  });
  const beforeConfig = structuredClone(getConfig());
  assert.throws(
    () => updateConfig({ api: { temperature: 0.5 } }),
    (error) => error.code === 'CONFIG_CONFLICT'
  );
  assert.deepEqual(getConfig(), beforeConfig, '写盘失败必须原地回滚，不得就地改写内存配置');
  const untouched = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(untouched.api.model, 'external-edit', '默认不覆盖外部修改');
  assert.notEqual(untouched.api.temperature, 0.5, '本次补丁不能写进磁盘');

  const conflict = getConfigConflict();
  assert.ok(conflict?.at > 0);
  assert.match(conflict.backupPath, /config\.json\.conflict-\d+-\d+\.bak$/);
  const backup = JSON.parse(fs.readFileSync(conflict.backupPath, 'utf8'));
  assert.equal(backup.api.model, 'external-edit');

  // 重新加载磁盘：内存切到外部版本，并清掉冲突提示。
  const reloaded = reloadConfig();
  assert.equal(reloaded.api.model, 'external-edit');
  assert.equal(getConfigConflict(), null);

  // 用户确认覆盖：写当前（刚重载的）配置，不再重复备份。
  updateConfig({ api: { temperature: 0.5 } }, { force: true });
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.api.model, 'external-edit');
  assert.equal(saved.api.temperature, 0.5);
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.conflict-'));
  assert.equal(backups.length, 1);
});

test('启动时没有 config.json、期间被外部新建：首次保存也要备份而不是当成基线', () => {
  fs.rmSync(configFile, { force: true });
  reloadConfig(); // 走 ENOENT 分支，基线是“空”
  fs.writeFileSync(configFile, JSON.stringify({ api: { model: 'external-new' } }, null, 2));
  assert.throws(
    () => updateConfig({ api: { temperature: 0.7 } }),
    (error) => error.code === 'CONFIG_CONFLICT'
  );
  const conflicts = fs.readdirSync(dir).filter((name) => name.includes('.conflict-'));
  assert.equal(conflicts.length, 2, '第一次保存前的外部文件也要留备份');
});

after(() => {
  // 同一进程里还会跑其他测试文件，别把“外部修改/冲突”状态留给它们。
  fs.rmSync(configFile, { force: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.includes('.conflict-')) fs.rmSync(path.join(dir, name), { force: true });
  }
  reloadConfig();
});
