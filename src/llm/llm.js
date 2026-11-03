// OpenAI 兼容 Chat Completions 客户端（非流式）。
// 支持工具调用、usage 统计和可选模型。
import { getConfig } from '../core/config.js';
import { stripLoneSurrogates } from '../core/util.js';
import { normalizeThinkingIntent, resolveThinkingPatch, modelServiceById, modelServiceOfBaseUrl, effectiveThinkingRaw, hostOf } from '../core/provider-presets.js';
import { resolveModelPrice, priceAt } from '../pricing/model-prices.js';
import { setTimeout as delay } from 'node:timers/promises';
import { assertTimeAllowed, watchTimeWindow } from '../core/time-gate.js';
import { readJsonBounded, readTextBounded } from '../core/http-body.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('llm');

// 聊天响应可能是长文，给宽松但有限的上限：8 MiB 已远超正常回答，
// 又能拦住畸形上游一口气吐几百 MB 把常驻进程读爆。
const CHAT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
// /models 只是一串模型 id，2 MiB 绰绰有余。
const MODELS_JSON_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 进程内 LLM 计数（低基数，不按会话/用户打标签）。
 * requests = 外层对话请求；attempts = 真正打出去的 HTTP 次数（含重试/兜底）；
 * retries = 主动重试次数；failures = 最终失败（重试与兜底都耗尽）；fallbackUses = 切兜底次数。
 * 控制台 /api/metrics 直接读这份计数，不额外落库。
 */
export const llmRuntimeStats = {
  requests: 0,
  attempts: 0,
  retries: 0,
  failures: 0,
  primaryErrors: 0,
  fallbackUses: 0
};

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey, baseUrl = '', model = '') {
  const h = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  // OpenCode Go 强制要求会话头做路由（缺了直接 400）。注意不能只认域名：
  // 走中转站转发时 baseUrl 不是 opencode.ai，只能靠模型 id 的 opencode-go/ 前缀识别。
  if (/opencode\.ai/i.test(String(baseUrl)) || /^opencode-go\//i.test(String(model || ''))) {
    h['x-opencode-session'] = getOpencodeSessionId();
    h['user-agent'] = 'qq-agent/0.3';   // 官方文档要求客户端自报身份，别用通用库名
  }
  return h;
}

// OpenCode Go 会话 ID：进程级生成一次，全程复用（路由粘性 + 缓存命中）
let opencodeSessionId = '';
function getOpencodeSessionId() {
  if (!opencodeSessionId) {
    opencodeSessionId = `qqagent-${crypto.randomUUID()}`;
  }
  return opencodeSessionId;
}

/**
 * 解析当前 api 配置里真正该用的 API Key。
 *
 * 优先级：**当前选中的目录提供商的 Key > 顶层 api.apiKey**。
 *
 * 注意顺序很重要：api.apiKey 是手动模式遗留字段，一旦用户在 UI 里选了某个
 * 目录提供商，就只能用它对应的 Key。否则会出现「选了 openrouter，却拿着 a6api 的
 * Key 去请求 openrouter.ai」的情况 —— 不只会全部会话 401，还会把上一家的 Key
 * 明文发给新厂商。没有该提供商的 Key 时宁可报"未配置"，也绝不回退顶层 Key。
 *
 * 兼容历史数据：providers[].apiKey 也可能存有明文（老配置），也认。
 */
export function resolveApiKey(cfg) {
  const pid = String(cfg?.api?.provider ?? '').trim();
  if (pid) {
    const fromCatalog = String(cfg?.providerKeys?.[pid] ?? '').trim();
    if (fromCatalog && fromCatalog !== '******') return fromCatalog;
    const p = (cfg?.providers || []).find((x) => x.id === pid);
    const legacy = String(p?.apiKey ?? '').trim();
    if (legacy && legacy !== '******') return legacy;
    return '';
  }
  const direct = String(cfg?.api?.apiKey ?? '').trim();
  return direct === '******' ? '' : direct;
}

