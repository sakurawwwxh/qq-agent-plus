# 配置示例（本分支新增项）

配置写在数据目录的 `config.json`（默认 `data/config.json`，含密钥，已被 Git 忽略）。
下面是本分支新增或调整过的键，其余键保持上游默认即可。

## security.allowFakeIpDns：代理 fake-ip（默认开）

```json
"security": {
  "allowFakeIpDns": true,
  "fakeIpCidrs": ["198.18.0.0/15"],
  "allowPrivateImageHosts": false
}
```

Clash/mihomo 等代理的 fake-ip 模式会把任意域名解析到 `198.18.0.0/15`。开启时只放行
**DNS 解析结果**里命中 `fakeIpCidrs` 的网段；URL 里直接写这些网段仍会被拒，`127/10/192.168/169.254`
等真正内网地址也仍然拦截。默认只列 IPv4 基准测试段；需要 fake-ip6 时自行追加
（例如 `"fc00::/18"`，先确认该网段在你的代理/网络里确实只承载 fake-ip）。关掉
`allowFakeIpDns` 则恢复旧行为：解析到任何私网/基准段都拒绝。

`config.json` 在进程运行期间被外部修改时，下一次保存会先把磁盘版本备份成
`config.json.conflict-<时间戳>-<pid>.bak`，然后返回 409，**默认不写盘**；控制台会给出
「重新加载磁盘配置 / 用当前页面覆盖」二选一。API 调用方确认覆盖时用
`POST /api/config?force=1`，重新加载用 `POST /api/config/reload`。备份写不出来时保存直接失败，
不会静默覆盖。

## platform.privateFileSend：当前私聊的纯文本资料（默认关闭）

```json
"platform": { "privateFileSend": false, "privateFileMaxKiB": 64, "quotas": { "privateFilesPerDay": 10 } }
```

控制台「平台能力 → 信息与素材」可显式开启，仅作用于允许访问的当前私聊，不受按群覆盖影响。
旧配置缺失该键、或值不是布尔 `true` 时关闭；群文件现有开关和行为不变。
每日额度 `platform.quotas.privateFilesPerDay` 默认 10 个（与其它平台写入闸门同一套 1–200 配置），
达到上限后不再上传；控制台「平台能力」的写入闸门表可查看用量和修改上限。

开启后提供 `send_private_file(text, name?)`：把本次生成或用户提供的文字在内存中编码为 base64，
经 `upload_private_file` 发送给 `ctx.chatKey` 绑定的私聊。正文默认最多 64 KiB（UTF-8），文件名最多
120 字节，只接受单个安全文件名与 `.txt` / `.md` / `.csv` / `.json` 扩展名，默认 `notes.txt`。
不接受 URL、本地路径、`file://`、原始协议端 `file`、任意接收人或其他额外参数；正文里的路径和
网址只会作为文字写入，不会读取或下载。不会生成 PDF/Office 文件，也不会自动读取配置、日志或资料库。

开关下方的「正文大小上限（KiB）」可设置 `platform.privateFileMaxKiB`：范围 1–256 的整数，
默认 64；缺失、零、负数、非数字类型和非有限值回落 64，小数向下取整且至少为 1，超大值硬顶 256。
不能用 0 取消限制，调整大小不会自动开启发送。该设置只由管理员控制，不是模型工具参数。
工具说明与提示词使用当前生效值；排队期间降低上限会在实际上传前再次校验，超限则不上传。
这个范围是本入口的资源保护范围，不代表协议端兼容性或实际收件的保证；调大后需单独验证。

仍遵守白名单/黑名单、运行模式、暂停、活跃时段、限流、取消、发送串行队列与 outbox。
排队期间关闭能力或撤销访问权限会阻止后续上传。此上传入口保守地不自动重试；确定未送达记为
`failed`，结果未知则挂起待人工核对，不能当成失败重发。
文件正文不写入发送台账；工具回执只确认发送结果，不回显正文。
失败回执使用固定安全文案及原因码，区分上传前阻止、确定未送达和投递结果未知；
暂停、时段、访问限制、限流与待核对写入分别说明，所有发送失败回执均标记不自动重试，且不回显协议端原始错误。
这不是内容保密过滤器：开启后，模型仍可能把当前上下文中已有的文字写入文件，使用时应遵守现有会话隔离和敏感信息规则。

需要协议端支持 `upload_private_file` 及 base64 文件输入；本地模拟测试不代表所有协议端版本兼容，
也不代表真实 QQ 收件成功。上线前请在获得收件方同意后，用合成文本单独验收。

## api.budget：每日花费上限（默认关闭）

```json
"api": {
  "budget": { "enabled": false, "dailyYuan": 20, "onExceed": "degrade", "notify": true }
}
```

- **按估算价累计**（estimateCost 的当日合计，落盘在 `data/usage-today.json` 的 `estimatedYuan`）；
  **仅本地开关，不产生任何实际扣费动作**，也不是账单对账口径。
- `enabled` 默认 `false`：升级不改变任何行为。`dailyYuan` 填 0 或非法值 = 永不超限
  （宁可不拦，也不把 0 当「零预算即封锁」）。
- `onExceed: 'degrade'`（默认）＝当天超限后**群里只回应 @**（非 @ 的消息保留未读，等被 @ 或明天）；
  私聊与手动唤醒不受限。`'block'` ＝新消息不处理（active 模式下回一句「今天的额度用完了，明天再聊」）。
  两者都只影响**新**运行，不打断进行中的会话。
- `notify: true` ＝超限当天私聊管理员一次（去重键＝日期，重启最多重发一条）。
- **未定价的运行不计入金额**，但会计入 `unpricedRuns` 并在 `/api/status` 的 `budget` 字段与
  控制台设置页显示 —— 防止「没价＝永远不超限」的静默失效。
- **口径边界：预算只管模型 token**（聊天/判断/写作/日报/空间互动的模型调用，
  按 `estimateCost` 的估算价累计）。**生图（generate_image）与语音合成（TTS）不计入、
  也不参与超限判定** —— 这两项按张/按字符计费，目前不写进 `usage-today.json`。
  换句话说：开了预算不等于"当天不会再多花一分钱"，只是"模型那头不会失控"；
  要连生图一起管，得先把它们的用量接进 `usage-today.json`（尚未做）。
- 跨日自动重置（沿用 `usage-today.json` 的 dayKey 惰性判定，无定时器）。

## api.thinking：思考档位（v0.7.4 起可按渠道/按供应商/按任务分设）

语义值：`on`（跟随服务商默认，也是默认值）/ `off` / `low` / `medium` / `high` / `max`。
程序按你填的 Base URL 识别渠道（内置常见服务商预设），把档位翻译成该家真实参数；
预设没有的档位不会出现在控制台档位条上（例如 Command Code 没有"关"）。

```json
{
  "api": {
    "thinking": { "chat": "off", "default": "on" },
    "thinkingByService": {
      "api.deepseek.com": "low",
      "open.bigmodel.cn": { "chat": "off", "judge": "high", "write": "max", "default": "on" }
    },
    "thinkingParams": { "low": { "reasoning_effort": "low" } },
    "extraBody": { "reasoning": { "enabled": false } }
  }
}
```

- `thinking`：全局兜底。字符串 = 所有任务一档；对象 = 按任务分设，`chat`（聊天）/ `judge`
  （判断·总结：记忆整理、身份与关系评估、收表情）/ `write`（每日动态、空间互动文案）/ `default`（其他）。
- `thinkingByService`：**按供应商独立**，键是 Base URL 的主机名（含端口、小写）。某家配了自己的条，
  就覆盖全局 `thinking`；没配的家用全局。控制台 → 设置 → 模型 API → 「高级：思考模式」里点档位条保存后自动写入。
- `thinkingParams`：**自定义档位映射**，给不在预设内的渠道用（键 = 档位名，值 = 该档实际发送的参数对象）。
  渠道识别不出来时会优先用它。
- `extraBody`：**额外请求参数**，以最高优先级合并进每次模型请求（含专用模型/兜底请求）；
  服务商文档里的怪参数都填这里。注意 `stream` 会被强制回非流式；`model` / `messages` / `tools`
  会整段替换对应字段。清空 JSON 时控制台走 `__replace__` 才能真删（deepMerge 只并集不删键）。
- 控制台「测试思考能力」按钮可按当前地址与 Key 实测：选"关掉"给"能不能关"的结论，
  选档位只报这一档能否通过；请求被 400 拒绝且错误提到 thinking/reasoning 参数时自动摘掉重试一次。

## api.fallback：兜底模型

```json
{
  "api": {
    "fallback": {
      "enabled": true,
      "baseUrl": "https://example.com/v1",
      "apiKey": "<另一个服务商的 key>",
      "model": "some-cheap-model"
    }
  }
}
```

主模型鉴权失败、额度不足或可重试错误耗尽时自动切换，日志里会写明原因；
主模型自身返回正常内容时不会触发（包括服务商审核拦截——那种情况会先用精简上下文重试一次）。

控制台入口：**设置 → 模型 API → 兜底模型**（启用、Base URL、模型 id、API Key）。
小米 MiMo 当前可用对话模型是 `mimo-v2.6-flash` / `mimo-v2.6-pro`；`mimo-v2.5` 对话模型已下线，
继续填写会在兜底时收到 400。跨服务商必须单独填兜底 Key，宿主不会把主渠道的 Key 发给另一家。

## api.vision / api.contextWindowTokens

`vision: true` 表示主模型能看图（收图后直接把图片交给模型）；上下文窗口按模型实际能力填写，
影响历史裁剪策略。

## proactive：主动开话题

