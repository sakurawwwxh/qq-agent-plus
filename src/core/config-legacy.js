// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS, normalizeBehaviorProfile, applyPersonaTemplate } from '../personas.js';
import {
  clampProbability,
  legacySliderToProbability,
  legacyTierToProbability,
  sliderToTier
} from './tier-slider.js';   // 零依赖模块，避免循环依赖
import { DEFAULT_TIME_CONTROL, normalizeTimeControl } from './time-control.js';
import { normalizeTokenSaverMode } from './token-saver.js';   // 零依赖模块，避免循环依赖
import { normalizeMomentWindows } from '../features/moment-schedule.js';
import { PLATFORM_GATE_KEYS } from './platform-gates.js';   // 零依赖模块：按群覆盖的键名校验

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件在 src/core/ 下：仓库根要多退一层（挪目录时最容易漏的就是这里）
export const ROOT = path.resolve(__dirname, '..', '..');
// 测试/便携场景可重定向数据目录
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 每日花费上限（改进方案 #8，默认关闭＝升级不改变任何行为）。按**估算价**累计当日用量，
    // 不产生任何实际扣费动作；金额由运营者按自己的渠道价格填（方案 D5）。
    budget: {
      enabled: false,
      dailyYuan: 20,
      onExceed: 'degrade',   // degrade=只回应 @；block=不运行
      notify: true
    },
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    visionModel: '',                        // 识图专用模型（可选）：主模型是纯文本模型时，看图工具的图片先送给它转述成文字；空=直塞主模型（原行为）
    // 思考控制（语义层，见 src/core/provider-presets.js 的渠道形状翻译）：
    //   'on'（默认，不干预）/ 'off'（尽力关闭；渠道关不掉时按最低档近似并提示）
    //   / 'low' / 'medium' / 'high' / 'max'（档位，仅该渠道已核实的档位会发出去）
    //   / 按用途对象 { chat: 'off', default: 'on' }
    // 表外渠道：只有明确 off 时才发历史默认形状 thinking:{type:'disabled'}（不认的网关不会 400）。
    thinking: 'on',
    // 每个供应商的独立思考设置，键为主机名（如 "api.commandcode.ai"）：换供应商不串设置；
    // 没有条目的供应商退回上面的全局 thinking（老配置照常工作）。
    thinkingByService: {},
    // 自定义渠道的档位映射：语义档位 → 请求字段，例：
    //   { "low": {"reasoning_effort": "low"}, "high": {"reasoning_effort": "high"} }
    // 表外/自定义渠道优先用它；内置预设渠道仍走内置形状（不覆盖）。
    thinkingParams: {},
    // 额外请求参数（高级逃生口）：填了就以最高优先级合并进每次请求。
    // 例：某些网关要 {"reasoning":{"enabled":false}} 才能关思考；表外渠道的怪癖参数都填这里。
    extraBody: {},
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 60000,
    runTimeoutMs: 180000,
    maxRunTokens: 160000,                   // 同一 Agent 运行内所有模型调用的累计 Token 上限
    contextWindowTokens: 1000000,           // 当前模型上下文窗口，供批处理裁剪与预算预判
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 成本口径（设置页只需用户选一次，不用逐模型配）：
    //   official     默认：按内置/远程价格表估算（"不是你的账单"）
    //   multiplier   渠道价 = 官方价 × costMultiplier（中转站常见：只知道一个折扣）
    //   subscription 按月付：所有模型按固定月费（订阅套餐 / 本地自建）
    costMode: 'official',
    costMultiplier: 1,
    costMonthlyFee: 0,
    // 没有价格的模型按"当前模型"的价估算（默认开）：避免"未定价"变成用户的作业。
    // 数字仍是估算口径，用量页会说明有多少次是按它估的。
    fallbackToCurrentModel: true,
    // 用量页那张"成本想更准？三选一"的引导卡是否已经处理过（选过或点过"以后再说"）
    costGuideDismissed: false,
    // 远程价格表 URL：留空 = 用项目自己的价格表（jsDelivr → raw.githubusercontent 兜底）；
    // 填 'none' = 完全关闭（只用内置表）；填 URL = 用你自己的表（同 prices.json 结构）。
    // 启动时拉取一次，之后每 24 小时自动刷新（失败过 3 小时重试）；
    // 拉取全程异步、失败不清表 —— 对正常使用零影响。
    // 远程条目按模型 id 覆盖内置表，内置表其余条目仍是兜底。
    priceRemoteUrl: '',
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 键可以是模型 id，也可以是「渠道：模型 id」（全角冒号）—— 后者只对该渠道生效。
    // 用户填的价优先于官方价格表；改动只存在这里，不回写内置价格表。
    modelPrices: {},
    // 每渠道一份价目表（自动拉取）：[{ vendor: '渠道名', url: 'https://.../pricing.json' }]
    // 拉到的价只在该渠道的调用上生效，优先级在"手填的渠道价"之后、官方表之前。
    // 见 src/pricing/channel-prices.js；探测渠道倍率用控制台的「从渠道自动拉价」。
    channelPriceFeeds: []
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  providerKeys: {},      // providerId -> 真实 API Key（providers[] 里不存明文 Key）
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso' | 'doubao' | 'tavily' | 'aggregate'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    doubao: {
      apiKey: '',                     // 火山 Agent Plan 搜索服务 Key；留空时回退环境变量 DOUBAO_SEARCH_API_KEY
      baseUrl: 'https://open.feedcoopapi.com/search_api/web_search',
      count: 6,
      timeoutMs: 20000
    },
    tavily: {
      apiKey: '',                     // tavily.com 搜索 Key；留空时回退环境变量 TAVILY_API_KEY
      baseUrl: 'https://api.tavily.com/search',
      count: 5,
      searchDepth: 'basic',
      timeoutMs: 20000
    },
    // 聚合搜索（provider='aggregate'）：并发跑多个源，URL 去重、结果带 source 标注，
    // 单源失败不影响整体，全部失败才报错。sources 顺序 = 结果优先级。
    aggregate: {
      sources: ['tavily', 'doubao', 'bing'],
      count: 4
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    }
  },
  // 语音转文字（ASR，可选）：把语音/视频里的音轨转成文字，任何聊天模型都能用。
  // 供应商可换，与「搜索服务」的 Key/服务完全无关：
  //   openai —— **默认**：任意 OpenAI 兼容的转写服务（硅基流动 / Groq / 自建 faster-whisper 网关…）：
  //             填 baseUrl（到 /v1 那层）+ model 即可，不用等我们适配
  //   volc   —— 火山引擎语音技术的大模型录音识别（Seed-ASR，走 WebSocket，按量计费）
  //   local  —— 本机 whisper.cpp：不联网、不要 Key、音频不出机器，代价是要自己装二进制与模型
  // 不同供应商的 API 不必是同一家，甚至不必是同一个账号。
  asr: {
    enabled: true,
    // 默认走"API Key 的托管服务"（用户 2026-09-26 要求）：预置推荐的免费服务（硅基流动）地址，
    // 粘一个 Key、从官网拉一次模型列表就能用；不想注册账号可以切到 local（本机 whisper.cpp，
    // 控制台里一键装/卸，约 466MB 模型）。地址预置只是默认值，服务预设里一键换别家。
    provider: 'openai',
    maxPerHour: 12,           // 按量计费服务的硬闸门：每小时最多转写几次（全局，#9 双闸的全局侧）
    maxPerHourPerChat: 4,     // 每会话每小时上限（#9 双闸：防单个群刷爆全局额度）
    apiKey: '',               // volc / openai / 百度(API Key) / 讯飞(APIKey) 用；留空回退环境变量 ASR_API_KEY
    apiKeyProvider: '',       // 上面这个 Key 是给哪家存的：换供应商后不再拿它发请求（避免把旧 Key 发给新服务）
    apiKeyHost: '',           // 再细一层：OpenAI 兼容里"哪家的地址"（主机名）。硅基流动/Groq/OpenAI 都是 openai 一家，只看 provider 分不出来
    // 少数几家要"两个/三个凭据"（都不走 OpenAI 协议，需要各自的签名/换取流程）：
    appId: '',                // 讯飞 AppID
    secretId: '',             // 腾讯云 SecretId
    secretIdProvider: '',     // 上面这个 SecretId 是给哪家存的（同 apiKeyProvider 的道理）
    secretKey: '',            // 百度 Secret Key / 腾讯云 SecretKey / 讯飞 APISecret
    secretKeyProvider: '',    // 上面这个 SecretKey 是给哪家存的（三个服务共用这一个字段，不记归属就会串用）
    // 「每家存过的那套凭据」按**槽位**记（2026-10-02 用户要求）：切服务预设时自动取回 ——
    // 存过就填回、没存过就留空等用户填。槽位口径见 asrCredentialSlot：
    // OpenAI 兼容按"地址主机"分家（硅基流动/Groq/OpenAI 都是 openai），其余按 provider。
    // 活动凭据仍是上面的单槽 + 归属钉；这个映射只作"切换预设时的记忆"（与 tts.keys / imageGen.keys 同款思路）。
    keys: {},
    baseUrl: 'https://api.siliconflow.cn/v1',  // 默认预置硅基流动（免费模型，国内可直连）；可换任意兼容服务
    model: '',                // openai 兼容的模型名，例：whisper-large-v3-turbo
    language: '',             // 可选：提示语言（zh / en…），留空由服务自己判
    localBin: '',             // 本机转写可执行文件，留空按 whisper-cli → whisper-cpp → main 找
    localModel: ''            // 本机转写的模型文件路径（如 ggml-base.bin）
  },
  // 语音回复（与 asr 对称：OpenAI 兼容的 /audio/speech，如硅基流动/自建网关）：默认关。
  // 开启前填好 baseUrl 与 model（voice 按服务商文档填）。
  tts: {
    enabled: false,
    provider: 'openai',       // openai（兼容 /audio/speech）/ volc（火山 v1）/ doubao（豆包语音合成 2.0，v3）/ minimax（T2A v2）
    baseUrl: '',
    apiKey: '',
    appId: '',                // 火山 v1：语音技术控制台的 AppID（纯数字）；豆包 2.0 可不填
    cluster: '',              // 火山 v1：cluster（默认 volcano_tts；**不是音色**）
    resourceId: '',           // 豆包 2.0：资源 ID（默认 seed-tts-2.0；1.0 音色要 seed-tts-1.0）
    groupId: '',              // MiniMax：账户里的 GroupId
    // 按服务分别存 Key（切预设不串用；切回来还能看到已存的那把）：
    //   { "siliconflow": "sk-…", "volc": "<access token>", "doubao": "<api key>", "minimax": "…" }
    keys: {},
    apiKeyService: '',          // 上面那个单槽 apiKey 是给哪家存的（提交时记；老配置留空 = 按"当前这家"兜底）
    model: '',
    voice: '',
    format: 'mp3',
    speed: 1,                 // 语速（0.25~4；实测硅基流动真实生效，聊天语速 1.05~1.15 更活）
    gain: 0,                  // 音量增益 dB（-10~10；觉得发闷可以 +2~+4）
    timeoutMs: 30000
  },
  // 图片生成（与 tts/asr 对称：OpenAI 兼容的 /images/generations）：默认关。
  // 计费按张，闸门只有 maxPerHour 这一道 —— 默认给得很保守。
  imageGen: {
    enabled: false,
    baseUrl: '',              // 留空表示"跟聊天模型同域"（很多网关同域就带 images 端点）
    apiKey: '',               // 单独填的 Key；留空只在"与模型同域"时复用模型 Key，否则拒绝（见 resolveImageGenAuth）
    apiKeyHost: '',           // 上面这把 Key 是给哪家的**地址**存的（主机名）：换预设/换地址后不再拿它发请求
    // 「每家存过的那把 Key」按主机记（2026-10-02 用户要求）：切服务预设时自动取回 ——
    // 存过就填回、没存过就留空等用户填。活动 Key 仍是上面的 apiKey + apiKeyHost 归属钉；
    // 这个映射只作"切换预设时的记忆"（与 tts.keys 同款思路）。
    keys: {},

    model: '',                // 如 gpt-image-1 / seedream-3.0 / cogview-3
    size: '',                 // 如 1024x1024；留空由服务商默认
    responseFormat: '',       // 留空最兼容（新版 OpenAI 会因未知参数 400）；可填 b64_json / url
    maxPerHour: 6,            // 全局每小时最多生成几张（按张计费，硬闸门）
    timeoutMs: 120000,        // 生图比对话慢
    extraBody: {}             // 额外请求参数（个别网关要 quality/style 之类）
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false           // true 时图片下载允许内网地址（仅本地测试/自建图床）
  },
  // 外部 OneBot v11 服务
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: '',       // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
    // WebSocket 心跳 ping 策略：auto（默认）第一次遇到"发 ping 就被断开"的对端后不再发
    // （NapCat 的实测行为，Issue #22）；on 始终发；off 从不发。改完要重启才生效。
    wsHeartbeat: 'auto',
    // 断线/重启后补回的消息超过这个时长只入库不回复（0 = 一律只补记录，不唤醒模型）。默认 30 分钟。
    catchupReplyWindowMs: 30 * 60 * 1000
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    behaviorProfile: 'legacy',             // legacy | grounded，选择模板时一起切换
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: '',                        // 追加自定义规则（可选）
    // 选中的内置卡 id（roles/*.md 的登记名）。非空表示"正文跟着卡文件走"：
    // 载入配置时若正文与文件不一致就按文件刷新，改了卡不用再去控制台重选一次。
    // 手改正文、或用自定义卡时是空串（正文不受文件影响）。
    templateId: 'xiaojingyu'
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 10000,
  wakeDelayMinMs: 8000,
  wakeDelayMaxMs: 12000,
  drainDelayMs: 10000,
  maxBatchWaitMs: 20000,
  runtime: { mode: 'observe', paused: false },
  timeControl: DEFAULT_TIME_CONTROL,
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 对话线程试点：默认关闭，可从控制台动态切换，不影响旧触发模式。
  conversation: {
    mode: 'legacy',                  // legacy | threaded | lifecycle
    unifiedMode: true,               // false 时允许 groupModes 按群覆盖
    groupModes: {},                  // { [groupId]: legacy | threaded | lifecycle }
    continuationWindowMs: 180000,    // 机器人发言后，同一参与者确定性续接窗口
    threadTtlMs: 1800000,            // 线程空闲多久后关闭
    continuationContextCount: 100,   // threaded 续接唤醒时携带的历史消息条数
    silentIdleMs: 300000,            // lifecycle：沉默状态 5 分钟无消息即结束
    activeIdleMs: 1200000,           // lifecycle：活跃状态 20 分钟无消息即结束
    hardLifetimeMs: 1800000,         // lifecycle：绝对生命周期上限 30 分钟
    rolloverArmedMs: 600000,         // 活跃线程撞硬上限后，一次性任意消息触发期限
    lifecycleContextCount: 100,      // 生命周期首次运行携带的历史条数
    lifecycleRolloverInputTokens: 32000, // 上次实际输入达到此值时，下一批先换代
    maxTranscriptChars: 240000       // 生命周期追加式模型上下文硬预算
  },
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    typingIndicator: true   // 私聊发言前亮「正在输入」（群聊 QQ 没有这个能力）
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25,
    // 下面两条是独立开关（控制台「主动开话题」分区各一个复选框），**不跟随上面的 enabled**：
    // 补话与模型自安排唤醒在引入开关之前一直是常开，默认 true 保持升级前后行为一致；
    // 只想关掉它们的人各关各的，不想主动开口的三个一起关。
    followUpEnabled: true,      // 发言后没人接话，过十来分钟补一句
    selfWakeEnabled: true       // 模型用 schedule_wake 给自己安排稍后的主动发言
  },
  // 自主节奏（可选）：消息不再即时触发，改由模型按自己安排的节奏醒来统一处理。
  // 默认关闭；开启后建议先在小范围（scope）试，确认能接受"延迟接话"的节奏。
  pacing: {
    enabled: false,
    scope: 'group',            // group | all —— 对哪些会话启用（私聊永远即时，不受影响）
    instantOnMention: true,    // 被 @ 时立刻处理，不排队
    defaultWakeMinutes: 20,    // 默认多久后自己醒一次看看
    minWakeMinutes: 5,         // 两次自主醒来之间的最短间隔
    maxSilenceMinutes: 45      // 最长沉默上限（超过就重排一次更早的醒来）
  },
  // GitHub 自动更新。外部 systemd timer 只负责唤醒，是否实际检查由 enabled 控制。
  autoUpdate: {
    enabled: false,
    ownerUin: '',
    repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
    branch: 'main',
    intervalHours: 6,
    // 协议端（SnowLuma）镜像的自动更新：默认关（它会重启协议端容器，虽然数据卷不动、
    // 登录态保留，但仍应显式打开）。打开后控制台进程每 6 小时比一次镜像版本，
    // 落后于项目基线就自动更新；失败会自动回滚到旧镜像。
    // image 留空 = 用项目基线（并沿用当前镜像的国内镜像站前缀）。
    snowluma: { enabled: false, image: '' }
  },
  // 群日报：每天定时把"昨天群里聊了啥"汇总成一条发到指定群。
  // 白名单制（chats 为空则不发任何群）；默认关。
  groupDigest: {
    enabled: false,
    time: '09:30',
    chats: [],
    maxChars: 300
  },
  // 群游戏（实验性，默认关）：白名单制、每群同时一局；私聊发词默认关闭（风控考虑）。
  groupGame: {
    enabled: false,
    chats: [],
    allowPrivateInvite: false,
    // 游戏期间私聊豁免（默认关）：开启后引擎发给**本局在册玩家**的私聊不再要求对方在
    // 私聊白名单里（报名=同意接收；deny 仍优先），用于狼人杀这类全程私聊行动的游戏。
    // 关着也能玩——把想玩的人加进 allow.private（推荐顺手加好友）即可。
    allowGamePrivateDm: false,
    // 开局报名时长（秒）：需要私聊的游戏（谁是卧底/狼人杀）先挂报名，够 minPlayers 才发牌；
    // 0 = 不报名（直接按"最近发过言的群友"发牌）。报名阶段不发任何私聊，避免把围观者拉进局。
    recruitSeconds: 45,
    // 允许开局的游戏（控制台勾选的那三个）：引擎按这个白名单拒绝 start（以前勾选是死控件）
    games: ['number-bomb', 'undercover'],
    // 白天讨论时长（秒；0 = 用插件默认 120）与结算是否公开词/身份
    discussSeconds: 0,
    revealWords: true,
    // 这两项一直在 UI/文档里当默认值用（10 / 0=插件默认），但配置对象里没有，
    // 于是"没保存过实验页"的实例实际用的是插件上限（2026-09-29 审查 P2）
    maxPlayers: 10,
    roundSeconds: 0,
    maxDurationMin: 60,
    dailyLimitPerChat: 6
  },
  // 定时提醒（"X 点提醒我 Y"）：持久化、到点主动唤醒说出来。默认开；
  // 关闭后 remind 工具与到期派发都停，已存数据保留（重新打开继续用）。
  // 控制台「设置 → 定时提醒」可开关并查看/取消已立的提醒。
  reminders: {
    enabled: true
  },
  // 每日群聊记忆总结与 QQ 空间动态
  dailyMoments: {
    enabled: false,
    hour: 23,                    // 上海时间
    minute: 30,
    scheduleWindows: null,       // null 保留固定时刻；数组为 {start, end, count}
    intervalDays: 1,             // 固定时刻模式的发送间隔（天）：1=每天；以上次成功发布为基准
    startupCatchup: true,        // 错过定时点后，服务恢复时补一次
    minMessagesPerGroup: 3,
    maxGroups: 12,
    maxMessagesPerGroup: 80,
    maxPromptChars: 120000,
    allowImages: true,
    maxImages: 1,
    visibility: 4,              // 1=所有人 4=好友 64=仅自己
    targetUins: [],
    maxResearchCalls: 4,
    maxRounds: 8
  },
  // 好友动态阅览、点赞评论与评论回复。默认关闭，启用后按上海时间周期轮询。
  qzoneInteractions: {
    enabled: false,
    startupCatchup: false,
    feedIntervalMinutes: 60,
    replyIntervalMinutes: 5,
    feedFetchCount: 30,
    ownPostCount: 10,
    maxAgeHours: 72,
    maxBatchItems: 20,
    maxLikesPerRun: 3,
    maxCommentsPerRun: 2,
    maxRepliesPerRun: 5,
    commentMaxChars: 60,
    replyMaxChars: 60,
    allowLikes: true,
    allowComments: true,
    allowReplies: true,
    actionDelayMinMs: 700,
    actionDelayMaxMs: 1800,
    maxDecisionRounds: 3
  },
  // 跨会话人物画像与好友关系试点。第一阶段只提供总开关；
  // 关闭时不得注册工具、注入提示词、启动任务或创建实验数据文件。
  // graduated 只控制独立产品入口，不改变 enabled 的运行语义。
  identityPilot: {
    enabled: false,
    graduated: false,
    incomingFriendRequest: {
      enabled: false,
      autoWhitelist: true,
      maxPending: 50
    },
    friendProposal: {
      enabled: false,
      graduated: false,
      activeDispatchEnabled: false,
      ownerUin: '',
      mode: 'triggered',
      minMessageCount: 50,
      cooldownDays: 30,
      maxPending: 10,
      triggered: {
        probability: 0.05,
        historyDays: 30,
        minMessages: 50,
        minActiveDays: 3,
        minDirectExchanges: 3,
        maxTriggerAgeMinutes: 10,
        friendStatusMaxAgeMinutes: 15,
        drawCooldownMinutes: 30,
        maxDrawsPerUserPerDay: 6,
        maxReviewsPerDay: 10,
        skipCooldownDays: 7,
        errorCooldownMinutes: 60,
        maxQueueAgeSeconds: 120,
        scoreThreshold: 70,
        weights: {
          quality: 40,
          interest: 30,
          reciprocity: 20,
          stability: 10
        }
      }
    }
  },
  // 黑话语料库试点。关闭时不建库、不扫描消息、不注册任务或改变模型请求。
  slangPilot: {
    enabled: false,
    graduated: false,
    ownerUin: '',
    minOccurrences: 3,
    minSpeakers: 2,
    windowHours: 72,
    maxPending: 100,
    perChatDailyLimit: 5,
    rejectCooldownDays: 14,
    maxEvidence: 12,
    webResearch: true,
    maxSearchResults: 5,
    maxFetchPages: 2,
    maxResearchRounds: 2
  },
  // 异常处理试点。关闭时不建库、不改变会话阻塞策略、不发送管理员告警。
  incidentPilot: {
    enabled: false,
    graduated: false,
    ownerUin: '',
    notifyWarnings: true,
    duplicateWindowMinutes: 10,
    unknownWritesBlockChat: false,
    retentionDays: 90
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    // 别人发来的表情包自动进库（同图只存一次，受 maxCollectPerHour 限频）
    autoCollect: true,
    maxCollectPerHour: 10,
    maxCollectPerHourPerChat: 3,   // 每会话每小时收藏上限（#9 双闸；上一行是全局）
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1
  },
  // QQ 平台能力（协议端 SnowLuma ≥1.14.20 提供）：每个开关关掉后，对应工具会从模型工具表
  // 里摘除、提示词也不再教用法（与"表情包/搜索/ASR"同一口径，避免模型调用必然失败的工具）。
  // 2026-10-07 拆细：读与写分开（"只让它看、不让它动手"要能单独配）；映射表在
  // core/platform-gates.js（控制台渲染、orchestrator 过滤、提示词共用同一份）。
  // 默认值取向：读/轻互动默认开；会改变**账号级外观**或**往群里发布内容**的默认关
  // （换头像、改昵称/个性说明、传相册）。拆细后的默认组合与拆分前逐项等价。
  platform: {
    reactions: true,        // 【读】看谁贴了什么表情（get_message_reactions；[贴表情] 记录一直会落存档）
    reactionsWrite: true,   // 【写】给群里的消息贴表情（react_to_message）
    qqVoice: true,          // QQ 原生 AI 语音（send_qq_voice）
    // QQ 语音音色（协议端 character_id，如 lucy-voice-laibixiaoxin=小新）。
    // 空 = 不固定：模型每次自己从协议端返回的角色目录里挑一个。
    qqVoiceCharacter: '',
    profileWrites: true,    // 【写】改签名 / 在线状态（账号侧可见，带 24h 闸门）
    remarkWrites: true,     // 【写】给好友/群设备注（独立闸门）
    // 换头像 / 改 QQ 昵称与个性说明（set_my_avatar / set_my_profile）——账号级外观，
    // 所有人都看得到、且不像发言那样可以被上下文解释，默认关（与相册上传同一档）。
    avatarWrites: false,
    nicknameWrites: false,
    groupTools: true,       // 【读】群资料/公告/荣誉（get_group_profile）
    groupWrites: true,      // 【写】群签到 / 设群待办
    ocr: true,              // 服务端 OCR（读图上的文字）
    groupFiles: true,       // 【读】群文件：看目录 / 取下载链
    groupFileSend: true,    // 【写】发文件到群
    albumRead: true,        // 【读】群相册：看相册与照片
    albumWrites: true,      // 【写】相册点赞 / 评论
    albumUpload: false,     // 【写】把图传进相册（默认关：会往群里发布内容）
    readReceipts: false,    // 处理完的消息在 QQ 里标已读（默认关：会改变你自己各端的未读观感）
    forwardCards: true,     // 长内容（群日报）用「合并转发卡片」发送，而不是一大段文本
    // 写入类动作的闸门上限（滑动窗口内的全局次数；0/非法 = 用内置默认，硬顶 200）。
    // 语义与 PLATFORM_QUOTA_DEFAULTS 一一对应：这是防模型抽风的刹车，不是"限额玩法"。
    quotas: {
      reactionsPerHour: 10,   // 贴表情：每小时
      profilePerDay: 1,       // 签名 + 在线状态（共享一个额度）
      remarksPerDay: 1,       // 备注
      avatarsPerWeek: 1,      // 换头像（窗口 7 天：真人按周/月换）
      albumWritesPerHour: 5   // 相册点赞 / 评论（评论是公开内容，卡得比贴表情紧）
    },
    // 按群覆盖：{ "<群号>": { "<门控键>": true|false } }。只认显式布尔值，
    // 其余键/坏值一律回落全局开关；键名合法性在控制台与 migrateConfig 两处校验。
    perGroup: {}
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 响应概率（滑条上的数字就是概率）──
    // 0 = 只回 @ 和关键词；100 = 任何消息都响应；中间值 = 普通消息按该概率响应。
    // 被 @ 或命中关键词一定响应，不受这个数字影响。
    contextSliderPos: 100,      // 滑条位置 = 概率（0~100）
    sliderMode: 'probability',  // 标记这套语义；老配置（四段式滑条）保存时一次性换算
    contextTier: 4,             // 派生：0%→1、中间→3、100%→4（决定读多少条已读、触发方式展示）
    atCount: 300,               // 被艾特时读多少条已读
    keywordCount: 100,          // 命中关键词时读多少条
    keywords: [],               // 关键词表（清空就只回 @）
    randomPercent: 100,         // 派生 = 概率（运行时判定用的就是它）
    randomCount: 60,            // 按概率响应时读多少条
    allCount: 300,              // 全响应时读多少条
    batchLimit: 100,
    batchMaxChars: 32000,
    pastStateMaxChars: 24000,
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按群单独设置
    groupSliderPos: {},         // { [群号]: 概率 0~100 } 仅 unifiedTier=false 时生效；未设置的群/私聊跟随全局
    keepSessionFiles: 2000
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃——不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    handoffEnabled: true,
    handoffTtlMinutes: 1440,
    handoffMaxChars: 4000,
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: '',                            // 专用模型 id（useChatModel=false 时生效）
    // 记忆可见性（#13）：默认与历史行为逐字一致（global + 不隐藏），切换必须显式操作
    visibility: { mode: 'global', hidePrivateInGroup: false }
  },
  // 省 Token 模式：只给"可控项"夹上限（上下文档位条数、单次运行轮数与预算、
  // 交接/印象注入字符数、提示词里的表情清单条数），不改写上面那些用户填的值。
  // off = 完全按用户设置；balanced = 省；aggressive = 很省。见 src/core/token-saver.js
  tokenSaver: {
    mode: 'off'
  },
  // Linux Web 控制台
  server: {
    port: 3210,
    host: '127.0.0.1',
    strictPort: true,
    token: ''                 // 留空 = 只监听 127.0.0.1
  },
  ui: {
    // ── 外观（2026-10-08 v3，七轴）────────────────────────────────────────────
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    darkIntensity: 'soft',    // 深色强度：soft | oled（纯黑）
    scheme: 'default',        // 表面色板：default | slate | nord | forest | rose
    accentPreset: 'indigo',   // 强调色预设 id（见 ui/core/appearance.js 的 ACCENTS）
    accent: '',               // 自定义强调色（#rrggbb）；非空时压过预设
    accentScope: 'global',    // 强调色作用范围：global | sidebar
    sidebarStyle: 'follow',   // 侧栏底色：follow | panel | accent
    // 侧栏是不是"悬停展开的图标条"：false = 鼠标移开收成 64px 图标条、移上去自动展开（参照控制台的默认），
    // true = 常驻展开。与参照实现同名同义（它的 appearance.sidebarPinned）。
    sidebarPinned: false,
    background: 'none',       // 整页背景：none | solid | gradient
    bgColor: '#0b1220',
    bgFrom: '#4c8dff',
    bgTo: '#a78bfa',
    bgAngle: 135,
    font: 'default',          // 界面字体：default | rounded | serif
    radius: 1,                // 圆角倍率（0.6 / 1 / 1.2 / 1.45 四档）
    zoom: 1,                  // 界面缩放 0.8~1.3
    density: 'cozy',          // 显示密度：cozy | compact | roomy
    tweaks: {},               // 主题微调：白名单 CSS 变量 → 颜色（未设的保持色板默认）
    showBadges: true,         // 顶栏显示连接/用量徽章
    showTopbarTheme: true,    // 顶栏显示主题切换按钮
    reduceMotion: false,      // 减弱动效
    noMotion: false,          // 关闭全部动效
    contrast: 'normal',       // 对比度：normal | high
    // ── 其它界面项 ─────────────────────────────────────────────────────────
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000          // 界面轮询间隔
  }
};

