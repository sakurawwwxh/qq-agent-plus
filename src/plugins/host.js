// 插件宿主：**每个插件一个子进程**，通过 stdio 上的 NDJSON 协议对话。
//
// 为什么不是一个进程装所有插件：权限是按进程给的。一个进程里跑两个插件，等于让它们共享
// 彼此的权限与崩溃面；分开才能做到"这个插件读不到 config.json""那个插件崩了不影响别人"。
//
// 这个类负责的四件事：起进程（带隔离参数）、按 manifest 鉴权能力调用、看住它（心跳/超时/崩溃
// 重启/连续失败停用）、以及停机时收干净。它**不**决定插件的工具能不能给模型用 —— 那是
// registry.js 的门控（默认拒），两边分开放，免得"加载成功"被当成"被授权"。
import fs from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import {
  CAP_REQUIREMENT, HOST_METHODS, encodeMessage, createLineDecoder, isResponse, previewLine, rpcError, rpcResult
} from './protocol.js';
import { pluginLaunchSpec, probeIsolation, networkIsolationSupported } from './isolation.js';
import { createCapabilities } from './capabilities.js';

// 默认时间参数：测试会覆盖成小值，生产用这一套。
export const HOST_DEFAULTS = Object.freeze({
  initTimeoutMs: 5000,
  callTimeoutMs: 20000,
  heartbeatMs: 15000,       // 心跳间隔
  heartbeatMissLimit: 2,    // 连续两次心跳无应答就判死
  shutdownGraceMs: 2000,
  restartBackoffMs: [1000, 5000, 15000],
  maxRestarts: 3,           // 连续崩溃超过这个数就停用（不再空转重启）
  maxRawLinesPerMin: 60     // 插件直接往 stdout 打的行：保留一部分就够排查了，别让它刷日志
});

/** 剥环境变量：子进程默认继承 env，`process.env.QQ_AGENT_*` 读得到 —— 那是凭据与路径（第 0 步实测）。 */
function childEnv(base = process.env) {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TMPDIR', 'TEMP', 'TMP', 'TZ', 'LANG', 'LC_ALL'];
  const env = {};
  for (const key of keep) if (base[key] !== undefined) env[key] = base[key];
  return env;
}