/** 返回一个 key 已解析好的 api 配置（不影响配置本体）。 */
function effectiveApi() {
  const cfg = getConfig();
  return { ...cfg.api, apiKey: resolveApiKey(cfg) };
}

/**
 * 判断一个错误是否值得重试。
 *
 * 可重试（多半是暂时性的，再试一次可能就好）：
 *   - 网络层失败 / 超时 / 连接被重置
 *   - HTTP 5xx（服务端出问题）
 *   - HTTP 429（限流，等一会儿再来）
 *   - 响应解析失败（偶发的空响应/截断）
 *
 * 不重试（重试也不会变好，只会浪费额度）：
 *   - HTTP 4xx：401 密钥错、400 请求体错、403 无权限、404 模型不存在
 *   - 主动中止（abort）
 */
export function isRetryableError(error) {
  if (error?.code === 'TIME_CONTROL_INACTIVE') return false;
  const msg = String(error?.message ?? error ?? '');

  // 主动中止（用户/系统取消）：重试没有意义
  if (/aborted|中止|已取消|cancel/i.test(msg)) return false;

  // 明确的客户端错误：重试也不会变好，只会白烧额度
  if (/HTTP\s*(401|400|403|404|405|409|413|422)/i.test(msg)) return false;
  if (/unauthorized|forbidden|invalid api.?key|incorrect api.?key/i.test(msg)) return false;

  // 明确的暂时性故障
  if (/HTTP\s*5\d\d/i.test(msg)) return true;                        // 5xx
  if (/429|rate.?limit|限流|too many requests|quota/i.test(msg)) return true;
  if (/超时|timeout|timed out/i.test(msg)) return true;

  // 网络层：错误码太多列不全（bad port、EHOSTUNREACH、证书、DNS…），
  // 凡是带 "模型请求失败" 前缀的都是 fetch 抛的，统一视为可重试
  if (/模型请求失败/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network/i.test(msg)) return true;

  // 响应解析失败（偶发空响应/截断）
  if (/无法解析的 JSON|Unexpected end|unexpected token|JSON/i.test(msg)) return true;

  // 兜底：模型 API 类错误默认不重试（避免未知错误疯狂重试）
  return false;
}

/**
 * 带重试的单次对话请求。
 *
 * 只在**可重试**的错误上重试（网络抖动、5xx、429），
 * 4xx（密钥错、参数错）直接抛出 —— 重试不会让它变好。
 * 退避策略：1s → 2s（指数退避，避免雪崩）。
 *
 * 注意：这里重试的是**同一轮**请求，messages 不变，所以是幂等的，
 * 不会造成重复发言。会话级的整体重试在 orchestrator 里做。
 *
 * @param {object} args 同 chatCompletion
 * @param {number} [retries=2] 最多额外重试几次（默认 2，即总共最多 3 次尝试）
 */
/**
 * 按用途决定要不要"思考"，并翻译成当前渠道认识的参数形状（见 src/core/provider-presets.js）。
 * 配置：api.thinking 支持 'on'/'off'（全局）、'low'/'medium'/'high'/'max'（档位）、
 * 或按用途对象 { chat: 'off', default: 'on' }。表外渠道沿用历史行为：只有明确 off
 * 时才带 thinking 字段 —— 不认这个字段的网关因此不会 400；档位对表外渠道一律不发。
 */
// 思考模式下降级强制 tool_choice 的提示只打一次（每种工具一次），避免每次判断刷屏。
const thinkingToolChoiceWarned = new Set();
// 表外渠道 / 未验证档位的提示同样只打一次，避免刷屏。
const thinkingUnsupportedWarned = new Set();
// 模型级差异兜底：个别模型/网关不认思考参数会 400 —— 去掉参数重试一次（每个模型只提示一次）。
const thinkingParamRejectedWarned = new Set();
// extraBody 里写 stream:true 会被强制回 false（本端固定非流式解析），只提示一次。
let extraBodyStreamWarned = false;

