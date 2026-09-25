# 宝塔面板部署

宝塔面板（含 aaPanel）不改变部署方式。底层仍为同一套 systemd 与包管理器，`deploy.sh` /
`deploy-all.sh` 可直接使用。差异集中在宝塔默认以 root 操作，并倾向由面板托管进程这一习惯上。
本文仅说明这些差异；通用步骤、数据与备份说明见 [LINUX.md](LINUX.md)。

## 概要

- **兼容性**：宝塔运行在同一套 Linux 与 systemd 之上，`deploy.sh` / `deploy-all.sh` 可直接使用。
- **安装方式**：创建 `qqagent` 用户，通过 SSH 登录该用户执行 `deploy.sh`；宝塔仅用于查看文件、
  放行端口与配置反向代理。
- **禁止做法**：不使用宝塔的 Node 项目或 PM2 启动本项目，不以 root 身份部署。

### 常见问题

**在宝塔中创建 Node 项目并启动**
不推荐。项目注册的是 systemd 用户服务，`manage.sh` 与自动更新均依赖该服务
（`scripts/manage.mjs` 里的 `systemctl --user` / `journalctl --user` 调用）。使用 PM2 会绕过部署前代码快照与失败回滚、健康检查、
unit 的自动重启，以及 Release 驱动的自动更新。

**宝塔「安全」页面的端口放行**
默认无需放行任何端口。控制台通过 SSH 隧道访问（`console-tunnel.bat` 或
`node src/ops.js console`）。仅在配置域名反向代理时需要放行端口，并且必须关闭
`proxy_buffering`，否则控制台的事件流将停止更新。

**`qqagent` 用户与 root 部署**
`deploy-all.sh` 开头直接拒绝 root（`((EUID == 0))` 即退出），`docs/LINUX.md` 的 Requirements 亦要求以服务用户身份部署。
更常见的运维问题是：以 root 执行 `manage.sh` 时查询的是 root 自身的 user manager，
因而误报「服务不存在」，而服务实际运行正常。

**宝塔 Docker 管理器安装 SnowLuma**
可以安装，并建议先完成安装，再执行 `deploy-all.sh --check-only` 探测，以避免两套 Docker
来源并存。安装完成后不得通过面板修改 SnowLuma 容器的端口或挂载，否则下次部署的归属校验
会报错退出。

## 结论：宝塔仅作面板，进程交由 systemd 管理

以下三项操作不可执行：

1. 使用宝塔的「Node 项目」或 PM2 启动本项目；
2. 在宝塔「计划任务」中重复创建更新任务；
3. 以 root 身份部署。

原因在于项目注册的是 **systemd 用户服务**：`scripts/install-service.mjs` 写入
`~/.config/systemd/user/qq-agent-linux.service`，`WantedBy=default.target`；运维入口
`manage.sh` 硬编码 `systemctl --user` / `journalctl --user`（`scripts/manage.mjs`），
自动更新由配套的 user timer 承担。改用 PM2 会绕过以下机制：部署前代码快照与失败回滚、
健康检查、unit 中的 `Restart=on-failure` 与 `NoNewPrivileges`，以及 Release 驱动的自动更新。
此外，`deploy-all.sh` 开头明确拒绝 root（`((EUID == 0))` 即退出），`docs/LINUX.md` 的 Requirements 亦要求以服务用户身份部署。

## 部署差异对照

| 项目的假设 | 宝塔面板默认 | 处理方式 |
| --- | --- | --- |
| 以非 root 服务用户部署 | 全程以 root 操作 | 创建 `qqagent` 用户，通过 SSH 登录后执行脚本 |
| `systemctl --user` 可用 | 网页终端通常不是登录会话 | 改用 SSH；或参见文末的 root 方案 |
| 依赖 `rsync`（硬检查）、`xz`（解压 Node） | 精简模板通常缺失 | 先执行 `apt install` |
| 脚本不改动防火墙，仅绑定 `127.0.0.1` | 面板「安全」页管理 ufw/iptables | 默认使用 SSH 隧道，无需放行端口 |
| 根目录默认 `/mnt/data/qq-agent` | 该路径通常不存在 | 使用 `--root-dir` 修改，优先选择 `.bat` 可识别的路径 |
| 缺 Node 时脚本自行下载并校验 22.23.2 | 面板 Node 管理器版本可能偏低 | 不使用面板的 Node 管理器 |

