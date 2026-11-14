// Linux 服务总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRouter } from './router.js';
import { createMetrics } from './metrics.js';
import { registerStorageRoutes } from './storage.js';
import { createSseSender } from './sse.js';
import { createNoticeDedup, emojiNoticeKey, pokeNoticeKey } from './notice-dedup.js';

import { asrApiKey, asrAvailable, asrConfigured, asrKeyHost, asrKeySlots, asrKeySource, asrLocalBin, asrLocalModel, asrSecretId, asrSecretKey, conversationConfigForChat, findWhisperBinSync, getConfig, getConfigConflict, identityPilotEnabled, imageGenAvailable, imageGenKeyHosts, incidentPilotEnabled, slangPilotEnabled, storeConfigForChat, updateConfig, onTimeControlChange, DATA_DIR, ROOT } from '../core/config.js';
import { redactText } from '../core/redact.js';
import { warmMarketIndex } from '../skills/market.js';
import { catchupReplyWindowMs, catchupLogLine, isFreshForReply } from '../core/catchup-policy.js';
import { sanitizeConfigSecrets } from '../core/secret-keys.js';
import { appendAudit, queryAudit } from '../core/audit-log.js';
import { createLogger } from '../core/logger.js';
import { createTimeBudget } from '../core/time-budget.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes } from '../onebot/onebot.js';
import { faceNameOf } from '../onebot/face-catalog.js';
import { readForwardMessages, readForwardNodesById, forwardResIdFromSegment } from '../onebot/forward-reader.js';
import { ChatStore } from '../core/store.js';
import { EffectLedger } from '../core/effects.js';
import { MemoryStore } from '../memory/memory.js';
import { LivingMemoryRuntime } from '../living-memory/runtime.js';
import { StickerManager } from '../onebot/sticker-manager.js';
import { SendQueue } from '../onebot/sender.js';
import { SessionRegistry, personaLabelOfPrompt, listSessionFiles, readSessionFile } from '../core/sessions.js';
import { Orchestrator } from '../core/orchestrator.js';
import { DailyMomentsManager } from '../features/daily-moments.js';
import { LifeFeedManager } from '../features/life-feed.js';
import { QzoneInteractionManager } from '../features/qzone-interactions.js';
import { GroupDigestManager } from '../features/group-digest.js';
import { AdminBriefingManager } from '../features/admin-briefing.js';
import { createAdminServices } from '../admin/bootstrap.js';
import { GroupGameManager } from '../features/group-game.js';
import { ReminderStore } from '../core/reminders.js';
import { PluginRegistry } from '../plugins/registry.js';
import { McpManager } from '../mcp/manager.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerMemeRoutes } from './routes/memes.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerLivingMemoryRoutes } from './routes/living-memory.js';
import { registerLifeFeedRoutes } from './routes/life-feed.js';
import { registerAutoUpdateRoutes } from './routes/auto-update.js';
import { registerManagerRoutes } from './routes/managers.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerChatRoutes } from './routes/chats.js';
import { registerOutboxRoutes } from './routes/outbox.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerMediaSettingsRoutes } from './routes/media-settings.js';
import { registerPriceRoutes } from './routes/prices.js';
import { registerOnebotRoutes } from './routes/onebot.js';
import { registerPersonaRoutes } from './routes/persona.js';
import { registerSearchRoutes } from './routes/search.js';
import { chatCompletion, cachedTokensOfUsage, llmRuntimeStats, addUsage, emptyUsage } from '../llm/llm.js';
import { matchesBlacklistKeyword } from '../core/keyword-rules.js';
import { imageGenKeyStale } from '../llm/image-gen.js';
import { TTS_SERVICES, ttsKeyServices, ttsServiceOf } from '../llm/tts-presets.js';
import { resolveOfficialPrice, listOfficialPrices, listModelAliases, isPeakHour, priceAt, resolveModelPrice, costModeOf, modelLabel, splitModelLabel, vendorOfConfig, vendorOfBaseUrl, UNKNOWN_VENDOR } from '../pricing/model-prices.js';
import { initPriceFeed, priceFeedStatus } from '../pricing/price-feed.js';
import { initChannelPrices, channelPriceStatus, maybeAutoProbeChannel } from '../pricing/channel-prices.js';
import { currentProviders } from '../core/providers.js';
import { personaStateSnapshot } from '../core/persona-state.js';
import { resolvePersona } from '../personas.js';
import { scanModelsVision, visionResults } from '../llm/vision-scan.js';
import { builtinVisionResults } from '../llm/model-vision-docs.js';
import { createEventBus, todayKey, shanghaiDayStart, isSelfSender, safeSlice, sanitizeUserText, settleWithDeadline } from '../core/util.js';
import { chatAllowed } from '../core/access.js';
import { idList } from '../core/list.js';
import { isTimeActive } from '../core/time-gate.js';
import { timeControlState, TIME_ZONE } from '../core/time-control.js';
import { IdentityPilotManager, inactiveIdentityPilotStatus } from '../identity/identity-pilot.js';

import { AssetObserver } from './asset-observer.js';
import { inactiveSlangPilotStatus, SlangPilotManager } from '../pilots/slang-pilot.js';
import {
  IncidentPilotManager,
  inactiveIncidentPilotStatus,
  incidentDatabasePath
} from '../pilots/incident-pilot.js';
import { safeFetch } from '../llm/safe-fetch.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { fetchPluginIndexes, createIndexRevokedCache, indexResultForDisplay } from '../plugins/install.js';
import { DEFAULT_MIRROR_PREFIXES } from '../plugins/mirrors.js';
import { createIndexTextFetcher } from '../plugins/index-fetch.js';
import { readOwnerUin } from '../core/notify-owner.js';
// 平台能力门控的元数据（键→标签/工具/默认取向/配额默认）：控制台不手抄第二份，防漂移
import {
  PLATFORM_DEFAULT_OFF, PLATFORM_GATE_LABELS, PLATFORM_QUOTA_DEFAULTS, PLATFORM_TOOL_GATES,
  platformQuotaUsage
} from '../tools/tools-core.js';
import { integrationStatus, updateSnowLumaPassword } from './integrations.js';
import { createSnowlumaUpdater, baselineAlignDecision } from '../core/snowluma-update.js';
import { hostStats } from '../core/host-stats.js';
import { runHealthCheck } from '../core/health-check.js';
import { isContainerRuntime, containerUpdateHint } from '../core/runtime.js';
import { AutoUpdateManager } from '../auto-update.js';
import { acquireInstanceLock } from '../core/instance-lock.js';

// /healthz 用：只暴露名称、版本与运行状态，不含任何配置内容
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 初始化失败时退回默认连接超时，不阻塞服务启动。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', '..', 'ui');

// 前端构建戳：按 ui/ 关键文件的体积+修改时间算，**每次请求现算**（不缓存在模块常量里）。
// 用途：/api/status 带上它，前端轮询发现戳变了就提示"控制台已更新，点此刷新"
// —— 控制台是单页应用，部署不会自动替换已打开的页面，此前只能靠人记得按 F5。
//
// ⚠️ 为什么必须现算（2026-10-16）：控制台的 ui/ 是**每个请求现从磁盘读**的（见 handleHttp 的
// 静态分支），所以"只改前端"根本不需要重启进程 —— 而重启会掐断 OneBot 连接（实测每次约 3 秒，
// 今天一天 8 次部署就是 8 次断线）。戳若在开机时算死，"不重启发前端"这条路就不成立：已打开的
// 页面永远收不到刷新提示，用户会拿着旧 JS 对着新 CSS 跑。代价是 6 次 statSync / 次请求，只在
// /api/status 这条路上，可以忽略。

// ── UI 静态资源的版本令牌（改进方案 §11「给 core/* 加内容哈希长缓存」）──
// 令牌 = 文件内容的 sha256 前 12 位，按 (size, mtime) 记忆，避免每次请求重算哈希。
// 用途在 handleHttp：下发 index.html 时把**非 js** 的自家资源改写成 "?v=<令牌>"，
// 带对令牌的请求回 immutable 长缓存；令牌对不上或没带 → 退回回源校验。
// js 单独一套（不带令牌、no-cache + 内容哈希 ETag）：理由见 rewriteAssetUrls 的注释。
const ASSET_TOKEN_CACHE = new Map();
function assetToken(fullPath) {
  const stat = fs.statSync(fullPath);
  const stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  const hit = ASSET_TOKEN_CACHE.get(fullPath);
  if (hit && hit.stamp === stamp) return hit.token;
  const token = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex').slice(0, 12);
  ASSET_TOKEN_CACHE.set(fullPath, { stamp, token });
  return token;
}

// 把 HTML 里"自家静态资源"的引用改成带内容哈希的 URL。只动以 / 开头、且没有查询串的路径：
// 外链（http(s):// 或 //cdn）与已经带 ?v= 的原样保留；目标文件不存在也原样保留
// （让正常路径去报 404，别在改写阶段把它吃掉）。
//
// **js 不在内**（2026-10-01，ui/ 转 ES module 之后）：浏览器按 URL 认模块 ——
// index.html 里带 ?v= 的 /core/dom.js，与模块内相对 import（./dom.js）解析出的
// /core/dom.js（相对路径解析不受父 URL 查询串影响），是两个不同的 URL，会各自求值一次，
// 于是同一份 state 变成两份实例（页面看着正常、状态不共享，极难查）。
// 所以 js 一律不带版本令牌、走 no-cache + 内容哈希 ETag 回源校验（真 304 仍然生效）；
// css/svg/png 不是模块，继续用 ?v= 换 immutable 长缓存。
const URL_TOKENIZED = new Set(['.css', '.svg', '.png']);
function rewriteAssetUrls(html) {
  return html.replace(/(\s(?:src|href))="(\/[^"?#]+\.(?:css|svg|png))"/g, (whole, attr, urlPath) => {
    const target = path.join(UI_DIR, ...urlPath.slice(1).split('/'));
    const rel = path.relative(UI_DIR, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return whole;
    try {
      return `${attr}="${urlPath}?v=${assetToken(target)}"`;
    } catch {
      return whole;
    }
  });
}

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = idList(cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`]);
  if (denyList.includes(s)) return false;
  const allowList = idList(cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`]);
  if (allowList.length > 0) return allowList.includes(s);
  return cfg.allowAllWhenEmpty === true;
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// /api/login 的按源失败退避：控制台 token 是唯一凭据（绑定 0.0.0.0 时尤其是），
// 原来对猜测试毫无成本、比较还是普通 !==。连续失败 5 次后指数退避（30s 起、封顶 15 分钟），
// 成功即清零。map 超过 4096 个源时整体清空（极端情况下最坏回到无退避，但内存有界）。
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BACKOFF_BASE_MS = 30_000;
const LOGIN_BACKOFF_MAX_MS = 15 * 60_000;
// 失败计数要随时间衰减：否则管理员输错几次后，隔几天再错一次仍按旧的 2^n 退避，
// 反向代理/共享出口下还可能把整个出口长期锁死（2026-11-03 第五轮复审 A1）。
const LOGIN_FAILURE_DECAY_MS = 30 * 60_000;
// 全局失败软上限：per-IP 退避挡不住大子网/分布式轮换源（IPv6 下换 IP 近乎零成本），
// 与 IP 无关地记一个总量，异常量级（>1000 次/小时）打告警日志供运维侧发现（2026-10-06 复审 P3）。
const LOGIN_GLOBAL_FAIL_ALERT = 1000;
let loginGlobalFails = 0;
let loginGlobalWindowAt = 0;
let loginGlobalAlerted = false;
// 查询串令牌只留给这些路径（EventSource 发不了自定义头）；登录走 /api/login 的 body。
// 用集合而不是 `pathname === '…'` 字面量判定：console-routes-migrated 的防回退断言
// 禁止 if 链形态的路由判定，路径判定一律收口到这里（2026-10-06 复审 P3）。
const QUERY_TOKEN_PATHS = new Set(['/api/events']);

// ── 反代地址与客户端 IP（登录限流 / Cookie Secure）────────────────────────
// 只有 TCP 对端命中 server.trustedProxies 时才采信转发头。**绝不**用转发头做鉴权或
// loopback 判定（isLoopbackRemote 仍只看 socket），避免伪造 XFF 绕过本机限制。
function normalizeIp(raw) {
  let value = String(raw || '').trim();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone > 0) value = value.slice(0, zone);
  return value.toLowerCase();
}

function ipv4ToInt(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    n = (n * 256) + num;
  }
  return n;
}

function ipMatchesRule(ip, rule) {
  const target = normalizeIp(rule);
  if (!target) return false;
  if (!target.includes('/')) return ip === target;
  // 严格解析：空前缀（"10.0.0.0/"）不能被 Number('')=0 当成 /0（那会让所有 IPv4 变成可信代理）。
  const cidr = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(target);
  if (!cidr) return false;
  const bits = Number(cidr[5]);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(cidr.slice(1, 5).join('.'));
  if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isTrustedProxy(req) {
  const list = getConfig()?.server?.trustedProxies;
  if (!Array.isArray(list) || !list.length) return false;
  const peer = normalizeIp(req.socket?.remoteAddress);
  return Boolean(peer) && list.some((rule) => ipMatchesRule(peer, rule));
}

function forwardedClientIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((item) => normalizeIp(item)).filter(Boolean);
  // 只认 X-Forwarded-For：X-Real-IP 常被代理原样透传，客户端可直接伪造。
  // 代理未设置 XFF 时限流退化为按代理地址计数（安全侧的可用性降级，不是绕过）。
  if (!chain.length) return '';
  // 从右往左跳过可信反代，取第一个**非可信**地址：
  // - 单级 nginx（$proxy_add_x_forwarded_for 追加）：最右就是真实客户端；
  // - 多级代理（CDN → nginx）：最右是中间代理，必须按 trustedProxies 继续往左剥，
  //   否则所有访客共用一个限流桶；
  // - 客户端自带的伪造段在最左边，不会被选中。
  const rules = getConfig()?.server?.trustedProxies;
  const trusted = Array.isArray(rules) ? rules : [];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!trusted.some((rule) => ipMatchesRule(chain[i], rule))) return chain[i];
  }
  // 所有跳都落在 trustedProxies 里（把客户端网段也配进来的典型错误）：
  // 退回最右（反代追加的那一段），至少不采用最左的客户端可伪造值。
  return chain[chain.length - 1];
}

function clientIpForThrottle(req) {
  const peer = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  if (!isTrustedProxy(req)) return peer;
  return forwardedClientIp(req) || peer;
}

function requestIsSecure(req) {
  if (req.socket?.encrypted === true) return true;
  if (!isTrustedProxy(req)) return false;
  // 同样取最后一跳（可信反代追加的那一段）。
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',').map((v) => v.trim()).filter(Boolean);
  return String(proto[proto.length - 1] || '').toLowerCase() === 'https';
}

const loginThrottle = new Map();
function loginGate(req) {
  const key = clientIpForThrottle(req);
  // 原"超 4096 整体 clear()"会把还在生效期的锁定一起清掉（攻击者灌满 map 即解锁自己）。
  // 改为先逐出非锁定条目，仍超限再按最旧逐出 —— 最坏也只是个别旧锁提前释放，不会全军覆没。
  if (loginThrottle.size > 4096) {
    const now = Date.now();
    for (const [k, v] of loginThrottle) {
      if (v.blockedUntil <= now) loginThrottle.delete(k);
    }
    for (const k of loginThrottle.keys()) {
      if (loginThrottle.size <= 4096) break;
      loginThrottle.delete(k);
    }
  }
  const entry = loginThrottle.get(key);
  if (entry && entry.blockedUntil > Date.now()) {
    return { ok: false, retryAfterSec: Math.ceil((entry.blockedUntil - Date.now()) / 1000) };
  }
  return {
    ok: true,
    fail() {
      const now = Date.now();
      if (now - loginGlobalWindowAt > 3_600_000) {
        loginGlobalWindowAt = now;
        loginGlobalFails = 0;
        loginGlobalAlerted = false;
      }
      loginGlobalFails += 1;
      if (loginGlobalFails === LOGIN_GLOBAL_FAIL_ALERT && !loginGlobalAlerted) {
        loginGlobalAlerted = true;
        console.error(`[console] 登录失败已达 ${LOGIN_GLOBAL_FAIL_ALERT} 次/小时（与源 IP 无关的全局计数），疑似针对令牌的暴力猜测，请检查访问来源`);
      }
      const e = loginThrottle.get(key) || { failures: 0, blockedUntil: 0, lastFailureAt: 0 };
      if (e.lastFailureAt && now - e.lastFailureAt > LOGIN_FAILURE_DECAY_MS) {
        e.failures = 0;
        e.blockedUntil = 0;
      }
      e.failures += 1;
      e.lastFailureAt = now;
      if (e.failures >= LOGIN_MAX_FAILURES) {
        e.blockedUntil = Date.now() + Math.min(
          LOGIN_BACKOFF_BASE_MS * 2 ** (e.failures - LOGIN_MAX_FAILURES),
          LOGIN_BACKOFF_MAX_MS
        );
      }
      loginThrottle.set(key, e);
    },
    clear() { loginThrottle.delete(key); }
  };
}

/**
 * 设置页「模型价格」要的一整组数据。
 * GET /api/model-prices 与「立即拉取」共用同一个形状 —— 少一个字段，
 * 前端替换状态后就会当场显示错价（渠道价/别名/渠道价目表丢失）。
 */
function modelPricesPayload(modelOverride = null) {
  const cfg = getConfig();
  const model = String(modelOverride || cfg.api?.model || '');
  // currentDetail：完整的解析链路（渠道价 → 自定义价 → 账户口径 → 渠道价目表 →
  // 官方/远程表 → 兜底 → 未定价，以及走了别名还是近似）。界面据此解释"这个价是哪来的"。
  const vendor = vendorOfConfig(cfg) || '';
  return {
    prices: listOfficialPrices(),
    current: resolveOfficialPrice(model),
    currentVendor: vendor,
    currentDetail: { model, vendor, ...resolveModelPrice(model, cfg, null, { vendor }) },
    aliases: listModelAliases(),
    costMode: costModeOf(cfg),
    channelFeeds: channelPriceStatus(),   // 每渠道一份价目表的状态
    remote: priceFeedStatus()   // 远程价格表状态（设置页展示：来源/时间/条目数/错误）
  };
}

/**
 * 写进 console-access.txt 的"可点击地址"：监听地址是通配地址时给 127.0.0.1，
 * IPv6 字面量要加方括号（http://::1:3210 不是合法 URL）。
 */
