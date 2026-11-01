# 插件（第三方扩展）

> **状态：插件 v1 已完整落地，作者工具与索引上架链路已就绪。** 可用部分：插件目录约定、manifest
> 校验、独立进程宿主（隔离 / 心跳 / 超时 / 崩溃重启）、能力鉴权与宿主侧实现、注册表与默认拒门控、
> 插件工具挂进模型工具表、入站消息投递、周期任务驱动、巡检项、控制台左侧「插件」页
> （列表 / 一键安装 / 启停 / 重载 / 卸载 / 隔离说明 / 来源记录）、官方索引（条目以独立仓库为准）、
> 作者三件套（`plugin-create` / `plugin-dev` / `plugin-pack`）与索引体检脚本。
>
> 技能包不是插件：技能只有只读 Markdown + 工具白名单，不执行代码。见 [SKILLS.md](SKILLS.md)。

## 怎么装（控制台，不用碰命令行）

左侧「插件」（2026-10-16 之前挂在「设置 → 插件」下）：

1. 打开「启用插件功能」；
2. 在索引列表里点某个插件的「安装」（默认来源是官方索引仓库，条目以仓库当前内容为准；
   上面的搜索框与标签能筛，索引里有更新版本时那一行会出现「升级到 vX」）；
3. 装完在「已装」里点「启用」—— **装上 ≠ 授权**，不点启用它不会跑，也不会给模型任何工具。

索引里没有、或者你手上直接有个包（别人发你的、自己刚打的），用**「手动安装」**那一栏：
填一个公开地址 + sha256，或者**直接选一个 `.tar.gz` 文件**（也可以拖进去）。
装完界面会把算出来的内容指纹（sha256）打给你核对，并问你要不要现在就启用。
不想开控制台的话，命令行等价：`node src/ops.js plugins install <文件.tar.gz>` 装，
`node src/ops.js plugins list` 看已装的与已授权的。

索引是一份 JSON，**住在独立仓库里**：`https://github.com/sakurawwwxh/qq-agent-plugins`
（控制台默认的 `plugins.indexUrl` 就指向它；包挂那个仓库的 Release，仓库内也提交一份供 CDN 走）。可加多条见下：

```json
{
  "plugins": [
    {
      "id": "weather",
      "name": "Minecraft 服务器状态",
      "version": "1.0.0",
      "description": "查一台 MC 服务器的在线玩家",
      "capabilities": ["tools", "http"],
      "apiVersion": 1,
      "minVersion": "0.8.5",
      "downloadUrl": "https://…/weather-1.0.0.tar.gz",
      "sha256": "…64 位十六进制…"
    }
  ]
}
```

条目字段：

- **宿主读索引时必需**：`id`、下载地址（`downloadUrl` / `tarball` / `url` 三个名字任选其一，
  按这个顺序取第一个非空值 —— `plugin-pack` 生成的是 `downloadUrl`，本仓最早的索引形状是 `tarball`，
  两种都认）、`sha256`（没有内容锚点就不许装）。缺任一项的条目会被跳过，**并在页面上列出跳过的条目与原因**
  （悄悄少一条最难排查）。
- **索引体检额外要求**（`scripts/verify-index.mjs`，上架与 CI 的硬闸门）：`version` 必须是 `x.y.z`、
  `capabilities` 必须是非空数组（安装界面要原样展示，使用者据此判断要不要信）。宿主侧对这两项更宽松：
  `version` 形状不对只会让"升级到 vX"提示失效，`capabilities` 缺了就是没有权限。两边要求不同是故意的 ——
  上架从严，已有条目不至于因为规范化更严而整条消失。
- **可选**：`name` / `description` / `author` / `homepage` / `tags` / `apiVersion` / `minVersion`。
  后两个是兼容门控：对不上的条目**照样列出来**，只是标成「本机装不了」并说明原因
  （`apiVersion` 不匹配、或 `minVersion` 比本机版本高）。
- **市场呈现**（都可选，缺了界面优雅降级）：`icon`、`screenshots[]`、`readme`（详情页正文）、
  `readmeUrl`、`changelogUrl`、`category`、`size`。`updatedAt` 由发布脚本写；
  `downloads` 由索引仓库的 `stats.yml` **每天从 Release 资产的下载计数写回**（上架当天可能还是空的，
  这时市场页按名字兜底排序）。
- **地址类字段一律只收 `http(s)`**：`homepage` / `readmeUrl` / `changelogUrl` / `icon` / `screenshots[]` /
  `mirrors[]`。它们在控制台里会变成可点的 `<a href>` 或 `<img src>`，而索引可以是第三方的
  （`plugins.indexUrls` 支持追加）—— 宿主侧归一化、索引仓库体检、界面渲染三层都只认 `http(s)`，
  形状不对就置空（界面优雅降级，不做出链接）。`esc()` 只挡标签、**不挡 scheme**，这道门不能省。
- **撤回与弃用**：`revoked: true` + `revokedReason`、`deprecated: true` + `deprecatedReason`。
  被撤回的条目照样列出来但**标成装不了**，宿主读到就拒载 —— 这是集中下架：索引改一次，
  所有装了它的机器下次读到索引就生效，不用等每台机器自己改配置。
  **撤回是版本粒度的**（一条条目就是一个版本）：只撤这一版；整插件下架 = 把它的每条条目都标上
  `revoked`。这样作者修好之后发的新版本能正常被装上，而老版本继续被挡（与 `plugins.revoked` 的
  `"id"` 撤全部 / `"id@1.2.3"` 只撤一版是同一套语义）。因为索引一个 id 只能有一条，
  `plugin-publish --clear-revoked` 会把被撤的旧版本号写进 `revokedVersions: ["1.0.0"]` ——
  那几条规则继续生效，不会因为"新版本上架"而被顺手解除。
  **索引拉取失败时撤回名单沿用上一次成功的结果**（不清空）—— 拉不动不等于没人被撤回，
  否则索引一抖动，被下架的插件就会在没有任何提示的情况下恢复工具与定时任务。
