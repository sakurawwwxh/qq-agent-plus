# 运维工具（src/ops.js）

本项目的运维入口仅有一个文件 `src/ops.js`，使用 Node 内置模块（`child_process` /
`fs` / `path` / `os` / `node:sqlite` 等），**不引入任何新依赖**，也不需要 python3。
原 `ops/` 目录（shell / python 脚本与 systemd 示例单元）的内容已全部移植至该文件，目录已
删除。

约定：

- 所有路径与凭据仅从**环境变量**读取，脚本中不包含任何真实地址、令牌或账号；
- token / 口令仅用于本地请求，`audit` 对 `config.json` 中的密钥只报告「有 / 无」，不打印内容；
- 只读子命令（`audit` / `audit-host` / `scan` / `watch-*` 及 `--print` 模式）不写入业务数据；
- 破坏性操作（`backup` / `deploy` / `guard` 真实执行 / `install-timers` 写盘）必须显式指定
  `--confirm`，预演使用 `--dry-run` 或 `--print`；
- 外部命令（`systemctl` / `docker` / `journalctl` / `ss` / `tar` / `openssl` 等）缺失时，
  对应段落打印「跳过」后继续执行，不中断整体体检；在 Windows/macOS 上只读体检可正常完成。

```bash
node src/ops.js help          # 全部子命令
node src/ops.js <子命令> --help
npm run ops -- <子命令>
```

## health-check（健康巡检）

```bash
node src/ops.js health-check            # 只巡检并输出 JSON（退出码 0=健康 / 1=有失败项）
node src/ops.js health-check --confirm  # 允许在"连续 3 次失败"或"恢复"时私聊 admin.ownerUin
```

11 项检查：控制台 `/healthz`、OneBot `get_status`、协议端版本（`protocol-version`：落后基线不算
不健康，明细里提示去控制台一键升级）、Docker 套接字可读写性（`docker-socket`，Issue #30）、
入站处理水位（`outbound-freshness`：到期未处理或重试耗尽的入站消息；
`runtime.mode=observe`、Agent 暂停、当日预算降级时自动跳过）、磁盘余量（< 1GB 报警）、
`auto-update.json` 的 `status=failed`、部署中断标记 `.deploy-in-progress`、`messages.sqlite` 完整性检查、
媒体工具（`media-tools`：缺 ffmpeg/ffprobe 时给安装提示，视频合流、抽帧与图片转码依赖它们）、
插件（`plugins`：总开关关着就跳过；开着时报"装了几个/授权几个"，manifest 有问题逐条给原因；
本机 Node 不支持权限隔离时也报红 —— 那种情况下插件不会被加载，见 docs/PLUGINS.md）。

OneBot 事件新鲜度不是巡检项，而是控制台侧的告警：连接显示在线但超过 10 分钟没有任何入站事件或
心跳时提示（此前这种情况会被当作正常在线）。

- 结果落在 `data/health.json`：`streaks` 记每类检查的连续失败数，`lastResults` 是最近一次明细。
- **抑制抖动**：同一检查连续失败到**第 3 次**才发一条 QQ 私聊告警；恢复正常时补发一条"已恢复"。
- `--confirm` 才真的发消息；不加就只巡检（定时器 `qq-agent-health.timer` 带 `--confirm`）。

安装定时器（每 5 分钟一次）：

```bash
node src/ops.js install-timers --print     # 预演，看将要写入的单元
node src/ops.js install-timers --confirm   # 写入并启用 backup / backup-drill / process-guard / health / audit-prune 五个 timer
```


## doctor（一键诊断包）

```bash
node src/ops.js doctor                        # 巡检 + 诊断包，默认写到 ./qq-agent-diagnose-<时间戳>.tar.gz
node src/ops.js doctor --out /tmp/diag.tar.gz # 指定输出路径
node src/ops.js doctor --no-health            # 跳过巡检（更快、也不探测网络）
```

