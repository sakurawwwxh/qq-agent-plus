// 巡检核心（改进方案 C8/#7）：供 `node src/ops.js health-check` 调用，也被
// qq-agent-health.timer 每 5 分钟触发。只读检查 + data/health.json 里的失败连击计数，
// 连续 3 次失败才通过 notify 通知 owner（抑制抖动），恢复时补发一次"已恢复"。
// fetchImpl / statfs 可注入：测试不打真实网络。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from './sqlite.js';
import { budgetStatus } from './budget.js';
import {
  SNOWLUMA_BASELINE_IMAGE, SNOWLUMA_MIN_RECOMMENDED, readComposeEnv, parseImage, compareVersions
} from './snowluma-update.js';

const OUTBOUND_STALE_MS = 6 * 60 * 60 * 1000;   // 入站静默窗口：6 小时没人说话＝静默期（原名出站水位，
                                                // 2026-10-02 判据改版后只用于比较入站时间）
const STUCK_INBOUND_MS = 60 * 60 * 1000;        // 入站到期未处理的宽限：pacing（自主节奏）下消息
                                                // 按设计可等 maxSilence（默认上限 45 分钟）才统一处理，
                                                // 60 分钟覆盖它之后仍停在 pending 才是管道死了
const DISK_MIN_BYTES = 1024 * 1024 * 1024;       // 磁盘余量：< 1GB 报警
const NOTIFY_AFTER_STREAK = 3;                   // 连续失败到第 3 次才通知
// 两个本机探测必须带超时（2026-10-01 审查）：原来一次 fetch 用 undici 的默认上限（约 5 分钟），
// 控制台半死不活（接受连接但不响应）时，一轮巡检会被它拖住整个超时窗口 ——
// 而 qq-agent-health.timer 是 5 分钟一次，等于巡检自己叠在一起排不上。
const FETCH_TIMEOUT_MS = 10 * 1000;

/**
 * 更新路径的 `sudo -n docker` 回退通不通（与 src/core/snowluma-update.js 的 runDocker 同一条路）。
 * 用 `-n`：绝不弹密码提示；超时也压住，不让一次巡检被 sudo 拖住。
 */
function probeSudoDocker() {
  try {
    const res = spawnSync('sudo', ['-n', 'docker', 'info', '--format', '{{.ServerVersion}}'],
      { timeout: 8000, stdio: 'ignore' });
    return res?.status === 0;
  } catch {
    return false;
  }
}

/**
 * 控制台**主进程**是否被 NoNewPrivileges 加固：加固时 `sudo -n docker` 在那边**必失败**
 * （内核禁止 setuid 提权），巡检就不能拿"巡检进程自己能 sudo"当"功能可用"的证据 ——
 * 那会造出一条永不过期的假绿：巡检报"更新会走回退"，用户点按钮照样失败
 *（2026-10-09 审查；标准 unit 由 install-service.mjs 生成，默认带 NNP）。
 * 路径：systemctl show MainPID → /proc/<pid>/status 的 NoNewPrivs。
 * 拿不到（非 Linux / 服务没在跑）时按"未加固"处理 —— 保持旧行为。
 */
function mainServiceHasNoNewPrivs(service) {
  try {
    const name = String(service || '').trim();
    if (!name) return false;
    const out = spawnSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', name],
      { timeout: 5000, encoding: 'utf8' });
    const pid = Number(String(out?.stdout || '').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    return /NoNewPrivs:\s*1/.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return false;
  }
}

function loadState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'health.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : { streaks: {} };
  } catch {
    return { streaks: {} };
  }
}

