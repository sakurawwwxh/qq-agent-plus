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
  proactiveProbability,
  randomWakeDelay,
  triggerKindForTier
} = await import('../src/core/orchestrator.js');
const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { ReminderStore } = await import('../src/core/reminders.js');
const { todayKey } = await import('../src/core/util.js');
const { currentTraceId, lastTraceId } = await import('../src/core/logger.js');

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

  function fixture(t, extra = {}) {
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
      },
      ...extra
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

  it('removes the sticker tools when the sticker switch is off (2026-10-02 用户反馈)', async (t) => {
    // 用户反馈：关掉「启用表情包」后机器人照样在发同一个表情 —— 那个开关只撤了提示词里的
    // 清单，四个贴纸工具还留着，模型没有新选项、只能反复用记得的那一个。修法与
    // schedule_wake / generate_image 同口径：开关关掉，工具与清单一起撤。
    const { cfg, runner, append } = fixture(t);
    cfg.sticker.enabled = false;   // fixture 默认就是关的，写明意图（防以后 fixture 改默认值）
    setRuntimeConfig(cfg);
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    append(1, '在吗', '42');
    await runner.wake('group:1');
    const names = bodies[0].tools.map((tool) => tool.function.name);
    for (const name of ['send_sticker', 'list_stickers', 'get_sticker_image', 'collect_sticker']) {
      assert.ok(!names.includes(name), `总开关关闭时不应再注入 ${name}`);
    }
    // 不断言提示词里没有"【可用表情包】"字样：角色卡是管理员内容，正文里就写着这几个字
    // （同 vision 那条用例的注释）。清单本身在 entries 为空时就不会注入，这里钉的是工具。
  });

  it('keeps the sticker tools by default (升级前后行为一致)', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.sticker.enabled = true;
    setRuntimeConfig(cfg);
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    append(1, '在吗', '42');
    await runner.wake('group:1');
    const names = bodies[0].tools.map((tool) => tool.function.name);
    for (const name of ['send_sticker', 'list_stickers', 'get_sticker_image', 'collect_sticker']) {
      assert.ok(names.includes(name), `默认配置（总开关开着）下 ${name} 应该在`);
    }
  });

  it('收藏总闸关闭时只摘 collect_sticker，发送/列表/看图仍在（2026-10-02）', async (t) => {
    // 总闸（collectEnabled）管的是"收"：关掉后模型不该再有主动收藏的工具，
    // 否则它会去调一个必然失败的收藏（还先白花一次看图判断）。
    const { cfg, runner, append } = fixture(t);
    cfg.sticker.enabled = true;
    cfg.sticker.collectEnabled = false;
    setRuntimeConfig(cfg);
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    append(1, '在吗', '42');
    await runner.wake('group:1');
    const names = bodies[0].tools.map((tool) => tool.function.name);
    assert.ok(!names.includes('collect_sticker'), '收藏总闸关闭时不应再注入 collect_sticker');
    for (const name of ['send_sticker', 'list_stickers', 'get_sticker_image']) {
      assert.ok(names.includes(name), `${name} 与收藏无关，应该保留`);
    }
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

  it('语音回复/提醒关掉时：工具表与提示词同步撤（send_voice 必失败、remind 不会被派发）', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.tts = { ...(cfg.tts || {}), enabled: false };       // 语音回复关（出厂默认就是关）
    cfg.reminders = { ...(cfg.reminders || {}), enabled: false };
    setRuntimeConfig(cfg);
    let system = '';
    let tools = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      system = body.messages[0].content;
      tools = body.tools || [];
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    append(1, '在吗', '42');
    await runner.wake('group:1');
    const names = tools.map((tool) => tool.function?.name);
    assert.equal(names.includes('send_voice'), false, '语音回复关掉 → send_voice 不该在工具表里（调了必然失败）');
    assert.equal(names.includes('remind'), false, '提醒关掉 → remind 不该在工具表里（不会被派发）');
    // 提示词侧不许再教这两个（只看平台自己写的工具引导段，角色卡正文是管理员内容）。
    // 注意标题名要跟 prompt.js 一致：'【群游戏规则】' 早就改名成 '【玩法与工具箱】'，
    // indexOf 返回 -1 时 slice(-1) 只取最后一个字符 —— 断言会**空转**（2026-10-07 审计发现）。
    const rules = system.slice(system.indexOf('【玩法与工具箱】'));
    assert.ok(rules.length > 0 && rules.startsWith('【玩法与工具箱】'), `提示词里应有玩法工具箱段，实际片段：${rules.slice(0, 40)}`);
    assert.equal(rules.includes('send_voice'), false, '提示词不该再教 send_voice');
    assert.equal(rules.includes('remind'), false, '提示词不该再教 remind（工具已被摘）');
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
    // 视频那条引导也要跟着 vision 走：关掉图片输入时 get_message_images 不在工具表里，
    // 不能教模型"用 get_message_images 看画面"（2026-09-26 审查：同类问题在贴纸清单上修过一次）
    // 断言只看平台自己那几段（角色卡正文是管理员内容，里面本来就写着"用 get_message_images 看图"）
    const sceneBlock = system.slice(system.indexOf('【QQ 场景规则】'));
    assert.ok(sceneBlock.length > 100, '要能定位到场景规则段');
    assert.equal(sceneBlock.includes('先看画面再听声音'), false, 'vision 关了不能再说"用 get_message_images 看画面"');
    // 这一轮 ASR 没配（fixture 默认），走的是"听不了语音"那条分支：
    // 不能出现"用 get_message_images 看画面"这类指向已被摘掉工具的引导
    assert.equal(sceneBlock.includes('用 get_message_images 看'), false, 'vision 关了不能教它看画面');

    // ASR 配好 + vision 关着：只能说"只能听声音"，不能说看画面
    cfg.asr.provider = 'volc';
    cfg.asr.apiKey = 'k';
    setRuntimeConfig(cfg);
    let asrNoVision = '';
    globalThis.fetch = async (_url, options) => {
      asrNoVision = JSON.parse(options.body).messages[0].content;
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    append(2, '哈哈', '42');
    await runner.wake('group:1');
    assert.match(asrNoVision, /画面看不到/, 'ASR 开着但看不了图 → 要说清只能听声音');
    assert.equal(asrNoVision.includes('先看画面再听声音'), false);

    // 模型自身不支持图片（api.vision 仍是 true）时，口径也必须跟着工具摘除走
    const novision = fixture(t);
    novision.cfg.api.vision = true;
    novision.cfg.api.model = 'deepseek-v4-pro';       // 内置资料表里明确 no-vision
    novision.cfg.sticker.enabled = true;
    novision.cfg.proactive = { ...novision.cfg.proactive, selfWakeEnabled: true };
    setRuntimeConfig(novision.cfg);
    let nvSystem = '';
    let nvTools = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      nvSystem = body.messages[0].content;
      nvTools = (body.tools || []).map((x) => x.function?.name);
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    novision.append(1, '发张图', '42');
    await novision.runner.wake('group:1');
    nvSystem = nvSystem || '';
    assert.equal(nvTools.includes('get_message_images'), false, 'no-vision 模型要摘掉看图工具');
    assert.equal(nvTools.includes('get_sticker_image'), false);
    const nvScene = nvSystem.slice(nvSystem.indexOf('【QQ 场景规则】'));
    assert.equal(nvScene.includes('用 get_message_images 看'), false, '工具摘了就不能再教它用（只读 api.vision 会漏掉这一半）');
    assert.equal(nvScene.includes('先看画面再听声音'), false);
    // 自安排唤醒的引导只跟 selfWakeEnabled 走：vision 关掉不该把它一起吞了
    assert.equal(nvSystem.includes('schedule_wake 给自己安排一次唤醒'), true, '工具在，用法引导也要在');
    // collect_sticker 的描述也不能点名已被摘掉的工具
    assert.equal(nvSystem.includes('先 get_message_images 看图确认'), false);

    // 反过来：vision 开着且 ASR 配好时，视频两侧都要明说（画面 + 声音）
    cfg.api.vision = true;
    setRuntimeConfig(cfg);
    let withVision = '';
    globalThis.fetch = async (_url, options) => {
      withVision = JSON.parse(options.body).messages[0].content;
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    append(3, '哈哈', '42');
    await runner.wake('group:1');
    assert.match(withVision, /别人发视频时两样都能拿到/);
    assert.match(withVision, /get_message_audio/);
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
    cfg.asr.provider = 'volc';   // 默认是 API Key 的托管服务（openai）；这条用例测的是火山
    cfg.asr.apiKey = 'test-asr-key';
    setRuntimeConfig(cfg);
    append(2, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasAudioTool(bodies.at(-1)), true, '配了 key 应注入');
    assert.match(bodies.at(-1).messages[0].content, /get_message_audio/);
    // 视频要两样都说清：画面（get_message_images 帧条）+ 声音（转写），否则模型会以为只能听
    assert.match(bodies.at(-1).messages[0].content, /别人发视频时两样都能拿到/);
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
    const offPrompt = bodies.at(-1).messages[0].content;
    assert.match(offPrompt, /听不了语音/);
    // 但视频的"画面"不归 ASR 管：关掉 ASR 也该能看帧条（2026-09-26 用户反馈"发视频只会说听声音"）
    assert.match(offPrompt, /get_message_images/);
    assert.match(offPrompt, /画面/);
  });

  it('generate_image 只在图片生成开关打开且配置齐时注入（按张计费，未配就别让模型去调）', async (t) => {
    const { cfg, runner, append } = fixture(t);
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    const hasImageTool = (body) => body.tools.some((tool) => tool.function.name === 'generate_image');
    // 1) 默认关：不注入，提示词里也不该有画图引导
    append(1, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasImageTool(bodies.at(-1)), false, '默认关不该注入画图工具');
    assert.doesNotMatch(bodies.at(-1).messages[0].content, /generate_image/);
    // 2) 开了但没填模型：仍不注入（调用必然失败，还会白花一次请求）
    cfg.imageGen = { ...(cfg.imageGen || {}), enabled: true, model: '' };
    setRuntimeConfig(cfg);
    append(2, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasImageTool(bodies.at(-1)), false, '没填模型不该注入');
    // 提示词的口径必须与工具过滤一致：只看 enabled 的话，这里会一边摘掉工具、
    // 一边还在教模型去调 generate_image（2026-09-30 审查：探针复现提示词含该工具）
    assert.doesNotMatch(bodies.at(-1).messages[0].content, /generate_image/, '没填模型时提示词也不该提画图');
    // 3) 开 + 有模型（地址留空 = 与模型同域）：注入，提示词同步给画图引导
    cfg.imageGen = { ...cfg.imageGen, enabled: true, model: 'gpt-image-1', baseUrl: '' };
    setRuntimeConfig(cfg);
    append(3, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasImageTool(bodies.at(-1)), true, '配齐了应注入');
    assert.match(bodies.at(-1).messages[0].content, /generate_image/);
    assert.match(bodies.at(-1).messages[0].content, /按张计费/);
    // 4) 再关掉：工具与引导一起消失
    cfg.imageGen = { ...cfg.imageGen, enabled: false };
    setRuntimeConfig(cfg);
    append(4, '在吗', '42');
    await runner.wake('group:1');
    assert.equal(hasImageTool(bodies.at(-1)), false);
    assert.doesNotMatch(bodies.at(-1).messages[0].content, /generate_image/);
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
    const { cfg, runner, store, append } = fixture(t);
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

it('提示词里不再写死默认人设的元素（示例改成中性的）', async (t) => {
  const { cfg, runner, append } = fixture(t);
  cfg.sticker.enabled = true;
  setRuntimeConfig(cfg);
  let system = '';
  globalThis.fetch = async (_url, options) => {
    system = JSON.parse(options.body).messages[0].content;
    return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
  };
  append(1, '哈哈', '42');
  await runner.wake('group:1');
  // 这四处原来写死的是默认卡（小鲸鱼）的梗/属性，换到别的卡就变成"别人的残留"
  // 只看平台段：角色卡正文里出现"大肥鱼"是这张卡自己的雷点，属于卡片内容，不算"平台写死"
  const platform = system.slice(0, system.indexOf('【角色设定')) + system.slice(system.indexOf('【QQ 场景规则】'));
  const leftover = ['别墨迹', '大肥鱼', '角色卡里的傲娇、毒舌', '如 DeepSeek V3'].filter((w) => platform.includes(w));
  assert.deepEqual(leftover, [], `平台提示词里不该再写死默认人设的元素：${leftover.join('、')}`);
  // 硬规则要在（口癖以当前卡为准）
  assert.match(system, /口癖、自称、梗一律以当前【角色设定】为准/);
});

it('换卡后 24 小时内，历史与交接口径会说明"旧口癖不作数"', async (t) => {
  const { cfg, runner, append } = fixture(t);
  setRuntimeConfig(cfg);
  let seq = 0;
  const run = async () => {
    let system = '';
    globalThis.fetch = async (_url, options) => {
      // 过去状态/交接在**用户**消息里，平台提示在系统消息里：两边都抓
      const messages = JSON.parse(options.body).messages || [];
      system = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join(String.fromCharCode(10));
      return Response.json({ choices: [{ message: { content: 'done' } }], usage: { total_tokens: 10 } });
    };
    seq += 1;
    append(seq, '在吗', '42');
    await runner.wake('group:1');
    return system;
  };
  await run();   // 先跑一轮，让"过去状态"里真的有历史（没有历史的会话不需要这段口径）
  // 没换过卡：不带这段口径
  setRuntimeConfig({ ...cfg, persona: { ...cfg.persona, changedAt: 0 } });
  const cold = await run();
  assert.equal(cold.includes('【角色设定】刚换过'), false);
  // 刚换过：历史/交接前面要带说明
  setRuntimeConfig({ ...cfg, persona: { ...cfg.persona, changedAt: Date.now() - 60 * 1000 } });
  const fresh = await run();
  assert.match(fresh, /【角色设定】刚换过/);
  assert.match(fresh, /口癖、自称、称呼都不一定还适用/);
  // 超过 24 小时：自动失效（只在换卡那阵子提醒，不长期占 token）
  setRuntimeConfig({ ...cfg, persona: { ...cfg.persona, changedAt: Date.now() - 25 * 3600 * 1000 } });
  const old = await run();
  assert.equal(old.includes('【角色设定】刚换过'), false);
});

  // ── 定时提醒的派发闸门（2026-09-29 审查 P1：标成"已触发"却从没派发过）──

  it('定时提醒：会话还留着未回收租约时本轮不派发，也不标记已触发', async (t) => {
    // 每个用例一份独立的提醒文件：默认文件是 DATA_DIR/reminders.json，同文件共用会让
    // 用例之间通过磁盘互相影响（一条用例把提醒标成 fired，另一条的断言就跟着变）
    const { runner, store, append } = fixture(t, { reminders: new ReminderStore(path.join(root, 'reminders-lease.json')) });
    append(1);
    // 模拟硬崩溃留下的 leased 残行：claimUnread 会因此返回 null，而 #wake 在那条路径上是静默 return
    assert.ok(store.claimUnread('group:1'), '先占一个租约');
    assert.equal(store.hasLeasedRun('group:1'), true);
    runner.reminders.items.push({
      id: 'r-lease', chatKey: 'group:1', at: Date.now() - 1000, text: '喝水', status: 'pending', createdBy: '42'
    });
    let woke = 0;
    runner.wake = async () => { woke++; };

    runner.fireDueReminders();

    assert.equal(woke, 0, '接不了就不该唤醒');
    assert.equal(runner.reminders.items[0].status, 'pending', '租约还在时不能标记已触发（否则提醒永久丢失）');
  });

  it('定时提醒：预算闸门会丢的唤醒顺延 24 小时而不是标成已触发；没超预算就正常派发', async (t) => {
    const { runner, cfg, append } = fixture(t, { reminders: new ReminderStore(path.join(root, 'reminders-budget.json')) });
    append(1);
    const item = { id: 'r-budget', chatKey: 'group:1', at: Date.now() - 1000, text: '喝水', status: 'pending', createdBy: '42' };
    runner.reminders.items.push(item);
    let woke = 0;
    runner.wake = async () => { woke++; };
    // 今天已花超 + 策略「停止」：#wake 的预算闸门会直接丢弃这次唤醒，派发侧必须先接住
    setRuntimeConfig({ ...cfg, api: { ...cfg.api, budget: { enabled: true, dailyYuan: 0.01, onExceed: 'block' } } });
    runner.sessions.todayUsage = () => ({ estimatedYuan: 5 });
    const origAt = item.at;
    runner.fireDueReminders();
    assert.equal(woke, 0, '预算会丢掉这次唤醒：不能派发');
    const after = runner.reminders.items.find((x) => x.id === 'r-budget');
    assert.equal(after.status, 'pending', '没派发就不能标记已触发（否则提醒内容永久丢失）');
    assert.ok(after.at >= origAt + 23 * 3600 * 1000,
      `到点时间要顺延 24 小时，实际 ${new Date(after.at).toISOString()}`);
    // 顺延的意义：12 小时作废窗口从**新**到点时间起算 —— 持续超预算一整天也不会被静默作废
    assert.equal(runner.reminders.expired(origAt + 13 * 3600 * 1000).length, 0,
      '按新到点时间起算，13 小时后不该被判超时作废（不顺延的话这条早就没了）');
    // 反向：没超预算时必须正常派发（否则「顺延」变成永远不提醒）
    after.at = Date.now() - 1000;
    runner.sessions.todayUsage = () => ({ estimatedYuan: 0 });
    runner.fireDueReminders();
    assert.equal(woke, 1, '没超预算要正常派发');
    assert.equal(runner.reminders.items.find((x) => x.id === 'r-budget').status, 'fired');
  });

  it('定时提醒：@ 落在第 51–100 条未读里时 degrade 不会丢这次唤醒，提醒也不该被顺延', async (t) => {
    // 派发预检与 #wake 的 degrade 闸门必须看同一批未读（都是 100 条）。看少 50 条时，
    // @ 落在第 51–100 条会被预检判成"会丢"→ 提醒无谓顺延 24 小时，而 #wake 其实照常派发
    //（2026-10-05 复审实测的窗口不一致）。
    const { runner, store, cfg } = fixture(t, { reminders: new ReminderStore(path.join(root, 'reminders-degrade.json')) });
    for (let i = 1; i <= 60; i++) {
      store.appendIncoming('group:1', {
        mid: i, text: i === 55 ? 'bot 在吗' : `m${i}`, senderId: '42', senderName: 'member-42', mentionsSelf: i === 55
      });
    }
    runner.reminders.items.push({
      id: 'r-degrade', chatKey: 'group:1', at: Date.now() - 1000, text: '喝水', status: 'pending', createdBy: '42'
    });
    let woke = 0;
    runner.wake = async () => { woke++; };
    setRuntimeConfig({ ...cfg, api: { ...cfg.api, budget: { enabled: true, dailyYuan: 0.01, onExceed: 'degrade' } } });
    runner.sessions.todayUsage = () => ({ estimatedYuan: 5 });   // 已超限，但 degrade 只丢"没 @"的那批

    runner.fireDueReminders();

    assert.equal(woke, 1, '@ 在 100 条窗口里 → #wake 不会丢这次唤醒，预检不该拦');
    assert.equal(runner.reminders.items.find((x) => x.id === 'r-degrade').status, 'fired');
  });

  it('定时提醒：一次只派发装得进提示词的条数，装不下的留到下一轮（标记与内容一致）', async (t) => {
    const { runner, append } = fixture(t, { reminders: new ReminderStore(path.join(root, 'reminders-merge.json')) });
    append(1);
    const long = 'A'.repeat(200);
    // 单条正文上限 200 字，note 正文上限 400 字 → 第一条就吃掉全部预算，其余必须留到下一轮
    for (const [i, id] of ['r1', 'r2', 'r3', 'r4'].entries()) {
      runner.reminders.items.push({
        id, chatKey: 'group:1', at: Date.now() - 1000 - i, text: `${long}${i}`, status: 'pending', createdBy: '42'
      });
    }
    const notes = [];
    runner.wake = async (_chatKey, opts = {}) => { notes.push(String(opts.wakeNote || '')); };

    runner.fireDueReminders();

    const byStatus = (s) => runner.reminders.items.filter((x) => x.status === s).map((x) => x.id);
    assert.equal(notes.length, 1, '一轮只唤醒一次');
    assert.deepEqual(byStatus('fired'), ['r1'], '只标记真正写进 note 的那些');
    assert.deepEqual(byStatus('pending'), ['r2', 'r3', 'r4'], '装不下的留在 pending，下一轮继续派');
    // 核心不变量：标记 fired 的每一条，内容都真的在 note 里（此前是多条被截掉却照样标记 fired）
    for (const id of byStatus('fired')) {
      const text = runner.reminders.items.find((x) => x.id === id).text;
      assert.ok(notes[0].includes(text), `${id} 的内容必须在 note 里`);
    }
    for (const id of byStatus('pending')) {
      const text = runner.reminders.items.find((x) => x.id === id).text;
      assert.equal(notes[0].includes(text), false, `${id} 还没派发，内容不该出现在 note 里`);
    }

    // 短提醒能吃满预算：一次全部派发（不能因为"多条"就只发一条）
    for (const item of runner.reminders.items) { item.status = 'pending'; item.at = Date.now() - 1000; }
    runner.reminders.items[0].text = '喝水'; runner.reminders.items[1].text = '吃药';
    runner.reminders.items[2].text = '开会'; runner.reminders.items[3].text = '睡觉';
    notes.length = 0;
    runner.fireDueReminders();
    assert.equal(notes.length, 1);
    assert.deepEqual(byStatus('pending'), [], '四条短提醒应当一轮派完');
    for (const text of ['喝水', '吃药', '开会', '睡觉']) assert.ok(notes[0].includes(text), `${text} 应在同一条 note 里`);
  });

  it('定时提醒：派发话术带归属（谁提的/提醒谁），模型不用再自己圆', async (t) => {
    const { runner, append } = fixture(t, { reminders: new ReminderStore(path.join(root, 'reminders-attribution-fire.json')) });
    append(1);
    runner.reminders.items.push({
      id: 'r-attr', chatKey: 'group:1', at: Date.now() - 1000, text: '去吃饭',
      status: 'pending', createdBy: '彭于晏', targetName: '吴彦祖'
    });
    const notes = [];
    runner.wake = async (_chatKey, opts = {}) => { notes.push(String(opts.wakeNote || '')); };

    runner.fireDueReminders();

    assert.equal(notes.length, 1);
    assert.ok(notes[0].includes('之前彭于晏让你在'), notes[0]);
    assert.ok(notes[0].includes('提醒吴彦祖：去吃饭'), notes[0]);
    assert.ok(notes[0].includes('是谁请你提醒谁的要说清'), notes[0]);
  });

  it('定时提醒：缺归属时话术明确"别猜"，不把提醒说成被提醒人自己设的', async (t) => {
    const { runner, append } = fixture(t, { reminders: new ReminderStore(path.join(root, 'reminders-plain-fire.json')) });
    append(1);
    runner.reminders.items.push({
      id: 'r-plain', chatKey: 'group:1', at: Date.now() - 1000, text: '喝水', status: 'pending'
    });
    const notes = [];
    runner.wake = async (_chatKey, opts = {}) => { notes.push(String(opts.wakeNote || '')); };

    runner.fireDueReminders();

    assert.equal(notes.length, 1);
    assert.ok(notes[0].includes('之前有人让你在'), notes[0]);
    assert.ok(notes[0].includes('别猜'), notes[0]);
  });

  it('锚点（2026-10-10 反馈）：提醒走"逐字"框架，话术真源在 reminders.buildReminderNote', () => {
    const orch = fs.readFileSync(new URL('../src/core/orchestrator.js', import.meta.url), 'utf8');
    assert.ok(orch.includes("const isReminderNote = String(wakeNote).startsWith('【定时提醒】');"), '要有提醒专用分支');
    assert.ok(orch.includes('? `${safeSlice(String(wakeNote), 600)}\\n`'), '提醒 note 要逐字进入（不套"给自己留过话"框架）');
    assert.ok(orch.includes('把提醒自然地说出来即可；说完就结束'), '提醒分支要有自己的收尾语');
    assert.ok(orch.includes('buildReminderNote(chosen, { now })') && orch.includes('reminderNoteCost(item)'),
      '话术与预算要共用 reminders 的唯一实现');
    assert.ok(orch.includes('triggerEntries: (triggerEntries || []).map'),
      '工具 ctx 要带本轮触发消息（remind 的 from 兜底要用）');
    const rem = fs.readFileSync(new URL('../src/core/reminders.js', import.meta.url), 'utf8');
    assert.ok(rem.includes('不要说是被提醒的人自己设的'), '缺归属时的"别猜"指令要留在话术真源里');
  });

  it('自安排唤醒：会话接不了这次唤醒时顺延，而不是删掉安排后静默丢弃', async (t) => {
    const { runner, cfg } = fixture(t);
    // 没配模型时 #wake 会静默 return（模型未设置 → 不产生报错会话），安排不能被吃掉
    setRuntimeConfig({ ...cfg, api: { ...cfg.api, model: '' } });
    runner.scheduledWakes.set('group:1', {
      at: Date.now() - 1000, note: '我过会儿回来看', paced: false, kind: 'selfWake', timer: null
    });

    runner.fireDueScheduledWakes();

    const kept = runner.scheduledWakes.get('group:1');
    assert.ok(kept, '接不了时必须顺延重排，不能把安排删掉');
    assert.equal(kept.note, '我过会儿回来看', '模型留的话不能丢');
    assert.ok(kept.at > Date.now(), '重排到将来');
    setRuntimeConfig(cfg);
  });
  it('每日预算 block：不跑模型、回固定文案、消息保留未读（改进方案 #8）', async (t) => {
    const sentTo = [];
    let traceAtSend = '';
    const { runner, store, cfg, append } = fixture(t, {
      sender: {
        sendTextBatch: async (chatKey, messages) => {
          traceAtSend = currentTraceId();   // #6：运行期异步上下文里必须带着 trace
          sentTo.push({ chatKey, messages });
          return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] };
        }
      }
    });
    cfg.api.budget = { enabled: true, dailyYuan: 1, onExceed: 'block', notify: false };
    setRuntimeConfig(cfg);
    fs.writeFileSync(path.join(root, 'usage-today.json'), JSON.stringify({ dayKey: todayKey(), estimatedYuan: 2 }));
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls += 1;
      return Response.json({ choices: [{ message: { content: 'x' } }] });
    };
    append(1);
    await runner.wake('group:1');
    assert.equal(modelCalls, 0, 'block 不应调用模型');
    assert.ok(sentTo.some((s) => s.messages.join('').includes('今天的额度用完了')), '应回复固定文案');
    assert.equal(store.findByMid('group:1', 1).read, false, '消息保留未读');
    // #6：wake 开 trace —— 运行期上下文带 id，lastTraceId 记录的就是这一次
    assert.match(traceAtSend, /^[0-9a-f]{8}$/, 'wake 运行期必须处于 trace 上下文');
    assert.equal(lastTraceId(), traceAtSend, 'lastTraceId 必须是最近一次运行的 id');
  });

  it('每日预算 block：主动唤醒（冷场开话题/自安排唤醒）也不跑模型、不发文案', async (t) => {
    const sentTo = [];
    const { runner, cfg } = fixture(t, {
      sender: {
        sendTextBatch: async (chatKey, messages) => {
          sentTo.push({ chatKey, messages });
          return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] };
        }
      }
    });
    cfg.api.budget = { enabled: true, dailyYuan: 1, onExceed: 'block', notify: false };
    setRuntimeConfig(cfg);
    fs.writeFileSync(path.join(root, 'usage-today.json'), JSON.stringify({ dayKey: todayKey(), estimatedYuan: 2 }));
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls += 1;
      return Response.json({ choices: [{ message: { content: 'x' } }] });
    };
    await runner.wake('group:1', { proactive: true });
    assert.equal(modelCalls, 0, 'block 策略下主动唤醒同样不许调模型（"今天别再花钱"就该真的停）');
    assert.equal(sentTo.filter((s) => s.messages.join('').includes('今天的额度用完了')).length, 0,
      'proactive 不该往群里发"额度用完"（那是新消息场景的回话）');
  });

  it('"今天的额度用完了"同一天同一会话只发一次（否则兜底回收每 5~25s 重排一次 → 刷屏）', async (t) => {
    const sentTo = [];
    const { runner, store, cfg, append } = fixture(t, {
      sender: {
        sendTextBatch: async (chatKey, messages) => {
          sentTo.push({ chatKey, messages });
          return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] };
        }
      }
    });
    cfg.api.budget = { enabled: true, dailyYuan: 1, onExceed: 'block', notify: false };
    setRuntimeConfig(cfg);
    fs.writeFileSync(path.join(root, 'usage-today.json'), JSON.stringify({ dayKey: todayKey(), estimatedYuan: 2 }));
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'x' } }] });
    append(1);
    await runner.wake('group:1');
    const first = sentTo.filter((s) => s.messages.join('').includes('今天的额度用完了')).length;
    assert.equal(first, 1, '第一轮应发一次');
    // 兜底回收会因"未读未被消费"重排（这正是刷屏的成因）→ 再来一轮仍只应有一条
    await runner.wake('group:1');
    const total = sentTo.filter((s) => s.messages.join('').includes('今天的额度用完了')).length;
    assert.equal(total, 1, '同一天同一会话不该重复说额度用完');
    assert.equal(store.findByMid('group:1', 1).read, false, '消息仍保留未读');
  });

  it('每日预算 degrade：群里非 @ 跳过（保留未读）；有 @ 的同批照常运行（改进方案 #8）', async (t) => {
    const { runner, store, cfg, append } = fixture(t);
    cfg.api.budget = { enabled: true, dailyYuan: 1, onExceed: 'degrade', notify: false };
    setRuntimeConfig(cfg);
    fs.writeFileSync(path.join(root, 'usage-today.json'), JSON.stringify({ dayKey: todayKey(), estimatedYuan: 2 }));
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls += 1;
      return Response.json({ choices: [{ message: { content: 'No reply needed' } }], usage: { total_tokens: 5 } });
    };
    append(1, '随便聊聊');
    await runner.wake('group:1');
    assert.equal(modelCalls, 0, '非 @ 不跑模型');
    assert.equal(store.findByMid('group:1', 1).read, false, '保留未读');
    // 同批里出现 @ 本 bot 的消息 → 整批照常处理（降级只跳过"纯非 @"的触发）
    store.appendIncoming('group:1', { mid: 2, text: '@bot 在吗', senderId: '42', senderName: 'm', mentionsSelf: true });
    await runner.wake('group:1');
    assert.ok(modelCalls >= 1, '有 @ 时应运行');
  });

  // ── 唤醒/排程的失败收口（2026-10-08 二轮审查）──
  // 这两条守同一件事：前置判定与预判里**有 store 读写**（getChatMeta / 线程过期写回 /
  // applyWaitingConversation），任何一步抛出都不能留下"永远停在等待中"的会话，也不能让
  // pendingWake 永久占位（那会让恢复循环从此跳过这个会话）。旧代码里这两处都在 try 之外 ——
  // 抛一次就得重启才能恢复。
  it('唤醒前置判定抛错：等待中会话要被收掉，不能留在 waiting', async (t) => {
    const { runner, store, sessions, append } = fixture(t);
    append(1);
    const waiting = sessions.create({
      chatKey: 'group:1', trigger: [], triggerSummary: '', status: 'waiting', waitUntil: Date.now() + 1000
    });
    // 模拟 sqlite 损坏/磁盘满：前置判定要读会话元数据（getChatMeta → 线程过期写回）
    store.getChatMeta = () => { throw new Error('database disk image is malformed'); };
    await runner.wake('group:1', { waitingSessionId: waiting.id });
    // finish() 会把会话从 current 摘掉并写进索引 —— 两边都要查，否则"undefined !== 'waiting'"
    // 这种空断言会假装通过（实测踩到）。
    assert.equal(sessions.current.has(waiting.id), false, '不能还挂在 current 里当活跃会话');
    const idx = sessions.index.find((s) => s.id === waiting.id);
    assert.ok(idx, '会话应落进索引');
    assert.notEqual(idx.status, 'waiting',
      `前置判定抛错后等待中会话不能被留在 waiting（实际 ${idx.status}）`);
  });

  it('排程预判抛错：pendingWake 不能永久占位（否则恢复循环从此跳过这个会话）', async (t) => {
    const { runner, store } = fixture(t);
    const chatKey = 'group:1';
    // 注入点要在 try 之内（预判/建"等待中"会话那一段读 peekUnread）：
    // 顶层那次 #chatRuntimeDecision 在 pendingWake.add 之前，它抛错不会留下占位。
    store.peekUnread = () => { throw new Error('database or disk is full'); };
    // 排程窗口给足 5s：不然那个 debounce 定时器会在 30ms 内自己跑掉、顺手把 pendingWake 删了，
    // 断言就永远是绿的（实测：窗口给 5ms 时这条用例连变异都咬不住）。
    assert.doesNotThrow(() => runner.scheduleWake(chatKey, 5000));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(runner.pendingWake.has(chatKey), false, 'pendingWake 不该留下这次排程的痕迹');
    assert.equal(runner.firstPendingAt.has(chatKey), false, 'firstPendingAt 也要清掉');
  });

});

describe('proactiveProbability（冷场开话题的发言概率）', () => {
  it('0 是合法取值，不能被默认值吞掉；越界夹到 [0,1]；非数字才回落 0.25', () => {
    // 旧实现是 `Number(p) || 0.25`：手写配置里填 0（= 不再随机开话题）被读成 25%。
    assert.equal(proactiveProbability(0), 0);
    assert.equal(proactiveProbability('0'), 0);
    assert.equal(proactiveProbability(1), 1);
    assert.equal(proactiveProbability(2), 1, '越界夹到 1');
    assert.equal(proactiveProbability(-3), 0, '负值夹到 0');
    assert.equal(proactiveProbability(undefined), 0.25, '没配置才用默认 0.25');
    assert.equal(proactiveProbability('abc'), 0.25);
  });
});

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
