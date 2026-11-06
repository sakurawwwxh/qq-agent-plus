# 已知问题

本文档仅记录**当前基线上稳定复现、尚未修复**的问题，以避免 CI 重复报告同一问题。
问题修复后即从本文档删除。

## 待修问题

### 2026-11-03 遗留

- **outbox 的 `unknown` 年龄上限默认关闭**：启动和运行期都会把遗留/卡住的 `sending`
  降级为 `unknown`，进入人工核对清单；控制台已支持筛选/全选/批量核对/导出 JSON，
  并有 `outbox.unknownAutoReleaseDays`（默认 0，上限 90）让"整段会话都安静超过 N 天"的
  unknown 按已发送留痕自动释放。默认关闭是产品口径：自动释放意味着放弃人工确认，
  可能漏掉一条实际未送达的回复；开启前应先在测试群观察。

### 2026-11-01 第四轮交叉盲审遗留

- **价格编辑不回算当日账本**：`usage-today.estimatedYuan` 是调用时按当时价目写入的快照，
  改价后只影响之后的调用；`/api/status` 与页面用 `max(会话聚合, 账本)` 避免页面金额
  偏低，但后台调用（记忆整理/日报等）的历史部分仍是旧价。修法方向：记录价格版本或
  在改价时重算当天账本，需要产品口径确认是否追溯。
- **记忆整理成本随成员数线性增长**：每个候选成员会取最近 30 条发言（≤200 字/条）作
  补充证据，大群一次全量整理会显著增加 prompt。当前受 `maxMembers`/分批与手动确认约束；
  修法方向：按 token 预算动态截断，而不是固定“每人 30 条”。
- **存储压缩路由仍逐个同步读写归档**：`/api/storage/compress` 的 gzip 已改为异步
  （`gzipAsync` 每次 await 让出事件循环），但单次请求最多处理 100 个归档，每个归档的
  `stat/readFile/writeFile/rename` 仍是同步调用；大目录下会有短暂停顿，不是原先描述的
  “整个压缩过程同步阻塞”。修法方向：改成后台任务 + 进度查询，或把读/写也移到 worker。

### 关键词黑名单的 `re:` 只匹配前 2000 字（2026-10-31 登记）

为了保证同步 ingest 不被灾难性回溯拖死，`re:` 规则只对消息前 2000 字做匹配：
- 广告放在 2000 字之后可绕过 `re:` 规则（普通字面量规则不受影响，仍全量包含匹配）；
- `$` 的语义在截断点成立，`re:^.*广告$` 可能在"前 2000 字末尾是广告、后面还有正文"时误杀；
- 「消息类型 → 合并转发自动展开」关闭时，转发内容只看到占位符，黑名单无法过滤
  （开启自动展开时，展开后的正文会在入库前复查一次黑名单）。
修法方向：改成重叠窗口扫描或强制 `re:` 锚定在 `^`，并把截断长度与协议端单条上限对齐。

### 2026-10-30 全项目审查遗留

本轮已修复：插件能力调用的并发/限频闸门（含子进程退出后计数复位）、技能市场 `homepage`
的 scheme 校验、插件 feed 封面的 SSRF、同版本重装的权限面变更确认（含配额增删/apiVersion）、
install-file 与 CLI 安装的确认哈希入口、MCP 单次超时误置 not-ready（连续 3 次才标记）、
degrade 闸门漏看队尾 @（并从 @ 那条开始领取）、degrade 全量扫描的循环/上限防御、关系影子
评估绕过 `memory.visibility`、暂停期间每日动态白跑并被记成阻断、控制台存档新消息不刷新、
屏蔽名单切群竞态、记忆详情重绘冲掉编辑、设置未保存改动确认（所有 switchTab 入口统一）、
quiet 保存后误报未保存、保存双写/暂停半生效/并发保存旧快照与审计快照、reminders cron 扫描
的 Intl 重复构造、face-catalog 数据目录口径、lifecycle 收尾写库失败阻塞会话（补 ack）、
生图额度在结果未知时误退、贴表情/查表情回应的跨会话归属校验、`get_recent_messages` 长度
上限、safeFetch 重定向不剥离凭据头、run 超时的批次重试放大、失败批次重试的上下文条数口径、
控制台备份/恢复按部署元数据解析服务名、脱敏回填的大小写不敏感匹配。以下为登记待修：