function saveState(dataDir, state) {
  const file = path.join(dataDir, 'health.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Agent 是否处于暂停态（runtime.paused 持久化在 config.json；读不到按未暂停）。 */
function readRuntimePaused(dataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return cfg?.runtime?.paused === true;
  } catch {
    return false;
  }
}

/**
 * 当日预算用尽、且策略本身就会**保留未读**（此时"到期未处理"是设计使然，不该报停滞）。
 * degrade：只回 @，其余保留未读；block：整批不跑，消息留到明天 —— 两种都会让消息堆着，
 * 只豁免 degrade 的话 block 用户每天都会收到一条"收发链路可能停滞"的误报（2026-10-08 审查）。
 */
function readBudgetKeepPending(dataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const usage = JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-today.json'), 'utf8'));
    const status = budgetStatus(cfg, usage);
    return status.exceeded && ['degrade', 'block'].includes(status.onExceed);
  } catch {
    return false;
  }
}

/**
 * 跑一轮巡检。
 * @param {object} opts
 *   dataDir / mode(observe|active) / consolePort / onebotHttpPort / onebotToken
 *   notify: async (text) => void|null   通知通道（ops.js 里接 core/notify-owner）
 *   fetchImpl / statfs / sudoDockerProbe 注入点（测试）
 * @returns {{ healthy: boolean, checks: Array, notified: string[], code: number }}
 */