/** 语音转写的供应商。四家国内云的转写接口都不是 OpenAI 协议，各有各的签名/换取流程，所以各是一个 provider：
 *  local   本机 whisper.cpp（零 Key）
 *  volc    火山 Seed-ASR（WebSocket，一个 Key）
 *  openai  任意 OpenAI 兼容服务（Key + 地址 + 模型）
 *  aliyun  阿里云百炼（chat + input_audio，一个 Key，地址/模型有默认值）
 *  baidu   百度短语音识别（API Key，可选 Secret Key 换 token）
 *  tencent 腾讯云一句话识别（SecretId + SecretKey，TC3 签名）
 *  iflytek 讯飞语音听写（AppID + APIKey + APISecret，签名 URL + WebSocket）
 */
export const ASR_PROVIDERS = ['volc', 'openai', 'aliyun', 'baidu', 'tencent', 'iflytek', 'local'];
/**
 * 没配 provider（或值非法）时用哪个：OpenAI 兼容的托管服务。
 * 用户 2026-09-26 要求把"用 API Key 的方式"设为默认 —— 默认配置预置硅基流动的地址，
 * 粘一个 Key + 拉一次模型列表就能用；本机 whisper.cpp（零 Key 但要装 466MB）仍是一等选项，
 * 只是不再占默认位。
 */
