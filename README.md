<div align="center">

<img src="docs/assets/mark.svg" alt="QQ Agent Plus" width="104" height="104">

# QQ Agent Plus

面向 Linux 服务器的 QQ 群聊 Agent，支持分条发言、表情包收发、长期记忆与内置运维命令。

[![CI](https://github.com/sakurawwwxh/qq-agent-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/sakurawwwxh/qq-agent-plus/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/sakurawwwxh/qq-agent-plus?color=e8b400&label=stars&logo=github)](https://github.com/sakurawwwxh/qq-agent-plus/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/sakurawwwxh/qq-agent-plus?logo=git&logoColor=white)](https://github.com/sakurawwwxh/qq-agent-plus/commits/main)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-Linux-0b5fff?logo=linux&logoColor=white)](docs/LINUX.md)
[![OneBot](https://img.shields.io/badge/protocol-OneBot%20v11-12b7f5)](https://github.com/botuniverse/onebot-11)
[![LLM](https://img.shields.io/badge/LLM-OpenAI%20%E5%85%BC%E5%AE%B9-6b4fbb)](#特性)

**简体中文** ｜ [English](README.en.md)

<img src="docs/assets/console-demo.png" alt="控制台：消息存档与会话管理" width="880">

</div>

QQ Agent Plus 是面向 Linux 服务器的 QQ 群聊 Agent。它连接外部 OneBot v11 协议端，每次触发使用
独立的 OpenAI Chat Completions 会话，不依赖 DSH、MCP、Electron 或 Windows 运行环境。

## 特性

下列能力均来自实际群聊环境中的问题修复，每条对应的失败模式与处理方式记录在[改动清单](docs/CHANGES.md)。

- **对话行为**：单轮分条发言，先判断图片情绪再回应，表情包清单常驻系统提示（常用的 + 没用过的轮换，条数可调），结束前自检。
- **发送链路**：网络层发送重试，QQ 系统表情，消息 id 归一化，内联工具调用兜底解析。
- **贴纸系统**：自动收藏并优先使用 QQ 收藏表情，查找兜底，同步护栏。
- **主动发言**：三条链路各自可关（冷场开话题 / 没人接话补一句 / 模型自安排唤醒），多活跃时段，
  间隔护栏，跳过原因日志，重启后补齐漏收消息。
- **模型接入**：按用途控制思考模式，服务商审核拦截重试，兜底模型切换。
- **语音转文字**：语音/音频文件/视频音轨转成文字再交给聊天模型（与模型是否多模态无关）。
  **默认走 API Key 的托管服务**（预置硅基流动的地址：粘一个 Key、从官网拉一次模型列表就能用；
  也可一键换成 Groq / 火山 Seed-ASR / 阿里云百炼 / 讯飞 / 腾讯云 / 百度 / 自建，各家对新用户多有免费额度）；
  也支持**零 Key 的本机 whisper.cpp**（离线、免费，控制台里点一下就能装、也能完整卸载，或跑
  `node scripts/install-asr-local.mjs`）。QQ 语音（SILK）与视频音轨都能吃（SILK 本地解码，不需要协议端转码）；
  视频还能"看画面"：抽 4 帧拼成 2×2 帧条交给视觉模型（另有音轨转写），看到也能听到。
  Key 与搜索的分开配。
  带每小时次数闸门。群禁言时会直接报因、不再硬发。

配置项示例见[配置示例](docs/CONFIG-EXAMPLES.md)。运维命令统一收录在 [src/ops.js](src/ops.js)，
用法见[运维工具](docs/OPS.md)。本地回归测试位于 [test/local/](test/local/README.md)。
衍生关系与第三方版权说明见 [NOTICE](NOTICE.md)。

## 示例

运维命令随程序提供（`src/ops.js`），只读命令不修改业务数据。

```text
$ node src/ops.js audit
===== 1. 服务与定时器 =====
  [正常] qq-agent-linux.service  active
  [正常] qq-agent-linux-update.timer  enabled
===== 3. 源码语法（全部 js） =====
  [正常] 所有 js 文件语法通过（75 个）
===== 4. 未定义调用扫描 =====
  [正常] 可疑未定义调用点: 0
===== 8. 运行态 =====
  [正常] OneBot: connected=true …
===== 自检结论 =====
  全部通过（0 项异常）
（节选：实际共 11 段，含配置 / 数据文件 / 价格缺口 / 最近日志 / 主机资源等）

$ node src/ops.js watch-send --minutes=5
基线：outbox 最新 rowid=17，待处理消息 0 条
      最近一条人类消息：今晚还打不打
SEND_OK：机器人通过工具层成功回话 ｜ group:123456789 ｜ run=3f2c… ｜ state=sent ｜ 打啊
      人类上一条：今晚还打不打
```

以下为群聊中一轮对话的示意样例，非真实聊天记录。接住对方的话之后，如有补充内容则以独立气泡发出，
合适场合直接使用表情：

```text
群友： 今晚还打不打
机器人：打啊
机器人：我吃完饭了 缓十分钟就来
机器人：[表情包：别墨迹]
```

## 架构

```text
OneBot WebSocket
  -> 按会话串行入库
  -> SQLite/WAL 消息状态机
  -> 默认随机 8-12 秒、最长 20 秒有界聚合
  -> legacy / threaded / lifecycle 路由
  -> 可选持久化线程与检查点
  -> 一次性 Agent 会话
  -> 会话绑定工具
  -> OneBot HTTP
```

消息仅在处理成功后确认。模型调用失败或进程退出时，未发送批次保持待处理状态并自动重试；发送结果
无法确认时进入 `held`，必须人工核对，以避免重复发言。

## 部署

### 全栈部署

全新 Linux 机器推荐使用交互式安装器 `deploy-all.sh`。安装器会询问部署目录与端口，自动安装 Docker
（需确认 sudo）、下载 SnowLuma、配置 OneBot、部署 QQ Agent，并生成和同步全部服务凭据。
SnowLuma 已包含 OneBot，无需另行安装 NapCat 或 Lagrange。

安装与运行都不使用 root：`deploy-all.sh` 会直接拒绝 root 身份，请以普通用户执行（脚本只在安装
Docker 与开启 linger 时按需调用 `sudo`）。

```bash
git clone https://github.com/sakurawwwxh/qq-agent-plus.git
cd qq-agent-plus
bash deploy-all.sh
```

默认部署目录为 `/mnt/data/qq-agent`，默认对外端口如下：

- `3210`：QQ Agent 控制台；
- `5099`：SnowLuma WebUI；
- `6081`：QQ 登录使用的 noVNC。

OneBot HTTP `3000` 与 WebSocket `3001` 默认仅绑定 `127.0.0.1`，不暴露到局域网。安装器不要求填写
本机 IP，完成后自动检测并打印访问地址。生成的凭据保存于 `/mnt/data/qq-agent/deployment-access.txt`，
权限为 `0600`。脚本不修改 UFW、firewalld 或云安全组；需要跨主机访问时，仅应向可信局域网或 VPN
放行上述三个入口，不得将 noVNC 或 OneBot 暴露到公网。

首次安装会同时询问模型 Base URL、API Key、模型名与 QQ 白名单。基础设施启动后，打开脚本输出的
noVNC 地址并扫码登录 QQ，返回终端按 Enter；脚本会校验 OneBot 登录状态并询问是否激活。确认旧机器人
已停止或已排除相同群聊后，也可手动执行：

```bash
/mnt/data/qq-agent/app/manage.sh activate --confirm-exclusive
```

无人值守安装：

```bash
bash deploy-all.sh --yes --root-dir /mnt/data/qq-agent \
  --agent-port 3210 --snowluma-port 5099 --novnc-port 6081 \
  --model-base-url https://api.deepseek.com \
  --model-api-key "$DEEPSEEK_API_KEY" --model deepseek-chat \
  --allow-groups 123456789
```

无人值守模式必须提供模型配置，或显式添加 `--skip-model-config` 并在部署后从控制台填写。白名单可为空，
但机器人在配置允许的会话之前不会响应任何消息。

仅允许对本脚本管理且配置一致的安装重跑。写入前会校验 Agent 配置与部署记录、systemd 服务目录、
SnowLuma 容器的 Compose 归属与数据卷、端口占用情况；发现非受管安装、残留的不完整状态或被后台修改
过的凭据时，脚本报错退出，不覆盖配置、不重启服务，`--yes` 与 `--rotate-credentials` 均无法绕过该保护。

只读检查（不创建目录、不下载依赖、不修改服务）：

```bash
bash deploy-all.sh --check-only --root-dir /mnt/data/qq-agent
```

旧 Bridge/SnowLuma 生产环境应使用 `deploy.sh` 更新 Agent，并保留实际数据目录、监听地址与 OneBot
配置；不得删除已有数据或伪造 `.env` 绕过检查。全栈检查还需要 `realpath` 与 `ss`（iproute2）；
已安装 Docker 但无法读取容器时，脚本安全退出。

受管安装重跑会保留 SnowLuma 数据、QQ 登录态与现有凭据。如需同步轮换 Agent、OneBot、SnowLuma WebUI
与 noVNC 凭据，添加 `--rotate-credentials`；启用 SnowLuma 2FA 后还需提供 `--snowluma-totp`。
完整参数见：

```bash
bash deploy-all.sh --help
```

### 仅部署 QQ Agent

已有可用 OneBot v11 协议端，或仅需安装、更新 Agent 时使用 `deploy.sh`。运行要求：

- Linux，且可用 systemd 用户服务；
- 以非 root 的普通用户执行（服务注册为该用户的 systemd 用户服务）；
- `curl`、`tar`、`sha256sum`、`rsync`（缺少合格 Node.js 时自动安装已校验的 Node 22）；
- 已运行的 OneBot v11 HTTP 与正向 WebSocket 服务；
- 兼容 OpenAI Chat Completions 的模型服务。

面板环境（宝塔 / aaPanel）的部署差异见[宝塔面板部署](docs/BAOTA.md)：面板仅作为管理界面，进程仍由
systemd 用户服务托管，不应通过面板的 Node 项目或 PM2 启动。

```bash
git clone https://github.com/sakurawwwxh/qq-agent-plus.git
cd qq-agent-plus

bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 127.0.0.1 \
  --port 3210
```

`deploy.sh` 不安装 SnowLuma，适合已有协议端或仅更新 Agent 的场景。脚本执行以下操作：

- 校验参数、源码与 Node.js 的 `node:sqlite` 能力；
- 安装生产依赖；
- 自动检测或安装 Node.js 22 运行时；
- 初始化独立数据目录与控制台 Token；
- 注册并启用 `qq-agent-linux.service`；
- 配置进程异常自动重启；
- 检查端口冲突与 systemd unit；
- 首次安装以 `observe` 模式启动，更新时保留既有运行模式；
- 更新前自动创建代码快照，失败时恢复旧代码、配置与服务；
- 排除 `.git`、`.dbg`、运行数据、凭据与本地调试记录。

查看全部参数：

```bash
bash deploy.sh --help
```

已配置外部备份流程时，可显式跳过代码快照：

```bash
bash deploy.sh --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data --host 127.0.0.1 --port 3210 \
  --no-backup
```

首次从旧 Bridge 迁移连接配置时，可附加：

```bash
  --import-bridge /path/to/old/config.json \
  --credential-file /path/to/credentials.env
```

该操作仅复制配置，不修改旧目录与旧数据。

更新已有安装：

```bash
git pull --ff-only
bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 127.0.0.1 \
  --port 3210
```

更新不重置运行模式，其余配置也保持不变。`--install-dir` 与 `--data-dir` 必须与现有安装一致：传错
目录不会报错，而是把服务指向一个新的空数据目录。`--host` 与 `--port` 可以省略——省略时脚本沿用
`config.json` 中记录的现值并打印一行提示；显式传入时必须与首次安装相同（例如全栈安装用的是
`0.0.0.0`），否则控制台会从外部失联。当前监听地址可从 `DATA_DIR/console-access.txt` 的 URL 行读到。

默认在 `DATA_DIR/deploy-backups/` 创建部署前代码快照；安装、配置、systemd 校验或健康检查任一环节
失败时，自动恢复旧代码、配置与服务。

部署脚本同时安装独立的 GitHub 更新 service/timer。自动更新默认关闭，可在「控制 -> 更新部署」配置
管理员后恢复。提示与部署均以**已发布的 Release** 为准（草稿、预发布与 `main` 上的日常提交不计入），
目标为该 tag 对应的提交：先执行单元测试，再复用 `deploy.sh` 部署；当前部署已包含最新 Release 时
不回退，无法比较方向时不执行；失败时回滚、停止自动更新并私聊通知管理员。
详见[自动更新部署](docs/AUTO_UPDATE.md)。

## 运维

### 服务管理

以下命令在安装目录（`--install-dir`）中执行：

```bash
bash manage.sh status
bash manage.sh logs
bash manage.sh health
bash manage.sh token
bash manage.sh restart
bash manage.sh observe
bash manage.sh activate --confirm-exclusive
bash manage.sh update-status
bash manage.sh update-now --confirm
bash manage.sh backup /path/to/new-backup-dir
```

### 运维工具

`manage.sh` 之外的运维工具（只读体检、数据备份、发送与登录监控、进程看门狗、表情名导出、非交互
部署、SSH 隧道）统一由 `src/ops.js` 提供，仅使用 Node 内置模块：

```bash
node src/ops.js help                     # 全部子命令
node src/ops.js audit                    # 服务 + 代码 + 数据体检（只读）
node src/ops.js audit-host               # 主机体检（只读）
node src/ops.js scan                     # 未定义调用扫描
node src/ops.js backup --confirm         # 停/起服务 + 打包数据目录，只留最近 4 份
node src/ops.js install-timers --print   # 查看两个 systemd user 定时器
node src/ops.js console --open           # 建 SSH 隧道并打开控制台
```

每个子命令均支持 `--help`。环境变量、常用示例与远程执行说明见[运维工具文档](docs/OPS.md)。

### OneBot 连接异常的排查

控制台仅展示“已连接 / 未连接”状态，具体原因位于 `/api/status` 的 `onebot.error` 字段，
执行一次体检即可查看：

```bash
node src/ops.js audit --dir=/mnt/data/qq-agent     # 查看 "OneBot: connected=false error=…" 一行
journalctl --user -u qq-agent-linux -n 80 | grep -i onebot
```

> `ops.js` 直连协议端时默认使用 `3390` 端口；未修改过端口（安装脚本默认 `3000`）时，需设置
> `QQ_AGENT_ONEBOT_HTTP_PORT=3000`，否则该行会误报不可达。

按 error 内容对应处理：

- `ECONNREFUSED`：协议端未在该端口监听。先确认容器状态：
  `docker ps -a | grep snowluma`、`docker logs --tail 50 qq-agent-snowluma`。
- `401` / `403`：令牌不一致。协议端 `onebot.json` 中的 `accessToken` 必须与控制台
  「设置 -> OneBot」的 WS 令牌一致（HTTP 令牌留空则沿用 WS）。
- `ENOTFOUND`：地址无法解析，WS 地址有误（默认 `ws://127.0.0.1:3001`）。
- `ETIMEDOUT`：无法连接到目标主机（地址或防火墙）。
- `404` / `Unexpected server response`：端口填写错误，对端不是 WebSocket 协议端
  （HTTP 端口 `3000` 不能作为 WS 使用）。

需要注意的三点：

- 修改地址或令牌后必须重启服务才生效：连接仅在服务启动时建立一次，在控制台保存配置不会触发重连，
  需执行 `bash manage.sh restart`。
- 协议端必须提供**正向 WebSocket 服务**：本项目仅作为正向 WS 客户端，不提供反向 WS 服务端。
- 状态圆点含义：绿色表示已连接；黄色表示曾连接后断开（服务按退避策略自动重连，无需重启）；
  灰色表示从未连接。

QQ 未登录不属于“未连接”：此时 WS 连接正常，只是无法获取登录信息，可用
`node src/ops.js watch-login` 观察登录状态。

### 控制台访问

控制台默认端口为 `3210`。仅部署 Agent（`deploy.sh`）时默认仅监听 `127.0.0.1`，本机通过 SSH 隧道
访问即可，无需开放任何公网端口；全栈安装器（`deploy-all.sh`）以 `--host 0.0.0.0` 启动控制台，
跨主机访问时应仅向可信局域网或 VPN 放行。Windows 用户可直接双击仓库中的
[`console-tunnel.bat`](console-tunnel.bat)：首次输入一次 `user@host` 并记住，之后自动从服务器读取控制台
令牌、建立 SSH 隧道并免登录打开浏览器，同时转发 `5099`（SnowLuma WebUI）与 `6081`（QQ 扫码登录）。
macOS、Linux 或已安装 Node 的机器可使用 `node src/ops.js console --open`，效果相同。

Token 可在「设置 -> 系统 -> 控制台安全」中轮换。控制台一旦可被其他主机访问，令牌即为唯一凭据，只能自己使用。

顶层「控制」页是统一运维入口，提供 QQ Agent、DSH、Bridge、SnowLuma 与 QQ 远程桌面的入口与在线状态，
并可跳转到模型、搜索、OneBot 与控制台 Token 设置。该页支持手动更新、暂停或恢复自动更新；SnowLuma
登录密钥可在该页直接修改，密钥仅随单次请求发送，不写入 QQ Agent 配置或前端存储。旧 `3110` 门户不再映射。

启用前必须确认旧机器人未处理相同会话，否则会产生双回复。

## 数据与存储

数据默认位于部署参数指定的 `data` 目录：

- `config.json`：配置与凭据，权限 `0600`；
- `messages.sqlite`：消息、租约与出站状态；
- `sessions/`：每次 Agent 运行记录；
- `memory/`：群友长期印象与跨 Session 会话交接状态；
- `identity-pilot.sqlite`：统一 QQ 身份索引与好友请求审批台账；
- `slang-pilot.sqlite`：黑话试点已退役，不会再创建；
- `daily-moments.json`：每日群聊总结、说说决策与发布结果；
- `qzone-interactions.json`：好友动态未读队列、评论回复与外部写入状态；
- `console-access.txt`：控制台地址与 Token，权限 `0600`。

聊天、密钥、Token 与运行数据均被 Git 忽略。

## 控制台功能

### 响应概率

「设置 -> 聊天设置」中的响应概率滑条决定机器人对普通消息的回话比例，滑条数值即概率。`0%` 仅回应
被 @、被点名或命中关键词的消息，`100%` 回应任何消息；被 @、被点名或命中关键词的批次一定回应，
不受概率影响。概率按批独立抽签，不累计配额，也不构成“每 100 条回应几条”的额度。可统一设置，
也可关闭统一开关后为每个群单独设置；未单独设置的群聊与所有私聊跟随统一滑条。旧版四段式档位
（0-10 仅艾特、10-20 加关键词、20-90 概率、90-100 全响应）在首次读盘时换算一次：0-20 变为 `0%`，
20-90 按比例线性映射，90 以上变为 `100%`。新语义中没有“仅回应 @、不回应关键词”的档位，
因此旧的 0-10 设置换算后也会回应关键词。

### 人设

「设置 -> 人设」里的人设卡库提供多张内置角色卡（默认小鲸鱼、损友、温柔陪聊、技术宅、猫娘），
点一张卡就把它的正文填进草稿，点击页尾常驻的“保存设置”后生效。正文按小节展示：招牌特征、
AI 味黑名单、示例（✓ 可用 / ✗ 禁用）各按自己的形状渲染，每节右上角可以单独“编辑 / 恢复本节”，
整篇改乱了还能“恢复整张卡”。交流策略可选“原版群友”或“自然可靠”，角色正文与管理员附加规则
均可修改，也可以当前草稿为基础用“＋ 新建自定义卡”创建副本。角色卡正文的
单一来源是 [`roles/`](roles) 目录，一张卡对应一个 markdown 文件，说明见[内置角色卡](docs/PERSONAS.md)。

### 会话与生命周期

每次 Agent 运行均有独立审计记录。`lifecycle` 模式按 `threadId` 持久化 provider transcript（含工具轨迹
与供应商返回的 `reasoning_content`），并在下一批消息中按原顺序续接；结构化 handoff 作为生命周期滚动
后的压缩状态继续保留。控制台可检查注入历史、最新完整模型输入以及逐轮 Token 与缓存命中。生命周期
默认在上次请求输入达到 32000 Token 时换代；单次 Agent 运行累计预算为 160000 Token，追加工具轮会在
请求前预估预算并安全收尾。

### 等待与批次

「设置 -> 聊天设置」可分别配置未思考等待的最短值与最长值。每次自动唤醒在范围内重新随机，默认
`8000-12000ms`；连续消息仍由 `maxBatchWaitMs=20000` 限制从首条待处理消息起的最长聚合时间。生命周期
的等待批次会立即归入当前 `threadId`，控制台不会先显示独立窗口再合并；新 Session 也不会抢占正在
查看的详情。生命周期批次栏支持横向滚动，切换批次时保留详情与批次栏位置。

### 计价与用量

顶部状态与用量页均按每次模型调用返回的 `usage`、实际模型与调用时刻计价。“今日”以及按天统计固定
使用 `Asia/Shanghai` 自然日，不受服务器系统时区影响。

### 省 Token

「设置 -> 省 Token」提供一个一键收口的省法：**只给几个"可控项"夹上限，不改写你在各分区填的值**，
关掉立刻恢复原样。三档：关闭（默认）/ 省 / 很省；设置页会列出每一项的"你的设置 / 当前生效"对照。

| 项 | 省 | 很省 |
| --- | --- | --- |
| 被艾特 / 全响应读多少条已读 | ≤80 | ≤40 |
| 关键词 / 随机档读多少条 | ≤50 / ≤30 | ≤30 / ≤20 |
| 单次运行工具轮数 | ≤8 | ≤5 |
| 单次运行累计 Token | ≤8 万 | ≤5 万 |
| 会话交接注入（字符） | ≤2000 | ≤1200 |
| 全局印象注入（字符） | ≤3000 | ≤1500 |
| 提示词里的表情清单条数 | ≤5 | ≤3 |

口径与实测：每次模型调用的**固定底**（系统提示 + 二十多个工具定义，按开关 22~24 个）约 1.2 万-1.5 万 token，这部分靠设置
改不动；剩下能压的就是上表这些。线上 7 天实测（867 次调用 / 1836 万 token）里输入占 98.8%，其中**没命中
缓存的输入**占花费的 76% —— 所以省 Token 的重点是"少读历史、少跑轮次、少叫模型"，而不是压输出。
要更省还可以配合：把「聊天设置」的响应概率调低、关掉用不到的「搜索服务」与图片输入、
用「时间控制」只在低谷时段活动（峰谷价差可再省约三分之一）。改完在「用量」页按天对比即可。

### 每日动态

「设置 -> 每日动态」可启用每日群聊总结。任务按上海时间运行，读取当天活跃群的消息、长期记忆与会话
交接；模型可以联网研究、查看近期群图或收藏图，最终自行决定发布或跳过。发布通过 SnowLuma
`send_qzone_msg` 完成，并按日期记录幂等状态，服务重启不会自动重复发布结果不明的说说。

每日动态使用专门的说说提示词，完整读取设置中的角色卡和管理员附加规则，不再附加普通群聊的工具流程。
提示词与设计说明见[动态提示词](docs/DAILY_MOMENTS.md)。“生成新草稿”不发布；检查正文后可点击
“发布这份草稿”，直接发送同一份内容，不再次消耗模型 Token。中断的生成可重新执行；非法模型参数会
触发纠错，纠错失败显示“生成失败”。“发布结果待核对”只能核对空间记录，不能盲目重发。

### 动态互动

「设置 -> 动态互动」可按可配置间隔阅览好友动态、决定点赞或评论，并检查自己动态及已评论动态中的
新回复。未阅览内容按最新优先统一提交给模型，超出模型上下文窗口的旧条目继续保持未读。首次启用
默认只建立基线，不突然互动历史内容。设计、状态与幂等规则见[动态互动](docs/QZONE_INTERACTIONS.md)。

### 主动唤醒

存档页的“主动唤醒”由管理员显式运行：有未读消息时直接处理当前批次（不看响应概率）；没有未读消息时
读取该模式配置的最近存档，由模型自行决定是否发言。该操作仍受运行模式、暂停、白名单、时间控制、
并发上限与 `held` 状态保护。

### 实验功能与固化入口

「设置 -> 实验功能」只管理实验能力的运行开关与固化状态，不承载业务数据或高级参数。固化后对应功能
会取得独立顶层入口；关闭运行开关不会撤销入口或删除历史数据。

「旧印象」页按 QQ 号聚合白名单会话中的身份、别名、消息统计、好友状态及已有会话印象，并开放受限的
`person_memory_lookup` 查询工具。「好友管理」页处理收到的好友请求：管理员审批同意后调用标准
`set_friend_add_request` 并自动加入私聊白名单。主动好友候选（机器人主动加好友）已于 2026-09-25
整体退役——协议被服务端统一拒绝、上游不暴露内核加好友能力，且连续实验触发过账号风控，退役原因与
边界见[已知问题](docs/KNOWN-ISSUES.md)；入站好友请求的审批不受影响。实现边界见
[已转正的稳定特性](docs/STABLE_FEATURES.md)。

「观测」页展示并管理表情包、黑话与黑话研究数据。人物与旧印象由固化后的独立页面管理，不再混放在
通用观测入口。手动上传的表情保存在数据目录；QQ 收藏表情的删除只会从 AI 资产库隐藏，不会改动 QQ
客户端收藏。表情图片通过控制台鉴权的同源代理加载，临时 QQ 图片 URL 不会返回给浏览器。详细口径见
[资产观测](docs/ASSET_OBSERVABILITY.md)。

自动黑话研究流水线**已退休**（`slangPilotEnabled()` 恒为 false，无法再启用）：提示词不再注入任何
黑话，历史配置中的开关不会再生效。见[已转正的稳定特性](docs/STABLE_FEATURES.md)。

## 时间控制

「设置 -> 时间控制」默认关闭。关闭时忽略全部时间规则，不改变现有唤醒、提示词、模型请求或消息处理
策略。开启后统一使用上海时间，全局规则默认为 DS 低峰：工作日 `00:00-09:00`、`12:00-14:00`、
`18:00-24:00`，周末全天。每个群聊及私聊均可覆盖为继承全局、DS 低峰、自定义星期与时段或全天活跃。
自定义允许跨午夜，例如周五 `22:00-02:00` 延续至周六凌晨；`00:00-24:00` 为全天，自定义空时间表
表示始终非活跃。

非活跃期消息与拍一拍仅归档，不触发 AI，不积压自动补回复；进入活跃期后新消息按原模式处理，已归档
消息仍可作为历史上下文。模型请求、工具轮、重试、记忆整理及发送均受时间门控。每日动态与控制台
模型测试遵循全局时间表，每日汇总还会排除当前非活跃的会话；被时间限制挡住的定时动态推迟至活跃窗口。

规则修改即时生效。在途请求跨入非活跃期会被中止，后续请求与发信被拦截；供应商对已经收到的请求仍
可能计费，无法承诺撤销这部分 Token。发送结果不明确的 `held` 记录不会因时间切换而被丢弃或自动重发。

## 验证

```bash
npm ci --omit=dev --ignore-scripts
npm run test:unit     # 单元测试
npm run test:local    # 本地回归（自动使用临时数据目录，不接触生产数据）
node src/ops.js scan --strict
npm audit --omit=dev
bash -n deploy.sh manage.sh
```

CI（GitHub Actions）在每次推送和 PR 上执行语法检查、未定义调用扫描（严格模式）、单元测试、本地回归，
以及提示词 / 渲染 / 滚动 / 用量端到端回归。
当前基线上有两条已确认、暂不修的小问题，均不影响主链路，历史记录见[已知问题](docs/KNOWN-ISSUES.md)。

详细说明见 [Linux 运维手册](docs/LINUX.md)，全部文档见[文档索引](docs/README.md)。试验性三模式对话
引擎见 [Conversation Modes](docs/CONVERSATION_MODES.md)；早期参与者续接方案见
[Threaded Conversation Pilot](docs/research/THREADED_PILOT.md)。

## 许可

本项目使用 MIT 许可（见 [LICENSE](LICENSE)）；衍生关系与第三方版权见 [NOTICE](NOTICE.md)。
OneBot 协议端是独立软件，遵循其自身许可。
