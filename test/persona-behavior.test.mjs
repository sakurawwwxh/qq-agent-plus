import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-behavior-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { PERSONAS, normalizeBehaviorProfile } = await import('../src/personas.js');
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig, updateConfig, loadConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');
const { buildMomentSystemPrompt, momentPersonaHash } = await import('../src/llm/moment-prompt.js');
const { buildQzoneInteractionPrompt, qzoneInteractionPersonaHash } = await import('../src/llm/qzone-interaction-prompt.js');
const { buildFriendReviewSystemPrompt } = await import('../src/llm/friend-review-prompt.js');
const { mdToPlain } = await import('../src/llm/md-to-plain.js');

// 用技术宅这张卡做 grounded 档的样本（grounded 的行为契约与具体是哪张卡无关）
function groundedPersona() {
  const template = PERSONAS.jishu_zhai;
  return {
    ...DEFAULT_CONFIG.persona,
    roleText: template.text,
    behaviorProfile: template.behaviorProfile
  };
}

test('内置卡单一来源，默认人设不受影响', () => {
  assert.equal(DEFAULT_CONFIG.persona.roleText, PERSONAS.xiaojingyu.text);
  assert.equal(DEFAULT_CONFIG.persona.behaviorProfile, 'legacy');
  assert.equal(PERSONAS.jishu_zhai.behaviorProfile, 'grounded');
  assert.equal(PERSONAS.jishu_zhai.text, fs.readFileSync(
    new URL('../roles/jishu-zhai.md', import.meta.url), 'utf8'
  ).trim());
  for (const text of ['Linux、Docker、网络和二手硬件', '不碰违法和不道德的技术', '没有实际运行结果', '排查口气']) {
    assert.ok(PERSONAS.jishu_zhai.text.includes(text), text);
  }
  for (const [id, persona] of Object.entries(PERSONAS)) {
    assert.doesNotMatch(persona.text, /mcp__|qq_mark_read|\[SILENT\]/, id);
  }
});

test('grounded 档替换冲突的风格规则，但保留权限与工具', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const prompt = buildSystemPrompt({ persona: groundedPersona() });
  for (const text of ['【自然交流与可靠边界】', '不受闲聊字数限制', '不能在后台持续运行',
    '不能执行命令', '发言必须', 'send_message', 'memory_append', '不按轮数凑配额',
    '【梗的使用】', '不主动抛新梗', '不确定意思或可能冒犯就不用', '先判断是不是梗']) {
    assert.ok(prompt.includes(text), text);
  }
  for (const text of ['可以先反问、阴阳、装傻', '给一个离谱/没用的答案', '多数 ≤30 字',
    '只有讲故事、回忆、补刀时才', '大约每 3~5 轮', '代码块在 QQ 上会显示成乱码']) {
    assert.equal(prompt.includes(text), false, text);
  }
  const legacyPersona = { ...DEFAULT_CONFIG.persona };
  delete legacyPersona.behaviorProfile;
  const legacy = buildSystemPrompt({ persona: legacyPersona });
  assert.equal(legacy, buildSystemPrompt({ persona: DEFAULT_CONFIG.persona }));
  assert.ok(legacy.includes('【反 AI 味：拒绝有求必应】'));
  assert.ok(legacy.includes('【梗的使用】'));
  assert.ok(legacy.includes('一轮最多一个梗'));
  assert.ok(legacy.includes('先接住'));
  assert.ok(legacy.includes('搜到梗后先看摘要'), '搜到梗后要有“先看摘要/再决定用不用”的约束');
  assert.ok(legacy.includes('meme=true'), '拿不准的词要显式开启梗补充，不能只靠查询关键词');
  assert.ok(legacy.includes('meme_remember'), '群友解释过的梗要能记进本群梗库');
  assert.ok(legacy.includes('本群梗库'), '提示词要提到本群梗库优先于搜索');
  assert.notEqual(legacy, prompt);
  assert.equal(prompt, buildSystemPrompt({ persona: groundedPersona() }));
});