export const ASR_DEFAULT_PROVIDER = 'openai';

/** PATH 里按顺序尝试的候选名（安装脚本构建出来的名字是 whisper-cli）。 */
export const WHISPER_BIN_CANDIDATES = ['whisper-cli', 'whisper-cpp', 'main'];

/**
 * 本机转写的模型文件：配置 > 环境变量 WHISPER_MODEL > 标准位置里第一个 ggml-*.bin。
 * 标准位置按"越可能被安装到"的顺序找：<数据目录>/asr/（安装脚本的默认落点）、仓库 models/、
 * ~/.cache/whisper.cpp/。同名偏好 small → base → tiny → 其它，保证同一台机器上结果确定。
 *
 * 放在 config-legacy 是因为读盘迁移（判"这台机器装过本机转写吗"）也要用它 —— 判据必须与运行期
 * 完全一致，否则会出现"运行期能用、迁移却判成没装"（2026-09-26 审查 P1）。
 */
export function asrLocalModel(cfg = getConfig()) {
  const configured = String(cfg?.asr?.localModel || '').trim();
  if (configured) return configured;
  const fromEnv = String(process.env.WHISPER_MODEL || '').trim();
  if (fromEnv) return fromEnv;
  const dirs = [
    path.join(DATA_DIR, 'asr'),
    path.join(ROOT, 'models'),
    path.join(os.homedir(), '.cache', 'whisper.cpp')
  ];
  const prefer = ['ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin'];
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^ggml-.+\.bin$/i.test(name)) continue;
      found.push(path.join(dir, name));
    }
  }
  if (!found.length) return '';
  const rank = (file) => {
    const base = path.basename(file).toLowerCase();
    const hit = prefer.indexOf(base);
    return hit === -1 ? prefer.length : hit;
  };
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

/**
 * 本机转写的可执行文件：配置 > 环境变量 WHISPER_BIN > 安装脚本的构建产物 > PATH 候选名。
 * 返回"打算用的那个"，真能不能跑由探测决定（见 asr-local.js 的 resolveWhisperBin）。
 */
export function asrLocalBin(cfg = getConfig()) {
  // "会用哪个"：配置/环境变量给了就用它（哪怕文件不在——这样用户能看见自己填错的那条路径）；
  // 否则找构建产物 / PATH 候选名。真要判定"能不能跑"用 findWhisperBinSync()（它做存在性检查）。
  const configured = String(cfg?.asr?.localBin || '').trim();
  if (configured) return configured;
  const fromEnv = String(process.env.WHISPER_BIN || '').trim();
  if (fromEnv) return fromEnv;
  return findWhisperBinSync(cfg) || '';
}

/** Windows 上要试 .exe 后缀；其它平台直接按名字找。 */
function binNamesOnPlatform() {
  const names = [...WHISPER_BIN_CANDIDATES];
  if (process.platform === 'win32') return [...names.map((n) => `${n}.exe`), ...names];
  return names;
}

/**
 * 同步找一遍可用的 whisper 二进制（配置里的路径 → 安装脚本的构建产物 → PATH 候选名）。
 * 只做存在性检查，够"要不要把工具注入给模型"用；真能不能跑由 asr-local.js 的异步探测定案。
 */
export function findWhisperBinSync(cfg = getConfig()) {
  const configured = String(cfg?.asr?.localBin || '').trim() || String(process.env.WHISPER_BIN || '').trim();
  const built = path.join(DATA_DIR, 'asr', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
  const seen = new Set();
  for (const candidate of [configured, built, ...binNamesOnPlatform()]) {
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (candidate.includes(path.sep) || candidate.includes('/')) {
        if (fs.existsSync(candidate)) return candidate;
        continue;
      }
      const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
      for (const dir of dirs) {
        const full = path.join(dir, candidate);
        if (fs.existsSync(full)) return candidate;
      }
    } catch { /* 单个目录坏掉就当没找到 */ }
  }
  return null;
}

/** 语音转写凭据的绑定粒度：OpenAI 兼容服务里"换地址 = 换了一家"，取主机名比较。 */
export function asrEndpointHost(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try { return new URL(raw).host.toLowerCase(); } catch { return ''; }
}

/**
 * /api/config 在 asr 上附加的"运行时结论"：客户端不该回传、更不该落盘。
 * 控制台保存时 patch 是 `{...c.asr, 真配置}`，不剔掉就会把陈旧副本写进 config.json，
 * 保存后的界面还会拿它当结论显示（2026-09-26 审查，实测：刚存好合法配置却显示"没配好"）。
 *
 * ⚠️ 这里只放"每次 GET 都会重算"的字段。绑定记录（apiKeyProvider / apiKeyHost /
 * secretIdProvider / secretKeyProvider）是**配置本身**，不在这个名单里 —— 混进来的话
 * 每合并一次就会被删掉再按当前服务重绑，"换成别家后旧凭据不算数"的防线就没了。
 */
export const ASR_DERIVED_KEYS = [
  'configured', 'available', 'keySource', 'keyProvider', 'keyUsable', 'keyHost',
  'keySlots',                               // "哪几家存过凭据"的布尔口径（GET 时重算），不回写
  'credentialStale',                       // 界面用来表达"刚换了服务、凭据要重填"的草稿标记，不该落盘
  'secretIdUsable', 'secretKeyUsable',
  'localBinResolved', 'localModelResolved', 'localManagedExists', 'localInstalled'
];

/**
 * 同理：/api/config 在 imageGen 上附加的"运行时结论"。
 * `available`（能不能真的画）每次 GET 都重算，前端展开回传后会被写进 config.json，
 * 之后升级改了判定口径、旧结论还留在文件里冒充当前状态（2026-09-30 审查，真实往返复现）。
 * hasApiKey 由 secret-keys 的 walk 自动生成，一并按 /^has[A-Z]/ 剔掉。
 *
 * `keyHost` 是 GET 时的**视图别名**：真身是 apiKeyHost，因为它名字里含 apikey 会被
 * secret-keys 抹掉，所以下发时换个名。前端把整份视图展开成 patch 回传 —— 不在这里剔掉，
 * 保存一次 config.json 里就多出一份陈旧副本（真身改了它不跟着动，读盘的人看到两个说法）。
 */
