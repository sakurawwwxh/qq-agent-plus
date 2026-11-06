// 管理员私聊里的只读状态/健康摘要。只读、脱敏，不碰配置原文与密钥。
import { hostStats } from '../core/host-stats.js';
import { runHealthCheck } from '../core/health-check.js';

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatAge(ms) {
  const value = Number(ms) || 0;
  if (value < 60_000) return `${Math.round(value / 1000)} 秒`;
  if (value < 3600_000) return `${Math.round(value / 60_000)} 分钟`;
  return `${(value / 3600_000).toFixed(1)} 小时`;
}

export function createStatusService({
  dataDir, store, onebot, getConfig: getConfigFn, getPlugins, getMcp, actions, now: nowFn = Date.now
} = {}) {
  function snapshot() {
    const cfg = getConfigFn();
    const outbox = store?.outboxStats?.() || { total: 0, byState: {} };
    const queues = store?.queueStats?.() || { byState: {}, oldestAgeMs: 0 };
    const unknown = store?.unknownSummaryAll?.() || { total: 0, oldestAgeMs: 0 };
    let host = null;
    try { host = hostStats({ dir: dataDir, now: nowFn() }); } catch { host = null; }
    let plugins = [];
    try { plugins = getPlugins?.()?.list?.()?.plugins || []; } catch { plugins = []; }
    let mcp = [];
    try { mcp = getMcp?.()?.status?.() || []; } catch { mcp = []; }
    const adminPending = actions?.listPending?.().length || 0;
    const adminUnknown = actions?.listUnknown?.().length || 0;
    return { cfg, outbox, queues, unknown, host, plugins, mcp, adminPending, adminUnknown };
  }

  function format() {
    const { cfg, outbox, queues, unknown, host, plugins, mcp, adminPending, adminUnknown } = snapshot();
    const pending = queues.byState || {};
    const states = outbox.byState || {};
    const installed = plugins.filter((plugin) => plugin.installed).length;
    const readyMcp = mcp.filter((server) => server.ready).length;
    const disk = host?.disk
      ? `磁盘 ${Number(host.disk.usedPercent) || 0}% 已用，可用 ${formatBytes(host.disk.free)}`
      : '磁盘不可用';
    return [
      `状态：${cfg.runtime?.mode || 'active'}${cfg.runtime?.paused ? '（已暂停）' : ''}`,
      `OneBot：${onebot?.connected ? '在线' : '离线'}`,
      `入站：pending ${pending.pending || 0} / leased ${pending.leased || 0} / held ${pending.held || 0} / deferred ${pending.deferred || 0}`,
      `出站：sending ${states.sending || 0} / failed ${states.failed || 0} / unknown ${states.unknown || 0}`,
      `未知发送：${unknown.total || 0} 条${unknown.oldestAgeMs ? `，最老 ${formatAge(unknown.oldestAgeMs)}` : ''}`,
      `插件：${installed}/${plugins.length} 已装；MCP：${readyMcp}/${mcp.length} 就绪`,
      `管理员动作：待确认 ${adminPending}；结果未知 ${adminUnknown}`,
      disk
    ].join('\n');
  }

  async function health() {
    const cfg = getConfigFn();
    const onebotCfg = cfg.onebot || {};
    // 主进程能拿到活的 MCP 注册表：不传的话，“MCP 没起来/没按配置隔离”
    // 只会在控制台一键体检里报红，管理员私聊的 !health 却始终显示通过。
    let mcpStatus = [];
    try { mcpStatus = getMcp?.()?.status?.() || []; } catch { mcpStatus = []; }
    const result = await runHealthCheck({
      dataDir,
      mode: cfg.runtime?.mode || 'active',
      consolePort: Number(cfg.server?.port) || 3210,
      onebotHttpPort: Number(onebotCfg.httpPort) || 3390,
      onebotHttpUrl: String(onebotCfg.httpUrl || ''),
      onebotToken: String(onebotCfg.httpAccessToken || onebotCfg.accessToken || ''),
      notify: null,
      persist: false,
      integrityCheck: false,
      mcpStatus
    });
    if (result?.healthy) return `健康检查通过（${result.checks?.length || 0} 项）。`;
    const failures = (result?.checks || []).filter((check) => !check.ok);
    if (!failures.length) return '健康检查未通过，但没有返回具体失败项。';
    return `健康检查未通过（${failures.length}/${result.checks.length} 项）：\n`
      + failures.slice(0, 8).map((check) => `- ${check.name}：${check.detail || '失败'}`).join('\n');
  }

  function unknownText() {
    const unknown = store?.unknownSummaryAll?.() || { total: 0, oldestAgeMs: 0 };
    return `未知发送：${unknown.total || 0} 条`
      + (unknown.oldestAgeMs ? `，最老 ${formatAge(unknown.oldestAgeMs)}` : '')
      + '。到控制台「会话」页核对，或让管理员在对应会话里核对。';
  }

  function failedText() {
    const outbox = store?.outboxStats?.() || { byState: {} };
    return `失败发送：${outbox.byState?.failed || 0} 条（可在控制台「会话」页查看失败原因）。`;
  }

  return { snapshot, format, health, unknown: unknownText, failed: failedText };
}
