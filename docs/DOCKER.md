# Docker 部署

> 适用：宿主机只装了 Docker（含 Compose v2），不想安装 Node、systemd 服务或改主机环境。
> 裸机/宝塔部署仍走 [LINUX.md](LINUX.md) 与 `install.sh`；两条路线的数据格式一致。

## 0. 前提

- Docker Engine 27+（或当前稳定版 Docker Desktop），Compose v2.3.3+，`docker compose version` 可用。
  Engine 24.0 已停止维护，不建议作为新部署下限。
  普通用户还要能执行 Docker 命令：如果 `docker ps` 报 permission denied，执行
  `sudo usermod -aG docker $USER` 后重新登录，或者所有命令前加 `sudo`。
- 一个 QQ 账号（扫码登录协议端）。
- 一个 OpenAI 兼容的模型 API（Base URL、Key、模型名）。

> 没装过 Docker、也不想处理 SSH 隧道的新手，优先用 `install.sh` 的裸机一键安装；
> Docker 路径适合“已经有 Docker、会用 SSH”的用户。

镜像里已经包含运行期依赖与 `ffmpeg`；宿主机不需要 Node、git、curl、openssl。
镜像约 1.2GB（磁盘）、压缩下载约 310MB，多架构（amd64/arm64）。体积主要来自
ffmpeg 及其依赖（约 470MB 的层）；不提供精简变体，以保证语音、视频、GIF 与大图降采样
与裸机一致。

## 1. 一键全栈

把仓库里的 `docker-compose.yml` 下载到任意目录（浏览器下载即可），然后：

```bash
docker compose up -d
```

compose 默认已经按国内网络配好：应用镜像走阿里云 ACR 的公开 `0.9.14`，协议端走
`docker.m.daocloud.io` 镜像站。升级时改 compose 里的默认值，或设
`QQ_AGENT_IMAGE=<镜像>:<版本>`。不要用 `latest` 当默认值——首次发布前它不存在，会拉取失败。
海外用户可以把 `QQ_AGENT_IMAGE` 换成 GHCR、`SNOWLUMA_IMAGE` 换成官方 Docker Hub 镜像。

这会启动两个服务：

- `snowluma`：QQ 协议端，WebUI 在 `127.0.0.1:5099`；
- `agent`：QQ Agent，控制台在 `127.0.0.1:3210`。

首次启动看控制台访问信息（令牌不会打进容器日志）：

```bash
docker compose exec agent cat /data/console-access.txt
```

文件里是控制台地址与令牌（权限 0600）。确实想让令牌出现在日志里，启动时加
`QQ_AGENT_PRINT_TOKEN=1`。

然后按顺序：

1. 打开控制台 → 设置 → 模型 API，填 Base URL、Key、模型名。
2. 扫码登录 QQ：打开 noVNC `http://127.0.0.1:6081`，密码是 `VNC_PASSWD`（留空时
   SnowLuma 首次启动会随机生成并打印在日志里，见 `docker compose logs snowluma`）。
   `5099` 是 SnowLuma WebUI（协议端设置），不是扫码页。
3. 控制台 → 聊天设置/白名单，加入要参与的群。
4. 在群里 @ 机器人一句，确认能回。

**全新 Docker 配置默认是 `active`**：填好模型、加入白名单后就会直接回复（裸机 `install.sh`
首次安装默认 observe，两者不同）。想先只观察，设 `QQ_AGENT_RUNTIME_MODE=observe`，或在控制台切换。

几个首次部署的边界：

- **宿主机 uid 不是 1000**：SnowLuma 默认按 `SNOWLUMA_UID/GID=1000` 写数据；用
  `SNOWLUMA_UID=$(id -u) SNOWLUMA_GID=$(id -g) docker compose up -d` 对齐。
- **noVNC 密码**：`VNC_PASSWD` 留空时 SnowLuma 会随机生成并打印在首次启动日志里；
  也可以显式设置。不要使用公开的固定默认值。
- **自定义宿主端口**：`QQ_AGENT_PORT`、`SNOWLUMA_WEBUI_HOST_PORT`、`NOVNC_PORT` 可以改，
  但控制台里的服务链接仍按 3210/5099/6081 拼接；改了端口请手动调整链接或保持默认。
