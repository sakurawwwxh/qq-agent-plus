// 协议端（SnowLuma）镜像版本与更新：**控制台一键升级**的实现，ops 命令与体检也共用这一份。
//
// 为什么需要它：项目把协议端镜像版本钉在 deploy-all.sh / ops deploy 里（基线），但升级协议端
// 一直是"运维 ssh 进去手动改 .env + docker compose up -d"——别人装完就停在旧版本，于是
// 「贴纸显示成图片」这类"能力有了但协议端太老"的问题，只有手动升级的人才能解决。
//
// 这里的做法只做一件事：**改 .env 里的 SNOWLUMA_IMAGE，然后 compose pull + up -d**——
// 与 deploy-all.sh 起它的方式完全一致（容器名/端口/数据卷都不动，所以 QQ 登录态保留）。
// 安全边界：
//   · 更新前把 .env / docker-compose.yml 备份到 <composeDir>/backups/<ts>/；
//   · pull 失败 → 只还原 .env，不动容器；
//   · 起不来或等不到就绪 → 自动回滚（还原 .env 再 up -d 回旧镜像），并把两次结果一起报出来；
//   · 只认 compose 项目里那份 .env 的 SNOWLUMA_IMAGE 键，其余行原样保留（不重写整份文件）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawnSync, execFile } from 'node:child_process';

/** 项目测过的协议端基线：ops deploy 与"建议版本"都用它（单一真源）。 */
export const SNOWLUMA_BASELINE_IMAGE = 'motricseven7/snowluma:v1.14.22';

/**
 * 低于这个版本，平台能力会**静默降级**：动画表情的"真表情"呈现要 ≥1.14.20
 * （1.14.17 上 sub_type 无效，SnowLuma issue #468）——贴纸仍会显示成图片。
 */
export const SNOWLUMA_MIN_RECOMMENDED = '1.14.20';

/**
 * 升级前备份保留份数。与 deploy.sh 的 rollback 快照同口径（3 份）：备份目录只含
 * .env 与 docker-compose.yml，体积不是问题，真正的风险是次数——每次升级/每次失败都新建
 * 一份且永不清理，反复升级会把数据盘与目录数一起堆上去。留 3 份够回退，也不至于无限增长。
 */
export const SNOWLUMA_BACKUP_KEEP = 3;

const IMAGE_KEY = 'SNOWLUMA_IMAGE';
const CONTAINER_KEY = 'SNOWLUMA_CONTAINER';

/**
 * docker 连不上守护进程时的可执行提示（Issue #30）。
 *
 * 为什么值得专门认这一条：控制台进程是 systemd **用户服务**，它的补充组在 `systemd --user`
 * 管理器启动那一刻就冻结了（开了 linger 时＝开机那一刻）。管理员后来 `usermod -aG docker`
 * 之后，新开的交互 shell 有 docker 组、`docker pull` 完全正常，但那个一直在跑的用户管理器
 * 不会跟着更新 —— 于是**只有控制台里更新协议端会炸**，报
 * `permission denied while trying to connect to the Docker daemon socket`。
 *
 * 那段原始 stderr 会把人引向“docker.sock 权限配错了”，而配置其实是对的、
 * 只是跑控制台的那个进程没拿到组。把它换成能直接执行的步骤，才不会再收到同一个 issue。
 */
export const DOCKER_SOCKET_HINT = [
  '连不上 Docker 守护进程（权限不足）。',
  '这不是 docker.sock 的权限配错了，而是跑控制台的那个进程没有 docker 组：',
  '控制台是 systemd 用户服务，它的补充组在 systemd --user 管理器启动时就固定了；',
  '你把自己加进 docker 组之后，那个一直在跑的管理器不会跟着更新 ——',
  '交互 shell 里 docker 正常、只有控制台里不行，就是这个原因。',
  '解决（会短暂重启控制台与协议端；最新版 deploy.sh / deploy-all.sh 在收尾时会自动做这件事，',
  '更早装好的机器才需要手工执行）：',
  '  sudo systemctl stop user@$(id -u).service',
  '  sleep 3',
  '  sudo systemctl start user@$(id -u).service',
  '  或直接重启机器',
  '⚠️ 不要用 systemctl restart user@ 代替：2026-10-09 实测（systemd 249）stop 与 start 挨太近时，',
  '   新管理器会因旧实例 cgroup 未回收而以 status=219/CGROUP 启动失败，且失败后不会自动回来',
  '   （服务停摆到人工 start）；分开两步、留 3 秒间隔才稳。',
  '⚠️ 也不要用 loginctl terminate-user：它同样不会把管理器自动带回来，服务会停到你下次登录。',
  '验证（输出里应出现 docker 组的 gid）：',
  '  systemctl --user show qq-agent-linux.service -p MainPID --value \\',
  '    | xargs -I{} grep ^Groups /proc/{}/status',
  '  getent group docker'
].join('\n');

