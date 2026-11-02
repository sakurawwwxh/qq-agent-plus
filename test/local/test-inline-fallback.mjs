// 本地回归：内联工具调用兜底 —— 解析器本身 + 三个模块的解析函数 + 空间互动整条链路。
//
// 用法：
//   T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-inline-fallback.mjs
//
// 说明：本用例用桩对象驱动 QzoneInteractionManager，不连真实 OneBot、不发消息；
//       但会在系统临时目录下的 qq-inline-fallback-behavior/ 写一个状态文件。不要把它指向生产数据目录。
import fs from 'node:fs';

const { parseInlineToolCalls, resolveToolCalls } = await import(new URL('../../src/tools/inline-tools.js', import.meta.url).href);
const { parseRelationshipResponse } = await import(new URL('../../src/pilots/relationship-pilot.js', import.meta.url).href);
const { parseFriendReview } = await import(new URL('../../src/identity/identity-pilot-core.js', import.meta.url).href);
const { parseManualFriendReview } = await import(new URL('../../src/identity/identity-pilot.js', import.meta.url).href);
const { QzoneInteractionManager } = await import(new URL('../../src/features/qzone-interactions.js', import.meta.url).href);
const { getConfig, updateConfig } = await import(new URL('../../src/core/config.js', import.meta.url).href);
const cfgNow = structuredClone(getConfig());
cfgNow.runtime = { ...cfgNow.runtime, mode: 'active', paused: false };
updateConfig(cfgNow);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log('%s %s%s', ok ? 'PASS' : 'FAIL', name, extra ? '  ' + extra : '');
  ok ? pass++ : fail++;
};

console.log('=== T1 解析器本身（4 种格式 + 反例）===');
const f1 = '<tool_call>\n<function=get_sticker_image>\n<parameter=stickerId>277</parameter>\n</function>\n</tool_call>';
check('格式1 Hermes XML', JSON.stringify(parseInlineToolCalls(f1)) === JSON.stringify([{ name: 'get_sticker_image', args: { stickerId: 277 } }]));
const f2 = '<tool_call>{"name":"submit_relationship_events","arguments":{"events":[]}}</tool_call>';
check('格式2 包裹 JSON', parseInlineToolCalls(f2)[0]?.name === 'submit_relationship_events');
const f3 = '<tool_call>\nsend_message\n{"messages":"在的"}\n</tool_call>';
check('格式3 首行函数名', parseInlineToolCalls(f3)[0]?.args?.messages === '在的');
const f4 = '{"name":"submit_daily_moment","arguments":{"decision":"skip","reason":"今天没什么好说的"}}';
check('格式4 裸 name-JSON', resolveToolCalls({ content: f4 })[0]?.function?.name === 'submit_daily_moment');
check('反例：普通文本不误判', resolveToolCalls({ content: '今天群里挺热闹的，我就看看' }).length === 0);
check('反例：没有 name 的 JSON 不误判', resolveToolCalls({ content: '{"save":true,"note":"x"}' }).length === 0);
const structured = [{ id: 'call_1', type: 'function', function: { name: 'send_message', arguments: '{}' } }];
check('原生 tool_calls 优先', resolveToolCalls({ tool_calls: structured, content: f1 })[0].id === 'call_1');
check('输出统一成 OpenAI 结构', (() => {
  const c = resolveToolCalls({ content: f1 })[0];
  return c.id && c.type === 'function' && c.function.name === 'get_sticker_image'
    && JSON.parse(c.function.arguments).stickerId === 277;
})());

console.log('\n=== T2 三个模块的解析函数（内联文本应该能取到决定）===');
const inlineRel = { message: { role: 'assistant', content: '<tool_call>\n<function=submit_relationship_events>\n<parameter=events>[]</parameter>\n</function>\n</tool_call>' } };
let relErr = '';
try { parseRelationshipResponse(inlineRel, []); } catch (e) { relErr = String(e.message); }
check('关系评估：不再报"未提交唯一"', !/未提交唯一/.test(relErr), relErr ? '（改为:' + relErr.slice(0, 40) + '）' : '（解析通过）');

