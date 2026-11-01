// MCP 路由（从 console/app.js 拆出，2026-10-31 结构整治 M1）。
import { searchPresets } from '../../mcp/presets.js';
import { searchRegistry } from '../../mcp/registry.js';

export function registerMcpRoutes(router, deps = {}) {
  const json = deps.json;
  const mcpManager = deps.mcpManager;
  if (!router || !json || !mcpManager) throw new Error('registerMcpRoutes 需要 router/json/mcpManager');

  router.add('GET', '/api/mcp/presets', async (_req, res, params, url) => {
    const query = String(url?.searchParams?.get('query') || '').trim();
    return json(res, 200, { ok: true, results: searchPresets(query) });
  });
  router.add('GET', '/api/mcp/registry', async (_req, res, params, url) => {
    const query = String(url?.searchParams?.get('query') || '').trim();
    try {
      const results = await searchRegistry(query);
      return json(res, 200, { ok: true, results });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/mcp', async (_req, res) =>
    json(res, 200, { ok: true, status: mcpManager.status() })
  );
  router.add('POST', '/api/mcp/reload', async (_req, res) => {
    try {
      const status = await mcpManager.reload();
      return json(res, 200, { ok: true, status });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
}
