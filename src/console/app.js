// Linux 服务总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRouter } from './router.js';

import { asrApiKey, asrAvailable, asrConfigured, asrCredentialForSlot, asrCredentialResolve, asrCredentialSlot, asrCredentialSlotOf, asrCredentials, asrEndpointHost, asrKeyHost, asrKeySlots, asrKeySource, asrLocalBin, asrLocalModel, asrSecretId, asrSecretKey, ASR_PROVIDERS, conversationConfigForChat, findWhisperBinSync, getConfig, identityPilotEnabled, imageGenAvailable, imageGenKeyHosts, imageGenKeyOwnedBy, imageGenKeyResolve, incidentPilotEnabled, slangPilotEnabled, updateConfig, onTimeControlChange, pinImageGenKeyHost, DATA_DIR, ROOT } from '../core/config.js';
import { tokenSaverEffective } from '../core/token-saver.js';
import { catchupReplyWindowMs, catchupLogLine, isFreshForReply } from '../core/catchup-policy.js';
import { budgetStatus } from '../core/budget.js';
import { sanitizeConfigSecrets } from '../core/secret-keys.js';
import { appendAudit, queryAudit } from '../core/audit-log.js';
import { lastTraceId } from '../core/logger.js';
import { customSearch } from '../llm/web-search.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes } from '../onebot/onebot.js';
import { faceNameOf } from '../onebot/face-catalog.js';
import { readForwardMessages } from '../onebot/forward-reader.js';
import { ChatStore } from '../core/store.js';
import { MemoryStore } from '../memory/memory.js';
import { StickerManager } from '../onebot/sticker-manager.js';
import { SendQueue } from '../onebot/sender.js';
import { SessionRegistry, personaLabelOfPrompt } from '../core/sessions.js';
import { Orchestrator } from '../core/orchestrator.js';
import { DailyMomentsManager } from '../features/daily-moments.js';
import { QzoneInteractionManager } from '../features/qzone-interactions.js';
import { GroupDigestManager } from '../features/group-digest.js';
import { GroupGameManager } from '../features/group-game.js';
import { ReminderStore } from '../core/reminders.js';
import { listModels, chatCompletion, resolveApiKey, cachedTokensOfUsage } from '../llm/llm.js';
import { synthesizeSpeech } from '../llm/tts.js';
import { generateImage, imageGenEffectiveHost, imageGenKeyStale, resolveImageGenAuth } from '../llm/image-gen.js';
import { imageType } from '../core/image-type.js';
import { IMAGEGEN_SERVICES } from '../llm/image-gen-presets.js';
import { TTS_SERVICES, ttsServiceById, ttsServiceOfBaseUrl, ttsKeyServices, ttsServiceOf, ttsKeyFor } from '../llm/tts-presets.js';
import { resolveOfficialPrice, listOfficialPrices, listModelAliases, isPeakHour, priceAt, resolveModelPrice, costModeOf, modelLabel, splitModelLabel, vendorOfConfig, UNKNOWN_VENDOR } from '../pricing/model-prices.js';
import { initPriceFeed, refreshPriceFeed, priceFeedStatus } from '../pricing/price-feed.js';
import { probeChannelPrices, capPrices } from '../pricing/price-probe.js';
import { initChannelPrices, refreshChannelFeed, removeChannelFeed, channelPriceStatus, maybeAutoProbeChannel } from '../pricing/channel-prices.js';
import { currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, probeThinking, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from '../core/providers.js';
import { scanModelsVision, visionResults } from '../llm/vision-scan.js';
import { builtinVisionResults } from '../llm/model-vision-docs.js';
import { createEventBus, todayKey, shanghaiDayStart, isSelfSender, safeSlice, sanitizeUserText, textWithQuote } from '../core/util.js';
import { assertCanSend } from '../core/access.js';
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
import { safeFetchBinary } from '../llm/safe-fetch.js';
// 平台能力门控的元数据（键→标签/工具/默认取向/配额默认）：控制台不手抄第二份，防漂移
import {
  PLATFORM_DEFAULT_OFF, PLATFORM_GATE_LABELS, PLATFORM_QUOTA_DEFAULTS, PLATFORM_TOOL_GATES,
  platformQuotaUsage
} from '../tools/tools-core.js';
import { integrationStatus, updateSnowLumaPassword } from './integrations.js';
import { createSnowlumaUpdater, baselineAlignDecision } from '../core/snowluma-update.js';
import { hostStats } from '../core/host-stats.js';
import { AutoUpdateManager, autoUpdatePending, readAutoUpdateState } from '../auto-update.js';
import { checkForUpdate, ignoreVersion } from '../update-notice.js';

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

// 前端构建戳：进程启动时按 ui/ 关键文件的体积+修改时间算一次。
// 用途：/api/status 带上它，前端轮询发现戳变了就提示"控制台已更新，点此刷新"
// —— 控制台是单页应用，部署不会自动替换已打开的页面，此前只能靠人记得按 F5。
function uiBuildStamp() {
  return ['index.html', 'app.js', 'style.css', 'stable-features.js', 'status-refresh.js', 'auto-update-network.js']
    .map((name) => {
      try {
        const s = fs.statSync(path.join(UI_DIR, name));
        return `${name}:${s.size}:${Math.round(s.mtimeMs)}`;
      } catch { return `${name}:missing`; }
    })
    .join('|');
}
const UI_BUILD = uiBuildStamp();

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
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
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

const loginThrottle = new Map();
function loginGate(req) {
  const key = String(req.socket?.remoteAddress || 'unknown');
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
      const e = loginThrottle.get(key) || { failures: 0, blockedUntil: 0 };
      e.failures += 1;
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

function decodeImageDataUrl(value) {
  const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i
    .exec(String(value || ''));
  if (!match) throw new Error('图片数据格式无效');
  const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('表情图片不能超过 8 MiB');
  return buffer;
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

export function createApp({
  log = console.log,
  autoUpdateOptions = {},
  asrInstaller = null,
  // 事件流的两个阈值只在测试里改（见 test/sse-stream.test.mjs）：默认值就是生产口径
  sseBacklogLimit = 1 << 20,
  sseHeartbeatMs = 20_000
} = {}) {
  const cfg = getConfig();
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

  // SSE 背压与心跳（2026-10-01 审查）：页面留在后台、或者对端半开（拔网线、NAT 表项过期）时，
  // res.write 只会往内核发送缓冲里堆，没人读就无限涨；半开连接连 close 事件都不会有，
  // 于是永久挂在集合里，每次广播都白写一遍、还拖着内存。
  // 两条兜底：① 写之前看 writableLength，积压超过上限就把这个客户端丢掉；
  // ② 定期发注释行心跳，让"写不进去"在半开连接上尽早暴露（EventSource 会忽略注释行）。
  const sseSend = (res, line) => {
    const closed = Boolean(res.writableEnded || res.destroyed);
    if (closed || Number(res.writableLength) > sseBacklogLimit) {
      sseClients.delete(res);
      const why = closed ? '连接已关闭' : `积压超过 ${Math.round(sseBacklogLimit / 1024)}KB`;
      log(`[console] 丢弃事件流客户端（${why}）`);
      try { res.end(); } catch { /* 已经断了 */ }
      // 只 end() 不够：keep-alive 下 socket 会一直留到 keepAliveTimeout 才关，
      // 对端既收不到 FIN 也不会重连，等于把"半开连接"换了个地方挂（2026-10-01 审查实测）。
      try { res.destroy?.(); } catch { /* 已经断了 */ }
      return;
    }
    try { res.write(line); } catch { sseClients.delete(res); }
  };
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
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
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
  const orchestrator = new Orchestrator({
    store,
    memory,
    stickers,
    sender,
    sessions,
    onebot,
    reminders,
    getGames: () => groupGame,
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
    log: moduleLog('group-game'),
    wake: (chatKey, delayMs, note, opts) => orchestrator.scheduleInitiativeWake(chatKey, delayMs, note, opts)
  });
  // 群日报：每天定时把"昨天群里聊了啥"汇总发到配置的群（默认关、白名单制）
  const groupDigest = new GroupDigestManager({
    store,
    sender,
    sessions,
    log: moduleLog('group-digest')
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
   */
  function retentionPruneTargets() {
    return [
      { name: '身份台账', run: () => identityPilot?.identityStore?.pruneLedgers() },
      { name: '关系台账', run: () => identityPilot?.pruneRelationshipHistory?.() },
      { name: '异常台账', run: () => incidentPilot?.pruneResolvedIncidents() },
      { name: '运行台账', run: () => store.pruneRuns() }
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
      allowPrivateUser: async (userId) => {
        const current = getConfig();
        const id = String(userId || '').trim();
        if (!/^\d{1,15}$/.test(id)) throw new Error('好友 QQ 号无效');
        const privateAllow = [...new Set([
          ...(current.allow?.private || []).map(String),
          id
        ])];
        const privateDeny = (current.deny?.private || [])
          .map(String)
          .filter((item) => item !== id);
        updateConfig({
          allow: { ...(current.allow || {}), private: privateAllow },
          deny: { ...(current.deny || {}), private: privateDeny }
        });
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
  maybeAutoProbeChannel({
    baseUrl: cfg.api?.baseUrl || '',
    vendor: vendorOfConfig(cfg) || '',
    feedsConfig: cfg.api?.channelPriceFeeds || [],
    options: { getConfig, updateConfig }
  }).catch(() => { /* 内部已吞，这里是第二道保险 */ });

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

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      const senderId = String(msg?.sender?.user_id ?? msg?.user_id ?? '');
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
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

  async function ingestMessage(kind, id, event, arrivedInactive = false) {
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

    let text;
    let reply = null;
    if (segments) {
      const replySegment = segments.find((segment) => segment?.type === 'reply' && segment?.data?.id != null);
      if (replySegment) {
        reply = await resolveReply(replySegment.data.id);
        if (!reply) {
          const local = store.findByMid(chatKey, replySegment.data.id);
          if (local) {
            reply = {
              messageId: String(replySegment.data.id),
              sender: local.self ? (onebot.selfNickname || cfgNow.persona?.botName || '我') : local.senderName,
              senderId: local.self ? String(onebot.selfId || '') : String(local.senderId || ''),
              self: Boolean(local.self),
              text: safeSlice(String(local.text || ''), 120)
            };
          }
        }
      }
      text = await segmentsToText(segments, {
        selfId: String(onebot.selfId || ''),
        resolveReply: (mid) => (
          reply && String(reply.messageId) === String(mid)
            ? reply
            : resolveReply(mid)
        ),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null
      });
    } else {
      // 协议端以字符串 / CQ 码上报时（message_format=string）正文也要清洗：
      // 否则这种部署形态下群友文本可以原样伪造段标记
      text = sanitizeUserText(String(event.raw_message ?? event.message ?? '').trim());
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 优先使用当前转发卡片的资源 id，兼容仅支持 message_id 的旧适配器。
    // 媒体里的 url 此时是新鲜的，一并收进 media（取图/金句都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    if (segments && (text.includes('[合并转发') || text.includes('[转发消息')) && event.message_id != null) {
      try {
        const nodes = await readForwardMessages(onebot, event.message_id, segments);
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${e?.message ?? e}`);
      }
    }

    if (!text && !media.length) return;
    const message = {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      // 表情包（QQ 标记为动画表情/表情的图）与普通图片分开标注，让模型和存档一眼能分辨
      text: text || (media.some((m) => m.kind === 'image' && /表情/.test(String(m.summary || '')))
        ? '[表情包]' : '[图片]'),
      reply,
      media,
      mentionsSelf,
      // 引擎发的游戏私聊（身份/查验结果/行动回执）标成 game-secret：提示词构建时会过滤掉，
      // 模型在私聊里不该是上帝视角（2026-09-29 审查 P2）
      eventKind: isSelf && groupGame?.isSecretSelfMessage?.(chatKey, event.message_id) ? 'game-secret' : 'message'
    };
    const stored = isSelf ? store.appendSelf(chatKey, message) : store.appendIncoming(chatKey, message, {
      recordOnly: arrivedInactive || !isTimeActive(chatKey)
    });
    if (stored.duplicate) return;
    if (!isSelf) identityPilot?.observeMessage(chatKey, stored);
    if (!isSelf) slangPilot?.observeMessage(chatKey, stored);
    if (!isSelf) {
      Promise.resolve(stickers.autoCollect?.(chatKey, stored)).catch((error) =>
        log('[sticker] 自动收藏失败:', error?.message ?? error));
    }
    emit('chat-update', chatKey);
    if (
      !isSelf
      && (
        await handleFriendProposalAdminCommand(kind, id, text)
        || await handleSlangPilotAdminCommand(kind, id, text)
      )
    ) return;
    // 群游戏的私聊行动（狼人杀这类"夜里私聊提交"的游戏）：属于进行中的局就由引擎在入口
    // 接管（发回执/发查验结果），并就地标记已读 —— 不再唤醒模型（省调用 + 零泄密面）。
    // 解析不了的消息返回 false，照常走下面的普通链路落到模型手里兜底。
    if (!isSelf && kind === 'private' && groupGame?.consumePrivateAction
      && await groupGame.consumePrivateAction(chatKey, stored)) return;
    if (!isSelf) orchestrator.onIncoming(chatKey);
  }

  // ── 启动/重连补齐 ──
  // 服务重启或协议端断线时事件会丢：消息根本没进库，也就永远没人回。
  // 连上以后从协议端拉一次最近历史，把库里没有的消息补进来；去重靠 mid，重复不会脏数据。
  let lastCatchUpAt = 0;
  function scheduleCatchUp() {
    if (Date.now() - lastCatchUpAt < 60000) return;   // 断线重连可能连续触发，一分钟内只补一次
    lastCatchUpAt = Date.now();
    setTimeout(() => { catchUpMissedMessages().catch(() => {}); }, 3000);
  }
  async function catchUpMissedMessages() {
    const cfgNow = getConfig();
    const windowMs = catchupReplyWindowMs(cfgNow);
    const targets = [
      ...(cfgNow.allow?.groups ?? []).map((g) => ({ kind: 'group', id: String(g) })),
      ...(cfgNow.allow?.private ?? []).map((p) => ({ kind: 'private', id: String(p) }))
    ];
    for (const { kind, id } of targets) {
      const chatKey = `${kind}:${id}`;
      try {
        const data = kind === 'group'
          ? await onebot.call('get_group_msg_history', { group_id: Number(id), count: 20 }, 20000, null)
          : await onebot.call('get_friend_msg_history', { user_id: Number(id), count: 20 }, 20000, null);
        const list = Array.isArray(data?.messages) ? data.messages : [];
        let added = 0;
        let recordedOnly = 0;
        for (const item of list) {
          const mid = item?.message_id;
          if (mid === undefined || mid === null) continue;
          if (store.findByMid(chatKey, mid)) continue;         // 库里已有（含自己发的），跳过
          const ts = Math.round(Number(item?.time || 0) * 1000) || Date.now();
          const fresh = isFreshForReply(ts, Date.now(), windowMs);  // 窗口内的按新消息处理，更早的只补记录
          if (!fresh) recordedOnly += 1;
          await ingestMessage(kind, id, item, !fresh);
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
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
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
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
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
      eventKind: 'poke'
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
    let operatorName = (await resolveAtName(groupId, operatorId)) || '';
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
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event, arrivedInactive);
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
    handleHttp(req, res).catch((error) => {
      incidentPilot?.capture(error, {
        source: 'http',
        category: 'http',
        severity: 'error',
        details: { method: req.method || '', pathname: String(req.url || '').split('?')[0] }
      });
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(error?.httpStatus || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
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
    return text ? JSON.parse(text) : {};
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

  function setConsoleCookie(res, token) {
    res.setHeader('set-cookie',
      // 本地改动：加 Max-Age，避免关掉浏览器就要重新输令牌
      `qq_agent_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
  }

  function writeConsoleAccess(token) {
    const file = path.join(DATA_DIR, 'console-access.txt');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp,
      `QQ Agent Linux\nURL: http://${getConfig().server.host}:${getConfig().server.port}\nToken: ${token}\nMode: ${getConfig().runtime.mode}\n`,
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

  /** 顶层键差异清单（config.update 的审计摘要用）；只比 JSON 形态，键名排序稳定。 */
  function changedTopKeys(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])).sort();
  }

  const router = createRouter({
    authorize,
    json,
    keyEndpointAllowed,
    // 审计（#5）：鉴权成功后由 router 记下本次凭据指纹（sha256 前 8 位），写接口埋点直接
    // 读 req.consoleTokenFp —— 与鉴权同一次取值，不在每个埋点里各自重算。
    tokenFp: () => tokenFpOf(getConfig().server?.token)
  });

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
    setConsoleCookie(res, token);
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
    setConsoleCookie(res, next);
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
  router.add('GET', '/api/snowluma/version', async (req, res) => {
    const st = await snowlumaUpdater.status();
    const auto = getConfig().autoUpdate?.snowluma || {};
    return json(res, 200, {
      ...st,
      auto: {
        enabled: auto.enabled === true,
        image: String(auto.image || ''),
        followBaseline: auto.followBaseline !== false
      }
    });
  });
  router.add('POST', '/api/snowluma/update', async (req, res) => {
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
  router.add('PUT', '/api/auto-update/settings', async (req, res) => {
    const body = await readBody(req);
    try {
      autoUpdate.configure({
        ownerUin: body.ownerUin,
        intervalHours: body.intervalHours
      });
      return json(res, 200, { ok: true, status: autoUpdate.status() });
    } catch (error) {
      return json(res, error.httpStatus || 400, {
        error: String(error?.message ?? error)
      });
    }
  });
  router.add('POST', '/api/auto-update/run', async (req, res) => {
    const body = await readBody(req);
    if (body.confirm !== true) {
      return json(res, 409, { error: '手动更新需要显式确认' });
    }
    try {
      const status = autoUpdate.requestManual({ version: body.version });
      auditWrite('auto-update.run', String(body.version || ''), { req, after: status });
      return json(res, 202, { ok: true, status });
    } catch (error) {
      auditWrite('auto-update.run', String(body.version || ''), { req, ok: false, error: String(error?.message ?? error) });
      return json(res, error.httpStatus || 409, {
        error: String(error?.message ?? error)
      });
    }
  });
  router.add('POST', '/api/auto-update/resume', async (req, res) => {
    const body = await readBody(req);
    if (body.confirm !== true) {
      return json(res, 409, { error: '恢复自动更新需要显式确认' });
    }
    try {
      autoUpdate.resume({
        ownerUin: body.ownerUin,
        intervalHours: body.intervalHours
      });
      auditWrite('auto-update.resume', String(body.ownerUin ?? ''), { req, after: autoUpdate.status() });
      return json(res, 200, { ok: true, status: autoUpdate.status() });
    } catch (error) {
      auditWrite('auto-update.resume', String(body.ownerUin ?? ''), { req, ok: false, error: String(error?.message ?? error) });
      return json(res, error.httpStatus || 400, {
        error: String(error?.message ?? error)
      });
    }
  });
  router.add('POST', '/api/auto-update/pause', async (req, res) => {
    const body = await readBody(req);
    if (body.confirm !== true) {
      return json(res, 409, { error: '暂停自动更新需要显式确认' });
    }
    autoUpdate.pause();
    return json(res, 200, { ok: true, status: autoUpdate.status() });
  });
  router.add('POST', '/api/auto-update/notify-pending', async (req, res) => {
    const status = await autoUpdate.handlePendingFailure();
    return json(res, 200, { ok: true, status });
  });
  router.add('GET', '/api/auto-update/check', async (req, res) => {
    // 「发现新版本」提示：只读检查 + Release 说明，结果缓存 30 分钟。
    // 点「立即更新」不走这里，仍由 /api/auto-update/run 触发既有部署链路。
    try {
      const notice = await checkForUpdate(DATA_DIR, getConfig());
      const state = readAutoUpdateState(DATA_DIR);
      return json(res, 200, {
        ok: true,
        notice,
        ignoredVersion: String(state.ignoredVersion || ''),
        // 已经提交、还没跑完的更新（见 autoUpdatePending）：前端据此不再重复弹同一个版本
        pending: autoUpdatePending(DATA_DIR)
      });
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/auto-update/ignore', async (req, res) => {
    const body = await readBody(req);
    const version = ignoreVersion(DATA_DIR, body.version);
    if (!version) return json(res, 400, { error: '缺少要忽略的版本号' });
    return json(res, 200, { ok: true, ignoredVersion: version });
  });
  router.add('POST', '/api/runtime', async (req, res) => {
    const body = await readBody(req);
    if (!['observe', 'active'].includes(body.mode)) return json(res, 400, { error: 'Invalid mode' });
    if (body.mode === 'active' && body.confirmExclusive !== true) {
      return json(res, 409, { error: 'Confirm that the old instance is disabled for these chats or use a different QQ account.' });
    }
    if (body.mode === 'observe') {
      for (const controller of orchestrator.controllers.values()) controller.abort(new Error('Run cancelled'));
      slangPilot?.abortResearch('机器人已切换到观察模式');
    }
    if (body.skipBacklog === true) for (const key of store.listChats()) store.markAllRead(key);
    updateConfig({ runtime: { mode: body.mode } });
    if (body.mode === 'active') slangPilot?.resumeQueued();
    emit('status', { mode: body.mode });
    return json(res, 200, { ok: true, mode: body.mode });
  });

  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/(retry-failed|resolve-held)$/, async (req, res, params) => {
    const body = await readBody(req);
    const key = `${params[1]}:${params[2]}`;
    if (body.confirm !== true) return json(res, 409, { error: 'Explicit confirmation required' });
    const count = params[3] === 'retry-failed' ? store.retryFailed(key) : store.resolveHeld(key);
    emit('chat-update', key);
    return json(res, 200, { ok: true, count });
  });
  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/runtime-control$/, async (req, res, params) => {
    const key = `${params[1]}:${params[2]}`;
    const meta = store.getChatMeta(key);
    return json(res, 200, {
      control: incidentPilot?.getChatControl(key) || {
        chatKey: key, mode: 'auto', reason: '', version: 0
      },
      decision: incidentPilot?.chatDecision(key, meta) || {
        allowed: meta.held === 0,
        mode: 'legacy',
        effectiveState: meta.held > 0 ? 'blocked' : 'normal',
        reason: meta.held > 0 ? '存在发送结果待确认' : ''
      },
      unread: meta.unread,
      held: meta.held
    });
  });
  router.add('PUT', /^\/api\/chats\/(group|private)_(\d+)\/runtime-control$/, async (req, res, params) => {
    if (!incidentPilot?.active) {
      return json(res, 409, { error: '异常处理实验当前未启用' });
    }
    const key = `${params[1]}:${params[2]}`;
    const body = await readBody(req);
    if (!['auto', 'blocked', 'continue'].includes(body.mode)) {
      return json(res, 400, { error: 'mode 必须是 auto、blocked 或 continue' });
    }
    if (body.mode === 'continue' && body.confirm !== true) {
      return json(res, 409, { error: '继续处理需要显式确认' });
    }
    const control = incidentPilot.setChatControl(key, {
      mode: body.mode,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      updatedBy: 'console'
    });
    const decision = orchestrator.enforceChatControl(key);
    let backlog = { action: 'keep', marked: 0, kept: store.unreadCount(key) };
    if (decision.allowed && body.backlogAction === 'discard') {
      backlog = { action: 'discard', marked: store.markAllRead(key), kept: 0 };
    } else if (decision.allowed && body.backlogAction === 'recent') {
      backlog = { action: 'recent', ...store.keepLatestPending(key) };
      if (backlog.kept > 0) orchestrator.scheduleWake(key, 0);
    }
    emit('chat-update', key);
    return json(res, 200, { ok: true, control, decision, backlog });
  });
  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/messages$/, async (req, res, params, url) => {
    const chatKey = `${params[1]}:${params[2]}`;
    // 单群消息上限 2^20（Kondius 钦定）：约等于不限，存档一口气全给
    const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
    const messages = store.recent(chatKey, { limit }).map((m) => ({
      id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
      // 与提示词同一套渲染：正文缺引用块时补上（回复 + 合并转发卡片那类记录）
      text: textWithQuote(m), self: m.self, read: m.read, reply: m.reply,
      media: m.media || []
    }));
    return json(res, 200, { chatKey, messages });
  });
  router.add('GET', /^\/api\/groups\/(\d+)\/members$/, async (req, res, params) => {
    try {
      const list = await onebot.call('get_group_member_list', { group_id: Number(params[1]) });
      const members = (Array.isArray(list) ? list : (list?.data ?? []))
        .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
        .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
      return json(res, 200, { members });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/wake$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const result = orchestrator.requestManualWake(chatKey);
    return json(res, result.ok ? 202 : 409, result);
  });
  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/thread$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    return json(res, 200, {
      chatKey,
      mode: conversationConfigForChat(chatKey).mode,
      thread: store.getConversationThread(chatKey),
      checkpoint: store.latestThreadCheckpoint(chatKey)
    });
  });
  router.add('DELETE', /^\/api\/chats\/(group|private)_(\d+)\/thread$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const closed = store.closeConversationThread(chatKey, 'operator');
    emit('chat-update', chatKey);
    return json(res, 200, { ok: true, closed });
  });
  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/test-send$/, async (req, res, params) => {
    const body = await readBody(req);
    const text = String(body.text ?? '').trim();
    if (!text) return json(res, 400, { error: '消息内容为空' });
    try {
      const chatKey = `${params[1]}:${params[2]}`;
      assertCanSend(chatKey);
      const decision = incidentPilot?.chatDecision(chatKey, store.getChatMeta(chatKey));
      if (decision && !decision.allowed) {
        return json(res, 409, { error: decision.reason || '该会话当前被阻塞' });
      }
      const data = await sender.sendTextBatch(chatKey, [text]);
      emit('chat-update', chatKey);
      return json(res, 200, { ok: true, messageId: data.sent[0]?.messageId ?? null });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const drained = store.drainUnread(chatKey);
    return json(res, 200, { ok: true, marked: drained.length });
  });

  router.add('GET', '/api/assets/overview', async (req, res) => {
    const overview = assetObserver.overview();
    const pilotStatus = slangPilotStatus();
    return json(res, 200, {
      ...overview,
      slang: { ...overview.slang, active: pilotStatus.active },
      slangPilot: pilotStatus
    });
  });
  router.add('GET', '/api/assets/stickers', async (req, res, params, url) => {
    const result = await assetObserver.listStickers({
      query: url.searchParams.get('query') || '',
      offset: url.searchParams.get('offset') || 0,
      limit: url.searchParams.get('limit') || 100,
      refresh: url.searchParams.get('refresh') === '1'
    });
    // QQ 收藏表情有上限（非会员 500）：满了之后新收藏只能进本地图库（发出去是图片），
    // 界面据此解释清楚，别让人以为"表情包坏了"
    try { result.qqFavorites = await stickers.qqFavoritesState(); } catch { /* 拿不到就不显示 */ }
    return json(res, 200, result);
  });
  router.add('POST', '/api/assets/stickers', async (req, res) => {
    try {
      const body = await readBody(req, 12 * 1024 * 1024);
      let imageBuffer;
      if (body.imageDataUrl) {
        imageBuffer = decodeImageDataUrl(body.imageDataUrl);
      } else if (body.imageUrl) {
        imageBuffer = (await safeFetchBinary(
          String(body.imageUrl),
          8 * 1024 * 1024
        )).buffer;
      } else {
        return json(res, 400, { error: '请选择图片文件或填写图片 URL' });
      }
      const entry = assetObserver.addSticker({
        imageBuffer,
        desc: body.desc,
        localNote: body.localNote,
        tags: body.tags,
        usage: body.usage
      });
      emit('asset-update', { kind: 'stickers', action: 'create', id: entry.id });
      return json(res, 201, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/assets/stickers/image', async (req, res, params, url) => {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return json(res, 400, { error: '缺少表情 ID' });
    let sticker = stickers.peek(id);
    const localImage = stickers.readImage(id);
    if (localImage) {
      // 贴纸图片按 id 内容恒定（id 唯一、删除后不再出现）：长缓存 + 强 ETag。
      // 2026-10-02：观测页每张 126KB，36 张约 4.5MB，重复浏览不该重下。
      const etag = `"s-${id}"`;
      if (String(req.headers['if-none-match'] || '') === etag) {
        res.writeHead(304, { etag, 'cache-control': 'private, max-age=604800, immutable' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': localImage.contentType,
        'content-length': localImage.buffer.length,
        'cache-control': 'private, max-age=604800, immutable',
        etag,
        'x-content-type-options': 'nosniff'
      });
      res.end(localImage.buffer);
      return;
    }
    if (sticker?.source === 'ai') {
      sticker = await stickers.findForSend(id);
    }
    if (!sticker?.url) return json(res, 404, { error: '表情图片不存在' });
    // 远程表情图片（QQ 表情 URL 里带 md5、内容恒定）：ETag + 一天浏览器缓存。
    // 2026-10-02 实测：线上 42 张贴纸**全部**只有远程 URL、没有本地文件，观测页每张
    // 缩略图都要服务器现去 QQ 拉一次且只缓存 60 秒 —— 每次进页面把整套图重拉一遍。
    const remoteEtag = `"u-${crypto.createHash('sha1').update(String(sticker.url)).digest('hex').slice(0, 16)}"`;
    if (String(req.headers['if-none-match'] || '') === remoteEtag) {
      res.writeHead(304, { etag: remoteEtag, 'cache-control': 'private, max-age=86400' });
      res.end();
      return;
    }
    try {
      const image = await safeFetchBinary(sticker.url, 8 * 1024 * 1024);
      const contentType = String(image.contentType || '').split(';')[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) {
        return json(res, 502, { error: '表情资源不是图片' });
      }
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': image.buffer.length,
        'cache-control': 'private, max-age=86400',
        etag: remoteEtag,
        'x-content-type-options': 'nosniff'
      });
      res.end(image.buffer);
      return;
    } catch (error) {
      return json(res, 502, { error: `表情图片读取失败：${String(error?.message ?? error)}` });
    }
  });
  router.add('GET', '/api/assets/slang', async (req, res, params, url) => {
    return json(res, 200, assetObserver.listSlang({
      query: url.searchParams.get('query') || '',
      status: url.searchParams.get('status') || '',
      offset: url.searchParams.get('offset') || 0,
      limit: url.searchParams.get('limit') || 200
    }));
  });
  router.add('POST', '/api/assets/slang', async (req, res) => {
    try {
      const entry = assetObserver.addSlang(await readBody(req));
      emit('asset-update', { kind: 'slang', action: 'create', id: entry.id });
      return json(res, 201, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/assets/identities', async (req, res, params, url) => {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    return json(res, 200, assetObserver.identitySnapshot({
      limit,
      query: url.searchParams.get('query') || ''
    }));
  });
  router.add('POST', '/api/assets/identities', async (req, res) => {
    try {
      const person = assetObserver.upsertIdentity(await readBody(req));
      emit('asset-update', { kind: 'identities', action: 'create', id: person.userId });
      emit('identity-pilot-update', identityPilotStatus());
      return json(res, 201, { ok: true, person });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/assets/memory', async (req, res, params, url) => {
    // limit：这个接口要遍历"每个会话 × 每个成员"，不带上限时多群实例会一次吐出上千行
    // （前端还要把它们全渲染成表格）。默认 500，与身份列表同一口径（2026-10-08 审查）。
    return json(res, 200, assetObserver.memorySummary({
      query: url.searchParams.get('query') || '',
      limit: Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500))
    }));
  });
  router.add('POST', '/api/assets/memory', async (req, res) => {
    try {
      const entry = assetObserver.addMemory(await readBody(req));
      await refreshIdentityAfterAssetMutation();
      emit('memory-update', { chatKey: String(entry.chatKey || '') });
      emit('asset-update', { kind: 'memory', action: 'create' });
      return json(res, 201, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('PUT', '/api/assets/memory', async (req, res) => {
    try {
      const body = await readBody(req);
      const member = assetObserver.updateMemory(body);
      await refreshIdentityAfterAssetMutation();
      emit('memory-update', { chatKey: String(body.chatKey || '') });
      emit('asset-update', { kind: 'memory', action: 'update' });
      return json(res, 200, { ok: true, member });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', '/api/assets/memory', async (req, res) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: '删除记忆需要显式确认' });
      if (!assetObserver.deleteMemory(body)) return json(res, 404, { error: '记忆不存在' });
      await refreshIdentityAfterAssetMutation();
      emit('memory-update', { chatKey: String(body.chatKey || '') });
      emit('asset-update', { kind: 'memory', action: 'delete' });
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });

  router.add('PUT', /^\/api\/assets\/stickers\/([^/]+)$/, async (req, res, params) => {
    try {
      const id = decodeURIComponent(params[1]);
      const body = await readBody(req);
      const entry = assetObserver.updateSticker(id, {
        desc: body.desc,
        localNote: body.localNote,
        tags: body.tags,
        usage: body.usage
      });
      if (!entry) return json(res, 404, { error: '表情不存在' });
      emit('asset-update', { kind: 'stickers', action: 'update', id });
      return json(res, 200, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/assets\/stickers\/([^/]+)$/, async (req, res, params) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: '删除表情需要显式确认' });
      const id = decodeURIComponent(params[1]);
      const result = assetObserver.deleteSticker(id);
      if (!result?.removed) return json(res, 404, { error: '表情不存在' });
      emit('asset-update', { kind: 'stickers', action: 'delete', id });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('PUT', /^\/api\/assets\/slang\/([^/]+)$/, async (req, res, params) => {
    try {
      const id = decodeURIComponent(params[1]);
      const entry = assetObserver.updateSlang(id, await readBody(req));
      if (!entry) return json(res, 404, { error: '黑话词条不存在' });
      emit('asset-update', { kind: 'slang', action: 'update', id });
      return json(res, 200, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/assets\/slang\/([^/]+)$/, async (req, res, params) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: '删除黑话需要显式确认' });
      const id = decodeURIComponent(params[1]);
      if (!assetObserver.deleteSlang(id)) return json(res, 404, { error: '黑话词条不存在' });
      emit('asset-update', { kind: 'slang', action: 'delete', id });
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('PUT', /^\/api\/assets\/identities\/(\d+)$/, async (req, res, params) => {
    try {
      const person = assetObserver.upsertIdentity({
        ...(await readBody(req)),
        userId: params[1]
      });
      emit('asset-update', { kind: 'identities', action: 'update', id: person.userId });
      emit('identity-pilot-update', identityPilotStatus());
      return json(res, 200, { ok: true, person });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/assets\/identities\/(\d+)$/, async (req, res, params) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: '删除人物需要显式确认' });
      if (!assetObserver.deleteIdentity(params[1])) {
        return json(res, 404, { error: '人物不存在' });
      }
      emit('asset-update', { kind: 'identities', action: 'delete', id: params[1] });
      emit('identity-pilot-update', identityPilotStatus());
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });

  router.add('GET', '/api/memory-files', async (req, res) => {
    const files = memory.listChats().map((chatKey) => {
      const members = memory.members(chatKey);
      const handoff = memory.getHandoff(chatKey);
      const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
      return {
        chatKey,
        impressionCount,
        memberCount: members.length,
        hasHandoff: Boolean(handoff),
        handoffExpiresAt: handoff?.expiresAt || 0,
        updatedAt: Math.max(
          Number(handoff?.updatedAt) || 0,
          0,
          ...members.map((m) => Number(m.updatedAt) || 0)
        )
      };
    });
    // 白名单里的群没有记忆也要显示
    const seen = new Set(files.map((f) => f.chatKey));
    // 补上白名单里还没有记忆的会话（缺字段也要有默认值，前端统一处理）
    for (const gid of (getConfig().allow?.groups || [])) {
      const key = `group:${String(gid)}`;
      if (!seen.has(key)) {
        files.push({
          chatKey: key, impressionCount: 0, memberCount: 0,
          hasHandoff: false, handoffExpiresAt: 0, updatedAt: 0, consolidating: false
        });
      }
    }
    for (const uid of (getConfig().allow?.private || [])) {
      const key = `private:${String(uid)}`;
      if (!seen.has(key)) {
        files.push({
          chatKey: key, impressionCount: 0, memberCount: 0,
          hasHandoff: false, handoffExpiresAt: 0, updatedAt: 0, consolidating: false
        });
      }
    }
    // 带上"正在整理"状态：切页签后前端靠它恢复提示，
    // 否则用户切走再切回，完全看不出整理是在跑还是已经中断。
    const busy = orchestrator.consolidating;
    for (const f of files) f.consolidating = busy.has(f.chatKey);
    files.sort((a, b) => b.updatedAt - a.updatedAt);
    return json(res, 200, { files, consolidating: [...busy] });
  });
  router.add('POST', '/api/memory-files/consolidate', async (req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const chatKey = String(body.chatKey || '');
      if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });

      // 可选：只整理指定的群友（QQ 号数组）。不传 = 整理全群。
      // 传了但记忆里还没有此人时，会从聊天记录里新建印象。
      let userIds = null;
      if (body.userIds != null) {
        const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
        userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
        if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
      }
      // 手动触发：跳过门槛/冷却检查，且对零印象的人启用"新建印象"模式
      const force = body.force !== false;

      if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
      orchestrator.consolidating.add(chatKey);
      emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
      orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
        .then((result) => {
          emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) });
        })
        .catch((error) => {
          emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) });
        })
        .finally(() => orchestrator.consolidating.delete(chatKey));
      return json(res, 202, { ok: true, started: true });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('GET', /^\/api\/memory-files\/(group|private)_(\d+)$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    return json(res, 200, {
      ...memory.query(chatKey),
      members: memory.members(chatKey),
      handoff: memory.getHandoff(chatKey)
    });
  });
  router.add('PUT', /^\/api\/memory-files\/(group|private)_(\d+)\/handoff$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const body = await readBody(req).catch(() => ({}));
    try {
      const handoff = memory.setHandoff(chatKey, body, { sourceSessionId: 'console' });
      emit('memory-update', { chatKey, phase: handoff ? 'handoff-update' : 'handoff-clear' });
      return json(res, 200, { ok: true, handoff });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/memory-files\/(group|private)_(\d+)\/handoff$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    memory.clearHandoff(chatKey);
    emit('memory-update', { chatKey, phase: 'handoff-clear' });
    return json(res, 200, { ok: true });
  });
  router.add('DELETE', /^\/api\/memory-files\/global\/members\/(\d{1,15})$/, async (req, res, params) => {
    // 破坏性操作统一 confirm 门槛（与全站口径一致）：global 版跨所有会话删除。
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '删除全部人物记忆需要 body.confirm === true' });
    const removed = memory.removeMember('', params[1]);
    emit('memory-update', { chatKey: '' });
    return json(res, 200, { ok: true, removed });
  });
  router.add('PUT', /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/, async (req, res, params) => {
    const chatKey = `${params[1]}:${params[2]}`;
    const body = await readBody(req).catch(() => ({}));
    try {
      const member = memory.editMemberImpression(chatKey, {
        userId: params[3],
        name: String(body.name ?? ''),
        note: body.note ?? '',
        impressions: body.impressions ?? []
      });
      emit('memory-update', { chatKey });
      return json(res, 200, { ok: true, member });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/, async (req, res, params) => {
    // 同上：删除成员印象也要 confirm（该路径的快照对 name-only 成员缺位，误删更难恢复）。
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '删除成员印象需要 body.confirm === true' });
    const chatKey = `${params[1]}:${params[2]}`;
    memory.removeMember(chatKey, params[3]);
    emit('memory-update', { chatKey });
    return json(res, 200, { ok: true });
  });

  router.add('GET', '/api/providers', async (req, res) => {
    const providers = currentProviders().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      baseURL: p.baseURL,
      apiKey: '',              // 不把真实 Key 暴露给 UI；有 Key 用 hasKey 表示
      apiKeyFrom: p.apiKeyFrom || '',
      needsBaseUrl: p.needsBaseUrl === true,
      hasKey: !!p.apiKey,
      anthropicOrigin: p.anthropicOrigin === true,
      models: p.models,
      modelNames: p.modelNames || {},
      preset: p.preset || '',
      thinkingProbe: p.thinkingProbe || null
    }));
    return json(res, 200, { providers });
  });
  router.add('GET', '/api/providers/key', async (req, res, params, url) => {
    if (!keyEndpointAllowed(req)) {
      return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
    }
    const pid = String(url.searchParams.get('providerId') || '');
    const p = currentProviders().find((x) => x.id === pid);
    return json(res, 200, { apiKey: p?.apiKey || '' });
  });
  router.add('POST', '/api/asr/models', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const baseUrl = String(body.baseUrl || cfgNow.asr?.baseUrl || '').trim();
      const submitted = String(body.apiKey ?? '').trim();
      const trimSlash = (value) => String(value || '').trim().replace(/[/]+$/, '').toLowerCase();
      const knownBase = trimSlash(cfgNow.asr?.baseUrl);
      const target = trimSlash(baseUrl);
      const apiKey = (submitted && submitted !== '******')
        ? submitted
        : (target && target === knownBase ? asrApiKey(cfgNow) : '');
      const all = await fetchModelsFrom(baseUrl, apiKey);
      // 用户要求：只取语音模型。列表里通常混着几百个 LLM，全给出来等于找不到东西。
      // 正向：转写类（whisper / sensevoice / ASR / speech-to-text / 转写…）。
      //   ⚠️ 关键词表必然不完备：硅基流动的 XingChenGSR 是语音识别，名字里却没有 asr
      //   （用户 2026-09-26 反馈"明明有 8 个只给 5 个"）。所以除了补关键词，
      //   还要把"被排除的 TTS"如实回报给界面 —— 用户能看出少的是哪几个、为什么少。
      const isAsrModel = (id) => /whisper|sensevoice|teleasr|funaudio|asr|gsr|paraformer|transcri|transcribe|audio.?to.?text|speech.?to.?text|recogni|stt|speech/i.test(id);
      // 反向：TTS（文字转语音）不是我们要的 —— 把 CosyVoice、tts-1、voice-clone 之类列进来只会误导。
      const isTtsModel = (id) => /tts|text.?to.?speech|cosyvoice|voice.?clone|voice.?design|speech.?synth|music|sing/i.test(id);
      const speech = all.filter((id) => isAsrModel(id) && !isTtsModel(id)).sort((a, b) => a.localeCompare(b));
      const tts = all.filter((id) => isTtsModel(id)).sort((a, b) => a.localeCompare(b));
      // 一家都没认出来时退回全量（宁可给多，也别让人以为"拉不到"），并如实说明
      const models = speech.length ? speech : [...all].sort((a, b) => a.localeCompare(b));
      return json(res, 200, {
        ok: true,
        models,
        speechOnly: speech.length > 0,
        speechCount: speech.length,
        // 被排除的语音合成模型：界面据此说明"少的那几个是什么"（只给前 3 个名字，别把提示撑满）
        ttsCount: tts.length,
        ttsSample: tts.slice(0, 3),
        total: all.length
      });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/asr/install-status', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    return json(res, 200, asrInstallSnapshot());
  });
  router.add('POST', '/api/asr/uninstall', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    // 与全站其它破坏性端点同一口径：必须显式 confirm —— 这是不可逆删除（约 500MB 模型与构建产物），
    // 之前唯一的防线是前端对话框，body 可为空的直接请求会把它们全删掉（2026-10-07 复审 P3）。
    const body = await readBody(req);
    if (body?.confirm !== true) return json(res, 409, { error: '删除本机转写需要显式确认' });
    if (asrInstall.running) return json(res, 409, { error: '安装还在进行中，等它跑完再删' });
    try {
      const removed = removeLocalAsrFiles();
      // 破坏性操作留一行日志：以后能查"什么时候、删了哪个目录、放了多少空间"
      log(`[asr] 已完整卸载本机转写：${removed.managedDir}（释放 ${Math.round((removed.freedBytes || 0) / 1048576)}MB）`);
      return json(res, 200, { ok: true, ...removed, status: asrInstallSnapshot() });
    } catch (error) {
      return json(res, 500, { error: `删除失败：${String(error?.message ?? error)}` });
    }
  });
  router.add('POST', '/api/asr/install', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    try {
      const started = startAsrInstall();
      auditWrite('asr.install', '', { req, after: started });
      return json(res, 202, started);
    } catch (error) {
      auditWrite('asr.install', '', { req, ok: false, error: String(error?.message ?? error) });
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/asr-key', async (req, res, params, url) => {
    if (!keyEndpointAllowed(req)) {
      return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
    }
    const field = String(url.searchParams.get('field') || 'apiKey');
    const allowed = { apiKey: 'apiKey', secretId: 'secretId', secretKey: 'secretKey' };
    if (!Object.hasOwn(allowed, field)) return json(res, 400, { error: `未知字段：${field}` });
    const cfgNow = getConfig();
    const cred = asrCredentials(cfgNow);
    // 表单里刚切换、还没保存时，「显示」要回显**目标槽位**那把（与界面上的掩码同源）：
    // 直接按已保存配置解析会把上一家的明文显示在新服务名下（2026-10-02 全量审查实测），
    // 用户点一下「显示」再保存就把那家 Key 绑给了新的服务。目标槽位与当前槽位不一致时
    // 只认"明确属于目标槽位"的（映射 + 归属钉匹配），归属未知的不给别家回显。
    const slot = String(url.searchParams.get('slot') || '').trim().toLowerCase();
    if (slot && slot !== String(cred.slot || '').toLowerCase()) {
      const target = asrCredentialForSlot(cfgNow.asr, field, slot);
      return json(res, 200, { apiKey: target.owned ? target.value : '' });
    }
    // 回读的是**当前这家实际会用的**那一把（活动槽，或"这家存过的"）
    return json(res, 200, { apiKey: cred[field] || '' });
  });
  router.add('POST', '/api/providers/fetch-models', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
      const submitted = String(body.apiKey ?? '').trim();
      // 掩码 / 空 → 用服务端已保存的 Key，但仅限配置里已知的地址（见 storedKeyAllowedFor）。
      const apiKey = (submitted && submitted !== '******')
        ? submitted
        : (storedKeyAllowedFor(cfgNow, baseUrl) ? String(cfgNow.api.apiKey || '') : '');
      const models = await fetchModelsFrom(baseUrl, apiKey);
      return json(res, 200, { ok: true, models });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/test-one', async (req, res) => {
    try {
      const body = await readBody(req);
      const result = await testOneProvider({
        providerId: String(body.providerId ?? ''),
        baseUrl: String(body.baseUrl ?? ''),
        apiKey: String(body.apiKey ?? '')
      });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/test-chat', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const submitted = String(body.apiKey ?? '').trim();
      const baseUrl = String(body.baseUrl ?? '');
      // 掩码 / 空 → 说明客户端没有新 Key，用服务端已保存的；但只发往配置里已知的地址
      // （见 storedKeyAllowedFor：否则等于把明文 Key 送到调用方指定的任意主机）。
      const apiKey = (submitted && submitted !== '******')
        ? submitted
        : (storedKeyAllowedFor(cfgNow, baseUrl) ? resolveApiKey(cfgNow) : '');
      const result = await testModelChat({
        baseUrl,
        apiKey,
        model: String(body.model ?? '')
      });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/probe-thinking', async (req, res) => {
    try {
      const body = await readBody(req);
      // 支持用"未保存的当前选择"实测：thinking 传字符串或按用途对象；
      // extraBody 传对象。类型不合法一律忽略（回落到已保存配置）。
      const thinkingInput = (typeof body.thinking === 'string'
        || (body.thinking && typeof body.thinking === 'object' && !Array.isArray(body.thinking)))
        ? body.thinking : undefined;
      const extraInput = (body.extraBody && typeof body.extraBody === 'object' && !Array.isArray(body.extraBody))
        ? body.extraBody : undefined;
      const baseUrlIn = String(body.baseUrl ?? '');
      const submitted = String(body.apiKey ?? '').trim();
      // 与「测试连通性」「获取列表」同一条守卫：掩码/空 Key 时只把服务端已存的明文 Key
      // 发给配置里已知的地址——不能因为调用方随手填个地址就把 Key 送出去（终审发现漏了这条）。
      const apiKeyResolved = (submitted && submitted !== '******')
        ? submitted
        : (storedKeyAllowedFor(getConfig(), baseUrlIn || getConfig().api.baseUrl) ? resolveApiKey(getConfig()) : '');
      const result = await probeThinking({
        providerId: String(body.providerId ?? ''),
        model: String(body.model ?? ''),
        thinking: thinkingInput,
        extraBody: extraInput,
        baseUrl: baseUrlIn,
        apiKey: apiKeyResolved
      });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers', async (req, res) => {
    try {
      const body = await readBody(req);
      const r = upsertProvider({
        baseUrl: String(body.baseUrl ?? ''),
        apiKey: String(body.apiKey ?? ''),
        models: body.models || [],
        preset: String(body.preset ?? '')
      });
      auditWrite('providers.upsert', String(r.provider?.id ?? ''), { req, after: sanitizeProvider(r.provider) });
      return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
    } catch (error) {
      auditWrite('providers.upsert', '', { req, ok: false, error: String(error?.message ?? error) });
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/models', async (req, res) => {
    try {
      const body = await readBody(req);
      const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
      if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
      auditWrite('providers.models.add', String(body.providerId ?? ''), { req, after: sanitizeProvider(p) });
      return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
    } catch (error) {
      auditWrite('providers.models.add', '', { req, ok: false, error: String(error?.message ?? error) });
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', '/api/providers/models', async (req, res) => {
    try {
      const body = await readBody(req);
      const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
      if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
      auditWrite('providers.models.remove', String(body.providerId ?? ''), { req, after: sanitizeProvider(p) });
      return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
    } catch (error) {
      auditWrite('providers.models.remove', '', { req, ok: false, error: String(error?.message ?? error) });
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/providers/set-key', async (req, res) => {
    const body = await readBody(req);
    const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
    if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
    // 只记 hasKey（明文 Key 由 core 的脱敏链兜底，即使误传也不会落盘）
    auditWrite('providers.key.set', String(body.providerId ?? ''), { req, after: { hasKey: !!updated.apiKey } });
    return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
  });
  router.add('POST', '/api/providers/test-all', async (req, res) => {
    const results = await testAllProviders(currentProviders());
    const okCount = Object.values(results).filter((r) => r.ok).length;
    return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
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
  router.add('GET', '/api/tts/key', async (req, res) => {
    const cfgNow = getConfig();
    // 显示当前这家的明文 Key（与模型 API 的「显示密钥」同一道守卫：本机控制台或带令牌）
    if (!keyEndpointAllowed(req)) return json(res, 403, { ok: false, error: '只能在控制台里查看密钥' });
    const svcId = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('service') || '');
    const key = ttsKeyFor(cfgNow.tts, svcId);
    return json(res, 200, { ok: true, apiKey: key });
  });
  router.add('POST', '/api/tts/models', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const provider = String(body.provider || cfgNow.tts?.provider || 'openai').trim().toLowerCase();
      if (provider !== 'openai') {
        // 火山（v1/v3）与 MiniMax 没有"列模型"的公开接口：模型名/音色按服务商文档内置。
        // 这里如实说明该填什么，而不是回空列表让界面显示"共 0 个"（2026-09-28 用户实测反馈）。
        const svc = ttsServiceOfBaseUrl(body.baseUrl || cfgNow.tts?.baseUrl || '')
          || TTS_SERVICES.find((s) => s.provider === provider);
        return json(res, 200, {
          ok: true,
          models: [],
          ttsOnly: false,
          unsupported: true,
          total: 0,
          note: svc?.note || '这一家没有可拉的模型列表：按服务商文档填模型名与音色。'
        });
      }
      const baseUrl = String(body.baseUrl || cfgNow.tts?.baseUrl || '').trim();
      const submitted = String(body.apiKey ?? '').trim();
      const norm = (v) => String(v || '').trim().replace(/[/]+$/, '').toLowerCase();
      const apiKey = (submitted && submitted !== '******')
        ? submitted
        : (norm(baseUrl) === norm(cfgNow.tts?.baseUrl) ? ttsKeyFor(cfgNow.tts) : '');
      const all = await fetchModelsFrom(baseUrl, apiKey);
      const isTtsModel = (id) => {
        const name = String(id);
        if (/whisper|sensevoice|asr|recognition|stt|transcri/i.test(name)) return false;   // ASR 不是 TTS
        return /tts|text.?to.?speech|speech.?synth|cosyvoice|moss|voice/i.test(name);
      };
      const models = all.filter(isTtsModel).sort((a, b) => a.localeCompare(b));
      return json(res, 200, {
        ok: true,
        models: models.length ? models : [...all].sort((a, b) => a.localeCompare(b)),
        ttsOnly: models.length > 0,
        total: all.length
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/tts/test', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const text = String(body.text ?? '').trim().slice(0, 120) || '你好呀，我是群里的小鲸鱼，这是一条试听。';
      if (cfgNow.tts?.enabled !== true) return json(res, 400, { ok: false, error: '语音回复未启用（勾上并保存后再试听）' });
      const { buffer, format } = await synthesizeSpeech({ cfg: cfgNow.tts, text });
      return json(res, 200, { ok: true, format, audio: buffer.toString('base64') });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // 显示「图片生成」当前生效的明文 Key（与 TTS/模型 API 同一道守卫：本机控制台或带令牌）。
  // 2026-09-30 审查：界面上有「显示」按钮却没有这条路由，点了没反应、已存的 Key 读不回来。
  router.add('GET', '/api/imagegen/presets', async (req, res) => json(res, 200, { ok: true, services: IMAGEGEN_SERVICES }));

  router.add('GET', '/api/imagegen/key', async (req, res, params, url) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { ok: false, error: '只能在控制台里查看密钥' });
    const cfgNow = getConfig();
    // 同 /api/asr-key：表单里换到**别的主机**（还没保存）时，回显那个主机存过的那把；
    // 按已保存配置解析会把当前那家的明文显示在新选的主机名下（2026-10-02 全量审查）。
    const askedHost = String(url.searchParams.get('host') || '').trim().toLowerCase();
    const effHost = imageGenEffectiveHost(cfgNow.imageGen, cfgNow.api);
    if (askedHost && askedHost !== effHost) {
      return json(res, 200, { ok: true, apiKey: imageGenKeyOwnedBy(cfgNow.imageGen, askedHost), reused: false, error: '' });
    }
    const auth = resolveImageGenAuth({
      imageGen: cfgNow.imageGen,
      api: cfgNow.api,
      apiKey: resolveApiKey(cfgNow)
    });
    // 「同域复用」时 auth.key 回的是**聊天模型那把 Key**：不能填进「图片生成」的输入框 ——
    // 保存只挡 '******'，一旦回显，用户点一次「保存设置」就把模型 Key 固化成 imageGen
    // 自有的 Key，"只发给同域"这条守卫从此对它失效（2026-10-01 审查 P2）。
    // 复用本来就是"留空即生效"，不需要明文；真要读模型 Key 去「模型 API」那边读。
    return json(res, 200, {
      ok: true,
      apiKey: auth.reused ? '' : (auth.key || ''),
      reused: auth.reused === true,
      error: auth.error || ''
    });
  });

  router.add('POST', '/api/imagegen/test', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const prompt = String(body.prompt ?? '').trim().slice(0, 200) || '一只橘猫戴着草帽坐在海边，卡通风格';
      if (cfgNow.imageGen?.enabled !== true) return json(res, 400, { ok: false, error: '图片生成未启用（勾上并保存后再试）' });
      if (!imageGenAvailable(cfgNow)) return json(res, 400, { ok: false, error: '还没配好：至少要填模型；地址留空表示与聊天模型同域' });
      // 试画不落库、不占闸门（它是"验证配置对不对"，不是真用）；计费由服务商算，所以提示里写明。
      const { buffer } = await generateImage({
        cfg: cfgNow,
        apiCfg: cfgNow.api,
        apiKey: resolveApiKey(cfgNow),
        prompt
      });
      // 按实际字节写 MIME：各家回的不一样（智谱 CogView 回 JPEG），写死 png 的话
      // 右键「图片另存为」会存成"扩展名 .png 的 JPEG"。
      const mime = imageType(buffer) || 'image/png';
      return json(res, 200, {
        ok: true,
        bytes: buffer.length,
        mime,
        image: `data:${mime};base64,${buffer.toString('base64')}`
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('POST', '/api/model-prices/probe', async (req, res) => {
    const cfgNow = getConfig();
    const body = await readBody(req);
    const target = String(body.url || cfgNow.api?.baseUrl || '').trim();
    const probe = await probeChannelPrices({
      url: target,
      usdRate: body.usdRate,
      fetchImpl: undefined,
      timeoutMs: Math.min(30000, Math.max(3000, Number(body.timeoutMs) || 12000))
    });
    return json(res, 200, {
      ok: probe.ok,
      kind: probe.kind,
      sourceUrl: probe.sourceUrl,
      usdRate: probe.usdRate,
      group: probe.group,
      groupRatio: probe.groupRatio,
      modelCount: probe.modelCount,
      skipped: probe.skipped,
      tried: probe.tried,
      error: probe.error,
      vendor: vendorOfConfig(cfgNow) || '',
      prices: capPrices(probe.prices || {})
    });
  });
  router.add('POST', '/api/channel-prices', async (req, res) => {
    const body = await readBody(req);
    const vendor = String(body.vendor || '').trim();
    const feedUrl = String(body.url || '').trim();
    if (!vendor) return json(res, 400, { error: '缺少渠道名（vendor）' });
    if (!/^https?:\/\//i.test(feedUrl)) return json(res, 400, { error: '价目表 URL 必须以 http(s):// 开头' });
    // 先写配置（意图），再拉一次（结果）
    const current = getConfig();
    const feeds = Array.isArray(current.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
    const auditBeforeFeeds = structuredClone(feeds);   // feeds 是配置里的活引用，先拍审计快照
    const next = feeds.filter((f) => String(f?.vendor || '').trim() !== vendor);
    next.push({ vendor, url: feedUrl });
    updateConfig({ api: { ...(current.api || {}), channelPriceFeeds: next } });
    const status = await refreshChannelFeed(vendor, feedUrl);
    auditWrite('channel-prices.save', vendor, { req, before: auditBeforeFeeds, after: next });
    return json(res, 200, { ok: true, feeds: status });
  });
  router.add('POST', '/api/channel-prices/refresh', async (req, res) => {
    const body = await readBody(req);
    const vendor = String(body.vendor || '').trim();
    const current = getConfig();
    const feeds = Array.isArray(current.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
    const hit = feeds.find((f) => String(f?.vendor || '').trim() === vendor);
    if (!hit) return json(res, 404, { error: `没有这个渠道的价目表：${vendor}` });
    const status = await refreshChannelFeed(vendor, String(hit.url || '').trim());
    return json(res, 200, { ok: true, feeds: status });
  });
  router.add('POST', '/api/channel-prices/remove', async (req, res) => {
    const body = await readBody(req);
    const vendor = String(body.vendor || '').trim();
    if (!vendor) return json(res, 400, { error: '缺少渠道名（vendor）' });
    const current = getConfig();
    const feeds = Array.isArray(current.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
    updateConfig({
      api: {
        ...(current.api || {}),
        channelPriceFeeds: feeds.filter((f) => String(f?.vendor || '').trim() !== vendor)
      }
    });
    const status = removeChannelFeed(vendor);
    return json(res, 200, { ok: true, feeds: status });
  });
  router.add('POST', '/api/model-prices/refresh', async (req, res) => {
    const st = await refreshPriceFeed(getConfig().api?.priceRemoteUrl || '');
    return json(res, 200, { ok: st.ok, ...modelPricesPayload() });
  });
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
  router.add('GET', '/api/persona-templates', async (req, res) => {
    const { PERSONAS } = await import('../personas.js');
    const builtins = Object.entries(PERSONAS).map(([id, p]) => ({
      id, name: p.name, text: p.text, behaviorProfile: p.behaviorProfile || 'legacy', builtin: true
    }));
    const customs = (getConfig().customPersonas || []).map((p, i) => ({
      id: `custom_${i}`,
      name: p.name,
      text: p.text,
      customRules: p.customRules || '',
      behaviorProfile: p.behaviorProfile || 'legacy',
      builtin: false
    }));
    return json(res, 200, { templates: [...builtins, ...customs] });
  });
  router.add('POST', '/api/persona-templates', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const name = String(body.name ?? '').trim().slice(0, 50);
    const text = String(body.text ?? '').trim();
    if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
    const { normalizeBehaviorProfile } = await import('../personas.js');
    let behaviorProfile;
    try {
      behaviorProfile = normalizeBehaviorProfile(body.behaviorProfile);
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
    // customRules 允许为空
    const entry = { name, text, behaviorProfile };
    if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
    const next = [...(getConfig().customPersonas || []), entry];
    updateConfig({ customPersonas: next });
    return json(res, 200, { ok: true, templates: next });
  });
  router.add('POST', '/api/persona/reset-handoffs', async (req, res) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    const body = await readBody(req).catch(() => ({}));
    // 破坏性操作统一 confirm 门槛（与删表情/删记忆那批接口同款）
    if (body?.confirm !== true) {
      return json(res, 409, { error: '清空交接是破坏性操作：请带 confirm=true 再调用（控制台按钮已带）' });
    }
    // 范围要含"只有交接、还没有聊天记录"的会话（记忆目录里可能有 group_*/private_*）
    const chats = [...new Set([...store.listChats(), ...(memory.listChats?.() || [])])];
    let closed = 0;
    for (const chatKey of chats) {
      try { memory.clearHandoff(chatKey); } catch { /* 单个会话失败不阻断其余 */ }
      try { if (store.closeConversationThread(chatKey, 'persona-changed')) closed += 1; } catch { /* 没有线程就跳过 */ }
    }
    // 在途运行会在结束时把"它那一轮"的交接写回来（那一轮用的是换卡前的提示词）：
    // 明确告诉调用方，必要时过一会儿再点一次（2026-09-27 审查 P2）
    const runs = Number(orchestrator?.activeRuns?.size ?? 0) || 0;   // chatKey -> sessionId
    log(`[persona] 换了人设：已清空 ${chats.length} 个会话的交接与线程状态`
      + (runs > 0 ? `（另有 ${runs} 个运行进行中，结束后会写回它们那轮的交接，可稍后再清一次）` : ''));
    return json(res, 200, {
      ok: true,
      chats: chats.length,
      threadsClosed: closed,
      activeRuns: runs,
      note: runs > 0 ? '有正在进行的会话：它们结束时会写回换卡前那轮的交接，建议过几分钟再清一次' : ''
    });
  });
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
      const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
      let entry;
      if (existing) {
        existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
        existing.baseUrl = baseUrl;
        existing.type = type;
        existing.model = String(body.model ?? existing.model ?? '').trim();
        existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
        existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
        // 掩码/空 = 保持原 Key 不变
        const submitted = String(body.apiKey ?? '').trim();
        if (submitted && submitted !== '******') existing.apiKey = submitted;
        entry = existing;
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

  router.add('GET', '/api/status', async (req, res) => {
    const dayKey = todayKey();
    const sessionUsage = sessions.todayUsage(dayKey);
    const dailyStats = buildUsageStats({ range: 'today' });
    const totals = dailyStats.totals;
    const usage = {
      dayKey,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      cachedTokens: totals.cachedTokens,
      runs: sessionUsage.runs,
      webSearchCount: dailyStats.searchCount,
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
      cacheHitRate: totals.cacheHitRate,
      webSearchCount: usage.webSearchCount || 0,
      // 前端构建戳：轮询时发现它变了 → 前端提示"控制台已更新，点击刷新"
      uiBuild: UI_BUILD,
      // 当前版本号（package.json 的 version）：控制台侧栏与控制页的版本徽标用它。
      // 之前控制页只显示部署提交号（sha），用户看不出"这是哪个版本"。
      version: PKG.version,
      // 省 Token 模式：模式 + 每项的"用户值 / 生效值"（设置页渲染用）
      tokenSaver,
      ...(cfgNow.timeControl?.enabled ? {
        timeControl: timeControlState(cfgNow.timeControl)
      } : {}),
      paused: orchestrator.paused,
      pauseReason: orchestrator.pauseReason ?? null
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
  router.add('GET', '/api/config', async (req, res) => {
    const cfgNow = getConfig();
    // 不把任何真实 Key 暴露给前端：递归清空所有密钥类字段，用 hasKey 表示"有密钥"。
    // 注意：不要用手工逐字段列举——之前漏了 5 个搜索 Key 和 2 个 SnowLuma 令牌，
    // 加新 provider 时还会继续漏。这里按字段名模式统一处理。
    const safe = safeConfigWithAsrStatus(cfgNow);
    return json(res, 200, safe);
  });
  router.add('POST', '/api/config', async (req, res) => {
    const cfgNow = getConfig();
    // 审计（#5）：getConfig() 返回引用，patch 应用后会被就地改写 —— 必须先拍快照，
    // 否则 before 会被写成 after（等于没记；方案附录 J.2）。
    const auditBefore = structuredClone(cfgNow);
    const patch = await readBody(req);
    // ── 整节替换（{ __replace__: X }）会把"映射由服务端维护"整条绕过：deepMerge 直接换成
    //    客户端对象，我们算好的 keys 被丢掉，客户端于是能把 keys 映射写进配置（2026-10-02
    //    全量审查实测：`{asr:{__replace__:{keys:{'openai|evil…':{apiKey:'ATK'}}}}}` 落盘成功）。
    //    这里把服务端算好的映射**钉回替换对象**：整节替换语义保留，但 keys 仍归服务端。
    const stampServerKeys = (section, nextKeys) => {
      const node = patch?.[section];
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const replaced = node.__replace__;
      if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) replaced.keys = nextKeys;
      node.keys = nextKeys;
    };
    // 整节替换下 deepMerge 只取替换体，节点层的删改/读取都落不到最终配置上 —— 凡是要"动这一节"
    // 的地方都取**有效体**：有对象替换体就用它，否则用节点本身。不这样，替换体里的归属钉会直接
    // 生效（delete 删不到）、`api.__replace__.baseUrl` 也让 pin 读不到新地址（2026-10-02 推前复审实测）。
    const sectionBody = (node) => (node && typeof node === 'object' && !Array.isArray(node)
      && node.__replace__ && typeof node.__replace__ === 'object' && !Array.isArray(node.__replace__)
      ? node.__replace__
      : node);
    // ── api 的两个"逃生口"文本域：提交内容与当前值的**脱敏形态**逐字相同时，当作没改 ──
    // extraBody / thinkingParams 在界面上是文本域，用脱敏视图回填、保存时原样 __replace__ 提交。
    // 脱敏会把对象形态的密钥字段换成 hasXxx（F6 的修复），于是"打开设置页什么都不改直接保存"
    // 就会把真配置覆盖成 {normal:'ok', hasAuthorization:true} —— 用户的自定义请求头没了，
    // 还多一个 hasAuthorization 进请求体（2026-10-04 复审 P2 实测）。
    // 判据与 Key 字段的掩码语义同款：脱敏视图原样回传 = "没动过"。
    // 用户真要删某个字段时提交内容与脱敏形态不同（少了那项），照样生效 —— 不影响"清空"。
    // ⚠️ 光有"逐字相同→没改"还不够（2026-10-04 复审 P2）：用户在**同一个框里改了别的字段**
    // 再保存，提交内容 ≠ 脱敏形态 → 守卫不删 → hasXxx 占位照样整键落盘 —— 真请求头被替换掉、
    // hasAuthorization 还会以最高优先级并进每一次模型请求。所以凡是提交里出现 hasXxx、
    // 而服务端现值里有对应的真键，就把真值**回填**回去（等价于"掩码 = 保持原值"的 Key 语义）。
    const unmaskSubmitted = (submitted, current) => {
      // 数组也要逐元素回填：`{headers:[{authorization:…}]}` 这种形态，脱敏后元素里只剩
      // `hasAuthorization`，不回填就会带着占位整段替换掉真值 —— 真 Key 静默丢失
      //（2026-10-05 复审实测：__replace__ 提交后盘上只剩 hasAuthorization）。
      // 按下标配对是启发式：用户重排数组元素时可能把旧值填到别的元素上（占位键本来就是
      // 脱敏产物，宁可保错也不能丢）。
      if (Array.isArray(submitted)) {
        const curArr = Array.isArray(current) ? current : [];
        return submitted.map((item, i) => unmaskSubmitted(item, curArr[i]));
      }
      if (!submitted || typeof submitted !== 'object') return submitted;
      const cur = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
      const out = { ...submitted };
      for (const key of Object.keys(out)) {
        const value = out[key];
        if (/^has[A-Z]/.test(key)) {
          const realKey = key.charAt(3).toLowerCase() + key.slice(4);
          // ⚠️ 提交里同时带了真值（用户在这个框里填了新 Key）时**真值优先**：无条件回填
          // 服务端旧值会把刚填的新 Key 悄悄丢掉（2026-10-04 复审 P2）。
          // 视图本身不含这些字段（脱敏是整条删除 + hasXxx 标记），所以"提交里有 realKey"
          // 就等于用户真的填了新值，不存在"回传掩码"的干扰。
          if (!Object.hasOwn(out, realKey) && Object.hasOwn(cur, realKey)) {
            out[realKey] = structuredClone(cur[realKey]);
          }
          if (Object.hasOwn(cur, realKey)) delete out[key];
          continue;
        }
        if (value && typeof value === 'object' && Object.hasOwn(cur, key)) {
          out[key] = unmaskSubmitted(value, cur[key]);
        }
      }
      return out;
    };
    if (patch?.api && typeof patch.api === 'object') {
      const apiGuard = sectionBody(patch.api);
      const sanitizedApi = sanitizeConfigSecrets({ api: cfgNow.api || {} }).api || {};
      for (const field of ['extraBody', 'thinkingParams']) {
        const raw = apiGuard[field];
        if (raw === undefined) continue;
        const isReplace = raw && typeof raw === 'object' && !Array.isArray(raw) && '__replace__' in raw;
        const submitted = isReplace ? raw.__replace__ : raw;
        if (stableJson(submitted) === stableJson(sanitizedApi[field])) {
          // 视图原样回传 = 用户没动这个框 → 整项当没改（快速路径）。
          // ⚠️ 两种形态都要 delete：非 __replace__ 时前端会在「JSON 解析失败/填了数组」
          // 的回退分支里原样回传脱敏视图（ui/pages/settings-save.js "已保留原值"），
          // 把它 clone 进 patch 就等于把视图里的 hasXxx 占位**落盘**，
          // 之后每次模型请求都被 Object.assign(body, extraBody) 带上
          //（2026-10-05 复审实测：盘上出现 hasAuthorization:true）。
          delete apiGuard[field];
          continue;
        }
        // 用户改了内容：把视图里的 hasXxx 占位换回服务端真值再落盘
        const healed = unmaskSubmitted(submitted, cfgNow.api?.[field]);
        if (isReplace) raw.__replace__ = healed;
        else apiGuard[field] = healed;
      }
    }
    // 控制台保存总会带上显式的 provider（来自服务预设）：等于用户确认过这一家，
    // 清掉"升级默认值"的标记，让环境变量 Key 恢复生效（2026-09-26 审查 P2）。
    // 要删在**有效体**上：整节替换时节点层的 delete 落不到最终配置上，替换体里那份
    // providerDefaulted 会一路进 deepMerge 落盘，永久屏蔽 ASR_API_KEY 环境变量（2026-10-04 复审 P2）。
    if (patch?.asr && typeof patch.asr === 'object') delete sectionBody(patch.asr).providerDefaulted;
    // tts 的 Key 与 asr 同款语义：留空/掩码占位 = 保持原值（掩码回写会把真 Key 冲掉）
    if (patch?.tts && typeof patch.tts === 'object') {
      const ttsBody = sectionBody(patch.tts);
      // 服务端派生位（GET 时下发的布尔/归属口径）：不回写配置（2026-09-29 审查 P2，
      // 之前 keyServices/currentService 会随保存被持久化进 config.json）
      delete ttsBody.hasApiKey;
      delete ttsBody.keyServices;
      delete ttsBody.currentService;
      // 归属钉同样由服务端算：客户端直接送 apiKeyService 就能把别家的旧 Key 改绑到当前这家，
      // 而 ttsKeyFor 会照新归属把它发出去（与 asr/imageGen 同一条防线，这里原先漏了）
      delete ttsBody.apiKeyService;
      delete ttsBody.hasApiKeyService;
      // 前端只送"这一家新填的 Key"（apiKeyInput）与当前服务：合并进 keys 映射，
      // 绝不接受整份 keys 覆盖（那会把别家的 Key 冲掉）。空/掩码 = 保持不变。
      const keyInput = String(ttsBody.apiKeyInput ?? '').trim();
      delete ttsBody.apiKeyInput;
      delete ttsBody.keys;
      // Key 归属 = UI 选中那家（service），地址反查只作兜底。之前只按地址认：
      // 「自定义/自建」的地址不在预设表里 → 落到 provider 字符串 'openai'，
      // 运行时又读不到 keys['openai']（2026-09-29 审查 P0）
      const uiService = ttsServiceById(String(ttsBody.service || '').trim())?.id || '';
      delete ttsBody.service;
      const svc = ttsServiceOfBaseUrl(ttsBody.baseUrl || cfgNow.tts?.baseUrl || '');
      const targetId = svc?.id || uiService || String(ttsBody.provider || cfgNow.tts?.provider || 'openai');
      const nextTtsKeys = keyInput && keyInput !== '******'
        ? { ...(cfgNow.tts?.keys || {}), [targetId]: keyInput }
        : { ...(cfgNow.tts?.keys || {}) };
      ttsBody.keys = nextTtsKeys;
      stampServerKeys('tts', nextTtsKeys);
      // 老客户端/手写配置不带 provider：按地址反查预设，免得火山/MiniMax 的地址走了 openai 兼容实现
      if (!ttsBody.provider && ttsBody.baseUrl) {
        const svc = ttsServiceOfBaseUrl(ttsBody.baseUrl);
        if (svc?.provider) ttsBody.provider = svc.provider;
      }
      const submittedKey = String(ttsBody.apiKey ?? '').trim();
      if (!submittedKey || submittedKey === '******') delete ttsBody.apiKey;
      // ── 单槽 Key 的归属（2026-10-03）── 必须放在上面那句之后：它把 apiKeyInput 清掉、
      //    再判"这次有没有真提交"；而"空/掩码 = 保持原值"那句会把我下面置的空串 delete 掉。
      //
      // ── 归档必须**无条件先跑**（与 imageGen/asr 同一口径，2026-10-04 复审 P1）──
      // 存量实例的 Key 只存在于 tts.apiKey 这一个字段里（keys 映射是控制台从 2026-09-29 起
      // 才写的）。之前归档写在"没填新 Key"那个分支里，于是"切服务 **并** 填一把新 Key"
      // 这条最常见的路径完全绕过了归档：那把旧 Key 留在单槽里、归属钉却被改成新服务 ——
      // 等用户再切回原服务且没填 Key 时，归属比较判成"别家的"，而 keys[原归属] 已被新 Key
      // 占位 → 不归档 → 直接置空 → **旧 Key 永久丢失**，控制台再也找不回来。
      const prevTtsKey = String(cfgNow.tts?.apiKey || '').trim();
      // 归属比较必须用"改动前"的配置：改完之后 current 已经变成新服务，拿它比会判成"就是这家的"。
      const ownerNow = String(cfgNow.tts?.apiKeyService || '').trim() || ttsServiceOf(cfgNow.tts)?.id || '';
      if (prevTtsKey && ownerNow && ownerNow !== targetId && !String(nextTtsKeys[ownerNow] || '').trim()) {
        nextTtsKeys[ownerNow] = prevTtsKey;
        ttsBody.keys = nextTtsKeys;
        stampServerKeys('tts', nextTtsKeys);
      }
      if (keyInput && keyInput !== '******') {
        // 新填的这把归属就是这一家（切回它时兜底才认）。单槽**同步换成新 Key**：
        // 只改钉不换槽的话，单槽里留的是上一家的 Key，归属钉却指着这一家 —— 与 asr/imageGen
        // 写入时"单槽装新值 + 钉指新归属"的口径反着来（2026-10-04 复审 P1）。
        ttsBody.apiKey = keyInput;
        ttsBody.apiKeyService = targetId;
      } else if (prevTtsKey && ownerNow !== targetId) {
        // 切到**没存过 Key** 的服务且没填 → 不沿用上一家的单槽 Key（与 asr/imageGen 同一口径）。
        // ⚠️ 置空串才是"清空"：delete 只是"这次不提交"（空/掩码 = 保持原值）。
        ttsBody.apiKey = '';
        ttsBody.apiKeyService = '';
      }
    }
    // imageGen 的 Key：与 tts 同款语义（留空/掩码 = 保持原值）。前端已按此过滤，
    // 这里再兜一层 —— 配置是外部可编辑的，别让一次手写的空串把 Key 冲掉。
    // （派生结论 available/hasApiKey 的剥离在 migrateConfig：那是所有写入路径的必经口，
    //   也顺带兜住读盘 —— 与 asr 同款，见 IMAGEGEN_DERIVED_KEYS 的说明）
    if (patch?.imageGen && typeof patch.imageGen === 'object') {
      const imgBody = sectionBody(patch.imageGen);
      // 服务端派生的布尔/归属口径：不回写配置
      delete imgBody.keyStale;
      delete imgBody.keyHosts;
      // keys 映射由服务端维护：客户端只送"这一家新填的 Key"（apiKey），绝不接受整份覆盖
      // （那会把别家存过的 Key 冲掉 —— 与 tts.keys 同款口径，2026-10-02）。
      // apiKeyHost 同款：归属钉一律由服务端按"本次提交的地址/凭据"重算 —— 客户端直接送它
      // 就能把旧 Key 的归属改到别的主机，等于绕过归属守卫（2026-10-02 全量审查实测）。
      delete imgBody.keys;
      delete imgBody.apiKeyHost;
      // 目标主机：按本次提交的地址算（没有就用当前地址；留空 = 跟聊天模型同家）。
      // ⚠️ 模型地址要用**本次 patch 之后**的值：同一次 POST 里既改 api.baseUrl 又填图 Key 时，
      // 用改动前的地址会把 Key 钉到旧主机（运行期按新地址找不到它；换回旧主机时又把它发给旧主机）。
      // 2026-10-02 全量审查实测的"保存期归属与运行期不一致"；`api.__replace__.baseUrl` 同样算数。
      const apiBody = sectionBody(patch.api);
      const nextApiBase = apiBody && apiBody.baseUrl !== undefined ? apiBody.baseUrl : cfgNow.api?.baseUrl;
      const keyTargetHost = pinImageGenKeyHost(
        { baseUrl: imgBody.baseUrl ?? cfgNow.imageGen?.baseUrl ?? '' },
        nextApiBase
      );
      const nextKeys = { ...(cfgNow.imageGen?.keys || {}) };
      // 归档：当前活动槽那把先记到它自己的主机名下 —— 老配置只有单槽（升级上来的实例），
      // 不归档就会在"切到别家并新填一把"时被覆盖丢掉，切回来再也取不回。
      const prevKey = String(cfgNow.imageGen?.apiKey || '').trim();
      const prevHost = String(cfgNow.imageGen?.apiKeyHost || '').trim().toLowerCase();
      if (prevKey && prevKey !== '******' && prevHost && !String(nextKeys[prevHost] || '').trim()) {
        nextKeys[prevHost] = prevKey;
      }
      const submittedKey = String(imgBody.apiKey ?? '').trim();
      if (submittedKey && submittedKey !== '******') {
        // 新填的 Key：记为当前活动 Key（归属钉照旧）＋ 存进"这家存过的"映射，切回来能自动取回
        if (keyTargetHost) nextKeys[keyTargetHost] = submittedKey;
        imgBody.keys = nextKeys;
        pinImageGenKeyHost(imgBody, nextApiBase);
      } else {
        // 留空/掩码 = "用这家存过的"（2026-10-02 用户要求）：切到哪家就取哪家存过的那把 ——
        // 存过就取回（连归属一起）；没存过就**不动现有的那把**：它由归属钉挡住使用
        // （不会发给别家），留着切回去还能用，界面按 keyHosts 显示"这家还没存过"。
        delete imgBody.apiKey;
        const resolved = imageGenKeyResolve(
          {
            ...(cfgNow.imageGen || {}),
            keys: nextKeys,
            ...(imgBody.baseUrl !== undefined ? { baseUrl: imgBody.baseUrl } : {})
          },
          keyTargetHost
        );
        if (resolved.value) {
          imgBody.apiKey = resolved.value;
          // 明确属于这个主机的才写回归属钉/补映射；"没记归属"的老单槽只用值、不认领
          if (resolved.owned) {
            nextKeys[keyTargetHost] = resolved.value;
            imgBody.keys = nextKeys;
            imgBody.apiKeyHost = keyTargetHost;
          }
        }
      }
      stampServerKeys('imageGen', nextKeys);
    }
    // ASR 的凭据：与 tts/imageGen 同款语义（2026-10-02 用户要求："切换服务预设时 Key 跟着切换"）。
    // 三种凭据（apiKey / secretId / secretKey，后者两家与讯飞百度共用字段）各按"槽位"记忆，
    // 槽位口径见 asrCredentialSlot：OpenAI 兼容按地址主机分家，其余按 provider。
    if (patch?.asr && typeof patch.asr === 'object') {
      const asrBody = sectionBody(patch.asr);
      delete asrBody.keySlots;                // 服务端派生的视图口径：不回写配置
      delete asrBody.keys;                    // 映射由服务端维护，绝不接受整份覆盖
      const curAsr = cfgNow.asr || {};
      // ⚠️ provider 必须在**写盘前**校验：它直接决定槽位名（asrCredentialSlot）。
      // 客户端送 `provider:"constructor"` 时槽位名就成了 "constructor"，而落盘的
      // keys['constructor'] 之后会让 asrKeySlots 取到 Object.prototype.constructor 并抛错，
      // **每一次读 /api/config 都 500**，且没有任何 API 能删掉那个槽位（2026-10-04 复审 P2 实测）。
      // ASR_PROVIDERS 之外的取值一律当"没改这一项"，沿用当前配置（坏输入最该被忽略）。
      const submittedProvider = String(asrBody.provider ?? '').trim().toLowerCase();
      const currentProvider = String(curAsr.provider || 'openai').trim().toLowerCase();
      const nextProvider = (submittedProvider && ASR_PROVIDERS.includes(submittedProvider))
        ? submittedProvider
        : currentProvider;
      if (asrBody.provider !== undefined && submittedProvider !== nextProvider) {
        delete asrBody.provider;   // 非法值/空串都别带进 deepMerge（空 = "这次没改这一项"）
      }
      const nextBaseUrl = asrBody.baseUrl !== undefined ? asrBody.baseUrl : (curAsr.baseUrl || '');
      const targetSlot = asrCredentialSlot(nextProvider, nextBaseUrl);
      const nextKeys = { ...(curAsr.keys || {}) };
      // 槽位条目必须是对象：手改成标量（"keys":{"tencent":"SCALAR"}）时 `{...'SCALAR'}` 会摊成
      // 字符索引的垃圾键写进配置（2026-10-02 推前复审）。migrateConfig 只归一化顶层映射，这里兜条目。
      // 目标槽与归档槽共用这一个守卫：只给目标槽加的话，归档路径仍会把标量摊成 {0:'S',1:'C',…}
      // 写进 config.json（同一段代码两套标准 = 漏改，2026-10-04 复审 P1）。
      const entryOf = (value) => (value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value } : {});
      const prevEntry = nextKeys[targetSlot];
      const slotEntry = entryOf(prevEntry);
      const credentials = [
        ['apiKey', 'apiKeyProvider', 'apiKeyHost'],
        ['secretId', 'secretIdProvider', ''],
        ['secretKey', 'secretKeyProvider', '']
      ];
      // 归属钉同款：一律由服务端按"本次提交的 provider/地址/凭据"重算 —— 客户端直接送它，
      // 就能把别家的旧凭据改绑到当前这家（或反过来），绕过归属守卫（2026-10-02 全量审查实测）。
      for (const [, providerField, hostField] of credentials) {
        delete asrBody[providerField];
        if (hostField) delete asrBody[hostField];
      }
      // 归档：活动槽里"这家还没有副本"的凭据先记到它自己的槽名下 —— 老配置只有单槽，
      // 切到别家新填凭据时会覆盖它，不归档就丢了（切回来取不回）。
      for (const [kind, providerField, hostField] of credentials) {
        const value = String(curAsr[kind] || '').trim();
        if (!value || value === '******') continue;
        // 只归档**归属明确**的那把（pin 非空）：归属未知的老凭据没有"自己的家"可记，而且用
        // 当前 provider 去猜会在同一次保存里被"取回"分支当成这家的凭据认领（推前复审实测：
        // 讯飞/百度的 secretKey 会被写回归属钉并塞进目标槽）
        const owner = String(curAsr[providerField] || '').trim().toLowerCase();
        if (!owner) continue;
        const host = hostField
          ? (String(curAsr[hostField] || '').trim().toLowerCase() || asrEndpointHost(curAsr.baseUrl))
          : '';
        const slot = asrCredentialSlotOf(owner, host);
        const entry = entryOf(nextKeys[slot]);
        if (!String(entry[kind] || '').trim()) entry[kind] = value;
        nextKeys[slot] = entry;
      }
      for (const [kind, providerField, hostField] of credentials) {
        const submitted = String(asrBody[kind] ?? '').trim();
        if (submitted && submitted !== '******') {
          // 新填的凭据：写进"这家存过的"映射 + 更新归属钉（切回来能自动取回）
          if (targetSlot) slotEntry[kind] = submitted;
          asrBody[providerField] = nextProvider;
          if (hostField) asrBody[hostField] = nextProvider === 'openai' ? asrEndpointHost(nextBaseUrl) : '';
          continue;
        }
        // 留空/掩码 = "用这家存过的"：取到就填回；**明确属于这家的**才写回归属钉/补映射 ——
        // "归属未知"的老凭据只用值、不认领（认领会把别家的凭据洗成这家的，2026-10-02 全量审查；
        // migrateConfig 的注释警告的正是这条路）。没取到就不动现有的：那把给别家存的，
        // 归属钉挡着不会被使用（切回去还能用）。
        delete asrBody[kind];
        const resolved = asrCredentialResolve(
          { ...curAsr, keys: nextKeys, baseUrl: nextBaseUrl },
          kind,
          nextProvider,
          nextBaseUrl
        );
        if (!resolved.value) continue;
        asrBody[kind] = resolved.value;
        if (!resolved.owned) continue;
        slotEntry[kind] = resolved.value;                // 取回的同时把映射补全（只补明确属于这家的）
        asrBody[providerField] = nextProvider;
        if (hostField) asrBody[hostField] = nextProvider === 'openai' ? asrEndpointHost(nextBaseUrl) : '';
      }
      if (targetSlot && Object.keys(slotEntry).length) nextKeys[targetSlot] = slotEntry;
      asrBody.keys = nextKeys;
      stampServerKeys('asr', nextKeys);
    }
    // 人设真的改了就打一个时间戳：提示词据此在接下来 24 小时里提醒模型
    // "历史里的旧口癖/自称不作数"（换卡后它会被自己的旧发言锚住，实测能锚一天以上）
    if (patch?.persona && typeof patch.persona === 'object') {
      const before = cfgNow.persona || {};
      const changed = ['roleText', 'templateId', 'behaviorProfile', 'customRules', 'botName',
        'selfNickname', 'participation']
        .some((key) => String(patch.persona[key] ?? before[key] ?? '') !== String(before[key] ?? ''));
      if (changed) patch.persona.changedAt = Date.now();
    }
    const previousProactive = JSON.stringify(cfgNow.proactive || {});
    const previousDailyMoments = JSON.stringify(cfgNow.dailyMoments || {});
    const previousQzoneInteractions = JSON.stringify(cfgNow.qzoneInteractions || {});
    const previousIdentityPilot = JSON.stringify(cfgNow.identityPilot || {});
    const previousPersona = JSON.stringify(cfgNow.persona || {});
    const previousSlangPilot = JSON.stringify(cfgNow.slangPilot || {});
    const previousIncidentPilot = JSON.stringify(cfgNow.incidentPilot || {});
    const previousIdentitySources = JSON.stringify({
      allow: cfgNow.allow || {},
      deny: cfgNow.deny || {},
      allowAllWhenEmpty: cfgNow.allowAllWhenEmpty === true,
      blocklist: cfgNow.blocklist || {}
    });
    const previousModes = new Map(
      store.listChats().map((chatKey) => [chatKey, conversationConfigForChat(chatKey).mode])
    );
    delete patch.runtime;
    if (patch.server) {
      // 整节替换（`__replace__`）时 delete 删的是节点层，替换体里的 token 会直接落盘 ——
      // 服务重启后 authorize 读不到令牌（控制台全部登出），下次 start() 还会因"绑非回环却无令牌"
      // 直接 throw 起不来（2026-10-03 全量审查）。归属与派生位一律取**有效体**处理。
      const serverBody = sectionBody(patch.server);
      // 2026-10-06 复审：替换体里的 token 必被剥（下面 delete，令牌只走专用端点）→ 整节替换后
      // server.token 必空，而运行中的套接字不随配置重绑 —— 绑 0.0.0.0 时这一保存会把监听降级为
      // "无令牌 + Host 头判本机"的免鉴权模式。运行期套接字仍在非回环地址上时，拒绝一切 server 整节替换。
      const serverReplacing = patch.server.__replace__ && typeof patch.server.__replace__ === 'object'
        && !Array.isArray(patch.server.__replace__);
      if (serverReplacing && boundServerHost && !['127.0.0.1', 'localhost', '::1'].includes(boundServerHost)) {
        // 直接回 409 而不是 throw：统一异常处理器会把一切抛错记成 error 级 incident，
        // 而这是"管理员存了个会被拒的配置"的**预期内拒绝**，不该刷异常面板
        //（2026-10-06 生产实测踩到：一次守卫验证就在 journal 和异常面板各留了一条 error）。
        return json(res, 409, {
          ok: false,
          error: '控制台正绑定在非回环地址上运行，整节替换 server 段会清空令牌且套接字不会重新绑定；请改用普通保存，或先停机改配置'
        });
      }
      delete serverBody.token;
      delete serverBody.hasToken;
    }
    // webSearch：自定义搜索服务列表 providers 是**密钥数组**，而 deepMerge 对数组是整体替换 ——
    // 界面回传的是脱敏副本（apiKey 被删、hasApiKey 被加），直接提交会把每家的 Key 冲掉
    // （2026-10-03 全量审查）。这里按 id 与服务端对齐：客户端没带新值就沿用服务端那把。
    if (patch?.webSearch && typeof patch.webSearch === 'object') {
      const wsBody = sectionBody(patch.webSearch);
      if (Array.isArray(wsBody.providers)) {
        const stored = new Map((cfgNow.webSearch?.providers || [])
          .map((item) => [String(item?.id || ''), item]));
        wsBody.providers = wsBody.providers
          .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
          .map((item) => {
            const next = { ...item };
            delete next.hasApiKey;
            const submitted = String(next.apiKey ?? '').trim();
            if (!submitted || submitted === '******') {
              const prev = stored.get(String(next.id || ''));
              if (prev && String(prev.apiKey || '').trim()) next.apiKey = prev.apiKey;
              else delete next.apiKey;
            }
            return next;
          });
      }
      // 派生位（sanitize 生成的 hasApiKey）由 migrateConfig 统一剔 —— 它是所有写入路径的必经口，
      // 路由层再剥一遍是冗余（同一语义写两处，反而会让人以为两边口径不同）。
    }
    let next;
    try {
      next = updateConfig(patch);
    } catch (error) {
      auditWrite('config.update', 'config', { req, before: auditBefore, ok: false, error: String(error?.message ?? error) });
      throw error;
    }
    auditWrite('config.update', 'config', { req, before: auditBefore, after: next, changed: changedTopKeys(auditBefore, next) });
    store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
    let closedThreads = 0;
    for (const [chatKey, previousMode] of previousModes) {
      if (conversationConfigForChat(chatKey).mode !== previousMode) {
        if (store.closeConversationThread(chatKey, 'mode-changed')) closedThreads += 1;
      }
    }
    if (closedThreads) emit('chat-update', '*');
    if (JSON.stringify(next.proactive || {}) !== previousProactive) {
      if (next.proactive?.enabled) orchestrator.startProactiveLoop();
      else orchestrator.stopProactiveLoop();
    }
    if (JSON.stringify(next.dailyMoments || {}) !== previousDailyMoments) {
      dailyMoments.reconfigure();
    }
    if (JSON.stringify(next.qzoneInteractions || {}) !== previousQzoneInteractions) {
      qzoneInteractions.reconfigure();
    }
    if (JSON.stringify(next.groupDigest || {}) !== JSON.stringify(cfgNow.groupDigest || {})) {
      groupDigest.reconfigure();
    }
    if (JSON.stringify(next.incidentPilot || {}) !== previousIncidentPilot) {
      try {
        syncIncidentPilot();
        for (const chatKey of store.listChats()) orchestrator.enforceChatControl(chatKey);
      } catch (error) {
        const reverted = updateConfig({
          incidentPilot: { ...(next.incidentPilot || {}), enabled: false }
        });
        return json(res, 500, {
          ok: false,
          error: `异常处理实验启动失败，开关已恢复为关闭：${String(error?.message ?? error)}`,
          config: safeConfigWithAsrStatus(reverted)
        });
      }
    }
    const identityChanged = JSON.stringify(next.identityPilot || {}) !== previousIdentityPilot;
    const identitySourcesChanged = JSON.stringify({
      allow: next.allow || {},
      deny: next.deny || {},
      allowAllWhenEmpty: next.allowAllWhenEmpty === true,
      blocklist: next.blocklist || {}
    }) !== previousIdentitySources;
    const personaChanged = JSON.stringify(next.persona || {}) !== previousPersona;
    if (
      identityChanged
      || (identityPilotEnabled(next) && (identitySourcesChanged || personaChanged))
    ) {
      try {
        await syncIdentityPilot({
          reindex: identitySourcesChanged,
          reconfigure: identityChanged || identitySourcesChanged || personaChanged
        });
      } catch (error) {
        const reverted = updateConfig({
          identityPilot: { ...(next.identityPilot || {}), enabled: false }
        });
        return json(res, 500, {
          ok: false,
          error: `统一身份库启动失败，开关已恢复为关闭：${String(error?.message ?? error)}`,
          config: safeConfigWithAsrStatus(reverted)
        });
      }
    }
    if (JSON.stringify(next.slangPilot || {}) !== previousSlangPilot) {
      try {
        await syncSlangPilot();
      } catch (error) {
        const reverted = updateConfig({
          slangPilot: { ...(next.slangPilot || {}), enabled: false }
        });
        return json(res, 500, {
          ok: false,
          error: `黑话语料库启动失败，开关已恢复为关闭：${String(error?.message ?? error)}`,
          config: safeConfigWithAsrStatus(reverted)
        });
      }
    }
    initPriceFeed(next.api?.priceRemoteUrl || '');   // 远程价格表 URL 可能改了（内部幂等）
    initChannelPrices(next.api?.channelPriceFeeds || []);   // 渠道价目表同理
    emit('status', { configUpdated: true });
    return json(res, 200, { ok: true, config: safeConfigWithAsrStatus(next) });
  });

  router.add('POST', '/api/group-game/stop', async (req, res) => {
    // 管理员在控制台结束某一局（局跑歪/要收场时用）：与模型调 group_game stop 走同一入口
    const body = await readBody(req);
    const chatKey = String(body?.chatKey || '').trim();
    if (!/^group:[^:\s]+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 要写成 group:<群号>' });
    const out = await groupGame.stop(chatKey, '管理员在控制台结束');
    if (!out?.ok) return json(res, 404, { ok: false, error: out?.error || '这个群没有进行中的游戏' });
    return json(res, 200, { ok: true });
  });
  router.add('POST', '/api/group-digest/run', async (req, res) => {
    try {
      const result = await groupDigest.runOnce();
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/reminders', async (req, res) => {
    // 控制台的提醒管理页：待触发全量 + 最近完成的（fired/canceled/expired）。
    // 已完成的每个会话只保留最近几条（DONE_KEEP），这里再全局截断一次。
    if (!reminders) return json(res, 200, { ok: true, enabled: false, pending: [], recent: [] });
    const enabled = getConfig().reminders?.enabled !== false;
    const fmt = (it) => ({
      id: it.id, chatKey: it.chatKey, text: it.text, status: it.status || 'pending',
      at: it.at, createdAt: it.createdAt, finishedAt: it.finishedAt || null,
      // 归属（谁提的/提醒谁）：控制台列表要显示"谁请你提醒谁"（2026-10-10 反馈）
      from: String(it.createdBy || ''), to: String(it.targetName || '')
    });
    const pending = reminders.items
      .filter((it) => it.status === 'pending')
      .sort((a, b) => a.at - b.at)
      .map(fmt);
    const recent = reminders.items
      .filter((it) => it.status && it.status !== 'pending')
      .sort((a, b) => (b.finishedAt || b.at) - (a.finishedAt || a.at))
      .slice(0, 30)
      .map(fmt);
    return json(res, 200, { ok: true, enabled, pending, recent });
  });
  router.add('POST', '/api/reminders/cancel', async (req, res) => {
    // 管理员在控制台里取消：带 id + chatKey（与聊天里"算了别提醒了"同一存储操作）
    const body = await readBody(req);
    if (!reminders) return json(res, 400, { ok: false, error: '提醒功能不可用' });
    const hit = reminders.cancel({ id: String(body?.id || ''), chatKey: String(body?.chatKey || '') });
    if (!hit) return json(res, 404, { ok: false, error: '没找到这条待触发的提醒（可能已被触发或取消）' });
    return json(res, 200, { ok: true, canceled: hit.id });
  });
  router.add('GET', '/api/incidents', async (req, res, params, url) => {
    return json(res, 200, {
      status: incidentPilotStatus(),
      incidents: incidentPilot?.list({
        state: url.searchParams.get('state') || '',
        severity: url.searchParams.get('severity') || '',
        chatKey: url.searchParams.get('chatKey') || '',
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
      ...(cfgNow.allow?.groups || []).map((id) => `group:${id}`),
      ...(cfgNow.allow?.private || []).map((id) => `private:${id}`),
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
  router.add('GET', '/api/models', async (req, res) => {
    try {
      const models = await listModels();
      return json(res, 200, { models });
    } catch (error) {
      return json(res, 502, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/sessions', async (req, res, params, url) => {
    // 上限 2^20（Kondius 钦定 1048576）：约等于不限，但拦得住真正的失控请求。
    // 前端靠分页（一次渲染 50 条）避免卡顿，后端不截断。
    const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
    const now = Date.now();
    const threadCache = new Map();
    return json(res, 200, {
      sessions: sessions.listSummaries(limit)
        .map((session) => buildSessionView(session, store, { now, threadCache }))
    });
  });
  router.add('GET', '/api/chats', async (req, res) => {
    const cfgNow = getConfig();
    const chats = store.listChats().map((key) => {
      const meta = store.getChatMeta(key);
      return {
        key,
        ...meta,
        incidentControl: incidentPilot?.getChatControl(key) || null,
        incidentDecision: incidentPilot?.chatDecision(key, meta) || null,
        ...(cfgNow.timeControl?.enabled
          ? { timeControl: timeControlState(cfgNow.timeControl, key) } : {})
      };
    })
      .sort((a, b) => b.lastTs - a.lastTs);
    // 附带群名，让 UI 能显示"群名（群号）"。
    // 群名要调 OneBot 拿，可能慢或失败 —— 用 allSettled 保证绝不影响主流程：
    // 拿不到的 chatName 为空，UI 自动退回只显示群号。
    await Promise.allSettled(chats.map(async (c) => {
      const m = /^group:(\d+)$/.exec(String(c.key || ''));
      if (!m) { c.chatName = ''; return; }
      try {
        c.chatName = await Promise.race([
          orchestrator.getChatName(m[1]),
          new Promise((r) => setTimeout(() => r(''), 3000))   // 3s 超时保护
        ]) || '';
      } catch { c.chatName = ''; }
    }));
    return json(res, 200, { chats });
  });
  router.add('POST', '/api/pause', async (req, res) => {
    const body = await readBody(req);
    const wasPaused = orchestrator.paused;
    orchestrator.setPaused(!!body.paused);
    if (body.paused) slangPilot?.abortResearch('机器人已暂停');
    else slangPilot?.resumeQueued();
    if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
      // 恢复时自动补处理暂停期间积压的未读消息
      orchestrator.drainBacklogAfterResume();
    }
    return json(res, 200, { ok: true, paused: orchestrator.paused });
  });
  router.add('DELETE', '/api/pause', async (req, res) => {
    orchestrator.setPaused(false);
    slangPilot?.resumeQueued();
    const marked = {};
    for (const chatKey of store.listChats()) {
      const n = store.drainUnread(chatKey).length;
      if (n > 0) marked[chatKey] = n;
    }
    emit('chat-update', '*');
    return json(res, 200, { ok: true, paused: false, marked });
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

  router.add('GET', /^\/api\/chats\/(group|private)_(\d+)\/unknown-operations$/, async (req, res, params) => {
    const key = `${params[1]}:${params[2]}`;
    return json(res, 200, { operations: store.listUnknownOperations(key) });
  });
  router.add('POST', /^\/api\/chats\/(group|private)_(\d+)\/unknown-operations\/([\w-]+)\/reconcile$/, async (req, res, params) => {
    const body = await readBody(req);
    if (body.confirm !== true || !['sent', 'failed'].includes(body.result)) {
      return json(res, 409, { error: '核对未知写入需要明确结果和确认' });
    }
    const key = `${params[1]}:${params[2]}`;
    try {
      const result = store.reconcileUnknownOperation(
        params[3],
        body.result
      );
      if (!result || result.chatKey !== key) {
        return json(res, 404, { error: '未知写入不存在或已核对' });
      }
      emit('chat-update', key);
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 409, { error: String(error?.message ?? error) });
    }
  });
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
        if (matched) {
          res.writeHead(304, { etag, 'cache-control': cacheControl });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': types[ext] ?? 'application/octet-stream',
          'cache-control': cacheControl,
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
      throw new Error('Console token required for LAN binding');
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
    if (getConfig().qzoneInteractions?.enabled) qzoneInteractions.start();
    if (getConfig().groupDigest?.enabled) groupDigest.start();
    groupGame.startLoop();   // 内部按配置判断是否推进；重启后从磁盘恢复进行中的局
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startScheduledWakeTicker();
    autoUpdate.start();
    log(`控制台已就绪：http://${serverCfg.host}:${port} (${getConfig().runtime.mode})`);
    // 协议端自动更新：首检延迟 2 分钟（别跟启动抢 IO），之后每 6 小时一轮；开关默认关
    clearTimeout(snowlumaAutoTimer);
    snowlumaAutoStopped = false;
    snowlumaAutoTimer = setTimeout(() => { snowlumaAutoCheck({ first: true }); }, 120_000);
    snowlumaAutoTimer.unref?.();
    log(`OneBot: ws=${getConfig().onebot?.wsUrl} http=${getConfig().onebot?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
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
    clearInterval(sseHeartbeat);
    snowlumaAutoStopped = true;
    clearTimeout(snowlumaAutoTimer);
    releaseTimeControl();
    dailyMoments.stop();
    dailyMoments.abort();
    qzoneInteractions.stop();
    // 群游戏/群日报的定时器也要停：store.close() 之后它们还在 tick 会撞已关闭的 sqlite，
    // 且群游戏 tick 会把 games.json 再写一遍（2026-10-07 复审 P3）。
    groupGame.stopLoop();
    groupDigest.stop();
    await qzoneInteractions.abort();
    autoUpdate.stop();
    identityPilot?.stop();
    identityPilot = null;
    await slangPilot?.stop();
    slangPilot = null;
    await incidentPilot?.stop();
    incidentPilot = null;
    onebot.close();
    await orchestrator.abortAll();
    await Promise.allSettled([...ingress.values()]);
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
    store.close();
  }

  return {
    server,
    onebot,
    store,
    memory,
    stickers,
    sender,
    sessions,
    orchestrator,
    dailyMoments,
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
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：60 秒（见 USAGE_CACHE_TTL_MS）。兜住"内容被改写但目录快照不变"这类边缘情况。
//      用量统计不是实时数据，1 分钟的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
// 2026-10-02 复审：缓存改成**按 range 分槽的 Map** —— 单槽时 /api/status 每 15 秒用
// range='today' 调一次（它要日统计），与用量页的 range='7' 交替覆盖同一个槽，导致 key
// 永远对不上、缓存实际从未命中（用量页每次打开仍全量扫）。分槽后各自的 TTL 独立生效。
const usageRowsCache = new Map();
const USAGE_CACHE_MAX_KEYS = 8;
const USAGE_CACHE_TTL_MS = 60000;   // 2026-10-02：20 秒 → 60 秒，打开用量页大多命中缓存；
                                    // 新会话最多晚 1 分钟进统计，换来不再每次打开都全量扫描

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs;
  } catch {
    return '';
  }
}

function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  const hit = usageRowsCache.get(sig);
  if (hit && (Date.now() - hit.at) < USAGE_CACHE_TTL_MS) {
    return {
      rows: hit.rows.slice(),
      win: win || hit.win,
      searchCount: hit.searchCount || 0,
      toolCounts: { ...(hit.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }
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

  for (const f of files) {
    const filePath = path.join(dir, f);
    if (mtimeFloor > 0) {
      try { if (fs.statSync(filePath).mtimeMs < mtimeFloor) continue; } catch { continue; }
    }
    let s;
    try { s = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
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
  const byDay = win.mode === 'days'
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
