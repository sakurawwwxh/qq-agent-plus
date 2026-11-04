#!/usr/bin/env bash
set -euo pipefail
umask 077

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${QQ_AGENT_STACK_DIR:-/mnt/data/qq-agent}"
AGENT_PORT="3210"
SNOWLUMA_PORT="5099"
NOVNC_PORT="6081"
ONEBOT_HTTP_PORT="3000"
ONEBOT_WS_PORT="3001"
# 控制台 / SnowLuma WebUI / noVNC 的宿主监听地址。
# 默认只绑回环：远程访问走 SSH 隧道；只有显式 --publish 才对外开放（安全组仍需自行收紧）。
PUBLISH_HOST="127.0.0.1"
PUBLISH_EXPLICIT=false
AGENT_PORT_SET=false
SNOWLUMA_PORT_SET=false
NOVNC_PORT_SET=false
ONEBOT_HTTP_PORT_SET=false
ONEBOT_WS_PORT_SET=false
SERVICE="qq-agent-linux"
SERVICE_SET=false
IMAGE="${SNOWLUMA_IMAGE:-motricseven7/snowluma:v1.14.22}"
IMAGE_SET=false
IMAGE_MIRROR_ARG=""
# 这两个是用户会按机器情况调的旋钮（显存紧张时改 SNOWLUMA_SCREEN、排查时改日志级别），
# 重跑时从 .env 回读，避免手工改动被默认值覆盖。
SNOWLUMA_SCREEN="1920x1080x24"
SNOWLUMA_LOG_LEVEL="info"
ASSUME_YES=false
CHECK_ONLY=false
ROTATE_CREDENTIALS=false
INSTALL_DOCKER=true
AGENT_TOKEN=""
ONEBOT_TOKEN=""
SNOWLUMA_PASSWORD=""
VNC_PASSWORD=""
SNOWLUMA_CURRENT_PASSWORD=""
SNOWLUMA_TOTP=""
MODEL_BASE_URL="${QQ_AGENT_MODEL_BASE_URL:-}"
MODEL_API_KEY="${QQ_AGENT_MODEL_API_KEY:-}"
MODEL_NAME="${QQ_AGENT_MODEL:-}"
ALLOW_GROUPS="${QQ_AGENT_ALLOW_GROUPS:-}"
ALLOW_PRIVATE="${QQ_AGENT_ALLOW_PRIVATE:-}"
SKIP_MODEL_CONFIG=false

# 网页终端（宝塔等面板的终端）、su、sudo -u 这类非登录会话不设置 XDG_RUNTIME_DIR：
# systemctl --user 会直接报 "Failed to connect to bus ... $XDG_RUNTIME_DIR not defined"，
# 即使用户管理器好好地在跑（2026-10-12 报道复现：同一台机器只差这一个环境变量）。
# 目录存在就按 systemd 的口径补上；用户自己设过的值不动。
if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

usage() {
  cat <<'EOF'
Usage: bash deploy-all.sh [options]

Interactive full-stack installer for QQ Agent + SnowLuma/OneBot.

Options:
  --root-dir PATH             Stack root (default: /mnt/data/qq-agent)
  --agent-port PORT           QQ Agent console port (default: 3210)
  --snowluma-port PORT        SnowLuma WebUI port (default: 5099)
  --novnc-port PORT           QQ login/noVNC port (default: 6081)
  --onebot-http-port PORT     Local-only OneBot HTTP port (default: 3000)
  --onebot-ws-port PORT       Local-only OneBot WebSocket port (default: 3001)
  --service NAME              systemd user service (default: qq-agent-linux)
  --image IMAGE               SnowLuma image (default: tested v1.14.22)
  --image-mirror HOST         Try this registry mirror (yours first) when Docker Hub
                              is unreachable (mainland China), e.g.
                              --image-mirror docker.m.daocloud.io
                              (also: QQ_AGENT_IMAGE_MIRROR, comma-separated);
                              built-in public mirrors are tried after yours
  --agent-token TOKEN         Set the QQ Agent console token
  --onebot-token TOKEN        Set the shared OneBot HTTP/WS token
  --snowluma-password VALUE   Set the initial SnowLuma WebUI password
  --snowluma-current-password VALUE
                              Current WebUI password when rotating it
  --snowluma-totp CODE        Current SnowLuma 2FA code when enabled
  --vnc-password VALUE        Set the noVNC password (8 characters recommended)
  --model-base-url URL        OpenAI-compatible Chat Completions base URL
  --model-api-key KEY         Model provider API key
  --model NAME                Model identifier
  --allow-groups IDS          Comma-separated QQ group allowlist
  --allow-private IDS         Comma-separated QQ private-chat allowlist
  --skip-model-config         Leave model settings for the management console
  --rotate-credentials        Replace stored credentials during an update
  --no-install-docker         Fail instead of installing Docker when missing
  --check-only                Inspect ownership and ports without changing anything
  --publish                   Bind console / SnowLuma WebUI / noVNC to 0.0.0.0
                              (default is 127.0.0.1; requires a tightened security group)
  --loopback                  Explicitly bind them to 127.0.0.1 (default for new installs)
  -y, --yes                   Accept defaults; suitable for non-interactive use
  -h, --help                  Show this help

The installer never asks for a LAN IP. By default the console, SnowLuma WebUI
and noVNC bind to 127.0.0.1 only; use an SSH tunnel (console-tunnel.bat or
`ops console`) or pass --publish to expose them. OneBot ports always bind to
127.0.0.1. Existing installations keep their current bind address unless
--publish/--loopback is passed explicitly.
Existing installations not owned by this installer are never adopted.
Use deploy.sh with the existing data directory and endpoints to update Agent only.
EOF
}

require_value() {
  (($# >= 2)) || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
}

while (($#)); do
  case "$1" in
    --root-dir) require_value "$@"; ROOT_DIR="$2"; shift 2 ;;
    --root-dir=*) ROOT_DIR="${1#*=}"; shift ;;
    --agent-port) require_value "$@"; AGENT_PORT="$2"; AGENT_PORT_SET=true; shift 2 ;;
    --snowluma-port) require_value "$@"; SNOWLUMA_PORT="$2"; SNOWLUMA_PORT_SET=true; shift 2 ;;
    --novnc-port) require_value "$@"; NOVNC_PORT="$2"; NOVNC_PORT_SET=true; shift 2 ;;
    --onebot-http-port) require_value "$@"; ONEBOT_HTTP_PORT="$2"; ONEBOT_HTTP_PORT_SET=true; shift 2 ;;
    --onebot-ws-port) require_value "$@"; ONEBOT_WS_PORT="$2"; ONEBOT_WS_PORT_SET=true; shift 2 ;;
    --service) require_value "$@"; SERVICE="$2"; SERVICE_SET=true; shift 2 ;;
    --image) require_value "$@"; IMAGE="$2"; IMAGE_SET=true; shift 2 ;;
    --image-mirror) require_value "$@"; IMAGE_MIRROR_ARG="$2"; shift 2 ;;
    --agent-token) require_value "$@"; AGENT_TOKEN="$2"; shift 2 ;;
    --onebot-token) require_value "$@"; ONEBOT_TOKEN="$2"; shift 2 ;;
    --snowluma-password) require_value "$@"; SNOWLUMA_PASSWORD="$2"; shift 2 ;;
    --snowluma-current-password) require_value "$@"; SNOWLUMA_CURRENT_PASSWORD="$2"; shift 2 ;;
    --snowluma-totp) require_value "$@"; SNOWLUMA_TOTP="$2"; shift 2 ;;
    --vnc-password) require_value "$@"; VNC_PASSWORD="$2"; shift 2 ;;
    --model-base-url) require_value "$@"; MODEL_BASE_URL="$2"; shift 2 ;;
    --model-api-key) require_value "$@"; MODEL_API_KEY="$2"; shift 2 ;;
    --model) require_value "$@"; MODEL_NAME="$2"; shift 2 ;;
    --allow-groups) require_value "$@"; ALLOW_GROUPS="$2"; shift 2 ;;
    --allow-private) require_value "$@"; ALLOW_PRIVATE="$2"; shift 2 ;;
    --skip-model-config) SKIP_MODEL_CONFIG=true; shift ;;
    --rotate-credentials) ROTATE_CREDENTIALS=true; shift ;;
    --no-install-docker) INSTALL_DOCKER=false; shift ;;
    --check-only) CHECK_ONLY=true; ASSUME_YES=true; shift ;;
    --publish) PUBLISH_HOST="0.0.0.0"; PUBLISH_EXPLICIT=true; shift ;;
    --loopback) PUBLISH_HOST="127.0.0.1"; PUBLISH_EXPLICIT=true; shift ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# 凭据的环境变量回退：命令行参数会出现在 /proc/<pid>/cmdline（对本机所有用户