test('grounded 档不否认定时工具：教了 remind / schedule_wake 就不说"没有安排定时承诺的工具"（2026-10-13 审查）', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const prompt = buildSystemPrompt({ persona: groundedPersona() });
  // 同一份提示词里既教 remind / schedule_wake 的用法、又说"没有安排定时承诺的工具"，
  // 模型会照句子拒设提醒 —— 与本批修的"提醒归属"反馈面直接冲突（独立审查抓到）。
  assert.ok(prompt.includes('schedule_wake'), 'grounded 提示词里应有 schedule_wake 的用法');
  assert.ok(prompt.includes('remind'), 'grounded 提示词里应有 remind 的用法');
  assert.match(prompt, /remind \/ schedule_wake 只是让系统到点唤醒你一次/,
    '该说的边界是"只是到点唤醒一次"，不是"没有这类工具"');
  assert.doesNotMatch(prompt, /没有执行代码、操作引擎或安排定时承诺的工具/,
    '这句与同文的 remind / schedule_wake 教学矛盾');
});

test('所有社交场景都带上同一份角色与附加规则，人设哈希随之失效', () => {
  const persona = groundedPersona();
  for (const build of [
    (p) => buildSystemPrompt({ persona: p }),
    buildMomentSystemPrompt,
    buildQzoneInteractionPrompt,
    buildFriendReviewSystemPrompt
  ]) {
    const result = build({ ...persona, customRules: '测试附加规则' });
    assert.ok(result.includes(persona.roleText));
    assert.ok(result.includes('测试附加规则'));
  }
  for (const hash of [momentPersonaHash, qzoneInteractionPersonaHash]) {
    assert.notEqual(hash(DEFAULT_CONFIG.persona), hash(persona));
  }
  assert.doesNotMatch(buildMomentSystemPrompt(persona), /【工作方式/);
  assert.doesNotMatch(buildQzoneInteractionPrompt(persona), /【反 AI 味/);
});

test('人设档位持久化、保留手改正文、原子拒绝非法值', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  assert.equal(normalizeBehaviorProfile(undefined), 'legacy');
  assert.equal(normalizeBehaviorProfile('card'), 'card', '角色卡优先档要能通过校验');
  updateConfig({ persona: groundedPersona() });
  assert.equal(loadConfig().persona.behaviorProfile, 'grounded');
  updateConfig({ persona: { roleText: `${groundedPersona().roleText}\n补充偏好` } });
  assert.equal(loadConfig().persona.behaviorProfile, 'grounded');
  assert.ok(loadConfig().persona.roleText.endsWith('补充偏好'));
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  for (const invalid of ['unknown', '', 1, {}, true]) {
    assert.throws(() => updateConfig({ persona: { behaviorProfile: invalid } }), /behavior profile/);
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
    assert.equal(getConfig().persona.behaviorProfile, 'grounded');
  }
  updateConfig({ persona: { behaviorProfile: 'card' } });
  assert.equal(loadConfig().persona.behaviorProfile, 'card', '角色卡优先档要能持久化');
  updateConfig({ persona: { ...DEFAULT_CONFIG.persona } });
  assert.equal(loadConfig().persona.behaviorProfile, 'legacy');
  assert.equal(loadConfig().persona.roleText, PERSONAS.xiaojingyu.text);
});