const inlineFriend = { message: { role: 'assistant', content: '<tool_call>\n<function=submit_friend_review>\n<parameter=rating>{"quality":3}</parameter>\n<parameter=reason>看着还行</parameter>\n</function>\n</tool_call>' } };
let idErr = '';
try { parseFriendReview(inlineFriend, [], {}); } catch (e) { idErr = String(e.message); }
check('身份评估(core)：不再报"未提交唯一"', !/未提交唯一/.test(idErr), idErr ? '（改为:' + idErr.slice(0, 40) + '）' : '（解析通过）');
let idErr2 = '';
try { parseManualFriendReview(inlineFriend, [], {}); } catch (e) { idErr2 = String(e.message); }
check('身份评估(manual)：不再报"未提交唯一"', !/未提交唯一/.test(idErr2), idErr2 ? '（改为:' + idErr2.slice(0, 40) + '）' : '（解析通过）');

console.log('\n=== T3 空间互动：模型用内联文本提交计划，能不能真的执行 ===');
// 用系统临时目录，别硬编码 /tmp：Windows 上会落到 C:	mp，而且 run.mjs 给的
// QQ_AGENT_DATA_DIR 对它无效（local/README 里记过这个历史遗留）
const os = await import('node:os');
const path = await import('node:path');
const behaviorDir = path.join(os.tmpdir(), 'qq-inline-fallback-behavior');
fs.mkdirSync(behaviorDir, { recursive: true });
const stateFile = path.join(behaviorDir, 'state.json');
const nowSec = Math.floor(Date.now() / 1000);
fs.writeFileSync(stateFile, JSON.stringify({
  version: 1, feedInitializedAt: Date.now() - 3600000, replyInitializedAt: Date.now() - 3600000,
  lastFeedPollAt: 0, lastReplyPollAt: 0, feeds: [], comments: [], watchedPosts: [], runs: []
}));
const seen = [];
const onebot = {
  selfId: '10001',
  async call(action) {
    seen.push(action);
    if (action === 'get_qzone_feeds') return { feeds: [{ uin: '10002', nickname: '测试群友', time: nowSec - 600, appid: 311, key: 'TIDTEST1', content: '今天天气不错，出去走了走', html: '今天天气不错，出去走了走' }] };
    if (action === 'get_qzone_msg_list') return { msglist: [] };
    return { ok: true };
  }
};
const complete = async ({ messages }) => {
  const prompt = messages.map((m) => String(m.content || '')).join('\n');
  const id = (prompt.match(/"id":"(feed-\d+)"/) || [])[1] || 'feed-1';
  const text = '<tool_call>\n<function=submit_qzone_interactions>\n'
    + `<parameter=feedActions>[{"id":"${id}","action":"like","content":"","reason":"看着挺惬意"}]</parameter>\n`
    + '<parameter=replyActions>[]</parameter>\n</function>\n</tool_call>';
  console.log('    [stub] 模型用内联文本提交：feedActions 点赞 ' + id);
  return { message: { role: 'assistant', content: text, tool_calls: [] }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'stub', raw: {} };
};
const mgr = new QzoneInteractionManager({
  onebot, complete, sleep: async () => {}, now: () => Date.now(), random: () => 0.5,
  log: (...a) => console.log('    [qzone]', ...a), stateFile, setProactiveSuppressed: () => {}
});
try {
  const run = await mgr.runNow('feed');
  const liked = seen.includes('like_qzone');
  check('空间互动：内联计划被采纳并执行点赞', liked, 'run.status=' + run.status + ' actions=' + JSON.stringify(run.actions) + ' 接口=' + seen.join(','));
} catch (e) {
  check('空间互动：内联计划被采纳并执行点赞', false, '异常：' + String(e.message).slice(0, 120));
}

console.log('\n结果：%d 通过 / %d 失败', pass, fail);
process.exit(fail ? 1 : 0);