包内是排障需要的现场：`manifest.json`（版本/提交/Node/平台/内存）、`config.redacted.json`
（字段名脱敏 + 按值再脱敏 + MCP env/args 与插件设置敏感键整段掩码）、
`health-check.json`（与 health-check 同一套检查）、
`storage.json`（data 目录一级占用排行 + 会话留档数量/压缩归档/最旧时间）、
`plugins.json`（已装插件与 apiVersion；清单损坏的以 `broken:true` 列出）、
`incidents.json`（异常台账计数与最近几条；读不到时明确写 `unavailable`）、
`effects.json`（出站副作用账本的状态计数与近 24h unknown）、
`logs.txt`（最近 3 小时 `journalctl --user`，取不到再试系统 journal，最后回退 `data/logs`
最新文件尾部 256KB，已按现有规则过滤 Bearer/查询串/Cookie/x-api-key 等形态）。
容器部署或 sudo 运行读不到 user journal 时，`logs.txt` 不会只写"没有日志"，而是写明
该用 `docker compose logs` 或 `journalctl --user -u <service>` 怎么取）。

文件名刻意不叫 `config.json` / `health.json`：包被误解到 data 目录时不会覆盖线上真实文件。
只读、不改配置、不重启服务、不写 `data/health.json`；`tar` 不可用时自动退化为同名 `.d`
目录（内容相同，绝不删除已存在的路径）。提 issue 时附上这个文件即可，不需要再贴配置或日志。
注意：配置里的 Key/Token 会被剔除，但**第三方插件自己打印到日志的内容**无法保证已脱敏。

## 发版前检查与覆盖率

```bash
node scripts/release-check.mjs                 # 版本/CHANGES/镜像 pin
node scripts/release-check.mjs --tag v0.9.14   # 额外校验 tag 与 package.json、[skip ci]
node scripts/release-check.mjs --allow-unreleased
node scripts/release-check.mjs --run-gates     # 再跑 lint/scan/unit（较慢）
npm run test:coverage                          # Node 内置覆盖率基线（零依赖）
```

`release-check` 检查：`package.json` 与 `docs/CHANGES.md` 最新版本章节一致、compose/README/
`docs/DOCKER.md` 的镜像 tag 一致、tag 指向的提交不带 `[skip ci]`（否则 Release/Docker 都不触发）。
`test:coverage` 只输出数字，不设硬门槛；后续里程碑按版本 ratchet。

## 子命令一览

