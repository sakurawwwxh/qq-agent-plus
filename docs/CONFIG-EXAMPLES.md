# 配置示例（本分支新增项）

配置写在数据目录的 `config.json`（默认 `data/config.json`，含密钥，已被 Git 忽略）。
下面是本分支新增或调整过的键，其余键保持上游默认即可。

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
  就覆盖全局 `thinking`；没配的家用全局。控制台 → 设置 → 高级选项里点档位条保存后自动写入。
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

- `enabled`：冷场时按概率主动开话题（控制台「设置 → 主动开话题」第一条），只管这一条链路。
- `followUpEnabled`：说完话没人接话时补一句（约 10 分钟后给一次机会）。与控制台同名的复选框对应。
- `selfWakeEnabled`：允许模型用 `schedule_wake` 给自己安排稍后的主动发言；关掉后该工具会从工具列表里摘掉。
- 这两项**独立于 `enabled`**，默认 `true`（与引入开关之前的行为一致）。想让它完全不主动开口，三个都要关；
  只想关掉"补话"或"自安排唤醒"的，各关各的。
- `activeHours.windows`：生效时段，窗口外不开口，也不消耗间隔；`24:00` 表示到当天结束（补话与自安排唤醒同样受这个窗口约束）。
- `idleThresholdMs`：群里安静这么久才考虑开口。
- `probability`：每次判定开口的概率。
- 冷场判定（`idleThresholdMs`）的时间会落盘：重启后不足一个间隔会跳过（避免"重启一次多一次判定"）。
  补话的 20 分钟节流**只在内存里**，重启后从零算，可能比预期多补一次（2026-09-26 审查发现文档与实现不一致）。
- 上面示例里的数值是**示例**、不是出厂默认：出厂 `checkIntervalMinMs` 1800000（30 分钟）、
  `checkIntervalMaxMs` 5400000（90 分钟）、`idleThresholdMs` 1800000（30 分钟）、`probability` 0.25；
  照抄示例会改变行为。

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

- `provider` 可选：`bing`（默认，抓 `cn.bing.com` 页面，不需要 Key）、`deepseek`、`zhipu`、`bocha`、
  `baidu`、`metaso`、`doubao`、`tavily`、`aggregate`（控制台「设置 → 搜索」里选）。
- 每家一套 `{ apiKey, baseUrl, count, timeoutMs }`（`deepseek` 用 `model` 代替 `count`；
  `zhipu` 另有 `engine`、`tavily` 另有 `searchDepth`）；`apiKey` 留空时回退各自的环境变量：`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `BOCHA_API_KEY` /
  `BAIDU_SEARCH_API_KEY` / `METASO_API_KEY` / `DOUBAO_SEARCH_API_KEY` / `TAVILY_API_KEY`。
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
  2000 字。环境不同、角色取向不同时按自己的口味填一段即可，改完即时生效、不用重启；自动收藏与
  聊天里主动收藏共用这一份标准。
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
    "consolidateMinIntervalMs": 21600000,
    "useChatModel": true,
    "visibility": {
      "mode": "global",
      "hidePrivateInGroup": false
    }
  }
}
```

- `visibility.mode`：`global`（默认，＝历史行为）＝所有会话观察到的印象都会注入提示词、
  也都会被 `memory_query` 返回；`perChat` ＝只注入/返回「来源含当前会话」的印象
  （印象按条记录来源，切到 perChat 后，群里看不到来自别的群与私聊的印象）。
  **两个字段的默认值与历史完全一致，切换是需要显式操作的运营决定。**
- `visibility.hidePrivateInGroup`：`true` 时**群聊里**不注入/返回来源含 `private:<QQ>` 的印象
  （私聊里照常可见）——适合"不想让人觉得机器人把私聊内容带进群"的运营者。
- 控制台「设置 → 记忆整理」有同样两个控件（下拉 + 勾选框），保存即生效，无需重启。
- 控制台的人物记忆页不受影响：你始终能看到全部印象与来源；「来源」不交给模型
  （`memory_query` 返回前会剥掉 `sourceChatKeys`）。
- 记忆整理的其他字段（冷却时间、发现新人的门槛、专用模型）都在同一设置页里，逐个有提示。

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

