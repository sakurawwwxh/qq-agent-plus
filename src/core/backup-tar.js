// 备份归档创建（tar 参数与 Windows 盘符兼容），从 ops.js 拆出来守住行数闸门。
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} opts
 * @param {string} opts.outFile 输出归档路径
 * @param {string} opts.dataDir 数据目录（可为软链）
 * @param {{dir: string, name: string}|null} opts.extra 额外打进归档顶层的目录
 * @param {(cmd: string, args: string[], opts?: object) => {ok: boolean, code: number|null, stderr: string}} opts.run
 * @param {boolean} opts.isWindows
 */
export function runTarCreate({ outFile, dataDir, extra = null, run, isWindows = process.platform === 'win32' }) {
  // 落到本地常量：ops scan --strict 不认解构参数里的函数名，直接调 run(...) 会报未定义。
  const runFn = run;
  // 数据目录可能是软链（数据盘单独挂载的受支持布局）。tar 默认不跟随软链，
  // 直接归档链接本身会生成恢复侧明确拒绝的 symlink 条目，备份看似成功却不可恢复。
  const sourceDir = fs.realpathSync(dataDir);
  const parent = path.dirname(sourceDir);
  const base = path.basename(sourceDir);
  // 部署快照 / 更新缓存都是可重建的大目录；与 scripts/manage.mjs backup 的排除清单保持一致，
  // 否则每周定时备份会把它们整套再打包一份（2026-10 审查 P3）。
  const excludes = ['--exclude=deploy-backups', '--exclude=update-work', '--exclude=update-repository.git',
    // 运行态锁/标记：备份/恢复跨主机时 pid/hostname 都是旧的，恢复后可能挡住新实例或永久误报
    '--exclude=.server.lock', '--exclude=.auto-update.lock', '--exclude=.auto-update.lock.takeover',
    '--exclude=.deploy.lock', '--exclude=.deploy.lock.takeover', '--exclude=.deploy-in-progress',
    // 维护锁现在放在数据目录同级；保留这条是为了兼容旧版本可能留下的目录内锁
    '--exclude=.maintenance.lock'];
  const baseArgs = [...excludes, '-czf', outFile, '-C', parent, base];
  // 可选：把部署凭据放在归档顶层 stack-credentials/ 下（恢复时不会自动写回，需人工取用）
  if (extra?.dir && extra?.name) baseArgs.push('-C', extra.dir, extra.name);
  const attempts = isWindows
    ? [['--force-local', ...baseArgs], [...baseArgs]]
    : [[...baseArgs]];
  let last = { ok: false, code: null, stderr: '' };
  for (const tarArgs of attempts) {
    // 有界超时：备份在 systemctl stop 之后跑，tar 卡住 = 机器人一直停着等人
    //（2026-10-12 审查：这里原来是 timeout: 0 = 永不超时）。30 分钟对数据目录足够宽裕；
    // 超时会连进程一起杀掉，失败路径会清掉半成品并照常拉起服务。
    const result = runFn('tar', tarArgs, { timeout: 30 * 60 * 1000 });
    if (result.ok) return result;
    last = result;
    try { fs.rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
  }
  return last;
}
