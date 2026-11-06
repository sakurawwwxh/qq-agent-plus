import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  DATA_DIR,
  friendProposalEnabled,
  friendRequestDispatchEnabled,
  getConfig,
  incomingFriendRequestEnabled,
  identityPilotEnabled,
  promptFriendProposalEnabled,
  triggeredFriendProposalEnabled
} from '../core/config.js';
import { chatAllowed } from '../core/access.js';
import { chatCompletionWithRetry, cachedTokensOfUsage } from '../llm/llm.js';
import { shanghaiDayStart } from '../core/util.js';
import {
  IdentityStore,
  identityDatabasePath,
  readLegacyIdentityMemories
} from './identity-store.js';
import {
  FriendRequestProtocolError,
  sendFriendRequestViaSnowLuma
} from './friend-request-protocol.js';
import {
  buildFriendReviewSystemPrompt,
  buildFriendReviewUserPrompt,
  FRIEND_REVIEW_TOOL
} from '../llm/friend-review-prompt.js';
import { resolveToolCalls } from '../tools/inline-tools.js';

const DB_DISPLAY_NAME = 'identity-pilot.sqlite';
const FRIEND_REVIEW_RATINGS = ['quality', 'interest', 'reciprocity', 'stability'];

function reviewUsage(response) {
  const usage = response?.usage || {};
  return {
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
    cachedTokens: cachedTokensOfUsage(usage),
    calls: 1
  };
}

export function parseFriendReview(response, history, settings) {
  const calls = resolveToolCalls(response?.message);
  if (calls.length !== 1 || calls[0]?.function?.name !== 'submit_friend_review') {
    throw new Error('模型未提交唯一的 submit_friend_review 结果');
  }
  let value;
  try {
    value = JSON.parse(String(calls[0].function.arguments || '{}'));
  } catch {
    throw new Error('好友评估工具参数不是有效 JSON');
  }
  if (!['propose', 'skip'].includes(value?.decision)) {
    throw new Error('好友评估 decision 必须是 propose 或 skip');
  }
  const ratings = {};
  for (const key of FRIEND_REVIEW_RATINGS) {
    const rating = Number(value?.ratings?.[key]);
    if (!Number.isInteger(rating) || rating < 0 || rating > 4) {
      throw new Error(`好友评估评分 ${key} 必须是 0 到 4 的整数`);
    }
    ratings[key] = rating;
  }
  const allowedEvidence = new Set(history.evidenceIds || []);
  const evidenceIds = [...new Set((Array.isArray(value.evidenceIds)
    ? value.evidenceIds
    : []).map(String))];
  if (evidenceIds.some((id) => !allowedEvidence.has(id))) {
    throw new Error('好友评估引用了不存在的证据');
  }
  const reasonCode = ['interest', 'frequent', 'banter'].includes(value.reasonCode)
    ? value.reasonCode
    : '';
  const reason = String(value.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!reasonCode || !reason) throw new Error('好友评估缺少有效原因');
  const weights = settings.weights || {};
  const score = FRIEND_REVIEW_RATINGS.reduce((sum, key) =>
    sum + (Number(weights[key]) || 0) * ratings[key] / 4, 0);
  return {
    decision: value.decision,
    ratings,
    evidenceIds,
    reasonCode,
    reason,
    verificationMessage: String(value.verificationMessage || '')
      .replace(/\s+/g, ' ').trim().slice(0, 50),
    score: Math.round(score * 100) / 100,
    qualified: value.decision === 'propose'
      && score >= Number(settings.scoreThreshold)
      && evidenceIds.length >= 2
  };
}

function sourceAllowed(chatKey, userId, cfg = getConfig()) {
  if (!chatAllowed(chatKey, cfg)) return false;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group' && (cfg.blocklist?.[id] || []).map(String).includes(String(userId))) {
    return false;
  }
  return true;
}

export class IdentityPilotManager {
  constructor({
    store,
    onebot,
    dataDir = DATA_DIR,
    config = getConfig,
    notifyFriendProposal = null,
    notifyIncomingFriendRequest = null,
    allowPrivateUser = null,
    sendFriendRequest = sendFriendRequestViaSnowLuma,
    sessions = null,
    complete = chatCompletionWithRetry,
    random = Math.random,
    emit = null,
    log = console.log
  }) {
    this.store = store;
    this.onebot = onebot;
    this.dataDir = dataDir;
    this.config = config;
    this.notifyFriendProposal = notifyFriendProposal;
    this.notifyIncomingFriendRequest = notifyIncomingFriendRequest;
    this.allowPrivateUser = allowPrivateUser;
    this.sendFriendRequest = sendFriendRequest;
    this.sessions = sessions;
    this.complete = complete;
    this.random = random;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.log = log;
    this.identityStore = null;
    this.starting = null;
    this.lastError = '';
    this.friendSyncError = '';
    this.friendSnapshotAt = 0;
    this.friendSyncing = null;
    this.pendingIncomingEvents = [];
    this.friendReviewGeneration = 1;
    this.friendReviewControllers = new Map();
    this.friendReviewTasks = new Set();
    this.friendReviewChain = Promise.resolve();
  }

  get active() {
    return Boolean(this.identityStore);
  }

