// 知识库路由（从 console/app.js 拆出，2026-10-31 结构整治 M1）。
// 依赖注入以 storage.js 为样板：显式取别名，避免 ops scan --strict 把解构参数当成未定义调用。
import { knowledgeEnabled, knowledgeStats, listKnowledgeFiles, writeKnowledgeFile, deleteKnowledgeFile, reindexKnowledge } from '../../knowledge/store.js';

export function registerKnowledgeRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  if (!router || !json || !readBody || !getConfig) throw new Error('registerKnowledgeRoutes 需要 router/json/readBody/getConfig');

  router.add('GET', '/api/knowledge', async (_req, res) =>
    json(res, 200, {
      ok: true,
      enabled: getConfig().knowledge?.enabled === true,
      available: knowledgeEnabled(),
      ...knowledgeStats()
    })
  );
  router.add('GET', '/api/knowledge/files', async (_req, res) =>
    json(res, 200, { ok: true, files: listKnowledgeFiles() })
  );
  router.add('POST', '/api/knowledge/files', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const file = writeKnowledgeFile(body.name, body.content);
      return json(res, 200, { ok: true, file, ...knowledgeStats() });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', '/api/knowledge/files', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const file = deleteKnowledgeFile(body.name);
      return json(res, 200, { ok: true, file, ...knowledgeStats() });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/knowledge/reindex', async (_req, res) =>
    json(res, 200, { ok: true, ...reindexKnowledge() })
  );
}
