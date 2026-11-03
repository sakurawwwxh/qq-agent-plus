// 数据备份/恢复路由（从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// 真正停服的动作都排进 user manager 的 transient unit：直接 spawn 时 console 与 ops
// 在同一个 service cgroup，stop 会把自己一起杀掉。维护任务状态只服务本模块，随模块走。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR, ROOT } from '../../core/config.js';

export function registerBackupRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const auditWrite = deps.auditWrite;
  if (!router || !json || !readBody || !auditWrite) {
    throw new Error('registerBackupRoutes 需要 router/json/readBody/auditWrite');
  }

  let maintenanceTask = '';
  /** 维护任务是否仍在跑：transient unit 结束就清空，不能干等 1 小时（2026-10-31 盲审 P2）。 */
  const busyTask = () => {
    if (!maintenanceTask) return '';
    if (maintenanceTask === 'pending' || process.platform !== 'linux') return maintenanceTask;
    for (const unit of [maintenanceTask, `${maintenanceTask}.timer`]) {
      const probe = spawnSync('systemctl', ['--user', 'is-active', unit], {
        encoding: 'utf8', timeout: 3000
      });
      const state = String(probe.stdout || '').trim();
      if (['active', 'activating', 'reloading'].includes(state)) return maintenanceTask;
    }
    maintenanceTask = '';
    return '';
  };
  const backupDirPath = () => process.env.QQ_AGENT_BACKUP_DIR
    || path.join(os.homedir(), 'qq-agent', 'backups');
  const backupKeyPath = () => process.env.QQ_AGENT_BACKUP_KEY_FILE
    || path.join(os.homedir(), '.config', 'qq-agent', 'backup.key');
  const runOpsCommand = (args, timeoutMs = 15 * 60 * 1000) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'ops.js'), ...args], {
      cwd: ROOT,
      env: { ...process.env, QQ_AGENT_DATA_DIR: DATA_DIR }
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish({ ok: false, code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-20000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-20000); });
    child.on('error', (error) => finish({ ok: false, code: null, stdout, stderr: `${stderr}${error?.message || error}` }));
    child.on('close', (code) => finish({ ok: code === 0, code, timedOut: false, stdout, stderr }));
  });
  /** 实际服务名：deploy.sh --service 自定义过时必须与部署元数据/环境变量同口径。 */
  const serviceName = () => {
    const deploymentService = (() => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(ROOT, '.deployment.json'), 'utf8'));
        return String(meta?.service || '').trim();
      } catch { return ''; }
    })();
    return process.env.QQ_AGENT_SERVICE || deploymentService || 'qq-agent-linux.service';
  };
  /** shell 单引号转义：打印给管理员复制执行的命令必须能处理空格/特殊字符。 */
  const shellQuote = (value) => `'${String(value).replace(/'/g, `'\''`)}'`;

  /**
   * 把会 stop 自身服务的 ops 命令排进独立 transient unit：
   * 直接用 spawn 时 console 和 ops 在同一个 service cgroup，stop 会把自己一起杀掉。
   * 延迟 3 秒执行，给 HTTP 响应留返回时间；transient service 不继承环境，关键变量显式 setenv。
   */
  const queueTransientOps = (kind, opsArgs) => {
    if (process.platform !== 'linux') {
      return { ok: false, error: '控制台执行只支持 Linux + systemd；请用 SSH 执行 ops 命令' };
    }
    const probe = spawnSync('systemd-run', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      return { ok: false, error: '本机没有可用的 systemd-run；请用 SSH 执行 ops 命令' };
    }
    const dataDirAbs = path.resolve(DATA_DIR);
    const service = serviceName();
    const unit = `qq-agent-${kind}-${Date.now()}`;
    const setenv = (key, value) => `--setenv=${key}=${value}`;
    const args = [
      '--user', '--unit', unit, '--collect', '--on-active=3',
      `--working-directory=${ROOT}`,
      setenv('QQ_AGENT_DATA_DIR', dataDirAbs),
      setenv('QQ_AGENT_SERVICE', service),
      setenv('QQ_AGENT_BACKUP_DIR', backupDirPath()),
      ...(process.env.QQ_AGENT_BACKUP_KEY_FILE
        ? [setenv('QQ_AGENT_BACKUP_KEY_FILE', process.env.QQ_AGENT_BACKUP_KEY_FILE)]
        : []),
      ...(process.env.QQ_AGENT_BACKUP_KEY ? [setenv('QQ_AGENT_BACKUP_KEY', process.env.QQ_AGENT_BACKUP_KEY)] : []),
      process.execPath, path.join(ROOT, 'src', 'ops.js'),
      ...opsArgs.map((arg) => (arg === DATA_DIR ? dataDirAbs : arg))
    ];
    const queued = spawnSync('systemd-run', args, { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
    if (queued.status !== 0) {
      return {
        ok: false,
        error: `任务排队失败：${String(queued.stderr || queued.stdout || '').trim().slice(0, 300) || 'systemd-run 失败'}`
      };
    }
    maintenanceTask = unit;
    const clear = setTimeout(() => { if (maintenanceTask === unit) maintenanceTask = ''; }, 60 * 60 * 1000);
    if (clear.unref) clear.unref();
    return { ok: true, unit };
  };

  router.add('GET', '/api/backup/status', async (req, res) => {
    const dir = backupDirPath();
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter((name) => /\.tar\.gz(?:\.enc)?$/.test(name))
        .map((name) => {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          return { name, bytes: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 20);
    } catch { /* 目录不存在时返回空列表 */ }
    return json(res, 200, {
      ok: true,
      dir,
      keyExists: fs.existsSync(backupKeyPath()),
      files,
      // 必须带 --data/--service：SSH 会话里没有服务进程的环境变量，照默认值执行会
      // 恢复到 /data/qq-agent/data、停错服务（2026-11-01 盲审 P1）。
      restoreCli: files[0]
        ? `node src/ops.js restore --from ${shellQuote(path.join(dir, files[0].name))}`
          + ` --data ${shellQuote(path.resolve(DATA_DIR))}`
          + ` --service ${shellQuote(serviceName())} --confirm`
        : ''
    });
  });
  router.add('POST', '/api/backup/run', async (req, res) => {
    const busy = busyTask();
    if (busy) return json(res, 409, { ok: false, error: `已有备份/恢复任务在排队（${busy}）` });
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 400, { ok: false, error: '执行备份需要 confirm:true' });
    const busyAgain = busyTask();
    if (busyAgain) return json(res, 409, { ok: false, error: `已有备份/恢复任务在排队（${busyAgain}）` });
    const dir = backupDirPath();
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 失败交给 ops 报 */ }
    maintenanceTask = 'pending';
    const queued = queueTransientOps('backup', [
      'backup', '--confirm', '--data', DATA_DIR, '--backup-dir', dir
    ]);
    if (!queued.ok) {
      maintenanceTask = '';
      return json(res, 500, { ok: false, error: queued.error });
    }
    auditWrite('backup.run', dir, { req, unit: queued.unit });
    return json(res, 202, {
      ok: true,
      status: 'queued',
      unit: queued.unit,
      note: '备份已排队，约 3 秒后开始。服务会短暂停止并重启，控制台可能断开几秒，完成后刷新页面。'
    });
  });
  router.add('POST', '/api/backup/verify', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const name = path.basename(String(body?.file || ''));
    if (!/\.tar\.gz(?:\.enc)?$/.test(name)) return json(res, 400, { ok: false, error: '备份文件名不合法' });
    const full = path.join(backupDirPath(), name);
    if (!fs.existsSync(full)) return json(res, 404, { ok: false, error: '备份文件不存在' });
    const result = await runOpsCommand(['restore', '--from', full, '--dry-run', '--data', DATA_DIR], 5 * 60 * 1000);
    const output = `${result.stdout}${result.stderr}`.slice(-4000);
    return json(res, result.ok ? 200 : 500, {
      ok: result.ok,
      code: result.code,
      timedOut: result.timedOut,
      output,
      // 前端 api() 只显示 error：失败时必须把 ops 的原因带出来，否则页面只剩 HTTP 500。
      ...(result.ok ? {} : { error: output.slice(-400) || `备份校验失败（退出码 ${result.code}）` })
    });
  });

  router.add('POST', '/api/backup/restore', async (req, res) => {
    const busyRestore = busyTask();
    if (busyRestore) {
      return json(res, 409, { ok: false, error: `已有备份/恢复任务在排队（${busyRestore}），不要重复提交` });
    }
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 400, { ok: false, error: '恢复需要 confirm:true' });
    const busyRestoreAgain = busyTask();
    if (busyRestoreAgain) {
      return json(res, 409, { ok: false, error: `已有备份/恢复任务在排队（${busyRestoreAgain}），不要重复提交` });
    }
    const name = path.basename(String(body?.file || ''));
    if (!/\.tar\.gz(?:\.enc)?$/.test(name)) return json(res, 400, { ok: false, error: '备份文件名不合法' });
    const full = path.join(backupDirPath(), name);
    if (!fs.existsSync(full)) return json(res, 404, { ok: false, error: '备份文件不存在' });
    maintenanceTask = 'pending';
    const queued = queueTransientOps('restore', [
      'restore', '--from', full, '--confirm', '--data', DATA_DIR
    ]);
    if (!queued.ok) {
      maintenanceTask = '';
      return json(res, 500, { ok: false, error: queued.error });
    }
    auditWrite('backup.restore', name, { req, unit: queued.unit });
    return json(res, 202, {
      ok: true,
      status: 'queued',
      unit: queued.unit,
      note: '恢复已排队，约 3 秒后开始。服务会短暂停止并重启，控制台可能断开几秒，完成后刷新页面。'
    });
  });
}