  async start() {
    if (!identityPilotEnabled(this.config())) return this.status();
    if (this.identityStore) return this.status();
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #start() {
    let db = null;
    try {
      db = new IdentityStore({ dataDir: this.dataDir });
      this.store.ensureIdentityLookupIndex();
      const cfg = this.config();
      const allowSource = (chatKey, userId) => sourceAllowed(chatKey, userId, cfg);
      let friends = [];
      this.friendSyncError = '';
      try {
        const result = await this.onebot.call('get_friend_list');
        friends = Array.isArray(result)
          ? result
          : Array.isArray(result?.data)
            ? result.data
            : [];
        this.friendSnapshotAt = Date.now();
      } catch (error) {
        this.friendSyncError = String(error?.message ?? error);
        this.friendSnapshotAt = 0;
        // 与 reindex 同款兜底：拉不到好友列表就沿用库里已知的好友，别拿空表去 rebuild
        // —— is_friend 标注是慢慢积累的，一次协议端抖动就全表清零（2026-10-10 审查 D1）
        friends = db.listKnownFriends();
        this.log(`[identity-pilot] 好友列表读取失败，先按消息与旧库已知好友（${friends.length} 个）建库：${this.friendSyncError}`, error);
      }
      // 远程好友请求可能等待数秒；最后再截取本地消息，避免等待期间的新消息漏索引。
      const activityRows = this.store.identityActivityRows()
        .filter((row) => allowSource(row.chatKey, row.userId));
      const legacyMemories = readLegacyIdentityMemories(this.dataDir, { allowSource });
      db.rebuild({ activityRows, legacyMemories, friends });
      if (!identityPilotEnabled(this.config())) {
        db.close();
        return this.status();
      }
      this.identityStore = db;
      await this.#syncKnownFriendWhitelists(friends);
      this.lastError = '';
      const queuedIncoming = this.pendingIncomingEvents.splice(0);
      for (const request of queuedIncoming) {
        // 2026-10-06 复审 P2：启动冲刷里单条请求失败（如待审批积压到上限时 createIncoming
        // 抛错）不能带崩整个 start() —— catch 会关掉 db 但 identityStore 仍指向已关闭句柄，
        // start() 又被 `if (this.identityStore)` 短路，身份功能整体瘫痪到重启且无法自愈。
        try {
          await this.receiveIncomingFriendRequest(request);
        } catch (error) {
          this.log(`[identity-pilot] 启动冲刷入站好友请求失败（跳过该条，继续启动）：${error?.message ?? error}`, error);
        }
      }
      if (incomingFriendRequestEnabled(this.config())) {
        const pendingIncoming = this.identityStore.listIncomingFriendRequests({
          status: 'pending',
          limit: 100
        }).filter((request) => !request.notifiedAt);
        await Promise.all(pendingIncoming.map((request) =>
          this.#notifyIncomingFriendRequest(request).catch((error) => {
            this.log(`[identity-pilot] 待审批请求通知失败（不阻塞启动）：${error?.message ?? error}`, error);
          })));
      }
      return this.status();
    } catch (error) {
      // 关库的同时必须把 identityStore 摘干净：active getter、start() 短路、status()/observe
      // 全都认这个字段 —— 留着已关闭句柄比 null 更糟（null 还能重新 start 重建）。
      if (this.identityStore === db) this.identityStore = null;
      try { db?.close(); } catch { /* ignore */ }
      this.lastError = String(error?.message ?? error);
      throw error;
    }
  }

  async reindex() {
    if (!this.identityStore || !identityPilotEnabled(this.config())) return this.status();
    const cfg = this.config();
    const allowSource = (chatKey, userId) => sourceAllowed(chatKey, userId, cfg);
    let friends = [];
    this.friendSyncError = '';
    try {
      const result = await this.onebot.call('get_friend_list');
      friends = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : [];
      this.friendSnapshotAt = Date.now();
    } catch (error) {
      this.friendSyncError = String(error?.message ?? error);
      friends = this.identityStore.listKnownFriends();
    }
    const activityRows = this.store.identityActivityRows()
      .filter((row) => allowSource(row.chatKey, row.userId));
    const legacyMemories = readLegacyIdentityMemories(this.dataDir, { allowSource });
    this.identityStore.rebuild({ activityRows, legacyMemories, friends });
    await this.#syncKnownFriendWhitelists(friends);
    return this.status();
  }

  async stop() {
    const store = this.identityStore;
    this.friendReviewGeneration += 1;
    for (const controller of this.friendReviewControllers.values()) {
      controller.abort(new Error('主动好友评估功能已停止'));
    }
    try { store?.cancelFriendReviews('feature-disabled'); } catch { /* ignore */ }
    this.identityStore = null;
    this.pendingIncomingEvents = [];
    this.friendSnapshotAt = 0;
    try {
      if (this.friendReviewTasks.size) await Promise.allSettled([...this.friendReviewTasks]);
    } finally {
      try { store?.close(); } catch { /* ignore */ }
    }
  }

  reconfigure() {
    this.friendReviewGeneration += 1;
    for (const controller of this.friendReviewControllers.values()) {
      controller.abort(new Error('主动好友评估配置已改变'));
    }
    return this.identityStore?.cancelFriendReviews('feature-reconfigured') || 0;
  }

  observeMessage(chatKey, message) {
    if (!this.identityStore || !identityPilotEnabled(this.config())) return false;
    if (!sourceAllowed(chatKey, message?.senderId, this.config())) return false;
    try {
      return this.identityStore.observe(chatKey, message);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.log(`[identity-pilot] 增量索引失败：${this.lastError}`, error);
      return false;
    }
  }

  listPeople(limit = 100) {
    return this.identityStore ? this.identityStore.listPeople(limit) : [];
  }

  lookupPerson(userId, { chatKey } = {}) {
    if (!this.identityStore || !identityPilotEnabled(this.config())) return null;
    const source = String(chatKey || '');
    const uin = String(userId ?? '').trim();
    if (!sourceAllowed(source, uin, this.config())) return null;
    if (!this.identityStore.hasSource(uin, source)) return null;
    return this.identityStore.getPerson(uin, { chatKey: source });
  }

  async proposeFriend({
    userId,
    chatKey,
    reasonCode,
    reason,
    verificationMessage = '',
    signal
  }) {
    const cfg = this.config();
    const settings = cfg.identityPilot?.friendProposal || {};
    if (!this.identityStore || !promptFriendProposalEnabled(cfg)) {
      throw new Error('主动好友候选功能当前未启用');
    }
    const ownerUin = String(settings.ownerUin || '').trim();
    if (!/^\d{5,15}$/.test(ownerUin)) {
      throw new Error('尚未配置接收好友审批的管理员 QQ');
    }
    const targetUin = String(userId || '').trim();
    if (targetUin === ownerUin) throw new Error('不能把审批管理员本人列为好友候选');
    const result = this.identityStore.createFriendProposal({
      userId: targetUin,
      sourceChatKey: chatKey,
      reasonCode,
      reason,
      verificationMessage,
      minMessageCount: settings.minMessageCount,
      cooldownDays: settings.cooldownDays,
      maxPending: settings.maxPending
    });
    if (!result.created) {
      return {
        ...result,
        adminNotified: Boolean(result.proposal.notifiedAt),
        protocolDispatchSupported: true
      };
    }
    const notified = await this.#notifyFriendProposalRecord(
      this.identityStore,
      result.proposal,
      signal
    );
    return {
      created: true,
      proposal: notified.proposal,
      adminNotified: notified.adminNotified,
      protocolDispatchSupported: true
    };
  }

  listFriendProposals(options = {}) {
    return this.identityStore ? this.identityStore.listFriendProposals(options) : [];
  }

  listFriendOpportunities(options = {}) {
    return this.identityStore ? this.identityStore.listFriendOpportunities(options) : [];
  }

  async handleSuccessfulTurn({
    chatKey,
    triggerEntries = [],
    parentSessionId = '',
    triggerReason = '',
    repliedThisRun = false
  } = {}) {
    const cfg = this.config();
    const settings = cfg.identityPilot?.friendProposal?.triggered || {};
    if (
      !this.identityStore
      || !friendProposalEnabled()
      || !triggeredFriendProposalEnabled(cfg)
      || cfg.runtime?.mode !== 'active'
    ) return { triggered: false, reason: 'disabled' };
    const now = Date.now();
    const accountUin = await this.#ensureFreshFriendSnapshot();
    if (!accountUin) return { triggered: false, reason: 'friend-status-unknown' };
    const ownerUin = String(cfg.identityPilot?.friendProposal?.ownerUin || '');
    const maxAgeMs = Math.max(1, Number(settings.maxTriggerAgeMinutes) || 10) * 60000;
    const candidates = new Map();
    for (const entry of triggerEntries) {
      const userId = String(entry?.senderId || '').trim();
      if (
        entry?.self
        || (entry?.eventKind && entry.eventKind !== 'message')
        || !/^\d{1,15}$/.test(userId)
        || userId === accountUin
        || userId === ownerUin
        || now - (Number(entry?.ts) || 0) > maxAgeMs
        || !sourceAllowed(chatKey, userId, cfg)
      ) continue;
      const directReply = ['self', accountUin].includes(String(entry?.reply?.senderId || ''));
      const priority = String(chatKey).startsWith('private:') || directReply
        ? 4
        : entry?.mentionsSelf
          ? 3
          : /续接|生命周期/.test(String(triggerReason || ''))
            ? 2
            : 1;
      const current = candidates.get(userId) || {
        userId,
        priority: 0,
        lastAt: 0,
        entries: []
      };
      current.priority = Math.max(current.priority, priority);
      current.lastAt = Math.max(current.lastAt, Number(entry.ts) || 0);
      current.entries.push(entry);
      candidates.set(userId, current);
    }
    const ranked = [...candidates.values()]
      .map((candidate) => ({
        ...candidate,
        lastOpportunityAt: this.identityStore.lastFriendOpportunityAt(
          accountUin,
          candidate.userId
        )
      }))
      .sort((a, b) =>
        b.priority - a.priority
        || a.lastOpportunityAt - b.lastOpportunityAt
        || b.lastAt - a.lastAt
        || a.userId.localeCompare(b.userId));
    const since = now - Math.max(1, Number(settings.historyDays) || 30) * 86400000;
    let selected = null;
    for (const candidate of ranked) {
      const blocked = this.identityStore.triggeredCandidateBlockReason(
        candidate.userId,
        chatKey,
        {
          accountUin,
          now,
          drawCooldownMs: Math.max(
            1,
            Number(settings.drawCooldownMinutes) || 30
          ) * 60000,
          dayStart: shanghaiDayStart(now),
          maxDrawsPerDay: Number(settings.maxDrawsPerUserPerDay) || 6
        }
      );
      if (blocked) continue;
      const metrics = this.store.friendEligibilityMetrics(chatKey, candidate.userId, {
        since,
        until: now,
        selfId: accountUin
      });
      if (
        metrics.messageCount < Number(settings.minMessages)
        || metrics.activeDays < Number(settings.minActiveDays)
        || metrics.directExchanges < Number(settings.minDirectExchanges)
      ) continue;
      selected = { ...candidate, metrics };
      break;
    }
    if (!selected) return { triggered: false, reason: 'no-eligible-candidate' };
    if (this.identityStore.isKnownFriend(selected.userId)) {
      return { triggered: false, reason: 'already-friend' };
    }
    const triggerMessageIds = selected.entries.map((entry) => (
      entry.mid !== null && entry.mid !== undefined && String(entry.mid) !== ''
        ? `platform:${entry.mid}`
        : `local:${entry.id}`
    ));
    const triggerKey = `${accountUin}:${
      crypto.createHash('sha256').update(JSON.stringify({
        chatKey,
        userId: selected.userId,
        messageIds: triggerMessageIds.sort()
      })).digest('hex')
    }`;
    const generation = this.friendReviewGeneration;
    const snapshot = {
      settings: structuredClone(settings),
      persona: structuredClone(cfg.persona || {}),
      model: String(cfg.api?.model || ''),
      generation
    };
    const created = this.identityStore.createFriendOpportunity({
      accountUin,
      userId: selected.userId,
      sourceChatKey: chatKey,
      parentSessionId,
      triggerKey,
      triggerMessageIds,
      triggerReason,
      eligibility: selected.metrics,
      config: {
        ...settings,
        generation,
        model: snapshot.model
      },
      probability: Number(settings.probability),
      randomValue: this.random(),
      dayStart: shanghaiDayStart(now),
      maxDrawsPerDay: Number(settings.maxDrawsPerUserPerDay),
      maxReviewsPerDay: Number(settings.maxReviewsPerDay),
      drawCooldownMs: Number(settings.drawCooldownMinutes) * 60000,
      now
    });
    if (created.created) this.emit('identity-pilot-update', this.status());
    if (!created.created || created.opportunity?.status !== 'queued') {
      return {
        triggered: Boolean(created.created),
        reason: created.reason || created.opportunity?.status || 'not-selected',
        opportunity: created.opportunity
      };
    }
    const store = this.identityStore;
    const task = this.friendReviewChain
      .catch(() => {})
      .then(() => this.#runFriendReview(
        store,
        created.opportunity.id,
        snapshot,
        { repliedThisRun }
      ))
      .catch((error) => {
        this.log(`[identity-pilot] 好友评估 ${created.opportunity.id} 失败：${error?.message ?? error}`, error);
      });
    this.friendReviewChain = task;
    this.friendReviewTasks.add(task);
    task.finally(() => this.friendReviewTasks.delete(task));
    return {
      triggered: true,
      reason: 'queued',
      opportunity: created.opportunity
    };
  }

  async receiveIncomingFriendRequest({
    userId,
    flag,
    comment = '',
    signal
  }) {
    const cfg = this.config();
    if (!incomingFriendRequestEnabled(cfg)) {
      return { ignored: true, reason: 'disabled' };
    }
    if (!this.identityStore) {
      this.pendingIncomingEvents.push({ userId, flag, comment, signal });
      if (this.pendingIncomingEvents.length > 100) this.pendingIncomingEvents.shift();
      return { queued: true, reason: 'starting' };
    }
    // 人物资产被删除后，协议端再收到同一个人的好友请求也不再落库/通知：
    // 否则管理员在控制台删掉的人会被一条新请求重新拉回审批队列。
    if (this.identityStore.isIdentityAssetDeleted(userId)) {
      return { ignored: true, reason: 'person-deleted' };
    }
    const result = this.identityStore.createIncomingFriendRequest({
      userId,
      flag,
      comment,
      maxPending: cfg.identityPilot?.incomingFriendRequest?.maxPending
    });
    if (result.created || !result.request.notifiedAt) {
      await this.#notifyIncomingFriendRequest(result.request, signal);
    }
    return {
      ...result,
      request: this.identityStore.getIncomingFriendRequest(result.request.id)
    };
  }

  listIncomingFriendRequests(options = {}) {
    return this.identityStore
      ? this.identityStore.listIncomingFriendRequests(options)
      : [];
  }

  async decideIncomingFriendRequest(
    id,
    decision,
    { decidedBy = '', remark = '', signal } = {}
  ) {
    const cfg = this.config();
    if (!this.identityStore || !incomingFriendRequestEnabled(cfg)) {
      throw new Error('入站好友请求审批功能当前未启用');
    }
    const beforeDecision = this.identityStore.getIncomingFriendRequest(id);
    if (beforeDecision && this.identityStore.isIdentityAssetDeleted(beforeDecision.userId)) {
      throw new Error('人物资产已被删除，不能处理该好友请求');
    }
    const request = this.identityStore.beginIncomingFriendRequestDecision(
      id,
      decision,
      { decidedBy }
    );
    try {
      await this.onebot.call('set_friend_add_request', {
        flag: request.requestFlag,
        approve: decision === 'approve',
        ...(decision === 'approve' && String(remark || '').trim()
          ? { remark: String(remark).trim().slice(0, 60) }
          : {})
      }, 15000, signal);
      // 协议调用期间管理员可能刚删掉这个人物：删除事务已把这条请求标成
      // cancelled，此时不能再走 complete（状态已变），更不能加白。
      const deletedMeanwhile = this.identityStore.isIdentityAssetDeleted(request.userId);
      let completed = deletedMeanwhile
        ? this.identityStore.getIncomingFriendRequest(request.id)
        : this.identityStore.completeIncomingFriendRequestDecision(
          request.id,
          request.actionAttemptId,
          decision === 'approve' ? 'approved' : 'rejected'
        );
      let whitelistError = '';
      if (
        decision === 'approve'
        && !deletedMeanwhile
        && cfg.identityPilot?.incomingFriendRequest?.autoWhitelist !== false
      ) {
        try {
          // 审批期间管理员可能刚删掉这个人物：协议端已经同意（无法回滚），
          // 但绝不能再把白名单加回来。删除事务会把这条请求标成 cancelled。
          if (this.identityStore.isIdentityAssetDeleted(completed.userId)) {
            throw new Error('人物已被删除，跳过自动加白');
          }
          if (!this.allowPrivateUser) throw new Error('私聊白名单更新器未配置');
          await this.allowPrivateUser(completed.userId);
          completed = this.identityStore.markIncomingFriendWhitelist(
            completed.id,
            { applied: true }
          );
        } catch (error) {
          whitelistError = String(error?.message ?? error);
          completed = this.identityStore.markIncomingFriendWhitelist(
            completed.id,
            { applied: false, error: whitelistError }
          );
        }
      }
      return {
        request: completed,
        execution: decision === 'approve' ? 'approved' : 'rejected',
        note: deletedMeanwhile
          ? '人物资产已被删除，本地审批记录已取消，未加入私聊白名单。'
          : decision === 'approve'
            ? whitelistError
              ? `已同意好友请求，但私聊白名单更新失败：${whitelistError}`
              : '已同意好友请求，并已加入私聊白名单。'
            : '已拒绝好友请求。'
      };
    } catch (error) {
      const definiteFailure = /OneBot set_friend_add_request 失败: retcode=/i
        .test(String(error?.message ?? error));
      const completed = this.identityStore.completeIncomingFriendRequestDecision(
        request.id,
        request.actionAttemptId,
        definiteFailure ? 'failed' : 'held_unknown',
        { error: String(error?.message ?? error) }
      );
      return {
        request: completed,
        execution: definiteFailure ? 'failed' : 'held-unknown',
        note: definiteFailure
          ? `好友请求处理失败：${String(error?.message ?? error)}`
          : '好友请求处理结果未知；系统已停止自动重试，请在 QQ 客户端核对。'
      };
    }
  }

  async decideFriendProposal(id, decision, { decidedBy = '', signal } = {}) {
    const cfg = this.config();
    if (!this.identityStore || !friendProposalEnabled(cfg)) {
      throw new Error('主动好友候选功能当前未启用');
    }
    if (decision === 'approve') {
      // 先看本地状态，避免为一条已删除的候选白跑一次好友列表刷新（外网调用）。
      const beforeFresh = this.identityStore.getFriendProposal(id);
      if (!beforeFresh) throw new Error('好友候选不存在或已被删除');
      if (this.identityStore.isIdentityAssetDeleted(beforeFresh.userId)) {
        throw new Error('该人物已被删除，不能批准好友候选');
      }
      if (!await this.#ensureFriendSnapshotFresh(signal, true)) {
        throw new Error('好友关系状态无法确认，未执行批准');
      }
      const current = this.identityStore.getFriendProposal(id);
      if (!current) throw new Error('好友候选不存在或已被删除');
      if (this.identityStore.isIdentityAssetDeleted(current.userId)) {
        throw new Error('该人物已被删除，不能批准好友候选');
      }
      if (current && this.identityStore.isKnownFriend(current.userId)) {
        this.identityStore.markFriendAdded(current.userId);
        return {
          proposal: this.identityStore.getFriendProposal(id),
          protocolDispatchSupported: true,
          execution: 'accepted',
          note: '对方已经是好友，已关闭该候选，未重复发送申请。'
        };
      }
    }
    const activeDispatch = decision === 'approve' && friendRequestDispatchEnabled(cfg);
    let selfId = this.onebot.selfId;
    if (activeDispatch && !/^\d{5,15}$/.test(String(selfId || ''))) {
      const login = await this.onebot.call('get_login_info', {}, 15000, signal);
      selfId = String(login?.user_id || '');
      if (!/^\d{5,15}$/.test(selfId)) {
        throw new Error('OneBot 未返回有效的机器人 QQ，未开始发送');
      }
    }
    const proposal = this.identityStore.decideFriendProposal(id, decision, {
      decidedBy,
      dispatch: activeDispatch
    });
    if (decision !== 'approve') {
      return {
        proposal,
        protocolDispatchSupported: true,
        execution: 'none',
        note: '管理员已拒绝该好友候选。'
      };
    }
    if (!activeDispatch || proposal.status !== 'dispatching') {
      return {
        proposal,
        protocolDispatchSupported: true,
        execution: 'manual-required',
        note: '管理员已批准；主动发送实验开关未开启，请在 QQ 客户端手动发起。'
      };
    }

    try {
      const result = await this.sendFriendRequest(this.onebot, {
        selfId,
        userId: proposal.userId,
        sourceChatKey: proposal.sourceChatKey,
        verificationMessage: proposal.verificationMessage,
        signal
      });
      const sent = this.identityStore.completeFriendProposalDispatch(
        proposal.id,
        proposal.dispatchAttemptId,
        'sent'
      );
      return {
        proposal: sent,
        protocolDispatchSupported: true,
        execution: sent.status === 'accepted' ? 'accepted' : 'sent',
        dispatch: result,
        note: sent.status === 'accepted'
          ? '好友申请已确认，对方已成为好友。'
          : '好友申请 API 已明确受理；尚未成为好友，等待 friend_add 事件确认。'
      };
    } catch (error) {
      const definiteFailure = error instanceof FriendRequestProtocolError
        && error.outcome === 'failed';
      const outcome = definiteFailure ? 'failed' : 'held_unknown';
      const updated = this.identityStore.completeFriendProposalDispatch(
        proposal.id,
        proposal.dispatchAttemptId,
        outcome,
        { error: String(error?.message ?? error) }
      );
      if (updated.status === 'accepted') {
        return {
          proposal: updated,
          protocolDispatchSupported: true,
          execution: 'accepted',
          note: '已收到 friend_add 事件，对方已成为好友。'
        };
      }
      this.log(
        `[identity-pilot] 好友候选 ${proposal.id} 主动发送`
        + `${definiteFailure ? '失败' : '结果未知'}：${String(error?.message ?? error)}`,
        error
      );
      return {
        proposal: updated,
        protocolDispatchSupported: true,
        execution: definiteFailure ? 'failed' : 'held-unknown',
        note: definiteFailure
          ? `管理员已批准，但好友申请发送失败：${String(error?.message ?? error)}`
          : '管理员已批准，但发送结果未知；系统已停止自动重试，请在 QQ 客户端核对。'
      };
    }
  }

  /**
   * 删除人物资产：先掐掉该人物的在途评估（模型请求会 abort），再落墓碑并
   * 取消待批请求/待评审机会。保留现有 allow.private —— 删除人物不等于拉黑。
   */
  deleteIdentityAsset(userId) {
    if (!this.identityStore) return false;
    const target = String(userId);
    for (const [opportunityId, controller] of this.friendReviewControllers) {
      const opportunity = this.identityStore.getFriendOpportunity(opportunityId);
      if (opportunity?.userId === target) {
        controller.abort(new Error('人物资产已被删除'));
      }
    }
    return this.identityStore.deleteIdentityAsset(target);
  }

  async markFriendAdded(userId) {
    if (!this.identityStore) return 0;
    for (const [opportunityId, controller] of this.friendReviewControllers) {
      const opportunity = this.identityStore.getFriendOpportunity(opportunityId);
      if (opportunity?.userId === String(userId)) {
        controller.abort(new Error('对方已经成为好友'));
      }
    }
    const related = this.identityStore.listIncomingFriendRequests({ limit: 500 })
      .filter((request) =>
        request.userId === String(userId)
        && ['pending', 'deciding', 'approved', 'held_unknown', 'failed']
          .includes(request.status));
    const relatedProposals = this.identityStore.listFriendProposals({ limit: 500 })
      .filter((proposal) =>
        proposal.userId === String(userId)
        && ['pending', 'approved_manual', 'dispatching', 'sent', 'held_unknown', 'failed']
          .includes(proposal.status));
    const changed = this.identityStore.markFriendAdded(userId);
    const needsWhitelist = related.some((request) => !request.whitelistApplied)
      || relatedProposals.length > 0;
    if (
      needsWhitelist
      &&
      !this.identityStore.isIdentityAssetDeleted(userId)
      &&
      this.config().identityPilot?.incomingFriendRequest?.autoWhitelist !== false
      && this.allowPrivateUser
    ) {
      try {
        // friend_add 是协议端自动事件，不是管理员在控制台点“同意”：只补 allow，
        // 不能把管理员手写的 deny.private 静默删掉（与启动/重排同步同一口径）。
        await this.allowPrivateUser(String(userId), { clearDeny: false });
        for (const request of related) {
          this.identityStore.markIncomingFriendWhitelist(request.id, { applied: true });
        }
      } catch (error) {
        for (const request of related) {
          this.identityStore.markIncomingFriendWhitelist(request.id, {
            applied: false,
            error: String(error?.message ?? error)
          });
        }
      }
    }
    return Number(changed.proposals || 0)
      + Number(changed.incoming || 0)
      + Number(changed.opportunities || 0);
  }

  async #ensureFreshFriendSnapshot(signal) {
    if (!this.identityStore || !identityPilotEnabled(this.config())) return '';
    let accountUin = String(this.onebot?.selfId || '').trim();
    if (!/^\d{5,15}$/.test(accountUin)) {
      try {
        const login = await this.onebot.call('get_login_info', {}, 15000, signal);
        accountUin = String(login?.user_id || '').trim();
      } catch (error) {
        this.friendSyncError = String(error?.message ?? error);
        return '';
      }
    }
    if (!/^\d{5,15}$/.test(accountUin)) return '';
    if (!await this.#ensureFriendSnapshotFresh(signal)) return '';
    return accountUin;
  }

  async #ensureFriendSnapshotFresh(signal, force = false) {
    if (!this.identityStore || !identityPilotEnabled(this.config())) return false;
    const maxAgeMs = Math.max(
      1,
      Number(
        this.config().identityPilot?.friendProposal?.triggered?.friendStatusMaxAgeMinutes
      ) || 15
    ) * 60000;
    if (
      !force
      && this.friendSnapshotAt > 0
      && Date.now() - this.friendSnapshotAt <= maxAgeMs
    ) {
      return true;
    }
    if (!this.friendSyncing) {
      const store = this.identityStore;
      this.friendSyncing = (async () => {
        try {
          const result = await this.onebot.call('get_friend_list', {}, 15000, signal);
          const friends = Array.isArray(result)
            ? result
            : Array.isArray(result?.data)
              ? result.data
              : null;
          if (!friends) throw new Error('OneBot 好友列表响应格式无效');
          if (this.identityStore !== store) return false;
          store.replaceKnownFriends(friends);
          this.friendSnapshotAt = Date.now();
          this.friendSyncError = '';
          return true;
        } catch (error) {
          this.friendSyncError = String(error?.message ?? error);
          return false;
        } finally {
          this.friendSyncing = null;
        }
      })();
    }
    return Boolean(await this.friendSyncing);
  }

  async #runFriendReview(store, opportunityId, snapshot, { repliedThisRun = false } = {}) {
    const initial = store.getFriendOpportunity(opportunityId);
    if (!initial || initial.status !== 'queued') return;
    if (
      Date.now() - initial.createdAt
      > Math.max(5, Number(snapshot.settings.maxQueueAgeSeconds) || 120) * 1000
    ) {
      store.finishFriendReview(opportunityId, 'expired', { reason: 'queue-expired' });
      this.emit('identity-pilot-update', this.status());
      return;
    }
    if (
      snapshot.generation !== this.friendReviewGeneration
      || !triggeredFriendProposalEnabled(this.config())
    ) {
      store.finishFriendReview(opportunityId, 'cancelled', {
        reason: 'feature-reconfigured'
      });
      return;
    }
    const accountUin = await this.#ensureFreshFriendSnapshot();
    if (!accountUin || this.identityStore !== store) {
      store.finishFriendReview(opportunityId, 'cancelled', {
        reason: 'friend-status-unknown'
      });
      return;
    }
    if (store.isKnownFriend(initial.userId)) {
      const current = store.getFriendOpportunity(opportunityId);
      if (['queued', 'reviewing'].includes(current?.status)) {
        store.finishFriendReview(opportunityId, 'cancelled', {
          reason: 'already-friend'
        });
      }
      return;
    }
    const opportunity = store.beginFriendReview(opportunityId);
    if (!opportunity) return;
    const since = opportunity.createdAt
      - Math.max(1, Number(snapshot.settings.historyDays) || 30) * 86400000;
    const person = store.getPerson(opportunity.userId, {
      chatKey: opportunity.sourceChatKey
    });
    const metrics = this.store.friendEligibilityMetrics(
      opportunity.sourceChatKey,
      opportunity.userId,
      {
        since,
        until: opportunity.createdAt,
        selfId: accountUin
      }
    );
    const history = this.store.friendReviewHistory(
      opportunity.sourceChatKey,
      opportunity.userId,
      {
        since,
        until: opportunity.createdAt,
        maxCandidate: 24,
        maxAgent: 24,
        maxChars: 12000
      }
    );
    const systemPrompt = buildFriendReviewSystemPrompt(snapshot.persona, { accountNickname: this.onebot?.selfNickname || '' });
    const userPrompt = buildFriendReviewUserPrompt({
      opportunity,
      person,
      metrics,
      history,
      settings: snapshot.settings,
      triggerReason: opportunity.triggerReason,
      repliedThisRun
    });
    const reviewSession = this.sessions?.create({
      chatKey: opportunity.sourceChatKey,
      trigger: [],
      triggerSummary: `好友评估：${opportunity.primaryName || opportunity.userId}`
    }) || null;
    if (reviewSession) {
      reviewSession.kind = 'friend-review';
      reviewSession.parentSessionId = opportunity.parentSessionId;
      reviewSession.opportunityId = opportunity.id;
      reviewSession.systemPrompt = systemPrompt;
      reviewSession.userPrompt = userPrompt;
      reviewSession.promptChars = systemPrompt.length + userPrompt.length;
      reviewSession.model = snapshot.model;
      reviewSession.inputTools = [structuredClone(FRIEND_REVIEW_TOOL)];
      reviewSession.inputRequestOptions = { toolChoice: 'auto', temperature: 0.2 };
      this.sessions.update(reviewSession.id);
      this.emit('session-start', {
        sessionId: reviewSession.id,
        chatKey: opportunity.sourceChatKey,
        triggerSummary: reviewSession.triggerSummary
      });
    }
    const controller = new AbortController();
    this.friendReviewControllers.set(opportunity.id, controller);
    const timer = setTimeout(
      () => controller.abort(new Error('好友评估请求超时')),
      30000
    );
    let consumedUsage = {};
    try {
      const response = await this.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        tools: [FRIEND_REVIEW_TOOL],
        toolChoice: 'auto',
        temperature: 0.2,
        purpose: 'judge',   // 好友申请评估 = 判断类任务
        maxTokens: 2048,
        signal: controller.signal
      }, 0);
      const usage = reviewUsage(response);
      consumedUsage = usage;
      if (reviewSession) {
        reviewSession.rounds = 1;
        reviewSession.usage = usage;
        reviewSession.messages.push({
          assistant: String(response?.message?.content || '').slice(0, 1000),
          toolCalls: response?.message?.tool_calls || []
        });
        this.sessions.update(reviewSession.id);
      }
      const review = parseFriendReview(response, history, snapshot.settings);
      if (
        snapshot.generation !== this.friendReviewGeneration
        || !triggeredFriendProposalEnabled(this.config())
        || this.identityStore !== store
        || store.isIdentityAssetDeleted(opportunity.userId)
      ) {
        throw new Error('主动好友评估配置已改变');
      }
      if (!await this.#ensureFriendSnapshotFresh(undefined, true)) {
        throw new Error('好友关系状态无法确认');
      }
      if (store.isKnownFriend(opportunity.userId)) {
        const current = store.getFriendOpportunity(opportunity.id);
        if (['queued', 'reviewing'].includes(current?.status)) {
          store.finishFriendReview(opportunity.id, 'cancelled', {
            reason: 'already-friend',
            review,
            usage,
            model: response.model
          });
        }
        if (reviewSession) this.sessions.finish(reviewSession.id, 'noreply');
        return;
      }
      const status = review.qualified ? 'proposed' : 'skipped';
      const reason = review.decision === 'skip'
        ? 'model-skip'
        : review.score < Number(snapshot.settings.scoreThreshold)
          ? 'below-threshold'
          : review.evidenceIds.length < 2
            ? 'insufficient-evidence'
            : '';
      const completed = store.finishFriendReview(opportunity.id, status, {
        reason,
        review,
        usage,
        model: response.model,
        proposal: review.qualified
          ? {
              reasonCode: review.reasonCode,
              reason: review.reason,
              verificationMessage: review.verificationMessage,
              cooldownDays: this.config().identityPilot?.friendProposal?.cooldownDays,
              maxPending: this.config().identityPilot?.friendProposal?.maxPending
            }
          : null
      });
      if (completed.proposal) {
        await this.#notifyFriendProposalRecord(
          store,
          completed.proposal,
          controller.signal
        );
      }
      if (reviewSession) this.sessions.finish(reviewSession.id, 'done');
      if (reviewSession) {
        this.emit('session-end', {
          sessionId: reviewSession.id,
          chatKey: opportunity.sourceChatKey,
          status: 'done',
          usage
        });
      }
      this.emit('identity-pilot-update', this.status());
    } catch (error) {
      const cancelled = snapshot.generation !== this.friendReviewGeneration
        || !triggeredFriendProposalEnabled(this.config())
        || this.identityStore !== store
        || store.isIdentityAssetDeleted(opportunity.userId)
        || store.isKnownFriend(opportunity.userId);
      try {
        store.finishFriendReview(opportunity.id, cancelled ? 'cancelled' : 'review_failed', {
          reason: cancelled ? 'feature-reconfigured' : String(error?.message ?? error),
          usage: consumedUsage
        });
      } catch { /* state was already closed by reconfiguration/friend_add */ }
      if (reviewSession) {
        reviewSession.error = String(error?.message ?? error);
        this.sessions.finish(reviewSession.id, cancelled ? 'aborted' : 'error');
        this.emit('session-end', {
          sessionId: reviewSession.id,
          chatKey: opportunity.sourceChatKey,
          status: cancelled ? 'aborted' : 'error',
          error: reviewSession.error
        });
      }
      if (!cancelled) throw error;
    } finally {
      clearTimeout(timer);
      this.friendReviewControllers.delete(opportunity.id);
    }
  }

  async #notifyFriendProposalRecord(store, proposal, signal) {
    const ownerUin = String(
      this.config().identityPilot?.friendProposal?.ownerUin || ''
    ).trim();
    let adminNotified = false;
    let notifyError = '';
    try {
      if (!/^\d{5,15}$/.test(ownerUin)) {
        throw new Error('尚未配置接收好友审批的管理员 QQ');
      }
      if (!this.notifyFriendProposal) throw new Error('管理员通知通道未配置');
      await this.notifyFriendProposal(proposal, ownerUin, signal);
      adminNotified = true;
    } catch (error) {
      notifyError = String(error?.message ?? error);
      this.log(`[identity-pilot] 好友候选 ${proposal.id} 通知管理员失败：${notifyError}`);
    }
    return {
      proposal: store.markFriendProposalNotification(
        proposal.id,
        { notified: adminNotified, error: notifyError }
      ),
      adminNotified
    };
  }

  status() {
    const cfg = this.config();
    const proposalConfig = cfg.identityPilot?.friendProposal || {};
    const incomingConfig = cfg.identityPilot?.incomingFriendRequest || {};
    const dispatchEnabled = friendRequestDispatchEnabled(cfg);
    const protocolState = !dispatchEnabled
      ? 'disabled'
      : this.onebot?.connected
        ? 'supported'
        : 'disconnected';
    const friendProposal = {
      enabled: friendProposalEnabled(cfg),
      mode: proposalConfig.mode === 'triggered' ? 'triggered' : 'prompt',
      triggeredEnabled: triggeredFriendProposalEnabled(cfg),
      friendSnapshotAt: this.friendSnapshotAt,
      friendStatusTrusted: this.friendSnapshotAt > 0
        && Date.now() - this.friendSnapshotAt <= Math.max(
          1,
          Number(proposalConfig.triggered?.friendStatusMaxAgeMinutes) || 15
        ) * 60000,
      activeDispatchEnabled: dispatchEnabled,
      ownerConfigured: /^\d{5,15}$/.test(String(proposalConfig.ownerUin || '').trim()),
      protocolDispatchSupported: true,
      protocolState,
      protocolNote: protocolState === 'disabled'
        ? '主动发送实验开关已关闭'
        : protocolState === 'disconnected'
          ? 'OneBot 当前未连接'
          : 'SnowLuma 原始协议通道可用',
      counts: this.identityStore
        ? this.identityStore.friendProposalStats()
        : {
            total: 0,
            pending: 0,
            approvedManual: 0,
            dispatching: 0,
            sent: 0,
            heldUnknown: 0,
            failed: 0,
            accepted: 0,
            rejected: 0
          },
      opportunityCounts: this.identityStore
        ? this.identityStore.friendOpportunityStats()
        : {
            total: 0,
            lotteryMiss: 0,
            reviewBudget: 0,
            active: 0,
            skipped: 0,
            proposed: 0,
            reviewFailed: 0,
            cancelled: 0
          }
    };
    const incomingFriendRequest = {
      enabled: incomingFriendRequestEnabled(cfg),
      autoWhitelist: incomingConfig.autoWhitelist !== false,
      ownerConfigured: /^\d{5,15}$/.test(String(proposalConfig.ownerUin || '').trim()),
      counts: this.identityStore
        ? this.identityStore.incomingFriendRequestStats()
        : {
            total: 0,
            pending: 0,
            deciding: 0,
            approved: 0,
            heldUnknown: 0,
            failed: 0,
            accepted: 0,
            rejected: 0
          }
    };
    const base = {
      enabled: identityPilotEnabled(this.config()),
      active: this.active,
      databaseExists: fs.existsSync(identityDatabasePath(this.dataDir)),
      databaseFile: DB_DISPLAY_NAME,
      friendSyncError: this.friendSyncError,
      error: this.lastError,
      friendProposal,
      incomingFriendRequest
    };
    if (!this.identityStore) {
      return {
        ...base,
        people: 0,
        messages: 0,
        friends: 0,
        aliases: 0,
        sources: 0,
        legacyMemories: 0,
        lastIndexedAt: 0
      };
    }
    return { ...base, ...this.identityStore.status() };
  }

  async #notifyIncomingFriendRequest(request, signal) {
    const ownerUin = String(this.config().identityPilot?.friendProposal?.ownerUin || '').trim();
    let notified = false;
    let error = '';
    try {
      if (!/^\d{5,15}$/.test(ownerUin)) throw new Error('尚未配置好友审批管理员 QQ');
      if (!this.notifyIncomingFriendRequest) throw new Error('入站好友请求通知通道未配置');
      await this.notifyIncomingFriendRequest(request, ownerUin, signal);
      notified = true;
    } catch (notifyError) {
      error = String(notifyError?.message ?? notifyError);
      this.log(`[identity-pilot] 入站好友请求 ${request.id} 通知管理员失败：${error}`);
    }
    return this.identityStore.markIncomingFriendRequestNotification(
      request.id,
      { notified, error }
    );
  }

  async #syncKnownFriendWhitelists(friends) {
    if (
      !this.identityStore
      || !this.allowPrivateUser
      || this.config().identityPilot?.incomingFriendRequest?.autoWhitelist === false
    ) return;
    const friendIds = new Set((friends || [])
      .map((friend) => String(friend?.userId ?? friend?.user_id ?? ''))
      .filter(Boolean));
    if (!friendIds.size) return;
    const incoming = this.identityStore.listIncomingFriendRequests({ limit: 500 });
    const proposals = this.identityStore.listFriendProposals({ limit: 500 });
    const relatedIds = new Set([
      ...incoming.filter((item) => item.status === 'accepted').map((item) => item.userId),
      ...proposals.filter((item) => item.status === 'accepted').map((item) => item.userId)
    ]);
    for (const userId of relatedIds) {
      if (!friendIds.has(userId)) continue;
      // 删除人物资产时已明确“不再自动加回”：即使旧账本里还留着 accepted 行
      // （老版本数据），启动/重排也不能把白名单补回来。
      if (this.identityStore.isIdentityAssetDeleted(userId)) continue;
      try {
        // 启动/重排时的"已知好友"同步只补 allow：管理员可能刚把这个人写进 deny.private，
        // 不能因为一次重启就被自动白名单流程静默删掉。
        await this.allowPrivateUser(userId, { clearDeny: false });
        for (const request of incoming.filter((item) =>
          item.userId === userId && item.status === 'accepted')) {
          this.identityStore.markIncomingFriendWhitelist(request.id, { applied: true });
        }
      } catch (error) {
        for (const request of incoming.filter((item) =>
          item.userId === userId && item.status === 'accepted')) {
          this.identityStore.markIncomingFriendWhitelist(request.id, {
            applied: false,
            error: String(error?.message ?? error)
          });
        }
      }
    }
  }
}