**插件 / MCP**

- `media.describe` 的视觉调用没有用户可调的配额，目前只有"每插件 60 次/小时"的硬上限
  （2026-11-04 已加，防止无限放大付费调用）；`media.asr.transcribe` 已复用宿主 ASR 配额。
  要按插件配置额度，需要在 manifest 里引入统一的付费能力键（`src/plugins/capabilities.js`）。
- 待批审批只保存 `actionPreview` 前 300 字，管理员批准的是全文哈希
  （`src/plugins/grants.js:290`、`src/plugins/registry.js:686`）。
- 控制台备份/恢复若把备份口令放在 `QQ_AGENT_BACKUP_KEY`，会经 `systemd-run --setenv` 进入
  进程参数与 transient unit 环境（同机可见）；建议改为 0600 临时 key 文件 + `*_KEY_FILE`
  （`src/console/app.js:5939`）。
- cron 提醒在 DST 切换日按传统 cron 语义处理：秋季回拨的重复小时会触发两次，春季跳过的
  挂钟时间当天不触发（daily/weekly 则顺延到跳变后）。这是有意保留的差异，因为 cron 本身
  允许一天多次触发，不能按"每个本地日期一次"去重（`src/core/reminders.js:198`）。
- degrade 的全量未读扫描有 2 万条上限：病态积压（>2 万 pending）时队尾 @ 仍可能扫不到，
  且每 5s 恢复循环会重扫；更稳的做法是按最新 id 反向扫描或用 mention 游标
  （`src/core/store.js:395`）。
- `requireIsolation:false` 时 `--max-old-space-size` 不生效，`memoryMb` 形同虚设
  （`src/plugins/isolation.js:86`）。

**控制台前端**

- 表情包批量导入的 object URL 在关闭弹窗/导入成功后不释放（`ui/pages/features.js:373`）。
- 用量页轮询没有校验范围/序号，旧响应会覆盖新范围（`ui/pages/usage.js:1042`）；
  "展开全部"用进页面时的旧快照回填（`:707`）。
- 长期记忆页切范围没有请求序号，旧响应可能覆盖（`ui/pages/living-memory.js:755`）。
- 关系状态行的 15 秒定时器在离开分区后不清理（`ui/relationship-pilot.js:171`）。


### `read` 的语音转写可能超过工具超时（2026-10-24 审查）

`bilibili.read` 声明 `timeoutMs: 300000`（5 分钟），但宿主 ASR 允许 ffmpeg 15 分钟、默认允许
20 分钟视频走转写。无字幕的长视频遇上慢 ASR 时，会在转写中途被宿主判超时，结果被丢弃。
修法方向：把媒体类工具的超时上限放宽（manifest 目前最大 300 秒）并与 ASR 上限对齐，
或按视频时长分段转写、每段独立超时。

### 只读挂载的数据目录无法用在线 backup API 备份（2026-10-21 复查记录）

`manage.sh backup` 对所有 `*.sqlite` 走 SQLite 在线备份。SQLite 3.22+ 在"文件可读、目录不可写"
时要求 WAL 库存在可读的 `-shm`，否则打开失败；把数据盘 `mount -o ro` 后做灾难恢复备份时，
若库已 checkpoint 且 `-shm/-wal` 不存在，这一步会失败（旧实现对其他库是 `cpSync`，这种场景能拷）。
正常可写数据目录不受影响。需要只读备份时，先确认 `-wal` 为空或临时以可写方式挂载再备份。

### 协议端一键更新不走镜像兜底（2026-10-13 登记）

