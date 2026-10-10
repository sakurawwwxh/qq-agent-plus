// 实际执行 ui/app.js 的所有设置分区渲染函数，捕获运行时错误。
// 目的：像"B 未定义"这类错误，node --check（语法检查）根本查不出来，
// 只有真正跑一遍渲染才会暴露。
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toClassicScript } from './helpers/ui-module-source.mjs';
import { scanDirForMarkdownStars } from './helpers/ui-markdown-stars.mjs';

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
const indexHtml = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
// script 清单的唯一真相源 = index.html（与 ui-smoke / ui-modules 同一口径）
const htmlScriptFiles = () => [...indexHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
// 本用例的沙箱只铺到 app.js 为止（8 个外挂插件要 NodeFilter 等真实 DOM 能力，由 ui-smoke
// 用 happy-dom 覆盖）。拆模块后 app.js 之前多出 core/pages 若干文件，按清单顺序取到 app.js（含）即止。
const htmlFilesUpToApp = () => {
  const all = htmlScriptFiles();
  return all.slice(0, all.indexOf('app.js') + 1);
};
// 源码断言用的"全部前端源码"：拆模块后某段字符串可能已搬去 core/pages，
// 用 app.js 单文件去断言会假红（"这里没有"其实是"搬到别处了"）。按 index.html 顺序全量拼接。
const code = htmlScriptFiles().map((f) => fs.readFileSync(path.join(ROOT, 'ui', f), 'utf8')).join('\n');

// 把一个元素挂到某个父容器下（焦点守卫用例需要 contains 成立）
function makeElIn(parent, id) {
  const el = makeEl(id);
  parent.children.push(el);
  return el;
}

// ── 极简 DOM 桩 ──// ── 极简 DOM 桩 ──
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
    // 滑块（ui/core/nav-pill.js）要往容器第一个位置插自己；侧栏那套要读 data-* 开关。
    // 真浏览器里这两个方法永远在，桩缺了会让整页渲染直接抛（2026-10-08 踩到）
    insertBefore(c) { el.children.unshift(c); return c; },
    remove() {},
    closest: () => null,
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    removeAttribute() {},
    focus() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20 }),
    insertAdjacentHTML() {},
    contains(node) { return this === node || this.children.includes(node); },
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
  createElement: () => {
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
  // 按 index.html 的 script 清单**真实顺序**加载（唯一真相源）。拆模块后清单会变，
  // 在这里写死文件名就会静默缺文件 —— 轻则 ReferenceError，重则少加载一个页面文件而
  // 渲染函数悄悄退化成"未定义"，测试却照绿。
  for (const srcFile of htmlFilesUpToApp()) {
    const raw = fs.readFileSync(path.join(ROOT, 'ui', srcFile), 'utf8');
    // ui/ 是 ES module（浏览器里 type="module"）；沙箱按老语义 = 去掉 import/export 后跑
    // classic script，见 test/helpers/ui-module-source.mjs 的说明。
    const srcCode = toClassicScript(raw, srcFile);
    new vm.Script(srcCode, { filename: `ui/${srcFile}` }).runInContext(ctx);
  }

  // 取出渲染函数并执行
  const sections = [
    'renderSettingsSection', 'renderApiSection', 'renderSearchSection', 'renderAsrSection',
    'renderMemorySettingsSection', 'renderExperimentalSettingsSection',
    'renderDailyMomentsSection', 'renderRemindersSection',
    'renderQzoneInteractionSection', 'renderTimeControlSection',
    'renderPersonaSection', 'renderAllowSection',
    'renderChatSection', 'renderDesktopSection', 'renderOnebotSection',
    'renderPersonaLibrary', 'renderPersonaGrid', 'renderTokenSaverSection',
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
      // 渲染入口改名/删掉就是真回归：以前这里记成 SKIP，既不计 pass 也不计 fail，
      // harness 照样打印 ALL PASSED（2026-10-01 审查）。
      fail++;
      console.log('  FAIL  ' + name + '（渲染入口不存在或未导出）');
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
  vm.runInContext('state.personaEditingSection = 0;', ctx);
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
  vm.runInContext('state.personaEditingSection = 1;', ctx);
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
  const collapsedNow = vm.runInContext('[...state.personaCollapsedSections].join(",")', ctx);
  const stillEditing = vm.runInContext('state.personaEditingSection', ctx) === 1;
  const collapseOk = collapseRoleBox.value.includes('正在编辑、还没保存的正文')
    && collapsedNow.split(',').includes('0') && stillEditing;
  collapseOk ? pass++ : fail++;
  console.log('  ' + (collapseOk ? 'OK   ' : 'FAIL ') + '收起别的小节前先落草稿（编辑中的字不会丢）'
    + (collapseOk ? '' : ` -> 折叠=${collapsedNow} 含草稿=${collapseRoleBox.value.includes('正在编辑、还没保存的正文')} 编辑态=${stillEditing}`));
  vm.runInContext('state.personaEditingSection = -1; state.personaCollapsedSections = new Set();', ctx);
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
  ctx.renderExperimentalSettingsSection(cfg);
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
  // 群游戏的配置与「正在进行的局」在自己的分区（2026-09-29 审查 P2：按
  // EXPERIMENTAL_FEATURE_STANDARD，实验页只留启停与转正动作）；这里钉住两件事：
  // ① 那些控件都在新分区里、勾选态跟着配置；② 实验页只剩状态与开关。
  const ggOn = { ...cfg, groupGame: { ...(cfg.groupGame || {}), enabled: true, allowPrivateInvite: true, allowGamePrivateDm: true, games: ['number-bomb', 'undercover', 'werewolf'] } };
  const ggOff = { ...cfg, groupGame: { ...(cfg.groupGame || {}), enabled: true, allowPrivateInvite: true, allowGamePrivateDm: false, games: ['number-bomb'] } };
  const wolfOnHtml = ctx.renderGroupGameSection(ggOn);
  const wolfOffHtml = ctx.renderGroupGameSection(ggOff);
  {
    const okWolf = /id="cfg-game-werewolf"[^>]*checked/.test(wolfOnHtml)
      && !/id="cfg-game-werewolf"[^>]*checked/.test(wolfOffHtml)
      && /id="cfg-game-privatedm"[^>]*checked/.test(wolfOnHtml)
      && !/id="cfg-game-privatedm"[^>]*checked/.test(wolfOffHtml)
      && /游戏期间私聊豁免/.test(wolfOnHtml)
      && /聊天白名单/.test(wolfOnHtml)
      && /id="cfg-game-discuss"/.test(wolfOnHtml)
      && /白天讨论时长/.test(wolfOnHtml)
      && /投吧/.test(wolfOnHtml)
      && /id="cfg-game-chats-box"/.test(wolfOnHtml)
      && /id="gg-running"/.test(wolfOnHtml)          // 正在进行的局面板
      && /id="gg-refresh-btn"/.test(wolfOnHtml)
      && /正在进行的局/.test(wolfOnHtml);
    okWolf ? pass++ : fail++;
    console.log('  ' + (okWolf ? 'OK   ' : 'FAIL ') + '群游戏分区：狼人杀勾选与「游戏期间私聊豁免」开关随配置（含白名单/加好友提示）');
  }
  {
    // 实验页只该剩：状态一行 + 启停开关 + 指路文案
    const exp = ctx.renderExperimentalSettingsSection(ggOn);
    const okOnly = /id="cfg-game-enabled"[^>]*checked/.test(exp)
      && /id="experiment-groupgame-state"/.test(exp)
      && /设置 → 群游戏/.test(exp)
      && !/id="cfg-game-werewolf"/.test(exp)
      && !/id="cfg-game-privatedm"/.test(exp)
      && !/id="cfg-game-discuss"/.test(exp)
      && !/id="cfg-game-chats-box"/.test(exp)
      && !/id="gg-running"/.test(exp);
    okOnly ? pass++ : fail++;
    console.log('  ' + (okOnly ? 'OK   ' : 'FAIL ') + '实验页的群游戏只留状态与开关（配置与局面板都在「设置 → 群游戏」）');
  }

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
    sticker: { ...cfg.sticker, promptMaxStickers: 24, collectEnabled: false, autoCollect: false, maxCollectPerHour: 5 }
  });
  const openSwitchesOk = chatHtml.includes('id="cfg-proactive"')
    && chatHtml.includes('id="cfg-pro-followup"') && chatHtml.includes('id="cfg-pro-selfwake"')
    && !/id="cfg-pro-followup"[^>]*checked/.test(chatHtml)
    && !/id="cfg-pro-selfwake"[^>]*checked/.test(chatHtml)
    // 清单条数是滑条（用户 2026-10-02 要求"做移动条"）：范围 1~60、细步长 0.1（拖动手感）、
    // 存量值 24 如实回显
    && /<input type="range" id="cfg-sticker-max"[^>]*min="1" max="60" step="0\.1"[^>]*value="24"/.test(chatHtml)
    && /<span class="slider-now" id="cfg-sticker-max-now">24<\/span>/.test(chatHtml)
    && !/<select id="cfg-sticker-max"/.test(chatHtml);
  openSwitchesOk ? pass++ : fail++;
  console.log('  ' + (openSwitchesOk ? 'OK   ' : 'FAIL ') + '设置页：主动开口三个开关 + 表情清单条数滑条');
  // 缺省 / 老配置（字段不存在）按"开"渲染：升级后行为不变；条数默认 10 档
  const defaultHtml = ctx.renderChatSection(cfg);
  const defaultOnOk = /id="cfg-pro-followup"[^>]*checked/.test(defaultHtml)
    && /id="cfg-pro-selfwake"[^>]*checked/.test(defaultHtml)
    && /<input type="range" id="cfg-sticker-max"[^>]*value="10"/.test(defaultHtml);
  defaultOnOk ? pass++ : fail++;
  console.log('  ' + (defaultOnOk ? 'OK   ' : 'FAIL ') + '设置页：缺省开关勾选、清单条数默认 10');
  // 收藏开关（2026-10-02 用户反馈"乱收藏"）：**一个开关**同时管"自动收"与"主动收"
  // （两个名字太像、分开摆会造成误解）；上限默认 10 档；关掉/自定义值如实回显，
  // 手改出的"混合状态"（总闸开、自动关）在界面上显示为关。
  const mixedCollectHtml = ctx.renderChatSection({ ...cfg, sticker: { ...cfg.sticker, collectEnabled: true, autoCollect: false } });
  const collectUiOk = /id="cfg-sticker-collect"/.test(defaultHtml)
    && !/id="cfg-sticker-autocollect"/.test(defaultHtml)
    && /id="cfg-sticker-collect"\s+checked/.test(defaultHtml)
    && /<input type="range" id="cfg-sticker-collect-max"[^>]*value="10"/.test(defaultHtml)
    && !/id="cfg-sticker-collect"\s+checked/.test(chatHtml)
    && /<input type="range" id="cfg-sticker-collect-max"[^>]*value="5"/.test(chatHtml)
    && /<span class="slider-now" id="cfg-sticker-collect-max-now">5<\/span>/.test(chatHtml)
    && !/id="cfg-sticker-collect"\s+checked/.test(mixedCollectHtml);
  collectUiOk ? pass++ : fail++;
  console.log('  ' + (collectUiOk ? 'OK   ' : 'FAIL ')
    + '设置页：收藏开关（一个开关管自动+主动）+ 每小时上限滑条（存量/混合值如实回显）');
  // 存量的超范围值（手改过 config.json 的 500）落到 60 档，不会渲染出 500 这种选项
  const overHtml = ctx.renderChatSection({ ...cfg, sticker: { ...cfg.sticker, promptMaxStickers: 500 } });
  // 断言只看贴纸那个滑条（同一段里发送上限的默认值就是 500，不能全局查 value="500"）
  const overOk = /<input type="range" id="cfg-sticker-max"[^>]*value="60"/.test(overHtml)
    && !/<input type="range" id="cfg-sticker-max"[^>]*value="500"/.test(overHtml);
  overOk ? pass++ : fail++;
  console.log('  ' + (overOk ? 'OK   ' : 'FAIL ') + '设置页：超范围存量值按 60 回显');

  // 手改成非正数（运行时按默认 10 生效）时界面也必须显示 10 —— 否则保存一下就把用户的值改成 1 了
  const zeroHtml = ctx.renderChatSection({ ...cfg, sticker: { ...cfg.sticker, promptMaxStickers: -5 } });
  const zeroOk = /<input type="range" id="cfg-sticker-max"[^>]*value="10"/.test(zeroHtml)
    && !/<input type="range" id="cfg-sticker-max"[^>]*value="-5"/.test(zeroHtml)
    && !/<input type="range" id="cfg-sticker-max"[^>]*value="1"/.test(zeroHtml);
  zeroOk ? pass++ : fail++;
  console.log('  ' + (zeroOk ? 'OK   ' : 'FAIL ') + '设置页：非正数存量值按运行时的 10 回显');

  // 设置 → 语音转文字：独立开关 + 每小时上限是**可以自己填的输入框**（用户 2026-09-26 要求：
  // 从档位下拉改成输入框），存量值要如实回填
  const asrOffHtml = ctx.renderAsrSection({ ...cfg, asr: { enabled: false, maxPerHour: 3 } });
  const asrOffOk = asrOffHtml.includes('id="cfg-asr"') && asrOffHtml.includes('id="cfg-asr-max"')
    && !/id="cfg-asr"[^>]*checked/.test(asrOffHtml)
    && /id="cfg-asr-max"[^>]*value="3"/.test(asrOffHtml)
    && asrOffHtml.includes('type="number" id="cfg-asr-max"')
    && /id="cfg-asr-max"[^>]*max="200"/.test(asrOffHtml)
    // 这一行要顶端对齐：.field-row 默认 end 对齐，左侧多一行 hint 时右边"识别语言"会往上/下错位
    && asrOffHtml.includes('<div class="field-row" style="align-items:start">');
  asrOffOk ? pass++ : fail++;
  if (!asrOffOk) {
    console.log('    DEBUG ' + JSON.stringify({
      有开关: asrOffHtml.includes('id="cfg-asr"'),
      默认没勾: !/id="cfg-asr"[^>]*checked/.test(asrOffHtml),
      回填3: /id="cfg-asr-max"[^>]*value="3"/.test(asrOffHtml),
      数字框: asrOffHtml.includes('type="number" id="cfg-asr-max"'),
      上限200: /id="cfg-asr-max"[^>]*max="200"/.test(asrOffHtml),
      顶端对齐: asrOffHtml.includes('<div class="field-row" style="align-items:start">')
    }));
  }
  console.log('  ' + (asrOffOk ? 'OK   ' : 'FAIL ') + '设置页：语音转文字开关可关、每小时上限自己填（回填存量值、与识别语言对齐）');

  // 模式只有两个：免费本机 Whisper / API Key 托管服务（用户要求）
  const localHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'local' } });
  const installedHtml = ctx.renderAsrSection({
    ...cfg, asr: { ...cfg.asr, provider: 'local', localInstalled: true, localManagedExists: true, localBinResolved: '/x/whisper-cli', localModelResolved: '/x/ggml-small.bin' }
  });
  const apiModeHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' } });
  const volcModeHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'volc', hasApiKey: true } });
  const twoModesOk = (localHtml.match(/<option value="(local|api)"/g) || []).length === 2         // 下拉只有两个选项
    && /<option value="local" selected>/.test(localHtml)
    && /<option value="api" selected>/.test(apiModeHtml)
    // 文案推荐走 API Key 的托管服务（用户要求），本机那支标注"较慢"
    && localHtml.includes('推荐用 API Key 的托管服务')
    && /<option value="api"[^>]*>API Key · 托管服务（推荐/.test(localHtml)
    && /<option value="local"[^>]*>免费 · 本机安装的 Whisper（不联网、不要 Key，较慢）/.test(localHtml)
    && localHtml.includes('推荐优先考虑上面的 API Key 托管服务')
    && apiModeHtml.includes('推荐用这一支')
    && /id="asr-local-mode" style=""/.test(localHtml) && /id="asr-api-mode" style="display:none"/.test(localHtml)
    && /id="asr-local-mode" style="display:none"/.test(apiModeHtml) && /id="asr-api-mode" style="/.test(apiModeHtml);
  twoModesOk ? pass++ : fail++;
  console.log('  ' + (twoModesOk ? 'OK   ' : 'FAIL ') + '设置页：用哪种方式只有两项（免费本机 Whisper / API Key 托管）');

  // 本机支：安装入口 + 完整卸载（已装时）
  const installOk = /id="asr-install-field"/.test(localHtml)
    && /class="btn btn-primary btn-small" id="asr-install-btn"/.test(localHtml)
    && /id="asr-install-btn"[^>]*>安装本机转写（免费）</.test(localHtml)
    && !localHtml.includes('asr-uninstall-btn')
    && /id="asr-install-btn"[^>]*>重新安装 \/ 修复</.test(installedHtml)
    && /type="button">完全卸载（删除模型与程序）</.test(installedHtml)
    && /class="btn btn-small btn-danger" id="asr-uninstall-btn"/.test(installedHtml);
  installOk ? pass++ : fail++;
  console.log('  ' + (installOk ? 'OK   ' : 'FAIL ') + '设置页：本机支有安装入口，已装时显示「完全卸载（删除模型与程序）」');

  // API Key 支：服务预设含火山，模型从服务商官网拉（预设里的模型名会过时）
  const serviceOk = /<option value="volc"/.test(volcModeHtml) && volcModeHtml.includes('火山引擎 · 大模型录音识别')
    && /<option value="siliconflow"/.test(apiModeHtml) && /<option value="groq"/.test(apiModeHtml)
    && /<option value="openai"/.test(apiModeHtml) && /<option value="custom"/.test(apiModeHtml)
    && apiModeHtml.includes('id="asr-fetch-models-btn"') && apiModeHtml.includes('从服务商官网拉')
    && /id="asr-openai-fields" style="align-items:start"/.test(apiModeHtml) // OpenAI 兼容：显示地址与模型（顶端对齐，见下）
    && /id="asr-openai-fields" style="display:none"/.test(volcModeHtml)  // 火山：走自己的协议，不显示
    && apiModeHtml.includes('id="cfg-asr-model-pick"');
  serviceOk ? pass++ : fail++;
  console.log('  ' + (serviceOk ? 'OK   ' : 'FAIL ') + '设置页：服务预设含火山等多家，模型点按钮从官网拉');

  // 四家国内云（讯飞/百度/腾讯/阿里）在服务预设里，且各自只显示它需要的凭据字段
  const tencentHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'tencent' } });
  const iflytekHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'iflytek' } });
  const baiduHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'baidu' } });
  const aliyunHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'aliyun' } });
  const cnOk = apiModeHtml.includes('讯飞语音听写（每日 500 次免费）')
    && apiModeHtml.includes('百度短语音识别（个人 5 万次免费）')
    && apiModeHtml.includes('腾讯云一句话识别（每月 5000 次免费）')
    && apiModeHtml.includes('阿里云百炼')
    // 腾讯只要 SecretId/SecretKey（没有 API Key 这一栏），阿里/百度/讯飞各按需
    && /id="asr-secretid-field" style=""/.test(tencentHtml)
    && /id="asr-secretkey-field" style=""/.test(tencentHtml)
    && /id="asr-key-field" style="display:none"/.test(tencentHtml)
    && /id="asr-appid-field" style="display:none"/.test(tencentHtml)
    && /id="asr-appid-field" style=""/.test(iflytekHtml)
    && /id="asr-key-field" style=""/.test(iflytekHtml)
    && /id="asr-secretkey-field" style=""/.test(iflytekHtml)
    && iflytekHtml.includes('APISecret（讯飞）')
    && /id="asr-key-field" style=""/.test(baiduHtml) && /id="asr-secretkey-field" style=""/.test(baiduHtml)
    && baiduHtml.includes('Secret Key（百度老式鉴权才需要）')
    // 阿里：要地址与模型（有默认值），所以模型行与拉取按钮在。
    // align-items:start 是必须的：.field-row 默认 end（底部对齐），模型格拉出列表后
    // 会把左边的服务地址框一起压下去（用户 2026-09-26 反馈的"选模型时地址框往下移"）。
    && /id="asr-openai-fields" style="align-items:start"/.test(aliyunHtml) && /id="asr-fetch-models-btn"/.test(aliyunHtml)
    // 讯飞/腾讯/百度没有地址与模型
    && /id="asr-openai-fields" style="display:none"/.test(iflytekHtml)
    && /id="asr-openai-fields" style="display:none"/.test(tencentHtml)
    && /id="asr-openai-fields" style="display:none"/.test(baiduHtml);
  cnOk ? pass++ : fail++;
  console.log('  ' + (cnOk ? 'OK   ' : 'FAIL ') + '设置页：四家国内云在预设里，各自只显示需要的凭据字段');

  // 预设反查：阿里这类"既有 provider 又带默认地址"的必须能被认回来，
  // 否则下拉显示"自定义"、保存时 provider 被改写成 openai（2026-09-26 审查的 Critical）
  const roundTripOk = ctx.asrServiceOf('aliyun', 'https://dashscope.aliyuncs.com/compatible-mode/v1') === 'aliyun'
    && ctx.asrServiceOf('tencent', '') === 'tencent'
    && ctx.asrServiceOf('iflytek', '') === 'iflytek'
    && ctx.asrServiceOf('baidu', '') === 'baidu'
    && ctx.asrServiceOf('openai', 'https://api.siliconflow.cn/v1/') === 'siliconflow'
    && ctx.asrServiceOf('openai', 'https://api.groq.com/openai/v1') === 'groq'
    && ctx.asrServiceOf('openai', 'https://my-gateway.example/v1') === 'custom'
    && ctx.asrServiceOf('volc', '') === 'volc'
    && /<option value="aliyun" selected>/.test(aliyunHtml);
  roundTripOk ? pass++ : fail++;
  console.log('  ' + (roundTripOk ? 'OK   ' : 'FAIL ') + '设置页：配置回读时能认出是哪家预设（含阿里/腾讯/讯飞/百度）');

  // 状态以服务端判定为准，且把"换供应商/换地址要重填凭据 / 缺地址模型 / Key 来自环境变量"讲清
  const needKeyHtml = ctx.renderAsrSection({
    ...cfg, asr: { ...cfg.asr, provider: 'openai', configured: false, hasApiKey: true, keyProvider: 'volc', keyUsable: false, baseUrl: '', model: '' }
  });
  const needAddrHtml = ctx.renderAsrSection({
    ...cfg, asr: { ...cfg.asr, provider: 'openai', configured: false, hasApiKey: true, keyProvider: 'openai', keyUsable: true, baseUrl: '', model: '' }
  });
  const envHtml = ctx.renderAsrSection({
    ...cfg, asr: { ...cfg.asr, provider: 'volc', configured: true, hasApiKey: false, keyUsable: true, keySource: 'env' }
  });
  const statusOk = needKeyHtml.includes('重新填一次凭据')
    && needAddrHtml.includes('还缺服务地址或模型')
    && envHtml.includes('ASR_API_KEY') && envHtml.includes('在生效')
    && !needKeyHtml.includes('已配置好') && !needAddrHtml.includes('已配置好');
  statusOk ? pass++ : fail++;
  console.log('  ' + (statusOk ? 'OK   ' : 'FAIL ') + '设置页：状态按服务端判定，并区分换服务/缺地址/环境变量三种情形');

  // 凭据不属于这一家时：输入框必须显示为空（不能是 ****** 让人以为"这家已经能用了"），
  // 并给出"请重新填一次"的提示 —— 后端不会把它发到别家（2026-09-26 审查，跨服务串用已实测）
  const wrongHostHtml = ctx.renderAsrSection({
    ...cfg, asr: {
      ...cfg.asr, provider: 'openai', configured: false, available: false,
      hasApiKey: true, keyProvider: 'openai', keyUsable: false, keyHost: 'api.siliconflow.cn',
      baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo'
    }
  });
  const wrongSecretHtml = ctx.renderAsrSection({
    ...cfg, asr: {
      ...cfg.asr, provider: 'iflytek', configured: false, available: false,
      appId: 'APP1', hasApiKey: true, keyUsable: true, keyProvider: 'iflytek',
      hasSecretKey: true, secretKeyProvider: 'tencent', secretKeyUsable: false
    }
  });
  const staleOk = /id="cfg-asr-key"[^>]*value=""/.test(wrongHostHtml)
    && wrongHostHtml.includes('重新填一次凭据')
    && /id="cfg-asr-secretkey"[^>]*value=""/.test(wrongSecretHtml)
    && wrongSecretHtml.includes('重新填一次凭据');
  staleOk ? pass++ : fail++;
  console.log('  ' + (staleOk ? 'OK   ' : 'FAIL ') + '设置页：换了服务/地址后凭据不再显示为已填，并提示重填');

  // 开关关着时不能说"在生效"
  const disabledHtml = ctx.renderAsrSection({
    ...cfg, asr: { ...cfg.asr, provider: 'volc', enabled: false, configured: true, available: false, hasApiKey: true }
  });
  const availableHtml = ctx.renderAsrSection({
    ...cfg, asr: { ...cfg.asr, provider: 'volc', enabled: true, configured: true, available: true, hasApiKey: true }
  });
  const switchOk = disabledHtml.includes('上面的开关关着，所以不生效')
    && !disabledHtml.includes('在生效</strong>')
    && availableHtml.includes('已配置好，这项在生效');
  switchOk ? pass++ : fail++;
  console.log('  ' + (switchOk ? 'OK   ' : 'FAIL ') + '设置页：开关关着时显示"配置齐但不生效"，打开才说在生效');

  // 缺省那支是 API Key 的托管服务（用户 2026-09-26 要求）：默认开启 + 预置硅基流动 + 12 次/小时
  //  + 写明与搜索解耦；没填 Key 时如实说"这项不会生效"
  const asrSectionHtml = ctx.renderAsrSection(cfg);
  const asrDefaultOk = /id="cfg-asr"[^>]*checked/.test(asrSectionHtml)
    && /<option value="api" selected>/.test(asrSectionHtml)
    && /<option value="siliconflow" selected>/.test(asrSectionHtml)
    && /id="cfg-asr-max"[^>]*value="12"/.test(asrSectionHtml)
    && asrSectionHtml.includes('识别服务与「搜索服务」各自独立')
    && asrSectionHtml.includes('还没有可用的 Key，这项不会生效');
  asrDefaultOk ? pass++ : fail++;
  console.log('  ' + (asrDefaultOk ? 'OK   ' : 'FAIL ') + '设置页：缺省配置指向 API Key 的托管服务（预置硅基流动，12 次/小时）');

  // 没有 Key 时界面必须说清"这项不会生效"
  const noKeyHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'volc', hasApiKey: false, keyUsable: false } });
  const keyedHtml = ctx.renderAsrSection({ ...cfg, asr: { ...cfg.asr, provider: 'volc', hasApiKey: true, keyUsable: true } });
  const asrKeyStateOk = noKeyHtml.includes('还没有可用的 Key，这项不会生效')
    && noKeyHtml.includes('也不会产生任何调用与费用')
    && keyedHtml.includes('已配置好，这项在生效')
    && !keyedHtml.includes('这项不会生效');
  asrKeyStateOk ? pass++ : fail++;
  console.log('  ' + (asrKeyStateOk ? 'OK   ' : 'FAIL ') + '设置页：没配 Key 时明说"不生效、不产生费用"，配了则显示已配置');

  // 复刻音色提示（2026-09-30 用户反馈）：必须写明"资源会自动切、但要开通后付费音色服务"，
  // 否则用户看到 45000030 会以为是自己没买音色槽位。
  const ttsSectionHtml = String(vm.runInContext('renderAsrSection(state.config || {})', ctx) || '');
  const cloneHintOk = ttsSectionHtml.includes('id="tts-clone-hint"')
    && ttsSectionHtml.includes('后付费音色服务')
    && ttsSectionHtml.includes('声音复刻2.0字符版')
    && ttsSectionHtml.includes('seed-icl-2.0')
    && ttsSectionHtml.includes('volcano_icl')
    && ttsSectionHtml.includes('ICL_uranus_')
    && ttsSectionHtml.includes('不用手改');
  cloneHintOk ? pass++ : fail++;
  console.log('  ' + (cloneHintOk ? 'OK   ' : 'FAIL ') + '设置页：复刻音色提示写明资源自动切 + 要开通后付费音色服务');

  // 图片生成（Issue #21）：控件齐全、默认关、闸门默认值在位
  const imgOk = ttsSectionHtml.includes('id="settings-imagegen"')
    && ttsSectionHtml.includes('id="cfg-img-enabled"')
    && !/id="cfg-img-enabled"[^>]*checked/.test(ttsSectionHtml)          // 默认关
    && ttsSectionHtml.includes('id="cfg-img-baseurl"')
    && ttsSectionHtml.includes('id="cfg-img-model"')
    && ttsSectionHtml.includes('id="cfg-img-max"')
    && ttsSectionHtml.includes('id="img-test-btn"')
    && ttsSectionHtml.includes('id="cfg-img-reveal-key-btn"')            // Key 要有「显示」按钮
    && ttsSectionHtml.includes('按张计费');
  imgOk ? pass++ : fail++;
  console.log('  ' + (imgOk ? 'OK   ' : 'FAIL ') + '设置页：图片生成区块齐全（默认关、含闸门、显示按钮与试画按钮）');

  // 「显示」按钮必须是活的（2026-09-30 审查：控件在、却没有任何绑定，点了没反应）。
  // 与 tts 那把同款：点一下要向后端专用端点取明文（/api/imagegen/key），不是读已脱敏的 state.config。
  {
    vm.runInContext("state.settingsSection = 'asr';", ctx);
    const imgCfg = { ...cfg, imageGen: { ...cfg.imageGen, enabled: true, model: 'gpt-image-1', hasApiKey: true } };
    vm.runInContext(`state.config = ${JSON.stringify(imgCfg)};`, ctx);
    ctx.bindSettingsEvents(imgCfg);   // 重新绑一次（每次 renderSettings 都会绑）
    const revealBtn = document.querySelector('#cfg-img-reveal-key-btn');
    const handlers = revealBtn?._listeners?.click || [];
    let fetched = null;
    const before = sandbox.fetch;
    sandbox.fetch = async (url) => {
      fetched = String(url);
      return { ok: true, status: 200, json: async () => ({ ok: true, apiKey: 'img-secret' }), text: async () => '' };
    };
    try { for (const h of handlers) await h({ currentTarget: revealBtn }); } catch { /* 看结果 */ }
    sandbox.fetch = before;
    const keyNode = document.querySelector('#cfg-img-key');
    const revealOk = handlers.length > 0 && /\/api\/imagegen\/key/.test(String(fetched))
      && keyNode.value === 'img-secret' && keyNode.type === 'text';
    revealOk ? pass++ : fail++;
    console.log('  ' + (revealOk ? 'OK   ' : 'FAIL ') + '设置页：图片生成的「显示」按钮真的向后端要明文（不是死按钮）'
      + (revealOk ? '' : ` -> handlers=${handlers.length} fetched=${fetched} value=${keyNode?.value} type=${keyNode?.type}`));
  }

  // OneBot 令牌与「正在输入」的密码框（2026-10-01 用户要求"把填了密钥的地方都加上控制"）：
  //  · 令牌这种**已保存**的密钥：显示要取回明文，隐藏要回到**空串**（不是 ****** ——
  //    服务端不认这个哨兵，真提交会把令牌改成字面量，见 ui/pages/settings-save.js）；
  //  · 控制台 Token 那三格是"正在输入"的：只做本地明文开关（点一下 type 变 text）。
  {
    ctx.bindSettingsEvents(cfg);
    const toggleBtn = document.querySelector('#cfg-obtoken-toggle');
    const handlers = toggleBtn?._listeners?.click || [];
    const input = document.querySelector('#cfg-obtoken');
    const before = sandbox.fetch;
    let fetched = null;
    sandbox.fetch = async (url) => {
      fetched = String(url);
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'ws-token-secret' }), text: async () => '' };
    };
    try { for (const h of handlers) await h({ currentTarget: toggleBtn }); } catch { /* 看结果 */ }
    const shown = input.value === 'ws-token-secret' && input.type === 'text' && /field=ws/.test(String(fetched));
    try { for (const h of handlers) await h({ currentTarget: toggleBtn }); } catch { /* 看结果 */ }
    sandbox.fetch = before;
    const hiddenToEmpty = input.value === '' && input.type === 'password';
    const onebotOk = handlers.length > 0 && shown && hiddenToEmpty;
    onebotOk ? pass++ : fail++;
    console.log('  ' + (onebotOk ? 'OK   ' : 'FAIL ') + '设置页：OneBot 令牌的「显示/隐藏」取明文、隐藏回到空串'
      + (onebotOk ? '' : ` -> handlers=${handlers.length} fetched=${fetched} value=${JSON.stringify(input.value)} type=${input.type}`));

    const peekBtn = document.querySelector('#cfg-console-token-new-peek');
    const peekHandlers = peekBtn?._listeners?.click || [];
    for (const h of peekHandlers) h({ currentTarget: peekBtn });
    const peekInput = document.querySelector('#cfg-console-token-new');
    const afterFirst = { type: peekInput.type, label: peekBtn.textContent };
    const peekOk = peekHandlers.length > 0 && peekInput.type === 'text' && peekBtn.textContent === '隐藏';
    for (const h of peekHandlers) h({ currentTarget: peekBtn });
    const peekBack = peekInput.type === 'password' && peekBtn.textContent === '显示';
    (peekOk && peekBack) ? pass++ : fail++;
    console.log('  ' + ((peekOk && peekBack) ? 'OK   ' : 'FAIL ') + '设置页：控制台 Token 输入框的「显示/隐藏」只切明文（本地开关）'
      + ((peekOk && peekBack) ? '' : ` -> handlers=${peekHandlers.length} afterFirst=${JSON.stringify(afterFirst)} type=${peekInput.type} label=${peekBtn.textContent}`));
  }

  // 语音转写 / 图片生成的密钥「显示」要带上**表单里当前选中**的槽位/主机（2026-10-02 全量审查）：
  // 刚切换预设、还没保存时，不带参数的端点按"已保存配置"回显 —— 会把上一家的明文显示在新服务名下，
  // 用户点一下「显示」再保存就把那家 Key 绑给了新服务。
  {
    ctx.bindSettingsEvents(cfg);
    const cases = [
      {
        btn: '#cfg-asr-key-toggle',
        input: '#cfg-asr-key',
        prep: () => {
          document.querySelector('#cfg-asr-service').value = 'groq';
          document.querySelector('#cfg-asr-baseurl').value = 'https://api.groq.com/openai/v1';
        },
        want: /slot=openai%7Capi\.groq\.com/
      },
      {
        btn: '#cfg-img-reveal-key-btn',
        input: '#cfg-img-key',
        prep: () => { document.querySelector('#cfg-img-baseurl').value = 'https://img.example.com/v1'; },
        want: /host=img\.example\.com/
      }
    ];
    let slotOk = true;
    const slotNotes = [];
    for (const item of cases) {
      const input = document.querySelector(item.input);
      const btn = document.querySelector(item.btn);
      const handlers = [...(btn?._listeners?.click || [])];
      input.value = '******';
      input.type = 'password';
      // 按钮状态可能是前面用例留下的「隐藏」态：不重置的话这次点的是隐藏分支、根本不发请求
      if (btn) { btn.textContent = '显示'; btn.dataset.revealed = '0'; }
      item.prep();
      const before = sandbox.fetch;
      let fetched = '';
      sandbox.fetch = async (url) => {
        fetched = String(url);
        return { ok: true, status: 200, json: async () => ({ ok: true, apiKey: 'x' }), text: async () => '' };
      };
      try { for (const h of handlers) await h({ currentTarget: btn }); } catch { /* 看结果 */ }
      sandbox.fetch = before;
      if (!handlers.length || !item.want.test(fetched)) { slotOk = false; slotNotes.push(`${item.btn} → ${fetched}`); }
    }
    slotOk ? pass++ : fail++;
    console.log('  ' + (slotOk ? 'OK   ' : 'FAIL ') + '设置页：密钥「显示」带上表单里的目标槽位/主机（不按已保存配置回显别家的）'
      + (slotOk ? '' : ` -> ${slotNotes.join('；')}`));
  }

  // 切换「语音转文字」服务预设只可就地更新，**不许整块重画**（2026-10-03 全量审查）：
  // 整块重画会把同分区里用户还没保存的输入（TTS 音色、图片生成模型…）统统退回后端上次保存的值
  // —— 与 2026-10-02「屏蔽名单搜索框只能输一个字」同族。
  {
    ctx.bindSettingsEvents(cfg);
    const ttsVoice = document.querySelector('#cfg-tts-voice');
    const imgModel = document.querySelector('#cfg-img-model');
    ttsVoice.value = 'unsaved-voice';
    imgModel.value = 'unsaved-image-model';
    const svc = document.querySelector('#cfg-asr-service');
    svc.value = 'groq';
    for (const h of [...(svc?._listeners?.change || [])]) h();
    const kept = ttsVoice.value === 'unsaved-voice'
      && imgModel.value === 'unsaved-image-model'
      && document.querySelector('#cfg-asr-key')?.value === '';
    if (kept) { pass++; console.log('  OK    切换语音识别服务预设不会清空同分区其它未保存的输入'); }
    else {
      fail++;
      console.log(`  FAIL  切换识别服务预设吞掉了未保存输入（voice=${ttsVoice.value} imgModel=${imgModel.value}）`);
    }
  }

  // 生图每小时上限：保存口径必须与运行期 imageGenMaxPerHour 一致（非正数/坏值按默认 6）。
  // 以前前端是 clampInt 式的 Math.max(1, …)：手填 -5 会存成"每小时 1 张"，比默认更严格。
  {
    const normalize = ctx.normalizeImageGenMax || sandbox.normalizeImageGenMax;
    const cases = [[-5, 6], [0, 6], ['x', 6], [999, 100], [3.7, 4], [8, 8]];
    const bad = typeof normalize !== 'function'
      ? 'normalizeImageGenMax 没导出'
      : cases.filter(([input, want]) => normalize(input) !== want).map(([i, w]) => `${i}→${normalize(i)}（期望 ${w}）`).join('，');
    if (!bad) { pass++; console.log('  OK    生图每小时上限的收口与运行期同口径（非正数按 6，不是夹到 1）'); }
    else { fail++; console.log(`  FAIL  生图每小时上限的收口与运行期不一致：${bad}`); }
  }

  // 后台重拉时若焦点落在区域内某个输入框里，这一轮重写要让路（setHtmlIfChanged 的焦点守卫）
  {
    const setter = ctx.setHtmlIfChanged || sandbox.setHtmlIfChanged;
    // ⚠️ 先判存在再调用：原先在跑完所有 setter(...) 之后才判 typeof —— 一旦它被删/改名，
    // 会抛 TypeError 被外层 catch 吞成一条"抛错"，后面上百条断言直接不执行、诊断信息也丢了
    //（2026-10-05 全审）。
    if (typeof setter !== 'function') {
      fail++; console.log('  FAIL  setHtmlIfChanged 没导出（后面的断言无法执行）');
    } else {
      const box = document.querySelector('#edit-guard-box');
      const field = makeElIn(box, 'gi-1');
      field.tagName = 'INPUT';
      field.value = 'typed-by-user';
      box.children.push(field);
      setter(box, '<b>v1</b>');
      const before = String(box.innerHTML);
      const prevActive = document.activeElement;
      document.activeElement = field;
      const wrote = setter(box, '<b>v2</b>');
      document.activeElement = prevActive;
      const blocked = wrote === false && String(box.innerHTML) === before && field.value === 'typed-by-user';
      if (blocked) { pass++; console.log('  OK    后台重拉不会覆盖正在输入的那一块（焦点在输入框里时让路）'); }
      else { fail++; console.log(`  FAIL  焦点守卫没起作用（wrote=${wrote}）`); }
    }
  }

  // 源码钉子：切语音服务预设的回调里不许出现 renderSettings() —— 垫片表达不了"输入框被换掉"
  // （上面那条行为断言在这个垫片下抓不住这一类回归，静态钉子才抓得住）
  {
    const src = fs.readFileSync(new URL('../ui/pages/settings-bind.js', import.meta.url), 'utf8');
    const start = src.indexOf("serviceSel.addEventListener('change'");
    const end = start >= 0 ? src.indexOf('syncAsrFields();', start) : -1;
    // ⚠️ 锚点自己失效时必须报红：indexOf 返回 -1 时 `slice(-1, end)` 会切出空串，
    // 「没找到 renderSettings()」于是恒真 —— 把被测的回调整段删掉反而变绿
    //（2026-10-05 全审：钉子的锚点退化）+ 反方向 `end = -1` 会切到文件尾造成假红。
    if (start < 0 || end <= start) {
      fail++; console.log('  FAIL  找不到语音服务切换回调（钉子锚点失效，先修测试再谈回归）');
    } else {
      // 先剥掉 // 注释：这段代码里正好有一句"这里**不能** renderSettings()"，不剥会自己误判
      const code = src.slice(start, end).replace(/\/\/[^\n]*/g, '');
      const reRender = /renderSettings\(\)/.test(code);
      if (reRender) { fail++; console.log('  FAIL  切换语音识别服务预设又调了 renderSettings()（会清空同分区未保存输入）'); }
      else { pass++; console.log('  OK    切换语音识别服务预设的回调里没有整块重画（源码钉子）'); }
    }
  }

  // 语音合成 Key：并入统一开关后的三件事（2026-10-01 审查的两条 low）  // 语音合成 Key：并入统一开关后的三件事（2026-10-01 审查的两条 low）
  //  · 「显示」向 /api/tts/key 要明文时要带上当前选中的那家（它按服务分家存 Key）；
  //  · 用户手输了一半就点「显示」：**不许**用回读值盖掉他没保存的输入，也不该白发请求；
  //  · 「隐藏」不许把用户刚输入（或刚粘上）的新 Key 盖成 ****** —— 服务端把 ****** 当
  //    "保持不变"，盖下去等于静默丢弃（旧的双按钮实现就是这么干的）。
  {
    ctx.bindSettingsEvents(cfg);
    const ttsBtn = document.querySelector('#tts-reveal-key-btn');
    const ttsHandlers = ttsBtn?._listeners?.click || [];
    const ttsInput = document.querySelector('#cfg-tts-key');
    const svcStub = document.querySelector('#cfg-tts-service');
    if (svcStub) svcStub.value = 'volc';
    const before = sandbox.fetch;
    let fetched = null;
    sandbox.fetch = async (url) => {
      fetched = String(url);
      return { ok: true, status: 200, json: async () => ({ ok: true, apiKey: 'tts-secret' }), text: async () => '' };
    };
    // ① 显示 → 明文 + 带 service
    ttsInput.value = '';
    try { for (const h of ttsHandlers) await h({ currentTarget: ttsBtn }); } catch { /* 看结果 */ }
    const shown = ttsInput.value === 'tts-secret' && ttsInput.type === 'text' && /\/api\/tts\/key\?service=volc/.test(String(fetched));
    const labelShown = ttsBtn.textContent === '隐藏';
    // ② 隐藏（没改过）→ 回到掩码
    try { for (const h of ttsHandlers) await h({ currentTarget: ttsBtn }); } catch { /* 看结果 */ }
    const masked = ttsInput.value === '******' && ttsInput.type === 'password';
    // ③ 用户手输未保存 → 先显示：保留他输的、且不发请求
    fetched = null;
    ttsInput.value = 'typed-new-key';
    try { for (const h of ttsHandlers) await h({ currentTarget: ttsBtn }); } catch { /* 看结果 */ }
    const keptOnShow = ttsInput.value === 'typed-new-key' && fetched === null;
    // ④ 再隐藏：新 Key 仍在（不许盖成 ******）
    try { for (const h of ttsHandlers) await h({ currentTarget: ttsBtn }); } catch { /* 看结果 */ }
    const keptOnHide = ttsInput.value === 'typed-new-key' && ttsInput.type === 'password';
    // ⑤ 先显示（这时框里是服务端回读的明文），用户就地改成新 Key，再隐藏：仍要保住新值
    ttsInput.value = '';
    try { for (const h of ttsHandlers) await h({ currentTarget: ttsBtn }); } catch { /* 看结果 */ }
    const revealedAgain = ttsInput.value === 'tts-secret';
    ttsInput.value = 'edited-while-shown';
    try { for (const h of ttsHandlers) await h({ currentTarget: ttsBtn }); } catch { /* 看结果 */ }
    sandbox.fetch = before;
    const keptEdit = ttsInput.value === 'edited-while-shown';
    const ttsOk = ttsHandlers.length > 0 && shown && labelShown && masked && keptOnShow && keptOnHide && revealedAgain && keptEdit;
    ttsOk ? pass++ : fail++;
    console.log('  ' + (ttsOk ? 'OK   ' : 'FAIL ') + '设置页：语音合成 Key 走统一开关（带 service 取明文、手输的新值不被覆盖/不被掩码吞掉）'
      + (ttsOk ? '' : ` -> handlers=${ttsHandlers.length} shown=${shown} label=${labelShown} masked=${masked} keptOnShow=${keptOnShow} keptOnHide=${keptOnHide} revealedAgain=${revealedAgain} keptEdit=${keptEdit} fetched=${fetched} value=${JSON.stringify(ttsInput.value)}`));
  }

  // 回读失败时不许"先翻状态再失败"（2026-10-01 审查）：原先「显示」是先把按钮与输入框切成
  // 明文态、再去 await 取明文。端点 401 / 网络失败时按钮已经写着「隐藏」、框里却还是掩码，
  // 用户会以为"显示成功但没值"；再点一下走的是隐藏分支，更莫名其妙。
  {
    // 不重新 bindSettingsEvents：那会重建设置页的 DOM 垫片、拿到的是另一批节点，
    // 而复用上一段的按钮/输入框（同一个桩）才打得中同一份状态。
    const btn = document.querySelector('#tts-reveal-key-btn');
    const handlers = btn?._listeners?.click || [];
    const input = document.querySelector('#cfg-tts-key');
    const note = document.querySelector('#tts-key-hint');
    const before = sandbox.fetch;
    sandbox.fetch = async () => { throw new Error('401 未授权'); };
    input.value = '******';
    input.type = 'password';
    const assigned = input.value;
    const sameNode = input === document.querySelector('#cfg-tts-key');
    btn.textContent = '显示';
    btn.dataset.revealed = '0';
    if (note) note.textContent = '';
    try { for (const h of handlers) await h({ currentTarget: btn }); } catch { /* 看结果 */ }
    sandbox.fetch = before;
    const untouched = input.value === '******' && input.type === 'password'
      && btn.textContent === '显示' && btn.dataset.revealed === '0';
    const noteText = String(document.querySelector('#tts-key-hint')?.textContent || '');
    const failOk = handlers.length > 0 && untouched && /读取失败/.test(noteText);
    failOk ? pass++ : fail++;
    console.log('  ' + (failOk ? 'OK   ' : 'FAIL ') + '设置页：取明文失败时按钮/输入框状态不变，只把原因写进提示'
      + (failOk ? '' : ` -> handlers=${handlers.length} assigned=${JSON.stringify(assigned)} sameNode=${sameNode} value=${JSON.stringify(input.value)} type=${input.type} label=${btn.textContent} revealed=${btn.dataset.revealed} note=${JSON.stringify(noteText)}`));
  }

  // 非 TTS 的开关也要有提示位（2026-10-01 第六轮审查）：KEY_TOGGLES 里 15 个开关原先只有 TTS
  // 配了 note，其余 14 个取明文失败时点一下毫无反应 —— 状态不翻是对的，但用户看不到任何原因。
  // 现在没配 note 的会现挂一个 `.key-toggle-note`（垫片没有真实父子关系，退化成 #<input>-note）。
  {
    ctx.bindSettingsEvents(cfg);
    const btn = document.querySelector('#cfg-apikey-toggle');
    const handlers = btn?._listeners?.click || [];
    const input = document.querySelector('#cfg-apikey');
    const before = sandbox.fetch;
    const readNote = () => String(document.querySelector('#cfg-apikey-note')?.textContent || '');
    // ① 回读失败 → 提示里要有原因
    sandbox.fetch = async () => { throw new Error('401 未授权'); };
    input.value = '******';
    input.type = 'password';
    btn.textContent = '显示';
    btn.dataset.revealed = '0';
    try { for (const h of handlers) await h({ currentTarget: btn }); } catch { /* 看结果 */ }
    const failNote = readNote();
    const untouched = input.value === '******' && btn.textContent === '显示';
    // ② 回读成功但这一家没存过 Key → 也要有说明（不能静默显示空值）
    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ apiKey: '' }), text: async () => '' });
    btn.textContent = '显示';
    btn.dataset.revealed = '0';
    input.value = '******';
    try { for (const h of handlers) await h({ currentTarget: btn }); } catch { /* 看结果 */ }
    const emptyNote = readNote();
    sandbox.fetch = before;
    const noteOk = handlers.length > 0 && untouched && /读取失败/.test(failNote) && /没有保存过/.test(emptyNote);
    noteOk ? pass++ : fail++;
    console.log('  ' + (noteOk ? 'OK   ' : 'FAIL ') + '设置页：没配 note 的密钥开关也有提示位（失败写原因、空值写说明）'
      + (noteOk ? '' : ` -> handlers=${handlers.length} untouched=${untouched} failNote=${JSON.stringify(failNote)} emptyNote=${JSON.stringify(emptyNote)}`));
  }

  // 分段守卫：bindSettingsEvents 现在由四段拼成（保存与分区 / 列表与分组 / 模型与密钥 / 人设与视觉）。
  // 调度器少调一段，只会让"那一段的控件变成死控件"，页面照样能打开 —— 所以逐段点名一个**无条件绑定**
  // 的代表控件，断言它确实被绑上了。这条用例是分段重构的守卫（2026-10-01 变异验证时发现：
  // 删掉"模型与密钥"那段的调用，原有用例全绿，只有这条会红）。
  {
    ctx.bindSettingsEvents(cfg);
    const segs = [
      ['保存与分区', '#save-cfg-btn'],
      ['列表与分组', '#change-console-token-btn'],
      ['模型与密钥', '#test-provider-btn'],
      ['人设与视觉', '#toggle-persona-edit']
    ];
    const missing = segs.filter(([, sel]) => !(document.querySelector(sel)?._listeners?.click || []).length).map(([label, sel]) => `${label}(${sel})`);
    missing.length === 0 ? pass++ : fail++;
    console.log('  ' + (missing.length ? 'FAIL ' : 'OK   ') + '设置页：四段绑定各自的代表控件都绑上了（分段漏调会在这里红）'
      + (missing.length ? ` -> 没绑上：${missing.join(', ')}` : ''));
  }

  // 界面 → 配置的映射（审查抓到过：保存时 apiKeyProvider 读了个已删掉的元素，
  // 于是新填的 Key 被记成"上一家的"，轻则该用不用、重则把旧 Key 发给别家）
  const saveCases = [
    { name: 'API Key + Groq', values: { '#cfg-asr-mode': 'api', '#cfg-asr-service': 'groq', '#cfg-asr-baseurl': 'https://api.groq.com/openai/v1', '#cfg-asr-model': 'whisper-large-v3-turbo', '#cfg-asr-key': 'typed-key' },
      expect: { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', apiKey: 'typed-key', apiKeyProvider: 'openai', apiKeyHost: 'api.groq.com' } },
    { name: 'API Key + 火山', values: { '#cfg-asr-mode': 'api', '#cfg-asr-service': 'volc', '#cfg-asr-baseurl': '', '#cfg-asr-model': '', '#cfg-asr-key': 'volc-key' },
      expect: { provider: 'volc', apiKey: 'volc-key', apiKeyProvider: 'volc' } },
    { name: '免费本机', values: { '#cfg-asr-mode': 'local', '#cfg-asr-service': 'siliconflow', '#cfg-asr-key': '' },
      expect: { provider: 'local' } },
    { name: 'API Key + 腾讯云', values: { '#cfg-asr-mode': 'api', '#cfg-asr-service': 'tencent', '#cfg-asr-secretid': 'AKID-x', '#cfg-asr-secretkey': 'SK-y', '#cfg-asr-key': '', '#cfg-asr-baseurl': '', '#cfg-asr-model': '' },
      expect: { provider: 'tencent', secretId: 'AKID-x', secretKey: 'SK-y', secretIdProvider: 'tencent', secretKeyProvider: 'tencent' } },
    { name: 'API Key + 讯飞', values: { '#cfg-asr-mode': 'api', '#cfg-asr-service': 'iflytek', '#cfg-asr-appid': 'APP1', '#cfg-asr-key': 'KEY1', '#cfg-asr-secretkey': 'SEC1' },
      expect: { provider: 'iflytek', appId: 'APP1', secretKey: 'SEC1', secretKeyProvider: 'iflytek', apiKeyProvider: 'iflytek' } }
  ];
  let mapOk = true;
  const mapNotes = [];
  for (const item of saveCases) {
    vm.runInContext("state.settingsSection = 'asr';", ctx);
    // 用 document.querySelector 取桩（store 里没有的会惰性创建），与 harness 其它用例一致
    for (const [sel, value] of Object.entries(item.values)) document.querySelector(sel).value = value;
    document.querySelector('#cfg-asr').checked = true;
    let posted = null;
    const fetchBefore = sandbox.fetch;
    sandbox.fetch = async (url, options) => {
      if (String(url).includes('/api/config') && options?.method === 'POST') {
        posted = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ config: { ...(cfg), asr: posted.asr } }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    try { await ctx.saveConfig({ quiet: true }); } catch (error) { mapNotes.push(`${item.name}: saveConfig 抛错 ${error?.message}`); }
    sandbox.fetch = fetchBefore;
    for (const [key, want] of Object.entries(item.expect)) {
      const got = posted?.asr?.[key];
      if (got !== want) { mapOk = false; mapNotes.push(`${item.name}.${key}=${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`); }
    }
    if (posted?.asr?.apiKey === '******') { mapOk = false; mapNotes.push(`${item.name}: 掩码被当成新 Key 存了`); }
  }
  mapOk ? pass++ : fail++;
  console.log('  ' + (mapOk ? 'OK   ' : 'FAIL ') + '设置页：保存时模式/服务正确映射成 provider/baseUrl/model/Key 归属'
    + (mapOk ? '' : ` -> ${mapNotes.join('；')}`));

  // 切换服务预设时凭据按"这家存过没有"自动填回（2026-10-02 用户要求"切预设时 Key 跟着切换"）：
  // 存过 → 掩码（保存时服务端取回这家存过的那把）；没存过 → 留空等填；都不再一律清空 + 报"要重填"。
  {
    let switchOk = true;
    const switchNotes = [];
    const view = {
      ...cfg,
      asr: {
        ...cfg.asr, provider: 'openai', baseUrl: 'https://a.example.com/v1', model: 'm-a',
        hasApiKey: true, keyUsable: true,
        keySlots: { 'openai|api.siliconflow.cn': ['apiKey'], tencent: ['secretId', 'secretKey'] }
      }
    };
    vm.runInContext("state.settingsSection = 'asr';", ctx);
    vm.runInContext(`state.config = ${JSON.stringify(view)};`, ctx);
    // ⚠️ 垫片里同一个元素会累积多次 bindSettingsEvents 留下的监听器（前面的用例也 bind 过）——
    // 全量触发会让"后跑的那份旧闭包"看到已更新的草稿、把 serviceChanged 重算成 false 并覆盖。
    // 所以只触发**本次 bind 新加的那几个**（按 bind 前的数量切一刀）。
    const svc = document.querySelector('#cfg-asr-service');
    const boundBefore = [...(svc?._listeners?.change || [])].length;
    ctx.bindSettingsEvents(view);            // 每次 renderSettings 都会绑；这里显式绑一次
    const handlers = [...(document.querySelector('#cfg-asr-service')?._listeners?.change || [])].slice(boundBefore);
    const read = (sel) => document.querySelector(sel)?.value;
    const asrDraft = (key) => vm.runInContext(`state.config.asr.${key}`, ctx);
    const fire = () => { for (const h of handlers) h(); };

    svc.value = 'siliconflow';               // ① 切到存过 apiKey 的那家（槽位 openai|api.siliconflow.cn）
    fire();
    if (read('#cfg-asr-key') !== '******') { switchOk = false; switchNotes.push(`存过的那家应显示掩码，实际 ${JSON.stringify(read('#cfg-asr-key'))}`); }
    if (asrDraft('credentialStale') !== false) { switchOk = false; switchNotes.push('存过的那家不该再报"要重填"'); }

    svc.value = 'tencent';                   // ② 切到存过 SecretId/SecretKey 的那家
    fire();
    if (read('#cfg-asr-secretid') !== '******') { switchOk = false; switchNotes.push(`腾讯的 SecretId 应显示掩码，实际 ${JSON.stringify(read('#cfg-asr-secretid'))}`); }
    if (read('#cfg-asr-secretkey') !== '******') { switchOk = false; switchNotes.push('腾讯的 SecretKey 应显示掩码'); }
    if (read('#cfg-asr-key') !== '') { switchOk = false; switchNotes.push('腾讯不用 apiKey，那格该留空'); }

    svc.value = 'groq';                      // ③ 切到没存过的那家（槽位 openai|api.groq.com）
    fire();
    for (const sel of ['#cfg-asr-key', '#cfg-asr-secretid', '#cfg-asr-secretkey']) {
      if (read(sel) !== '') { switchOk = false; switchNotes.push(`${sel} 没存过应留空，实际 ${JSON.stringify(read(sel))}`); }
    }
    if (asrDraft('hasApiKey') !== false) { switchOk = false; switchNotes.push(`没存过的那家不该显示成"已填"（实际 ${JSON.stringify(asrDraft('hasApiKey'))}）`); }
    if (asrDraft('credentialStale') !== true) { switchOk = false; switchNotes.push(`没存过的那家要提示"请重新填一次凭据"（实际 ${JSON.stringify(asrDraft('credentialStale'))} / provider=${JSON.stringify(asrDraft('provider'))} baseUrl=${JSON.stringify(asrDraft('baseUrl'))} slots=${JSON.stringify(Object.keys(asrDraft('keySlots') || {}))} svc=${JSON.stringify(svc.value)}）`); }
    switchOk ? pass++ : fail++;
    console.log('  ' + (switchOk ? 'OK   ' : 'FAIL ') + '设置页：切换语音服务预设时凭据按"这家存过没有"填回（存过掩码 / 没存过留空）'
      + (switchOk ? '' : ` -> ${switchNotes.join('；')}`));
  }

  // 每小时上限：清空 = 保持原值（不能变成 1，那是"清一下就变严格"的坑）
  {
    vm.runInContext("state.settingsSection = 'asr';", ctx);
    vm.runInContext(`state.config = ${JSON.stringify({ ...cfg, asr: { ...cfg.asr, provider: 'volc', maxPerHour: 20 } })};`, ctx);
    document.querySelector('#cfg-asr-mode').value = 'api';
    document.querySelector('#cfg-asr-service').value = 'volc';
    document.querySelector('#cfg-asr-max').value = '';
    let posted = null;
    const before = sandbox.fetch;
    sandbox.fetch = async (url, options) => {
      if (String(url).includes('/api/config') && options?.method === 'POST') {
        posted = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ config: { ...cfg, asr: posted.asr } }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    try { await ctx.saveConfig({ quiet: true }); } catch { /* 看 patch */ }
    sandbox.fetch = before;
    const emptyOk = posted?.asr?.maxPerHour === 20;
    emptyOk ? pass++ : fail++;
    console.log('  ' + (emptyOk ? 'OK   ' : 'FAIL ') + '设置页：每小时上限清空时保持原值（不会变成 1）'
      + (emptyOk ? '' : ` -> ${posted?.asr?.maxPerHour}`));
  }

  // 记忆门槛：控制台「记忆整理」里能自己设"发现新人的最少发言条数 / 单次最多发现几人"，
  // 保存要落到 memory.*（聊天多却零印象的人进不进记忆，就取决于这两项）
  {
    let posted = null;
    vm.runInContext("state.settingsSection = 'memory';", ctx);
    vm.runInContext(`state.config = ${JSON.stringify({ ...cfg, memory: { ...(cfg.memory || {}), discoverMinMessages: 20, discoverMaxMembers: 3 } })};`, ctx);
    document.querySelector('#cfg-mem-discover-min').value = '8';
    document.querySelector('#cfg-mem-discover-max').value = '5';
    const before = sandbox.fetch;
    sandbox.fetch = async (url, options) => {
      if (String(url).includes('/api/config') && options?.method === 'POST') {
        posted = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ config: { ...cfg, memory: posted.memory } }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    try { await ctx.saveConfig({ quiet: true }); } catch { /* 看 patch */ }
    sandbox.fetch = before;
    const memOk = posted?.memory?.discoverMinMessages === 8 && posted?.memory?.discoverMaxMembers === 5
      && code.includes('id="cfg-mem-discover-min"') && code.includes('id="cfg-mem-discover-max"');
    memOk ? pass++ : fail++;
    console.log('  ' + (memOk ? 'OK   ' : 'FAIL ') + '设置页：记忆整理可设"发现新人的最少发言条数/单次最多发现几人"并落到 memory.*'
      + (memOk ? '' : ` -> ${JSON.stringify(posted?.memory)}`));
  }

  // OneBot 心跳策略与补课窗口（Issue #22）：两个控件都要在，保存要落到 onebot.*；
  // 补课窗口**留空 = 不改**（清空输入框不该悄悄变成"一律不回复"），只有填了数字才提交。
  {
    const onebotRender = ctx.renderOnebotSection({
      ...cfg,
      onebot: { ...cfg.onebot, wsHeartbeat: 'off', catchupReplyWindowMs: 45 * 60 * 1000 }
    });
    const controlsOk = onebotRender.includes('id="cfg-wsheartbeat"')
      && onebotRender.includes('id="cfg-catchup-window"')
      && onebotRender.includes('value="off" selected')
      && onebotRender.includes('value="45"');
    let posted = null;
    vm.runInContext("state.settingsSection = 'onebot';", ctx);
    vm.runInContext(`state.config = ${JSON.stringify({ ...cfg, onebot: { ...cfg.onebot, wsHeartbeat: 'auto', catchupReplyWindowMs: 30 * 60 * 1000 } })};`, ctx);
    document.querySelector('#cfg-wsheartbeat').value = 'off';
    document.querySelector('#cfg-catchup-window').value = '45';
    const before = sandbox.fetch;
    sandbox.fetch = async (url, options) => {
      if (String(url).includes('/api/config') && options?.method === 'POST') {
        posted = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ config: { ...cfg, onebot: posted.onebot } }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    try { await ctx.saveConfig({ quiet: true }); } catch { /* 看 patch */ }
    const saved = { ...posted?.onebot };
    // 留空 = 不改
    document.querySelector('#cfg-catchup-window').value = '';
    posted = null;
    try { await ctx.saveConfig({ quiet: true }); } catch { /* 看 patch */ }
    sandbox.fetch = before;
    const ok = controlsOk
      && saved.wsHeartbeat === 'off' && saved.catchupReplyWindowMs === 45 * 60000
      && posted?.onebot && !('catchupReplyWindowMs' in posted.onebot);
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '设置页：OneBot 心跳策略/补课窗口可设，清空窗口不改动原值'
      + (ok ? '' : ` -> controls=${controlsOk} saved=${JSON.stringify(saved)} empty=${JSON.stringify(posted?.onebot)}`));
  }

  // 门槛两端都要收口：手输 9999 不能存进去（会把"发现新人"事实上永久关掉，或一次建出上百条印象）
  {
    let posted = null;
    const outs = [];
    const cases = [
      { min: '9999', max: '999', want: [500, 20] },
      { min: '0', max: '-3', want: [20, 3] },
      { min: '8.6', max: '4.4', want: [9, 4] }
    ];
    for (const item of cases) {
      vm.runInContext("state.settingsSection = 'memory';", ctx);
      vm.runInContext(`state.config = ${JSON.stringify({ ...cfg, memory: { ...(cfg.memory || {}), discoverMinMessages: 20, discoverMaxMembers: 3 } })};`, ctx);
      document.querySelector('#cfg-mem-discover-min').value = item.min;
      document.querySelector('#cfg-mem-discover-max').value = item.max;
      const before = sandbox.fetch;
      sandbox.fetch = async (url, options) => {
        if (String(url).includes('/api/config') && options?.method === 'POST') {
          posted = JSON.parse(options.body);
          return { ok: true, status: 200, json: async () => ({ config: { ...cfg, memory: posted.memory } }), text: async () => '' };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      };
      try { await ctx.saveConfig({ quiet: true }); } catch { /* 看 patch */ }
      sandbox.fetch = before;
      const got = [posted?.memory?.discoverMinMessages, posted?.memory?.discoverMaxMembers];
      if (got[0] !== item.want[0] || got[1] !== item.want[1]) outs.push(`${item.min}/${item.max} -> ${JSON.stringify(got)}（期望 ${JSON.stringify(item.want)}）`);
    }
    const clampOk = outs.length === 0;
    clampOk ? pass++ : fail++;
    console.log('  ' + (clampOk ? 'OK   ' : 'FAIL ') + '设置页：记忆门槛两端收口（1–500 / 1–20，清空回默认）'
      + (clampOk ? '' : ` -> ${outs.join('；')}`));
  }

  // 每小时上限的收口口径要与显示/后端一致：非正数按 12、超上限夹到 200（不是夹到 1）
  {
    const cases = [
      { input: '-5', want: 12, label: '负数按 12（不是 1）' },
      { input: '0', want: 12, label: '0 按 12' },
      { input: '999', want: 200, label: '超上限夹到 200' },
      { input: '3.7', want: 4, label: '小数四舍五入' }
    ];
    let clampOk = true;
    const notes = [];
    for (const item of cases) {
      vm.runInContext("state.settingsSection = 'asr';", ctx);
      vm.runInContext(`state.config = ${JSON.stringify({ ...cfg, asr: { ...cfg.asr, provider: 'volc', maxPerHour: 12 } })};`, ctx);
      document.querySelector('#cfg-asr-mode').value = 'api';
      document.querySelector('#cfg-asr-service').value = 'volc';
      document.querySelector('#cfg-asr-max').value = item.input;
      document.querySelector('#cfg-asr').checked = true;
      let posted = null;
      const before = sandbox.fetch;
      sandbox.fetch = async (url, options) => {
        if (String(url).includes('/api/config') && options?.method === 'POST') {
          posted = JSON.parse(options.body);
          return { ok: true, status: 200, json: async () => ({ config: { ...cfg, asr: posted.asr } }), text: async () => '' };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      };
      try { await ctx.saveConfig({ quiet: true }); } catch { /* 看 patch */ }
      sandbox.fetch = before;
      if (posted?.asr?.maxPerHour !== item.want) { clampOk = false; notes.push(`${item.label}: 存成 ${posted?.asr?.maxPerHour}（期望 ${item.want}）`); }
    }
    clampOk ? pass++ : fail++;
    console.log('  ' + (clampOk ? 'OK   ' : 'FAIL ') + '设置页：每小时上限的收口与后端口径一致（非正数按 12）'
      + (clampOk ? '' : ` -> ${notes.join('；')}`));
  }

  // 服务端说"这把 Key 不是给这家的"（换了地址）时保存：不能把它重新登记成当前这家的 Key。
  // 桩配置按服务端的真实形状来：/api/config 的脱敏会把 apiKey/apiKeyProvider/apiKeyHost 这些
  // 字段整个删掉（名字命中 apikey/secret 模式），只留 hasXxx 标记 —— 界面手里并没有这些值。
  const stubAsr = { ...cfg.asr }; delete stubAsr.apiKey; delete stubAsr.apiKeyProvider; delete stubAsr.apiKeyHost;
  {
    vm.runInContext("state.settingsSection = 'asr';", ctx);
    vm.runInContext(`state.config = ${JSON.stringify({
      ...cfg,
      asr: {
        ...stubAsr, provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo',
        hasApiKey: true, keyProvider: 'openai', keyUsable: false, keyHost: 'api.siliconflow.cn'
      }
    })};`, ctx);
    document.querySelector('#cfg-asr-mode').value = 'api';
    document.querySelector('#cfg-asr-service').value = 'groq';
    document.querySelector('#cfg-asr-key').value = '';       // 输入框是空的（不再显示 ******）
    document.querySelector('#cfg-asr').checked = true;
    let posted2 = null;
    const fetchBefore2 = sandbox.fetch;
    sandbox.fetch = async (url, options) => {
      if (String(url).includes('/api/config') && options?.method === 'POST') {
        posted2 = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ config: { ...(cfg), asr: posted2.asr } }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    try { await ctx.saveConfig({ quiet: true }); } catch { /* 断言看 patch */ }
    sandbox.fetch = fetchBefore2;
    const noRepin = !posted2?.asr?.apiKey                    // 不能把明文 Key 带上（留空 = 保持不变）
      && (posted2?.asr?.apiKeyHost === undefined || posted2?.asr?.apiKeyHost === 'api.siliconflow.cn');
    noRepin ? pass++ : fail++;
    console.log('  ' + (noRepin ? 'OK   ' : 'FAIL ') + '设置页：换地址后保存不会把旧 Key 重新登记成新地址的'
      + (noRepin ? '' : ` -> apiKey=${posted2?.asr?.apiKey} host=${posted2?.asr?.apiKeyHost}`));
  }

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

  // 静态护栏（2026-10-02 复审 P2）：包裹/守卫这类"只有读代码才看得见"的约定，行为用例只
  // 覆盖标记生效后的分支 —— 未来把包裹或守卫删掉，行为用例仍然全绿。这里把源码形态钉死：
  // ① 每个保存点都被 withAssetWrite 包裹；② 删除在途标记覆盖全部类别（身份/记忆的回声走
  //    identity-pilot-update，不能退回只标 stickers/slang）；③ 资产/身份回声监听器带着守卫。
  const featuresSrc = fs.readFileSync(path.join(ROOT, 'ui', 'pages', 'features.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  const wrapCount = (featuresSrc.match(/withAssetWrite\(async/g) || []).length;
  const finishCount = (featuresSrc.match(/await finishAssetMutation\(/g) || []).length;
  const guardHit = (name) => {
    const at = appSrc.indexOf(`addEventListener('${name}'`);
    return at >= 0 && appSrc.slice(at, at + 900).includes('assetWriteInFlight');
  };
  const guardPins = wrapCount >= 5 && wrapCount === finishCount
    && featuresSrc.includes("const inFlight = { kind, id: String(entry.id ?? entry.userId ?? '') };")
    && featuresSrc.includes('state.assetDeleteInFlight = inFlight;')
    && featuresSrc.includes('if (state.assetDeleteInFlight === inFlight) state.assetDeleteInFlight = null;')
    && guardHit('asset-update') && guardHit('identity-pilot-update');
  guardPins ? pass++ : fail++;
  console.log('  ' + (guardPins ? 'OK   ' : 'FAIL ')
    + `写入/删除在途守卫的源码约定保持（保存点包裹 ${wrapCount}/${finishCount}）`);

  // 滑条填充色不能靠 background transition 动画（2026-10-02 用户反馈"一卡一卡"）：
  // 线性渐变之间无法插值，浏览器会在过渡结束才整段切换 —— 拖动时填充追不上滑块、
  // 看起来一格一格跳。钉住 .tier-slider 基础块里没有 background 过渡，
  // 且读数 span 有 .slider-now（等宽数字，拖动时文字宽度不跳）。
  const cssSrc = fs.readFileSync(path.join(ROOT, 'ui', 'style.css'), 'utf8');
  // 先剥掉注释再查：注释里会同时出现 background / transition 两个词，不剥会误报
  const tierSliderBlock = (/\.tier-slider\s*\{([\s\S]*?)\}/.exec(cssSrc)?.[1] || '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const sliderCssPin = tierSliderBlock.length > 0
    && !/transition\s*:[^;]*background/.test(tierSliderBlock)
    && /\.slider-now\s*\{/.test(cssSrc);
  sliderCssPin ? pass++ : fail++;
  console.log('  ' + (sliderCssPin ? 'OK   ' : 'FAIL ')
    + '滑条填充不做 background 过渡（渐变无法插值，拖动会一格一格跳）');

  // 滑条填充端点要对齐球心：calc(半球宽 + 比例 × (100% - 球宽))。纯百分比在低值时会露出
  // "球和条没连上"的缝（2026-10-02 用户实测 10/60 差约 6px）。三个滑条都必须走这个算法。
  const bindSrc = fs.readFileSync(path.join(ROOT, 'ui', 'pages', 'settings-bind.js'), 'utf8');
  const fillPosUses = (bindSrc.match(/sliderFillPos\(/g) || []).length;
  const fillPin = /function sliderFillPos\(/.test(bindSrc)
    && /100% - \$\{SLIDER_THUMB_PX\}px/.test(bindSrc)
    && fillPosUses >= 4;   // 定义 1 处 + 统一/分群/两个收藏滑条各 1 处调用
  fillPin ? pass++ : fail++;
  console.log('  ' + (fillPin ? 'OK   ' : 'FAIL ')
    + `滑条填充按球心对齐（calc 共 ${fillPosUses} 处，低值不再露缝）`);

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

  // 删除成功后不得清空资产状态再整页重拉 —— 那会把页面塌成"加载中…"、把滚动位置
  // 顶回顶部，删一张图就要重新划半天（2026-10-02 用户反馈）。
  vm.runInContext(
    'if (!state.assetOverview) state.assetOverview = { generatedAt: "test" };'
    + 'window.__scrollCalls = []; window.scrollY = 4242;'
    + 'window.scrollTo = (x, y) => { window.__scrollCalls.push(y); };', ctx);
  const pendingScroll = ctx.deleteAsset('stickers', { id: 'sticker-1', desc: '测试表情' });
  await answerLatestConfirmation(true);
  await pendingScroll;
  const overviewKept = vm.runInContext('state.assetOverview != null', ctx);
  overviewKept ? pass++ : fail++;
  console.log('  ' + (overviewKept ? 'OK   ' : 'FAIL ')
    + '删除资产后概览状态保留（不再清空整页重拉）');
  const restoredY = vm.runInContext('window.__scrollCalls[window.__scrollCalls.length - 1]', ctx);
  const scrollRestored = restoredY === 4242;
  scrollRestored ? pass++ : fail++;
  console.log('  ' + (scrollRestored ? 'OK   ' : 'FAIL ')
    + '删除资产后滚动位置还原（回到删除前的 4242）');

  // 传入了卡片节点时直接移除该节点（缩略图不重闪、网格不重渲染），不再退回整页重渲染
  let cardRemoved = false;
  const pendingCard = ctx.deleteAsset('stickers', { id: 'sticker-1', desc: '测试表情' },
    { remove: () => { cardRemoved = true; } });
  await answerLatestConfirmation(true);
  await pendingCard;
  cardRemoved ? pass++ : fail++;
  console.log('  ' + (cardRemoved ? 'OK   ' : 'FAIL ')
    + '传入卡片节点时直接摘除节点（不整页重渲染）');

  // 摘除守卫：条目已不在本地列表时（并发删除 / 中途刷新过）不再减计数 ——
  // 防与 SSE 路径双重扣减（2026-10-02 复审）。
  vm.runInContext('state.assetOverview = { stickers: { total: 5 } }; state.assetDetail = { entries: [{ id: "other-1" }] };', ctx);
  const pendingGuard = ctx.deleteAsset('stickers', { id: 'ghost-1' }, { remove: () => {} });
  await answerLatestConfirmation(true);
  await pendingGuard;
  const noDoubleDec = vm.runInContext('state.assetOverview.stickers.total === 5', ctx);
  noDoubleDec ? pass++ : fail++;
  console.log('  ' + (noDoubleDec ? 'OK   ' : 'FAIL ')
    + '条目不在本地列表时不再减计数（防双重扣减）');

  // SSE 广播的 delete 事件必须就地过滤（幂等）：自己的删除本地已处理过，SSE 再来一条
  // 同样的 delete 不能把状态清空重拉 —— 那是"整页刷新"的另一半根因（2026-10-02）。
  ctx.connectSSE();
  vm.runInContext('state.tab = "assets"; state.assetDetail = { entries: [{ id: "sticker-1" }, { id: "sticker-2" }] };', ctx);
  for (const fn of sseRegistry['asset-update'] || []) {
    await fn({ data: JSON.stringify({ kind: 'stickers', action: 'delete', id: 'sticker-1' }) });
  }
  const sseState = vm.runInContext(
    '({ overview: !!state.assetOverview, ids: state.assetDetail.entries.map((e) => e.id).join(",") })', ctx);
  const sseOk = sseState.overview && sseState.ids === 'sticker-2';
  sseOk ? pass++ : fail++;
  console.log('  ' + (sseOk ? 'OK   ' : 'FAIL ')
    + `SSE delete 事件就地过滤（概览保留=${sseState.overview}，剩余=${sseState.ids || '空'}，不整页重拉）`);
  for (const fn of sseRegistry['asset-update'] || []) {
    await fn({ data: JSON.stringify({ kind: 'stickers', action: 'delete', id: 'sticker-1' }) });
  }
  // 空值保护：旧行为会把 assetDetail 清成 null，这里要让断言明确变红而不是让整个
  // 测试进程崩溃（崩了反而看不清是哪条行为被改坏）。
  const sseIdempotent = vm.runInContext(
    '!state.assetDetail || (state.assetDetail.entries.map((e) => e.id).join(",") === "sticker-2" && !!state.assetOverview)', ctx);
  sseIdempotent ? pass++ : fail++;
  console.log('  ' + (sseIdempotent ? 'OK   ' : 'FAIL ')
    + 'SSE delete 重复派发幂等（自己的删除不会被二次处理）');

  // SSE 先于 DELETE 响应到达的竞态：自己正在删除的条目，SSE 事件必须被在途守卫跳过
  // （否则本地摘除前就整格重渲染 + 概览计数减两次 ——「等好久才消失」，2026-10-02 实测）。
  vm.runInContext(
    'state.assetDeleteInFlight = { kind: "stickers", id: "sticker-9" };'
    + 'state.assetDetail = { entries: [{ id: "sticker-9" }] };'
    + 'state.assetOverview = { stickers: { total: 10 } };', ctx);
  for (const fn of sseRegistry['asset-update'] || []) {
    await fn({ data: JSON.stringify({ kind: 'stickers', action: 'delete', id: 'sticker-9' }) });
  }
  const raceOk = vm.runInContext(
    'state.assetOverview.stickers.total === 10 && state.assetDetail.entries.length === 1', ctx);
  raceOk ? pass++ : fail++;
  console.log('  ' + (raceOk ? 'OK   ' : 'FAIL ')
    + 'SSE delete 撞上在途删除被跳过（不提前重渲染、不重复减计数）');
  // 清掉在途标记后，同一事件应正常就地摘除（别人的删除同步路径仍然有效）
  vm.runInContext('state.assetDeleteInFlight = null;', ctx);
  for (const fn of sseRegistry['asset-update'] || []) {
    await fn({ data: JSON.stringify({ kind: 'stickers', action: 'delete', id: 'sticker-9' }) });
  }
  const remoteOk = vm.runInContext(
    'state.assetOverview.stickers.total === 9 && state.assetDetail.entries.length === 0', ctx);
  remoteOk ? pass++ : fail++;
  console.log('  ' + (remoteOk ? 'OK   ' : 'FAIL ')
    + '清掉在途标记后同一事件正常就地摘除（别人的删除仍然同步）');

  // 别人的黑话删除：条目就地摘除的同时概览计数也要减一（2026-10-02 复审：原先只减 stickers，
  // 黑话列表少一条而汇总卡的数字还挂着旧的）
  vm.runInContext(
    'state.tab = "assets"; state.assetDetail = { entries: [{ id: "slang-1" }, { id: "slang-2" }] };'
    + 'state.assetOverview = { slang: { total: 7 } };', ctx);
  for (const fn of sseRegistry['asset-update'] || []) {
    await fn({ data: JSON.stringify({ kind: 'slang', action: 'delete', id: 'slang-1' }) });
  }
  const slangSync = vm.runInContext(
    'state.assetOverview.slang.total === 6 && state.assetDetail.entries.length === 1', ctx);
  slangSync ? pass++ : fail++;
  console.log('  ' + (slangSync ? 'OK   ' : 'FAIL ')
    + 'SSE 黑话删除就地过滤并同步概览计数（汇总卡不留旧数字）');

  // 本地写入在途（编辑/新增保存）时，asset-update 回声一律跳过 —— 防"保存后双重重渲染"
  vm.runInContext(
    'state.tab = "assets"; state.assetWriteInFlight = 1;'
    + 'state.assetDetail = { entries: [{ id: "sticker-7" }] };'
    + 'state.assetOverview = { stickers: { total: 3 } };', ctx);
  for (const fn of sseRegistry['asset-update'] || []) {
    await fn({ data: JSON.stringify({ kind: 'stickers', action: 'update', id: 'sticker-7' }) });
  }
  const writeSkip = vm.runInContext(
    '(state.assetOverview && state.assetOverview.stickers && state.assetOverview.stickers.total === 3)'
    + ' && Array.isArray(state.assetDetail && state.assetDetail.entries)'
    + ' && state.assetDetail.entries.length === 1', ctx);
  writeSkip ? pass++ : fail++;
  console.log('  ' + (writeSkip ? 'OK   ' : 'FAIL ')
    + '本地写入在途时 asset-update 回声被跳过（防保存后双重重渲染）');
  vm.runInContext('state.assetWriteInFlight = 0;', ctx);

  // 身份/记忆的保存与删除在途时，identity-pilot-update 回声同样必须被跳过 —— 服务端
  // /api/assets/identities 写库、/api/assets/memory 经 refreshIdentityAfterAssetMutation
  // 都会广播该事件；不挡的话 finishAssetMutation / 删除收尾之前先被回声整页重拉一次，
  // 保存/删除后页面闪两下（2026-10-02 复审 P1：五个保存点里身份、记忆两处曾被穿透）。
  vm.runInContext(
    'const __origLoadIdentityPage = loadIdentityFeaturePage;'
    + 'globalThis.__identityReloads = 0;'
    + 'loadIdentityFeaturePage = () => { globalThis.__identityReloads += 1; return Promise.resolve(); };'
    + 'state.tab = "identity"; state.assetDeleteInFlight = null;', ctx);
  // ① 保存在途 → 跳过
  vm.runInContext('state.assetWriteInFlight = 1;', ctx);
  for (const fn of sseRegistry['identity-pilot-update'] || []) await fn({ data: '{}' });
  const identityWriteSkip = vm.runInContext('globalThis.__identityReloads === 0', ctx);
  identityWriteSkip ? pass++ : fail++;
  console.log('  ' + (identityWriteSkip ? 'OK   ' : 'FAIL ')
    + '身份/记忆保存在途时 identity-pilot-update 回声被跳过（防保存后双重重拉）');
  // ② 身份/记忆删除在途 → 同样跳过（删除收尾自己会重拉）
  vm.runInContext(
    'state.assetWriteInFlight = 0; state.assetDeleteInFlight = { kind: "identities", id: "u-1" };', ctx);
  for (const fn of sseRegistry['identity-pilot-update'] || []) await fn({ data: '{}' });
  const identityDeleteSkip = vm.runInContext('globalThis.__identityReloads === 0', ctx);
  identityDeleteSkip ? pass++ : fail++;
  console.log('  ' + (identityDeleteSkip ? 'OK   ' : 'FAIL ')
    + '身份/记忆删除在途时 identity-pilot-update 回声被跳过（防删除后双重重拉）');
  // ③ 清掉在途标记后，同一事件正常触发重拉（后台/别处的身份变更仍然同步）
  vm.runInContext('state.assetDeleteInFlight = null;', ctx);
  for (const fn of sseRegistry['identity-pilot-update'] || []) await fn({ data: '{}' });
  const identityEchoApplied = vm.runInContext('globalThis.__identityReloads >= 1', ctx);
  identityEchoApplied ? pass++ : fail++;
  console.log('  ' + (identityEchoApplied ? 'OK   ' : 'FAIL ')
    + '清掉在途标记后 identity-pilot-update 正常触发重拉（后台变更仍然同步）');
  vm.runInContext('loadIdentityFeaturePage = __origLoadIdentityPage; state.tab = "assets";', ctx);

  // withAssetWrite 用计数而非布尔（2026-10-02 复审 P2）：两次保存重叠时，先完成的一次
  // 不能把后一次的在途窗口提前清掉 —— 否则后一次的回声漏进来，双重重拉复发。
  const refcount = await vm.runInContext(
    '(async () => {'
    + ' state.assetWriteInFlight = 0;'
    + ' let release;'
    + ' const gate = new Promise((resolve) => { release = resolve; });'
    + ' const first = withAssetWrite(async () => { await gate; });'
    + ' const second = withAssetWrite(async () => {});'
    + ' await second;'
    + ' const duringFirst = state.assetWriteInFlight;'
    + ' release();'
    + ' await first;'
    + ' return { duringFirst, after: state.assetWriteInFlight };'
    + '})()', ctx);
  const refcountOk = refcount.duringFirst === 1 && refcount.after === 0;
  refcountOk ? pass++ : fail++;
  console.log('  ' + (refcountOk ? 'OK   ' : 'FAIL ')
    + 'withAssetWrite 计数语义（先完成的一次不提前关闭另一次的在途窗口）');

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

  // 更新检查说明要跟着增量刷新走（2026-10-01 审查）：控制中枢的结构只建一次，
  // 说明文字原先只在首次建模板时写进 DOM，之后 SSE/轮询推来新结论也不会更新。
  // 这里刻意**不**重置 __hubBuilt —— 走的就是 updateControlHubFields 那条增量路径
  // （重置了就变成重建模板，这条用例也就测不到东西了）。
  const firstNote = String(controlBox.querySelector('[data-hub-update-check]')?.textContent || '');
  vm.runInContext(`state.autoUpdateStatus = ${JSON.stringify({
    installed: true,
    enabled: true,
    busy: false,
    status: 'no-update',
    lastCheckAt: Date.now(),
    updateNotice: { checkedAt: Date.now(), available: false, reason: 'no-release', version: '' }
  })};`, ctx);
  ctx.renderControlHub({ services: [] });
  const secondNote = String(controlBox.querySelector('[data-hub-update-check]')?.textContent || '');
  const updateNoteSyncedOk =
    !firstNote.includes('仓库尚未发布')
    && secondNote.includes('仓库尚未发布新的 Release');
  if (updateNoteSyncedOk) {
    pass++;
    console.log('  OK    更新检查说明随增量刷新更新（不是只在首次建模板时写一次）');
  } else {
    fail++;
    console.log(`  FAIL  更新检查说明没跟着刷新（首次「${firstNote.slice(0, 20)}」→ 之后「${secondNote.slice(0, 20)}」）`);
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

          // 搜索卡的**副行**也要被填（2026-10-01 第五轮审查：这里原先只断言主数字，
          // 副行写死在模板里也能全绿）。夹具是 searchCount=46 且 toolCounts 只有 web_search=39
          // → 应当说"只做了联网搜索（没抓网页）"；把判据里的 searched 改成 fetched 这条必红。
          const subTxt = String(usageBox.querySelector('[data-field="search-sub"]')?.textContent || '');
          const subOk = subTxt.includes('只做了联网搜索') && subTxt.includes('没抓网页');
          subOk ? pass++ : fail++;
          console.log('  ' + (subOk ? 'OK   ' : 'FAIL ') + '搜索卡副行按工具明细拆开  副行=' + JSON.stringify(subTxt));

          // token 两张卡的副行也要断言（2026-10-01 第六轮审查：prompt-sub / rate-sub 此前 0 断言，
          // 副行写死或串错字段都能全绿）。夹具 promptTokens=120000 / completionTokens=34000 /
          // cachedTokens=80000 / cacheHitRate=0.666 → 主数字与副行都得对上。
          const tok = (n) => (Number(n) || 0).toLocaleString('zh-CN');
          const q = (f) => String(usageBox.querySelector(`[data-field="${f}"]`)?.textContent || '');
          const tokenOk = q('prompt') === tok(120000) && q('prompt-sub') === `输出 ${tok(34000)}`
            && q('rate') === '66.6%' && q('rate-sub') === `命中 ${tok(80000)} / 输入 ${tok(120000)}`;
          tokenOk ? pass++ : fail++;
          console.log('  ' + (tokenOk ? 'OK   ' : 'FAIL ') + 'token 两卡的副行带对数字  输入=' + JSON.stringify(q('prompt-sub'))
            + ' 缓存=' + JSON.stringify(q('rate-sub')) + ' 主数字=' + JSON.stringify(q('prompt')) + '/' + JSON.stringify(q('rate')));

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

          // 缓存路径的 range 校验：**两个方向都要测**，而且不能先把缓存清掉。
          // 旧版是 `state.usageLastData = null` 之后断言"renderUsagePage 被调过" —— 那只证明
          // force 刷新会渲染，把 usage.js 的 `range === range` 校验删掉照样全绿
          //（2026-10-05 全审：断言恒真）。这里改成看"同步段"（缓存在 await 之前决定）：
          //   ① 同 range → 同步段就该画一版（缓存命中）；② 换 range → 同步段一次都不该画。
          let earlyRenders = 0;
          const origPage = ctx.renderUsagePage || sandbox.renderUsagePage;
          ctx.renderUsagePage = sandbox.renderUsagePage = (...a) => { earlyRenders += 1; return origPage(...a); };
          vm.runInContext("state.tab = 'usage'; state.usageRange = '7';", ctx);
          vm.runInContext("state.usageLastData = { range: '7', stats: state.usageStats || {}, st: {}, prices: {} };", ctx);
          const sameRangeLoad = loadUsage({ force: true });
          const sameRangeEarly = earlyRenders;
          await sameRangeLoad;

          earlyRenders = 0;
          vm.runInContext("state.usageRange = 'today';", ctx);
          const staleRangeLoad = loadUsage({ force: true });
          const staleRangeEarly = earlyRenders;
          await staleRangeLoad;
          ctx.renderUsagePage = sandbox.renderUsagePage = origPage;
          vm.runInContext("state.usageRange = '7';", ctx);

          const okSame = sameRangeEarly === 1;
          okSame ? pass++ : fail++;
          console.log('  ' + (okSame ? 'OK   ' : 'FAIL ') + '同 range 的旧数据会被立即画出来（正向对照）');
          const okStale = staleRangeEarly === 0;
          okStale ? pass++ : fail++;
          console.log('  ' + (okStale ? 'OK   ' : 'FAIL ') + '切换 range 不误用旧区间数据（缓存必须被 range 校验挡住）');
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
      state.lastDetailFp = null;
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

  // ── UI 预设表与后端 MODEL_SERVICES 同步 ──
  // MODEL_SERVICES_UI 是后端表的手工副本：单边改了 hosts/levels/canDisable 会让档位条展示错档
  // （2026-09-28 审查）。这里逐家比对，改表漏同步直接红。
  {
    const { MODEL_SERVICES } = await import('../src/core/provider-presets.js');
    const uiTable = vm.runInContext(
      'MODEL_SERVICES_UI.map((s) => ({ id: s.id, hosts: s.hosts || [], levels: s.levels || [], canDisable: s.canDisable }))',
      ctx
    );
    const backend = new Map(MODEL_SERVICES.map((s) => [s.id, {
      hosts: s.hosts || [],
      levels: (s.thinking && s.thinking.uiLevels) || [],
      canDisable: s.thinking ? s.thinking.canDisable : null
    }]));
    const mismatch = uiTable.filter((u) => {
      const b = backend.get(u.id);
      if (!b) return true;
      return JSON.stringify([...u.hosts].sort()) !== JSON.stringify([...b.hosts].sort())
        || JSON.stringify(u.levels) !== JSON.stringify(b.levels)
        || u.canDisable !== b.canDisable;
    });
    const okSync = uiTable.length === backend.size && mismatch.length === 0;
    okSync ? pass++ : fail++;
    console.log('  ' + (okSync ? 'OK   ' : 'FAIL ') + 'UI 预设表与后端 MODEL_SERVICES 一致'
      + (okSync ? '' : ' -> ' + JSON.stringify(mismatch)));
  }

  // ── 保存分支回归（2026-09-28 审查 P1）：控件在哪个页面，patch 就得在哪一段构造 ——
  //    曾经把 tts / groupGame 的保存块放进 moments 分支，等于在看得见控件的页面上点保存什么都不会存。
  {
    const posts = [];
    sandbox.fetch = async (path, opts = {}) => {
      if (String(path).includes('/api/config') && String(opts.method || '').toUpperCase() === 'POST') {
        try { posts.push(JSON.parse(opts.body || '{}')); } catch { /* 忽略 */ }
      }
      const cfgNow = JSON.parse(vm.runInContext('JSON.stringify(state.config || {})', ctx));
      return { ok: true, status: 200, json: async () => ({ ok: true, config: cfgNow }), text: async () => '{}' };
    };
    // 每个页面允许写出的键：asr 页同时管 tts 与 imageGen（都是"语音/生成"这类按量计费项）；
    // 其余页各自一个。多写 = 越界（读不到 DOM 会写成空值/清空配置）。
    const cases = [
      ['asr', ['tts', 'imageGen']],
      ['experiments', ['groupGame']],
      ['groupGame', ['groupGame']],
      ['moments', ['groupDigest']],
      ['reminders', ['reminders']],
      // 闲聊页（chat）是"控件最多的那页"：新加的收藏三件套就走这一段构造，
      // 列全它写出的键，顺手把"贴纸键从 chat 段写出去"钉住。
      ['chat', ['wakeDelayMinMs', 'wakeDelayMaxMs', 'wakeDelayMs', 'drainDelayMs', 'maxConcurrentRuns',
        'conversation', 'send', 'proactive', 'sticker', 'store']]
    ];
    const allKeys = [...new Set(cases.flatMap(([, keys]) => keys))];
    const results = [];
    for (const [sec, keys] of cases) {
      vm.runInContext(`state.settingsSection = '${sec}';`, ctx);
      posts.length = 0;
      await vm.runInContext('saveConfig({ quiet: true })', ctx);
      const body = posts.length ? posts[posts.length - 1] : {};
      const has = keys.every((k) => Object.prototype.hasOwnProperty.call(body, k));
      // 越界也要查：在 A 页保存不该带上 B 页的键（因为它们读不到 DOM，会写成空值/清空配置）
      const leaked = allKeys.filter((k) => !keys.includes(k) && Object.prototype.hasOwnProperty.call(body, k));
      results.push([sec, keys.join('+'), has, leaked.join('/'), Object.keys(body).slice(0, 6).join(',')]);
    }
    const okBranch = results.every(([, , ok, leaked]) => ok && !leaked);
    okBranch ? pass++ : fail++;
    console.log('  ' + (okBranch ? 'OK   ' : 'FAIL ')
      + '保存分支：asr→tts+imageGen / experiments→groupGame / moments→groupDigest / chat→10 键'
      + (okBranch ? '' : ' -> ' + JSON.stringify(results)));
  }

  // 收藏开关（2026-10-02 用户反馈）：一个开关管两个键 —— 关掉时 collectEnabled 与 autoCollect
  // 一起写 false（否则"总闸关了还在往 QQ 收藏里收"那个洞会从界面重开）；勾上时一起 true。
  {
    const posts = [];
    sandbox.fetch = async (path, opts = {}) => {
      if (String(path).includes('/api/config') && String(opts.method || '').toUpperCase() === 'POST') {
        try { posts.push(JSON.parse(opts.body || '{}')); } catch { /* 忽略 */ }
      }
      const cfgNow = JSON.parse(vm.runInContext('JSON.stringify(state.config || {})', ctx));
      return { ok: true, status: 200, json: async () => ({ ok: true, config: cfgNow }), text: async () => '{}' };
    };
    vm.runInContext(
      'state.settingsSection = "chat";'
      + 'document.querySelector("#cfg-sticker-collect").checked = false;'
      + 'document.querySelector("#cfg-sticker-collect-max").value = "5";', ctx);
    await vm.runInContext('saveConfig({ quiet: true })', ctx);
    let sk = (posts.length ? posts[posts.length - 1] : {}).sticker || {};
    const collectOffOk = sk.collectEnabled === false && sk.autoCollect === false && sk.maxCollectPerHour === 5;
    vm.runInContext('document.querySelector("#cfg-sticker-collect").checked = true;', ctx);
    await vm.runInContext('saveConfig({ quiet: true })', ctx);
    sk = (posts.length ? posts[posts.length - 1] : {}).sticker || {};
    const collectOnOk = sk.collectEnabled === true && sk.autoCollect === true;
    // 控件无值/缺失时的兜底：回退到已保存的值（滑条正常不会为空，这里钉的是兜底分支）
    vm.runInContext(
      'state.config.sticker = { ...(state.config.sticker || {}), maxCollectPerHour: 7 };'
      + 'document.querySelector("#cfg-sticker-collect-max").value = "";', ctx);
    await vm.runInContext('saveConfig({ quiet: true })', ctx);
    sk = (posts.length ? posts[posts.length - 1] : {}).sticker || {};
    const collectClearOk = sk.maxCollectPerHour === 7;
    const collectSaveOk = collectOffOk && collectOnOk && collectClearOk;
    collectSaveOk ? pass++ : fail++;
    console.log('  ' + (collectSaveOk ? 'OK   ' : 'FAIL ')
      + '保存：收藏开关一起写 collectEnabled/autoCollect（关=两个都关、开=都开；无值时回退已保存值）'
      + (collectSaveOk ? '' : ` -> off=${collectOffOk} on=${collectOnOk} clear=${collectClearOk} ${JSON.stringify(sk)}`));
  }

  // ── 屏蔽名单搜索框（2026-10-02 用户反馈"只能输一个字"）────────────────────────
  //    根因：输入回调重画了整个右栏（含搜索框自己）→ 每次按键输入框被换掉、焦点丢失。
  //    修法：工具栏只渲染一次，输入时只重画列表容器。断言"输入后右栏 HTML 未被重建、
  //    只有列表容器变了"—— 变异（把回调改回 renderRight）会让它变红。
  {
    const prevFetch = sandbox.fetch;
    sandbox.fetch = async (path) => {
      const p = String(path);
      if (p.includes('/api/onebot/groups')) {
        return { ok: true, status: 200, json: async () => ({ groups: [{ id: '1', name: '测试群' }] }), text: async () => '' };
      }
      if (p.includes('/members')) {
        return { ok: true, status: 200, json: async () => ({ members: [
          { userId: '10001', nickname: '甲', card: '' },
          { userId: '10002', nickname: '乙', card: '' }
        ] }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    vm.runInContext('state.config = { ...(state.config || {}), allow: { groups: ["1"] } };', ctx);
    ctx.openBlocklistModal();
    await new Promise((resolve) => setTimeout(resolve, 20));   // 等 groups / members 两个 api 回来
    const overlay = document.body.children[document.body.children.length - 1];
    const right = overlay.querySelector('#bl-right');
    const searchEl = right.querySelector('#bl-search');
    const beforeRight = right.innerHTML;
    const beforeList = right.querySelector('#bl-list').innerHTML;
    // 快照迭代：变异版本（输入回调重画整栏）会往同一个 stub 元素的监听器数组里再塞一个，
    // 对着活数组 for...of 会无限循环 —— 那种"炸掉"不算"用例抓住变异"，要让它正常走到断言。
    const inputHandlers = [...(searchEl._listeners?.input || [])];
    for (const fn of inputHandlers) fn({ target: { value: '甲' } });
    const afterRight = right.innerHTML;
    const afterList = right.querySelector('#bl-list').innerHTML;
    const blSearchOk = inputHandlers.length > 0
      && beforeRight === afterRight        // 整栏没被重建（搜索框还在原位、焦点不丢）
      && beforeList !== afterList;         // 只有列表被重画
    blSearchOk ? pass++ : fail++;
    console.log('  ' + (blSearchOk ? 'OK   ' : 'FAIL ')
      + '屏蔽名单搜索：输入只重画列表、不重建含搜索框的整栏（防"只能输一个字"）');
    sandbox.fetch = prevFetch;
  }

  // ── 群勾选列表的"没读完别覆盖"守卫 ──
  //    用户报过"群列表一直读取中"（2026-09-28）：那种状态下盒子里只剩提示文案、零勾选，
  //    若保存照常发 chats: []，一次无关的保存就把白名单清空了。判据是 box.dataset.loaded
  //    （渲染出真实行才置位）。这里三个断言：没读完不带 chats、读完后能主动清空、日报那份同理。
  {
    const posts2 = [];
    const prevFetch = sandbox.fetch;
    sandbox.fetch = async (path, opts = {}) => {
      if (String(path).includes('/api/config') && String(opts.method || '').toUpperCase() === 'POST') {
        try { posts2.push(JSON.parse(opts.body || '{}')); } catch { /* 忽略 */ }
      }
      const cfgNow = JSON.parse(vm.runInContext('JSON.stringify(state.config || {})', ctx));
      return { ok: true, status: 200, json: async () => ({ ok: true, config: cfgNow }), text: async () => '{}' };
    };
    const gbox = document.querySelector('#cfg-game-chats-box');
    const dbox = document.querySelector('#cfg-digest-chats-box');
    const checks = [];
    const saveIn = async (sec) => {
      vm.runInContext(`state.settingsSection = '${sec}';`, ctx);
      posts2.length = 0;
      await vm.runInContext('saveConfig({ quiet: true })', ctx);
      return posts2[posts2.length - 1] || {};
    };
    // 配置里先放一份白名单：没读完时保存必须原样保留（不能变空），读完了没勾才允许清空。
    vm.runInContext("state.config.groupGame = { ...(state.config.groupGame || {}), chats: ['group:111', 'group:222'] };", ctx);
    vm.runInContext("state.config.groupDigest = { ...(state.config.groupDigest || {}), chats: ['group:333'] };", ctx);
    delete gbox.dataset.loaded;
    const bodyA = await saveIn('groupGame');
    checks.push(['未读完保留原白名单', JSON.stringify(bodyA.groupGame?.chats) === '["group:111","group:222"]', JSON.stringify(bodyA.groupGame?.chats)]);
    gbox.dataset.loaded = '1';
    const bodyB = await saveIn('groupGame');
    checks.push(['读完后能清空', Array.isArray(bodyB.groupGame?.chats) && bodyB.groupGame.chats.length === 0, JSON.stringify(bodyB.groupGame?.chats)]);
    delete dbox.dataset.loaded;
    const bodyC = await saveIn('moments');
    checks.push(['日报未读完保留原白名单', JSON.stringify(bodyC.groupDigest?.chats) === '["group:333"]', JSON.stringify(bodyC.groupDigest?.chats)]);
    sandbox.fetch = prevFetch;
    const okGuard = checks.every(([, ok]) => ok);
    okGuard ? pass++ : fail++;
    console.log('  ' + (okGuard ? 'OK   ' : 'FAIL ') + '群勾选列表：没读完保留原白名单、读完后能清空'
      + (okGuard ? '' : ' -> ' + JSON.stringify(checks.map(([n, ok, v]) => n + '=' + ok + '(' + v + ')'))));
  }

  // ── 定时提醒设置页 ──
  //    新增的 reminders 分区：开关 + 待触发/最近完成两个列表容器 + 刷新按钮都要在；
  //    设置侧边栏与 sections 路由也要认识它（少接一条就是"侧边栏点了没反应"）。
  {
    vm.runInContext("state.settingsSection = 'reminders';", ctx);
    const html = vm.runInContext('renderSettingsSection(state.config || {})', ctx);
    const okPage = /id="cfg-reminders-enabled"/.test(html)
      && /id="reminders-pending"/.test(html)
      && /id="reminders-recent"/.test(html)
      && /id="reminders-refresh-btn"/.test(html)
      && /启用定时提醒/.test(html);
    okPage ? pass++ : fail++;
    console.log('  ' + (okPage ? 'OK   ' : 'FAIL ') + '定时提醒设置页：开关、两个列表容器、刷新按钮齐备');
  }

  // ── 控制台错误页复位（2026-09-29 审查 P1）──
  //    setHtmlIfChanged 靠 el.__renderedHtml 去重。出错时若不清缓存，页面会永远停在
  //    "读取失败"上（数据其实已经回来了，只有 F5 能救）。这条钉住"出错 → 恢复 → DOM 真的被重写"。
  {
    const box = document.querySelector('#identity-page');
    const good = '<div class="ok">页面内容</div>';
    ctx.setHtmlIfChanged(box, good);                                   // 一次成功渲染，缓存住 HTML
    ctx.setBoxError(box, '<div class="empty-hint">读取失败：boom</div>');
    const recovered = ctx.setHtmlIfChanged(box, good);                 // 同样的内容，必须能写回去
    const okRecover = recovered === true && box.innerHTML === good;

    // 控制页还多一个 __hubBuilt 结构标志：出错时也要归零，否则下次成功刷新只更新字段、不重建
    const hub = document.querySelector('#control-page');
    hub.__hubBuilt = true;
    ctx.setBoxError(hub, 'err');
    const okHub = hub.__hubBuilt === false && hub.__renderedHtml === null;

    const ok = okRecover && okHub;
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ')
      + `出错提示后退回同样内容能重新渲染（缓存复位=${okRecover}，控制页结构标志归零=${okHub}）`);
  }

  // ── 群友备注的写入形状（2026-09-29 审查 P1；2026-10-10 多写方跟进）──
  //    备注写回必须走 __replace__ 整体替换：普通深合并删不掉键，"清空/删除备注"会看着成功、实际没变。
  //    memberNotes 现在有两个写入方（控制台 + 群里让机器人用 set_member_note 记），所以
  //    saveMemberNote 每次提交前都会重取一次现值再拼整表 —— 用**动态的服务端表**演：
  //    POST 的 __replace__ 结果会写回"服务端"，GET 返回它的当前值。
  {
    const originalFetch = sandbox.fetch;
    const posts = [];
    let serverNotes = { '42': '老张', '43': '小李' };
    sandbox.fetch = async (url, options = {}) => {
      const method = String(options.method || 'GET').toUpperCase();
      const body = options.body ? JSON.parse(options.body) : null;
      posts.push({ url: String(url), method, body });
      if (method === 'GET') {
        // /api/config 的 GET 直接返回配置本身（控制台就是这么用的）
        return { ok: true, status: 200, json: async () => ({ memberNotes: { ...serverNotes } }) };
      }
      serverNotes = { ...(body?.memberNotes?.__replace__ || {}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, config: { memberNotes: { ...serverNotes } } }) };
    };

    // 群里刚用 set_member_note 记过一条（控制台的旧快照里没有）：写入时必须带上它，
    // 不许被旧快照整表覆盖（2026-10-10 复核的丢数据场景）
    serverNotes['77'] = '群里刚记的';

    vm.runInContext("state.config = { memberNotes: { '42': '老张', '43': '小李' } };", ctx);
    await ctx.saveMemberNote('42', '张三');
    const setBody = posts.at(-1)?.body;
    const okSet = setBody?.memberNotes?.__replace__?.['42'] === '张三'
      && setBody.memberNotes.__replace__['43'] === '小李'
      && setBody.memberNotes.__replace__['77'] === '群里刚记的'
      && setBody.memberNotes['42'] === undefined;   // 普通对象形态会让服务端把旧值并回来

    await ctx.saveMemberNote('42', '');              // 传空串 = 删除这条备注
    const delBody = posts.at(-1)?.body;
    const okDel = Boolean(delBody?.memberNotes?.__replace__) && !('42' in delBody.memberNotes.__replace__)
      && delBody.memberNotes.__replace__['43'] === '小李'
      && delBody.memberNotes.__replace__['77'] === '群里刚记的';

    // state.config 还没拉到（或已过期）也先取一次现值打底：否则 __replace__ 会把服务端已有
    // 的备注（含群里刚记的）整体清掉
    vm.runInContext('state.config = null;', ctx);
    await ctx.saveMemberNote('43', '小李子');
    const guardBody = posts.at(-1)?.body;
    const okGuard = guardBody?.memberNotes?.__replace__?.['43'] === '小李子'
      && guardBody.memberNotes.__replace__['77'] === '群里刚记的';

    // 还原：后面还有用例要按正常配置渲染分区（state.config 为 null 时 renderApiSection 会抛错）
    vm.runInContext(`state.config = ${JSON.stringify(cfg)};`, ctx);
    sandbox.fetch = originalFetch;
    const ok = okSet && okDel && okGuard;
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ')
      + `备注写入走 __replace__（新增=${okSet}，删除=${okDel}，未加载/多写方时不误清=${okGuard}）`);
  }

  // ── 存档页 / 顶栏刷新的合并（2026-09-29 审查 P2）──
  //    chat-update 是"每条落库消息推一次"：不合并的话存档页会为每条消息重拉整段历史并重建表格，
  //    人物印象/异常处理页还会各自整页重拉。这里连推 5 次，断言只发生一轮刷新。
  {
    ctx.connectSSE();
    const originalFetch = sandbox.fetch;
    const originalRefreshStatus = sandbox.refreshStatus;
    const originalRefreshIntervalMs = sandbox.refreshIntervalMs;
    const paths = [];
    sandbox.fetch = async (url) => {
      paths.push(String(url));
      return { ok: true, status: 200, json: async () => ({ chats: [] }) };
    };
    const originalRefreshStatus2 = originalRefreshStatus;
    let statusCalls = 0;
    sandbox.refreshStatus = () => { statusCalls++; };
    // 存档页另有一条每 4 秒的列表轮询（startListPoller，ui/app.js 里启动的那个）：不把它挪开，
    // 它就会在观测窗口里插一脚，"5 次事件只刷一轮"的断言会变成看运气。
    sandbox.refreshIntervalMs = () => 3600 * 1000;
    ctx.startListPoller();
    vm.runInContext("state.tab = 'chats'; state.currentChatKey = '';", ctx);
    paths.length = 0;   // connectSSE 自己可能先拉一次列表，只统计"派发事件之后"的请求

    for (let i = 0; i < 5; i++) {
      for (const fn of sseRegistry['chat-update'] || []) fn({ data: '{}' });
    }
    await new Promise((r) => setTimeout(r, 2000));   // sleepMs 是别的块里的局部函数，这里自己等

    const chatCalls = paths.filter((u) => u.includes('/api/chats')).length;
    sandbox.fetch = originalFetch;
    sandbox.refreshStatus = originalRefreshStatus2;
    sandbox.refreshIntervalMs = originalRefreshIntervalMs;
    ctx.startListPoller();                           // 恢复原来的轮询间隔
    vm.runInContext("state.tab = '';", ctx);

    const ok = chatCalls === 1 && statusCalls === 1;
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ')
      + `连推 5 次 chat-update 只刷新一轮（存档页 ${chatCalls} 次、顶栏 ${statusCalls} 次，期望各 1 次）`
      + (ok ? '' : ' -> ' + JSON.stringify(paths)));
  }

  // ── 会话记忆详情的切群竞态守卫（2026-09-29 审查 P2）──
  //    连点两个群时，先发出的那个请求晚回来（成功或失败）都不该覆盖后选中的群。
  //    这里让旧请求挂住、新请求先成功，再把旧请求以失败收尾 —— 旧的 catch 也必须认守卫，
  //    否则它会把已经渲染好的新群详情换成"加载失败"。
  {
    const originalFetch = sandbox.fetch;
    const detail = document.querySelector('#memory-detail');
    let releaseFirst;
    const firstHang = new Promise((resolve) => { releaseFirst = resolve; });
    let listed = 0;
    sandbox.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/memory-files/')) {
        listed += 1;
        if (listed === 1) { await firstHang; throw new Error('隧道断了'); }   // 旧请求：晚失败
        return { ok: true, status: 200, json: async () => ({ members: [], handoff: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ memberNotes: {} }) };
    };
    vm.runInContext('state.memoryDetailSeq = 0;', ctx);

    const stale = ctx.loadMemoryDetail('group:1');   // 旧：会挂在那儿
    const fresh = ctx.loadMemoryDetail('group:2');   // 新：先渲染完
    await fresh;
    const afterFresh = String(detail.innerHTML || '');
    releaseFirst();
    await stale.catch(() => {});
    const afterStale = String(detail.innerHTML || '');
    sandbox.fetch = originalFetch;

    const rendered = /的记忆/.test(afterFresh);                        // 防止用例空转（成功路径真跑到了）
    const ok = rendered && afterStale === afterFresh;
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ')
      + `切群时旧请求晚失败不覆盖新群详情（新群已渲染=${rendered}，旧请求回来后未改动=${afterStale === afterFresh}）`
      + (ok ? '' : ' -> ' + afterStale.slice(0, 120)));
  }

  // ── "当前版本"的显示口径（2026-09-29 实测）──
  //    用未提交的本地树部署时，deployed-revision 记的是 `source-<UTC 时间戳>`：
  //    直接截前 12 个字符会显示成 `source-20260`，用户看不出"当前跑的不是某个提交"。
  {
    vm.runInContext(`state.autoUpdateStatus = ${JSON.stringify({
      installed: true, enabled: false, busy: false, status: 'no-update',
      ownerUin: '10000003',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git', branch: 'main', intervalHours: 6,
      currentRevision: 'source-20260929T111923Z', targetRevision: '',
      lastCheckAt: Date.now() - 60000, nextCheckAt: 0, error: ''
    })};`, ctx);
    const box = document.getElementById('control-page');
    box.__hubBuilt = false;
    box.__renderedHtml = null;
    ctx.renderControlHub({ services: [{ id: 'agent', online: true }] });
    const html = String(box.innerHTML || '');
    const ok = html.includes('未提交版本') && !html.includes('source-20260');
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ')
      + '部署未提交树时"当前版本"显示为「未提交版本 · 时间」，不是被截断的 source-20260');
  }

  // ── 人物记忆页「按 QQ 设备注」（2026-09-29）──
  //    左侧名单只列"进过记忆库的人"（说过话的），没说过话的群友靠这个入口补。
  //    它必须走同一个写入口（app.js 的 saveMemberNote → __replace__），
  //    否则"清空备注"又会变成看着成功、实际没变。
  {
    const originalFetch = sandbox.fetch;
    const posts = [];
    sandbox.fetch = async (url, options = {}) => {
      const method = String(options.method || 'GET').toUpperCase();
      posts.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ files: [], memberNotes: {} }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, config: { memberNotes: {} } }) };
    };
    // 这个页面脚本在真实控制台里随 index.html 加载；这里在同一个 vm 里执行它，
    // 然后直接触发"保存"按钮绑定的那个处理器。
    if (typeof sandbox.addEventListener !== 'function') sandbox.addEventListener = () => {};
    const gmCode = toClassicScript(fs.readFileSync(path.join(ROOT, 'ui', 'global-memory.js'), 'utf8'), 'global-memory.js');
    new vm.Script(gmCode, { filename: 'ui/global-memory.js' }).runInContext(ctx);

    const qqInput = document.getElementById('gm-anynote-qq');
    const noteInput = document.getElementById('gm-anynote-text');
    const saveBtn = document.getElementById('gm-anynote-save');
    qqInput.value = '12345';
    noteInput.value = '沉默群友';
    const handler = (saveBtn._listeners?.click || [])[0];
    if (handler) await handler({ currentTarget: saveBtn });
    const body = posts.find((p) => p.method === 'POST')?.body;   // 之后还会跟一次 GET（刷新名单）
    const statusText = String(document.getElementById('gm-anynote-status')?.textContent || '');
    sandbox.fetch = originalFetch;

    const ok = Boolean(handler)
      && body?.memberNotes?.__replace__?.['12345'] === '沉默群友'
      && statusText.includes('已保存')
      && noteInput.value === '';
    ok ? pass++ : fail++;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ')
      + `按 QQ 设备注：走 __replace__ 写入口并回报状态（状态="${statusText}"）`
      + (ok ? '' : ' -> ' + JSON.stringify(body) + ' handler=' + Boolean(handler)));
  }

  // ── 设置分区的"菜单 id ↔ 路由 key"一致性（2026-09-29）──
  //    侧边栏菜单与 renderSettingsSection 的路由表是两份独立清单（同一文件里各写一遍）；
  //    任一侧多写/写岔，点侧边栏就会**静默落回 API 页**（未知 key 会 `|| sections.api`），
  //    而所有渲染断言照样全绿。这里逐条走一遍菜单 id：都要有自己的输出、彼此不重复
  //    （重复＝两个菜单项指向同一个渲染函数），并且不能等于 API 页的兜底输出。
  {
    ctx.renderSettingsSidebar();
    // 渲染要按正常配置来（前面有用例把 state.config 设成 null 验过"配置未加载"）
    vm.runInContext(`state.config = ${JSON.stringify(cfg)};`, ctx);
    const sidebarHtml = String(document.querySelector('#settings-sidebar').innerHTML || '');
    const menuIds = [...sidebarHtml.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
    const outputs = new Map();
    const failed = [];
    vm.runInContext("state.settingsSection = 'api';", ctx);
    const apiHtml = String(vm.runInContext('renderSettingsSection(state.config || {})', ctx) || '');
    for (const id of menuIds) {
      vm.runInContext(`state.settingsSection = ${JSON.stringify(id)};`, ctx);
      let html = '';
      try { html = String(vm.runInContext('renderSettingsSection(state.config || {})', ctx) || ''); }
      catch (error) { failed.push(`${id}:抛错 ${error?.message || error}`); continue; }
      if (!html.trim()) failed.push(`${id}:空输出`);
      else if (id !== 'api' && html === apiHtml) failed.push(`${id}:落到 API 兜底（路由表缺这个 key）`);
      else outputs.set(id, html);
    }
    const dup = [...outputs.entries()].find(([, html], i, arr) => arr.findIndex(([, other]) => other === html) !== i);
    if (dup) failed.push(`${dup[0]}:与另一个分区输出完全相同`);
    if (!menuIds.includes('groupGame')) failed.push('菜单里没有 groupGame');
    if (!(outputs.get('groupGame') || '').includes('id="settings-groupgame"')) failed.push('groupGame 没渲染到自己的分区');
    const okSecs = menuIds.length >= 15 && failed.length === 0;
    okSecs ? pass++ : fail++;
    console.log('  ' + (okSecs ? 'OK   ' : 'FAIL ')
      + `设置侧边栏 ${menuIds.length} 个菜单项都能路由到自己的分区`
      + (okSecs ? '' : ' -> ' + JSON.stringify(failed)));
    vm.runInContext("state.settingsSection = 'api';", ctx);
  }

  // ⚠️ 设置页那些 .hint 是 **HTML**，不是 markdown：把 **…** 写进去浏览器会连星号一起显示
  //（2026-10-04 复审 P3：写文案的人以为在用 markdown，实际用户看到「**密钥类字段…**」）。
  // 判据本体在 test/helpers/ui-markdown-stars.mjs —— 那里同时被一条跨平台用例调用。
  // 为什么要抽出去：这段原本只活在这个文件里，而它在 Windows 上会先因别的原因失败，
  // 于是**本地永远跑不到**（2026-10-08 实证：往 appearance.js 写了一行 `** 2.4` 幂运算，
  // 本地全绿、CI 直接红）。
  {
    const { offenders, probeFailures, scanned } = scanDirForMarkdownStars('ui', { relTo: '.' });
    for (const why of probeFailures) {
      fail++;
      console.log('  FAIL markdown 判据自检：' + why + '（判据被改坏了）');
    }
    if (!probeFailures.length) {
      pass++;
      console.log('  OK   markdown 判据自检：带 URL 的提示行仍要检出 / 掩码不算 markdown');
    }
    if (offenders.length) {
      fail++;
      console.log('  FAIL 提示文案里混进 markdown 星号（会原样显示给用户）-> ' + offenders.join(', '));
    } else {
      pass++;
      console.log('  OK   ui/ 源码里没有漏进 HTML 模板的 markdown 星号（扫了 ' + scanned + ' 个文件）');
    }
  }

} catch (e) {
  fail++;
  console.log('\n加载 app.js 失败: ' + (e && e.message));
  console.log(e && e.stack && e.stack.split('\n').slice(0, 6).join('\n'));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / passed ' + pass : 'ALL PASSED ' + pass));
process.exit(fail ? 1 : 0);
