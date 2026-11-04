// 控制台布局契约（2026-10-19 UI 审查）：
//   · 人设身份区四字段同排，提示统一放在行下方（不能只挂在机器人名字下面）
//   · 按群人设会话多时用多列卡片网格，不再一列拉到底
//   · 表单统一「标签在上、控件在下」；不再有"无 hint 字段改标签左"的全局规则
//   · 时间范围行与全站控件同高
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const persona = fs.readFileSync(new URL('../ui/pages/persona.js', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8');

test('人设身份区：四字段同排，提示统一在行下方', () => {
  assert.match(persona, /class="field-row persona-identity-row"/);
  assert.match(persona, /class="hint persona-identity-hint"/);
  assert.doesNotMatch(persona, /id="cfg-botname"[\s\S]{0,160}<div class="hint">/,
    '提示不能只挂在机器人名字下面：同一行其余字段没有提示会显得突兀');
});

test('按群人设：会话多时用多列卡片网格', () => {
  assert.match(css, /\.per-chat-list \{[^}]*display: grid;/);
  assert.match(css, /\.per-chat-list \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(300px, 1fr\)\)/);
  assert.match(css, /\.per-chat-row \{[^}]*grid-template-columns: minmax\(0, \.9fr\) minmax\(140px, 1\.1fr\)/);
});

test('表单统一标签在上：不再有「无 hint 字段改标签左」的全局规则', () => {
  assert.doesNotMatch(css, /\.field:not\(:has\(\.hint\)\):not\(:has\(> label\.checkbox-row\)\) \{/,
    '标签左/控件右会让同一行的文本框换行、下拉留在原行，两种标签位置');
  assert.match(css, /\.field > select \{ max-width: 380px; \}/);
});

test('时间范围行与全站控件同高', () => {
  assert.match(css, /\.moment-window-row input \{[^}]*height: 40px/);
  assert.match(css, /\.moment-window-remove \{ width: 40px; height: 40px;/);
});

// ── 边角一致性（2026-10-19 用户反馈：有的圆有的尖、圆角里有缝隙）──
test('列表表头跟随容器圆角；保存条是渐隐的下沉带，不是贴着底边的一条页脚', () => {
  // .list-head 是 .list-pane 的 sticky 表头：方角会从圆角里戳出来。
  assert.match(css, /\.list-head \{[^}]*border-top-left-radius: inherit;[^}]*border-top-right-radius: inherit;/s,
    '列表表头要继承父级顶部圆角');
  // 保存条（2026-10-19 用户反馈"单独占一块、固定在屏幕上太生硬"）：不做方块了 ——
  // 没有边框、没有底色块，模糊与底色一起用 mask 从下往上淡出；上半截必须能点穿。
  const saveBar = /\n\.save-bar \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(saveBar, '要有 .save-bar 规则');
  assert.match(saveBar[1], /padding: 34px 0 16px;/, '留出雾带的高度（按钮仍在实区里）');
  assert.match(saveBar[1], /mask-image: linear-gradient\(to top, #000 55%, transparent 100%\);/,
    '模糊与底色要一起渐隐，才看不到矩形边缘');
  assert.match(saveBar[1], /pointer-events: none;/, '雾带不能挡住下面滚动的表单');
  assert.match(saveBar[1], /border: 0;/, '没有描边');
  assert.doesNotMatch(saveBar[1], /border-top:/, '不要再有那条"页脚分割线"');
  assert.match(css, /\.save-bar > \.btn \{ pointer-events: auto;/, '按钮要能点');
  assert.match(css, /\.settings-pane \{[^}]*padding: 22px 26px 0;/s,
    '设置面板底部不留内边距：雾带直接压到面板底缘');
});

test('表格圆角：collapse 会吃掉 border-radius，必须 separate 并给四角单元格补半径', () => {
  assert.match(css, /\.usage-table \{[^}]*border-collapse: separate; border-spacing: 0;/);
  assert.match(css, /\.usage-table > thead > tr:first-child > th:first-child,/, '表头左上角');
  assert.match(css, /\.usage-table > tbody > tr:last-child > :first-child,/, '表体左下角');
  assert.match(css, /\.model-rows-table \{ border-collapse: separate; border-spacing: 0; border-radius: var\(--r-sm\); overflow: hidden; \}/);
});

test('同屏的块状控件不能是方角：更新摘要 / 素材分类', () => {
  assert.match(css, /\.update-deploy-summary \{[^}]*border-radius: var\(--r-card\);[^}]*overflow: hidden;/s,
    '四格版本摘要要裁成圆角');
  assert.match(css, /\.asset-kinds \{[^}]*border-radius: var\(--r-sm\);[^}]*overflow: hidden;/s,
    '素材分类分段控件要圆角');
});

// ── 框内文字（2026-10-19 用户反馈：圆角框里的字摆放不对）──
test('面板正文与标题同一左缘，图标离圆角有安全距离', () => {
  assert.match(css, /\.panel \{[^}]*padding: 14px 18px 15px;/s, '面板左右要留 18px（等于圆角）');
  assert.match(css, /\.panel \{ padding: var\(--sp-4\) 18px; \}/, '后一处面板 padding 也必须保留左右内边距');
  assert.match(css, /\[data-density='compact'\] \.panel \{ padding: 10px 18px 11px; \}/);
  assert.match(css, /\[data-density='roomy'\] \.panel \{ padding: 17px 18px 18px; \}/);
  assert.match(css, /\.panel:has\(\.panel-ico\) \.panel-body \{ padding-left: 25px; \}/,
    '有图标时正文缩进到标题左缘（图标 16 + 间距 9）');
  assert.match(css, /html\[data-glass\] \.kpi \{ padding-left: 20px; padding-right: 20px; \}/,
    'KPI 首格内容要躲开 18px 圆角');
});

test('圆角表格的首列表头要留出圆角安全区', () => {
  assert.match(css, /\.model-rows-table th:first-child \{ width: 46%; padding-left: 10px; \}/);
  assert.match(css, /\.model-rows-table th:last-child \{ width: 8%; text-align: right; padding-right: 10px; \}/);
});

test('KPI 悬停底色不能盖掉整块面板的圆角', () => {
  const block = css.slice(css.indexOf('.kpi-grid {'), css.indexOf('}', css.indexOf('.kpi-grid {')));
  assert.match(block, /overflow: hidden;/, 'kpi-grid 要裁切子格的方形悬停底色');
});

// ── 跨页一致性与控件轮廓（2026-10-19 第二轮显示缺陷排查）──
const features = fs.readFileSync(new URL('../ui/pages/features.js', import.meta.url), 'utf8');

test('一级页签共用同一套内容内边距与滚动条沟槽', () => {
  // 实测：总览 20/22、其余 22/26 —— 切页时标题跳 4px；内容够长的页面还少 10px 滚动条宽度，
  // 卡片右缘再跳一次。两处都收口到同一个口径。
  for (const sel of ['.overview-pane', '.control-pane', '.asset-pane', '.usage-pane', '.plugins-pane', '.detail-pane']) {
    // 锚行首：窄屏覆盖块里也有 `.asset-pane { padding: 16px; }`（带缩进），不能先撞上它
    const m = new RegExp(`\\n\\${sel} \\{([\\s\\S]*?)\\n\\}`).exec(css);
    assert.ok(m, `${sel} 要存在`);
    assert.match(m[1], /padding: 22px 26px 40px;/, `${sel} 要和其它页签同内边距`);
  }
  assert.match(css, /\[data-density='compact'\] \.overview-pane \{ padding: 15px 17px 22px; \}/,
    '紧凑档的横向内边距也要跟插件页一致');
  assert.match(css, /\[data-density='roomy'\] \.overview-pane \{ padding: 26px 30px 34px; \}/);
  assert.match(css, /\.overview-pane,\s*\.control-pane,\s*\.asset-pane,\s*\.usage-pane,\s*\.plugins-pane,\s*#view-settings \{ scrollbar-gutter: stable; \}/,
    '所有主滚动容器都要预留滚动条沟槽，否则有没有滚动条内容宽度差 10px');
});

test('列表行的 hover 位移不能把列表撑出横向滚动条', () => {
  assert.match(css, /\.list-pane \{[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/s,
    'hover translateX(2px) 会让 overflow-x 变成 auto —— 实测列表底部冒横向滚动条');
  assert.match(css, /\.chat-item:hover \{ transform: translateX\(2px\); \}/, '位移本身保留');
});

test('菜单行高不随字形变化；空计数的列表头不显示', () => {
  // 「OneBot」是纯拉丁文字，line-height: normal 下比中文行矮 4px（实测 31.3 vs 35.3）。
  assert.match(css, /\.settings-menu-item \{[^}]*line-height: 1\.4;/s);
  assert.match(css, /\.list-head:has\(> #session-count:empty\) \{ display: none; \}/,
    '会话数为空时不要把一条什么都没有的表头留在列表顶上');
});

test('同角色的卡片用同一个圆角档位（--r-card）', () => {
  for (const sel of ['.control-service', '.control-key-list', '.asset-summary-item']) {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at > 0, `${sel} 要存在`);
    const block = css.slice(at, css.indexOf('}', at));
    assert.match(block, /border-radius: var\(--r-card\);/, `${sel} 是卡片，不能用 --r-sm`);
  }
  assert.match(css, /\.usage-table \{[^}]*border-radius: var\(--r-card\);/s);
  assert.match(css, /\.usage-table > thead > tr:first-child > th:first-child,[^}]*calc\(var\(--r-card\) - 1px\)/,
    '单元格圆角要跟着外框减 1px');
  assert.match(css, /\.usage-guide \{[^}]*border-radius: var\(--r-card\);/s,
    '同页的引导面板与 .usage-card 同档');
});

test('控件轮廓在壁纸亮部也要看得见；密码行按钮与输入框同高', () => {
  assert.match(css, /--ctl-line: color-mix\(in srgb, var\(--text\) 30%, var\(--border\)\);/,
    '22% 在玻璃壁纸的白色泛光上只剩半截边');
  assert.match(css, /\.pw-row > \.btn \{ height: 40px; \}/, '输入框 40px、按钮 34px 会错开 3px');
});

test('「刷新」在所有页签里是同一种控件', () => {
  // 总览是 .btn.btn-small + 图标 + 文字；其余页面原来只有一个透明的 ↻ 字形（28px、无底、无边框），
  // 压在亮壁纸上几乎看不见，也不像按钮。
  assert.match(features, /import \{ iconSvg \} from '\.\.\/core\/icons\.js';/);
  for (const id of ['asset-refresh', 'identity-feature-refresh', 'friend-feature-refresh', 'slang-feature-refresh', 'incident-feature-refresh']) {
    assert.match(features, new RegExp(`class="btn btn-small" id="${id}"[^>]*>\\$\\{iconSvg\\('refresh', \\{ size: 15 \\}\\)\\}<span>刷新</span>`),
      `${id} 要换成带文字的胶囊按钮`);
  }
  assert.doesNotMatch(features, /class="icon-btn" id="[a-z-]*refresh"/, '不要再留透明的裸图标刷新键');
});

// ── 浅色液态玻璃的配色与顶线（2026-10-19 用户反馈：会话行发灰、插件卡片泛色、设置页被压下一行）──
test('列表行不常驻灰底：底色只在悬停/选中时出现', () => {
  // 旧规则把 --hover 同时写给元素本身和 :hover 两份选择器，浅色玻璃下每行都像一块灰砖。
  assert.doesNotMatch(css, /\.chat-item, \.session-item, \.pick-item, \.settings-menu-item, \.tool-card, \.chat-item:hover/,
    '这条旧规则会给每一行列表/菜单项常驻一层灰底');
  assert.match(css, /\.chat-item:hover, \.session-item:hover, \.pick-item:hover, \.settings-menu-item:hover \{/,
    '悬停反馈要保留');
  assert.match(css, /\.tool-card:hover \{ background: var\(--bg-3\); \}/, '工具卡有自己的实底，悬停别用半透明黑盖掉');
});

test('浅色液态玻璃降饱和、提填充；顶栏脱离文档流，面板与主侧栏同顶线', () => {
  assert.match(css, /\[data-theme='light'\]\[data-glass='liquid'\] \{[^}]*--glass-fill: rgba\(250, 250, 250, \.56\);[^}]*--glass-sat: 125%;/s,
    '亮色壁纸的色带会把白卡染成一边绿一边蓝');
  assert.match(css, /#workspace \{ position: relative; \}/);
  assert.match(css, /html\[data-glass='liquid'\] #topbar \{[^}]*position: absolute;[^}]*top: 8px;[^}]*right: 8px;/s,
    '顶栏是浮层，不该再占正文的一行');
  // 同权重的 position: relative 在折射清单的组选择器里；absolute 在它之后的 media 块里，
  // 靠顺序取胜（不能只看"存在 absolute"，调换顺序功能就坏了）。具体块在下面挑。
  const relAt = css.indexOf("html[data-glass='liquid'] #topbar,");
  // 顶栏宽了会压住左侧列表/设置左栏：给它留出右侧 348px
  assert.match(css, /html\[data-glass='liquid'\] #topbar \{[^}]*max-width: calc\(100% - 348px\);/s,
    '顶栏宽度要扣掉左侧列表栏的 348px');
  // ≤900 是堆叠布局（列表整行、无 88px 让位），浮层必须关掉。
  // 文件里还有别的 min-width: 901px 块（侧栏横排），要挑出含 88px 让位的那一块。
  let media = null;
  const mediaRe = /@media \(min-width: 901px\) \{([\s\S]*?)\n\}/g;
  let mm;
  while ((mm = mediaRe.exec(css))) {
    if (mm[1].includes('padding-top: 88px;')) { media = mm; break; }
  }
  assert.ok(media, '浮层规则要包在 min-width: 901px 里');
  assert.ok(media.index > relAt, '绝对定位规则必须在折射清单的 relative 之后');
  assert.ok(media[1].includes('position: absolute;'), '桌面才脱离文档流');
  const pad = /html\[data-glass='liquid'\] \.overview-pane,([\s\S]*?)\{ padding-top: 88px; \}/.exec(media[1]);
  assert.ok(pad, '主滚动容器要让出顶栏高度');
  for (const sel of ['.control-pane', '.asset-pane', '.usage-pane', '.plugins-pane', '.detail-pane', '#view-settings .settings-pane']) {
    assert.ok(pad[1].includes(sel), `${sel} 也要让出顶栏高度`);
  }
  assert.match(media[1], /html\[data-glass='liquid'\] #banner:not\(\.hidden\) \{ margin-top: 72px; \}/,
    '横幅要落在顶栏下面，不能被盖住');
});

test('保存失败的状态文字可选中、tooltip 能弹出来（雾层不能把指针事件一直吞掉）', () => {
  const block = /#cfg-save-result \{([\s\S]*?)\}/.exec(css);
  assert.ok(block, '要有 #cfg-save-result 规则');
  assert.match(block[1], /pointer-events: auto;/, '父级 .save-bar 是 pointer-events: none');
  assert.match(block[1], /user-select: text;/);
});

test('液态玻璃档的侧栏样式与高对比真的生效（这两个 token 不读 --glass-tint）', () => {
  assert.match(css, /html\[data-glass='liquid'\]\[data-sidebar-style='panel'\] #sidebar \{[^}]*color-mix\(in srgb, var\(--bg-3\) 56%, transparent\)/s,
    '--glass-tint 在液态档是 0%，沿用旧公式会算成全透明');
  assert.match(css, /\[data-theme='dark'\]\[data-glass='liquid'\]\[data-sidebar-style='panel'\] #sidebar \{[^}]*42%, transparent\)/s);
  assert.match(css, /\[data-theme='light'\]\[data-contrast='high'\]\[data-glass='liquid'\] \{ --glass-fill: var\(--bg-2\); --glass-modal-fill: var\(--bg-2\); \}/,
    '液态档填色写死 rgba，高对比必须直接改 --glass-fill（模态框的厚填色同理）');
});

test('二级侧栏在亮色玻璃下接近白面板（sticky 表头是不透明白条）', () => {
  // 56% 的玻璃底会把壁纸的绿色透上来，而 .list-head 是 --bg-2 的不透明白条：
  // 上面一条白、下面一片绿，像两块拼的（2026-10-19 用户反馈"会话界面左侧边栏颜色违和"）。
  assert.match(css, /html\[data-theme='light'\]\[data-glass='liquid'\] \.list-pane,\s*html\[data-theme='light'\]\[data-glass='liquid'\] \.settings-sidebar \{[^}]*--glass-fill: rgba\(250, 250, 250, \.84\);/s);
  assert.match(css, /\.list-head \{[^}]*background: var\(--bg-2\);/s, '表头仍要不透明，才能盖住滚动的行');
  // 84% 是声明在元素自身上的，会盖过 html 上的高对比规则；高对比要同层再声明一次
  assert.match(css, /html\[data-theme='light'\]\[data-contrast='high'\]\[data-glass='liquid'\] \.list-pane,\s*html\[data-theme='light'\]\[data-contrast='high'\]\[data-glass='liquid'\] \.settings-sidebar \{[^}]*--glass-fill: var\(--bg-2\);/s);
});

test('会话列表的暖色收口：生命周期改冷紫、机器人声线改冷青', () => {
  // 用户反馈列表里那块棕黄（"本轮已发言"）与主题不协调：--voice 原来是黄铜，
  // 生命周期模式的橙色触发字也在同一屏。现在三档模式是 绿/蓝/紫，声线是冷青。
  assert.match(css, /\.mode-lifecycle \{ --mode-color: #8b5cf6; --mode-soft: rgba\(139, 92, 246, \.12\); \}/);
  assert.match(css, /\[data-theme='dark'\] \.mode-lifecycle \{ --mode-color: #a78bfa;/);
  assert.match(css, /--voice: #2dd4bf;/);
  assert.match(css, /--voice: #0f766e;/);
  assert.doesNotMatch(css, /--voice: #d9a441|--voice: #8a5a06/, '黄铜声线已退役');
});

test('人物印象的表头与数据同向对齐（数字列右、操作列右）', () => {
  // 实测生产：thead 的「会话/消息」左对齐、对应 td 是 .r 右对齐，数字贴在列右缘、标题留在列左缘。
  assert.match(features, /<th class="r">会话<\/th><th class="r">消息<\/th>/);
  assert.match(features, /<th>画像备注<\/th><th class="actions-col">操作<\/th>/);
  assert.match(features, /<th>最近更新<\/th><th class="actions-col">操作<\/th>/, '旧印象表的操作列也要跟按钮同向');
  // 黑话/黑话研究表的数字列与操作列同样要同向
  assert.match(features, /<th class="r">出现<\/th><th class="r">证据<\/th><th class="actions-col">操作<\/th>/);
  assert.match(features, /<th>状态<\/th><th class="actions-col">操作<\/th>/);
  assert.match(css, /\.asset-table th\.actions-col \{ text-align: right; \}/);
  assert.match(css, /@media \(max-width: 600px\) \{ \.asset-table th\.actions-col \{ text-align: left; \} \}/);
});

test('亮色玻璃里有边界的盒子要看得见：--card-line', () => {
  assert.match(css, /\[data-theme='light'\]\[data-glass\] \{[^}]*--card-line: var\(--border\);/s, '无 color-mix 时回退');
  assert.match(css, /--card-line: color-mix\(in srgb, var\(--text\) 30%, var\(--border\)\);/);
  const block = /\[data-theme='light'\]\[data-glass\] \.asset-summary-item,[\s\S]*?border-color: var\(--card-line\);[\s\S]*?\n\}/.exec(css);
  assert.ok(block, '卡片/表格/空状态要套 --card-line');
  for (const sel of ['.asset-table-wrap', '.context-call-table-wrap', '.control-service', '.control-key-list',
    '.usage-table', '.usage-card', '.usage-note', '.tool-card', '.kpi-grid', '.plugin-card', '.opt-card',
    '.plat-card', '.price-card', '.conversation-mode-option', '.persona-card', '.persona-detail',
    '.scheme-card', '.memory-summary', '.memory-advanced', '.memory-handoff', '.modal', '.model-modal', '.empty-hint']) {
    assert.ok(block[0].includes(sel), `${sel} 也要有可见描边`);
  }
  assert.match(css, /--ctl-line: color-mix\(in srgb, var\(--text\) 30%, var\(--border\)\);/,
    '输入框/开关仍用更重的控件线，别被卡片线顶掉');
});

test('人物印象的表壳要能滚动：max-height 不能被 overflow:hidden 变成截断', () => {
  // 实测 14 行：scrollHeight 1076 / clientHeight 569，hidden 下后面几行既看不到也滚不到。
  assert.match(css, /\.asset-table-wrap \{[^}]*max-height: calc\(100vh - 330px\);[^}]*overflow: auto;/s);
  assert.match(css, /\.asset-table-wrap, \.context-call-table-wrap \{ border-radius: var\(--r-card\); border: 1px solid var\(--border\); overflow: auto; \}/);
});

test('复制内置卡做自定义副本时不能被判回内置卡', () => {
  const persona = fs.readFileSync(new URL('../ui/pages/persona.js', import.meta.url), 'utf8');
  // 同文命中时自定义优先（否则保存后绑定到内置卡文件、副本跟着卡文件变且删不掉）
  assert.match(persona, /exacts\.find\(\(\[, p\]\) => !p\.builtin\) \|\| exacts\[0\]/);
  // 新建流程显式把新卡的 id（custom_<末位>）交给草稿
  assert.match(persona, /custom_\$\{customCount - 1\}/);
  assert.match(persona, /applyPersonaDraft\(\{ name, text, customRules, behaviorProfile \}, newId, \{ forceProfile: behaviorProfile \}\)/);
  // 点卡只填正文/规则：草稿是 card，或用户刚把下拉改成别的档（与已保存值不同）→ 保留草稿；
  // 不再看已保存配置，否则「已保存 card → 改成 legacy → 点卡」会把 legacy 吞掉。
  assert.match(persona, /const draftProfile = personaDraftState\(\)\.behaviorProfile;/);
  assert.match(persona, /const keepDraft = draftProfile === 'card' \|\| state\.personaProfileTouched === true;/);
  assert.doesNotMatch(persona, /keepCard = state\.config/);
});

test('模态框用更厚的前景填色：浅色液态下页面文字不透过输入框', () => {
  // 实测：.model-modal 跟着环境面板用 56% 白玻璃，背后页面的文字直接透到输入区，
  // 「添加人设」看起来像一块没擦干净的毛玻璃。前景单独一条更厚的 token。
  assert.match(css, /--glass-modal-fill: rgba\(18, 18, 18, \.80\);/);
  assert.match(css, /\[data-theme='light'\]\[data-glass='liquid'\] \{[^}]*--glass-modal-fill: rgba\(250, 250, 250, \.90\);/s);
  assert.match(css, /html\[data-contrast='high'\]\[data-glass\] \{[^}]*--glass-modal-fill: var\(--bg-2\);/s);
  assert.match(css, /html\[data-glass\] \.model-modal,\s*html\[data-glass\] \.modal,\s*html\[data-glass\] dialog \{\s*background-color: var\(--glass-modal-fill\);/s,
    '前景填色规则必须写在表面组之后，否则会被 --glass-fill 盖掉');
  // 白名单选择器（.modal）也得进玻璃表面组，否则它仍是死白的一块
  const group = /html\[data-glass\] #topbar,[\s\S]*?html\[data-glass\] \.list-pane \{/.exec(css);
  assert.ok(group && group[0].includes('html[data-glass] .modal,'), '.modal 要跟 .model-modal 同一套表面');
});

test('表情包卡片：动作区贴底，描述长度不再顶开按钮', () => {
  const sticker = /\.asset-sticker \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(sticker, /display: flex;/);
  assert.match(sticker, /flex-direction: column;/);
  assert.match(css, /\.asset-sticker-body \{[^}]*flex: 1; display: flex; flex-direction: column;/s);
  assert.match(css, /\.asset-sticker-body > \.asset-actions \{ margin-top: auto;/);
  assert.match(css, /\.asset-sticker-body strong \{[\s\S]*?-webkit-line-clamp: 2;/);
  const features = fs.readFileSync(new URL('../ui/pages/features.js', import.meta.url), 'utf8');
  assert.match(features, /<span title="\$\{esc\(entry\.desc\)\}">/, '截断后全文要留在 title 里');
});

test('会话记忆详情：先给状态与摘要，结构化字段收进二级折叠', () => {
  const memory = fs.readFileSync(new URL('../ui/pages/memory.js', import.meta.url), 'utf8');
  assert.match(memory, /class="memory-state \$\{handoff \? 'is-live' : ''\}"/);
  assert.match(memory, /class="memory-summary/);
  assert.match(memory, /当前没有交接/);
  assert.match(memory, /<details class="memory-advanced"/);
  assert.match(memory, /会话级 handoff \/ 工作状态/);
  assert.match(css, /\.memory-summary \{/);
  assert.match(css, /\.memory-handoff \.field-row \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
});

test('窄屏的「列表 + 详情」视图上下堆叠，不把详情压成竖排文字', () => {
  // 390px 实测：列表固定 320px，详情只剩 ~40px（"← 选择会话查看…" 一个字一行）。
  assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?#view-chats, #view-memory, #view-people-memory \{ flex-direction: column; overflow-y: auto; \}/);
  assert.match(css, /#view-chats > \.list-pane, #view-memory > \.list-pane, #view-people-memory > \.list-pane \{[^}]*width: 100%;[^}]*max-height: 40vh;/s);
  assert.match(css, /#view-chats > \.detail-pane, #view-memory > \.detail-pane, #view-people-memory > \.detail-pane \{[^}]*display: block;[^}]*width: 100%;/s);
});

test('把 .modal 并入玻璃表面时，降级清单与折射扫描也要同步', () => {
  // 不支持 backdrop-filter 的浏览器会退回实心表面；漏了 .modal 就等于浅色下 56% 透底
  const fallback = /@supports not \(\(backdrop-filter[\s\S]*?html\[data-glass\] \.list-pane \{/.exec(css);
  assert.ok(fallback, '要有无 backdrop-filter 的降级块');
  assert.ok(fallback[0].includes('html[data-glass] .modal,'), '降级块要包含 .modal');
  const refract = fs.readFileSync(new URL('../ui/core/glass-refract.js', import.meta.url), 'utf8');
  assert.match(refract, /'\.model-modal', '\.modal', 'dialog'/,
    'REFRACT_SELECTOR 要与 CSS 玻璃表面清单保持一致');
});

test('新建自定义卡是空表单：角色设定不复制当前卡', () => {
  const start = persona.indexOf('function openPersonaCreateModal');
  const end = persona.indexOf('\nfunction ', start + 10);
  const body = persona.slice(start, end === -1 ? undefined : end);
  assert.ok(start >= 0 && body.includes('new-persona-text'), '要找到新建卡弹窗');
  assert.doesNotMatch(body, /cfg-roletext|cfg-customrules/,
    '新建卡不能把当前卡正文/附加规则带进来（看起来像复制了一张卡）');
  assert.match(body, /id="new-persona-text"[^>]*><\/textarea>/);
  assert.match(body, /id="new-persona-rules"[^>]*><\/textarea>/);
});

test('好友管理保留卡片版：8 张功能卡，保存按钮在页头', () => {
  // 这是用户确认过的版本：五个设置区 + 三个列表区，不能退回扁平旧版。
  const start = features.indexOf('function renderFriendFeaturePageImpl');
  const end = features.indexOf('async function saveFriendFeatureConfig', start);
  const friend = features.slice(start, end);
  assert.ok(start >= 0 && end > start, '要找到好友管理渲染函数');
  for (const title of ['基础设置', '触发条件', '频率与配额', '评分权重', '入站好友请求', '收到的好友请求', '主动好友候选', '消息触发与评估记录']) {
    assert.match(friend, new RegExp(`<h3>${title}</h3>`), `缺少「${title}」卡片`);
  }
  const cards = friend.match(/<section class="settings-card"/g) || [];
  assert.equal(cards.length, 8, `好友管理应有 8 张卡片，实际 ${cards.length}`);
  assert.match(friend, /class="asset-head-actions"/);
  assert.match(friend, /id="friend-feature-save"/);
  assert.match(friend, /id="friend-feature-save-result"/);
});

test('人物印象与异常处理按功能块分卡', () => {
  const identity = features.slice(
    features.indexOf('function renderIdentityFeaturePageImpl'),
    features.indexOf('function renderFriendFeaturePageImpl')
  );
  assert.match(identity, /<section class="settings-card">\s*<h3>统一人物<\/h3>/);
  assert.match(identity, /<section class="settings-card">\s*<h3>旧印象<\/h3>/);
  const incident = features.slice(
    features.indexOf('function renderIncidentFeaturePageImpl'),
    features.indexOf('async function saveIncidentFeatureConfig')
  );
  assert.match(incident, /<section class="settings-card">\s*<div class="control-section-title">\s*<div><h3>告警与策略<\/h3>/);
  assert.match(incident, /<section class="settings-card">\s*<div class="control-section-title">\s*<div><h3>异常日志<\/h3>/);
});

test('资产页卡片复用同一套卡片样式', () => {
  assert.match(css, /\.asset-pane \.settings-card > \.control-section-title,\s*\.control-pane \.settings-card > \.control-section-title \{ margin-bottom: 12px; \}/);
  assert.match(css, /\.asset-summary \+ \.settings-card,\s*\.friend-save-result \+ \.settings-card \{ margin-top: 14px; \}/);
  assert.match(css, /\.asset-head-actions \{ display: flex; align-items: center; gap: 8px; flex: 0 0 auto; \}/);
});

test('控制页功能块分卡，服务入口排满一行', () => {
  const sections = appJs.match(/<section class="settings-card"/g) || [];
  assert.equal(sections.length, 9, '控制页 9 个功能块（运行指标/审计、数据备份、存储维护与群策略）都要成卡');
  assert.doesNotMatch(appJs, /<section class="control-section"/);
  const block = /\.control-pane \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(block, '控制页要有独立布局规则');
  assert.match(block[1], /grid-template-columns: minmax\(0, 1180px\);/);
  assert.match(block[1], /justify-content: center;/);
  assert.match(css, /\.control-service-grid \{[^}]*repeat\(auto-fit, minmax\(220px, 1fr\)\)/s,
    'auto-fill 会留下空轨道，第五个入口被挤到下一行');
});

test('窄屏顶部导航横滑但不显示系统滚动条', () => {
  const media = /@media \(max-width: 900px\) \{([\s\S]*?)\n\}/g;
  const blocks = [...css.matchAll(media)].map((m) => m[1]);
  const nav = blocks.find((b) => b.includes('#tabs') && b.includes('scrollbar-width: none'));
  assert.ok(nav, '要有窄屏横滑导航规则并隐藏系统滚动条');
  assert.match(css, /#tabs::-webkit-scrollbar \{ display: none; \}/);
});

test('好友管理 / 人物印象 / 异常处理整块内容居中，宽度取 1180', () => {
  const block = /#friend-page,\s*#identity-page,\s*#incident-page \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(block, '三页要有同一条居中列规则');
  assert.match(block[1], /display: grid;/);
  assert.match(block[1], /grid-template-columns: minmax\(0, 1180px\);/);
  assert.match(block[1], /justify-content: center;/);
  assert.match(block[1], /align-content: start;/);
});

test('见闻候选：卡片式栅格，不再用内联缩略图 + 单行小字', () => {
  const lifeFeedUi = fs.readFileSync(new URL('../ui/pages/life-feed.js', import.meta.url), 'utf8');
  assert.match(lifeFeedUi, /class="feed-card"/);
  assert.match(lifeFeedUi, /class="feed-card-cover"/);
  assert.match(lifeFeedUi, /class="feed-card-actions"/);
  assert.doesNotMatch(lifeFeedUi, /class="asset-row"/, '旧的 asset-row 没有样式，候选卡片必须用专用结构');
  assert.doesNotMatch(lifeFeedUi, /style="display:flex;gap:8px/, '卡片里不能再靠内联样式排版');
  assert.match(css, /\.feed-card \{[^}]*grid-template-columns: 168px minmax\(0, 1fr\);[^}]*grid-template-areas:/s);
  assert.match(css, /\.feed-card-cover \{[^}]*aspect-ratio: 16 \/ 9;/s);
  assert.match(css, /@media \(max-width: 560px\) \{\s*\.feed-card \{ grid-template-columns: minmax\(0, 1fr\);/);
});

test('分享设置：自动/手动模式与独立目标群都进保存补丁', () => {
  const lifeFeedUi = fs.readFileSync(new URL('../ui/pages/life-feed.js', import.meta.url), 'utf8');
  const save = fs.readFileSync(new URL('../ui/pages/settings-save.js', import.meta.url), 'utf8');
  assert.match(lifeFeedUi, /id="cfg-lifefeed-sharemode"/);
  assert.match(lifeFeedUi, /value="auto"/);
  assert.match(lifeFeedUi, /id="cfg-lifefeed-sharegroups-box"/);
  assert.match(save, /shareMode: String\(val\('#cfg-lifefeed-sharemode'/);
  assert.match(save, /pickedSessionValues\('cfg-lifefeed-sharegroups-box'\)/);
  assert.match(save, /shareGroups/);
});

test('见闻分享范围：群与私聊混排，选择走统一会话选择器', () => {
  const lifeFeedUi = fs.readFileSync(new URL('../ui/pages/life-feed.js', import.meta.url), 'utf8');
  const picker = fs.readFileSync(new URL('../ui/core/session-picker.js', import.meta.url), 'utf8');
  assert.match(lifeFeedUi, /renderSessionPicker\('cfg-lifefeed-sharegroups-box', selectedShareGroups/,
    '分享目标要用统一选择器，不能退回内嵌群清单');
  assert.match(lifeFeedUi, /renderSessionPicker\('cfg-lifefeed-groups-box', selectedGroups/,
    '兴趣来源也要能选私聊');
  assert.match(lifeFeedUi, /<option value="private:\$\{esc\(id\)\}">私聊/,
    '手动分享下拉要有 private:<QQ> 选项');
  assert.match(picker, /export \{ openSessionPicker, renderSessionPicker, pickedSessionValues \};/, '选择器要有弹窗实现');
  assert.match(picker, /sessionDirty/, '只有用户确认过的字段才进保存补丁');
  assert.match(css, /\.session-picker-row \{/);
  assert.doesNotMatch(css, /\.group-checklist/, '旧的内嵌清单样式应已移除');
});
