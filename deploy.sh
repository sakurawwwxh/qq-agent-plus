#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$ROOT"
DATA_DIR=""
HOST="127.0.0.1"
PORT="3210"
HOST_SET=false
PORT_SET=false
SERVICE="qq-agent-linux"
DEPLOY_REPOSITORY=""
DEPLOY_BRANCH=""
IMPORT_BRIDGE=""
CREDENTIAL_FILE=""
NODE_BIN="${NODE_BIN:-}"
NODE_VERSION="${QQ_AGENT_NODE_VERSION:-22.23.3}"
BACKUP_ENABLED=true
ALLOW_PATH_CHANGE=false

usage() {
  cat <<'EOF'
Usage: bash deploy.sh [options]

Options:
  --install-dir PATH     Application directory (default: repository directory)
  --data-dir PATH        Persistent data directory (default: INSTALL_DIR/data)
  --host ADDRESS         Console bind address (default: 127.0.0.1; on updates the
                         address already recorded in config.json is reused)
  --port PORT            Console port (default: 3210; on updates the port already
                         recorded in config.json is reused)
  --service NAME         systemd user service name (default: qq-agent-linux)
  --node PATH            Existing Node.js >=22.19 binary
  --import-bridge PATH   Import legacy Bridge config on first install
  --repository URL       Expected origin repository (auto-update passes it; compared
                         against .deployment.json when provided)
  --branch NAME          Expected source branch (compared when provided)
  --credential-file PATH Import DEEPSEEK_API_KEY on first install
  --no-backup            Skip the pre-deployment code snapshot
  --allow-path-change    Allow the persistent data directory to move (requires
                         QQ_AGENT_ALLOW_PATH_CHANGE=1 in the environment) —
                         both conditions are checked before anything changes
  -h, --help             Show this help
EOF
}

require_value() {
  (($# >= 2)) || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
}

while (($#)); do
  case "$1" in
    --install-dir) require_value "$@"; INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) require_value "$@"; DATA_DIR="$2"; shift 2 ;;
    --host) require_value "$@"; HOST="$2"; HOST_SET=true; shift 2 ;;
    --port) require_value "$@"; PORT="$2"; PORT_SET=true; shift 2 ;;
    --service) require_value "$@"; SERVICE="$2"; shift 2 ;;
    --repository) require_value "$@"; DEPLOY_REPOSITORY="$2"; shift 2 ;;
    --branch) require_value "$@"; DEPLOY_BRANCH="$2"; shift 2 ;;
    --node) require_value "$@"; NODE_BIN="$2"; shift 2 ;;
    --import-bridge) require_value "$@"; IMPORT_BRIDGE="$2"; shift 2 ;;
    --credential-file) require_value "$@"; CREDENTIAL_FILE="$2"; shift 2 ;;
    --no-backup) BACKUP_ENABLED=false; shift ;;
    # 数据目录迁移的逃生开关：校验器要求「本参数 + 环境变量 QQ_AGENT_ALLOW_PATH_CHANGE=1」双条件。
    # 此前本脚本没收这个参数，校验器却让用户加它 → 迁移永远做不成、提示还指向不存在的开关
    # （2026-09-30 审查 P1）。
    --allow-path-change) ALLOW_PATH_CHANGE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || { printf 'Linux only\n' >&2; exit 1; }
if ((EUID == 0)); then
  printf 'Warning: running deploy.sh as root is not recommended; the service will run as root. Prefer the service user or install.sh.\n' >&2