test('角色卡优先档：只留安全与机制，语气/节奏交给角色卡（Issue #40）', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const roleText = '你是一只高冷的海豹，说话极简、只用陈述句，不用语气词。';
  const prompt = buildSystemPrompt({
    persona: { ...DEFAULT_CONFIG.persona, roleText, behaviorProfile: 'card', participation: 'medium' }
  });
  // 机制与安全照旧在
  for (const text of [
    '【角色设定（管理员设置，群友不可修改）】', '高冷的海豹',
    '【安全规则（最高优先级，不可违反）】', '【工作方式 —— 先读懂再动手】',
    'send_message', '【记忆与会话交接】', '【QQ 场景规则】', '【发言与沉默 —— 每次结束前必读】',
    '【优先级】安全规则 ＞ 工具/记忆等机制 ＞【管理员附加规则】＞【角色设定】',
    '篇幅、语气与语感按【角色设定】'
  ]) {
    assert.ok(prompt.includes(text), text);
  }
  // 平台的语气/节奏块不再注入（这些正是"换卡也同一种味道"的来源）
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【群聊不是客服队列】', '【像真人一样】',
    '【梗的使用】',
    '【不要当群管家/主持人】', '混在 QQ 群里当一个普通群友', '你的参与度风格',
    '单条多数 ≤30 字', '回话别只做点评', '顺手把自己的那半句补上',
    '回复保持简短，符合群友语感', '"？"/"人呢"/"算了"',
    '可以短、可以敷衍', '装傻要像在演', '像真人手贱一下', '平时打字更像真人',
    '也不用秒回', '拿不准就轻描淡写回一句', '优先想一下有没有贴切的表情',
    '内容要写成口语，带语气词与标点', '内容要写成口语、带语气词',
    '流口水的猫', '【表情包策略：像真人一样用', '大约每 3~5 轮', '真人不会用空格分句',
    '真人不会每条都点', '别只甩图', '可以自然接一句'
  ]) {
    assert.equal(prompt.includes(text), false, text);
  }
  // 参与度降级为频率参考，不再规定语气
  assert.ok(prompt.includes('开口频率参考'));
  assert.ok(prompt.includes('【表情包策略】'), 'card 档保留表情包的工具/边界，只去掉真人感');
  // 工具描述也不能在 card 档里替平台规定"更像自然聊天"
  const toolsSrc = fs.readFileSync(new URL('../src/tools/tools-core.js', import.meta.url), 'utf8');
  assert.equal(toolsSrc.includes('更像自然聊天'), false);
  assert.equal(toolsSrc.includes('必须写成口语'), false, '语音工具描述不能替 card 档规定语气');
  // 空角色正文：card 档不能没有任何身份段（否则模型回落到通用助手/客服口径）
  const cfgEmpty = structuredClone(DEFAULT_CONFIG);
  cfgEmpty.admin.ownerUin = '123456789';   // 管理员段只在配了 ownerUin 时注入
  setRuntimeConfig(cfgEmpty);
  const empty = buildSystemPrompt({
    persona: { ...cfgEmpty.persona, roleText: '', behaviorProfile: 'card' }
  });
  assert.ok(empty.includes('管理员还没有填写【角色设定】'), '空正文要有中性兜底');
  assert.ok(empty.includes('管理员还没有填写角色设定；'), '管理员段也不要假装正文存在');
  assert.equal(empty.includes('混在 QQ 群里当一个普通群友'), false, '空正文不能回落到旧开场白');
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  // 换回 legacy 档时这些块要回来（三档是并存的，不是把旧档删了）
  const legacy = buildSystemPrompt({
    persona: { ...DEFAULT_CONFIG.persona, roleText, behaviorProfile: 'legacy', participation: 'medium' }
  });
  assert.ok(legacy.includes('【反 AI 味：拒绝有求必应】'));
  assert.ok(legacy.includes('你的参与度风格'));
});

test('grounded 的代码格式保留运算符、缩进与行内代码', () => {
  const code = [
    '#if DEBUG',
    '    var product = a * b * c;',
    '    var mask = left | right;',
    '    var label = "__keep__";',
    '    var test = value > 0 && value < 10;',
    '    var markdown = "[name](url)";',
    '#endif'
  ].join('\n');
  const input = `**Example**\n\`\`\`csharp\n${code}\n\`\`\`\nInline \`a * b * c\`.`;
  assert.equal(mdToPlain(input, { preserveCode: true }), `Example\n${code}\nInline a * b * c.`);
  assert.equal(mdToPlain(`~~~cpp\n${code}\n~~~`, { preserveCode: true }), code);
  assert.equal(mdToPlain('```cs\r\n    x *= 2;\r\n```', { preserveCode: true }), '    x *= 2;');
  assert.equal(mdToPlain('````cs\nvar s = "```";\n````', { preserveCode: true }), 'var s = "```";');
  assert.equal(mdToPlain('\u0000QQ_CODE_0\u0000 `a * b * c`', { preserveCode: true }),
    '\u0000QQ_CODE_0\u0000 a * b * c');
  assert.equal(mdToPlain('**hello**\n- item'), 'hello\n• item');
  assert.equal(mdToPlain('`a * b * c`'), 'a  b  c');
});

