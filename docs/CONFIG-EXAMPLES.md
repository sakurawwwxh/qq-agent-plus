# 配置示例（本分支新增项）

配置写在数据目录的 `config.json`（默认 `data/config.json`，含密钥，已被 Git 忽略）。
下面是本分支新增或调整过的键，其余键保持上游默认即可。

## api.thinking：按用途控制思考模式

```json
{
  "api": {
    "thinking": { "chat": "off", "default": "on" }
  }
}
```

- `chat`：聊天场景是否带思考（`off` 降低延迟与成本；部分模型忽略该字段，行为不受影响）。
- `default`：判断、写作等其余用途；`on` 保留思考。

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
- 判定时间会落盘，重启后不足一个间隔会跳过（避免"重启一次多一次判定"）。

## sticker：表情包

```json
{
  "sticker": {
    "enabled": true,
    "promptMaxStickers": 10,
    "collectEnabled": true,
    "autoCollect": true,
    "maxCollectPerHour": 10,
    "encourage": 3
  }
}
```

- `promptMaxStickers`：系统提示里常驻的可用表情条数（10/20/30/45/60 五档，在控制台
  「设置 → 聊天设置 → 所有模式 · 表情包」下拉选择）。清单一半按使用频次取常用的，一半留给没用过/很久没用的
  （发掉一张换下一张顶上来）；档位越大能选的范围越宽，代价是每轮提示词更长。库容量与此无关：
  收藏表情同步一律拉 500 条，全在库里；手改配置写成 1~60 以外的数会在保存/渲染时落到边界档。
- `autoCollect`：别人发来的表情包是否自动入库（同图只存一次，`maxCollectPerHour` 限频）。
- `encourage`：鼓励使用表情的力度（0-3），太频繁可调回 1-2。

## asr：语音转文字（可选，默认开启）

```json
{
  "asr": {
    "enabled": true,
    "provider": "volc",
    "maxPerHour": 12,
    "apiKey": "",
    "baseUrl": "",
    "model": "",
    "language": "",
    "localBin": "",
    "localModel": ""
  }
}
```

- 作用：把消息里的语音、音频文件、视频音轨转成文字再交给聊天模型 —— 与模型是否多模态无关。
  控制台「设置 → 语音转文字」有同一组开关与字段。
- **识别服务可换**（`provider`），与「搜索服务」完全独立 —— 不必是同一家、也不必是同一个账号：

  | provider | 说明 | 需要什么 |
  | --- | --- | --- |
  | `local`（**默认**） | 本机 **whisper.cpp**：不联网、不要 Key、无按量费用、音频不出机器 | 跑一次 `node scripts/install-asr-local.mjs`（自动构建 + 下模型，默认落 `<数据目录>/asr/` 并写回配置） |
  | `volc` | 火山引擎语音技术的**大模型录音识别（Seed-ASR）**，WebSocket，按量计费 | `apiKey`（语音技术控制台创建；也可用环境变量 `ASR_API_KEY`） |
  | `openai` | **任意 OpenAI 兼容**的转写服务：`POST {baseUrl}/audio/transcriptions` | `apiKey` + `baseUrl`（到 `/v1` 那层）+ `model` |

- 本机转写的路径解析：`asr.localModel` / `asr.localBin` > 环境变量 `WHISPER_MODEL` / `WHISPER_BIN` >
  自动找（`<数据目录>/asr/`、仓库 `models/`、`~/.cache/whisper.cpp/`；二进制按 `whisper-cli` → `whisper-cpp` → `main`）。
  所以装完脚本后**什么都不用填**，控制台里也会显示"当前会自动用哪两个路径"。
- **免费选项**（都走 `openai` 那支；控制台里选一下「服务预设」就会把地址与模型填好，你只需粘一个该服务的 Key。
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
- `apiKey` 与"存它时的 provider"绑定（`apiKeyProvider`）：换了识别服务后旧 Key 不会被发到新服务，
  控制台会提示重新填一次。环境变量 `ASR_API_KEY` 不受此限（它是部署级的单一值）。
- `language` 可选（`zh` / `en`…），留空由服务自己判；`maxPerHour` 是每小时最多转写几次的硬闸门
  （跨会话共享，默认 12，非正数按 12 处理）。
- 需要服务器上有 `ffmpeg`；单条音频上限 15 分钟，超长会直接报错不转写。

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