- **OneBot 令牌**：full stack 不需要手动配置。Agent 启动时会从只读挂载的
  `snowluma-data/config/onebot*.json` 读取 SnowLuma 生成的 accessToken，并写进自己的配置。
  首次启动最多等 120 秒；如果 Protocol 端还没写出配置文件，日志会提示，登录后重启 agent 即可同步。
  使用**外部协议端**时，才需要设 `QQ_AGENT_ONEBOT_ACCESS_TOKEN` / `QQ_AGENT_ONEBOT_HTTP_TOKEN`。

控制台与协议端 WebUI 都只绑宿主机 `127.0.0.1`。远程访问用 SSH 隧道：

```bash
ssh -L 3210:127.0.0.1:3210 -L 5099:127.0.0.1:5099 -L 6081:127.0.0.1:6081 user@server
```

然后在本机浏览器打开 `http://127.0.0.1:3210`。

## 2. 只要 Agent（协议端在别处）

如果已经有一个 OneBot v11 协议端，启动时指定地址即可，不需要 compose 里的 `snowluma`：

```bash
QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS=0 \
QQ_AGENT_ONEBOT_WS_URL=ws://<协议端主机>:3001 \
QQ_AGENT_ONEBOT_HTTP_URL=http://<协议端主机>:3000 \
docker compose up -d agent
```

或者完全不用 compose，只用 `docker run`：

```bash
docker volume create qq-agent-data
docker run -d --name qq-agent \
  --restart unless-stopped \
  --init \
  --read-only \
  --tmpfs /tmp:size=1g \
  --security-opt no-new-privileges:true \
  --stop-timeout 30 \
  -p 127.0.0.1:3210:3210 \
  -v qq-agent-data:/data \
  -e QQ_AGENT_RUNTIME=docker \
  -e QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS=0 \
  -e QQ_AGENT_ONEBOT_WS_URL=ws://<协议端主机>:3001 \
  -e QQ_AGENT_ONEBOT_HTTP_URL=http://<协议端主机>:3000 \
  ghcr.io/sakurawwwxh/qq-agent-plus:<版本>
```

固定具体版本或 digest，不要用 `latest`；这样升级和回滚都可预期。

这种模式下控制台里的协议端 WebUI / noVNC 探活仍指向 compose 网络里的服务名，会显示离线；
把 `SNOWLUMA_INTERNAL_URL`、`QQ_AGENT_NOVNC_URL` 指到实际可访问的地址，或直接忽略这两个方块。

令牌用 `docker exec qq-agent cat /data/console-access.txt` 查看；也可以加
`-e QQ_AGENT_PRINT_TOKEN=1` 让令牌打印到日志，或自己指定 `-e QQ_AGENT_CONSOLE_TOKEN=<令牌>`。

## 3. 配置从哪来

容器模式下，下面这些**环境变量只用于首次播种**（配置里已有值时不会被覆盖，
避免重启把控制台里改过的设置顶回去）。

> `docker compose` 只会把 `docker-compose.yml` 的 `environment:` 里列出的变量传进容器；
> 下表是 entrypoint 支持的变量。未在 compose 文件里列出的（例如 `QQ_AGENT_API_*`、
> `QQ_AGENT_PRINT_TOKEN`、`LIVING_MEMORY_VECTOR_SCAN_LIMIT`）需要自行加到
> `agent.environment`，或用 `docker run -e`。直接写进 `.env` 只会参与 compose 变量替换。