export const IMAGEGEN_DERIVED_KEYS = ['available', 'keyStale', 'keyHost', 'keyHosts'];

/**
 * 这个凭据能不能用于"当前配的这家"：凭据记着存它时的供应商（OpenAI 兼容的还记地址主机）。
 * 换了服务/换了地址就不再拿旧凭据去发请求 —— 否则"把腾讯的 SecretKey 当讯飞 APISecret 发出去"
 * 会静默发生（2026-09-26 审查，两种情形都实测复现过）。
 * 没记归属的老配置按当前这家算（migrateConfig 会补记），不给升级中的实例制造"突然不生效"。
 */
export function asrCredentialApplies(asr, provider, value, providerField, hostField = '') {
  if (!String(value || '').trim()) return false;
  const storedFor = String(asr?.[providerField] || '').trim().toLowerCase();
  if (!storedFor) return true;
  if (storedFor !== String(provider || '').trim().toLowerCase()) return false;
  if (provider === 'openai' && hostField) {
    const bound = String(asr?.[hostField] || '').trim().toLowerCase();
    if (bound && bound !== asrEndpointHost(asr?.baseUrl)) return false;
  }
  return true;
}

/** 槽位拼装（provider + 主机名；主机名只有 OpenAI 兼容用得上）。 */
export function asrCredentialSlotOf(provider, host) {
  const p = String(provider || '').trim().toLowerCase() || 'openai';
  return p === 'openai' ? `openai|${String(host || '').trim().toLowerCase()}` : p;
}

/**
 * 凭据槽位：一个服务预设对应一个槽（2026-10-02 用户要求："切换服务预设时 Key 跟着切换"）。
 * 粒度与 asrCredentialApplies 的归属判定一致：OpenAI 兼容按**地址主机**分家
 * （硅基流动/Groq/OpenAI 都是 provider=openai，不按地址分就会把 A 家的 Key 发给 B 家），
 * 其余（讯飞/百度/腾讯/火山/百炼/本机）按 provider。
 */
export function asrCredentialSlot(provider, baseUrl) {
  return asrCredentialSlotOf(provider, asrEndpointHost(baseUrl));
}


/**
 * 取"这家存过的"某个凭据（asr.keys 映射优先；老配置的单槽凭据按归属算 —— 与
 * asrCredentialApplies 同一条口径，升级上来的实例行为不变）。
 * 运行时取凭据（core/config.js）用它；"保存时该用哪把、能不能认领"要用
 * asrCredentialResolve（2026-10-02 全量审查拆开的两件事）。
 */
export function asrCredentialFor(asr, kind, provider, baseUrl) {
  const slot = asrCredentialSlot(provider, baseUrl);
  const fromMap = String(credentialSlotEntry(asr?.keys, slot)?.[kind] || '').trim();
  if (fromMap) return fromMap;
  const providerField = kind === 'apiKey' ? 'apiKeyProvider' : `${kind}Provider`;
  const hostField = kind === 'apiKey' ? 'apiKeyHost' : '';
  const stored = String(asr?.[kind] || '').trim();
  if (!stored) return '';
  return asrCredentialApplies({ ...(asr || {}), baseUrl }, provider, stored, providerField, hostField) ? stored : '';
}

/**
 * 保存时解析"目标槽位该用哪把凭据"，返回 { value, owned }（2026-10-02 全量审查定稿）：
 *   owned=true  → 这把凭据**明确属于这家**（活动槽的归属钉匹配，或映射里这家存过的）；
 *                 保存时可以把归属钉写回去、并补进映射。
 *   owned=false → 只是"归属未知的老凭据"（asrCredentialApplies 的兜底规则）：值照用，
 *                 但**不许认领** —— 不回写归属钉、不塞映射，否则会把别家的凭据洗成这家的
 *                 （migrateConfig 的注释警告的正是这条路：只读盘或用户重填时才记归属）。
 * 顺序：活动槽（明确属于目标）→ 这家存过的 → 归属未知的老单槽。活动槽在前是为了让
 * "手改过活动槽、映射里还留着旧值"时**用活动槽那把**（与运行时同一口径）。
 */
export function asrCredentialResolve(asr, kind, provider, baseUrl) {
  const slot = asrCredentialSlot(provider, baseUrl);
  const providerField = kind === 'apiKey' ? 'apiKeyProvider' : `${kind}Provider`;
  const hostField = kind === 'apiKey' ? 'apiKeyHost' : '';
  const stored = String(asr?.[kind] || '').trim();
  const pin = String(asr?.[providerField] || '').trim().toLowerCase();
  if (stored && pin && asrCredentialApplies({ ...(asr || {}), baseUrl }, provider, stored, providerField, hostField)) {
    return { value: stored, owned: true };
  }
  const fromMap = String(credentialSlotEntry(asr?.keys, slot)?.[kind] || '').trim();
  if (fromMap) return { value: fromMap, owned: true };
  if (stored && !pin) return { value: stored, owned: false };
  return { value: '', owned: false };
}

/**
 * 按**槽位字符串**取"明确属于这家"的凭据（只认映射 + 归属钉匹配的活动槽，不含"归属未知"兜底）。
 * 给控制台的「显示」端点用：表单里刚切换、还没保存时，回显的必须是**目标槽位**那把 ——
 * 拿已保存配置的解析结果会把上一家的明文显示在新服务名下（2026-10-02 全量审查）。
 */
export function asrCredentialForSlot(asr, kind, slot) {
  const s = String(slot || '').trim().toLowerCase();
  if (!s) return { value: '', owned: false };
  const sep = s.indexOf('|');
  const provider = sep === -1 ? s : s.slice(0, sep);
  const host = sep === -1 ? '' : s.slice(sep + 1);
  const baseUrl = host ? `https://${host}` : '';
  const providerField = kind === 'apiKey' ? 'apiKeyProvider' : `${kind}Provider`;
  const hostField = kind === 'apiKey' ? 'apiKeyHost' : '';
  const fromMap = String(credentialSlotEntry(asr?.keys, s)?.[kind] || '').trim();
  if (fromMap) return { value: fromMap, owned: true };
  const stored = String(asr?.[kind] || '').trim();
  const pin = String(asr?.[providerField] || '').trim().toLowerCase();
  if (!stored || !pin) return { value: '', owned: false };
  return asrCredentialApplies({ ...(asr || {}), baseUrl }, provider, stored, providerField, hostField)
    ? { value: stored, owned: true } : { value: '', owned: false };
}

/**
 * 按槽位名取条目，**只认自有属性**。槽位名来自 asr.provider / 地址主机，是外部可控的：
 * `keys['constructor']` 会取到 Object.prototype.constructor（一个函数），`keys['__proto__']`
 * 会取到原型对象 —— 既可能把函数源码当成"存过的凭据"，也可能让下游按数组处理时直接抛错
 * （2026-10-04 复审 P2 实测）。与 ttsKeyFor / imageGenKeyResolveCore 同一口径。
 */
function credentialSlotEntry(keys, slot) {
  if (!keys || typeof keys !== 'object' || !Object.hasOwn(keys, slot)) return null;
  const entry = keys[slot];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
}

/**
 * 哪些槽存过凭据、存的是哪几项（给界面切换预设时显示掩码用；只下发布尔口径，不下发明文）。
 * 形状：{ 'openai|api.siliconflow.cn': ['apiKey'], tencent: ['secretId', 'secretKey'] }
 */
export function asrKeySlots(asr) {
  const out = {};
  const push = (slot, kind, value) => {
    const s = String(slot || '').trim().toLowerCase();
    if (!s || !String(value || '').trim()) return;
    // ⚠️ 必须用自有属性判定：`out` 是普通对象，`out['constructor']` 会取到
    // Object.prototype.constructor（一个函数），接着 `list.includes` 报
    // "list.includes is not a function"，整个 /api/config 500（2026-10-04 复审 P2 实测：
    // 一次 POST 就能把坏值写进 config.json，之后每次读配置都 500，且没有任何 API 能删掉它）。
    // 槽位名来自 asr.provider —— 客户端可控，所以这里按"不可信键名"处理（与 ttsKeyFor 同款）。
    if (!Object.hasOwn(out, s)) out[s] = [];
    const list = out[s];
    if (!list.includes(kind)) list.push(kind);
  };
  for (const [slot, entry] of Object.entries(asr?.keys || {})) {
    for (const kind of ['apiKey', 'secretId', 'secretKey']) push(slot, kind, entry?.[kind]);
  }
  // 老配置的单槽（升级上来、还没在控制台重存过）：按各自记的归属算槽，
  // 让"切走再切回"能照常显示掩码（新写入路径会把它归档进映射）。
  const fallbackProvider = String(asr?.provider || '').trim().toLowerCase();
  const apiKeyProvider = String(asr?.apiKeyProvider || '').trim().toLowerCase() || fallbackProvider;
  const apiKeyHost = String(asr?.apiKeyHost || '').trim().toLowerCase() || asrEndpointHost(asr?.baseUrl);
  push(asrCredentialSlotOf(apiKeyProvider, apiKeyHost), 'apiKey', asr?.apiKey);
  push(asrCredentialSlotOf(asr?.secretIdProvider || fallbackProvider, ''), 'secretId', asr?.secretId);
  push(asrCredentialSlotOf(asr?.secretKeyProvider || fallbackProvider, ''), 'secretKey', asr?.secretKey);
  return out;
}

/** 外观 v2 的「主题配色」id → v3 的强调色 id（只用于迁移，别的地方不要用这张表）。 */
const LEGACY_PRESET_TO_ACCENT = { snow: 'indigo', mint: 'emerald', amber: 'amber', violet: 'violet', rose: 'rose' };