`deploy-all.sh` 拉镜像已有内置公共加速站兜底（`docs/LINUX.md`），但**控制台「一键更新协议端」
与「随智能体版本对齐」**走的是 `src/core/snowluma-update.js`：它只把 `snowluma/.env` 的
`SNOWLUMA_IMAGE` 改成目标 tag 再 `compose pull`，没有镜像站回退 —— 国内/受限网络直连
Docker Hub 失败时，这条更新路径仍会报拉取失败（首次全栈安装不受影响）。临时办法：先把
`snowluma/.env` 里的 `SNOWLUMA_IMAGE` 改成带可信镜像前缀的引用
（如 `<mirror>/motricseven7/snowluma:<tag>`，重启容器后生效），再点控制台更新。根因修法
（把部署脚本的兜底列表接进 `snowluma-update`）留下一批。

### 主动运行期间的「核对」会清掉在途 outbox 证据（2026-10-13 审查，窄竞态）

`store.resolveHeld` 判断"哪些 run 还活跃"只看 `runs` 表；**主动唤醒没有 runs 行**
（`session.leaseId = lease?.id || session.id`，工具发送用 leaseId 当 runId）。于是管理员恰好
在某会话的主动唤醒**正在运行**时点「核对」，会把该次在途的 `sending/unknown` 行一并清掉，
`hasUncertainEffects(session.leaseId)` 的兜底不再触发 —— 一次结果未知的发送可能被当干净收尾
（后续轮次理论上可重发）。触发需人工操作与运行同刻，影响面小。修法方向：把活跃主动会话的
id 集合（`activeRuns` 的 sessionId）传入 store，清理时排除。留待下一批处理。

### 直连协议端的写入工具不走发送队列的 outbox（2026-10-08 复审记录）

**2026-10-31 更新**：直连协议端的写操作（贴表情/签名/状态/备注/签到/待办/头像/资料/群名片/
禁言/踢人/撤回/设管理员/相册点赞与评论）已接入副作用账本（只登记，不拦截）：协议端明确拒绝
或连接被拒记 `failed`，超时/连接重置记 `unknown`，控制台与 `ops doctor` 能看到。下面说的
"不走 outbox、结果不确定不会进 unknown"仍然成立 —— 账本只提供可观测性，不改变这些调用的
重试行为；`unknown` 行需人工核对（`resolve` 或按日志/`effects.json` 排查）。

`react_to_message` / `set_my_signature` / `set_my_status` / `set_remark` / `group_sign` /
`set_group_todo` 这类**直接调用协议端**的写入工具不经过 `SendQueue` 的 `#deliver`，因此传输结果
"不确定"（超时、5xx、连接重置）不会记进 outbox 的 `unknown`，工具循环的 `hasUncertainEffects`
也看不到它们 —— `sender.js` 那套「不确定就不许重复」目前只覆盖走队列的文本/贴纸/语音/表情/
戳一戳/文件/相册。

后果：这类调用在超时后若被重试，理论上可能把同一个动作做两遍。影响有限 —— 它们大体幂等
（重复贴一次表情、重复设一次签名，结果相同），且各自有 24h 闸门配额封顶。
真要收口需要让这些工具也走发送队列（或明确"哪些动作允许不确定地重复"），涉及写路径重构，
单独排期。

- **非 Linux 平台拦不住插件网络**：Node 的权限模型覆盖 fs / child_process / worker / addons，但
  **不覆盖网络**（`--allow-net` 在本机 v24 与生产 v22.23.2 上都是 `bad option`）。Linux 上用网络命名空间
  （`unshare -n`）真正断网，默认开启；Windows / macOS 没有等价能力，控制台与巡检会明确标注
  "网络未隔离"。在这些平台上，"插件读不到 config.json"成立，"插件不能外发"不成立 ——
  `docs/PLUGINS.md` 的信任声明与控制台都如实写明，不假装拦住了。