| 变量 | 作用 |
| --- | --- |
| `QQ_AGENT_CONSOLE_TOKEN` | 控制台令牌；留空＝首次生成并写进配置 |
| `QQ_AGENT_SERVER_HOST` | 容器内监听地址，默认 `0.0.0.0`（不要改成 127.0.0.1） |
| `QQ_AGENT_SERVER_PORT` | 容器内固定 3210（宿主端口用 `QQ_AGENT_PORT`） |
| `QQ_AGENT_ONEBOT_WS_URL` | OneBot WebSocket 地址 |
| `QQ_AGENT_ONEBOT_HTTP_URL` | OneBot HTTP 地址 |
| `QQ_AGENT_ONEBOT_ACCESS_TOKEN` / `QQ_AGENT_ONEBOT_HTTP_TOKEN` | OneBot 令牌 |
| `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` | SnowLuma WebUI 初始密码（与 deploy-all 的 `.env` 同名） |
| `QQ_AGENT_API_BASE_URL` / `QQ_AGENT_API_KEY` / `QQ_AGENT_API_MODEL` | 可选的模型初始配置 |
| `LIVING_MEMORY_EMBEDDING_BASE_URL` / `LIVING_MEMORY_EMBEDDING_API_KEY` / `LIVING_MEMORY_EMBEDDING_MODEL` | 可选的长期记忆 Embedding；数据与向量保存在同一 `/data/living-memory/` SQLite 文件 |
| `LIVING_MEMORY_EMBEDDING_DIMENSIONS` / `LIVING_MEMORY_RECALL_VECTOR_TIMEOUT_MS` / `LIVING_MEMORY_VECTOR_SCAN_LIMIT` | Embedding 维度、实时语义检索时限和每次扫描的向量上限 |
| `SNOWLUMA_INTERNAL_URL` | 服务端探测协议端 WebUI 的地址（compose 网络内） |
| `QQ_AGENT_NOVNC_URL` | 服务端探测 noVNC 的地址（compose 网络内） |
| `QQ_AGENT_RUNTIME_MODE` | 全新配置的首次运行模式；默认 `active`，设 `observe` 先观察 |
| `QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS` | 等 SnowLuma 写出 OneBot 配置的毫秒数；只跑 agent 时设 `0` |
| `QQ_AGENT_PRINT_TOKEN` | 设为 1 时把控制台令牌打印到日志（默认只写文件） |

**例外与强制覆盖**：

- OneBot 地址如果配置里是 `127.0.0.1:339x`（裸机迁移留下的），会被容器地址替换；
  已经是别的非回环地址（你自己改过的）则保留。
- 要强制用环境变量覆盖所有已有值，设 `QQ_AGENT_FORCE_ENV=1` 重启一次；只强制令牌用
  `QQ_AGENT_FORCE_CONSOLE_TOKEN=1`。
- `QQ_AGENT_SERVER_HOST/PORT` 是容器网络约定，始终以环境变量/compose 为准。

其余设置（人设、记忆、语音、插件、白名单等）都在控制台里改，写进 `/data/config.json`，升级镜像不会丢。

## 4. 数据、权限与备份

- 应用数据在 `./data`（容器内 `/data`）：`config.json`、SQLite、贴纸、插件数据、日志。
- 协议端数据在 `./snowluma-data`、`./snowluma-client-config`、`./snowluma-client-data`。
- 容器内应用以 uid 1000（`node`）运行。入口脚本启动时会自动 `chown` 数据目录；
  如果用的是 NFS/SMB 卷（root squash），会给出明确错误。手工修法：

```bash
sudo chown -R 1000:1000 ./data
```

备份就是停服务后打包 `./data`（SQLite 建议同时保留 `-wal`/`-shm`，或先停容器）：

```bash
docker compose stop agent
tar czf qq-agent-data-$(date +%F).tar.gz data
docker compose start agent
```

`docker compose stop` 会等应用自己收尾（compose 里已设 `stop_grace_period: 30s`，
应用内部的退出期限是 25 秒）；`docker run` 请加 `--stop-timeout 30`。

## 5. 升级与回滚

```bash
# 先把 compose 里的 QQ_AGENT_IMAGE 改到目标版本（下面是显式传变量的写法）
QQ_AGENT_IMAGE=<镜像>:<新版本> docker compose pull agent
QQ_AGENT_IMAGE=<镜像>:<新版本> docker compose up -d agent
```

数据卷不动。回滚：把 compose 里的 `QQ_AGENT_IMAGE` 固定到上一个版本 tag，再 `up -d`：

```bash
QQ_AGENT_IMAGE=ghcr.io/sakurawwwxh/qq-agent-plus:<上一个版本> docker compose up -d agent
```

协议端升级同理：改 `SNOWLUMA_IMAGE` 后 `docker compose pull snowluma && docker compose up -d snowluma`。

**容器里没有 `deploy.sh`、systemd、宿主 Docker 套接字**，控制台的“立即更新”“更新协议端”
会被禁用并提示改用上面的命令。这是故意的：容器里 exec 宿主机命令既不可靠也不安全。

