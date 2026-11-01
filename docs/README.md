# 文档索引

按使用场景分组，每篇文档一句话说明。角色卡正文不在 docs 目录下，位于 `roles/`（一张卡一个 markdown 文件）。

## 上手与部署

| 文档 | 说明 |
| --- | --- |
| [LINUX.md](LINUX.md) | Linux 全栈部署与运维手册：隔离边界、依赖、安装（一键 `install.sh` / 交互式 `deploy-all.sh`）、控制台、数据与备份、OneBot 连接故障排查 |
| [DOCKER.md](DOCKER.md) | Docker / Compose 部署：只装 Docker 的机器、首次启动、升级回滚、从裸机迁移、容器模式限制 |
| [BAOTA.md](BAOTA.md) | 宝塔 / aaPanel 面板部署：面板与 systemd 的分工、非 root 服务用户、端口与反向代理、常见报错 |
| [OPS.md](OPS.md) | `src/ops.js` 运维入口（体检 / 扫描 / 加密备份与恢复演练 / 消息清理 / 部署 / 看门狗 / 健康巡检 / 指标 / 隧道）的环境变量与示例 |
| [CONFIG-EXAMPLES.md](CONFIG-EXAMPLES.md) | 常用配置片段：思考模式、兜底模型、视觉、主动发言、表情包、节奏、拟人化表达、QQ 空间来源与周期提醒 |
| [HUMANIZE.md](HUMANIZE.md) | 拟人化表达：运行时实现（气泡整形、角色声音、few-shot、诚实边界）、客观指标、盲评量表与调参顺序 |
| [MCP.md](MCP.md) | MCP：客户端配置（stdio server、工具挂载）、只读资源服务（人物记忆/梗库/提醒）、安全边界与运维接口 |
| [MODERATION.md](MODERATION.md) | 群管理动作：管理员门槛、禁言/踢人/撤回/设管理员 |
| [KNOWLEDGE.md](KNOWLEDGE.md) | 轻量知识库：目录、切片、关键词检索与边界（不是完整 RAG） |
| [LIVING-MEMORY.md](LIVING-MEMORY.md) | 长期向量记忆：主进程内 SQLite 存储、语义召回、Embedding 环境变量与隐私边界 |
| [AUTO_UPDATE.md](AUTO_UPDATE.md) | Release 驱动的自动更新：判定规则、两条下载通道（git / API+源码包）、失败策略与状态字段 |

## 功能说明

| 文档 | 说明 |
| --- | --- |
| [CONVERSATION_MODES.md](CONVERSATION_MODES.md) | 对话引擎三模式（legacy / threaded / lifecycle）的差异与选择 |
| [DAILY_MOMENTS.md](DAILY_MOMENTS.md) | QQ 空间动态：来源（人设自己 / 群聊 / 混合）、默认草稿与编辑、去重、计划与时间口径 |
| [QZONE_INTERACTIONS.md](QZONE_INTERACTIONS.md) | 好友动态与评论回复的巡检节奏与退避 |
| [MEMORY.md](MEMORY.md) | 人物印象与会话交接、FTS5 + 中文二元组检索、可见性、容量/保留期与召回基准 |
| [SKILLS.md](SKILLS.md) | 技能包：只读 Markdown 流程、工具白名单、按群启用、安全边界与内置示例 |
| [SKILL-SUBMISSION.md](SKILL-SUBMISSION.md) | 向官方技能市场提交技能：打包脚本、托管、哈希与审核标准 |
| [model-prices.md](model-prices.md) | 价格体系：模型 id 归一化与别名、渠道价、账户口径三选一、实付/估算/未定价 |
| [STABLE_FEATURES.md](STABLE_FEATURES.md) | 已从实验转为默认开启的功能，以及转正的判定标准 |
| [STABLE_FEATURE_MIGRATION_NOTES.md](STABLE_FEATURE_MIGRATION_NOTES.md) | 实验/退役功能留下的一次性兼容边界（身份、好友、异常、黑话） |
| [EXPERIMENTAL_FEATURE_STANDARD.md](EXPERIMENTAL_FEATURE_STANDARD.md) | 实验功能的开发规范：开关、默认值、降级与转正流程 |
| [ASSET_OBSERVABILITY.md](ASSET_OBSERVABILITY.md) | AI 资产观测（表情/黑话等）的统计口径与控制台入口 |

## 开发与维护