function migrateConfig(parsed) {
  // 顶层必须是对象：手改坏的 config.json 可能是 null / 5 / "x" / true（都是合法 JSON）。
  // 放它过去，下面 out.persona = … 那一步就会抛（Cannot create property 'persona' on number '5'），
  // 被 loadConfig 的 catch 吞掉后静默退回默认值、还会被持久化 —— 用户配置整份没了。
  if (!isPlainObject(parsed)) parsed = {};
  const out = structuredClone(parsed);
  // 人设段必须是对象：手改坏的 config.json 里可能是 "persona": "小鲸鱼" 这类标量或数组，
  // 放它过去会在保存时炸（Cannot create property 'behaviorProfile' on string），
  // 而控制台保存与 scripts/configure-linux.mjs 都要走这条路径 —— 恢复成默认人设对象。
  // 恢复时把 templateId 清空（未绑定）：坏字段不该被"治好"成绑定默认卡，那会在下一次
  // 保存时把正文换成默认卡的正文，比报错更难发现。roleText 是空串（故意"不挂卡"）不受影响。
  if (!isPlainObject(out.persona)) {
    out.persona = { ...structuredClone(DEFAULT_CONFIG.persona), templateId: '' };
  }
  // ── 人设模板绑定：老配置没有 persona.templateId ──
  // 必须在这里显式补空串（deepMerge 之前）：默认值里带的是 "xiaojingyu"，
  // 让默认值补上的话，老实例（例如选的是猫娘）载入后会被当成绑定了默认卡、正文被换掉。
  // 空串 = 未绑定（正文按自定义处理，不改动）；在控制台重选一次卡就会自动绑上。
  if (out.persona.templateId === undefined) out.persona.templateId = '';
  // ── 平台能力（2026-10-07 键拆细：读/写分离）──
  // 老配置里 avatarWrites 一个键同时管"换头像"和"改昵称/个性说明"。拆细后按老键回填：
  // 显式开过 avatarWrites=true 的实例，昵称也保持开着 —— 否则用户"开过换头像/改资料"的
  // 意图会被拆细静默收掉一半（保存一次控制台即固化）。
  if (isPlainObject(out.platform)) {
    if (out.platform.nicknameWrites === undefined && out.platform.avatarWrites === true) {
      out.platform.nicknameWrites = true;
    }
    // 拆细后新增的"写侧兄弟键"：老配置里那个伞键**被显式关掉**时，兄弟键也要跟着关 ——
    // 否则 deepMerge 会替老配置补上默认 true，等于"升级即悄悄扩权"（用户当初关掉
    // reactions/profileWrites/groupTools/groupFiles/albumRead 的意图被撕掉一半）。
    // 只在兄弟键**没存过**时回填：控制台保存过一次的 15 键配置永远不被改写
    // （2026-10-07 独立审计 P1）。
    for (const [oldKey, newKey] of [
      ['reactions', 'reactionsWrite'],
      ['profileWrites', 'remarkWrites'],
      ['groupTools', 'groupWrites'],
      ['groupFiles', 'groupFileSend'],
      ['albumRead', 'albumWrites']
    ]) {
      if (out.platform[newKey] === undefined && out.platform[oldKey] === false) out.platform[newKey] = false;
    }
    // perGroup / quotas 的坏形状先归一化：手改坏一个字符不许把整份配置带崩
    // （这两段是 2026-10-07 新增的嵌套结构，别的字段都没有这一层）。
    if (out.platform.perGroup !== undefined && !isPlainObject(out.platform.perGroup)) out.platform.perGroup = {};
    if (isPlainObject(out.platform.perGroup)) {
      for (const [gid, node] of Object.entries(out.platform.perGroup)) {
        if (!isPlainObject(node)) { delete out.platform.perGroup[gid]; continue; }
        // 只留"合法门控键 + 显式布尔值"：字符串 'true'、未知键（如把 readReceipts 写进按群）
        // 都在这里清掉，查找侧也就不必再兜第二遍。
        for (const [key, value] of Object.entries(node)) {
          if (typeof value !== 'boolean' || !PLATFORM_GATE_KEYS.includes(key)) delete node[key];
        }
      }
    }
    if (out.platform.quotas !== undefined && !isPlainObject(out.platform.quotas)) out.platform.quotas = {};
    // 配额键改名：avatarsPerDay → avatarsPerWeek（2026-10-07：换头像的窗口从"每天"改成"每周" ——
    // "每天最多 1 次"一周仍能换 7 次，不符合"按真人标准"）。老键的值搬过去再把老键删掉：
    // 留着它，控制台"留空 = 用默认"那条兜底会读到它，等于改不动这项。
    if (isPlainObject(out.platform.quotas)) {
      const carried = Number(out.platform.quotas.avatarsPerDay);
      if (out.platform.quotas.avatarsPerWeek === undefined && Number.isFinite(carried) && carried > 0) {
        out.platform.quotas.avatarsPerWeek = Math.max(1, Math.min(200, Math.floor(carried)));
      }
      delete out.platform.quotas.avatarsPerDay;
    }
  }
  // ── 省 Token 模式：老配置没有这个键 ──
  // 缺键/坏值一律按 off 处理（默认关闭，行为与升级前完全一致）；坏值不许把整份配置带崩。
  if (!isPlainObject(out.tokenSaver)) out.tokenSaver = { mode: 'off' };
  else out.tokenSaver.mode = normalizeTokenSaverMode(out.tokenSaver.mode);
  // identityPilot 及子段同样可能是手改坏的标量（true / "off" / 5）：直接写 .mode 一样会抛，
  // 落进同一个"静默退回默认值"的坑，所以先归一化成对象再谈迁移。
  if (out.identityPilot !== undefined && !isPlainObject(out.identityPilot)) out.identityPilot = {};
  if (out.identityPilot && out.identityPilot.friendProposal !== undefined && !isPlainObject(out.identityPilot.friendProposal)) {
    out.identityPilot.friendProposal = {};
  }
  if (
    out.identityPilot?.friendProposal
    && out.identityPilot.friendProposal.mode == null
  ) {
    // The experiment has moved to controller-owned message triggers. Existing
    // pilot configs without a mode follow the new path; "prompt" remains an
    // explicit rollback mode in the friend management page.
    out.identityPilot.friendProposal.mode = 'triggered';
  }
  // ── 响应滑条：一次性把"四段式滑条"迁移成"滑条值就是概率" ──
  // ⚠️ 必须在这里做（deepMerge(DEFAULT_CONFIG, ...) **之前**）：默认值里已经带了
  //    sliderMode: 'probability'，合并之后就没法区分"老文件没有这个键"和"已经是新语义"了
  //    —— 放在 updateConfig 里判断会让迁移永远不执行（审查发现的坑）。
  // 老口径：位置 ≤20（1/2 档）不掷骰子 → 0%；20~90 线性；≥90（4 档全响应）→ 100%。
  if (out.store && typeof out.store === 'object' && out.store.sliderMode !== 'probability') {
    const store = out.store;
    const hasPos = store.contextSliderPos !== undefined && store.contextSliderPos !== null;
    const probability = hasPos
      ? legacySliderToProbability(store.contextSliderPos)
      : legacyTierToProbability(store.contextTier, store.randomPercent);
    const derived = sliderToTier(probability);
    const groupSliderPos = {};
    for (const [groupId, pos] of Object.entries(store.groupSliderPos || {})) {
      groupSliderPos[groupId] = legacySliderToProbability(pos);
    }
    out.store = {
      ...store,
      sliderMode: 'probability',
      contextSliderPos: probability,
      contextTier: derived.tier,
      randomPercent: derived.randomPercent,
      groupSliderPos
    };
  }
  if (out.wakeDelayMinMs == null && out.wakeDelayMaxMs == null && out.wakeDelayMs != null) {
    const legacy = Math.max(0, Number(out.wakeDelayMs) || 0);
    if (legacy === 10000) {
      out.wakeDelayMinMs = 8000;
      out.wakeDelayMaxMs = 12000;
    } else {
      out.wakeDelayMinMs = legacy;
      out.wakeDelayMaxMs = legacy;
    }
  }
  if (!out.onebot && out.snowluma) {
    out.onebot = {
      wsUrl: out.snowluma.wsUrl,
      httpUrl: out.snowluma.httpUrl,
      accessToken: out.snowluma.accessToken,
      httpAccessToken: out.snowluma.httpAccessToken
    };
  }
  if (!out.providerKeys && out.dshProviderKeys) out.providerKeys = out.dshProviderKeys;
  delete out.snowluma;
  delete out.dshProviderKeys;
  delete out.providersSourceYaml;
  delete out.providersImported;
  delete out.telemetry;
  if (out.server) {
    delete out.server.autoStart;
    delete out.server.closeToTray;
  }
  if (out.ui?.theme === '?') out.ui.theme = 'dark';
  // 外观 v2 → v3（2026-10-08）：v2 只有"主题配色"（ui.preset）一个抽象，v3 把它拆成
  // "表面色板"（scheme）与"强调色"（accentPreset）两条轴 —— 老值按同一份色相搬到 accentPreset，
  // 然后把 preset 删掉。留着它就会出现两个真源：界面读 accentPreset，存档里还躺着一个 preset，
  // 而保存路径（ui/core/appearance.js 的 appearancePatch）根本不写 preset，它只会变成一具干尸。
  if (out.ui && typeof out.ui === 'object') {
    if (out.ui.accentPreset == null && LEGACY_PRESET_TO_ACCENT[out.ui.preset]) {
      out.ui.accentPreset = LEGACY_PRESET_TO_ACCENT[out.ui.preset];
    }
    delete out.ui.preset;
    // v2 的 avatarsPerDay 式"越界历史值"不用在这里修：resolveAppearance 已经是那条唯一入口，
    // 它会夹紧；这里只处理"字段改名/消失"，不做取值规整。
  }
  // ── 派生位 has* 的剥离要覆盖**每一段** ──
  // sanitizeConfigSecrets 会给任何密钥类字段生成 hasXxx；GET /api/config 把它们一起下发，
  // "整份配置展开回传"的客户端就会把它们送回来。不剥的话保存一次就落进 config.json，
  // 往后每份配置都带着上个版本算出来的结论。原先只覆盖了 webSearch/tts/asr/imageGen，
  // 漏了 api 与 providers[]（2026-10-04 复审 P3 实测：api.hasApiKey / api.hasKey /
  // providers[].hasKey 全部落盘）。官方界面逐字段构造 patch，不会回传这些位，
  // 但剥离规则按"所有段"统一，不留例外。
  for (const sec of ['api', 'conversation', 'server', 'onebot', 'tts', 'asr', 'imageGen', 'webSearch', 'identityPilot', 'sticker']) {
    if (isPlainObject(out[sec])) {
      for (const key of Object.keys(out[sec])) if (/^has[A-Z]/.test(key)) delete out[sec][key];
    }
  }
  if (Array.isArray(out.providers)) {
    for (const item of out.providers) {
      if (isPlainObject(item)) for (const key of Object.keys(item)) if (/^has[A-Z]/.test(key)) delete item[key];
    }
  }
  // ── 带凭据映射的三个段：手改坏成标量/数组时归一化成对象，段内的 keys 同理 ──
  // （`{ ...'sk-x' }` 会把字符串展开成字符索引的垃圾映射；与 persona/identityPilot 同款兜底。
  //   2026-10-02 全量审查：非对象形态的 keys 还会绕过控制台下发的"整包清空"——那条单独在
  //   secret-keys.js 修，这里保证落盘/合并路径拿到的一定是对象。）
  for (const sec of ['asr', 'tts', 'imageGen']) {
    if (out[sec] !== undefined && !isPlainObject(out[sec])) out[sec] = {};
    if (isPlainObject(out[sec]) && out[sec].keys !== undefined && !isPlainObject(out[sec].keys)) out[sec].keys = {};
  }
  // webSearch 同理：sanitize 生成的 hasApiKey 属于派生位，回传展开后会跟着落进 config.json
  // （界面每次展开 { ...c.webSearch } 都会带上；2026-10-03 全量审查）
  if (isPlainObject(out.webSearch)) {
    for (const [key, value] of Object.entries(out.webSearch)) {
      if (/^has[A-Z]/.test(key)) delete out.webSearch[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isPlainObject(item)) for (const sub of Object.keys(item)) if (/^has[A-Z]/.test(sub)) delete item[sub];
        }
      } else if (isPlainObject(value)) {
        for (const sub of Object.keys(value)) if (/^has[A-Z]/.test(sub)) delete value[sub];
      }
    }
  }
  // ── 语音合成（tts）──
  if (isPlainObject(out.tts)) {
    // 派生位不落盘：hasApiKey 是 sanitize 生成的、keyServices/currentService 是 GET 下发的，
    // 而 sanitize 生成的 hasApiKeyService 等一律用 has[A-Z] 通配兜住（与下面 asr/imageGen 两段同口径；
    // 原来 tts 这一段整个缺，别处写入会把它们持久化）
    for (const key of Object.keys(out.tts)) if (/^has[A-Z]/.test(key)) delete out.tts[key];
    for (const key of ['keyServices', 'currentService']) delete out.tts[key];
    if (out.tts.keys !== undefined && !isPlainObject(out.tts.keys)) out.tts.keys = {};
  }
  // ── 语音转写（asr）──
  if (isPlainObject(out.asr)) {
    // 剔掉运行时结论（见 ASR_DERIVED_KEYS 的说明），连 sanitizeConfig 生成的 hasXxx 一起。
    // ⚠️ 这里**不**补凭据归属：合并路径上补会把"归属未知的老凭据"洗成当前服务名下的，
    // 恰好是"把 A 家的 Key 当成 B 家的"那条路。归属只在读盘（loadConfig）或用户重填时记。
    for (const key of ASR_DERIVED_KEYS) delete out.asr[key];
    for (const key of Object.keys(out.asr)) if (/^has[A-Z]/.test(key)) delete out.asr[key];
  }
  // ── 图片生成（imageGen）──
  if (isPlainObject(out.imageGen)) {
    // 同一条道理：GET /api/config 下发的 hasApiKey/available 是"给界面看的派生结论"，
    // 前端会把整份配置展开成 patch 回传 —— 不在这里剔掉，保存一次就落进 config.json，
    // 往后每份配置都带着上个版本算出来的结论（2026-09-30 审查，真实往返复现）。
    for (const key of Object.keys(out.imageGen)) {
      if (/^has[A-Z]/.test(key) || IMAGEGEN_DERIVED_KEYS.includes(key)) delete out.imageGen[key];
    }
    // ⚠️ 这里**不**补归属钉（与上面 asr 同一条纪律，2026-10-04 复审 P2）：合并路径上补会把
    // "归属未知的老凭据"绑到**这次 patch 之后**的地址上。路由层刻意不认领那把（resolved.owned
    // 为 false 就只填值、不写钉），转到这里却被无条件认领 —— 用户把地址换成别家、没填新 Key
    // 保存一次，旧 Key 就被静默绑到新主机，此后 resolveImageGenAuth 会把它发给新主机。
    // 读盘那次该补的照旧补（见 loadConfig 里的 pinUnboundImageGenKey），那时地址没被这次改动带偏。
  }
  // 槽位条目被手改成标量（"keys":{"tencent":"SCALAR"}）时，各处 `{...entry}` 会摊成
  // {0:'S',1:'C',…} 的字符索引垃圾。这里直接把非对象条目归一成 {}，读写两侧都干净
  //（migrateConfig 是所有写入路径的必经口，读盘也走它；2026-10-04 复审 P2）。
  if (isPlainObject(out.asr?.keys)) {
    for (const [slot, entry] of Object.entries(out.asr.keys)) {
      if (!isPlainObject(entry)) out.asr.keys[slot] = {};
    }
  }
  return out;
}