### 已经部署过 Docker 版本的

1. **先更新 compose 文件**：本次新增了 SnowLuma 配置挂载和 OneBot 令牌同步，只 `pull` 镜像不够。
   在仓库目录 `git pull`，或重新下载 `docker-compose.yml`。
2. 把 compose 里的 `QQ_AGENT_IMAGE` 改到目标版本（或显式传变量），再
   `docker compose pull && docker compose up -d`；数据卷不动，不需要迁移数据。
3. 如果升级前控制台显示“观察模式”，到 控制 → 运行模式 切到**活跃**（旧配置不会被自动改成 active）。
4. 如果 noVNC 密码变了，看 `docker compose logs snowluma`（`VNC_PASSWD` 留空时是随机生成的）。
5. 固定了旧镜像 digest 的，把 `QQ_AGENT_IMAGE` 改回 `...:0.9.14` 或新 digest 后再 pull。

**裸机 systemd 部署不受影响**：这次只改了 Docker 路径，服务器上的 `qq-agent-linux.service`
继续按原来的方式升级即可；只有想迁到 Docker 时才需要处理数据目录与旧协议端容器。

## 6. 从裸机部署迁移

1. 停旧服务：`systemctl --user stop qq-agent-linux.service`。
2. 把旧数据目录（默认 `/data/qq-agent/data`）整个拷到 compose 目录下的 `./data`。
3. `sudo chown -R 1000:1000 ./data`。
4. 如果旧全栈的协议端容器还叫 `qq-agent-snowluma`，先停掉并删除（`docker rm -f qq-agent-snowluma`）；
   把 SnowLuma 的数据/客户端目录迁到 `./snowluma-data`、`./snowluma-client-config`、`./snowluma-client-data`。
5. 起**完整** compose：`docker compose up -d`。不要只 `up agent`——Agent 默认指向 compose 里的
   `snowluma` 服务。若保留外部协议端，设 `QQ_AGENT_ONEBOT_WS_URL=ws://<可达地址>:3001` 与
   HTTP 地址后再 `docker compose up -d agent`；旧协议端不能只绑 127.0.0.1。
6. 打开控制台确认会话、记忆、提醒都在；在群里发一句测试。

## 7. 镜像发布与下载（维护者）

推荐三层，按“别人能不能拉到”排序：

| 层 | 位置 | 用途 |
| --- | --- | --- |
| 主发布 | `ghcr.io/sakurawwwxh/qq-agent-plus` | CI 自动构建 amd64/arm64，GitHub 用户直接拉 |
| 国内镜像 | 阿里云 ACR 个人版 / 腾讯云 TCR | 国内用户拉得快；CI 复制 GHCR 的 manifest，不重新构建 |
| 离线包 | GitHub Release 的 `docker save` 压缩包（可选） | 完全离线/内网；体积大，按需生成 |

**每次发版推这些 tag**：`0.9.14`、`0.9`、`sha-<短哈希>`、`latest`。
长期部署请固定版本号，不要依赖 `latest`。

### 配置国内镜像（可选）

以阿里云 ACR 个人版为例（免费、可公开拉取）：

> 2024-09-09 之后新建的个人版实例使用**独立访问域名**，形如
> `crpi-xxxxxxxx.<region>.personal.cr.aliyuncs.com`，在实例概览页的「公网」一栏复制。
> 旧的 `registry.<region>.aliyuncs.com` 只适用于更早创建的实例，不要混用。

1. 在阿里云容器镜像服务创建个人版实例，建命名空间（例如 `sakurawwwxh`），
   建仓库 `qq-agent-plus`，把仓库设为**公开**。
2. GitHub 仓库 → Settings → Secrets and variables → Actions：
   - Variables：`CN_REGISTRY=crpi-xxxxxxxx.<region>.personal.cr.aliyuncs.com`、
     `CN_NAMESPACE=<命名空间>`、`CN_IMAGE_NAME=qq-agent-plus`；
   - Secrets：`CN_REGISTRY_USERNAME`、`CN_REGISTRY_PASSWORD`（ACR 的固定密码）。
3. 打 `v*` tag：CI 先推 GHCR，`publish-cn` job 再把多架构 manifest 原样复制到 ACR。
4. 用户拉取：

