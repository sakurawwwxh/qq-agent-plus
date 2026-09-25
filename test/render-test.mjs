// 实际执行 ui/app.js 的所有设置分区渲染函数，捕获运行时错误。
// 目的：像"B 未定义"这类错误，node --check（语法检查）根本查不出来，
// 只有真正跑一遍渲染才会暴露。
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须指到临时数据目录：这个用例会 import src/console/app.js，控制台启动时会把身份与
// 异常两个试点的 SQLite 建在 DATA_DIR 下。不重定向就会动到开发机（甚至部署机）自己的
// data/*.sqlite —— 和之前"跑测试覆盖掉 data/config.json"是同一类问题。
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-render-'));
process.env.QQ_AGENT_DATA_DIR = TEST_DATA_DIR;
process.on('exit', () => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch { /* 清理失败不影响用例结论 */ }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ui', 'app.js');
const code = fs.readFileSync(SRC, 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');

// ── 极简 DOM 桩 ──
function makeEl(id = '', cls = '') {
  const el = {
    id,
    _cls: new Set(cls ? cls.split(' ') : []),
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    children: [],
    classList: null,
    addEventListener(type, handler) {
      (el._listeners ||= {})[type] ||= [];
      el._listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      if (!el._listeners?.[type]) return;
      el._listeners[type] = el._listeners[type].filter((entry) => entry !== handler);
    },
    // 返回可用子元素而非 null —— 弹窗代码会拿它调 addEventListener。
    // ⚠️ 同一个 selector 必须返回**同一个**元素：updateUsagePage 用
    //    box.querySelector('[data-field="cost"]').textContent = v 填值，
    //    每次返回新元素的话，测试就永远读不到填进去的数值。
    querySelector: (sel) => { el._q ||= {} ; el._q[sel] ||= makeEl(); return el._q[sel]; },
    querySelectorAll: () => [],
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    closest: () => null,
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20 }),
    insertAdjacentHTML() {},
    contains: () => false,
    scrollTop: 0, scrollHeight: 100, clientHeight: 50
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); },
    contains: (c) => el._cls.has(c)
  };
  return el;
}

const store = new Map();
const document = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  head: makeEl('head'),
  querySelector: (sel) => {
    if (!store.has(sel)) store.set(sel, makeEl(String(sel).replace(/^#/, '')));
    return store.get(sel);
  },
  querySelectorAll: () => [],
  getElementById: (id) => document.querySelector('#' + id),
  createElement: (tag) => {
    const el = makeEl('', '');
    // 假 DOM 不解析 HTML：patchKeyedList 的 makeNode 会读 <template>.content.firstElementChild。
    // 给个空壳（firstElementChild 为 null），定时器触发的列表渲染就会安全跳过 ——
    // 否则会在测试收尾阶段抛 TypeError，把整个用例文件带崩（随机复现）。
    el.content = { firstElementChild: null };
    return el;
  },
  addEventListener() {},
  removeEventListener() {}
};

// SSE 处理器注册表：桩捕获 connectSSE 绑定的监听，测试可直接派发合成事件
const sseRegistry = {};
// 定时器计数：进度行的每秒 ticker 必须能停（切页、跑完都要清），这里数活动定时器个数，
// 断言"回到基线"而不是"等于 0" —— 控制台本来就有常驻轮询定时器。
const activeIntervals = new Set();
const sandbox = {
  document,
  window: null,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1/', protocol: 'http:', host: '127.0.0.1' },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  EventSource: function () {
    this.addEventListener = (type, fn) => { (sseRegistry[type] ||= []).push(fn); };
    this.close = () => {};
  },
  setTimeout, clearTimeout,
  setInterval: (fn, ms, ...rest) => {
    const id = setInterval(fn, ms, ...rest);
    activeIntervals.add(id);
    return id;
  },
  clearInterval: (id) => { activeIntervals.delete(id); clearInterval(id); },
  __intervalStats: () => ({ active: activeIntervals.size }),
  console,
  alert: () => {},
  confirm: () => true,
  prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  URL, Blob: function () {}, FileReader: function () {},
  Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x))
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let pass = 0, fail = 0;
const results = [];

