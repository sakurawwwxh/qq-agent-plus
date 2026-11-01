// admin.__replace__ 不能绕过“自动更新启用时必须有全局管理员”的不变量
// （2026-10-31 全项目复审 P2）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-admin-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');

test('admin 整段替换不能清空管理员（autoUpdate 启用时）', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ...cfg.admin, ownerUin: '12345' };
  cfg.autoUpdate = { ...cfg.autoUpdate, enabled: true };
  updateConfig(cfg);
  assert.equal(getConfig().admin.ownerUin, '12345');

  assert.throws(() => updateConfig({ admin: { __replace__: {} } }), /不能清空全局管理员/);
  assert.throws(() => updateConfig({ admin: { __replace__: { ownerUin: '' } } }), /不能清空全局管理员/);
  assert.equal(getConfig().admin.ownerUin, '12345', '被拒绝的保存不能改内存');
  // autoUpdate 也用 __replace__ 开启时，包装层同样必须识别出来
  assert.throws(() => updateConfig({
    allowAllWhenEmpty: true,
    admin: { __replace__: { ownerUin: '' } },
    autoUpdate: { __replace__: { enabled: true, ownerUin: '12345' } }
  }), /不能清空全局管理员/);

  // 关闭自动更新后允许清空
  updateConfig({ autoUpdate: { enabled: false } });
  updateConfig({ admin: { __replace__: { ownerUin: '' } } });
  assert.equal(getConfig().admin.ownerUin, '');
});


test('autoUpdate/allow 用 __replace__ 时仍能补上管理员归属', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ...cfg.admin, ownerUin: '12345' };
  cfg.autoUpdate = { ...cfg.autoUpdate, enabled: false };
  cfg.allow = { ...cfg.allow, private: [] };
  updateConfig(cfg);

  updateConfig({ autoUpdate: { __replace__: { enabled: true } } });
  assert.equal(getConfig().autoUpdate.enabled, true);
  assert.equal(getConfig().autoUpdate.ownerUin, '12345', '替换体里要补 ownerUin');

  updateConfig({ allow: { __replace__: { groups: ['1'], private: [] } } });
  assert.ok(getConfig().allow.private.includes('12345'), 'allow 替换也要保留管理员私聊白名单');

  // 替换体没写 enabled 时实际生效是 false，不应被“当前开着”误判成清空管理员。
  updateConfig({ autoUpdate: { __replace__: {} } });
  assert.equal(getConfig().autoUpdate.enabled, false);
});
