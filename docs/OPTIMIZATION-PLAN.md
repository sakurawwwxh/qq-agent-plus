# qq-agent-plus 优化方案

> 基于 2026-11-04 与 2026-11-05 两轮全项目审查、单元/回归/浏览器测试和线上只读巡检。
> 目标不是“重写”，而是把已经稳定的单机机器人逐步变成**可发布、可观测、可回滚**的服务。

## 本轮已落地（2026-11-05）

- 线上：release 只留最近 3 份、journald vacuum 到 300M，根盘从 82% 降到 78%（约释放 1.5G）。
- 健康检查新增“磁盘已用 >85%”阈值；每日保留期调度新增 SQLite `wal_checkpoint` + `optimize`。
- `web_search` 取消信号贯通所有 provider、聚合链与梗补充链。
- 备份/恢复：同级 `.maintenance.lock` 跨进程互斥、SIGINT/SIGTERM/SIGHUP 守卫、文件名随机后缀。
- MCP：崩溃有界自动重启；新增 `networkIsolation`（Linux netns）与 `permissionIsolation`
  （Node 权限模型，只读入口目录、禁止写/子进程/Worker；非 node 命令 fail-closed）、`memoryMb`；
  隔离模式剥离 `NODE_OPTIONS`/`LD_PRELOAD`。
- 插件：控制台“安装文件/URL”升级遇到权限面变化会展示 diff 并带 `expectedDiffHash` 重试；
  权限面变化后清批准/关写开关。
- unknown：控制台支持筛选/全选/批量核对/导出 JSON（逐条审计）；新增默认关闭的
  `outbox.unknownAutoReleaseDays` 超期释放策略；健康巡检带上最老 unknown 年龄。
- 观测/CI：`/api/metrics` 增加 unknown/held、MCP 重启、磁盘指标并进 Prometheus 与控制台卡片；
  覆盖率从“只出数”改为门槛 ratchet（line 67% / branch 69% / funcs 72%）。
- 2026-11-05 复核补强：MCP 隔离拒绝 args 内权限/加载器参数、拒绝白名单内越界软链；
  outbox 单条核对绑定会话；维护锁接管互斥与 owner 精确 release；插件旧清单损坏时
  非 force 拒绝、force 按权限已变清授权；`ops effects resolve` 不碰 `sending`；
  unknown 自动释放逐条审计；Prometheus pending 指标取 `sending` 桶。

尚未做（见下文优先级）：控制台/orchestrator 大文件拆分、独立可观测性页面、消息归档后的
自动清理（`store.retentionDays` 仍默认 0）、npx/docker 类 MCP 的外部沙箱、插件付费能力的
按插件配额。

## 现状基线

- 通过的门禁：ESLint、`src/ops.js scan --strict`、约 2700 条单元测试（0 fail / 55 skip）、
  回归脚本、Playwright、`release-check`、覆盖率基线（只出数，无阈值）。
- 主要体量：`src/console/app.js` 4335 行、`src/core/orchestrator.js` 4206 行、
  `src/tools/tools-core.js` 3513 行、`src/ops.js` 3451 行、`src/core/store.js` 1770 行、
  `src/identity/identity-store.js` 1951 行。
- 线上：systemd user 单元、SQLite/WAL、控制台只监听 0.0.0.0:3210（安全组未放行）；
  2026-11-04 实测根盘 40G 约 82% 使用，`releases` 约 1.1G、备份约 950M、journald 约 832M。
- 已知的最大结构性缺口：MCP 子进程没有复用插件的权限/网络隔离；备份/恢复没有信号收尾与
  跨进程互斥；`web_search` 没有把本轮取消信号传进各 provider。

## 优先级总览

| 优先级 | 事项 | 收益 | 成本 |
| --- | --- | --- | --- |
| P0 | 发布本轮修复 + 磁盘清理 + 发布保留策略 | 直接降低“盘满导致服务全挂”的风险 | 0.5–1 天 |
| P0 | `unknown` 发送记录的批量核对/释放口径 | 解除少数会话被永久卡住 | 1–2 天 |
| P1 | 备份/恢复信号收尾 + 互斥锁 | 避免半套恢复数据与明文残留 | 2–3 天 |
| P1 | MCP 权限/网络隔离 | 关闭最大的第三方代码执行面 | 1–2 周 |
| P1 | `web_search` 取消信号贯通 | 停止/超时后不再空跑与重复计费 | 2–3 天 |
| P1 | 插件升级两段式确认 UI | 升级权限面变更可控 | 2–3 天 |
| P2 | 控制台/orchestrator 拆分 | 降低改动风险与评审成本 | 2–4 周 |
| P2 | SQLite 维护与消息保留 | 控制长期磁盘/查询成本 | 3–5 天 |
| P2 | 覆盖率 ratchet + 故障注入 | 把“靠人审查”变成“靠门禁” | 1 周 |