try {
  const ctx = vm.createContext(sandbox);
  // 用 Script 执行（app.js 是普通脚本，非 module）
  new vm.Script(code, { filename: SRC }).runInContext(ctx);

  // 取出渲染函数并执行
  const sections = [
    'renderSettingsSection', 'renderApiSection', 'renderSearchSection',
    'renderMemorySettingsSection', 'renderExperimentalSettingsSection',
    'renderDailyMomentsSection',
    'renderQzoneInteractionSection', 'renderTimeControlSection',
    'renderPersonaSection', 'renderAllowSection',
    'renderChatSection', 'renderDesktopSection', 'renderOnebotSection',
    'renderPersonaLibrary', 'renderPersonaGrid', 'renderHealthCard', 'renderTokenSaverSection',
    'renderAssetSummary', 'renderStickerAssets', 'renderSlangAssets',
    'renderSlangResearch', 'renderIdentityAssets', 'renderMemoryAssets'
  ];

  // 直接用后端的 DEFAULT_CONFIG 做桩 —— 不要手敲字段名，
  // 手敲容易猜错层级（我刚把 minGapMs 放错层，误报了一个不存在的问题）。
  const { DEFAULT_CONFIG } = await import('../src/core/config.js');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  // 再叠加上本轮关心的档位字段（默认值里没有 contextSliderPos）
  cfg.store = {
    ...(cfg.store || {}),
    contextTier: 3, contextSliderPos: 55,
    atCount: 5, keywordCount: 10, keywords: ['大肥鱼'],
    randomPercent: 50, randomCount: 20, allCount: 80
  };
  // 有的分区（健康卡）读的是 state.config —— 控制台是拉到配置后填进去的，测试里先塞好，
  // 否则按"配置还没加载"的分支走，拿不到真实渲染结果。
  vm.runInContext(`state.config = ${JSON.stringify(cfg)};`, ctx);


  console.log('=== 实际执行各设置分区渲染函数 ===\n');
  for (const name of sections) {
    const fn = ctx[name] || sandbox[name];
    if (typeof fn !== 'function') {
      console.log('  SKIP  ' + name + '（非函数或未导出）');
      continue;
    }
    try {
      const out = fn(cfg);
      const ok = typeof out === 'string' && out.length > 0;
      if (ok) { pass++; console.log('  OK    ' + name + '  (' + out.length + ' 字符)'); }
      else { fail++; console.log('  FAIL  ' + name + ' 返回非字符串'); }
    } catch (e) {
      fail++;
      console.log('  FAIL  ' + name + ' 抛错: ' + (e && e.message));
      results.push({ name, err: e && e.message });
    }
  }
  const { PERSONAS } = await import('../src/personas.js');
  // 夹具照控制台 /api/persona-templates 的真实载荷来：内置卡带 builtin: true
  // （卡库靠它显示"内置 · 跟随卡文件"，少了这个标志会一律显示成"自定义"）。
  const personaTemplates = {
    ...Object.fromEntries(Object.entries(PERSONAS).map(([id, p]) => [id, { ...p, builtin: true }])),
    custom_0: {
      ...PERSONAS.jishu_zhai,
      name: 'Grounded copy',
      customRules: 'Explain version assumptions'
    }
  };
  vm.runInContext(`state.personaTemplates = ${JSON.stringify(personaTemplates)};`, ctx);
  ctx.applyPersonaDraft(personaTemplates.custom_0);
  if (ctx.currentPersonaId() === 'custom_0'
      && document.querySelector('#cfg-behavior-profile').value === 'grounded'
      && document.querySelector('#cfg-customrules').value === personaTemplates.custom_0.customRules
      && !document.querySelector('#del-persona-btn').classList.contains('hidden')) {
    pass++;
    console.log('  OK    自定义人设同步正文、策略与附加规则');
  } else {
    fail++;
    console.log('  FAIL  自定义人设草稿字段未同步');
  }
  document.querySelector('#cfg-roletext').value += '\nEdited';
  ctx.syncPersonaButtons();
  // 匹配不上任何内置卡时：既不能错误标记成原模板，提示行也要说清"这是按自定义处理"，
  // 否则升级后（模板改过、实例存的是旧正文）看起来像人设丢了。
  // （旧的 #cfg-persona-pick 隐藏输入框已随人设页改版删除，这里改看提示行与绑定徽章。）
  if (ctx.currentPersonaId() === ''
      && document.querySelector('#persona-pick-hint').textContent.includes('与内置模板不一致')
      && document.querySelector('#persona-view-binding').textContent.includes('解绑')) {
    pass++;
    console.log('  OK    修改人设后不错误标记为原模板');
  } else {
    fail++;
    console.log('  FAIL  修改人设后模板匹配未更新');
  }
  ctx.applyPersonaDraft(PERSONAS.xiaojingyu);
  if (ctx.currentPersonaId() === 'xiaojingyu'
      && document.querySelector('#cfg-behavior-profile').value === 'legacy'
      && document.querySelector('#cfg-customrules').value === ''
      && document.querySelector('#del-persona-btn').classList.contains('hidden')) {
    pass++;
    console.log('  OK    切回原版时恢复策略并清除模板附加规则');
  } else {
    fail++;
    console.log('  FAIL  原版人设回退不完整');
  }
  const groundedHtml = ctx.renderPersonaSection({
    ...cfg, persona: { ...cfg.persona, behaviorProfile: 'grounded' }
  });
  if (groundedHtml.includes('id="cfg-behavior-profile"')
      && groundedHtml.includes('value="grounded" selected')) {
    pass++;
    console.log('  OK    自然可靠交流策略正确回显');
  } else {
    fail++;
    console.log('  FAIL  交流策略未回显');
  }
  // ── 人设页改版：卡库 + 结构化正文视图 ──
  // 角色正文原来只给一个 textarea（"留言板"）；现在解析成分节面板，
  // 招牌渲染成标签、黑名单渲染成打叉标签、示例渲染成聊天气泡。
  const catText = PERSONAS.maoniang.text;
  const catParsed = ctx.parsePersonaCard(catText);
  const parseOk = catParsed.title === '角色卡：猫娘（二次元）'
    && catParsed.sections.length >= 8
    && catParsed.sections.some((s) => s.name.includes('你的标志'));
  parseOk ? pass++ : fail++;
  console.log('  ' + (parseOk ? 'OK   ' : 'FAIL ') + '正文解析出分节与卡名'
    + (parseOk ? '' : ` -> title=${catParsed.title} sections=${catParsed.sections.length}`));

  const exampleSection = catParsed.sections.find((s) => s.name.includes('示例'));
  const exampleBlocks = exampleSection ? exampleSection.blocks.filter((b) => b.type === 'example') : [];
  const askGranted = exampleBlocks.some((b) => b.turns.some((t) => t.role === 'peer' && t.text.includes('给我喵一个'))
    && b.turns.some((t) => t.role === 'ok' && t.text.includes('喵')));
  const exOk = exampleBlocks.length >= 8 && askGranted;
  exOk ? pass++ : fail++;
  console.log('  ' + (exOk ? 'OK   ' : 'FAIL ') + '示例按"群友/你不要/你可以"分组（含"给我喵一个"的给法）'
    + (exOk ? '' : ` -> blocks=${exampleBlocks.length} askGranted=${askGranted}`));

  const catView = ctx.renderPersonaCardBody(catText);
  const viewOk = catView.includes('pd-tag star') && catView.includes('招牌特征')
    && catView.includes('pd-tag bad')
    && catView.includes('pd-quote')
    && catView.includes('pd-msg bad') && catView.includes('pd-msg ok');
  viewOk ? pass++ : fail++;
  console.log('  ' + (viewOk ? 'OK   ' : 'FAIL ') + '招牌=标签、黑名单=打叉标签、示例=气泡、原则=引用块');

  const plainView = ctx.renderPersonaCardBody('就一段没分节的正文，说明这是自定义内容');
  const plainOk = plainView.includes('pd-empty');
  plainOk ? pass++ : fail++;
  console.log('  ' + (plainOk ? 'OK   ' : 'FAIL ') + '没分节的正文给出提示而不是空白');

  const personaSectionHtml = ctx.renderPersonaSection(cfg);
  const keepOk = ['id="persona-grid"', 'id="persona-card-view"', 'id="cfg-roletext"',
    'id="cfg-behavior-profile"', 'id="persona-pick-hint"', 'id="toggle-persona-edit"',
    'id="new-persona-btn"', 'id="del-persona-btn"'].every((needle) => personaSectionHtml.includes(needle));
  keepOk ? pass++ : fail++;
  console.log('  ' + (keepOk ? 'OK   ' : 'FAIL ') + '人设页改版后保留原有 DOM 契约（保存/绑定/删除按钮仍在）');

  const gridHtml = ctx.renderPersonaGrid(cfg, {});
  const gridOk = gridHtml.includes('persona-card') && gridHtml.includes('使用中')
    && gridHtml.includes('内置 · 跟随卡文件');
  gridOk ? pass++ : fail++;
  console.log('  ' + (gridOk ? 'OK   ' : 'FAIL ') + '卡库渲染出卡片与"内置 · 跟随卡文件"来源标记'
    + (gridOk ? '' : ' -> ' + gridHtml.replace(/\s+/g, ' ').slice(0, 240)));

  // 附加规则不再是空白框：给几个点一下就填进去的例子
  const ruleChipsOk = personaSectionHtml.includes('id="persona-rule-chips"')
    && personaSectionHtml.includes('class="pd-tag rule-chip"')
    && personaSectionHtml.includes('＋ 别装傻、别反问，不想接就安静')
    && personaSectionHtml.includes('id="persona-expand-btn"')
    && personaSectionHtml.includes('全部收起');
  ruleChipsOk ? pass++ : fail++;
  console.log('  ' + (ruleChipsOk ? 'OK   ' : 'FAIL ') + '附加规则给出可点选的例子、正文有全部收起按钮');

  // ── 逐节编辑：解析出小节的行号区间，改动按节拼回去 ──
  const catLines = catText.split(/\r?\n/);
  const sec0 = catParsed.sections[0];
  const sec1 = catParsed.sections[1];
  const rangeOk = catLines[sec0.from].startsWith('## ') && catLines[sec1.from].startsWith('## ')
    && sec0.to === sec1.from && catParsed.sections[catParsed.sections.length - 1].to === catLines.length;
  rangeOk ? pass++ : fail++;
  console.log('  ' + (rangeOk ? 'OK   ' : 'FAIL ') + '小节记录了自己在原文里的行号区间');

  const sec0Body = ctx.personaSectionBody(catText, 0);
  // 用"只出现在下一节里的句子"来判断没串到隔壁：'说话方式' 这种词正文里本来就有，不能当判据
  const bodyOk = sec0Body.includes('二次元猫娘') && !sec0Body.includes('## ')
    && !sec0Body.includes('颜文字和表情符号偶尔用');
  bodyOk ? pass++ : fail++;
  console.log('  ' + (bodyOk ? 'OK   ' : 'FAIL ') + '取单节正文不含标题、不含隔壁小节'
    + (bodyOk ? '' : ` -> len=${sec0Body.length} head=${JSON.stringify(sec0Body.slice(0, 60))}`));

  const edited = ctx.replacePersonaSectionBody(catText, 0, '你是群里的新正文，就这一句。');
  const editedCard = ctx.parsePersonaCard(edited);
  const editOk = editedCard.sections.length === catParsed.sections.length
    && edited.includes('## 一、你是谁') && edited.includes('你是群里的新正文，就这一句。')
    && edited === catText.replace(ctx.personaSectionBody(catText, 0), '你是群里的新正文，就这一句。');
  editOk ? pass++ : fail++;
  console.log('  ' + (editOk ? 'OK   ' : 'FAIL ') + '按节替换只动那一节，其余部分逐字节不变');

  const roundTrip = ctx.replacePersonaSectionBody(catText, 3, ctx.personaSectionBody(catText, 3));
  const roundOk = roundTrip === catText;
  roundOk ? pass++ : fail++;
  console.log('  ' + (roundOk ? 'OK   ' : 'FAIL ') + '原样写回时正文逐字节不变（可反复编辑）'
    + (roundOk ? '' : ` -> ${roundTrip.length} vs ${catText.length}`));

  const dirtyText = ctx.replacePersonaSectionBody(catText, 0, '手改过的一节');
  const dirtyView = ctx.renderPersonaCardBody(dirtyText, { fileText: catText });
  // 要能鉴别"只有被改的那一节才给恢复按钮"：数一下按钮个数，并确认它挂在这一节上
  const revertCount = (dirtyView.match(/pd-sec-revert/g) || []).length;
  const revertOk = dirtyView.includes('pd-sec-edit') && revertCount === 1
    && /class="pd-sec[^"]*"[^>]*data-sec="0"[\s\S]*?pd-sec-revert/.test(dirtyView);
  revertOk ? pass++ : fail++;
  console.log('  ' + (revertOk ? 'OK   ' : 'FAIL ') + '只有被改过的那一节出现「恢复本节」'
    + (revertOk ? '' : ` -> 按钮数=${revertCount}`));

  const cleanView = ctx.renderPersonaCardBody(catText, { fileText: catText });
  const cleanOk = cleanView.includes('pd-sec-edit') && !cleanView.includes('pd-sec-revert');
  cleanOk ? pass++ : fail++;
  console.log('  ' + (cleanOk ? 'OK   ' : 'FAIL ') + '没改过的小节不给"恢复本节"（本来就跟卡文件一致）');

  const editingView = ctx.renderPersonaCardBody(catText, { editing: 1 });
  const editorOk = editingView.includes('pd-edit-text') && editingView.includes('pd-sec-save')
    && editingView.includes('pd-sec-cancel')
    && /<div class="pd-sec[^"]*\bediting\b/.test(editingView)
    && editingView.includes('正在编辑');
  editorOk ? pass++ : fail++;
  console.log('  ' + (editorOk ? 'OK   ' : 'FAIL ') + '正在编辑的那节渲染成 textarea + 保存/取消'
    + (editorOk ? '' : ` -> ${editingView.match(/<div class="pd-sec[^"]*"/g)?.join(' | ') || '(没找到小节容器)'}`));

  // 分节编辑：没改过的节不许"原样写回"（会规范化行尾空白/多余空行 → 与卡文件不再逐字节相同
  // → 保存时被当成"自定义" → 静默解绑内置卡）；收起别的节前必须先落草稿（否则正在敲的字会丢）
  const editorRoleBox = document.querySelector('#cfg-roletext');
  const messyCard = '## 一、你是谁\n\n\n你是群里的猫娘，带喵。   \n\n## 二、说话方式\n\n短句。\n';
  const editorField = (idx) => document.querySelector(`#persona-card-view .pd-edit-text[data-sec="${idx}"]`);
  vm.runInContext('personaEditingSection = 0;', ctx);
  editorRoleBox.value = messyCard;
  editorField(0).value = ctx.personaSectionBody(messyCard, 0);
  const flushedNoop = ctx.flushPersonaSectionEdit();
  const noopOk = flushedNoop === false && editorRoleBox.value === messyCard;
  noopOk ? pass++ : fail++;
  console.log('  ' + (noopOk ? 'OK   ' : 'FAIL ') + '没改过的小节原样写回不落草稿（正文与卡文件保持逐字节相同）'
    + (noopOk ? '' : ` -> flushed=${flushedNoop} len=${editorRoleBox.value.length}/${messyCard.length}`));

  editorField(0).value = '你是群里的新正文，就这一句。';
  const flushedEdit = ctx.flushPersonaSectionEdit();
  const editFlushOk = flushedEdit === true && editorRoleBox.value.includes('你是群里的新正文，就这一句。')
    && !editorRoleBox.value.includes('带喵。   ');
  editFlushOk ? pass++ : fail++;
  console.log('  ' + (editFlushOk ? 'OK   ' : 'FAIL ') + '改过的小节落回草稿（并去掉行尾空白）');

  // 正在编辑第 1 节时收起第 0 节：先落草稿再重画，输入框里的字不能丢。
  // 注意顺序：先让折叠基准对齐这张卡（section 数变了的话 refreshPersonaFold 会取消编辑态，
  // 那是"换卡"时的正常行为，不是这条用例要测的东西）。
  const collapseRoleBox = document.querySelector('#cfg-roletext');
  collapseRoleBox.value = catText;
  ctx.syncPersonaButtons();
  vm.runInContext('personaEditingSection = 1;', ctx);
  editorField(1).value = '正在编辑、还没保存的正文';
  // 这些点击行为挂在 bindSettingsEvents 里：测试要显式绑一次（真实控制台是渲染设置页时绑的）。
  // 绑定过程中会同步"视觉开关"，它读 state.config —— 前面的用例把它清过，这里补上。
  vm.runInContext(`state.config = ${JSON.stringify(cfg)};`, ctx);
  ctx.bindSettingsEvents(cfg);
  const fakeSection = { dataset: { sec: '0' } };
  const fakeHead = { closest: (sel) => (sel === '.pd-sec' ? fakeSection : null) };
  const fakeTarget = { closest: (sel) => (sel === '.pd-sec-head' ? fakeHead : null) };
  for (const handler of document.querySelector('#persona-card-view')._listeners?.click || []) {
    handler({ target: fakeTarget });
  }
  const collapsedNow = vm.runInContext('[...personaCollapsedSections].join(",")', ctx);
  const stillEditing = vm.runInContext('personaEditingSection', ctx) === 1;
  const collapseOk = collapseRoleBox.value.includes('正在编辑、还没保存的正文')
    && collapsedNow.split(',').includes('0') && stillEditing;
  collapseOk ? pass++ : fail++;
  console.log('  ' + (collapseOk ? 'OK   ' : 'FAIL ') + '收起别的小节前先落草稿（编辑中的字不会丢）'
    + (collapseOk ? '' : ` -> 折叠=${collapsedNow} 含草稿=${collapseRoleBox.value.includes('正在编辑、还没保存的正文')} 编辑态=${stillEditing}`));
  vm.runInContext('personaEditingSection = -1; personaCollapsedSections = new Set();', ctx);
  collapseRoleBox.value = '';

  // 记忆页每条印象的来源标记：多老 + 谁写的
  const metaNow = ctx.impressionMetaLabel({ content: 'x', createdAt: Date.now(), origin: 'model' });
  const metaOld = ctx.impressionMetaLabel({ content: 'x', createdAt: Date.now() - 40 * 24 * 3600 * 1000, origin: 'manual' });
  const metaLegacy = ctx.impressionMetaLabel({ content: 'x', createdAt: Date.now() });
  const metaAncient = ctx.impressionMetaLabel({ content: 'x', createdAt: Date.now() - 400 * 24 * 3600 * 1000, origin: 'consolidated' });
  const metaBroken = ctx.impressionMetaLabel({ content: 'x', createdAt: 0 });
  const metaOk = /^\[\d{2}-\d{2} · 模型记的\] $/.test(metaNow)
    && /· 手动编辑\] $/.test(metaOld)
    && /· 早先的\] $/.test(metaLegacy)
    && metaNow !== metaOld
    // 一年以上的要带年份（只给月-日会被读成"还没到的那天"）
    && /^\[\d{4}-\d{2}-\d{2} · 整理改写\] $/.test(metaAncient)
    && /^\[\?\?-\?\? · 早先的\] $/.test(metaBroken);
  metaOk ? pass++ : fail++;
  console.log('  ' + (metaOk ? 'OK   ' : 'FAIL ') + '印象标记带日期与来源（今年的月-日 / 往年带年份 / 坏时间戳给 ??)'
    + (metaOk ? '' : ` -> ${metaNow} | ${metaOld} | ${metaLegacy} | ${metaAncient} | ${metaBroken}`));

  vm.runInContext('state.personaTemplates = {};', ctx);
  const desktopHtml = ctx.renderDesktopSection(cfg);
  const apiHtml = ctx.renderApiSection(cfg);
  if (apiHtml.includes('id="cfg-max-run-tokens"')
      && apiHtml.includes('value="160000"')
      && apiHtml.includes('id="cfg-context-window-tokens"')
      && apiHtml.includes('value="1000000"')) {
    pass++;
    console.log('  OK    运行预算与模型上下文窗口控件完整');
  } else {
    fail++;
    console.log('  FAIL  运行预算或模型上下文窗口控件缺失');
  }
  const tokenControls = [
    'cfg-console-token-current', 'cfg-console-token-new',
    'cfg-console-token-confirm', 'change-console-token-btn'
  ].every((id) => desktopHtml.includes(`id="${id}"`));
  if (tokenControls && !desktopHtml.includes('value="console-test-secret"')) {
    pass++;
    console.log('  OK    控制台 Token 更新控件完整且不回显密钥');
  } else {
    fail++;
    console.log('  FAIL  控制台 Token 更新控件缺失或回显了密钥');
  }
  const onebotHtml = ctx.renderOnebotSection({
    ...cfg,
    onebot: { ...cfg.onebot, accessToken: 'onebot-secret', httpAccessToken: 'onebot-http-secret',
      hasAccessToken: true, hasHttpAccessToken: true }
  });
  if (onebotHtml.includes('cfg-obtoken') && onebotHtml.includes('留空保持不变')
      && !onebotHtml.includes('onebot-secret') && !onebotHtml.includes('onebot-http-secret')) {
    pass++;
    console.log('  OK    OneBot Token 留空保持且不回显密钥');
  } else {
    fail++;
    console.log('  FAIL  OneBot Token 控件会丢失或回显密钥');
  }
  const momentsHtml = ctx.renderDailyMomentsSection(cfg);
  const momentControls = [
    'cfg-moments-enabled', 'cfg-moments-catchup',
    'cfg-moments-hour', 'cfg-moments-minute', 'cfg-moments-visibility',
    'cfg-moments-min-messages', 'cfg-moments-max-groups',
    'cfg-moments-max-messages', 'cfg-moments-images',
    'cfg-moments-max-images', 'cfg-moments-research', 'cfg-moments-rounds',
    'daily-moments-preview-btn', 'daily-moments-run-btn', 'daily-moments-status'
  ].every((id) => momentsHtml.includes(`id="${id}"`))
    && code.includes('confirmDuplicateRisk: action')
    && code.includes('confirmDuplicateRisk: publish');
  if (momentControls) {
    pass++;
    console.log('  OK    每日动态调度、研究、配图和手动执行控件完整');
  } else {
    fail++;
    console.log('  FAIL  每日动态设置控件缺失');
  }
  const windowHtml = ctx.renderDailyMomentsSection({
    ...cfg,
    dailyMoments: {
      ...cfg.dailyMoments,
      scheduleWindows: [
        { start: '12:00', end: '14:00', count: 2 },
        { start: '23:00', end: '01:00', count: 3 }
      ]
    }
  });
  const scheduleHtml = ctx.renderMomentSchedule({
    lastScheduleCheck: { reason: '<check>' },
    scheduleSlots: [{
      dayKey: '2026-09-14', windowKey: '23:00-01:00',
      at: Date.parse('2026-09-15T00:15:00+08:00'),
      status: 'pending', reason: '<reason>'
    }, {
      dayKey: '2026-09-14', windowKey: '12:00-14:00',
      at: Date.parse('2026-09-14T12:15:00+08:00'),
      status: 'missed', reason: ''
    }]
  });
  const momentUiChecks = [
    ['旧配置保留固定时刻模式',
      /value="fixed" selected/.test(momentsHtml)
      && /id="moment-random-windows" hidden/.test(momentsHtml)],
    ['多个随机范围、跨午夜与每段条数正确回显',
      /value="windows" selected/.test(windowHtml)
      && /id="moment-fixed-time" hidden/.test(windowHtml)
      && (windowHtml.match(/class="moment-window-row"/g) || []).length === 2
      && ['12:00', '14:00', '23:00', '01:00'].every((time) => windowHtml.includes(`value="${time}"`))
      && /moment-window-count[^>]*value="2"/.test(windowHtml)
      && /moment-window-count[^>]*value="3"/.test(windowHtml)
      && windowHtml.includes('id="moment-window-add"')
      && windowHtml.includes('aria-label="删除时间范围"')],
    ['随机计划显示日期、状态并转义原因',
      scheduleHtml.includes('2026-09-14')
      && scheduleHtml.includes('23:00-01:00')
      && scheduleHtml.includes('待执行')
      && scheduleHtml.includes('已错过窗口')
      && scheduleHtml.includes('&lt;check&gt;')
      && scheduleHtml.includes('&lt;reason&gt;')
      && !scheduleHtml.includes('<reason>')],
    ['固定模式无空计划表', !ctx.renderMomentSchedule({}).includes('<table')]
  ];
  for (const [name, ok] of momentUiChecks) {
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK    ' : 'FAIL  ') + name);
  }
  const momentFetch = sandbox.fetch;
  sandbox.fetch = async () => ({
    ok: true, json: async () => ({
      enabled: true, running: false, scheduleSlots: [], latest: null,
      records: [
        { id: 'auto', dayKey: '2026-09-14', source: 'scheduled', status: 'published' },
        { id: 'manual', dayKey: '2026-09-14', source: 'manual-preview', status: 'published' }
      ]
    })
  });
  try {
    await ctx.loadDailyMomentsStatus();
    const statusHtml = store.get('#daily-moments-status').innerHTML;
    const ok = statusHtml.includes('<th>来源</th>')
      && statusHtml.includes('<td>定时</td>') && statusHtml.includes('<td>手动</td>');
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK    ' : 'FAIL  ') + '动态历史区分手动与定时来源');
  } finally {
    sandbox.fetch = momentFetch;
  }
  const interactionsHtml = ctx.renderQzoneInteractionSection(cfg);
  const interactionControls = [
    'cfg-qzi-enabled', 'cfg-qzi-catchup',
    'cfg-qzi-feed-interval', 'cfg-qzi-reply-interval', 'cfg-qzi-max-age',
    'cfg-qzi-feed-count', 'cfg-qzi-own-count', 'cfg-qzi-batch-items',
    'cfg-qzi-likes', 'cfg-qzi-comments', 'cfg-qzi-replies',
    'cfg-qzi-max-likes', 'cfg-qzi-max-comments', 'cfg-qzi-max-replies',
    'qzi-run-feed-btn', 'qzi-run-reply-btn', 'qzone-interactions-status'
  ].every((id) => interactionsHtml.includes(`id="${id}"`));
  if (
    interactionControls
    && !/id="cfg-qzi-enabled" checked/.test(interactionsHtml)
    && code.includes('对应动态')
    && code.includes('record.details')
  ) {
    pass++;
    console.log('  OK    动态互动默认关闭，调度、限额和手动执行控件完整');
  } else {
    fail++;
    console.log('  FAIL  动态互动设置控件缺失或默认状态错误');
  }
  const experimentalHtml = ctx.renderExperimentalSettingsSection(cfg);
  const experimentalOnHtml = ctx.renderExperimentalSettingsSection({
    ...cfg,
    identityPilot: {
      enabled: true,
      graduated: true,
      incomingFriendRequest: {
        enabled: true,
        autoWhitelist: true,
        maxPending: 50
      },
      friendProposal: {
        enabled: true,
        graduated: true,
        activeDispatchEnabled: true,
        ownerUin: '10000003',
        minMessageCount: 50,
        cooldownDays: 30,
        maxPending: 10
      }
    },
    slangPilot: {
      enabled: true,
      graduated: false,
      ownerUin: '10000003',
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
    incidentPilot: {
      enabled: true,
      graduated: true,
      ownerUin: '10000003',
      notifyWarnings: true,
      duplicateWindowMinutes: 10,
      unknownWritesBlockChat: false,
      retentionDays: 90
    }
  });
  // 「关掉时的样子」显式摆出来：出厂配置不等于"关"（人物印象现在默认就是开的），
  // 拿出厂配置当对照组的话，断言会跟着默认值飘。
  const experimentalOffHtml = ctx.renderExperimentalSettingsSection({
    ...cfg,
    identityPilot: { ...cfg.identityPilot, enabled: false, graduated: false },
    slangPilot: { ...cfg.slangPilot, enabled: false, graduated: false },
    incidentPilot: { ...cfg.incidentPilot, enabled: false, graduated: false }
  });
  if (
    experimentalOffHtml.includes('id="cfg-identity-pilot-enabled"')
    && experimentalOffHtml.includes('id="cfg-auto-friend-enabled"')
    && experimentalOffHtml.includes('id="cfg-slang-pilot-enabled"')
    && experimentalOffHtml.includes('id="cfg-incident-pilot-enabled"')
    && !/id="cfg-identity-pilot-enabled" checked/.test(experimentalOffHtml)
    && /id="cfg-identity-pilot-enabled" checked/.test(experimentalOnHtml)
    && experimentalOnHtml.includes('id="cfg-slang-pilot-enabled" checked')
    && experimentalOnHtml.includes('id="cfg-incident-pilot-enabled" checked')
    && experimentalOffHtml.includes('id="launch-identity-feature"')
    && experimentalOffHtml.includes('固化上线')
    && !/id="launch-identity-feature"[^>]*disabled/.test(experimentalOffHtml)
    && /id="launch-identity-feature"[^>]*disabled/.test(experimentalOnHtml)
    && experimentalOffHtml.includes('id="launch-auto-friend-feature"')
    && experimentalOffHtml.includes('id="launch-slang-feature"')
    && experimentalOffHtml.includes('id="launch-incident-feature"')
    && experimentalOnHtml.includes('人物统一印象')
    && experimentalOnHtml.includes('自动好友添加')
    && experimentalOnHtml.includes('已固化')
    && !experimentalOnHtml.includes('id="identity-pilot-stats"')
    && !experimentalOnHtml.includes('id="identity-pilot-people"')
    && !experimentalOnHtml.includes('id="cfg-identity-friend-owner"')
    && !experimentalOnHtml.includes('id="cfg-slang-owner"')
    && !experimentalOnHtml.includes('data-open-feature')
  ) {
    pass++;
    console.log('  OK    实验页只保留启用与固化动作');
  } else {
    fail++;
    console.log('  FAIL  人物画像实验总开关缺失或默认状态错误');
  }
  const pilotPatchFn = ctx.identityPilotSettingsPatch || sandbox.identityPilotSettingsPatch;
  const pilotOnPatch = pilotPatchFn(
    cfg,
    true,
    {
      enabled: true,
      activeDispatchEnabled: true,
      ownerUin: '10000003',
      minMessageCount: 80
    },
    { enabled: true, autoWhitelist: true, maxPending: 25 }
  );
  const pilotOffPatch = pilotPatchFn({ ...cfg, identityPilot: { enabled: true } }, false);
  if (
    pilotOnPatch.enabled === true
    && pilotOffPatch.enabled === false
    && pilotOnPatch.friendProposal.enabled === true
    && pilotOnPatch.friendProposal.activeDispatchEnabled === true
    && pilotOnPatch.friendProposal.ownerUin === '10000003'
    && pilotOnPatch.friendProposal.minMessageCount === 80
    && pilotOnPatch.incomingFriendRequest.enabled === true
    && pilotOnPatch.incomingFriendRequest.autoWhitelist === true
    && pilotOnPatch.incomingFriendRequest.maxPending === 25
    && pilotOffPatch.friendProposal.enabled === undefined
    && Object.keys(pilotOnPatch).length === 4
    && Object.keys(pilotOffPatch).length === 3
  ) {
    pass++;
    console.log('  OK    实验总开关与主动好友候选生成最小配置补丁');
  } else {
    fail++;
    console.log('  FAIL  实验功能保存补丁不正确');
  }
  const launchPatchFn =
    ctx.experimentalFeatureLaunchPatch || sandbox.experimentalFeatureLaunchPatch;
  const identityLaunchPatch = launchPatchFn(cfg, 'identity');
  const friendLaunchPatch = launchPatchFn(cfg, 'auto-friend', '10000003');
  const slangLaunchPatch = launchPatchFn(cfg, 'slang', '10000003');
  const incidentLaunchPatch = launchPatchFn(cfg, 'incidents', '10000003');
  if (
    identityLaunchPatch.identityPilot.enabled === true
    && identityLaunchPatch.identityPilot.graduated === true
    && Object.keys(identityLaunchPatch).length === 1
    && friendLaunchPatch.identityPilot.enabled === true
    && friendLaunchPatch.identityPilot.friendProposal.enabled === true
    && friendLaunchPatch.identityPilot.friendProposal.graduated === true
    && friendLaunchPatch.identityPilot.friendProposal.activeDispatchEnabled === true
    && friendLaunchPatch.identityPilot.friendProposal.ownerUin === '10000003'
    && friendLaunchPatch.identityPilot.incomingFriendRequest.enabled === true
    && friendLaunchPatch.identityPilot.incomingFriendRequest.autoWhitelist === true
    && Object.keys(friendLaunchPatch).length === 1
    && slangLaunchPatch.slangPilot.enabled === true
    && slangLaunchPatch.slangPilot.graduated === true
    && slangLaunchPatch.slangPilot.ownerUin === '10000003'
    && incidentLaunchPatch.incidentPilot.enabled === true
    && incidentLaunchPatch.incidentPilot.graduated === true
    && incidentLaunchPatch.incidentPilot.ownerUin === '10000003'
  ) {
    pass++;
    console.log('  OK    实验功能支持人物印象与自动好友添加一键上线');
  } else {
    fail++;
    console.log('  FAIL  实验功能一键上线补丁不正确');
  }
  const featureConfig = {
    ...cfg,
    identityPilot: {
      ...cfg.identityPilot,
      enabled: true,
      graduated: true,
      incomingFriendRequest: { ...cfg.identityPilot.incomingFriendRequest, enabled: true },
      friendProposal: {
        ...cfg.identityPilot.friendProposal,
        enabled: true,
        graduated: true,
        activeDispatchEnabled: true,
        ownerUin: '10000003'
      }
    }
  };
  ctx.renderIdentityFeaturePage(
    { active: true, people: 1, aliases: 2, sources: 1, legacyMemories: 1, friends: 0 },
    {
      exists: true,
      entries: [{
        userId: '123456', primaryName: '测试人物', aliases: ['别名'],
        chatCount: 1, messageCount: 5, legacyMemoryCount: 1
      }]
    },
    {
      entries: [{
        chatKey: 'group:123', userId: '123456', name: '测试人物',
        impressions: [{ content: '旧印象内容' }], updatedAt: Date.now()
      }]
    }
  );
  ctx.renderFriendFeaturePage(featureConfig, {
    active: true,
    friendProposal: { protocolNote: '可用', counts: { pending: 1, sent: 2 } },
    incomingFriendRequest: { counts: { pending: 3 } }
  });
  ctx.renderSlangFeaturePage(featureConfig, { active: false, enabled: false });
  ctx.renderIncidentFeaturePage({
    ...featureConfig,
    incidentPilot: {
      ...cfg.incidentPilot,
      enabled: true,
      graduated: true,
      ownerUin: '10000003'
    }
  }, {
    active: true,
    exists: true,
    counts: { open: 1, acknowledged: 0, resolved: 0, critical: 1 },
    pendingNotifications: 0
  }, [{
    id: 'inc_1234567890abcdef',
    code: 'TEST_ERROR',
    severity: 'critical',
    source: 'test',
    chatKey: 'group:123',
    message: '<script>alert(1)</script>',
    count: 1,
    state: 'open',
    lastAt: Date.now()
  }]);
  const dedicatedFeaturePagesOk =
    indexHtml.includes('data-tab="identity"')
    && indexHtml.includes('id="view-identity"')
    && indexHtml.includes('data-tab="friends"')
    && indexHtml.includes('id="view-friends"')
    && indexHtml.includes('data-tab="incidents"')
    && indexHtml.includes('id="view-incidents"')
    && store.get('#identity-page').innerHTML.includes('人物统一印象')
    && store.get('#identity-page').innerHTML.includes('旧印象内容')
    && store.get('#friend-page').innerHTML.includes('好友管理')
    && store.get('#friend-page').innerHTML.includes('cfg-identity-friend-owner')
    && store.get('#friend-page').innerHTML.includes('cfg-identity-friend-mode')
    && store.get('#friend-page').innerHTML.includes('cfg-friend-trigger-probability')
    && store.get('#friend-page').innerHTML.includes('cfg-friend-trigger-min-exchanges')
    && store.get('#friend-page').innerHTML.includes('cfg-friend-trigger-friend-age')
    && store.get('#friend-page').innerHTML.includes('cfg-friend-trigger-skip-cooldown')
    && store.get('#friend-page').innerHTML.includes('cfg-friend-trigger-threshold')
    && store.get('#friend-page').innerHTML.includes('cfg-friend-weight-quality')
    && store.get('#friend-page').innerHTML.includes('已经是好友的用户不会进入抽签')
    && store.get('#friend-page').innerHTML.includes('identity-friend-proposals')
    && store.get('#friend-page').innerHTML.includes('identity-friend-opportunities')
    && store.get('#slang-page').innerHTML.includes('黑话研究')
    && store.get('#slang-page').innerHTML.includes('cfg-slang-owner')
    && store.get('#incident-page').innerHTML.includes('异常日志')
    && store.get('#incident-page').innerHTML.includes('cfg-incident-owner')
    && store.get('#incident-page').innerHTML.includes('&lt;script&gt;alert(1)&lt;/script&gt;')
    && !store.get('#incident-page').innerHTML.includes('<script>alert(1)</script>');
  if (dedicatedFeaturePagesOk) {
    pass++;
    console.log('  OK    固化实验功能拥有独立业务页面');
  } else {
    fail++;
    console.log('  FAIL  固化实验功能独立页面不完整');
  }

  // 省 Token 分区：三档选择 + "用户值 / 生效值"对照表（上限数字来自服务端，界面不另抄一份）
  vm.runInContext(`state.status = { ...(state.status || {}), tokenSaver: ${JSON.stringify({
    mode: 'balanced',
    label: '省',
    active: true,
    capsByMode: {
      off: null,
      balanced: { atCount: 80, keywordCount: 50, randomCount: 30, allCount: 80, maxRounds: 8, maxRunTokens: 80000, handoffMaxChars: 2000, memoryBlockChars: 3000, promptMaxStickers: 5 },
      aggressive: { atCount: 40, keywordCount: 30, randomCount: 20, allCount: 40, maxRounds: 5, maxRunTokens: 50000, handoffMaxChars: 1200, memoryBlockChars: 1500, promptMaxStickers: 3 }
    },
    rows: [
      { key: 'atCount', label: '被艾特时读多少条已读', user: 300, cap: 80, effective: 80, clamped: true },
      { key: 'maxRounds', label: '单次运行最大工具轮数', user: 6, cap: 8, effective: 6, clamped: false }
    ]
  })} };`, ctx);
  const saverHtml = ctx.renderTokenSaverSection({ ...cfg, tokenSaver: { mode: 'balanced' } });
  ctx.renderSettingsSidebar();
  const saverOk = saverHtml.includes('name="token-saver-mode"')
    && /value="balanced"[^>]*checked/.test(saverHtml)
    && /value="off"[^>]*checked/.test(saverHtml) === false
    && saverHtml.includes('档位读 80/50/30 条')
    && saverHtml.includes('<strong>80</strong>') && saverHtml.includes('（被夹住）')
    && saverHtml.includes('单次运行最大工具轮数')
    && store.get('#settings-sidebar').innerHTML.includes('省 Token');
  saverOk ? pass++ : fail++;
  console.log('  ' + (saverOk ? 'OK   ' : 'FAIL ') + '省 Token 分区：三档选择 + 生效值对照表 + 设置菜单入口');

  // 设置 → 闲聊：主动开口的三个开关（冷场/补话/自安排唤醒）+ 表情清单条数（下拉档位）
  const chatHtml = ctx.renderChatSection({
    ...cfg,
    proactive: { ...cfg.proactive, followUpEnabled: false, selfWakeEnabled: false },
    sticker: { ...cfg.sticker, promptMaxStickers: 24 }
  });
  const openSwitchesOk = chatHtml.includes('id="cfg-proactive"')
    && chatHtml.includes('id="cfg-pro-followup"') && chatHtml.includes('id="cfg-pro-selfwake"')
    && !/id="cfg-pro-followup"[^>]*checked/.test(chatHtml)
    && !/id="cfg-pro-selfwake"[^>]*checked/.test(chatHtml)
    // 清单条数是下拉：固定档位 + 存量自定义值（24）补一项并被选中
    && /<select id="cfg-sticker-max">/.test(chatHtml)
    && /<option value="24" selected>/.test(chatHtml)
    && /<option value="60"/.test(chatHtml);
  openSwitchesOk ? pass++ : fail++;
  console.log('  ' + (openSwitchesOk ? 'OK   ' : 'FAIL ') + '设置页：主动开口三个开关 + 表情清单条数下拉');
  // 缺省 / 老配置（字段不存在）按"开"渲染：升级后行为不变；条数默认 10 档
  const defaultHtml = ctx.renderChatSection(cfg);
  const defaultOnOk = /id="cfg-pro-followup"[^>]*checked/.test(defaultHtml)
    && /id="cfg-pro-selfwake"[^>]*checked/.test(defaultHtml)
    && /<option value="10" selected>/.test(defaultHtml)
    // 自由输入框必须不复存在：填多大都只会被静默夹住，那种控件不该出现
    && !/id="cfg-sticker-max"[^>]*type="number"/.test(defaultHtml);
  defaultOnOk ? pass++ : fail++;
  console.log('  ' + (defaultOnOk ? 'OK   ' : 'FAIL ') + '设置页：缺省开关勾选、清单条数默认 10 档且不再是输入框');
  // 存量的超范围值（手改过 config.json 的 500）落到 60 档，不会渲染出 500 这种选项
  const overHtml = ctx.renderChatSection({ ...cfg, sticker: { ...cfg.sticker, promptMaxStickers: 500 } });
  const overOk = /<option value="60" selected>/.test(overHtml)
    && !/<option value="500"/.test(overHtml);
  overOk ? pass++ : fail++;
  console.log('  ' + (overOk ? 'OK   ' : 'FAIL ') + '设置页：超范围存量值落到 60 档，不出现越界选项');

  // 手改成非正数（运行时按默认 10 生效）时界面也必须显示 10 —— 否则保存一下就把用户的值改成 1 了
  const zeroHtml = ctx.renderChatSection({ ...cfg, sticker: { ...cfg.sticker, promptMaxStickers: -5 } });
  const zeroSelect = /<select id="cfg-sticker-max">([\s\S]*?)<\/select>/.exec(zeroHtml)?.[1] || '';
  const zeroOk = /value="10" selected/.test(zeroSelect)
    && !zeroSelect.includes('value="-5"') && !zeroSelect.includes('value="1"');
  zeroOk ? pass++ : fail++;
  console.log('  ' + (zeroOk ? 'OK   ' : 'FAIL ') + '设置页：非正数存量值按运行时的 10 档显示'
    + (zeroOk ? '' : ` -> ${zeroSelect.slice(0, 120)}`));

  // 保存后回填：服务端存下来的值要写回控件（以前填 500 页面上会一直显示 500）
  const maxNode = document.querySelector('#cfg-sticker-max');
  maxNode.value = '500';
  vm.runInContext(`state.config = ${JSON.stringify({
    ...cfg, sticker: { ...cfg.sticker, promptMaxStickers: 60 }
  })};`, ctx);
  ctx.syncClampedInputs();
  const syncOk = maxNode.value === '60';
  syncOk ? pass++ : fail++;
  console.log('  ' + (syncOk ? 'OK   ' : 'FAIL ') + '设置页：保存后把夹住的值回填到清单条数控件'
    + (syncOk ? '' : ` -> value=${maxNode.value}`));

  // 总开关开着、但统一身份库没起来时（active=false），好友页的三个接口都会 409：
  // 加载器要自己给提示，不能因为请求失败把整页（连同设置表单）换成一整块错误信息。
  let friendFetchCalls = 0;
  const fetchBeforeFriends = sandbox.fetch;
  sandbox.fetch = async () => {
    friendFetchCalls++;
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  await ctx.loadIncomingFriendRequests({ active: false, incomingFriendRequest: { enabled: true } });
  await ctx.loadFriendProposals({ active: false, friendProposal: { enabled: true } });
  await ctx.loadFriendOpportunities({ active: false, friendProposal: { enabled: true, mode: 'triggered' } });
  sandbox.fetch = fetchBeforeFriends;
  const inactiveHint = '统一身份库没有启动';
  const inactiveOk = friendFetchCalls === 0
    && store.get('#identity-incoming-friend-requests').innerHTML.includes(inactiveHint)
    && store.get('#identity-friend-proposals').innerHTML.includes(inactiveHint)
    && store.get('#identity-friend-opportunities').innerHTML.includes(inactiveHint);
  inactiveOk ? pass++ : fail++;
  console.log('  ' + (inactiveOk ? 'OK   ' : 'FAIL ') + '身份库没起来时好友页给提示、不去撞 409'
    + (inactiveOk ? '' : ` -> fetch=${friendFetchCalls} 入站=${store.get('#identity-incoming-friend-requests').innerHTML.slice(0, 40)}`));

  // 接口真的报错时，错误要显示在那个列表自己的框里（外层用 allSettled 之后没人替它兜错）
  sandbox.fetch = async () => ({
    ok: false, status: 500, json: async () => ({ error: '内部错误' }), text: async () => ''
  });
  await ctx.loadIncomingFriendRequests({ active: true, incomingFriendRequest: { enabled: true } });
  await ctx.loadFriendProposals({ active: true, friendProposal: { enabled: true } });
  await ctx.loadFriendOpportunities({ active: true, friendProposal: { enabled: true, mode: 'triggered' } });
  sandbox.fetch = fetchBeforeFriends;
  const boxes = ['#identity-incoming-friend-requests', '#identity-friend-proposals', '#identity-friend-opportunities'];
  const errorShown = boxes.every((sel) => store.get(sel).innerHTML.includes('读取失败：内部错误'));
  errorShown ? pass++ : fail++;
  console.log('  ' + (errorShown ? 'OK   ' : 'FAIL ') + '好友页单个接口报错时只在该列表里显示错误'
    + (errorShown ? '' : ` -> ${boxes.map((sel) => store.get(sel).innerHTML.slice(0, 30)).join(' | ')}`));
  const assetSummaryHtml = ctx.renderAssetSummary({
    generatedAt: Date.now(),
    stickers: { enabled: true, total: 3, annotated: 2, used: 1 },
    slang: { exists: true, active: false, total: 4 },
    slangPilot: { active: true, pendingResearch: 2, pendingAdmission: 1 },
    identity: { enabled: true, active: true, people: 5 },
    memory: { chats: 2, people: 3, impressions: 6 }
  });
  const stickerAssetHtml = ctx.renderStickerAssets({
    entries: [{
      id: 'sticker-1', desc: '开心', localNote: '庆祝', tags: ['开心'],
      source: 'qq', useCount: 2, hasImage: true
    }]
  });
  const slangAssetHtml = ctx.renderSlangAssets({
    exists: true,
    entries: [{
      id: 'slang-1', content: '开香槟', meaning: '提前庆祝', status: 'confirmed',
      risk: '', count: 3, evidenceCount: 1
    }]
  });
  const slangResearchHtml = ctx.renderSlangResearch({
    discoveries: [{
      id: 'sr_123456789abc',
      displayTerm: '无名剑法',
      scopeChatKey: 'group:123',
      occurrenceCount: 4,
      speakerCount: 2,
      state: 'pending_research',
      evidence: [{ text: '这就是无名剑法' }]
    }, {
      id: 'sr_abcdef123456',
      displayTerm: '开香槟',
      scopeChatKey: 'group:123',
      occurrenceCount: 5,
      speakerCount: 3,
      state: 'pending_admission',
      evidence: [{ text: '先别开香槟' }],
      research: { meaning: '提前庆祝' }
    }]
  });
  const identityAssetHtml = ctx.renderIdentityAssets({
    exists: true,
    entries: [{
      userId: '123456', primaryName: '测试人物', aliases: ['别名'],
      chatCount: 2, messageCount: 10, isFriend: false,
      profileNote: '画像备注', manuallyManaged: true
    }]
  });
  const memoryAssetHtml = ctx.renderMemoryAssets({
    entries: [{
      chatKey: 'group:123', userId: '123456', name: '测试人物',
      impressions: [{ content: '长期记忆' }], updatedAt: Date.now()
    }]
  });
  const assetUiOk =
    indexHtml.includes('data-tab="assets"')
    && indexHtml.includes('id="view-assets"')
    && !assetSummaryHtml.includes('统一人物')
    && !assetSummaryHtml.includes('会话印象')
    && stickerAssetHtml.includes('/api/assets/stickers/image?id=sticker-1')
    && stickerAssetHtml.includes('asset-edit')
    && stickerAssetHtml.includes('asset-delete')
    && !stickerAssetHtml.includes('https://')
    && slangAssetHtml.includes('开香槟')
    && slangAssetHtml.includes('已确认')
    && slangResearchHtml.includes('无名剑法')
    && slangResearchHtml.includes('研究')
    && slangResearchHtml.includes('查看并收录')
    && typeof ctx.openSlangResearchDetail === 'function'
    && typeof ctx.openSlangAdmissionEditor === 'function'
    && code.includes('/api/slang-pilot/discoveries')
    && identityAssetHtml.includes('画像备注')
    && identityAssetHtml.includes('人工维护')
    && memoryAssetHtml.includes('长期记忆')
    && typeof ctx.openAssetEditor === 'function'
    && typeof ctx.deleteAsset === 'function'
    && code.includes('id="asset-add"')
    && code.includes('/api/assets/stickers/')
    && code.includes('/api/assets/slang/')
    && code.includes('/api/assets/identities/')
    && code.includes('/api/assets/memory');
  if (assetUiOk) {
    pass++;
    console.log('  OK    AI 资产观测入口、概览、表情和黑话视图完整');
  } else {
    fail++;
    console.log('  FAIL  AI 资产观测视图缺失或泄露了图片源 URL');
  }

  const originalFetch = sandbox.fetch;
  const assetDeleteCalls = [];
  sandbox.fetch = async (url, options = {}) => {
    if (options.method === 'DELETE') {
      assetDeleteCalls.push({
        url: String(url),
        body: JSON.parse(options.body || '{}')
      });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ chats: [], entries: [] }),
      text: async () => ''
    };
  };
  const assetDeleteCases = [
    ['stickers', { id: 'sticker-1', desc: '测试表情' }],
    ['slang', { id: 'slang-1', content: '测试黑话' }],
    ['identities', { userId: '123456', primaryName: '测试人物' }],
    ['memory', { chatKey: 'group:123', userId: '123456', name: '测试人物' }]
  ];
  const answerLatestConfirmation = async (accept) => {
    const overlay = document.body.children.at(-1);
    const button = overlay.querySelector(
      accept ? '[data-confirm-accept]' : '[data-confirm-cancel]'
    );
    for (const handler of button._listeners?.click || []) {
      await handler({ currentTarget: button, target: button });
    }
  };
  for (const [kind, entry] of assetDeleteCases) {
    const pending = ctx.deleteAsset(kind, entry);
    await answerLatestConfirmation(false);
    await pending;
  }
  const assetCancelSafe = assetDeleteCalls.length === 0;
  assetCancelSafe ? pass++ : fail++;
  console.log('  ' + (assetCancelSafe ? 'OK   ' : 'FAIL ')
    + '确认弹窗取消时四类资产均不发送 DELETE');

  for (const [kind, entry] of assetDeleteCases) {
    const pending = ctx.deleteAsset(kind, entry);
    await answerLatestConfirmation(true);
    await pending;
  }
  const expectedAssetDeletePaths = [
    '/api/assets/stickers/sticker-1',
    '/api/assets/slang/slang-1',
    '/api/assets/identities/123456',
    '/api/assets/memory'
  ];
  const assetConfirmSafe =
    assetDeleteCalls.length === expectedAssetDeletePaths.length
    && assetDeleteCalls.every((call, index) =>
      call.url === expectedAssetDeletePaths[index] && call.body.confirm === true)
    && assetDeleteCalls[3].body.chatKey === 'group:123'
    && assetDeleteCalls[3].body.userId === '123456';
  assetConfirmSafe ? pass++ : fail++;
  console.log('  ' + (assetConfirmSafe ? 'OK   ' : 'FAIL ')
    + '确认弹窗通过后四类资产各发送一次带显式确认的 DELETE');
  sandbox.fetch = originalFetch;

  vm.runInContext(`state.autoUpdateStatus = ${JSON.stringify({
    installed: true,
    enabled: false,
    busy: false,
    status: 'failed',
    ownerUin: '10000003',
    repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
    branch: 'main',
    intervalHours: 6,
    currentRevision: 'a'.repeat(40),
    targetRevision: 'b'.repeat(40),
    lastCheckAt: Date.now() - 60000,
    nextCheckAt: 0,
    error: '测试失败'
  })};`, ctx);
  ctx.renderControlHub({
    services: [
      { id: 'agent', online: true },
      { id: 'dsh', online: true, optional: true, configured: true },
      { id: 'bridge', online: true, optional: true, configured: true },
      { id: 'snowluma', online: true },
      { id: 'novnc', online: false }
    ]
  });
  const controlHtml = String(document.getElementById('control-page').innerHTML || '');
  // 错误行是运行时填进 #hub-deploy-error 的（结构只建一次、之后只更新字段），
  // 所以"测试失败"要在元素上找，而不是在首次生成的模板字符串里找。
  const deployErrorText = String(document.getElementById('hub-deploy-error')?.textContent || '');
  const controlUiOk =
    indexHtml.includes('data-tab="control"')
    && indexHtml.includes('id="view-control"')
    && controlHtml.includes('服务与访问控制')
    && controlHtml.includes('SnowLuma 登录密钥')
    && controlHtml.includes('更新部署')
    && controlHtml.includes('手动更新')
    && controlHtml.includes('恢复自动更新')
    && controlHtml.includes('10000003')
    && deployErrorText.includes('测试失败')
    && controlHtml.includes('QQ Agent 控制台 Token')
    && controlHtml.includes(':3080')
    && controlHtml.includes(':3100')
    && controlHtml.includes(':5099')
    && controlHtml.includes(':6081')
    && !/id="snowluma-current-password"[^>]*\svalue=/.test(controlHtml);
  if (controlUiOk) {
    pass++;
    console.log('  OK    服务入口、更新部署与密钥控制视图完整');
  } else {
    fail++;
    console.log('  FAIL  服务入口、更新部署或密钥控制视图缺失');
  }

  // 保存白名单不能让屏蔽名单消失：界面里没有 deny 编辑控件，唯一正确的做法是不发这个字段
  // （服务端 config.js 会按现状补 deny.private，而 deepMerge 对数组是整体替换）。
  if (/patch\.deny\s*=/.test(code)) {
    fail++;
    console.log('  FAIL  保存白名单仍会覆盖屏蔽名单（不要发 patch.deny）');
  } else {
    pass++;
    console.log('  OK    保存白名单不动屏蔽名单');
  }

  // 旧架构服务（DSH / Bridge）不在本仓库的部署栈里：没配置端点时显示「未部署」（灰色）而不是
  // 终年「不可达」，指向旧控制台的入口也收起；配置过（迁移期并存）才照旧探测、报不可达。
  const controlBox = document.getElementById('control-page');
  const renderHubFor = (services) => {
    // 结构只建一次，要重走模板就手动重置这两个标记
    controlBox.__hubBuilt = false;
    controlBox.__renderedHtml = null;
    ctx.renderControlHub({ services });
  };
  // 状态是写进 controlBox 自己的 querySelector 桩里的（假 DOM 不解析 HTML），
  // 所以要从同一个元素读，不能从 document 上另取一个桩。
  const tileOf = (id) => controlBox.querySelector(`[data-hub-service="${id}"] .control-service-state`);
  const bridgeRowHidden = () => /class="control-key-row hidden" data-hub-legacy-entry="bridge" href="[^"]*:3100/.test(String(controlBox.innerHTML || ''));
  renderHubFor([
    { id: 'agent', online: true },
    { id: 'dsh', online: false, optional: true, configured: false },
    { id: 'bridge', online: false, optional: true, configured: false },
    { id: 'snowluma', online: true },
    { id: 'novnc', online: false }
  ]);
  const legacyOffOk =
    String(tileOf('dsh')?.textContent) === '未部署'
    && String(tileOf('dsh')?.className).includes('idle')
    && String(tileOf('bridge')?.textContent) === '未部署'
    && String(tileOf('novnc')?.textContent) === '不可达'
    && String(tileOf('snowluma')?.textContent) === '在线'
    && bridgeRowHidden();
  renderHubFor([
    { id: 'agent', online: true },
    { id: 'dsh', online: false, optional: true, configured: true },
    { id: 'bridge', online: true, optional: true, configured: true }
  ]);
  const legacyOnOk = String(tileOf('dsh')?.textContent) === '不可达' && !bridgeRowHidden();
  if (legacyOffOk && legacyOnOk) {
    pass++;
    console.log('  OK    旧架构服务未部署时标「未部署」、入口收起，配置过才报不可达');
  } else {
    fail++;
    console.log(`  FAIL  旧架构服务状态文案异常（未部署 ${legacyOffOk} / 已配置 ${legacyOnOk}）`);
  }

  // 更新进度行（2026-09-22 反馈：点「立即更新」后提示框不关、也没有任何进度显示）：
  // 运行中显示阶段与耗时；排队阶段优先看 status（phase 是上一轮残留）；跑完隐藏并清空。
  vm.runInContext(`state.autoUpdateStatus = ${JSON.stringify({
    installed: true,
    enabled: true,
    busy: true,
    status: 'deploying',
    phase: 'deploying',
    targetVersion: 'v9.9.9',
    startedAt: Date.now() - 125000,
    progressAt: Date.now() - 65000
  })};`, ctx);
  ctx.renderControlHub({ services: [] });
  const progressStage = String(document.getElementById('hub-deploy-progress-text')?.textContent || '');
  const progressElapsed = String(document.getElementById('hub-deploy-progress-elapsed')?.textContent || '');
  const progressShownOk = !document.getElementById('hub-deploy-progress').classList.contains('hidden')
    && progressStage.includes('v9.9.9')
    && progressStage.includes('部署（服务会短暂重启）')
    && progressElapsed.includes('本阶段 1 分')
    && progressElapsed.includes('总计 2 分');
  const queuedText = String(ctx.updateProgressText({
    busy: true, status: 'queued', phase: 'complete', progressAt: Date.now() - 4000
  }) || '');
  const progressQueuedOk = queuedText.includes('等待更新器接手') && !queuedText.includes('收尾');
  const idleText = String(ctx.updateProgressText({ busy: false, status: 'succeeded', phase: 'complete' }) || '');
  // 连通性测试（probe）不部署，不能说成"正在更新"
  const probeText = String(ctx.updateProgressText({
    busy: true, mode: 'probe', status: 'checking', phase: 'connectivity', progressAt: Date.now() - 3000
  }) || '');
  const progressProbeOk = probeText.includes('正在探测更新通道') && probeText.includes('检查网络连通性');
  // 「在跑」的口径与更新器一致：busy 只说明进程在，状态是终态时（跳过间隔、禁用、跑完）不能显示进度行
  const terminalTexts = ['succeeded', 'failed', 'no-update', 'idle'].map((status) => String(
    ctx.updateProgressText({ busy: true, status, phase: 'complete', targetVersion: 'v9.9.9' }) || ''
  ));
  const progressTerminalOk = terminalTexts.every((text) => text === '');
  vm.runInContext('state.autoUpdateStatus = { installed: true, enabled: true, busy: false, status: "succeeded", phase: "complete" };', ctx);
  ctx.renderControlHub({ services: [] });
  const progressHiddenOk = document.getElementById('hub-deploy-progress').classList.contains('hidden') === true
    && String(document.getElementById('hub-deploy-progress-text')?.textContent || '') === ''
    && String(document.getElementById('hub-deploy-progress-elapsed')?.textContent || '') === ''
    && idleText === '';
  if (progressShownOk && progressQueuedOk && progressHiddenOk && progressProbeOk && progressTerminalOk) {
    pass++;
    console.log('  OK    更新进度行：运行中显示阶段与耗时、排队优先看 status、探测不写作更新、跑完/终态隐藏');
  } else {
    fail++;
    console.log(`  FAIL  更新进度行异常（显示 ${progressShownOk} / 排队 ${progressQueuedOk} / 隐藏 ${progressHiddenOk} / 探测 ${progressProbeOk}）`);
  }

  // 1 秒定时器必须真的能跑：曾经回调里调了 updateControlHubFields 的局部 setText，
  // 更新期间每秒抛 ReferenceError；只因当时 tab 没停在 control，测试没抓到。
  vm.runInContext(`state.tab = 'control'; state.autoUpdateStatus = ${JSON.stringify({
    installed: true, enabled: true, busy: true, status: 'deploying', phase: 'deploying',
    targetVersion: 'v9.9.9', startedAt: Date.now() - 3000, progressAt: Date.now() - 3000
  })};`, ctx);
  ctx.renderControlHub({ services: [] });
  const elapsedBefore = String(document.getElementById('hub-deploy-progress-elapsed')?.textContent || '');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const elapsedAfter = String(document.getElementById('hub-deploy-progress-elapsed')?.textContent || '');
  const tickerOk = elapsedBefore !== elapsedAfter && /本阶段 [1-9]\d* 秒/.test(elapsedAfter);
  // 定时器必须能停：切走页签、更新跑完都要清掉，否则后台每秒白跑（也会把旧耗时一直刷新）
  const timers = ctx.__intervalStats ? ctx.__intervalStats() : null;
  const intervalBaseline = timers ? timers.active : 0;
  vm.runInContext('state.tab = "sessions";', ctx);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const stopOnTabOk = !timers || timers.active <= intervalBaseline;
  vm.runInContext('state.tab = "control"; state.autoUpdateStatus = { installed: true, enabled: true, busy: false, status: "succeeded", phase: "complete" };', ctx);
  ctx.renderControlHub({ services: [] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const stopOnFinishOk = !timers || timers.active <= intervalBaseline;
  tickerOk ? pass++ : fail++;
  console.log('  ' + (tickerOk ? 'OK   ' : 'FAIL ') + '进度行每秒刷新本阶段耗时（定时器真的在跑）'
    + (tickerOk ? '' : ` -> "${elapsedBefore}" 到 "${elapsedAfter}"`));
  if (stopOnTabOk && stopOnFinishOk) {
    pass++;
    console.log('  OK    进度行定时器会停：切走页签、更新跑完都清掉'
      + (timers ? `（活动定时器 ${timers.active}）` : '（未统计到定时器，按未泄露通过）'));
  } else {
    fail++;
    console.log(`  FAIL  进度行定时器未清理（切页 ${stopOnTabOk} / 跑完 ${stopOnFinishOk}）`);
  }
  const timeHtml = ctx.renderTimeControlSection({
    ...cfg, allow: { groups: ['123'], private: ['456'] }
  });
  if (['tc-enabled', 'tc-target', 'tc-mode', 'tc-live-state'].every((id) =>
    timeHtml.includes(`id="${id}"`)) && timeHtml.includes('group:123')
    && timeHtml.includes('private:456') && timeHtml.includes('DS 低峰时段')
    && !/id="tc-enabled" checked/.test(timeHtml)) {
    pass++;
    console.log('  OK    时间控制默认关闭，支持群聊及私聊规则');
  } else {
    fail++;
    console.log('  FAIL  时间控制设置不完整');
  }
  const customTimeHtml = ctx.renderTimeControlSection({
    ...cfg,
    timeControl: {
      enabled: true,
      schedule: { mode: 'custom', windows: [{ days: [1, 7], start: '22:00', end: '06:00' }] },
      overrides: {}
    }
  });
  if (customTimeHtml.includes('value="22:00"') && customTimeHtml.includes('value="06:00"')
    && customTimeHtml.includes('data-day="7" checked')
    && customTimeHtml.includes('aria-label="删除时间段"')
    && customTimeHtml.includes('id="tc-add"')) {
    pass++;
    console.log('  OK    自定义时段、星期与增删控件完整');
  } else {
    fail++;
    console.log('  FAIL  自定义时间段控件缺失');
  }
  const conversationHtml = ctx.renderChatSection({
    ...cfg,
    allow: { ...cfg.allow, groups: ['123'] },
    conversation: {
      ...cfg.conversation,
      mode: 'lifecycle',
      unifiedMode: false,
      groupModes: { 123: 'threaded' }
    }
  });
  const conversationControls = [
    'cfg-conversation-mode', 'cfg-conversation-unified',
    'conversation-group-select', 'conversation-group-mode',
    'cfg-cont-window', 'cfg-thread-ttl', 'cfg-cont-history',
    'cfg-life-silent', 'cfg-life-active', 'cfg-life-hard',
    'cfg-life-rollover', 'cfg-life-history', 'cfg-life-tokens', 'cfg-life-chars',
    'cfg-wakedelay-min', 'cfg-wakedelay-max'
  ].every((id) => conversationHtml.includes(`id="${id}"`));
  if (conversationControls
      && conversationHtml.includes('id="cfg-conversation-mode" value="lifecycle"')
      && conversationHtml.includes('id="cfg-life-tokens"')
      && conversationHtml.includes('value="32000"')
      && ['legacy', 'threaded', 'lifecycle'].every((mode) =>
        conversationHtml.includes(`data-conversation-mode="${mode}"`)
        && conversationHtml.includes(`data-conversation-panel="${mode}"`))) {
    pass++;
    console.log('  OK    三种对话模式及分群覆盖控件完整');
  } else {
    fail++;
    console.log('  FAIL  三种对话模式或分群覆盖控件缺失');
  }
  const modePanel = (html, mode) => {
    const match = html.match(new RegExp(
      `<section class="conversation-mode-panel([^"]*)"[^>]*data-conversation-panel="${mode}"[^>]*>([\\s\\S]*?)<\\/section>`
    ));
    return match ? { classes: match[1], html: match[2] } : null;
  };
  const modeViews = Object.fromEntries(['legacy', 'threaded', 'lifecycle'].map((mode) => {
    const html = ctx.renderChatSection({
      ...cfg,
      conversation: { ...cfg.conversation, mode }
    });
    return [mode, {
      legacy: modePanel(html, 'legacy'),
      threaded: modePanel(html, 'threaded'),
      lifecycle: modePanel(html, 'lifecycle')
    }];
  }));
  const isolatedModePanels =
    !modeViews.legacy.legacy.classes.includes('hidden')
    && modeViews.legacy.threaded.classes.includes('hidden')
    && modeViews.legacy.lifecycle.classes.includes('hidden')
    && !modeViews.threaded.threaded.classes.includes('hidden')
    && modeViews.threaded.threaded.html.includes('cfg-cont-window')
    && !modeViews.threaded.threaded.html.includes('cfg-life-silent')
    && !modeViews.lifecycle.lifecycle.classes.includes('hidden')
    && modeViews.lifecycle.lifecycle.html.includes('cfg-life-silent')
    && !modeViews.lifecycle.lifecycle.html.includes('cfg-cont-window');
  if (isolatedModePanels) {
    pass++;
    console.log('  OK    模式切换仅显示当前模式的专属参数');
  } else {
    fail++;
    console.log('  FAIL  不同模式的参数仍混在同一可见面板');
  }
  const statusText = ctx.sessionStatusText || sandbox.sessionStatusText;
  const conversationText = ctx.conversationStatusText || sandbox.conversationStatusText;
  const modeBand = ctx.renderSessionModeBand || sandbox.renderSessionModeBand;
  const triggerLabel = ctx.triggerKindLabel || sandbox.triggerKindLabel;
  const lifecycleSession = {
    status: 'done',
    conversationMode: 'lifecycle',
    threadState: 'listening',
    threadId: '12345678-abcd',
    triggerKind: 'mention',
    lifecycle: { state: 'listening', isCurrent: true }
  };
  if (
    statusText(lifecycleSession) === '本轮已发言'
    && conversationText(lifecycleSession) === '完整生命周期 · 监听中'
    && triggerLabel(lifecycleSession) === '@ 触发'
    && triggerLabel({ triggerKind: 'keyword' }) === '关键词触发'
    && triggerLabel({ triggerKind: 'probability' }) === '传统概率触发'
    && statusText({ status: 'done', conversationMode: 'legacy' }) === '已发言'
    && modeBand(lifecycleSession).includes('session-mode-band mode-lifecycle')
    && modeBand(lifecycleSession).includes('线程 12345678')
  ) {
    pass++;
    console.log('  OK    Session 结束与各模式运行态 UI 已明确区分');
  } else {
    fail++;
    console.log('  FAIL  Session 模式状态仍未清晰区分');
  }
  const groupSessions = ctx.buildSessionDisplayItems || sandbox.buildSessionDisplayItems;
  const threadTimeline = ctx.renderSessionThreadTimeline || sandbox.renderSessionThreadTimeline;
  const lifecycleOverview = ctx.renderLifecycleOverview || sandbox.renderLifecycleOverview;
  const lifecycleDeadline = Date.now() + 10 * 60 * 1000;
  const hardDeadline = Date.now() + 20 * 60 * 1000;
  const groupedRuns = [
    {
      id: 'life-wait', chatKey: 'group:1', startedAt: 3, status: 'waiting',
      conversationMode: 'lifecycle', threadId: 'thread-1', threadState: 'active',
      trigger: '等待第三批', triggerKind: 'lifecycle', triggerReason: '生命周期：活跃状态',
      rounds: 0, webSearchCount: 0, waitUntil: Date.now() + 5000,
      lifecycle: {
        threadId: 'thread-1', state: 'active', isCurrent: true,
        deadline: lifecycleDeadline, hardDeadline
      },
      sessionMetrics: { estimatedCost: 0 },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    },
    {
      id: 'life-2', chatKey: 'group:1', startedAt: 2, status: 'done',
      conversationMode: 'lifecycle', threadId: 'thread-1', threadState: 'listening',
      trigger: '第二批', triggerKind: 'lifecycle', triggerReason: '生命周期：监听状态',
      rounds: 2, webSearchCount: 1, sessionMetrics: { estimatedCost: 0.002 },
      usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22, cachedTokens: 15, calls: 2 }
    },
    {
      id: 'life-1', chatKey: 'group:1', startedAt: 1, status: 'done',
      conversationMode: 'lifecycle', threadId: 'thread-1', threadState: 'active',
      trigger: '第一批', triggerKind: 'mention', triggerReason: '被艾特',
      rounds: 1, webSearchCount: 0, sessionMetrics: { estimatedCost: 0.004 },
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, cachedTokens: 0, calls: 1 }
    },
    {
      id: 'legacy-1', chatKey: 'group:2', startedAt: 1, status: 'done',
      conversationMode: 'legacy', threadId: null, rounds: 1,
      usage: { totalTokens: 5, calls: 1 }
    }
  ];
  const groupedView = groupSessions(groupedRuns);
  vm.runInContext(`state.sessions = ${JSON.stringify(groupedRuns)};`, ctx);
  const timelineHtml = threadTimeline(groupedRuns[0]);
  const lifecycleHtml = lifecycleOverview(groupedRuns[0]);
  const lifecycleGroup = groupedView.find((item) => item.threadId === 'thread-1');
  if (
    groupedView.length === 2
    && lifecycleGroup?.runCount === 3
    && lifecycleGroup?.usage?.totalTokens === 33
    && lifecycleGroup?.estimatedCost === 0.006
    && lifecycleGroup?.originTriggerKind === 'mention'
    && lifecycleGroup?.latestSessionId === 'life-wait'
    && (timelineHtml.match(/data-thread-session-id=/g) || []).length === 3
    && timelineHtml.includes('3 批 · 3 次调用')
    && timelineHtml.includes('@ 触发')
    && timelineHtml.includes('生命周期续接')
    && timelineHtml.includes('¥0.0060')
    && lifecycleHtml.includes('当前状态')
    && lifecycleHtml.includes('生命周期剩余')
    && lifecycleHtml.includes('预估总消耗')
    && lifecycleHtml.includes('¥0.0060')
  ) {
    pass++;
    console.log('  OK    生命周期 Session 展示触发方式、状态、剩余时间和累计消耗');
  } else {
    fail++;
    console.log('  FAIL  生命周期 Session 运行摘要或时间线不完整');
  }
  vm.runInContext('state.sessions = [];', ctx);
  const contextInspector = ctx.renderSessionContextInspector || sandbox.renderSessionContextInspector;
  const contextSession = {
    id: 'context-test',
    status: 'done',
    model: 'deepseek-reasoner',
    promptLayout: 'deepseek-lifecycle-append-v1',
    threadId: 'thread-1',
    inputRound: 2,
    inputPayloadChars: 4096,
    injectedMessages: [{ role: 'assistant', content: '上一轮回复' }],
    inputMessages: [
      { role: 'system', content: '系统提示\n- 规则一\n**重点**' },
      { role: 'user', content: '本轮输入' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }
    ],
    inputTools: [{ type: 'function', function: { name: 'finish' } }],
    inputRequestOptions: { toolChoice: 'auto', temperature: 0.8 },
    usage: {
      promptTokens: 2400,
      completionTokens: 180,
      totalTokens: 2580,
      cachedTokens: 1800,
      calls: 2
    },
    webSearchCount: 2,
    sessionMetrics: { estimatedCost: 0.0123 },
    callUsage: [
      { round: 1, promptTokens: 1000, cachedTokens: 700, completionTokens: 100, totalTokens: 1100 },
      { round: 2, promptTokens: 1400, cachedTokens: 1100, completionTokens: 80, totalTokens: 1480 }
    ],
    messages: [
      { role: 'assistant', content: null, reasoning_content: '检查上下文后调用工具' },
      { toolCall: { name: 'finish', args: {}, result: 'ok' } },
      { role: 'assistant', content: 'done', reasoning_content: '任务已完成' }
    ]
  };
  vm.runInContext("state.sessionInspectorTab = 'input';", ctx);
  const inputInspector = contextInspector(contextSession);
  vm.runInContext("state.sessionInspectorTab = 'injected';", ctx);
  const injectedInspector = contextInspector(contextSession);
  vm.runInContext("state.sessionInspectorTab = 'reasoning';", ctx);
  const reasoningInspector = contextInspector(contextSession);
  const contextMetrics = (ctx.sessionMetricsOf || sandbox.sessionMetricsOf)(contextSession);
  const contextInspectorOk =
    contextMetrics.firstCallCacheHitRate === 0.7
    && contextMetrics.cacheHitRate === 0.75
    && contextMetrics.promptTokens === 2400
    && contextMetrics.completionTokens === 180
    && contextMetrics.cachedTokens === 1800
    && contextMetrics.toolCalls === 1
    && contextMetrics.webSearchCount === 2
    && contextMetrics.estimatedCost === 0.0123
    && inputInspector.includes('完整输入 · 4')
    && inputInspector.includes('Session 全局统计 · 2 次模型调用')
    && inputInspector.includes('首轮缓存命中率')
    && inputInspector.includes('70.0%')
    && inputInspector.includes('总缓存命中率')
    && inputInspector.includes('75.0%')
    && inputInspector.includes('总输出 Token')
    && inputInspector.includes('180')
    && inputInspector.includes('总输入 Token')
    && inputInspector.includes('2,400')
    && inputInspector.includes('总缓存 Token')
    && inputInspector.includes('1,800')
    && inputInspector.includes('总工具次数')
    && inputInspector.includes('总联网次数')
    && inputInspector.includes('预估成本')
    && inputInspector.includes('¥0.0123')
    && inputInspector.includes('当前展示第 2 轮请求快照')
    && inputInspector.includes('第 1 轮')
    && inputInspector.includes('第 2 轮')
    && inputInspector.includes('1,400')
    && inputInspector.includes('1,100')
    && inputInspector.includes('&quot;tools&quot;')
    && inputInspector.includes('#1 · 系统提示')
    && inputInspector.includes('#2 · 会话消息')
    && inputInspector.includes('#3 · 模型')
    && inputInspector.includes('#4 · 工具返回')
    && inputInspector.includes('• 规则一')
    && inputInspector.includes('<strong>重点</strong>')
    && inputInspector.includes('调用工具 <code>finish</code>')
    && inputInspector.includes('&quot;summary&quot;:&quot;ok&quot;')
    && inputInspector.includes('&quot;ok&quot;:true')
    && inputInspector.includes('原始请求 JSON')
    && injectedInspector.includes('上一轮回复')
    && reasoningInspector.includes('检查上下文后调用工具')
    && reasoningInspector.includes('任务已完成');
  if (contextInspectorOk) {
    pass++;
    console.log('  OK    注入对话、完整输入、Token 与模型推理检查器完整');
  } else {
    fail++;
    console.log('  FAIL  模型上下文检查器缺失关键数据');
  }

  // 滑条换算函数
  console.log('\n=== 滑条换算（UI 侧）===');
  for (const fnName of ['sliderToTierUI', 'sliderToTierUI_tierToSlider', 'sliderDesc']) {
    const fn = ctx[fnName] || sandbox[fnName];
    if (typeof fn !== 'function') { fail++; console.log('  FAIL  ' + fnName + ' 未定义'); continue; }
    try {
      if (fnName === 'sliderToTierUI') {
        const r = fn(55);
        const ok = r.tier === 3 && Math.abs(r.randomPercent - 55) < 0.6;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderToTierUI(55) → 档' + r.tier + '/' + r.randomPercent + '%');
      } else if (fnName === 'sliderToTierUI_tierToSlider') {
        // 新语义：滑条位置就是概率，原样还原
        const now = fn({ contextSliderPos: 55, sliderMode: 'probability' });
        // 老配置（四段式位置 55 = 老 3 档 50%）要先换算成概率，不能被直接当成 55%
        const legacy = fn({ contextSliderPos: 55 });
        const legacyTier = fn({ contextSliderPos: null, contextTier: 4, randomPercent: 0 });
        const ok = now === 55 && legacy === 50 && legacyTier === 100;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderToTierUI_tierToSlider() → 新 ' + now
          + ' / 老位置 55 → ' + legacy + ' / 老 4 档 → ' + legacyTier);
      } else {
        const r = fn(55);
        // 滑条值就是概率：55 位置应当说明"55% 概率回"
        const ok = typeof r === 'string' && r.includes('55%');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderDesc(55) → ' + String(r).slice(0, 46));
      }
    } catch (e) {
      fail++;
      console.log('  FAIL  ' + fnName + ' 抛错: ' + (e && e.message));
    }
  }

  // 各滑条位置都渲染一次（覆盖全区间）
  console.log('\n=== 各滑条位置渲染聊天设置 ===');
  for (const pos of [0, 5, 10, 15, 20, 30, 55, 75, 90, 95, 100]) {
    try {
      const out = (ctx.renderChatSection || sandbox.renderChatSection)({
        ...cfg, store: { ...cfg.store, contextSliderPos: pos }
      });
      const ok = typeof out === 'string' && out.length > 0;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' 位置 ' + String(pos).padStart(3) + '% → ' + out.length + ' 字符');
    } catch (e) {
      fail++;
      console.log('  FAIL  位置 ' + pos + '% 抛错: ' + (e && e.message));
    }
  }

    // ── 刻度段高亮：滑到哪一档，对应标签 + 上边线一起变色 ──
    console.log('\n=== 刻度段高亮（拖动联动）===');
    /** 从渲染出的 HTML 里找出带 .on 的刻度段编号 */
    const activeSegs = (html) => {
      const out = [];
      const re = /class="tier-seg seg(\d)([^"]*)"/g;
      let m;
      while ((m = re.exec(html))) { if (/\bon\b/.test(m[2])) out.push(Number(m[1])); }
      return out;
    };
    const renderAt = (pos) => (ctx.renderChatSection || sandbox.renderChatSection)({
      ...JSON.parse(JSON.stringify(cfg)),
      store: { ...cfg.store, contextSliderPos: pos }
    });

    for (const [pos, want, desc] of [
      [0, 1, '最左端(0%)'],
      [5, 2, '5%'], [10, 2, '10%'], [15, 2, '15%'], [20, 2, '20%'], [30, 2, '30%'],
      [55, 3, '55%'], [75, 3, '75%'], [90, 3, '90%'], [99, 3, '99%'],
      [100, 4, '最右端(100%)']
    ]) {
      try {
        const on = activeSegs(renderAt(pos));
        const ok = on.length === 1 && on[0] === want;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(pos).padStart(3) + '% (' + desc + ') → 高亮第 ' + want + ' 段'
          + (ok ? '' : '  实际 [' + on.join(',') + ']'));
      } catch (e) { fail++; console.log('  FAIL ' + pos + '% 抛错: ' + (e && e.message)); }
    }

    // 任何时候只亮一段
    for (const pos of [0, 10, 30, 55, 90, 99, 100]) {
      const on = activeSegs(renderAt(pos));
      const ok = on.length === 1;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(pos).padStart(3) + '% 只亮 1 段' + (ok ? '' : '  实际 ' + on.length + ' 段'));
    }

    // 四段都有机会被点亮
    const lit = new Set();
    for (let p = 0; p <= 100; p += 0.5) for (const n of activeSegs(renderAt(p))) lit.add(n);
    {
      const ok = lit.size === 4;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '四段都能被点亮' + (ok ? '' : '  实际 [' + [...lit].sort().join(',') + ']'));
    }

    // 参数块高亮的规则（2026-09-22 起滑条值就是概率，不再与刻度段一一对应）：
    //   ① 被艾特、② 关键词 —— 始终算数（任何概率下都一定响应，所以都要能读条数）
    //   ③ 按概率响应 —— 只当概率在 (0, 100) 之间
    //   ④ 全响应 —— 只有概率 = 100
    const brightParams = (html) => [...html.matchAll(/class="tier-param(?!s)([^"]*)"/g)]
      .map((m, i) => ({ idx: i + 1, dim: /\bdim\b/.test(m[1]) }))
      .filter((x) => !x.dim)
      .map((x) => x.idx);
    // 注意正则要带边界：容器是 tier-params（复数），不能被当前缀匹配进来
    for (const [pos, want] of [
      [0, [1, 2]], [5, [1, 2, 3]], [30, [1, 2, 3]], [99, [1, 2, 3]], [100, [1, 2, 4]]
    ]) {
      const bright = brightParams(renderAt(pos));
      const ok = bright.join(',') === want.join(',');
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(pos).padStart(3) + '% 参数高亮 [' + bright.join(',') + ']'
        + (ok ? '' : '  期望 [' + want.join(',') + ']'));
    }


    // ── 调用明细弹窗（点「调用次数」卡片打开）──
    console.log('\n=== 调用明细弹窗 ===');
    const openBreakdown = ctx.openToolBreakdown || sandbox.openToolBreakdown;
    if (typeof openBreakdown !== 'function') {
      fail++; console.log('  FAIL openToolBreakdown 未定义');
    } else {
      const fakeStats = {
        rangeLabel: '近 7 天',
        searchCount: 46,
        toolCounts: {
          send_message: 133, finish: 149, send_sticker: 7, send_poke: 6,
          get_recent_messages: 3, get_message_images: 70, get_message_detail: 7,
          list_stickers: 4, collect_sticker: 2,
          memory_append: 2, person_memory_lookup: 4, memory_remove: 2,
          web_search: 39, web_fetch: 7,
          some_unknown_tool: 5
        }
      };
      let captured = '';
      const realShell = ctx.modelModalShell || sandbox.modelModalShell;
      // 拦截弹窗外壳，拿到它渲染的 body
      ctx.modelModalShell = sandbox.modelModalShell = (opt) => { captured = String(opt.body || ''); return makeEl(); };

      try {
        vm.runInContext('state.usageStats = ' + JSON.stringify(fakeStats) + ';', ctx);
        openBreakdown();
        const ok = captured.length > 0
          && captured.includes('tool-breakdown')
          && captured.includes('send_message')
          && captured.includes('person_memory_lookup')
          && captured.includes('查人物记忆')
          && captured.includes('联网搜索')
          && captured.includes('some_unknown_tool');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '弹窗渲染（含未知工具兜底）  ' + captured.length + ' 字符');
        const catsOk = ['发言', '查看', '表情', '记忆', '联网', '其他'].every((c) => captured.includes(c));
        catsOk ? pass++ : fail++;
        console.log('  ' + (catsOk ? 'OK   ' : 'FAIL ') + '六个分类齐全');
        const leadOk = captured.includes('发了 133 条消息') && captured.includes('联网查了 46 次');
        leadOk ? pass++ : fail++;
        console.log('  ' + (leadOk ? 'OK   ' : 'FAIL ') + '一句话小结正确');
      } catch (e) {
        fail++; console.log('  FAIL 弹窗抛错: ' + (e && e.message));
      }

      try {
        captured = '';
        vm.runInContext("state.usageStats = { rangeLabel: '今天', searchCount: 0, toolCounts: {} };", ctx);
        openBreakdown();
        const ok = captured.includes('还没有任何工具调用记录');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '空数据给出友好提示');
      } catch (e) {
        fail++; console.log('  FAIL 空数据抛错: ' + (e && e.message));
      }

      if (realShell) ctx.modelModalShell = sandbox.modelModalShell = realShell;
    }


    // ── 用量页端到端：实际调用 loadUsageView 并验证页面真的有内容 ──
    // 补这个是因为：上一轮 loadUsageView 被误删，而现有测试**全是绿的** ——
    // 没有任何测试真正调用它，所以删了也没人发现。这是测试盲区。
    console.log('\n=== 用量页加载（loadUsageView）===');
    {
      const { DEFAULT_CONFIG: DC2 } = await import('../src/core/config.js');
      const loadUsage = ctx.loadUsageView || sandbox.loadUsageView;
      if (typeof loadUsage !== 'function') {
        fail++; console.log('  FAIL loadUsageView 未定义（用量页会一直空白）');
      } else {
        // 造一份统计返回
        const stats = {
          range: '7', rangeLabel: '近 7 天', mode: 'days',
          totals: {
            cost: 3.96, promptTokens: 120000, completionTokens: 34000,
            cachedTokens: 80000, totalTokens: 154000,
            cacheHitRate: 0.666, runs: 149, peakCost: 2, offPeakCost: 1.96
          },
          searchCount: 46,
          toolCounts: { send_message: 133, web_search: 39, finish: 149 },
          days: [{ key: '2026-09-04', runs: 20, promptTokens: 1000, completionTokens: 200, cachedTokens: 500, cacheHitRate: 0.5, cost: 0.5 }],
          chats: [{ key: 'group:1', runs: 10, promptTokens: 500, completionTokens: 100, cacheHitRate: 0.4, cost: 0.2 }],
          models: [{ key: 'deepseek:deepseek-chat', runs: 149, promptTokens: 120000, completionTokens: 34000, cacheHitRate: 0.666, cost: 3.96 }]
        };
        const statusData = { usage: { runs: 12 }, config: DC2 };
        const prices = { rows: [] };

        // ⚠️ mock 只覆盖**真实存在**的接口，其余一律 404。
        //    曾经这里把 /api/usage/prices 也 mock 成 200，而这个接口后端根本没有
        //    —— 结果测试全绿、线上用量页永远加载失败。
        //    所以未知路径必须返回 404，让"捏造的接口"在测试里就暴露。
        const realFetch = sandbox.fetch;
        const REAL_USAGE_APIS = ['/api/usage/stats', '/api/usage/breakdown', '/api/status'];
        sandbox.fetch = async (url) => {
          const u = String(url);
          const hit = REAL_USAGE_APIS.find((p) => u.includes(p));
          if (!hit) return { ok: false, status: 404, json: async () => ({ error: `未知 API：${u}` }) };
          const body = u.includes('/api/usage/stats') ? stats : statusData;
          return { ok: true, status: 200, json: async () => body };
        };

        const usageBox = document.getElementById('usage-page');
        try {
          vm.runInContext("state.tab = 'usage';", ctx);
          await loadUsage({ force: true });
          const html = String(usageBox.innerHTML || '');
          if (html.length < 500) console.log('    [调试] 实际内容: ' + JSON.stringify(html.slice(0, 300)));
          const ok = html.length > 500
            && html.includes('用量与成本')
            && html.includes('估算成本')
            && html.includes('搜索次数');
          ok ? pass++ : fail++;
          console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '加载后页面有内容  ' + html.length + ' 字符'
            + (ok ? '' : '  （缺关键区块）'));

          // 数值应被填入。注意 updateUsagePage 走的是 textContent（不是 innerHTML），
          // 所以要直接查那个字段元素，而不是查整段 HTML
          const costEl = usageBox.querySelector('[data-field="cost"]');
          const costTxt = String(costEl?.textContent || '');
          const runsEl = usageBox.querySelector('[data-field="runs"]');
          const runsTxt = String(runsEl?.textContent || '');
          const searchEl = usageBox.querySelector('[data-field="search"]');
          const searchTxt = String(searchEl?.textContent || '');
          const filled = costTxt.includes('3.96') && runsTxt === '149' && searchTxt === '46';
          filled ? pass++ : fail++;
          console.log('  ' + (filled ? 'OK   ' : 'FAIL ') + '数值已填充  成本=' + costTxt
            + ' 调用=' + runsTxt + ' 搜索=' + searchTxt);

          // 骨架屏应已被真实内容替换
          const noSkeleton = !/usage-card skeleton/.test(html);
          noSkeleton ? pass++ : fail++;
          console.log('  ' + (noSkeleton ? 'OK   ' : 'FAIL ') + '骨架屏已被替换（不是一直转圈）');

          // 非 force（轮询）路径：只更新数值，不重建
          usageBox.innerHTML = '<div id="keepme">KEEP</div>';
          await loadUsage();
          const kept = String(usageBox.innerHTML || '').includes('KEEP');
          kept ? pass++ : fail++;
          console.log('  ' + (kept ? 'OK   ' : 'FAIL ') + '轮询(force=false)不重建 DOM');

          // ★ 第二次进入：应直接用上次数据立即渲染，不显示骨架
          //   （后端统计冷启动约 200ms，缓存 TTL 只有 5s，每次都等就是"黑一下"）
          usageBox.innerHTML = '';
          let sawSkeleton = false;
          const origSkeleton = ctx.renderUsageSkeleton || sandbox.renderUsageSkeleton;
          ctx.renderUsageSkeleton = sandbox.renderUsageSkeleton = () => { sawSkeleton = true; return origSkeleton(); };
          await loadUsage({ force: true });
          ctx.renderUsageSkeleton = sandbox.renderUsageSkeleton = origSkeleton;
          const secondHtml = String(usageBox.innerHTML || '');
          const ok2 = !sawSkeleton && secondHtml.includes('估算成本');
          ok2 ? pass++ : fail++;
          console.log('  ' + (ok2 ? 'OK   ' : 'FAIL ') + '二次进入直接显示旧数据（不闪骨架）');

          // ★ 用量页请求的接口必须真实存在（不能在测试里 mock 掉 404）
          //   上一轮就是凭空捏造了 /api/usage/prices，测试绿、线上白屏。
          const { createApp: createApp2 } = await import('../src/console/app.js');
          const { setRuntimeConfig: setRuntimeConfig2, DEFAULT_CONFIG: DEFAULT_CONFIG2 } = await import('../src/core/config.js');
          const http = await import('node:http');
          // console 的 start() 用的是配置里的端口（不收参数），默认 3210；而本机开着
          // console 隧道时 3210 是被占的，用例会因为 EADDRINUSE 误报。先探一个空闲
          // 端口写进配置，用例就不再依赖 3210 空着。
          const freePort = await new Promise((resolve, reject) => {
            const probe = http.createServer();
            probe.once('error', reject);
            probe.listen(0, '127.0.0.1', () => {
              const port = probe.address().port;
              probe.close(() => resolve(port));
            });
          });
          setRuntimeConfig2({
            ...structuredClone(DEFAULT_CONFIG2),
            server: { ...DEFAULT_CONFIG2.server, host: '127.0.0.1', port: freePort }
          });
          const realApp = createApp2({ log: () => {} });
          const realPort = await realApp.start();
          const hit = (p) => new Promise((r) => {
            http.request({ host: '127.0.0.1', port: realPort, path: p, method: 'GET',
              headers: { 'x-console-token': 'qq-agent-console' } },
              (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r({ code: res.statusCode, d })); }
            ).on('error', () => r({ code: 0, d: '' })).end();
          });
          for (const p of ['/api/usage/stats?range=7', '/api/status']) {
            const r = await hit(p);
            const ok = r.code === 200;
            ok ? pass++ : fail++;
            console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '真实接口可用 ' + p + ' → HTTP ' + r.code);
          }
          // 反向确认：不存在的接口确实返回 404（证明上面不是假阳性）
          const bad = await hit('/api/usage/prices');
          const badOk = bad.code === 404;
          badOk ? pass++ : fail++;
          console.log('  ' + (badOk ? 'OK   ' : 'FAIL ') + '不存在的接口确实 404（/api/usage/prices）');
          await realApp.stop();

          // 切到别的 range 时，旧数据不能冒用（range 对不上会显示错的区间）
          vm.runInContext("usageRange = 'today';", ctx);
          usageBox.innerHTML = '';
          let usedOld = false;
          const origPage = ctx.renderUsagePage || sandbox.renderUsagePage;
          ctx.renderUsagePage = sandbox.renderUsagePage = (...a) => { usedOld = true; return origPage(...a); };
          // 先清掉缓存，模拟"新 range 没有旧数据"
          vm.runInContext('usageLastData = null;', ctx);
          usageBox.innerHTML = '';
          await loadUsage({ force: true });
          ctx.renderUsagePage = sandbox.renderUsagePage = origPage;
          vm.runInContext("usageRange = '7';", ctx);
          const ok3 = usedOld;
          ok3 ? pass++ : fail++;
          console.log('  ' + (ok3 ? 'OK   ' : 'FAIL ') + '切换 range 会重新渲染（不误用旧区间数据）');
        } catch (e) {
          fail++; console.log('  FAIL 抛错: ' + (e && e.message));
        } finally {
          sandbox.fetch = realFetch;
        }
      }
    }

  // ── 会话详情 SSE 实时性（2026-09-05 回归）──
  // 曾经的三个洞：① SSE 载荷不带 sent →"已发送"徽标只能等手动刷新；
  // ② session-end 不重拉详情（轮询只刷 running/waiting，最终态再也不来）；
  // ③ 渲染合批用 rAF → 窗口被遮挡时完全停火，渲染全部积压。
  console.log('\n=== 会话详情 SSE 实时推送 ===');
  try {
    const detailBox = document.querySelector('#session-detail');
    vm.runInContext(`
      state.tab = 'sessions';
      state.currentSessionId = 's_sse_1';
      state.sessionDetail = { id: 's_sse_1', chatKey: 'group:1', status: 'running', startedAt: 1,
        messages: [], sent: [], usage: { calls: 0 }, rounds: 0 };
      state.sessions = [{ id: 's_sse_1', chatKey: 'group:1', status: 'running', startedAt: 1, messages: [], sent: [] }];
      state.chats = [];
      lastDetailFp = null;
    `, ctx);
    ctx.connectSSE();   // 把处理器注册进 sseRegistry（init 里那次可能还没执行到）
    const fireSse = (type, data) => { for (const fn of sseRegistry[type] || []) fn({ data: JSON.stringify(data) }); };
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

    // ① session-update 携带 sent：合批（80ms）后详情必须实时出现工具卡片与"已发送"徽标
    fireSse('session-update', {
      sessionId: 's_sse_1', chatKey: 'group:1', status: 'running', activity: '',
      rounds: 1, usage: { calls: 1 },
      messages: [{ role: 'assistant', content: '让我想想' },
        { toolCall: { name: 'send_message', args: { messages: '实时你好' }, result: '已发送' } }],
      sent: [{ type: 'text', text: '实时你好', at: '12:00:00' }]
    });
    await sleepMs(250);
    const html1 = String(detailBox.innerHTML || '');
    const okTool = html1.includes('send_message');
    okTool ? pass++ : fail++;
    console.log('  ' + (okTool ? 'OK   ' : 'FAIL ') + '工具卡片实时出现（send_message）' + (okTool ? '' : ' -> ' + html1.slice(0, 100)));
    const okSent = html1.includes('实时你好');
    okSent ? pass++ : fail++;
    console.log('  ' + (okSent ? 'OK   ' : 'FAIL ') + '已发送徽标实时出现（不等轮询/手动刷新）' + (okSent ? '' : ' -> ' + html1.slice(0, 100)));

    // ② session-end：当前开着的会话必须自动重拉完整详情（最终 sent/finishReason）
    const finalSession = { id: 's_sse_1', chatKey: 'group:1', status: 'done', startedAt: 1, endedAt: 2,
      messages: [{ role: 'assistant', content: '让我想想' }],
      sent: [{ type: 'text', text: '最终发言', at: '12:00:01' }],
      usage: { calls: 1 }, rounds: 1, finishReason: 'stop' };
    const origFetch2 = sandbox.fetch;
    sandbox.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sessions/s_sse_1')) return { ok: true, json: async () => finalSession };
      if (u.includes('/api/sessions')) return { ok: true, json: async () => ({ sessions: [finalSession] }) };
      return origFetch2(url);
    };
    fireSse('session-end', { sessionId: 's_sse_1', chatKey: 'group:1', status: 'done' });
    await sleepMs(400);
    sandbox.fetch = origFetch2;
    const html2 = String(detailBox.innerHTML || '');
    const okFinal = html2.includes('最终发言');
    okFinal ? pass++ : fail++;
    console.log('  ' + (okFinal ? 'OK   ' : 'FAIL ') + 'session-end 后详情自动刷出最终 sent（不用手动刷新）' + (okFinal ? '' : ' -> ' + html2.slice(0, 100)));

    // ③ 新 Session 只刷新列表，不能抢占用户当前正在阅读的详情。
    const incoming = { id: 's_sse_2', chatKey: 'group:2', status: 'waiting', startedAt: 3,
      messages: [], sent: [], usage: { calls: 0 }, rounds: 0 };
    sandbox.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sessions')) {
        return { ok: true, json: async () => ({ sessions: [incoming, finalSession] }) };
      }
      if (u.includes('/api/status')) {
        return { ok: true, json: async () => ({ onebot: {}, orchestrator: {}, usage: {}, cost: {} }) };
      }
      return origFetch2(url);
    };
    fireSse('session-start', { sessionId: incoming.id, chatKey: incoming.chatKey, status: 'waiting' });
    await sleepMs(250);
    sandbox.fetch = origFetch2;
    const keptSelection = vm.runInContext('state.currentSessionId', ctx) === 's_sse_1';
    keptSelection ? pass++ : fail++;
    console.log('  ' + (keptSelection ? 'OK   ' : 'FAIL ') + '新 Session 不抢占当前查看窗口');
  } catch (e) {
    fail++; console.log('  FAIL SSE 实时性测试抛错: ' + (e && e.message));
  }

  // ── 批量自定义价格编辑弹窗（2026-09-05 改版：供应商 → 模型 → 官方价）──
  console.log('\n=== 批量自定义价格编辑弹窗 ===');
  try {
    vm.runInContext(`
      state.providers = [
        { id: 'a6api', displayName: 'A6API中转站', models: ['deepseek-v4-flash', 'glm-5.3'], modelNames: {} },
        { id: 'openrouter', displayName: 'OpenRouter', models: ['openai/gpt-5.6-luna'], modelNames: {} }
      ];
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = { 'orphan-model-x': { in: 1, out: 2, cached: 0.1 } };
      state.modelPrices = { prices: [{ id: 'deepseek-v4-flash', in: 1.5, out: 4.5, cached: 0.05 }], current: null };
    `, ctx);
    ctx.openBatchPriceModal();
    const overlay = document.body.children[document.body.children.length - 1];
    const leftHtml = String(overlay.querySelector('#bp-left').innerHTML || '');
    const rightHtml = String(overlay.querySelector('#bp-right').innerHTML || '');
    const okProv = leftHtml.includes('A6API中转站') && leftHtml.includes('OpenRouter');
    okProv ? pass++ : fail++;
    console.log('  ' + (okProv ? 'OK   ' : 'FAIL ') + '左列展示供应商列表' + (okProv ? '' : ' -> ' + leftHtml.slice(0, 120)));
    const okOrphan = leftHtml.includes('已自定义（目录外');
    okOrphan ? pass++ : fail++;
    console.log('  ' + (okOrphan ? 'OK   ' : 'FAIL ') + '目录外已自定义模型归入虚拟供应商');
    const okModel = rightHtml.includes('deepseek-v4-flash');
    okModel ? pass++ : fail++;
    console.log('  ' + (okModel ? 'OK   ' : 'FAIL ') + '右列展示选中供应商的模型');
    const okOff = !rightHtml.includes('官方 输入') && !rightHtml.includes('官方 缓存命中');
    okOff ? pass++ : fail++;
    console.log('  ' + (okOff ? 'OK   ' : 'FAIL ') + '官方价不占列（太挤，改走占位符/悬停）');
    const okPh = rightHtml.includes('placeholder="1.5"') && rightHtml.includes('官方价：输入 1.5 / 输出 4.5');
    okPh ? pass++ : fail++;
    console.log('  ' + (okPh ? 'OK   ' : 'FAIL ') + '官方价仍在占位符与悬停提示里' + (okPh ? '' : ' -> ' + rightHtml.slice(0, 150)));
  } catch (e) {
    fail++; console.log('  FAIL 批量价格弹窗抛错: ' + (e && e.message));
  }

} catch (e) {
  fail++;
  console.log('\n加载 app.js 失败: ' + (e && e.message));
  console.log(e && e.stack && e.stack.split('\n').slice(0, 6).join('\n'));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / passed ' + pass : 'ALL PASSED ' + pass));
process.exit(fail ? 1 : 0);