```json
{
  "proactive": {
    "enabled": true,
    "checkIntervalMinMs": 9000000,
    "checkIntervalMaxMs": 12600000,
    "idleThresholdMs": 1800000,
    "probability": 0.55,
    "groupEnabled": true,
    "privateEnabled": false,
    "scopeMode": "shared",
    "perChatMaxPerTick": 2,
    "followUpEnabled": true,
    "selfWakeEnabled": true,
    "activeHours": {
      "start": null,
      "end": null,
      "windows": [{ "start": "09:00", "end": "12:00" }, { "start": "14:00", "end": "24:00" }]
    }
  }
}
```

- `enabled`：会话安静时按概率发起话题（控制台「设置 → 聊天设置 → 主动开话题」第一条），只管这一条链路。
- `groupEnabled`：安静时发起话题是否挑群聊，默认 `true`；候选沿用 `allow.groups` 与 `allowAllWhenEmpty`。
- `scopeMode`：`shared`（默认）= 群聊/私聊各共用一次机会，每轮各挑一个会话；`perChat` = 每个群/私聊独立按概率判定。`perChatMaxPerTick`（默认 2）限制独立模式每轮最多开几个，避免群多时刷屏。
- `privateEnabled`：是否也挑私聊，默认 `false`。打开后（且 `enabled: true`）按 `allow.private`
  的私聊白名单挑人，`deny.private` 仍然优先；规则与平时回复私聊一致，不另建名单。
  被选中的私聊同样要满足：没有未读、安静超过 `idleThresholdMs`、当前允许运行。
  控制台「群聊 / 私聊」两个复选框分别对应这两项；两个都不勾时不会主动开话题。
  群聊和私聊**各自独立计时、独立掷骰、独立记录上次判定**：一个范围这次开了话题或摇到不发言，
  不会占用另一个范围的机会。
- `followUpEnabled`：发言后无人回应时补一句（约 10 分钟后给一次机会）。与控制台同名的复选框对应。
- `selfWakeEnabled`：允许模型用 `schedule_wake` 给自己安排稍后的主动发言；关掉后该工具会从工具列表里摘掉。
- 这两项**独立于 `enabled`**，默认 `true`（与引入开关之前的行为一致）。想让它完全不主动开口，
  所有相关勾选都要关；只想关掉"补话"或"自安排唤醒"的，各关各的。
- `activeHours.windows`：生效时段，窗口外不开口，也不消耗间隔；`24:00` 表示到当天结束（补话与自安排唤醒同样受这个窗口约束）。
  控制台「聊天设置 → 主动开话题 → 发言时段」可直接增删多行；空列表 = 全天。
- `idleThresholdMs`：会话安静这么久才考虑开口（群聊与私聊同一口径）。
- `probability`：每次判定开口的概率。
- 安静判定（`idleThresholdMs`）的时间会落盘：重启后不足一个间隔会跳过（避免"重启一次多一次判定"）。
  补话的 20 分钟节流**只在内存里**，重启后从零算，可能比预期多补一次（2026-09-26 审查发现文档与实现不一致）。
- 上面示例里的数值是**示例**、不是出厂默认：出厂 `checkIntervalMinMs` 1800000（30 分钟）、
  `checkIntervalMaxMs` 5400000（90 分钟）、`idleThresholdMs` 1800000（30 分钟）、`probability` 0.25；
  照抄示例会改变行为。

## humanize：拟人化表达与状态（可选，默认关）

```json
{
  "humanize": {
    "enabled": true,
    "respectPersonaCard": true,
    "preset": "natural",
    "replyDelay": {
      "enabled": true,
      "minMs": 500,
      "maxMs": 1800,
      "perCharMs": 12,
      "capMs": 8000
    },
    "antiAi": { "enabled": true, "blockSevere": true },
    "personaState": { "enabled": true, "sleepStart": "00:00", "sleepEnd": "07:00" },
    "relationship": { "enabled": true },
    "actions": {
      "enabled": true,
      "maxPerRun": 4,
      "stickerCooldownMs": 60000,
      "pokeCooldownMs": 300000,
      "voiceCooldownMs": 600000,
      "reactCooldownMs": 30000
    },
    "shape": {
      "enabled": true,
      "maxBubbles": 3,
      "maxChars": 60
    }
  }
}
```

- `enabled`：总开关，默认 `false`。关闭时下面各项都不生效，提示词与发送节奏和升级前逐字一致。
- `respectPersonaCard`：默认 `true`。角色卡优先（`behaviorProfile: 'card'`）时不注入状态行、不改卡的措辞、不追加关系标签；`grounded` 档保留"首先/其次"这类结构词。
- `preset`：控制台风格预设（`natural` / `active` / `quiet` / `companion`），只用于记住上次选择；实际值以下面的具体参数为准。
- `actions`：动作冷却与单轮上限，避免连续贴纸/拍一拍/语音。`enabled` 默认 `true`（仅在 `humanize.enabled` 时生效）。
- `shape`：气泡整形。模型只给一段时按句子拆成 1–3 条（`maxBubbles`）、单条尽量不超过
  `maxChars`，代码块/URL/行内代码/颜文字受保护；只作用于人格回复，日报/群游戏/插件代发不拆。
  每张角色卡自己的字数、条数与间隔在 `roles/voice-profiles.json`，与这里的全局上限共同生效。
- `replyDelay`：只作用于本轮**第一条**消息，按总字数计算发送前延迟；后续气泡仍按 `send.minGapMs/maxGapMs` 的节奏。
  私聊会先显示"正在输入"；暂停/中止会立即取消等待。`perCharMs` 填 0 = 不按字数增加。
- `antiAi`：过滤助手式自指（如"作为一个 AI"）与客服收尾语；`blockSevere` 打开时，
  检测到明显的自指/免责会让模型用角色口吻重写一次（同一会话只拦一次，避免死循环）。
- `personaState`：按人设（`templateId` 或 `botName`）记录精力、心情与当前活动，每轮只往提示词注入一行；
  状态随时间缓慢变化，互动会轻微抬心情。`sleepStart/sleepEnd` 是作息窗口，睡眠时段会提示"回复短一点、慢一点"。
- `relationship`：只对**已经有人物印象**的人累计互动次数，格式化成"关系：刚认识/有点熟/熟/很熟"；
  不会为陌生人新建档案，也不改变检索与排序。
- 控制台入口：设置 → 聊天设置 → 「所有模式 · 拟人化表达（实验性）」。
- 边界：不伪造真人身份；被直接问"你是不是 AI"时仍按角色卡/平台安全规则处理。

## webSearch：联网搜索（多家 provider + 聚合）


```json
{
  "webSearch": {
    "enabled": true,
    "provider": "bing",
    "maxResults": 6,
    "tavily": {
      "apiKey": "", "baseUrl": "https://api.tavily.com/search",
      "count": 5, "searchDepth": "basic", "timeoutMs": 20000
    },
    "aggregate": { "sources": ["tavily", "doubao", "bing"], "count": 4 }
  }
}
```

- `provider` 可选：`bing`（默认，优先读 `cn.bing.com` RSS，失败时回退 HTML 页面，不需要 Key）、`deepseek`、`zhipu`、`bocha`、
  `baidu`、`metaso`、`doubao`、`tavily`、`aggregate`（控制台「设置 → 搜索」里选）。
