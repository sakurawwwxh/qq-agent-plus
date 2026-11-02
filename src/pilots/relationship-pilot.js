import { getConfig } from '../core/config.js';
import { chatCompletionWithRetry, cachedTokensOfUsage } from '../llm/llm.js';
import { globalMemoryStoreForIdentity } from '../memory/memory-runtime-integration.js';
import { shanghaiDayStart } from '../core/util.js';
import {
  RelationshipPilotStore,
  relationshipDatabasePath,
  RELATIONSHIP_EVALUATOR_VERSION
} from './relationship-pilot-store.js';
import {
  buildRelationshipSystemPrompt,
  buildRelationshipUserPrompt,
  RELATIONSHIP_EVENT_TOOL,
  RELATIONSHIP_EVENT_TYPES
} from '../llm/relationship-pilot-prompt.js';
import { resolveToolCalls } from '../tools/inline-tools.js';
import { repairJsonObject } from '../core/json-repair.js';
import { memoryVisibilityOf, visibleImpressions } from '../core/memory-visibility.js';

const EVENT_TYPES = new Set(RELATIONSHIP_EVENT_TYPES);
const clean = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clampInt = (value, min, max, fallback) => Math.min(
  max,
  Math.max(min, Math.round(Number.isFinite(Number(value)) ? Number(value) : fallback))
);
const clampNum = (value, min, max, fallback) => Math.min(
  max,
  Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback)
);

export function relationshipPilotConfig(cfg = getConfig()) {
  const raw = cfg?.relationshipPilot || {};
  return {
    enabled: raw.enabled === true,
    // V1 强制 shadow。后续要影响主模型时必须单独设计并显式升级，不能靠改配置偷跑。
    shadowMode: true,
    minNewMessages: clampInt(raw.minNewMessages, 4, 50, 8),
    minBatchMessages: clampInt(raw.minBatchMessages, 2, 20, 3),
    minBatchAgeMinutes: clampInt(raw.minBatchAgeMinutes, 30, 1440, 360),
    maxEvidenceMessages: clampInt(raw.maxEvidenceMessages, 8, 64, 32),
    maxPeoplePerTurn: clampInt(raw.maxPeoplePerTurn, 1, 4, 2),
    maxEvaluationsPerDay: clampInt(raw.maxEvaluationsPerDay, 1, 200, 20),
    familiarityRefreshMinutes: clampInt(raw.familiarityRefreshMinutes, 1, 1440, 5),
    frictionHalfLifeHours: clampNum(raw.frictionHalfLifeHours, 6, 720, 48),
    maxMemoryContext: clampInt(raw.maxMemoryContext, 0, 12, 6),
    model: clean(raw.model || cfg?.api?.model || '', 160),
    evaluatorVersion: RELATIONSHIP_EVALUATOR_VERSION
  };
}

export function relationshipPilotEnabled(cfg = getConfig()) {
  return relationshipPilotConfig(cfg).enabled;
}

export function inactiveRelationshipPilotStatus({ error = '' } = {}) {
  const settings = relationshipPilotConfig();
  return {
    enabled: settings.enabled,
    active: false,
    shadowMode: true,
    error: String(error || ''),
    database: 'relationship-pilot.sqlite',
    counts: { states: 0, events: 0, openFlags: 0 },
    queuedEvaluations: 0,
    runningEvaluations: 0,
    evaluatorVersion: settings.evaluatorVersion
  };
}

function usageOf(response) {
  const usage = response?.usage || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const cachedTokens = Math.min(promptTokens, cachedTokensOfUsage(usage));
  return {
    promptTokens,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
    cachedTokens,
    calls: 1
  };
}

function callUsageOf(response) {
  const usage = usageOf(response);
  return {
    round: 1,
    promptTokens: usage.promptTokens,
    cachedTokens: usage.cachedTokens,
    cacheHitRate: usage.promptTokens ? Math.min(1, usage.cachedTokens / usage.promptTokens) : 0,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens
  };
}