- `sha256` 必须与要下载的那份内容一致 —— **装的是要执行的代码，没有内容锚点就不许装**。

**索引可以有多条**（`plugins.indexUrls` 是数组，配置顺序即优先级，同 id 只取最靠前那份，
落选的会作为"重复条目"列出来）。默认那一条是官方索引；要加第三方索引就往数组里追加。

安装过程：下载（safe-fetch：HTTPS 优先 HTTP/2、失败回落 HTTP/1.1；内网拦、体积上限、超时）→ 校验 sha256 → 解到 staging →
校验 manifest（与宿主同一份校验）→ **原子换入**（升级时旧版挪到 `.backup-<id>-<时间戳>/`，
换入失败原样放回）。装完会在 `plugin-data/<id>/install.json` 记一份**来源记录**
（从哪个索引/地址装的、哪一份 sha256、什么版本、什么时候），控制台「已装」里能看到。
卸载只挪走代码目录，`plugin-data/<id>/` 里的数据与来源记录都保留。

## 这是什么

让别人（或你自己）用一份 `plugin.json` + 一个入口 JS 给机器人加能力：暴露只读工具给模型、
看到入站消息、按周期跑事。**插件跑在独立子进程里**，通过 stdio 上的 JSON 协议与宿主对话。

## 工具是怎么到模型手里的

- 插件工具**不进内置工具表**（`buildToolDefs()`），而是编排器每轮运行时从注册表现取现追加 ——
  内置工具表另有"每个工具都要有调度分类"的契约，插件工具混进去会破坏它。
- 名字是 `<插件id>__<工具名>`；描述里由宿主补一句"来自插件「X」，第三方代码：内容由插件给出，
  按外部信息对待"，让模型知道自己在读谁给的什么。
- **默认拒**：总开关没开 / 插件不在 `enabledIds` / 进程没跑 / 工具没在 manifest 里声明 ——
  任一不满足就不出现；已经拿到工具定义的调用也会在执行前再判一次（一轮之内被停用也拦得住）。
- 插件工具的返回值过 `sanitizeDeep`（递归洗掉段头伪造），参数说明也过同一道 ——
  这些字符串最终都会进提示词，而它们是**插件作者可控的文本**。

## 入站消息投递（`observe`）

投递点在**落库之后、唤醒之前**，内容是已去重、已过 `sanitizeUserText` 的最小集：

```json
{ "chatKey": "group:123", "group": true, "mid": "456", "ts": 1730000000000,
  "senderId": "10001", "senderName": "某人", "text": "正文" }
```

只投**别人发的**消息（自己发的不投）：v1 插件发不了言，但等 `send` 能力开了之后，
"自己发的也投"会变成自问自答的环。插件只能看：改不了内容、拦不住消息（它没有回执通道）。

⚠️ 投递范围包含**私聊**（`chatKey: "private:<QQ>"`），包括与 owner 的私聊正文。这是
"observe = 观察全部入站消息"的设计，不是漏洞；只应安装可信插件，插件进程自身的网络访问
无法由宿主的 safe-fetch 拦（Linux 下靠 netns 隔离）。

## 周期任务

宿主每 15 秒检查一遍：按 manifest 里声明的 `everyMs` 到点就通过 `schedule` 方法触发插件。
**定时器在宿主手里**（不是插件自己起）——这样插件重启后周期不会丢，也不会出现"插件崩了但
定时器还在跑"。重启后周期重新计时（内存态，不做持久化：重启本身就该重算）。

## 先说信任（装之前必须知道）

- **插件是第三方代码。** 装上一个插件 = 让它的作者在你的服务器上跑代码。请只装你看得懂或
  愿意信任的插件。
- **凭据读不到。** 插件进程被 Node 的权限模型关在只读自己目录的沙箱里：实测
  `data/config.json`（里面有 API Key、控制台 Token、OneBot Token）读出来是 `ERR_ACCESS_DENIED`；
  起子进程、开 worker、写文件同样被拒；宿主还会剥掉环境变量（否则 `QQ_AGENT_DATA_DIR` 之类
  会漏过去）。
- **网络：Linux 上默认是断的，其他平台断不了，页面会告诉你当前是哪种。** Node 的权限模型覆盖
  fs / 子进程 / worker / addons，**不覆盖网络**（`--allow-net` 这个 flag 在 Node 22/24 上都不存在）。
  于是在 Linux 上宿主把插件进程放进一个**没有网络接口的命名空间**（`unshare --user --map-root-user
  --net`，实测 connect 与 fetch 都是 `ENETUNREACH`），要联网只能走宿主的 `cap.http.request`
  —— 那条路有内网拦截、体积上限、超时与审计。Windows / macOS 没有这套东西，插件进程的网络拦不住：
  控制台与巡检会**明说**"网络未隔离"，这时要更严就用 `plugins.requireNetworkIsolation: true`
  （本机做不到就拒绝加载插件）。
- **模型的工具描述会被插件作者影响。** manifest 里的名字与描述会进系统提示词（宿主会做段头
  弱化与递归清洗，但字面内容仍由作者决定），插件工具返回的内容一律按"外部信息"对待。

## 目录与 manifest

插件放 **`$DATA_DIR/plugins/<id>/`**（`QQ_AGENT_DATA_DIR`，默认 `<应用目录>/data`）。
放这里是因为版本更新只用 rsync 铺源码树、数据目录在保留清单里 —— 插件不会被升级抹掉。

```
$DATA_DIR/plugins/weather/
├── plugin.json       # manifest（必需）
└── index.mjs         # 入口（默认 index.mjs，可用 entry 指定）
```

