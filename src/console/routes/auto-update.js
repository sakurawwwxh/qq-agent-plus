// 自动更新路由（从 console/app.js 拆出，2026-10-31 结构整治 M2）。
// autoUpdate 在 createApp 里是 let（构造期可能为 null），所以用 getter 注入，
// 不能在注册时把对象值捕获进来。
import { autoUpdatePending, readAutoUpdateState } from '../../auto-update.js';
import { checkForUpdate, ignoreVersion } from '../../update-notice.js';
import { isContainerRuntime, containerUpdateHint } from '../../core/runtime.js';

export function registerAutoUpdateRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const auditWrite = deps.auditWrite;
  const getConfig = deps.getConfig;
  const getAutoUpdate = deps.getAutoUpdate;
  const dataDir = deps.dataDir;
  if (!router || !json || !readBody || !auditWrite || !getConfig || !getAutoUpdate || !dataDir) {
    throw new Error('registerAutoUpdateRoutes 需要 router/json/readBody/auditWrite/getConfig/getAutoUpdate/dataDir');
  }
  const autoUpdate = () => getAutoUpdate();

  router.add('PUT', '/api/auto-update/settings', async (req, res) => {
    const body = await readBody(req);
    try {
      autoUpdate().configure({
        ownerUin: body.ownerUin,
        intervalHours: body.intervalHours
      });
      return json(res, 200, { ok: true, status: autoUpdate().status() });
    } catch (error) {
      return json(res, error.httpStatus || 400, {
        error: String(error?.message ?? error)
      });
    }
  });
  router.add('POST', '/api/auto-update/run', async (req, res) => {
    const body = await readBody(req);
    // 容器里没有 update service / systemd，提交请求只会留下一个永远不执行的 pending。
    // 先于 confirm 判断：否则容器用户第一次点击只会看到“需要显式确认”，
    // 看不到真正原因（2026-10-31 复审 P2）。
    if (isContainerRuntime()) {
      return json(res, 409, { error: containerUpdateHint() });
    }
    if (body.confirm !== true) {
      return json(res, 409, { error: '手动更新需要显式确认' });
    }
    try {
      const status = autoUpdate().requestManual({ version: body.version });
      auditWrite('auto-update.run', String(body.version || ''), { req, after: status });
      return json(res, 202, { ok: true, status });
    } catch (error) {
      auditWrite('auto-update.run', String(body.version || ''), { req, ok: false, error: String(error?.message ?? error) });
      return json(res, error.httpStatus || 409, {
        error: String(error?.message ?? error)
      });
    }
  });
  router.add('POST', '/api/auto-update/resume', async (req, res) => {
    const body = await readBody(req);
    if (body.confirm !== true) {
      return json(res, 409, { error: '恢复自动更新需要显式确认' });
    }
    try {
      autoUpdate().resume({
        ownerUin: body.ownerUin,
        intervalHours: body.intervalHours
      });
      auditWrite('auto-update.resume', String(body.ownerUin ?? ''), { req, after: autoUpdate().status() });
      return json(res, 200, { ok: true, status: autoUpdate().status() });
    } catch (error) {
      auditWrite('auto-update.resume', String(body.ownerUin ?? ''), { req, ok: false, error: String(error?.message ?? error) });
      return json(res, error.httpStatus || 400, {
        error: String(error?.message ?? error)
      });
    }
  });
  router.add('POST', '/api/auto-update/pause', async (req, res) => {
    const body = await readBody(req);
    if (body.confirm !== true) {
      return json(res, 409, { error: '暂停自动更新需要显式确认' });
    }
    autoUpdate().pause();
    return json(res, 200, { ok: true, status: autoUpdate().status() });
  });
  router.add('POST', '/api/auto-update/notify-pending', async (req, res) => {
    const status = await autoUpdate().handlePendingFailure();
    return json(res, 200, { ok: true, status });
  });
  router.add('GET', '/api/auto-update/check', async (req, res) => {
    // 「发现新版本」提示：只读检查 + Release 说明，结果缓存 30 分钟。
    // 点「立即更新」不走这里，仍由 /api/auto-update/run 触发既有部署链路。
    try {
      const notice = await checkForUpdate(dataDir, getConfig());
      const state = readAutoUpdateState(dataDir);
      return json(res, 200, {
        ok: true,
        notice,
        ignoredVersion: String(state.ignoredVersion || ''),
        // 已经提交、还没跑完的更新（见 autoUpdatePending）：前端据此不再重复弹同一个版本
        pending: autoUpdatePending(dataDir)
      });
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/auto-update/ignore', async (req, res) => {
    const body = await readBody(req);
    const version = ignoreVersion(dataDir, body.version);
    if (!version) return json(res, 400, { error: '缺少要忽略的版本号' });
    return json(res, 200, { ok: true, ignoredVersion: version });
  });
}
