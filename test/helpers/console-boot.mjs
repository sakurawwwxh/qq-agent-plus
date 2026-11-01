// 控制台接口 smoke 的共享启动器：临时 dataDir + 动态 import config/app + 换端口重试。
//
// 为什么必须动态 import：config 在模块求值期读 QQ_AGENT_DATA_DIR，import 之后再设已经晚了。
// 现在 test/ 下有 30 个文件各写一份 freePort/boot，先为路由拆分的新用例提供统一实现。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// 每个测试进程只能启动一次：config 在模块求值期把 DATA_DIR 固定成第一次的 root，
// 第二次 boot 会写到已删除的目录（随机 ENOENT）。需要多实例的用例请拆文件。
let consumed = false;

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{config?: object, token?: string}} [options]
 * @returns {Promise<{app: object, base: string, root: string, token: string,
 *   request: (method: string, route: string, body?: object, headers?: object) => Promise<{status: number, body: any}>}>}
 */
export async function bootConsole(t, { config = {}, token = 'smoke-token' } = {}) {
  if (consumed) throw new Error('console-boot 每个测试进程只能启动一次（config 的 DATA_DIR 在 import 期固定）');
  consumed = true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-console-smoke-'));
  process.env.QQ_AGENT_DATA_DIR = root;
  process.env.QQ_AGENT_SKIP_INDEX_WARM = '1';

  const { DEFAULT_CONFIG, updateConfig } = await import('../../src/core/config.js');
  const { createApp } = await import('../../src/console/app.js');
  const { installManualFriendReviewRoute } = await import('../../src/console/manual-friend-review-route.js');

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.server = { ...cfg.server, host: '127.0.0.1', port, token };
    cfg.runtime = { ...cfg.runtime, mode: 'observe' };
    cfg.allow = { ...cfg.allow, groups: ['1'], private: [] };
    cfg.onebot = { ...cfg.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: '' };
    cfg.api = { ...cfg.api, baseUrl: '', apiKey: '', model: 'deepseek-flash', priceRemoteUrl: 'none' };
    // server 允许局部覆盖（trustedProxies 等），否则调用方给 server 子对象会丢端口/令牌
    const merged = { ...cfg, ...config };
    if (config.server) merged.server = { ...cfg.server, ...config.server };
    updateConfig(merged);

    const app = createApp({ log: () => {} });
    installManualFriendReviewRoute(app);   // 与生产 server.js 的注册集一致
    try {
      const bound = await app.start();
      const base = `http://127.0.0.1:${bound}`;
      const request = async (method, route, body = undefined, headers = {}) => {
        const res = await fetch(`${base}${route}`, {
          method,
          headers: {
            'x-console-token': token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      };
      t.after(async () => {
        await app.stop().catch(() => {});
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
      });
      return { app, base, root, token, request };
    } catch (error) {
      lastError = error;
      await app.stop().catch(() => {});
      if (!/EADDRINUSE/.test(String(error?.message ?? ''))) break;
    }
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  throw lastError;
}