/** 当前连接的地址主机（每供应商独立设置按它取）。 */
function currentHost() {
  try {
    const cfg = getConfig();
    const pid = String(cfg?.api?.provider || '').trim();
    const provider = (cfg?.providers || []).find((p) => p && p.id === pid) || null;
    return hostOf(provider?.baseURL || cfg?.api?.baseUrl || '');
  } catch {
    return '';
  }
}

/** 当前连接命中的渠道预设 id（先看 provider 记录，再看 api.baseUrl）。 */
function currentServiceId() {
  try {
    const cfg = getConfig();
    const pid = String(cfg?.api?.provider || '').trim();
    const provider = (cfg?.providers || []).find((p) => p && p.id === pid) || null;
    if (provider?.preset) {
      const byPreset = modelServiceById(provider.preset);
      if (byPreset) return byPreset.id;
    }
    if (provider?.baseURL) {
      const byProvider = modelServiceOfBaseUrl(provider.baseURL);
      if (byProvider) return byProvider.id;
    }
    const byApi = modelServiceOfBaseUrl(cfg?.api?.baseUrl);
    return byApi ? byApi.id : '';
  } catch {
    return '';
  }
}

function thinkingFor(purpose, overrides = null) {
  let raw = null;
  let customParams = null;
  let serviceId = '';
  try {
    const cfg = getConfig();
    customParams = cfg?.api?.thinkingParams;
    if (overrides?.baseUrl) {
      // 专用模型/兜底这类 overrides 调用按 overrides 自己的地址取每供应商设置与渠道形状，
      // 不串用主渠道的（审查 2026-09-28：主渠道 Command Code、专用 DeepSeek 时，
      // 旧逻辑会把 reasoning_effort 发给 DeepSeek——"换家不串味"正是这套预设的设计目标）。
      raw = effectiveThinkingRaw(cfg?.api, hostOf(overrides.baseUrl));
      const svc = modelServiceOfBaseUrl(overrides.baseUrl);
      serviceId = svc ? svc.id : '';
    } else {
      // 先取"当前供应商自己的条"，没有才退回全局设置（每供应商独立）。
      raw = effectiveThinkingRaw(cfg?.api, currentHost());
      serviceId = currentServiceId();
    }
  } catch { /* 取不到就走默认 */ }
  const intent = normalizeThinkingIntent(raw, purpose);
  if (intent === 'on') return { mode: 'on', patch: null, approx: false, effectiveOff: false, serviceId };
  // 自定义/表外渠道优先用用户的档位映射（api.thinkingParams）。
  const resolved = resolveThinkingPatch(serviceId, intent, customParams);
  if (!resolved) {
    // 表内没核过这个档位 / 表外渠道：不发参数，别赌网关认不认。
    const key = `${serviceId || 'unknown'}:${intent}`;
    if (intent !== 'off' && !thinkingUnsupportedWarned.has(key)) {
      thinkingUnsupportedWarned.add(key);
      log.warn(`[llm] 当前渠道（${serviceId || '未识别'}）未验证思考档位「${intent}」，已跳过该参数；可用「额外请求参数」自定义。`);
    }
    return { mode: intent, patch: null, approx: false, effectiveOff: false, serviceId };
  }
  // 只有"真正关掉"才丢 reasoning_content：近似关闭（如网关最低档）思考仍在发生，历史里保留它更连贯。
  const effectiveOff = intent === 'off' && !resolved.approx && !resolved.suppressed;
  return { mode: intent, patch: resolved.patch, approx: resolved.approx, effectiveOff, serviceId, suppressed: resolved.suppressed };
}

// 服务商的内容审核会偶尔把整次请求判为 high risk 直接拒绝（2026-09-18 实测：群里吵架上下文触发，
// 模型一句话都没机会说，表现为"已读不回"）。识别到这种拒绝时，用精简上下文重试一次。
const MODERATION_REFUSAL_RE = /considered high risk|high risk request/i;

export function isModerationRefusal(response) {
  const msg = response?.message;
  if (!msg) return false;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return false;
  return MODERATION_REFUSAL_RE.test(String(msg.content || ''));
}