- 每家一套 `{ apiKey, baseUrl, count, timeoutMs }`（`zhipu` 另有 `engine`、`tavily` 另有 `searchDepth`）；
  `apiKey` 留空时回退各自的环境变量：`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `BOCHA_API_KEY` /
  `BAIDU_SEARCH_API_KEY` / `METASO_API_KEY` / `DOUBAO_SEARCH_API_KEY` / `TAVILY_API_KEY`。
- `deepseek`：优先走官方 **Search API** `POST {baseUrl}/v1/tools/search`，返回结构化 `title/url/summary`
  （`count` 1–50，`needContent:true` 时额外取正文）；老配置里的 `/responses` 会被自动剥掉。
  只有新接口返回 404/405 或没有结果时，才回退到旧 Responses `web_search`（旧接口拿不到 URL，`model` 只给这个兜底用）。
- `tavily`：tavily.com 的搜索 API（2026-09 时点的公开口径：免费档 1000 次/月，专为 LLM 设计），另有 `searchDepth`（默认 `basic`）。
- `aggregate`（聚合搜索）：并发跑 `sources` 里的多个源，URL 去重、每条结果带 `source` 标注；
  `sources` 顺序就是结果优先级，单个源失败不影响整体，全部失败才报错。
- 还能在控制台「搜索提供方」里自己加提供商（`type: 'openai'` 走 POST JSON 搜索接口、`type: 'bing'` 抓页面解析），
  在下拉框里以 `custom:<id>` 的形式出现。

## sticker：表情包

```json
{
  "sticker": {
    "enabled": true,
    "promptMaxStickers": 10,
    "collectEnabled": true,
    "autoCollect": true,
    "maxCollectPerHour": 10,
    "maxCollectPerHourPerChat": 3,
    "collectCriteria": "",
    "encourage": 3
  }
}
```

- `promptMaxStickers`：系统提示里常驻的可用表情条数（1~60；控制台「设置 → 聊天设置 → 所有模式 ·
  表情包」里是滑条，拖动设置）。清单一半按使用频次取常用的，一半留给没用过/很久没用的
  （发掉一张换下一张顶上来）；条数越大能选的范围越宽，代价是每轮提示词更长。库容量与此无关：
  收藏表情同步一律拉 500 条，全在库里；手改配置写成 1~60 以外的数会在保存/渲染时落到边界值。
- `collectEnabled`：收藏总闸（默认开）。关掉后机器人不再收任何表情 —— 自动扫群友发的图与
  聊天里主动收藏都停；控制台里手动添加不受影响。控制台「设置 → 聊天设置 → 所有模式 · 表情包」
  的「允许机器人自己收藏表情包」开关**同时**管它和 `autoCollect`（界面上就是一个开关）。
- `autoCollect`：别人发来的表情包是否自动入库（同图只存一次）。仅在 `collectEnabled` 开着时生效；
  手改配置可以只关它（保留"聊天里看中某张图主动收"这条），控制台开关做不到这种拆分。
- `collectCriteria`：收藏判定的「判定标准」——**收什么 / 不收什么**（留空 = 内置默认，行为与之前
  完全一致）。只写判定标准本身，身份那句（"你是「谁」、正在看谁的图"）由代码补在前面；上限
  2000 字（控制台里是同名多行文本域，留空即内置默认）。环境不同、角色取向不同时按自己的口味
  填一段即可，改完即时生效、不用重启；自动收藏与聊天里主动收藏共用这一份标准。
- **收藏速率双闸（#9）**：`maxCollectPerHour`＝**全局**每小时上限（默认 10，控制台里是 1~60 滑条），
  `maxCollectPerHourPerChat`＝**每个会话**每小时上限（默认 3）。任一超限都会被拒，文案区分
  「本会话收藏太频繁」与「全局每小时上限」；判定只查不扣，真正记账发生在图片落库成功之后
  （取不到图/写库失败不占额度）。两个都是滑动 1 小时窗口，进程内计数、重启归零。
- `encourage`：鼓励使用表情的力度（0-3），太频繁可调回 1-2。

## asr：语音转文字（可选，默认开启）

```json
{
  "asr": {
    "enabled": true,
    "provider": "openai",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "model": "",
    "apiKey": "",
    "maxPerHour": 12,
    "maxPerHourPerChat": 4,
    "language": "",
    "localBin": "",
    "localModel": ""
  }
}
```

- 作用：把消息里的语音、音频文件、视频音轨转成文字再交给聊天模型 —— 与模型是否多模态无关。
  控制台「设置 → 语音转文字」有同一组开关与字段。
- **转写次数双闸（#9）**：`maxPerHour`＝**全局**每小时上限（默认 12，跨会话共享），
  `maxPerHourPerChat`＝**每个会话**每小时上限（默认 4）。任一超限都拒绝并给不同文案
  （「本会话…」/「本小时全局…」）；额度在"确定要下载+转码"时才扣，调错消息不消耗额度。
  滑动 1 小时窗口、进程内计数、重启归零（按量计费场景够用，不是精确对账）。
- 控制台里「用哪种方式」只有两项：**API Key · 托管服务（推荐：更快、不用下模型，硅基流动/Groq 有免费额度）**
  或 **免费 · 本机安装的 Whisper（不联网、不要 Key，转写较慢）**；
  选了前者再由「服务预设」挑具体哪家（硅基流动 / 火山引擎 / 阿里云百炼 / 讯飞 / 腾讯云 / 百度 / Groq / OpenAI 官方 / 自定义自建）。
  模型**从服务商官网拉**（「获取模型列表」按钮打 `{baseUrl}/models`）—— 预设里写死模型名会过时，
  比如硅基流动新上免费模型时，列表跟着官网走才看得到。与「搜索服务」完全独立，不必是同一家、同一个账号：

  | provider | 说明 | 需要什么 |
  | --- | --- | --- |
  | `local` | 本机 **whisper.cpp**：不联网、不要 Key、无按量费用、音频不出机器 | 控制台「设置 → 语音转文字」点「安装本机转写」（推荐，带进度、装完自动生效）；装好后旁边有「完全卸载（删除模型与程序）」可释放约 500MB（删托管目录 `<数据目录>/asr` 与配置里指向它的路径；你另外装的 whisper.cpp/模型不会被碰）。或在服务器上跑 `node scripts/install-asr-local.mjs`，后者**要重启一次服务**（配置只在启动时读一次） |
  | `volc` | 火山引擎语音技术的**大模型录音识别（Seed-ASR）**，WebSocket，按量计费 | `apiKey`（语音技术控制台创建；也可用环境变量 `ASR_API_KEY`） |
  | `openai`（**默认**） | **任意 OpenAI 兼容**的转写服务：`POST {baseUrl}/audio/transcriptions`；默认预置硅基流动的地址（可一键换别家） | `apiKey` + `baseUrl`（到 `/v1` 那层）+ `model` |
  | `aliyun` | 阿里云百炼：走它的 OpenAI 兼容 chat 端点 + `input_audio`（默认模型 `qwen3-asr-flash`） | `apiKey`（百炼的 API Key）；地址/模型有默认值，可改 |
  | `baidu` | 百度短语音识别（标准版）：`POST vop.baidu.com/server_api`，JSON 带 base64 音频 | `apiKey`；老的「API Key + Secret Key」还要 `secretKey`（新的 `bce-v3/ALTAK-…` Key 只填 API Key） |
  | `tencent` | 腾讯云**一句话识别**：`POST asr.tencentcloudapi.com`，TC3-HMAC-SHA256 签名 | `secretId` + `secretKey`（访问密钥里的那对，不是 API Key）；地域默认 `ap-guangzhou` |
  | `iflytek` | 讯飞**语音听写**：`wss://iat-api.xfyun.cn/v2/iat`，签名 URL + WebSocket | `appId` + `apiKey` + `secretKey`(APISecret) 三个值 |

  **这四家的免费额度**（2026-09-26 查证，以各家官网当期政策为准）：
  讯飞语音听写约 **500 次/日**（新用户默认，另有一次性免费包）；百度短语音识别个人约 **5 万次**；
  腾讯云一句话识别约 **5000 次/月**；阿里云百炼新用户有免费额度（文生图/语音等按模型计）。

  ⚠️ 这四家都**不走 OpenAI 协议**，是各自的原生适配（腾讯的 TC3 签名与官方 SDK 交叉验证过、
  讯飞的分帧协议用本地假服务端跑通过；但**都没有用真实凭据端到端验证过**）。真机上若鉴权或参数不对，
  各家会回明确的错误码，这里会翻译成人话（例如"签名/鉴权没通过：核对 SecretId/SecretKey 是否填反"、
  "音频过长（超过 60 秒，需要分片）"），便于一轮定位。**超过 60 秒的音频会自动分片**（55 秒一片）
  后逐段转写再拼接。

- 本机转写的路径解析：`asr.localModel` / `asr.localBin` > 环境变量 `WHISPER_MODEL` / `WHISPER_BIN` >
  自动找（`<数据目录>/asr/`、仓库 `models/`、`~/.cache/whisper.cpp/`；二进制按 `whisper-cli` → `whisper-cpp` → `main`）。
  所以装完脚本后**什么都不用填**，控制台里也会显示"当前会自动用哪两个路径"。
- **免费选项**（都走 `openai` 那支；控制台里选「服务预设」会把**地址**填好，**模型**要点「获取模型列表」从官网拉
  —— 预设里写死模型名会过时；你只需粘一个该服务的 Key。
  免费政策是会变的，下面的事实核查于 2026-09-26，用之前建议看一眼各家价目表）：

  | 服务 | baseUrl | model | 免费情况 |
  | --- | --- | --- | --- |
  | **硅基流动**（推荐，国内可直连） | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` | 官方价目表标**免费**；单文件 ≤1 小时 / ≤50MB |
  | Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | 有免费额度（约每分钟 20 次、每天 2000 次、每天 8 小时音频）；单文件 25MB；国内可否直连未确认 |
  | 自建 | 你自己的网关 | 自定 | 免费（前提是你有机器），faster-whisper 等 |

  **没有任何托管服务能做到"零注册零 Key"** —— 想完全不注册账号，只有 `local`（本机 whisper.cpp）：
  一次装好后永久免费、离线可用，但 CPU 转写大约 1.5~2 倍实时（2 核机器上 30 秒语音约 15~25 秒），
  长音频会很慢；中文建议 `ggml-small.bin`（约 466MB）起步。
- 没配齐时这项**完全不生效**：工具不会注入给模型、不会产生任何调用与费用，提示词照旧说"听不了语音"。
- 凭据与"存它时的服务"绑定：`apiKeyProvider`、`secretIdProvider`、`secretKeyProvider`，OpenAI 兼容服务
  再加一层 `apiKeyHost`（主机名）。换服务、或换到另一个主机（硅基流动 ↔ Groq ↔ OpenAI 都算 `openai` 这一家，
  只看 provider 分不出来）之后，旧凭据**不会被发到新地址**；切回**存过凭据的**服务/主机时控制台会自动
  填回那把（按服务槽位记在 `keys` 里，见下），只有从未存过的才提示重新填一次。环境变量 `ASR_API_KEY`
  不受此限（它是部署级的单一值）。升级上来的老配置在读盘时自动补记归属，原来能用的照常能用。
- 控制台保存后配置里会出现 `keys`（按服务记住的凭据：OpenAI 兼容按地址主机分槽、其余按供应商，
  切预设时自动取回）。手改配置一般不用动它；删掉只会丢掉"切回来自动填回"的便利，不影响当前在用的凭据。
- `language` 可选（`zh` / `en`…），留空由服务自己判；`maxPerHour` 是每小时的硬闸门（跨会话共享，默认 12，
  非正数按 12 处理）。**按"转写一条消息"计**：超过 55 秒的音频会拆成多段请求，服务商那边的额度是按段扣的
  —— 一条 13 分钟的语音约等于 15 次上游调用（2026-09-26 审查标注口径）。
- `local` 与 `iflytek` 要按音频真实时长逐帧推流：一次运行的总时限（默认 180 秒、上限 240 秒）里转不完长音频，
  超过约 150 秒（本机约 75 秒）会**提前**给一句可照做的提示，而不是等两分钟才超时。
- 需要服务器上有 `ffmpeg`（转码用）；单条音频上限 15 分钟，超长会直接报错不转写。
- **视频给的是"画面 + 声音"两样**：画面由 get_message_images 抽 4 帧拼成 2×2 帧条（JPEG）给视觉模型，
  声音由 get_message_audio 转写音轨；两者独立，模型可以只取其一。协议端若只给文件名、没给可下载 URL
  （NapCat 在视频只存在本地缓存时如此），工具会明说拿不到地址并建议用"发送文件"重发，而不是报一句"URL 无效"。
- **QQ 语音是 SILK 格式**（文件名写着 `.amr`、服务端还回 `content-type: audio/mp3`，但字节是
  `.#!SILK_V3`）—— ffmpeg **不支持** SILK，所以这条链路不走 ffmpeg：先用 `silk-wasm`（WASM，
  随依赖安装）在本地解成 16k 单声道 PCM，再交给所选服务转写。协议端的 `get_record` 不会替你转码
  （实测 NapCat：传 `out_format=mp3/wav` 仍返回同一个原始 URL），所以这一步必须自己做。