/**
 * 可等待的睡眠。**不能 unref**：unref 的定时器只是"我不阻止进程退出"，
 * 当事件循环里只剩它时（子进程刚退干净就会这样）Node 会直接放弃等待 —— 表现为
 * `stop()` 永远不返回 / "unsettled top-level await"（2026-10-15 服务器实测）。
 * 规则：要 await 的定时器保持引用，后台循环（心跳 / 周期）才 unref。
 */
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export class PluginHost {
  /**
   * @param manifest 已校验过的 manifest（src/plugins/manifest.js）
   * @param dataDir  应用数据目录
   * @param log      宿主日志（Error 实例才会进异常面板，与各 manager 同约定）
   * @param deps     注入点（测试用）：spawn / spawnSyncImpl / checkEntry / now
   */
  constructor({
    manifest, dataDir, log = () => {}, getSettings = () => ({}), getSender = () => null,
    spawn = spawnChild, spawnSyncImpl = spawnSync, nodePath = process.execPath,
    timeouts = {}, capabilities = null, now = () => Date.now(), requireIsolation = true,
    networkIsolation = true, requireNetworkIsolation = false, limits = {},
    approveAll = false, httpMock = null
  } = {}) {
    this.manifest = manifest;
    this.id = manifest.id;
    this.dataDir = dataDir;
    this.log = log;
    this.getSettings = getSettings;
    this.now = now;
    this.spawnImpl = spawn;
    this.spawnSyncImpl = spawnSyncImpl;
    this.nodePath = nodePath;
    this.timeouts = { ...HOST_DEFAULTS, ...timeouts };
    // 隔离不可用时是否拒绝加载（默认拒绝）。置 false 是"我明确接受没有隔离"——
    // 那种情况下插件进程读得到 config.json，所以状态里会带 unconfined:true，控制台如实显示。
    this.requireIsolation = requireIsolation !== false;
    // 网络：默认"有命名空间就断网"；requireNetworkIsolation = 没有网络隔离就拒绝加载（fail-closed，
    // 给"我就是要插件连不出去"的人一个真开关 —— 默认关是因为 Windows/macOS 上根本做不到，
    // 默认打开等于插件生态在那些平台直接不可用）
    this.networkIsolation = networkIsolation !== false;
    this.requireNetworkIsolation = requireNetworkIsolation === true;
    this.limits = { memoryMb: 128, callsPerMinute: 120, concurrency: 4, diskMb: 256, ...limits };
    this.callWindow = [];          // 最近一分钟的调用时间戳（限频用，见 #allowCall）
    this.inFlight = 0;             // 当前在途工具调用数（并发上限用）
    // 插件→宿主的能力调用同样要有闸门：callTool 的限频/并发只拦宿主→插件方向，
    // 拦不住插件在 stdout 里连发 cap.media.download（单次 80MB）把宿主进程打爆。
    this.capInFlight = 0;          // 当前在途能力调用数
    this.mediaInFlight = 0;        // 其中媒体类（下载/合并/抽帧）并发
    this.capWindow = [];           // 媒体/HTTP/日志能力的一分钟窗口
    this.rssKb = 0;                // 最近一次采样到的常驻内存（Linux 读 /proc，其他平台 0）
    this.unconfined = false;
    this.netIsolated = false;
    this.caps = capabilities ?? createCapabilities({
      pluginId: this.id, dataDir, getSettings, log, now, manifest,
      limits: this.limits,
      approveAll, httpMock,
      getSender      // send 能力用：插件发言必须走机器人自己那条队列（守卫全在里面）
    });

    this.state = 'idle';           // idle | starting | running | stopping | stopped | failed
    this.starting = false;         // 重入保护（与 state 分开：崩溃重启时 state 也是 starting）
    this.lastError = '';
    this.startedAt = 0;
    this.restarts = 0;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();      // id -> {resolve, reject, timer, method}
    this.heartbeatTimer = null;
    this.heartbeatMisses = 0;
    this.stopping = false;
    this.rawLines = [];
    this.stats = { calls: 0, timeouts: 0, denied: 0, protocolErrors: 0, crashes: 0 };
    this.decoder = createLineDecoder({
      onMessage: (message) => this.#onMessage(message),
      onParseError: (text) => {
        this.stats.protocolErrors += 1;
        this.#raw(`[插件输出不是协议消息] ${previewLine(text)}`);
      },
      onViolation: (kind) => {
        this.stats.protocolErrors += 1;
        this.log(`[plugin:${this.id}] 协议违规（${kind}），已忽略该段数据`);
      }
    });
  }

  status() {
    return {
      id: this.id,
      name: this.manifest.name,
      version: this.manifest.version,
      capabilities: [...this.manifest.capabilities],
      tools: this.manifest.tools.map((t) => t.name),
      schedule: this.manifest.schedule.map((s) => s.name),
      state: this.state,
      running: this.state === 'running',
      unconfined: this.unconfined,   // true = 本机没隔离且配置允许降级（控制台要显示出来）
      netIsolated: this.netIsolated, // true = 插件进程在无网络的命名空间里（只能走宿主出网）
      rssKb: this.rssKb,             // 最近一次采样到的常驻内存（Linux；其他平台 0）
      limits: { ...this.limits },
      inFlight: this.inFlight,
      restarts: this.restarts,
      startedAt: this.startedAt,
      lastError: this.lastError,
      stats: { ...this.stats },
      storageFile: this.caps.storageFile
    };
  }

  /** 起进程并完成 init 握手。返回 true=可用；false=没起来（原因写进 lastError）。 */
  async start() {
    // 幂等：已经在跑就直接算成功。重入保护用独立的 starting 标记 —— 崩溃重启那条路上
    // state 也会是 'starting'，用它做判断会把重启挡在门外（自锁，重启永远起不来）。
    if (this.#alive() && this.state === 'running') return true;
    if (this.starting) return false;
    this.starting = true;
    try {
      return await this.#startOnce();
    } finally {
      this.starting = false;
    }
  }

  async #startOnce() {
    this.state = 'starting';
    this.stopping = false;
    this.lastError = '';
    this.rssKb = 0;   // 新进程重新采样/上报，别把上一代的高水位带过来
    // 手动 start()（没有 exit 事件）时也要清掉上一代的能力计数
    this.capInFlight = 0;
    this.mediaInFlight = 0;
    this.capWindow = [];

    const entry = this.manifest.entry;
    // 先语法体检：插件写错一个括号，直接 spawn 只会得到"进程秒退"，报错里看不出原因
    const check = this.spawnSyncImpl(this.nodePath, ['--check', entry], { encoding: 'utf8', timeout: 15000 });
    if (check?.status !== 0) {
      this.#fail(`语法检查未通过：${previewLine(String(check?.stderr || check?.error?.message || '').split('\n').slice(-3).join(' '), 300)}`);
      this.state = 'failed';   // 没起子进程就不会有 exit 事件，不置 failed 会永远停在「启动中」
      return false;
    }

    const probe = probeIsolation({ pluginDir: this.#pluginDir(), spawn: this.spawnSyncImpl, nodePath: this.nodePath });
    this.unconfined = !probe.ok;
    if (!probe.ok && this.requireIsolation) {
      // 隔离不可用时**不假装**：默认宁可插件跑不起来，也不能在没有隔离的机器上执行第三方代码
      this.#fail(`隔离不可用：${probe.error}`);
      this.state = 'failed';
      return false;
    }
    if (!probe.ok) {
      // 配置里明确关掉了 requireIsolation：照常起，但这件事必须吵闹地说出来（日志 + 状态 + 控制台）
      this.log(`[plugin:${this.id}] ⚠️ 未隔离运行（${probe.error}）：该插件进程读得到 config.json，风险自负`);
    }
    // 网络隔离：能拦就拦（Linux 上的网络命名空间）。拦不住时按配置决定是拒绝加载还是照跑并说明。
    const netProbe = networkIsolationSupported({ spawn: this.spawnSyncImpl, nodePath: this.nodePath });
    if (this.requireNetworkIsolation && !netProbe.ok) {
      this.#fail(`要求网络隔离但本机做不到：${netProbe.error}（换 Linux，或在配置里关掉 plugins.requireNetworkIsolation）`);
      this.state = 'failed';
      return false;
    }

    try {
      // 启动方式（命令 + 参数）由 isolation.js 现算：隔离参数按**本插件自己的目录**算
      // （probeIsolation 只返回"能不能用"的结论，不缓存参数 —— 缓存一份会把第一个插件的目录发给所有插件）
      // 未隔离时用最朴素的参数起（不加 --permission —— 那组参数在本机跑不起来）
      // requireNetworkIsolation=true 时即使 networkIsolation=false 也必须隔离：
      // 两个独立开关允许这种组合，不能让它静默退化成"带网络启动"。
      const isolateNetwork = this.requireNetworkIsolation || this.networkIsolation;
      const spec = pluginLaunchSpec({
        pluginDir: this.#pluginDir(),
        unconfined: this.unconfined,
        networkIsolation: isolateNetwork,
        memoryMb: this.limits.memoryMb,
        spawn: this.spawnSyncImpl,
        nodePath: this.nodePath
      });
      this.netIsolated = spec.netIsolated;
      this.child = this.spawnImpl(spec.command, [...spec.args, entry], {
        cwd: this.#pluginDir(),
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      if (this.netIsolated && this.unconfined) this.log(`[plugin:${this.id}] 网络已隔离（进程隔离未开启）`);
    } catch (error) {
      this.#fail(`启动失败：${error?.message ?? error}`);
      this.state = 'failed';
      return false;
    }

    this.child.stdout.on('data', (chunk) => this.decoder.push(chunk));
    this.child.stderr.on('data', (chunk) => {
      // 与 stdout 同一条限流：插件刷 stderr（或循环打印错误）不该把宿主日志/journal 灌满
      const text = previewLine(String(chunk), 400);
      if (text) this.#raw(`stderr: ${text}`);
    });
    // 插件的 stdin 是管道：对端关闭/退出后写入会**异步**抛 EPIPE。没有 error 监听时它变成
    // uncaughtException，而 server.js 的策略是直接退出进程 —— 一个坏插件（例如自行 destroy(stdin)
    // 却继续运行）就能带走整个机器人。这里兜住：管道错误不升级成进程级异常，交给 exit/看门狗处理。
    this.child.stdin.on('error', (error) => {
      const code = String(error?.code || '');
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
      this.#raw(`stdin 错误：${error?.message ?? error}`);
    });
    this.child.on('error', (error) => this.#fail(`进程错误：${error?.message ?? error}`));
    this.child.on('exit', (code, signal) => this.#onExit(code, signal));

    // init 握手：带上 apiVersion 与能力清单，插件据此决定自己要不要继续
    try {
      await this.#request(HOST_METHODS.init, {
        apiVersion: this.manifest.apiVersion,
        pluginId: this.id,
        capabilities: [...this.manifest.capabilities],
        settings: this.#settingsForInit()
      }, this.timeouts.initTimeoutMs);
    } catch (error) {
      this.#fail(`init 未完成：${error?.message ?? error}`);
      this.#kill();
      return false;
    }

    this.state = 'running';
    this.startedAt = this.now();
    this.#startHeartbeat();
    return true;
  }

/** 应用层自检（可选）：控制台"检测登录"一类按钮经这里问插件。没实现的插件报 E_NO_METHOD。 */
  probe() {
    this.#allowCall('probe');
    return this.#request(HOST_METHODS.probe, {}, Math.min(15000, this.timeouts.callTimeoutMs));
  }

  /** 让插件执行一个工具调用。超时/进程不可用/超频都会抛带 code 的错误。 */
  async callTool(name, args, { timeoutMs, context = null } = {}) {
    this.#allowCall('callTool');
    // 并发上限：一个插件同时跑太多调用会把宿主的事件循环与内存拖垮。
    // fail-closed 直接拒绝（模型下一轮可以重试），不在宿主里排队堆积。
    const maxConcurrency = Math.max(1, Number(this.limits.concurrency) || 4);
    if (this.inFlight >= maxConcurrency) {
      this.stats.busy = (this.stats.busy || 0) + 1;
      throw Object.assign(
        new Error(`插件 ${this.id} 并发已满（上限 ${maxConcurrency} 个在途调用），请稍后重试`),
        { code: 'E_BUSY' }
      );
    }
    this.inFlight += 1;
    try {
      return await this.#request(HOST_METHODS.callTool, {
        name: String(name ?? ''),
        args: args ?? {},
        context: context && typeof context === 'object' ? context : {}
      }, timeoutMs ?? this.timeouts.callTimeoutMs);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  /**
   * 调用频次闸门：**每分钟上限**（默认 120）。守的是宿主自己 —— 模型可以在一轮里连调同一个工具，
   * 或者一个坏插件让工具"总是失败"引发重试风暴；没有这道闸门，宿主会被自己的工具表拖垮。
   * 周期任务（宿主自己驱动，不由模型触发）不设限。
   */
  #allowCall(kind) {
    const limit = Number(this.limits.callsPerMinute) || 0;
    if (limit <= 0) return;
    const cutoff = this.now() - 60000;
    this.callWindow = this.callWindow.filter((at) => at > cutoff);
    if (this.callWindow.length >= limit) {
      this.stats.rateLimited = (this.stats.rateLimited || 0) + 1;
      throw Object.assign(new Error(`插件 ${this.id} 调用太频繁（每分钟上限 ${limit} 次，来源：${kind}）`), { code: 'E_RATE_LIMIT' });
    }
    this.callWindow.push(this.now());
  }

  /**
   * 能力调用闸门（插件→宿主方向）：并发上限对所有能力生效，媒体类再加"同时 1 个"。
   * 媒体/HTTP/日志额外限频 —— 这三类是内存与磁盘的主要放大器（80MB 下载、整包进内存、
   * 无限刷日志）；storage 这类高频小调用不按分钟限，避免把正常插件卡死。
   */
  #allowCapability(method) {
    const now = this.now();
    const maxConcurrency = Math.max(1, Number(this.limits.concurrency) || 4);
    if (this.capInFlight >= maxConcurrency) {
      this.stats.busy = (this.stats.busy || 0) + 1;
      throw Object.assign(new Error(`插件 ${this.id} 能力调用并发已满（上限 ${maxConcurrency} 个），请稍后重试`), { code: 'E_BUSY' });
    }
    const media = /^media\./.test(method);
    if (media && this.mediaInFlight >= 1) {
      this.stats.busy = (this.stats.busy || 0) + 1;
      throw Object.assign(new Error(`插件 ${this.id} 已有媒体任务在跑，请稍后重试`), { code: 'E_BUSY' });
    }
    if (media || /^http\./.test(method) || /^log\./.test(method)) {
      const limit = Number(this.limits.callsPerMinute) || 0;
      if (limit > 0) {
        this.capWindow = this.capWindow.filter((at) => at > now - 60000);
        if (this.capWindow.length >= limit) {
          this.stats.rateLimited = (this.stats.rateLimited || 0) + 1;
          throw Object.assign(new Error(`插件 ${this.id} 能力调用太频繁（每分钟上限 ${limit} 次，来源：${method}）`), { code: 'E_RATE_LIMIT' });
        }
        this.capWindow.push(now);
      }
    }
  }

  /** 主动采样一次 RSS（注册表做"全部插件总内存"预算时用；非 Linux 返回插件自报值）。 */
  refreshRss() {
    return this.#sampleRss();
  }

  /**
   * 采样插件进程的常驻内存（Linux 读 /proc/<pid>/statm，其他平台返回 0 = 采样不到）。
   * 超上限不直接杀 —— 交给看门狗按"异常"处理（重启 + 日志 + 计数），避免误杀正在干活的插件。
   */
  #sampleRss() {
    const pid = this.child?.pid;
    if (!pid) return this.rssKb;
    // 非 Linux 没有 /proc：保留插件自己在 ping 应答里报的 rssKb（没报就是 0）。
    if (process.platform !== 'linux') return this.rssKb;
    try {
      const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/);
      const pages = Number(statm[1]) || 0;                    // [1] = resident
      this.rssKb = Math.round((pages * 4096) / 1024);
    } catch {
      // 读不到就**清零**，别保留上一次的值：进程刚重启时 pid 可能还不存在，留着旧进程的高水位
      // 会把刚起来的那个当成"超限"直接杀掉。清零的代价只是这一拍不设防（堆上限仍由 V8 管）。
      this.rssKb = 0;
    }
    return this.rssKb;
  }

  /**
   * 内存超限就重启（返回 true = 已触发重启）。
   *
   * `limits.memoryMb` 是 **V8 堆上限**；常驻内存（RSS）会多出 Node 二进制、堆外的 C++ 结构等开销，
   * 所以看门狗用 1.5 倍作为阈值 —— 两者用同一个数会自相矛盾（RSS 永远先撞线，
   * 表现是"插件刚起来就被判超限"）。真把上限设得很小时，进程可能还没到 init 就被 V8 自己按堆上限带走，
   * 那是另一回事（日志里能看到退出码）。
   */
  #enforceMemoryLimit() {
    const cap = Number(this.limits.memoryMb) || 0;
    if (cap <= 0 || !this.rssKb) return false;
    if (this.rssKb <= cap * 1.5 * 1024) return false;
    this.stats.memoryKills = (this.stats.memoryKills || 0) + 1;
    this.#raw(`[插件内存超过上限] 实测 ${(this.rssKb / 1024).toFixed(0)}MB > ${cap}MB，重启该插件进程`);
    this.#kill();
    return true;
  }

  /** 周期任务由宿主驱动（这样插件重启后周期不会丢），失败不向上抛。 */
  async runSchedule(name) {
    try {
      await this.#request(HOST_METHODS.schedule, { name: String(name ?? '') }, this.timeouts.callTimeoutMs);
      return true;
    } catch (error) {
      this.log(`[plugin:${this.id}] 周期任务 ${name} 失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 投递一条入站消息（**只读观察**：插件看得到，但改不了内容、也拦不住消息 —— 它没有返回值
   * 通道，宿主也不等它）。没在跑就丢掉：插件停机期间的消息不需要补课。
   */
  observe(event) {
    if (this.state !== 'running') return false;
    return this.#notify(HOST_METHODS.observe, event);
  }

  /**
   * 停机：先请它自己退，宽限期内没动静就 kill。
   *
   * ⚠️ 只收**这一次停机开始时的那一代**子进程：宽限期内如果被重新 start 了（懒启动的空闲停遇上
   * 一次新调用），手里的 child 已经换了人 —— 继续按 this.child 收就会把新进程 SIGKILL 掉，
   * 然后因为 stopping 被清掉而当崩溃重启，插件在"已停掉"之后又活过来（日志还写着"空闲 N 分钟"）。
   */
  async stop() {
    if (this.state === 'idle' || this.state === 'stopped') { this.state = 'stopped'; return; }
    this.stopping = true;
    this.wakeSleep?.();          // 正在退避等待重启的话，立刻放行（别再等满退避）
    this.state = 'stopping';
    const target = this.child;   // 这一代
    try { this.#notify(HOST_METHODS.shutdown, {}); } catch { /* 已经不在就算了 */ }
    // 宽限期用**真实时钟**：注入的 now 可能被测试冻住，用它会让这个循环永远转下去
    const deadline = Date.now() + this.timeouts.shutdownGraceMs;
    while (target && this.child === target && this.#alive(target) && Date.now() < deadline) {
      await delay(50);
    }
    if (this.child === target) {
      this.#kill();
      // 等它**真的退出**再返回：卸载/回退会在 stop() 之后 rename 插件目录，而 Windows 上
      // rename 一个存活进程的 cwd 会 EPERM/EBUSY。上限 1.5 秒，等不到也不阻塞（日志里看得到）。
      await this.#waitExit(target, 1500);
      this.state = 'stopped';
    }
    this.caps.flush();
  }

  /** 等某个子进程退出（最多 ms 毫秒）。已经退了的立刻返回。 */
  #waitExit(child, ms = 1500) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => done(false), ms);
      child.once('exit', () => done(true));
    });
  }

  #pluginDir() { return this.manifest.dir || ''; }
  #alive(child = this.child) { return Boolean(child) && child.exitCode === null && child.signalCode === null; }
  #settingsForInit() { return structuredClone(this.getSettings() ?? {}); }

  #fail(reason) {
    this.lastError = String(reason ?? '');
    this.log(`[plugin:${this.id}] ${this.lastError}`);
  }

  /** 插件直接打在 stdout 上的行：留一部分当线索，超量就只计数（防刷屏）。 */
  #raw(line) {
    const t = this.now();
    while (this.rawLines.length && t - this.rawLines[0] > 60_000) this.rawLines.shift();
    if (this.rawLines.length >= this.timeouts.maxRawLinesPerMin) return;
    this.rawLines.push(t);
    this.log(`[plugin:${this.id}] ${previewLine(line)}`);
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeatMisses = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'running') return;
      // 每一拍顺手采一次内存：超上限就走"当成异常重启"那条路（不静默杀，也不放任它吃到把机器拖垮）
      this.#sampleRss();
      if (this.#enforceMemoryLimit()) return;
      this.#request(HOST_METHODS.ping, {}, Math.max(1000, Math.floor(this.timeouts.heartbeatMs / 2)))
        .then((reply) => {
          this.heartbeatMisses = 0;
          // 跨平台 RSS：插件可以在 ping 应答里带 { rssKb }（Windows/macOS 没有 /proc）。
          if (process.platform !== 'linux' && Number.isFinite(Number(reply?.rssKb))) {
            this.rssKb = Math.max(0, Math.round(Number(reply.rssKb)));
          }
        })
        .catch(() => {
          this.heartbeatMisses += 1;
          if (this.heartbeatMisses >= this.timeouts.heartbeatMissLimit) {
            this.log(`[plugin:${this.id}] 连续 ${this.heartbeatMisses} 次心跳无应答，重启该插件进程`);
            this.#kill(new Error('心跳超时'));
          }
        });
    }, this.timeouts.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** 可被打断的睡眠：stop() 调 this.wakeSleep?.() 立刻放行。 */
  #interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wakeSleep = null; resolve(); }, ms);
      this.wakeSleep = () => { clearTimeout(timer); this.wakeSleep = null; resolve(); };
    });
  }

  #kill(reason) {
    try { this.child?.kill('SIGKILL'); } catch { /* 已经退了 */ }
    if (reason) this.lastError = String(reason.message ?? reason);
  }

  async #onExit(code, signal) {
    this.#stopHeartbeat();
    // 进程在写操作中途退出 = 结果未知：必须带 E_PLUGIN_DOWN，让 registry 走 unknown 而不是
    // 当"确定失败"退款——插件可能已经把评论/弹幕发出去了（2026-11-03 全量审查 P1）。
    this.#rejectAll(Object.assign(
      new Error(`插件进程退出（code=${code}, signal=${signal}）`),
      { code: 'E_PLUGIN_DOWN' }
    ));
    // 旧代发起的能力调用可能还在宿主里跑（下载/HTTP 没有总截止）。计数不归零的话，
    // 新进程的 media.* 会一直被上一代占着并发位、永久 E_BUSY。
    this.capInFlight = 0;
    this.mediaInFlight = 0;
    this.capWindow = [];
    if (this.stopping || this.state === 'stopped' || this.state === 'stopping') { this.state = 'stopped'; return; }
    this.stats.crashes += 1;
    this.child = null;
    // 稳稳跑过一段时间的插件，一次崩溃不该计入"连续崩溃"：否则一个月里零星崩三次就被停用了
    if (this.startedAt && this.now() - this.startedAt > 5 * 60_000) this.restarts = 0;
    this.startedAt = 0;
    if (this.restarts >= this.timeouts.maxRestarts) {
      // 连续崩够次数就停用：空转重启只会一直刷日志、一直烧 CPU
      this.state = 'failed';
      this.#fail(`连续崩溃 ${this.restarts + 1} 次（已自动重启 ${this.restarts} 次，最后 code=${code}, signal=${signal}），已停用该插件`);
      return;
    }
    const wait = this.timeouts.restartBackoffMs[Math.min(this.restarts, this.timeouts.restartBackoffMs.length - 1)];
    this.restarts += 1;
    this.state = 'starting';
    this.log(`[plugin:${this.id}] 进程退出（code=${code}, signal=${signal}），${Math.round(wait / 1000)} 秒后重启（第 ${this.restarts} 次）`);
    // 可被打断的退避：停机时不该为一个后台重试干等（最多 15 秒），stop() 会叫醒它
    await this.#interruptibleSleep(wait);
    if (this.stopping) { this.state = 'stopped'; return; }
    const ok = await this.start();
    if (!ok) this.state = 'failed';
  }

  #rejectAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  #notify(method, params) {
    if (!this.child?.stdin?.writable) return false;
    // 写入错误必须就地吞掉（EPIPE 表示对端已关，真正的处理在 exit/看门狗那边）；
    // 不传回调时错误会以 'error' 事件冒出来，见 spawn 后的 stdin 监听注释。
    this.child.stdin.write(encodeMessage({ method, params }), (error) => {
      if (error && error.code !== 'EPIPE') this.#raw(`写入失败（${method}）：${error?.message ?? error}`);
    });
    return true;
  }

  #request(method, params, timeoutMs) {
    if (!this.#alive()) return Promise.reject(Object.assign(new Error(`插件未在运行（${this.id}）`), { code: 'E_PLUGIN_DOWN' }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      // 同上：这个定时器的职责就是"到点把 promise 结清"，必须保持引用
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats.timeouts += 1;
        reject(Object.assign(new Error(`${method} 超时（${timeoutMs}ms）`), { code: 'E_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(encodeMessage({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error(`写入插件 stdin 失败：${error?.message ?? error}`), { code: 'E_PIPE' }));
      });
    });
  }

  #onMessage(message) {
    if (isResponse(message)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;                     // 迟到的应答（超时后到达）：丢掉
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(Object.assign(new Error(String(message.error.message ?? '插件报错')), {
          code: String(message.error.code || 'E_PLUGIN')
        }));
      } else {
        entry.resolve(message.result ?? null);
      }
      return;
    }
    // 插件发起的请求：只可能是能力调用（cap.*），逐条按 manifest 声明鉴权
    if (typeof message?.method === 'string') return this.#onCapability(message);
    this.stats.protocolErrors += 1;
    this.#raw(`[无法识别的消息] ${previewLine(JSON.stringify(message))}`);
  }

  async #onCapability(message) {
    const { id, method, params } = message;
    const reply = (payload) => {
      if (id === undefined || id === null || !this.child?.stdin?.writable) return;
      this.child.stdin.write(encodeMessage(payload), (error) => {
        if (error && error.code !== 'EPIPE') this.#raw(`能力应答写入失败：${error?.message ?? error}`);
      });
    };
    const required = CAP_REQUIREMENT[method];
    if (!required) {
      reply(rpcError(id, 'E_NO_METHOD', `未知能力方法：${method}`));
      this.stats.protocolErrors += 1;
      return;
    }
    if (!this.manifest.capabilities.includes(required)) {
      // 没在 manifest 里声明就调 = 越权。记下来（控制台能看到），并且拒绝
      this.stats.denied += 1;
      this.log(`[plugin:${this.id}] 越权调用 ${method}（未声明能力 "${required}"），已拒绝`);
      reply(rpcError(id, 'E_CAP_DENIED', `未声明能力 "${required}"`));
      return;
    }
    try {
      this.#allowCapability(method);
    } catch (error) {
      reply(rpcError(id, error?.code || 'E_CAP', error?.message ?? String(error)));
      return;
    }
    const media = /^media\./.test(method);
    this.capInFlight += 1;
    if (media) this.mediaInFlight += 1;
    try {
      const result = await this.caps.methods[method](params ?? {});
      reply(rpcResult(id, result ?? null));
    } catch (error) {
      reply(rpcError(id, error?.code || 'E_CAP', error?.message ?? String(error)));
    } finally {
      this.capInFlight = Math.max(0, this.capInFlight - 1);
      if (media) this.mediaInFlight = Math.max(0, this.mediaInFlight - 1);
    }
  }
}
