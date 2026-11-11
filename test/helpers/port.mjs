// 控制台/API 测试的端口分配与启动重试。
//
// freePort 是“先绑 0、拿端口、再关掉、稍后复用”，在并发测试里存在 TOCTOU 窗口：
// 另一个测试或本机进程可能在这几毫秒内占走端口，app.start() 报 EADDRINUSE。
// 生产默认 strictPort，不能靠换端口静默；测试里则应该换一个新端口重试，并把
// 已半启动的 app 停干净。
import http from 'node:http';

export async function freePort(host = '127.0.0.1') {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, host, resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function isPortConflict(error) {
  return error?.code === 'EADDRINUSE' || /EADDRINUSE/i.test(String(error?.message || error));
}

/**
 * @param {{ create: (port:number)=>any|Promise<any>, attempts?:number }} options
 *   create 负责用指定端口构造 app；返回对象需提供 start()/stop()。
 * @returns {Promise<{app:any, port:number}>}
 */
export async function startAppWithPortRetry({ create, attempts = 5 } = {}) {
  if (typeof create !== 'function') throw new TypeError('create must be a function');
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await freePort();
    let app = null;
    try {
      app = await create(port);
      const bound = await app.start();
      return { app, port: Number(bound) || port };
    } catch (error) {
      lastError = error;
      // 不能只依赖 start() 的失败清理：有的实现 listen 成功后才抛后续初始化错误。
      try { await app?.stop?.(); } catch { /* 已停 */ }
      if (!isPortConflict(error)) throw error;
    }
  }
  throw lastError || new Error('无法分配可用的测试端口');
}