| 文档 | 说明 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构总览：模块划分、消息流、存储与外部依赖 |
| [CHANGES.md](CHANGES.md) | 本分支相对上游的改动清单，每条附「失败模式 → 现行做法」 |
| [RELEASE-ARCHIVE.md](RELEASE-ARCHIVE.md) | v0.5.0–v0.8.4 已从 GitHub Releases 列表移除的旧发布说明存档（git tag 全部保留） |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | 当前已知但未修复的问题，以及历史上的基线失败记录 |
| [EFFECT-LEDGER.md](EFFECT-LEDGER.md) | 出站副作用账本：日报/提醒/游戏终局的幂等键与 unknown 语义（第一阶段已实现，插件 journal 待做） |
| [PERSONAS.md](PERSONAS.md) | 内置角色卡清单、选择与保存、语气档位（原版群友 / 自然可靠）与生效范围 |
| [PLUGINS.md](PLUGINS.md) | 插件机制：目录与 manifest 契约、NDJSON 协议、能力白名单、隔离实测与信任声明（含分期）；apiVersion 2 的设置面板/加密凭据/授权与配额/媒体边界；作者向的写插件三条命令与上架流程（控制台「插件 → 发布插件」是同一份路线的界面版） |
| [BILIBILI.md](BILIBILI.md) | 官方 B 站插件：读/观看/互动范围、Cookie 配置、批准与配额、视频下载合流的限制 |
| [LIFE-FEED.md](LIFE-FEED.md) | 生活层（见闻）：B 站觅食、兴趣画像、候选队列、主动分享与插件 `feed` 数据源 |
| [WAVE3-DESIGN.md](WAVE3-DESIGN.md) | 第三波设计：多来源 adapter、内容池、说说互通、群策略总览与统一确认 |
| [UI-SMOKE.md](UI-SMOKE.md) | 改了 `ui/` 之后的手工烟测清单（自动化只覆盖「渲染不抛 + 钩子接上了」） |
| [adr/](adr/) | 架构决策记录（已定决策 + 理由 + 后果）：无构建工具、人物记忆全局共享、systemd user 托管、跨文件接管走 QARegistry、ui/ 全量转 ES module |
| [../AGENTS.md](../AGENTS.md) | 面向 AI 协作者的约定：代码风格、验证方式、提交要求 |

## 调研与方向稿

[`research/`](research/) 目录下为**当时**的调研与设计草稿，不属于现行规范（结论可能已经过时，
现状以代码与上文各篇为准）：

- [WECHAT_BOT_FEASIBILITY.md](research/WECHAT_BOT_FEASIBILITY.md)：微信端可行性调研
- [CONTEXT_BUDGET_RESEARCH.md](research/CONTEXT_BUDGET_RESEARCH.md)：上下文预算的三个概念与实测
- [INCIDENT_HANDLING_RESEARCH.md](research/INCIDENT_HANDLING_RESEARCH.md)：异常处理与降级策略的调研
- [FRIEND_TRIGGER_PILOT_RESEARCH.md](research/FRIEND_TRIGGER_PILOT_RESEARCH.md)：主动加好友触发条件的调研
- [SNOWLUMA_FRIEND_API_RESEARCH.md](research/SNOWLUMA_FRIEND_API_RESEARCH.md)：协议端好友接口调研
- [THREADED_PILOT.md](research/THREADED_PILOT.md)：线程化对话的早期方案
- [GAME_HOSTING_DESIGN.md](research/GAME_HOSTING_DESIGN.md)：多人游戏状态机（群游戏主持）的设计与实施方案（已实现：框架 + 数字炸弹 + 谁是卧底 + 狼人杀；代码在 `src/features/group-game.js` 与 `src/features/games/`，狼人杀与私聊通道的细节见 §4.2）
- [MULTIMODAL_CONTEXT_PILOT.md](research/MULTIMODAL_CONTEXT_PILOT.md)：多模态上下文连续性的早期方案

## 角色卡与其它

- 角色卡正文：[`roles/`](../roles)，一张卡一个 markdown（内置九张：小鲸鱼、损友、温柔陪聊、
  技术宅、猫娘、乐子人、孙吧大肥鱼、学习搭子、女儿），说明见 [PERSONAS.md](PERSONAS.md)；声音参数在
  `roles/voice-profiles.json`，对话示例在 `roles/dialogs/`。新增卡要在 `src/personas.js` 登记，
  由 `test/personas.test.mjs` 检查。
- 远程价格表（随版本发布）：[`prices.json`](../prices.json)
- 运行数据与凭据：`data/`（**不入库**，分享前使用 `node scripts/sanitize-release.mjs` 生成脱敏副本）
