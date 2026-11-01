// 控制台路由表（改进方案 #2，设计定稿见方案附录 J.1）。
// 背景：旧形态是 handleHttp 里 100+ 处 `pathname === ...` 内联 if 链 + 一条
// 「摘掉 server 监听再包一层」的例外路由。本模块提供注册式路由，迁移方式为
// **加壳并行**：handleHttp 开头先 `if (await router.handle(req, res)) return;`，
// 每次搬 5–10 条分支进表、搬走即删原分支；未迁移的自动落回 if 链（handle 返回 false）。
//
// 契约（与方案附录 J.1 一致）：
// - add(method, path, handler, opts)：handler(req, res, params, url)
//   - path 支持三种形态：字面量 '/api/x'；带 ':param' 的路径（按段匹配，decode 后进 params）；
//     **RegExp**（捕获组以数组进 params —— 现有 28 处正则路由靠它安放：约束/交替/大小写标志
//     是 ':param' 表达不了的）
//   - opts.auth       默认 true；false 仅限 /healthz 与 /api/login 两处。
//                    SSE（/api/events）**也用默认 true**（旧实现是分支内手写 authorize）——
//                    不要给它加 auth:false，那会让事件流免鉴权（2026-09-30 审查 P3 修正文案）
//   - opts.keyEndpoint true 时经 keyEndpointAllowed（明文密钥回读端点专用）
//   - opts.audit      #5 阶段二（路由声明式审计）留的挂点；阶段一手工埋点不经过它
//   - deps.tokenFp    () => string：鉴权成功后记 req.consoleTokenFp（#5 审计埋点读它）
// - handle(req, res) → true 已处理；false 交回 if 链 / 静态兜底。
//   路径命中但方法不匹配 → 405（带 Allow 头，附录 J.1 拍板的行为变化）。
//   迁移期「未命中的 /api/ 一律 404 不落静态」暂不启用：那会吃掉 if 链里尚未迁移的路由；
//   等迁移收尾时用 apiFallthrough:false 打开。

// 迁移已完成（2026-09-30）：apiFallthrough 默认 false —— 未命中的 /api/ 一律 404 JSON
// （与旧 if 链尾部的文案逐字一致），不落静态服务。deps.apiFallthrough 仅作测试/过渡用。
import { newTraceId, withTrace } from '../core/logger.js';

