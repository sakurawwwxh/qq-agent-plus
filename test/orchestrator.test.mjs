import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-orchestrator-'));
process.env.QQ_AGENT_DATA_DIR = root;
const {
  Orchestrator,
  estimateNextPromptTokens,
  followUpPlan,
  randomWakeDelay,
  triggerKindForTier
} = await import('../src/core/orchestrator.js');
const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

describe('Orchestrator', () => {
  it('draws the debounce delay inside the configured range', () => {
    const cfg = { wakeDelayMinMs: 8000, wakeDelayMaxMs: 12000, wakeDelayMs: 10000 };
    assert.equal(randomWakeDelay(cfg, () => 0), 8000);
    assert.equal(randomWakeDelay(cfg, () => 0.5), 10000);
    assert.equal(randomWakeDelay(cfg, () => 1), 12000);
    assert.equal(randomWakeDelay({ wakeDelayMinMs: 12000, wakeDelayMaxMs: 8000 }, () => 0), 8000);
  });

  it('classifies persisted Session trigger kinds without parsing display text', () => {
    assert.equal(triggerKindForTier({ tier: 1, reason: '被艾特' }), 'mention');
    assert.equal(triggerKindForTier({ tier: 2, reason: '关键词命中' }), 'keyword');
    assert.equal(triggerKindForTier({ tier: 3, reason: '随机命中(12%)' }), 'probability');
    assert.equal(triggerKindForTier({ tier: 6, reason: '生命周期：活跃状态' }), 'lifecycle');
    assert.equal(triggerKindForTier({ tier: 7, reason: '生命周期：硬上限后的任意消息续接' }), 'rollover');
    assert.equal(triggerKindForTier({}, { manual: true, proactive: true }), 'manual');
  });

  it('omits inline image bytes from next-round Token estimation', () => {
    const image = `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`;
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'look at this image' },
      {
        role: 'tool',
        tool_call_id: 'image',
        content: [
          { type: 'text', text: 'image result' },
          { type: 'image_url', image_url: { url: image } }
        ]
      }
    ];
    const result = estimateNextPromptTokens({
      messages,
      tools: [{ type: 'function', function: { name: 'finish', parameters: {} } }],
      previousPromptTokens: 12360,
      previousEstimateChars: 23400,
      previousImageCount: 0
    });
    assert.ok(JSON.stringify({ messages }).length > 12 * 1024 * 1024);
    assert.ok(result.estimateChars < 2000);
    assert.equal(result.imageCount, 1);
    assert.ok(result.estimatedPromptTokens < 10000);
  });

  function fixture(t) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.runtime.mode = 'active';
    cfg.allow.groups = ['1'];
    cfg.api.model = 'mock';
    cfg.api.baseUrl = 'https://model.invalid';
    cfg.sticker.enabled = false;
    cfg.memory.consolidateEnabled = false;
    cfg.wakeDelayMs = 30;
    cfg.wakeDelayMinMs = 30;
    cfg.wakeDelayMaxMs = 30;
    cfg.maxBatchWaitMs = 120;
    cfg.drainDelayMs = 200;
    setRuntimeConfig(cfg);
    const dir = fs.mkdtempSync(path.join(root, 'store-'));
    const store = new ChatStore(0, { dataDir: dir });
    const sessions = new SessionRegistry();
    const handoffs = [];
    let currentHandoff = null;
    const memory = {
      formatForPrompt: () => '',
      formatHandoffForPrompt: () => currentHandoff
        ? `【上次会话交接】\n- 当前话题：${currentHandoff.topic || ''}\n- 已知上下文：${currentHandoff.summary || ''}`
        : '',
      getHandoff: () => currentHandoff,
      setHandoff: (chatKey, state, meta) => {
        if (state.clearHandoff === true) {
          currentHandoff = null;
          handoffs.push({ chatKey, state: structuredClone(state), meta: structuredClone(meta) });
          return null;
        }
        const value = { ...state, ...meta, updatedAt: Date.now() };
        currentHandoff = { ...(currentHandoff || {}), ...value };
        handoffs.push({ chatKey, state: structuredClone(state), meta: structuredClone(meta) });
        return currentHandoff;
      },
      clearHandoff: () => { currentHandoff = null; }
    };
    const sender = {
      sendTextBatch: async (_chatKey, messages) => ({
        sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })),
        failed: []
      })
    };
    const runner = new Orchestrator({
      store, sessions, memory,
      stickers: {}, sender, onebot: {
        selfId: '888',
        selfNickname: 'bot',
        getGroupInfo: async () => ({ group_name: 'test' })
      }
    });
    const original = globalThis.fetch;
    t.after(async () => { await runner.abortAll(); store.close(); globalThis.fetch = original; });
    const append = (mid, text = 'hi', senderId = '42', reply = null) => store.appendIncoming('group:1', {
      mid, text, senderId, senderName: `member-${senderId}`, reply
    });
    return { cfg, runner, store, sessions, memory, handoffs, append };
  }

  it('only acknowledges the claimed batch after successful model processing', async (t) => {
    const { runner, store, append } = fixture(t);
    append(1);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      assert.equal(store.findByMid('group:1', 1).read, false);
      append(2);
      return Response.json({ choices: [{ message: { content: 'No reply needed' } }], usage: { total_tokens: 10 } });
    };
    await runner.wake('group:1');
    assert.equal(calls, 1);
    assert.equal(store.findByMid('group:1', 1).read, true);
    assert.equal(store.findByMid('group:1', 2).read, false);
  });

  it('preserves failed input and recorded token usage without clearing a run', async (t) => {
    const { runner, store, sessions, append } = fixture(t);
    append(1);
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 1) return Response.json({
        choices: [{ message: { tool_calls: [{ id: '1', function: { name: 'get_active_members', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 50, total_tokens: 50 }
      });
      return new Response('bad request', { status: 400 });
    };
    await runner.wake('group:1');
    assert.equal(store.getChatMeta('group:1').failed, 1);
    const session = sessions.get(sessions.listSummaries(1)[0].id);
    assert.equal(session.status, 'error');
    assert.equal(session.usage.totalTokens, 50);
  });

  it('does not escalate model-correctable malformed tool arguments to incidents', async (t) => {
    const { runner, append } = fixture(t);
    const incidents = [];
    runner.getIncidentPilot = () => ({
      capture: (...args) => incidents.push(args)
    });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'bad-json',
                type: 'function',
                function: {
                  name: 'send_message',
                  arguments: '{"messages": hello}'
                }
              }]
            }
          }],
          usage: { prompt_tokens: 50, total_tokens: 60 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 70, total_tokens: 80 }
      });
    };

    append(1, '测试格式纠正');
    await runner.wake('group:1');

    assert.equal(calls, 2);
    assert.equal(incidents.length, 0);
    const session = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    const toolCall = session.messages.find((message) =>
      message.toolCall?.name === 'send_message');
    assert.equal(toolCall.toolCall.isError, true);
    assert.equal(toolCall.toolCall.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  it('does not start a model call in observe mode or in an unapproved chat', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.runtime.mode = 'observe';
    append(1);
    globalThis.fetch = async () => assert.fail('unexpected model request');
    await runner.wake('group:1');
    cfg.runtime.mode = 'active';
    await runner.wake('group:2');
    assert.equal(runner.activeRuns.size, 0);
  });

  it('caps a continuously extended debounce window at the first-message deadline', async (t) => {
    const { runner, append } = fixture(t);
    append(1);
    const started = Date.now();
    const elapsed = await new Promise((resolve) => {
      runner.wake = async () => resolve(Date.now() - started);
      runner.scheduleWake('group:1');
      const timer = setInterval(() => runner.scheduleWake('group:1'), 10);
      t.after(() => clearInterval(timer));
    });
    assert.ok(elapsed >= 100 && elapsed < 300, `elapsed=${elapsed}`);
  });

  it('manual wake bypasses trigger rules and can run from read archive context', async (t) => {
    const { cfg, runner, store, sessions, append } = fixture(t);
    cfg.store.contextTier = 1;
    const prompts = [];
    globalThis.fetch = async (_url, options) => {
      prompts.push(JSON.parse(options.body).messages.at(-1)?.content || '');
      return Response.json({
        choices: [{ message: { content: '无需发言' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110
        }
      });
    };

    append(1, '没有艾特机器人的普通消息');
    const unreadWake = runner.requestManualWake('group:1');
    assert.deepEqual(unreadWake, { ok: true, mode: 'unread' });
    await Promise.allSettled([...runner.runTasks]);
    assert.equal(prompts.length, 1);
    assert.equal(store.findByMid('group:1', 1).state, 'acked');
    assert.match(prompts[0], /管理员从控制台主动要求你立即处理以下未读消息/);
    assert.match(prompts[0], /没有艾特机器人的普通消息/);

    const contextWake = runner.requestManualWake('group:1');
    assert.deepEqual(contextWake, { ok: true, mode: 'context' });
    await Promise.allSettled([...runner.runTasks]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /当前没有未读消息/);
    assert.match(prompts[1], /没有艾特机器人的普通消息/);
    assert.equal(sessions.listSummaries(1)[0].trigger, '控制台主动唤醒');
  });

  it('attaches a waiting lifecycle batch to its existing thread immediately', async (t) => {
    const { cfg, runner, store, sessions, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    cfg.wakeDelayMinMs = 5000;
    cfg.wakeDelayMaxMs = 5000;
    const thread = store.updateLifecycleThread('group:1', {
      disposition: 'active',
      participantIds: ['42'],
      activeIdleMs: 1200000,
      hardLifetimeMs: 1800000,
      rolloverArmedMs: 600000,
      now: Date.now()
    });
    append(1, '继续刚才的话题', '42');

    runner.scheduleWake('group:1');

    const waiting = sessions.listSummaries().find((session) => session.status === 'waiting');
    assert.ok(waiting);
    assert.equal(waiting.conversationMode, 'lifecycle');
    assert.equal(waiting.threadId, thread.threadId);
    assert.equal(waiting.threadState, 'active');
    assert.equal(waiting.lifecycleContinuation, true);
  });

  it('cancels a running request and releases the batch for a later attempt', async (t) => {
    const { runner, store, append } = fixture(t);
    append(1);
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    globalThis.fetch = async (_url, { signal }) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const task = runner.wake('group:1');
    await ready;
    await runner.abortAll();
    await task;
    assert.equal(store.findByMid('group:1', 1).state, 'pending');
    assert.equal(runner.runningChats.size, 0);
  });

  it('commits an explicit finish handoff after a successful batch', async (t) => {
    const { runner, store, handoffs, append } = fixture(t);
    append(1);
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          tool_calls: [{
            id: 'finish-1',
            type: 'function',
            function: {
              name: 'finish',
              arguments: JSON.stringify({
                summary: '已经确认第一项',
                topic: '继续排查',
                hypotheses: ['第二项可能异常'],
                evidence: ['第一项检查结果正常'],
                facts: ['第一项正常'],
                rejectedDirections: ['不是第一项导致'],
                openQuestions: ['第二项是否正常'],
                nextStep: '等待下一条结果'
              })
            }
          }]
        }
      }],
      usage: { total_tokens: 10 }
    });

    await runner.wake('group:1');

    assert.equal(store.findByMid('group:1', 1).read, true);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].state.topic, '继续排查');
    assert.deepEqual(handoffs[0].state.hypotheses, ['第二项可能异常']);
    assert.deepEqual(handoffs[0].state.rejectedDirections, ['不是第一项导致']);
    assert.deepEqual(handoffs[0].state.openQuestions, ['第二项是否正常']);
    assert.deepEqual(handoffs[0].meta.participantIds, ['42']);
    assert.ok(handoffs[0].meta.sourceSessionId);
  });

  it('creates a conservative handoff when a successful reply ends without finish', async (t) => {
    const { runner, handoffs, append } = fixture(t);
    append(1);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'send-1',
                type: 'function',
                function: {
                  name: 'send_message',
                  arguments: JSON.stringify({ messages: ['请继续发结果'] })
                }
              }]
            }
          }],
          usage: { total_tokens: 10 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    await runner.wake('group:1');

    assert.equal(handoffs.length, 1);
    assert.match(handoffs[0].state.summary, /本轮收到/);
    assert.match(handoffs[0].state.summary, /请继续发结果/);
  });

  it('injects the previous run handoff into the next stateless session', async (t) => {
    const { runner, append } = fixture(t);
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'finish-1',
                type: 'function',
                function: {
                  name: 'finish',
                  arguments: JSON.stringify({
                    summary: '第一轮确认了连接正常',
                    topic: '继续检查附件',
                    openQuestions: ['附件是否成功落盘'],
                    nextStep: '等待第二轮结果'
                  })
                }
              }]
            }
          }],
          usage: { total_tokens: 10 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1);
    await runner.wake('group:1');
    append(2);
    await runner.wake('group:1');

    assert.equal(requests.length, 2);
    const secondPrompt = String(requests[1].messages?.[1]?.content || '');
    assert.match(secondPrompt, /【上次会话交接】/);
    assert.match(secondPrompt, /继续检查附件/);
    assert.match(secondPrompt, /第一轮确认了连接正常/);
  });

  it('passes provider reasoning content into the next tool round', async (t) => {
    const { runner, append } = fixture(t);
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              reasoning_content: '先读取成员再决定',
              tool_calls: [{
                id: 'members-1',
                type: 'function',
                function: { name: 'get_active_members', arguments: '{}' }
              }]
            }
          }],
          usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, total_tokens: 110 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, total_tokens: 130 }
      });
    };

    append(1);
    await runner.wake('group:1');

    assert.equal(requests.length, 2);
    const assistant = requests[1].messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.reasoning_content, '先读取成员再决定');
    const session = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(session.callUsage.length, 2);
    assert.equal(session.callUsage[0].cacheHitRate, 0.4);
    assert.equal(session.inputRound, 2);
    assert.ok(session.inputTools.length > 0);
    const auditedAssistant = session.inputMessages.find((m) => m.role === 'assistant');
    assert.equal(auditedAssistant.reasoning_content, '先读取成员再决定');
    assert.equal(auditedAssistant.tool_calls[0].function.name, 'get_active_members');
    assert.ok(session.inputPayloadChars > 0);
  });

  it('exposes and executes the unified person lookup only while the pilot is active', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.identityPilot.enabled = true;
    const lookups = [];
    runner.getIdentityPilot = () => ({
      active: true,
      lookupPerson: (userId, options) => {
        lookups.push({ userId, ...options });
        return {
          userId,
          primaryName: '成员42',
          aliases: ['成员42', '旧昵称'],
          isFriend: true,
          messageCount: 80,
          chatCount: 2,
          currentChatMessageCount: 50,
          currentContextMemories: [{ content: '喜欢讨论架构', observedAt: 1 }],
          otherContextMemoryCount: 1,
          safeProfile: {}
        };
      }
    });
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        assert.ok(body.tools.some((tool) =>
          tool.function.name === 'person_memory_lookup'));
        assert.match(body.messages[0].content, /person_memory_lookup/);
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'person-1',
                type: 'function',
                function: {
                  name: 'person_memory_lookup',
                  arguments: JSON.stringify({ userId: '42' })
                }
              }]
            }
          }],
          usage: { prompt_tokens: 100, total_tokens: 110 }
        });
      }
      const toolResult = body.messages.find((message) =>
        message.role === 'tool' && message.name === 'person_memory_lookup');
      assert.match(String(toolResult?.content || ''), /喜欢讨论架构/);
      assert.match(String(toolResult?.content || ''), /"chatCount": 2/);
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 120, total_tokens: 130 }
      });
    };

    append(1, '你还记得我吗', '42');
    await runner.wake('group:1');

    assert.equal(requests.length, 2);
    assert.deepEqual(lookups, [{ userId: '42', chatKey: 'group:1' }]);
    const session = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.ok(session.messages.some((message) =>
      message.toolCall?.name === 'person_memory_lookup'));
  });

  it('friend proposal retirement keeps tool and prompt section out of every mode', async (t) => {
    const { cfg, runner, append } = fixture(t);
    // 存量配置里最"想复活"的形态：enabled:true + mode:'prompt'。整体退役后两个开关都不再生效，
    // 提案工具与提示词里的好友候选段都不允许出现（docs/KNOWN-ISSUES.md 2026-09-25）。
    cfg.identityPilot = {
      enabled: true,
      friendProposal: {
        enabled: true,
        mode: 'prompt',
        ownerUin: '900001',
        minMessageCount: 1,
        cooldownDays: 30,
        maxPending: 10
      }
    };
    const proposals = [];
    runner.getIdentityPilot = () => ({
      active: true,
      proposeFriend: async (input) => {
        proposals.push(input);
        return {
          created: true,
          adminNotified: true,
          proposal: { id: 'fp_123456789abc', status: 'pending' }
        };
      }
    });
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      assert.ok(!body.tools.some((tool) =>
        tool.function.name === 'friend_request_propose'),
        '退役后 friend_request_propose 不应再注入');
      assert.doesNotMatch(body.messages[0].content, /好友候选/);
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 100, total_tokens: 110 }
      });
    };

    append(1, '以后还能继续聊吗', '42');
    await runner.wake('group:1');

    assert.equal(requests.length, 1);
    assert.equal(proposals.length, 0, '退役后模型没有任何路径能创建提案');
  });

  it('removes friend proposal prompt and tool from ordinary triggered-mode chat', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.identityPilot = {
      enabled: true,
      friendProposal: {
        enabled: true,
        mode: 'triggered',
        ownerUin: '900001'
      }
    };
    runner.getIdentityPilot = () => ({ active: true });
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.ok(!body.tools.some((tool) =>
        tool.function.name === 'friend_request_propose'));
      assert.doesNotMatch(body.messages[0].content, /好友候选|自行判断是否主动交朋友/);
      return Response.json({
        choices: [{ message: { content: '无需回复' } }],
        usage: { prompt_tokens: 100, total_tokens: 105 }
      });
    };

    append(1, '普通聊天不应携带交友任务', '42');
    await runner.wake('group:1');
    assert.equal(calls, 1);
  });

  it('removes schedule_wake and the follow-up reminder when their switches are off', async (t) => {
    // 用户反馈：关掉「冷场主动开话题」照样会主动发消息 —— 因为补话与自安排唤醒
    // 从来没读过任何开关。现在它们各有独立开关，关掉后工具与提示词引导一起撤掉。
    const { cfg, runner, append } = fixture(t);
    cfg.proactive.enabled = false;
    cfg.proactive.followUpEnabled = false;
    cfg.proactive.selfWakeEnabled = false;
    setRuntimeConfig(cfg);
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };
    append(1, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0].tools.some((tool) => tool.function.name === 'schedule_wake'),
      '开关关闭时不应再注入 schedule_wake');
    assert.doesNotMatch(bodies[0].messages[0].content, /schedule_wake/, '提示词里也不该再教它');
    assert.doesNotMatch(bodies[0].messages[0].content, /刚发的话没人接/, '补话提醒随开关一起撤掉');
  });

  it('keeps schedule_wake available by default (升级前后行为一致)', async (t) => {
    const { cfg, runner, append } = fixture(t);
    setRuntimeConfig(cfg);
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };
    append(1, '在吗', '42');
    await runner.wake('group:1');
    assert.ok(bodies[0].tools.some((tool) => tool.function.name === 'schedule_wake'));
  });

  it('feeds both familiar and unused stickers into the system prompt', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.sticker.enabled = true;
    cfg.sticker.promptMaxStickers = 10;
    setRuntimeConfig(cfg);
    const entries = [];
    for (let i = 1; i <= 30; i++) {
      entries.push({
        id: `st-${i}`,
        desc: i <= 3 ? `常用备注${i}` : '',
        url: `https://example.com/${i}.png`,
        useCount: i <= 3 ? 4 : 0,
        lastUsedAt: i <= 3 ? 1_700_000_000_000 + i : 0,
        createdAt: new Date(1_700_000_000_000 + i).toISOString()
      });
    }
    runner.stickers = { sync: async () => ({ entries }), list: async () => ({ total: entries.length, stickers: [] }) };
    let system = '';
    globalThis.fetch = async (_url, options) => {
      system = JSON.parse(options.body).messages[0].content;
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };
    append(1, '哈哈', '42');
    await runner.wake('group:1');
    assert.match(system, /stickerId：st-1/, '常用的要在清单里');
    assert.match(system, /（没用过）（stickerId：st-\d+）/, '没用过的也要有机会进清单');
    assert.equal([...system.matchAll(/stickerId：/g)].length, 10, '条数按配置取满');
  });

  it('图片输入关掉时，表情清单不能再教模型"先看一眼"（提示词不能自相矛盾）', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.sticker.enabled = true;
    cfg.sticker.promptMaxStickers = 10;
    cfg.api.vision = false;                       // 关掉图片输入：get_sticker_image 会被摘掉工具
    setRuntimeConfig(cfg);
    const entries = [];
    for (let i = 1; i <= 12; i++) {
      entries.push({
        id: `st-${i}`,
        // 一半有备注、一半没有：关掉图片输入时，没备注的既看不懂也没法看图，不该留在清单里
        desc: i % 2 ? `备注${i}` : '',
        url: `https://example.com/${i}.png`,
        useCount: 0, lastUsedAt: 0, createdAt: new Date(1_700_000_000_000 + i).toISOString()
      });
    }
    runner.stickers = { sync: async () => ({ entries }), list: async () => ({ total: entries.length, stickers: [] }) };
    let system = '';
    let tools = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      system = body.messages[0].content;
      tools = body.tools || [];
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    append(1, '哈哈', '42');
    await runner.wake('group:1');
    assert.equal(tools.some((tool) => tool.function?.name === 'get_sticker_image'), false, '工具已摘掉');
    // 只看【可用表情包】那一段（角色卡正文是管理员内容，可能仍提到这个工具，不归这里管）：
    // 清单不能再说"可以先 get_sticker_image 看一眼"——那句话指向一个不存在的工具
    const listBlock = system.slice(system.indexOf('【可用表情包】'));
    assert.ok(listBlock.includes('stickerId：'), '清单段要在');
    assert.equal(listBlock.includes('get_sticker_image'), false, '清单里不该再出现这个工具名');
    assert.equal(listBlock.includes('st-2（'), false, '没备注的（看不明白也用不了看图工具）不该列出来');
    assert.ok(listBlock.includes('st-1'), '有备注的照常列');
    assert.match(system, /看不到图/, '看不到图时的口径要在');
    cfg.api.vision = true;
  });

  it('get_message_audio 只在 ASR 开关打开且配了 key 时注入（与搜索开关解耦）', async (t) => {
    const { cfg, runner, append } = fixture(t);
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    const hasAudioTool = (body) => body.tools.some((tool) => tool.function.name === 'get_message_audio');
    // 1) 没配 key：不注入（调用必失败，也防意外计费）
    append(1, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasAudioTool(bodies.at(-1)), false, '没 key 不该注入 ASR 工具');
    // 2) 有 key 且开关默认打开：注入，提示词同步换成"可以转文字"的口径
    cfg.asr.provider = 'volc';   // 默认是本机转写；这条用例测的是"用 Key 的那家"
    cfg.asr.apiKey = 'test-asr-key';
    setRuntimeConfig(cfg);
    append(2, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasAudioTool(bodies.at(-1)), true, '配了 key 应注入');
    assert.match(bodies.at(-1).messages[0].content, /get_message_audio/);
    // 3) 关掉联网搜索但 ASR 开关仍开着：语音转写不该跟着消失（审查意见）
    cfg.webSearch.enabled = false;
    setRuntimeConfig(cfg);
    append(3, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasAudioTool(bodies.at(-1)), true, '关搜索不该顺带关掉语音转写');
    // 4) ASR 自己的开关关掉：工具与提示词引导一起消失
    cfg.asr.enabled = false;
    setRuntimeConfig(cfg);
    append(4, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasAudioTool(bodies.at(-1)), false);
    assert.doesNotMatch(bodies.at(-1).messages[0].content, /get_message_audio/);
    assert.match(bodies.at(-1).messages[0].content, /无法处理语音\/视频\/音频文件/);
  });

  it('keeps slang injection retired even with legacy config and slang assets', async (t) => {
    // 黑话研究已下线（stable-feature-policy: slangPilot=false）：即使旧配置里
    // enabled=true、磁盘上还有 slang.json，提示词也不应再注入任何黑话段落，
    // 避免把某个群的梗泄露到另一个群。
    const { cfg, runner, append } = fixture(t);
    cfg.slangPilot = {
      ...structuredClone(DEFAULT_CONFIG.slangPilot),
      enabled: true,
      ownerUin: '900001'
    };
    setRuntimeConfig(cfg);
    const slangFile = path.join(root, 'slang.json');
    t.after(() => fs.rmSync(slangFile, { force: true }));
    fs.writeFileSync(slangFile, JSON.stringify([
      {
        id: 'global',
        content: '全局梗',
        meaning: '所有会话可见',
        status: 'confirmed',
        scope: 'global-safe',
        count: 2
      },
      {
        id: 'local',
        content: '本群梗',
        meaning: '只在当前群可见',
        status: 'confirmed',
        scope: 'chat-private',
        scopeChatKey: 'group:1',
        count: 3
      },
      {
        id: 'other',
        content: '隔壁群梗',
        meaning: '不应泄露',
        status: 'confirmed',
        scope: 'chat-private',
        scopeChatKey: 'group:2',
        count: 10
      },
      {
        id: 'candidate',
        content: '待确认梗',
        meaning: '不能注入',
        status: 'candidate',
        count: 20
      }
    ]));
    let request;
    globalThis.fetch = async (_url, options) => {
      request = JSON.parse(options.body);
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 100, total_tokens: 110 }
      });
    };

    append(1, '这是什么说法', '42');
    await runner.wake('group:1');

    const prompt = String(request.messages.find((message) =>
      message.role === 'user')?.content || '');
    assert.doesNotMatch(prompt, /【已确认黑话】/);
    assert.doesNotMatch(prompt, /全局梗/);
    assert.doesNotMatch(prompt, /本群梗/);
    assert.doesNotMatch(prompt, /隔壁群梗/);
    assert.doesNotMatch(prompt, /待确认梗/);
  });

  it('deterministically wakes the same participant inside the threaded continuation window', async (t) => {
    const { cfg, runner, store, sessions, append } = fixture(t);
    cfg.conversation.mode = 'threaded';
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'send-1',
                type: 'function',
                function: {
                  name: 'send_message',
                  arguments: JSON.stringify({ messages: ['继续说'], replyToMessageId: 1 })
                }
              }]
            }
          }],
          usage: { total_tokens: 10 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '@bot 先聊这个', '42');
    append(2, '我在旁边说一句', '43');
    await runner.wake('group:1');
    const thread = store.getConversationThread('group:1');
    assert.ok(thread);
    assert.deepEqual(thread.participantIds, ['42']);
    assert.ok(store.latestThreadCheckpoint('group:1'));

    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    append(3, '旁观者继续说', '43');
    await runner.wake('group:1');
    assert.equal(calls, 2, '未被回复的旁观者不应获得续接资格');
    append(4, '那接下来呢', '42');
    await runner.wake('group:1');

    assert.equal(calls, 3, '普通跟话应绕过低概率门控并进入第二次模型调用');
    const latest = runner.sessions.listSummaries(1)[0];
    const latestDetail = runner.sessions.get(latest.id);
    assert.equal(latestDetail.contextTier, 5);
    assert.match(latestDetail.contextReason, /续接/);
  });

  it('deterministically wakes a reply to the bot without an existing thread', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.conversation.mode = 'threaded';
    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '你刚才那句什么意思', '43', {
      senderId: '888',
      sender: 'bot',
      text: '上一条机器人消息'
    });
    await runner.wake('group:1');

    assert.equal(calls, 1);
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextTier, 5);
    assert.equal(latest.contextReason, '续接：引用机器人');
  });

  it('supports per-group lifecycle mode and reuses the append-only DeepSeek transcript', async (t) => {
    const { cfg, runner, store, sessions, append } = fixture(t);
    cfg.conversation.mode = 'legacy';
    cfg.conversation.unifiedMode = false;
    cfg.conversation.groupModes = { 1: 'lifecycle' };
    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              reasoning_content: '先回应并保持当前生命周期',
              tool_calls: [{
                id: 'send-life-1',
                type: 'function',
                function: { name: 'send_message', arguments: JSON.stringify({ messages: ['继续说'] }) }
              }]
            }
          }],
          usage: { total_tokens: 10 }
        });
      }
      if (requests.length === 2) {
        return Response.json({
          choices: [{ message: { reasoning_content: '已经回复，等待后续', content: 'done' } }],
          usage: { total_tokens: 10 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '@bot 开始生命周期', '42');
    await runner.wake('group:1');
    const firstThread = store.getConversationThread('group:1');
    assert.equal(firstThread.mode, 'lifecycle');
    assert.equal(firstThread.state, 'active');
    assert.ok(firstThread.hardDeadline > firstThread.idleDeadline);
    assert.ok(store.getThreadTurns(firstThread.threadId).length >= 3);
    const firstSession = sessions.get(sessions.listSummaries(1)[0].id);
    assert.equal(firstSession.triggerKind, 'mention');
    assert.equal(firstSession.triggerReason, '被艾特');
    assert.equal(firstSession.threadId, firstThread.threadId);
    assert.equal(firstSession.threadState, 'active');
    assert.equal(firstSession.threadHardDeadline, firstThread.hardDeadline);

    append(2, '路过说一句', '99');
    await runner.wake('group:1');

    assert.equal(requests.length, 3, '生命周期内任意参与者消息都应进入模型');
    assert.ok(requests[2].messages.length > 2, '第二次运行应携带持久化 transcript');
    assert.deepEqual(
      requests[2].messages.slice(0, requests[1].messages.length),
      requests[1].messages,
      '生命周期下一次请求应完整复用上一请求前缀'
    );
    const priorReasoning = requests[2].messages.find(
      (message) => message.reasoning_content === '先回应并保持当前生命周期'
    );
    assert.ok(priorReasoning, 'DeepSeek reasoning_content 应跨生命周期调用续传');
    assert.ok(
      requests[2].messages.some((message) => message.reasoning_content === '已经回复，等待后续'),
      '终止轮 reasoning_content 也应随实际发言记录续传'
    );
    assert.match(
      String(requests[2].messages.at(-1)?.content || ''),
      /【生命周期续接】/
    );
    const secondThread = store.getConversationThread('group:1');
    assert.equal(secondThread.threadId, firstThread.threadId);
    assert.equal(secondThread.state, 'listening', '无回复后应进入短空闲监听状态');
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextTier, 6);
    assert.match(latest.contextReason, /生命周期/);
    assert.equal(latest.triggerKind, 'lifecycle');
    assert.match(latest.triggerReason, /生命周期/);
    assert.equal(latest.threadIdleDeadline, secondThread.idleDeadline);
    assert.equal(latest.threadHardDeadline, secondThread.hardDeadline);
    assert.deepEqual(
      latest.injectedMessages,
      requests[2].messages.slice(1, -1),
      'Session 应单独保存生命周期注入的 provider transcript'
    );
    assert.deepEqual(
      latest.inputMessages,
      requests[2].messages,
      'Session 应保存当前轮发送给模型的完整 messages'
    );
  });

  it('rolls a lifecycle generation before the next request when actual input reaches 32K', async (t) => {
    const { cfg, runner, store, sessions, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    cfg.conversation.lifecycleRolloverInputTokens = 32000;
    let calls = 0;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      calls += 1;
      requests.push(JSON.parse(options.body));
      return Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: `finish-${calls}`,
              type: 'function',
              function: {
                name: 'finish',
                arguments: JSON.stringify({
                  summary: `checkpoint-${calls}`,
                  threadDisposition: 'active'
                })
              }
            }]
          }
        }],
        usage: {
          prompt_tokens: calls === 1 ? 32000 : 15000,
          completion_tokens: 100,
          total_tokens: calls === 1 ? 32100 : 15100
        }
      });
    };

    append(1, '@bot start');
    await runner.wake('group:1');
    const firstThread = store.getConversationThread('group:1');
    assert.equal(firstThread.promptTokens, 32000);
    assert.ok(store.getThreadTurns(firstThread.threadId).length > 0);

    append(2, 'continue');
    await runner.wake('group:1');

    const secondThread = store.getConversationThread('group:1');
    assert.notEqual(secondThread.threadId, firstThread.threadId);
    assert.equal(secondThread.promptTokens, 15000);
    assert.equal(requests[1].messages.length, 2, '换代后的请求不应携带旧 provider transcript');
    assert.match(requests[1].messages[1].content, /上次生命周期检查点/);
    const latest = sessions.get(sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextRollover.reason, 'input-token-budget');
    assert.equal(latest.contextRollover.promptTokens, 32000);
    assert.equal(latest.lifecycleContinuation, false);
  });

  it('stops safely before a projected 160K run without holding confirmed sends', async (t) => {
    const { cfg, runner, store, sessions, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    cfg.api.maxRunTokens = 160000;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const tool = calls === 1
        ? { id: 'members', type: 'function', function: { name: 'get_active_members', arguments: '{}' } }
        : {
            id: `send-${calls}`,
            type: 'function',
            function: {
              name: 'send_message',
              arguments: JSON.stringify({ messages: [`reply-${calls}`] })
            }
          };
      const usage = [
        { prompt_tokens: 40879, completion_tokens: 304, total_tokens: 41183 },
        { prompt_tokens: 41598, completion_tokens: 104, total_tokens: 41702 },
        { prompt_tokens: 41757, completion_tokens: 69, total_tokens: 41826 }
      ][calls - 1];
      if (!usage) assert.fail('预算保护前应停止第四次模型调用');
      return Response.json({ choices: [{ message: { tool_calls: [tool] } }], usage });
    };

    append(1, '@bot reply');
    await runner.wake('group:1');

    assert.equal(calls, 3);
    assert.equal(store.findByMid('group:1', 1).state, 'acked');
    assert.equal(store.getChatMeta('group:1').held, 0);
    const latest = sessions.get(sessions.listSummaries(1)[0].id);
    assert.equal(latest.status, 'done');
    assert.equal(latest.sent.length, 2);
    assert.equal(latest.budgetStopped, true);
    assert.equal(latest.budgetStopReason, 'next-call-budget');
    assert.equal(latest.usage.totalTokens, 124711);
    assert.equal(latest.error, null);
  });

  it('consumes rollover-armed state with the next arbitrary message', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    const old = store.updateLifecycleThread('group:1', {
      disposition: 'active',
      participantIds: ['42'],
      promptHash: 'old-prefix'
    });
    store.armLifecycleRollover('group:1', 'hard-lifetime', 600000);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { content: 'not related, stay silent' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '完全普通的新消息', '99');
    await runner.wake('group:1');

    assert.equal(calls, 1);
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextTier, 7);
    const next = store.getConversationThread('group:1');
    assert.notEqual(next.threadId, old.threadId);
    assert.equal(next.state, 'listening');
  });

  it('honors an explicit active lifecycle disposition even without sending', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          tool_calls: [{
            id: 'finish-active',
            type: 'function',
            function: {
              name: 'finish',
              arguments: JSON.stringify({
                summary: '等待对方补充日志',
                topic: '继续排查',
                openQuestions: ['完整日志是什么'],
                nextStep: '等待日志',
                threadDisposition: 'active'
              })
            }
          }]
        }
      }],
      usage: { total_tokens: 10 }
    });

    append(1, '@bot 我稍后补日志', '42');
    await runner.wake('group:1');

    const thread = store.getConversationThread('group:1');
    assert.equal(thread.state, 'active');
    assert.ok(thread.idleDeadline - thread.updatedAt >= 19 * 60000);
    assert.equal(store.latestThreadCheckpoint('group:1').state.nextStep, '等待日志');
  });

  it('clears handoff memory without closing a listening lifecycle', async (t) => {
    const { cfg, runner, store, memory, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    memory.setHandoff('group:1', { topic: '旧话题', summary: '应当清除' });
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          tool_calls: [{
            id: 'finish-clear-memory',
            type: 'function',
            function: {
              name: 'finish',
              arguments: JSON.stringify({
                summary: '旧话题结束，但继续监听新消息',
                threadDisposition: 'listening',
                clearHandoff: true
              })
            }
          }]
        }
      }],
      usage: { total_tokens: 10 }
    });

    append(1, '@bot 换个话题', '42');
    await runner.wake('group:1');

    assert.equal(memory.getHandoff('group:1'), null);
    assert.equal(store.getConversationThread('group:1')?.state, 'listening');
  });

  it('keeps the lifecycle thread id on the Session that closes it', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: `finish-${calls}`,
              type: 'function',
              function: {
                name: 'finish',
                arguments: JSON.stringify({
                  summary: calls === 1 ? '继续' : '结束',
                  threadDisposition: calls === 1 ? 'active' : 'close'
                })
              }
            }]
          }
        }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '@bot 开始', '42');
    await runner.wake('group:1');
    const threadId = store.getConversationThread('group:1')?.threadId;

    append(2, '结束吧', '42');
    await runner.wake('group:1');
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);

    assert.ok(threadId);
    assert.equal(store.getConversationThread('group:1'), null);
    assert.equal(latest.threadId, threadId);
    assert.equal(latest.threadState, 'closed');
  });

  it('does not drop a previously claimed retry when the trigger state changes', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    append(1, '普通消息', '42');
    const firstLease = store.claimUnread('group:1');
    store.failLease(firstLease.id, 'temporary failure', { delayMs: 0 });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    await runner.wake('group:1');

    assert.equal(calls, 1);
    assert.equal(store.findByMid('group:1', 1).read, true);
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextReason, '失败批次重试');
  });

  it('does not recreate a lifecycle after its mode is changed during a run', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    globalThis.fetch = async () => {
      cfg.conversation.mode = 'legacy';
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '@bot start', '42');
    await runner.wake('group:1');

    assert.equal(store.findByMid('group:1', 1).read, true);
    assert.equal(store.getConversationThread('group:1'), null);
  });

  it('skips the "nobody replied" follow-up when its own switch is off', () => {
    const base = { sentCount: 1, unread: 0, lastFollowUpAt: 0, windowActive: true, random: () => 0 };
    // 默认（开关缺省）仍按老行为给一次机会
    assert.deepEqual(followUpPlan(base), { schedule: true, minutes: 10, reason: '发言后没人接话' });
    // 开关关掉：连"有没有说过话"都不再看，直接不安排（以前它只听 proactive.enabled，等于常开）
    assert.deepEqual(
      followUpPlan({ ...base, followUpEnabled: false }),
      { schedule: false, reason: '补话开关已关闭' }
    );
    // 开关打开：判据与老行为逐条一致
    assert.equal(followUpPlan({ ...base, followUpEnabled: true }).schedule, true);
    assert.equal(followUpPlan({ ...base, followUpEnabled: true, unread: 1 }).schedule, false);
  });
});

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
