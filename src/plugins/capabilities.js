// 能力的**宿主侧**实现 —— 插件进程里没有 ctx、没有 onebot、没有 fs 写权限，它唯一的出口
// 就是这几个方法，所以"守卫必须复用"这件事在这里变成结构性的：想发消息必须走宿主给的那条路，
// 想联网必须走宿主实现的那条路（v1 里 send 还没开，见 docs/PLUGINS.md 的分期）。
//
// 每个能力都要在 manifest 里声明才算数（鉴权在 host.js 的 handleCapability 里做，
// 声明表在 protocol.js 的 CAP_REQUIREMENT）——没声明就调，直接拒 + 记一次越权。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CAP_METHODS } from './protocol.js';
import { sanitizeUserText } from '../core/util.js';
import { imageType } from '../core/image-type.js';
import { safeFetchRequest, safeFetchBinary, isHostAllowed, assertPublicUrlLiteral } from '../llm/safe-fetch.js';
import { readPluginSecrets, writePluginSecrets, secretFieldKeys } from './secrets.js';
import { ffmpegToPcm, runProvider } from '../tools/audio-transcribe.js';
import { asrAvailable } from '../core/config.js';
import { visionEnabled } from '../llm/vision-scan.js';
import { chatCompletion } from '../llm/llm.js';
import { checkApproval, consumeQuota } from './grants.js';
import { hashManifest } from './manifest-diff.js';

const MAX_KEY = 64;
const MAX_VALUE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_WRITES_PER_MIN = 120;
const MAX_LOG_CHARS = 2000;
const MAX_HTTP_CHARS = 40000;          // 与 web_fetch 的 2 万字符同档：插件也不该把整站塞进上下文
const MAX_INCIDENT_LOGS_PER_MIN = 5;   // 插件崩溃循环时不能把管理员异常面板刷满
// 单条发言上限。1500 是为了容纳扫码登录的半块字符二维码（约 1000–1400 字符）：
// 二维码被静默截断 = 扫不出来，所以超限一律报错、绝不 slice（2026-10-24 审查 P1）。
const MAX_SEND_CHARS = 1500;
const MAX_SENDS_PER_MIN = 6;           // 每个插件每分钟最多说几句 —— 防"刷屏"这种最直观的作恶
const MAX_HTTP_HEADERS = 16;
const MAX_HEADER_CHARS = 2048;
const MAX_MEDIA_BYTES = 80 * 1024 * 1024;   // 单次下载上限（B 站 480P/720P 够用）
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024; // WS 已连接时可用（大帧走 WS）
const HTTP_INLINE_IMAGE_BYTES = 1 * 1024 * 1024; // 仅 HTTP 时受协议端 body 上限约束
const MAX_MEDIA_FILES = 12;                 // 每个插件保留的媒体文件数（抽帧+缓存+成品都要住这里）
const MEDIA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * 跑一个固定的媒体工具（ffmpeg/ffprobe）。参数由宿主拼，**不经过 shell**；
 * 超时强杀、输出截断到 8KB —— 够报错，不足以把宿主日志灌满。
 */
function runTool(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(fail('E_MEDIA_TOOL', `无法启动 ${command}：${error?.message ?? error}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish(fail('E_TIMEOUT', `${command} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < 8192) stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += String(chunk); });
    child.on('error', (error) => {
      const missing = String(error?.code || '') === 'ENOENT';
      finish(fail('E_MEDIA_TOOL', missing
        ? `本机没有 ${command}：播放/合流需要 ffmpeg（Linux 用 apt install ffmpeg）`
        : `${command} 启动失败：${error?.message ?? error}`));
    });
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(fail('E_MEDIA_TOOL', `${command} 退出码 ${code}：${stderr.split('\n').slice(-3).join(' ').slice(0, 400)}`));
    });
  });
}

/** 插件自己的状态目录（**不放插件目录里**：卸载/重装插件不该顺手把数据删掉）。 */
export function pluginDataDir(dataDir, pluginId) {
  return path.join(dataDir, 'plugin-data', pluginId);
}

/**
 * @param pluginId   插件 id（存储与日志前缀用）
 * @param dataDir    应用数据目录（宿主侧唯一允许写的地方）
 * @param getSettings () => 该插件的配置段（plugins.settings.<id>）
 * @param log        宿主日志函数（约定与各 manager 一致：Error 实例才会进异常面板）
 */