## P0：先让线上稳下来

### 1. 发布与磁盘

**问题**：自动更新只负责换代码，不清理旧 release、旧备份和 journald；根盘 82% 时，
一次备份/升级就可能把 SQLite 写失败放大成服务不可用。当前也没有“保留最近 N 个 release”
的显式策略。

**动作**：
1. 发布前按 `docs/OPS.md` 做一次备份 + `backup-drill`，再用 `release-check` 通过后上线；
   上线后跑 `node src/ops.js doctor` / 健康检查，确认 5 个定时器与 `systemd-timers` 项为绿。
2. 立即清理：保留最近 3 个 release（含当前回滚目标）、备份保留 14 天、journald 限制到
   200–500M；清理前先确认最新备份可恢复（drill 已覆盖）。
3. 把清理固化成运维脚本/定时器，而不是一次性手工命令；健康检查现在只看“剩余 <1GB”，
   建议再加一条“使用率 >85% 报警”（40G 盘对应约 6GB 余量，比 1GB 更早介入）。

**验收**：根盘使用率降到 60% 以下；健康检查能对磁盘阈值报警；重启后服务 active。

### 2. `unknown` 发送记录的处置口径

**问题**：`sending` 现在会在运行期降级为 `unknown`（本轮已修），但 `unknown` 仍是终态：
开了 `unknownWritesBlockChat` 的群会一直等管理员逐条核对；控制台没有批量导出/批量核对，
记录多时运维成本高。

**动作**：
1. 控制台增加按会话/时间筛选、导出 JSON、批量“确认已发送/未发送”（仍逐条写审计）。
2. 明确产品口径：超过 N 天且同会话无新 `unknown` 的记录，是否允许自动转“仅审计、不阻塞”；
   若允许，新增 `outbox.unknownAutoReleaseDays` 默认关闭，先在测试群灰度。
3. 健康巡检把 `unknown` 数量与最老年龄纳入日报，而不是只在控制台可见。

**验收**：一个被 `unknown` 卡住的会话可以在 3 次点击内解除；审计日志能追溯到操作者。

## P1：可靠性与安全

### 3. 备份/恢复的信号收尾与互斥

**问题**（`docs/KNOWN-ISSUES.md` 已登记）：SSH 里 Ctrl+C/SIGHUP 会跳过 `finally`，
可能留下“服务停着 + 半套恢复数据”或明文 `.plain`；同秒启动两个备份会撞同名文件，
备份与恢复也可能交错。

**动作**：注册 `SIGINT`/`SIGTERM`/`SIGHUP` 收尾；用 `DATA_DIR/.maintenance.lock`
做跨进程互斥（带 pid/hostname/心跳，陈旧锁可接管）；备份文件名加随机后缀；恢复前校验
归档类型与数据目录链接，失败时自动回到恢复前快照。

**验收**：故障注入测试在备份/恢复中途发信号，服务能回到可用状态且没有明文残留。

### 4. MCP 与插件同一套隔离

**问题**（`docs/KNOWN-ISSUES.md` 已登记）：MCP stdio server 以宿主用户身份运行，
能读数据目录、网络与宿主环境；导入的 npm/OCI 包一旦有恶意代码，隔离面小于插件。
本轮已补“崩溃自动重启”，但没有解决隔离。

**动作**：优先在 Linux 上复用插件宿主的 `--permission` + `unshare --net` 启动方式；
Windows/macOS 明确降级为“管理员显式信任”，在控制台首次启用时二次确认并展示风险；
MCP 配置增加 `memoryMb`/`timeoutMs` 上限与启动命令白名单校验。

**验收**：Linux 上 MCP 子进程无法访问数据目录与内网；无隔离平台在 UI 上有明确风险提示。

### 5. `web_search` 取消信号贯通

**问题**（`docs/KNOWN-ISSUES.md` 已登记）：工具层没有把本轮 `AbortSignal` 传进聚合
搜索链，停止/超时后底层 provider 请求仍会跑 60–75s，批次重试可能重复计费。

**动作**：`webSearch(query, { meme, signal })` 一路传到 `withTimeWindow` 与各 provider 的
`fetch`；用 `AbortSignal.any([signal, timeout])` 组合；聚合链在每个 provider 之间检查
`signal.aborted`，已取消就不再发起下一个。

**验收**：取消后 1s 内不再有新的 provider 请求；计费日志不出现同一批次的重复调用。

### 6. 插件升级的两段式确认 UI

**问题**（`docs/KNOWN-ISSUES.md` 已登记）：API/CLI 已支持 `expectedDiffHash`，控制台
“安装文件”遇到 `E_UPGRADE_CONFIRM` 只显示错误；升级后也不重置授权/关闭写开关。