function parseRelationshipResponse(response, evidence) {
  const calls = resolveToolCalls(response?.message);
  if (calls.length !== 1 || calls[0]?.function?.name !== 'submit_relationship_events') {
    throw new Error('关系评估模型未提交唯一的 submit_relationship_events 结果');
  }
  let value;
  const rawArgs = String(calls[0].function.arguments || '{}');
  try {
    value = JSON.parse(rawArgs);
  } catch {
    // 评估模型吐的"准 JSON"带常见瑕疵（代码围栏、前后缀文本、尾随逗号、
    // 单引号、字符串内未转义引号——长输出里 note 引用原话时高发，Issue #6）：
    // 先走共享修复链（core/json-repair.js，与 inline-tools 兜底同一套），仍失败才抛。
    value = repairJsonObject(rawArgs);
    if (!value) throw new Error('关系评估工具参数不是有效 JSON');
  }
  if (!Array.isArray(value?.events)) throw new Error('关系评估 events 必须是数组');
  if (value.events.length > 4) throw new Error('单次关系评估最多提交 4 个事件');
  const allowed = new Map((evidence || []).map((item) => [String(item.evidenceId), item]));
  const events = [];
  for (const raw of value.events) {
    const type = String(raw?.type || '');
    if (!EVENT_TYPES.has(type)) throw new Error(`未知关系事件类型：${type}`);
    const strength = Number(raw?.strength);
    const confidence = Number(raw?.confidence);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new Error('关系事件 strength 必须在 0 到 1');
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('关系事件 confidence 必须在 0 到 1');
    }
    const evidenceIds = [...new Set((Array.isArray(raw?.evidenceIds) ? raw.evidenceIds : [])
      .map(String).filter(Boolean))];
    if (!evidenceIds.length || evidenceIds.some((id) => !allowed.has(id))) {
      throw new Error('关系事件引用了不存在或不可计数的 evidenceId');
    }
    const sourceChatKeys = [...new Set(evidenceIds.map((id) => allowed.get(id)?.chatKey).filter(Boolean))];
    events.push({
      type,
      strength,
      confidence,
      evidenceIds,
      sourceChatKeys,
      summary: clean(raw?.summary, 240)
    });
  }
  return {
    events,
    noChangeReason: clean(value?.noChangeReason, 300)
  };
}

export class RelationshipPilotManager {
  constructor({
    identityPilot,
    store,
    sessions = null,
    dataDir,
    config = getConfig,
    complete = chatCompletionWithRetry,
    emit = null,
    log = console.log
  } = {}) {
    this.identityPilot = identityPilot;
    this.store = store;
    this.sessions = sessions;
    this.dataDir = dataDir;
    this.config = config;
    this.complete = complete;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.log = log;
    this.relationshipStore = null;
    this.lastError = '';
    this.queue = Promise.resolve();
    this.queued = 0;
    this.running = 0;
    this.generation = 1;
    this.lastFamiliarityRefresh = new Map();
  }

  get active() {
    return Boolean(this.relationshipStore);
  }

  start() {
    const settings = relationshipPilotConfig(this.config());
    if (!settings.enabled || !this.identityPilot?.active) return this.status();
    if (!this.relationshipStore) {
      this.relationshipStore = new RelationshipPilotStore({
        ...(this.dataDir ? { dataDir: this.dataDir } : {})
      });
    }
    this.lastError = '';
    return this.status();
  }

  stop() {
    this.generation += 1;
    const store = this.relationshipStore;
    this.relationshipStore = null;
    this.queued = 0;
    this.running = 0;
    this.lastFamiliarityRefresh.clear();
    try { store?.close(); } catch { /* ignore */ }
  }

  reconfigure() {
    this.generation += 1;
    const settings = relationshipPilotConfig(this.config());
    if (!settings.enabled) {
      this.stop();
      return this.status();
    }
    return this.start();
  }

  /**
   * 账本保留期清理的对外入口：原来只在 RelationshipPilotStore 构造函数里跑一次，
   * 常驻进程不重启等于不执行（2026-10-09 复审）。这里给进程内每日调度一个稳定调用点，
   * 签名与默认值保持不变（store.pruneHistory(retentionDays = 90)），只做转发。
   * 试点未启用/已停止时 relationshipStore 为空，静默跳过。
   */
  pruneHistory(retentionDays = 90) {
    try { this.relationshipStore?.pruneHistory(retentionDays); }
    catch { /* 清理失败不影响评估 */ }
  }