- **插件工具的 Token 开销取决于挂载方式**：默认 `plugins.toolMounting: "meta"`，每轮只常驻一个
  `plugin_call`（工具清单在调用时展开），装多少个插件都不增加固定底；改成 `"direct"` 后每个插件工具
  各占一条工具定义，装得多时上下文会明显变大。控制台能看到每个插件声明了多少工具，但不显示 token 影响。
- **插件工具名含双下划线**：`<插件id>__<工具名>` —— 用双下划线而不是点号，是因为 OpenAI 的 function name
  只允许 `[a-zA-Z0-9_-]`（点号会让严格校验的兼容端点整个请求 400）。若将来要换分隔符，属破坏性变更，
  需按 `apiVersion` 升版本处理。


## 历史问题（已全部修复）

### 成本口径复审记录的 6 项问题（2026-09-21 记录，同日全部修复）

v0.6.0..v0.6.4 之间复审成本口径时记录的 6 项“不影响主链路”的问题，随后已全部修复，
修复原因均写入 `src/pricing/`、`ui/app.js`、`docs/model-prices.md`：

1. 更换远程表地址且新地址拉取失败时，界面无法区分实际生效的地址 → `priceFeedStatus()` 增加
   `sourceStale`，设置页明确提示“当前生效的仍是上一次成功拉取的旧地址”。
2. 两次刷新重叠时没有并发保护 → `refreshPriceFeed` 采用单飞：同一组地址复用同一次请求，
   地址变化时排队，后到的旧结果不会覆盖新结果。
3. 别名 `from`/`until` 写成非法日期时被静默忽略 → 解析失败即整条别名不生效（fail-closed）。
4. 手工修改 `config.json` 删除渠道不撤销已注入的价目表 → `initChannelPrices` 按配置对齐注入，
   删除的渠道即时撤表，无需重启。
5. 全 0 的自定义价与 `costMultiplier: 0` 被当作未填写 → 0 是合法价格（免费），
   判据改为是否写入 `in`/`out` 字段。
6. 「当前模型单价」卡片与「全局兜底单价」共用一组输入框 → 拆分为「生效价」（只读展示）与
   「自填单价」（仅在保存确实生效时可编辑，停用时说明原因）。

另有 `friend_opportunities` 缺少保留策略，已连同 `friend_proposals`、`incoming_friend_requests`
一起补充 90 天清理（`IdentityStore.pruneLedgers`，启动时清理过期的**已了结**行，未决待办不删）。

本文档历史上还记录过 5 个随底座引入的基线失败用例（2026-09-19 已全部修复）：

- `configure-linux` 生成的 `config.json` 权限被防抖保存回退为 0664 → 修复：所有写盘路径
  统一 `mode: 0o600`（`src/core/config-legacy.js` 的 `scheduleConfigSave`）。
- 「禁用身份基建后不建库」：该用例验证的是旧契约。身份与事件基建已按
  `src/core/stable-feature-policy.js` 转为默认开启，用例改写为「转正后旧的 enabled:false 被忽略」。
- 「好友候选批准分发」：分发链路同样已转为默认开启，测试桩补充 `get_login_info` 与
  `sendFriendRequest` 桩件，断言改为「批准即发送」。
- 事件列表计数 `2 !== 1`：`app.start()` 无法连接 OneBot 时会自动捕获一条连接事件，
  属于正常基建行为；用例改为仅断言自身注入的那条（按 `source` 过滤）。
- 「已确认黑话」注入：黑话研究已下线（slangPilot retired），提示词不再注入任何黑话；
  用例改写为「即使旧配置开启、slang.json 存在也不注入」（防跨群泄露的原始目标保留）。

## 环境相关（不属于项目问题）