export function createRouter(deps = {}) {
  // 显式取别名而不是解构参数：ops.js 的未定义调用扫描器不认识解构参数，
  // 会把 authorize(...) 误报成"可疑未定义调用"（CI 门禁 --strict 会红）。
  const authorize = deps.authorize;
  const json = deps.json;
  const keyEndpointAllowed = deps.keyEndpointAllowed || (() => true);
  const tokenFp = deps.tokenFp || null;
  const apiFallthrough = deps.apiFallthrough === true;
  const metrics = deps.metrics || null;
  const routes = [];

  function add(method, path, handler, opts = {}) {
    if (typeof handler !== 'function') throw new Error('router.add 需要 handler 函数');
    routes.push({
      method: String(method || 'GET').toUpperCase(),
      path,
      handler,
      auth: opts.auth !== false,
      keyEndpoint: opts.keyEndpoint === true,
      audit: opts.audit || ''
    });
  }

  // 返回 { matched: bool, params }；params：':param' 路由为命名对象，RegExp 路由为捕获组数组
  function matchPath(route, pathname) {
    if (route.path instanceof RegExp) {
      const m = route.path.exec(pathname);
      return m ? { matched: true, params: [...m] } : { matched: false, params: null };
    }
    const want = String(route.path).split('/');
    const got = pathname.split('/');
    if (want.length !== got.length) return { matched: false, params: null };
    const params = {};
    for (let i = 0; i < want.length; i++) {
      const seg = want[i];
      if (seg.startsWith(':')) {
        if (!got[i]) return { matched: false, params: null };
        try { params[seg.slice(1)] = decodeURIComponent(got[i]); } catch { return { matched: false, params: null }; }
      } else if (seg !== got[i]) {
        return { matched: false, params: null };
      }
    }
    return { matched: true, params };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = String(req.method || 'GET').toUpperCase();
    // 指标：在 writeHead/end 上各挂一次（只记第一次），SSE 也在 writeHead 时记一笔。
    if (metrics && typeof res.writeHead === 'function' && typeof res.end === 'function') {
      const startedNs = process.hrtime.bigint();
      let recorded = false;
      const record = (status) => {
        if (recorded) return;
        recorded = true;
        metrics.recordHttp(status, Number(process.hrtime.bigint() - startedNs) / 1e6);
      };
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = (status, ...rest) => {
        record(status);
        return originalWriteHead(status, ...rest);
      };
      const originalEnd = res.end.bind(res);
      res.end = (...args) => {
        record(res.statusCode || 200);
        return originalEnd(...args);
      };
    }
    // #6：每个 HTTP 请求一个 trace id，回在响应头里（控制台/脚本按它去捞日志）。
    // remember:false —— 它不该覆盖 /api/status 的 lastTraceId（那是"最近一次运行"的 id）。
    const traceId = newTraceId();
    if (typeof res.setHeader === 'function') res.setHeader('x-trace-id', traceId);   // 测试用的极简 res 没有它


    // 先做完整匹配收集：**405/404 也必须先过鉴权**。旧的 /api/ 总闸是"先 authorize
    // 再看路径"，无 token 时任何 /api/* 都是 401；若让 405/404 绕过鉴权，未授权者就能
    // 用 404/405/401 三态区分出"路径不存在 / 存在且支持这些方法（Allow 头）/ 存在且方法正确"
    // —— 等于一份 API 面清单（2026-09-30 外部审查 P2，已核实并修复）。
    const matched = [];
    for (const route of routes) {
      const { matched: hit, params } = matchPath(route, pathname);
      if (hit) matched.push({ route, params });
    }
    // 鉴权前置：路径命中且候选里有要求鉴权的路由，或（无命中时）/api/ 前缀本身，都先过 authorize
    const needsAuth = matched.length
      ? matched.some(({ route }) => route.auth)
      : pathname.startsWith('/api/');
    if (needsAuth && !authorize(req)) {
      json(res, 401, { error: '未授权' });
      return true;
    }
    // 审计（#5）：鉴权成功即记下本次凭据指纹，供写接口埋点直接读（与鉴权同一次取值，
    // 埋点不再各自读配置）。未设令牌（localhost 模式）时为空串。
    if (needsAuth && typeof tokenFp === 'function' && req.consoleTokenFp === undefined) {
      req.consoleTokenFp = String(tokenFp() ?? '');
    }

    const hit = matched.find(({ route }) => route.method === method);
    if (hit) {
      if (hit.route.keyEndpoint && !keyEndpointAllowed(req)) {
        json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return true;
      }
      await withTrace(traceId, () => hit.route.handler(req, res, hit.params, url), { remember: false });   // 异常冒泡给 createServer 的统一处理（记 incident + 500）
      return true;
    }
    if (matched.length > 0) {
      // 路径命中但方法不匹配：405（附录 J.1 拍板；旧的 if 链形态这里会落空成 404）
      const allow = [...new Set(matched.map(({ route }) => route.method))].join(', ');
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow });
      res.end(JSON.stringify({ error: `方法不允许：${method}` }));
      return true;
    }
    if (!apiFallthrough && pathname.startsWith('/api/')) {
      // 与旧 if 链尾部逐字一致的文案（前端/脚本按它判"接口不存在"）
      json(res, 404, { error: `未知 API：${req.method || 'GET'} ${pathname}` });
      return true;
    }
    return false;
  }

  /**
   * 路由清单（method + path + 鉴权标志）。路径是 RegExp 时转成字符串，
   * 供 `test/route-parity.test.mjs` 做顺序敏感的快照；不含 handler（不可序列化）。
   */
  function listRoutes() {
    return routes.map((route) => ({
      method: route.method,
      path: route.path instanceof RegExp ? String(route.path) : route.path,
      auth: route.auth,
      keyEndpoint: route.keyEndpoint
    }));
  }

  return { add, handle, routes, listRoutes };
}
