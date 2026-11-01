// 自定义搜索服务（webSearch.providers）与联网搜索测试路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// API Key 只写不读：GET 只回 hasApiKey；提交 '******' 表示保持原 Key。
import { customSearch, webSearch } from '../../llm/web-search.js';
import { sanitizeUserText } from '../../core/util.js';

export function registerSearchRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const updateConfig = deps.updateConfig;
  if (!router || !json || !readBody || !getConfig || !updateConfig) {
    throw new Error('registerSearchRoutes 需要 router/json/readBody/getConfig/updateConfig');
  }

  router.add('GET', '/api/search-providers', async (req, res) => {
    const list = (getConfig().webSearch?.providers || []).map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      model: p.model,
      count: p.count,
      timeoutMs: p.timeoutMs,
      hasApiKey: Boolean(String(p.apiKey || '').trim())   // 不返回明文
    }));
    return json(res, 200, { providers: list });
  });
  router.add('POST', '/api/search-providers', async (req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const baseUrl = String(body.baseUrl ?? '').trim();
      const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
      if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
      const list = [...(getConfig().webSearch?.providers || [])];
      const index = list.findIndex((p) => p.baseUrl === baseUrl && p.type === type);
      let entry;
      if (index >= 0) {
        // 必须构造副本：getConfig() 返回的是活引用，就地改会在 updateConfig 写盘失败
        //（CONFIG_CONFLICT/磁盘错误）时污染回滚后的内存配置（2026-10-31 复审 P2）。
        const existing = list[index];
        entry = {
          ...existing,
          name: String(body.name ?? existing.name ?? '').trim() || existing.name,
          baseUrl,
          type,
          model: String(body.model ?? existing.model ?? '').trim(),
          count: Math.min(20, Math.max(1, Number(body.count) || existing.count || 6)),
          timeoutMs: Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000)
        };
        // 掩码/空 = 保持原 Key 不变
        const submitted = String(body.apiKey ?? '').trim();
        if (submitted && submitted !== '******') entry.apiKey = submitted;
        list[index] = entry;
      } else {
        entry = {
          id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name: String(body.name ?? '').trim() || baseUrl,
          type,
          baseUrl,
          apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
          model: String(body.model ?? '').trim(),
          count: Math.min(20, Math.max(1, Number(body.count) || 6)),
          timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
        };
        list.push(entry);
      }
      updateConfig({ webSearch: { providers: list } });
      return json(res, 200, {
        ok: true,
        provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) }
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', '/api/search-providers', async (req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const id = String(body.id ?? '').trim();
      if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
      const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
      updateConfig({ webSearch: { providers: list } });
      // 若当前正选中被删的那项，回落 bing，避免搜索直接报错
      const cur = String(getConfig().webSearch?.provider || '');
      if (cur === `custom:${id}`) {
        updateConfig({ webSearch: { provider: 'bing' } });
      }
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/search-providers/test', async (req, res) => {
    const startedAt = Date.now();
    try {
      const body = await readBody(req).catch(() => ({}));
      const provId = String(body.providerId ?? '').trim();
      const r = await customSearch('qq agent 测试', provId || null);
      return json(res, 200, {
        ok: true,
        result: {
          ok: true,
          count: r.results.length,
          sample: r.results[0]?.title || '',
          latencyMs: Date.now() - startedAt
        }
      });
    } catch (error) {
      return json(res, 200, {
        ok: true,
        result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt }
      });
    }
  });
  router.add('POST', '/api/web-search/test', async (req, res) => {
    const startedAt = Date.now();
    try {
      const body = await readBody(req).catch(() => ({}));
      const query = String(body.query ?? '').trim().slice(0, 120);
      if (!query) return json(res, 400, { ok: false, error: '请输入要测试的搜索词' });
      const result = await webSearch(query, { meme: body.meme === true });
      const sources = Array.isArray(result.sources) && result.sources.length
        ? result.sources
        : [String(getConfig().webSearch?.provider || 'bing')];
      return json(res, 200, {
        ok: true,
        query,
        meme: body.meme === true,
        sources,
        supplemented: sources.some((source) => source !== 'bing'),
        count: result.results.length,
        latencyMs: Date.now() - startedAt,
        results: result.results.slice(0, 8).map((item) => {
          const url = String(item?.url ?? '');
          return {
            title: sanitizeUserText(String(item?.title ?? '')).slice(0, 200),
            url: /^https?:\/\//i.test(url) ? url.slice(0, 500) : '',
            snippet: sanitizeUserText(String(item?.snippet ?? '')).slice(0, 400)
          };
        })
      });
    } catch (error) {
      return json(res, 200, {
        ok: false,
        error: String(error?.message ?? error).slice(0, 300),
        latencyMs: Date.now() - startedAt
      });
    }
  });
}