**Windows 团队**：历史上 `npm run test:unit` 在 Windows 上会固定红 43 条（docker/systemd/linux 集成类）。
2026-10 起改为：跨平台可修的断言直接修（PATH 分隔符、POSIX 权限位断言、句柄未释放时的清理重试），
真正依赖 POSIX/Linux 的用例用 `test/helpers/platform.mjs` 显式 skip 并写明原因。
`test/baseline-failures.json` 应为空；`npm run test:unit:win` 用 spec 报告与基线比对，
**任何未预期失败都会红**，CI 有独立 `windows` job 守住这个口径。Linux 与 CI（ubuntu-latest）
仍是全量通过的权威结论。

`test/usage-e2e.mjs` 已改用隔离端口（写进临时配置），机器上跑着机器人也不会 EADDRINUSE；
自 2026-10-09 起它与另外三个回归脚本都在更新器的部署前预检里（`scripts/test-suite.mjs` 的
regression 集），在部署机上执行 `npm test` 时也在其中。

## 主动好友候选功能已退役（2026-09-25）

**"主动加好友"整个功能已退役**（候选生成、审批、派发全部关闭），原因：

1. **协议路径被服务端统一拒绝**：`friendlist.addFriend` JCE 包能被解析并回包，
   但业务码恒为 1（"添加失败，请稍后再试"），与参数、目标、验证方式全部无关
   （陌生人 / 已好友 / 机器人自己 / 参数矩阵扫描均同一结果，详见 Issue #10）。
2. **上游明确不做**：GUI 实际走 NTQQ 内核 `NodeIKernelBuddyService::reqToAddFriends`；
   向 SnowLuma 请求暴露该能力的 issue（#480）被维护者关闭为 not_planned
   （"公开版不会加主动加好友功能，该功能过于敏感"）。开源生态亦无可参考实现。
3. **风控代价**：连续派发实验已实际触发 QQ 官方设备风控警告。该功能即使可用，
   自动化加好友本身也是风控敏感行为。
4. **滥用风险**：开箱即用的自动化批量加好友能力，极易被拿去做营销骚扰、
   灰产引流等滥用场景，不适合作为开源机器人仓库的内置功能。

### 退役方式

- `src/core/stable-feature-policy.js`：每次落盘强制
  `identityPilot.friendProposal.enabled=false`（毕业不变量反转为退役不变量，
  配置无法重新开启）；
- `src/core/config.js`：`friendProposalEnabled()` 硬编码 `return false`；
- 提案照常生成的前提已不存在，审批与派发入口全部被功能门拦截；
- 历史提案数据（friend_proposals 表）保留在身份库中备查；
- **入站好友请求处理（`incomingFriendRequest`）不受影响**：别人主动发送的
  好友申请仍可在 Web 控制台审批，批准后自动加入私聊白名单。

如需给机器人增加好友，请在 SnowLuma 的 noVNC 界面手动操作（GUI 路径正常）。

## 已知窄竞态：`data/auto-update.json` 是跨进程整文件读改写（2026-09-25 首记，2026-09-29 扩写）

原记录（`notification` 单槽）：`data/auto-update.json` 的 `notification` 只有一个槽位。Agent
发送通知的数秒窗口里，如果另一个写入方（updater 独立进程、或控制台手动更新的失败路径）恰好
写入了一条**新的**待发通知，发送完成时的收尾写会把整份旧快照盖回去——新通知被标成"已发"而
静默丢失。触发要求两次失败落进同一次发送窗口，概率很低。

扩写（2026-09-29 审查）：这不只是 `notification` 一个字段的问题——**整个
`auto-update.json` 都是"读—改—写"且没有跨进程互斥**。写入方有两个进程：
应用进程（`src/auto-update.js` 的 manager，处理控制台的暂停/恢复/立即更新；以及
`src/update-notice.js` 写通知与忽略版本）和 updater 独立进程（`scripts/auto-update.mjs`
在连通性/检查/部署各阶段写状态）。后写者用自己那份整文件快照覆盖，因此**并发时丢的是
"另一个进程刚改的字段"**（例如你点"暂停"的同时一个计划运行正在推进阶段），而不是把文件写坏
——写入本身是原子的（`writeObject` 走 tmp + rename + 0600，`readObject` 解析失败回落 `{}`）。