```bash
docker pull ghcr.io/sakurawwwxh/qq-agent-plus:0.9.14
docker pull <CN_REGISTRY>/<命名空间>/qq-agent-plus:0.9.14
```

腾讯云 TCR 同理，把 `CN_REGISTRY` 换成 `ccr.ccs.tencentyun.com`。

**首次推送后必须做的一步**：到 GitHub 的 Packages 页面把该 package 的可见性改成
**Public**，否则匿名 `docker pull` 会 401。GHCR 包默认可能跟随仓库可见性，但首次发布后
最好手动确认一次。

### Compose 使用国内镜像

```bash
QQ_AGENT_IMAGE=<CN_REGISTRY>/<命名空间>/qq-agent-plus:0.9.14 \
SNOWLUMA_IMAGE=docker.m.daocloud.io/motricseven7/snowluma:v1.14.22 \
docker compose up -d
```

不要把 Docker Hub 作为主发布渠道：国内不可直连，SnowLuma 的 Docker Hub 镜像也需要镜像站前缀。

### 发版流程（每版一次）

1. 按现有 Release 流程改版本号、提交、打 tag（例如 `v0.9.14`）并推送。
   **tag 推送并触发镜像构建后不要再移动它**：GHCR 与国内镜像都拒绝覆盖已存在的精确版本 tag；
   前移 tag 会让这次 tag 的 Docker 构建永久变红，而线上镜像仍指向旧提交。发现镜像内容有问题，
   正确做法是发一个补丁版本，而不是重打同名 tag。
2. CI 自动执行：`verify`（单测/lint）→ `smoke`（真实容器冒烟）→ `build`
   （amd64/arm64 构建并推 GHCR）→ `publish-cn`（配置了国内仓库时复制 manifest）。
   `publish-cn` 对精确版本 tag 也有同样的不可覆盖守卫：重建同一版本镜像时，需要先用
   `workflow_dispatch` 的 `cn_only=true` + `overwrite=true` 把国内镜像对齐到新 digest，
   再重跑失败任务；这只是修复事故的手段，正常发版不要依赖它。
3. 在 Release 说明里贴两条拉取命令（GHCR + 国内镜像），并写清本次是否需要手动迁移数据。
4. 在一台干净机器上 `docker pull <新版本>` + `sh scripts/docker-smoke.sh` 验证一次再宣布。
5. 用户升级：`docker compose pull && docker compose up -d`；数据卷不动。

日常提交不会触发镜像构建；只有 tag（或手动 `workflow_dispatch`）才会。基础镜像与
ffmpeg 层有构建缓存，后续版本主要重新传应用层；首次推送与国内镜像首次同步的体积最大。

### 只推镜像、不发新版本（不占本地）

首次发布 Docker 镜像、或只想把当前版本推到仓库时，不需要在本机构建：

1. 确认 Docker 工作流已经在默认分支上（`main`）。
2. GitHub → Actions → Docker → Run workflow：
   - `version`：留空只推 `sha-...`；要推版本就填一个**新**版本号（已存在的 tag 默认拒绝覆盖；
     确需覆盖勾选 `overwrite`）；
   - `push_cn`：勾选（填了版本才会复制到国内镜像）。
3. CI 会跑 verify/smoke，构建 amd64+arm64，推 GHCR 的 `0.9.14`/`sha-...`；
   正式稳定 tag 才会有 `0.9` 与 `latest`。**手动运行不会移动 `latest`**，
   避免把未发布的构建变成默认版本。

本机不需要 `docker pull`、`docker build` 或 `docker push`；本地镜像可以随时删掉。

## 8. 常见问题

### 国内网络：Docker Hub / GHCR 不可用

这里涉及两个来源不同的镜像：

| 服务 | 默认 | 来源 |
| --- | --- | --- |
| `agent` | `crpi-.../wangxinhong/qq-agent-plus:0.9.14` | 阿里云 ACR（国内可直连） |
| `snowluma` | `docker.m.daocloud.io/motricseven7/snowluma:v1.14.22` | 镜像站（官方在 Docker Hub） |

compose 默认已经走国内可访问的地址；Docker Hub 在国内通常不可直连，GHCR 也可能很慢。
要换回官方源或换镜像站，用环境变量覆盖。三种取法，按省事程度排序：