## memory：记忆整理与可见性（可选）

```json
{
  "memory": {
    "consolidateEnabled": true,
    "handoffEnabled": true,
    "consolidateMinIntervalMs": 21600000,
    "useChatModel": true,
    "visibility": {
      "mode": "global",
      "hidePrivateInGroup": false
    },
    "maxImpressionsPerPerson": 50,
    "impressionRetentionDays": 0
  }
}
```

- `visibility.mode`：`global`（默认，＝历史行为）＝所有会话观察到的印象都会注入提示词、
  也都会被 `memory_query` 返回；`perChat` ＝只注入/返回「来源含当前会话」的印象
  （印象按条记录来源，切到 perChat 后，群里看不到来自别的群与私聊的印象）。
  **两个字段的默认值与历史完全一致，切换是需要显式操作的运营决定。**
- `visibility.hidePrivateInGroup`：`true` 时**群聊里**不注入/返回来源含 `private:<QQ>` 的印象
  （私聊里照常可见）——适合"不想让人觉得机器人把私聊内容带进群"的运营者。
- `handoffEnabled`（默认 `true`）：允许模型在长会话里写「会话交接」，下次唤醒时带上。
  关掉后 `finish` 不再生成交接草稿、`_handoff.json` 也不再注入（已有文件不删）；
  lifecycle 模式的检查点仍会记录“本轮发了多少条/是否沉默”这类运行摘要，但不含模型写的交接字段。
  控制台「设置 → 记忆 → 记忆整理」有勾选框。
- 控制台「设置 → 记忆整理」有同样两个控件（下拉 + 勾选框），保存即生效，无需重启。
- 控制台的人物记忆页不受影响：你始终能看到全部印象与来源；「来源」不交给模型
  （`memory_query` 返回前会剥掉 `sourceChatKeys`）。
- 记忆整理的其他字段（冷却时间、发现新人的门槛、专用模型）都在同一设置页里，逐个有提示。
- `maxImpressionsPerPerson`（默认 50，范围 5–200）：每人最多保留多少条印象；手写 `manual` 条目永远不被这个上限删掉。
- `impressionRetentionDays`（默认 0，范围 0–3650）：自动印象保留天数；0 = 不按时间过期。默认不设过期，
  升级老库时不会把历史印象直接清掉。

## skills：技能包（可选，默认关）

```json
{
  "skills": {
    "enabled": true,
    "enabledIds": ["chat-summary"],
    "perChat": {
      "group:123456": ["video-digest"]
    },
    "indexUrl": "https://raw.githubusercontent.com/sakurawwwxh/qq-agent-skills/main/index.json",
    "allowPrivateIndex": false
  }
}
```

- `enabled`：总开关；关闭时不加载 `skills/`、不注册 `skill_list` / `skill_use`。
- `enabledIds`：全局启用的技能 id。
- `perChat`：按会话覆盖；键是 `group:<群号>` / `private:<QQ>`，值是该会话可用的技能 id 列表。
- 技能是只读 Markdown + 工具白名单，不能执行代码；给技能的工具只能**收窄**本轮工具，不能新增。
- 控制台顶部「技能」页可以开关、按会话覆盖、重新扫描目录，并在「技能市场」子页从官方索引 `qq-agent-skills` 安装/卸载用户技能；格式见 [SKILLS.md](SKILLS.md)。
- `indexUrl`：技能市场索引地址；留空 = 不显示市场。`allowPrivateIndex` 只给自建/局域网索引用，默认 `false`（市场只访问公网地址）。

## livingMemory：长期向量记忆（实验性，默认关闭）

```json
{
  "livingMemory": {
    "enabled": false,
    "mode": "shadow",
    "allowPrivate": false,
    "allowGlobal": false,
    "maxRecallItems": 6,
    "recallTimeoutMs": 1800,
    "shadowSemantic": false,
    "turnRetentionDays": 7
  }
}
```

- 数据和向量都保存在 Agent 数据目录的 `living-memory/living-memory.sqlite`，不需要额外容器或向量数据库。
- `shadow` 会收集和审计关键词召回但不改变回复；确认质量后才切换 `active`。`shadowSemantic=true` 会让影子模式也调用 Embedding（更贵、更慢，只建议短时验证）。
- `turnRetentionDays` 控制来源回合保留天数（默认 7）；删除记忆会同时删除它引用的来源文本。
- 语义检索需要进程环境中的 `LIVING_MEMORY_EMBEDDING_BASE_URL`、`LIVING_MEMORY_EMBEDDING_API_KEY` 和 `LIVING_MEMORY_EMBEDDING_MODEL`；未配置时自动退回关键词检索。完整说明见 [LIVING-MEMORY.md](LIVING-MEMORY.md)。

## memberNotes：群友称呼（备注/代号，可选）

```json
{
  "memberNotes": {
    "123456789": "pyy"
  }
}
```

- 按 QQ 号记"这个人在机器人眼里叫什么"。**记下之后，聊天记录、成员列表里显示的都是它**
  （优先于群名片与昵称）；不设就照旧用群名片。
- 两个写入口：控制台「人物记忆页 → 备注」（也是"按 QQ 设备注"那一行），
  或直接在群里让机器人记（它对「以后叫他 pyy / 别喊群名片」这类要求用 `set_member_note` 落一条，
  只能给当前会话里出现过的人设，号码编错会被拒）。控制台可随时改回；清空即恢复群名片。
- 备注会作为"显示名"反复进提示词，与其他外部文本同口径（段头会被弱化）；
  存储层单个备注最长 200 字，模型工具侧限制 16 字（够当称呼用）。

## tts：语音回复（可选，默认关闭）

```json
{
  "tts": {
    "enabled": true,
    "provider": "openai",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKey": "<语音合成的 Key>",
    "model": "FunAudioLLM/CosyVoice2-0.5B",
    "voice": "FunAudioLLM/CosyVoice2-0.5B:anna",
    "speed": 1.1,
    "gain": 0
  }
}
```

- **五种适配器**（按 `provider` 分发，`src/llm/tts.js`）：
  `openai`（兼容 `POST {baseUrl}/audio/speech`，硅基流动/OpenAI/自建，**已实测**）、
  `volc`（火山引擎语音合成 **v1** HTTP，需要数字 `appId` + `apiKey`=Access Token，`cluster` 默认 `volcano_tts`、
  复刻音色自动切 `volcano_icl`（见下文「火山的两套凭据不一样，别混」），
  音色如 `BV001_streaming`；老接口，账号没开通 v1 服务时会固定报 3001）、
  `doubao`（火山引擎**豆包大模型语音合成 2.0**，`https://openspeech.bytedance.com/api/v3/tts/unidirectional`，
  只填 `apiKey`（控制台密钥，走 `X-Api-Key`）与 `voice`，`resourceId` 默认 `seed-tts-2.0`；
  **2026-09-28 用真实账号实测**：音频/语速/音量/格式/错误码都核过，自然度明显高于 v1 与硅基流动）、
  `minimax`（T2A v2，需要 `apiKey` + `groupId`，音色如 `female-shaonv`，音频是 hex 编码、适配器已处理）、
  `mimo`（小米 MiMo token-plan，走 `POST {baseUrl}/chat/completions`，Key 放 `api-key` 头；
  支持「导演指令」和 `send_voice` 的 `emotion` 参数，**2026-10-25 用 token-plan 账号实测**：有导演指令时停顿/语气明显更自然）。
  volc / minimax 按官方文档实现但机器上没凭据、未实测：填好凭据点控制台「试听」即可验证，报错会把人话原因（含火山错误码含义）带出来。

豆包 2.0 的写法（当前最推荐的音质）：

```json
{
  "tts": {
    "enabled": true,
    "provider": "doubao",
    "baseUrl": "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    "keys": { "doubao": "<语音技术控制台里的密钥>" },
    "resourceId": "seed-tts-2.0",
    "voice": "zh_female_vv_uranus_bigtts",
    "speed": 1.1,
    "gain": 2
  }
}
```

MiMo 的写法（想要语气、又不想上 GPU 时最省事）：

```json
{
  "tts": {
    "enabled": true,
    "provider": "mimo",
    "baseUrl": "https://token-plan-cn.xiaomimimo.com/v1",
    "keys": { "mimo": "<token-plan 控制台里的 Key>" },
    "model": "mimo-v2.5-tts",
    "voice": "Chloe",
    "director": "你是小鲸鱼，声音软一点，像在群里随口聊天，不要播音腔。",
    "format": "mp3"
  }
}
```

- MiMo 的 Key 走 `api-key` 请求头（不是 `Authorization: Bearer`）；`baseUrl` 填到 `/v1` 即可，适配器会补 `/chat/completions`。
- `director` 是**全局人设级**的导演提示；模型每次调 `send_voice` 还可以带 `emotion`（`happy` / `soft` / `sad` / `tired` / `playful` …），
  服务端会把情绪追加成一行「【情绪】…」再发给 MiMo。没有情绪时最少也会带一句「群聊口语、不要播音腔」的默认指导。
