// 生活层（见闻）路由（从 console/app.js 拆出，2026-10-31 结构整治 M1）。
// 分享不直接发送：交给主动发言链路（requestManualWake），由模型用自己的语气说。
import { sanitizeUserText } from '../../core/util.js';

export function registerLifeFeedRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const lifeFeed = deps.lifeFeed;
  const auditWrite = deps.auditWrite;
  const orchestrator = deps.orchestrator;
  if (!router || !json || !readBody || !lifeFeed || !auditWrite || !orchestrator) {
    throw new Error('registerLifeFeedRoutes 需要 router/json/readBody/lifeFeed/auditWrite/orchestrator');
  }

  router.add('GET', '/api/life-feed/status', async (req, res) => {
    lifeFeed.drainInbox?.();
    return json(res, 200, { ok: true, ...lifeFeed.status() });
  });
  router.add('POST', '/api/life-feed/forage', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) {
      return json(res, 400, { ok: false, error: '觅食会发起外部请求，请带 confirm:true' });
    }
    const result = await lifeFeed.forageNow({ reason: 'manual' });
    return json(res, result.ok ? 200 : 409, result);
  });
  router.add('POST', '/api/life-feed/dismiss', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body?.bvid || body?.id || '').trim();
    if (!id) return json(res, 400, { ok: false, error: '缺少 bvid' });
    const result = lifeFeed.dismiss(id);
    return json(res, result.ok ? 200 : 404, result);
  });
  router.add('POST', '/api/life-feed/more', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body?.bvid || body?.id || '').trim();
    if (!id) return json(res, 400, { ok: false, error: '缺少 bvid' });
    const result = lifeFeed.feedback({ id, action: 'more_like_this' });
    return json(res, result.ok ? 200 : 404, result);
  });
  router.add('POST', '/api/life-feed/clear', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 400, { ok: false, error: '清空候选需要 confirm:true' });
    const result = lifeFeed.clearCandidates();
    auditWrite('life-feed.clear', 'life-feed:candidates', { req, removed: result.removed });
    return json(res, 200, result);
  });
  router.add('POST', '/api/life-feed/share', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 400, { ok: false, error: '请带 confirm:true' });
    const chatKey = String(body?.chatKey || '').trim();
    if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 不合法' });
    const taken = lifeFeed.takeForShare(String(body?.bvid || body?.id || ''), { manual: true });
    if (taken.error) return json(res, 404, { ok: false, error: taken.error });
    const item = taken.item;
    // 不直接发：交给主动发言链路，由模型用自己的语气说，人设/分条/限速/安静时段全部生效。
    // B 站标题/UP 是第三方页面内容，必须去掉“【…】”这类段头伪装后再进【系统提醒】。
    const itemSource = String(item.source || '');
    const source = itemSource.startsWith('plugin:')
      ? '插件见闻'
      : (itemSource === 'rss' ? 'RSS 见闻' : 'B 站见闻');
    const note = `【系统提醒】可以分享这条${source}：${sanitizeUserText(String(item.title ?? ''))}`
      + `（UP：${sanitizeUserText(String(item.up ?? ''))}）${sanitizeUserText(String(item.url ?? ''))}。`
      + `请调用 share_bilibili（bvid=${item.id}，comment=你的一句话）发送标题链接和封面，不要用 send_message 重复发链接。`
      .slice(0, 600);
    const wake = orchestrator.requestManualWake(chatKey, { wakeNote: note });
    if (!wake.ok) {
      // 没有真正进入发送链路：撤回 offer/排队记录，允许用户稍后重试。
      lifeFeed.releaseShare(item.id);
      return json(res, 409, { ok: false, error: wake.reason || '无法安排这次分享' });
    }
    auditWrite('life-feed.share', chatKey, { req, bvid: item.id });
    return json(res, 200, { ok: true, status: 'queued', item });
  });
}
