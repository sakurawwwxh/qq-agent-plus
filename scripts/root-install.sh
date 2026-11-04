#!/usr/bin/env bash
# root 安装包装层：install.sh 检测到 root 时进入这里。
#
# 为什么不让机器人直接跑 root：
#   - 模型输出、插件、依赖漏洞任何一处被利用，root 进程等于整台服务器失守；
#   - systemd 用户服务、数据目录、控制台令牌都不该由 root 拥有。
#
# 这里只做 root 才能做的准备：
#   1) 创建/复用一个普通服务用户（默认 qqagent，或沿用现有安装的属主 / SUDO_USER）；
#   2) 安装 Docker、按显式 opt-in 把服务用户加入 docker 组、开启 linger；
#   3) 把部署根目录与源码副本交给服务用户；
#   4) 以服务用户重新执行 install.sh，真正的部署与运行都不再是 root。
#
# 源码副本放在 <root-dir>/src：root 常常在 /root 下 clone，服务用户读不到；
# 复制一份也避免 rsync --delete 动到用户的仓库。
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
ROOT_DIR="${QQ_AGENT_STACK_DIR:-/mnt/data/qq-agent}"
CHECK_ONLY=false
PASSTHRU=()

info() { printf '%s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }
die() { printf '\n[root 安装] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
由 install.sh 在 root 下自动调用，不建议手工执行。

它会把服务落到一个普通用户（默认 qqagent），机器人本身不以 root 运行。
EOF
}

while (($#)); do
  case "$1" in
    --root-dir)
      (($# >= 2)) || die '--root-dir 需要一个路径'
      ROOT_DIR="$2"
      PASSTHRU+=("$1" "$2")
      shift 2
      ;;
    --root-dir=*)
      ROOT_DIR="${1#*=}"
      # deploy-all.sh 只认分离写法；统一成 --root-dir PATH 再透传，
      # 否则 root 路径会在改完用户/Docker/linger 之后才报“未知参数”。
      PASSTHRU+=("--root-dir" "$ROOT_DIR")
      shift
      ;;
    --check-only)
      CHECK_ONLY=true
      PASSTHRU+=("$1")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      PASSTHRU+=("$1")
      shift
      ;;
  esac
done

[[ "$ROOT_DIR" == /* ]] || die "部署根目录必须是绝对路径：$ROOT_DIR"
[[ "$ROOT_DIR" != *[[:space:]%\"]* ]] || die "部署根目录不能包含空格、% 或引号：$ROOT_DIR"
case "$ROOT_DIR" in
  *'$'*|*'`'*|*'\'*) die "部署根目录不能包含 \$、反引号或反斜杠：$ROOT_DIR" ;;
esac
command -v realpath >/dev/null 2>&1 \
  || die '缺少 realpath（coreutils）；无法安全规范化部署根目录'
ROOT_DIR="$(realpath -m -- "$ROOT_DIR")"
SOURCE_DIR="$(realpath -m -- "$SOURCE_DIR")"

# 共享系统目录绝不能整体 chown/chmod；默认安装目录 /mnt/data/qq-agent 不受影响，
# 但 /mnt、/opt、/home 这类父目录会被拒绝。
case "$ROOT_DIR" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
    die "部署根目录不能是共享系统目录：$ROOT_DIR（请用例如 /mnt/data/qq-agent）"
    ;;
esac
[[ -f "$SOURCE_DIR/install.sh" && -f "$SOURCE_DIR/deploy-all.sh" ]] \
  || die "源码目录不完整：$SOURCE_DIR（需要 install.sh 与 deploy-all.sh）"

# 源码不能在部署根目录里（否则 chown/chmod/rsync 会动到你的 checkout），
# 也不能把部署根目录放进源码里。$ROOT_DIR/src 是安装器自己的副本，允许复用。
SRC_DIR="$ROOT_DIR/src"
case "$SOURCE_DIR/" in
  "$ROOT_DIR/"*)
    [[ "$SOURCE_DIR" == "$SRC_DIR" ]] \
      || die "源码不能放在部署根目录里：$SOURCE_DIR（请把仓库 clone 到别处）"
    ;;
esac
case "$ROOT_DIR/" in
  "$SOURCE_DIR/"*) die "部署根目录不能放在源码目录里：$ROOT_DIR" ;;
esac
case "$SOURCE_DIR/" in
  "$SRC_DIR/"*) die "源码不能放在安装器副本目录里：$SOURCE_DIR" ;;
esac

# 测试/预览入口：只打印计划，不做任何系统改动。正式路径必须真的是 root。
TEST_MODE="${QQ_AGENT_ROOT_INSTALL_TEST:-}"
if [[ "$(id -u)" != "0" && "$TEST_MODE" != "1" ]]; then
  die '这个脚本只应由 root 下的 install.sh 调用；普通用户请直接运行 bash install.sh'
fi

# ── 选服务用户 ──────────────────────────────────────────────────────────────
# 优先级：显式 QQ_AGENT_SERVICE_USER > 现有安装的属主 > SUDO_USER > qqagent。
# 现有安装的属主优先，避免更新时把数据目录整体改属主、把正在跑的服务弄坏。
SERVICE_USER="${QQ_AGENT_SERVICE_USER:-}"
SERVICE_USER_EXPLICIT=false
[[ -n "$SERVICE_USER" ]] && SERVICE_USER_EXPLICIT=true

if [[ "$SERVICE_USER_EXPLICIT" != true && -f "$ROOT_DIR/app/.deployment.json" ]]; then
  OWNER="$(stat -c '%U' "$ROOT_DIR/app" 2>/dev/null || true)"
  if [[ "$OWNER" == "root" ]]; then
    die "检测到既有安装属于 root：$ROOT_DIR/app。请先按 docs/LINUX.md 迁移到一个普通用户，或手工指定 QQ_AGENT_SERVICE_USER。"
  fi
  [[ -n "$OWNER" ]] && SERVICE_USER="$OWNER"
fi

if [[ -z "$SERVICE_USER" && -d "$ROOT_DIR" ]]; then
  OWNER="$(stat -c '%U' "$ROOT_DIR" 2>/dev/null || true)"
  [[ -n "$OWNER" && "$OWNER" != "root" ]] && SERVICE_USER="$OWNER"
fi

if [[ -z "$SERVICE_USER" && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  SERVICE_USER="$SUDO_USER"
fi

SERVICE_USER="${SERVICE_USER:-qqagent}"
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || die "服务用户名不合法：$SERVICE_USER（只允许小写字母、数字、_、-）"
[[ "$SERVICE_USER" != "root" ]] || die '服务用户不能是 root'

print_plan() {
  cat <<EOF
== root 安装准备 ==
服务用户：$SERVICE_USER（机器人将以它运行，不是 root）
部署目录：$ROOT_DIR
源码副本：$SRC_DIR
将执行：
  1. 创建/复用用户 $SERVICE_USER，并确保有可登录 shell 与 home
  2. 安装/检查 Docker；默认只在本次安装子进程临时授予 docker 组（不永久加组），
     QQ_AGENT_ALLOW_DOCKER_GROUP=1 才把 $SERVICE_USER 永久加入 docker 组
  3. loginctl enable-linger $SERVICE_USER，保证退出 SSH 后服务仍在
  4. 复制源码到 $SRC_DIR，属主交给 $SERVICE_USER
  5. 以 $SERVICE_USER 执行 install.sh（真正的部署）
EOF
}

# 测试模式：只打印计划，绝不创建用户或改系统。
if [[ "$TEST_MODE" == "1" ]]; then
  print_plan
  exit 0
fi

if [[ "$CHECK_ONLY" == true ]]; then
  print_plan
  echo
  echo '== 只读预检 =='
  command -v bash >/dev/null && echo "  OK bash: $(bash --version | head -n1)" || warn '缺少 bash'
  command -v curl >/dev/null && echo '  OK curl' || warn '缺少 curl（安装器会尝试安装）'
  command -v tar >/dev/null && echo '  OK tar' || warn '缺少 tar（安装器会尝试安装）'
  command -v sha256sum >/dev/null && echo '  OK sha256sum' || warn '缺少 sha256sum（安装器会尝试安装）'
  command -v rsync >/dev/null && echo '  OK rsync' || warn '缺少 rsync（安装器会尝试安装）'
  command -v realpath >/dev/null && echo '  OK realpath' || warn '缺少 realpath（安装器会尝试安装）'
  command -v ss >/dev/null && echo '  OK ss' || warn '缺少 ss/iproute2（安装器会尝试安装）'
  command -v xz >/dev/null && echo '  OK xz' || warn '缺少 xz（安装器会尝试安装）'
  command -v loginctl >/dev/null && echo '  OK loginctl' || warn '缺少 loginctl（systemd 用户服务需要）'
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    echo '  OK Docker 已运行'
    docker compose version >/dev/null 2>&1 && echo '  OK Docker Compose' || warn '缺少 Docker Compose 插件'
  else
    warn 'Docker 未运行；正式安装会尝试安装并启动'
  fi
  if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
    echo "  OK 服务用户已存在：$SERVICE_USER"
  else
    echo "  将创建服务用户：$SERVICE_USER"
  fi
  if [[ -f /proc/meminfo ]]; then
    MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    (( MEM_KB >= 1800000 )) || warn "内存约 $((MEM_KB / 1024))MB，低于建议的 2GB；SnowLuma/Chromium 可能 OOM"
  fi
  echo
  echo '（--check-only：只做了 root 包装层预检，没有创建用户、没有安装任何东西。）'
  exit 0
fi

# ── 服务用户 ────────────────────────────────────────────────────────────────
if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  command -v useradd >/dev/null 2>&1 \
    || die '缺少 useradd；请先安装 shadow-utils/passwd，或手工创建用户后设置 QQ_AGENT_SERVICE_USER'
  info "创建服务用户：$SERVICE_USER"
  useradd --create-home --shell /bin/bash "$SERVICE_USER" \
    || die "创建用户失败：$SERVICE_USER"
fi

IFS=: read -r _ _ SERVICE_UID SERVICE_GID _ HOME_DIR SERVICE_SHELL <<<"$(getent passwd "$SERVICE_USER")"
[[ -n "$SERVICE_UID" && -n "$SERVICE_GID" ]] || die "无法读取用户信息：$SERVICE_USER"
# UID/GID 0 的别名账号也是 root；不拦住会让内层 install.sh 再次进入 root-install。
[[ "$SERVICE_UID" != "0" && "$SERVICE_GID" != "0" ]] \
  || die "服务用户不能是 UID/GID 0（$SERVICE_USER 实际是 root）"

SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
if [[ -z "$HOME_DIR" || "$HOME_DIR" == "/nonexistent" ]]; then
  HOME_DIR="/home/$SERVICE_USER"
  mkdir -p "$HOME_DIR"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$HOME_DIR"
  usermod -d "$HOME_DIR" "$SERVICE_USER" || die "无法设置用户 home：$SERVICE_USER"
fi
if [[ ! -x "${SERVICE_SHELL:-}" ]]; then
  usermod -s /bin/bash "$SERVICE_USER" || die "无法设置用户 shell：$SERVICE_USER"
  SERVICE_SHELL=/bin/bash
fi

# ── 基础命令 ────────────────────────────────────────────────────────────────
install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "$@"
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install -y "$@"
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm "$@"
  else
    return 1
  fi
}

package_for() {
  case "$1" in
    sha256sum|realpath) printf 'coreutils' ;;
    ss) printf 'iproute2' ;;
    xz)
      if command -v apt-get >/dev/null 2>&1; then printf 'xz-utils'; else printf 'xz'; fi
      ;;
    *) printf '%s' "$1" ;;
  esac
}

MISSING=()
PACKAGES=()
for cmd in curl tar sha256sum rsync realpath ss xz git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    MISSING+=("$cmd")
    PACKAGES+=("$(package_for "$cmd")")
  fi
done
if ((${#MISSING[@]})); then
  info "安装基础命令：${MISSING[*]}"
  install_packages "${PACKAGES[@]}" || die "基础命令安装失败：${MISSING[*]}"
fi

# ── Docker ──────────────────────────────────────────────────────────────────
# 引擎和 Compose 分开装：Debian 12 官方仓库没有 docker-compose-v2，把两个包写在
# 同一条 apt install 里会整条失败，连 docker.io 都装不上。
if ! command -v docker >/dev/null 2>&1; then
  info '安装 Docker Engine'
  if command -v apt-get >/dev/null 2>&1; then
    install_packages docker.io || die 'Docker Engine 安装失败'
  elif command -v dnf >/dev/null 2>&1; then
    install_packages docker || install_packages moby-engine || die 'Docker Engine 安装失败'
  elif command -v yum >/dev/null 2>&1; then
    install_packages docker || install_packages moby-engine || die 'Docker Engine 安装失败'
  elif command -v zypper >/dev/null 2>&1; then
    install_packages docker || die 'Docker Engine 安装失败'
  elif command -v pacman >/dev/null 2>&1; then
    install_packages docker || die 'Docker Engine 安装失败'
  else
    die '找不到支持的包管理器；请手工安装 Docker Engine 与 Compose 后重试'
  fi
fi
if ! docker info >/dev/null 2>&1; then
  info '启动 Docker 守护进程'
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 \
  || die 'Docker 守护进程不可用。已尝试 systemctl enable --now docker；请检查 docker.service 与 /var/run/docker.sock。'

if ! docker compose version >/dev/null 2>&1; then
  info '安装 Docker Compose v2'
  if command -v apt-get >/dev/null 2>&1; then
    install_packages docker-compose-v2 || install_packages docker-compose-plugin || true
  elif command -v dnf >/dev/null 2>&1; then
    install_packages docker-compose-plugin || install_packages docker-compose || true
  elif command -v yum >/dev/null 2>&1; then
    install_packages docker-compose-plugin || install_packages docker-compose || true
  elif command -v zypper >/dev/null 2>&1; then
    install_packages docker-compose || true
  elif command -v pacman >/dev/null 2>&1; then
    install_packages docker-compose || true
  fi
fi
docker compose version >/dev/null 2>&1 \
  || die 'Docker Engine 已安装，但 Docker Compose v2 不可用。Debian 12 / Rocky / Alma 9 stock 仓库不提供 v2；请按 docs/DOCKER.md 配置 Docker 官方仓库，或手工安装 docker-compose-plugin 后重试。Fedora 用 docker-compose 包。'

getent group docker >/dev/null 2>&1 \
  || die '系统里没有 docker 组；rootless Docker 不在这个安装器的支持范围内'
DOCKER_GID="$(getent group docker | cut -d: -f3)"
[[ -n "$DOCKER_GID" ]] || die '无法读取 docker 组的 gid'
# docker 组等价于宿主 root（组内进程可挂载宿主文件系统）。和 deploy.sh 同一口径：
# 默认不永久加组，只有显式 QQ_AGENT_ALLOW_DOCKER_GROUP=1 才执行 usermod。
# 但安装本身（拉镜像/起 SnowLuma）必须能访问 Docker：默认用 setpriv 只给安装子进程
# 临时补充组，安装完不保留，避免为了装一次就把服务账号永久提升到 root 等价权限。
if [[ "${QQ_AGENT_ALLOW_DOCKER_GROUP:-}" == "1" ]]; then
  usermod -aG docker "$SERVICE_USER" || die "无法把 $SERVICE_USER 加入 docker 组"
  id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker \
    || die "docker 组没有生效：$SERVICE_USER"
else
  printf '默认不永久加入 docker 组；安装期间用临时补充组访问 Docker（控制台「更新协议端」仍需 QQ_AGENT_ALLOW_DOCKER_GROUP=1）\n'
fi

# ── linger + 用户管理器 ─────────────────────────────────────────────────────
command -v loginctl >/dev/null 2>&1 || die '缺少 loginctl（systemd 用户服务需要）'
loginctl enable-linger "$SERVICE_USER" || die "无法为 $SERVICE_USER 开启 linger"
for _ in $(seq 1 20); do
  [[ -d "/run/user/$SERVICE_UID" ]] && break
  sleep 0.5
done
[[ -d "/run/user/$SERVICE_UID" ]] \
  || die "用户管理器没有起来：/run/user/$SERVICE_UID 不存在（检查 systemd-logind 与 linger）"

# ── 目录与源码 ──────────────────────────────────────────────────────────────
if [[ ! -d "$ROOT_DIR" ]]; then
  mkdir -p "$ROOT_DIR"
  chown -- "$SERVICE_USER:$SERVICE_GROUP" "$ROOT_DIR"
  chmod -- 0700 "$ROOT_DIR"
else
  # 已存在的根目录只允许受管条目；避免把 /mnt/data、/opt 这类共享父目录整体改权限。
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    case "$(basename -- "$entry")" in
      app|data|snowluma|src|backup|deployment-access.txt|deployment-access.txt.tmp|console-access.txt|console-access.txt.tmp|.deploy-all.lock|.deploy-all.lock.takeover)
        ;;
      *)
        die "部署根目录已有未知内容：$entry（请换一个空目录，或先人工确认）"
        ;;
    esac
  done < <(find "$ROOT_DIR" -mindepth 1 -maxdepth 1 -print 2>/dev/null)
  # 管理员按文档先 `sudo mkdir -p /mnt/data/qq-agent` 是常见前置：目录是 root 的，
  # 服务用户随后写不进去。只改根目录本身（不递归），下面的受管子目录由 deploy.sh 维护。
  chown -- "$SERVICE_USER:$SERVICE_GROUP" "$ROOT_DIR"
  chmod -- 0700 "$ROOT_DIR"
fi

if [[ "$SOURCE_DIR" != "$SRC_DIR" ]]; then
  # root 会用 rsync --delete 覆盖 $SRC_DIR。若它是符号链接（例如不可信用户把
  # $ROOT_DIR/src 指向 /etc），mkdir/rsync/chown 会跟随链接，以 root 删除目标目录内容。
  # 必须在任何写入前拒绝；允许的部署根布局只认 $ROOT_DIR/src 这个真实路径。
  if [[ -L "$SRC_DIR" ]]; then
    die "源码目录不能是符号链接：$SRC_DIR"
  fi
  if [[ -e "$SRC_DIR" && "$(realpath -m -- "$SRC_DIR")" != "$(realpath -m -- "$ROOT_DIR/src")" ]]; then
    die "源码目录解析后不在部署根内：$SRC_DIR"
  fi
  info "复制源码到 $SRC_DIR"
  mkdir -p "$SRC_DIR"
  rsync -a --delete \
    --exclude=.git \
    --exclude=node_modules \
    --exclude=data \
    --exclude=snowluma \
    --exclude=snowluma-data \
    --exclude=snowluma-client-config \
    --exclude=snowluma-client-data \
    --exclude=backups \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='*.log' \
    --exclude=console-access.txt \
    "$SOURCE_DIR/" "$SRC_DIR/"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$SRC_DIR"
fi

# ── 以服务用户重跑 install.sh ───────────────────────────────────────────────
# setpriv 可以只给安装子进程临时 docker 组，不必永久 usermod；runuser 无法附加组，
# 因此默认路径要求 setpriv（util-linux 常规组件），或显式选择永久加组。
if command -v setpriv >/dev/null 2>&1; then
  if [[ "${QQ_AGENT_ALLOW_DOCKER_GROUP:-}" == "1" ]]; then
    RUN_AS=(setpriv --reuid="$SERVICE_UID" --regid="$SERVICE_GID" --init-groups --)
  else
    RUN_AS=(setpriv --reuid="$SERVICE_UID" --regid="$SERVICE_GID" --groups "$DOCKER_GID" --)
  fi
elif command -v runuser >/dev/null 2>&1 && [[ "${QQ_AGENT_ALLOW_DOCKER_GROUP:-}" == "1" ]]; then
  RUN_AS=(runuser -u "$SERVICE_USER" --)
else
  die '缺少 setpriv（util-linux），无法在不永久加入 docker 组的情况下完成安装；请安装 setpriv，或显式设置 QQ_AGENT_ALLOW_DOCKER_GROUP=1 后重试'
fi

RUN_ENV=(
  "HOME=$HOME_DIR"
  "USER=$SERVICE_USER"
  "LOGNAME=$SERVICE_USER"
  "SHELL=$SERVICE_SHELL"
  "XDG_RUNTIME_DIR=/run/user/$SERVICE_UID"
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  "QQ_AGENT_ROOT_INSTALL_WRAPPED=1"
)

MANAGER_OK=false
for _ in $(seq 1 20); do
  if "${RUN_AS[@]}" env "${RUN_ENV[@]}" systemctl --user show-environment >/dev/null 2>&1; then
    MANAGER_OK=true
    break
  fi
  sleep 0.5
done
[[ "$MANAGER_OK" == true ]] \
  || die "无法以 $SERVICE_USER 连接 systemd 用户管理器；请检查 linger 与 /run/user/$SERVICE_UID"

info "以服务用户 $SERVICE_USER 执行安装"
set +e
"${RUN_AS[@]}" env "${RUN_ENV[@]}" bash "$SRC_DIR/install.sh" "${PASSTHRU[@]}"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  die "安装没有完成（退出码 $STATUS）。服务用户没有以 root 运行过；按上面的提示修复后重跑同一条命令。"
fi

# ── root 侧管理入口 ─────────────────────────────────────────────────────────
MANAGE_WRAPPER=/usr/local/bin/qq-agent-manage
if [[ -x "$ROOT_DIR/app/manage.sh" ]]; then
  if [[ "${RUN_AS[0]}" == "setpriv" ]]; then
    RUN_LINE="exec setpriv --reuid=$SERVICE_UID --regid=$SERVICE_GID --init-groups --"
  else
    RUN_LINE="exec runuser -u $SERVICE_USER --"
  fi
  cat >"$MANAGE_WRAPPER" <<EOF
#!/bin/sh
set -e
if [ "\$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行：sudo qq-agent-manage \$*" >&2
  exit 1
fi
$RUN_LINE \\
  env HOME="$HOME_DIR" USER="$SERVICE_USER" LOGNAME="$SERVICE_USER" SHELL="$SERVICE_SHELL" \\
  XDG_RUNTIME_DIR="/run/user/$SERVICE_UID" "$ROOT_DIR/app/manage.sh" "\$@"
EOF
  chmod 0755 "$MANAGE_WRAPPER"
  info "管理入口：sudo qq-agent-manage status|logs|restart|observe|activate"
fi

info "完成：服务用户是 $SERVICE_USER，机器人进程不是 root。"