fi
[[ "$SERVICE" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || {
  printf 'Port must be an integer from 1 to 65535\n' >&2
  exit 2
}
[[ "$INSTALL_DIR" = /* ]] || { printf 'Use an absolute installation path\n' >&2; exit 2; }
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
[[ "$DATA_DIR" = /* ]] || { printf 'Use an absolute data path\n' >&2; exit 2; }
for p in "$INSTALL_DIR" "$DATA_DIR"; do
  [[ "$p" != *[[:space:]%\"]* ]] || {
    printf 'Deployment paths must not contain whitespace, %% or quotes: %s\n' "$p" >&2
    exit 2
  }
done
# 两个方向都要拒：安装目录在源码仓库里 → rsync --delete 会删掉仓库里的文件；
# 源码仓库在安装目录里 → --delete 会把 data/、.runtime/、node_modules/ 连源码目录一起清掉。
# 2026-10-01 审查：原先只查了前一个方向。
# 判定前先归一化：`/srv/app` 与 `/srv//app`、`/srv/x/../app`、以及经符号链接指向同一处的写法
# 是同一个目录，只做未归一化的字符串前缀比较会漏判（另一条同类审查意见）。
# 归一化失败**不退回原串**（2026-10-01 第六轮审查）：退回等于守卫静默失效 —— 带 `//`、`..`
# 或符号链接的等价写法又能绕过两条嵌套判定。realpath 属 coreutils，本脚本本来就要求
# Linux + systemd + rsync + node，这里 fail-closed：调用点失败即停（见下面两条）。
canon_path() {
  realpath -m -- "$1"
}
ROOT_CANON="$(canon_path "$ROOT")" || { printf 'Cannot normalize the source path: %s\n' "$ROOT" >&2; exit 2; }
INSTALL_CANON="$(canon_path "$INSTALL_DIR")" || { printf 'Cannot normalize the installation path: %s\n' "$INSTALL_DIR" >&2; exit 2; }
# 共享目录判定放在归一化之后：`/srv/`、`/srv/../srv` 或指向 /srv 的符号链接
# 归一化后都会命中；只比较未归一化的原始字符串会被这些等价写法绕过。
case "$INSTALL_CANON" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
    printf 'Refusing to deploy into a shared system directory: %s\n' "$INSTALL_DIR" >&2
    exit 2
    ;;
esac
if [[ "$ROOT_CANON" != "$INSTALL_CANON" && "$INSTALL_CANON" == "$ROOT_CANON/"* ]]; then
  printf 'Installation path must not be nested inside the source repository\n' >&2
  exit 2
fi
if [[ "$ROOT_CANON" != "$INSTALL_CANON" && "$ROOT_CANON" == "$INSTALL_CANON/"* ]]; then
  printf 'The source repository must not be nested inside the installation path\n' >&2
  exit 2
fi
# 数据目录 = 安装目录时，下面按相对路径排除数据的逻辑会退化成只排除 /data/，而源码树里没有
# data/ —— 第二次部署的 `rsync -a --delete` 会把 config.json / SQLite / 会话全删掉。
# 这是"传了两个参数看起来都合理"的组合，必须在任何改动之前拒绝（与 rsync --delete 同一口径）。
DATA_CANON="$(canon_path "$DATA_DIR")" || { printf 'Cannot normalize the data path: %s\n' "$DATA_DIR" >&2; exit 2; }
if [[ "$DATA_CANON" == "$INSTALL_CANON" ]]; then
  printf 'The data directory must be different from the installation directory: rsync --delete would wipe it\n' >&2
  exit 2
fi
# 网页终端 / su / sudo -u 等非登录会话不设置 XDG_RUNTIME_DIR：systemctl --user 会报
# "Failed to connect to bus"，哪怕用户管理器在跑（2026-10-12 报道在生产机复现：只差这一个
# 环境变量）。目录存在就补上；用户自己的值不动。控制台触发的部署由 ops.js 注入，不受影响。
if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
command -v systemctl >/dev/null || { printf 'systemctl is required: deploy on a Linux host with systemd\n' >&2; exit 1; }
systemctl --user show-environment >/dev/null || { printf 'Cannot reach the systemd user manager for %s: non-login shells (web terminals, su) need XDG_RUNTIME_DIR — run this script from a normal login session (for example over SSH), or export XDG_RUNTIME_DIR=/run/user/$(id -u) and retry; if that directory does not exist, run "sudo loginctl enable-linger %s" first\n' "$(id -un)" "$(id -un)" >&2; exit 1; }
command -v rsync >/dev/null || { printf 'rsync is required: install it first (Debian/Ubuntu: apt install -y rsync)\n' >&2; exit 1; }
mkdir -p "$INSTALL_DIR" "$DATA_DIR"

LOCK_DIR="$DATA_DIR/.deploy.lock"
TAKEOVER_DIR="$LOCK_DIR.takeover"
# TMP_DIR 提前声明：Node 下载失败时 set -e 直接退出，EXIT trap 里的清理要能引用到它（set -u 下未定义会报错）。
TMP_DIR=""
LOCK_OWNED=false
TAKEOVER_OWNED=false
# trap 必须在**抢锁之前**挂上：抢锁窗口里被打断（下面那几条 exit 1、SIGTERM）也要把互斥目录收掉。
# 2026-10-01 审查 P1：原来 trap 挂在抢锁之后，于是"删锁重建失败 → exit 1"会留下互斥目录，
# 而互斥没有陈旧兜底时，此后每次接管都死在"retry in a moment"——把锁修成了新的死锁。
# SIGKILL/OOM/掉电不执行 trap，那条路由下面互斥目录的 5 分钟陈旧宽限兜底。
cleanup_lock() {
  if [[ "$TAKEOVER_OWNED" == true ]]; then rm -rf -- "$TAKEOVER_DIR"; fi
  if [[ "$LOCK_OWNED" == true ]]; then rm -rf -- "$LOCK_DIR"; fi
  if [[ -n "$TMP_DIR" ]]; then rm -rf -- "$TMP_DIR"; fi
  return 0
}
trap cleanup_lock EXIT
# 锁的属主写成 pid + 开始时间：SIGKILL（systemd 超时补杀、OOM、掉电）不会执行 EXIT trap，
# 锁目录会永久留下，无人值守的自动更新从此每次都死在第一条检查上，只能人工 rm。
# 接管条件取严：属主进程不存在 **且** 锁已超过 5 分钟 —— 刚 mkdir 还没写 pid 的锁不能算陈旧，
# 否则一次并发部署会被"抢锁"。仍不满足就报出 pid/时间，让人确认后再删（2026-09-29 审查 P2）。
lock_owner_alive() {
  local pid
  pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}
# find 的 -mmin +5 命中时才打印路径：判"是否超过 5 分钟"要的是**输出非空**（-n）。
# 2026-10-01 审查：原先写成 -z，语义整个反过来 —— 属主已死且确实过期的锁走 else 直接 exit 1
# （SIGKILL 之后无人值守的更新就永久卡死），而"刚 mkdir 还没写 pid"的并发锁反被抢走 rm -rf。
stale_enough() {
  [[ -n "$(find "$1" -maxdepth 0 -mmin +5 2>/dev/null)" ]]
}
lock_is_stale() {
  ! lock_owner_alive && stale_enough "$LOCK_DIR"
}
# 抢到互斥之后才真正删锁重建。返回非 0 = 不该抢，调用方退出（trap 会清掉互斥）。
take_over_lock() {
  # 拿到互斥后**再判一次**：判定与抢互斥之间可能被调度挂起，期间别的进程可能已经建好新锁
  # （它先判定、再抢到互斥、跑完释放），照删就会把人家正在用的锁删掉（2026-10-01 审查 P2）。
  if ! lock_is_stale; then
    printf 'Another deployment is running (the lock was refreshed while taking over).\n' >&2
    return 1
  fi
  printf 'Stale deployment lock (owner process is gone for over 5 minutes): taking it over\n' >&2
  rm -rf -- "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || { printf 'Another deployment may be running.\n' >&2; return 1; }
  LOCK_OWNED=true
  return 0
}
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if ! lock_is_stale; then
    printf 'Another deployment is running (pid %s, started %s).\n' \
      "$(cat "$LOCK_DIR/pid" 2>/dev/null || printf '?')" "$(cat "$LOCK_DIR/started" 2>/dev/null || printf '?')" >&2
    printf 'If that process is really gone, remove the lock and retry: rm -rf -- %s\n' "$LOCK_DIR" >&2
    exit 1
  fi
  # 抢锁要过一道互斥（mkdir 原子）：两个并发部署同时判定"陈旧"时，若都直接 rm -rf + mkdir，
  # 后者会把前者刚建好的新锁删掉，两个进程同时往下走。只有一个能进这段，另一个退出。
  if ! mkdir "$TAKEOVER_DIR" 2>/dev/null; then
    # 互斥本身也可能被 SIGKILL 遗留（trap 不执行）：过 5 分钟就清掉重来，
    # 否则自动更新会被永久钉在"有人正在接管"上 —— 和当初那把陈旧锁是同一个坑。
    if ! stale_enough "$TAKEOVER_DIR"; then
      printf 'Another deployment is taking over a stale lock; retry in a moment.\n' >&2
      exit 1
    fi
    printf 'Leftover takeover lock (older than 5 minutes): removing it\n' >&2
    rm -rf -- "$TAKEOVER_DIR"
    mkdir "$TAKEOVER_DIR" 2>/dev/null || { printf 'Another deployment is taking over a stale lock; retry in a moment.\n' >&2; exit 1; }
  fi
  TAKEOVER_OWNED=true
  take_over_lock || exit 1
  rmdir "$TAKEOVER_DIR" 2>/dev/null || true
  TAKEOVER_OWNED=false
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
printf '%s\n' "$(date -Is 2>/dev/null || date)" > "$LOCK_DIR/started"
LOCK_OWNED=true

node_ready() {
  [[ -n "$1" && -x "$1" ]] || return 1
  # 低限 22.19：运行期依赖 undici 8 声明 engines >=22.19（2026-10-01 升级，
  # Dependabot 的 undici 6→8）；deploy.sh 自己下载的 .runtime 是 22.23.3，不受影响。
  "$1" --input-type=module -e '
    const [major,minor]=process.versions.node.split(".").map(Number);
    if (major<22 || (major===22 && minor<19)) process.exit(1);
    const {DatabaseSync}=await import("node:sqlite");
    new DatabaseSync(":memory:").close();
  ' >/dev/null 2>&1
}

if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
# 2026-10-06 复审 P2：无系统 Node 时先复用 $INSTALL_DIR/.runtime 里已装好的运行时。
# 原先只探测 `command -v node`，服务器重跑部署（deploy-all 的镜像拉取失败提示就是
# "重跑 deploy-all.sh"，而它调 deploy.sh 不带 --node）会每次都从 nodejs.org 全量重下，
# nodejs.org 不可达时整个部署失败 —— 哪怕磁盘上就有校验过的可用 node。
RUNTIME_DIR="$INSTALL_DIR/.runtime"
NODE_ARCH=''
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) NODE_ARCH='' ;;
esac
if [[ -n "$NODE_ARCH" ]] && ! node_ready "$NODE_BIN"; then
  CANDIDATE_NODE="$RUNTIME_DIR/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node"
  if node_ready "$CANDIDATE_NODE"; then
    NODE_BIN="$CANDIDATE_NODE"
    printf 'Reusing existing Node.js runtime at %s\n' "$CANDIDATE_NODE"
  fi
fi
# 精确补丁版没命中时，先认上次部署记下的运行时，再退到 .runtime 里任意一个合格版本：
# 升级 NODE_VERSION（22.23.2 → 22.23.3）不该让离线机器因为"版本号不同"重新下载。
if ! node_ready "$NODE_BIN" && [[ -r "$INSTALL_DIR/.deployment-node" ]]; then
  RECORDED_NODE="$(tr -d '\r\n' < "$INSTALL_DIR/.deployment-node" 2>/dev/null || true)"
  if node_ready "$RECORDED_NODE"; then
    NODE_BIN="$RECORDED_NODE"
    printf 'Reusing recorded Node.js runtime at %s\n' "$NODE_BIN"
  fi
fi
if ! node_ready "$NODE_BIN" && [[ -n "$NODE_ARCH" && -d "$RUNTIME_DIR" ]]; then
  while IFS= read -r CANDIDATE_NODE; do
    [[ -n "$CANDIDATE_NODE" ]] || continue
    if node_ready "$CANDIDATE_NODE"; then
      NODE_BIN="$CANDIDATE_NODE"
      printf 'Reusing existing Node.js runtime at %s\n' "$NODE_BIN"
      break
    fi
  done < <(find "$RUNTIME_DIR" -maxdepth 4 -type f \
    -path "*/node-v*-linux-${NODE_ARCH}/bin/node" -print 2>/dev/null | sort -rV)
fi
if ! node_ready "$NODE_BIN"; then
  command -v curl >/dev/null
  command -v sha256sum >/dev/null
  command -v tar >/dev/null
  command -v xz >/dev/null || { printf 'xz is required to unpack the Node.js archive (install xz-utils)\n' >&2; exit 1; }
  if [[ -z "$NODE_ARCH" ]]; then
    printf 'Unsupported CPU architecture: %s\n' "$(uname -m)" >&2; exit 1
  fi
  ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  TMP_DIR="$(mktemp -d)"
  printf 'Installing Node.js v%s for %s...\n' "$NODE_VERSION" "$NODE_ARCH"
  curl -fsSLo "$TMP_DIR/$ARCHIVE" "https://nodejs.org/dist/v${NODE_VERSION}/$ARCHIVE"
  curl -fsSLo "$TMP_DIR/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (cd "$TMP_DIR" && grep "  $ARCHIVE$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$RUNTIME_DIR"
  tar -xJf "$TMP_DIR/$ARCHIVE" -C "$RUNTIME_DIR"
  rm -rf "$TMP_DIR"
  NODE_BIN="$RUNTIME_DIR/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node"
fi
node_ready "$NODE_BIN" || { printf 'Node.js >=22.19 with node:sqlite is required\n' >&2; exit 1; }
NODE_BIN="$("$NODE_BIN" -p 'process.execPath')"
[[ "$NODE_BIN" != *[[:space:]%\"]* ]] || { printf 'Node path contains unsupported characters\n' >&2; exit 2; }
export PATH="$(dirname "$NODE_BIN"):$PATH"

# 更新已有安装时，没有显式给出的 --host/--port 沿用 config.json 里的现值：用默认值覆盖会让一次
# 普通更新把控制台从"所有网卡"或原来的地址悄悄改成只监听本机。
if [[ "$HOST_SET" != true || "$PORT_SET" != true ]] && [[ -f "$DATA_DIR/config.json" ]]; then
  mapfile -t PREVIOUS_ENDPOINT < <("$NODE_BIN" -e '
    const fs = require("node:fs");
    const out = ["", ""];
    try {
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof cfg?.server?.host === "string") out[0] = cfg.server.host;
      if (Number.isInteger(cfg?.server?.port)) out[1] = String(cfg.server.port);
    } catch { /* 配置损坏时按新装处理，交给 configure-linux 报错 */ }
    process.stdout.write(`${out[0]}\n${out[1]}\n`);
  ' "$DATA_DIR/config.json" 2>/dev/null)
  if [[ "$HOST_SET" != true && -n "${PREVIOUS_ENDPOINT[0]:-}" ]]; then
    HOST="${PREVIOUS_ENDPOINT[0]}"
  fi
  if [[ "$PORT_SET" != true && -n "${PREVIOUS_ENDPOINT[1]:-}" ]]; then
    PORT="${PREVIOUS_ENDPOINT[1]}"
  fi
  [[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || {
    printf 'Port from config.json must be an integer from 1 to 65535, got: %s\n' "$PORT" >&2
    exit 2
  }
  [[ "$HOST" != *[[:space:]%\"]* ]] || {
    printf 'Listen address must not contain whitespace, %% or quotes: %s\n' "$HOST" >&2
    exit 2
  }
  [[ "$HOST_SET" == true && "$PORT_SET" == true ]] \
    || printf 'Reusing the recorded listen endpoint %s:%s (pass --host/--port to change it)\n' "$HOST" "$PORT"
fi

# 部署目标与 .deployment.json 记录的一致性强校验（改进方案 C7/#3）：install-dir/data/
# service/repository/branch 与记录不符时，在部署真正开始前拒绝退出 —— 此处 ERR trap
# 尚未挂载，拒绝即"部署未开始"：服务未停、未 rsync、.deploy-in-progress 未落，不需要
# 也不会走回滚。host/port 的真相源是 config.json（上方沿用逻辑保证不覆盖现值），与记录
# 不一致仅提示漂移不拒绝，否则"控制台改监听地址后自动更新"会被误拒。
# 调用点放在"沿用端点"之后：这样 --host/--port 传的是本次真正会用的值，漂移提示才有意义
# （2026-09-30 审查：放在沿用之前会拿默认值误报漂移，或干脆不传导致提示成死分支）。
VERIFY_ARGS=(--install-dir "$INSTALL_DIR" --data-dir "$DATA_DIR" --service "$SERVICE"
  --host "$HOST" --port "$PORT" --source-root "$ROOT")
[[ -n "$DEPLOY_REPOSITORY" ]] && VERIFY_ARGS+=(--repository "$DEPLOY_REPOSITORY")
[[ -n "$DEPLOY_BRANCH" ]] && VERIFY_ARGS+=(--branch "$DEPLOY_BRANCH")
[[ "$ALLOW_PATH_CHANGE" == true ]] && VERIFY_ARGS+=(--allow-path-change)
if ! "$NODE_BIN" "$ROOT/scripts/verify-deployment-target.mjs" "${VERIFY_ARGS[@]}"; then
  exit 2
fi

for required in package.json package-lock.json src/server.js src/auto-update.js scripts/auto-update.mjs scripts/configure-linux.mjs scripts/install-service.mjs scripts/manage.mjs manage.sh; do
  [[ -f "$ROOT/$required" ]] || {
    printf 'Source repository is incomplete: missing %s\n' "$required" >&2
    exit 1
  }
done
"$NODE_BIN" --check "$ROOT/src/server.js"
"$NODE_BIN" --check "$ROOT/scripts/configure-linux.mjs"
"$NODE_BIN" --check "$ROOT/scripts/install-service.mjs"
bash -n "$ROOT/manage.sh"

RSYNC_PRESERVE=(
  --exclude=/.git/
  --exclude=/.runtime/
  --exclude=/.deployment.json
  --exclude=/.deployment-node
  --exclude=/.dbg/
  --exclude='/debug-*.md'
  --exclude=/.env
  --exclude='/.env.*'
  --exclude='*.log'
  # 更新器跑测试时会在 checkout 根建这两个目录（runner 会在 rsync 前删掉，这里再兜一层：
  # rsync 是 `-a --delete` 从 checkout 根同步的，根目录多什么就会被部署什么）
  --exclude='/.auto-update-test-*/'
  # Docker 全栈是另一种部署方式，不是 systemd 安装树的一部分。不铺进安装目录，
  # 既是避免用户误跑 root docker-compose，也是保护安装目录里用户自己的同名文件
  #（排除规则同时挡住 rsync --delete）。
  --exclude=/docker-compose.yml
  --exclude='/docker-compose.*.yml'
  --exclude=/Dockerfile
  --exclude=/.dockerignore
  --exclude=/docker/
  --exclude='/scripts/docker-*.mjs'
  --exclude='/scripts/docker-*.sh'
)
# 用**规范化**后的路径算相对路径：原始写法带 `/./`、`/x/../`、尾斜杠或符号链接时，
# 字符串前缀比较会失败 → 排除规则匹配不到真实目录 → `rsync --delete` 把数据删掉
#（2026-10-19 复审 P1）。DATA_CANON/INSTALL_CANON 在上面的路径守卫里已算好。
#
# 原始条目单独保护：数据目录可能是安装目录里指向别处的**符号链接**（数据盘独立），
# 此时 DATA_CANON 落在安装目录之外，下面的 canonical 分支保护不到这个链接本身。
# 规则**不能带尾斜杠**：rsync 的 `dir/` 只匹配目录，符号链接在删扫时按普通文件分类，
# 带斜杠的规则匹配不到它（2026-10-19 复核实测语义）。同时排除条目与内容。
# rsync 的 exclude 是模式语言：数据目录名里出现 * ? [ 时会被当成通配符，
# 例如 data[1] 的规则会匹配 data1/，真正的 data[1]/ 反而没被排除、被 --delete 删掉。
# 路径本身仍然合法，所以这里转义而不是拒绝。
rsync_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\*/\\*}"
  s="${s//\?/\\?}"
  s="${s//\[/\\[}"
  printf '%s' "$s"
}

DATA_REL=""
if [[ "$DATA_CANON" == "$INSTALL_CANON/"* ]]; then
  DATA_REL="${DATA_CANON#"$INSTALL_CANON"/}"
  DATA_REL_ESC="$(rsync_escape "$DATA_REL")"
  RSYNC_PRESERVE+=(--exclude="/$DATA_REL_ESC/")
else
  RSYNC_PRESERVE+=(--exclude=/data/)
fi
# 原始条目单独保护：数据目录可能是安装目录里指向别处的符号链接（数据盘独立），
# 此时 DATA_CANON 落在安装目录之外，上面的 canonical 分支保护不到这个链接本身。
# 规则不能带尾斜杠（rsync 的 `dir/` 只匹配目录，符号链接按普通文件分类）。
DATA_TRIMMED="$DATA_DIR"
while [[ "$DATA_TRIMMED" == */ ]]; do DATA_TRIMMED="${DATA_TRIMMED%/}"; done
# 用 realpath -ms 做**不跟随符号链接**的规范化：它会把 /./、/x/../、重复斜杠和
# 尾斜杠收干净，但保留最后一段（以及路径中间）的链接名字。旧写法只归一化父目录，
# 遇到「父目录本身是符号链接」时后半段原始路径直接落到安装目录之外，保护整段失效。
if command -v realpath >/dev/null 2>&1; then
  DATA_TRIMMED="$(realpath -ms -- "$DATA_TRIMMED")"
else
  DATA_PARENT="$(canon_path "$(dirname -- "$DATA_TRIMMED")")"
  DATA_TRIMMED="${DATA_PARENT%/}/$(basename -- "$DATA_TRIMMED")"
fi
INSTALL_TRIMMED="$(canon_path "$INSTALL_DIR")"
if [[ "$DATA_TRIMMED" == "$INSTALL_TRIMMED/"* ]]; then
  RAW_REL="${DATA_TRIMMED#"$INSTALL_TRIMMED"/}"
  # 祖先里的符号链接也要保护：数据目录 /srv/app/storage/data、storage 是链接时，
  # 只排除最后一段 data 仍然会让 rsync --delete 把 storage 这个链接删掉。
  RAW_PREFIX=""
  IFS='/' read -r -a RAW_PARTS <<< "$RAW_REL"
  for RAW_PART in "${RAW_PARTS[@]}"; do
    [[ -n "$RAW_PART" ]] || continue
    RAW_PREFIX="${RAW_PREFIX:+$RAW_PREFIX/}$RAW_PART"
    if [[ -L "$INSTALL_DIR/$RAW_PREFIX" ]]; then
      RAW_PREFIX_ESC="$(rsync_escape "$RAW_PREFIX")"
      RSYNC_PRESERVE+=(--exclude="/$RAW_PREFIX_ESC" --exclude="/$RAW_PREFIX_ESC/**")
      break
    fi
  done
  if [[ -n "$RAW_REL" && ( -z "$DATA_REL" || "$RAW_REL/" != "$DATA_REL/" ) ]]; then
    RAW_REL_ESC="$(rsync_escape "$RAW_REL")"
    RSYNC_PRESERVE+=(--exclude="/$RAW_REL_ESC" --exclude="/$RAW_REL_ESC/**")
  fi
fi
RSYNC_SOURCE=("${RSYNC_PRESERVE[@]}" --exclude=/node_modules/)

WAS_ACTIVE=false
WAS_ENABLED=false
if systemctl --user is-active --quiet "$SERVICE.service"; then
  WAS_ACTIVE=true
fi
if systemctl --user is-enabled --quiet "$SERVICE.service" 2>/dev/null; then
  WAS_ENABLED=true
fi

ROLLBACK_DIR=""
if [[ "$BACKUP_ENABLED" == true && -f "$INSTALL_DIR/package.json" ]]; then
  BACKUP_ROOT="$DATA_DIR/deploy-backups"
  ROLLBACK_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$ROLLBACK_DIR/app"
  rsync -a "${RSYNC_PRESERVE[@]}" "$INSTALL_DIR/" "$ROLLBACK_DIR/app/"
  printf 'Created rollback snapshot: %s\n' "$ROLLBACK_DIR"
  # 快照上限 3 份在"创建时"就维护，而不是部署成功之后：连续失败的更新每次都会
  # 留一份完整快照（含 node_modules），不在创建时轮转会把数据盘慢慢占满
  # （自动更新无人值守场景）。刚创建的这份最新，必然保留。
  kept=0
  pruned=0
  while IFS= read -r stale; do
    kept=$((kept + 1))
    if ((kept > 3)); then
      rm -rf -- "$stale"
      pruned=$((pruned + 1))
    fi
  done < <(ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null)
  ((pruned == 0)) || printf 'Pruned %s old snapshot(s), keeping the 3 newest\n' "$pruned"
fi

UNIT_FILE="$HOME/.config/systemd/user/$SERVICE.service"
UPDATE_SERVICE="${SERVICE}-update"
UPDATE_UNIT_FILE="$HOME/.config/systemd/user/$UPDATE_SERVICE.service"
UPDATE_TIMER_FILE="$HOME/.config/systemd/user/$UPDATE_SERVICE.timer"
mkdir -p "$LOCK_DIR/state"
HAD_CONFIG=false
HAD_ACCESS_FILE=false
HAD_UNIT=false
HAD_DEPLOYMENT_JSON=false
HAD_DEPLOYMENT_NODE=false
HAD_UPDATE_UNIT=false
HAD_UPDATE_TIMER=false
WAS_UPDATE_TIMER_ENABLED=false
WAS_UPDATE_TIMER_ACTIVE=false
if [[ -f "$DATA_DIR/config.json" ]]; then
  HAD_CONFIG=true
  cp -p "$DATA_DIR/config.json" "$LOCK_DIR/state/config.json"
fi
if [[ -f "$DATA_DIR/console-access.txt" ]]; then
  HAD_ACCESS_FILE=true
  cp -p "$DATA_DIR/console-access.txt" "$LOCK_DIR/state/console-access.txt"
fi
if [[ -f "$UNIT_FILE" ]]; then
  HAD_UNIT=true
  cp -p "$UNIT_FILE" "$LOCK_DIR/state/service.unit"
fi
if [[ -f "$UPDATE_UNIT_FILE" ]]; then
  HAD_UPDATE_UNIT=true
  cp -p "$UPDATE_UNIT_FILE" "$LOCK_DIR/state/update.service"
fi
if [[ -f "$UPDATE_TIMER_FILE" ]]; then
  HAD_UPDATE_TIMER=true
  cp -p "$UPDATE_TIMER_FILE" "$LOCK_DIR/state/update.timer"
fi
if systemctl --user is-enabled --quiet "$UPDATE_SERVICE.timer" 2>/dev/null; then
  WAS_UPDATE_TIMER_ENABLED=true
fi
if systemctl --user is-active --quiet "$UPDATE_SERVICE.timer" 2>/dev/null; then
  WAS_UPDATE_TIMER_ACTIVE=true
fi
if [[ -f "$INSTALL_DIR/.deployment.json" ]]; then
  HAD_DEPLOYMENT_JSON=true
  cp -p "$INSTALL_DIR/.deployment.json" "$LOCK_DIR/state/deployment.json"
fi
if [[ -f "$INSTALL_DIR/.deployment-node" ]]; then
  HAD_DEPLOYMENT_NODE=true
  cp -p "$INSTALL_DIR/.deployment-node" "$LOCK_DIR/state/deployment-node"
fi

# 部署进行中标记：停服务 → rsync --delete → npm ci → 起服务 → 健康检查这段窗口里，
# 一旦被 SIGKILL/OOM/掉电打断，trap 不会执行 —— 服务停着、代码可能是半拷贝的，
# 而下次开机 systemd 会把半更新的树当成正常代码拉起来（比崩掉更难查）。
# 标记落在数据目录（安装目录之外，rsync 不会碰它），应用启动时会读它并告警。
IN_PROGRESS_MARKER="$DATA_DIR/.deploy-in-progress"
mark_deploy_in_progress() {
  (
    umask 077
    printf '{"pid":%s,"startedAt":"%s","installDir":"%s","dataDir":"%s","service":"%s","snapshot":"%s"}\n' \
      "$$" "$(date -Is 2>/dev/null || date)" "$INSTALL_DIR" "$DATA_DIR" "$SERVICE" "${ROLLBACK_DIR:-}" \
      > "$IN_PROGRESS_MARKER"
  ) 2>/dev/null || true
}
clear_deploy_marker() {
  rm -f -- "$IN_PROGRESS_MARKER" 2>/dev/null || true
}

rollback_deployment() {
  local status=$?
  # 显式调用点（npm 缺失、健康检查失败）是在 printf 之后进来的，此时 $? 已经是 0；
  # 那种情况必须按失败退出，否则调用方（自动更新按退出码判定）会把回滚过的部署当成成功。
  ((status != 0)) || status=1
  trap - ERR INT TERM HUP
  set +e
  ROLLBACK_FAILED=false
  # 注意：清标记必须放在**恢复动作之后**（原来放在这里）：
  # 恢复过程中再失败（磁盘满正是常见原因）或被 SIGKILL 时，标记已经没了，
  # 机器停在"半新半旧"却不再报 deploy-interrupted（2026-10-13 全项目审查）。
  printf '\nDeployment failed; restoring the previous installation...\n' >&2
  systemctl --user stop "$SERVICE.service" >/dev/null 2>&1
  systemctl --user disable --now "$UPDATE_SERVICE.timer" >/dev/null 2>&1
  if [[ -n "$ROLLBACK_DIR" && -d "$ROLLBACK_DIR/app" ]]; then
    rsync -a --delete "${RSYNC_PRESERVE[@]}" "$ROLLBACK_DIR/app/" "$INSTALL_DIR/" || ROLLBACK_FAILED=true
  fi
  if [[ "$HAD_CONFIG" == true ]]; then
    cp -p "$LOCK_DIR/state/config.json" "$DATA_DIR/config.json" || ROLLBACK_FAILED=true
  else
    rm -f -- "$DATA_DIR/config.json"
  fi
  if [[ "$HAD_ACCESS_FILE" == true ]]; then
    cp -p "$LOCK_DIR/state/console-access.txt" "$DATA_DIR/console-access.txt" || ROLLBACK_FAILED=true
  else
    rm -f -- "$DATA_DIR/console-access.txt"
  fi
  if [[ "$HAD_UNIT" == true ]]; then
    mkdir -p "$(dirname "$UNIT_FILE")"
    cp -p "$LOCK_DIR/state/service.unit" "$UNIT_FILE" || ROLLBACK_FAILED=true
  else
    rm -f -- "$UNIT_FILE"
  fi
  if [[ "$HAD_UPDATE_UNIT" == true ]]; then
    cp -p "$LOCK_DIR/state/update.service" "$UPDATE_UNIT_FILE" || ROLLBACK_FAILED=true
  else
    rm -f -- "$UPDATE_UNIT_FILE"
  fi
  if [[ "$HAD_UPDATE_TIMER" == true ]]; then
    cp -p "$LOCK_DIR/state/update.timer" "$UPDATE_TIMER_FILE" || ROLLBACK_FAILED=true
  else
    rm -f -- "$UPDATE_TIMER_FILE"
  fi
  if [[ "$HAD_DEPLOYMENT_JSON" == true ]]; then
    cp -p "$LOCK_DIR/state/deployment.json" "$INSTALL_DIR/.deployment.json" || ROLLBACK_FAILED=true
  else
    rm -f -- "$INSTALL_DIR/.deployment.json"
  fi
  if [[ "$HAD_DEPLOYMENT_NODE" == true ]]; then
    cp -p "$LOCK_DIR/state/deployment-node" "$INSTALL_DIR/.deployment-node" || ROLLBACK_FAILED=true
  else
    rm -f -- "$INSTALL_DIR/.deployment-node"
  fi
  systemctl --user daemon-reload
  if [[ "$WAS_UPDATE_TIMER_ENABLED" == true ]]; then
    # 只恢复开机自启；原来 enabled 但被手动 stop 的，不要用 --now 擅自启动。
    systemctl --user enable "$UPDATE_SERVICE.timer" >/dev/null 2>&1
  fi
  if [[ "$WAS_UPDATE_TIMER_ACTIVE" == true ]]; then
    systemctl --user start "$UPDATE_SERVICE.timer" >/dev/null 2>&1
  fi
  if [[ "$WAS_ACTIVE" == true ]]; then
    if [[ "$ROLLBACK_FAILED" != true ]]; then
      if ! systemctl --user start "$SERVICE.service"; then
        ROLLBACK_FAILED=true
      else
        # Type=simple 的 start 只代表 fork/exec 成功；等两秒再确认进程没立刻退出。
        sleep 2
        systemctl --user is-active --quiet "$SERVICE.service" || ROLLBACK_FAILED=true
      fi
    fi
  elif [[ "$WAS_ENABLED" == true ]]; then
    # 原来是 enabled 但被手动 stop：回滚只恢复开机自启，不擅自启动。
    systemctl --user enable "$SERVICE.service" >/dev/null 2>&1
  else
    systemctl --user disable --now "$SERVICE.service" >/dev/null 2>&1
  fi
  if [[ "$ROLLBACK_FAILED" == true ]]; then
    # EXIT trap 会删掉整个 .deploy.lock（含 state/ 里的部署前 config/unit 备份）。
    # 回滚失败时先把它们复制到数据目录外的恢复目录，否则提示里的“手动恢复”没有材料。
    if [[ -d "$LOCK_DIR/state" ]]; then
      RECOVERY_STATE_DIR="$DATA_DIR/deploy-recovery-$(date +%Y%m%dT%H%M%S)"
      if mkdir -p "$RECOVERY_STATE_DIR" && cp -a "$LOCK_DIR/state/." "$RECOVERY_STATE_DIR/"; then
        printf 'Pre-deploy config/unit backups kept at %s\n' "$RECOVERY_STATE_DIR" >&2
      else
        printf 'Could not copy pre-deploy state to %s; check disk/permissions.\n' "$RECOVERY_STATE_DIR" >&2
      fi
    fi
    printf 'Rollback incomplete: keeping %s for manual recovery. Do not start the old service blindly.\n' "$IN_PROGRESS_MARKER" >&2
    exit "$status"
  fi
  # 恢复与重启都做完，才算这次部署收尾
  clear_deploy_marker
  exit "$status"
}
trap rollback_deployment ERR INT TERM HUP

# 从这里到健康检查通过是"服务可能停着、代码可能半拷贝"的窗口：先落标记。
# 即使服务原本是 stopped，也必须标记：SIGKILL/掉电后下一次启动要能发现半更新。
mark_deploy_in_progress
if [[ "$WAS_ACTIVE" == true ]]; then
  systemctl --user stop "$SERVICE.service"
fi
if [[ "$ROOT" != "$INSTALL_DIR" ]]; then
  rsync -a --delete "${RSYNC_SOURCE[@]}" "$ROOT/" "$INSTALL_DIR/"
fi

cd "$INSTALL_DIR"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[[ -x "$NPM_BIN" ]] || NPM_BIN="$(command -v npm || true)"
[[ -n "$NPM_BIN" && -x "$NPM_BIN" ]] || { printf 'npm is required\n' >&2; rollback_deployment; exit 1; }
"$NPM_BIN" ci --omit=dev --ignore-scripts

# Do not silently choose another port on a server.
"$NODE_BIN" --input-type=module -e '
import net from "node:net";
const s=net.createServer(); s.on("error",e=>{console.error(e.message);process.exit(1)});
s.listen(Number(process.argv[1]), process.argv[2], ()=>s.close());
' "$PORT" "$HOST"
ARGS=(--data-dir "$DATA_DIR" --host "$HOST" --port "$PORT")
[[ -z "$IMPORT_BRIDGE" ]] || ARGS+=(--import-bridge "$IMPORT_BRIDGE")
[[ -z "$CREDENTIAL_FILE" ]] || ARGS+=(--credential-file "$CREDENTIAL_FILE")
"$NODE_BIN" scripts/configure-linux.mjs "${ARGS[@]}"
export QQ_INSTALL_DIR="$INSTALL_DIR" QQ_DATA_DIR="$DATA_DIR" QQ_NODE="$NODE_BIN" QQ_SERVICE="$SERVICE" QQ_HOST="$HOST" QQ_PORT="$PORT"
"$NODE_BIN" scripts/install-service.mjs
systemd-analyze --user verify "$HOME/.config/systemd/user/$SERVICE.service"
systemd-analyze --user verify "$UPDATE_UNIT_FILE"
systemd-analyze --user verify "$UPDATE_TIMER_FILE"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE.service"
systemctl --user enable --now "$UPDATE_SERVICE.timer"
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != yes ]]; then
  # Issue #15：unit 带 NoNewPrivileges（docs/BAOTA.md 推荐的加固）时，重启后由
  # systemd 拉起的进程跑不了 sudo，这一步曾让整个更新回滚。linger 同时决定两件事：
  # 会话结束后用户管理器是否存活（没开的话，本登录会话一断，logind 就连同服务一起停掉）
  # 和开机是否自动拉起——后果比"不自启"大，但这一步仍不该一票否决本次部署：预检 + 尽力
  # 而为，失败只警告（2026-10-12 修正文案：原说法只提了"下次开机不会自启"）。
  if grep -q 'NoNewPrivs:[[:space:]]*1' /proc/self/status 2>/dev/null; then
    printf '警告：服务被 NoNewPrivileges 加固，无法代为开启 linger；本次部署不受影响，但当前登录会话一断开，systemd 就会连同用户管理器一起停掉服务（机器人掉线），服务下次开机也不会自启。\n请在服务账号的交互终端执行一次：sudo loginctl enable-linger %s（执行后立即生效，之后退出终端服务不受影响）\n' "$USER" >&2
  elif ! sudo -n loginctl enable-linger "$USER" 2>/dev/null; then
    printf '警告：启用 linger 失败（sudo 不可用或被拒绝）；本次部署不受影响，但当前登录会话一断开，systemd 就会连同用户管理器一起停掉服务（机器人掉线），服务下次开机也不会自启。\n请在服务账号的交互终端执行一次：sudo loginctl enable-linger %s（执行后立即生效，之后退出终端服务不受影响）\n' "$USER" >&2
  fi
fi
# 健康检查要拼 URL，IPv6 字面量必须加方括号（http://::1:3210 不是合法 URL，fetch 会直接 reject，
# 于是 90 次探测全失败 → 回滚 → "这类机器每次更新都回滚"）。'::1' 是配置层明确支持的监听地址，
# 别的 IPv6 字面量同理；只有已带方括号的才原样用。
case "$HOST" in
  0.0.0.0) HEALTH_HOST=127.0.0.1 ;;
  ::|\[::\]) HEALTH_HOST='[::1]' ;;
  \[*\]) HEALTH_HOST="$HOST" ;;
  *:*) HEALTH_HOST="[$HOST]" ;;
  *) HEALTH_HOST="$HOST" ;;
esac
HEALTHY=false
# 90 秒窗口：慢机器冷启动（大库迁移、慢磁盘）可能超过旧版 50×0.2s≈10-20 秒，
# 被误判失败会触发回滚，形成"每次更新都回滚"的怪圈；deploy-all 对同服务给的是
# 30-90 秒，这里对齐同一量级。
HEALTH_DEADLINE=$((SECONDS + 90))
for _ in {1..90}; do
  # 单次 fetch 必须有硬超时：服务接受连接但不响应时，undici 默认可能拖几百秒，
  # 90 次循环就不再是 90 秒窗口，更新 unit 会先被杀掉、回滚也跑不到。
  if "$NODE_BIN" -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
      "http://$HEALTH_HOST:$PORT/healthz"; then
    HEALTHY=true
    break
  fi
  (( SECONDS < HEALTH_DEADLINE )) || break
  sleep 1
done
[[ "$HEALTHY" == true ]] || { printf 'Service health check failed\n' >&2; rollback_deployment; exit 1; }
trap - ERR INT TERM HUP
clear_deploy_marker
# 每份快照是整个安装目录（含 node_modules），而自动更新会无人值守地反复部署：
# 不清理会把数据盘慢慢填满。保留最近的 3 份。
if [[ "${QQ_AGENT_SOURCE_REVISION:-}" =~ ^[0-9a-f]{40}$ ]]; then
  REVISION="$QQ_AGENT_SOURCE_REVISION"
elif command -v git >/dev/null && git -C "$ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
  REVISION="$(git -C "$ROOT" rev-parse HEAD)"
  if ! git -C "$ROOT" diff --quiet --ignore-submodules HEAD --; then
    REVISION="${REVISION}-dirty"
  fi
else
  REVISION="source-$(date -u +%Y%m%dT%H%M%SZ)"
fi
# 以下都是"部署已成功（健康检查通过）之后的收尾"：任何一步失败都不该把退出码变成非 0 ——
# 更新器按退出码判定成败，尾部失败会被记成"部署失败"并触发 disableOnFailure 自停 + 告警，
# 而实际服务已经跑在新版本上（2026-10-07 复审 P3）。全部尽力而为。
if printf '%s\n' "$REVISION" > "$DATA_DIR/deployed-revision" 2>/dev/null; then
  chmod 600 "$DATA_DIR/deployed-revision" 2>/dev/null || true
else
  printf 'Warning: could not record deployed revision in %s\n' "$DATA_DIR/deployed-revision" >&2
fi
# 自动更新驱动（QQ_AGENT_SOURCE_REVISION 有值）且按控制台设置换了仓库/分支时，把安装记录
# 对齐到实际来源 —— 否则下次校验仍按旧记录判"不一致"（见 verify-deployment-target.mjs）。
if [[ -n "${QQ_AGENT_SOURCE_REVISION:-}" && -f "$INSTALL_DIR/.deployment.json" && ( -n "${QQ_AGENT_REPOSITORY:-}" || -n "${QQ_AGENT_BRANCH:-}" ) ]]; then
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, repository, branch] = process.argv.slice(1);
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    if (repository) meta.repository = repository;
    if (branch) meta.branch = branch;
    fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  ' "$INSTALL_DIR/.deployment.json" "${QQ_AGENT_REPOSITORY:-}" "${QQ_AGENT_BRANCH:-}" || printf 'Warning: could not sync .deployment.json source record\n' >&2
  chmod 600 "$INSTALL_DIR/.deployment.json" 2>/dev/null || true
fi
systemctl --user --no-pager status "$SERVICE.service" || true
MODE="$("$NODE_BIN" -e 'const c=require(process.argv[1]);process.stdout.write(c.runtime.mode)' "$DATA_DIR/config.json" 2>/dev/null)" || MODE="unknown"
# ── docker 组自愈：控制台的「更新协议端」按钮靠服务进程直连 /var/run/docker.sock ──────────
# 背景（Issue #30）：服务进程的补充组在 user manager 启动那一刻冻结；而标准部署从不碰
# docker 组成员关系 —— 那个按钮从第一天起就会报 permission denied。收尾做两件事（幂等、尽力而为）：
#   ① 把部署用户加进 docker 组（getent / usermod 是 systemd 家族各发行版 —— Ubuntu/Debian/
#      CentOS/Fedora/Arch —— 的通用件；没有 docker 组的环境静默跳过）；
#   ② user manager 若还带着旧组快照就重建它（重建后 linger 自动拉起服务，新进程带上新组）。
# ⚠️ 重建必须 stop → sleep 3 → start，**不能用 systemctl restart**：2026-10-09 实测（systemd 249）
#    用 restart 时新管理器会因旧实例 cgroup 未回收而以 status=219/CGROUP 启动失败，且失败后
#    不会自动回来（服务停摆到人工 start）；停、留回收间隔、再单独起，是实测可靠的姿势。
#    脚本自身不受影响：ssh 会话在独立的 session scope（实测 cgroup 为 session-*.scope），
#    重建只动 user@.service 的 cgroup。
# ⚠️ 自动更新（QQ_AGENT_SOURCE_REVISION 有值）场景**跳过重建**：无人值守时不做停服动作，
#    只加组（等下次交互部署或机器重启时自然生效）。
# ⚠️ 下面几处 sudo 一律带 `-n`（非交互）：这些调用的 stdout/stderr 都被丢弃了，一旦 sudo 要
#    密码，提示会被吞掉、部署看起来像卡死（用户只能盲输或 Ctrl+C）。`-n` 让它立刻失败并走
#    "手工执行"那句提示 —— 与运行时 `sudo -n docker` 是同一纪律（2026-10-09 复核）。
# ⚠️ 代价须知：把账号加进 docker 组等于给它 root 等价权限（docker 组可以挂载宿主文件系统）。
#    这条自愈是「控制台里更新协议端」这个功能的前提，但它也把"控制台被拿下"的后果从应用级
#    抬到了宿主 root —— 权衡见 docs/LINUX.md（2026-10-09 复核）。
if getent group docker >/dev/null 2>&1; then
  # 收尾段仍在 set -e 之下：每个可能失败的赋值都要自带保护，否则会把退出码弄坏
  DOCKER_GID="$(getent group docker 2>/dev/null | cut -d: -f3 || true)"
  if [[ -n "$DOCKER_GID" ]]; then
    DOCKER_MEMBER=false
    if id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker; then
      DOCKER_MEMBER=true
    elif [[ "${QQ_AGENT_ALLOW_DOCKER_GROUP:-}" == "1" ]]; then
      # 显式 opt-in：docker 组等于 root 等价权限，不能默认替用户加。
      if sudo -n usermod -aG docker "$(id -un)" >/dev/null 2>&1; then
        DOCKER_MEMBER=true
        printf '已把 %s 加入 docker 组（控制台「更新协议端」需要；可用 QQ_AGENT_ALLOW_DOCKER_GROUP=0 关闭）\n' "$(id -un)"
      else
        printf '警告：把自己加入 docker 组失败；控制台「更新协议端」会报权限不足（可手工执行：sudo usermod -aG docker %s）\n' "$(id -un)" >&2
      fi
    else
      printf '跳过 docker 组自动加入（需要显式设置 QQ_AGENT_ALLOW_DOCKER_GROUP=1；控制台「更新协议端」可能报权限不足）\n'
    fi
    if [[ "$DOCKER_MEMBER" == true && -z "${QQ_AGENT_SOURCE_REVISION:-}" ]]; then
      MANAGER_UNIT="user@$(id -u).service"
      SVC_PID="$(systemctl --user show "$SERVICE.service" -p MainPID --value 2>/dev/null || true)"
      SVC_GROUPS=""
      if [[ "$SVC_PID" =~ ^[0-9]+$ && -r "/proc/$SVC_PID/status" ]]; then
        SVC_GROUPS=" $(grep '^Groups:' "/proc/$SVC_PID/status" 2>/dev/null | cut -d: -f2 | tr '\t' ' ' || true) "
      fi
      if [[ -n "$SVC_GROUPS" && "$SVC_GROUPS" != *" $DOCKER_GID "* ]]; then
        printf '重建 user manager 让 docker 组生效（服务会停约 10 秒后自动恢复）……\n'
        if sudo -n systemctl stop "$MANAGER_UNIT" 2>/dev/null; then
          sleep 3
          if ! sudo -n systemctl start "$MANAGER_UNIT" 2>/dev/null; then
            # ⚠️ 重试前必须再等一次：这次失败通常正是 219/CGROUP（旧实例 cgroup 还没回收完），
            # 紧接着重试会撞同一个竞态、白试一次。多留 3 秒，重试才有意义（2026-10-09 复核）。
            sleep 3
            sudo -n systemctl start "$MANAGER_UNIT" 2>/dev/null \
              || printf '警告：user manager 没能启动；请执行：sudo systemctl start %s\n' "$MANAGER_UNIT" >&2
          fi
          for _ in {1..10}; do
            systemctl --user is-active --quiet "$SERVICE.service" 2>/dev/null && break
            sleep 1
          done
          if systemctl --user is-active --quiet "$SERVICE.service" 2>/dev/null; then
            printf '服务已随新管理器恢复（docker 组已生效，控制台可用）\n'
          else
            printf '服务未能随新管理器恢复：%s。部署按失败处理，请检查：sudo systemctl start %s\n' \
              "$SERVICE.service" "$MANAGER_UNIT" >&2
            exit 1
          fi
        else
          printf '警告：停 user manager 失败；请手工执行：sudo systemctl stop %s && sleep 3 && sudo systemctl start %s\n' "$MANAGER_UNIT" "$MANAGER_UNIT" >&2
        fi
      fi
    fi
  fi
fi
printf '\nConsole: http://%s:%s (%s mode)\nToken: %s/manage.sh token\n' "$HEALTH_HOST" "$PORT" "$MODE" "$INSTALL_DIR"
[[ -z "$ROLLBACK_DIR" ]] || printf 'Rollback snapshot: %s\n' "$ROLLBACK_DIR"