/**
 * 本机诊断：账号在不在 docker 组 —— 用来把修复步骤精确到"这一台还差什么"。
 * getent/id 是各 systemd 发行版的通用件（Ubuntu/Debian/CentOS/Fedora/Arch…）；
 * 命令不可用（非 Linux、极简容器）时返回 null 字段 = "不知道"，调用方退回通用提示。
 */
export function dockerGroupDiagnosis() {
  let user = '';
  try { user = os.userInfo().username; } catch { user = String(process.env.USER || ''); }
  try {
    const res = spawnSync('getent', ['group', 'docker'], { encoding: 'utf8', timeout: 5000 });
    if (!res || res.error || res.status === null) return { user, groupExists: null, userInGroup: null };
    if (res.status !== 0) return { user, groupExists: false, userInGroup: false };
    const members = String(res.stdout || '').split(':')[3] || '';
    let inGroup = members.split(',').map((s) => s.trim()).filter(Boolean).includes(user);
    if (!inGroup) {
      // 也可能把 docker 设成了主组（少见但合法）
      const primary = spawnSync('id', ['-gn'], { encoding: 'utf8', timeout: 5000 });
      if (primary?.status === 0 && String(primary.stdout || '').trim() === 'docker') inGroup = true;
    }
    return { user, groupExists: true, userInGroup: inGroup };
  } catch {
    return { user, groupExists: null, userInGroup: null };
  }
}

/**
 * 按本机诊断生成"精确到这一台"的修复步骤（附在通用提示前面）；诊断不可用时返回空串。
 * 三条 2026-10-09 实测过的铁律写进文案：
 *   · NoNewPrivileges 加固的 unit 里 sudo 必失败 → 没有免密捷径，必须人工做一次；
 *   · 重建管理器必须 stop → sleep 3 → start：restart 会撞 status=219/CGROUP（旧实例 cgroup
 *     回收竞态），失败后管理器不会自动回来（服务停摆到人工 start）；
 *   · loginctl terminate-user 同样不会自动重建（服务停到下次登录）。
 */
export function dockerSocketHintLocal(diag = {}) {
  if (diag.userInGroup !== true && diag.userInGroup !== false) return '';
  if (diag.groupExists === false) {
    return '本机没有 docker 组（非标准 Docker 安装？）：请对照 docs/LINUX.md 的「控制台里更新协议端报 docker 权限不足」手工排查。';
  }
  const user = String(diag.user || '').trim() || '$USER';
  let uid = '';
  try { uid = String(process.getuid?.() ?? ''); } catch { uid = ''; }
  if (!/^\d+$/.test(uid)) uid = '$(id -u)';
  if (diag.userInGroup === false) {
    return [
      '按这台机器现在的状态，依次执行（这是唯一修法 —— 本服务被 NoNewPrivileges 加固，sudo 回退不可用）：',
      `  1) sudo usermod -aG docker ${user}`,
      `  2) sudo systemctl stop user@${uid}.service`,
      `  3) sleep 3`,
      `  4) sudo systemctl start user@${uid}.service`,
      '（服务会停约 10 秒后自动恢复。）'
    ].join('\n');
  }
  return [
    `按这台机器现在的状态，依次执行（${user} 已在 docker 组，缺的只是让管理器读到它）：`,
    `  sudo systemctl stop user@${uid}.service`,
    `  sleep 3`,
    `  sudo systemctl start user@${uid}.service`,
    '（服务会停约 10 秒后自动恢复。）'
  ].join('\n');
}

/** stderr/stdout 是不是“docker 套接字权限不足”（本机 unix socket 与 TCP 两种措辞都认）。 */
export function isDockerSocketDenied(text) {
  const raw = String(text || '');
  // 先要求文本里出现 docker：`connect: permission denied` 这一条单看太宽了 ——
  // 出网策略（SELinux / 防火墙 / 代理）也会给出同样的措辞，那时把用户引去
  // "重启 user manager" 就是把人带错方向。带上 docker 上下文之后就不会误伤。
  if (!/docker/i.test(raw)) return false;
  return /permission denied while trying to connect to the Docker daemon socket|Got permission denied while trying to connect|connect: permission denied/i
    .test(raw);
}

/** 从镜像串里取 tag / registry 前缀 / 仓库路径。`a/b/c:tag` → registry='a/b/'，repo='c'。 */
export function parseImage(image = '') {
  const raw = String(image || '').trim();
  if (!raw) return { raw: '', registry: '', repo: '', tag: '', version: '' };
  const at = raw.lastIndexOf('/');
  const colon = raw.lastIndexOf(':');
  const hasTag = colon > at;
  const tag = hasTag ? raw.slice(colon + 1) : '';
  const withoutTag = hasTag ? raw.slice(0, colon) : raw;
  // 第一段含 '.' 或 ':'（含端口）才当 registry（docker 的判定口径）
  const first = withoutTag.split('/')[0] || '';
  const hasRegistry = withoutTag.includes('/') && (first.includes('.') || first.includes(':'));
  const registry = hasRegistry ? `${first}/` : '';
  const repo = hasRegistry ? withoutTag.slice(first.length + 1) : withoutTag;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  return { raw, registry, repo, tag, version: m ? `${m[1]}.${m[2]}.${m[3]}` : '' };
}