## 一、前置检查

```bash
systemctl --user show-environment >/dev/null 2>&1 \
  && echo "systemd 用户服务：可用" \
  || echo "systemd 用户服务：不可用（别在宝塔网页终端跑，改用 SSH 登录）"

for c in rsync curl tar xz sha256sum; do
  command -v "$c" >/dev/null && echo "OK  $c" || echo "缺  $c"
done
```

`deploy.sh:77-79` 在执行部署前即要求 `systemctl`、`systemctl --user` 与 `rsync` 三者可用，
缺少任何一项都会打印具体原因后退出；**本脚本不会安装系统包**。全栈安装额外需要 `realpath`
与 `ss`（iproute2）。

端口默认值如下：控制台 `3210`，SnowLuma WebUI `5099`，noVNC `6081`，协议端（OneBot）
`3000`/`3001` 仅绑定 `127.0.0.1`。需确认对外开放的三个端口（3210 / 5099 / 6081）未被宝塔
的其它服务占用。面板自身默认使用 `8888`，网站使用 `80/443`，MySQL 使用 `3306`，通常不会
冲突。

## 二、服务用户创建与 linger 开启（以 root 执行一次）

```bash
# Debian / Ubuntu
adduser --disabled-password --gecos "" qqagent
# CentOS / Rocky / AlmaLinux
useradd -m -s /bin/bash qqagent

mkdir -p /mnt/data/qq-agent
chown -R qqagent:qqagent /mnt/data/qq-agent
loginctl enable-linger qqagent
```

linger 是服务在开机后无需用户登录即可持续运行的前提。预先开启 linger 可避免使用 `sudo`：
`deploy.sh` 仅在 linger 未开启时才尝试执行 `sudo loginctl enable-linger`（安装收尾处）。

若服务 unit 配置了 `NoNewPrivileges=true`（本指南第 273 行附近的加固建议），服务重启后由 systemd 拉起的进程无法执行 `sudo`——`deploy.sh` 对此做了预检：此时会跳过 `sudo` 并提示手动执行一次 `loginctl enable-linger`，linger 未开只影响下次开机自启，不会让本次部署或手动更新回滚（Issue #15）。

父目录同样需要在此创建。`deploy.sh` 会自行 `mkdir -p` 安装目录与数据目录，但 `/mnt` 属主为
root，以 `qqagent` 身份执行时无法创建 `data` 这一级目录。`docs/LINUX.md` 要求「先以合适
的属主创建父目录」，即指此处。

同时将 `console-tunnel.bat` 使用的 SSH 公钥配置给 `qqagent`，写入
`/home/qqagent/.ssh/authorized_keys`（即 `~qqagent` 的家目录下）。隧道使用该密钥登录。

## 三、系统依赖安装

```bash
apt update && apt install -y rsync curl tar xz-utils
```

`xz-utils` 不是可选项。脚本下载的 Node 压缩包为 `.tar.xz` 格式，使用 `tar -xJf` 解压，
缺少 `xz` 时该步骤失败。

## 四、QQ Agent 部署（以 qqagent 身份）

```bash
su - qqagent          # 或 ssh qqagent@服务器地址
git clone https://github.com/sakurawwwxh/qq-agent-plus.git ~/qq-agent-plus
cd ~/qq-agent-plus

bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir    /mnt/data/qq-agent/data \
  --host 127.0.0.1 --port 3210
```

要点如下：

- **目录**：`/mnt/data/qq-agent` 与 `/data/qq-agent` 是 `console-tunnel.bat:46` 读取令牌的
  两个路径，应优先选择；机器上这两个挂载点均不存在时，改用其它绝对路径（如 `/opt/qq-agent`）。
  路径不得包含空格、`%` 或引号；SQLite 必须位于本机磁盘，不能使用 NFS/SMB。不得放入
  `/www/wwwroot`，该目录为宝塔站点目录，会被网站备份与防篡改逻辑一并扫描。
- **`--host 127.0.0.1` 保持默认**：控制台不对外开放，访问通过下一节的隧道实现。使用同机
  nginx 反向代理时目标亦为 `127.0.0.1`，同样无需对外开放。后续更新若不显式传入
  `--host`/`--port`，脚本会沿用 `config.json` 中记录的现值并打印提示，不会退回默认值。