export function trimForModerationRetry(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = list.filter((m) => m?.role === 'system');
  const lastUser = [...list].reverse().find((m) => m?.role === 'user');
  // 只在"这一轮还没执行过工具"时精简：一旦 send_message 等工具跑过，丢掉 tool 结果
  // 会让模型以为没发过、重试时再发一遍 —— 群里出现两条一样的话，而 outbox 只记一条。
  const hasToolExchange = list.some((m) => m?.role === 'tool'
    || (Array.isArray(m?.tool_calls) && m.tool_calls.length));
  if (hasToolExchange) return list;
  return lastUser ? [...systems, lastUser] : systems;
}

/** 同一个模型内部的"带重试 + 审核拦截重试"完整走法；抽出来给主模型和兜底模型共用。 */
async function runCompletionWithRetries(args, retries) {
  let lastError = null;
  let moderationRetried = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      args.signal?.throwIfAborted();
      const response = await chatCompletion(args);
      if (!moderationRetried && isModerationRefusal(response)) {
        if (attempt >= retries) return response;   // 最后一轮还被拦：把拦截结果如实返回（重试预算已耗尽）
        moderationRetried = true;
        args = { ...args, messages: trimForModerationRetry(args.messages) };
        llmRuntimeStats.retries += 1;
        log.warn('[llm] 服务商审核拦截整次请求，改用精简上下文重试一次');
        await delay(600, undefined, { signal: args.signal });
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (args.signal?.aborted || attempt >= retries || !isRetryableError(error)) throw error;
      const wait = 1000 * Math.pow(2, attempt);   // 1s, 2s
      llmRuntimeStats.retries += 1;
      log.warn(`[llm] 请求失败（第 ${attempt + 1} 次尝试），${wait}ms 后重试：${error?.message ?? error}`);
      await delay(wait, undefined, { signal: args.signal });
    }
  }
  throw lastError;
}

/** 主模型不可用时，是否值得换兜底模型再试：可重试类故障，外加认证/欠费/权限类（换服务商可能就能用）。 */
function isFallbackWorthy(error) {
  if (isRetryableError(error)) return true;
  const msg = String(error?.message ?? error ?? '');
  if (/HTTP\s*(401|402|403)/i.test(msg)) return true;
  if (/unauthorized|forbidden|invalid api.?key|incorrect api.?key|余额|欠费/i.test(msg)) return true;
  return false;
}

/** 从配置取兜底模型覆盖项；没配 / 已停用 / 调用方自带 overrides（专用模型场景）时不兜底。 */
function pickFallback(args) {
  if (args.overrides) return null;
  let fb = null;
  try { fb = getConfig().api?.fallback; } catch { return null; }
  if (!fb || fb.enabled === false || !String(fb.model || '').trim()) return null;
  const api = effectiveApi();
  const fbBase = String(fb.baseUrl || '').trim();
  const fbKey = String(fb.apiKey || '').trim();
  const fbHost = hostOf(fbBase || api.baseUrl);
  const keyHost = String(fb.apiKeyHost || '').trim().toLowerCase();
  // 备用地址换了主机、却没单独给 Key 时**绝不沿用主渠道那把** —— 那等于把 A 家的密钥发给 B 家
  // （这类事故本项目在 asr / 生图 / tts 上都修过，兜底模型是最后一个漏口）。
  // 文档里 api.fallback.apiKey 本就是"另一个服务商的 key"；留空就当"没配兜底"，退回主渠道的错。
  if (fbBase && fbHost !== hostOf(api.baseUrl) && !fbKey) {
    log.warn(`[llm] 兜底地址 ${fbHost} 与主渠道不同却没配 api.fallback.apiKey，本次不切兜底`);
    return null;
  }
  // Key 是给某一家存的（apiKeyHost）：地址换了主机就绝不把它发过去，哪怕字段里还留着旧值。
  // 控制台保存时已拒绝这种组合；这里是绕过控制台直接改配置时的最后一道闸。
  if (fbKey && keyHost && fbHost && keyHost !== fbHost) {
    log.warn(`[llm] 兜底 Key 绑定的是 ${keyHost}，当前地址是 ${fbHost}；本次不切兜底，请重填 Key`);
    return null;
  }
  return {
    ...api,
    baseUrl: fb.baseUrl || api.baseUrl,
    apiKey: fb.apiKey || api.apiKey,
    model: fb.model,
    timeoutMs: Number(fb.timeoutMs) || api.timeoutMs
  };
}