- `voice` 内置候选有 `mimo_default` / 冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean；实测 Chloe 偏清亮，最接近「小鲸鱼」那类形象。
  音色是否可用看账号开通情况，报错会带 HTTP 状态与上游原因。
- 这不是 RVC/Seed-VC：它能把**说话**的语气做出来，但不能把真人歌声换成另一个声线，也别拿它复刻未授权的第三方声音。
- **合成失败会自动回落成文字**：`send_voice` 发不出语音时改发同一段文字（返回里带 `fallback: "text"` 与原因），不会让这轮回复消失。
- 与 `asr` 对称但**默认关**。
- **服务预设**：控制台「设置 → 语音回复」有预设下拉（硅基流动 / OpenAI 官方 / 火山 v1 / 豆包 2.0 / MiniMax / 小米 MiMo / 自定义），
  选中会把地址、资源 ID 填好，并给出这家的常用模型与音色候选；OpenAI 兼容那几家还能点「获取模型列表」从官网拉全量。
  音色没有可查接口（硅基流动与 OpenAI 都实测 404），只能内置——表在 `src/llm/tts-presets.js`。
  火山/豆包/MiniMax **没有模型列表接口**，界面上会直接说明该填什么（不再显示"共 0 个"）。
- **火山的两套凭据不一样，别混**：v1 要「应用管理」里的数字 AppID + Access Token + `cluster=volcano_tts`；
  豆包 2.0 只要控制台密钥（`X-Api-Key`），**不需要 AppID / Cluster**，但要多填一个 `resourceId`。
  常见填错：把资源 ID（`seed-tts-2.0`）填进 AppID、把音色名（`zh_*_uranus_bigtts` / `ICL_uranus_*`）填进 Cluster ——
  控制台会当场提示，服务端报错也会说明（`3001` = AppID/Token 不对；`45000010` = Key 不对；`45000030` = 没开通该资源；
  `55000000` = 音色与资源 ID 不匹配）。
- **声音复刻音色要换资源 ID，适配器已自动处理**：控制台复刻出来的音色形如 `S_xxxxxxxx`
  （批量查询接口给的是小写 `icl_` 开头），属于**声音复刻大模型**，必须用 `X-Api-Resource-Id: seed-icl-2.0`
  （合成时适配器会按音色前缀自动切；你用「资源 ID」栏手填 `seed-icl-1.0` 也会被尊重，对应复刻 1.0 的老音色）。
  **v1 接口同理**：复刻音色要 `cluster: volcano_icl`（不是 `volcano_tts`），适配器同样会按音色自动切
  （官方 v1 文档写明业务集群「标准音色、复刻等均不相同」）。
  账号要先在控制台「开通管理」开通**声音复刻2.0字符版**；**后付费音色还要单独开通「后付费音色服务」**，
  否则首次调用会报 `45000030 requested resource not granted` —— 那不是"没买音色槽位"，而是这条后付费服务没勾。
  注意别把**官方投放音色** `ICL_uranus_*`（首字母大写，火山自营，跟普通 2.0 音色一样走 `seed-tts-2.0`）
  当成复刻音色：它不在内置候选表里，但直接手填进「音色」就能用，不需要开通复刻资源。
- 豆包 2.0 的音色表 = **火山官方 2.0 全量清单（102 个，按控制台分类分组）**，控制台「候选音色」里的分类与火山控制台的音色列表一一对应；
  2026-09-28 在真实账号上把这 102 个逐个打过一遍：中文 99 个全部可用，3 个英文音色该账号未开通（会用 `resource not granted` 说明，别的账号可能已开通）。
  官方投放音色（形如 `ICL_uranus_zh_female_xxx_tob`，共 201 个）不在内置表里，直接手填进「音色」即可 —— 界面不会自动替换不在表里的音色；
  自己复刻的音色（`S_` 开头）同理，且资源 ID 会自动切到 `seed-icl-2.0`。
- `voice`：硅基流动是「模型id:音色」（`…:anna / bella / claire / diana / benjamin / alex / charles / david`），OpenAI 官方是裸音色名（`alloy / nova / …`），火山系是音色 ID。
- `speed`（0.25~4）与 `gain`（-10~10 dB）：本机实测**真实生效**（同一句 0.7→8.1s、1.3→4.7s）；聊天语速 1.05~1.15 更活，觉得闷可以把 gain 提 2~4。
- 平淡的另一半在**文本**：合成内容要写成口语（语气词 + 「——」「……」「？」带停顿），工具描述里已这样教模型。
- 开启后模型多一个 `send_voice` 工具：短句 1~3 句、≤120 字最自然；提示词只会在开启时才教它用。
  工具支持 `emotion`（情绪）参数；支持导演指令的供应商会把它变成真实语气，其他供应商忽略。
- 协议端需要支持 `record` 消息段；不支持时发送会失败并提示改用文字（不会反复重试）。
- 与 `asr` 的 Key 分开配置（听和说是两个服务是常态）。
- **Key 按服务分家**：`keys` 映射按服务 id 记着各家的 Key（`{"volc":"…","doubao":"…"}`），
  切预设不串用、切回来还能自动填回；单槽 `apiKey` 是升级前的形态，它属于 `apiKeyService`
  记下的那一家——控制台保存时自动维护这两个字段，手改一般不用动。
  切换到**没存过 Key** 的服务且没填 Key 时，旧的那把会先归档进 `keys` 再停用（切回去能自动取回，
  但不会发给新服务）。

## imageGen：图片生成（可选，默认关闭，按张计费）

```json
{
  "imageGen": {
    "enabled": true,
    "baseUrl": "",
    "apiKey": "",
    "apiKeyHost": "",
    "model": "gpt-image-1",
    "size": "1024x1024",
    "responseFormat": "",
    "maxPerHour": 6,
    "autoSend": true
  }
}
```

- 作用：群友说「画一张」时模型调 `generate_image`（OpenAI 兼容的 `POST {baseUrl}/images/generations`），
  生成的图**默认直接发到当前会话**，同时存进表情库；`autoSend: false` 时只入库，模型需要时再用
  `send_sticker` 发。控制台在「设置 → 语音转文字」页下方的「图片生成」区块（与语音回复同页），
  有「试画一张」当场验证配置。
- **生成后发送格式**：`imageGen.sendAs` 取 `sticker`（默认，按表情发送）或 `image`（普通图片，群友可直接保存）。
  只影响 `generate_image` 自动发送的图；表情库手动发表情不受影响。控制台「图片生成」区块有同名下拉。
- **服务预设**：控制台下拉里预置了「去哪儿拿免费的图模型」，选中会自动填好地址与默认模型（表在
  `src/llm/image-gen-presets.js`）：

  | 预设 | 地址 | 要不要 Key | 说明 |
  | --- | --- | --- | --- |
  | Pollinations | `https://image.pollinations.ai` | **不用** | 免注册免 Key，零成本开箱可用；第三方公共服务，**按 IP 限流**（官方口径匿名档 15 秒 1 次，2026-10-01 查阅）、**图片带它的水印**、提示词会经过它。额度用完返回空的 402 —— 当"试玩"，长期用换有免费额度的图模型 |
  | 智谱 CogView-3-Flash | `https://open.bigmodel.cn/api/paas/v4` | 要（免费档） | 2026-10-01 真机实测：8~9 秒出一张 1024×1024（约 100 KB）；是否仍免费以智谱定价页为准。出图**右下角带「AI 生成」水印** —— 国内厂商按《人工智能生成合成内容标识办法》都要打，介意水印只能换海外服务商 |
  | 硅基流动 | `https://api.siliconflow.cn/v1` | 要 | 到「模型广场」挑标了**免费**的图模型填进「模型」栏 |
  | Moss Image | `https://api.mosi.cn/v1` | 要 | `moss-image-base-1.0` / `moss-image-sft-1.0`；地址只填到 `/v1`，不要带 `/images/generations`；官方只支持 `response_format=url`，生成较慢；去水印可在「自定义请求参数」填 `{"output_watermark": {"enabled": false}}`（官方文档是嵌套对象，不是布尔值） |
  | 魔搭 ModelScope | `https://api-inference.modelscope.cn/v1` | 要 Token | 按公开口径有每日免费额度（以官网为准） |
  | 自定义 / 自建 | 自己填 | 要 | 任何 OpenAI 兼容的 `/images/generations` |

- **服务商文档里的零散参数走 `imageGen.extraBody`**：控制台「图片生成」区块的「自定义请求参数（JSON）」
  会原样合并进生图请求体，适合 Moss 的 `output_watermark`、`quality` 这类没有单独输入框的参数。
  同名键会覆盖适配器生成的 `model` / `n` / `size`；填错 JSON 时保存会就地提示并保留原值，清空该框即删除全部自定义参数。

- **Pollinations 是唯一"免 Key"的一条，请求形状也跟别家不同**：它是
  `GET {地址}/prompt/<提示词>?width=&height=&model=&nologo=true`（提示词在路径里，`nologo` 尽最大努力去它自家的水印），适配器按主域名自动切换。
  ⚠️ 它另有一个长得像 OpenAI 的 `POST /openai/images/generations`，但那个端点**不解析请求体** ——
  两个完全不同的提示词会返回逐字节相同的图（2026-10-01 实测），所以不要照那个接。
- **地址留空 = 跟聊天模型同一家**（很多网关同域就带 images 端点，填个模型名就能试）。
- **Key 归属有守卫**：地址与聊天模型**不同域**时必须单独填 Key —— 不会把模型那把 Key 发给别家。
  同域（或地址留空）时留空即复用模型 Key。这条是为了防"把 A 家的密钥发给 B 家"的事故；
  预设里声明"不需要 Key"的那家（Pollinations）是唯一的例外，它连 `Authorization` 头都不发。
