import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeUpdateNetworkSettings } from './update-network.js';

const STATE_FILE = 'auto-update.json';
const REQUEST_FILE = 'auto-update-request.json';
const ACTIVE_STATES = new Set(['queued', 'checking', 'testing', 'deploying']);
const REQUEST_MODES = new Set(['manual', 'scheduled', 'probe']);
// 活跃状态超过这个时长还不动，就当它卡住了：不再抑制"发现新版本"提示，让人能再点一次
const PENDING_TTL_MS = 30 * 60 * 1000;

function cleanText(value, max = 1200) {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

function readObject(file, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function writeObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function updateError(message, httpStatus = 409) {
  return Object.assign(new Error(message), { httpStatus });
}

export function autoUpdatePaths(dataDir) {
  const root = path.resolve(dataDir);
  return {
    state: path.join(root, STATE_FILE),
    request: path.join(root, REQUEST_FILE),
    lock: path.join(root, '.auto-update.lock'),
    repository: path.join(root, 'update-repository.git'),
    workRoot: path.join(root, 'update-work')
  };
}

export function readAutoUpdateState(dataDir) {
  return readObject(autoUpdatePaths(dataDir).state, {
    version: 1,
    status: 'idle',
    mode: '',
    phase: '',
    startedAt: 0,
    updatedAt: 0,
    completedAt: 0,
    lastCheckAt: 0,
    lastSuccessAt: 0,
    currentRevision: '',
    targetRevision: '',
    error: '',
    autoDisabled: false,
    connectivity: {
      status: 'unknown',
      checkedAt: 0,
      attempts: 0,
      latencyMs: 0,
      repository: '',
      branch: '',
      revision: '',
      error: ''
    },
    notification: {
      pending: false,
      ownerUin: '',
      sentAt: 0,
      error: ''
    }
  });
}

export function writeAutoUpdateState(dataDir, patch) {
  const current = readAutoUpdateState(dataDir);
  const next = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: Date.now(),
    connectivity: {
      ...(current.connectivity || {}),
      ...(patch.connectivity || {})
    },
    notification: {
      ...(current.notification || {}),
      ...(patch.notification || {})
    }
  };
  writeObject(autoUpdatePaths(dataDir).state, next);
  return next;
}

export function writeAutoUpdateRequest(dataDir, mode = 'manual') {
  const normalizedMode = REQUEST_MODES.has(mode) ? mode : 'scheduled';
  const request = {
    version: 1,
    mode: normalizedMode,
    requestedAt: Date.now()
  };
  writeObject(autoUpdatePaths(dataDir).request, request);
  return request;
}

/**
 * 有没有一个"已经提交、还没跑完"的更新。
 * 控制台的「发现新版本」提示要用它：用户点过「立即更新」之后就别再弹同一个版本了 ——
 * 部署完成前 deployed-revision 还是旧的，光比版本永远会认为"有新版本没装"，
 * 于是每次刷新都弹一遍，看起来像"更新没生效"（2026-09-21 反馈）。
 * 超过 PENDING_TTL_MS 还停在活跃状态就当卡住了，返回 null，让人能再点一次。
 * @returns {{status: string, mode: string, version: string, revision: string, updatedAt: number} | null}
 */
export function autoUpdatePending(dataDir) {
  const state = readAutoUpdateState(dataDir);
  const status = String(state.status || '');
  if (!ACTIVE_STATES.has(status)) return null;
  // 基准是"最近一次进度"：
  //   progressAt —— requestManual 与更新器**每个阶段**都写（正常更新会一直续期）；
  //   startedAt  —— 兜底（老版本更新器没写 progressAt）；
  //   updatedAt  —— 最后兜底。
  // ⚠️ 不能直接用 updatedAt 当主基准：checkForUpdate 存提示也会调 writeAutoUpdateState，
  //    控制台一开就把基准推到现在，于是"卡住 30 分钟就放开"永远不成立（更新器被 kill 后
  //    提示被永久压住、手动更新按钮一直是灰的）。只用 startedAt 也不够：慢机器上一轮正常
  //    更新就可能超过 30 分钟（npm ci 10 分钟 + 单测 20 分钟 + 部署 20 分钟），会被误判成卡住。
  const base = Number(state.progressAt || 0) || Number(state.startedAt || 0) || Number(state.updatedAt || 0);
  if (!base || Date.now() - base > PENDING_TTL_MS) return null;
  return {
    status,
    mode: String(state.mode || ''),
    version: String(state.targetVersion || ''),
    revision: String(state.targetRevision || ''),
    startedAt: Number(state.startedAt || 0),
    progressAt: Number(state.progressAt || 0),
    updatedAt: Number(state.updatedAt || 0)
  };
}

export function consumeAutoUpdateRequest(dataDir) {
  const file = autoUpdatePaths(dataDir).request;
  const request = readObject(file, null);
  try { fs.unlinkSync(file); } catch { /* no request */ }
  if (
    !request
    || !REQUEST_MODES.has(request.mode)
    || Date.now() - Number(request.requestedAt || 0) > 60 * 60 * 1000
  ) {
    return null;
  }
  return request;
}

/**
 * Auto update shares the application's one global administrator.
 *
 * The updater runner can execute directly against config.json before the main
 * process has had a chance to migrate an old install. Therefore legacy owner
 * paths are read only when the file has no admin section at all. Once admin
 * exists—even with an intentionally empty ownerUin—it is the sole truth.
 */
export function autoUpdateOwner(config = {}) {
  const hasAdmin = Boolean(
    config.admin
    && typeof config.admin === 'object'
    && !Array.isArray(config.admin)
  );
  if (hasAdmin) return String(config.admin.ownerUin || '').trim();
  return String(
    config.autoUpdate?.ownerUin
    || config.incidentPilot?.ownerUin
    || config.identityPilot?.friendProposal?.ownerUin
    || ''
  ).trim();
}

export function sanitizeUpdateError(error) {
  return cleanText(error?.message ?? error ?? '更新失败');
}

/**
 * 失败命令的"值得展示的详情"。
 *
 * 旧口径是"输出结尾 2000 字符"，对 `node --test` 的 TAP 输出会把失败项甩掉：
 * 测试文件并行跑、按字典序收尾，结尾往往是狼人杀/卧底这类排在最后的测试文件，
 * 真正的失败可以离结尾好几百条 —— 2026-10-10 线上实测：更新失败信息里整段是群游戏
 * 测试名（用户被问"为什么爆群游戏的内容"），真正的失败（snowluma 用例）一条看不见，
 * 误导了整个排查过程。有 TAP 的 `not ok` 行时改为列出**失败项本身**
 * （名字 + 紧随的诊断 error/message，最多 10 行）加结尾汇总；没有则退回旧口径。
 *
 * 两个细节都踩过：`describe()` 内的用例失败时 TAP 行带缩进（按嵌套层级缩进 4 空格/层，
 * 2026-10-10 实测 `    not ok 1 - …`），所以匹配要允许行首空白；`error: |-` 是 YAML 块
 * 形式（assert.equal 的 actual/expected 对比就在块里），要把块内容一起收进来。
 */
export function failureDetail(result) {
  const stdout = String(result?.stdout || '');
  const picked = [];
  if (/^\s*not ok \d+ - /m.test(stdout)) {
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length && picked.length < 10; i += 1) {
      if (!/^\s*not ok \d+ - /.test(lines[i])) continue;
      picked.push(lines[i].trim());
      for (let j = i + 1; j < Math.min(lines.length, i + 20); j += 1) {
        const m = /^(\s+)(error|message):\s*(.*)$/.exec(lines[j]);
        if (m) {
          const keyIndent = m[1].length;
          picked.push(`  ${m[2]}: ${m[3]}`);
          // YAML 块形式（`error: |-`）：真实内容在更深缩进的后续行里，收集到下一个
          // 同级键或 `...` 为止（空行跳过），最多 6 行
          if (/^\|[-+]?$/.test(m[3].trim())) {
            let took = 0;
            for (let k = j + 1; k < Math.min(lines.length, j + 12) && took < 6; k += 1) {
              const line = lines[k];
              if (!line.trim()) continue;
              const indent = line.length - line.trimStart().length;
              if (indent <= keyIndent || line.trim() === '...') break;
              picked.push(`    ${line.trim()}`);
              took += 1;
            }
          }
          break;
        }
        if (/^\s*(?:ok|not ok) \d|^\s*# /.test(lines[j])) break;
      }
    }
    const summary = (stdout.match(/^\s*# (?:tests|pass|fail|skipped) .+$/gm) || []).map((s) => s.trim()).join('\n');
    if (summary) picked.push(summary);
  }
  const detail = picked.length
    ? picked.join('\n')
    : String(result?.stderr || result?.stdout || '').trim().slice(-2000);
  return detail.slice(0, 2000);
}

export class AutoUpdateManager {
  constructor({
    appDir,
    dataDir,
    config,
    updateConfig,
    notify,
    notifyAvailable = () => true,
    emit = null,
    runSystemctl = null,
    log = console.log
  }) {
    this.appDir = path.resolve(appDir);
    this.dataDir = path.resolve(dataDir);
    this.config = config;
    this.updateConfig = updateConfig;
    this.notify = notify;
    this.notifyAvailable = notifyAvailable;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.runSystemctl = runSystemctl || ((args) => spawnSync(
      'systemctl',
      ['--user', ...args],
      { encoding: 'utf8', timeout: 15_000 }
    ));
    this.log = log;
    this.notificationTimer = null;
    this.notificationKickoff = null;
    this.notificationTask = null;
  }

  deployment() {
    const value = readObject(path.join(this.appDir, '.deployment.json'), null);
    if (!value?.service || path.resolve(value.root || '') !== this.appDir) return null;
    return value;
  }

  serviceName() {
    const deployment = this.deployment();
    return deployment
      ? String(deployment.updateService || `${deployment.service}-update`)
      : '';
  }

  installed() {
    return Boolean(this.serviceName())
      && fs.existsSync(path.join(this.appDir, 'scripts', 'auto-update.mjs'));
  }

  serviceActive() {
    if (!this.installed()) return false;
    const result = this.runSystemctl([
      '--quiet',
      'is-active',
      `${this.serviceName()}.service`
    ]);
    return result?.status === 0;
  }

  status() {
    const cfg = this.config();
    const settings = cfg.autoUpdate || {};
    const network = normalizeUpdateNetworkSettings(settings);
    const state = readAutoUpdateState(this.dataDir);
    const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
    // 与「发现新版本」提示用同一套判据（autoUpdatePending）：一处说"在跑"、另一处说"卡住"
    // 会让用户卡在"提示弹出来了、按钮却是灰的"。基准见 autoUpdatePending 的注释。
    const busy = this.serviceActive() || autoUpdatePending(this.dataDir) !== null;
    let deployedRevision = '';
    try {
      deployedRevision = fs.readFileSync(
        path.join(this.dataDir, 'deployed-revision'),
        'utf8'
      ).trim();
    } catch { /* not deployed through deploy.sh yet */ }
    return {
      installed: this.installed(),
      enabled: settings.enabled === true && state.autoDisabled !== true,
      busy,
      ownerUin: autoUpdateOwner(cfg),
      repository: String(settings.repository || ''),
      branch: String(settings.branch || 'main'),
      intervalHours: Number(settings.intervalHours) || 6,
      ...network,
      nextCheckAt: settings.enabled === true
        ? Math.max(Date.now(), Number(state.lastCheckAt || 0) + intervalMs)
        : 0,
      ...state,
      // 以 data/deployed-revision 为准：那是每次部署都会重写的"这台机器现在跑的版本"，
      // 而 state.currentRevision 只是"上一次更新器自己部署时"的快照。反过来会让控制台
      // 显示与实际不符的版本（2026-09-29 实测：线上跑的是未提交树 source-…，控制台却显示
      // 4 天前的提交 cd4e1003）。文件缺失（没走 deploy.sh 部署过）才回落到状态里的值。
      currentRevision: deployedRevision || state.currentRevision
    };
  }

  configure(options = {}) {
    const current = this.config();
    const autoUpdate = current.autoUpdate || {};
    const next = {
      ...autoUpdate,
      intervalHours: options.intervalHours ?? autoUpdate.intervalHours ?? 6
    };
    // ownerUin is accepted only as a backwards-compatible API alias. Route it
    // immediately into admin.ownerUin; autoUpdate.ownerUin remains a config
    // compatibility mirror maintained by the central config layer.
    const adminPatch = options.ownerUin === undefined
      ? null
      : { ownerUin: String(options.ownerUin || '').trim() };
    for (const key of [
      'branch',
      'networkRetries',
      'retryBaseMs',
      'retryMaxMs',
      'connectivityTimeoutSeconds',
      'fetchTimeoutSeconds',
      'forceHttp11',
      'disableOnFailure'
    ]) {
      if (options[key] !== undefined) next[key] = options[key];
    }
    const cfg = this.updateConfig({
      autoUpdate: next,
      ...(adminPatch ? { admin: adminPatch } : {})
    });
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  resume({ ownerUin, intervalHours = 6 } = {}) {
    const current = this.config();
    const adminPatch = ownerUin === undefined
      ? null
      : { ownerUin: String(ownerUin || '').trim() };
    const cfg = this.updateConfig({
      autoUpdate: {
        ...(current.autoUpdate || {}),
        enabled: true,
        intervalHours
      },
      ...(adminPatch ? { admin: adminPatch } : {})
    });
    // 显式恢复更新：清掉失败自停标记，否则更新器仍按 autoDisabled 跳过
    //（2026-10-07 复审：与 scripts/auto-update.mjs 的 autoDisabled 判定配套）。
    try { writeAutoUpdateState(this.dataDir, { autoDisabled: false }); } catch { /* 状态文件写不进去不影响恢复 */ }
    // 更新正在跑时不要把它写成 idle：那会清掉"已提交未跑完"的抑制与 busy 判据，
    // 让控制台一边显示在跑、一边又能再点一次（直接调接口才会遇到，2026-09-22 审查发现）
    if (!this.serviceActive() && !autoUpdatePending(this.dataDir)) {
      writeAutoUpdateState(this.dataDir, {
        status: 'idle',
        phase: '',
        error: '',
        autoDisabled: false,
        completedAt: Date.now(),
        lastCheckAt: 0
      });
    }
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  pause() {
    const cfg = this.updateConfig({
      autoUpdate: {
        ...(this.config().autoUpdate || {}),
        enabled: false
      }
    });
    if (!this.serviceActive()) {
      writeAutoUpdateState(this.dataDir, {
        status: 'disabled',
        phase: '',
        completedAt: Date.now()
      });
    }
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  requestManual({ version = '' } = {}) {
    if (!this.installed()) {
      throw updateError('自动更新服务尚未安装，请先用 deploy.sh 部署当前版本');
    }
    let cfg = this.config();
    const probeOnly = cfg.autoUpdate?.nextAction === 'probe';
    if (probeOnly) {
      cfg = this.updateConfig({
        autoUpdate: {
          ...(cfg.autoUpdate || {}),
          nextAction: ''
        }
      });
    }
    const ownerUin = autoUpdateOwner(cfg);
    if (!probeOnly) {
      if (!/^\d{5,15}$/.test(ownerUin)) {
        throw updateError('请先配置全局管理员 QQ', 400);
      }
      if (
        cfg.allowAllWhenEmpty !== true
        && !(cfg.allow?.private || []).map(String).includes(ownerUin)
      ) {
        throw updateError('全局管理员 QQ 必须同时加入私聊白名单', 400);
      }
    }
    const current = this.status();
    if (current.busy) throw updateError('已有更新任务正在运行');

    const mode = probeOnly ? 'probe' : 'manual';
    writeAutoUpdateRequest(this.dataDir, mode);
    // 记下这次要更到哪个版本：控制台的「发现新版本」提示要用它判断"这个版本的更新
    // 已经提交过了，别再弹"（更新器跑到能解析 tag 的阶段才会自己写 targetVersion，
    // 在那之前状态里是空的，只靠版本号比对会一直弹）。
    const targetVersion = mode === 'manual' ? cleanText(version, 64).trim() : '';
    writeAutoUpdateState(this.dataDir, {
      status: 'queued',
      mode,
      phase: probeOnly ? 'connectivity' : 'queued',
      startedAt: Date.now(),
      completedAt: 0,
      error: '',
      // 没带版本也要显式清空：不然上一次的版本会留在状态里，前端拿它比对会误判
      targetVersion,
      progressAt: Date.now(),
      ...(probeOnly ? {
        connectivity: {
          status: 'queued',
          checkedAt: 0,
          attempts: 0,
          latencyMs: 0,
          repository: String(cfg.autoUpdate?.repository || ''),
          branch: String(cfg.autoUpdate?.branch || 'main'),
          revision: '',
          error: ''
        }
      } : {})
    });
    const result = this.runSystemctl([
      '--no-block',
      'start',
      `${this.serviceName()}.service`
    ]);
    if (result?.status !== 0) {
      const message = cleanText(result?.stderr || '无法启动自动更新服务');
      if (probeOnly) {
        writeAutoUpdateState(this.dataDir, {
          status: 'idle',
          mode: 'probe',
          phase: 'complete',
          completedAt: Date.now(),
          error: '',
          autoDisabled: false,
          connectivity: {
            status: 'failed',
            checkedAt: Date.now(),
            attempts: 0,
            latencyMs: 0,
            error: message
          },
          notification: { pending: false }
        });
        throw updateError(message);
      }
      const policy = normalizeUpdateNetworkSettings(cfg.autoUpdate || {});
      if (policy.disableOnFailure) {
        this.updateConfig({
          autoUpdate: {
            ...(this.config().autoUpdate || {}),
            enabled: false
          }
        });
      }
      writeAutoUpdateState(this.dataDir, {
        status: 'failed',
        phase: 'launch',
        completedAt: Date.now(),
        error: message,
        autoDisabled: policy.disableOnFailure,
        notification: {
          pending: true,
          ownerUin,
          sentAt: 0,
          error: ''
        }
      });
      this.resumeNotifications();
      throw updateError(message);
    }
    this.emit('auto-update', this.status());
    return this.status();
  }

  start() {
    this.stop();
    this.notificationTimer = setInterval(() => {
      this.resumeNotifications();
    }, 30_000);
    this.notificationTimer.unref?.();
    this.notificationKickoff = setTimeout(() => {
      this.notificationKickoff = null;
      this.resumeNotifications();
    }, 2_000);
    this.notificationKickoff.unref?.();
  }

  stop() {
    clearInterval(this.notificationTimer);
    clearTimeout(this.notificationKickoff);
    this.notificationTimer = null;
    this.notificationKickoff = null;
  }

  resumeNotifications() {
    if (this.notificationTask) return this.notificationTask;
    this.notificationTask = this.#notifyPending()
      .catch((error) => this.log(`[auto-update] 管理员通知失败：${error?.message ?? error}`))
      .finally(() => { this.notificationTask = null; });
    return this.notificationTask;
  }

  async handlePendingFailure() {
    const state = readAutoUpdateState(this.dataDir);
    const policy = normalizeUpdateNetworkSettings(this.config().autoUpdate || {});
    if (
      state.status === 'failed'
      && state.autoDisabled === true
      && policy.disableOnFailure
      && this.config().autoUpdate?.enabled === true
    ) {
      this.updateConfig({
        autoUpdate: {
          ...(this.config().autoUpdate || {}),
          enabled: false
        }
      });
    }
    await this.resumeNotifications();
    return this.status();
  }

  async #notifyPending() {
    const state = readAutoUpdateState(this.dataDir);
    if (!state.notification?.pending || !this.notify || !this.notifyAvailable()) return state;
    const ownerUin = String(
      state.notification.ownerUin || autoUpdateOwner(this.config())
    ).trim();
    if (!/^\d{5,15}$/.test(ownerUin)) {
      return writeAutoUpdateState(this.dataDir, {
        notification: {
          ...state.notification,
          error: '未配置有效的全局管理员 QQ'
        }
      });
    }
    const mode = state.mode === 'manual' ? '手动更新' : '定时更新';
    const currentEnabled = this.config().autoUpdate?.enabled === true;
    const action = state.autoDisabled === true
      ? '自动更新已停止。'
      : currentEnabled
        ? '自动更新保持启用，将在后续检查周期继续重试。'
        : '自动更新原本处于暂停状态，本次失败未改变开关。';
    const text = [
      '【QQ Agent 更新部署失败】',
      `方式：${mode}`,
      `阶段：${state.phase || 'unknown'}`,
      ...(state.targetRevision
        ? [`目标版本：${String(state.targetRevision).slice(0, 12)}`]
        : []),
      `结果：${cleanText(state.error || '未知错误', 600)}`,
      '',
      action,
      '处理入口：控制台 → 控制 → 更新部署'
    ].join('\n');
    try {
      // 发送前先把状态落成"结果未知"：这条链路没有 outbox 那样的 sending 落盘，原来
      // 发送途中崩溃/重启的话 pending 还是 true，重启 resumeNotifications 会把同一条
      // 失败通知再发一遍。先落 unknown（pending=false）；确定没发出去的情况由下面的
      // catch 恢复成 pending 等重试，其余失败保持 unknown 等人工确认。
      writeAutoUpdateState(this.dataDir, {
        notification: { ...state.notification, pending: false, deliveryUnknown: true, ownerUin, error: '' }
      });
      await this.notify(text, ownerUin);
      const updated = writeAutoUpdateState(this.dataDir, {
        notification: {
          ...state.notification,
          pending: false,
          ownerUin,
          sentAt: Date.now(),
          error: '',
          // 这一条已经确认发出去了，之前那条"结果未知"的标记不能留着 ——
          // 否则 data/auto-update.json 会一直显示"需人工确认"，与 docs/AUTO_UPDATE.md 的语义对不上。
          deliveryUnknown: false
        }
      });
      this.emit('auto-update', this.status());
      return updated;
    } catch (error) {
      // 发送失败要分清"确定没发出去"和"结果未知"：只有前者能自动重试。这条通知走
      // onebot.sendText，超时属于结果未知。此前 pending 一直留着，于是 30 秒一次的定时器
      // 会把同一条【更新部署失败】反复发给管理员（项目规则：结果未知不外发重试）。
      const definitelyNotSent = error?.beforeWrite === true;
      writeAutoUpdateState(this.dataDir, {
        notification: {
          ...state.notification,
          pending: definitelyNotSent,
          ownerUin,
          error: cleanText(error?.message ?? error, 500),
          // 发送前已经把 deliveryUnknown 落成 true：确定没发出去时要显式归位 false，
          // 否则"未连接"这种可重试的失败也会被标成结果未知
          deliveryUnknown: !definitelyNotSent
        }
      });
      throw error;
    }
  }
}