/**
 * 读盘这一次给"有 Key 却没记归属"的老配置补记归属（与 pinStoredAsrCredentials 同款）。
 * 只在读盘做、合并路径不做 —— 合并时地址可能刚被这次 patch 改过，补记等于把老凭据绑到新主机。
 * 入口条件与 pinStoredAsrCredentials 同款：确实有 Key、确实没记归属。
 */
function pinUnboundImageGenKey(imageGen, apiBaseUrl) {
  if (!isPlainObject(imageGen)) return '';
  if (!String(imageGen.apiKey || '').trim()) return '';
  if (String(imageGen.apiKeyHost || '').trim()) return String(imageGen.apiKeyHost);
  return pinImageGenKeyHost(imageGen, apiBaseUrl);
}

/**
 * 给"有凭据、还没记归属"的老配置补上归属（凭据 → 服务，OpenAI 兼容的再补地址主机）。
 * 两个调用点，口径不同：
 *   · migrateConfig（每次合并都会跑）：只补没记过的（onlyUnbound）—— 否则客户端传来的空值
 *     会把"为别家地址存的"凭据悄悄改绑到当前地址上（2026-09-26 审查踩到过）。
 *   · loadConfig（只跑一次，读的是本机配置文件）：把所有能补的都补齐，老实例升级后
 *     "换服务/换地址要重填"的防线立刻生效。
 */
/**
 * 哪个凭据字段"哪家会用到"（与 config.js 的 asrConfigured 同一套口径）。
 * 补记归属时要看这张表：把一把 secretKey 记到 openai/volc 名下毫无意义，
 * 反而会挡住它真正的主人（腾讯/讯飞/百度），让用户白重填一次。
 */
const ASR_CREDENTIAL_PROVIDERS = {
  apiKey: ['volc', 'openai', 'aliyun', 'baidu', 'iflytek'],
  secretId: ['tencent'],
  secretKey: ['tencent', 'iflytek', 'baidu']
};

/**
 * 给"有凭据、还没记归属"的老配置补上归属（凭据 → 服务，OpenAI 兼容的再补地址主机）。
 * **只在读盘时调用**（loadConfig）：配置合并路径上补会把"归属未知的老凭据"洗成当前服务名下的，
 * 恰好就是"把 A 家的 Key 当成 B 家的"那条路（2026-09-26 审查踩到过）。之后归属只由用户重填更新。
 */
/**
 * "默认 provider 从 local 改成 openai"之后的一次性迁移（只在读盘时调用）。
 *
 * 为什么需要它：没显式存过 `asr.provider` 的老配置，语义会从"本机转写"变成"API Key 托管服务" ——
 * 本机装了 whisper 的实例会静默失效（2026-09-26 审查 P1）。
 * 规则：看得出装过本机转写（<数据目录>/asr 或配置里写了 localBin/localModel）→ local；
 * 否则用新默认，并把**归属未知**的凭据记到 `local` 名下 —— local 用不到凭据，
 * 于是它不会被发到用户从没选过的预置服务去（同一次审查 P1 的另一半）。
 */
export function applyAsrProviderFallback(asr, { localInstalled = false } = {}) {
  if (!isPlainObject(asr)) return '';
  asr.provider = localInstalled ? 'local' : ASR_DEFAULT_PROVIDER;
  // 这次 provider 是"升级默认值"而不是用户选的：记一个标记，让 asrApiKey 不要拿
  // 部署级的环境变量 Key 去请求一个用户从没选过的服务（2026-09-26 审查 P2）。
  // 用户从控制台保存一次（界面总会带上显式的 provider）就会清掉它。
  asr.providerDefaulted = true;
  if (!localInstalled) {
    for (const [field, providerField] of [
      ['apiKey', 'apiKeyProvider'], ['secretId', 'secretIdProvider'], ['secretKey', 'secretKeyProvider']
    ]) {
      if (String(asr[field] || '').trim() && !String(asr[providerField] || '').trim()) {
        asr[providerField] = 'local';
      }
    }
  }
  return asr.provider;
}

export function pinStoredAsrCredentials(asr, providerValue) {
  if (!isPlainObject(asr)) return;
  const provider = String(providerValue || '').trim().toLowerCase();
  if (!provider) return;                       // provider 未知：宁可留着"未绑定"，也不瞎记归属
  const host = asrEndpointHost(asr.baseUrl);
  const pin = (field, providerField, hostField = '') => {
    if (!String(asr[field] || '').trim()) return;
    if (!(ASR_CREDENTIAL_PROVIDERS[field] || []).includes(provider)) return;   // 这家不用它 → 不记
    const bound = String(asr[providerField] || '').trim();
    if (!bound) {
      asr[providerField] = provider;           // 第一次记归属
      // 归属与地址一起记：硅基流动/Groq/OpenAI 这几家 provider 都是 openai，
      // 不记地址的话换预设就不会要求重填，旧 Key 会被发到新域名
      if (hostField && provider === 'openai' && host) asr[hostField] = host;
      return;
    }
    // 已有归属：老配置里 provider 记了、但那时还没有 apiKeyHost 字段 —— 补上缺的主机
    if (hostField && bound === 'openai' && host && !String(asr[hostField] || '').trim()) {
      asr[hostField] = host;
    }
  };
  pin('apiKey', 'apiKeyProvider', 'apiKeyHost');
  pin('secretId', 'secretIdProvider');
  pin('secretKey', 'secretKeyProvider');
}

/**
 * 记下"这把图片生成的 Key 是给哪家的地址存的"，供后续判断"换了地址还能不能拿它发请求"。
 * 与 asr 的 apiKeyProvider/apiKeyHost 是同一条道理：把 A 家的 Key 发给 B 家是**静默事故**
 * （不会报错，只会在别家后台留下一条 401 或一条意外计费）。只在真的提交了新 Key 时调用。
 * 地址留空＝跟聊天模型同一家，按模型地址记；地址解析不出主机就记空串（= 未绑定）。
 */
export function pinImageGenKeyHost(imageGen, apiBaseUrl) {
  if (!isPlainObject(imageGen)) return '';
  const base = String(imageGen.baseUrl || '').trim() || String(apiBaseUrl || '').trim();
  imageGen.apiKeyHost = asrEndpointHost(base);
  return imageGen.apiKeyHost;
}

/**
 * 取"某个主机上存过的图片生成 Key"（活动槽归属匹配优先，其次 keys 映射；老配置只有单槽
 * apiKey + apiKeyHost，"没记归属"的那把按"当前地址能用"算 —— 与 imageGenKeyApplies 一致）。
 * 运行时/判定端读它；"保存时该用哪把、能不能认领"用 imageGenKeyResolve（2026-10-02 全量审查拆开）。
 */
/**
 * 保存时解析"目标主机该用哪把 Key"，返回 { value, owned }（与 asrCredentialResolve 同款）：
 *   owned=true  → 明确属于这个主机（活动槽的 apiKeyHost 就是它，或映射里这家存过的）→ 可写回钉；
 *   owned=false → "没记归属"的老单槽兜底：值照用，但**不认领**（不写 apiKeyHost、不塞映射）。
 */
export function imageGenKeyResolve(imageGen, host) {
  return imageGenKeyResolveCore(imageGen, host, { allowUnbound: true });
}

/** 只认"明确属于这个主机"的那把（控制台「显示」端点给"表单里换到别的主机"时用）。 */
export function imageGenKeyOwnedBy(imageGen, host) {
  return imageGenKeyResolveCore(imageGen, host, { allowUnbound: false }).value;
}

function imageGenKeyResolveCore(imageGen, host, { allowUnbound }) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return { value: '', owned: false };
  const active = String(imageGen?.apiKey || '').trim();
  const boundHost = String(imageGen?.apiKeyHost || '').trim().toLowerCase();
  if (active && active !== '******' && boundHost && boundHost === h) return { value: active, owned: true };
  // 用**自有属性**读映射：`keys['constructor']` 会命中原型链，把函数的源码当"这家存过的 Key"
  // （2026-10-02 推前复审实测：host=constructor 会返回 "function Object() { [native code] }" 并标 owned）
  const map = imageGen?.keys;
  const fromMap = map && typeof map === 'object' && Object.hasOwn(map, h) ? String(map[h] || '').trim() : '';
  if (fromMap) return { value: fromMap, owned: true };
  if (allowUnbound && active && active !== '******' && !boundHost) return { value: active, owned: false };
  return { value: '', owned: false };
}

/** 哪些主机存过 Key（给界面在切换预设时显示掩码用；只下发布尔口径，不下发明文）。 */
export function imageGenKeyHosts(imageGen) {
  const hosts = Object.entries(imageGen?.keys || {})
    .filter(([, v]) => String(v || '').trim())
    .map(([k]) => String(k).trim().toLowerCase())
    .filter(Boolean);
  const legacyHost = String(imageGen?.apiKeyHost || '').trim().toLowerCase();
  if (legacyHost && String(imageGen?.apiKey || '').trim() && !hosts.includes(legacyHost)) hosts.push(legacyHost);
  return hosts;
}