```json
{
  "id": "weather",
  "apiVersion": 1,
  "name": "Minecraft 服务器状态",
  "version": "1.0.0",
  "description": "查一台 MC 服务器的在线玩家",
  "capabilities": ["tools", "http"],
  "tools": [
    {
      "name": "players",
      "description": "查指定服务器的在线玩家列表",
      "parameters": { "type": "object", "properties": { "host": { "type": "string" } }, "required": ["host"] }
    }
  ],
  "schedule": []
}
```

校验是 **fail-closed** 的：`id` 必须与目录名一致、`apiVersion` 必须是本机支持的版本（1 或 2）、`capabilities`
只认白名单、`entry` 必须落在插件目录内（防目录穿越）、`tools[].name` 只许小写字母数字下划线、
`everyMs` 有上下限（1 分钟 ~ 7 天）。任一项不合法 → 拒载并在日志/控制台给出原因，不会静默跳过。

## 协议（apiVersion 1）

一行一个 JSON（NDJSON），宿主与插件共用同一条 stdin/stdout。

**宿主 → 插件**

| 方法 | 说明 |
| --- | --- |
| `init` | 握手：带 `apiVersion`、插件 id、能力清单、该插件自己的配置段 |
| `callTool` | 执行工具：`{ name, args }` |
| `observe` | 一条入站消息（通知，不等回执；只能看，不能改、不能拦） |
| `schedule` | 到点了，执行 manifest 里声明的周期任务 |
| `ping` | 心跳 |
| `shutdown` | 请它自己退出（宽限期内没动静就 kill） |

**插件 → 宿主（能力调用，`cap.` 前缀，按 manifest 声明逐条鉴权）**

| 方法 | 需要声明的能力 |
| --- | --- |
| `cap.log.write` | `log` |
| `cap.storage.get` / `cap.storage.set` | `storage` |
| `cap.config.get` | `config` |
| `cap.http.request` | `http` |
| `cap.send.text` | `send` |
| `cap.secrets.get` / `cap.secrets.set` | `secrets`（只能读写 manifest 里声明为 `secret` 的字段） |
| `cap.approval.check` | `approval`（动作必须写在 manifest.approvals 里） |
| `cap.quota.consume` | `quota`（动作必须写在 manifest.quotas 里） |
| `cap.media.download` / `cap.media.probe` / `cap.media.merge` | `media` |
| `cap.media.frames` / `cap.media.describe` / `cap.asr.transcribe` | `media` |
| `cap.feed.publish` | `feed`（只能提交见闻候选，不能调模型、不能发消息） |
| `cap.send.file` | `send`（目前只支持群聊） |

### 见闻候选（`feed`，v2.1）

插件声明 `feed` 后可以调 `cap.feed.publish`，把条目提交给生活层候选队列：

```js
await callHost('cap.feed.publish', { items: [
  { id: 'douyin-123', title: '标题', url: 'https://…', up: '作者',
    durationSec: 90, tags: ['游戏'], summary: '一句摘要',
    cover: 'https://…/cover.jpg' }   // 可选：只收 https
] });
```

宿主会校验链接/标题/封面、按 id 去重、每插件每天最多收 20 条。插件**不能**调模型、不能直接发消息；
候选会立即进入生活层 inbox，并在模型取候选或控制台刷新时吸收，由正常的主动发言链路决定是否分享。
抖音/小红书等第三方数据源插件可以借此接入同一套"见闻"，而不需要拿到发送权或模型权限。

## apiVersion 2：设置面板、凭据、授权、配额与媒体

v2 没有改协议方法名，只**加能力**与 manifest 字段。声明 `apiVersion: 2` 才能用下面这些；
v1 插件原样可用，加载时 `apiVersion` 字段在 1 与 2 之间都算兼容。

### 设置 schema（宿主统一渲染，作者不写 HTML）

```json
"settings": {
  "groups": [{
    "key": "account",
    "title": "账号",
    "description": "可选",
    "fields": [
      { "key": "sessdata", "label": "SESSDATA", "type": "secret", "help": "浏览器 Cookie" },
      { "key": "quality", "label": "清晰度", "type": "select", "default": "32",
        "options": [{ "value": "32", "label": "480P" }, { "value": "64", "label": "720P" }] },
      { "key": "sendVideo", "label": "允许发视频", "type": "boolean", "default": false },
      { "key": "maxFileMb", "label": "文件上限", "type": "number", "default": 60, "min": 5, "max": 80 }
    ]
  }]
}
```

支持 `text` / `number` / `boolean` / `select` / `secret`。上限：8 组、32 个字段。
普通字段写进 `plugins.settings.<id>`（插件用 `cap.config.get` 读）；`secret` 字段用宿主密钥
（AES-256-GCM）加密落在 `data/plugin-secrets/<id>.json`，控制台只显示"已配置/未配置"，
永远不会把明文回给页面。密钥文件在 `data/plugin-secrets/.key`（0600），**丢了已存凭据就解不开**，
所以控制台与备份都要带上它。

### 高风险动作：approval + quota

```json
"approvals": [{ "action": "interact", "label": "点赞/投币", "defaultUses": 1 }],
"quotas": { "interact": 30 }
```

- 管理员在插件详情里点"批准一次 / 批准 10 次"，生成一张有时限（默认 10 分钟，最少 1 分钟）与次数的通行证；
- 插件每次写操作前调 `cap.approval.check { action, consume: true }`，没批准/过期/次数用完都返回 `approved:false`；
- 配额由宿主按"插件 + 动作 + 当天"计数，跨天归零；没在 `quotas` 里声明的动作调用 `cap.quota.consume` 直接报错；
- `approvals` 必须同时声明 `approval` 能力，`quotas` 必须声明 `quota` 能力，`secret` 字段必须声明 `secrets` 能力。