**A. 用镜像站前缀（推荐先试）**

```bash
SNOWLUMA_IMAGE=docker.m.daocloud.io/motricseven7/snowluma:v1.14.22 \
QQ_AGENT_IMAGE=ghcr.nju.edu.cn/sakurawwwxh/qq-agent-plus:latest \
docker compose up -d
```

先把两个镜像单独 `docker pull` 一次，确认站可用再 `up`。镜像站会变动，不要用来源不明
的站；固定 tag（不要用 `latest` 做长期部署）便于核对。

**B. 自己构建应用镜像，基础镜像也走镜像站**

Docker Hub 拉不到 `node` 基础镜像时，构建参数可以换前缀：

```bash
docker build \
  --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22.23.3-bookworm-slim \
  -t qq-agent-plus:local .
QQ_AGENT_IMAGE=qq-agent-plus:local docker compose up -d agent
```

协议端仍要按 A 的方式换 `SNOWLUMA_IMAGE`。

**C. 镜像搬运（完全离线/内网）**

在一台能拉取的机器上：

```bash
docker pull ghcr.io/sakurawwwxh/qq-agent-plus:<版本>
docker save ghcr.io/sakurawwwxh/qq-agent-plus:<版本> | gzip > qq-agent.tar.gz
```

拷到目标机后 `docker load < qq-agent.tar.gz`，再用 `QQ_AGENT_IMAGE=<本地镜像名>` 启动。

宿主机层面也可以给 Docker 配 `registry-mirrors`（只对 Docker Hub 生效，管不到 GHCR），
改 `/etc/docker/daemon.json` 后重启 Docker；这只是另一种写法，不改变“镜像站会变”的事实。

**控制台打不开 / 401**
- 确认访问的是宿主机 `127.0.0.1:3210`（或 SSH 隧道）。
- 令牌在 `data/console-access.txt` 里：
  `docker compose exec agent cat /data/console-access.txt`。也可以在 `data/config.json` 的
  `server.token` 里看（不要把它贴到公开地方）。
- 容器内必须绑 `0.0.0.0`；改成 127.0.0.1 会导致端口映射进不来。

**`EACCES: permission denied, open '/data/config.json'`**
数据卷属主不对。执行 `sudo chown -R 1000:1000 ./data` 后重启容器。
NFS 卷请让卷对 uid 1000 可写。

**协议端扫码后 Agent 仍显示未连接**
- 看 `docker compose logs snowluma` 是否已登录；
- 确认 `QQ_AGENT_ONEBOT_WS_URL` 指向 `snowluma:3001`（不是 127.0.0.1）；
- 两个服务要在同一个 compose 网络里（默认就是）。

**要远程访问**
不要改 compose 里的端口绑定为 `0.0.0.0`。用 SSH 隧道，或在前面放一个带 TLS 的反向代理，
并保留控制台令牌。

**ARM 服务器**
镜像同时发布 `linux/amd64` 与 `linux/arm64`。如果拉到的架构不对，检查
`docker image inspect <镜像> --format '{{.Architecture}}'`。

## 9. 容器模式不提供的功能

| 功能 | 原因 | 替代 |
| --- | --- | --- |
| 控制台“立即更新” | 没有 systemd update service | `docker compose pull && up -d` |
| 控制台“更新协议端” | 不挂宿主 docker 套接字 | 更新 compose 里的 `SNOWLUMA_IMAGE` |
| `deploy.sh` / `install-timers` | 面向宿主机 systemd | 不使用；镜像即部署 |
| 本机 whisper.cpp 安装 | 需要编译工具与持久化目录 | 用托管 ASR，或自定义镜像里预装 |

其余功能（分条发言、贴纸、记忆、提醒、主动发言、语音、插件、日报）与裸机一致。
镜像内已包含 `ffmpeg`，音频转写、视频抽帧、GIF 帧条与大图降采样可用。

## 10. 验证这套部署

仓库里有一个只依赖 Docker 的冒烟脚本：

```bash
docker build -t qq-agent-plus:test .
sh scripts/docker-smoke.sh qq-agent-plus:test
```

它会检查首次启动、控制台健康、容器模式守卫（手动更新应 409）、`/data` 权限与
SIGTERM 优雅退出。CI 在发布 tag 时也会跑同样的检查。