- **Node 由脚本准备**：找不到合格的 Node 时，脚本会下载并校验 `22.23.2` 至
  `INSTALL_DIR/.runtime`。要求为 ≥22.13 且 `node:sqlite` 可用（`package.json` 的 `engines`）。
- **首次启动模式**：首次安装以 `observe` 模式启动，机器人不会发言；确认后再执行激活。
- **GitHub 不可达时**：将 Release 源码包上传并解压，在解压出的目录中执行同一条 `deploy.sh`。
  自动更新依赖 GitHub，网络不通时保留现状并在控制台说明原因。

## 五、控制台访问：无需开放端口

与裸机部署一致，推荐入口为 SSH 隧道；[AGENTS.md](../AGENTS.md) 的口径是不要求服务器开放
任何公网端口。

- **Windows**：使用仓库根目录的 `console-tunnel.bat`，双击后输入 `qqagent@服务器地址`；
  或使用命令行 `console-tunnel.bat qqagent@服务器地址`（写入 `.console-tunnel.cfg`，
  后续可直接双击）。
- **macOS / Linux / 本机有 Node**：`SSHHOST=qqagent@服务器地址 node src/ops.js console --open`。
- **手工方式**：

  ```bash
  ssh -L 3210:127.0.0.1:3210 -L 5099:127.0.0.1:5099 -L 6081:127.0.0.1:6081 qqagent@服务器地址
  ```

  随后访问 `http://127.0.0.1:3210`。扫码登录 QQ 使用 `6081`，**不得**将 noVNC 暴露到公网。

**目录变更的影响**：`console-tunnel.bat:46` 仅在
`/mnt/data/qq-agent/data/console-access.txt` 与 `/data/qq-agent/data/console-access.txt`
两处查找令牌。安装到其它路径时隧道仍可使用，但不支持免登录，需手动获取令牌：

```bash
cat /安装根目录/data/console-access.txt      # 查看 Token 那一行
bash /安装根目录/app/manage.sh token         # 等价
```

或在客户端设置 `QQ_AGENT_CONSOLE_TOKEN=<令牌>`。`.bat` 使用密钥登录（`BatchMode=yes`），
读取令牌的账号须能读取 `data/`（权限 `0600`，属主 `qqagent`），因此隧道账号使用 `qqagent`
或 root 最为简便。

### 域名与 HTTPS：宝塔反向代理

在「网站 → 反代」中将目标设为 `http://127.0.0.1:3210`，并关闭缓存。控制台的事件流为
SSE（`src/console/app.js` 的 `/api/events` 路由，前端 `ui/app.js` 的 `EventSource`），宝塔生成的 nginx
配置默认开启 `proxy_buffering`，会导致页面显示停止更新。在反向代理配置中补充以下内容：

```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

登录 cookie 包含 `HttpOnly; SameSite=Strict`，不含 `Secure` 标志（`src/console/app.js` 的 `setConsoleCookie`），
因此 HTTP 反向代理下登录正常，启用 HTTPS 亦不受影响。首次访问使用
`https://<域名>/?token=<令牌>` 即可免登录，此后浏览器保留 30 天。反向代理一旦对公网开放，
控制台令牌即为唯一凭据，必须仅限本人使用。

## 六、全栈部署（SnowLuma / OneBot / Docker）

`deploy-all.sh` 拒绝 root 身份，需按以下顺序操作：

1. 先在宝塔「Docker」管理器中安装 Docker 与 Compose v2，避免脚本再通过 apt 安装第二套；
2. 执行 `usermod -aG docker qqagent`，然后**重新登录** `qqagent`（组变更需在新会话中生效）；
3. 执行只读探测（非交互、不修改任何内容）：

   ```bash
   bash deploy-all.sh --check-only --root-dir /mnt/data/qq-agent
   ```

4. 执行正式安装（需要 TTY，可使用 SSH 或宝塔网页终端，但必须以 `qqagent` 身份运行）：

   ```bash
   bash deploy-all.sh --root-dir /mnt/data/qq-agent \
     --agent-port 3210 --snowluma-port 5099 --novnc-port 6081 \
     --model-base-url https://api.deepseek.com \
     --model-api-key "$DEEPSEEK_API_KEY" --model deepseek-chat \
     --allow-groups 123456789
   ```