### HTTP 与媒体边界

- `httpDomains`（v2）：声明后，`cap.http.request` 与 `cap.media.download` 只允许这些主机及其子域；
  v1 不加白名单时沿用"公网但禁内网"的默认守卫。
- HTTPS **GET / 媒体下载优先走 HTTP/2**（ALPN），服务端不支持或连接层失败时自动回落 HTTP/1.1；
  两条路都保留 DNS 固定、内网拦截、逐跳重定向校验、凭据剥离、体积上限与超时。Cloudflare 对
  HTTP/1.1 按版本/指纹挑战的站点（e926/e621 等）因此可以正常访问。POST 为了不重复写入仍只走
  HTTP/1.1，不自动重试。
- `cap.http.request` 的 v2 参数：`method` 只允许 GET / POST；POST 可带 `headers` 与 `body`（≤64KB）。
  **非 GET 请求不跟随重定向**；GET 带 Cookie/Authorization 时同源重定向保留、跨源（含换端口或
  https→http）自动剥掉凭据 —— 否则一次 302 就能把登录态交给白名单里的另一台主机。
- `cap.send.text` 单条上限 1500 字符，**超限报错、不静默截断**（半块字符二维码约 1000–1400 字符）。
- `cap.media.download` 只写插件自己的 `plugin-data/<id>/media/`，单文件上限 80MB；下载、合流与抽帧
  共用同一个目录，只保留最近 12 个文件（防止换 prefix 反复抽帧把磁盘写满）；
  `cap.media.merge` 由宿主调用 ffmpeg（固定参数、不经 shell）；`cap.send.file` 只能发这个目录里的文件，
  且只支持群聊。图片（按 PNG/JPEG/GIF/WebP 魔数识别，文件名可以没有扩展名）会改成 image 消息段发送；
  WS 连接时 8MB 以内、仅 HTTP 时 1MB 以内直接内联 base64，协议端在容器/另一台机器时也能收到；更大的图仍用宿主路径。
  图片不会进入群文件列表。插件自己跑不了命令，也拿不到别的目录。

### 写操作信任模型（v2.1）

写操作（点赞/评论/发弹幕这类会改变外部账号数据的动作）在宿主侧过**三层门**，插件绕不过：

1. **动作开关（默认关）**：manifest 工具声明 `"action": "interact"`（对应 approvals 清单里的动作），
   控制台打开 `plugins.switches.<插件>.<动作>` 才注册这个工具 —— 关着时模型根本看不见；
2. **对象级批准**：调用时宿主按 `actionTarget`（参数名，可数组）取目标，生成**绑定该目标**的待批请求
   （`actionPreview` 指向的参数会进批准预览，并对**完整正文**绑定摘要——列表只展示前 160/200 字并标注总字数，超出展示长度的部分同样受批准约束；评论/弹幕换了正文必须重新批准）。
   目标必须合法且唯一：声明了 `actionTarget` 却没给、给了非法字符、或一次给了多个不同目标都会被拒，
   不会退化成"任意目标都能用"的通行证。管理员在控制台待批列表，或私聊回「待批」查看全部、
   「同意 [编号] [次数]」/「拒绝 [编号]」处理；通知里带待批编号、今日剩余配额与有效期。
   私聊通知优先走发送队列，被白名单等守卫拒绝时宿主会改用 OneBot HTTP 补发；两条都失败会在
   控制台待批卡片上标「通知未送达」，不会让管理员误以为 QQ 里已经收到。
   一次批准默认 10 分钟内单次有效（「同意 编号 5」可一次批 5 次）；同插件两次写至少间隔 60 秒；
3. **当天配额**（manifest.quotas）＋**失败退还**：插件明确返回 `ok:false`、幂等跳过或执行前抛错时，
   已扣的批准与配额自动退回；**超时/插件进程退出/插件显式标记 `E_WRITE_UNKNOWN`（写请求 5xx、超时、非 JSON）时不退**，记 `unknown` 并让模型不要重试
   （请求可能已经到达对方，重试就是重复评论/弹幕）。

插件契约：写工具执行前先查当前状态（已做过就跳过返回 `skipped`），执行后**回读核验**并把 `verified` 带回；
宿主把每次写操作记进审计（控制台插件详情「最近写操作」）。插件不需要（也不应该）再调 cap.approval.check。

其它 v2.1：manifest `engines.minVersion`（安装与**每次加载**都校验）、工具级 `timeoutMs`（1s-300s）、
`httpMaxBytes`（响应上限 40KB-512KB）、可选 `probe` 协议方法（控制台「检测登录」按钮）。

### 官方例子

`examples/plugins/bilibili` 是完整的 v2 例子：读接口、DASH 下载合流、写操作（授权 + 配额）。
它的用法与限制见 [BILIBILI.md](BILIBILI.md)。

形状最小到能照抄：

```js
// index.mjs —— 一个什么都不做的插件长这样
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (line) {
      const m = JSON.parse(line);
      if (m.method === 'init') send({ id: m.id, result: { ok: true } });
      else if (m.method === 'ping') send({ id: m.id, result: {} });
      else if (m.method === 'shutdown') process.exit(0);
      else if (m.method === 'callTool') send({ id: m.id, result: { echo: m.params.args } });
      else if (m.method === 'schedule') send({ id: m.id, result: {} });
    }
    i = buffer.indexOf('\n');
  }
});
```

## 写一个插件（作者向）