/** 真对象判定（排除 null / 数组 / 标量）——人设段这类"必须是对象"的字段用它兜底。 */
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    // ⚠️ X 必须是**对象**。X 是 null / 标量 / 数组时，整键**忽略**（当作"这一项没给"）：
    // 替换会把整个键变成那种值，凭据段于是被清成 null/""—— 一次 `{"asr":{"__replace__":null}}`
    // 就静默清空整段（keys 映射 + 单槽 Key + 归属钉一起没了），而 HTTP 仍返回 200。
    // 与其默默毁掉一整段凭据，不如什么都不做（2026-10-04 复审 P3）。
    // ⚠️ 必须 continue 而不是落回下面的合并分支：落回去会把 `__replace__` 当普通键合进去，
    // 于是 `{keys:{__replace__:'sk-leaked'}}` 变成 `{keys:{__replace__:'sk-leaked'}}` ——
    // 那个密钥字符串反而**留在配置里**了（config.test.mjs 钉的就是这一条）。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      if (!isPlainObject(value.__replace__)) continue;
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = migrateConfig(JSON.parse(text));
    const merged = deepMerge(DEFAULT_CONFIG, parsed);
    // ── provider 迁移（2026-09-26）──
    // 默认 provider 从 local 改成 openai 之后，**没显式存过 provider** 的老配置语义会变：
    // 本机装了 whisper 的实例会从"能用"变成"没配齐"（静默失效，2026-09-26 审查 P1）。
    // 按"能不能看出装过本机转写"回填：装了 → local；没装 → 保持新默认（openai）。
    const declaredProvider = String(parsed?.asr?.provider || '').trim().toLowerCase();
    if (!ASR_PROVIDERS.includes(declaredProvider)) {
      // 判"这台机器装过本机转写吗"**必须用运行期同一套解析**（配置 > 环境变量 > <数据目录>/asr、
      // 仓库 models/、~/.cache/whisper.cpp、PATH 里的 whisper-cli）——只认安装脚本落点会漏掉
      // PATH/标准目录装的用户，把他们静默切成 openai（2026-09-26 审查 P1）。
      const localCfg = { asr: (parsed && parsed.asr) || {} };
      const localLooksInstalled = asrLocalModel(localCfg) !== '' && Boolean(findWhisperBinSync(localCfg));
      const next = applyAsrProviderFallback(merged.asr, { localInstalled: localLooksInstalled });
      console.warn(`[config] 语音转写没记过 provider：按本机 ${localLooksInstalled ? '装过 whisper.cpp → local' : '没装 whisper.cpp → 新默认 ' + next}`
        + '（用户从控制台保存一次即固化）');
    }
    // 读盘这一次把老配置的凭据归属补齐（provider + OpenAI 兼容的地址主机）：
    // 升级后"换服务/换地址要重填"的防线立刻生效，而不是等用户碰一次设置才生效
    const asrProviderValue = String(merged.asr?.provider || '').trim().toLowerCase();
    if (asrProviderValue) pinStoredAsrCredentials(merged.asr, asrProviderValue);
    // 图片生成同款：老配置只有单槽 apiKey、没有 apiKeyHost，不补记的话升级后"换个预设"就拿旧
    // Key 去撞新地址 —— 而那在升级前一直是好用的。只在读盘补，合并路径不补（见 migrateConfig）
    pinUnboundImageGenKey(merged.imageGen, merged.api?.baseUrl);
    applyPersonaTemplate(merged);   // 绑了内置卡就按 roles/*.md 刷新正文（卡文件是唯一来源）
    return merged;
  } catch (error) {
    // 读不动/解析不了就**先把原件留一份**再退回默认值：config.js 的 stabilize 会把结果持久化，
    // 原来这里只是静默返回默认配置 —— 手改坏一个字符，apiKey、白名单、人设就整份被覆盖掉了。
    if (fs.existsSync(CONFIG_FILE)) {
      try { fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.broken-${Date.now()}`); } catch { /* 备份失败不阻断启动 */ }
      console.warn('[config] 读取 config.json 失败，原文件已备份成 config.json.broken-*：', error?.message ?? error);
    }
    const fresh = structuredClone(DEFAULT_CONFIG);
    applyPersonaTemplate(fresh);
    return fresh;
  }
}

let currentConfig = null;
let saveTimers = new Map();
const timeControlListeners = new Set();

export function onTimeControlChange(listener) {
  timeControlListeners.add(listener);
  return () => timeControlListeners.delete(listener);
}

function notifyTimeControlChange() {
  for (const listener of timeControlListeners) listener();
}

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 所有实验画像能力的唯一总闸门。 */
export function identityPilotEnabled(cfg = getConfig()) {
  return cfg?.identityPilot?.enabled === true;
}

export function friendProposalEnabled(cfg = getConfig()) {
  return identityPilotEnabled(cfg) && cfg?.identityPilot?.friendProposal?.enabled === true;
}

export function triggeredFriendProposalEnabled(cfg = getConfig()) {
  return friendProposalEnabled(cfg)
    && cfg?.identityPilot?.friendProposal?.mode === 'triggered';
}

export function promptFriendProposalEnabled(cfg = getConfig()) {
  return friendProposalEnabled(cfg)
    && cfg?.identityPilot?.friendProposal?.mode !== 'triggered';
}

export function incomingFriendRequestEnabled(cfg = getConfig()) {
  return identityPilotEnabled(cfg)
    && cfg?.identityPilot?.incomingFriendRequest?.enabled === true;
}

export function friendRequestDispatchEnabled(cfg = getConfig()) {
  return friendProposalEnabled(cfg)
    && cfg?.identityPilot?.friendProposal?.activeDispatchEnabled === true;
}

export function slangPilotEnabled(cfg = getConfig()) {
  return cfg?.slangPilot?.enabled === true;
}

export function incidentPilotEnabled(cfg = getConfig()) {
  return cfg?.incidentPilot?.enabled === true;
}

/** 控制台可粘贴的长文本上界（见 updateConfig 里的说明）。 */
const PERSONA_ROLE_TEXT_MAX = 20000;
const PERSONA_CUSTOM_RULES_MAX = 4000;
const MEMBER_NOTE_MAX = 200;
const MEMBER_NOTES_MAX = 2000;

/** 备注表归一化：值去空白并截断，丢空值，条目数设上限（防止备注表无限膨胀）。 */
function clampMemberNotes(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  let count = 0;
  for (const [key, note] of Object.entries(value)) {
    if (count >= MEMBER_NOTES_MAX) break;
    const text = String(note ?? '').trim();
    if (!text) continue;
    out[String(key)] = text.slice(0, MEMBER_NOTE_MAX);
    count += 1;
  }
  return out;
}

/** 更新并持久化配置（深合并到当前值：对象字段递归合并、数组整体替换；
 *  映射型字段（如 api.modelPrices）要"删掉旧键"时传 `{ __replace__: X }` 整体替换）。 */
export function updateConfig(patch) {
  // 人设段传了 null / 数组 / 标量（手写 API 调用、坏客户端）时当"没改人设"处理：
  // 直接把这个键从 patch 里摘掉，免得它在合并/迁移里被当成"恢复默认人设"，甚至抛错。
  const safePatch = isPlainObject(patch) ? { ...patch } : {};
  if ('persona' in safePatch && !isPlainObject(safePatch.persona)) delete safePatch.persona;
  // 三个带凭据的段同理：它们被 migrateConfig 归一化成 {}，等于**整段清空**（连 keys 映射与
  // 归属钉一起丢），而不是"这次没改"。坏输入最该被忽略，不该当成用户要求清空（2026-10-03 全量审查）。
  for (const sec of ['asr', 'tts', 'imageGen']) {
    if (sec in safePatch && !isPlainObject(safePatch[sec])) delete safePatch[sec];
  }
  // 下面这些段是直接写属性用的（next.api.maxRunTokens = …），客户端送来标量或数组时
  // 会抛 TypeError（ESM 是严格模式）→ 整个 /api/config 返回 500。坏输入最该被忽略，
  // 不该把整次保存带崩（2026-10-04 复审 P2）。
  for (const sec of ['api', 'conversation', 'dailyMoments', 'qzoneInteractions']) {
    if (sec in safePatch && !isPlainObject(safePatch[sec])) delete safePatch[sec];
  }
  const next = migrateConfig(deepMerge(getConfig(), safePatch));
  const oldTimeControl = JSON.stringify(getConfig().timeControl);
  // 人设绑定与正文的优先级，只在配置保存这一层定：
  //   1) patch 里写了 roleText 但没给 templateId = 手写正文 → 自动解绑，正文按你写的来；
  //   2) patch 里给了 templateId（控制台选卡）→ 卡文件说了算，正文按 roles/*.md 刷新；
  //   3) 两者都没给（改别的字段、升级带的正文更新）→ 绑着就刷新。
  const patchPersona = safePatch.persona ?? {};
  if (patchPersona.templateId === undefined && patchPersona.roleText !== undefined) {
    next.persona.templateId = '';
  }
  next.persona.behaviorProfile = normalizeBehaviorProfile(next.persona.behaviorProfile);
  if (patchPersona?.templateId !== undefined || patchPersona?.roleText === undefined) {
    applyPersonaTemplate(next);
  }
  // 长文本字段在"写入这一侧"设上界（放在 applyPersonaTemplate 之后，保证最终值也被夹住）：
  // roleText / customRules 每次请求都会进系统提示词，memberNotes 会进控制台回包与 config.json，
  // 而 /api/config 唯一的兜底是 2MB 请求体 —— 一次粘贴事故就能把模型上下文打爆，
  // 并让之后每次保存都搬运这几百 KB（2026-09-29 审查 P2）。
  // 触发条件是"这次 patch 带了该字段"：不带就不动它，所以无关保存不会改写存量值。
  // 注意 memberNotes 是按整张表夹的：控制台每次保存都整表回传，做不到只夹被改的那个键。
  if (patchPersona.roleText !== undefined && typeof next.persona.roleText === 'string') {
    next.persona.roleText = next.persona.roleText.slice(0, PERSONA_ROLE_TEXT_MAX);
  }
  if (patchPersona.customRules !== undefined && typeof next.persona.customRules === 'string') {
    next.persona.customRules = next.persona.customRules.slice(0, PERSONA_CUSTOM_RULES_MAX);
  }
  if ('memberNotes' in safePatch) next.memberNotes = clampMemberNotes(next.memberNotes);
  next.tokenSaver = { ...(next.tokenSaver || {}), mode: normalizeTokenSaverMode(next.tokenSaver?.mode) };
  next.timeControl = normalizeTimeControl(next.timeControl);
  next.dailyMoments.scheduleWindows = normalizeMomentWindows(next.dailyMoments.scheduleWindows);
  if (!['observe', 'active'].includes(next.runtime?.mode)) throw new Error('Invalid runtime mode');
  if (!['legacy', 'threaded', 'lifecycle'].includes(next.conversation?.mode)) {
    throw new Error('Invalid conversation mode');
  }
  for (const mode of Object.values(next.conversation?.groupModes || {})) {
    if (!['legacy', 'threaded', 'lifecycle'].includes(mode)) {
      throw new Error('Invalid group conversation mode');
    }
  }
  next.api.maxRunTokens = Math.min(
    1000000,
    Math.max(20000, Math.round(Number(next.api.maxRunTokens) || DEFAULT_CONFIG.api.maxRunTokens))
  );
  next.api.contextWindowTokens = Math.min(
    2000000,
    Math.max(
      16000,
      Math.round(Number(next.api.contextWindowTokens) || DEFAULT_CONFIG.api.contextWindowTokens)
    )
  );
  let wakeMin = Math.min(
    20000,
    Math.max(0, Math.round(Number(next.wakeDelayMinMs) || 0))
  );
  let wakeMax = Math.min(
    20000,
    Math.max(0, Math.round(Number(next.wakeDelayMaxMs) || 0))
  );
  if (wakeMin > wakeMax) [wakeMin, wakeMax] = [wakeMax, wakeMin];
  next.wakeDelayMinMs = wakeMin;
  next.wakeDelayMaxMs = wakeMax;
  next.wakeDelayMs = Math.round((wakeMin + wakeMax) / 2);
  next.conversation.lifecycleRolloverInputTokens = Math.min(
    500000,
    Math.max(
      5000,
      Math.round(
        Number(next.conversation.lifecycleRolloverInputTokens)
        || DEFAULT_CONFIG.conversation.lifecycleRolloverInputTokens
      )
    )
  );
  const interactions = next.qzoneInteractions || {};
  next.qzoneInteractions = {
    ...interactions,
    enabled: interactions.enabled === true,
    startupCatchup: interactions.startupCatchup === true,
    feedIntervalMinutes: Math.min(1440, Math.max(5, Number(interactions.feedIntervalMinutes) || 60)),
    replyIntervalMinutes: Math.min(1440, Math.max(1, Number(interactions.replyIntervalMinutes) || 5)),
    feedFetchCount: Math.min(50, Math.max(1, Number(interactions.feedFetchCount) || 30)),
    ownPostCount: Math.min(30, Math.max(1, Number(interactions.ownPostCount) || 10)),
    maxAgeHours: Math.min(720, Math.max(1, Number(interactions.maxAgeHours) || 72)),
    maxBatchItems: Math.min(50, Math.max(1, Number(interactions.maxBatchItems) || 20)),
    maxLikesPerRun: Math.min(20, Math.max(0, Number(interactions.maxLikesPerRun) || 0)),
    maxCommentsPerRun: Math.min(10, Math.max(0, Number(interactions.maxCommentsPerRun) || 0)),
    maxRepliesPerRun: Math.min(20, Math.max(0, Number(interactions.maxRepliesPerRun) || 0)),
    commentMaxChars: Math.min(200, Math.max(5, Number(interactions.commentMaxChars) || 60)),
    replyMaxChars: Math.min(200, Math.max(5, Number(interactions.replyMaxChars) || 60)),
    allowLikes: interactions.allowLikes !== false,
    allowComments: interactions.allowComments !== false,
    allowReplies: interactions.allowReplies !== false,
    actionDelayMinMs: Math.min(10000, Math.max(0, Number(interactions.actionDelayMinMs) || 0)),
    actionDelayMaxMs: Math.min(15000, Math.max(0, Number(interactions.actionDelayMaxMs) || 0)),
    maxDecisionRounds: Math.min(5, Math.max(1, Number(interactions.maxDecisionRounds) || 3))
  };
  const identity = next.identityPilot || {};
  const incomingFriendRequest = identity.incomingFriendRequest || {};
  const friendProposal = identity.friendProposal || {};
  const triggered = friendProposal.triggered || {};
  const rawWeights = triggered.weights || {};
  const finiteNumber = (value, fallback) => (
    Number.isFinite(Number(value)) ? Number(value) : fallback
  );
  const clampNumber = (value, min, max, fallback) => Math.min(
    max,
    Math.max(min, finiteNumber(value, fallback))
  );
  const clampInteger = (value, min, max, fallback) =>
    Math.round(clampNumber(value, min, max, fallback));
  const weights = {
    quality: clampInteger(rawWeights.quality, 0, 100, 40),
    interest: clampInteger(rawWeights.interest, 0, 100, 30),
    reciprocity: clampInteger(rawWeights.reciprocity, 0, 100, 20),
    stability: clampInteger(rawWeights.stability, 0, 100, 10)
  };
  if (Object.values(weights).reduce((sum, value) => sum + value, 0) !== 100) {
    throw new Error('主动好友评估权重合计必须为 100');
  }
  next.identityPilot = {
    ...identity,
    enabled: identity.enabled === true,
    graduated: identity.graduated === true,
    incomingFriendRequest: {
      ...incomingFriendRequest,
      enabled: incomingFriendRequest.enabled === true,
      autoWhitelist: incomingFriendRequest.autoWhitelist !== false,
      maxPending: Math.min(
        500,
        Math.max(1, Math.round(Number(incomingFriendRequest.maxPending) || 50))
      )
    },
    friendProposal: {
      ...friendProposal,
      enabled: friendProposal.enabled === true,
      graduated: friendProposal.graduated === true,
      activeDispatchEnabled: friendProposal.enabled === true
        && friendProposal.activeDispatchEnabled === true,
      ownerUin: /^\d{5,15}$/.test(String(friendProposal.ownerUin || '').trim())
        ? String(friendProposal.ownerUin).trim()
        : '',
      mode: friendProposal.mode === 'prompt' ? 'prompt' : 'triggered',
      minMessageCount: Math.min(
        10000,
        Math.max(1, Math.round(Number(friendProposal.minMessageCount) || 50))
      ),
      cooldownDays: Math.min(
        365,
        Math.max(1, Math.round(Number(friendProposal.cooldownDays) || 30))
      ),
      maxPending: Math.min(
        100,
        Math.max(1, Math.round(Number(friendProposal.maxPending) || 10))
      ),
      triggered: {
        ...triggered,
        probability: clampNumber(triggered.probability, 0, 1, 0.05),
        historyDays: clampInteger(triggered.historyDays, 1, 365, 30),
        minMessages: clampInteger(triggered.minMessages, 0, 10000, 50),
        minActiveDays: clampInteger(triggered.minActiveDays, 0, 365, 3),
        minDirectExchanges: clampInteger(triggered.minDirectExchanges, 0, 1000, 3),
        maxTriggerAgeMinutes: clampInteger(
          triggered.maxTriggerAgeMinutes,
          1,
          1440,
          10
        ),
        friendStatusMaxAgeMinutes: clampInteger(
          triggered.friendStatusMaxAgeMinutes,
          1,
          1440,
          15
        ),
        drawCooldownMinutes: clampInteger(triggered.drawCooldownMinutes, 1, 10080, 30),
        maxDrawsPerUserPerDay: clampInteger(
          triggered.maxDrawsPerUserPerDay,
          1,
          1000,
          6
        ),
        maxReviewsPerDay: clampInteger(triggered.maxReviewsPerDay, 0, 1000, 10),
        skipCooldownDays: clampInteger(triggered.skipCooldownDays, 0, 365, 7),
        errorCooldownMinutes: clampInteger(
          triggered.errorCooldownMinutes,
          1,
          10080,
          60
        ),
        maxQueueAgeSeconds: clampInteger(triggered.maxQueueAgeSeconds, 5, 3600, 120),
        scoreThreshold: clampInteger(triggered.scoreThreshold, 0, 100, 70),
        weights
      }
    }
  };
  if (
    next.identityPilot.enabled
    && (
      next.identityPilot.friendProposal.enabled
      || next.identityPilot.incomingFriendRequest.enabled
    )
  ) {
    const ownerUin = next.identityPilot.friendProposal.ownerUin;
    if (!ownerUin) throw new Error('好友审批功能需要配置管理员 QQ');
    if (
      next.allowAllWhenEmpty !== true
      && !(next.allow?.private || []).map(String).includes(ownerUin)
    ) {
      throw new Error('审批管理员 QQ 必须同时加入私聊白名单');
    }
  }
  const incidentPilot = next.incidentPilot || {};
  next.incidentPilot = {
    ...incidentPilot,
    enabled: incidentPilot.enabled === true,
    graduated: incidentPilot.graduated === true,
    ownerUin: /^\d{5,15}$/.test(String(incidentPilot.ownerUin || '').trim())
      ? String(incidentPilot.ownerUin).trim()
      : '',
    notifyWarnings: incidentPilot.notifyWarnings !== false,
    duplicateWindowMinutes: Math.min(
      1440,
      Math.max(1, Math.round(Number(incidentPilot.duplicateWindowMinutes) || 10))
    ),
    unknownWritesBlockChat: incidentPilot.unknownWritesBlockChat === true,
    retentionDays: Math.min(
      3650,
      Math.max(1, Math.round(Number(incidentPilot.retentionDays) || 90))
    )
  };
  if (next.incidentPilot.enabled) {
    if (!next.incidentPilot.ownerUin) {
      throw new Error('异常处理试点需要配置告警管理员 QQ');
    }
    if (
      next.allowAllWhenEmpty !== true
      && !(next.allow?.private || []).map(String).includes(next.incidentPilot.ownerUin)
    ) {
      throw new Error('异常告警管理员 QQ 必须同时加入私聊白名单');
    }
  }
  const autoUpdate = next.autoUpdate || {};
  const updateRepository = String(
    autoUpdate.repository || DEFAULT_CONFIG.autoUpdate.repository
  ).trim();
  const updateBranch = String(
    autoUpdate.branch || DEFAULT_CONFIG.autoUpdate.branch
  ).trim();
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
    updateRepository
  )) {
    throw new Error('自动更新仓库必须是 GitHub HTTPS 地址');
  }
  if (
    !/^[A-Za-z0-9._/-]{1,100}$/.test(updateBranch)
    || updateBranch.startsWith('-')
    || updateBranch.includes('..')
    || updateBranch.endsWith('/')
  ) {
    throw new Error('自动更新分支名称无效');
  }
  next.autoUpdate = {
    ...autoUpdate,
    enabled: autoUpdate.enabled === true,
    ownerUin: /^\d{5,15}$/.test(String(autoUpdate.ownerUin || '').trim())
      ? String(autoUpdate.ownerUin).trim()
      : '',
    repository: updateRepository.endsWith('.git')
      ? updateRepository
      : `${updateRepository}.git`,
    branch: updateBranch,
    intervalHours: Math.min(
      168,
      Math.max(1, Math.round(Number(autoUpdate.intervalHours) || 6))
    )
  };
  if (next.autoUpdate.enabled) {
    if (!next.autoUpdate.ownerUin) {
      throw new Error('自动更新需要配置告警管理员 QQ');
    }
    if (
      next.allowAllWhenEmpty !== true
      && !(next.allow?.private || []).map(String).includes(next.autoUpdate.ownerUin)
    ) {
      throw new Error('自动更新管理员 QQ 必须同时加入私聊白名单');
    }
  }
  const slangPilot = next.slangPilot || {};
  next.slangPilot = {
    ...slangPilot,
    enabled: slangPilot.enabled === true,
    graduated: slangPilot.graduated === true,
    ownerUin: /^\d{5,15}$/.test(String(slangPilot.ownerUin || '').trim())
      ? String(slangPilot.ownerUin).trim()
      : '',
    minOccurrences: Math.min(
      20,
      Math.max(2, Math.round(Number(slangPilot.minOccurrences) || 3))
    ),
    minSpeakers: Math.min(
      20,
      Math.max(1, Math.round(Number(slangPilot.minSpeakers) || 2))
    ),
    windowHours: Math.min(
      720,
      Math.max(1, Math.round(Number(slangPilot.windowHours) || 72))
    ),
    maxPending: Math.min(
      500,
      Math.max(1, Math.round(Number(slangPilot.maxPending) || 100))
    ),
    perChatDailyLimit: Math.min(
      50,
      Math.max(1, Math.round(Number(slangPilot.perChatDailyLimit) || 5))
    ),
    rejectCooldownDays: Math.min(
      365,
      Math.max(1, Math.round(Number(slangPilot.rejectCooldownDays) || 14))
    ),
    maxEvidence: Math.min(
      30,
      Math.max(3, Math.round(Number(slangPilot.maxEvidence) || 12))
    ),
    webResearch: slangPilot.webResearch !== false,
    maxSearchResults: Math.min(
      10,
      Math.max(1, Math.round(Number(slangPilot.maxSearchResults) || 5))
    ),
    maxFetchPages: Math.min(
      3,
      Math.max(0, Math.round(Number(slangPilot.maxFetchPages) || 0))
    ),
    maxResearchRounds: Math.min(
      3,
      Math.max(1, Math.round(Number(slangPilot.maxResearchRounds) || 2))
    )
  };
  if (next.slangPilot.enabled) {
    const ownerUin = next.slangPilot.ownerUin;
    if (!ownerUin) throw new Error('黑话语料库试点需要配置审批管理员 QQ');
    if (
      next.allowAllWhenEmpty !== true
      && !(next.allow?.private || []).map(String).includes(ownerUin)
    ) {
      throw new Error('黑话审批管理员 QQ 必须同时加入私聊白名单');
    }
  }
  if (!Number.isInteger(Number(next.server?.port)) || next.server.port < 1 || next.server.port > 65535) {
    throw new Error('Invalid server port');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(next.server.host) && !String(next.server.token || '').trim()) {
    throw new Error('A console token is required for LAN access');
  }
  currentConfig = next;

  // ── 响应概率：以滑条位置为唯一真相 ──
  // 滑条上的数字就是概率（0~100）；前端只负责上报位置，档位与概率一律由这里派生，
  // 这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾。
  // 老配置的迁移在 migrateConfig（读盘时）做；这里的 legacy 分支只兜住"没走读盘"的配置
  // （测试用 setRuntimeConfig 注入的那类）—— 正常配置到这里时已经带 sliderMode 标记了。
  const storeNow = currentConfig?.store || {};
  const migrated = storeNow.sliderMode !== 'probability';
  const probability = migrated
    ? (storeNow.contextSliderPos !== undefined && storeNow.contextSliderPos !== null
        ? legacySliderToProbability(storeNow.contextSliderPos)
        : legacyTierToProbability(storeNow.contextTier, storeNow.randomPercent))
    : clampProbability(storeNow.contextSliderPos);
  const derived = sliderToTier(probability);
  const groupSliderPos = {};
  for (const [groupId, pos] of Object.entries(storeNow.groupSliderPos || {})) {
    groupSliderPos[groupId] = migrated ? legacySliderToProbability(pos) : clampProbability(pos);
  }
  currentConfig.store = {
    ...storeNow,
    sliderMode: 'probability',
    contextSliderPos: probability,
    contextTier: derived.tier,
    randomPercent: derived.randomPercent,
    groupSliderPos
  };

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.tmp`;
  // flush：rename 之前先把数据落盘，否则断电后可能拿到"改名成功、内容为空"的 config.json
  // （进程被杀不受影响，只有真断电会中招；2026-09-29 审查 P2）
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), { mode: 0o600, flush: true });
  fs.renameSync(tmp, CONFIG_FILE);
  // btrfs（部分 NAS）上 writeFileSync 的 mode 参数会丢失（0600→0700）：
  // 显式 chmod 兜底，不依赖"创建时 mode"在所有文件系统上都生效（Issue #11）。
  // chmod 失败不向上抛：写入本身已成功，别让一次已成功的 updateConfig 因
  // 极窄文件系统场景（FUSE/NFS 关闭 mode 支持等）变成全仓调用方的失败。
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* 保留已成功写入 */ }
  if (oldTimeControl !== JSON.stringify(next.timeControl)) notifyTimeControlChange();
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
  notifyTimeControlChange();
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 群聊查 groupSliderPos（存的就是概率），换算出该群的 tier/randomPercent，
 * 其余字段（各档读取条数、关键词表）沿用全局值。私聊永远跟随全局档位。
 */