/**
 * 带重试 + 兜底模型的对话请求。
 * 主模型彻底失败（重试耗尽 / 认证欠费类错误），或两轮都被服务商审核拦下时，
 * 自动改用 config.api.fallback 里配置的备用模型再试一次（只切一次，不递归）。
 */
export async function chatCompletionWithRetry(args, retries = 2) {
  llmRuntimeStats.requests += 1;
  let response = null;
  let primaryError = null;
  try {
    response = await runCompletionWithRetries(args, retries);
  } catch (error) {
    primaryError = error;
    llmRuntimeStats.primaryErrors += 1;
  }

  const shouldFallback = primaryError
    ? isFallbackWorthy(primaryError)
    : isModerationRefusal(response);
  const fb = shouldFallback ? pickFallback(args) : null;
  if (!fb || args.signal?.aborted) {
    if (primaryError) {
      llmRuntimeStats.failures += 1;
      throw primaryError;
    }
    // 兜底不可用时把**本次结果**如实返回；null 只能来自内部异常路径（throw null 已被上面堵死），
    // 但调用方（orchestrator 等）会直接读 response.model / .message —— 这里显式兜一层，别让它崩在调用方。
    if (!response) throw new Error('模型请求没有返回结果');
    return response;
  }

  const why = primaryError
    ? `失败（${String(primaryError?.message ?? primaryError).slice(0, 90)}）`
    : '两轮都被审核拦截';
  log.warn(`[llm] 主模型${why}，改用兜底模型 ${fb.model}`);
  llmRuntimeStats.fallbackUses += 1;
  try {
    const fbResponse = await runCompletionWithRetries({ ...args, overrides: fb }, 1);
    // 2026-10-06 复审 P3：标记本次是否真的换了渠道（兜底端点与主渠道 host 不同）。
    // 同渠道换模型不算换渠道 —— vendor 不变；跨渠道时调用方把成本记到实际渠道名下。
    const primaryBase = String(effectiveApi().baseUrl || '');
    const channelChanged = Boolean(fbResponse.originBaseUrl)
      && hostOf(fbResponse.originBaseUrl) !== hostOf(primaryBase);
    return { ...fbResponse, viaFallback: true, channelChanged };
  } catch (error) {
    llmRuntimeStats.failures += 1;
    throw error;
  }
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 * overrides: { baseUrl, apiKey, model, timeoutMs } 可选，用于记忆整理专用模型等场景。
 */
/** 请求体里的内容清洗：字符串直接清，多模态数组逐段清 text（图片段原样保留）。 */
function cleanContentForRequest(content) {
  if (typeof content === 'string') return stripLoneSurrogates(content);
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === 'string'
      ? { ...part, text: stripLoneSurrogates(part.text) }
      : part));
  }
  return content;
}