const urlCases = [
  ['路径中的下划线', 'https://example.org/package/__init__.py', 'https://example.org/package/__init__.py'],
  ['查询中的下划线', 'https://example.org/download?name=__report__.csv', 'https://example.org/download?name=__report__.csv'],
  ['路径中的星号', 'https://example.org/a*b*c', 'https://example.org/a*b*c'],
  ['查询中的星号与删除线', 'https://example.org/?filter=*a*&name=~~draft~~', 'https://example.org/?filter=*a*&name=~~draft~~'],
  ['地址末尾的标记', 'https://example.org/__tail__ https://example.org/*tail*', 'https://example.org/__tail__ https://example.org/*tail*'],
  ['多个地址', 'https://example.org/a** and https://example.org/b**', 'https://example.org/a** and https://example.org/b**'],
  ['Markdown 链接', '[**源码**](https://example.org/__init__.py)', '源码 (https://example.org/__init__.py)'],
  ['括号与片段', '[文档](https://example.org/a(b)__c__#part*one*)', '文档 (https://example.org/a(b)__c__#part*one*)'],
  ['紧邻格式标记', '**https://example.org/__init__.py**', 'https://example.org/__init__.py'],
  ['跨正文的格式标记', '**请看 https://example.org/a*b*c**。', '请看 https://example.org/a*b*c。'],
  ['嵌套外层格式', '~~**请看 https://example.org/__init__.py**~~', '请看 https://example.org/__init__.py'],
  ['斜体与句号', '*see https://example.org/__init__.py*.', 'see https://example.org/__init__.py.'],
  ['外层下划线', '__see https://example.org/a*b*c__', 'see https://example.org/a*b*c'],
  ['多个格式区域', '**https://example.org/a*b*c** **加粗** https://example.org/__x__', 'https://example.org/a*b*c 加粗 https://example.org/__x__'],
  ['中文标点与括号', '看（https://example.org/__x__），再看 https://example.org/*y*。', '看（https://example.org/__x__），再看 https://example.org/*y*。'],
  ['英文括号与格式', '(https://example.org/__x__) **加粗**', '(https://example.org/__x__) 加粗'],
  ['大小写与转义', 'HTTP://example.org/%2F__x__?q=a%2Ab#*c*', 'HTTP://example.org/%2F__x__?q=a%2Ab#*c*'],
  ['地址中的单引号', "https://example.org/O'Reilly/__init__.py", "https://example.org/O'Reilly/__init__.py"],
  ['裸地址中的右括号', 'https://example.org/a)b__c__?x=*y*', 'https://example.org/a)b__c__?x=*y*'],
  ['地址末尾的表格字符', 'https://example.org/__x__|', 'https://example.org/__x__|'],
  ['图片与正文', '![预览](https://example.org/__image__.png) https://example.org/__file__', '预览 https://example.org/__file__'],
  ['无替代文字图片', '![](https://example.org/__image__.png)', 'https://example.org/__image__.png'],
  ['普通格式对照', '**加粗** *斜体* ~~删除~~ __强调__\n- 项目\n> 引用', '加粗 斜体 删除 强调\n• 项目\n引用'],
  ['非 HTTP 协议对照', 'ftp://example.org/__file__', 'ftp://example.org/file'],
  ['原始控制字符', '\u0000QQ_CODE_0\u0000 \u0000QQ_URL_0\u0000 https://example.org/__x__', '\u0000QQ_CODE_0\u0000 \u0000QQ_URL_0\u0000 https://example.org/__x__']
];
for (const preserveCode of [false, true]) {
  for (const [name, input, expected] of urlCases) {
    test(`URL 原样保留：${name}（preserveCode=${preserveCode}）`, () => {
      assert.equal(mdToPlain(input, { preserveCode }), expected);
    });
  }
}

test('URL 保护与代码保护相互独立', () => {
  const code = '    const url = "https://example.org/__x__?q=*y*";\n    const product = a * b * c;';
  const input = `**源码**\n\`\`\`js\n${code}\n\`\`\`\n\`https://example.org/__inline__\`\nhttps://example.org/__outside__`;
  assert.equal(mdToPlain(input, { preserveCode: true }),
    `源码\n${code}\nhttps://example.org/__inline__\nhttps://example.org/__outside__`);
});