function consoleUrlHost(host) {
  const value = String(host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::' || value === '::0') return '127.0.0.1';
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

// 默认日志走结构化 logger（scope=console）：QQ_AGENT_LOG_FORMAT=json 对控制台日志也生效；
// 测试/嵌入方传自己的 log 函数时保持原样。
const consoleLogger = createLogger('console');
const defaultConsoleLog = (...args) => consoleLogger.info(...args);

/**
 * 组合根。单实例锁在**构造存储之前**获取：旧实现放到 start()，第二个进程在被拒绝前
 * 已经打开 SQLite、做过迁移/清理、重写过会话索引（2026-10-31 复核 P1）。
 * 同进程可重入（测试会创建多个 app 对象），跨进程严格互斥。
 */
export function createApp(options = {}) {
  const lock = getConfig().server?.singleInstanceLock === false
    ? null
    : acquireInstanceLock(DATA_DIR, { log: options.log ?? defaultConsoleLog });
  try {
    return buildApp(options, lock);
  } catch (error) {
    lock?.release();
    throw error;
  }
}

function buildApp({
  log = defaultConsoleLog,
  autoUpdateOptions = {},
  asrInstaller = null,
  // 事件流的两个阈值只在测试里改（见 test/sse-stream.test.mjs）：默认值就是生产口径
  sseBacklogLimit = 1 << 20,
  sseHeartbeatMs = 20_000
} = {}, instanceLock = null) {
  const cfg = getConfig();
  // 过宽的可信代理网段等于让同网段任意主机自选限流键；启动时明确告警一次。
  for (const rule of Array.isArray(cfg.server?.trustedProxies) ? cfg.server.trustedProxies : []) {
    const bits = Number(String(rule).split('/')[1]);
    if (String(rule).includes('/') && (!Number.isFinite(bits) || bits <= 8)) {
      log(`[console] server.trustedProxies 含过宽网段 ${rule}：同网段主机可伪造 X-Forwarded-For，建议只填反代自身地址`);
    }
  }
  const bus = createEventBus();
  const sseClients = new Set();

  // ── 本机语音转写的安装（控制台里点一下就能装，不用 SSH）────────────────
  // 状态只留最近一次；日志留尾部若干行给界面显示。装完**在进程内重读配置**——
  // 配置只在启动时读一次（没有文件监听），不重读的话"装完了却还没生效"。
  const asrInstall = { running: false, startedAt: 0, finishedAt: 0, ok: false, phase: '', percent: null, log: [], error: '' };
  const ASR_LOG_MAX = 40;
  let asrChild = null;

  function asrInstallSnapshot() {
    return {
      running: asrInstall.running,
      installed: Boolean(findWhisperBinSync(getConfig())) && String(asrLocalModel(getConfig())) !== ''
        && (() => { try { return fs.existsSync(asrLocalModel(getConfig())); } catch { return false; } })(),
      managedExists: managedAsrExists(),
      phase: asrInstall.phase,
      percent: asrInstall.percent,
      ok: asrInstall.ok,
      error: asrInstall.error,
      startedAt: asrInstall.startedAt || null,
      finishedAt: asrInstall.finishedAt || null,
      log: asrInstall.log.slice(-ASR_LOG_MAX),
      resolved: { bin: asrLocalBin(getConfig()), model: asrLocalModel(getConfig()) }
    };
  }

  /** 托管目录（<数据目录>/asr）里还有没有东西 —— 决定界面给不给"删除"按钮。 */
  function managedAsrExists() {
    try { return fs.existsSync(path.resolve(DATA_DIR, 'asr')); } catch { return false; }
  }

  /**
   * 杀掉一棵进程树：安装脚本是 detached 起的，进程组里还有它 spawnSync 出来的 git/cmake/make。
   * 只杀包装进程会留下孤儿继续写构建目录（超时路径与 stop() 都要用它，别再各写一份）。
   */
  function killTreeOf(child) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* 平台不支持按组杀（如 Windows） */ }
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }

  /** 目录体积（只用于告诉用户释放了多少，算不出来就算了）。 */
  function dirSizeBytes(dir) {
    let total = 0;
    const walk = (target) => {
      let stat = null;
      try { stat = fs.lstatSync(target); } catch { return; }
      // 不跟软链接：rmSync 也只删链接本身；跟进去遇到环会 RangeError，
      // 而那一步跑在 rmSync 之前 —— 一次算错就变成"永远删不掉"（审查抓到）。
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        let names = [];
        try { names = fs.readdirSync(target); } catch { return; }
        for (const name of names) walk(path.join(target, name));
        return;
      }
      total += stat.size;
    };
    walk(dir);
    return total;
  }

  /**
   * 删除本机转写的文件：只动托管目录 <数据目录>/asr（安装脚本的落点）。
   * 配置里若指到别处（用户自己的 whisper.cpp 或模型），**不删**，只在结果里说明 ——
   * 那些文件不归这个功能管，删掉别人自己的东西是不可接受的。
   */
  function removeLocalAsrFiles() {
    // 必须 resolve：DATA_DIR 可能是相对路径（QQ_AGENT_DATA_DIR 允许相对），而配置里存的是绝对路径 ——
    // 不 resolve 就会"文件删了、却判成不在托管目录、配置没清"（审查抓到）。
    const managed = path.resolve(DATA_DIR, 'asr');
    // Windows/macOS 的文件系统大小写不敏感：同一个目录换个大小写写法还是它，比较前统一折叠
    const fold = (value) => (process.platform === 'win32' || process.platform === 'darwin'
      ? value.toLowerCase()
      : value);
    const inside = (target) => {
      try {
        const resolved = fold(path.resolve(target));
        const base = fold(managed);
        return resolved === base || resolved.startsWith(base + path.sep);
      } catch { return false; }
    };
    const cfgNow = getConfig();
    const bin = String(cfgNow.asr?.localBin || '').trim();
    const model = String(cfgNow.asr?.localModel || '').trim();
    const keptOutside = [bin, model].filter((item) => item && !inside(item));
    const freedBytes = dirSizeBytes(managed);
    fs.rmSync(managed, { recursive: true, force: true });
    // 指向托管目录的路径要清掉（不清就会留一条指向已删文件的配置）；
    // 指向别处的原样保留，由界面提示"未删除"。
    const patch = {};
    if (bin && inside(bin)) patch.localBin = '';
    if (model && inside(model)) patch.localModel = '';
    if (Object.keys(patch).length) {
      updateConfig({ asr: patch });
      emit('chat-update', '*');
    }
    return { managedDir: managed, freedBytes, keptOutside };
  }

  function startAsrInstall() {
    if (asrInstall.running) throw new Error('已经有一个安装在进行中，等它跑完再点');
    const script = asrInstaller || path.join(ROOT, 'scripts', 'install-asr-local.mjs');
    if (!fs.existsSync(script)) throw new Error(`找不到安装脚本：${script}`);
    Object.assign(asrInstall, { running: true, startedAt: Date.now(), finishedAt: 0, ok: false, phase: '启动中', percent: null, log: [], error: '' });

    // --no-write-config：写回由控制台自己做（能顺带刷新进程内配置），避免两边各写一次
    const child = spawn(process.execPath, [script, '--data-dir', DATA_DIR, '--no-write-config'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true
    });
    asrChild = child;
    // 进度行以回车刷新：拆行用的分隔集合在运行时构造，避免字面量转义被工具链改写
    const ASR_LINE_SEP = new RegExp('[' + String.fromCharCode(13, 10) + ']+');
    const pushLine = (line) => {
      const text = String(line || '').trim();
      if (!text) return;
      asrInstall.log.push(text);
      if (asrInstall.log.length > 200) asrInstall.log.shift();
      if (/拉取|构建|下载模型|源码已在|二进制已存在/.test(text)) asrInstall.phase = text.replace(/^[· ]+/, '').slice(0, 60);
      const pct = /([0-9]+(?:\.[0-9]+)?)%/.exec(text);
      if (pct) asrInstall.percent = Number(pct[1]);
    };
    const onData = (buf) => {
      // 进度行用回车刷新，先按回车/换行拆开再逐行记（分隔符运行时构造，避免字面量里的转义被工具链吞掉）
      for (const line of String(buf).split(ASR_LINE_SEP)) pushLine(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const finish = (ok, error) => {
      // 必须是"这一轮"的 child 才能改状态：被超时杀掉的包装进程，它 spawnSync 出来的
      // git/cmake 还活着并握着管道，旧 child 的 close 可能晚到很久（甚至等到下一轮已经开始），
      // 那时清 running 就会把新一轮的守卫抹掉 → 允许并发安装、界面误报失败（2026-09-26 审查）。
      if (child !== asrChild) return;
      if (!asrInstall.running) return;
      asrInstall.running = false;
      asrInstall.finishedAt = Date.now();
      asrInstall.ok = ok;
      asrInstall.error = ok ? '' : String(error || '安装失败，看上面的输出').slice(0, 500);
      asrInstall.phase = ok ? '完成' : '失败';
      asrChild = null;
      if (ok) {
        // 装完把解析出来的路径写进配置（同时刷新进程内配置，不用重启）
        try {
          updateConfig({ asr: { enabled: getConfig().asr?.enabled !== false, provider: 'local', localBin: asrLocalBin(getConfig()), localModel: asrLocalModel(getConfig()) } });
          emit('chat-update', '*');
        } catch (e) {
          // 写配置失败就**不能**报成功：界面会说"已生效"，而实际 available 仍是 false
          asrInstall.ok = false;
          asrInstall.phase = '失败';
          asrInstall.error = `安装成功但写配置失败：${String(e?.message ?? e)}`;
        }
      }
    };
    const killTree = () => killTreeOf(child);
    const timer = setTimeout(() => {
      killTree();
      pushLine('安装超时（30 分钟），已中止');
      finish(false, '安装超时');
    }, 30 * 60 * 1000);
    timer.unref?.();
    child.on('error', (e) => { clearTimeout(timer); finish(false, `启动安装脚本失败：${e.message}`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) finish(true);
      else finish(false, `安装脚本退出码 ${code}`);
    });
    return asrInstallSnapshot();
  }

  // SSE 背压与半开连接处理在 ./sse.js（含积压丢弃与写失败时关闭 socket）。
  const sseSend = createSseSender({ clients: sseClients, log, backlogLimit: sseBacklogLimit });
  const sseHeartbeat = setInterval(() => {
    // 遍历副本：sseSend 会顺手把坏客户端从集合里摘掉
    for (const res of [...sseClients]) sseSend(res, ': ping\n\n');
  }, sseHeartbeatMs);
  sseHeartbeat.unref?.();

  const emit = (type, payload) => {
    bus.emit(type, payload);
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          const view = buildSessionView(s, store);
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            // 人设标记要随 SSE 一起推：session-start 早于 systemPrompt 赋值，
            // 不带的话新会话的卡片要等下一次 HTTP 轮询（默认 4 秒）才补上。
            persona: view.persona || '',
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            triggerKind: s.triggerKind ?? '',
            triggerReason: s.triggerReason ?? s.contextReason ?? '',
            messages: s.messages ?? [],
            conversationMode: s.conversationMode ?? 'legacy',
            threadId: s.threadId ?? null,
            threadState: view.threadState ?? null,
            lifecycle: view.lifecycle,
            promptLayout: s.promptLayout ?? '',
            lifecycleContinuation: s.lifecycleContinuation === true,
            callUsage: s.callUsage ?? [],
            sessionMetrics: buildSessionMetrics(s),
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of [...sseClients]) sseSend(res, line);
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0, {
    synchronous: cfg.store?.sqliteSynchronous   // FULL（默认）/ NORMAL，Issue #45
  });   // 0 = 不限
  // 出站副作用账本：日报/提醒/游戏终局等"一次性动作"的幂等键与未知结果（docs/EFFECT-LEDGER.md）。
  // 与 store 同一个 sqlite 库，构造时会把上一条命留下的 planned 转成 unknown（不自动重试）。
  // 清扫放到 start() 成功监听之后（构造期清扫会误伤另一个正在运行的进程：
  // 第二个实例没抢到端口时，也会把第一个实例在途的 planned 标成 unknown）。
  const effects = new EffectLedger(store.db, { sweep: false });
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0, {
    persistIntervalMs: cfg.store?.sessionPersistMs,
    compressAfterDays: cfg.store?.sessionCompressAfterDays,
    maxTotalMb: cfg.store?.sessionMaxTotalMb
  });   // 0 = 不限
  let incidentPilot = null;
  let incidentPilotError = '';
  let autoUpdate = null;
  // 协议端（SnowLuma）更新器：控制台一键更新 + 可选的自动更新都用它。
  // compose 目录/容器名来自环境（QQ_AGENT_SNOWLUMA_DIR / QQ_AGENT_SNOWLUMA_CONTAINER），
  // 与 deploy-all.sh 落盘的布局一致；目录不存在时所有接口都如实返回"没装协议端"。
  const snowlumaDir = String(process.env.QQ_AGENT_SNOWLUMA_DIR || path.join(path.dirname(DATA_DIR), 'snowluma'));
  let snowlumaUpdater = createSnowlumaUpdater({
    composeDir: snowlumaDir,
    container: String(process.env.QQ_AGENT_SNOWLUMA_CONTAINER || 'qq-agent-snowluma'),
    webuiPort: Number(process.env.QQ_AGENT_WEBUI_PORT) || 5099,
    log: (line) => log(line)
  });
  const moduleLog = (source) => (...args) => {
    log(...args);
    // 只有调用方显式传了 Error 实例才进异常面板。此前对纯文本日志合成 Error 并记成
    // severity:'error' —— "已排程/报名/满员/跳过"这类信息性日志全部变成管理员告警，
    // 群日报/群游戏一开就是持续告警风暴（2026-10-07 复审 P2）。各模块记录真实异常时
    // 必须把 catch 到的 Error 传进来，别只拼 message。
    const supplied = args.find((value) => value instanceof Error);
    if (!supplied) return;
    incidentPilot?.capture(supplied, {
      source,
      category: 'module',
      severity: 'error'
    });
  };
  // 长期语义记忆是独立的实验模块：即使服务端未部署/未配置令牌，也只降级它自己，绝不影响聊天主链路。
  const livingMemory = new LivingMemoryRuntime({
    getConfig,
    dataDir: DATA_DIR,
    log: moduleLog('living-memory'),
    emit,
    // 提炼调用不在会话回合里，必须单独计入今日用量；否则这笔钱在控制台完全看不见。
    recordUsage: (response, model = '') => {
      try {
        const usage = emptyUsage();
        addUsage(usage, response?.usage);
        usage.calls = 1;
        const vendor = response?.originBaseUrl
          ? vendorOfBaseUrl(getConfig(), response.originBaseUrl) : '';
        sessions.recordExternalUsage(usage, { model: model || response?.model || '', vendor });
      } catch { /* 记账失败不影响主流程 */ }
    }
  });
  const onebot = new OneBotClient({
    wsUrl: cfg.onebot?.wsUrl,
    httpUrl: cfg.onebot?.httpUrl,
    accessToken: cfg.onebot?.accessToken,
    httpToken: cfg.onebot?.httpAccessToken || cfg.onebot?.accessToken,
    heartbeat: cfg.onebot?.wsHeartbeat,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => {
      incidentPilot?.capture(error, {
        source: 'onebot-ingress',
        category: 'ingress',
        severity: 'error',
        chatKey: event?.group_id
          ? `group:${event.group_id}`
          : event?.user_id
            ? `private:${event.user_id}`
            : '',
        details: {
          postType: event?.post_type || '',
          messageType: event?.message_type || '',
          noticeType: event?.notice_type || ''
        }
      });
      log('[ingest] 处理事件出错:', error?.message ?? error);
    })
  });
  const stickers = new StickerManager(onebot);
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`),
    onIncident: (error, context) => incidentPilot?.capture(error, context)
  });
  let identityPilot = null;
  let identityPilotError = '';
  // 定时提醒：落盘持久化（重启不丢），到点由编排器走主动唤醒让模型说出来
  const reminders = new ReminderStore();
  // 周期提醒的启动对账：错过多次只补最近一次（12h 窗内留作晚触发，超窗跳到下一期）
  {
    const touched = reminders.reconcileRecurring();
    if (touched.length) {
      log(`[reminder] 周期提醒启动对账：${touched.length} 条超窗未补，已跳到下一期`
        + `（${touched.slice(0, 3).map((t) => `${t.id}@${new Date(t.skippedFrom).toLocaleString('zh-CN')}`).join('、')}）`);
    }
  }
  // 索引结果的 10 分钟缓存（声明放在注册表之前：注册表要读它的「被撤回」清单）
  let pluginIndexCache = { key: '', at: 0, result: { plugins: [], skipped: [], sources: [] } };

  /**
   * 索引里被撤回的条目（`id@版本`）：注册表据此拒载 —— 集中下架，不用每台机器改配置。
   * 缓存语义（"拉取失败时沿用旧名单，失败不许清空"）在 createIndexRevokedCache 里，那里有用例钉着。
   */
  const indexRevokedCache = createIndexRevokedCache({ file: path.join(DATA_DIR, 'plugin-index-revoked.json') });
  // 上次成功读到的索引（失败时回落到它；见 indexResultForDisplay 的注释）
  let lastGoodPluginIndex = null;
  // 插件宿主是否已经起过。索引加载晚于 start（启动时那 5 秒竞速输了，但请求还在后台跑）
  // 时，拿到的新撤回名单要能触发一次重排 —— 否则被撤回的插件会一直跑到进程结束。
  let pluginsStarted = false;
  const indexRevokedRules = () => indexRevokedCache.rules();
  const pluginRegistry = new PluginRegistry({
    root: path.join(DATA_DIR, 'plugins'),   // 约定目录：数据目录不会被版本更新覆盖（见 docs/PLUGINS.md）
    dataDir: DATA_DIR,
    log: moduleLog('plugins'),
    getConfig,
    // 索引里标了 revoked 的插件一律拒载（索引改一次，所有机器下次读到就生效）
    getIndexRevoked: indexRevokedRules,
    // 插件声明 send 能力后，发言走机器人自己那条发送队列（禁言/限频/白名单/记账全在里面）
    getSender: () => sender,
    // 无令牌 + 无网络隔离时拒绝加载插件（loopback 免鉴权会被插件进程利用）
    getConsoleToken: () => String(getConfig().server?.token ?? '')
  });
  // OneBot 入站新鲜度告警：连接还在但 10 分钟没有任何事件/心跳（半开连接/上游卡死）——
  // 只在主进程里看着，一次发作只通知一次，恢复后复位。
  let freshnessTimer = null;
  {
    let staleNotified = false;
    freshnessTimer = setInterval(async () => {
      try {
        const last = Number(onebot.lastEventAt) || 0;
        if (!onebot.connected || !last) { staleNotified = false; return; }
        const staleMs = Date.now() - last;
        if (staleMs > 10 * 60_000 && !staleNotified) {
          staleNotified = true;
          const owner = readOwnerUin(getConfig());
          const text = `OneBot 连接显示在线，但已经 ${Math.round(staleMs / 60_000)} 分钟没有任何事件或心跳（可能是半开连接）。去服务器跑一次 src/ops.js health-check --confirm 看看。`;
          log(`[onebot-freshness] ${text}`);
          if (/^\d{5,15}$/.test(owner || '')) {
            await sender.sendTextBatch(`private:${owner}`, [text], {}).catch(() => {});
          }
        } else if (staleMs < 60_000) {
          staleNotified = false;
        }
      } catch { /* 告警自身失败不影响主流程 */ }
    }, 60_000);
    freshnessTimer.unref?.();
  }
  const mcpManager = new McpManager({ log: moduleLog('mcp') });
  if (getConfig().mcp?.enabled === true) {
    void mcpManager.start().catch((error) => moduleLog('mcp')('启动失败:', error));
  }
  // 管理员私聊能力：跨群发送/统一审批/只读状态。仅 owner 私聊可见，模型只能创建待确认动作。
  const adminServices = createAdminServices({
    dataDir: DATA_DIR, store, sender, onebot, effects, pluginRegistry,
    getIdentityPilot: () => identityPilot, getMcp: () => mcpManager, getConfig, log
  });
  // 生活层：宿主侧的觅食与候选队列。禁用时不建状态文件、不起定时器。
  const lifeFeed = new LifeFeedManager({
    dataDir: DATA_DIR,
    store,
    config: () => getConfig(),
    log: moduleLog('life-feed')
  });
  const orchestrator = new Orchestrator({
    store,
    memory,
    livingMemory,
    stickers,
    sender,
    sessions,
    onebot,
    reminders,
    effects,
    getGames: () => groupGame,
    getPlugins: () => pluginRegistry,
    getMcp: () => mcpManager,
    getLifeFeed: () => lifeFeed,
    emit,
    getIdentityPilot: () => identityPilot,
    getIncidentPilot: () => incidentPilot
  });
  const dailyMoments = new DailyMomentsManager({
    store,
    memory,
    stickers,
    onebot,
    sessions,
    resolveChatName: (groupId) => orchestrator.getChatName(groupId),
    getLifeFeed: () => lifeFeed,
    setProactiveSuppressed: (suppressed) =>
      orchestrator.setProactiveSuppressed('daily-moments', suppressed),
    emit,
    log: moduleLog('daily-moments')
  });
  const qzoneInteractions = new QzoneInteractionManager({
    onebot,
    sessions,
    setProactiveSuppressed: (suppressed) =>
      orchestrator.setProactiveSuppressed('qzone-interactions', suppressed),
    emit,
    log: moduleLog('qzone-interactions')
  });
  // 群游戏：状态机主持（实验性、默认关、白名单制）；私聊发词受 allowPrivateInvite 门控
  const groupGame = new GroupGameManager({
    store,
    sender,
    effects,
    log: moduleLog('group-game'),
    wake: (chatKey, delayMs, note, opts) => orchestrator.scheduleInitiativeWake(chatKey, delayMs, note, opts)
  });
  // 群日报：每天定时把"昨天群里聊了啥"汇总发到配置的群（默认关、白名单制）
  const groupDigest = new GroupDigestManager({
    store,
    sender,
    effects,
    sessions,
    log: moduleLog('group-digest')
  });
  // 管理员早报：每天把过去 24 小时群里的见闻私聊给全局管理员（默认关）
  const adminBriefing = new AdminBriefingManager({
    store,
    sender,
    sessions,
    log: moduleLog('admin-briefing')
  });
  function createIncidentPilot() {
    return new IncidentPilotManager({
      dataDir: DATA_DIR,
      config: getConfig,
      emit,
      log,
      notifyAvailable: () => onebot.connected === true,
      notify: async (incident, ownerUin) => {
        const userId = String(ownerUin || '').trim();
        if (!onebot.connected) {
          throw Object.assign(new Error('OneBot 未连接，告警等待发送'), {
            beforeWrite: true
          });
        }
        const severity = {
          critical: '严重',
          error: '错误',
          warning: '警告',
          info: '信息'
        }[incident.severity] || incident.severity;
        const text = [
          '【实验功能 · QQ Agent 异常】',
          `等级：${severity}`,
          `模块：${incident.source}`,
          ...(incident.chatKey ? [`会话：${incident.chatKey}`] : []),
          `结果：${incident.message}`,
          `次数：${incident.count}`,
          `编号：${incident.id}`,
          '',
          '处理入口：控制台 → 异常'
        ].join('\n');
        const data = await onebot.sendText('private', userId, text);
        store.appendSelf(`private:${userId}`, {
          mid: data?.message_id ?? null,
          ts: Date.now(),
          text
        });
        emit('chat-update', `private:${userId}`);
      }
    });
  }
  function incidentPilotStatus() {
    return incidentPilot?.status() || inactiveIncidentPilotStatus({
      enabled: incidentPilotEnabled(),
      error: incidentPilotError
    });
  }
  function syncIncidentPilot() {
    if (!incidentPilotEnabled()) {
      if (!incidentPilot && fs.existsSync(incidentDatabasePath(DATA_DIR))) {
        incidentPilot = createIncidentPilot();
        incidentPilot.openExisting();
      }
      return incidentPilotStatus();
    }
    incidentPilot ||= createIncidentPilot();
    try {
      const status = incidentPilot.start();
      incidentPilot.resumeNotifications();
      incidentPilotError = '';
      return status;
    } catch (error) {
      incidentPilotError = String(error?.message ?? error);
      throw error;
    }
  }
  function identityPilotStatus() {
    return identityPilot?.status() || inactiveIdentityPilotStatus({
      enabled: identityPilotEnabled(),
      error: identityPilotError
    });
  }

  /**
   * 四个台账的保留期清理入口，供 server.js 的每日调度调用（见 core/ledger-retention.js）。
   *
   * 为什么放在这里：identityStore 与 incidentPilot 是本模块的闭包变量，relationshipStore 只能经
   * identityPilot 原型上的 pruneRelationshipHistory 拿到，store 同理 —— 引用都只有 app 内部才有。
   * 各自按自己的配置读保留期（identity/relationship 走 pruneX() 的默认 90 天，incident 走
   * incidentPilot.retentionDays，runs 运行账本走 store.pruneRuns() 的默认 90 天），
   * 不在这里写死新默认值。
   * 返回的是**任务描述**而不是直接执行：真正的 try/catch 与日志由调度器逐项做，
   * 免得以后换了调度宿主还得把容错再抄一遍。
   *
   * ⚠️ 运行台账（runs）是 2026-10-09 审查补进来的：它原来只在 ChatStore 构造时清一次，
   * 连跑数月不重启 = 永不清理 —— 与另外三本台账当初踩的是同一个坑。
   * 会话留档（sessions）是 2026-10-10 审查补进来的：默认 keepFiles=0 时它连构造时的
   * 清理都没有，磁盘与内存 index 双向无界增长（pruneSessions 默认 90 天，与 runs 同口径）。
   */
  function retentionPruneTargets() {
    return [
      { name: '身份台账', run: () => identityPilot?.identityStore?.pruneLedgers() },
      { name: '关系台账', run: () => identityPilot?.pruneRelationshipHistory?.() },
      { name: '异常台账', run: () => incidentPilot?.pruneResolvedIncidents() },
      { name: '运行台账', run: () => store.pruneRuns() },
      { name: '发送台账', run: () => store.pruneOutbox() },
      { name: '会话留档', run: () => sessions.pruneSessions() },
      // 压缩放在清理之后：先按保留期/预算删掉该删的，剩下的旧留档再压成 .gz。
      // 每次最多压 100 个，避免每日任务占满事件循环；没压完的下一轮继续。
      { name: '留档压缩', run: () => sessions.compressSessions() },
      // WAL 截断/查询计划统计放在删除之后：先腾行，再回收文件，最后刷新统计。
      { name: 'SQLite 维护', run: () => { store.maintain(); identityPilot?.identityStore?.maintain?.(); } },
      { name: '副作用账本', run: () => effects.prune() },
      { name: '人物记忆', run: () => memory.maybePrune(Date.now()) }
    ];
  }
  async function sendIdentityAdminText(ownerUin, text, signal) {
    const userId = String(ownerUin || '').trim();
    if (!/^\d{5,15}$/.test(userId)) throw new Error('管理员 QQ 配置无效');
    const data = await onebot.sendText('private', userId, text, { signal });
    store.appendSelf(`private:${userId}`, {
      mid: data?.message_id ?? null,
      ts: Date.now(),
      text
    });
    emit('chat-update', `private:${userId}`);
    return data;
  }
  autoUpdate = new AutoUpdateManager({
    appDir: autoUpdateOptions.appDir || ROOT,
    dataDir: DATA_DIR,
    config: getConfig,
    updateConfig,
    emit,
    log,
    notifyAvailable: () => onebot.connected === true,
    // 与异常告警同口径：连协议端都没连上 = **确定没发出去**（带 beforeWrite，保留 pending 等重连后重发）；
    // 已经在发送中失败的（超时/业务拒绝）属于"结果未知"，只记 deliveryUnknown、不自动重发
    // —— 否则 pending 会一直留着，30 秒一次的定时器把同一条失败通知反复发给管理员。
    notify: async (text, ownerUin) => {
      if (!onebot.connected) {
        throw Object.assign(new Error('OneBot 未连接，更新失败通知等待发送'), { beforeWrite: true });
      }
      return sendIdentityAdminText(ownerUin, text);
    },
    ...(autoUpdateOptions.runSystemctl
      ? { runSystemctl: autoUpdateOptions.runSystemctl }
      : {})
  });
  async function syncIdentityPilot({ reindex = false, reconfigure = false } = {}) {
    if (!identityPilotEnabled()) {
      identityPilot?.stop();
      identityPilot = null;
      identityPilotError = '';
      return identityPilotStatus();
    }
    identityPilot ||= new IdentityPilotManager({
      store,
      onebot,
      sessions,
      emit,
      log: moduleLog('identity-pilot'),
      notifyFriendProposal: async (proposal, ownerUin, signal) => {
        const reasonLabels = {
          interest: '对这个人感兴趣',
          frequent: '聊得比较频繁',
          banter: '想继续互怼'
        };
        const verification = proposal.verificationMessage
          ? `\n验证消息：${proposal.verificationMessage}`
          : '';
        signal?.throwIfAborted();
        await sendIdentityAdminText(
          ownerUin,
          [
            '【实验功能 · 主动好友候选】',
            `对象：${proposal.primaryName || '未命名'}（${proposal.userId}）`,
            `来源：${proposal.sourceChatKey}`,
            `原因：${reasonLabels[proposal.reasonCode] || proposal.reasonCode}；${proposal.reason}`,
            `编号：${proposal.id}${verification}`,
            '',
            `回复“同意好友 ${proposal.id}”或“拒绝好友 ${proposal.id}”，也可以在控制台“设置 → 实验功能”审批。`,
            getConfig().identityPilot?.friendProposal?.activeDispatchEnabled === true
              ? '说明：批准后会通过 SnowLuma 实验协议发送申请；仅明确成功才标记已提交，结果未知时不会自动重试。'
              : '说明：主动发送实验开关未开启；批准后会进入待手动执行状态，不会伪报已发送。'
          ].join('\n'),
          signal
        );
      },
      notifyIncomingFriendRequest: async (request, ownerUin, signal) => {
        signal?.throwIfAborted();
        await sendIdentityAdminText(
          ownerUin,
          [
            '【实验功能 · 收到好友请求】',
            `申请人：${request.primaryName || '未命名'}（${request.userId}）`,
            `验证消息：${request.comment || '（无）'}`,
            `编号：${request.id}`,
            '',
            `回复“同意好友申请 ${request.id}”或“拒绝好友申请 ${request.id}”，也可以在控制台“设置 → 实验功能”审批。`,
            '同意后会调用 OneBot 接受请求，并自动加入私聊白名单；结果未知时不会自动重试。'
          ].join('\n'),
          signal
        );
      },
      allowPrivateUser: async (userId, { clearDeny = true } = {}) => {
        const current = getConfig();
        const id = String(userId || '').trim();
        if (!/^\d{1,15}$/.test(id)) throw new Error('好友 QQ 号无效');
        const privateAllow = [...new Set([
          ...idList(current.allow?.private),
          id
        ])];
        const patch = { allow: { ...(current.allow || {}), private: privateAllow } };
        // 自动同步"已知好友"只补 allow，绝不能把管理员手写的 deny.private 删掉；
        // 只有管理员当场批准好友申请的路径才允许清 deny。
        if (clearDeny) {
          patch.deny = {
            ...(current.deny || {}),
            private: idList(current.deny?.private).filter((item) => item !== id)
          };
        }
        updateConfig(patch);
        emit('status', { configUpdated: true, friendWhitelisted: id });
      }
    });
    try {
      if (reconfigure && identityPilot.active) identityPilot.reconfigure();
      const status = reindex && identityPilot.active
        ? await identityPilot.reindex()
        : await identityPilot.start();
      identityPilotError = '';
      emit('identity-pilot-update', status);
      return status;
    } catch (error) {
      identityPilotError = String(error?.message ?? error);
      identityPilot?.stop();
      identityPilot = null;
      throw error;
    }
  }
  const assetObserver = new AssetObserver({
    stickers,
    memory,
    getIdentityPilot: () => identityPilot,
    getIdentityStatus: identityPilotStatus
  });
  let slangPilot = null;
  let slangPilotError = '';
  function slangPilotStatus() {
    return slangPilot?.status() || inactiveSlangPilotStatus({
      enabled: slangPilotEnabled(),
      error: slangPilotError
    });
  }
  async function syncSlangPilot() {
    if (!slangPilotEnabled()) {
      await slangPilot?.stop();
      slangPilot = null;
      slangPilotError = '';
      return slangPilotStatus();
    }
    slangPilot ||= new SlangPilotManager({
      assetObserver,
      chatStore: store,
      sessions,
      emit,
      log: moduleLog('slang-pilot'),
      notify: async (stage, discovery, ownerUin) => {
        const research = discovery.research || {};
        const lines = stage === 'pending-admission'
          ? [
              '【实验功能 · 黑话研究完成】',
              `词条：${discovery.displayTerm}`,
              `含义：${research.meaning || '不确定'}`,
              `范围：${research.recommendedScope === 'global-safe' ? '可全局使用' : '仅来源群'}`,
              `置信度：${Math.round((Number(research.confidence) || 0) * 100)}%`,
              `编号：${discovery.id}`,
              '',
              `回复“收录黑话 ${discovery.id}”或“拒绝收录 ${discovery.id}”。`
            ]
          : [
              '【实验功能 · 黑话研究候选】',
              `词条：${discovery.displayTerm}`,
              `来源：${discovery.scopeChatKey}`,
              `出现：${discovery.occurrenceCount} 次 / ${discovery.speakerCount} 人`,
              `编号：${discovery.id}`,
              '',
              `回复“研究黑话 ${discovery.id}”或“拒绝研究 ${discovery.id}”。`
            ];
        await sendIdentityAdminText(ownerUin, lines.join('\n'));
      }
    });
    try {
      const status = slangPilot.start();
      slangPilotError = '';
      emit('slang-pilot-update', status);
      return status;
    } catch (error) {
      slangPilotError = String(error?.message ?? error);
      await slangPilot?.stop();
      slangPilot = null;
      throw error;
    }
  }
  async function refreshIdentityAfterAssetMutation() {
    if (!identityPilot?.active) return;
    try {
      await identityPilot.reindex();
      emit('identity-pilot-update', identityPilot.status());
    } catch (error) {
      log(`[assets] 统一身份索引刷新失败：${String(error?.message ?? error)}`);
    }
  }
  let timeControlTimer = null;
  let snowlumaAutoTimer = null;
  let snowlumaAutoStopped = false;   // stop() 后不再重挂周期定时器（2026-10-09 审查）
  // 协议端自动更新：默认关（config.autoUpdate.snowluma.enabled）。打开后每 6 小时比一次镜像，
  // 落后于项目基线就自动更新 —— 更新只改 .env + compose pull/up，数据卷不动（登录态保留），
  // 失败会自动回滚到旧镜像。boot 后延迟 2 分钟再首检（别跟启动抢 IO）。
  const SNOWLUMA_AUTO_INTERVAL_MS = 6 * 3600_000;

  // 「随 Agent 版本对齐协议端」（2026-10-09，默认开）：协议端基线是**代码里的常量**，只随
  // Agent 新版本到达用户机器 —— 所以"更新 Agent 后主服务带新代码重启"是用户看到新基线的
  // 唯一时刻。在这一刻做一次对齐（复用 updater 全套：改 .env → pull → up → 等就绪 → 失败
  // 自动回滚），就实现了"我们发版动了协议端基线 → 用户更新 Agent 时顺带对齐；没动 → 什么都
  // 不动"。尊重两条既有语义：自定义镜像（autoUpdate.snowluma.image）永远优先；显式关掉
  // followBaseline 就不再自动动。失败只记日志 —— 绝不影响 Agent 更新自身的结果
  //（deploy.sh 早已完成、主服务已在跑新版本）。
  async function snowlumaBaselineAlign() {
    try {
      const cfgNow = getConfig();
      const override = String(cfgNow.autoUpdate?.snowluma?.image || '');
      const st = await snowlumaUpdater.status();
      const decision = baselineAlignDecision({
        installed: st.installed,
        outdated: st.outdated,
        override,
        followBaseline: cfgNow.autoUpdate?.snowluma?.followBaseline !== false,
        busy: st.busy
      });
      if (decision !== 'align') {
        // 常规态（已是最新/没装协议端）不刷日志；配置性或临时性跳过留一行便于排查
        if (decision !== 'skip:up-to-date' && decision !== 'skip:not-installed') {
          log(`[snowluma] 随版本对齐跳过（${decision}）`);
        }
        return;
      }
      log(`[snowluma] Agent 新版本带来的协议端基线变化：${st.currentVersion || st.currentImage} → ${st.targetVersion || st.targetImage}，开始对齐`);
      const res = await snowlumaUpdater.update({ to: override });
      if (res.ok) log(`[snowluma] 随版本对齐完成：${res.to}（等待就绪 ${Math.round((res.waitedMs || 0) / 1000)}s）`);
      else log(`[snowluma] 随版本对齐失败：${res.error}${res.rolledBack ? '（已自动回滚到旧镜像）' : ''}`);
    } catch (error) {
      log(`[snowluma] 随版本对齐异常：${error?.message ?? error}`);
    }
  }

  async function snowlumaAutoCheck({ first = false } = {}) {
    // 容器里没有宿主 docker 套接字，协议端由 compose 管：更新只能换镜像，不能在这里 exec。
    // 直接返回，连基线对齐也不做（那同样要重建协议端容器）。
    if (isContainerRuntime()) return;
    try {
      // 启动时先做一次"随版本对齐"（默认开，只在基线真的变化时动手）；它与下面的周期检查
      // 相互独立：周期检查的开关（默认关）不受影响。
      if (first) await snowlumaBaselineAlign();
      const cfgNow = getConfig();
      if (cfgNow.autoUpdate?.snowluma?.enabled !== true) return;
      const st = await snowlumaUpdater.status();
      if (!st.installed || !st.outdated || st.busy) return;
      log(`[snowluma] 自动更新协议端：${st.currentVersion || st.currentImage} → ${st.targetVersion || st.targetImage}`);
      const res = await snowlumaUpdater.update({ to: String(cfgNow.autoUpdate?.snowluma?.image || '') });
      if (res.ok) log(`[snowluma] 自动更新完成：${res.to}（等待就绪 ${Math.round((res.waitedMs || 0) / 1000)}s）`);
      else log(`[snowluma] 自动更新失败：${res.error}${res.rolledBack ? '（已自动回滚）' : ''}`);
    } catch (error) {
      log(`[snowluma] 自动更新异常：${error?.message ?? error}`);
    } finally {
      clearTimeout(snowlumaAutoTimer);
      // stop() 之后不再重挂（否则同进程重启/嵌入式用法会留下一个活定时器，6 小时后
      // 在已停止的应用里再发起一次协议端更新）；重挂的定时器同样 unref（2026-10-09 审查）。
      if (!snowlumaAutoStopped) {
        snowlumaAutoTimer = setTimeout(() => { snowlumaAutoCheck(); }, SNOWLUMA_AUTO_INTERVAL_MS);
        snowlumaAutoTimer.unref?.();
      }
    }
  }

  function refreshTimeControl() {
    clearTimeout(timeControlTimer);
    if (getConfig().timeControl?.enabled !== true) {
      slangPilot?.resumeQueued();
      return;
    }
    orchestrator.enforceTimeControl();
    slangPilot?.resumeQueued();
    const now = Date.now();
    const keys = ['', ...store.listChats()];
    const changes = keys.map((key) =>
      timeControlState(getConfig().timeControl, key, now).nextChangeAt
    ).filter((at) => at > now);
    const delay = Math.min(60000, ...changes.map((at) => at - now));
    timeControlTimer = setTimeout(refreshTimeControl, Math.max(1, delay));
    timeControlTimer.unref?.();
  }
  const releaseTimeControl = onTimeControlChange(refreshTimeControl);

  // 远程价格表：启动即初始化（内部幂等；URL 为空则完全不动）
  initPriceFeed(cfg.api?.priceRemoteUrl || '');

  // 每渠道一份价目表：先吃磁盘缓存，缓存缺失/过旧的按需后台刷新（同样幂等、不阻塞启动）
  initChannelPrices(cfg.api?.channelPriceFeeds || []);
  // 零配置路径：填了渠道地址但没配过价目表时，后台自己探一次（成功自动采用，失败静默）
  // 测试集用 QQ_AGENT_SKIP_NETWORK_PROBES=1 关掉这类"顺手探测"：几百个测试文件并行时
  // 每个 createApp 都去打默认渠道地址，会拖慢/拖住无外网的 CI 与部署机。
  if (process.env.QQ_AGENT_SKIP_NETWORK_PROBES !== '1') {
    maybeAutoProbeChannel({
      baseUrl: cfg.api?.baseUrl || '',
      vendor: vendorOfConfig(cfg) || '',
      feedsConfig: cfg.api?.channelPriceFeeds || [],
      options: { getConfig, updateConfig }
    }).catch(() => { /* 内部已吞，这里是第二道保险 */ });
  }

  // OneBot 连接状态推送
  onebot.onStatus((status) => {
    emit('onebot-status', status);
    if (status.connected) incidentPilot?.resumeNotifications();
    if (status.connected) autoUpdate?.resumeNotifications();
    // 连上（含重连）就补一次：把重启/断线期间漏掉的消息捞回来
    if (status.connected) scheduleCatchUp();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(chatKey, messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      // OneBot 的 message_id 是全局的：引用的可能是别的群/私聊消息。入站富化只能把
      // 当前会话里的引用原文带进历史，否则跨会话内容会被复制到本群并送进模型。
      const [kind, chatId] = String(chatKey).split(':');
      if (kind === 'group') {
        if (msg?.group_id == null || String(msg.group_id) !== String(chatId)) return null;
      } else if (kind === 'private') {
        // 私聊里不能接受群消息（适配器可能不带 message_type，但带 group_id）。
        if (msg?.group_id != null || msg?.message_type === 'group') return null;
        if (msg?.message_type && String(msg.message_type) !== 'private') return null;
        if (msg?.user_id != null && String(msg.user_id) !== String(chatId)) return null;
      }
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      const senderId = String(msg?.sender?.user_id ?? msg?.user_id ?? '');
      let text = '';
      if (Array.isArray(msg?.message)) {
        // 引用富化与正文同口径（Issue #99）：[图片] 才能命中提示词的看图触发词；includeReply:false 防递归。
        text = await segmentsToText(msg.message, { includeReply: false, selfId: String(onebot.selfId || '') });
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      return {
        messageId: String(messageId),
        sender: String(senderName),
        senderId,
        // 引用的是不是自己的消息：引用块里要标"我"（与历史行口径一致），
        // 否则模型会把机器人自己的名片名当成别人（Issue #16：引用了自己的一条，答成"你发的啊"）。
        self: isSelfSender(senderId, onebot.selfId),
        text: safeSlice(String(text), 120)
      };
    } catch {
      return null;
    }
  }

  // 入站富化任务：串行执行同会话的富化（保持引用/转发的处理顺序），但不阻塞事件入口。
  const deferredIngestChains = new Map();
  const deferredIngestTasks = new Set();
  let ingestAbort = new AbortController();
  let ingestStopping = false;

  function enqueueDeferredIngest(chatKey, job) {
    const previous = deferredIngestChains.get(chatKey) || Promise.resolve();
    const task = previous.then(() => job.run()).catch(async (error) => {
      log('[ingest] 延迟富化失败：', error?.message ?? error);
      try {
        await job.fallback();
      } catch (fallbackError) {
        log('[ingest] 延迟富化兜底失败：', fallbackError?.message ?? fallbackError);
      }
    });
    deferredIngestChains.set(chatKey, task);
    deferredIngestTasks.add(task);
    const cleanup = () => {
      deferredIngestTasks.delete(task);
      if (deferredIngestChains.get(chatKey) === task) deferredIngestChains.delete(chatKey);
    };
    task.then(cleanup, cleanup);
  }

  async function resolveReplyWithLocal(chatKey, mid, budget, cfgNow) {
    const remote = await budget.run(resolveReply(chatKey, mid), null);
    if (remote) return remote;
    const local = store.findByMid(chatKey, mid);
    if (!local) return null;
    return {
      messageId: String(mid),
      sender: local.self ? (onebot.selfNickname || cfgNow.persona?.botName || '我') : local.senderName,
      senderId: local.self ? String(onebot.selfId || '') : String(local.senderId || ''),
      self: Boolean(local.self),
      text: safeSlice(String(local.text || ''), 120)
    };
  }

  /**
   * 富化一条入站消息：解析引用、@昵称、合并转发。
   * 所有网络操作都走同一个 budget；到点返回 null/占位符，调用方照常落库与唤醒。
   * 黑名单不在里面做：调用方拿到最终正文后再判，避免把未展开的内容喂给模型。
   */
  async function enrichIncomingMessage({
    chatKey, kind, id, segments, replySegment, looksForward, autoExpand, forwardResId, event, media, budget, cfgNow
  }) {
    const replyCache = new Map();
    const getReply = (mid) => {
      const key = String(mid);
      if (!replyCache.has(key)) {
        replyCache.set(key, resolveReplyWithLocal(chatKey, key, budget, cfgNow));
      }
      return replyCache.get(key);
    };
    let text = await segmentsToText(segments, {
      selfId: String(onebot.selfId || ''),
      resolveReply: getReply,
      resolveAtName: (qq) => (kind === 'group' ? budget.run(resolveAtName(id, qq), null) : null)
    });
    let reply = replySegment ? await getReply(replySegment.data.id) : null;
    let nextMedia = media;
    if (segments && looksForward && event.message_id != null && autoExpand) {
      const isCard = !text.includes('[合并转发') && !text.includes('[转发消息');
      if (budget.expired) {
        log(`[ingest] ${chatKey} 合并转发富化预算用尽，保留占位符`);
      } else {
        const work = (async () => {
          try {
            const nodes = await readForwardMessages(onebot, event.message_id, segments);
            const ex = await expandForwardNodes(nodes, {
              fetchNested: (rid) => readForwardNodesById(onebot, rid)
            });
            return { nodes, ex };
          } catch (error) {
            return { error };
          }
        })();
        const result = await budget.run(work, { timeout: true });
        if (result?.ex?.text) {
          text = result.ex.text;
          if (result.ex.media?.length) nextMedia = [...media, ...result.ex.media];
          // 诊断（每张卡片一行，低噪音）：卡片能不能读，靠这行下结论
          if (isCard) log(`[ingest] 聊天记录卡片：resid ${forwardResId ? '有' : '无'}，取回 ${result.nodes?.length ?? 0} 条`);
        } else if (result?.error) {
          if (isCard) log(`[ingest] 聊天记录卡片展开失败（resid ${forwardResId ? '有' : '无'}）: ${result.error?.message ?? result.error}`);
          else log(`[ingest] 展开合并转发失败（保留占位符）: ${result.error?.message ?? result.error}`);
        } else {
          log(`[ingest] ${chatKey} 合并转发展开超时（保留占位符，可用 read_forward 重试）`);
        }
      }
    }
    return { text: text || '', reply, media: nextMedia };
  }

  /**
   * 消息落库后的统一收尾。非延迟路径直接调用；延迟路径在富化完成、状态放行前调用。
   * finalize 只在延迟路径传入：命令拦截时也放行（保持原有"不叫醒模型"语义）。
   */
  async function dispatchStoredIncoming(options) {
    const { chatKey, kind, id, stored, isSelf, backlog = false } = options;
    const finalize = options.finalize || null;
    emit('chat-update', chatKey);
    const ackHandled = async () => {
      if (finalize) {
        await options.finalize('handled');
        return;
      }
      // 非延迟路径已经是 pending：命令被消费后必须 ack，否则恢复循环 5 秒内仍会叫醒模型
      // 让它看到"同意好友申请 fp_xxx"这类命令正文（deferred 路径由 finalize 负责）。
      try { store.markRead(chatKey, [stored.id]); } catch (error) {
        log(`[ingest] 管理员命令消息标记已读失败：${error?.message ?? error}`);
      }
    };
    if (!isSelf && kind === 'group' && (getConfig().blocklist?.[id] || []).map(String).includes(String(stored.senderId))) { await ackHandled(); return; }
    // 群游戏的私聊行动（狼人杀这类"夜里私聊提交"的游戏）：属于进行中的局就由引擎在入口
    // 接管（发回执/发查验结果），并就地标记已读 —— 不再唤醒模型，也不给插件观察者看。
    // 解析不了的消息返回 false，照常走下面的普通链路落到模型手里兜底。
    if (!isSelf && kind === 'private' && groupGame?.consumePrivateAction
      && await groupGame.consumePrivateAction(chatKey, stored)) {
      await ackHandled();
      return;
    }
    if (!isSelf) identityPilot?.observeMessage(chatKey, stored);
    if (!isSelf) slangPilot?.observeMessage(chatKey, stored);
    // 插件只读观察：只给已去重、已过 sanitizeUserText 的正文与最小元信息，不给 media；
    // 插件改不了内容、也拦不住消息（没有回执通道）。不投自己发的消息，避免自问自答环。
    if (!isSelf) {
      pluginRegistry.observe({
        chatKey, group: kind === 'group',
        mid: stored.mid, ts: stored.ts,
        senderId: stored.senderId, senderName: stored.senderName,
        text: stored.text
      });
    }
    if (!isSelf) {
      Promise.resolve(stickers.autoCollect?.(chatKey, stored)).catch((error) =>
        log('[sticker] 自动收藏失败:', error?.message ?? error));
    }
    if (
      !isSelf
      && (
        await handleFriendProposalAdminCommand(kind, id, stored.text)
        || await handleSlangPilotAdminCommand(kind, id, stored.text)
      )
    ) {
      await ackHandled();
      return;
    }
    // 被动采集放在命令/游戏私聊消费之后：管理员批准命令、狼人杀夜间行动这类
    // "就地消费、不叫醒模型"的消息不该进长期记忆（backlog 补课历史同样跳过）。
    if (!isSelf && !backlog) livingMemory.captureIncoming?.({ chatKey, message: stored });
    if (finalize) {
      const released = await options.finalize('wake');
      if (released !== 'pending') return;   // 'acked' = 只存档，不触发 wake
    }
    if (!isSelf) orchestrator.onIncoming(chatKey, stored);
  }

  async function ingestMessage(kind, id, event, arrivedInactive = false, backlog = false) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录
    const chatKey = `${kind}:${id}`;

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');
    const isSelf = senderId === onebot.selfId;

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    if (kind === 'group' && senderId && (cfgNow.blocklist?.[id] || []).map(String).includes(senderId)) return;
    const media = segments ? extractMediaFromSegments(segments) : [];
    const mentionsSelf = Boolean(segments?.some((segment) =>
      segment?.type === 'at'
      && String(segment?.data?.qq ?? '') === String(onebot.selfId || '')));

    const replySegment = segments?.find((segment) => segment?.type === 'reply' && segment?.data?.id != null) || null;
    let text;
    if (segments) {
      // 先用不解析引用/@昵称的正文落库：弱网下这一步不做任何网络请求（Issue #85）。
      // 引用块和 @ 的最终渲染由后台富化补上，超时就保留占位符。
      text = await segmentsToText(segments, { selfId: String(onebot.selfId || '') });
    } else {
      // 协议端以字符串 / CQ 码上报时（message_format=string）正文也要清洗：
      // 否则这种部署形态下群友文本可以原样伪造段标记
      text = sanitizeUserText(String(event.raw_message ?? event.message ?? '').trim());
    }

    if (!isSelf && matchesBlacklistKeyword(text, cfgNow.store?.blacklistKeywords)) {
      log(`[ingest] ${chatKey} 命中消息关键词黑名单，已丢弃`);
      return;
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 优先使用当前转发卡片的资源 id，兼容仅支持 message_id 的旧适配器。
    // 媒体里的 url 此时是新鲜的，一并收进 media（取图/金句都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    // 卡片（json 段里的 multimsg）也走同一条路：先从卡片里取资源 id，取不到就只剩摘要
    //（那是协议端给不给的问题，不是深度问题）。
    const forwardResId = Array.isArray(segments) ? segments.map(forwardResIdFromSegment).find(Boolean) : null;
    const looksForward = Boolean(forwardResId)
      || text.includes('[合并转发') || text.includes('[转发消息') || text.includes('[卡片聊天记录');
    // 「消息类型」页可以关掉自动展开（一条 20 条的记录展开后是几千字符，还要跟着进存档与
    // 后续每一轮的上下文）。**被 @ 的那条仍然展开** —— 用户点名要看的东西不该再多花一轮
    // 工具调用；关掉后正文留占位符，模型需要时自己调 read_forward。
    const autoExpand = cfgNow.messageTypes?.expandForward !== false || mentionsSelf;
    if (!isSelf && segments && looksForward && event.message_id != null && !autoExpand) {
      log('[ingest] 合并转发未自动展开（「消息类型」页关着）：占位符已存档，需要时模型可调 read_forward');
    }
    const hasAtName = Boolean(segments?.some((segment) =>
      segment?.type === 'at' && String(segment?.data?.qq ?? '') !== 'all'));
    const needsEnrichment = Boolean(
      segments
      && (replySegment || hasAtName || (looksForward && event.message_id != null && autoExpand))
    );
    const enrichTimeoutMs = Math.max(200, Math.min(15000,
      Number(cfgNow.messageTypes?.enrichTimeoutMs) || 5000));

    // 自己的回显没有唤醒需求；富化仍按原有语义同步做完（有预算），避免正文退化成占位符。
    let initialReply = null;
    if (isSelf && needsEnrichment) {
      const budget = createTimeBudget(enrichTimeoutMs, { signal: ingestAbort.signal });
      const enriched = await enrichIncomingMessage({
        chatKey, kind, id, segments, replySegment, looksForward, autoExpand, forwardResId,
        event, media, budget, cfgNow
      });
      text = enriched.text || text;
      initialReply = enriched.reply;
    }

    if (!text && !media.length) return;
    const recordOnly = arrivedInactive || !isTimeActive(chatKey);
    const message = {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      // 表情包（QQ 标记为动画表情/表情的图）与普通图片分开标注，让模型和存档一眼能分辨
      text: text || (media.some((m) => m.kind === 'image' && /表情/.test(String(m.summary || '')))
        ? '[表情包]' : '[图片]'),
      reply: initialReply,
      media,
      mentionsSelf,
      // 引擎发的游戏私聊（身份/查验结果/行动回执）标成 game-secret：提示词构建时会过滤掉，
      // 模型在私聊里不该是上帝视角（2026-09-29 审查 P2）
      eventKind: isSelf && groupGame?.isSecretSelfMessage?.(chatKey, event.message_id) ? 'game-secret' : 'message'
    };
    const deferred = !isSelf && needsEnrichment;
    const stored = isSelf ? store.appendSelf(chatKey, message) : store.appendIncoming(chatKey, message, {
      recordOnly,
      deferred
    });
    if (stored.duplicate) return;
    emit('chat-update', chatKey);

    if (!deferred) {
      await dispatchStoredIncoming({ chatKey, kind, id, stored, isSelf, recordOnly, backlog });
      return;
    }

    let finished = false;
    let blocked = false;
    const finalizeDeferred = (reason) => {
      if (finished) return '';
      // 群游戏/管理员命令已经消费了这条：必须 ack，不能再放回 pending 让模型看到行动正文。
      const state = store.finalizeDeferred(chatKey, stored.id,
        reason === 'handled' ? { state: 'acked' } : undefined);
      if (!state) return '';
      finished = true;
      emit('chat-update', chatKey);
      return state;
    };
    const finishWithFallback = async () => {
      if (blocked) {
        // 黑名单删除失败（SQLITE_BUSY/停库）也不能把正文放给模型：先改写为拦截占位再 ack。
        try {
          store.updateDeferredMessage(chatKey, stored.id, { text: '[内容已拦截]', reply: null, media: [] });
          store.finalizeDeferred(chatKey, stored.id, { state: 'acked' });
          emit('chat-update', chatKey);
        } catch (error) {
          log(`[ingest] ${chatKey} 拦截消息收尾失败（留给启动清扫）：${error?.message ?? error}`);
        }
        return;
      }
      const current = store.getMessage(chatKey, stored.id);
      if (!current) return;
      await dispatchStoredIncoming({ chatKey, kind, id, stored: current, isSelf: false, backlog, finalize: finalizeDeferred });
    };
    // recordOnly（静默段/重连补课）走单独队列：不能让一大批历史富化把实时消息的
    // 延迟放行链堵在后面（Issue #85 的同类慢队列问题）。
    enqueueDeferredIngest(recordOnly ? `${chatKey}#backlog` : chatKey, {
      run: async () => {
        // 排队期间可能已被兜底清扫按占位符放行：不要再花一次网络预算去覆盖已放行的正文。
        if (store.getMessage(chatKey, stored.id)?.state !== 'deferred') return;
        // 队列可能排了很久才轮到：把年龄从"真正开始富化"重新起算，避免刚出队就被清扫放行。
        store.touchDeferred(chatKey, stored.id);
        const budget = createTimeBudget(enrichTimeoutMs, { signal: ingestAbort.signal });
        let enriched;
        try {
          enriched = await enrichIncomingMessage({
            chatKey, kind, id, segments, replySegment, looksForward, autoExpand, forwardResId,
            event, media, budget, cfgNow
          });
        } catch (error) {
          log(`[ingest] ${chatKey} 延迟富化异常，按占位符处理：${error?.message ?? error}`);
          enriched = { text, reply: null, media };
        }
        const finalText = enriched.text || text;
        // 用当前配置而非到达时快照：富化可能等十几秒，期间管理员新增的规则也要生效。
        if (finalText && matchesBlacklistKeyword(finalText, getConfig().store?.blacklistKeywords)) {
          blocked = true;
          const dropped = store.dropDeferredMessage(chatKey, stored.id);
          if (dropped) {
            finished = true;
            emit('chat-update', chatKey);
            log(`[ingest] ${chatKey} 富化后的正文命中消息关键词黑名单，已丢弃`);
          }
          return;
        }
        const changed = store.updateDeferredMessage(chatKey, stored.id, {
          text: finalText,
          reply: enriched.reply,
          media: enriched.media
        });
        if (!changed) return;
        const current = store.getMessage(chatKey, stored.id);
        if (!current) return;
        await dispatchStoredIncoming({ chatKey, kind, id, stored: current, isSelf: false, backlog, finalize: finalizeDeferred });
      },
      fallback: finishWithFallback
    });
  }

  // ── 启动/重连补齐 ──
  // 服务重启或协议端断线时事件会丢：消息根本没进库，也就永远没人回。
  // 连上以后从协议端拉一次最近历史，把库里没有的消息补进来；去重靠 mid，重复不会脏数据。
  let lastCatchUpAt = 0;
  let catchUpTimer = null;
  function scheduleCatchUp() {
    if (ingestStopping) return;
    if (Date.now() - lastCatchUpAt < 60000) return;   // 断线重连可能连续触发，一分钟内只补一次
    lastCatchUpAt = Date.now();
    clearTimeout(catchUpTimer);
    catchUpTimer = setTimeout(() => {
      catchUpTimer = null;
      catchUpMissedMessages().catch(() => {});
    }, 3000);
    catchUpTimer.unref?.();
  }
  async function catchUpMissedMessages() {
    if (ingestStopping) return;
    const cfgNow = getConfig();
    const windowMs = catchupReplyWindowMs(cfgNow);
    const targetMap = new Map();
    for (const g of idList(cfgNow.allow?.groups)) targetMap.set(`group:${g}`, { kind: 'group', id: g });
    for (const p of idList(cfgNow.allow?.private)) targetMap.set(`private:${p}`, { kind: 'private', id: p });
    // allowAllWhenEmpty 时 allow 名单是空的，旧逻辑一个群都不补；从已入库会话补，
    // 仍过一遍 chatAllowed（deny / 移出白名单的会话不会被补回来）。
    if (cfgNow.allowAllWhenEmpty) {
      for (const chatKey of store.listChats()) {
        if (!chatAllowed(chatKey, cfgNow)) continue;
        const m = /^(group|private):(\d+)$/.exec(chatKey);
        if (m) targetMap.set(chatKey, { kind: m[1], id: m[2] });
      }
    }
    const targets = [...targetMap.values()];
    const count = Math.max(1, Math.min(500, Number(cfgNow.onebot?.catchupHistoryCount) || 100));
    for (const { kind, id } of targets) {
      if (ingestStopping) break;
      const chatKey = `${kind}:${id}`;
      try {
        const data = kind === 'group'
          ? await onebot.call('get_group_msg_history', { group_id: Number(id), count }, 20000, null)
          : await onebot.call('get_friend_msg_history', { user_id: Number(id), count }, 20000, null);
        const list = Array.isArray(data?.messages) ? data.messages : [];
        if (list.length >= count) {
          console.log(`[catchup] ${chatKey} 已拉满 ${count} 条，更早的消息可能未补（可调大 onebot.catchupHistoryCount）`);
        }
        let added = 0;
        let recordedOnly = 0;
        for (const item of list) {
          if (ingestStopping) break;
          const mid = item?.message_id;
          if (mid === undefined || mid === null) continue;
          if (store.findByMid(chatKey, mid)) continue;         // 库里已有（含自己发的），跳过
          const ts = Math.round(Number(item?.time || 0) * 1000) || Date.now();
          const fresh = isFreshForReply(ts, Date.now(), windowMs);  // 窗口内的按新消息处理，更早的只补记录
          if (!fresh) recordedOnly += 1;
          // 第五个参数 backlog：补拉的历史（!fresh）不参与长期记忆的被动采集。
          await ingestMessage(kind, id, item, !fresh, !fresh);
          added += 1;
        }
        const line = catchupLogLine(chatKey, added, recordedOnly);
        if (line) console.log(line);
      } catch (error) {
        console.log(`[catchup] ${chatKey} 补齐失败：${error?.message ?? error}`);
      }
    }
  }

  async function handleFriendProposalAdminCommand(kind, id, text) {
    const identity = getConfig().identityPilot || {};
    const settings = identity.friendProposal || {};
    const incoming = identity.incomingFriendRequest || {};
    if (kind !== 'private' || String(settings.ownerUin) !== String(id)) {
      return false;
    }
    const incomingMatch = incoming.enabled === true
      ? /^\s*\/?(同意|拒绝)好友申请\s+(fr_[a-f0-9]{12})\s*$/i.exec(String(text || ''))
      : null;
    if (incomingMatch) {
      const decision = incomingMatch[1] === '同意' ? 'approve' : 'reject';
      let reply;
      try {
        const result = await identityPilot?.decideIncomingFriendRequest(
          incomingMatch[2],
          decision,
          { decidedBy: String(id) }
        );
        if (!result) throw new Error('统一身份库当前不可用');
        reply = result.note;
        emit('identity-pilot-update', identityPilot.status());
      } catch (error) {
        reply = `好友请求审批失败：${String(error?.message ?? error)}`;
      }
      try {
        await sendIdentityAdminText(id, reply);
      } catch (error) {
        log(`[identity-pilot] 入站好友请求审批结果通知失败：${error?.message ?? error}`);
      }
      return true;
    }
    if (settings.enabled !== true) return false;
    const match = /^\s*\/?(同意|拒绝)好友(?:申请)?\s+(fp_[a-f0-9]{12})\s*$/i.exec(String(text || ''));
    if (!match) return false;
    const decision = match[1] === '同意' ? 'approve' : 'reject';
    let reply;
    try {
      const result = await identityPilot?.decideFriendProposal(match[2], decision, {
        decidedBy: String(id)
      });
      if (!result) throw new Error('统一身份库当前不可用');
      const proposal = result.proposal;
      reply = decision === 'approve'
        ? `已批准 ${proposal.primaryName || proposal.userId}（${proposal.userId}）的好友候选。${result.note}`
        : `已拒绝 ${proposal.primaryName || proposal.userId}（${proposal.userId}）的好友候选。`;
      emit('identity-pilot-update', identityPilot.status());
    } catch (error) {
      reply = `好友候选审批失败：${String(error?.message ?? error)}`;
    }
    try {
      await sendIdentityAdminText(id, reply);
    } catch (error) {
      log(`[identity-pilot] 审批结果通知失败：${error?.message ?? error}`);
    }
    return true;
  }

  async function handleSlangPilotAdminCommand(kind, id, text) {
    const settings = getConfig().slangPilot || {};
    if (
      kind !== 'private'
      || settings.enabled !== true
      || String(settings.ownerUin) !== String(id)
    ) return false;
    const raw = String(text || '');
    const researchMatch =
      /^\s*\/?(研究黑话|拒绝研究)\s+(sr_[a-f0-9]{12})\s*$/i.exec(raw);
    const admissionMatch =
      /^\s*\/?(收录黑话|拒绝收录)\s+(sr_[a-f0-9]{12})\s*$/i.exec(raw);
    const retryMatch = /^\s*\/?重试黑话\s+(sr_[a-f0-9]{12})\s*$/i.exec(raw);
    if (!researchMatch && !admissionMatch && !retryMatch) return false;
    let reply;
    try {
      if (researchMatch) {
        const decision = researchMatch[1] === '研究黑话' ? 'approve' : 'reject';
        const result = slangPilot?.decideResearch(researchMatch[2], decision, {
          decidedBy: String(id)
        });
        if (!result) throw new Error('黑话语料库当前不可用');
        reply = decision === 'approve'
          ? `已批准研究“${result.discovery.displayTerm}”，任务已进入队列。`
          : `已拒绝研究“${result.discovery.displayTerm}”。`;
      } else if (admissionMatch) {
        const decision = admissionMatch[1] === '收录黑话' ? 'approve' : 'reject';
        const result = slangPilot?.decideAdmission(admissionMatch[2], decision, {
          decidedBy: String(id)
        });
        if (!result) throw new Error('黑话语料库当前不可用');
        reply = decision === 'approve'
          ? `已将“${result.discovery.displayTerm}”加入黑话候选库。`
          : `已拒绝收录“${result.discovery.displayTerm}”。`;
      } else {
        const result = slangPilot?.retryResearch(retryMatch[1], {
          decidedBy: String(id)
        });
        if (!result) throw new Error('黑话语料库当前不可用');
        reply = `已重新排队研究“${result.discovery.displayTerm}”。`;
      }
      emit('slang-pilot-update', slangPilot.status());
    } catch (error) {
      reply = `黑话审批失败：${String(error?.message ?? error)}`;
    }
    try {
      await sendIdentityAdminText(id, reply);
    } catch (error) {
      log(`[slang-pilot] 审批结果通知失败：${error?.message ?? error}`);
    }
    return true;
  }

  // 拍一拍/贴表情的去重表在 ./notice-dedup.js（notice 没有平台 mid，NULL 不参与唯一约束）。
  const noticeDedup = createNoticeDedup();

  async function ingestPoke(event, arrivedInactive = false) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）
    if (isGroup && operatorId && (cfgNow.blocklist?.[id] || []).map(String).includes(operatorId)) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"<uin> 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    if (noticeDedup.alreadySeen(pokeNoticeKey(chatKeyNow, operatorId, targetId, event))) return;
    // 拍一拍/贴表情也在同一条 ingress 串行链上：成员资料查询必须同样有预算，
    // 否则一个慢 get_group_member_info 会卡住这个群的后续消息（Issue #85）。
    const nameBudget = createTimeBudget(
      Math.max(200, Math.min(15000, Number(cfgNow.messageTypes?.enrichTimeoutMs) || 5000)),
      { signal: ingestAbort.signal }
    );
    let operatorName = isGroup ? ((await nameBudget.run(resolveAtName(id, operatorId), null)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    let text;
    if (String(targetId) === String(selfId)) {
      // 拍机器人是最常见的拍法：这条分支以前漏了清洗，群名片里的段标记能原样进提示词
      text = sanitizeUserText(`[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorName}）`);
    } else {
      const targetName = isGroup ? (await nameBudget.run(resolveAtName(id, targetId), null)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
      text = sanitizeUserText(text);
      // 上面这段文案会进消息存档、进而进提示词，昵称同样是 QQ 侧可控内容
    }
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: [],
      eventKind: 'poke',
      // 拍机器人 = 直接互动：档位判定与回复纠正据此把这条当"被点名"处理
      targetUserId: targetId
    }, { recordOnly: arrivedInactive || !isTimeActive(chatKeyNow) });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function ingestEmojiLike(event, arrivedInactive = false) {
    // OneBot（SnowLuma / NapCat 命名）：notice_type=group_msg_emoji_like、
    // sub_type=add|remove、likes:[{emoji_id, count}]，message_id 是被贴的那条消息。
    // 设计取舍：贴的是**机器人自己发的消息**才唤醒本轮（那是对它发言的反馈）；
    // 群友之间互相贴只落一条记录（acked），进未来运行的上下文，不单独叫醒它 ——
    // 否则活跃群里每个表情回应都触发一次运行，太吵。
    const groupId = String(event.group_id ?? '');
    if (!groupId) return;
    const cfgNow = getConfig();
    if (!allowed('group', groupId, cfgNow)) return;
    const operatorId = String(event.user_id ?? '');
    if (operatorId && operatorId === onebot.selfId) return;   // 自己贴的自己在发送时不重复记
    if (operatorId && (cfgNow.blocklist?.[groupId] || []).map(String).includes(operatorId)) return;
    const chatKeyNow = `group:${groupId}`;
    if (noticeDedup.alreadySeen(emojiNoticeKey(chatKeyNow, operatorId, event))) return;
    const nameBudget = createTimeBudget(
      Math.max(200, Math.min(15000, Number(cfgNow.messageTypes?.enrichTimeoutMs) || 5000)),
      { signal: ingestAbort.signal }
    );
    let operatorName = (await nameBudget.run(resolveAtName(groupId, operatorId), null)) || '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId && String(m.senderName || ''));
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    const likes = Array.isArray(event.likes) ? event.likes : [];
    const parts = likes.map((like) => {
      const emojiId = String(like?.emoji_id ?? '');
      const name = faceNameOf(emojiId);
      const count = Number(like?.count) || 1;
      return `${name ? `「${name}」` : ''}${emojiId || '?'}${count > 1 ? `×${count}` : ''}`;
    }).filter(Boolean).join('、') || '一个表情';
    let toSelf = false;
    if (event.message_id != null) {
      try { toSelf = store.findByMid?.(chatKeyNow, event.message_id)?.self === true; } catch { toSelf = false; }
    }
    const verb = event.sub_type === 'remove' ? '撤回了表情回应' : '贴了表情';
    const text = sanitizeUserText(toSelf
      ? `[贴表情] ${operatorName} ${verb}：${parts}（贴的是你说的那条）`
      : `[贴表情] ${operatorName} ${verb}：${parts}`);
    // 只有"贴"才当唤醒源：撤回表情不是对发言的反馈，把它也当唤醒源会让"某人撤回一个表情"
    // 也叫醒一轮（2026-10-07 复审 P3）。撤回照旧落记录 —— 但必须 recordOnly：
    // 唤醒标记（pending）是"要跑一轮"的信号，只记不跑的行留在未读里会永远吊着，
    // 直到下一个无关事件把它顺手带进上下文。
    const wakeSelf = toSelf && event.sub_type !== 'remove';
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: [],
      eventKind: 'emoji-like'
    }, { recordOnly: arrivedInactive || !isTimeActive(chatKeyNow) || !wakeSelf });
    emit('chat-update', chatKeyNow);
    if (wakeSelf) orchestrator.onIncoming(chatKeyNow);
  }

  const ingress = new Map();
  function handleOneBotEvent(event) {
    if (ingestStopping) return Promise.resolve();
    const key = event?.group_id ? `group:${event.group_id}` : `private:${event?.user_id}`;
    const arrivedInactive = !isTimeActive(key);
    const task = (ingress.get(key) || Promise.resolve()).then(() => ingestOneBotEvent(event, arrivedInactive));
    const tail = task.catch((error) => log('[ingest]', error?.message ?? error)).finally(() => {
      if (ingress.get(key) === tail) ingress.delete(key);
    });
    ingress.set(key, tail);
    return task;
  }

  async function ingestOneBotEvent(event, arrivedInactive) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // Echoes are deduplicated by message ID; shared-protocol observe mode also records old-instance replies.
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event, arrivedInactive);
      if (event.message_type === 'private' && event.user_id != null) {
        // 管理员私聊回「同意/拒绝」＝ 批准插件的写操作：这类消息不该再进模型
        //（模型只会把它当普通聊天内容，批了也白批）。
        // 只认**真实收到的消息**：message_sent 是机器人自己发出的回显，user_id 恰好是接收方
        //（管理员），机器人发一句"同意"就会被当成 owner 批准（2026-10-24 审查 P2）。
        if (event.post_type === 'message') {
          if (await adminServices.handlePrivateMessage(event)) return;
          const approval = pluginRegistry?.handleOwnerApprovalText?.(String(event.raw_message || ''), String(event.user_id));
          if (approval?.handled) {
            if (approval.reply) {
              void sender.sendTextBatch(`private:${event.user_id}`, [approval.reply], {}).catch(() => {});
            }
            return;
          }
        }
        return ingestMessage('private', String(event.user_id), event, arrivedInactive);
      }
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event, arrivedInactive);
    }
    if (event.post_type === 'notice' && event.notice_type === 'group_msg_emoji_like' && event.group_id != null) {
      return ingestEmojiLike(event, arrivedInactive);
    }
    if (
      event.post_type === 'request'
      && event.request_type === 'friend'
      && event.user_id != null
      && event.flag
    ) {
      const result = await identityPilot?.receiveIncomingFriendRequest({
        userId: String(event.user_id),
        flag: String(event.flag),
        comment: String(event.comment || '')
      });
      if (result && !result.ignored) emit('identity-pilot-update', identityPilot.status());
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'friend_add' && event.user_id != null) {
      const changed = await identityPilot?.markFriendAdded(String(event.user_id)) || 0;
      if (changed) emit('identity-pilot-update', identityPilot.status());
      return;
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  // 键序无关的深比较（序列化前把对象键排序）：判断"客户端提交的这份"与"服务端那份"
  // 是不是同一份东西 —— 掩码语义要用（脱敏视图原样回传 = 用户没动过）。
  const stableJson = (value) => {
    const seen = new WeakSet();
    const norm = (x) => {
      if (x === null || typeof x !== 'object') return x;
      if (seen.has(x)) return undefined;
      seen.add(x);
      if (Array.isArray(x)) return x.map(norm);
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = norm(x[k]);
      return out;
    };
    try { return JSON.stringify(norm(value)); } catch { return null; }
  };
  const server = http.createServer((req, res) => {
    // 停服第一步就拒绝新请求：否则停服窗口内到达的配置/插件写请求可能在
    // pluginRegistry.stop() 之后又触发 reconfigure，把插件子进程重新拉起来。
    if (ingestStopping) {
      try {
        res.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: '服务正在停止' }));
      } catch { /* 连接已断 */ }
      return;
    }
    handleHttp(req, res).catch((error) => {
      // 4xx 是用户输入/权限问题，不是服务端异常：不要写入异常面板，否则每次输错
      // 管理员 QQ/非法 JSON 都会变成一条 error incident。
      if (!(Number(error?.httpStatus) >= 400 && Number(error?.httpStatus) < 500)) {
        incidentPilot?.capture(error, {
          source: 'http',
          category: 'http',
          severity: 'error',
          details: { method: req.method || '', pathname: String(req.url || '').split('?')[0] }
        });
      }
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(error?.httpStatus || 500, { 'content-type': 'application/json' });
        // 错误原文可能带内部路径/compose 目录/上游响应：出控制台前过一道脱敏并截断（2026-10-10 审查）
        res.end(JSON.stringify({ error: redactText(String(error?.message ?? error), 400) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    // gzip（2026-10-02）：sessions 全量约 1.4MB、经隧道裸传要 3.4 秒 —— 而控制台每次
    // 初始化都拉它，这是"每个页面加载好几秒"的主因。JSON 压缩率约 10 倍，超过 1KB 就压；
    // 压缩失败退化成明文（客户端照样能读）。客户端没带 Accept-Encoding: gzip 就不压。
    const body = Buffer.from(JSON.stringify(data));
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Accept-Encoding'
    };
    const accept = String(res.req?.headers?.['accept-encoding'] || '').toLowerCase();
    // gzip 协商：忽略大小写、显式 q=0 视为拒绝（RFC 9110 最小正确子集，
    // 覆盖浏览器与常见代理的实际写法）。
    const gzipWanted = /(^|[\s,])gzip([\s,;]|$)/.test(accept)
      && !/gzip\s*;\s*q=0(?:\.0*)?\s*(?:,|$)/.test(accept);
    if (body.length >= 1024 && gzipWanted) {
      zlib.gzip(body, (error, packed) => {
        // 防御：回调可能晚于连接生命周期（客户端断开属安全 no-op；headers 已被
        // 兜底处理器写过时再 writeHead 会抛 —— 回调里的异常没人接得住，故先检查）。
        if (res.headersSent || res.destroyed) return;
        if (error) {
          res.writeHead(code, { ...headers, 'content-length': body.length });
          res.end(body);
          return;
        }
        res.writeHead(code, { ...headers, 'content-encoding': 'gzip', 'content-length': packed.length });
        res.end(packed);
      });
      return;
    }
    res.writeHead(code, { ...headers, 'content-length': body.length });
    res.end(body);
  }

  async function readBody(req, maxBytes = 2 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        throw Object.assign(new Error('请求体过大'), { httpStatus: 413 });
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { httpStatus: 400 });
    }
  }

  // 「无令牌 = 仅本机」的本机判定必须看 TCP 对端（req.socket.remoteAddress），不能只看 Host 头：
  // Host 是客户端随便填的，0.0.0.0 暴露面下伪造 `Host: 127.0.0.1` 就能冒充本机
  //（2026-10-06 复审：server.__replace__ 清空令牌后，监听仍是 0.0.0.0，靠 Host 头判本机即免鉴权）。
  function isLoopbackRemote(req) {
    let remote = String(req.socket?.remoteAddress || '');
    if (!remote) return false;
    // 同机反向代理（如 BT 面板的 nginx 部署形态）对端也是 127.0.0.1，"仅本机"前提不成立。
    // 只要出现转发头就说明请求不是从本机直连来的，无令牌模式一律 fail-closed（要求令牌）。
    // SSH 隧道（console-tunnel / ops console）不注入这些头，免密体验不受影响（2026-10-07 复审）。
    if (req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || req.headers?.forwarded) return false;
    if (remote.startsWith('::ffff:')) remote = remote.slice('::ffff:'.length);   // IPv4-mapped
    return remote === '::1' || remote.startsWith('127.');
  }

  // 套接字只在 start() 里绑定一次，不随配置重绑 —— 运行期的真实暴露面以这里记的为准，
  // updateConfig 的"非回环必须有令牌"校验不能只看配置里的 host（配置改成 127.0.0.1 校验就过了，
  // 监听却还开着 0.0.0.0）。'' 表示尚未绑定（测试直连路由的场景）。
  let boundServerHost = '';

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    const origin = String(req.headers.origin || '');
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return false;
    if (!token) {
      return isLoopbackRemote(req)
        && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || '');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const cookie = String(req.headers.cookie || '').split(';').map((v) => v.trim())
      .find((v) => v.startsWith('qq_agent_token='));
    return sameSecret(req.headers['x-console-token'], token)
      || (QUERY_TOKEN_PATHS.has(url.pathname) && sameSecret(url.searchParams.get('token'), token))
      || sameSecret(cookie?.slice('qq_agent_token='.length), encodeURIComponent(token));
  }

  function setConsoleCookie(req, res, token) {
    res.setHeader('set-cookie',
      // 本地改动：加 Max-Age，避免关掉浏览器就要重新输令牌。
      // HTTPS（直连或可信反代 x-forwarded-proto: https）下加 Secure，避免明文链路发 Cookie。
      `qq_agent_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`
      + (requestIsSecure(req) ? '; Secure' : ''));
  }

  function writeConsoleAccess(token) {
    const file = path.join(DATA_DIR, 'console-access.txt');
    const tmp = `${file}.${process.pid}.tmp`;
    const cfg = getConfig();
    fs.writeFileSync(tmp,
      `QQ Agent Linux\nURL: http://${consoleUrlHost(cfg.server.host)}:${cfg.server.port}\nToken: ${token}\nMode: ${cfg.runtime.mode}\n`,
      { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  }

  // ── 配置脱敏 ─────────────────────────────────────────────────────────────
  // 判定与实现已迁出到 src/core/secret-keys.js（#5/#6 共同前置：控制台脱敏与审计脱敏
  // 共用同一份模式表）。保留原名做薄包装，调用点不动。
  const sanitizeConfig = sanitizeConfigSecrets;

  // ── ASR 的运行时结论 ─────────────────────────────────────────────────────
  /**
   * /api/config 里 asr 那节附带的"服务端结论"：是否配齐/可用、Key 的来源与归属、
   * 本机转写实际会用哪个二进制与模型。
   * GET 与 POST 必须走同一处：只挂给 GET 的话，保存接口回给界面的是"打开设置页那一刻"的
   * 陈旧副本 —— 刚存好合法配置却显示"没配好"，该报警时（换了服务/地址）又不报警（2026-09-26 审查）。
   */
  function asrStatusOf(cfgNow) {
    return {
      configured: asrConfigured(cfgNow),
      available: asrAvailable(cfgNow),
      keySource: asrKeySource(cfgNow),
      // 归属：界面据此判断"这把 Key/Secret 是不是当前这家的"，不匹配就不能显示成"已填"
      keyProvider: String(cfgNow?.asr?.apiKeyProvider || ''),
      keyHost: asrKeyHost(cfgNow),
      keyUsable: asrApiKey(cfgNow) !== '',
      secretIdProvider: String(cfgNow?.asr?.secretIdProvider || ''),
      secretIdUsable: asrSecretId(cfgNow) !== '',
      secretKeyProvider: String(cfgNow?.asr?.secretKeyProvider || ''),
      secretKeyUsable: asrSecretKey(cfgNow) !== '',
      // 「哪几家（槽位）存过凭据、存的是哪几项」的布尔口径（不下发明文）：
      // 界面切换服务预设时据此显示掩码/留空（存过 → 掩码、没存过 → 空白等填）
      keySlots: asrKeySlots(cfgNow?.asr),
      // 本机转写用哪个二进制/模型（配置>环境变量>自动找到）——让"装没装、会用哪个"看得见
      localBinResolved: asrLocalBin(cfgNow),
      localModelResolved: asrLocalModel(cfgNow),
      // 托管目录里还有东西吗？删除按钮只看这个 —— 避免"本机可用但没有任何托管文件"
      // （例如 whisper-cli 装在 PATH 里）时按钮点了什么也没删、还退不出去（审查意见）
      localManagedExists: managedAsrExists(),
      // "装好了没"要真去验：配置里写得再像也不等于文件在（审查意见）。
      // 界面拿这个决定按钮文案，跟 asrAvailable() 的口径保持一致。
      localInstalled: Boolean(findWhisperBinSync(cfgNow))
        && String(asrLocalModel(cfgNow)) !== ''
        && (() => { try { return fs.existsSync(asrLocalModel(cfgNow)); } catch { return false; } })()
    };
  }

  /** 脱敏后的配置 + asr 的运行时结论（GET 与 POST 共用，界面拿到的永远是最新结论）。 */
  function safeConfigWithAsrStatus(cfgNow) {
    const safe = sanitizeConfig(cfgNow);
    // 容器标记来自运行环境，不是用户配置，所以不落盘、每次响应现算。
    // 控制台据此禁用"立即更新"、协议端一键更新等只对 systemd 部署有意义的操作。
    safe.runtime = {
      ...(safe.runtime || {}),
      container: isContainerRuntime(),
      updateManagedBy: isContainerRuntime() ? 'docker' : 'systemd'
    };
    safe.asr = { ...(safe.asr || {}), ...asrStatusOf(cfgNow) };
    // tts 的 Key 被 sanitize 删掉了，用派生标志告诉界面"哪几家已存"（按供应商显示掩码）
    safe.tts = {
      ...(safe.tts || {}),
      keyServices: ttsKeyServices(cfgNow.tts),
      hasApiKey: Boolean(cfgNow.tts?.apiKey || Object.keys(cfgNow.tts?.keys || {}).length),
      currentService: ttsServiceOf(cfgNow.tts)?.id || ''
    };
    // imageGen 的 Key 同样被 sanitize 删掉了：给界面一个"存过没有"的派生标志
    // （hasApiKey 由 walk 自动生成，这里的 available 是"能不能真的画"）
    // keyHost/keyStale 必须显式补：字段名含 apikey，会被 secret-keys 的模式当密钥删掉，
    // 而界面要靠它说明"存过的 Key 不是给这个地址的，换个地址要重填"。
    safe.imageGen = {
      ...(safe.imageGen || {}),
      available: imageGenAvailable(cfgNow),
      keyHost: String(cfgNow.imageGen?.apiKeyHost || ''),
      keyStale: imageGenKeyStale(cfgNow.imageGen, cfgNow.api),
      // 「哪几家（主机）存过 Key」的布尔口径（不下发明文）：界面切换预设时据此显示掩码/留空
      keyHosts: imageGenKeyHosts(cfgNow.imageGen)
    };
    // 兜底 Key 同样被 sanitize 删除；keyHost 是真身 apiKeyHost 的视图别名，
    // 界面据此提示"换地址后这把 Key 不属于这里、要重填"。
    safe.api = {
      ...(safe.api || {}),
      fallback: {
        ...(safe.api?.fallback || {}),
        keyHost: String(cfgNow.api?.fallback?.apiKeyHost || '')
      }
    };
    delete safe.api.fallback.hasApiKeyHost;
    return safe;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线应当是「校验请求来源」，而不是砍掉本地功能。
   *
   * 放行条件（任一）：
   *   1. 配置了 server.token 且请求带上了它（远程/多用户场景）
   *   2. 请求来自本机控制台：Origin/Referer 指向本服务，或带 x-console-token 头
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token && authorize(req)) return true;
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (sameSecret(req.headers['x-console-token'], token)
        || (QUERY_TOKEN_PATHS.has(url.pathname) && sameSecret(url.searchParams.get('token'), token))) return true;
    }
    // 带自定义头 → 不可能是简单跨站请求（需 CORS 预检通过才能发出）；
    // 但还要求请求真来自本机（remoteAddress 回环 + Host 口径保留）：否则"控制台暴露到公网
    // 且没设令牌"时，伪造 `Host: 127.0.0.1` 就能带着任意 x-console-token 读明文密钥。
    const host = String(req.headers.host ?? '');
    if (req.headers['x-console-token'] && isLoopbackRemote(req)
      && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return true;

    const origin = String(req.headers.origin ?? '');
    const referer = String(req.headers.referer ?? '');
    // 与上面 x-console-token 分支、authorize 同一口径（端口可选）：config 校验允许 host='::1'，
    // 漏了 [::1] 时 IPv6 回环部署在这里会一直 403；80 端口部署的 Host 也不带端口。
    const isLoopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
    if (!isLoopbackHost || !isLoopbackRemote(req)) return false;
    if (origin) return origin === `http://${host}`;
    if (referer) return referer.startsWith(`http://${host}/`);
    return true;   // 地址栏直连等无来源请求，无法进一步区分
  }

  /**
   * 已保存的 Key 只允许发往配置里已知的地址。
   * 目的只是不让"随手填个地址点测试"把已保存的 Key 送出去，**它不构成安全边界**：
   * 控制台令牌本身就是完全管理凭据，持有令牌的人可以直接从 /api/api-key 等端点读到明文
   * Key（见 keyEndpointAllowed 的第一条分支：令牌通过即放行）；也可以先 POST /api/providers
   * 把自己的地址注册进来，再走这个回退。前端正常流程都显式传 Key，只有"测试当前配置的
   * provider"会用到回退，而那个地址本来就等于配置里的值。
   */
  function storedKeyAllowedFor(cfgNow, baseUrl) {
    const norm = (v) => String(v || '').trim().replace(/\/+$/, '').toLowerCase();
    const target = norm(baseUrl);
    if (!target) return true;   // 没给地址 = 用配置里的那个
    const known = [
      norm(cfgNow.api?.baseUrl),
      ...(cfgNow.providers || []).map((p) => norm(p?.baseURL))
    ].filter(Boolean);
    return known.includes(target);
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  // ── 路由表（改进方案 #2；迁移方式：加壳并行，搬走即删原分支）──
  // 第一批：三个 auth:false 例外 + SSE（/healthz、/api/login、/api/events）。
  // ── 审计（#5）────────────────────────────────────────────────────────────
  // 写接口留痕（方案 #5，落盘见 core/audit-log.js）：全程旁路 —— 写失败只 warn，
  // 绝不影响响应。before/after 由调用方给，脱敏与截断在 core 里统一做。
  const tokenFpOf = (token) => (token
    ? crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8)
    : '');

  function auditWrite(action, target, extra = {}) {
    const req = extra.req || null;
    appendAudit({
      action,
      target,
      ip: req?.socket?.remoteAddress || '',
      fwd: String(req?.headers?.['x-forwarded-for'] || ''),
      ua: String(req?.headers?.['user-agent'] || ''),
      tokenFp: String(req?.consoleTokenFp ?? ''),
      before: extra.before,
      after: extra.after,
      changed: extra.changed,
      ok: extra.ok !== false,
      error: extra.error ? String(extra.error) : ''
    });
  }

  const metrics = createMetrics();
  const router = createRouter({
    authorize,
    json,
    keyEndpointAllowed,
    metrics,
    // 审计（#5）：鉴权成功后由 router 记下本次凭据指纹（sha256 前 8 位），写接口埋点直接
    // 读 req.consoleTokenFp —— 与鉴权同一次取值，不在每个埋点里各自重算。
    tokenFp: () => tokenFpOf(getConfig().server?.token)
  });
  // 存储占用接口（/api/storage、/api/storage/compress）。按领域拆在 console/storage.js，
  // 这里只注册，不再往本文件里加 handler。
  registerStorageRoutes(router, { json, sessions });

  router.add('GET', '/healthz', async (req, res) => {
    // 给拨测/uptime 监控用：无鉴权，但只含版本与连接状态，不带任何配置
    return json(res, 200, {
      ok: true,
      name: PKG.name,
      version: PKG.version,
      uptimeSeconds: Math.round(process.uptime()),
      onebotConnected: Boolean(onebot?.connected),
      timestamp: Date.now()
    });
  }, { auth: false });

  // 用量统计要读会话文件；指标抓取可能很频繁，缓存 60 秒，避免每次 scrape 都把磁盘扫一遍。
  let metricsUsageCache = { at: 0, value: null };
  function metricsUsageToday() {
    const now = Date.now();
    if (now - metricsUsageCache.at < 60000) return metricsUsageCache.value;
    let value = null;
    try {
      const usage = buildUsageStats({ range: 'today' });
      // 与 /api/status 同口径：台账包含记忆整理/日报等不写 session 的后台调用，
      // 监控里的今日花费不能系统性偏低（2026-11-01 盲审 P2）。
      const ledgerCost = Number(sessions.todayUsage(todayKey())?.estimatedYuan) || 0;
      value = {
        calls: Number(usage?.totals?.runs) || 0,
        cost: Math.round(Math.max(Number(usage?.totals?.cost) || 0, ledgerCost) * 10000) / 10000,
        promptTokens: Number(usage?.totals?.promptTokens) || 0,
        completionTokens: Number(usage?.totals?.completionTokens) || 0,
        totalTokens: Number(usage?.totals?.totalTokens) || 0
      };
    } catch { value = null; }
    metricsUsageCache = { at: now, value };
    return value;
  }

  router.add('GET', '/api/metrics', async (req, res, params, url) => {
    const memory = process.memoryUsage();
    const queues = store.queueStats?.() || { byState: {}, oldestAt: 0, oldestAgeMs: 0 };
    const outbox = store.outboxStats?.() || { total: 0, byState: {} };
    const usage = metricsUsageToday();
    const llm = {
      ...llmRuntimeStats,
      callsToday: usage?.calls ?? 0,
      costToday: usage?.cost ?? 0,
      promptTokensToday: usage?.promptTokens ?? 0,
      completionTokensToday: usage?.completionTokens ?? 0,
      totalTokensToday: usage?.totalTokens ?? 0
    };
    const plugins = (pluginRegistry.list?.().plugins || []).map((plugin) => ({
      id: plugin.id,
      state: plugin.status?.state || 'unknown',
      rssKb: Number(plugin.status?.rssKb) || 0,
      inFlight: Number(plugin.status?.inFlight) || 0,
      stats: plugin.status?.stats || {}
    }));
    // 指标页要能一眼回答“群里不回话是卡在哪”：unknown/held 是发送链，
    // MCP 重启次数是工具链，磁盘水位是所有链的共同前提。
    const unknown = store.unknownSummaryAll?.() || { total: 0, oldestAgeMs: 0 };
    const mcpRows = typeof mcpManager?.status === 'function' ? mcpManager.status() : [];
    const mcp = {
      restarting: mcpRows.filter((row) => row.restarting).length,
      restartAttempts: mcpRows.reduce((sum, row) => sum + (Number(row.restartAttempts) || 0), 0),
      permissionActive: mcpRows.filter((row) => row.permissionActive).length,
      servers: mcpRows.map((row) => ({
        id: row.id,
        ready: row.ready === true,
        restarting: row.restarting === true,
        restartAttempts: Number(row.restartAttempts) || 0,
        permissionIsolation: row.permissionIsolation === true,
        permissionActive: row.permissionActive === true
      }))
    };
    let host = null;
    try { host = hostStats({ dir: DATA_DIR }); } catch { host = null; }
    const snapshot = {
      ok: true,
      timestamp: Date.now(),
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal
      },
      http: metrics.snapshot(),
      onebot: {
        connected: Boolean(onebot?.connected),
        sendFailures: Number(outbox?.byState?.failed) || 0
      },
      outbox,
      unknown,
      queues,
      mcp,
      host: host ? { mem: host.mem, disk: host.disk } : null,
      llm,
      plugins
    };
    if (String(url.searchParams.get('format') || '').toLowerCase() === 'prometheus') {
      const lines = [
        '# HELP qqagent_uptime_seconds Process uptime.',
        '# TYPE qqagent_uptime_seconds gauge',
        `qqagent_uptime_seconds ${snapshot.process.uptimeSeconds}`,
        '# TYPE qqagent_http_requests_total counter',
        `qqagent_http_requests_total ${snapshot.http.requests.total}`,
        '# TYPE qqagent_outbox_pending gauge',
        `qqagent_outbox_pending ${Number(outbox?.byState?.sending) || 0}`,
        '# TYPE qqagent_outbox_failed gauge',
        `qqagent_outbox_failed ${Number(outbox?.byState?.failed) || 0}`,
        '# TYPE qqagent_inbound_pending gauge',
        `qqagent_inbound_pending ${Number(queues?.byState?.pending) || 0}`,
        '# TYPE qqagent_inbound_oldest_age_seconds gauge',
        `qqagent_inbound_oldest_age_seconds ${Math.round((Number(queues?.oldestAgeMs) || 0) / 1000)}`,
        '# TYPE qqagent_outbox_unknown gauge',
        `qqagent_outbox_unknown ${Number(unknown?.total) || 0}`,
        '# TYPE qqagent_outbox_unknown_oldest_age_seconds gauge',
        `qqagent_outbox_unknown_oldest_age_seconds ${Math.round((Number(unknown?.oldestAgeMs) || 0) / 1000)}`,
        '# TYPE qqagent_mcp_restart_attempts_total gauge',
        `qqagent_mcp_restart_attempts_total ${mcp.restartAttempts}`,
        '# TYPE qqagent_mcp_restarting gauge',
        `qqagent_mcp_restarting ${mcp.restarting}`,
        '# TYPE qqagent_disk_used_ratio gauge',
        `qqagent_disk_used_ratio ${(Number(snapshot.host?.disk?.usedPercent) || 0) / 100}`,
        '# TYPE qqagent_llm_requests_total counter',
        `qqagent_llm_requests_total ${llm.requests}`,
        '# TYPE qqagent_llm_failures_total counter',
        `qqagent_llm_failures_total ${llm.failures}`,
        '# TYPE qqagent_llm_retries_total counter',
        `qqagent_llm_retries_total ${llm.retries}`,
        '# TYPE qqagent_llm_cost_today gauge',
        `qqagent_llm_cost_today ${llm.costToday}`,
        '# TYPE qqagent_event_loop_utilization gauge',
        `qqagent_event_loop_utilization ${snapshot.http.eventLoop?.utilization ?? 0}`,
        '# TYPE qqagent_onebot_connected gauge',
        `qqagent_onebot_connected ${snapshot.onebot.connected ? 1 : 0}`
      ];
      for (const [bucket, count] of Object.entries(snapshot.http.requests.byStatus)) {
        lines.push(`qqagent_http_responses_total{class="${bucket}"} ${count}`);
      }
      for (const [state, count] of Object.entries(outbox?.byState || {})) {
        lines.push(`qqagent_outbox{state="${state}"} ${count}`);
      }
      for (const [state, count] of Object.entries(queues?.byState || {})) {
        lines.push(`qqagent_inbound_queue{state="${state}"} ${count}`);
      }
      for (const plugin of plugins) {
        lines.push(`qqagent_plugin_up{id="${plugin.id}"} ${plugin.state === 'running' ? 1 : 0}`);
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(`${lines.join('\n')}\n`);
      return;
    }
    return json(res, 200, snapshot);
  });

  // 最近一次巡检结果（health.json 由 ops health-check 写；控制台只读）
  router.add('GET', '/api/health', async (req, res) => {
    let health = null;
    try { health = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'health.json'), 'utf8')); } catch { health = null; }
    return json(res, 200, { ok: true, health });
  });

  router.add('POST', '/api/login', async (req, res) => {
    const origin = String(req.headers.origin || '');
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
      return json(res, 403, { error: 'Invalid origin' });
    }
    const gate = loginGate(req);
    if (!gate.ok) return json(res, 429, { error: `尝试过于频繁，请 ${gate.retryAfterSec} 秒后再试` });
    const body = await readBody(req).catch(() => ({}));
    const token = getConfig().server.token;
    // timing-safe 比较：全项目统一 sameSecret 口径（这里原来是唯一的普通 !==，修复遗漏）。
    if (!token || !sameSecret(String(body?.token ?? ''), token)) {
      gate.fail();
      return json(res, 401, { error: 'Token 不正确' });
    }
    gate.clear();
    setConsoleCookie(req, res, token);
    return json(res, 200, { ok: true });
  }, { auth: false });

  router.add('POST', '/api/console-token', async (req, res) => {
    const body = await readBody(req);
    const current = String(body.currentToken ?? '');
    const next = String(body.newToken ?? '').trim();
    const confirm = String(body.confirmToken ?? '').trim();
    if (!sameSecret(current, getConfig().server.token)) {
      // 凭据相关的失败也留痕（#5 埋点口径：成功 + 异常 + 凭据校验失败；普通参数校验 4xx 不记）
      auditWrite('console-token.rotate', 'server.token', { req, ok: false, error: '当前 Token 不正确' });
      return json(res, 403, { error: '当前 Token 不正确' });
    }
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(next)) {
      return json(res, 400, { error: '新 Token 必须为 16-128 位字母、数字或 . _ ~ -' });
    }
    if (next !== confirm) return json(res, 400, { error: '两次输入的新 Token 不一致' });
    if (sameSecret(next, getConfig().server.token)) return json(res, 400, { error: '新 Token 不能与当前 Token 相同' });
    updateConfig({ server: { token: next } });
    let accessFileUpdated = true;
    try { writeConsoleAccess(next); }
    catch (error) {
      accessFileUpdated = false;
      log('[console] Token 已更新，但 console-access.txt 写入失败:', error?.message ?? error);
    }
    // 审计（#5）：只记前后指纹（sha256 前 8 位），令牌明文既不落盘也不进日志；
    // 换令牌前后可对账（旧指纹来自本次鉴权用的令牌，新指纹来自刚设置的值）。
    auditWrite('console-token.rotate', 'server.token', {
      req,
      before: { tokenFp: String(req.consoleTokenFp ?? '') },
      after: { tokenFp: tokenFpOf(next), accessFileUpdated }
    });
    setConsoleCookie(req, res, next);
    for (const client of sseClients) client.end();
    sseClients.clear();
    return json(res, 200, { ok: true, accessFileUpdated });
  });

  router.add('GET', '/api/audit', async (req, res, params, url) => {
    // 审计留痕查询（#5）：默认 200 条、硬上限 500（core 里再兜一次），before = ts 游标。
    // 不做全量导出；config.update 类的记录含前后快照（单条可达数十 KB），翻页取即可。
    const limit = Number(url.searchParams.get('limit') || 0) || 200;
    const beforeTs = Number(url.searchParams.get('before') || 0) || 0;
    return json(res, 200, queryAudit({ limit, beforeTs }));
  });

  router.add('GET', '/api/api-key', async (req, res) => {
    return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
  }, { keyEndpoint: true });

  router.add('GET', '/api/fallback-key', async (req, res) => {
    return json(res, 200, { apiKey: String(getConfig().api?.fallback?.apiKey || '') });
  }, { keyEndpoint: true });

  router.add('GET', '/api/search-key', async (req, res, params, url) => {
    const field = String(url.searchParams.get('field') || '');
    // 自定义搜索服务的 Key 不走这里（它们存在 webSearch.providers 数组里，
    // 由 /api/search-providers 管理，且添加时是一次性输入，不提供明文回读）。
    const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso', 'doubao', 'tavily'];
    if (!allowed.includes(field)) {
      return json(res, 400, { error: `未知搜索服务：${field}` });
    }
    return json(res, 200, { apiKey: String(getConfig().webSearch?.[field]?.apiKey || '') });
  }, { keyEndpoint: true });

  // OneBot 的 WS / HTTP 令牌：与聊天模型 Key 一样属"填过就看不见"的密钥
  // （/api/config 按字段名 accessToken/httpAccessToken 统一脱敏），
  // 控制台里因此需要一条回读明文的受守卫端点才能做「显示」。
  // 注意与别的 Key 的**语义差别**：这两个字段的"保持不变"哨兵是**空串**（不是 ******），
  // 前端「隐藏」时要把输入框还原成空，保存处也认空串；写成 ****** 会真存进配置。
  router.add('GET', '/api/onebot-key', async (req, res, params, url) => {
    const field = String(url.searchParams.get('field') || '');
    const pick = {
      ws: () => getConfig().onebot?.accessToken,
      http: () => getConfig().onebot?.httpAccessToken
    }[field];
    if (!pick) return json(res, 400, { error: `未知字段：${field}（可选 ws / http）` });
    return json(res, 200, { token: String(pick() || '') });
  }, { keyEndpoint: true });

  router.add('GET', '/api/events', async (req, res) => {
    // SSE：鉴权由路由表默认 auth:true 统一执行（原实现里手写的 authorize 已删）
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    res.write('event: hello\ndata: {}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  router.add('GET', '/api/integrations/status', async (req, res) => json(res, 200, await integrationStatus()));
  router.add('GET', '/api/auto-update/status', async (req, res) => json(res, 200, autoUpdate.status()));
  // 协议端（SnowLuma）版本 / 更新 / 回滚：控制台「设置 → OneBot」页用
  // 主机资源（只读）：总览页用。取不到的项返回 null，接口本身不因为某个指标失败而 500。
  router.add('GET', '/api/host', async (req, res) => json(res, 200, { ok: true, ...hostStats({ dir: DATA_DIR }) }));

  // 一键体检：复用 `ops health-check` 的同一份巡检（控制台/协议端/入站/磁盘/更新），
  // 只读、不通知 owner。控制台把失败项直接列出来，用户不用再 ssh 跑命令。
  // 并发/落盘约束：一次只允许一个体检；跳过全库 integrity_check 和 health.json 写入，
  // 否则同步 DatabaseSync 会卡住事件循环，并覆盖定时巡检的连击状态。
  let healthCheckInFlight = null;
  router.add('POST', '/api/health/check', async (req, res) => {
    if (healthCheckInFlight) {
      return json(res, 429, { busy: true, error: '体检正在进行中，请稍候' });
    }
    const cfgNow = getConfig();
    const onebotPort = Number(cfgNow.onebot?.httpPort) || 3000;
    const onebotHttpUrl = String(cfgNow.onebot?.httpUrl || '').trim()
      || `http://127.0.0.1:${onebotPort}`;
    const task = (async () => runHealthCheck({
      dataDir: DATA_DIR,
      mode: String(cfgNow.runtime?.mode || 'active'),
      consolePort: Number(cfgNow.server?.port) || Number(process.env.QQ_AGENT_SERVER_PORT) || 3210,
      onebotHttpPort: onebotPort,
      onebotHttpUrl,
      onebotToken: String(cfgNow.onebot?.httpAccessToken || cfgNow.onebot?.accessToken || ''),
      containerRuntime: isContainerRuntime(),
      snowlumaDir,
      service: '',
      notify: null,
      persist: false,
      integrityCheck: false,
      mcpStatus: mcpManager.status()
      // 不注入 sudoDockerProbe：巡检默认会试一次 `sudo -n docker`（8 秒上限）。
      // 固定成 false 会让"直连不可用但 sudo 回退可用"的机器在控制台里假红。
    }))();
    healthCheckInFlight = task;
    try {
      const result = await task;
      return json(res, 200, { healthy: result.healthy, checks: result.checks });
    } catch (error) {
      log('[console] health check failed:', error?.message ?? error);
      return json(res, 200, {
        healthy: false,
        checks: [],
        error: String(error?.message ?? error)
      });
    } finally {
      if (healthCheckInFlight === task) healthCheckInFlight = null;
    }
  });
  router.add('GET', '/api/snowluma/version', async (req, res) => {
    const st = await snowlumaUpdater.status();
    const auto = getConfig().autoUpdate?.snowluma || {};
    return json(res, 200, {
      ...st,
      // 容器模式：协议端由 compose 管，版本信息仍可展示，但"一键更新/回滚"不可用。
      container: isContainerRuntime(),
      auto: {
        enabled: auto.enabled === true,
        image: String(auto.image || ''),
        followBaseline: auto.followBaseline !== false
      }
    });
  });
  router.add('POST', '/api/snowluma/update', async (req, res) => {
    if (isContainerRuntime()) {
      return json(res, 409, { ok: false, error: containerUpdateHint() });
    }
    const body = await readBody(req).catch(() => ({}));
    const to = String(body?.to || getConfig().autoUpdate?.snowluma?.image || '').trim();
    const result = await snowlumaUpdater.update({ to, dryRun: body?.dryRun === true });
    auditWrite('snowluma-update', result.to || 'protocol', {
      req, ok: result.ok !== false, error: result.error || '',
      changed: { from: result.from, to: result.to, rolledBack: result.rolledBack === true }
    });
    return json(res, result.ok ? 200 : 500, result);
  });
  router.add('POST', '/api/snowluma/rollback', async (req, res) => {
    if (isContainerRuntime()) {
      return json(res, 409, { ok: false, error: containerUpdateHint() });
    }
    const result = await snowlumaUpdater.rollback();
    auditWrite('snowluma-rollback', result.to || 'protocol', {
      req, ok: result.ok !== false, error: result.error || ''
    });
    return json(res, result.ok ? 200 : 500, result);
  });
  router.add('GET', '/api/channel-prices', async (req, res) => json(res, 200, { ok: true, feeds: channelPriceStatus() }));
  router.add('GET', '/api/model-prices', async (req, res, params, url) => json(res, 200, modelPricesPayload(url.searchParams.get('model'))));
  router.add('GET', '/api/vision/results', async (req, res) => json(res, 200, { results: { ...builtinVisionResults(currentProviders()), ...visionResults() }, scanning: visionScan.running }));
  router.add('GET', '/api/daily-moments/status', async (req, res) => json(res, 200, dailyMoments.status()));
  router.add('GET', '/api/qzone-interactions/status', async (req, res) => json(res, 200, qzoneInteractions.status()));
  router.add('GET', '/api/group-game/status', async (req, res) => json(res, 200, groupGame.status()));
  router.add('GET', '/api/group-digest/status', async (req, res) => json(res, 200, groupDigest.status()));
  router.add('GET', '/api/admin-briefing/status', async (req, res) => json(res, 200, adminBriefing.status()));
  router.add('GET', '/api/tts/presets', async (req, res) => json(res, 200, { ok: true, services: TTS_SERVICES }));
  // 「平台能力」页的元数据：键 → 标签 / 它管的工具 / 默认取向（"默认关"的三项在 UI 上要标注）。
  // 让 UI 从服务端拿这份清单，而不是在 ui/ 里再抄一份 —— 抄一份就会在下次拆键时漏掉一半。
  router.add('GET', '/api/platform/gates', async (req, res) => json(res, 200, {
    ok: true,
    gates: Object.entries(PLATFORM_TOOL_GATES).map(([key, tools]) => ({
      key,
      label: PLATFORM_GATE_LABELS[key] || key,
      tools,
      defaultOn: !PLATFORM_DEFAULT_OFF.has(key)
    })),
    quotas: Object.entries(PLATFORM_QUOTA_DEFAULTS).map(([key, value]) => ({ key, default: value }))
  }));
  // 平台写入闸门的当前用量（滑动窗口内）：UI 显示"本小时/今日已用 x / 上限 y"。
  // 注意这是**进程内**计数 —— 控制台与机器人同一进程（src/console/app.js 就是主进程的装配）。
  router.add('GET', '/api/platform/quota-usage', async (req, res) => json(res, 200, { ok: true, quotas: platformQuotaUsage() }));
  router.add('GET', '/api/identity-pilot/status', async (req, res) => json(res, 200, identityPilotStatus()));
  router.add('GET', '/api/slang-pilot/status', async (req, res) => json(res, 200, slangPilotStatus()));
  router.add('GET', '/api/incident-pilot/status', async (req, res) => json(res, 200, incidentPilotStatus()));

  router.add('POST', '/api/integrations/snowluma/password', async (req, res) => {
    const body = await readBody(req);
    try {
      return json(res, 200, await updateSnowLumaPassword(body));
    } catch (error) {
      return json(res, error.httpStatus || 502, {
        error: String(error?.message ?? error)
      });
    }
  });
  // 自动更新（status 一行式路由仍留在上面的状态聚合区）
  registerAutoUpdateRoutes(router, { json, readBody, auditWrite, getConfig, getAutoUpdate: () => autoUpdate, dataDir: DATA_DIR });

  registerChatRoutes(router, {
    json, readBody, emit, log, store, orchestrator, sender, onebot, updateConfig,
    groupDigest, adminBriefing,
    getIncidentPilot: () => incidentPilot, getSlangPilot: () => slangPilot
  });

  registerAssetRoutes(router, {
    json, readBody, emit, assetObserver, stickers,
    slangPilotStatus, identityPilotStatus, refreshIdentityAfterAssetMutation
  });

  // ── 插件（v1）：列表 / 索引 / 安装 / 卸载 / 启停 / 重载 ───────────────────────────
  // 插件的这些动作**全走这里、不进设置页的保存分支**：装/卸/启停要起停子进程并重排工具表，
  // 是运行时动作而不是配置表单；设置页那一栏只负责渲染与调用这些接口。
  // 索引来源清单：`plugins.indexUrls`（数组，顺序即优先级）+ 旧配置 `plugins.indexUrl`（单条，仍认）。
  // 两者都空 = 不看任何索引（页面上如实说明），不会静默回落到某个内置地址。
  const pluginIndexSources = () => {
    const cfg = getConfig().plugins || {};
    const sources = [];
    const push = (url, name) => {
      const target = String(url || '').trim();
      if (!target || sources.some((item) => item.url === target)) return;
      sources.push({ url: target, name: String(name || '').trim() });
    };
    for (const item of Array.isArray(cfg.indexUrls) ? cfg.indexUrls : []) {
      if (item && typeof item === 'object') push(item.url, item.name);
      else push(item, '');
    }
    // 旧单条配置（plugins.indexUrl）来的那条：如果它就是出厂的那份官方索引，名字就叫"官方索引"，
    // 否则叫"自定义索引" —— 页面上写着"索引来源：自定义索引"会让人以为缺省值被改过
    push(cfg.indexUrl, String(cfg.indexUrl || '').trim() === String(DEFAULT_CONFIG.plugins?.indexUrl || '').trim()
      ? '官方索引'
      : '自定义索引');
    return sources;
  };
  /** 镜像配置：默认用内置前缀列表；`plugins.mirrorPrefixes` 可以改成自己的（空数组＝只用原始地址）。 */
  const pluginMirrorConfig = () => {
    const configured = getConfig().plugins?.mirrorPrefixes;
    return { prefixes: Array.isArray(configured) ? configured : DEFAULT_MIRROR_PREFIXES };
  };

  const loadPluginIndex = async ({ applyRevocation = true } = {}) => {
    const sources = pluginIndexSources();
    const key = sources.map((item) => `${item.name}|${item.url}`).join(' ');
    if (!sources.length) {
      // 用户把索引来源清空（完全离线）：已移除来源的撤回规则不应继续生效。
      const before = indexRevokedRules().slice().sort().join('\n');
      indexRevokedCache.update({ sources: [], configured: [] });
      // 缓存也必须一起清：否则 10 分钟内把同一来源加回来时，下面那行缓存命中会直接返回
      // 旧结果、跳过 indexRevokedCache.update —— 撤回名单保持为空，kill switch 失效。
      pluginIndexCache = { key: '', at: 0, result: { plugins: [], skipped: [], sources: [] } };
      const after = indexRevokedRules().slice().sort().join('\n');
      if (applyRevocation && pluginsStarted && after !== before) {
        void pluginRegistry.reconfigure()
          .then(() => log('[plugins] 索引来源已清空，撤回名单已更新，插件已按新名单重排'))
          .catch((error) => log('[plugins] 按新撤回名单重排失败：', error?.message ?? error));
      }
      return { plugins: [], skipped: [], sources: [] };
    }
    if (pluginIndexCache.key === key && Date.now() - pluginIndexCache.at < 10 * 60_000) return pluginIndexCache.result;
    // 索引地址是用户填的 URL → 走 safe-fetch（内网/SSRF/体积/超时都在里面）
    // hostVersion 用于兼容门控（条目标了 minVersion 时判断本机够不够），不是网络参数
    // ⚠️ **索引不走第三方镜像**，只走你配置的那个地址（原始 raw 或你自己的地址）。
    // 因为索引是信任根：镜像能替换"该装什么"（塞一条它自己的插件 + 它自己的 sha256），
    // 而 sha256 只能证明"包与索引里写的一致"——索引被换掉时它救不了你。
    // 包则不同：包被 sha256 钉住，走镜像最多是"取不到"，不可能"取到假的还装上"（见 mirrors.js）。
    // 索引拉不动时的兜底：10 分钟缓存、页面明确报错、把 indexUrls 指向自己的 fork，
    // 以及 raw.githubusercontent.com 超时时自动换 GitHub Contents API（见 index-fetch.js；
    // 仍然只信任 GitHub，不经过第三方 CDN）。
    // 索引是结构化文件，会随条目增多长过网页那份 50KB 上限：给它单独的体积上限
    //（SSRF / 超时 / 重定向守卫仍是 safeFetch 那一套）
    const fresh = await fetchPluginIndexes({
      sources,
      // 原始地址 10 秒（被墙时别让页面干等 25 秒），API 兜底 15 秒；两者都是总截止
      fetchText: createIndexTextFetcher({
        fetchImpl: (url, options) => safeFetch(url, options),
        log: moduleLog('plugins')
      }),
      log: moduleLog('plugins'), hostVersion: PKG.version
    });
    // 拉不到就用上次成功读到的（见 indexResultForDisplay）：索引挂在第三方托管上，偶发超时是常态，
    // 而"这次没拉到"不该让市场变成空的。
    const result = indexResultForDisplay(fresh, lastGoodPluginIndex);
    if (Array.isArray(result.plugins) && result.plugins.length && !result.stale) {
      lastGoodPluginIndex = { at: Date.now(), result };
    }
    // 撤回名单只认**这次真拉到的**（拉不动沿用旧名单，见该函数注释）。
    // 名单变化要立刻反映到正在跑的插件上：启动时那次加载可能输给了 5 秒竞速（请求仍在后台跑），
    // 页面打开/定时刷新也可能在运行中拿到新名单 —— 只在下一轮 start 才生效等于 kill switch 失效。
    const rulesBefore = indexRevokedRules().slice().sort().join('\n');
    indexRevokedCache.update({
      ...fresh,
      // 显式告诉缓存"现在配置着哪些来源"：全部拉取失败时也能正确移除已删来源的规则。
      configured: sources.map((item) => String(item.url || item.name || ''))
    });
    const rulesAfter = indexRevokedRules().slice().sort().join('\n');
    if (applyRevocation && pluginsStarted && rulesAfter !== rulesBefore) {
      void pluginRegistry.reconfigure()
        .then(() => log('[plugins] 集中撤回名单有更新，插件已按新名单重排'))
        .catch((error) => log('[plugins] 按新撤回名单重排失败：', error?.message ?? error));
    }
    pluginIndexCache = { key, at: Date.now(), result };
    return result;
  };
  /**
   * 启动阶段取一次索引，只为拿到**集中撤回名单**：否则重启后只要没人打开插件页，
   * 被撤回的插件就会照常跑完整个进程生命周期（kill switch 形同虚设）。
   * 网络抖动不该拖慢启动：最多等 ms 毫秒，拉不到就按本地配置先起，定时刷新会补。
   */
  const warmPluginIndexForRevocation = async (ms = 5000) => {
    if (!pluginIndexSources().length) {
      // 无来源也要走一次 loadPluginIndex：它会清空已移除来源的撤回规则；否则重启后
      // 仍按上一次磁盘里的旧规则拒载插件（2026-10-19 复核 P2）。
      await loadPluginIndex().catch(() => 'failed');
      return 'no-source';
    }
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); timer.unref?.(); });
    try {
      return await Promise.race([
        loadPluginIndex().then(() => 'ok').catch(() => 'failed'),
        timeout
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  // 长期运行的进程也要能收到"后来才撤回"：每 6 小时刷一次，名单有变才重排（重排会重启插件进程）
  let pluginIndexRefreshTimer = null;
  const startPluginIndexRefresh = (everyMs = 6 * 60 * 60_000) => {
    if (pluginIndexRefreshTimer) return;
    pluginIndexRefreshTimer = setInterval(() => {
      if (getConfig().plugins?.enabled !== true) return;
      const before = [...indexRevokedRules()].sort().join('\n');
      // applyRevocation:false：定时器自己比较前后并只重排一次。loadPluginIndex 内部默认
      // 也会重排，叠加起来会让所有插件被完整重启两遍。
      void loadPluginIndex({ applyRevocation: false }).then(() => {
        const after = [...indexRevokedRules()].sort().join('\n');
        if (after === before) return null;
        return pluginRegistry.reconfigure()
          .then(() => log('[plugins] 集中撤回名单有更新，插件已按新名单重排'));
      }).catch((error) => log('[plugins] 索引刷新失败（沿用现有名单）：', error?.message ?? error));
    }, Math.max(60_000, Number(everyMs) || 0));
    pluginIndexRefreshTimer.unref?.();
  };
  const stopPluginIndexRefresh = () => {
    if (pluginIndexRefreshTimer) clearInterval(pluginIndexRefreshTimer);
    pluginIndexRefreshTimer = null;
  };
  // 知识库 / 梗库 / MCP 路由（按域拆到 routes/；注册位置保持原顺序）
  registerKnowledgeRoutes(router, { json, readBody, getConfig });
  registerMemeRoutes(router, { json, readBody });
  registerMcpRoutes(router, { json, mcpManager });
  registerPluginRoutes(router, {
    json, readBody, getConfig, updateConfig, auditWrite, log, dataDir: DATA_DIR,
    hostVersion: PKG.version, pluginRegistry,
    loadIndex: (options) => loadPluginIndex(options),
    invalidateIndex: () => { pluginIndexCache = { key: '', at: 0, result: { plugins: [], skipped: [], sources: [] } }; },
    mirrorConfig: pluginMirrorConfig, pluginLog: moduleLog('plugins')
  });

  // 技能路由（skills/market 必须先于 :id 注册，顺序由模块内部保证）
  registerSkillRoutes(router, { json, readBody, getConfig, updateConfig, auditWrite, emit });

  registerMemoryRoutes(router, { json, readBody, getConfig, memory, orchestrator, emit });

  // 长期语义记忆（scope 归一化与路由都在模块内）
  registerLivingMemoryRoutes(router, { json, readBody, getConfig, livingMemory, emit, auditWrite });

  registerProviderRoutes(router, {
    json, readBody, getConfig, auditWrite,
    keyEndpointAllowed, storedKeyAllowedFor, sanitizeProvider,
    asrInstallSnapshot, removeLocalAsrFiles, startAsrInstall,
    getAsrRunning: () => asrInstall.running, log
  });

  router.add('POST', '/api/vision/scan', async (req, res) => {
    // 读体放在守卫**之前**：检查与置位之间有 await 时，两个并发请求会双双通过 409 守卫、
    // 把要花钱的模型探测跑两遍并交错覆盖结果（2026-10-03 全量审查）。顺序与 /api/memory-files/consolidate 一致。
    const body = await readBody(req).catch(() => ({}));
    if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
    const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
    visionScan.running = true;
    emit('vision-scan', { phase: 'start' });
    scanModelsVision({
      providers: currentProviders(),
      emit,
      onlyProviderIds,
      timeoutMs: 25000,
      limit: 3
    })
      .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
      .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
      .finally(() => { visionScan.running = false; });
    return json(res, 202, { ok: true, started: true });
  });
  registerMediaSettingsRoutes(router, { json, readBody, getConfig, keyEndpointAllowed });

  registerPriceRoutes(router, {
    json, readBody, getConfig, updateConfig, auditWrite, modelPricesPayload
  });

  registerOnebotRoutes(router, { json, getConfig, onebot });

  registerPersonaRoutes(router, {
    json, readBody, getConfig, updateConfig, keyEndpointAllowed, store, memory, orchestrator, log
  });

  registerSearchRoutes(router, { json, readBody, getConfig, updateConfig });

  router.add('POST', '/api/test/api', async (req, res) => {
    const startedAt = Date.now();
    try {
      const r = await chatCompletion({
        messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
        tools: null,
        temperature: 0
      });
      const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
      return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
    } catch (error) {
      return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
    }
  });

  router.add('GET', '/api/humanize/state', async (req, res, params, url) => {
    const chatKey = String(url?.searchParams?.get('chatKey') || '').trim();
    const cfg = getConfig();
    const persona = resolvePersona(cfg, chatKey);
    return json(res, 200, {
      ...personaStateSnapshot(persona),
      persona: persona.botName || '',
      chatKey
    });
  });
  registerStatusRoutes(router, {
    json, getConfig, sessions, onebot, orchestrator, incidentPilotStatus,
    effects, uiDir: UI_DIR, version: PKG.version, getConfigConflict,
    buildUsageStats, buildUsageBreakdown
  });

  registerConfigRoutes(router, {
    json, readBody, getConfig, updateConfig, auditWrite, emit, log,
    store, orchestrator, sessions, mcpManager, pluginRegistry,
    dailyMoments, lifeFeed, qzoneInteractions, groupDigest, adminBriefing,
    safeConfigWithAsrStatus,
    syncIncidentPilot, syncIdentityPilot, syncSlangPilot,
    getConfigConflict, getBoundServerHost: () => boundServerHost,
    dataDir: DATA_DIR, configLog: moduleLog('config'), mcpLog: moduleLog('mcp'), stableJson
  });

  // 群游戏结束 / 群日报 / 管理员早报 / 提醒 管理
  registerManagerRoutes(router, { json, readBody, auditWrite, getConfig, groupGame, groupDigest, adminBriefing, reminders });

  // 生活层（见闻）
  registerLifeFeedRoutes(router, { json, readBody, lifeFeed, auditWrite, orchestrator });

  // 数据备份/恢复（队列与维护状态都在模块内）
  registerBackupRoutes(router, { json, readBody, auditWrite });

  router.add('GET', '/api/group-policy', async (req, res) => {
    const cfgNow = getConfig();
    const gameChats = new Set((cfgNow.groupGame?.chats || []).map((id) => `group:${id}`));
    const rows = store.listChats()
      .filter((key) => String(key).startsWith('group:'))
      .map((chatKey) => ({
        chatKey,
        allowed: chatAllowed(chatKey, cfgNow),
        randomPercent: Number(storeConfigForChat(chatKey)?.randomPercent) || 0,
        conversationMode: conversationConfigForChat(chatKey).mode,
        timeControl: timeControlState(cfgNow.timeControl, chatKey),
        groupGame: gameChats.has(chatKey),
        dailyMoments: cfgNow.dailyMoments?.enabled === true
      }));
    return json(res, 200, { ok: true, rows });
  });

  router.add('GET', '/api/incidents', async (req, res, params, url) => {
    return json(res, 200, {
      status: incidentPilotStatus(),
      incidents: incidentPilot?.list({
        state: url.searchParams.get('state') || '',
        severity: url.searchParams.get('severity') || '',
        chatKey: url.searchParams.get('chatKey') || '',
        query: url.searchParams.get('query') || '',
        limit: url.searchParams.get('limit') || 100
      }) || []
    });
  });
  router.add('GET', '/api/slang-pilot/discoveries', async (req, res, params, url) => {
    if (!slangPilot?.active) {
      return json(res, 409, { error: '黑话语料库试点未启用' });
    }
    return json(res, 200, {
      status: slangPilot.status(),
      discoveries: slangPilot.list({
        state: url.searchParams.get('state') || '',
        query: url.searchParams.get('query') || '',
        limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      })
    });
  });
  router.add('GET', '/api/identity-pilot/people', async (req, res, params, url) => {
    if (!identityPilot?.active) {
      return json(res, 409, { error: '统一身份库未启用' });
    }
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    return json(res, 200, {
      status: identityPilot.status(),
      people: identityPilot.listPeople(limit)
    });
  });
  router.add('GET', '/api/identity-pilot/incoming-friend-requests', async (req, res, params, url) => {
    if (
      !identityPilot?.active
      || getConfig().identityPilot?.incomingFriendRequest?.enabled !== true
    ) {
      return json(res, 409, { error: '入站好友请求审批功能未启用' });
    }
    return json(res, 200, {
      status: identityPilot.status(),
      requests: identityPilot.listIncomingFriendRequests({
        status: url.searchParams.get('status') || '',
        limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      })
    });
  });
  router.add('GET', '/api/identity-pilot/friend-proposals', async (req, res, params, url) => {
    if (!identityPilot?.active || getConfig().identityPilot?.friendProposal?.enabled !== true) {
      return json(res, 409, { error: '主动好友候选功能未启用' });
    }
    return json(res, 200, {
      status: identityPilot.status(),
      proposals: identityPilot.listFriendProposals({
        status: url.searchParams.get('status') || '',
        limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      })
    });
  });
  router.add('GET', '/api/identity-pilot/friend-opportunities', async (req, res, params, url) => {
    if (!identityPilot?.active || getConfig().identityPilot?.friendProposal?.enabled !== true) {
      return json(res, 409, { error: '主动好友候选功能未启用' });
    }
    return json(res, 200, {
      status: identityPilot.status(),
      opportunities: identityPilot.listFriendOpportunities({
        status: url.searchParams.get('status') || '',
        limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      })
    });
  });
  router.add('POST', '/api/qzone-interactions/run', async (req, res) => {
    const body = await readBody(req);
    if (body.confirm !== true) {
      return json(res, 409, { error: '手动执行动态互动需要显式确认' });
    }
    try {
      return json(res, 200, await qzoneInteractions.runNow(String(body.kind || 'all')));
    } catch (error) {
      return json(
        res,
        error.httpStatus || (error.code === 'TIME_CONTROL_INACTIVE' ? 409 : 500),
        { error: String(error?.message ?? error), code: error.code || '' }
      );
    }
  });
  router.add('GET', '/api/time-control/status', async (req, res) => {
    const cfgNow = getConfig();
    const now = Date.now();
    const keys = [...new Set([
      ...store.listChats(),
      ...idList(cfgNow.allow?.groups).map((id) => `group:${id}`),
      ...idList(cfgNow.allow?.private).map((id) => `private:${id}`),
      ...Object.keys(cfgNow.timeControl?.overrides || {})
    ])];
    return json(res, 200, {
      timeZone: TIME_ZONE, now,
      global: timeControlState(cfgNow.timeControl, '', now),
      chats: keys.map((chatKey) => ({
        chatKey, ...timeControlState(cfgNow.timeControl, chatKey, now)
      }))
    });
  });
  router.add('POST', '/api/daily-moments/run', async (req, res) => {
    const body = await readBody(req);
    if (body.publish === true && body.confirm !== true) {
      return json(res, 409, { error: '发布说说需要显式确认' });
    }
    try {
      const result = await dailyMoments.runNow({
        ...(body.dayKey ? { dayKey: String(body.dayKey) } : {}),
        publish: body.publish === true,
        force: body.force === true,
        confirmDuplicateRisk: body.confirmDuplicateRisk === true
      });
      return json(res, 200, result);
    } catch (error) {
      return json(res, error.httpStatus || (error.code === 'TIME_CONTROL_INACTIVE' ? 409 : 500), {
        error: String(error?.message ?? error), code: error.code || ''
      });
    }
  });
  registerSessionRoutes(router, {
    json, readBody, emit, getConfig, sessions, store, orchestrator, buildSessionView,
    getIncidentPilot: () => incidentPilot, getSlangPilot: () => slangPilot
  });

  router.add('DELETE', /^\/api\/persona-templates\/(custom_\d+)$/, async (req, res, params) => {
    const idx = Number(params[1].replace('custom_', ''));
    const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
    updateConfig({ customPersonas: next });
    return json(res, 200, { ok: true });
  });
  router.add('GET', /^\/api\/incidents\/(inc_[a-f0-9]{16})$/i, async (req, res, params) => {
    const incident = incidentPilot?.get(params[1]);
    return incident
      ? json(res, 200, { incident })
      : json(res, 404, { error: '异常日志不存在' });
  });
  router.add('DELETE', /^\/api\/incidents\/(inc_[a-f0-9]{16})$/i, async (req, res, params) => {
    const body = await readBody(req);
    if (body.confirm !== true) {
      return json(res, 409, { error: '删除异常日志需要显式确认' });
    }
    try {
      return incidentPilot?.delete(params[1])
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: '异常日志不存在' });
    } catch (error) {
      return json(res, error?.httpStatus || 409, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/identity-pilot\/friend-proposals\/(fp_[a-f0-9]{12})\/decision$/i, async (req, res, params) => {
    if (!identityPilot?.active || getConfig().identityPilot?.friendProposal?.enabled !== true) {
      return json(res, 409, { error: '主动好友候选功能未启用' });
    }
    const body = await readBody(req);
    if (!['approve', 'reject'].includes(body.decision)) {
      return json(res, 400, { error: 'decision 必须是 approve 或 reject' });
    }
    try {
      const result = await identityPilot.decideFriendProposal(
        params[1],
        body.decision,
        { decidedBy: 'console' }
      );
      emit('identity-pilot-update', identityPilot.status());
      return json(res, 200, result);
    } catch (error) {
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/daily-moments\/records\/([\w-]+)\/edit$/, async (req, res, params) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const result = await dailyMoments.editDraft(params[1], { content: body.content });
      auditWrite('moments.edit', `moments:${params[1]}`, { req, length: String(body.content || '').length });
      return json(res, 200, { ok: true, content: result.record.content });
    } catch (error) {
      return json(res, error.httpStatus || 500, { error: String(error?.message ?? error), code: error.code || '' });
    }
  });

  router.add('POST', /^\/api\/daily-moments\/records\/([\w-]+)\/(publish|reconcile|resolve)$/, async (req, res, params) => {
    const body = await readBody(req);
    if (params[2] === 'publish' && body.confirm !== true) {
      return json(res, 409, { error: '发布草稿需要显式确认' });
    }
    if (params[2] === 'resolve' && body.confirm !== true) {
      return json(res, 409, { error: '人工核对结果需要显式确认' });
    }
    try {
      const result = params[2] === 'publish'
        ? await dailyMoments.publishDraft(params[1], {
            force: body.force === true,
            confirmDuplicateRisk: body.confirmDuplicateRisk === true
          })
        : params[2] === 'resolve'
          ? await dailyMoments.resolveRecord(params[1], { result: body.result })
          : await dailyMoments.reconcile(params[1]);
      return json(res, 200, result);
    } catch (error) {
      return json(res, error.httpStatus || (error.code === 'TIME_CONTROL_INACTIVE' ? 409 : 500), {
        error: String(error?.message ?? error), code: error.code || ''
      });
    }
  });
  router.add('GET', /^\/api\/sessions\/([\w-]+)$/, async (req, res, params) => {
    const s = sessions.get(params[1]);
    if (!s) return json(res, 404, { error: '会话不存在' });
    return json(res, 200, buildSessionView(s, store));
  });

  registerOutboxRoutes(router, { json, readBody, store, effects, auditWrite, emit });
  router.add('POST', /^\/api\/incidents\/(inc_[a-f0-9]{16})\/(acknowledge|resolve)$/i, async (req, res, params) => {
    const body = await readBody(req);
    try {
      const incident = params[2] === 'acknowledge'
        ? incidentPilot?.acknowledge(params[1])
        : incidentPilot?.resolve(params[1], body.resolution);
      return incident
        ? json(res, 200, { ok: true, incident })
        : json(res, 404, { error: '异常日志不存在' });
    } catch (error) {
      return json(res, error?.httpStatus || 409, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', /^\/api\/slang-pilot\/discoveries\/(sr_[a-f0-9]{12})$/i, async (req, res, params) => {
    if (!slangPilot?.active) {
      return json(res, 409, { error: '黑话语料库试点未启用' });
    }
    const discovery = slangPilot.detail(params[1]);
    return discovery
      ? json(res, 200, { discovery })
      : json(res, 404, { error: '黑话发现不存在' });
  });
  router.add('POST', /^\/api\/slang-pilot\/discoveries\/(sr_[a-f0-9]{12})\/research-decision$/i, async (req, res, params) => {
    if (!slangPilot?.active) {
      return json(res, 409, { error: '黑话语料库试点未启用' });
    }
    const body = await readBody(req);
    if (!['approve', 'reject'].includes(body.decision)) {
      return json(res, 400, { error: 'decision 必须是 approve 或 reject' });
    }
    try {
      return json(res, 200, slangPilot?.decideResearch(
        params[1],
        body.decision,
        { decidedBy: 'console', expectedVersion: body.expectedVersion }
      ));
    } catch (error) {
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/slang-pilot\/discoveries\/(sr_[a-f0-9]{12})\/admission-decision$/i, async (req, res, params) => {
    if (!slangPilot?.active) {
      return json(res, 409, { error: '黑话语料库试点未启用' });
    }
    const body = await readBody(req);
    if (!['approve', 'reject'].includes(body.decision)) {
      return json(res, 400, { error: 'decision 必须是 approve 或 reject' });
    }
    try {
      return json(res, 200, slangPilot?.decideAdmission(
        params[1],
        body.decision,
        {
          decidedBy: 'console',
          expectedVersion: body.expectedVersion,
          edits: body.edits || {}
        }
      ));
    } catch (error) {
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/identity-pilot\/incoming-friend-requests\/(fr_[a-f0-9]{12})\/decision$/i, async (req, res, params) => {
    if (
      !identityPilot?.active
      || getConfig().identityPilot?.incomingFriendRequest?.enabled !== true
    ) {
      return json(res, 409, { error: '入站好友请求审批功能未启用' });
    }
    const body = await readBody(req);
    if (!['approve', 'reject'].includes(body.decision)) {
      return json(res, 400, { error: 'decision 必须是 approve 或 reject' });
    }
    try {
      const result = await identityPilot.decideIncomingFriendRequest(
        params[1],
        body.decision,
        {
          decidedBy: 'console',
          remark: String(body.remark || '')
        }
      );
      emit('identity-pilot-update', identityPilot.status());
      return json(res, 200, result);
    } catch (error) {
      return json(res, error?.httpStatus || 409, {
        error: String(error?.message ?? error)
      });
    }
  });

  router.add('POST', /^\/api\/slang-pilot\/discoveries\/(sr_[a-f0-9]{12})\/retry$/i, async (req, res, params) => {
    if (!slangPilot?.active) {
      return json(res, 409, { error: '黑话语料库试点未启用' });
    }
    try {
      return json(res, 200, slangPilot?.retryResearch(
        params[1],
        { decidedBy: 'console' }
      ));
    } catch (error) {
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });

  async function handleHttp(req, res) {
    // 全部 API 路由都在路由表里；未命中的 /api/ 由表的 fallthrough 回 404（文案与旧一致）
    if (await router.handle(req, res)) return;
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;

    // 静态 UI
    if (req.method === 'GET') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const stat = fs.statSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        let body = fs.readFileSync(fullPath);
        let etag;
        let cacheControl = 'no-cache';
        const askedToken = new URL(req.url, 'http://127.0.0.1').searchParams.get('v') || '';
        if (ext === '.html') {
          // 下发的 HTML 里把自家脚本/样式换成带**内容哈希**的 URL；ETag 取改写后的字节 ——
          // 这样"某个脚本变了、HTML 自己没变"也会换 ETag，浏览器不会攥着旧 HTML 里的旧令牌不放。
          body = Buffer.from(rewriteAssetUrls(body.toString('utf8')));
          etag = `W/"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
        } else {
          const token = assetToken(fullPath);
          if (URL_TOKENIZED.has(ext) && askedToken && askedToken === token) {
            // 令牌对得上 = 这个 URL 的内容是不可变的：长缓存，别再回源。
            cacheControl = 'public, max-age=31536000, immutable';
            etag = `"${token}"`;   // 强 ETag（内容哈希）
          } else {
            // 其余情况一律回源校验：内容哈希做**强** ETag（比体积+时间可靠），
            // cache-control 保持 no-cache —— 每次都会带 If-None-Match 问一句，没变就是 304。
            // js 走的永远是这一支（见 URL_TOKENIZED 的注释：模块 URL 必须唯一）。
            etag = `"${token}"`;
          }
        }
        // 真 304：此前只发了 ETag/Last-Modified 却从不判 If-None-Match，于是 no-cache 强制回源
        // 而每次都是 200 + 全文 —— 实测每开一次控制台就把 30 个脚本整个重下一遍。
        // HTML 只认 If-None-Match（它的 ETag 是改写后内容的哈希）；其余文件两种校验都认。
        const inm = String(req.headers['if-none-match'] || '');
        const matched = inm
          ? inm.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}` || `W/${t.trim()}` === etag)
          : (ext !== '.html' && String(req.headers['if-modified-since'] || '') !== ''
            && Date.parse(req.headers['if-modified-since']) >= Math.floor(stat.mtimeMs / 1000) * 1000);
        const securityHeaders = {
          // 控制台可被本机无令牌模式打开：禁止被第三方页面 iframe 嵌入，防点击劫持。
          'x-frame-options': 'DENY',
          'content-security-policy': "frame-ancestors 'none'",
          'referrer-policy': 'no-referrer'
        };
        if (matched) {
          // 304 也要带安全头：否则升级前缓存过 index.html 的浏览器会一直复用旧响应，防护不生效。
          res.writeHead(304, { ...securityHeaders, etag, 'cache-control': cacheControl });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': types[ext] ?? 'application/octet-stream',
          'cache-control': cacheControl,
          ...securityHeaders,
          etag,
          'last-modified': stat.mtime.toUTCString()
        });
        res.end(body);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, getConfig().server?.host || '127.0.0.1', () => {
        server.off('error', reject);
        boundServerHost = String(getConfig().server?.host || '127.0.0.1');
        resolve(port);
      });
    });
  }

  async function start() {
    const serverCfg = getConfig().server;
    if (!['127.0.0.1', 'localhost', '::1'].includes(serverCfg.host) && !serverCfg.token) {
      throw new Error('控制台绑定到非回环地址时必须设置 server.token（控制台令牌），否则远程访问无法鉴权');
    }
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + (serverCfg.strictPort === false ? 10 : 1); p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');
    // 抢到端口才说明是唯一在跑的本实例：此时上一条命留下的 planned 不可能还在执行。
    // 不等 15 分钟 TTL，否则重启落在发送窗口内会让日报/游戏播报被当成 in-flight 跳过当天。
    // 这些都是一次性清扫：瞬时 SQLITE_BUSY/磁盘抖动只应推迟清扫，不能阻止服务启动。
    try {
      effects.markStalePlanned({ olderThanMs: 0, minAgeMs: 0 });
      effects.prune();
      // 上一条命在发送途中退出：sending 行收口成 unknown，进入人工核对清单。
      const staleSending = store.markStaleSendingUnknown();
      if (staleSending) log(`[outbox] ${staleSending} 条上次进程遗留的 sending 已标记为 unknown`);
      const staleLeases = store.failLeasedRunsAtStartup();
      if (staleLeases) log(`[runs] ${staleLeases} 条上次进程遗留的 leased run 已收口`);
      // 上一次进程如果在富化途中退出，deferred 消息会留在库里：按占位符放行，
      // 让恢复循环把它们当普通未读处理，别让它们永远不可见（Issue #85）。
      if (ingestAbort.signal.aborted) ingestAbort = new AbortController();
      ingestStopping = false;
      const staleDeferred = store.releaseStaleDeferred();
      if (staleDeferred.length) {
        log(`[ingest] 启动释放 ${staleDeferred.length} 个会话里未完成富化的消息（按占位符处理）`);
      }
    } catch (error) {
      log('[start] 启动清扫失败（不影响启动，恢复循环会继续重试）：', error?.message ?? error);
    }

    await onebot.connect();
    if (
      incidentPilotEnabled()
      || fs.existsSync(incidentDatabasePath(DATA_DIR))
    ) {
      try {
        syncIncidentPilot();
      } catch (error) {
        log(`[incident-pilot] 启动失败，聊天主流程继续：${error?.message ?? error}`);
      }
    }
    if (identityPilotEnabled()) {
      try {
        await syncIdentityPilot();
      } catch (error) {
        log(`[identity-pilot] 启动失败，聊天主流程继续：${error?.message ?? error}`);
      }
    }
    if (slangPilotEnabled()) {
      try {
        await syncSlangPilot();
      } catch (error) {
        log(`[slang-pilot] 启动失败，聊天主流程继续：${error?.message ?? error}`);
      }
    }
    refreshTimeControl();
    orchestrator.startRecoveryLoop();
    orchestrator.startReminderLoop();
    if (getConfig().dailyMoments?.enabled) dailyMoments.start();
    if (getConfig().lifeFeed?.enabled) lifeFeed.start();
    if (getConfig().qzoneInteractions?.enabled) qzoneInteractions.start();
    if (getConfig().groupDigest?.enabled) groupDigest.start();
    if (getConfig().adminBriefing?.enabled) adminBriefing.start();
    groupGame.startLoop();   // 内部按配置判断是否推进；重启后从磁盘恢复进行中的局
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startScheduledWakeTicker();
    // 插件宿主：起插件子进程（隔离不可用时按配置**拒绝加载**，理由写进日志与巡检）。
    // 放在最后、且失败只记日志：插件是第三方扩展，它起不来不该影响控制台与机器人本体。
    // 先取一次索引（只为撤回名单）：加载前拿到，才能保证"重启后没人打开插件页也挡得住"。
    try {
      if (getConfig().plugins?.enabled === true) {
        const warmed = await warmPluginIndexForRevocation();
        if (warmed !== 'ok') log(`[plugins] 启动时未能读取索引（${warmed}），先按本地配置加载，稍后自动重试`);
      }
    } catch (error) {
      log('[plugins] 启动时读取索引失败（继续按本地配置加载）：', error?.message ?? error);
    }
    try {
      const rulesBeforeStart = [...indexRevokedRules()].sort().join('\n');
      await pluginRegistry.start();
      pluginsStarted = true;
      // 暖加载可能恰好在 start 期间完成（pluginsStarted 还是 false，那次没有触发重排）：
      // 启动完成后再比一次，名单变了就按新名单重排
      const rulesAfterStart = [...indexRevokedRules()].sort().join('\n');
      if (rulesAfterStart !== rulesBeforeStart) {
        await pluginRegistry.reconfigure().catch(() => {});
      }
    } catch (error) {
      log('[plugins] 插件宿主启动失败：', error);
    }
    startPluginIndexRefresh();
    // 技能市场索引预热（不阻塞启动）：GitHub raw 偶发 20 秒超时，第一次打开市场不该替它买单。
    // 测试集会设 QQ_AGENT_SKIP_INDEX_WARM=1，避免每个 createApp().start() 都打外网。
    if (process.env.QQ_AGENT_SKIP_INDEX_WARM !== '1') void warmMarketIndex().catch(() => {});
    if (isContainerRuntime()) {
      log('[auto-update] 容器模式：应用与协议端都由镜像管理，跳过自动更新通知器与协议端定时器');
    } else {
      autoUpdate.start();
      // 协议端自动更新：首检延迟 2 分钟（别跟启动抢 IO），之后每 6 小时一轮；开关默认关
      clearTimeout(snowlumaAutoTimer);
      snowlumaAutoStopped = false;
      snowlumaAutoTimer = setTimeout(() => { snowlumaAutoCheck({ first: true }); }, 120_000);
      snowlumaAutoTimer.unref?.();
    }
    log(`控制台已就绪：http://${serverCfg.host}:${port} (${getConfig().runtime.mode})`);
    log(`OneBot: ws=${getConfig().onebot?.wsUrl} http=${getConfig().onebot?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    try {
      pluginsStarted = false;
      // 先关闭入站入口，再 abort：否则停服过程中到达的事件会在等待快照之后
      // 再入队，store.close() 时撞上已关闭的数据库。
      ingestStopping = true;
      // 先中止入站富化：还在等协议端下载的后台任务应立即按占位符收尾，
      // 否则 stop 会陪它们等完整个预算（Issue #85）。
      ingestAbort.abort();
    // 安装脚本别被落下：进程重启/停服时它是孤儿进程，会一直占着构建目录。
    // 只 kill 包装进程不够：它 spawnSync 出来的 cmake/make 会活下来继续写构建目录、与下一次安装并发
    // （超时那条路径早就按进程组杀了，这里同款处理，2026-09-26 审查）。
    if (asrChild) {
      const child = asrChild;
      asrChild = null;                 // 先摘掉：被杀的 child 的 close 事件不该再改状态
      asrInstall.running = false;      // 同进程重启时别把"正在安装"的标记带到下一条命
      asrInstall.phase = '已中止（服务停止）';
      killTreeOf(child);
    }
    clearTimeout(timeControlTimer);
    clearTimeout(catchUpTimer);
    catchUpTimer = null;
    clearInterval(freshnessTimer);
    clearInterval(sseHeartbeat);
    snowlumaAutoStopped = true;
    clearTimeout(snowlumaAutoTimer);
    stopPluginIndexRefresh();
    releaseTimeControl();
    // Phase 1：先停所有会产生新工作的调度器（不要在这里关 transport/store）。
    dailyMoments.stop();
    lifeFeed.stop();
    qzoneInteractions.stop();
    // 群游戏/群日报的定时器也要停：store.close() 之后它们还在 tick 会撞已关闭的 sqlite，
    // 且群游戏 tick 会把 games.json 再写一遍（2026-10-07 复审 P3）。
    groupGame.stopLoop();
    groupDigest.stop();
    adminBriefing.stop();
    // Phase 2：并行收尾各 manager 的在途任务；8 秒总上限，单个卡死不能拖垮退出。
    const identityStop = identityPilot?.stop();
    identityPilot = null;
    await settleWithDeadline([
      dailyMoments.abort(), lifeFeed.drain(), qzoneInteractions.abort(), groupGame.drain(),
      groupDigest.drain(), adminBriefing.drain(), autoUpdate.stop(), identityStop
    ], 8000);

    // Phase 3：先停子进程，再中止对话 run；orchestrator 必须在 onebot.close() 之前收尾。
    // 插件子进程要在 onebot 关闭之前停掉：停机后不该再有插件在读消息。
    await pluginRegistry.stop();
    await settleWithDeadline([mcpManager.close()], 5000);
    await settleWithDeadline([orchestrator.abortAll()], 5000);   // 等 runTasks 收官，但别让 25s 强杀跳过 Phase 4
    // 对话 run 可能还在用 living-memory；等它们结束后再关库。
    await settleWithDeadline([livingMemory.drain()], 5000);
    await settleWithDeadline([slangPilot?.stop()], 3000);
    slangPilot = null;
    await settleWithDeadline([incidentPilot?.stop()], 5000);
    incidentPilot = null;

    // Phase 4：发送队列是 appendSelf/onSent 的最后一道屏障，必须在 store.close() 前 drain。
    await sender.drain({ timeoutMs: 3000 });
    onebot.close();
    // 等待所有在途入站/富化收尾。用循环重新取集合而不是一次快照：正在收尾的 ingress
    // 任务可能在 await 期间又入队一条 deferred（Issue #85 停服竞态）。
    for (let round = 0; round < 100; round += 1) {
      const pending = [...ingress.values(), ...deferredIngestTasks];
      if (!pending.length) break;
      await Promise.allSettled(pending);
      if (!ingress.size && !deferredIngestTasks.size) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const client of sseClients) client.end();
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        done();
      }, 2000);
      server.close(done);
      server.closeIdleConnections?.();
    });
    memory.close();
      store.close();
    } finally {
      // 锁释放放到最后：store/session/插件都收尾完，新实例才能起来写同一目录。
      instanceLock?.release();
      instanceLock = null;
    }
  }

  return {
    server,
    onebot,
    store,
    memory,
    livingMemory,
    stickers,
    sender,
    sessions,
    orchestrator,
    dailyMoments,
    lifeFeed,
    qzoneInteractions,
    assetObserver,
    autoUpdate,
    // 用 getter/setter（而不是普通属性）：测试与运维可以整体替换更新器，
    // 路由闭包读的就是同一个变量（app.onebot 那类注入点同理）
    get snowlumaUpdater() { return snowlumaUpdater; },
    set snowlumaUpdater(next) { snowlumaUpdater = next; },
    get incidentPilot() { return incidentPilot; },
    incidentPilotStatus,
    // 每日台账保留期清理的任务清单（server.js 的 core/ledger-retention.js 调度用）
    retentionPruneTargets,
    snowlumaBaselineAlign,
    captureIncident(error, context = {}) {
      return incidentPilot?.capture(error, context) || null;
    },
    get identityPilot() { return identityPilot; },
    identityPilotStatus,
    get slangPilot() { return slangPilot; },
    slangPilotStatus,
    start,
    stop,
    emit,
    getConfig,
    updateConfig,
    // 外部模块注册控制台路由的唯一入口（改进方案 #2 / J.1 的例外路由收口）：
    // 与内部路由共享同一套鉴权（auth 默认 true）、405 与未命中 404 语义。
    addRoute(method, routePath, handler, opts) { router.add(method, routePath, handler, opts); },
    // 路由清单快照（getRoutes 与 addRoute 同一口径）：结构拆分时用它证明"注册集合没变"。
    listRoutes() { return router.listRoutes(); },
    // 外部模块写审计（#5）：例外路由（manual-friend-review）用它留痕，语义与内部埋点一致
    // （旁路、脱敏、永不抛；见 core/audit-log.js）。
    auditWrite
  };
}

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    return { mode: 'today', start: shanghaiDayStart(now), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  if (s === 'all') {
    // 「全部」档：从最早记录算起（start=0 让文件预筛收下所有记录）。UI 的「全部」按钮
    // 此前落进下面的 Number('all')||7，标签和数据都变成"最近 7 天"（2026-10-12 审查）。
    return { mode: 'all', start: 0, end: now, label: '全部' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按上海自然日：从 N-1 天前的 00:00 算起。
  return {
    mode: 'days',
    start: shanghaiDayStart(now) - (n - 1) * 24 * 60 * 60 * 1000,
    end: now,
    label: `最近 ${n} 天`
  };
}

/** 上海时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  return todayKey(ts);
}

/** 把一个 Session 展开为与用量页完全相同的逐调用计价行。 */
function usageRowsForSession(s) {
  const started = Number(s?.startedAt) || 0;
  if (!started) return [];
  const base = {
    vendor: String(s.vendor || '').trim() || UNKNOWN_VENDOR,
    chatKey: String(s.chatKey || '(未知)'),
    sessionId: s.id
  };
  const calls = [];
  for (const m of (s.messages || [])) {
    const raw = m?.raw;
    if (!raw || typeof raw !== 'object') continue;
    const ru = raw.usage || {};
    const promptTokens = Number(ru.prompt_tokens) || 0;
    const completionTokens = Number(ru.completion_tokens) || 0;
    if (!promptTokens && !completionTokens) continue;
    calls.push({
      ...base,
      promptTokens,
      completionTokens,
      cachedTokens: cachedTokensOfUsage(ru),
      at: Number(raw.created) ? Number(raw.created) * 1000 : started,
      model: String(raw.model || s.model || '') || '(未知)',
      exact: true
    });
  }
  const rows = calls.length ? calls : (() => {
    const usage = s.usage || {};
    const promptTokens = Number(usage.promptTokens) || 0;
    const completionTokens = Number(usage.completionTokens) || 0;
    if (!promptTokens && !completionTokens) return [];
    return [{
      ...base,
      promptTokens,
      completionTokens,
      cachedTokens: Number(usage.cachedTokens) || 0,
      at: started,
      model: String(s.model || '') || '(未知)',
      exact: false
    }];
  })();
  return rows.map((row) => ({
    ...row,
    modelKey: modelLabel(row.vendor, row.model)
  }));
}

/** Session 详情使用的全局指标；成本与用量页共用同一计价函数。 */
function buildSessionMetrics(s) {
  const usage = s?.usage || {};
  const calls = Array.isArray(s?.callUsage) ? s.callUsage : [];
  const promptTokens = Number(usage.promptTokens) || 0;
  const completionTokens = Number(usage.completionTokens) || 0;
  const cachedTokens = Math.min(promptTokens, Number(usage.cachedTokens) || 0);
  const first = calls[0] || {};
  const firstPromptTokens = Number(first.promptTokens) || 0;
  const firstCachedTokens = Math.min(
    firstPromptTokens,
    Number(first.cachedTokens) || 0
  );
  const priced = costOfRows(usageRowsForSession(s));
  return {
    modelCalls: Number(usage.calls) || calls.length,
    firstCallCacheHitRate: firstPromptTokens ? firstCachedTokens / firstPromptTokens : 0,
    cacheHitRate: promptTokens ? cachedTokens / promptTokens : 0,
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: Number(usage.totalTokens) || promptTokens + completionTokens,
    toolCalls: (s?.messages || []).filter((message) => message?.toolCall).length,
    webSearchCount: Number(s?.webSearchCount) || 0,
    estimatedCost: priced.cost,
    costBreakdown: priced.breakdown,
    exactCostCalls: priced.exactCalls,
    unpricedCalls: priced.unpricedCalls || 0,
    // 包月/本地也要带给会话上下文面板：只有 unpriced 会漏掉"这次是按月付/不计费"
    flatCalls: priced.flatCalls || 0,
    localCalls: priced.localCalls || 0
  };
}

function lifecycleDeadline(thread) {
  if (!thread) return 0;
  if (thread.state === 'rollover_armed') {
    return Number(thread.resumeArmedUntil) || Number(thread.expiresAt) || 0;
  }
  const deadlines = [
    Number(thread.idleDeadline) || 0,
    Number(thread.hardDeadline) || 0,
    Number(thread.expiresAt) || 0
  ].filter((value) => value > 0);
  return deadlines.length ? Math.min(...deadlines) : 0;
}

function sessionLifecycleView(s, store, {
  now = Date.now(),
  threadCache = new Map()
} = {}) {
  if (s?.conversationMode !== 'lifecycle') return null;
  const chatKey = String(s.chatKey || '');
  const threadId = String(s.threadId || '');
  if (!threadId) {
    return {
      threadId: '',
      state: ['waiting', 'running'].includes(s.status) ? 'starting' : 'closed',
      disposition: '',
      openedAt: Number(s.threadOpenedAt) || 0,
      idleDeadline: 0,
      hardDeadline: 0,
      resumeArmedUntil: 0,
      expiresAt: 0,
      deadline: 0,
      remainingMs: 0,
      hardRemainingMs: 0,
      closeReason: String(s.threadCloseReason || ''),
      isCurrent: false
    };
  }

  let current = null;
  if (threadCache.has(chatKey)) {
    current = threadCache.get(chatKey);
  } else {
    current = store?.getConversationThread?.(chatKey, now) || null;
    threadCache.set(chatKey, current);
  }
  const isCurrent = current?.mode === 'lifecycle'
    && String(current.threadId || '') === threadId;
  const source = isCurrent ? current : {
    threadId,
    state: 'closed',
    disposition: '',
    openedAt: Number(s.threadOpenedAt) || 0,
    idleDeadline: Number(s.threadIdleDeadline) || 0,
    hardDeadline: Number(s.threadHardDeadline) || 0,
    resumeArmedUntil: Number(s.threadResumeArmedUntil) || 0,
    expiresAt: Number(s.threadExpiresAt) || 0,
    closeReason: String(s.threadCloseReason || '')
  };
  const deadline = isCurrent ? lifecycleDeadline(source) : 0;
  return {
    threadId,
    state: String(source.state || (isCurrent ? s.threadState : 'closed') || 'closed'),
    disposition: String(source.disposition || ''),
    openedAt: Number(source.openedAt) || 0,
    idleDeadline: Number(source.idleDeadline) || 0,
    hardDeadline: Number(source.hardDeadline) || 0,
    resumeArmedUntil: Number(source.resumeArmedUntil) || 0,
    expiresAt: Number(source.expiresAt) || 0,
    deadline,
    remainingMs: deadline ? Math.max(0, deadline - now) : 0,
    hardRemainingMs: isCurrent && Number(source.hardDeadline) > 0
      ? Math.max(0, Number(source.hardDeadline) - now)
      : 0,
    closeReason: String(source.closeReason || ''),
    isCurrent
  };
}

function buildSessionView(s, store, options = {}) {
  const lifecycle = sessionLifecycleView(s, store, options);
  return {
    ...s,
    // 列表走索引摘要（带 persona）；详情拿的是完整会话对象，只有 systemPrompt —— 这里补算，
    // 否则详情头部永远显示"没记录到角色卡"。
    persona: s.persona || personaLabelOfPrompt(s.systemPrompt),
    threadState: lifecycle?.state || s.threadState || null,
    lifecycle,
    sessionMetrics: buildSessionMetrics(s)
  };
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 注意：会话文件在运行期会被节流重写（sessions.js #persistThrottled），不是"写一次就不动"，
// 所以可靠性绑定在下面两条失效策略上，别把它当不可变数据用。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 文件集合变化：新增/删除会话文件（Issue #45：以前用目录 mtime，而运行中的会话每
//      2 秒 rename 重写一次会话文件 —— rename 会改目录 mtime，等于每次写盘都让缓存失效，
//      控制台开着时 /api/status 几乎每次都全量扫盘。文件名集合只在增删时变）。
//   2. TTL 到期：120 秒（见 USAGE_CACHE_TTL_MS），兜住"内容被改写但文件名不变"（会话结束时
//      的最终统计最多晚 2 分钟进用量页；顶栏的 token 数另有实时来源）。
//      用量统计不是实时数据，2 分钟的新鲜度可以接受。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
// 2026-10-02 复审：缓存改成**按 range 分槽的 Map** —— 单槽时 /api/status 每 15 秒用
// range='today' 调一次（它要日统计），与用量页的 range='7' 交替覆盖同一个槽，导致 key
// 永远对不上、缓存实际从未命中（用量页每次打开仍全量扫）。分槽后各自的 TTL 独立生效。
const usageRowsCache = new Map();
const USAGE_CACHE_MAX_KEYS = 8;
const USAGE_CACHE_TTL_MS = 120000;  // Issue #45：60 → 120 秒。签名不再随运行中重写抖动，
                                    // 2 分钟一次全量扫描足以覆盖新会话与最终统计

/**
 * 缓存签名：排序后的文件名集合（哈希）。只看增删，不看 mtime —— 运行中的会话重写
 * 不会让缓存失效；会话结束的最终统计由 TTL 兜住。
 */
export function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    // 文件名集合（含压缩归档）：压缩会改名，签名随之变化一次，缓存失效后重算即可。
    const files = listSessionFiles(dir).map((f) => path.basename(f.file)).sort();
    return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
  } catch {
    return '';
  }
}

/**
 * 用量缓存的稳定 key。`end` 是 Date.now()，绝不能进 key —— 否则每次请求都是新 key，
 * TTL 缓存永远不命中（issue #61）。today/days/all 的 start 固定；24h 是滚动窗口，
 * 按 TTL 分桶，最多滞后一个 TTL。
 */
export function usageCacheSignature(range, win = resolveRange(range)) {
  const bucketStart = win?.mode === '24h'
    ? Math.floor(Number(win.start) / USAGE_CACHE_TTL_MS)
    : Number(win?.start) || 0;
  return `${sessionsDirSignature()}@${String(range)}@${win?.mode || ''}@${bucketStart}`;
}

function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  // 窗口也进签名：TTL 跨过午夜时，同一个文件名集合下 today/7 天的起点已经变了，
  // 不能再命中前一天算好的 rows（否则今日花费会把昨天整天算进来）。
  const sig = usageCacheSignature(range, win);
  const hit = usageRowsCache.get(sig);
  if (hit && (Date.now() - hit.at) < USAGE_CACHE_TTL_MS) {
    return {
      rows: hit.rows.slice(),
      // 返回缓存对应的窗口：rows 是按它筛的，返回当前 win 会让标签和行列不同步。
      win: hit.win || win,
      searchCount: hit.searchCount || 0,
      toolCounts: { ...(hit.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  // 留档可能已被压缩成 .json.gz：统一走 listSessionFiles/readSessionFile，
  // 否则"用量"会静默少算压缩掉的那几个月（同一 id 两种形态并存时只算明文那份）。
  const byId = new Map();
  try {
    for (const entry of listSessionFiles(dir)) {
      const cur = byId.get(entry.id);
      if (!cur || (cur.compressed && !entry.compressed)) byId.set(entry.id, entry);
    }
  } catch {
    // 目录读不了（EACCES/EBUSY）：返回空结果，不能让用量接口 500。
    // 空结果会进缓存，TTL 到期后重试。
    return { rows: [], win, searchCount: 0, toolCounts: {} };
  }
  const files = [...byId.values()];
  // mtime 预筛（2026-10-02）：窗口外的会话文件不必读 —— 749 个文件全读 + parse 约 1 秒，
  // 是"用量页打开要等一秒"的主因。会话文件的写入发生在运行期内/之后，mtime 只会晚于
  // startedAt，留 6 小时余量后按 mtime 跳过窗口外文件是安全的。
  const mtimeFloor = Number(win.start) > 0 ? Number(win.start) - 6 * 60 * 60 * 1000 : 0;

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 与 rows 在同一个循环里统计 —— 不额外多读一次文件。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const entry of files) {
    const filePath = entry.file;
    if (mtimeFloor > 0) {
      try { if (fs.statSync(filePath).mtimeMs < mtimeFloor) continue; } catch { continue; }
    }
    const s = readSessionFile(filePath);
    if (!s) continue;
    const started = Number(s.startedAt) || 0;
    if (!started) continue;

    // 这个会话是否落在时间窗口内（工具/搜索计数按会话归属，没有独立时间戳）
    if (started >= win.start && started <= win.end) {
      searchCount += Number(s.webSearchCount) || 0;
      for (const m of (s.messages || [])) {
        const name = m && m.toolCall && m.toolCall.name;
        if (name) toolCounts[String(name)] = (toolCounts[String(name)] || 0) + 1;
      }
    }

    for (const row of usageRowsForSession(s)) {
      if (row.at < win.start || row.at > win.end) continue;
      rows.push(row);
    }
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  usageRowsCache.set(sig, {
    rows: rows.slice(),
    win,
    searchCount,
    toolCounts: { ...toolCounts },
    at: Date.now()
  });
  if (usageRowsCache.size > USAGE_CACHE_MAX_KEYS) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of usageRowsCache) {
      if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key; }
    }
    if (oldestKey !== null) usageRowsCache.delete(oldestKey);
  }
  return { rows, win, searchCount, toolCounts };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价：渠道价（「渠道：模型」）→ 模型自定义价 → 价格表 → 兜底 → 未定价。
 * 链路本身在 resolveModelPrice 里，这里只负责把这次的渠道身份传进去。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor, at = 0) {
  // at = 这次调用的时刻：带时间区间的别名（如某日起路由到新模型）要按当时规则算
  return resolveModelPrice(model, getConfig(), null, { vendor, at });
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let freshCost = 0, cachedCost = 0, outputCost = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  // 未定价 = 价格表里查不到（不是"免费"）。这些调用不计成本，但必须能看见。
  let unpricedCalls = 0, unpricedTokens = 0;
  // 口径拆分：实付（用户自己填的渠道价/自定义价）vs 估算（官方表/兜底）。
  // 面板要能说清"这个数字里有多少是真价、多少是估的"。
  let actualCost = 0, estimateCost = 0, actualCalls = 0, estimateCalls = 0;
  // 包月/本地：不按 token 计价，成本以"固定支出"单独呈现（不计入区间成本）
  let flatCalls = 0, flatTokens = 0;
  const flatItems = new Map();
  let localCalls = 0, localTokens = 0;
  // 按"当前模型"的价估算的调用（没有自己价格的模型，避免变成用户的作业）
  let fallbackCalls = 0, fallbackTokens = 0;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor, r.at);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const freshPart = (fresh / 1_000_000) * tier.in;
    const cachedPart = (cached / 1_000_000) * tier.cached;
    const outputPart = (completion / 1_000_000) * tier.out;
    const c = freshPart + cachedPart + outputPart;
    cost += c;
    freshCost += freshPart;
    cachedCost += cachedPart;
    outputCost += outputPart;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
    if (p.unpriced === true) { unpricedCalls += 1; unpricedTokens += tk; }
    else if (p.billing === 'flat') {
      flatCalls += 1;
      flatTokens += tk;
      // 账户级包月（订阅制/本地自建）是**一个**固定支出，不能按模型个数各记一份：
      // 否则面板会把 ¥68/月 显示成 ¥68 × 用过的模型数。按账户口径定价的调用
      // 统一并到同一个条目里，模型级包月（价格表/自定义价里标 flat 的）仍按模型分开。
      const accountLevel = p.source === 'subscription';
      const key = accountLevel ? '(账户月费)' : (r.modelKey || r.model || '(未知)');
      const item = flatItems.get(key) || {
        key,
        amount: Number(p.amount) || 0,
        period: p.period === 'day' ? 'day' : 'month',
        calls: 0,
        tokens: 0,
        ...(accountLevel ? { accountLevel: true } : {})
      };
      item.calls += 1;
      item.tokens += tk;
      flatItems.set(key, item);
    } else if (p.billing === 'none') {
      localCalls += 1;
      localTokens += tk;
    } else if (p.source === 'fallback-model') {
      fallbackCalls += 1;
      fallbackTokens += tk;
      if (p.kind === 'actual') { actualCost += c; actualCalls += 1; }
      else { estimateCost += c; estimateCalls += 1; }
    } else if (p.kind === 'actual') { actualCost += c; actualCalls += 1; }
    else { estimateCost += c; estimateCalls += 1; }
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    breakdown: { fresh: freshCost, cached: cachedCost, output: outputCost },
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length,
    unpricedCalls, unpricedTokens,
    actualCost, estimateCost, actualCalls, estimateCalls,
    flatCalls, flatTokens, flatItems: [...flatItems.values()],
    localCalls, localTokens,
    fallbackCalls, fallbackTokens
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。 */
function buildUsageStats({ range = '7' } = {}) {
  const { rows, win, searchCount, toolCounts } = collectUsageRows({ range });
  const totals = costOfRows(rows);
  // 按天分桶需要 dayKey 字段
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  const byDay = (win.mode === 'days' || win.mode === 'all')
    ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })).sort((a, b) => a.day.localeCompare(b.day))
    : [];
  const chats = groupBy(rows, 'chatKey', 0);
  // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
  // 行数多时由前端滚动容器处理。
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  // 未定价清单：哪些模型没有价格、涉及多少次调用与 token。
  // 页面顶部要把这件事说清楚，否则用户会以为这些调用是免费的。
  const unpricedByModel = new Map();
  for (const r of rows) {
    if (priceOf(r.model, r.vendor, r.at).unpriced !== true) continue;
    const cur = unpricedByModel.get(r.modelKey) || { key: r.modelKey, calls: 0, tokens: 0 };
    cur.calls += 1;
    cur.tokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0);
    unpricedByModel.set(r.modelKey, cur);
  }
  const unpricedList = [...unpricedByModel.values()]
    .sort((a, b) => b.calls - a.calls)
    .map((x) => {
      const { vendor, model } = splitModelLabel(x.key);
      return { ...x, vendor, model };
    });
  const UNPRICED_LIMIT = 20;
  return {
    range: String(range),
    rangeLabel: win.label,
    mode: win.mode,
    totals,
    // 次数类统计：只看数量，不参与成本计算
    searchCount: searchCount || 0,
    toolCounts: toolCounts || {},
    days: byDay,
    chats,
    models,
    // 包月/本地：不按 token 计价，单独列出（不计入上面的区间成本）
    billing: {
      flatCalls: totals.flatCalls || 0,
      flatTokens: totals.flatTokens || 0,
      flatItems: (totals.flatItems || []).slice(0, 20),
      localCalls: totals.localCalls || 0,
      localTokens: totals.localTokens || 0
    },
    unpriced: {
      calls: totals.unpricedCalls || 0,
      tokens: totals.unpricedTokens || 0,
      models: unpricedList.slice(0, UNPRICED_LIMIT),
      more: Math.max(0, unpricedList.length - UNPRICED_LIMIT)
    }
  };
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows } = collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls,
      // 包月/本地/未定价也要带给明细行：否则这些行的成本列只剩 ¥0.00，
      // 会被读成"免费"（主表已经用徽标规避了这个问题，明细表同样需要）。
      flatCalls: g.flatCalls || 0,
      flatItems: (g.flatItems || []).slice(0, 5),
      localCalls: g.localCalls || 0,
      unpricedCalls: g.unpricedCalls || 0
    }))
  };
}