export async function chatCompletion({
  messages,
  tools = null,
  toolChoice = 'auto',
  temperature = null,
  signal = null,
  overrides = null,
  cacheKey = '',
  maxTokens = null,
  purpose = ''
}) {
  assertTimeAllowed();
  llmRuntimeStats.attempts += 1;
  const api = overrides || effectiveApi();
  // 聊天这类"随口回一句"的任务关掉思考：省一半输出 token、少 1~3 秒；
  // 判断/写作类（表情包要不要收、说说、空间互动、身份评估）不传 purpose，继续思考。
  const thinking = thinkingFor(purpose, overrides);
  const thinkingOff = thinking.effectiveOff;
  const body = {
    model: api.model,
    messages: messages.map(({ role, content, tool_calls, tool_call_id, name, reasoning_content }) => ({
      role,
      // 请求前兜底：字符串里若有孤立代理项（只可能来自把 emoji 切两半的错误截断），
      // 整次调用会被模型网关判成 400 Bad Request（2026-09-27 实测：记忆"新建印象"因此永远失败）。
      // 统一在这里清掉，别指望每个拼提示词的地方都记得用 safeSlice。
      content: cleanContentForRequest(content),
      ...(tool_calls ? { tool_calls } : {}),
      ...(tool_call_id ? { tool_call_id } : {}), ...(name ? { name } : {}),
      // 关思考时不能把上一轮的 reasoning_content 带回去（有的网关会 400）
      ...(!thinkingOff && reasoning_content ? { reasoning_content } : {})
    })),
    stream: false
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    // 思考模式与强制 tool_choice 不兼容：部分网关（DeepSeek 系）会整次请求 400
    // "Thinking mode does not support this tool_choice"。此前贴纸判断就踩在这个组合上
    // （每张图重试 3 次全失败，最后整张图跳过）。降级成 auto 由提示词与工具描述驱动，
    // 调用方本身也有内联文本兜底解析，比硬失败强。
    const forced = toolChoice && typeof toolChoice === 'object';
    if (!thinkingOff && forced) {
      const name = String(toolChoice?.function?.name || '');
      if (!thinkingToolChoiceWarned.has(name)) {
        thinkingToolChoiceWarned.add(name);
        log.warn('[llm] 思考模式不接受强制 tool_choice，已降级为 auto（每种工具只提示一次）：', name || JSON.stringify(toolChoice));
      }
      body.tool_choice = 'auto';
    } else {
      body.tool_choice = toolChoice;
    }
  }
  const temp = temperature === null ? (api.temperature ?? 0.8) : temperature;
  if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) body.temperature = Number(temp);
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    body.max_tokens = Math.round(Number(maxTokens));
  }
  // OpenAI/Azure 可用显式 key 提高相同前缀的路由稳定性。兼容网关不盲传，
  // 避免它们因未知字段返回 400；DeepSeek 使用自动前缀缓存，无需该字段。
  if (cacheKey && /(^|\.)openai\.com$|\.openai\.azure\.com$|\.services\.ai\.azure\.com$/i.test((() => {
    try { return new URL(api.baseUrl).hostname; } catch { return ''; }
  })())) {
    body.prompt_cache_key = String(cacheKey).slice(0, 64);
  }
  // 思考参数档位的优先级排在温度/工具选择/输出上限之后（与"extraBody 最高优先级"同一条链：
  // 内置字段 < thinking.patch < extraBody），不再插在中间造成两段语义不一致（审查 2026-09-28）。
  if (thinking.patch) Object.assign(body, thinking.patch);
  // 额外请求参数（控制台「高级」）：用户按自己服务商的文档填，最高优先级合并，
  // 表外渠道/怪癖网关不必等适配（例：某些网关要 {"reasoning":{"enabled":false}}）。
  // overrides（专用模型/兜底）请求同样合并——文档承诺的是"每次请求"（审查 2026-09-28）。
  // 注意兜底路（pickFallback）spread 了 effectiveApi 自带 extraBody；记忆专用模型路的
  // overrides 没有这个字段，必须回落到配置里的 api.extraBody（复审 2026-09-28 抓过）。
  const extraRaw = overrides
    ? (overrides.extraBody !== undefined ? overrides.extraBody : getConfig()?.api?.extraBody)
    : api.extraBody;
  const extraBody = extraRaw && typeof extraRaw === 'object' && !Array.isArray(extraRaw)
    ? extraRaw : null;
  if (extraBody) Object.assign(body, extraBody);
  if (body.stream === true) {
    // 响应解析固定走非流式（res.json()），stream:true 只会得到解析失败、还被当成可重试错误
    // 连打三次（表现为"已读不回"）——强制回 false 并提示一次（审查 2026-09-28）。
    if (!extraBodyStreamWarned) {
      extraBodyStreamWarned = true;
      log.warn('[llm] 额外请求参数里的 stream:true 已忽略：本端固定按非流式解析响应。');
    }
    body.stream = false;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(api.timeoutMs) || 180000);
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  const abort = () => controller.abort(signal.reason ?? new Error('Run cancelled'));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', abort, { once: true });
  }
  const releaseTimeGuard = watchTimeWindow((error) => controller.abort(error));

  try {
    controller.signal.throwIfAborted();
    assertTimeAllowed();
    const send = (payload) => fetch(joinUrl(api.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(api.apiKey, api.baseUrl, api.model) },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    let res = await send(body);
    if (!res.ok) {
      let text = await readTextBounded(res, CHAT_RESPONSE_MAX_BYTES);
      // 模型级差异：个别模型/网关不认识思考参数会整次 400 —— 一个可选参数不该让消息发不出去。
      // 去掉"我们自己加的"思考参数重试一次（extraBody 是用户显式填的，不动）。
      const patchKeys = thinking.patch ? Object.keys(thinking.patch) : [];
      // 400 且错误文本提到我们发的思考参数词面（thinking/reasoning 覆盖 thinking.type、
      // reasoning_effort、enable_thinking 三个族，结构化错误的 error.param 值也在响应体里）。
      // 别用 invalid/unknown/unexpected 这类泛词：上下文超长等无关 400 的错误体几乎都带
      // "invalid_request_error"，会误判成参数被拒——白重试一次还打误导日志（审查 2026-09-28）。
      const paramRejected = res.status === 400 && patchKeys.length
        && /thinking|reasoning/i.test(text);
      if (paramRejected) {
        const retryBody = { ...body };
        for (const k of patchKeys) delete retryBody[k];
        if (!thinkingParamRejectedWarned.has(api.model)) {
          thinkingParamRejectedWarned.add(api.model);
          log.warn('[llm] 模型拒绝思考参数，已去掉后重试（每个模型提示一次）：', api.model, '|', text.slice(0, 160));
        }
        res = await send(retryBody);
        if (!res.ok) text = await readTextBounded(res, CHAT_RESPONSE_MAX_BYTES);
      }
      if (!res.ok) throw new Error(`模型 API HTTP ${res.status}：${text.slice(0, 500)}`);
    }
    const data = await readJsonBounded(res, CHAT_RESPONSE_MAX_BYTES);
    const choice = data?.choices?.[0];
    if (!choice) throw new Error('模型 API 响应缺少 choices');
    return {
      message: choice.message ?? {}, finishReason: choice.finish_reason ?? null,
      usage: data.usage ?? null, model: data.model ?? api.model, raw: data,
      // 实际发往的端点（overrides/兜底接管后 ≠ 主渠道）—— 调用方据此把成本记到实际渠道名下
      originBaseUrl: String(api.baseUrl || '')
    };
  } catch (error) {
    if (controller.signal.reason?.code === 'TIME_CONTROL_INACTIVE') throw controller.signal.reason;
    if (signal?.aborted) throw signal.reason ?? new Error('Run cancelled');
    if (controller.signal.aborted) throw new Error(`模型请求超时（${timeoutMs}ms）`);
    if (/模型 API HTTP/.test(String(error.message))) throw error;
    throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
  } finally {
    releaseTimeGuard();
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** 获取模型列表（GET /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = effectiveApi();
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey, cfg.baseUrl),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await readJsonBounded(res, MODELS_JSON_MAX_BYTES);
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/**
 * 累加 usage。
 * 同时累计 cachedTokens（命中前缀缓存的 prompt 部分）—— 中转站会在
 * usage.prompt_tokens_details.cached_tokens 里返回它，成本看板与缓存命中率统计都依赖这个数。
 */
export function addUsage(target, usage) {
  if (!usage) return target;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += Number(usage.total_tokens) || (prompt + completion);
  target.cachedTokens = (Number(target.cachedTokens) || 0) + cachedTokensOfUsage(usage);
  return target;
}

/** 兼容各供应商返回缓存命中 Token 的字段差异。 */
export function cachedTokensOfUsage(usage = {}) {
  return Number(
    usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.prompt_cache_hit_tokens
    ?? usage?.cached_tokens
    ?? 0
  ) || 0;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
}

/** 缓存命中率（0~1）。没有 prompt 数据时返回 0。 */
export function cacheHitRate(usage) {
  const p = Number(usage?.promptTokens) || 0;
  if (!p) return 0;
  return Math.min(1, Math.max(0, (Number(usage?.cachedTokens) || 0) / p));
}

/**
 * 按配置单价折算成本（元）。
 *
 * 三种单价来源：
 *   1. useOfficialPrice=true 且模型 id 在内置价格表里 → 用官方价（缓存部分单独计价）
 *   2. 否则用用户手填的 priceInputPerM / priceOutputPerM / priceCachedPerM
 *   3. 都没有 → 0（不估算）
 *
 * 缓存命中部分优先走 cached 单价；官方价里 cached 为 null 时（该模型无缓存优惠）
 * 退回按普通输入价计算。
 *
 * 峰谷分时：opts.at 传调用时刻（毫秒时间戳）时，对支持分时的厂商（DeepSeek）
 * 按该时刻自动取高峰价或闲时价。不传 at 则按闲时计价（保守估值，会偏低）。
 * 历史统计请看 sumCostByTime() —— 它按每条记录的时刻分别计价后汇总，更准。
 */
export function estimateCost(usage, opts = {}) {
  const cfg = effectiveApi();
  // 成本只与"实际调用的模型"有关。opts.model 优先（统计时逐条传入各自的模型），
  // 不传才回退到当前选中的模型。
  const model = String(opts.model ?? cfg.model ?? '');

  const promptTokens = Number(usage?.promptTokens) || 0;
  const completionTokens = Number(usage?.completionTokens) || 0;
  const cachedTokens = Math.min(Number(usage?.cachedTokens) || 0, promptTokens);
  // 未命中缓存的输入 = 总输入 - 命中部分
  const freshTokens = Math.max(0, promptTokens - cachedTokens);

  // 统一走 resolveModelPrice：自定义 > 内置官方表 > 全局兜底
  // 注意：第二个参数要传完整配置对象（内部读 cfg.api.*），
  // 传 effectiveApi() 的返回值（它就是 api 本身）会导致取不到字段。
  // 第三、四个参数不能省：带时间区间的别名与渠道价都靠 options.at/vendor 判定，
  // 丢了就会拿"现在"的别名规则去算历史调用（2026-09-29 审查 P2）。
  const p = resolveModelPrice(model, getConfig(), null, {
    at: Number(opts.at) || 0,
    vendor: String(opts.vendor ?? '')
  });

  // 峰谷：传了 at（调用时刻）且该模型有 peak 档位就取对应档
  const tier = p.peak && opts.at ? priceAt(p, opts.at) : null;
  const inPrice = tier ? tier.in : p.in;
  const outPrice = tier ? tier.out : p.out;
  const cachedPrice = tier ? tier.cached : p.cached;

  const source = p.source;
  const matched = p.matched;
  const peak = Boolean(tier?.peak);
  const hasPeakTiers = Boolean(p.peak);

  const cost =
    (freshTokens / 1_000_000) * inPrice +
    (cachedTokens / 1_000_000) * cachedPrice +
    (completionTokens / 1_000_000) * outPrice;

  return {
    cost,
    source,
    breakdown: {
      fresh: (freshTokens / 1_000_000) * inPrice,
      cached: (cachedTokens / 1_000_000) * cachedPrice,
      output: (completionTokens / 1_000_000) * outPrice
    },
    prices: { in: inPrice, out: outPrice, cached: cachedPrice },
    matched,
    // 未定价 = 价格表里查不到（不是免费）。调用方要能区分这两种情况。
    unpriced: p.unpriced === true,
    confidence: p.confidence || '',
    via: p.via || '',
    // 峰谷信息：hasPeakTiers 表示这个模型是否分时段计价
    peak,
    hasPeakTiers
  };
}