| 子命令 | 对应原脚本 | 功能 | 适用场景 |
| --- | --- | --- | --- |
| `audit` | `ops/audit-server.sh` | 服务、代码与数据体检：systemd user 服务/定时器、启动补丁链可执行性、全量 js 语法、未定义调用扫描、关键补丁标记、config.json 关键项（密钥只报告有/无）、sqlite 完整性、控制台与协议端运行态、最近日志、主机资源 | 部署后验收；出现问题时用于定位 |
| `audit-host` | `ops/audit-host.sh` | 主机只读体检：失败单元、内存/磁盘/journald、Docker 容器与重启次数、监听端口、SSH 安全、防火墙、定时任务、可升级包、TLS 证书到期、备份现状 | 接手机器后的检查、例行巡检 |
| `audit-prune` | —（改进方案 #5 新增） | 删除 `data/audit-log/` 下超过保留月数的 `audit-YYYYMM.jsonl`（控制台写操作的审计留痕）；默认保留 6 个月，先 `--dry-run` 预演 | 每月定时执行（`qq-agent-audit-prune.timer`）；磁盘吃紧时手动执行 |
| `backup` | `ops/backup-qq-agent-data.sh` | 停止服务数秒 → AES-256-GCM 加密打包数据目录（`*.tar.gz.enc`）→ 启动服务 → 仅保留最近 N 份；任何失败路径都会重新启动服务 | 每周定时执行（配合 `.timer`）；重大变更前手动执行 |
| `restore` | —（0.9.9 新增） | 解密 → 路径校验 → 停服务 → 检查实例锁（仍被占用则拒绝）→ 旧数据移到 `data.pre-restore-*` → 解包 → 启动并确认 `is-active`；失败自动回滚。先 `--dry-run` 看归档条目，再 `--confirm` | 迁移、灾难恢复、备份演练 |
| `prune` | —（0.9.9 新增） | 只删除 `state='acked'` 且超过保留期的消息；`pending` / `held` 永远不删。`--days=N` 不传时读 `store.retentionDays`（0 = 不删） | 历史消息占用磁盘时；先 `--dry-run` |
| `scan` | `ops/scan-undefined-calls.py` + `ops/check-undefined-calls.sh` | 将注释/字符串/正则/模板串抹白后，查找「已调用但本文件既未定义也未 import」的函数名；默认只记录、不阻断（退出码 0）；`--strict` 下有可疑调用**或目录不存在**则退出 1（2026-10-03：路径写错也要让 CI 变红） | 修改 `src/*.js` 后；也可挂载到服务 `ExecStartPost` |
| `doctor` | —（2026-10-30 新增） | 生成诊断包：巡检 + 脱敏配置 + 存储占用 + 插件清单 + 异常台账 + 出站副作用账本状态（`effects.json`，含最近 unknown 的 id/动作/会话）+ 最近日志；只读 | 用户报 issue 时让对方先跑；自己排障时省去逐项收集 |
| `effects` | —（2026-10-31 新增） | 出站副作用账本的人工核对：`list [--state unknown]` 列记录；`resolve <id> --sent\|--failed --confirm` 改判 unknown（写 resolvedBy=manual）。只改账本，不补发/撤回消息 | 总览出现「出站动作待核对」、或 `doctor` 报账本 unknown 时 |
| `watch-send` | `ops/watch-send.py` | 监视 outbox 表的 rowid 水位线：基线之后新增 failed 行报 SEND_FAIL，新增成功行报 SEND_OK；同时检查是否再次出现未定义函数事故 | 修复发送链路后的线上验证 |
| `watch-login` | `ops/watch-login.py` | 每 15 秒轮询协议端 HTTP 端口，直至 QQ 登录成功，随后打印登录信息 / 控制台状态 / 最近日志 | 重启协议端容器或掉线重登后确认恢复 |
| `guard` | `ops/guard-process-explosion.sh` | 用户进程数超过阈值时清理失控的 bash/grep/tr/sh/sleep 进程树并记录现场（仅 Linux） | 配合 `process-guard.timer` 每 10 分钟执行 |
| `face-names` | `ops/export-face-names.sh` | 合并 SnowLuma 目录 / QQ 客户端配置 / 手工补充表，导出 `data/face-names.json` | QQ 新增表情、表情名不匹配时 |
| `snowluma-version` | —（协议端管理新增） | 看协议端（SnowLuma）镜像版本与是否落后于项目基线 | 排查「表情显示成图片」、确认协议端状态 |
| `snowluma-update` | —（协议端管理新增） | 把协议端镜像更新到项目基线（或 `--to` 指定镜像）：备份 .env/compose → pull → up -d → 等就绪，起不来自动回滚；`--dry-run` 预演 | 控制台「设置 → OneBot」一键更新的命令行等价 |
| `deploy` | `ops/deploy_qq_agent.sh` | 非交互部署：设置模型凭据后调用源码目录的 `deploy-all.sh -y` | 新机器初始化、CI 或远程 SSH 环境中的部署 |
| `console` | `ops/qq-console.bat` | 使用系统 `ssh` 建立控制台 / WebUI / 远程桌面三个端口的隧道，就绪后提示或打开控制台（Windows/macOS/Linux 通用） | 日常打开控制台 |
| `plugins` | —（插件生态新增） | 插件管理：`list` 列出已装插件（版本/能力/来源）与已授权清单；`install <文件.tar.gz>` **从本地文件装**（别人发的包、自己打的包）——sha256 由它算给你核对，装完来源记录写「本地文件：<文件名>」；`uninstall <id> [--purge-data]` 卸载并可选删除插件数据 | 不打开控制台就能装/看；小白用户拿到包只会在控制台装，命令行这条给运维与作者自测 |
| `install-timers` | `ops/systemd/` | 生成并安装五个 systemd user 定时器：备份（每周日 04:10）、恢复演练、进程看门狗（每 10 分钟）、健康巡检（每 5 分钟）、审计日志清理（每月 1 日 04:20） | 安装定时任务 |

