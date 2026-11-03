// 存储占用相关路由（2026-10-30）。
//
// 单独成模块而不是继续写进 console/app.js：app.js 已经 7400 行，历史原因是
// "每个功能都往同一个闭包里加 handler"。新接口按领域拆出来，app.js 只留一行注册，
// 后续想搬别的路由可以照这个样板做。
//
// 依赖注入而不是 import 单例：sessions 实例由 app.js 的闭包持有（带运行中会话），
// json 是所有路由共用的响应助手（统一 CORS/序列化口径）。
export function registerStorageRoutes(router, deps = {}) {
  // 显式取别名而不是解构参数：`ops scan --strict` 的未定义调用扫描器不认识解构参数，
  // 会把 json(...) 误报成"可疑未定义调用"（router.js 顶部有同款说明）。
  const json = deps.json;
  const sessions = deps.sessions;
  if (!router || !sessions) throw new Error('registerStorageRoutes 需要 router 与 sessions');

  router.add('GET', '/api/storage', async (req, res) => {
    // fresh=true：用户点开面板时看到的是当下数字，不吃 30 秒缓存
    return json(res, 200, { ok: true, ...sessions.storageStats({ fresh: true }) });
  });

  // 手动触发一次"压缩 N 天前的留档"（幂等：已经压过的跳过）。
  // 不做删除——删除只走保留期调度与总量预算，避免控制台按钮变成不可逆操作。
  router.add('POST', '/api/storage/compress', async (req, res) => {
    const result = await sessions.compressSessions();
    return json(res, 200, {
      ok: true,
      ...result,
      storage: sessions.storageStats({ fresh: true })
    });
  });
}