# 可读），无人值守/CI 场景请优先用环境变量传凭据。命令行显式传值时优先于环境变量。
AGENT_TOKEN="${AGENT_TOKEN:-${QQ_AGENT_AGENT_TOKEN:-}}"
ONEBOT_TOKEN="${ONEBOT_TOKEN:-${QQ_AGENT_ONEBOT_TOKEN:-}}"
SNOWLUMA_PASSWORD="${SNOWLUMA_PASSWORD:-${QQ_AGENT_SNOWLUMA_PASSWORD:-}}"
SNOWLUMA_TOTP="${SNOWLUMA_TOTP:-${QQ_AGENT_SNOWLUMA_TOTP:-}}"
# ops deploy 用 0600 临时文件传模型 Key，不走子进程环境；这里要认这个入口。
if [[ -z "$MODEL_API_KEY" && -n "${QQ_AGENT_MODEL_KEY_FILE:-}" ]]; then
  [[ -r "$QQ_AGENT_MODEL_KEY_FILE" ]] || {
    printf 'Error: QQ_AGENT_MODEL_KEY_FILE 不存在或不可读：%s\n' "$QQ_AGENT_MODEL_KEY_FILE" >&2
    exit 1
  }
  MODEL_API_KEY="$(tr -d '\r\n' < "$QQ_AGENT_MODEL_KEY_FILE")"
fi
VNC_PASSWORD="${VNC_PASSWORD:-${QQ_AGENT_VNC_PASSWORD:-}}"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

# 全新安装中途失败时清掉本次写下的 .env / compose 与空目录：否则重跑会被
# check_local_ownership 判成"不完整的受管安装"而拒绝 —— 而拉镜像失败的提示恰恰让操作者重跑。
# 容器可能已经写过东西，所以目录只用 rmdir：非空会失败，正好保留现场。
FRESH_STACK_CLEANUP=false
STACK_LOCK_DIR=""
STACK_LOCK_OWNED=false
cleanup_fresh_stack() {
  [[ "$FRESH_STACK_CLEANUP" == true ]] || return 0
  printf '安装未完成：已清理本次写入的栈文件与空目录，可以直接重跑 deploy-all.sh。\n' >&2
  rm -f "$ENV_FILE" "$ENV_FILE.tmp" "$COMPOSE_FILE" "$COMPOSE_FILE.tmp"
  rmdir "$SNOWLUMA_DATA_DIR/config" "$SNOWLUMA_DIR/client-config" "$SNOWLUMA_DIR/client-data" \
    "$SNOWLUMA_DATA_DIR" "$SNOWLUMA_DIR" "$AGENT_DATA_DIR" 2>/dev/null || true
}

# 2026-10-06 复审 P2/P3：统一的退出钩子（bash 只有一个 EXIT trap，原先分散的
# `trap cleanup_fresh_stack EXIT` 与 `trap 'rm …' EXIT` 互相覆盖，谁后挂谁生效）。
# - fresh：清掉半成品栈文件与空目录。
# - existing + 轮换凭据：.env 在部署成功前就已重写成新凭据，而 config.json 还是旧令牌
#   （deploy.sh 的回滚只管 config.json）—— 此后 check-stack-update 比对必然 refuse_existing，
#   脚本自提示的"重跑带 --rotate-credentials"也无效（预检在写凭据之前跑）。失败退出回拷
#   部署前的 .env，让重跑路径保持可用。
# - 模型 Key 临时文件兜底删除（原先只在设置了 MODEL_API_KEY 时才挂 trap，且会顶掉清理钩子）。
deploy_all_exit() {
  local status=$?
  [[ -n "${MODEL_KEY_FILE:-}" ]] && rm -f "$MODEL_KEY_FILE"
  if [[ "${ENV_REWRITTEN:-false}" == true && "${DEPLOY_COMPLETED:-false}" != true && "${KEEP_ENV_ON_ROTATE_FAILURE:-false}" != true && -f "$ENV_FILE.pre-deploy" ]]; then
    cp -p "$ENV_FILE.pre-deploy" "$ENV_FILE"
    printf '部署未完成：.env 已回滚为部署前内容（备份保留在 %s.pre-deploy），可直接重跑 deploy-all.sh。\n' "$ENV_FILE" >&2
  fi
  # 清理必须在仍持锁时做：先放锁再删 .env，新的赢家可能已经写好 .env 又被这里删掉。
  cleanup_fresh_stack
  if [[ "${STACK_LOCK_OWNED:-false}" == true && -n "${STACK_LOCK_DIR:-}" ]]; then
    rm -rf -- "$STACK_LOCK_DIR"
    STACK_LOCK_OWNED=false
  fi
  exit "$status"
}

# 栈级互斥：两个 deploy-all 同时跑时，.env/compose 会在 deploy.sh 的锁之前互相覆盖。
# 锁放在部署根目录，覆盖从 .env 写入到 deploy.sh 收尾的全程。
acquire_stack_lock() {
  local attempt=0 pid="" stale="" takeover="$STACK_LOCK_DIR.takeover"
  while (( attempt < 3 )); do
    if mkdir -- "$STACK_LOCK_DIR" 2>/dev/null; then
      STACK_LOCK_OWNED=true
      printf '%s\n' "$$" >"$STACK_LOCK_DIR/pid" 2>/dev/null || true
      date -Is >"$STACK_LOCK_DIR/started" 2>/dev/null || true
      return 0
    fi
    pid="$(cat "$STACK_LOCK_DIR/pid" 2>/dev/null | tr -d '\r\n' || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      die "另一个 deploy-all.sh 正在运行（pid $pid，锁 $STACK_LOCK_DIR）"
    fi
    stale="$(find "$STACK_LOCK_DIR" -maxdepth 0 -mmin +5 2>/dev/null || true)"
    if [[ -n "$stale" || -n "$pid" ]]; then
      # 陈旧锁的接管要互斥：两个实例都判定"陈旧"时，不能都 rm -rf 再 mkdir——
      # 后者的 rm 会把前者刚建好的新锁删掉，两个进程同时往下走。
      if ! mkdir -- "$takeover" 2>/dev/null; then
        if [[ -n "$(find "$takeover" -maxdepth 0 -mmin +5 2>/dev/null || true)" ]]; then
          rm -rf -- "$takeover"
          mkdir -- "$takeover" 2>/dev/null \
            || die "另一个 deploy-all.sh 正在接管陈旧锁，请稍后重试"
        else
          die "另一个 deploy-all.sh 正在接管陈旧锁，请稍后重试"
        fi
      fi
      # 二次判定：拿到接管权后锁可能已被别人重建
      pid="$(cat "$STACK_LOCK_DIR/pid" 2>/dev/null | tr -d '\r\n' || true)"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        rmdir -- "$takeover" 2>/dev/null || true
        die "另一个 deploy-all.sh 正在运行（pid $pid，锁 $STACK_LOCK_DIR）"
      fi
      # 原子移走再删：只有真正搬走旧锁的实例才能继续，搬不动的说明已被别人接管。
      if mv -- "$STACK_LOCK_DIR" "$takeover/stale" 2>/dev/null; then
        rm -rf -- "$takeover/stale"
      fi
      rmdir -- "$takeover" 2>/dev/null || true
      attempt=$((attempt + 1))
      continue
    fi
    die "另一个 deploy-all.sh 正在运行（锁 $STACK_LOCK_DIR）"
  done
  die "无法获取部署锁：$STACK_LOCK_DIR"
}

step() {
  printf '\n==> %s\n' "$*"
}

prompt_value() {
  local label="$1" default="$2" answer=""
  if [[ "$ASSUME_YES" == true ]]; then
    printf '%s' "$default"
    return
  fi
  [[ -r /dev/tty ]] || die 'Interactive input is unavailable; use --yes and explicit options'
  printf '%s [%s]: ' "$label" "$default" >/dev/tty
  IFS= read -r answer </dev/tty || true
  printf '%s' "${answer:-$default}"
}

confirm() {
  local label="$1" default_yes="${2:-false}" answer=""
  if [[ "$ASSUME_YES" == true ]]; then
    [[ "$default_yes" == true ]]
    return
  fi
  local suffix='[y/N]'
  [[ "$default_yes" == true ]] && suffix='[Y/n]'
  printf '%s %s ' "$label" "$suffix" >/dev/tty
  IFS= read -r answer </dev/tty || true
  if [[ -z "$answer" ]]; then
    [[ "$default_yes" == true ]]
  else
    [[ "$answer" =~ ^([yY]|yes|YES|是)$ ]]
  fi
}