## 部署纪律：只改 `ui/` 就不要重启服务

**重启会掐断 OneBot 连接**（实测每次约 3 秒：`Stopping → Started → 新进程建立 WS`），
群消息在那几秒里收不到。控制台的 `ui/` 是**每个请求现从磁盘读**的（`src/console/app.js` 的
`handleHttp` 静态分支：`statSync` + `readFileSync` + 内容哈希强 ETag），所以：

| 改了什么 | 怎么部署 | 要重启吗 |
| --- | --- | --- |
| 只动 `ui/**`（前端页面、样式、文案） | `rsync -a --delete <新树>/ui/ /data/qq-agent/app/ui/` | **不要** |
| 动 `src/**`、`package.json`、systemd unit、`.env` | 铺整棵树 + `systemctl --user restart qq-agent-linux.service` | 要 |

不重启也**不会**让已打开的页面拿着旧 JS：`/api/status` 里的 `uiBuild` 戳是**按请求现算**的
（2026-10-16 从"进程启动时算一次"改过来，就是为了让这条路成立），前端轮询发现它变了会提示
「控制台已更新，点此刷新」。部署完可以这样确认没重启：

```bash
systemctl --user show -p MainPID --value qq-agent-linux.service   # 部署前后 PID 应相同
```

## 备份/恢复与单实例锁

- `backup` 需要停服时，`systemctl stop` 失败会**中止备份**（不再生成可能不一致的归档）。
  归档生成后、加密前会按恢复侧同一套类型校验重读一遍：数据目录内若有符号链接/硬链接/
  设备文件，本次备份直接失败并提示移除，避免留下"备份成功但 restore/drill 必拒绝"的包。
- `restore` 停服后会再读一次 `<数据目录>/.server.lock`：仍被活实例占用（自定义服务名、
  容器、WSL 等）就拒绝覆盖并尝试把服务拉回。确认旧进程已退出后再恢复。
- 恢复会清掉归档里的旧 `.server.lock`（跨主机恢复不会被上一个 pid/hostname 挡住）。

## 单实例锁

控制台启动时会在 `<数据目录>/.server.lock` 写入 `{pid, hostname, startedAt}`：同一数据目录
第二个实例会拒绝启动（`E_INSTANCE_LOCKED`），避免两个进程同时写 `messages.sqlite`、
会话索引与插件目录。同机 pid 已不存在或锁文件损坏会自动接管；不同主机（共享盘）一律拒绝。
确认旧进程已退出后也可手动删除锁文件。`server.singleInstanceLock: false` 可关闭（不建议）。

边界：共享盘上"其它机器写的完整锁"一律拒绝；但**内容损坏且超过 5 秒**的锁会被当作
崩溃残留接管（无法确认是别的机器正在写）。容器/K8s 重建后 hostname 会变，若上次是
SIGKILL/OOM 留下的锁，新容器会因 hostname 不同被拒——确认旧容器已退出后删除
`.server.lock`，或在该部署显式关闭单实例锁（自行保证只跑一个实例）。

## 常用示例