- **换地址后旧 Key 不跟过去**：单独填过的 Key 会记下"当时是给哪家的"（`apiKeyHost`，保存时自动写入，
  不用手填）。之后在控制台把预设/地址换成别家，那把旧 Key **不会**被发到新地址；换回**存过 Key 的**
  地址时控制台会自动填回那把（按主机记在 `keys` 里），只有从未存过的地址才提示"当前地址要重新填一次
  Key"，重填后自动改记到新地址。这与 `asr` 的 Key 绑定同一套逻辑（见上文 `asr` 一节）。
- `model` 必填（如 `gpt-image-1` / `seedream-3.0` / `cogview-3` / `flux`）；`size` 可选，留空用服务商默认
  （Pollinations 那条会把 `1024x1024` 这类值转成它的 `width`/`height` 参数）。
- **默认不发送 `response_format`**（配置 `imageGen.responseFormat` 可填 `b64_json` / `url` 强制）：新版 OpenAI（gpt-image-1）会因未知参数直接 400；两种响应形态适配器都吃（`url` 会走内置的 SSRF 防护下载后再落盘，不存会过期的临时链接）。
- **返回的图片格式不一定是 PNG**：智谱 CogView 回的就是 JPEG（2026-10-01 实测）。落库与「试画一张」
  的预览都按**字节魔数**判断格式（`src/core/image-type.js`），不看扩展名也不看 Content-Type。
- 提示词上限 800 字；生成的图落盘上限 8 MiB、只收 PNG/JPEG/GIF/WebP（与表情库同一道校验）。
- **生成成功即发送**（`autoSend`，默认 `true`）：图片同时存进表情库并直接发到当前会话；
  不想自动发送就把它设成 `false`，此时只入库，模型需要时用 `send_sticker` 发。
  单次调用传 `send:false` 可以只收藏这一次。不再依赖模型追加一次 `send_sticker`
  （模型漏掉第二步时用户收不到图，Issue #41）。控制台在「图片生成」区块有同名勾选框。
- 关闭时 `generate_image` 不进模型工具表、提示词也不提画图 —— 模型不会去调一个必然失败的工具。

## groupDigest：群日报（可选，默认关闭）

```json
{
  "groupDigest": {
    "enabled": true,
    "time": "09:30",
    "chats": ["group:123456"],
    "maxChars": 300
  }
}
```

- 每天到点把「过去 24 小时这个群聊了什么」汇总成一条，用机器人的人设口吻发到群里（只发白名单里的群）。
- 少于 5 条消息的群当天跳过；生成走 `purpose:'write'`，吃对应思考档位与 Token 节省上限。
- 手动触发/查看状态：`POST /api/group-digest/run`、`GET /api/group-digest/status`。

## adminBriefing：管理员早报（可选，默认关闭）

```json
{
  "adminBriefing": {
    "enabled": true,
    "time": "09:30",
    "chats": [],
    "maxChars": 300
  }
}
```

- 每天到点把「过去 24 小时群里的见闻」用机器人自己的口吻**私聊给全局管理员**（`admin.ownerUin`），
  不发群、也不是运行状态报告。
- `chats` 留空 = 所有当前可运行（active、未暂停、在活跃时段、白名单内）的群；也可以只挑几个群。
  最多读 12 个群、每群按小时分层抽样，不会只看到某个时间点的消息。
- 全部群加起来少于 5 条消息不打扰；当天成功发送后去重，重启不会重发；观察/暂停模式会延迟 30 分钟补跑
  （最多 8 次）。管理员 QQ 或私聊白名单没配好时不跑，绝不猜收件人。
- 手动触发/查看状态：`POST /api/admin-briefing/run`、`GET /api/admin-briefing/status`。

## dailyMoments：QQ 空间动态（可选，默认关闭）

```json
{
  "dailyMoments": {
    "enabled": true,
    "source": "self",
    "autoPublish": false,
    "hour": 23,
    "minute": 30,
    "scheduleWindows": null,
    "intervalDays": 1,
    "startupCatchup": true
  }
}
```

- `source`：`self`（默认）= 只写人设自己的观点/兴趣，不收集群聊；`group` = 从群聊候选瞬间取材；
  `mixed` = 人设为主，群聊素材至多点缀一句。`self` 的素材来自 `roles/interests.json` 的兴趣库与
  可选的公开资料搜索，并会与最近已发动态做大段查重；"我今天去了/吃了"这类没有现实素材的断言会被拦下。
- `autoPublish`：默认 `false`，定时只生成**草稿**，在控制台确认或编辑正文后才发布（编辑同样过事实边界
  检查）。改成 `true` 才会按时直接发；旧行为是 `source: "group"` + `autoPublish: true`。
- `hour` / `minute`：固定时刻模式，按上海时间；`scheduleWindows: [{ "start": "20:00", "end": "23:00", "count": 1 }]`
  可按窗口随机取点；`intervalDays` 控制间隔；`startupCatchup` 控制错过定时点后是否补一次。
- 发布走 SnowLuma `send_qzone_msg`，按日期记录幂等状态，重启不会重复发布结果不明的说说。
- 控制台「设置 → QQ 空间动态」：来源、发布方式、最近预览（带来源）、草稿编辑与“发布这份草稿”。

## onebot：WebSocket 心跳与「补课」回复窗口

```json
{
  "onebot": {
    "wsHeartbeat": "auto",
    "catchupReplyWindowMs": 1800000
  }
}
```

- `wsHeartbeat`：`auto`（默认）/ `on` / `off`。心跳（每 30 秒一个 WebSocket PING）用来发现
  "连接已经死了但事件还没到"的半开连接。**NapCat 收到 PING 会直接销毁连接**（客户端看到
  `close code=1006`、永远收不到 pong，Issue #22）——`auto` 在第一次遇到这种对端后就不再发送，
  改由 close/error 事件发现断线；`on` 始终发送（老行为，适合会回 pong 的协议端）；
  `off` 从不发送。非法值按 `auto` 兜底。**改完重启生效**（连接只在启动时建立）。
  控制台「设置 → OneBot」里有同一个开关。
- `catchupReplyWindowMs`：断线或重启后从历史里补回的消息，超过这个时长只入库不回复，
  默认 30 分钟（`1800000`）；`0` = 一律只补记录、不唤醒模型。补课日志会把两个数分开写
  （「补进 5 条 —— 其中 2 条超过回复窗口，只补记录、不回复」），避免"补进来了却不回"看起来像故障。
  控制台同一处填分钟数；留空 = 不改动当前值。

## reminders：定时提醒（默认开启）

```json
{
  "reminders": {
    "enabled": true,
    "quiet": { "start": "23:30", "end": "08:00" }
  }
}
```

- 群友/私聊说「明天 9 点提醒我交作业」「30 分钟后提醒我」时，模型用 `remind` 工具把提醒
  **落盘**（`data/reminders.json`，重启不丢），到点主动唤醒、用它自己的口吻把事情说出来。
- **周期提醒**：`repeat` 传对象——每天 21:00 是 `{"kind":"daily","hour":21,"minute":0}`
  （只给 `hour` 时 `minute` 按 0）；每周五 18:30 是 `{"kind":"weekly","weekday":5,"hour":18,"minute":30}`；
  也可用 5 字段 cron：`{"kind":"cron","cron":"30 18 * * 5"}`（分 时 日 月 周；`*`/数字/列表/区间/步长，
  日与月只支持 `*`）。`tz` 指定 IANA 时区（如 `Asia/Shanghai`，默认跟随项目时区；跨 DST 按挂钟校正），
  `jitterMs`（0~3600000）用来错开整点。不传 `at`/`minutes` 时首次触发点按 `repeat` 规则算；
  到点后自动续下一期；机器人离线错过的多次触发**只补最近一次**，超过 12 小时的跳过。
- **免打扰**：配置里的 `reminders.quiet`（`start`/`end`，HH:MM）把落在窗口内的触发点顺延到窗口结束；
  周期提醒会把窗口存进条目本身，之后改全局配置不影响已建条目。
- **重复创建保护**：同一次机器人处理流程中，重复创建相同周期提醒会复用仍待执行的原任务，
  不再新增系列或占用名额；返回原任务 ID 和当前实际触发时间。不同会话、发起人、目标、周期或首次触发设置保持可区分。
  多人批次未指明发起人、同名多人或发起人无法核实时，保持原创建行为，避免误合并。
  新一轮请求和一次性提醒仍可独立创建；不自动合并历史任务，也不保证跨重启的创建去重。
- 是「A 让机器人提醒 B」时（"12 点提醒他吃饭"），提醒会带上归属（谁提的/提醒谁），
  到点说话时如实说出是谁请的；没记住归属时明确"有人托我提醒"，不会猜成被提醒人自己设的。
- 限制：单条 ≤200 字、最多设到 30 天后、单会话待触发 10 条 / 全局 50 条、
  离线导致迟到超 12 小时作废不补发；时间控制静默段到点的提醒会**顺延**到窗口恢复（不作废，静默多久都等）。
- **容量判定（#9）**：新增提醒时会先把「早已过期、还没被巡检标掉」的项标成 expired 再数名额，
  不会因为一堆早该作废的提醒而误报"满了"；全局满时文案是「全局提醒位已满（每人上限 10 条，共 50 条）」。
- `enabled: false` 后 `remind` 工具与到期派发都停（模型会答"定时提醒未启用"），已存数据保留。
- 控制台「设置 → 定时提醒」：开关、待触发列表（带周期标签）、最近完成（触发/取消/过期），可单条取消。

## groupGame：群游戏（实验性，默认关闭）

```json
{
  "groupGame": {
    "enabled": true,
    "chats": ["group:123456"],
    "allowPrivateInvite": true,
    "allowGamePrivateDm": false,
    "revealWords": true,
    "dailyLimitPerChat": 6,
    "maxDurationMin": 60,
    "discussSeconds": 120,
    "recruitSeconds": 45,
    "maxPlayers": 10,
    "roundSeconds": 0,
    "games": ["number-bomb", "undercover", "werewolf"]
  }
}
```