/** 版本号比较（只认 x.y.z；不认识的按 0 处理）。 */
export function compareVersions(a = '', b = '') {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/**
 * 目标镜像：显式 override（配置里手填）优先；否则用项目基线，但**沿用当前镜像的 registry 前缀**
 * ——国内机器上当前是 `mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15`，
 * 直接换成 docker.io 的基线会拉不动（deploy-all.sh 支持 `--image` 就是为了这件事）。
 */
export function targetImageFor({ currentImage = '', override = '', baseline = SNOWLUMA_BASELINE_IMAGE } = {}) {
  const explicit = String(override || '').trim();
  if (explicit) return explicit;
  const cur = parseImage(currentImage);
  const base = parseImage(baseline);
  if (cur.registry && base.registry !== cur.registry) {
    return `${cur.registry}${base.repo}:${base.tag}`;
  }
  return baseline;
}

/**
 * 「随 Agent 版本对齐协议端」的决策（2026-10-09）。
 *
 * 语义：协议端基线（SNOWLUMA_BASELINE_IMAGE）是**代码常量** —— 它只随 Agent 新版本到达
 * 用户机器。所以"更新 Agent 后主服务带新代码重启"是用户看到新基线的唯一时刻；在这一刻做
 * 一次对齐，就实现了"我们发版动了协议端 → 用户更新 Agent 时顺带对齐；我们没动 → 用户也
 * 什么都不动"（基线没变时 outdated 为假，天然 no-op）。
 *
 * 返回字符串原因（便于日志与测试）：
 *   'align'              —— 该对齐（已安装 + 基线落后 + 无自定义镜像 + 开关未关 + 不忙）
 *   'skip:not-installed' —— 这台机器没装协议端
 *   'skip:override'      —— 用户指定了自定义镜像（锁版本），永不动他（既有语义）
 *   'skip:disabled'      —— 配置里显式关闭（autoUpdate.snowluma.followBaseline = false）
 *   'skip:busy'          —— 上一次更新还没收尾
 *   'skip:up-to-date'    —— 当前镜像不低于基线
 */
export function baselineAlignDecision({
  installed = false, outdated = false, override = '', followBaseline = true, busy = false
} = {}) {
  if (!installed) return 'skip:not-installed';
  if (String(override || '').trim() !== '') return 'skip:override';
  if (followBaseline === false) return 'skip:disabled';
  if (busy) return 'skip:busy';
  if (!outdated) return 'skip:up-to-date';
  return 'align';
}

/**
 * 默认的命令执行器（与 ops.js 的 run() 同口径，可注入替身以便测试）。
 *
 * ⚠️ 2026-10-09 改异步（原来是 spawnSync）：`docker compose pull` 的 timeout 是 300s，
 * spawnSync 会把整个主进程事件循环冻住 —— 拉镜像期间消息不处理、控制台无响应、/healthz
 * 探测失败、SIGTERM 也推进不了（systemd 的 TimeoutStopSec 到点直接 SIGKILL 整个 cgroup）。
 * 更新协议端本来就意味着"机器人离线几十秒"（容器重建），但不该顺手把 Agent 自己冻死。
 * 返回形状保持与旧实现逐字段一致（ok/code/stdout/stderr/missing/error）。
 */
export function defaultExec(cmd, args = [], { timeout = 180000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      encoding: 'utf8',
      timeout: timeout > 0 ? timeout : undefined,
      maxBuffer: 32 * 1024 * 1024,
      cwd,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        missing: Boolean(error && error.code === 'ENOENT'),
        error: error ? String(error.message || error) : ''
      });
    });
  });
}

/** 读 compose 项目的 .env（只取我们要用的几个键；文件不存在返回空）。 */
export function readComposeEnv(composeDir) {
  const envFile = path.join(composeDir, '.env');
  const out = { envFile, exists: false, image: '', container: '', raw: '' };
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    out.exists = true;
    out.raw = raw;
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === IMAGE_KEY) out.image = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1] === CONTAINER_KEY) out.container = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* 没装协议端/没权限：交给调用方按"不存在"处理 */ }
  return out;
}