影响：控制台显示的阶段/状态、通知、忽略版本可能短暂回退或丢失，下一次写入即自愈；
不影响部署是否成功、也不影响代码与数据的完整性。彻底修法是给这个文件加一个跨进程锁
（mkdir 型的 `auto-update.json.lock`，两个进程共用）后再读改写；在此之前，若控制台状态
与 updater 日志对不上，以 **updater 日志**为准。

> **2026-10-01 补注（状态更新，结论不变）**：上段说的"两个进程共用一把锁"**仍未做**，
> 这个窄竞态照旧存在。同一批里修的是**另一把锁** —— updater 自己的运行互斥
> `data/.auto-update.lock`（防止两次更新同时跑）：原先它①只有 `pid > 0` 才检查属主活没活
> （空/坏锁会被立刻抢走）、②接管是 `unlink + open('wx')` 两步、不是原子对（并发时互相
> 删掉对方的锁）、③接管互斥文件没有陈旧兜底。现在：空/坏锁按 mtime 给 5 分钟宽限、
> 接管走 `.takeover` 互斥文件（互斥本身也带 5 分钟陈旧兜底）、拿到互斥后**再判一次**
> 才删锁，errno 非 ESRCH 一律按"进程还在"处理（busy 按 0 退出，不会连累 `disableOnFailure`）。
> 即：**"两个进程同时读改写同一个 json"未修，"两个 updater 同时部署"已加固**。

## 2026-10-13 全项目审查：未修的几条（需产品口径 / 上游前提）

- **反向代理部署下，`POST /api/config` 的 `server` 整节替换会把令牌清成空**（守卫只看"绑定是否回环"）。
  需两个条件同时成立：持令牌者主动整节替换 + 反代不注入 `x-forwarded-for/x-real-ip/forwarded`；属"管理员
  自伤"而非越权提升。最小改法：把守卫从"绑定非回环"改成"当前存在令牌就一律 409"。
- **`get_group_profile` 的 honors 没有显式体积上限**：同一函数里 files/albums/notices/messages 都有截断。
  上游 `get_group_honor_info` 各 list 通常自带上限，故未实测到爆量；换适配器时建议按字段截断。
- **群游戏在观察/暂停、非活跃时段仍推进状态机**（`#tickOnce` 只看 `cfg.enabled`）：播报被 `assertCanSend`
  挡下只记日志，恢复时局已悄悄结束，中间播报（天亮了/投票结果）永久丢失。修法是加 `canRun(chatKey)` 闸门；
  **若产品口径是"暂停也继续推"，请把该行为写进文档**并让丢掉的播报可见，在此之前维持现状。
- **`ops scan --strict` 的覆盖边界**：只覆盖"同行裸标识符调用"，`this.store.missingMethod()` 这类属性调用
  不扫，且行首的裸调用会被误当成"定义"（见 `docs/OPS.md`）。
- **好友管理页缺页内序号守卫**（`loadFriendFeaturePageImpl`）：该页无筛选/搜索状态，乱序到达通常覆盖成同
  内容，可观测影响极小。
- **部署脚本收尾段的 `"$USER"`**：`set -u` 下若环境未注入 `USER`，会在**部署成功之后**报 unbound variable
  并被更新器记成失败；标准路径（systemd 用户服务）应已注入，未构造出复现。建议统一改成 `"$(id -un)"`。
- **合并转发里的「聊天记录卡片」读不到**（2026-10-14 实测）：卡片是 `json` 段，SnowLuma 给它的
  负载里**没有资源 id**（`resid` 之类），而 `get_forward_msg({ message_id })` 对这类记录返回空 —— 所以
  只能看到卡片自带的标题摘要。代码已能识别 resid（上游一旦提供就自动展开），入站也留了一行诊断日志；
  在协议端支持之前，被问到时应当照实说"卡片内容看不到"（提示词已写明这一点）。
