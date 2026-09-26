# 本地回归测试（test/local）

这些用例不依赖任何真实服务（不连 OneBot、不发消息），用桩对象直接调用 `src/` 里的模块，
用来复现和验证几处"只在线上才炸"的问题。跑完即退出，失败时退出码非 0。

## 怎么跑

需要一个 node：部署自带的 `.runtime/node-*/bin/node`，或系统里 **node >= 22.13**（见 `package.json` 的 `engines`）。

在仓库根目录执行：

```bash
T=$(mktemp -d)
QQ_AGENT_DATA_DIR=$T node test/local/test-sender-retry.mjs
```

**必须用临时 QQ_AGENT_DATA_DIR**：下表中标记"需要 DATA_DIR"的用例都要一个可写的数据目录
（其中两个会 seed 一份放行的 `config.json`，`src/core/access.js` 的 `assertCanSend` 才不拦发送；
`test-send-tools.mjs` 会往里复制表情名表），指向生产目录会覆盖线上配置。
最简单的写法就是上面那两行：先 `mktemp -d`，再带上 `QQ_AGENT_DATA_DIR=$T`。

## 用例一览

| 文件 | 验证什么 | 需要 DATA_DIR | 耗时 |
| --- | --- | --- | --- |
| `test-sender-retry.mjs` | 发送走网络层错误（`fetch failed`）时重试一次；限频等非网络错误不重试；连续失败最多重试一次 | 是（写 config.json） | < 2 秒 |
| `test-qzone-backoff.mjs` | 空间互动接口连续失败时指数退避（假时钟）：首轮失败只尝试一次、退避 2 分钟 → 4 分钟翻倍、连续故障只报一条日志 | 是（写 config.json） | < 2 秒 |
| `test-qzone-intervals.mjs` | 巡检节奏（假时钟把 24 小时压到毫秒）：好友动态 24 小时 / 评论回复 2 小时各自到点才跑、没到点的接口一次不调、没有新内容不调模型、失败只重试一次并退避 2→4 分钟、活跃时段外排到时段开始 | 是（写 config.json） | < 2 秒 |
| `test-send-tools.mjs` | 工具层发送不再抛 "is not defined"，`replyToMessageId` 的 `#` 被归一化后透传给 sender | 是（写临时目录） | < 2 秒 |
| `test-inline-fallback.mjs` | 内联工具调用兜底：4 种文本格式能解析、普通文本不误判；关系/身份/每日说说/空间互动都认内联提交 | 建议设（被 import 的模块会读 config.json；用例本身不写数据目录，只写 `/tmp/qz-behavior/`） | < 2 秒 |
| `test-sticker-lookup.mjs` | `findSticker` 的模糊兜底：id、备注原文、备注半句、模糊词都能命中，空串/不存在不误命中 | 否 | < 1 秒 |
| `test-qzone-reply-fallback.mjs` | 动态互动的"回复"半边：自己的动态列表被限流（retcode=100）时不整轮抛错，改走"已关注动态 + Cookie 详情"兜底 | 是（写 config.json） | < 2 秒 |
| `test-thinking-toolchoice.mjs` | 思考模式下强制 `tool_choice` 会 400：要自动降级成"允许模型自选"而不是整次失败 | 是（写 config.json） | < 2 秒 |
| `test-card-segments.mjs` | 分享卡片（json / xml 段）解析成可读文本，并标注"自己的动态" | 否 | < 1 秒 |

## 可选用例依赖

- `test-send-tools.mjs`：可选 `QQ_AGENT_FACE_NAMES_SRC=/path/to/data`，把真实的
  `face-names.json` / `face-names-extra.json` 复制进临时目录，让 `send_face` 用真实表情名；
  不设也能跑（表情名表缺失时工具会报"找不到表情"之类的正常提示）。
- `test-inline-fallback.mjs` 会写 `/tmp/qz-behavior/state.json`，反复跑没问题。

## 与 `test/*.test.mjs` 的区别

`test/*.test.mjs` 是 `npm test` 跑的主测试套件；这里的用例是发补丁时用来做定点回归的
小脚本（每个只验证一处行为，输出人类可读的 PASS/FAIL），保留下来方便以后改动时复验。