  status() {
    const settings = relationshipPilotConfig(this.config());
    return {
      enabled: settings.enabled,
      active: this.active,
      shadowMode: true,
      error: this.lastError,
      database: pathName(relationshipDatabasePath(this.dataDir)),
      counts: this.relationshipStore?.counts() || { states: 0, events: 0, openFlags: 0 },
      queuedEvaluations: this.queued,
      runningEvaluations: this.running,
      evaluatorVersion: settings.evaluatorVersion,
      settings: {
        minNewMessages: settings.minNewMessages,
        minBatchMessages: settings.minBatchMessages,
        minBatchAgeMinutes: settings.minBatchAgeMinutes,
        maxEvidenceMessages: settings.maxEvidenceMessages,
        maxEvaluationsPerDay: settings.maxEvaluationsPerDay,
        frictionHalfLifeHours: settings.frictionHalfLifeHours
      }
    };
  }

  observeMessage(chatKey, message) {
    if (!this.active || !relationshipPilotEnabled(this.config())) return false;
    const uin = String(message?.senderId || '').trim();
    if (message?.self || !/^\d{1,15}$/.test(uin)) return false;
    const settings = relationshipPilotConfig(this.config());
    const now = Date.now();
    const last = Number(this.lastFamiliarityRefresh.get(uin)) || 0;
    if (now - last >= settings.familiarityRefreshMinutes * 60000) {
      try {
        this.#refreshFamiliarity(uin, now);
        this.lastFamiliarityRefresh.set(uin, now);
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        this.log(`[relationship-pilot] 熟悉度刷新失败：${this.lastError}`, error);
      }
    }
    return true;
  }

  handleSuccessfulTurn({ chatKey, triggerEntries = [] } = {}) {
    if (!this.active || !relationshipPilotEnabled(this.config())) return { scheduled: 0 };
    const settings = relationshipPilotConfig(this.config());
    const selfId = String(this.identityPilot?.onebot?.selfId || '');
    const ranked = new Map();
    for (const entry of triggerEntries || []) {
      const uin = String(entry?.senderId || '').trim();
      if (entry?.self || !/^\d{1,15}$/.test(uin) || uin === selfId) continue;
      const repliesToAgent = String(entry?.reply?.senderId || '') === selfId;
      const priority = String(chatKey).startsWith('private:')
        ? 4
        : repliesToAgent
          ? 4
          : entry?.mentionsSelf
            ? 3
            : 1;
      const previous = ranked.get(uin) || { uin, priority: 0, at: 0 };
      previous.priority = Math.max(previous.priority, priority);
      previous.at = Math.max(previous.at, Number(entry?.ts) || 0);
      ranked.set(uin, previous);
    }
    const targets = [...ranked.values()]
      .sort((a, b) => b.priority - a.priority || b.at - a.at)
      .slice(0, settings.maxPeoplePerTurn);
    for (const target of targets) this.#queueEvaluation(target.uin, { sourceChatKey: chatKey });
    return { scheduled: targets.length, userIds: targets.map((item) => item.uin) };
  }

  relationshipFor(userId) {
    if (!this.active) return null;
    const settings = relationshipPilotConfig(this.config());
    const uin = String(userId || '').trim();
    try {
      this.#refreshFamiliarity(uin);
    } catch { /* keep last state */ }
    const state = this.relationshipStore.getState(uin, { halfLifeHours: settings.frictionHalfLifeHours });
    if (!state) return null;
    return {
      ...state,
      shadowMode: true,
      openFlags: this.relationshipStore.openFlags(uin),
      recentEvents: this.relationshipStore.recentEvents(uin, 12)
    };
  }

  augmentPerson(person) {
    if (!person) return person;
    return {
      ...person,
      relationship: this.relationshipFor(person.userId)
    };
  }