- `maxPlayers` 默认 10（**老实例的配置里没有这个键时，合并默认值后也是 10**；数字炸弹这类插件的自身上限
  更高，但名单只会在开局文案里体现，实际玩法不受影响）。`roundSeconds` 默认 0 = 用插件默认
  （狼人杀 90 秒、谁是卧底 150 秒）；讨论时长与单回合超时**小于 30 秒按 30 秒生效**。
- `maxDurationMin` 是单局时长上限，**与游戏自身的上限取较小值**（数字炸弹 20 分钟、谁是卧底 45 分钟、
  狼人杀 60 分钟）；设得比它们大不会延长。到点引擎自动结算。
- **报名制（默认开，45 秒）**：需要私聊的游戏（谁是卧底/狼人杀）开局先挂报名——想玩的在群里发一句
  「我玩」或「报名」，够 `minPlayers` 才发牌、发牌才发私聊。这样不会把只是在群里插句话的围观者
  拉进局并给他发身份私聊（2026-09-29 模拟发现：旧行为是"最近发过言的人"直接发牌）。
  `recruitSeconds: 0` = 关闭报名，回到"按最近发言者直接发牌"（**只有显式写 0 才是关闭**；键缺失或写 `null`/`""` 都按默认 45 秒）；
  模型显式给了 players（"就我们四个玩"）也跳过报名——名单里的重复项会被去重（同一个人写两遍不会拿两张身份）。
- **白天讨论有三个出口**（谁先到算谁）：①`discussSeconds`（固定讨论时长，秒；0=插件默认 120）到点进投票；
  ②**超过半数存活玩家**说「投吧 / 直接投」（不带目标）立刻开投；③所有人都发过言也立刻开投。
  「投 3」这种带目标的算投票（记票、切阶段保留），不算"想开投"。
- **默认白名单只有 `number-bomb` 和 `undercover`**：狼人杀默认**不在**白名单里（`games` 缺省时），
  想玩要把 `werewolf` 加进 `games` 或在控制台「设置 → 群游戏」勾选；不在名单里的游戏开局会被引擎直接拒。
- **三种游戏**：`number-bomb`（数字炸弹，全公开；每人每局只会收到一次"越界"提醒——区间变化后也不会再提醒，防刷屏）、
  `undercover`（谁是卧底，开局私聊发词；另有出局/退出各一条私聊）、
  `werewolf`（狼人杀，6~9 人：**整局都靠私聊**——夜里私聊提交刀/守/查/女巫用药，白天在群里讨论投票）。
- **狼人杀角色（按人数自动配）**：6 人 = 2 狼 / 1 预言家 / 1 女巫 / 2 民（无守卫）；7 人起加守卫；
  9 人 3 狼。**女巫**两瓶药各一次：解药救今晚被刀的人、毒药毒一个人，**一晚最多用一瓶**（后说的覆盖先说的）、
  **不能自救**；狼刀定下后引擎才私聊问她（提示里写清"今晚被刀的是 X"），此时狼再改刀会被拒；
  **守卫守的人与女巫救的人是同一个 → 仍然出局（同守同救必死）**，只守不救 / 只救不守照常活。
- **私聊怎么发得出去（两条路，任选其一）**：
  ① 把想玩的人加进 `allow.private`（推荐顺手加好友，最稳）；
  ② 打开 `allowGamePrivateDm`（默认关）——**游戏期间私聊豁免**：引擎发给"本局在册玩家"的私聊
  不再要求对方在白名单里（报名=同意接收），只在局内、失败不重试、内容全部是引擎文本；
  模型自己发的消息（send_message / send_voice）**永远**受 `allow.private` 约束，`deny.private` 始终优先。
  谁是卧底只有发词一条私聊；狼人杀人均 3~6 条，没 ① 或 ② 时只有白名单里的人收得到（开局会把失败人数报给模型）。
- 开局名单缺省=最近发过言的群友（上限 `maxPlayers`）；但**需要私聊的游戏（谁是卧底/狼人杀）默认先走报名制**
  （`recruitSeconds`，默认 45 秒），只有 `recruitSeconds: 0` 或数字炸弹这类不需要私聊的游戏才直接按名单发牌。
  模型可以用 `group_game` 的 `players` 参数
  锁定名单，传 QQ 号或**群名片**都行（名片要一字不差，且必须最近发过言——这是防提示注入把词发给任意 QQ 的硬门）。

- 主持人由模型担任（氛围/解说），**轮次、计票与判定由状态机负责**（`src/features/group-game.js`）：
  数字炸弹（1~100 猜数，谁踩中谁输）、谁是卧底（4~10 人，词只走私聊，公开摘要不含身份）。
- 白名单制、每群同时一局、每天每群有开局上限；进行中的局落盘 `data/games.json`，重启可恢复，超时自动收尾；
  终局播报发送失败会挂起重试、不丢局（送达前局不会被删）。
- `allowPrivateInvite`：卧底发词必须开（只发给报名者、每人每局一条、失败不重试）；默认关。
- 控制台入口：**设置 → 群游戏**（启停开关在「设置 → 实验功能」）。开局：群里说「来个数字炸弹 / 谁是卧底」。

## conversation：回复行为（可选，默认开启）

```json
{
  "conversation": {
    "replyGuardEnabled": true,
    "pokeReplyEnabled": true
  }
}
```

- `replyGuardEnabled`：私聊、被 @、引用机器人或点名时，模型写了正文却没调用发送工具，
  会做一次纠正；仍未发送就发一条固定说明。默认开，关掉后退回只靠提示词。
- `pokeReplyEnabled`：拍一拍机器人算直接互动（档位必回、自主节奏即时处理、降级闸门与回复纠正都覆盖）。
  默认开；关掉后拍一拍按普通群消息处理，群友之间互拍不受影响。
- 控制台入口：设置 → 聊天设置 →「所有模式 · 回复行为」。

## pacing：自主节奏（实验性，默认关闭）

```json
{
  "pacing": {
    "enabled": false,
    "scope": "group",
    "instantOnMention": true,
    "defaultWakeMinutes": 20,
    "minWakeMinutes": 5,
    "maxSilenceMinutes": 45
  }
}
```

开启后消息不再即时触发，模型按自己安排的节奏醒来统一处理；私聊永远即时，
`instantOnMention` 保证被 @（以及算直接互动的拍一拍，见 `conversation.pokeReplyEnabled`）时立刻响应。
适合"不想每条都秒回"的场景，建议先小范围试。

控制台「设置 → 聊天设置」有开关与四个节奏参数（默认醒来间隔、最短间隔、最长沉默、被 @ 即时）。
`scope` 目前只在配置文件里可调：私聊永远即时，所以 `all` 与 `group` 在当前只有群聊与私聊两种
会话时效果一致，控制台不暴露这个选项。

## store：会话数据与磁盘写入（可选）

```json
{
  "store": {
    "maxMessagesPerChat": 0,
    "keepSessionFiles": 2000,
    "sessionPersistMs": 10000,
    "sqliteSynchronous": "FULL"
  }
}
```

- `blacklistKeywords`：消息关键词黑名单（每项一条，最多 100 条）。普通文字大小写不敏感
  包含匹配；以 `re:` 开头启用受限正则：最多一个 `*`/`+`/`{n,}`，所有变长量词（含 `?`、
  `{n,m}`）的组合预算不超过 200，单项最多 160 字符，禁止断言/反向引用/嵌套重复，
  且只匹配消息前 2000 字。命中的消息在入口直接丢弃，不入库、不触发模型；黑名单优先于
  `keywords`。手改配置时非法规则会在加载阶段被丢弃并打印一次告警，控制台保存会直接 400。
- `maxMessagesPerChat`：每个会话最多保留的消息条数，`0` = 不限；只清理已处理完的历史，
  不会删待处理或结果未知的消息。新上限保存后即时生效，已有超限历史从下一次写入起清理。
- `keepSessionFiles`：`data/sessions` 审计文件保留条数，`0` = 不限；重启后生效。
- `sessionPersistMs`：运行中会话 JSON 的落盘间隔，默认 10 秒（2~60 秒）。会话文件包含完整
  提示词与记录，间隔越小崩溃时丢的进度越少，但磁盘写入越多。
- `sqliteSynchronous`：`messages.sqlite` 的同步级别。默认 `FULL`（每条提交等落盘）；
  小云盘 IOPS 紧张时可设 `NORMAL`——WAL 下仍保证崩溃一致性，但掉电可能丢最近几条提交。
- 控制台默认只让用户选三个档位：均衡（10 秒 / FULL）、省 IO（30 秒 / NORMAL）、
  最省 IO（60 秒 / NORMAL）。手改过配置、不在这三档里的值会显示为「自定义」；选中「自定义」
  才会展开毫秒数与同步级别的输入框，普通用户不必碰。
- 控制台入口：设置 → 聊天设置 → 数据保留。除审计文件条数外均即时生效。

## tokenSaver：Token 节省模式

```json
{
  "tokenSaver": { "mode": "balanced" }
}
```

- `mode`：`off`（默认）/ `balanced`（省）/ `aggressive`（很省）。控制台在「设置 -> Token 节省」，带"你的设置 / 当前生效"对照表。
- 语义：**只夹上限，不改写** `store.atCount` / `api.maxRounds` 这些用户值；关掉立刻回到原设置（`off` 与升级前一致；手改成负数这类坏值时会按默认值处理，不再原样传下去）。
- 被夹的项：上下文档位条数（被艾特/关键词/随机/全响应）、单次运行工具轮数与累计 Token、
  会话交接与全局印象注入的字符上限、系统提示里的表情清单条数。
- 有一处例外：每日动态（说说）另有一条提示词组装路径，它自己取交接与印象，不吃上面那两个字符上限
  （那条路径有自己的 `maxPromptChars` 预算兜底）。