test('grounded 会话通过工具与出站队列发出完整代码', async (t) => {
  const { ChatStore } = await import('../src/core/store.js');
  const { SessionRegistry } = await import('../src/core/sessions.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { SendQueue } = await import('../src/onebot/sender.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona = groundedPersona();
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['123'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const code = '    var product = a * b * c;\n    var mask = left | right;';
  const sent = [];
  const onebot = {
    getGroupInfo: async () => ({ group_name: 'Test' }),
    sendText: async (kind, id, text) => { sent.push({ kind, id, text }); return { message_id: 9 }; }
  };
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const runner = new Orchestrator({
    store, sessions, onebot, stickers: {}, memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot })
  });
  const previousFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = previousFetch;
    await runner.abortAll();
    store.close();
  });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.ok(request.messages[0].content.includes('【自然交流与可靠边界】'));
    calls++;
    if (calls === 1) {
      // 运行途中改设置，不能改变已开始这一轮的消息格式
      setRuntimeConfig({ ...cfg, persona: { ...DEFAULT_CONFIG.persona } });
    }
    return Response.json({
      choices: [{ message: calls === 1 ? { tool_calls: [{
        id: 'code-send', type: 'function',
        function: { name: 'send_message', arguments: JSON.stringify({ messages: `\`\`\`cs\n${code}\n\`\`\`` }) }
      }] } : { content: '' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    });
  };
  store.appendIncoming('group:123', { mid: 1, senderId: '42', text: 'Show code' });
  await runner.wake('group:123');
  assert.deepEqual(sent, [{ kind: 'group', id: '123', text: code }]);
  assert.equal(store.findByMid('group:123', 9).text, code);
  assert.equal(store.findByMid('group:123', 1).state, 'acked');
});

test('控制台接口能列出、选择、自定义与回退内置卡', async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const { createApp } = await import('../src/console/app.js');
  const app = createApp({ log: () => {} });
  app.onebot.connect = async () => {};
  t.after(async () => { await app.stop(); });
  await app.start();
  const request = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const templates = (await (await request('/api/persona-templates')).json()).templates;
  const builtin = templates.find((p) => p.id === 'jishu_zhai');
  assert.equal(builtin.text, groundedPersona().roleText);
  assert.equal(builtin.behaviorProfile, 'grounded');
  assert.equal(builtin.builtin, true);
  assert.equal((await request('/api/config', { persona: groundedPersona() })).status, 200);
  assert.equal((await (await request('/api/config')).json()).persona.behaviorProfile, 'grounded');
  const custom = { name: 'Grounded copy', text: builtin.text, customRules: 'Prefer concise examples', behaviorProfile: 'grounded' };
  assert.equal((await request('/api/persona-templates', custom)).status, 200);
  const saved = (await (await request('/api/persona-templates')).json()).templates.find((p) => p.name === custom.name);
  assert.equal(saved.customRules, custom.customRules);
  assert.equal(saved.behaviorProfile, custom.behaviorProfile);
  assert.equal((await request('/api/persona-templates', { name: 'Old API', text: 'Old role' })).status, 200);
  assert.equal(getConfig().customPersonas.at(-1).behaviorProfile, 'legacy');
  const cardCopy = { name: 'Card copy', text: '高冷海豹', behaviorProfile: 'card' };
  assert.equal((await request('/api/persona-templates', cardCopy)).status, 200, '控制台接口要接受 card 档');
  const savedCard = (await (await request('/api/persona-templates')).json()).templates.find((p) => p.name === cardCopy.name);
  assert.equal(savedCard.behaviorProfile, 'card');
  assert.equal((await request('/api/persona-templates', { ...custom, behaviorProfile: 'bad' })).status, 400);
  assert.equal((await request('/api/config', { persona: DEFAULT_CONFIG.persona })).status, 200);
  assert.equal(getConfig().persona.behaviorProfile, 'legacy');
});

test('控制台人设页提供「角色卡优先」档（全局与新建卡两处都要能选）', () => {
  const src = fs.readFileSync(new URL('../ui/pages/persona.js', import.meta.url), 'utf8');
  const hits = src.match(/<option value="card"/g) || [];
  assert.equal(hits.length, 2, '全局交流策略与「＋ 新建自定义卡」弹窗各一处');
  assert.match(src, /function profileLabel\(/, '卡片上的档位标签要走同一个显示名映射');
  assert.match(src, /v === 'card' \? '角色卡优先' : '原版群友'/);
});