export function inactiveIdentityPilotStatus({
  enabled = identityPilotEnabled(),
  dataDir = DATA_DIR,
  error = ''
} = {}) {
  const proposalConfig = getConfig().identityPilot?.friendProposal || {};
  const incomingConfig = getConfig().identityPilot?.incomingFriendRequest || {};
  return {
    enabled,
    active: false,
    databaseExists: fs.existsSync(identityDatabasePath(dataDir)),
    databaseFile: DB_DISPLAY_NAME,
    friendSyncError: '',
    error: String(error || ''),
    friendProposal: {
      enabled: enabled && proposalConfig.enabled === true,
      mode: proposalConfig.mode === 'triggered' ? 'triggered' : 'prompt',
      triggeredEnabled: enabled
        && proposalConfig.enabled === true
        && proposalConfig.mode === 'triggered',
      friendSnapshotAt: 0,
      friendStatusTrusted: false,
      activeDispatchEnabled: enabled
        && proposalConfig.enabled === true
        && proposalConfig.activeDispatchEnabled === true,
      ownerConfigured: /^\d{5,15}$/.test(String(proposalConfig.ownerUin || '').trim()),
      protocolDispatchSupported: true,
      protocolState: 'inactive',
      protocolNote: enabled
        ? '统一身份库未运行'
        : '统一身份库总开关已关闭',
      counts: {
        total: 0,
        pending: 0,
        approvedManual: 0,
        dispatching: 0,
        sent: 0,
        heldUnknown: 0,
        failed: 0,
        accepted: 0,
        rejected: 0
      },
      opportunityCounts: {
        total: 0,
        lotteryMiss: 0,
        reviewBudget: 0,
        active: 0,
        skipped: 0,
        proposed: 0,
        reviewFailed: 0,
        cancelled: 0
      }
    },
    incomingFriendRequest: {
      enabled: enabled && incomingConfig.enabled === true,
      autoWhitelist: incomingConfig.autoWhitelist !== false,
      ownerConfigured: /^\d{5,15}$/.test(String(proposalConfig.ownerUin || '').trim()),
      counts: {
        total: 0,
        pending: 0,
        deciding: 0,
        approved: 0,
        heldUnknown: 0,
        failed: 0,
        accepted: 0,
        rejected: 0
      }
    },
    people: 0,
    messages: 0,
    friends: 0,
    aliases: 0,
    sources: 0,
    legacyMemories: 0,
    lastIndexedAt: 0
  };
}
