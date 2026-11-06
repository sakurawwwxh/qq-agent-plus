import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStatusService } from '../src/admin/status.js';

test('状态摘要：只读聚合、不泄露配置原文，并显示管理员动作计数', () => {
  const service = createStatusService({
    dataDir: process.cwd(),
    store: {
      outboxStats: () => ({ total: 3, byState: { sending: 1, failed: 1, unknown: 1 } }),
      queueStats: () => ({ byState: { pending: 2, held: 1 }, oldestAgeMs: 90_000 }),
      unknownSummaryAll: () => ({ total: 1, oldestAgeMs: 90_000 })
    },
    onebot: { connected: true },
    getConfig: () => ({ runtime: { mode: 'active', paused: false } }),
    getPlugins: () => ({ list: () => ({ plugins: [{ installed: true }, { installed: false }] }) }),
    getMcp: () => ({ status: () => [{ ready: true }, { ready: false }] }),
    actions: {
      listPending: () => [{ id: 'ad_1' }],
      listUnknown: () => [{ id: 'ad_2' }, { id: 'ad_3' }]
    }
  });
  const text = service.format();
  assert.match(text, /状态：active/);
  assert.match(text, /OneBot：在线/);
  assert.match(text, /入站：pending 2/);
  assert.match(text, /出站：sending 1 \/ failed 1 \/ unknown 1/);
  assert.match(text, /未知发送：1 条/);
  assert.match(text, /插件：1\/2 已装；MCP：1\/2 就绪/);
  assert.match(text, /管理员动作：待确认 1；结果未知 2/);
  assert.doesNotMatch(text, /token|apiKey|secret/i);
  assert.match(service.unknown(), /未知发送：1 条/);
  assert.match(service.failed(), /失败发送：1 条/);
});