- 改不动的部分：每次模型调用的固定底（系统提示 + 工具定义）约 1.2 万-1.5 万 token。

## plugins：插件（第三方扩展，默认全关）

```json
{
  "plugins": {
    "enabled": true,
    "enabledIds": ["weather"],
    "requireIsolation": true,
    "networkIsolation": true,
    "requireNetworkIsolation": false,
    "lazy": true,
    "idleMinutes": 15,
    "toolMounting": "meta",
    "limits": { "memoryMb": 128, "callsPerMinute": 120 },
    "publishers": {},
    "revoked": [],
    "indexUrls": [],
    "indexUrl": "https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plugins/main/plugins/index.json",
    "mirrorPrefixes": null,
    "settings": { "weather": { "defaultCity": "上海" } }
  }
}
```

契约、协议与信任声明见 `docs/PLUGINS.md`，这里只说配置形状：

- `enabled`：总开关，**默认 `false`**（一个插件都不加载，落地没有任何副作用）。
- `enabledIds`：**显式授权清单**，默认空 = 装了也不跑。控制台「插件」页里的「启用/停用」改的就是它。
- `requireIsolation`：默认 `true` = 本机 Node 不支持权限模型时**拒绝加载**（没有隔离就不执行第三方
  代码）；控制台与巡检会把"没有隔离"这件事说明白。改成 `false` 是明确接受没有隔离。
- `indexUrls`：**额外的索引来源**（数组，配置顺序即优先级：同一个 id 只取最靠前那份）。
  想加第三方索引就往这里追加。
- `mirrorPrefixes`：取**包**时的镜像前缀（默认用内置的几个；空数组＝只用原始地址）。
  **索引不走镜像**（索引是信任根，被第三方换掉的话 sha256 也救不了你）；包走镜像则是安全的
  —— 先按索引里的 sha256 校验再换入，最多是"取不到"。
- `indexUrl`：单条索引地址（默认官方索引，住在独立仓库 `qq-agent-plugins`）。它等价于 `indexUrls` 里排在最后的一项；
  两个都留空 = 完全不看索引（控制台那一栏会说清"没有配置来源"，手动填地址仍然可用）。
  拉取走 safe-fetch：HTTPS 优先 HTTP/2、失败回落 HTTP/1.1；内网地址被拦、有体积与超时上限。官方索引先从 `raw.githubusercontent.com` 取，
  该地址请求失败（超时或非 200，国内常见超时）时自动改用 GitHub Contents API 的 raw 媒体类型——
  仍然是 GitHub 自己的地址，不经过第三方 CDN。
- `networkIsolation`：Linux 上把插件进程放进**没有网络接口**的命名空间（默认开，有就用）；
  做不到的平台（Windows/macOS）控制台会明说"网络未隔离"。`requireNetworkIsolation: true` 是严格档：
  本机做不到就**拒绝加载插件**（默认关 —— 打开等于在那些平台禁用整个插件生态）。
  控制台入口：「设置 → 平台能力 → 插件宿主（高级）」，保存后即时重排插件进程。
- `lazy` / `idleMinutes`：懒启动（默认开、空闲 15 分钟停）。只有工具、不观察消息也不起周期任务的
  插件按需起进程；声明了 `observe`/`schedule` 的插件常驻（否则消息与周期会静默失效）。
- `toolMounting`：插件工具怎么给模型。默认 `meta`（只挂一个 `plugin_call`，里面列出可用的插件工具
  —— 每轮提示词不随插件数增长）；`direct` 是每个插件工具各挂一个。插件**声明了 `send` 能力**时
  安装界面会明确标出"能代机器人发言"，那条发言走的是机器人自己的发送队列（禁言/限频/白名单/记账全在）。
- `limits`：宿主强制的资源上限 —— `memoryMb`（堆上限 + 常驻超限就重启）、`callsPerMinute`
  （工具调用每分钟上限，防模型连调打爆宿主；周期任务不受此限）。
- `publishers`：`{ "<发布者名>": "<Ed25519 公钥>" }`。登记后，该发布者的包必须带签名且验得过才许装。
- `revoked`：撤回名单，`"id"` 撤全部版本、`"id@1.2.3"` 只撤那个版本；命中的插件不加载但列表里可见。
- `settings.<id>`：给单个插件的配置段。插件通过 `cap.config.get` **只能读到自己的这一段**
  （密钥填这里，别写进插件代码 —— 代码是最容易被转发的部分）。

装完在 `plugin-data/<id>/install.json` 会留一份来源记录（从哪个索引/地址装的、哪一份 sha256、
什么版本、什么时候装的），控制台「已装」里能看到；卸载插件**不会**删掉它和 `plugin-data/`。

## messageTypes：消息类型（要不要读这类消息）

```json
{
  "messageTypes": { "expandForward": false, "videoFrames": true, "images": true, "stickers": false }
}
```

- 控制台在「设置 -> 消息类型」。四个开关都**默认开**（即升级前的老行为，不会因为升级改变现有实例的表现）。
- 语义：只是决定这类内容**进不进提示词/进不进模型**；消息本身照常进聊天记录。
  注意合并转发那条：**展开后的文本就是存档里的那一行**，关掉后存档（以及控制台里的显示与搜索）
  留下的是占位符，内容要等模型按需 `read_forward` 之后才补进去。
- `expandForward`：入站是否自动展开「合并转发 / 聊天记录卡片」。关掉后正文只留一行占位符
  （`[合并转发聊天记录]` / `[卡片聊天记录 …]`），模型需要时自己调 `read_forward` 展开；
  **被 @ 的那条仍然自动展开**。一条 20 条的记录展开后是几千字符，而且会跟着进存档和之后每一轮的上下文 ——
  群多、转发频繁时这是最值得关的一项。
- `videoFrames`：是否查看视频画面（`get_message_images` 抽 4 帧拼 2×2）。关掉后视频只剩声音
  （`get_message_audio` 转写），省一次抽帧与一次视觉调用；提示词会同步改成"你只能拿到声音"。
  **画面依赖 `images`**：`images: false` 时这个工具被摘掉，`videoFrames` 再怎么设也看不到画面。
- `images`：是否查看消息里发来的图片与表情包。关掉后 `get_message_images` 从工具表摘掉，
  提示词改成"看不到图片内容"，消息本身照常存档。**视频画面也依赖这个工具**，所以关掉后
  视频只保留声音。表情包的**自动收藏**由 `sticker.collectEnabled` 单独控制，不受这里影响。
- `stickers`：是否查看表情库里没备注的图。关掉后 `get_sticker_image` 从工具表摘掉；
  按备注名发送表情（`send_sticker`）不受影响。
- 以上两项叠加在 `api.vision`（「设置 -> 模型 API」的「图片输入」）之上：模型本身不能看图时，
  这些开关没有意义，相关工具一律摘掉；`read_image_text`（QQ 服务端 OCR，只取文字）不受影响。

## 安全提示

- `config.json` 含 API Key、控制台 Token、OneBot Token，不要提交、不要外发；
- 控制台 Token 可在 `设置 -> 系统 -> 控制台安全` 中轮换；
- 换模型时先确认 `vision`、`contextWindowTokens`、`maxRunTokens` 三项与模型能力一致，
  否则会出现"图片被当成文本"或"上下文被过早裁剪"。

## personaPerChat：按群人设（可选）

```json
{
  "personaPerChat": {
    "group:100200301": { "templateId": "maoniang" },
    "group:100200302": { "templateId": "duzui_sunyou", "customRules": "这个群人比较正经，少开玩笑" },
    "private:700000001": { "roleText": "你是一只看门狗。", "behaviorProfile": "legacy" }
  }
}
```

- 键：`group:<群号>` / `private:<QQ>`；**不配 = 跟随全局 `persona`**（升级行为不变）。
- 可覆盖字段：`templateId`（内置卡 id：正文与档位以 `roles/*.md` 为准）、`roleText`（自定义正文，不绑卡时使用）、
  `botName`、`selfNickname`、`behaviorProfile`、`participation`、`customRules`。
- 控制台入口：设置 → 人设 →「按群人设」。白名单里的每个会话一行，选一张卡即可；选「跟随全局」即删除该行。
- **人物记忆是全局的**：同一个群友在不同群共用一份印象，只是每个群用哪套口吻不同。
- 群昵称是账号级的，无法按群不同；能按群改的展示名是群名片（`set_group_card`，平台能力里默认关）。

### 安全规则在哪里改（常被问）

系统提示里的**【安全规则（最高优先级，不可违反）】**是**写死在源码里的**：
`src/llm/prompt.js` 里那个 `securityRules()` 函数，由同文件的 `buildSystemPrompt` 注入 ——
**安全规则 ＞ 管理员附加规则 ＞ 角色卡正文 ＞ 平台默认风格**（行的先后顺序就是优先级）。
控制台**没有**、也不打算开一个改安全规则的口子：那是"群友忽悠模型放开限制"的第一道防线。

要给这台机器人加自己的规矩，走**管理员附加规则**：控制台 `设置 -> 人设` 里的那个文本框
（`persona.customRules`，上限 4000 字；人设卡库里的每张卡也可以各带一份）。
它排在安全规则**之下**、角色卡正文**之上** —— 想压过平台默认风格（助手腔过滤、发言节奏那些）
就写在这里。好友动态/说说另有自己的一套【安全边界】，在
`src/llm/qzone-interaction-prompt.js`。

改安全规则本身只能改源码，并且要同步两处用例：`test/personas.test.mjs` 断言每张内置卡的
提示词里都有【安全规则（最高优先级，不可违反）】这一段，`test/admin-identity.test.mjs`
断言它排在【优先级】说明之后。改完跑 `npm run lint` 与 `node --test test/*.test.mjs`。
