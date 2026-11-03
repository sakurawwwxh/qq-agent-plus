// 控制台 /api/status 与用量统计路由（从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// 状态聚合只做投影：数据来源（onebot/orchestrator/sessions/effects）全部注入，
// 统计函数 buildUsageStats/buildUsageBreakdown 仍留在 app.js（它们与用量缓存同处一文件）。
import { uiBuildStamp } from '../ui-build.js';
import { todayKey } from '../../core/util.js';
import { tokenSaverEffective } from '../../core/token-saver.js';
import { budgetStatus } from '../../core/budget.js';
import { lastTraceId } from '../../core/logger.js';
import { timeControlState } from '../../core/time-control.js';
import { vendorOfConfig, resolveModelPrice, priceAt, costModeOf } from '../../pricing/model-prices.js';

export function registerStatusRoutes(router, deps = {}) {
  const json = deps.json;
  const getConfig = deps.getConfig;
  const sessions = deps.sessions;
  const onebot = deps.onebot;
  const orchestrator = deps.orchestrator;
  const incidentPilotStatus = deps.incidentPilotStatus;
  const effects = deps.effects;
  const uiDir = deps.uiDir;
  const version = deps.version;
  const getConfigConflict = deps.getConfigConflict;
  const buildUsageStats = deps.buildUsageStats;
  const buildUsageBreakdown = deps.buildUsageBreakdown;
  if (!router || !json || !getConfig || !sessions || !onebot || !orchestrator
    || !incidentPilotStatus || !effects || !uiDir || !version || !getConfigConflict
    || !buildUsageStats || !buildUsageBreakdown) {
    throw new Error('registerStatusRoutes 需要 router/json/getConfig/sessions/onebot/orchestrator/effects/uiDir/version/统计函数');
  }

  // /api/status 可能被多个页面/脚本高频轮询；uiBuildStamp 递归 readdir+stat 全量 ui/ 文件，
  // 每请求几十次 statSync（2026-11-03 第五轮复审 A9）。3 秒缓存足够让“控制台已更新”提示
  // 及时出现，又把常态轮询的成本压到最低。
  let uiStampCache = null;
  const cachedUiBuildStamp = () => {
    const now = Date.now();
    if (uiStampCache && now - uiStampCache.at < 3000) return uiStampCache.stamp;
    const stamp = uiBuildStamp(uiDir);
    uiStampCache = { at: now, stamp };
    return stamp;
  };

  router.add('GET', '/api/status', async (req, res) => {
    const dayKey = todayKey();
    const sessionUsage = sessions.todayUsage(dayKey);
    const dailyStats = buildUsageStats({ range: 'today' });
    const totals = dailyStats.totals;
    const usage = {
      dayKey,
      // token / 次数从 usage-today + 运行中会话直接取（实时）；cost 仍来自会话文件聚合，
      // 最多滞后 USAGE_CACHE_TTL_MS（Issue #45：不能让顶栏轮询驱动全量扫盘）。
      promptTokens: sessionUsage.promptTokens,
      completionTokens: sessionUsage.completionTokens,
      totalTokens: sessionUsage.totalTokens,
      cachedTokens: sessionUsage.cachedTokens,
      runs: sessionUsage.runs,
      webSearchCount: sessionUsage.webSearchCount,
      // 改进方案 #8：当日估算金额与未计价运行数（budgetStatus 的口径来源）
      estimatedYuan: Number(sessionUsage.estimatedYuan) || 0,
      unpricedRuns: Number(sessionUsage.unpricedRuns) || 0
    };
    const cfgNow = getConfig();
    // 省 Token 模式的"用户值 / 生效值"对照表：控制台设置页直接渲染，避免两边各写一份上限数字
    const tokenSaver = tokenSaverEffective(cfgNow);
    const currentVendor = vendorOfConfig(cfgNow) || '';
    const currentPrice = resolveModelPrice(cfgNow.api?.model, cfgNow, null, { vendor: currentVendor });
    const currentTier = currentPrice.peak
      ? priceAt(currentPrice, Date.now())
      : currentPrice;
    const cost = {
      cost: totals.cost,
      // 台账口径（usage-today 的 estimatedYuan）：含记忆整理等不写 session 的后台调用；
      // 旧字段 cost 保留会话口径给明细用（2026-11-01 插件仓库 issue #25）。
      ledgerCost: Number(sessionUsage.estimatedYuan) || 0,
      source: currentPrice.source,
      calculation: 'per-call',
      breakdown: totals.breakdown,
      // 口径：实付（用户自己填的价）/ 估算（官方表、兜底）/ 未定价
      kind: currentPrice.kind || 'estimate',
      billing: currentPrice.billing || 'token',
      costMode: costModeOf(cfgNow).mode,
      costMultiplier: costModeOf(cfgNow).multiplier,
      costMonthlyFee: costModeOf(cfgNow).monthlyFee,
      fallbackCalls: totals.fallbackCalls || 0,
      billingAmount: Number(currentPrice.amount) || 0,
      billingPeriod: currentPrice.period === 'day' ? 'day' : 'month',
      actualCost: totals.actualCost || 0,
      estimateCost: totals.estimateCost || 0,
      flatCost: (totals.flatItems || []).reduce((sum, item) => (
        item.period === 'month' ? sum + (Number(item.amount) || 0) : sum
      ), 0),
      flatCalls: totals.flatCalls || 0,
      localCalls: totals.localCalls || 0,
      prices: {
        in: currentTier.in,
        out: currentTier.out,
        cached: currentTier.cached
      },
      matched: currentPrice.matched,
      // 未定价 = 当前模型没有单价（不是免费）；界面据此提示"含未定价调用"
      unpriced: currentPrice.unpriced === true,
      confidence: currentPrice.confidence || '',
      via: currentPrice.via || '',
      peak: Boolean(currentTier.peak),
      hasPeakTiers: totals.hasPeakModel,
      peakCost: totals.peakCost,
      offPeakCost: totals.offPeakCost,
      exactCalls: totals.exactCalls,
      calls: totals.runs
    };
    return json(res, 200, {
      onebot: {
        connected: onebot.connected,
        everConnected: onebot.everConnected,
        error: onebot.lastConnectError,
        lastEventAt: Number(onebot.lastEventAt) || 0,
        lastHeartbeatAt: Number(onebot.lastHeartbeatAt) || 0,
        self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
      },
      orchestrator: orchestrator.statusSummary(),
      incidentPilot: incidentPilotStatus(),
      usage,
      // 改进方案 #8：当日预算状态（enabled/limit/spent/exceeded/onExceed/unpricedRuns）
      budget: budgetStatus(cfgNow, usage),
      // 改进方案 #6：最近一次运行的 trace id（拿它去 journalctl / 日志文件捞整条链路）
      lastTraceId: lastTraceId(),
      cost,
      // 与 usage 同口径（实时）：cached/prompt；totals 的命中率来自滞后的会话聚合
      cacheHitRate: usage.promptTokens ? Math.min(1, usage.cachedTokens / usage.promptTokens) : 0,
      webSearchCount: usage.webSearchCount || 0,
      // 前端构建戳：轮询时发现它变了 → 前端提示"控制台已更新，点击刷新"
      uiBuild: cachedUiBuildStamp(),
      // 进程运行期间 config.json 被外部改过：磁盘版本已备份，控制台据此提示
      configConflict: getConfigConflict(),
      // 当前版本号（package.json 的 version）：控制台侧栏与控制页的版本徽标用它。
      // 之前控制页只显示部署提交号（sha），用户看不出"这是哪个版本"。
      version,
      // 省 Token 模式：模式 + 每项的"用户值 / 生效值"（设置页渲染用）
      tokenSaver,
      ...(cfgNow.timeControl?.enabled ? {
        timeControl: timeControlState(cfgNow.timeControl)
      } : {}),
      paused: orchestrator.paused,
      pauseReason: orchestrator.pauseReason ?? null,
      // 留档占用（文件数/字节/压缩数/上限）：总览页"主机资源"用它显示，
      // 避免用户收到磁盘告警才知道 data/sessions 在涨。模块内 30 秒缓存。
      storage: sessions.storageStats(),
      // 出站副作用账本：unknown > 0 说明有"不知道发没发出去"的动作，需要人工核对
      effects: effects.stats()
    });
  });
  router.add('GET', '/api/usage/stats', async (req, res, params, url) => {
    try {
      const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
      const stats = buildUsageStats({ range: raw });
      return json(res, 200, { ok: true, range: raw, ...stats });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/usage/breakdown', async (req, res, params, url) => {
    try {
      const raw = String(url.searchParams.get('range') || '7');
      const dim = String(url.searchParams.get('dim') || '');
      const key = String(url.searchParams.get('key') || '');
      const by = String(url.searchParams.get('by') || '');
      const r = buildUsageBreakdown({ range: raw, dim, key, by });
      return json(res, 200, { ok: true, ...r });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
}