/** 把 .env 里的 SNOWLUMA_IMAGE 换成新值：**其余行原样保留**，没有该键就追加。 */
export function renderEnvWithImage(raw = '', image = '') {
  // 镜像引用要写进 .env 的一行 —— 值里带换行就等于往 .env 注入新变量（docker compose 会拿它
  // 插值镜像 tag / 端口 / 引导密码）。合法镜像引用只由这些字符组成，与 deploy-all.sh 对同一个
  // 值用的那套校验同一口径（2026-10-08 审查）。
  if (!/^[A-Za-z0-9._/:@-]+$/.test(String(image || ''))) {
    throw new Error(`镜像引用不合法（只允许字母、数字与 . _ / : @ -）：${JSON.stringify(image)}`);
  }
  const lines = String(raw || '').split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\s*SNOWLUMA_IMAGE\s*=/.test(line)) { replaced = true; return `${IMAGE_KEY}=${image}`; }
    return line;
  });
  if (!replaced) {
    // 末尾空行就插在它前面，别留一堆空行
    if (next.length && next[next.length - 1] === '') next.splice(next.length - 1, 0, `${IMAGE_KEY}=${image}`);
    else next.push(`${IMAGE_KEY}=${image}`);
  }
  return next.join('\n');
}

/**
 * 轮转 <composeDir>/backups/ 下的旧备份，只保留最新的 keep 份，返回被删的绝对路径。
 *
 * 必须在**创建时**调用（而不是升级成功之后）：连续失败的升级每次都会新建一份完整备份，
 * 等成功了再清会把数据盘慢慢占满（deploy.sh 的 rollback 快照注释写了同一条教训）。
 * 刚创建的那份由 protect 显式钉住，即使时间戳撞车也不会被删。
 *
 * 删除范围限死在 `<composeDir>/backups/` 的**直接子目录**，且目录名必须是纯数字时间戳：
 * composeDir 为空、相对路径、或解析后不在 backupsRoot 下的，一律不删——一次配错的路径
 * 不能变成对别处的 rm -rf（与 deploy.sh 的绝对路径校验是同一意图）。
 * 清理失败只经 log 记一笔，绝不让升级流程失败（备份是保险，保险坏了不该拦下升级）。
 */
export function pruneComposeBackups(composeDir, { keep = SNOWLUMA_BACKUP_KEEP, protect = '', log = () => {} } = {}) {
  const limit = Math.floor(Number(keep));
  const root = String(composeDir || '').trim();
  if (!Number.isFinite(limit) || limit < 1 || !root || !path.isAbsolute(root)) {
    return { removed: [], kept: [] };
  }
  const backupsRoot = path.resolve(root, 'backups');
  const protectPath = protect ? path.resolve(protect) : '';
  let dirents = [];
  try {
    dirents = fs.readdirSync(backupsRoot, { withFileTypes: true });
  } catch (error) {
    // 目录不存在是正常情况（第一次升级）；其它错误也只是清理失败，不该中断升级
    if (error?.code !== 'ENOENT') log(`[snowluma] 读取备份目录失败，跳过清理：${error?.message ?? error}`);
    return { removed: [], kept: [] };
  }
  const entries = [];
  for (const dirent of dirents) {
    // 只看备份目录本身：isDirectory() 对符号链接为 false（不会顺着链接删出去），
    // 纯数字名把范围再收一层——rm -rf 的目标只能是 <backups>/<timestamp>/
    if (!dirent.isDirectory() || !/^\d{10,}$/.test(dirent.name)) continue;
    const full = path.join(backupsRoot, dirent.name);
    if (path.dirname(path.resolve(full)) !== backupsRoot) continue;
    entries.push(full);
  }
  // 目录名就是创建时间戳：数值大的更新，保留前 limit 份，其余删掉
  entries.sort((a, b) => Number(path.basename(b)) - Number(path.basename(a)));
  const removed = [];
  for (const target of entries.slice(limit)) {
    if (target === protectPath) continue;                 // 新创建的那份必须保留
    if (path.dirname(target) !== backupsRoot) continue;    // 再校验一次，别越出 backups/ 一步
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      log(`[snowluma] 清理旧备份失败（忽略）：${path.basename(target)} ${error?.message ?? error}`);
    }
  }
  const removedSet = new Set(removed);
  return { removed, kept: entries.filter((entry) => !removedSet.has(entry)) };
}

/** 备份 .env 与 compose 文件到 <composeDir>/backups/<ts>/（更新前的保险），并轮转旧备份。 */
export function backupComposeFiles(composeDir, ts = Date.now(), { keep = SNOWLUMA_BACKUP_KEEP, log = () => {} } = {}) {
  const dir = path.join(composeDir, 'backups', String(ts));
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const name of ['.env', 'docker-compose.yml']) {
    const from = path.join(composeDir, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dir, name));
    copied.push(name);
  }
  // 创建时就轮转，并把刚创建的这份钉住
  const pruned = pruneComposeBackups(composeDir, { keep, protect: dir, log });
  return { dir, copied, pruned };
}