**动作**：控制台展示权限面 diff（新增能力、配额、apiVersion），确认后带哈希重试；
升级成功默认 `resetPluginGrants` 并关闭写开关，需要管理员重新授权。

**验收**：同 id 升级新增 `http`/`secrets` 能力时，未确认无法完成；确认后旧批准不继承。

## P2：架构与长期成本

### 7. 拆分控制台与编排器

**问题**：`app.js` 4335 行、`orchestrator.js` 4206 行，单文件已经接近“改一处要读半天”
的规模；现有 `src/console/routes/` 只承接了一部分路由。

**动作**：
- 控制台按域拆：`routes/{config,plugins,mcp,backup,identity,chat}.js` + `services/`；
  `app.js` 只保留装配、生命周期与共享闭包，目标 ≤1500 行。
- orchestrator 拆成 `turn-runner`（一轮生命周期）、`tool-loop`（工具调用/重试）、
  `delivery`（发送/账本/held）、`prompt-builder`；共享状态用显式 context 对象传递。
- 用 `test/src-size.test.mjs` 的 ratchet 每批下调基线；新增 `import` 边界测试，
  禁止 `core → console`、`llm → console` 这类反向依赖。

**验收**：两个文件都降到 1800 行以内并从 ALLOWLIST 移除；行为测试零改动通过。

### 8. SQLite 维护与消息保留

**问题**：`store.retentionDays` 默认 0（永不删消息），`maxMessagesPerChat` 默认 0
（不限制单群条数）；长期运行后 `messages` 表只增不减。WAL 也没有周期性 checkpoint/
`PRAGMA optimize` 的固定节奏。

**动作**：
1. 每日低峰执行 `PRAGMA optimize` 与 `wal_checkpoint(TRUNCATE)`；每月维护窗口做一次
   `VACUUM`（或确认备份已用 `VACUUM INTO`）。
2. 提供“归档后删除”策略：按 `store.retentionDays` 先导出压缩归档，再删 `acked` 行；
   默认仍为 0，但在控制台显示当前库大小与预计可释放空间。
3. 用 `EXPLAIN QUERY PLAN` 固化热查询（待处理队列、最近消息、outbox 按会话）计划，
   防止新增索引后反而走错索引。

**验收**：连续运行 30 天数据库增长可预测；控制台能看到库大小与归档任务结果。

### 9. 覆盖率 ratchet 与故障注入

**问题**：覆盖率只出数不设阈值；测试并发 4 时出现过整文件 flaky（端口冲突、
EADDRINUSE），目前靠本地 `QQ_AGENT_TEST_CONCURRENCY=2` 规避。

**动作**：
1. 以当前覆盖率为基线，每个 release 提高 2%（先 core/store、orchestrator、plugins）。
2. 测试端口统一用 `listen(0)` + 读取实际端口；网络类用例加 `skip` 条件而不是固定端口。
3. 故障注入套件：MCP 崩溃（本轮已加）、磁盘写满、`SQLITE_BUSY`、EPIPE、
   备份中途 SIGINT、插件子进程被杀。

**验收**：CI 在并发 4 下稳定；覆盖率低于基线直接红。

### 10. 可观测性

**问题**：排障仍以日志为主，缺少按 run 聚合的指标（队列深度、发送延迟、LLM 错误率、
MCP 重启次数、插件违规次数）。

**动作**：在控制台“运行状态”增加一页指标卡；日志统一带 `runId`/`chatKey` 短标识；
把 `outbox unknown`、`held`、`MCP restartAttempts`、磁盘水位纳入健康日报。

**验收**：出现“群里不回话”时，能在一个页面看出是队列、LLM、发送还是 MCP 故障。

## 建议的落地顺序

1. **本周**：发布本轮修复；清理磁盘并固化保留策略；确定 `unknown` 处置口径。
2. **两周内**：备份/恢复信号与锁；`web_search` 取消信号；插件升级确认 UI。
3. **一个月内**：MCP 隔离（Linux 先行）；覆盖率 ratchet；SQLite 维护任务。
4. **季度**：控制台/orchestrator 拆分；可观测性页面；消息归档策略。

## 不建议现在做

- **SQLite 换 Postgres**：单机、单进程、数据量可控，迁移带来的运维成本大于收益。
- **全量微服务化**：当前瓶颈是单文件复杂度与运维流程，不是横向扩展。
- **Windows 上强上 netns 隔离**：平台不支持；应明确“管理员显式信任 + 风险提示”，
  把强隔离放在 Linux 部署路径。
- **为了覆盖率数字补无意义断言**：优先补状态机、账本、失败路径的行为测试。