**先看活例子**：`examples/plugins/` 下有八个官方插件 —— `weather`（天气，走不需要 Key 的
Open-Meteo；也是 issue #37 那个原始诉求）、`gh-activity`（GitHub 仓库动态）、`translate`（翻译）、
`exchange-rate`（汇率）、`hot-topics`（热榜）、`rss`（订阅源）、`ip-info`（IP 归属地）、
`bilibili`（B 站：读/观看/互动，apiVersion 2 的完整例子）。
七个都能在控制台一键装，都是**零依赖、不 import 宿主内部模块、不自己发请求**的写法，
一个文件一百多行，照着改最快；每个的 README 里有"拷目录 / 打包分发"两条路。

**三条命令**（在宿主仓库里跑，不用装任何工具；生成 / 调试 / 打包各一条）：

```bash
# ① 生成骨架（plugin.json + index.mjs + README.md）
node scripts/plugin-create.mjs my-plugin --name "我的插件" --author 你的名字
#    要 settings / http / storage / 写动作（approval + quota）的完整 v2 骨架：
node scripts/plugin-create.mjs my-plugin --api-version 2

# ①' 校验清单（宿主自己的 validator，唯一真源）
node scripts/plugin-validate.mjs ./my-plugin

# ② 本地跑起来：真协议 + 真隔离 + 假 QQ。不带参数进交互模式（t 调工具 / o 投消息 / s 触发周期 / l 看日志）
node scripts/plugin-dev.mjs ./my-plugin --call hello --args '{"text":"你好"}'

# ③ 打包 + **自测**（拿宿主自己的安装器在临时目录里真装一遍）+ 生成索引条目
node scripts/plugin-pack.mjs ./my-plugin --base-url https://github.com/你/my-plugin --tag v0.1.0 --min-version 0.8.5
```

第 ③ 条默认把包落在插件目录的旁边（`--out` 可改），并打印一段可直接粘进索引的 JSON；加
`--index <索引仓库工作副本>/plugins/index.json --write` 就直接写进去（按 id 合并，不会覆盖条目里原有的
撤回/签名/分类等字段；自测不过不会写）。**自测不过就别往索引里提**
—— "包能不能装"不靠嘴说。

两个和"本地能跑、线上装不上"有关的性质是故意的：

- **打包可复现**：同一份源码打两次，包逐字节相同，**换操作系统也一样**（实测 Windows 与 Linux
  打出的 `sha256` 一致）—— 你在本地算的 `sha256` 就是 CI 与使用者那边认的那个。为此插件目录里
  的文件按**码位**排序、`mtime` 归零、gzip 头不写平台信息；这些都是"看起来无所谓、实际会让校验
  和两边对不上"的地方。
- **`plugin-dev` 用的就是宿主那一套**：同一个 manifest 校验、同一组子进程隔离参数、同一份能力实现。
  所以在这里看到的网络拦截、越权被拒、超时，与线上是同一条路。
- 开发期有两个**只在这个假宿主里生效**的开关：
  `--approve-all` 让 `cap.approval.check` 直接放行（不用先去控制台点批准）；
  `--http-mock '<JSON 或文件>'` 把匹配 URL 的 `cap.http.request` 直接返回固定响应，
  支持 `{ "api.example.com": { "status": 200, "body": "..." } }` 或
  `[{ "match": "/v1/play", "method": "POST", "status": 200, "body": "..." }]`。
  未命中的 URL 仍走真实网络；生产宿主没有这两个注入点。

骨架就是"读 stdin 的一行行 JSON、按方法名回一行行 JSON"（完整形状见上面的协议表）。
`plugin-create` 生成的就是下面这段的完整版（还带能力调用与工具表）：

```js
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (line) {
      const m = JSON.parse(line);
      if (m.method === 'init') send({ id: m.id, result: { ok: true } });
      else if (m.method === 'ping') send({ id: m.id, result: {} });
      else if (m.method === 'shutdown') process.exit(0);
      else if (m.method === 'schedule') send({ id: m.id, result: {} });
      else if (m.method === 'callTool') send({ id: m.id, result: { echo: m.params.args } });
    }
    i = buffer.indexOf('\n');
  }
});
```

几条容易踩的：

- **能力要声明才能用**：调 `cap.storage.set` 之前 `capabilities` 里得有 `storage`，否则宿主拒掉
  并记一次越权（控制台看得到次数）。`cap.*` 的入参出参见上面的协议表。
- **网络走 `cap.http.request`**：宿主那条路有内网拦截、体积上限、超时与审计。
  （这是"更规矩的那条路"，不是安全边界 —— 插件进程自己能联网，见信任声明。）
- **状态走 `cap.storage`**：主机落在 `plugin-data/<id>/`，卸载不删、重装还在。
  插件进程只有读权限，自己写文件会 `ERR_ACCESS_DENIED`。
- **定时器交给宿主**：manifest 里声明 `schedule`（`everyMs` 下限 1 分钟），宿主到点调你的
  `schedule` 方法 —— 自己起 setInterval 的话，插件崩了定时器还在跑，而且重启就丢。
- **处理不了就如实报错**：工具结果里带 `error` 字段（或回 `{error:{code,message}}`），
  别静默返回空 —— 模型和用户都靠它判断，空结果会被当成"查到了但没有"。

**打包与分发**：用 `node scripts/plugin-pack.mjs ./my-plugin …`（见上面的 ③）。它会拒绝三类包，
拒的原因都是"装在使用者机器上会出问题"，不是洁癖：

- **TypeScript 源码**：宿主不装构建工具，`index.ts` 到使用者那儿跑不起来 —— 先编译成 JS 再打。
- **声明了第三方依赖**（`package.json` 的 `dependencies` / `peerDependencies`）：v1 只收零依赖插件，
  安装时不会在用户机器上跑 npm —— 把要用的那几个函数内联进来，或等 v2 的依赖树方案。
- **超过 5MB**：安装器的下载上限。

要手工打也行，但**必须是 ustar**（pax 长路径头会被安装器拒），且包里的目录要以插件 id 为根：

