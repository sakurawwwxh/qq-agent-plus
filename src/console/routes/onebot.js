// OneBot 目录查询（群 / 好友 / AI 音色）路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M3）。只做只读代理，缓存由协议端负责。
export function registerOnebotRoutes(router, deps = {}) {
  const json = deps.json;
  const getConfig = deps.getConfig;
  const onebot = deps.onebot;
  if (!router || !json || !getConfig || !onebot) {
    throw new Error('registerOnebotRoutes 需要 router/json/getConfig/onebot');
  }

  router.add('GET', '/api/onebot/groups', async (req, res) => {
    try {
      const list = await onebot.call('get_group_list');
      const groups = (Array.isArray(list) ? list : (list?.data ?? []))
        .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
      return json(res, 200, { groups });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/onebot/friends', async (req, res) => {
    try {
      const list = await onebot.call('get_friend_list');
      const friends = (Array.isArray(list) ? list : (list?.data ?? []))
        .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
      return json(res, 200, { friends });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
  // QQ 内置语音音色目录（控制台「平台能力」页的「音色」下拉用）。协议端是按群返回的，
  // 这里默认取第一个白名单群（QQ 的 AI 音色是官方固定目录，各群一致）；可用 ?groupId= 指定。
  router.add('GET', '/api/onebot/ai-characters', async (req, res, params, url) => {
    const groupId = String(url.searchParams.get('groupId') || getConfig().allow?.groups?.[0] || '').trim();
    if (!groupId) return json(res, 400, { error: '还没有可用的群：先在「聊天白名单」里加一个群，或用 ?groupId= 指定' });
    try {
      const characters = await onebot.getAiCharacters(groupId);
      return json(res, 200, { groupId, characters });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
}