export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  if (store.unifiedTier !== false) return store;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return store;
  const pos = store.groupSliderPos?.[id];
  if (pos === undefined || pos === null) return store;
  // 老配置（还没保存过）里的分群位置是四段式的，先换算成概率
  const probability = store.sliderMode === 'probability'
    ? clampProbability(pos)
    : legacySliderToProbability(pos);
  const { tier, randomPercent } = sliderToTier(probability);
  return { ...store, contextTier: tier, randomPercent };
}

/** 获取某个会话实际生效的对话引擎配置。私聊始终使用全局模式。 */
export function conversationConfigForChat(chatKey) {
  const conversation = getConfig().conversation || {};
  if (conversation.unifiedMode !== false) return conversation;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return conversation;
  const mode = conversation.groupModes?.[id];
  return ['legacy', 'threaded', 'lifecycle'].includes(mode)
    ? { ...conversation, mode }
    : conversation;
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${CONFIG_FILE}.tmp`;
      // config.json 含模型 Key 与控制台 Token，防抖路径也必须锁 0600，
      // 否则 rename 会把 updateConfig 落好的 0600 打回 umask 默认（0664）
      fs.writeFileSync(tmp, JSON.stringify(getConfig(), null, 2), { mode: 0o600, flush: true });
      fs.renameSync(tmp, CONFIG_FILE);
      fs.chmodSync(CONFIG_FILE, 0o600); // btrfs 兜底（Issue #11：mode 参数在该文件系统上会丢失）
    } catch (error) {
      console.error('[config] 保存失败:', error);
    }
  }, 400));
}