- **四种适配器**（按 `provider` 分发，`src/llm/tts.js`）：
  `openai`（兼容 `POST {baseUrl}/audio/speech`，硅基流动/OpenAI/自建，**已实测**）、
  `volc`（火山引擎语音合成 **v1** HTTP，需要数字 `appId` + `apiKey`=Access Token，`cluster` 默认 `volcano_tts`、
  复刻音色自动切 `volcano_icl`（见下文「火山的两套凭据不一样，别混」），
  音色如 `BV001_streaming`；老接口，账号没开通 v1 服务时会固定报 3001）、
  `doubao`（火山引擎**豆包大模型语音合成 2.0**，`https://openspeech.bytedance.com/api/v3/tts/unidirectional`，
  只填 `apiKey`（控制台密钥，走 `X-Api-Key`）与 `voice`，`resourceId` 默认 `seed-tts-2.0`；
  **2026-09-28 用真实账号实测**：音频/语速/音量/格式/错误码都核过，自然度明显高于 v1 与硅基流动）、
  `minimax`（T2A v2，需要 `apiKey` + `groupId`，音色如 `female-shaonv`，音频是 hex 编码、适配器已处理）。
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

- 与 `asr` 对称但**默认关**。
- **服务预设**：控制台「设置 → 语音回复」有预设下拉（硅基流动 / OpenAI 官方 / 火山 v1 / 豆包 2.0 / MiniMax / 自定义），
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
    "maxPerHour": 6
  }
}
```

- 作用：群友说「画一张」时模型调 `generate_image`（OpenAI 兼容的 `POST {baseUrl}/images/generations`），
  生成的图**直接存进表情库**、再用现成的 `send_sticker` 发出去。控制台在「设置 → 语音转文字」页下方的
  「图片生成」区块（与语音回复同页），有「试画一张」当场验证配置。
- **服务预设**：控制台下拉里预置了「去哪儿拿免费的图模型」，选中会自动填好地址与默认模型（表在
  `src/llm/image-gen-presets.js`）：

  | 预设 | 地址 | 要不要 Key | 说明 |
  | --- | --- | --- | --- |
  | Pollinations | `https://image.pollinations.ai` | **不用** | 免注册免 Key，零成本开箱可用；第三方公共服务，**按 IP 限流**（官方口径匿名档 15 秒 1 次，2026-10-01 查阅）、**图片带它的水印**、提示词会经过它。额度用完返回空的 402 —— 当"试玩"，长期用换有免费额度的图模型 |
  | 智谱 CogView-3-Flash | `https://open.bigmodel.cn/api/paas/v4` | 要（免费档） | 2026-10-01 真机实测：8~9 秒出一张 1024×1024（约 100 KB）；是否仍免费以智谱定价页为准。出图**右下角带「AI 生成」水印** —— 国内厂商按《人工智能生成合成内容标识办法》都要打，介意水印只能换海外服务商 |
  | 硅基流动 | `https://api.siliconflow.cn/v1` | 要 | 到「模型广场」挑标了**免费**的图模型填进「模型」栏 |
  | 魔搭 ModelScope | `https://api-inference.modelscope.cn/v1` | 要 Token | 按公开口径有每日免费额度（以官网为准） |
  | 自定义 / 自建 | 自己填 | 要 | 任何 OpenAI 兼容的 `/images/generations` |

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
- 少于 5 条消息的群当天跳过；生成走 `purpose:'write'`，吃对应思考档位与省 Token 上限。
- 手动触发/查看状态：`POST /api/group-digest/run`、`GET /api/group-digest/status`。

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
  "reminders": { "enabled": true }
}
```

- 群友/私聊说「明天 9 点提醒我交作业」「30 分钟后提醒我」时，模型用 `remind` 工具把提醒
  **落盘**（`data/reminders.json`，重启不丢），到点主动唤醒、用它自己的口吻把事情说出来。
- 是「A 让机器人提醒 B」时（"12 点提醒他吃饭"），提醒会带上归属（谁提的/提醒谁），
  到点说话时如实说出是谁请的；没记住归属时明确"有人托我提醒"，不会猜成被提醒人自己设的。
- 限制：单条 ≤200 字、最多设到 30 天后、单会话待触发 10 条 / 全局 50 条、
  离线导致迟到超 12 小时作废不补发。
- **容量判定（#9）**：新增提醒时会先把「早已过期、还没被巡检标掉」的项标成 expired 再数名额，
  不会因为一堆早该作废的提醒而误报"满了"；全局满时文案是「全局提醒位已满（每人上限 10 条，共 50 条）」。
- `enabled: false` 后 `remind` 工具与到期派发都停（模型会答"定时提醒未启用"），已存数据保留。
- 控制台「设置 → 定时提醒」：开关、待触发列表、最近完成（触发/取消/过期），可单条取消。

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
- 白名单制、每群同时一局、每天每群有开局上限；进行中的局落盘 `data/games.json`，重启可恢复，超时自动收尾。
- `allowPrivateInvite`：卧底发词必须开（只发给报名者、每人每局一条、失败不重试）；默认关。
- 控制台入口：**设置 → 群游戏**（启停开关在「设置 → 实验功能」）。开局：群里说「来个数字炸弹 / 谁是卧底」。

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
`instantOnMention` 保证被 @ 时立刻响应。适合"不想每条都秒回"的场景，建议先小范围试。

## tokenSaver：省 Token 模式

```json
{
  "tokenSaver": { "mode": "balanced" }
}
```

- `mode`：`off`（默认）/ `balanced`（省）/ `aggressive`（很省）。控制台在「设置 -> 省 Token」，带"你的设置 / 当前生效"对照表。
- 语义：**只夹上限，不改写** `store.atCount` / `api.maxRounds` 这些用户值；关掉立刻回到原设置（`off` 与升级前一致；手改成负数这类坏值时会按默认值处理，不再原样传下去）。
- 被夹的项：上下文档位条数（被艾特/关键词/随机/全响应）、单次运行工具轮数与累计 Token、
  会话交接与全局印象注入的字符上限、系统提示里的表情清单条数。
- 有一处例外：每日动态（说说）另有一条提示词组装路径，它自己取交接与印象，不吃上面那两个字符上限
  （那条路径有自己的 `maxPromptChars` 预算兜底）。
- 改不动的部分：每次模型调用的固定底（系统提示 + 工具定义）约 1.2 万-1.5 万 token。

## 安全提示

- `config.json` 含 API Key、控制台 Token、OneBot Token，不要提交、不要外发；
- 控制台 Token 可在 `设置 -> 系统 -> 控制台安全` 中轮换；
- 换模型时先确认 `vision`、`contextWindowTokens`、`maxRunTokens` 三项与模型能力一致，
  否则会出现"图片被当成文本"或"上下文被过早裁剪"。

### 安全规则在哪里改（常被问）

系统提示里的**【安全规则（最高优先级，不可违反）】**是**写死在源码里的**：
`src/llm/prompt.js` 里那个 `securityRules()` 函数，由同文件的 `buildSystemPrompt` 注入 ——
**安全规则 ＞ 管理员附加规则 ＞ 角色卡正文 ＞ 平台默认风格**（行的先后顺序就是优先级）。
控制台**没有**、也不打算开一个改安全规则的口子：那是"群友忽悠模型放开限制"的第一道防线。

要给这台机器人加自己的规矩，走**管理员附加规则**：控制台 `设置 -> 人设` 里的那个文本框
（`persona.customRules`，上限 4000 字；人设卡库里的每张卡也可以各带一份）。
它排在安全规则**之下**、角色卡正文**之上** —— 想压过平台默认风格（反 AI 味、发言节奏那些）
就写在这里。好友动态/说说另有自己的一套【安全边界】，在
`src/llm/qzone-interaction-prompt.js`。

改安全规则本身只能改源码，并且要同步两处用例：`test/personas.test.mjs` 断言每张内置卡的
提示词里都有【安全规则（最高优先级，不可违反）】这一段，`test/admin-identity.test.mjs`
断言它排在【优先级】说明之后。改完跑 `npm run lint` 与 `node --test test/*.test.mjs`。