export async function runHealthCheck(opts = {}) {
  const {
    dataDir,
    mode = 'active',
    consolePort = 3210,
    onebotHttpPort = 3390,
    onebotToken = '',
    snowlumaDir = '',
    service = '',
    noNewPrivsStatus = null,   // 可注入（测试）：null＝自动探测主服务进程
    sudoDockerProbe = null,    // 可注入（测试）：null＝走真实 probeSudoDocker()
    outboundStaleMs = OUTBOUND_STALE_MS,
    notify = null,
    fetchImpl = globalThis.fetch,
    fetchTimeoutMs = FETCH_TIMEOUT_MS,
    statfs = null,
    now = Date.now(),
  } = opts;

  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  // AbortSignal.timeout 覆盖整次请求（含读 body）：挂死的服务在 fetchTimeoutMs 内必被中止，
  // 巡检不会为它多等一个 undici 默认超时。
  const probeSignal = () => AbortSignal.timeout(fetchTimeoutMs);

  // ① 控制台 /healthz
  try {
    const res = await fetchImpl(`http://127.0.0.1:${consolePort}/healthz`, { signal: probeSignal() });
    add('console-healthz', res.ok, `HTTP ${res.status}`);
  } catch (error) {
    add('console-healthz', false, error?.message ?? String(error));
  }

  // ② OneBot get_status
  try {
    const headers = { 'content-type': 'application/json' };
    if (onebotToken) headers.authorization = `Bearer ${onebotToken}`;
    const res = await fetchImpl(`http://127.0.0.1:${onebotHttpPort}/get_status`, { method: 'POST', headers, body: '{}', signal: probeSignal() });
    const data = await res.json().catch(() => ({}));
    add('onebot-status', res.ok && data?.status === 'ok', res.ok ? `retcode=${data?.retcode ?? '?'}` : `HTTP ${res.status}`);
  } catch (error) {
    add('onebot-status', false, error?.message ?? String(error));
  }

  // ②b 协议端（SnowLuma）版本：只读 compose 项目的 .env（不 exec docker，巡检要便宜且无副作用）。
  // 低于推荐版本**不算不健康**（机器人照常工作，只是贴纸会显示成图片），所以 ok=true + 在
  // detail 里把"该升级"说清楚 —— 控制台「设置 → OneBot」页可以一键更新。
  try {
    if (!snowlumaDir) add('protocol-version', true, '未配置协议端目录（跳过）');
    else {
      const env = readComposeEnv(snowlumaDir);
      const version = parseImage(env.image).version;
      if (!env.exists) add('protocol-version', true, '没找到协议端 compose 项目（跳过）');
      else if (!version) add('protocol-version', true, `镜像 tag 认不出：${env.image || '(空)'}`);
      else if (compareVersions(version, SNOWLUMA_MIN_RECOMMENDED) < 0) {
        add('protocol-version', true,
          `${version} 低于推荐 ${SNOWLUMA_MIN_RECOMMENDED}（贴纸会显示成图片）；控制台可一键更新到 ${parseImage(SNOWLUMA_BASELINE_IMAGE).version}`);
      } else {
        add('protocol-version', true, `${version}（镜像 ${env.image}）`);
      }
    }
  } catch (error) {
    add('protocol-version', true, `跳过：${error?.message ?? error}`);
  }

  // ②b Docker 套接字可读写性（Issue #30）。
  //     协议端是靠 docker 管的，控制台里的「更新协议端」要能连上守护进程。
  //     这里用 fs.access 而不是跑 `docker info`：要的就是“这个进程的组对不对”
  //     这一个事实，不依赖守护进程本身健不健康，也不引入外部命令。
  //     ⚠️ 这一项只代表**拉起巡检的那个进程**有没有权限。巡检由 systemd timer 拉起，
  //     组同样来自 systemd --user 管理器 —— 所以它恰好能提前抓到
  //     “管理员后加进 docker 组、但用户管理器没重建”那种状态（交互 shell 里 docker 好用、
  //     只有控制台里报 permission denied），而那正是只会在点下“更新协议端”那一刻才爆发的坑。
  try {
    const dockerHost = String(process.env.DOCKER_HOST || '');
    const sock = dockerHost.startsWith('unix://') ? dockerHost.slice('unix://'.length) : '/var/run/docker.sock';
    fs.accessSync(sock, fs.constants.R_OK | fs.constants.W_OK);
    add('docker-socket', true, `可读写 ${sock}`);
  } catch (error) {
    // 主进程被 NNP 加固时回退必失败（2026-10-09 审查）：先判，别让"巡检能 sudo"造成假绿。
    const hardened = noNewPrivsStatus ?? mainServiceHasNoNewPrivs(service);
    if (error?.code === 'ENOENT') {
      // 没装 docker、或用了远程 DOCKER_HOST ——与 protocol-version 的“跳过”同一口径：
      // 这不是异常，不该把巡检报红。
      add('docker-socket', true, '没有 docker 套接字（未装 docker 或用了远程 DOCKER_HOST，跳过）');
    } else if (hardened) {
      add('docker-socket', false,
        `${error?.code || '不可读'}：控制台主进程被 NoNewPrivileges 加固，sudo 回退不可用，`
        + '更新协议端会失败；修法见 docs/LINUX.md「控制台里更新协议端报 docker 权限不足」');
    } else if ((sudoDockerProbe ?? probeSudoDocker)()) {
      // ⚠️ 关键：不能只因为"直连不可用"就报失败。更新路径有一条 `sudo -n docker` 回退
      //（Issue #30，与 deploy-all.sh 同一条路），那条路通则功能就是**能用**的。
      // 只报直连失败会造出一条**永不过期的误报**：巡检每 5 分钟失败一次、连击 3 次通知 owner，
      // 而因为那个条件不会自己恢复，也永远不会有"已恢复"通知。
      add('docker-socket', true,
        `直连不可用（${error?.code || '不可读'}），但 sudo -n docker 可用 —— 更新协议端会走回退；`
        + '永久修法见 docs/LINUX.md「控制台里更新协议端报 docker 权限不足」');
    } else {
      add('docker-socket', false,
        `${error?.code || '不可读'}：直连与 sudo -n docker 回退都不可用，控制台里更新协议端会失败；`
        + '见 docs/LINUX.md「控制台里更新协议端报 docker 权限不足」');
    }
  }

  // ③ 入站处理水位：判据是"**到期的入站消息有没有被处理**"，而不是"入站新 → 出站必须新"，
  //    也不是"bot 一直没说话"。
  // - observe 模式本来就不发消息 → 跳过（否则每 5 分钟固定误报）。
  // - 窗口内没有入站消息（深夜/冷清时段）→ 静默期，出站为空是正常行为 → 记 ok。
  //   2026-10-01 实测踩到：凌晨 00:13 部署后群里没人说话，出站水位在 05:40 越过 6 小时，
  //   连击到 3 次就私聊 owner 报"收发停止" —— 纯误报，判据本身把静默期排除掉。
  // - 2026-10-02 08:15 第二种误报：入站很新，但编排器按响应概率**决定不回**（日志：
  //   「未命中触发条件（概率 60%，未触发），已标记已读、不响应」），旧判据"入站新 → 出站必须新"
  //   把这种合法沉默当成收发停止，又弹了一次告警。实际上对每条入站消息，编排器要么发起回复、
  //   要么决定不回并标记已读（state='acked'），补课窗口外的入库时更是直接 acked —— 两者都算
  //   "处理过"。time-gate 的 held（故意延迟）和发送失败重试的 backoff（available_at 在未来）
  //   也都不是卡住。所以真正的故障信号只剩一个：**有消息到期了却一直停在 pending**——管道死掉
  //   才会出现这种堆积。
  // - 三种"故意不处理"要显式豁免（2026-10-02 复审补）：① 观察模式；② Agent 已暂停
  //   （orchestrator 在 paused 时直接 return，消息留在 pending）；③ 当日预算用尽且
  //   onExceed='degrade'（文档化行为："保留未读，被 @ 或跨日再处理"）。没有这三条豁免，
  //   暂停一天或预算超限的部署会被误报成"收发停滞"。
  // - STUCK_INBOUND_MS 取 60 分钟：pacing（自主节奏）下消息被设计为等待
  //   minWake~maxSilence 分钟（默认 20、上限 45）才统一处理，30 分钟宽限会把 paced 消息
  //   误判成卡住；60 分钟覆盖 pacing 上限 + 一轮宽限。注意：maxSilenceMinutes 若手工改到
  //   > 60，这里要同步调大，否则 paced 消息会被误报（控制台不暴露该键）。
  // - 2026-10-02 复审补 P1：**failed（重试耗尽）也算"没被处理"**。模型网关整体打挂时，
  //   消息会在十几秒内被三次重试耗尽、全部转 failed（这类行只有控制台手动 retry-failed 才会
  //   复活），出站随之中断 —— 只看 pending 会把这种"进程活着但完全答不了话"静默漏报。
  //   failed 只认**发生在最后一次成功出站之后**的：偶发单条失败而 bot 之后还能正常说话，
  //   不算链路停滞；生产库里两周前的旧 failed 也落在观察窗口外，不追打。
  //   已知边界：发送结果待确认（held / outbox sending|unknown）的批次不在判据内 ——
  //   那条链路由控制台的"待核对"流程人工兜底，暂不并入自动告警（避免与 time-gate 的
  //   故意延迟混淆）。
  // - 也因此不再用"还没有出站记录"提前放行：从未成功发过消息的部署，只要入站到期未处理
  //   同样要报（原先这条早退会让"模型没配/从未发出"的部署永远绿）。
  if (mode === 'observe') {
    add('outbound-freshness', true, '跳过（observe 模式不发消息）');
  } else if (readRuntimePaused(dataDir)) {
    add('outbound-freshness', true, '跳过（Agent 已暂停，消息按设计留在未读）');
  } else if (readBudgetKeepPending(dataDir)) {
    add('outbound-freshness', true, '跳过（当日预算已用尽且策略为 degrade/block：保留未读是设计行为）');
  } else {
    try {
      const db = openDatabase(path.join(dataDir, 'messages.sqlite'), { readOnly: true });
      try {
        const out = db.prepare('SELECT max(ts) AS m FROM messages WHERE self=1').get();
        const inbound = db.prepare('SELECT max(ts) AS m FROM messages WHERE self=0').get();
        const outAge = out === undefined || out.m === null ? null : now - Number(out.m);
        const inAge = inbound === undefined || inbound.m === null ? null : now - Number(inbound.m);
        if (inAge === null) {
          add('outbound-freshness', true, '静默期：还没有入站消息记录（没有人在说话，出站为空属正常）');
        } else if (inAge > outboundStaleMs) {
          add('outbound-freshness', true, `静默期：最近一次入站距今 ${Math.round(inAge / 60000)} 分钟（超过 ${Math.round(outboundStaleMs / 60000)} 分钟没人说话，出站为空属正常）`);
        } else {
          // 卡住的入站 = 到期仍未处理，两类：① pending 且已到期（max(ts, available_at) 过
          // 宽限线 —— available_at 在未来的是显式排期/退避重试，不是卡住；held 天然不算）；
          // ② failed（重试耗尽）且发生在最后一次成功出站之后（见上方注释的取舍）。
          // 两类都限定在观察窗口内：窗口外的历史遗留不追打。
          const lastOutTs = outAge === null ? 0 : now - outAge;
          const stuck = db.prepare(
            "SELECT" +
            " COALESCE(SUM(state='pending'),0) AS pendingCount," +
            " COALESCE(SUM(state='failed' AND ts > ?),0) AS failedCount," +
            " min(ts) AS oldest" +
            " FROM messages" +
            " WHERE self=0 AND ts > ? AND max(ts, available_at) <= ?" +
            "   AND (state='pending' OR (state='failed' AND ts > ?))"
          ).get(lastOutTs, now - outboundStaleMs, now - STUCK_INBOUND_MS, lastOutTs);
          const stuckCount = Number(stuck.pendingCount || 0) + Number(stuck.failedCount || 0);
          const outDetail = outAge === null ? '；还没有出站记录' : `；出站距今 ${Math.round(outAge / 60000)} 分钟`;
          if (stuckCount > 0) {
            add('outbound-freshness', false,
              `有 ${stuckCount} 条入站消息到期超过 ${Math.round(STUCK_INBOUND_MS / 60000)} 分钟未被处理` +
              (Number(stuck.failedCount) > 0 ? `（其中 ${stuck.failedCount} 条重试已耗尽）` : '') +
              `（最早一条距今 ${Math.round((now - Number(stuck.oldest)) / 60000)} 分钟）—— 收发链路可能停滞`);
          } else if (inAge < STUCK_INBOUND_MS) {
            add('outbound-freshness', true,
              `最近入站处理中（${Math.round(inAge / 60000)} 分钟前收到${outDetail}）`);
          } else {
            add('outbound-freshness', true,
              `最近入站没有到期未处理的（最后一条距今 ${Math.round(inAge / 60000)} 分钟${outDetail}）`);
          }
        }
      } finally { db.close(); }
    } catch (error) {
      add('outbound-freshness', false, `入站处理水位读不了: ${error?.message ?? error}`);
    }
  }

  // ④ 磁盘余量
  try {
    const st = typeof statfs === 'function' ? statfs(dataDir) : fs.statfsSync(dataDir);
    const avail = Number(st.bavail) * Number(st.bsize);
    add('disk-space', avail >= DISK_MIN_BYTES, `可用 ${(avail / 1024 / 1024 / 1024).toFixed(2)} GB`);
  } catch (error) {
    add('disk-space', false, `磁盘余量读不了: ${error?.message ?? error}`);
  }

  // ⑤ 自动更新状态
  try {
    const upd = JSON.parse(fs.readFileSync(path.join(dataDir, 'auto-update.json'), 'utf8'));
    add('auto-update', upd?.status !== 'failed', upd?.status === 'failed' ? `status=failed（${String(upd?.error || '').slice(0, 120)}）` : `status=${upd?.status ?? 'unknown'}`);
  } catch {
    add('auto-update', true, '跳过（无 auto-update.json）');
  }

  // ⑥ 部署中断标记（36c649a 加固项）：存在＝上次部署被 SIGKILL/OOM 打断且未收尾
  const marker = path.join(dataDir, '.deploy-in-progress');
  add('deploy-interrupted', !fs.existsSync(marker), fs.existsSync(marker) ? '存在中断标记，按 docs/LINUX.md「部署被中断后怎么恢复」处理' : '');

  // ⑦ messages 库完整性（适配层只读打开）
  try {
    const db = openDatabase(path.join(dataDir, 'messages.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get();
      add('sqlite-integrity', row?.integrity_check === 'ok', row?.integrity_check ?? '');
    } finally { db.close(); }
  } catch (error) {
    add('sqlite-integrity', false, error?.message ?? String(error));
  }

  const healthy = checks.every((c) => c.ok);

  // ── 抑制与通知：按类别计连击；连续 NOTIFY_AFTER_STREAK 次失败才通知，恢复补发一次 ──
  const state = loadState(dataDir);
  state.streaks = state.streaks || {};
  state.lastRunAt = now;
  state.healthy = healthy;
  state.lastResults = checks;
  const notified = [];
  if (typeof notify === 'function') {
    for (const c of checks) {
      const prev = state.streaks[c.name] || { count: 0 };
      if (!c.ok) {
        const count = prev.count + 1;
        // 保留上一轮的送达痕迹：整体重写会把 lastNotifiedAt/notifyError 抹掉，
        // 于是"这轮到底发出去没有"再也查不到（2026-09-30 审查 P1）。
        const next = { count, lastDetail: c.detail };
        // 用 != null 而不是真值判断：注入的 now 允许为 0（测试造时间），
        // 真值判断会把已送达的 0 当成"没送过"从而每轮重发（2026-09-30 复审）。
        if (prev.lastNotifiedAt != null) next.lastNotifiedAt = prev.lastNotifiedAt;
        if (prev.notifyError) next.notifyError = prev.notifyError;
        state.streaks[c.name] = next;
        // 到达阈值后**每轮都重试直到送达成功**：告警通道正是 OneBot HTTP，
        // 最需要告警的故障场景下最容易发不出去；原来只在 count===3 那一次尝试，
        // 一次瞬时失败就等于整段故障期静默（2026-09-30 审查 P1）。
        if (count >= NOTIFY_AFTER_STREAK && next.lastNotifiedAt == null) {
          const sent = await tryNotify(notify, `【QQ Agent 健康告警】${c.name} 连续 ${count} 次检查失败：${c.detail || '无详情'}（每 5 分钟巡检一次，恢复后会通知）`);
          if (sent.ok) {
            state.streaks[c.name].lastNotifiedAt = now;
            delete state.streaks[c.name].notifyError;
            notified.push(`告警:${c.name}`);
          } else {
            state.streaks[c.name].notifyError = sent.detail;
          }
        }
      } else if (prev.count >= NOTIFY_AFTER_STREAK) {
        // 恢复通知同样看结果：发失败了照常清零连击（已经恢复是事实），但记下失败痕迹 ——
        // 成功后要把痕迹清掉，否则留一条"上次恢复没发出去"的陈旧诊断（2026-09-30 复审）。
        const sent = await tryNotify(notify, `【QQ Agent 健康恢复】${c.name} 已恢复正常`);
        if (sent.ok) {
          notified.push(`恢复:${c.name}`);
          delete state.recoveryNotifyError;
        } else {
          state.recoveryNotifyError = sent.detail;
        }
        state.streaks[c.name] = { count: 0 };
      } else if (prev.count) {
        state.streaks[c.name] = { count: 0 };
      }
    }
  }
  try { saveState(dataDir, state); } catch { /* health.json 写失败不影响巡检结论 */ }

  return { healthy, checks, notified, code: healthy ? 0 : 1 };
}

/**
 * 调用注入的通知器并归一化结果。
 * 生产注入的是 notify-owner 的 sendOwnerText：它**失败时返回 { ok:false, detail } 而不抛**，
 * 所以只 try/catch 会把"没发出去"当成"已送达"。两种失败都要认（2026-09-30 审查 P1）。
 * 返回 undefined（旧测试里的式样 `async (text) => { notes.push(text) }`）按成功处理。
 */
async function tryNotify(notify, text) {
  try {
    const r = await notify(text);
    if (r && typeof r === 'object' && r.ok === false) {
      return { ok: false, detail: String(r.detail || r.error || '通知发送失败') };
    }
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) };
  }
}
