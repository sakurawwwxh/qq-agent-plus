// Linux 服务总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { asrApiKey, asrAvailable, asrConfigured, asrKeyHost, asrKeySource, asrLocalBin, asrLocalModel, asrSecretId, asrSecretKey, conversationConfigForChat, findWhisperBinSync, getConfig, identityPilotEnabled, incidentPilotEnabled, slangPilotEnabled, updateConfig, onTimeControlChange, DATA_DIR, ROOT } from '../core/config.js';
import { tokenSaverEffective } from '../core/token-saver.js';
import { customSearch } from '../llm/web-search.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes } from '../onebot/onebot.js';
import { readForwardMessages } from '../onebot/forward-reader.js';
import { ChatStore } from '../core/store.js';
import { MemoryStore } from '../memory/memory.js';
import { StickerManager } from '../onebot/sticker-manager.js';
import { SendQueue } from '../onebot/sender.js';
import { SessionRegistry, personaLabelOfPrompt } from '../core/sessions.js';
import { Orchestrator } from '../core/orchestrator.js';
import { DailyMomentsManager } from '../features/daily-moments.js';
import { QzoneInteractionManager } from '../features/qzone-interactions.js';
import { listModels, chatCompletion, resolveApiKey, cachedTokensOfUsage } from '../llm/llm.js';
import { resolveOfficialPrice, listOfficialPrices, listModelAliases, isPeakHour, priceAt, resolveModelPrice, costModeOf, modelLabel, splitModelLabel, vendorOfConfig, UNKNOWN_VENDOR } from '../pricing/model-prices.js';
import { initPriceFeed, refreshPriceFeed, priceFeedStatus } from '../pricing/price-feed.js';
import { probeChannelPrices, capPrices } from '../pricing/price-probe.js';
import { initChannelPrices, refreshChannelFeed, removeChannelFeed, channelPriceStatus, maybeAutoProbeChannel } from '../pricing/channel-prices.js';
import { currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from '../core/providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from '../llm/vision-scan.js';
import { builtinVisionResults } from '../llm/model-vision-docs.js';
import { createEventBus, todayKey, shanghaiDayStart, sanitizeUserText } from '../core/util.js';
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
import { integrationStatus, updateSnowLumaPassword } from './integrations.js';
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
const loginThrottle = new Map();
function loginGate(req) {
  const key = String(req.socket?.remoteAddress || 'unknown');
  if (loginThrottle.size > 4096) loginThrottle.clear();
  const entry = loginThrottle.get(key);
  if (entry && entry.blockedUntil > Date.now()) {
    return { ok: false, retryAfterSec: Math.ceil((entry.blockedUntil - Date.now()) / 1000) };
  }
  return {
    ok: true,
    fail() {
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

export function createApp({ log = console.log, autoUpdateOptions = {}, asrInstaller = null } = {}) {
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
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  let incidentPilot = null;
  let incidentPilotError = '';
  let autoUpdate = null;
  const moduleLog = (source) => (...args) => {
    log(...args);
    const supplied = args.find((value) => value instanceof Error);
    const error = supplied || new Error(args.map((value) =>
      typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
    incidentPilot?.capture(error, {
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
  const orchestrator = new Orchestrator({
    store,
    memory,
    stickers,
    sender,
    sessions,
    onebot,
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
        text: String(text).slice(0, 120)
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
              text: String(local.text || '').slice(0, 120)
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
      eventKind: 'message'
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
        for (const item of list) {
          const mid = item?.message_id;
          if (mid === undefined || mid === null) continue;
          if (store.findByMid(chatKey, mid)) continue;         // 库里已有（含自己发的），跳过
          const ts = Math.round(Number(item?.time || 0) * 1000) || Date.now();
          const fresh = Date.now() - ts <= 30 * 60 * 1000;     // 半小时内的按新消息处理，更早的只补记录
          await ingestMessage(kind, id, item, !fresh);
          added += 1;
        }
        if (added) console.log(`[catchup] ${chatKey} 补进 ${added} 条（重启/断线期间漏掉的）`);
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
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
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

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    const origin = String(req.headers.origin || '');
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return false;
    if (!token) return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || '');
    const url = new URL(req.url, 'http://127.0.0.1');
    const cookie = String(req.headers.cookie || '').split(';').map((v) => v.trim())
      .find((v) => v.startsWith('qq_agent_token='));
    return sameSecret(req.headers['x-console-token'], token)
      || sameSecret(url.searchParams.get('token'), token)
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

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password …
  const SECRET_KEY_PATTERN = /(^token$|apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.providerKeys && typeof out.providerKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.providerKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.providerKeys = {};
      out.providerKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.providerKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── ASR 的运行时结论 ────────────────────────────────────────────────────
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
      if (sameSecret(req.headers['x-console-token'], token) || sameSecret(url.searchParams.get('token'), token)) return true;
    }
    // 带自定义头 → 不可能是简单跨站请求（需 CORS 预检通过才能发出）；
    // 但还要求 loopback Host：否则"控制台暴露到公网且没设令牌"时任何人都能读明文密钥。
    const host = String(req.headers.host ?? '');
    if (req.headers['x-console-token'] && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return true;

    const origin = String(req.headers.origin ?? '');
    const referer = String(req.headers.referer ?? '');
    // 与上面 x-console-token 分支、authorize 同一口径（端口可选）：config 校验允许 host='::1'，
    // 漏了 [::1] 时 IPv6 回环部署在这里会一直 403；80 端口部署的 Host 也不带端口。
    const isLoopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
    if (!isLoopbackHost) return false;
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
      ...(cfgNow.providers || []).map((p) => norm(p?.baseUrl))
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

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === '/healthz' && req.method === 'GET') {
      // 给拨测/uptime 监控用：无鉴权，但只含版本与连接状态，不带任何配置
      return json(res, 200, {
        ok: true,
        name: PKG.name,
        version: PKG.version,
        uptimeSeconds: Math.round(process.uptime()),
        onebotConnected: Boolean(onebot?.connected),
        timestamp: Date.now()
      });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
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
    }

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      if (pathname === '/api/console-token' && method === 'POST') {
        const body = await readBody(req);
        const current = String(body.currentToken ?? '');
        const next = String(body.newToken ?? '').trim();
        const confirm = String(body.confirmToken ?? '').trim();
        if (!sameSecret(current, cfgNow.server.token)) {
          return json(res, 403, { error: '当前 Token 不正确' });
        }
        if (!/^[A-Za-z0-9._~-]{16,128}$/.test(next)) {
          return json(res, 400, { error: '新 Token 必须为 16-128 位字母、数字或 . _ ~ -' });
        }
        if (next !== confirm) return json(res, 400, { error: '两次输入的新 Token 不一致' });
        if (sameSecret(next, cfgNow.server.token)) return json(res, 400, { error: '新 Token 不能与当前 Token 相同' });
        updateConfig({ server: { token: next } });
        let accessFileUpdated = true;
        try { writeConsoleAccess(next); }
        catch (error) {
          accessFileUpdated = false;
          log('[console] Token 已更新，但 console-access.txt 写入失败:', error?.message ?? error);
        }
        setConsoleCookie(res, next);
        for (const client of sseClients) client.end();
        sseClients.clear();
        return json(res, 200, { ok: true, accessFileUpdated });
      }

      if (pathname === '/api/integrations/status' && method === 'GET') {
        return json(res, 200, await integrationStatus());
      }

      if (pathname === '/api/integrations/snowluma/password' && method === 'POST') {
        const body = await readBody(req);
        try {
          return json(res, 200, await updateSnowLumaPassword(body));
        } catch (error) {
          return json(res, error.httpStatus || 502, {
            error: String(error?.message ?? error)
          });
        }
      }

      if (pathname === '/api/auto-update/status' && method === 'GET') {
        return json(res, 200, autoUpdate.status());
      }

      if (pathname === '/api/auto-update/settings' && method === 'PUT') {
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
      }

      if (pathname === '/api/auto-update/run' && method === 'POST') {
        const body = await readBody(req);
        if (body.confirm !== true) {
          return json(res, 409, { error: '手动更新需要显式确认' });
        }
        try {
          const status = autoUpdate.requestManual({ version: body.version });
          return json(res, 202, { ok: true, status });
        } catch (error) {
          return json(res, error.httpStatus || 409, {
            error: String(error?.message ?? error)
          });
        }
      }

      if (pathname === '/api/auto-update/resume' && method === 'POST') {
        const body = await readBody(req);
        if (body.confirm !== true) {
          return json(res, 409, { error: '恢复自动更新需要显式确认' });
        }
        try {
          autoUpdate.resume({
            ownerUin: body.ownerUin,
            intervalHours: body.intervalHours
          });
          return json(res, 200, { ok: true, status: autoUpdate.status() });
        } catch (error) {
          return json(res, error.httpStatus || 400, {
            error: String(error?.message ?? error)
          });
        }
      }

      if (pathname === '/api/auto-update/pause' && method === 'POST') {
        const body = await readBody(req);
        if (body.confirm !== true) {
          return json(res, 409, { error: '暂停自动更新需要显式确认' });
        }
        autoUpdate.pause();
        return json(res, 200, { ok: true, status: autoUpdate.status() });
      }

      if (pathname === '/api/auto-update/notify-pending' && method === 'POST') {
        const status = await autoUpdate.handlePendingFailure();
        return json(res, 200, { ok: true, status });
      }

      if (pathname === '/api/auto-update/check' && method === 'GET') {
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
      }

      if (pathname === '/api/auto-update/ignore' && method === 'POST') {
        const body = await readBody(req);
        const version = ignoreVersion(DATA_DIR, body.version);
        if (!version) return json(res, 400, { error: '缺少要忽略的版本号' });
        return json(res, 200, { ok: true, ignoredVersion: version });
      }

      if (pathname === '/api/runtime' && method === 'POST') {
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
      }

      const recovery = /^\/api\/chats\/(group|private)_(\d+)\/(retry-failed|resolve-held)$/.exec(pathname);
      if (recovery && method === 'POST') {
        const body = await readBody(req);
        const key = `${recovery[1]}:${recovery[2]}`;
        if (body.confirm !== true) return json(res, 409, { error: 'Explicit confirmation required' });
        const count = recovery[3] === 'retry-failed' ? store.retryFailed(key) : store.resolveHeld(key);
        emit('chat-update', key);
        return json(res, 200, { ok: true, count });
      }

      const chatControl = /^\/api\/chats\/(group|private)_(\d+)\/runtime-control$/.exec(pathname);
      if (chatControl && method === 'GET') {
        const key = `${chatControl[1]}:${chatControl[2]}`;
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
      }
      if (chatControl && method === 'PUT') {
        if (!incidentPilot?.active) {
          return json(res, 409, { error: '异常处理实验当前未启用' });
        }
        const key = `${chatControl[1]}:${chatControl[2]}`;
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
      }
      const unknownOperations =
        /^\/api\/chats\/(group|private)_(\d+)\/unknown-operations$/.exec(pathname);
      if (unknownOperations && method === 'GET') {
        const key = `${unknownOperations[1]}:${unknownOperations[2]}`;
        return json(res, 200, { operations: store.listUnknownOperations(key) });
      }
      const unknownOperationAction =
        /^\/api\/chats\/(group|private)_(\d+)\/unknown-operations\/([\w-]+)\/reconcile$/
          .exec(pathname);
      if (unknownOperationAction && method === 'POST') {
        const body = await readBody(req);
        if (body.confirm !== true || !['sent', 'failed'].includes(body.result)) {
          return json(res, 409, { error: '核对未知写入需要明确结果和确认' });
        }
        const key = `${unknownOperationAction[1]}:${unknownOperationAction[2]}`;
        try {
          const result = store.reconcileUnknownOperation(
            unknownOperationAction[3],
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
      }

      if (pathname === '/api/status' && method === 'GET') {
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
          webSearchCount: dailyStats.searchCount
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
          cost,
          cacheHitRate: totals.cacheHitRate,
          webSearchCount: usage.webSearchCount || 0,
          // 前端构建戳：轮询时发现它变了 → 前端提示"控制台已更新，点击刷新"
          uiBuild: UI_BUILD,
          // 省 Token 模式：模式 + 每项的"用户值 / 生效值"（设置页渲染用）
          tokenSaver,
          ...(cfgNow.timeControl?.enabled ? {
            timeControl: timeControlState(cfgNow.timeControl)
          } : {}),
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null
        });
      }

      // ── 成本看板：按天 / 按会话 / 按模型统计 ──
      // range: 'today'=今天0点起 | '24h'=最近24小时 | '3'|'7'|'14'|'30'=最近N天
      if (pathname === '/api/usage/stats' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 某个维度下的明细（点表格行时弹窗用）
      // dim: 'chat' | 'model' | 'day'  key: 对应值  by: 'day' | 'model' | 'chat'
      if (pathname === '/api/usage/breakdown' && method === 'GET') {
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
      }

      // 从渠道自动拉价（探测）：只做预览，不写配置。
      // 支持 one-api / new-api 家族的 /api/pricing（倍率换算）与自家价目表形状。
      if (pathname === '/api/model-prices/probe' && method === 'POST') {
        const body = await readBody(req);
        const cfgNow = getConfig();
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
      }

      // 渠道价目表（每渠道一份，自动拉取）
      if (pathname === '/api/channel-prices' && method === 'GET') {
        return json(res, 200, { ok: true, feeds: channelPriceStatus() });
      }

      if (pathname === '/api/channel-prices' && method === 'POST') {
        const body = await readBody(req);
        const vendor = String(body.vendor || '').trim();
        const feedUrl = String(body.url || '').trim();
        if (!vendor) return json(res, 400, { error: '缺少渠道名（vendor）' });
        if (!/^https?:\/\//i.test(feedUrl)) return json(res, 400, { error: '价目表 URL 必须以 http(s):// 开头' });
        // 先写配置（意图），再拉一次（结果）
        const current = getConfig();
        const feeds = Array.isArray(current.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
        const next = feeds.filter((f) => String(f?.vendor || '').trim() !== vendor);
        next.push({ vendor, url: feedUrl });
        updateConfig({ api: { ...(current.api || {}), channelPriceFeeds: next } });
        const status = await refreshChannelFeed(vendor, feedUrl);
        return json(res, 200, { ok: true, feeds: status });
      }

      if (pathname === '/api/channel-prices/refresh' && method === 'POST') {
        const body = await readBody(req);
        const vendor = String(body.vendor || '').trim();
        const current = getConfig();
        const feeds = Array.isArray(current.api?.channelPriceFeeds) ? current.api.channelPriceFeeds : [];
        const hit = feeds.find((f) => String(f?.vendor || '').trim() === vendor);
        if (!hit) return json(res, 404, { error: `没有这个渠道的价目表：${vendor}` });
        const status = await refreshChannelFeed(vendor, String(hit.url || '').trim());
        return json(res, 200, { ok: true, feeds: status });
      }

      if (pathname === '/api/channel-prices/remove' && method === 'POST') {
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
      }

      if (pathname === '/api/model-prices' && method === 'GET') {
        return json(res, 200, modelPricesPayload(url.searchParams.get('model')));
      }

      // 手动触发一次远程价格表拉取（设置页「立即拉取」按钮）
      // 返回体与 GET 同形（只多一个 ok）：前端拿到后就地替换状态，
      // 少字段会让价格卡当场显示错价（渠道价/别名/渠道价目表集体丢失）。
      if (pathname === '/api/model-prices/refresh' && method === 'POST') {
        const st = await refreshPriceFeed(getConfig().api?.priceRemoteUrl || '');
        return json(res, 200, { ok: st.ok, ...modelPricesPayload() });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
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
      }

      // 用户自定义人设：新增 / 删除
      if (pathname === '/api/persona-templates' && method === 'POST') {
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
      }

      const personaDeleteMatch = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname);
      if (personaDeleteMatch && method === 'DELETE') {
        const idx = Number(personaDeleteMatch[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/providers' && method === 'GET') {
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
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers });
      }

      // 显示目录提供商的真实 Key（本地 UI 点击“显示”用）
      // 明文密钥端点：仅放行本机控制台请求，挡住外部网页冒用（见 keyEndpointAllowed）。
      if (pathname === '/api/providers/key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }

      // 显示顶层 api.apiKey（手动模式、未选目录提供商时用）
      if (pathname === '/api/api-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }

      // 显示某个搜索服务的真实 Key（本地 UI 点击“显示”用）。
      // /api/config 里的搜索 Key 是脱敏的，所以“显示”必须走这里。
      if (pathname === '/api/search-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const field = String(url.searchParams.get('field') || '');
        // 自定义搜索服务的 Key 不走这里（它们存在 webSearch.providers 数组里，
        // 由 /api/search-providers 管理，且添加时是一次性输入，不提供明文回读）。
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso', 'doubao'];
        if (!allowed.includes(field)) {
          return json(res, 400, { error: `未知搜索服务：${field}` });
        }
        return json(res, 200, { apiKey: String(getConfig().webSearch?.[field]?.apiKey || '') });
      }

      // 语音识别的模型列表：从服务商官网拉（用户要求 —— 写死的预设会过时，
      // 例如硅基流动上了新的免费模型，列表应该跟着官网走）。
      // 与 LLM 那边同一套密钥规则：只有地址是配置里已知的，才使用保存的 Key。
      if (pathname === '/api/asr/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
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
      }

      // 本机语音转写：状态查询与"点一下安装"（只有控制台来源放行；不擅自重启服务）
      if (pathname === '/api/asr/install-status' && method === 'GET') {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
        return json(res, 200, asrInstallSnapshot());
      }
      if (pathname === '/api/asr/uninstall' && method === 'POST') {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
        if (asrInstall.running) return json(res, 409, { error: '安装还在进行中，等它跑完再删' });
        try {
          const removed = removeLocalAsrFiles();
          // 破坏性操作留一行日志：以后能查"什么时候、删了哪个目录、放了多少空间"
          log(`[asr] 已完整卸载本机转写：${removed.managedDir}（释放 ${Math.round((removed.freedBytes || 0) / 1048576)}MB）`);
          return json(res, 200, { ok: true, ...removed, status: asrInstallSnapshot() });
        } catch (error) {
          return json(res, 500, { error: `删除失败：${String(error?.message ?? error)}` });
        }
      }
      if (pathname === '/api/asr/install' && method === 'POST') {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
        try {
          return json(res, 202, startAsrInstall());
        } catch (error) {
          return json(res, 409, { error: String(error?.message ?? error) });
        }
      }

      // 语音转写的凭据明文回读：与 /api/search-key 同款（只有控制台来源放行）。
      // field=apiKey|secretId|secretKey，默认 apiKey。
      if (pathname === '/api/asr-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const field = String(url.searchParams.get('field') || 'apiKey');
        const allowed = { apiKey: 'apiKey', secretId: 'secretId', secretKey: 'secretKey' };
        if (!allowed[field]) return json(res, 400, { error: `未知字段：${field}` });
        return json(res, 200, { apiKey: String(getConfig().asr?.[field] || '') });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
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
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
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
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求。
      // apiKey 可省略：省略时由服务端自己解析真实 Key 使用（不外发给客户端），
      // 这样未配置 server.token 时"测试连通性"依然可用。
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const submitted = String(body.apiKey ?? '').trim();
          const baseUrl = String(body.baseUrl ?? '');
          // 掩码 / 空 → 说明客户端没有新 Key，用服务端已保存的；但只发往配置里已知的地址
          // （见 storedKeyAllowedFor：否则等于把明文 Key 送到调用方指定的任意主机）。
          const cfgNow = getConfig();
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
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的一个模型
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: { ...builtinVisionResults(currentProviders()), ...visionResults() }, scanning: visionScan.running });
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
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
      }

      // ── 自定义搜索提供商（可添加多个，交互沿用模型提供商那套）──
      if (pathname === '/api/search-providers' && method === 'GET') {
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
      }

      // 新增/更新：同 baseUrl + type 视为同一项，覆盖其配置
      if (pathname === '/api/search-providers' && method === 'POST') {
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
      }

      // 删除一个自定义搜索提供商
      if (pathname === '/api/search-providers' && method === 'DELETE') {
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
      }

      // 测试某个自定义搜索提供商是否可用
      if (pathname === '/api/search-providers/test' && method === 'POST') {
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
      }

      if (pathname === '/api/test/api' && method === 'POST') {
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
      }

      if (pathname === '/api/config' && method === 'GET') {
        // 不把任何真实 Key 暴露给前端：递归清空所有密钥类字段，用 hasKey 表示"有密钥"。
        // 注意：不要用手工逐字段列举——之前漏了 5 个搜索 Key 和 2 个 SnowLuma 令牌，
        // 加新 provider 时还会继续漏。这里按字段名模式统一处理。
        const safe = safeConfigWithAsrStatus(cfgNow);
        return json(res, 200, safe);
      }

      if (pathname === '/api/config' && method === 'POST') {
        const patch = await readBody(req);
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
          delete patch.server.token;
          delete patch.server.hasToken;
        }
        const next = updateConfig(patch);
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
      }

      if (pathname === '/api/daily-moments/status' && method === 'GET') {
        return json(res, 200, dailyMoments.status());
      }

      if (pathname === '/api/qzone-interactions/status' && method === 'GET') {
        return json(res, 200, qzoneInteractions.status());
      }

      if (pathname === '/api/identity-pilot/status' && method === 'GET') {
        return json(res, 200, identityPilotStatus());
      }

      if (pathname === '/api/slang-pilot/status' && method === 'GET') {
        return json(res, 200, slangPilotStatus());
      }

      if (pathname === '/api/incident-pilot/status' && method === 'GET') {
        return json(res, 200, incidentPilotStatus());
      }
      if (pathname === '/api/incidents' && method === 'GET') {
        return json(res, 200, {
          status: incidentPilotStatus(),
          incidents: incidentPilot?.list({
            state: url.searchParams.get('state') || '',
            severity: url.searchParams.get('severity') || '',
            chatKey: url.searchParams.get('chatKey') || '',
            limit: url.searchParams.get('limit') || 100
          }) || []
        });
      }
      const incidentDetail = /^\/api\/incidents\/(inc_[a-f0-9]{16})$/i.exec(pathname);
      if (incidentDetail && method === 'GET') {
        const incident = incidentPilot?.get(incidentDetail[1]);
        return incident
          ? json(res, 200, { incident })
          : json(res, 404, { error: '异常日志不存在' });
      }
      if (incidentDetail && method === 'DELETE') {
        const body = await readBody(req);
        if (body.confirm !== true) {
          return json(res, 409, { error: '删除异常日志需要显式确认' });
        }
        try {
          return incidentPilot?.delete(incidentDetail[1])
            ? json(res, 200, { ok: true })
            : json(res, 404, { error: '异常日志不存在' });
        } catch (error) {
          return json(res, error?.httpStatus || 409, { error: String(error?.message ?? error) });
        }
      }
      const incidentAction =
        /^\/api\/incidents\/(inc_[a-f0-9]{16})\/(acknowledge|resolve)$/i.exec(pathname);
      if (incidentAction && method === 'POST') {
        const body = await readBody(req);
        try {
          const incident = incidentAction[2] === 'acknowledge'
            ? incidentPilot?.acknowledge(incidentAction[1])
            : incidentPilot?.resolve(incidentAction[1], body.resolution);
          return incident
            ? json(res, 200, { ok: true, incident })
            : json(res, 404, { error: '异常日志不存在' });
        } catch (error) {
          return json(res, error?.httpStatus || 409, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/slang-pilot/discoveries' && method === 'GET') {
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
      }

      const slangDiscoveryDetail =
        /^\/api\/slang-pilot\/discoveries\/(sr_[a-f0-9]{12})$/i.exec(pathname);
      if (slangDiscoveryDetail && method === 'GET') {
        if (!slangPilot?.active) {
          return json(res, 409, { error: '黑话语料库试点未启用' });
        }
        const discovery = slangPilot.detail(slangDiscoveryDetail[1]);
        return discovery
          ? json(res, 200, { discovery })
          : json(res, 404, { error: '黑话发现不存在' });
      }

      const slangResearchDecision =
        /^\/api\/slang-pilot\/discoveries\/(sr_[a-f0-9]{12})\/research-decision$/i
          .exec(pathname);
      if (slangResearchDecision && method === 'POST') {
        if (!slangPilot?.active) {
          return json(res, 409, { error: '黑话语料库试点未启用' });
        }
        const body = await readBody(req);
        if (!['approve', 'reject'].includes(body.decision)) {
          return json(res, 400, { error: 'decision 必须是 approve 或 reject' });
        }
        try {
          return json(res, 200, slangPilot?.decideResearch(
            slangResearchDecision[1],
            body.decision,
            { decidedBy: 'console', expectedVersion: body.expectedVersion }
          ));
        } catch (error) {
          return json(res, 409, { error: String(error?.message ?? error) });
        }
      }

      const slangAdmissionDecision =
        /^\/api\/slang-pilot\/discoveries\/(sr_[a-f0-9]{12})\/admission-decision$/i
          .exec(pathname);
      if (slangAdmissionDecision && method === 'POST') {
        if (!slangPilot?.active) {
          return json(res, 409, { error: '黑话语料库试点未启用' });
        }
        const body = await readBody(req);
        if (!['approve', 'reject'].includes(body.decision)) {
          return json(res, 400, { error: 'decision 必须是 approve 或 reject' });
        }
        try {
          return json(res, 200, slangPilot?.decideAdmission(
            slangAdmissionDecision[1],
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
      }

      const slangResearchRetry =
        /^\/api\/slang-pilot\/discoveries\/(sr_[a-f0-9]{12})\/retry$/i.exec(pathname);
      if (slangResearchRetry && method === 'POST') {
        if (!slangPilot?.active) {
          return json(res, 409, { error: '黑话语料库试点未启用' });
        }
        try {
          return json(res, 200, slangPilot?.retryResearch(
            slangResearchRetry[1],
            { decidedBy: 'console' }
          ));
        } catch (error) {
          return json(res, 409, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/identity-pilot/people' && method === 'GET') {
        if (!identityPilot?.active) {
          return json(res, 409, { error: '统一身份库未启用' });
        }
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        return json(res, 200, {
          status: identityPilot.status(),
          people: identityPilot.listPeople(limit)
        });
      }

      if (pathname === '/api/identity-pilot/incoming-friend-requests' && method === 'GET') {
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
      }

      const incomingFriendDecision =
        /^\/api\/identity-pilot\/incoming-friend-requests\/(fr_[a-f0-9]{12})\/decision$/i
          .exec(pathname);
      if (incomingFriendDecision && method === 'POST') {
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
            incomingFriendDecision[1],
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
      }

      if (pathname === '/api/identity-pilot/friend-proposals' && method === 'GET') {
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
      }

      if (pathname === '/api/identity-pilot/friend-opportunities' && method === 'GET') {
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
      }

      const friendProposalDecision = /^\/api\/identity-pilot\/friend-proposals\/(fp_[a-f0-9]{12})\/decision$/i.exec(pathname);
      if (friendProposalDecision && method === 'POST') {
        if (!identityPilot?.active || getConfig().identityPilot?.friendProposal?.enabled !== true) {
          return json(res, 409, { error: '主动好友候选功能未启用' });
        }
        const body = await readBody(req);
        if (!['approve', 'reject'].includes(body.decision)) {
          return json(res, 400, { error: 'decision 必须是 approve 或 reject' });
        }
        try {
          const result = await identityPilot.decideFriendProposal(
            friendProposalDecision[1],
            body.decision,
            { decidedBy: 'console' }
          );
          emit('identity-pilot-update', identityPilot.status());
          return json(res, 200, result);
        } catch (error) {
          return json(res, 409, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/assets/overview' && method === 'GET') {
        const overview = assetObserver.overview();
        const pilotStatus = slangPilotStatus();
        return json(res, 200, {
          ...overview,
          slang: { ...overview.slang, active: pilotStatus.active },
          slangPilot: pilotStatus
        });
      }

      if (pathname === '/api/assets/stickers' && method === 'GET') {
        const result = await assetObserver.listStickers({
          query: url.searchParams.get('query') || '',
          offset: url.searchParams.get('offset') || 0,
          limit: url.searchParams.get('limit') || 100,
          refresh: url.searchParams.get('refresh') === '1'
        });
        return json(res, 200, result);
      }

      if (pathname === '/api/assets/stickers' && method === 'POST') {
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
      }

      if (pathname === '/api/assets/stickers/image' && method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim();
        if (!id) return json(res, 400, { error: '缺少表情 ID' });
        let sticker = stickers.peek(id);
        const localImage = stickers.readImage(id);
        if (localImage) {
          res.writeHead(200, {
            'content-type': localImage.contentType,
            'content-length': localImage.buffer.length,
            'cache-control': 'private, max-age=300',
            'x-content-type-options': 'nosniff'
          });
          res.end(localImage.buffer);
          return;
        }
        if (sticker?.source === 'ai') {
          sticker = await stickers.findForSend(id);
        }
        if (!sticker?.url) return json(res, 404, { error: '表情图片不存在' });
        try {
          const image = await safeFetchBinary(sticker.url, 8 * 1024 * 1024);
          const contentType = String(image.contentType || '').split(';')[0].trim().toLowerCase();
          if (!contentType.startsWith('image/')) {
            return json(res, 502, { error: '表情资源不是图片' });
          }
          res.writeHead(200, {
            'content-type': contentType,
            'content-length': image.buffer.length,
            'cache-control': 'private, max-age=60',
            'x-content-type-options': 'nosniff'
          });
          res.end(image.buffer);
          return;
        } catch (error) {
          return json(res, 502, { error: `表情图片读取失败：${String(error?.message ?? error)}` });
        }
      }

      const stickerAssetMatch = /^\/api\/assets\/stickers\/([^/]+)$/.exec(pathname);
      if (stickerAssetMatch && method === 'PUT') {
        try {
          const id = decodeURIComponent(stickerAssetMatch[1]);
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
      }
      if (stickerAssetMatch && method === 'DELETE') {
        try {
          const body = await readBody(req);
          if (body.confirm !== true) return json(res, 409, { error: '删除表情需要显式确认' });
          const id = decodeURIComponent(stickerAssetMatch[1]);
          const result = assetObserver.deleteSticker(id);
          if (!result?.removed) return json(res, 404, { error: '表情不存在' });
          emit('asset-update', { kind: 'stickers', action: 'delete', id });
          return json(res, 200, { ok: true, ...result });
        } catch (error) {
          return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/assets/slang' && method === 'GET') {
        return json(res, 200, assetObserver.listSlang({
          query: url.searchParams.get('query') || '',
          status: url.searchParams.get('status') || '',
          offset: url.searchParams.get('offset') || 0,
          limit: url.searchParams.get('limit') || 200
        }));
      }

      if (pathname === '/api/assets/slang' && method === 'POST') {
        try {
          const entry = assetObserver.addSlang(await readBody(req));
          emit('asset-update', { kind: 'slang', action: 'create', id: entry.id });
          return json(res, 201, { ok: true, entry });
        } catch (error) {
          return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
        }
      }
      const slangAssetMatch = /^\/api\/assets\/slang\/([^/]+)$/.exec(pathname);
      if (slangAssetMatch && method === 'PUT') {
        try {
          const id = decodeURIComponent(slangAssetMatch[1]);
          const entry = assetObserver.updateSlang(id, await readBody(req));
          if (!entry) return json(res, 404, { error: '黑话词条不存在' });
          emit('asset-update', { kind: 'slang', action: 'update', id });
          return json(res, 200, { ok: true, entry });
        } catch (error) {
          return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
        }
      }
      if (slangAssetMatch && method === 'DELETE') {
        try {
          const body = await readBody(req);
          if (body.confirm !== true) return json(res, 409, { error: '删除黑话需要显式确认' });
          const id = decodeURIComponent(slangAssetMatch[1]);
          if (!assetObserver.deleteSlang(id)) return json(res, 404, { error: '黑话词条不存在' });
          emit('asset-update', { kind: 'slang', action: 'delete', id });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/assets/identities' && method === 'GET') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
        return json(res, 200, assetObserver.identitySnapshot({
          limit,
          query: url.searchParams.get('query') || ''
        }));
      }

      if (pathname === '/api/assets/identities' && method === 'POST') {
        try {
          const person = assetObserver.upsertIdentity(await readBody(req));
          emit('asset-update', { kind: 'identities', action: 'create', id: person.userId });
          emit('identity-pilot-update', identityPilotStatus());
          return json(res, 201, { ok: true, person });
        } catch (error) {
          return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
        }
      }
      const identityAssetMatch = /^\/api\/assets\/identities\/(\d+)$/.exec(pathname);
      if (identityAssetMatch && method === 'PUT') {
        try {
          const person = assetObserver.upsertIdentity({
            ...(await readBody(req)),
            userId: identityAssetMatch[1]
          });
          emit('asset-update', { kind: 'identities', action: 'update', id: person.userId });
          emit('identity-pilot-update', identityPilotStatus());
          return json(res, 200, { ok: true, person });
        } catch (error) {
          return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
        }
      }
      if (identityAssetMatch && method === 'DELETE') {
        try {
          const body = await readBody(req);
          if (body.confirm !== true) return json(res, 409, { error: '删除人物需要显式确认' });
          if (!assetObserver.deleteIdentity(identityAssetMatch[1])) {
            return json(res, 404, { error: '人物不存在' });
          }
          emit('asset-update', { kind: 'identities', action: 'delete', id: identityAssetMatch[1] });
          emit('identity-pilot-update', identityPilotStatus());
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/assets/memory' && method === 'GET') {
        return json(res, 200, assetObserver.memorySummary({
          query: url.searchParams.get('query') || ''
        }));
      }
      if (pathname === '/api/assets/memory' && method === 'POST') {
        try {
          const entry = assetObserver.addMemory(await readBody(req));
          await refreshIdentityAfterAssetMutation();
          emit('memory-update', { chatKey: String(entry.chatKey || '') });
          emit('asset-update', { kind: 'memory', action: 'create' });
          return json(res, 201, { ok: true, entry });
        } catch (error) {
          return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
        }
      }
      if (pathname === '/api/assets/memory' && method === 'PUT') {
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
      }
      if (pathname === '/api/assets/memory' && method === 'DELETE') {
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
      }

      if (pathname === '/api/qzone-interactions/run' && method === 'POST') {
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
      }

      if (pathname === '/api/time-control/status' && method === 'GET') {
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
      }

      if (pathname === '/api/daily-moments/run' && method === 'POST') {
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
      }

      const momentAction = /^\/api\/daily-moments\/records\/([\w-]+)\/(publish|reconcile|resolve)$/.exec(pathname);
      if (momentAction && method === 'POST') {
        const body = await readBody(req);
        if (momentAction[2] === 'publish' && body.confirm !== true) {
          return json(res, 409, { error: '发布草稿需要显式确认' });
        }
        if (momentAction[2] === 'resolve' && body.confirm !== true) {
          return json(res, 409, { error: '人工核对结果需要显式确认' });
        }
        try {
          const result = momentAction[2] === 'publish'
            ? await dailyMoments.publishDraft(momentAction[1], {
                force: body.force === true,
                confirmDuplicateRisk: body.confirmDuplicateRisk === true
              })
            : momentAction[2] === 'resolve'
              ? await dailyMoments.resolveRecord(momentAction[1], { result: body.result })
              : await dailyMoments.reconcile(momentAction[1]);
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.httpStatus || (error.code === 'TIME_CONTROL_INACTIVE' ? 409 : 500), {
            error: String(error?.message ?? error), code: error.code || ''
          });
        }
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        // 上限 2^20（Kondius 钦定 1048576）：约等于不限，但拦得住真正的失控请求。
        // 前端靠分页（一次渲染 50 条）避免卡顿，后端不截断。
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const now = Date.now();
        const threadCache = new Map();
        return json(res, 200, {
          sessions: sessions.listSummaries(limit)
            .map((session) => buildSessionView(session, store, { now, threadCache }))
        });
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        const s = sessions.get(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, buildSessionView(s, store));
      }

      if (pathname === '/api/chats' && method === 'GET') {
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
      }

      // 记忆文件列表（记忆页签）：白名单里的每个群都显示，含无记忆的
      if (pathname === '/api/memory-files' && method === 'GET') {
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
      }

      const memoryFileMatch = /^\/api\/memory-files\/(group|private)_(\d+)$/.exec(pathname);
      if (memoryFileMatch && method === 'GET') {
        const chatKey = `${memoryFileMatch[1]}:${memoryFileMatch[2]}`;
        return json(res, 200, {
          ...memory.query(chatKey),
          members: memory.members(chatKey),
          handoff: memory.getHandoff(chatKey)
        });
      }

      const memoryHandoffMatch = /^\/api\/memory-files\/(group|private)_(\d+)\/handoff$/.exec(pathname);
      if (memoryHandoffMatch && method === 'PUT') {
        const chatKey = `${memoryHandoffMatch[1]}:${memoryHandoffMatch[2]}`;
        const body = await readBody(req).catch(() => ({}));
        try {
          const handoff = memory.setHandoff(chatKey, body, { sourceSessionId: 'console' });
          emit('memory-update', { chatKey, phase: handoff ? 'handoff-update' : 'handoff-clear' });
          return json(res, 200, { ok: true, handoff });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (memoryHandoffMatch && method === 'DELETE') {
        const chatKey = `${memoryHandoffMatch[1]}:${memoryHandoffMatch[2]}`;
        memory.clearHandoff(chatKey);
        emit('memory-update', { chatKey, phase: 'handoff-clear' });
        return json(res, 200, { ok: true });
      }

      // 按 QQ 号**全局**删除此人的人物记忆（人物库页「删除全部人物记忆」用）：
      // 空 chatKey = 该 QQ 在所有会话的印象一起删（删前留快照，可回滚）。
      // 旧的 /api/memory-files/<chat>/members/<uid> 语义是"只清这个来源"，两者别混用。
      const memoryMemberGlobalMatch = /^\/api\/memory-files\/global\/members\/(\d{1,15})$/.exec(pathname);
      if (memoryMemberGlobalMatch && method === 'DELETE') {
        // 破坏性操作统一 confirm 门槛（与全站口径一致）：global 版跨所有会话删除。
        const body = await readBody(req).catch(() => ({}));
        if (body?.confirm !== true) return json(res, 409, { ok: false, error: '删除全部人物记忆需要 body.confirm === true' });
        const removed = memory.removeMember('', memoryMemberGlobalMatch[1]);
        emit('memory-update', { chatKey: '' });
        return json(res, 200, { ok: true, removed });
      }

      // 手动编辑某个群友的印象（PUT 编辑：QQ号必填，备注可同步保存 / DELETE 删除成员文件）
      const memoryMemberMatch = /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/.exec(pathname);
      if (memoryMemberMatch && method === 'PUT') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        const body = await readBody(req).catch(() => ({}));
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: memoryMemberMatch[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (memoryMemberMatch && method === 'DELETE') {
        // 同上：删除成员印象也要 confirm（该路径的快照对 name-only 成员缺位，误删更难恢复）。
        const body = await readBody(req).catch(() => ({}));
        if (body?.confirm !== true) return json(res, 409, { ok: false, error: '删除成员印象需要 body.confirm === true' });
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        memory.removeMember(chatKey, memoryMemberMatch[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }

      // 手动整理某个群的记忆：遍历聊天记录中出现的成员，逐人整理直到收敛
      if (pathname === '/api/memory-files/consolidate' && method === 'POST') {
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
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        // 单群消息上限 2^20（Kondius 钦定）：约等于不限，存档一口气全给
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply,
          media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }

      // 群成员列表（OneBot get_group_member_list），用于备注与记忆页成员展示
      const groupMembersMatch = /^\/api\/groups\/(\d+)\/members$/.exec(pathname);
      if (groupMembersMatch && method === 'GET') {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(groupMembersMatch[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        const result = orchestrator.requestManualWake(chatKey);
        return json(res, result.ok ? 202 : 409, result);
      }

      const chatThreadMatch = /^\/api\/chats\/(group|private)_(\d+)\/thread$/.exec(pathname);
      if (chatThreadMatch && method === 'GET') {
        const chatKey = `${chatThreadMatch[1]}:${chatThreadMatch[2]}`;
        return json(res, 200, {
          chatKey,
          mode: conversationConfigForChat(chatKey).mode,
          thread: store.getConversationThread(chatKey),
          checkpoint: store.latestThreadCheckpoint(chatKey)
        });
      }
      if (chatThreadMatch && method === 'DELETE') {
        const chatKey = `${chatThreadMatch[1]}:${chatThreadMatch[2]}`;
        const closed = store.closeConversationThread(chatKey, 'operator');
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, closed });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
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
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      if (pathname === '/api/pause' && method === 'POST') {
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
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        orchestrator.setPaused(false);
        slangPilot?.resumeQueued();
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

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
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        const stat = fs.statSync(fullPath);
        res.writeHead(200, {
          'content-type': types[ext] ?? 'application/octet-stream',
          // no-cache = 每次使用前必须回源校验；带 ETag/Last-Modified 让未变时走 304
          'cache-control': 'no-cache',
          etag: `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`,
          'last-modified': stat.mtime.toUTCString()
        });
        res.end(data);
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
    if (getConfig().dailyMoments?.enabled) dailyMoments.start();
    if (getConfig().qzoneInteractions?.enabled) qzoneInteractions.start();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startScheduledWakeTicker();
    autoUpdate.start();
    log(`控制台已就绪：http://${serverCfg.host}:${port} (${getConfig().runtime.mode})`);
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
    releaseTimeControl();
    dailyMoments.stop();
    dailyMoments.abort();
    qzoneInteractions.stop();
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
    get incidentPilot() { return incidentPilot; },
    incidentPilotStatus,
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
    updateConfig
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
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;

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
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      rows: usageRowsCache.rows.slice(),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 与 rows 在同一个循环里统计 —— 不额外多读一次文件。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
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
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.slice();
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
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
  const cfg = getConfig();
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
  const { rows, win } = collectUsageRows({ range });
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