```bash
# 体检（先主机层，再服务层）
node src/ops.js audit-host
QQ_AGENT_CONSOLE_TOKEN=xxx node src/ops.js audit

# 本地跑体检时指定仓库自身（默认看 /data/qq-agent/app）
node src/ops.js audit --app=. --data=./data

# 未定义调用扫描：默认带项目已知误报忽略表；传空 --ignore= 可看原始结果
node src/ops.js scan
node src/ops.js scan --ignore=
node src/ops.js scan --log="$HOME/qq-agent-undefined-calls.log"   # 有可疑调用时追加记录

# 备份（默认 AES-256-GCM 加密；先预演，再执行；N 默认取 QQ_AGENT_KEEP=4）
node src/ops.js backup --dry-run
node src/ops.js backup --confirm --keep=4
# 可选：把部署机的 .env / .deployment.json / deployment-access.txt 也加密进包
# （归档顶层 stack-credentials/；恢复时不会自动写回，需人工取用）
node src/ops.js backup --confirm --include-stack-creds
# 密钥：QQ_AGENT_BACKUP_KEY（64 位 hex 或口令）优先；否则用
# ~/.config/qq-agent/backup.key（首次备份自动生成，丢失则备份不可恢复）

# 恢复演练（解密最近一份备份到临时目录 + SQLite integrity_check，不碰生产数据）
node src/ops.js backup --drill

# 恢复（确认前先 --dry-run 看归档条目；服务起不来会自动回滚）
node src/ops.js restore --from ~/qq-agent/backups/qq-agent-data-xxxx.tar.gz.enc --dry-run
node src/ops.js restore --from ~/qq-agent/backups/qq-agent-data-xxxx.tar.gz.enc --confirm

# 历史消息清理（只删 state='acked' 且超期的；pending/held 永远不删；按会话复合键定位，删除后重算 message_count）
# 不传 --days 时读 config.json 的 store.retentionDays（0 = 不删）
node src/ops.js prune --days=90 --dry-run
node src/ops.js prune --days=90 --confirm

# 插件卸载（默认保留 plugin-data 与凭据；--purge-data 一并删除；--dry-run 预览）
node src/ops.js plugins uninstall my-plugin --confirm
node src/ops.js plugins uninstall my-plugin --purge-data --confirm

# 轻量指标（需控制台令牌）：JSON 或 Prometheus 文本
# 含 HTTP 请求/延迟、进程 RSS/heap、event-loop 利用率、LLM 调用/失败/重试/今日成本、
# outbox 各状态、入站队列最老年龄、OneBot 连接与发送失败、插件状态/RSS/调用统计。
curl -s -H "x-console-token: $TOKEN" http://127.0.0.1:3210/api/metrics
curl -s -H "x-console-token: $TOKEN" "http://127.0.0.1:3210/api/metrics?format=prometheus"
# 最近一次巡检结果（health.json）
curl -s -H "x-console-token: $TOKEN" http://127.0.0.1:3210/api/health

# 审计日志清理（控制台写操作留痕，按自然月切文件；默认保留 6 个月）
node src/ops.js audit-prune --dry-run
node src/ops.js audit-prune --confirm --keep-months=6

# 线上验证
node src/ops.js watch-send --minutes=240
node src/ops.js watch-login --timeout=25

# 进程看门狗
node src/ops.js guard --dry-run
node src/ops.js guard --confirm --threshold=800

# 表情名导出（容器在跑时直接导出；也可以给本地文件副本）
node src/ops.js face-names
node src/ops.js face-names --print
node src/ops.js face-names --catalog=/path/sys-face-catalog.json --qq-config=/path/face_config.json

# 非交互部署
QQ_AGENT_MODEL_API_KEY=... QQ_AGENT_MODEL_BASE_URL=... QQ_AGENT_MODEL=... \
  node src/ops.js deploy --dir="$HOME/qq-agent-src" --confirm

# 控制台隧道
SSHHOST=user@your-server node src/ops.js console --open
node src/ops.js console --print        # 只打印 ssh 命令
# 本机没有 Node：只下载一个脚本即可（不用克隆仓库）
#   Windows:      console-tunnel.bat [test|forget]
#   macOS/Linux:  bash console-tunnel.sh [test|forget]
#   test 做连通性自检（输出 TEST_OK / 非零退出）；forget 清除记住的服务器地址

# 定时器
node src/ops.js install-timers --print
node src/ops.js install-timers --confirm
```