```bash
tar --format=ustar -czf <id>-<version>.tar.gz -C <插件父目录> <id>
sha256sum <id>-<version>.tar.gz
```

然后把生成的条目（`{ id, name, version, description, apiVersion, minVersion, capabilities,
downloadUrl, sha256, tags }`）加进一份索引 JSON（形状见"怎么装"），或直接把 `{ url, sha256 }`
给使用者走 `POST /api/plugins/install`。
**装你的插件 = 让你的代码跑在他的服务器上**：把 `capabilities` 写准 —— 安装界面会原样展示，
这也是使用者判断"要不要信你"的主要依据。

### 上架到官方索引

官方索引在独立仓库 **`sakurawwwxh/qq-agent-plugins`**（免得插件目录跟宿主源码绑在一起）：

1. 打包：`node scripts/plugin-pack.mjs examples/plugins/<你的插件>`
   —— **自测必须先过**（用宿主自己的安装器真装一遍）；
   想先在自己机器上装一遍看效果：`node src/ops.js plugins install <包>.tar.gz`；
2. 把包提交进索引仓库的 `plugins/packages/`（**不用新建 Release**：该仓库的 CI 会把缺的包同步到
   固定的滚动 Release `packages` 上）。提交后确认 `git status` 里**同时**有 `plugins/index.json`
   和 `plugins/packages/<id>-<version>.tar.gz` —— 只提交索引会让索引仓库的 `verify index` 立刻红
   （`仓库里没有 …tar.gz`），而本仓库的锚点用例只看“源码 vs 锚点”，看不见索引仓库缺了包
   （2026-10-24 实际发生）；
3. 在索引仓库的 `plugins/index.json` 加一条（`downloadUrl` 指向
   `…/releases/download/packages/<文件名>`；`sha256` 用第 1 步打印的值），
   跑 `node scripts/verify-index.mjs --no-remote`（结构 + 仓库内产物 + sha256；新包还没上 Release，
   远端核对由合并后的 CI 做）；
4. 回到**本仓库**把 `plugins/official-packages.json` 里那个插件的期望值同步过去
   —— 它是两边的"对齐锚"：本仓库的用例拿"现打源码的 sha256"跟它比，
   **改了源码忘了重打包会立刻变红**（这条护栏在索引搬走之后换了个形式留在了本仓库）；
5. 两个仓库各提一个 PR。

**收尾其实只有一条命令**：`node scripts/plugin-publish.mjs examples/plugins/<你的插件> --index-repo <索引仓库工作副本>` ——
打包 + 自测（不过就不许上架）→ 把包放进索引仓库 → 更新索引条目（**合并而不是覆盖**，保住原有的
`publisher` / `signature` / `mirrors` / `downloads`，也绝不清掉 `revoked`）→ 跑离线自检 →
打印要执行的 git 命令。加 `--push` 才会真的传资产、提交、推索引。

三条刻意的设计，都是被实际问题逼出来的：

- **所有包共用一个滚动 Release（tag 固定 `packages`）**：加插件、升版本都不再发 Release。
  资产只增不删（旧条目还指着旧版本），同版本号不换内容——换内容请升版本，否则同名覆盖会把
  下载计数清零、索引里的 sha256 也会对不上。
- **`--push` 先传资产，最后才推索引**：索引里的地址一旦公开就被"一键安装"用上了，反过来（先推索引、
  资产传失败）所有使用者都会 404，只能再推一次修复；先传资产则失败时远端什么都没变（本地提交还在，
  重跑即可）。推送前的自检（含真下载核对）是**硬闸门**，不过就不推。
- **要改已经下架条目的状态必须显式给 `--clear-revoked`**：撤回是维护动作，不能被一次例行发布
  悄悄清掉（那等于下架的插件又变成可安装）。
- 提交用**显式文件清单**（`plugins/index.json` + 这一个包），不用 `git add -A`：一次中断过的准备、
  编辑器临时文件都不该混进同一次提交。

索引仓库的 CI 跑同一个体检脚本；**每天还会自动做一次真下载核对** —— 谁删了 Release、换了文件、
或者镜像挂了，当天就暴露，不用等使用者装的时候才发现。

体检脚本对任意一份索引都能跑：`node scripts/plugin-index-check.mjs <索引文件>`
（字段形状、重复 id、兼容门控；`--verify-remote` 额外把每条地址真下载下来核对）。

体检脚本还可以额外做两件事：`--verify-remote` 把每条 `downloadUrl` 真下载下来核对 sha256（要联网，
CI 里可选），`--json` 给机器读。

## 兼容与版本政策

插件与宿主之间只有一份契约：`apiVersion`。政策写死如下，避免"升个级插件全废"这类生态事故：

- **`apiVersion` 只增不改**：同一版本号内的协议方法、能力名字与语义不改（改语义等于换版本）。
  本机当前支持 1 与 2；v1 插件不需要任何改动。
- **破坏性变更必须升 `apiVersion`**，并且宿主在**加载时**就拒绝不认识的版本（不是跑起来才崩）。
  本机支持的版本见 `docs/PLUGINS.md` 与本仓 `src/plugins/manifest.js` 的 `PLUGIN_API_VERSION`。
- **能力只增不删**：新能力加名字（宿主按声明注入）；废弃的能力先标记、跨至少两个 minor 版本再移除，
  期间老插件照跑。
- **插件声明它能跑的最低宿主版本**：索引条目里的 `minVersion`。宿主版本低于它时，条目在控制台里
  标成「本机装不了」并说明原因（看得见但装不了，比看不见好排查）。
- **宿主不因插件而改契约**：插件看到的只有协议与能力，看不到宿主的内部模块（这条是 v1 的架构决定：
  独立进程 + 版本化协议，就是为了让宿主能持续重构而不弄坏插件）。