prompt_secret() {
  local label="$1" answer=""
  printf '%s: ' "$label" >/dev/tty
  IFS= read -r -s answer </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

random_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1 | tr -d '\r'
}

validate_port() {
  [[ "$2" =~ ^[0-9]+$ ]] && ((10#$2 >= 1 && 10#$2 <= 65535)) \
    || die "$1 must be an integer from 1 to 65535"
}

validate_secret() {
  local label="$1" value="$2" minimum="$3"
  ((${#value} >= minimum)) || die "$label must contain at least $minimum characters"
  [[ "$value" =~ ^[A-Za-z0-9._!@%+=:-]+$ ]] \
    || die "$label may only contain letters, numbers, and ._!@%+=:-"
}

run_root() {
  if ((EUID == 0)); then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "Root permission is required for: $*"
  fi
}

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

sudo_docker_ready() {
  ((EUID != 0)) && command -v sudo >/dev/null 2>&1 \
    && command -v docker >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1
}

install_docker() {
  [[ "$INSTALL_DOCKER" == true ]] || die 'Docker is unavailable and automatic installation is disabled'
  confirm 'Docker is missing. Install Docker and Compose now?' true \
    || die 'Docker is required by SnowLuma'

  step 'Installing Docker Engine'
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update
    run_root apt-get install -y docker.io || die 'Docker Engine installation failed'
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y docker || run_root dnf install -y moby-engine \
      || die 'Docker Engine installation failed'
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y docker || run_root yum install -y moby-engine \
      || die 'Docker Engine installation failed'
  elif command -v zypper >/dev/null 2>&1; then
    run_root zypper --non-interactive install -y docker || die 'Docker Engine installation failed'
  elif command -v pacman >/dev/null 2>&1; then
    run_root pacman -Sy --noconfirm docker || die 'Docker Engine installation failed'
  else
    die 'No supported package manager found; install Docker Engine and Compose manually'
  fi
  run_root systemctl enable --now docker

  install_compose
}

# Compose 单独装/单独检查：Debian 12 官方仓库没有 docker-compose-v2，
# 引擎已存在但 Compose 缺失时也不能因为“docker_ready”跳过。
install_compose() {
  [[ "$INSTALL_DOCKER" == true ]] \
    || die 'Docker Compose v2 is missing and automatic installation is disabled'
  step 'Installing Docker Compose v2'
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get install -y docker-compose-v2 \
      || run_root apt-get install -y docker-compose-plugin \
      || true
  elif command -v dnf >/dev/null 2>&1; then
    # Fedora 的 Compose 包名是 docker-compose；Rocky/Alma 9 stock 仓库通常两者都没有。
    run_root dnf install -y docker-compose-plugin \
      || run_root dnf install -y docker-compose \
      || true
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y docker-compose-plugin \
      || run_root yum install -y docker-compose \
      || true
  elif command -v zypper >/dev/null 2>&1; then
    run_root zypper --non-interactive install -y docker-compose || true
  elif command -v pacman >/dev/null 2>&1; then
    run_root pacman -Sy --noconfirm docker-compose || true
  fi
  docker_call compose version >/dev/null 2>&1 \
    || die 'Docker Engine is installed but Docker Compose v2 is unavailable. Debian 12 / Rocky / Alma 9 stock repos do not provide it; configure the Docker official repository (docs/DOCKER.md) or install docker-compose-plugin manually. Fedora uses the docker-compose package.'
}

docker_call() {
  if docker_ready; then
    docker "$@"
  elif sudo_docker_ready; then
    sudo docker "$@"
  else
    return 1
  fi
}

wait_http() {
  local url="$1" attempts="${2:-60}"
  for ((i = 0; i < attempts; i++)); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

onebot_ready() {
  # Token 经 stdin 喂给 curl（-H @-），不出现在 /proc/<pid>/cmdline——
  # 对本机所有用户可读（凭据退出命令行参数原则）。
  printf 'authorization: Bearer %s\n' "$ONEBOT_TOKEN" | \
  curl -fsS --max-time 3 -H @- \
    -H 'content-type: application/json' \
    -d '{}' "http://127.0.0.1:$ONEBOT_HTTP_PORT/get_login_info" \
    | grep -Eq '"retcode"[[:space:]]*:[[:space:]]*0'
}

refuse_existing() {
  printf 'Existing or incomplete installation detected: %s\n' "$1" >&2
  die 'No deployment changes made. Use deploy.sh for the existing Agent; preserve its data directory, bind address and OneBot settings. Automatic takeover is not supported.'
}

check_local_ownership() {
  local file directory contents
  if [[ -e "$ENV_FILE" ]]; then
    for file in "$ENV_FILE" "$COMPOSE_FILE" "$APP_DIR/.deployment.json" \
      "$APP_DIR/.deployment-node" "$AGENT_DATA_DIR/config.json"; do
      [[ -f "$file" && -r "$file" && ! -L "$file" ]] \
        || refuse_existing "incomplete managed stack ($file)"
    done
    EXISTING_STACK=true
    IFS= read -r PREFLIGHT_NODE <"$APP_DIR/.deployment-node" || true
    [[ -n "$PREFLIGHT_NODE" && -x "$PREFLIGHT_NODE" ]] \
      || refuse_existing 'the recorded Node runtime is unavailable'
  else
    for file in "$APP_DIR/.deployment.json" "$APP_DIR/.deployment-node" \
      "$APP_DIR/config.json" "$ACCESS_FILE"; do
      [[ ! -e "$file" && ! -L "$file" ]] \
        || refuse_existing "$file exists without managed stack metadata"
    done
    for directory in "$AGENT_DATA_DIR" "$APP_DIR/data" "$SNOWLUMA_DIR"; do
      [[ ! -L "$directory" ]] || refuse_existing "unmanaged data symlink $directory"
      [[ -e "$directory" ]] || continue
      [[ -d "$directory" && -r "$directory" && -x "$directory" ]] \
        || refuse_existing "cannot inspect $directory"
      contents="$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" \
        || refuse_existing "cannot inspect $directory"
      [[ -z "$contents" ]] || refuse_existing "$directory contains data without managed stack metadata"
    done
  fi
}

check_host_ownership() {
  local load_state working_dir inventory id name image own_id="" docker_ports=""
  local listeners port agent_running=false old_agent_port=""
  local docker_command=()
  command -v systemctl >/dev/null || die 'systemctl is required'
  systemctl --user show-environment >/dev/null \
    || die "Cannot reach the systemd user manager from this shell; no deployment changes made. A web terminal (panel console) or other non-login shell does not set XDG_RUNTIME_DIR even when the manager is running: run 'export XDG_RUNTIME_DIR=/run/user/\$(id -u)' and retry; if that directory does not exist, run 'sudo loginctl enable-linger $(id -un)' first, then retry."
  if ! load_state="$(systemctl --user show "$SERVICE.service" --property=LoadState --value)"; then
    [[ "$load_state" == not-found ]] \
      || die 'Cannot inspect the selected systemd service; no deployment changes made'
  fi
  case "$load_state" in
    not-found) ;;
    loaded)
      [[ "$EXISTING_STACK" == true ]] || refuse_existing "$SERVICE.service already exists"
      working_dir="$(systemctl --user show "$SERVICE.service" --property=WorkingDirectory --value)" \
        || refuse_existing "cannot inspect $SERVICE.service"
      [[ -n "$working_dir" && "$(realpath -m -- "$working_dir")" == "$APP_DIR" ]] \
        || refuse_existing "$SERVICE.service belongs to another application directory"
      if systemctl --user is-active --quiet "$SERVICE.service"; then agent_running=true; fi
      ;;
    *) refuse_existing "cannot establish ownership of $SERVICE.service" ;;
  esac

  if [[ "$EXISTING_STACK" == true ]]; then
    "$PREFLIGHT_NODE" "$SOURCE_DIR/scripts/check-stack-update.mjs" \
      --root-dir "$ROOT_DIR" --service "$SERVICE" \
      || refuse_existing 'managed Agent configuration does not match the saved stack'
    old_agent_port="$(env_value "$ENV_FILE" AGENT_PORT)"
  fi

  if command -v docker >/dev/null 2>&1; then
    if docker_ready; then
      docker_command=(docker)
    elif command -v sudo >/dev/null 2>&1; then
      if sudo -n docker info >/dev/null 2>&1; then
        docker_command=(sudo -n docker)
      elif [[ "$CHECK_ONLY" != true && "$ASSUME_YES" != true ]] \
        && sudo docker info >/dev/null; then
        docker_command=(sudo docker)
      fi
    fi
    ((${#docker_command[@]} > 0)) \
      || refuse_existing 'Docker exists but its containers cannot be inspected (check daemon access or sudo)'
    inventory="$("${docker_command[@]}" ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}')" \
      || refuse_existing 'Docker container inventory is unavailable'
    while IFS='|' read -r id name image; do
      [[ -n "$id" ]] || continue
      image="$(printf '%s' "$image" | tr '[:upper:]' '[:lower:]')"
      case "$name:$image" in
        qq-agent-snowluma:*|*[Ss][Nn][Oo][Ww][Ll][Uu][Mm][Aa]*|*[Nn][Aa][Pp][Cc][Aa][Tt]*|*[Ll][Aa][Gg][Rr][Aa][Nn][Gg][Ee]*)
          [[ "$EXISTING_STACK" == true && "$name" == qq-agent-snowluma ]] \
            || refuse_existing "external QQ gateway container $name"
          own_id="$id"
          "${docker_command[@]}" inspect "$id" \
            | "$PREFLIGHT_NODE" "$SOURCE_DIR/scripts/check-stack-update.mjs" \
                --root-dir "$ROOT_DIR" --service "$SERVICE" --input container \
            || refuse_existing "container $name does not belong to this stack"
          ;;
      esac
    done <<<"$inventory"
    if [[ "$EXISTING_STACK" == true ]]; then
      "${docker_command[@]}" compose --project-directory "$SNOWLUMA_DIR" \
        --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json \
        | "$PREFLIGHT_NODE" "$SOURCE_DIR/scripts/check-stack-update.mjs" \
            --root-dir "$ROOT_DIR" --service "$SERVICE" --input compose \
        || refuse_existing 'Compose configuration does not match this stack'
    fi
    if [[ -n "$own_id" ]]; then
      docker_ports="$("${docker_command[@]}" inspect --format \
        '{{if .State.Running}}{{range .NetworkSettings.Ports}}{{range .}}{{.HostPort}}{{"\n"}}{{end}}{{end}}{{end}}' "$own_id")" \
        || refuse_existing 'cannot inspect managed container ports'
    fi
  elif [[ "$EXISTING_STACK" == true ]]; then
    refuse_existing 'Docker is missing for the existing managed stack'
  fi

  command -v ss >/dev/null || die 'ss (iproute2) is required for port checks'
  listeners="$(ss -H -ltn)" || die 'Cannot inspect listening ports; no deployment changes made'
  listeners="$(printf '%s\n' "$listeners" | awk '{n=split($4,a,":"); print a[n]}')"
  for port in "${ports[@]}"; do
    if printf '%s\n' "$listeners" | grep -Fxq "$port"; then
      if [[ "$port" == "$AGENT_PORT" && "$port" == "$old_agent_port" && "$agent_running" == true ]]; then
        continue
      fi
      if [[ "$port" != "$AGENT_PORT" ]] && printf '%s\n' "$docker_ports" | grep -Fxq "$port"; then
        continue
      fi
      refuse_existing "selected port $port is already in use outside the managed services"
    fi
  done
}

[[ "$(uname -s)" == Linux ]] || die 'Full-stack deployment is supported on Linux only'
((EUID != 0)) || die 'Run as the service user, not root; sudo is used only for host dependencies'
if [[ "${QQ_AGENT_PLATFORM_CHECKED:-}" != "1" ]]; then
  bash "$SOURCE_DIR/scripts/check-platform.sh" --strict \
    || die '当前系统不受支持（原因见上）。推荐 Ubuntu 22.04/24.04、Debian 12、Rocky/Alma 9；openSUSE 等 dnf/zypper 系属于预期可用、未实测。'
  export QQ_AGENT_PLATFORM_CHECKED=1
fi
command -v curl >/dev/null 2>&1 || die 'curl is required'
[[ "$SERVICE" =~ ^[A-Za-z0-9_-]+$ ]] || die 'Invalid service name'
[[ "$IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die 'Invalid SnowLuma image reference'

if [[ "$ASSUME_YES" != true ]]; then
  ROOT_DIR="$(prompt_value 'Deployment root' "$ROOT_DIR")"
fi
[[ "$ROOT_DIR" = /* ]] || die '--root-dir must be an absolute path'
[[ "$ROOT_DIR" != *[[:space:]%\"]* ]] || die 'Deployment root contains unsupported characters'
command -v realpath >/dev/null || die 'realpath is required'
ROOT_DIR="$(realpath -m -- "$ROOT_DIR")"
[[ "$ROOT_DIR" != / ]] || die 'The filesystem root cannot be used as the deployment root'

APP_DIR="$ROOT_DIR/app"
AGENT_DATA_DIR="$ROOT_DIR/data"
SNOWLUMA_DIR="$ROOT_DIR/snowluma"
SNOWLUMA_DATA_DIR="$SNOWLUMA_DIR/data"
ENV_FILE="$SNOWLUMA_DIR/.env"
COMPOSE_FILE="$SNOWLUMA_DIR/docker-compose.yml"
ACCESS_FILE="$ROOT_DIR/deployment-access.txt"

EXISTING_STACK=false
PREFLIGHT_NODE=""
# 栈级锁必须在“归属判定/凭据读回”之前拿到：两个实例交错时，后启动的那个不能先按
# 全新安装预检、等前一个结束后再拿锁继续（会把受管栈的凭据轮换掉，2026-10 审查 P2）。
# 锁放在临时目录而不是部署根：预检拒绝时不能留下任何部署目录（fresh preflight 的契约）。
STACK_LOCK_DIR="${TMPDIR:-/tmp}/qq-agent-deploy-$(id -u)-$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-12).lock"
trap deploy_all_exit EXIT
acquire_stack_lock
check_local_ownership
# 存量安装：没有显式 --publish/--loopback 时沿用现有绑定，避免一次更新把远程访问改没。
# 先读 .env 的 PUBLISH_HOST；老版本没有这个键，就从 compose 的 0.0.0.0 绑定反推。
if [[ "$EXISTING_STACK" == true && "$PUBLISH_EXPLICIT" != true ]]; then
  if [[ -f "$ENV_FILE" ]] && grep -q '^PUBLISH_HOST=' "$ENV_FILE"; then
    PUBLISH_HOST="$(sed -n 's/^PUBLISH_HOST=//p' "$ENV_FILE" | head -n 1)"
  elif [[ -f "$COMPOSE_FILE" ]] && grep -q '"0\.0\.0\.0:' "$COMPOSE_FILE"; then
    PUBLISH_HOST="0.0.0.0"
  fi
  [[ "$PUBLISH_HOST" == "0.0.0.0" ]] || PUBLISH_HOST="127.0.0.1"
fi
if [[ "$EXISTING_STACK" == true ]]; then
  if [[ "$SERVICE_SET" != true ]]; then
    SERVICE="$(env_value "$ENV_FILE" QQ_AGENT_SERVICE)"; SERVICE="${SERVICE:-qq-agent-linux}"
  fi
  if [[ "$IMAGE_SET" != true ]]; then
    IMAGE="$(env_value "$ENV_FILE" SNOWLUMA_IMAGE)"; IMAGE="${IMAGE:-motricseven7/snowluma:v1.14.22}"
  fi
  if [[ "$AGENT_PORT_SET" != true ]]; then
    AGENT_PORT="$(env_value "$ENV_FILE" AGENT_PORT)"; AGENT_PORT="${AGENT_PORT:-3210}"
  fi
  if [[ "$SNOWLUMA_PORT_SET" != true ]]; then
    SNOWLUMA_PORT="$(env_value "$ENV_FILE" SNOWLUMA_WEBUI_HOST_PORT)"; SNOWLUMA_PORT="${SNOWLUMA_PORT:-5099}"
  fi
  if [[ "$NOVNC_PORT_SET" != true ]]; then
    NOVNC_PORT="$(env_value "$ENV_FILE" NOVNC_PORT)"; NOVNC_PORT="${NOVNC_PORT:-6081}"
  fi
  if [[ "$ONEBOT_HTTP_PORT_SET" != true ]]; then
    ONEBOT_HTTP_PORT="$(env_value "$ENV_FILE" ONEBOT_HTTP_PORT)"; ONEBOT_HTTP_PORT="${ONEBOT_HTTP_PORT:-3000}"
  fi
  if [[ "$ONEBOT_WS_PORT_SET" != true ]]; then
    ONEBOT_WS_PORT="$(env_value "$ENV_FILE" ONEBOT_WS_PORT)"; ONEBOT_WS_PORT="${ONEBOT_WS_PORT:-3001}"
  fi
  SNOWLUMA_SCREEN="$(env_value "$ENV_FILE" SNOWLUMA_SCREEN)"; SNOWLUMA_SCREEN="${SNOWLUMA_SCREEN:-1920x1080x24}"
  SNOWLUMA_LOG_LEVEL="$(env_value "$ENV_FILE" SNOWLUMA_LOG_LEVEL)"; SNOWLUMA_LOG_LEVEL="${SNOWLUMA_LOG_LEVEL:-info}"
fi
[[ "$SERVICE" =~ ^[A-Za-z0-9_-]+$ ]] || die 'Invalid service name'
[[ "$IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die 'Invalid SnowLuma image reference'
[[ "$SNOWLUMA_SCREEN" =~ ^[0-9]+x[0-9]+x[0-9]+$ ]] \
  || die "Invalid SNOWLUMA_SCREEN, expected WIDTHxHEIGHTxDEPTH: $SNOWLUMA_SCREEN"
[[ "$SNOWLUMA_LOG_LEVEL" =~ ^[A-Za-z]+$ ]] || die "Invalid SNOWLUMA_LOG_LEVEL: $SNOWLUMA_LOG_LEVEL"
# 镜像站列表 = 用户指定的（QQ_AGENT_IMAGE_MIRROR 逗号分隔 + --image-mirror）在前，
# 内置公共加速站兜底在后。直连 Docker Hub 能通时这些一个都用不到。
# 为什么留内置兜底：国内/受限网络直连 registry-1.docker.io 必失败，兜底之前每个新部署
# 都要先撞一次"拉取镜像失败"再手改参数重跑（2026-10-12 群友实测）。内置站是第三方、
# 随时可能失效：要换成或补充自己的，用参数放在前面即可（重复的会去掉）。
DEFAULT_IMAGE_MIRRORS=(docker.1panel.live docker.m.daocloud.io)
IMAGE_MIRRORS=()
if [[ -n "${QQ_AGENT_IMAGE_MIRROR:-}" ]]; then
  IFS=',' read -r -a IMAGE_MIRRORS <<<"$QQ_AGENT_IMAGE_MIRROR"
fi
[[ -z "$IMAGE_MIRROR_ARG" ]] || IMAGE_MIRRORS+=("$IMAGE_MIRROR_ARG")
for mirror in "${DEFAULT_IMAGE_MIRRORS[@]}"; do
  duplicate=false
  # 空数组展开用 + guard：bash 4.3 及更老（CentOS 7 / Amazon Linux 2）在 set -u 下
  # `"${arr[@]}"` 展开空数组会直接 "unbound variable" 退出（2026-10-13 审查）。
  for existing in ${IMAGE_MIRRORS[@]+"${IMAGE_MIRRORS[@]}"}; do
    [[ "$existing" == "$mirror" ]] && { duplicate=true; break; }
  done
  [[ "$duplicate" == true ]] || IMAGE_MIRRORS+=("$mirror")
done
for mirror in ${IMAGE_MIRRORS[@]+"${IMAGE_MIRRORS[@]}"}; do
  [[ "$mirror" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "Invalid image mirror host: $mirror"
done

if [[ "$ASSUME_YES" != true ]]; then
  AGENT_PORT="$(prompt_value 'QQ Agent console port' "$AGENT_PORT")"
  SNOWLUMA_PORT="$(prompt_value 'SnowLuma WebUI port' "$SNOWLUMA_PORT")"
  NOVNC_PORT="$(prompt_value 'QQ login/noVNC port' "$NOVNC_PORT")"
  ONEBOT_HTTP_PORT="$(prompt_value 'OneBot HTTP port (localhost only)' "$ONEBOT_HTTP_PORT")"
  ONEBOT_WS_PORT="$(prompt_value 'OneBot WebSocket port (localhost only)' "$ONEBOT_WS_PORT")"
fi
for item in \
  "agent:$AGENT_PORT" "SnowLuma:$SNOWLUMA_PORT" "noVNC:$NOVNC_PORT" \
  "OneBot HTTP:$ONEBOT_HTTP_PORT" "OneBot WebSocket:$ONEBOT_WS_PORT"; do
  validate_port "${item%%:*} port" "${item##*:}"
done
ports=("$AGENT_PORT" "$SNOWLUMA_PORT" "$NOVNC_PORT" "$ONEBOT_HTTP_PORT" "$ONEBOT_WS_PORT")
[[ "$(printf '%s\n' "${ports[@]}" | sort -u | wc -l | tr -d ' ')" == 5 ]] \
  || die 'All five host ports must be different'

if [[ "$SOURCE_DIR" != "$APP_DIR" && ( "$APP_DIR" == "$SOURCE_DIR/"* || "$SOURCE_DIR" == "$APP_DIR/"* ) ]]; then
  die 'Source and application directories cannot contain each other; choose another --root-dir'
fi
# 显式轮换凭据时，预检不能拿“新 .env 里的令牌必须等于旧 config.json”来拒绝。
if [[ "$ROTATE_CREDENTIALS" == true ]]; then
  export QQ_AGENT_ALLOW_CREDENTIAL_ROTATION=1
fi
check_host_ownership
if [[ "$CHECK_ONLY" == true ]]; then
  if [[ "$EXISTING_STACK" == true ]]; then
    printf 'Environment: managed stack. Ownership and port checks passed; no deployment changes made.\n'
  else
    printf 'Environment: fresh installation. Ownership and port checks passed; no deployment changes made.\n'
  fi
  exit 0
fi

# 旧值用到时现读，不把凭据长期留在变量里（少一份密钥驻留在进程环境与内存中）
stored_value() { env_value "$ENV_FILE" "$1"; }
if [[ "$EXISTING_STACK" == true && "$ROTATE_CREDENTIALS" != true && "$ASSUME_YES" != true ]]; then
  if confirm 'Rotate Agent, OneBot, SnowLuma and noVNC credentials?' false; then
    ROTATE_CREDENTIALS=true
  fi
fi
if [[ "$EXISTING_STACK" == true && "$ROTATE_CREDENTIALS" != true ]]; then
  AGENT_TOKEN="${AGENT_TOKEN:-$(stored_value QQ_AGENT_CONSOLE_TOKEN)}"
  ONEBOT_TOKEN="${ONEBOT_TOKEN:-$(stored_value ONEBOT_TOKEN)}"
  SNOWLUMA_PASSWORD="${SNOWLUMA_PASSWORD:-$(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD)}"
  VNC_PASSWORD="${VNC_PASSWORD:-$(stored_value VNC_PASSWD)}"
fi

AGENT_TOKEN="${AGENT_TOKEN:-$(random_hex 24)}"
ONEBOT_TOKEN="${ONEBOT_TOKEN:-$(random_hex 32)}"
SNOWLUMA_PASSWORD="${SNOWLUMA_PASSWORD:-Sl-$(random_hex 12)!Aa}"
VNC_PASSWORD="${VNC_PASSWORD:-$(random_hex 4)}"

if [[ "$ASSUME_YES" != true ]] && [[ "$EXISTING_STACK" != true || "$ROTATE_CREDENTIALS" == true ]]; then
  if confirm 'Use custom credentials instead of the generated values?' false; then
    AGENT_TOKEN="$(prompt_secret 'QQ Agent console token')"
    ONEBOT_TOKEN="$(prompt_secret 'Shared OneBot token')"
    SNOWLUMA_PASSWORD="$(prompt_secret 'SnowLuma WebUI password')"
    VNC_PASSWORD="$(prompt_secret 'noVNC password (8 characters recommended)')"
  fi
fi

if [[ "$EXISTING_STACK" == true && "$SNOWLUMA_PASSWORD" != "$(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD)" ]]; then
  SNOWLUMA_CURRENT_PASSWORD="${SNOWLUMA_CURRENT_PASSWORD:-$(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD)}"
  if [[ -z "$SNOWLUMA_CURRENT_PASSWORD" && "$ASSUME_YES" != true ]]; then
    SNOWLUMA_CURRENT_PASSWORD="$(prompt_secret 'Current SnowLuma WebUI password')"
  fi
  [[ -n "$SNOWLUMA_CURRENT_PASSWORD" ]] \
    || die 'The current SnowLuma password is required to rotate existing credentials'
fi

if [[ "$EXISTING_STACK" != true && "$SKIP_MODEL_CONFIG" != true ]]; then
  if [[ "$ASSUME_YES" != true ]]; then
    # 模型这一步做成"可以整段跳过"：Base URL / 模型名都回车即默认，Key 留空＝装完在网页
    # 控制台里配（那边有服务预设与连通性测试，对新人反而更好填）。以前 Key 没默认值，
    # 答不上来直接 die —— 这是小白卡得最多的一步（2026-10-12）。
    printf 'Model setup (press Enter everywhere to skip; configure it later in the web console).\n' >/dev/tty
    MODEL_BASE_URL="$(prompt_value 'Model API base URL' "${MODEL_BASE_URL:-https://api.deepseek.com}")"
    MODEL_NAME="$(prompt_value 'Model name' "${MODEL_NAME:-deepseek-chat}")"
    if [[ -z "$MODEL_API_KEY" ]]; then
      MODEL_API_KEY="$(prompt_secret 'Model API key (blank = configure in the console after install)')"
    fi
    ALLOW_GROUPS="$(prompt_value 'Allowed group IDs, comma-separated (blank to configure later)' "$ALLOW_GROUPS")"
    ALLOW_PRIVATE="$(prompt_value 'Allowed private QQ IDs, comma-separated (blank to configure later)' "$ALLOW_PRIVATE")"
    # Key 留空 = 跳过模型配置（保留已填的 base URL/模型名，别把显式传来的值抹掉）：
    # 走 SKIP_MODEL_CONFIG 会把"还缺模型"写进结尾清单，控制台里补 Key 即可。
    [[ -n "$MODEL_API_KEY" ]] || SKIP_MODEL_CONFIG=true
  fi
  [[ "$SKIP_MODEL_CONFIG" == true || ( -n "$MODEL_BASE_URL" && -n "$MODEL_API_KEY" && -n "$MODEL_NAME" ) ]] \
    || die 'Fresh non-interactive deployment requires --model-base-url, --model-api-key and --model, or --skip-model-config'
fi
if [[ -n "$MODEL_BASE_URL" && ! "$MODEL_BASE_URL" =~ ^https?:// ]] ; then
  die 'Model API base URL must use http:// or https://'
fi
for list in "$ALLOW_GROUPS" "$ALLOW_PRIVATE"; do
  [[ -z "$list" || "$list" =~ ^[0-9]+(,[0-9]+)*$ ]] \
    || die 'Allowlists must contain comma-separated numeric QQ IDs without spaces'
done

validate_secret 'QQ Agent console token' "$AGENT_TOKEN" 16
validate_secret 'OneBot token' "$ONEBOT_TOKEN" 16
validate_secret 'SnowLuma WebUI password' "$SNOWLUMA_PASSWORD" 10
[[ "$SNOWLUMA_PASSWORD" =~ [a-z] && "$SNOWLUMA_PASSWORD" =~ [A-Z] \
  && "$SNOWLUMA_PASSWORD" =~ [^A-Za-z0-9] ]] \
  || die 'SnowLuma WebUI password must contain lowercase, uppercase, and a special character'
validate_secret 'noVNC password' "$VNC_PASSWORD" 8

step 'Preparing directories'
ROOT_CREATED=false
if [[ ! -d "$ROOT_DIR" ]]; then
  run_root mkdir -p "$ROOT_DIR"
  run_root chown "$(id -u):$(id -g)" "$ROOT_DIR"
  ROOT_CREATED=true
fi
[[ -w "$ROOT_DIR" ]] || die "Deployment root is not writable by $(id -un): $ROOT_DIR"
mkdir -p "$APP_DIR" "$AGENT_DATA_DIR" \
  "$SNOWLUMA_DATA_DIR/config" "$SNOWLUMA_DIR/client-config" "$SNOWLUMA_DIR/client-data"
# 只收紧本次创建的根目录；已存在的父目录可能是共享目录（/opt、/mnt/data），
# 不能因为一次部署把别人的目录改成 0700。
[[ "$ROOT_CREATED" != true ]] || chmod 700 "$ROOT_DIR"
chmod 700 "$AGENT_DATA_DIR" "$SNOWLUMA_DIR" "$SNOWLUMA_DATA_DIR" \
  "$SNOWLUMA_DIR/client-config" "$SNOWLUMA_DIR/client-data"

# 退出钩子与栈级锁已在归属判定之前挂好（见上方 EXISTING_STACK 初始化处）。
# 只有拿到锁且确认是 fresh 的实例才允许做清理；抢锁失败的实例退出时不能删赢家的 .env/compose。
if [[ "$EXISTING_STACK" != true ]]; then
  FRESH_STACK_CLEANUP=true
fi
# 只比较摘要/长度，不把旧令牌留在变量里（与“现读现用凭据”的纪律一致）。
OLD_ONEBOT_LEN="$(env_value "$ENV_FILE" ONEBOT_TOKEN | wc -c | tr -d ' ')"
OLD_ONEBOT_DIGEST="$(env_value "$ENV_FILE" ONEBOT_TOKEN | sha256sum | awk '{print $1}')"
NEW_ONEBOT_DIGEST="$(printf '%s' "$ONEBOT_TOKEN" | sha256sum | awk '{print $1}')"
if (( OLD_ONEBOT_LEN > 0 )) && [[ "$OLD_ONEBOT_DIGEST" != "$NEW_ONEBOT_DIGEST" ]]; then
  # compose up 看到配置没变不会重建容器；令牌改了但 SnowLuma 仍读旧 onebot.json
  # 会一直 401，所以这里显式强制重建。
  RECREATE_SNOWLUMA=true
else
  RECREATE_SNOWLUMA=false
fi
if [[ -f "$ENV_FILE" ]]; then
  cp -p "$ENV_FILE" "$ENV_FILE.pre-deploy"
fi
cat >"$ENV_FILE.tmp" <<EOF
SNOWLUMA_IMAGE=$IMAGE
SNOWLUMA_CONTAINER=qq-agent-snowluma
PUBLISH_HOST=$PUBLISH_HOST
AGENT_PORT=$AGENT_PORT
QQ_AGENT_SERVICE=$SERVICE
SNOWLUMA_UID=$(id -u)
SNOWLUMA_GID=$(id -g)
SNOWLUMA_WEBUI_HOST=0.0.0.0
SNOWLUMA_WEBUI_PORT=5099
SNOWLUMA_WEBUI_HOST_PORT=$SNOWLUMA_PORT
SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=$SNOWLUMA_PASSWORD
SNOWLUMA_LOG_LEVEL=$SNOWLUMA_LOG_LEVEL
SNOWLUMA_SCREEN=$SNOWLUMA_SCREEN
SNOWLUMA_HOOK_AUTOLOAD=1
SNOWLUMA_ONEBOT_HOST=0.0.0.0
SNOWLUMA_TELEMETRY=0
VNC_PASSWD=$VNC_PASSWORD
NOVNC_PORT=$NOVNC_PORT
ONEBOT_HTTP_PORT=$ONEBOT_HTTP_PORT
ONEBOT_WS_PORT=$ONEBOT_WS_PORT
ONEBOT_TOKEN=$ONEBOT_TOKEN
QQ_AGENT_CONSOLE_TOKEN=$AGENT_TOKEN
EOF
mv "$ENV_FILE.tmp" "$ENV_FILE"
# .env 已重写（可能带新凭据）：先置位，再做 chmod；chmod 失败时失败退出仍能回拷 .pre-deploy。
ENV_REWRITTEN=true
chmod 600 "$ENV_FILE"

cat >"$COMPOSE_FILE.tmp" <<'EOF'
services:
  snowluma:
    image: "${SNOWLUMA_IMAGE}"
    container_name: "${SNOWLUMA_CONTAINER}"
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    shm_size: 1gb
    ulimits:
      nofile:
        soft: 65536
        hard: 1048576
    cap_add:
      - SYS_PTRACE
    security_opt:
      - seccomp=unconfined
    environment:
      VNC_PASSWD: "${VNC_PASSWD}"
      SNOWLUMA_ONEBOT_HOST: "${SNOWLUMA_ONEBOT_HOST}"
      SNOWLUMA_UID: "${SNOWLUMA_UID}"
      SNOWLUMA_GID: "${SNOWLUMA_GID}"
      SNOWLUMA_WEBUI_HOST: "${SNOWLUMA_WEBUI_HOST}"
      SNOWLUMA_WEBUI_PORT: "${SNOWLUMA_WEBUI_PORT}"
      SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: "${SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD}"
      SNOWLUMA_LOG_LEVEL: "${SNOWLUMA_LOG_LEVEL}"
      SNOWLUMA_SCREEN: "${SNOWLUMA_SCREEN}"
      SNOWLUMA_HOOK_AUTOLOAD: "${SNOWLUMA_HOOK_AUTOLOAD}"
      SNOWLUMA_QQ_FLAGS: --disable-gpu --disable-software-rasterizer --disable-gpu-compositing
      SNOWLUMA_TELEMETRY: "${SNOWLUMA_TELEMETRY}"
    ports:
      - "${PUBLISH_HOST}:${NOVNC_PORT}:6081"
      - "${PUBLISH_HOST}:${SNOWLUMA_WEBUI_HOST_PORT}:5099"
      - "127.0.0.1:${ONEBOT_HTTP_PORT}:3000"
      - "127.0.0.1:${ONEBOT_WS_PORT}:3001"
    volumes:
      - ./data:/app/data
      - ./client-config:/app/.config
      - ./client-data:/app/.local/share
EOF
mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"
chmod 600 "$COMPOSE_FILE"

# 清理钩子已提前到 .env 写盘之前挂载（deploy_all_exit，见上）；Agent 装好后在下方撤销标志。
if ! docker_ready && ! sudo_docker_ready; then install_docker; fi
docker_ready || sudo_docker_ready || die 'Docker installation completed but the daemon is unavailable'
docker_call compose version >/dev/null 2>&1 || install_compose
docker_call compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'

# 拉一个引用：每个地址最多 3 次，退避 3 / 6 秒
pull_with_retry() {
  local ref="$1" attempt
  for attempt in 1 2 3; do
    if docker_call pull "$ref"; then return 0; fi
    ((attempt < 3)) || return 1
    sleep $((attempt * 3))
  done
  return 1
}

# 换成镜像站之后同步 .env：compose 走 --env-file，里面也得是同一个引用；权限保持不变
update_env_image() {
  local tmp="$ENV_FILE.tmp.$$"
  awk -v image="$IMAGE" -F= 'BEGIN { OFS="=" } $1 == "SNOWLUMA_IMAGE" { print "SNOWLUMA_IMAGE=" image; next } { print }' \
    "$ENV_FILE" >"$tmp" || return 1
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# 连不上 Docker Hub 时的落地方案（国内服务器常见；内置站已在上面自动试过一轮）
image_pull_hint() {
  cat >&2 <<'HINT'

拉取 SnowLuma 镜像失败。国内/受限网络连不上 Docker Hub（registry-1.docker.io）很常见；
内置的公共加速站已经自动试过一轮（docker.1panel.live、docker.m.daocloud.io），都没拉下来。
下面三种办法任选一种，然后重跑 deploy-all.sh：

  1) 换成你信得过的加速器地址重跑（云厂商给的那个通常最稳）：
       QQ_AGENT_IMAGE_MIRROR=<mirror> bash deploy-all.sh
     可以给多个、逗号分隔；你自己的排在前面，内置的仍在其后兜底。
     或直接给完整地址：
       bash deploy-all.sh --image <mirror>/motricseven7/snowluma:v1.14.22

  2) 给 Docker 配全局加速器（配一次，之后所有拉取都走它）：
       sudo tee /etc/docker/daemon.json <<'JSON'
       { "registry-mirrors": ["https://<你的加速器地址>"] }
       JSON
       sudo systemctl restart docker

  3) 在能联网的机器上拉好再带过来：
       docker pull motricseven7/snowluma:v1.14.22
       docker save motricseven7/snowluma:v1.14.22 | gzip > snowluma.tgz
       gunzip -c snowluma.tgz | docker load     # 在目标机上执行

镜像站由第三方提供：内置的两家只是兜底，不放心就用 --image-mirror 换成你自己的。
HINT
}

step "Downloading SnowLuma image $IMAGE"
PULLED=false
if docker_call image inspect "$IMAGE" >/dev/null 2>&1; then
  # 离线/内网按文档 docker load 过的镜像：本地已有就不要强制访问 registry。
  info "Using locally loaded image: $IMAGE"
  PULLED=true
elif pull_with_retry "$IMAGE"; then
  PULLED=true
else
  # .env 里存的可能是"上次走通的镜像站前缀 + 基础引用"——默认走内置兜底之后，这是国内新装的
  # 常态。不先把认得的前缀剥掉，换站重跑会把旧前缀原样拼给每个镜像站：旧站一挂就永远换不到
  # 新站（2026-10-12 审查：hint 首推的 QQ_AGENT_IMAGE_MIRROR=<mirror> 同样会失效）。
  # 只剥"当前列表里认得的"前缀——真正的自定义 registry 引用不猜、照旧原样重试。
  BASE_IMAGE="$IMAGE"
  for known in "${IMAGE_MIRRORS[@]}"; do
    case "$BASE_IMAGE" in
      "$known"/*) BASE_IMAGE="${BASE_IMAGE#"$known"/}"; break ;;
    esac
  done
  for mirror in "${IMAGE_MIRRORS[@]}"; do
    # 只在基础引用还没有 registry host 时加前缀：≥2 个斜杠 = 真正的自定义 registry
    #（或没剥掉的前缀），保持原样，不能拿第三方前缀去套别人的命名空间。
    case "$BASE_IMAGE" in
      */*/*) candidate="$BASE_IMAGE" ;;
      *) candidate="${mirror%/}/$BASE_IMAGE" ;;
    esac
    # 直连那一步已经试过这个引用（剥离后重拼可能等于原值）就别再试一遍
    [[ "$candidate" == "$IMAGE" ]] && continue
    # 本地已有镜像站前缀的同一镜像时别访问那个可能已下线的站
    if docker_call image inspect "$candidate" >/dev/null 2>&1; then
      info "Using locally loaded image: $candidate"
      IMAGE="$candidate"
      update_env_image || true
      PULLED=true
      break
    fi
    step "Retrying through image mirror $mirror"
    if pull_with_retry "$candidate"; then
      IMAGE="$candidate"
      update_env_image || true
      PULLED=true
      break
    fi
  done
fi
if [[ "$PULLED" != true ]]; then
  image_pull_hint
  die "Failed to download SnowLuma image ($IMAGE); see the hint above"
fi

step 'Installing QQ Agent'
export QQ_AGENT_CONSOLE_TOKEN="$AGENT_TOKEN"
export QQ_AGENT_ONEBOT_TOKEN="$ONEBOT_TOKEN"
export QQ_AGENT_ONEBOT_HTTP_TOKEN="$ONEBOT_TOKEN"
export QQ_AGENT_ONEBOT_HTTP_URL="http://127.0.0.1:$ONEBOT_HTTP_PORT"
export QQ_AGENT_ONEBOT_WS_URL="ws://127.0.0.1:$ONEBOT_WS_PORT"
export QQ_SNOWLUMA_WEBUI_URL="http://127.0.0.1:$SNOWLUMA_PORT"
# 协议端更新器用这个端口做就绪探测；只在 URL 里带端口不够（自定义 --snowluma-port 时
# 会一直探默认 5099 → 超时回滚，2026-10 审查 P2）。
export QQ_AGENT_WEBUI_PORT="$SNOWLUMA_PORT"
[[ -z "$MODEL_BASE_URL" ]] || export QQ_AGENT_MODEL_BASE_URL="$MODEL_BASE_URL"
# 模型 Key 不走子进程环境（/proc/<pid>/environ 里读得到）：写 0600 临时文件，
# 部署脚本按 QQ_AGENT_MODEL_KEY_FILE 读，脚本退出时删掉。
if [[ -n "$MODEL_API_KEY" ]]; then
  MODEL_KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/qq-agent-model-key.XXXXXX")"
  printf '%s' "$MODEL_API_KEY" >"$MODEL_KEY_FILE"
  chmod 600 "$MODEL_KEY_FILE"
  export QQ_AGENT_MODEL_KEY_FILE="$MODEL_KEY_FILE"
fi
[[ -z "$MODEL_NAME" ]] || export QQ_AGENT_MODEL="$MODEL_NAME"
[[ -z "$ALLOW_GROUPS" ]] || export QQ_AGENT_ALLOW_GROUPS="$ALLOW_GROUPS"
[[ -z "$ALLOW_PRIVATE" ]] || export QQ_AGENT_ALLOW_PRIVATE="$ALLOW_PRIVATE"
# 端口每一轮都显式传给 deploy.sh：.env 在重跑时已经写成了新端口，如果 deploy.sh 仍沿用
# config.json 的旧端口，部署会"成功"但随后按新端口做健康检查必然超时，.env 与 config.json
# 从此不一致，后续所有预检都会拒绝（2026-10 审查 P1）。
DEPLOY_ARGS=(--install-dir "$APP_DIR" --data-dir "$AGENT_DATA_DIR" --service "$SERVICE" --port "$AGENT_PORT")
if [[ "$EXISTING_STACK" != true || "$PUBLISH_EXPLICIT" == true ]]; then
  # 新装按 --publish/--loopback 落 host；已有安装只有显式传了 --publish/--loopback 才改，
  # 否则沿用 config.json 里的 host（避免一次普通重跑把用户收紧过的绑定改回去）。
  DEPLOY_ARGS+=(--host "$PUBLISH_HOST")
fi
bash "$SOURCE_DIR/deploy.sh" "${DEPLOY_ARGS[@]}"
# Agent 已装好，栈不再是"半成品"：撤销失败清理，保留 .env / compose。
FRESH_STACK_CLEANUP=false
# .env 的新凭据自此生效（deploy.sh 已完成、config.json 已含配套令牌）：此后失败不再回拷。
DEPLOY_COMPLETED=true

NODE_BIN="$(tr -d '\r\n' <"$APP_DIR/.deployment-node")"
if [[ "$EXISTING_STACK" != true ]]; then
  "$APP_DIR/manage.sh" observe
fi
"$NODE_BIN" "$SOURCE_DIR/scripts/configure-snowluma.mjs" \
  --data-dir "$SNOWLUMA_DATA_DIR" \
  --http-port 3000 \
  --ws-port 3001

step 'Starting SnowLuma and OneBot'
COMPOSE_UP=(--env-file .env up -d)
if [[ "$RECREATE_SNOWLUMA" == true ]]; then
  COMPOSE_UP+=(--force-recreate snowluma)
fi
(cd "$SNOWLUMA_DIR" && docker_call compose "${COMPOSE_UP[@]}")
wait_http "http://127.0.0.1:$SNOWLUMA_PORT/api/ui/public" 90 \
  || die "SnowLuma WebUI did not become ready; run: cd $SNOWLUMA_DIR && docker compose logs"
wait_http "http://127.0.0.1:$NOVNC_PORT/" 30 \
  || die "noVNC did not become ready; run: cd $SNOWLUMA_DIR && docker compose logs"
# 2026-10-06 复审 P3：原判据用 stored_value 读 SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD，但 .env
# 已在 613-636 行把该键改写成新密码，于是「新密码 != stored_value」恒为假，整个轮换分支
# （含 rotate-snowluma-password.mjs）永不执行：容器里还是旧密码，而 .env 与
# deployment-access.txt 记的是新密码，凭据静默失配且无任何报错。这里改用 553-556 行
# 在改写 .env 之前捕获的旧密码 SNOWLUMA_CURRENT_PASSWORD 来比较。
# 另加 -n 守卫：密码未变时 553 行分支不进入，该变量为空，若不判空则空串 != 新密码 会误触发
# 轮换（重跑脚本是常态，不能每次都轮换）；真正需要轮换却取不到旧密码时，558 行已提前 die。
if [[ "$EXISTING_STACK" == true && -n "$SNOWLUMA_CURRENT_PASSWORD" \
  && "$SNOWLUMA_CURRENT_PASSWORD" != "$SNOWLUMA_PASSWORD" ]]; then
  # 密码走环境变量而不是命令行参数：/proc/<pid>/cmdline 对本机所有用户可读。
  export QQ_AGENT_SNOWLUMA_CURRENT_PASSWORD="$SNOWLUMA_CURRENT_PASSWORD"
  export QQ_AGENT_SNOWLUMA_PASSWORD="$SNOWLUMA_PASSWORD"
  rotate_args=(--url "http://127.0.0.1:$SNOWLUMA_PORT")
  [[ -z "$SNOWLUMA_TOTP" ]] || rotate_args+=(--totp "$SNOWLUMA_TOTP")
  if ! "$NODE_BIN" "$SOURCE_DIR/scripts/rotate-snowluma-password.mjs" "${rotate_args[@]}"; then
    # 2026-10-09 审查：原先这里回拷 .env 是**假回滚** —— 此刻 config.json / compose / 容器
    # 都已是新凭据，只退回 .env 会让下次部署被自家预检拒（"凭据被外部改过"），而新的控制台
    # 令牌又只留在 config.json 里、access 文件还没生成。保持三方一致（都用新凭据）才是可恢复
    # 状态：WebUI 密码维持旧值，带上**实际在用**的旧密码重跑即可完成轮换。
    KEEP_ENV_ON_ROTATE_FAILURE=true
    printf '控制台令牌已更新；新令牌见 %s/config.json 的 server.token（或 %s/console-access.txt）。SnowLuma WebUI 密码仍是旧值。\n' \
      "$AGENT_DATA_DIR" "$AGENT_DATA_DIR" >&2
    die 'SnowLuma password rotation failed. Every other credential was left in place and stays consistent; the WebUI password is unchanged. Retry with --snowluma-current-password set to the password the WebUI actually uses.'
  fi
fi
systemctl --user restart "$SERVICE.service"
wait_http "http://127.0.0.1:$AGENT_PORT/healthz" 30 \
  || die "QQ Agent did not become ready; run: $APP_DIR/manage.sh logs"

# 优先 IPv4：IPv6 直接拼 http://240e:... 是非法 URL，install.sh 的端口正则也匹配不到。
HOST_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
HOST_IP="${HOST_IP:-$(hostname -I 2>/dev/null | awk '{print $1}' || true)}"
HOST_IP="${HOST_IP:-127.0.0.1}"
if [[ "$PUBLISH_HOST" == "127.0.0.1" ]]; then
  HOST_IP="127.0.0.1"
  PUBLISH_NOTE="bound to 127.0.0.1 only — use an SSH tunnel (console-tunnel.bat / ops console) or re-run with --publish"
else
  PUBLISH_NOTE="bound to 0.0.0.0 — restrict the cloud security group / firewall to trusted sources"
fi
MODE="$("$NODE_BIN" -e 'const c=require(process.argv[1]);process.stdout.write(c.runtime.mode)' \
  "$AGENT_DATA_DIR/config.json")"
cat >"$ACCESS_FILE.tmp" <<EOF
QQ Agent full-stack access
Publish host: $PUBLISH_HOST
Agent console: http://$HOST_IP:$AGENT_PORT
Agent token: $AGENT_TOKEN
SnowLuma WebUI: http://$HOST_IP:$SNOWLUMA_PORT
SnowLuma password: $SNOWLUMA_PASSWORD
QQ login/noVNC: http://$HOST_IP:$NOVNC_PORT
noVNC password: $VNC_PASSWORD
OneBot HTTP: http://127.0.0.1:$ONEBOT_HTTP_PORT
OneBot WebSocket: ws://127.0.0.1:$ONEBOT_WS_PORT
OneBot token: $ONEBOT_TOKEN
Mode: $MODE
EOF
mv "$ACCESS_FILE.tmp" "$ACCESS_FILE"
chmod 600 "$ACCESS_FILE"
# 成功收尾：.env 已是当前凭据，旧 .pre-deploy 里还有上一版令牌/密码，不应长期留在栈目录。
rm -f "$ENV_FILE.pre-deploy"

printf '\nDeployment complete. Agent mode: %s.\n' "$MODE"
printf 'Bind: %s\n' "$PUBLISH_NOTE"
printf '1. Open QQ login:     http://%s:%s\n' "$HOST_IP" "$NOVNC_PORT"
printf '2. Scan the QR code and finish QQ login.\n'
printf '3. Open Agent console: http://%s:%s\n' "$HOST_IP" "$AGENT_PORT"
printf '4. Verify OneBot is connected in the Agent console.\n'
if [[ "$SKIP_MODEL_CONFIG" == true || -z "$ALLOW_GROUPS$ALLOW_PRIVATE" ]]; then
  printf '5. Complete the model/allowlist fields that were intentionally left blank.\n'
fi
printf '6. Activate only after excluding the old bot: %s/manage.sh activate --confirm-exclusive\n' "$APP_DIR"
printf 'Credentials: %s\n' "$ACCESS_FILE"

if [[ "$ASSUME_YES" != true ]]; then
  printf '\nComplete QQ login in noVNC, then press Enter to verify the OneBot connection: ' >/dev/tty
  IFS= read -r _ </dev/tty || true
  CONNECTED=false
  for _ in {1..30}; do
    if onebot_ready; then CONNECTED=true; break; fi
    sleep 1
  done
  if [[ "$CONNECTED" == true ]]; then
    printf 'OneBot login verified.\n'
    if [[ "$MODE" != active && "$SKIP_MODEL_CONFIG" != true && -n "$ALLOW_GROUPS$ALLOW_PRIVATE" ]] \
      && confirm 'Activate QQ Agent now? Confirm the old bot no longer handles these chats.' false; then
      "$APP_DIR/manage.sh" activate --confirm-exclusive
    fi
  else
    printf 'OneBot is not logged in yet. The services remain installed in observe mode.\n' >&2
  fi
fi
