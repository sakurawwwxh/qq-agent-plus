// 插件路由模块的依赖注入守卫（2026-10-31 M2 拆分回归）：
// 拆分时曾把注入的 mirrorConfig 与 handler 内同名局部变量写成
// `const mirrorConfig = mirrorConfig()` —— TDZ ReferenceError 只在真正调用端点时暴露，
// 源码锚点测试拦不住。这里用假 router + 假索引直接调用 handler：
// 断言"已经走到下载失败"而不是"访问未初始化变量"，从而证明注入函数可调用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-routes-'));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { registerPluginRoutes } = await import('../src/console/routes/plugins.js');

function buildRoutes(body) {
  const handlers = new Map();
  const router = { add(method, routePath, handler) { handlers.set(`${method} ${routePath}`, handler); } };
  const calls = [];
  const json = (res, status, payload) => { res.status = status; res.payload = payload; };
  registerPluginRoutes(router, {
    json,
    readBody: async () => body,
    getConfig: () => ({ plugins: { publishers: {} } }),
    updateConfig: () => {},
    auditWrite: () => {},
    log: () => {},
    dataDir,
    hostVersion: '0.0.0',
    pluginRegistry: {},
    loadIndex: async () => ({
      plugins: [{
        id: 'weather',
        url: 'http://127.0.0.1:1/weather.tar.gz',
        sha256: '0'.repeat(64),
        compatible: true,
        source: '测试索引'
      }],
      skipped: [],
      sources: []
    }),
    invalidateIndex: () => calls.push('invalidate'),
    mirrorConfig: () => ({ prefixes: [] }),
    pluginLog: () => {}
  });
  return { handlers, calls };
}

test('/api/plugins/upgrade-preview 能调用注入的镜像配置（不是 TDZ 报错）', async () => {
  const { handlers } = buildRoutes({ id: 'weather' });
  const handler = handlers.get('POST /api/plugins/upgrade-preview');
  const res = {};
  await handler({ headers: {}, url: '/api/plugins/upgrade-preview', socket: {} }, res);
  assert.equal(res.status, 400, JSON.stringify(res.payload));
  // 走到镜像下载失败（E_DOWNLOAD）才证明 mirrorConfig() 真的被调用过；
  // 仅排除 TDZ 文案的话，注入返回 undefined 也能蒙混过关。
  assert.equal(res.payload?.code, 'E_DOWNLOAD', JSON.stringify(res.payload));
  assert.doesNotMatch(String(res.payload?.error || ''), /before initialization|is not defined/,
    '出现未初始化/未定义说明依赖注入被同名局部变量遮蔽');
});

test('/api/plugins/install 按索引安装路径同样能调用镜像配置', async () => {
  const { handlers } = buildRoutes({ id: 'weather' });
  const handler = handlers.get('POST /api/plugins/install');
  const res = {};
  await handler({ headers: {}, url: '/api/plugins/install', socket: {} }, res);
  assert.equal(res.status, 400, JSON.stringify(res.payload));
  // 走到镜像下载失败（E_DOWNLOAD）才证明 mirrorConfig() 真的被调用过；
  // 仅排除 TDZ 文案的话，注入返回 undefined 也能蒙混过关。
  assert.equal(res.payload?.code, 'E_DOWNLOAD', JSON.stringify(res.payload));
  assert.doesNotMatch(String(res.payload?.error || ''), /before initialization|is not defined/,
    '出现未初始化/未定义说明依赖注入被同名局部变量遮蔽');
});