  #queueEvaluation(uin, context = {}) {
    const generation = this.generation;
    this.queued += 1;
    this.queue = this.queue.then(async () => {
      this.queued = Math.max(0, this.queued - 1);
      if (generation !== this.generation || !this.active || !relationshipPilotEnabled(this.config())) return;
      this.running += 1;
      try {
        await this.#maybeEvaluate(uin, context);
      } catch (error) {
        this.lastError = String(error?.message ?? error);
        this.log(`[relationship-pilot] ${uin} 影子评估失败：${this.lastError}`, error);
      } finally {
        this.running = Math.max(0, this.running - 1);
        this.emit('relationship-pilot-update', this.status());
      }
    }, async () => {
      this.queued = Math.max(0, this.queued - 1);
    });
  }

  #statsForUser(uin) {
    const selfId = String(this.identityPilot?.onebot?.selfId || '');
    const replyNeedle = selfId ? `%\"senderId\":\"${selfId}\"%` : '%__never__%';
    const row = this.store.db.prepare(`SELECT
      COUNT(*) AS messageCount,
      COUNT(DISTINCT chat_key) AS chatCount,
      COUNT(DISTINCT date(ts / 1000, 'unixepoch', '+8 hours')) AS activeDays,
      MAX(ts) AS lastInteractionAt,
      COALESCE(SUM(CASE WHEN chat_key=? OR mentions_self=1 OR reply LIKE ? THEN 1 ELSE 0 END),0)
        AS directInteractions
      FROM messages WHERE self=0 AND sender_id=?`).get(`private:${uin}`, replyNeedle, String(uin));
    return {
      messageCount: Number(row?.messageCount) || 0,
      chatCount: Number(row?.chatCount) || 0,
      activeDays: Number(row?.activeDays) || 0,
      directInteractions: Number(row?.directInteractions) || 0,
      lastInteractionAt: Number(row?.lastInteractionAt) || 0
    };
  }

  #refreshFamiliarity(uin, now = Date.now()) {
    if (!this.relationshipStore || !/^\d{1,15}$/.test(String(uin || ''))) return null;
    return this.relationshipStore.refreshFamiliarity(String(uin), this.#statsForUser(String(uin)), now);
  }

  #evaluationCountToday() {
    if (!this.relationshipStore) return 0;
    return Number(this.relationshipStore.db.prepare(`SELECT COUNT(*) AS n FROM relationship_evaluations
      WHERE created_at>=?`).get(shanghaiDayStart())?.n) || 0;
  }

  #newEvidence(uin, maxEvidence, scopeChatKey = '') {
    const cursors = this.relationshipStore.cursors(uin);
    const vis = memoryVisibilityOf(this.config());
    // 证据同样受 memory.visibility 约束：perChat 只看当前会话；群里不把私聊原文带进来。
    const chats = this.store.db.prepare(`SELECT chat_key,MAX(id) AS maxId FROM messages
      WHERE self=0 AND sender_id=? GROUP BY chat_key ORDER BY MAX(ts) DESC`).all(String(uin))
      .filter((chat) => {
        const key = String(chat.chat_key);
        const scope = String(scopeChatKey || '');
        if (!scope) return true;
        if (vis.mode === 'perChat') return key === scope;
        if (vis.hidePrivateInGroup && scope.startsWith('group:') && key.startsWith('private:')) return false;
        return true;
      });
    const bootstrapPerChat = Math.max(2, Math.ceil(maxEvidence / Math.max(1, chats.length)));
    const rows = [];
    for (const chat of chats) {
      const chatKey = String(chat.chat_key);
      const cursor = Number(cursors[chatKey]) || 0;
      const chunk = cursor > 0
        ? this.store.db.prepare(`SELECT * FROM messages WHERE chat_key=? AND self=0 AND sender_id=?
            AND id>? ORDER BY id LIMIT ?`).all(chatKey, String(uin), cursor, maxEvidence)
        : this.store.db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE chat_key=? AND self=0
            AND sender_id=? ORDER BY id DESC LIMIT ?) ORDER BY id`).all(
            chatKey, String(uin), bootstrapPerChat
          );
      for (const row of chunk) {
        // 屏蔽名单是"历史消息也不能再进模型"：关系证据按 mid/原文读取，同样要过滤。
        const [rowKind, rowGroup] = String(row.chat_key || '').split(':');
        if (rowKind === 'group' && rowGroup
          && (getConfig().blocklist?.[rowGroup] || []).map(String).includes(String(row.sender_id))) continue;
        rows.push(row);
      }
    }
    rows.sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.id) - Number(b.id));
    const selected = rows.length > maxEvidence ? rows.slice(0, maxEvidence) : rows;
    const selfId = String(this.identityPilot?.onebot?.selfId || '');
    return selected.map((row) => {
      let reply = null;
      try { reply = row.reply ? JSON.parse(row.reply) : null; } catch { reply = null; }
      return {
        evidenceId: `${row.chat_key}#${row.id}`,
        chatKey: String(row.chat_key),
        messageId: Number(row.id) || 0,
        at: Number(row.ts) || 0,
        text: clean(row.text, 1000),
        mentionsAgent: Boolean(row.mentions_self),
        repliesToAgent: Boolean(selfId && String(reply?.senderId || '') === selfId)
      };
    });
  }

  #agentContext(evidence) {
    const byChat = new Map();
    for (const item of evidence) {
      const current = byChat.get(item.chatKey) || { min: item.at, max: item.at };
      current.min = Math.min(current.min, item.at);
      current.max = Math.max(current.max, item.at);
      byChat.set(item.chatKey, current);
    }
    const context = [];
    for (const [chatKey, range] of byChat) {
      const rows = this.store.db.prepare(`SELECT id,ts,text FROM messages WHERE chat_key=? AND self=1
        AND ts BETWEEN ? AND ? ORDER BY id DESC LIMIT 12`).all(
          chatKey,
          Math.max(0, range.min - 10 * 60000),
          range.max + 10 * 60000
        ).reverse();
      for (const row of rows) {
        context.push({
          chatKey,
          messageId: Number(row.id) || 0,
          at: Number(row.ts) || 0,
          speaker: 'agent',
          text: clean(row.text, 800),
          countableEvidence: false
        });
      }
    }
    return context.sort((a, b) => a.at - b.at).slice(-24);
  }

  #cursorUpdates(evidence) {
    const updates = {};
    for (const item of evidence) {
      updates[item.chatKey] = Math.max(Number(updates[item.chatKey]) || 0, Number(item.messageId) || 0);
    }
    return updates;
  }

  #memoryContext(uin, limit, chatKey = '') {
    const memory = globalMemoryStoreForIdentity();
    if (!memory || limit <= 0) return [];
    const member = memory.getMember('', String(uin));
    // 与提示词/记忆工具同口径：perChat / hidePrivateInGroup 在这里也必须生效，
    // 否则私聊印象会经"关系影子评估"这条新路径重新进入模型。
    const impressions = visibleImpressions(member?.impressions || [], chatKey, memoryVisibilityOf(this.config()));
    return [...impressions]
      .sort((a, b) => (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
        - (Number(a.lastObservedAt) || Number(a.createdAt) || 0))
      .slice(0, limit)
      .map((item) => ({
        content: clean(item?.content, 300),
        observedAt: Number(item?.lastObservedAt) || Number(item?.createdAt) || 0
      }));
  }

  async #maybeEvaluate(uin, { sourceChatKey = '' } = {}) {
    const settings = relationshipPilotConfig(this.config());
    if (!settings.enabled || !this.relationshipStore) return { evaluated: false, reason: 'disabled' };
    if (this.#evaluationCountToday() >= settings.maxEvaluationsPerDay) {
      return { evaluated: false, reason: 'daily-budget' };
    }
    const state = this.#refreshFamiliarity(uin) || this.relationshipStore.getState(uin);
    const evidence = this.#newEvidence(uin, settings.maxEvidenceMessages, sourceChatKey);
    if (!evidence.length) return { evaluated: false, reason: 'no-new-evidence' };
    const ageMs = state?.lastEvaluatedAt ? Date.now() - state.lastEvaluatedAt : 0;
    const eligible = evidence.length >= settings.minNewMessages
      || (state?.lastEvaluatedAt > 0
        && evidence.length >= settings.minBatchMessages
        && ageMs >= settings.minBatchAgeMinutes * 60000);
    if (!eligible) return { evaluated: false, reason: 'below-batch-threshold', evidence: evidence.length };

    const person = this.identityPilot?.identityStore?.getPerson?.(uin, {
      chatKey: sourceChatKey || evidence.at(-1)?.chatKey || ''
    }) || { userId: String(uin) };
    const openFlags = this.relationshipStore.openFlags(uin);
    const systemPrompt = buildRelationshipSystemPrompt();
    const userPrompt = buildRelationshipUserPrompt({
      person,
      memoryContext: this.#memoryContext(uin, settings.maxMemoryContext, sourceChatKey || evidence.at(-1)?.chatKey || ''),
      openFlags,
      evidence,
      agentContext: this.#agentContext(evidence)
    });
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const tools = [RELATIONSHIP_EVENT_TOOL];
    const evaluationId = this.relationshipStore.beginEvaluation(uin, {
      evidenceCount: evidence.length,
      sourceChatKeys: [...new Set(evidence.map((item) => item.chatKey))],
      model: settings.model
    });
    const session = this.sessions?.create({
      chatKey: sourceChatKey || evidence.at(-1)?.chatKey || `private:${uin}`,
      trigger: [],
      triggerSummary: `关系影子评估：${person?.primaryName || uin}`
    }) || null;
    if (session) {
      session.kind = 'relationship-review';
      session.relationshipShadowMode = true;
      session.relationshipTargetUserId = String(uin);
      session.relationshipEvaluationId = evaluationId;
      session.systemPrompt = systemPrompt;
      session.userPrompt = userPrompt;
      session.promptChars = systemPrompt.length + userPrompt.length;
      session.model = settings.model;
      session.inputMessages = structuredClone(messages);
      session.inputTools = structuredClone(tools);
      session.inputRequestOptions = { toolChoice: 'auto', temperature: 0.1, maxTokens: 1600 };
      session.inputRound = 1;
      session.inputPayloadChars = JSON.stringify({ messages, tools }).length;
      session.triggerKind = 'relationship-shadow';
      session.triggerReason = `新增关系证据 ${evidence.length} 条`;
      this.sessions.update(session.id);
      this.emit('session-start', {
        sessionId: session.id,
        chatKey: session.chatKey,
        triggerSummary: session.triggerSummary
      });
    }

    let usage = {};
    try {
      const response = await this.complete({
        messages,
        tools,
        toolChoice: 'auto',
        temperature: 0.1,
        purpose: 'judge',   // 关系评估 = 判断类任务
        maxTokens: 1600
      }, 0);
      usage = usageOf(response);
      const parsed = parseRelationshipResponse(response, evidence);
      const applied = this.relationshipStore.applyEvaluation(uin, parsed.events, {
        cursorUpdates: this.#cursorUpdates(evidence),
        halfLifeHours: settings.frictionHalfLifeHours,
        evaluatorVersion: settings.evaluatorVersion
      });
      this.relationshipStore.finishEvaluation(evaluationId, { status: 'done', usage });
      if (session) {
        session.rounds = 1;
        session.usage = usage;
        session.finishReason = parsed.events.length
          ? `影子评估记录 ${parsed.events.length} 个关系事件`
          : `影子评估无关系变化${parsed.noChangeReason ? `：${parsed.noChangeReason}` : ''}`;
        session.callUsage = [callUsageOf(response)];
        session.messages.push({
          role: 'assistant',
          content: response?.message?.content ?? null,
          ...(typeof response?.message?.reasoning_content === 'string' && response.message.reasoning_content
            ? { reasoning_content: response.message.reasoning_content }
            : {}),
          ...(resolveToolCalls(response?.message).length
            ? { tool_calls: structuredClone(resolveToolCalls(response?.message)) }
            : {}),
          raw: response.raw ?? null
        });
        this.sessions.finish(session.id, 'done');
        this.emit('session-end', {
          sessionId: session.id,
          chatKey: session.chatKey,
          status: 'done',
          usage
        });
      }
      this.emit('relationship-pilot-update', {
        userId: String(uin),
        state: applied.state,
        appliedEvents: applied.appliedEvents.length,
        shadowMode: true
      });
      return {
        evaluated: true,
        userId: String(uin),
        events: parsed.events,
        state: applied.state,
        shadowMode: true
      };
    } catch (error) {
      this.relationshipStore.finishEvaluation(evaluationId, {
        status: 'failed', usage, error: String(error?.message ?? error)
      });
      if (session) {
        session.error = String(error?.message ?? error);
        this.sessions.finish(session.id, 'error');
        this.emit('session-end', {
          sessionId: session.id,
          chatKey: session.chatKey,
          status: 'error',
          usage
        });
      }
      throw error;
    }
  }
}

function pathName(value) {
  return String(value || '').split(/[\\/]/).pop() || 'relationship-pilot.sqlite';
}

export { parseRelationshipResponse };