- **`plugin-data/<id>/` 与来源记录不随升级/卸载删除**：数据是作者的，也是使用者的。

## 宿主侧纪律（写插件时可以直接依赖的事实）

- 工具名给模型时是 **`<插件id>__<工具名>`**，撞不了名。
- 工具**默认拒**：总开关 `plugins.enabled` 没开、插件不在 `plugins.enabledIds` 里、被列进撤回名单、
  或工具没在 manifest 里声明 —— 任一不满足，它的工具与消息投递都不生效；"加载成功"不等于"被授权"。
  **进程没跑不在此列**：懒启动的插件（只有工具、不 observe/schedule）默认进程是待命状态，
  工具照样给模型，第一次调用宿主才起进程（见下面的"资源上限与懒启动"）。
- 未声明的能力调用会被拒绝并在日志里留痕（`越权调用 …`），控制台能看到次数。
- 调用有超时（默认 20 秒）；进程崩溃会自动重启，**连续崩溃到第 4 次时停用**（中间自动重启 3 次；
  每次都算"连续"，稳跑过 5 分钟后再崩重新计数）；心跳连续两次无应答就重启进程。
- 插件的状态走 `cap.storage`（宿主落盘到 `$DATA_DIR/plugin-data/<id>/`，单个值 32KB、
  总量 256KB、每分钟最多写 120 次），进程重启不丢；**卸载插件不会顺手删掉这些数据**。
- 插件不需要写权限：`--allow-fs-write` 一个都不给。
- **资源上限由宿主强制**：堆上限默认 128MB（`--max-old-space-size`），常驻内存（RSS）超过
  **堆上限的 1.5 倍**就重启该插件进程（Linux 上采样 `/proc/<pid>/statm`；Windows/macOS 用插件
  在 `ping` 应答里上报的 `rssKb`，不报则不做 RSS 判杀）；工具调用每分钟上限 120 次、并发在途
  调用上限 4 个（超了返回 `E_BUSY`，不排队堆积）、插件数据磁盘上限 256MB（storage/media/secrets
  合计，超了返回 `E_DISK_QUOTA`）。周期任务不受每分钟调用限制。
  插件 → 宿主的**能力调用（`cap.*`）同样受闸门约束**：并发在途不超过 `concurrency`；媒体类
  （`media.*`）同时只允许 1 个；`media.*`/`http.*`/`log.write` 另受 `callsPerMinute` 限制
  （storage/send 等高频小调用不按分钟限）。超限返回 `E_BUSY` / `E_RATE_LIMIT`，不排队。
  另有可选的**全部插件总内存上限** `plugins.limits.totalMemoryMb`（默认 0 = 不限；只在 Linux 有可靠
  RSS 读数）：运行中插件 RSS 之和达到上限后不再启动新插件，启动后超限的会被停掉并记 `E_TOTAL_MEMORY`。
  这些都在 `plugins.limits` 里调，也可以走控制台「设置 → 平台能力 → 插件宿主（高级）」；
  保存后按新上限重排插件进程。
- **懒启动**：只有工具、不观察消息也不起周期任务的插件，进程**按需起、空闲停**
  （`plugins.lazy` 默认开，空闲 `plugins.idleMinutes` 默认 15 分钟）。工具在模型那边一直可见，
  第一次调用时宿主才起进程 —— 装了十个插件不会常驻十个进程，代价是首次调用多约 100ms。
  声明了 `observe` 或 `schedule` 的插件**不懒启动**（消息与周期不会等你启动，懒启动它们等于功能静默失效）。
- **撤回名单**（`plugins.revoked`）：`"某插件"` 撤该插件所有版本、`"某插件@1.2.3"` 只撤那一个版本。
  命中的插件不加载、不给模型工具，但**列表里照旧显示并标注已撤回** —— 悄悄消失最难排查。
- **发布者签名**（可选，Ed25519）：索引条目里带 `publisher` + `signature`，宿主侧
  `plugins.publishers` 登记公钥后，安装前验签；登记过公钥的发布者，包没签名或验不过就**拒绝安装**。
  它证明的是"这个包确实是那把私钥的主人发的"，不证明"该不该信这个人"——后者靠索引人工审核。

## 发布者签名与撤回（可选，但出事时有用）

```bash
# 发布者：生成密钥对（私钥自己收好，公钥登记给使用者/写进索引 PR 说明）
node scripts/plugin-sign.mjs --keygen --out ~/.qq-agent-plugin-key
# 给包签名（打印可粘进索引条目的 signature）
node scripts/plugin-sign.mjs --key ~/.qq-agent-plugin-key.key --pack plugins/packages/<包>.tar.gz
```

使用者侧登记公钥，之后从这个发布者装的包会自动验签：

```json
{ "plugins": { "publishers": { "sakurawwwxh": "<公钥 base64 / hex / PEM>" } } }
```

- 登记了公钥的发布者：包**必须**带签名且验得通过，否则拒绝安装（`E_SIGNATURE`）。
- 没登记公钥：照装，但来源记录里标"未验证"，控制台显示出来 —— 用户至少知道这一条没有密码学证据。
- 撤回：`plugins.revoked` 写 `"id"`（撤全部版本）或 `"id@1.2.3"`（只撤那个版本）。

## 配置

```json
{
  "plugins": {
    "enabled": true,
    "enabledIds": ["weather"],
    "requireIsolation": true,
    "mirrorPrefixes": null,
    "networkIsolation": true,
    "requireNetworkIsolation": false,
    "lazy": true,
    "idleMinutes": 15,
    "toolMounting": "meta",
    "limits": { "memoryMb": 128, "callsPerMinute": 120 },
    "publishers": {
      "sakurawwwxh": "<公钥 base64 / hex / PEM>"
    },
    "revoked": ["某个出过事的插件@1.0.0"],
    "settings": { "weather": { "defaultCity": "上海" } }
  }
}
```