## 环境变量

所有带默认值的路径均可覆盖。注意：`install.sh` / `deploy-all.sh` 默认部署到
`/mnt/data/qq-agent`，而 `ops.js` 的历史默认仍是 `/data/qq-agent`。用安装器装完后请先
`export QQ_AGENT_DIR=/mnt/data/qq-agent`（或显式传 `--dir` / `--data`），否则体检、备份和
定时器会看错目录。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_AGENT_DIR` | `/data/qq-agent` | 部署根目录 |
| `QQ_AGENT_APP_DIR` | `$QQ_AGENT_DIR/app` | 应用目录（`src/`、`ui/`、自带 `.runtime/node`） |
| `QQ_AGENT_DATA_DIR` | `$QQ_AGENT_DIR/data` | 数据目录（config.json、sqlite、sessions） |
| `QQ_AGENT_BACKUP_DIR` | `$HOME/qq-agent/backups` | 备份输出目录 |
| `QQ_AGENT_BACKUP_KEY` | 空 | 备份加密密钥（64 位 hex 或口令）；不设则读密钥文件 |
| `QQ_AGENT_BACKUP_KEY_FILE` | `~/.config/qq-agent/backup.key` | 密钥文件；首次加密备份自动生成（0600） |
| `QQ_AGENT_SERVICE` | `qq-agent-linux.service` | systemd user 服务名 |
| `QQ_AGENT_KEEP` | `4` | `backup` 保留份数（也可用 `--keep=N`） |
| `QQ_AGENT_USER` | 当前登录用户 | 进程/定时任务检查的目标用户 |
| `QQ_AGENT_NODE` | 自动查找 `$APP_DIR/.runtime/node-*/bin/node` | 执行 `--check` 使用的 node |
| `QQ_AGENT_LOG` | —（无消费者） | 历史遗留名：`scan` 的报告文件只认 `--log=` 显式指定，这个环境变量**不生效**（ops.js 帮助原文自述"仅文档用途"） |
| `QQ_AGENT_LOG_LEVEL` | `info` | 应用日志级别（`error`/`warn`/`info`/`debug`，改进方案 #6） |
| `QQ_AGENT_LOG_FORMAT` | `text` | 应用日志格式（`text` 保持原观感 / `json` 单行供 journald 过滤） |
| `QQ_AGENT_CONSOLE_PORT` | `3210` | 控制台端口 |
| `QQ_AGENT_ONEBOT_HTTP_PORT` | `3390` | 协议端 HTTP 端口 |
| `QQ_AGENT_CONSOLE_TOKEN` | 无（未设置时回退到 `config.json` 的 `server.token`；两者均无则跳过相关检查） | 控制台 API token |
| `QQ_AGENT_ONEBOT_TOKEN` | 无（未设置时回退到 `config.json` 的 OneBot 令牌） | 协议端 access token |
| `QQ_AGENT_UPDATE_TIMER` | `qq-agent-linux-update.timer` | 自动更新定时器名（`audit` 只读检查） |
| `QQ_AGENT_GUARD_TIMER` | `process-guard.timer` | 进程看门狗定时器名 |
| `QQ_AGENT_OVERRIDE_CONF` | `~/.config/systemd/user/<service>.d/override.conf` | 启动补丁链检查使用的 override 文件 |
| `QQ_AGENT_HOST_UPDATE_PATTERN` | `hermes\|unattended\|update` | 主机级更新定时器过滤正则 |
| `QQ_AGENT_GUARD_USER` | `QQ_AGENT_USER` | 看门狗监视的系统用户 |
| `QQ_AGENT_PROC_LIMIT` | `800` | 看门狗阈值（也可用 `--threshold=N`） |
| `QQ_AGENT_GUARD_LOG` | `$HOME/process-explosion.log` | 看门狗现场记录文件 |
| `QQ_AGENT_SNOWLUMA_CONTAINER` | `qq-agent-snowluma` | 协议端容器名（`face-names` 使用） |
| `QQ_AGENT_WEBUI_PORT` | `5099` | SnowLuma WebUI 端口（`console` 隧道） |
| `QQ_AGENT_VNC_PORT` | `6081` | QQ 远程桌面 / 扫码端口（`console` 隧道） |
| `QQ_AGENT_SYSTEMD_DIR` | `~/.config/systemd/user` | `install-timers` 写入目录 |
| `QQ_AGENT_SRC_DIR` | `$HOME/qq-agent-src` | `deploy` 的源码 checkout 目录（也可用 `--dir=`） |
| ~~`QQ_AGENT_ROOT_DIR`~~ | — | 已废弃：该环境变量**不生效**（代码从不读取）；`deploy` 的部署根目录请用 `--root-dir=` 参数，或直接用 `QQ_AGENT_DIR` |
| `QQ_AGENT_MODEL_API_KEY` / `QQ_AGENT_MODEL_KEY_FILE` | 无（必填其一） | 模型凭据（文件优先级低于环境变量） |
| `QQ_AGENT_MODEL_BASE_URL` / `QQ_AGENT_MODEL` | 无（必填） | 模型网关地址 / 模型名 |
| `SNOWLUMA_IMAGE` | `motricseven7/snowluma:v1.14.22` | 协议端镜像（`deploy`）；已部署的实例可在控制台「设置 → OneBot → 协议端」一键升级/回滚 |
| `QQ_AGENT_SNOWLUMA_DIR` | `<root>/snowluma` | 协议端 compose 项目目录（一键更新与体检读它的 `.env`） |
| `QQ_AGENT_IMAGE_MIRROR` | 空 | 追加自己的镜像站（逗号分隔多个；等价于 `deploy-all.sh --image-mirror`），排在**内置兜底列表之前**。留空时也会先用内置的公共加速站（`docker.1panel.live`、`docker.m.daocloud.io`），所以国内直连不上 Docker Hub 的开箱安装通常不用设它；用法见 `docs/LINUX.md` |
| `QQ_AGENT_ONEBOT_WS_PORT` | `3001` | 协议端 WebSocket 端口（`deploy`；与 install.sh 全栈默认一致） |
| `SSHHOST` / `QQ_AGENT_SSH` | **必填**（缺失直接报错退出） | 服务器地址；两种写法都支持：`SSHHOST=host` 或 `SSHHOST=user@host` / `QQ_AGENT_SSH=user@host` |
| `SSHUSER` | `ubuntu` | SSH 登录用户 |
| `SSHPORT` | `22` | SSH 端口 |

安全约定：token / 口令仅从环境变量或部署生成的配置文件读取，不得写入脚本或提交到仓库。

## 日志（级别 / 格式 / trace id）

应用日志（改进方案 #6）默认输出与升级前逐字相同：`text` 格式直通 stdout/stderr，只多了一层
脱敏（Bearer / 查询串 / JSON 体 / Cookie / 裸 `sk-`-`pk-`-`rk-` 开头的密钥），并且**一次运行内的
日志会自动带 `[<traceId>]` 前缀**。

- `QQ_AGENT_LOG_LEVEL=debug`：打开调试级（默认 `info`；也可设 `warn` / `error` 更严）；
- `QQ_AGENT_LOG_FORMAT=json`：每条一行 JSON（`{ts,level,scope,traceId,msg}`），方便 journald 过滤，
  例如 `journalctl --user -u qq-agent-linux.service -o cat | grep '"level":"error"'`；
- **traceId**：每次运行（消息唤醒、以及群日报 / 空间互动 / 每日动态的定时轮次）分配一个 8 位 id，
  这段运行里的日志都带同一个 id；控制台 HTTP 的响应头 `x-trace-id` 是那次请求的 id。
  排查"这一轮到底发生了什么"：
  ```bash
  journalctl --user -u qq-agent-linux.service -o cat | grep '<traceId>'
  # 或看接口：GET /api/status 的 lastTraceId 字段 = 最近一次运行的 id（控制台界面暂未展示）
  ```
- 注意：`node src/ops.js …` 这条链路的输出不走应用日志（仍是直接打印）。

## 退出码

| 子命令 | 退出码 |
| --- | --- |
| `scan` | 默认 0（只记录、不阻断）；`--strict` 下有可疑调用或目录不存在则退出 1 |
| `watch-send` | 0 = 工具层成功发出消息；1 = 发送失败或再次出现未定义函数；2 = 超时 |
| `watch-login` | 0 = 已登录；1 = 超时或缺少令牌 |
| `backup` / `deploy` / `install-timers` / `audit-prune` | 0 = 成功；1 = 参数或执行失败（缺少 `--confirm` 亦返回 1） |
| `audit` / `audit-host` | 恒为 0（问题仅体现在 NG / [注意] 行数） |
| `guard` | 0 = 正常或仅告警；超阈值且未加 `--confirm` 时返回 1（真实清理需显式确认） |

## 定时任务

`install-timers` 生成五个 unit。`--print` 仅打印内容，`--confirm` 写入
`~/.config/systemd/user/` 并执行 `systemctl --user daemon-reload && enable --now`：

- `qq-agent-backup.timer`：`OnCalendar=Sun *-*-* 04:10:00`、`Persistent=true`，
  调用 `node src/ops.js backup --confirm`；
- `qq-agent-backup-drill.timer`：每月执行一次 `ops backup --drill --confirm`，验证备份可解密、
  tar 与 SQLite 完整性；
- `process-guard.timer`：`OnBootSec=3min`、`OnUnitActiveSec=10min`，
  调用 `node src/ops.js guard --confirm`；
- `qq-agent-health.timer`：`OnBootSec=5min`、`OnUnitActiveSec=5min`，
  调用 `node src/ops.js health-check --confirm`；
- `qq-agent-audit-prune.timer`：`OnCalendar=*-*-01 04:20:00`、`Persistent=true`，
  调用 `node src/ops.js audit-prune --confirm`（控制台写操作审计留痕的月度清理）。

生成的 ExecStart 使用当前 node 与 `src/ops.js` 的绝对路径。更换机器或部署目录后，重新执行
`install-timers --confirm` 即可，也可直接修改 unit 中的路径。

## 远程执行

仓库不再包含开发机专用的 ssh/paramiko 文件传输与执行脚本（原 `ops/sshcmd.py`、
`ops/sshrun.py`、`ops/sshupload.py`、`ops/sshget.py`）。**远程执行直接使用 `ssh` / `scp`**，
例如：

```bash
ssh user@host 'cd /data/qq-agent/app && node src/ops.js audit'
scp user@host:/data/qq-agent/data/messages.sqlite ./messages.sqlite
```

本项目仅额外提供 `console` 子命令用于端口隧道（控制台 / WebUI / 远程桌面），便于日常打开
控制台。

## 旧 ops/ 迁移对照

- 命令对应关系见上方子命令一览表；所有默认路径与变量名保持不变；
- 已知差异：
  - `watch-send` / `watch-login` 改为在本机（或通过 SSH 登录的目标机器）直接运行，不再内置
    SSH 客户端；轮询间隔新增 `--interval` 选项，便于调试；
  - `backup` 在缺少 `systemctl` 的环境（如 Windows）仅跳过停止/启动服务，仍会打包数据；
  - `scan` 默认带项目已知误报忽略表（等价于原 `check-undefined-calls.sh`），`--ignore=` 可
    关闭；`--log=文件` 等价于原启动自检的日志行为；
  - `audit` 的第 4 节会打印每个文件的未定义调用明细，并在结论中重复计数。

## `ops scan --strict` 的覆盖边界

只覆盖**同行裸标识符调用**（"调用点有、定义没有"那类历史事故）。不覆盖 `this.x.y()` 之类的属性调用，
且行首的裸调用会被误当成"定义" —— 它是一道粗筛，不是类型检查。