/** 探测协议端是否已经起来：WebUI 的公开接口能返回 JSON 就算就绪（无需鉴权）。 */
function probeWebui(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ui/public', timeout: timeoutMs }, (res) => {
      // 只需要判断"是不是 JSON"：超过 64KB 的部分直接丢弃，不往内存里累（2026-10-10 审查）
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        bytes += Buffer.byteLength(c);
        if (bytes <= 64 * 1024) body += c;
      });
      res.on('end', () => resolve({ ok: res.statusCode === 200 && body.trim().startsWith('{'), status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(new Error('probe timeout')); resolve({ ok: false, status: 0 }); });
    req.on('error', (error) => resolve({ ok: false, status: 0, error: String(error?.message || error) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 本进程是否被 NoNewPrivileges 加固（读 /proc/self/status；非 Linux 读不到＝未加固）。
 * 加固时 `sudo` 这类 setuid 提权**必失败**（内核禁止），所以任何"先试 sudo 再说"的
 * 回退都该先过这一关（deploy.sh 对同一条限制早有先例 —— Issue #15）。
 */
function processHasNoNewPrivs() {
  try {
    return /NoNewPrivs:\s*1/.test(fs.readFileSync('/proc/self/status', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * 协议端更新器。exec 可注入（测试用替身）；probe 同理。
 * 只做"改 .env + compose pull/up + 等就绪 + 失败自动回滚"，不碰容器名/端口/数据卷。
 */
export function createSnowlumaUpdater(options = {}) {
  // ⚠️ 注入点写成 const 而不是"解构参数默认值"：未定义调用扫描（node src/ops.js scan --strict，
  // CI 会跑）只认已声明的标识符，`{ exec = defaultExec }` 这种默认值它看不见，
  // 会把 exec(...)/probe(...) 报成"可疑未定义调用"（2026-10-08 CI 抓到过一次）。
  const dir = String(options.composeDir || '');
  const container = options.container || 'qq-agent-snowluma';
  const webuiPort = Number(options.webuiPort) || 5099;
  const baseline = options.baseline || SNOWLUMA_BASELINE_IMAGE;
  const exec = options.exec || defaultExec;
  const probe = options.probe || probeWebui;
  const log = options.log || (() => {});
  // NNP 探测同样留注入点（测试替身；命名跟 exec/probe 一样走"const 局部量"的扫描约定）。
  const hasNoNewPrivs = options.hasNoNewPrivs || processHasNoNewPrivs;
  // 直接 docker 撞上“套接字没权限”时，要不要回退到 `sudo -n docker`。
  // 关掉它：QQ_AGENT_NO_SUDO_DOCKER=1。
  const noSudoDocker = process.env.QQ_AGENT_NO_SUDO_DOCKER === '1';
  let usedSudoDocker = false;
  const readyTimeoutMs = Number(options.readyTimeoutMs) || 120000;
  const readyPollMs = Number(options.readyPollMs) || 2000;
  const lockDir = path.join(dir, '.snowluma-update.lock');
  const journalFile = path.join(dir, '.snowluma-update.json');
  let busy = null;                  // 同一时刻只允许一个更新在跑
  let lastResult = null;            // 最近一次更新结果（供"回滚到上一版"用）

  const readJournal = () => {
    try { return JSON.parse(fs.readFileSync(journalFile, 'utf8')); } catch { return null; }
  };
  const writeJournal = (entry) => {
    const tmp = `${journalFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, journalFile);
  };
  const clearJournal = () => {
    try { fs.rmSync(journalFile, { force: true }); } catch { /* 忽略 */ }
  };
  const acquireLock = () => {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      // 崩溃遗留的锁：超过 30 分钟才接管，避免误伤正在 pull 的另一个进程。
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { ageMs = 0; }
      if (ageMs < 30 * 60_000) return false;
      try { fs.rmSync(lockDir, { recursive: true, force: true }); fs.mkdirSync(lockDir, { recursive: false }); }
      catch { return false; }
    }
    try {
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid, hostname: os.hostname(), startedAt: Date.now()
      }), { mode: 0o600 });
    } catch { /* 锁目录存在即可；owner 只是诊断 */ }
    return true;
  };
  const releaseLock = () => {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };

  /**
   * 跑一条 docker 命令：先按当前进程的身份跑；如果撞上“套接字没权限”这种只有组缺失才会有的错，
   * 再退回 `sudo -n docker`（一次性、非交互；没免密 sudo 就立刻失败，不会挂住）。
   *
   * 为什么必须有这条回退（Issue #30）：非 root 进程**无法**给自己补上缺失的补充组 ——
   * 实测 `systemd-run --user -p SupplementaryGroups=docker` 报
   * “Changing group credentials failed: Operation not permitted”（`sg` 在 Ubuntu 上也不是 setgid 的）。
   * 所以在“后来才被加进 docker 组、但 systemd --user 管理器没重建”的机器上，直接 docker 永远不行。
   * 而 deploy-all.sh 早就在用 `sudo docker` 这条同样的路（见那儿的探测梯子）——
   * 把同一条路给运行时用上，Issue #30 那个按钮才真的能用，而不只是改一句报错。
   */
  async function runDocker(args, opts) {
    const res = await exec('docker', args, opts);
    if (res.ok || noSudoDocker) return res;
    if (!isDockerSocketDenied(`${res.stderr || ''}${res.stdout || ''}`)) return res;
    // ⚠️ NoNewPrivileges 加固的 unit 里 sudo 必失败（内核禁止 setuid 提权）：先判再试。
    // 不判的话这里每次都白跑一次注定失败的提权，错误文案还会写成"已尝试 sudo 回退，
    // 同样失败"，把用户引向"是不是 sudo 没配"——真正的修法是重启 user manager
    //（2026-10-09 审查；本项目的标准 unit 由 install-service.mjs 生成，**默认带 NNP**）。
    if (hasNoNewPrivs()) {
      return {
        ...res,
        stderr: `${String(res.stderr || '').trim()}\n`
          + '（本服务被 NoNewPrivileges 加固，sudo 回退不可用；'
          + '永久修法见 docs/LINUX.md「控制台里更新协议端报 docker 权限不足」）'
      };
    }
    const viaSudo = await exec('sudo', ['-n', 'docker', ...args], opts);
    if (viaSudo.ok) {
      usedSudoDocker = true;
      log('[snowluma] 直接连 docker 权限不足（这个进程没有 docker 组），已回退到 sudo -n docker；'
        + '永久修法见 docs/LINUX.md「控制台里更新协议端报 docker 权限不足」');
      return viaSudo;
    }
    // 两条路都不通：把两边的报错合起来回传，别把 sudo 那半截丢了 ——
    // “连提权都失败”比“权限不足”更接近真相。
    return {
      ...viaSudo,
      stderr: `${String(res.stderr || '').trim()}\n${String(viaSudo.stderr || '').trim()}`.trim()
    };
  }

  function compose(...args) {
    return runDocker(['compose', '--project-directory', dir, '--env-file', path.join(dir, '.env'),
      '-f', path.join(dir, 'docker-compose.yml'), ...args], { cwd: dir, timeout: 300000 });
  }

  /**
   * docker 的原始输出 → 给用户看的文案。
   * 认得出是“进程没 docker 组”就给可执行步骤（Issue #30），否则照旧截断回传。
   */
  function describeDockerFailure(text, fallback) {
    const raw = String(text || '').trim();
    if (isDockerSocketDenied(raw)) {
      // "已尝试 sudo 回退"只在真的试过时才说：NNP 加固时 runDocker 直接跳过 sudo，
      // 说"已尝试、同样失败"会把用户引向"是不是 sudo 没配"（2026-10-09 审查）。
      const retryNote = hasNoNewPrivs()
        ? '（NoNewPrivileges 加固下 sudo 回退不可用，未尝试提权）'
        : '（已尝试 sudo -n docker 回退，同样失败）';
      // 本机精确步骤放最前面（用户在报错里照第一段做即可），通用说明随后（2026-10-09）。
      const local = dockerSocketHintLocal(dockerGroupDiagnosis());
      return [local, DOCKER_SOCKET_HINT, retryNote, `原始输出：${raw.slice(0, 300)}`]
        .filter(Boolean).join('\n\n');
    }
    return (raw || fallback).slice(0, 500);
  }

  async function inspect(field) {
    const res = await runDocker(['inspect', '-f', `{{${field}}}`, container], { timeout: 15000 });
    return res.ok ? res.stdout.trim() : '';
  }

  /** 当前状态：跑着的镜像 tag、容器状态、目标镜像、是否落后（异步：内部要查 docker）。 */
  async function status() {
    const env = readComposeEnv(dir);
    const runningImage = await inspect('.Config.Image');
    const state = await inspect('.State.Status');
    const currentImage = runningImage || env.image;
    const cur = parseImage(currentImage);
    const target = targetImageFor({ currentImage, override: '', baseline });
    const tgt = parseImage(target);
    return {
      composeDir: dir,
      installed: env.exists,
      envImage: env.image,
      container: env.container || container,
      runningImage,
      runningState: state,
      running: state === 'running',
      currentImage,
      currentVersion: cur.version,
      targetImage: target,
      targetVersion: tgt.version,
      outdated: Boolean(cur.version && tgt.version) && compareVersions(cur.version, tgt.version) < 0,
      belowRecommended: Boolean(cur.version) && compareVersions(cur.version, SNOWLUMA_MIN_RECOMMENDED) < 0,
      minRecommended: SNOWLUMA_MIN_RECOMMENDED,
      baseline,
      busy: Boolean(busy),
      lockHeld: fs.existsSync(lockDir),
      // 非空 = 上一次更新的进程在写 .env/compose 时死掉了，需要管理员按 journal 检查。
      interrupted: readJournal(),
      lastResult
    };
  }

  /** 等容器起来 + WebUI 就绪。 */
  async function waitReady() {
    const startedAt = Date.now();
    for (;;) {
      const state = await inspect('.State.Status');
      if (state === 'running') {
        const p = await probe(webuiPort);
        if (p.ok) return { ok: true, waitedMs: Date.now() - startedAt };
      }
      if (Date.now() - startedAt > readyTimeoutMs) {
        return { ok: false, waitedMs: Date.now() - startedAt, state };
      }
      await sleep(readyPollMs);
    }
  }

  async function runUpdate({ to = '', dryRun = false } = {}) {
    const st = await status();
    if (!st.installed) return { ok: false, error: `没找到协议端的 compose 项目（${dir}/.env 不存在）` };
    const from = st.currentImage;
    const target = String(to || '').trim() || st.targetImage;
    if (!target) return { ok: false, error: '算不出目标镜像' };
    const steps = [
      { cmd: 'docker', args: ['compose', 'pull'] },
      { cmd: 'docker', args: ['compose', 'up', '-d'] }
    ];
    if (dryRun) {
      return { ok: true, dryRun: true, from, to: target, envChange: `${IMAGE_KEY}=${target}`, steps };
    }
    if (target === from) {
      // 真机验证过的行为：镜像 tag 没变时 `compose up -d` 发现配置无变化，**不会**重启容器
      // （这是好事：没必要为了"更新"平白断一次连接）。要强制重建得手动 --force-recreate。
      log(`[snowluma] 已经是目标镜像 ${target}：只拉取/校验，compose 不会白重启容器`);
    }
    // 预检（Issue #30）：在**动任何文件之前**先确认这个进程能不能连上守护进程。
    // 只拦“没权限”这一种 —— 守护进程挂了/镜像仓库不通交给后面真正的 pull 报，
    // 在这里提前失败只会让原因变含糊。用 docker info 而不是探 socket 文件：
    // 前者同时覆盖“socket 在但守护进程没起”与自定义 DOCKER_HOST 的情况。
    const probeRes = await runDocker(['info', '--format', '{{.ServerVersion}}'], { timeout: 15000 });
    if (!probeRes.ok && isDockerSocketDenied(`${probeRes.stderr || ''}${probeRes.stdout || ''}`)) {
      // 走 describeDockerFailure 而不是直接塞 HINT：它会把"是否真的试过 sudo 回退"如实带出来
      //（NNP 加固时 runDocker 直接跳过 sudo，文案不能再写"已尝试"——2026-10-09 审查）。
      const detail = describeDockerFailure(`${probeRes.stderr || ''}${probeRes.stdout || ''}`, DOCKER_SOCKET_HINT);
      log(`[snowluma] ${detail}`);
      const result = {
        ok: false, stage: 'preflight', error: detail,
        from, to: target, restored: true, viaSudo: usedSudoDocker, log: [detail]
      };
      lastResult = result;
      return result;
    }

    // 目录校验：QQ_AGENT_SNOWLUMA_DIR 配成部署根目录时，这里看到的是全栈 compose
    //（含 agent 服务）。再往下会 pull/up 起第二个 Agent、和 systemd 抢 3210、共用 ./data。
    // 只认服务列表，不靠文件名；读不到服务列表时 fail-closed。
    const servicesRes = await compose('config', '--services');
    const services = String(servicesRes.stdout || '').split(/\s+/).filter(Boolean);
    if (!servicesRes.ok) {
      const detail = `无法读取协议端 compose 的服务列表（${dir}/docker-compose.yml）：${describeDockerFailure(servicesRes.stderr || servicesRes.stdout, 'compose config 失败')}`;
      log(`[snowluma] ${detail}`);
      const result = { ok: false, stage: 'preflight', error: detail, from, to: target, restored: true, viaSudo: usedSudoDocker, log: [detail] };
      lastResult = result;
      return result;
    }
    if (services.includes('agent')) {
      const detail = `这个目录看起来是全栈 compose（含 agent 服务），不是协议端项目：${dir}。`
        + '请把 QQ_AGENT_SNOWLUMA_DIR 指到 snowluma 子目录，避免控制台更新协议端时拉起第二个 Agent。';
      log(`[snowluma] ${detail}`);
      const result = { ok: false, stage: 'preflight', error: detail, from, to: target, restored: true, viaSudo: usedSudoDocker, log: [detail] };
      lastResult = result;
      return result;
    }

    const backup = backupComposeFiles(dir, Date.now(), { log });
    const envFile = path.join(dir, '.env');
    const originalEnv = fs.readFileSync(envFile, 'utf8');
    // journal 必须在改 .env 之前落盘：进程在 pull/up 中途死掉时，下一次启动能看出
    // "env 可能已被改成 to、容器可能是 from"；正常结束由 update() 的 finally 清掉。
    writeJournal({ from, to: target, backupDir: backup.dir, pid: process.pid, hostname: os.hostname(), startedAt: Date.now() });
    const lines = [];
    const push = (s) => { const line = String(s).trim(); if (line) { lines.push(line); log(`[snowluma] ${line}`); } };

    // .env 原子写（2026-10-12 审查）：直接写目标文件时，更新器被超时/重启打断会留下半个
    // .env，compose 直接起不来。tmp 写完再 rename；权限沿用原文件的（rename 会换 inode，
    // 不带 mode 会把原来的 0600 打回 umask 默认）。
    const envMode = (() => { try { return fs.statSync(envFile).mode & 0o777; } catch { return 0o600; } })();
    const writeEnvAtomic = (content) => {
      const tmp = `${envFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: envMode });
      fs.renameSync(tmp, envFile);
    };

    try {
      writeEnvAtomic(renderEnvWithImage(originalEnv, target));
      push(`镜像写入 ${IMAGE_KEY}=${target}（备份在 ${backup.dir}）`);

      const pull = await compose('pull');
      push(`pull ${pull.ok ? 'ok' : `失败(code=${pull.code})`}`);
      if (!pull.ok) {
        writeEnvAtomic(originalEnv);
        const result = { ok: false, stage: 'pull', error: describeDockerFailure(pull.stderr || pull.stdout, '拉取镜像失败'), from, to: target, restored: true, viaSudo: usedSudoDocker, backupDir: backup.dir, log: lines };
        lastResult = result;
        return result;
      }

      const up = await compose('up', '-d');
      push(`up -d ${up.ok ? 'ok' : `失败(code=${up.code})`}`);
      if (!up.ok) throw new Error(describeDockerFailure(up.stderr || up.stdout, 'compose up 失败'));

      const ready = await waitReady();
      push(`就绪等待 ${ready.waitedMs}ms → ${ready.ok ? '已就绪' : '超时'}`);
      if (!ready.ok) throw new Error(`容器没有在 ${readyTimeoutMs}ms 内就绪（状态 ${ready.state || 'unknown'}）`);

      const result = { ok: true, from, to: target, waitedMs: ready.waitedMs, viaSudo: usedSudoDocker, backupDir: backup.dir, log: lines };
      lastResult = result;
      return result;
    } catch (error) {
      // 失败即回滚：把 .env 还原再 up -d 回旧镜像（数据卷没动过，登录态不受影响）
      push(`失败：${error?.message ?? error} —— 开始回滚到 ${from}`);
      let rolledBack = false;
      try {
        writeEnvAtomic(originalEnv);
        const back = await compose('up', '-d');
        const ready = await waitReady();
        rolledBack = back.ok && ready.ok;
        push(`回滚 ${rolledBack ? '成功' : '未确认（需要人工看一眼）'}`);
      } catch (rollbackError) {
        push(`回滚也失败了：${rollbackError?.message ?? rollbackError}`);
      }
      const result = { ok: false, stage: 'up', error: String(error?.message ?? error), from, to: target, rolledBack, backupDir: backup.dir, log: lines };
      lastResult = result;
      return result;
    }
  }

  /** 串行化：同一时刻只跑一个更新（并发点击/自动+手动撞车时直接拒绝）。 */
  function update(options = {}) {
    if (busy) return Promise.resolve({ ok: false, error: '已经有一个协议端更新在进行中', busy: true });
    if (!dir || !fs.existsSync(dir)) {
      return Promise.resolve({ ok: false, error: `没找到协议端的 compose 项目（${dir || '(未配置目录)'}）` });
    }
    const interrupted = readJournal();
    if (interrupted) {
      return Promise.resolve({
        ok: false,
        busy: false,
        interrupted,
        error: '上一次协议端更新没有正常收尾（journal 仍在）：请先检查 .env/容器状态并删除 '
          + `${journalFile} 后再试`
      });
    }
    if (!acquireLock()) {
      return Promise.resolve({ ok: false, busy: true, error: '另一个进程正在更新协议端（跨进程锁已占用）' });
    }
    busy = Promise.resolve()
      .then(() => runUpdate(options))
      .finally(() => { clearJournal(); releaseLock(); busy = null; });
    return busy;
  }

  /** 回滚到"上一次更新前的镜像"（只有在有过一次成功/失败的更新后可用）。 */
  function rollback() {
    const from = lastResult?.from || '';
    if (!from) return Promise.resolve({ ok: false, error: '还没有可回滚的记录（本次进程内没执行过更新）' });
    return update({ to: from });
  }

  return { status, update, rollback, composeDir: dir, webuiPort, container };
}
