// 梗库路由（从 console/app.js 拆出，2026-10-31 结构整治 M1）。
import { listMemes, rememberMeme, deleteMeme, memeStats } from '../../memes/store.js';

export function registerMemeRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  if (!router || !json || !readBody) throw new Error('registerMemeRoutes 需要 router/json/readBody');

  router.add('GET', '/api/memes', async (_req, res, params, url) => {
    const chatKey = String(url?.searchParams?.get('chatKey') || '').trim();
    const stats = memeStats();
    return json(res, 200, { ok: true, entries: listMemes(chatKey), count: stats.entries, chats: stats.chats });
  });
  router.add('POST', '/api/memes', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const entry = rememberMeme({
        chatKey: body.chatKey,
        term: body.term,
        meaning: body.meaning,
        usage: body.usage,
        aliases: body.aliases,
        createdBy: body.createdBy || 'console'
      });
      const stats = memeStats();
      return json(res, 200, { ok: true, entry, count: stats.entries, chats: stats.chats });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', '/api/memes', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const removed = deleteMeme(body.id);
    return removed ? json(res, 200, { ok: true, ...memeStats() }) : json(res, 404, { ok: false, error: '梗条目不存在' });
  });
}