5. 通过 `6081` 隧道打开 noVNC 扫码登录 QQ，返回终端按 Enter，再按提示执行激活：

   ```bash
   /mnt/data/qq-agent/app/manage.sh activate --confirm-exclusive
   ```

`--yes` 无人值守模式必须显式提供模型参数（或使用 `--skip-model-config`）；白名单留空等同于
默认不响应任何会话。宝塔 Docker 管理器安装的 Docker 可以被复用，SnowLuma 容器也会出现在
面板的容器列表中，但**不得**通过面板修改其端口或挂载，否则下次 `deploy-all.sh` 的归属校验
会报错退出（见 [LINUX.md](LINUX.md) 的 Existing Environment Protection）。

## 七、运维与自动更新

```bash
cd /mnt/data/qq-agent/app
bash manage.sh status        # 或 logs / health / token / restart / observe
bash manage.sh backup /path/to/backup-dir
```

以上命令均通过 `systemctl --user` 执行（`scripts/manage.mjs`），**必须在 `qqagent`
的登录会话中执行**。以 root 身份直接执行时，查询的是 root 自身的 user manager，会报
「服务不存在」，而服务实际运行正常，容易造成误判。

自动更新使用项目自带的 GitHub Release 定时器（在控制台「控制 → 更新部署」中配置管理员后可
开启），**不得**在宝塔「计划任务」中重复创建。宝塔「文件」管理器以 root 读取 `data/` 无异常，
但不得通过面板修改这些文件的属主，否则服务用户可能无法读取自己的数据。

## 八、常见报错对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Failed to connect to bus` / 提到 `XDG_RUNTIME_DIR` | 在非登录会话（宝塔网页终端）中调用 `systemctl --user` | 改用 SSH 登录；或采用文末的 root 方案 |
| `deploy.sh` 刚开始即退出 | `deploy.sh:77-79` 的 `systemctl` / `systemctl --user` / `rsync` 检查未通过（脚本会打印缺哪一项） | 按提示安装 `rsync`，或改用 SSH 登录会话 |
| `Deployed Node.js runtime is unavailable` | 在源码目录而非安装目录执行了 `manage.sh`（该目录下没有 `.deployment-node`） | 切到安装目录执行；**不要**因此重跑 `deploy.sh` |
| `Run as the service user, not root` | `deploy-all.sh:385` | 执行 `su - qqagent` 后重新运行 |
| 解压 Node 失败、提示 `xz` | 缺少 `xz-utils` | 执行 `apt install -y xz-utils` |
| 控制台打开正常但数据不刷新 | 反向代理缓冲了 SSE | 在反向代理配置中加入 `proxy_buffering off;` |
| 机器人不回复 | 仍处于 `observe` 模式，或白名单为空 | 执行 `manage.sh activate --confirm-exclusive`，并在控制台配置白名单 |
| `manage.sh` 提示服务不存在，但进程在运行 | 以 root 执行，查询的是 root 的 user manager | 改用 `qqagent` 身份执行 |
| 隧道连通但需要手动登录 | 安装目录已变更，`.bat` 找不到令牌 | 手动获取令牌，或设置 `QQ_AGENT_CONSOLE_TOKEN` |
| 全栈安装中途退出并提示已有非受管安装 | 目录中存在不属于本安装器的数据或容器 | 不得删除数据或伪造元数据绕过；按提示使用 `deploy.sh` 更新，或先人工确认残留状态 |

## 九、备选方案：以 root 用户部署（不推荐）

在机器上确实没有第二个可用账号时，可执行以下操作：

```bash
apt install -y rsync curl tar xz-utils
loginctl enable-linger root
export XDG_RUNTIME_DIR=/run/user/0          # 每次新开 shell 都要设，否则 manage.sh 找不到服务

cd /root/qq-agent-plus
bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir    /mnt/data/qq-agent/data \
  --host 127.0.0.1 --port 3210
```

代价如下：机器人以 root 身份常驻（unit 中的 `NoNewPrivileges`、`UMask=0077` 仍然生效，
但进程身份为 root）；`deploy-all.sh` 依然拒绝 root，因此**全栈模式不支持该方案**，只能以
非 root 用户安装。存在独立服务用户时，应采用第四节所述方式。