export function createCapabilities({
  pluginId, dataDir, getSettings = () => ({}), log = () => {}, now = () => Date.now(),
  getSender = () => null, manifest = null, limits = {},
  approveAll = false, httpMock = null
} = {}) {
  // 注入点先落到本地常量：`node src/ops.js scan --strict`（CI 门禁）只认 const/let 声明与
  // KNOWN_IGNORE 里的名字，**直接调用解构参数的默认值会被判成"未定义调用"**
  //（同一约定见 src/core/ledger-retention.js 顶部那段注释）。
  const settingsOf = getSettings;
  const nowFn = now;
  const senderOf = getSender;
  const pluginManifest = manifest;
  // plugin-dev 的两个开发开关：只在这个脚本里注入，宿主生产路径永远不传。
  const devApproveAll = approveAll === true;
  const devHttpMock = typeof httpMock === 'function' ? httpMock : null;
  const dir = pluginDataDir(dataDir, pluginId);
  const storageFile = path.join(dir, 'storage.json');
  const mediaDir = path.join(dir, 'media');
  const diskLimitKb = Math.max(0, Math.round((Number(limits?.diskMb) || 0) * 1024));
  let diskCache = { at: 0, kb: 0 };
  const pluginDirSizeKb = () => {
    if (!diskLimitKb) return 0;
    const t = nowFn();
    if (t - diskCache.at < 5000) return diskCache.kb;
    let total = 0;
    const walk = (current) => {
      let entries = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) walk(file);
        else {
          try { total += fs.statSync(file).size; } catch { /* 忽略单个文件 */ }
        }
      }
    };
    walk(dir);
    diskCache = { at: t, kb: Math.round(total / 1024) };
    return diskCache.kb;
  };
  const assertDiskRoom = (additionalBytes = 0) => {
    if (!diskLimitKb) return;
    const need = Math.ceil(Math.max(0, Number(additionalBytes) || 0) / 1024);
    if (pluginDirSizeKb() + need > diskLimitKb) {
      throw fail('E_DISK_QUOTA', `插件数据超过上限 ${Math.round(diskLimitKb / 1024)}MB（可在「插件宿主（高级）」里调整）`);
    }
  };
  let storage = null;
  const writeTimes = [];
  const incidentLogs = [];
  const stats = { storageWrites: 0, storageBytes: 0, logLines: 0, incidentLogs: 0, httpRequests: 0, sends: 0, mediaDownloads: 0, approvals: 0 };
  const sendTimes = [];
  // send.text 与 send.file 共用同一个每分钟出站桶：否则插件可以绕过 6 条/分钟
  // 的防刷屏上限，用文件/图片刷满全局 80 条/分钟（2026-11-03 全量审查 P2）。
  const takeSendSlot = () => {
    const cutoff = nowFn() - 60000;
    while (sendTimes.length && sendTimes[0] < cutoff) sendTimes.shift();
    if (sendTimes.length >= MAX_SENDS_PER_MIN) {
      throw fail('E_RATE', `发送太频繁（每分钟上限 ${MAX_SENDS_PER_MIN} 条）`);
    }
    sendTimes.push(nowFn()); // 先记再发：失败也占额度，避免失败重试无限刷
  };
  // manifest 决定白名单：凭据字段、可授权动作、配额、http 域名。没声明的一律不认（fail-closed）。
  const secretKeys = secretFieldKeys(pluginManifest?.settings);
  const approvalActions = new Set((pluginManifest?.approvals || []).map((item) => item.action));
  const quotas = pluginManifest?.quotas && typeof pluginManifest.quotas === 'object' ? pluginManifest.quotas : {};
  const httpDomains = Array.isArray(pluginManifest?.httpDomains) ? pluginManifest.httpDomains : [];
  // 响应上限按 manifest 声明放宽（默认 40KB，最高 512KB）：B 站搜索这类接口 40KB 会截断
  const httpCap = Math.max(40000, Math.min(512 * 1024, Math.floor(Number(pluginManifest?.httpMaxBytes) || 40000)));

  const loadStorage = () => {
    if (storage) return storage;
    try {
      const raw = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
      storage = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (error) {
      // 文件坏了/不存在都从空开始，但要留痕（否则"插件状态莫名清空"永远查不出来）
      if (error?.code !== 'ENOENT') {
        log(`[plugin:${pluginId}] 状态文件读不了，按空状态继续：${error?.message ?? error}`);
      }
      storage = {};
    }
    return storage;
  };

  const persist = () => {
    const body = JSON.stringify(storage ?? {});
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${storageFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, storageFile);
    stats.storageBytes = Buffer.byteLength(body);
  };

  const methods = {
    [CAP_METHODS.storageGet]: ({ key } = {}) => {
      const k = String(key ?? '');
      if (!k || k.length > MAX_KEY) throw fail('E_ARGS', `storage key 必须是 1-${MAX_KEY} 字`);
      const value = loadStorage()[k];
      return { value: value === undefined ? null : value };
    },
    [CAP_METHODS.storageSet]: ({ key, value } = {}) => {
      const k = String(key ?? '');
      if (!k || k.length > MAX_KEY) throw fail('E_ARGS', `storage key 必须是 1-${MAX_KEY} 字`);
      const serialized = JSON.stringify(value === undefined ? null : value);
      if (serialized === undefined) throw fail('E_ARGS', 'value 必须能被 JSON 序列化');
      if (Buffer.byteLength(serialized) > MAX_VALUE_BYTES) {
        throw fail('E_TOO_BIG', `单个值上限 ${MAX_VALUE_BYTES / 1024}KB`);
      }
      const store = loadStorage();
      const next = { ...store, [k]: value === undefined ? null : value };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_TOTAL_BYTES) {
        throw fail('E_FULL', `状态总量上限 ${MAX_TOTAL_BYTES / 1024}KB，先删掉不用的键`);
      }
      assertDiskRoom(Buffer.byteLength(JSON.stringify(next)));
      const t = nowFn();
      while (writeTimes.length && t - writeTimes[0] > 60_000) writeTimes.shift();
      if (writeTimes.length >= MAX_WRITES_PER_MIN) throw fail('E_RATE', '写得太频繁（每分钟上限 120 次）');
      writeTimes.push(t);
      storage = next;
      persist();
      stats.storageWrites += 1;
      return { ok: true };
    },
    [CAP_METHODS.configGet]: () => ({ settings: structuredClone(settingsOf() ?? {}) }),
    [CAP_METHODS.logWrite]: ({ level, message } = {}) => {
      const lv = ['info', 'warn', 'error'].includes(level) ? level : 'info';
      const text = sanitizeUserText(String(message ?? '')).slice(0, MAX_LOG_CHARS);
      if (!text) return { ok: true };
      stats.logLines += 1;
      const line = `[plugin:${pluginId}] ${text}`;
      if (lv === 'error') {
        const t = nowFn();
        while (incidentLogs.length && t - incidentLogs[0] > 60_000) incidentLogs.shift();
        if (incidentLogs.length < MAX_INCIDENT_LOGS_PER_MIN) {
          incidentLogs.push(t);
          stats.incidentLogs += 1;
          // 传 Error 实例 → 走各模块同一套 moduleLog 约定进异常面板；被限流的部分只留日志行
          log(line, Object.assign(new Error(text), { pluginId }));
          return { ok: true };
        }
      }
      log(line);
      return { ok: true };
    },
    /**
     * **代机器人发言**（v1.1）。这是信任面最大的一条能力，所以：
     *   · 强制走宿主的发送队列（`sender.sendTextBatch`）—— 非活跃时间、观察/暂停模式、群白名单、
     *     禁言预检、限频、outbox 未知写入记账，全都在那条路上，插件绕不过去；
     *   · 每个插件每分钟最多说 MAX_SENDS_PER_MIN 句（防刷屏：最直观的作恶方式）；
     *   · 单条长度上限；内容过 sanitizeUserText（与作者文本同一口径）；
     *   · 每次发言都写一条带插件 id 的日志 —— 控制台里查得到"这句话是哪个插件说的"。
     * 宿主没有发送队列时**明确报错**，不假装发成功。
     */
    [CAP_METHODS.sendText]: async ({ chatKey, text } = {}) => {
      const target = String(chatKey ?? '').trim();
      const raw = sanitizeUserText(String(text ?? '').trim());
      if (raw.length > MAX_SEND_CHARS) {
        throw fail('E_ARGS', `text 超过单条上限 ${MAX_SEND_CHARS} 字（实际 ${raw.length}）`);
      }
      const body = raw;
      // 收紧到"数字 id"：原先的 \S+ 放行 `group:123:0` 这类形状 —— 下游 `chatKey.split(':')` 只取
      // 前两段（消息真发到群 123），但禁言预检拿的是整串（必失败 → 当成"未禁言"），每会话限频的桶键
      // 也是整串（每次换后缀就是一个新预算桶）→ 一道禁言、一道限频双双被绕。
      if (!/^(group|private):\d+$/.test(target)) throw fail('E_ARGS', 'chatKey 必须是 group:<数字群号> 或 private:<数字QQ号>');
      if (!body) throw fail('E_ARGS', 'text 不能为空');
      const sender = senderOf();
      if (!sender?.sendTextBatch) throw fail('E_NO_SENDER', '宿主没有可用的发送队列（插件暂时发不了言）');
      takeSendSlot();
      await sender.sendTextBatch(target, [body], {});
      stats.sends += 1;
      log(`[plugin:${pluginId}] 以机器人身份在 ${target} 说了一句：${body.slice(0, 60)}`);
      return { ok: true, chatKey: target, chars: body.length };
    },

    [CAP_METHODS.httpRequest]: async ({ url, maxChars, method, headers, body, decompress, withSetCookies } = {}) => {
      const target = String(url ?? '').trim();
      if (!target) throw fail('E_ARGS', 'url 不能为空');
      let parsed;
      try { parsed = new URL(target); } catch { throw fail('E_ARGS', 'url 不是合法地址'); }
      if (!/^https?:$/.test(parsed.protocol)) throw fail('E_ARGS', '只允许 http/https');
      if (!isHostAllowed(parsed.hostname, httpDomains)) {
        throw fail('E_DOMAIN', `域名 ${parsed.hostname} 不在插件的 httpDomains 白名单里`);
      }
      const verb = String(method || 'GET').toUpperCase();
      if (!['GET', 'POST'].includes(verb)) throw fail('E_ARGS', 'method 只允许 GET / POST');
      const cleanHeaders = {};
      if (headers !== undefined && headers !== null) {
        if (typeof headers !== 'object' || Array.isArray(headers)) throw fail('E_ARGS', 'headers 必须是对象');
        const entries = Object.entries(headers);
        if (entries.length > MAX_HTTP_HEADERS) throw fail('E_ARGS', `headers 最多 ${MAX_HTTP_HEADERS} 项`);
        for (const [key, value] of entries) {
          if (key.length > 64 || /[\r\n]/.test(key) || /[\r\n]/.test(String(value))) throw fail('E_ARGS', 'headers 含非法字符');
          if (String(value).length > MAX_HEADER_CHARS) throw fail('E_ARGS', '请求头过长');
          cleanHeaders[key] = String(value);
        }
      }
      if (body !== undefined && body !== null) {
        if (verb !== 'POST') throw fail('E_ARGS', '只有 POST 可以带请求体');
        if (typeof body !== 'string') throw fail('E_ARGS', 'body 必须是字符串');
      }
      // 上限跟 manifest 的 httpMaxBytes 走（B 站搜索/每周必看这类接口 40KB 就会截断）
      const limit = Math.min(Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : MAX_HTTP_CHARS, httpCap);
      stats.httpRequests += 1;
      // --http-mock：只在 plugin-dev 里注入。返回 null 表示"这条不 mock，继续走真网络"，
      // 这样作者可以只钉住某几个接口，其余仍按真实宿主的拦截/超时跑。
      if (devHttpMock) {
        const mocked = await devHttpMock({ url: target, method: verb, headers: cleanHeaders, body: verb === 'POST' ? body : null });
        if (mocked !== null && mocked !== undefined) {
          const status = Number(mocked?.status ?? 200) || 200;
          const mockBody = typeof mocked === 'string' ? mocked : String(mocked?.body ?? '');
          log(`[plugin:${pluginId}] dev --http-mock ${verb} ${parsed.host}${parsed.pathname} → ${status}`);
          return { status, truncated: false, body: mockBody.slice(0, limit) };
        }
      }
      // 复用宿主的 safe-fetch：内网/字面量拦截、重定向逐跳复检、体积与超时上限都在里面。
      // ⚠️ 这是"方便 + 可审计"，不是安全边界：插件进程自己有网络（Node 权限模型不管网络），
      //    要真禁网得靠命名空间/容器，v1 做不到（docs/PLUGINS.md 写明了）。
      const result = await safeFetchRequest(target, {
        method: verb, headers: cleanHeaders, body: verb === 'POST' ? body : null,
        maxBytes: httpCap, decompress: decompress === true,
        // Set-Cookie 透出是显式开关（扫码登录 poll 的成功凭据在响应头里）：
        // 默认关。开着时也只把 cookie 名与值交给**声明了 secrets 能力**的插件，
        // 且写一条日志（哪个插件在什么时候收了凭据）。
        withSetCookies: withSetCookies === true && (pluginManifest?.capabilities || []).includes('secrets'),
        // 白名单跟着每一跳重定向走：只查初始 URL 的话，白名单域一个 302 就能带去任意站
        allowedDomains: httpDomains.length ? httpDomains : null
      });
      if (verb !== 'GET') {
        // 写请求一律留痕：出问题时能回答"是哪个插件、在什么时候、对谁发的"
        log(`[plugin:${pluginId}] ${verb} ${parsed.host}${parsed.pathname} → HTTP ${result?.statusCode ?? 0}`);
      }
      const out = {
        status: result?.statusCode ?? 0,
        truncated: Boolean(result?.truncated),
        body: String(result?.body ?? '').slice(0, limit)
      };
      if (Array.isArray(result?.setCookies) && result.setCookies.length) {
        out.setCookies = result.setCookies.map(String).slice(0, 20);
        log(`[plugin:${pluginId}] 收到 Set-Cookie 响应头（${result.setCookies.length} 条，凭据类，只交给声明 secrets 的插件）`);
      }
      return out;
    },

    // ── apiVersion 2 ──────────────────────────────────────────────────────
    [CAP_METHODS.secretsGet]: () => {
      const secrets = readPluginSecrets(dataDir, pluginId);
      const out = {};
      for (const key of secretKeys) {
        if (typeof secrets[key] === 'string' && secrets[key]) out[key] = secrets[key];
      }
      return { values: out, configured: Object.keys(out) };
    },
    [CAP_METHODS.secretsSet]: ({ values } = {}) => {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('E_ARGS', 'values 必须是对象');
      writePluginSecrets(dataDir, pluginId, values, secretKeys);
      log(`[plugin:${pluginId}] 更新了凭据字段：${Object.keys(values).filter((key) => secretKeys.includes(key)).join(', ')}`);
      return { ok: true };
    },
    [CAP_METHODS.approvalCheck]: ({ action, consume = true } = {}) => {
      const key = String(action ?? '');
      if (!approvalActions.has(key)) throw fail('E_NOT_DECLARED', `动作 ${key || '(空)'} 没有在 manifest.approvals 里声明`);
      if (devApproveAll) {
        // 只给本地开发：生产宿主没有这个注入点，授权仍由控制台/管理员批准。
        stats.approvals += 1;
        log(`[plugin:${pluginId}] 授权检查 ${key}：dev --approve-all 放行`);
        return { approved: true, reason: 'dev --approve-all', expiresAt: nowFn() + 3600000, usesLeft: 1 };
      }
      const result = checkApproval(dataDir, pluginId, key, {
        consume: consume !== false, now: nowFn(), manifestHash: hashManifest(pluginManifest)
      });
      stats.approvals += 1;
      log(`[plugin:${pluginId}] 授权检查 ${key}：${result.approved ? '通过' : `拒绝（${result.reason}）`}`);
      return result;
    },
    [CAP_METHODS.quotaConsume]: ({ action, amount = 1 } = {}) => {
      const key = String(action ?? '');
      if (!Object.prototype.hasOwnProperty.call(quotas, key)) {
        throw fail('E_NOT_DECLARED', `动作 ${key || '(空)'} 没有在 manifest.quotas 里配置上限`);
      }
      return consumeQuota(dataDir, pluginId, key, quotas[key], { amount, now: nowFn() });
    },
    [CAP_METHODS.mediaDownload]: async ({ url, name, maxBytes, headers } = {}) => {
      const target = String(url ?? '').trim();
      if (!target) throw fail('E_ARGS', 'url 不能为空');
      let parsed;
      try { parsed = new URL(target); } catch { throw fail('E_ARGS', 'url 不是合法地址'); }
      if (!/^https?:$/.test(parsed.protocol)) throw fail('E_ARGS', '只允许 http/https');
      if (!isHostAllowed(parsed.hostname, httpDomains)) {
        throw fail('E_DOMAIN', `域名 ${parsed.hostname} 不在插件的 httpDomains 白名单里`);
      }
      const fileName = String(name ?? '').trim();
      if (!MEDIA_NAME_RE.test(fileName)) throw fail('E_ARGS', 'name 只能包含字母/数字/点/下划线/连字符（≤64 位）');
      const cap = Math.max(1, Math.min(MAX_MEDIA_BYTES, Math.floor(Number(maxBytes) || MAX_MEDIA_BYTES)));
      const cleanHeaders = {};
      if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
        for (const [key, value] of Object.entries(headers).slice(0, MAX_HTTP_HEADERS)) {
          if (key.length > 64 || /[\r\n]/.test(key) || /[\r\n]/.test(String(value))) throw fail('E_ARGS', 'headers 含非法字符');
          if (String(value).length > MAX_HEADER_CHARS) throw fail('E_ARGS', '请求头过长');
          cleanHeaders[key] = String(value);
        }
      }
      const fetched = await safeFetchBinary(target, cap, undefined, { allowPrivate: false, headers: cleanHeaders, allowedDomains: httpDomains.length ? httpDomains : null });
      fs.mkdirSync(mediaDir, { recursive: true });
      const file = path.join(mediaDir, fileName);
      // 磁盘配额：先把新文件算进去，超了就拒绝（不写半个文件，也不把老文件删掉）
      assertDiskRoom(fetched.buffer.length);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, fetched.buffer);
      fs.renameSync(tmp, file);
      diskCache = { at: 0, kb: 0 };   // 让下一次检查重新统计
      pruneMedia();
      stats.mediaDownloads += 1;
      return { file: fileName, bytes: fetched.buffer.length, contentType: fetched.contentType || '' };
    },
    [CAP_METHODS.mediaProbe]: async ({ file } = {}) => {
      const target = mediaFile(file);
      const result = await runTool('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration,size,format_name', '-of', 'json', target
      ], 15000);
      let info = {};
      try { info = JSON.parse(result.stdout || '{}')?.format || {}; } catch { /* 下面统一报错 */ }
      return {
        duration: Number(info.duration) || 0,
        bytes: Number(info.size) || 0,
        format: String(info.format_name || '')
      };
    },
    [CAP_METHODS.mediaMerge]: async ({ video, audio, name } = {}) => {
      const videoPath = mediaFile(video);
      const audioPath = mediaFile(audio);
      const fileName = String(name ?? '').trim();
      if (!MEDIA_NAME_RE.test(fileName)) throw fail('E_ARGS', 'name 只能包含字母/数字/点/下划线/连字符（≤64 位）');
      const outPath = path.join(mediaDir, fileName);
      // 参数固定、不过 shell：插件没法借文件名注入命令
      await runTool('ffmpeg', [
        '-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-movflags', '+faststart', outPath
      ], 120000);
      pruneMedia();
      return { file: fileName, bytes: fs.statSync(outPath).size };
    },
    // 抽帧：宿主 ffmpeg 固定参数（-ss 定位 + 单帧 jpg），插件不碰命令行。
    // 一次 1-6 帧：read 管线第二段用；抽完的帧同样住在 media 目录、受文件数上限约束。
    [CAP_METHODS.mediaFrames]: async ({ file, times, prefix } = {}) => {
      const source = mediaFile(file);
      const list = Array.isArray(times) ? times : [];
      if (!list.length || list.length > 6) throw fail('E_ARGS', 'times 要传 1-6 个时间点（毫秒）');
      const safePrefix = String(prefix || 'f').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'f';
      const frames = [];
      for (const [index, raw] of list.entries()) {
        const atMs = Math.max(0, Math.min(24 * 3600_000, Math.floor(Number(raw) || 0)));
        const name = `${safePrefix}_${index}.jpg`;
        try {
          await runTool('ffmpeg', [
            '-y', '-ss', (atMs / 1000).toFixed(3), '-i', source,
            '-frames:v', '1', '-q:v', '3', path.join(mediaDir, name)
          ], 60_000);
        } catch (error) {
          // 单帧失败（时间点越界等）不拖垮整批：继续抽后面的，最后如实报数量
          log(`[plugin:${pluginId}] 抽帧失败 ${name}@${atMs}ms：${error?.message ?? error}`);
          continue;
        }
        if (fs.existsSync(path.join(mediaDir, name))) frames.push({ file: name, atMs });
      }
      if (!frames.length) throw fail('E_MEDIA_TOOL', '一张帧都没抽到（时间点可能超出视频时长）');
      // 抽帧同样住在 media 目录：不剪枝的话，换 prefix 反复抽帧可以无限写盘（2026-10-24 审查 P2）
      pruneMedia();
      return { frames };
    },

    // 帧描述：宿主的视觉模型把画面转成文字（主模型不需要视觉能力，DSH 同款思路）
    [CAP_METHODS.mediaDescribe]: async ({ file, prompt } = {}) => {
      const source = mediaFile(file);
      if (!/\.(jpe?g|png)$/i.test(source)) throw fail('E_ARGS', 'describe 只支持 jpg/png 帧');
      if (fs.statSync(source).size > 8 * 1024 * 1024) throw fail('E_TOO_BIG', '帧图超过 8MB');
      if (!visionEnabled()) {
        throw fail('E_NO_VISION', '宿主没有可用的视觉模型（模型不支持或已关闭图片输入）：帧会照常抽出但无法转成文字');
      }
      const mime = /\.png$/i.test(source) ? 'png' : 'jpeg';
      const dataUrl = `data:image/${mime};base64,${fs.readFileSync(source).toString('base64')}`;
      const response = await chatCompletion({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: String(prompt || '').slice(0, 500) || '描述这一帧画面：能读出的文字/数字/界面/图表/人物动作，说具体内容，别猜画面外的事。' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }],
        maxTokens: 500,
        purpose: 'media-describe'
      });
      const text = String(response?.choices?.[0]?.message?.content ?? '').trim();
      if (!text) throw fail('E_VISION', '视觉模型没有返回描述');
      return { description: text.slice(0, 2000) };
    },

    // 音频转写：复用宿主已配置的 ASR（语音消息同一条链路：ffmpeg → 16k PCM → 供应商）
    [CAP_METHODS.asrTranscribe]: async ({ file } = {}) => {
      const source = mediaFile(file);
      if (!asrAvailable()) {
        throw fail('E_NO_ASR', '宿主没有配置语音识别（控制台 → 设置 → 语音识别）：无字幕视频转写需要它');
      }
      const pcm = await ffmpegToPcm(source, { timeoutMs: 15 * 60_000 });
      // 30 分钟封顶：再长就要求先出字幕，别让一次转写跑半小时
      if (pcm.length > 30 * 60 * 32000) {
        throw fail('E_TOO_BIG', '音频超过 30 分钟，转写太慢：这个视频请直接看字幕或换一个');
      }
      const text = await runProvider(undefined, pcm);
      return { text: String(text || '').slice(0, 20000), seconds: Math.round(pcm.length / 32000) };
    },

    [CAP_METHODS.feedPublish]: ({ items } = {}) => {
      // 插件只能"提交候选"，不能调模型、不能发消息；宿主生活层决定用不用。
      // 每插件每天最多 20 条，条目只保留公开元数据（标题/链接/UP/时长/标签/摘要）。
      const list = Array.isArray(items) ? items.slice(0, 20) : [];
      const day = new Date(nowFn()).toISOString().slice(0, 10);
      const inboxDir = path.join(dataDir, 'life-feed-inbox');
      const file = path.join(inboxDir, `${pluginId}.json`);
      let state = { version: 1, pluginId, day, items: [] };
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw?.day === day && Array.isArray(raw.items)) state = raw;
      } catch { /* 没有或坏了就从空开始 */ }
      const existing = new Set(state.items.map((item) => item.id));
      let accepted = 0;
      let rejected = 0;
      for (const item of list) {
        const id = String(item?.id ?? '').trim().slice(0, 100);
        const title = sanitizeUserText(String(item?.title ?? '')).slice(0, 200);
        const url = String(item?.url ?? '').trim();
        const cover = String(item?.cover ?? '').trim();
        if (!id || !title || url.length > 1000 || !/^https?:\/\/\S+$/i.test(url) || existing.has(id) || state.items.length >= 20) {
          rejected += 1;
          continue;
        }
        state.items.push({
          id,
          title,
          url,
          up: sanitizeUserText(String(item?.up ?? '')).slice(0, 60),
          durationSec: Math.max(0, Math.min(7200, Math.round(Number(item?.durationSec) || 0))),
          tags: Array.isArray(item?.tags)
            ? item.tags.map((tag) => sanitizeUserText(String(tag)).slice(0, 30)).slice(0, 6) : [],
          summary: sanitizeUserText(String(item?.summary ?? '')).slice(0, 200),
          // 封面最终是由**协议端**去取的，宿主的 safeFetchBinary 不在这条路上：
          // 只校验 https 挡不住 127.0.0.1 / 169.254.169.254 这类内网目标，入库前先挡掉。
          cover: (() => {
            if (!/^https:\/\//i.test(cover)) return '';
            try { return assertPublicUrlLiteral(cover, { label: '封面地址' }).slice(0, 500); }
            catch { return ''; }
          })(),
          source: `plugin:${pluginId}`,
          addedAt: nowFn()
        });
        existing.add(id);
        accepted += 1;
      }
      if (accepted) {
        try {
          fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
          fs.renameSync(tmp, file);
        } catch (error) {
          throw fail('E_STORAGE', `见闻候选写盘失败：${error?.message || error}`);
        }
      }
      stats.feedItems = (stats.feedItems || 0) + accepted;
      return { accepted, rejected, remaining: Math.max(0, 20 - state.items.length), day };
    },
    [CAP_METHODS.sendFile]: async ({ chatKey, file, name } = {}) => {
      const target = String(chatKey ?? '').trim();
      if (!/^group:\d+$/.test(target)) throw fail('E_ARGS', 'send.file 目前只支持群聊（group:<群号>）');
      const source = mediaFile(file);
      const size = fs.statSync(source).size;
      if (size > MAX_MEDIA_BYTES) throw fail('E_TOO_BIG', `文件超过 ${MAX_MEDIA_BYTES / 1024 / 1024}MB，不能发送`);
      const sender = senderOf();
      takeSendSlot();
      const displayName = String(name || path.basename(source)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
      // NTQQ 的 upload_group_file 只收文件，图片会被 rich media transfer failed。
      // 文件名可能没有扩展名，按魔数识别；是图片就走 image 消息段，否则保持群文件。
      const imageMime = sniffImage(source);
      if (imageMime) {
        if (!sender?.sendImage) throw fail('E_NO_SENDER', '宿主没有可用的图片发送队列');
        // 小图直接内联 base64：协议端跑在容器/另一台机器时也能收到；
        // 大图仍用路径，避免一次把几十 MB 塞进请求体。
        const inlineLimit = sender.onebot?.connected ? MAX_INLINE_IMAGE_BYTES : HTTP_INLINE_IMAGE_BYTES;
        const imageUrl = size <= inlineLimit
          ? `base64://${fs.readFileSync(source).toString('base64')}`
          : source;
        await sender.sendImage(target, {
          id: `plugin-${pluginId}-${path.basename(source)}`,
          url: imageUrl,
          desc: displayName
        }, {});
        log(`[plugin:${pluginId}] 以机器人身份在 ${target} 发了一张图片：${displayName}（${Math.round(size / 1024)}KB）`);
        return { ok: true, chatKey: target, bytes: size, image: true, mime: imageMime };
      }
      if (!sender?.groupFile) throw fail('E_NO_SENDER', '宿主没有可用的发送队列（插件暂时发不了文件）');
      await sender.groupFile(target, { file: source, name: displayName }, {});
      log(`[plugin:${pluginId}] 以机器人身份在 ${target} 发了一个文件：${displayName}（${Math.round(size / 1024)}KB）`);
      return { ok: true, chatKey: target, bytes: size };
    }
  };

  function pruneMedia() {
    try {
      const files = fs.readdirSync(mediaDir)
        .map((name) => ({ name, at: fs.statSync(path.join(mediaDir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const stale of files.slice(MAX_MEDIA_FILES)) {
        fs.rmSync(path.join(mediaDir, stale.name), { force: true });
      }
    } catch { /* 清理失败不影响本次下载 */ }
  }

  /** 把插件给的文件名解析到自己的 media 目录内（拒绝目录穿越与绝对路径）。 */
  function mediaFile(name) {
    const raw = String(name ?? '').trim();
    if (!MEDIA_NAME_RE.test(raw)) throw fail('E_ARGS', 'file 必须是 download/merge 返回的文件名');
    const file = path.resolve(mediaDir, raw);
    if (file !== path.resolve(mediaDir, path.basename(file))) throw fail('E_ARGS', 'file 越界');
    if (!fs.existsSync(file)) throw fail('E_NO_FILE', `找不到文件 ${raw}`);
    return file;
  }

  /** 只读前 16 字节嗅探图片魔数；插件文件名可能没有扩展名，不能只看后缀。 */
  function sniffImage(file) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(16);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return imageType(buf.subarray(0, n));
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* 忽略 */ }
      }
    }
  }

  return {
    methods,
    storageFile,
    stats,
    /** 退出前/巡检时把内存里的状态落盘（v1 是每次 set 即时落盘，这里留个确定性的收口）。 */
    flush() { try { if (storage) persist(); } catch { /* 落盘失败不该阻断停机 */ } }
  };
}