- `enabled` 总开关，默认 `false`；`enabledIds` 是**显式授权清单**，默认空 = 一个都不跑。
- `requireIsolation` 默认 `true`：本机 Node 不支持权限模型时**拒绝加载插件**（没有隔离就不执行
  第三方代码），并在日志与巡检里说明原因。改成 `false` 是明确接受"没有隔离"，后果自负。
- `toolMounting`（默认 `meta`）：插件工具怎么交给模型 —— `meta` 只挂**一个** `plugin_call`，
  里面列出可用的插件工具（模型多一跳，但每轮提示词不随插件数增长）；`direct` 是每个工具各挂一个。
  装十几个插件时这个差别很明显。
- `settings.<id>` 是给单个插件的配置，插件通过 `cap.config.get` 只能读到**自己这一段**。
- `mirrorPrefixes`：取**包**时的镜像前缀（形如 `https://ghproxy.example/https://github.com/…`）。
  默认用内置的几个；**空数组＝只用原始地址**（不绕第三方）；也可以写自己的代理。
  **索引不走镜像** —— 索引是信任根，镜像能替换"该装什么"，而 sha256 只能证明"包与索引里写的一致"；
  包则被 sha256 钉住，走镜像最多是"取不到"，不可能"取到假的还装上"。
  唯一例外是 GitHub 自己的 Contents API：`raw.githubusercontent.com` 请求失败（超时或非 200）时会换
  `api.github.com/repos/.../contents/...`（raw 媒体类型）取同一份文件，信任根没有变化。

## 分期

v1 的四段已经落地（宿主、能力与门控、控制台安装、示例与文档）。此后按**开放生态**的方向走：
先把"别人写得出、装得顺"这条路修好，再谈市场与信任基础设施。顺序与状态如下。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| v1 第一段 | 目录/manifest/协议/宿主/能力/注册表与门控 + 测试 | **已完成** |
| v1 第二段 | 挂进模型工具表（默认拒）、入站投递、周期任务驱动、巡检项 | **已完成** |
| v1 第三段 | 控制台「插件」页 + 官方索引一键安装（sha256 校验 / 解包防护 / 回滚） | **已完成** |
| v1 第四段 | 示例插件（`examples/plugins/mc-status`，2026-10-16 下架并删除）、作者向 quickstart、索引模板 | **已完成** |
| 生态 P1 · 作者 DX | `plugin-create` / `plugin-dev` / `plugin-pack`（生成、假宿主调试、可复现打包 + 装得上自测） | **已完成** |
| 生态 P2 · 契约与上架 | 兼容政策成文、索引多源（官方索引独立成仓库）、安装来源记录、索引校验进 CI、上架走 Issue 表单 + 自动校验（干净环境真装真起真调） | 待做 |
| 生态 P3 · 结构性加固 | 网络真拦（Linux 网络命名空间）、懒启动、资源上限（堆/常驻/限频）、发布者签名、撤回名单 | **已完成** |
| 生态 P4 · 市场与运营 | 控制台市场 UI（搜索/详情/更新提示）、发现机制、更多官方插件 | **已完成**（杀手级插件持续积累） |
| v1.1 | `send` 能力（出站发言，强制走发送队列与配额）、插件工具按需挂载（工具预算） | 待定 |
| v2 | 插件自带 `node_modules`、索引分级、控制台 UI 扩展 | 待定 |

## 升级时的权限变化（2026-10）

插件升级不再只是"换目录"：权限面变化必须重新授权。

- **升级前**：控制台先请求 `POST /api/plugins/upgrade-preview`，服务端下载、解包、按宿主同一份
  validator 解析新 manifest，再与已装版本做 diff。权限面有变化时弹确认层展示「新增/移除/变更」。
- **权限面**：`capabilities`、`httpDomains`、工具的 `action` / `actionTarget` / `actionPreview` / 参数、
  `approvals`、`quotas`、secret 字段、`schedule`、`apiVersion`、发布者与签名。只改描述/README 不算。
- **确认后**：安装请求带 `expectedDiffHash`；服务端校验哈希一致才换目录（防止"确认的是旧 diff"）。
- **重置**：权限面变化时自动关闭该插件的所有写动作开关、清空对象级批准与待批；
  当日配额计数保留（否则升级一次就能刷额度）。插件数据与 settings/secrets 值保留。
- **兜底**：每条批准与待批都绑定当时的 manifest 哈希；即使重置逻辑漏了，新版本也拿不到旧授权。
- **版本**：降级默认拒绝（`force:true` 可覆盖）；同版本重装保留（修复/重装是既有工作流）。

## 隔离能力实测（Node 22.23.2 / 24）

| 尝试 | 结果 |
| --- | --- |
| 读 `data/config.json`（凭据） | `ERR_ACCESS_DENIED` |
| 读插件目录外的文件 | `ERR_ACCESS_DENIED` |
| `child_process.spawn` / `execSync` | `ERR_ACCESS_DENIED` |
| `worker_threads` | `ERR_ACCESS_DENIED` |
| 写文件（含自己的目录） | `ERR_ACCESS_DENIED` |
| 加载同目录的兄弟模块（多文件插件） | 正常 |
| 网络（仅 Node 权限模型） | **通**（Node 权限模型里没有网络这一项） |
| 网络（Linux + 网络命名空间） | **不通**：connect / fetch 都是 `ENETUNREACH`（2026-10-16 实测，内核 5.15 + `unprivileged_userns_clone=1`，不需要 root，在 `setpriv --no-new-privs` 的加固环境里同样可用） |
| `process.env` | 可见 → 由宿主剥掉（白名单只留 PATH/TZ 等） |
